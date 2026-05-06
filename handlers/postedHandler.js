/**
 * handlers/postedHandler.js
 * Handles IG URL DMs sent to Greg.
 *
 * Flow:
 *   VA posts an ad to Instagram, copies the URL, DMs Greg the URL.
 *   Greg:
 *     1. Extracts post info from URL
 *     2. Looks up the user's most recent scheduled posted_ads (last 24h)
 *     3. If exactly 1: auto-marks Live + replies "✅ Marked live for @page"
 *     4. If multiple: shows buttons "Which ad? [Ad #1] [Ad #2]"
 *     5. If none: replies "No matching scheduled ads"
 *     6. Falls back to URL-based handle hint or @mention disambiguation
 *
 * Side effects:
 *   - Updates Master Revenue Sheet column I: Scheduled → Live
 *   - Updates posted_ads.status = 'live', sets ig_url, ig_post_id, posted_at
 */

const { extractIGPostInfo, hasIGUrl, extractHandleMention } = require("../lib/igUrl");
const sessions       = require("../lib/sessions");
const { updateStatusToLive } = require("../sheets");

const MASTER_SHEET_ID = process.env.MASTER_SHEET_ID;
const TAB_NAME        = process.env.SHEET_TAB_NAME || "2026 Ad Overview";

/**
 * Check if a Telegram message is a DM and contains an IG URL.
 * Returns true if we should handle it.
 */
function shouldHandle(ctx) {
  if (!ctx.message?.text) return false;
  if (ctx.chat?.type !== "private") return false;
  return hasIGUrl(ctx.message.text);
}

/**
 * Main handler — wire to bot.on("message") for DMs.
 */
async function handlePostedDM(ctx) {
  try {
    const text   = ctx.message.text;
    const userId = ctx.from?.id;
    if (!userId) return;

    const info = extractIGPostInfo(text);
    if (!info) {
      // hasIGUrl matched but extractIGPostInfo didn't — could be a profile URL
      await ctx.reply("📷 That looks like an Instagram URL but I couldn't find a post ID. Send the link to a specific post or reel.");
      return;
    }

    // Disambiguation hints — first the URL itself, then any @mention in the message
    const explicitHandle = info.handleHint || extractHandleMention(text);

    // Find scheduled ads for this user
    let candidates = await sessions.findScheduledByUser(userId, {
      pageHandle: explicitHandle,
      limit: 5,
    });

    // If none found for this user but user gave an explicit handle, broaden to
    // anyone's scheduled ads for that page (covers VAs marking team's ads live)
    if (candidates.length === 0 && explicitHandle) {
      candidates = await sessions.findScheduledByHandle(explicitHandle, { limit: 5 });
    }

    // ── No matches ────────────────────────────────────────────────────────
    if (candidates.length === 0) {
      const hint = explicitHandle
        ? `for @${explicitHandle}`
        : "in your recent submissions";
      await ctx.reply(
        `🤔 I couldn't find a scheduled ad ${hint}.\n\n` +
        `If this is for someone else's ad, paste again with the page handle, e.g.:\n` +
        `\`${info.url} @thefuck.tv\``,
        { parse_mode: "Markdown" }
      );
      return;
    }

    // ── Exactly 1 match → auto-mark live ──────────────────────────────────
    if (candidates.length === 1) {
      const ad = candidates[0];
      await markLive(ctx, ad, info);
      return;
    }

    // ── Multiple matches → show picker ────────────────────────────────────
    // Stash the URL info on each button's callback_data
    const buttons = candidates.map((ad, i) => ([{
      text: `${i + 1}. @${ad.page_handle} — ${ad.client_name}`,
      callback_data: `posted:${ad.id}:${info.postId}:${info.kind}`,
    }]));

    await ctx.reply(
      `📍 Multiple scheduled ads match. Which one is this for?\n\n` +
      candidates.map((a, i) => `${i + 1}. @${a.page_handle} — ${a.client_name} (scheduled ${formatTimeAgo(a.created_at)})`).join("\n"),
      { reply_markup: { inline_keyboard: buttons } }
    );
  } catch (e) {
    console.error("[postedHandler] error:", e.message);
    try { await ctx.reply("⚠️ Something went wrong marking that as posted. Try again or use the manual /posted command."); } catch {}
  }
}

/**
 * Callback handler for the picker buttons.
 * callback_data format: "posted:{adId}:{postId}:{kind}"
 */
async function handlePostedCallback(ctx) {
  try {
    const parts = ctx.callbackQuery.data.split(":");
    if (parts[0] !== "posted") return false; // not us
    const [, adId, postId, kind] = parts;

    // Look up the ad
    const { data: ad } = await sessions._supabase
      .from("posted_ads")
      .select("*")
      .eq("id", adId)
      .single();

    if (!ad) {
      await ctx.answerCbQuery("Ad not found", { show_alert: true });
      return true;
    }

    if (ad.status !== "scheduled") {
      await ctx.answerCbQuery(`Ad already marked as ${ad.status}`, { show_alert: true });
      return true;
    }

    // Reconstruct the URL
    const url = `https://www.instagram.com/${kind}/${postId}/`;
    await markLive(ctx, ad, { url, postId, kind });
    await ctx.answerCbQuery("✅ Marked live");
    return true;
  } catch (e) {
    console.error("[postedHandler] callback error:", e.message);
    try { await ctx.answerCbQuery("Error — try again"); } catch {}
    return true;
  }
}

/**
 * Mark a posted_ad as live: Supabase + Master Sheet.
 */
async function markLive(ctx, ad, info) {
  // Update Supabase
  await sessions.markPostedLive(ad.id, {
    igUrl: info.url,
    igPostId: info.postId,
  });

  // Update Master Sheet status
  let sheetUpdated = 0;
  if (MASTER_SHEET_ID) {
    try {
      sheetUpdated = await updateStatusToLive(
        MASTER_SHEET_ID,
        TAB_NAME,
        [ad.page_handle],
        ad.client_name
      );
    } catch (e) {
      console.error("[postedHandler] sheet update error:", e.message);
    }
  }

  await ctx.reply(
    `✅ Marked live for @${ad.page_handle}\n` +
    `Client: ${ad.client_name}\n` +
    (sheetUpdated > 0 ? `📊 Master sheet updated (${sheetUpdated} row)` : `⚠️ Sheet update skipped`)
  );
}

function formatTimeAgo(isoString) {
  const ms = Date.now() - new Date(isoString).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

module.exports = { shouldHandle, handlePostedDM, handlePostedCallback };
