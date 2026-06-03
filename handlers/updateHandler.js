/**
 * handlers/updateHandler.js — Unified /update command (task #31)
 *
 * Replaces the keyword-style audit commands (price update / takedown /
 * creative update) with a single discoverable slash command + a richer
 * set of subcommands that update DB, sheets, AND chat copies.
 *
 *   /update price @handle $X            — change a page's price everywhere
 *   /update name <new campaign name>    — rename brief client (TODO)
 *   /update creative @handle            — flag for creative refresh (TODO)
 *   /update takedown @handle            — pull rows (TODO)
 *   /update sponsor @newhandle          — change sponsor handle (TODO)
 *
 * Why this matters vs. the old keyword commands:
 *   • Discoverable: typing /u in Telegram autocompletes; price update is invisible
 *   • Single source of truth for sheet + DB + chat sync (old commands only hit sheets)
 *   • Edits the forwarded brief in each per-page IG Ads chat so the team
 *     sees the new price/name immediately (within Telegram's 48-hr edit window)
 *
 * Backwards compat: handlers/auditHandler.js still handles the old
 * keyword-style commands; they call into this module's subcommand fns
 * so behavior stays consistent.
 *
 * Reply-mode required — must be a reply to the brief message so we can
 * uniquely identify which ad_briefs row to mutate.
 */

const adBriefs       = require("../lib/adBriefs");
const pagesRegistry  = require("../lib/pages");
const sheetsLib      = require("../sheets");
const { parseAdMessage } = require("../parser");

const TARGET_CHAT_IDS = new Set(
  (process.env.TARGET_CHAT_IDS || process.env.TARGET_CHAT_ID || "")
    .split(",").map((s) => s.trim()).filter(Boolean)
);
const MASTER_SHEET_ID = process.env.MASTER_SHEET_ID;
const MASTER_TAB_NAME = process.env.SHEET_TAB_NAME      || "2026 Ad Overview";
const PAGE_TAB_NAME   = process.env.PAGE_SHEET_TAB_NAME || "IG Revenue Tracker";

// ── Helpers ──────────────────────────────────────────────────────────────────

function _extractHandles(str) {
  return (str.match(/@([\w.]+)/g) || []).map((h) => h.slice(1).toLowerCase());
}

function _md(text) {
  if (text == null) return "";
  return String(text).replace(/[_*`\[\]]/g, (c) => "\\" + c);
}

/**
 * Edit each forwarded brief in per-page chats by running a text mutation
 * over the original brief text. Skips silently when:
 *   • The forwarded message is > 48 hours old (Telegram rejects edit)
 *   • The chat isn't reachable (bot was kicked, chat deleted)
 *   • No replacement was needed (mutator returned same text)
 *
 * Returns { edited, skipped, failed }.
 */
async function _editForwardedBriefs(ctx, brief, pages, mutator) {
  let edited = 0, skipped = 0, failed = 0;
  for (const p of pages) {
    if (!p.forwarded_message_ids || p.forwarded_message_ids.length === 0) {
      skipped++; continue;
    }
    const destChatId = pagesRegistry.getChatId(p.page_handle);
    if (!destChatId) { skipped++; continue; }
    // The brief forward is the LAST forwarded message (sent after the media).
    const briefFwdMsgId = p.forwarded_message_ids[p.forwarded_message_ids.length - 1];
    const newText = mutator(brief.raw_text);
    if (newText === brief.raw_text) { skipped++; continue; }
    try {
      await ctx.telegram.editMessageText(
        String(destChatId), Number(briefFwdMsgId), undefined, newText
      );
      edited++;
    } catch (err) {
      // 48-hr edit window expired, or message not editable — log + continue
      const msg = err?.message || String(err);
      if (/message can't be edited|message is not modified|message to edit not found/i.test(msg)) {
        skipped++;
      } else {
        console.error(`[update] edit fwd @${p.page_handle} (chat ${destChatId} msg ${briefFwdMsgId}): ${msg}`);
        failed++;
      }
    }
  }
  return { edited, skipped, failed };
}

// ── Subcommand: price ────────────────────────────────────────────────────────

/**
 * /update price @handle $newPrice
 *
 * Sheets: updates Master + per-page Price column for matching rows
 * DB:     updates ad_brief_pages.page_price
 * Chat:   edits the forwarded brief in each affected page chat,
 *         swapping "@handle - $oldPrice" → "@handle - $newPrice"
 */
async function updatePrice(ctx, brief, briefPages, handles, newPrice) {
  const replies = [];
  for (const handle of handles) {
    const norm = handle.toLowerCase().replace(/^@/, "");
    // Sheets
    let masterRows = 0, pageRows = 0;
    try {
      if (MASTER_SHEET_ID) {
        masterRows = await sheetsLib.updateAdPrice(
          MASTER_SHEET_ID, MASTER_TAB_NAME, [norm], brief.client, `$${newPrice}`, true,
        );
      }
    } catch (err) {
      console.error(`[update price] master @${norm}: ${err.message}`);
    }
    const pgSheetId = pagesRegistry.getSheetId(norm);
    if (pgSheetId) {
      try {
        pageRows = await sheetsLib.updateAdPrice(
          pgSheetId, PAGE_TAB_NAME, [norm], brief.client, `$${newPrice}`, false,
        );
      } catch (err) {
        console.error(`[update price] page @${norm}: ${err.message}`);
      }
    }
    // DB
    let dbUpdated = 0;
    if (adBriefs._supabase) {
      try {
        const { data, error } = await adBriefs._supabase
          .from("ad_brief_pages")
          .update({ page_price: Number(newPrice) })
          .eq("brief_id", brief.id)
          .ilike("page_handle", norm)
          .select("id");
        if (error) throw new Error(error.message);
        dbUpdated = data?.length || 0;
      } catch (err) {
        console.error(`[update price] DB @${norm}: ${err.message}`);
      }
    }
    replies.push(
      `*@${_md(norm)}* → \$${newPrice}: ` +
      `Master ${masterRows} · Per-page ${pageRows} · DB ${dbUpdated}`
    );
  }

  // Chat edits — rewrite each forwarded brief with all updated prices
  const handlesLc = handles.map((h) => h.toLowerCase().replace(/^@/, ""));
  const affectedPages = briefPages.filter((p) => handlesLc.includes(p.page_handle.toLowerCase()));
  const editResult = await _editForwardedBriefs(ctx, brief, affectedPages, (text) => {
    let newText = text;
    for (const h of handlesLc) {
      // Match "@handle - $XXX" with optional commas in the number; preserve formatting
      const re = new RegExp(`(@${h.replace(/[.\-]/g, '\\$&')}\\s*-\\s*\\$)[\\d,]+(?:\\.\\d{1,2})?`, "g");
      newText = newText.replace(re, `$1${newPrice}`);
    }
    return newText;
  });

  return {
    replies,
    chatEdits: editResult,
  };
}

// ── Subcommand: name (rename campaign client) ────────────────────────────────

/**
 * /update name <new campaign name>
 *
 * Sheets: updates Master Client column + per-page Client column for all rows
 * DB:     updates ad_briefs.client + raw_text (regex-replace first line)
 * Chat:   edits the forwarded brief in each affected page chat
 */
async function updateName(ctx, brief, briefPages, newName) {
  if (!brief.client) {
    return { error: "brief has no client name to rename — nothing to do" };
  }
  const oldName = brief.client;
  if (oldName === newName) {
    return { error: `client is already "${newName}"` };
  }

  // Sheets — Master + each per-page sheet
  let masterRows = 0, pageRows = 0;
  const handles = briefPages.map((p) => p.page_handle);
  try {
    if (MASTER_SHEET_ID) {
      masterRows = await sheetsLib.updateAdClient(
        MASTER_SHEET_ID, MASTER_TAB_NAME, handles, oldName, newName, true,
      );
    }
  } catch (err) {
    console.error(`[update name] master: ${err.message}`);
  }
  for (const p of briefPages) {
    const pgSheetId = pagesRegistry.getSheetId(p.page_handle);
    if (!pgSheetId) continue;
    try {
      const n = await sheetsLib.updateAdClient(
        pgSheetId, PAGE_TAB_NAME, [], oldName, newName, false,
      );
      pageRows += n;
    } catch (err) {
      console.error(`[update name] page @${p.page_handle}: ${err.message}`);
    }
  }

  // DB — brief row
  let dbUpdated = 0;
  if (adBriefs._supabase) {
    try {
      const newRawText = (brief.raw_text || "").replace(
        new RegExp(oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
        newName,
      );
      const { data, error } = await adBriefs._supabase
        .from("ad_briefs")
        .update({ client: newName, raw_text: newRawText })
        .eq("id", brief.id)
        .select("id");
      if (error) throw new Error(error.message);
      dbUpdated = data?.length || 0;
    } catch (err) {
      console.error(`[update name] DB: ${err.message}`);
    }
  }

  // Chat edits — swap oldName for newName in each forwarded brief
  const editResult = await _editForwardedBriefs(ctx, brief, briefPages, (text) =>
    text.replace(
      new RegExp(oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
      newName,
    )
  );

  return {
    replies: [
      `*Name:* \`${_md(oldName)}\` → \`${_md(newName)}\`\n` +
      `  Master ${masterRows} · Per-page ${pageRows} · DB ${dbUpdated}`,
    ],
    chatEdits: editResult,
  };
}

// ── Subcommand: takedown (remove page from a brief) ──────────────────────────

/**
 * /update takedown @page [@page…]
 *
 * Full removal of one or more pages from a brief — touches every surface:
 *   1. Delete the bot's forwarded brief in @page's IG Ads chat
 *      (uses forwarded_message_ids; fail-soft if NULL or >48h)
 *   2. Delete Master sheet row for @page in this brief
 *   3. Delete @page's per-page sheet row
 *   4. Delete ad_brief_pages row in DB
 *   5. Decrement ad_briefs.total_price by @page's price
 *
 * OTHER per-page chats are NOT edited — each per-page brief copy is
 * already isolated to its own page (the rewrite shows only that page's
 * line + that page's price), so removing @page doesn't affect them.
 */
async function updateTakedown(ctx, brief, briefPages, handles) {
  const replies = [];
  const chatEdits = { edited: 0, skipped: 0, failed: 0 };
  let runningTotal = Number(brief.total_price || 0);

  for (const handle of handles) {
    const norm = handle.toLowerCase().replace(/^@/, "");
    const pageRow = briefPages.find((p) => p.page_handle.toLowerCase() === norm);
    if (!pageRow) {
      replies.push(`⚠️ *@${_md(norm)}* not in this brief — skipping`);
      continue;
    }

    // 1. Delete the bot's forwarded brief in the page's IG Ads chat
    let chatDeleted = false;
    let chatNote = "no msg_id";
    if (pageRow.forwarded_message_ids?.length) {
      const briefMsgId = pageRow.forwarded_message_ids[pageRow.forwarded_message_ids.length - 1];
      const destChatId = pagesRegistry.getChatId(norm);
      if (destChatId) {
        try {
          await ctx.telegram.deleteMessage(String(destChatId), Number(briefMsgId));
          chatDeleted = true;
          chatEdits.edited++;
          chatNote = "deleted";
        } catch (err) {
          const msg = err?.message || String(err);
          if (/can't be deleted|message to delete not found/i.test(msg)) {
            chatEdits.skipped++;
            chatNote = ">48h or already gone";
          } else {
            chatEdits.failed++;
            chatNote = `err: ${msg.slice(0, 40)}`;
            console.error(`[update takedown] delete msg @${norm}: ${msg}`);
          }
        }
      } else {
        chatEdits.skipped++;
        chatNote = "no chat_id configured";
      }
    } else {
      chatEdits.skipped++;
    }

    // 2. Delete Master sheet row
    let masterDel = 0;
    try {
      if (MASTER_SHEET_ID) {
        masterDel = await sheetsLib.deleteAdRows(MASTER_SHEET_ID, MASTER_TAB_NAME, [norm], brief.client, true);
      }
    } catch (err) {
      console.error(`[update takedown] master sheet @${norm}: ${err.message}`);
    }

    // 3. Delete @page's per-page sheet row
    let pageDel = 0;
    const pgSheetId = pagesRegistry.getSheetId(norm);
    if (pgSheetId) {
      try {
        pageDel = await sheetsLib.deleteAdRows(pgSheetId, PAGE_TAB_NAME, [norm], brief.client, false);
      } catch (err) {
        console.error(`[update takedown] per-page sheet @${norm}: ${err.message}`);
      }
    }

    // 4. Delete ad_brief_pages row in DB
    let dbDel = 0;
    if (adBriefs._supabase) {
      try {
        const { data, error } = await adBriefs._supabase
          .from("ad_brief_pages")
          .delete()
          .eq("brief_id", brief.id)
          .ilike("page_handle", norm)
          .select("id");
        if (error) throw new Error(error.message);
        dbDel = data?.length || 0;
      } catch (err) {
        console.error(`[update takedown] DB delete @${norm}: ${err.message}`);
      }
    }

    // 5. Decrement ad_briefs.total_price
    const removedPrice = Number(pageRow.page_price || 0);
    if (adBriefs._supabase && removedPrice > 0) {
      runningTotal = Math.max(0, runningTotal - removedPrice);
      try {
        await adBriefs._supabase
          .from("ad_briefs")
          .update({ total_price: runningTotal })
          .eq("id", brief.id);
        brief.total_price = runningTotal; // update local so subsequent handles see fresh
      } catch (err) {
        console.error(`[update takedown] update total_price: ${err.message}`);
      }
    }

    replies.push(
      `*@${_md(norm)}* removed ($${removedPrice}): ` +
      `Chat ${chatNote} · Master ${masterDel} · Per-page ${pageDel} · DB ${dbDel}`
    );
  }

  if (handles.length > 0 && replies.some((r) => /removed/.test(r))) {
    replies.push(`*New brief total:* $${runningTotal}`);
  }
  return { replies, chatEdits };
}

// ── Main entry — parses /update and dispatches ──────────────────────────────

/**
 * Entry point for `/update <subcommand> <args>`. Wired via bot.command in
 * index.js. Requires reply-to-brief for unambiguous brief identification.
 */
async function handleUpdateCommand(ctx) {
  try {
    // Only in target chats (don't fire in random groups)
    const chatId = String(ctx.chat?.id);
    if (TARGET_CHAT_IDS.size > 0 && !TARGET_CHAT_IDS.has(chatId)) {
      // Silent — operator likely typed /update in another chat; not for us
      return;
    }
    const replyTo = ctx.message?.reply_to_message;
    if (!replyTo) {
      await ctx.reply(
        "*/update* must be a reply to the brief.\n\n" +
        "Examples (reply to the brief, then type):\n" +
        "  `/update price @hitsblunt $250`\n" +
        "  `/update price @hitsblunt @dailyhoodposts $200`\n" +
        "  `/update name New Campaign Name`\n" +
        "  `/update takedown @oddlyhorrifying`\n" +
        "  `/update takedown @page1 @page2`\n\n" +
        "_Multi-line works — each line is processed as a separate command:_\n" +
        "```\n/update price @hitsblunt $250\n/update takedown @oddlyhorrifying\n```",
        { parse_mode: "Markdown" }
      ).catch(() => {});
      return;
    }
    const fullText = (ctx.message?.text || "").trim();
    // Multi-line: each `/update …` line is its own command. Matches the
    // legacy `price update / takedown / creative update` pattern. Necessary
    // to fix the "all handles got same price" bug from the single-command-
    // matches-multiple-lines parser.
    const updateLines = fullText
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^\/update(?:@\w+)?\s+/i.test(l));
    if (updateLines.length === 0) {
      await ctx.reply(
        "Usage: `/update <subcommand> <args>`\n" +
        "Subcommands: `price`, `name` (more coming: creative, takedown, sponsor)",
        { parse_mode: "Markdown" }
      ).catch(() => {});
      return;
    }

    // Look up brief once, share across all sub-commands
    const briefMessageId = replyTo.message_id;
    const sourceChatId   = ctx.chat.id;
    const brief = await adBriefs.findBriefByTelegramMessage(Number(sourceChatId), briefMessageId);
    if (!brief) {
      await ctx.reply(
        "❌ Couldn't find this brief in DB. The brief might be older than the bot's capture window."
      ).catch(() => {});
      return;
    }
    const briefPages = await adBriefs.getBriefPages(brief.id);

    // Run each /update line independently, accumulate results
    const allReplies = [];
    const totalChatEdits = { edited: 0, skipped: 0, failed: 0 };
    for (const line of updateLines) {
      const result = await _runOneUpdateLine(ctx, brief, briefPages, line);
      if (result?.replies) allReplies.push(...result.replies);
      if (result?.chatEdits) {
        totalChatEdits.edited  += result.chatEdits.edited;
        totalChatEdits.skipped += result.chatEdits.skipped;
        totalChatEdits.failed  += result.chatEdits.failed;
      }
      if (result?.error) allReplies.push(`⚠️ ${result.error}`);
    }
    const summary = [
      `✅ */update* — ${brief.client || "brief"} (${updateLines.length} cmd${updateLines.length === 1 ? "" : "s"})`,
      ...allReplies.map((l) => "  " + l),
      ``,
      `Chat edits: ${totalChatEdits.edited} edited · ${totalChatEdits.skipped} skipped (no edit needed or >48h) · ${totalChatEdits.failed} failed`,
    ];
    await ctx.reply(summary.join("\n"), { parse_mode: "Markdown" }).catch(() => {});
    return;
  } catch (err) {
    console.error("[update] error:", err.message);
    try { await ctx.reply(`❌ /update failed: ${err.message}`); } catch (_) {}
  }
}

/**
 * Parse + execute a single `/update <subcommand> <args>` line. Returns
 * { replies, chatEdits, error } for the caller to aggregate. Pulled out
 * of the main handler so multi-line invocations can loop cleanly.
 */
async function _runOneUpdateLine(ctx, brief, briefPages, line) {
  const m = line.match(/^\/update(?:@\w+)?\s+(\w+)\s+([\s\S]+)$/i);
  if (!m) return { error: `Couldn't parse: \`${line}\`` };
  const subcommand = m[1].toLowerCase();
  const argsStr    = m[2].trim();

  if (subcommand === "price") {
    const handles = _extractHandles(argsStr);
    const priceM = argsStr.match(/\$?([\d,]+(?:\.\d{1,2})?)\s*$/);
    if (!handles.length || !priceM) {
      return { error: `Bad syntax: \`${line}\` — expected \`/update price @handle [@handle…] $PRICE\`` };
    }
    const newPrice = priceM[1].replace(/,/g, "");
    return await updatePrice(ctx, brief, briefPages, handles, newPrice);
  }
  if (subcommand === "name") {
    const newName = argsStr.trim();
    if (!newName) return { error: `Bad syntax: \`${line}\` — expected \`/update name <new name>\`` };
    return await updateName(ctx, brief, briefPages, newName);
  }
  if (subcommand === "takedown") {
    const handles = _extractHandles(argsStr);
    if (!handles.length) return { error: `Bad syntax: \`${line}\` — expected \`/update takedown @handle [@handle…]\`` };
    return await updateTakedown(ctx, brief, briefPages, handles);
  }
  if (["creative", "sponsor"].includes(subcommand)) {
    return { error: `\`/update ${subcommand}\` — not yet implemented; use keyword form (\`${subcommand} update @handle\`)` };
  }
  return { error: `Unknown subcommand: \`${_md(subcommand)}\` (available: price, name)` };
}

module.exports = {
  handleUpdateCommand,
  // exported for reuse by handlers/auditHandler.js (backwards compat)
  updatePrice,
  updateName,
  updateTakedown,
};
