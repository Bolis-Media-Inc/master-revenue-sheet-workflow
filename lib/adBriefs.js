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
  const { error } = await supabase
    .from("ad_brief_pages")
    .update({
      forwarded_at:          new Date().toISOString(),
      forwarded_message_ids: outcome.messageIds ?? null,
      master_sheet_row:      outcome.masterSheetRow ?? null,
      page_sheet_row:        outcome.pageSheetRow ?? null,
      forward_error:         null,
    })
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
  getBriefPages,
  listRecentBriefs,
  // Internal export for tests
  _supabase: supabase,
};
