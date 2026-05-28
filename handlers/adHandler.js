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
const { appendRow, markForwardedBatch, updateStatusToLive, updateAdDate, appendRemindersBatch, applyCenterAlignmentBatch, applyColumnCenterAlignment } = require("../sheets");
const { clearBufferUpTo, getCollabBundlesByPage, getContentBundlesByPage, getFilenameBundlesByPage, getMessages, getPrecedingMessages, getStandardBundle } = require("../messageBuffer");
const { parseNifMs, scheduleNifReminder } = require("../scheduler");
const { parsePostDuration }    = require("../reminders");
const pagesRegistry            = require("../lib/pages");
const adBriefs                 = require("../lib/adBriefs");

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

// Levenshtein distance — used to fuzzy-correct typo'd handles in
// "Posted on" replies against the original brief's page list. Iterative
// matrix; O(m*n) is fine for the handle lengths we deal with (<25 chars).
function _editDistance(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  const m = a.length, n = b.length;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

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
 * Send a stored media reference ({file_id, kind}) to a chat via the right
 * Telegram method. Used by DB-backed /replay to re-attach media when the
 * original messages are no longer in the in-memory buffer.
 *
 * Telegram file_ids stay valid as long as the bot's seen the file before,
 * regardless of how much time has passed — so this works even for briefs
 * weeks old.
 *
 * Falls back to sendDocument if kind is unknown, which works for most
 * file types as a last resort.
 *
 * @param {import("telegraf").Telegram} telegram
 * @param {string} chatId
 * @param {{file_id: string, kind: string}} ref
 */
async function sendByKind(telegram, chatId, ref) {
  if (!ref || !ref.file_id) return;
  switch (ref.kind) {
    case "photo":     return telegram.sendPhoto    (chatId, ref.file_id);
    case "video":     return telegram.sendVideo    (chatId, ref.file_id);
    case "document":  return telegram.sendDocument (chatId, ref.file_id);
    case "animation": return telegram.sendAnimation(chatId, ref.file_id);
    case "audio":     return telegram.sendAudio    (chatId, ref.file_id);
    case "voice":     return telegram.sendVoice    (chatId, ref.file_id);
    case "video_note": return telegram.sendVideoNote(chatId, ref.file_id);
    default:          return telegram.sendDocument(chatId, ref.file_id); // best-effort fallback
  }
}

/**
 * Pull the highest-resolution file_id + media kind out of a Telegram message.
 * The kind tells a future /replay which Telegram API to use to re-send the
 * file (sendPhoto vs sendVideo vs sendDocument vs sendAnimation etc.) —
 * file_id alone doesn't reveal type, so we record both.
 *
 * Returns null if the message carries no media (e.g. text-only).
 *
 * @returns {{file_id: string, kind: string} | null}
 */
function extractMediaRef(msg) {
  if (!msg) return null;
  if (msg.photo && msg.photo.length > 0) {
    // photo is an array of size variants — last is highest resolution
    return { file_id: msg.photo[msg.photo.length - 1].file_id, kind: "photo" };
  }
  if (msg.video)      return { file_id: msg.video.file_id,      kind: "video" };
  if (msg.document)   return { file_id: msg.document.file_id,   kind: "document" };
  if (msg.animation)  return { file_id: msg.animation.file_id,  kind: "animation" };
  if (msg.audio)      return { file_id: msg.audio.file_id,      kind: "audio" };
  if (msg.voice)      return { file_id: msg.voice.file_id,      kind: "voice" };
  if (msg.video_note) return { file_id: msg.video_note.file_id, kind: "video_note" };
  return null;
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
    parsed.postType      || "",  // E: Post Type (Reels, Carousel, Story, Feed)
    parsed.postDuration  || "",  // F: Post Duration (Permanent, 24hr, 30 Days, etc.)
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
    parsed.status || "Scheduled",                     // I: Status — override via parsed.status (e.g. "Live" on /syncsheets recovery)
    "",                                               // J: Views (filled manually later)
    parsed.nif || "",                                 // K: NIF
  ];
}

/**
 * Build a per-page version of the brief — strips other pages from the
 * PAGE INFO list and rewrites the header dollar amount to just this
 * page's price. Matches the convention VAs follow when copy-pasting:
 *
 *   Phil Heave JerkMate - Sexual - $4,350         →   Phil Heave JerkMate - Sexual - $600
 *
 *   PAGE INFO:                                         PAGE INFO:
 *   11:30am AZ / 2:30pm EST                            11:30am AZ / 2:30pm EST
 *   @moist - $750                                      @thefuck.tv - $600
 *   @dailyhumor_4u - $700
 *   @i_have_no_memes96_v2 - $600
 *   @thefuck.tv - $600
 *   …
 *
 * Strategy: extract the original line for this handle verbatim (so any
 * bulk numbers, parentheticals, or other annotations Danielson adds
 * survive intact), and keep the INSTRUCTIONS section unchanged.
 *
 * Returns null when the brief can't be parsed cleanly (no PAGE INFO
 * section, no matching handle line) so the caller can fall back to
 * forwardMessage of the original.
 */
function buildPerPageBriefText(originalText, pageHandle, pagePriceFromParser) {
  if (!originalText) return null;
  const pageInfoIdx = originalText.search(/PAGE INFO:/i);
  if (pageInfoIdx === -1) return null;

  const headerPart = originalText.slice(0, pageInfoIdx);
  const infoPart   = originalText.slice(pageInfoIdx);

  // Find the original line for THIS handle inside PAGE INFO (verbatim).
  // Escape dots for regex (handles like "thefuck.tv", "secrets.jp").
  const handleEsc = pageHandle.replace(/[.\\]/g, "\\$&");
  const pageLineRe = new RegExp(`^[ \\t]*\\(?[^@\\n]*@${handleEsc}\\b.*$`, "mi");
  const pageLineMatch = infoPart.match(pageLineRe);
  if (!pageLineMatch) return null; // handle not present in PAGE INFO list
  const pageLine = pageLineMatch[0].trim();

  // Extract the time / date header line (first non-empty, non-@ line after
  // "PAGE INFO:"). Preserves whatever format Danielson used.
  const infoLines = infoPart.split("\n");
  let timeLine = "";
  for (let i = 1; i < infoLines.length; i++) {
    const t = infoLines[i].trim();
    if (!t) continue;
    if (t.startsWith("@") || /^\(/.test(t)) break; // hit the page list
    timeLine = t;
    break;
  }

  // Rewrite header price to this page's. Matches "$<number>" at end of
  // the FIRST line (the header). Leaves rest of headerPart (INSTRUCTIONS,
  // senior tags, bullets) untouched.
  //
  // Use function replacer (not string with $N backrefs) because the
  // pricePart contains "$<number>" and "$100" / "$200" etc. would otherwise
  // be parsed as group-N backreferences by String.replace.
  const pricePart = pagePriceFromParser != null ? `$${pagePriceFromParser}` : "$0";
  const newHeader = headerPart.replace(
    /^([^\n]+?)\s*-\s*\$[\d,]+(?:\.\d+)?(\s*\n)/,
    (_match, g1, g2) => `${g1} - ${pricePart}${g2}`,
  );

  // Reassemble. Preserve any whitespace style by re-using a typical layout.
  const trimmedHeader = newHeader.trimEnd();
  return `${trimmedHeader}\n\nPAGE INFO:\n\n${timeLine ? timeLine + "\n\n" : ""}${pageLine}`;
}

/**
 * Send a per-page version of the ad brief to a page's Telegram destination.
 *
 * Previously this was a `forwardMessage` that re-sent the full brief (every
 * page + every price). Now we rebuild a brief that contains only THIS page's
 * row + THIS page's price in the header — matches how VAs manually format
 * briefs in IG Ads chats. If the rewrite fails (parser couldn't isolate the
 * handle), falls back to forwardMessage of the original brief so the chat
 * still gets something.
 *
 * Content (media/video) is forwarded separately upstream — bm_tracking_bot
 * only handles the brief text here.
 *
 * @param {object} telegram        ctx.telegram (Telegraf Telegram instance)
 * @param {string} sourceChatId    The group the ad came from
 * @param {number} adMessageId     The ad brief's message_id (for fallback forward)
 * @param {string} originalText    The original brief's text (for rewriting)
 * @param {string} destChatId      Destination Telegram chat ID (page's group/DM)
 * @param {string} pageHandle      Page handle (e.g. "thefuck.tv")
 * @param {object} parsedItem      Parsed item for this page (gives adPrice, etc.)
 */
async function forwardToPage(telegram, sourceChatId, adMessageId, originalText, destChatId, pageHandle, parsedItem) {
  const perPageText = buildPerPageBriefText(originalText, pageHandle, parsedItem?.adPrice);
  if (perPageText) {
    try {
      await telegram.sendMessage(destChatId, perPageText);
      console.log(`[adHandler] ✅ Per-page brief @${pageHandle} → ${destChatId} ($${parsedItem?.adPrice ?? "?"})`);
      return;
    } catch (err) {
      console.error(`[adHandler] ❌ Per-page brief @${pageHandle} → ${destChatId}: ${err.message} — falling back to original forward`);
    }
  } else {
    console.warn(`[adHandler] ⚠️ Couldn't build per-page brief for @${pageHandle} — using original forward`);
  }

  // Fallback: forward the original brief verbatim
  try {
    await telegram.forwardMessage(destChatId, sourceChatId, adMessageId);
    console.log(`[adHandler] ✅ Forward brief @${pageHandle} → ${destChatId} (full brief, rewrite skipped)`);
  } catch (err) {
    console.error(`[adHandler] ❌ Forward brief @${pageHandle} → ${destChatId}: ${err.message}`);
  }
}

/**
 * Main handler — called by the Telegraf bot for every incoming message.
 */
/**
 * /replay — re-run brief forwarding for a previously-processed brief.
 *
 * Triggered when an admin replies to a brief with "/replay" (optionally
 * followed by specific @handles). Useful when forwarding failed for one
 * or more pages (e.g., bot wasn't a member of the destination chat at
 * the time of the original processing) and is now fixed.
 *
 * Skips master sheet write, per-page sheet write, mark-forwarded, and
 * NIF reminder scheduling — those side effects were already done by the
 * original processing run. Replay is PURE Telegram re-forwarding.
 *
 * Constraint: the brief + its preceding media must still be in the
 * messageBuffer (capped at MAX_BUFFER_PER_CHAT = 30 messages per chat).
 * If the buffer has aged out, surface a clear error.
 */
async function handleReplayCommand(ctx) {
  // Admin gate — /replay re-triggers forwards, so restrict to the bot's
  // configured admin. WIZARD_ADMIN_USER_ID is the numeric Telegram user
  // ID set in env (5849045894 = Connor on master-revenue-sheet-workflow).
  const adminId = parseInt(process.env.WIZARD_ADMIN_USER_ID || "0", 10);
  if (adminId && ctx.from?.id !== adminId) {
    console.log(`[adHandler] /replay denied — user ${ctx.from?.id} is not admin (${adminId})`);
    return;
  }

  const cmdText = (ctx.message?.text || "").trim();
  const handleMatches = cmdText.match(/@([\w.]+)/g) || [];
  const requestedHandles = handleMatches.map((h) => h.slice(1).toLowerCase());

  // Two paths to find the brief:
  //   1. Reply mode — reply to the brief, use reply_to_message
  //   2. Search mode — campaign name follows /replay (before any @handles)
  let briefText, briefMessageId, sourceChatId, briefDate;
  const replyTo = ctx.message?.reply_to_message;

  if (replyTo) {
    // Reply mode — first try the replied message itself
    briefText      = replyTo.text || replyTo.caption || "";
    briefMessageId = replyTo.message_id;
    sourceChatId   = String(ctx.chat.id);
    briefDate      = new Date((replyTo.date || Math.floor(Date.now() / 1000)) * 1000);
    if (!briefText) {
      // DB fallback — replied msg has no text but we may have captured it earlier.
      // Happens when the brief is a media-only message and the captured raw_text
      // is on a different originating message_id.
      const dbBrief = await adBriefs.findBriefByTelegramMessage(
        Number(ctx.chat.id),
        replyTo.message_id,
      );
      if (dbBrief) {
        briefText = dbBrief.raw_text;
        briefDate = new Date(dbBrief.received_at);
        console.log(`[adHandler] 🔁 /replay reply-mode found brief in DB — brief_id=${dbBrief.id.slice(0, 8)}…`);
      } else {
        await ctx.reply("❌ Replied message has no text — can't replay.").catch(() => {});
        return;
      }
    }
  } else {
    // Search mode — strip "/replay" + handle mentions to get the campaign name
    const campaignName = cmdText
      .replace(/^\/replay\s*/i, "")
      .replace(/@[\w.]+/g, "")
      .trim();
    if (!campaignName) {
      await ctx.reply(
        "❌ Usage:\n" +
        "• Reply to a brief with `/replay [@handle …]`\n" +
        "• Or type `/replay <campaign name> @handle [@handle …]`\n\n" +
        "Example: `/replay stake bet slip day 5 @howeverythingworks`",
        { parse_mode: "Markdown" }
      ).catch(() => {});
      return;
    }
    if (requestedHandles.length === 0) {
      await ctx.reply(
        `❌ Search mode requires at least one @handle. ` +
        `Example: \`/replay ${campaignName} @howeverythingworks\``,
        { parse_mode: "Markdown" }
      ).catch(() => {});
      return;
    }

    // Search each TARGET chat's buffer for a brief matching this campaign name.
    // Match = every word in the query appears in the brief's client field
    // (case-insensitive). Walks newest → oldest so we hit the most recent
    // matching brief if multiple exist.
    const queryWords = campaignName.toLowerCase().split(/\s+/).filter(Boolean);
    let match = null;
    outer: for (const tc of TARGET_CHAT_IDS) {
      const msgs = getMessages(tc);
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i];
        const t = msg.text || msg.caption || "";
        if (!t) continue;
        const parsed = parseAdMessage(t, new Date((msg.date || 0) * 1000));
        if (!parsed) continue;
        const items = Array.isArray(parsed) ? parsed : [parsed];
        const briefClient = (items[0]?.client || "").toLowerCase();
        if (!briefClient) continue;
        if (queryWords.every((w) => briefClient.includes(w))) {
          match = { msg, chatId: tc, items, parsedClient: items[0]?.client };
          break outer;
        }
      }
    }

    // ── DB fallback ─────────────────────────────────────────────────────────
    // Buffer miss → check the ad_briefs table (persisted since 8fc4cda).
    // This lets /replay reach briefs older than the in-memory buffer's window.
    // Limitation: DB has raw_text + shared media file_ids but no Message
    // objects, so media re-attachment via DB requires schema extension to
    // store media types (out of scope this commit). For now the DB path
    // forwards the per-page brief text only — same UX as a text-only
    // campaign like Stake. Full media replay from DB lands in a follow-up.
    let dbBrief = null;
    if (!match) {
      const candidates = await adBriefs.findBriefsByClient(campaignName, 5);
      if (candidates.length > 0) {
        // Default: most recent match (already sorted DESC). If multiple,
        // surface the date list so user can re-issue with a more specific name.
        dbBrief = candidates[0];
        if (candidates.length > 1) {
          // Heads-up listing: monthly-recurring briefs (Stake bet slip etc.)
          // will have multiple matches. Show date_posted so user can confirm.
          const lines = candidates.map((b, i) => {
            const dt = new Date(b.received_at).toLocaleString("en-US", {
              timeZone: "America/Phoenix",
              weekday: "short",
              month:   "numeric",
              day:     "numeric",
              year:    "2-digit",
              hour:    "numeric",
              minute:  "2-digit",
            });
            return `${i === 0 ? "▶" : " "} [${i + 1}] ${dt} — ${b.client}`;
          });
          await ctx.reply(
            `🔍 Found ${candidates.length} briefs matching "${campaignName}".\n` +
            `Replaying the most recent (▶):\n\n${lines.join("\n")}\n\n` +
            `If you wanted a different one, re-run /replay with a more specific name ` +
            `(e.g. add the month: "${campaignName} ${new Date(candidates[0].received_at).toLocaleString("en-US", { month: "short", timeZone: "America/Phoenix" })}").`,
            { parse_mode: "Markdown" }
          ).catch(() => {});
        }
      }
    }

    if (!match && !dbBrief) {
      await ctx.reply(
        `❌ Couldn't find a brief matching "${campaignName}" in the bot's recent buffers ` +
        `or DB history.\n\n` +
        `Either the brief was never seen by this bot (predates DB capture, deployed today) ` +
        `or the name doesn't match. Try replying to the brief directly with ` +
        `\`/replay @${requestedHandles.join(" @")}\` instead.`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
      return;
    }

    if (match) {
      briefText      = match.msg.text || match.msg.caption || "";
      briefMessageId = match.msg.message_id;
      sourceChatId   = match.chatId;
      briefDate      = new Date((match.msg.date || 0) * 1000);
      console.log(`[adHandler] 🔁 /replay search (buffer) found "${match.parsedClient}" in chat ${sourceChatId} (msg ${briefMessageId})`);
    } else {
      // DB path — synthesize what buffer mode would have provided
      briefText      = dbBrief.raw_text;
      briefMessageId = dbBrief.telegram_message_id;
      sourceChatId   = String(dbBrief.telegram_chat_id);
      briefDate      = new Date(dbBrief.received_at);
      console.log(`[adHandler] 🔁 /replay search (DB) found "${dbBrief.client}" — brief_id=${dbBrief.id.slice(0, 8)}…`);
    }
  }

  // Re-parse the brief (search mode parsed once already, but re-parse for
  // consistency — cheap and ensures parsedList is always available below)
  const parsed = parseAdMessage(briefText, briefDate);
  if (!parsed) {
    await ctx.reply("❌ Couldn't parse the brief.").catch(() => {});
    return;
  }
  const parsedList = Array.isArray(parsed) ? parsed : [parsed];

  // Figure out which handles to target
  const briefHandles = new Set(parsedList.map((p) => p.pageHandle?.toLowerCase()).filter(Boolean));
  let targetHandles;
  if (requestedHandles.length === 0) {
    targetHandles = [...briefHandles];
  } else {
    const valid   = requestedHandles.filter((h) => briefHandles.has(h));
    const invalid = requestedHandles.filter((h) => !briefHandles.has(h));
    if (valid.length === 0) {
      await ctx.reply(
        `❌ None of those handles are in this brief.\n\n` +
        `Brief lists: ${[...briefHandles].map((h) => "@" + h).join(", ") || "(none)"}`
      ).catch(() => {});
      return;
    }
    targetHandles = valid;
    if (invalid.length > 0) {
      console.warn(`[adHandler] /replay: ignoring handles not in brief: ${invalid.join(", ")}`);
    }
  }

  // Filter to pages that are auto_forward + have a chat_id
  const ready  = targetHandles.filter((h) => isPageEnabled(h) && pagesRegistry.getChatId(h));
  const noFwd  = targetHandles.filter((h) => !isPageEnabled(h));
  const noChat = targetHandles.filter((h) => isPageEnabled(h) && !pagesRegistry.getChatId(h));
  if (ready.length === 0) {
    let msg = "❌ No targetable handles.\n\n";
    if (noFwd.length > 0)  msg += `auto_forward=false: ${noFwd.map((h) => "@" + h).join(", ")}\n`;
    if (noChat.length > 0) msg += `No chat_id configured: ${noChat.map((h) => "@" + h).join(", ")}\n`;
    await ctx.reply(msg.trim()).catch(() => {});
    return;
  }

  // ── Look up brief + page rows in DB ─────────────────────────────────────
  // If this brief was processed AFTER the adBriefs wiring landed (8fc4cda),
  // we can backfill any sheet rows that were missed at original-processing
  // time (e.g. dropped by Sheets API quota errors). When briefRowId is null
  // — either DB disabled or brief predates the capture — skip backfill
  // silently and just do pure Telegram re-forwarding.
  const dbBriefForBackfill = await adBriefs.findBriefByTelegramMessage(
    Number(sourceChatId),
    briefMessageId,
  );
  const dbPagesByHandle = new Map();
  if (dbBriefForBackfill) {
    const dbPages = await adBriefs.getBriefPages(dbBriefForBackfill.id);
    for (const p of dbPages) dbPagesByHandle.set(p.page_handle, p);
    console.log(`[adHandler] 🔁 /replay: backfill enabled — ${dbPages.length} DB page rows linked to brief`);
  }

  // Re-build bundles from the messageBuffer (same logic as initial processing).
  // Same getStandardBundle fallback as the main handler so /replay handles
  // 6+ slide carousels without dropping early slides.
  const collabBundles    = getCollabBundlesByPage(sourceChatId, briefMessageId);
  const filenameBundles  = collabBundles ? null : getFilenameBundlesByPage(sourceChatId, briefMessageId);
  const labelBundles     = (collabBundles || filenameBundles) ? null : getContentBundlesByPage(sourceChatId, briefMessageId);
  const useCollab        = !!collabBundles    && collabBundles.byHandle.size    > 0;
  const useFilenames     = !useCollab && !!filenameBundles && filenameBundles.byHandle.size > 0;
  const useLabels        = !useCollab && !useFilenames && !!labelBundles && labelBundles.byHandle.size > 0;
  const standardBundle   = (!useCollab && !useFilenames && !useLabels)
                         ? getStandardBundle(sourceChatId, briefMessageId)
                         : null;
  const activeBundle     = useCollab    ? collabBundles
                         : useFilenames ? filenameBundles
                         : useLabels    ? labelBundles
                         : standardBundle;
  const sharedBundle     = activeBundle?.shared || { media: [], caption: null };
  const fallbackMedia    = (sharedBundle.media.length === 0 && !useCollab && !useFilenames && !useLabels)
    ? getPrecedingMessages(sourceChatId, briefMessageId, 4)
        .filter((m) => m.photo || m.video || m.document || m.animation)
    : [];

  const format = useCollab ? "collab" : useFilenames ? "filename" : useLabels ? "label" : "standard";
  const hasMediaInBuffer =
    (activeBundle && activeBundle.byHandle.size > 0) ||
    sharedBundle.media.length > 0 ||
    fallbackMedia.length > 0;

  // DB-backed media: if buffer is empty but we have JSONB page_media or
  // shared_media populated from a prior brief capture, we can still
  // re-attach media via sendPhoto/sendVideo using the stored file_ids.
  const hasMediaInDb =
    (dbBriefForBackfill?.shared_media?.length > 0) ||
    [...dbPagesByHandle.values()].some((p) => p.page_media?.length > 0);

  console.log(
    `[adHandler] 🔁 /replay triggered — brief msg ${briefMessageId}, ${ready.length} target handle(s), format: ${format}, ` +
    `attributed: ${activeBundle?.byHandle.size || 0}, shared media: ${sharedBundle.media.length}, fallback: ${fallbackMedia.length}, ` +
    `db media: ${hasMediaInDb ? "yes" : "no"}`,
  );

  if (!hasMediaInBuffer && !hasMediaInDb && !sharedBundle.caption && !dbBriefForBackfill?.shared_caption) {
    // Brief itself was found (otherwise we'd have errored out earlier) — what's
    // missing is the *media bundle* (covers / slides / caption). For text-only
    // briefs (e.g. Stake bet slips, where pages create their own clips) this
    // is the expected case, not an error. Phrase it accordingly.
    await ctx.reply(
      `ℹ️ No media bundle attached to this brief — forwarding the per-page brief text only.\n\n` +
      `(Normal for text-only campaigns like Stake bet slips. If media *was* expected, the brief is older than the bot's in-memory buffer and wasn't captured to DB.)`
    ).catch(() => {});
  }

  // Run forwarding loop
  let ok = 0;
  const errors = [];
  const forwardedDestinations = new Set();

  for (const handle of ready) {
    const destChatId = String(pagesRegistry.getChatId(handle));
    if (forwardedDestinations.has(destChatId)) {
      console.log(`[adHandler]    ⏭️ /replay: skipping @${handle} — dest ${destChatId} already covered`);
      continue;
    }
    forwardedDestinations.add(destChatId);

    const perPageBundle = activeBundle
      ? (activeBundle.byHandle.get(handle.toLowerCase()) || { media: [], caption: null })
      : { media: fallbackMedia, caption: null };

    // DB media fallback: when the buffer doesn't have the bundle (because
    // the brief aged out / was processed pre-deploy), fall back to
    // ad_brief_pages.page_media + ad_briefs.shared_media JSONB columns.
    // Each entry is { file_id, kind } → routes to sendPhoto/sendVideo/etc.
    const dbPageForMedia = dbPagesByHandle.get(handle.toLowerCase());
    const dbPerPageMedia = (!perPageBundle.media.length && dbPageForMedia?.page_media) || [];
    const dbSharedMedia  = (!sharedBundle.media.length && dbBriefForBackfill?.shared_media) || [];
    const dbPerPageCaption = !perPageBundle.caption && dbPageForMedia?.page_caption || null;
    const dbSharedCaption  = !sharedBundle.caption && dbBriefForBackfill?.shared_caption || null;

    try {
      // 1. Per-page media — buffer (forwardMessage) OR DB (sendByKind)
      for (const m of perPageBundle.media) {
        try {
          await ctx.telegram.forwardMessage(destChatId, sourceChatId, m.message_id);
        } catch (err) {
          console.error(`[adHandler] ❌ /replay per-page msg ${m.message_id} → @${handle}: ${err.message}`);
        }
      }
      for (const ref of dbPerPageMedia) {
        try { await sendByKind(ctx.telegram, destChatId, ref); }
        catch (err) { console.error(`[adHandler] ❌ /replay per-page (DB) ${ref.kind} → @${handle}: ${err.message}`); }
      }
      const perPageTotal = perPageBundle.media.length + dbPerPageMedia.length;
      if (perPageTotal > 0) {
        console.log(`[adHandler] ✅ /replay forwarded ${perPageTotal} per-page msg(s) → @${handle} (buffer: ${perPageBundle.media.length}, DB: ${dbPerPageMedia.length})`);
      }

      // 2. Shared media — same two paths
      for (const m of sharedBundle.media) {
        try {
          await ctx.telegram.forwardMessage(destChatId, sourceChatId, m.message_id);
        } catch (err) {
          console.error(`[adHandler] ❌ /replay shared msg ${m.message_id} → @${handle}: ${err.message}`);
        }
      }
      for (const ref of dbSharedMedia) {
        try { await sendByKind(ctx.telegram, destChatId, ref); }
        catch (err) { console.error(`[adHandler] ❌ /replay shared (DB) ${ref.kind} → @${handle}: ${err.message}`); }
      }
      const sharedTotal = sharedBundle.media.length + dbSharedMedia.length;
      if (sharedTotal > 0) {
        console.log(`[adHandler] ✅ /replay forwarded ${sharedTotal} shared msg(s) → @${handle} (buffer: ${sharedBundle.media.length}, DB: ${dbSharedMedia.length})`);
      }

      // 3. Caption (per-page wins over shared) — buffer first, then DB
      const captionToSend = perPageBundle.caption || sharedBundle.caption
                          || dbPerPageCaption || dbSharedCaption;
      if (captionToSend) {
        await ctx.telegram.sendMessage(destChatId, captionToSend);
        console.log(`[adHandler] 💬 /replay caption sent → @${handle}`);
      }

      // 4. Per-page brief (rewritten to just this page's row)
      const parsedItem = parsedList.find((p) => p.pageHandle?.toLowerCase() === handle);
      await forwardToPage(
        ctx.telegram, sourceChatId, briefMessageId, briefText, destChatId, handle, parsedItem,
      );

      // ── Backfill missing sheet rows ─────────────────────────────────────
      // If the original processing missed a sheet write (quota error,
      // network blip, etc.), DB will have null master_sheet_row /
      // page_sheet_row on the corresponding ad_brief_pages row. Now that
      // we're successfully forwarding, re-attempt those writes using the
      // now-deterministic appendRow. Failures here are non-fatal — log,
      // don't abort the rest of the loop.
      const dbPage = dbPagesByHandle.get(handle.toLowerCase());
      if (dbPage && parsedItem) {
        // Master sheet backfill
        if (MASTER_SHEET_ID && !dbPage.master_sheet_row && !PLACEHOLDER_PATTERN.test(MASTER_SHEET_ID)) {
          try {
            const rowNum = await appendRow(MASTER_SHEET_ID, TAB_NAME, buildRow(parsedItem));
            if (rowNum) {
              adBriefs.updatePageSheetRows(dbPage.id, { masterSheetRow: rowNum }).catch(() => {});
              // Center-align the backfilled row to match the rest of the sheet
              applyCenterAlignmentBatch(MASTER_SHEET_ID, TAB_NAME, [rowNum], "K")
                .catch(() => {});
              console.log(`[adHandler] 🩹 /replay backfilled master sheet row ${rowNum} for @${handle}`);
            }
          } catch (err) {
            console.error(`[adHandler] ❌ /replay master backfill @${handle}: ${err.message}`);
          }
        }
        // Per-page sheet backfill
        if (!dbPage.page_sheet_row) {
          const sheetId = pagesRegistry.getSheetId(handle);
          if (sheetId && !PLACEHOLDER_PATTERN.test(sheetId)) {
            try {
              const rowNum = await appendRow(
                sheetId, PAGE_TAB_NAME, buildPageRow(parsedItem),
                { anchorColumn: "A", endColumn: "H" },
              );
              if (rowNum) {
                adBriefs.updatePageSheetRows(dbPage.id, { pageSheetRow: rowNum }).catch(() => {});
                applyCenterAlignmentBatch(sheetId, PAGE_TAB_NAME, [rowNum], "H").catch(() => {});
                console.log(`[adHandler] 🩹 /replay backfilled per-page row ${rowNum} for @${handle}`);
              }
            } catch (err) {
              console.error(`[adHandler] ❌ /replay page backfill @${handle}: ${err.message}`);
            }
          }
        }
        // Mark forwarded in DB (covers both first-time successful forwards
        // and re-replays of previously-failed forwards)
        adBriefs.markPageForwarded(dbPage.id, {
          masterSheetRow: dbPage.master_sheet_row ?? null,
          pageSheetRow:   dbPage.page_sheet_row   ?? null,
        }).catch(() => {});
      }

      ok++;
      console.log(`[adHandler] ✅ /replay complete for @${handle}`);
    } catch (err) {
      errors.push({ handle, msg: err.message });
      console.error(`[adHandler] ❌ /replay @${handle}: ${err.message}`);
    }
  }

  // Reply with summary
  let reply = `🔁 *Replay summary*: ${ok}/${ready.length} sent`;
  if (errors.length > 0) {
    reply += `\n\n*Failures*:\n` + errors.map((e) => `• @${e.handle}: \`${e.msg.slice(0, 100)}\``).join("\n");
  }
  if (ready.length < targetHandles.length) {
    const skipped = targetHandles.filter((h) => !ready.includes(h));
    reply += `\n\n*Skipped* (not enabled or no chat): ${skipped.map((h) => "@" + h).join(", ")}`;
  }
  await ctx.reply(reply, { parse_mode: "Markdown" }).catch(() => {});
}

/**
 * /syncsheets — write any missing sheet rows for briefs captured in DB.
 *
 * Walks ad_brief_pages for entries with NULL master_sheet_row or
 * NULL page_sheet_row, rebuilds the rows from the joined brief data,
 * appends to the correct sheets via the (now grid-extending) appendRow,
 * and writes the resulting row numbers back to DB.
 *
 * Idempotent — only writes when the corresponding sheet_row column is
 * still NULL. Re-runs are safe.
 *
 * No Telegram re-forwarding (unlike /replay) — sheets only. Use when
 * the chat-side outcome is already fine and you just need the books
 * caught up.
 *
 * Usage:
 *   /syncsheets                       — fix everything that's missing
 *   /syncsheets FashionNova           — fix only briefs matching client name
 *   /syncsheets Stake BET SLIP Day 5  — multi-word filter works
 */
async function handleSyncSheetsCommand(ctx) {
  // Same admin gate as /replay
  const adminId = parseInt(process.env.WIZARD_ADMIN_USER_ID || "0", 10);
  if (adminId && ctx.from?.id !== adminId) {
    console.log(`[adHandler] /syncsheets denied — user ${ctx.from?.id} is not admin (${adminId})`);
    return;
  }

  const cmdText = (ctx.message?.text || "").trim();
  const clientFilter = cmdText.replace(/^\/syncsheets\s*/i, "").trim() || null;

  await ctx.reply(
    `⏳ Scanning DB for incomplete sheet writes${clientFilter ? ` matching "${clientFilter}"` : ""}…`
  ).catch(() => {});

  const incomplete = await adBriefs.findIncompletePages({ clientFilter });
  if (incomplete.length === 0) {
    await ctx.reply("✅ Nothing to sync — every captured brief has both sheet rows populated.").catch(() => {});
    return;
  }

  console.log(`[adHandler] 🩹 /syncsheets — ${incomplete.length} incomplete page row(s) to backfill`);

  let masterWritten = 0, masterAlreadyOk = 0, masterFailed = 0;
  let pageWritten   = 0, pageAlreadyOk   = 0, pageFailed   = 0, pageSkippedNoSheet = 0;
  const errors = [];
  // Collect master rows that need Forwarded ✅ — pages that DB shows as
  // forwarded but whose master row was just written by us (so the
  // original markForwarded batched never saw the row number).
  const masterRowsToTickForwarded = [];

  for (const row of incomplete) {
    const brief = row.brief;
    if (!brief) { errors.push(`@${row.page_handle}: missing brief join`); continue; }

    // Build a parsed-item shape that matches what buildRow/buildPageRow expect.
    // If DB shows this page was Posted-on (regardless of whether the master
    // row existed at the time), set status=Live so the backfilled master
    // row lands correctly instead of Scheduled.
    const parsedItem = {
      client:       brief.client,
      category:     brief.category,
      adPrice:      row.page_price,
      pageHandle:   row.page_handle,
      bulkNum:      row.bulk_num,
      postType:     brief.post_type,
      postDuration: brief.post_duration,
      nif:          brief.nif,
      datePosted:   brief.date_posted,
      timeMST:      brief.time_mst,
      status:       row.posted_at ? "Live" : "Scheduled",
    };

    // ── Master sheet backfill ───────────────────────────────────────────
    if (!row.master_sheet_row && MASTER_SHEET_ID && !PLACEHOLDER_PATTERN.test(MASTER_SHEET_ID)) {
      try {
        const rowNum = await appendRow(MASTER_SHEET_ID, TAB_NAME, buildRow(parsedItem));
        if (rowNum) {
          await adBriefs.updatePageSheetRows(row.id, { masterSheetRow: rowNum });
          applyCenterAlignmentBatch(MASTER_SHEET_ID, TAB_NAME, [rowNum], "K").catch(() => {});
          masterWritten++;
          console.log(`[adHandler] 🩹 /syncsheets: master row ${rowNum} → ${brief.client} / @${row.page_handle}`);
          // If the page was already forwarded (per DB), the original
          // markForwardedBatch never saw this row number (sheet write
          // had failed at that point). Queue for batched tick at end.
          if (row.forwarded_at) masterRowsToTickForwarded.push(rowNum);
        }
      } catch (err) {
        masterFailed++;
        const msg = `master @${row.page_handle} (${brief.client}): ${err.message}`;
        errors.push(msg);
        console.error(`[adHandler] ❌ /syncsheets ${msg}`);
      }
    } else if (row.master_sheet_row) {
      masterAlreadyOk++;
    }

    // ── Per-page sheet backfill ─────────────────────────────────────────
    if (!row.page_sheet_row) {
      const sheetId = pagesRegistry.getSheetId(row.page_handle);
      if (!sheetId || PLACEHOLDER_PATTERN.test(sheetId)) {
        pageSkippedNoSheet++;
        console.warn(`[adHandler] ⚠️ /syncsheets: no sheet_id for @${row.page_handle} — skipping per-page`);
        continue;
      }
      try {
        const rowNum = await appendRow(sheetId, PAGE_TAB_NAME, buildPageRow(parsedItem), {
          anchorColumn: "A", endColumn: "H",
        });
        if (rowNum) {
          await adBriefs.updatePageSheetRows(row.id, { pageSheetRow: rowNum });
          applyCenterAlignmentBatch(sheetId, PAGE_TAB_NAME, [rowNum], "H").catch(() => {});
          pageWritten++;
          console.log(`[adHandler] 🩹 /syncsheets: page row ${rowNum} → @${row.page_handle} (${brief.client})`);
        }
      } catch (err) {
        pageFailed++;
        const msg = `page @${row.page_handle} (${brief.client}): ${err.message}`;
        errors.push(msg);
        console.error(`[adHandler] ❌ /syncsheets ${msg}`);
      }
    } else {
      pageAlreadyOk++;
    }
  }

  // Tick Forwarded ✅ on master rows that were already forwarded per DB
  // but whose row number wasn't known when the original markForwardedBatch
  // ran. Batched into one API call to stay efficient.
  let forwardedTicked = 0;
  if (masterRowsToTickForwarded.length > 0 && MASTER_SHEET_ID) {
    try {
      await markForwardedBatch(MASTER_SHEET_ID, TAB_NAME, masterRowsToTickForwarded);
      forwardedTicked = masterRowsToTickForwarded.length;
      console.log(`[adHandler] 🩹 /syncsheets: ticked ${forwardedTicked} Forwarded checkbox(es)`);
    } catch (err) {
      console.error(`[adHandler] ❌ /syncsheets markForwarded: ${err.message}`);
      errors.push(`markForwarded: ${err.message}`);
    }
  }

  // Build a human summary
  const lines = [
    `🩹 *SyncSheets done*${clientFilter ? ` (filter: \`${clientFilter}\`)` : ""}`,
    "",
    `*Master sheet*:`,
    `  ✅ wrote ${masterWritten}`,
    `  ⏭️  already ok ${masterAlreadyOk}`,
    masterFailed > 0 ? `  ❌ failed ${masterFailed}` : null,
    forwardedTicked > 0 ? `  ✅ ticked Forwarded ${forwardedTicked}` : null,
    "",
    `*Per-page sheets*:`,
    `  ✅ wrote ${pageWritten}`,
    `  ⏭️  already ok ${pageAlreadyOk}`,
    pageSkippedNoSheet > 0 ? `  ⚠️  no sheet_id ${pageSkippedNoSheet}` : null,
    pageFailed > 0 ? `  ❌ failed ${pageFailed}` : null,
  ].filter(Boolean);
  if (errors.length > 0) {
    lines.push("", "*First few errors*:");
    errors.slice(0, 5).forEach((e) => lines.push(`• \`${e.slice(0, 150)}\``));
    if (errors.length > 5) lines.push(`…and ${errors.length - 5} more (see logs)`);
  }
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" }).catch(() => {});
}

/**
 * /centersheets — one-time column-wide center alignment on master sheet
 * + every configured per-page sheet. New rows inherit center alignment
 * from the column going forward, so the bot never has to apply per-row
 * formatting again (which was blowing the Sheets API quota).
 *
 * Throttled to 1 sheet per second to stay safely under 60/min read +
 * write quota — a 60-sheet pass takes ~60s, runs in the background.
 *
 * Usage:
 *   /centersheets         — format master + all per-page sheets
 *   /centersheets master  — master sheet only (fast)
 */
async function handleCenterSheetsCommand(ctx) {
  const adminId = parseInt(process.env.WIZARD_ADMIN_USER_ID || "0", 10);
  if (adminId && ctx.from?.id !== adminId) return;

  const cmdText = (ctx.message?.text || "").trim();
  const masterOnly = /master/i.test(cmdText);

  await ctx.reply(
    `⏳ Applying column-wide center alignment${masterOnly ? " to master sheet" : " (master + all per-page sheets)"}…\n` +
    `Throttled to ~1 sheet/sec to stay under quota.`
  ).catch(() => {});

  let ok = 0, failed = 0;
  const errors = [];

  // Master sheet
  if (MASTER_SHEET_ID && !PLACEHOLDER_PATTERN.test(MASTER_SHEET_ID)) {
    try {
      await applyColumnCenterAlignment(MASTER_SHEET_ID, TAB_NAME, "K");
      ok++;
      console.log(`[adHandler] 🎨 /centersheets: master sheet done`);
    } catch (err) {
      failed++;
      errors.push(`master: ${err.message}`);
      console.error(`[adHandler] ❌ /centersheets master: ${err.message}`);
    }
  }

  if (!masterOnly) {
    // Per-page sheets — one at a time, throttled
    const allPages = pagesRegistry.listAllSync ? pagesRegistry.listAllSync() : [];
    const targets = allPages.filter((p) => p.sheet_id && !PLACEHOLDER_PATTERN.test(p.sheet_id));
    console.log(`[adHandler] 🎨 /centersheets: ${targets.length} per-page sheets to format`);

    for (const page of targets) {
      try {
        await applyColumnCenterAlignment(page.sheet_id, PAGE_TAB_NAME, "H");
        ok++;
        console.log(`[adHandler] 🎨 /centersheets: @${page.handle} done`);
      } catch (err) {
        failed++;
        errors.push(`@${page.handle}: ${err.message}`);
        console.error(`[adHandler] ❌ /centersheets @${page.handle}: ${err.message}`);
      }
      // Throttle — stay under 60/min quota
      await new Promise((r) => setTimeout(r, 1100));
    }
  }

  const lines = [
    `🎨 *CenterSheets done*${masterOnly ? " (master only)" : ""}`,
    "",
    `✅ formatted: ${ok}`,
    failed > 0 ? `❌ failed: ${failed}` : null,
  ].filter(Boolean);
  if (errors.length > 0) {
    lines.push("", "*Errors*:");
    errors.slice(0, 10).forEach((e) => lines.push(`• \`${e.slice(0, 150)}\``));
    if (errors.length > 10) lines.push(`…and ${errors.length - 10} more (see logs)`);
  }
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" }).catch(() => {});
}

async function handleAdMessage(ctx) {
  try {
    const text = ctx.message?.text || ctx.message?.caption;

    // ── /replay — re-run forwarding for a previously-processed brief ───────────
    // Runs BEFORE the TARGET_CHAT_IDS gate so it can be invoked from any
    // chat the bot is in (e.g. Monetization Team + AI). Admin-only via
    // WIZARD_ADMIN_USER_ID check inside the handler.
    //
    // Two usage modes:
    //   • Reply mode — reply to a brief in any chat; "/replay [@handles…]"
    //   • Search mode — type "/replay <campaign name> @handle [@handle…]"
    //                   from anywhere. The bot searches its in-memory
    //                   buffers (TARGET_CHAT_IDS) for the brief by name.
    if (text && /^\/replay\b/i.test(text.trim())) {
      return await handleReplayCommand(ctx);
    }

    // /syncsheets — backfill missing sheet rows from DB. Idempotent, only
    // fills nulls. No Telegram re-forwarding — sheets only.
    if (text && /^\/syncsheets\b/i.test(text.trim())) {
      return await handleSyncSheetsCommand(ctx);
    }

    // /centersheets — one-time column-wide center formatting on every
    // configured sheet. Future rows then inherit center alignment from
    // column formatting, so no per-write API cost.
    if (text && /^\/centersheets\b/i.test(text.trim())) {
      return await handleCenterSheetsCommand(ctx);
    }

    const chatId = String(ctx.chat?.id);

    // Only process messages from allowed groups (production + any test groups)
    if (TARGET_CHAT_IDS.size > 0 && !TARGET_CHAT_IDS.has(chatId)) return;

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
      const rawHandles = text.split("\n")
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

      // Fuzzy-correct typos in Posted-on handles against the brief's actual
      // page list. Bounded to the brief's pages only (not the whole registry)
      // so we can't accidentally flip an unrelated handle. Edit distance ≤ 1
      // catches single-character typos (e.g. "oddlyhorrifyinh" → "oddlyhorrifying").
      // Ambiguous corrections (2+ candidates within distance 1) are rejected
      // and the typo is passed through unchanged — better an obvious miss than
      // a silent wrong flip.
      const briefHandles = originalList
        .map((p) => p.pageHandle)
        .filter(Boolean)
        .map((h) => h.toLowerCase());
      const handles = briefHandles.length === 0
        ? rawHandles
        : rawHandles.map((h) => {
            const lower = h.toLowerCase();
            if (briefHandles.includes(lower)) return h; // exact match already
            const candidates = briefHandles.filter((b) => _editDistance(lower, b) <= 1);
            if (candidates.length === 1) {
              console.log(`[adHandler] 🔤 Fuzzy-matched "@${h}" → "@${candidates[0]}" (typo correction)`);
              return candidates[0];
            }
            if (candidates.length > 1) {
              console.warn(`[adHandler] ⚠️ Ambiguous Posted-on handle "@${h}" — matches ${candidates.join(", ")} — leaving as-is`);
            }
            return h;
          });

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
        // Persist the Posted-on event to DB regardless of whether the
        // sheet update found rows. /syncsheets reads this later to set
        // Status=Live on any rows it backfills (covers the case where
        // the master row didn't exist when "Posted on" first ran).
        adBriefs.markPagesPosted(handles, clientName)
          .then((n) => n > 0 && console.log(`[adHandler] 📥 markPagesPosted: ${n}/${handles.length} page(s) persisted`))
          .catch((err) => console.error(`[adBriefs] markPagesPosted: ${err.message}`));

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

    // ── Persist brief skeleton to Supabase ─────────────────────────────────────
    // Insert the brief + one row per targeted page BEFORE any side effects so
    // we have stable DB IDs to attach sheet-row numbers + forward outcomes to
    // throughout the rest of this handler. Shared media / per-page media /
    // bundle format get filled in later (after bundle detection runs around
    // line ~902). Forward outcomes get attached in the forwarding loop.
    //
    // Fail-soft: if Supabase is unconfigured or insert fails, briefRowId is
    // null and pageRowIdByHandle is empty — downstream updates silently no-op
    // and the rest of the handler runs unchanged. The DB layer is a
    // tracking/audit add-on, never a hard dependency.
    let briefRowId = null;
    const pageRowIdByHandle = new Map(); // page_handle → ad_brief_pages.id
    try {
      const first = parsedList[0] || {};
      // Total price = sum of per-page prices (handles bulk briefs)
      const totalPrice = parsedList.reduce(
        (sum, p) => sum + (Number.isFinite(p.adPrice) ? p.adPrice : 0),
        0,
      );
      briefRowId = await adBriefs.insertBrief({
        telegramChatId:    Number(chatId),
        telegramMessageId: ctx.message.message_id,
        senderUserId:      ctx.message.from?.id ?? null,
        senderHandle:      ctx.message.from?.username ?? null,
        rawText:           text,
        client:            first.client ?? null,
        category:          first.category ?? null,
        totalPrice,
        postType:          first.postType ?? null,
        postDuration:      first.postDuration ?? null,
        nif:               first.nif ?? null,
        datePosted:        first.datePosted ?? null,
        timeMst:           first.timeMST ?? null,
        // shared_media_file_ids / shared_caption / bundle_format filled later
      });
      if (briefRowId) {
        const pageRows = parsedList
          .filter((p) => p.pageHandle)
          .map((p) => ({
            pageHandle: p.pageHandle.toLowerCase(),
            bulkNum:    p.bulkNum || null,
            pagePrice:  Number.isFinite(p.adPrice) ? p.adPrice : null,
          }));
        const inserted = await adBriefs.insertBriefPages(briefRowId, pageRows);
        for (const [handle, id] of inserted) pageRowIdByHandle.set(handle, id);
        console.log(`[adBriefs] 📥 Persisted brief ${briefRowId.slice(0, 8)}… (${pageRowIdByHandle.size}/${parsedList.length} pages)`);
      }
    } catch (err) {
      console.error(`[adBriefs] ❌ Failed to persist brief: ${err.message}`);
      // Continue — DB persistence is best-effort, doesn't block forwarding
    }

    // ── Write to Master Revenue Sheet ──────────────────────────────────────────
    // masterRowByHandle: handle → 1-indexed row number (used later to tick checkbox)
    const masterRowByHandle = new Map();

    // Row numbers we successfully wrote — flushed to a single batched
    // applyCenterAlignmentBatch call at the end so new rows match the team's
    // existing centered-formatting convention without N extra API calls.
    const masterRowsToFormat = [];
    if (MASTER_SHEET_ID && !PLACEHOLDER_PATTERN.test(MASTER_SHEET_ID)) {

      let successCount = 0;
      for (const item of parsedList) {
        const row = buildRow(item);
        try {
          const rowNumber = await appendRow(MASTER_SHEET_ID, TAB_NAME, row);
          successCount++;
          if (rowNumber) masterRowsToFormat.push(rowNumber);
          if (item.pageHandle && rowNumber) {
            masterRowByHandle.set(item.pageHandle, rowNumber);
            // Persist master row number to DB so we can audit + retry missing writes
            const pageRowId = pageRowIdByHandle.get(item.pageHandle.toLowerCase());
            if (pageRowId) {
              adBriefs.updatePageSheetRows(pageRowId, { masterSheetRow: rowNumber })
                .catch(() => {}); // fire-and-forget; logged inside the helper
            }
          }
        } catch (err) {
          console.error(`[adHandler] ❌ Master sheet write error for @${item.pageHandle}: ${err.message}`);
          console.error(err.stack);
        }
      }
      console.log(`[adHandler] ✅ Master sheet: wrote ${successCount}/${parsedList.length} row(s) (tab: "${TAB_NAME}")`);

      // Batched format call — center-aligns all newly-written rows in one shot
      if (masterRowsToFormat.length > 0) {
        applyCenterAlignmentBatch(MASTER_SHEET_ID, TAB_NAME, masterRowsToFormat, "K")
          .then(() => console.log(`[adHandler] 🎨 Master sheet: centered ${masterRowsToFormat.length} row(s)`))
          .catch((err) => console.error(`[adHandler] ❌ Center-align master: ${err.message}`));
      }
    } else {
      console.warn("[adHandler] MASTER_SHEET_ID not configured — skipping master sheet.");
    }

    const results = [];

    // ── Write to individual page revenue sheet ────────────────────────────────
    // Gated by ENABLED_PAGES env var — only runs for explicitly enabled handles.
    // Set ENABLED_PAGES=artistswithoutautotune to start; expand as validated.
    // Set ENABLED_PAGES=* to enable for all pages.
    let pageSheetCount = 0;
    // Group successful per-page writes by sheetId so we can format them in
    // one batchUpdate per sheet at the end (rather than one per row).
    const perPageRowsToFormat = new Map(); // sheetId → number[]
    for (const item of parsedList) {
      if (!item.pageHandle || !isPageEnabled(item.pageHandle)) continue;

      const sheetId = pagesRegistry.getSheetId(item.pageHandle);
      if (!sheetId || PLACEHOLDER_PATTERN.test(sheetId)) {
        console.warn(`[adHandler] ⚠️ No sheet ID for @${item.pageHandle} — add to pages.json`);
        continue;
      }

      const row = buildPageRow(item);
      try {
        // Per-page sheets: col A = Client Name (always filled), cols go A→H
        const pageSheetRowNum = await appendRow(sheetId, PAGE_TAB_NAME, row, { anchorColumn: "A", endColumn: "H" });
        pageSheetCount++;
        if (pageSheetRowNum) {
          if (!perPageRowsToFormat.has(sheetId)) perPageRowsToFormat.set(sheetId, []);
          perPageRowsToFormat.get(sheetId).push(pageSheetRowNum);
        }
        // Persist per-page sheet row to DB for audit + retry visibility
        const pageRowId = pageRowIdByHandle.get(item.pageHandle.toLowerCase());
        if (pageRowId && pageSheetRowNum) {
          adBriefs.updatePageSheetRows(pageRowId, { pageSheetRow: pageSheetRowNum })
            .catch(() => {});
        }
        console.log(`[adHandler] ✅ Page sheet write: @${item.pageHandle} → "${PAGE_TAB_NAME}"`);
      } catch (err) {
        console.error(`[adHandler] ❌ Page sheet error for @${item.pageHandle}: ${err.message}`);
      }
    }
    if (pageSheetCount > 0) {
      console.log(`[adHandler] ✅ Individual page sheets: wrote ${pageSheetCount} row(s)`);
    }

    // Per-page sheet center-align — now safe to fire inline because every
    // Sheets API call goes through the rate limiter in sheets.js (50/min
    // ceiling, bursts queue instead of failing). For a heavy brief the
    // formatting calls will rate-limit themselves and complete after the
    // critical data writes have already landed. /centersheets remains
    // available for one-time column-wide setup if preferred.
    for (const [sheetId, rows] of perPageRowsToFormat) {
      applyCenterAlignmentBatch(sheetId, PAGE_TAB_NAME, rows, "H")
        .catch((err) => console.error(`[adHandler] ❌ Center-align page sheet ${sheetId.slice(0, 8)}…: ${err.message}`));
    }

    // ── Forward content + ad brief to each page's Telegram destination ─────────
    // Skip entirely if this brief was sent by Greg's /api/ad/intake — Greg already
    // forwarded per-page creatives directly to each destination.
    if (FORWARDING_ENABLED && !pagesRegistry.isForwardingDisabledGlobally() && !isGregHandled) {

      const adMessageId  = ctx.message.message_id;
      const sourceChatId = chatId;

      // Pre-compute per-handle creative bundles by reading the messageBuffer
      // backwards from the ad brief. Four formats supported (checked in order):
      //
      //   1. Collab — videos with "Host: @page, invite: …" attribution.
      //      getCollabBundlesByPage returns { handle: [video, captionMsgs…, hostMsg] }.
      //
      //   2. Filename — covers uploaded as documents with "@<handle>.jpg"
      //      filenames (e.g. "@thefuck.tv.jpg", "@moist.jpg"). The handle
      //      lives in the file metadata, not surrounding text. Cheapest
      //      attribution for the team — no inline labels needed, no
      //      copy-paste mistakes. getFilenameBundlesByPage.
      //
      //   3. Per-page text labels — media followed by "@PageHandle^" lines.
      //      getContentBundlesByPage.
      //
      //   4. Standard fallback — no attribution detected. Take the last 4
      //      preceding media messages and forward the same set to every
      //      page. Right answer for true shared-creative ads, wrong for
      //      "13 unique covers" ads that didn't use a per-page convention
      //      (logs visible at FORMAT_DETECTED line below).
      //
      // Each parser stops scanning at any unrecognized non-empty text so
      // we never pull media from a previous ad's content. clearBufferUpTo
      // at the end of this handler also keeps cross-ad contamination out.
      // All three scanners now return { byHandle, shared } or null. The
      // `shared` bundle carries unattributed media (e.g. "slides 2-4 for
      // ALL pages" videos) and the IG caption text Danielson types right
      // above the brief — every page receives shared content alongside
      // its per-page attributed cover.
      const collabBundles    = getCollabBundlesByPage(sourceChatId, adMessageId);
      const filenameBundles  = collabBundles ? null : getFilenameBundlesByPage(sourceChatId, adMessageId);
      const labelBundles     = (collabBundles || filenameBundles) ? null : getContentBundlesByPage(sourceChatId, adMessageId);
      const useCollab        = !!collabBundles    && collabBundles.byHandle.size    > 0;
      const useFilenames     = !useCollab && !!filenameBundles && filenameBundles.byHandle.size > 0;
      const useLabels        = !useCollab && !useFilenames && !!labelBundles && labelBundles.byHandle.size > 0;
      // Pick the active bundle source. When no attribution is detected by
      // any of the three structured scanners, fall back to getStandardBundle:
      // walks backwards collecting ALL preceding media until hitting a
      // previous brief, and captures the IG caption text. Replaces the old
      // "last 4 preceding messages" heuristic which silently dropped slides
      // 1-5 of any 6+ slide carousel.
      const standardBundle   = (!useCollab && !useFilenames && !useLabels)
                             ? getStandardBundle(sourceChatId, adMessageId)
                             : null;
      const activeBundle     = useCollab    ? collabBundles
                             : useFilenames ? filenameBundles
                             : useLabels    ? labelBundles
                             : standardBundle;
      const sharedBundle     = activeBundle?.shared || { media: [], caption: null };
      // fallbackMedia kept as a final escape hatch — used only when the
      // ad message itself isn't in the buffer (so getStandardBundle returns
      // empty). Otherwise sharedBundle has everything.
      const fallbackMedia  = (sharedBundle.media.length === 0 && !useCollab && !useFilenames && !useLabels)
        ? getPrecedingMessages(sourceChatId, adMessageId, 4)
            .filter((m) => m.photo || m.video || m.document || m.animation)
        : [];

      const detectedFormat = useCollab ? "collab"
                           : useFilenames ? "filename-attributed"
                           : useLabels ? "per-page-label"
                           : "standard";
      // True iff we have actual per-handle attribution. Standard fallback
      // has activeBundle set but byHandle is empty by design — every page
      // gets the same shared bundle, no per-page differentiation.
      const isAttributed = useCollab || useFilenames || useLabels;
      const attributedCount = activeBundle?.byHandle.size || 0;
      console.log(
        `[adHandler] 📤 Manual ad — forwarding ` +
        `(format: ${detectedFormat}, attributed: ${attributedCount}, ` +
        `shared media: ${sharedBundle.media.length}, ` +
        `shared caption: ${sharedBundle.caption ? "yes" : "no"}, ` +
        `fallback media: ${fallbackMedia.length})`,
      );

      // ── Persist bundle info to DB ────────────────────────────────────────
      // Now that bundle detection has run, attach shared media/caption + format
      // to the brief row, and per-page media/caption to each page row. Media
      // is stored as JSONB [{file_id, kind}, …] so /replay can re-send via
      // the right Telegram method (sendPhoto / sendVideo / etc.) without
      // having to scan the in-memory buffer.
      if (briefRowId) {
        try {
          const sharedMedia = sharedBundle.media.map(extractMediaRef).filter(Boolean);
          if (sharedMedia.length > 0 || sharedBundle.caption || detectedFormat) {
            const sb = adBriefs._supabase;
            if (sb) {
              sb.from("ad_briefs").update({
                shared_media:   sharedMedia,
                shared_caption: sharedBundle.caption ?? null,
                bundle_format:  detectedFormat,
              }).eq("id", briefRowId).then(({ error }) => {
                if (error) console.error("[adBriefs] update brief bundle:", error.message);
              });
            }
          }
          if (activeBundle) {
            for (const [handle, bundle] of activeBundle.byHandle) {
              const pageRowId = pageRowIdByHandle.get(handle);
              if (!pageRowId) continue;
              const media = (bundle.media || []).map(extractMediaRef).filter(Boolean);
              if (media.length === 0 && !bundle.caption) continue;
              const sb = adBriefs._supabase;
              if (sb) {
                sb.from("ad_brief_pages").update({
                  page_media:   media,
                  page_caption: bundle.caption ?? null,
                }).eq("id", pageRowId).then(({ error }) => {
                  if (error) console.error(`[adBriefs] update page @${handle}:`, error.message);
                });
              }
            }
          }
        } catch (err) {
          console.error(`[adBriefs] ❌ Failed to update bundle info: ${err.message}`);
        }
      }

      // ── Coverage check ─────────────────────────────────────────────────
      // Cross-reference the brief's page list against what attribution
      // produced. Surfaces three useful signals BEFORE forwarding:
      //   • covered:    pages in brief AND attributed — will get per-page media
      //   • uncovered:  pages in brief BUT not attributed — will get only
      //                 shared media + brief (no cover). Operator should know
      //                 since this often means a missing @-filename or typo.
      //   • orphan:     pages attributed but NOT in the brief — usually a
      //                 typo in a handle-list or filename. The forwarder
      //                 will skip these (only brief-listed pages get sent
      //                 to), so they're surfaced for human review.
      // Skip entirely in standard fallback — there's no per-handle
      // attribution by definition, every page gets the same shared bundle.
      if (isAttributed) {
        const listed     = new Set(parsedList.map((p) => p.pageHandle?.toLowerCase()).filter(Boolean));
        const attributed = new Set([...activeBundle.byHandle.keys()]);
        const covered    = [...listed].filter((h) => attributed.has(h));
        const uncovered  = [...listed].filter((h) => !attributed.has(h));
        const orphan     = [...attributed].filter((h) => !listed.has(h));
        console.log(
          `[adHandler] 📋 Coverage: ${listed.size} in brief · ` +
          `${covered.length} with per-page media · ${uncovered.length} brief-only · ` +
          `${orphan.length} orphan attribution`,
        );
        if (uncovered.length > 0) {
          console.log(`[adHandler]    🟡 Brief-only (no per-page cover): ${uncovered.map((h) => "@" + h).join(", ")}`);
        }
        if (orphan.length > 0) {
          // Orphans are suspicious — likely typo'd handles in a label or
          // handle-list, OR an @-named file for a page not actually in this
          // brief. Either way, that media won't get forwarded (we only loop
          // over brief-listed pages). Flagging so it's visible.
          console.log(`[adHandler]    🔴 Orphan attribution (won't forward): ${orphan.map((h) => "@" + h).join(", ")}`);
        }
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

      // Collect side-effect work to flush in a single batched call AFTER
      // the per-page forward loop completes. Before: each successful
      // forward triggered 2 sheet writes (markForwarded + appendReminder),
      // so a 25-page brief = 50+ writes/min and Google Sheets API quota
      // (60 writes/min/user) would kick in and silently drop half of them.
      // After: collect during the loop, flush once = 2 calls total.
      const masterRowsToMark = [];
      const remindersToQueue = [];

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

        // ── Per-page attributed bundle (cover etc.) ──────────────────────
        // When attribution detected, look up this handle's specific bundle.
        // Pages NOT in the attribution map get an empty per-page bundle —
        // they still receive shared media + brief below.
        const perPageBundle = activeBundle
          ? (activeBundle.byHandle.get(handle.toLowerCase()) || { media: [], caption: null })
          : { media: fallbackMedia, caption: null };
        const perPageMedia   = perPageBundle.media;
        const perPageCaption = perPageBundle.caption;

        // 1️⃣ Forward per-page attributed media (cover = slide 1)
        // Only warn about missing per-page creative when an ATTRIBUTED
        // bundle is in effect (collab / filename / label). In standard
        // fallback every page receives the same shared bundle by design,
        // so "no per-page creative" isn't a missing-creative bug.
        if (perPageMedia.length === 0 && isAttributed) {
          // We HAVE attribution data but this specific handle isn't in
          // byHandle. Operator typo'd the label / host line, OR the page
          // was added to the brief but its creative wasn't included.
          // Don't forward random media — log and continue. Shared media
          // and brief below still go out so the page isn't totally silent.
          console.warn(`[adHandler] ⚠️ No per-page creative found for @${handle} — sending shared + brief only`);
        } else {
          for (const mediaMsg of perPageMedia) {
            try {
              await ctx.telegram.forwardMessage(String(destChatId), sourceChatId, mediaMsg.message_id);
            } catch (err) {
              console.error(`[adHandler] ❌ Forward per-page msg ${mediaMsg.message_id} → @${handle}: ${err.message}`);
            }
          }
          if (perPageMedia.length > 0) {
            console.log(`[adHandler] ✅ Forwarded ${perPageMedia.length} per-page msg(s) → @${handle}`);
          }
        }

        // 2️⃣ Forward shared media (slides 2-4 for ALL pages, etc.)
        // Same set to every destination, in original chronological order.
        if (sharedBundle.media.length > 0) {
          for (const mediaMsg of sharedBundle.media) {
            try {
              await ctx.telegram.forwardMessage(String(destChatId), sourceChatId, mediaMsg.message_id);
            } catch (err) {
              console.error(`[adHandler] ❌ Forward shared msg ${mediaMsg.message_id} → @${handle}: ${err.message}`);
            }
          }
          console.log(`[adHandler] ✅ Forwarded ${sharedBundle.media.length} shared msg(s) → @${handle}`);
        }

        // 3️⃣ Caption — per-page wins over shared. Either way, sent as a
        // separate text message after media so VA can copy/paste into IG.
        const captionToSend = perPageCaption || sharedBundle.caption;
        if (captionToSend) {
          try {
            await ctx.telegram.sendMessage(String(destChatId), captionToSend);
            const source = perPageCaption ? "per-page" : "shared";
            console.log(`[adHandler] 💬 ${source} caption sent → @${handle} (${captionToSend.length} chars)`);
          } catch (err) {
            console.error(`[adHandler] ❌ Caption → @${handle}: ${err.message}`);
          }
        }

        try {
          // Find the parsed item for THIS handle so the per-page brief
          // rewrite can use the right price + bulkNum + nif.
          const parsedItem = parsedList.find((p) => p.pageHandle === handle);
          await forwardToPage(
            ctx.telegram,
            sourceChatId,
            adMessageId,
            ctx.message?.text || ctx.message?.caption || "",
            String(destChatId),
            handle,
            parsedItem
          );
          forwardOk++;

          // ── Mark this page forwarded in the DB ──────────────────────────────
          // forwardToPage doesn't surface the destination message_ids, so we
          // can't store forwarded_message_ids precisely here without a bigger
          // refactor. The forwarded_at timestamp + master_sheet_row + page_sheet_row
          // are enough for /replay backfill purposes.
          const pageRowId = pageRowIdByHandle.get(handle.toLowerCase());
          if (pageRowId) {
            adBriefs.markPageForwarded(pageRowId, {
              masterSheetRow: masterRowByHandle.get(handle) ?? null,
            }).catch(() => {});
          }

          // ── Queue "Forwarded" checkbox tick (batched after loop) ────────────
          const masterRow = masterRowByHandle.get(handle);
          if (MASTER_SHEET_ID && masterRow) {
            masterRowsToMark.push(masterRow);
          }

          // ── Queue post-expiry / analytics reminder (batched after loop) ──
          // NIF reminder is scheduled separately from the "Posted on" handler
          // so it starts when the post actually goes live, not at brief-forwarding time.
          const item = parsedList.find((p) => p.pageHandle === handle);
          if (MASTER_SHEET_ID && item) {
            const postDur = parsePostDuration(item.nif);
            if (postDur) {
              const dueAt = new Date(Date.now() + postDur.ms).toISOString();
              remindersToQueue.push({
                handle,
                client:     item.client,
                destChatId: String(destChatId),
                type:       postDur.type,
                dueAt,
              });
            }
          }

        } catch (err) {
          console.error(`[adHandler] ❌ Forward error for @${handle}: ${err.message}`);
          // Record the failure on the page row so /replay can target it later
          const pageRowId = pageRowIdByHandle.get(handle.toLowerCase());
          if (pageRowId) {
            adBriefs.markPageForwardError(pageRowId, err.message || String(err))
              .catch(() => {});
          }
        }
      }

      console.log(
        `[adHandler] 📤 Forward summary: ${forwardOk} sent, ${forwardSkipped} skipped`
      );

      // ── Flush batched side effects (1 sheet call each, not N) ──────────
      if (masterRowsToMark.length > 0) {
        markForwardedBatch(MASTER_SHEET_ID, TAB_NAME, masterRowsToMark)
          .then(() => console.log(`[adHandler] ✅ markForwarded batched: ${masterRowsToMark.length} row(s)`))
          .catch((err) => console.error(`[adHandler] ❌ markForwardedBatch error: ${err.message}`));
      }
      if (remindersToQueue.length > 0) {
        appendRemindersBatch(MASTER_SHEET_ID, remindersToQueue)
          .then(() => console.log(`[adHandler] ✅ appendReminders batched: ${remindersToQueue.length} reminder(s)`))
          .catch((err) => console.error(`[adHandler] ❌ appendRemindersBatch error: ${err.message}`));
      }

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
