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

/**
 * Scan backwards from the ad message and group preceding content into
 * per-page bundles based on text label messages ending with "^".
 *
 * Label format: "PageHandle^"   e.g. "Thefuck.tv^"  "Childhoodpost^"
 *
 * The scan walks back through the buffer and collects media messages,
 * assigning them to the most recent label seen while going backwards.
 * It stops when it hits a plain text message that is NOT a label
 * (e.g. an old ad brief, an admin comment) to avoid over-reaching.
 *
 * Returns a Map<string, Array<message>> where the key is the normalized
 * label (lowercased, "^" stripped) and the value is the content messages
 * for that page in chronological order (oldest first).
 *
 * Returns an empty Map if no labeled bundles are found (simple/shared ad).
 *
 * @param {string} chatId
 * @param {number} adMessageId
 * @returns {Map<string, Array>}
 */
function getContentBundlesByPage(chatId, adMessageId) {
  const buf = _buffers.get(String(chatId)) || [];
  const adIdx = buf.findIndex((m) => m.message_id === adMessageId);

  // Messages before the ad (oldest … newest, not including the ad itself)
  const preceding = adIdx > 0
    ? buf.slice(0, adIdx)
    : buf.slice(0, Math.max(0, buf.length - 1));

  const result = new Map();
  let pendingContent = []; // media messages collected since the last label (going backwards)

  for (let i = preceding.length - 1; i >= 0; i--) {
    const msg  = preceding[i];
    const text = (msg.text || "").trim();
    const hasMedia = !!(
      msg.photo || msg.video || msg.document ||
      msg.animation || msg.audio || msg.sticker
    );

    // A label message: text-only, non-empty, ends with "^"
    const isLabel = !hasMedia && text.endsWith("^") && text.length > 1;

    if (isLabel) {
      const label = text.slice(0, -1).trim().toLowerCase();
      result.set(label, [...pendingContent]); // pendingContent is already oldest-first
      pendingContent = [];

    } else if (hasMedia) {
      // Content message — prepend so the final array stays chronological
      pendingContent.unshift(msg);

    } else if (!text) {
      // Empty / service message — skip
      continue;

    } else {
      // Plain text that is NOT a label — likely a previous ad brief or admin note.
      // Stop scanning so we don't accidentally pull in content from an earlier ad.
      break;
    }
  }

  return result;
}

/**
 * Detect and parse collab-post content bundles from preceding messages.
 *
 * Collab post format (oldest → newest before the ad brief):
 *
 *   VideoA.mp4
 *   Host: @pageX, invite: @pageA @pageB @pageC
 *   Host: @pageY, invite: @pageD @pageE
 *   VideoB.mp4
 *   Host: @pageZ, invite: @pageF @pageG
 *   [optional promo text / caption copy — skipped]
 *   AD BRIEF
 *
 * Each video "owns" the Host messages that follow it before the next video.
 * Every handle mentioned in a Host message (host + all invites) should receive
 * that video + that host message when the ad is forwarded.
 *
 * Returns a Map<handle, Array<message>> where the value is [video?, hostMsg]
 * in the order they should be forwarded.
 * Returns null (not an empty Map) when no collab format is detected, so the
 * caller can distinguish "collab with no matches" from "not a collab".
 *
 * @param {string} chatId
 * @param {number} adMessageId
 * @returns {Map<string, Array>|null}
 */
function getCollabBundlesByPage(chatId, adMessageId) {
  const buf = _buffers.get(String(chatId)) || [];
  const adIdx = buf.findIndex((m) => m.message_id === adMessageId);

  // Messages before the ad (oldest → newest)
  const preceding = adIdx > 0
    ? buf.slice(0, adIdx)
    : buf.slice(0, Math.max(0, buf.length - 1));

  // "Host: @handle, invite: @a @b @c"
  // Handles may appear on separate lines within the same message text.
  const HOST_RE = /^Host:\s*@([\w.]+)(?:,\s*|\s+)invite:\s*([\s\S]+)/i;

  // Quick bail — if there are no Host: messages, this isn't a collab ad
  if (!preceding.some((m) => HOST_RE.test((m.text || "").trim()))) return null;

  // ── Forward pass (oldest → newest) ──────────────────────────────────────
  // Group messages into {video, hostMsgs[]} blocks.
  // A new block opens every time we see a video file.
  // Host messages after a video belong to that video's block.
  // Plain text that isn't a Host: line is treated as shared caption copy
  // (e.g. "Now he can buy 100,000 new shirts 🥹👕") and forwarded to every page.
  const groups      = []; // Array<{video: msg|null, hostMsgs: [{msg, handles: string[]}]}>
  const captionMsgs = []; // Plain-text caption/promo messages shared by all pages
  let current = { video: null, hostMsgs: [] };

  for (const msg of preceding) {
    const text = (msg.text || "").trim();

    if (msg.video || msg.document) {
      // Flush the current block (if it has any host messages) and open a new one
      if (current.hostMsgs.length > 0) groups.push(current);
      current = { video: msg, hostMsgs: [] };

    } else {
      const m = text.match(HOST_RE);
      if (m) {
        const hostHandle    = m[1].toLowerCase();
        const inviteHandles = (m[2].match(/@([\w.]+)/g) || [])
          .map((h) => h.slice(1).toLowerCase());
        current.hostMsgs.push({ msg, handles: [hostHandle, ...inviteHandles] });
      } else if (text) {
        // Plain text that isn't a Host: line — treat as shared caption/promo copy.
        // Collect it so we can append it to every page's bundle.
        captionMsgs.push(msg);
      }
    }
  }
  // Flush final block
  if (current.hostMsgs.length > 0) groups.push(current);

  // ── Build handle → [video?, hostMsg, ...captionMsgs] map ─────────────────
  const result = new Map();
  for (const group of groups) {
    for (const { msg: hostMsg, handles } of group.hostMsgs) {
      // Order: video → host/invite message → caption copy (same order as the chat)
      const toForward = [
        ...(group.video ? [group.video] : []),
        hostMsg,
        ...captionMsgs,
      ];
      for (const handle of handles) {
        result.set(handle, toForward);
      }
    }
  }

  return result;
}

module.exports = { addMessage, getPrecedingMessages, getContentBundlesByPage, getCollabBundlesByPage, MAX_BUFFER_PER_CHAT };
