/**
 * lib/igUrl.js
 * Instagram URL parsing utilities.
 *
 * Used by handlers/postedHandler.js to detect IG URLs in DMs and extract
 * the post ID + (where possible) the page handle.
 */

// All the Instagram URL patterns we care about
const IG_URL_RE = /https?:\/\/(?:www\.)?instagram\.com\/(?:([\w.]+)\/)?(p|reel|reels|tv)\/([\w-]+)/i;

// Profile URL patterns (e.g. https://instagram.com/thefuck.tv)
// We only fall back to these when there's no post URL — most cases we have a post link.
const IG_PROFILE_RE = /https?:\/\/(?:www\.)?instagram\.com\/([\w.]+)\/?(?:\?|$)/i;

/**
 * Extract post info from any Instagram URL.
 * Examples:
 *   https://www.instagram.com/p/Cabc123/                    → { postId: 'Cabc123', kind: 'p' }
 *   https://instagram.com/reel/Cabc123/                     → { postId: 'Cabc123', kind: 'reel' }
 *   https://instagram.com/thefuck.tv/p/Cabc123/             → { postId: 'Cabc123', kind: 'p', handleHint: 'thefuck.tv' }
 *   https://www.instagram.com/reels/Cabc123/?igsh=...        → { postId: 'Cabc123', kind: 'reels' }
 *
 * @param {string} text  Any text that may or may not contain an IG URL
 * @returns {{url: string, postId: string, kind: string, handleHint: string|null}|null}
 */
function extractIGPostInfo(text) {
  if (!text || typeof text !== 'string') return null;

  const m = text.match(IG_URL_RE);
  if (!m) return null;

  return {
    url:        m[0],
    handleHint: m[1] ? m[1].toLowerCase() : null, // page handle if present in URL path
    kind:       m[2].toLowerCase(),               // 'p' | 'reel' | 'reels' | 'tv'
    postId:     m[3],
  };
}

/**
 * Quick test: does this text contain ANY Instagram URL (including profile URLs)?
 * Used as a cheap pre-filter before calling extractIGPostInfo.
 */
function hasIGUrl(text) {
  if (!text || typeof text !== 'string') return false;
  return IG_URL_RE.test(text) || IG_PROFILE_RE.test(text);
}

/**
 * Extract a page handle from an inline @mention if the user typed
 * something like "https://instagram.com/p/abc @goal" to disambiguate.
 *
 * @param {string} text
 * @returns {string|null}  lowercased handle without leading @, or null
 */
function extractHandleMention(text) {
  if (!text) return null;
  const m = text.match(/@([\w.]+)/);
  return m ? m[1].toLowerCase() : null;
}

module.exports = { extractIGPostInfo, hasIGUrl, extractHandleMention };
