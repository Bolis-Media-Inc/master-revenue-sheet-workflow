#!/usr/bin/env node
/**
 * Tests that getCollabBundlesByPage is bounded to the current brief's block.
 * Regression: with multiple briefs in the buffer (e.g. /catchup re-injection),
 * a "Host: @x invite:" line from an EARLIER brief misclassified a later
 * standard brief as collab, handed its page an empty bundle, and suppressed the
 * standard scan → the carousel never forwarded (OneOff incident).
 */
process.env.SUPABASE_URL = "";
process.env.SUPABASE_SERVICE_ROLE_KEY = "";
const buf = require("../messageBuffer");

let pass = true;
const assert = (c, m) => { console.log(c ? "✅" : "❌", m); if (!c) pass = false; };

console.log("\n── prior collab brief must NOT make a later standard brief collab ──");
{
  const chat = -8100;
  const msgs = [
    // Brief A: a COLLAB brief (Host line) with its own video
    { message_id: 1, video: { file_name: "collabA.mp4" } },
    { message_id: 2, text: "Host: @somehost, invite: @inv1 @inv2" },
    { message_id: 3, text: "Collab Client - E-com - $300\n\nINSTRUCTIONS:\n- collab\n\nPAGE INFO:\n@somehost - $300" },
    // Brief B: a STANDARD carousel brief for @goal (the OneOff shape)
    { message_id: 4, document: { file_name: "IMG_8579.PNG" } },
    { message_id: 5, document: { file_name: "IMG_8580.PNG" } },
    { message_id: 6, text: "The World Cup is here — shop the looks @oneoff.world" },
    { message_id: 7, text: "OneOff - Affiliate - 1/4 - $500\n\nINSTRUCTIONS:\n- Carousel\n\nPAGE INFO:\n@goal - 1/4" },
  ];
  for (const m of msgs) buf.addMessage({ chat: { id: chat }, ...m });

  // Brief B (msg 7) must NOT be classified collab (its block has no Host line).
  const collab = buf.getCollabBundlesByPage(chat, 7);
  assert(collab === null, `OneOff brief → collab scanner returns null (got ${collab === null ? "null" : "a bundle"})`);

  // Standard scanner should capture the 2 carousel PNGs as shared media.
  const std = buf.getStandardBundle(chat, 7);
  assert(std && std.shared && std.shared.media.length === 2, `standard scan captured 2 carousel images (got ${std?.shared?.media?.length})`);
  const ids = (std?.shared?.media || []).map((m) => m.message_id).sort((a, b) => a - b);
  assert(JSON.stringify(ids) === JSON.stringify([4, 5]), `carousel = msgs 4,5 (got ${JSON.stringify(ids)})`);
}

console.log("\n── a genuine collab brief STILL works ──");
{
  const chat = -8101;
  const msgs = [
    { message_id: 1, video: { file_name: "promo.mp4" } },
    { message_id: 2, text: "Host: @hostpage, invite: @friend1 @friend2" },
    { message_id: 3, text: "Collab Co - E-com - $400\n\nINSTRUCTIONS:\n- collab post\n\nPAGE INFO:\n@hostpage - $400" },
  ];
  for (const m of msgs) buf.addMessage({ chat: { id: chat }, ...m });
  const collab = buf.getCollabBundlesByPage(chat, 3);
  assert(collab && collab.byHandle && collab.byHandle.has("hostpage"), "collab brief still detected (hostpage attributed)");
  assert(collab.byHandle.has("friend1") && collab.byHandle.has("friend2"), "invited handles attributed");
}

console.log("\n" + (pass ? "✅ All collab-bounding tests passed" : "❌ Some failed"));
process.exit(pass ? 0 : 1);
