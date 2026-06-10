#!/usr/bin/env node
/**
 * Tests the date-key logic behind sortSheetByDate — proving chronological
 * order is correct where a naive text sort of "Mon 3/9/26" would be wrong.
 * Mirrors the dateKey() in sheets.js exactly.
 */

function assert(cond, msg) { console.log(cond ? "✅" : "❌", msg); if (!cond) process.exitCode = 1; }

const dateKey = (s) => {
  const m = String(s || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  const mo = +m[1], d = +m[2];
  let y = +m[3]; if (y < 100) y += 2000;
  return y * 10000 + mo * 100 + d;
};

// Sort a list of date strings using the key (blanks/undated last, stable).
function sortByDate(arr) {
  return arr
    .map((s, i) => ({ s, i, k: dateKey(s) }))
    .sort((a, b) => {
      if (a.k == null && b.k == null) return a.i - b.i;
      if (a.k == null) return 1;   // undated → bottom
      if (b.k == null) return -1;
      return a.k - b.k || a.i - b.i;
    })
    .map((x) => x.s);
}

console.log("\n── Chronological order beats text order ──");
{
  const input = ["Tue 5/26/26", "Fri 10/1/26", "Mon 3/9/26", "Wed 1/1/26"];
  const out = sortByDate(input);
  assert(JSON.stringify(out) === JSON.stringify(["Wed 1/1/26", "Mon 3/9/26", "Tue 5/26/26", "Fri 10/1/26"]),
    `1/1 < 3/9 < 5/26 < 10/1 (got ${JSON.stringify(out)})`);
  // A naive string sort would put "Fri 10/1/26" first (F) and "10/1" before "3/9" — prove we don't:
  assert(out[out.length - 1] === "Fri 10/1/26", "10/1 ends up LAST, not first (text-sort trap avoided)");
}

console.log("\n── Year rollover ──");
{
  const out = sortByDate(["Thu 1/1/26", "Wed 12/31/25", "Fri 1/2/26"]);
  assert(JSON.stringify(out) === JSON.stringify(["Wed 12/31/25", "Thu 1/1/26", "Fri 1/2/26"]),
    `Dec '25 before Jan '26 (got ${JSON.stringify(out)})`);
}

console.log("\n── Undated / blank rows sink to the bottom, stably ──");
{
  const out = sortByDate(["Mon 3/9/26", "", "Tue 1/5/26", "notes row", "Wed 2/1/26"]);
  assert(JSON.stringify(out) === JSON.stringify(["Tue 1/5/26", "Wed 2/1/26", "Mon 3/9/26", "", "notes row"]),
    `dated rows sorted, undated kept at end in original order (got ${JSON.stringify(out)})`);
}

console.log("\n── Comma / format drift still parses ──");
{
  assert(dateKey("Wed, 5/27/26") === 20260527, "comma format → 20260527");
  assert(dateKey("5/27/2026")    === 20260527, "4-digit year → 20260527");
  assert(dateKey("garbage")      === null,     "unparseable → null");
}

console.log("\n" + (process.exitCode ? "❌ Some tests failed" : "✅ All sort-by-date logic tests passed"));
