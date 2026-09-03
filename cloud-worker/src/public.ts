// The public surface — no auth, GET/HEAD only. Today: the landing page at
// `/`, the static assets, and a 404 page for everything else. Public pages
// (a published file rendered from its synced blob, a folder's table of
// contents) arrive with publishing — docs/cloud-redesign.md §5.6, PR 4 —
// and slot in ahead of the 404 in index.ts.

import { WEB_ASSETS } from "./assets";
import type { WorkspaceRecord } from "./bucket";
import { APPLE_TOUCH_PNG_B64, FAVICON_ICO_B64 } from "./favicons";
import { escapeHtml } from "./http";

const DOWNLOAD_URL =
  "https://github.com/boat-builder/doklin/releases/latest/download/Doklin-macos-arm64.dmg";
const REPO_URL = "https://github.com/boat-builder/doklin";

const decode = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const FAVICON_ICO = decode(FAVICON_ICO_B64);
const APPLE_TOUCH = decode(APPLE_TOUCH_PNG_B64);

const FAVICON_LINKS = `<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">`;

// The page chrome's tokens — the same values the app's reading view uses,
// so the landing page and a rendered note (later) read as one site.
const SHELL_CSS = `
:root { --bg: #ffffff; --text: #37352f; --muted: rgba(55, 53, 47, 0.55); --border: rgba(55, 53, 47, 0.12); --accent: #2383e2; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #191919; --text: #ebebeb; --muted: rgba(255, 255, 255, 0.5); --border: rgba(255, 255, 255, 0.14); --accent: #529cca; }
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); }
body {
  min-height: 100dvh; display: flex; flex-direction: column; color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Inter", "SF Pro Text", "Segoe UI", sans-serif;
  font-size: 16px; line-height: 1.6; -webkit-font-smoothing: antialiased;
}
main { width: 100%; max-width: 640px; margin: auto; padding: 64px 24px; }
h1 { font-size: 32px; line-height: 1.25; letter-spacing: -0.01em; margin: 0 0 8px; }
p { margin: 0; padding: 4px 0; }
.eyebrow { color: var(--muted); font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; }
.muted { color: var(--muted); }
.actions { display: flex; flex-wrap: wrap; gap: 12px 20px; align-items: center; padding-top: 20px; }
.button { display: inline-block; padding: 9px 16px; border-radius: 8px; background: var(--accent); color: #fff; text-decoration: none; font-weight: 600; }
.quiet { color: var(--muted); text-decoration: none; border-bottom: 1px solid var(--border); }
.quiet:hover, .button:hover { filter: brightness(1.08); }
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
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
  });
}

/**
 * `/` when the public map names no root page: the workspace's name and a
 * way to get Doklin. What a visitor who trimmed a link back to the domain
 * needs to know — whose notes these are, and what wrote them.
 */
export function landingPage(workspace: WorkspaceRecord | null): Response {
  const name = workspace?.name.trim() ?? "";
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

function iconResponse(bytes: Uint8Array, contentType: string): Response {
  return new Response(bytes, {
    headers: { "content-type": contentType, "cache-control": "public, max-age=604800, immutable" },
  });
}

export const favicon = (): Response => iconResponse(FAVICON_ICO, "image/x-icon");
export const appleTouchIcon = (): Response => iconResponse(APPLE_TOUCH, "image/png");

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
