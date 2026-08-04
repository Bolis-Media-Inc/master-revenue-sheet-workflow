/**
 * handlers/creativeReplyHandler.js — "reply to a brief with a creative to
 * add it" shortcut.
 *
 * Why this exists:
 *   Operators (Connor, Ivan, Danielson) routinely realize AFTER posting a
 *   brief that they forgot a creative for one page, or want to swap one in.
 *   Their instinct was to DELETE the whole brief and re-send it — but
 *   Telegram never tells the bot about deletions, so the re-send becomes a
 *   second brief and (because the creative is no longer above it) forwards
 *   empty content. The Stake Day 19 disaster.
 *
 *   This handler gives them the clean path: reply to the brief with the
 *   creative file named `@<page>.<ext>` (or caption starting `@<page>`). The
 *   bot forwards just that creative to that page's IG Ads chat and records
 *   it on the brief's page row so a later /replay includes it.
 *
 * Trigger conditions (ALL must hold):
 *   1. The message is a REPLY (reply_to_message present).
 *   2. The message carries media (photo / video / document / animation).
 *   3. The replied-to message parses as a brief (parseAdMessage succeeds).
 *   4. A target @handle is derivable from the file name or caption AND is in
 *      that brief's page list.
 *
 * Returns true if it consumed the message (so the caller short-circuits),
 * false otherwise (message flows on to the normal handlers).
 *
 * Wired into bot.on("message") in index.js BEFORE handleAdMessage.
 */

const { parseAdMessage } = require("../parser");
const pagesRegistry      = require("../lib/pages");
const adBriefs           = require("../lib/adBriefs");

// Mirror adHandler's gate: a page is "enabled" if ENABLED_PAGES=* OR the
// page has auto-forward turned on in the registry.
const ENABLED_PAGES_ALL = (process.env.ENABLED_PAGES || "").trim() === "*";
const isPageEnabled = (handle) =>
  !!handle && (ENABLED_PAGES_ALL || pagesRegistry.getAutoForward(handle));

function _mediaRef(msg) {
  if (!msg) return null;
  if (msg.photo?.length)  return { file_id: msg.photo[msg.photo.length - 1].file_id, kind: "photo" };
  if (msg.video)          return { file_id: msg.video.file_id,     kind: "video" };
  if (msg.document)       return { file_id: msg.document.file_id,  kind: "document" };
  if (msg.animation)      return { file_id: msg.animation.file_id, kind: "animation" };
  return null;
}

// Source ads chat(s) — the ONLY place this shortcut is active. Operators post
// briefs here and add creatives here. In page chats / DMs, sales people, VAs
// and clients reply to forwarded briefs with analytics screenshots, "got it",
// questions, etc. — replying there with a "name your creative" nag is pure
// noise (and forwarding a creative back into a page chat would be circular).
const SOURCE_CHATS = (process.env.TARGET_CHAT_ID || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

async function handleCreativeReply(ctx) {
  const msg = ctx.message;
  if (!msg) return false;

  // Gate to the source ads chat(s). Outside them, do nothing — the message
  // flows on to the normal (chat-gated) handlers, which ignore it.
  if (SOURCE_CHATS.length && !SOURCE_CHATS.includes(String(ctx.chat?.id))) return false;

  const replied = msg.reply_to_message;
  if (!replied) return false;

  const hasMedia = !!(msg.photo || msg.video || msg.document || msg.animation);
  if (!hasMedia) return false;

  // The replied-to message must itself be a brief.
  const repliedText = replied.text || replied.caption || "";
  if (!repliedText) return false;
  const parsed = parseAdMessage(repliedText, new Date());
  if (!parsed) return false;
  const parsedList = Array.isArray(parsed) ? parsed : [parsed];
  const briefHandles = new Set(
    parsedList.map((p) => p.pageHandle?.toLowerCase()).filter(Boolean),
  );
  if (briefHandles.size === 0) return false;

  // Derive the target handle: prefer the @<page>.<ext> filename, fall back
  // to a caption that starts with @<page>.
  const fileName = msg.document?.file_name || msg.video?.file_name || "";
  let handle = null;
  const fm = fileName.match(/^@([\w.]+?)(?:\s*\(\d+\))?\s*\.[a-zA-Z0-9]+$/);
  if (fm?.[1]) {
    handle = fm[1].toLowerCase().replace(/\.$/, "");
  } else {
    const cap = (msg.caption || "").trim();
    const cm = cap.match(/^@([\w.]+)/);
    if (cm?.[1]) handle = cm[1].toLowerCase();
  }

  // No handle anywhere → this is a reply-with-media but we can't tell where
  // it goes. Tell the operator how to target it rather than guessing.
  if (!handle) {
    await ctx.reply(
      "📎 Got a creative on that brief, but I couldn't tell which page it's for.\n" +
      "Name the file `@page.jpg`, or start the caption with `@page`. " +
      "(Or reply `/replay` to re-run the whole brief.)",
      { parse_mode: "Markdown", reply_to_message_id: msg.message_id },
    ).catch(() => {});
    return true;
  }

  const canonical = pagesRegistry.resolveHandle(handle) || handle;
  if (!briefHandles.has(canonical) && !briefHandles.has(handle)) {
    await ctx.reply(
      `⚠️ @${handle} isn't in that brief's page list — not forwarding. ` +
      `Double-check the handle, or add the page to the brief first.`,
      { reply_to_message_id: msg.message_id },
    ).catch(() => {});
    return true;
  }

  if (!isPageEnabled(canonical)) {
    await ctx.reply(`⚠️ @${canonical} is disabled — not forwarding.`,
      { reply_to_message_id: msg.message_id }).catch(() => {});
    return true;
  }

  const destChatId = pagesRegistry.getChatId(canonical);
  // Single-destination mode: per-page chats are off and the creative is already
  // in Internal Network Ads (where it was replied) — record it below, don't
  // re-forward it to a per-page chat.
  if (!process.env.RESULTS_CHAT_ID) {
    if (!destChatId) {
      await ctx.reply(`⚠️ No destination chat configured for @${canonical}.`,
        { reply_to_message_id: msg.message_id }).catch(() => {});
      return true;
    }

    // Forward the creative to the page's chat (preserves the original file).
    try {
      await ctx.telegram.forwardMessage(String(destChatId), ctx.chat.id, msg.message_id);
    } catch (err) {
      await ctx.reply(`❌ Couldn't forward to @${canonical}: ${err.message}`,
        { reply_to_message_id: msg.message_id }).catch(() => {});
      return true;
    }
  }

  await ctx.reply(`✅ Added creative → @${canonical}`,
    { reply_to_message_id: msg.message_id }).catch(() => {});

  // Best-effort: record the creative on the brief's page row so a later
  // /replay re-attaches it. Look up the brief by (chat, replied msg id);
  // append to page_media if the row exists.
  try {
    const sb = adBriefs._supabase;
    if (sb) {
      const brief = await adBriefs.findBriefByTelegramMessage(ctx.chat.id, replied.message_id);
      if (brief?.id) {
        const ref = _mediaRef(msg);
        const { data: pageRow } = await sb
          .from("ad_brief_pages")
          .select("id, page_media")
          .eq("brief_id", brief.id)
          .eq("page_handle", canonical)
          .maybeSingle();
        if (pageRow?.id && ref) {
          const media = Array.isArray(pageRow.page_media) ? pageRow.page_media : [];
          media.push(ref);
          await sb.from("ad_brief_pages")
            .update({ page_media: media })
            .eq("id", pageRow.id);
          console.log(`[creativeReply] 📎 Appended creative to @${canonical} page row (brief ${brief.id.slice(0, 8)}…)`);
        }
      }
    }
  } catch (err) {
    console.error(`[creativeReply] DB append (non-fatal): ${err.message}`);
  }

  console.log(`[creativeReply] ✅ Forwarded reply-creative → @${canonical} (dest ${destChatId})`);
  return true;
}

module.exports = { handleCreativeReply };
