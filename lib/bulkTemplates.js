/**
 * lib/bulkTemplates.js
 *
 * Single source of truth for `config/bulks.json`. The Telegram wizard
 * (wizard.js) and the HTTP API (lib/api.js → /api/ad/intake) both go
 * through this module so they don't drift.
 *
 * File shape (one entry per template):
 *   {
 *     id, name, client, refPrefix, lastRefNum,
 *     adType, postType, duration, nif, seniors[],
 *     priceMode, format, pages[],
 *     perPagePrices: { handle: { price: "400", bulk: "13/15" } }
 *   }
 *
 * The `bulk: "N/M"` string per page tracks how many of M total slots
 * (purchased by the client) have been used so far. This module exposes
 * a two-phase API so the cancel window in poster.js can plan an advance
 * up front and only commit it after a successful post:
 *
 *   const plan = bulkTemplates.planAdvance("stake-bet-slips", ["dailyhumor_4u"]);
 *   // plan.perHandle = { dailyhumor_4u: { used: 14, total: 15, slot: "14/15" } }
 *   // (no disk write yet)
 *   ...
 *   bulkTemplates.commitAdvance(plan); // writes lastRefNum + per-page slots
 */

const fs   = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const BULKS_PATH = path.join(__dirname, "..", "config", "bulks.json");

// ── Supabase mirror ─────────────────────────────────────────────────────
// bulks.json on disk is the primary store (the Telegram wizard reads/writes
// it directly). After every write we push the same row(s) to Supabase
// `ad_bulks` so Digi web can read templates over HTTP.

const _supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

if (!_supabase) {
  console.warn("[bulkTemplates] SUPABASE_URL/SERVICE_ROLE_KEY not set — Supabase mirror disabled");
}

// ── Disk I/O (no in-memory cache: always read fresh, so writers from
//    different processes/handlers never observe stale data) ──────────────

function _read() {
  try   { return JSON.parse(fs.readFileSync(BULKS_PATH, "utf8")); }
  catch (_) { return []; }
}

function _write(data) {
  try   { fs.writeFileSync(BULKS_PATH, JSON.stringify(data, null, 2)); }
  catch (e) { console.error("[bulkTemplates] write failed:", e.message); return false; }
  // Mirror to Supabase fire-and-forget — never block the disk write
  _mirrorAll(data).catch((e) =>
    console.error("[bulkTemplates] supabase mirror failed:", e.message)
  );
  return true;
}

function _normHandle(h) { return String(h || "").replace(/^@/, "").trim().toLowerCase(); }

/** Convert one camelCase template entry → snake_case row for ad_bulks */
function _toRow(b) {
  return {
    id:            b.id,
    name:          b.name || "Unnamed",
    client:        b.client || null,
    ref_prefix:    b.refPrefix || null,
    last_ref_num:  Number.isFinite(b.lastRefNum) ? b.lastRefNum : 0,
    ad_type:       b.adType   || null,
    post_type:     b.postType || null,
    duration:      b.duration || null,
    nif:           b.nif      || null,
    seniors:       Array.isArray(b.seniors) ? b.seniors : [],
    price_mode:    b.priceMode || null,
    format:        b.format    || null,
    pages:         Array.isArray(b.pages) ? b.pages : [],
    per_page:      b.perPagePrices || {},
    status:        b.status || "open",
    notes:         b.notes  || null,
  };
}

/** Convert a snake_case row from ad_bulks → camelCase template (for reads) */
function _fromRow(r) {
  if (!r) return null;
  return {
    id:             r.id,
    name:           r.name,
    client:         r.client,
    refPrefix:      r.ref_prefix,
    lastRefNum:     r.last_ref_num,
    adType:         r.ad_type,
    postType:       r.post_type,
    duration:       r.duration,
    nif:            r.nif,
    seniors:        r.seniors || [],
    priceMode:      r.price_mode,
    format:         r.format,
    pages:          r.pages || [],
    perPagePrices:  r.per_page || {},
    status:         r.status,
    notes:          r.notes,
    updatedAt:      r.updated_at,
  };
}

/** Push the entire bulks.json contents to Supabase via upsert. */
async function _mirrorAll(data) {
  if (!_supabase) return;
  const rows = (data || []).map(_toRow);
  if (rows.length === 0) return;
  const { error } = await _supabase.from("ad_bulks").upsert(rows, { onConflict: "id" });
  if (error) throw new Error(error.message);
}

// ── Reads ───────────────────────────────────────────────────────────────

function list() { return _read(); }

function get(id) {
  if (!id) return null;
  return _read().find((b) => b.id === id) || null;
}

/**
 * Compute the next slot for a page given a current "N/M" string.
 * Returns null if the slot is already full or the format is invalid.
 */
function nextSlot(currentSlotStr) {
  if (!currentSlotStr) return null;
  const m = String(currentSlotStr).match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!m) return null;
  const used  = parseInt(m[1], 10);
  const total = parseInt(m[2], 10);
  if (used >= total) return { used, total, slot: `${used}/${total}`, full: true };
  return { used: used + 1, total, slot: `${used + 1}/${total}`, full: false };
}

/**
 * Build a list of pages with their current state for UI display
 * (used by Digi's BulkSelector dropdown).
 */
function pageStatusFor(bulkId) {
  const bulk = get(bulkId);
  if (!bulk) return null;
  const out = [];
  for (const handle of (bulk.pages || [])) {
    const norm = _normHandle(handle);
    const entry = bulk.perPagePrices?.[norm] || bulk.perPagePrices?.[handle] || {};
    const next = nextSlot(entry.bulk);
    out.push({
      handle:  norm,
      price:   entry.price ? parseFloat(entry.price) : null,
      slot:    entry.bulk || null,
      next:    next?.slot || null,
      full:    !!next?.full,
      hasSlot: !!entry.bulk,
    });
  }
  return {
    id:          bulk.id,
    name:        bulk.name,
    client:      bulk.client,
    adType:      bulk.adType,
    refPrefix:   bulk.refPrefix,
    nextRefNum:  (bulk.lastRefNum || 0) + 1,
    pages:       out,
  };
}

// ── Two-phase advance: plan → commit ────────────────────────────────────

/**
 * Plan a slot advance for the given pages of a bulk. Does NOT write to
 * disk. Returned object can be passed to commitAdvance() once the ad
 * actually ships (after the cancel window closes successfully).
 *
 * The plan also records the next campaign ref line (e.g. "BET SLIP Day 15")
 * so the caller can attach it to the brief without re-reading the file.
 */
function planAdvance(bulkId, handles) {
  const bulk = get(bulkId);
  if (!bulk) return null;

  const plan = {
    bulkId,
    refLine:    bulk.refPrefix ? `${bulk.refPrefix} ${(bulk.lastRefNum || 0) + 1}` : null,
    refPrefix:  bulk.refPrefix || null,
    nextRefNum: (bulk.lastRefNum || 0) + 1,
    perHandle:  {},   // handle → { used, total, slot }
    skipped:    [],   // handles whose slot is full or unknown
  };

  for (const raw of (handles || [])) {
    const handle = _normHandle(raw);
    if (!handle) continue;
    const entry = bulk.perPagePrices?.[handle] || bulk.perPagePrices?.[raw] || {};
    const next  = nextSlot(entry.bulk);
    if (next && !next.full) {
      plan.perHandle[handle] = next;
    } else {
      plan.skipped.push({ handle, reason: next?.full ? "package_full" : "no_slot_state" });
    }
  }

  return plan;
}

/**
 * Apply a previously-built plan to the bulks.json file. Bumps
 * `lastRefNum` (if the bulk has a refPrefix) and updates each
 * `perPagePrices[handle].bulk` to the new "N/M" string.
 *
 * Returns true on success, false if the bulk no longer exists.
 */
function commitAdvance(plan) {
  if (!plan || !plan.bulkId) return false;
  const data = _read();
  const idx  = data.findIndex((b) => b.id === plan.bulkId);
  if (idx < 0) return false;

  const bulk = data[idx];
  if (plan.refPrefix) {
    bulk.lastRefNum = (bulk.lastRefNum || 0) + 1;
  }
  for (const [handle, info] of Object.entries(plan.perHandle || {})) {
    if (!bulk.perPagePrices) bulk.perPagePrices = {};
    if (!bulk.perPagePrices[handle]) bulk.perPagePrices[handle] = {};
    bulk.perPagePrices[handle].bulk = info.slot;
  }
  return _write(data);
}

/**
 * Force a full mirror sync of bulks.json → Supabase. Useful on app
 * startup if mirror drifted (e.g. SUPABASE creds were missing on a
 * previous run while bulks.json kept being mutated locally).
 */
async function mirrorNow() {
  return _mirrorAll(_read());
}

/**
 * Reverse of mirrorNow(): pull the durable rows from Supabase `ad_bulks`
 * and reconcile them back into bulks.json. This is the recovery path for
 * ephemeral hosts — on Railway the container filesystem resets to the
 * git-committed bulks.json on every redeploy/restart, so templates that
 * were created/edited over the web (and mirrored to Supabase) would
 * otherwise vanish from every read, since all reads consult the disk file
 * only. Call this once on boot, before the API starts serving.
 *
 * Merge policy: union by id. For ids present in both disk and Supabase the
 * Supabase row wins — it is the live mirror written on every web/wizard
 * edit, whereas the disk copy is the stale git seed. Disk-only ids are
 * preserved (covers seeds that predate the mirror). Writes straight to
 * disk without re-mirroring (the data just came from Supabase).
 */
async function hydrateFromSupabase() {
  if (!_supabase) return { skipped: "supabase not configured" };
  const { data: rows, error } = await _supabase.from("ad_bulks").select("*");
  if (error) {
    console.error("[bulkTemplates] hydrate read failed:", error.message);
    return { error: error.message };
  }
  const remote = (rows || []).map(_fromRow).filter(Boolean);
  const disk   = _read();
  const byId   = new Map();
  for (const b of disk)   byId.set(b.id, b);   // disk seeds first…
  for (const b of remote) byId.set(b.id, b);   // …Supabase mirror overrides
  const merged = [...byId.values()];
  try {
    fs.writeFileSync(BULKS_PATH, JSON.stringify(merged, null, 2));
  } catch (e) {
    console.error("[bulkTemplates] hydrate write failed:", e.message);
    return { error: e.message };
  }
  console.log(
    `[bulkTemplates] hydrated ${merged.length} templates from Supabase ` +
    `(disk had ${disk.length}, Supabase had ${remote.length})`
  );
  return { count: merged.length, fromDisk: disk.length, fromSupabase: remote.length };
}

// ── CRUD: create / update / setStatus / remove ──────────────────────────

function _slugify(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "") || "untitled";
}

const ALLOWED_STATUSES = ["open", "completed", "archived"];

const UPDATABLE_FIELDS = [
  "name", "client", "refPrefix", "lastRefNum", "adType", "postType",
  "duration", "nif", "seniors", "priceMode", "format", "pages",
  "perPagePrices", "status", "notes",
];

/**
 * Create a new bulk template. If `id` is omitted it's slugified from `name`.
 * Returns `{ bulk }` on success or `{ error }` if id collides.
 */
function create(template) {
  if (!template || !template.name) return { error: "name is required" };
  const data = _read();
  const id = template.id || _slugify(template.name);
  if (data.some((b) => b.id === id)) {
    return { error: `bulk template "${id}" already exists` };
  }
  const newBulk = {
    id,
    name:          template.name,
    client:        template.client      || null,
    refPrefix:     template.refPrefix   || null,
    lastRefNum:    Number.isFinite(template.lastRefNum) ? template.lastRefNum : 0,
    adType:        template.adType      || null,
    postType:      template.postType    || null,
    duration:      template.duration    || null,
    nif:           template.nif         || null,
    seniors:       Array.isArray(template.seniors) ? template.seniors : [],
    priceMode:     template.priceMode   || "per-page",
    format:        template.format      || "Standard",
    pages:         Array.isArray(template.pages) ? template.pages : [],
    perPagePrices: template.perPagePrices || {},
    status:        "open",
    notes:         template.notes       || null,
  };
  data.push(newBulk);
  if (!_write(data)) return { error: "failed to write bulks.json" };
  return { bulk: newBulk };
}

/**
 * Update one or more fields on an existing template. Whitelist of
 * mutable fields prevents callers from rewriting `id`. Returns
 * `{ bulk }` on success or `{ error }` if not found.
 */
function update(id, fields) {
  if (!id || !fields || typeof fields !== "object") {
    return { error: "id and fields object are required" };
  }
  const data = _read();
  const idx = data.findIndex((b) => b.id === id);
  if (idx < 0) return { error: `bulk template not found: ${id}` };
  for (const k of UPDATABLE_FIELDS) {
    if (k in fields) data[idx][k] = fields[k];
  }
  if (fields.status && !ALLOWED_STATUSES.includes(fields.status)) {
    return { error: `invalid status (must be ${ALLOWED_STATUSES.join("|")})` };
  }
  if (!_write(data)) return { error: "failed to write bulks.json" };
  return { bulk: data[idx] };
}

/** Convenience: change status only. */
function setStatus(id, status) {
  if (!ALLOWED_STATUSES.includes(status)) {
    return { error: `invalid status (must be ${ALLOWED_STATUSES.join("|")})` };
  }
  return update(id, { status });
}

/**
 * Permanently delete a template (also removes the Supabase mirror row).
 * Prefer `setStatus(id, 'archived')` for soft-delete.
 */
function remove(id) {
  const data = _read();
  const idx = data.findIndex((b) => b.id === id);
  if (idx < 0) return { error: `bulk template not found: ${id}` };
  const removed = data.splice(idx, 1)[0];
  if (!_write(data)) return { error: "failed to write bulks.json" };
  // Also drop from Supabase (fire-and-forget)
  if (_supabase) {
    _supabase.from("ad_bulks").delete().eq("id", id).then(({ error }) => {
      if (error) console.error("[bulkTemplates] supabase delete:", error.message);
    });
  }
  return { bulk: removed };
}

// ── Progress / dashboard rollup ─────────────────────────────────────────

/**
 * Compute per-page + aggregate progress for one template. The dashboard
 * surfaces this directly: completion %, $ committed vs spent vs remaining,
 * page-level rollup. Driven entirely from `perPagePrices[handle].bulk`
 * ("N/M") + `.price`, no extra DB query needed.
 */
function progress(id) {
  const bulk = get(id);
  if (!bulk) return null;

  const pages = (bulk.pages || []).map((handleRaw) => {
    const handle = _normHandle(handleRaw);
    const entry  = bulk.perPagePrices?.[handle] || bulk.perPagePrices?.[handleRaw] || {};
    const price  = entry.price != null ? parseFloat(entry.price) : 0;
    const m      = String(entry.bulk || "").match(/^(\d+)\s*\/\s*(\d+)$/);
    const used   = m ? parseInt(m[1], 10) : 0;
    const total  = m ? parseInt(m[2], 10) : 0;
    return {
      handle,
      price:           Number.isFinite(price) ? price : 0,
      used,
      total,
      remaining:       Math.max(0, total - used),
      committed:       total * (Number.isFinite(price) ? price : 0),
      spent:           used  * (Number.isFinite(price) ? price : 0),
      dollarsRemaining:(total - used) * (Number.isFinite(price) ? price : 0),
      pct:             total > 0 ? (used / total) * 100 : 0,
      full:            total > 0 && used >= total,
    };
  });

  const totalSlots             = pages.reduce((a, p) => a + p.total,            0);
  const usedSlots              = pages.reduce((a, p) => a + p.used,             0);
  const totalDollarsCommitted  = pages.reduce((a, p) => a + p.committed,        0);
  const dollarsSpent           = pages.reduce((a, p) => a + p.spent,            0);
  const dollarsRemaining       = pages.reduce((a, p) => a + p.dollarsRemaining, 0);
  const pagesFull              = pages.filter((p) => p.full).length;

  return {
    id:          bulk.id,
    name:        bulk.name,
    client:      bulk.client,
    adType:      bulk.adType,
    status:      bulk.status || "open",
    refPrefix:   bulk.refPrefix,
    lastRefNum:  bulk.lastRefNum || 0,
    nextRefNum:  (bulk.lastRefNum || 0) + 1,
    notes:       bulk.notes,
    totals: {
      pagesCount:             pages.length,
      pagesFull,
      pagesRemaining:         pages.length - pagesFull,
      totalSlots,
      usedSlots,
      remainingSlots:         Math.max(0, totalSlots - usedSlots),
      completionPct:          totalSlots > 0 ? (usedSlots / totalSlots) * 100 : 0,
      totalDollarsCommitted,
      dollarsSpent,
      dollarsRemaining,
    },
    pages,
    updatedAt: bulk.updatedAt,
  };
}

module.exports = {
  list,
  get,
  nextSlot,
  pageStatusFor,
  planAdvance,
  commitAdvance,
  mirrorNow,
  hydrateFromSupabase,
  // CRUD
  create,
  update,
  setStatus,
  remove,
  // Dashboard
  progress,
  // exposed for tests / wizard reload hooks
  _BULKS_PATH: BULKS_PATH,
};
