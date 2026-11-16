// Responses that need no workspace: the landing page and the 404 page. Out
// of public.ts so pages.ts (which answers 404 for a file that is gone) can use
// them without an import cycle. The files a page asks for — fonts, icons,
// og.png, robots.txt, the mermaid module — are not the worker's: Cloudflare
// serves them from the web directory beside it (scripts/bundle-worker.mjs).

import { escapeHtml } from "./http";
import { FONT_PRELOAD, PAGE_THEME } from "./theme";

const DOWNLOAD_URL =
  "https://github.com/boat-builder/doklin/releases/latest/download/Doklin-macos-arm64.dmg";
const REPO_URL = "https://github.com/boat-builder/doklin";

const FAVICON_LINKS = `<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">`;

// The landing and 404 pages wear the same theme as a rendered note
// (theme.ts: the app's own tokens and bundled fonts), so the domain reads as
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
  margin: 0 0 12px; font-family: var(--font-heading); font-size: 42px; font-weight: var(--doc-heading-weight);
  line-height: 1.12; letter-spacing: var(--doc-h1-track);
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
