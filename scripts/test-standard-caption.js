#!/usr/bin/env node
/**
 * Verifies getStandardBundle captures the IG caption even when an annotation
 * ("…^") or media sits between the caption and the brief — the SESH case
 * where the caption was missed (stored empty → /resolve sent no caption).
 */
process.env.SUPABASE_URL = "";
process.env.SUPABASE_SERVICE_ROLE_KEY = "";
const buf = require("../messageBuffer");

let pass = true;
const assert = (c, m) => { console.log(c ? "✅" : "❌", m); if (!c) pass = false; };

function seed(chatId, msgs) { for (const m of msgs) buf.addMessage({ chat: { id: chatId }, ...m }); }

console.log("\n── caption sits ABOVE an annotation + slides, then the brief ──");
{
  const chat = -9001;
  // chronological: cover, "Covers ^", slide, "Slides 2-7 for ALL ^", CAPTION, then BRIEF
  seed(chat, [
    { message_id: 1, document: { file_name: "IMG_1.JPG" } },
    { message_id: 2, text: "Covers for these 6 pages ^" },
    { message_id: 3, video: { file_name: "IMG_2.MOV" } },
    { message_id: 4, text: "Slides 2-7 for ALL ^" },
    { message_id: 5, text: "@sesh has raised over $40 million and just added DJ Khaled as its newest investor." },
    { message_id: 6, text: "@goal ^" },                       // annotation right before brief
    { message_id: 7, text: "Algo Agency Sesh - E-com - $3,500\n\nINSTRUCTIONS:\n- Carousel\n\nPAGE INFO:\n@scooby - $100" },
  ]);
  const bundle = buf.getStandardBundle(chat, 7);
  assert(/@sesh has raised over \$40 million/.test(bundle.shared.caption || ""),
    `caption captured past the "@goal ^" annotation (got: "${(bundle.shared.caption||"").slice(0,40)}…")`);
  assert(bundle.shared.media.length === 2, `2 shared media collected (got ${bundle.shared.media.length})`);
}

console.log("\n── annotation-only above brief → no caption (not the '^' line) ──");
{
  const chat = -9002;
  seed(chat, [
    { message_id: 1, document: { file_name: "IMG_1.JPG" } },
    { message_id: 2, text: "Covers for ALL ^" },
    { message_id: 3, text: "X - Music - $100\n\nPAGE INFO:\n@a - $100" },
  ]);
  const bundle = buf.getStandardBundle(chat, 3);
  assert(bundle.shared.caption === null, `annotation "Covers for ALL ^" not used as caption (got: ${JSON.stringify(bundle.shared.caption)})`);
}

console.log("\n" + (pass ? "✅ All standard-caption tests passed" : "❌ Some failed"));
process.exit(pass ? 0 : 1);
