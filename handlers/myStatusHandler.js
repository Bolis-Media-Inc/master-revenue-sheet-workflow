/**
 * myStatusHandler.js — /mystatus command for sales contributors
 *
 * Lets contributors check the state of their own /ad submissions
 * without needing admin access to Supabase or the sheet.
 *
 * Modes:
 *   /mystatus               — list the user's 10 most recent submissions
 *                             with status badges + 1-line summary each
 *   /mystatus <id_prefix>   — full health card for one submission
 *                             (8-char prefix is enough, like git short hash)
 *
 * Access: DM-only + must be an active sales contributor. Each user only
 * ever sees their own submissions (enforced by user_id filter in SQL).
 *
 * Status interpretation:
 *   pending_review → ⏳ Awaiting review
 *   approved       → ✅ Approved (rare intermediate state)
 *   sent           → ✅ Posted, with health check
 *   rejected       → ❌ Rejected
 *
 * For "sent" submissions, attempts to link the session to its ad_briefs
 * row by temporal-join (client name + ±2 min window vs session updated_at).
 * If found, shows whether the sheet rows + per-page forward actually
 * landed. If not found, status reads "Posted" without recording detail.
 */

const { _supabase: supabase } = require("../lib/sessions");
const { isContributor }       = require("../lib/contributors");

// Admin bypass — Connor (WIZARD_ADMIN_USER_ID) can /mystatus too even if
// he's not in the contributors table. Same env-var check wizard.js uses.
function isSalesAdmin(telegramId) {
  const adminId = parseInt(process.env.WIZARD_ADMIN_USER_ID || "0", 10);
  return adminId && Number(telegramId) === adminId;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const AZ_TZ      = "America/Phoenix";
const LIST_LIMIT = 10;

// ── Formatting helpers ────────────────────────────────────────────────────────

function fmtAzDate(iso, opts = {}) {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d)) return "?";
  return d.toLocaleString("en-US", {
    timeZone: AZ_TZ,
    month:    "numeric",
    day:      "numeric",
    hour:     "numeric",
    minute:   "2-digit",
    hour12:   true,
    ...opts,
  });
}

function statusBadge(status) {
  if (status === "pending_review") return "⏳";
  if (status === "approved")       return "✅";
  if (status === "sent")           return "✅";
  if (status === "rejected")       return "❌";
  return "•";
}

function statusLabel(status) {
  if (status === "pending_review") return "Pending review";
  if (status === "approved")       return "Approved";
  if (status === "sent")           return "Posted";
  if (status === "rejected")       return "Rejected";
  return status;
}

// Markdown escape — wizard sessions can include user-input campaign names
// with underscores/asterisks that would break Telegram Markdown parsing.
function md(text) {
  if (text == null) return "";
  return String(text).replace(/[_*`\[\]]/g, (c) => "\\" + c);
}

// Format pages array → "@a, @b" with up to 3 visible
function fmtPages(pages) {
  if (!Array.isArray(pages) || pages.length === 0) return "—";
  const visible = pages.slice(0, 3).map((p) => `@${p}`).join(", ");
  return pages.length > 3 ? `${visible} +${pages.length - 3}` : visible;
}

// ── Query ─────────────────────────────────────────────────────────────────────

// Pull the user's recent submissions with parsed answer fields
async function querySessions(userId, limit) {
  const { data, error } = await supabase
    .from("ad_sessions")
    .select("id, status, created_at, updated_at, payload")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`ad_sessions: ${error.message}`);
  return (data || []).map(extractFields);
}

async function querySessionByPrefix(userId, prefix) {
  // UUID prefix match — use ILIKE since uuid::text comparison needs cast
  const { data, error } = await supabase
    .from("ad_sessions")
    .select("id, status, created_at, updated_at, payload")
    .eq("user_id", userId)
    .ilike("id::text", `${prefix}%`)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) {
    // Some Supabase clients reject the ::text cast in ilike — fall back to
    // fetching by user + filtering client-side. Slightly slower but works.
    const all = await querySessions(userId, 100);
    const match = all.find((s) => s.id.startsWith(prefix.toLowerCase()));
    return match || null;
  }
  return data?.[0] ? extractFields(data[0]) : null;
}

// Pull the matching ad_briefs row (+ ad_brief_pages) for a sent session.
// Link strategy: client name + temporal proximity to session.updated_at.
// Posts via sales_bolismedia arrive at bm_tracking_bot within ~1 sec of
// the session being marked 'sent', so a ±5 min window is plenty.
async function queryBriefHealth(session) {
  if (session.status !== "sent") return null;
  if (!session.client) return null;

  const t = new Date(session.updated_at);
  const lo = new Date(t.getTime() -  2 * 60 * 1000).toISOString();
  const hi = new Date(t.getTime() + 10 * 60 * 1000).toISOString(); // brief receive can lag a bit

  // adBriefs is a separate module — talk to it directly via supabase. Don't
  // worry about cross-contributor leakage: we're filtering on client +
  // narrow time window, which uniquely identifies this user's brief in
  // practice. Worst case a sibling brief is shown; still no PII leak (the
  // session payload is already gated by user_id).
  const { data, error } = await supabase
    .from("ad_briefs")
    .select("id, client, total_price, received_at, telegram_chat_id, telegram_message_id, bundle_format")
    .eq("client", session.client)
    .gte("received_at", lo)
    .lte("received_at", hi)
    .order("received_at", { ascending: true })
    .limit(1);
  if (error || !data?.[0]) return null;

  const brief = data[0];
  const { data: pages } = await supabase
    .from("ad_brief_pages")
    .select("page_handle, master_sheet_row, page_sheet_row, forwarded_at, forward_error, posted_at, forwarded_message_ids")
    .eq("brief_id", brief.id);

  return { brief, pages: pages || [] };
}

// Extract the fields we care about from the session payload JSONB
function extractFields(row) {
  const answers = row.payload?.wizard?.answers || {};
  const content = row.payload?.wizard?.content || {};

  let mediaCount = 0;
  if (answers.format === "Standard") {
    mediaCount = Array.isArray(content.shared) ? content.shared.length : 0;
  } else if (answers.format === "Per-creative") {
    mediaCount = Object.values(content.byHandle || {})
      .reduce((s, arr) => s + (Array.isArray(arr) ? arr.length : 0), 0);
  } else if (answers.format === "Collab") {
    mediaCount = (content.collabGroups || [])
      .reduce((s, g) => s + (Array.isArray(g?.media) ? g.media.length : 0), 0);
  }

  return {
    id:         row.id,
    status:     row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    client:     answers.client     || null,
    adType:     answers.adType     || null,
    price:      answers.price      || null,
    format:     answers.format     || null,
    timeAz:     answers.time       || null,
    duration:   answers.duration   || null,
    pages:      Array.isArray(answers.pages) ? answers.pages : [],
    caption:    answers.caption    || null,
    mediaCount,
  };
}

// ── Renderers ─────────────────────────────────────────────────────────────────

function renderList(sessions) {
  if (sessions.length === 0) {
    return "📭 You haven't submitted any ads yet. Run `/ad` to submit your first.";
  }

  const lines = [`📋 *Your last ${sessions.length} submission${sessions.length === 1 ? "" : "s"}*`, ""];

  for (const s of sessions) {
    const idShort = s.id.slice(0, 8);
    const badge   = statusBadge(s.status);
    const date    = fmtAzDate(s.created_at);
    const title   = [s.client, s.adType, s.price ? `$${s.price}` : null]
      .filter(Boolean).join(" — ");
    const pages   = fmtPages(s.pages);
    const fmt     = s.format ? `${s.format} · ${s.mediaCount} ${s.mediaCount === 1 ? "media" : "media"}` : "";
    const status  = statusLabel(s.status);

    lines.push(`${badge} \`#${idShort}\` · ${date} AZ`);
    if (title)  lines.push(`   ${md(title)}`);
    lines.push(`   ${md(pages)}${fmt ? " · " + md(fmt) : ""}`);
    lines.push(`   _${md(status)}_`);
    lines.push("");
  }

  lines.push("`/mystatus <id>` for full detail on one submission");
  return lines.join("\n");
}

function renderDetail(s, health) {
  const idShort = s.id.slice(0, 8);
  const lines = [
    `📋 *Submission* \`#${idShort}\``,
    "──────────────────────────",
    `*Campaign:*  ${md([s.client, s.adType].filter(Boolean).join(" — ")) || "—"}`,
    `*Pages:*     ${md(fmtPages(s.pages))}${s.price ? ` (\$${s.price})` : ""}`,
    `*Format:*    ${md(s.format || "—")} · ${s.mediaCount} ${s.mediaCount === 1 ? "media" : "media"}`,
    `*Schedule:*  ${md(s.timeAz || "—")} · ${md(s.duration || "—")}`,
    "",
    `*Status:*    ${statusBadge(s.status)} ${statusLabel(s.status)}`,
    `*Submitted:* ${fmtAzDate(s.created_at)} AZ`,
    `*Last upd:*  ${fmtAzDate(s.updated_at)} AZ`,
  ];

  // Caption preview (truncated)
  if (s.caption) {
    const preview = s.caption.length > 120 ? s.caption.slice(0, 120) + "…" : s.caption;
    lines.push("");
    lines.push(`*Caption:*   _${md(preview)}_`);
  }

  // For sent submissions, append recording health
  if (s.status === "sent") {
    lines.push("");
    if (!health) {
      lines.push(
        "_Posted to Internal Network Ads — couldn't auto-link to brief row " +
        "for recording check. Ping Connor if you suspect something's off._",
      );
    } else {
      const { brief, pages } = health;
      const totalPages = pages.length;
      const masterOk   = pages.filter((p) => p.master_sheet_row).length;
      const pageOk     = pages.filter((p) => p.page_sheet_row).length;
      const fwdOk      = pages.filter((p) => p.forwarded_at && !p.forward_error).length;
      const postedOk   = pages.filter((p) => p.posted_at).length;

      lines.push("*Recording check:*");
      lines.push(`  Master sheet:  ${masterOk}/${totalPages} ${masterOk === totalPages ? "✓" : "⚠️"}`);
      lines.push(`  Per-page:      ${pageOk}/${totalPages} ${pageOk === totalPages ? "✓" : pageOk === 0 ? "—" : "⚠️"}`);
      lines.push(`  Forwarded:     ${fwdOk}/${totalPages} ${fwdOk === totalPages ? "✓" : "⚠️"}`);
      lines.push(`  Live detected: ${postedOk}/${totalPages} ${postedOk === totalPages ? "✓" : postedOk === 0 ? "—" : "⚠️"}`);
      if (brief.bundle_format) {
        lines.push(`  Bundle format: \`${brief.bundle_format}\``);
      }

      // Surface any per-page forward errors directly
      const errors = pages.filter((p) => p.forward_error).map((p) => `@${p.page_handle}: ${p.forward_error}`);
      if (errors.length) {
        lines.push("");
        lines.push("*Forward errors:*");
        for (const e of errors) lines.push(`  • ${md(e)}`);
      }
    }
  }

  return lines.join("\n");
}

// ── Main handler ──────────────────────────────────────────────────────────────

async function handleMyStatus(ctx) {
  try {
    // DM-only — sales agents check their submissions privately in Greg's DM
    if (ctx.chat?.type !== "private") return;

    const userId = ctx.from?.id;
    if (!userId) return;

    // Only sales contributors (or the admin) can use this. Non-contributors
    // silently get nothing — same posture as other Greg DM commands.
    const allowed = isSalesAdmin(userId) || (await isContributor(userId));
    if (!allowed) return;

    const args   = (ctx.message?.text || "").trim().split(/\s+/).slice(1);
    const arg    = args[0]?.replace(/^#/, "").toLowerCase();

    if (arg) {
      // Detail mode — fetch one submission by id prefix
      const session = await querySessionByPrefix(userId, arg);
      if (!session) {
        return ctx.reply(
          `❌ No submission found starting with \`${md(arg)}\` in your history.\n\n` +
          "Run `/mystatus` to see all your recent submissions.",
          { parse_mode: "Markdown" },
        );
      }
      const health = await queryBriefHealth(session);
      return ctx.reply(renderDetail(session, health), { parse_mode: "Markdown" });
    }

    // List mode — last N submissions
    const sessions = await querySessions(userId, LIST_LIMIT);
    return ctx.reply(renderList(sessions), { parse_mode: "Markdown" });
  } catch (err) {
    console.error("[myStatusHandler] error:", err.message);
    try {
      await ctx.reply(`❌ Couldn't fetch your submissions: ${err.message}`);
    } catch (_) { /* nothing to do */ }
  }
}

module.exports = { handleMyStatus };
