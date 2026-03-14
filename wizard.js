/**
 * wizard.js — Greg, the Ad Brief Wizard Bot
 *
 * Single-message wizard that guides the sales team through building a
 * correctly formatted ad brief. Every button tap and text reply edits the
 * same Telegram message in place — no messy thread of back-and-forth.
 *
 * When confirmed, Greg posts the content + brief to Internal Network Ads
 * in the exact format the tracking bot expects.
 *
 * Env vars (Greg's Railway service):
 *   WIZARD_BOT_TOKEN        — Greg's bot token (BotFather → /newbot)
 *   WIZARD_TARGET_CHAT_ID   — Internal Network Ads group ID
 *   WIZARD_ADMIN_HANDLES    — comma-separated admin handles for brief header
 *                             e.g. "davogabriel,jazmynecooper"
 *
 * config/clients.json       — array of known client names shown as buttons
 *
 * Run: node wizard.js  (separate Railway service, polling mode)
 */

require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");

// ── Config ────────────────────────────────────────────────────────────────────

const WIZARD_TOKEN  = process.env.WIZARD_BOT_TOKEN;
const TARGET_CHAT   = process.env.WIZARD_TARGET_CHAT_ID;
const ADMIN_HANDLES = (process.env.WIZARD_ADMIN_HANDLES || "")
  .split(",").map((h) => h.trim().replace(/^@/, "")).filter(Boolean);

if (!WIZARD_TOKEN)  { console.error("❌  WIZARD_BOT_TOKEN not set");       process.exit(1); }
if (!TARGET_CHAT)   { console.error("❌  WIZARD_TARGET_CHAT_ID not set");  process.exit(1); }

// Known clients — shown as a button grid on the client step.
// Edit config/clients.json to add/remove clients.
let KNOWN_CLIENTS = [];
try { KNOWN_CLIENTS = require("./config/clients.json"); } catch (_) {}

const bot = new Telegraf(WIZARD_TOKEN);

// ── Session ───────────────────────────────────────────────────────────────────

const sessions = new Map(); // Map<userId, Session>

function freshSession(chatId) {
  return {
    chatId,
    wizardMsgId:    null,
    step:           "client",
    awaitingCustom: null,  // "client" | "price" | "nif"

    answers: {
      client:   null,
      adType:   null,
      price:    null,
      postType: null,
      duration: null,
      nif:      null,   // "none" | "30min NIF" | custom string
      time:     null,
      pages:    [],
      format:   null,   // "Standard" | "Per-creative" | "Collab"
    },

    // ── Content collection ─────────────────────────────────────────────────
    content: {
      // Standard: all files go here → forwarded to all pages
      shared:    [],      // [{fromChatId, msgId}]

      // Per-creative: one bucket per page handle
      byHandle:  {},      // handle (string) → [{fromChatId, msgId}]
      handleIdx: 0,       // which page we're currently collecting for

      // Collab phase 1 — build host/invite groupings
      collabPhase:      "groups",  // "groups" | "videos"
      collabGroups:     [],        // [{host, invites: string[], video: msgRef|null}]
      collabGroupIdx:   0,         // which group is being built
      collabBuildPhase: "host",    // "host" | "invites" | "more"

      // Collab phase 2 — collect a video per group
      collabVideoIdx: 0,
    },
  };
}

// ── Step order ────────────────────────────────────────────────────────────────
// "content" sits between "format" and "preview" and branches internally.

const STEPS = [
  "client", "adType", "price", "postType",
  "duration", "nif", "time", "pages", "format", "content", "preview",
];

function nextStep(from) {
  const i = STEPS.indexOf(from);
  return i >= 0 && i < STEPS.length - 1 ? STEPS[i + 1] : "preview";
}

// ── Summary line(s) — shown at top of every wizard message ───────────────────

function renderSummary(a) {
  const lines = [];
  const r1 = [
    a.client             ? `*${a.client}*`  : null,
    a.adType             ? a.adType         : null,
    a.price !== null     ? `$${a.price}`    : null,
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

  return lines.join("\n") || "—";
}

// ── Keyboard builder ──────────────────────────────────────────────────────────

const b = (label, data) => Markup.button.callback(label, data);

function buildKeyboard(step) {
  switch (step) {
    case "client": {
      if (!KNOWN_CLIENTS.length) return null; // fallback to text input
      const rows = [];
      for (let i = 0; i < Math.min(KNOWN_CLIENTS.length, 8); i += 2) {
        const row = [b(KNOWN_CLIENTS[i], `f:client:${KNOWN_CLIENTS[i]}`)];
        if (KNOWN_CLIENTS[i + 1]) row.push(b(KNOWN_CLIENTS[i + 1], `f:client:${KNOWN_CLIENTS[i + 1]}`));
        rows.push(row);
      }
      rows.push([b("✏️  New client", "c:client")]);
      return Markup.inlineKeyboard(rows);
    }
    case "adType":
      return Markup.inlineKeyboard([
        [b("Affiliate", "f:adType:Affiliate"), b("Promo", "f:adType:Promo")],
        [b("Sponsorship", "f:adType:Sponsorship"), b("Bounty", "f:adType:Bounty")],
      ]);
    case "price":
      return Markup.inlineKeyboard([
        [b("$0", "f:price:0"), b("$250", "f:price:250"), b("$500", "f:price:500")],
        [b("$750", "f:price:750"), b("$1000", "f:price:1000"), b("✏️  Custom", "c:price")],
      ]);
    case "postType":
      return Markup.inlineKeyboard([
        [b("Reels", "f:postType:Reels"), b("Carousel", "f:postType:Carousel")],
        [b("Story", "f:postType:Story"), b("Feed", "f:postType:Feed")],
      ]);
    case "duration":
      return Markup.inlineKeyboard([
        [b("Permanent", "f:duration:Permanent"), b("24hr", "f:duration:24hr"), b("48hr", "f:duration:48hr")],
      ]);
    case "nif":
      return Markup.inlineKeyboard([
        [b("No NIF", "f:nif:none"), b("15min", "f:nif:15min NIF"), b("30min", "f:nif:30min NIF")],
        [b("1hr", "f:nif:1hr NIF"), b("2hr", "f:nif:2hr NIF"), b("✏️  Custom", "c:nif")],
      ]);
    case "format":
      return Markup.inlineKeyboard([
        [b("Standard", "f:format:Standard"), b("Per-creative", "f:format:Per-creative"), b("Collab", "f:format:Collab")],
      ]);
    case "preview":
      return Markup.inlineKeyboard([
        [b("✅  Post it", "a:post"), b("✏️  Edit", "a:edit"), b("🗑️  Cancel", "a:cancel")],
      ]);
    default:
      return null;
  }
}

const QUESTIONS = {
  client:   KNOWN_CLIENTS.length ? "👤  *Client?*" : "👤  *Client name?*\n_Type below ↓_",
  adType:   "📂  *Ad type?*",
  price:    "💰  *Price?*",
  postType: "🎬  *Post type?*",
  duration: "⏳  *Post duration?*",
  nif:      "⏰  *NIF?*",
  time:     "🕐  *Scheduled time?*\n_e.g. 8pm AZ / 11pm EST · Type below ↓_",
  pages:    "📄  *Which pages?*\n_Type @handles below ↓_",
  format:   "📐  *Content format?*",
};

// ── Content step renderer — branches by format ────────────────────────────────

function renderContentStep(session) {
  const { answers, content } = session;
  const fmt = answers.format;
  const sum = renderSummary(answers);

  // ── Standard ────────────────────────────────────────────────────────────────
  if (fmt === "Standard") {
    const n = content.shared.length;
    return {
      text: `📋 *New Ad Brief*\n\n${sum}\n\n` +
            `📎  *Upload shared content*\n` +
            `${n > 0 ? `✅  ${n} file(s) received` : "_Send files here, then tap Done_"}`,
      keyboard: Markup.inlineKeyboard([[b("✅  Done", "cnt:done")]]),
    };
  }

  // ── Per-creative ─────────────────────────────────────────────────────────────
  if (fmt === "Per-creative") {
    const pages = answers.pages;
    const idx   = content.handleIdx;
    if (idx >= pages.length) { session.step = "preview"; return renderMsg(session); }
    const handle = pages[idx];
    const n      = (content.byHandle[handle] || []).length;
    const isLast = idx === pages.length - 1;
    return {
      text: `📋 *New Ad Brief*\n\n${sum}\n\n` +
            `📎  *Content for @${handle}*  (${idx + 1} / ${pages.length})\n` +
            `${n > 0 ? `✅  ${n} file(s) received` : "_Send files for this page_"}`,
      keyboard: Markup.inlineKeyboard([
        [b(isLast ? "✅  Done" : "➡️  Next page", "cnt:next")],
      ]),
    };
  }

  // ── Collab ───────────────────────────────────────────────────────────────────
  if (fmt === "Collab") {

    // Phase 1: collect host/invite groupings
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
          text: `📋 *New Ad Brief*\n\n${sum}\n\n🎭  *Groups defined:*\n${all}\n\n_Add another group or move on to uploading videos_`,
          keyboard: Markup.inlineKeyboard([
            [b("➕  Add group", "clb:addGroup"), b("📎  Upload videos →", "clb:startVideos")],
          ]),
        };
      }
    }

    // Phase 2: upload a video per group
    if (content.collabPhase === "videos") {
      const gIdx  = content.collabVideoIdx;
      if (gIdx >= content.collabGroups.length) { session.step = "preview"; return renderMsg(session); }
      const g      = content.collabGroups[gIdx];
      const hasVid = !!g.video;
      const isLast = gIdx === content.collabGroups.length - 1;
      return {
        text: `📋 *New Ad Brief*\n\n${sum}\n\n` +
              `📎  *Video for Group ${gIdx + 1}*  (${gIdx + 1} / ${content.collabGroups.length})\n` +
              `Host: @${g.host}  ·  ${g.invites.map((h) => `@${h}`).join(" ")}\n` +
              `${hasVid ? "✅  Video received" : "_Send the video below ↓_"}`,
        keyboard: hasVid
          ? Markup.inlineKeyboard([[b(isLast ? "✅  Done" : "➡️  Next group", "clb:nextVideo")]])
          : null,
      };
    }
  }

  // Fallback — shouldn't reach here
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

  if (step === "content") return renderContentStep(session);

  if (awaitingCustom) {
    const prompt =
      awaitingCustom === "client" ? "👤  *New client name?*\n_Type below ↓_" :
      awaitingCustom === "price"  ? "💰  *Custom price?*\n_Numbers only, e.g. 1500 · Type below ↓_" :
                                    "⏰  *Custom NIF?*\n_e.g. 45min NIF · Type below ↓_";
    return {
      text:     `📋 *New Ad Brief*\n\n${renderSummary(answers)}\n\n${prompt}`,
      keyboard: null,
    };
  }

  return {
    text:     `📋 *New Ad Brief*\n\n${renderSummary(answers)}\n\n${QUESTIONS[step] || ""}`,
    keyboard: buildKeyboard(step),
  };
}

// ── Brief text builder ────────────────────────────────────────────────────────
// Output must match the format parser.js expects so the tracking bot logs it.

function buildBrief(a) {
  const header  = `${a.client} - ${a.adType} - $${a.price}`;
  const topTags = [...ADMIN_HANDLES, "sales_bolismedia"].map((h) => `@${h}`).join("\n");

  const instr = ["INSTRUCTIONS:", `- ${a.postType}`];
  if (a.duration === "Permanent") instr.push("- Permanent post - DO NOT DELETE");
  else instr.push(`- ${a.duration} post`);
  if (a.nif && a.nif !== "none") instr.push(`- ${a.nif}`);

  const timeStr   = /AZ|MST/i.test(a.time) ? a.time : `${a.time} AZ`;
  const pageLines = a.pages.map((h) => `@${h}`).join("\n");

  return [
    header, "",
    topTags, "",
    instr.join("\n"), "",
    `PAGE INFO:\n\n${timeStr}\n\n${pageLines}`,
  ].join("\n");
}

// ── Post to Internal Network Ads group ────────────────────────────────────────
// Sends content first (in the format the tracking bot can parse), then the brief.

async function postToGroup(telegram, session) {
  const { answers, content } = session;
  const fmt = answers.format;

  // Copy a message from the DM to the group without "Forwarded from" header
  const copy = (ref) =>
    telegram.copyMessage(TARGET_CHAT, ref.fromChatId, ref.msgId)
      .catch((e) => console.error("[wizard] copyMessage error:", e.message));

  if (fmt === "Standard") {
    // All shared content → then brief
    for (const ref of content.shared) await copy(ref);
    await telegram.sendMessage(TARGET_CHAT, buildBrief(answers));

  } else if (fmt === "Per-creative") {
    // For each page: send "handle^" label → then that page's content → then brief
    for (const handle of answers.pages) {
      const msgs = content.byHandle[handle] || [];
      if (msgs.length) {
        await telegram.sendMessage(TARGET_CHAT, `${handle}^`);
        for (const ref of msgs) await copy(ref);
      }
    }
    await telegram.sendMessage(TARGET_CHAT, buildBrief(answers));

  } else if (fmt === "Collab") {
    // For each group: copy video → send "Host: @X, invite: @A @B" → then brief
    for (const g of content.collabGroups) {
      if (g.video) await copy(g.video);
      const invites = g.invites.map((h) => `@${h}`).join("\n");
      await telegram.sendMessage(TARGET_CHAT, `Host: @${g.host}, invite:\n\n${invites}`);
    }
    await telegram.sendMessage(TARGET_CHAT, buildBrief(answers));

  } else {
    // Unknown format — just post the brief
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
  const opts = { parse_mode: "Markdown", ...(keyboard || {}) };
  const msg = await ctx.reply(text, opts);
  session.wizardMsgId = msg.message_id;
  sessions.set(ctx.from.id, session);
});

// ── Callback queries (button taps) ───────────────────────────────────────────

bot.on("callback_query", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const session = sessions.get(ctx.from.id);
  if (!session) {
    await ctx.answerCbQuery("Session expired — send /new to start again.").catch(() => {});
    return;
  }

  const data = ctx.callbackQuery.data || "";

  // ── Action buttons (preview step) ────────────────────────────────────────
  if (data.startsWith("a:")) {
    const action = data.slice(2);

    if (action === "cancel") {
      sessions.delete(ctx.from.id);
      await ctx.telegram.editMessageText(
        session.chatId, session.wizardMsgId, undefined, "🗑️ Brief cancelled."
      );
      return;
    }

    if (action === "edit") {
      session.step          = "client";
      session.awaitingCustom = null;
      await updateWizard(ctx.telegram, session);
      return;
    }

    if (action === "post") {
      try {
        await postToGroup(ctx.telegram, session);
        const brief = buildBrief(session.answers);
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
  }

  // ── Custom text prompt ────────────────────────────────────────────────────
  if (data.startsWith("c:")) {
    session.awaitingCustom = data.slice(2); // "client" | "price" | "nif"
    await updateWizard(ctx.telegram, session);
    return;
  }

  // ── Content step — Standard / Per-creative ────────────────────────────────
  if (data.startsWith("cnt:")) {
    const action = data.slice(4);
    if (action === "done") {
      session.step = "preview";
    } else if (action === "next") {
      session.content.handleIdx++;
      if (session.content.handleIdx >= session.answers.pages.length) {
        session.step = "preview";
      }
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
      if (content.collabVideoIdx >= content.collabGroups.length) {
        session.step = "preview";
      }
    }
    await updateWizard(ctx.telegram, session);
    return;
  }

  // ── Field answers (f:fieldName:value) ────────────────────────────────────
  if (data.startsWith("f:")) {
    const [, field, ...rest] = data.split(":");
    const value = rest.join(":");
    const a     = session.answers;

    if (field === "client")   a.client   = value;
    if (field === "adType")   a.adType   = value;
    if (field === "price")    a.price    = value;
    if (field === "postType") a.postType = value;
    if (field === "duration") a.duration = value;
    if (field === "nif")      a.nif      = value;
    if (field === "format")   a.format   = value;

    session.step          = nextStep(field);
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

  // ── Custom field override (price / nif / client) ──────────────────────────
  if (session.awaitingCustom) {
    const field = session.awaitingCustom;
    if (field === "price") {
      const n = parseFloat(input.replace(/[^0-9.]/g, ""));
      session.answers.price = isNaN(n) ? input : String(n);
    } else if (field === "nif") {
      session.answers.nif = input;
    } else if (field === "client") {
      session.answers.client = input;
    }
    session.awaitingCustom = null;
    session.step           = nextStep(field);
    await updateWizard(ctx.telegram, session);
    return;
  }

  // ── Collab group building (text inputs during content step) ──────────────
  if (session.step === "content" && session.answers.format === "Collab") {
    const { content } = session;
    if (content.collabPhase === "groups") {
      if (content.collabBuildPhase === "host") {
        const host = input.replace(/^@/, "").toLowerCase();
        content.collabGroups[content.collabGroupIdx] = { host, invites: [], video: null };
        content.collabBuildPhase = "invites";
        await updateWizard(ctx.telegram, session);
        return;
      }
      if (content.collabBuildPhase === "invites") {
        const invites = [...input.matchAll(/@?([\w.]+)/g)]
          .map((m) => m[1].toLowerCase())
          .filter((h) => h.length > 1);
        const g = content.collabGroups[content.collabGroupIdx];
        if (g) g.invites = invites;
        content.collabBuildPhase = "more";
        await updateWizard(ctx.telegram, session);
        return;
      }
    }
    return; // ignore other text during content step
  }

  // ── Standard text-input steps ────────────────────────────────────────────
  const { step, answers } = session;

  if (step === "client") {
    // Only reached if KNOWN_CLIENTS is empty (no button grid)
    answers.client = input;
    session.step   = nextStep("client");
  } else if (step === "time") {
    answers.time   = input;
    session.step   = nextStep("time");
  } else if (step === "pages") {
    answers.pages = [...input.matchAll(/@?([\w.]+)/g)]
      .map((m) => m[1].toLowerCase())
      .filter((h) => h.length > 1 && !/^(and|the|or|to|in)$/i.test(h));
    session.step = nextStep("pages");
  } else {
    return; // ignore stray text during button steps
  }

  await updateWizard(ctx.telegram, session);
});

// ── Media messages (content upload phase) ────────────────────────────────────

bot.on(["photo", "video", "document", "animation"], async (ctx) => {
  const session = sessions.get(ctx.from.id);
  if (!session || session.step !== "content") return;

  const msgRef         = { fromChatId: ctx.chat.id, msgId: ctx.message.message_id };
  const fmt            = session.answers.format;
  const { content }    = session;

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
    // Only accept the first file per group (one video per collab group)
    if (g && !g.video) g.video = msgRef;
  }

  // Update the wizard message to show updated file count
  await updateWizard(ctx.telegram, session);
});

// ── Launch (polling) ──────────────────────────────────────────────────────────

bot.launch().then(() => console.log("✅ Greg (Ad Brief Wizard) running"));

process.once("SIGINT",  () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
