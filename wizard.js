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
const cron            = require("node-cron");
const brain           = require("./brain");

// ── Config ────────────────────────────────────────────────────────────────────

const WIZARD_TOKEN  = process.env.WIZARD_BOT_TOKEN;
const TARGET_CHAT   = process.env.WIZARD_TARGET_CHAT_ID;
const ADMIN_HANDLES = (process.env.WIZARD_ADMIN_HANDLES || "")
  .split(",").map((h) => h.trim().replace(/^@/, "")).filter(Boolean);

const ALL_SENIORS = [
  "davogabriel", "jazmynecooper", "sales_bolismedia",
  "vendemia", "onah_bolismedia", "isaac_bolismedia", "dannygabriel",
];

if (!WIZARD_TOKEN)  { console.error("❌  WIZARD_BOT_TOKEN not set");       process.exit(1); }
if (!TARGET_CHAT)   { console.error("❌  WIZARD_TARGET_CHAT_ID not set");  process.exit(1); }

let KNOWN_CLIENTS = [];
try { KNOWN_CLIENTS = require("./config/clients.json"); } catch (_) {}

const BULKS_PATH = path.join(__dirname, "config", "bulks.json");
let KNOWN_BULKS = [];
try { KNOWN_BULKS = JSON.parse(fs.readFileSync(BULKS_PATH, "utf8")); } catch (_) {}
function saveBulks() {
  try { fs.writeFileSync(BULKS_PATH, JSON.stringify(KNOWN_BULKS, null, 2)); } catch (_) {}
}

const CAMPAIGNS_PATH = path.join(__dirname, "config", "campaigns.json");
let KNOWN_CAMPAIGNS = [];
try { KNOWN_CAMPAIGNS = JSON.parse(fs.readFileSync(CAMPAIGNS_PATH, "utf8")); } catch (_) {}
function saveCampaigns() {
  try { fs.writeFileSync(CAMPAIGNS_PATH, JSON.stringify(KNOWN_CAMPAIGNS, null, 2)); } catch (_) {}
}

const COLLABS_PATH = path.join(__dirname, "config", "collabs.json");
let KNOWN_COLLABS = [];
try { KNOWN_COLLABS = JSON.parse(fs.readFileSync(COLLABS_PATH, "utf8")); } catch (_) {}
function saveCollabs() {
  try { fs.writeFileSync(COLLABS_PATH, JSON.stringify(KNOWN_COLLABS, null, 2)); } catch (_) {}
}

const bot = new Telegraf(WIZARD_TOKEN);

// Give brain.js the bot instance so recaps are sent from Greg (bot account)
brain.setBotInstance(bot);

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

function freshSession(chatId, mode = "brief") {
  return {
    chatId,
    wizardMsgId:    null,
    mode,                  // "brief" | "template"
    step:           mode === "template" ? "bulkName" : "client",
    awaitingCustom: null,

    // template-creation extras
    _bulkName:       null,
    _bulkRefPrefix:  null,
    _bulkStartNum:   0,       // last completed run # (next = this + 1), bulks only
    _skipBulkSlots:  false,   // true for campaigns — skip per-page slot # question
    _bulkTemplateId: null,    // set when continuing a bulk template
    _campaignTemplateId: null,// set when continuing a campaign template

    answers: {
      client:      null,
      campaignRef: null,
      adType:      null,
      price:       null,
      priceMode:   "same",
      postType:    null,
      duration:    null,
      nif:         null,
      time:        null,
      seniors:     [],   // selected responsible handles
      pages:       [],
      format:      null,
      caption:     null,

      perPagePrices:  {},
      pagePriceIdx:   0,
      pagePricePhase: "price",
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
// "pageprices" is conditional — inserted after "pages" when priceMode === "per-page".
// Template mode has its own step list (bulkName/bulkRefPrefix up front; no time/caption/content).

const STEPS = [
  "client", "adType", "price",
  "postType", "duration", "nif", "time", "seniors",
  "pages", "format", "caption", "content", "preview",
];

// Bulk template creation: bulkStartNum tracks how far through the slot package we are.
const TEMPLATE_STEPS = [
  "bulkName", "bulkRefPrefix", "bulkStartNum", "client", "adType", "price",
  "postType", "duration", "nif", "seniors", "pages", "format", "preview",
];

// Campaign template creation: no bulkStartNum (ref # is freeform each run, not sequential).
const TEMPLATE_CAMPAIGN_STEPS = [
  "bulkName", "bulkRefPrefix", "client", "adType", "price",
  "postType", "duration", "nif", "seniors", "pages", "format", "preview",
];

function _stepsFor(session) {
  if (session?.mode === "template")          return TEMPLATE_STEPS;
  if (session?.mode === "campaign-template") return TEMPLATE_CAMPAIGN_STEPS;
  return STEPS;
}

function nextStep(from, session) {
  const steps = _stepsFor(session);
  if (from === "pages"      && session?.answers?.priceMode === "per-page") return "pageprices";
  if (from === "pageprices")  return "format";
  if (from === "price"      && session?.answers?.priceMode === "per-page") return "postType";
  const i = steps.indexOf(from);
  return i >= 0 && i < steps.length - 1 ? steps[i + 1] : "preview";
}

// Skip steps whose answers are already filled (used by betslip auto-flow)
function skipFilledSteps(session) {
  const a = session.answers;
  const filled = (step) => {
    switch (step) {
      case "client":     return !!a.client;
      case "adType":     return !!a.adType;
      case "price":      return !!a.price;
      case "postType":   return !!a.postType;
      case "duration":   return !!a.duration;
      case "nif":        return !!a.nif;
      case "time":       return !!a.time;
      case "seniors":    return a.seniors && a.seniors.length > 0;
      case "pages":      return a.pages && a.pages.length > 0;
      case "pageprices": return Object.keys(a.perPagePrices || {}).length > 0;
      case "format":     return !!a.format;
      case "caption":    return a.caption != null;
      case "content":    return session.content.shared.length > 0;
      default:           return false;
    }
  };
  let safety = 20;
  while (session.step !== "preview" && filled(session.step) && --safety > 0) {
    session.step = nextStep(session.step, session);
  }
}

function prevStep(from, session) {
  const steps = _stepsFor(session);
  if (from === "pageprices") return "pages";
  if (from === "format" && session?.answers?.priceMode === "per-page") return "pageprices";
  if (from === "postType" && session?.answers?.priceMode === "per-page") return "price";
  const i = steps.indexOf(from);
  return i > 0 ? steps[i - 1] : steps[0];
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

  if (a.time)              lines.push(`🕐  ${a.time}`);
  if (a.seniors?.length)   lines.push(`👥  ${a.seniors.map((h) => `@${h}`).join("  ")}`);
  if (a.pages.length)      lines.push(`📄  ${a.pages.map((h) => `@${h}`).join("  ")}`);
  if (a.format)       lines.push(`📐  ${a.format}`);
  if (a.caption)      lines.push(`💬  "${a.caption}"`);

  return lines.join("\n") || "—";
}

// ── Keyboards ─────────────────────────────────────────────────────────────────

const b = (label, data) => Markup.button.callback(label, data);

function buildKeyboard(step, session) {
  const isTemplate = session?.mode === "template";
  switch (step) {
    case "bulkName":
      return null; // text input only

    case "bulkRefPrefix":
      return Markup.inlineKeyboard([
        [b("⏭️  No ref prefix", "a:skipBulkRefPrefix")],
        [b("← Back", "a:back")],
      ]);

    case "bulkStartNum":
      return Markup.inlineKeyboard([
        [b("Start fresh  (next = #1)", "bsn:0")],
        [b("5",  "bsn:5"),  b("10", "bsn:10"), b("13", "bsn:13")],
        [b("14", "bsn:14"), b("15", "bsn:15"), b("✏️  Custom", "c:bulkStartNum")],
        [b("← Back", "a:back")],
      ]);

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
        [b("Reels",   "f:postType:Reels"),   b("Carousel", "f:postType:Carousel"), b("Story", "f:postType:Story")],
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
    case "seniors": {
      const selected = session?.answers?.seniors || [];
      const rows = ALL_SENIORS.map((h) => {
        const label = selected.includes(h) ? `✅ @${h}` : `@${h}`;
        return [b(label, `sr:${h}`)];
      });
      rows.push([b("✅  Done", "a:seniorsDone")]);
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
      return (isTemplate || session?.mode === "campaign-template")
        ? Markup.inlineKeyboard([
            [b("💾  Save template", "a:saveTemplate"), b("✏️  Edit", "a:edit"), b("🗑️  Cancel", "a:cancel")],
            [b("← Back", "a:back")],
          ])
        : Markup.inlineKeyboard([
            [b("✅  Post it", "a:post"), b("✏️  Edit", "a:edit"), b("🗑️  Cancel", "a:cancel")],
            [b("← Back", "a:back")],
          ]);
    default:
      return null;
  }
}

const QUESTIONS = {
  bulkName:      "📦  *Bulk template name?*\n_e.g. Stake Bet Slips · Type below ↓_",
  bulkRefPrefix: "🏷️  *Campaign ref prefix?* _(optional)_\n_e.g. BET SLIP Day → Greg will append 1, 2, 3… each run · Type below ↓_",
  bulkStartNum:  "🔢  *Where are we in this bulk right now?*\n_Pick the last completed run # — next run will be one higher_",
  client:        KNOWN_CLIENTS.length ? "👤  *Client?*" : "👤  *Client name?*\n_Type below ↓_",
  campaignRef:   "🏷️  *Campaign reference?* _(optional)_\n_e.g. Bounty Post \\#147 · BET SLIP Day 4 · Type below ↓_",
  adType:        "📂  *Ad type?*",
  price:         "💰  *Price?*",
  postType:      "🎬  *Post type?*",
  duration:      "⏳  *Post duration?*",
  nif:           "⏰  *NIF?*",
  time:          "🕐  *Scheduled time?*\n_Next 12 hrs — or tap Custom for anything further out_",
  seniors:       "👥  *Who's responsible for posting?*\n_Select one or more — tap Done when ready_",
  pages:         "📄  *Which pages?*\n_Type @handles below ↓_",
  format:        "📐  *Content format?*",
  caption:       "💬  *Post caption?* _(optional)_\n_The copy text that goes with the post — Type below ↓ or skip_",
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

  // Campaigns skip the bulk slot # entirely — auto-advance to next page
  if (session._skipBulkSlots && phase === "bulk") {
    answers.pagePricePhase = "price";
    answers.pagePriceIdx++;
    return renderPagePricesStep(session);
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

      // Show preset picker if no groups built yet and presets exist
      if (phase === "host" && gIdx === 0 && !content.collabGroups.length && KNOWN_COLLABS.length) {
        const presetBtns = KNOWN_COLLABS.map((c) =>
          [b(`🎭 ${c.name} (${c.groups.length})`, `sc:use:${c.id}`)]
        );
        presetBtns.push([b("✏️ Build manually", "sc:manual")]);
        return {
          text: `📋 *New Ad Brief*\n\n${sum}\n\n🎭 *Collab Groups*\n_Pick a preset or build manually:_`,
          keyboard: Markup.inlineKeyboard(presetBtns),
        };
      }

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
  const { step, answers, awaitingCustom, mode } = session;
  const isTemplate         = mode === "template";
  const isCampaignTemplate = mode === "campaign-template";
  const isAnyTemplate      = isTemplate || isCampaignTemplate;
  const heading = isCampaignTemplate ? "🔁 *New Campaign Template*"
                : isTemplate         ? "📦 *New Bulk Template*"
                : "📋 *New Ad Brief*";

  // ── Template-specific steps ───────────────────────────────────────────────
  if (step === "bulkName") {
    return {
      text:     `${heading}\n\n📦  *Bulk template name?*\n_e.g. Stake Bet Slips · Type below ↓_`,
      keyboard: null,
    };
  }
  if (step === "bulkRefPrefix") {
    const set = session._bulkName ? `Template: *${session._bulkName}*\n\n` : "";
    return {
      text:     `${heading}\n\n${set}🏷️  *Campaign ref prefix?* _(optional)_\n_e.g. BET SLIP Day  →  Greg appends 1, 2, 3… each run_\n_Type below ↓ or skip_`,
      keyboard: buildKeyboard("bulkRefPrefix", session),
    };
  }
  if (step === "bulkStartNum") {
    const prefix = session._bulkRefPrefix ? `*${session._bulkRefPrefix}*` : "this bulk";
    const nextNum = (session._bulkStartNum || 0) + 1;
    return {
      text:     `${heading}\n\n🔢  *Where are we in ${prefix} right now?*\n_Pick the last completed # — next run will be *#${nextNum}*_`,
      keyboard: buildKeyboard("bulkStartNum", session),
    };
  }

  if (step === "preview") {
    if (isAnyTemplate) {
      let refLine;
      if (isCampaignTemplate) {
        refLine = session._bulkRefPrefix
          ? `Ref: ${session._bulkRefPrefix} 1, ${session._bulkRefPrefix} 2, … _(editable each run)_`
          : "No ref prefix — you'll set the ref each run";
      } else {
        const nextNum = (session._bulkStartNum || 0) + 1;
        refLine = session._bulkRefPrefix
          ? `Ref: ${session._bulkRefPrefix} ${nextNum}, ${nextNum + 1}, …`
          : `Run counter starts at #${nextNum}`;
      }
      return {
        text:     `${heading}\n\n*${session._bulkName || "Unnamed"}*\n${refLine}\n\n${renderSummary(answers)}`,
        keyboard: buildKeyboard("preview", session),
      };
    }
    const brief = buildBrief(answers);
    return {
      text:     `📋 *Ad Brief — Preview*\n\n${renderSummary(answers)}\n\n\`\`\`\n${brief}\n\`\`\``,
      keyboard: buildKeyboard("preview", session),
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
      pageprice:    (() => {
        const h = answers.pages[answers.pagePriceIdx];
        return `💰  *Custom price for @${h}?*\n_Numbers only · Type below ↓_`;
      })(),
      bulkStartNum: "🔢  *Last completed run #?*\n_e.g. 13 means next run will be #14 · Type below ↓_",
    };
    return {
      text:     `${heading}\n\n${renderSummary(answers)}\n\n${prompts[awaitingCustom] || "Type below ↓"}`,
      keyboard: null,
    };
  }

  return {
    text:     `${heading}\n\n${renderSummary(answers)}\n\n${QUESTIONS[step] || ""}`,
    keyboard: buildKeyboard(step, session),
  };
}

// ── Brief builder ─────────────────────────────────────────────────────────────

function buildBrief(a) {
  const header  = `${a.client} - ${a.adType} - $${a.price ?? 0}`;
  const seniorList = (a.seniors && a.seniors.length > 0) ? a.seniors : ADMIN_HANDLES;
  const topTags = seniorList.map((h) => `@${h}`).join("\n");

  const instr = ["INSTRUCTIONS:", `- ${a.postType}`];
  if (a.duration === "Permanent") instr.push("- Permanent post - DO NOT DELETE");
  else instr.push(`- ${a.duration} post`);
  if (a.nif && a.nif !== "none") instr.push(`- ${a.nif}`);

  const timeStr = /AZ|MST/i.test(a.time) ? a.time : `${a.time} AZ`;

  // Extract just the #NUM from a campaign ref (e.g. "Bounty Post #149" → "#149")
  const campaignNumPrefix = a.campaignRef
    ? (a.campaignRef.match(/#\d+/)?.[0] ?? a.campaignRef)
    : null;

  let pageLines;
  if (a.priceMode === "per-page") {
    pageLines = a.pages.map((h) => {
      const pp    = a.perPagePrices[h] || {};
      const price = pp.price ?? "0";
      // Bulk slot # (13/15) takes priority; campaign #NUM is the fallback — both go in Bulk # column
      const prefix = pp.bulk || campaignNumPrefix || null;
      return prefix ? `(${prefix}) @${h} - $${price}` : `@${h} - $${price}`;
    }).join("\n");
  } else {
    // Same price — prefix every page with campaign #NUM if set
    pageLines = a.pages.map((h) =>
      campaignNumPrefix ? `(${campaignNumPrefix}) @${h}` : `@${h}`
    ).join("\n");
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

// ── /ad command ───────────────────────────────────────────────────────────────

bot.command("ad", async (ctx) => {
  const session = freshSession(ctx.chat.id);
  const { text, keyboard } = renderMsg(session);
  const msg = await ctx.reply(text, { parse_mode: "Markdown", ...(keyboard || {}) });
  session.wizardMsgId = msg.message_id;
  sessions.set(ctx.from.id, session);
});

// ── /newbulk — create a new bulk template ─────────────────────────────────────

bot.command("newbulk", async (ctx) => {
  const session = freshSession(ctx.chat.id, "template");
  const { text, keyboard } = renderMsg(session);
  const msg = await ctx.reply(text, { parse_mode: "Markdown", ...(keyboard || {}) });
  session.wizardMsgId = msg.message_id;
  sessions.set(ctx.from.id, session);
});

// ── /newcamp — create a recurring campaign template ───────────────────────────

bot.command("newcamp", async (ctx) => {
  const session = freshSession(ctx.chat.id, "campaign-template");
  const { text, keyboard } = renderMsg(session);
  const msg = await ctx.reply(text, { parse_mode: "Markdown", ...(keyboard || {}) });
  session.wizardMsgId = msg.message_id;
  sessions.set(ctx.from.id, session);
});

// ── /camp — run an existing campaign template ─────────────────────────────────

bot.command("camp", async (ctx) => {
  if (!KNOWN_CAMPAIGNS.length) {
    return ctx.reply(
      "🔁 No campaign templates saved yet\\.\nUse /newcamp to create one\\.",
      { parse_mode: "MarkdownV2" }
    );
  }
  const keyboard = Markup.inlineKeyboard(
    KNOWN_CAMPAIGNS.map((t) => [b(t.name, `cmp:${t.id}`)])
  );
  const session = freshSession(ctx.chat.id);
  const msg = await ctx.reply("🔁 *Which campaign?*", {
    parse_mode: "Markdown", ...keyboard,
  });
  session.wizardMsgId = msg.message_id;
  sessions.set(ctx.from.id, session);
});

// ── /bulk — run an existing bulk template ─────────────────────────────────────

bot.command("bulk", async (ctx) => {
  if (!KNOWN_BULKS.length) {
    return ctx.reply(
      "📦 No bulk templates saved yet\\.\nUse /newbulk to create one\\.",
      { parse_mode: "MarkdownV2" }
    );
  }
  const keyboard = Markup.inlineKeyboard(
    KNOWN_BULKS.map((t) => {
      const num = (t.lastRefNum || 0) + 1;
      const label = t.refPrefix ? `${t.name}  ·  #${num}` : t.name;
      return [b(label, `blk:${t.id}`)];
    })
  );
  const session = freshSession(ctx.chat.id);
  const msg = await ctx.reply("📦 *Which bulk campaign?*", {
    parse_mode: "Markdown", ...keyboard,
  });
  session.wizardMsgId = msg.message_id;
  sessions.set(ctx.from.id, session);
});

// ── /editbulk & /editcamp — edit an existing template ────────────────────────

function renderTemplatePreview(tpl, kind) {
  const icon = kind === "bulk" ? "📦" : "🔁";
  const lines = [`${icon} *${tpl.name}*`];
  if (tpl.refPrefix) {
    const next = (tpl.lastRefNum || 0) + 1;
    lines.push(`🏷️  Ref: ${tpl.refPrefix} (next #${next})`);
  }
  if (tpl.client)   lines.push(`👤  Client: ${tpl.client}`);
  if (tpl.adType)   lines.push(`📂  Ad type: ${tpl.adType}`);
  if (tpl.postType) lines.push(`📱  Post type: ${tpl.postType}`);
  if (tpl.duration) lines.push(`⏳  Duration: ${tpl.duration}`);
  if (tpl.nif)      lines.push(`⏰  NIF: ${tpl.nif}`);
  if (tpl.seniors?.length)
    lines.push(`👥  Seniors: ${tpl.seniors.map((h) => `@${h}`).join("  ")}`);
  if (tpl.pages?.length)
    lines.push(`📄  Pages (${tpl.pages.length}): ${tpl.pages.map((h) => `@${h}`).join("  ")}`);
  if (tpl.priceMode === "per-page" && tpl.perPagePrices) {
    const total = tpl.pages.reduce((s, h) => s + (parseFloat(tpl.perPagePrices[h]?.price || 0) || 0), 0);
    lines.push(`💰  Per-page total: $${total}`);
    tpl.pages.forEach((h) => {
      const pp = tpl.perPagePrices[h];
      if (pp) lines.push(`     @${h}: $${pp.price} (${pp.bulk})`);
    });
  }
  if (tpl.format) lines.push(`📐  Format: ${tpl.format}`);
  return lines.join("\n");
}

const EDITABLE_FIELDS = [
  { key: "client",    label: "👤 Client" },
  { key: "adType",    label: "📂 Ad Type" },
  { key: "postType",  label: "📱 Post Type" },
  { key: "duration",  label: "⏳ Duration" },
  { key: "nif",       label: "⏰ NIF" },
  { key: "format",    label: "📐 Format" },
  { key: "refPrefix", label: "🏷️ Ref Prefix" },
  { key: "lastRefNum",label: "🔢 Run Counter" },
  { key: "seniors",   label: "👥 Seniors" },
  { key: "pages",     label: "📄 Pages" },
  { key: "pagePrices",label: "💰 Page Prices" },
];

function editTemplateKeyboard(tplId, kind) {
  const prefix = kind === "bulk" ? "eb" : "ec";
  const rows = [];
  for (let i = 0; i < EDITABLE_FIELDS.length; i += 2) {
    const row = [b(EDITABLE_FIELDS[i].label, `${prefix}:${tplId}:${EDITABLE_FIELDS[i].key}`)];
    if (EDITABLE_FIELDS[i + 1])
      row.push(b(EDITABLE_FIELDS[i + 1].label, `${prefix}:${tplId}:${EDITABLE_FIELDS[i + 1].key}`));
    rows.push(row);
  }
  rows.push([b("✅ Done", `${prefix}:${tplId}:done`)]);
  return Markup.inlineKeyboard(rows);
}

bot.command("editbulk", async (ctx) => {
  if (!KNOWN_BULKS.length) return ctx.reply("📦 No bulk templates to edit. Use /newbulk first.");
  const keyboard = Markup.inlineKeyboard(
    KNOWN_BULKS.map((t) => [b(t.name, `ebs:${t.id}`)])
  );
  await ctx.reply("📦 *Which bulk template to edit?*", { parse_mode: "Markdown", ...keyboard });
});

bot.command("editcamp", async (ctx) => {
  if (!KNOWN_CAMPAIGNS.length) return ctx.reply("🔁 No campaign templates to edit. Use /newcamp first.");
  const keyboard = Markup.inlineKeyboard(
    KNOWN_CAMPAIGNS.map((t) => [b(t.name, `ecs:${t.id}`)])
  );
  await ctx.reply("🔁 *Which campaign template to edit?*", { parse_mode: "Markdown", ...keyboard });
});

// Track which template is being edited and which field is awaiting text input
const _editSessions = new Map(); // userId → { kind, tplId, field, msgId }

// ── /setcollab — create & manage collab presets ──────────────────────────────

// Collab preset structure:
// { id: "dank-niche", name: "Dank Niche Collab", groups: [{ host: "handle", invites: ["h1","h2"] }, ...] }

const _collabSessions = new Map(); // userId → { phase, msgId, preset?, groupIdx? }

bot.command("setcollab", async (ctx) => {
  const existingBtns = KNOWN_COLLABS.map((c) => [
    b(`✏️ ${c.name} (${c.groups.length} groups)`, `sc:edit:${c.id}`),
  ]);
  existingBtns.push([b("➕ New Collab Preset", "sc:new")]);
  const kb = Markup.inlineKeyboard(existingBtns);
  const msg = await ctx.reply("🎭 *Collab Presets*\n\n_Manage your predefined collab groupings:_", {
    parse_mode: "Markdown", ...kb,
  });
  _collabSessions.set(ctx.from.id, { phase: "menu", msgId: msg.message_id });
});

bot.command("collabs", async (ctx) => {
  if (!KNOWN_COLLABS.length) return ctx.reply("🎭 No collab presets yet. Use /setcollab to create one.");
  const lines = KNOWN_COLLABS.map((c) => {
    const groupLines = c.groups.map((g, i) =>
      `  ${i + 1}. Host: @${g.host} · ${g.invites.map((h) => `@${h}`).join(" ")}`
    ).join("\n");
    return `*${c.name}*\n${groupLines}`;
  });
  await ctx.reply(`🎭 *Collab Presets*\n\n${lines.join("\n\n")}`, { parse_mode: "Markdown" });
});

function renderCollabPreset(preset) {
  if (!preset.groups.length) return "_No groups yet_";
  return preset.groups.map((g, i) =>
    `${i + 1}. Host: @${g.host}  ·  ${g.invites.map((h) => `@${h}`).join("  ")}`
  ).join("\n");
}

function collabPresetEditKeyboard(presetId) {
  return Markup.inlineKeyboard([
    [b("➕ Add Group", `sc:addgrp:${presetId}`), b("🗑️ Remove Last Group", `sc:rmgrp:${presetId}`)],
    [b("✏️ Rename", `sc:rename:${presetId}`), b("🗑️ Delete Preset", `sc:delete:${presetId}`)],
    [b("✅ Done", `sc:done:${presetId}`)],
  ]);
}

// ── Callback queries ──────────────────────────────────────────────────────────

bot.on("callback_query", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const data = ctx.callbackQuery.data || "";

  // ── Edit template selection (ebs: = edit bulk select, ecs: = edit camp select)
  if (data.startsWith("ebs:") || data.startsWith("ecs:")) {
    const kind = data.startsWith("ebs:") ? "bulk" : "camp";
    const tplId = data.slice(4);
    const list = kind === "bulk" ? KNOWN_BULKS : KNOWN_CAMPAIGNS;
    const tpl = list.find((t) => t.id === tplId);
    if (!tpl) return;
    const preview = renderTemplatePreview(tpl, kind);
    const kb = editTemplateKeyboard(tplId, kind);
    const msg = await ctx.telegram.editMessageText(
      ctx.chat.id, ctx.callbackQuery.message.message_id, undefined,
      `✏️ *Edit Template*\n\n${preview}\n\n_Tap a field to edit:_`,
      { parse_mode: "Markdown", ...kb }
    );
    return;
  }

  // ── Edit field selection (eb: = edit bulk field, ec: = edit camp field)
  if (data.startsWith("eb:") || data.startsWith("ec:")) {
    const kind = data.startsWith("eb:") ? "bulk" : "camp";
    const parts = data.slice(3).split(":");
    const tplId = parts[0];
    const field = parts[1];
    const list = kind === "bulk" ? KNOWN_BULKS : KNOWN_CAMPAIGNS;
    const tpl = list.find((t) => t.id === tplId);
    if (!tpl) return;

    if (field === "done") {
      await ctx.telegram.editMessageText(
        ctx.chat.id, ctx.callbackQuery.message.message_id, undefined,
        `✅ Template *${tpl.name}* saved!`,
        { parse_mode: "Markdown" }
      );
      _editSessions.delete(ctx.from.id);
      return;
    }

    // Store edit session for text follow-up
    _editSessions.set(ctx.from.id, {
      kind, tplId, field,
      msgId: ctx.callbackQuery.message.message_id,
    });

    const currentVal = field === "seniors"    ? (tpl.seniors || []).map((h) => `@${h}`).join(" ")
                     : field === "pages"      ? (tpl.pages || []).map((h) => `@${h}`).join(" ")
                     : field === "pagePrices" ? "per-page prices"
                     : field === "lastRefNum" ? String(tpl.lastRefNum || 0)
                     : tpl[field] || "not set";

    const prompts = {
      client:     `👤 *Client name?*\nCurrent: ${currentVal}\n_Type new value below ↓_`,
      adType:     `📂 *Ad type?*\nCurrent: ${currentVal}\n_Type new value below ↓_`,
      postType:   `📱 *Post type?* (Feed / Reels / Story)\nCurrent: ${currentVal}\n_Type new value below ↓_`,
      duration:   `⏳ *Duration?*\nCurrent: ${currentVal}\n_Type new value below ↓_`,
      nif:        `⏰ *NIF?* (none / 15 min / 30 min / 1hr)\nCurrent: ${currentVal}\n_Type new value below ↓_`,
      format:     `📐 *Format?* (Standard / Per-creative / Collab)\nCurrent: ${currentVal}\n_Type new value below ↓_`,
      refPrefix:  `🏷️ *Ref prefix?*\nCurrent: ${currentVal}\n_Type new value below ↓_`,
      lastRefNum: `🔢 *Last completed run #?*\nCurrent: ${currentVal}\n_Next run will be this + 1_\n_Type number below ↓_`,
      seniors:    `👥 *Seniors?*\nCurrent: ${currentVal}\n_Type @handles separated by spaces below ↓_`,
      pages:      `📄 *Pages?*\nCurrent: ${currentVal}\n_Type @handles separated by spaces below ↓_`,
      pagePrices: `💰 *Page prices?*\nFormat: @handle price bulk/total\nOne per line, e.g.:\n\`@dailyhumor_4u 400 13/15\`\n\`@scooby 120 13/15\`\n_Type below ↓_`,
    };

    await ctx.telegram.editMessageText(
      ctx.chat.id, ctx.callbackQuery.message.message_id, undefined,
      `✏️ *Edit Template — ${tpl.name}*\n\n${prompts[field] || "Type new value below ↓"}`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  // ── Collab preset callbacks (sc: prefix) ──────────────────────────────────
  if (data.startsWith("sc:")) {
    const parts = data.slice(3).split(":");
    const action = parts[0];
    const presetId = parts[1];
    const collabSess = _collabSessions.get(ctx.from.id);
    const msgId = collabSess?.msgId || ctx.callbackQuery.message?.message_id;

    if (action === "new") {
      _collabSessions.set(ctx.from.id, { phase: "name", msgId });
      await ctx.telegram.editMessageText(
        ctx.chat.id, msgId, undefined,
        "🎭 *New Collab Preset*\n\n📝 *Name?*\n_e.g. Dank Niche Collab · Type below ↓_",
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (action === "edit") {
      const preset = KNOWN_COLLABS.find((c) => c.id === presetId);
      if (!preset) return;
      _collabSessions.set(ctx.from.id, { phase: "editing", msgId, presetId });
      await ctx.telegram.editMessageText(
        ctx.chat.id, msgId, undefined,
        `🎭 *${preset.name}*\n\n${renderCollabPreset(preset)}\n\n_Edit this preset:_`,
        { parse_mode: "Markdown", ...collabPresetEditKeyboard(presetId) }
      );
      return;
    }

    if (action === "addgrp") {
      const preset = KNOWN_COLLABS.find((c) => c.id === presetId);
      if (!preset) return;
      _collabSessions.set(ctx.from.id, { phase: "addhost", msgId, presetId });
      await ctx.telegram.editMessageText(
        ctx.chat.id, msgId, undefined,
        `🎭 *${preset.name}* — Add Group\n\n${renderCollabPreset(preset)}\n\n` +
        `🎯 *Host for group ${preset.groups.length + 1}?*\n_Type @handle below ↓_`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (action === "rmgrp") {
      const preset = KNOWN_COLLABS.find((c) => c.id === presetId);
      if (!preset || !preset.groups.length) return;
      preset.groups.pop();
      saveCollabs();
      await ctx.telegram.editMessageText(
        ctx.chat.id, msgId, undefined,
        `🎭 *${preset.name}*\n\n${renderCollabPreset(preset)}\n\n✅ Last group removed\n_Edit this preset:_`,
        { parse_mode: "Markdown", ...collabPresetEditKeyboard(presetId) }
      );
      return;
    }

    if (action === "rename") {
      _collabSessions.set(ctx.from.id, { phase: "rename", msgId, presetId });
      await ctx.telegram.editMessageText(
        ctx.chat.id, msgId, undefined,
        "🎭 *Rename Preset*\n\n📝 Type new name below ↓",
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (action === "delete") {
      const idx = KNOWN_COLLABS.findIndex((c) => c.id === presetId);
      if (idx >= 0) {
        const name = KNOWN_COLLABS[idx].name;
        KNOWN_COLLABS.splice(idx, 1);
        saveCollabs();
        await ctx.telegram.editMessageText(
          ctx.chat.id, msgId, undefined,
          `🗑️ Preset *${name}* deleted.`,
          { parse_mode: "Markdown" }
        );
      }
      _collabSessions.delete(ctx.from.id);
      return;
    }

    if (action === "done") {
      const preset = KNOWN_COLLABS.find((c) => c.id === presetId);
      await ctx.telegram.editMessageText(
        ctx.chat.id, msgId, undefined,
        `✅ *${preset?.name || "Preset"}* saved! (${preset?.groups?.length || 0} groups)`,
        { parse_mode: "Markdown" }
      );
      _collabSessions.delete(ctx.from.id);
      return;
    }

    // ── Collab preset selection during campaign run (sc:use:presetId) ──
    if (action === "use") {
      const session = sessions.get(ctx.from.id);
      if (!session) return;
      const preset = KNOWN_COLLABS.find((c) => c.id === presetId);
      if (!preset) return;

      // Load preset groups into session content
      session.content.collabGroups = preset.groups.map((g) => ({
        host: g.host,
        invites: [...g.invites],
        media: [],
      }));
      session.content.collabGroupIdx = preset.groups.length - 1;
      session.content.collabBuildPhase = "more";
      session.content.collabPhase = "groups";
      await updateWizard(ctx.telegram, session);
      return;
    }

    // ── "Build manually" during campaign collab ──
    if (action === "manual") {
      const session = sessions.get(ctx.from.id);
      if (!session) return;
      // Just proceed — the default collab flow handles it
      session.content.collabPhase = "groups";
      session.content.collabGroupIdx = 0;
      session.content.collabBuildPhase = "host";
      await updateWizard(ctx.telegram, session);
      return;
    }

    return;
  }

  const session = sessions.get(ctx.from.id);
  if (!session) return;

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

        // ── Increment ref counter (persisted in-process; resets on redeploy) ──
        if (session._bulkTemplateId) {
          const bidx = KNOWN_BULKS.findIndex((t) => t.id === session._bulkTemplateId);
          if (bidx >= 0) { KNOWN_BULKS[bidx].lastRefNum = (KNOWN_BULKS[bidx].lastRefNum || 0) + 1; saveBulks(); }
        }
        if (session._campaignTemplateId) {
          const cidx = KNOWN_CAMPAIGNS.findIndex((t) => t.id === session._campaignTemplateId);
          if (cidx >= 0) { KNOWN_CAMPAIGNS[cidx].lastRefNum = (KNOWN_CAMPAIGNS[cidx].lastRefNum || 0) + 1; saveCampaigns(); }
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
    if (action === "skipBulkRefPrefix") {
      session._bulkRefPrefix = null;
      session.step = nextStep("bulkRefPrefix", session);
      await updateWizard(ctx.telegram, session);
      return;
    }
    if (action === "saveTemplate") {
      const a            = session.answers;
      const isCampaignTpl = session.mode === "campaign-template";
      const id  = (session._bulkName || "template")
        .toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
      const store    = isCampaignTpl ? KNOWN_CAMPAIGNS : KNOWN_BULKS;
      const existing = store.findIndex((t) => t.id === id);
      const template = {
        id,
        name:        session._bulkName || "Unnamed",
        refPrefix:   session._bulkRefPrefix || null,
        lastRefNum:  isCampaignTpl ? 0 : (session._bulkStartNum || 0),
        client:      a.client,
        adType:      a.adType,
        postType:    a.postType,
        duration:    a.duration,
        nif:         a.nif,
        seniors:     [...(a.seniors || [])],
        priceMode:   a.priceMode,
        format:      a.format,
        pages:       [...a.pages],
        // Campaigns: strip bulk slot #s — only keep prices
        perPagePrices: Object.fromEntries(
          Object.entries(JSON.parse(JSON.stringify(a.perPagePrices))).map(([h, v]) =>
            isCampaignTpl ? [h, { price: v.price, bulk: null }] : [h, v]
          )
        ),
      };
      if (existing >= 0) {
        if (!isCampaignTpl) template.lastRefNum = store[existing].lastRefNum || 0;
        store[existing] = template;
      } else {
        store.push(template);
      }
      isCampaignTpl ? saveCampaigns() : saveBulks();
      sessions.delete(ctx.from.id);
      const continueCmd = isCampaignTpl ? "/camp" : "/bulk";
      await ctx.telegram.editMessageText(
        session.chatId, session.wizardMsgId, undefined,
        `💾 *${isCampaignTpl ? "Campaign" : "Bulk"} template saved!*\n\n*${template.name}*\n` +
        `${template.refPrefix ? `Ref prefix: ${template.refPrefix}\n` : ""}` +
        `${template.pages.length} pages · Use ${continueCmd} to run it.`,
        { parse_mode: "Markdown" }
      );
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
    if (action === "seniorsDone") {
      if (!session.answers.seniors.length) return; // require at least 1
      session.step = nextStep("seniors", session);
      if (session._bulkTemplateId) skipFilledSteps(session);
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

  // ── Bulk start number selection ───────────────────────────────────────────
  if (data.startsWith("bsn:")) {
    const n = parseInt(data.slice(4), 10);
    session._bulkStartNum = isNaN(n) ? 0 : n;
    session.step = nextStep("bulkStartNum", session);
    await updateWizard(ctx.telegram, session);
    return;
  }

  // ── Seniors toggle ────────────────────────────────────────────────────────
  if (data.startsWith("sr:")) {
    const handle  = data.slice(3);
    const seniors = session.answers.seniors;
    const idx     = seniors.indexOf(handle);
    if (idx >= 0) seniors.splice(idx, 1);
    else seniors.push(handle);
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
    a.seniors     = [...(template.seniors || [])];
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

  // ── Campaign template selection ───────────────────────────────────────────
  if (data.startsWith("cmp:")) {
    const id       = data.slice(4);
    const template = KNOWN_CAMPAIGNS.find((t) => t.id === id);
    if (!template) return;

    const a = session.answers;
    a.client      = template.client   || null;
    a.adType      = template.adType   || null;
    a.postType    = template.postType || null;
    a.duration    = template.duration || null;
    a.nif         = template.nif      || null;
    a.seniors     = [...(template.seniors || [])];
    a.priceMode   = template.priceMode || "same";
    a.format      = template.format   || null;
    a.pages       = [...(template.pages || [])];
    a.perPagePrices = JSON.parse(JSON.stringify(template.perPagePrices || {}));

    if (a.priceMode === "per-page") {
      const total = a.pages.reduce((sum, h) => {
        const p = parseFloat(a.perPagePrices[h]?.price || "0");
        return sum + (isNaN(p) ? 0 : p);
      }, 0);
      a.price = String(total);
    }

    // Pre-fill campaignRef with suggested next # — user can edit it
    if (template.refPrefix) {
      a.campaignRef = `${template.refPrefix} ${(template.lastRefNum || 0) + 1}`;
    }

    session._campaignTemplateId = id;
    session._skipBulkSlots      = true; // campaigns never ask for slot #s

    // Land on campaignRef so the ref # can be freely confirmed or changed
    session.step = "campaignRef";
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
    // Skip past any pre-filled steps (betslip auto-flow)
    if (session._bulkTemplateId) skipFilledSteps(session);
    await updateWizard(ctx.telegram, session);
  }
});

// ── /pipeline — AI-powered pipeline summary ───────────────────────────────────

bot.command("pipeline", async (ctx) => {
  try {
    const msg = await ctx.reply("🔍 Pulling pipeline...");
    const summary = await brain.getPipelineSummary();
    const text = `📊 Pipeline Summary\n\n${summary}`;
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id, msg.message_id, undefined,
        `📊 *Pipeline Summary*\n\n${summary}`,
        { parse_mode: "Markdown" }
      );
    } catch (_) {
      await ctx.telegram.editMessageText(
        ctx.chat.id, msg.message_id, undefined, text
      );
    }
  } catch (err) {
    console.error("[wizard] /pipeline error:", err.message);
    await ctx.reply("Pipeline error: " + err.message);
  }
});

// ── /deal [client] — advice on a specific deal ────────────────────────────────

bot.command("deal", async (ctx) => {
  try {
    const clientName = ctx.message.text.replace(/^\/deal\s*/i, "").trim();
    if (!clientName) {
      return ctx.reply("Usage: /deal [client name]");
    }
    const msg = await ctx.reply(`🔍 Analyzing deal for "${clientName}"...`);
    const advice = await brain.getDealAdvice(clientName);
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id, msg.message_id, undefined,
        advice, { parse_mode: "Markdown" }
      );
    } catch (_) {
      await ctx.telegram.editMessageText(
        ctx.chat.id, msg.message_id, undefined, advice
      );
    }
  } catch (err) {
    console.error("[wizard] /deal error:", err.message);
    await ctx.reply("Pipeline error: " + err.message);
  }
});

// ── /recap — trigger morning recap on demand ──────────────────────────────────

bot.command("recap", async (ctx) => {
  try {
    await ctx.reply("🌅 Generating morning recap...");
    await brain.sendMorningRecap();
    await ctx.reply("✅ Recap sent to Greg+ Sales Team.");
  } catch (err) {
    console.error("[wizard] /recap error:", err.message);
    await ctx.reply("Recap error: " + err.message);
  }
});

// ── /nightrecap — trigger nightly revenue recap on demand ──────────────────

bot.command("nightrecap", async (ctx) => {
  try {
    await ctx.reply("🌙 Generating nightly revenue recap...");
    await brain.sendNightlyRecap();
    await ctx.reply("✅ Nightly recap sent to Greg+ Sales Team.");
  } catch (err) {
    console.error("[wizard] /nightrecap error:", err.message);
    await ctx.reply("Nightly recap error: " + err.message);
  }
});

// ── /betslip — generate Stake bet slip cover image via Digi ────────────────
// Usage: reply to a bet slip photo with /betslip, or send /betslip then a photo.
// Greg analyzes the screenshot with Claude Vision, sends it to Digi for rendering,
// and returns the finished cover image.

const _awaitingBetSlip = new Set(); // chat IDs waiting for a bet slip photo

bot.command("betslip", async (ctx) => {
  try {
    // Check if replying to a photo
    const replyMsg = ctx.message.reply_to_message;
    if (replyMsg && replyMsg.photo?.length) {
      return await processBetSlipPhoto(ctx, replyMsg);
    }

    // Otherwise, prompt user to send a photo
    _awaitingBetSlip.add(ctx.chat.id);
    await ctx.reply("📸 Send me the bet slip screenshot and I'll generate a cover for it.");

    // Auto-clear after 2 minutes
    setTimeout(() => _awaitingBetSlip.delete(ctx.chat.id), 120000);
  } catch (err) {
    console.error("[wizard] /betslip error:", err.message);
    await ctx.reply("Betslip error: " + err.message);
  }
});

// Listen for photos when awaiting bet slip
bot.on("photo", async (ctx) => {
  if (!_awaitingBetSlip.has(ctx.chat.id)) return;
  _awaitingBetSlip.delete(ctx.chat.id);
  await processBetSlipPhoto(ctx, ctx.message);
});

async function processBetSlipPhoto(ctx, photoMsg) {
  try {
    const progressMsg = await ctx.reply("🎨 Analyzing bet slip and generating cover...");

    // Get highest resolution photo
    const photo = photoMsg.photo[photoMsg.photo.length - 1];
    const fileLink = await ctx.telegram.getFileLink(photo.file_id);

    // Download the photo
    const res = await fetch(fileLink.href);
    if (!res.ok) throw new Error("Failed to download bet slip photo");
    const buffer = Buffer.from(await res.arrayBuffer());
    const base64 = buffer.toString("base64");

    // Determine MIME type from URL
    const mime = fileLink.href.includes(".png") ? "image/png" : "image/jpeg";

    // Generate cover via brain → Digi
    await ctx.telegram.editMessageText(
      ctx.chat.id, progressMsg.message_id, undefined,
      "🎨 Analyzing bet slip with Claude Vision..."
    ).catch(() => {});

    const result = await brain.generateBetSlipCover(base64, mime);

    if (!result.success) {
      await ctx.telegram.editMessageText(
        ctx.chat.id, progressMsg.message_id, undefined,
        `❌ Cover generation failed: ${result.error}`
      );
      return;
    }

    await ctx.telegram.editMessageText(
      ctx.chat.id, progressMsg.message_id, undefined,
      "✅ Cover generated! Setting up bulk ad brief..."
    ).catch(() => {});

    // Send the cover image to chat so we have a copyable message reference
    const coverBuffer = Buffer.from(result.imageBase64, "base64");
    const coverMsg = await ctx.replyWithPhoto(
      { source: coverBuffer, filename: "stake-cover.jpg" },
      { caption: `📊 ${result.analysis?.sport || "Sports"} | ${result.analysis?.headline || ""}` }
    );

    // ── Auto-flow into /bulk with stake-bet-slips template ──────────────
    const template = KNOWN_BULKS.find((t) => t.id === "stake-bet-slips");
    if (!template) {
      await ctx.reply("⚠️ No 'stake-bet-slips' bulk template found. Use /newbulk to create one first, then try /betslip again.");
      await ctx.telegram.deleteMessage(ctx.chat.id, progressMsg.message_id).catch(() => {});
      return;
    }

    // Create a fresh session and pre-fill from bulk template
    const session = freshSession(ctx.chat.id);
    const nextNum = (template.lastRefNum || 0) + 1;
    const a = session.answers;

    a.client      = template.client    || "Stake";
    a.campaignRef = template.refPrefix ? `${template.refPrefix} ${nextNum}` : null;
    a.adType      = template.adType    || "Affiliate";
    a.postType    = template.postType  || "Feed";
    a.duration    = template.duration  || "Permanent";
    a.nif         = template.nif       || "15 min";
    a.seniors     = [...(template.seniors || [])];
    a.priceMode   = template.priceMode || "per-page";
    a.format      = template.format    || "Standard";
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

    // Pre-fill caption from Claude analysis
    a.caption = result.analysis?.caption || null;

    // Store the cover image as content (message ref for copyMessage)
    session.content.shared.push({
      fromChatId: ctx.chat.id,
      msgId:      coverMsg.message_id,
    });

    // Also store the original bet slip as content
    session.content.shared.push({
      fromChatId: photoMsg.chat.id,
      msgId:      photoMsg.message_id,
    });

    // Remember template for counter increment on post
    session._bulkTemplateId = "stake-bet-slips";

    // Jump straight to time selection (everything else is pre-filled)
    session.step = "time";

    // Show the wizard
    const { text, keyboard } = renderMsg(session);
    const wizMsg = await ctx.reply(text, { parse_mode: "Markdown", ...(keyboard || {}) });
    session.wizardMsgId = wizMsg.message_id;
    sessions.set(ctx.from.id, session);

    await ctx.telegram.deleteMessage(ctx.chat.id, progressMsg.message_id).catch(() => {});
  } catch (err) {
    console.error("[wizard] processBetSlipPhoto error:", err.message);
    await ctx.reply("Cover generation error: " + err.message);
  }
}

// ── Text messages ─────────────────────────────────────────────────────────────

bot.on("text", async (ctx) => {
  if (ctx.message.text.startsWith("/")) return;

  // ── Handle collab preset text input ────────────────────────────────────
  const collabSess = _collabSessions.get(ctx.from.id);
  if (collabSess && ["name", "rename", "addhost", "addinvites"].includes(collabSess.phase)) {
    const input = ctx.message.text.trim();
    try { await ctx.deleteMessage(); } catch (_) {}
    const { phase, msgId, presetId } = collabSess;

    if (phase === "name") {
      // Create new preset
      const id = input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const preset = { id, name: input, groups: [] };
      KNOWN_COLLABS.push(preset);
      saveCollabs();
      _collabSessions.set(ctx.from.id, { phase: "editing", msgId, presetId: id });
      await ctx.telegram.editMessageText(
        ctx.chat.id, msgId, undefined,
        `🎭 *${preset.name}*\n\n_No groups yet — add your first collab group:_`,
        { parse_mode: "Markdown", ...collabPresetEditKeyboard(id) }
      );
      return;
    }

    if (phase === "rename") {
      const preset = KNOWN_COLLABS.find((c) => c.id === presetId);
      if (preset) { preset.name = input; saveCollabs(); }
      _collabSessions.set(ctx.from.id, { phase: "editing", msgId, presetId });
      await ctx.telegram.editMessageText(
        ctx.chat.id, msgId, undefined,
        `🎭 *${preset?.name || input}*\n\n${renderCollabPreset(preset)}\n\n✅ Renamed!\n_Edit this preset:_`,
        { parse_mode: "Markdown", ...collabPresetEditKeyboard(presetId) }
      );
      return;
    }

    if (phase === "addhost") {
      const host = input.replace(/^@/, "").toLowerCase().trim();
      _collabSessions.set(ctx.from.id, { phase: "addinvites", msgId, presetId, _host: host });
      const preset = KNOWN_COLLABS.find((c) => c.id === presetId);
      await ctx.telegram.editMessageText(
        ctx.chat.id, msgId, undefined,
        `🎭 *${preset?.name}* — Group ${(preset?.groups?.length || 0) + 1}\n\n` +
        `Host: @${host}\n\n👥 *Invite pages?*\n_Type @handles separated by spaces below ↓_`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (phase === "addinvites") {
      const invites = [...input.matchAll(/@?([\w.]+)/g)]
        .map((m) => m[1].toLowerCase()).filter((h) => h.length > 1);
      const preset = KNOWN_COLLABS.find((c) => c.id === presetId);
      if (preset) {
        preset.groups.push({ host: collabSess._host, invites });
        saveCollabs();
      }
      _collabSessions.set(ctx.from.id, { phase: "editing", msgId, presetId });
      await ctx.telegram.editMessageText(
        ctx.chat.id, msgId, undefined,
        `🎭 *${preset?.name}*\n\n${renderCollabPreset(preset)}\n\n✅ Group added!\n_Edit this preset:_`,
        { parse_mode: "Markdown", ...collabPresetEditKeyboard(presetId) }
      );
      return;
    }
  }

  // ── Handle edit template text input ──────────────────────────────────────
  const editSess = _editSessions.get(ctx.from.id);
  if (editSess) {
    const input = ctx.message.text.trim();
    try { await ctx.deleteMessage(); } catch (_) {}

    const list = editSess.kind === "bulk" ? KNOWN_BULKS : KNOWN_CAMPAIGNS;
    const tpl = list.find((t) => t.id === editSess.tplId);
    if (!tpl) { _editSessions.delete(ctx.from.id); return; }

    const { field } = editSess;

    if (field === "seniors") {
      tpl.seniors = [...input.matchAll(/@?([\w.]+)/g)]
        .map((m) => m[1].toLowerCase()).filter((h) => h.length > 1);
    } else if (field === "pages") {
      tpl.pages = [...input.matchAll(/@?([\w.]+)/g)]
        .map((m) => m[1].toLowerCase()).filter((h) => h.length > 1);
    } else if (field === "lastRefNum") {
      const num = parseInt(input, 10);
      if (!isNaN(num)) tpl.lastRefNum = num;
    } else if (field === "pagePrices") {
      // Parse: @handle price bulk/total  (one per line)
      const lines = input.split("\n").map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        const m = line.match(/@?([\w.]+)\s+(\d+)\s+(\d+\/\d+)/);
        if (m) {
          const handle = m[1].toLowerCase();
          tpl.perPagePrices = tpl.perPagePrices || {};
          tpl.perPagePrices[handle] = { price: m[2], bulk: m[3] };
        }
      }
    } else {
      tpl[field] = input;
    }

    // Save
    if (editSess.kind === "bulk") saveBulks(); else saveCampaigns();

    // Show updated template
    const preview = renderTemplatePreview(tpl, editSess.kind);
    const kb = editTemplateKeyboard(editSess.tplId, editSess.kind);
    _editSessions.delete(ctx.from.id);

    await ctx.telegram.editMessageText(
      ctx.chat.id, editSess.msgId, undefined,
      `✏️ *Edit Template*\n\n${preview}\n\n✅ *${EDITABLE_FIELDS.find((f) => f.key === field)?.label || field}* updated!\n_Tap another field or Done:_`,
      { parse_mode: "Markdown", ...kb }
    );
    return;
  }

  const session = sessions.get(ctx.from.id);
  if (!session) return;

  const input = ctx.message.text.trim();
  try { await ctx.deleteMessage(); } catch (_) {}

  // ── Template creation steps ───────────────────────────────────────────────
  if (session.step === "bulkName") {
    session._bulkName = input;
    session.step = nextStep("bulkName", session);
    await updateWizard(ctx.telegram, session);
    return;
  }
  if (session.step === "bulkRefPrefix") {
    session._bulkRefPrefix = input;
    session.step = nextStep("bulkRefPrefix", session);
    await updateWizard(ctx.telegram, session);
    return;
  }

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
    if (field === "bulkStartNum") {
      const n = parseInt(input.replace(/[^0-9]/g, ""), 10);
      session._bulkStartNum  = isNaN(n) ? 0 : n;
      session.awaitingCustom = null;
      session.step           = nextStep("bulkStartNum", session);
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

// ── Sales intelligence startup ────────────────────────────────────────────────
// Connects to @sales_bolismedia and listens to all chats automatically.

brain.startAutoCapture();

// ── Morning recap — 8:00 AM Arizona time (MST, no DST) ───────────────────────

cron.schedule("0 8 * * *", () => {
  brain.sendMorningRecap()
    .catch((e) => console.error("[wizard] morning recap error:", e.message));
}, { timezone: "America/Phoenix" });

// ── Nightly lesson extraction — 11:00 PM Arizona time ────────────────────────

cron.schedule("0 23 * * *", () => {
  brain.extractNightlyLessons()
    .catch((e) => console.error("[wizard] nightly lessons error:", e.message));
}, { timezone: "America/Phoenix" });

// ── Nightly revenue recap — 9:00 PM Arizona time ─────────────────────────

cron.schedule("0 21 * * *", () => {
  brain.sendNightlyRecap()
    .catch((e) => console.error("[wizard] nightly recap error:", e.message));
}, { timezone: "America/Phoenix" });

// ── Launch ────────────────────────────────────────────────────────────────────

bot.launch().then(() => console.log("✅ Greg (Ad Brief Wizard) running"));
process.once("SIGINT",  () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
