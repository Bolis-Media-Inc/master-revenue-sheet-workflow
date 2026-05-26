/**
 * handlers/adHandler.js
 * Called for every message in the Internal Network Ads group.
 *
 * Flow:
 *  1. Parse the message text for ad structure
 *  2. Build the row (matches columns in the revenue sheets)
 *  3. Append to Master Revenue Sheet (always)
 *  4. Append to the individual page's revenue sheet (if handle is known in pages.json)
 *  5. Forward the ad content + brief to each page's Telegram destination (if configured)
 *  6. Reply with a ✅ confirmation (or stay silent if not an ad)
 */

const { parseAdMessage }       = require("../parser");
const { appendRow, markForwarded, updateStatusToLive, updateAdDate, appendReminder } = require("../sheets");
const { clearBufferUpTo, getCollabBundlesByPage, getContentBundlesByPage, getPrecedingMessages } = require("../messageBuffer");
const { parseNifMs, scheduleNifReminder } = require("../scheduler");
const { parsePostDuration }    = require("../reminders");
const pagesRegistry            = require("../lib/pages");

// Supports comma-separated chat IDs so a test group can run alongside production.
// e.g. TARGET_CHAT_ID=-1001111111111,-1002222222222
const TARGET_CHAT_IDS = new Set(
  (process.env.TARGET_CHAT_ID || "").split(",").map((id) => id.trim()).filter(Boolean)
);
const MASTER_SHEET_ID = process.env.MASTER_SHEET_ID;
const TAB_NAME        = process.env.SHEET_TAB_NAME      || "2026 Ad Overview";
const PAGE_TAB_NAME   = process.env.PAGE_SHEET_TAB_NAME || "IG Revenue Tracker";

// Set FORWARDING_ENABLED=true in env to turn on forwarding
const FORWARDING_ENABLED = (process.env.FORWARDING_ENABLED || "").toLowerCase() === "true";

// Per-page forwarding gate now lives on the `pages` table (auto_forward column),
// driven by the Digi /admin/pages UI. The legacy ENABLED_PAGES env var was
// retired in favor of a per-row toggle — see migrations/010_pages.sql.
// A "*" env override still wins for ad-hoc all-on testing.
const ENABLED_PAGES_ALL = (process.env.ENABLED_PAGES || "").trim() === "*";
const isPageEnabled = (handle) =>
  !!handle && (ENABLED_PAGES_ALL || pagesRegistry.getAutoForward(handle));

// Placeholder values that haven't been filled in yet (to skip writing to that sheet)
const PLACEHOLDER_PATTERN = /^(SHEET_ID_|TELEGRAM_CHAT_ID_)/;

// Track recently processed ad message IDs to prevent duplicate forwarding
// (e.g. from webhook retries or Railway restarts replaying pending updates)
const _recentlyProcessed = new Set();
const DEDUP_MAX_SIZE = 200;

/**
/**
 * Parse a date written naturally inside a "Posted on" reply.
 * Accepts: "April 14th", "April 14", "Apr 14 2026", "4/14", "4-14",
 * "2026-04-14", "today", "yesterday".
 *
 * Returns a date string formatted to match the existing sheet column D
 * style ("Tue 5/5/26" — see parser.js datePosted), or null if no
 * recognizable date is present.
 *
 * Year handling: when the operator omits the year (e.g. "April 14"),
 * default to the current year UNLESS that yields a future date by
 * more than 31 days — in which case roll back to last year (catches
 * Jan-confirmation of a December post).
 */
const MONTHS = {
  jan: 0, january: 0,  feb: 1, february: 1,  mar: 2, march: 2,
  apr: 3, april: 3,    may: 4,                jun: 5, june: 5,
  jul: 6, july: 6,     aug: 7, august: 7,     sep: 8, september: 8, sept: 8,
  oct: 9, october: 9,  nov: 10, november: 10, dec: 11, december: 11,
};

function extractPostedOnDate(text) {
  if (!text) return null;

  // Walk each line. For each, both try the line as-is AND a "stripped"
  // version with "Posted on" headers, @handles, and surrounding noise
  // removed — that way single-line replies like "Posted on @goal April
  // 14" still parse, while keeping the original-line check for the
  // common date-on-its-own-line case.
  for (const rawLine of text.split("\n")) {
    const candidates = new Set();
    const trimmed = rawLine.trim();
    if (trimmed) candidates.add(trimmed);

    const stripped = trimmed
      .replace(/^(posted on|second set posted on)\b:?/i, "")
      .replace(/@[\w.]+/g, "")
      .replace(/[()–—]/g, " ")  // strip parens + em/en dashes
      .replace(/\s+/g, " ")
      .trim();
    if (stripped && stripped !== trimmed) candidates.add(stripped);

    for (const candidate of candidates) {
      const result = _parseDateToken(candidate);
      if (result) return result;
    }
  }
  return null;
}

function _parseDateToken(s) {
  const lower = s.toLowerCase();

  // "today" / "yesterday"
  if (/^today\b/.test(lower)) return formatSheetDate(new Date());
  if (/^yesterday\b/.test(lower)) {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return formatSheetDate(d);
  }

  // "April 14th 2026" / "April 14, 2026" / "April 14"
  // Allow the date to appear anywhere in the candidate string — VAs
  // sometimes prefix with extra text like "on April 14".
  const monthM = lower.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:[,\s]+(\d{4}))?\b/i);
  if (monthM) {
    const month = MONTHS[monthM[1].toLowerCase()];
    const day   = parseInt(monthM[2], 10);
    const year  = monthM[3] ? parseInt(monthM[3], 10) : guessYear(month, day);
    const d = new Date(year, month, day);
    if (!isNaN(d.getTime())) return formatSheetDate(d);
  }

  // ISO yyyy-mm-dd
  const isoM = lower.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (isoM) {
    const d = new Date(parseInt(isoM[1], 10), parseInt(isoM[2], 10) - 1, parseInt(isoM[3], 10));
    if (!isNaN(d.getTime())) return formatSheetDate(d);
  }

  // m/d or m/d/yy or m/d/yyyy  (also m-d-yy style). Anchor to word
  // boundaries so we don't accidentally pick up a fragment of "$400".
  const slashM = lower.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
  if (slashM) {
    const month = parseInt(slashM[1], 10) - 1;
    const day   = parseInt(slashM[2], 10);
    if (month < 0 || month > 11 || day < 1 || day > 31) return null;
    let year = slashM[3] ? parseInt(slashM[3], 10) : guessYear(month, day);
    if (year < 100) year += 2000;
    const d = new Date(year, month, day);
    if (!isNaN(d.getTime())) return formatSheetDate(d);
  }

  return null;
}

function guessYear(month, day) {
  const today  = new Date();
  const tryNow = new Date(today.getFullYear(), month, day);
  // If it's more than 31 days in the future, the operator probably means
  // last year (e.g. logging a Dec post in January).
  if (tryNow.getTime() - today.getTime() > 31 * 24 * 3600 * 1000) {
    return today.getFullYear() - 1;
  }
  return today.getFullYear();
}

function formatSheetDate(date) {
  // Match the existing parser.js datePosted format: "Tue 5/5/26" (AZ time)
  return date.toLocaleDateString("en-US", {
    timeZone: "America/Phoenix",
    weekday: "short",
    month:   "numeric",
    day:     "numeric",
    year:    "2-digit",
  });
}

/**
 * Build a row for an individual page's "IG Revenue Tracker" tab.
 * Column structure (different from master sheet):
 *
 *  A: Client Name  — parsed client
 *  B: Ad Type      — parsed category
 *  C: Bulk #       — e.g. "11/15"
 *  D: Date Posted  — e.g. "Mon 3/9/26"
 *  E: Post Type    — Reels / Carousel / Story / Feed (from INSTRUCTIONS)
 *  F: Post Duration — Permanent / 24hr / 1hr NIF etc. (from INSTRUCTIONS)
 *  G: Ad Price     — "$500"
 *  H: Notes        — (blank — filled manually)
 */
function buildPageRow(parsed) {
  return [
    parsed.client        || "",  // A: Client Name
    parsed.category      || "",  // B: Ad Type
    parsed.bulkNum       || "",  // C: Bulk #
    parsed.datePosted    || "",  // D: Date Posted
    parsed.postType      || "",  // E: Post Type (Reels, Carousel, etc.)
    parsed.nif           || "",  // F: Post Duration (Permanent, 24hr, etc.)
    parsed.adPrice != null ? `$${parsed.adPrice}` : "", // G: Ad Price
    "",                          // H: Notes
  ];
}

/**
 * Build the row array matching the Master Revenue Sheet "2026 Ad Overview" tab:
 *
 *  A: Forwarded   — left blank (checkbox, VA ticks manually)
 *  B: Client Name — parsed client
 *  C: Ad Type     — parsed category
 *  D: Date        — message date  e.g. "Thu 3/5/26"
 *  E: Time (MST)  — time from PAGE INFO  e.g. "4:45 PM"
 *  F: Page        — @pageHandle
 *  G: Bulk #      — left blank (manual)
 *  H: Page Ad Price — "$750"
 *  I: Status      — left blank (manual)
 *  J: Views       — left blank (filled in later)
 *  K: NIF         — NIF/duration from INSTRUCTIONS  e.g. "30min NIF"
 */
function buildRow(parsed) {
  return [
    "",                                               // A: Forwarded (checkbox — skip)
    parsed.client,                                    // B: Client Name
    parsed.category,                                  // C: Ad Type
    parsed.datePosted,                                // D: Date
    parsed.timeMST || "",                             // E: Time (MST)
    parsed.pageHandle ? `@${parsed.pageHandle}` : "", // F: Page
    parsed.bulkNum || "",                             // G: Bulk # (e.g. "11/15")
    parsed.adPrice != null ? `$${parsed.adPrice}` : "", // H: Page Ad Price ($0 is valid)
    "Scheduled",                                      // I: Status — default on insert
    "",                                               // J: Views (filled manually later)
    parsed.nif || "",                                 // K: NIF
  ];
}

/**
 * Forward the ad brief to a page's Telegram destination channel.
 *
 * Content (media/video) is now forwarded directly by Greg (wizard.js) at
 * submission time — bm_tracking_bot only forwards the brief message itself.
 *
 * @param {object} telegram        ctx.telegram (Telegraf Telegram instance)
 * @param {string} sourceChatId    The group the ad came from
 * @param {number} adMessageId     The ad brief's message_id
 * @param {string} destChatId      Destination Telegram chat ID (page's group/DM)
 * @param {string} pageHandle      For logging
 */
async function forwardToPage(telegram, sourceChatId, adMessageId, destChatId, pageHandle) {
  try {
    await telegram.forwardMessage(destChatId, sourceChatId, adMessageId);
    console.log(`[adHandler] ✅ Forward brief @${pageHandle} → ${destChatId}`);
  } catch (err) {
    console.error(`[adHandler] ❌ Forward brief @${pageHandle} → ${destChatId}: ${err.message}`);
  }
}

/**
 * Main handler — called by the Telegraf bot for every incoming message.
 */
async function handleAdMessage(ctx) {
  try {
    const chatId = String(ctx.chat?.id);

    // Only process messages from allowed groups (production + any test groups)
    if (TARGET_CHAT_IDS.size > 0 && !TARGET_CHAT_IDS.has(chatId)) return;

    const text = ctx.message?.text || ctx.message?.caption;
    if (!text) return;

    // ── Greg-handled brief → skip forwarding (Greg already forwarded per-page) ─
    // Greg's API intake adds <!-- greg-handled --> as the first line of the brief
    // so bm_tracking_bot writes to sheets but doesn't re-forward content.
    const isGregHandled = /<!--\s*greg-handled\s*-->/i.test(text);

    // ── "Posted on" reply → flip matching rows from Scheduled → Live ───────────
    if (/^posted on\b/i.test(text.trim())) {
      // Greg-mirrored confirmations carry the greg-handled tag — skip
      // sheet processing here because Greg's postedHandler already
      // updated the master + per-page sheets when it received the
      // contributor's DM. We still let the message stay in the chat
      // for the audit trail.
      if (isGregHandled) {
        console.log("[adHandler] ⏭️  Skipping greg-mirrored Posted-on (already handled by Greg)");
        return;
      }
      const handles = text.split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("@"))
        .map((l) => l.match(/^@([\w.]+)/)?.[1])
        .filter(Boolean);

      // If this is a Telegram reply, parse the original ad to get the client name
      // so we only flip rows for that specific campaign (not all Scheduled rows with matching pages)
      let clientName  = null;
      let originalList = [];
      const replyText = ctx.message?.reply_to_message?.text || ctx.message?.reply_to_message?.caption;
      if (replyText) {
        const originalParsed = parseAdMessage(replyText, new Date());
        originalList = Array.isArray(originalParsed) ? originalParsed : (originalParsed ? [originalParsed] : []);
        const first = originalList[0];
        if (first?.client) {
          clientName = first.client;
          console.log(`[adHandler] "Posted on" linked to campaign: "${clientName}"`);
        }
      }

      // ── Optional date override ─────────────────────────────────────────────
      // VAs sometimes confirm a post days late ("Posted on @goal April 14th").
      // When a date is included in the reply, also update column D in both
      // the master sheet and the per-page sheet to that date — overrides the
      // brief-posting date so the sheet reflects the actual go-live day.
      const overrideDate = extractPostedOnDate(text);

      if (handles.length > 0 && MASTER_SHEET_ID) {
        try {
          const updated = await updateStatusToLive(MASTER_SHEET_ID, TAB_NAME, handles, clientName);
          console.log(`[adHandler] ✅ "Posted on" — marked ${updated} row(s) as Live${clientName ? ` for "${clientName}"` : " (no campaign filter)"}`);
        } catch (err) {
          console.error(`[adHandler] ❌ "Posted on" update error: ${err.message}`);
        }

        if (overrideDate) {
          // Master sheet: update column D for matching client + handle rows
          try {
            const dated = await updateAdDate(MASTER_SHEET_ID, TAB_NAME, handles, clientName, overrideDate, true);
            console.log(`[adHandler] ✅ "Posted on" date override → "${overrideDate}" on ${dated} master row(s)`);
          } catch (err) {
            console.error(`[adHandler] ❌ "Posted on" date update (master): ${err.message}`);
          }

          // Per-page sheets: update column D where this handle has a sheet
          for (const handle of handles) {
            if (!isPageEnabled(handle)) continue;
            const sheetId = pagesRegistry.getSheetId(handle);
            if (!sheetId || PLACEHOLDER_PATTERN.test(sheetId)) continue;
            try {
              const dated = await updateAdDate(sheetId, PAGE_TAB_NAME, [handle], clientName, overrideDate, false);
              console.log(`[adHandler] ✅ "Posted on" date override → "${overrideDate}" on ${dated} @${handle} sheet row(s)`);
            } catch (err) {
              console.error(`[adHandler] ❌ "Posted on" date update (@${handle}): ${err.message}`);
            }
          }
        }
      }

      // ── NIF reminders start NOW (when the post actually went live) ────────────
      // The NIF window begins at post time, not at brief-forwarding time.
      for (const handle of handles) {
        const item   = originalList.find((p) => p.pageHandle === handle) || originalList[0];
        const nifMs  = parseNifMs(item?.nif);
        if (!nifMs) continue;

        const destChatId = pagesRegistry.getChatId(handle);
        if (!destChatId || PLACEHOLDER_PATTERN.test(String(destChatId))) continue;

        scheduleNifReminder(
          ctx.telegram,
          String(destChatId),
          item?.client || clientName || handle,
          handle,
          nifMs
        );
        console.log(`[adHandler] ⏰ NIF reminder scheduled for @${handle} in ${nifMs / 60000}min`);
      }

      return;
    }

    const date   = ctx.message?.date ? new Date(ctx.message.date * 1000) : new Date();
    const parsed = parseAdMessage(text, date);

    // Not an ad message — ignore silently
    if (!parsed) return;

    // Dedup: skip if we already processed this exact message (webhook retry / restart replay)
    const msgId = ctx.message.message_id;
    if (_recentlyProcessed.has(msgId)) {
      console.log(`[adHandler] ⏭️ Skipping duplicate message ${msgId}`);
      return;
    }
    _recentlyProcessed.add(msgId);
    if (_recentlyProcessed.size > DEDUP_MAX_SIZE) {
      // Trim oldest entries (Sets iterate in insertion order)
      const iter = _recentlyProcessed.values();
      for (let i = 0; i < 50; i++) _recentlyProcessed.delete(iter.next().value);
    }

    // Normalise to array so multi-page and single-page use the same code path
    const parsedList = Array.isArray(parsed) ? parsed : [parsed];

    console.log(
      `[adHandler] Ad detected: "${parsedList[0].client}" / ${parsedList[0].category}` +
      (parsedList.length > 1
        ? ` — ${parsedList.length} pages (bulk ad)`
        : ` / $${parsedList[0].adPrice}` + (parsedList[0].pageHandle ? ` → @${parsedList[0].pageHandle}` : " (no page handle)"))
    );

    // ── Write to Master Revenue Sheet ──────────────────────────────────────────
    // masterRowByHandle: handle → 1-indexed row number (used later to tick checkbox)
    const masterRowByHandle = new Map();

    if (MASTER_SHEET_ID && !PLACEHOLDER_PATTERN.test(MASTER_SHEET_ID)) {

      let successCount = 0;
      for (const item of parsedList) {
        const row = buildRow(item);
        try {
          const rowNumber = await appendRow(MASTER_SHEET_ID, TAB_NAME, row);
          successCount++;
          if (item.pageHandle && rowNumber) masterRowByHandle.set(item.pageHandle, rowNumber);
        } catch (err) {
          console.error(`[adHandler] ❌ Master sheet write error for @${item.pageHandle}: ${err.message}`);
          console.error(err.stack);
        }
      }
      console.log(`[adHandler] ✅ Master sheet: wrote ${successCount}/${parsedList.length} row(s) (tab: "${TAB_NAME}")`);
    } else {
      console.warn("[adHandler] MASTER_SHEET_ID not configured — skipping master sheet.");
    }

    const results = [];

    // ── Write to individual page revenue sheet ────────────────────────────────
    // Gated by ENABLED_PAGES env var — only runs for explicitly enabled handles.
    // Set ENABLED_PAGES=artistswithoutautotune to start; expand as validated.
    // Set ENABLED_PAGES=* to enable for all pages.
    let pageSheetCount = 0;
    for (const item of parsedList) {
      if (!item.pageHandle || !isPageEnabled(item.pageHandle)) continue;

      const sheetId = pagesRegistry.getSheetId(item.pageHandle);
      if (!sheetId || PLACEHOLDER_PATTERN.test(sheetId)) {
        console.warn(`[adHandler] ⚠️ No sheet ID for @${item.pageHandle} — add to pages.json`);
        continue;
      }

      const row = buildPageRow(item);
      try {
        await appendRow(sheetId, PAGE_TAB_NAME, row);
        pageSheetCount++;
        console.log(`[adHandler] ✅ Page sheet write: @${item.pageHandle} → "${PAGE_TAB_NAME}"`);
      } catch (err) {
        console.error(`[adHandler] ❌ Page sheet error for @${item.pageHandle}: ${err.message}`);
      }
    }
    if (pageSheetCount > 0) {
      console.log(`[adHandler] ✅ Individual page sheets: wrote ${pageSheetCount} row(s)`);
    }

    // ── Forward content + ad brief to each page's Telegram destination ─────────
    // Skip entirely if this brief was sent by Greg's /api/ad/intake — Greg already
    // forwarded per-page creatives directly to each destination.
    if (FORWARDING_ENABLED && !pagesRegistry.isForwardingDisabledGlobally() && !isGregHandled) {

      const adMessageId  = ctx.message.message_id;
      const sourceChatId = chatId;

      // Pre-compute per-handle creative bundles by reading the messageBuffer
      // backwards from the ad brief. Three formats supported:
      //
      //   1. Collab — videos with "Host: @page, invite: …" attribution.
      //      getCollabBundlesByPage returns { handle: [video, captionMsgs…, hostMsg] }
      //      so each page gets only its group's video + host message.
      //
      //   2. Per-page — media followed by labels like "@PageHandle^".
      //      getContentBundlesByPage returns { handle: [media…] } so each
      //      page gets only its labeled creative(s).
      //
      //   3. Standard — no attribution, one creative for everyone. Falls
      //      back to the last 4 preceding media messages (typical carousel
      //      slide count) and forwards the same set to every page.
      //
      // Both bundle parsers stop scanning at any non-label / non-host text,
      // so we never pull media from a previous ad's content. clearBufferUpTo
      // at the end of this handler also keeps cross-ad contamination out.
      const collabBundles  = getCollabBundlesByPage(sourceChatId, adMessageId);
      const labelBundles   = collabBundles ? null : getContentBundlesByPage(sourceChatId, adMessageId);
      const useCollab      = !!collabBundles && collabBundles.size > 0;
      const useLabels      = !useCollab && !!labelBundles && labelBundles.size > 0;
      const fallbackMedia  = (!useCollab && !useLabels)
        ? getPrecedingMessages(sourceChatId, adMessageId, 4)
            .filter((m) => m.photo || m.video || m.document || m.animation)
        : [];

      console.log(
        `[adHandler] 📤 Manual ad — forwarding ` +
        `(format: ${useCollab ? "collab" : useLabels ? "per-page" : "standard"}, ` +
        `attributed: ${useCollab ? collabBundles.size : useLabels ? labelBundles.size : 0}, ` +
        `fallback media: ${fallbackMedia.length})`,
      );

      // Only forward for pages that are enabled AND have a configured destination
      const uniqueHandles = [...new Set(
        parsedList.map((p) => p.pageHandle).filter((h) => h && isPageEnabled(h))
      )];

      let forwardOk      = 0;
      let forwardSkipped = 0;

      // Track which destination chats have already received the ad brief
      // to prevent sending the same brief 3-4x when multiple handles share a channel
      const forwardedDestinations = new Set();

      for (const handle of uniqueHandles) {
        const destChatId = pagesRegistry.getChatId(handle);

        if (!destChatId || PLACEHOLDER_PATTERN.test(String(destChatId))) {
          console.warn(`[adHandler] ⚠️ No Telegram destination configured for @${handle} — skipping forward`);
          forwardSkipped++;
          continue;
        }

        // Dedup by destination chat — skip if we already forwarded the ad brief to this channel
        const destKey = String(destChatId);
        if (forwardedDestinations.has(destKey)) {
          console.log(`[adHandler] ⏭️ Skipping @${handle} — ad already forwarded to ${destKey}`);
          forwardSkipped++;
          continue;
        }
        forwardedDestinations.add(destKey);

        // ── Forward the page's attributed creative(s) FIRST, then the brief
        const attributed = useCollab
          ? (collabBundles.get(handle.toLowerCase()) || [])
          : useLabels
            ? (labelBundles.get(handle.toLowerCase()) || [])
            : fallbackMedia;

        if (attributed.length === 0 && (useCollab || useLabels)) {
          // We HAVE per-page attribution data but this specific handle isn't
          // in it. Means the operator typo'd the label / host line, OR the
          // page was added to the brief but the creative wasn't included.
          // Don't forward random media — log and continue with brief only.
          console.warn(`[adHandler] ⚠️ No attributed creative found for @${handle} — forwarding brief only`);
        } else {
          for (const mediaMsg of attributed) {
            try {
              await ctx.telegram.forwardMessage(String(destChatId), sourceChatId, mediaMsg.message_id);
            } catch (err) {
              console.error(`[adHandler] ❌ Forward creative msg ${mediaMsg.message_id} → @${handle}: ${err.message}`);
            }
          }
          if (attributed.length > 0) {
            console.log(`[adHandler] ✅ Forwarded ${attributed.length} creative msg(s) → @${handle}`);
          }
        }

        try {
          await forwardToPage(
            ctx.telegram,
            sourceChatId,
            adMessageId,
            String(destChatId),
            handle
          );
          forwardOk++;

          // ── Tick "Forwarded" checkbox in master sheet (column A) ────────────
          const masterRow = masterRowByHandle.get(handle);
          if (MASTER_SHEET_ID && masterRow) {
            markForwarded(MASTER_SHEET_ID, TAB_NAME, masterRow).catch((err) =>
              console.error(`[adHandler] ❌ markForwarded error for @${handle}: ${err.message}`)
            );
          }

          // ── Post expiry / analytics reminder (persisted to Reminders sheet) ──
          // NIF reminder is scheduled separately from the "Posted on" handler
          // so it starts when the post actually goes live, not at brief-forwarding time.
          const item = parsedList.find((p) => p.pageHandle === handle);
          if (MASTER_SHEET_ID && item) {
            const postDur = parsePostDuration(item.nif);
            if (postDur) {
              const dueAt = new Date(Date.now() + postDur.ms).toISOString();
              appendReminder(MASTER_SHEET_ID, {
                handle,
                client:     item.client,
                destChatId: String(destChatId),
                type:       postDur.type,
                dueAt,
              }).catch((err) =>
                console.error(`[adHandler] ❌ appendReminder error for @${handle}: ${err.message}`)
              );
            }
          }

        } catch (err) {
          console.error(`[adHandler] ❌ Forward error for @${handle}: ${err.message}`);
        }
      }

      console.log(
        `[adHandler] 📤 Forward summary: ${forwardOk} sent, ${forwardSkipped} skipped`
      );

      // Clear the buffer up to and including this ad message so stale
      // content from this batch doesn't leak into the next ad's scan.
      clearBufferUpTo(sourceChatId, adMessageId);
    }

    // ── Optional: reply in the chat with a status update ──────────────────────
    // Uncomment the block below if you want the bot to silently confirm each write.
    // (Keep it commented for production to avoid spamming the group.)
    /*
    const summary = results.join("\n");
    await ctx.reply(
      `📊 Revenue logged for *${parsed.client}* ($${parsed.adPrice})\n${summary}`,
      { parse_mode: "Markdown", reply_to_message_id: ctx.message.message_id }
    );
    */

  } catch (err) {
    console.error("[adHandler] Unhandled error:", err.message);
  }
}

module.exports = { handleAdMessage, extractPostedOnDate };
