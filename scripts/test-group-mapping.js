#!/usr/bin/env node
/**
 * Tests resolveHandler.parseGroupMapping — turning an operator's
 * "G1: @a @b | G2: @c" reply into { handle: groupIndex }. Must not let a
 * group token swallow handles containing 'g' (e.g. @goal, @greatestmedia).
 */
process.env.SUPABASE_URL = "";
process.env.SUPABASE_SERVICE_ROLE_KEY = "";
const { parseGroupMapping } = require("../handlers/resolveHandler");

let pass = true;
const assert = (c, m) => { console.log(c ? "✅" : "❌", m); if (!c) pass = false; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("\n── basic pipe-separated ──");
{
  const out = parseGroupMapping("G1: @howeverythingworks @moist | G2: @dailyhumor_4u @thefuck.tv", 2);
  assert(out.howeverythingworks === 0 && out.moist === 0, "G1 → index 0");
  assert(out.dailyhumor_4u === 1 && out["thefuck.tv"] === 1, "G2 → index 1 (incl thefuck.tv dot handle)");
}

console.log("\n── newline-separated, mixed case G ──");
{
  const out = parseGroupMapping("g1: @a @b\ng2: @c", 2);
  assert(eq(out, { a: 0, b: 0, c: 1 }), `newline + lowercase g (got ${JSON.stringify(out)})`);
}

console.log("\n── handles containing 'g' aren't swallowed ──");
{
  const out = parseGroupMapping("G1: @goal @greatestmediamoments | G2: @gum", 2);
  assert(out.goal === 0 && out.greatestmediamoments === 0, "@goal + @greatestmediamoments → G1 intact");
  assert(out.gum === 1, "@gum → G2");
}

console.log("\n── out-of-range group ignored ──");
{
  const out = parseGroupMapping("G1: @a | G3: @b", 2); // only 2 groups
  assert(out.a === 0 && out.b === undefined, "G3 (no such group) ignored");
}

console.log("\n── empty / garbage ──");
{
  assert(eq(parseGroupMapping("", 2), {}), "empty → {}");
  assert(eq(parseGroupMapping("no groups here @x @y", 2), {}), "no G markers → {}");
}

console.log("\n" + (pass ? "✅ All group-mapping tests passed" : "❌ Some failed"));
process.exit(pass ? 0 : 1);
