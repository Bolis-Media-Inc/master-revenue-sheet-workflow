-- 019_pending_brief_assignments_groups.sql
--
-- Multi-group brief support (interactive resolver). A brief can split its
-- pages into creative groups, each with its own covers + slides + caption.
--
--   kind               'covers' (existing cover-only resolve) | 'groups'
--   blocks             jsonb — captured group structure from
--                      messageBuffer.getBlockStructure: [{ key, caption,
--                      coverRefs:[{file_id,kind}], slideRefs:[…] }, …]
--   group_assignments  jsonb — { "@moist": "<groupKey>", … } operator mapping

ALTER TABLE pending_brief_assignments
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'covers',
  ADD COLUMN IF NOT EXISTS blocks jsonb,
  ADD COLUMN IF NOT EXISTS group_assignments jsonb;
