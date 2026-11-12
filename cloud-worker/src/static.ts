// Responses that need no workspace: the static assets, the landing page and
// the 404 page. Out of public.ts so pages.ts (which answers 404 for a file
// that is gone) can use them without an import cycle.

import { WEB_ASSETS } from "./assets";
import { APPLE_TOUCH_PNG_B64, FAVICON_ICO_B64 } from "./favicons";
import { escapeHtml } from "./http";
import { OG_PNG_B64 } from "./og";
import { FONT_PRELOAD, PAGE_THEME, fontBytes } from "./theme";

const DOWNLOAD_URL =
  "https://github.com/boat-builder/doklin/releases/latest/download/Doklin-macos-arm64.dmg";
const REPO_URL = "https://github.com/boat-builder/doklin";

const decode = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const FAVICON_ICO = decode(FAVICON_ICO_B64);
const APPLE_TOUCH = decode(APPLE_TOUCH_PNG_B64);
const OG_PNG = decode(OG_PNG_B64);

const FAVICON_LINKS = `<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">`;

// The landing and 404 pages wear the same theme as a rendered note
// (theme.ts: the app's own tokens and Newsreader), so the domain reads as
// one site.
const SHELL_CSS = `${PAGE_THEME}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--sheet); }
body {
  min-height: 100dvh; display: flex; flex-direction: column; color: var(--text-1);
  font-family: var(--font-ui); font-size: 16px; line-height: 1.6; -webkit-font-smoothing: antialiased;
}
::selection { background: var(--selection); }
main { width: 100%; max-width: 640px; margin: auto; padding: 64px 24px; }
h1 {
  margin: 0 0 12px; font-family: var(--font-serif); font-size: 42px; font-weight: 650;
  line-height: 1.12; letter-spacing: -0.02em;
}
p { margin: 0; padding: 4px 0; }
.eyebrow { color: var(--text-3); font-size: var(--fs-sm); font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; }
.muted { color: var(--text-2); }
.actions { display: flex; flex-wrap: wrap; gap: 12px 20px; align-items: center; padding-top: 20px; }
.button {
  display: inline-block; padding: 9px 16px; border-radius: var(--r-md); background: var(--accent);
  color: var(--on-fill); text-decoration: none; font-weight: 600;
}
.button:hover { filter: brightness(1.08); }
.quiet { color: var(--text-2); text-decoration: none; border-bottom: 1px solid var(--border-strong); }
.quiet:hover { color: var(--text-1); }
`;

function shell(title: string, body: string, status = 200): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${FAVICON_LINKS}
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
${FONT_PRELOAD}
<style>${SHELL_CSS}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "x-robots-tag": "noindex" },
  });
}

/**
 * `/` when the public map names no root page: the workspace's name and a
 * way to get Doklin. What a visitor who trimmed a link back to the domain
 * needs to know — whose notes these are, and what wrote them.
 */
export function landingPage(workspaceName: string | null): Response {
  const name = workspaceName?.trim() ?? "";
  const heading = name || "Notes";
  return shell(
    name ? `${name} · Doklin` : "Doklin",
    `<p class="eyebrow">Published with Doklin</p>
<h1>${escapeHtml(heading)}</h1>
<p class="muted">Notes on this domain are written in Doklin, a free and open-source markdown editor for macOS that keeps your writing on your own machine — and on a domain of your own, like this one.</p>
<p class="actions"><a class="button" href="${DOWNLOAD_URL}">Download Doklin</a> <a class="quiet" href="${REPO_URL}">Source on GitHub</a></p>`,
  );
}

export function notFoundPage(): Response {
  return shell(
    "Nothing here",
    `<h1>Nothing here</h1>
<p class="muted">This page doesn't exist or is no longer published.</p>`,
    404,
  );
}

export function robotsTxt(): Response {
  return new Response("User-agent: *\nAllow: /\n", {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function assetResponse(bytes: Uint8Array, contentType: string): Response {
  return new Response(bytes, {
    headers: { "content-type": contentType, "cache-control": "public, max-age=604800, immutable" },
  });
}

export const favicon = (): Response => assetResponse(FAVICON_ICO, "image/x-icon");
export const appleTouchIcon = (): Response => assetResponse(APPLE_TOUCH, "image/png");
/** One static Open Graph image for the whole site — og:title carries the words. */
export const ogImage = (): Response => assetResponse(OG_PNG, "image/png");

/**
 * A Newsreader file at /__web/fonts/<file> — the very files the app bundles
 * (theme.ts). Addressed by name like the icons, so cached for the same week.
 */
export function fontFile(file: string): Response | null {
  const bytes = fontBytes(file);
  return bytes ? assetResponse(bytes, "font/woff2") : null;
}

/**
 * The standalone mermaid module at /__web/<tag>/mermaid.js. Any tag serves
 * the CURRENT build: the immutable cache is content-keyed by the tag a page
 * requested, and a mismatched tag only means an older page, which still gets
 * working code and re-tags on its next load. The build's own tag rides
 * along as the etag.
 */
export function mermaidModule(): Response {
  if (!WEB_ASSETS) {
    return new Response("web assets not bundled — build with scripts/bundle-worker.mjs", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return new Response(WEB_ASSETS.mermaid, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
      etag: `"${WEB_ASSETS.tag}"`,
      "x-robots-tag": "noindex",
    },
  });
}
