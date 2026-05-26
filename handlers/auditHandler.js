/**
 * handlers/auditHandler.js
 *
 * Handles audit / amendment commands sent as replies to original ad messages
 * inside the Internal Network Ads group.
 *
 * ── Commands (reply to the original ad message) ─────────────────────────────
 *
 *  price update @handle1 [@handle2 ...] $newprice
 *      Updates the Ad Price in the master sheet (col H) and individual page
 *      sheet (col G) for every listed handle.
 *      Multiple handles → same new price for all.
 *      Different prices per handle → use separate lines.
 *
 *  takedown @handle1 [@handle2 ...]
 *      Hard-deletes matching rows from the master sheet and individual page sheets.
 *
 *  creative update @handle1 [@handle2 ...]
 *      Forwards the media attached to this reply (the new creative) to each
 *      listed page's configured Telegram destination.
 *
 * ── Multi-command messages ───────────────────────────────────────────────────
 *  Multiple commands on separate lines in the same reply are all executed.
 *  e.g.
 *    price update @thefuck.tv @childhoodpost $600
 *    takedown @scooby
 *    creative update @thefuck.tv
 *
 * ── Bot reply ────────────────────────────────────────────────────────────────
 *  The bot replies in-thread confirming what was done (or warning if nothing matched).
 */

const { parseAdMessage }          = require("../parser");
const { updateAdPrice, deleteAdRows } = require("../sheets");
const pagesRegistry               = require("../lib/pages");

const TARGET_CHAT_ID = process.env.TARGET_CHAT_ID;
const MASTER_SHEET_ID = process.env.MASTER_SHEET_ID;
const TAB_NAME        = process.env.SHEET_TAB_NAME      || "2026 Ad Overview";
const PAGE_TAB_NAME   = process.env.PAGE_SHEET_TAB_NAME || "IG Revenue Tracker";

const PLACEHOLDER_PATTERN = /^(SHEET_ID_|TELEGRAM_CHAT_ID_)/;

const ENABLED_PAGES_RAW = process.env.ENABLED_PAGES || "";
const ENABLED_PAGES_ALL = ENABLED_PAGES_RAW.trim() === "*";
const ENABLED_PAGES_SET = new Set(
  ENABLED_PAGES_RAW.split(",").map((h) => h.trim().toLowerCase().replace(/^@/, "")).filter(Boolean)
);
const isPageEnabled = (h) => h && (ENABLED_PAGES_ALL || ENABLED_PAGES_SET.has(h.toLowerCase()));

// ── Command parsing ────────────────────────────────────────────────────────

/**
 * Extract all @handles from a string.
 * @param {string} str
 * @returns {string[]} lowercase handles without @
 */
function extractHandles(str) {
  return (str.match(/@([\w.]+)/g) || []).map((h) => h.slice(1).toLowerCase());
}

/**
 * Parse all audit commands from a (possibly multi-line) message text.
 *
 * Supported per line:
 *   price update @h1 [@h2 ...] $price
 *   takedown @h1 [@h2 ...]
 *   creative update @h1 [@h2 ...]
 *
 * @param {string} text
 * @returns {Array<{type: string, handles: string[], price?: string}>}
 */
function parseAuditCommands(text) {
  const commands = [];

  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {

    // price update @handle(s) $price
    const priceM = line.match(/^price\s+update\b([\s\S]+)/i);
    if (priceM) {
      const rest    = priceM[1];
      const priceV  = rest.match(/\$?([\d,]+)\s*$/);     // last number = the price
      const handles = extractHandles(rest);
      if (handles.length && priceV) {
        commands.push({
          type:    "price_update",
          handles,
          price:   `$${priceV[1].replace(/,/g, "")}`,
        });
      }
      continue;
    }

    // takedown @handle(s)
    const takedownM = line.match(/^takedown\b([\s\S]+)/i);
    if (takedownM) {
      const handles = extractHandles(takedownM[1]);
      if (handles.length) commands.push({ type: "takedown", handles });
      continue;
    }

    // creative update @handle(s)
    const creativeM = line.match(/^creative\s+update\b([\s\S]+)/i);
    if (creativeM) {
      const handles = extractHandles(creativeM[1]);
      if (handles.length) commands.push({ type: "creative_update", handles });
    }
  }

  return commands;
}

// ── Main handler ───────────────────────────────────────────────────────────

async function handleAuditCommand(ctx) {
  try {
    const chatId = String(ctx.chat?.id);
    if (TARGET_CHAT_ID && chatId !== String(TARGET_CHAT_ID)) return;

    // Must be a reply to another message
    const replyTo = ctx.message?.reply_to_message;
    if (!replyTo) return;

    const text = (ctx.message?.text || ctx.message?.caption || "").trim();
    if (!text) return;

    // Parse commands — if none found, silently ignore (not an audit command)
    const commands = parseAuditCommands(text);
    if (commands.length === 0) return;

    // Get the client name from the original ad (for sheet matching)
    const replyText     = (replyTo.text || replyTo.caption || "").trim();
    const originalParsed = replyText ? parseAdMessage(replyText, new Date()) : null;
    const firstParsed    = Array.isArray(originalParsed) ? originalParsed[0] : originalParsed;
    const clientName     = firstParsed?.client || null;

    console.log(
      `[auditHandler] ${commands.length} command(s) detected` +
      (clientName ? ` for "${clientName}"` : " (could not parse client from reply)")
    );

    const replyLines = []; // confirmation lines accumulated across all commands

    for (const cmd of commands) {

      // ── price update ──────────────────────────────────────────────────────
      if (cmd.type === "price_update") {
        for (const handle of cmd.handles) {
          let masterUpdated = 0;
          let pageUpdated   = 0;

          try {
            if (MASTER_SHEET_ID && !PLACEHOLDER_PATTERN.test(MASTER_SHEET_ID)) {
              masterUpdated = await updateAdPrice(
                MASTER_SHEET_ID, TAB_NAME, [handle], clientName, cmd.price, true
              );
            }
          } catch (err) {
            console.error(`[auditHandler] ❌ price update master @${handle}: ${err.message}`);
          }

          try {
            if (isPageEnabled(handle)) {
              const sheetId = pagesRegistry.getSheetId(handle);
              if (sheetId && !PLACEHOLDER_PATTERN.test(sheetId)) {
                pageUpdated = await updateAdPrice(
                  sheetId, PAGE_TAB_NAME, [handle], clientName, cmd.price, false
                );
              }
            }
          } catch (err) {
            console.error(`[auditHandler] ❌ price update page sheet @${handle}: ${err.message}`);
          }

          const total = masterUpdated + pageUpdated;
          if (total > 0) {
            replyLines.push(
              `✅ Price updated @${handle} → ${cmd.price}` +
              (clientName ? ` (${clientName})` : "") +
              ` — ${total} row(s)`
            );
            console.log(`[auditHandler] ✅ Price updated @${handle} → ${cmd.price} (${total} rows)`);
          } else {
            replyLines.push(`⚠️ No rows found for @${handle}${clientName ? ` / ${clientName}` : ""}`);
          }
        }
      }

      // ── takedown ──────────────────────────────────────────────────────────
      else if (cmd.type === "takedown") {
        for (const handle of cmd.handles) {
          let masterDeleted = 0;
          let pageDeleted   = 0;

          try {
            if (MASTER_SHEET_ID && !PLACEHOLDER_PATTERN.test(MASTER_SHEET_ID)) {
              masterDeleted = await deleteAdRows(
                MASTER_SHEET_ID, TAB_NAME, [handle], clientName, true
              );
            }
          } catch (err) {
            console.error(`[auditHandler] ❌ takedown master @${handle}: ${err.message}`);
          }

          try {
            if (isPageEnabled(handle)) {
              const sheetId = pagesRegistry.getSheetId(handle);
              if (sheetId && !PLACEHOLDER_PATTERN.test(sheetId)) {
                pageDeleted = await deleteAdRows(
                  sheetId, PAGE_TAB_NAME, [handle], clientName, false
                );
              }
            }
          } catch (err) {
            console.error(`[auditHandler] ❌ takedown page sheet @${handle}: ${err.message}`);
          }

          const total = masterDeleted + pageDeleted;
          if (total > 0) {
            replyLines.push(
              `🗑️ Takedown @${handle}` +
              (clientName ? ` (${clientName})` : "") +
              ` — ${total} row(s) deleted`
            );
            console.log(`[auditHandler] 🗑️ Deleted @${handle} (${total} rows)`);
          } else {
            replyLines.push(`⚠️ No rows found for @${handle}${clientName ? ` / ${clientName}` : ""}`);
          }
        }
      }

      // ── creative update ───────────────────────────────────────────────────
      else if (cmd.type === "creative_update") {
        // The new creative must be attached to this reply message (photo, video, or document)
        const hasMedia = !!(
          ctx.message?.photo   ||
          ctx.message?.video   ||
          ctx.message?.document ||
          ctx.message?.animation
        );

        if (!hasMedia) {
          replyLines.push(
            `⚠️ creative update: no media attached — attach the new creative to this reply`
          );
          continue;
        }

        for (const handle of cmd.handles) {
          const destChatId = pagesRegistry.getChatId(handle);

          if (!destChatId || PLACEHOLDER_PATTERN.test(String(destChatId))) {
            replyLines.push(`⚠️ No Telegram destination configured for @${handle}`);
            continue;
          }

          try {
            await ctx.telegram.forwardMessage(String(destChatId), chatId, ctx.message.message_id);
            replyLines.push(
              `✅ Creative forwarded to @${handle}` +
              (clientName ? ` (${clientName})` : "")
            );
            console.log(`[auditHandler] ✅ Creative forwarded to @${handle} → ${destChatId}`);
          } catch (err) {
            replyLines.push(`❌ Failed to forward to @${handle}: ${err.message}`);
            console.error(`[auditHandler] ❌ creative forward @${handle}: ${err.message}`);
          }
        }
      }
    }

    // Send a single consolidated reply
    if (replyLines.length > 0) {
      await ctx.reply(replyLines.join("\n"), {
        reply_to_message_id: ctx.message.message_id,
      });
    }

  } catch (err) {
    console.error("[auditHandler] Unhandled error:", err.message);
  }
}

module.exports = { handleAuditCommand };
