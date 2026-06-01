/**
 * resolveHandler.js — Interactive cover-to-page assignment for ambiguous briefs
 *
 * Backs the /resolve command. When a brief lists N pages but only K
 * covers were @-labeled, the remaining covers default to "shared" and
 * every page gets every cover — wrong attribution for the operator.
 *
 * /resolve <brief_id_prefix>           — drill into one brief
 * /resolve                             — list recent ambiguous briefs
 *
 * UX flow (DM with the initiating operator):
 *   1. Header card — brief summary + page list + cover counter
 *   2. For each unattributed cover: a media message + page-buttons grid
 *      Each button has callback_data ca:<assignmentId>:<msgId>:<pageIdx>
 *      Special targets: ":shared" (every page gets this cover) and
 *      ":skip" (drop the cover from forwarding entirely).
 *   3. On tap: save to assignments JSONB, edit the cover's reply markup
 *      to show "✓ assigned to @<handle>" instead of the button grid.
 *   4. When every cover is assigned, header updates to "all assigned".
 *      Auto-resume forwarding lands in Phase 3 (queued task #36).
 *
 * Storage: pending_brief_assignments (migration 015). Single source of
 * truth — operator can resume the same session across Railway restarts.
 *
 * Permissions: WIZARD_ADMIN_USER_ID only (Connor). Sales contributors
 * shouldn't be reassigning other people's per-page attribution.
 */

const { createClient } = require("@supabase/supabase-js");

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;

function isAdmin(telegramId) {
  const id = parseInt(process.env.WIZARD_ADMIN_USER_ID || "0", 10);
  return id && Number(telegramId) === id;
}

// ── Markdown helpers ──────────────────────────────────────────────────────────

function md(text) {
  if (text == null) return "";
  return String(text).replace(/[_*`\[\]]/g, (c) => "\\" + c);
}

// ── Query helpers ─────────────────────────────────────────────────────────────

async function fetchBriefByPrefix(prefix) {
  // Briefs are UUID-keyed; prefix lookup via order+limit on text-cast id
  if (!supabase) throw new Error("Supabase not configured");
  // We can't reliably ::text-cast in a Supabase ilike filter from the JS
  // client — fetch recent briefs and filter client-side. Volume is low
  // enough this is fine (typically <1k briefs/wk).
  const { data, error } = await supabase
    .from("ad_briefs")
    .select("id, telegram_chat_id, telegram_message_id, client, total_price, raw_text, received_at, shared_media, bundle_format")
    .order("received_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(`ad_briefs lookup: ${error.message}`);
  const match = (data || []).find((b) => b.id.startsWith(prefix.toLowerCase()));
  return match || null;
}

async function fetchBriefPages(briefId) {
  const { data, error } = await supabase
    .from("ad_brief_pages")
    .select("page_handle, page_price, page_media, master_sheet_row, page_sheet_row, forwarded_at, forward_error")
    .eq("brief_id", briefId);
  if (error) throw new Error(`ad_brief_pages: ${error.message}`);
  return data || [];
}

async function listRecentAmbiguous(limit = 10) {
  // Heuristic: briefs where shared_media has items AND the page count
  // exceeds the number of distinct page_media keys (= multi-page with
  // unattributed covers). Run as a single query with a subselect to
  // avoid N+1.
  const { data, error } = await supabase
    .from("ad_briefs")
    .select(`
      id, client, received_at, shared_media,
      ad_brief_pages ( page_handle, page_media )
    `)
    .order("received_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(`recent ambiguous: ${error.message}`);
  const list = (data || []).filter((b) => {
    const sharedN = Array.isArray(b.shared_media) ? b.shared_media.length : 0;
    const pages   = Array.isArray(b.ad_brief_pages) ? b.ad_brief_pages : [];
    const pageN   = pages.length;
    const attrib  = pages.filter((p) => Array.isArray(p.page_media) && p.page_media.length > 0).length;
    return pageN > 1 && sharedN > 0 && attrib < pageN;
  }).slice(0, limit);
  return list;
}

async function findActiveSession(briefId, initiatedBy) {
  const { data, error } = await supabase
    .from("pending_brief_assignments")
    .select("*")
    .eq("brief_id", briefId)
    .eq("initiated_by", initiatedBy)
    .in("status", ["awaiting", "resolving"])
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`pba lookup: ${error.message}`);
  return data?.[0] || null;
}

async function createSession({ brief, pages, unattributed, initiatedBy }) {
  const { data, error } = await supabase
    .from("pending_brief_assignments")
    .insert({
      brief_id:         brief.id,
      source_chat_id:   brief.telegram_chat_id,
      brief_message_id: brief.telegram_message_id,
      brief_text:       (brief.raw_text || "").slice(0, 1000),
      pages:            pages,
      unattributed:     unattributed,
      assignments:      {},
      status:           "resolving",
      initiated_by:     initiatedBy,
      expires_at:       new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24h
    })
    .select()
    .single();
  if (error) throw new Error(`pba insert: ${error.message}`);
  return data;
}

async function saveAssignment(sessionId, msgId, target) {
  // Read-modify-write — small JSONB so locking isn't worth it
  const { data: cur, error: e1 } = await supabase
    .from("pending_brief_assignments")
    .select("assignments, unattributed, pages, status")
    .eq("id", sessionId)
    .single();
  if (e1) throw new Error(`pba read: ${e1.message}`);
  const assignments = { ...(cur.assignments || {}) };
  assignments[String(msgId)] = target;

  const totalCovers = Array.isArray(cur.unattributed) ? cur.unattributed.length : 0;
  const assignedCount = Object.keys(assignments).length;
  const newStatus = assignedCount >= totalCovers ? "resolved" : "resolving";

  const { data, error: e2 } = await supabase
    .from("pending_brief_assignments")
    .update({ assignments, status: newStatus })
    .eq("id", sessionId)
    .select()
    .single();
  if (e2) throw new Error(`pba update: ${e2.message}`);
  return data;
}

async function setPromptMessageIds(sessionId, chatId, messageIds) {
  const { error } = await supabase
    .from("pending_brief_assignments")
    .update({ prompt_chat_id: chatId, prompt_message_ids: messageIds })
    .eq("id", sessionId);
  if (error) console.error(`[resolve] setPromptMessageIds: ${error.message}`);
}

// ── UI helpers ────────────────────────────────────────────────────────────────

// Build the inline keyboard for one cover's assignment.
// Pages array is the brief's full page list; we map index → callback_data
// to keep callback payloads within Telegram's 64-byte limit.
function buildCoverKeyboard(sessionId, msgId, pages) {
  const rows = [];
  let row = [];
  for (let i = 0; i < pages.length; i++) {
    row.push({
      text:          `@${pages[i]}`,
      callback_data: `ca:${sessionId}:${msgId}:${i}`,
    });
    if (row.length === 2 || i === pages.length - 1) {
      rows.push(row);
      row = [];
    }
  }
  rows.push([
    { text: "🔁 Shared (all pages)", callback_data: `ca:${sessionId}:${msgId}:shared` },
    { text: "⏭️ Skip",                callback_data: `ca:${sessionId}:${msgId}:skip` },
  ]);
  return { inline_keyboard: rows };
}

function renderHeaderText(session, brief, assignedCount) {
  const totalCovers = (session.unattributed || []).length;
  const pages = (session.pages || []).map((p) => `@${p}`).join(", ");
  const lines = [
    "🛠️ *Brief assignment*",
    "─────────────────────────",
    `*Campaign:* ${md(brief?.client || "?")}`,
    `*Pages (${session.pages.length}):* ${md(pages)}`,
    "",
    `*Progress:* ${assignedCount}/${totalCovers} covers assigned`,
  ];
  if (assignedCount >= totalCovers && totalCovers > 0) {
    lines.push("");
    lines.push("✅ All covers assigned. Phase 3 will auto-resume forwarding here.");
    lines.push("_For now: copy the mapping above and run `/replay` after renaming the source files._");
  }
  return lines.join("\n");
}

function renderAssignmentBadge(target, pages) {
  if (target === "shared") return "🔁 Shared (every page)";
  if (target === "skip")   return "⏭️ Skipped";
  const idx = parseInt(target, 10);
  if (!isNaN(idx) && pages[idx]) return `→ @${pages[idx]}`;
  return `→ ${target}`;
}

// ── Main command + callback handlers ──────────────────────────────────────────

async function handleResolveCommand(ctx) {
  try {
    if (!isAdmin(ctx.from?.id)) return; // silent for non-admin
    if (!supabase) return ctx.reply("⚠️ Supabase not configured — can't run /resolve.");

    const args = (ctx.message?.text || "").trim().split(/\s+/).slice(1);
    const prefix = args[0]?.replace(/^#/, "").toLowerCase();

    // List mode — show recent ambiguous briefs
    if (!prefix) {
      const list = await listRecentAmbiguous(10);
      if (list.length === 0) {
        return ctx.reply("📭 No ambiguous briefs in the last 50 — everything looks attributed.");
      }
      const lines = ["🛠️ *Recent ambiguous briefs*", "─────────────────────────"];
      for (const b of list) {
        const sharedN = b.shared_media?.length || 0;
        const pages   = (b.ad_brief_pages || []).map((p) => `@${p.page_handle}`).slice(0, 3).join(", ");
        const more    = (b.ad_brief_pages || []).length > 3 ? ` +${(b.ad_brief_pages || []).length - 3}` : "";
        const date    = new Date(b.received_at).toLocaleString("en-US", { timeZone: "America/Phoenix", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
        lines.push(`\`#${b.id.slice(0, 8)}\` · ${date} AZ`);
        lines.push(`  ${md(b.client || "?")} — ${b.ad_brief_pages?.length || 0} pages, ${sharedN} unlabeled`);
        lines.push(`  ${md(pages + more)}`);
        lines.push("");
      }
      lines.push("`/resolve <id_prefix>` to start assigning covers.");
      return ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
    }

    // Drill-in mode — look up the brief
    const brief = await fetchBriefByPrefix(prefix);
    if (!brief) return ctx.reply(`❌ No brief found starting with \`${md(prefix)}\`.`, { parse_mode: "Markdown" });

    const pageRows = await fetchBriefPages(brief.id);
    const pages    = pageRows.map((p) => p.page_handle.toLowerCase());
    const shared   = Array.isArray(brief.shared_media) ? brief.shared_media : [];

    if (shared.length === 0) {
      return ctx.reply(`ℹ️ Brief \`#${brief.id.slice(0, 8)}\` has no unattributed covers — nothing to resolve.`, { parse_mode: "Markdown" });
    }
    if (pages.length < 2) {
      return ctx.reply(`ℹ️ Brief \`#${brief.id.slice(0, 8)}\` only has 1 page — there's nothing to disambiguate.`, { parse_mode: "Markdown" });
    }

    // Build the unattributed payload — each shared_media entry becomes an
    // assignable cover. shared_media items don't currently carry a
    // message_id; we synthesize one from the file_id so callback routing
    // works. (Phase 3 will refactor to persist message_ids upstream.)
    const unattributed = shared.map((m, i) => ({
      idx:       i,
      msg_id:    m.message_id || `synth-${i}`,
      file_id:   m.file_id,
      kind:      m.kind || "photo",
      file_name: m.file_name || null,
    }));

    // Re-use an existing session if one's already open for this brief+user
    let session = await findActiveSession(brief.id, ctx.from.id);
    if (!session) {
      session = await createSession({
        brief,
        pages,
        unattributed,
        initiatedBy: ctx.from.id,
      });
    }

    await postAssignmentUI(ctx.telegram, ctx.chat.id, session.id, { brief });
  } catch (err) {
    console.error("[resolve] command error:", err.message);
    try { await ctx.reply(`❌ /resolve failed: ${err.message}`); } catch (_) {}
  }
}

/**
 * Post the full assignment UI (header card + per-cover button grids) to a
 * chat. Used by /resolve (manual entry) AND by adHandler's pause block
 * (auto-trigger when ambiguity detected). Saves prompt_message_ids back to
 * the session so /resolve can resume cleanly if the operator re-runs it.
 *
 * @param {*} telegram   - Telegraf bot.telegram instance
 * @param {number|string} chatId - destination (admin DM or monetization chat)
 * @param {string} sessionId - pending_brief_assignments.id
 * @param {object} [opts] - { brief? } pre-fetched brief if caller has it
 */
async function postAssignmentUI(telegram, chatId, sessionId, opts = {}) {
  // Fetch session
  const { data: session, error: e1 } = await supabase
    .from("pending_brief_assignments").select("*").eq("id", sessionId).single();
  if (e1 || !session) throw new Error(`session not found: ${e1?.message || "(unknown)"}`);

  // Fetch brief (skip if caller pre-fetched)
  let brief = opts.brief;
  if (!brief) {
    const { data } = await supabase
      .from("ad_briefs").select("id, client, raw_text").eq("id", session.brief_id).single();
    brief = data;
  }

  const pages = session.pages || [];
  const unattributed = session.unattributed || [];
  const existingAssignments = session.assignments || {};

  // Post header
  const assignedCount = Object.keys(existingAssignments).length;
  const header = await telegram.sendMessage(chatId, renderHeaderText(session, brief, assignedCount), { parse_mode: "Markdown" });
  const sentIds = [header.message_id];

  // Post each cover with button grid
  for (const cover of unattributed) {
    const existing = existingAssignments[String(cover.msg_id)];
    const caption  = `Cover \`${md(cover.file_name || cover.msg_id)}\``;
    let sent;
    try {
      const sendFn = cover.kind === "video" ? telegram.sendVideo.bind(telegram)
                   : cover.kind === "document" || cover.kind === "animation" ? telegram.sendDocument.bind(telegram)
                   : telegram.sendPhoto.bind(telegram);
      sent = await sendFn(chatId, cover.file_id, {
        caption,
        parse_mode: "Markdown",
        reply_markup: existing ? undefined : buildCoverKeyboard(session.id, cover.msg_id, pages),
      });
      if (existing) {
        await telegram.editMessageCaption(chatId, sent.message_id, undefined,
          `${caption}\n\n${renderAssignmentBadge(existing, pages)}`,
          { parse_mode: "Markdown" }
        );
      }
    } catch (err) {
      // file_id may have aged out (rare but possible for old briefs) —
      // fall back to text-only prompt so the operator can still tap
      sent = await telegram.sendMessage(chatId,
        `*Cover ${cover.idx + 1}* — couldn't preview (${md(err.message)})\n\nFile: \`${md(cover.file_name || cover.msg_id)}\``,
        {
          parse_mode: "Markdown",
          reply_markup: existing ? undefined : buildCoverKeyboard(session.id, cover.msg_id, pages),
        }
      );
    }
    sentIds.push(sent.message_id);
  }

  await setPromptMessageIds(session.id, chatId, sentIds);
  return { headerMsgId: header.message_id, coverMsgIds: sentIds.slice(1) };
}

async function handleAssignmentCallback(ctx) {
  try {
    if (!isAdmin(ctx.from?.id)) {
      return ctx.answerCbQuery("Not authorized.", { show_alert: false });
    }
    const data = ctx.callbackQuery?.data || "";
    const m = data.match(/^ca:([0-9a-f-]+):([^:]+):(.+)$/);
    if (!m) return ctx.answerCbQuery("Bad callback.", { show_alert: false });
    const [, sessionId, msgId, target] = m;

    const updated = await saveAssignment(sessionId, msgId, target);

    // Edit THIS cover's caption to show the badge + remove the keyboard
    const pages = updated.pages || [];
    const badge = renderAssignmentBadge(target, pages);
    const chatId = ctx.callbackQuery.message.chat.id;
    const messageId = ctx.callbackQuery.message.message_id;
    const oldCaption = ctx.callbackQuery.message.caption || ctx.callbackQuery.message.text || "Cover";
    try {
      // Editing caption works for photo/video/doc; editMessageText works for text-only
      if (ctx.callbackQuery.message.caption !== undefined) {
        await ctx.telegram.editMessageCaption(chatId, messageId, undefined,
          `${oldCaption}\n\n${badge}`,
          { parse_mode: "Markdown" }
        );
      } else {
        await ctx.telegram.editMessageText(chatId, messageId, undefined,
          `${oldCaption}\n\n${badge}`,
          { parse_mode: "Markdown" }
        );
      }
    } catch (err) {
      // Editing can fail if message is too old or unchanged — ignore
      console.warn(`[resolve] edit caption failed: ${err.message}`);
    }

    // Also refresh the header (first prompt message) with new progress count
    const totalCovers = (updated.unattributed || []).length;
    const assignedCount = Object.keys(updated.assignments || {}).length;
    const promptIds = updated.prompt_message_ids || [];
    if (promptIds.length > 0) {
      // Need the brief for the header context; lightweight re-fetch
      const { data: brief } = await supabase
        .from("ad_briefs").select("client").eq("id", updated.brief_id).single();
      try {
        await ctx.telegram.editMessageText(chatId, promptIds[0], undefined,
          renderHeaderText(updated, brief, assignedCount),
          { parse_mode: "Markdown" }
        );
      } catch (_) {}
    }

    const done = assignedCount >= totalCovers;
    await ctx.answerCbQuery(done ? `✅ All ${totalCovers} assigned` : `Saved (${assignedCount}/${totalCovers})`, { show_alert: false });

    // ── Phase 3: auto-forward when all assignments are in ─────────────────
    // Last tap just landed → resume forwarding using the manual mapping.
    // For each assigned cover, send it to the target page's chat. "Shared"
    // assignments fan out to every page. "Skip" drops the cover entirely.
    // Then forward the brief text to each page so they have full context.
    if (done) {
      runPhase3Forward(ctx, updated).catch((err) => {
        console.error("[resolve] Phase 3 forward failed:", err.message);
      });
    }
  } catch (err) {
    console.error("[resolve] callback error:", err.message);
    try { await ctx.answerCbQuery(`❌ ${err.message}`, { show_alert: true }); } catch (_) {}
  }
}

// ── Phase 3: re-forward correctly attributed media when /resolve completes ──

async function fetchPageChats(handles) {
  if (!supabase) return new Map();
  const { data, error } = await supabase
    .from("pages")
    .select("handle, chat_id, auto_forward")
    .in("handle", handles);
  if (error) {
    console.error(`[resolve] fetchPageChats: ${error.message}`);
    return new Map();
  }
  const map = new Map();
  for (const row of data || []) {
    if (row.auto_forward && row.chat_id) {
      map.set(row.handle.toLowerCase(), row.chat_id);
    }
  }
  return map;
}

async function fetchBriefById(briefId) {
  const { data, error } = await supabase
    .from("ad_briefs")
    .select("id, telegram_chat_id, telegram_message_id, client, raw_text, shared_caption")
    .eq("id", briefId)
    .single();
  if (error) {
    console.error(`[resolve] fetchBriefById: ${error.message}`);
    return null;
  }
  return data;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function sendByKind(telegram, chatId, kind, fileId) {
  if (kind === "video")     return telegram.sendVideo(chatId, fileId);
  if (kind === "audio")     return telegram.sendAudio(chatId, fileId);
  if (kind === "animation") return telegram.sendAnimation(chatId, fileId);
  if (kind === "document")  return telegram.sendDocument(chatId, fileId);
  return telegram.sendPhoto(chatId, fileId);
}

/**
 * Run the corrected per-page forward using the manual cover-to-page mapping
 * stored in pending_brief_assignments. Each assigned cover goes to exactly
 * one page (or all pages if "shared"). Skipped covers are dropped.
 *
 * Also forwards the brief text to each destination so the page has full
 * context. Caption text and the original brief itself live in the source
 * chat — re-forward those by message_id from there.
 *
 * Fail-soft: per-cover errors are logged, not raised. Final summary edits
 * the resolve session's header to show the outcome.
 */
async function runPhase3Forward(ctx, session) {
  const brief = await fetchBriefById(session.brief_id);
  if (!brief) {
    await ctx.telegram.sendMessage(ctx.callbackQuery.message.chat.id,
      "❌ Phase 3: couldn't fetch brief from DB — re-run /replay manually."
    ).catch(() => {});
    return;
  }
  const pages = session.pages || [];
  const pageChats = await fetchPageChats(pages);
  const assignments = session.assignments || {};
  const unattributed = session.unattributed || [];

  // Build msg_id → target handles map ("shared" expands to all pages,
  // "skip" maps to [] which means don't forward this cover at all).
  const targetsByMsgId = new Map();
  for (const cover of unattributed) {
    const a = assignments[String(cover.msg_id)];
    if (a === undefined || a === "skip") {
      targetsByMsgId.set(cover.msg_id, []);
      continue;
    }
    if (a === "shared") {
      targetsByMsgId.set(cover.msg_id, pages.filter((p) => pageChats.has(p)));
      continue;
    }
    const idx = parseInt(a, 10);
    if (!isNaN(idx) && pages[idx] && pageChats.has(pages[idx])) {
      targetsByMsgId.set(cover.msg_id, [pages[idx]]);
    } else {
      targetsByMsgId.set(cover.msg_id, []);
    }
  }

  // Send each cover to its target(s), then the brief to every page.
  // Small sleep between sends to dodge Telegram's per-chat flood limits.
  let sentCount = 0;
  let errCount  = 0;
  const errors  = [];
  for (const cover of unattributed) {
    const targets = targetsByMsgId.get(cover.msg_id) || [];
    for (const handle of targets) {
      const destChatId = pageChats.get(handle);
      try {
        await sendByKind(ctx.telegram, destChatId, cover.kind || "photo", cover.file_id);
        sentCount++;
        await sleep(80);
      } catch (err) {
        errCount++;
        errors.push(`@${handle}: ${err.message}`);
        console.error(`[resolve] Phase 3 send to @${handle}: ${err.message}`);
      }
    }
  }

  // Forward the brief text to every page that received any cover
  const destHandles = pages.filter((p) => pageChats.has(p));
  for (const handle of destHandles) {
    try {
      await ctx.telegram.forwardMessage(
        String(pageChats.get(handle)),
        String(brief.telegram_chat_id),
        Number(brief.telegram_message_id)
      );
      await sleep(80);
    } catch (err) {
      console.error(`[resolve] Phase 3 brief forward → @${handle}: ${err.message}`);
    }
  }

  // Mark session done — flips status from "resolved" to "resolved" (already
  // there) but records prompt edits below. Future: add "completed_at"
  // column to distinguish "all assigned" from "all forwarded".
  await supabase
    .from("pending_brief_assignments")
    .update({ status: "resolved" })
    .eq("id", session.id);

  const summaryText =
    `✅ *Phase 3 complete*\n` +
    `─────────────────────────\n` +
    `Covers sent: ${sentCount}\n` +
    `Errors:      ${errCount}\n` +
    `Brief forwarded to: ${destHandles.length}/${pages.length} pages\n\n` +
    (errCount > 0
      ? `*Errors:*\n${errors.slice(0, 5).map((e) => "  • " + md(e)).join("\n")}` +
        (errors.length > 5 ? `\n  …and ${errors.length - 5} more (check logs)` : "")
      : `_Run \`/syncsheets\` to backfill master + per-page sheet rows._`);

  try {
    await ctx.telegram.sendMessage(ctx.callbackQuery.message.chat.id, summaryText, { parse_mode: "Markdown" });
  } catch (err) {
    console.error(`[resolve] Phase 3 summary post: ${err.message}`);
  }
}

module.exports = {
  handleResolveCommand,
  handleAssignmentCallback,
  postAssignmentUI,
};
