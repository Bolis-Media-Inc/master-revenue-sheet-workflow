/**
 * v2ledger.js — MIRROR the bot's revenue writes into the v2 "Portfolio P/L" workbook's Ledger tab.
 *
 * This is a strictly ADDITIVE, FAIL-OPEN mirror alongside the existing master-sheet writes. Every
 * function here is wrapped so any error is logged and swallowed — a mirror hiccup can NEVER break the
 * bot's master/page/DB writes. Enabled only when V2_LEDGER_ID is set; a no-op otherwise.
 *
 * It reuses sheets.js's authenticated + rate-limited client and its appendRow helper (require'd lazily
 * to avoid a circular-require race; sheets.js require's THIS module lazily too).
 *
 * v2 Ledger columns (A–P):
 *   A ID · B Client · C Ad Type · D Campaign · E Instance · F Clipping?(bool) · G Date · H Time ·
 *   I Page · J Price · K Status · L Month(yyyy-mm text) · M Post Type · N Post Duration · O Source · P Clip Status
 *
 * Master "2026 Ad Overview" columns (A–K), as passed to appendRow:
 *   A Forwarded · B Client · C Ad Type · D Date · E Time · F Page · G Bulk# · H Price · I Status · J Views · K NIF
 */

const LEDGER_TAB = "Ledger";
const DAY_DIVIDER_MARK = "​"; // zero-width space used by sheets.js day dividers — never mirror these

function enabled() { return !!process.env.V2_LEDGER_ID; }
function v2Id()    { return process.env.V2_LEDGER_ID; }

// ── small parsers ────────────────────────────────────────────────────────────
function parsePrice(raw) {
  if (raw == null) return 0;
  const s = String(raw).replace(/[$,\s]/g, "");
  if (s === "") return 0;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}
// "Thu 3/5/26" / "3/5/2026" → { dateStr:"3/5/2026", ym:"2026-03" }, or null
function parseDate(raw) {
  const m = String(raw || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  const mo = +m[1], d = +m[2];
  let y = +m[3]; if (y < 100) y += 2000;
  return { dateStr: `${mo}/${d}/${y}`, ym: `${y}-${String(mo).padStart(2, "0")}` };
}
const normPage   = (h) => `@${String(h || "").toLowerCase().replace(/^@+/, "")}`;
const normClient = (c) => String(c || "").trim().toLowerCase();

// Map a master A–K row array → a v2 A–P row array. Returns null for non-placement rows.
function mapMasterRowToV2(mr) {
  const client = String(mr[1] || "").trim();
  if (!client || client === DAY_DIVIDER_MARK || /undistributed/i.test(client)) return null; // divider / special
  const adType   = mr[2] || "";
  const dateText = mr[3] || "";
  const time     = mr[4] || "";
  const page     = normPage(mr[5]);
  const bulk     = mr[6] || "";
  const price    = parsePrice(mr[7]);
  const status   = mr[8] || "";
  const nif      = mr[10] || "";
  const isClip   = price === 0;
  const d        = parseDate(dateText);
  return [
    "",                             // A ID (mutations match by content, so a stable id isn't needed)
    client,                         // B Client
    adType,                         // C Ad Type
    client,                         // D Campaign (= client, matches the prior pull convention)
    bulk,                           // E Instance (Bulk #)
    isClip,                         // F Clipping? (boolean)
    d ? d.dateStr : dateText,       // G Date (clean m/d/yyyy so USER_ENTERED coerces to a real date)
    time,                           // H Time
    page,                           // I Page
    price,                          // J Price
    status,                         // K Status
    d ? d.ym : "",                  // L Month (yyyy-mm; col preformatted '@' in the Ledger → stays text)
    "",                             // M Post Type (master doesn't carry it)
    nif,                            // N Post Duration (NIF)
    "Bot",                          // O Source
    isClip ? "Unattributed" : "",   // P Clip Status ($0 clips flow into the workbench)
  ];
}

// ── mirror: APPEND ───────────────────────────────────────────────────────────
async function mirrorAppend(masterRow) {
  if (!enabled()) return;
  try {
    const v2Row = mapMasterRowToV2(masterRow);
    if (!v2Row) return;
    const { appendRow } = require("./sheets");
    await appendRow(v2Id(), LEDGER_TAB, v2Row, { anchorColumn: "B", endColumn: "P" });
  } catch (err) {
    console.error(`[v2ledger] mirrorAppend (non-fatal): ${err.message}`);
  }
}

// ── shared matcher: read A:P, return {rows, indicesMatching} ──────────────────
async function _matchRows(pageHandles, clientName, opts = {}) {
  const { sheetsClient } = require("./sheets");
  const sheets = await sheetsClient();
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: v2Id(), range: `${LEDGER_TAB}!A:P` });
  const rows = resp.data.values || [];
  const pages = (pageHandles || []).map(normPage);
  const wantClient = clientName != null ? normClient(clientName) : null;
  const wantDate = opts.dateFilter ? (parseDate(opts.dateFilter) || {}).dateStr : null;
  const dnorm = (s) => { const p = parseDate(s); return p ? p.dateStr : null; };
  const matches = [];
  for (let i = 2; i < rows.length; i++) {                 // skip title(1)+header(2)
    const r = rows[i];
    const pageCell   = normPage(r[8]);                    // I
    const clientCell = normClient(r[1]);                  // B
    const dateCell   = dnorm(r[6]);                       // G
    const pageOk   = pages.length === 0 || pages.includes(pageCell);
    const clientOk = wantClient == null || clientCell === wantClient;
    const dateOk   = !wantDate || dateCell === wantDate;
    if (pageOk && clientOk && dateOk && clientCell) matches.push(i + 1); // 1-indexed row
  }
  return matches;
}

async function _batchWrite(updates) {
  if (!updates.length) return 0;
  const { sheetsClient } = require("./sheets");
  const sheets = await sheetsClient();
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: v2Id(),
    requestBody: { valueInputOption: "USER_ENTERED", data: updates },
  });
  return updates.length;
}

// ── mirror: PRICE (col J) ─────────────────────────────────────────────────────
async function mirrorUpdatePrice(pageHandles, clientName, newPrice) {
  if (!enabled()) return;
  try {
    const price = parsePrice(newPrice);
    const rows = await _matchRows(pageHandles, clientName);
    await _batchWrite(rows.map((row) => ({ range: `${LEDGER_TAB}!J${row}`, values: [[price]] })));
  } catch (err) { console.error(`[v2ledger] mirrorUpdatePrice (non-fatal): ${err.message}`); }
}

// ── mirror: CLIENT rename (cols B + D) ────────────────────────────────────────
async function mirrorUpdateClient(pageHandles, oldClient, newClient) {
  if (!enabled()) return;
  try {
    const rows = await _matchRows(pageHandles, oldClient);
    const updates = [];
    rows.forEach((row) => {
      updates.push({ range: `${LEDGER_TAB}!B${row}`, values: [[newClient]] });
      updates.push({ range: `${LEDGER_TAB}!D${row}`, values: [[newClient]] }); // campaign tracks client
    });
    await _batchWrite(updates);
  } catch (err) { console.error(`[v2ledger] mirrorUpdateClient (non-fatal): ${err.message}`); }
}

// ── mirror: DATE (col G) + recompute Month (col L) ────────────────────────────
async function mirrorUpdateDate(pageHandles, clientName, newDate) {
  if (!enabled()) return;
  try {
    const d = parseDate(newDate);
    const rows = await _matchRows(pageHandles, clientName);
    const updates = [];
    rows.forEach((row) => {
      updates.push({ range: `${LEDGER_TAB}!G${row}`, values: [[d ? d.dateStr : newDate]] });
      if (d) updates.push({ range: `${LEDGER_TAB}!L${row}`, values: [[d.ym]] });
    });
    await _batchWrite(updates);
  } catch (err) { console.error(`[v2ledger] mirrorUpdateDate (non-fatal): ${err.message}`); }
}

// ── mirror: STATUS → Live (col K) ─────────────────────────────────────────────
async function mirrorUpdateStatusToLive(pageHandles, clientName) {
  if (!enabled()) return;
  try {
    const rows = await _matchRows(pageHandles, clientName);
    await _batchWrite(rows.map((row) => ({ range: `${LEDGER_TAB}!K${row}`, values: [["Live"]] })));
  } catch (err) { console.error(`[v2ledger] mirrorUpdateStatusToLive (non-fatal): ${err.message}`); }
}

// ── mirror: DELETE rows (match page+client, optional dateFilter) ──────────────
async function mirrorDelete(pageHandles, clientName, opts = {}) {
  if (!enabled()) return;
  try {
    const rows = await _matchRows(pageHandles, clientName, opts);
    if (!rows.length) return;
    const { sheetsClient } = require("./sheets");
    const sheets = await sheetsClient();
    const meta = await sheets.spreadsheets.get({ spreadsheetId: v2Id() });
    const sheet = meta.data.sheets?.find((s) => s.properties.title === LEDGER_TAB);
    if (!sheet) return;
    const sheetId = sheet.properties.sheetId;
    const uniq = [...new Set(rows)].sort((a, b) => b - a); // bottom-up
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: v2Id(),
      requestBody: { requests: uniq.map((rn) => ({
        deleteDimension: { range: { sheetId, dimension: "ROWS", startIndex: rn - 1, endIndex: rn } },
      })) },
    });
  } catch (err) { console.error(`[v2ledger] mirrorDelete (non-fatal): ${err.message}`); }
}

module.exports = {
  enabled, mapMasterRowToV2,
  mirrorAppend, mirrorUpdatePrice, mirrorUpdateClient, mirrorUpdateDate, mirrorUpdateStatusToLive, mirrorDelete,
};
