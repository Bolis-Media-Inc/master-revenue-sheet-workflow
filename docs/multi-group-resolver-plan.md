# Plan: Interactive Multi-Group Brief Resolver

**Status:** spec'd, not built. Build as a dedicated focused effort.
**Author context:** Connor, 2026-06 — triggered by the "Algo Agency Sesh"
brief that the bot flattened.

---

## The problem (the SESH brief)

A single brief covered ~12–13 pages split into **two creative groups**:

| | Group A ("7 pages") | Group B ("6 pages") |
|---|---|---|
| Covers | 7× "INTERNET REACTS TO DJ KHALED" (unnamed IMG_xxxx) | 6× "NICOTINE POUCH $40M" (unnamed) |
| Slides | Slides 2-6 (IMG_3835–3839) | Slide 2 (IMG_3857 jet ski) |
| Caption | "DJ Khaled's partnership with @sesh…" | "@sesh has raised over $40 million…" |

Chat structure used delimiter labels: `Covers for these 7 pages ^`,
`Slides 2-6 for these 7 pages ^`, `Caption for these 7 pages ^`, then the
same trio for the 6-page group, then the brief.

**What went wrong:** the bundle scanner **flattens** everything into ONE
bundle — one `shared_caption`, one `shared.media` set, per-page covers only.
So it:
- kept only one caption (and for SESH, captured none — empty),
- merged both slide-sets into one "shared" pile,
- had no concept of "these pages vs those pages",
- therefore had **nothing to ask the operator** — it just silently
  flattened and (separately) paused for cover assignment.

Connor's framing of the real gaps:
1. It didn't ask about **captions** (there were 2).
2. There's no way to do **shared slides for SOME pages but not all**.
3. It didn't preserve the brief's **group structure**.

The fix is NOT a stricter posting format, and NOT re-posting. It's: **the
team posts once in whatever shape, the bot reconstructs the groups from the
chat, and asks the operator for a quick mapping** — extending the existing
`/resolve` cover-assignment model to captions and slide-groups.

## Non-negotiable principles (from Connor)

1. **Never make the team re-send / re-post.** They post once, any combo. The
   bot adapts. Re-posting is banned — see #2.
2. **Sheet-safe.** Master + per-page rev rows are written ONCE at brief
   processing. `/resolve` + Phase-3 forward are PURE Telegram re-forwarding
   and must NEVER write sheets — so re-running resolve can't duplicate rows.
   (This is already true today; keep it true.)
3. **Works on the EXISTING brief.** Even when the original capture flattened
   the structure, the source messages are still in the chat. The resolver
   re-reads them (buffer, else live via sales_bolismedia) to rebuild groups —
   so an already-posted brief (like SESH) is resolvable in place, no repost.
4. **Minimize operator effort.** Pre-group as much as the labels allow ("these
   7 pages" → one group with 7 covers + its slides + its caption); only ask
   for the bits the bot genuinely can't infer (which specific pages → which
   group). Fast mapping, not data entry.

---

## Design overview

Four parts: **capture blocks → detect multi-group → interactive mapping →
per-group forward.**

### 1. Block-capture model (`messageBuffer.js`) — used at processing AND on /resolve

Stop flattening. Treat each `"… ^"` annotation as a **delimiter** that closes
a block. This same `getBlockStructure()` runs in two places:
- at brief processing, to detect multi-group + persist the structure; and
- **on `/resolve`, to RE-READ the source chat and rebuild groups** even if the
  original capture flattened them or the brief predates this feature. If the
  brief's messages have aged out of the in-memory buffer, fetch them live via
  `sales_bolismedia` (`userClient.getRecentMessages` around the brief) — the
  raw covers/captions/labels are still in Internal Network Ads.

Walking backward from the brief, emit an ordered list of blocks:

```js
// New scanner output for complex briefs:
{
  blocks: [
    { kind: "covers",  label: "Covers for these 7 pages ^",   media: [...7 msgs] },
    { kind: "slides",  label: "Slides 2-6 for these 7 pages ^", media: [...5 msgs] },
    { kind: "caption", label: "Caption for these 7 pages ^",   text: "DJ Khaled…" },
    { kind: "covers",  label: "Covers for these 6 pages ^",    media: [...6 msgs] },
    { kind: "slides",  label: "Slide 2 for these 6 pages ^",   media: [...1 msg] },
    { kind: "caption", label: "Caption for these 6 pages ^",   text: "@sesh raised…" },
  ],
  pages: [/* brief PAGE INFO handles + prices */],
}
```

- A block's **kind** is inferred from its label keyword: `cover(s)` →
  covers, `slide(s)` → slides, `caption` → caption. (Reuse a small keyword map.)
- A block's **content** is the media/text *between this label and the
  previous label* (going back).
- Caption blocks carry text (the message above the label); cover/slide blocks
  carry media message refs.
- Backward-compat: a brief with ZERO `"… ^"` delimiters, or one flat group,
  produces a single implicit block set = today's behavior. Only multi-block
  briefs take the new path.

**Keep the existing scanners** (`getFilenameBundlesByPage` etc.) for the
common single-group case. Add a new `getBlockStructure(chatId, adMsgId)` that
returns `{ blocks, pages }` when ≥2 delimiter groups are detected, else null.

### 2. Detection (`adHandler.js`)

After the existing format detection, call `getBlockStructure`. If it returns
≥2 caption blocks OR ≥2 slide blocks → this is a **multi-group brief**:
- Persist the block structure (see schema below).
- PAUSE forwarding (reuse the existing pause path).
- Fire the interactive mapping resolver (post to RESOLVE_ALERT_CHAT_ID /
  Monetization chat, same as the cover-assignment pause).

### 3. Interactive mapping (`resolveHandler.js`)

Extend the resolve session to map **groups**, not just covers. The operator
is asked, per page (or per page-batch), which group it belongs to. Once a page
is in a group, it inherits that group's caption + slides + (a) cover.

UX options (pick during build):
- **(a) Group-assignment buttons:** post each caption block + slide block as a
  labeled "Group A / Group B" choice, then list all brief pages with buttons
  [Group A] [Group B] [skip]. Cover-within-group assignment piggybacks (covers
  distributed one-per-page in assignment order, or a second tap).
- **(b) Paste-mapping:** operator replies with
  `A: @moist @hoodreels @howeverythingworks …` / `B: @dailyhumor_4u …`. Bot
  parses, confirms, forwards. Lower-effort UI, faster for the operator on
  large briefs.

Recommendation: build **(b) paste-mapping first** (fastest to ship + use on
big briefs), add **(a) buttons** later if needed.

Nothing forwards until every page is assigned to a group (or skipped).

### 4. Per-group forward (`resolveHandler.runPhase3Forward`)

For each page, look up its group → forward: its cover + that group's slides +
that group's caption (text) + the per-page brief (rewritten via
`buildPerPageBriefText`, already wired). Reuse the existing per-page rewrite
and clean-delete logic.

---

## DB schema (migration 019)

`pending_brief_assignments` gains:
- `blocks jsonb` — the captured block structure from §1.
- `group_assignments jsonb` — `{ "@moist": "A", "@hoodreels": "A", … }`.
- `kind text default 'covers'` — `'covers'` (today's flow) vs `'groups'` (new
  multi-group flow), so the callback/forward code branches correctly.

(Existing `unattributed` / `assignments` stay for the cover-only flow.)

---

## Files to modify

- `messageBuffer.js` — add `getBlockStructure()`; keyword→kind map; block
  delimiter walk. Largest piece.
- `handlers/adHandler.js` — detect multi-group, persist blocks, route to the
  group resolver instead of (or alongside) the cover resolver.
- `handlers/resolveHandler.js` — group-mapping prompt + parse + per-group
  Phase 3 forward.
- `migrations/019_*.sql` — schema above.
- `scripts/test-block-structure.js` — synthetic SESH-shaped brief: assert
  2 caption blocks, 2 slide blocks, 2 cover sets, correct media per block.
- `scripts/test-group-forward.js` — assert each page gets its group's
  caption + slides + cover.

---

## Edge cases

- **Single-group / no delimiters** → unchanged (today's flow). The new path
  only triggers on ≥2 caption or slide groups.
- **Counts don't add up** (SESH: 7+6=13 labels but 12 PAGE INFO rows) → the
  mapping UI is the safety valve: operator assigns whatever pages exist; the
  bot never guesses.
- **Covers unnamed within a group** → distribute one-per-page in assignment
  order (they're usually interchangeable color variants). If a page needs a
  specific cover, operator can still `@page.jpg`-name it.
- **A page assigned to no group** → not forwarded; surfaced in the summary.
- **Captions starting with `@brand`** → already handled (standard-caption fix
  from 2026-06-10 walks back past annotations).

---

## Recovering the SESH brief (and any already-posted multi-group brief)

NO repost (sheets already written). Once the smarter resolver ships, run
`/resolve 4a77e6a3` on the existing brief:
1. It re-reads the source messages (buffer or live) → rebuilds the 2 caption
   blocks, 2 slide blocks, 2 cover sets.
2. Asks you to map the 12–13 pages to Group A / Group B (paste-mapping).
3. Re-forwards each page's correct cover + group slides + group caption +
   per-page brief — Telegram only, NO sheet writes.

The manual chat-cleanup of the bad earlier forward (covers + flattened brief)
still applies once — after that, the in-place resolve produces the right
content. Going forward `/resolve` records its sends (commit 99030f0) so even
that cleanup becomes a clean `/replay`.

## Out of scope (for v1)

- Auto-guessing group membership from PAGE INFO order — too fragile; always ask.
- Per-page *unique* captions (only per-group). Rare; revisit if needed.

---

## Interim already shipped (2026-06-10)

- Paused briefs now alert the Monetization chat + reminder loop (won't go
  silent).
- `/resolve` Phase 3 uses per-page brief rewrite + sends the (single) caption.
- `getStandardBundle` captures the caption past intervening annotations.

These make the single-group flow correct; this plan adds the multi-group case.
