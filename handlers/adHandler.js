/**
 * handlers/adHandler.js
 * Called for every message in the Internal Network Ads group.
 *
 * Flow:
 *  1. Parse the message text for ad structure
 *  2. Build the row (matches columns in the revenue sheets)
 *  3. Append to Master Revenue Sheet (always)
 *  4. Append to the individual page's revenue sheet (if handle is known in pages.json)
 *  5. Forward the ad content + brief to each page's Telegram destination (if configured)
 *  6. Reply with a ✅ confirmation (or stay silent if not an ad)
 */

const { parseAdMessage }       = require("../parser");
const { appendRow, getLastDate, appendSeparatorRow, updateStatusToLive } = require("../sheets");
const { getPrecedingMessages } = require("../messageBuffer");
const pages                    = require("../config/pages.json");
const destinations             = require("../config/telegram-destinations.json");

const TARGET_CHAT_ID  = process.env.TARGET_CHAT_ID;
const MASTER_SHEET_ID = process.env.MASTER_SHEET_ID;
const TAB_NAME        = process.env.SHEET_TAB_NAME || "2026 Ad Overview";

// How many messages before the ad brief to grab as content (image / video / copy)
const CONTENT_MESSAGES_TO_FORWARD = parseInt(process.env.FORWARD_PRECEDING_COUNT || "2");

// Set FORWARDING_ENABLED=true in env to turn on forwarding
const FORWARDING_ENABLED = (process.env.FORWARDING_ENABLED || "").toLowerCase() === "true";

// Placeholder values that haven't been filled in yet (to skip writing to that sheet)
const PLACEHOLDER_PATTERN = /^(SHEET_ID_|TELEGRAM_CHAT_ID_)/;

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
    "",                                               // A: Forwarded (checkbox — skip)
    parsed.client,                                    // B: Client Name
    parsed.category,                                  // C: Ad Type
    parsed.datePosted,                                // D: Date
    parsed.timeMST || "",                             // E: Time (MST)
    parsed.pageHandle ? `@${parsed.pageHandle}` : "", // F: Page
    parsed.bulkNum || "",                             // G: Bulk # (e.g. "11/15")
    parsed.adPrice ? `$${parsed.adPrice}` : "",       // H: Page Ad Price
    "Scheduled",                                      // I: Status — default on insert
    "",                                               // J: Views (filled manually later)
    parsed.nif || "",                                 // K: NIF
  ];
}

/**
 * Forward the ad content (preceding messages) + the ad brief itself
 * to the Telegram destination for a single page handle.
 *
 * Uses forwardMessage so media + original sender info are preserved.
 *
 * @param {object} telegram        ctx.telegram (Telegraf Telegram instance)
 * @param {string} sourceChatId    The group the ad came from
 * @param {number} adMessageId     The ad brief's message_id
 * @param {Array}  precedingMsgs   The content messages (image/video) before the ad
 * @param {string} destChatId      Destination Telegram chat ID (page's group/DM)
 * @param {string} pageHandle      For logging
 */
async function forwardToPage(telegram, sourceChatId, adMessageId, precedingMsgs, destChatId, pageHandle) {
  const results = [];

  // Forward content messages first (oldest → newest), then the ad brief
  const messagesToForward = [...precedingMsgs, { message_id: adMessageId, _isAdBrief: true }];

  for (const msg of messagesToForward) {
    try {
      await telegram.forwardMessage(
        destChatId,       // to
        sourceChatId,     // from chat
        msg.message_id    // message to forward
      );
      results.push(`✅ msg ${msg.message_id}`);
    } catch (err) {
      results.push(`❌ msg ${msg.message_id}: ${err.message}`);
    }
  }

  console.log(`[adHandler] Forward @${pageHandle} → ${destChatId}: ${results.join(", ")}`);
  return results;
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

    // ── "Posted on" reply → flip matching rows from Scheduled → Live ───────────
    if (/^posted on\b/i.test(text.trim())) {
      const handles = text.split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("@"))
        .map((l) => l.match(/^@([\w.]+)/)?.[1])
        .filter(Boolean);

      // If this is a Telegram reply, parse the original ad to get the client name
      // so we only flip rows for that specific campaign (not all Scheduled rows with matching pages)
      let clientName = null;
      const replyText = ctx.message?.reply_to_message?.text || ctx.message?.reply_to_message?.caption;
      if (replyText) {
        const originalParsed = parseAdMessage(replyText, new Date());
        const first = Array.isArray(originalParsed) ? originalParsed[0] : originalParsed;
        if (first?.client) {
          clientName = first.client;
          console.log(`[adHandler] "Posted on" linked to campaign: "${clientName}"`);
        }
      }

      if (handles.length > 0 && MASTER_SHEET_ID) {
        try {
          const updated = await updateStatusToLive(MASTER_SHEET_ID, TAB_NAME, handles, clientName);
          console.log(`[adHandler] ✅ "Posted on" — marked ${updated} row(s) as Live${clientName ? ` for "${clientName}"` : " (no campaign filter)"}`);
        } catch (err) {
          console.error(`[adHandler] ❌ "Posted on" update error: ${err.message}`);
        }
      }
      return;
    }

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

      // Insert a black separator row if the date has changed since the last entry
      try {
        const lastDate = await getLastDate(MASTER_SHEET_ID, TAB_NAME);
        const newDate  = parsedList[0].datePosted.replace(/,/g, "").trim();
        if (lastDate && lastDate !== newDate) {
          await appendSeparatorRow(MASTER_SHEET_ID, TAB_NAME);
          console.log(`[adHandler] 📅 New day detected (${lastDate} → ${newDate}) — separator row inserted`);
        }
      } catch (err) {
        console.warn(`[adHandler] ⚠️ Could not insert separator row: ${err.message}`);
      }

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

    // ── Forward content + ad brief to each page's Telegram destination ─────────
    if (FORWARDING_ENABLED && !destinations._forwarding_disabled_globally) {

      const adMessageId = ctx.message.message_id;
      const sourceChatId = chatId;

      // Grab the N messages that came before this ad brief
      const precedingMsgs = getPrecedingMessages(sourceChatId, adMessageId, CONTENT_MESSAGES_TO_FORWARD);
      console.log(`[adHandler] 📤 Forwarding enabled — found ${precedingMsgs.length} preceding message(s) to include`);

      // Deduplicate page handles (bulk ads list the same handle at most once,
      // but let's be safe)
      const uniqueHandles = [...new Set(parsedList.map((p) => p.pageHandle).filter(Boolean))];

      let forwardOk = 0;
      let forwardSkipped = 0;

      for (const handle of uniqueHandles) {
        const destChatId = destinations[handle];

        if (!destChatId || PLACEHOLDER_PATTERN.test(String(destChatId))) {
          console.warn(`[adHandler] ⚠️ No Telegram destination configured for @${handle} — skipping forward`);
          forwardSkipped++;
          continue;
        }

        try {
          await forwardToPage(
            ctx.telegram,
            sourceChatId,
            adMessageId,
            precedingMsgs,
            String(destChatId),
            handle
          );
          forwardOk++;
        } catch (err) {
          console.error(`[adHandler] ❌ Forward error for @${handle}: ${err.message}`);
        }
      }

      console.log(
        `[adHandler] 📤 Forward summary: ${forwardOk} sent, ${forwardSkipped} skipped (no destination configured)`
      );
    }

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
