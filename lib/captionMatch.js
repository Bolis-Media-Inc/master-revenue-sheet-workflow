/**
 * lib/captionMatch.js
 * Scores how likely a candidate scheduled ad is the one that matches a
 * given Instagram post (resolved via Digi).
 *
 * Inputs per candidate:
 *   - the campaign's caption (what we sent in the brief)
 *   - the campaign's client name
 *   - the IG post's actual caption
 *   - times: when the ad was scheduled vs when it was posted
 *
 * Output: a numeric score (0..1). Higher = better match.
 *
 * The scoring is intentionally fuzzy — captions get edited, hashtags
 * change, links get added/removed. We need *plausible* match, not exact.
 */

/**
 * Tokenize a caption for similarity scoring.
 * - Lowercase, strip URLs, hashtags, @mentions, punctuation
 * - Keep meaningful words 3+ chars
 */
function tokenize(text) {
  if (!text || typeof text !== "string") return new Set();
  const cleaned = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#@][\w._]+/g, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return new Set(cleaned.split(" ").filter((w) => w.length >= 3));
}

/**
 * Jaccard similarity between two tokenized sets.
 */
function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Score a candidate ad against an IG post.
 *
 * @param {object} candidate
 * @param {string} candidate.brandedCaption  — what we asked the page to post
 * @param {string} candidate.clientName      — the campaign client (e.g. "OnlyFans Premium")
 * @param {Date}   candidate.scheduledAt     — when the ad was created (proxy for "expected post time")
 *
 * @param {object} igPost
 * @param {string} igPost.caption    — the actual IG caption (from BrightData/Digi)
 * @param {Date|null} igPost.postedAt
 *
 * @returns {{score: number, breakdown: object}}
 */
function scoreCandidate(candidate, igPost) {
  const igTokens   = tokenize(igPost.caption || "");
  const ourTokens  = tokenize(candidate.brandedCaption || "");
  const clientName = (candidate.clientName || "").toLowerCase();

  // 1. Caption similarity (Jaccard) — 60% of score
  const captionSim = jaccard(ourTokens, igTokens);

  // 2. Client name appears in IG caption — 25% of score
  const clientMatch = clientName && (igPost.caption || "").toLowerCase().includes(clientName) ? 1 : 0;

  // 3. Time proximity — 15% of score
  // Scheduled ads typically get posted within a few hours of scheduledAt.
  // Within 1h: 1.0, 1-6h: 0.7, 6-24h: 0.3, beyond: 0
  let timeScore = 0;
  if (igPost.postedAt && candidate.scheduledAt) {
    const diffMs = Math.abs(new Date(igPost.postedAt).getTime() - new Date(candidate.scheduledAt).getTime());
    const diffH  = diffMs / 3_600_000;
    if      (diffH <= 1)  timeScore = 1;
    else if (diffH <= 6)  timeScore = 0.7;
    else if (diffH <= 24) timeScore = 0.3;
  }

  const total = captionSim * 0.6 + clientMatch * 0.25 + timeScore * 0.15;

  return {
    score: total,
    breakdown: { captionSim, clientMatch, timeScore },
  };
}

/**
 * Pick the best-matching candidate from a list. Returns { match, score, alternatives }.
 *
 * High confidence (>= 0.55): auto-mark
 * Medium (0.3 .. 0.55):       show picker but pre-select top
 * Low (< 0.3):                show picker, no pre-select
 */
function pickBestMatch(candidates, igPost) {
  const scored = candidates.map((c) => ({
    candidate: c,
    ...scoreCandidate(c.matchInputs, igPost),
  }));
  scored.sort((a, b) => b.score - a.score);

  return {
    best:           scored[0] || null,
    alternatives:   scored.slice(1),
    autoMark:       scored[0]?.score >= 0.55,
    suggestPicker:  scored[0] && scored[0].score < 0.55,
  };
}

module.exports = { tokenize, jaccard, scoreCandidate, pickBestMatch };
