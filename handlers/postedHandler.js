/**
 * handlers/postedHandler.js
 *
 * Marks scheduled ads as Live when a VA sends Greg an Instagram post URL.
 * Fires in three contexts:
 *   - Direct message to Greg (always — the original VA flow)
 *   - Group / supergroup chat where the message is a REPLY to one of
 *     Greg's previous messages (e.g. replying to the "🚀 Sent" intake
 *     notification with the IG link)
 *   - Group / supergroup chat where the message @-mentions Greg's bot
 *
 * Bare IG URLs in groups (with neither reply nor mention) are intentionally
 * ignored so Greg doesn't collide with Digi's manualSubmission listener
 * that also watches for media URLs.
 *
 * Resolution flow:
 *   1. Extract post info from URL (postId, kind)
 *   2. Call Digi /api/ig/resolve → { username, caption, postedAt, ... }
 *      (BrightData scrape of the IG post)
 *   3. Find candidate scheduled posted_ads where page_handle = username
 *   4. Pull each candidate's campaign caption + client_name from ad_sessions
 *   5. Score each candidate (caption similarity + client name + time proximity)
 *   6. Auto-mark live if best score ≥ 0.55, else show picker
 *
 * Fallback chain when Digi resolve fails:
 *   - If user typed @handle inline → narrow by that handle
 *   - Else: fall back to "find scheduled ads by submitter" heuristic (legacy)
 *   - Last resort: ask VA to add @handle inline
 *
 * The Digi resolver is best-effort. If Digi is down or BrightData rate
 * limits, we fail-soft to the legacy heuristic so VAs are never blocked.
 */

const { extractIGPostInfo, hasIGUrl, extractHandleMention } = require("../lib/igUrl");
const sessions     = require("../lib/sessions");
const digiClient   = require("../lib/digiClient");
const captionMatch = require("../lib/captionMatch");
const { updateStatusToLive } = require("../sheets");

const MASTER_SHEET_ID = process.env.MASTER_SHEET_ID;
const TAB_NAME        = process.env.SHEET_TAB_NAME || "2026 Ad Overview";

/**
 * True if the message is a reply to one of Greg's own messages. Used to
 * detect "VA pastes IG link in reply to Greg's intake notification" in a
 * shared sales/ops chat.
 */
function isReplyToGreg(ctx) {
  const replyFromId = ctx.message?.reply_to_message?.from?.id;
  return !!replyFromId && replyFromId === ctx.botInfo?.id;
}

/**
 * True if the message @-mentions Greg's bot username. Case-insensitive.
 */
function mentionsGreg(ctx) {
  const me = ctx.botInfo;
  if (!me?.username) return false;
  const text = ctx.message?.text || "";
  const entities = ctx.message?.entities || [];
  const target = `@${me.username.toLowerCase()}`;
  for (const e of entities) {
    if (e.type !== "mention") continue;
    const mention = text.slice(e.offset, e.offset + e.length).toLowerCase();
    if (mention === target) return true;
  }
  return false;
}

function shouldHandle(ctx) {
  if (!ctx.message?.text) return false;
  if (!hasIGUrl(ctx.message.text)) return false;

  const chatType = ctx.chat?.type;
  if (chatType === "private") return true;

  // Group / supergroup: only act when the message is unambiguously meant
  // for Greg. A bare IG URL in a shared chat is left alone so we don't
  // step on Digi's manual-submission listener.
  if (chatType === "group" || chatType === "supergroup") {
    return isReplyToGreg(ctx) || mentionsGreg(ctx);
  }
  return false;
}

async function handlePostedDM(ctx) {
  let resolvingMsg = null;

  try {
    const text   = ctx.message.text;
    const userId = ctx.from?.id;
    if (!userId) return;

    const info = extractIGPostInfo(text);
    if (!info) {
      await ctx.reply("📷 That looks like an Instagram URL but I couldn't find a post ID. Send the link to a specific post or reel.");
      return;
    }

    const explicitHandle = info.handleHint || extractHandleMention(text);

    // Show "resolving" indicator while BrightData scrape runs (~5-10s)
    resolvingMsg = await ctx.reply("🔍 Resolving Instagram post…").catch(() => null);

    // ── Try Digi resolver first ──────────────────────────────────────────
    let resolved = null;
    try {
      const result = await digiClient.resolveIGPost(info.url);
      if (result.ok) resolved = result.data;
      else console.warn(`[postedHandler] Digi resolve failed: ${result.error}`);
    } catch (e) {
      console.warn(`[postedHandler] Digi resolve threw: ${e.message}`);
    }

    // Best-source page handle: resolver > URL hint > inline @mention
    const matchHandle = resolved?.username || explicitHandle;

    if (resolvingMsg) {
      try { await ctx.telegram.deleteMessage(ctx.chat.id, resolvingMsg.message_id); } catch (_) {}
      resolvingMsg = null;
    }

    // ── Find candidates ──────────────────────────────────────────────────
    let candidates = [];
    if (matchHandle) {
      candidates = await sessions.findScheduledByHandle(matchHandle, { limit: 10 });
    }

    // Fallback: if no handle resolved at all, look at this user's recent
    // scheduled ads (legacy heuristic — only useful when submitter == poster)
    if (candidates.length === 0 && !matchHandle) {
      candidates = await sessions.findScheduledByUser(userId, { limit: 5 });
    }

    if (candidates.length === 0) {
      const hint = matchHandle
        ? `for @${matchHandle}`
        : "in scheduled ads";
      await ctx.reply(
        `🤔 Couldn't find a scheduled ad ${hint}.\n\n` +
        (matchHandle
          ? `Either the ad wasn't submitted via Greg, or it's already marked live.`
          : `Paste again with the page handle, e.g.\n\`${info.url} @thefuck.tv\``),
        { parse_mode: "Markdown" }
      );
      return;
    }

    // ── If we have caption from resolver, score and auto-pick ───────────
    if (resolved && resolved.caption) {
      const enriched = await Promise.all(candidates.map(async (ad) => {
        const sess = await loadAdSession(ad.ad_session_id);
        return {
          ad,
          matchInputs: {
            brandedCaption: sess?.payload?.adInfo?.caption || "",
            clientName:     ad.client_name,
            scheduledAt:    new Date(ad.created_at),
          },
        };
      }));

      const result = captionMatch.pickBestMatch(enriched, resolved);

      if (result.autoMark && result.best) {
        await markLive(ctx, result.best.candidate.ad, info, resolved, result.best.score);
        return;
      }

      // Mid-confidence: show picker with scores so user picks the right one
      if (result.best && result.alternatives.length > 0) {
        await sendPicker(ctx, info, [result.best, ...result.alternatives]);
        return;
      }

      // Single candidate, low confidence — just mark with note
      if (candidates.length === 1) {
        await markLive(ctx, candidates[0], info, resolved, result.best?.score ?? null);
        return;
      }
    }

    // ── No resolver caption: single candidate auto-marks ─────────────────
    if (candidates.length === 1) {
      await markLive(ctx, candidates[0], info, resolved, null);
      return;
    }

    // ── Multiple candidates, no caption to disambiguate: show picker ─────
    const scored = candidates.map((ad) => ({ candidate: { ad }, score: 0 }));
    await sendPicker(ctx, info, scored);

  } catch (e) {
    console.error("[postedHandler] error:", e.message);
    if (resolvingMsg) {
      try { await ctx.telegram.deleteMessage(ctx.chat.id, resolvingMsg.message_id); } catch (_) {}
    }
    try { await ctx.reply("⚠️ Something went wrong marking that as posted."); } catch {}
  }
}

async function loadAdSession(sessionId) {
  if (!sessionId) return null;
  const { data } = await sessions._supabase
    .from("ad_sessions")
    .select("payload")
    .eq("id", sessionId)
    .maybeSingle();
  return data || null;
}

/**
 * Show picker buttons for ambiguous matches. Each button encodes the ad
 * + post info so the callback handler can mark the chosen ad.
 */
async function sendPicker(ctx, info, scoredList) {
  const buttons = scoredList.slice(0, 5).map(({ candidate, score, breakdown }) => {
    const ad = candidate.ad;
    const scoreLabel = score && score > 0 ? ` ${Math.round(score * 100)}%` : "";
    return [{
      text: `@${ad.page_handle} — ${ad.client_name}${scoreLabel}`,
      callback_data: `posted:${ad.id}:${info.postId}:${info.kind}`,
    }];
  });

  const lines = [`📍 Multiple ads match — pick the right one:`, ""];
  scoredList.slice(0, 5).forEach(({ candidate, score }, i) => {
    const ad = candidate.ad;
    const t  = formatTimeAgo(ad.created_at);
    const s  = score && score > 0 ? ` (${Math.round(score * 100)}% match)` : "";
    lines.push(`${i + 1}. @${ad.page_handle} — ${ad.client_name} (scheduled ${t})${s}`);
  });

  await ctx.reply(lines.join("\n"), { reply_markup: { inline_keyboard: buttons } });
}

async function handlePostedCallback(ctx) {
  try {
    const parts = ctx.callbackQuery.data.split(":");
    if (parts[0] !== "posted") return false;
    const [, adId, postId, kind] = parts;

    const { data: ad } = await sessions._supabase
      .from("posted_ads").select("*").eq("id", adId).single();

    if (!ad) {
      await ctx.answerCbQuery("Ad not found", { show_alert: true });
      return true;
    }
    if (ad.status !== "scheduled") {
      await ctx.answerCbQuery(`Already ${ad.status}`, { show_alert: true });
      return true;
    }

    const url = `https://www.instagram.com/${kind}/${postId}/`;
    await markLive(ctx, ad, { url, postId, kind }, null, null);
    await ctx.answerCbQuery("✅ Marked live");
    return true;
  } catch (e) {
    console.error("[postedHandler] callback error:", e.message);
    try { await ctx.answerCbQuery("Error — try again"); } catch {}
    return true;
  }
}

async function markLive(ctx, ad, info, resolved, score) {
  await sessions.markPostedLive(ad.id, {
    igUrl: info.url,
    igPostId: info.postId,
  });

  let sheetUpdated = 0;
  if (MASTER_SHEET_ID) {
    try {
      sheetUpdated = await updateStatusToLive(
        MASTER_SHEET_ID, TAB_NAME, [ad.page_handle], ad.client_name
      );
    } catch (e) {
      console.error("[postedHandler] sheet update error:", e.message);
    }
  }

  const lines = [
    `✅ Marked live for @${ad.page_handle}`,
    `Client: ${ad.client_name}`,
  ];
  if (resolved) {
    lines.push(`Resolver: ${resolved.source} (${resolved.caption?.slice(0, 60) || "(no caption)"}…)`);
  }
  if (score != null) lines.push(`Match confidence: ${Math.round(score * 100)}%`);
  lines.push(sheetUpdated > 0 ? `📊 Master sheet updated (${sheetUpdated} row)` : `⚠️ Sheet update skipped`);

  await ctx.reply(lines.join("\n"));
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
