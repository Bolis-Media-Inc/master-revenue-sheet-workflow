#!/usr/bin/env node
/**
 * Diagnostic: read row 1 column A of every per-page sheet to determine
 * which sheets still have the "SS" checkbox column (or any non-Client A).
 *
 * Page list is hardcoded — pulled from `pages` table via Supabase MCP.
 * Keep in sync if pages are added/removed (one-off audit script).
 */

require("dotenv").config();
const { google } = require("googleapis");

const PAGE_TAB_NAME = process.env.PAGE_SHEET_TAB_NAME || "IG Revenue Tracker";

const PAGES = [
  ["answerallquestions",         "1UNN-JZE9AYPLNJxAihff0ilxKAvnd9n1CRPzhbus-cQ"],
  ["archivedrunway",             "1fx9JGcYYKdxl4vuGysqZX3BMXGdtx1oYwmMs_5OY5po"],
  ["artistswithoutautotune",     "1W3mZ1WlFMr9xzPGqJT1OdtOgO4RqybG-yGxtIuRu_Sw"],
  ["bestofhumors",               "1vDf3f3kvnqOim-RHbltsbFHl7RNK-O-tM1xIBybj6nE"],
  ["bitchy.tweets",              "18aAIVKn4h6SynODhT2fZb75DfP6GoaWtcJ1VyZ6RTbE"],
  ["bitchyquotes",               "1zZYl7SHvbErIdkGNvopx93yLW-cq4m_B70g60EeolH0"],
  ["childhoodpost",              "1KPBgkBGwH-kjbP6xrdLqqH8PlKXBby-EsKeYRcTWnlI"],
  ["crankybitchprobs",           "1NEdMnR1QWMa5lwAfF-0ZVmLaEbbeLzU7S4tBYIhSH6o"],
  ["dailyhoodposts",             "1bT8ue5zGJKdu7cgmCoAqsdl9Ea2ilLSAjbwtA71C5wA"],
  ["dailyhumor_4u",              "1YdYTItK4QskrHw4Z5A8WWDazTiOxL7kyETdJLxDK3ik"],
  ["dankquillius",               "1RvTe8M7ruc7bu6uOnhllm3NfhD1vNVU5KWfbjR78GsE"],
  ["databases",                  "18xEE_mO1z2i88zKMHet2AqCPDSO3FExNjkP71_L9peE"],
  ["dopejukes",                  "1MXr9SWq0wQQY6-fykQ2IKG7UcH74NGS3tRKsy7YLSjQ"],
  ["explainingpaintings",        "1rzRqXJXy2SqZZzwd-Ie3l6rr9p5u6noCQI03tkIl_WQ"],
  ["factmayor",                  "10dzxF7HyihGE4H5C0pO4E7wIRn6QemIBeSCDxNRj-9s"],
  ["faillgram",                  "1hW_OH-dj10Y2p0UX3iw7XpVLSHdUAaySKFWAgPCFvAw"],
  ["goal",                       "1bkPxQr2kt3iSuvC8Ju8Wt6P-LZs9rCDjQUETSHUh71s"],
  ["greatestmediamoments",       "1mYTjI70rz95238wJEPeDndifD5wDUC6vfVbI5jGrMSI"],
  ["hardestpost",                "1T6qbvhHFwNmlVVCB66qHKdOLEnEhC2AEFJbAkegyow4"],
  ["hauntedfootage",             "1Q638PxDb9On02xuEogr2uLaUp5t4uDYIq6vUaGYFSd4"],
  ["historic",                   "1zOakodpHib_3sWSwQlIM5JIFTga4JBPFkdMl4kKWcLc"],
  ["hitsblunt",                  "11aBxu_RdkuRmTqDlSSdROE2uptEOuCOskXSQiYKbri0"],
  ["hoereacts",                  "1lydJTDhMmncV_uSCrSLHFPCO7fS858wfXpVblLS1TwQ"],
  ["hoodreels",                  "1_r3ttaNhodj0AfG1Q1T3WWMGnR-1_V2xgoHkx9JF8Ww"],
  ["hoopsxcenter",               "19eS416GSNG0yoP8hKK2G-JKGZfY5ycFIEAYlZw6l3Wk"],
  ["howeverythingworks",         "1dp9bpMsHtJaY_Wv2YMqpHRSVbVOuGLkx7n9i-PH6Tqs"],
  ["howsongsarerecorded",        "1vCLo7PXNVRstrnUSX4qQwr3O8IZ4XyYVFO03jgj3X4o"],
  ["i_have_no_memes96_v2",       "1LtBHynKg7l2uDfM-LtWwOx0ywkyMXJjhNri4ZH66aVw"],
  ["imbeingsarcastic",           "1je8zPTBjFz_TUFas-5ovGS7W6C4sUGPLdo5oeSAetlE"],
  ["itstumblrhumor",             "1tcPUQU2E2lUF5zFGkmDQi9B3-eOJ6EJawFZc_yir7mY"],
  ["marvelmovies",               "1P3aTJ3gy9cHm_jaJa1UKZjS_nCs93lj0Z9JFLC_dbkY"],
  ["memedwyd",                   "1cCw98e6BqMj-09Mm6mSVLgFvTiyDFD-pHeNyQ-QryWs"],
  ["moist",                      "1fU8e8mBiyyx_cBTLYffJ8ajQLPFUmNrW0OIulZbdVbg"],
  ["mostmemorablemedia",         "19Rg1SSJ4yitXfA6XZgYpSl9CLiMBznWHf4xXomvyeJQ"],
  ["motorchive",                 "1VdsT3_qPH5t77mE7Gq4t_CVpLgFAvW_dlTTE03YZcuc"],
  ["musicbeforeautotune",        "1okrS0H9ShKiXt8QSsNTLytJwJ6HCEKhlc7IaVI-9IV8"],
  ["northwitch69",               "1KuccLvdKtpc2d63xQpJBHjLycyPkJaWELpc7OrQwEsc"],
  ["oddlyhorrifying",            "1bC9mO2w6pgE8uylwwdxKydiA9DTod5jKk_kk6O1_4ec"],
  ["pastpreserved",              "1DpSYJI5u9cLF_xy3021dwniBey3_jOgxIVJ5TxKj25I"],
  ["physicsuncovered",           "1V1yYxRxmhPwtDPsdZFFhpjgeXix1tvHZKSSAXsDvnUI"],
  ["popdownload",                "1Q4wD3m4Me0JJ7HaMmAiUckxvRstot6VUVjbSF8gWvEY"],
  ["psychological",              "16-JHD6zfO51PO6B4-ALRsK1dTfa9dG0JCfnbEj6JrOk"],
  ["rapperswithoutautotune",     "1dc48HNa8tTMg6i206stbwU8WWCu_Y2QFKdINDSCDo8Y"],
  ["relatablegirlymemes",        "1oiAjHGYi23PlvcNhOQWtAD1EjQIZwzLA6G43vw2UA9k"],
  ["scooby",                     "1a3wu8f3K4iYBcWcJsZvI8WamAW3mHpdbr5krK0dYVwQ"],
  ["secrets.jp",                 "1MM6_zPEJfhl_3Y8r3GvnwoQyQEK88gdnFVdDKlLh-cE"],
  ["selfcaresis",                "1CJelxfdOL-RsKacqcaaLXWm05Y53bOgKzaDsAqrRXFY"],
  ["showerfeelings",             "1l7YOlYgFGW-umTnDchIGPgB1ODQYElIie2z5Dhrz0OY"],
  ["soda",                       "18-mHyxvTfwWt9of-w3wsDHjNxzMDx9DiY8tiEDwDpU0"],
  ["superficialdolls",           "1DpjJ7ol6ilnfvJB2sX7zerEodH7kifkGBRpTu0OakyI"],
  ["thefuck.tv",                 "1EO_azp66cyQ64vm0cMNUofYgqxVoxngoZOAzMB2YH_8"],
  ["thought",                    "1GJYV_kIUmWBmFQauPmmfwhF1V7zDkuceY-XYg_HSlPw"],
  ["tinderreels",                "104EGTZFA1bz4Y16TjMaCCVbebqKKELIOxsJ2CLA77hI"],
  ["tonsil",                     "1tg9Bo1d1kimYEF668uRyM_hTDU-W_5BJg3u9aHqo70I"],
  ["unforgettablebloopers",      "1GjGE0HUNnQ2EDuctRGA1SrzbYJRJX2jeOAM9IYza7JI"],
  ["unforgettablesportsmoments", "1nL67lSdosbyZAFz41EhP8CAyjLnjIVSAwFOGuw9uoJQ"],
  ["whatsif",                    "1ENq3KwEa6K1cHU5m7XxSazuPyuab6nin3AZe0cJRrLU"],
  ["whenrappersfreestyle",       "1TKl6gXqnTfOJ83SduUsmVkyrvdPzJ5zQjaQw7T8V0WQ"],
  ["zer",                        "1uGtzxGXVkOAAYxQwqdhc1uKeY31AHEN3PsfAg0qXGo8"],
];

async function main() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });

  const flagged = [];
  for (const [handle, sheetId] of PAGES) {
    try {
      const r = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `${PAGE_TAB_NAME}!A1:B1`,
      });
      const [a, b] = (r.data.values && r.data.values[0]) || [];
      const aHeader = (a || "").trim();
      const bHeader = (b || "").trim();
      const aIsClient = /client/i.test(aHeader);
      const tag = aIsClient ? "✅ A=Client" : `⚠️ A="${aHeader}", B="${bHeader}"`;
      console.log(`@${handle.padEnd(28)} ${tag}`);
      if (!aIsClient) flagged.push({ handle, aHeader, bHeader });
    } catch (err) {
      console.log(`@${handle.padEnd(28)} ❌ ${err.message.slice(0, 60)}`);
    }
  }

  console.log("");
  if (flagged.length === 0) {
    console.log("✅ All per-page sheets have A=Client Name — code matches schema everywhere.");
  } else {
    console.log(`⚠️ ${flagged.length} page(s) have a non-Client column A:`);
    for (const f of flagged) console.log(`   @${f.handle}: A="${f.aHeader}", B="${f.bHeader}"`);
  }
}

main().catch((err) => { console.error("FATAL:", err.message); process.exit(1); });
