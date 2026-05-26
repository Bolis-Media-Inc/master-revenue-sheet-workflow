/**
 * lib/pages.js
 *
 * Single source of truth for the page registry (sheet IDs, Telegram chat
 * IDs, auto-forwarding gate). Replaces the dual-JSON setup
 * (config/pages.json + config/telegram-destinations.json) plus the
 * ENABLED_PAGES env var.
 *
 * Storage: `pages` table on Bolis Command Center Supabase. See
 * migrations/010_pages.sql for the schema.
 *
 * Read pattern: in-memory snapshot, refreshed from Supabase every 60s
 * and on every mutation. Sync accessors (getChatId, getSheetId,
 * getAutoForward) read from the snapshot so legacy callsites can swap
 * in without going async. JSON files are loaded at boot as a safety
 * net — if Supabase is unreachable, forwarding keeps working off the
 * file values.
 *
 * Write pattern: upsertPage / deletePage from the HTTP API (lib/api.js)
 * which the Digi /admin/pages UI calls.
 */

const sessions = require("./sessions");

// JSON fallbacks — loaded at boot, used to seed the snapshot before the
// first Supabase fetch resolves AND as a backup if Supabase is down.
let _pagesJson = {};
let _destsJson = {};
try { _pagesJson = require("../config/pages.json"); } catch (_) {}
try { _destsJson = require("../config/telegram-destinations.json"); } catch (_) {}

const REFRESH_MS = 60 * 1000;
let _byHandle = new Map(); // handle → { sheet_id, chat_id, auto_forward, display_name, notes }
let _forwardingDisabledGlobally = !!_destsJson._forwarding_disabled_globally;

function _norm(h) {
  return String(h || "").trim().toLowerCase().replace(/^@/, "");
}

function _seedFromJson() {
  const skip = (o) => Object.keys(o).filter((k) => !k.startsWith("_"));
  const next = new Map();
  for (const h of skip(_pagesJson)) {
    next.set(h, { handle: h, sheet_id: _pagesJson[h], chat_id: null, auto_forward: false });
  }
  for (const h of skip(_destsJson)) {
    const row = next.get(h) || { handle: h, sheet_id: null, auto_forward: false };
    row.chat_id = _destsJson[h];
    next.set(h, row);
  }
  _byHandle = next;
}

async function refresh() {
  if (!sessions._supabase) return;
  const { data, error } = await sessions._supabase
    .from("pages")
    .select("handle, sheet_id, chat_id, auto_forward, display_name, notes");
  if (error) {
    console.error("[pages] refresh error:", error.message);
    return;
  }
  if (!data || data.length === 0) {
    // DB empty — keep the JSON-seeded snapshot rather than wiping
    console.warn("[pages] refresh returned 0 rows — keeping JSON fallback snapshot");
    return;
  }
  const next = new Map();
  for (const row of data) next.set(row.handle, row);
  _byHandle = next;
}

// Sync accessors — drop-in replacements for `destinations[handle]` /
// `pages[handle]` lookups. Return null when missing so callers don't have
// to distinguish undefined from absent.
function getChatId(handle) {
  return _byHandle.get(_norm(handle))?.chat_id ?? null;
}
function getSheetId(handle) {
  return _byHandle.get(_norm(handle))?.sheet_id ?? null;
}
function getAutoForward(handle) {
  return !!_byHandle.get(_norm(handle))?.auto_forward;
}
function getPage(handle) {
  return _byHandle.get(_norm(handle)) || null;
}
function listAllSync() {
  return [..._byHandle.values()];
}
function knownHandles() {
  return [..._byHandle.keys()];
}
function isForwardingDisabledGlobally() {
  // Preserved from telegram-destinations.json._forwarding_disabled_globally
  // so callsites that consulted that flag keep working. Move to a DB
  // setting later if we ever flip it.
  return _forwardingDisabledGlobally;
}

// Async accessors — for the HTTP API / admin UI where freshness matters.
async function listAll() {
  if (!sessions._supabase) return listAllSync();
  const { data, error } = await sessions._supabase
    .from("pages")
    .select("*")
    .order("handle");
  if (error) {
    console.error("[pages] listAll error:", error.message);
    return listAllSync();
  }
  return data || [];
}

async function upsertPage({ handle, sheet_id, chat_id, auto_forward, display_name, notes, added_by }) {
  if (!sessions._supabase) return { ok: false, error: "Supabase not configured" };
  const h = _norm(handle);
  if (!h) return { ok: false, error: "handle required" };

  const row = { handle: h };
  if (sheet_id     !== undefined) row.sheet_id     = sheet_id || null;
  if (chat_id      !== undefined) row.chat_id      = chat_id != null && chat_id !== "" ? Number(chat_id) : null;
  if (auto_forward !== undefined) row.auto_forward = !!auto_forward;
  if (display_name !== undefined) row.display_name = display_name || null;
  if (notes        !== undefined) row.notes        = notes || null;
  if (added_by     !== undefined) row.added_by     = added_by ? Number(added_by) : null;

  const { data, error } = await sessions._supabase
    .from("pages")
    .upsert(row, { onConflict: "handle" })
    .select()
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  await refresh().catch(() => {});
  return { ok: true, row: data };
}

async function deletePage(handle) {
  if (!sessions._supabase) return { ok: false, error: "Supabase not configured" };
  const h = _norm(handle);
  const { error } = await sessions._supabase
    .from("pages")
    .delete()
    .eq("handle", h);
  if (error) return { ok: false, error: error.message };
  await refresh().catch(() => {});
  return { ok: true };
}

// Prime the snapshot from JSON immediately so getXxx() works on the
// first tick, then refresh from DB. Interval keeps it warm.
_seedFromJson();
refresh().catch(() => {});
setInterval(() => { refresh().catch(() => {}); }, REFRESH_MS).unref();

module.exports = {
  refresh,
  // Sync (snapshot-backed) — for legacy callsites
  getChatId,
  getSheetId,
  getAutoForward,
  getPage,
  listAllSync,
  knownHandles,
  isForwardingDisabledGlobally,
  // Async (DB-backed) — for the HTTP API
  listAll,
  upsertPage,
  deletePage,
};
