/**
 * lib/pendingBriefs.js — debounced brief processing queue.
 *
 * Why this exists:
 *   When an operator (e.g. Danielson) posts a brief in Internal Network
 *   Ads, they sometimes immediately edit it — fixing typos, changing the
 *   day number ("Stake Day 5 → Day 7"), tweaking pricing. The bot used
 *   to process the original text instantly, forward 20+ wrong messages
 *   to per-page chats, and write bad rows to sheets. The edit_message
 *   webhook (task #40) updates the message_buffer but the damage is
 *   already done.
 *
 *   This module buffers brief processing for 2 minutes. During the
 *   wait, edit_message events update message_buffer in place. When the
 *   cron worker picks up a due brief, it reads the LATEST text from
 *   message_buffer and processes that — so the post-edit version is
 *   what reaches sheets, chats, and DB.
 *
 * Schema: migrations/016_pending_briefs.sql
 */

const { _supabase: supabase } = require("./sessions");

const DEBOUNCE_MS = parseInt(process.env.BRIEF_DEBOUNCE_MS || "120000", 10); // 2 min default

/**
 * Insert a brief into the pending queue. Idempotent on (chat_id, message_id) —
 * Telegram occasionally redelivers webhooks before the bot ACKs; a second
 * insert from the same physical message is silently ignored.
 *
 * Returns the row that was inserted (or null if the queue is disabled).
 */
async function defer(chatId, messageId) {
  if (!supabase) return null;
  if (DEBOUNCE_MS <= 0) return null; // explicit opt-out via env var

  const scheduledFor = new Date(Date.now() + DEBOUNCE_MS).toISOString();
  try {
    // Use upsert so duplicate webhook deliveries don't create errors.
    // ignoreDuplicates: row stays at original scheduled_for + status.
    const { data, error } = await supabase
      .from("pending_briefs")
      .upsert(
        {
          chat_id:       Number(chatId),
          message_id:    Number(messageId),
          scheduled_for: scheduledFor,
          status:        "pending",
        },
        { onConflict: "chat_id,message_id", ignoreDuplicates: true }
      )
      .select()
      .maybeSingle();
    if (error) {
      console.error(`[pendingBriefs] defer error: ${error.message}`);
      return null;
    }
    return data;
  } catch (err) {
    console.error(`[pendingBriefs] defer threw: ${err.message}`);
    return null;
  }
}

/**
 * Get briefs whose debounce window has elapsed and are ready for processing.
 * Atomically flips them to 'processing' so concurrent cron ticks (e.g. on
 * Railway redeploy boundary) don't double-process the same brief.
 *
 * Returns array of { chat_id, message_id, attempts }.
 */
async function claimDue() {
  if (!supabase) return [];
  const nowIso = new Date().toISOString();

  // Two-step: SELECT due, then UPDATE the ones we picked.
  // Postgres doesn't have FOR UPDATE SKIP LOCKED via PostgREST, so we
  // accept a tiny race window — at worst the same brief gets processed
  // twice, which handleAdMessage's idempotency (ad_briefs unique on
  // (chat_id, message_id)) catches. Belt-and-suspenders.
  const { data: dueRows, error: e1 } = await supabase
    .from("pending_briefs")
    .select("chat_id, message_id, attempts")
    .eq("status", "pending")
    .lte("scheduled_for", nowIso)
    .order("scheduled_for", { ascending: true })
    .limit(50);
  if (e1) {
    console.error(`[pendingBriefs] claimDue select error: ${e1.message}`);
    return [];
  }
  if (!dueRows || dueRows.length === 0) return [];

  // Flip them to processing one by one (small batches; cron runs every 30s)
  const claimed = [];
  for (const row of dueRows) {
    const { error: e2 } = await supabase
      .from("pending_briefs")
      .update({ status: "processing" })
      .eq("chat_id",    row.chat_id)
      .eq("message_id", row.message_id)
      .eq("status",     "pending"); // only flip if still pending — avoids races
    if (!e2) claimed.push(row);
  }
  return claimed;
}

async function markProcessed(chatId, messageId) {
  if (!supabase) return;
  await supabase
    .from("pending_briefs")
    .update({ status: "processed", last_error: null })
    .eq("chat_id",    Number(chatId))
    .eq("message_id", Number(messageId));
}

async function markFailed(chatId, messageId, err) {
  if (!supabase) return;
  // Bump attempts, flip back to pending if under retry limit (5), else failed
  const msg = (err?.message || String(err)).slice(0, 500);
  const { data: cur } = await supabase
    .from("pending_briefs")
    .select("attempts")
    .eq("chat_id",    Number(chatId))
    .eq("message_id", Number(messageId))
    .single();
  const attempts = (cur?.attempts || 0) + 1;
  const finalStatus = attempts >= 5 ? "failed" : "pending";
  // For retry: also push scheduled_for out by a minute so we don't tight-loop
  const reschedule = finalStatus === "pending"
    ? { scheduled_for: new Date(Date.now() + 60_000).toISOString() }
    : {};
  await supabase
    .from("pending_briefs")
    .update({ status: finalStatus, attempts, last_error: msg, ...reschedule })
    .eq("chat_id",    Number(chatId))
    .eq("message_id", Number(messageId));
}

module.exports = {
  defer,
  claimDue,
  markProcessed,
  markFailed,
  DEBOUNCE_MS,
  _supabase: supabase,
};
