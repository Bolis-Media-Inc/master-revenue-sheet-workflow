-- ── Media tracking: replace TEXT[] file_ids with JSONB ────────────────────
-- 011 stored `shared_media_file_ids TEXT[]` and `page_media_file_ids TEXT[]`,
-- which is enough to find the media on Telegram's CDN but not enough to KNOW
-- HOW TO RE-SEND IT — sendPhoto vs sendVideo vs sendDocument require
-- different methods, and a bare file_id doesn't reveal type.
--
-- This migration moves to JSONB columns storing array-of-objects:
--   shared_media: [{ "file_id": "AgAC...", "kind": "photo" }, ...]
--   page_media:   [{ "file_id": "BAA...",  "kind": "video" }, ...]
--
-- Why JSONB over parallel TEXT[]:
--   - Items can't get misaligned (file_id always pairs with its own kind)
--   - Easy to add more fields later (caption per item, dimensions, etc.)
--   - PostgreSQL JSONB ops give us querying primitives if we ever want them
--
-- Safe because 011 was just deployed and ad_briefs / ad_brief_pages are
-- empty — no data migration needed. Idempotent via IF EXISTS / IF NOT EXISTS.

ALTER TABLE ad_briefs DROP COLUMN IF EXISTS shared_media_file_ids;
ALTER TABLE ad_briefs ADD  COLUMN IF NOT EXISTS shared_media JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE ad_brief_pages DROP COLUMN IF EXISTS page_media_file_ids;
ALTER TABLE ad_brief_pages ADD  COLUMN IF NOT EXISTS page_media JSONB NOT NULL DEFAULT '[]'::jsonb;
