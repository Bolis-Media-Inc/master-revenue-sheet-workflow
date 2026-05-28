-- ── Posted-on event persistence ───────────────────────────────────────────
-- "Posted on @page1 @page2 ..." messages in the admin chat flip the master
-- sheet's Status column for those rows from Scheduled → Live. When the
-- master row doesn't exist yet (because the original write hit the Sheets
-- API quota), the update updates 0 rows and the page stays Scheduled
-- forever — even after /syncsheets backfills the row later.
--
-- Fix: persist the Posted-on event on ad_brief_pages.posted_at. Then
-- /syncsheets can detect "this page was already posted, the master row I
-- just wrote should be Live not Scheduled" and write the correct status.
--
-- Partial index covers the common query: "which backfilled pages need
-- their Status flipped?"

ALTER TABLE ad_brief_pages
  ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS ad_brief_pages_posted_idx
  ON ad_brief_pages (brief_id) WHERE posted_at IS NOT NULL;
