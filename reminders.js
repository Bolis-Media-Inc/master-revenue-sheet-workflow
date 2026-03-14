/**
 * reminders.js
 * Persistent post-expiry and analytics reminders.
 *
 * Two reminder types:
 *
 *  "timed"     — post has a finite duration (24hr, 48hr, etc.)
 *                Fired at expiry: take analytics screenshots then delete.
 *
 *  "permanent" — post is permanent or long-term (7-day default check-in)
 *                Fired after 7 days: analytics check-in, do NOT delete.
 *
 * Reminders are persisted in a "Reminders" tab on the master sheet so they
 * survive Railway restarts. A node-cron job polls every 15 minutes.
 */

const { getPendingReminders, markReminderSent } = require("./sheets");

const MASTER_SHEET_ID = process.env.MASTER_SHEET_ID;

// ── Post duration parsing ──────────────────────────────────────────────────────

/**
 * Derive a post-expiry reminder from the `nif` (post duration) string.
 *
 * Returns { type: "timed"|"permanent", ms: number } or null if unrecognised.
 *
 * Rules:
 *   - Contains "permanent" or "do not delete" → permanent, 7-day check-in
 *   - Contains "30 day" / "30day"             → treat as permanent (long-term)
 *   - Contains a plain hour/day duration      → timed expiry reminder
 *   - Contains "nif" but no separate duration → permanent (NIF = posting delay,
 *                                               not post lifetime)
 *
 * @param {string} nifString   The `nif` field from the parsed ad
 * @returns {{ type: string, ms: number }|null}
 */
function parsePostDuration(nifString) {
  if (!nifString) return null;
  const s = nifString.toLowerCase();

  const SEVEN_DAYS   = 7  * 24 * 60 * 60 * 1000;
  const TWENTY_FOUR  = 24 * 60 * 60 * 1000;
  const FORTY_EIGHT  = 48 * 60 * 60 * 1000;

  // Permanent / long-term → 7-day analytics check-in
  if (
    /perm/.test(s) ||
    /do not delete/.test(s) ||
    /don't delete/.test(s) ||
    /30\s*day/.test(s)
  ) {
    return { type: "permanent", ms: SEVEN_DAYS };
  }

  // If it's purely a NIF (no post duration stated) → treat post as permanent
  if (/\bnif\b/.test(s) && !/\d+\s*hr(?!\s*nif)/.test(s) && !/\d+\s*h(?!\s*nif)/.test(s)) {
    return { type: "permanent", ms: SEVEN_DAYS };
  }

  // 48hr / 48h
  if (/48\s*h/.test(s)) return { type: "timed", ms: FORTY_EIGHT };

  // 24hr / 24h
  if (/24\s*h/.test(s)) return { type: "timed", ms: TWENTY_FOUR };

  // Any other plain hour duration e.g. "2hr"
  const hrMatch = s.match(/(\d+)\s*hr?\b(?!\s*nif)/);
  if (hrMatch) {
    const ms = parseInt(hrMatch[1]) * 60 * 60 * 1000;
    if (ms >= 60 * 60 * 1000) return { type: "timed", ms }; // ≥ 1hr only
  }

  return null;
}

// ── Cron-fired checker ─────────────────────────────────────────────────────────

/**
 * Check the Reminders sheet for any overdue entries and fire them.
 * Called every 15 minutes by the cron job in index.js.
 *
 * @param {object} telegram   Telegraf telegram instance (bot.telegram)
 */
async function checkAndFireReminders(telegram) {
  if (!MASTER_SHEET_ID) return;

  let pending;
  try {
    pending = await getPendingReminders(MASTER_SHEET_ID);
  } catch (err) {
    console.error("[reminders] ❌ Failed to read reminders sheet:", err.message);
    return;
  }

  if (pending.length === 0) return;
  console.log(`[reminders] 🔔 ${pending.length} reminder(s) due`);

  for (const r of pending) {
    const message = r.type === "timed"
      ? `📸 *${r.client}* post is expiring on @${r.handle} — take analytics screenshots then delete the post.`
      : `📊 *7-day analytics check-in* — ${r.client} on @${r.handle}.\nDo NOT delete this post — just log your analytics.`;

    try {
      await telegram.sendMessage(r.destChatId, message, { parse_mode: "Markdown" });
      await markReminderSent(MASTER_SHEET_ID, r.rowNumber);
      console.log(`[reminders] ✅ Sent ${r.type} reminder → @${r.handle} (${r.client})`);
    } catch (err) {
      console.error(`[reminders] ❌ Failed to send reminder for @${r.handle}: ${err.message}`);
    }
  }
}

module.exports = { parsePostDuration, checkAndFireReminders };
