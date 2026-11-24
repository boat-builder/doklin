// The iOS app's colours, taken from the Mac app's rather than restated: every
// colour set in ios/Doklin/Assets.xcassets is written from
// src/styles/tokens.css — the light palette, and the dark one as its dark
// appearance — so a palette change reaches the phone by running this, not by
// retyping a hex value. The worker does the same for public pages
// (cloud-worker/src/theme.ts).
//
// Which tokens: every name ios/Doklin/Theme.swift asks for as Color("<token>"),
// plus --accent as the asset catalog's AccentColor.
//
//   node scripts/ios-colors.mjs           # write the colour sets
//   node scripts/ios-colors.mjs --check   # exit 1 when they are not what tokens.css says
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;
const TOKENS = join(ROOT, "src/styles/tokens.css");
const THEME = join(ROOT, "ios/Doklin/Theme.swift");
const ASSETS = join(ROOT, "ios/Doklin/Assets.xcassets");
const check = process.argv.includes("--check");

// tokens.css is a flat list of rules, so a palette is read by its selector —
// the same three the worker reads. One that cannot be found is an error.
const blocks = new Map();
for (const m of readFileSync(TOKENS, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  blocks.set(m[1].replace(/\s+/g, " ").trim(), m[2]);
}
function palette(selector) {
  const body = blocks.get(selector);
  if (body === undefined) throw new Error(`tokens.css has no "${selector}" block`);
  const out = new Map();
  for (const m of body.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim());
  return out;
}
// What does not change with the theme is in :root alone: a palette holds it too.
const always = palette(":root");
const light = new Map([...always, ...palette(':root, [data-theme="light"]')]);
const dark = new Map([...always, ...palette('[data-theme="dark"]')]);

/** A token's value as an asset catalog colour: sRGB bytes and an alpha. */
function colour(token, value) {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = hex[1].toUpperCase();
    return { red: `0x${n.slice(0, 2)}`, green: `0x${n.slice(2, 4)}`, blue: `0x${n.slice(4, 6)}`, alpha: "1.000" };
  }
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([0-9.]+)\s*)?\)$/.exec(value);
  if (rgb) {
    const byte = (s) => `0x${Number(s).toString(16).toUpperCase().padStart(2, "0")}`;
    return { red: byte(rgb[1]), green: byte(rgb[2]), blue: byte(rgb[3]), alpha: Number(rgb[4] ?? 1).toFixed(3) };
  }
  throw new Error(`--${token} is "${value}" — a colour here is #rrggbb, rgb() or rgba()`);
}

function colourSet(token) {
  const pick = (map, name) => {
    const value = map.get(token);
    if (value === undefined) throw new Error(`the ${name} palette in tokens.css has no --${token}`);
    return { "color-space": "srgb", components: colour(token, value) };
  };
  return `${JSON.stringify(
    {
      colors: [
        { idiom: "universal", color: pick(light, "light") },
        { idiom: "universal", appearances: [{ appearance: "luminosity", value: "dark" }], color: pick(dark, "dark") },
      ],
      info: { author: "xcode", version: 1 },
    },
    null,
    2,
  )}\n`;
}

const asked = [...readFileSync(THEME, "utf8").matchAll(/Color\("([a-z0-9-]+)"\)/g)].map((m) => m[1]);
if (asked.length === 0) throw new Error("ios/Doklin/Theme.swift names no colour");

/** Folder name → Contents.json, for everything this script owns. */
const wanted = new Map(asked.map((token) => [`${token}.colorset`, colourSet(token)]));
wanted.set("AccentColor.colorset", colourSet("accent"));

const onDisk = existsSync(ASSETS) ? readdirSync(ASSETS).filter((name) => name.endsWith(".colorset")) : [];
const stale = [];
for (const [folder, json] of wanted) {
  const file = join(ASSETS, folder, "Contents.json");
  if (!existsSync(file) || readFileSync(file, "utf8") !== json) stale.push(folder);
}
const extra = onDisk.filter((folder) => !wanted.has(folder));

if (check) {
  if (stale.length + extra.length > 0) {
    console.error(
      `The iOS colour sets are not what src/styles/tokens.css says (${[...stale, ...extra].join(", ")}) — run: node scripts/ios-colors.mjs`,
    );
    process.exit(1);
  }
  console.log(`${wanted.size} colour sets match tokens.css`);
} else {
  for (const [folder, json] of wanted) {
    mkdirSync(join(ASSETS, folder), { recursive: true });
    writeFileSync(join(ASSETS, folder, "Contents.json"), json);
  }
  for (const folder of extra) rmSync(join(ASSETS, folder), { recursive: true });
  const top = join(ASSETS, "Contents.json");
  if (!existsSync(top)) writeFileSync(top, `${JSON.stringify({ info: { author: "xcode", version: 1 } }, null, 2)}\n`);
  console.log(`wrote ${wanted.size} colour sets (${stale.length} changed, ${extra.length} removed)`);
}
