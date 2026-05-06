/**
 * scripts/scan-drive-folder.js
 *
 * One-time tool: lists every Google Sheet in a Drive folder and matches each
 * file name to a page handle, outputting a JSON map that can be merged into
 * config/pages.json.
 *
 * Usage:
 *   1. Share the Drive folder with the service account email
 *      (find it inside your GOOGLE_SERVICE_ACCOUNT_JSON: the "client_email" field)
 *   2. Get the folder ID from the URL:
 *      https://drive.google.com/drive/folders/THIS_IS_THE_FOLDER_ID
 *   3. Run: DRIVE_FOLDER_ID=<id> node scripts/scan-drive-folder.js
 *
 * Output: prints a JSON object to stdout. Pipe to a file or copy/paste into
 * config/pages.json.
 */

require("dotenv").config();
const { google } = require("googleapis");

const FOLDER_ID = process.env.DRIVE_FOLDER_ID;
if (!FOLDER_ID) {
  console.error("❌ Set DRIVE_FOLDER_ID env var to your Drive folder ID");
  console.error("   Example: DRIVE_FOLDER_ID=1abc...xyz node scripts/scan-drive-folder.js");
  process.exit(1);
}

function getAuth() {
  let credentials;

  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    credentials = require(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  } else {
    throw new Error("Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS");
  }

  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets.readonly",
      "https://www.googleapis.com/auth/drive.readonly",
    ],
  });
}

/**
 * Try to extract a page handle from a sheet's filename.
 * Matches things like:
 *   "@thefuck.tv Revenue"        → "thefuck.tv"
 *   "thefuck.tv IG Revenue"      → "thefuck.tv"
 *   "Goal — Revenue Sheet"        → "goal"
 *   "artistswithoutautotune Rev"  → "artistswithoutautotune"
 */
function extractHandle(filename) {
  const lower = filename.toLowerCase();

  // Try @handle format first
  const atMatch = lower.match(/@([\w.]+)/);
  if (atMatch) return atMatch[1];

  // Strip common suffixes/prefixes and grab the first "word"
  const cleaned = lower
    .replace(/\b(ig|instagram|revenue|tracker|sheet|workflow|net|page|2026|2025)\b/g, "")
    .replace(/[—–\-_|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Take first non-empty token, allow dots and underscores
  const firstWord = cleaned.split(" ")[0]?.replace(/[^\w.]/g, "");
  return firstWord || null;
}

async function main() {
  const auth = getAuth();
  const drive = google.drive({ version: "v3", auth });

  console.error(`🔍 Scanning folder ${FOLDER_ID}...`);

  let pageToken;
  const allFiles = [];

  do {
    const { data } = await drive.files.list({
      q: `'${FOLDER_ID}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.spreadsheet'`,
      pageSize: 1000,
      pageToken,
      fields: "nextPageToken, files(id, name)",
    });

    if (data.files) allFiles.push(...data.files);
    pageToken = data.nextPageToken;
  } while (pageToken);

  console.error(`✅ Found ${allFiles.length} sheet(s) in folder\n`);

  const result = {};
  const unmatched = [];

  for (const f of allFiles) {
    const handle = extractHandle(f.name);
    if (handle) {
      if (result[handle]) {
        console.error(`⚠️  Duplicate handle "${handle}":`);
        console.error(`     existing: ${result[handle]}`);
        console.error(`     new:      ${f.id}  (${f.name})`);
      }
      result[handle] = f.id;
      console.error(`  ✅ @${handle.padEnd(35)} ${f.id}  (${f.name})`);
    } else {
      unmatched.push(f);
      console.error(`  ❌ Could not extract handle from: "${f.name}"  (${f.id})`);
    }
  }

  console.error(`\n📊 Summary: ${Object.keys(result).length} matched, ${unmatched.length} unmatched`);
  console.error(`\n--- JSON OUTPUT (pipe to file or paste into config/pages.json) ---\n`);

  // Print sorted
  const sorted = Object.fromEntries(
    Object.entries(result).sort(([a], [b]) => a.localeCompare(b))
  );
  console.log(JSON.stringify(sorted, null, 2));
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  if (err.errors) console.error(err.errors);
  process.exit(1);
});
