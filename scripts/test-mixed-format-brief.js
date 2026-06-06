#!/usr/bin/env node
/**
 * Synthetic test for mixed-format briefs — the fix for the Stake World
 * Cup Day 13 failure (6/2/26, paused 13 rows).
 *
 * Layout (oldest → newest):
 *   @moist.jpg, @psychological.jpg, @thefuck.tv.jpg, ...   (12 covers)
 *   "Cover slides for all ^"
 *   HERO video                                              (shared)
 *   "2nd slide for all ^"
 *   World Cup body caption
 *   GOAL TEMPLATE png 1
 *   GOAL TEMPLATE png 2 (with caption "Kevin De Bruyne...")
 *   @goal ^                                                 ← LABEL
 *   Stake BET SLIP Day 13 brief                             (13 pages)
 *
 * Pre-fix: filename scanner found 12 @-named covers, useFilenames=true,
 *          label scanner never ran, @goal absent from byHandle,
 *          ambiguity detector paused the brief.
 * Post-fix: filename scanner also recognizes "@goal ^", attributes the
 *           immediately-preceding GOAL TEMPLATE png 2 to @goal.
 *           byHandle.size = 13 → matches briefHandleCount → no pause.
 */

const path = require("path");

// Need to wire up _buffers manually since we can't easily mock Telegram.
// Reach into the module to seed test data.
const buf = require(path.join(__dirname, "..", "messageBuffer.js"));

// Simulate the World Cup Stake brief layout.
const CHAT_ID = "test-internal-network-ads";

const messages = [
  // 12 per-page @-named covers (filename attribution)
  ...["moist", "childhoodpost", "howeverythingworks", "dailyhumor_4u",
      "i_have_no_memes96_v2", "marvelmovies", "hoodreels", "thefuck.tv",
      "oddlyhorrifying", "hitsblunt", "psychological", "dailyhoodposts"]
    .map((h, i) => ({
      message_id: 1000 + i,
      document: { file_name: `@${h}.jpg` },
    })),

  // "Cover slides for all ^" annotation — ignored by filename scanner
  { message_id: 1012, text: "Cover slides for all ^" },

  // HERO video (shared)
  { message_id: 1013, video: { file_name: "HERO.mp4" } },

  // "2nd slide for all ^" annotation
  { message_id: 1014, text: "2nd slide for all ^" },

  // World Cup body caption
  { message_id: 1015, text: "Stake just launched a CRAZY ad for the World Cup..." },

  // GOAL TEMPLATE png 1 — should go to shared (label only consumes one media going backwards)
  { message_id: 1016, document: { file_name: "GOAL TEMPLATE - 2026-06-02T131924.344.png" } },

  // GOAL TEMPLATE png 2 with caption — should go to @goal (closest to label)
  {
    message_id: 1017,
    document: { file_name: "GOAL TEMPLATE - 2026-06-02T131241.651.png" },
    caption: "Kevin De Bruyne and Luka Modrić met up before...\n\nOdds by @stake",
  },

  // @goal ^ label
  { message_id: 1018, text: "@goal ^" },

  // Brief
  {
    message_id: 1019,
    text: "Stake BET SLIP Day 13 - Affiliate - 3,175\n\n@sales_bolismedia\n@davogabriel\n\nINSTRUCTIONS:...",
  },
];

// Seed buffer
for (const m of messages) {
  // Use addMessage if exported; otherwise reach into _buffers
  if (typeof buf.addMessage === "function") {
    // addMessage takes a real Telegram message; for tests we monkey-mock minimal shape
    buf.addMessage({ chat: { id: CHAT_ID }, ...m });
  } else {
    // Fallback — try internal _buffers (won't work if private)
    throw new Error("Need to access _buffers internally");
  }
}

const briefId = 1019;

// Run the scanners
const filenameBundle = buf.getFilenameBundlesByPage(CHAT_ID, briefId);

console.log("\n── Filename scanner output ──────────────────────────");
if (!filenameBundle) {
  console.log("❌ scanner returned null (no @-filename attribution found)");
  process.exit(1);
}
console.log("byHandle.size:", filenameBundle.byHandle.size);
for (const [h, b] of filenameBundle.byHandle) {
  const files = b.media.map((m) =>
    m.document?.file_name || m.video?.file_name || "(unnamed)"
  );
  console.log(`  @${h}: ${files.join(", ")}${b.caption ? ` | caption: "${b.caption.slice(0,40)}..."` : ""}`);
}
console.log("\nshared.media:", filenameBundle.shared.media.map((m) =>
  m.document?.file_name || m.video?.file_name || "(unnamed)"
));
console.log("shared.caption:", filenameBundle.shared.caption?.slice(0, 60) || "(none)");

// Assertions
console.log("\n── Assertions ───────────────────────────────────────");
const expected13 = new Set([
  "moist", "childhoodpost", "howeverythingworks", "dailyhumor_4u",
  "i_have_no_memes96_v2", "marvelmovies", "hoodreels", "thefuck.tv",
  "oddlyhorrifying", "hitsblunt", "psychological", "dailyhoodposts", "goal",
]);

let pass = true;
function assert(cond, msg) {
  console.log((cond ? "✅" : "❌"), msg);
  if (!cond) pass = false;
}

assert(filenameBundle.byHandle.size === 13,
  `byHandle has 13 entries (got ${filenameBundle.byHandle.size}) — all pages attributed`);
assert(filenameBundle.byHandle.has("goal"),
  "@goal recognized via '@goal ^' label syntax");
assert(filenameBundle.byHandle.get("goal")?.media.length === 1,
  "@goal has 1 attributed media (the GOAL TEMPLATE png 2, closest to label)");
assert(filenameBundle.byHandle.get("goal")?.media[0]?.document?.file_name?.includes("131241"),
  "@goal's media is GOAL TEMPLATE png 2 (the one immediately preceding the label)");
assert(filenameBundle.byHandle.get("goal")?.caption?.includes("Kevin De Bruyne"),
  "@goal's caption captured from the png 2 caption");

for (const h of expected13) {
  assert(filenameBundle.byHandle.has(h), `@${h} present in byHandle`);
}

// Shared bundle should contain GOAL TEMPLATE png 1 and HERO video (the unattributed shared media)
const sharedNames = filenameBundle.shared.media.map((m) =>
  m.document?.file_name || m.video?.file_name || "(unnamed)"
);
assert(sharedNames.some((n) => n.includes("131924")),
  "GOAL TEMPLATE png 1 in shared.media (not attributed by label)");
assert(sharedNames.includes("HERO.mp4"),
  "HERO video in shared.media");

console.log("\n" + (pass ? "✅ All assertions passed — Ivan's brief would now forward correctly" : "❌ Some assertions failed"));
process.exit(pass ? 0 : 1);
