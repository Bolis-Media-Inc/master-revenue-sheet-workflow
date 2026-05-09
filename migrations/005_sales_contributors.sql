-- ── Sales contributors ────────────────────────────────────────────────────
-- External contributors who run /ad in Greg DM. Their submissions queue
-- in SALES_TEAM_CHAT_ID for sales-team review by tapping Approve in the
-- review card — instead of firing direct to Internal Network Ads.
--
-- Listed by Telegram user_id (the same id Greg sees on incoming /ad
-- messages). Granted via /addcontributor (reply-based) by sales admin.
--
-- Apply via Supabase SQL Editor or `supabase db push`. Idempotent.

CREATE TABLE IF NOT EXISTS sales_contributors (
  telegram_id    BIGINT PRIMARY KEY,
  display_name   TEXT,
  granted_by     BIGINT,
  granted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_active      BOOLEAN NOT NULL DEFAULT true,
  notes          TEXT
);

CREATE INDEX IF NOT EXISTS sales_contributors_active_idx
  ON sales_contributors(is_active) WHERE is_active = true;
