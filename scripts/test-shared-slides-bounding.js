#!/usr/bin/env node
/**
 * Regression: filename-attributed brief's shared slides were DROPPED when a
 * previous brief sat in the buffer (catchup multi-brief buffer). The filename
 * scanner walked back, collected the slides into `shared`, then hit the prior
 * brief's "PAGE INFO" line and wiped them → shared_media empty → no slides
 * forwarded (District 12 / Knicks incident). _currentBlock bounds every scanner
 * to its own block so this can't happen.
 */
process.env.SUPABASE_URL = "";
process.env.SUPABASE_SERVICE_ROLE_KEY = "";
const buf = require("../messageBuffer");

let pass = true;
const assert = (c, m) => { console.log(c ? "✅" : "❌", m); if (!c) pass = false; };

console.log("\n── shared slides survive a previous brief in the buffer ──");
{
  const chat = -8200;
  const msgs = [];
  let id = 0; const next = () => ++id;
  // PREVIOUS brief (still in buffer — not pruned, like catchup/hydration)
  msgs.push({ message_id: next(), document: { file_name: "@oldpage.jpg" } });
  msgs.push({ message_id: next(), text: "Old Client - E-com - $100\n\nINSTRUCTIONS:\n- x\n\nPAGE INFO:\n@oldpage - $100" });
  // THIS brief: 2 @-named covers + 3 shared slides + caption + brief
  msgs.push({ message_id: next(), document: { file_name: "@historic.jpg" } });
  msgs.push({ message_id: next(), document: { file_name: "@moist.jpg" } });
  msgs.push({ message_id: next(), text: "Covers for all 2 ^" });
  msgs.push({ message_id: next(), document: { file_name: "IMG_3970.jpg" } });
  msgs.push({ message_id: next(), document: { file_name: "IMG_3971.jpg" } });
  msgs.push({ message_id: next(), document: { file_name: "IMG_3972.jpg" } });
  msgs.push({ message_id: next(), text: "Slides 2-13 for all ^" });
  msgs.push({ message_id: next(), text: "The Knicks are Winning. Welcome to District 12" });
  const briefId = next();
  msgs.push({ message_id: briefId, text: "Ari New York 12th District - Politics - $0 ($3.50 CPM)\n\nINSTRUCTIONS:\n- carousel\n\nPAGE INFO:\n@historic - $0\n@moist - $0" });
  for (const m of msgs) buf.addMessage({ chat: { id: chat }, ...m });

  const fb = buf.getFilenameBundlesByPage(chat, briefId);
  assert(!!fb && fb.byHandle.has("historic") && fb.byHandle.has("moist"), "2 covers attributed (historic, moist)");
  assert(fb.shared.media.length === 3, `3 shared slides captured, NOT dropped (got ${fb?.shared?.media?.length})`);
  // The previous brief's @oldpage cover must NOT bleed in
  assert(!fb.byHandle.has("oldpage"), "previous brief's @oldpage cover excluded");
}

console.log("\n── single brief in a clean buffer still works (no-op bound) ──");
{
  const chat = -8201;
  const msgs = [
    { message_id: 1, document: { file_name: "@a.jpg" } },
    { message_id: 2, text: "Covers for all ^" },
    { message_id: 3, document: { file_name: "slide1.jpg" } },
    { message_id: 4, text: "Slides for all ^" },
    { message_id: 5, text: "Client - E-com - $100\n\nPAGE INFO:\n@a - $100" },
  ];
  for (const m of msgs) buf.addMessage({ chat: { id: chat }, ...m });
  const fb = buf.getFilenameBundlesByPage(chat, 5);
  assert(fb.byHandle.has("a"), "cover attributed");
  assert(fb.shared.media.length === 1, `1 shared slide (got ${fb?.shared?.media?.length})`);
}

console.log("\n" + (pass ? "✅ All shared-slides-bounding tests passed" : "❌ Some failed"));
process.exit(pass ? 0 : 1);
