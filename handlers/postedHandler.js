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
const { updateStatusToLive, updateAdDate } = require("../sheets");
const pagesRegistry = require("../lib/pages");

const MASTER_SHEET_ID    = process.env.MASTER_SHEET_ID;
const TAB_NAME           = process.env.SHEET_TAB_NAME      || "2026 Ad Overview";
const PAGE_TAB_NAME      = process.env.PAGE_SHEET_TAB_NAME || "IG Revenue Tracker";
const TARGET_CHAT_ID     = process.env.WIZARD_TARGET_CHAT_ID;
const PLACEHOLDER_PATTERN = /^(SHEET_ID_|TELEGRAM_CHAT_ID_)/;
const GREG_TAG           = "<!-- greg-handled -->";

// "Posted on" pattern detection — matches the reply format VAs already
// type in Internal Network Ads ("Posted on", "posted on", "Second set
// posted on"). We accept it in DMs from contributors so Greg can mirror
// the confirmation into Internal Network Ads.
const POSTED_ON_RE = /\bposted on\b/i;

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
  const text = ctx.message.text;
  const hasUrl = hasIGUrl(text);
  const hasPostedOn = POSTED_ON_RE.test(text);
  if (!hasUrl && !hasPostedOn) return false;

  const chatType = ctx.chat?.type;
  if (chatType === "private") return true;

  // Group / supergroup: only act when the message is unambiguously meant
  // for Greg. A bare IG URL or "Posted on" in a shared chat is left
  // alone so we don't step on Digi's manual-submission listener nor
  // bm_tracking_bot's existing "Posted on" handler in Internal Network
  // Ads.
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

    // ── "Posted on @page <date>" without an IG URL ─────────────────────────
    // Contributors confirming a posted ad in their own Greg DM. Greg
    // updates the sheet AND mirrors the confirmation back into Internal
    // Network Ads as a reply to the original brief, so the audit trail
    // there matches what the chat would have if the contributor had
    // posted the confirmation directly.
    if (!hasIGUrl(text) && POSTED_ON_RE.test(text)) {
      return handlePostedOnConfirmation(ctx);
    }

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

// ── Posted-on confirmation in contributor DM (no IG URL needed) ──────────────
//
// A contributor whose ad was approved + posted by Greg replies in their
// own Greg DM with a "Posted on @page <date>" message. Greg:
//   1. Identifies the matching scheduled ad(s) for this user
//   2. Updates the master sheet (status Live + date) and per-page sheets
//   3. Mirrors the confirmation text into Internal Network Ads as a
//      reply to the original brief (with <!-- greg-handled --> so
//      bm_tracking_bot's own Posted-on handler doesn't double-update
//      the sheet)
//   4. Replies to the contributor with confirmation
//
// Mirror format matches the human format VAs already type so it reads
// naturally in the audit trail. Greg-handled marker is appended at the
// end of the message — invisible in normal Telegram clients.

const { extractPostedOnDate } = require("./adHandler");

async function handlePostedOnConfirmation(ctx) {
  try {
    const text   = ctx.message.text;
    const userId = ctx.from?.id;
    if (!userId) return;

    // Extract @handles. Same logic bm_tracking_bot uses for Posted-on
    // replies — handle lines start with @, page handle is the captured
    // word. Multi-page replies list one handle per line.
    const handles = text.split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("@"))
      .map((l) => l.match(/^@([\w.]+)/)?.[1])
      .filter(Boolean);

    if (handles.length === 0) {
      await ctx.reply(
        "🤔 I see a 'Posted on' but no @handles. Reply with the page handles you posted to, e.g.\n" +
        "```\nPosted on:\n@goal\n@thefuck.tv\nMay 5th\n```",
        { parse_mode: "Markdown" },
      );
      return;
    }

    const overrideDate = extractPostedOnDate(text);

    // Find this contributor's recent scheduled ads matching ANY of the
    // handles. We narrow by submitter so we don't accidentally flip
    // someone else's pending campaigns.
    const candidates = [];
    for (const handle of handles) {
      const found = await sessions.findScheduledByUser(userId, { pageHandle: handle, limit: 5 });
      candidates.push(...found);
    }

    if (candidates.length === 0) {
      await ctx.reply(
        `🤔 Couldn't find any of your scheduled ads for ${handles.map((h) => "@" + h).join(", ")}.\n\n` +
        `Possibilities:\n` +
        `· The ads were already marked live\n` +
        `· They weren't submitted via Greg (manual post in Internal Network Ads)\n` +
        `· The submission still hasn't shipped (cancel-window not yet closed)`,
      );
      return;
    }

    // Group candidates by ad_session_id so we can mirror once per session
    // (multiple handles in one session → single Internal Network Ads
    // mirror reply listing all the confirmed handles).
    const bySession = new Map();
    for (const ad of candidates) {
      const list = bySession.get(ad.ad_session_id) || [];
      list.push(ad);
      bySession.set(ad.ad_session_id, list);
    }

    let totalSheetRows = 0;
    let mirroredCount  = 0;
    const replyParts   = [];

    for (const [sessionId, ads] of bySession) {
      // Load the session to get internal_brief.messageId and client name
      const session = await loadAdSession(sessionId);
      const clientName = ads[0]?.client_name || null;
      const brief      = session?.internal_brief || null;

      // 1. Mark each ad as Live + record posted_at
      for (const ad of ads) {
        try {
          await sessions.markPostedLive(ad.id, { igUrl: null, igPostId: null });
        } catch (e) {
          console.error(`[postedHandler] markPostedLive ${ad.id}: ${e.message}`);
        }
      }

      // 2. Update sheets — Greg side does this directly so we have a
      //    single source of truth and the contributor can immediately
      //    see "Marked Live for @page" in their reply
      const sessionHandles = ads.map((a) => a.page_handle);
      if (MASTER_SHEET_ID) {
        try {
          const flipped = await updateStatusToLive(MASTER_SHEET_ID, TAB_NAME, sessionHandles, clientName);
          totalSheetRows += flipped;
        } catch (e) { console.error("[postedHandler] master status update:", e.message); }

        if (overrideDate) {
          try {
            await updateAdDate(MASTER_SHEET_ID, TAB_NAME, sessionHandles, clientName, overrideDate, true);
          } catch (e) { console.error("[postedHandler] master date update:", e.message); }
        }
      }

      // Per-page sheets: status flip is done via mirror (bm_tracking_bot
      // would also flip, but it'll skip due to greg-handled marker — see
      // below). For the page sheet date, do it directly.
      if (overrideDate) {
        for (const handle of sessionHandles) {
          const pageSheetId = pagesRegistry.getSheetId(handle);
          if (!pageSheetId || PLACEHOLDER_PATTERN.test(pageSheetId)) continue;
          try {
            await updateAdDate(pageSheetId, PAGE_TAB_NAME, [handle], clientName, overrideDate, false);
          } catch (e) { console.error(`[postedHandler] @${handle} sheet date:`, e.message); }
        }
      }

      // 3. Mirror to Internal Network Ads as a reply to the original
      //    brief (greg-handled marker prevents bm_tracking_bot from
      //    double-processing this as another Posted-on event).
      if (brief?.chatId && brief?.messageId) {
        const mirrorLines = [
          // Mirror the user's text verbatim — reads naturally in the chat
          text.trim(),
          "",
          GREG_TAG,
        ];
        try {
          await ctx.telegram.sendMessage(
            brief.chatId,
            mirrorLines.join("\n"),
            { reply_to_message_id: brief.messageId, disable_notification: true },
          );
          mirroredCount++;
        } catch (e) {
          console.error(`[postedHandler] mirror to internal failed for session ${sessionId}: ${e.message}`);
        }
      } else if (TARGET_CHAT_ID) {
        // Older session without internal_brief stashed (pre-migration).
        // Send as a fresh message rather than a reply — still gets the
        // audit trail, just without thread context.
        try {
          await ctx.telegram.sendMessage(
            TARGET_CHAT_ID,
            `${text.trim()}\n\n${GREG_TAG}`,
            { disable_notification: true },
          );
          mirroredCount++;
        } catch (e) {
          console.error(`[postedHandler] mirror (no brief ref) failed: ${e.message}`);
        }
      }

      replyParts.push(
        `✅ @${ads.map((a) => a.page_handle).join(", @")} — ${clientName || "unknown client"}` +
        (overrideDate ? ` (date: ${overrideDate})` : "")
      );
    }

    // 4. Reply to the contributor
    const lines = [
      `✅ *Marked live for ${replyParts.length} ad${replyParts.length === 1 ? "" : "s"}*`,
      "",
      ...replyParts,
      "",
      `📊 Master sheet: ${totalSheetRows} row(s) updated`,
      mirroredCount > 0
        ? `💬 Confirmation mirrored to Internal Network Ads`
        : `⚠️ Couldn't mirror to Internal Network Ads (chat not configured)`,
    ];
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  } catch (e) {
    console.error("[postedHandler] confirmation handler error:", e.message);
    try { await ctx.reply("⚠️ Something went wrong processing that confirmation."); } catch {}
  }
}

module.exports = { shouldHandle, handlePostedDM, handlePostedCallback };
