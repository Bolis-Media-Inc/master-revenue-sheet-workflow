/**
 * lib/adBriefs.js
 * Supabase-backed ad brief history.
 *
 * Persists every brief we process (raw text + parsed fields + shared media)
 * plus one row per page targeted. Powers /replay (DB-backed instead of
 * in-memory buffer) and future audit/analytics tooling.
 *
 * Schema: migrations/011_ad_briefs.sql
 *
 * All functions silently no-op when Supabase isn't configured — same
 * fail-soft pattern as lib/sessions.js, so a missing SUPABASE_URL doesn't
 * break forwarding.
 */

const { createClient } = require("@supabase/supabase-js");

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("[adBriefs] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — brief history disabled");
}

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

/**
 * Insert a new ad_briefs row.
 *
 * @param {object} brief
 * @param {number} brief.telegramChatId
 * @param {number} brief.telegramMessageId
 * @param {number} [brief.senderUserId]
 * @param {string} [brief.senderHandle]
 * @param {string} brief.rawText
 * @param {string} [brief.client]
 * @param {string} [brief.category]
 * @param {number} [brief.totalPrice]
 * @param {string} [brief.postType]
 * @param {string} [brief.postDuration]
 * @param {string} [brief.nif]
 * @param {string} [brief.datePosted]
 * @param {string} [brief.timeMst]
 * @param {Array<{file_id: string, kind: string}>} [brief.sharedMedia]
 * @param {string} [brief.sharedCaption]
 * @param {string} [brief.bundleFormat]
 * @returns {Promise<string|null>} The inserted brief's UUID, or null on
 *   failure / duplicate / Supabase disabled.
 */
async function insertBrief(brief) {
  if (!supabase) return null;

  const row = {
    telegram_chat_id:    brief.telegramChatId,
    telegram_message_id: brief.telegramMessageId,
    sender_user_id:      brief.senderUserId ?? null,
    sender_handle:       brief.senderHandle ?? null,
    raw_text:            brief.rawText,
    client:              brief.client ?? null,
    category:            brief.category ?? null,
    total_price:         brief.totalPrice ?? null,
    post_type:           brief.postType ?? null,
    post_duration:       brief.postDuration ?? null,
    nif:                 brief.nif ?? null,
    date_posted:         brief.datePosted ?? null,
    time_mst:            brief.timeMst ?? null,
    shared_media:        brief.sharedMedia ?? [],
    shared_caption:      brief.sharedCaption ?? null,
    bundle_format:       brief.bundleFormat ?? null,
  };

  const { data, error } = await supabase
    .from("ad_briefs")
    .insert(row)
    .select("id")
    .single();

  if (error) {
    // Duplicate (same chat_id + message_id) is fine — look up existing
    if (error.code === "23505") {
      const { data: existing } = await supabase
        .from("ad_briefs")
        .select("id")
        .eq("telegram_chat_id", brief.telegramChatId)
        .eq("telegram_message_id", brief.telegramMessageId)
        .maybeSingle();
      return existing?.id || null;
    }
    console.error("[adBriefs] insertBrief error:", error.message);
    return null;
  }
  return data?.id || null;
}

/**
 * Insert N ad_brief_pages rows for a given brief in a single call.
 * Caller should always batch — even single-page briefs go through this.
 *
 * @param {string} briefId
 * @param {Array<{
 *   pageHandle: string,
 *   bulkNum?: string,
 *   pagePrice?: number,
 *   pageMedia?: Array<{file_id: string, kind: string}>,
 *   pageCaption?: string,
 * }>} pages
 * @returns {Promise<Map<string, string>>} Map of page_handle → row id
 *   (empty if Supabase disabled or insert failed)
 */
async function insertBriefPages(briefId, pages) {
  const result = new Map();
  if (!supabase || !briefId || !pages || pages.length === 0) return result;

  const rows = pages.map((p) => ({
    brief_id:     briefId,
    page_handle:  p.pageHandle,
    bulk_num:     p.bulkNum ?? null,
    page_price:   p.pagePrice ?? null,
    page_media:   p.pageMedia ?? [],
    page_caption: p.pageCaption ?? null,
  }));

  const { data, error } = await supabase
    .from("ad_brief_pages")
    .upsert(rows, { onConflict: "brief_id,page_handle" })
    .select("id, page_handle");

  if (error) {
    console.error("[adBriefs] insertBriefPages error:", error.message);
    return result;
  }
  for (const r of data || []) result.set(r.page_handle, r.id);
  return result;
}

/**
 * Mark a page as successfully forwarded.
 *
 * @param {string} pageRowId  id from insertBriefPages return map
 * @param {object} outcome
 * @param {number[]} [outcome.messageIds]
 * @param {number} [outcome.masterSheetRow]
 * @param {number} [outcome.pageSheetRow]
 */
async function markPageForwarded(pageRowId, outcome = {}) {
  if (!supabase || !pageRowId) return;
  const patch = {
    forwarded_at:          new Date().toISOString(),
    forwarded_message_ids: outcome.messageIds ?? null,
    forward_error:         null,
  };
  // Only WRITE sheet-row numbers when a real value is supplied — NEVER null
  // them out. Callers (live forward, /replay) routinely pass the stale
  // in-memory value here, which used to CLOBBER a row number that
  // updatePageSheetRows had written moments earlier. That's how 741 rows ended
  // up with page_sheet_row = NULL despite a row existing in the sheet — and why
  // /syncsheets + recovery couldn't tell a row already existed and generated
  // duplicates. Mirror updatePageSheetRows' guard so this can only ADD
  // tracking, never destroy it.
  if (outcome.masterSheetRow != null) patch.master_sheet_row = outcome.masterSheetRow;
  if (outcome.pageSheetRow   != null) patch.page_sheet_row   = outcome.pageSheetRow;
  const { error } = await supabase
    .from("ad_brief_pages")
    .update(patch)
    .eq("id", pageRowId);
  if (error) console.error("[adBriefs] markPageForwarded error:", error.message);
}

/**
 * Record a forwarding failure for a page.
 */
async function markPageForwardError(pageRowId, errorMessage) {
  if (!supabase || !pageRowId) return;
  const { error } = await supabase
    .from("ad_brief_pages")
    .update({ forward_error: errorMessage })
    .eq("id", pageRowId);
  if (error) console.error("[adBriefs] markPageForwardError error:", error.message);
}

/**
 * Update sheet row numbers without touching forwarded_at.
 * Used when master/page sheet writes happen before forwarding completes.
 */
async function updatePageSheetRows(pageRowId, { masterSheetRow, pageSheetRow }) {
  if (!supabase || !pageRowId) return;
  const patch = {};
  if (masterSheetRow != null) patch.master_sheet_row = masterSheetRow;
  if (pageSheetRow   != null) patch.page_sheet_row   = pageSheetRow;
  if (Object.keys(patch).length === 0) return;
  const { error } = await supabase
    .from("ad_brief_pages")
    .update(patch)
    .eq("id", pageRowId);
  if (error) console.error("[adBriefs] updatePageSheetRows error:", error.message);
}

/**
 * Find the most recent brief matching a client-name fuzzy search.
 * Used by /replay search mode (e.g. /replay stake bet slip day 5 @handle).
 *
 * @param {string} clientQuery  partial client name, e.g. "stake bet slip"
 * @param {number} [limit=5]
 * @returns {Promise<Array<{
 *   id: string,
 *   client: string,
 *   raw_text: string,
 *   received_at: string,
 *   telegram_chat_id: number,
 *   telegram_message_id: number,
 *   shared_media_file_ids: string[],
 *   shared_caption: string|null,
 * }>>}
 */
async function findBriefsByClient(clientQuery, limit = 5) {
  if (!supabase || !clientQuery) return [];
  const { data, error } = await supabase
    .from("ad_briefs")
    .select("id, client, raw_text, received_at, telegram_chat_id, telegram_message_id, shared_media, shared_caption")
    .ilike("client", `%${clientQuery.trim()}%`)
    .order("received_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("[adBriefs] findBriefsByClient error:", error.message);
    return [];
  }
  return data || [];
}

/**
 * Look up a brief by its Telegram identity. Used by /replay reply mode
 * as a fallback when the in-memory buffer doesn't have the brief.
 */
async function findBriefByTelegramMessage(chatId, messageId) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("ad_briefs")
    .select("id, client, raw_text, received_at, telegram_chat_id, telegram_message_id, shared_media, shared_caption")
    .eq("telegram_chat_id", chatId)
    .eq("telegram_message_id", messageId)
    .maybeSingle();
  if (error) {
    console.error("[adBriefs] findBriefByTelegramMessage error:", error.message);
    return null;
  }
  return data || null;
}

/**
 * Load all pages for a brief, optionally filtered to specific handles.
 * Returns rows in insertion order for stable /replay forwarding.
 */
async function getBriefPages(briefId, handleFilter = null) {
  if (!supabase || !briefId) return [];
  let q = supabase
    .from("ad_brief_pages")
    .select("id, page_handle, bulk_num, page_price, page_media, page_caption, forwarded_at, master_sheet_row, page_sheet_row")
    .eq("brief_id", briefId)
    .order("created_at", { ascending: true });
  if (handleFilter && handleFilter.length > 0) {
    q = q.in("page_handle", handleFilter.map((h) => h.toLowerCase().replace(/^@/, "")));
  }
  const { data, error } = await q;
  if (error) {
    console.error("[adBriefs] getBriefPages error:", error.message);
    return [];
  }
  return data || [];
}

/**
 * Mark the most-recent matching ad_brief_pages rows as posted. Called by
 * the "Posted on @handle1 @handle2 …" handler so we have a durable
 * record of which pages went live even when the master sheet write
 * failed at original-processing time.
 *
 * Matching strategy: most recent ad_brief_pages row per (page_handle,
 * brief.client) — newest first, take one. If no client filter is given,
 * use the most recent row for the handle across all briefs.
 *
 * @param {string[]} handles  page handles without leading @
 * @param {string} [clientName]  e.g. "Whop Enhanced Games"
 * @returns {Promise<number>} count of rows updated
 */
async function markPagesPosted(handles, clientName) {
  if (!supabase || !handles || handles.length === 0) return 0;
  let updated = 0;
  for (const handle of handles) {
    const h = handle.toLowerCase().replace(/^@/, "");
    // Find the latest ad_brief_pages row for this handle, optionally
    // filtered by client. Use the joined ad_briefs for the client filter.
    let q = supabase
      .from("ad_brief_pages")
      .select("id, brief:ad_briefs!brief_id(client, received_at)")
      .eq("page_handle", h)
      .is("posted_at", null)
      .order("created_at", { ascending: false })
      .limit(10);
    const { data, error } = await q;
    if (error) { console.error(`[adBriefs] markPagesPosted lookup @${h}:`, error.message); continue; }
    if (!data || data.length === 0) continue;
    // Filter by client if provided — fuzzy substring match since the
    // "Posted on" handler does client matching the same way
    let target = data[0];
    if (clientName) {
      const needle = clientName.toLowerCase();
      const match = data.find((r) => (r.brief?.client || "").toLowerCase().includes(needle));
      if (match) target = match; else continue; // no matching client → skip this handle
    }
    const { error: updErr } = await supabase
      .from("ad_brief_pages")
      .update({ posted_at: new Date().toISOString() })
      .eq("id", target.id);
    if (updErr) {
      console.error(`[adBriefs] markPagesPosted update @${h}:`, updErr.message);
    } else {
      updated++;
    }
  }
  return updated;
}

/**
 * Find all ad_brief_pages where a sheet write didn't complete (either
 * master_sheet_row or page_sheet_row is NULL). Optionally filter by
 * client-name substring (case-insensitive) so /syncsheets can target
 * one campaign at a time. Returns joined data — caller has everything
 * needed to rebuild the row without a second DB hit.
 *
 * @param {object} [opts]
 * @param {string} [opts.clientFilter]  Substring match against ad_briefs.client
 * @param {number} [opts.limit=200]     Safety cap
 */
async function findIncompletePages(opts = {}) {
  if (!supabase) return [];
  const limit = opts.limit ?? 200;

  let q = supabase
    .from("ad_brief_pages")
    .select(`
      id, brief_id, page_handle, bulk_num, page_price,
      master_sheet_row, page_sheet_row, forwarded_at, posted_at,
      brief:ad_briefs!brief_id(
        id, client, category, total_price, post_type, post_duration,
        nif, date_posted, time_mst, received_at
      )
    `)
    .or("master_sheet_row.is.null,page_sheet_row.is.null")
    .order("created_at", { ascending: false })
    .limit(limit);

  const { data, error } = await q;
  if (error) {
    console.error("[adBriefs] findIncompletePages error:", error.message);
    return [];
  }
  // Supabase returns the joined brief as a nested object — flatten and filter
  const rows = (data || []).map((r) => ({
    ...r,
    brief: Array.isArray(r.brief) ? r.brief[0] : r.brief, // PostgREST sometimes returns array
  }));
  if (opts.clientFilter) {
    const needle = opts.clientFilter.toLowerCase();
    return rows.filter((r) => (r.brief?.client || "").toLowerCase().includes(needle));
  }
  return rows;
}

/**
 * Recent briefs feed for any future "ad activity" UI.
 */
async function listRecentBriefs(limit = 25) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("ad_briefs")
    .select("id, client, category, total_price, received_at, telegram_chat_id, telegram_message_id")
    .order("received_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("[adBriefs] listRecentBriefs error:", error.message);
    return [];
  }
  return data || [];
}

module.exports = {
  insertBrief,
  insertBriefPages,
  markPageForwarded,
  markPageForwardError,
  updatePageSheetRows,
  findBriefsByClient,
  findBriefByTelegramMessage,
  findIncompletePages,
  getBriefPages,
  listRecentBriefs,
  markPagesPosted,
  // Internal export for tests
  _supabase: supabase,
};
