/**
 * lib/priceAudit.js — pure logic behind /auditprices.
 *
 * The Tracker writes a brief's prices once, after the 2-minute debounce. If
 * the brief is edited later in Telegram (e.g. "@goof - $165" → "$250"), the
 * sheets and DB keep the old price forever. /auditprices re-reads every brief
 * as it reads NOW and compares each page's price against the master sheet,
 * the page's own P/L and ad_brief_pages.page_price.
 *
 * Everything here is I/O-free (no Sheets, Supabase or Telegram) so
 * scripts/test-price-audit.js can exercise it without credentials. The handler
 * (handlers/auditPricesHandler.js) does the reads and calls into this.
 */

const { parseAdMessage } = require("../parser");

const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
const normHandle = (h) => norm(h).replace(/^@/, "");

/** "Wed, 6/3/26" / "6/3/2026" → "6/3/26" (same key as sheets.dateKeyOf). */
function dateKeyOf(s) {
  const m = String(s || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  let y = +m[3]; if (y < 100) y += 2000;
  return `${+m[1]}/${+m[2]}/${String(y).slice(-2)}`;
}

const samePrice = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.005;

/** "$250" / "$727.57"; null → "—". */
function fmtPrice(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  return "$" + (Number.isInteger(v) ? String(v) : v.toFixed(2));
}

/** Public t.me link for a message in a private supergroup (-100…). */
function tgLink(chatId, messageId) {
  return `https://t.me/c/${String(chatId).replace(/^-100/, "")}/${messageId}`;
}

/** Ready-to-paste fix — same syntax handlers/updateHandler.js parses. */
function updateCommand(link, page, price) {
  return `/update price ${link} @${page} ${fmtPrice(price)}`;
}

/**
 * Turn one Telegram message (as it reads now) + its DB brief into placements.
 *
 * @param {{message_id:number, date:number, text:string, edit_date?:number}} msg
 * @param {{client, date_posted, pages:[{page_handle, page_price, master_sheet_row, page_sheet_row}]}} dbBrief
 * @param {{chatId:number, resolve?:(h:string)=>string|null}} opts
 * @returns {{ placements: object[], added: string[], removed: string[] }}
 *   added   = pages in the brief now that have no ad_brief_pages row (page
 *             added by an edit — /update can't fix that, so it's listed apart)
 *   removed = ad_brief_pages rows whose page is no longer in the brief
 */
function extractPlacements(msg, dbBrief, opts = {}) {
  const resolve = (h) => normHandle((opts.resolve && opts.resolve(normHandle(h))) || h);
  const out = { placements: [], added: [], removed: [] };
  if (!msg?.text || !dbBrief) return out;

  let parsed;
  try { parsed = parseAdMessage(msg.text, new Date((msg.date || 0) * 1000)); } catch (_) { parsed = null; }
  const items = (Array.isArray(parsed) ? parsed : parsed ? [parsed] : []).filter((it) => it.pageHandle);
  if (!items.length) return out;

  const briefPrices = new Map(); // resolved page → price (first mention wins)
  for (const it of items) {
    const page = resolve(it.pageHandle);
    if (!briefPrices.has(page)) briefPrices.set(page, it.adPrice);
  }
  const dbPages = new Map();
  for (const p of dbBrief.pages || []) {
    const page = resolve(p.page_handle);
    if (!dbPages.has(page)) dbPages.set(page, p);
  }

  const clients   = [...new Set([norm(dbBrief.client), norm(items[0].client)].filter(Boolean))];
  const dateKeys  = [...new Set([dateKeyOf(dbBrief.date_posted), dateKeyOf(items[0].datePosted)].filter(Boolean))];
  const link      = tgLink(opts.chatId, msg.message_id);

  for (const [page, briefPrice] of briefPrices) {
    const db = dbPages.get(page);
    if (!db) { out.added.push(page); continue; }
    out.placements.push({
      messageId: msg.message_id,
      link,
      edited:    !!msg.edit_date,
      client:    dbBrief.client || items[0].client,
      clients,
      dateKeys,
      date:      dateKeys[0] || "",
      page,
      briefPrice,
      dbPrice:   db.page_price == null ? null : Number(db.page_price),
      masterRow: db.master_sheet_row || null,
      pageRow:   db.page_sheet_row || null,
    });
  }
  for (const page of dbPages.keys()) if (!briefPrices.has(page)) out.removed.push(page);
  return out;
}

/**
 * Pair each placement with one sheet row. Rows are { row, client, price,
 * mo, day, yr, page? } as returned by sheets.readMasterPlacements /
 * readPagePlacements.
 *
 *   1. The stored row number from ad_brief_pages, if that row still holds the
 *      same client (and page, on the master).
 *   2. Otherwise client + date (+ page on the master). When several rows
 *      share them, prefer the one whose price matches the brief, then the
 *      DB price, then the first.
 *
 * A row is claimed by at most one placement, so two same-day briefs for the
 * same client and page don't both land on the same row. Stored-row matches
 * are made for every placement before any fallback runs.
 *
 * @param {object[]} placements
 * @param {object[]} rows
 * @param {{ storedKey:"masterRow"|"pageRow", byPage:boolean, resolve?:Function }} opts
 * @returns {Map<object, object>} placement → row (unmatched placements absent)
 */
function matchRows(placements, rows, opts) {
  const resolve = (h) => normHandle((opts.resolve && opts.resolve(normHandle(h))) || h);
  const rowKey = rows.map((r) => ({
    r,
    client: norm(r.client),
    page:   opts.byPage ? resolve(r.page) : null,
    date:   r.dateKey || (r.mo ? `${r.mo}/${r.day}/${String(r.yr).slice(-2)}` : null),
  }));
  const byNum = new Map(rowKey.map((k) => [k.r.row, k]));
  const claimed = new Set();
  const out = new Map();
  const fits = (p, k) => p.clients.includes(k.client) && (!opts.byPage || k.page === p.page);

  for (const p of placements) {
    const k = byNum.get(p[opts.storedKey]);
    if (k && !claimed.has(k.r.row) && fits(p, k)) { claimed.add(k.r.row); out.set(p, k.r); }
  }
  for (const p of placements) {
    if (out.has(p)) continue;
    const cands = rowKey.filter((k) => !claimed.has(k.r.row) && fits(p, k) && p.dateKeys.includes(k.date));
    if (!cands.length) continue;
    const pick = cands.find((k) => samePrice(k.r.price, p.briefPrice))
              || cands.find((k) => samePrice(k.r.price, p.dbPrice))
              || cands[0];
    claimed.add(pick.r.row);
    out.set(p, pick.r);
  }
  return out;
}

/**
 * How many OTHER rows `/update price` would also rewrite for this placement.
 * updateAdPrice matches the master by client + page and the page P/L by client
 * alone — across every date — so a recurring client gets all its past rows
 * repriced. The handler surfaces this next to the suggested command.
 */
function collateralRows(p, rows, matched, opts) {
  const resolve = (h) => normHandle((opts.resolve && opts.resolve(normHandle(h))) || h);
  const client = norm(p.client);
  return rows.filter((r) => r !== matched && norm(r.client) === client
    && (!opts.byPage || resolve(r.page) === p.page)).length;
}

/**
 * Compare one placement's brief price against what the books hold.
 * `masterRow` / `pageRow` are the matched rows (or undefined if not found).
 * `collateral` = { master, page } counts from collateralRows.
 * Returns null when every value that was found agrees with the brief.
 */
function comparePlacement(p, masterRow, pageRow, collateral = {}) {
  const master = masterRow ? masterRow.price : null;
  const pl     = pageRow ? pageRow.price : null;
  const off = (v) => v != null && !samePrice(v, p.briefPrice);
  if (!off(p.dbPrice) && !off(master) && !off(pl)) return null;
  return {
    ...p,
    master, pl,
    masterFound: !!masterRow,
    pageFound:   !!pageRow,
    fix: updateCommand(p.link, p.page, p.briefPrice),
    collateral: (collateral.master || 0) + (collateral.page || 0),
  };
}

const _md = (s) => String(s || "").replace(/[*_`\[]/g, (c) => "\\" + c);

/** Telegram Markdown block for one mismatch. */
function formatMismatch(m) {
  const val = (v, found) => (found ? fmtPrice(v) : "not found");
  return [
    `• *@${_md(m.page)}* — ${_md(m.client)} — ${m.date}${m.edited ? " ✏️" : ""}`,
    `   brief *${fmtPrice(m.briefPrice)}* · master ${val(m.master, m.masterFound)} · page ${val(m.pl, m.pageFound)} · DB ${fmtPrice(m.dbPrice)}`,
    `   ${m.link}`,
    "   `" + m.fix + "`",
    ...(m.collateral ? [`   ⚠️ that also rewrites ${m.collateral} other ${_md(m.client)} row(s) on @${_md(m.page)} (other dates) — fix by hand`] : []),
  ].join("\n");
}

module.exports = {
  dateKeyOf, samePrice, fmtPrice, tgLink, updateCommand,
  extractPlacements, matchRows, collateralRows, comparePlacement, formatMismatch,
};
