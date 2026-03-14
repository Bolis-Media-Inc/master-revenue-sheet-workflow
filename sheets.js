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
async function appendRow(spreadsheetId, tabName, rowValues) {
  const auth   = getAuth();
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });

  // A:K constrains the "find last row" lookup to columns A–K only.
  // OVERWRITE means "write to the next empty row" without inserting/shifting rows —
  // this prevents blank-row interleaving when the sheet has data beyond column K.
  const result = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tabName}!A:K`,
    valueInputOption: "USER_ENTERED", // Lets Sheets parse dates and currency strings
    insertDataOption: "OVERWRITE",
    requestBody: {
      values: [rowValues],
    },
  });

  // Parse row number from updatedRange e.g. "'2026 Ad Overview'!A245:K245"
  const updatedRange = result.data.updates?.updatedRange || "";
  const rowMatch     = updatedRange.match(/[A-Z](\d+):/);
  return rowMatch ? parseInt(rowMatch[1]) : null;
}

/**
 * Tick the "Forwarded" checkbox (column A) for the given 1-indexed row
 * in the master sheet. Column A is a checkbox — writing TRUE checks it.
 */
async function markForwarded(spreadsheetId, tabName, rowNumber) {
  if (!rowNumber) return;
  const auth   = getAuth();
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range:           `${tabName}!A${rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody:     { values: [["TRUE"]] },
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
      values: [[
        reminder.handle,
        reminder.client,
        reminder.destChatId,
        reminder.type,
        reminder.dueAt,
        "FALSE",
      ]],
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

module.exports = {
  appendRow, markForwarded,
  getLastDate, appendSeparatorRow,
  updateStatusToLive, updateAdPrice, deleteAdRows,
  appendReminder, getPendingReminders, markReminderSent,
};
