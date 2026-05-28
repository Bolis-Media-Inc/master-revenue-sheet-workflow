-- ── Persistent message buffer — survives Railway redeploys ────────────────
--
-- The in-memory MessageBuffer drops everything when the Node process
-- restarts (Railway redeploy, OOM, crash). Tonight a redeploy mid-brief
-- wiped the Whop Enhanced Games collab content from the buffer, leaving
-- the bot unable to attribute videos to pages even though the brief
-- itself was captured fine.
--
-- Fix: mirror every incoming message to message_buffer. On startup,
-- hydrate the in-memory buffer from the last MAX_BUFFER_PER_CHAT rows
-- per chat. Bundle scanners are unchanged — they still read from
-- in-memory.
--
-- Storing the full Telegram message as JSONB lets us reconstruct the
-- exact Message object the scanners expect (photo[], video.file_id,
-- document.file_name, text, caption, message_id, etc.) without having
-- to enumerate every field as a column.

CREATE TABLE IF NOT EXISTS message_buffer (
  id           BIGSERIAL PRIMARY KEY,
  chat_id      BIGINT NOT NULL,
  message_id   BIGINT NOT NULL,
  message_json JSONB  NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chat_id, message_id)
);

-- Hydration query (last N per chat) hits this index
CREATE INDEX IF NOT EXISTS message_buffer_chat_received_idx
  ON message_buffer (chat_id, received_at DESC);

-- clearBufferUpTo runs `DELETE WHERE chat_id = X AND message_id <= Y` —
-- needs this index for efficient pruning
CREATE INDEX IF NOT EXISTS message_buffer_chat_msg_idx
  ON message_buffer (chat_id, message_id);
