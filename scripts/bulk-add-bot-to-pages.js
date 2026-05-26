#!/usr/bin/env node
/**
 * scripts/bulk-add-bot-to-pages.js
 *
 * Adds @bm_tracking_bot to every chat referenced in the pages registry
 * table (chat_id NOT NULL), using the operations Telegram user account
 * via gramJS. Operations is admin in every IG Ads chat by creation, so
 * the invite call succeeds without manual per-chat permission grants.
 *
 * Idempotent: if the bot is already in a chat, Telegram returns
 * USER_ALREADY_PARTICIPANT and we log + skip.
 *
 * Usage:
 *   # Dry run — show what would be invited, don't actually invite
 *   node scripts/bulk-add-bot-to-pages.js --dry-run
 *
 *   # Real run
 *   node scripts/bulk-add-bot-to-pages.js
 *
 *   # Override which bot to invite (default: bm_tracking_bot)
 *   BOT_USERNAME=bm_tracking_bot node scripts/bulk-add-bot-to-pages.js
 *
 * Prereqs (all env vars set):
 *   OPS_TELEGRAM_API_ID
 *   OPS_TELEGRAM_API_HASH
 *   OPS_TELEGRAM_SESSION      ← must be a FRESH, non-revoked session
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Run locally — not on Railway. Loads .env if present.
 */

require("dotenv").config();
const { Api } = require("telegram");
const userClient = require("../userClient");
const sessions   = require("../lib/sessions");

const DRY_RUN     = process.argv.includes("--dry-run");
const BOT_USERNAME = (process.env.BOT_USERNAME || "bm_tracking_bot").replace(/^@/, "");

async function main() {
  if (!sessions._supabase) {
    console.error("❌ Supabase not configured. Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }

  const client = await userClient.getOpsClient();
  if (!client) {
    console.error(
      "❌ Ops client unavailable. Set OPS_TELEGRAM_API_ID, OPS_TELEGRAM_API_HASH, " +
      "OPS_TELEGRAM_SESSION (run setup-session.js --ops if you don't have one).",
    );
    process.exit(1);
  }
  console.log("✅ Ops client connected\n");

  // Resolve the bot entity once
  let botEntity;
  try {
    botEntity = await client.getEntity(BOT_USERNAME);
    console.log(`🤖 Bot: @${BOT_USERNAME} (id=${botEntity.id})\n`);
  } catch (e) {
    console.error(`❌ Couldn't resolve @${BOT_USERNAME}: ${e.message}`);
    console.error("   The ops account needs to have seen this bot before (DM it once if not).");
    process.exit(1);
  }

  // Pull pages with a chat_id from the registry
  const { data: pages, error } = await sessions._supabase
    .from("pages")
    .select("handle, chat_id, auto_forward")
    .not("chat_id", "is", null)
    .order("handle");
  if (error) {
    console.error(`❌ Supabase read failed: ${error.message}`);
    process.exit(1);
  }
  console.log(`📋 Found ${pages.length} pages with chat_id in registry\n`);

  if (DRY_RUN) console.log("─── DRY RUN — no invites will be sent ───\n");

  const counts = { invited: 0, alreadyIn: 0, failed: 0, skipped: 0 };
  const failures = [];

  for (const page of pages) {
    const chatId = page.chat_id;
    const label  = `@${page.handle} (${chatId})`;

    let entity;
    try {
      entity = await client.getEntity(chatId);
    } catch (e) {
      counts.failed++;
      failures.push({ label, reason: `entity fetch: ${e.message}` });
      console.warn(`⚠️  ${label}: can't fetch entity — ${e.message}`);
      continue;
    }

    if (DRY_RUN) {
      console.log(`   ${label} (would invite to "${entity.title || entity.username || '?'}")`);
      counts.skipped++;
      continue;
    }

    try {
      if (entity.className === "Channel") {
        // Supergroup or broadcast channel
        await client.invoke(new Api.channels.InviteToChannel({
          channel: entity,
          users:   [botEntity],
        }));
      } else if (entity.className === "Chat") {
        // Legacy basic group
        await client.invoke(new Api.messages.AddChatUser({
          chatId:   entity.id,
          userId:   botEntity,
          fwdLimit: 0,
        }));
      } else {
        counts.failed++;
        failures.push({ label, reason: `unsupported entity type: ${entity.className}` });
        console.warn(`⚠️  ${label}: entity is ${entity.className} (not Channel/Chat) — skipping`);
        continue;
      }

      counts.invited++;
      console.log(`✅ ${label} — invited`);
    } catch (e) {
      const msg = e.message || String(e);
      if (/USER_ALREADY_PARTICIPANT|ALREADY_PARTICIPANT/i.test(msg)) {
        counts.alreadyIn++;
        console.log(`✓  ${label} — already in`);
      } else if (/USER_PRIVACY_RESTRICTED|USER_BANNED_IN_CHANNEL/i.test(msg)) {
        counts.failed++;
        failures.push({ label, reason: msg });
        console.warn(`⚠️  ${label}: ${msg} (privacy / banned — needs manual add)`);
      } else if (/CHAT_ADMIN_REQUIRED|CHAT_WRITE_FORBIDDEN/i.test(msg)) {
        counts.failed++;
        failures.push({ label, reason: msg });
        console.warn(`⚠️  ${label}: ${msg} (ops account isn't admin — manual add needed)`);
      } else {
        counts.failed++;
        failures.push({ label, reason: msg });
        console.warn(`⚠️  ${label}: ${msg}`);
      }
    }

    // Polite delay so we don't flood the API and trigger flood-wait
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log("\n─── Summary ───");
  console.log(`✅ Invited:    ${counts.invited}`);
  console.log(`✓  Already in: ${counts.alreadyIn}`);
  console.log(`⏭️  Skipped:    ${counts.skipped}${DRY_RUN ? " (dry run)" : ""}`);
  console.log(`⚠️  Failed:     ${counts.failed}`);

  if (failures.length > 0) {
    console.log("\nFailures — these need manual review:");
    for (const f of failures) console.log(`  · ${f.label}: ${f.reason}`);
  }

  await userClient.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error("❌ Fatal:", e);
  process.exit(1);
});
