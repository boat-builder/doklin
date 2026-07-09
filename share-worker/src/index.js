// Doklin share worker — serves public share pages from an R2 bucket.
//
// Optional env vars (wrangler.toml [vars]): OWNER_NAME / OWNER_LINK brand the
// root landing page; when unset it stays generic.
//
// Public surface (no auth):
//   GET /<id>          rendered read-only page for pages/<id>.json in R2
//   GET /<id>/og.png   the page's OG image (pages/<id>.png in R2)
//
// Write API (Authorization: Bearer $SHARE_TOKEN — the desktop app only):
//   GET    /api/pages            list shared pages (id, title, updatedAt)
//   GET    /api/pages/<id>       page metadata (existence check)
//   PUT    /api/pages/<id>       body {title, markdown} — create/update
//   PUT    /api/pages/<id>/og    body image/png — set the OG image
//   DELETE /api/pages/<id>       stop sharing (removes page + OG image)

import { marked } from "../vendor/marked.esm.js";

const ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const RESERVED = new Set(["api", "robots.txt", "favicon.ico"]);
const MAX_MARKDOWN_BYTES = 4 * 1024 * 1024;
const MAX_OG_BYTES = 2 * 1024 * 1024;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": "authorization,content-type",
  "access-control-max-age": "86400",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api" || path.startsWith("/api/")) {
      return handleApi(request, env, url);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", { status: 405 });
    }
    if (path === "/") return landingPage(env, url);
    if (path === "/robots.txt") {
      return new Response("User-agent: *\nAllow: /\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    if (path === "/favicon.ico") return new Response(null, { status: 204 });

    const ogMatch = path.match(/^\/([a-z0-9-]{1,64})\/og\.png$/);
    if (ogMatch && validId(ogMatch[1])) return serveOgImage(env, ogMatch[1]);

    const pageMatch = path.match(/^\/([a-z0-9-]{1,64})$/);
    if (pageMatch && validId(pageMatch[1])) {
      return servePage(env, pageMatch[1], url);
    }
    return notFoundPage();
  },
};

function validId(id) {
  return ID_RE.test(id) && !RESERVED.has(id);
}

/* ---------- Write API ---------- */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

async function handleApi(request, env, url) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  const auth = request.headers.get("authorization") || "";
  if (!env.SHARE_TOKEN || auth !== `Bearer ${env.SHARE_TOKEN}`) {
    return json({ error: "unauthorized" }, 401);
  }

  const parts = url.pathname.split("/").filter(Boolean); // ["api", "pages", id?, "og"?]
  if (parts[1] !== "pages") return json({ error: "not found" }, 404);

  if (parts.length === 2) {
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
    return listPages(env);
  }

  const id = parts[2];
  if (!validId(id)) return json({ error: "invalid id" }, 400);
  const pageKey = `pages/${id}.json`;
  const ogKey = `pages/${id}.png`;

  if (parts.length === 3) {
    if (request.method === "GET") {
      const obj = await env.PAGES.get(pageKey);
      if (!obj) return json({ error: "not found" }, 404);
      const data = await obj.json();
      return json({
        id,
        title: data.title ?? "Untitled",
        createdAt: data.createdAt ?? null,
        updatedAt: data.updatedAt ?? null,
      });
    }
    if (request.method === "PUT") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid json body" }, 400);
      }
      const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : "Untitled";
      const markdown = typeof body.markdown === "string" ? body.markdown : null;
      if (markdown === null) return json({ error: "markdown must be a string" }, 400);
      if (markdown.length > MAX_MARKDOWN_BYTES) return json({ error: "markdown too large" }, 413);

      const existing = await env.PAGES.get(pageKey);
      const prior = existing ? await existing.json().catch(() => null) : null;
      const now = new Date().toISOString();
      const record = {
        title,
        markdown,
        createdAt: prior?.createdAt ?? now,
        updatedAt: now,
      };
      await env.PAGES.put(pageKey, JSON.stringify(record), {
        httpMetadata: { contentType: "application/json" },
        customMetadata: {
          title: title.slice(0, 256),
          updatedAt: now,
          createdAt: record.createdAt,
        },
      });
      return json({ id, url: `${url.origin}/${id}`, createdAt: record.createdAt, updatedAt: now });
    }
    if (request.method === "DELETE") {
      await env.PAGES.delete([pageKey, ogKey]);
      return json({ id, deleted: true });
    }
    return json({ error: "method not allowed" }, 405);
  }

  if (parts.length === 4 && parts[3] === "og") {
    if (request.method !== "PUT") return json({ error: "method not allowed" }, 405);
    const buf = await request.arrayBuffer();
    if (buf.byteLength === 0) return json({ error: "empty body" }, 400);
    if (buf.byteLength > MAX_OG_BYTES) return json({ error: "image too large" }, 413);
    await env.PAGES.put(ogKey, buf, {
      httpMetadata: { contentType: "image/png" },
    });
    return json({ id, og: true });
  }

  return json({ error: "not found" }, 404);
}

async function listPages(env) {
  const pages = [];
  let cursor;
  do {
    const batch = await env.PAGES.list({
      prefix: "pages/",
      cursor,
      include: ["customMetadata"],
    });
    for (const obj of batch.objects) {
      const m = obj.key.match(/^pages\/([a-z0-9-]+)\.json$/);
      if (!m) continue;
      pages.push({
        id: m[1],
        title: obj.customMetadata?.title ?? "Untitled",
        createdAt: obj.customMetadata?.createdAt ?? null,
        updatedAt: obj.customMetadata?.updatedAt ?? obj.uploaded?.toISOString?.() ?? null,
      });
    }
    cursor = batch.truncated ? batch.cursor : undefined;
  } while (cursor);
  return json({ pages });
}

/* ---------- Public pages ---------- */

// Mirror of the app's clean-copy transform (criticMarkup.ts): drop CriticMarkup
// comments, unwrap highlights. The app already strips before pushing; this is
// defense in depth so editorial notes can never leak to a public page.
function stripComments(md) {
  return md
    .replace(/\{>>[\s\S]*?<<\}/g, "")
    .replace(/\{==([\s\S]*?)==\}/g, "$1");
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// First ~200 visible characters of the document, markdown syntax removed.
function deriveDescription(md) {
  const text = md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>#|-]/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

async function servePage(env, id, url) {
  const obj = await env.PAGES.get(`pages/${id}.json`);
  if (!obj) return notFoundPage();
  let data;
  try {
    data = await obj.json();
  } catch {
    return notFoundPage();
  }

  const title = data.title || "Untitled";
  const clean = stripComments(data.markdown || "");
  const body = marked.parse(clean, { gfm: true, breaks: false, async: false });
  const desc = deriveDescription(clean);
  const ogImage = await env.PAGES.head(`pages/${id}.png`);
  const pageUrl = `${url.origin}/${id}`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(desc)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="${escapeHtml(url.hostname)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(desc)}">
<meta property="og:url" content="${pageUrl}">
${ogImage ? `<meta property="og:image" content="${pageUrl}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${pageUrl}/og.png">` : `<meta name="twitter:card" content="summary">`}
<style>${PAGE_CSS}</style>
</head>
<body>
<main class="doc">
${body}
</main>
<footer>shared via <a href="/">${escapeHtml(url.hostname)}</a></footer>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
}

async function serveOgImage(env, id) {
  const obj = await env.PAGES.get(`pages/${id}.png`);
  if (!obj) return new Response("not found", { status: 404 });
  return new Response(obj.body, {
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=300",
      etag: obj.httpEtag,
    },
  });
}

/* ---------- Shell pages ---------- */

function shellPage(title, message, status = 200) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<main class="doc shell">
<h1>${escapeHtml(title)}</h1>
<p class="muted">${escapeHtml(message)}</p>
</main>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
  });
}

// The landing page answers two questions for anyone who lands on the domain
// root: what doklin.cc is (a person's own place for notes they publish from
// Doklin) and what Doklin is (a free, open-source Mac editor they can download,
// which then walks them through hosting a share domain of their own). Owner
// branding comes from the OWNER_NAME / OWNER_LINK env vars (wrangler.toml
// [vars]); without them the page stays generic. The "Download for macOS" button
// points at DOWNLOAD_URL, defaulting to the official GitHub release's stable
// latest-download alias (kept in sync by .github/workflows/release.yml); set
// DOWNLOAD_URL="" to hide it. OWNER_LINK (typically a LinkedIn profile) and the
// project's source on GitHub show as quiet links under the download button.
const DEFAULT_DOWNLOAD_URL =
  "https://github.com/boat-builder/doklin/releases/latest/download/Doklin-macos-universal.dmg";
const REPO_URL = "https://github.com/boat-builder/doklin";

function landingPage(env, url) {
  const host = url.hostname;
  const owner = typeof env.OWNER_NAME === "string" ? env.OWNER_NAME.trim() : "";
  const link = typeof env.OWNER_LINK === "string" ? env.OWNER_LINK.trim() : "";
  const isLinkedIn = /(^|\.)linkedin\.com\//i.test(link.replace(/^https?:\/\//, ""));
  // Unset -> official release; set (even to "") -> respected verbatim, so a
  // self-hoster can point elsewhere or blank it out.
  const downloadUrl = (env.DOWNLOAD_URL === undefined ? DEFAULT_DOWNLOAD_URL : String(env.DOWNLOAD_URL)).trim();

  const title = owner ? `${host} — notes shared by ${owner}` : `${host} — shared notes`;
  const desc = owner
    ? `Every page on ${host} is a note personally published by ${owner} from Doklin, an open-source Mac editor.`
    : `Every page on ${host} is a note published from Doklin, an open-source Mac markdown editor.`;
  const headline = owner ? `Notes shared by ${owner}` : `Notes shared on ${host}`;
  // The lead is the point of the page: whose domain this is and why a link here
  // is trustworthy. First person when we know the owner.
  const lead = owner
    ? `Every page on ${host} is a note I published myself, straight from Doklin — my own Mac editor. If a link here reached you, it came from me: a real person, not a spammer.`
    : `Every page on ${host} is a note published straight from Doklin, a personal Mac markdown editor.`;
  // Secondary: what the editor is. Kept neutral so it reads the same on any
  // self-hosted deployment. The "domain of your own" line is the only nod to
  // the share feature — deliberately light-touch; it isn't the app's headline.
  const about = `Doklin is a free, open-source markdown editor for macOS with on-device dictation. It's yours to download — and it'll walk you through publishing notes to a domain of your own, like this one.`;

  const appleIcon = `<svg class="landing-apple" viewBox="0 0 384 512" fill="currentColor" aria-hidden><path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z"/></svg>`;
  const linkedInIcon = `<svg class="landing-in" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M20.45 20.45h-3.55v-5.57c0-1.33-.03-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.36V9h3.41v1.56h.05c.47-.9 1.63-1.85 3.36-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12zM7.12 20.45H3.55V9h3.57v11.45z"/></svg>`;
  const githubIcon = `<svg class="landing-gh" viewBox="0 0 16 16" fill="currentColor" aria-hidden><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`;

  const downloadButton = downloadUrl
    ? `<a class="landing-btn" href="${escapeHtml(downloadUrl)}">${appleIcon}Download Doklin for macOS</a>
    <p class="landing-sub">Free · Universal — Apple Silicon &amp; Intel</p>`
    : "";

  // Quiet links under the CTA: the owner's profile (usually LinkedIn) and the
  // project source. GitHub is always shown — it's how "open source" gets said.
  const links = [];
  if (link) {
    const authorLabel = isLinkedIn
      ? owner ? `${owner} on LinkedIn` : "On LinkedIn"
      : owner ? `About ${owner}` : "About the author";
    links.push(`<a class="landing-link" href="${escapeHtml(link)}" rel="me noopener">${isLinkedIn ? linkedInIcon : ""}${escapeHtml(authorLabel)}</a>`);
  }
  links.push(`<a class="landing-link" href="${REPO_URL}" rel="noopener">${githubIcon}Source on GitHub</a>`);
  const linksRow = `<div class="landing-links">${links.join(`<span class="landing-link-sep" aria-hidden>·</span>`)}</div>`;

  const actions = `<div class="landing-actions">
    ${downloadButton}
    ${linksRow}
  </div>`;

  const footer = owner ? `© ${owner} · Doklin is open source` : `${host} · Doklin is open source`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(desc)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${escapeHtml(host)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(desc)}">
<meta property="og:url" content="${url.origin}/">
<style>${PAGE_CSS}${LANDING_CSS}</style>
</head>
<body>
<main class="landing">
  <div class="landing-mark"><span class="landing-dot" aria-hidden></span>${escapeHtml(host)}</div>
  <h1 class="landing-headline">${escapeHtml(headline)}</h1>
  <p class="landing-lead">${escapeHtml(lead)}</p>
  <hr class="landing-rule" aria-hidden>
  <p class="landing-about">${escapeHtml(about)}</p>
  ${actions}
  <footer class="landing-footer">${escapeHtml(footer)}</footer>
</main>
</body>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
  });
}

const LANDING_CSS = `
.landing {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 40px 24px 84px;
}
.landing-mark {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--muted);
}
.landing-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: rgba(255, 145, 0, 0.95);
  box-shadow: 0 0 0 4px rgba(255, 145, 0, 0.14);
}
.landing-headline {
  margin: 26px 0 0;
  font-size: clamp(30px, 5vw, 44px);
  line-height: 1.12;
  font-weight: 700;
  letter-spacing: -0.025em;
}
.landing-lead {
  max-width: 33rem;
  margin: 18px auto 0;
  font-size: 16.5px;
  line-height: 1.62;
  color: var(--text);
  opacity: 0.82;
}
.landing-rule {
  width: 44px;
  height: 1px;
  border: 0;
  margin: 30px 0 0;
  background: var(--border);
}
.landing-about {
  max-width: 30rem;
  margin: 26px auto 0;
  font-size: 14px;
  line-height: 1.6;
  color: var(--muted);
}
.landing-actions {
  margin-top: 30px;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.landing-btn {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  padding: 12px 22px;
  border-radius: 10px;
  background: var(--text);
  color: var(--bg);
  font-size: 15px;
  font-weight: 600;
  text-decoration: none;
  border: 1px solid var(--text);
  transition: opacity 0.12s, transform 0.12s;
}
.landing-btn:hover { opacity: 0.9; transform: translateY(-1px); }
.landing-sub {
  margin: 12px 0 0;
  font-size: 12.5px;
  color: var(--muted);
}
/* Quiet secondary links (owner profile + GitHub source), separated by a dot. */
.landing-links {
  margin-top: 22px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13.5px;
}
.landing-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  text-decoration: none;
  padding: 5px 7px;
  border-radius: 6px;
  transition: color 0.12s;
}
.landing-link:hover { color: var(--text); }
.landing-link-sep { color: var(--muted); opacity: 0.5; }
.landing-apple { width: 16px; height: 16px; margin-top: -2px; }
.landing-in, .landing-gh { width: 15px; height: 15px; }
.landing-footer {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 20px;
  font-size: 12px;
  color: var(--muted);
}
`;

function notFoundPage() {
  return shellPage("Nothing here", "This page doesn't exist or is no longer shared.", 404);
}

/* ---------- Reading-view CSS ----------
   Matches the Doklin desktop app's editor canvas (src/App.css): same font stack,
   type scale, and light/dark color tokens, so a shared page reads exactly like
   the document does in the app. */

const PAGE_CSS = `
:root {
  --bg: #ffffff;
  --text: #37352f;
  --muted: rgba(55, 53, 47, 0.5);
  --border: rgba(55, 53, 47, 0.09);
  --surface: #f7f6f3;
  --inline-code: #b45309;
  --link: #2383e2;
  --selection: rgba(35, 131, 226, 0.18);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #191919;
    --text: #ebebeb;
    --muted: rgba(255, 255, 255, 0.45);
    --border: rgba(255, 255, 255, 0.08);
    --surface: #1f1f1f;
    --inline-code: #f59e9e;
    --link: #529cca;
    --selection: rgba(255, 255, 255, 0.12);
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); }
body {
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Inter", "SF Pro Text", "Segoe UI", sans-serif;
  font-size: 16px;
  line-height: 1.6;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
}
::selection { background: var(--selection); }
main.doc {
  max-width: 1080px;
  margin: 0 auto;
  padding: 48px 64px 96px;
}
@media (max-width: 720px) {
  main.doc { padding: 32px 24px 72px; }
}
.doc h1, .doc h2, .doc h3, .doc h4, .doc h5, .doc h6 {
  font-family: inherit;
  font-weight: 700;
  letter-spacing: -0.01em;
  margin-bottom: 4px;
}
.doc h1 { font-size: 32px; line-height: 1.25; margin-top: 28px; }
.doc h2 { font-size: 24px; line-height: 1.3; margin-top: 24px; }
.doc h3 { font-size: 19px; line-height: 1.35; margin-top: 20px; }
.doc h4, .doc h5, .doc h6 { font-size: 16px; margin-top: 16px; }
.doc > :first-child { margin-top: 0; }
.doc p { font-size: 16px; line-height: 1.6; margin: 0; padding: 3px 0; }
.doc ul, .doc ol { margin: 4px 0; padding-left: 26px; }
.doc li { padding: 2px 0; }
.doc li > p { padding: 0; }
.doc blockquote {
  margin: 6px 0;
  padding: 2px 0 2px 14px;
  border-left: 3px solid var(--text);
}
.doc a { color: var(--link); text-decoration: none; }
.doc a:hover { text-decoration: underline; }
.doc code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 85%;
  padding: 0.15em 0.35em;
  border-radius: 4px;
  background: var(--surface);
  color: var(--inline-code);
}
.doc pre {
  margin: 8px 0;
  padding: 16px 20px;
  border-radius: 8px;
  background: var(--surface);
  overflow-x: auto;
}
.doc pre code {
  padding: 0;
  background: none;
  color: var(--text);
  font-size: 13.5px;
  line-height: 1.55;
}
.doc img { max-width: 100%; border-radius: 4px; }
.doc hr { border: none; border-top: 1px solid var(--border); margin: 20px 0; }
.doc table { border-collapse: collapse; margin: 8px 0; display: block; overflow-x: auto; }
.doc th, .doc td { border: 1px solid var(--border); padding: 6px 12px; text-align: left; }
.doc th { background: var(--surface); font-weight: 600; }
.doc input[type="checkbox"] { margin-right: 6px; }
.doc li:has(> input[type="checkbox"]) { list-style: none; margin-left: -20px; }
.shell { text-align: center; padding-top: 20vh; }
.muted { color: var(--muted); }
footer {
  max-width: 1080px;
  margin: 0 auto;
  padding: 24px 64px 48px;
  font-size: 12px;
  color: var(--muted);
  text-align: center;
}
footer a { color: var(--muted); }
`;
