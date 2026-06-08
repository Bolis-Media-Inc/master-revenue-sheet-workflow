#!/usr/bin/env node
/**
 * Regression test for the ambiguity-pause gate + no-media guard.
 *
 * Reproduces the Stake BET SLIP Day 19 disaster (2026-06-07):
 *   - 12-page brief
 *   - 9 pages had @<handle>.jpg covers (filename-attributed)
 *   - 3 pages had NO unique cover (just take the shared slides)
 *   - 7 shared "slides for ALL"
 *
 * PRE-FIX: ambiguousPartial fired (useFilenames && 9 < 12 && shared > 0)
 *          → brief PAUSED → never forwarded. A later media-less re-post
 *          then force-forwarded empty content to all 12 pages.
 *
 * POST-FIX: filename-attributed partial coverage does NOT pause. And a
 *           media-less multi-page brief is SKIPPED, not force-forwarded.
 *
 * These mirror the inline conditions in handlers/adHandler.js. Kept in
 * sync by hand — if you change the gate, update both.
 */

function assert(cond, msg) {
  console.log(cond ? "✅" : "❌", msg);
  if (!cond) process.exitCode = 1;
}

// ── Replicate the (fixed) ambiguity conditions ───────────────────────────
function computeAmbiguity({ useFilenames, detectedFormat, briefHandleCount, attributedCount, sharedMediaCount }) {
  // FIXED: ambiguousPartial is disabled — filename attribution is unambiguous.
  const ambiguousPartial = false;
  const ambiguousNoLabels =
    detectedFormat === "standard" &&
    briefHandleCount >= 2 &&
    sharedMediaCount >= briefHandleCount;
  const ambiguousLabelMiss =
    detectedFormat === "per-page-label" &&
    briefHandleCount > 1 &&
    attributedCount < briefHandleCount &&
    sharedMediaCount > 0;
  return ambiguousPartial || ambiguousNoLabels || ambiguousLabelMiss;
}

function computeNoMediaSkip({ attributedCount, sharedMediaCount, fallbackCount, uniquePages }) {
  const noMediaAtAll = attributedCount === 0 && sharedMediaCount === 0 && fallbackCount === 0;
  return noMediaAtAll && uniquePages >= 2;
}

console.log("\n── Test 1: Day 19 first copy (9 covers, 12 pages, 7 shared) ──");
{
  const isAmbiguous = computeAmbiguity({
    useFilenames: true, detectedFormat: "filename-attributed",
    briefHandleCount: 12, attributedCount: 9, sharedMediaCount: 7,
  });
  assert(isAmbiguous === false,
    "Filename-attributed partial coverage does NOT pause (covered pages get cover+shared, uncovered get shared-only)");
}

console.log("\n── Test 2: Day 19 third copy (standard, 0 media, 12 pages) ──");
{
  const skip = computeNoMediaSkip({
    attributedCount: 0, sharedMediaCount: 0, fallbackCount: 0, uniquePages: 12,
  });
  assert(skip === true,
    "Media-less multi-page brief is SKIPPED, not force-forwarded as empty content");
}

console.log("\n── Test 3: genuine no-labels pile (12 unnamed covers, 12 pages) ──");
{
  const isAmbiguous = computeAmbiguity({
    useFilenames: false, detectedFormat: "standard",
    briefHandleCount: 12, attributedCount: 0, sharedMediaCount: 12,
  });
  assert(isAmbiguous === true,
    "A pile of UNNAMED covers (1 per page) STILL pauses for /resolve (genuine ambiguity preserved)");
}

console.log("\n── Test 4: single-page brief, no media ──");
{
  const skip = computeNoMediaSkip({
    attributedCount: 0, sharedMediaCount: 0, fallbackCount: 0, uniquePages: 1,
  });
  assert(skip === false,
    "Single-page media-less brief is NOT skipped (guard only applies to multi-page)");
}

console.log("\n── Test 5: all 12 pages covered (full filename coverage) ──");
{
  const isAmbiguous = computeAmbiguity({
    useFilenames: true, detectedFormat: "filename-attributed",
    briefHandleCount: 12, attributedCount: 12, sharedMediaCount: 0,
  });
  assert(isAmbiguous === false, "Fully-covered filename brief forwards normally");
}

console.log("\n── Test 6: healthy brief with media is NOT skipped ──");
{
  const skip = computeNoMediaSkip({
    attributedCount: 9, sharedMediaCount: 7, fallbackCount: 0, uniquePages: 12,
  });
  assert(skip === false, "Brief WITH media (9 covers + 7 shared) forwards normally");
}

console.log("\n" + (process.exitCode ? "❌ Some tests failed" : "✅ All tests passed"));
