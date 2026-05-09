-- ── Internal-brief message reference for Posted-on mirroring ──────────────
-- When Greg posts an ad to Internal Network Ads (via /api/ad/intake), it
-- now stashes the resulting message_id on the session. Later, when a
-- contributor confirms in their Greg DM with a "Posted on @page" message,
-- Greg mirrors the confirmation back to Internal Network Ads as a reply
-- to that exact brief — keeping the audit trail visually consistent with
-- humanly-typed confirmations.
--
-- internal_brief shape: { chatId: number|string, messageId: number }
-- Older sessions without this field fall back to a non-reply send.
--
-- Apply via Supabase SQL Editor or `supabase db push`. Idempotent.

ALTER TABLE ad_sessions
  ADD COLUMN IF NOT EXISTS internal_brief JSONB;
