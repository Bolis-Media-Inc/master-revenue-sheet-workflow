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
const _cache = new Map(); // telegramId → { isActive, fetchedAt }

/**
 * True if the given Telegram user_id is an active sales contributor.
 * Falls back to false (not a contributor → core sales path) on any DB
 * error so a Supabase outage doesn't gate Connor and the regular sales
 * team out of /ad.
 */
async function isContributor(telegramId) {
  if (!telegramId) return false;
  if (!sessions._supabase) return false;
  const id = Number(telegramId);
  if (!Number.isFinite(id)) return false;

  const cached = _cache.get(id);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.isActive;
  }

  const { data, error } = await sessions._supabase
    .from("sales_contributors")
    .select("telegram_id, is_active")
    .eq("telegram_id", id)
    .maybeSingle();
  if (error) {
    console.error("[contributors] isContributor error:", error.message);
    return false;
  }
  const isActive = !!(data?.is_active);
  _cache.set(id, { isActive, fetchedAt: Date.now() });
  return isActive;
}

/**
 * Add a contributor. Caller must already have verified the granter has
 * permission. Returns { ok, error? }.
 */
async function addContributor({ telegramId, displayName, grantedBy, notes = null }) {
  if (!sessions._supabase) return { ok: false, error: "Supabase not configured" };
  const id = Number(telegramId);
  if (!Number.isFinite(id)) return { ok: false, error: "invalid telegram_id" };

  const { error } = await sessions._supabase
    .from("sales_contributors")
    .upsert({
      telegram_id:  id,
      display_name: displayName || null,
      granted_by:   grantedBy ? Number(grantedBy) : null,
      granted_at:   new Date().toISOString(),
      is_active:    true,
      notes,
    }, { onConflict: "telegram_id" });

  if (error) return { ok: false, error: error.message };
  _cache.delete(id);
  return { ok: true };
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

module.exports = {
  isContributor,
  addContributor,
  removeContributor,
  listContributors,
  clearCache,
};
