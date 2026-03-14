/**
 * wizard.js — Greg, the Ad Brief Wizard Bot
 *
 * Single-message wizard: every tap/reply edits the same Telegram message in
 * place. When confirmed, Greg posts content + brief to Internal Network Ads.
 *
 * Env vars (Greg's Railway service):
 *   WIZARD_BOT_TOKEN        — Greg's bot token
 *   WIZARD_TARGET_CHAT_ID   — Internal Network Ads group ID
 *   WIZARD_ADMIN_HANDLES    — comma-separated admin handles for brief header
 *                             e.g. "davogabriel,jazmynecooper"
 *
 * config/clients.json       — array of known client names shown as buttons
 *
 * Run: node wizard.js
 */

require("dotenv").config();
const fs              = require("fs");
const path            = require("path");
const { Telegraf, Markup } = require("telegraf");

// ── Config ────────────────────────────────────────────────────────────────────

const WIZARD_TOKEN  = process.env.WIZARD_BOT_TOKEN;
const TARGET_CHAT   = process.env.WIZARD_TARGET_CHAT_ID;
const ADMIN_HANDLES = (process.env.WIZARD_ADMIN_HANDLES || "")
  .split(",").map((h) => h.trim().replace(/^@/, "")).filter(Boolean);

if (!WIZARD_TOKEN)  { console.error("❌  WIZARD_BOT_TOKEN not set");       process.exit(1); }
if (!TARGET_CHAT)   { console.error("❌  WIZARD_TARGET_CHAT_ID not set");  process.exit(1); }

let KNOWN_CLIENTS = [];
try { KNOWN_CLIENTS = require("./config/clients.json"); } catch (_) {}

const BULKS_PATH = path.join(__dirname, "config", "bulks.json");
let KNOWN_BULKS = [];
try { KNOWN_BULKS = JSON.parse(fs.readFileSync(BULKS_PATH, "utf8")); } catch (_) {}

/** Persist updated lastRefNum back to bulks.json (best-effort, ephemeral between deploys). */
function saveBulks() {
  try { fs.writeFileSync(BULKS_PATH, JSON.stringify(KNOWN_BULKS, null, 2)); } catch (_) {}
}

const bot = new Telegraf(WIZARD_TOKEN);

// ── AZ time slot generator ────────────────────────────────────────────────────

function getAZTimeSlots() {
  const THIRTY_MIN  = 30 * 60 * 1000;
  const nextSlotMs  = Math.ceil(Date.now() / THIRTY_MIN) * THIRTY_MIN;
  const slots = [];
  for (let i = 0; i < 24; i++) {
    const t = new Date(nextSlotMs + i * THIRTY_MIN);
    slots.push(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Phoenix",
        hour: "numeric", minute: "2-digit", hour12: true,
      }).format(t) + " AZ"
    );
  }
  return slots;
}

// ── Session ───────────────────────────────────────────────────────────────────

const sessions = new Map();

function freshSession(chatId) {
  return {
    chatId,
    wizardMsgId:    null,
    step:           "client",
    awaitingCustom: null,  // field name expecting a text reply

    answers: {
      client:      null,
      campaignRef: null,   // optional — appended to client in header
      adType:      null,
      price:       null,   // header price; "0" for per-page mode
      priceMode:   "same", // "same" | "per-page"
      postType:    null,
      duration:    null,
      nif:         null,
      time:        null,
      pages:       [],
      format:      null,
      caption:     null,   // optional post caption

      // Per-page pricing
      perPagePrices: {},   // handle → { price: string, bulk: string|null }
      pagePriceIdx:  0,    // which page we're currently pricing
      pagePricePhase: "price", // "price" | "bulk"
    },

    content: {
      shared:    [],
      byHandle:  {},
      handleIdx: 0,
      collabPhase:      "groups",
      collabGroups:     [],
      collabGroupIdx:   0,
      collabBuildPhase: "host",
      collabVideoIdx:   0,
    },
  };
}

// ── Step order ────────────────────────────────────────────────────────────────
// "pageprices" is conditional (not in linear array) — inserted after "pages"
// when priceMode === "per-page".

const STEPS = [
  "client", "campaignRef", "adType", "price",
  "postType", "duration", "nif", "time",
  "pages", "format", "caption", "content", "preview",
];

function nextStep(from, session) {
  if (from === "pages"      && session?.answers?.priceMode === "per-page") return "pageprices";
  if (from === "pageprices")  return "format";
  if (from === "price"      && session?.answers?.priceMode === "per-page") return "postType";
  const i = STEPS.indexOf(from);
  return i >= 0 && i < STEPS.length - 1 ? STEPS[i + 1] : "preview";
}

function prevStep(from, session) {
  if (from === "pageprices") return "pages";
  if (from === "format" && session?.answers?.priceMode === "per-page") return "pageprices";
  // postType follows price in per-page mode
  if (from === "postType" && session?.answers?.priceMode === "per-page") return "price";
  const i = STEPS.indexOf(from);
  return i > 0 ? STEPS[i - 1] : "client";
}

// ── Summary ───────────────────────────────────────────────────────────────────

function renderSummary(a) {
  const lines = [];
  const clientFull = [a.client, a.campaignRef].filter(Boolean).join(" ");
  const r1 = [
    clientFull           ? `*${clientFull}*`    : null,
    a.adType             ? a.adType             : null,
    a.price !== null && a.priceMode === "same" ? `$${a.price}` : (a.priceMode === "per-page" ? "Per page" : null),
  ].filter(Boolean).join("  ·  ");
  if (r1) lines.push(r1);

  const r2 = [
    a.postType,
    a.duration,
    a.nif && a.nif !== "none" ? a.nif : null,
  ].filter(Boolean).join("  ·  ");
  if (r2) lines.push(r2);

  if (a.time)         lines.push(`🕐  ${a.time}`);
  if (a.pages.length) lines.push(`📄  ${a.pages.map((h) => `@${h}`).join("  ")}`);
  if (a.format)       lines.push(`📐  ${a.format}`);
  if (a.caption)      lines.push(`💬  "${a.caption}"`);

  return lines.join("\n") || "—";
}

// ── Keyboards ─────────────────────────────────────────────────────────────────

const b = (label, data) => Markup.button.callback(label, data);

function buildKeyboard(step) {
  switch (step) {
    case "client": {
      if (!KNOWN_CLIENTS.length) return null;
      const rows = [];
      for (let i = 0; i < Math.min(KNOWN_CLIENTS.length, 8); i += 2) {
        const row = [b(KNOWN_CLIENTS[i], `f:client:${KNOWN_CLIENTS[i]}`)];
        if (KNOWN_CLIENTS[i + 1]) row.push(b(KNOWN_CLIENTS[i + 1], `f:client:${KNOWN_CLIENTS[i + 1]}`));
        rows.push(row);
      }
      rows.push([b("✏️  New client", "c:client")]);
      return Markup.inlineKeyboard(rows);
    }
    case "campaignRef":
      return Markup.inlineKeyboard([
        [b("⏭️  Skip — no ref", "a:skipCampaignRef")],
        [b("← Back", "a:back")],
      ]);

    case "adType":
      return Markup.inlineKeyboard([
        [b("Affiliate",    "f:adType:Affiliate"),    b("E-Com",        "f:adType:E-Com")],
        [b("Info Product", "f:adType:Info Product"), b("Music",        "f:adType:Music")],
        [b("✏️  Custom",   "c:adType")],
        [b("← Back", "a:back")],
      ]);
    case "price":
      return Markup.inlineKeyboard([
        [b("$0",   "f:price:0"),   b("$250", "f:price:250"), b("$500",  "f:price:500")],
        [b("$750", "f:price:750"), b("$1000","f:price:1000"), b("✏️  Custom", "c:price")],
        [b("📋  Different per page", "a:perPageMode")],
        [b("← Back", "a:back")],
      ]);
    case "postType":
      return Markup.inlineKeyboard([
        [b("Reels",   "f:postType:Reels"),   b("Carousel", "f:postType:Carousel")],
        [b("Story",   "f:postType:Story"),   b("Feed",     "f:postType:Feed")],
        [b("← Back", "a:back")],
      ]);
    case "duration":
      return Markup.inlineKeyboard([
        [b("Permanent", "f:duration:Permanent"), b("24hr", "f:duration:24hr"), b("48hr", "f:duration:48hr")],
        [b("✏️  Custom", "c:duration")],
        [b("← Back", "a:back")],
      ]);
    case "nif":
      return Markup.inlineKeyboard([
        [b("No NIF", "f:nif:none"), b("15min", "f:nif:15min NIF"), b("30min", "f:nif:30min NIF")],
        [b("1hr",  "f:nif:1hr NIF"), b("2hr", "f:nif:2hr NIF"), b("✏️  Custom", "c:nif")],
        [b("← Back", "a:back")],
      ]);
    case "time": {
      const slots = getAZTimeSlots();
      const rows  = [];
      for (let i = 0; i < slots.length; i += 3) {
        const row = [b(slots[i], `f:time:${slots[i]}`)];
        if (slots[i + 1]) row.push(b(slots[i + 1], `f:time:${slots[i + 1]}`));
        if (slots[i + 2]) row.push(b(slots[i + 2], `f:time:${slots[i + 2]}`));
        rows.push(row);
      }
      rows.push([b("✏️  Custom time", "c:time")]);
      rows.push([b("← Back", "a:back")]);
      return Markup.inlineKeyboard(rows);
    }
    case "format":
      return Markup.inlineKeyboard([
        [b("Standard", "f:format:Standard"), b("Per-creative", "f:format:Per-creative"), b("Collab", "f:format:Collab")],
        [b("← Back", "a:back")],
      ]);
    case "caption":
      return Markup.inlineKeyboard([
        [b("⏭️  Skip — no caption", "a:skipCaption")],
        [b("← Back", "a:back")],
      ]);
    case "preview":
      return Markup.inlineKeyboard([
        [b("✅  Post it", "a:post"), b("✏️  Edit", "a:edit"), b("🗑️  Cancel", "a:cancel")],
        [b("← Back", "a:back")],
      ]);
    default:
      return null;
  }
}

const QUESTIONS = {
  client:      KNOWN_CLIENTS.length ? "👤  *Client?*" : "👤  *Client name?*\n_Type below ↓_",
  campaignRef: "🏷️  *Campaign reference?* _(optional)_\n_e.g. Bounty Post \\#147 · BET SLIP Day 4 · Type below ↓_",
  adType:      "📂  *Ad type?*",
  price:       "💰  *Price?*",
  postType:    "🎬  *Post type?*",
  duration:    "⏳  *Post duration?*",
  nif:         "⏰  *NIF?*",
  time:        "🕐  *Scheduled time?*\n_Next 12 hrs — or tap Custom for anything further out_",
  pages:       "📄  *Which pages?*\n_Type @handles below ↓_",
  format:      "📐  *Content format?*",
  caption:     "💬  *Post caption?* _(optional)_\n_The copy text that goes with the post — Type below ↓ or skip_",
};

// ── Per-page pricing step renderer ───────────────────────────────────────────

function renderPagePricesStep(session) {
  const { answers } = session;
  const pages = answers.pages;
  const idx   = answers.pagePriceIdx;
  const phase = answers.pagePricePhase;
  const sum   = renderSummary(answers);

  if (idx >= pages.length) {
    // All pages priced — compute header price as sum, advance to format
    const total = pages.reduce((acc, h) => {
      const p = parseFloat(answers.perPagePrices[h]?.price || "0");
      return acc + (isNaN(p) ? 0 : p);
    }, 0);
    answers.price    = String(total);
    session.step     = "format";
    return renderMsg(session);
  }

  const handle = pages[idx];

  if (phase === "price") {
    return {
      text: `📋 *New Ad Brief*\n\n${sum}\n\n💰  *Price for @${handle}?*  (${idx + 1} / ${pages.length})`,
      keyboard: Markup.inlineKeyboard([
        [b("$0",   "pp:0"),   b("$100",  "pp:100"),  b("$200", "pp:200")],
        [b("$250", "pp:250"), b("$300",  "pp:300"),  b("$400", "pp:400")],
        [b("$500", "pp:500"), b("$750",  "pp:750"),  b("✏️  Custom", "c:pageprice")],
        [b("← Back", "a:back")],
      ]),
    };
  }

  if (phase === "bulk") {
    const pp = answers.perPagePrices[handle];
    return {
      text: `📋 *New Ad Brief*\n\n${sum}\n\n📋  *Bulk slot for @${handle}?*  (${idx + 1} / ${pages.length})\n` +
            `_e.g. 9/15 · or skip if not a bulk campaign_\n` +
            `${pp?.price !== undefined ? `Price: $${pp.price}` : ""}`,
      keyboard: Markup.inlineKeyboard([
        [b("⏭️  Skip bulk #", "pp:skipbulk")],
        [b("← Back", "a:back")],
      ]),
    };
  }

  session.step = "format";
  return renderMsg(session);
}

// ── Content step renderer ─────────────────────────────────────────────────────

function renderContentStep(session) {
  const { answers, content } = session;
  const fmt = answers.format;
  const sum = renderSummary(answers);

  if (fmt === "Standard") {
    const n = content.shared.length;
    return {
      text: `📋 *New Ad Brief*\n\n${sum}\n\n📎  *Upload shared content*\n` +
            `${n > 0 ? `✅  ${n} file(s) received` : "_Send files here, then tap Done_"}`,
      keyboard: Markup.inlineKeyboard([[b("✅  Done", "cnt:done")]]),
    };
  }

  if (fmt === "Per-creative") {
    const pages = answers.pages;
    const idx   = content.handleIdx;
    if (idx >= pages.length) { session.step = "preview"; return renderMsg(session); }
    const handle = pages[idx];
    const n      = (content.byHandle[handle] || []).length;
    const isLast = idx === pages.length - 1;
    return {
      text: `📋 *New Ad Brief*\n\n${sum}\n\n📎  *Content for @${handle}*  (${idx + 1} / ${pages.length})\n` +
            `${n > 0 ? `✅  ${n} file(s) received` : "_Send files for this page_"}`,
      keyboard: Markup.inlineKeyboard([[b(isLast ? "✅  Done" : "➡️  Next page", "cnt:next")]]),
    };
  }

  if (fmt === "Collab") {
    if (content.collabPhase === "groups") {
      const gIdx  = content.collabGroupIdx;
      const phase = content.collabBuildPhase;
      const g     = content.collabGroups[gIdx];
      const existing = content.collabGroups
        .filter((_, i) => i < gIdx)
        .map((gr, i) => `${i + 1}. @${gr.host}  ·  ${gr.invites.map((h) => `@${h}`).join(" ")}`)
        .join("\n");

      if (phase === "host") {
        return {
          text: `📋 *New Ad Brief*\n\n${sum}\n\n` +
                (existing ? `Groups so far:\n${existing}\n\n` : "") +
                `🎭  *Group ${gIdx + 1} — Host?*\n_Type @handle below ↓_`,
          keyboard: null,
        };
      }
      if (phase === "invites") {
        return {
          text: `📋 *New Ad Brief*\n\n${sum}\n\n` +
                (existing ? `Groups so far:\n${existing}\n\n` : "") +
                `🎭  *Group ${gIdx + 1}* · Host: @${g?.host}\n_Invite pages? Type @handles below ↓_`,
          keyboard: null,
        };
      }
      if (phase === "more") {
        const all = content.collabGroups
          .map((gr, i) => `${i + 1}. @${gr.host}  ·  ${gr.invites.map((h) => `@${h}`).join(" ")}`)
          .join("\n");
        return {
          text: `📋 *New Ad Brief*\n\n${sum}\n\n🎭  *Groups defined:*\n${all}\n\n_Add another group or upload videos_`,
          keyboard: Markup.inlineKeyboard([
            [b("➕  Add group", "clb:addGroup"), b("📎  Upload content →", "clb:startVideos")],
          ]),
        };
      }
    }

    if (content.collabPhase === "videos") {
      const gIdx  = content.collabVideoIdx;
      if (gIdx >= content.collabGroups.length) { session.step = "preview"; return renderMsg(session); }
      const g      = content.collabGroups[gIdx];
      const n      = g.media.length;
      const isLast = gIdx === content.collabGroups.length - 1;
      return {
        text: `📋 *New Ad Brief*\n\n${sum}\n\n` +
              `📎  *Content for Group ${gIdx + 1}*  (${gIdx + 1} / ${content.collabGroups.length})\n` +
              `Host: @${g.host}  ·  ${g.invites.map((h) => `@${h}`).join(" ")}\n` +
              `${n > 0 ? `✅  ${n} file(s) received` : "_Send video or images below ↓_"}`,
        keyboard: n > 0
          ? Markup.inlineKeyboard([[b(isLast ? "✅  Done" : "➡️  Next group", "clb:nextVideo")]])
          : null,
      };
    }
  }

  session.step = "preview";
  return renderMsg(session);
}

// ── Main message renderer ─────────────────────────────────────────────────────

function renderMsg(session) {
  const { step, answers, awaitingCustom } = session;

  if (step === "preview") {
    const brief = buildBrief(answers);
    return {
      text:     `📋 *Ad Brief — Preview*\n\n${renderSummary(answers)}\n\n\`\`\`\n${brief}\n\`\`\``,
      keyboard: buildKeyboard("preview"),
    };
  }

  if (step === "pageprices") return renderPagePricesStep(session);
  if (step === "content")    return renderContentStep(session);

  if (awaitingCustom) {
    const prompts = {
      client:    "👤  *New client name?*\n_Type below ↓_",
      campaignRef: "🏷️  *Campaign reference?*\n_Type below ↓_",
      adType:    "📂  *Custom ad type?*\n_Type below ↓_",
      price:     "💰  *Custom price?*\n_Numbers only, e.g. 1500 · Type below ↓_",
      duration:  "⏳  *Custom duration?*\n_e.g. 7 days · Type below ↓_",
      nif:       "⏰  *Custom NIF?*\n_e.g. 45min NIF · Type below ↓_",
      time:      "🕐  *Custom time?*\n_e.g. Tomorrow 10am AZ · Type below ↓_",
      pageprice: (() => {
        const h = answers.pages[answers.pagePriceIdx];
        return `💰  *Custom price for @${h}?*\n_Numbers only · Type below ↓_`;
      })(),
    };
    return {
      text:     `📋 *New Ad Brief*\n\n${renderSummary(answers)}\n\n${prompts[awaitingCustom] || "Type below ↓"}`,
      keyboard: null,
    };
  }

  return {
    text:     `📋 *New Ad Brief*\n\n${renderSummary(answers)}\n\n${QUESTIONS[step] || ""}`,
    keyboard: buildKeyboard(step),
  };
}

// ── Brief builder ─────────────────────────────────────────────────────────────

function buildBrief(a) {
  const clientFull = [a.client, a.campaignRef].filter(Boolean).join(" ");
  const header     = `${clientFull} - ${a.adType} - $${a.price ?? 0}`;
  const topTags    = [...ADMIN_HANDLES, "sales_bolismedia"].map((h) => `@${h}`).join("\n");

  const instr = ["INSTRUCTIONS:", `- ${a.postType}`];
  if (a.duration === "Permanent") instr.push("- Permanent post - DO NOT DELETE");
  else instr.push(`- ${a.duration} post`);
  if (a.nif && a.nif !== "none") instr.push(`- ${a.nif}`);

  const timeStr = /AZ|MST/i.test(a.time) ? a.time : `${a.time} AZ`;

  let pageLines;
  if (a.priceMode === "per-page") {
    pageLines = a.pages.map((h) => {
      const pp    = a.perPagePrices[h] || {};
      const price = pp.price ?? "0";
      const bulk  = pp.bulk;
      return bulk ? `(${bulk}) @${h} - $${price}` : `@${h} - $${price}`;
    }).join("\n");
  } else {
    pageLines = a.pages.map((h) => `@${h}`).join("\n");
  }

  return [
    header, "",
    topTags, "",
    instr.join("\n"), "",
    `PAGE INFO:\n\n${timeStr}\n\n${pageLines}`,
  ].join("\n");
}

// ── Post to group ─────────────────────────────────────────────────────────────

async function postToGroup(telegram, session) {
  const { answers, content } = session;
  const fmt = answers.format;
  const copy = (ref) =>
    telegram.copyMessage(TARGET_CHAT, ref.fromChatId, ref.msgId)
      .catch((e) => console.error("[wizard] copyMessage error:", e.message));

  // Helper: send caption if one was set
  const sendCaption = async () => {
    if (answers.caption) await telegram.sendMessage(TARGET_CHAT, answers.caption);
  };

  if (fmt === "Standard") {
    for (const ref of content.shared) await copy(ref);
    await sendCaption();
    await telegram.sendMessage(TARGET_CHAT, buildBrief(answers));

  } else if (fmt === "Per-creative") {
    for (const handle of answers.pages) {
      const msgs = content.byHandle[handle] || [];
      if (msgs.length) {
        await telegram.sendMessage(TARGET_CHAT, `${handle}^`);
        for (const ref of msgs) await copy(ref);
      }
    }
    await sendCaption();
    await telegram.sendMessage(TARGET_CHAT, buildBrief(answers));

  } else if (fmt === "Collab") {
    for (const g of content.collabGroups) {
      for (const ref of g.media) await copy(ref);
      const invites = g.invites.map((h) => `@${h}`).join("\n");
      await telegram.sendMessage(TARGET_CHAT, `Host: @${g.host}, invite:\n\n${invites}`);
    }
    await sendCaption();
    await telegram.sendMessage(TARGET_CHAT, buildBrief(answers));

  } else {
    await sendCaption();
    await telegram.sendMessage(TARGET_CHAT, buildBrief(answers));
  }
}

// ── Edit wizard message in place ──────────────────────────────────────────────

async function updateWizard(telegram, session) {
  const { text, keyboard } = renderMsg(session);
  const opts = { parse_mode: "Markdown", ...(keyboard || {}) };
  try {
    await telegram.editMessageText(
      session.chatId, session.wizardMsgId, undefined, text, opts
    );
  } catch (e) {
    if (!e.message?.includes("not modified")) {
      console.error("[wizard] edit error:", e.message);
    }
  }
}

// ── /new command ──────────────────────────────────────────────────────────────

bot.command("new", async (ctx) => {
  const session = freshSession(ctx.chat.id);
  const { text, keyboard } = renderMsg(session);
  const msg = await ctx.reply(text, { parse_mode: "Markdown", ...(keyboard || {}) });
  session.wizardMsgId = msg.message_id;
  sessions.set(ctx.from.id, session);
});

// ── /newbulk — pick a saved bulk template ─────────────────────────────────────

bot.command("newbulk", async (ctx) => {
  if (!KNOWN_BULKS.length) {
    return ctx.reply(
      "📦 No bulk templates configured yet.\nEdit *config/bulks.json* to add some.",
      { parse_mode: "Markdown" }
    );
  }
  const keyboard = Markup.inlineKeyboard(
    KNOWN_BULKS.map((t) => [b(t.name, `blk:${t.id}`)])
  );
  const session = freshSession(ctx.chat.id);
  const msg = await ctx.reply("📦 *Which bulk campaign?*", {
    parse_mode: "Markdown", ...keyboard,
  });
  session.wizardMsgId = msg.message_id;
  sessions.set(ctx.from.id, session);
});

// ── Callback queries ──────────────────────────────────────────────────────────

bot.on("callback_query", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const session = sessions.get(ctx.from.id);
  if (!session) return;

  const data = ctx.callbackQuery.data || "";

  // ── Action buttons ────────────────────────────────────────────────────────
  if (data.startsWith("a:")) {
    const action = data.slice(2);

    if (action === "cancel") {
      sessions.delete(ctx.from.id);
      await ctx.telegram.editMessageText(
        session.chatId, session.wizardMsgId, undefined, "🗑️ Brief cancelled."
      );
      return;
    }
    if (action === "back") {
      session.awaitingCustom = null;
      const cur = session.step;
      session.step = prevStep(cur, session);
      // If going back into per-page pricing, reset to last page/phase
      if (session.step === "pageprices") {
        session.answers.pagePriceIdx   = Math.max(0, session.answers.pages.length - 1);
        session.answers.pagePricePhase = "price";
      }
      await updateWizard(ctx.telegram, session);
      return;
    }
    if (action === "edit") {
      session.step = "client"; session.awaitingCustom = null;
      await updateWizard(ctx.telegram, session);
      return;
    }
    if (action === "post") {
      try {
        await postToGroup(ctx.telegram, session);
        const brief = buildBrief(session.answers);

        // ── Increment bulk counter (persisted in-process; resets on redeploy) ──
        if (session._bulkTemplateId) {
          const bidx = KNOWN_BULKS.findIndex((t) => t.id === session._bulkTemplateId);
          if (bidx >= 0) {
            KNOWN_BULKS[bidx].lastRefNum = (KNOWN_BULKS[bidx].lastRefNum || 0) + 1;
            saveBulks();
          }
        }

        sessions.delete(ctx.from.id);
        await ctx.telegram.editMessageText(
          session.chatId, session.wizardMsgId, undefined,
          `✅ *Posted to Internal Network Ads!*\n\n\`\`\`\n${brief}\n\`\`\``,
          { parse_mode: "Markdown" }
        );
      } catch (err) {
        console.error("[wizard] post error:", err.message);
        await ctx.telegram.editMessageText(
          session.chatId, session.wizardMsgId, undefined,
          `❌ Failed to post: ${err.message}`
        );
      }
      return;
    }
    if (action === "skipCampaignRef") {
      session.answers.campaignRef = null;
      session.step = nextStep("campaignRef", session);
      await updateWizard(ctx.telegram, session);
      return;
    }
    if (action === "skipCaption") {
      session.answers.caption = null;
      session.step = nextStep("caption", session);
      await updateWizard(ctx.telegram, session);
      return;
    }
    if (action === "perPageMode") {
      session.answers.priceMode = "per-page";
      session.answers.price     = null;
      session.step = nextStep("price", session); // jumps to postType
      await updateWizard(ctx.telegram, session);
      return;
    }
  }

  // ── Custom text prompts ───────────────────────────────────────────────────
  if (data.startsWith("c:")) {
    session.awaitingCustom = data.slice(2);
    await updateWizard(ctx.telegram, session);
    return;
  }

  // ── Per-page price answers ────────────────────────────────────────────────
  if (data.startsWith("pp:")) {
    const val    = data.slice(3);
    const a      = session.answers;
    const handle = a.pages[a.pagePriceIdx];

    if (val === "skipbulk") {
      // No bulk # — move to next page
      a.pagePricePhase = "price";
      a.pagePriceIdx++;
      await updateWizard(ctx.telegram, session);
      return;
    }

    if (a.pagePricePhase === "price") {
      if (!a.perPagePrices[handle]) a.perPagePrices[handle] = { price: null, bulk: null };
      a.perPagePrices[handle].price = val;
      a.pagePricePhase = "bulk"; // ask for bulk slot next
    }

    await updateWizard(ctx.telegram, session);
    return;
  }

  // ── Content step ──────────────────────────────────────────────────────────
  if (data.startsWith("cnt:")) {
    const action = data.slice(4);
    if (action === "done") {
      session.step = "preview";
    } else if (action === "next") {
      session.content.handleIdx++;
      if (session.content.handleIdx >= session.answers.pages.length) session.step = "preview";
    }
    await updateWizard(ctx.telegram, session);
    return;
  }

  // ── Collab actions ────────────────────────────────────────────────────────
  if (data.startsWith("clb:")) {
    const action = data.slice(4);
    const { content } = session;
    if (action === "addGroup") {
      content.collabGroupIdx++;
      content.collabBuildPhase = "host";
    } else if (action === "startVideos") {
      content.collabPhase    = "videos";
      content.collabVideoIdx = 0;
    } else if (action === "nextVideo") {
      content.collabVideoIdx++;
      if (content.collabVideoIdx >= content.collabGroups.length) session.step = "preview";
    }
    await updateWizard(ctx.telegram, session);
    return;
  }

  // ── Bulk template selection ───────────────────────────────────────────────
  if (data.startsWith("blk:")) {
    const id       = data.slice(4);
    const template = KNOWN_BULKS.find((t) => t.id === id);
    if (!template) return;

    const nextNum = (template.lastRefNum || 0) + 1;
    const a       = session.answers;

    a.client      = template.client    || null;
    a.campaignRef = template.refPrefix ? `${template.refPrefix} ${nextNum}` : null;
    a.adType      = template.adType    || null;
    a.postType    = template.postType  || null;
    a.duration    = template.duration  || null;
    a.nif         = template.nif       || null;
    a.priceMode   = template.priceMode || "same";
    a.format      = template.format    || null;
    a.pages       = [...(template.pages || [])];
    a.perPagePrices = JSON.parse(JSON.stringify(template.perPagePrices || {}));

    // Compute header price as sum of per-page prices
    if (a.priceMode === "per-page") {
      const total = a.pages.reduce((sum, h) => {
        const p = parseFloat(a.perPagePrices[h]?.price || "0");
        return sum + (isNaN(p) ? 0 : p);
      }, 0);
      a.price = String(total);
    }

    // Remember which template we're using (for counter increment on post)
    session._bulkTemplateId = id;

    // Everything is pre-filled — jump straight to time selection
    session.step = "time";
    await updateWizard(ctx.telegram, session);
    return;
  }

  // ── Field answers ─────────────────────────────────────────────────────────
  if (data.startsWith("f:")) {
    const [, field, ...rest] = data.split(":");
    const value = rest.join(":");
    const a     = session.answers;

    if (field === "client")   { a.client   = value; }
    if (field === "adType")   { a.adType   = value; }
    if (field === "price")    { a.price    = value; }
    if (field === "postType") { a.postType = value; }
    if (field === "duration") { a.duration = value; }
    if (field === "nif")      { a.nif      = value; }
    if (field === "time")     { a.time     = value; }
    if (field === "format")   { a.format   = value; }

    session.step          = nextStep(field, session);
    session.awaitingCustom = null;
    await updateWizard(ctx.telegram, session);
  }
});

// ── Text messages ─────────────────────────────────────────────────────────────

bot.on("text", async (ctx) => {
  if (ctx.message.text.startsWith("/")) return;
  const session = sessions.get(ctx.from.id);
  if (!session) return;

  const input = ctx.message.text.trim();
  try { await ctx.deleteMessage(); } catch (_) {}

  // ── Custom field overrides ────────────────────────────────────────────────
  if (session.awaitingCustom) {
    const field = session.awaitingCustom;
    const a     = session.answers;

    if (field === "client")      { a.client   = input; }
    if (field === "campaignRef") { a.campaignRef = input; }
    if (field === "adType")      { a.adType   = input; }
    if (field === "duration")    { a.duration = input; }
    if (field === "nif")         { a.nif      = input; }
    if (field === "time")        { a.time     = input; }
    if (field === "price") {
      const n = parseFloat(input.replace(/[^0-9.]/g, ""));
      a.price = isNaN(n) ? input : String(n);
    }
    if (field === "pageprice") {
      const handle = a.pages[a.pagePriceIdx];
      const n      = parseFloat(input.replace(/[^0-9.]/g, ""));
      if (!a.perPagePrices[handle]) a.perPagePrices[handle] = { price: null, bulk: null };
      a.perPagePrices[handle].price = isNaN(n) ? input : String(n);
      a.pagePricePhase = "bulk";
      session.awaitingCustom = null;
      await updateWizard(ctx.telegram, session);
      return;
    }

    session.awaitingCustom = null;
    session.step           = nextStep(field, session);
    await updateWizard(ctx.telegram, session);
    return;
  }

  // ── Bulk slot text input (pageprices "bulk" phase) ────────────────────────
  if (session.step === "pageprices" && session.answers.pagePricePhase === "bulk") {
    const a      = session.answers;
    const handle = a.pages[a.pagePriceIdx];
    if (!a.perPagePrices[handle]) a.perPagePrices[handle] = { price: null, bulk: null };
    a.perPagePrices[handle].bulk = input;
    a.pagePricePhase = "price";
    a.pagePriceIdx++;
    await updateWizard(ctx.telegram, session);
    return;
  }

  // ── Collab group building ─────────────────────────────────────────────────
  if (session.step === "content" && session.answers.format === "Collab") {
    const { content } = session;
    if (content.collabPhase === "groups") {
      if (content.collabBuildPhase === "host") {
        const host = input.replace(/^@/, "").toLowerCase();
        content.collabGroups[content.collabGroupIdx] = { host, invites: [], media: [] };
        content.collabBuildPhase = "invites";
        await updateWizard(ctx.telegram, session);
        return;
      }
      if (content.collabBuildPhase === "invites") {
        const invites = [...input.matchAll(/@?([\w.]+)/g)]
          .map((m) => m[1].toLowerCase()).filter((h) => h.length > 1);
        const g = content.collabGroups[content.collabGroupIdx];
        if (g) g.invites = invites;
        content.collabBuildPhase = "more";
        await updateWizard(ctx.telegram, session);
        return;
      }
    }
    return;
  }

  // ── Caption text input ────────────────────────────────────────────────────
  if (session.step === "caption") {
    session.answers.caption = input;
    session.step = nextStep("caption", session);
    await updateWizard(ctx.telegram, session);
    return;
  }

  // ── Standard text steps ───────────────────────────────────────────────────
  const { step, answers } = session;

  if (step === "client") {
    answers.client = input;
    session.step   = nextStep("client", session);
  } else if (step === "campaignRef") {
    answers.campaignRef = input;
    session.step        = nextStep("campaignRef", session);
  } else if (step === "pages") {
    answers.pages = [...input.matchAll(/@?([\w.]+)/g)]
      .map((m) => m[1].toLowerCase())
      .filter((h) => h.length > 1 && !/^(and|the|or|to|in)$/i.test(h));
    session.step = nextStep("pages", session);
  } else {
    return;
  }

  await updateWizard(ctx.telegram, session);
});

// ── Media messages (content upload phase) ────────────────────────────────────

bot.on(["photo", "video", "document", "animation"], async (ctx) => {
  const session = sessions.get(ctx.from.id);
  if (!session || session.step !== "content") return;

  const msgRef      = { fromChatId: ctx.chat.id, msgId: ctx.message.message_id };
  const fmt         = session.answers.format;
  const { content } = session;

  if (fmt === "Standard") {
    content.shared.push(msgRef);
  } else if (fmt === "Per-creative") {
    const handle = session.answers.pages[content.handleIdx];
    if (handle) {
      if (!content.byHandle[handle]) content.byHandle[handle] = [];
      content.byHandle[handle].push(msgRef);
    }
  } else if (fmt === "Collab" && content.collabPhase === "videos") {
    const g = content.collabGroups[content.collabVideoIdx];
    if (g) g.media.push(msgRef);
  }

  await updateWizard(ctx.telegram, session);
});

// ── Launch ────────────────────────────────────────────────────────────────────

bot.launch().then(() => console.log("✅ Greg (Ad Brief Wizard) running"));
process.once("SIGINT",  () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
