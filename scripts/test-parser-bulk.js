#!/usr/bin/env node
/**
 * Tests parser bulk/carousel-index handling.
 * Regression: "OneOff - Affiliate - 1/4 - $500" folded the "1/4" into the Ad
 * Type ("Affiliate - 1/4") and "@goal - 1/4" in PAGE INFO was misread as a $1
 * price. The "1/4" is a bulk index → belongs in the Bulk # column.
 */
const { parseAdMessage } = require("../parser");

let pass = true;
const assert = (c, m) => { console.log(c ? "✅" : "❌", m); if (!c) pass = false; };
const one = (r) => (Array.isArray(r) ? r[0] : r);

console.log("\n── OneOff: header bulk + handle bulk ──");
{
  const r = one(parseAdMessage(
    "OneOff - Affiliate - 1/4 - $500\n\n@noel_bolismedia\n\nINSTRUCTIONS:\n- Carousel\n\nPAGE INFO:\n4:15 PM AZ // 7:15 PM EST\n@goal - 1/4",
    new Date(),
  ));
  assert(r.category === "Affiliate", `category = Affiliate (got "${r.category}")`);
  assert(r.bulkNum === "1/4", `bulkNum = 1/4 (got "${r.bulkNum}")`);
  assert(r.adPrice === 500, `price = 500 (got ${r.adPrice})`);
  assert(r.pageHandle === "goal", `page = goal (got "${r.pageHandle}")`);
}

console.log("\n── multi-page (N/15) bulk still works ──");
{
  const r = parseAdMessage(
    "Acme - E-com - $3,500\n\nINSTRUCTIONS:\n- post\n\nPAGE INFO:\n4:45 PM AZ\n(1/15) @moist - $250\n(2/15) @scooby - $250",
    new Date(),
  );
  assert(Array.isArray(r) && r.length === 2, "two page entries");
  assert(r[0].bulkNum === "1/15" && r[1].bulkNum === "2/15", `bulkNums 1/15,2/15 (got ${r.map((p) => p.bulkNum)})`);
  assert(r[0].category === "E-Com", "category normalized to E-Com");
}

console.log("\n── standard single brief → no false bulk ──");
{
  const r = one(parseAdMessage("Brand - Music - $400\n\nPAGE INFO:\n@goal - $400", new Date()));
  assert(r.bulkNum === "", `bulkNum empty (got "${r.bulkNum}")`);
  assert(r.adPrice === 400 && r.pageHandle === "goal", "price 400 / page goal intact");
}

console.log("\n── header bulk + CPM parenthetical ──");
{
  const r = one(parseAdMessage("X - Affiliate - 2/4 - $0 ($3.50 CPM)\n\nPAGE INFO:\n@thefuck.tv - 2/4", new Date()));
  assert(r.category === "Affiliate", `category Affiliate (got "${r.category}")`);
  assert(r.bulkNum === "2/4", `bulkNum 2/4 (got "${r.bulkNum}")`);
  assert(r.pageHandle === "thefuck.tv", `page thefuck.tv (got "${r.pageHandle}")`);
}

console.log("\n" + (pass ? "✅ All parser-bulk tests passed" : "❌ Some failed"));
process.exit(pass ? 0 : 1);
