-- ── Sales-contributor review flow ─────────────────────────────────────────
-- Adds an intermediate 'pending_review' status to ad_sessions for
-- contributors (team_roles includes 'sales_contributor' but not 'sales').
-- Their submissions land in the Sales Team chat as a review card and only
-- promote to 'pending' (the regular cancel-window state) once a sales user
-- taps Approve.
--
-- review_msg JSONB stores {chatId, messageId} of the team-chat card so we
-- can edit it on approve/reject. Kept separate from approval_msg (which
-- still holds the cancel-window admin notification once promoted) so we
-- don't lose the team-chat audit trail when the cancel-window message
-- overwrites it.
--
-- No CHECK constraint on status — the set of valid values is enforced in
-- application code (lib/sessions.js + lib/poster.js):
--   pending_review → pending → sent
--   pending_review → cancelled
--   pending → sent | cancelled | expired
--
-- Apply via Supabase SQL Editor or `supabase db push`. Idempotent.

ALTER TABLE ad_sessions
  ADD COLUMN IF NOT EXISTS review_msg JSONB;

CREATE INDEX IF NOT EXISTS ad_sessions_pending_review_idx
  ON ad_sessions(status)
  WHERE status = 'pending_review';
