/**
 * cleanup-bad-rows.js
 *
 * Removes the corrupted rows from the "2026 Ad Overview" tab:
 *  - Rows that have ONLY a page handle (col F) and/or a status (col I) but
 *    are missing Client Name (col B), Date (col D), and Price (col H).
 *  - Blank rows sitting between those bad rows (from the runaway separator inserts).
 *
 * Run with:   railway run node cleanup-bad-rows.js
 * Or locally: node cleanup-bad-rows.js  (requires .env with credentials)
 *
 * SAFE — prints a preview first and asks you to confirm before deleting.
 */

require("dotenv").config();
const { google } = require("googleapis");
const readline = require("readline");

const MASTER_SHEET_ID = process.env.MASTER_SHEET_ID;
const TAB_NAME        = process.env.SHEET_TAB_NAME || "2026 Ad Overview";

if (!MASTER_SHEET_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  console.error("❌ MASTER_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON must be set");
  process.exit(1);
}

function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

async function main() {
  const auth   = getAuth();
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });

  // ── Step 1: Read all rows A:K ─────────────────────────────────────────────
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: MASTER_SHEET_ID,
    range: `${TAB_NAME}!A:K`,
  });

  const rows = res.data.values || [];
  console.log(`Total rows read: ${rows.length}`);

  // ── Step 2: Get the numeric sheet ID for batchUpdate ──────────────────────
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: MASTER_SHEET_ID });
  const sheet = spreadsheet.data.sheets?.find((s) => s.properties.title === TAB_NAME);
  if (!sheet) {
    console.error(`❌ Tab "${TAB_NAME}" not found`);
    process.exit(1);
  }
  const sheetId = sheet.properties.sheetId;

  // ── Step 3: Identify bad rows ─────────────────────────────────────────────
  // A "bad row" is one where:
  //   - Col B (Client Name) is empty AND
  //   - Col D (Date) is empty AND
  //   - Col H (Price) is empty AND
  //   - (Col F has a value like @handle OR the entire row is blank)
  //
  // These are the corrupted rows inserted by the separator-inside-loop bug.
  // Header row (row 0, 1-indexed row 1) is skipped.

  const badRowIndices = []; // 0-indexed

  for (let i = 1; i < rows.length; i++) {  // skip header at index 0
    const row       = rows[i] || [];
    const clientVal = (row[1] || "").trim(); // B
    const dateVal   = (row[3] || "").trim(); // D
    const priceVal  = (row[7] || "").trim(); // H
    const pageVal   = (row[5] || "").trim(); // F
    const statusVal = (row[8] || "").trim(); // I

    // Completely blank row — separator attempt
    const isBlank = row.every((c) => !c?.trim());

    // Partial row: has page handle or status but no client/date/price
    const isPartial =
      !clientVal && !dateVal && !priceVal && (pageVal || statusVal);

    if (isBlank || isPartial) {
      badRowIndices.push(i);
    }
  }

  if (badRowIndices.length === 0) {
    console.log("✅ No bad rows found — sheet looks clean!");
    return;
  }

  // ── Step 4: Preview ────────────────────────────────────────────────────────
  console.log(`\n⚠️  Found ${badRowIndices.length} bad rows to delete:`);
  badRowIndices.slice(0, 30).forEach((i) => {
    const row = rows[i] || [];
    console.log(
      `  Row ${i + 1}: B="${row[1] || ""}"  D="${row[3] || ""}"  F="${row[5] || ""}"  I="${row[8] || ""}"`
    );
  });
  if (badRowIndices.length > 30) {
    console.log(`  ... and ${badRowIndices.length - 30} more`);
  }

  // ── Step 5: Confirm ────────────────────────────────────────────────────────
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolve) => {
    rl.question(`\nDelete these ${badRowIndices.length} rows? Type YES to confirm: `, (answer) => {
      rl.close();
      if (answer.trim().toUpperCase() !== "YES") {
        console.log("Aborted.");
        process.exit(0);
      }
      resolve();
    });
  });

  // ── Step 6: Delete rows in reverse order (so indices stay valid) ───────────
  // Build deletion requests. Google Sheets API requires ranges to be
  // non-overlapping and sorted in REVERSE order when doing multiple deletes.
  const sortedDesc = [...badRowIndices].sort((a, b) => b - a);

  // Merge consecutive indices into contiguous ranges for efficiency
  const ranges = [];
  let rangeStart = sortedDesc[0];
  let rangeEnd   = sortedDesc[0];

  for (let k = 1; k < sortedDesc.length; k++) {
    if (sortedDesc[k] === rangeEnd - 1) {
      // Consecutive (going backwards) — extend range
      rangeEnd = sortedDesc[k];
    } else {
      ranges.push({ start: rangeEnd, end: rangeStart + 1 }); // +1 because endIndex is exclusive
      rangeStart = sortedDesc[k];
      rangeEnd   = sortedDesc[k];
    }
  }
  ranges.push({ start: rangeEnd, end: rangeStart + 1 });

  const requests = ranges.map(({ start, end }) => ({
    deleteDimension: {
      range: {
        sheetId,
        dimension: "ROWS",
        startIndex: start,
        endIndex:   end,
      },
    },
  }));

  console.log(`\nSending ${requests.length} delete request(s)...`);

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: MASTER_SHEET_ID,
    requestBody: { requests },
  });

  console.log(`✅ Done! Deleted ${badRowIndices.length} bad rows from "${TAB_NAME}".`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
