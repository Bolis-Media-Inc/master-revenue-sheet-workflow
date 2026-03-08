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

module.exports = { appendRow };
