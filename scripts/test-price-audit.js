#!/usr/bin/env node
/**
 * Tests the /auditprices logic (lib/priceAudit.js): reading per-page prices out
 * of a brief as it reads now, pairing placements with master / page P/L rows,
 * and building the /update price fix. Pure logic — no Sheets, Supabase or
 * Telegram credentials needed:
 *
 *   node scripts/test-price-audit.js
 *
 * Live check (Railway): run `/auditprices 7` as the admin in any chat the
 * Tracker is in. See the PR description for what to expect.
 */

const audit = require("../lib/priceAudit");

function assert(cond, msg) { console.log(cond ? "✅" : "❌", msg); if (!cond) process.exitCode = 1; }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const CHAT = -1001868750472;
const sec = (y, mo, d, h = 20) => Date.UTC(y, mo - 1, d, h) / 1000; // 20:00 UTC = 1pm AZ
const REGISTRY = { goof: 1, dankquillius: 1, hauntedfootage: 1, a: 1, b: 1, c: 1, moist: 1 };
const TYPOS = { dankqiullius: "dankquillius", hauntededfootage: "hauntedfootage" };
const resolve = (h) => (REGISTRY[h] ? h : TYPOS[h] || null);

const brief = (header, pageLines) => [
  header, "", "@davogabriel", "", "**INSTRUCTIONS:**", "- Reels", "- 30min NIF", "",
  "**PAGE INFO:**", "NOW / 4:45 PM AZ", ...pageLines,
].join("\n");

// ── The motivating case: Dom @jetla.exe on @goof, edited $165 → $250 ──────────
console.log("\n── extractPlacements ──");
const domMsg = { message_id: 79827, date: sec(2026, 11, 6), edit_date: sec(2026, 11, 6, 22),
  text: brief("Dom @jetla.exe - Music - $250", ["@goof - $250"]) };
const domDb = { client: "Dom @jetla.exe", date_posted: "Fri, 11/6/26",
  pages: [{ page_handle: "goof", page_price: "165", master_sheet_row: 812, page_sheet_row: 40 }] };
const dom = audit.extractPlacements(domMsg, domDb, { chatId: CHAT, resolve });
const p0 = dom.placements[0];
assert(dom.placements.length === 1 && p0.page === "goof", "one placement on @goof");
assert(p0.briefPrice === 250 && p0.dbPrice === 165, "brief $250 (as edited) vs DB $165");
assert(p0.link === "https://t.me/c/1868750472/79827", "t.me link built from the -100 chat id");
assert(eq(p0.dateKeys, ["11/6/26"]) && p0.edited, "date key 11/6/26, flagged as edited");
assert(p0.masterRow === 812 && p0.pageRow === 40, "stored row numbers carried through");

// Typo handle in the brief resolves to the registry page the DB row uses
const typo = audit.extractPlacements(
  { message_id: 1, date: sec(2026, 9, 2), text: brief("Pump.fun $daejon - Crypto - $250", ["@dankqiullius - $250"]) },
  { client: "Pump.fun $daejon", date_posted: "Wed, 9/2/26", pages: [{ page_handle: "dankquillius", page_price: 100 }] },
  { chatId: CHAT, resolve });
assert(typo.placements.length === 1 && typo.placements[0].page === "dankquillius" && !typo.added.length,
  "@dankqiullius in the brief matches the @dankquillius DB row");

// Multi-page brief edited to swap a page: @b added, @c removed
const swap = audit.extractPlacements(
  { message_id: 2, date: sec(2026, 10, 1), text: brief("Acme - Ecom - $600", ["@a - $300", "@b - $300"]) },
  { client: "Acme", date_posted: "Thu, 10/1/26", pages: [{ page_handle: "a", page_price: 300 }, { page_handle: "c", page_price: 300 }] },
  { chatId: CHAT, resolve });
assert(swap.placements.length === 1 && eq(swap.added, ["b"]) && eq(swap.removed, ["c"]), "page swap reported as added/removed");

assert(audit.extractPlacements({ message_id: 3, date: 0, text: "just chatting\nabout ads" }, domDb, { chatId: CHAT }).placements.length === 0,
  "non-brief text yields nothing");

// ── Row matching ──────────────────────────────────────────────────────────────
console.log("\n── matchRows (master: client + date + page) ──");
const M = { storedKey: "masterRow", byPage: true, resolve };
const mrow = (row, client, page, d, price) => ({ row, client, page, mo: 11, day: d, yr: 2026, price });
{
  const rows = [mrow(811, "Other", "@goof", 6, 100), mrow(812, "Dom @jetla.exe", "@goof", 6, 165), mrow(900, "Dom @jetla.exe", "@goof", 6, 250)];
  const got = audit.matchRows([p0], rows, M).get(p0);
  assert(got && got.row === 812, "stored row wins when it still holds the same client + page (even if another row's price matches)");
}
{
  // Rows shifted: stored 812 now holds a different client → fall back to client + date + page
  const rows = [mrow(812, "Other", "@goof", 6, 165), mrow(813, "Dom @jetla.exe", "@moist", 6, 250), mrow(814, "dom @jetla.exe ", "@goof", 6, 165)];
  const got = audit.matchRows([p0], rows, M).get(p0);
  assert(got && got.row === 814, "drifted stored row → client + date + page fallback (case/space-insensitive client)");
}
{
  // Two same-day placements of the same client on the same page, different prices
  const mk = (id, price, dbPrice) => ({ messageId: id, page: "goof", clients: ["dom @jetla.exe"], dateKeys: ["11/6/26"], briefPrice: price, dbPrice, masterRow: null });
  const pa = mk(10, 250, 165), pb = mk(11, 165, 165);
  const rows = [mrow(700, "Dom @jetla.exe", "@goof", 6, 165), mrow(701, "Dom @jetla.exe", "@goof", 6, 250)];
  const got = audit.matchRows([pa, pb], rows, M);
  assert(got.get(pa).row === 701 && got.get(pb).row === 700, "several client+date rows → each takes the price-matching row, none shared");
}
{
  const rows = [mrow(5, "Dom @jetla.exe", "@hauntededfootage", 6, 165)];
  const ph = { page: "hauntedfootage", clients: ["dom @jetla.exe"], dateKeys: ["11/6/26"], briefPrice: 165, dbPrice: 165 };
  assert(audit.matchRows([ph], rows, M).get(ph)?.row === 5, "typo page cell on the master resolves to the registry page");
}
{
  const rows = [mrow(5, "Dom @jetla.exe", "@goof", 7, 165)];
  assert(!audit.matchRows([p0], rows, M).has(p0), "only row is another date and not the stored row → not matched");
}

console.log("\n── matchRows (page P/L: client + date) ──");
{
  const P = { storedKey: "pageRow", byPage: false };
  const prow = (row, client, d, price) => ({ row, client, mo: 11, day: d, yr: 2026, price });
  const rows = [prow(39, "Someone", 6, 100), prow(41, "Dom @jetla.exe", 5, 165), prow(42, "Dom @jetla.exe", 6, 165)];
  assert(audit.matchRows([p0], rows, P).get(p0)?.row === 42, "stored row 40 gone → client + date picks row 42, not the 11/5 row");
}

// ── Compare + fix command ─────────────────────────────────────────────────────
console.log("\n── comparePlacement / output ──");
{
  const m = audit.comparePlacement(p0, { price: 165 }, { price: 165 });
  assert(m && m.master === 165 && m.pl === 165, "brief $250 vs master/page $165 → mismatch");
  assert(m.fix === "/update price https://t.me/c/1868750472/79827 @goof $250", "fix command: " + (m && m.fix));
  const ok = { ...p0, dbPrice: 250 };
  assert(audit.comparePlacement(ok, { price: 250 }, { price: 250 }) === null, "all agree → no mismatch");
  assert(audit.comparePlacement(ok, undefined, { price: 250 }) === null, "missing master row isn't itself a price mismatch");
  const mm = audit.comparePlacement(ok, undefined, { price: 100 });
  assert(mm && !mm.masterFound && mm.pl === 100, "page-only mismatch still reported");
  const text = audit.formatMismatch(audit.comparePlacement(p0, { price: 165 }, undefined, { master: 2, page: 1 }));
  assert(text.includes("✏️") && text.includes("page not found") && text.includes("`/update price https://t.me/c/1868750472/79827 @goof $250`"),
    "formatted block has edited marker, not-found and the command");
  assert(text.includes("3 other"), "warns that /update price would also rewrite 3 other rows");
}
{
  // The fix command must survive /update's own parsing (handlers/updateHandler.js)
  const cmd = audit.updateCommand(audit.tgLink(CHAT, 79827), "relewans", 727.57);
  const link = cmd.match(/t\.me\/c\/(\d+)\/(?:\d+\/)?(\d+)/i);
  assert(link && Number("-100" + link[1]) === CHAT && Number(link[2]) === 79827, "/update parses the link back to chat + message");
  const args = cmd.replace(/https?:\/\/t\.me\/\S+/gi, "").trim().match(/^\/update(?:@\w+)?\s+(\w+)\s+([\s\S]+)$/i);
  const price = args && args[2].match(/\$?([\d,]+(?:\.\d{1,2})?)\s*$/);
  assert(args && args[1] === "price" && /@relewans/.test(args[2]) && price && price[1] === "727.57", "/update parses subcommand, handle and $727.57");
}
{
  const rows = [{ row: 1, client: "Dom @jetla.exe", page: "@goof" }, { row: 2, client: "Dom @jetla.exe", page: "@goof" }, { row: 3, client: "Dom @jetla.exe", page: "@moist" }];
  assert(audit.collateralRows(p0, rows, rows[0], M) === 1, "collateral (master): other same-client rows on the same page only");
  assert(audit.collateralRows(p0, rows, rows[0], { byPage: false }) === 2, "collateral (page P/L): every other same-client row");
}

console.log("\n── helpers ──");
assert(audit.fmtPrice(727.57) === "$727.57" && audit.fmtPrice(250) === "$250" && audit.fmtPrice(null) === "—", "fmtPrice");
assert(audit.dateKeyOf("Wed, 6/3/2026") === "6/3/26" && audit.dateKeyOf("") === null, "dateKeyOf");

console.log(process.exitCode ? "\n❌ FAILURES" : "\n✅ all passed");
