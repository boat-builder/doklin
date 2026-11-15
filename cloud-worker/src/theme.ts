// The public pages' look, taken from the app rather than restated: its design
// tokens (src/styles/tokens.css), its @font-face rules (src/styles/fonts.css)
// and the font files they name, imported as text and bytes when the worker
// is built. A published note then reads in the same colours and type as the
// note in the app, in any browser, and a palette change in the app reaches
// published pages with the next worker build instead of by hand.
//
// One thing differs, because a visitor's browser is not the app: the app
// paints a theme by setting data-theme on <html>, resolved in JavaScript. A
// public page has to read right with scripts off, so the light palette is
// :root and the dark one answers prefers-color-scheme. Paper is a choice
// made inside the app; no browser can ask for it.

import tokensCss from "../../src/styles/tokens.css?raw";
import fontsCss from "../../src/styles/fonts.css?raw";
import interLatinExtItalic from "../../src/assets/fonts/inter/inter-latin-ext-opsz-italic.woff2?inline";
import interLatinExtNormal from "../../src/assets/fonts/inter/inter-latin-ext-opsz-normal.woff2?inline";
import interLatinItalic from "../../src/assets/fonts/inter/inter-latin-opsz-italic.woff2?inline";
import interLatinNormal from "../../src/assets/fonts/inter/inter-latin-opsz-normal.woff2?inline";
import literataLatinExtItalic from "../../src/assets/fonts/literata/literata-latin-ext-opsz-italic.woff2?inline";
import literataLatinExtNormal from "../../src/assets/fonts/literata/literata-latin-ext-opsz-normal.woff2?inline";
import literataLatinItalic from "../../src/assets/fonts/literata/literata-latin-opsz-italic.woff2?inline";
import literataLatinNormal from "../../src/assets/fonts/literata/literata-latin-opsz-normal.woff2?inline";
import monoLatinExtNormal from "../../src/assets/fonts/roboto-mono/roboto-mono-latin-ext-wght-normal.woff2?inline";
import monoLatinNormal from "../../src/assets/fonts/roboto-mono/roboto-mono-latin-wght-normal.woff2?inline";

/* ---------- The fonts ---------- */

/** Where a page asks for a font file: /__web/fonts/<file>. */
export const FONT_PATH = "/__web/fonts/";

// The vendored files, as vite hands them over: data: URLs. Decoded on first
// request, once per isolate, rather than at startup. File names are unique
// across the families, so the route needs no family folder.
const FONT_DATA: ReadonlyMap<string, string> = new Map([
  ["inter-latin-ext-opsz-italic.woff2", interLatinExtItalic],
  ["inter-latin-ext-opsz-normal.woff2", interLatinExtNormal],
  ["inter-latin-opsz-italic.woff2", interLatinItalic],
  ["inter-latin-opsz-normal.woff2", interLatinNormal],
  ["literata-latin-ext-opsz-italic.woff2", literataLatinExtItalic],
  ["literata-latin-ext-opsz-normal.woff2", literataLatinExtNormal],
  ["literata-latin-opsz-italic.woff2", literataLatinItalic],
  ["literata-latin-opsz-normal.woff2", literataLatinNormal],
  ["roboto-mono-latin-ext-wght-normal.woff2", monoLatinExtNormal],
  ["roboto-mono-latin-wght-normal.woff2", monoLatinNormal],
]);
const decoded = new Map<string, Uint8Array>();

/** A font file's bytes, or null when the worker carries no file by that name. */
export function fontBytes(file: string): Uint8Array | null {
  const cached = decoded.get(file);
  if (cached) return cached;
  const url = FONT_DATA.get(file);
  if (!url) return null;
  const bin = atob(url.slice(url.indexOf(",") + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  decoded.set(file, bytes);
  return bytes;
}

// fonts.css names its files relative to itself; a page asks the worker. Every
// file it names must be one this module imports, or a page would ask for a
// font the worker can't serve — so a mismatch fails the build's tests, not a
// reader's page.
const FONT_FACES = fontsCss.replace(/\/\*[\s\S]*?\*\//g, "").trim().replace(
  /url\("\.\.\/assets\/fonts\/[a-z-]+\/([^"]+)"\)/g,
  (_, file: string) => {
    if (!FONT_DATA.has(file)) throw new Error(`fonts.css names ${file}, which the worker does not carry`);
    return `url("${FONT_PATH}${file}")`;
  },
);

/** The faces nearly every page needs first — the text and the headings —
 *  fetched before the stylesheet asks. */
export const FONT_PRELOAD = ["inter-latin-opsz-normal.woff2", "literata-latin-opsz-normal.woff2"]
  .map((f) => `<link rel="preload" href="${FONT_PATH}${f}" as="font" type="font/woff2" crossorigin>`)
  .join("\n");

/* ---------- The tokens ---------- */

/**
 * tokens.css as a public page can use it: the theme-independent :root (type,
 * radii, motion), the light palette as :root, and the dark palette under
 * prefers-color-scheme. Paper is left out.
 * tokens.css is a flat list of rules, so its blocks are read by selector;
 * one that can't be found is an error, never a page quietly missing a
 * palette.
 */
function pageTokens(css: string): string {
  const blocks = new Map<string, string>();
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    blocks.set(m[1].replace(/\s+/g, " ").trim(), m[2].trim());
  }
  const pick = (selector: string): string => {
    const body = blocks.get(selector);
    if (body === undefined) throw new Error(`tokens.css has no "${selector}" block`);
    return body;
  };
  return [
    `:root { ${pick(":root")} }`,
    `:root { ${pick(':root, [data-theme="light"]')} }`,
    `@media (prefers-color-scheme: dark) { :root { ${pick('[data-theme="dark"]')} } }`,
  ].join("\n");
}

/** Every public page's first stylesheet: the app's fonts and tokens. */
export const PAGE_THEME = `${FONT_FACES}\n${pageTokens(tokensCss)}\n`;
