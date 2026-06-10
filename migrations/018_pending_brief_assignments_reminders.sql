-- 018_pending_brief_assignments_reminders.sql
--
-- Reminder tracking for paused (awaiting) cover-assignment sessions.
--
-- Why: a paused ad waits for someone to run /resolve. The initial prompt can
-- be missed, so a cron re-pings the Monetization Team + AI chat until the
-- session is resolved/expired. These columns let it space reminders out and
-- cap how many it sends (gentle, not spammy).
--
--   reminder_count    — how many nudges sent so far (cap, then back off)
--   last_reminded_at  — when the last nudge went out (space them ~30 min)

ALTER TABLE pending_brief_assignments
  ADD COLUMN IF NOT EXISTS reminder_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reminded_at timestamptz;
