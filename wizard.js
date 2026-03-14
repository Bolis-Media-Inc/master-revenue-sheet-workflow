/**
 * wizard.js
 * Ad Brief Wizard Bot — guides the sales team through a step-by-step form
 * that lives as a SINGLE evolving Telegram message (edited in place on every
 * button press or text reply).
 *
 * Flow: /new → one message with running summary + current question → confirm
 *       → bot posts the formatted brief to Internal Network Ads group.
 *
 * The tracking bot then picks up the brief as normal — no manual typing needed.
 *
 * Env vars required:
 *   WIZARD_BOT_TOKEN        — separate bot token (BotFather → /newbot)
 *   TARGET_CHAT_ID          — same as tracking bot (posts to first ID in the list)
 *   WIZARD_ADMIN_HANDLES    — comma-separated admin handles to tag at top of brief
 *                             e.g. "davogabriel,jazmynecooper"  (no @ needed)
 *
 * Run: node wizard.js
 * Deploy as a separate Railway service pointing at this entry point.
 */

require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");

// ── Config ────────────────────────────────────────────────────────────────────

const WIZARD_TOKEN  = process.env.WIZARD_BOT_TOKEN;
const TARGET_CHAT   = process.env.TARGET_CHAT_ID?.split(",")[0]; // prod group only

// Admin handles shown at the top of every brief (before @sales_bolismedia)
const ADMIN_HANDLES = (process.env.WIZARD_ADMIN_HANDLES || "")
  .split(",").map((h) => h.trim().replace(/^@/, "")).filter(Boolean);

if (!WIZARD_TOKEN)  { console.error("❌  WIZARD_BOT_TOKEN not set"); process.exit(1); }
if (!TARGET_CHAT)   { console.error("❌  TARGET_CHAT_ID not set");   process.exit(1); }

const bot = new Telegraf(WIZARD_TOKEN);

// ── Session ───────────────────────────────────────────────────────────────────

// Map<userId (number), Session>
const sessions = new Map();

function freshSession(chatId) {
  return {
    chatId,
    wizardMsgId:   null,
    step:          "client",
    awaitingCustom: null,  // "price" | "nif" — user must type next
    answers: {
      client:   null,
      adType:   null,
      price:    null,   // string — kept as string so "$0" stays intact
      postType: null,
      duration: null,
      nif:      null,   // "none" | "30min NIF" | "1hr NIF" | custom string
      time:     null,   // raw text, e.g. "8pm AZ / 11pm EST"
      pages:    [],     // array of handles without @
      format:   null,   // "Standard" | "Per-creative" | "Collab"
    },
  };
}

// Step order — pages & format come last so the summary looks complete at preview
const STEPS = [
  "client", "adType", "price", "postType",
  "duration", "nif", "time", "pages", "format", "preview",
];

function nextStep(from) {
  const i = STEPS.indexOf(from);
  return i >= 0 && i < STEPS.length - 1 ? STEPS[i + 1] : "preview";
}

// ── Summary renderer ──────────────────────────────────────────────────────────

function renderSummary(a) {
  const lines = [];

  // Row 1: client · type · price
  const r1 = [
    a.client              ? `*${a.client}*`              : null,
    a.adType              ? a.adType                     : null,
    a.price !== null      ? `$${a.price}`                : null,
  ].filter(Boolean).join("  ·  ");
  if (r1) lines.push(r1);

  // Row 2: post type · duration · nif
  const r2 = [
    a.postType            ? a.postType                   : null,
    a.duration            ? a.duration                   : null,
    a.nif && a.nif !== "none" ? a.nif                   : null,
  ].filter(Boolean).join("  ·  ");
  if (r2) lines.push(r2);

  if (a.time)             lines.push(`🕐  ${a.time}`);
  if (a.pages.length)     lines.push(`📄  ${a.pages.map((h) => `@${h}`).join("  ")}`);
  if (a.format)           lines.push(`📐  ${a.format}`);

  return lines.join("\n") || "—";
}

// ── Keyboard builder ──────────────────────────────────────────────────────────

const b = (label, data) => Markup.button.callback(label, data);

function buildKeyboard(step) {
  switch (step) {
    case "adType":
      return Markup.inlineKeyboard([
        [b("Affiliate",   "f:adType:Affiliate"),   b("Promo",  "f:adType:Promo")],
        [b("Sponsorship", "f:adType:Sponsorship"), b("Bounty", "f:adType:Bounty")],
      ]);
    case "price":
      return Markup.inlineKeyboard([
        [b("$0",  "f:price:0"),   b("$250", "f:price:250"), b("$500",  "f:price:500")],
        [b("$750","f:price:750"), b("$1000","f:price:1000"), b("✏️ Custom", "c:price")],
      ]);
    case "postType":
      return Markup.inlineKeyboard([
        [b("Reels",    "f:postType:Reels"),    b("Carousel", "f:postType:Carousel")],
        [b("Story",    "f:postType:Story"),    b("Feed",     "f:postType:Feed")],
      ]);
    case "duration":
      return Markup.inlineKeyboard([
        [b("Permanent", "f:duration:Permanent"), b("24hr", "f:duration:24hr"), b("48hr", "f:duration:48hr")],
      ]);
    case "nif":
      return Markup.inlineKeyboard([
        [b("No NIF", "f:nif:none"), b("15min", "f:nif:15min NIF"), b("30min", "f:nif:30min NIF")],
        [b("1hr",    "f:nif:1hr NIF"), b("2hr", "f:nif:2hr NIF"), b("✏️ Custom", "c:nif")],
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
  client:   "✏️  *Client name?*\n_Type below ↓_",
  adType:   "📂  *Ad type?*",
  price:    "💰  *Price?*",
  postType: "🎬  *Post type?*",
  duration: "⏳  *Post duration?*",
  nif:      "⏰  *NIF?*",
  time:     "🕐  *Scheduled time?*\n_e.g. 8pm AZ / 11pm EST · Type below ↓_",
  pages:    "📄  *Which pages?*\n_Type @handles below ↓_",
  format:   "📐  *Content format?*\n_(for your reference — won't affect the brief text)_",
};

// ── Message renderer ──────────────────────────────────────────────────────────

function renderMsg(session) {
  const { step, answers, awaitingCustom } = session;

  if (step === "preview") {
    const brief = buildBrief(answers);
    return {
      text:     `📋 *Ad Brief — Preview*\n\n${renderSummary(answers)}\n\n\`\`\`\n${brief}\n\`\`\``,
      keyboard: buildKeyboard("preview"),
    };
  }

  if (awaitingCustom) {
    const prompt = awaitingCustom === "price"
      ? "💰  *Custom price?*\n_Numbers only, e.g. 1500 · Type below ↓_"
      : "⏰  *Custom NIF?*\n_e.g. 45min NIF · Type below ↓_";
    return { text: `📋 *New Ad Brief*\n\n${renderSummary(answers)}\n\n${prompt}`, keyboard: null };
  }

  return {
    text:     `📋 *New Ad Brief*\n\n${renderSummary(answers)}\n\n${QUESTIONS[step] || ""}`,
    keyboard: buildKeyboard(step),
  };
}

// ── Brief text builder (must produce output the tracking bot can parse) ───────
//
// Output structure the parser expects:
//   Line 1:  {Client} - {Category} - ${Price}
//   Lines:   @admin1 \n @admin2 \n @sales_bolismedia
//   Section: INSTRUCTIONS: \n - {postType} \n - {duration} \n [- {nif}]
//   Section: PAGE INFO: \n\n {time} \n\n @handle1 \n @handle2 …

function buildBrief(a) {
  const header    = `${a.client} - ${a.adType} - $${a.price}`;
  const topTags   = [...ADMIN_HANDLES, "sales_bolismedia"].map((h) => `@${h}`).join("\n");

  const instr = ["INSTRUCTIONS:", `- ${a.postType}`];
  if (a.duration === "Permanent") {
    instr.push("- Permanent post - DO NOT DELETE");
  } else {
    instr.push(`- ${a.duration} post`);
  }
  if (a.nif && a.nif !== "none") instr.push(`- ${a.nif}`);

  // Ensure "AZ" appears so the parser picks up the time
  const timeStr   = /AZ|MST/i.test(a.time) ? a.time : `${a.time} AZ`;
  const pageLines = a.pages.map((h) => `@${h}`).join("\n");

  return [
    header, "",
    topTags, "",
    instr.join("\n"), "",
    `PAGE INFO:\n\n${timeStr}\n\n${pageLines}`,
  ].join("\n");
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
    await ctx.answerCbQuery("Session expired — send /new to start again.");
    return;
  }

  const data = ctx.callbackQuery.data || "";

  // ── Action buttons (preview) ─────────────────────────────────────────────
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
      // Jump back to the beginning — user can re-answer any field
      session.step          = "client";
      session.awaitingCustom = null;
      await updateWizard(ctx.telegram, session);
      return;
    }

    if (action === "post") {
      const brief = buildBrief(session.answers);
      try {
        await ctx.telegram.sendMessage(TARGET_CHAT, brief);
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
    session.awaitingCustom = data.slice(2); // "price" | "nif"
    await updateWizard(ctx.telegram, session);
    return;
  }

  // ── Field answer (f:fieldName:value) ──────────────────────────────────────
  if (data.startsWith("f:")) {
    const [, field, ...rest] = data.split(":");
    const value = rest.join(":");
    const a     = session.answers;

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

// ── Text messages (text-input steps + custom overrides) ──────────────────────

bot.on("text", async (ctx) => {
  if (ctx.message.text.startsWith("/")) return;

  const session = sessions.get(ctx.from.id);
  if (!session) return;

  const input = ctx.message.text.trim();

  // Delete the user's message to keep the DM clean — wizard msg is the UI
  try { await ctx.deleteMessage(); } catch (_) {}

  // ── Custom price / nif override ──────────────────────────────────────────
  if (session.awaitingCustom) {
    const field = session.awaitingCustom;
    if (field === "price") {
      const n = parseFloat(input.replace(/[^0-9.]/g, ""));
      session.answers.price = isNaN(n) ? input : String(n);
    } else {
      session.answers.nif = input;
    }
    session.awaitingCustom = null;
    session.step           = nextStep(field);
    await updateWizard(ctx.telegram, session);
    return;
  }

  // ── Standard text-input steps ────────────────────────────────────────────
  const { step, answers } = session;

  if (step === "client") {
    answers.client = input;
    session.step   = nextStep("client");

  } else if (step === "time") {
    answers.time = input;
    session.step = nextStep("time");

  } else if (step === "pages") {
    // Accept "@handle" or "handle" separated by spaces / commas / newlines
    answers.pages = [...input.matchAll(/@?([\w.]+)/g)]
      .map((m) => m[1].toLowerCase())
      .filter((h) => h.length > 1 && !/^(and|the|or|to|in)$/i.test(h));
    session.step = nextStep("pages");

  } else {
    return; // ignore stray text during button steps
  }

  await updateWizard(ctx.telegram, session);
});

// ── Launch (polling — wizard bot doesn't need a webhook) ─────────────────────

bot.launch().then(() =>
  console.log("✅ Ad Brief Wizard running (polling)")
);

process.once("SIGINT",  () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
