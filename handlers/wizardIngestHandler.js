/**
 * handlers/wizardIngestHandler.js
 *
 * Handles wizard-approved brief submissions handed off from Greg.
 *
 * Why this exists:
 *   Greg the wizard bot posts the brief + creatives to the Internal Network
 *   Ads chat after admin approval. bm_tracking_bot (this service) is also in
 *   that chat — BUT Telegram explicitly blocks bot-to-bot message delivery,
 *   so bm_tracking_bot's webhook never sees Greg's post. Without this
 *   handoff, wizard-submitted briefs would silently skip sheet writes,
 *   per-page forwarding, and DB tracking.
 *
 * Architecture:
 *   1. Greg posts to Internal Network Ads, captures message_ids
 *   2. Greg POSTs structured payload here with media message_ids
 *   3. We forward each page's media from Internal Network Ads to that
 *      page's IG Ads chat (bm_tracking_bot is a member everywhere)
 *   4. We write master sheet + per-page sheet rows
 *   5. We persist ad_briefs + ad_brief_pages (same schema as Danielson briefs)
 *
 * Payload shape (see contract in this file's TypeScript-style comment).
 */

const adBriefs       = require("../lib/adBriefs");
const pagesRegistry  = require("../lib/pages");
const {
  appendRow,
  markForwardedBatch,
  applyCenterAlignmentBatch,
} = require("../sheets");

const MASTER_SHEET_ID = process.env.MASTER_SHEET_ID;
const TAB_NAME        = process.env.SHEET_TAB_NAME      || "2026 Ad Overview";
const PAGE_TAB_NAME   = process.env.PAGE_SHEET_TAB_NAME || "IG Revenue Tracker";
const PLACEHOLDER_PATTERN = /^(SHEET_ID_|TELEGRAM_CHAT_ID_)/;

/**
 * Payload contract:
 * {
 *   source_chat_id:    -1001868750472,             // Internal Network Ads (where Greg posted)
 *   brief: {
 *     brief_message_id:    12345,                  // brief text msg in source_chat (required, used as DB unique key)
 *     raw_text:            "Polymarket - ...",     // canonical brief text
 *     client:              "Polymarket",
 *     category:            "Info Product",
 *     post_type:           "Carousel",
 *     post_duration:       "Permanent",
 *     nif:                 "30 MIN NIF" | null,
 *     date_posted:         "Sat, 5/31/26",
 *     time_mst:            "2:00 PM",
 *     caption_text:        "..." | null,
 *     caption_message_id:  12344 | null,           // if caption was posted as a separate msg
 *   },
 *   pages: [
 *     {
 *       handle: "tonsil",
 *       price: 750,
 *       bulk_num: "12/100" | null,
 *       media_message_ids: [12340, 12341],         // msg ids in source_chat to forward
 *     },
 *   ],
 *   sender: {
 *     telegram_user_id:   7712967091,              // contributor's id (Marcel)
 *     telegram_username:  "relewans",
 *     session_id:         "a14ea948-..." | null,
 *   },
 * }
 *
 * Returns { ok, brief_id?, writes: {master_rows, page_rows, forwarded_chats}, errors }
 */
async function ingestWizardBrief(telegram, payload) {
  const errors = [];
  const writes = { master_rows: 0, page_rows: 0, forwarded_chats: 0 };

  // ── Validate payload ────────────────────────────────────────────────────
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "invalid payload", writes };
  }
  const { source_chat_id, brief, pages, sender } = payload;
  if (!source_chat_id) return { ok: false, error: "source_chat_id required", writes };
  if (!brief || !brief.brief_message_id) {
    return { ok: false, error: "brief.brief_message_id required", writes };
  }
  if (!Array.isArray(pages) || pages.length === 0) {
    return { ok: false, error: "pages must be non-empty array", writes };
  }

  // ── 1. Insert ad_briefs + ad_brief_pages ────────────────────────────────
  // Mirrors what handleAdMessage does for Danielson briefs so /syncsheets
  // and /replay see wizard-submitted briefs the same way.
  const totalPrice = pages.reduce((s, p) => s + (Number.isFinite(p.price) ? p.price : 0), 0);
  let briefId = null;
  const pageRowIdByHandle = new Map();
  try {
    briefId = await adBriefs.insertBrief({
      telegramChatId:    Number(source_chat_id),
      telegramMessageId: brief.brief_message_id,
      senderUserId:      sender?.telegram_user_id ?? null,
      senderHandle:      sender?.telegram_username ?? null,
      rawText:           brief.raw_text || "",
      client:            brief.client || null,
      category:          brief.category || null,
      totalPrice,
      postType:          brief.post_type || null,
      postDuration:      brief.post_duration || null,
      nif:               brief.nif || null,
      datePosted:        brief.date_posted || null,
      timeMst:           brief.time_mst || null,
      sharedCaption:     brief.caption_text || null,
      bundleFormat:      "wizard-handoff",
    });
    if (briefId) {
      const pageRows = pages.map((p) => ({
        pageHandle: String(p.handle).toLowerCase(),
        bulkNum:    p.bulk_num || null,
        pagePrice:  Number.isFinite(p.price) ? p.price : null,
      }));
      const inserted = await adBriefs.insertBriefPages(briefId, pageRows);
      for (const [h, id] of inserted) pageRowIdByHandle.set(h, id);
      console.log(`[ingest-wizard-brief] 📥 Persisted brief ${briefId.slice(0, 8)}… (${pageRowIdByHandle.size}/${pages.length} pages)`);
    }
  } catch (err) {
    errors.push(`db insert: ${err.message}`);
    console.error(`[ingest-wizard-brief] ❌ DB persist: ${err.message}`);
    // Continue — sheet writes can still succeed
  }

  // ── 2. Master sheet rows ─────────────────────────────────────────────────
  const masterRowsToFormat = [];
  const masterRowsToTickForwarded = [];
  if (MASTER_SHEET_ID && !PLACEHOLDER_PATTERN.test(MASTER_SHEET_ID)) {
    for (const p of pages) {
      const handle = String(p.handle).toLowerCase();
      const row = [
        "",                                                              // A: Forwarded
        brief.client || "",                                              // B: Client
        brief.category || "",                                            // C: Ad Type
        brief.date_posted || "",                                         // D: Date
        brief.time_mst || "",                                            // E: Time (MST)
        `@${handle}`,                                                    // F: Page
        p.bulk_num || "",                                                // G: Bulk #
        Number.isFinite(p.price) ? `$${p.price}` : "",                   // H: Price
        "Scheduled",                                                     // I: Status
        "",                                                              // J: Views
        brief.nif || "",                                                 // K: NIF
      ];
      try {
        const rowNum = await appendRow(MASTER_SHEET_ID, TAB_NAME, row, { v2: {
          client: brief.client, category: brief.category, datePosted: brief.date_posted,
          timeMST: brief.time_mst, pageHandle: handle, bulkNum: p.bulk_num, adPrice: p.price,
          status: "Scheduled", nif: brief.nif, postType: brief.post_type, postDuration: brief.post_duration,
        } });
        if (rowNum) {
          writes.master_rows++;
          masterRowsToFormat.push(rowNum);
          masterRowsToTickForwarded.push(rowNum);
          const pageRowId = pageRowIdByHandle.get(handle);
          if (pageRowId) {
            await adBriefs.updatePageSheetRows(pageRowId, { masterSheetRow: rowNum }).catch(() => {});
          }
        }
      } catch (err) {
        errors.push(`master @${handle}: ${err.message}`);
        console.error(`[ingest-wizard-brief] ❌ Master row @${handle}: ${err.message}`);
      }
    }
    if (masterRowsToFormat.length > 0) {
      applyCenterAlignmentBatch(MASTER_SHEET_ID, TAB_NAME, masterRowsToFormat, "K").catch(() => {});
    }
  } else {
    errors.push("MASTER_SHEET_ID not set or is a placeholder");
  }

  // ── 3. Per-page sheet rows ───────────────────────────────────────────────
  for (const p of pages) {
    const handle = String(p.handle).toLowerCase();
    const canonicalHandle = pagesRegistry.resolveHandle(handle) || handle;
    const sheetId = pagesRegistry.getSheetId(canonicalHandle);
    if (!sheetId || PLACEHOLDER_PATTERN.test(sheetId)) {
      // Not necessarily an error — some pages legitimately have no per-page sheet yet
      continue;
    }
    const row = [
      brief.client || "",                                                // A: Client Name
      brief.category || "",                                              // B: Ad Type
      p.bulk_num || "",                                                  // C: Bulk #
      brief.date_posted || "",                                           // D: Date Posted
      brief.post_type || "",                                             // E: Post Type
      brief.post_duration || "",                                         // F: Post Duration
      Number.isFinite(p.price) ? `$${p.price}` : "",                     // G: Ad Price
      "",                                                                // H: Notes
    ];
    try {
      const rowNum = await appendRow(sheetId, PAGE_TAB_NAME, row, { anchorColumn: "A", endColumn: "H" });
      if (rowNum) {
        writes.page_rows++;
        const pageRowId = pageRowIdByHandle.get(handle);
        if (pageRowId) {
          await adBriefs.updatePageSheetRows(pageRowId, { pageSheetRow: rowNum }).catch(() => {});
        }
        applyCenterAlignmentBatch(sheetId, PAGE_TAB_NAME, [rowNum], "H").catch(() => {});
      }
    } catch (err) {
      errors.push(`page @${handle}: ${err.message}`);
      console.error(`[ingest-wizard-brief] ❌ Per-page @${handle}: ${err.message}`);
    }
  }

  // ── 4. Send per-page brief text to each page chat ───────────────────────
  // ONLY the brief text — media + caption forwarding is handled by Greg
  // using a user-account session (sales_bolismedia). Bot accounts can't
  // forwardMessage other bots' posts (Telegram's bot-to-bot filter), and
  // file_ids are bot-scoped so re-sending via sendDocument doesn't work
  // either. User accounts aren't subject to that filter, so Greg does it
  // post-handoff via userClient.forwardMessages.
  const RESULTS_CHAT_ID = process.env.RESULTS_CHAT_ID;
  if (RESULTS_CHAT_ID) {
    // Single-destination mode: send the FULL brief ONCE to the results chat (a
    // per-brief feed the team replies to with insights), not per-page. Then mark
    // every page forwarded so the books/DB match.
    try {
      await telegram.sendMessage(String(RESULTS_CHAT_ID), brief.raw_text || buildPerPageBrief(brief, pages[0] || {}));
      writes.forwarded_chats++;
    } catch (err) {
      errors.push(`brief → results: ${err.message}`);
      console.error(`[ingest-wizard-brief] ❌ Brief → results: ${err.message}`);
    }
    for (const p of pages) {
      const pageRowId = pageRowIdByHandle.get(String(p.handle).toLowerCase());
      if (pageRowId) await adBriefs.markPageForwarded(pageRowId, {}).catch(() => {});
    }
  } else {
    for (const p of pages) {
      const handle = String(p.handle).toLowerCase();
      const canonicalHandle = pagesRegistry.resolveHandle(handle) || handle;
      const destChatId = pagesRegistry.getChatId(canonicalHandle);
      if (!destChatId || PLACEHOLDER_PATTERN.test(String(destChatId))) {
        errors.push(`no chat_id for @${handle}`);
        continue;
      }

      try {
        const perPageBrief = buildPerPageBrief(brief, p);
        await telegram.sendMessage(String(destChatId), perPageBrief);
        writes.forwarded_chats++;
        // Mark forwarded — Greg's userClient takes care of media+caption next
        const pageRowId = pageRowIdByHandle.get(handle);
        if (pageRowId) {
          await adBriefs.markPageForwarded(pageRowId, {}).catch(() => {});
        }
      } catch (err) {
        errors.push(`brief → @${handle}: ${err.message}`);
        console.error(`[ingest-wizard-brief] ❌ Brief send → @${handle}: ${err.message}`);
        const pageRowId = pageRowIdByHandle.get(handle);
        if (pageRowId) {
          await adBriefs.markPageForwardError(pageRowId, err.message).catch(() => {});
        }
      }
    }
  }

  // ── 5. Tick Forwarded checkbox on master sheet for everything that forwarded
  // (batched single call). Best-effort.
  if (masterRowsToTickForwarded.length > 0 && MASTER_SHEET_ID) {
    markForwardedBatch(MASTER_SHEET_ID, TAB_NAME, masterRowsToTickForwarded)
      .then(() => console.log(`[ingest-wizard-brief] ✅ markForwarded ticked ${masterRowsToTickForwarded.length}`))
      .catch((err) => console.error(`[ingest-wizard-brief] ❌ markForwarded: ${err.message}`));
  }

  console.log(
    `[ingest-wizard-brief] 📊 Done — brief=${briefId?.slice(0, 8) || "skipped"}, ` +
    `master=${writes.master_rows}/${pages.length}, page=${writes.page_rows}/${pages.length}, ` +
    `forwarded=${writes.forwarded_chats}/${pages.length}, errors=${errors.length}`
  );

  return {
    ok: errors.length === 0,
    brief_id: briefId,
    writes,
    errors,
  };
}

/**
 * Build the per-page brief text shown in each page's IG Ads chat.
 * For now: use the full brief as-is (matching how Danielson posts it).
 * Future: rewrite the PAGE INFO section to show only this page's row
 * with its specific price (matching bm_tracking_bot's forwardToPage logic).
 */
function buildPerPageBrief(brief, page) {
  return brief.raw_text || `${brief.client} - ${brief.category} - $${page.price ?? "?"}\n\n@${page.handle} - $${page.price ?? "?"}`;
}

module.exports = { ingestWizardBrief };
