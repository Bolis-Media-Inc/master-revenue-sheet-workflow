-- ── Ad brief history — persistent storage of every brief we process ──────
-- Today briefs live only in:
--   1. The in-memory MessageBuffer (100 msgs/chat, ~1hr on busy chats)
--   2. Denormalized rows on the master revenue sheet
--
-- Neither lets us audit "did secrets.jp actually receive the Whop brief?",
-- /replay a brief older than 1 hour, or query "show me all briefs from a
-- given client last week." This migration adds two tables:
--
--   ad_briefs       — one row per brief Danielson (or anyone) posts in
--                     Internal Network Ads. Verbatim raw_text + parsed
--                     fields + shared media/caption.
--   ad_brief_pages  — one row per page targeted in that brief. Per-page
--                     price, per-page media, forwarding outcome, and the
--                     sheet row numbers we wrote.
--
-- Indexes are tuned for /replay's two query shapes:
--   - search mode: WHERE client ILIKE '%stake bet slip%'
--   - reply mode:  WHERE telegram_chat_id = X AND telegram_message_id = Y
--
-- Idempotent — CREATE TABLE IF NOT EXISTS, DROP/CREATE trigger.

CREATE TABLE IF NOT EXISTS ad_briefs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Telegram source identity (used by /replay reply mode + duplicate detection)
  telegram_chat_id      BIGINT NOT NULL,
  telegram_message_id   BIGINT NOT NULL,
  sender_user_id        BIGINT,
  sender_handle         TEXT,

  -- Raw + parsed brief content
  raw_text              TEXT NOT NULL,
  client                TEXT,
  category              TEXT,
  total_price           NUMERIC,
  post_type             TEXT,
  post_duration         TEXT,
  nif                   TEXT,
  date_posted           TEXT,           -- "Wed, 5/27/26" — matches sheet format
  time_mst              TEXT,           -- "8:15 PM"

  -- Shared bundle (slides 2-4 for all pages + shared IG caption)
  shared_media_file_ids TEXT[] NOT NULL DEFAULT '{}',
  shared_caption        TEXT,

  -- Detected attribution format for debugging
  bundle_format         TEXT,           -- "filename" | "label" | "collab" | "fallback"

  received_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (telegram_chat_id, telegram_message_id)
);

-- Fast client-name search for /replay search mode
CREATE INDEX IF NOT EXISTS ad_briefs_client_idx
  ON ad_briefs USING gin (client gin_trgm_ops);

-- Recent-first listing for any future "recent briefs" UI
CREATE INDEX IF NOT EXISTS ad_briefs_received_at_idx
  ON ad_briefs (received_at DESC);

-- pg_trgm extension needed for the gin trigram index above
CREATE EXTENSION IF NOT EXISTS pg_trgm;


CREATE TABLE IF NOT EXISTS ad_brief_pages (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brief_id              UUID NOT NULL REFERENCES ad_briefs(id) ON DELETE CASCADE,

  -- Page identity + per-page brief data
  page_handle           TEXT NOT NULL,
  bulk_num              TEXT,                              -- e.g. "11/15"
  page_price            NUMERIC,
  page_media_file_ids   TEXT[] NOT NULL DEFAULT '{}',      -- this page's cover(s)
  page_caption          TEXT,                              -- per-page IG copy if any

  -- Forwarding outcome (NULL until forwarded)
  forwarded_at          TIMESTAMPTZ,
  forwarded_message_ids BIGINT[],                          -- what we sent into the page's IG Ads chat
  forward_error         TEXT,                              -- last error if forward failed

  -- Sheet row receipts (NULL if write failed)
  master_sheet_row      INT,
  page_sheet_row        INT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (brief_id, page_handle)
);

-- /replay search-mode + audit: "which pages got Whop Enhanced Games?"
CREATE INDEX IF NOT EXISTS ad_brief_pages_brief_id_idx
  ON ad_brief_pages (brief_id);

-- "Show me all briefs that targeted @howeverythingworks" — supports the
-- future "page history" panel in Digi.
CREATE INDEX IF NOT EXISTS ad_brief_pages_handle_idx
  ON ad_brief_pages (page_handle);

-- Audit: which forwards failed and need retry
CREATE INDEX IF NOT EXISTS ad_brief_pages_unforwarded_idx
  ON ad_brief_pages (brief_id) WHERE forwarded_at IS NULL;
