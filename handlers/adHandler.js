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
const { appendRow, markForwarded, updateStatusToLive, appendReminder } = require("../sheets");
const { getPrecedingMessages, getContentBundlesByPage, getCollabBundlesByPage, MAX_BUFFER_PER_CHAT } = require("../messageBuffer");
const { parseNifMs, scheduleNifReminder } = require("../scheduler");
const { parsePostDuration }    = require("../reminders");
const pages                    = require("../config/pages.json");
const destinations             = require("../config/telegram-destinations.json");

// Supports comma-separated chat IDs so a test group can run alongside production.
// e.g. TARGET_CHAT_ID=-1001111111111,-1002222222222
const TARGET_CHAT_IDS = new Set(
  (process.env.TARGET_CHAT_ID || "").split(",").map((id) => id.trim()).filter(Boolean)
);
const MASTER_SHEET_ID = process.env.MASTER_SHEET_ID;
const TAB_NAME        = process.env.SHEET_TAB_NAME      || "2026 Ad Overview";
const PAGE_TAB_NAME   = process.env.PAGE_SHEET_TAB_NAME || "IG Revenue Tracker";

// How many messages before the ad brief to grab as content (image / video / copy)
const CONTENT_MESSAGES_TO_FORWARD = parseInt(process.env.FORWARD_PRECEDING_COUNT || "2");

// Set FORWARDING_ENABLED=true in env to turn on forwarding
const FORWARDING_ENABLED = (process.env.FORWARDING_ENABLED || "").toLowerCase() === "true";

// Comma-separated list of page handles to enable individual sheet writes + forwarding for.
// e.g. ENABLED_PAGES=artistswithoutautotune
// Leave empty / unset to disable all individual page writes (master sheet only).
// Set to "*" to enable for all pages.
const ENABLED_PAGES_RAW = process.env.ENABLED_PAGES || "";
const ENABLED_PAGES_ALL = ENABLED_PAGES_RAW.trim() === "*";
const ENABLED_PAGES_SET = new Set(
  ENABLED_PAGES_RAW.split(",").map((h) => h.trim().toLowerCase().replace(/^@/, "")).filter(Boolean)
);
const isPageEnabled = (handle) =>
  handle && (ENABLED_PAGES_ALL || ENABLED_PAGES_SET.has(handle.toLowerCase()));

// Placeholder values that haven't been filled in yet (to skip writing to that sheet)
const PLACEHOLDER_PATTERN = /^(SHEET_ID_|TELEGRAM_CHAT_ID_)/;

// Track recently processed ad message IDs to prevent duplicate forwarding
// (e.g. from webhook retries or Railway restarts replaying pending updates)
const _recentlyProcessed = new Set();
const DEDUP_MAX_SIZE = 200;

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
 * Forward the ad content (preceding messages) + the ad brief itself
 * to the Telegram destination for a single page handle.
 *
 * Uses forwardMessage so media + original sender info are preserved.
 *
 * @param {object} telegram        ctx.telegram (Telegraf Telegram instance)
 * @param {string} sourceChatId    The group the ad came from
 * @param {number} adMessageId     The ad brief's message_id
 * @param {Array}  precedingMsgs   The content messages (image/video) before the ad
 * @param {string} destChatId      Destination Telegram chat ID (page's group/DM)
 * @param {string} pageHandle      For logging
 */
async function forwardToPage(telegram, sourceChatId, adMessageId, precedingMsgs, destChatId, pageHandle) {
  const results = [];

  // Only forward content messages that have actual media (photo/video/document/animation).
  // Skip text-only messages to avoid sending empty-looking forwards.
  const mediaOnly = precedingMsgs.filter((msg) =>
    msg.photo || msg.video || msg.document || msg.animation
  );

  // Forward media content first (oldest → newest), then the ad brief
  const messagesToForward = [...mediaOnly, { message_id: adMessageId, _isAdBrief: true }];

  for (const msg of messagesToForward) {
    try {
      await telegram.forwardMessage(
        destChatId,       // to
        sourceChatId,     // from chat
        msg.message_id    // message to forward
      );
      results.push(`✅ msg ${msg.message_id}`);
    } catch (err) {
      results.push(`❌ msg ${msg.message_id}: ${err.message}`);
    }
  }

  console.log(`[adHandler] Forward @${pageHandle} → ${destChatId}: ${results.join(", ")}`);
  return results;
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

    // ── "Posted on" reply → flip matching rows from Scheduled → Live ───────────
    if (/^posted on\b/i.test(text.trim())) {
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

      if (handles.length > 0 && MASTER_SHEET_ID) {
        try {
          const updated = await updateStatusToLive(MASTER_SHEET_ID, TAB_NAME, handles, clientName);
          console.log(`[adHandler] ✅ "Posted on" — marked ${updated} row(s) as Live${clientName ? ` for "${clientName}"` : " (no campaign filter)"}`);
        } catch (err) {
          console.error(`[adHandler] ❌ "Posted on" update error: ${err.message}`);
        }
      }

      // ── NIF reminders start NOW (when the post actually went live) ────────────
      // The NIF window begins at post time, not at brief-forwarding time.
      for (const handle of handles) {
        const item   = originalList.find((p) => p.pageHandle === handle) || originalList[0];
        const nifMs  = parseNifMs(item?.nif);
        if (!nifMs) continue;

        const destChatId = destinations[handle];
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

      const sheetId = pages[item.pageHandle];
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
    if (FORWARDING_ENABLED && !destinations._forwarding_disabled_globally) {

      const adMessageId  = ctx.message.message_id;
      const sourceChatId = chatId;

      // ── Detect which content format this ad uses ──────────────────────────
      //
      // Priority 1 — Per-creative ("Thefuck.tv^" label + images per page)
      // Priority 2 — Collab ("Host: @X, invite: @A @B" + paired video)
      // Priority 3 — Standard (shared preceding N messages → all pages)
      //
      const contentBundles = getContentBundlesByPage(sourceChatId, adMessageId);
      const collabBundles  = getCollabBundlesByPage(sourceChatId, adMessageId);

      const hasLabels = contentBundles.size > 0;
      const hasCollab = collabBundles !== null;   // null = not collab, Map = collab

      let fallbackMsgs = [];
      if (hasLabels) {
        console.log(
          `[adHandler] 📤 Per-creative format — ${contentBundles.size} labeled bundle(s): ` +
          [...contentBundles.keys()].join(", ")
        );
      } else if (hasCollab) {
        console.log(
          `[adHandler] 📤 Collab format — ${collabBundles.size} page(s) mapped from Host/invite messages`
        );
      } else {
        // Standard format — no labeled bundles, no collab.
        // Send brief only (no preceding content) to avoid forwarding stale
        // buffer messages (reminders, chat noise, etc.) to page groups.
        console.log(`[adHandler] 📤 Standard format — brief only, no preceding content`);
      }

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
        const destChatId = destinations[handle];

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

        // ── Pick the right content messages for this page ──────────────────
        let contentMsgs;

        // Helper: look up a handle in a Map, with a dot/underscore-stripped fallback
        const lookupHandle = (map, h) => {
          if (map.has(h)) return map.get(h);
          const stripped = h.replace(/[._]/g, "");
          for (const [k, v] of map) {
            if (k.replace(/[._]/g, "") === stripped) return v;
          }
          return null;
        };

        if (hasLabels) {
          // Format 1 — per-creative ("Thefuck.tv^" bundles)
          contentMsgs = lookupHandle(contentBundles, handle);
          if (!contentMsgs) {
            console.warn(`[adHandler] ⚠️ No per-creative bundle for @${handle} — skipping forward`);
            forwardSkipped++;
            continue;
          }

        } else if (hasCollab) {
          // Format 2 — collab ("Host: @X, invite: @A @B" + paired video)
          contentMsgs = lookupHandle(collabBundles, handle);
          if (!contentMsgs) {
            console.warn(`[adHandler] ⚠️ No collab bundle for @${handle} — skipping forward`);
            forwardSkipped++;
            continue;
          }

        } else {
          // Format 3 — standard (brief only, no preceding content)
          contentMsgs = [];
        }

        try {
          await forwardToPage(
            ctx.telegram,
            sourceChatId,
            adMessageId,
            contentMsgs,
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

module.exports = { handleAdMessage };
