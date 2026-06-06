#!/usr/bin/env node
/**
 * Synthetic test for filterBundleToBriefPages — the fix for the
 * Stake-after-Knicks orphan-attribution bug (2026-06-06).
 *
 * Scenario: Ivan posts Knicks @-named covers + slides + caption + an
 * "@goal^" mislabel + a Stake brief. The filename scanner walks backwards,
 * finds the 3 Knicks @-named files, returns them as byHandle attribution.
 * But those 3 handles aren't in the Stake brief's page list — they're
 * orphans from a missing brief.
 *
 * Pre-fix: 3 orphan handles → ambiguity detector fires (3 < 12) → brief
 *          paused, never forwarded.
 * Post-fix: filter drops all 3, bundle becomes null, label scanner runs.
 *           If label scanner also returns nothing valid, standard fallback
 *           kicks in and brief forwards.
 */

const path = require("path");

// Hack: stub out pagesRegistry so adHandler.js doesn't actually call Supabase.
const Module = require("module");
const origResolve = Module._resolve_filename || Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === "../lib/pagesRegistry") return path.join(__dirname, "_stub-pagesRegistry.js");
  return origResolve.call(this, req, ...rest);
};

// Stub registry that's a no-op resolver.
require.cache[path.join(__dirname, "_stub-pagesRegistry.js")] = {
  id: path.join(__dirname, "_stub-pagesRegistry.js"),
  filename: path.join(__dirname, "_stub-pagesRegistry.js"),
  loaded: true,
  exports: { resolveHandle: (h) => h?.toLowerCase() },
};

// We can't easily import the un-exported helper, so re-implement it inline
// for this test (kept in sync with the version in adHandler.js).
function filterBundleToBriefPages(bundle, briefHandleSet) {
  if (!bundle?.byHandle || bundle.byHandle.size === 0) return bundle;
  if (!briefHandleSet || briefHandleSet.size === 0) return bundle;
  const filtered = new Map();
  const dropped  = [];
  for (const [handle, b] of bundle.byHandle) {
    if (briefHandleSet.has(handle.toLowerCase())) {
      filtered.set(handle, b);
    } else {
      dropped.push(handle);
    }
  }
  if (dropped.length > 0) {
    console.log(`  [filter] dropped ${dropped.length}: ${dropped.map((h) => "@" + h).join(", ")}`);
  }
  if (filtered.size === 0) return null;
  return { ...bundle, byHandle: filtered };
}

function assert(cond, msg) {
  if (cond) {
    console.log("✅", msg);
  } else {
    console.error("❌", msg);
    process.exitCode = 1;
  }
}

// ── Test 1: Stake brief, Knicks @-named covers leaked in ─────────────────
console.log("\nTest 1: Stake brief w/ orphan Knicks attribution");
{
  const bundle = {
    byHandle: new Map([
      ["thefuck.tv",     { media: [{ document: { file_name: "@thefuck.tv.jpg" } }], caption: null }],
      ["psychological",  { media: [{ document: { file_name: "@psychological.jpg" } }], caption: null }],
      ["oddlyhorrifying",{ media: [{ document: { file_name: "@oddlyhorrifying.jpg" } }], caption: null }],
    ]),
    shared: { media: [{ photo: ["bet_slip"] }], caption: "The Knicks just walked into..." },
  };
  // Stake's 12 pages — none of the Knicks 3 are in here
  const stakeHandles = new Set([
    "moist", "childhoodpost", "howeverythingworks", "dailyhumor_4u",
    "i_have_no_memes96_v2", "marvelmovies", "hoodreels", "goal",
    "hitsblunt", "dailyhoodposts", "californiacandidates", "mensonly",
  ]);
  const filtered = filterBundleToBriefPages(bundle, stakeHandles);
  assert(filtered === null, "0 valid handles → returns null (caller falls through to next scanner)");
}

// ── Test 2: Partial overlap (1 of 3 Knicks @-files happens to be in Stake) ─
console.log("\nTest 2: Partial overlap (1 valid handle, 2 orphans)");
{
  const bundle = {
    byHandle: new Map([
      ["thefuck.tv",      { media: [{ document: { file_name: "@thefuck.tv.jpg" } }], caption: null }],
      ["psychological",   { media: [{ document: { file_name: "@psychological.jpg" } }], caption: null }],
      ["oddlyhorrifying", { media: [{ document: { file_name: "@oddlyhorrifying.jpg" } }], caption: null }],
    ]),
    shared: { media: [], caption: null },
  };
  // Stake list happens to include thefuck.tv
  const stakeHandles = new Set(["moist", "thefuck.tv", "hoodreels"]);
  const filtered = filterBundleToBriefPages(bundle, stakeHandles);
  assert(filtered !== null,                            "1 valid handle → returns non-null bundle");
  assert(filtered.byHandle.size === 1,                 "byHandle reduced to 1 entry");
  assert(filtered.byHandle.has("thefuck.tv"),          "thefuck.tv preserved");
  assert(!filtered.byHandle.has("psychological"),      "psychological dropped");
  assert(!filtered.byHandle.has("oddlyhorrifying"),    "oddlyhorrifying dropped");
  assert(filtered.shared === bundle.shared,            "shared bundle untouched (not affected by filter)");
}

// ── Test 3: All handles valid (happy path — normal Danielson brief) ──────
console.log("\nTest 3: Happy path — all 3 handles are in brief's page list");
{
  const bundle = {
    byHandle: new Map([
      ["thefuck.tv",      { media: [{ document: { file_name: "@thefuck.tv.jpg" } }], caption: null }],
      ["psychological",   { media: [{ document: { file_name: "@psychological.jpg" } }], caption: null }],
      ["oddlyhorrifying", { media: [{ document: { file_name: "@oddlyhorrifying.jpg" } }], caption: null }],
    ]),
    shared: { media: [], caption: null },
  };
  const knicksHandles = new Set(["thefuck.tv", "psychological", "oddlyhorrifying"]);
  const filtered = filterBundleToBriefPages(bundle, knicksHandles);
  assert(filtered === bundle || filtered.byHandle.size === 3,
    "All 3 valid → bundle preserved with all 3 entries");
}

// ── Test 4: Null bundle (collab scanner declined) ────────────────────────
console.log("\nTest 4: Null bundle in → null bundle out");
{
  const filtered = filterBundleToBriefPages(null, new Set(["moist"]));
  assert(filtered === null, "null bundle returns null");
}

// ── Test 5: Empty briefHandleSet (degenerate — should pass through) ──────
console.log("\nTest 5: Empty briefHandleSet → bundle returned unchanged (no filtering)");
{
  const bundle = {
    byHandle: new Map([["abc", { media: [], caption: null }]]),
    shared: { media: [], caption: null },
  };
  const filtered = filterBundleToBriefPages(bundle, new Set());
  assert(filtered === bundle, "Degenerate empty set returns bundle unchanged (safety, no false drops)");
}

console.log("\n" + (process.exitCode ? "❌ Some tests failed" : "✅ All tests passed"));
