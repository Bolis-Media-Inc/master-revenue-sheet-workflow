-- ── Posters: people responsible for posting ads to Instagram ────────────
-- Distinct from sales_contributors (who SUBMIT ads). The same person
-- can be registered as both. Posters surface in the /ad wizard's
-- "Who's responsible for posting?" step, alongside hardcoded
-- ALL_SENIORS, so VAs / contributors can be picked there as the
-- person tagged on the brief.
--
-- pages array = lowercased page handles (no @) the poster is scoped
-- to. NULL or empty = unrestricted (any page).
--
-- username column holds the lowercased Telegram @handle the wizard
-- renders as a button. Set on add (or filled in when a pending invite
-- materializes — see migration 007 pattern).
--
-- poster_invites mirrors sales_contributor_invites: pending grants by
-- @username, auto-materialized when the named user sends Greg any
-- message (their telegram_id is resolved at that point).
--
-- Apply via Supabase SQL Editor. Idempotent.

CREATE TABLE IF NOT EXISTS posters (
  telegram_id    BIGINT PRIMARY KEY,
  username       TEXT,
  display_name   TEXT,
  pages          TEXT[],
  added_by       BIGINT,
  added_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_active      BOOLEAN NOT NULL DEFAULT true,
  notes          TEXT
);

CREATE INDEX IF NOT EXISTS posters_active_idx
  ON posters(is_active) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS posters_username_idx ON posters(username);

CREATE TABLE IF NOT EXISTS poster_invites (
  username       TEXT PRIMARY KEY,
  display_name   TEXT,
  pages          TEXT[],
  added_by       BIGINT,
  added_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes          TEXT
);
