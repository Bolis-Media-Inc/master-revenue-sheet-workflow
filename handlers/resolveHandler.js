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

// Reuse the existing Supabase client from lib/sessions — it already has the
// right env var names (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) and is
// initialized once. Creating a separate client here with the wrong env var
// name (SUPABASE_SERVICE_KEY vs SUPABASE_SERVICE_ROLE_KEY) caused a null
// client → "Cannot read properties of null (reading 'from')" when the
// auto-post UI tried to query pending_brief_assignments.
const { _supabase: supabase } = require("../lib/sessions");

function isAdmin(telegramId) {
  const id = parseInt(process.env.WIZARD_ADMIN_USER_ID || "0", 10);
  // Fail-OPEN when WIZARD_ADMIN_USER_ID isn't set on this service — matches
  // /editbrief, /replay, /syncsheets. Without this, /resolve silently
  // no-ops for everyone (the "nothing happens" bug), because id=0 makes the
  // gate always false. Better to allow + log in a trusted internal chat than
  // to silently reject the operator.
  if (!id) return true;
  return Number(telegramId) === id;
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
    lines.push("✅ *All covers assigned.* Review them, then tap *Forward all* below to send.");
    lines.push("_Misclick? Just tap a different page under that cover to re-assign — nothing sends until you press Forward._");
  } else {
    lines.push("");
    lines.push(`⏸️ *Forwarding paused* — ${totalCovers} cover${totalCovers === 1 ? "" : "s"}, no per-page @handle, so I can't tell which goes where.`);
    lines.push("Tap a page under each cover to assign it (re-tap to change). A *Forward all* button appears once every cover is mapped.");
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

    // ── Multi-group flow ──────────────────────────────────────────────────
    // If this brief has a 'groups' session (covers/slides/caption split across
    // page groups), handle the page→group mapping. If none exists yet (brief
    // predates the feature / buffer cleared, e.g. SESH), RE-READ the source
    // messages live and build the session on the fly.
    let groupSession = await findGroupSession(brief.id);
    if (!groupSession) {
      groupSession = await tryBuildGroupSessionFromLive(ctx.telegram, brief, ctx.chat.id);
    }
    if (groupSession) {
      // Cover-button picking: post each cover with page buttons (group-aware
      // forward fires when all are assigned). The operator picks cover→page,
      // and each page inherits that cover's group's slides + caption.
      await postAssignmentUI(ctx.telegram, ctx.chat.id, groupSession.id, { brief });
      return;
    }

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

// ═══════════════════════════════════════════════════════════════════════
// Multi-group resolver (covers/slides/caption split across page groups)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Build a 'groups' session by RE-READING the brief's source messages live
 * (via sales_bolismedia), for briefs that predate the capture feature or
 * whose buffer was cleared (e.g. SESH). The covers/slides/captions are still
 * in the source chat; we reconstruct the block structure and store each
 * media item as a {msg_id} ref so the forward re-sends it by message id (no
 * Bot-API file_id needed). Returns the session, or null if not multi-group.
 */
async function tryBuildGroupSessionFromLive(telegram, brief, promptChatId) {
  if (!supabase || !brief?.telegram_chat_id || !brief?.telegram_message_id) return null;
  try {
    const userClient = require("../userClient");
    const { getBlockStructure } = require("../messageBuffer");
    const live = await userClient.getMessagesBefore(brief.telegram_chat_id, brief.telegram_message_id, 100);
    if (!live || live.length === 0) return null;

    // Normalize for getBlockStructure: message_id + text + a media flag.
    const norm = live.map((m) => ({
      message_id: m.message_id,
      text:       m.text,
      document:   m.hasMedia ? {} : undefined, // generic media marker (forward by id)
    }));
    // Ensure the brief itself is the anchor.
    if (!norm.find((m) => m.message_id === Number(brief.telegram_message_id))) {
      norm.push({ message_id: Number(brief.telegram_message_id), text: brief.raw_text || "" });
    }

    const bs = getBlockStructure(brief.telegram_chat_id, Number(brief.telegram_message_id), norm);
    if (!bs || !bs.isMultiGroup) return null;

    // blocks = per-group slides + caption (NO covers — covers go into the
    // cover-button assignment list so the operator picks cover→page).
    const blocks = bs.groups.map((g) => ({
      key:        g.key,
      caption:    g.caption || null,
      namedPages: g.namedPages || null,
      slideRefs:  (g.slides || []).map((m) => ({ msg_id: m.message_id })),
    }));
    // unattributed = ALL covers across groups, each tagged with its group so
    // the forward attaches that group's slides + caption. Operator taps each
    // cover → page (the cover-button UI). Live covers carry msg_id (forwarded
    // by id), not a Bot-API file_id.
    let idx = 0;
    const unattributed = [];
    bs.groups.forEach((g, gi) => {
      for (const m of (g.covers || [])) {
        unattributed.push({ idx: idx++, msg_id: m.message_id, group: gi, kind: "photo", file_name: null });
      }
    });

    const pageRows = await fetchBriefPages(brief.id);
    const pages = pageRows.map((p) => p.page_handle.toLowerCase());

    const { data: session, error } = await supabase
      .from("pending_brief_assignments")
      .insert({
        brief_id:         brief.id,
        source_chat_id:   Number(brief.telegram_chat_id),
        brief_message_id: Number(brief.telegram_message_id),
        brief_text:       (brief.raw_text || "").slice(0, 1000),
        pages,
        kind:             "groups",
        blocks,
        unattributed,
        assignments:      {},
        status:           "awaiting",
        prompt_chat_id:   Number(promptChatId),
        expires_at:       new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      })
      .select()
      .single();
    if (error || !session) { console.error(`[resolve] live-build session: ${error?.message}`); return null; }

    console.log(`[resolve] 🧩 live-rebuilt group session ${session.id.slice(0, 8)} for brief ${brief.id.slice(0, 8)} (${blocks.length} groups, ${unattributed.length} covers from ${live.length} live msgs)`);
    return session;
  } catch (e) {
    console.error(`[resolve] tryBuildGroupSessionFromLive: ${e.message}`);
    // Surface the common config gap instead of silently falling back to the
    // cover-only flow: the live re-scan needs the sales_bolismedia user
    // session, which must be set on THIS service.
    if (/Missing TELEGRAM|TELEGRAM_SESSION|TELEGRAM_API/i.test(e.message || "")) {
      await telegram.sendMessage(promptChatId,
        "⚠️ Multi-group re-scan needs the *sales_bolismedia* user session on this service " +
        "(`TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION`). Copy them from Greg's " +
        "Railway service, redeploy, then `/resolve` again.\n\n_(Falling back to cover-only assignment for now — ignore it for a multi-group brief.)_",
        { parse_mode: "Markdown" }
      ).catch(() => {});
    }
    return null;
  }
}

/** Latest AWAITING group session for a brief. Resolved ones are ignored so a
 *  re-/resolve triggers a fresh live-rebuild rather than reusing stale data. */
async function findGroupSession(briefId) {
  if (!supabase) return null;
  const { data } = await supabase
    .from("pending_brief_assignments")
    .select("*")
    .eq("brief_id", briefId)
    .eq("kind", "groups")
    .eq("status", "awaiting")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

/**
 * Parse a page→group mapping like:
 *   "G1: @a @b | G2: @c @d"   (also newline-separated; G1/G2 case-insensitive)
 * Returns { handle: groupIndex } (G1 → 0). Requires @-prefixed handles so
 * group tokens never swallow handles containing 'g' (e.g. @goal).
 */
function parseGroupMapping(text, numGroups) {
  const out = {};
  const parts = String(text || "").split(/\bG\s*(\d+)\s*[:\-]/i);
  for (let i = 1; i < parts.length; i += 2) {
    const gi = parseInt(parts[i], 10) - 1;
    if (gi < 0 || gi >= numGroups) continue;
    const handles = ((parts[i + 1] || "").match(/@([\w.]+)/g) || [])
      .map((h) => h.slice(1).toLowerCase());
    for (const h of handles) out[h] = gi;
  }
  return out;
}

/**
 * Post the group-mapping prompt to a chat. Lists each group's caption +
 * cover/slide counts and the brief's pages, with the exact /resolve command
 * to reply with.
 */
async function postGroupPrompt(telegram, chatId, session, briefId) {
  const briefShort = (briefId || session.brief_id).slice(0, 8);
  const groups = session.blocks || [];
  const pages  = session.pages  || [];
  // PLAIN TEXT (no parse_mode): page handles contain underscores
  // (@i_have_no_memes96_v2) and captions contain arbitrary chars, which break
  // Telegram's Markdown entity parser ("can't parse entities").
  const lines = [
    `⏸️ Multi-group brief — needs page→group mapping`,
    `─────────────────────────`,
    `${groups.length} creative groups across ${pages.length} pages. Each group has its own covers/slides/caption — map your pages, then I'll forward.`,
    ``,
  ];
  groups.forEach((g, i) => {
    const cap = (g.caption || "").split("\n")[0].slice(0, 70);
    const named = g.namedPages ? ` · already named: ${g.namedPages.map((h) => "@" + h).join(" ")}` : "";
    lines.push(`G${i + 1} — ${(g.coverRefs || []).length} covers · ${(g.slideRefs || []).length} slides${named}`);
    if (cap) lines.push(`   "${cap}…"`);
  });
  lines.push(``, `Pages: ${pages.map((h) => "@" + h).join(" ")}`, ``,
    `Reply:\n/resolve ${briefShort} G1: @page @page | G2: @page @page`);
  const sent = await telegram.sendMessage(chatId, lines.join("\n"))
    .catch((e) => { console.error(`[resolve] postGroupPrompt: ${e.message}`); return null; });
  if (sent?.message_id) {
    await supabase.from("pending_brief_assignments")
      .update({ prompt_message_ids: [sent.message_id], prompt_chat_id: Number(chatId) })
      .eq("id", session.id);
  }
}

/**
 * Create a 'groups' session + post the cover-button assignment UI. Called from
 * adHandler at intake when getBlockStructure flags a multi-group brief.
 * `opts.groups` = [{ key, caption, namedPages, coverRefs:[{file_id,kind}],
 * slideRefs }]. Covers go into `unattributed` (each tagged with its group) so
 * the operator picks cover→page; slides+caption stay in `blocks` per group.
 * Returns true if a session was created (caller pauses forwarding).
 */
async function createGroupSessionAndPrompt(telegram, opts) {
  if (!supabase) return false;
  try {
    const promptTarget = opts.alertChatId || opts.sourceChatId;
    // blocks = per-group slides + caption; covers move to unattributed.
    const blocks = (opts.groups || []).map((g) => ({
      key: g.key, caption: g.caption || null, namedPages: g.namedPages || null,
      slideRefs: g.slideRefs || [],
    }));
    let idx = 0;
    const unattributed = [];
    (opts.groups || []).forEach((g, gi) => {
      for (const ref of (g.coverRefs || [])) {
        unattributed.push({ idx: idx++, msg_id: ref.msg_id ?? `synth-${idx}`, file_id: ref.file_id, kind: ref.kind || "photo", file_name: ref.file_name || null, group: gi });
      }
    });

    const { data: session, error } = await supabase
      .from("pending_brief_assignments")
      .insert({
        brief_id:         opts.briefId,
        source_chat_id:   Number(opts.sourceChatId),
        brief_message_id: Number(opts.briefMessageId),
        brief_text:       (opts.briefText || "").slice(0, 1000),
        pages:            opts.pages,
        kind:             "groups",
        blocks,
        unattributed,
        assignments:      {},
        status:           "awaiting",
        prompt_chat_id:   promptTarget ? Number(promptTarget) : null,
        expires_at:       new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      })
      .select()
      .single();
    if (error) { console.error(`[resolve] createGroupSession: ${error.message}`); return false; }

    if (promptTarget) await postAssignmentUI(telegram, promptTarget, session.id);
    console.log(`[resolve] 🧩 group session ${session.id.slice(0, 8)} created (${blocks.length} groups, ${unattributed.length} covers), prompt → ${promptTarget}`);
    return true;
  } catch (e) {
    console.error(`[resolve] createGroupSessionAndPrompt: ${e.message}`);
    return false;
  }
}

/** Apply a mapping (or re-post the prompt if none) for a group session. */
async function resolveGroupSession(ctx, session, brief, mappingText) {
  const groups = session.blocks || [];
  if (!mappingText || !mappingText.trim()) {
    await postGroupPrompt(ctx.telegram, ctx.chat.id, session, brief.id);
    return;
  }
  // Merge new mapping over any auto-assigned (named-page) groups.
  const parsed = parseGroupMapping(mappingText, groups.length);
  const assignments = { ...(session.group_assignments || {}), ...parsed };
  if (Object.keys(assignments).length === 0) {
    return ctx.reply(
      `❌ Couldn't read a mapping. Use: \`/resolve ${brief.id.slice(0, 8)} G1: @a @b | G2: @c\``,
      { parse_mode: "Markdown" },
    ).catch(() => {});
  }
  session.group_assignments = assignments;
  const { sent, errs } = await runGroupForward(ctx, session, brief);
  const lines = [`✅ *Multi-group forward complete*`, `─────────────────────────`, `Pages forwarded: ${sent}`];
  if (errs.length) {
    lines.push(`Errors: ${errs.length}`);
    errs.slice(0, 5).forEach((e) => lines.push(`• \`${md(e)}\``));
  } else {
    lines.push(`_Sheets already written at intake — not touched._`);
  }
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" }).catch(() => {});
}

/**
 * Forward each page its assigned group's content: one cover (by position in
 * the group), the group's slides, the group's caption, and the per-page
 * brief. Records forwarded_message_ids per page. NO sheet writes.
 */
async function runGroupForward(ctx, session, briefArg) {
  const brief = briefArg || (await fetchBriefById(session.brief_id));
  const groups = session.blocks || [];
  const assignments = session.group_assignments || {};
  const pages = session.pages || [];
  const pageChats = await fetchPageChats(pages);

  const { buildPerPageBriefText } = require("./adHandler");
  const { parseAdMessage } = require("../parser");
  const parsed = parseAdMessage(brief.raw_text || "", new Date());
  const plist = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
  const priceBy = new Map();
  for (const p of plist) if (p.pageHandle) priceBy.set(p.pageHandle.toLowerCase(), p.adPrice);

  // Pages per group, in assignment order (cover distribution uses this order).
  const groupPages = groups.map(() => []);
  for (const [h, gi] of Object.entries(assignments)) {
    if (groupPages[gi]) groupPages[gi].push(h);
  }

  // Send one media ref to a chat: by Bot-API file_id (captured-at-intake
  // sessions) OR by forwarding the source message id (live-rebuilt sessions).
  const sendRef = async (chatId, ref) => {
    if (!ref) return null;
    if (ref.file_id) return sendByKind(ctx.telegram, chatId, ref.kind || "photo", ref.file_id);
    if (ref.msg_id != null) return ctx.telegram.forwardMessage(chatId, String(brief.telegram_chat_id), Number(ref.msg_id));
    return null;
  };

  let sent = 0;
  const errs = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const handles = groupPages[gi] || [];
    for (let idx = 0; idx < handles.length; idx++) {
      const handle = handles[idx];
      const destChatId = pageChats.get(handle);
      if (!destChatId) { errs.push(`@${handle}: no chat configured`); continue; }
      const ids = [];
      try {
        // 1. one cover (by position within the group, wrap if fewer covers)
        if ((g.coverRefs || []).length) {
          const cover = g.coverRefs[idx % g.coverRefs.length];
          const s = await sendRef(String(destChatId), cover);
          if (s?.message_id) ids.push(s.message_id);
          await sleep(80);
        }
        // 2. the group's slides (all, shared within group)
        for (const sl of (g.slideRefs || [])) {
          const s = await sendRef(String(destChatId), sl);
          if (s?.message_id) ids.push(s.message_id);
          await sleep(80);
        }
        // 3. the group's caption
        if (g.caption && g.caption.trim()) {
          const s = await ctx.telegram.sendMessage(String(destChatId), g.caption);
          if (s?.message_id) ids.push(s.message_id);
          await sleep(80);
        }
        // 4. per-page brief (rewritten), brief id LAST in the array
        const ppt = buildPerPageBriefText(brief.raw_text || "", handle, priceBy.get(handle));
        const s = ppt
          ? await ctx.telegram.sendMessage(String(destChatId), ppt)
          : await ctx.telegram.forwardMessage(String(destChatId), String(brief.telegram_chat_id), Number(brief.telegram_message_id));
        if (s?.message_id) ids.push(s.message_id);
        sent++;

        // record sent ids (undo/replay) — NO sheet writes
        const pr = await supabase.from("ad_brief_pages")
          .select("id").eq("brief_id", brief.id).eq("page_handle", handle).maybeSingle();
        if (pr.data?.id) {
          await supabase.from("ad_brief_pages")
            .update({ forwarded_at: new Date().toISOString(), forwarded_message_ids: ids })
            .eq("id", pr.data.id);
        }
      } catch (e) {
        errs.push(`@${handle}: ${e.message}`);
        console.error(`[resolve] group forward @${handle}: ${e.message}`);
      }
    }
  }
  await supabase.from("pending_brief_assignments")
    .update({ status: "resolved", group_assignments: assignments }).eq("id", session.id);
  return { sent, errs };
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
    const grpTag   = cover.group != null ? ` · G${cover.group + 1}` : "";
    const caption  = `Cover \`${md(cover.file_name || cover.msg_id)}\`${grpTag}`;
    // Always attach the keyboard — covers stay re-assignable (re-tap to change)
    // until the operator presses "Forward all". Nothing auto-forwards.
    const keyboard = buildCoverKeyboard(session.id, cover.msg_id, pages);
    let sent;
    try {
      if (!cover.file_id && cover.msg_id != null && session.source_chat_id) {
        // Live-rebuilt session: no Bot-API file_id. Copy the original cover
        // message from the source chat (preserves the image) WITH the buttons.
        sent = await telegram.copyMessage(chatId, String(session.source_chat_id), Number(cover.msg_id), {
          caption, parse_mode: "Markdown", reply_markup: keyboard,
        });
      } else {
        const sendFn = cover.kind === "video" ? telegram.sendVideo.bind(telegram)
                     : cover.kind === "document" || cover.kind === "animation" ? telegram.sendDocument.bind(telegram)
                     : telegram.sendPhoto.bind(telegram);
        sent = await sendFn(chatId, cover.file_id, {
          caption,
          parse_mode: "Markdown",
          reply_markup: keyboard,
        });
      }
      if (existing) {
        // Show the saved badge but KEEP the keyboard so it's still changeable.
        // Plain text — the badge's @handle underscores break Markdown.
        await telegram.editMessageCaption(chatId, sent.message_id, undefined,
          `Cover ${cover.file_name || cover.msg_id}${grpTag}\n\n${renderAssignmentBadge(existing, pages)}`,
          { reply_markup: keyboard }
        );
      }
    } catch (err) {
      // file_id may have aged out (rare but possible for old briefs) —
      // fall back to text-only prompt so the operator can still tap
      sent = await telegram.sendMessage(chatId,
        `*Cover ${cover.idx + 1}* — couldn't preview (${md(err.message)})\n\nFile: \`${md(cover.file_name || cover.msg_id)}\``,
        {
          parse_mode: "Markdown",
          reply_markup: keyboard,
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
    const data = ctx.callbackQuery?.data || "";
    const m = data.match(/^ca:([0-9a-f-]+):([^:]+):(.+)$/);
    if (!m) return ctx.answerCbQuery("Bad callback.", { show_alert: false });
    const [, sessionId, msgId, target] = m;

    // Auth: either WIZARD_ADMIN_USER_ID matches OR the tap happened in the
    // same chat where the UI was posted (the bot already gated who can see
    // those prompts by choosing which chat to deliver them to — that IS
    // the auth boundary). This lets the Tracker service work even if
    // WIZARD_ADMIN_USER_ID isn't set on it (only Greg's service has it
    // historically).
    let authorized = isAdmin(ctx.from?.id);
    if (!authorized) {
      const tapChatId = ctx.callbackQuery?.message?.chat?.id;
      if (tapChatId) {
        const { data: sess } = await supabase
          .from("pending_brief_assignments")
          .select("prompt_chat_id")
          .eq("id", sessionId)
          .single();
        if (sess?.prompt_chat_id && Number(sess.prompt_chat_id) === Number(tapChatId)) {
          authorized = true;
        }
      }
    }
    if (!authorized) {
      console.warn(`[resolve] callback denied — user ${ctx.from?.id} session ${sessionId.slice(0, 8)} chat ${ctx.callbackQuery?.message?.chat?.id}`);
      return ctx.answerCbQuery("Not authorized.", { show_alert: false });
    }

    // ── "Forward all" button → THE only thing that forwards ─────────────────
    // Assignment is never auto-forwarded anymore, so a misclick is always
    // correctable (re-tap a cover) right up until this is pressed.
    if (msgId === "__forward__") {
      await ctx.answerCbQuery("Forwarding…").catch(() => {});
      const { data: claimed } = await supabase
        .from("pending_brief_assignments")
        .update({ status: "forwarding" })
        .eq("id", sessionId).eq("status", "awaiting").select("id");
      if (claimed && claimed.length) {
        const { data: sess } = await supabase
          .from("pending_brief_assignments").select("*").eq("id", sessionId).single();
        runPhase3Forward(ctx, sess).catch((err) => console.error("[resolve] Phase 3 forward failed:", err.message));
      } else {
        console.log(`[resolve] forward already running/done for ${sessionId.slice(0, 8)} — ignoring re-tap`);
      }
      return;
    }

    const updated = await saveAssignment(sessionId, msgId, target);

    const pages = updated.pages || [];
    const badge = renderAssignmentBadge(target, pages);
    const chatId = ctx.callbackQuery.message.chat.id;
    const messageId = ctx.callbackQuery.message.message_id;
    const oldCaption = ctx.callbackQuery.message.caption || ctx.callbackQuery.message.text || "Cover";
    // Strip any prior badge so re-assigning the same cover doesn't stack them.
    const baseCaption = oldCaption.replace(/\n\n(?:→ |🔁|⏭️)[\s\S]*$/, "");
    // KEEP the keyboard attached so a misclick is fixable: re-tap a different
    // page and saveAssignment overwrites. Plain text (no parse_mode) — badges
    // contain @handles whose underscores break Markdown.
    const coverKb = buildCoverKeyboard(sessionId, msgId, pages);
    try {
      if (ctx.callbackQuery.message.caption !== undefined) {
        await ctx.telegram.editMessageCaption(chatId, messageId, undefined, `${baseCaption}\n\n${badge}`, { reply_markup: coverKb });
      } else {
        await ctx.telegram.editMessageText(chatId, messageId, undefined, `${baseCaption}\n\n${badge}`, { reply_markup: coverKb });
      }
    } catch (err) {
      console.warn(`[resolve] edit caption failed: ${err.message}`);
    }

    const totalCovers = (updated.unattributed || []).length;
    const assignedCount = Object.keys(updated.assignments || {}).length;
    const done = assignedCount >= totalCovers;
    const promptIds = updated.prompt_message_ids || [];
    if (promptIds.length > 0) {
      const { data: brief } = await supabase
        .from("ad_briefs").select("client").eq("id", updated.brief_id).single();
      // "Forward all" appears only once every cover is assigned. Forwarding is
      // explicit (no auto-fire), so misclicks stay correctable until pressed.
      const headerKb = done
        ? { inline_keyboard: [[{ text: `✅ Forward all ${totalCovers} → pages`, callback_data: `ca:${sessionId}:__forward__:go` }]] }
        : undefined;
      try {
        await ctx.telegram.editMessageText(chatId, promptIds[0], undefined,
          renderHeaderText(updated, brief, assignedCount),
          { parse_mode: "Markdown", reply_markup: headerKb }
        );
      } catch (_) {}
    }

    await ctx.answerCbQuery(done ? `✅ All ${totalCovers} assigned — tap Forward all` : `Saved (${assignedCount}/${totalCovers})`, { show_alert: false });
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

/**
 * Run a Telegram send, retrying on 429 (Too Many Requests) after the
 * server-specified retry_after. Without this, a multi-page brief's burst of
 * sends gets throttled partway and the remaining pages silently fail (Stake
 * Day 23 only reaching 4 of 12). Up to 3 attempts; non-429 errors rethrow.
 */
async function sendWithFloodRetry(fn, label = "") {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const ra = err?.response?.parameters?.retry_after ?? err?.parameters?.retry_after;
      if (ra != null && attempt < 3) {
        console.warn(`[resolve] 429 on ${label} — waiting ${ra}s (attempt ${attempt + 1})`);
        await sleep((Number(ra) + 1) * 1000);
        continue;
      }
      throw err;
    }
  }
}

async function sendByKind(telegram, chatId, kind, fileId) {
  if (kind === "video")     return telegram.sendVideo(chatId, fileId);
  if (kind === "audio")     return telegram.sendAudio(chatId, fileId);
  if (kind === "animation") return telegram.sendAnimation(chatId, fileId);
  if (kind === "document")  return telegram.sendDocument(chatId, fileId);
  return telegram.sendPhoto(chatId, fileId);
}

/**
 * Group-aware forward for multi-group briefs. Each assigned cover→page send
 * gives that page: the cover + its GROUP's slides + the group's caption + the
 * per-page brief. Group is read from cover.group (set at session build) →
 * session.blocks[group] holds that group's slideRefs + caption. Media is sent
 * by Bot-API file_id when present, else forwarded by source message id.
 * NO sheet writes. Records forwarded_message_ids per page.
 */
async function runGroupCoverForward(ctx, session, brief) {
  const pages = session.pages || [];
  const pageChats = await fetchPageChats(pages);
  const blocks = session.blocks || [];
  const assignments = session.assignments || {};
  const unattributed = session.unattributed || [];

  const { buildPerPageBriefText } = require("./adHandler");
  const { parseAdMessage } = require("../parser");
  const parsed = parseAdMessage(brief.raw_text || "", new Date());
  const plist = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
  const priceBy = new Map();
  for (const p of plist) if (p.pageHandle) priceBy.set(p.pageHandle.toLowerCase(), p.adPrice);

  const sendRef = async (chatId, ref) => {
    if (!ref) return null;
    if (ref.file_id) return sendByKind(ctx.telegram, chatId, ref.kind || "photo", ref.file_id);
    if (ref.msg_id != null) return ctx.telegram.forwardMessage(chatId, String(brief.telegram_chat_id), Number(ref.msg_id));
    return null;
  };

  let sent = 0, errCount = 0;
  const errors = [];
  for (const cover of unattributed) {
    const a = assignments[String(cover.msg_id)];
    if (a === undefined || a === "skip" || a === "shared") continue; // need a specific page
    const pageIdx = parseInt(a, 10);
    const handle = pages[pageIdx];
    const destChatId = handle && pageChats.get(handle);
    if (!destChatId) { errCount++; errors.push(`cover→${handle || a}: no chat`); continue; }
    const g = blocks[cover.group] || {};
    const ids = [];
    try {
      // 1. the picked cover
      const c = await sendRef(String(destChatId), cover);
      if (c?.message_id) ids.push(c.message_id);
      await sleep(80);
      // 2. that group's slides
      for (const sl of (g.slideRefs || [])) {
        const s = await sendRef(String(destChatId), sl);
        if (s?.message_id) ids.push(s.message_id);
        await sleep(80);
      }
      // 3. that group's caption
      if (g.caption && g.caption.trim()) {
        const s = await ctx.telegram.sendMessage(String(destChatId), g.caption);
        if (s?.message_id) ids.push(s.message_id);
        await sleep(80);
      }
      // 4. per-page brief (rewritten), id last
      const ppt = buildPerPageBriefText(brief.raw_text || "", handle, priceBy.get(handle));
      const s = ppt
        ? await ctx.telegram.sendMessage(String(destChatId), ppt)
        : await ctx.telegram.forwardMessage(String(destChatId), String(brief.telegram_chat_id), Number(brief.telegram_message_id));
      if (s?.message_id) ids.push(s.message_id);
      sent++;

      const pr = await supabase.from("ad_brief_pages")
        .select("id").eq("brief_id", brief.id).eq("page_handle", handle).maybeSingle();
      if (pr.data?.id) {
        await supabase.from("ad_brief_pages")
          .update({ forwarded_at: new Date().toISOString(), forwarded_message_ids: ids })
          .eq("id", pr.data.id);
      }
    } catch (e) {
      errCount++;
      errors.push(`@${handle}: ${e.message}`);
      console.error(`[resolve] group-cover forward @${handle}: ${e.message}`);
    }
  }

  await supabase.from("pending_brief_assignments").update({ status: "resolved" }).eq("id", session.id);

  const summary =
    `✅ *Multi-group forward complete*\n─────────────────────────\n` +
    `Pages forwarded: ${sent}\n` +
    (errCount > 0
      ? `Errors: ${errCount}\n${errors.slice(0, 5).map((e) => "  • " + md(e)).join("\n")}`
      : `_Each page got its group's cover + slides + caption. Sheets untouched._`);
  try {
    const chatId = ctx.callbackQuery?.message?.chat?.id || ctx.chat?.id;
    if (chatId) await ctx.telegram.sendMessage(chatId, summary, { parse_mode: "Markdown" });
  } catch (_) {}
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
  // Works whether invoked from a button tap (callbackQuery) or a command like
  // /replay (plain message) — summary/status messages go to whichever chat.
  const _summaryChat = ctx.callbackQuery?.message?.chat?.id || ctx.chat?.id;
  const brief = await fetchBriefById(session.brief_id);
  if (!brief) {
    await ctx.telegram.sendMessage(_summaryChat,
      "❌ Phase 3: couldn't fetch brief from DB — re-run /replay manually."
    ).catch(() => {});
    return;
  }
  // Multi-group: each assigned cover's page gets that cover's GROUP's slides
  // + caption (not one shared caption). Delegate to the group-aware forward.
  if (Array.isArray(session.blocks) && session.blocks.length) {
    return runGroupCoverForward(ctx, session, brief);
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

  // Track every message id Phase 3 sends to each page so it can be cleanly
  // deleted/re-run later (forwarded_message_ids was previously never recorded
  // by /resolve → no undo). Map<handle, number[]>.
  const sentIdsByHandle = new Map();
  const pushId = (handle, id) => {
    if (!id) return;
    if (!sentIdsByHandle.has(handle)) sentIdsByHandle.set(handle, []);
    sentIdsByHandle.get(handle).push(id);
  };

  // Send each cover to its target(s), then the brief to every page.
  // Small sleep between sends to dodge Telegram's per-chat flood limits.
  // Send a cover by file_id when present, else forward by message_id from the
  // source chat. Covers recovered via /catchup were re-injected from history
  // and carry NO bot file_id (only msg_id) — sending them by an undefined
  // file_id is what threw "there is no document in the request" for every page.
  const sendCover = async (chatId, cover) => {
    if (cover.file_id) return sendByKind(ctx.telegram, chatId, cover.kind || "photo", cover.file_id);
    if (cover.msg_id != null) return ctx.telegram.forwardMessage(String(chatId), String(brief.telegram_chat_id), Number(cover.msg_id));
    return null;
  };

  let sentCount = 0;
  let errCount  = 0;
  const errors  = [];
  for (const cover of unattributed) {
    const targets = targetsByMsgId.get(cover.msg_id) || [];
    for (const handle of targets) {
      const destChatId = pageChats.get(handle);
      try {
        const sent = await sendWithFloodRetry(() => sendCover(destChatId, cover), `cover→@${handle}`);
        pushId(handle, sent?.message_id);
        sentCount++;
        await sleep(150);
      } catch (err) {
        errCount++;
        errors.push(`@${handle}: ${err.message}`);
        console.error(`[resolve] Phase 3 send to @${handle}: ${err.message}`);
      }
    }
  }

  // Send caption text + per-page brief to every page that received covers.
  // Parse the brief once for per-page prices so the brief can be rewritten to
  // JUST this page's line (matching the normal forward path) instead of
  // native-forwarding the full multi-page brief ("Forwarded from Danny G" +
  // every page's PAGE INFO).
  const { buildPerPageBriefText } = require("./adHandler");
  const { parseAdMessage } = require("../parser");
  const parsedForPrices = parseAdMessage(brief.raw_text || "", new Date());
  const parsedList = Array.isArray(parsedForPrices) ? parsedForPrices : (parsedForPrices ? [parsedForPrices] : []);
  const priceByHandle = new Map();
  for (const p of parsedList) {
    if (p.pageHandle) priceByHandle.set(p.pageHandle.toLowerCase(), p.adPrice);
  }

  const destHandles = pages.filter((p) => pageChats.has(p));
  for (const handle of destHandles) {
    const destChatId = String(pageChats.get(handle));
    // 1. Caption text (if captured). Empty for briefs whose caption wasn't
    //    grabbed at processing time — nothing to send then.
    const _cap = (brief.shared_caption || "").trim();
    // Never send a bare @handle (or handle list) as the IG caption — that's a
    // page-attribution line that leaked into the caption slot, not real copy.
    const _isBareHandles = _cap.length > 0 && /^(@[\w.]+[\s,]*)+$/.test(_cap);
    if (_cap && !_isBareHandles) {
      try {
        const sent = await sendWithFloodRetry(() => ctx.telegram.sendMessage(destChatId, brief.shared_caption), `caption→@${handle}`);
        pushId(handle, sent?.message_id);
        await sleep(150);
      } catch (err) {
        console.error(`[resolve] Phase 3 caption send → @${handle}: ${err.message}`);
      }
    }
    // 2. Per-page brief — rewritten to just this page's row + price. Falls
    //    back to a native forward only if the rewrite can't isolate the page.
    //    Sent LAST so its id is last in forwarded_message_ids (updateHandler
    //    reads [length-1] as the brief id for /update edits).
    try {
      const perPageText = buildPerPageBriefText(
        brief.raw_text || "", handle, priceByHandle.get(handle.toLowerCase()),
      );
      const sent = await sendWithFloodRetry(() => (
        perPageText
          ? ctx.telegram.sendMessage(destChatId, perPageText)
          : ctx.telegram.forwardMessage(destChatId, String(brief.telegram_chat_id), Number(brief.telegram_message_id))
      ), `brief→@${handle}`);
      pushId(handle, sent?.message_id);
      await sleep(150);
    } catch (err) {
      console.error(`[resolve] Phase 3 brief send → @${handle}: ${err.message}`);
    }
  }

  // Persist the sent message ids per page so a later /replay (clean delete +
  // resend) or an undo can find exactly what Phase 3 posted.
  for (const [handle, ids] of sentIdsByHandle) {
    if (!ids.length) continue;
    const pageRow = await supabase
      .from("ad_brief_pages")
      .select("id")
      .eq("brief_id", brief.id)
      .eq("page_handle", handle)
      .maybeSingle();
    if (pageRow.data?.id) {
      await supabase.from("ad_brief_pages")
        .update({ forwarded_at: new Date().toISOString(), forwarded_message_ids: ids })
        .eq("id", pageRow.data.id)
        .then(({ error }) => { if (error) console.error(`[resolve] Phase 3 record ids @${handle}: ${error.message}`); });
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
    await ctx.telegram.sendMessage(_summaryChat, summaryText, { parse_mode: "Markdown" });
  } catch (err) {
    console.error(`[resolve] Phase 3 summary post: ${err.message}`);
  }
}

/**
 * /replay helper: re-fire the cover→page forward for a brief that already has
 * a (fully-) assigned cover-pick session — re-using the operator's existing
 * mapping and forwarding by message_id. Does NOT write sheets (Phase 3 never
 * does), so the existing correct sheet rows are untouched. Returns true if a
 * session existed and was re-forwarded; false if no session (so /replay falls
 * back to its normal buffer/DB forward).
 */
async function replayCoverForward(ctx, briefId) {
  if (!supabase || !briefId) return false;
  const { data: rows } = await supabase
    .from("pending_brief_assignments")
    .select("*")
    .eq("brief_id", briefId)
    .order("created_at", { ascending: false })
    .limit(1);
  const session = rows?.[0];
  if (!session) return false;
  const assignedCount = Object.keys(session.assignments || {}).length;
  if (assignedCount === 0) return false; // nothing mapped yet — let /resolve handle it
  console.log(`[resolve] /replay re-firing Phase 3 for brief ${String(briefId).slice(0,8)} (session ${session.id.slice(0,8)}, ${assignedCount} assigned)`);
  await runPhase3Forward(ctx, session);
  return true;
}

/**
 * Re-ping the team about cover-assignment sessions still stuck in "awaiting".
 * Called on a cron (index.js). Sends a gentle nudge to each session's
 * prompt_chat_id (or the fallback alert chat) — spaced ~GAP_MIN apart, capped
 * at MAX_REMINDERS so it's not spammy — until the session is resolved or
 * expires. This is the safety net so a paused ad never rots unseen.
 *
 * @param {object} telegram        bot.telegram
 * @param {string|number} fallbackChatId  where to ping if a session has no
 *                                        prompt_chat_id (the monetization chat)
 */
async function remindAwaitingSessions(telegram, fallbackChatId) {
  if (!supabase) return;
  const MAX_REMINDERS = 4;          // stop nagging after this many
  const GAP_MIN       = 30;         // minimum minutes between nudges
  const nowIso  = new Date().toISOString();
  const cutoff  = new Date(Date.now() - GAP_MIN * 60_000).toISOString();

  let sessions = [];
  try {
    const { data, error } = await supabase
      .from("pending_brief_assignments")
      .select("id, brief_id, prompt_chat_id, pages, unattributed, reminder_count, brief_text")
      .eq("status", "awaiting")
      .gt("expires_at", nowIso)
      .lt("reminder_count", MAX_REMINDERS)
      .or(`last_reminded_at.is.null,last_reminded_at.lt.${cutoff}`);
    if (error) { console.error(`[resolve] remind query: ${error.message}`); return; }
    sessions = data || [];
  } catch (err) {
    console.error(`[resolve] remind query threw: ${err.message}`);
    return;
  }

  for (const s of sessions) {
    const target = s.prompt_chat_id || fallbackChatId;
    if (!target) continue;
    // /resolve matches on the BRIEF id prefix (not the session id).
    const briefShort = (s.brief_id || "").slice(0, 8);
    const pagesCt  = Array.isArray(s.pages) ? s.pages.length : 0;
    const coversCt = Array.isArray(s.unattributed) ? s.unattributed.length : 0;
    const firstLine = (s.brief_text || "").split("\n")[0].slice(0, 60);
    const nth = (s.reminder_count || 0) + 1;
    try {
      await telegram.sendMessage(target,
        `⏰ *Reminder ${nth}/${MAX_REMINDERS} — ad still needs cover assignment*\n` +
        `\`${firstLine.replace(/[`*_\[]/g, (c) => "\\" + c)}\`\n` +
        `${pagesCt} pages · ${coversCt} unnamed cover(s) waiting — not sent yet.\n` +
        `Run \`/resolve ${briefShort}\` to assign covers → pages and send it out.`,
        { parse_mode: "Markdown" }
      );
      await supabase.from("pending_brief_assignments")
        .update({ reminder_count: nth, last_reminded_at: new Date().toISOString() })
        .eq("id", s.id);
      console.log(`[resolve] ⏰ reminder ${nth}/${MAX_REMINDERS} sent for brief ${briefShort} → ${target}`);
    } catch (err) {
      console.error(`[resolve] reminder send failed for ${briefShort}: ${err.message}`);
    }
  }
}

module.exports = {
  handleResolveCommand,
  handleAssignmentCallback,
  postAssignmentUI,
  remindAwaitingSessions,
  createGroupSessionAndPrompt,
  replayCoverForward,
  parseGroupMapping, // exported for tests
};
