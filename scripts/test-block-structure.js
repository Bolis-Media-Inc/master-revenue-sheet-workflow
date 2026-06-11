#!/usr/bin/env node
/**
 * Tests messageBuffer.getBlockStructure — reconstructing multi-group brief
 * structure from the chat (the Algo Agency Sesh shape: 2 groups, each with
 * its own covers + slides + caption).
 */
process.env.SUPABASE_URL = "";
process.env.SUPABASE_SERVICE_ROLE_KEY = "";
const buf = require("../messageBuffer");

let pass = true;
const assert = (c, m) => { console.log(c ? "✅" : "❌", m); if (!c) pass = false; };
const seed = (chatId, msgs) => { for (const m of msgs) buf.addMessage({ chat: { id: chatId }, ...m }); };

console.log("\n── SESH shape: 2 groups (7-page + 6-page) ──");
{
  const chat = -7001;
  let id = 0; const next = () => ++id;
  const msgs = [];
  // Group A: 7 covers, slides 2-6 (5), caption A
  for (let i = 0; i < 7; i++) msgs.push({ message_id: next(), document: { file_name: `A_cover_${i}.jpg` } });
  msgs.push({ message_id: next(), text: "Covers for these 7 pages ^" });
  for (let i = 0; i < 5; i++) msgs.push({ message_id: next(), video: { file_name: `A_slide_${i}.mov` } });
  msgs.push({ message_id: next(), text: "Slides 2-6 for these 7 pages ^" });
  msgs.push({ message_id: next(), text: "DJ Khaled's partnership with @sesh is getting the internet talking." });
  msgs.push({ message_id: next(), text: "Caption for these 7 pages ^" });
  // Group B: 6 covers, slide 2 (1), caption B
  for (let i = 0; i < 6; i++) msgs.push({ message_id: next(), document: { file_name: `B_cover_${i}.jpg` } });
  msgs.push({ message_id: next(), text: "Covers for these 6 pages ^" });
  msgs.push({ message_id: next(), video: { file_name: "B_slide.mov" } });
  msgs.push({ message_id: next(), text: "Slide 2 for these 6 pages ^" });
  msgs.push({ message_id: next(), text: "@sesh has raised over $40 million and just added DJ Khaled." });
  msgs.push({ message_id: next(), text: "Caption for these 6 pages ^" });
  const briefId = next();
  msgs.push({ message_id: briefId, text: "Algo Agency Sesh - E-com - $3,500\n\nPAGE INFO:\n@moist - $500" });
  seed(chat, msgs);

  const res = buf.getBlockStructure(chat, briefId);
  assert(res !== null, "returns a structure");
  assert(res.isMultiGroup === true, "detected as multi-group");
  assert(res.groups.length === 2, `2 groups (got ${res.groups.length})`);

  const g7 = res.groups.find((g) => g.key.includes("7 pages"));
  const g6 = res.groups.find((g) => g.key.includes("6 pages"));
  assert(!!g7 && !!g6, "both group keys present (these 7 / these 6 pages)");
  assert(g7.coverCount === 7, `group-7 has 7 covers (got ${g7.coverCount})`);
  assert(g7.slideCount === 5, `group-7 has 5 slides (got ${g7.slideCount})`);
  assert(/DJ Khaled's partnership/.test(g7.caption || ""), "group-7 caption = DJ Khaled partnership");
  assert(g6.coverCount === 6, `group-6 has 6 covers (got ${g6.coverCount})`);
  assert(g6.slideCount === 1, `group-6 has 1 slide (got ${g6.slideCount})`);
  assert(/raised over \$40 million/.test(g6.caption || ""), "group-6 caption = $40M");
}

console.log("\n── single-group brief → NOT multi-group ──");
{
  const chat = -7002;
  seed(chat, [
    { message_id: 1, document: { file_name: "@moist.jpg" } },
    { message_id: 2, text: "Covers for ALL ^" },
    { message_id: 3, video: { file_name: "slide.mov" } },
    { message_id: 4, text: "Slides for ALL ^" },
    { message_id: 5, text: "One caption for everyone" },
    { message_id: 6, text: "Caption for ALL ^" },
    { message_id: 7, text: "Client - Music - $100\n\nPAGE INFO:\n@moist - $100" },
  ]);
  const res = buf.getBlockStructure(chat, 7);
  assert(res && res.isMultiGroup === false, "single 'ALL' group → not multi-group");
}

console.log("\n── named-page groups → namedPages populated ──");
{
  const chat = -7003;
  seed(chat, [
    { message_id: 1, document: { file_name: "c1.jpg" } },
    { message_id: 2, text: "Covers for @moist @hoodreels ^" },
    { message_id: 3, text: "caption one" },
    { message_id: 4, text: "Caption for @moist @hoodreels ^" },
    { message_id: 5, document: { file_name: "c2.jpg" } },
    { message_id: 6, text: "Covers for @scooby @goal ^" },
    { message_id: 7, text: "caption two" },
    { message_id: 8, text: "Caption for @scooby @goal ^" },
    { message_id: 9, text: "Client - E-com - $100\n\nPAGE INFO:\n@moist - $100" },
  ]);
  const res = buf.getBlockStructure(chat, 9);
  assert(res.isMultiGroup === true, "named-page multi-group detected");
  const g1 = res.groups.find((g) => g.namedPages && g.namedPages.includes("moist"));
  const g2 = res.groups.find((g) => g.namedPages && g.namedPages.includes("scooby"));
  assert(g1 && g1.namedPages.join(",") === "moist,hoodreels", "group 1 namedPages = moist,hoodreels");
  assert(g2 && g2.namedPages.join(",") === "scooby,goal", "group 2 namedPages = scooby,goal");
}

console.log("\n" + (pass ? "✅ All block-structure tests passed" : "❌ Some failed"));
process.exit(pass ? 0 : 1);
