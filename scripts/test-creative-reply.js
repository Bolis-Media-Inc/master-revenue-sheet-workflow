#!/usr/bin/env node
/**
 * Tests for handleCreativeReply — the "reply to a brief with a creative
 * named @page.jpg to add it" shortcut.
 *
 * Stubs lib/pages + lib/adBriefs via require.cache so no DB/registry is
 * touched. parser.js is real.
 */

const path = require("path");

// ── Stub lib/pages ───────────────────────────────────────────────────────
const KNOWN = {
  moist:          { chatId: -1001, enabled: true },
  childhoodpost:  { chatId: -1002, enabled: true },
  "thefuck.tv":   { chatId: -1003, enabled: true },
  disabledpage:   { chatId: -1004, enabled: false },
};
require.cache[path.join(__dirname, "..", "lib", "pages.js")] = {
  id: "pages", filename: "pages", loaded: true,
  exports: {
    resolveHandle: (h) => (h ? h.toLowerCase() : h),
    getChatId: (h) => KNOWN[h?.toLowerCase()]?.chatId,
    getAutoForward: (h) => !!KNOWN[h?.toLowerCase()]?.enabled,
  },
};

// ── Stub lib/adBriefs (no DB) ──────────────────────────────────────────────
require.cache[path.join(__dirname, "..", "lib", "adBriefs.js")] = {
  id: "adBriefs", filename: "adBriefs", loaded: true,
  exports: { _supabase: null, findBriefByTelegramMessage: async () => null },
};

process.env.ENABLED_PAGES = ""; // exercise the per-page getAutoForward gate

const { handleCreativeReply } = require("../handlers/creativeReplyHandler");

const BRIEF_TEXT =
  "Stake BET SLIP Day 19 - Affiliate - $3,025\n\nINSTRUCTIONS:\n• FEED POST\n\n" +
  "@moist - $400\n@childhoodpost - $250\n@thefuck.tv - $300";

function makeCtx({ media, fileName, caption, repliedText, isReply = true }) {
  const forwarded = [];
  const replies = [];
  const message = {
    message_id: 999,
    chat: { id: -100999 },
    reply_to_message: isReply ? { message_id: 500, text: repliedText } : undefined,
  };
  if (media === "document") message.document = { file_id: "f1", file_name: fileName };
  if (media === "video")    message.video    = { file_id: "f2", file_name: fileName };
  if (media === "photo")    message.photo     = [{ file_id: "f3" }];
  if (caption) message.caption = caption;
  return {
    message,
    chat: { id: -100999 },
    telegram: {
      forwardMessage: async (dest, src, mid) => { forwarded.push({ dest, src, mid }); },
    },
    reply: async (text, opts) => { replies.push(text); },
    _forwarded: forwarded,
    _replies: replies,
  };
}

let pass = true;
function assert(cond, msg) { console.log(cond ? "✅" : "❌", msg); if (!cond) pass = false; }

(async () => {
  console.log("\n── Test 1: reply to brief with @moist.jpg → forwards to moist ──");
  {
    const ctx = makeCtx({ media: "document", fileName: "@moist.jpg", repliedText: BRIEF_TEXT });
    const consumed = await handleCreativeReply(ctx);
    assert(consumed === true, "consumed the message");
    assert(ctx._forwarded.length === 1, "forwarded exactly one creative");
    assert(ctx._forwarded[0]?.dest === "-1001", "forwarded to @moist's chat (-1001)");
    assert(ctx._replies.some((r) => r.includes("moist")), "confirmed with ✅ reply");
  }

  console.log("\n── Test 2: @page in CAPTION (no @-filename) → routes by caption ──");
  {
    const ctx = makeCtx({ media: "photo", caption: "@childhoodpost new cover", repliedText: BRIEF_TEXT });
    const consumed = await handleCreativeReply(ctx);
    assert(consumed === true, "consumed");
    assert(ctx._forwarded[0]?.dest === "-1002", "routed to @childhoodpost via caption");
  }

  console.log("\n── Test 3: @page NOT in brief → rejected, no forward ──");
  {
    const ctx = makeCtx({ media: "document", fileName: "@randompage.jpg", repliedText: BRIEF_TEXT });
    const consumed = await handleCreativeReply(ctx);
    assert(consumed === true, "consumed (handled with a warning)");
    assert(ctx._forwarded.length === 0, "did NOT forward an off-brief handle");
    assert(ctx._replies.some((r) => r.includes("isn't in that brief")), "warned operator");
  }

  console.log("\n── Test 4: media reply but no handle anywhere → asks how to target ──");
  {
    const ctx = makeCtx({ media: "document", fileName: "IMG_1234.jpg", repliedText: BRIEF_TEXT });
    const consumed = await handleCreativeReply(ctx);
    assert(consumed === true, "consumed");
    assert(ctx._forwarded.length === 0, "no forward without a target");
    assert(ctx._replies.some((r) => r.toLowerCase().includes("which page")), "asked which page");
  }

  console.log("\n── Test 5: reply to a NON-brief message → passes through (false) ──");
  {
    const ctx = makeCtx({ media: "document", fileName: "@moist.jpg", repliedText: "just some chat message" });
    const consumed = await handleCreativeReply(ctx);
    assert(consumed === false, "not consumed — flows on to normal handlers");
  }

  console.log("\n── Test 6: media that's NOT a reply → passes through (false) ──");
  {
    const ctx = makeCtx({ media: "document", fileName: "@moist.jpg", isReply: false });
    const consumed = await handleCreativeReply(ctx);
    assert(consumed === false, "not consumed");
  }

  console.log("\n── Test 7: disabled page → rejected ──");
  {
    const briefWithDisabled = BRIEF_TEXT + "\n@disabledpage - $100";
    const ctx = makeCtx({ media: "document", fileName: "@disabledpage.jpg", repliedText: briefWithDisabled });
    const consumed = await handleCreativeReply(ctx);
    assert(consumed === true, "consumed");
    assert(ctx._forwarded.length === 0, "did not forward to disabled page");
    assert(ctx._replies.some((r) => r.includes("disabled")), "told operator it's disabled");
  }

  console.log("\n" + (pass ? "✅ All creative-reply tests passed" : "❌ Some tests failed"));
  process.exit(pass ? 0 : 1);
})();
