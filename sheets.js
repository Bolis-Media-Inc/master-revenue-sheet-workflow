/**
 * sheets.js
 * Google Sheets API helper.
 * Authenticates with a Service Account and provides a single `appendRow` function.
 *
 * Setup:
 *  1. Create a Google Cloud project + enable the Sheets API.
 *  2. Create a Service Account and download the JSON key.
 *  3. Share every revenue sheet with the service account email (Editor access).
 *  4. Set GOOGLE_SERVICE_ACCOUNT_JSON in your .env (paste the full JSON as one line).
 */

const { google } = require("googleapis");

let _auth = null;

// ── Rate limiter ──────────────────────────────────────────────────────────
// Google Sheets API enforces 60 read + 60 write requests per minute per user
// (service account). When a multi-page brief processes, we can burst far
// above that — a 24-page brief is ~24 per-page writes × 2 calls each + master
// writes + center-align + markForwarded = ~100 calls in 5-10 seconds.
//
// Instead of dropping calls when the burst hits the ceiling, queue them: any
// caller that would push us over the limit `await`s until the oldest call
// falls out of the 60-second window. Slows down a heavy brief from ~10s to
// ~30-60s end-to-end, but every call lands.
//
// Cap intentionally set below the 60 quota (50) to leave headroom for the
// occasional unhandled request and reduce risk of brushing the ceiling.
// If we increase the underlying quota via Google Cloud Console, bump this
// number to match.
const RATE_LIMIT_CALLS_PER_MIN = parseInt(process.env.SHEETS_RATE_LIMIT || "50", 10);
const RATE_LIMIT_WINDOW_MS     = 60_000;
const _callTimes = [];

async function _throttle() {
  const now = Date.now();
  // Drop call timestamps older than the window — they don't count anymore
  while (_callTimes.length > 0 && now - _callTimes[0] >= RATE_LIMIT_WINDOW_MS) {
    _callTimes.shift();
  }
  if (_callTimes.length >= RATE_LIMIT_CALLS_PER_MIN) {
    // Sleep until the oldest in-window call rotates out, then re-check
    const waitMs = RATE_LIMIT_WINDOW_MS - (now - _callTimes[0]) + 50;
    if (waitMs > 0) {
      await new Promise((r) => setTimeout(r, waitMs));
    }
    return _throttle(); // re-check after sleeping (more calls may have queued)
  }
  _callTimes.push(now);
}

/**
 * Wrap a Sheets API call with the rate limiter. Use this for EVERY
 * `sheets.spreadsheets.X.Y(...)` invocation.
 *
 * Returns whatever the wrapped promise returns. If the underlying call
 * still hits a quota error (because the API's actual limit is lower
 * than RATE_LIMIT_CALLS_PER_MIN), it propagates — caller can decide
 * to retry or not. Most call sites already have try/catch.
 */
async function _throttled(fn) {
  await _throttle();
  return fn();
}

/**
 * Drop-in replacement for `google.sheets({version, auth})` that returns
 * a rate-limited client. Hand-rolled wrapper (not Proxy-based) because
 * googleapis defines `spreadsheets` as non-configurable+non-writable
 * on the Resource object, and the ES Proxy spec forbids returning a
 * different value (like a wrapped sub-proxy) for such properties —
 * tripping a "proxy did not return its actual value" TypeError.
 *
 * Instead, we manually wrap the 6 methods we actually call so each one
 * awaits the rate limiter before invoking. Adding a new method later
 * just means adding one more line here.
 */
function getThrottledSheets(authClient) {
  const sheets = google.sheets({ version: "v4", auth: authClient });
  const t = (fn) => (...args) => _throttle().then(() => fn(...args));
  return {
    spreadsheets: {
      get:         t(sheets.spreadsheets.get.bind(sheets.spreadsheets)),
      batchUpdate: t(sheets.spreadsheets.batchUpdate.bind(sheets.spreadsheets)),
      values: {
        get:         t(sheets.spreadsheets.values.get.bind(sheets.spreadsheets.values)),
        update:      t(sheets.spreadsheets.values.update.bind(sheets.spreadsheets.values)),
        append:      t(sheets.spreadsheets.values.append.bind(sheets.spreadsheets.values)),
        batchUpdate: t(sheets.spreadsheets.values.batchUpdate.bind(sheets.spreadsheets.values)),
      },
    },
  };
}

/**
 * Initialise and cache the Google Auth client.
 */
function getAuth() {
  if (_auth) return _auth;

  let credentials;

  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    } catch (err) {
      throw new Error(
        "GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON. " + err.message
      );
    }
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    // Let the library pick it up automatically
    credentials = require(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  } else {
    throw new Error(
      "No Google credentials found. Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS."
    );
  }

  _auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return _auth;
}

/**
 * Append a single row to a Google Sheet.
 *
 * @param {string} spreadsheetId   The Sheet ID (from the URL)
 * @param {string} tabName         Tab name, e.g. "IG Revenue Tracker"
 * @param {any[]}  rowValues       Array of cell values in column order
 */
/**
 * Append a single row and return the 1-indexed row number that was written.
 * Returns null if the row number can't be determined from the API response.
 */
async function appendRow(spreadsheetId, tabName, rowValues, opts = {}) {
  const auth   = getAuth();
  const client = await auth.getClient();
  const sheets = getThrottledSheets(client);

  // ── Deterministic append ───────────────────────────────────────────────────
  // Don't use spreadsheets.values.append + table auto-detection — it gets
  // confused by:
  //   - explicit `false` checkboxes in col A (which read as values, not empty)
  //   - stray data in cols beyond K (NIF Reminder, Native Posted, etc.) that
  //     Sheets sometimes treats as part of "the table"
  //   - past appends that landed in misaligned columns and now anchor future
  //     appends to the wrong row
  //
  // Instead: read the "anchor column" (the column that's always populated for
  // real rows, never has dropdowns/checkboxes) to find the true last row,
  // then write directly. Two API calls vs one, but bulletproof.
  //
  //   Master sheet:    col A = Forwarded checkbox → anchor on col B (Client)
  //   Per-page sheet:  col A = Client Name        → anchor on col A
  //
  // Pass `opts.anchorColumn` to override (default "B"). Pass `opts.endColumn`
  // to set the rightmost column of the write range (default "K" for master).
  const anchorColumn = opts.anchorColumn || "B";
  const endColumn    = opts.endColumn    || "K";

  const colData = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tabName}!${anchorColumn}:${anchorColumn}`,
    majorDimension: "COLUMNS",
  });
  const colValues = (colData.data.values && colData.data.values[0]) || [];
  // Walk backwards to find the last non-empty cell (handles sparse history)
  let lastFilledRow = 0;
  for (let i = colValues.length - 1; i >= 0; i--) {
    if (colValues[i] != null && String(colValues[i]).trim() !== "") {
      lastFilledRow = i + 1; // values array is 0-indexed, sheet rows are 1-indexed
      break;
    }
  }
  const targetRow = lastFilledRow + 1;

  // values.update fails with "exceeds grid limits" when the target row is
  // beyond the sheet's currently-allocated grid (default sheets ship with
  // 1000 rows; once filled, the sheet caps there). values.append would
  // auto-extend but it has the table-detection issues described above.
  // Solution: try update, catch grid-exceeded, extend by 1000 rows, retry.
  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tabName}!A${targetRow}:${endColumn}${targetRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [rowValues] },
    });
  } catch (err) {
    const msg = err?.message || String(err);
    if (!/exceeds grid limits/i.test(msg)) throw err;

    // Find the numeric sheet id (different from spreadsheetId) — needed by
    // batchUpdate's appendDimension request.
    const meta  = await sheets.spreadsheets.get({ spreadsheetId });
    const sheet = meta.data.sheets?.find((s) => s.properties.title === tabName);
    if (!sheet) throw err; // re-throw original if we can't find the tab
    const sheetId = sheet.properties.sheetId;

    console.log(`[sheets] 📐 Extending "${tabName}" by 1000 rows (target row ${targetRow} exceeded grid)`);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          appendDimension: {
            sheetId,
            dimension: "ROWS",
            length: 1000,
          },
        }],
      },
    });

    // Retry the value write now that the row exists
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tabName}!A${targetRow}:${endColumn}${targetRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [rowValues] },
    });
  }

  return targetRow;
}

/**
 * Tick the "Forwarded" checkbox (column A) for the given 1-indexed row
 * in the master sheet.
 *
 * Uses batchUpdate (updateCells) instead of values.update so that the cell
 * gets both the checkbox data-validation AND the boolean value true in one
 * request. This works even when the appended row didn't inherit checkbox
 * formatting from the column above it.
 */
async function markForwarded(spreadsheetId, tabName, rowNumber) {
  if (!rowNumber) return;
  return markForwardedBatch(spreadsheetId, tabName, [rowNumber]);
}

/**
 * Batched variant — tick multiple "Forwarded" checkboxes in column A in
 * a single batchUpdate call. Avoids the Google Sheets API write-per-minute
 * quota that gets blown when a 25-page brief fires 25 individual
 * markForwarded calls in a tight loop.
 *
 * Cost: 1 spreadsheets.get + 1 spreadsheets.batchUpdate (vs N+N before).
 * Silent no-op for empty arrays.
 */
async function markForwardedBatch(spreadsheetId, tabName, rowNumbers) {
  const rows = (rowNumbers || []).filter((n) => Number.isFinite(n) && n > 0);
  if (rows.length === 0) return;

  const auth   = getAuth();
  const client = await auth.getClient();
  const sheets = getThrottledSheets(client);

  // One metadata fetch covers all rows
  const meta  = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = meta.data.sheets?.find((s) => s.properties.title === tabName);
  if (!sheet) {
    console.warn(`[sheets] markForwardedBatch: tab "${tabName}" not found`);
    return;
  }
  const sheetId = sheet.properties.sheetId;

  // Build N updateCells requests in one batchUpdate
  const requests = rows.map((rowNumber) => ({
    updateCells: {
      range: {
        sheetId,
        startRowIndex:    rowNumber - 1,
        endRowIndex:      rowNumber,
        startColumnIndex: 0,
        endColumnIndex:   1,
      },
      rows: [{
        values: [{
          userEnteredValue: { boolValue: true },
          dataValidation: {
            condition: { type: "BOOLEAN" },
            showCustomUi: true,
          },
        }],
      }],
      fields: "userEnteredValue,dataValidation",
    },
  }));

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });
}

/**
 * Apply center horizontal alignment to a list of rows in one batchUpdate.
 * Used at the end of brief processing so new rows match the team's
 * existing per-page-sheet formatting convention (everything centered)
 * without requiring 50+ sheets to be manually formatted column-wide.
 *
 * Cost: 1 spreadsheets.get + 1 spreadsheets.batchUpdate per sheet,
 * regardless of how many rows are being formatted. Silent no-op on
 * empty input — keeps callers from having to guard.
 *
 * @param {string} spreadsheetId
 * @param {string} tabName
 * @param {number[]} rowNumbers       1-indexed row numbers
 * @param {string}   [endColumn="K"]  Rightmost column to format (e.g. "K" for
 *                                    master, "H" for per-page sheets)
 */
async function applyCenterAlignmentBatch(spreadsheetId, tabName, rowNumbers, endColumn = "K") {
  const rows = (rowNumbers || []).filter((n) => Number.isFinite(n) && n > 0);
  if (rows.length === 0) return;

  const auth   = getAuth();
  const client = await auth.getClient();
  const sheets = getThrottledSheets(client);

  const meta  = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = meta.data.sheets?.find((s) => s.properties.title === tabName);
  if (!sheet) {
    console.warn(`[sheets] applyCenterAlignmentBatch: tab "${tabName}" not found`);
    return;
  }
  const sheetId = sheet.properties.sheetId;
  // Convert end column letter to 0-indexed column count (A=1, B=2, ..., K=11)
  const endColumnIndex = endColumn.toUpperCase().charCodeAt(0) - "A".charCodeAt(0) + 1;

  // One repeatCell request per row — sets horizontalAlignment without
  // touching any other cell properties (so checkboxes, validations,
  // values, etc. all stay put).
  const requests = rows.map((rowNumber) => ({
    repeatCell: {
      range: {
        sheetId,
        startRowIndex:    rowNumber - 1,
        endRowIndex:      rowNumber,
        startColumnIndex: 0,
        endColumnIndex:   endColumnIndex,
      },
      cell: {
        userEnteredFormat: { horizontalAlignment: "CENTER" },
      },
      fields: "userEnteredFormat.horizontalAlignment",
    },
  }));

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });
}

// Zero-width space — marks a day-divider row's anchor cell. Non-whitespace
// (so appendRow's `.trim() !== ""` anchor check counts it and the next real
// row lands BELOW the divider), but invisible to humans.
const DAY_DIVIDER_MARK = "​";

/**
 * Insert a black separator bar at the start of a new day's submissions in the
 * master sheet — the visual day-break the team used to keep by hand.
 *
 * Fires only when the brief's date differs from the last real data row's date
 * (so it lands once per day, above that day's first brief). Idempotent: if the
 * last row is already a divider, it no-ops.
 *
 * Mechanics: appends a row whose ANCHOR cell holds a zero-width space (so the
 * brief rows append below it, not over it) and whose A:endColumn cells get a
 * black background via batchUpdate — matching the old empty-black-bar look.
 *
 * Detection compares NORMALIZED M/D/YY (extracted by regex), so "Tue 5/26/26"
 * vs "Wed, 5/27/26" formatting drift doesn't cause false splits.
 *
 * Fully fail-open: any error is logged and swallowed (returns {inserted:false})
 * so a divider hiccup never blocks the brief's real sheet writes.
 *
 * @returns {Promise<{inserted: boolean, row?: number}>}
 */
async function maybeInsertDayDivider(spreadsheetId, tabName, briefDateStr, opts = {}) {
  try {
    if (!spreadsheetId || !briefDateStr) return { inserted: false };
    const anchorColumn = opts.anchorColumn || "B"; // master: Client col
    const dateColumn   = opts.dateColumn   || "D"; // master: Date col
    const endColumn    = opts.endColumn    || "K";

    const auth   = getAuth();
    const client = await auth.getClient();
    const sheets = getThrottledSheets(client);

    const norm = (s) => {
      const m = String(s || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
      return m ? `${+m[1]}/${+m[2]}/${m[3].slice(-2)}` : null;
    };
    const briefNorm = norm(briefDateStr);
    if (!briefNorm) return { inserted: false }; // can't parse incoming date — skip

    // Last REAL data date (divider rows have empty date col, so naturally skipped)
    const dateResp = await sheets.spreadsheets.values.get({
      spreadsheetId, range: `${tabName}!${dateColumn}:${dateColumn}`, majorDimension: "COLUMNS",
    });
    const dateVals = (dateResp.data.values && dateResp.data.values[0]) || [];
    let lastDate = null;
    for (let i = dateVals.length - 1; i >= 0; i--) {
      if (dateVals[i] != null && String(dateVals[i]).trim() !== "") { lastDate = dateVals[i]; break; }
    }
    if (!lastDate) return { inserted: false };          // no data yet → no divider before day 1
    if (norm(lastDate) === briefNorm) return { inserted: false }; // same day → no divider

    // Guard against double dividers: if the last anchored row is already a
    // divider mark, don't stack another.
    const anchorResp = await sheets.spreadsheets.values.get({
      spreadsheetId, range: `${tabName}!${anchorColumn}:${anchorColumn}`, majorDimension: "COLUMNS",
    });
    const anchorVals = (anchorResp.data.values && anchorResp.data.values[0]) || [];
    for (let i = anchorVals.length - 1; i >= 0; i--) {
      const v = anchorVals[i];
      if (v != null && String(v).trim() !== "") {
        if (v === DAY_DIVIDER_MARK) return { inserted: false };
        break;
      }
    }

    // Build a blank divider row with the zero-width mark in the anchor column,
    // then reuse appendRow (handles deterministic placement + grid-extend).
    const colIdx = anchorColumn.toUpperCase().charCodeAt(0) - 65;
    const endIdx = endColumn.toUpperCase().charCodeAt(0) - 65;
    const rowValues = Array.from({ length: endIdx + 1 }, (_, i) => (i === colIdx ? DAY_DIVIDER_MARK : ""));
    const dividerRow = await appendRow(spreadsheetId, tabName, rowValues, { anchorColumn, endColumn });
    if (!dividerRow) return { inserted: false };

    // Paint A:endColumn black.
    const meta  = await sheets.spreadsheets.get({ spreadsheetId });
    const sheet = meta.data.sheets?.find((s) => s.properties.title === tabName);
    if (sheet) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{
            repeatCell: {
              range: {
                sheetId: sheet.properties.sheetId,
                startRowIndex: dividerRow - 1, endRowIndex: dividerRow,
                startColumnIndex: 0, endColumnIndex: endIdx + 1,
              },
              cell: { userEnteredFormat: { backgroundColor: { red: 0, green: 0, blue: 0 } } },
              fields: "userEnteredFormat.backgroundColor",
            },
          }],
        },
      });
    }
    console.log(`[sheets] ▬ Day divider inserted at row ${dividerRow} (new day: ${briefDateStr})`);
    return { inserted: true, row: dividerRow };
  } catch (err) {
    console.error(`[sheets] maybeInsertDayDivider (non-fatal): ${err.message}`);
    return { inserted: false };
  }
}

/**
 * Sort a sheet's data rows chronologically by the Date column.
 *
 * Per-page rev sheets accumulate entries in append order, which drifts out of
 * date order (backdated briefs, /replay, manual edits). This re-sorts them
 * ascending by date.
 *
 * Approach: dates are stored as TEXT ("Mon 3/9/26") so a plain column sort is
 * lexically wrong. Instead we (1) APPEND a temporary scratch column at the end
 * of the grid and write a numeric YYYYMMDD key into it, (2) use a native
 * sortRange request — which moves ENTIRE rows incl. their formatting, so
 * nothing misaligns — keyed on that scratch column, then (3) DELETE the
 * scratch column entirely.
 *
 * The append+delete (vs a fixed scratch column like "T") is load-bearing:
 * per-page rev sheets ship with a FIXED 11-column grid (A–K), so writing to a
 * far column fails with "exceeds grid limits". Appending guarantees a real,
 * empty, in-bounds column regardless of the sheet's width.
 *
 * Header rows are auto-detected: the first row whose Date cell parses as a
 * date is the first data row; everything above it is left in place. Rows with
 * no parseable date sort to the bottom.
 *
 * Safe for per-page sheets because per-page updates (price/date/status) locate
 * rows by CONTENT (client name), not stored row number — so re-ordering can't
 * misdirect a later /update.
 *
 * @returns {Promise<{sorted: boolean, rows?: number, reason?: string}>}
 */
function _colLetter(idx0) {
  let n = idx0 + 1, s = "";
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

async function sortSheetByDate(spreadsheetId, tabName, opts = {}) {
  const dateColLetter = opts.dateColumn || "D";
  const dateColIdx0   = dateColLetter.toUpperCase().charCodeAt(0) - 65; // 0-indexed

  const auth   = getAuth();
  const client = await auth.getClient();
  const sheets = getThrottledSheets(client);

  const dateKey = (s) => {
    const m = String(s || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (!m) return null;
    const mo = +m[1], d = +m[2];
    let y = +m[3]; if (y < 100) y += 2000;
    return y * 10000 + mo * 100 + d;
  };

  // Read A..date column to find the data extent + parse date keys.
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId, range: `${tabName}!A:${dateColLetter}`,
  });
  const rows = resp.data.values || [];
  if (rows.length === 0) return { sorted: false, reason: "empty sheet" };

  // First data row = first row whose Date cell parses (1-indexed).
  let firstDataRow = -1;
  for (let i = 0; i < rows.length; i++) {
    if (dateKey(rows[i]?.[dateColIdx0])) { firstDataRow = i + 1; break; }
  }
  if (firstDataRow === -1) return { sorted: false, reason: "no dated rows" };

  // Last data row = last row with ANY content in A..date column.
  let lastDataRow = firstDataRow;
  for (let i = rows.length - 1; i >= firstDataRow - 1; i--) {
    if ((rows[i] || []).some((c) => c != null && String(c).trim() !== "")) {
      lastDataRow = i + 1; break;
    }
  }
  const dataCount = lastDataRow - firstDataRow + 1;
  if (dataCount < 2) return { sorted: false, reason: "fewer than 2 data rows" };

  // Resolve numeric sheetId + current column count for the tab.
  const meta  = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = meta.data.sheets?.find((s) => s.properties.title === tabName);
  if (!sheet) return { sorted: false, reason: `tab "${tabName}" not found` };
  const sheetId  = sheet.properties.sheetId;
  const colCount = sheet.properties.gridProperties?.columnCount || 11;
  const scratchIdx0 = colCount;                 // new column appended at the end
  const scratchLetter = _colLetter(scratchIdx0);

  // 1. Append a temporary scratch column at the end of the grid (guaranteed
  //    empty + in-bounds, unlike a fixed far column on a narrow grid).
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        appendDimension: { sheetId, dimension: "COLUMNS", length: 1 },
      }],
    },
  });

  try {
    // 2. Write YYYYMMDD keys into the scratch column for each data row.
    //    Undated rows get "" (Sheets sorts blanks last on ascending).
    const keyValues = [];
    for (let r = firstDataRow; r <= lastDataRow; r++) {
      const k = dateKey(rows[r - 1]?.[dateColIdx0]);
      keyValues.push([k != null ? k : ""]);
    }
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tabName}!${scratchLetter}${firstDataRow}:${scratchLetter}${lastDataRow}`,
      valueInputOption: "RAW",
      requestBody: { values: keyValues },
    });

    // 3. Native sortRange over A..scratch, keyed on the scratch column ASC.
    //    Moves entire rows (with formatting) — no value-rewrite misalignment.
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          sortRange: {
            range: {
              sheetId,
              startRowIndex:    firstDataRow - 1,
              endRowIndex:      lastDataRow,
              startColumnIndex: 0,
              endColumnIndex:   scratchIdx0 + 1,
            },
            sortSpecs: [{ dimensionIndex: scratchIdx0, sortOrder: "ASCENDING" }],
          },
        }],
      },
    });
  } finally {
    // 4. Always delete the scratch column, even if the sort step threw —
    //    never leave a stray column behind.
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          deleteDimension: {
            range: { sheetId, dimension: "COLUMNS", startIndex: scratchIdx0, endIndex: scratchIdx0 + 1 },
          },
        }],
      },
    }).catch((err) => console.error(`[sheets] sortSheetByDate scratch-column cleanup: ${err.message}`));
  }

  return { sorted: true, rows: dataCount };
}

/**
 * Find OUT-OF-RANGE / suspicious dates in a sheet's Date column (D). Read-only.
 * Flags rows whose parsed date is in a future year, more than `futureDays`
 * ahead of today, or before `floorYear` — i.e. typo'd dates like "2/26/27"
 * (Feb 2027) sitting among 2026 entries. Returns [{ row, client, date }].
 */
async function findOutlierDates(spreadsheetId, tabName, opts = {}) {
  const futureDays = opts.futureDays != null ? opts.futureDays : 45;
  const floorYear  = opts.floorYear  != null ? opts.floorYear  : 2025;
  const now = new Date();
  const curYear = now.getFullYear();
  const maxOk = new Date(now.getTime() + futureDays * 86400000);

  const auth   = getAuth();
  const client = await auth.getClient();
  const sheets = getThrottledSheets(client);
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId, range: `${tabName}!A:D`,
  });
  const rows = resp.data.values || [];

  const hits = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const clientCell = (r?.[0] || "").trim();
    const dateStr = r?.[3];
    const m = String(dateStr || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (!clientCell || !m) continue;
    const mo = +m[1], d = +m[2];
    let y = +m[3]; if (y < 100) y += 2000;
    const dt = new Date(y, mo - 1, d);
    if (y > curYear || y < floorYear || dt > maxOk) {
      hits.push({ row: i + 1, client: clientCell, date: String(dateStr).trim() });
    }
  }
  return hits;
}

/**
 * Read the header row (row 1) of a tab. Read-only. Returns an array of the
 * column header strings (A, B, C, …). Used by /auditcols to detect per-page
 * sheets whose layout drifted from the standard template.
 */
async function getHeaderRow(spreadsheetId, tabName) {
  const auth   = getAuth();
  const client = await auth.getClient();
  const sheets = getThrottledSheets(client);
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId, range: `${tabName}!1:1`,
  });
  return (resp.data.values && resp.data.values[0]) || [];
}

/**
 * Scan a single column for cells whose value matches a regex. Read-only.
 * Returns [{ row, value }] (1-indexed rows). Used by the NIF-in-Duration
 * audit to surface legacy rows where the old parser dumped a NIF into the
 * Post Duration column.
 */
async function findRowsInColumn(spreadsheetId, tabName, colLetter, regex) {
  const auth   = getAuth();
  const client = await auth.getClient();
  const sheets = getThrottledSheets(client);
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId, range: `${tabName}!${colLetter}:${colLetter}`, majorDimension: "COLUMNS",
  });
  const col = (resp.data.values && resp.data.values[0]) || [];
  const hits = [];
  for (let i = 0; i < col.length; i++) {
    const v = col[i];
    if (v != null && regex.test(String(v))) hits.push({ row: i + 1, value: String(v) });
  }
  return hits;
}

/**
 * Find DUPLICATE ad entries in a per-page sheet — rows that share the same
 * (client + date + price) within the given months. Read-only.
 *
 * Per-page schema: A=Client, B=Ad Type, C=Bulk#, D=Date, E=Post Type,
 * F=Post Duration, G=Ad Price, H=Notes.
 *
 * @param opts.months  array of 1-indexed months to include (e.g. [4,5])
 * @param opts.year     filter to this 2-digit-equiv year (default 2026)
 * @param opts.minPrice only count rows with price > this (default 0)
 * @returns [{ client, date, price, count, rows:[rowNums] }] for groups ≥2
 */
async function findDuplicateRows(spreadsheetId, tabName, opts = {}) {
  const months   = opts.months   || [4, 5];
  const year      = opts.year     || 2026;
  const minPrice  = opts.minPrice != null ? opts.minPrice : 0;

  const auth   = getAuth();
  const client = await auth.getClient();
  const sheets = getThrottledSheets(client);

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId, range: `${tabName}!A:G`,
  });
  const rows = resp.data.values || [];

  const parseDate = (s) => {
    const m = String(s || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (!m) return null;
    let y = +m[3]; if (y < 100) y += 2000;
    return { mo: +m[1], d: +m[2], y, key: `${+m[1]}/${+m[2]}/${String(y).slice(-2)}` };
  };
  const parsePrice = (s) => {
    const n = parseFloat(String(s || "").replace(/[$,]/g, ""));
    return Number.isFinite(n) ? n : null;
  };

  const groups = new Map(); // key → { client, date, price, rows:[] }
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const clientCell = (r?.[0] || "").trim();
    const dt = parseDate(r?.[3]);
    const price = parsePrice(r?.[6]);
    if (!clientCell || !dt) continue;
    if (!months.includes(dt.mo) || dt.y !== year) continue;
    if (price == null || price <= minPrice) continue;

    const key = `${clientCell.toLowerCase()}|${dt.key}|${price}`;
    if (!groups.has(key)) groups.set(key, { client: clientCell, date: dt.key, price, rows: [] });
    groups.get(key).rows.push(i + 1);
  }

  return [...groups.values()]
    .filter((g) => g.rows.length >= 2)
    .map((g) => ({ ...g, count: g.rows.length }));
}

/**
 * Get the date value from the last populated row in column D (Date column).
 * Returns a normalised date string like "Fri 3/6/26", or null if not found.
 */
async function getLastDate(spreadsheetId, tabName) {
  const auth   = getAuth();
  const client = await auth.getClient();
  const sheets = getThrottledSheets(client);

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tabName}!D:D`,
  });

  const values = response.data.values || [];
  for (let i = values.length - 1; i >= 0; i--) {
    const val = values[i]?.[0]?.trim();
    if (val) return val.replace(/,/g, "").trim(); // normalise "Fri, 3/6/26" → "Fri 3/6/26"
  }
  return null;
}

/**
 * Append a black separator row (used to mark the start of a new day).
 */
async function appendSeparatorRow(spreadsheetId, tabName) {
  const auth   = getAuth();
  const client = await auth.getClient();
  const sheets = getThrottledSheets(client);

  // Append 11 empty cells — enough to anchor the row in the table
  const appendResult = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tabName}!A:K`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "OVERWRITE",
    requestBody: { values: [["", "", "", "", "", "", "", "", "", "", ""]] },
  });

  // Parse the row number from the updatedRange e.g. "'2026 Ad Overview'!A3129:K3129"
  const updatedRange = appendResult.data.updates?.updatedRange || "";
  const rowMatch     = updatedRange.match(/[A-Z](\d+):/);
  if (!rowMatch) return;

  const rowIndex = parseInt(rowMatch[1]) - 1; // 0-indexed

  // Resolve the sheetId (numeric) for the target tab
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = spreadsheet.data.sheets?.find(
    (s) => s.properties.title === tabName
  );
  if (!sheet) return;

  const sheetId = sheet.properties.sheetId;

  // Paint the entire row black
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: rowIndex,
            endRowIndex:   rowIndex + 1,
            startColumnIndex: 0,
            endColumnIndex:   26, // A–Z, covers all columns
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0, green: 0, blue: 0 },
            },
          },
          fields: "userEnteredFormat.backgroundColor",
        },
      }],
    },
  });
}

/**
 * Update Status (column I) to "Live" for any rows whose Page (column F)
 * matches one of the given handles AND whose current Status is "Scheduled".
 * Returns the number of rows updated.
 */
async function updateStatusToLive(spreadsheetId, tabName, pageHandles, clientName = null) {
  const auth   = getAuth();
  const client = await auth.getClient();
  const sheets = getThrottledSheets(client);

  // Read B:I — gives us: B=0 (Client), C=1, D=2, E=3, F=4 (Page), G=5, H=6, I=7 (Status)
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tabName}!B:I`,
  });

  const rows       = response.data.values || [];
  const updates    = [];
  const normalised = pageHandles.map((h) => `@${h.toLowerCase().replace(/^@/, "")}`);
  const normClient = clientName?.toLowerCase().trim() || null;

  for (let i = 0; i < rows.length; i++) {
    const clientCell = (rows[i]?.[0] || "").trim().toLowerCase(); // B
    const pageCell   = (rows[i]?.[4] || "").trim().toLowerCase(); // F
    const statusCell = (rows[i]?.[7] || "").trim();               // I

    const pageMatches   = normalised.includes(pageCell);
    const statusMatches = statusCell === "Scheduled";
    // If we know the client name, require it to match — prevents cross-campaign false positives
    const clientMatches = !normClient || clientCell === normClient;

    if (pageMatches && statusMatches && clientMatches) {
      updates.push({
        range:  `${tabName}!I${i + 1}`,
        values: [["Live"]],
      });
    }
  }

  if (updates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: "USER_ENTERED", data: updates },
    });
  }

  return updates.length;
}

/**
 * Update the Date column for rows matching the given page handles + client.
 *
 * Master sheet (isMasterSheet = true):
 *   Read B:I — B=Client(0), F=Page(4). Match client + page → write col D.
 * Page sheet (isMasterSheet = false):
 *   Read A:G — A=Client(0). Match client only (page sheets are per-handle
 *   already), update col D ("Date Posted") on every matching row.
 *
 * Used by the "Posted on @page <date>" reply pattern when a VA confirms
 * a posted ad with a specific date — we update the live date in the
 * sheet to match what they typed (overrides the brief-posting date).
 *
 * Returns the number of cells updated.
 */
async function updateAdDate(spreadsheetId, tabName, pageHandles, clientName, newDate, isMasterSheet = true) {
  const auth   = getAuth();
  const client = await auth.getClient();
  const sheets = getThrottledSheets(client);

  const normClient = clientName?.toLowerCase().trim() || null;

  if (isMasterSheet) {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tabName}!B:I`,
    });
    const rows       = response.data.values || [];
    const normalised = pageHandles.map((h) => `@${h.toLowerCase().replace(/^@/, "")}`);
    const updates    = [];

    for (let i = 0; i < rows.length; i++) {
      const clientCell = (rows[i]?.[0] || "").trim().toLowerCase(); // B
      const pageCell   = (rows[i]?.[4] || "").trim().toLowerCase(); // F

      const pageMatches   = normalised.includes(pageCell);
      const clientMatches = !normClient || clientCell === normClient;

      if (pageMatches && clientMatches) {
        // Master sheet date is column D
        updates.push({ range: `${tabName}!D${i + 1}`, values: [[newDate]] });
      }
    }

    if (updates.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: { valueInputOption: "USER_ENTERED", data: updates },
      });
    }
    return updates.length;
  }

  // Page sheet — match by client only (each page sheet is already per-handle)
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tabName}!A:G`,
  });
  const rows    = response.data.values || [];
  const updates = [];

  for (let i = 0; i < rows.length; i++) {
    const clientCell = (rows[i]?.[0] || "").trim().toLowerCase(); // A
    if (normClient && clientCell !== normClient) continue;
    if (!clientCell) continue; // skip blank rows
    // Page sheet date is column D ("Date Posted")
    updates.push({ range: `${tabName}!D${i + 1}`, values: [[newDate]] });
  }

  if (updates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: "USER_ENTERED", data: updates },
    });
  }
  return updates.length;
}

/**
 * Update the Ad Price for rows matching the given page handles + client name.
 *
 * Master sheet (isMasterSheet = true):
 *   Read B:I — B=Client(0), F=Page(4), H=Price(6). Match client + page, update col H.
 * Page sheet (isMasterSheet = false):
 *   Read A:G — A=Client(0), G=Price(6). Match client only, update col G.
 *
 * Returns the number of cells updated.
 */
async function updateAdPrice(spreadsheetId, tabName, pageHandles, clientName, newPrice, isMasterSheet = true) {
  const auth   = getAuth();
  const client = await auth.getClient();
  const sheets = getThrottledSheets(client);

  const normClient = clientName?.toLowerCase().trim() || null;

  if (isMasterSheet) {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tabName}!B:I`,
    });
    const rows       = response.data.values || [];
    const normalised = pageHandles.map((h) => `@${h.toLowerCase().replace(/^@/, "")}`);
    const updates    = [];

    for (let i = 0; i < rows.length; i++) {
      const clientCell = (rows[i]?.[0] || "").trim().toLowerCase(); // B
      const pageCell   = (rows[i]?.[4] || "").trim().toLowerCase(); // F
      const clientMatches = !normClient || clientCell === normClient;

      if (normalised.includes(pageCell) && clientMatches) {
        updates.push({ range: `${tabName}!H${i + 1}`, values: [[newPrice]] });
      }
    }

    if (updates.length) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: { valueInputOption: "USER_ENTERED", data: updates },
      });
    }
    return updates.length;

  } else {
    // Page sheet — no page column, match by client name only
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tabName}!A:G`,
    });
    const rows    = response.data.values || [];
    const updates = [];

    for (let i = 0; i < rows.length; i++) {
      const clientCell    = (rows[i]?.[0] || "").trim().toLowerCase(); // A
      const clientMatches = !normClient || clientCell === normClient;

      if (clientMatches && clientCell) { // clientCell guard skips blank rows
        updates.push({ range: `${tabName}!G${i + 1}`, values: [[newPrice]] });
      }
    }

    if (updates.length) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: { valueInputOption: "USER_ENTERED", data: updates },
      });
    }
    return updates.length;
  }
}

/**
 * Rename the Client/Campaign column for rows matching (oldClient + pageHandles).
 * Mirror of updateAdPrice but writes column B (Master) or A (per-page) with
 * a new client name instead of column H/G with a new price.
 *
 * Used by /update name (handlers/updateHandler.js). Building block for
 * the future "rename campaign across the books" workflow.
 *
 * @returns {Promise<number>} count of rows updated
 */
async function updateAdClient(spreadsheetId, tabName, pageHandles, oldClient, newClient, isMasterSheet = true) {
  const auth   = getAuth();
  const client = await auth.getClient();
  const sheets = getThrottledSheets(client);

  const normOld = oldClient?.toLowerCase().trim() || null;
  if (!normOld) throw new Error("updateAdClient: oldClient required");
  if (!newClient) throw new Error("updateAdClient: newClient required");

  if (isMasterSheet) {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tabName}!B:I`,
    });
    const rows       = response.data.values || [];
    const normalised = (pageHandles || []).map((h) => `@${h.toLowerCase().replace(/^@/, "")}`);
    const wantPage   = normalised.length > 0;
    const updates    = [];
    for (let i = 0; i < rows.length; i++) {
      const clientCell = (rows[i]?.[0] || "").trim().toLowerCase(); // B
      const pageCell   = (rows[i]?.[4] || "").trim().toLowerCase(); // F
      if (clientCell !== normOld) continue;
      if (wantPage && !normalised.includes(pageCell)) continue;
      updates.push({ range: `${tabName}!B${i + 1}`, values: [[newClient]] });
    }
    if (updates.length) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: { valueInputOption: "USER_ENTERED", data: updates },
      });
    }
    return updates.length;
  } else {
    // Per-page sheet: A=client. Match + rewrite col A.
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tabName}!A:G`,
    });
    const rows    = response.data.values || [];
    const updates = [];
    for (let i = 0; i < rows.length; i++) {
      const clientCell = (rows[i]?.[0] || "").trim().toLowerCase(); // A
      if (clientCell !== normOld) continue;
      updates.push({ range: `${tabName}!A${i + 1}`, values: [[newClient]] });
    }
    if (updates.length) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: { valueInputOption: "USER_ENTERED", data: updates },
      });
    }
    return updates.length;
  }
}

/**
 * Hard-delete rows matching the given page handles + client name.
 *
 * Master sheet (isMasterSheet = true):  match B=client + F=page.
 * Page sheet  (isMasterSheet = false):  match A=client only.
 *
 * Rows are deleted bottom-to-top so indices don't shift mid-request.
 * Returns the number of rows deleted.
 */
async function deleteAdRows(spreadsheetId, tabName, pageHandles, clientName, isMasterSheet = true) {
  const auth   = getAuth();
  const client = await auth.getClient();
  const sheets = getThrottledSheets(client);

  // Resolve numeric sheetId for the tab (required by deleteDimension)
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = spreadsheet.data.sheets?.find((s) => s.properties.title === tabName);
  if (!sheet) throw new Error(`Tab "${tabName}" not found in spreadsheet ${spreadsheetId}`);
  const sheetId = sheet.properties.sheetId;

  const normClient = clientName?.toLowerCase().trim() || null;
  let rowsToDelete = []; // 0-indexed row indices in the sheet

  if (isMasterSheet) {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tabName}!B:I`,
    });
    const rows       = response.data.values || [];
    const normalised = pageHandles.map((h) => `@${h.toLowerCase().replace(/^@/, "")}`);

    for (let i = 0; i < rows.length; i++) {
      const clientCell = (rows[i]?.[0] || "").trim().toLowerCase(); // B
      const pageCell   = (rows[i]?.[4] || "").trim().toLowerCase(); // F
      const clientMatches = !normClient || clientCell === normClient;

      if (normalised.includes(pageCell) && clientMatches) {
        rowsToDelete.push(i); // 0-indexed
      }
    }

  } else {
    // Page sheet — match client only
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tabName}!A:A`,
    });
    const rows = response.data.values || [];

    for (let i = 0; i < rows.length; i++) {
      const clientCell    = (rows[i]?.[0] || "").trim().toLowerCase();
      const clientMatches = !normClient || clientCell === normClient;

      if (clientMatches && clientCell) {
        rowsToDelete.push(i);
      }
    }
  }

  if (rowsToDelete.length === 0) return 0;

  // Delete bottom-to-top so earlier indices don't shift
  rowsToDelete.sort((a, b) => b - a);

  const requests = rowsToDelete.map((rowIdx) => ({
    deleteDimension: {
      range: {
        sheetId,
        dimension:  "ROWS",
        startIndex: rowIdx,
        endIndex:   rowIdx + 1,
      },
    },
  }));

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });

  return rowsToDelete.length;
}

// ── Reminders tab helpers ─────────────────────────────────────────────────────
// Schema (columns A–F):
//   A: page handle   B: client   C: destChatId   D: type (permanent|timed)
//   E: dueAt (ISO)   F: sent (FALSE/TRUE)

const REMINDERS_TAB = "Reminders";

/**
 * Ensure the Reminders tab exists in the master sheet. Creates it if missing.
 */
async function ensureRemindersTab(spreadsheetId) {
  const auth   = getAuth();
  const client = await auth.getClient();
  const sheets = getThrottledSheets(client);

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets?.some((s) => s.properties.title === REMINDERS_TAB);
  if (exists) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: REMINDERS_TAB } } }],
    },
  });
  console.log(`[sheets] Created "${REMINDERS_TAB}" tab`);
}

/**
 * Append a reminder record to the Reminders tab.
 * @param {string} spreadsheetId  Master sheet ID
 * @param {{ handle, client, destChatId, type, dueAt }} reminder
 */
async function appendReminder(spreadsheetId, reminder) {
  return appendRemindersBatch(spreadsheetId, [reminder]);
}

/**
 * Batched variant — append N reminders in a single API call instead of N.
 * One ensureRemindersTab + one spreadsheets.values.append.
 * Cuts 25 reminders from 50 calls (25 ensure + 25 append) to 2.
 *
 * Silent no-op for empty arrays.
 */
async function appendRemindersBatch(spreadsheetId, reminders) {
  const items = (reminders || []).filter(Boolean);
  if (items.length === 0) return;

  await ensureRemindersTab(spreadsheetId);

  const auth   = getAuth();
  const client = await auth.getClient();
  const sheets = getThrottledSheets(client);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range:            `${REMINDERS_TAB}!A:F`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "OVERWRITE",
    requestBody: {
      values: items.map((r) => [
        r.handle,
        r.client,
        r.destChatId,
        r.type,
        r.dueAt,
        "FALSE",
      ]),
    },
  });
}

/**
 * Read all pending (unsent) reminders whose dueAt is in the past.
 * Returns array of { rowNumber, handle, client, destChatId, type }
 */
async function getPendingReminders(spreadsheetId) {
  await ensureRemindersTab(spreadsheetId);

  const auth   = getAuth();
  const client = await auth.getClient();
  const sheets = getThrottledSheets(client);

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${REMINDERS_TAB}!A:F`,
  });

  const rows = response.data.values || [];
  const now  = Date.now();
  const due  = [];

  for (let i = 0; i < rows.length; i++) {
    const [handle, client_, destChatId, type, dueAt, sent] = rows[i];
    if (!handle || sent === "TRUE") continue;
    const dueMs = new Date(dueAt).getTime();
    if (!isNaN(dueMs) && dueMs <= now) {
      due.push({ rowNumber: i + 1, handle, client: client_, destChatId, type });
    }
  }

  return due;
}

/**
 * Mark a reminder row as sent (set column F = TRUE).
 */
async function markReminderSent(spreadsheetId, rowNumber) {
  const auth   = getAuth();
  const client = await auth.getClient();
  const sheets = getThrottledSheets(client);

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range:            `${REMINDERS_TAB}!F${rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody:      { values: [["TRUE"]] },
  });
}

/**
 * Apply center horizontal alignment to entire columns (A..endColumn) of a
 * sheet. One-time setup per sheet — once columns are formatted, every new
 * row inherits center alignment automatically, with ZERO per-write API cost.
 *
 * Replaces the per-row applyCenterAlignmentBatch that was blowing the
 * Sheets API quota (60/min) by firing one batchUpdate per row per page
 * sheet per brief.
 *
 * Cost: 1 spreadsheets.get + 1 spreadsheets.batchUpdate per sheet.
 * Idempotent — re-running just re-asserts CENTER alignment, no-op effect.
 */
async function applyColumnCenterAlignment(spreadsheetId, tabName, endColumn = "K") {
  const auth   = getAuth();
  const client = await auth.getClient();
  const sheets = getThrottledSheets(client);

  const meta  = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = meta.data.sheets?.find((s) => s.properties.title === tabName);
  if (!sheet) {
    throw new Error(`Tab "${tabName}" not found in ${spreadsheetId}`);
  }
  const sheetId   = sheet.properties.sheetId;
  const rowCount  = sheet.properties.gridProperties?.rowCount  || 1000;
  const endColumnIndex = endColumn.toUpperCase().charCodeAt(0) - "A".charCodeAt(0) + 1;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        repeatCell: {
          range: {
            sheetId,
            startRowIndex:    1,           // skip header row
            endRowIndex:      rowCount,
            startColumnIndex: 0,
            endColumnIndex:   endColumnIndex,
          },
          cell: {
            userEnteredFormat: { horizontalAlignment: "CENTER" },
          },
          fields: "userEnteredFormat.horizontalAlignment",
        },
      }],
    },
  });
}

module.exports = {
  appendRow, markForwarded, markForwardedBatch,
  applyCenterAlignmentBatch, applyColumnCenterAlignment,
  getLastDate, appendSeparatorRow, maybeInsertDayDivider, sortSheetByDate, findRowsInColumn, findDuplicateRows, getHeaderRow, findOutlierDates,
  updateStatusToLive, updateAdPrice, updateAdClient, updateAdDate, deleteAdRows,
  appendReminder, appendRemindersBatch, getPendingReminders, markReminderSent,
};
