#!/usr/bin/env node
/**
 * Tests which row `/update price` (and the legacy "price update" reply)
 * rewrites — lib/placementRows.js pickPlacementRow, used by
 * sheets.updatePlacementPrice and v2ledger.mirrorUpdatePlacementPrice. Pure
 * logic — no Sheets, Supabase or Telegram credentials needed:
 *
 *   node scripts/test-placement-rows.js
 *
 * Live check (Railway): see the PR description — post a scratch brief for a
 * client that already has an earlier placement on the same page, then
 * `/update price <link> @page $X` and confirm only the new row changed.
 */

const { pickPlacementRow, dateKeyOf, priceOf } = require("../lib/placementRows");

function assert(cond, msg) { console.log(cond ? "✅" : "❌", msg); if (!cond) process.exitCode = 1; }

const MASTER = { byPage: true };
const PAGE   = { byPage: false };
const DOM = "Dom @jetla.exe";

// Master tab: Dom on @goof three times (11/2, 11/4, 11/6), plus neighbours.
const master = [
  { row: 1,   client: "Client Name", page: "Page", date: "Date", price: "Ad Price" },
  { row: 800, client: DOM,     page: "@goof",  date: "Mon, 11/2/26", price: "$165" },
  { row: 806, client: DOM,     page: "@goof",  date: "Wed, 11/4/26", price: "$165" },
  { row: 811, client: "Other", page: "@goof",  date: "Fri, 11/6/26", price: "$100" },
  { row: 812, client: DOM,     page: "@goof",  date: "Fri, 11/6/26", price: "$165" },
  { row: 813, client: DOM,     page: "@moist", date: "Fri, 11/6/26", price: "$165" },
];
const brief = { client: DOM, page: "goof", date: "Fri, 11/6/26", oldPrice: "165" };

console.log("\n── master: stored row ──");
{
  const hit = pickPlacementRow(master, { ...brief, storedRow: 812 }, MASTER);
  assert(hit && hit.row === 812 && hit.via === "stored", "stored row 812 still holds Dom + @goof → only row 812");
  const stale = pickPlacementRow(master, { ...brief, storedRow: 811 }, MASTER);
  assert(stale && stale.row === 812 && stale.via === "date", "stored row now holds another client → client + date + page finds 812");
  const wrongPage = pickPlacementRow(master, { ...brief, storedRow: 813 }, MASTER);
  assert(wrongPage && wrongPage.row === 812, "stored row holds Dom on a different page → not used on the master");
  const gone = pickPlacementRow(master, { ...brief, storedRow: 9999 }, MASTER);
  assert(gone && gone.row === 812, "stored row past the end → date fallback");
}

console.log("\n── master: date fallback ──");
{
  const hit = pickPlacementRow(master, brief, MASTER);
  assert(hit && hit.row === 812, "no stored row → 11/6 row, never the 11/2 or 11/4 placements");
  const nov4 = pickPlacementRow(master, { ...brief, date: "11/4/2026" }, MASTER);
  assert(nov4 && nov4.row === 806, "brief dated 11/4 (4-digit year) → row 806");
  const caseSpace = pickPlacementRow(
    [{ row: 5, client: "  dom @JETLA.exe ", page: "@Goof", date: "11/6/26", price: 165 }], brief, MASTER);
  assert(caseSpace && caseSpace.row === 5, "client/page compare is case- and space-insensitive");
  assert(pickPlacementRow(master, { ...brief, date: "Sat, 11/7/26" }, MASTER) === null,
    "no row on the brief's date → nothing (no client-wide fallback)");
  assert(pickPlacementRow(master, { ...brief, date: null }, MASTER) === null,
    "no stored row and no date → nothing");
  assert(pickPlacementRow(master, { ...brief, client: "" , storedRow: 812 }, MASTER) === null,
    "no client → nothing, even with a stored row (the old path repriced the whole page)");
}

console.log("\n── master: two same-day rows ──");
{
  const twins = [
    { row: 700, client: DOM, page: "@goof", date: "11/6/26", price: "$250" },
    { row: 701, client: DOM, page: "@goof", date: "11/6/26", price: "$165" },
  ];
  assert(pickPlacementRow(twins, brief, MASTER).row === 701, "prefers the row still holding the old price ($165)");
  assert(pickPlacementRow(twins, { ...brief, oldPrice: null }, MASTER).row === 700, "no old price → first row");
  assert(pickPlacementRow(twins, { ...brief, oldPrice: 999 }, MASTER).row === 700, "old price matches neither → first row");
}

console.log("\n── page P/L (no page column) ──");
{
  const pl = [
    { row: 38, client: DOM,       date: "11/2/26", price: "$165" },
    { row: 39, client: "Someone", date: "11/6/26", price: "$100" },
    { row: 40, client: DOM,       date: "11/6/26", price: "$165" },
  ];
  assert(pickPlacementRow(pl, { ...brief, storedRow: 40 }, PAGE).row === 40, "stored row 40 holds Dom → row 40");
  assert(pickPlacementRow(pl, { ...brief, storedRow: 38 }, PAGE).row === 38,
    "stored row holds Dom (on another date, e.g. moved by Posted on) → still trusted, as in /auditprices");
  assert(pickPlacementRow(pl, { ...brief, storedRow: 39 }, PAGE).row === 40, "stored row holds someone else → client + date → 40");
  assert(pickPlacementRow(pl, brief, PAGE).row === 40, "page column ignored on the page P/L");
}

console.log("\n── v2 Ledger shape (numeric price, M/D/YYYY date) ──");
{
  const ledger = [
    { row: 3, client: DOM, page: "@goof", date: "11/2/2026", price: 165 },
    { row: 4, client: DOM, page: "@goof", date: "11/6/2026", price: 165 },
  ];
  assert(pickPlacementRow(ledger, { ...brief, storedRow: 4 }, MASTER).row === 4, "ledger_sheet_row honoured");
  assert(pickPlacementRow(ledger, brief, MASTER).row === 4, "ledger date fallback → 11/6 row only");
}

console.log("\n── typo page cells ──");
{
  const TYPOS = { hauntededfootage: "hauntedfootage" };
  const rows = [{ row: 5, client: DOM, page: "@hauntededfootage", date: "11/6/26", price: 165 }];
  const t = { ...brief, page: "hauntedfootage" };
  assert(pickPlacementRow(rows, t, MASTER) === null, "without a resolver a typo'd page cell doesn't match");
  assert(pickPlacementRow(rows, t, { byPage: true, resolve: (h) => TYPOS[h] || null }).row === 5,
    "with a resolver it does");
}

console.log("\n── helpers ──");
assert(dateKeyOf("Wed, 6/3/2026") === "6/3/26" && dateKeyOf("6/3/26") === "6/3/26" && dateKeyOf("Date") === null, "dateKeyOf");
assert(priceOf("$1,250.50") === 1250.5 && priceOf(165) === 165 && priceOf("") === null && priceOf("Ad Price") === null, "priceOf");

console.log(process.exitCode ? "\n❌ FAILURES" : "\n✅ all passed");
