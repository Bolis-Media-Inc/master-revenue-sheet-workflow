/**
 * checkMissedHandler.js — /checkmissed [days]: find ad briefs in the Internal
 * Network Ads chat that were never captured (not in the DB), and offer to WRITE
 * them into the books (master + per-page sheets + Ledger) with NO forwarding.
 *
 * Run in any admin chat (e.g. Monetization). It reads the source ads chat's
 * history via the user account, parses each message as a brief, diffs against
 * ad_briefs, and posts every missing one with an "➕ Add" button. Add re-runs
 * handleAdMessage in WRITE-ONLY mode (ctx._writeOnly) — sheets + Ledger + DB,
 * and it stops before any forwarding. Nothing gets re-posted anywhere.
 */
const userClient = require("../userClient");
const { parseAdMessage } = require("../parser");
const adBriefs = require("../lib/adBriefs");

// Primary ads source chat (Internal Network Ads). Same resolution as /catchup.
const DEFAULT_SOURCE_CHAT = (process.env.TARGET_CHAT_ID || "").split(",")[0].trim() || "-1001868750472";

function isAdmin(ctx) {
  const adminId = parseInt(process.env.WIZARD_ADMIN_USER_ID || "0", 10);
  return !adminId || ctx.from?.id === adminId;
}
const _md = (s) => String(s || "").replace(/[*_`\[]/g, (c) => "\\" + c);

// msgId -> { text, sourceChatId, date, t }. 1h TTL so the buttons survive a
// short delay but don't leak forever.
const _pending = new Map();
setInterval(() => { const cut = Date.now() - 3600000; for (const [k, v] of _pending) if (v.t < cut) _pending.delete(k); }, 300000).unref();

async function handleCheckMissedCommand(ctx) {
  if (!isAdmin(ctx)) return;
  const mm = (ctx.message?.text || "").trim().match(/^\/checkmissed(?:@\w+)?\s*(\d+)?/i);
  const days = Math.min(31, Math.max(1, mm && mm[1] ? parseInt(mm[1], 10) : 7));
  const sourceChatId = Number(DEFAULT_SOURCE_CHAT);

  const status = await ctx.reply(`🔎 Scanning the last ${days} day(s) of Internal Network Ads for briefs not in the books…`).catch(() => null);
  const setStatus = (t, md) => status
    ? ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, t, md ? { parse_mode: "Markdown" } : undefined).catch(() => {})
    : ctx.reply(t, md ? { parse_mode: "Markdown" } : undefined).catch(() => {});

  let window;
  try { window = await userClient.getHistoryWindow(sourceChatId, Date.now() - days * 86400000, 3000); }
  catch (err) { await setStatus(`❌ Couldn't read chat history: ${err.message}`); return; }

  const missed = [];
  for (const msg of window) {
    if (!msg.text || msg.kind) continue;                                   // briefs are text messages
    if (/^\/(catchup|checkmissed|replay|resolve|sync|center|sort|audit|update|editbrief|fixpage|bonus|clips)/i.test(msg.text.trim())) continue;
    let parsed;
    try { parsed = parseAdMessage(msg.text, new Date((msg.date || 0) * 1000)); } catch (_) { parsed = null; }
    const items = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
    if (!items.length || !items[0].client) continue;                        // not a brief
    const existing = await adBriefs.findBriefByTelegramMessage(sourceChatId, msg.message_id);
    if (existing) continue;                                                 // already captured
    const pages = [...new Set(items.map((p) => p.pageHandle).filter(Boolean))];
    const total = items.reduce((s, p) => s + (Number(p.adPrice) || 0), 0);
    missed.push({ message_id: msg.message_id, date: msg.date, client: items[0].client, pages, total, text: msg.text });
  }

  if (!missed.length) { await setStatus(`✅ No missed briefs in the last ${days} day(s) — everything in that chat is in the books.`); return; }

  await setStatus(`⚠️ *${missed.length} brief(s)* from the last ${days} day(s) are NOT in the books — tap ➕ to write each (no forwarding):`, true);
  for (const b of missed) {
    _pending.set(b.message_id, { text: b.text, sourceChatId, date: b.date, t: Date.now() });
    const snippet = (b.text.split("\n").find((l) => l.trim()) || "").slice(0, 80);
    await ctx.reply(
      `• *${_md(b.client)}* — ${b.pages.map((p) => "@" + p).join(", ") || "(no page)"} — $${b.total}\n_${_md(snippet)}_`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[
        { text: "➕ Add (no forward)", callback_data: `ckadd:${sourceChatId}:${b.message_id}` },
        { text: "⏭️ Skip",            callback_data: `ckskip:${b.message_id}` },
      ]] } },
    ).catch(() => {});
  }
}

async function handleCheckMissedCallback(ctx) {
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized").catch(() => {});
  const data = ctx.callbackQuery?.data || "";
  const skip = data.match(/^ckskip:(\d+)$/);
  if (skip) { _pending.delete(Number(skip[1])); await ctx.answerCbQuery("Skipped").catch(() => {}); await ctx.editMessageText("⏭️ Skipped — not written.").catch(() => {}); return; }

  const m = data.match(/^ckadd:(-?\d+):(\d+)$/);
  if (!m) return ctx.answerCbQuery().catch(() => {});
  const sourceChatId = Number(m[1]), msgId = Number(m[2]);
  const rec = _pending.get(msgId);
  if (!rec) return ctx.answerCbQuery("Expired — re-run /checkmissed", { show_alert: true }).catch(() => {});

  await ctx.answerCbQuery("Writing…").catch(() => {});
  try {
    const { handleAdMessage } = require("./adHandler");
    // Synthetic Telegraf ctx: enough for handleAdMessage to parse + write. The
    // ORIGINAL message date drives the brief's date; _writeOnly stops all forwarding.
    const fakeCtx = {
      message: { message_id: msgId, text: rec.text, chat: { id: sourceChatId }, from: { id: ctx.from?.id, username: ctx.from?.username }, date: rec.date || Math.floor(Date.now() / 1000) },
      chat: { id: sourceChatId },
      from: { id: ctx.from?.id },
      telegram: ctx.telegram,
      _isDeferredProcessing: true,
      _writeOnly: true,
      reply: (text, extra) => ctx.telegram.sendMessage(ctx.chat.id, text, extra),
    };
    await handleAdMessage(fakeCtx);
    _pending.delete(msgId);
    await ctx.editMessageText("✅ Written to the books — master + page sheet + Ledger. No forward.").catch(() => {});
  } catch (err) {
    console.error(`[checkmissed] add ${msgId}: ${err.message}`);
    await ctx.editMessageText(`❌ Write failed: ${err.message}`).catch(() => {});
  }
}

module.exports = { handleCheckMissedCommand, handleCheckMissedCallback };
