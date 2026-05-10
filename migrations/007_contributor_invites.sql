-- ── Pending sales-contributor invites by @username ───────────────────────
-- Telegram bot API can't resolve @username → user_id without the user
-- having sent the bot a message first. This table holds grants in
-- waiting; when the named user DMs Greg, the matching row is
-- materialized into sales_contributors with their resolved telegram_id
-- and the invite is deleted (one-shot consumption).
--
-- username column is lowercased (no leading @). Re-running
-- /addcontributor for the same handle upserts the existing row, so
-- admins can extend allowed_pages on a pending invite without
-- creating duplicates.
--
-- Apply via Supabase SQL Editor or `supabase db push`. Idempotent.

CREATE TABLE IF NOT EXISTS sales_contributor_invites (
  username       TEXT PRIMARY KEY,
  display_name   TEXT,
  granted_by     BIGINT,
  granted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  allowed_pages  TEXT[],
  notes          TEXT
);

COMMENT ON TABLE sales_contributor_invites IS
  'Pending sales-contributor grants by @username. Auto-materializes when the user DMs Greg.';
