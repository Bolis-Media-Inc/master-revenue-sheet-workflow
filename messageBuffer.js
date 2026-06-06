/**
 * messageBuffer.js
 * Maintains a rolling in-memory buffer of recent messages per chat.
 *
 * Why: Telegram bots cannot query chat history retroactively — they only
 * receive messages as they arrive. To forward the content (image/video)
 * that precedes an ad brief, we store the last N messages as they come in.
 */

// Buffer cap per chat. Used to be 30, which was fine when /replay
// didn't exist. Now /replay walks the buffer to find prior briefs by
// name — for an active chat like Internal Network Ads (~5-10 briefs/hr
// × ~5-15 msgs per brief) 30 = ~15min window before briefs age out.
// 100 ≈ 1 hour of headroom on a heavy day. Still RAM-cheap (~250KB
// per chat with full Telegram message objects).
const MAX_BUFFER_PER_CHAT = 100;

// Map<chatId (string), Array<TelegramMessage>>
const _buffers = new Map();

// ── Persistence layer ─────────────────────────────────────────────────────
// In-memory buffer dies on every Railway redeploy / crash. To prevent
// in-flight collab/multi-msg briefs from breaking when we deploy fixes,
// mirror every message to Supabase message_buffer table. On startup,
// hydrate the in-memory buffer from the last MAX_BUFFER_PER_CHAT rows
// per chat. Bundle scanners are unchanged — they still read the
// in-memory _buffers Map.
//
// Schema: migrations/013_message_buffer.sql
// Fail-soft: if Supabase isn't configured, everything still works in-
// memory only (same behavior as before this layer was added).
const { createClient } = require("@supabase/supabase-js");
const _supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

if (!_supabase) {
  console.warn("[messageBuffer] SUPABASE_URL not set — persistence disabled, buffer is RAM-only");
}

// ── Dedup helpers for shared media (task #41) ────────────────────────────────
//
// Operators sometimes upload the same file multiple times in one brief (e.g.
// Danielson uploaded IMG_3448.JPG twice within one batch — same iPhone
// filename, same byte count, but DIFFERENT Telegram file_ids since each
// upload event is a distinct message). The bundle scanners walk backwards
// and would surface every copy as a separate cover in /resolve — operator
// burden + visual noise.
//
// _mediaKey() produces a stable identity from (filename, file_size). When
// the key matches a previously-added shared item, we skip the duplicate.
// Walking is backwards-from-brief, so the FIRST instance we see is the
// closest to the brief; we keep that and drop earlier-uploaded duplicates.
//
// Photos don't carry file_name → can't dedupe → always pushed (rare in
// document-heavy ads, never seen as duplicates in practice).

function _mediaKey(msg) {
  if (!msg) return null;
  const doc = msg.document || msg.video || msg.audio;
  if (!doc) return null;
  const name = doc.file_name;
  const size = doc.file_size;
  // Need both to safely dedupe — without size, two unrelated files with
  // the same iPhone name (rare but possible across users) would collide.
  if (!name || size == null) return null;
  return `${name}|${size}`;
}

function _addUniqueShared(sharedMedia, msg, seenKeys) {
  const key = _mediaKey(msg);
  if (!key) {
    sharedMedia.unshift(msg); // photo or untracked kind — can't dedupe
    return;
  }
  if (seenKeys.has(key)) return; // duplicate — drop
  seenKeys.add(key);
  sharedMedia.unshift(msg);
}

/**
 * Hydrate the in-memory buffer from Supabase on startup. Must be awaited
 * before the webhook starts processing messages.
 */
async function hydrateFromDb() {
  if (!_supabase) return;
  try {
    // Pull the last MAX_BUFFER_PER_CHAT rows per chat — Postgres doesn't
    // do per-group LIMIT easily, so just grab the most recent N=10000
    // rows total (safe over-fetch for ~100 chats × 100 msgs) and group
    // in code. Cheap; runs once at boot.
    const { data, error } = await _supabase
      .from("message_buffer")
      .select("chat_id, message_json, received_at")
      .order("received_at", { ascending: false })
      .limit(10000);
    if (error) { console.error("[messageBuffer] hydrateFromDb error:", error.message); return; }

    // Group by chat_id, take newest MAX_BUFFER_PER_CHAT, reverse for chrono order
    const byChat = new Map();
    for (const row of (data || [])) {
      const cid = String(row.chat_id);
      if (!byChat.has(cid)) byChat.set(cid, []);
      const arr = byChat.get(cid);
      if (arr.length < MAX_BUFFER_PER_CHAT) arr.push(row.message_json);
    }
    let total = 0;
    for (const [cid, msgs] of byChat) {
      // Reverse to chronological order (we fetched DESC, in-memory expects oldest→newest)
      msgs.reverse();
      _buffers.set(cid, msgs);
      total += msgs.length;
    }
    console.log(`[messageBuffer] 🔄 Hydrated ${total} message(s) across ${byChat.size} chat(s) from DB`);
  } catch (err) {
    console.error("[messageBuffer] hydrateFromDb threw:", err.message);
  }
}

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

  // Fire-and-forget DB persistence — never blocks message processing.
  // Idempotent via UNIQUE(chat_id, message_id), so dupes from retry are
  // silently swallowed.
  if (_supabase) {
    _supabase.from("message_buffer").upsert({
      chat_id:      Number(chatId),
      message_id:   message.message_id,
      message_json: message,
    }, { onConflict: "chat_id,message_id" }).then(({ error }) => {
      if (error) console.error("[messageBuffer] persist error:", error.message);
    });
  }
}

/**
 * Apply a Telegram edit to the in-memory + persisted buffer.
 *
 * Called from bot.on("edited_message", ...) — when a sender edits a
 * caption/brief/text after posting, Telegram fires a separate webhook
 * with the new payload. Without this, /replay + /resolve forward the
 * stale pre-edit text forever.
 *
 * Strategy: replace the row in-place (same chat_id + message_id), keep
 * buffer position so scanner ordering doesn't change. If the message
 * isn't in the buffer (aged out), persist to DB anyway so a future
 * hydrateFromDb sees the latest version.
 */
function updateMessage(editedMessage) {
  if (!editedMessage?.chat?.id || !editedMessage?.message_id) return;

  const chatId = String(editedMessage.chat.id);
  const buf = _buffers.get(chatId);
  let inBuffer = false;
  if (buf) {
    const idx = buf.findIndex((m) => m.message_id === editedMessage.message_id);
    if (idx >= 0) {
      buf[idx] = editedMessage;
      inBuffer = true;
    }
  }

  // Mirror to DB — upsert overwrites the prior row's message_json column.
  // Done even when not in buffer (e.g. message aged out of the in-memory
  // window but is still in DB for a future /replay or hydrate).
  if (_supabase) {
    _supabase.from("message_buffer").upsert({
      chat_id:      Number(chatId),
      message_id:   editedMessage.message_id,
      message_json: editedMessage,
    }, { onConflict: "chat_id,message_id" }).then(({ error }) => {
      if (error) console.error("[messageBuffer] edit persist error:", error.message);
    });
  }
  const preview = (editedMessage.text || editedMessage.caption || "").slice(0, 60).replace(/\n/g, " ");
  console.log(`[messageBuffer] ✏️ edit: chat=${chatId} msg=${editedMessage.message_id} buffer=${inBuffer ? "yes" : "no"} preview="${preview}"`);
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
 * Pull the SHARED caption candidate from the message immediately before
 * the brief (preceding[preceding.length - 1]). Returns the trimmed text
 * iff it qualifies as IG caption copy, else null. Rules:
 *   - non-empty
 *   - not a label (doesn't end with "^")
 *   - not a previous-ad brief (no "PAGE INFO"/"INSTRUCTIONS:" markers)
 *
 * Used by all three bundle scanners — the convention is the same
 * regardless of attribution format: Danielson types the IG caption
 * once, right above the brief, and every page's IG Ads chat should
 * receive it.
 */
function _extractSharedCaption(preceding) {
  if (preceding.length === 0) return null;
  const last = preceding[preceding.length - 1];
  const text = (last.text || "").trim();
  const hasMedia = !!(last.photo || last.video || last.document ||
                      last.animation || last.audio || last.sticker);
  if (hasMedia) return null;
  if (!text) return null;
  if (text.endsWith("^")) return null;
  if (_looksLikePreviousBrief(text)) return null;
  return text;
}

/**
 * Scan backwards from the ad message and group preceding content into
 * per-page bundles based on text label messages ending with "^".
 *
 * Label format: "PageHandle^"   e.g. "Thefuck.tv^"  "Childhoodpost^"
 *
 * The scan walks back through the buffer and collects media messages,
 * assigning them to the most recent label seen while going backwards.
 * Media that isn't followed by any label going backwards = unattributed,
 * gets collected into the SHARED bundle so every page receives it
 * (matches the team's "shared slides for ALL pages" convention).
 *
 * Returns `{ byHandle, shared }` where:
 *   - byHandle: Map<handle, { media, caption }> — per-page attributed
 *   - shared:   { media, caption } — content every page should get
 *
 * Returns `{ byHandle: new Map(), shared: { media: [], caption: null } }`
 * if no labels found — caller decides whether to use standard fallback.
 *
 * @param {string} chatId
 * @param {number} adMessageId
 * @returns {{ byHandle: Map<string, {media:Array, caption:string|null}>, shared: {media:Array, caption:string|null} }}
 */
function getContentBundlesByPage(chatId, adMessageId) {
  const buf = _buffers.get(String(chatId)) || [];
  const adIdx = buf.findIndex((m) => m.message_id === adMessageId);

  // Messages before the ad (oldest … newest, not including the ad itself)
  // If the ad wasn't found in the buffer, return empty — never scan random buffer contents.
  if (adIdx <= 0) return { byHandle: new Map(), shared: { media: [], caption: null } };
  const preceding = buf.slice(0, adIdx);

  const byHandle = new Map();
  const sharedMedia = []; // media not claimed by any label going backwards
  const sharedSeen  = new Set(); // (file_name, file_size) keys for dedup
  let pendingContent = []; // media collected since the last label (going backwards)
  // Pending label info for label-AFTER-media convention. When we encounter
  // a label with no preceding media, the next media we see (going backwards)
  // belongs to that label. Generalized from the old @story-only flag to
  // support any handle — Danny's FashionNova format puts every per-page
  // label AFTER its video.
  //
  //   { kind: "story"   } → next media routes to sharedMedia
  //   { kind: "handle", handle: "thefuck.tv", caption: null|"..." } → next media goes to byHandle
  let pendingLabel = null;
  // First non-label non-media text encountered going backwards. This is
  // the shared IG caption — captured inline rather than via a separate
  // _extractSharedCaption call so it works even when intervening labels
  // / media sit between the caption and the brief (Danny's layout:
  // caption → IMG_3286 → Story ^ → brief). Only the FIRST match wins —
  // anything older is treated as ad chatter and ignored.
  let sharedCaption = null;

  for (let i = preceding.length - 1; i >= 0; i--) {
    const msg  = preceding[i];
    const text = (msg.text || "").trim();
    const hasMedia = !!(
      msg.photo || msg.video || msg.document ||
      msg.animation || msg.audio || msg.sticker
    );

    // A label message: text-only, non-empty, ends with "^", AND either:
    //   (a) starts with "@" — a per-page handle, e.g. "@thefuck.tv ^"
    //   (b) is exactly "story ^" or "stories ^" (case-insensitive) — the
    //       legacy story-shared annotation used by FashionNova-style
    //       briefs. No "@" prefix in the operator's convention.
    //
    // The @-prefix requirement on case (a) is load-bearing — without it,
    // operator annotations like "Covers for ALL ^" or "13 slides ^"
    // get parsed as labels for a fake "@covers"/"@13" handle and drag
    // preceding media into a phantom page bundle. Case (b) is the one
    // legitimate exception (story/stories is a SHARED bundle so the
    // dragging behavior is correct), allowlisted explicitly.
    const isStoryAnnotation = /^(stor(?:y|ies))\s*\^$/i.test(text);
    const isLabel = !hasMedia && text.endsWith("^") && text.length > 1 &&
      (text.startsWith("@") || isStoryAnnotation);

    if (isLabel) {
      // Label format options:
      //   "@thefuck.tv ^"                              → handle only
      //   "@thefuck.tv NEO just dropped! Read bio ^"   → handle + per-page caption
      //   "@story ^" / "@stories ^"                    → SHARED bundle (special)
      //
      // First token (sans @, lowercased) is the handle. Anything between
      // handle and trailing ^ becomes the per-page caption text.
      const labelText = text.slice(0, -1).trim();
      const firstSpace = labelText.search(/\s/);
      const handlePart = (firstSpace === -1 ? labelText : labelText.slice(0, firstSpace))
        .toLowerCase().replace(/^@/, "");
      const captionPart = firstSpace === -1 ? null : labelText.slice(firstSpace + 1).trim() || null;
      const isStory = handlePart === "story" || handlePart === "stories";

      // Pick label-before vs label-after by inspecting pendingContent at
      // moment of encounter:
      //   - pendingContent has stuff → label-BEFORE-media. Flush pending
      //     into this label.
      //   - pendingContent is empty → label-AFTER-media. Remember this
      //     label as pending; the next media we walk into belongs to it.
      if (pendingContent.length > 0) {
        if (isStory) {
          // Dedupe — these are appended to sharedMedia going chronologically
          for (const m of pendingContent) {
            const k = _mediaKey(m);
            if (k && sharedSeen.has(k)) continue;
            if (k) sharedSeen.add(k);
            sharedMedia.push(m);
          }
        } else {
          byHandle.set(handlePart, { media: [...pendingContent], caption: captionPart });
        }
        pendingContent = [];
      } else {
        pendingLabel = isStory
          ? { kind: "story" }
          : { kind: "handle", handle: handlePart, caption: captionPart };
      }

    } else if (hasMedia) {
      if (pendingLabel) {
        // The label we just walked past claims THIS media. Route directly
        // (per kind) instead of via pendingContent so a subsequent label
        // doesn't re-claim it.
        if (pendingLabel.kind === "story") {
          _addUniqueShared(sharedMedia, msg, sharedSeen);
        } else {
          const existing = byHandle.get(pendingLabel.handle) || { media: [], caption: null };
          existing.media.unshift(msg);
          // First label wins for the caption — don't overwrite if already set
          if (existing.caption == null) existing.caption = pendingLabel.caption;
          byHandle.set(pendingLabel.handle, existing);
        }
        pendingLabel = null;
      } else {
        // Content message — prepend so the final array stays chronological
        pendingContent.unshift(msg);
      }

    } else if (!text) {
      // Empty / service message — skip
      continue;

    } else if (_looksLikePreviousBrief(text)) {
      // Strong signal we've crossed into a previous ad — stop.
      // Anything still in pendingContent is from BEFORE the previous
      // brief; safer to drop than to attribute to the current ad.
      pendingContent = [];
      pendingLabel = null;
      break;

    } else {
      // Random text — could be the shared IG caption or just chatter.
      // Capture the FIRST one we see going backwards (closest to brief)
      // since that's the caption-slot by team convention. Older plain-text
      // messages are treated as chatter and ignored.
      if (sharedCaption == null) sharedCaption = text;
      continue;
    }
  }

  // Anything left in pendingContent at the end = media that appeared
  // before any label going backwards = chronologically OLDER than any
  // @story-flushed media already in sharedMedia. Prepend (with dedup)
  // to preserve chronological order in sharedMedia.
  for (const m of pendingContent) {
    const k = _mediaKey(m);
    if (k && sharedSeen.has(k)) continue;
    if (k) sharedSeen.add(k);
    sharedMedia.unshift(m);
  }

  return {
    byHandle,
    shared: {
      media:   sharedMedia,
      // Inline-captured caption wins over the legacy _extractSharedCaption
      // (which only looks at preceding[last]). When no inline caption was
      // found AND the immediately-preceding message qualifies, fall back to
      // _extractSharedCaption so simpler layouts still work.
      caption: sharedCaption || _extractSharedCaption(preceding),
    },
  };
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
  //
  // Separator between @handle and "invite:" is permissive — `[,\s]+`
  // matches any mix of commas + whitespace so all of these parse:
  //   "Host: @page, invite:"   — standard
  //   "Host: @page , invite:"  — extra space before comma (Connor's typo case)
  //   "Host: @page  invite:"   — no comma, just whitespace
  //   "Host: @page,\ninvite:"  — newline after comma
  // Pre-fix only the "@page," form parsed cleanly, so any operator typing
  // a space before the comma silently lost their whole host block's media
  // attribution.
  const HOST_RE = /^Host:\s*@([\w.]+)\s*[,\s]+\s*invite:\s*([\s\S]+)/i;

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
  const byHandle = new Map();
  for (const group of groups) {
    for (const { msg: hostMsg, handles } of group.hostMsgs) {
      // Order: video → caption text messages → host/invite message
      const toForward = [
        ...(group.video ? [group.video] : []),
        ...group.captionMsgs,
        hostMsg,
      ];
      for (const handle of handles) {
        byHandle.set(handle, { media: toForward, caption: null });
      }
    }
  }

  // Collab doesn't use the "shared slides for ALL" media pattern (all
  // collab content routes through Host/invite blocks), but Danielson
  // DOES still type a shared IG caption right above the brief — same
  // convention as label / filename / standard formats. Capture it so
  // every collab destination chat gets the caption alongside the
  // per-page video + host message.
  return {
    byHandle,
    shared: { media: [], caption: _extractSharedCaption(preceding) },
  };
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
 * Media WITHOUT an @-filename in the same scan window (e.g. shared
 * "slides 2-4" videos) is collected into the SHARED bundle so every
 * page receives it.
 *
 * Returns `{ byHandle, shared }` or null when nothing filename-
 * attributed was found (signals the caller to try the next scanner).
 *
 * Stops scanning at any text that looks like a previous ad brief.
 *
 * @param {string} chatId
 * @param {number} adMessageId
 * @returns {{ byHandle: Map<string, {media:Array, caption:string|null}>, shared: {media:Array, caption:string|null} }|null}
 */
function getFilenameBundlesByPage(chatId, adMessageId) {
  const buf = _buffers.get(String(chatId)) || [];
  const adIdx = buf.findIndex((m) => m.message_id === adMessageId);
  if (adIdx <= 0) return null;
  const preceding = buf.slice(0, adIdx);

  const byHandle = new Map();
  const sharedMedia = []; // chronological — collected newest-first then reversed below
  const sharedSeen  = new Set(); // (file_name, file_size) keys for dedup
  let foundAny = false;

  // A "handle list" message is a standalone text containing ONLY @-handles
  // (whitespace-separated, nothing else). Danielson uses this to attach a
  // single un-named cover to multiple pages, e.g.:
  //
  //    IMG_3190.JPG
  //    @memedwyd @greatestmediamoments @popdownload
  //
  // The list applies to the immediately-preceding (chronologically) media
  // when that media has no @-filename of its own. Walking backwards, we
  // see the list first, set pendingHandleList, and apply it to the next
  // unfilenamed media we encounter.
  //
  // Cleared when: (a) consumed by a media, (b) interrupted by any other
  // text, (c) we hit a previous-brief boundary.
  const HANDLE_LIST_RE = /^(@[\w.]+(?:\s+|$))+$/;
  // Per-page label syntax: "@goal ^" attributes the next media (going
  // backwards = chronologically preceding) to @goal. Same semantic as a
  // handle list, but ending in ^. Catches mixed-format briefs where
  // most pages use @<handle>.jpg filenames but ONE page (e.g. @goal in
  // a sport-split Stake brief) gets per-page assets via label. Without
  // this, the filename scanner saw the 12 @-named covers, declared
  // useFilenames=true, and the label scanner (which DOES recognize ^
  // labels) never ran — @goal ended up absent from byHandle and
  // ambiguity detection paused the brief.
  //
  // Format: "@<handle> ^" — single handle, trailing ^. Matches loosely
  // to tolerate "@goal^" (no space) too, since operators have used both.
  const HANDLE_LABEL_RE = /^@([\w.]+)\s*\^$/;
  let pendingHandleList = null;

  function _addHandleEntry(handle, msg) {
    // Capture any caption attached to the media itself (Telegram's
    // .caption field on a photo/video/doc message). Mirrors what the
    // @-filename branch does so label-attributed media also get their
    // per-page caption forwarded. Without this, GOAL TEMPLATE png 2's
    // "Kevin De Bruyne... Odds by @stake" caption would be dropped.
    const mediaCaption = (msg.caption || "").trim() || null;
    if (!byHandle.has(handle)) {
      byHandle.set(handle, { media: [msg], caption: mediaCaption });
    } else {
      const entry = byHandle.get(handle);
      entry.media.unshift(msg);
      // First non-null caption wins (closest to brief going backwards).
      if (!entry.caption && mediaCaption) entry.caption = mediaCaption;
    }
  }

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
        if (!byHandle.has(handle)) {
          byHandle.set(handle, { media: [msg], caption: mediaCaption });
        } else {
          // Multiple files for the same page — keep chronological order
          // and prefer the most recent non-null caption (first iteration =
          // newest since we're walking backwards).
          const entry = byHandle.get(handle);
          entry.media.unshift(msg);
          if (!entry.caption && mediaCaption) entry.caption = mediaCaption;
        }
        foundAny = true;
        pendingHandleList = null; // filename attribution wins; list discarded
      } else if (pendingHandleList) {
        // Unnamed media with a handle-list waiting for it → attribute to
        // every handle in the list. Same cover sent to N pages.
        for (const h of pendingHandleList) _addHandleEntry(h, msg);
        foundAny = true;
        pendingHandleList = null;
      } else {
        // Media without an @-filename and no handle-list → shared bundle
        // (e.g. slides 2-4 for all pages). Collect newest-first; we'll
        // reverse at the end to restore chronological order. Dedup by
        // (file_name, file_size) — drops repeat uploads of the same file.
        _addUniqueShared(sharedMedia, msg, sharedSeen);
      }

    } else if (!text) {
      continue; // empty / service
    } else if (_looksLikePreviousBrief(text)) {
      // Strong "previous ad" signal — stop here. Drop sharedMedia
      // collected up to now, those came from before the previous brief.
      sharedMedia.length = 0;
      sharedSeen.clear();
      pendingHandleList = null;
      break;
    } else if (HANDLE_LIST_RE.test(text)) {
      // Set pending; will attribute the next media we encounter (going
      // backwards = chronologically before this text). Replace any
      // previous pending — only the closest list applies to a cover.
      pendingHandleList = (text.match(/@([\w.]+)/g) || [])
        .map((h) => h.slice(1).toLowerCase());
    } else if (HANDLE_LABEL_RE.test(text)) {
      // "@goal ^" / "@goal^" — single-handle label-AFTER syntax.
      // Set pending; the next media (going backwards) attributes to
      // this handle. Same accumulation rule as HANDLE_LIST_RE: cleared
      // after one media consumes it, or on any non-matching text.
      const m = text.match(HANDLE_LABEL_RE);
      pendingHandleList = [m[1].toLowerCase()];
    } else {
      // Caption text, "13 Covers ^" annotation, admin chatter — skip and
      // keep scanning. An intervening non-handle-list text invalidates
      // any pending list so we don't attribute a cover to handles that
      // weren't actually adjacent.
      pendingHandleList = null;
      continue;
    }
  }

  if (!foundAny) return null;

  return {
    byHandle,
    shared: {
      media: sharedMedia,
      caption: _extractSharedCaption(preceding),
    },
  };
}

function clearBufferUpTo(chatId, upToMessageId) {
  const buf = _buffers.get(String(chatId));
  if (buf) {
    const idx = buf.findIndex((m) => m.message_id === upToMessageId);
    if (idx >= 0) {
      // Remove everything up to and including the ad message
      buf.splice(0, idx + 1);
    }
  }

  // Mirror the prune to DB so a restart doesn't re-hydrate stale content.
  // Fire-and-forget; in-memory state is the source of truth at runtime.
  if (_supabase) {
    _supabase.from("message_buffer")
      .delete()
      .eq("chat_id", Number(chatId))
      .lte("message_id", upToMessageId)
      .then(({ error }) => {
        if (error) console.error("[messageBuffer] prune error:", error.message);
      });
  }
}

/**
 * Return the raw buffer for a chat — used by /replay to scan past
 * messages for a brief matching a campaign name. Caller-side is
 * responsible for parsing each candidate.
 */
function getMessages(chatId) {
  return _buffers.get(String(chatId)) || [];
}

/**
 * Last-resort scanner for ads with NO attribution (no @<handle>.jpg
 * filenames, no @page ^ labels, no Host: collab markers — just plain
 * IMG_XXXX.PNG files like Danny posts).
 *
 * Was previously handled inline in adHandler.js by grabbing the last
 * 4 preceding messages, which silently dropped slides 1-5 of any 6+
 * slide carousel. Now walks backwards collecting ALL preceding media
 * until it hits a previous brief — handles carousels of any length.
 *
 * Returns the same `{ byHandle, shared }` shape as the other scanners
 * for forwarder symmetry. byHandle is always empty (no attribution by
 * definition) — everything goes to shared, where every page receives
 * the same set of media + caption.
 *
 * @param {string} chatId
 * @param {number} adMessageId
 * @returns {{ byHandle: Map<string, {media:Array, caption:string|null}>, shared: {media:Array, caption:string|null} }}
 */
function getStandardBundle(chatId, adMessageId) {
  const buf = _buffers.get(String(chatId)) || [];
  const adIdx = buf.findIndex((m) => m.message_id === adMessageId);
  if (adIdx <= 0) return { byHandle: new Map(), shared: { media: [], caption: null } };
  const preceding = buf.slice(0, adIdx);

  const sharedMedia = [];
  const sharedSeen  = new Set(); // (file_name, file_size) keys — dedup

  // Walk backwards from the message just before the brief. Collect media,
  // skip non-brief text (admin chatter, captions, annotations like
  // "8 covers ^"), stop hard if we encounter a previous ad brief.
  // Dedup by (file_name, file_size) so the same upload posted twice
  // doesn't show up as two separate covers in /resolve.
  for (let i = preceding.length - 1; i >= 0; i--) {
    const msg  = preceding[i];
    const text = (msg.text || "").trim();
    const hasMedia = !!(
      msg.photo || msg.video || msg.document ||
      msg.animation || msg.audio || msg.sticker
    );

    if (hasMedia) {
      _addUniqueShared(sharedMedia, msg, sharedSeen);
      continue;
    }
    if (!text) continue;
    if (_looksLikePreviousBrief(text)) break;
    // Random non-brief text (caption, annotation, chatter) — skip but keep scanning
  }

  return {
    byHandle: new Map(),
    shared: {
      media:   sharedMedia,
      caption: _extractSharedCaption(preceding),
    },
  };
}

module.exports = {
  addMessage,
  updateMessage,
  getPrecedingMessages,
  getContentBundlesByPage,
  getCollabBundlesByPage,
  getFilenameBundlesByPage,
  getStandardBundle,
  getMessages,
  clearBufferUpTo,
  hydrateFromDb,
  MAX_BUFFER_PER_CHAT,
};
