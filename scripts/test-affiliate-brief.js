#!/usr/bin/env node
/**
 * Tests the three FashionNova-style affiliate-brief fixes:
 *   #1 per-page tracking links stripped to just this page (buildPerPageBriefText)
 *   #2 category "E-com"/"Ecom" normalized to "E-Com" (parser)
 *   #3 Time (MST) captured from "7-8pm PST / 10-11pm EST" (parser)
 */

const { parseAdMessage } = require("../parser");

let pass = true;
function assert(cond, msg) { console.log(cond ? "✅" : "❌", msg); if (!cond) pass = false; }

const BRIEF = `FashionNova - E-com - $230

@davogabriel

INSTRUCTIONS:

- Important - this is a 30d post, do not delete
- DO NOT HIDE LIKES/SHARES
- Reel
- Tag @FashionNova on the feed post & story
- 30min NIF
- Add story to story highlights
- Add link to the story & title the tap link: Shop FashionNova.com

@thefuck.tv - https://www.fashionnova.com/collections/new?utm_campaign=thefuck.tv

@dailyhumor_4u - https://www.fashionnova.com/collections/new?utm_campaign=dailyhumor_4u

@childhoodpost - https://www.fashionnova.com/collections/new?utm_campaign=childhoodpost

@i_have_no_memes96_v2 - https://www.fashionnova.com/collections/new?utm_campaign=i_have_no_memes96_v2

PAGE INFO:

7-8pm PST / 10-11pm EST

(32/100) @i_have_no_memes96_v2 - $230
(33/100) @thefuck.tv - $180
(34/100) @dailyhumor_4u - $200
(35/100) @childhoodpost - $180`;

console.log("\n── #2 Category normalization ──");
{
  const parsed = parseAdMessage(BRIEF, new Date("2026-06-06T19:00:00Z"));
  const list = Array.isArray(parsed) ? parsed : [parsed];
  assert(list[0].category === "E-Com", `"E-com" → "E-Com" (got "${list[0].category}")`);
  // standalone variants
  assert(parseAdMessage("X - Ecom - $5\n@a - $5", new Date()).category === "E-Com", `"Ecom" → "E-Com"`);
  assert(parseAdMessage("X - E-Commerce - $5\n@a - $5", new Date()).category === "E-Com", `"E-Commerce" → "E-Com"`);
  assert(parseAdMessage("X - Music - $5\n@a - $5", new Date()).category === "Music", `"Music" left untouched`);
  assert(parseAdMessage("X - Affiliate - $5\n@a - $5", new Date()).category === "Affiliate", `"Affiliate" left untouched`);
}

console.log("\n── #3 Time (MST) from PST/EST line ──");
{
  const parsed = parseAdMessage(BRIEF, new Date("2026-06-06T19:00:00Z"));
  const list = Array.isArray(parsed) ? parsed : [parsed];
  assert(list[0].timeMST === "7-8PM", `"7-8pm PST" → "7-8PM" (got "${list[0].timeMST}")`);
  // AZ still preferred when present
  const az = parseAdMessage("X - Music - $5\n\nPAGE INFO:\n4:45 PM AZ / 7:45 PM EST\n@a - $5", new Date());
  assert(az.timeMST === "4:45 PM", `AZ time still wins: "4:45 PM AZ" → "4:45 PM" (got "${az.timeMST}")`);
}

console.log("\n── #1 Per-page link isolation ──");
{
  const { buildPerPageBriefTextForTest } = loadBuilder();
  const out = buildPerPageBriefTextForTest(BRIEF, "i_have_no_memes96_v2", 230);
  assert(out.includes("utm_campaign=i_have_no_memes96_v2"), "keeps THIS page's link");
  assert(!out.includes("utm_campaign=thefuck.tv"),      "drops @thefuck.tv link");
  assert(!out.includes("utm_campaign=dailyhumor_4u"),   "drops @dailyhumor_4u link");
  assert(!out.includes("utm_campaign=childhoodpost"),   "drops @childhoodpost link");
  assert(out.includes("Tag @FashionNova"),              "keeps brand-mention instruction line");
  assert(out.includes("@i_have_no_memes96_v2 - $230"),  "keeps this page's PAGE INFO line");
  assert(!out.includes("@thefuck.tv - $180"),           "drops other pages' PAGE INFO lines");
}

console.log("\n" + (pass ? "✅ All affiliate-brief tests passed" : "❌ Some tests failed"));
process.exit(pass ? 0 : 1);

// buildPerPageBriefText isn't exported; pull it out of adHandler via a light shim.
function loadBuilder() {
  // It's a module-internal function. Re-require the source and eval the fn body
  // would be brittle; instead, re-implement the public behavior by requiring
  // the handler module which exports nothing for it — so we read it through a
  // tiny re-export hook if present, else skip with a clear message.
  try {
    const mod = require("../handlers/adHandler");
    if (typeof mod.buildPerPageBriefText === "function") {
      return { buildPerPageBriefTextForTest: mod.buildPerPageBriefText };
    }
  } catch (_) {}
  console.error("⚠️  buildPerPageBriefText not exported — add it to adHandler module.exports for this test.");
  process.exit(2);
}
