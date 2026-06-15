#!/usr/bin/env node
/**
 * Regression: digi (and some upload tools) sanitize "_" and "." to "-" in
 * generated cover filenames — so a cover for page @dailyhumor_4u arrives as
 * "@dailyhumor-4u.jpg", and @thefuck.tv's cover as "@thefuck-tv.jpg". The
 * filename attribution regex used to allow only [\w.] (letters/digits/
 * underscore/dot), so every hyphenated cover FAILED to attribute and fell into
 * the "shared = forward to all pages" bucket. Result (Stake Day 27 incident):
 * every page got its own cover PLUS 2-3 other pages' covers.
 *
 * Fix part 1 (here): the regex now allows "-" so hyphenated covers attribute.
 * Fix part 2 (test-pages-separator-resolve): pagesRegistry.resolveHandle maps
 * the hyphenated key back to the real page (separator-insensitive), so the
 * forwarder routes each cover to its single correct page.
 */
process.env.SUPABASE_URL = "";
process.env.SUPABASE_SERVICE_ROLE_KEY = "";
process.env.DISABLE_USER_CLIENT = "1";
const buf = require("../messageBuffer");

let pass = true;
const assert = (c, m) => { console.log(c ? "✅" : "❌", m); if (!c) pass = false; };

console.log("\n── hyphenated per-page covers attribute (not shared) ──");
{
  const chat = -9001;
  let id = 0; const next = () => ++id;
  const msgs = [];
  msgs.push({ message_id: next(), document: { file_name: "@dailyhoodposts.jpg" } });        // plain
  msgs.push({ message_id: next(), document: { file_name: "@dailyhumor-4u.jpg" } });          // -→_
  msgs.push({ message_id: next(), document: { file_name: "@i-have-no-memes96-v2.jpg" } });   // multi -→_
  msgs.push({ message_id: next(), document: { file_name: "@thefuck-tv.jpg" } });             // -→.
  msgs.push({ message_id: next(), video: { file_name: "IMG_3082.MP4" }, caption: "Japan fans..." }); // genuine shared
  const briefId = next();
  msgs.push({ message_id: briefId, text:
    "Stake BET SLIP Day 27 - Affiliate - $175\n\nINSTRUCTIONS:\n- x\n\nPAGE INFO:\n" +
    "@dailyhoodposts - $175\n@dailyhumor_4u - $175\n@i_have_no_memes96_v2 - $175\n@thefuck.tv - $175" });
  for (const m of msgs) buf.addMessage({ chat: { id: chat }, ...m });

  const fb = buf.getFilenameBundlesByPage(chat, briefId);
  assert(fb.byHandle.has("dailyhoodposts"), "dailyhoodposts attributed");
  assert(fb.byHandle.has("dailyhumor-4u"), "dailyhumor-4u attributed (was shared before fix)");
  assert(fb.byHandle.has("i-have-no-memes96-v2"), "i-have-no-memes96-v2 attributed");
  assert(fb.byHandle.has("thefuck-tv"), "thefuck-tv attributed");
  assert(fb.byHandle.size === 4, `exactly 4 covers attributed (got ${fb.byHandle.size})`);
  assert(fb.shared.media.length === 1, `exactly 1 genuinely-shared slide (got ${fb.shared.media.length})`);
  // The IG copy rode in as the shared video's caption — must NOT be dropped.
  assert(fb.shared.caption === "Japan fans...", `shared caption recovered from media (got ${JSON.stringify(fb.shared.caption)})`);
}

console.log("\n── standalone caption above brief still wins over media caption ──");
{
  const chat = -9002;
  let id = 0; const next = () => ++id;
  const msgs = [];
  msgs.push({ message_id: next(), document: { file_name: "@dailyhoodposts.jpg" } });
  msgs.push({ message_id: next(), video: { file_name: "slide.mp4" }, caption: "incidental media caption" });
  msgs.push({ message_id: next(), text: "The real IG caption copy goes here" }); // standalone, closest to brief
  const briefId = next();
  msgs.push({ message_id: briefId, text: "Client X - E-com - $100\n\nPAGE INFO:\n@dailyhoodposts - $100" });
  for (const m of msgs) buf.addMessage({ chat: { id: chat }, ...m });
  const fb = buf.getFilenameBundlesByPage(chat, briefId);
  assert(fb.shared.caption === "The real IG caption copy goes here", `standalone caption wins (got ${JSON.stringify(fb.shared.caption)})`);
}

console.log("\n── pagesRegistry maps hyphenated handle → real page ──");
{
  const pages = require("../lib/pages");
  const reg = (pages.listAllSync ? pages.listAllSync() : []).map((p) => p.handle);
  const cases = [
    ["dailyhumor-4u", "dailyhumor_4u"],
    ["i-have-no-memes96-v2", "i_have_no_memes96_v2"],
    ["thefuck-tv", "thefuck.tv"],
  ];
  for (const [inp, exp] of cases) {
    if (!reg.includes(exp)) { console.log("⏭️ ", exp, "not in registry snapshot — skipping"); continue; }
    assert(pages.resolveHandle(inp) === exp, `${inp} → ${exp}`);
  }
}

console.log("\n" + (pass ? "✅ All hyphen-cover-attribution tests passed" : "❌ Some failed"));
process.exit(pass ? 0 : 1);
