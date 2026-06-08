-- 017_pending_briefs_superseded.sql
--
-- Add 'superseded' to the pending_briefs.status CHECK constraint.
--
-- Why: the supersede guard cancels older pending copies of a brief when the
-- operator deletes + re-sends to fix a typo / add a forgotten creative
-- (delete-and-resend workflow). The cancelled copies are marked 'superseded'
-- — distinct from 'processed' for audit clarity — so only the final copy
-- forwards. Prevents the Stake Day 19 cascade where 3 copies each processed
-- independently and the media-less last one force-forwarded empty content.

ALTER TABLE pending_briefs DROP CONSTRAINT IF EXISTS pending_briefs_status_check;
ALTER TABLE pending_briefs ADD CONSTRAINT pending_briefs_status_check
  CHECK (status = ANY (ARRAY[
    'pending'::text,
    'processing'::text,
    'processed'::text,
    'failed'::text,
    'superseded'::text
  ]));
