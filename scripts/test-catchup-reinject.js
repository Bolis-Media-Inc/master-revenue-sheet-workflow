#!/usr/bin/env node
/**
 * Tests /catchup's re-injection path: a userClient rich message for a cover
 * document named "@moist.jpg" must, after toBufferMsg → addMessage, attribute
 * correctly via the filename bundle scanner (the whole per-page routing depends
 * on the @<handle>.<ext> filename surviving the round-trip — gramJS exposes it
 * via m.file.name, mapped to file_name in getHistoryWindow).
 */
process.env.SUPABASE_URL = "";
process.env.SUPABASE_SERVICE_ROLE_KEY = "";
const buf = require("../messageBuffer");
const { toBufferMsg } = require("../handlers/catchupHandler");

let pass = true;
const assert = (c, m) => { console.log(c ? "✅" : "❌", m); if (!c) pass = false; };

console.log("\n── toBufferMsg media/text shaping ──");
{
  const doc = toBufferMsg(-900, { message_id: 1, date: 100, kind: "document", file_name: "@moist.jpg", text: "" });
  assert(doc.document && doc.document.file_name === "@moist.jpg", "document → msg.document.file_name preserved");
  assert(!doc.text, "media message carries no .text");

  const vid = toBufferMsg(-900, { message_id: 2, date: 100, kind: "video", file_name: "" });
  assert(!!vid.video, "video → msg.video marker");

  const label = toBufferMsg(-900, { message_id: 3, date: 100, kind: null, text: "13 Covers ^" });
  assert(label.text === "13 Covers ^" && !label.document, "text label → msg.text, no media");

  const brief = toBufferMsg(-900, { message_id: 4, date: 100, kind: null, text: "Acme - E-com - $500" });
  assert(brief.text === "Acme - E-com - $500", "brief text preserved");
}

console.log("\n── re-injected covers attribute per-page via filename scanner ──");
{
  const chat = -901;
  const rich = [
    { message_id: 10, date: 1, kind: "document", file_name: "@moist.jpg",     text: "" },
    { message_id: 11, date: 2, kind: "document", file_name: "@hoodreels.jpg",  text: "" },
    { message_id: 12, date: 3, kind: null, text: "Covers ^" },
    { message_id: 13, date: 4, kind: null, text: "Acme - E-com - $500\n\nPAGE INFO:\n@moist - $250\n@hoodreels - $250" },
  ];
  for (const m of rich) buf.addMessage(toBufferMsg(chat, m));

  const bundle = buf.getFilenameBundlesByPage(chat, 13);
  assert(!!bundle && bundle.byHandle, "filename bundle produced from re-injected msgs");
  assert(bundle.byHandle.has("moist") && bundle.byHandle.has("hoodreels"), "both @handles attributed");
  const moistMedia = bundle.byHandle.get("moist")?.media || [];
  assert(moistMedia.length === 1 && moistMedia[0].message_id === 10, "@moist cover = msg 10 (forwardable by message_id)");
}

console.log("\n" + (pass ? "✅ All catchup re-inject tests passed" : "❌ Some failed"));
process.exit(pass ? 0 : 1);
