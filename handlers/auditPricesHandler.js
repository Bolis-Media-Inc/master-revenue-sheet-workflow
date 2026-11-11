/**
 * auditPricesHandler.js — /auditprices [days]: compare every Internal Network
 * Ads brief's per-page price AS IT READS NOW in Telegram (edits included)
 * against the master sheet (col H), the page's P/L (col G) and
 * ad_brief_pages.page_price. READ-ONLY — reports mismatches with a t.me link
 * and a ready-to-paste `/update price` per mismatch; writes nothing.
 *
 * Why: the Tracker reads a brief once, after its 2-minute debounce. An edit
 * after that (e.g. "@goof - $165" → "$250") never reaches the books.
 *
 * Reads chat history through the user account (same path as /checkmissed and
 * /catchup). Briefs not in the DB are counted and left to /checkmissed. The
 * matching/comparison logic lives in lib/priceAudit.js (tested by
 * scripts/test-price-audit.js).
 */
const userClient = require("../userClient");
const adBriefs = require("../lib/adBriefs");
const pagesRegistry = require("../lib/pages");
const { readMasterPlacements, readPagePlacements } = require("../sheets");
const audit = require("../lib/priceAudit");
const { parseAdMessage } = require("../parser");

const DEFAULT_SOURCE_CHAT = (process.env.TARGET_CHAT_ID || "").split(",")[0].trim() || "-1001868750472";
const MASTER_SHEET_ID = process.env.MASTER_SHEET_ID;
const TAB_NAME        = process.env.SHEET_TAB_NAME      || "2026 Ad Overview";
const PAGE_TAB_NAME   = process.env.PAGE_SHEET_TAB_NAME || "IG Revenue Tracker";
const PLACEHOLDER_PATTERN = /^(SHEET_ID_|TELEGRAM_CHAT_ID_)/;

function isAdmin(ctx) {
  const adminId = parseInt(process.env.WIZARD_ADMIN_USER_ID || "0", 10);
  return !adminId || ctx.from?.id === adminId;
}
const _md = (s) => String(s || "").replace(/[*_`\[]/g, (c) => "\\" + c);
const resolve = (h) => pagesRegistry.resolveHandle(h);

async function handleAuditPricesCommand(ctx) {
  if (!isAdmin(ctx)) return;
  const mm = (ctx.message?.text || "").trim().match(/^\/auditprices(?:@\w+)?\s*(\d+)?/i);
  const days = Math.min(120, Math.max(1, mm && mm[1] ? parseInt(mm[1], 10) : 30));
  const sourceChatId = Number(DEFAULT_SOURCE_CHAT);

  const status = await ctx.reply(`🔎 Reading the last ${days} day(s) of Internal Network Ads as they read now…`).catch(() => null);
  const setStatus = (t) => status
    ? ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, t, { parse_mode: "Markdown", disable_web_page_preview: true }).catch(() => {})
    : ctx.reply(t, { parse_mode: "Markdown", disable_web_page_preview: true }).catch(() => {});

  // ── 1. Briefs as they read now ────────────────────────────────────────────
  let window;
  try { window = await userClient.getHistoryWindow(sourceChatId, Date.now() - days * 86400000, Math.max(3000, days * 300)); }
  catch (err) { await setStatus(`❌ Couldn't read chat history: ${_md(err.message)}`); return; }
  const msgs = window.filter((m) => m.text && !m.kind && !/^\/[a-z]/i.test(m.text.trim()));

  let dbBriefs;
  try { dbBriefs = await adBriefs.findBriefsWithPagesByMessages(sourceChatId, msgs.map((m) => m.message_id)); }
  catch (err) { await setStatus(`❌ Couldn't read ad_briefs: ${_md(err.message)}`); return; }

  const placements = [];
  const pageChanges = [];   // pages added/removed by an edit — /update price can't fix those
  let notInDb = 0;
  for (const m of msgs) {
    const brief = dbBriefs.get(m.message_id);
    if (!brief) {           // not in the books → /checkmissed's job; just count real briefs
      let parsed; try { parsed = parseAdMessage(m.text, new Date((m.date || 0) * 1000)); } catch (_) { parsed = null; }
      if ((Array.isArray(parsed) ? parsed[0] : parsed)?.client) notInDb++;
      continue;
    }
    const res = audit.extractPlacements(m, brief, { chatId: sourceChatId, resolve });
    placements.push(...res.placements);
    if (res.added.length || res.removed.length) {
      pageChanges.push({ client: brief.client, link: audit.tgLink(sourceChatId, m.message_id), ...res });
    }
  }
  if (!placements.length) { await setStatus(`ℹ️ No briefs from the last ${days} day(s) are in the DB — nothing to compare.`); return; }

  // ── 2. Master sheet ───────────────────────────────────────────────────────
  await setStatus(`📄 ${placements.length} placement(s) across ${dbBriefs.size} brief(s). Reading the master sheet…`);
  let masterRows;
  try { masterRows = await readMasterPlacements(MASTER_SHEET_ID, TAB_NAME); }
  catch (err) { await setStatus(`❌ Couldn't read master sheet: ${_md(err.message)}`); return; }
  const masterOpts = { storedKey: "masterRow", byPage: true, resolve };
  const masterMatch = audit.matchRows(placements, masterRows, masterOpts);

  // ── 3. Page P/L sheets — one read per sheet ───────────────────────────────
  const bySheet = new Map();
  let noSheet = 0;
  for (const p of placements) {
    const sid = pagesRegistry.getSheetId(p.page);
    if (!sid || PLACEHOLDER_PATTERN.test(sid)) { noSheet++; continue; }
    if (!bySheet.has(sid)) bySheet.set(sid, []);
    bySheet.get(sid).push(p);
  }
  await setStatus(`📄 Reading ${bySheet.size} page P/L sheet(s)…`);
  const pageMatch = new Map();
  const pageCollateral = new Map();
  let failedSheets = 0;
  for (const [sid, ps] of bySheet) {
    let rows;
    try { rows = await readPagePlacements(sid, PAGE_TAB_NAME); }
    catch (err) { failedSheets++; console.error(`[auditprices] P/L read ${sid}: ${err.message}`); continue; }
    const pageOpts = { storedKey: "pageRow", byPage: false };
    for (const [p, r] of audit.matchRows(ps, rows, pageOpts)) pageMatch.set(p, r);
    for (const p of ps) pageCollateral.set(p, audit.collateralRows(p, rows, pageMatch.get(p), pageOpts));
  }

  // ── 4. Compare ────────────────────────────────────────────────────────────
  const mismatches = [];
  let masterMissing = 0, pageMissing = 0;
  for (const p of placements) {
    const mr = masterMatch.get(p), pr = pageMatch.get(p);
    if (!mr) masterMissing++;
    if (!pr) pageMissing++;
    const diff = audit.comparePlacement(p, mr, pr, {
      master: audit.collateralRows(p, masterRows, mr, masterOpts),
      page:   pageCollateral.get(p) || 0,
    });
    if (diff) mismatches.push(diff);
  }

  // ── 5. Report ─────────────────────────────────────────────────────────────
  const lines = [`💲 *Price audit — last ${days} day(s)* (brief as it reads now = truth)`];
  if (!mismatches.length) lines.push(``, `✅ No price mismatches across ${placements.length} placement(s).`);
  else {
    lines.push(`_${mismatches.length} mismatch(es). ✏️ = brief was edited after posting. Paste the command to fix DB + master + page + Ledger._`, ``);
    for (const m of mismatches) lines.push(audit.formatMismatch(m), ``);
  }
  if (pageChanges.length) {
    lines.push(`*Page list changed in the brief* (not fixable with /update price):`);
    for (const c of pageChanges) {
      const bits = [
        c.added.length ? `added ${c.added.map((h) => "@" + _md(h)).join(" ")}` : "",
        c.removed.length ? `removed ${c.removed.map((h) => "@" + _md(h)).join(" ")}` : "",
      ].filter(Boolean).join(" · ");
      lines.push(`• ${_md(c.client)} — ${bits}\n   ${c.link}`);
    }
    lines.push(``);
  }
  lines.push(
    `_Checked ${placements.length} placement(s) in ${dbBriefs.size} brief(s). ` +
    `No row found: master ${masterMissing} · page ${pageMissing}` +
    (noSheet ? ` · ${noSheet} with no P/L sheet` : "") +
    (failedSheets ? ` · ${failedSheets} P/L sheet(s) unreadable` : "") +
    ` (those are price-checked against what was found). ` +
    (notInDb ? `${notInDb} brief(s) in the chat aren't in the DB — run /checkmissed.` : "") + `_`,
  );

  // Telegram caps messages at ~4096 chars; chunk on line boundaries.
  const full = lines.join("\n");
  if (full.length <= 3900) { await setStatus(full); return; }
  await setStatus(`${lines[0]}\n_${mismatches.length} mismatch(es) — sending in parts…_`);
  let buf = [];
  const flush = async () => { if (buf.length) { await ctx.reply(buf.join("\n"), { parse_mode: "Markdown", disable_web_page_preview: true }).catch(() => {}); buf = []; } };
  for (const ln of lines.slice(1)) { if (buf.join("\n").length + ln.length > 3900) await flush(); buf.push(ln); }
  await flush();
}

module.exports = { handleAuditPricesCommand };
