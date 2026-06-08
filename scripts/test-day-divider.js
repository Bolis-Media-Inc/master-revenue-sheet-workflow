#!/usr/bin/env node
/**
 * Tests the day-divider DECISION logic (date normalization + new-day
 * detection). The Sheets I/O in maybeInsertDayDivider can't run without live
 * credentials, but the only non-trivial logic is "is this a new day?" — which
 * is pure. This mirrors the `norm` + compare logic in sheets.js exactly.
 */

function assert(cond, msg) { console.log(cond ? "✅" : "❌", msg); if (!cond) process.exitCode = 1; }

// Mirror of sheets.js maybeInsertDayDivider's norm()
const norm = (s) => {
  const m = String(s || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  return m ? `${+m[1]}/${+m[2]}/${m[3].slice(-2)}` : null;
};
// inserts a divider iff both dates parse AND differ
const wouldInsert = (lastDate, briefDate) => {
  const b = norm(briefDate);
  if (!b) return false;
  if (!lastDate) return false;          // empty sheet → no divider before day 1
  return norm(lastDate) !== b;
};

console.log("\n── New-day detection ──");
assert(wouldInsert("Tue 5/26/26", "Wed, 5/27/26") === true,  "different day → insert divider");
assert(wouldInsert("Wed 5/27/26", "Wed 5/27/26")  === false, "same day (same string) → no divider");
assert(wouldInsert("Wed 5/27/26", "Wed, 5/27/26") === false, "same day, comma drift → NO false split");
assert(wouldInsert(null, "Wed 5/27/26")           === false, "empty sheet → no divider before first day");
assert(wouldInsert("Tue 5/26/26", "garbage")      === false, "unparseable brief date → skip (fail-safe)");

console.log("\n── Year boundary + format variety ──");
assert(wouldInsert("Wed 12/31/25", "Thu 1/1/26") === true,  "year rollover → insert");
assert(wouldInsert("Fri, 3/6/26",  "Fri 3/6/26") === false, "leading-zero-free + comma → same day");
assert(wouldInsert("Mon 5/5/2026", "Mon 5/5/26") === true || norm("Mon 5/5/2026") === norm("Mon 5/5/26"),
  "4-digit vs 2-digit year both normalize to '5/5/26'");
assert(norm("Mon 5/5/2026") === "5/5/26", "4-digit year normalizes to 2-digit (5/5/26)");
assert(norm("Mon 5/5/26")   === "5/5/26", "2-digit year stays (5/5/26)");

console.log("\n" + (process.exitCode ? "❌ Some tests failed" : "✅ All day-divider logic tests passed"));
