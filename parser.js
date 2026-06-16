/**
 * parser.js
 * Parses ad messages from the Internal Network Ads Telegram group.
 *
 * Expected message format:
 *
 *   {Client Name} - {Category} - ${Price}
 *
 *   @admin1 @admin2
 *
 *   **INSTRUCTIONS:**
 *   - feed / reels / carousel
 *   - 30min NIF / Perm post / etc.
 *
 *   **PAGE INFO:**
 *   [time] AZ / [time] EST   ← or "NOW / 4:45 PM AZ"
 *   @{page_handle} - ${price}
 *
 * Returns null if the message doesn't look like a valid ad.
 */

/**
 * @param {string} text  Raw Telegram message text
 * @param {Date}   date  Timestamp of the message
 * @returns {{ client, category, adPrice, pageHandle, postType, nif, datePosted, timeMST } | null}
 */
function parseAdMessage(text, date) {
  if (!text || typeof text !== "string") return null;

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;

  // Strip the Greg-tag marker if present so it doesn't interfere with parsing.
  // (Greg adds <!-- greg-handled --> as the first line for ads from /api/ad/intake.)
  if (/<!--\s*greg-handled\s*-->/i.test(lines[0])) {
    lines.shift();
    if (lines.length < 2) return null;
  }

  // ── Line 1: "{Client} - {Category} - ${amount}" ─────────────────────────────
  // Allows an optional trailing parenthetical note like "($3.50 CPM)" or
  // "(net $1,000)" — common for CPM/affiliate briefs where the headline
  // price is $0 and the actual rate is in the parens. Without this we
  // silently drop the brief at parse time (e.g. Danielson's "Justin
  // @FruitSnacks California Candidates - Politics - $0 ($3.50 CPM)").
  const headerMatch = lines[0].match(
    /^(.+?)\s*-\s*(.+?)\s*-\s*\$?([\d,]+(?:\.\d{1,2})?)(?:\s*\([^)]*\))?\s*$/
  );
  if (!headerMatch) return null;

  const client   = headerMatch[1].trim();
  let   category = headerMatch[2].trim();
  const adPrice  = parseFloat(headerMatch[3].replace(/,/g, ""));

  // ── Normalize category to the master sheet's Ad Type dropdown value ─────
  // Briefs type the category inconsistently — "E-com", "Ecom", "E-Commerce"
  // — which trips the sheet's data-validation list ("Invalid: input must be
  // an item on the specified list") and leaves the cell flagged. The only
  // recurring offender is the E-Com family, so normalize just that (leaving
  // every other category verbatim to avoid breaking valid values we're less
  // sure about). Extend CATEGORY_CANON as more variants surface.
  const CATEGORY_CANON = [
    { pat: /^e[-\s]?com(?:m(?:erce)?)?$/i, out: "E-Com" },
  ];
  for (const c of CATEGORY_CANON) {
    if (c.pat.test(category)) { category = c.out; break; }
  }

  // ── Header bulk/carousel index ─────────────────────────────────────────────
  // A brief may carry a bulk index between category and price:
  //   "OneOff - Affiliate - 1/4 - $500"  → category "Affiliate", bulk "1/4"
  // The header regex above greedily folds the "- 1/4" into the category, which
  // landed "Affiliate - 1/4" in the Ad Type column. Split it back out here and
  // use it as the Bulk # for any page that doesn't specify its own.
  let headerBulk = "";
  const catBulkMatch = category.match(/^(.+?)\s*-\s*(\d+\/\d+)\s*$/);
  if (catBulkMatch) { category = catBulkMatch[1].trim(); headerBulk = catBulkMatch[2]; }

  // ── PAGE INFO section ────────────────────────────────────────────────────────
  let timeMST  = "";
  const pageEntries = []; // { handle, price } — may be multiple for bulk ads

  const pageInfoIdx = lines.findIndex((l) =>
    l.replace(/\*/g, "").toLowerCase().includes("page info")
  );

  if (pageInfoIdx !== -1) {
    for (let i = pageInfoIdx + 1; i < lines.length; i++) {
      const line = lines[i];

      // Extract time: "NOW / 4:45 PM AZ" or "1-1:30pm AZ / 3pm EST" or "4:45 PM AZ"
      // or affiliate-style "7-8pm PST / 10-11pm EST".
      if (!timeMST) {
        if (/^now\b/i.test(line)) {
          timeMST = "NOW";
        } else {
          // Shared time-core: hour, optional ":MM", optional "-H[:MM]" range,
          // optional am/pm. Handles "7", "4:45", "7-8", "1-1:30", "6:30-7:30pm".
          // The leading (?<![\d:]) lookbehind is critical: without it, when the
          // hour doesn't line up the regex engine RESTARTS mid-number — e.g. it
          // matched "30" out of "6:30-7:30pm" and wrote "30-7:30PM" into the
          // master Time column. The lookbehind forbids starting right after a
          // digit or a colon, so a time can only begin at a real hour.
          const TIME_CORE = "(\\d{1,2}(?::\\d{2})?(?:\\s*[-–]\\s*\\d{1,2}(?::\\d{2})?)?\\s*(?:am|pm)?)";
          // Prefer an explicit AZ/MST time.
          const azMatch = line.match(new RegExp(`(?<![\\d:])${TIME_CORE}\\s*(?:AZ|MST|MDT)`, "i"));
          if (azMatch) {
            timeMST = azMatch[1].trim().toUpperCase();
          } else {
            // Fall back to a Pacific time (PST/PDT/PT). For the summer ad
            // calendar Pacific shares Mountain's offset (both UTC-7), so e.g.
            // "7-8pm PST / 10-11pm EST" → "7-8PM". Without this, Pacific/
            // Eastern-only time lines left the Time (MST) column blank.
            const ptMatch = line.match(new RegExp(`(?<![\\d:])${TIME_CORE}\\s*(?:PST|PDT|PT)\\b`, "i"));
            if (ptMatch) timeMST = ptMatch[1].trim().toUpperCase();
          }
        }
      }

      // Multi-page format: "(9/15) @handle - $price" or "(9/15)@handle - $price"
      const multiMatch = line.match(/^\(([\d/]+)\)\s*@([\w.]+)\s*-\s*\$?([\d,]+(?:\.\d{1,2})?)/);
      if (multiMatch) {
        pageEntries.push({
          handle:  multiMatch[2].toLowerCase(),
          price:   parseFloat(multiMatch[3].replace(/,/g, "")),
          bulkNum: multiMatch[1], // e.g. "11/15"
        });
        continue;
      }

      // Handle + bulk index, no per-page price: "@goal - 1/4" → bulk "1/4",
      // per-page price = header price. MUST run before the price form below so
      // the "1/4" isn't misread as a $1 price.
      const handleBulkMatch = line.match(/^@([\w.]+)\s*-\s*(\d+\/\d+)\s*$/);
      if (handleBulkMatch) {
        pageEntries.push({
          handle:  handleBulkMatch[1].toLowerCase(),
          price:   adPrice,
          bulkNum: handleBulkMatch[2],
        });
        continue;
      }

      // Single-page format with price: "@handle - $price"
      const singleMatch = line.match(/^@([\w.]+)\s*-\s*\$?([\d,]+(?:\.\d{1,2})?)/);
      if (singleMatch) {
        pageEntries.push({
          handle: singleMatch[1].toLowerCase(),
          price:  parseFloat(singleMatch[2].replace(/,/g, "")),
        });
        continue;
      }

      // Handle-only format (no price): "@handle"  e.g. Whop-style bulk ads
      // Use the header price (adPrice) as the per-page price
      const handleOnly = line.match(/^@([\w.]+)\s*$/);
      if (handleOnly) {
        pageEntries.push({
          handle: handleOnly[1].toLowerCase(),
          price:  adPrice,
        });
      }
    }
  }

  // Fallback: scan for page entries when PAGE INFO section didn't yield any.
  // Two recognized formats:
  //
  //   "@handle - $price"   — standard sponsorship brief
  //   "@handle - <URL>"    — affiliate brief (FashionNova-style, where the
  //                          per-page link IS the per-page deal). Header
  //                          $price is used as the per-page price.
  //
  // We scan from AFTER the INSTRUCTIONS heading (when present) so admin
  // handles listed near the top (@davogabriel, @sales_bolismedia) don't
  // accidentally become pages. If no INSTRUCTIONS marker exists either,
  // scan from the top — risk is acceptable since handles followed by a
  // dash + something are very unlikely to be admin handles.
  //
  // Collects ALL matches (multi-page support) — the old single-match
  // behavior silently dropped pages 2-N of any multi-page affiliate brief.
  if (pageEntries.length === 0) {
    // Hoisted INSTRUCTIONS lookup — the section parser below computes its own
    // instrIdx but we need ours earlier to bound the fallback scan.
    const instrIdxForFallback = lines.findIndex((l) =>
      l.replace(/\*/g, "").toLowerCase().includes("instructions")
    );
    const scanStart = pageInfoIdx !== -1
      ? pageInfoIdx + 1
      : (instrIdxForFallback !== -1 ? instrIdxForFallback + 1 : 0);
    for (let i = scanStart; i < lines.length; i++) {
      const line = lines[i];
      // @handle - $price
      const priceMatch = line.match(/^@([\w.]+)\s*-\s*\$?([\d,]+(?:\.\d{1,2})?)/);
      if (priceMatch) {
        pageEntries.push({
          handle: priceMatch[1].toLowerCase(),
          price:  parseFloat(priceMatch[2].replace(/,/g, "")),
        });
        continue;
      }
      // @handle - <URL>   (affiliate brief — per-page price = header price)
      const urlMatch = line.match(/^@([\w.]+)\s*-\s*(https?:\/\/\S+)/i);
      if (urlMatch) {
        pageEntries.push({
          handle: urlMatch[1].toLowerCase(),
          price:  adPrice,
        });
        continue;
      }
    }
  }

  // ── INSTRUCTIONS section ─────────────────────────────────────────────────────
  // Three distinct fields extracted from the INSTRUCTIONS block:
  //
  //   postType     — Feed / Reels / Carousel / Story
  //                  (normalized to one canonical token, NOT the whole line)
  //   postDuration — Permanent / 24hr / 30 Days etc.
  //                  (how long the post stays up — column F on per-page sheet)
  //   nif          — 30 MIN NIF / 1hr NIF etc.
  //                  (no-impression-feed window — column K on master sheet)
  //
  // Previously postDuration and nif were conflated into a single `nif` field
  // that landed in both columns, producing rows like:
  //    Post Type: "FEED POST"     ← whole line captured, not normalized
  //    Post Duration: "30 MIN NIF" ← actually the NIF, not the duration
  // Fixed: separate them, normalize postType to canonical token.
  let postType     = "";
  let postDuration = "";
  let nif          = "";

  const instrIdx = lines.findIndex((l) =>
    l.replace(/\*/g, "").toLowerCase().includes("instructions")
  );

  if (instrIdx !== -1) {
    const instrEnd = pageInfoIdx !== -1 ? pageInfoIdx : lines.length;
    const instrLines = lines.slice(instrIdx + 1, instrEnd).map((l) =>
      l.replace(/^[-*•]\s*/, "").replace(/\*/g, "").trim()
    );

    // ── Post type — normalize to canonical token ───────────────────────────
    // Match order matters: check "reels" before "reel" (substring),
    // "stories" before "story", "carousel" first since it's unique.
    const POST_TYPE_MAP = [
      { pat: /\bcarousel\b/i,  out: "Carousel" },
      { pat: /\breels?\b/i,    out: "Reels"    },
      { pat: /\bstor(?:y|ies)\b/i, out: "Story" },
      { pat: /\bfeed\b/i,      out: "Feed"     }, // checked last so "feed post" doesn't override more specific types
    ];
    for (const instr of instrLines) {
      let matched = false;
      for (const t of POST_TYPE_MAP) {
        if (t.pat.test(instr)) { postType = t.out; matched = true; break; }
      }
      if (matched) break;
    }

    // ── NIF — explicit "<duration> NIF" only ───────────────────────────────
    for (const instr of instrLines) {
      if (/\bnif\b/i.test(instr)) {
        // Capture e.g. "30 MIN NIF" / "1hr NIF" verbatim (master sheet K)
        nif = instr.trim();
        break;
      }
    }

    // ── Post duration — how long the post lives ────────────────────────────
    // Separate from NIF: NIF is the testing window, duration is post lifetime.
    // "Permanent" / "Do not delete" / "Leave as permanent" → "Permanent"
    // "24h" / "24 hr" / "24 hours" → "24hr"
    // "30 days" → "30 Days"
    const DURATION_MAP = [
      { pat: /\b(?:permanent|do not delete|leave as perm|never delete)\b/i,
        fn: () => "Permanent" },
      { pat: /\b(\d+)\s*h(?:r|our)?s?\b/i,
        fn: (m) => `${m[1]}hr` },
      { pat: /\b(\d+)\s*day/i,
        fn: (m) => `${m[1]} Days` },
      { pat: /\b(\d+)\s*week/i,
        fn: (m) => `${m[1]} Week${m[1] === "1" ? "" : "s"}` },
      { pat: /\b(\d+)\s*month/i,
        fn: (m) => `${m[1]} Month${m[1] === "1" ? "" : "s"}` },
    ];
    for (const instr of instrLines) {
      // Skip the NIF line so we don't accidentally pull its duration
      if (/\bnif\b/i.test(instr)) continue;
      for (const d of DURATION_MAP) {
        const m = instr.match(d.pat);
        if (m) { postDuration = d.fn(m); break; }
      }
      if (postDuration) break;
    }

    // Fallback: if no postType match in any line, use first instruction line's
    // first word (preserves old behavior for bare "Reel" / "Carousel" briefs).
    if (!postType && instrLines.length > 0) {
      const firstWord = instrLines[0].split(/\s+/)[0];
      postType = firstWord.charAt(0).toUpperCase() + firstWord.slice(1).toLowerCase();
    }
  }

  // ── Format date (matches sheet "Thu 1/1/26" style) ───────────────────────────
  const d = date || new Date();
  const datePosted = d.toLocaleDateString("en-US", {
    timeZone: "America/Phoenix", // AZ time — Railway runs UTC, ads are scheduled in AZ
    weekday: "short",
    month:   "numeric",
    day:     "numeric",
    year:    "2-digit",
  });

  const base = { client, category, postType, postDuration, nif, datePosted, timeMST };

  if (pageEntries.length === 0) {
    return { ...base, adPrice, pageHandle: null, bulkNum: headerBulk };
  } else if (pageEntries.length === 1) {
    return { ...base, adPrice: pageEntries[0].price, pageHandle: pageEntries[0].handle, bulkNum: pageEntries[0].bulkNum || headerBulk };
  } else {
    return pageEntries.map((p) => ({ ...base, adPrice: p.price, pageHandle: p.handle, bulkNum: p.bulkNum || headerBulk }));
  }
}

module.exports = { parseAdMessage };
