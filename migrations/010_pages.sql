-- ── Pages registry — Sheet IDs + Telegram chat IDs in one table ───────────
-- Replaces the dual-JSON setup (config/pages.json + config/telegram-
-- destinations.json) plus the ENABLED_PAGES env var, so adding a new page
-- becomes a single insert via Greg's /api/pages endpoint (driven by the
-- Digi UI). Greg + bm_tracking_bot read this table at boot with a periodic
-- refresh; on DB outage they fall back to the JSON files so live
-- forwarding doesn't break.
--
-- sheet_id / chat_id are nullable: some pages have a tracker sheet but no
-- forwarding chat yet (and vice versa). auto_forward replaces the
-- ENABLED_PAGES gate — true means bm_tracking_bot will forward briefs
-- mentioning this handle to its chat_id.
--
-- Apply via Supabase SQL Editor. Idempotent (CREATE IF NOT EXISTS,
-- INSERT ... ON CONFLICT). Re-running this script preserves any
-- post-migration changes — only seeds new rows.

CREATE TABLE IF NOT EXISTS pages (
  handle         TEXT PRIMARY KEY,
  sheet_id       TEXT,
  chat_id        BIGINT,
  auto_forward   BOOLEAN NOT NULL DEFAULT false,
  display_name   TEXT,
  notes          TEXT,
  added_by       BIGINT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pages_auto_forward_idx
  ON pages(auto_forward) WHERE auto_forward = true;

-- updated_at trigger so the API doesn't have to set it manually
CREATE OR REPLACE FUNCTION pages_set_updated_at() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pages_updated_at ON pages;
CREATE TRIGGER pages_updated_at BEFORE UPDATE ON pages
  FOR EACH ROW EXECUTE FUNCTION pages_set_updated_at();

-- ── Seed from the JSON files (auto_forward=true for current ENABLED_PAGES)
INSERT INTO pages (handle, sheet_id, chat_id, auto_forward) VALUES
  ('answerallquestions', '1UNN-JZE9AYPLNJxAihff0ilxKAvnd9n1CRPzhbus-cQ', -4588095782, false),
  ('archivedrunway', '1fx9JGcYYKdxl4vuGysqZX3BMXGdtx1oYwmMs_5OY5po', -4124009890, false),
  ('artistswithoutautotune', '174dnczVEOIHnk8nGKzkMhKzrxAETEld_9grym4CBhaI', -1003068531615, true),
  ('bestofhumors', '1vDf3f3kvnqOim-RHbltsbFHl7RNK-O-tM1xIBybj6nE', -1001560870573, false),
  ('bitchy.tweets', '18aAIVKn4h6SynODhT2fZb75DfP6GoaWtcJ1VyZ6RTbE', -1001888440710, false),
  ('bitchyquotes', '1zZYl7SHvbErIdkGNvopx93yLW-cq4m_B70g60EeolH0', -1002058818155, false),
  ('childhoodpost', '1KPBgkBGwH-kjbP6xrdLqqH8PlKXBby-EsKeYRcTWnlI', -1002646643959, false),
  ('crankybitchprobs', '1NEdMnR1QWMa5lwAfF-0ZVmLaEbbeLzU7S4tBYIhSH6o', -1002031821630, false),
  ('dailyhoodposts', '1bT8ue5zGJKdu7cgmCoAqsdl9Ea2ilLSAjbwtA71C5wA', -1001801499125, false),
  ('dailyhumor_4u', '1YdYTItK4QskrHw4Z5A8WWDazTiOxL7kyETdJLxDK3ik', -1003232793711, false),
  ('dankquillius', '1RvTe8M7ruc7bu6uOnhllm3NfhD1vNVU5KWfbjR78GsE', -1003748086461, false),
  ('databases', '18xEE_mO1z2i88zKMHet2AqCPDSO3FExNjkP71_L9peE', -1002076362386, false),
  ('dopejukes', '1MXr9SWq0wQQY6-fykQ2IKG7UcH74NGS3tRKsy7YLSjQ', -1003896773405, false),
  ('factmayor', '10dzxF7HyihGE4H5C0pO4E7wIRn6QemIBeSCDxNRj-9s', -1002323473417, false),
  ('faillgram', '1hW_OH-dj10Y2p0UX3iw7XpVLSHdUAaySKFWAgPCFvAw', -1001860511555, false),
  ('forged_over_40', NULL, -1003719483553, false),
  ('goal', '1bkPxQr2kt3iSuvC8Ju8Wt6P-LZs9rCDjQUETSHUh71s', -4948060394, false),
  ('greatestmediamoments', '1uD64KYdIpDEhtxrw1gcwEBnX5puh2cZZ-ZbaH7zJeIw', -1001828303871, false),
  ('hauntedfootage', '1Q638PxDb9On02xuEogr2uLaUp5t4uDYIq6vUaGYFSd4', -1003659689883, false),
  ('historic', '1zOakodpHib_3sWSwQlIM5JIFTga4JBPFkdMl4kKWcLc', -4518413558, false),
  ('hitsblunt', '11aBxu_RdkuRmTqDlSSdROE2uptEOuCOskXSQiYKbri0', -1002017246409, false),
  ('hoereacts', '1lydJTDhMmncV_uSCrSLHFPCO7fS858wfXpVblLS1TwQ', -1002004096130, false),
  ('hoodreels', '1_r3ttaNhodj0AfG1Q1T3WWMGnR-1_V2xgoHkx9JF8Ww', -1002426861571, false),
  ('hoopsxcenter', '19eS416GSNG0yoP8hKK2G-JKGZfY5ycFIEAYlZw6l3Wk', -1003710900353, false),
  ('howeverythingworks', '13DJt0pujS3VkZzTM8PY8vgxTaXixKNJRD3aTgPi5OrU', -1002538694071, false),
  ('howsongsarerecorded', '1vCLo7PXNVRstrnUSX4qQwr3O8IZ4XyYVFO03jgj3X4o', NULL, false),
  ('i_have_no_memes96_v2', '1LtBHynKg7l2uDfM-LtWwOx0ywkyMXJjhNri4ZH66aVw', -1002120390092, false),
  ('imbeingsarcastic', '1je8zPTBjFz_TUFas-5ovGS7W6C4sUGPLdo5oeSAetlE', -1001841553143, false),
  ('itstumblrhumor', '1tcPUQU2E2lUF5zFGkmDQi9B3-eOJ6EJawFZc_yir7mY', -1002072000856, false),
  ('marvelmovies', '1P3aTJ3gy9cHm_jaJa1UKZjS_nCs93lj0Z9JFLC_dbkY', -1002458029900, false),
  ('memedwyd', '1cCw98e6BqMj-09Mm6mSVLgFvTiyDFD-pHeNyQ-QryWs', -1001163243075, false),
  ('memerats', NULL, -1001609628938, false),
  ('memerzify', NULL, -1001734112546, false),
  ('moist', '1fU8e8mBiyyx_cBTLYffJ8ajQLPFUmNrW0OIulZbdVbg', -1003293539856, false),
  ('mostmemorablemedia', '19Rg1SSJ4yitXfA6XZgYpSl9CLiMBznWHf4xXomvyeJQ', -5048716543, false),
  ('motorchive', '1VdsT3_qPH5t77mE7Gq4t_CVpLgFAvW_dlTTE03YZcuc', -5032835844, false),
  ('musicbeforeautotune', '1okrS0H9ShKiXt8QSsNTLytJwJ6HCEKhlc7IaVI-9IV8', -1002609139593, false),
  ('nflmemss', NULL, -1003676743403, false),
  ('northwitch69', '1KuccLvdKtpc2d63xQpJBHjLycyPkJaWELpc7OrQwEsc', -1001805483404, false),
  ('oddlyhorrifying', '1bC9mO2w6pgE8uylwwdxKydiA9DTod5jKk_kk6O1_4ec', -1002430472646, false),
  ('pastpreserved', '1DpSYJI5u9cLF_xy3021dwniBey3_jOgxIVJ5TxKj25I', NULL, false),
  ('physicsuncovered', '1V1yYxRxmhPwtDPsdZFFhpjgeXix1tvHZKSSAXsDvnUI', -1003527726967, false),
  ('popdownload', NULL, -1001734112546, false),
  ('psychological', '16-JHD6zfO51PO6B4-ALRsK1dTfa9dG0JCfnbEj6JrOk', -1002124766934, false),
  ('rapperswithoutautotune', '1dc48HNa8tTMg6i206stbwU8WWCu_Y2QFKdINDSCDo8Y', -1002516662892, false),
  ('relatablegirlymemes', '1oiAjHGYi23PlvcNhOQWtAD1EjQIZwzLA6G43vw2UA9k', -1001261098605, false),
  ('scooby', '1a3wu8f3K4iYBcWcJsZvI8WamAW3mHpdbr5krK0dYVwQ', -1001765030106, false),
  ('secrets.jp', '1MM6_zPEJfhl_3Y8r3GvnwoQyQEK88gdnFVdDKlLh-cE', -1002047763087, false),
  ('selfcaresis', '1CJelxfdOL-RsKacqcaaLXWm05Y53bOgKzaDsAqrRXFY', -1001322852192, false),
  ('soda', '18-mHyxvTfwWt9of-w3wsDHjNxzMDx9DiY8tiEDwDpU0', -1003891018165, false),
  ('superficialdolls', '1DpjJ7ol6ilnfvJB2sX7zerEodH7kifkGBRpTu0OakyI', NULL, false),
  ('thefuck.tv', '1OV7sdzcagOY3vzIPRwUSWGio3jOY_G_7JbuI835GUyM', -1001575437749, true),
  ('tinderreels', '104EGTZFA1bz4Y16TjMaCCVbebqKKELIOxsJ2CLA77hI', -1001936590769, false),
  ('tonsil', '1N9vlNxBHgEOiyGWyFciwGXCjiVNazjVRr86yPcwlTYM', -1001992195167, true),
  ('unforgettablesportsmoments', '1nL67lSdosbyZAFz41EhP8CAyjLnjIVSAwFOGuw9uoJQ', -4154960404, false),
  ('whatsif', '1ENq3KwEa6K1cHU5m7XxSazuPyuab6nin3AZe0cJRrLU', -1002049532040, false),
  ('whenrappersfreestyle', '1TKl6gXqnTfOJ83SduUsmVkyrvdPzJ5zQjaQw7T8V0WQ', -4746211766, false)
ON CONFLICT (handle) DO NOTHING;
