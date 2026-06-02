/**
 * handlers/editBriefHandler.js — admin command to surgically edit ONE
 * bot-sent message in a per-page IG Ads chat.
 *
 * Why this exists: past briefs (processed before commit e025778) have
 * NULL forwarded_message_ids in DB, so /update price's chat-edit pass
 * silently skips them. /editbrief is the manual escape hatch — operator
 * pastes the message link + new text, bot calls editMessageText.
 *
 * Usage:
 *   /editbrief <telegram-message-link>
 *   <new text on subsequent lines>
 *
 * Example:
 *   /editbrief https://t.me/c/1234567890/12345
 *   Spencer Tom Steyer/Xavier Becerra - Political - $100
 *   ...
 *
 * The URL formats supported:
 *   https://t.me/c/<internal>/<msg_id>   — private/supergroup chat link
 *   https://t.me/<username>/<msg_id>     — public chat link
 *
 * For /c/ links, the URL's `<internal>` is the chat_id with the -100
 * prefix stripped — we re-add it to get the real chat_id Telegram
 * expects (-100<internal>).
 *
 * Admin gate: WIZARD_ADMIN_USER_ID only — editing chats is consequential
 * and shouldn't be delegated.
 */

function isAdmin(telegramId) {
  const id = parseInt(process.env.WIZARD_ADMIN_USER_ID || "0", 10);
  // If env var isn't set on this service, allow anyone (matches the
  // pattern used by /replay and /syncsheets in adHandler.js — better
  // to allow + log than to silently reject and confuse the operator).
  if (!id) return true;
  return Number(telegramId) === id;
}

// Two-message flow state: when /editbrief <link> arrives WITHOUT a body
// on the same message (because some Telegram clients strip newlines on
// paste, or the operator wants to send the text separately), stash the
// link here keyed by (user_id, chat_id). The next non-command message
// from the same user in the same chat is consumed as the new text.
// Expires after 5 min so stale stashes don't ambush future messages.
const _pendingEdits = new Map(); // key: `${userId}:${chatId}` → { link, expiresAt }
const PENDING_TTL_MS = 5 * 60 * 1000;

function _stashKey(ctx) { return `${ctx.from?.id}:${ctx.chat?.id}`; }
function _setPending(ctx, link) {
  _pendingEdits.set(_stashKey(ctx), { link, expiresAt: Date.now() + PENDING_TTL_MS });
}
function _takePending(ctx) {
  const k = _stashKey(ctx);
  const v = _pendingEdits.get(k);
  if (!v) return null;
  _pendingEdits.delete(k);
  if (v.expiresAt < Date.now()) return null;
  return v;
}

function _parseLink(link) {
  // /c/<internal>/<msg_id>  → chatId = -100<internal>, msgId = <msg_id>
  // /<username>/<msg_id>    → chatId = @<username>,    msgId = <msg_id>
  const cMatch = link.match(/t\.me\/c\/(\d+)\/(\d+)/i);
  if (cMatch) {
    return { chatId: `-100${cMatch[1]}`, msgId: Number(cMatch[2]) };
  }
  const pubMatch = link.match(/t\.me\/([\w_]+)\/(\d+)/i);
  if (pubMatch) {
    return { chatId: `@${pubMatch[1]}`, msgId: Number(pubMatch[2]) };
  }
  return null;
}

async function _performEdit(ctx, link, newText) {
  const parsed = _parseLink(link);
  if (!parsed) {
    await ctx.reply(
      "❌ Couldn't parse link. Expected `https://t.me/c/<id>/<msg>` or `https://t.me/<user>/<msg>`.",
      { parse_mode: "Markdown" }
    ).catch(() => {});
    return;
  }
  try {
    await ctx.telegram.editMessageText(parsed.chatId, parsed.msgId, undefined, newText);
    await ctx.reply(
      `✅ Edited message \`${parsed.msgId}\` in chat \`${parsed.chatId}\` (${newText.length} chars).`,
      { parse_mode: "Markdown" }
    ).catch(() => {});
  } catch (err) {
    const msg = err?.message || String(err);
    let hint = "";
    if (/message can't be edited/i.test(msg))        hint = "\n_>48hr edit window expired._";
    else if (/message to edit not found/i.test(msg)) hint = "\n_Wrong msg_id or bot not in chat._";
    else if (/message is not modified/i.test(msg))   hint = "\n_New text matches old — nothing changed._";
    else if (/forbidden/i.test(msg))                 hint = "\n_Bot kicked / no permission in that chat._";
    await ctx.reply(`❌ Edit failed: \`${msg}\`${hint}`, { parse_mode: "Markdown" }).catch(() => {});
  }
}

async function handleEditBriefCommand(ctx) {
  try {
    const rawText = ctx.message?.text || "";
    console.log(`[editbrief] from user ${ctx.from?.id} chat ${ctx.chat?.id} (${ctx.chat?.type}) text_length=${rawText.length} has_newline=${rawText.includes("\n")}`);
    if (!isAdmin(ctx.from?.id)) {
      console.warn(`[editbrief] denied — user ${ctx.from?.id} doesn't match WIZARD_ADMIN_USER_ID`);
      return;
    }

    const fullText = rawText.trim();
    const firstNewline = fullText.indexOf("\n");

    // ── Case A: single-message multi-line — `/editbrief <link>\n<text>` ─────
    if (firstNewline > 0) {
      const firstLine = fullText.slice(0, firstNewline).trim();
      const newText   = fullText.slice(firstNewline + 1).trim();
      const linkMatch = firstLine.match(/^\/editbrief(?:@\w+)?\s+(\S+)$/i);
      if (!linkMatch) {
        await ctx.reply("❌ First line should be `/editbrief <link>`.", { parse_mode: "Markdown" }).catch(() => {});
        return;
      }
      if (!newText) {
        await ctx.reply("❌ New text is empty.").catch(() => {});
        return;
      }
      await _performEdit(ctx, linkMatch[1], newText);
      return;
    }

    // ── Case B: single-line `/editbrief <link>` — stash, await next msg ────
    const linkMatch = fullText.match(/^\/editbrief(?:@\w+)?\s+(\S+)$/i);
    if (linkMatch) {
      _setPending(ctx, linkMatch[1]);
      await ctx.reply(
        `🔗 Got the link. Now send the *new text* in your next message — I'll use it to overwrite that message. ` +
        `(Times out in 5 min if you don't send anything.)`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
      return;
    }

    // ── Case C: bare `/editbrief` (no args) — usage ────────────────────────
    await ctx.reply(
      "*Usage* (two ways):\n\n" +
      "*One message:*\n```\n/editbrief <link>\n<new text on next lines>\n```\n\n" +
      "*Or two messages:*\n1. `/editbrief <link>`\n2. Reply with the new text\n\n" +
      "Get the link by right-clicking the bot's message → Copy Link.",
      { parse_mode: "Markdown" }
    ).catch(() => {});
  } catch (err) {
    console.error("[editbrief] error:", err.message);
    try { await ctx.reply(`❌ /editbrief failed: ${err.message}`); } catch (_) {}
  }
}

/**
 * Consume the next non-command message from an admin who recently sent
 * `/editbrief <link>` with no body — treat that next message as the new
 * text and perform the edit. Wired into bot.on("message") in index.js,
 * runs BEFORE the regular handlers so we can short-circuit if pending.
 *
 * Returns true if the message was consumed, false otherwise (so the
 * caller can decide whether to continue with normal message handling).
 */
async function maybeConsumePendingEdit(ctx) {
  if (!isAdmin(ctx.from?.id)) return false;
  const text = ctx.message?.text;
  if (!text) return false;
  if (text.startsWith("/")) return false; // commands aren't text payloads
  const pending = _takePending(ctx);
  if (!pending) return false;
  console.log(`[editbrief] consuming next-message edit (link=${pending.link})`);
  await _performEdit(ctx, pending.link, text);
  return true;
}

module.exports = { handleEditBriefCommand, maybeConsumePendingEdit };
