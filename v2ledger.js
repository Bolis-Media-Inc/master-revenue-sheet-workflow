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
// Post Duration must be a real duration (Permanent/24hr/…), NOT a NIF timing — the master's NIF value
// isn't valid for the Ledger's dropdown (shows a red flag). Drop anything NIF-ish → blank.
const cleanDur_  = (v) => { v = String(v || "").trim(); return /nif/i.test(v) ? "" : v; };
// Synthetic Placement ID for bot-written rows (col A is cosmetic — mutations match by page+client).
function placementId_(page, dateStr) {
  return `BOT-${String(page || "").replace(/^@/, "")}-${String(dateStr || "").replace(/\//g, "")}`;
}

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
    placementId_(page, d ? d.dateStr : dateText),  // A ID (synthetic; mutations match by content anyway)
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
    "",                             // M Post Type (not on the master tab — filled via the parsed item)
    cleanDur_(nif),                 // N Post Duration (NIF-ish → blank; master has no real duration)
    "Bot",                          // O Source
    isClip ? "Unattributed" : "",   // P Clip Status ($0 clips flow into the workbench)
  ];
}

// Map the RICH parsed brief item (what buildRow/buildPageRow receive) → v2 A–P row. This has Post Type
// and Post Duration, which the master sheet row lacks — so bot-written rows come out fully populated.
function mapParsedToV2(p) {
  const client = String(p.client || "").trim();
  if (!client) return null;
  const price  = (typeof p.adPrice === "number") ? p.adPrice : parsePrice(p.adPrice);
  const isClip = price === 0;
  const page   = normPage(p.pageHandle);
  const d      = parseDate(p.datePosted);
  return [
    placementId_(page, d ? d.dateStr : p.datePosted),  // A ID
    client,                                  // B Client
    p.category || "",                        // C Ad Type
    client,                                  // D Campaign
    p.bulkNum || "",                         // E Instance
    isClip,                                  // F Clipping?
    d ? d.dateStr : (p.datePosted || ""),    // G Date
    p.timeMST || "",                         // H Time
    page,                                    // I Page
    price,                                   // J Price
    p.status || "",                          // K Status
    d ? d.ym : "",                           // L Month
    p.postType || "",                        // M Post Type
    cleanDur_(p.postDuration),               // N Post Duration (real duration only — no NIF)
    "Bot",                                   // O Source
    isClip ? "Unattributed" : "",            // P Clip Status
  ];
}

// ── mirror: APPEND ───────────────────────────────────────────────────────────
// Returns the 1-indexed Ledger row it wrote (or null). The caller (sheets.js
// appendRow) surfaces this so it can be persisted to ad_brief_pages.ledger_sheet_row
// — the key that lets /remove delete THIS exact row later, the same way
// master_sheet_row makes the master takedown precise.
async function mirrorAppend(masterRow, rich) {
  if (!enabled()) return null;
  try {
    // Prefer the rich parsed item (has Post Type / Duration); fall back to the master row.
    const v2Row = rich ? mapParsedToV2(rich) : mapMasterRowToV2(masterRow);
    if (!v2Row) return null;
    const { appendRow } = require("./sheets");
    // appendRow returns the row number it wrote (mirror is not re-fired: the
    // Ledger id !== MASTER_SHEET_ID, so no recursion).
    return await appendRow(v2Id(), LEDGER_TAB, v2Row, { anchorColumn: "B", endColumn: "P" });
  } catch (err) {
    console.error(`[v2ledger] mirrorAppend (non-fatal): ${err.message}`);
    return null;
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
async function mirrorUpdateDate(pageHandles, clientName, newDate, matchDate) {
  if (!enabled()) return;
  try {
    const d = parseDate(newDate);
    // matchDate (optional): only repin Ledger rows currently on that date — the
    // surgical "Posted on" path, so one placement moves, not the whole client.
    const rows = await _matchRows(pageHandles, clientName, matchDate ? { dateFilter: matchDate } : {});
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

// ── mirror: DELETE exact rows (PRECISE — row + content verified) ─────────────
// The parallel to the master takedown: delete specific Ledger row numbers, each
// verified against its expected client/date/page before removal. Because it
// targets a KNOWN row (ad_brief_pages.ledger_sheet_row), an identical same-day
// twin — which lives on a DIFFERENT Ledger row — is never matched, so it can't
// be collaterally deleted. A row whose content no longer matches (the Ledger was
// re-sorted / rows shifted) is REPORTED as stale, never force-deleted.
// `items`: [{ row, client, date, page }].
async function mirrorDeleteRows(items) {
  if (!enabled()) return { deleted: 0, stale: [] };
  try {
    const wanted = (items || []).filter((it) => it && Number(it.row) > 0);
    if (!wanted.length) return { deleted: 0, stale: [] };
    const { sheetsClient } = require("./sheets");
    const sheets = await sheetsClient();
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: v2Id(), range: `${LEDGER_TAB}!A:P` });
    const rows = resp.data.values || [];
    const dnorm = (s) => { const p = parseDate(s); return p ? p.dateStr : null; };
    const verified = [], stale = [];
    for (const it of wanted) {
      const r = rows[Number(it.row) - 1];                                          // 1-indexed
      if (!r) { stale.push({ row: it.row, found: "(out of range)" }); continue; }
      const okClient = it.client == null || normClient(r[1]) === normClient(it.client);   // B Client
      const okDate   = it.date   == null || dnorm(r[6]) === dnorm(it.date);               // G Date
      const okPage   = it.page   == null || normPage(r[8]) === normPage(it.page);          // I Page
      if (okClient && okDate && okPage) verified.push(Number(it.row));
      else stale.push({ row: it.row, found: `${r[1] || "?"} | ${dnorm(r[6]) || "?"} | ${r[8] || "?"}` });
    }
    if (!verified.length) return { deleted: 0, stale };
    const meta = await sheets.spreadsheets.get({ spreadsheetId: v2Id() });
    const sheet = meta.data.sheets?.find((s) => s.properties.title === LEDGER_TAB);
    if (!sheet) return { deleted: 0, stale };
    const sheetId = sheet.properties.sheetId;
    const uniq = [...new Set(verified)].sort((a, b) => b - a);                     // bottom-up
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: v2Id(),
      requestBody: { requests: uniq.map((rn) => ({
        deleteDimension: { range: { sheetId, dimension: "ROWS", startIndex: rn - 1, endIndex: rn } },
      })) },
    });
    return { deleted: uniq.length, stale };
  } catch (err) {
    console.error(`[v2ledger] mirrorDeleteRows (non-fatal): ${err.message}`);
    return { deleted: 0, stale: [] };
  }
}

// ── mirror: DELETE rows (match page+client, optional dateFilter) ──────────────
// Content-match delete — used for client-wide / date-wide takedowns (deleteAdRows)
// and as the LEGACY fallback for rows written before ledger_sheet_row existed.
// Not precise against identical same-day twins; prefer mirrorDeleteRows when a
// known Ledger row is available.
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
  enabled, mapMasterRowToV2, mapParsedToV2,
  mirrorAppend, mirrorUpdatePrice, mirrorUpdateClient, mirrorUpdateDate, mirrorUpdateStatusToLive, mirrorDelete, mirrorDeleteRows,
};
