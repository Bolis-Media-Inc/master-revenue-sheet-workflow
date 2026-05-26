/**
 * setup-session.js — One-time Telegram session generator
 *
 * Run this ONCE on your local machine to authenticate a Telegram user
 * account and generate a gramjs session string for Railway.
 *
 * Two modes:
 *
 *   • SALES (default) — generates the @sales_bolismedia session.
 *     Reads TELEGRAM_API_ID / TELEGRAM_API_HASH from env, prints output
 *     keyed as TELEGRAM_SESSION=… for Railway.
 *
 *   • OPS — pass `--ops` (or `OPS=1`). Generates the operations account
 *     session. Reads OPS_TELEGRAM_API_ID / OPS_TELEGRAM_API_HASH, prints
 *     output keyed as OPS_TELEGRAM_SESSION=… so you can paste the
 *     variable name straight into Railway without renaming.
 *
 * Usage:
 *   TELEGRAM_API_ID=12345 TELEGRAM_API_HASH=abc123 node setup-session.js
 *   OPS_TELEGRAM_API_ID=98765 OPS_TELEGRAM_API_HASH=def456 node setup-session.js --ops
 */

require("dotenv").config();
const { TelegramClient } = require("telegram");
const { StringSession }  = require("telegram/sessions");
const readline           = require("readline");

const IS_OPS = process.argv.includes("--ops") || process.env.OPS === "1";

const API_ID_VAR    = IS_OPS ? "OPS_TELEGRAM_API_ID"   : "TELEGRAM_API_ID";
const API_HASH_VAR  = IS_OPS ? "OPS_TELEGRAM_API_HASH" : "TELEGRAM_API_HASH";
const SESSION_VAR   = IS_OPS ? "OPS_TELEGRAM_SESSION"  : "TELEGRAM_SESSION";
const ACCOUNT_LABEL = IS_OPS ? "operations account"    : "@sales_bolismedia";

const API_ID   = parseInt(process.env[API_ID_VAR]  || "0", 10);
const API_HASH = process.env[API_HASH_VAR]          || "";

if (!API_ID || !API_HASH) {
  console.error(`❌  Set ${API_ID_VAR} and ${API_HASH_VAR} before running.`);
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
    phoneNumber:  async () => await ask(`📞 Phone number for ${ACCOUNT_LABEL} (with country code, e.g. +1...): `),
    password:     async () => await ask("🔐 2FA password (leave blank if none): "),
    phoneCode:    async () => await ask("💬 Code Telegram just sent you: "),
    onError:      (err) => { console.error("❌ Auth error:", err.message); process.exit(1); },
  });

  const sessionString = client.session.save();

  console.log("\n✅ Authenticated successfully!\n");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("Add this to your Railway environment variables:\n");
  console.log(`${SESSION_VAR}=${sessionString}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  console.log("⚠️  Keep this string secret — it gives full account access.\n");

  await client.disconnect();
  rl.close();
  process.exit(0);
})();
