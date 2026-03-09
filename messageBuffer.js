/**
 * messageBuffer.js
 * Maintains a rolling in-memory buffer of recent messages per chat.
 *
 * Why: Telegram bots cannot query chat history retroactively — they only
 * receive messages as they arrive. To forward the content (image/video)
 * that precedes an ad brief, we store the last N messages as they come in.
 */

const MAX_BUFFER_PER_CHAT = 30; // keep last 30 messages per group

// Map<chatId (string), Array<TelegramMessage>>
const _buffers = new Map();

/**
 * Store a message in the rolling buffer for its chat.
 * Call this on EVERY incoming message before any other handler fires.
 *
 * @param {object} message  ctx.message from Telegraf
 */
function addMessage(message) {
  if (!message?.chat?.id || !message?.message_id) return;

  const chatId = String(message.chat.id);
  if (!_buffers.has(chatId)) _buffers.set(chatId, []);

  const buf = _buffers.get(chatId);
  buf.push(message);

  // Trim to max — drop oldest
  if (buf.length > MAX_BUFFER_PER_CHAT) buf.shift();
}

/**
 * Return up to `count` messages that immediately preceded `beforeMessageId`
 * in the given chat.
 *
 * @param {string} chatId
 * @param {number} beforeMessageId  The ad message's message_id
 * @param {number} count            How many preceding messages to retrieve (default 2)
 * @returns {Array<TelegramMessage>}  Oldest first (same order as in the chat)
 */
function getPrecedingMessages(chatId, beforeMessageId, count = 2) {
  const buf = _buffers.get(String(chatId)) || [];

  // Find the index of the ad message itself
  const adIdx = buf.findIndex((m) => m.message_id === beforeMessageId);

  if (adIdx <= 0) {
    // Ad message not found in buffer, or it's the very first — return whatever we have
    // (this happens if the bot just started and missed earlier messages)
    return buf.slice(Math.max(0, buf.length - count));
  }

  // Return up to `count` messages before the ad
  return buf.slice(Math.max(0, adIdx - count), adIdx);
}

module.exports = { addMessage, getPrecedingMessages };
