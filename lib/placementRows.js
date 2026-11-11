/**
 * lib/placementRows.js
 * Pure row-picking for edits that target ONE placement (one brief on one page)
 * — no I/O, no requires, so scripts/test-placement-rows.js can exercise it
 * without Sheets or Supabase credentials.
 *
 * Why this exists: `/update price` used to rewrite every master row with the
 * same client + page, and every page-P/L row with the same client, across all
 * dates. Repricing one placement for a recurring client (Dom @jetla.exe on
 * @goof) silently repriced all of its past placements too. pickPlacementRow
 * finds the single row that belongs to the brief instead.
 *
 * Same matching rules as lib/priceAudit.js matchRows (/auditprices), for one
 * placement at a time.
 */

const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
const normPage = (h) => norm(h).replace(/^@+/, "");

/** "Wed, 6/3/26" / "6/3/2026" → "6/3/26" (null if unparseable). */
function dateKeyOf(s) {
  const m = String(s || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  let y = +m[3]; if (y < 100) y += 2000;
  return `${+m[1]}/${+m[2]}/${String(y).slice(-2)}`;
}

/** "$1,250.50" / 165 / "165" → number (null if blank / not a price). */
function priceOf(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

const samePrice = (a, b) => a != null && b != null && Math.abs(a - b) < 0.005;

/**
 * Pick the one sheet row that holds this placement.
 *
 *   1. `storedRow` (ad_brief_pages.master_sheet_row / page_sheet_row /
 *      ledger_sheet_row) if that row still holds the same client — and the
 *      same page, when `byPage`.
 *   2. Otherwise client + date (+ page when `byPage`). When several rows share
 *      them, prefer the one still holding `oldPrice`, then the first.
 *   3. Otherwise nothing. Never falls back to client-wide: a row we can't pin
 *      down is reported, not guessed at.
 *
 * @param {Array<{row:number, client:any, page?:any, date:any, price?:any}>} rows
 *        One entry per sheet row (1-indexed `row`), as read from the tab.
 * @param {{client:string, page?:string, date?:string, storedRow?:number, oldPrice?:any}} target
 * @param {{byPage?:boolean, resolve?:(h:string)=>string|null}} [opts]
 *        resolve maps a typo'd page cell to its registry handle.
 * @returns {{row:number, via:"stored"|"date"} | null}
 */
function pickPlacementRow(rows, target, opts = {}) {
  const resolve = (h) => normPage((opts.resolve && opts.resolve(normPage(h))) || h);
  const client = norm(target.client);
  if (!client) return null;
  const page = opts.byPage ? resolve(target.page) : null;
  const fits = (r) => norm(r.client) === client && (!opts.byPage || resolve(r.page) === page);

  const stored = Number(target.storedRow) > 0 ? rows.find((r) => r.row === Number(target.storedRow)) : null;
  if (stored && fits(stored)) return { row: stored.row, via: "stored" };

  const date = dateKeyOf(target.date);
  if (!date) return null;
  const cands = rows.filter((r) => fits(r) && dateKeyOf(r.date) === date);
  if (!cands.length) return null;
  const old = priceOf(target.oldPrice);
  const pick = cands.find((r) => samePrice(priceOf(r.price), old)) || cands[0];
  return { row: pick.row, via: "date" };
}

module.exports = { dateKeyOf, priceOf, pickPlacementRow };
