/**
 * scripts/verify-coverage.js
 * Cross-references pages.json and telegram-destinations.json to find pages
 * missing one or the other.
 */
const fs = require("fs");
const path = require("path");

const pages = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "pages.json"), "utf-8"));
const dests = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "telegram-destinations.json"), "utf-8"));

const sheetHandles = new Set(Object.keys(pages).filter((k) => !k.startsWith("_")));
const chatHandles  = new Set(Object.keys(dests).filter((k) => !k.startsWith("_")));

const both    = [...sheetHandles].filter((h) => chatHandles.has(h)).sort();
const sheetOnly = [...sheetHandles].filter((h) => !chatHandles.has(h)).sort();
const chatOnly  = [...chatHandles].filter((h) => !sheetHandles.has(h)).sort();

console.log("─".repeat(60));
console.log("📊 COVERAGE REPORT");
console.log("─".repeat(60));
console.log(`\n✅ Pages with BOTH sheet + chat (${both.length}):`);
both.forEach((h) => console.log(`     ${h}`));

if (sheetOnly.length) {
  console.log(`\n📄 Pages with SHEET only — missing IG Ads chat (${sheetOnly.length}):`);
  sheetOnly.forEach((h) => console.log(`     ${h}`));
}

if (chatOnly.length) {
  console.log(`\n💬 Pages with CHAT only — missing revenue sheet (${chatOnly.length}):`);
  chatOnly.forEach((h) => console.log(`     ${h}`));
}

console.log("\n" + "─".repeat(60));
console.log(`Sheets total: ${sheetHandles.size}`);
console.log(`Chats total:  ${chatHandles.size}`);
console.log(`Fully wired:  ${both.length}`);
