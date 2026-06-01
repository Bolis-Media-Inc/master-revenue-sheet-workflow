-- 015_pending_brief_assignments.sql
--
-- Paused-brief state for the /resolve flow (cover disambiguation Phase 2).
--
-- When a brief lands with N pages but only K covers @-labeled and the
-- rest unattributed, the operator can run /resolve to walk through
-- per-cover assignment via inline buttons. Each row here represents
-- one resolution session in flight.
--
-- assignments JSONB shape: { "<message_id>": "<page_handle>" | "shared" | "skip" }
-- unattributed JSONB shape: [{ message_id, kind, file_id, file_name? }, ...]
-- prompt_message_ids: messageIds of the prompt cards in the operator's DM
--                     (so /resolve cancel can clean up)

CREATE TABLE IF NOT EXISTS pending_brief_assignments (
  id                  uuid primary key default gen_random_uuid(),
  brief_id            uuid references ad_briefs(id) on delete cascade,
  source_chat_id      bigint   not null,
  brief_message_id    bigint   not null,
  brief_text          text,
  pages               text[]   not null default ARRAY[]::text[],
  unattributed        jsonb    not null default '[]'::jsonb,
  assignments         jsonb    not null default '{}'::jsonb,
  status              text     not null default 'awaiting'
                      check (status in ('awaiting','resolving','resolved','cancelled','expired')),
  prompt_chat_id      bigint,
  prompt_message_ids  bigint[],
  initiated_by        bigint,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  expires_at          timestamptz
);

CREATE INDEX IF NOT EXISTS idx_pba_status      ON pending_brief_assignments(status);
CREATE INDEX IF NOT EXISTS idx_pba_brief       ON pending_brief_assignments(brief_id);
CREATE INDEX IF NOT EXISTS idx_pba_initiator   ON pending_brief_assignments(initiated_by);

-- Auto-update updated_at on UPDATE (mirrors other tables' convention)
CREATE OR REPLACE FUNCTION _pba_touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pba_touch_updated_at ON pending_brief_assignments;
CREATE TRIGGER pba_touch_updated_at
  BEFORE UPDATE ON pending_brief_assignments
  FOR EACH ROW EXECUTE FUNCTION _pba_touch_updated_at();
