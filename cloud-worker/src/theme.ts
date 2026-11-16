// The public pages' look, taken from the app rather than restated: its design
// tokens (src/styles/tokens.css) and its @font-face rules (src/styles/fonts.css),
// imported as text when the worker is built. A published note then reads in
// the same colours and type as the note in the app, in any browser, and a
// palette change in the app reaches published pages with the next worker
// build instead of by hand. The font files themselves are not the worker's:
// scripts/bundle-worker.mjs copies the ones fonts.css names into the web
// directory Cloudflare serves beside it.
//
// One thing differs, because a visitor's browser is not the app: the app
// paints a theme by setting data-theme on <html>, resolved in JavaScript. A
// public page has to read right with scripts off, so the light palette is
// :root and the dark one answers prefers-color-scheme. Paper is a choice
// made inside the app; no browser can ask for it.

import tokensCss from "../../src/styles/tokens.css?raw";
import fontsCss from "../../src/styles/fonts.css?raw";

/* ---------- The fonts ---------- */

/** Where a page asks for a font file: /__web/fonts/<file>. */
export const FONT_PATH = "/__web/fonts/";

// fonts.css names its files relative to itself, one folder per family; a page
// asks the web directory, where they lie side by side (the bundle script
// refuses two files of one name). The bundle script reads fonts.css with this
// same pattern, so every face here names a file it copied.
const FONT_FACES = fontsCss.replace(/\/\*[\s\S]*?\*\//g, "").trim().replace(
  /url\("\.\.\/assets\/fonts\/[a-z-]+\/([^"]+)"\)/g,
  (_, file: string) => `url("${FONT_PATH}${file}")`,
);
if (/url\("\.\./.test(FONT_FACES)) throw new Error("fonts.css names a font outside src/assets/fonts/<family>/");

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
