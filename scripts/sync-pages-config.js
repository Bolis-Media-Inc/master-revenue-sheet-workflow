/**
 * scripts/sync-pages-config.js
 *
 * Pulls every Google Sheet from a Drive folder, matches names to handles,
 * and merges the IDs directly into config/pages.json. Shows a diff before
 * writing.
 *
 * Usage:
 *   DRIVE_FOLDER_ID=<id> node scripts/sync-pages-config.js
 *
 *   # Dry run (show diff, don't write):
 *   DRIVE_FOLDER_ID=<id> DRY_RUN=true node scripts/sync-pages-config.js
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const FOLDER_ID = process.env.DRIVE_FOLDER_ID;
const DRY_RUN   = (process.env.DRY_RUN || "").toLowerCase() === "true";
const PAGES_PATH = path.join(__dirname, "..", "config", "pages.json");

if (!FOLDER_ID) {
  console.error("❌ Set DRIVE_FOLDER_ID env var");
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
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
}

// Sheets in the Drive folder that are NOT pages (master sheet, partner sheets, etc.)
const EXCLUDED_HANDLES = new Set([
  "master",   // Master Revenue Sheet itself
  "ai",       // AI test sheet
  "habits",   // partner/client
  "strive",   // partner/client
  "bonus",    // bonus sheet
  "hayak",    // partner/client
  "lines",    // Lines (partner)
]);

// Normalize typo'd handles in Drive filenames to canonical handle
const HANDLE_ALIASES = {
  "dankquilius": "dankquillius",  // Drive file has 1 L, real handle has 2
};

function extractHandle(filename) {
  const lower = filename.toLowerCase();

  const atMatch = lower.match(/@([\w.]+)/);
  let handle = atMatch ? atMatch[1] : null;

  if (!handle) {
    const cleaned = lower
      .replace(/\b(ig|instagram|revenue|tracker|sheet|workflow|net|page|2026|2025)\b/g, "")
      .replace(/[—–\-_|]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    handle = cleaned.split(" ")[0]?.replace(/[^\w.]/g, "") || null;
  }

  if (!handle) return null;
  if (EXCLUDED_HANDLES.has(handle)) return null;
  return HANDLE_ALIASES[handle] || handle;
}

async function main() {
  const auth = getAuth();
  const drive = google.drive({ version: "v3", auth });

  console.log(`🔍 Scanning folder ${FOLDER_ID}...`);

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

  console.log(`✅ Found ${allFiles.length} sheet(s)\n`);

  const newIds = {};
  const unmatched = [];
  for (const f of allFiles) {
    const handle = extractHandle(f.name);
    if (handle) newIds[handle] = f.id;
    else unmatched.push(f);
  }

  // Load existing config
  const existing = JSON.parse(fs.readFileSync(PAGES_PATH, "utf-8"));
  const merged = { ...existing };

  const added    = [];
  const replaced = [];
  const unchanged = [];
  const stillMissing = [];

  for (const [handle, newId] of Object.entries(newIds)) {
    const oldId = existing[handle];
    if (!oldId) {
      added.push({ handle, newId });
      merged[handle] = newId;
    } else if (oldId.startsWith("SHEET_ID_") || oldId !== newId) {
      replaced.push({ handle, oldId, newId });
      merged[handle] = newId;
    } else {
      unchanged.push({ handle, id: newId });
    }
  }

  // Find handles in config that DIDN'T match a Drive file
  for (const [handle, id] of Object.entries(existing)) {
    if (handle.startsWith("_")) continue;
    if (!newIds[handle] && id.startsWith("SHEET_ID_")) {
      stillMissing.push(handle);
    }
  }

  // Print diff
  console.log("─".repeat(60));
  console.log("📋 SYNC PLAN");
  console.log("─".repeat(60));

  if (added.length) {
    console.log(`\n✨ NEW pages to add (${added.length}):`);
    added.forEach(({ handle, newId }) => console.log(`   + ${handle.padEnd(30)} ${newId}`));
  }

  if (replaced.length) {
    console.log(`\n🔄 IDs to UPDATE (${replaced.length}):`);
    replaced.forEach(({ handle, oldId, newId }) => {
      console.log(`   ~ ${handle}`);
      console.log(`       old: ${oldId}`);
      console.log(`       new: ${newId}`);
    });
  }

  if (unchanged.length) {
    console.log(`\n✅ Unchanged (${unchanged.length}):`);
    unchanged.forEach(({ handle }) => console.log(`     ${handle}`));
  }

  if (stillMissing.length) {
    console.log(`\n⚠️  Still missing sheet IDs in Drive (${stillMissing.length}):`);
    stillMissing.forEach((h) => console.log(`     ${h}`));
  }

  if (unmatched.length) {
    console.log(`\n❓ Drive files we couldn't auto-match (${unmatched.length}):`);
    unmatched.forEach((f) => console.log(`     "${f.name}"  →  ${f.id}`));
    console.log(`     (Add manually to config/pages.json if needed)`);
  }

  console.log("\n" + "─".repeat(60));

  if (DRY_RUN) {
    console.log("🚧 DRY_RUN=true — no changes written");
    console.log("   Run without DRY_RUN to apply changes");
    return;
  }

  if (added.length === 0 && replaced.length === 0) {
    console.log("✅ Nothing to update");
    return;
  }

  // Write merged config
  fs.writeFileSync(PAGES_PATH, JSON.stringify(merged, null, 2) + "\n");
  console.log(`✅ Wrote updated config to ${PAGES_PATH}`);
  console.log(`   ${added.length} added, ${replaced.length} replaced`);
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  if (err.errors) console.error(err.errors);
  process.exit(1);
});
