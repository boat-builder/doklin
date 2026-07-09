// Doklin share worker — serves public share pages from an R2 bucket.
//
// Optional env vars (wrangler.toml [vars]): OWNER_NAME / OWNER_LINK brand the
// root landing page; when unset it stays generic.
//
// Public surface (no auth):
//   GET /<id>          rendered read-only page for pages/<id>.json in R2.
//                      A page can carry a markdown document, an html rendition,
//                      or both; with both, a pill on the page lets the reader
//                      switch (?v=html selects the html rendition).
//   GET /<id>?v=html   the html rendition, framed (sandboxed iframe -> /raw)
//   GET /<id>/raw      the raw html rendition document
//   GET /<id>/og.png   the page's OG image (pages/<id>.png in R2)
//
// Write API (Authorization: Bearer $SHARE_TOKEN — the desktop app only):
//   GET    /api/pages            list shared pages (id, title, updatedAt)
//   GET    /api/pages/<id>       page metadata (existence check)
//   PUT    /api/pages/<id>       body {title, markdown?, html?} — create/update
//                                (at least one of markdown/html required)
//   PUT    /api/pages/<id>/og    body image/png — set the OG image
//   DELETE /api/pages/<id>       stop sharing (removes page + OG image)

import { marked } from "../vendor/marked.esm.js";

const ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const RESERVED = new Set(["api", "robots.txt", "favicon.ico"]);
const MAX_MARKDOWN_BYTES = 4 * 1024 * 1024;
const MAX_HTML_BYTES = 8 * 1024 * 1024;
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

    const rawMatch = path.match(/^\/([a-z0-9-]{1,64})\/raw$/);
    if (rawMatch && validId(rawMatch[1])) return serveRawHtml(env, rawMatch[1]);

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
      // A page carries a markdown document, an html rendition, or both. The
      // app sends the full record every push (html read fresh from disk), so a
      // missing field means that version no longer exists — not "keep prior".
      const markdown = typeof body.markdown === "string" ? body.markdown : null;
      const html = typeof body.html === "string" && body.html.length > 0 ? body.html : null;
      if (markdown === null && html === null) {
        return json({ error: "markdown or html must be a string" }, 400);
      }
      if (markdown !== null && markdown.length > MAX_MARKDOWN_BYTES) {
        return json({ error: "markdown too large" }, 413);
      }
      if (html !== null && html.length > MAX_HTML_BYTES) {
        return json({ error: "html too large" }, 413);
      }

      const existing = await env.PAGES.get(pageKey);
      const prior = existing ? await existing.json().catch(() => null) : null;
      const now = new Date().toISOString();
      const record = {
        title,
        ...(markdown !== null ? { markdown } : {}),
        ...(html !== null ? { html } : {}),
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

// First ~200 visible characters of an html rendition (tags stripped), used for
// the description when a page has no markdown to derive it from.
function deriveDescriptionFromHtml(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
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

  const hasMd = typeof data.markdown === "string";
  const hasHtml = typeof data.html === "string" && data.html.length > 0;
  if (!hasMd && !hasHtml) return notFoundPage();

  const title = data.title || "Untitled";
  const clean = hasMd ? stripComments(data.markdown) : "";
  const desc = hasMd ? deriveDescription(clean) : deriveDescriptionFromHtml(data.html);
  const ogImage = await env.PAGES.head(`pages/${id}.png`);
  const pageUrl = `${url.origin}/${id}`;

  const head = `<meta charset="utf-8">
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
<meta name="twitter:image" content="${pageUrl}/og.png">` : `<meta name="twitter:card" content="summary">`}`;

  // With both versions present, the reader picks: a fixed pill toggles between
  // the markdown page (/<id>) and the html rendition (/<id>?v=html).
  const pill = (active) =>
    hasMd && hasHtml
      ? `<nav class="view-pill" aria-label="Document version">
<a class="view-seg ${active === "md" ? "is-active" : ""}" href="${pageUrl}">MD</a>
<a class="view-seg ${active === "html" ? "is-active" : ""}" href="${pageUrl}?v=html">HTML</a>
</nav>`
      : "";

  const wantHtml = url.searchParams.get("v") === "html";
  if (hasHtml && (wantHtml || !hasMd)) {
    // The rendition is an arbitrary standalone document; framing it (instead of
    // serving it at /<id> directly) keeps our meta tags, the toggle, and the
    // sandbox — its scripts run under an opaque origin.
    const html = `<!doctype html>
<html lang="en">
<head>
${head}
<style>${PAGE_CSS}${FRAME_CSS}</style>
</head>
<body>
${pill("html")}
<iframe class="raw-frame" src="${pageUrl}/raw" sandbox="allow-scripts allow-popups" title="${escapeHtml(title)}"></iframe>
</body>
</html>`;
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
    });
  }

  const body = marked.parse(clean, { gfm: true, breaks: false, async: false });
  const html = `<!doctype html>
<html lang="en">
<head>
${head}
<style>${PAGE_CSS}</style>
</head>
<body>
${pill("md")}
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

// The html rendition, verbatim. Loaded by the ?v=html page's sandboxed iframe;
// direct hits are fine too — the content is public either way.
async function serveRawHtml(env, id) {
  const obj = await env.PAGES.get(`pages/${id}.json`);
  if (!obj) return new Response("not found", { status: 404 });
  let data;
  try {
    data = await obj.json();
  } catch {
    return new Response("not found", { status: 404 });
  }
  if (typeof data.html !== "string" || data.html.length === 0) {
    return new Response("not found", { status: 404 });
  }
  return new Response(data.html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
      "x-robots-tag": "noindex",
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

// The landing page exists to vouch for the domain: anyone handed a share link
// can check the root and see who's behind it — and grab the app themselves.
// Branding comes from the OWNER_NAME / OWNER_LINK env vars (wrangler.toml
// [vars]); without them it stays generic. The "Download for macOS" button
// points at DOWNLOAD_URL, defaulting to the official GitHub release's stable
// latest-download alias (kept in sync by .github/workflows/release.yml). Set
// DOWNLOAD_URL="" to hide the button entirely.
const DEFAULT_DOWNLOAD_URL =
  "https://github.com/boat-builder/doklin/releases/latest/download/Doklin-macos-universal.dmg";

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
    ? `Every page on this domain is a note personally published by ${owner}, written in Doklin.`
    : `Every page on this domain is a note published from Doklin, a personal markdown editor.`;
  const headline = owner ? `Notes shared by ${owner}` : `Notes shared on ${host}`;
  const copy = owner
    ? `Every page on this domain is a note I published myself, straight from Doklin — my own markdown editor. If someone sent you a ${host} link, it came from me — a real person, not a spammer.`
    : `Every page on this domain is a note published straight from Doklin, a personal markdown editor.`;

  const appleIcon = `<svg class="landing-apple" viewBox="0 0 384 512" fill="currentColor" aria-hidden><path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z"/></svg>`;
  const linkedInIcon = `<svg class="landing-in" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M20.45 20.45h-3.55v-5.57c0-1.33-.03-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.36V9h3.41v1.56h.05c.47-.9 1.63-1.85 3.36-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12zM7.12 20.45H3.55V9h3.57v11.45z"/></svg>`;

  const downloadButton = downloadUrl
    ? `<a class="landing-btn" href="${escapeHtml(downloadUrl)}">${appleIcon}Download Doklin for macOS</a>
  <p class="landing-sub">Free · Universal (Apple Silicon &amp; Intel)</p>`
    : "";
  const authorButton = link
    ? `<a class="landing-btn landing-btn-ghost" href="${escapeHtml(link)}" rel="me noopener">
    ${isLinkedIn ? linkedInIcon : ""}${escapeHtml(owner ? (isLinkedIn ? `${owner} on LinkedIn` : `About ${owner}`) : "About the author")}
  </a>`
    : "";
  const actions = downloadButton || authorButton
    ? `<div class="landing-actions">
    ${downloadButton}
    ${authorButton}
  </div>`
    : "";

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
  <p class="landing-copy">${escapeHtml(copy)}</p>
  ${actions}
  <footer class="landing-footer">${escapeHtml(owner ? `© ${owner}` : host)}</footer>
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
  padding: 24px;
}
.landing-mark {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--muted);
}
.landing-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: rgba(255, 145, 0, 0.9);
}
.landing-headline {
  margin: 20px 0 0;
  font-size: clamp(30px, 5.5vw, 46px);
  line-height: 1.15;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.landing-copy {
  max-width: 540px;
  margin: 16px auto 0;
  font-size: 16px;
  line-height: 1.65;
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
  border-radius: 9px;
  background: var(--text);
  color: var(--bg);
  font-size: 15px;
  font-weight: 600;
  text-decoration: none;
  border: 1px solid var(--text);
  transition: opacity 0.12s;
}
.landing-btn:hover { opacity: 0.88; }
/* Secondary action (author link): outlined, quieter than the download CTA. */
.landing-btn-ghost {
  margin-top: 14px;
  padding: 9px 18px;
  background: transparent;
  color: var(--muted);
  border: 1px solid var(--border);
  font-size: 14px;
}
.landing-btn-ghost:hover { opacity: 1; color: var(--text); }
.landing-sub {
  margin: 12px 0 0;
  font-size: 12.5px;
  color: var(--muted);
}
.landing-apple { width: 16px; height: 16px; margin-top: -2px; }
.landing-in { width: 15px; height: 15px; }
.landing-footer {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 22px;
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
/* MD/HTML version pill (only rendered when a page has both versions). */
.view-pill {
  position: fixed;
  top: 14px;
  right: 14px;
  z-index: 10;
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--bg) 78%, transparent);
  border: 1px solid var(--border);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}
.view-seg {
  padding: 3px 10px;
  border-radius: 6px;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--muted);
  text-decoration: none;
}
.view-seg:hover { color: var(--text); }
.view-seg.is-active {
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 0 0 1px var(--border);
}
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

/* The ?v=html page: the rendition owns the whole viewport; only the version
   pill floats above it. */
const FRAME_CSS = `
html, body { height: 100%; overflow: hidden; }
.raw-frame {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  border: 0;
  background: #ffffff;
}
`;
