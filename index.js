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
const { addMessage, hydrateFromDb } = require("./messageBuffer");
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
const { handleResolveCommand, handleAssignmentCallback } = require("./handlers/resolveHandler");
bot.command("resolve", handleResolveCommand);
bot.action(/^ca:[0-9a-f-]+:[^:]+:.+$/, handleAssignmentCallback);

// ── Passive listener — fires on every message ─────────────────────────────────
// 1. Feed every message into the rolling buffer (needed for content forwarding)
// 2. Run the ad handler (ignores non-ads and non-target chats internally)
bot.on("message", (ctx) => {
  if (ctx.message) addMessage(ctx.message);
  handleAuditCommand(ctx); // reply-based audit commands (price update / takedown / creative update)
  handleAdMessage(ctx);    // new ad detection + sheet logging + forwarding
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
