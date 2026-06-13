/**
 * catchupHandler.js — /catchup: recover briefs the bot missed during downtime.
 *
 * When the service is down, Telegram's queued webhook updates are dropped on
 * restart (setWebhook drop_pending_updates: true), so any briefs posted during
 * the outage are NEVER received — they exist only in the source chat's history.
 * They're not in the DB or the message buffer, so /replay and /syncsheets can't
 * see them.
 *
 * /catchup [hours]  (admin, run IN the affected source chat)
 *   1. Reads the chat's last <hours> of history via the sales_bolismedia user
 *      account (the only way to read history — the Bot API can't).
 *   2. Finds every message that parses as a brief and is NOT already in
 *      ad_briefs (dedupe by telegram chat+message_id → no double sheet rows).
 *   3. Posts each missed brief with [Forward] / [Skip] buttons so the operator
 *      triages (stale time-sensitive ads can be skipped).
 *
 * On [Forward]: re-reads the messages around that brief, re-injects them into
 * the buffer (message_id + text + media markers + @<handle> filenames), then
 * runs the SAME fakeCtx → handleAdMessage path the pending-brief cron uses. So
 * forwarding (by message_id), sheet writes, dedupe, and the cover→page picker
 * all reuse the normal, tested pipeline. Nothing here writes sheets directly.
 */

const { parseAdMessage } = require("../parser");
const adBriefs   = require("../lib/adBriefs");
const userClient = require("../userClient");
const { addMessage, getMessages } = require("../messageBuffer");

const ADMIN_ID = parseInt(process.env.WIZARD_ADMIN_USER_ID || "0", 10);
const MAX_LISTED = 25;          // cap the review list so we don't flood the chat
const WINDOW_BEFORE = 60;       // messages to re-read before+incl a brief on Forward
// The primary ads source chat (Internal Network Ads) + the Monetization Team +
// AI chat. Running /catchup IN the monetization chat (no explicit source) auto-
// targets the ads chat, so cards + cover-pickers stay in monetization and the
// sales team in the ads chat never sees the recovery traffic.
// Primary ads source chat (Internal Network Ads). TARGET_CHAT_ID may be a
// comma list — take the first. Running /catchup anywhere that ISN'T this chat
// (e.g. the Monetization chat) auto-targets it, so the sales team in the ads
// chat never sees recovery traffic.
const DEFAULT_SOURCE_CHAT = (process.env.TARGET_CHAT_ID || "").split(",")[0].trim() || "-1001868750472";

function isAdmin(ctx) {
  // Fail-open if no admin configured (matches the rest of the codebase's
  // posture); otherwise restrict to the configured admin.
  return !ADMIN_ID || ctx.from?.id === ADMIN_ID;
}

/**
 * Turn a userClient rich message ({message_id, date, text, kind, file_name})
 * into a Bot-API-shaped object the message buffer + bundle scanners understand.
 * Media carries only a marker + filename (no bot file_id — forwarding is by
 * message_id), which is all the scanners and the picker need.
 */
function toBufferMsg(chatId, m) {
  const msg = {
    message_id: m.message_id,
    chat:       { id: Number(chatId) },
    date:       m.date,
    from:       { id: 0, is_bot: false, username: null },
  };
  if (m.kind) {
    // Media message — text (if any) is its caption.
    if (m.text) msg.caption = m.text;
    if (m.kind === "document")  msg.document  = { file_name: m.file_name || undefined };
    else if (m.kind === "video")     msg.video     = { file_name: m.file_name || undefined };
    else if (m.kind === "audio")     msg.audio     = { file_name: m.file_name || undefined };
    else if (m.kind === "animation") msg.animation = {};
    else if (m.kind === "photo")     msg.photo     = [{ file_id: null }];
  } else {
    msg.text = m.text || "";
  }
  return msg;
}

const fmtTime = (unixSec) => {
  try {
    return new Date((unixSec || 0) * 1000).toLocaleString("en-US", {
      timeZone: "America/Phoenix", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit",
    });
  } catch (_) { return "?"; }
};

// ── /catchup command ─────────────────────────────────────────────────────────
async function handleCatchupCommand(ctx) {
  if (!isAdmin(ctx)) {
    console.log(`[catchup] denied — user ${ctx.from?.id} not admin`);
    return;
  }
  const promptChatId = ctx.chat?.id;            // where cards/responses go (e.g. Monetization)
  if (!promptChatId) return;

  const cmd = (ctx.message?.text || "").trim();
  // Optional explicit source chat (a Telegram supergroup id, -100…). Strip it
  // before parsing hours so the id's digits aren't read as the hour count.
  const sourceMatch = cmd.match(/(-100\d{6,})/);
  const explicitSource = sourceMatch ? sourceMatch[1] : null;
  const hoursMatch = cmd.replace(/-100\d{6,}/, "").match(/\b(\d{1,3}(?:\.\d+)?)\b/);
  const hoursArg = hoursMatch ? parseFloat(hoursMatch[1]) : NaN;
  const hours = Number.isFinite(hoursArg) && hoursArg > 0 ? Math.min(hoursArg, 72) : 30;

  // Source chat to SCAN + forward from. Explicit arg wins. Otherwise: if run IN
  // the ads chat, scan it; if run ANYWHERE ELSE (e.g. Monetization), default to
  // the configured ads chat — so /catchup from Monetization points at Internal
  // Network Ads with no args and the team there sees nothing.
  const inAdsChat = DEFAULT_SOURCE_CHAT && String(promptChatId) === String(DEFAULT_SOURCE_CHAT);
  const sourceChatId = Number(explicitSource || (inAdsChat ? promptChatId : (DEFAULT_SOURCE_CHAT || promptChatId)));
  const crossChat = String(sourceChatId) !== String(promptChatId);

  await ctx.reply(
    `🔎 Scanning the last ${hours}h of ${crossChat ? `chat \`${sourceChatId}\`` : "this chat"} for missed briefs…`,
    { parse_mode: "Markdown" }
  ).catch(() => {});

  // 1. Read history via the user account.
  let window;
  try {
    window = await userClient.getHistoryWindow(sourceChatId, Date.now() - hours * 3600 * 1000, 1500);
  } catch (err) {
    await ctx.reply(
      `❌ Couldn't read chat history: ${err.message}\n\n` +
      "Catch-up needs the sales_bolismedia user session. If you set " +
      "`DISABLE_USER_CLIENT=true` to stop the reconnect war, the Tracker needs " +
      "its *own* session string (not a copy of Greg's) before /catchup can run.",
      { parse_mode: "Markdown" }
    ).catch(() => {});
    return;
  }

  // 2. Find briefs not already in the DB.
  const missed = [];
  for (const m of window) {
    if (!m.text || m.kind) continue;                 // briefs are text messages
    if (/^\/(catchup|replay|resolve|sync|center|sort|audit|update|editbrief)/i.test(m.text.trim())) continue;
    let parsed;
    try { parsed = parseAdMessage(m.text, new Date((m.date || 0) * 1000)); } catch (_) { parsed = null; }
    if (!parsed) continue;
    const items = Array.isArray(parsed) ? parsed : [parsed];
    if (!items.length || !items[0]?.client) continue;

    // Dedupe: already processed (forwarded + sheeted) → skip.
    const existing = await adBriefs.findBriefByTelegramMessage(sourceChatId, m.message_id);
    if (existing) continue;

    const pages = [...new Set(items.map((p) => p.pageHandle?.toLowerCase()).filter(Boolean))];
    missed.push({ message_id: m.message_id, date: m.date, client: items[0].client, pages, text: m.text });
  }

  if (!missed.length) {
    await ctx.reply(`✅ No missed briefs in the last ${hours}h — everything in this chat is already in the books.`).catch(() => {});
    return;
  }

  const shown = missed.slice(0, MAX_LISTED);
  await ctx.reply(
    `📋 Found *${missed.length}* missed brief${missed.length === 1 ? "" : "s"} in the last ${hours}h` +
    (missed.length > shown.length ? ` (showing first ${shown.length})` : "") +
    `.\nTap *Forward* to replay one (covers, slides, caption + brief to each page), or *Skip* if it's stale.`,
    { parse_mode: "Markdown" }
  ).catch(() => {});

  // 3. One reviewable card per missed brief.
  for (const b of shown) {
    const snippet = b.text.split("\n").slice(0, 2).join(" / ").slice(0, 120);
    const pagesStr = b.pages.length ? b.pages.map((h) => `@${h}`).join(", ") : "(no @handles in brief)";
    await ctx.telegram.sendMessage(promptChatId,
      `🆕 *Missed brief*\n` +
      `*Campaign:* ${b.client}\n` +
      `*Pages (${b.pages.length}):* ${pagesStr}\n` +
      `*Posted:* ${fmtTime(b.date)}\n` +
      `\`${snippet.replace(/[`*_\[]/g, (c) => "\\" + c)}…\``,
      {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[
          { text: "✅ Forward", callback_data: `catchup:fwd:${sourceChatId}:${b.message_id}` },
          { text: "⏭️ Skip",    callback_data: `catchup:skip:${sourceChatId}:${b.message_id}` },
        ]] },
      }
    ).catch((e) => console.error(`[catchup] card send failed: ${e.message}`));
  }
}

// ── Forward/Skip button callback ───────────────────────────────────────────────
async function handleCatchupCallback(ctx) {
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized.", { show_alert: true }).catch(() => {});
  const data = ctx.callbackQuery?.data || "";
  const m = data.match(/^catchup:(fwd|skip):(-?\d+):(\d+)$/);
  if (!m) return ctx.answerCbQuery("Bad callback.").catch(() => {});
  const [, action, chatIdStr, msgIdStr] = m;
  const chatId = Number(chatIdStr);
  const msgId  = Number(msgIdStr);

  if (action === "skip") {
    await ctx.answerCbQuery("Skipped").catch(() => {});
    await ctx.editMessageText("⏭️ *Skipped* — not forwarded.", { parse_mode: "Markdown" }).catch(() => {});
    return;
  }

  // Forward.
  await ctx.answerCbQuery("Processing…").catch(() => {});

  // Guard against double-processing (double-tap, or processed since the scan).
  const existing = await adBriefs.findBriefByTelegramMessage(chatId, msgId).catch(() => null);
  if (existing) {
    await ctx.editMessageText("⚠️ Already in the books (processed) — skipped to avoid a duplicate.", { parse_mode: "Markdown" }).catch(() => {});
    return;
  }

  // Re-read the brief + its preceding creatives, re-inject into the buffer.
  let around;
  try {
    around = await userClient.getMessagesBefore(chatId, msgId, WINDOW_BEFORE);
  } catch (err) {
    await ctx.editMessageText(`❌ Couldn't re-read history: ${err.message}`, { parse_mode: "Markdown" }).catch(() => {});
    return;
  }
  const briefRich = around.find((x) => x.message_id === msgId);
  if (!briefRich) {
    await ctx.editMessageText("❌ Brief no longer found in chat history (deleted?).", { parse_mode: "Markdown" }).catch(() => {});
    return;
  }

  // Only inject message_ids not already in the in-memory buffer (addMessage
  // pushes without in-memory dedupe — re-adding a present id would double-count
  // media in the bundle scanners).
  const present = new Set((getMessages(String(chatId)) || []).map((x) => x.message_id));
  let briefMsg = null;
  for (const rich of around) {
    const bufMsg = toBufferMsg(chatId, rich);
    if (rich.message_id === msgId) briefMsg = bufMsg;
    if (!present.has(rich.message_id)) addMessage(bufMsg);
  }
  if (!briefMsg) briefMsg = toBufferMsg(chatId, briefRich);

  // Run the normal pipeline. _isDeferredProcessing skips the 2-min defer gate;
  // handleAdMessage then forwards by message_id, writes sheets, and routes
  // ambiguous covers to the picker — exactly like a freshly-received brief.
  // chat.id = the SOURCE chat (forward-from + page lookups), but route any
  // handler replies to the card's chat (where /catchup was run, e.g.
  // Monetization) so recovery chatter stays out of the ads chat.
  const replyChatId = ctx.chat?.id || chatId;
  const { handleAdMessage } = require("./adHandler");
  const fakeCtx = {
    message:               briefMsg,
    chat:                  { id: chatId },
    from:                  briefMsg.from,
    telegram:              ctx.telegram,
    _isDeferredProcessing: true,
    reply: (text, extra) => ctx.telegram.sendMessage(replyChatId, text, extra),
  };
  try {
    await handleAdMessage(fakeCtx);
    await ctx.editMessageText("✅ *Forwarded / processed.* If it needed cover assignment, the picker was posted below.", { parse_mode: "Markdown" }).catch(() => {});
  } catch (err) {
    console.error(`[catchup] forward failed for ${chatId}/${msgId}: ${err.message}`);
    await ctx.editMessageText(`❌ Forward failed: ${err.message}`, { parse_mode: "Markdown" }).catch(() => {});
  }
}

module.exports = { handleCatchupCommand, handleCatchupCallback, toBufferMsg };
