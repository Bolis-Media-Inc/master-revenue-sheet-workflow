#!/usr/bin/env node
/**
 * Tests for messageBuffer.pruneToLiveSet — the ghost reconciliation that
 * makes "what's in the chat after the 2-min wait" the source of truth.
 *
 * Ghost = a message ID in the buffer, within the fetched range, that is NOT
 * in the live set (operator deleted it; the bot never got a deletion event).
 */

process.env.SUPABASE_URL = "";              // disable DB mirror in test
process.env.SUPABASE_SERVICE_ROLE_KEY = "";

const buf = require("../messageBuffer");

let pass = true;
function assert(cond, msg) { console.log(cond ? "✅" : "❌", msg); if (!cond) pass = false; }

function seed(chatId, ids) {
  // addMessage requires {chat:{id}, message_id}
  for (const id of ids) buf.addMessage({ chat: { id: chatId }, message_id: id, text: `m${id}` });
}
function bufIds(chatId) {
  return buf.getMessages(String(chatId)).map((m) => m.message_id).sort((a, b) => a - b);
}

console.log("\n── Test 1: Day-19 shape — 3 brief copies, only last survives ──");
{
  const chat = -1001;
  // covers 100-108, slides 110-116, caption 117, brief copies 120/131/133
  seed(chat, [100,101,102,103,104,105,106,107,108, 110,111,112,113,114,115,116, 117, 120, 131, 133]);
  // Live state: operator deleted brief copies 120 & 131 and a stale slide 110.
  const liveIds = [100,101,102,103,104,105,106,107,108, 111,112,113,114,115,116, 117, 133];
  const { removed, kept } = buf.pruneToLiveSet(chat, liveIds);
  assert(removed === 3, `dropped 3 ghosts (120, 131, 110) — got ${removed}`);
  const remaining = bufIds(chat);
  assert(!remaining.includes(120) && !remaining.includes(131), "deleted brief copies gone");
  assert(!remaining.includes(110), "deleted slide gone");
  assert(remaining.includes(133), "surviving final brief kept");
  assert(remaining.includes(117), "caption kept");
  assert(kept === remaining.length, "kept count matches");
}

console.log("\n── Test 2: nothing deleted → no-op ──");
{
  const chat = -1002;
  seed(chat, [10, 11, 12, 13]);
  const { removed } = buf.pruneToLiveSet(chat, [10, 11, 12, 13]);
  assert(removed === 0, "no ghosts when live == buffer");
}

console.log("\n── Test 3: empty live fetch → don't nuke (treat as unverified) ──");
{
  const chat = -1003;
  seed(chat, [20, 21, 22]);
  const { removed, kept } = buf.pruneToLiveSet(chat, []);
  assert(removed === 0 && kept === 3, "empty live set leaves buffer intact");
}

console.log("\n── Test 4: out-of-range entries untouched ──");
{
  const chat = -1004;
  // older messages 5,6 are OUTSIDE the live fetch window (live covers 50-55)
  seed(chat, [5, 6, 50, 51, 52, 53, 54, 55]);
  // live fetch only saw 50-55; 52 was deleted
  const liveIds = [50, 51, 53, 54, 55];
  const { removed } = buf.pruneToLiveSet(chat, liveIds);
  const remaining = bufIds(chat);
  assert(removed === 1, "only the in-range ghost (52) removed");
  assert(remaining.includes(5) && remaining.includes(6), "out-of-range older msgs (5,6) preserved");
  assert(!remaining.includes(52), "in-range ghost 52 dropped");
}

console.log("\n" + (pass ? "✅ All ghost-prune tests passed" : "❌ Some tests failed"));
process.exit(pass ? 0 : 1);
