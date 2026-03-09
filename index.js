require("dotenv").config();
const http = require("http");
const { Telegraf } = require("telegraf");
const { handleAdMessage } = require("./handlers/adHandler");
const { addMessage }       = require("./messageBuffer");

// ── Validate required env vars ─────────────────────────────────────────────────
const required = ["TELEGRAM_BOT_TOKEN", "TARGET_CHAT_ID", "MASTER_SHEET_ID"];
const missing  = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`❌ Missing required env vars: ${missing.join(", ")}`);
  process.exit(1);
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// ── Passive listener — fires on every message ─────────────────────────────────
// 1. Feed every message into the rolling buffer (needed for content forwarding)
// 2. Run the ad handler (ignores non-ads and non-target chats internally)
bot.on("message", (ctx) => {
  if (ctx.message) addMessage(ctx.message);
  handleAdMessage(ctx);
});

// ── Launch: webhook on Railway, polling locally ───────────────────────────────
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT        = parseInt(process.env.PORT || "3000");

let server;

if (WEBHOOK_URL) {
  const webhookPath    = "/webhook";
  const webhookFullUrl = `${WEBHOOK_URL}${webhookPath}`;

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
    } else {
      res.writeHead(200);
      res.end("Revenue Sheet Workflow is running ✅");
    }
  });

  server.listen(PORT, async () => {
    console.log(`✅ HTTP server listening on port ${PORT}`);
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
  // Local dev
  bot.launch().then(() =>
    console.log("✅ Revenue Sheet Workflow running via polling (local dev)")
  );
}

// In webhook mode bot.stop() throws "Bot is not running!" — just close the HTTP server gracefully
process.once("SIGINT",  () => { try { server?.close(); } catch (e) {} process.exit(0); });
process.once("SIGTERM", () => { try { server?.close(); } catch (e) {} process.exit(0); });

// Catch unhandled promise rejections so they don't silently crash the process
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
