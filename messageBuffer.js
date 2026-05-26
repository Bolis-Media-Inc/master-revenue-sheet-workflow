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

// Strong markers that a text message is a brief (not a caption / admin
// chatter). Used by the bundle scanners as a STOP signal — if we hit one
// of these while scanning backwards from the current ad, we've crossed
// into a previous ad's content and must not pull any further media.
//
// Captions and random text between brief and media should be SKIPPED, not
// treated as boundaries — that's the whole point of this list. False
// positives here are dangerous (premature stop = no attribution); false
// negatives are mildly dangerous (over-scan = pull previous ad's media,
// but clearBufferUpTo usually cleans these out before we get there).
function _looksLikePreviousBrief(text) {
  if (!text) return false;
  return /\bPAGE INFO\b/i.test(text) || /\bINSTRUCTIONS:/i.test(text);
}

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
    // Ad message not found in buffer, or it's the very first — return empty.
    // Never return random buffer messages as a fallback.
    return [];
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
  // If the ad wasn't found in the buffer, return empty — never scan random buffer contents.
  if (adIdx <= 0) return new Map();
  const preceding = buf.slice(0, adIdx);

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
      // Label format options:
      //   "@thefuck.tv ^"                              → handle only
      //   "@thefuck.tv ^"  (no @)                      → handle only
      //   "@thefuck.tv NEO just dropped! Read bio ^"   → handle + per-page caption
      //
      // First token (sans @, lowercased) is the handle. Anything between
      // handle and trailing ^ becomes the per-page caption text that will
      // be forwarded as a separate message after the media in that
      // page's IG Ads chat — useful when each page gets unique copy.
      const labelText = text.slice(0, -1).trim();
      const firstSpace = labelText.search(/\s/);
      const handlePart = (firstSpace === -1 ? labelText : labelText.slice(0, firstSpace))
        .toLowerCase().replace(/^@/, "");
      const captionPart = firstSpace === -1 ? null : labelText.slice(firstSpace + 1).trim() || null;
      result.set(handlePart, { media: [...pendingContent], caption: captionPart });
      pendingContent = [];

    } else if (hasMedia) {
      // Content message — prepend so the final array stays chronological
      pendingContent.unshift(msg);

    } else if (!text) {
      // Empty / service message — skip
      continue;

    } else if (_looksLikePreviousBrief(text)) {
      // Strong signal we've crossed into a previous ad — stop.
      break;

    } else {
      // Random text (Instagram caption, admin chatter, "13 Covers ^" annotation
      // that wasn't a label, etc). Skip — keep scanning for media + labels.
      continue;
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

  // If the ad wasn't found in the buffer, return null — never scan random buffer contents.
  if (adIdx <= 0) return null;
  const preceding = buf.slice(0, adIdx);

  // "Host: @handle, invite: @a @b @c"
  // Handles may appear on separate lines within the same message text.
  const HOST_RE = /^Host:\s*@([\w.]+)(?:,\s*|\s+)invite:\s*([\s\S]+)/i;

  // Quick bail — if there are no Host: messages, this isn't a collab ad
  if (!preceding.some((m) => HOST_RE.test((m.text || "").trim()))) return null;

  // ── Forward pass (oldest → newest) ──────────────────────────────────────
  // Group messages into {video, captionMsgs[], hostMsgs[]} blocks.
  // A new block opens every time we see a media file (video, document, photo, animation).
  // Text between a video and the next Host: line = caption for that group.
  // Text BEFORE any video = old noise (ignored).
  const groups  = []; // Array<{video: msg|null, captionMsgs: msg[], hostMsgs: [{msg, handles: string[]}]}>
  let current = { video: null, captionMsgs: [], hostMsgs: [] };

  for (const msg of preceding) {
    const text = (msg.text || "").trim();
    const hasMedia = !!(msg.video || msg.document || msg.photo || msg.animation);

    if (hasMedia) {
      // Flush the current block (if it has any host messages) and open a new one
      if (current.hostMsgs.length > 0) groups.push(current);
      current = { video: msg, captionMsgs: [], hostMsgs: [] };

    } else {
      const m = text.match(HOST_RE);
      if (m) {
        const hostHandle    = m[1].toLowerCase();
        const inviteHandles = (m[2].match(/@([\w.]+)/g) || [])
          .map((h) => h.slice(1).toLowerCase());
        current.hostMsgs.push({ msg, handles: [hostHandle, ...inviteHandles] });
      } else if (text && current.video && current.hostMsgs.length === 0) {
        // Text between a video and the first Host: message = caption/promo for this group.
        // Only collect if we have a video (ignore text before any video = old noise).
        current.captionMsgs.push(msg);
      }
      // Text before any video or after Host: messages is ignored.
    }
  }
  // Flush final block
  if (current.hostMsgs.length > 0) groups.push(current);

  // ── Build handle → {media, caption} map ──────────────────
  // Shape mirrors getContentBundlesByPage / getFilenameBundlesByPage so
  // the caller can read all three uniformly. Collab posts don't carry
  // per-page caption text today (captionMsgs are forwarded as media-
  // sibling messages, not as text the VA copies into IG) — so caption is
  // always null. Could revisit if Bolis ever needs unique IG copy per
  // collab member.
  const result = new Map();
  for (const group of groups) {
    for (const { msg: hostMsg, handles } of group.hostMsgs) {
      // Order: video → caption text messages → host/invite message
      const toForward = [
        ...(group.video ? [group.video] : []),
        ...group.captionMsgs,
        hostMsg,
      ];
      for (const handle of handles) {
        result.set(handle, { media: toForward, caption: null });
      }
    }
  }

  return result;
}

/**
 * Clear all messages in the buffer for a given chat up to (and including)
 * a specific message ID. Called after an ad is processed so that stale
 * messages from previous ad batches don't contaminate future scans.
 *
 * @param {string} chatId
 * @param {number} upToMessageId  Clear everything up to and including this message
 */
/**
 * Detect per-page content bundles from FILENAME attribution.
 *
 * Convention: each cover is uploaded as a document with the filename
 * starting with "@<handle>" (e.g. "@i_have_no_memes96_v2.jpg",
 * "@thefuck.tv.jpg"). Trailing " (1)", " (2)" duplicate-suffixes are
 * tolerated since Telegram clients sometimes append them when files
 * collide on the user's device.
 *
 * Returns Map<handle, Array<message>> where each entry is just [coverMsg]
 * (one message per page). Returns null when no filename-attributed media
 * is found, so the caller can fall through to text-label detection.
 *
 * Stops scanning at the first non-media, non-empty message (typically
 * the previous ad's brief) so we don't pull covers from earlier ads.
 *
 * @param {string} chatId
 * @param {number} adMessageId
 * @returns {Map<string, Array>|null}
 */
function getFilenameBundlesByPage(chatId, adMessageId) {
  const buf = _buffers.get(String(chatId)) || [];
  const adIdx = buf.findIndex((m) => m.message_id === adMessageId);
  if (adIdx <= 0) return null;
  const preceding = buf.slice(0, adIdx);

  const result = new Map();
  let foundAny = false;

  for (let i = preceding.length - 1; i >= 0; i--) {
    const msg = preceding[i];
    const fileName =
      msg.document?.file_name ||
      msg.video?.file_name    ||
      msg.audio?.file_name    || "";
    const text = (msg.text || msg.caption || "").trim();
    const hasMedia = !!(msg.photo || msg.video || msg.document ||
                        msg.animation || msg.audio);

    if (hasMedia) {
      // Match "@<handle>" at the start, allow optional " (N)" duplicate
      // suffix and any extension. \w covers letters/digits/underscore;
      // we add `.` for handles like "thefuck.tv".
      const m = fileName.match(/^@([\w.]+?)(?:\s*\(\d+\))?\s*\.[a-zA-Z0-9]+$/);
      if (m && m[1]) {
        const handle = m[1].toLowerCase().replace(/\.$/, "");
        // Telegram's media `caption` field — if Danielson typed something
        // under the file in his client, it surfaces here. Becomes the
        // per-page caption forwarded as a separate text after the cover.
        const mediaCaption = (msg.caption || "").trim() || null;
        if (!result.has(handle)) {
          result.set(handle, { media: [msg], caption: mediaCaption });
        } else {
          // Multiple files for the same page — keep chronological order
          // and prefer the most recent non-null caption (first iteration =
          // newest since we're walking backwards).
          const entry = result.get(handle);
          entry.media.unshift(msg);
          if (!entry.caption && mediaCaption) entry.caption = mediaCaption;
        }
        foundAny = true;
      }
      // Media without an @-filename is fine — could be a shared "slides
      // 2-4" attachment that doesn't get per-page-routed by filename.
      // We just don't attribute it.

    } else if (!text) {
      continue; // empty / service
    } else if (_looksLikePreviousBrief(text)) {
      // Strong "previous ad" signal — stop here, don't pull from earlier ad
      break;
    } else {
      // Caption text, "13 Covers ^" annotation, admin chatter — skip and
      // keep scanning. The strong-marker check above is the real boundary.
      continue;
    }
  }

  return foundAny ? result : null;
}

function clearBufferUpTo(chatId, upToMessageId) {
  const buf = _buffers.get(String(chatId));
  if (!buf) return;

  const idx = buf.findIndex((m) => m.message_id === upToMessageId);
  if (idx >= 0) {
    // Remove everything up to and including the ad message
    buf.splice(0, idx + 1);
  }
}

module.exports = { addMessage, getPrecedingMessages, getContentBundlesByPage, getCollabBundlesByPage, getFilenameBundlesByPage, clearBufferUpTo, MAX_BUFFER_PER_CHAT };
