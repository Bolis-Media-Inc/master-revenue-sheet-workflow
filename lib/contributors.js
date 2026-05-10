/**
 * lib/contributors.js
 *
 * Sales-contributor membership + review flow for the /ad and /bulk
 * wizards. A contributor is an external person allowed to run /ad in
 * Greg DM, but their submissions don't fire directly into Internal
 * Network Ads — they queue in SALES_TEAM_CHAT_ID for the core sales
 * team to approve.
 *
 * Storage: sales_contributors table on Bolis Command Center DB
 *   telegram_id (BIGINT PK) + display_name + granted_by + granted_at
 *   + is_active + notes
 *
 * Lookups are cached in-memory with a 5-minute TTL since membership
 * changes rarely. clearCache() is exposed for the /addcontributor /
 * /removecontributor commands so the new state takes effect immediately.
 */

const sessions = require("./sessions");

const CACHE_TTL_MS = 5 * 60 * 1000;
const _cache = new Map(); // telegramId → { row, fetchedAt }   (row=null when not a contributor)

function _normHandle(h) {
  return String(h || "").trim().replace(/^@/, "").toLowerCase();
}

/**
 * Fetch a contributor row (with allowed_pages) by Telegram user_id.
 * Returns null when not a contributor or inactive. Cached for 5min.
 *
 * Use this when you need allowed_pages or other fields. For a simple
 * yes/no membership check, isContributor() is the convenience wrapper.
 */
async function getContributor(telegramId) {
  if (!telegramId) return null;
  if (!sessions._supabase) return null;
  const id = Number(telegramId);
  if (!Number.isFinite(id)) return null;

  const cached = _cache.get(id);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.row;
  }

  const { data, error } = await sessions._supabase
    .from("sales_contributors")
    .select("telegram_id, display_name, granted_by, granted_at, is_active, notes, allowed_pages")
    .eq("telegram_id", id)
    .maybeSingle();
  if (error) {
    console.error("[contributors] getContributor error:", error.message);
    return null;
  }
  const row = (data && data.is_active) ? {
    telegramId:   data.telegram_id,
    displayName:  data.display_name,
    grantedBy:    data.granted_by,
    grantedAt:    data.granted_at,
    notes:        data.notes,
    // Normalize to lowercase, strip @, drop empties. NULL stays NULL
    // (= unrestricted); empty array also means unrestricted.
    allowedPages: Array.isArray(data.allowed_pages)
      ? data.allowed_pages.map(_normHandle).filter(Boolean)
      : null,
  } : null;
  _cache.set(id, { row, fetchedAt: Date.now() });
  return row;
}

/**
 * True if the given Telegram user_id is an active sales contributor.
 * Falls back to false (not a contributor → core sales path) on any DB
 * error so a Supabase outage doesn't gate Connor and the regular sales
 * team out of /ad.
 */
async function isContributor(telegramId) {
  const row = await getContributor(telegramId);
  return !!row;
}

/**
 * Returns { allowed: boolean, denied: string[] } for a list of page
 * handles. allowed=true when every handle is permitted (or contributor
 * has no restriction). denied lists the handles that aren't authorized
 * — empty when allowed=true.
 *
 * Pass `contributor` (already-loaded row) when you have it to avoid
 * a second DB hit; otherwise call getContributor first.
 */
function isAllowedForPages(contributor, handles) {
  if (!contributor) return { allowed: false, denied: handles.map(_normHandle) };
  // No restriction = unrestricted access
  if (!contributor.allowedPages || contributor.allowedPages.length === 0) {
    return { allowed: true, denied: [] };
  }
  const allowedSet = new Set(contributor.allowedPages);
  const denied = (handles || [])
    .map(_normHandle)
    .filter((h) => h && !allowedSet.has(h));
  return { allowed: denied.length === 0, denied };
}

/**
 * Add a contributor. Caller must already have verified the granter has
 * permission.
 *
 * `allowedPages`: null/undefined = unrestricted; otherwise an array of
 * page handles (lowercased, no @) the contributor is scoped to.
 */
async function addContributor({ telegramId, displayName, grantedBy, notes = null, allowedPages = null }) {
  if (!sessions._supabase) return { ok: false, error: "Supabase not configured" };
  const id = Number(telegramId);
  if (!Number.isFinite(id)) return { ok: false, error: "invalid telegram_id" };

  const allowed = Array.isArray(allowedPages) && allowedPages.length > 0
    ? Array.from(new Set(allowedPages.map(_normHandle).filter(Boolean)))
    : null;

  const { error } = await sessions._supabase
    .from("sales_contributors")
    .upsert({
      telegram_id:   id,
      display_name:  displayName || null,
      granted_by:    grantedBy ? Number(grantedBy) : null,
      granted_at:    new Date().toISOString(),
      is_active:     true,
      notes,
      allowed_pages: allowed,
    }, { onConflict: "telegram_id" });

  if (error) return { ok: false, error: error.message };
  _cache.delete(id);
  return { ok: true };
}

/**
 * Set or clear a contributor's allowed_pages. Pass null/undefined or an
 * empty array to clear the restriction (= unrestricted access).
 * Returns { ok, error?, row? }.
 */
async function setAllowedPages(telegramId, allowedPages) {
  if (!sessions._supabase) return { ok: false, error: "Supabase not configured" };
  const id = Number(telegramId);
  if (!Number.isFinite(id)) return { ok: false, error: "invalid telegram_id" };

  const allowed = Array.isArray(allowedPages) && allowedPages.length > 0
    ? Array.from(new Set(allowedPages.map(_normHandle).filter(Boolean)))
    : null;

  const { data, error } = await sessions._supabase
    .from("sales_contributors")
    .update({ allowed_pages: allowed })
    .eq("telegram_id", id)
    .eq("is_active", true)
    .select()
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "contributor not found or inactive" };
  _cache.delete(id);
  return { ok: true, row: data };
}

/**
 * Soft-remove a contributor (sets is_active = false). Their existing
 * pending_review sessions stay intact; only future /ad submissions
 * stop going to review.
 */
async function removeContributor(telegramId) {
  if (!sessions._supabase) return { ok: false, error: "Supabase not configured" };
  const id = Number(telegramId);
  if (!Number.isFinite(id)) return { ok: false, error: "invalid telegram_id" };

  const { data, error } = await sessions._supabase
    .from("sales_contributors")
    .update({ is_active: false })
    .eq("telegram_id", id)
    .select("telegram_id, display_name");
  if (error) return { ok: false, error: error.message };
  _cache.delete(id);
  return { ok: true, removed: data?.[0] || null };
}

/**
 * List all active contributors. Returns array of rows.
 */
async function listContributors() {
  if (!sessions._supabase) return [];
  const { data, error } = await sessions._supabase
    .from("sales_contributors")
    .select("*")
    .eq("is_active", true)
    .order("granted_at", { ascending: false });
  if (error) {
    console.error("[contributors] list error:", error.message);
    return [];
  }
  return data || [];
}

function clearCache(telegramId = null) {
  if (telegramId) _cache.delete(Number(telegramId));
  else _cache.clear();
}

// ── Username-based pending invites ─────────────────────────────────────────
// Admin grants by @username before the contributor has DM'd Greg. Stored
// in sales_contributor_invites; auto-materialized into sales_contributors
// when the user's first message arrives (we have their telegram_id then).

function _normUsername(u) {
  return String(u || "").trim().replace(/^@/, "").toLowerCase();
}

/**
 * Create a pending invite by username. If the user has already DM'd Greg
 * (their telegram_id is known), the caller should use addContributor()
 * directly — invites are only for the unseen-user case.
 */
async function createInvite({ username, displayName, grantedBy, allowedPages = null, notes = null }) {
  if (!sessions._supabase) return { ok: false, error: "Supabase not configured" };
  const u = _normUsername(username);
  if (!u) return { ok: false, error: "username required" };

  const allowed = Array.isArray(allowedPages) && allowedPages.length > 0
    ? Array.from(new Set(allowedPages.map(_normHandle).filter(Boolean)))
    : null;

  const { error } = await sessions._supabase
    .from("sales_contributor_invites")
    .upsert({
      username:       u,
      display_name:   displayName || null,
      granted_by:     grantedBy ? Number(grantedBy) : null,
      granted_at:     new Date().toISOString(),
      allowed_pages:  allowed,
      notes,
    }, { onConflict: "username" });

  if (error) return { ok: false, error: error.message };
  return { ok: true, username: u };
}

/**
 * Try to materialize a pending invite for the given user. Called from
 * the bot's incoming-message middleware on every private-chat message
 * — fires only when the user has a username AND it matches an invite.
 *
 * Returns the materialized contributor row + the invite that was
 * consumed (so the caller can ping the grantor), or null if nothing
 * matched.
 */
async function tryConsumeInvite({ telegramId, username, displayName }) {
  if (!sessions._supabase) return null;
  const u = _normUsername(username);
  if (!u) return null;
  const id = Number(telegramId);
  if (!Number.isFinite(id)) return null;

  // Look up pending invite
  const { data: invite, error: readErr } = await sessions._supabase
    .from("sales_contributor_invites")
    .select("*")
    .eq("username", u)
    .maybeSingle();
  if (readErr || !invite) return null;

  // Materialize into sales_contributors
  const addResult = await addContributor({
    telegramId:   id,
    displayName:  displayName || invite.display_name || `@${u}`,
    grantedBy:    invite.granted_by,
    allowedPages: Array.isArray(invite.allowed_pages) ? invite.allowed_pages : null,
    notes:        invite.notes,
  });
  if (!addResult.ok) {
    console.error("[contributors] tryConsumeInvite addContributor failed:", addResult.error);
    return null;
  }

  // Delete the invite (idempotent — addContributor would re-grant if
  // the invite re-fires).
  await sessions._supabase
    .from("sales_contributor_invites")
    .delete()
    .eq("username", u);

  return { telegramId: id, username: u, invite };
}

/**
 * List all pending invites (for /listcontributors to show what's waiting).
 */
async function listInvites() {
  if (!sessions._supabase) return [];
  const { data, error } = await sessions._supabase
    .from("sales_contributor_invites")
    .select("*")
    .order("granted_at", { ascending: false });
  if (error) {
    console.error("[contributors] listInvites error:", error.message);
    return [];
  }
  return data || [];
}

async function deleteInvite(username) {
  if (!sessions._supabase) return { ok: false, error: "Supabase not configured" };
  const u = _normUsername(username);
  const { error } = await sessions._supabase
    .from("sales_contributor_invites")
    .delete()
    .eq("username", u);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

module.exports = {
  isContributor,
  getContributor,
  isAllowedForPages,
  addContributor,
  setAllowedPages,
  removeContributor,
  listContributors,
  clearCache,
  createInvite,
  tryConsumeInvite,
  listInvites,
  deleteInvite,
};
