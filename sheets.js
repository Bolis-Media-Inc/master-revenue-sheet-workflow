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
async function appendRow(spreadsheetId, tabName, rowValues) {
  const auth   = getAuth();
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });

  // Use the tab name only (no column constraint) so the API finds the true last row
  // across ALL columns — avoids blank-row interleaving when the sheet has data beyond col K.
  // OVERWRITE means "write to first empty row" without inserting/shifting existing rows.
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: tabName,
    valueInputOption: "USER_ENTERED", // Lets Sheets parse dates and currency strings
    insertDataOption: "OVERWRITE",
    requestBody: {
      values: [rowValues],
    },
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
    range: tabName,
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

module.exports = { appendRow, getLastDate, appendSeparatorRow };
