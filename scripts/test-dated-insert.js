#!/usr/bin/env node
/**
 * Tests where insertRowByDate puts a row (lib/datedInsert.js planDatedInsert)
 * and how held row numbers follow later inserts (rebaseRow). Pure logic — no
 * Sheets or Supabase credentials needed:
 *
 *   node scripts/test-dated-insert.js
 *
 * Live check (Railway shell, writes to a SCRATCH copy of a sheet — never the
 * real master): set TEST_SHEET_ID to a copied spreadsheet the service account
 * can edit, then
 *
 *   TEST_SHEET_ID=... node scripts/test-dated-insert.js --live
 *
 * It writes a late row into the copy's "2026 Ad Overview" tab with dividers on
 * and prints the row it landed on so you can eyeball the section in the sheet.
 * Stored-row shifting only runs for the real MASTER_SHEET_ID / page sheets, so
 * a scratch copy never touches Supabase.
 */

const { DAY_DIVIDER_MARK: D, planDatedInsert, rebaseRow, dateKey } = require("../lib/datedInsert");

function assert(cond, msg) { console.log(cond ? "✅" : "❌", msg); if (!cond) process.exitCode = 1; }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Master layout: header, day 10/20 (2 rows), divider, 10/22 (2 rows), divider, 10/30 (1 row)
const master = [
  { anchor: "Client Name", date: "Date" },   // 1
  { anchor: "Acme",  date: "Tue, 10/20/26" }, // 2
  { anchor: "Bolt",  date: "Tue, 10/20/26" }, // 3
  { anchor: D,       date: "" },              // 4
  { anchor: "Cora",  date: "Thu, 10/22/26" }, // 5
  { anchor: "Dune",  date: "Thu, 10/22/26" }, // 6
  { anchor: D,       date: "" },              // 7
  { anchor: "Echo",  date: "Fri, 10/30/26" }, // 8
];
const M = { dayDividers: true };

console.log("\n── Date keys ──");
assert(dateKey("Wed, 10/21/26") === 20261021, "master format parses");
assert(dateKey("Wed 10/21/26") === 20261021, "page format parses");
assert(dateKey("10/21/2026") === 20261021, "4-digit year parses");
assert(dateKey("Date") === null, "header → null");

console.log("\n── Master: cheap path ──");
let p = planDatedInsert(master, "Fri, 10/30/26", M);
assert(p.mode === "append" && p.startRow === 9 && eq(p.kinds, ["data"]), "same day as last row → append, no divider");
p = planDatedInsert(master, "Mon, 11/2/26", M);
assert(p.mode === "append" && p.startRow === 9 && eq(p.kinds, ["divider", "data"]) && p.dataRow === 10, "new day → divider + append");
p = planDatedInsert([...master, { anchor: D, date: "" }], "Mon, 11/2/26", M);
assert(p.mode === "append" && eq(p.kinds, ["data"]) && p.startRow === 10, "last row already a divider → no double divider");
p = planDatedInsert(master, "garbage", M);
assert(p.mode === "append" && eq(p.kinds, ["data"]), "unparseable date → plain append");
p = planDatedInsert([master[0]], "Mon, 11/2/26", M);
assert(p.mode === "append" && p.startRow === 2 && eq(p.kinds, ["data"]), "no dated rows yet → append, no divider before day 1");

console.log("\n── Master: late rows ──");
p = planDatedInsert(master, "Thu, 10/22/26", M);
assert(p.mode === "insert" && p.startRow === 7 && eq(p.kinds, ["data"]), "10/22 → below last 10/22 row (6), above the 10/30 divider");
p = planDatedInsert(master, "Tue, 10/20/26", M);
assert(p.mode === "insert" && p.startRow === 4 && eq(p.kinds, ["data"]), "10/20 → row 4, above the 10/22 divider");
p = planDatedInsert(master, "Wed, 10/21/26", M);
assert(p.mode === "insert" && p.startRow === 4 && eq(p.kinds, ["divider", "data"]) && p.dataRow === 5,
  "10/21 (no section) → [divider, row] below 10/20; existing 10/22 divider closes it");
p = planDatedInsert(master, "Mon, 10/26/26", M);
assert(p.mode === "insert" && p.startRow === 7 && eq(p.kinds, ["divider", "data"]) && p.dataRow === 8,
  "10/26 (no section) → between 10/22 and the 10/30 divider");
p = planDatedInsert(master, "Mon, 10/19/26", M);
assert(p.mode === "insert" && p.startRow === 2 && eq(p.kinds, ["data", "divider"]) && p.dataRow === 2,
  "before everything → above first dated row, divider after it");

// No divider between days → add one on both sides
const noDiv = [
  { anchor: "Client Name", date: "Date" },
  { anchor: "Acme", date: "Tue, 10/20/26" },
  { anchor: "Cora", date: "Thu, 10/22/26" },
];
p = planDatedInsert(noDiv, "Wed, 10/21/26", M);
assert(eq(p.kinds, ["divider", "data", "divider"]) && p.startRow === 3 && p.dataRow === 4,
  "missing day with no divider below → divider on both sides");

console.log("\n── Page sheets (no dividers) ──");
const page = [
  { anchor: "Client Name", date: "Date Posted" }, // 1
  { anchor: "Acme", date: "Tue 10/20/26" },        // 2
  { anchor: "Cora", date: "Thu 10/22/26" },        // 3
  { anchor: "Echo", date: "Fri 10/30/26" },        // 4
];
p = planDatedInsert(page, "Wed 10/21/26");
assert(p.mode === "insert" && p.startRow === 3 && eq(p.kinds, ["data"]), "10/21 → below 10/20");
p = planDatedInsert(page, "Thu 10/22/26");
assert(p.mode === "insert" && p.startRow === 4, "10/22 → below the existing 10/22 row");
p = planDatedInsert(page, "Fri 10/30/26");
assert(p.mode === "append" && p.startRow === 5, "same day as last → append");
p = planDatedInsert(page, "Mon 10/19/26");
assert(p.mode === "insert" && p.startRow === 2, "before everything → just under the header");

console.log("\n── Same-brief sequence (rows stay in order) ──");
// Two pages of a late 10/21 brief: second goes under the first.
const after1 = master.slice(0, 3).concat([{ anchor: D, date: "" }, { anchor: "Late1", date: "Wed, 10/21/26" }], master.slice(3));
p = planDatedInsert(after1, "Wed, 10/21/26", M);
assert(p.mode === "insert" && p.startRow === 6 && eq(p.kinds, ["data"]), "2nd page of late brief → right under the 1st, no new divider");

console.log("\n── Held row numbers follow later inserts ──");
const log = [{ seq: 1, row: 4, count: 2 }, { seq: 2, row: 50, count: 1 }, { seq: 3, row: 10, count: 1 }];
assert(rebaseRow(20, 0, log) === 23, "row 20 recorded before all three inserts → 23");
assert(rebaseRow(20, 1, log) === 21, "recorded after seq 1 → only the row-10 insert counts");
assert(rebaseRow(3, 0, log) === 3, "row above every insert doesn't move");
assert(rebaseRow(4, 0, log) === 6, "insert AT the row pushes it down");
assert(rebaseRow(9, 0, log) === 12, "an insert that lands above the shifted row counts (9→11, then 10≤11 → 12)");

async function live() {
  require("dotenv").config();
  const id = process.env.TEST_SHEET_ID;
  if (!id || id === process.env.MASTER_SHEET_ID) {
    console.log("\n⚠️  --live needs TEST_SHEET_ID set to a SCRATCH copy (not the master)");
    process.exitCode = 1;
    return;
  }
  const { insertRowByDate } = require("../sheets");
  const tab = process.env.TEST_TAB || "2026 Ad Overview";
  const date = process.env.TEST_DATE || "Wed, 10/21/26";
  const row = ["", "ZZ insertRowByDate test", "Test", date, "", "@test", "", "$1", "Scheduled", "", ""];
  const r = await insertRowByDate(id, tab, row, { dateStr: date, dayDividers: true });
  console.log(`\n🧪 Live: "${date}" landed on row ${r} of "${tab}" — check its neighbours, then delete it.`);
}

if (process.argv.includes("--live")) {
  live().catch((err) => { console.error("❌ live:", err.message); process.exitCode = 1; });
} else {
  console.log("\n" + (process.exitCode ? "❌ Some tests failed" : "✅ All dated-insert tests passed"));
}
