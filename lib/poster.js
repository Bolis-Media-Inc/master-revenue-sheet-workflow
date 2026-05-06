/**
 * lib/poster.js
 * Handles posting ads to Internal Network Ads from URL-based payloads
 * (i.e. ads submitted via /api/ad/intake instead of the in-Telegram wizard).
 *
 * Different from wizard.js's postToGroup() / forwardContentToPages() because
 * those work with Telegram message refs (fromChatId + msgId for copyMessage).
 * Here we work with HTTP URLs to creatives stored in Supabase Storage / S3 /
 * any public URL.
 */

const sessions     = require("./sessions");
const destinations = require("../config/telegram-destinations.json");

const TARGET_CHAT          = process.env.WIZARD_TARGET_CHAT_ID;
const ADMIN_USER_ID        = parseInt(process.env.WIZARD_ADMIN_USER_ID || "0", 10);
const PLACEHOLDER_PATTERN  = /^(SHEET_ID_|TELEGRAM_CHAT_ID_)/;
const CANCEL_WINDOW_MS     = parseInt(process.env.GREG_CANCEL_WINDOW_MS || "30000", 10);

// Hidden marker prepended to briefs that originate from Greg's /api/ad/intake.
// bm_tracking_bot reads this to skip its forwarding step (Greg already
// forwarded per-page creatives directly).
const GREG_TAG = "<!-- greg-handled -->";

// Track active scheduled sends so we can cancel them
const _scheduledSends = new Map(); // sessionId → setTimeout handle

/**
 * Format an Internal Network Ads brief from an API payload.
 * Mirrors the wizard's buildBrief() output but takes the HTTP API shape.
 */
function buildBriefFromPayload(payload) {
  const { campaign, adInfo, pages } = payload;
  const seniors = adInfo.seniors && adInfo.seniors.length > 0
    ? adInfo.seniors
    : ((process.env.WIZARD_ADMIN_HANDLES || "").split(",").map((s) => s.trim()).filter(Boolean));
  const topTags = seniors.map((h) => `@${h.replace(/^@/, "")}`).join("\n");

  const instr = ["INSTRUCTIONS:", `- ${adInfo.postType}`];
  if (adInfo.duration === "Permanent") instr.push("- Permanent post - DO NOT DELETE");
  else instr.push(`- ${adInfo.duration} post`);
  if (adInfo.nif && adInfo.nif !== "none") instr.push(`- ${adInfo.nif}`);

  const time = /AZ|MST/i.test(adInfo.time) ? adInfo.time : `${adInfo.time} AZ`;

  // Each page line: "@handle - $price"  (or just @handle if same price as basePrice)
  const allSamePrice = pages.every((p) => (p.price ?? campaign.basePrice) === campaign.basePrice);
  const pageLines = pages.map((p) => {
    const price = p.price ?? campaign.basePrice;
    return allSamePrice ? `@${p.handle.replace(/^@/, "")}` : `@${p.handle.replace(/^@/, "")} - $${price}`;
  }).join("\n");

  const header = `${campaign.client} - ${campaign.adType} - $${campaign.basePrice}`;

  return [
    GREG_TAG,
    header, "",
    topTags, "",
    instr.join("\n"), "",
    `PAGE INFO:\n\n${time}\n\n${pageLines}`,
  ].join("\n");
}

/**
 * Send a creative URL to a chat. Uses sendPhoto for images, sendVideo for videos.
 * Telegram supports HTTP URLs directly for both.
 */
async function sendCreativeToChat(telegram, chatId, creative, caption = null) {
  const opts = caption ? { caption } : {};
  try {
    if (creative.media_type === "video") {
      await telegram.sendVideo(chatId, creative.media_url, opts);
    } else {
      await telegram.sendPhoto(chatId, creative.media_url, opts);
    }
  } catch (e) {
    console.error(`[poster] sendCreative → ${chatId}: ${e.message}`);
  }
}

/**
 * Parse the duration field into milliseconds (for posted_ads.duration_ms).
 */
function parseDurationMs(duration) {
  if (!duration || /perm/i.test(duration)) return null; // perm = no expiry
  const m = String(duration).match(/^(\d+)\s*(min|m|hr|hour|h|day|d|week|w)/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  if (unit.startsWith("min") || unit === "m") return n * 60_000;
  if (unit.startsWith("h"))                   return n * 3_600_000;
  if (unit.startsWith("d"))                   return n * 86_400_000;
  if (unit.startsWith("w"))                   return n * 604_800_000;
  return null;
}

/**
 * Send the notification card to the admin (Connor) about an incoming ad.
 * Includes a [Cancel] button that's live for the cancel window.
 */
async function sendIntakeNotification(bot, session, payload) {
  if (!ADMIN_USER_ID) {
    console.warn("[poster] WIZARD_ADMIN_USER_ID not set — can't send notification");
    return null;
  }

  const { campaign, adInfo, pages } = payload;
  const lines = [
    `🚀 *Ad incoming — sending in ${Math.round(CANCEL_WINDOW_MS / 1000)}s*`,
    "",
    `*Client:* ${campaign.client}`,
    `*Type:* ${campaign.adType} — $${campaign.basePrice}/page`,
    `*Time:* ${adInfo.time}`,
    `*Post:* ${adInfo.postType}, ${adInfo.duration}${adInfo.nif ? ", " + adInfo.nif : ""}`,
    `*Source:* ${session.source}`,
    "",
    `*Pages (${pages.length}):*`,
    ...pages.map((p, i) => `${i + 1}. @${p.handle.replace(/^@/, "")}${p.creativeUrl ? " 🖼️" : ""}`),
  ];

  const msg = await bot.telegram.sendMessage(
    ADMIN_USER_ID,
    lines.join("\n"),
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[
          { text: "❌ Cancel", callback_data: `intake:cancel:${session.id}` },
        ]],
      },
    }
  ).catch((e) => {
    console.error("[poster] sendIntakeNotification error:", e.message);
    return null;
  });

  if (msg) {
    await sessions.updateSession(session.id, {
      approval_msg: { chatId: msg.chat.id, messageId: msg.message_id },
      cancel_until: new Date(Date.now() + CANCEL_WINDOW_MS).toISOString(),
    });
  }

  return msg;
}

/**
 * Execute the actual posting: brief to TARGET_CHAT, creatives to page channels.
 * Called after the cancel window expires.
 */
async function executeIntake(bot, sessionId) {
  // Reload session to get current state
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

  const payload = session.payload;

  // Build the brief (with Greg-tag marker)
  const brief = buildBriefFromPayload(payload);

  if (!TARGET_CHAT) {
    console.error("[poster] WIZARD_TARGET_CHAT_ID not set — can't post brief");
    await sessions.expireSession(sessionId);
    return;
  }

  // 1. Post brief to Internal Network Ads
  let briefMsg;
  try {
    briefMsg = await bot.telegram.sendMessage(TARGET_CHAT, brief);
  } catch (e) {
    console.error("[poster] post brief error:", e.message);
    await sessions.expireSession(sessionId);
    return;
  }

  // 2. Forward creatives + caption to each page channel
  const creatives = await sessions.getCreatives(sessionId);
  const creativesByHandle = new Map(creatives.map((c) => [c.page_handle, c]));
  const seenDests = new Set();

  for (const page of payload.pages) {
    const handle = page.handle.replace(/^@/, "").toLowerCase();
    const dest   = destinations[handle];
    if (!dest || PLACEHOLDER_PATTERN.test(String(dest))) {
      console.warn(`[poster] no destination for @${handle} — skipping`);
      continue;
    }
    const destKey = String(dest);
    if (seenDests.has(destKey)) continue;
    seenDests.add(destKey);

    const creative = creativesByHandle.get(handle);
    if (creative) {
      await sendCreativeToChat(bot.telegram, destKey, creative, payload.adInfo.caption);
    }

    // Forward the brief to the page channel too (so VAs see context)
    try {
      await bot.telegram.forwardMessage(destKey, TARGET_CHAT, briefMsg.message_id);
    } catch (e) {
      console.error(`[poster] forward brief → ${destKey}: ${e.message}`);
    }
  }

  // 3. Record posted_ads rows for each page (for later "marked live" lookup)
  const durationMs = parseDurationMs(payload.adInfo.duration);
  for (const page of payload.pages) {
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

  // 5. Update the original notification card
  if (session.approval_msg) {
    try {
      await bot.telegram.editMessageText(
        session.approval_msg.chatId,
        session.approval_msg.messageId,
        undefined,
        `✅ *Sent.* ${payload.pages.length} page(s) live in Internal Network Ads.`,
        { parse_mode: "Markdown" }
      );
    } catch (e) {
      console.error("[poster] edit notification error:", e.message);
    }
  }

  console.log(`[poster] ✅ Sent ad ${sessionId} — ${payload.pages.length} pages`);
}

/**
 * Schedule an executeIntake() call after the cancel window.
 */
function scheduleExecution(bot, sessionId, delayMs = CANCEL_WINDOW_MS) {
  // Clear any prior scheduling for this session
  const existing = _scheduledSends.get(sessionId);
  if (existing) clearTimeout(existing);

  const handle = setTimeout(() => {
    _scheduledSends.delete(sessionId);
    executeIntake(bot, sessionId).catch((e) => {
      console.error(`[poster] scheduled execution error for ${sessionId}:`, e.message);
    });
  }, delayMs);

  _scheduledSends.set(sessionId, handle);
}

/**
 * Cancel a scheduled intake (called by the [❌ Cancel] button).
 */
async function cancelIntake(bot, sessionId) {
  const handle = _scheduledSends.get(sessionId);
  if (handle) {
    clearTimeout(handle);
    _scheduledSends.delete(sessionId);
  }
  await sessions.cancelSession(sessionId);

  // Update notification card
  const { data: session } = await sessions._supabase
    .from("ad_sessions")
    .select("approval_msg, payload")
    .eq("id", sessionId)
    .single();

  if (session?.approval_msg) {
    try {
      await bot.telegram.editMessageText(
        session.approval_msg.chatId,
        session.approval_msg.messageId,
        undefined,
        `❌ *Cancelled.* Ad was not sent.`,
        { parse_mode: "Markdown" }
      );
    } catch (e) {
      console.error("[poster] edit cancellation error:", e.message);
    }
  }
}

/**
 * Top-level entry point called by lib/api.js after a session is created.
 * Sends the notification + schedules the auto-send.
 */
async function handleIntake({ session, payload, bot }) {
  await sendIntakeNotification(bot, session, payload);
  scheduleExecution(bot, session.id);
}

module.exports = {
  handleIntake,
  cancelIntake,
  executeIntake,
  scheduleExecution,
  buildBriefFromPayload,
  GREG_TAG,
  CANCEL_WINDOW_MS,
};
