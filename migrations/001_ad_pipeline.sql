-- ── Ad-to-Live Pipeline Migration ──────────────────────────────────────────
-- Run this in the Supabase SQL Editor for the Bolis Command Center project.
-- Creates tables for the new ad submission, posted-ad tracking, and view-count
-- automation pipeline (replacing in-memory wizard.js sessions).
--
-- Apply via: copy/paste into https://supabase.com/dashboard/project/[id]/sql/new
-- Or via Supabase CLI: supabase db push
--
-- Idempotent — safe to re-run.

-- ── ad_sessions: replaces wizard.js in-memory `sessions` Map ────────────────
CREATE TABLE IF NOT EXISTS ad_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      BIGINT NOT NULL,                       -- Telegram user
  step         TEXT NOT NULL,                         -- current wizard step or 'awaiting_approval' / 'sending'
  source       TEXT NOT NULL,                         -- 'wizard' | 'quick' | 'api' | 'digi'
  trusted      BOOLEAN DEFAULT false,                 -- if true, auto-approves with cancel window
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,    -- accumulated wizard answers + creatives
  approval_msg JSONB,                                 -- {chatId, messageId} for the cancel/approval card
  cancel_until TIMESTAMPTZ,                           -- when auto-approve cancel window closes
  status       TEXT DEFAULT 'pending',                -- pending | sent | cancelled | expired
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now(),
  expires_at   TIMESTAMPTZ DEFAULT (now() + INTERVAL '24 hours')
);

CREATE INDEX IF NOT EXISTS idx_ad_sessions_user_status   ON ad_sessions (user_id, status);
CREATE INDEX IF NOT EXISTS idx_ad_sessions_cancel_until  ON ad_sessions (cancel_until) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_ad_sessions_expires       ON ad_sessions (expires_at) WHERE status = 'pending';

-- ── ad_creatives: per-page creative URLs within a session ─────────────────
CREATE TABLE IF NOT EXISTS ad_creatives (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   UUID NOT NULL REFERENCES ad_sessions(id) ON DELETE CASCADE,
  page_handle  TEXT NOT NULL,
  media_url    TEXT NOT NULL,                         -- Supabase Storage URL or external URL
  media_type   TEXT NOT NULL,                         -- 'image' | 'video'
  headline     TEXT,                                  -- per-page headline variant (from Digi)
  metadata     JSONB,                                 -- {accentColor, font, etc.}
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ad_creatives_session ON ad_creatives (session_id);

-- ── posted_ads: lifecycle tracking from "scheduled" → "live" → "expired" ──
CREATE TABLE IF NOT EXISTS posted_ads (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  master_sheet_row INT,                               -- row in Master Revenue Sheet (nullable until known)
  page_handle     TEXT NOT NULL,
  client_name     TEXT NOT NULL,
  ad_session_id   UUID REFERENCES ad_sessions(id),
  submitted_by    BIGINT,                             -- Telegram user who submitted/posted
  ig_url          TEXT,                               -- set when VA pastes link
  ig_post_id      TEXT,                               -- extracted from URL (e.g. 'p/abc123')
  status          TEXT DEFAULT 'scheduled',           -- scheduled | live | expired | taken_down
  posted_at       TIMESTAMPTZ,                        -- when VA pasted the IG URL
  duration_ms     BIGINT,                             -- post duration from NIF/perm
  expires_at      TIMESTAMPTZ,                        -- when post should come down
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_posted_ads_user_status   ON posted_ads (submitted_by, status);
CREATE INDEX IF NOT EXISTS idx_posted_ads_handle_status ON posted_ads (page_handle, status);
CREATE INDEX IF NOT EXISTS idx_posted_ads_expires       ON posted_ads (expires_at) WHERE status = 'live';

-- ── view_counts: historical view-count snapshots per posted ad ────────────
CREATE TABLE IF NOT EXISTS view_counts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  posted_ad_id  UUID NOT NULL REFERENCES posted_ads(id) ON DELETE CASCADE,
  views         BIGINT NOT NULL,
  fetched_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_view_counts_posted ON view_counts (posted_ad_id, fetched_at DESC);

-- ── Trigger: auto-update updated_at columns ───────────────────────────────
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_updated_at ON ad_sessions;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON ad_sessions
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON posted_ads;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON posted_ads
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
