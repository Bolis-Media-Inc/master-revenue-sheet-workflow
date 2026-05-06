/**
 * scripts/audit-telegram-destinations.js
 *
 * Compares config/telegram-destinations.json against the live Telegram chat
 * list (from data discovered via the @sales_bolismedia user account) and:
 *   - Flags pages currently pointed at "AI TEST" chats
 *   - Suggests the real IG Ads chat ID for each page
 *   - Lists IG Ads chats that exist on Telegram but aren't in the config yet
 *
 * Usage:
 *   node scripts/audit-telegram-destinations.js
 *
 * Note: this script does NOT call Telegram. It uses a hardcoded snapshot of
 * chats taken when run; refresh by pasting fresh `list_chats` output into
 * KNOWN_CHATS below.
 */

const fs   = require("fs");
const path = require("path");

const DEST_PATH = path.join(__dirname, "..", "config", "telegram-destinations.json");

// Snapshot of live IG Ads chats (paste fresh list from telegram MCP `list_chats`)
// Format: { chatId, name }
const KNOWN_CHATS = [
  { id: -1003293539856, name: "@moist IG Ads" },
  { id: -1001841553143, name: "@imbeingsarcastic IG Ads" },
  { id: -1002049532040, name: "@whatsif IG Ads" },
  { id: -1001805483404, name: "@northwitch69 IG Ads" },
  { id: -1002004096130, name: "@hoereacts IG Ads" },
  { id: -1002058818155, name: "@bitchyquotes IG Ads" },
  { id: -1002430472646, name: "@oddlyhorrifying IG Ads" },
  { id: -1001860511555, name: "@faillgram IG Ads" },
  { id: -1001765030106, name: "@scooby IG Ads" },
  { id: -1002646643959, name: "@childhoodpost IG Ads" },
  { id: -1003232793711, name: "@dailyhumor_4u IG Ads" },
  { id: -1001575437749, name: "@thefuck.tv IG Ads" },
  { id: -1002124766934, name: "@psychological IG Ads" },
  { id: -1001801499125, name: "@dailyhoodposts IG Ads" },
  { id: -1002120390092, name: "@i_have_no_memes96_v2 IG Ads" },
  { id: -1002426861571, name: "@hoodreels IG Ads" },
  { id: -1002538694071, name: "@howeverythingworks IG Ads" },
  { id: -1003527726967, name: "@physicsuncovered IG Ads" },
  { id: -4518413558,    name: "@historic IG Ads" },
  { id: -1003659689883, name: "@hauntedfootage IG Ads" },
  { id: -1003891018165, name: "@soda IG Ads" },
  { id: -1002017246409, name: "@hitsblunt IG Ads" },
  { id: -4154960404,    name: "@unforgettablesportsmoments IG Ads" },
  { id: -1003710900353, name: "@hoopsxcenter IG Ads Chat" },
  { id: -1003896773405, name: "@dopejukes IG Ads" },
  { id: -1002458029900, name: "@marvelmovies IG Ads" },
  { id: -1001888440710, name: "@bitchy.tweets IG Ads" },
  { id: -1001163243075, name: "@memedwyd IG Ads" },
  { id: -1001936590769, name: "@tinderreels IG Ads" },
  { id: -1001560870573, name: "@bestofhumors IG Ads" },
  { id: -1001734112546, name: "@popdownload IG Ads" },
  { id: -1001828303871, name: "@greatestmediamoments IG Ads" },
  { id: -1003748086461, name: "@dankquillius IG Ads" },
  { id: -1003068531615, name: "@artistswithoutautotune IG Ads" },
  { id: -1002047763087, name: "@secrets.jp IG Ads" },
  { id: -5032835844,    name: "@motorchive IG Ads" },
  { id: -1001304130907, name: "@Zer ASK IG Ads" },
  { id: -1002031821630, name: "@crankybitchprobs IG Ads" },
  { id: -1001322852192, name: "@selfcaresis IG Ads" },
  { id: -1002072000856, name: "@itstumblrhumor IG Ads" },
  { id: -4948060394,    name: "@goal IG Ads" },
  { id: -1001992195167, name: "@tonsil IG Ads" },
  { id: -1002076362386, name: "@databases IG Ads" },
  { id: -4588095782,    name: "@answerallquestions IG Ads" },
  { id: -1002323473417, name: "@factmayor IG Ads" },
  { id: -1001261098605, name: "@relatablegirlymemes IG Ads" },
  { id: -1003719483553, name: "@forged_over_40 IG Ads" },
  { id: -1003676743403, name: "@nflmemss IG Ads" },
  { id: -4124009890,    name: "@archivedrunway IG Ads" },
  { id: -1002516662892, name: "@rapperswithoutautotune IG Ads" },
  { id: -1002609139593, name: "@musicbeforeautotune IG Ads" },
  { id: -1001609628938, name: "@memerats IG Ads" },
];

// Extract the page handle from "@handle IG Ads" or "@handle IG Ads Chat"
function nameToHandle(chatName) {
  const m = chatName.match(/^@([\w.]+)\s+IG Ads/i);
  return m ? m[1].toLowerCase() : null;
}

function main() {
  // Build live handle → chatId map
  const liveMap = new Map();
  for (const chat of KNOWN_CHATS) {
    const h = nameToHandle(chat.name);
    if (!h) continue;
    if (liveMap.has(h)) {
      console.warn(`⚠️  Duplicate live chat for @${h}:`);
      console.warn(`     ${liveMap.get(h)}`);
      console.warn(`     ${chat.id}  (${chat.name})`);
    } else {
      liveMap.set(h, chat.id);
    }
  }

  const config = JSON.parse(fs.readFileSync(DEST_PATH, "utf-8"));

  console.log("─".repeat(60));
  console.log("🔍 TELEGRAM DESTINATIONS AUDIT");
  console.log("─".repeat(60));

  const wrongMappings  = [];
  const placeholders   = [];
  const correct        = [];
  const newPages       = [];

  for (const [handle, configId] of Object.entries(config)) {
    if (handle.startsWith("_")) continue;
    const liveId = liveMap.get(handle);
    const configIdNum = typeof configId === "number" ? configId : parseInt(configId, 10);

    if (typeof configId === "string" && /^TELEGRAM_CHAT_ID_/.test(configId)) {
      placeholders.push({ handle, liveId });
    } else if (liveId && liveId !== configIdNum) {
      // Find what the configId actually IS in the live snapshot
      const wrongChat = KNOWN_CHATS.find((c) => c.id === configIdNum);
      wrongMappings.push({
        handle,
        configId: configIdNum,
        configChatName: wrongChat?.name || "(unknown / AI TEST?)",
        correctId: liveId,
      });
    } else if (liveId === configIdNum) {
      correct.push({ handle, id: liveId });
    }
  }

  // Pages with live IG Ads chats but not in config
  for (const [handle, liveId] of liveMap.entries()) {
    if (!(handle in config)) {
      newPages.push({ handle, liveId });
    }
  }

  if (wrongMappings.length) {
    console.log(`\n🚨 WRONG MAPPINGS (${wrongMappings.length}) — config points at wrong chat:`);
    wrongMappings.forEach(({ handle, configId, configChatName, correctId }) => {
      console.log(`   ${handle}`);
      console.log(`     currently: ${configId}  →  "${configChatName}"`);
      console.log(`     should be: ${correctId}`);
    });
  }

  if (placeholders.length) {
    console.log(`\n📝 PLACEHOLDERS (${placeholders.length}) — config has TELEGRAM_CHAT_ID_*:`);
    placeholders.forEach(({ handle, liveId }) => {
      console.log(`   ${handle}  →  ${liveId || "(no live chat found)"}`);
    });
  }

  if (newPages.length) {
    console.log(`\n✨ NEW IG Ads chats found in Telegram (${newPages.length}) — not in config:`);
    newPages.forEach(({ handle, liveId }) => {
      console.log(`   ${handle.padEnd(30)} ${liveId}`);
    });
  }

  if (correct.length) {
    console.log(`\n✅ Correct (${correct.length}):`);
    correct.forEach(({ handle, id }) => console.log(`     ${handle.padEnd(30)} ${id}`));
  }

  console.log("\n" + "─".repeat(60));
  console.log(`Summary: ${correct.length} correct, ${wrongMappings.length} wrong, ${placeholders.length} placeholders, ${newPages.length} new`);
}

main();
