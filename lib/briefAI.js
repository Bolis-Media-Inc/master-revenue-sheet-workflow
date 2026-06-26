// lib/briefAI.js — LLM "Brief-AI" shadow layer.
//
// WHY THIS EXISTS
// ---------------
// Caption / creative attribution has historically been driven by a growing pile
// of regex heuristics (bare-handle detection, "posted on" lists, ^-labels,
// @page.jpg scanners, walk-back rules…). Every new brief shape that doesn't fit
// breaks one of them and silently drops a caption or mis-counts creatives. It's
// whack-a-mole.
//
// This module runs Claude over the WHOLE brief block in parallel with the live
// heuristics and SEMANTICALLY classifies what each part is: marketing caption vs
// operator instructions vs destination/page list vs audio reference vs the
// creative media themselves. It then compares its read against whatever the
// heuristics decided and, when they DISAGREE, posts a compact flag to the
// Monetization chat.
//
// SAFETY: This is SHADOW ONLY. It never touches forwarding, sheets, or the DB.
//   - Gated behind BRIEF_AI_SHADOW=true (off → hard no-op, zero API calls).
//   - No-op if ANTHROPIC_API_KEY is unset.
//   - Every entry point is wrapped so a failure can never bubble into the live
//     forward path. shadowCompare is meant to be called fire-and-forget.
//
// Once we trust the agreement rate we flip it to primary (with the heuristics as
// fallback). Until then it just watches and tells us where the heuristics are
// wrong.

const Anthropic = require("@anthropic-ai/sdk");

const SHADOW_ENABLED = (process.env.BRIEF_AI_SHADOW || "").toLowerCase() === "true";
const MODEL          = process.env.BRIEF_AI_MODEL || "claude-sonnet-4-6";
// SHADOW IS SILENT BY DEFAULT. Every comparison is logged to the DB and reviewed
// later via /briefai — it does NOT post to the Monetization chat. The only things
// that should interrupt that chat are genuine blocking questions (the cover→page
// picker that freezes forwarding), which live in adHandler, not here. Set
// BRIEF_AI_FLAG_ALL=true only if you want live disagreement pings while evaluating.
const FLAG_ALL       = (process.env.BRIEF_AI_FLAG_ALL || "").toLowerCase() === "true";

let _client = null;
function client() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

const SYSTEM = `You classify Telegram advertising briefs for a social-media agency.

An operator pastes a "brief block": a sequence of messages — some are media
(photos/videos = the ad creatives), some are text. Your job is to read the WHOLE
block the way a human operator would and decide what each part actually IS, so a
bot can forward the right creatives with the right caption to the right pages.

The brief block is given as an ordered list of messages. The LAST one (marked
BRIEF) is the actual ad-order text that names the pages and the price. Earlier
messages are the surrounding context (creatives + notes).

You must distinguish, semantically (NOT by keyword matching):

- CAPTION: the marketing copy meant to be POSTED publicly alongside the ad on the
  page (the Instagram/TikTok caption). This is what the audience reads. It is NOT
  the brief order text, NOT a list of page handles, NOT operator instructions.
  A caption can be empty/absent — many ads post with no caption. If there is no
  real public-facing caption, return null. Do NOT invent one.

- CREATIVES: the actual media to forward (cover images + slides + videos). Count
  the DISTINCT creative media items. A bare "@handle" that is just a filename or
  a label is NOT a creative.

- INSTRUCTIONS: operator-facing directions ("post on story too", "use this
  sound", "tag the brand", "go live at 5pm"). Internal, NOT posted as caption.

- AUDIO/SOUND REFERENCE: a named song/sound to attach. Internal.

- PAGE LIST / DESTINATIONS: the @handles the ad targets. These are routing info,
  NEVER a caption — even when they appear as a tidy list under "posted on:".

- NOISE: leftover text from a PREVIOUS brief, bare handle lists, separators.

Output RAW JSON only (no markdown, no code fences) with this exact shape:
{
  "caption": string | null,        // the public-facing caption to post, or null
  "creativeCount": number,         // distinct creative media items to forward
  "instructions": string | null,   // operator instructions, joined; null if none
  "audioRef": string | null,       // named sound/song, or null
  "pages": string[],               // @handles the ad targets (lowercase, with @)
  "perPage": object | null,        // { "@handle": "caption" } ONLY if pages get
                                   //   DIFFERENT captions; else null
  "confidence": number,            // 0..1, your confidence in this read
  "reason": string                 // one short sentence explaining the caption call
}`;

// Render the {block, brief} structure from messageBuffer.getBriefBlockForAI into
// a compact, readable transcript for the model.
function renderBlock(serialized) {
  if (!serialized) return null;
  const lines = [];
  const one = (m, isBrief) => {
    const tag = isBrief ? "BRIEF" : (m.kind || "text");
    const file = m.file_name ? ` file=${m.file_name}` : "";
    let body = "";
    if (m.caption) body = ` caption=${JSON.stringify(m.caption)}`;
    else if (m.text) body = ` ${JSON.stringify(m.text)}`;
    lines.push(`[#${m.message_id} ${tag}${file}]${body}`);
  };
  for (const m of (serialized.block || [])) one(m, false);
  if (serialized.brief) one(serialized.brief, true);
  return lines.join("\n");
}

// Run Claude over a serialized brief block. Returns the parsed classification
// object, or null on any failure (never throws).
async function classifyBriefBlock(serialized) {
  const ai = client();
  if (!ai) return null;
  const rendered = renderBlock(serialized);
  if (!rendered) return null;
  try {
    const msg = await ai.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM,
      messages: [{ role: "user", content: rendered }],
    });
    let raw = msg.content[0]?.text?.trim() || "{}";
    raw = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/g, "").trim();
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
    return null;
  } catch (e) {
    console.error("[briefAI] classify error:", e.message);
    return null;
  }
}

// Normalize a caption for comparison: collapse whitespace, lowercase, trim.
function _norm(s) {
  return (s || "").replace(/\s+/g, " ").trim().toLowerCase();
}

// How similar are two captions? Token Jaccard — cheap and good enough to tell
// "same caption, minor edit" from "completely different text".
function _similar(a, b) {
  const ta = new Set(_norm(a).split(" ").filter(Boolean));
  const tb = new Set(_norm(b).split(" ").filter(Boolean));
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

// Compare the AI's read against the heuristic result and return a list of
// human-readable disagreement strings (empty = agreement).
function diffReads(ai, heuristic) {
  const out = [];
  const hCap = heuristic.caption || null;
  const aCap = ai.caption || null;

  if (!hCap && aCap) {
    out.push(`🟥 CAPTION DROPPED — heuristics sent no caption, AI found one:\n   “${aCap.slice(0, 280)}”`);
  } else if (hCap && !aCap) {
    out.push(`🟧 CAPTION SUSPECT — heuristics are posting text the AI thinks is NOT a caption:\n   “${hCap.slice(0, 280)}”`);
  } else if (hCap && aCap && _similar(hCap, aCap) < 0.6) {
    out.push(`🟨 CAPTION MISMATCH — heuristics vs AI differ:\n   heuristic: “${hCap.slice(0, 200)}”\n   AI:        “${aCap.slice(0, 200)}”`);
  }

  if (typeof ai.creativeCount === "number" && typeof heuristic.creativeCount === "number") {
    const d = Math.abs(ai.creativeCount - heuristic.creativeCount);
    if (d >= 1) {
      out.push(`🟦 CREATIVE COUNT — heuristics=${heuristic.creativeCount}, AI=${ai.creativeCount}`);
    }
  }
  return out;
}

// Persist one comparison to brief_ai_shadow_log (never throws).
async function _logComparison(info, ai, diffs) {
  try {
    const supabase = require("./adBriefs")._supabase;
    if (!supabase) return;
    const h = info.heuristic || {};
    await supabase.from("brief_ai_shadow_log").insert({
      chat_id:          info.chatId != null ? Number(info.chatId) : null,
      brief_message_id: info.briefMessageId != null ? Number(info.briefMessageId) : null,
      client:           h.client || (info.label || "").split(" · ")[0] || null,
      detected_format:  h.format || null,
      page_count:       Array.isArray(h.pages) ? h.pages.length : null,
      agreed:           diffs.length === 0,
      diffs,
      heuristic:        h,
      ai,
      block:            info.serialized,
      model:            MODEL,
    });
  } catch (e) {
    console.error("[briefAI] log insert error (non-fatal):", e.message);
  }
}

// Fire-and-forget shadow comparison. Safe to call on every live forward.
//   telegram   — ctx.telegram (Telegraf) for posting the flag
//   alertChatId— the Monetization chat id (RESOLVE_ALERT_CHAT_ID)
//   info       — { serialized, heuristic:{caption, creativeCount, format, pages, client},
//                  label, chatId, briefMessageId }
//
// EVERY comparison (agree or disagree) is logged to brief_ai_shadow_log for the
// few-days review. Telegram pings are limited to the money-losing cases unless
// BRIEF_AI_FLAG_ALL=true.
async function shadowCompare(telegram, alertChatId, info) {
  if (!SHADOW_ENABLED) return;
  try {
    if (!info || !info.serialized) return;
    const ai = await classifyBriefBlock(info.serialized);
    if (!ai) return;

    const heuristic = info.heuristic || {};
    const diffs = diffReads(ai, heuristic);

    // Always record — agreements are the denominator of the agreement rate.
    await _logComparison(info, ai, diffs);

    if (diffs.length === 0) {
      console.log(`[briefAI] shadow OK — agrees with heuristics${info.label ? ` (${info.label})` : ""}`);
      return;
    }
    console.warn(`[briefAI] shadow FLAG (${diffs.length})${info.label ? ` ${info.label}` : ""}`);

    // Silent by default — the disagreement is stored, not broadcast. Reviewed
    // later via /briefai. Only ping the chat if explicitly opted in.
    if (!FLAG_ALL || !telegram || !alertChatId) return;

    const conf = typeof ai.confidence === "number" ? ` · AI conf ${(ai.confidence * 100).toFixed(0)}%` : "";
    const head = `🔎 *Brief-AI shadow flag*${info.label ? ` — ${info.label}` : ""}${conf}`;
    const reason = ai.reason ? `\n_AI read:_ ${ai.reason}` : "";
    const body = diffs.join("\n\n");
    const foot = `\n\n_Shadow only — the bot forwarded normally. Verify if a caption looks wrong._`;

    await telegram.sendMessage(String(alertChatId), `${head}\n\n${body}${reason}${foot}`, {
      parse_mode: "Markdown",
    }).catch(async () => {
      // Markdown can choke on caption punctuation — retry as plain text.
      await telegram.sendMessage(String(alertChatId),
        `Brief-AI shadow flag${info.label ? ` — ${info.label}` : ""}\n\n${body}`,
      ).catch(() => {});
    });
  } catch (e) {
    console.error("[briefAI] shadowCompare error (non-fatal):", e.message);
  }
}

// Summarize the shadow log for review. Returns { total, agreed, disagreed,
// agreementRate, byKind:{}, recent:[...] } over the last `days`.
async function summarize(days = 7, limit = 25) {
  const supabase = require("./adBriefs")._supabase;
  if (!supabase) return null;
  const sinceMs = Date.now() - days * 86400000;
  const since = new Date(sinceMs).toISOString();
  const { data, error } = await supabase
    .from("brief_ai_shadow_log")
    .select("created_at, client, detected_format, agreed, diffs, heuristic, ai")
    .gte("created_at", since)
    .order("created_at", { ascending: false });
  if (error) { console.error("[briefAI] summarize error:", error.message); return null; }
  const rows = data || [];
  const total = rows.length;
  const agreed = rows.filter((r) => r.agreed).length;
  const disagreed = total - agreed;
  const byKind = { dropped: 0, suspect: 0, mismatch: 0, count: 0 };
  for (const r of rows) {
    for (const d of (r.diffs || [])) {
      if (d.startsWith("🟥")) byKind.dropped++;
      else if (d.startsWith("🟧")) byKind.suspect++;
      else if (d.startsWith("🟨")) byKind.mismatch++;
      else if (d.startsWith("🟦")) byKind.count++;
    }
  }
  const recent = rows.filter((r) => !r.agreed).slice(0, limit);
  return {
    days,
    total,
    agreed,
    disagreed,
    agreementRate: total ? agreed / total : null,
    byKind,
    recent,
  };
}

module.exports = {
  SHADOW_ENABLED,
  classifyBriefBlock,
  shadowCompare,
  summarize,
  // exported for tests
  renderBlock,
  diffReads,
};
