/**
 * lib/poster.js
 *
 * Sends ads from /api/ad/intake into Internal Network Ads + each page's
 * IG Ads channel. Greg replicates the exact message sequences humans use
 * (Ivan, Danielson, Davo) so Internal Network Ads looks identical regardless
 * of sender, but ALSO delivers a per-page package to each page's IG Ads
 * channel directly so VAs see the creative + brief + per-page custom info
 * in one place — without depending on bm_tracking_bot's parser.
 *
 * Five formats supported:
 *   1. collab    — videos with nested host/invite groups (Stake Bounty)
 *   2. per-page  — labeled creatives, optional per-page UTM (FashionNova)
 *   3. standard  — one shared creative for N pages (Capa)
 *   4. hybrid    — per-page covers + shared content slides (Bet Slip)
 *   5. single    — same as standard with 1 page (DCW Media). Same code path.
 *
 * Hidden marker on the brief:
 *   <!-- greg-handled --><!-- greg-session: {id} -->
 *
 * Tells bm_tracking_bot to skip its brief-forwarding step (Greg already
 * delivered to per-page channels) but still log to sheets normally. The
 * session id lets Greg's own systems (lifecycle reminders, view-count
 * cron, posted-ad detection) look up the structured ad data later.
 */

const sessions     = require("./sessions");
const destinations = require("../config/telegram-destinations.json");

const TARGET_CHAT          = process.env.WIZARD_TARGET_CHAT_ID;
const ADMIN_USER_ID        = parseInt(process.env.WIZARD_ADMIN_USER_ID || "0", 10);
const PLACEHOLDER_PATTERN  = /^(SHEET_ID_|TELEGRAM_CHAT_ID_)/;
const CANCEL_WINDOW_MS     = parseInt(process.env.GREG_CANCEL_WINDOW_MS || "30000", 10);

const GREG_TAG = "<!-- greg-handled -->";

const _scheduledSends = new Map(); // sessionId → setTimeout handle

// ── Helpers ──────────────────────────────────────────────────────────────

function normalize(handle) {
  return String(handle || "").replace(/^@/, "").trim().toLowerCase();
}

function destFor(handle) {
  const dest = destinations[normalize(handle)];
  if (!dest || PLACEHOLDER_PATTERN.test(String(dest))) return null;
  return String(dest);
}

function isVideoUrl(url) { return /\.(mp4|mov|webm)(\?|$)/i.test(url); }

/**
 * Send a media URL into a Telegram chat. Accepts either a string URL
 * (legacy) or a Slide object `{ type, url, label? }` (new shape from
 * normalized intake payloads). The explicit `type` field — when present —
 * overrides URL-extension inference, which matters for storage URLs that
 * lack file extensions (Supabase signed URLs, etc.).
 */
async function sendMedia(telegram, chatId, slideOrUrl, opts = {}) {
  if (!slideOrUrl) return;
  const slide = typeof slideOrUrl === "string" ? { url: slideOrUrl } : slideOrUrl;
  const url = slide.url;
  if (!url) return;
  const type = slide.type || (isVideoUrl(url) ? "video" : "image");

  try {
    if (type === "video") {
      // Send videos as documents to retain quality (no Telegram re-encoding)
      await telegram.sendDocument(chatId, url, opts);
    } else {
      await telegram.sendPhoto(chatId, url, opts);
    }
  } catch (e) {
    // Fallback: try sendDocument for anything that fails
    try { await telegram.sendDocument(chatId, url, opts); }
    catch (e2) { console.error(`[poster] sendMedia ${chatId} ${url}: ${e.message} / ${e2.message}`); }
  }
}

/**
 * Read the canonical shared-slide list off a (normalized) payload.
 * After api.js normalization sharedSlides is always Slide[]; we still
 * fall back to legacy `sharedCreativeUrl` / string entries so this
 * function is safe to call against older sessions stored in Supabase.
 */
function getSharedSlides(payload) {
  const list = Array.isArray(payload.sharedSlides) ? payload.sharedSlides : [];
  const normalized = list.map((s) => {
    if (typeof s === "string") return { type: isVideoUrl(s) ? "video" : "image", url: s };
    if (s && s.url) {
      return { type: s.type || (isVideoUrl(s.url) ? "video" : "image"), url: s.url, label: s.label };
    }
    return null;
  }).filter(Boolean);
  if (normalized.length === 0 && payload.sharedCreativeUrl) {
    return [{ type: isVideoUrl(payload.sharedCreativeUrl) ? "video" : "image", url: payload.sharedCreativeUrl }];
  }
  return normalized;
}

function parseDurationMs(duration) {
  if (!duration || /perm/i.test(duration)) return null;
  const m = String(duration).match(/^(\d+)\s*(min|m|hr|hour|h|day|d|week|w)/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  if (unit.startsWith("min") || unit === "m") return n * 60_000;
  if (unit.startsWith("h"))                    return n * 3_600_000;
  if (unit.startsWith("d"))                    return n * 86_400_000;
  if (unit.startsWith("w"))                    return n * 604_800_000;
  return null;
}

// ── Brief building (format-aware) ────────────────────────────────────────

function buildSeniorTags(seniors) {
  const list = seniors && seniors.length > 0
    ? seniors
    : ((process.env.WIZARD_ADMIN_HANDLES || "").split(",").map((s) => s.trim()).filter(Boolean));
  return list.map((h) => `@${normalize(h)}`).join("\n");
}

function buildInstructions(adInfo, perPageBlock = "") {
  const lines = ["INSTRUCTIONS:", `- ${adInfo.postType}`];
  if (/perm/i.test(adInfo.duration)) lines.push("- Permanent post - DO NOT DELETE");
  else lines.push(`- ${adInfo.duration} post`);
  if (adInfo.nif && !/none/i.test(adInfo.nif)) lines.push(`- ${adInfo.nif}`);
  if (Array.isArray(adInfo.extras)) lines.push(...adInfo.extras.map((x) => `- ${x}`));
  return perPageBlock
    ? lines.join("\n") + "\n\n" + perPageBlock
    : lines.join("\n");
}

function withGregMarker(text, sessionId) {
  return `${text}\n\n${GREG_TAG}<!-- greg-session: ${sessionId} -->`;
}

function timeStr(time) {
  return /AZ|MST/i.test(time) ? time : `${time} AZ`;
}

/**
 * Resolve all targeted page handles for a payload, regardless of format.
 * Returns deduped list of { handle, price, bulkNum? }
 */
function resolveAllPages(payload) {
  const out = new Map();
  const basePrice = payload.campaign.basePrice;

  if (payload.format === "collab") {
    for (const v of (payload.videos || [])) {
      for (const g of (v.groups || [])) {
        const all = [g.host, ...(g.invites || [])].filter(Boolean);
        for (const h of all) {
          const handle = normalize(h);
          if (handle && !out.has(handle)) out.set(handle, { handle, price: basePrice });
        }
      }
    }
  }

  if (Array.isArray(payload.pages)) {
    for (const p of payload.pages) {
      const handle = normalize(p.handle);
      if (!handle) continue;
      out.set(handle, {
        handle,
        price:   p.price ?? basePrice,
        bulkNum: p.bulkNum,
        utmUrl:  p.utmUrl || p.customUrl,
      });
    }
  }

  return [...out.values()];
}

// ── Brief builders per format ────────────────────────────────────────────

function buildBriefStandard(payload, sessionId) {
  const { campaign, adInfo } = payload;
  const allPages = resolveAllPages(payload);
  const allSamePrice = allPages.every((p) => p.price === campaign.basePrice);
  const pageLines = allPages.map((p) => {
    const prefix = p.bulkNum ? `(${p.bulkNum}) ` : "";
    return allSamePrice
      ? `${prefix}@${p.handle}`
      : `${prefix}@${p.handle} - $${p.price}`;
  }).join("\n");

  return withGregMarker([
    `${campaign.client} - ${campaign.adType} - $${campaign.basePrice}`,
    "",
    buildSeniorTags(adInfo.seniors),
    "",
    buildInstructions(adInfo),
    "",
    `PAGE INFO:`,
    "",
    timeStr(adInfo.time),
    "",
    pageLines,
  ].join("\n"), sessionId);
}

function buildBriefPerPage(payload, sessionId) {
  const { campaign, adInfo } = payload;
  const allPages = resolveAllPages(payload);

  // If per-page custom URLs (UTMs) are present, surface them in INSTRUCTIONS
  let perPageBlock = "";
  const pagesWithUtm = allPages.filter((p) => p.utmUrl);
  if (pagesWithUtm.length > 0) {
    perPageBlock = pagesWithUtm.map((p) => `@${p.handle} - ${p.utmUrl}`).join("\n\n");
  }

  const allSamePrice = allPages.every((p) => p.price === campaign.basePrice);
  const pageLines = allPages.map((p) => {
    const prefix = p.bulkNum ? `(${p.bulkNum}) ` : "";
    return allSamePrice
      ? `${prefix}@${p.handle}`
      : `${prefix}@${p.handle} - $${p.price}`;
  }).join("\n");

  return withGregMarker([
    `${campaign.client} - ${campaign.adType} - $${campaign.basePrice}`,
    "",
    buildSeniorTags(adInfo.seniors),
    "",
    buildInstructions(adInfo, perPageBlock),
    "",
    `PAGE INFO:`,
    "",
    timeStr(adInfo.time),
    "",
    pageLines,
  ].join("\n"), sessionId);
}

function buildBriefCollab(payload, sessionId) {
  const { campaign, adInfo } = payload;
  const allPages = resolveAllPages(payload);
  const pageLines = allPages.map((p) => `@${p.handle}`).join("\n");

  return withGregMarker([
    `${campaign.client} - ${campaign.adType} - $${campaign.basePrice}`,
    "",
    buildSeniorTags(adInfo.seniors),
    "",
    buildInstructions(adInfo),
    "",
    `PAGE INFO:`,
    "",
    timeStr(adInfo.time),
    "",
    "AVAILABLE SPACING",
    "",
    pageLines,
  ].join("\n"), sessionId);
}

const buildBriefHybrid = buildBriefPerPage; // same brief shape

function buildBriefForFormat(payload, sessionId) {
  switch (payload.format) {
    case "collab":   return buildBriefCollab(payload, sessionId);
    case "per-page": return buildBriefPerPage(payload, sessionId);
    case "hybrid":   return buildBriefHybrid(payload, sessionId);
    case "standard":
    default:         return buildBriefStandard(payload, sessionId);
  }
}

// ── Format-specific senders to Internal Network Ads ─────────────────────

async function sendCollabToInternal(telegram, payload, sessionId) {
  for (const video of (payload.videos || [])) {
    if (video.mediaUrl) {
      await sendMedia(telegram, TARGET_CHAT, { type: video.mediaType, url: video.mediaUrl });
    }
    for (const group of (video.groups || [])) {
      const host = normalize(group.host);
      const invites = (group.invites || []).map((h) => `@${normalize(h)}`).join("\n");
      await telegram.sendMessage(TARGET_CHAT, `Host: @${host}, invite:\n\n${invites}`);
    }
  }
  if (payload.adInfo.caption) await telegram.sendMessage(TARGET_CHAT, payload.adInfo.caption);
  return telegram.sendMessage(TARGET_CHAT, buildBriefCollab(payload, sessionId));
}

async function sendPerPageToInternal(telegram, payload, sessionId) {
  for (const page of (payload.pages || [])) {
    // /bulk batches submit coverUrl; legacy SOPs use creativeUrl. Accept both.
    const url = page.creativeUrl || page.coverUrl;
    if (url) {
      await sendMedia(telegram, TARGET_CHAT, url);
      await telegram.sendMessage(TARGET_CHAT, `@${normalize(page.handle)} ^`);
    }
  }
  // Optional shared media (e.g. story media). Accept typed slides or {url,label}
  if (Array.isArray(payload.sharedMedia)) {
    for (const m of payload.sharedMedia) {
      await sendMedia(telegram, TARGET_CHAT, m);
      if (m.label) await telegram.sendMessage(TARGET_CHAT, `${m.label} ^`);
    }
  }
  if (payload.adInfo.caption) await telegram.sendMessage(TARGET_CHAT, payload.adInfo.caption);
  return telegram.sendMessage(TARGET_CHAT, buildBriefPerPage(payload, sessionId));
}

async function sendStandardToInternal(telegram, payload, sessionId) {
  // sharedSlides is the slide list (typed) that goes to every page
  const slides = getSharedSlides(payload);
  for (const slide of slides) await sendMedia(telegram, TARGET_CHAT, slide);
  if (payload.adInfo.caption) await telegram.sendMessage(TARGET_CHAT, payload.adInfo.caption);
  return telegram.sendMessage(TARGET_CHAT, buildBriefStandard(payload, sessionId));
}

async function sendHybridToInternal(telegram, payload, sessionId) {
  // Per-page covers first
  for (const page of (payload.pages || [])) {
    if (page.coverUrl) await sendMedia(telegram, TARGET_CHAT, page.coverUrl);
  }
  if ((payload.pages || []).some((p) => p.coverUrl)) {
    await telegram.sendMessage(TARGET_CHAT, `Cover slides ^`);
  }
  // Then shared content slides (typed)
  const sharedSlides = getSharedSlides(payload);
  for (const slide of sharedSlides) await sendMedia(telegram, TARGET_CHAT, slide);
  if (sharedSlides.length > 0) {
    await telegram.sendMessage(TARGET_CHAT, `${sharedSlides.length === 1 ? "Content slide" : `2-${sharedSlides.length + 1} slide for all`} ^`);
  }
  if (payload.adInfo.caption) await telegram.sendMessage(TARGET_CHAT, payload.adInfo.caption);
  return telegram.sendMessage(TARGET_CHAT, buildBriefHybrid(payload, sessionId));
}

// ── Per-page channel delivery (each page IG Ads chat) ───────────────────

/**
 * Send a tailored package to one page's IG Ads channel based on the format.
 * Each format determines what creative + ancillary messages that page sees.
 */
async function sendToPageChannel(telegram, payload, page, sessionId, briefText) {
  const handle = normalize(page.handle);
  const dest = destFor(handle);
  if (!dest) {
    console.warn(`[poster] no destination for @${handle} — skipping per-page`);
    return false;
  }

  switch (payload.format) {
    case "collab": {
      // Find which video + group this page belongs to
      const found = findCollabContext(payload, handle);
      if (found) {
        if (found.video.mediaUrl) {
          await sendMedia(telegram, dest, { type: found.video.mediaType, url: found.video.mediaUrl });
        }
        const inviteList = (found.group.invites || []).map((h) => `@${normalize(h)}`).join("\n");
        await telegram.sendMessage(dest, `Host: @${normalize(found.group.host)}, invite:\n\n${inviteList}`);
      }
      break;
    }

    case "per-page": {
      const pagePayload = (payload.pages || []).find((p) => normalize(p.handle) === handle);
      // Accept either creativeUrl (legacy SOP) or coverUrl (new from /bulk batches)
      const url = pagePayload?.creativeUrl || pagePayload?.coverUrl;
      if (url) await sendMedia(telegram, dest, url);
      if (Array.isArray(payload.sharedMedia)) {
        for (const m of payload.sharedMedia) await sendMedia(telegram, dest, m);
      }
      break;
    }

    case "standard": {
      const slides = getSharedSlides(payload);
      for (const slide of slides) await sendMedia(telegram, dest, slide);
      break;
    }

    case "hybrid": {
      const pagePayload = (payload.pages || []).find((p) => normalize(p.handle) === handle);
      if (pagePayload?.coverUrl) await sendMedia(telegram, dest, pagePayload.coverUrl);
      for (const slide of getSharedSlides(payload)) await sendMedia(telegram, dest, slide);
      break;
    }
  }

  if (payload.adInfo.caption) {
    try { await telegram.sendMessage(dest, payload.adInfo.caption); }
    catch (e) { console.error(`[poster] caption → ${dest}: ${e.message}`); }
  }
  // Forward the brief into the page channel so VAs have full context
  try { await telegram.sendMessage(dest, briefText); }
  catch (e) { console.error(`[poster] brief → ${dest}: ${e.message}`); }

  return true;
}

function findCollabContext(payload, pageHandle) {
  for (const v of (payload.videos || [])) {
    for (const g of (v.groups || [])) {
      const allHandles = [g.host, ...(g.invites || [])].map(normalize);
      if (allHandles.includes(pageHandle)) return { video: v, group: g };
    }
  }
  return null;
}

// ── Notification + scheduling ───────────────────────────────────────────

async function sendIntakeNotification(bot, session, payload) {
  if (!ADMIN_USER_ID) {
    console.warn("[poster] WIZARD_ADMIN_USER_ID not set — can't send notification");
    return null;
  }
  const allPages = resolveAllPages(payload);
  const lines = [
    `🚀 *Ad incoming — sending in ${Math.round(CANCEL_WINDOW_MS / 1000)}s*`,
    "",
    `*Client:* ${payload.campaign.client}`,
    `*Type:* ${payload.campaign.adType} — $${payload.campaign.basePrice}/page`,
    `*Format:* ${payload.format || "standard"}`,
    `*Time:* ${payload.adInfo.time}`,
    `*Post:* ${payload.adInfo.postType}, ${payload.adInfo.duration}${payload.adInfo.nif ? ", " + payload.adInfo.nif : ""}`,
    `*Source:* ${session.source}`,
    "",
    `*Pages (${allPages.length}):*`,
    ...allPages.slice(0, 10).map((p, i) => `${i + 1}. @${p.handle}`),
    ...(allPages.length > 10 ? [`...and ${allPages.length - 10} more`] : []),
  ];

  const msg = await bot.telegram.sendMessage(
    ADMIN_USER_ID,
    lines.join("\n"),
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[{ text: "❌ Cancel", callback_data: `intake:cancel:${session.id}` }]],
      },
    }
  ).catch((e) => { console.error("[poster] sendIntakeNotification error:", e.message); return null; });

  if (msg) {
    await sessions.updateSession(session.id, {
      approval_msg: { chatId: msg.chat.id, messageId: msg.message_id },
      cancel_until: new Date(Date.now() + CANCEL_WINDOW_MS).toISOString(),
    });
  }
  return msg;
}

// ── Main execution ──────────────────────────────────────────────────────

async function executeIntake(bot, sessionId) {
  const { data: session } = await sessions._supabase
    .from("ad_sessions")
    .select("*")
    .eq("id", sessionId)
    .single();

  if (!session) {
    console.warn(`[poster] executeIntake: session ${sessionId} not found`);
    return;
  }
  if (session.status !== "pending") {
    console.log(`[poster] executeIntake: session ${sessionId} is ${session.status}, skipping`);
    return;
  }

  if (!TARGET_CHAT) {
    console.error("[poster] WIZARD_TARGET_CHAT_ID not set");
    await sessions.expireSession(sessionId);
    return;
  }

  const payload  = session.payload;
  const format   = payload.format || "standard";
  const allPages = resolveAllPages(payload);

  // 1. Send full ad sequence to Internal Network Ads (visible to sales/admins)
  let briefMsg;
  try {
    switch (format) {
      case "collab":   briefMsg = await sendCollabToInternal(bot.telegram,   payload, sessionId); break;
      case "per-page": briefMsg = await sendPerPageToInternal(bot.telegram, payload, sessionId); break;
      case "hybrid":   briefMsg = await sendHybridToInternal(bot.telegram,  payload, sessionId); break;
      case "standard":
      default:         briefMsg = await sendStandardToInternal(bot.telegram, payload, sessionId); break;
    }
  } catch (e) {
    console.error("[poster] sendToInternal error:", e.message);
    await sessions.expireSession(sessionId);
    return;
  }

  const briefText = briefMsg.text || buildBriefForFormat(payload, sessionId);

  // 2. Deliver per-page packages to each page's IG Ads channel
  // Dedup by destination chat id (some pages share channels)
  const seenDests = new Set();
  let pagesDelivered = 0;
  for (const page of allPages) {
    const dest = destFor(page.handle);
    if (!dest) continue;
    if (seenDests.has(dest)) continue;
    seenDests.add(dest);
    const ok = await sendToPageChannel(bot.telegram, payload, page, sessionId, briefText);
    if (ok) pagesDelivered++;
  }

  // 3. Record posted_ads rows for lifecycle tracking
  const durationMs = parseDurationMs(payload.adInfo.duration);
  for (const page of allPages) {
    await sessions.recordPostedAd({
      pageHandle:   page.handle,
      clientName:   payload.campaign.client,
      sessionId:    sessionId,
      submittedBy:  session.user_id,
      durationMs,
    });
  }

  // 4. Mark session as sent
  await sessions.markSent(sessionId);

  // 5. Update notification card
  if (session.approval_msg) {
    try {
      await bot.telegram.editMessageText(
        session.approval_msg.chatId,
        session.approval_msg.messageId,
        undefined,
        `✅ *Sent.* ${allPages.length} page(s) live in Internal Network Ads + per-page channels (format: ${format}).`,
        { parse_mode: "Markdown" }
      );
    } catch (e) { console.error("[poster] edit notification:", e.message); }
  }

  console.log(`[poster] ✅ Sent ad ${sessionId} — format=${format}, pages=${allPages.length}, perPageDelivered=${pagesDelivered}`);
}

// ── Cancel window scheduling ────────────────────────────────────────────

function scheduleExecution(bot, sessionId, delayMs = CANCEL_WINDOW_MS) {
  const existing = _scheduledSends.get(sessionId);
  if (existing) clearTimeout(existing);
  const handle = setTimeout(() => {
    _scheduledSends.delete(sessionId);
    executeIntake(bot, sessionId).catch((e) =>
      console.error(`[poster] scheduled execution error for ${sessionId}:`, e.message),
    );
  }, delayMs);
  _scheduledSends.set(sessionId, handle);
}

async function cancelIntake(bot, sessionId) {
  const handle = _scheduledSends.get(sessionId);
  if (handle) {
    clearTimeout(handle);
    _scheduledSends.delete(sessionId);
  }
  await sessions.cancelSession(sessionId);

  const { data: session } = await sessions._supabase
    .from("ad_sessions").select("approval_msg, payload").eq("id", sessionId).single();

  if (session?.approval_msg) {
    try {
      await bot.telegram.editMessageText(
        session.approval_msg.chatId,
        session.approval_msg.messageId,
        undefined,
        `❌ *Cancelled.* Ad was not sent.`,
        { parse_mode: "Markdown" }
      );
    } catch (e) { console.error("[poster] edit cancellation:", e.message); }
  }
}

async function handleIntake({ session, payload, bot }) {
  await sendIntakeNotification(bot, session, payload);
  scheduleExecution(bot, session.id);
}

module.exports = {
  handleIntake,
  cancelIntake,
  executeIntake,
  scheduleExecution,
  buildBriefForFormat,
  resolveAllPages,
  GREG_TAG,
  CANCEL_WINDOW_MS,
};
