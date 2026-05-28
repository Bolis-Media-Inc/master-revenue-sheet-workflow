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
  const sheets = google.sheets({ version: "v4", auth: client });

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
  const sheets = google.sheets({ version: "v4", auth: client });

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
  const sheets = google.sheets({ version: "v4", auth: client });

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

/**
 * Get the date value from the last populated row in column D (Date column).
 * Returns a normalised date string like "Fri 3/6/26", or null if not found.
 */
async function getLastDate(spreadsheetId, tabName) {
  const auth   = getAuth();
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });

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
  const sheets = google.sheets({ version: "v4", auth: client });

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
  const sheets = google.sheets({ version: "v4", auth: client });

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
  const sheets = google.sheets({ version: "v4", auth: client });

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
  const sheets = google.sheets({ version: "v4", auth: client });

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
  const sheets = google.sheets({ version: "v4", auth: client });

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
  const sheets = google.sheets({ version: "v4", auth: client });

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
  const sheets = google.sheets({ version: "v4", auth: client });

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
  const sheets = google.sheets({ version: "v4", auth: client });

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
  const sheets = google.sheets({ version: "v4", auth: client });

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
  const sheets = google.sheets({ version: "v4", auth: client });

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
  getLastDate, appendSeparatorRow,
  updateStatusToLive, updateAdPrice, updateAdDate, deleteAdRows,
  appendReminder, appendRemindersBatch, getPendingReminders, markReminderSent,
};
