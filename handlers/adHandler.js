/**
 * handlers/adHandler.js
 * Called for every message in the Internal Network Ads group.
 *
 * Flow:
 *  1. Parse the message text for ad structure
 *  2. Build the row (matches columns in the revenue sheets)
 *  3. Append to Master Revenue Sheet (always)
 *  4. Append to the individual page's revenue sheet (if handle is known in pages.json)
 *  5. Reply with a ✅ confirmation (or stay silent if not an ad)
 */

const { parseAdMessage }  = require("../parser");
const { appendRow }       = require("../sheets");
const pages               = require("../config/pages.json");

const TARGET_CHAT_ID  = process.env.TARGET_CHAT_ID;
const MASTER_SHEET_ID = process.env.MASTER_SHEET_ID;
const TAB_NAME        = process.env.SHEET_TAB_NAME || "2026 Ad Overview";

// Placeholder values that haven't been filled in yet (to skip writing to that sheet)
const PLACEHOLDER_PATTERN = /^SHEET_ID_/;

/**
 * Build the row array matching the Master Revenue Sheet "2026 Ad Overview" tab:
 *
 *  A: Forwarded   — left blank (checkbox, VA ticks manually)
 *  B: Client Name — parsed client
 *  C: Ad Type     — parsed category
 *  D: Date        — message date  e.g. "Thu 3/5/26"
 *  E: Time (MST)  — time from PAGE INFO  e.g. "4:45 PM"
 *  F: Page        — @pageHandle
 *  G: Bulk #      — left blank (manual)
 *  H: Page Ad Price — "$750"
 *  I: Status      — left blank (manual)
 *  J: Views       — left blank (filled in later)
 *  K: NIF         — NIF/duration from INSTRUCTIONS  e.g. "30min NIF"
 */
function buildRow(parsed) {
  return [
    "",                                          // A: Forwarded (checkbox — skip)
    parsed.client,                               // B: Client Name
    parsed.category,                             // C: Ad Type
    parsed.datePosted,                           // D: Date
    parsed.timeMST || "",                        // E: Time (MST)
    parsed.pageHandle ? `@${parsed.pageHandle}` : "", // F: Page
    "",                                          // G: Bulk # (manual)
    parsed.adPrice ? `$${parsed.adPrice}` : "",  // H: Page Ad Price
    "",                                          // I: Status (manual)
    "",                                          // J: Views (manual)
    parsed.nif || "",                            // K: NIF
  ];
}

/**
 * Main handler — called by the Telegraf bot for every incoming message.
 */
async function handleAdMessage(ctx) {
  try {
    const chatId = String(ctx.chat?.id);

    // Only process messages from the target group
    if (TARGET_CHAT_ID && chatId !== String(TARGET_CHAT_ID)) return;

    const text = ctx.message?.text || ctx.message?.caption;
    if (!text) return;

    const date   = ctx.message?.date ? new Date(ctx.message.date * 1000) : new Date();
    const parsed = parseAdMessage(text, date);

    // Not an ad message — ignore silently
    if (!parsed) return;

    // Normalise to array so multi-page and single-page use the same code path
    const parsedList = Array.isArray(parsed) ? parsed : [parsed];

    console.log(
      `[adHandler] Ad detected: "${parsedList[0].client}" / ${parsedList[0].category}` +
      (parsedList.length > 1
        ? ` — ${parsedList.length} pages (bulk ad)`
        : ` / $${parsedList[0].adPrice}` + (parsedList[0].pageHandle ? ` → @${parsedList[0].pageHandle}` : " (no page handle)"))
    );

    // ── Write to Master Revenue Sheet ──────────────────────────────────────────
    if (MASTER_SHEET_ID && !PLACEHOLDER_PATTERN.test(MASTER_SHEET_ID)) {
      let successCount = 0;
      for (const item of parsedList) {
        const row = buildRow(item);
        try {
          await appendRow(MASTER_SHEET_ID, TAB_NAME, row);
          successCount++;
        } catch (err) {
          console.error(`[adHandler] ❌ Master sheet write error for @${item.pageHandle}: ${err.message}`);
          console.error(err.stack);
        }
      }
      console.log(`[adHandler] ✅ Master sheet: wrote ${successCount}/${parsedList.length} row(s) (tab: "${TAB_NAME}")`);
    } else {
      console.warn("[adHandler] MASTER_SHEET_ID not configured — skipping master sheet.");
    }

    const results = [];

    // ── Write to individual page revenue sheet ─────────────────────────────────
    // 🚧 DISABLED during A/B test phase — master sheet only for now.
    // Re-enable once master sheet output is validated against the manual process.
    /*
    if (parsed.pageHandle) {
      const sheetId = pages[parsed.pageHandle];

      if (sheetId && !PLACEHOLDER_PATTERN.test(sheetId)) {
        try {
          await appendRow(sheetId, TAB_NAME, row);
          results.push(`✅ @${parsed.pageHandle} sheet`);
        } catch (err) {
          console.error(
            `[adHandler] Individual sheet write error for @${parsed.pageHandle}: ${err.message}`
          );
          results.push(`❌ @${parsed.pageHandle} sheet (error — check share permissions)`);
        }
      } else if (!sheetId) {
        console.warn(
          `[adHandler] No sheet ID mapped for @${parsed.pageHandle}. Add it to config/pages.json.`
        );
        results.push(`⚠️ @${parsed.pageHandle} (no sheet mapped — update pages.json)`);
      } else {
        // Has a placeholder value
        results.push(`⚠️ @${parsed.pageHandle} (sheet ID is a placeholder — update pages.json)`);
      }
    }
    */

    // ── Optional: reply in the chat with a status update ──────────────────────
    // Uncomment the block below if you want the bot to silently confirm each write.
    // (Keep it commented for production to avoid spamming the group.)
    /*
    const summary = results.join("\n");
    await ctx.reply(
      `📊 Revenue logged for *${parsed.client}* ($${parsed.adPrice})\n${summary}`,
      { parse_mode: "Markdown", reply_to_message_id: ctx.message.message_id }
    );
    */

  } catch (err) {
    console.error("[adHandler] Unhandled error:", err.message);
  }
}

module.exports = { handleAdMessage };
