/**
 * userClient.js — Telegram User Account Clients
 *
 * Two real-user MTProto connections, both via gramjs:
 *
 *   1. SALES (@sales_bolismedia) — the default. Handles recaps, message
 *      listening (onNewMessage), and anything that needs to act AS the
 *      sales identity. Required.
 *
 *   2. OPS (operations account) — optional second session. The ops
 *      account is the one that *creates* every new page's IG Ads chat,
 *      so it's a member of every chat from inception (sales sometimes
 *      isn't added for a while). Used for chat search / lookup so the
 *      /admin/page-registry "Find chat" feature surfaces fresh chats
 *      the moment they're created.
 *
 * Env vars:
 *   Sales (required):
 *     TELEGRAM_API_ID       — from https://my.telegram.org (numeric)
 *     TELEGRAM_API_HASH     — from https://my.telegram.org (string)
 *     TELEGRAM_SESSION      — session string from setup-session.js
 *
 *   Ops (optional — falls back to sales for chat search if unset):
 *     OPS_TELEGRAM_API_ID
 *     OPS_TELEGRAM_API_HASH
 *     OPS_TELEGRAM_SESSION
 *
 *   GREG_SALES_CHAT         — recap target chat (group username or id)
 */

require("dotenv").config();
const { TelegramClient, Api } = require("telegram");
const { StringSession }       = require("telegram/sessions");

// Sales session (legacy default — required)
const API_ID      = parseInt(process.env.TELEGRAM_API_ID  || "0", 10);
const API_HASH    = process.env.TELEGRAM_API_HASH          || "";
const SESSION_STR = process.env.TELEGRAM_SESSION           || "";
const SALES_CHAT  = process.env.GREG_SALES_CHAT            || "";

// Ops session (optional — used for chat lookup only)
const OPS_API_ID      = parseInt(process.env.OPS_TELEGRAM_API_ID  || "0", 10);
const OPS_API_HASH    = process.env.OPS_TELEGRAM_API_HASH          || "";
const OPS_SESSION_STR = process.env.OPS_TELEGRAM_SESSION           || "";

let _client    = null;  // sales
let _opsClient = null;  // ops

// ── Connect (sales) ───────────────────────────────────────────────────────────

async function getClient() {
  if (_client?.connected) return _client;

  if (!API_ID || !API_HASH || !SESSION_STR) {
    throw new Error(
      "Missing TELEGRAM_API_ID, TELEGRAM_API_HASH, or TELEGRAM_SESSION env vars. " +
      "Run: node setup-session.js"
    );
  }

  const session = new StringSession(SESSION_STR);
  _client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 5,
    useWSS: false,
  });

  await _client.connect();
  console.log("[userClient] ✅ Connected as @sales_bolismedia (sales)");
  return _client;
}

// ── Connect (ops) ─────────────────────────────────────────────────────────────
// Returns null when ops env vars aren't configured — callers should
// fall back to the sales client. Lazy-instantiated on first use.

async function getOpsClient() {
  if (_opsClient?.connected) return _opsClient;
  if (!OPS_API_ID || !OPS_API_HASH || !OPS_SESSION_STR) return null;

  const session = new StringSession(OPS_SESSION_STR);
  _opsClient = new TelegramClient(session, OPS_API_ID, OPS_API_HASH, {
    connectionRetries: 5,
    useWSS: false,
  });

  await _opsClient.connect();
  console.log("[userClient] ✅ Connected as operations account (chat-lookup channel)");
  return _opsClient;
}

// ── Send message to a chat ────────────────────────────────────────────────────

async function sendMessage(chatIdOrUsername, text) {
  const client = await getClient();
  await client.sendMessage(chatIdOrUsername, { message: text });
}

// ── Send daily recap to the Greg+ Sales Team group ────────────────────────────

async function sendRecap(text) {
  if (!SALES_CHAT) {
    console.warn("[userClient] GREG_SALES_CHAT not set — recap not sent");
    return;
  }
  await sendMessage(SALES_CHAT, text);
}

// ── Get recent messages from a chat ──────────────────────────────────────────

async function getRecentMessages(chatIdOrUsername, limit = 50) {
  const client = await getClient();
  const messages = await client.getMessages(chatIdOrUsername, { limit });
  return messages.map((m) => ({
    id:        m.id,
    text:      m.message || "",
    sender:    m.senderId?.toString() || null,
    date:      new Date(m.date * 1000),
  }));
}

// ── List all chats the account is in ─────────────────────────────────────────

async function listChats() {
  const client = await getClient();
  const dialogs = await client.getDialogs({ limit: 100 });
  return dialogs.map((d) => ({
    id:    d.id?.toString(),
    name:  d.title || d.name || "Unknown",
    type:  d.isGroup ? "group" : d.isChannel ? "channel" : "private",
  }));
}

// ── Search chats by name substring ───────────────────────────────────────────
// Powers Digi's /admin/page-registry "Find chat by handle" lookup.
//
// Prefers the OPS account because operations creates every IG Ads chat
// — so ops is a member from second zero. The sales account sometimes
// isn't added for a while after a new page comes online, which would
// make freshly-created chats invisible to a sales-only search.
//
// Falls back to the sales client if ops env vars aren't configured.
// Higher dialog limit than listChats() (500) since the account is in
// 100+ chats and a stale cap would silently miss matches.
async function searchChats(query, { limit = 20 } = {}) {
  if (!query) return [];
  const q = String(query).trim().toLowerCase();
  if (!q) return [];
  const client = (await getOpsClient()) || (await getClient());
  const dialogs = await client.getDialogs({ limit: 500 });
  const matches = [];
  for (const d of dialogs) {
    const name = d.title || d.name || "";
    if (!name) continue;
    if (!name.toLowerCase().includes(q)) continue;
    matches.push({
      id:   d.id?.toString(),
      name,
      type: d.isGroup ? "group" : d.isChannel ? "channel" : "private",
    });
    if (matches.length >= limit) break;
  }
  // Rank: shorter names first (more specific matches usually win), then
  // alphabetical for stable ordering.
  matches.sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
  return matches;
}

// ── Get messages from all chats since a given date ───────────────────────────
// Used for the daily recap — pulls the last N hours across all relevant chats.

async function getMessagesSince(sinceDate, maxPerChat = 100) {
  const client  = await getClient();
  const dialogs = await client.getDialogs({ limit: 100 });
  const results = [];

  for (const dialog of dialogs) {
    // Skip broadcast channels and archived chats
    if (dialog.isChannel && !dialog.isGroup) continue;

    try {
      const messages = await client.getMessages(dialog.inputEntity, {
        limit: maxPerChat,
        offsetDate: Math.floor(Date.now() / 1000), // start from now, going back
      });

      for (const m of messages) {
        const msgDate = new Date(m.date * 1000);
        if (msgDate < sinceDate) break; // messages are ordered newest-first
        if (!m.message?.trim()) continue;

        results.push({
          chatId:   dialog.id?.toString(),
          chatName: dialog.title || dialog.name || "Unknown",
          msgId:    m.id,
          text:     m.message,
          sender:   m.senderId?.toString() || null,
          date:     msgDate,
        });
      }
    } catch (_) {
      // Some chats may be inaccessible — skip silently
    }
  }

  return results.sort((a, b) => a.date - b.date);
}

// ── Listen to new messages (passive capture) ─────────────────────────────────

async function onNewMessage(callback) {
  const client = await getClient();
  const { NewMessage } = require("telegram/events");

  client.addEventHandler(async (event) => {
    try {
      const msg = event.message;
      if (!msg?.message?.trim()) return;

      // Get chat info
      let chatName = "Unknown";
      let chatId   = msg.chatId?.toString() || msg.peerId?.toString() || null;
      try {
        const entity = await client.getEntity(msg.peerId);
        chatName = entity.title || entity.username || chatName;
      } catch (e) {
        // CHANNEL_INVALID etc — skip silently, use defaults
        if (e.errorMessage === 'CHANNEL_INVALID') {
          console.warn(`[userClient] Skipping invalid channel: ${chatId}`);
          return; // Don't process messages from channels we can't access
        }
      }

      const senderId = msg.senderId?.toString() || null;
      let senderHandle = senderId;
      try {
        const sender = await client.getEntity(msg.senderId);
        senderHandle = sender.username || sender.firstName || senderId;
      } catch (_) {}

      callback({
        chatId,
        chatName,
        msgId:  msg.id,
        text:   msg.message,
        sender: senderHandle,
        date:   new Date(msg.date * 1000),
      });
    } catch (e) {
      // Don't let a single message error crash the entire listener
      console.warn(`[userClient] Message handler error: ${e.message}`);
    }
  }, new NewMessage({}));

  console.log("[userClient] 👂 Listening for new messages across all chats...");
}

// ── Disconnect ────────────────────────────────────────────────────────────────

async function disconnect() {
  if (_client?.connected)    { await _client.disconnect();    _client    = null; }
  if (_opsClient?.connected) { await _opsClient.disconnect(); _opsClient = null; }
}

module.exports = { getClient, getOpsClient, sendMessage, sendRecap, getRecentMessages, listChats, searchChats, getMessagesSince, onNewMessage, disconnect };
