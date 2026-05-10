-- ── Per-contributor page scoping ─────────────────────────────────────────
-- Sales contributors can be scoped to a specific subset of pages they're
-- allowed to submit ads for. NULL or empty array = unrestricted (any
-- page allowed). Non-empty array = the contributor's /ad submission is
-- rejected at post time if any handle in `pages` isn't in this list.
--
-- Granted via /addcontributor + /setcontributorpages (reply-based
-- commands in Greg). Validation lives in wizard.js's post-step
-- intercept and lib/contributors.js#isAllowedForPages.

ALTER TABLE sales_contributors
  ADD COLUMN IF NOT EXISTS allowed_pages TEXT[];

COMMENT ON COLUMN sales_contributors.allowed_pages IS
  'Lowercased page handles (no @) the contributor can submit ads for. NULL or empty = unrestricted.';
