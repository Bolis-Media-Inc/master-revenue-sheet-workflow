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
const { appendRow, markForwardedBatch, updateStatusToLive, updateAdDate, appendRemindersBatch, applyCenterAlignmentBatch, applyColumnCenterAlignment, maybeInsertDayDivider, sortSheetByDate, findRowsInColumn, findDuplicateRows, getHeaderRow, findOutlierDates, repinDateByClient, fixDropdownColumn, getColumnDropdownOptions, snapToDropdown } = require("../sheets");
const { clearBufferUpTo, getCollabBundlesByPage, getContentBundlesByPage, getFilenameBundlesByPage, getMessages, getPrecedingMessages, getStandardBundle, getBlockStructure, getBriefBlockForAI } = require("../messageBuffer");
const { parseNifMs, scheduleNifReminder } = require("../scheduler");
const { parsePostDuration }    = require("../reminders");
const pagesRegistry            = require("../lib/pages");
const adBriefs                 = require("../lib/adBriefs");
const briefAI                  = require("../lib/briefAI");

// Supports comma-separated chat IDs so a test group can run alongside production.
// e.g. TARGET_CHAT_ID=-1001111111111,-1002222222222
const TARGET_CHAT_IDS = new Set(
  (process.env.TARGET_CHAT_ID || "").split(",").map((id) => id.trim()).filter(Boolean)
);
const MASTER_SHEET_ID = process.env.MASTER_SHEET_ID;
const TAB_NAME        = process.env.SHEET_TAB_NAME      || "2026 Ad Overview";
const PAGE_TAB_NAME   = process.env.PAGE_SHEET_TAB_NAME || "IG Revenue Tracker";

// Where paused-ad / "needs /resolve" alerts go. The Monetization Team + AI
// chat (SALES_TEAM_CHAT_ID) by default; RESOLVE_ALERT_CHAT_ID overrides.
// Exported so the reminder cron (index.js) targets the same chat.
const RESOLVE_ALERT_CHAT_ID =
  (process.env.RESOLVE_ALERT_CHAT_ID || process.env.SALES_TEAM_CHAT_ID || "").trim() || null;

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
    return _formatYMD(year, month, day);
  }

  // ISO yyyy-mm-dd
  const isoM = lower.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (isoM) {
    return _formatYMD(parseInt(isoM[1], 10), parseInt(isoM[2], 10) - 1, parseInt(isoM[3], 10));
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
    return _formatYMD(year, month, day);
  }

  return null;
}

/**
 * Format a Year/Month/Day triple as "Tue 5/27/26" matching the sheet
 * convention. Pinned to noon UTC during Date construction so that
 * formatting with America/Phoenix (UTC-7) doesn't slip back a day —
 * a Railway-UTC process constructing `new Date(2026, 4, 27)` got
 * midnight UTC which is 5pm previous-day in AZ, producing "Tue 5/26/26"
 * for a user-typed "5/27" (off-by-one bug Connor saw on Lola Young).
 */
function _formatYMD(year, monthIdx, day) {
  // Date.UTC pins a timezone-independent instant; noon ensures no edge
  // condition rolls the date when re-projected to any timezone west of
  // UTC+12 or east of UTC-12 (i.e. any real-world location).
  const d = new Date(Date.UTC(year, monthIdx, day, 12, 0, 0));
  if (isNaN(d.getTime())) return null;
  return formatSheetDate(d);
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
 * Canonicalize a bundle's byHandle keys against the pages registry.
 * Bundle scanners (messageBuffer.js) read raw handles from Telegram text
 * / filenames. When a host line says "@dankquilius" (one-L typo) but the
 * registry has "@dankquillius", we need byHandle's key to match what the
 * canonicalized parsedList uses — otherwise the forwarder iterates over
 * parsedList handles, looks them up in byHandle, misses, and falls back
 * to "no per-page creative" warnings.
 *
 * Merges entries when canonicalization collapses two raw handles into
 * one canonical handle (e.g. both "dankquilius" and "dankquillius"
 * appear in a brief somehow → merge their media + take first non-null
 * caption).
 *
 * Returns a new bundle; safe to call with null.
 */
function canonicalizeBundleHandles(bundle) {
  if (!bundle?.byHandle || bundle.byHandle.size === 0) return bundle;
  const canon = new Map();
  for (const [handle, b] of bundle.byHandle) {
    const canonical = pagesRegistry.resolveHandle(handle) || handle;
    if (canon.has(canonical)) {
      const existing = canon.get(canonical);
      existing.media = [...existing.media, ...(b.media || [])];
      if (!existing.caption && b.caption) existing.caption = b.caption;
    } else {
      canon.set(canonical, { media: [...(b.media || [])], caption: b.caption });
    }
  }
  return { ...bundle, byHandle: canon };
}

/**
 * Drop byHandle entries whose handle isn't in the current brief's page list.
 *
 * Why this exists (Stake-after-Knicks bug, 2026-06-06): if an operator posts
 * assets (`@<handle>.jpg` covers, slides, captions) WITHOUT a matching brief
 * and then a *different* brief lands for *different* pages, the filename
 * scanner walks backwards across the orphans (no previous-brief boundary
 * stopped it) and pulls them into the new brief's `byHandle`. Phase 1
 * ambiguity detection then trips (`attributedCount < briefHandleCount` with
 * shared media present) and the brief gets paused — even though every page
 * in this brief actually has no per-page cover, just orphan content from
 * a missing brief upstream.
 *
 * Fix: after canonicalization, drop any byHandle entry whose key isn't one
 * of THIS brief's listed handles. Returns null if 0 valid entries remain so
 * the caller treats the scanner as "found nothing" and falls through to the
 * next scanner (label → standard).
 *
 * Does NOT touch `shared.media` — that pollution is a separate concern
 * (operator-hygiene: don't post brief assets without the brief). Standard
 * fallback will still pick up shared media as needed.
 *
 * Safe to call with null bundle or empty briefHandleSet (returns bundle
 * unchanged in both cases — only filters when there's something to filter
 * against).
 */
function filterBundleToBriefPages(bundle, briefHandleSet) {
  if (!bundle?.byHandle || bundle.byHandle.size === 0) return bundle;
  if (!briefHandleSet || briefHandleSet.size === 0) return bundle;
  const filtered = new Map();
  const dropped  = [];
  for (const [handle, b] of bundle.byHandle) {
    if (briefHandleSet.has(handle.toLowerCase())) {
      filtered.set(handle, b);
    } else {
      dropped.push(handle);
    }
  }
  if (dropped.length > 0) {
    console.log(
      `[adHandler] 🗑️  Dropped ${dropped.length} orphan handle(s) from bundle ` +
      `(in scanner output but not in brief's page list): ${dropped.map((h) => "@" + h).join(", ")}`
    );
  }
  if (filtered.size === 0) return null;
  return { ...bundle, byHandle: filtered };
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
 * Like extractMediaRef but ALWAYS carries the source message_id (and filename
 * when present), even for media with no bot file_id — e.g. messages re-injected
 * from chat history by /catchup, where only the message_id is bot-usable.
 * Downstream (postAssignmentUI / runGroupCoverForward) sends by file_id when
 * present, else copyMessage/forwardMessage by msg_id, so a ref with msg_id and
 * no file_id still forwards. Returns null only for non-media messages.
 */
// A caption that's nothing but @handle(s) is a page-attribution line that
// leaked into the caption slot (e.g. "@moist"), not real IG copy — never send
// it as a caption.
function isBareHandleCaption(t) {
  return !!t && /^(@[\w.]+[\s,]*)+$/.test(String(t).trim());
}

function mediaRefWithId(msg) {
  if (!msg) return null;
  const ref = extractMediaRef(msg);
  const file_name = msg.document?.file_name || msg.video?.file_name || msg.audio?.file_name || null;
  if (ref) return { ...ref, msg_id: msg.message_id, file_name };
  if (msg.message_id == null) return null;
  // No bot file_id (history re-inject) — infer kind from the media marker.
  const kind = msg.video ? "video" : msg.animation ? "animation" : msg.audio ? "audio"
             : msg.document ? "document" : msg.photo ? "photo" : null;
  if (!kind) return null;
  return { file_id: null, kind, msg_id: msg.message_id, file_name };
}

/**
 * Delete the bot's PRIOR forwarded messages for a campaign in one page's
 * chat, so a /replay can do a clean delete + resend instead of stacking a
 * second copy on top of the first (the Stake Day 19 cleanup ask).
 *
 * "Campaign" = all ad_briefs rows with the same client name in the same
 * source chat. This matters for the delete+resend workflow: the correct
 * media lives on brief copy A, but the junk was forwarded by copy B — both
 * are rows for the same campaign, so we sweep all of them.
 *
 * Deletes every id in each page row's forwarded_message_ids. For LEGACY
 * rows that stored only the brief id (length === 1, caption not captured),
 * also deletes id-1 — the bot always sends the caption immediately before
 * the brief, so id-1 is that caption.
 *
 * Best-effort: deleteMessage failures (>48h window, already gone, not ours)
 * are swallowed. Returns the count actually deleted.
 */
async function deletePriorCampaignForwards(telegram, sourceChatId, clientName, handle, destChatId) {
  const sb = adBriefs._supabase;
  if (!sb || !clientName) return 0;
  try {
    const { data: briefs } = await sb
      .from("ad_briefs")
      .select("id")
      .eq("telegram_chat_id", Number(sourceChatId))
      .ilike("client", clientName);
    if (!briefs || briefs.length === 0) return 0;

    const { data: pages } = await sb
      .from("ad_brief_pages")
      .select("forwarded_message_ids")
      .in("brief_id", briefs.map((b) => b.id))
      .eq("page_handle", handle.toLowerCase());
    if (!pages || pages.length === 0) return 0;

    const toDelete = new Set();
    for (const p of pages) {
      const ids = (p.forwarded_message_ids || []).map(Number).filter(Number.isFinite);
      for (const id of ids) toDelete.add(id);
      if (ids.length === 1) toDelete.add(ids[0] - 1); // legacy: caption sits at briefId-1
    }

    let deleted = 0;
    for (const id of toDelete) {
      try { await telegram.deleteMessage(destChatId, id); deleted++; }
      catch (_) { /* >48h / already gone / not ours — ignore */ }
    }
    if (deleted > 0) {
      console.log(`[adHandler] 🧹 /replay cleaned ${deleted} prior msg(s) in ${destChatId} for @${handle}`);
    }
    return deleted;
  } catch (err) {
    console.error(`[adHandler] deletePriorCampaignForwards (non-fatal): ${err.message}`);
    return 0;
  }
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
 * Like buildPageRow, but first snaps the dropdown fields (B Ad Type,
 * E Post Type, F Post Duration) to the DESTINATION sheet's ACTUAL dropdown
 * options. Each page has its own dropdowns, so this matches whatever that page
 * expects (e.g. the bot's "30 Days" → that sheet's "30 days") — no red
 * "invalid" flags on new rows. Fail-open: if the validation can't be read, the
 * original values are written (never blocks a forward). Reads are cached per
 * (sheet, column), so this is a one-time cost per sheet.
 */
async function buildPageRowSnapped(sheetId, parsed) {
  try {
    const [adType, postType, postDur] = await Promise.all([
      getColumnDropdownOptions(sheetId, PAGE_TAB_NAME, "B"),
      getColumnDropdownOptions(sheetId, PAGE_TAB_NAME, "E"),
      getColumnDropdownOptions(sheetId, PAGE_TAB_NAME, "F"),
    ]);
    const snapped = {
      ...parsed,
      category:     adType   ? snapToDropdown(parsed.category, adType)      : parsed.category,
      postType:     postType ? snapToDropdown(parsed.postType, postType)    : parsed.postType,
      postDuration: postDur  ? snapToDropdown(parsed.postDuration, postDur) : parsed.postDuration,
    };
    return buildPageRow(snapped);
  } catch (err) {
    console.error(`[adHandler] buildPageRowSnapped (writing raw): ${err.message}`);
    return buildPageRow(parsed);
  }
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

  let   headerPart = originalText.slice(0, pageInfoIdx);
  const infoPart   = originalText.slice(pageInfoIdx);

  // Strip OTHER pages' per-page tracking links from the header/INSTRUCTIONS
  // block. Affiliate briefs (FashionNova) list a unique UTM link per page up
  // here, e.g. "@thefuck.tv - https://…utm_campaign=thefuck.tv" — one line
  // per page. Without stripping, every page's brief copy carried all 4 pages'
  // links. Keep ONLY this page's link line; leave all non-link lines (brand
  // mentions like "Tag @FashionNova", bullets, etc.) untouched.
  headerPart = headerPart
    .split("\n")
    .filter((ln) => {
      const m = ln.match(/^\s*@([\w.]+)\s*-\s*https?:\/\//i);
      if (!m) return true;                                       // not a per-page link
      return m[1].toLowerCase() === pageHandle.toLowerCase();    // keep only this page's
    })
    .join("\n");

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
      const sent = await telegram.sendMessage(destChatId, perPageText);
      console.log(`[adHandler] ✅ Per-page brief @${pageHandle} → ${destChatId} ($${parsedItem?.adPrice ?? "?"})`);
      return sent?.message_id ?? null;
    } catch (err) {
      console.error(`[adHandler] ❌ Per-page brief @${pageHandle} → ${destChatId}: ${err.message} — falling back to original forward`);
    }
  } else {
    console.warn(`[adHandler] ⚠️ Couldn't build per-page brief for @${pageHandle} — using original forward`);
  }

  // Fallback: forward the original brief verbatim
  try {
    const sent = await telegram.forwardMessage(destChatId, sourceChatId, adMessageId);
    console.log(`[adHandler] ✅ Forward brief @${pageHandle} → ${destChatId} (full brief, rewrite skipped)`);
    return sent?.message_id ?? null;
  } catch (err) {
    console.error(`[adHandler] ❌ Forward brief @${pageHandle} → ${destChatId}: ${err.message}`);
  }
  return null;
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
  // Sender of the original brief — needed for self-heal insertBrief() when
  // the brief was silently dropped by an old parser bug and we need to
  // create the ad_briefs row from scratch during /replay.
  let briefSenderUserId = null;
  let briefSenderHandle = null;
  const replyTo = ctx.message?.reply_to_message;

  if (replyTo) {
    // Reply mode — first try the replied message itself
    briefText         = replyTo.text || replyTo.caption || "";
    briefMessageId    = replyTo.message_id;
    sourceChatId      = String(ctx.chat.id);
    briefDate         = new Date((replyTo.date || Math.floor(Date.now() / 1000)) * 1000);
    briefSenderUserId = replyTo.from?.id ?? null;
    briefSenderHandle = replyTo.from?.username ?? null;
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
  } else if (/^\/replay\s+(?:\d{4,}|(?:https?:\/\/)?t\.me\/\S+)\s*$/i.test(cmdText)) {
    // Message-id mode — "/replay 67165" OR "/replay <pasted message link>".
    // The team has no easy way to read a raw message id, so accept the link
    // Telegram gives them directly (tap message → Copy Link →
    // https://t.me/c/1868750472/67165) and pull the id out ourselves — it's the
    // LAST number in the link (c/<chatId>/<msgId>, or .../<topic>/<msgId>).
    // Resolves the brief from the DB by Telegram message id, so /replay can run
    // from ANY chat (e.g. Monetization) without replying to the source message.
    const arg = cmdText.replace(/^\/replay\s*/i, "").trim();
    const link = arg.match(/t\.me\/\S+/i);
    let mid;
    if (link) {
      const nums = link[0].match(/\d+/g) || [];
      mid = nums.length ? Number(nums[nums.length - 1]) : NaN;
    } else {
      mid = Number(arg);
    }
    if (!Number.isFinite(mid) || mid <= 0) {
      await ctx.reply("❌ Couldn't read a message id. Paste the message link (tap the message → Copy Link) or the number, e.g. /replay 67165").catch(() => {});
      return;
    }
    let b = null;
    if (adBriefs._supabase) {
      const { data } = await adBriefs._supabase
        .from("ad_briefs")
        .select("id, client, raw_text, received_at, telegram_chat_id, telegram_message_id, shared_media, shared_caption")
        .eq("telegram_message_id", mid)
        .order("received_at", { ascending: false })
        .limit(1);
      b = data?.[0] || null;
    }
    if (!b) {
      await ctx.reply(`❌ No brief in the books with message id ${mid}.`).catch(() => {});
      return;
    }
    briefText      = b.raw_text;
    briefMessageId = mid;
    sourceChatId   = String(b.telegram_chat_id);
    briefDate      = new Date(b.received_at);
    console.log(`[adHandler] 🔁 /replay msg-id mode — brief ${b.id.slice(0, 8)}… (msg ${mid}, chat ${sourceChatId})`);
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
    // No @-handle filter = forward to ALL pages in the matched brief.
    // This is the common case ("re-process this whole brief, I'm not
    // cherry-picking pages"). Previously the command required at least
    // one @-handle, which is overkill for the common case and surprising
    // when the campaign name happens to contain an @-mention (e.g.
    // "/replay Justin @FruitSnacks California Candidates" — the
    // @FruitSnacks would be parsed as a target page filter and bail).
    // Empty requestedHandles flows through to the forward loop below,
    // where uniqueHandles defaults to all pages in the brief.

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
      briefText         = match.msg.text || match.msg.caption || "";
      briefMessageId    = match.msg.message_id;
      sourceChatId      = match.chatId;
      briefDate         = new Date((match.msg.date || 0) * 1000);
      briefSenderUserId = match.msg.from?.id ?? null;
      briefSenderHandle = match.msg.from?.username ?? null;
      console.log(`[adHandler] 🔁 /replay search (buffer) found "${match.parsedClient}" in chat ${sourceChatId} (msg ${briefMessageId})`);
    } else {
      // DB path — brief already exists in ad_briefs, no self-heal needed
      briefText         = dbBrief.raw_text;
      briefMessageId    = dbBrief.telegram_message_id;
      sourceChatId      = String(dbBrief.telegram_chat_id);
      briefDate         = new Date(dbBrief.received_at);
      briefSenderUserId = dbBrief.sender_user_id ?? null;
      briefSenderHandle = dbBrief.sender_handle ?? null;
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

  // Canonicalize brief-listed handles via the registry — same fuzzy-resolution
  // applied during initial brief processing. This way the brief's "dankquilius"
  // (one-L typo) gets matched to the registered "dankquillius", and the user
  // can pass either spelling in their /replay command.
  for (const item of parsedList) {
    if (!item.pageHandle) continue;
    const canonical = pagesRegistry.resolveHandle(item.pageHandle);
    if (canonical && canonical !== item.pageHandle.toLowerCase()) {
      item.pageHandle = canonical;
    }
  }
  // Also canonicalize user-requested handles so /replay accepts either
  // spelling when the registry has a canonical form for it.
  const canonicalRequested = requestedHandles.map((h) => pagesRegistry.resolveHandle(h) || h);

  // Figure out which handles to target
  const briefHandles = new Set(parsedList.map((p) => p.pageHandle?.toLowerCase()).filter(Boolean));
  let targetHandles;
  if (canonicalRequested.length === 0) {
    targetHandles = [...briefHandles];
  } else {
    const valid   = canonicalRequested.filter((h) => briefHandles.has(h));
    const invalid = canonicalRequested.filter((h) => !briefHandles.has(h));
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
  let dbBriefForBackfill = await adBriefs.findBriefByTelegramMessage(
    Number(sourceChatId),
    briefMessageId,
  );
  const dbPagesByHandle = new Map();

  // ── Self-heal: brief in buffer but never written to DB ─────────────────
  // Triggered when a brief came through bm_tracking_bot but was silently
  // dropped — most commonly because the parser failed (old CPM header bug,
  // future similar edge cases). The brief is in message_buffer (so we
  // found it via /replay's buffer search) but never made it into
  // ad_briefs. Without this block, /resolve has no DB row to target and
  // the brief's audit trail is lost forever.
  //
  // What we do here: insert the brief row + page rows from the parsed
  // data we already have in hand. We deliberately DON'T write to Master
  // sheet or per-page sheets — those are handled by the existing
  // /syncsheets command after self-heal, which keeps this block focused
  // and avoids duplicating the sheet-writing pipeline.
  if (!dbBriefForBackfill && parsedList.length > 0 && adBriefs._supabase) {
    try {
      const first = parsedList[0];
      const totalPrice = parsedList.reduce(
        (s, p) => s + (Number.isFinite(p.adPrice) ? p.adPrice : 0),
        0,
      );
      const newBriefId = await adBriefs.insertBrief({
        telegramChatId:    Number(sourceChatId),
        telegramMessageId: briefMessageId,
        senderUserId:      briefSenderUserId,
        senderHandle:      briefSenderHandle,
        rawText:           briefText,
        client:            first.client ?? null,
        category:          first.category ?? null,
        totalPrice,
        postType:          first.postType ?? null,
        postDuration:      first.postDuration ?? null,
        nif:               first.nif ?? null,
        datePosted:        first.datePosted ?? null,
        timeMst:           first.timeMST ?? null,
      });
      if (newBriefId) {
        const pageRows = parsedList
          .filter((p) => p.pageHandle)
          .map((p) => ({
            pageHandle: p.pageHandle.toLowerCase(),
            bulkNum:    p.bulkNum || null,
            pagePrice:  Number.isFinite(p.adPrice) ? p.adPrice : null,
          }));
        await adBriefs.insertBriefPages(newBriefId, pageRows);
        console.log(`[adHandler] 🩹 /replay self-heal: created brief ${newBriefId.slice(0, 8)}… + ${pageRows.length} page rows (was missing from DB)`);
        await ctx.reply(
          `🩹 *Self-healed:* this brief had no DB record (likely silently dropped by an older parser bug). ` +
          `Created \`#${newBriefId.slice(0, 8)}\` with ${pageRows.length} page row(s). ` +
          `Now you can run \`/resolve ${newBriefId.slice(0, 8)}\` to assign covers, ` +
          `or \`/syncsheets\` to backfill the sheet rows.`,
          { parse_mode: "Markdown" }
        ).catch(() => {});
        // Re-fetch so the downstream backfill logic sees the new row
        dbBriefForBackfill = await adBriefs.findBriefByTelegramMessage(
          Number(sourceChatId),
          briefMessageId,
        );
      }
    } catch (err) {
      console.error(`[adHandler] /replay self-heal failed: ${err.message}`);
    }
  }

  // ── Prefer the richest campaign copy for MEDIA ─────────────────────────
  // Delete+resend can leave the real creative on an EARLIER brief copy while
  // a later, media-less copy is the one still in the chat (Stake Day 19:
  // copy A had 9 covers + 7 slides, copy C had none). If the resolved copy
  // has no media in DB but a sibling copy of the same campaign (same client
  // + chat) does, switch the media/page source to that sibling so /replay
  // re-sends real content instead of an empty brief. Purely additive — only
  // fires when the resolved copy is empty, so it can't degrade a good replay.
  if (dbBriefForBackfill && adBriefs._supabase && dbBriefForBackfill.client) {
    try {
      let ownMedia = (dbBriefForBackfill.shared_media || []).length;
      const ownPages = await adBriefs.getBriefPages(dbBriefForBackfill.id);
      ownMedia += ownPages.reduce((s, p) => s + (p.page_media?.length || 0), 0);
      if (ownMedia === 0) {
        const { data: siblings } = await adBriefs._supabase
          .from("ad_briefs").select("*")
          .eq("telegram_chat_id", Number(sourceChatId))
          .ilike("client", dbBriefForBackfill.client)
          .neq("id", dbBriefForBackfill.id);
        let best = null, bestScore = 0;
        for (const s of (siblings || [])) {
          let score = (s.shared_media || []).length;
          try {
            const sp = await adBriefs.getBriefPages(s.id);
            score += sp.reduce((a, p) => a + (p.page_media?.length || 0), 0);
          } catch (_) {}
          if (score > bestScore) { bestScore = score; best = s; }
        }
        if (best && bestScore > 0) {
          console.log(`[adHandler] 🔁 /replay: resolved copy had no media — switching to richer sibling copy (msg ${best.telegram_message_id}, ${bestScore} media items)`);
          dbBriefForBackfill = best;
        }
      }
    } catch (err) {
      console.error(`[adHandler] /replay richest-copy fallback (non-fatal): ${err.message}`);
    }
  }

  if (dbBriefForBackfill) {
    const dbPages = await adBriefs.getBriefPages(dbBriefForBackfill.id);
    for (const p of dbPages) dbPagesByHandle.set(p.page_handle, p);
    console.log(`[adHandler] 🔁 /replay: backfill enabled — ${dbPages.length} DB page rows linked to brief`);
  }

  // ── Cover-pick re-forward shortcut ───────────────────────────────────────
  // If this brief already has a fully-assigned cover→page session, the correct
  // re-forward is that saved mapping — it forwards covers by message_id and
  // writes NO sheets, so the already-correct sheet rows stay put. Crucial for
  // briefs recovered via /catchup whose media isn't in the buffer (a buffer
  // re-scan would find nothing). Returns false if there's no assigned session,
  // so normal briefs fall through to the standard re-scan forward below.
  if (dbBriefForBackfill?.id) {
    const { replayCoverForward } = require("./resolveHandler");
    if (await replayCoverForward(ctx, dbBriefForBackfill.id)) return;
  }

  // ALWAYS live-re-read the brief's own block from chat history (clears the
  // chat buffer first, then injects only this brief's block). Critical: the
  // shared buffer accumulates pollution from prior /catchup + /replay
  // re-injections, so even when the brief IS in the buffer, scanning it sweeps
  // in OTHER briefs' creatives (the "mixed covers in the picker" bug). Doing
  // the clean re-read unconditionally guarantees the bundle scan sees exactly
  // this brief. /replay stays forward-only (DB row exists → no sheet writes).
  // Best-effort: if the user session is down, fall through to the raw buffer.
  try {
    const { reinjectBriefWindow } = require("./catchupHandler");
    const got = await reinjectBriefWindow(sourceChatId, briefMessageId);
    console.log(`[adHandler] /replay clean re-read brief ${briefMessageId} (${got ? "ok" : "not found in history"})`);
  } catch (e) {
    console.warn(`[adHandler] /replay live re-read skipped: ${e.message}`);
  }

  // Re-build bundles from the messageBuffer (same logic as initial processing).
  // Same getStandardBundle fallback as the main handler so /replay handles
  // 6+ slide carousels without dropping early slides.
  // Scanner output is canonicalized against the registry so the
  // forwarder's parsedList-vs-byHandle lookup never misses on typo'd
  // raw handles in Host lines / filenames / labels.
  // Run all three scanners, filter each to THIS brief's pages, and pick the one
  // covering the MOST pages (drops orphan @-named covers / labels and prevents a
  // stray collab "Host:" line from an adjacent brief hijacking the brief — see
  // the live-handler block for the full rationale).
  const collabBundles    = filterBundleToBriefPages(canonicalizeBundleHandles(getCollabBundlesByPage(sourceChatId, briefMessageId)), briefHandles);
  const filenameBundles  = filterBundleToBriefPages(canonicalizeBundleHandles(getFilenameBundlesByPage(sourceChatId, briefMessageId)), briefHandles);
  const labelBundles     = filterBundleToBriefPages(canonicalizeBundleHandles(getContentBundlesByPage(sourceChatId, briefMessageId)), briefHandles);
  const collabCov   = collabBundles?.byHandle.size   || 0;
  const filenameCov = filenameBundles?.byHandle.size || 0;
  const labelCov    = labelBundles?.byHandle.size    || 0;
  const useCollab        = collabCov   > 0 && collabCov   >= filenameCov && collabCov >= labelCov;
  const useFilenames     = !useCollab && filenameCov > 0 && filenameCov >= labelCov;
  const useLabels        = !useCollab && !useFilenames && labelCov > 0;
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

  // Refresh shared_caption + shared_media in ad_briefs from the current
  // buffer scan. Without this, Phase 3 (resolveHandler) reads stale
  // values OR null — and crucially, if Danielson edited the caption
  // after the original brief landed, this re-scan picks up the new text
  // (the buffer now tracks edits via bot.on("edited_message"), so the
  // scan output above reflects whatever's current in Telegram).
  if (dbBriefForBackfill?.id && adBriefs._supabase) {
    const sharedMediaRefs = sharedBundle.media.map(extractMediaRef).filter(Boolean);
    const newCaption      = sharedBundle.caption || null;
    if (newCaption || sharedMediaRefs.length > 0) {
      adBriefs._supabase
        .from("ad_briefs")
        .update({
          shared_caption: newCaption,
          shared_media:   sharedMediaRefs.length > 0 ? sharedMediaRefs : null,
          bundle_format:  format,
        })
        .eq("id", dbBriefForBackfill.id)
        .then(({ error }) => {
          if (error) console.error(`[adHandler] /replay refresh bundle: ${error.message}`);
          else console.log(`[adHandler] 🔁 /replay refreshed ad_briefs shared_caption + ${sharedMediaRefs.length} shared_media`);
        });
    }
  }

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

  // ── Ambiguity gate (mirror of adHandler's pause logic) ──────────────────
  // If this brief is ambiguous (multi-page with unlabeled covers) and we
  // have a DB row, refuse to re-forward — would just blast wrong covers
  // again. Operator runs /resolve to assign first; Phase 3 (resolveHandler)
  // re-forwards with the correct mapping when assignments complete.
  if (dbBriefForBackfill?.id && adBriefs._supabase) {
    const briefHandleCountRpl = ready.length;
    const useFilenamesRpl  = format === "filename";
    const isStandardRpl    = format === "standard";
    const useLabelsRpl     = format === "label";
    const attribCountRpl   = activeBundle?.byHandle.size || 0;
    const sharedCountRpl   = sharedBundle.media.length;
    const ambiguousPartialRpl   = useFilenamesRpl && briefHandleCountRpl > 1 && attribCountRpl < briefHandleCountRpl && sharedCountRpl > 0;
    const ambiguousNoLabelsRpl  = isStandardRpl && briefHandleCountRpl >= 2 && sharedCountRpl >= briefHandleCountRpl;
    const ambiguousLabelMissRpl = useLabelsRpl && briefHandleCountRpl > 1 && attribCountRpl < briefHandleCountRpl && sharedCountRpl > 0;
    if (ambiguousPartialRpl || ambiguousNoLabelsRpl || ambiguousLabelMissRpl) {
      // Look for an existing session for this brief
      const { data: existingSessions } = await adBriefs._supabase
        .from("pending_brief_assignments")
        .select("id, status, assignments, unattributed")
        .eq("brief_id", dbBriefForBackfill.id)
        .order("created_at", { ascending: false })
        .limit(1);
      let existing = existingSessions?.[0];
      const allAssigned = existing && (
        existing.status === "resolved"
        || (Array.isArray(existing.unattributed) && existing.unattributed.length > 0
            && Object.keys(existing.assignments || {}).length >= existing.unattributed.length)
      );
      // An UNSTARTED session (0 covers assigned) from a prior /replay is stale —
      // refresh it (delete + recreate a fresh picker below) instead of forcing
      // "/resolve to continue", so re-running /replay always yields a clean
      // picker built from the current (now de-polluted) buffer.
      if (existing && !allAssigned && Object.keys(existing.assignments || {}).length === 0) {
        await adBriefs._supabase.from("pending_brief_assignments").delete().eq("id", existing.id);
        console.log(`[adHandler] /replay refreshed stale 0-assigned session ${existing.id.slice(0, 8)}`);
        existing = null;
      }
      if (existing && !allAssigned) {
        await ctx.reply(
          `⏸️ This brief has an open assignment session — \`/resolve ${existing.id.slice(0, 8)}\` to continue.\n` +
          `Assigned so far: ${Object.keys(existing.assignments || {}).length}/${(existing.unattributed || []).length}.`,
          { parse_mode: "Markdown" }
        ).catch(() => {});
        return;
      }
      if (!existing) {
        // Create a new session — same shape as adHandler's pause block
        const unattributedRefs = sharedBundle.media.map((m, i) => {
          const ref = extractMediaRef(m);
          return ref ? { ...ref, idx: i, msg_id: m.message_id || `synth-${i}`, file_name: m.document?.file_name || m.video?.file_name || null } : null;
        }).filter(Boolean);
        const briefPagesArr = [...new Set(parsedList.map((p) => p.pageHandle?.toLowerCase()).filter(Boolean))];
        try {
          const { data: pba } = await adBriefs._supabase
            .from("pending_brief_assignments")
            .insert({
              brief_id:         dbBriefForBackfill.id,
              source_chat_id:   Number(sourceChatId),
              brief_message_id: briefMessageId,
              brief_text:       (briefText || "").slice(0, 1000),
              pages:            briefPagesArr,
              unattributed:     unattributedRefs,
              assignments:      {},
              status:           "awaiting",
              expires_at:       new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            })
            .select()
            .single();
          if (pba) {
            // Send heads-up + auto-post the assignment UI right in /replay's
            // reply context. Operator never has to type /resolve manually.
            await ctx.reply(
              `⏸️ *Brief paused — assigning covers below*\n` +
              `─────────────────────────\n` +
              `*Pages:* ${briefHandleCountRpl} · *Unlabeled covers:* ${unattributedRefs.length}\n` +
              `*Type:* ${ambiguousNoLabelsRpl ? "no labels at all" : ambiguousLabelMissRpl ? "label-format misattribution" : "partial labels"}\n\n` +
              `Refusing to re-forward — would re-send wrong covers to every page.\n` +
              `Tap a page button under each cover below to assign. Phase 3 auto-forwards when all are done.`,
              { parse_mode: "Markdown" }
            ).catch(() => {});
            try {
              const { postAssignmentUI } = require("./resolveHandler");
              await postAssignmentUI(ctx.telegram, ctx.chat.id, pba.id);
            } catch (err) {
              console.error(`[adHandler] /replay auto-trigger UI failed: ${err.message}`);
              await ctx.reply(
                `⚠️ Couldn't auto-post UI (${err.message}). Run \`/resolve ${pba.id.slice(0, 8)}\` manually.`,
                { parse_mode: "Markdown" }
              ).catch(() => {});
            }
            return;
          }
        } catch (err) {
          console.error(`[adHandler] /replay pause-session create failed: ${err.message}`);
          // Fall through — better to forward than to silently fail
        }
      }
      // If allAssigned but we got here, fall through to forward (Phase 3
      // hook from resolveHandler will normally pre-empt, but allow manual
      // /replay to flush anyway).
    }
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

    // Clean delete + resend: remove the bot's prior forwards for this
    // campaign in this page's chat BEFORE re-sending, so the page ends up
    // with exactly one correct copy (not the junk + the fix stacked).
    const replayClient = (parsedList?.[0]?.client) || dbBriefForBackfill?.client || null;
    await deletePriorCampaignForwards(ctx.telegram, sourceChatId, replayClient, handle, destChatId);

    // Collect ids we send this pass so we can persist the fresh set (and so
    // a future /replay or /update targets the right messages).
    const replayIds = [];

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
          const sent = await ctx.telegram.forwardMessage(destChatId, sourceChatId, m.message_id);
          if (sent?.message_id) replayIds.push(sent.message_id);
        } catch (err) {
          console.error(`[adHandler] ❌ /replay per-page msg ${m.message_id} → @${handle}: ${err.message}`);
        }
      }
      for (const ref of dbPerPageMedia) {
        try { const sent = await sendByKind(ctx.telegram, destChatId, ref); if (sent?.message_id) replayIds.push(sent.message_id); }
        catch (err) { console.error(`[adHandler] ❌ /replay per-page (DB) ${ref.kind} → @${handle}: ${err.message}`); }
      }
      const perPageTotal = perPageBundle.media.length + dbPerPageMedia.length;
      if (perPageTotal > 0) {
        console.log(`[adHandler] ✅ /replay forwarded ${perPageTotal} per-page msg(s) → @${handle} (buffer: ${perPageBundle.media.length}, DB: ${dbPerPageMedia.length})`);
      }

      // 2. Shared media — same two paths
      for (const m of sharedBundle.media) {
        try {
          const sent = await ctx.telegram.forwardMessage(destChatId, sourceChatId, m.message_id);
          if (sent?.message_id) replayIds.push(sent.message_id);
        } catch (err) {
          console.error(`[adHandler] ❌ /replay shared msg ${m.message_id} → @${handle}: ${err.message}`);
        }
      }
      for (const ref of dbSharedMedia) {
        try { const sent = await sendByKind(ctx.telegram, destChatId, ref); if (sent?.message_id) replayIds.push(sent.message_id); }
        catch (err) { console.error(`[adHandler] ❌ /replay shared (DB) ${ref.kind} → @${handle}: ${err.message}`); }
      }
      const sharedTotal = sharedBundle.media.length + dbSharedMedia.length;
      if (sharedTotal > 0) {
        console.log(`[adHandler] ✅ /replay forwarded ${sharedTotal} shared msg(s) → @${handle} (buffer: ${sharedBundle.media.length}, DB: ${dbSharedMedia.length})`);
      }

      // 3. Caption (per-page wins over shared) — buffer first, then DB.
      // Pick the first REAL caption, skipping bare-@handle junk so a cover whose
      // caption is just "@page" can't suppress the real shared caption.
      const captionToSend = [perPageBundle.caption, sharedBundle.caption, dbPerPageCaption, dbSharedCaption]
        .find((c) => c && !isBareHandleCaption(c)) || null;
      if (captionToSend) {
        const sent = await ctx.telegram.sendMessage(destChatId, captionToSend);
        if (sent?.message_id) replayIds.push(sent.message_id);
        console.log(`[adHandler] 💬 /replay caption sent → @${handle}`);
      }

      // 4. Per-page brief (rewritten to just this page's row)
      const parsedItem = parsedList.find((p) => p.pageHandle?.toLowerCase() === handle);
      const replayBriefMsgId = await forwardToPage(
        ctx.telegram, sourceChatId, briefMessageId, briefText, destChatId, handle, parsedItem,
      );
      if (replayBriefMsgId) replayIds.push(replayBriefMsgId); // brief last → updateHandler reads [length-1]

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
                sheetId, PAGE_TAB_NAME, await buildPageRowSnapped(sheetId, parsedItem),
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
        // and re-replays of previously-failed forwards). Persist the FRESH
        // message-id set from this replay so the next /replay cleans these
        // (not the now-deleted old ones) and /update edits the right brief.
        adBriefs.markPageForwarded(dbPage.id, {
          masterSheetRow: dbPage.master_sheet_row ?? null,
          pageSheetRow:   dbPage.page_sheet_row   ?? null,
          messageIds:     replayIds.length > 0 ? replayIds : null,
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

  // Single Telegram message that we edit as we go — gives Connor live
  // progress instead of staring at a stuck "Scanning..." for 30+ seconds.
  // Telegram editMessageText is cheap (rate-limited at ~30/min per chat,
  // we update ~5 times max).
  const statusMsg = await ctx.reply(
    `⏳ Scanning DB for incomplete sheet writes${clientFilter ? ` matching "${clientFilter}"` : ""}…`
  ).catch(() => null);

  const editStatus = async (text) => {
    if (!statusMsg) return;
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id, statusMsg.message_id, undefined, text,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      // 400 Bad Request: message is not modified → no-op, ignore
      if (!/not modified/i.test(err.message || "")) {
        console.error(`[adHandler] /syncsheets editStatus: ${err.message}`);
      }
    }
  };

  const incomplete = await adBriefs.findIncompletePages({ clientFilter });
  if (incomplete.length === 0) {
    await editStatus("✅ *Nothing to sync* — every captured brief has both sheet rows populated.");
    return;
  }

  console.log(`[adHandler] 🩹 /syncsheets — ${incomplete.length} incomplete page row(s) to backfill`);
  await editStatus(
    `🔍 Found *${incomplete.length}* incomplete row(s)${clientFilter ? ` matching \`${clientFilter}\`` : ""}\n` +
    `🛠️  Processing… (rate-limited to ~50 API calls/min, est. ${Math.ceil(incomplete.length * 4 / 50)} min)`
  );

  let masterWritten = 0, masterAlreadyOk = 0, masterFailed = 0;
  let pageWritten   = 0, pageAlreadyOk   = 0, pageFailed   = 0, pageSkippedNoSheet = 0;
  const errors = [];
  // Collect master rows that need Forwarded ✅ — pages that DB shows as
  // forwarded but whose master row was just written by us (so the
  // original markForwarded batched never saw the row number).
  const masterRowsToTickForwarded = [];

  let processed = 0;
  let lastProgressEdit = Date.now();
  for (const row of incomplete) {
    const brief = row.brief;
    if (!brief) { errors.push(`@${row.page_handle}: missing brief join`); processed++; continue; }

    // Edit the status message every ~5 seconds so Connor sees motion.
    // Telegram allows up to 30 edits/min/message — we're well under that.
    if (Date.now() - lastProgressEdit > 5000) {
      const pct = Math.round((processed / incomplete.length) * 100);
      editStatus(
        `🛠️  *Backfilling sheets* — ${processed}/${incomplete.length} (${pct}%)\n` +
        `Master: ${masterWritten} written · Per-page: ${pageWritten} written` +
        (masterFailed + pageFailed > 0 ? ` · ${masterFailed + pageFailed} failed` : "")
      ).catch(() => {});
      lastProgressEdit = Date.now();
    }

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
    // Safety guard: if the page was already forwarded (forwarded_at set),
    // the bot's brief-processing path already reached + completed the
    // per-page sheet write loop — so a row DOES exist in the per-page
    // sheet, even though the inline DB persist may have failed (the silent-
    // failure bug fixed in 8f497b2). Re-writing here would create a
    // DUPLICATE row. Skip with a note instead.
    if (!row.page_sheet_row && row.forwarded_at) {
      console.log(`[adHandler] ⏭️ /syncsheets: skipping per-page write for @${row.page_handle} — forwarded_at set, row likely exists in sheet but DB lost track`);
      pageAlreadyOk++;
      processed++;
      continue;
    }
    if (!row.page_sheet_row) {
      // Fuzzy-resolve in case the DB row has a typo'd handle (e.g.
      // historical @dankquilius vs registered @dankquillius). Avoids
      // skipping per-page writes for recoverable misspellings.
      const canonicalHandle = pagesRegistry.resolveHandle(row.page_handle) || row.page_handle;
      const sheetId = pagesRegistry.getSheetId(canonicalHandle);
      if (!sheetId || PLACEHOLDER_PATTERN.test(sheetId)) {
        pageSkippedNoSheet++;
        console.warn(`[adHandler] ⚠️ /syncsheets: no sheet_id for @${row.page_handle} — skipping per-page`);
        processed++;
        continue;
      }
      try {
        const rowNum = await appendRow(sheetId, PAGE_TAB_NAME, await buildPageRowSnapped(sheetId, parsedItem), {
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
    processed++;
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
  // Edit the status message we've been updating throughout; fall back to a
  // new reply if the original message couldn't be edited (e.g. it was
  // deleted manually).
  if (statusMsg) {
    await editStatus(lines.join("\n"));
  } else {
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" }).catch(() => {});
  }
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

  // Live-edited status message (same pattern as /syncsheets)
  const statusMsg = await ctx.reply(
    `⏳ Applying column-wide center alignment${masterOnly ? " to master sheet" : " (master + all per-page sheets)"}…`
  ).catch(() => null);
  const editStatus = async (text) => {
    if (!statusMsg) return;
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id, statusMsg.message_id, undefined, text, { parse_mode: "Markdown" }
      );
    } catch (err) {
      if (!/not modified/i.test(err.message || "")) {
        console.error(`[adHandler] /centersheets editStatus: ${err.message}`);
      }
    }
  };

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

    await editStatus(
      `🎨 *CenterSheets in progress*\n` +
      `Master: ✅\n` +
      `Per-page: 0/${targets.length} (est. ~${Math.ceil(targets.length / 50)} min)`
    );

    let lastProgressEdit = Date.now();
    let processed = 0;
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
      processed++;
      // Edit progress every ~5s
      if (Date.now() - lastProgressEdit > 5000) {
        editStatus(
          `🎨 *CenterSheets in progress*\n` +
          `Master: ✅\n` +
          `Per-page: ${processed}/${targets.length}${failed > 0 ? ` · ${failed} failed` : ""}`
        ).catch(() => {});
        lastProgressEdit = Date.now();
      }
      // Throttle is now handled by the API rate limiter (50/min) inside
      // sheets.js — no extra setTimeout needed here.
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
  if (statusMsg) {
    await editStatus(lines.join("\n"));
  } else {
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" }).catch(() => {});
  }
}

/**
 * /briefai [days] — review the Brief-AI shadow log. Read-only: shows how often
 * the LLM's read of each brief agreed with the live heuristics, and lists the
 * recent disagreements (caption dropped / suspect / mismatch / creative-count).
 * This is the "come back in a few days and see what's happening" surface — the
 * data lives in brief_ai_shadow_log, this just summarizes it on demand.
 */
async function handleBriefAICommand(ctx) {
  const adminId = parseInt(process.env.WIZARD_ADMIN_USER_ID || "0", 10);
  if (adminId && ctx.from?.id !== adminId) return;

  const m = (ctx.message?.text || "").match(/\/briefai(?:@\w+)?\s+(\d{1,3})/i);
  const days = m ? Math.min(parseInt(m[1], 10) || 7, 90) : 7;

  if (!briefAI.SHADOW_ENABLED) {
    await ctx.reply("⚠️ Brief-AI shadow is OFF (set BRIEF_AI_SHADOW=true). No data is being collected.").catch(() => {});
    return;
  }

  const s = await briefAI.summarize(days, 20);
  if (!s) { await ctx.reply("⚠️ Could not read the shadow log (DB unavailable).").catch(() => {}); return; }
  if (s.total === 0) {
    await ctx.reply(`📊 *Brief-AI shadow* — last ${days}d\n\nNo briefs compared yet. The log fills as new briefs forward.`, { parse_mode: "Markdown" }).catch(() => {});
    return;
  }

  const rate = s.agreementRate != null ? `${(s.agreementRate * 100).toFixed(0)}%` : "—";
  const lines = [
    `📊 *Brief-AI shadow* — last ${days}d`,
    ``,
    `Compared: *${s.total}*  ·  agreed: *${s.agreed}*  ·  disagreed: *${s.disagreed}*`,
    `Agreement rate: *${rate}*`,
    ``,
    `Disagreements by type:`,
    `🟥 caption dropped: ${s.byKind.dropped}`,
    `🟧 caption suspect: ${s.byKind.suspect}`,
    `🟨 caption mismatch: ${s.byKind.mismatch}`,
    `🟦 creative count: ${s.byKind.count}`,
  ];
  if (s.recent.length) {
    lines.push(``, `*Recent disagreements:*`);
    for (const r of s.recent.slice(0, 12)) {
      const when = (r.created_at || "").slice(5, 16).replace("T", " ");
      const who = r.client || "?";
      const first = (r.diffs && r.diffs[0]) ? r.diffs[0].split("\n")[0] : "";
      lines.push(`• ${when} — ${who}: ${first}`);
    }
  }
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" }).catch(async () => {
    await ctx.reply(lines.join("\n").replace(/[*_`]/g, "")).catch(() => {});
  });
}

/**
 * /sortsheets [@handle …] — re-sort per-page rev sheets chronologically by
 * date. With @handles, sorts only those (good for eyeballing one first).
 * Without, sorts every enabled per-page sheet. Master sheet is excluded.
 *
 * Safe: per-page price/date/status updates locate rows by client name, not
 * stored row number, so re-ordering never misdirects a later /update.
 */
async function handleSortSheetsCommand(ctx) {
  const adminId = parseInt(process.env.WIZARD_ADMIN_USER_ID || "0", 10);
  if (adminId && ctx.from?.id !== adminId) return;

  // Strip the command token + any "@botname" mention BEFORE parsing page
  // handles — otherwise "/sortsheets@bm_tracking_bot" (how you'd address the
  // bot in a multi-bot group like Monetization Team) gets misread as a page
  // filter for "@bm_tracking_bot" and matches nothing.
  const cmdText = (ctx.message?.text || "").trim().replace(/^\/sortsheets(?:@\w+)?\s*/i, "");
  const requested = (cmdText.match(/@([\w.]+)/g) || []).map((h) => h.slice(1).toLowerCase());

  const allPages = pagesRegistry.listAllSync ? pagesRegistry.listAllSync() : [];
  let targets = allPages.filter((p) => p.sheet_id && !PLACEHOLDER_PATTERN.test(p.sheet_id));
  if (requested.length > 0) {
    const want = new Set(requested.map((h) => pagesRegistry.resolveHandle(h) || h));
    targets = targets.filter((p) => want.has((p.handle || "").toLowerCase()));
  }

  if (targets.length === 0) {
    await ctx.reply("⚠️ No matching per-page sheets to sort.").catch(() => {});
    return;
  }

  const statusMsg = await ctx.reply(
    `⏳ Sorting ${targets.length} per-page sheet(s) chronologically by date…`
  ).catch(() => null);
  const editStatus = async (t) => {
    if (!statusMsg) return;
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, t, { parse_mode: "Markdown" });
    } catch (err) {
      if (!/not modified/i.test(err.message || "")) console.error(`[adHandler] /sortsheets editStatus: ${err.message}`);
    }
  };

  let sorted = 0, skipped = 0, failed = 0, processed = 0;
  const errors = [];
  let lastEdit = Date.now();

  for (const page of targets) {
    try {
      const res = await sortSheetByDate(page.sheet_id, PAGE_TAB_NAME);
      if (res.sorted) {
        sorted++;
        console.log(`[adHandler] 🔢 /sortsheets @${page.handle}: sorted ${res.rows} rows`);
      } else {
        skipped++;
        console.log(`[adHandler] ⏭️ /sortsheets @${page.handle}: skipped (${res.reason})`);
      }
    } catch (err) {
      failed++;
      errors.push(`@${page.handle}: ${err.message}`);
      console.error(`[adHandler] ❌ /sortsheets @${page.handle}: ${err.message}`);
    }
    processed++;
    if (Date.now() - lastEdit > 5000) {
      editStatus(`🔢 *Sorting sheets*\n${processed}/${targets.length} done · ${sorted} sorted${skipped ? ` · ${skipped} skipped` : ""}${failed ? ` · ${failed} failed` : ""}`).catch(() => {});
      lastEdit = Date.now();
    }
  }

  const lines = [
    `🔢 *SortSheets done*`,
    "",
    `✅ sorted: ${sorted}`,
    skipped > 0 ? `⏭️ skipped: ${skipped} (no dated rows / <2 rows)` : null,
    failed > 0 ? `❌ failed: ${failed}` : null,
  ].filter(Boolean);
  if (errors.length > 0) {
    lines.push("", "*Errors*:");
    errors.slice(0, 10).forEach((e) => lines.push(`• \`${e.slice(0, 150)}\``));
    if (errors.length > 10) lines.push(`…and ${errors.length - 10} more (see logs)`);
  }
  if (statusMsg) await editStatus(lines.join("\n"));
  else await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" }).catch(() => {});
}

/**
 * /auditnif — read-only audit. Scans every enabled per-page sheet's Post
 * Duration column (F) for cells containing "NIF" (legacy rows where the old
 * parser dumped a NIF into the duration column). Reports counts + the
 * offending page/row/value. Makes NO edits.
 */
async function handleAuditNifCommand(ctx) {
  const adminId = parseInt(process.env.WIZARD_ADMIN_USER_ID || "0", 10);
  if (adminId && ctx.from?.id !== adminId) return;

  const allPages = pagesRegistry.listAllSync ? pagesRegistry.listAllSync() : [];
  const targets = allPages.filter((p) => p.sheet_id && !PLACEHOLDER_PATTERN.test(p.sheet_id));
  if (targets.length === 0) { await ctx.reply("⚠️ No per-page sheets to audit.").catch(() => {}); return; }

  const statusMsg = await ctx.reply(`⏳ Scanning ${targets.length} per-page sheet(s) for NIF-in-Duration…`).catch(() => null);
  const editStatus = async (t) => {
    if (!statusMsg) return;
    try { await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, t, { parse_mode: "Markdown" }); }
    catch (err) { if (!/not modified/i.test(err.message || "")) console.error(`[adHandler] /auditnif editStatus: ${err.message}`); }
  };

  const NIF_RE = /\bnif\b/i;
  const found = []; // { handle, row, value }
  let processed = 0, scanned = 0, failed = 0, lastEdit = Date.now();

  for (const page of targets) {
    try {
      const hits = await findRowsInColumn(page.sheet_id, PAGE_TAB_NAME, "F", NIF_RE);
      scanned++;
      for (const h of hits) found.push({ handle: page.handle, row: h.row, value: h.value });
    } catch (err) {
      failed++;
      console.error(`[adHandler] /auditnif @${page.handle}: ${err.message}`);
    }
    processed++;
    if (Date.now() - lastEdit > 5000) {
      editStatus(`🔎 *NIF audit*\n${processed}/${targets.length} scanned · ${found.length} hit(s)${failed ? ` · ${failed} failed` : ""}`).catch(() => {});
      lastEdit = Date.now();
    }
  }

  const lines = [
    `🔎 *NIF-in-Duration audit done*`,
    "",
    `Scanned: ${scanned}/${targets.length} per-page sheets${failed ? ` · ${failed} failed` : ""}`,
    `Found: *${found.length}* row(s) with NIF in Post Duration`,
  ];
  if (found.length > 0) {
    lines.push("", "*Offending rows:*");
    found.slice(0, 25).forEach((f) => lines.push(`• @${f.handle} row ${f.row}: \`${f.value.slice(0, 40)}\``));
    if (found.length > 25) lines.push(`…and ${found.length - 25} more (see logs)`);
    console.log(`[adHandler] /auditnif full list:`, JSON.stringify(found));
    lines.push("", "_Reply `/fixnif` to blank these (not built yet — tell me to add it)._");
  } else {
    lines.push("", "✅ Clean — no NIF values in any Post Duration column.");
  }
  if (statusMsg) await editStatus(lines.join("\n"));
  else await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" }).catch(() => {});
}

/**
 * /auditdupes [month …] — read-only audit. Scans every enabled per-page
 * sheet for DUPLICATE ad entries: rows sharing the same client + date +
 * price (price > $0) within the target months. Defaults to April + May
 * (this year). Reports per-page; makes NO edits.
 */
async function handleAuditDupesCommand(ctx) {
  const adminId = parseInt(process.env.WIZARD_ADMIN_USER_ID || "0", 10);
  if (adminId && ctx.from?.id !== adminId) return;

  const cmdText = (ctx.message?.text || "").trim();
  // "verify" → cross-check each candidate group against the source of truth
  // (distinct Telegram messages in the DB) so legit repeats aren't flagged.
  const verify = /\bverify\b/i.test(cmdText);
  const monthArgs = (cmdText.match(/\b(1[0-2]|[1-9])\b/g) || []).map(Number);
  const months = monthArgs.length > 0 ? monthArgs : [4, 5]; // default Apr+May
  const monthNames = months.map((m) => ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m]).join(" + ");

  const allPages = pagesRegistry.listAllSync ? pagesRegistry.listAllSync() : [];
  const targets = allPages.filter((p) => p.sheet_id && !PLACEHOLDER_PATTERN.test(p.sheet_id));
  if (targets.length === 0) { await ctx.reply("⚠️ No per-page sheets to audit.").catch(() => {}); return; }

  const statusMsg = await ctx.reply(`⏳ Scanning ${targets.length} sheet(s) for duplicate >$0 entries in ${monthNames}…`).catch(() => null);
  const editStatus = async (t) => {
    if (!statusMsg) return;
    try { await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, t, { parse_mode: "Markdown" }); }
    catch (err) { if (!/not modified/i.test(err.message || "")) console.error(`[adHandler] /auditdupes editStatus: ${err.message}`); }
  };

  const pagesWithDupes = []; // { handle, dupes:[{client,date,price,count,rows}] }
  let processed = 0, scanned = 0, failed = 0, totalDupeGroups = 0, lastEdit = Date.now();

  for (const page of targets) {
    try {
      const dupes = await findDuplicateRows(page.sheet_id, PAGE_TAB_NAME, { months, year: 2026, minPrice: 0 });
      scanned++;
      if (dupes.length > 0) {
        pagesWithDupes.push({ handle: page.handle, dupes });
        totalDupeGroups += dupes.length;
      }
    } catch (err) {
      failed++;
      console.error(`[adHandler] /auditdupes @${page.handle}: ${err.message}`);
    }
    processed++;
    if (Date.now() - lastEdit > 5000) {
      editStatus(`🔎 *Duplicate audit (${monthNames})*\n${processed}/${targets.length} scanned · ${totalDupeGroups} dup group(s) on ${pagesWithDupes.length} page(s)${failed ? ` · ${failed} failed` : ""}`).catch(() => {});
      lastEdit = Date.now();
    }
  }

  // ── verify: cross-check every candidate group against the source of truth ──
  // (distinct Telegram messages in the DB for that page+client+date). More
  // sheet rows than distinct real posts = TRUE duplicates; equal = legit
  // repeats (e.g. LLM/DCW 4/23 ×2 = two different briefs); zero DB records =
  // pre-tracking, can't verify here (check the chat). Fail-soft per group.
  if (verify && pagesWithDupes.length > 0) {
    const dnorm = (s) => { const m = String(s || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); return m ? `${+m[1]}/${+m[2]}/${(+m[3]) % 100}` : null; };
    const realDupes = [], legit = [], unverifiable = [];
    let vproc = 0;
    for (const pg of pagesWithDupes) {
      for (const d of pg.dupes) {
        let briefs = [];
        try { briefs = await adBriefs.getBriefsForPageClient(pg.handle, d.client); } catch (_) {}
        const key  = dnorm(d.date);
        const msgs = new Set(briefs.filter((b) => dnorm(b.date_posted) === key).map((b) => b.telegram_message_id));
        const real = msgs.size;
        if (real === 0)            unverifiable.push({ handle: pg.handle, client: d.client, date: d.date, count: d.count, rows: d.rows });
        else if (real >= d.count)  legit.push({ handle: pg.handle, client: d.client, date: d.date, real, count: d.count });
        else                       realDupes.push({ handle: pg.handle, client: d.client, date: d.date, price: d.price, sheetCount: d.count, real, excess: d.count - real, rows: d.rows });
      }
      vproc++;
      if (Date.now() - lastEdit > 5000) { editStatus(`🔬 Verifying vs chat — ${vproc}/${pagesWithDupes.length} page(s)…`).catch(() => {}); lastEdit = Date.now(); }
    }
    const vlines = [
      `🔬 *Source-of-truth dupe audit* (${monthNames})`,
      "",
      `Candidate groups: ${totalDupeGroups} on ${pagesWithDupes.length} page(s)`,
      `🗑️ True dupes: *${realDupes.length}* · ✅ Legit repeats: *${legit.length}* · ❓ Unverifiable: *${unverifiable.length}*`,
    ];
    if (realDupes.length) {
      vlines.push("", "*🗑️ TRUE DUPLICATES — delete the excess:*");
      let n = 0;
      for (const r of realDupes) { if (n++ >= 20) { vlines.push("…more in logs"); break; } vlines.push(`• @${r.handle}: ${r.client} · ${r.date} · $${r.price} — sheet ×${r.sheetCount}, real ${r.real} → delete ${r.excess} (rows ${r.rows.join(", ")})`); }
    }
    if (unverifiable.length) {
      vlines.push("", "*❓ PRE-TRACKING — no DB record, check the chat:*");
      let n = 0;
      for (const u of unverifiable) { if (n++ >= 12) { vlines.push("…more in logs"); break; } vlines.push(`• @${u.handle}: ${u.client} · ${u.date} ×${u.count} (rows ${u.rows.join(", ")})`); }
    }
    if (legit.length) vlines.push("", `*✅ Legit repeats (left alone):* ${legit.length} group(s)`);
    console.log(`[adHandler] /auditdupes verify:`, JSON.stringify({ realDupes, legit, unverifiable }));
    if (statusMsg) await editStatus(vlines.join("\n"));
    else await ctx.reply(vlines.join("\n"), { parse_mode: "Markdown" }).catch(() => {});
    return;
  }

  const lines = [
    `🔎 *Duplicate-entry audit done* (${monthNames}, >$0)`,
    "",
    `Scanned: ${scanned}/${targets.length} sheets${failed ? ` · ${failed} failed` : ""}`,
    `Found: *${totalDupeGroups}* duplicate group(s) across *${pagesWithDupes.length}* page(s)`,
    verify ? "\n_(verify: no candidate groups to check)_" : null,
  ].filter(Boolean);
  if (pagesWithDupes.length > 0) {
    lines.push("");
    let shown = 0;
    for (const pg of pagesWithDupes) {
      if (shown >= 25) { lines.push(`…and more (full list in logs)`); break; }
      lines.push(`*@${pg.handle}*`);
      for (const d of pg.dupes) {
        if (shown >= 25) break;
        lines.push(`• ${d.client} · ${d.date} · $${d.price} ×${d.count} (rows ${d.rows.join(", ")})`);
        shown++;
      }
    }
    console.log(`[adHandler] /auditdupes full result:`, JSON.stringify(pagesWithDupes));
  } else {
    lines.push("", "✅ No duplicate >$0 entries found.");
  }
  if (statusMsg) await editStatus(lines.join("\n"));
  else await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" }).catch(() => {});
}

/**
 * /fixundistributed [go] [@handle …] — repair the dateless "Undistributed
 * Funds Allocation" revenue row. It arrived with no Date Posted, so /syncsheets
 * stamped it ~today and it drifted toward the bottom of each page sheet. This
 * pins it to 6/24/22 (well before any real ad) on every per-page sheet that
 * has it, then re-sorts so it floats to the top.
 *
 *   /fixundistributed            → DRY RUN: list every page + current date, no writes
 *   /fixundistributed go         → apply on all pages (set date 6/24/22 + re-sort)
 *   /fixundistributed go @moist  → apply on just the named page(s)
 *
 * Matches column A on /funds\s+allocation/i so spelling/typo variants still hit.
 */
async function handleFixUndistributedCommand(ctx) {
  const adminId = parseInt(process.env.WIZARD_ADMIN_USER_ID || "0", 10);
  if (adminId && ctx.from?.id !== adminId) return;

  const cmdText = (ctx.message?.text || "").trim();
  const apply   = /\bgo\b/i.test(cmdText);
  const wantedHandles = (cmdText.match(/@([\w.]+)/g) || []).map((h) => h.slice(1).toLowerCase());

  const CLIENT_RE   = /funds\s+allocation/i;
  // 6/24/22 in the sheet's comma-free "Ddd M/D/YY" convention (e.g. "Fri
  // 6/24/22"), noon-UTC pinned so AZ projection can't slip the day. Built
  // without formatSheetDate because that emits a comma ("Fri, 6/24/22") which
  // would look inconsistent next to the existing "Thu 6/11/26" rows. (Sort
  // ignores the text anyway — it keys off a numeric scratch column.)
  const _t = new Date(Date.UTC(2022, 5, 24, 12, 0, 0));
  const TARGET_DATE =
    _t.toLocaleDateString("en-US", { timeZone: "America/Phoenix", weekday: "short" }) + " " +
    _t.toLocaleDateString("en-US", { timeZone: "America/Phoenix", month: "numeric", day: "numeric", year: "2-digit" });

  const allPages = pagesRegistry.listAllSync ? pagesRegistry.listAllSync() : [];
  let targets = allPages.filter((p) => p.sheet_id && !PLACEHOLDER_PATTERN.test(p.sheet_id));
  if (wantedHandles.length > 0) {
    const want = new Set(wantedHandles.map((h) => pagesRegistry.resolveHandle(h) || h));
    targets = targets.filter((p) => want.has(p.handle));
  }
  if (targets.length === 0) { await ctx.reply("⚠️ No matching per-page sheets.").catch(() => {}); return; }

  const mode = apply ? "Applying" : "DRY RUN — previewing";
  const statusMsg = await ctx.reply(`⏳ ${mode}: scanning ${targets.length} sheet(s) for "Funds Allocation" → ${TARGET_DATE}…`).catch(() => null);
  const editStatus = async (t) => {
    if (!statusMsg) return;
    try { await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, t, { parse_mode: "Markdown" }); }
    catch (err) { if (!/not modified/i.test(err.message || "")) console.error(`[adHandler] /fixundistributed editStatus: ${err.message}`); }
  };

  const hits = [];           // { handle, count, oldDates:[] }
  let processed = 0, failed = 0, totalRows = 0, sorted = 0, lastEdit = Date.now();

  for (const page of targets) {
    try {
      const res = await repinDateByClient(page.sheet_id, PAGE_TAB_NAME, CLIENT_RE, TARGET_DATE, { dryRun: !apply });
      if (res.count > 0) {
        hits.push({ handle: page.handle, count: res.count, oldDates: res.rows.map((r) => r.oldDate || "(blank)") });
        totalRows += res.count;
        if (apply) {
          await sortSheetByDate(page.sheet_id, PAGE_TAB_NAME).then(() => { sorted++; })
            .catch((e) => console.error(`[adHandler] /fixundistributed sort @${page.handle}: ${e.message}`));
        }
      }
    } catch (err) {
      failed++;
      console.error(`[adHandler] /fixundistributed @${page.handle}: ${err.message}`);
    }
    processed++;
    if (Date.now() - lastEdit > 5000) {
      editStatus(`🛠️ ${mode} — ${processed}/${targets.length}\n${hits.length} page(s), ${totalRows} row(s)${failed ? ` · ${failed} failed` : ""}`).catch(() => {});
      lastEdit = Date.now();
    }
  }

  const lines = [
    apply ? `🩹 *Undistributed Funds fixed* → ${TARGET_DATE}` : `🔎 *DRY RUN — Undistributed Funds* (would set → ${TARGET_DATE})`,
    "",
    `Scanned: ${processed}/${targets.length} sheets${failed ? ` · ${failed} failed` : ""}`,
    `${apply ? "Fixed" : "Found"}: *${totalRows}* row(s) on *${hits.length}* page(s)${apply ? ` · re-sorted ${sorted}` : ""}`,
  ];
  if (hits.length) {
    lines.push("");
    let shown = 0;
    for (const h of hits) {
      if (shown >= 30) { lines.push("…and more (see logs)"); break; }
      lines.push(`• @${h.handle}${h.count > 1 ? ` ×${h.count} ⚠️` : ""} — was: ${h.oldDates.join(", ")}`);
      shown++;
    }
    if (hits.some((h) => h.count > 1)) lines.push("", "⚠️ pages marked ×N have multiple matching rows — likely dupes, review after.");
    console.log(`[adHandler] /fixundistributed ${apply ? "APPLIED" : "dryrun"}:`, JSON.stringify(hits));
  } else {
    lines.push("", "✅ No 'Funds Allocation' rows found.");
  }
  if (!apply && hits.length) lines.push("", "▶️ Run `/fixundistributed go` to apply (+ re-sort). Note: rows with malformed dates (e.g. `10/20//22`) will sort to the bottom — fix those first.");

  if (statusMsg) await editStatus(lines.join("\n"));
  else await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" }).catch(() => {});
}

/**
 * /fixdropdowns [go] [@handle …] — snap the dropdown columns (B Ad Type,
 * E Post Type, F Post Duration) to each sheet's ACTUAL data-validation options
 * so there are no red "invalid" flags. e.g. the bot's "30 Days" → the
 * dropdown's "30 days". Reads each column's real option list and matches
 * case-insensitively (+ light wording normalization), then writes the exact
 * option text. Genuinely-unknown values are left untouched and reported.
 *
 *   /fixdropdowns            → DRY RUN: list what would change, no writes
 *   /fixdropdowns go         → apply on all pages
 *   /fixdropdowns go @moist  → apply on just the named page(s)
 */
async function handleFixDropdownsCommand(ctx) {
  const adminId = parseInt(process.env.WIZARD_ADMIN_USER_ID || "0", 10);
  if (adminId && ctx.from?.id !== adminId) return;

  const cmdText = (ctx.message?.text || "").trim();
  const apply   = /\bgo\b/i.test(cmdText);
  const wantedHandles = (cmdText.match(/@([\w.]+)/g) || []).map((h) => h.slice(1).toLowerCase());

  // Per-page schema: B = Ad Type, E = Post Type, F = Post Duration.
  const COLS = [["B", "Ad Type"], ["E", "Post Type"], ["F", "Post Duration"]];

  const allPages = pagesRegistry.listAllSync ? pagesRegistry.listAllSync() : [];
  let targets = allPages.filter((p) => p.sheet_id && !PLACEHOLDER_PATTERN.test(p.sheet_id));
  if (wantedHandles.length > 0) {
    const want = new Set(wantedHandles.map((h) => pagesRegistry.resolveHandle(h) || h));
    targets = targets.filter((p) => want.has(p.handle));
  }
  if (targets.length === 0) { await ctx.reply("⚠️ No matching per-page sheets.").catch(() => {}); return; }

  const mode = apply ? "Applying" : "DRY RUN — previewing";
  const statusMsg = await ctx.reply(`⏳ ${mode}: snapping dropdowns on ${targets.length} sheet(s)…`).catch(() => null);
  const editStatus = async (t) => {
    if (!statusMsg) return;
    try { await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, t, { parse_mode: "Markdown" }); }
    catch (err) { if (!/not modified/i.test(err.message || "")) console.error(`[adHandler] /fixdropdowns editStatus: ${err.message}`); }
  };

  const perPage = [];            // { handle, fixed, unmatched:[{col,value,row}] }
  let processed = 0, failed = 0, totalFixed = 0, totalUnmatched = 0, lastEdit = Date.now();

  for (const page of targets) {
    let pageFixed = 0; const pageUnmatched = [];
    try {
      for (const [col, label] of COLS) {
        const res = await fixDropdownColumn(page.sheet_id, PAGE_TAB_NAME, col, { dryRun: !apply });
        if (res.options == null) continue; // no dropdown on this column for this sheet
        pageFixed += res.changes.length;
        for (const u of res.unmatched) pageUnmatched.push({ col: label, value: u.value, row: u.row });
      }
      if (pageFixed > 0 || pageUnmatched.length > 0) {
        perPage.push({ handle: page.handle, fixed: pageFixed, unmatched: pageUnmatched });
        totalFixed += pageFixed; totalUnmatched += pageUnmatched.length;
      }
    } catch (err) {
      failed++;
      console.error(`[adHandler] /fixdropdowns @${page.handle}: ${err.message}`);
    }
    processed++;
    if (Date.now() - lastEdit > 5000) {
      editStatus(`🛠️ ${mode} — ${processed}/${targets.length}\n${apply ? "Fixed" : "Would fix"} ${totalFixed} cell(s) · ${totalUnmatched} unmatched${failed ? ` · ${failed} failed` : ""}`).catch(() => {});
      lastEdit = Date.now();
    }
  }

  const lines = [
    apply ? `🩹 *Dropdowns snapped to valid options*` : `🔎 *DRY RUN — dropdown snap*`,
    "",
    `Scanned: ${processed}/${targets.length} sheets${failed ? ` · ${failed} failed` : ""}`,
    `${apply ? "Fixed" : "Would fix"}: *${totalFixed}* cell(s) on *${perPage.filter((p) => p.fixed).length}* page(s)`,
    totalUnmatched > 0 ? `⚠️ Unmatched (no dropdown option): *${totalUnmatched}*` : null,
  ].filter(Boolean);
  if (perPage.length) {
    lines.push("");
    let shown = 0;
    for (const p of perPage) {
      if (shown >= 25) { lines.push("…more in logs"); break; }
      const bits = [];
      if (p.fixed) bits.push(`${p.fixed} fixed`);
      if (p.unmatched.length) bits.push(`${p.unmatched.length} unmatched`);
      lines.push(`• @${p.handle}: ${bits.join(", ")}`);
      for (const u of p.unmatched.slice(0, 3)) lines.push(`    ⚠️ ${u.col} row ${u.row}: "${u.value}"`);
      shown++;
    }
    console.log(`[adHandler] /fixdropdowns ${apply ? "APPLIED" : "dryrun"}:`, JSON.stringify(perPage));
  } else {
    lines.push("", "✅ Everything already matches the dropdowns.");
  }
  if (!apply && totalFixed > 0) lines.push("", "▶️ Run `/fixdropdowns go` to apply.");

  if (statusMsg) await editStatus(lines.join("\n"));
  else await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" }).catch(() => {});
}

/**
 * /auditcols — read-only audit. Checks every enabled per-page sheet's header
 * row against the standard layout the bot writes to:
 *   A Client · B Ad Type · C Bulk# · D Date · E Post Type · F Post Duration ·
 *   G Ad Price · H Notes
 * Flags any sheet where the key headers (esp. Ad Price + Post Type) aren't in
 * their expected columns — i.e. shifted by an extra column, which makes the
 * bot's positional writes land in the wrong column (@bestofhumors case).
 */
async function handleAuditColsCommand(ctx) {
  const adminId = parseInt(process.env.WIZARD_ADMIN_USER_ID || "0", 10);
  if (adminId && ctx.from?.id !== adminId) return;

  const allPages = pagesRegistry.listAllSync ? pagesRegistry.listAllSync() : [];
  const targets = allPages.filter((p) => p.sheet_id && !PLACEHOLDER_PATTERN.test(p.sheet_id));
  if (targets.length === 0) { await ctx.reply("⚠️ No per-page sheets to audit.").catch(() => {}); return; }

  const statusMsg = await ctx.reply(`⏳ Checking column layout on ${targets.length} per-page sheet(s)…`).catch(() => null);
  const editStatus = async (t) => {
    if (!statusMsg) return;
    try { await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, t, { parse_mode: "Markdown" }); }
    catch (err) { if (!/not modified/i.test(err.message || "")) console.error(`[adHandler] /auditcols editStatus: ${err.message}`); }
  };

  // Expected header → 0-indexed column. We anchor on the columns whose
  // misplacement actually corrupts data (Price, Post Type, Duration).
  const colLetter = (i) => String.fromCharCode(65 + i);
  const ANCHORS = [
    { name: "Ad Price",      idx: 6, re: /\bad\s*price\b|^price$/i },
    { name: "Post Type",     idx: 4, re: /\bpost\s*type\b/i },
    { name: "Post Duration", idx: 5, re: /\bpost\s*duration\b|\bduration\b/i },
  ];

  const misaligned = []; // { handle, problems:[...], header:[...] }
  let processed = 0, checked = 0, failed = 0, lastEdit = Date.now();

  for (const page of targets) {
    try {
      const header = await getHeaderRow(page.sheet_id, PAGE_TAB_NAME);
      checked++;
      const problems = [];
      for (const a of ANCHORS) {
        const atExpected = a.re.test((header[a.idx] || "").trim());
        if (!atExpected) {
          // find where it actually is
          const actualIdx = header.findIndex((h) => a.re.test((h || "").trim()));
          problems.push(`${a.name} expected ${colLetter(a.idx)}, ` +
            (actualIdx >= 0 ? `found in ${colLetter(actualIdx)}` : "not found"));
        }
      }
      if (problems.length > 0) misaligned.push({ handle: page.handle, problems, header });
    } catch (err) {
      failed++;
      console.error(`[adHandler] /auditcols @${page.handle}: ${err.message}`);
    }
    processed++;
    if (Date.now() - lastEdit > 5000) {
      editStatus(`🧮 *Column-layout audit*\n${processed}/${targets.length} checked · ${misaligned.length} misaligned${failed ? ` · ${failed} failed` : ""}`).catch(() => {});
      lastEdit = Date.now();
    }
  }

  const lines = [
    `🧮 *Column-layout audit done*`,
    "",
    `Checked: ${checked}/${targets.length} sheets${failed ? ` · ${failed} failed` : ""}`,
    `Misaligned: *${misaligned.length}*`,
  ];
  if (misaligned.length > 0) {
    lines.push("", "*Sheets needing a column fix:*");
    misaligned.slice(0, 30).forEach((m) => {
      lines.push(`• *@${m.handle}* — ${m.problems.join("; ")}`);
    });
    if (misaligned.length > 30) lines.push(`…and ${misaligned.length - 30} more (see logs)`);
    console.log(`[adHandler] /auditcols full result:`, JSON.stringify(misaligned.map((m) => ({ handle: m.handle, problems: m.problems, header: m.header }))));
  } else {
    lines.push("", "✅ All per-page sheets match the standard layout.");
  }
  if (statusMsg) await editStatus(lines.join("\n"));
  else await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" }).catch(() => {});
}

/**
 * /auditdates — read-only audit. Scans every enabled per-page sheet's Date
 * Posted column for out-of-range values: future year, >45 days ahead, or
 * before 2025 — i.e. typo'd dates like "Fri 2/26/27" sitting among 2026 rows.
 * Reports page/row/client/date. Makes NO edits.
 */
async function handleAuditDatesCommand(ctx) {
  const adminId = parseInt(process.env.WIZARD_ADMIN_USER_ID || "0", 10);
  if (adminId && ctx.from?.id !== adminId) return;

  const allPages = pagesRegistry.listAllSync ? pagesRegistry.listAllSync() : [];
  const targets = allPages.filter((p) => p.sheet_id && !PLACEHOLDER_PATTERN.test(p.sheet_id));
  if (targets.length === 0) { await ctx.reply("⚠️ No per-page sheets to audit.").catch(() => {}); return; }

  const statusMsg = await ctx.reply(`⏳ Scanning ${targets.length} sheet(s) for out-of-range dates…`).catch(() => null);
  const editStatus = async (t) => {
    if (!statusMsg) return;
    try { await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, t, { parse_mode: "Markdown" }); }
    catch (err) { if (!/not modified/i.test(err.message || "")) console.error(`[adHandler] /auditdates editStatus: ${err.message}`); }
  };

  const pagesWithBad = []; // { handle, bad:[{row,client,date}] }
  let processed = 0, scanned = 0, failed = 0, totalBad = 0, lastEdit = Date.now();

  for (const page of targets) {
    try {
      const bad = await findOutlierDates(page.sheet_id, PAGE_TAB_NAME, { futureDays: 45, floorYear: 2025 });
      scanned++;
      if (bad.length > 0) { pagesWithBad.push({ handle: page.handle, bad }); totalBad += bad.length; }
    } catch (err) {
      failed++;
      console.error(`[adHandler] /auditdates @${page.handle}: ${err.message}`);
    }
    processed++;
    if (Date.now() - lastEdit > 5000) {
      editStatus(`📅 *Date audit*\n${processed}/${targets.length} scanned · ${totalBad} bad date(s) on ${pagesWithBad.length} page(s)${failed ? ` · ${failed} failed` : ""}`).catch(() => {});
      lastEdit = Date.now();
    }
  }

  const lines = [
    `📅 *Out-of-range date audit done*`,
    "",
    `Scanned: ${scanned}/${targets.length} sheets${failed ? ` · ${failed} failed` : ""}`,
    `Found: *${totalBad}* suspicious date(s) on *${pagesWithBad.length}* page(s)`,
  ];
  if (pagesWithBad.length > 0) {
    lines.push("", "*Bad dates (likely typos):*");
    let shown = 0;
    for (const pg of pagesWithBad) {
      if (shown >= 30) { lines.push("…more in logs"); break; }
      for (const b of pg.bad) {
        if (shown >= 30) break;
        lines.push(`• *@${pg.handle}* row ${b.row}: ${b.client} → \`${b.date}\``);
        shown++;
      }
    }
    console.log(`[adHandler] /auditdates full result:`, JSON.stringify(pagesWithBad));
  } else {
    lines.push("", "✅ No out-of-range dates — all within the operating window.");
  }
  if (statusMsg) await editStatus(lines.join("\n"));
  else await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" }).catch(() => {});
}

async function handleAdMessage(ctx) {
  try {
    const text = ctx.message?.text || ctx.message?.caption;

    // ── /chatid — reply with THIS chat's numeric ID ────────────────────────────
    // Setup helper: add bm_tracking_bot to any IG Ads group and run /chatid to
    // get the exact ID to paste into the page registry. Works in any chat the
    // bot is in (placed BEFORE the TARGET_CHAT_IDS gate). Ungated — it only
    // reveals the chat's own ID, which is exactly what's needed during setup.
    if (text && /^\/chatid\b/i.test(text.trim())) {
      const c = ctx.chat || {};
      const lines = [
        `🆔 *Chat ID*`,
        `\`${c.id}\``,
        ``,
        `*Title:* ${c.title || (c.type === "private" ? "(private chat)" : "—")}`,
        `*Type:* ${c.type}`,
      ];
      if (c.type === "group") {
        lines.push(``, `⚠️ _Basic group — this ID changes if it's ever upgraded to a supergroup._`);
      }
      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" })
        .catch(() => ctx.reply(`Chat ID: ${c.id}`).catch(() => {}));
      return;
    }

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

    // /catchup [hours] — find + replay briefs the bot missed during a downtime
    // window (Telegram drops queued updates on restart, so they exist only in
    // chat history). Reads history via the user account, lists each missed
    // brief with Forward/Skip buttons. Sheet-safe: dedupes vs ad_briefs.
    if (text && /^\/catchup\b/i.test(text.trim())) {
      const { handleCatchupCommand } = require("./catchupHandler");
      return await handleCatchupCommand(ctx);
    }

    // /fixname <msgId> <name> — override a mislabeled brief's client name so
    // /catchup forwards + sheets it under the correct name (when the source
    // message can't be edited).
    if (text && /^\/fixname\b/i.test(text.trim())) {
      const { handleFixNameCommand } = require("./catchupHandler");
      return await handleFixNameCommand(ctx);
    }

    // /resolve — cover-to-page assignment for paused/ambiguous briefs.
    // Routed HERE (text-regex on bot.on "message") rather than via
    // bot.command("resolve") because in a multi-bot group (Monetization
    // Team + AI has 3 bots) Telegram doesn't reliably deliver a bare
    // "/resolve" to a specific bot through the command mechanism, so it
    // silently did nothing. This path fires for every message the bot sees
    // (privacy off), so bare /resolve works just like /sortsheets etc.
    if (text && /^\/resolve\b/i.test(text.trim())) {
      const { handleResolveCommand } = require("./resolveHandler");
      return await handleResolveCommand(ctx);
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

    // /sortsheets [@handle …] — re-sort per-page rev sheet(s) chronologically
    // by date. No args = all enabled pages; @handles = just those (test one
    // first). Master sheet excluded (its colored rows + day-bars need care).
    if (text && /^\/sortsheets\b/i.test(text.trim())) {
      return await handleSortSheetsCommand(ctx);
    }

    // /briefai [days] — review the Brief-AI shadow log: agreement rate +
    // recent disagreements between the LLM's read and the heuristics. Read-only.
    if (text && /^\/briefai\b/i.test(text.trim())) {
      return await handleBriefAICommand(ctx);
    }

    // /fixundistributed [go] [@handle …] — pin the dateless "Undistributed
    // Funds Allocation" row to 6/24/22 across per-page sheets + re-sort.
    // Dry-run by default; "go" applies.
    if (text && /^\/fixundistributed\b/i.test(text.trim())) {
      return await handleFixUndistributedCommand(ctx);
    }

    // /fixdropdowns [go] [@handle …] — snap Ad Type / Post Type / Post Duration
    // cells to each sheet's real dropdown options (kills red "invalid" flags).
    // Dry-run by default; "go" applies.
    if (text && /^\/fixdropdowns\b/i.test(text.trim())) {
      return await handleFixDropdownsCommand(ctx);
    }

    // /remove <message link|id> [@page …] — whole-adset takedown by link,
    // runnable from Monetization (no reply needed in the ads chat). Deletes
    // every page's forwarded post + master & per-page sheet rows + DB.
    if (text && /^\/remove\b/i.test(text.trim())) {
      const { handleRemoveCommand } = require("./updateHandler");
      return await handleRemoveCommand(ctx);
    }

    // /auditnif — read-only scan of every per-page sheet's Post Duration
    // column (F) for stray "… NIF" values (legacy pre-fix rows). Reports
    // only; makes no edits.
    if (text && /^\/auditnif\b/i.test(text.trim())) {
      return await handleAuditNifCommand(ctx);
    }

    // /auditdupes [months] — read-only scan for duplicate ad entries (same
    // client + date + price, price > $0) in every per-page sheet. Defaults to
    // April + May; pass numbers to override (e.g. "/auditdupes 3 4 5").
    if (text && /^\/auditdupes\b/i.test(text.trim())) {
      return await handleAuditDupesCommand(ctx);
    }

    // /auditcols — read-only check that every per-page sheet's header row
    // matches the standard layout (Post Type=E, Post Duration=F, Ad Price=G,
    // Notes=H). Flags sheets shifted by an extra column (@bestofhumors case).
    if (text && /^\/auditcols\b/i.test(text.trim())) {
      return await handleAuditColsCommand(ctx);
    }

    // /auditdates — read-only scan for out-of-range Date Posted values across
    // every per-page sheet (future-year typos like "2/26/27", ancient dates).
    if (text && /^\/auditdates\b/i.test(text.trim())) {
      return await handleAuditDatesCommand(ctx);
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

    // ── Debounce direct briefs (task #47) ───────────────────────────────────
    // Operators sometimes post a brief, immediately notice a typo (wrong day
    // number, wrong price, wrong client), and edit the message. Without a
    // buffer, the bot has already processed the original text — forwarded to
    // 20+ chats, written wrong rows to sheets, persisted the wrong DB row.
    //
    // Defer direct posts by BRIEF_DEBOUNCE_MS (default 2 min). During the
    // wait, edit_message webhook (task #40) updates message_buffer in place.
    // The cron worker (index.js) picks up due briefs, re-reads the latest
    // text from message_buffer, and replays this same handleAdMessage with
    // ctx._isDeferredProcessing=true to skip the defer gate.
    //
    // Skips:
    //   • Wizard handoffs — detected by querying ad_sessions for a 'sent'
    //     session whose internal_brief matches this chat+msg. Wizard writes
    //     that linkage in wizard.js after postAsUserClient succeeds. Beats
    //     the simpler "sender=sales_bolismedia" check because sales might
    //     also post manually using the same account (no wizard involved →
    //     should be debounced normally).
    //   • Already-deferred replays (ctx._isDeferredProcessing) — would loop
    //   • Debounce disabled (BRIEF_DEBOUNCE_MS<=0)
    if (!ctx._isDeferredProcessing) {
      try {
        const pendingBriefs = require("../lib/pendingBriefs");
        if (pendingBriefs.DEBOUNCE_MS > 0) {
          // Is this brief msg the result of a recent wizard approval?
          const sessions = require("../lib/sessions");
          let isWizardHandoff = false;
          if (sessions._supabase) {
            try {
              const { data: wizMatch } = await sessions._supabase
                .from("ad_sessions")
                .select("id")
                .eq("status", "sent")
                .eq("internal_brief->>chatId",    String(ctx.chat.id))
                .eq("internal_brief->>messageId", String(ctx.message.message_id))
                .limit(1);
              isWizardHandoff = !!(wizMatch && wizMatch.length > 0);
            } catch (_) { /* fail-open — debounce if lookup errors */ }
          }
          if (!isWizardHandoff) {
            // ── Supersede guard ────────────────────────────────────────────
            // Operators delete + re-send a brief to fix a typo, change pages,
            // or add a forgotten creative. Telegram never tells the bot about
            // the deletion, so without this every copy would process + forward
            // independently (Stake Day 19: 3 copies, last one media-less).
            //
            // Before deferring THIS copy, cancel any older still-pending copies
            // for the SAME campaign (same client name) in this chat. Only the
            // newest copy survives the debounce window and forwards. Matched by
            // parsed client name — robust to price/page edits between resends.
            try {
              // NOTE: `parsedList` is declared later in this function (const →
              // temporal dead zone), so derive the client from `parsed` here,
              // which is already in scope. Referencing parsedList threw
              // "Cannot access 'parsedList' before initialization" on every
              // brief, silently disabling the whole supersede guard.
              const thisClient = ((Array.isArray(parsed) ? parsed[0] : parsed)?.client || "")
                .trim().toLowerCase();
              if (thisClient) {
                const open = await pendingBriefs.listOpenForChat(ctx.chat.id, ctx.message.message_id);
                for (const row of open) {
                  // Read the older copy's text from the buffer and parse its client
                  const olderMsg = (getMessages(ctx.chat.id) || [])
                    .find((m) => m.message_id === row.message_id);
                  const olderText = olderMsg?.text || olderMsg?.caption || "";
                  if (!olderText) continue;
                  const olderParsed = parseAdMessage(olderText, new Date());
                  const olderClient = (Array.isArray(olderParsed) ? olderParsed[0] : olderParsed)?.client;
                  if (olderClient && olderClient.trim().toLowerCase() === thisClient) {
                    await pendingBriefs.markSuperseded(row.chat_id, row.message_id, ctx.message.message_id);
                    console.log(`[adHandler] ♻️  Superseded older pending copy msg ${row.message_id} ("${olderClient}") — newer copy ${ctx.message.message_id} replaces it`);
                  }
                }
              }
            } catch (err) {
              console.error(`[adHandler] supersede guard error (non-fatal): ${err.message}`);
            }

            const deferred = await pendingBriefs.defer(ctx.chat.id, ctx.message.message_id);
            if (deferred !== undefined) {
              const debounceSec = Math.round(pendingBriefs.DEBOUNCE_MS / 1000);
              console.log(`[adHandler] ⏳ Deferred brief ${ctx.message.message_id} for ${debounceSec}s (edit window)`);
              return; // cron will re-call handleAdMessage in DEBOUNCE_MS
            }
          } else {
            console.log(`[adHandler] ⏭️  Skipping debounce — wizard handoff for msg ${ctx.message.message_id}`);
          }
        }
      } catch (err) {
        console.error(`[adHandler] defer failed (processing immediately): ${err.message}`);
        // Fall through to immediate processing — fail-open
      }
    }

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

    // ── Fuzzy-canonicalize page handles against the registry ────────────────
    // Briefs sometimes typo handles (e.g. @dankquilius / one L instead of
    // the registered @dankquillius / two L's). Resolving early means every
    // downstream lookup (sheet_id, chat_id, auto_forward) hits a canonical
    // handle. Falls through unchanged for unknown handles — we only "fix"
    // a handle when there's a unique fuzzy match within distance 1.
    for (const item of parsedList) {
      if (!item.pageHandle) continue;
      const canonical = pagesRegistry.resolveHandle(item.pageHandle);
      if (canonical && canonical !== item.pageHandle.toLowerCase()) {
        item.pageHandle = canonical;
      }
    }

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

      // Insert a black day-divider bar if this brief starts a new day in the
      // master sheet (matches the team's old by-hand day breaks). Fires once
      // per day, above that day's first brief. Fully fail-open — never blocks
      // the real row writes below.
      await maybeInsertDayDivider(MASTER_SHEET_ID, TAB_NAME, parsedList[0]?.datePosted);

      let successCount = 0;
      for (const item of parsedList) {
        const row = buildRow(item);
        try {
          const rowNumber = await appendRow(MASTER_SHEET_ID, TAB_NAME, row);
          successCount++;
          if (rowNumber) masterRowsToFormat.push(rowNumber);
          if (item.pageHandle && rowNumber) {
            masterRowByHandle.set(item.pageHandle, rowNumber);
            // Persist master row number to DB. Awaited with explicit error
            // logging so we can match this against the per-page DB update —
            // if master succeeds and per-page fails (the symptom we saw),
            // both logs will be present in Railway and we can compare.
            const pageRowId = pageRowIdByHandle.get(item.pageHandle.toLowerCase());
            if (pageRowId) {
              try {
                await adBriefs.updatePageSheetRows(pageRowId, { masterSheetRow: rowNumber });
              } catch (dbErr) {
                console.error(`[adHandler] ❌ DB persist master_sheet_row for @${item.pageHandle}: ${dbErr.message}`);
              }
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

      const row = await buildPageRowSnapped(sheetId, item);
      try {
        // Per-page sheets: col A = Client Name (always filled), cols go A→H
        const pageSheetRowNum = await appendRow(sheetId, PAGE_TAB_NAME, row, { anchorColumn: "A", endColumn: "H" });
        pageSheetCount++;
        if (pageSheetRowNum) {
          if (!perPageRowsToFormat.has(sheetId)) perPageRowsToFormat.set(sheetId, []);
          perPageRowsToFormat.get(sheetId).push(pageSheetRowNum);
        }
        // Persist per-page sheet row to DB for audit + retry visibility.
        // Was previously fire-and-forget with .catch(() => {}) but production
        // showed this update silently failing for every brief — DB rows had
        // master_sheet_row set but page_sheet_row=null even though the bot
        // logged "Page sheet write" successfully. Switched to await+explicit
        // error logging so any failure mode (network, supabase quota, etc.)
        // surfaces in Railway logs instead of hiding behind .catch().
        const pageRowId = pageRowIdByHandle.get(item.pageHandle.toLowerCase());
        if (pageRowId && pageSheetRowNum) {
          try {
            await adBriefs.updatePageSheetRows(pageRowId, { pageSheetRow: pageSheetRowNum });
          } catch (dbErr) {
            console.error(`[adHandler] ❌ DB persist page_sheet_row for @${item.pageHandle} (page_row=${pageRowId.slice(0,8)}, sheet_row=${pageSheetRowNum}): ${dbErr.message}`);
          }
        } else if (!pageRowId) {
          console.warn(`[adHandler] ⚠️ DB persist skipped: no pageRowId mapping for @${item.pageHandle} (handle key lookup miss; map has ${pageRowIdByHandle.size} entries)`);
        }
        console.log(`[adHandler] ✅ Page sheet write: @${item.pageHandle} → "${PAGE_TAB_NAME}" (sheet row ${pageSheetRowNum}, db row ${pageRowId ? pageRowId.slice(0,8) : "n/a"})`);
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
      // Canonicalize scanner output against the registry so byHandle keys
      // match the canonicalized parsedList handles downstream (avoids
      // "no per-page creative" warnings when a Host line typo'd a handle).
      // Also filter scanner output to THIS brief's page list — drops orphan
      // @-named covers / labels from a missing or earlier brief that the
      // backwards-walk pulled in (Stake-after-Knicks bug, 2026-06-06).
      const briefHandles     = new Set(parsedList.map((p) => p.pageHandle?.toLowerCase()).filter(Boolean));
      // Run all three structured scanners and filter EACH to this brief's pages.
      // Collab used to win outright on any match — but a stray "Host: @x invite:"
      // line from an adjacent brief in the buffer (whose PAGE INFO boundary got
      // pruned, so _currentBlock couldn't bound it) matches collab on a single
      // coincidental page and hijacks the whole brief, suppressing the label/
      // filename scanners that would attribute every page (FashionNova → tagged
      // collab, attributed 1, dropped creatives). So instead pick the scanner
      // covering the MOST of the brief's actual pages — a real collab covers all
      // of them, contamination covers ~0-1 and loses.
      const rawCollabBundles   = canonicalizeBundleHandles(getCollabBundlesByPage(sourceChatId, adMessageId));
      const rawFilenameBundles = canonicalizeBundleHandles(getFilenameBundlesByPage(sourceChatId, adMessageId));
      const rawLabelBundles    = canonicalizeBundleHandles(getContentBundlesByPage(sourceChatId, adMessageId));
      const collabBundles    = filterBundleToBriefPages(rawCollabBundles, briefHandles);
      const filenameBundles  = filterBundleToBriefPages(rawFilenameBundles, briefHandles);
      const labelBundles     = filterBundleToBriefPages(rawLabelBundles, briefHandles);
      const collabCov   = collabBundles?.byHandle.size   || 0;
      const filenameCov = filenameBundles?.byHandle.size || 0;
      const labelCov    = labelBundles?.byHandle.size    || 0;
      const useCollab    = collabCov   > 0 && collabCov   >= filenameCov && collabCov >= labelCov;
      const useFilenames = !useCollab && filenameCov > 0 && filenameCov >= labelCov;
      const useLabels    = !useCollab && !useFilenames && labelCov > 0;
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

      // ── Brief-AI shadow compare (fire-and-forget, never blocks forward) ──
      // Run Claude over the whole brief block in parallel and flag any place it
      // reads the caption / creative count differently than the heuristics did.
      // Gated behind BRIEF_AI_SHADOW; hard no-op otherwise. Never alters this
      // forward — see lib/briefAI.js.
      if (briefAI.SHADOW_ENABLED) {
        try {
          const serialized = getBriefBlockForAI(sourceChatId, adMessageId);
          if (serialized) {
            const hCap = sharedBundle.caption && !isBareHandleCaption(sharedBundle.caption)
              ? sharedBundle.caption : null;
            const hPages = [...new Set(parsedList.map((p) => p.pageHandle?.toLowerCase()).filter(Boolean))];
            briefAI.shadowCompare(ctx.telegram, RESOLVE_ALERT_CHAT_ID, {
              serialized,
              chatId: sourceChatId,
              briefMessageId: adMessageId,
              heuristic: {
                caption: hCap,
                creativeCount: sharedBundle.media.length || fallbackMedia.length,
                format: detectedFormat,
                pages: hPages,
                client: parsedList[0]?.clientName || null,
              },
              label: `${parsedList[0]?.clientName || "?"} · ${detectedFormat} · ${hPages.length}p`,
            }); // intentionally not awaited
          }
        } catch (err) {
          console.error(`[adHandler] briefAI shadow hook error (non-fatal): ${err.message}`);
        }
      }

      // ── Group / multi-cover detection → pause + cover→page picker ────────
      // Two shapes get routed to the interactive picker (NO sheet writes —
      // already done above):
      //
      //   A. MULTI-GROUP — pages split into creative GROUPS, each with its own
      //      covers + slides + caption ("… for these N pages ^" labels). Can't
      //      be flattened into one bundle.
      //
      //   B. MULTI-COVER "for all" — a SINGLE group carrying ≥2 visually
      //      distinct COVER images with no per-page @handle (e.g. 5 different
      //      "Cover slides for all ^" images + shared slides). The bot can't
      //      tell if those are one-per-page covers or a shared carousel, so it
      //      must ASK rather than blast every cover to every page. (One shared
      //      cover/video → not ambiguous, stays on the silent standard path.)
      //
      // Both pause forwarding and auto-post the cover→page picker to the
      // monetization chat — exactly what /resolve would show. Takes precedence
      // over the cover-only ambiguity pause below.
      let multiGroupHandled = false;
      try {
        const blockStruct = getBlockStructure(sourceChatId, adMessageId);
        const briefPages = [...new Set(parsedList.map((p) => p.pageHandle?.toLowerCase()).filter(Boolean))];
        const hasAttribution = useCollab || useFilenames || useLabels;
        // Count DISTINCT cover images across the detected group(s) — distinct so
        // a single cover re-sent or duplicated doesn't read as "multiple".
        const coverKey = (m) => { const r = extractMediaRef(m); return r ? r.file_id : (m.document?.file_name || m.message_id); };
        const allCovers = blockStruct ? blockStruct.groups.flatMap((g) => g.covers || []) : [];
        const distinctCovers = new Set(allCovers.map(coverKey)).size;
        const multiCoverForAll = (
          !!blockStruct
          && !blockStruct.isMultiGroup
          && !hasAttribution            // no @handle mapping to trust
          && distinctCovers >= 2        // ≥2 distinct covers → genuinely ambiguous
          && briefPages.length >= 2
        );

        if (blockStruct && (blockStruct.isMultiGroup || multiCoverForAll) && briefRowId && adBriefs._supabase) {
          const singleGroup = blockStruct.groups.length === 1;
          const serGroups = blockStruct.groups.map((g) => ({
            key:        g.key,
            // Block scanner only captures captions behind an explicit
            // "Caption ^" label; a bare caption above the brief (the common
            // "for all" shape) is captured by getStandardBundle instead — fall
            // back to it so the single group still forwards its caption.
            caption:    g.caption || (singleGroup ? (sharedBundle.caption || null) : null),
            namedPages: g.namedPages || null,
            coverRefs:  (g.covers || []).map(mediaRefWithId).filter(Boolean),
            slideRefs:  (g.slides || []).map(mediaRefWithId).filter(Boolean),
          }));
          const { createGroupSessionAndPrompt } = require("./resolveHandler");
          const created = await createGroupSessionAndPrompt(ctx.telegram, {
            briefId:        briefRowId,
            sourceChatId,
            briefMessageId: ctx.message.message_id,
            briefText:      text,
            pages:          briefPages,
            groups:         serGroups,
            alertChatId:    RESOLVE_ALERT_CHAT_ID,
          });
          if (created) {
            multiGroupHandled = true;
            const shape = blockStruct.isMultiGroup ? `${serGroups.length} groups` : `${distinctCovers} distinct covers (single "for all" group)`;
            console.warn(`[adHandler] 🧩 Brief ${briefRowId.slice(0, 8)} paused for cover→page picker — ${shape}`);
          }
        }
      } catch (err) {
        console.error(`[adHandler] group/multi-cover detection error (non-fatal): ${err.message}`);
      }

      // ── Ambiguous-brief detection + PAUSE ────────────────────────────────
      // Two ambiguity shapes we catch here:
      //
      //   1. PARTIAL labeling: some covers @-named, others not. Filename
      //      scanner attributes the labeled ones but the unlabeled covers
      //      go into shared → wrong attribution for half the pages.
      //
      //   2. NO labeling at all on a multi-page brief: standard fallback
      //      runs and bundles every preceding media item as "shared" →
      //      every page receives every cover indiscriminately (Danielson's
      //      "Justin @FruitSnacks California Candidates" case fit this).
      //
      // When detected, instead of silently misforwarding, we PAUSE: create
      // a pending_brief_assignments row + tell the admin to /resolve.
      // The forward block below checks this flag and skips per-page sends.
      const briefHandleCount = new Set(
        parsedList.map((p) => p.pageHandle?.toLowerCase()).filter(Boolean),
      ).size;
      // NOTE (2026-06-07): `ambiguousPartial` is DISABLED for filename
      // attribution. It used to fire whenever a filename-attributed brief
      // had fewer @-covers than pages + any shared media — but that's the
      // SHAPE OF DANIELSON'S STANDARD HYBRID BRIEF: some pages get a unique
      // @<handle>.jpg cover, the rest just take the shared "slides for ALL".
      // @-filenames are UNAMBIGUOUS by definition (the filename says exactly
      // which page each cover belongs to), so partial coverage is not
      // ambiguous — the uncovered pages simply receive shared media + brief.
      //
      // The old gate paused EVERY hybrid brief for a /resolve that operators
      // never ran, and a later media-less re-post would then force-forward
      // junk (Stake Day 19 disaster, msgs 66706/66731 paused → 66733 sent
      // empty). Forwarding partial-coverage filename briefs directly is the
      // correct behavior: covered pages get cover+shared, uncovered pages get
      // shared-only. If an operator genuinely forgot to @-name a cover, it
      // lands in every page's shared bundle — recoverable via /update, far
      // less damaging than a silent pause.
      //
      // Genuine ambiguity (a pile of UNNAMED covers, one per page, no naming
      // at all) is still caught by `ambiguousNoLabels` below.
      const ambiguousPartial = false;
      const ambiguousNoLabels = (
        detectedFormat === "standard"
        && briefHandleCount >= 2
        && sharedBundle.media.length >= briefHandleCount     // at least 1 cover per page expected
      );
      // Per-page-label format can also be ambiguous: the scanner detected
      // SOMETHING that looked label-like (e.g. "Covers for ALL ^") but
      // didn't actually attribute any of the brief's pages. Symptom:
      // detectedFormat="per-page-label" but attributedCount < pages.
      const ambiguousLabelMiss = (
        detectedFormat === "per-page-label"
        && briefHandleCount > 1
        && attributedCount < briefHandleCount
        && sharedBundle.media.length > 0
      );
      const isAmbiguousBrief = ambiguousPartial || ambiguousNoLabels || ambiguousLabelMiss;
      let isPaused = false;
      // Multi-group already paused + created its own (richer) session above —
      // don't ALSO run the cover-only ambiguity pause for the same brief.
      if (multiGroupHandled) isPaused = true;
      if (!multiGroupHandled && isAmbiguousBrief && briefRowId && adBriefs._supabase) {
        try {
          const unattributedRefs = sharedBundle.media.map((m, i) => extractMediaRef(m)
            ? { ...extractMediaRef(m), idx: i, msg_id: m.message_id || `synth-${i}`, file_name: m.document?.file_name || m.video?.file_name || null }
            : null
          ).filter(Boolean);
          const briefPages = [...new Set(parsedList.map((p) => p.pageHandle?.toLowerCase()).filter(Boolean))];

          // Create paused session — /resolve picks it up
          const { data: pba, error: pbaErr } = await adBriefs._supabase
            .from("pending_brief_assignments")
            .insert({
              brief_id:         briefRowId,
              source_chat_id:   Number(chatId),
              brief_message_id: ctx.message.message_id,
              brief_text:       (text || "").slice(0, 1000),
              pages:            briefPages,
              unattributed:     unattributedRefs,
              assignments:      {},
              status:           "awaiting",
              expires_at:       new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            })
            .select()
            .single();
          if (pbaErr) throw new Error(pbaErr.message);

          isPaused = true;
          const adminId = parseInt(process.env.WIZARD_ADMIN_USER_ID || "0", 10);
          const sessionShort = pba.id.slice(0, 8);
          const briefShort   = briefRowId.slice(0, 8);
          const briefSnippet = (ctx.message?.text || "").split("\n").slice(0, 2).join("\n");
          const ambKind = ambiguousNoLabels ? "no labels" : ambiguousLabelMiss ? "label-format misattribution" : "partial labels";
          // Where to post the assignment prompt. Prefer the Monetization
          // Team + AI chat (RESOLVE_ALERT_CHAT_ID / SALES_TEAM_CHAT_ID) so the
          // team sees it + the reminder cron can re-ping there; then admin DM;
          // then the source chat as a last resort so a paused brief is NEVER
          // silent (the SESH brief paused with WIZARD_ADMIN_USER_ID unset →
          // session created, prompt_chat_id null, 0 prompts sent).
          // ctx._resolvePromptChatId is set by /catchup so a recovered brief's
          // picker lands in the chat the operator ran /catchup from
          // (Monetization), NOT the source ads chat the team watches.
          const promptTarget = ctx._resolvePromptChatId || RESOLVE_ALERT_CHAT_ID || adminId || ctx.chat?.id;
          const promptWhere = ctx._resolvePromptChatId ? "catchup chat" : RESOLVE_ALERT_CHAT_ID ? "monetization chat" : adminId ? "admin DM" : "source chat";
          console.warn(`[adHandler] ⏸️ PAUSED BRIEF ${briefShort} — ${ambKind}, session ${sessionShort}, prompting ${promptWhere} ${promptTarget}`);

          if (promptTarget) {
            // Heads-up first, then the interactive UI (per-cover prompts with
            // page buttons). Operator never needs to type /resolve manually.
            try {
              await ctx.telegram.sendMessage(promptTarget,
                "⏸️ *Brief paused — needs cover assignment*\n" +
                "─────────────────────────\n" +
                `*Brief:* \`${briefSnippet.replace(/[_*`\[]/g, (c) => "\\" + c).slice(0, 160)}…\`\n` +
                `*Pages:* ${briefHandleCount} · *Unlabeled covers:* ${unattributedRefs.length} · *Type:* ${ambiguousNoLabels ? "no labels at all" : "partial labels"}\n\n` +
                "Per-page forwarding *did not run* — would have misattributed covers.\n" +
                `Tap a page button under each cover below to assign (or run \`/resolve ${briefShort}\`). Auto-forwards when all are assigned.`,
                { parse_mode: "Markdown" }
              );
              const { postAssignmentUI } = require("./resolveHandler");
              await postAssignmentUI(ctx.telegram, promptTarget, pba.id);
            } catch (err) {
              console.error(`[adHandler] auto-trigger /resolve UI failed: ${err.message}`);
              // Last-ditch: a plain instructional message to the source chat
              // so the pause still surfaces even if the rich UI post failed.
              ctx.telegram.sendMessage(promptTarget,
                `⏸️ Brief paused — ${unattributedRefs.length} unnamed cover(s) for ${briefHandleCount} pages need assignment. Run \`/resolve ${briefShort}\` to map them.`,
                { parse_mode: "Markdown" }
              ).catch(() => {});
            }
          } else {
            console.error(`[adHandler] ⚠️ Brief paused but no prompt target (no admin + no chat id) — session ${sessionShort} awaiting manual /resolve`);
          }
        } catch (err) {
          console.error(`[adHandler] ambiguous-brief pause failed (forwarding will proceed): ${err.message}`);
          // Fail-open — if we can't persist the paused session, fall through
          // to current behavior rather than blocking the forward entirely
          isPaused = false;
        }
      }

      // ── "Couldn't classify format" advisory (NON-BLOCKING) ──────────────
      // The scanners found per-page creative (@-named files or "@handle ^"
      // labels) but, after filtering to THIS brief's pages, none of it
      // matched — so the brief fell through to the "standard / shared-to-all"
      // path. That's a classification misfire: either the creative belongs to
      // a different brief that the backwards-walk pulled in (Stake-after-Knicks
      // contamination), or the @-handles are misspelled / not in the registry.
      // We do NOT pause (forwarding proceeds as standard — pausing here caused
      // the Day-19 empty-send disaster); we just post a heads-up so a human can
      // /resolve it if the auto-guess was wrong. Never silent, never blocking.
      try {
        const rawAttribCount = (rawFilenameBundles?.byHandle.size || 0) + (rawLabelBundles?.byHandle.size || 0);
        const unclassified = (
          !multiGroupHandled && !isPaused
          && detectedFormat === "standard"
          && rawAttribCount > 0      // per-page creative WAS detected…
          && attributedCount === 0   // …but none matched this brief's pages
        );
        if (unclassified && RESOLVE_ALERT_CHAT_ID) {
          const seenHandles = [
            ...Object.keys(rawFilenameBundles?.byHandle ? Object.fromEntries(rawFilenameBundles.byHandle) : {}),
            ...Object.keys(rawLabelBundles?.byHandle ? Object.fromEntries(rawLabelBundles.byHandle) : {}),
          ];
          const seenStr = [...new Set(seenHandles)].slice(0, 12).map((h) => `@${h}`).join(", ") || "—";
          const briefShort = briefRowId ? briefRowId.slice(0, 8) : "?";
          const briefSnippet = (ctx.message?.text || "").split("\n").slice(0, 2).join(" / ").slice(0, 160);
          console.warn(`[adHandler] ⚠️ UNCLASSIFIED brief ${briefShort} — detected per-page creative for [${seenStr}] but none match brief pages; forwarded as standard`);
          await ctx.telegram.sendMessage(RESOLVE_ALERT_CHAT_ID,
            "⚠️ *Couldn't confidently classify this brief*\n" +
            "─────────────────────────\n" +
            `*Brief:* \`${briefSnippet.replace(/[_*`\[]/g, (c) => "\\" + c)}…\`\n` +
            `*Pages (${briefHandleCount}):* ${[...briefHandles].slice(0, 12).map((h) => `@${h}`).join(", ")}\n\n` +
            `I found per-page creative labeled for ${seenStr}, but *none of those match this brief's pages* — likely a misspelled @handle or creative from a different brief.\n\n` +
            `➡️ Forwarded as a *standard / shared-to-all* brief (every page got the same creative + brief). ` +
            `If covers should map per-page instead, run \`/resolve ${briefShort}\`.`,
            { parse_mode: "Markdown" }
          ).catch((e) => console.error(`[adHandler] unclassified advisory send failed: ${e.message}`));
        }
      } catch (err) {
        console.error(`[adHandler] unclassified-format advisory error (non-fatal): ${err.message}`);
      }

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

      // PAUSED: ambiguous-brief gate fired above. Skip per-page forwarding
      // entirely — operator will resolve via /resolve, which triggers a
      // re-forward with the correct cover-to-page mapping (Phase 3).
      if (isPaused) {
        console.log(`[adHandler] ⏸️ Per-page forwarding skipped — brief paused for /resolve. ${uniqueHandles.length} pages will be sent once assignments complete.`);
        // Keep sheet writes etc. that already happened above — those are
        // idempotent and operator can /syncsheets to confirm. We just don't
        // send the Telegram forwards yet.
        clearBufferUpTo(chatId, ctx.message.message_id);
        return;
      }

      // ── No-media guard (2026-06-07) ──────────────────────────────────────
      // If a MULTI-PAGE brief reaches this point with ZERO media of any kind
      // — no per-page covers, no shared media, no fallback media — something
      // is wrong. The overwhelmingly common cause: the brief was posted (or
      // re-posted) AFTER its creative had already been pruned from the buffer
      // by an earlier processing of the same campaign. Force-forwarding a
      // media-less "standard" brief to N pages spams every chat with a brief
      // + caption and NO content — exactly the Stake Day 19 failure (msg
      // 66733 sent 12 media-less forwards after 66706/66731 already ran).
      //
      // Rather than blast junk, skip the forward and alert the admin. The
      // real creative-bearing copy already forwarded (or is paused); this
      // empty re-post should not overwrite it. Operator can /replay if this
      // was a genuine standalone text brief that legitimately had no media.
      const noMediaAtAll =
        (!activeBundle || activeBundle.byHandle.size === 0) &&
        sharedBundle.media.length === 0 &&
        fallbackMedia.length === 0;
      if (noMediaAtAll && uniqueHandles.length >= 2) {
        console.warn(
          `[adHandler] 🚫 Skipping media-less multi-page brief (${uniqueHandles.length} pages, ` +
          `format: ${detectedFormat}). Likely a re-post after the creative was pruned from the buffer. ` +
          `Not force-forwarding empty content.`,
        );
        const adminId = parseInt(process.env.WIZARD_ADMIN_USER_ID || "0", 10);
        if (adminId) {
          ctx.telegram.sendMessage(adminId,
            "🚫 *Skipped a media-less brief*\n" +
            "─────────────────────────\n" +
            `*Brief:* \`${(ctx.message?.text || "").split("\n")[0].slice(0, 80)}\`\n` +
            `*Pages:* ${uniqueHandles.length} · *Media found:* none\n\n` +
            "This looks like a duplicate/re-post after the creative was already " +
            "consumed by an earlier copy. I did *not* forward empty content to the pages.\n\n" +
            "If this was a real standalone brief, reply `/replay` to it.",
            { parse_mode: "Markdown" }
          ).catch(() => {});
        }
        clearBufferUpTo(chatId, ctx.message.message_id);
        return;
      }

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

        // Collect EVERY message id we send to this page (covers, shared
        // slides, caption, brief) so a later /replay can delete the whole
        // prior forward before re-sending — clean delete+resend, no dupes.
        const forwardedIds = [];

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
              const sent = await ctx.telegram.forwardMessage(String(destChatId), sourceChatId, mediaMsg.message_id);
              if (sent?.message_id) forwardedIds.push(sent.message_id);
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
              const sent = await ctx.telegram.forwardMessage(String(destChatId), sourceChatId, mediaMsg.message_id);
              if (sent?.message_id) forwardedIds.push(sent.message_id);
            } catch (err) {
              console.error(`[adHandler] ❌ Forward shared msg ${mediaMsg.message_id} → @${handle}: ${err.message}`);
            }
          }
          console.log(`[adHandler] ✅ Forwarded ${sharedBundle.media.length} shared msg(s) → @${handle}`);
        }

        // 3️⃣ Caption — a real per-page caption wins over the shared one.
        // Filter EACH candidate for bare-@handle junk BEFORE choosing: a cover
        // whose media caption is just "@page" must NOT suppress the real shared
        // caption. (Old `perPageCaption || shared` then a single bare-handle
        // check let "@page" win the ||, then nulled it → the real IG caption
        // silently dropped on every brief whose cover carried a @handle caption.)
        const _ppCap = perPageCaption && !isBareHandleCaption(perPageCaption) ? perPageCaption : null;
        const _shCap = sharedBundle.caption && !isBareHandleCaption(sharedBundle.caption) ? sharedBundle.caption : null;
        const captionToSend = _ppCap || _shCap;
        if (captionToSend) {
          try {
            const sent = await ctx.telegram.sendMessage(String(destChatId), captionToSend);
            if (sent?.message_id) forwardedIds.push(sent.message_id);
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
          const briefFwdMsgId = await forwardToPage(
            ctx.telegram,
            sourceChatId,
            adMessageId,
            ctx.message?.text || ctx.message?.caption || "",
            String(destChatId),
            handle,
            parsedItem
          );
          if (briefFwdMsgId) forwardedIds.push(briefFwdMsgId);
          forwardOk++;

          // ── Mark this page forwarded in the DB ──────────────────────────────
          // Store the FULL set of message ids sent to this page (covers,
          // shared slides, caption, brief) — not just the brief. This lets a
          // later /replay delete the entire prior forward before re-sending
          // (clean delete+resend) AND keeps the brief id available for
          // /update price chat edits. The brief id is last in the array.
          const pageRowId = pageRowIdByHandle.get(handle.toLowerCase());
          if (pageRowId) {
            adBriefs.markPageForwarded(pageRowId, {
              masterSheetRow: masterRowByHandle.get(handle) ?? null,
              messageIds:     forwardedIds.length > 0 ? forwardedIds : null,
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

module.exports = { handleAdMessage, extractPostedOnDate, buildPerPageBriefText };
