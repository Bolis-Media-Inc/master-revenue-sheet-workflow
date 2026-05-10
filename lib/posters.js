/**
 * lib/posters.js
 *
 * Posters are people responsible for posting ads to Instagram. Distinct
 * from sales_contributors (who SUBMIT ads). The same person can be
 * registered as both. Posters show up in the /ad wizard's "Who's
 * responsible for posting?" step alongside the hardcoded core seniors,
 * so contributors / VAs can be picked there.
 *
 * Storage: posters + poster_invites tables on Bolis Command Center.
 * Mirrors the contributors module's pattern — admin-only grants,
 * username-based pending invites for users who haven't DM'd Greg yet,
 * page scoping via the `pages` array (NULL/empty = unrestricted).
 */

const sessions = require("./sessions");

const CACHE_TTL_MS = 5 * 60 * 1000;
const _byIdCache = new Map(); // telegram_id → { row, fetchedAt }
let _activeListCache = null;
let _activeListCacheAt = 0;

function _normHandle(h) {
  return String(h || "").trim().replace(/^@/, "").toLowerCase();
}
function _normUsername(u) {
  return String(u || "").trim().replace(/^@/, "").toLowerCase();
}

function _invalidateCaches() {
  _byIdCache.clear();
  _activeListCache = null;
  _activeListCacheAt = 0;
  // Refresh the sync cache opportunistically — wizard keyboards read it
  // synchronously and shouldn't lag a step behind a recent /addposter.
  refreshSyncCache().catch(() => {});
}

// ── Synchronous accessor (for the /ad wizard's keyboard builder) ──────────
// buildKeyboard() in wizard.js is sync, so it can't await listActive().
// We keep a parallel snapshot here, refreshed on a 5-min interval AND
// on every mutation. First-load primes from DB at module-require time.
let _syncCache = [];

function listActiveSync() {
  return _syncCache;
}

async function refreshSyncCache() {
  if (!sessions._supabase) return [];
  const { data, error } = await sessions._supabase
    .from("posters")
    .select("telegram_id, username, display_name, pages")
    .eq("is_active", true)
    .order("added_at", { ascending: false });
  if (error) {
    console.error("[posters] refreshSyncCache error:", error.message);
    return _syncCache;
  }
  _syncCache = data || [];
  return _syncCache;
}

// Prime + auto-refresh
refreshSyncCache().catch(() => {});
setInterval(() => { refreshSyncCache().catch(() => {}); }, 5 * 60 * 1000).unref();

/**
 * List all active posters with their display name + scope. Cached for
 * 5 minutes; the cache is busted on every add/remove/setPages so
 * changes show up immediately in the wizard's keyboard.
 */
async function listActive() {
  if (_activeListCache && Date.now() - _activeListCacheAt < CACHE_TTL_MS) {
    return _activeListCache;
  }
  if (!sessions._supabase) return [];
  const { data, error } = await sessions._supabase
    .from("posters")
    .select("telegram_id, display_name, pages, added_by, added_at, notes")
    .eq("is_active", true)
    .order("added_at", { ascending: false });
  if (error) {
    console.error("[posters] listActive error:", error.message);
    return [];
  }
  _activeListCache = data || [];
  _activeListCacheAt = Date.now();
  return _activeListCache;
}

async function getPoster(telegramId) {
  if (!telegramId || !sessions._supabase) return null;
  const id = Number(telegramId);
  if (!Number.isFinite(id)) return null;
  const cached = _byIdCache.get(id);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.row;

  const { data, error } = await sessions._supabase
    .from("posters")
    .select("*")
    .eq("telegram_id", id)
    .maybeSingle();
  if (error) {
    console.error("[posters] getPoster error:", error.message);
    return null;
  }
  const row = (data && data.is_active) ? data : null;
  _byIdCache.set(id, { row, fetchedAt: Date.now() });
  return row;
}

async function addPoster({ telegramId, username, displayName, addedBy, pages = null, notes = null }) {
  if (!sessions._supabase) return { ok: false, error: "Supabase not configured" };
  const id = Number(telegramId);
  if (!Number.isFinite(id)) return { ok: false, error: "invalid telegram_id" };

  const scope = Array.isArray(pages) && pages.length > 0
    ? Array.from(new Set(pages.map(_normHandle).filter(Boolean)))
    : null;

  // Username goes into the brief's seniors block — required so the
  // wizard's keyboard can render @username buttons. If we don't have
  // one (rare — operator's Telegram profile has no username), the
  // poster gets stored anyway but won't show up as a tappable button
  // in the wizard.
  const u = username ? _normUsername(username) : null;

  const { error } = await sessions._supabase
    .from("posters")
    .upsert({
      telegram_id:  id,
      username:     u,
      display_name: displayName || null,
      pages:        scope,
      added_by:     addedBy ? Number(addedBy) : null,
      added_at:     new Date().toISOString(),
      is_active:    true,
      notes,
    }, { onConflict: "telegram_id" });

  if (error) return { ok: false, error: error.message };
  _invalidateCaches();
  return { ok: true };
}

async function setPosterPages(telegramId, pages) {
  if (!sessions._supabase) return { ok: false, error: "Supabase not configured" };
  const id = Number(telegramId);
  if (!Number.isFinite(id)) return { ok: false, error: "invalid telegram_id" };
  const scope = Array.isArray(pages) && pages.length > 0
    ? Array.from(new Set(pages.map(_normHandle).filter(Boolean)))
    : null;
  const { data, error } = await sessions._supabase
    .from("posters")
    .update({ pages: scope })
    .eq("telegram_id", id)
    .eq("is_active", true)
    .select()
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "poster not found or inactive" };
  _invalidateCaches();
  return { ok: true, row: data };
}

async function removePoster(telegramId) {
  if (!sessions._supabase) return { ok: false, error: "Supabase not configured" };
  const id = Number(telegramId);
  if (!Number.isFinite(id)) return { ok: false, error: "invalid telegram_id" };
  const { data, error } = await sessions._supabase
    .from("posters")
    .update({ is_active: false })
    .eq("telegram_id", id)
    .select("telegram_id, display_name");
  if (error) return { ok: false, error: error.message };
  _invalidateCaches();
  return { ok: true, removed: data?.[0] || null };
}

// ── Username-invite pattern (mirrors contributors) ────────────────────────

async function createInvite({ username, displayName, addedBy, pages = null, notes = null }) {
  if (!sessions._supabase) return { ok: false, error: "Supabase not configured" };
  const u = _normUsername(username);
  if (!u) return { ok: false, error: "username required" };

  const scope = Array.isArray(pages) && pages.length > 0
    ? Array.from(new Set(pages.map(_normHandle).filter(Boolean)))
    : null;

  const { error } = await sessions._supabase
    .from("poster_invites")
    .upsert({
      username:     u,
      display_name: displayName || null,
      pages:        scope,
      added_by:     addedBy ? Number(addedBy) : null,
      added_at:     new Date().toISOString(),
      notes,
    }, { onConflict: "username" });
  if (error) return { ok: false, error: error.message };
  return { ok: true, username: u };
}

async function tryConsumeInvite({ telegramId, username, displayName }) {
  if (!sessions._supabase) return null;
  const u = _normUsername(username);
  if (!u) return null;
  const id = Number(telegramId);
  if (!Number.isFinite(id)) return null;

  const { data: invite, error: readErr } = await sessions._supabase
    .from("poster_invites")
    .select("*")
    .eq("username", u)
    .maybeSingle();
  if (readErr || !invite) return null;

  const addResult = await addPoster({
    telegramId:   id,
    username:     u,
    displayName:  displayName || invite.display_name || `@${u}`,
    addedBy:      invite.added_by,
    pages:        Array.isArray(invite.pages) ? invite.pages : null,
    notes:        invite.notes,
  });
  if (!addResult.ok) {
    console.error("[posters] tryConsumeInvite addPoster failed:", addResult.error);
    return null;
  }

  await sessions._supabase
    .from("poster_invites")
    .delete()
    .eq("username", u);

  return { telegramId: id, username: u, invite };
}

async function listInvites() {
  if (!sessions._supabase) return [];
  const { data, error } = await sessions._supabase
    .from("poster_invites")
    .select("*")
    .order("added_at", { ascending: false });
  if (error) {
    console.error("[posters] listInvites error:", error.message);
    return [];
  }
  return data || [];
}

async function deleteInvite(username) {
  if (!sessions._supabase) return { ok: false, error: "Supabase not configured" };
  const u = _normUsername(username);
  const { error } = await sessions._supabase
    .from("poster_invites")
    .delete()
    .eq("username", u);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

module.exports = {
  listActive,
  listActiveSync,
  refreshSyncCache,
  getPoster,
  addPoster,
  setPosterPages,
  removePoster,
  createInvite,
  tryConsumeInvite,
  listInvites,
  deleteInvite,
};
