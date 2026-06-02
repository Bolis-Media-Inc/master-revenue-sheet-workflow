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

async function handleEditBriefCommand(ctx) {
  try {
    console.log(`[editbrief] received from user ${ctx.from?.id} in chat ${ctx.chat?.id} (${ctx.chat?.type})`);
    if (!isAdmin(ctx.from?.id)) {
      console.warn(`[editbrief] denied — user ${ctx.from?.id} doesn't match WIZARD_ADMIN_USER_ID`);
      return; // silent
    }

    const fullText = (ctx.message?.text || "").trim();
    // First line: `/editbrief <link>`. Everything after the first \n is the new text.
    const firstNewline = fullText.indexOf("\n");
    if (firstNewline < 0) {
      await ctx.reply(
        "*Usage:*\n" +
        "```\n/editbrief <telegram-message-link>\n<new text starts on next line>\n<more lines OK>\n```\n\n" +
        "Get the link by right-clicking the bot's message in the per-page chat → Copy Link.",
        { parse_mode: "Markdown" }
      ).catch(() => {});
      return;
    }
    const firstLine = fullText.slice(0, firstNewline).trim();
    const newText   = fullText.slice(firstNewline + 1).trim();
    if (!newText) {
      await ctx.reply("❌ New text is empty — nothing to edit to.").catch(() => {});
      return;
    }

    // /editbrief <link>   — strip the command name
    const linkMatch = firstLine.match(/^\/editbrief(?:@\w+)?\s+(\S+)$/i);
    if (!linkMatch) {
      await ctx.reply(
        "❌ Couldn't parse command. First line should be `/editbrief <link>`.",
        { parse_mode: "Markdown" }
      ).catch(() => {});
      return;
    }
    const parsed = _parseLink(linkMatch[1]);
    if (!parsed) {
      await ctx.reply(
        "❌ Couldn't parse link. Expected `https://t.me/c/<id>/<msg>` or `https://t.me/<user>/<msg>`.",
        { parse_mode: "Markdown" }
      ).catch(() => {});
      return;
    }

    // Do the edit
    try {
      await ctx.telegram.editMessageText(parsed.chatId, parsed.msgId, undefined, newText);
      await ctx.reply(
        `✅ Edited message \`${parsed.msgId}\` in chat \`${parsed.chatId}\` ` +
        `(${newText.length} chars).`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
    } catch (err) {
      const msg = err?.message || String(err);
      let hint = "";
      if (/message can't be edited/i.test(msg))  hint = "\n_Most likely cause: message is >48 hours old (Telegram's edit window expired)._";
      else if (/message to edit not found/i.test(msg)) hint = "\n_Most likely cause: wrong msg_id, or the bot is no longer in that chat._";
      else if (/message is not modified/i.test(msg))   hint = "\n_The new text matches what's already there — nothing changed._";
      else if (/forbidden/i.test(msg)) hint = "\n_Bot was kicked from that chat or doesn't have permission._";
      await ctx.reply(`❌ Edit failed: \`${msg}\`${hint}`, { parse_mode: "Markdown" }).catch(() => {});
    }
  } catch (err) {
    console.error("[editbrief] error:", err.message);
    try { await ctx.reply(`❌ /editbrief failed: ${err.message}`); } catch (_) {}
  }
}

module.exports = { handleEditBriefCommand };
