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
  const headerMatch = lines[0].match(
    /^(.+?)\s*-\s*(.+?)\s*-\s*\$?([\d,]+(?:\.\d{1,2})?)$/
  );
  if (!headerMatch) return null;

  const client   = headerMatch[1].trim();
  const category = headerMatch[2].trim();
  const adPrice  = parseFloat(headerMatch[3].replace(/,/g, ""));

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
      if (!timeMST) {
        if (/^now\b/i.test(line)) {
          timeMST = "NOW";
        } else {
          const timeMatch = line.match(/([\d]{1,2}(?:[-–][\d:]+)?(?::\d{2})?\s*(?:am|pm)?)\s*(?:AZ|MST)/i);
          if (timeMatch) timeMST = timeMatch[1].trim().toUpperCase();
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

  // Fallback: scan whole message for "@handle - $price" if PAGE INFO had none.
  // Only looks at lines AFTER the PAGE INFO section (or whole message if no PAGE INFO found)
  // to avoid accidentally picking up admin handles listed near the top.
  if (pageEntries.length === 0) {
    const scanStart = pageInfoIdx !== -1 ? pageInfoIdx + 1 : 0;
    for (let i = scanStart; i < lines.length; i++) {
      const m = lines[i].match(/^@([\w.]+)\s*-\s*\$?([\d,]+)/);
      if (m) { pageEntries.push({ handle: m[1].toLowerCase(), price: parseFloat(m[2].replace(/,/g, "")) }); break; }
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
    return { ...base, adPrice, pageHandle: null, bulkNum: "" };
  } else if (pageEntries.length === 1) {
    return { ...base, adPrice: pageEntries[0].price, pageHandle: pageEntries[0].handle, bulkNum: pageEntries[0].bulkNum || "" };
  } else {
    return pageEntries.map((p) => ({ ...base, adPrice: p.price, pageHandle: p.handle, bulkNum: p.bulkNum || "" }));
  }
}

module.exports = { parseAdMessage };
