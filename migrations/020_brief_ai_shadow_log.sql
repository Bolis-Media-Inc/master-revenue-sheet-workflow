-- 020_brief_ai_shadow_log.sql
-- Stores every Brief-AI shadow comparison so we can review the LLM's read vs the
-- heuristics over a few days and measure the agreement rate before flipping
-- Brief-AI to primary. See lib/briefAI.js.
--
-- One row per forwarded brief (when BRIEF_AI_SHADOW=true). `agreed` = the AI and
-- the heuristics produced the same caption/creative read. `diffs` holds the
-- human-readable disagreement strings when they don't.

create table if not exists brief_ai_shadow_log (
  id                uuid        primary key default gen_random_uuid(),
  created_at        timestamptz not null    default now(),
  chat_id           bigint,
  brief_message_id  bigint,
  client            text,
  detected_format   text,
  page_count        int,
  agreed            boolean     not null,
  diffs             jsonb,      -- string[] of disagreement descriptions (empty when agreed)
  heuristic         jsonb,      -- { caption, creativeCount, format, pages }
  ai                jsonb,      -- full classification { caption, creativeCount, instructions, audioRef, pages, perPage, confidence, reason }
  block             jsonb,      -- serialized brief block (for later human review)
  model             text
);

create index if not exists brief_ai_shadow_log_created_idx
  on brief_ai_shadow_log (created_at desc);

create index if not exists brief_ai_shadow_log_agreed_idx
  on brief_ai_shadow_log (agreed, created_at desc);
