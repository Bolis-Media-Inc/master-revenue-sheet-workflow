/**
 * lib/datedInsert.js
 * Pure placement logic for sheets.js insertRowByDate — no I/O, no requires,
 * so scripts/test-dated-insert.js can exercise every branch without Sheets
 * credentials.
 *
 * Why this exists: appendRow always writes below the last filled row, so a
 * row dated in the past (a Greg approval that lands days late, a /checkmissed
 * "Add", a /syncsheets or /replay backfill) ended up at the BOTTOM of the
 * sheet, under today's ads. Twice (10/20 and 10/30) that made the team think
 * current ads were missing. planDatedInsert decides where such a row belongs.
 */

// Zero-width space — marks a day-divider row's anchor cell (see sheets.js).
const DAY_DIVIDER_MARK = "​";

/** "Wed, 10/21/26" / "Wed 10/21/26" / "10/21/2026" → 20261021 (null if unparseable). */
function dateKey(s) {
  const m = String(s || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  let y = +m[3]; if (y < 100) y += 2000;
  return y * 10000 + (+m[1]) * 100 + (+m[2]);
}

const _filled = (v) => v != null && String(v).trim() !== "";

/**
 * Decide where a new row dated `newDateStr` goes.
 *
 * @param {Array<{anchor:any, date:any}>} cells  One entry per sheet row, index 0 = row 1.
 * @param {string} newDateStr
 * @param {object} [opts]
 * @param {boolean} [opts.dayDividers=false]  Master sheet: keep one black divider
 *                                            row between days.
 * @returns {{ mode: "append"|"insert", startRow: number, kinds: string[], dataRow: number }}
 *   startRow = 1-indexed row where the block begins. kinds = the block, top to
 *   bottom ("divider" | "data"). In "append" mode the block is written into
 *   the empty rows after the last filled row; in "insert" mode that many rows
 *   are inserted at startRow, pushing everything at/below it down.
 *
 * Rules:
 *   - No parseable new date, no dated rows yet, or new date >= the LAST dated
 *     row's date → append (the cheap path every current-day row takes).
 *     Master: a divider goes first when the date is a new day and the last
 *     filled row isn't already a divider.
 *   - Master, date earlier than the last dated row:
 *       • that day has rows → insert right below its last row (i.e. above the
 *         next day's divider). No new divider.
 *       • that day has no rows → insert below the last earlier-dated row, as
 *         [divider, row], plus a trailing divider only if the next filled row
 *         is real data (not already a divider).
 *       • nothing earlier at all → insert above the first dated row, with a
 *         divider after it.
 *   - Page sheets (no dividers): insert below the last same-or-earlier-dated
 *     row, or above the first dated row if none.
 */
function planDatedInsert(cells, newDateStr, opts = {}) {
  const dividers = !!opts.dayDividers;
  const newKey = dateKey(newDateStr);

  let lastFilled = 0;            // 1-indexed, 0 = empty sheet
  let lastDatedIdx = -1;         // 0-indexed
  let firstDatedIdx = -1;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i] || {};
    if (_filled(c.anchor)) lastFilled = i + 1;
    if (dateKey(c.date) != null) {
      if (firstDatedIdx === -1) firstDatedIdx = i;
      lastDatedIdx = i;
    }
  }
  const lastKey = lastDatedIdx >= 0 ? dateKey(cells[lastDatedIdx].date) : null;

  // ── Cheap path: append at the bottom ─────────────────────────────────────
  if (newKey == null || lastKey == null || newKey >= lastKey) {
    const lastAnchor = lastFilled > 0 ? (cells[lastFilled - 1] || {}).anchor : null;
    const needDivider = dividers && newKey != null && lastKey != null &&
                        newKey !== lastKey && lastAnchor !== DAY_DIVIDER_MARK;
    const kinds = needDivider ? ["divider", "data"] : ["data"];
    const startRow = lastFilled + 1;
    return { mode: "append", startRow, kinds, dataRow: startRow + kinds.indexOf("data") };
  }

  // ── Late row: find its date section ──────────────────────────────────────
  let sameIdx = -1, earlierIdx = -1;
  for (let i = 0; i < cells.length; i++) {
    const k = dateKey((cells[i] || {}).date);
    if (k == null) continue;
    if (k === newKey) sameIdx = i;
    else if (k < newKey) earlierIdx = i;
  }

  let startRow, kinds;
  if (!dividers) {
    const below = Math.max(sameIdx, earlierIdx);
    if (below >= 0) { startRow = below + 2; kinds = ["data"]; }
    else            { startRow = firstDatedIdx + 1; kinds = ["data"]; }
  } else if (sameIdx >= 0) {
    startRow = sameIdx + 2;
    kinds = ["data"];
  } else if (earlierIdx >= 0) {
    // Next filled row after the earlier day's last row — normally the next
    // day's divider, which then also separates our new day from it.
    let next = null;
    for (let i = earlierIdx + 1; i < cells.length; i++) {
      if (_filled((cells[i] || {}).anchor)) { next = cells[i].anchor; break; }
    }
    startRow = earlierIdx + 2;
    kinds = (next != null && next !== DAY_DIVIDER_MARK)
      ? ["divider", "data", "divider"]
      : ["divider", "data"];
  } else {
    startRow = firstDatedIdx + 1;
    kinds = ["data", "divider"];
  }
  return { mode: "insert", startRow, kinds, dataRow: startRow + kinds.indexOf("data") };
}

/**
 * Rebase a row number through later inserts. `log` entries are
 * { seq, row, count } in seq order: `count` rows were inserted at `row`.
 * A row recorded at `sinceSeq` moves down by `count` for every later insert
 * at or above it.
 */
function rebaseRow(row, sinceSeq, log) {
  let r = row;
  for (const e of log) {
    if (e.seq <= sinceSeq) continue;
    if (e.row <= r) r += e.count;
  }
  return r;
}

module.exports = { DAY_DIVIDER_MARK, dateKey, planDatedInsert, rebaseRow };
