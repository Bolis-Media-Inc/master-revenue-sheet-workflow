/**
 * userClient.js — Telegram User Account Client (sales)
 *
 * Connects to @sales_bolismedia via gramjs for the features that
 * legitimately need a user identity:
 *
 *   - sendRecap — daily recap message posted AS the sales account
 *   - onNewMessage — passive message listener for brain.js auto-capture
 *   - getMessagesSince — recap aggregation across all chats
 *
 * Chat lookup / dialog search used to live here too (as searchChats,
 * with an optional ops session fallback). That's been removed — user-
 * account features that aren't strictly Greg's domain (chat discovery,
 * bulk bot-invite, etc.) should live in Digi instead. See architecture
 * doc / Connor's "Greg owns the API, Digi owns user-account tasks"
 * framing.
 *
 * Env vars:
 *   TELEGRAM_API_ID         — from https://my.telegram.org (numeric)
 *   TELEGRAM_API_HASH       — from https://my.telegram.org (string)
 *   TELEGRAM_SESSION        — session string from setup-session.js
 *   GREG_SALES_CHAT         — recap target chat (group username or id)
 */

require("dotenv").config();
const { TelegramClient, Api } = require("telegram");
const { StringSession }       = require("telegram/sessions");

const API_ID      = parseInt(process.env.TELEGRAM_API_ID  || "0", 10);
const API_HASH    = process.env.TELEGRAM_API_HASH          || "";
const SESSION_STR = process.env.TELEGRAM_SESSION           || "";
const SALES_CHAT  = process.env.GREG_SALES_CHAT            || "";

let _client = null;

// ── Connect ───────────────────────────────────────────────────────────────────

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
  console.log("[userClient] ✅ Connected as @sales_bolismedia");
  return _client;
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
}

/**
 * Forward messages from one chat to another via the user account.
 * (Kept for backwards compat; new flow prefers sendFile / sendMessage
 * direct posting via this same user session so bm_tracking_bot's webhook
 * sees the post naturally and processes via its normal handleAdMessage.)
 */
async function forwardMessages(fromChatId, toChatId, messageIds) {
  if (!messageIds || messageIds.length === 0) return { ok: true };
  try {
    const client = await getClient();
    await client.forwardMessages(toChatId, {
      messages: messageIds.map(Number),
      fromPeer: fromChatId,
    });
    return { ok: true };
  } catch (err) {
    console.error(`[userClient] forwardMessages ${fromChatId}→${toChatId} (${messageIds.length} msg): ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Upload a file (Buffer) to a Telegram chat AS THE USER ACCOUNT
 * (sales_bolismedia). Used when Greg the bot has the file via Marcel's
 * DM but we need the post to appear from a USER so bm_tracking_bot
 * (which is blocked from seeing other bots' messages by Telegram's
 * bot-to-bot filter) can pick it up via its normal webhook.
 *
 * @param {number|string} chatId
 * @param {Buffer}        buffer   Raw file contents
 * @param {object}        [opts]
 * @param {string}        [opts.filename]   Filename to attach (Telegram uses this for downloads)
 * @param {string}        [opts.caption]    Caption text shown under the file
 * @param {boolean}       [opts.asDocument] Force document-style upload (recommended for consistency with the team's brief format)
 * @returns {Promise<{ok: boolean, message_id?: number, error?: string}>}
 */
async function sendFile(chatId, buffer, opts = {}) {
  try {
    const client = await getClient();
    const sent = await client.sendFile(chatId, {
      file:           buffer,
      caption:        opts.caption,
      fileName:       opts.filename,
      forceDocument:  opts.asDocument !== false, // default to document
    });
    return { ok: true, message_id: sent?.id };
  } catch (err) {
    console.error(`[userClient] sendFile → ${chatId} (${buffer.length} bytes): ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Send a text-only message AS THE USER ACCOUNT and return the sent
 * message_id (the existing sendMessage above doesn't return). Used by
 * the wizard's approve flow so we have the brief's message_id for any
 * downstream lookups.
 */
async function sendText(chatId, text) {
  try {
    const client = await getClient();
    const sent = await client.sendMessage(chatId, { message: text });
    return { ok: true, message_id: sent?.id };
  } catch (err) {
    console.error(`[userClient] sendText → ${chatId}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

module.exports = { getClient, sendMessage, sendRecap, getRecentMessages, listChats, getMessagesSince, onNewMessage, disconnect, forwardMessages, sendFile, sendText };
