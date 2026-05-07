/**
 * lib/digiClient.js
 * HTTP client for Greg → Digi calls (the reverse of lib/api.js which is
 * Digi → Greg).
 *
 * Currently used by the posted-ad marker (handlers/postedHandler.js) to
 * resolve an IG post URL to its metadata so we can correctly match it to
 * the scheduled ad.
 */

const DIGI_API_URL    = process.env.DIGI_API_URL;
const GREG_API_SECRET = process.env.GREG_API_SECRET || process.env.DIGI_API_SECRET;

/**
 * Resolve an Instagram post URL to its metadata.
 *
 * @param {string} url
 * @returns {Promise<{ ok: boolean, data?: object, error?: string }>}
 *
 * data shape: { username, caption, postId, postedAt, mediaType, mediaUrl, source }
 */
async function resolveIGPost(url) {
  if (!DIGI_API_URL || !GREG_API_SECRET) {
    return { ok: false, error: "DIGI_API_URL or GREG_API_SECRET not set" };
  }

  let res, body;
  try {
    res = await fetch(`${DIGI_API_URL.replace(/\/$/, '')}/api/ig/resolve`, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${GREG_API_SECRET}`,
      },
      body: JSON.stringify({ url }),
    });
    body = await res.json().catch(() => null);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  if (!res.ok) return { ok: false, error: body?.error || `HTTP ${res.status}` };
  return { ok: true, data: body };
}

module.exports = { resolveIGPost };
