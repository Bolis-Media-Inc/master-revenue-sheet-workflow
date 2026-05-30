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
const pagesRegistry   = require("./lib/pages");
const postedHandler   = require("./handlers/postedHandler");
const apiServer       = require("./lib/api");
const poster          = require("./lib/poster");

// ── Config ────────────────────────────────────────────────────────────────────

const WIZARD_TOKEN     = process.env.WIZARD_BOT_TOKEN;
const TARGET_CHAT      = process.env.WIZARD_TARGET_CHAT_ID;
const SALES_TEAM_CHAT  = process.env.SALES_TEAM_CHAT_ID || "";
const WIZARD_ADMIN_ID  = parseInt(process.env.WIZARD_ADMIN_USER_ID || "0", 10);
const ADMIN_HANDLES    = (process.env.WIZARD_ADMIN_HANDLES || "")
  .split(",").map((h) => h.trim().replace(/^@/, "")).filter(Boolean);

const contributors = require("./lib/contributors");
const posters      = require("./lib/posters");
const sessionsLib  = require("./lib/sessions");

// Escape Telegram Markdown V1 specials so user-controlled strings
// (especially usernames containing "_") can't break entity parsing
// in a message we render with parse_mode: "Markdown". V1's reserved
// characters outside an entity are: _ * ` [
function escapeMd(s) {
  return String(s == null ? "" : s).replace(/([_*`\[])/g, "\\$1");
}

/**
 * True if the Telegram user is a sales-admin who can grant/revoke the
 * sales-contributor role. Today: WIZARD_ADMIN_USER_ID (Connor) only —
 * we keep this conservative since granting a contributor also grants
 * them /ad access. Expand later if other senior sales need this.
 */
function isSalesAdmin(telegramId) {
  if (!telegramId) return false;
  if (WIZARD_ADMIN_ID && Number(telegramId) === WIZARD_ADMIN_ID) return true;
  return false;
}

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
function reloadBulks() {
  try { KNOWN_BULKS = JSON.parse(fs.readFileSync(BULKS_PATH, "utf8")); }
  catch (_) { KNOWN_BULKS = []; }
}
reloadBulks();

// Watch the file so external mutations (e.g. lib/api.js advancing bulk
// slots after an HTTP /api/ad/intake post) get reflected in the wizard
// without a restart. Polls every 2s — Railway file IO is fast enough.
try {
  fs.watchFile(BULKS_PATH, { interval: 2000 }, () => reloadBulks());
} catch (e) {
  console.warn("[wizard] could not watch bulks.json:", e.message);
}

function saveBulks() {
  try { fs.writeFileSync(BULKS_PATH, JSON.stringify(KNOWN_BULKS, null, 2)); }
  catch (_) {}
  // Also push to Supabase mirror — fire-and-forget, never blocks the wizard
  try {
    const bulkTemplates = require("./lib/bulkTemplates");
    bulkTemplates.mirrorNow().catch((e) =>
      console.error("[wizard] supabase mirror error:", e.message)
    );
  } catch (_) {}
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
      // Merge core seniors with registered posters. Posters added via
      // /addposter @name show up here on next session start (sync cache
      // refreshes on add/remove + every 5min).
      const posterUsernames = posters.listActiveSync()
        .map((p) => p.username)
        .filter(Boolean);
      const merged = Array.from(new Set([...ALL_SENIORS, ...posterUsernames]));
      const rows = merged.map((h) => {
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
            `${n > 0 ? `✅  ${n} file(s) received` : "_Send files here, then tap Done_\n💡  Tip: tap 📎 → *File* to keep full quality"}`,
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
            `${n > 0 ? `✅  ${n} file(s) received` : "_Send files for this page_\n💡  Tip: tap 📎 → *File* to keep full quality"}`,
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
              `${n > 0 ? `✅  ${n} file(s) received` : "_Send video or images below ↓_\n💡  Tip: tap 📎 → *File* to keep full quality"}`,
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
  // Header dollar amount:
  //   same-price mode → a.price (the single base price)
  //   per-page mode   → sum of perPagePrices (e.g. $400 + $300 + $300 = $1000)
  // Live wizard runs in per-page mode leave a.price null; the bulk-template
  // load path already sums for its summary, but the live brief needs it too.
  let headerPrice;
  if (a.priceMode === "per-page") {
    const total = (a.pages || []).reduce((sum, h) => {
      const p = parseFloat(a.perPagePrices?.[h]?.price || "0");
      return sum + (isNaN(p) ? 0 : p);
    }, 0);
    headerPrice = total;
  } else {
    headerPrice = a.price ?? 0;
  }
  const header  = `${a.client} - ${a.adType} - $${headerPrice}`;
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
    // Same price across all pages — render `@handle - $price` per line so
    // each row in PAGE INFO carries the dollar amount (matches the sales
    // team's brief convention). Skip the suffix if no price was set.
    const samePrice = a.price != null && a.price !== "" ? a.price : null;
    pageLines = a.pages.map((h) => {
      const handlePart = campaignNumPrefix ? `(${campaignNumPrefix}) @${h}` : `@${h}`;
      return samePrice != null ? `${handlePart} - $${samePrice}` : handlePart;
    }).join("\n");
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
  // All media goes as documents — sales-team convention. sendCapturedAsDocument
  // uses the captured file_id when available and falls back to copyMessage
  // for legacy refs that pre-date the file_id capture.
  const sendDoc = (ref) => sendCapturedAsDocument(telegram, TARGET_CHAT, ref);

  // Helper: send caption if one was set
  const sendCaption = async () => {
    if (answers.caption) await telegram.sendMessage(TARGET_CHAT, answers.caption);
  };

  if (fmt === "Standard") {
    for (const ref of content.shared) await sendDoc(ref);
    await sendCaption();
    await telegram.sendMessage(TARGET_CHAT, buildBrief(answers));

  } else if (fmt === "Per-creative") {
    for (const handle of answers.pages) {
      const msgs = content.byHandle[handle] || [];
      if (msgs.length) {
        await telegram.sendMessage(TARGET_CHAT, `${handle}^`);
        for (const ref of msgs) await sendDoc(ref);
      }
    }
    await sendCaption();
    await telegram.sendMessage(TARGET_CHAT, buildBrief(answers));

  } else if (fmt === "Collab") {
    for (const g of content.collabGroups) {
      for (const ref of g.media) await sendDoc(ref);
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

// ── Sales-contributor review submission ─────────────────────────────────────
// Routes a contributor's /ad submission to SALES_TEAM_CHAT_ID for sales-team
// review. The wizard's session content (Telegram message refs from the
// contributor's DM) is persisted in ad_sessions.payload so the approver can
// re-run the post against TARGET_CHAT minutes/hours later via copyMessage.

async function submitForSalesReview(ctx, session) {
  if (!SALES_TEAM_CHAT) {
    await ctx.telegram.editMessageText(
      session.chatId, session.wizardMsgId, undefined,
      "⚠️ Sales review chat not configured (SALES_TEAM_CHAT_ID missing). Ask Connor to set it up.",
    );
    sessions.delete(ctx.from.id);
    return;
  }

  // 1. Persist wizard state (answers + content refs) in ad_sessions
  const adSession = await sessionsLib.createSession({
    userId: ctx.from.id,
    source: "wizard-contributor",
    step:   "pending_review",
    payload: {
      // Wizard-shaped state — used at approve-time to replay copyMessage
      // against TARGET_CHAT and run the existing forwardContentToPages
      // flow.
      wizard: {
        answers: session.answers,
        content: session.content,
        sourceChatId: session.chatId,    // contributor's DM chat id
        userInfo: {
          userId: ctx.from.id,
          firstName: ctx.from.first_name || null,
          lastName:  ctx.from.last_name  || null,
          username:  ctx.from.username   || null,
        },
        bulkTemplateId:     session._bulkTemplateId     || null,
        campaignTemplateId: session._campaignTemplateId || null,
      },
      // Mirror enough of the intake-payload shape so other tooling
      // (poster.js, bm_tracking_bot's parser) can read this session
      // consistently with HTTP-intake sessions.
      campaign: {
        client:    session.answers.client,
        adType:    session.answers.adType,
        basePrice: parseFloat(session.answers.price) || 0,
      },
      adInfo: {
        time:     session.answers.time,
        postType: session.answers.postType,
        duration: session.answers.duration,
        nif:      session.answers.nif,
        seniors:  session.answers.seniors,
        caption:  session.answers.caption,
      },
      pages: (session.answers.pages || []).map((h) => ({ handle: h })),
    },
  });
  if (!adSession) {
    await ctx.telegram.editMessageText(
      session.chatId, session.wizardMsgId, undefined,
      "❌ Couldn't queue submission for review (database error). Try again or ping Connor.",
    );
    sessions.delete(ctx.from.id);
    return;
  }

  // Mark as pending_review (createSession defaults to 'pending')
  await sessionsLib.updateSession(adSession.id, {
    status: "pending_review",
    step:   "pending_review",
  });

  // 2. Mirror the creatives + brief into SALES_TEAM_CHAT_ID via copyMessage
  //    so reviewers see exactly what'll go to Internal Network Ads.
  //    Pass ctx.from explicitly — the in-memory wizard session doesn't carry
  //    Telegram user info, so the review card needs it threaded through.
  const submitterInfo = {
    userId:    ctx.from.id,
    firstName: ctx.from.first_name || null,
    lastName:  ctx.from.last_name  || null,
    username:  ctx.from.username   || null,
  };
  const mirrorResult = await postWizardReviewCard(ctx.telegram, adSession.id, session, submitterInfo);

  // 3. Reply to the contributor in their DM. If the mirror failed, surface
  //    the real reason so we don't silently tell them "submitted" when
  //    nothing actually landed in the review chat.
  if (!mirrorResult.ok) {
    await ctx.telegram.editMessageText(
      session.chatId, session.wizardMsgId, undefined,
      `⚠️ *Submission incomplete*\n\n` +
      `I saved your ad to the queue but couldn't post the review card to the monetization chat:\n\n` +
      `_${mirrorResult.error}_\n\n` +
      `Connor — please check that:\n` +
      `· \`SALES_TEAM_CHAT_ID\` is set on Greg's Railway service\n` +
      `· Greg is a member of that chat\n` +
      `· The chat ID is correct (groups are negative, e.g. \`-1003547231643\`)`,
      { parse_mode: "Markdown" },
    );
    // Also DM the admin so they see the failure even if the contributor doesn't ping
    if (WIZARD_ADMIN_ID && ctx.from.id !== WIZARD_ADMIN_ID) {
      try {
        await ctx.telegram.sendMessage(
          WIZARD_ADMIN_ID,
          `⚠️ *Contributor submission failed to mirror*\n\n` +
          `From: ${ctx.from?.first_name || ctx.from?.id}\n` +
          `Session: \`${adSession.id}\`\n` +
          `Error: ${mirrorResult.error}`,
          { parse_mode: "Markdown" },
        );
      } catch (_) {}
    }
  } else {
    await ctx.telegram.editMessageText(
      session.chatId, session.wizardMsgId, undefined,
      "🛂 *Submitted for sales review*\n\n" +
      "Your ad is in the monetization team's review queue. " +
      "You'll get a DM here when it's approved or rejected.",
      { parse_mode: "Markdown" },
    );
  }

  sessions.delete(ctx.from.id);
}

async function postWizardReviewCard(telegram, sessionId, wizardSession, submitterInfo = null) {
  if (!SALES_TEAM_CHAT) {
    return { ok: false, error: "SALES_TEAM_CHAT_ID is not set on Greg's Railway service" };
  }

  const fmt = wizardSession.answers.format;
  const content = wizardSession.content || {};

  // Probe the chat first — if Greg can't post even a tiny message, we
  // know the issue (chat ID wrong, bot not a member, etc.) and can
  // surface a single clean error instead of streaming media into the
  // void and only failing on the brief at the end.
  let probeOk = true;
  let probeError = null;
  try {
    // Send a leading "starting" marker so reviewers see something even
    // if a later step fails. This also doubles as our connectivity probe.
    await telegram.sendMessage(SALES_TEAM_CHAT, "🛂 *Incoming submission for review…*", { parse_mode: "Markdown" });
  } catch (e) {
    probeOk = false;
    probeError = e.message || String(e);
    console.error(`[wizard] cannot post to SALES_TEAM_CHAT_ID=${SALES_TEAM_CHAT}: ${probeError}`);
  }

  if (!probeOk) {
    // Translate raw Telegram errors into something actionable
    let hint = probeError;
    if (/chat not found/i.test(probeError)) {
      hint = `chat not found — verify SALES_TEAM_CHAT_ID is the correct chat ID (Monetization Team + AI's chat is -1003547231643)`;
    } else if (/forbidden|bot was kicked|not enough rights/i.test(probeError)) {
      hint = `Greg isn't a member of that chat (or got kicked). Add @${BOT_USERNAME_HINT} to the chat first.`;
    }
    return { ok: false, error: hint };
  }

  // Forward creatives as documents (sales-team convention) in the
  // format-specific order so the review chat sees what Internal Network
  // Ads would see at post time.
  const sendDoc = (ref) => sendCapturedAsDocument(telegram, SALES_TEAM_CHAT, ref);

  try {
    if (fmt === "Standard") {
      for (const ref of content.shared || []) {
        await sendDoc(ref);
      }
    } else if (fmt === "Per-creative") {
      for (const handle of wizardSession.answers.pages || []) {
        const msgs = content.byHandle?.[handle] || [];
        if (msgs.length === 0) continue;
        await telegram.sendMessage(SALES_TEAM_CHAT, `${handle}^`).catch(() => {});
        for (const ref of msgs) {
          await sendDoc(ref);
        }
      }
    } else if (fmt === "Collab") {
      for (const g of content.collabGroups || []) {
        for (const ref of g.media || []) {
          await sendDoc(ref);
        }
        const invites = (g.invites || []).map((h) => `@${h}`).join("\n");
        await telegram.sendMessage(SALES_TEAM_CHAT, `Host: @${g.host}, invite:\n\n${invites}`).catch(() => {});
      }
    }
    if (wizardSession.answers.caption) {
      await telegram.sendMessage(SALES_TEAM_CHAT, wizardSession.answers.caption).catch(() => {});
    }
    await telegram.sendMessage(SALES_TEAM_CHAT, buildBrief(wizardSession.answers)).catch(() => {});
  } catch (e) {
    console.error("[wizard] review preview error:", e.message);
  }

  // Review card with Approve / Reject buttons.
  // Submitter info comes from the caller's ctx.from (threaded in as
  // submitterInfo) — the in-memory wizard session doesn't carry Telegram
  // user identity. Fall back to the persisted payload's wizard.userInfo
  // for any legacy callers that don't pass submitterInfo yet.
  const u = submitterInfo || wizardSession.userInfo || {};
  const submitter = u.username
    ? `@${escapeMd(u.username)}`
    : u.userId
    ? `user ${u.userId}`
    : "unknown submitter";

  // Post review card with retry-on-429 + auto-persist on success.
  const cardResult = await _sendReviewCardWithRetry(telegram, sessionId, submitter);
  if (!cardResult.ok) return cardResult;
  return { ok: true };
}

/**
 * Post the Approve/Reject review card for a given session_id to the
 * monetization chat, with retry-on-429 (5 attempts, honoring Telegram's
 * retry_after between each). On success, persists review_msg in DB.
 *
 * Used by:
 *   - postWizardReviewCard (the main wizard submit flow)
 *   - /repostreview admin command (recovery for sessions where the
 *     initial send hit a sustained 429 and exhausted retries)
 *
 * Returns { ok, error?, card? }. The card field is the sent Message
 * object on success — useful if the caller wants the message_id.
 */
async function _sendReviewCardWithRetry(telegram, sessionId, submitter) {
  if (!SALES_TEAM_CHAT) {
    return { ok: false, error: "SALES_TEAM_CHAT_ID is not set on Greg's Railway service" };
  }

  const REVIEW_RETRIES = 5; // bumped from 3 — sustained 429s need more headroom
  let lastErr = null;
  for (let attempt = 1; attempt <= REVIEW_RETRIES; attempt++) {
    try {
      const card = await telegram.sendMessage(
        SALES_TEAM_CHAT,
        `🛂 *Pending sales review* — submitted by ${submitter}\n` +
        `_Approve to post to Internal Network Ads (30s cancel window)_`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[
              { text: "✅ Approve & post", callback_data: `wreview:approve:${sessionId}` },
              { text: "❌ Reject",         callback_data: `wreview:reject:${sessionId}`  },
            ]],
          },
        },
      );
      // Persist on success so future /repostreview can detect already-posted
      await sessionsLib.updateSession(sessionId, {
        review_msg: { chatId: card.chat.id, messageId: card.message_id },
      });
      return { ok: true, card };
    } catch (e) {
      lastErr = e;
      const retryAfterSec =
        e.parameters?.retry_after ||
        e.response?.parameters?.retry_after ||
        (typeof e.description === "string" && e.description.match(/retry after (\d+)/i)?.[1]) ||
        null;
      const is429 = e.code === 429 || /429|too many requests/i.test(e.message || "");
      if (is429 && attempt < REVIEW_RETRIES) {
        // Honor Telegram's retry_after if provided; otherwise exponential
        // backoff starting at 5s so a "no retry_after" 429 still escalates.
        const waitSec = retryAfterSec
          ? parseInt(retryAfterSec, 10) + 1
          : Math.min(5 * Math.pow(2, attempt - 1), 300); // 5, 10, 20, 40, 80 (cap 300)
        console.warn(`[wizard] review card 429 (attempt ${attempt}/${REVIEW_RETRIES}) — waiting ${waitSec}s before retry`);
        await new Promise((r) => setTimeout(r, waitSec * 1000));
        continue;
      }
      // Non-429 OR exhausted retries → surface
      console.error(`[wizard] review card send failed (attempt ${attempt}/${REVIEW_RETRIES}):`, e.message);
      return { ok: false, error: `Posted creative + brief but the Approve/Reject card failed: ${e.message}` };
    }
  }
  return { ok: false, error: `Posted creative + brief but the Approve/Reject card failed: ${lastErr?.message || "unknown"}` };
}

// Best-effort placeholder — populated after bot.launch() resolves
let BOT_USERNAME_HINT = "the bot";

// ── Forward content directly to page channels ────────────────────────────────
// Greg knows exactly which content goes to which page at submission time,
// so we forward media directly to each page's destination channel here.
// bm_tracking_bot only needs to forward the ad brief afterwards.

const PLACEHOLDER_PATTERN = /^(SHEET_ID_|TELEGRAM_CHAT_ID_)/;

async function forwardContentToPages(telegram, session) {
  const { answers, content } = session;
  const fmt = answers.format;
  const pages = answers.pages || [];

  if (!pages.length) return;

  // Resolve unique destination chat IDs (dedup when multiple handles share a channel)
  const forwardedDests = new Set();

  // All media goes as documents — sales-team convention. Falls back
  // to forwardMessage for legacy refs without file_id.
  const fwd = (destChatId, ref) => sendCapturedAsDocument(telegram, destChatId, ref);

  if (fmt === "Standard") {
    // Shared content → every page
    for (const handle of pages) {
      const dest = pagesRegistry.getChatId(handle) || pagesRegistry.getChatId(handle.replace(/[._]/g, ""));
      if (!dest || PLACEHOLDER_PATTERN.test(String(dest))) continue;
      const destKey = String(dest);
      if (forwardedDests.has(destKey)) continue;
      forwardedDests.add(destKey);

      for (const ref of content.shared) await fwd(destKey, ref);
    }

  } else if (fmt === "Per-creative") {
    // Each page gets its own content
    for (const handle of pages) {
      const dest = pagesRegistry.getChatId(handle) || pagesRegistry.getChatId(handle.replace(/[._]/g, ""));
      if (!dest || PLACEHOLDER_PATTERN.test(String(dest))) continue;
      const destKey = String(dest);
      if (forwardedDests.has(destKey)) continue;
      forwardedDests.add(destKey);

      const msgs = content.byHandle[handle] || [];
      for (const ref of msgs) await fwd(destKey, ref);
    }

  } else if (fmt === "Collab") {
    // Each collab group's media → all handles in that group (host + invites)
    for (const g of content.collabGroups) {
      const allHandles = [g.host, ...g.invites];
      for (const handle of allHandles) {
        const dest = pagesRegistry.getChatId(handle) || pagesRegistry.getChatId(handle.replace(/[._]/g, ""));
        if (!dest || PLACEHOLDER_PATTERN.test(String(dest))) continue;
        const destKey = String(dest);
        if (forwardedDests.has(destKey)) continue;
        forwardedDests.add(destKey);

        for (const ref of g.media) await fwd(destKey, ref);
      }
    }
  }

  // Forward caption to all pages if set
  if (answers.caption && forwardedDests.size > 0) {
    for (const destKey of forwardedDests) {
      try {
        await telegram.sendMessage(destKey, answers.caption);
      } catch (e) {
        console.error(`[wizard] caption send error → ${destKey}: ${e.message}`);
      }
    }
  }

  console.log(`[wizard] 📤 Content forwarded to ${forwardedDests.size} destination(s)`);
}

// ── Edit wizard message in place ──────────────────────────────────────────────
//
// Coalesced edits: when a user sends a media group of 8 photos, Telegram
// fires 8 separate updates ~50-200ms apart. Each one calls updateWizard,
// which calls editMessageText — but Telegram rate-limits edits to roughly
// 1/sec per message, silently dropping the rest. The result is a frozen
// "4 file(s) received" display even though the wizard array has all 8.
//
// We debounce per session: each call schedules a trailing-edge edit ~600ms
// out. If another update comes in before that fires, cancel and re-schedule.
// After the burst settles, exactly one edit fires with the final count.
// _flushPending(sessionId) forces an immediate flush — used by callback
// handlers (Done button, step transitions) so the UI is current the
// moment the user takes an action.

const _pendingEdits = new Map(); // sessionId → { timer, telegram, session }
const EDIT_DEBOUNCE_MS = 600;

async function _doEdit(telegram, session) {
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

async function updateWizard(telegram, session, { immediate = false } = {}) {
  const key = session.chatId; // one wizard message per chat
  // Cancel any pending edit for this session
  const pending = _pendingEdits.get(key);
  if (pending) clearTimeout(pending.timer);

  if (immediate) {
    _pendingEdits.delete(key);
    return _doEdit(telegram, session);
  }

  // Schedule a trailing-edge edit. If another updateWizard fires before
  // EDIT_DEBOUNCE_MS, we'll cancel this timer above.
  const timer = setTimeout(() => {
    _pendingEdits.delete(key);
    _doEdit(telegram, session).catch(() => {});
  }, EDIT_DEBOUNCE_MS);
  _pendingEdits.set(key, { timer, telegram, session });
}

// ── /ad command ───────────────────────────────────────────────────────────────

bot.command("ad", async (ctx) => {
  // Clear any stale edit/collab sessions so they don't intercept text
  _editSessions.delete(ctx.from.id);
  _collabSessions.delete(ctx.from.id);
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

// ── /bulks — sales-team bulk dashboard (mobile-friendly status view) ──────────
//
// Mirrors what /bulks shows on Digi web, but as a Telegram-native message
// so sales can check progress without opening a laptop. One-line summary
// per template with completion %, $ spent vs committed, slot count.
// Tap a template to drill into /bulkstatus.

const PROGRESS_BAR_WIDTH = 10;
function progressBar(pct) {
  const filled = Math.max(0, Math.min(PROGRESS_BAR_WIDTH, Math.round((pct / 100) * PROGRESS_BAR_WIDTH)));
  return "█".repeat(filled) + "░".repeat(PROGRESS_BAR_WIDTH - filled);
}

bot.command("bulks", async (ctx) => {
  const bulkTemplates = require("./lib/bulkTemplates");
  const all = bulkTemplates.list();
  // Filter to active (status='open' or unset, treat unset as open for legacy rows)
  const open = all.filter((b) => !b.status || b.status === "open");
  if (open.length === 0) {
    return ctx.reply(
      "📦 No open bulk campaigns.\n\n" +
      "Use /newbulk to create one, or /editbulk to reopen an archived template.",
    );
  }

  const lines = ["📦 *Open bulk campaigns*", ""];
  const buttons = [];
  for (const t of open) {
    const p = bulkTemplates.progress(t.id);
    if (!p) continue;
    const pct = p.totals.completionPct;
    const spent = Math.round(p.totals.dollarsSpent).toLocaleString();
    const committed = Math.round(p.totals.totalDollarsCommitted).toLocaleString();
    const refLine = t.refPrefix ? ` · next: \`${t.refPrefix} ${p.nextRefNum}\`` : "";
    lines.push(
      `*${t.name}*${refLine}\n` +
      `\`${progressBar(pct)}\` ${pct.toFixed(0)}%\n` +
      `${p.totals.usedSlots}/${p.totals.totalSlots} slots · $${spent} of $${committed}` +
      (p.totals.pagesFull > 0 ? ` · ${p.totals.pagesFull} pages full` : ""),
      "",
    );
    buttons.push([b(`📊 ${t.name}`, `bs:${t.id}`)]);
  }

  await ctx.reply(lines.join("\n"), {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard(buttons),
  });
});

// ── /bulkstatus <slug> — single-bulk drill-down with admin controls ───────────

async function renderBulkStatus(ctx, bulkId, opts = {}) {
  const bulkTemplates = require("./lib/bulkTemplates");
  const p = bulkTemplates.progress(bulkId);
  if (!p) {
    const msg = `📦 Bulk template not found: \`${bulkId}\``;
    return opts.edit ? ctx.editMessageText(msg, { parse_mode: "Markdown" }) : ctx.reply(msg, { parse_mode: "Markdown" });
  }

  const pct = p.totals.completionPct;
  const spent = Math.round(p.totals.dollarsSpent).toLocaleString();
  const committed = Math.round(p.totals.totalDollarsCommitted).toLocaleString();
  const remaining = Math.round(p.totals.dollarsRemaining).toLocaleString();
  const statusEmoji = p.status === "completed" ? "✅" : p.status === "archived" ? "📁" : "🟢";
  const refLine = p.refPrefix ? `\n🏷️  Next ref: \`${p.refPrefix} ${p.nextRefNum}\`` : "";

  const lines = [
    `📦 *${p.name}* ${statusEmoji} _${p.status}_`,
    p.client ? `👤  ${p.client}${p.adType ? ` · ${p.adType}` : ""}` : "",
    refLine.trim(),
    "",
    `\`${progressBar(pct)}\` *${pct.toFixed(0)}%*`,
    `📊  ${p.totals.usedSlots}/${p.totals.totalSlots} slots · ${p.totals.pagesFull}/${p.totals.pagesCount} pages full`,
    `💰  $${spent} spent · $${remaining} remaining of $${committed}`,
    "",
    "*Per-page:*",
  ].filter(Boolean);

  // Page table — sort by remaining slots desc so most-active pages show first
  const sortedPages = [...p.pages].sort((a, b) => b.remaining - a.remaining);
  for (const pg of sortedPages.slice(0, 20)) {
    const tag = pg.full
      ? "🟢 FULL"
      : `${pg.used}/${pg.total}`;
    const price = pg.price ? ` $${pg.price}` : "";
    lines.push(`\`${tag.padEnd(9)}\` @${pg.handle}${price}`);
  }
  if (p.pages.length > 20) {
    lines.push(`_…and ${p.pages.length - 20} more pages_`);
  }

  // Status controls — only show when relevant
  const buttons = [];
  if (p.status === "open") {
    if (p.totals.pagesRemaining === 0) {
      // All pages full → suggest mark complete prominently
      buttons.push([b("✅ All slots used — mark complete", `bs-complete:${p.id}`)]);
    } else {
      buttons.push([
        b("✅ Mark complete", `bs-complete:${p.id}`),
        b("📁 Archive", `bs-archive:${p.id}`),
      ]);
    }
  } else if (p.status === "archived") {
    buttons.push([b("🔄 Reopen", `bs-reopen:${p.id}`)]);
  }
  buttons.push([b("🔄 Refresh", `bs:${p.id}`)]);

  const text = lines.join("\n");
  const replyOpts = { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) };
  return opts.edit ? ctx.editMessageText(text, replyOpts) : ctx.reply(text, replyOpts);
}

bot.command("bulkstatus", async (ctx) => {
  const arg = ctx.message.text.replace(/^\/bulkstatus(@\w+)?\s*/i, "").trim();
  if (!arg) {
    return ctx.reply(
      "Usage: `/bulkstatus <slug>`\n\nOr just /bulks to pick from a list.",
      { parse_mode: "Markdown" },
    );
  }
  await renderBulkStatus(ctx, arg);
});

// Inline button: drill into a bulk from /bulks
bot.action(/^bs:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const bulkId = ctx.match[1];
  // Fresh status as a NEW message (not edit) — simpler when chained from /bulks
  await renderBulkStatus(ctx, bulkId);
});

// Inline buttons: status changes
bot.action(/^bs-(complete|archive|reopen):(.+)$/, async (ctx) => {
  const action = ctx.match[1];
  const bulkId = ctx.match[2];
  const status = action === "complete" ? "completed" : action === "archive" ? "archived" : "open";
  const bulkTemplates = require("./lib/bulkTemplates");

  const result = bulkTemplates.setStatus(bulkId, status);
  if (result.error) {
    await ctx.answerCbQuery(`Failed: ${result.error}`, { show_alert: true });
    return;
  }
  await ctx.answerCbQuery(`✓ ${action === "complete" ? "Marked completed" : action === "archive" ? "Archived" : "Reopened"}`);
  // Re-render the same message in place so the user sees the new status + buttons
  await renderBulkStatus(ctx, bulkId, { edit: true });
});

bot.command("editcamp", async (ctx) => {
  if (!KNOWN_CAMPAIGNS.length) return ctx.reply("🔁 No campaign templates to edit. Use /newcamp first.");
  const keyboard = Markup.inlineKeyboard(
    KNOWN_CAMPAIGNS.map((t) => [b(t.name, `ecs:${t.id}`)])
  );
  await ctx.reply("🔁 *Which campaign template to edit?*", { parse_mode: "Markdown", ...keyboard });
});

// ── Sales-contributor management ─────────────────────────────────────────────
// Reply-based commands for granting + revoking sales-contributor status.
// Contributors can run /ad in Greg DM but their submissions queue in
// SALES_TEAM_CHAT_ID for review by core sales — instead of firing direct
// to Internal Network Ads.
//
// Auth: only WIZARD_ADMIN_USER_ID (Connor) can grant/revoke. Anyone with
// access to that account can extend by setting their telegram_id in env.

// Pull @handles out of arbitrary text (e.g. command args). Normalised to
// lowercase, no leading @. Returns [] when nothing matches.
function extractPageHandles(text) {
  const matches = String(text || "").match(/@([\w.]+)/g) || [];
  return Array.from(new Set(matches.map((h) => h.slice(1).toLowerCase())));
}

// Pull a Telegram-style @username (no `.`, distinct from page handles
// which can contain dots). First match wins.
function extractTgUsername(text) {
  const m = String(text || "").match(/(?:^|\s)@([A-Za-z][A-Za-z0-9_]{4,31})\b/);
  return m ? m[1].toLowerCase() : null;
}

bot.command("addcontributor", async (ctx) => {
  if (!isSalesAdmin(ctx.from?.id)) {
    return ctx.reply("⛔ Only sales admin can grant contributor status.");
  }

  const cmdText = ctx.message?.text || "";
  const replyTo = ctx.message?.reply_to_message;
  const allowedPages = extractPageHandles(cmdText);

  // ── Path 1: replied to the contributor's message — instant grant ────────
  if (replyTo?.from) {
    const target = replyTo.from;
    if (target.is_bot) return ctx.reply("⛔ Can't grant contributor status to a bot.");

    const displayName = [target.first_name, target.last_name].filter(Boolean).join(" ")
      || (target.username ? `@${target.username}` : null);

    const result = await contributors.addContributor({
      telegramId:   target.id,
      displayName,
      grantedBy:    ctx.from.id,
      allowedPages: allowedPages.length > 0 ? allowedPages : null,
    });
    if (!result.ok) return ctx.reply(`⚠️ Failed: ${result.error}`);

    const scopeLine = allowedPages.length > 0
      ? `Scoped to: ${allowedPages.map((h) => "@" + h).join(", ")}`
      : `Unrestricted — can submit for any page.`;
    return ctx.reply(
      `✅ Granted sales-contributor status to ${displayName || target.id}.\n\n` +
      `${scopeLine}\n\n` +
      `They can now run /ad in their DM with me. Submissions queue in the monetization team chat for review.\n\n` +
      `Adjust their page scope anytime with /setcontributorpages (reply to their message + handles).`,
    );
  }

  // ── Path 2: @username invite — pending until they DM Greg ──────────────
  // Telegram bot API can't resolve @username → user_id without the user
  // having sent a message Greg can see. Store as a pending invite that
  // auto-activates the moment the user messages Greg.
  const username = extractTgUsername(cmdText);
  if (username) {
    const result = await contributors.createInvite({
      username,
      grantedBy: ctx.from.id,
      allowedPages: allowedPages.length > 0 ? allowedPages : null,
    });
    if (!result.ok) return ctx.reply(`⚠️ Failed: ${result.error}`);

    const scopeLine = allowedPages.length > 0
      ? `Scoped to: ${allowedPages.map((h) => "@" + h).join(", ")}`
      : `Unrestricted — can submit for any page.`;
    return ctx.reply(
      `📌 *Pending invite for @${username}*\n\n` +
      `${scopeLine}\n\n` +
      `Once @${username} sends me any message (e.g. \`/start\`), the grant activates automatically. ` +
      `Tell them to DM me to finish setup — I'll DM you a confirmation when it lands.\n\n` +
      `Cancel anytime: \`/canceleinvite @${username}\``,
      { parse_mode: "Markdown" },
    );
  }

  // ── Help ──────────────────────────────────────────────────────────────
  return ctx.reply(
    "👤 *How to grant contributor status*\n\n" +
    "*Reply to the contributor's message* with:\n" +
    "`/addcontributor` — unrestricted (any page)\n" +
    "`/addcontributor @goal @thefuck.tv` — scoped to those pages\n\n" +
    "*Or grant by username* (works even if they haven't DM'd me yet):\n" +
    "`/addcontributor @theiruser` — unrestricted, pending until they DM me\n" +
    "`/addcontributor @theiruser @goal @thefuck.tv` — scoped, pending\n\n" +
    "_Telegram usernames are case-insensitive. Page handles can contain dots; usernames can't._",
    { parse_mode: "Markdown" },
  );
});

// ── Poster registry ──────────────────────────────────────────────────────
// Posters are people responsible for posting ads on Instagram. They
// show up in the /ad wizard's "Who's responsible for posting?" step
// alongside ALL_SENIORS — so contributors / VAs can be picked there.
// Same admin-only auth + pending-invite-by-username pattern as
// /addcontributor.

bot.command("addposter", async (ctx) => {
  if (!isSalesAdmin(ctx.from?.id)) {
    return ctx.reply("⛔ Only sales admin can register posters.");
  }
  const cmdText = ctx.message?.text || "";
  const replyTo = ctx.message?.reply_to_message;
  const pages   = extractPageHandles(cmdText);

  // Path 1: replied to an existing user's message → instant grant
  if (replyTo?.from) {
    const target = replyTo.from;
    if (target.is_bot) return ctx.reply("⛔ Can't register a bot as a poster.");
    if (!target.username) {
      return ctx.reply(
        "⚠️ That user doesn't have a Telegram @username set.\n\n" +
        "Posters need a username so the wizard can render them as @handle buttons. " +
        "Ask them to set one in Telegram → Settings → Username, then retry.",
      );
    }
    const displayName = [target.first_name, target.last_name].filter(Boolean).join(" ")
      || `@${target.username}`;
    const result = await posters.addPoster({
      telegramId:  target.id,
      username:    target.username,
      displayName,
      addedBy:     ctx.from.id,
      pages:       pages.length > 0 ? pages : null,
    });
    if (!result.ok) return ctx.reply(`⚠️ Failed: ${result.error}`);

    const scopeLine = pages.length > 0
      ? `Scoped to: ${pages.map((h) => "@" + h).join(", ")}`
      : `Unrestricted — listed for any page.`;
    return ctx.reply(
      `✅ Registered @${target.username} as a poster.\n\n${scopeLine}\n\n` +
      `They'll now appear in /ad's "Who's responsible for posting?" list.`,
    );
  }

  // Path 2: invite by username
  const username = extractTgUsername(cmdText);
  if (username) {
    const result = await posters.createInvite({
      username,
      addedBy: ctx.from.id,
      pages: pages.length > 0 ? pages : null,
    });
    if (!result.ok) return ctx.reply(`⚠️ Failed: ${result.error}`);

    const scopeLine = pages.length > 0
      ? `Scoped to: ${pages.map((h) => "@" + h).join(", ")}`
      : `Unrestricted — listed for any page.`;
    return ctx.reply(
      `📌 *Pending poster invite for @${username}*\n\n${scopeLine}\n\n` +
      `Once @${username} sends me any message, they'll be registered as a poster ` +
      `and show up in /ad's "Who's responsible for posting?" list.`,
      { parse_mode: "Markdown" },
    );
  }

  return ctx.reply(
    "📋 *How to register a poster*\n\n" +
    "*Reply to their message:*\n" +
    "`/addposter` — listed for any page\n" +
    "`/addposter @goal @thefuck.tv` — scoped to those pages\n\n" +
    "*Or by username* (works even if they haven't DM'd me yet):\n" +
    "`/addposter @theiruser` — pending until they DM me\n" +
    "`/addposter @theiruser @goal @thefuck.tv` — scoped, pending",
    { parse_mode: "Markdown" },
  );
});

bot.command("setposterpages", async (ctx) => {
  if (!isSalesAdmin(ctx.from?.id)) return;
  const replyTo = ctx.message?.reply_to_message;
  if (!replyTo?.from) {
    return ctx.reply(
      "Reply to the poster's message:\n" +
      "`/setposterpages @goal @thefuck.tv` — restrict to those pages\n" +
      "`/setposterpages` (no handles) — clear restriction",
      { parse_mode: "Markdown" },
    );
  }
  const target = replyTo.from;
  const pages = extractPageHandles(ctx.message?.text || "");
  const result = await posters.setPosterPages(target.id, pages);
  if (!result.ok) return ctx.reply(`⚠️ Failed: ${result.error}`);
  const scopeLine = pages.length > 0
    ? `Scoped to: ${pages.map((h) => "@" + h).join(", ")}`
    : `Unrestricted — listed for any page.`;
  await ctx.reply(`✅ @${result.row.username || target.id} — ${scopeLine}`);
});

bot.command("removeposter", async (ctx) => {
  if (!isSalesAdmin(ctx.from?.id)) return;
  const replyTo = ctx.message?.reply_to_message;
  if (!replyTo?.from) {
    return ctx.reply("Reply to the poster's message with `/removeposter`.", { parse_mode: "Markdown" });
  }
  const result = await posters.removePoster(replyTo.from.id);
  if (!result.ok) return ctx.reply(`⚠️ Failed: ${result.error}`);
  if (!result.removed) return ctx.reply("ℹ️ That user isn't a registered poster.");
  await ctx.reply(`✅ Removed @${result.removed.display_name || replyTo.from.id} from posters.`);
});

bot.command("listposters", async (ctx) => {
  if (!isSalesAdmin(ctx.from?.id)) return;
  const [list, invites] = await Promise.all([
    posters.listActive(),
    posters.listInvites(),
  ]);
  if (list.length === 0 && invites.length === 0) {
    return ctx.reply("📋 No posters registered.");
  }
  const lines = [];
  if (list.length > 0) {
    lines.push("📋 *Registered posters*", "");
    for (const p of list) {
      const handle = p.username ? "@" + p.username : `tg:${p.telegram_id}`;
      const scope = Array.isArray(p.pages) && p.pages.length > 0
        ? p.pages.map((h) => "@" + h).join(", ")
        : "_unrestricted_";
      lines.push(`· ${handle} ${p.display_name && p.display_name !== p.username ? `(${p.display_name})` : ""}\n   ↳ ${scope}`);
    }
  }
  if (invites.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("📌 *Pending poster invites* _(activate when user DMs me)_", "");
    for (const i of invites) {
      const scope = Array.isArray(i.pages) && i.pages.length > 0
        ? i.pages.map((h) => "@" + h).join(", ")
        : "_unrestricted_";
      lines.push(`· @${i.username}\n   ↳ ${scope}`);
    }
  }
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
});

// Cancel a pending invite that hasn't been claimed yet.
bot.command("canceleinvite", async (ctx) => {
  if (!isSalesAdmin(ctx.from?.id)) return;
  const username = extractTgUsername(ctx.message?.text || "");
  if (!username) {
    return ctx.reply("Usage: `/canceleinvite @username`", { parse_mode: "Markdown" });
  }
  const result = await contributors.deleteInvite(username);
  if (!result.ok) return ctx.reply(`⚠️ Failed: ${result.error}`);
  await ctx.reply(`✅ Cancelled pending invite for @${username}.`);
});

// /setcontributorpages — reply to a contributor's message + supply page
// handles (or no handles, to clear the restriction).
bot.command("setcontributorpages", async (ctx) => {
  if (!isSalesAdmin(ctx.from?.id)) {
    return ctx.reply("⛔ Only sales admin can update contributor scope.");
  }
  const replyTo = ctx.message?.reply_to_message;
  if (!replyTo?.from) {
    return ctx.reply(
      "👤 *How to update contributor scope*\n\n" +
      "Reply to the contributor's message:\n" +
      "`/setcontributorpages @goal @thefuck.tv` — restrict to those pages\n" +
      "`/setcontributorpages` (no handles) — clear restriction (any page)",
      { parse_mode: "Markdown" },
    );
  }
  const target = replyTo.from;
  const allowedPages = extractPageHandles(ctx.message?.text || "");

  const result = await contributors.setAllowedPages(target.id, allowedPages);
  if (!result.ok) return ctx.reply(`⚠️ Failed: ${result.error}`);

  const displayName = result.row?.display_name || `tg:${target.id}`;
  const scopeLine = allowedPages.length > 0
    ? `Scoped to: ${allowedPages.map((h) => "@" + h).join(", ")}`
    : `Unrestricted — can submit for any page.`;
  await ctx.reply(`✅ ${displayName} — ${scopeLine}`);
});

bot.command("removecontributor", async (ctx) => {
  if (!isSalesAdmin(ctx.from?.id)) {
    return ctx.reply("⛔ Only sales admin can revoke contributor status.");
  }
  const replyTo = ctx.message?.reply_to_message;
  if (!replyTo?.from) {
    return ctx.reply("👤 Reply to the contributor's message with /removecontributor.");
  }
  const target = replyTo.from;
  const result = await contributors.removeContributor(target.id);
  if (!result.ok) return ctx.reply(`⚠️ Failed: ${result.error}`);
  if (!result.removed) return ctx.reply("ℹ️ That user wasn't a contributor.");

  const displayName = result.removed.display_name || target.id;
  await ctx.reply(
    `✅ Revoked sales-contributor status from ${displayName}.\n\n` +
    `Their pending review submissions stay intact; only future /ad calls will stop queuing for review.`,
  );
});

bot.command("listcontributors", async (ctx) => {
  if (!isSalesAdmin(ctx.from?.id)) return; // silent — others don't need to see it
  const [list, invites] = await Promise.all([
    contributors.listContributors(),
    contributors.listInvites(),
  ]);

  const lines = [];
  if (list.length === 0 && invites.length === 0) {
    return ctx.reply("👥 No active sales contributors or pending invites.");
  }

  if (list.length > 0) {
    lines.push("👥 *Active sales contributors*", "");
    for (const c of list) {
      const name = c.display_name || `tg:${c.telegram_id}`;
      const granted = c.granted_at ? new Date(c.granted_at).toLocaleDateString() : "?";
      const scope = Array.isArray(c.allowed_pages) && c.allowed_pages.length > 0
        ? c.allowed_pages.map((h) => "@" + h).join(", ")
        : "_unrestricted_";
      lines.push(`· ${name} \`(${c.telegram_id})\` — added ${granted}\n   ↳ ${scope}`);
    }
  }

  if (invites.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("📌 *Pending invites* _(activate when user DMs me)_", "");
    for (const i of invites) {
      const granted = i.granted_at ? new Date(i.granted_at).toLocaleDateString() : "?";
      const scope = Array.isArray(i.allowed_pages) && i.allowed_pages.length > 0
        ? i.allowed_pages.map((h) => "@" + h).join(", ")
        : "_unrestricted_";
      lines.push(`· @${i.username} — invited ${granted}\n   ↳ ${scope}`);
    }
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
});

// ── Auto-materialize pending invites on first contact ─────────────────────
// Both contributor and poster invites are keyed by username — when a user
// with a matching pending invite DMs Greg, we resolve their telegram_id
// and convert the invite. Both flavors can fire for the same user
// (relewans is contributor + poster). Runs as best-effort middleware,
// never blocks the rest of the handler chain.
//
// CRITICAL: short-circuit for users we've already processed this session.
// Without this, every photo/video in a media-group upload fires two
// Supabase round-trips, which slows the webhook response enough that
// Telegram drops some updates mid-burst (observed: 5 of 8 photos
// captured on Marcell's submission). Once-per-process per user is
// sufficient — invite consumption is one-shot anyway.
const _inviteCheckSeen = new Set(); // telegram_id of users we've already processed
bot.use(async (ctx, next) => {
  try {
    const username = ctx.from?.username;
    if (username && ctx.from?.id && !_inviteCheckSeen.has(ctx.from.id)) {
      _inviteCheckSeen.add(ctx.from.id);
      const tgId = ctx.from.id;
      const display = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") || null;

      // 1. Contributor invite
      const contribResult = await contributors.tryConsumeInvite({
        telegramId: tgId, username, displayName: display,
      });
      if (contribResult) {
        try {
          const scope = Array.isArray(contribResult.invite.allowed_pages) && contribResult.invite.allowed_pages.length > 0
            ? `for: ${contribResult.invite.allowed_pages.map((h) => "@" + h).join(", ")}`
            : "for any page (unrestricted)";
          await ctx.telegram.sendMessage(
            contribResult.telegramId,
            `✅ You've been granted sales-contributor access ${scope}.\n\n` +
            `Run /ad in this chat to submit your first ad. Submissions go to the monetization team for review before posting.`,
          );
        } catch (_) {}
        if (contribResult.invite.granted_by) {
          try {
            await ctx.telegram.sendMessage(
              contribResult.invite.granted_by,
              `✅ @${contribResult.username} just DM'd me — sales-contributor invite activated.`,
            );
          } catch (_) {}
        }
      }

      // 2. Poster invite (independent of contributor — both can fire)
      const posterResult = await posters.tryConsumeInvite({
        telegramId: tgId, username, displayName: display,
      });
      if (posterResult) {
        try {
          const scope = Array.isArray(posterResult.invite.pages) && posterResult.invite.pages.length > 0
            ? `for: ${posterResult.invite.pages.map((h) => "@" + h).join(", ")}`
            : "for any page";
          await ctx.telegram.sendMessage(
            posterResult.telegramId,
            `📋 You're now listed as a poster ${scope}. ` +
            `When the team submits ads, you'll be selectable in the "Who's responsible for posting?" step.`,
          );
        } catch (_) {}
        if (posterResult.invite.added_by) {
          try {
            await ctx.telegram.sendMessage(
              posterResult.invite.added_by,
              `✅ @${posterResult.username} just DM'd me — poster invite activated.`,
            );
          } catch (_) {}
        }
      }
    }
  } catch (e) {
    console.error("[wizard] invite materialization error:", e.message);
  }
  return next();
});

// Track which template is being edited and which field is awaiting text input
const _editSessions = new Map(); // userId → { kind, tplId, field, msgId }

// ── Sales-contributor review: pending reject prompts ────────────────────────
// When a sales reviewer taps ❌ Reject on a review card, we send a force_reply
// prompt asking for a note. The next text message that targets that prompt is
// consumed as the rejection reason. 10-min TTL; cleanup via fixed interval.
const _pendingRejectPrompts = new Map(); // promptMessageId → { sessionId, approverTelegramId, chatId, createdAt }
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of _pendingRejectPrompts) if (v.createdAt < cutoff) _pendingRejectPrompts.delete(k);
}, 60 * 1000).unref();

// ── /repostreview — admin recovery for stuck sessions ───────────────────────
// When the initial review-card post hit a sustained 429 and exhausted all 5
// retries, the session lands in DB with status=pending_review but
// review_msg=null. Admin runs:
//
//   /repostreview <session_id>
//
// and Greg re-attempts the Approve/Reject card post (with retry logic
// included). Idempotent — if review_msg is already set, refuses to repost.
//
// Marcel's a14ea948 stuck session was the trigger. Admin-only since this
// targets a specific session and shouldn't be exposed to contributors.
bot.command("repostreview", async (ctx) => {
  if (!isSalesAdmin(ctx.from?.id)) return; // silent for non-admins
  const args = (ctx.message?.text || "").trim().split(/\s+/).slice(1);
  const sessionId = args[0];
  if (!sessionId) {
    return ctx.reply(
      "*Usage:* `/repostreview <session_id>`\n\n" +
      "Look up the stuck session in Supabase ad_sessions (status=pending_review, review_msg IS NULL) and pass its `id`.",
      { parse_mode: "Markdown" }
    );
  }
  // Fetch session
  let adSession;
  try {
    const { data } = await sessionsLib._supabase
      .from("ad_sessions").select("*").eq("id", sessionId).single();
    adSession = data;
  } catch (err) {
    return ctx.reply(`❌ DB lookup failed: \`${err.message}\``, { parse_mode: "Markdown" });
  }
  if (!adSession) {
    return ctx.reply(`❌ No session with id \`${sessionId}\``, { parse_mode: "Markdown" });
  }
  if (adSession.status !== "pending_review") {
    return ctx.reply(
      `ℹ️ Session is in status \`${adSession.status}\` — review card only makes sense for \`pending_review\`.`,
      { parse_mode: "Markdown" }
    );
  }
  if (adSession.review_msg) {
    return ctx.reply(
      `ℹ️ Review card was already posted: chat \`${adSession.review_msg.chatId}\`, message \`${adSession.review_msg.messageId}\`. ` +
      `Nothing to redo.`,
      { parse_mode: "Markdown" }
    );
  }

  // Reconstruct the submitter label from payload.wizard.userInfo
  const userInfo = adSession.payload?.wizard?.userInfo || {};
  const submitter = userInfo.username
    ? `@${escapeMd(userInfo.username)}`
    : userInfo.userId
    ? `user ${userInfo.userId}`
    : `user ${adSession.user_id}`;

  await ctx.reply(`⏳ Re-posting review card for session \`${sessionId.slice(0, 8)}…\`…`, { parse_mode: "Markdown" });

  const result = await _sendReviewCardWithRetry(ctx.telegram, sessionId, submitter);
  if (result.ok) {
    await ctx.reply(
      `✅ Review card re-posted to monetization chat (message ${result.card.message_id}).\n` +
      `Approve/Reject buttons are live again.`
    );
  } else {
    await ctx.reply(`❌ Re-post failed: ${result.error}`);
  }
});

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
  const data = ctx.callbackQuery.data || "";

  // ── Posted-ad disambiguation buttons (handles its own answerCbQuery) ────
  if (data.startsWith("posted:")) {
    const handled = await postedHandler.handlePostedCallback(ctx);
    if (handled) return;
  }

  // ── Intake cancel button ────────────────────────────────────────────────
  if (data.startsWith("intake:cancel:")) {
    const sessionId = data.slice("intake:cancel:".length);
    await poster.cancelIntake(bot, sessionId);
    await ctx.answerCbQuery("Cancelled — ad was not sent");
    return;
  }

  // ── Sales-contributor review: Approve ───────────────────────────────────
  if (data.startsWith("review:approve:")) {
    const sessionId = data.slice("review:approve:".length);
    try {
      const approverLabel = ctx.from?.username ? `@${escapeMd(ctx.from.username)}` : null;
      const result = await poster.approveSession(bot, sessionId, ctx.from?.id || null, approverLabel);
      if (!result.ok) {
        await ctx.answerCbQuery(result.error || "Couldn't approve", { show_alert: true });
        return;
      }
      await ctx.answerCbQuery("✅ Approved — sending in 30s");
    } catch (e) {
      console.error("[wizard] review approve error:", e.message);
      await ctx.answerCbQuery("Error — see logs", { show_alert: true });
    }
    return;
  }

  // ── Sales-contributor review: Reject (force-reply for optional reason) ──
  // Tap → bot replies to the reviewer with a force_reply prompt asking for
  // a note. The next text reply is interpreted as the rejection reason.
  // Empty / "skip" / "no reason" → reject without note.
  if (data.startsWith("review:reject:")) {
    const sessionId = data.slice("review:reject:".length);
    try {
      const prompt = await ctx.reply(
        `❌ Rejecting session \`${sessionId.slice(0, 8)}…\` — reply to *this* message with a note for the contributor (or "skip" for no note).`,
        {
          parse_mode: "Markdown",
          reply_markup: { force_reply: true, selective: true },
        },
      );
      _pendingRejectPrompts.set(prompt.message_id, {
        sessionId,
        approverTelegramId: ctx.from?.id || null,
        approverUsername: ctx.from?.username || null,
        chatId: ctx.chat.id,
        createdAt: Date.now(),
      });
      await ctx.answerCbQuery("Add a note?");
    } catch (e) {
      console.error("[wizard] review reject prompt error:", e.message);
      await ctx.answerCbQuery("Error — see logs", { show_alert: true });
    }
    return;
  }

  // ── Wizard-contributor review: Approve & post ────────────────────────────
  // The contributor's wizard ran end-to-end in their DM; we just need to
  // replay the saved message refs against TARGET_CHAT to post + run the
  // standard per-page forwarding + sheet logging chain. Then DM the
  // contributor with a confirmation.
  if (data.startsWith("wreview:approve:")) {
    const sessionId = data.slice("wreview:approve:".length);
    try {
      const { data: adSession } = await sessionsLib._supabase
        .from("ad_sessions").select("*").eq("id", sessionId).single();
      if (!adSession) {
        await ctx.answerCbQuery("Session not found", { show_alert: true });
        return;
      }
      if (adSession.status !== "pending_review") {
        await ctx.answerCbQuery(`Already ${adSession.status}`, { show_alert: true });
        return;
      }

      const wizardState = adSession.payload?.wizard;
      if (!wizardState?.answers || !wizardState?.content) {
        await ctx.answerCbQuery("Missing wizard state — can't post", { show_alert: true });
        return;
      }

      // Reconstruct the wizard-shaped session for postToGroup +
      // forwardContentToPages
      const replaySession = {
        answers: wizardState.answers,
        content: wizardState.content,
        chatId:  wizardState.sourceChatId,
      };

      await postToGroup(ctx.telegram, replaySession);
      await forwardContentToPages(ctx.telegram, replaySession);

      // Bump bulk/campaign template ref counters if the contributor used one
      if (wizardState.bulkTemplateId) {
        const bidx = KNOWN_BULKS.findIndex((t) => t.id === wizardState.bulkTemplateId);
        if (bidx >= 0) { KNOWN_BULKS[bidx].lastRefNum = (KNOWN_BULKS[bidx].lastRefNum || 0) + 1; saveBulks(); }
      }
      if (wizardState.campaignTemplateId) {
        const cidx = KNOWN_CAMPAIGNS.findIndex((t) => t.id === wizardState.campaignTemplateId);
        if (cidx >= 0) { KNOWN_CAMPAIGNS[cidx].lastRefNum = (KNOWN_CAMPAIGNS[cidx].lastRefNum || 0) + 1; saveCampaigns(); }
      }

      await sessionsLib.markSent(sessionId);

      // Edit the review card to lock it out
      if (adSession.review_msg) {
        try {
          await ctx.telegram.editMessageText(
            adSession.review_msg.chatId,
            adSession.review_msg.messageId,
            undefined,
            `✅ *Approved + posted to Internal Network Ads*\n_Approved by ${ctx.from?.username ? "@" + escapeMd(ctx.from.username) : escapeMd(ctx.from?.first_name || `user ${ctx.from?.id}`)}_`,
            { parse_mode: "Markdown" },
          );
        } catch (_) {}
      }

      // DM the contributor
      if (adSession.user_id) {
        try {
          await ctx.telegram.sendMessage(
            adSession.user_id,
            "✅ Your ad was approved and posted to Internal Network Ads.",
          );
        } catch (e) {
          console.warn(`[wizard] approve notify contributor ${adSession.user_id}: ${e.message}`);
        }
      }

      await ctx.answerCbQuery("✅ Posted to Internal Network Ads");
    } catch (e) {
      console.error("[wizard] wreview approve error:", e.message);
      await ctx.answerCbQuery("Error — see logs", { show_alert: true });
    }
    return;
  }

  // ── Wizard-contributor review: Reject (force_reply for note) ─────────────
  if (data.startsWith("wreview:reject:")) {
    const sessionId = data.slice("wreview:reject:".length);
    try {
      const prompt = await ctx.reply(
        `❌ Rejecting submission \`${sessionId.slice(0, 8)}…\` — reply to *this* message with a note for the contributor (or "skip" for no note).`,
        { parse_mode: "Markdown", reply_markup: { force_reply: true, selective: true } },
      );
      // Re-use _pendingRejectPrompts but tag with kind so the consumer
      // knows which path to take. Could fork — keeping it simple.
      _pendingRejectPrompts.set(prompt.message_id, {
        sessionId,
        approverTelegramId: ctx.from?.id || null,
        approverUsername: ctx.from?.username || null,
        chatId: ctx.chat.id,
        createdAt: Date.now(),
        kind: "wizard",
      });
      await ctx.answerCbQuery("Add a note?");
    } catch (e) {
      console.error("[wizard] wreview reject prompt error:", e.message);
      await ctx.answerCbQuery("Error — see logs", { show_alert: true });
    }
    return;
  }

  await ctx.answerCbQuery().catch(() => {});

  // ── Betslip headline option pick ────────────────────────────────────────
  if (data.startsWith("bshl:")) {
    const idx = parseInt(data.slice(5), 10);
    const pending = _betslipPending.get(ctx.from.id);
    if (!pending || pending.step !== "headline") return;

    const chosenHeadline = pending.headlines[idx];
    if (!chosenHeadline) return;

    // Set the chosen headline
    pending.analysis.headline = chosenHeadline;
    pending.step = "image";

    // Clean up headline picker
    const chatId = pending.chatId || ctx.chat.id;
    await ctx.telegram.deleteMessage(chatId, ctx.callbackQuery.message.message_id).catch(() => {});

    // Now proceed to image search
    await ctx.telegram.editMessageText(
      chatId, pending.progressMsgId, undefined,
      `📊 *${pending.analysis.sport || "Sports"}* — ${pending.analysis.teams?.join(" vs ") || ""}\n` +
      `📝 *${chosenHeadline}*\n\n🔍 Searching for background images...`,
      { parse_mode: "Markdown" }
    ).catch(() => {});

    const options = pending.analysis.imageOptions || [];
    if (options.length === 0) {
      await ctx.telegram.editMessageText(
        chatId, pending.progressMsgId, undefined,
        "🎨 Generating cover..."
      ).catch(() => {});
      await finalizeBetSlipCover(ctx, ctx.from.id, null, pending.analysis.imageSearchQuery || chosenHeadline);
      return;
    }

    // Search for image previews
    const imageResults = await brain.searchBetSlipImages(options);
    if (!imageResults.length) {
      await ctx.telegram.editMessageText(
        chatId, pending.progressMsgId, undefined,
        "⚠️ No images found — generating with auto-search..."
      ).catch(() => {});
      await finalizeBetSlipCover(ctx, ctx.from.id, null, options[0]?.query || chosenHeadline);
      return;
    }

    pending.imageResults = imageResults;

    // Send image previews
    const previewMsgIds = [];
    for (let i = 0; i < imageResults.length; i++) {
      const img = imageResults[i];
      const thumbBuf = Buffer.from(img.base64, "base64");
      const previewMsg = await ctx.replyWithPhoto(
        { source: thumbBuf, filename: `option-${i + 1}.jpg` },
        { caption: `${i + 1}️⃣  ${img.label}` }
      );
      previewMsgIds.push(previewMsg.message_id);
    }

    // Send pick buttons
    const rows = imageResults.map((img, i) =>
      [Markup.button.callback(`${i + 1}️⃣  ${img.label}`, `bsimg:${i}`)]
    );
    const pickerMsg = await ctx.reply(
      `🖼️ *Pick a background image:*`,
      { parse_mode: "Markdown", ...Markup.inlineKeyboard(rows) }
    );

    pending.previewMsgIds = previewMsgIds;
    pending.pickerMsgId = pickerMsg.message_id;

    await ctx.telegram.deleteMessage(chatId, pending.progressMsgId).catch(() => {});
    return;
  }

  // ── Betslip image option pick ──────────────────────────────────────────
  if (data.startsWith("bsimg:")) {
    const idx = parseInt(data.slice(6), 10);
    const pending = _betslipPending.get(ctx.from.id);
    if (!pending) return;
    const imageResults = pending.imageResults || [];
    const chosen = imageResults[idx];
    if (!chosen) return;
    // Delete all preview photos and picker message
    const chatId = pending.chatId || ctx.chat.id;
    const previewMsgIds = pending.previewMsgIds || [];
    console.log(`[wizard] Cleaning up ${previewMsgIds.length} preview images in chat ${chatId}`);
    for (const msgId of previewMsgIds) {
      await ctx.telegram.deleteMessage(chatId, msgId).catch((e) => {
        console.log(`[wizard] Failed to delete preview ${msgId}: ${e.message}`);
      });
    }
    await ctx.telegram.deleteMessage(chatId, ctx.callbackQuery.message.message_id).catch(() => {});

    // Use the pre-fetched full image — no need to search again
    await finalizeBetSlipCover(ctx, ctx.from.id, chosen.fullBase64, null);
    return;
  }

  // ── Inspire headline pick ─────────────────────────────────────────────
  if (data.startsWith("insp:")) {
    const idx = parseInt(data.slice(5), 10);
    const pending = _inspirePending.get(ctx.from.id);
    if (!pending) return;
    const chosen = pending.variations[idx];
    if (!chosen) return;
    _inspirePending.delete(ctx.from.id);

    // Clean up picker
    await ctx.telegram.deleteMessage(pending.chatId || ctx.chat.id, ctx.callbackQuery.message.message_id).catch(() => {});

    // Send the chosen headline as a ready-to-use topic
    await ctx.reply(
      `✅ *Headline selected:*\n\n📝 "${chosen}"\n\n` +
      `_You can now use this with /generate or forward it to Digi for a super post._`,
      { parse_mode: "Markdown" }
    );
    return;
  }

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
        // ── Sales-contributor intercept ────────────────────────────────────
        // External contributors can run /ad in Greg DM, but their submissions
        // don't fire direct to Internal Network Ads — they queue in the
        // monetization team chat (SALES_TEAM_CHAT_ID) for review by core
        // sales. Intercept here so the rest of the post path remains
        // untouched for everyone else.
        //
        // Per-contributor page scoping: if the contributor has a non-empty
        // allowed_pages list, every page in this submission must be in
        // that list. Reject up-front so the contributor doesn't get
        // "submitted for review" only to have a sales user reject it
        // for a scope reason.
        const contributor = await contributors.getContributor(ctx.from.id);
        if (contributor) {
          const requestedHandles = (session.answers.pages || []).map((h) =>
            String(h || "").toLowerCase().replace(/^@/, "")
          );
          const { allowed, denied } = contributors.isAllowedForPages(contributor, requestedHandles);
          if (!allowed) {
            const allowedDisplay = (contributor.allowedPages || []).map((h) => "@" + h).join(", ") || "(none)";
            const deniedDisplay  = denied.map((h) => "@" + h).join(", ");
            await ctx.telegram.editMessageText(
              session.chatId, session.wizardMsgId, undefined,
              `❌ *Not authorized for some pages*\n\n` +
              `You can submit ads for: *${allowedDisplay}*\n` +
              `This submission included: *${deniedDisplay}*\n\n` +
              `Remove the unauthorized handles and resubmit, or ask sales admin to extend your scope with /setcontributorpages.`,
              { parse_mode: "Markdown" },
            );
            sessions.delete(ctx.from.id);
            return;
          }
          return submitForSalesReview(ctx, session);
        }

        await postToGroup(ctx.telegram, session);
        await forwardContentToPages(ctx.telegram, session);
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

// Listen for photos when awaiting /inspire or /betslip. CRITICAL: when
// neither flow claims the photo, fall through to the next handler via
// `next()` — otherwise the wizard's content-step media capture (later
// in this file) never sees the photo, and the contributor's /ad
// upload silently drops them ("2 file(s) received" when 5 were sent).
bot.on("photo", async (ctx, next) => {
  // /inspire waiting for a competitor screenshot
  if (_awaitingInspire.has(ctx.chat.id)) {
    _awaitingInspire.delete(ctx.chat.id);
    return await processInspirePhoto(ctx, ctx.message);
  }
  // /betslip waiting for a bet slip photo
  if (_awaitingBetSlip.has(ctx.chat.id)) {
    _awaitingBetSlip.delete(ctx.chat.id);
    return await processBetSlipPhoto(ctx, ctx.message);
  }
  // Pass through so the wizard's content media handler can capture it
  return next();
});

// Store pending betslip data while user picks an image option
const _betslipPending = new Map(); // userId → { analysis, betSlipBase64, betSlipMime, photoMsg, progressMsgId }

async function processBetSlipPhoto(ctx, photoMsg) {
  try {
    const progressMsg = await ctx.reply("🎨 Analyzing bet slip with Claude Vision...");

    // Get highest resolution photo
    const photo = photoMsg.photo[photoMsg.photo.length - 1];
    const fileLink = await ctx.telegram.getFileLink(photo.file_id);

    // Download the photo
    const res = await fetch(fileLink.href);
    if (!res.ok) throw new Error("Failed to download bet slip photo");
    const buffer = Buffer.from(await res.arrayBuffer());
    const base64 = buffer.toString("base64");
    const mime = fileLink.href.includes(".png") ? "image/png" : "image/jpeg";

    // Step 1: Analyze the bet slip (get headline, player options, etc.)
    const analysis = await brain.analyzeBetSlip(base64, mime);
    if (!analysis || !analysis.headline) {
      await ctx.telegram.editMessageText(
        ctx.chat.id, progressMsg.message_id, undefined,
        "❌ Could not analyze bet slip — try a clearer screenshot"
      );
      return;
    }

    // Step 2: Show headline options (if multiple)
    const headlines = analysis.headlines || [analysis.headline];
    if (headlines.length > 1) {
      await ctx.telegram.editMessageText(
        ctx.chat.id, progressMsg.message_id, undefined,
        `📊 *${analysis.sport || "Sports"}* — ${analysis.teams?.join(" vs ") || ""}\n\n📝 *Pick a headline:*`,
        { parse_mode: "Markdown" }
      ).catch(() => {});

      const headlineRows = headlines.map((h, i) =>
        [Markup.button.callback(`${i + 1}️⃣ ${h.slice(0, 50)}`, `bshl:${i}`)]
      );
      const hlPickerMsg = await ctx.reply(
        headlines.map((h, i) => `${i + 1}️⃣  ${h}`).join("\n"),
        { ...Markup.inlineKeyboard(headlineRows) }
      );

      // Store pending with headlines, wait for selection
      _betslipPending.set(ctx.from.id, {
        analysis,
        betSlipBase64: base64,
        betSlipMime: mime,
        photoMsg,
        imageResults: [],
        headlines,
        headlinePickerMsgId: hlPickerMsg.message_id,
        progressMsgId: progressMsg.message_id,
        chatId: ctx.chat.id,
        step: "headline",
      });
      return;
    }

    // Single headline — skip straight to image search
    // Step 3: Search for image previews via Digi
    const options = analysis.imageOptions || [];
    if (options.length === 0) {
      await ctx.telegram.editMessageText(
        ctx.chat.id, progressMsg.message_id, undefined,
        "🎨 Generating cover..."
      ).catch(() => {});
      await finalizeBetSlipCover(ctx, ctx.from.id, null, analysis.imageSearchQuery || analysis.headline);
      return;
    }

    await ctx.telegram.editMessageText(
      ctx.chat.id, progressMsg.message_id, undefined,
      `📊 *${analysis.sport || "Sports"}* — ${analysis.teams?.join(" vs ") || ""}\n` +
      `📝 *${analysis.headline}*\n\n🔍 Searching for background images...`,
      { parse_mode: "Markdown" }
    ).catch(() => {});

    // Call Digi to search for images
    const imageResults = await brain.searchBetSlipImages(options);

    if (!imageResults.length) {
      // No images found — fallback to auto-search
      await ctx.telegram.editMessageText(
        ctx.chat.id, progressMsg.message_id, undefined,
        "⚠️ No images found — generating with auto-search..."
      ).catch(() => {});
      _betslipPending.set(ctx.from.id, { analysis, betSlipBase64: base64, betSlipMime: mime, photoMsg, imageResults: [] });
      await finalizeBetSlipCover(ctx, ctx.from.id, null, options[0]?.query || analysis.headline);
      return;
    }

    // Store pending data with the fetched image results
    _betslipPending.set(ctx.from.id, {
      analysis,
      betSlipBase64: base64,
      betSlipMime: mime,
      photoMsg,
      imageResults,
    });

    // Send each image preview as a photo with a numbered label
    const previewMsgIds = [];
    for (let i = 0; i < imageResults.length; i++) {
      const img = imageResults[i];
      const thumbBuf = Buffer.from(img.base64, "base64");
      const previewMsg = await ctx.replyWithPhoto(
        { source: thumbBuf, filename: `option-${i + 1}.jpg` },
        { caption: `${i + 1}️⃣  ${img.label}` }
      );
      previewMsgIds.push(previewMsg.message_id);
    }

    // Send pick buttons
    const rows = imageResults.map((img, i) =>
      [Markup.button.callback(`${i + 1}️⃣  ${img.label}`, `bsimg:${i}`)]
    );
    const pickerMsg = await ctx.reply(
      `🖼️ *Pick a background image:*`,
      { parse_mode: "Markdown", ...Markup.inlineKeyboard(rows) }
    );

    // Store message IDs so we can clean up after selection
    const pending = _betslipPending.get(ctx.from.id);
    if (pending) {
      pending.previewMsgIds = previewMsgIds;
      pending.pickerMsgId = pickerMsg.message_id;
      pending.chatId = ctx.chat.id;
    }

    await ctx.telegram.deleteMessage(ctx.chat.id, progressMsg.message_id).catch(() => {});

  } catch (err) {
    console.error("[wizard] processBetSlipPhoto error:", err.message);
    await ctx.reply("❌ Analysis error: " + err.message);
  }
}

/**
 * Finalize: render cover with chosen image query, then flow into /bulk.
 */
async function finalizeBetSlipCover(ctx, userId, bgImageBase64, imageQuery) {
  const pending = _betslipPending.get(userId);
  if (!pending) {
    await ctx.reply("❌ No pending bet slip — run /betslip again");
    return;
  }
  _betslipPending.delete(userId);

  const progressMsg = await ctx.reply("🎨 Generating cover...");
  const { analysis, betSlipBase64, betSlipMime, photoMsg } = pending;

  try {
    // Use pre-fetched image if available, otherwise search by query
    let result;
    console.log(`[wizard] finalizeBetSlipCover: bgImageBase64=${bgImageBase64 ? `${Math.round(bgImageBase64.length/1024)}KB` : 'null'}, imageQuery="${imageQuery}"`);
    if (bgImageBase64) {
      console.log("[wizard] Rendering cover with pre-fetched image...");
      result = await brain.renderCoverWithImage(betSlipBase64, betSlipMime, analysis, bgImageBase64);
    } else {
      console.log(`[wizard] Rendering cover with search query: "${imageQuery}"`);
      result = await brain.renderCoverWithQuery(betSlipBase64, betSlipMime, analysis, imageQuery);
    }
    console.log(`[wizard] Cover result: success=${result?.success}, error=${result?.error || 'none'}`);

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

    // Send the cover as a document (file) to retain full quality for IG Ads
    const coverBuffer = Buffer.from(result.imageBase64, "base64");
    const coverMsg = await ctx.replyWithDocument(
      { source: coverBuffer, filename: "stake-cover.jpg" },
      { caption: `📊 ${analysis.sport || "Sports"} | ${analysis.headline || ""}` }
    );

    // ── Auto-flow into /bulk with stake-bet-slips template ──────────────
    const template = KNOWN_BULKS.find((t) => t.id === "stake-bet-slips");
    if (!template) {
      await ctx.reply("⚠️ No 'stake-bet-slips' bulk template found. Use /newbulk to create one first.");
      await ctx.telegram.deleteMessage(ctx.chat.id, progressMsg.message_id).catch(() => {});
      return;
    }

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

    if (a.priceMode === "per-page") {
      const total = a.pages.reduce((sum, h) => {
        const p = parseFloat(a.perPagePrices[h]?.price || "0");
        return sum + (isNaN(p) ? 0 : p);
      }, 0);
      a.price = String(total);
    }

    a.caption = analysis.caption || null;

    session.content.shared.push({ fromChatId: ctx.chat.id, msgId: coverMsg.message_id });
    session.content.shared.push({ fromChatId: photoMsg.chat.id, msgId: photoMsg.message_id });

    session._bulkTemplateId = "stake-bet-slips";
    session.step = "time";

    const { text, keyboard } = renderMsg(session);
    const wizMsg = await ctx.reply(text, { parse_mode: "Markdown", ...(keyboard || {}) });
    session.wizardMsgId = wizMsg.message_id;
    sessions.set(userId, session);

    await ctx.telegram.deleteMessage(ctx.chat.id, progressMsg.message_id).catch(() => {});
  } catch (err) {
    console.error("[wizard] finalizeBetSlipCover error:", err.message);
    await ctx.reply("❌ Cover generation error: " + err.message);
  }
}

// ── /inspire — analyze a competitor cover and generate engagement bait ────────
// Usage: reply to a competitor's cover image with /inspire

const _awaitingInspire = new Set(); // chat IDs waiting for an inspire photo

bot.command("inspire", async (ctx) => {
  try {
    const replyMsg = ctx.message.reply_to_message;
    if (replyMsg && replyMsg.photo?.length) {
      return await processInspirePhoto(ctx, replyMsg);
    }

    _awaitingInspire.add(ctx.chat.id);
    await ctx.reply("📸 Send me a screenshot of a competitor's cover and I'll generate engagement bait variations.");
    setTimeout(() => _awaitingInspire.delete(ctx.chat.id), 120000);
  } catch (err) {
    console.error("[wizard] /inspire error:", err.message);
    await ctx.reply("Inspire error: " + err.message);
  }
});

// Store pending inspire data
const _inspirePending = new Map(); // userId → { variations, originalTopic }

async function processInspirePhoto(ctx, photoMsg) {
  try {
    const progressMsg = await ctx.reply("🔍 Analyzing competitor cover...");

    const photo = photoMsg.photo[photoMsg.photo.length - 1];
    const fileLink = await ctx.telegram.getFileLink(photo.file_id);
    const res = await fetch(fileLink.href);
    if (!res.ok) throw new Error("Failed to download photo");
    const buffer = Buffer.from(await res.arrayBuffer());
    const base64 = buffer.toString("base64");
    const mime = fileLink.href.includes(".png") ? "image/png" : "image/jpeg";

    const result = await brain.analyzeCompetitorCover(base64, mime);
    if (!result || !result.variations?.length) {
      await ctx.telegram.editMessageText(
        ctx.chat.id, progressMsg.message_id, undefined,
        "❌ Could not analyze this cover — try a clearer screenshot."
      );
      return;
    }

    await ctx.telegram.deleteMessage(ctx.chat.id, progressMsg.message_id).catch(() => {});

    const text = `🎯 *Original topic:* ${result.originalTopic}\n` +
      `📐 *Style:* ${result.style}\n\n` +
      `🔥 *Engagement bait variations:*\n\n` +
      result.variations.map((v, i) => `${i + 1}️⃣  ${v}`).join("\n");

    const rows = result.variations.map((v, i) =>
      [Markup.button.callback(`${i + 1}️⃣ Use this headline`, `insp:${i}`)]
    );

    const pickerMsg = await ctx.reply(text, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard(rows),
    });

    _inspirePending.set(ctx.from.id, {
      variations: result.variations,
      originalTopic: result.originalTopic,
      pickerMsgId: pickerMsg.message_id,
      chatId: ctx.chat.id,
    });
  } catch (err) {
    console.error("[wizard] processInspirePhoto error:", err.message);
    await ctx.reply("❌ Inspire error: " + err.message);
  }
}

// ── Text messages ─────────────────────────────────────────────────────────────

bot.on("text", async (ctx) => {
  // ── Instagram URL in DM → mark posted ad as live ────────────────────
  // Highest priority: handle BEFORE the slash-command bail since IG URLs
  // can be pasted with leading text. Only fires for DMs.
  if (postedHandler.shouldHandle(ctx)) {
    await postedHandler.handlePostedDM(ctx);
    return;
  }

  if (ctx.message.text.startsWith("/")) return;

  // ── Sales reviewer reply with rejection reason ─────────────────────────
  // The Reject button sends a force_reply prompt; this consumes the
  // operator's reply (text only) as the note that's DMed back to the
  // contributor. "skip" / "no reason" = reject without note.
  const rejectReplyTo = ctx.message?.reply_to_message?.message_id;
  if (rejectReplyTo && _pendingRejectPrompts.has(rejectReplyTo)) {
    const pending = _pendingRejectPrompts.get(rejectReplyTo);
    _pendingRejectPrompts.delete(rejectReplyTo);
    const raw = ctx.message.text.trim();
    const reason = /^(skip|none|no reason|n\/a)$/i.test(raw) ? "" : raw;

    // Two reject flavors share the prompt map:
    //   kind = 'wizard'    — wizard-contributor's /ad submission
    //   kind = undefined   — Digi-bot HTTP-intake review (poster.rejectSession)
    if (pending.kind === "wizard") {
      try {
        await sessionsLib.cancelSession(pending.sessionId);
        const { data: adSession } = await sessionsLib._supabase
          .from("ad_sessions")
          .select("review_msg, user_id, payload")
          .eq("id", pending.sessionId).single();

        if (adSession?.review_msg) {
          try {
            const note = reason ? `\n\n_Note:_ ${reason}` : "";
            await bot.telegram.editMessageText(
              adSession.review_msg.chatId,
              adSession.review_msg.messageId,
              undefined,
              `❌ *Rejected* — not posted.\n_Rejected by ${ctx.from?.username ? "@" + escapeMd(ctx.from.username) : escapeMd(ctx.from?.first_name || `user ${pending.approverTelegramId}`)}_${note}`,
              { parse_mode: "Markdown" },
            );
          } catch (_) {}
        }

        if (adSession?.user_id) {
          try {
            const lines = [
              "❌ Your ad was rejected by sales.",
              `*Client:* ${adSession.payload?.campaign?.client || "—"}`,
            ];
            if (reason) lines.push("", `*Reason:* ${reason}`);
            lines.push("", "Run /ad again with adjustments and resubmit.");
            await bot.telegram.sendMessage(adSession.user_id, lines.join("\n"), { parse_mode: "Markdown" });
          } catch (e) {
            console.warn(`[wizard] reject notify contributor ${adSession.user_id}: ${e.message}`);
          }
        }

        await ctx.reply(reason ? "❌ Rejected with note." : "❌ Rejected (no note).").catch(() => {});
      } catch (e) {
        console.error("[wizard] wizard-reject consume error:", e.message);
        await ctx.reply("⚠️ Reject failed — see logs.").catch(() => {});
      }
      return;
    }

    // Default: Digi-bot HTTP-intake review path (existing behavior)
    try {
      const approverLabel = pending.approverUsername ? `@${escapeMd(pending.approverUsername)}` : null;
      const result = await poster.rejectSession(bot, pending.sessionId, pending.approverTelegramId, reason, approverLabel);
      if (!result.ok) {
        await ctx.reply(`⚠️ Reject failed: ${result.error}`).catch(() => {});
      } else {
        await ctx.reply(reason ? "❌ Rejected with note." : "❌ Rejected (no note).").catch(() => {});
      }
    } catch (e) {
      console.error("[wizard] reject reply consume error:", e.message);
      await ctx.reply("⚠️ Reject failed — see logs.").catch(() => {});
    }
    return;
  }

  // ── Reply feedback on sourced/betslip images ──────────────────────────
  const reply = ctx.message.reply_to_message;
  if (reply && (reply.photo || reply.document) && ctx.message.text.length > 3) {
    // User is replying to an image with feedback text
    const feedbackText = ctx.message.text.trim();
    const caption = reply.caption || "";
    // Try to extract context from the caption (image label, query, etc.)
    const stored = await brain.storeImageFeedback({
      userId: String(ctx.from.id),
      feedbackText,
      imageQuery: caption || null,
      pageHandle: null, // could be extracted from session context
      context: `Reply to image: "${caption.slice(0, 100)}"`,
    });
    if (stored) {
      await ctx.reply("👍 Got it — I'll remember that for future searches.", { reply_to_message_id: ctx.message.message_id });
    }
    return;
  }

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
  if (editSess && editSess.field) {  // only intercept if actively awaiting a field
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
//
// At capture time we record both the message reference (chatId + msgId) AND
// the underlying file_id + media kind. This lets downstream forwarding go
// through sendDocument (preserves quality, matches the sales-team convention
// of always shipping creatives as documents) instead of copyMessage (which
// re-sends as the original media type and is occasionally lossy for photos).

function extractFileRef(message) {
  if (!message) return null;
  if (message.photo?.length) {
    // Telegram stores multiple sizes; pick the largest.
    const largest = message.photo[message.photo.length - 1];
    return { kind: "photo", fileId: largest.file_id };
  }
  if (message.video)     return { kind: "video",     fileId: message.video.file_id };
  if (message.document)  return { kind: "document",  fileId: message.document.file_id };
  if (message.animation) return { kind: "animation", fileId: message.animation.file_id };
  if (message.audio)     return { kind: "audio",     fileId: message.audio.file_id };
  return null;
}

bot.on(["photo", "video", "document", "animation"], async (ctx) => {
  const session = sessions.get(ctx.from.id);
  // Telemetry to debug "5 of 8 received" media-group drops — logs every
  // wizard-bound media update with media_group_id, current count, and
  // why we returned early (if we did). When it recurs, grep logs for
  // [wizard-content] mg=<id> to see how many updates actually arrived.
  const mgid = ctx.message?.media_group_id || "single";
  const kind = ctx.message?.photo ? "photo"
             : ctx.message?.video ? "video"
             : ctx.message?.document ? "document"
             : ctx.message?.animation ? "animation"
             : "other";
  if (!session) {
    console.log(`[wizard-content] mg=${mgid} kind=${kind} user=${ctx.from.id} DROPPED: no session`);
    return;
  }
  if (session.step !== "content") {
    console.log(`[wizard-content] mg=${mgid} kind=${kind} user=${ctx.from.id} DROPPED: step=${session.step}`);
    return;
  }

  const fileRef = extractFileRef(ctx.message);
  const msgRef  = {
    fromChatId: ctx.chat.id,
    msgId:      ctx.message.message_id,
    fileId:     fileRef?.fileId || null,
    kind:       fileRef?.kind   || null,
  };
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

  // Count after the push, so we can detect if pushes are happening but
  // updateWizard's edit is what's stale.
  const totalNow = fmt === "Standard"
    ? content.shared.length
    : fmt === "Per-creative"
    ? Object.values(content.byHandle).reduce((s, a) => s + (a?.length || 0), 0)
    : fmt === "Collab"
    ? content.collabGroups.reduce((s, g) => s + (g?.media?.length || 0), 0)
    : 0;
  console.log(`[wizard-content] mg=${mgid} kind=${kind} user=${ctx.from.id} fmt=${fmt} captured total=${totalNow}`);

  await updateWizard(ctx.telegram, session);
});

// Send a captured media reference as a document. Three-tier strategy:
//
//   1. If the user uploaded as a document/animation → file_id works
//      directly with sendDocument (true zero-loss passthrough).
//   2. If the user uploaded as a photo or video (Telegram compresses
//      these client-side, then assigns a typed file_id) → sendDocument
//      with that file_id is rejected. Download the file via the Bot API
//      and re-upload as a Buffer with sendDocument. We only get the
//      compressed bytes (originals were lost at upload time), but the
//      output arrives as a document attachment which is the sales-team
//      convention for the audit trail.
//   3. Final fallback: copyMessage. Used when (a) we have no file_id
//      (legacy session refs from before the file_id capture upgrade),
//      or (b) download+re-upload itself fails.
//
// Operators get the highest fidelity by uploading via "Send as File"
// (the prompt at the content step now mentions this).
async function sendCapturedAsDocument(telegram, chatId, ref) {
  if (!ref) return;

  // Path 1: already a document → file_id passthrough
  if (ref.fileId && (ref.kind === "document" || ref.kind === "animation")) {
    try {
      await telegram.sendDocument(chatId, ref.fileId);
      return;
    } catch (e) {
      console.warn(`[wizard] sendDocument(${ref.kind}) passthrough failed: ${e.message}`);
    }
  }

  // Path 2: photo/video/audio captured by Telegram → download + re-upload
  if (ref.fileId && (ref.kind === "photo" || ref.kind === "video" || ref.kind === "audio")) {
    try {
      const fileLink = await telegram.getFileLink(ref.fileId);
      const res = await fetch(fileLink.toString());
      if (!res.ok) throw new Error(`fetch ${res.status} ${res.statusText}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      const ext = ref.kind === "photo" ? "jpg"
                : ref.kind === "video" ? "mp4"
                : ref.kind === "audio" ? "mp3"
                : "bin";
      const filename = `${ref.kind}-${String(ref.fileId).slice(-8)}.${ext}`;
      await telegram.sendDocument(chatId, { source: buffer, filename });
      return;
    } catch (e) {
      console.warn(`[wizard] download+reupload(${ref.kind}) failed: ${e.message} — falling back to copyMessage`);
    }
  }

  // Path 3: copyMessage fallback (preserves original media type, last resort)
  if (ref.fromChatId && ref.msgId) {
    try { await telegram.copyMessage(chatId, ref.fromChatId, ref.msgId); }
    catch (e) { console.error(`[wizard] copyMessage fallback failed: ${e.message}`); }
  }
}

// ── Sales intelligence startup ────────────────────────────────────────────────
// Connects to @sales_bolismedia and listens to all chats automatically.

brain.startAutoCapture();

// ── Recap cron jobs ───────────────────────────────────────────────────────────
// Greg's morning + nightly recaps fire to GREG_SALES_CHAT via cron. Default
// is OFF (Connor turned them off May 2026 — too noisy in the combined sales
// chat). Re-enable by setting GREG_AUTOMATED_RECAPS_ENABLED=true on Railway.
// Manual /recap and /nightrecap commands always work regardless of this
// toggle for on-demand pulls.
const RECAPS_ENABLED = (process.env.GREG_AUTOMATED_RECAPS_ENABLED || "false").toLowerCase() === "true";
if (!RECAPS_ENABLED) {
  console.log("[wizard] ⏸  Auto recaps OFF (set GREG_AUTOMATED_RECAPS_ENABLED=true to enable)");
} else {
  console.log("[wizard] 🌅 Auto recaps ON — morning at 8am AZ, nightly at 9pm AZ");
}

// ── Morning recap — 8:00 AM Arizona time (MST, no DST) ───────────────────────

cron.schedule("0 8 * * *", () => {
  if (!RECAPS_ENABLED) return;
  brain.sendMorningRecap()
    .catch((e) => console.error("[wizard] morning recap error:", e.message));
}, { timezone: "America/Phoenix" });

// ── Nightly lesson extraction — 11:00 PM Arizona time ────────────────────────
// (Lessons are stored in Supabase, no chat send — leaves this enabled even
// when recaps are off so the knowledge base keeps growing.)

cron.schedule("0 23 * * *", () => {
  brain.extractNightlyLessons()
    .catch((e) => console.error("[wizard] nightly lessons error:", e.message));
}, { timezone: "America/Phoenix" });

// ── Nightly revenue recap — 9:00 PM Arizona time ─────────────────────────

cron.schedule("0 21 * * *", () => {
  if (!RECAPS_ENABLED) return;
  brain.sendNightlyRecap()
    .catch((e) => console.error("[wizard] nightly recap error:", e.message));
}, { timezone: "America/Phoenix" });

// ── Launch ────────────────────────────────────────────────────────────────────

bot.launch().then(async () => {
  console.log("✅ Greg (Ad Brief Wizard) running");
  // Cache the bot's @username so error messages can reference it concretely
  try {
    const me = await bot.telegram.getMe();
    if (me?.username) BOT_USERNAME_HINT = me.username;
  } catch (_) {}
});

// HTTP API for external ad submission (Digi → Greg, etc.)
const apiHttpServer = apiServer.startServer({
  bot,
  handleIntake: poster.handleIntake,
});

process.once("SIGINT",  () => { try { apiHttpServer?.close(); } catch (_) {} bot.stop("SIGINT"); });
process.once("SIGTERM", () => { try { apiHttpServer?.close(); } catch (_) {} bot.stop("SIGTERM"); });
