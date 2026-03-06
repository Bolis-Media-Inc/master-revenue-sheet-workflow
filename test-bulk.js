/**
 * test-bulk.js
 * Manually simulates a bulk ad message and writes rows to the master sheet.
 * Run with: GOOGLE_SERVICE_ACCOUNT_JSON='...' MASTER_SHEET_ID='...' node test-bulk.js
 */
require("dotenv").config();
const { parseAdMessage } = require("./parser");
const { appendRow }      = require("./sheets");

const MASTER_SHEET_ID = process.env.MASTER_SHEET_ID;
const TAB_NAME        = process.env.SHEET_TAB_NAME || "2026 Ad Overview";

const TEST_MESSAGE = `Stake BET SLIP Day 4 - Affiliate - $3,070
@sales_bolismedia
@onah_bolismedia
@davogabriel
@isaac_bolismedia
INSTRUCTIONS:
- FEED
- LEAVE AS PERMANENT POST
- 15 MIN NIF
- Add any popular audio from IG Library
- IMPORTANT: Send link to posts in Stake CPM campaign groups:

*Link*
STAKE BET SLIP
@pagename
PAGE INFO:
3:45pm AZ / 5:45pm EST
(9/15) @dailyhumor_4u - $400
(9/15)@i_have_no_memes96_v2 - $400
(9/15) @marvelmovies - $350
(9/15) @hoodreels - $300
(9/15) @thefuck.tv -  $300
(9/15) @hitsblunt - $200
(9/15) @psychological - $200
(9/15) @scooby - $120
(7/15) @oddlyhorrifying - $250
(11/15) @hauntedfootage - $150
(11/15) @dailyhoodposts - $200
(11/15) @unforgettablesportsmoments - $100
(11/15) @dopejukes - $50
(11/15)@hoopsxcenter - $50`;

function buildRow(parsed) {
  return [
    "",
    parsed.client,
    parsed.category,
    parsed.datePosted,
    parsed.timeMST || "",
    parsed.pageHandle ? `@${parsed.pageHandle}` : "",
    "",
    parsed.adPrice ? `$${parsed.adPrice}` : "",
    "",
    "",
    parsed.nif || "",
  ];
}

async function main() {
  const parsed     = parseAdMessage(TEST_MESSAGE, new Date());
  const parsedList = Array.isArray(parsed) ? parsed : [parsed];

  console.log(`Parsed ${parsedList.length} row(s):`);
  parsedList.forEach((p, i) =>
    console.log(`  [${i + 1}] @${p.pageHandle} — $${p.adPrice}`)
  );
  console.log(`\nWriting to sheet: ${MASTER_SHEET_ID} / tab: "${TAB_NAME}"\n`);

  let ok = 0;
  for (const item of parsedList) {
    try {
      await appendRow(MASTER_SHEET_ID, TAB_NAME, buildRow(item));
      console.log(`  ✅ @${item.pageHandle}`);
      ok++;
    } catch (err) {
      console.error(`  ❌ @${item.pageHandle}: ${err.message}`);
    }
  }
  console.log(`\nDone: ${ok}/${parsedList.length} rows written.`);
}

main();
