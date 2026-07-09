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

// The landing page reads like Doklin's own product page, personalized to the
// deployment: the Doklin wordmark leads, and OWNER_NAME / OWNER_LINK (wrangler
// .toml [vars]) fill in whose domain this is. It answers two things for a
// visitor who followed a share link here: whose notes live on this domain, and
// what Doklin is (a free, open-source Mac editor, with a three-feature pitch +
// a download button). The editor is presented as a product the owner uses, not
// one they own. Without OWNER_NAME the page stays a generic Doklin page. The
// download button points at DOWNLOAD_URL, defaulting to the official GitHub
// release's stable latest-download alias (kept in sync by
// .github/workflows/release.yml); set DOWNLOAD_URL="" to hide it. OWNER_LINK
// (typically a LinkedIn profile) and the project source on GitHub show as quiet
// links under the button; GitHub is where "open source" gets said.
const DEFAULT_DOWNLOAD_URL =
  "https://github.com/boat-builder/doklin/releases/latest/download/Doklin-macos-arm64.dmg";
const REPO_URL = "https://github.com/boat-builder/doklin";

// Notion's mark (Google favicon service, embedded so the page stays fully
// self-contained and no visitor request leaks to Google). Black glyph on a
// transparent field; inverted to white in dark mode via .landing-logo.
const NOTION_LOGO =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAMAAAD04JH5AAAAZlBMVEX///8AAADS0tJQUFCampo/Pz9kZGSsrKyoqKj19fXd3d3x8fHZ2dnr6+ulpaXPz8+ysrIxMTHk5OS/v79paWlYWFi5ubl0dHQiIiKMjIyGhobIyMh8fHxGRkYWFhYsLCwODg44ODi+YdwDAAAD/0lEQVR4nO2abcOqIAyGM03T1HzNTLP6/3/y2FOaDEyGuD4c748J7AJsG7jNZtWqVatWrdKnQ+JX0T4M92lAZjPwticnvBT2tTGGOkeLmXxN06qz/GZ8U7PVZtJNvONrmrv7V5tAl3nTTKOwnJzmd50TNevOboZRVqGCefesOF3TLsrQSbfta1n2b+TVRQPE0ibvOzu7WM6p8hLOTNVPI0XaP321GedZbe2jyk8OUwOVXZ8MB2ALVzZqVxbrXI79GD6mW9/rIlpZnMxurFIB4DrP9kthv3WTO8YBGI4OgqRBD/fZfeTLM6KiGy5HAxjxzFfgpbQfr8ICGIaWeHLoHWuNBlBypV/GbCSCA3ADai9C0MbPtI3ZbQA12Wi2xwIYN4k/0CHxtq29sCyyfNfAEVgVWADD4HIbN/D8qk0Q2mhtX9Ghy0IDGOcySt8LmsuHqjHd8QCa9Z8CxH1gogGIc7u4WHsnbUNq8Hao2XIA98fLXpQeW3tTQ88HaB55JmGP020GQP5nb+tNZ2JfZKoDKOb32gAwGdUiAHKBfEEATcfMFeAXAG2m8EksqQASNlP45OPaAdrEZJs6Hvi1Bp0/+YwmAL/NTDJ7kHmx/VPYWfcWwMMrdFMF88y2Bk5UC8Be8JjZhFOR94sD0j8tAFfB4zM3SLgcgOgxn+g6ywEcvO0p4m7OYLRcEOBP3C3a7dcA0BQ9gMFmZj8AePwagD32/gLAGKarPwEYXqsRAYCT8uAYTwRQlGyzT9wjArBB489FHBlAxbY7kQPA7IAewGUb2uQAnalOKTkA9An0AAHbtCAH2Fhs2yM5wAZcVdID+GzjmhwAnoV8cgDQp6EHAMexkhxgk7Ptk4gaAHjkBzkA9Mg3cgBxlkYJEIj6UQJAj0wPAD0yPYDP96MF4G6nyAH4rkoAokohSQDugkwJIIOjyANAj6wGICpikQUAHlkNQPQSyAJAj6wGILgJHAEQfFlnPbIawIavHhs7nufWETxhPbIiQDIF4A4RY7Zmjlk/RQC4kyzAsQQ+F2zE8K5YFYC7kB4AcHAG/JLY/xfPsIpMHgAGlgEA9FM1X2nj3P52hv/IgAAIRgFi0y5qK3ROle8Fo2U+4gcIAOBVST9avVUvAHDFAGwe+gEMFICrHcDHAQzqETVVdDVIgEGaCR2uvNy+puoTquV793Un0hVl7xKnvVUXtjlWcoTg77rwX6VeOiSen0bIkqoYAeB1nR7Ht71nyZj1tLdTrD5GFnzznn++4Kfe7xJliPOErXhXXukRTdcTAgkPnUo6X+0SW+b9FJfsyyruqqtmVh8Jj73iCWZ1ORWnlRQJDT50TVAKochNs53gKxFJNE9w1apVq1at+rX+AZWnOuBOYxBWAAAAAElFTkSuQmCC";

// Five feature cards, shown as a compact strip under the lead. Text is generic
// so it reads the same on any deployment. The first card uses Notion's mark to
// make "Notion-style" land; the rest are stroke SVGs tinted with --accent.
const FEATURES = [
  {
    title: "Notion-style editor",
    desc: "on local, private files",
    icon: `<img class="landing-logo" src="${NOTION_LOGO}" alt="Notion" width="19" height="19">`,
  },
  {
    title: "Markdown for agents",
    desc: "HTML for humans",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden><path d="M8.5 8 4.5 12l4 4"/><path d="M15.5 8l4 4-4 4"/><line x1="13.5" y1="4.5" x2="10.5" y2="19.5"/></svg>`,
  },
  {
    title: "On-device AI",
    desc: "dictation, plus LLM polish",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden><path d="M12 3.2l1.7 4.6 4.6 1.7-4.6 1.7L12 15.8l-1.7-4.6L5.7 9.5l4.6-1.7z"/><path d="M18.6 14.6l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z"/></svg>`,
  },
  {
    title: "Files and workspaces",
    desc: "or a quick scratch note",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden><path d="M3 7.5a2 2 0 0 1 2-2h3.3a2 2 0 0 1 1.4.6l1 1a2 2 0 0 0 1.4.6H19a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`,
  },
  {
    title: "Instant sharing",
    desc: "any page, one public URL",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden><circle cx="12" cy="12" r="9"/><line x1="3" y1="12" x2="21" y2="12"/><path d="M12 3c2.5 2.5 3.8 5.7 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.7-3.8-9S9.5 5.5 12 3Z"/></svg>`,
  },
];

function landingPage(env, url) {
  const host = url.hostname;
  const owner = typeof env.OWNER_NAME === "string" ? env.OWNER_NAME.trim() : "";
  const link = typeof env.OWNER_LINK === "string" ? env.OWNER_LINK.trim() : "";
  const isLinkedIn = /(^|\.)linkedin\.com\//i.test(link.replace(/^https?:\/\//, ""));
  // Unset -> official release; set (even to "") -> respected verbatim, so a
  // self-hoster can point elsewhere or blank it out.
  const downloadUrl = (env.DOWNLOAD_URL === undefined ? DEFAULT_DOWNLOAD_URL : String(env.DOWNLOAD_URL)).trim();

  const title = owner ? `Notes by ${owner}, written in Doklin` : `Notes written in Doklin`;
  const desc = owner
    ? `${host} is where ${owner} publishes notes written in Doklin, a free, open-source markdown editor for macOS with on-device dictation.`
    : `${host} publishes notes written in Doklin, a free, open-source markdown editor for macOS with on-device dictation.`;
  // Lead is Doklin product copy. When there's an owner it opens with "Written
  // in Doklin", a phrase moved out of the headline so the name can end the
  // headline line and carry its profile badge cleanly. No domain, no name here,
  // so the only editable-looking parts of the page are the headline name and
  // the footer. (headline is built as HTML below, since the name is a link.)
  const lead = owner
    ? `Written in Doklin, a free and open-source markdown editor for macOS. It keeps your writing on your machine, and it's yours to download too.`
    : `Doklin is a free and open-source markdown editor for macOS. It keeps your writing on your machine, and it's yours to download too.`;

  const appleIcon = `<svg class="landing-apple" viewBox="0 0 384 512" fill="currentColor" aria-hidden><path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z"/></svg>`;
  const githubIcon = `<svg class="landing-gh" viewBox="0 0 16 16" fill="currentColor" aria-hidden><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`;

  // The owner's name in the headline is the profile link (the only place it
  // lives now). The name ends the headline line, so the link mark trails it in
  // its own small tile. An enclosed badge reads as a "link" button, not as the
  // word "in" sitting inside the sentence. LinkedIn glyph, or a generic
  // external-link glyph if OWNER_LINK is not a LinkedIn URL.
  const nameBadge = isLinkedIn
    ? `<svg viewBox="3.2 3.1 17.6 17.6" fill="currentColor" aria-hidden><path d="M20.45 20.45h-3.55v-5.57c0-1.33-.03-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.36V9h3.41v1.56h.05c.47-.9 1.63-1.85 3.36-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12zM7.12 20.45H3.55V9h3.57v11.45z"/></svg>`
    : `<svg viewBox="4 4 16 16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden><path d="M8 5h11v11"/><path d="M19 5 5 19"/></svg>`;
  const nameHtml =
    owner && link
      ? `<a class="landing-name" href="${escapeHtml(link)}" rel="me noopener"><span class="landing-name-text">${escapeHtml(owner)}</span><span class="landing-name-badge">${nameBadge}</span></a>`
      : owner
        ? escapeHtml(owner)
        : "";
  const headlineHtml = owner ? `Notes by ${nameHtml}` : `Notes written in Doklin`;

  const featureCards = FEATURES.map(
    (f) => `<div class="landing-feature">
      <span class="landing-feature-icon">${f.icon}</span>
      <div class="landing-feature-text">
        <div class="landing-feature-title">${escapeHtml(f.title)}</div>
        <div class="landing-feature-desc">${escapeHtml(f.desc)}</div>
      </div>
    </div>`
  ).join("\n    ");

  const downloadButton = downloadUrl
    ? `<a class="landing-btn" href="${escapeHtml(downloadUrl)}">${appleIcon}Download for macOS</a>
    <p class="landing-sub">Free · For Apple silicon Macs</p>`
    : "";

  // One quiet link under the CTA: the project source. Fixed Doklin chrome, not
  // owner-specific; it's where "open source" gets said. The profile link now
  // lives on the name in the headline.
  const linksRow = `<div class="landing-links"><a class="landing-link" href="${REPO_URL}" rel="noopener">${githubIcon}Source on GitHub</a></div>`;

  const footer = owner ? `${host} · notes by ${owner}` : host;

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
  <div class="landing-mark"><span class="landing-dot" aria-hidden></span>Doklin</div>
  <h1 class="landing-headline">${headlineHtml}</h1>
  <p class="landing-lead">${escapeHtml(lead)}</p>
  <div class="landing-features">
    ${featureCards}
  </div>
  <div class="landing-actions">
    ${downloadButton}
    ${linksRow}
  </div>
  <footer class="landing-footer">${escapeHtml(footer)}</footer>
</main>
</body>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
  });
}

const LANDING_CSS = `
:root { --accent: rgba(224, 122, 0, 0.95); }
@media (prefers-color-scheme: dark) { :root { --accent: rgba(255, 160, 40, 0.98); } }
.landing {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 36px 24px 72px;
}
.landing-mark {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--text);
}
.landing-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 4px rgba(224, 122, 0, 0.14);
}
.landing-headline {
  margin: 20px 0 0;
  max-width: 20ch;
  font-size: clamp(27px, 4.4vw, 41px);
  line-height: 1.14;
  font-weight: 700;
  letter-spacing: -0.025em;
}
/* The owner name in the headline links to their profile, marked by a small
   badge glyph that reads as "this links out" without spelling out LinkedIn. */
.landing-name {
  color: inherit;
  text-decoration: none;
  white-space: nowrap;
}
.landing-name:hover .landing-name-text { text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: 3px; }
/* Profile link mark: a small enclosed tile (echoing the feature icons) that
   trails the name, so it reads as a link button rather than the word "in". */
.landing-name-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1em;
  height: 1em;
  margin-left: 0.34em;
  vertical-align: 0.05em;
  border-radius: 6px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--muted);
  transition: color 0.12s, border-color 0.12s;
}
.landing-name-badge svg { width: 0.6em; height: 0.6em; }
.landing-name:hover .landing-name-badge { color: var(--accent); border-color: var(--accent); }
.landing-lead {
  max-width: 34rem;
  margin: 15px auto 0;
  font-size: 15.5px;
  line-height: 1.58;
  color: var(--muted);
}
.landing-features {
  margin: 30px auto 0;
  display: flex;
  gap: 14px;
  width: 100%;
  max-width: 56rem;
  justify-content: center;
}
.landing-feature {
  flex: 1 1 0;
  min-width: 0;
  max-width: 10.5rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 9px;
}
.landing-feature-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: 11px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--accent);
}
.landing-feature-icon svg { width: 19px; height: 19px; }
.landing-logo { width: 19px; height: 19px; display: block; }
@media (prefers-color-scheme: dark) { .landing-logo { filter: invert(1); } }
.landing-feature-title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.landing-feature-desc {
  margin-top: 2px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--muted);
}
.landing-actions {
  margin-top: 32px;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.landing-btn {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  padding: 12px 24px;
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
  margin: 11px 0 0;
  font-size: 12.5px;
  color: var(--muted);
}
/* Quiet secondary links (owner profile + GitHub source), separated by a dot. */
.landing-links {
  margin-top: 18px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
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
.landing-apple { width: 16px; height: 16px; margin-top: -2px; }
.landing-in, .landing-gh { width: 15px; height: 15px; }
.landing-footer {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 16px;
  font-size: 12px;
  color: var(--muted);
}
@media (max-width: 720px) {
  .landing-features { flex-direction: column; align-items: center; gap: 14px; max-width: 22rem; }
  .landing-feature { flex-direction: row; align-items: center; text-align: left; max-width: 22rem; gap: 13px; width: 100%; }
  .landing-feature-desc { margin-top: 2px; }
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
