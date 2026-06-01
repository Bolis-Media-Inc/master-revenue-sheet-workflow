#!/usr/bin/env node
/**
 * One-off: relabel brief 6cdafdc4 from "Stake BET SLIP Day 5" → "Day 7".
 *
 * Why: user posted Day 5 → bot recorded as Day 5 → user edited to Day 7
 * (no edit-tracking back then) → records stuck on Day 5. DB row already
 * updated; this catches up Master + 12 per-page sheets.
 *
 * Run: node scripts/relabel-stake-day-7.js
 */

require("dotenv").config();
const { updateAdClient } = require("../sheets");

const OLD_CLIENT = "Stake BET SLIP Day 5";
const NEW_CLIENT = "Stake BET SLIP Day 7";
const MASTER_SHEET_ID = process.env.MASTER_SHEET_ID;
const MASTER_TAB_NAME = process.env.MASTER_TAB_NAME || "Sheet1";
const PAGE_TAB_NAME   = process.env.PAGE_TAB_NAME   || "Sheet1";

// 12 page handles + their per-page sheet IDs (from the SQL query)
const PAGES = [
  { handle: "moist",                sheetId: "1fU8e8mBiyyx_cBTLYffJ8ajQLPFUmNrW0OIulZbdVbg" },
  { handle: "childhoodpost",        sheetId: "1KPBgkBGwH-kjbP6xrdLqqH8PlKXBby-EsKeYRcTWnlI" },
  { handle: "howeverythingworks",   sheetId: "1dp9bpMsHtJaY_Wv2YMqpHRSVbVOuGLkx7n9i-PH6Tqs" },
  { handle: "dailyhumor_4u",        sheetId: "1YdYTItK4QskrHw4Z5A8WWDazTiOxL7kyETdJLxDK3ik" },
  { handle: "i_have_no_memes96_v2", sheetId: "1LtBHynKg7l2uDfM-LtWwOx0ywkyMXJjhNri4ZH66aVw" },
  { handle: "marvelmovies",         sheetId: "1P3aTJ3gy9cHm_jaJa1UKZjS_nCs93lj0Z9JFLC_dbkY" },
  { handle: "hoodreels",            sheetId: "1_r3ttaNhodj0AfG1Q1T3WWMGnR-1_V2xgoHkx9JF8Ww" },
  { handle: "thefuck.tv",           sheetId: "1EO_azp66cyQ64vm0cMNUofYgqxVoxngoZOAzMB2YH_8" },
  { handle: "oddlyhorrifying",      sheetId: "1bC9mO2w6pgE8uylwwdxKydiA9DTod5jKk_kk6O1_4ec" },
  { handle: "hitsblunt",            sheetId: "11aBxu_RdkuRmTqDlSSdROE2uptEOuCOskXSQiYKbri0" },
  { handle: "psychological",        sheetId: "16-JHD6zfO51PO6B4-ALRsK1dTfa9dG0JCfnbEj6JrOk" },
  { handle: "dailyhoodposts",       sheetId: "1bT8ue5zGJKdu7cgmCoAqsdl9Ea2ilLSAjbwtA71C5wA" },
];

async function main() {
  if (!MASTER_SHEET_ID) throw new Error("MASTER_SHEET_ID not set in env");

  // 1. Master sheet — scope to just our 12 page handles to avoid catching
  //    any sibling "Day 5" briefs that share the same client name
  console.log(`[relabel] Master sheet ${MASTER_SHEET_ID} — updating "${OLD_CLIENT}" → "${NEW_CLIENT}" for ${PAGES.length} pages…`);
  const masterUpdated = await updateAdClient(
    MASTER_SHEET_ID, MASTER_TAB_NAME,
    PAGES.map((p) => p.handle),
    OLD_CLIENT, NEW_CLIENT, true,
  );
  console.log(`[relabel] Master: ${masterUpdated} row(s) updated.`);

  // 2. Per-page sheets — one update call per sheet
  let perPageTotal = 0;
  for (const p of PAGES) {
    try {
      const n = await updateAdClient(p.sheetId, PAGE_TAB_NAME, [], OLD_CLIENT, NEW_CLIENT, false);
      console.log(`[relabel] @${p.handle}: ${n} row(s) updated.`);
      perPageTotal += n;
    } catch (err) {
      console.error(`[relabel] @${p.handle}: ${err.message}`);
    }
  }

  console.log(`\n[relabel] ✅ Done — Master: ${masterUpdated}, Per-page total: ${perPageTotal}`);
}

main().catch((err) => { console.error("[relabel] FATAL:", err.message); process.exit(1); });
