/**
 * lib/sessions.js
 * Supabase-backed wizard session storage.
 *
 * Replaces the in-memory `sessions` Map in wizard.js so pending ad submissions
 * survive Railway redeploys. One row per user per active session.
 *
 * Schema lives in migrations/001_ad_pipeline.sql.
 */

const { createClient } = require("@supabase/supabase-js");

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("[sessions] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — session persistence disabled");
}

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

/**
 * Find the active (status='pending') ad_session for a user.
 * Returns null if none.
 */
async function loadSession(userId) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("ad_sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[sessions] loadSession error:", error.message);
    return null;
  }
  return data || null;
}

/**
 * Create a new session for a user.
 * @param {object} fields  { user_id, source, step, payload?, trusted? }
 * @returns {object|null} the new session row
 */
async function createSession({ userId, source, step = "client", payload = {}, trusted = false }) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("ad_sessions")
    .insert({
      user_id: userId,
      source,
      step,
      payload,
      trusted,
      status: "pending",
    })
    .select()
    .single();
  if (error) {
    console.error("[sessions] createSession error:", error.message);
    return null;
  }
  return data;
}

/**
 * Patch an existing session. `updates` can include `step`, `payload`, `status`,
 * `cancel_until`, `approval_msg`. Merges payload at top level if present.
 */
async function updateSession(sessionId, updates) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("ad_sessions")
    .update(updates)
    .eq("id", sessionId)
    .select()
    .single();
  if (error) {
    console.error("[sessions] updateSession error:", error.message);
    return null;
  }
  return data;
}

/**
 * Convenience: merge a partial object into payload without overwriting other keys.
 */
async function mergePayload(sessionId, partial) {
  if (!supabase) return null;
  // Read current payload, merge in JS, write back. Avoid jsonb_set complexity.
  const { data: current, error: readErr } = await supabase
    .from("ad_sessions")
    .select("payload")
    .eq("id", sessionId)
    .single();
  if (readErr) {
    console.error("[sessions] mergePayload read error:", readErr.message);
    return null;
  }
  const merged = { ...(current?.payload || {}), ...partial };
  return updateSession(sessionId, { payload: merged });
}

async function expireSession(sessionId) {
  return updateSession(sessionId, { status: "expired" });
}

async function cancelSession(sessionId) {
  return updateSession(sessionId, { status: "cancelled" });
}

async function markSent(sessionId) {
  return updateSession(sessionId, { status: "sent" });
}

/**
 * Insert a creative row tied to a session. For per-page bulk submissions.
 */
async function addCreative(sessionId, { pageHandle, mediaUrl, mediaType, headline, metadata }) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("ad_creatives")
    .insert({
      session_id: sessionId,
      page_handle: pageHandle.toLowerCase().replace(/^@/, ""),
      media_url: mediaUrl,
      media_type: mediaType,
      headline: headline || null,
      metadata: metadata || null,
    })
    .select()
    .single();
  if (error) {
    console.error("[sessions] addCreative error:", error.message);
    return null;
  }
  return data;
}

/**
 * List creatives for a session (used when posting to send each page its content).
 */
async function getCreatives(sessionId) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("ad_creatives")
    .select("*")
    .eq("session_id", sessionId);
  if (error) {
    console.error("[sessions] getCreatives error:", error.message);
    return [];
  }
  return data || [];
}

/**
 * Insert a posted_ads row when an ad is sent — used later when VA pastes IG URL.
 */
async function recordPostedAd({ pageHandle, clientName, sessionId, submittedBy, masterSheetRow, durationMs }) {
  if (!supabase) return null;
  const expiresAt = durationMs ? new Date(Date.now() + durationMs).toISOString() : null;
  const { data, error } = await supabase
    .from("posted_ads")
    .insert({
      page_handle: pageHandle.toLowerCase().replace(/^@/, ""),
      client_name: clientName,
      ad_session_id: sessionId || null,
      submitted_by: submittedBy,
      master_sheet_row: masterSheetRow || null,
      duration_ms: durationMs || null,
      expires_at: expiresAt,
      status: "scheduled",
    })
    .select()
    .single();
  if (error) {
    console.error("[sessions] recordPostedAd error:", error.message);
    return null;
  }
  return data;
}

/**
 * Find scheduled posted_ads matching a user. If pageHandle given, narrows to that.
 * Returns most recent first, capped at limit.
 */
async function findScheduledByUser(userId, { pageHandle = null, limit = 5 } = {}) {
  if (!supabase) return [];
  let q = supabase
    .from("posted_ads")
    .select("*")
    .eq("submitted_by", userId)
    .eq("status", "scheduled")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (pageHandle) q = q.eq("page_handle", pageHandle.toLowerCase().replace(/^@/, ""));
  const { data, error } = await q;
  if (error) {
    console.error("[sessions] findScheduledByUser error:", error.message);
    return [];
  }
  return data || [];
}

/**
 * Find scheduled posted_ads regardless of who submitted them (for VAs marking other people's ads live).
 */
async function findScheduledByHandle(pageHandle, { limit = 5 } = {}) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("posted_ads")
    .select("*")
    .eq("page_handle", pageHandle.toLowerCase().replace(/^@/, ""))
    .eq("status", "scheduled")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("[sessions] findScheduledByHandle error:", error.message);
    return [];
  }
  return data || [];
}

/**
 * Mark a posted_ad as live, recording the IG URL + post ID.
 */
async function markPostedLive(postedAdId, { igUrl, igPostId }) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("posted_ads")
    .update({
      status: "live",
      ig_url: igUrl,
      ig_post_id: igPostId,
      posted_at: new Date().toISOString(),
    })
    .eq("id", postedAdId)
    .select()
    .single();
  if (error) {
    console.error("[sessions] markPostedLive error:", error.message);
    return null;
  }
  return data;
}

module.exports = {
  loadSession,
  createSession,
  updateSession,
  mergePayload,
  expireSession,
  cancelSession,
  markSent,
  addCreative,
  getCreatives,
  recordPostedAd,
  findScheduledByUser,
  findScheduledByHandle,
  markPostedLive,
  _supabase: supabase, // exposed for direct queries if needed
};
