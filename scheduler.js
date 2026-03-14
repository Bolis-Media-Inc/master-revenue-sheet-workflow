/**
 * scheduler.js
 * In-process NIF expiration reminders via setTimeout.
 *
 * NIF = Not In Feed. After the NIF window expires the VA should post
 * native content. This fires a reminder in the page's IG Ads group.
 *
 * setTimeout is acceptable here because NIF durations are short (≤ 2hr).
 * Railway rarely restarts within that window. For longer reminders (24hr,
 * 7-day analytics) see reminders.js which uses the persistent Reminders sheet.
 */

/**
 * Parse a NIF string into milliseconds.
 * Examples:
 *   "15 MIN NIF"  → 900000
 *   "30min NIF"   → 1800000
 *   "1hr NIF"     → 3600000
 *   "2hr NIF"     → 7200000
 *
 * Returns null if no NIF duration is found.
 *
 * @param {string} nifString  The `nif` field from the parsed ad
 * @returns {number|null}
 */
function parseNifMs(nifString) {
  if (!nifString) return null;
  const s = nifString.toLowerCase();

  // Must contain the word "nif" to qualify (avoids matching "24hr" post durations)
  if (!/\bnif\b/.test(s)) return null;

  const hrMatch  = s.match(/(\d+)\s*hr/);
  const minMatch = s.match(/(\d+)\s*min/);

  if (hrMatch)  return parseInt(hrMatch[1])  * 60 * 60 * 1000;
  if (minMatch) return parseInt(minMatch[1]) * 60 * 1000;
  return null;
}

/**
 * Schedule a NIF expiration reminder for one page.
 * Sends a message to the page's IG Ads group after the NIF window expires.
 *
 * @param {object} telegram    Telegraf telegram instance (ctx.telegram)
 * @param {string} destChatId  The page's IG Ads group chat ID
 * @param {string} client      Campaign / client name (for the reminder text)
 * @param {string} handle      Page handle (for logging)
 * @param {number} nifMs       NIF duration in milliseconds
 */
function scheduleNifReminder(telegram, destChatId, client, handle, nifMs) {
  const mins = Math.round(nifMs / 60000);
  console.log(`[scheduler] ⏰ NIF reminder scheduled for @${handle} in ${mins} min (${client})`);

  setTimeout(async () => {
    try {
      await telegram.sendMessage(
        destChatId,
        `⏰ *NIF expired* — ${client}\nTime to post native content!`,
        { parse_mode: "Markdown" }
      );
      console.log(`[scheduler] ✅ NIF reminder sent → @${handle}`);
    } catch (err) {
      console.error(`[scheduler] ❌ NIF reminder failed for @${handle}: ${err.message}`);
    }
  }, nifMs);
}

module.exports = { parseNifMs, scheduleNifReminder };
