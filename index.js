require("dotenv").config();

// ── Cleanup mode — set CLEANUP_MODE=true in Railway env vars, redeploy,
// watch the logs, then remove the var and redeploy again to restore normal operation.
if (process.env.CLEANUP_MODE === "true") {
  require("./cleanup-bad-rows").runCleanup().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
  return;
}

const http = require("http");
const cron = require("node-cron");
const { Telegraf } = require("telegraf");
const { handleAdMessage }    = require("./handlers/adHandler");
const { handleAuditCommand } = require("./handlers/auditHandler");
const { addMessage, updateMessage, hydrateFromDb } = require("./messageBuffer");
const { checkAndFireReminders } = require("./reminders");

// ── Validate required env vars ─────────────────────────────────────────────────
const required = ["TELEGRAM_BOT_TOKEN", "TARGET_CHAT_ID", "MASTER_SHEET_ID"];
const missing  = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`❌ Missing required env vars: ${missing.join(", ")}`);
  process.exit(1);
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// ── /resolve — interactive cover-to-page assignment for ambiguous briefs ─────
// Used when a brief lists N pages but only some covers were @-labeled.
// Operator runs /resolve in DM with bm_tracking_bot, gets each unattributed
// cover with inline page-buttons. Each tap saves to pending_brief_assignments.
// Phase 3 (queued #36) wires the "all assigned" terminal state into actual
// re-forwarding. For now it just produces the mapping for manual /replay.
const { handleResolveCommand, handleAssignmentCallback, remindAwaitingSessions } = require("./handlers/resolveHandler");
// Where paused-ad reminders go when a session has no prompt_chat_id — the
// Monetization Team + AI chat.
const RESOLVE_ALERT_CHAT_ID = (process.env.RESOLVE_ALERT_CHAT_ID || process.env.SALES_TEAM_CHAT_ID || "").trim() || null;
bot.command("resolve", handleResolveCommand);
bot.action(/^ca:[0-9a-f-]+:[^:]+:.+$/, handleAssignmentCallback);

// ── /update — unified brief mutation (price, name; more subcommands TODO) ────
// Reply to a brief in Internal Network Ads then:
//   /update price @handle $X   — update a page's price (sheets + DB + chat edit)
//   /update name <new name>    — rename the brief client everywhere
// See handlers/updateHandler.js + task #31.
const { handleUpdateCommand } = require("./handlers/updateHandler");
bot.command("update", handleUpdateCommand);

// ── /editbrief — surgical edit of ONE bot-sent message via Telegram link ─────
// Manual escape hatch for past briefs with NULL forwarded_message_ids.
// `/editbrief <link>` + new text on the next lines. See handlers/editBriefHandler.js.
const { handleEditBriefCommand, maybeConsumePendingEdit } = require("./handlers/editBriefHandler");
bot.command("editbrief", handleEditBriefCommand);

// ── Reply-with-creative shortcut ─────────────────────────────────────────────
// Reply to a brief with a creative named `@page.jpg` (or caption `@page …`) and
// the bot forwards just that creative to that page's chat — the clean way to
// add a forgotten cover without deleting + re-sending the whole brief.
// See handlers/creativeReplyHandler.js.
const { handleCreativeReply } = require("./handlers/creativeReplyHandler");

// ── Passive listener — fires on every message ─────────────────────────────────
// 1. Feed every message into the rolling buffer (needed for content forwarding)
// 2. Run the ad handler (ignores non-ads and non-target chats internally)
bot.on("message", async (ctx) => {
  if (ctx.message) addMessage(ctx.message);
  // /editbrief two-message flow: if admin recently sent `/editbrief <link>`
  // alone and this is their next message, consume it as the new text + edit.
  // Short-circuits the rest of the message handlers when consumed.
  try {
    const consumed = await maybeConsumePendingEdit(ctx);
    if (consumed) return;
  } catch (err) { console.error("[editbrief] consume error:", err.message); }
  // Reply-with-creative: a media reply to a brief naming @page.jpg routes the
  // creative straight to that page. Short-circuits when consumed so the media
  // doesn't fall through to ad detection.
  try {
    const consumed = await handleCreativeReply(ctx);
    if (consumed) return;
  } catch (err) { console.error("[creativeReply] error:", err.message); }
  handleAuditCommand(ctx); // reply-based audit commands (price update / takedown / creative update)
  handleAdMessage(ctx);    // new ad detection + sheet logging + forwarding
});

// ── Edit listener — propagate caption/text edits into the buffer ─────────────
// Without this, /replay and /resolve forward the pre-edit text forever
// (e.g. Danielson edited "Any caption works" → "How did we end up back here?"
// and our buffer kept the original). Updates in-memory + persists to DB.
bot.on("edited_message", (ctx) => {
  if (ctx.editedMessage) updateMessage(ctx.editedMessage);
});

// ── Auto-capture chat IDs when bot is added to a new chat ────────────────────
// Telegram fires my_chat_member whenever the bot's membership status changes
// in a chat — including being added. We listen, then DM Connor with the chat
// ID + title so he can paste it into /admin/page-registry without ever
// having to look up the ID manually. Replaces the user-account search flow
// that kept getting SESSION_REVOKED.
//
// Filter: only on "joined" transitions (was outsider, now a member) — not on
// every routine permission change. Bot can only be added by a human, so this
// fires at most once per chat onboarding.
bot.on("my_chat_member", async (ctx) => {
  try {
    const upd     = ctx.myChatMember;
    const oldS    = upd?.old_chat_member?.status;
    const newS    = upd?.new_chat_member?.status;
    const isJoin  = (oldS === "left" || oldS === "kicked") &&
                    (newS === "member" || newS === "administrator");
    if (!isJoin) return;

    const chat    = upd.chat;
    const adder   = upd.from;
    const title   = chat.title || chat.username || "(untitled chat)";

    // Two ways to address the admin(s):
    //   1. WIZARD_ADMIN_USER_ID   — numeric ID (preferred, no DM-history dependency)
    //   2. WIZARD_ADMIN_HANDLES   — comma list of @usernames (existing convention)
    //
    // For (2), Telegram's sendMessage will only deliver to a @username if
    // the user has DM'd the bot at least once. If they haven't, Telegram
    // returns "Forbidden: bot can't initiate conversation with a user" and
    // we surface that in the logs so the admin knows to /start the bot.
    const adminIdRaw = parseInt(process.env.WIZARD_ADMIN_USER_ID || "0", 10);
    const adminHandles = (process.env.WIZARD_ADMIN_HANDLES || "")
      .split(",")
      .map((h) => h.trim().replace(/^@/, ""))
      .filter(Boolean);

    let recipients = [];
    if (adminIdRaw) recipients.push(adminIdRaw);
    else if (adminHandles.length) recipients = adminHandles.map((h) => `@${h}`);

    if (recipients.length === 0) {
      console.warn(`[my_chat_member] Bot added to "${title}" (${chat.id}) — no WIZARD_ADMIN_USER_ID or WIZARD_ADMIN_HANDLES, can't DM`);
      return;
    }

    const adderTag = adder?.username
      ? `@${adder.username}`
      : [adder?.first_name, adder?.last_name].filter(Boolean).join(" ") || `user ${adder?.id}`;

    const text =
      `📥 *Added to a new chat*\n\n` +
      `*Title:* ${title.replace(/[_*`\[]/g, (c) => "\\" + c)}\n` +
      `*Chat ID:* \`${chat.id}\`\n` +
      `*Type:* ${chat.type}\n` +
      `*Added by:* ${adderTag.replace(/[_*`\[]/g, (c) => "\\" + c)}\n\n` +
      `→ Paste \`${chat.id}\` into the page-registry row for whatever handle this is.\n` +
      `Or visit https://app.bolismedia.com/admin/page-registry to link it now.`;

    for (const recipient of recipients) {
      try {
        await ctx.telegram.sendMessage(recipient, text, { parse_mode: "Markdown" });
        console.log(`[my_chat_member] Bot joined "${title}" (${chat.id}) — DM'd ${recipient}`);
      } catch (err) {
        // Bots can't initiate conversation with users who've never DM'd them.
        // Surface this clearly so the admin knows the fix.
        if (/can't initiate conversation|chat not found|user not found/i.test(err.message)) {
          console.warn(
            `[my_chat_member] Couldn't DM ${recipient} for chat "${title}" (${chat.id}): ${err.message}\n` +
            `   → Have ${recipient} send /start to @bm_tracking_bot once, then retry.`,
          );
        } else {
          console.error(`[my_chat_member] DM ${recipient} failed: ${err.message}`);
        }
      }
    }
  } catch (e) {
    console.error(`[my_chat_member] error: ${e.message}`);
  }
});

// ── Persistent reminders — poll every 15 minutes ─────────────────────────────
// Fires overdue post-expiry / analytics check-in reminders stored in the
// "Reminders" tab on the master sheet (survives Railway restarts).
cron.schedule("*/15 * * * *", () => {
  checkAndFireReminders(bot.telegram).catch((err) =>
    console.error("[cron] reminders error:", err.message)
  );
});

// ── Paused-ad reminder — poll every 15 minutes ───────────────────────────────
// Re-pings the Monetization Team + AI chat about any cover-assignment session
// still stuck in "awaiting" (gentle, capped at a few nudges, ~30 min apart)
// so a paused ad never rots unseen. See resolveHandler.remindAwaitingSessions.
cron.schedule("*/15 * * * *", () => {
  remindAwaitingSessions(bot.telegram, RESOLVE_ALERT_CHAT_ID).catch((err) =>
    console.error("[cron] resolve-reminder error:", err.message)
  );
});

// ── Pending-brief worker — poll every 30 seconds ─────────────────────────────
// Picks up direct-posted briefs whose 2-min debounce window has elapsed,
// re-reads the latest text from message_buffer (post-edit if any), and runs
// the full handleAdMessage pipeline. See lib/pendingBriefs.js + task #47.
const pendingBriefs = require("./lib/pendingBriefs");
const { getMessages, pruneToLiveSet } = require("./messageBuffer");
const userClient = require("./userClient");
cron.schedule("*/30 * * * * *", async () => {
  try {
    const due = await pendingBriefs.claimDue();
    if (due.length === 0) return;
    console.log(`[cron] pending-briefs: ${due.length} due`);
    for (const row of due) {
      const chatIdStr = String(row.chat_id);

      // ── Live-state reconcile (Connor's "read the chat after 2 min" model) ──
      // Bots never get deletion events, so the buffer accumulates ghosts from
      // deleted brief copies / removed creatives. Before processing, ask the
      // sales_bolismedia user account for the chat's TRUE current message IDs
      // and drop any buffer ghosts. Whatever survived the 2-min wait is the
      // truth. Fails open: if the user session is down, we process the raw
      // buffer + the no-media / supersede guards still protect us.
      try {
        const liveIds = await userClient.getLiveMessageIds(row.chat_id, 80);
        if (liveIds && liveIds.length) {
          const { removed, kept } = pruneToLiveSet(chatIdStr, liveIds);
          if (removed > 0) {
            console.log(`[cron] 👻 reconciled ${chatIdStr}: dropped ${removed} ghost (deleted) msg(s), ${kept} live`);
          }
          // If the brief itself was deleted during the wait, don't forward.
          if (!liveIds.map(Number).includes(Number(row.message_id))) {
            console.log(`[cron] 🗑️  brief ${chatIdStr}/${row.message_id} no longer in chat (deleted) — skipping`);
            await pendingBriefs.markProcessed(row.chat_id, row.message_id);
            continue;
          }
        }
      } catch (err) {
        console.warn(`[cron] live-state reconcile skipped (user session?): ${err.message}`);
      }

      // Re-fetch the latest text from in-memory buffer — captures any edits
      // that arrived during the debounce window via bot.on("edited_message")
      const buf = getMessages(chatIdStr);
      const msg = buf.find((m) => m.message_id === Number(row.message_id));
      if (!msg) {
        console.warn(`[cron] pending-brief ${chatIdStr}/${row.message_id} not in buffer — marking failed`);
        await pendingBriefs.markFailed(row.chat_id, row.message_id, new Error("not in buffer"));
        continue;
      }
      // Synthetic Telegraf-shaped context for handleAdMessage
      const fakeCtx = {
        message:                  msg,
        chat:                     msg.chat,
        from:                     msg.from,
        telegram:                 bot.telegram,
        _isDeferredProcessing:    true, // prevents re-enqueueing in the defer gate
        reply: (text, extra) => bot.telegram.sendMessage(msg.chat.id, text, extra),
      };
      try {
        await handleAdMessage(fakeCtx);
        await pendingBriefs.markProcessed(row.chat_id, row.message_id);
        console.log(`[cron] ✅ processed pending brief ${chatIdStr}/${row.message_id}`);
      } catch (err) {
        console.error(`[cron] ❌ pending brief ${chatIdStr}/${row.message_id} failed: ${err.message}`);
        await pendingBriefs.markFailed(row.chat_id, row.message_id, err);
      }
    }
  } catch (err) {
    console.error(`[cron] pending-briefs worker error: ${err.message}`);
  }
});

// ── Launch: webhook on Railway, polling locally ───────────────────────────────
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT        = parseInt(process.env.PORT || "3000");

let server;

if (WEBHOOK_URL) {
  const webhookPath    = "/webhook";
  const webhookFullUrl = `${WEBHOOK_URL}${webhookPath}`;

  const { ingestWizardBrief } = require("./handlers/wizardIngestHandler");
  const INGEST_TOKEN = process.env.WIZARD_INGEST_TOKEN || "";

  server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === webhookPath) {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        res.writeHead(200);
        res.end("OK");
        try {
          const update = JSON.parse(body);
          await bot.handleUpdate(update);
        } catch (err) {
          console.error("Webhook handler error:", err.message);
        }
      });
    } else if (req.method === "POST" && req.url === "/api/ingest-wizard-brief") {
      // Greg → Tracker handoff for wizard-approved submissions.
      // Greg posts the brief + media to Internal Network Ads (since Greg
      // is a member there) then hands off to Tracker via this endpoint so
      // bm_tracking_bot can do per-page forwarding (it's in every IG Ads
      // chat) + write sheets + persist DB. Avoids needing Greg's bot to
      // join every page chat individually.
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          // Auth: shared secret in header
          const provided = req.headers["x-ingest-token"] || "";
          if (!INGEST_TOKEN || provided !== INGEST_TOKEN) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
            return;
          }
          const payload = JSON.parse(body);
          const result = await ingestWizardBrief(bot.telegram, payload);
          res.writeHead(result.ok ? 200 : 500, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          console.error("[ingest-wizard-brief]", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
    } else {
      res.writeHead(200);
      res.end("Revenue Sheet Workflow is running ✅");
    }
  });

  server.listen(PORT, async () => {
    console.log(`✅ HTTP server listening on port ${PORT}`);
    // Restore in-memory buffer from Supabase BEFORE registering the
    // webhook so the first brief post-redeploy can resolve its preceding
    // media. Without this, mid-flow redeploys wipe the buffer and the
    // brief lands with no media to attribute.
    try {
      await hydrateFromDb();
    } catch (err) {
      console.error("❌ messageBuffer hydration failed:", err.message);
    }
    try {
      await bot.telegram.setWebhook(webhookFullUrl, { drop_pending_updates: true });
      const info = await bot.telegram.getWebhookInfo();
      console.log(`✅ Webhook registered: ${info.url}`);
      if (info.last_error_message) {
        console.warn(`⚠️  Last webhook error: ${info.last_error_message}`);
      }
    } catch (err) {
      console.error("❌ Failed to register webhook:", err.message);
    }
  });
} else {
  // Local dev — hydrate before polling starts so /replay etc. work
  hydrateFromDb()
    .catch((err) => console.error("❌ messageBuffer hydration failed:", err.message))
    .finally(() => {
      bot.launch().then(() =>
        console.log("✅ Revenue Sheet Workflow running via polling (local dev)")
      );
    });
}

// In webhook mode bot.stop() throws "Bot is not running!" — just close the HTTP server gracefully
process.once("SIGINT",  () => { try { server?.close(); } catch (e) {} process.exit(0); });
process.once("SIGTERM", () => { try { server?.close(); } catch (e) {} process.exit(0); });

// Catch unhandled promise rejections so they don't silently crash the process
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
