/**
 * setup-session.js — One-time Telegram session generator
 *
 * Run this ONCE on your local machine to authenticate @sales_bolismedia
 * and generate a session string. Then add that string to Railway as
 * TELEGRAM_SESSION env var. You never need to run this again unless
 * the session expires.
 *
 * Usage:
 *   TELEGRAM_API_ID=12345 TELEGRAM_API_HASH=abc123 node setup-session.js
 *
 * Or add those vars to your .env file first, then just:
 *   node setup-session.js
 */

require("dotenv").config();
const { TelegramClient } = require("telegram");
const { StringSession }  = require("telegram/sessions");
const readline           = require("readline");

const API_ID   = parseInt(process.env.TELEGRAM_API_ID  || "0", 10);
const API_HASH = process.env.TELEGRAM_API_HASH          || "";

if (!API_ID || !API_HASH) {
  console.error("❌  Set TELEGRAM_API_ID and TELEGRAM_API_HASH before running.");
  console.error("   Get them from: https://my.telegram.org");
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

(async () => {
  const session = new StringSession("");
  const client  = new TelegramClient(session, API_ID, API_HASH, { connectionRetries: 3 });

  console.log("\n📱 Connecting to Telegram...\n");

  await client.start({
    phoneNumber:  async () => await ask("📞 Phone number for @sales_bolismedia (with country code, e.g. +1...): "),
    password:     async () => await ask("🔐 2FA password (leave blank if none): "),
    phoneCode:    async () => await ask("💬 Code Telegram just sent you: "),
    onError:      (err) => { console.error("❌ Auth error:", err.message); process.exit(1); },
  });

  const sessionString = client.session.save();

  console.log("\n✅ Authenticated successfully!\n");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("Add this to your Railway environment variables:\n");
  console.log(`TELEGRAM_SESSION=${sessionString}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  console.log("⚠️  Keep this string secret — it gives full account access.\n");

  await client.disconnect();
  rl.close();
  process.exit(0);
})();
