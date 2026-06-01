-- 016_pending_briefs.sql
--
-- Defer direct-posted briefs by 2 minutes so post-publish edits land
-- before the bot forwards + writes sheets + persists. Catches the
-- "Stake Day 5 → edit to Day 7" pattern that broke our books.
--
-- Lifecycle:
--   pending     → just landed, scheduled_for is +2min from receipt
--   processing  → cron picked it up, calling handleAdMessage
--   processed   → handleAdMessage completed (or determined not-a-brief)
--   failed      → handleAdMessage threw; attempts++ on next retry
--
-- Primary key is (chat_id, message_id) — natural unique. Duplicate
-- inserts are ON CONFLICT no-op (in code), since Telegram sometimes
-- redelivers a webhook before the bot ACKs.

CREATE TABLE IF NOT EXISTS pending_briefs (
  chat_id        bigint      NOT NULL,
  message_id     bigint      NOT NULL,
  scheduled_for  timestamptz NOT NULL,
  status         text        NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','processing','processed','failed')),
  attempts       integer     NOT NULL DEFAULT 0,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_pending_briefs_due
  ON pending_briefs (scheduled_for)
  WHERE status = 'pending';

CREATE OR REPLACE FUNCTION _pb_touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pb_touch_updated_at ON pending_briefs;
CREATE TRIGGER pb_touch_updated_at
  BEFORE UPDATE ON pending_briefs
  FOR EACH ROW EXECUTE FUNCTION _pb_touch_updated_at();
