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
      const multiMatch = line.match(/^\([\d/]+\)\s*@([\w.]+)\s*-\s*\$?([\d,]+(?:\.\d{1,2})?)/);
      if (multiMatch) {
        pageEntries.push({
          handle: multiMatch[1].toLowerCase(),
          price:  parseFloat(multiMatch[2].replace(/,/g, "")),
        });
        continue;
      }

      // Single-page format: "@handle - $price"
      const singleMatch = line.match(/^@([\w.]+)\s*-\s*\$?([\d,]+(?:\.\d{1,2})?)/);
      if (singleMatch) {
        pageEntries.push({
          handle: singleMatch[1].toLowerCase(),
          price:  parseFloat(singleMatch[2].replace(/,/g, "")),
        });
      }
    }
  }

  // Fallback: scan whole message for "@handle - $price" if PAGE INFO had none
  if (pageEntries.length === 0) {
    for (const line of lines) {
      const m = line.match(/^@([\w.]+)\s*-\s*\$?([\d,]+)/);
      if (m) { pageEntries.push({ handle: m[1].toLowerCase(), price: parseFloat(m[2].replace(/,/g, "")) }); break; }
    }
  }

  // ── INSTRUCTIONS section ─────────────────────────────────────────────────────
  let postType = "";
  let nif      = "";   // NIF / Perm / duration — maps to column K

  const instrIdx = lines.findIndex((l) =>
    l.replace(/\*/g, "").toLowerCase().includes("instructions")
  );

  if (instrIdx !== -1) {
    const instrEnd = pageInfoIdx !== -1 ? pageInfoIdx : lines.length;
    const instrLines = lines.slice(instrIdx + 1, instrEnd).map((l) =>
      l.replace(/^[-*•]\s*/, "").replace(/\*/g, "").trim()
    );

    // Post type (feed / reels / carousel / story)
    const typeKeywords = ["feed", "reel", "reels", "carousel", "story", "stories"];
    for (const instr of instrLines) {
      if (typeKeywords.some((k) => instr.toLowerCase().includes(k))) {
        postType = instr.charAt(0).toUpperCase() + instr.slice(1);
        break;
      }
    }

    // NIF / duration — prefer lines with "NIF" explicitly, then fall back to perm/duration keywords
    // Priority 1: explicit NIF mention (e.g. "1hr NIF", "30min NIF")
    for (const instr of instrLines) {
      if (/\bnif\b/i.test(instr)) {
        nif = instr.charAt(0).toUpperCase() + instr.slice(1);
        break;
      }
    }
    // Priority 2: perm / duration keywords
    if (!nif) {
      const nifKeywords = ["perm", "do not delete", "24h", "48h", "hour", "week", "month", "permanent"];
      for (const instr of instrLines) {
        if (nifKeywords.some((k) => instr.toLowerCase().includes(k))) {
          nif = instr.charAt(0).toUpperCase() + instr.slice(1);
          break;
        }
      }
    }

    if (!postType && instrLines.length > 0) {
      postType = instrLines[0].charAt(0).toUpperCase() + instrLines[0].slice(1);
    }
  }

  // ── Format date (matches sheet "Thu 1/1/26" style) ───────────────────────────
  const d = date || new Date();
  const datePosted = d.toLocaleDateString("en-US", {
    weekday: "short",
    month:   "numeric",
    day:     "numeric",
    year:    "2-digit",
  });

  const base = { client, category, postType, nif, datePosted, timeMST };

  if (pageEntries.length === 0) {
    // No page found — return single result using header price
    return { ...base, adPrice, pageHandle: null };
  } else if (pageEntries.length === 1) {
    // Single page — use per-page price from PAGE INFO
    return { ...base, adPrice: pageEntries[0].price, pageHandle: pageEntries[0].handle };
  } else {
    // Multi-page bulk ad — return array, one entry per page
    return pageEntries.map((p) => ({ ...base, adPrice: p.price, pageHandle: p.handle }));
  }
}

module.exports = { parseAdMessage };
