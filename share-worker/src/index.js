// Doklin share worker — serves public share pages from an R2 bucket.
//
// The root of the domain serves a landing page. Its branding lives in the
// app-managed site config (site.json in R2, written via PUT /api/site). When
// the site config names a rootPageId, that shared page IS the root —
// replacing the landing page entirely.
//
// Public surface (no auth):
//   GET /              landing page (or the rootPageId page from site.json)
//   GET /<id>          rendered read-only page for pages/<id>.json in R2.
//                      A page can carry a markdown document, an html rendition,
//                      or both; with both, the html rendition (the polished,
//                      human-facing one) is what the link opens on, and a pill
//                      on the page lets the reader switch (?v=md selects the
//                      markdown document). A page stored with kind:"collection"
//                      is a folder/workspace share instead: it renders as a
//                      table-of-contents home page linking to its member pages,
//                      and each member page shows a "back to the folder" crumb.
//   GET /<id>?v=md     the markdown document (when the page also has html)
//   GET /<id>/raw      the raw html rendition document
//   GET /<id>/og.png   the page's OG image (pages/<id>.png in R2)
//
// Write API (Authorization: Bearer $SHARE_TOKEN — the desktop app only):
//   GET    /api/meta             worker version + feature list, so the app can
//                                tell an outdated deployment from a broken one
//   GET    /api/site             the site config (landing branding + root page)
//   PUT    /api/site             body {ownerName?, ownerLink?, downloadUrl?,
//                                rootPageId?} — full record every time, like
//                                page pushes (a missing field means unset)
//   GET    /api/pages            list shared pages (id, title, updatedAt)
//   GET    /api/pages/<id>       page metadata (existence check)
//   PUT    /api/pages/<id>       body {title, markdown?, html?, collection?}
//                                — create/update a page (at least one of
//                                markdown/html required; collection {id,title}
//                                back-references the folder share it's in) —
//                                or body {title, kind:"collection", items,
//                                description?} to create/update a folder share
//                                (items are {id, title, path} member
//                                references; description shows under the
//                                public TOC's title)
//   PUT    /api/pages/<id>/og    body image/png — set the OG image
//   DELETE /api/pages/<id>       stop sharing (removes page + OG image)
//
// Sync + auth (version 4): the same worker doubles as a private cloud-sync
// backend. Private workspace files live under sync/<ws>/ and are reachable
// only through the token-gated API — the public surface above never serves
// them. Tokens come in two roles: the owner (SHARE_TOKEN, or a linked-device
// token minted from it) and members (invited people; scoped to a workspace
// allowlist, and to their own published pages). See README for the contract.
//
//   GET  /join                   public invite landing page (the invite code
//                                travels in the URL #fragment — never logged)
//   POST /api/auth/join          exchange a one-time invite code for a token
//   POST /api/auth/invites       mint an invite (owner)
//   GET/DELETE /api/auth/invites[/<id>]   list / cancel invites (owner)
//   GET/DELETE /api/auth/tokens[/<id>]    list / revoke tokens (owner)
//   GET  /api/auth/whoami        the calling token's identity + scope
//   GET/POST /api/sync/workspaces         list / create workspaces
//   DELETE /api/sync/workspaces/<ws>      delete a workspace + its objects
//   GET  /api/sync/<ws>/poll     {manifestEtag, presence} — the cheap poll
//   GET/PUT /api/sync/<ws>/manifest       the workspace manifest, CAS'd by
//                                         etag (PUT sends x-base-etag; a lost
//                                         race returns 412 + current etag)
//   GET/PUT/DELETE /api/sync/<ws>/files/<fileId>/<hash>   content-addressed,
//                                         immutable file blobs (hash names
//                                         the content, so revisions never
//                                         clobber each other)
//   GET  /api/sync/<ws>/files/<fileId>    list a file's stored blobs (for GC)
//   GET/PUT /api/sync/<ws>/history/<fileId>   deep revision archive (entries
//                                         rolled out of the manifest's tail)
//   PUT  /api/sync/<ws>/presence          heartbeat "this device is editing
//                                         <fileId>" (TTL'd, best-effort)

import { marked } from "../vendor/marked.esm.js";

// Bumped when the API grows; GET /api/meta reports it. 1 = pages+collections
// (never had /api/meta, so the app infers it from a 404), 2 = site config +
// root page override, 3 = collection descriptions, 4 = cloud sync + member
// tokens.
const WORKER_VERSION = 4;
const WORKER_FEATURES = [
  "pages",
  "collections",
  "site",
  "root-page",
  "collection-description",
  "sync",
  "auth",
];

const ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const RESERVED = new Set(["api", "join", "robots.txt", "favicon.ico"]);
// Landing branding + root page, app-managed. Lives outside the pages/ prefix
// so listings never see it.
const SITE_KEY = "site.json";
const MAX_MARKDOWN_BYTES = 4 * 1024 * 1024;
const MAX_HTML_BYTES = 8 * 1024 * 1024;
const MAX_OG_BYTES = 2 * 1024 * 1024;
const MAX_COLLECTION_ITEMS = 1000;
const MAX_COLLECTION_DESCRIPTION = 500;
// A folder share's TOC adapts to its size: up to this many pages it renders
// as a flat list of cards (a small share is usually THE deliverable — a
// handful of documents handed to stakeholders — and a three-row tree reads
// as sparse, not curated); past it, the compact collapsible tree takes over.
const TOC_CARDS_MAX = 8;
const MAX_SITE_TEXT = 120;
const MAX_SITE_URL = 512;

/* Sync + auth limits. File paths mirror the app's own workspace caps
   (MAX_TREE_DEPTH / MAX_TREE_ENTRIES in src-tauri), so the worker never
   accepts a workspace the app couldn't hold. */
const SYNC_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/; // workspace + file ids
const BLOB_HASH_RE = /^[a-f0-9]{16,64}$/; // content-address fragment
const MAX_SYNC_FILE_BYTES = 25 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_FILES = 5000;
const MAX_SYNC_PATH_LEN = 1024;
const MAX_SYNC_PATH_DEPTH = 12;
const MAX_HISTORY_BYTES = 256 * 1024;
// Listing workspaces reads one small object per workspace in a single
// request, and the free plan allows 50 subrequests per invocation — 30 keeps
// comfortable margin. Way beyond a personal backend's realistic count anyway.
const MAX_WORKSPACES = 30;
const MAX_TOKENS = 100;
const MAX_INVITES = 50;
// A single invite can grant at most this many workspaces — keeps the scope
// small enough to ride in R2 customMetadata (values are strings, ~2KB total).
const MAX_INVITE_WORKSPACES = 10;
const MAX_NAME_LEN = 80;
const PRESENCE_TTL_MS = 90_000;
const INVITE_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INVITE_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const JOIN_RATE_LIMIT = 10; // joins per IP per minute (per isolate, best effort)
const TOKENS_PREFIX = "auth/tokens/";
const INVITES_PREFIX = "auth/invites/";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,PUT,POST,DELETE,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,x-base-etag",
  "access-control-expose-headers": "x-manifest-etag",
  "access-control-max-age": "86400",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api" || path.startsWith("/api/")) {
      return handleApi(request, env, url, ctx);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", { status: 405 });
    }
    if (path === "/") return serveRoot(env, url);
    if (path === "/join") return joinPage(env, url);
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

// A manifest item's path is relative to the shared folder: forward slashes,
// no leading/trailing slash, no traversal, sane length. Only used to group
// the TOC — the link target is always the item's page id.
function validItemPath(p) {
  if (typeof p !== "string" || p.length === 0 || p.length > 512) return false;
  return p.split("/").every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}

/* ---------- Write API ---------- */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

async function handleApi(request, env, url, ctx) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const parts = url.pathname.split("/").filter(Boolean); // ["api", "pages", id?, "og"?]

  // The one unauthenticated API route: the invite code in the body IS the
  // credential. Everything else requires a bearer token.
  if (parts[1] === "auth" && parts[2] === "join" && parts.length === 3) {
    return handleJoin(request, env, url);
  }

  const auth = await authenticate(request, env);
  if (!auth) return json({ error: "unauthorized" }, 401);

  // Version probe: lets the app distinguish "this worker predates feature X"
  // (404 here) from "the endpoint is broken", and prompt a redeploy.
  if (parts[1] === "meta") {
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
    return json({ version: WORKER_VERSION, features: WORKER_FEATURES });
  }

  if (parts[1] === "auth") return handleAuthApi(request, env, url, parts, auth);
  if (parts[1] === "sync") return handleSyncApi(request, env, url, parts, auth, ctx);

  // Site config shapes the public landing page (and the root-page override) —
  // that's the owner's voice, not a member's.
  if (parts[1] === "site" && parts.length === 2 && auth.role !== "owner") {
    return json({ error: "owner only" }, 403);
  }

  if (parts[1] === "site" && parts.length === 2) {
    if (request.method === "GET") {
      return json({ site: await readSiteConfig(env) });
    }
    if (request.method === "PUT") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid json body" }, 400);
      }
      const site = {};
      if (typeof body.ownerName === "string" && body.ownerName.trim()) {
        site.ownerName = body.ownerName.trim().slice(0, MAX_SITE_TEXT);
      }
      if (typeof body.ownerLink === "string" && body.ownerLink.trim()) {
        const link = body.ownerLink.trim();
        if (!/^https?:\/\/\S+$/.test(link) || link.length > MAX_SITE_URL) {
          return json({ error: "ownerLink must be an http(s) url" }, 400);
        }
        site.ownerLink = link;
      }
      // downloadUrl keeps the env var's three-way semantics: absent = official
      // release, "" = hide the button, a url = use it verbatim.
      if (typeof body.downloadUrl === "string") {
        const dl = body.downloadUrl.trim();
        if (dl && (!/^https?:\/\/\S+$/.test(dl) || dl.length > MAX_SITE_URL)) {
          return json({ error: "downloadUrl must be an http(s) url or empty" }, 400);
        }
        site.downloadUrl = dl;
      }
      if (body.rootPageId !== undefined && body.rootPageId !== null) {
        if (typeof body.rootPageId !== "string" || !validId(body.rootPageId)) {
          return json({ error: "invalid rootPageId" }, 400);
        }
        site.rootPageId = body.rootPageId;
      }
      site.updatedAt = new Date().toISOString();
      await env.PAGES.put(SITE_KEY, JSON.stringify(site), {
        httpMetadata: { contentType: "application/json" },
      });
      return json({ site });
    }
    return json({ error: "method not allowed" }, 405);
  }

  if (parts[1] !== "pages") return json({ error: "not found" }, 404);

  if (parts.length === 2) {
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
    return listPages(env, auth);
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
      // A collection is a folder/workspace share: no document of its own, just
      // a manifest of member pages (each an ordinary page in this bucket). The
      // public side renders it as a table-of-contents home page. The manifest
      // is the full membership every push — a missing item means "no longer
      // included", not "keep prior".
      if (body.kind === "collection") {
        const rawItems = Array.isArray(body.items) ? body.items : null;
        if (!rawItems) return json({ error: "items must be an array" }, 400);
        if (rawItems.length > MAX_COLLECTION_ITEMS) {
          return json({ error: "too many items" }, 413);
        }
        const items = [];
        for (const it of rawItems) {
          if (!it || typeof it !== "object") return json({ error: "invalid item" }, 400);
          if (typeof it.id !== "string" || !validId(it.id)) {
            return json({ error: "invalid item id" }, 400);
          }
          if (!validItemPath(it.path)) return json({ error: "invalid item path" }, 400);
          const itemTitle =
            typeof it.title === "string" && it.title.trim()
              ? it.title.trim().slice(0, 256)
              : "Untitled";
          items.push({ id: it.id, title: itemTitle, path: it.path });
        }
        // Owner-written blurb under the public TOC's title. Sent (or omitted)
        // every push like everything else: absent means "no description".
        const description =
          typeof body.description === "string" && body.description.trim()
            ? body.description.trim().slice(0, MAX_COLLECTION_DESCRIPTION)
            : null;
        const existing = await env.PAGES.get(pageKey);
        if (!canTouchPage(auth, existing)) {
          return json({ error: "page belongs to another member" }, 403);
        }
        const prior = existing ? await existing.json().catch(() => null) : null;
        const now = new Date().toISOString();
        const record = {
          kind: "collection",
          title,
          ...(description ? { description } : {}),
          items,
          createdAt: prior?.createdAt ?? now,
          updatedAt: now,
        };
        await env.PAGES.put(pageKey, JSON.stringify(record), {
          httpMetadata: { contentType: "application/json" },
          customMetadata: {
            title: title.slice(0, 256),
            kind: "collection",
            updatedAt: now,
            createdAt: record.createdAt,
            owner: pageOwner(auth, existing),
          },
        });
        return json({
          id,
          url: `${url.origin}/${id}`,
          createdAt: record.createdAt,
          updatedAt: now,
        });
      }
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
      // A member of a folder share carries a back-reference so its public page
      // can show a "back to the folder" crumb. Sent (or omitted) on every push,
      // like the renditions: absent means "not in a folder share".
      let collection = null;
      if (
        body.collection &&
        typeof body.collection === "object" &&
        typeof body.collection.id === "string" &&
        validId(body.collection.id)
      ) {
        collection = {
          id: body.collection.id,
          title:
            typeof body.collection.title === "string" && body.collection.title.trim()
              ? body.collection.title.trim().slice(0, 256)
              : "Untitled",
        };
      }

      const existing = await env.PAGES.get(pageKey);
      if (!canTouchPage(auth, existing)) {
        return json({ error: "page belongs to another member" }, 403);
      }
      const prior = existing ? await existing.json().catch(() => null) : null;
      const now = new Date().toISOString();
      const record = {
        title,
        ...(markdown !== null ? { markdown } : {}),
        ...(html !== null ? { html } : {}),
        ...(collection ? { collection } : {}),
        createdAt: prior?.createdAt ?? now,
        updatedAt: now,
      };
      await env.PAGES.put(pageKey, JSON.stringify(record), {
        httpMetadata: { contentType: "application/json" },
        customMetadata: {
          title: title.slice(0, 256),
          updatedAt: now,
          createdAt: record.createdAt,
          owner: pageOwner(auth, existing),
        },
      });
      return json({ id, url: `${url.origin}/${id}`, createdAt: record.createdAt, updatedAt: now });
    }
    if (request.method === "DELETE") {
      if (auth.role !== "owner") {
        const existing = await env.PAGES.get(pageKey);
        if (!canTouchPage(auth, existing)) {
          return json({ error: "page belongs to another member" }, 403);
        }
      }
      await env.PAGES.delete([pageKey, ogKey]);
      return json({ id, deleted: true });
    }
    return json({ error: "method not allowed" }, 405);
  }

  if (parts.length === 4 && parts[3] === "og") {
    if (request.method !== "PUT") return json({ error: "method not allowed" }, 405);
    if (auth.role !== "owner") {
      const existing = await env.PAGES.get(pageKey);
      if (!canTouchPage(auth, existing)) {
        return json({ error: "page belongs to another member" }, 403);
      }
    }
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

async function listPages(env, auth) {
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
      // A member's view of the backend is their own pages; the full catalog
      // (including the owner's and other members') is the owner's to see.
      if (auth.role !== "owner" && obj.customMetadata?.owner !== auth.tokenId) continue;
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

/* ---------- Auth: tokens, invites, roles ----------

   No accounts. The owner's credential is the SHARE_TOKEN worker secret (as it
   always was); everyone else holds a minted token stored as one small R2
   object keyed by the token's SHA-256 (per-object storage means create and
   revoke never race each other, and the raw secret never touches the bucket).
   A token carries a role and a workspace allowlist:

     owner   SHARE_TOKEN itself, or a linked-device token. Everything.
     member  sync on the granted workspaces, plus publishing pages — but only
             its own pages, never the site config, tokens, or invites.

   Invites are one-time codes (auth/invites/<id>.json stores the code's hash +
   scope + expiry); redeeming one is CAS-guarded so a code can never mint two
   tokens. Names on tokens are labels for presence/history attribution — the
   invite itself is the trust decision. */

async function sha256Hex(input) {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* Credential objects are keyed by the SHA-256 of the credential itself
   (auth/tokens/<hash>.json), so resolving a bearer is ONE strongly-consistent
   R2 get — no registry to load, no cache to go stale, and revocation (delete
   the object) takes effect on the very next request in every isolate. The
   human-facing fields ride along as customMetadata so the owner's
   list/revoke UI works off a single list() call without reading bodies. */

const tokenObjectKey = (hash) => `${TOKENS_PREFIX}${hash}.json`;
const inviteObjectKey = (hash) => `${INVITES_PREFIX}${hash}.json`;

// customMetadata values must be strings (and small); the workspace scope is
// capped (MAX_INVITE_WORKSPACES) so this always fits R2's metadata budget.
function credentialMeta(record) {
  return {
    id: record.id,
    name: String(record.name ?? "").slice(0, MAX_NAME_LEN),
    role: record.role,
    ws: record.workspaces === "*" ? "*" : JSON.stringify(record.workspaces),
    createdAt: record.createdAt ?? "",
    ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
    ...(record.lastSeenAt ? { lastSeenAt: record.lastSeenAt } : {}),
  };
}

function scopeFromMeta(ws) {
  if (ws === "*") return "*";
  try {
    const parsed = JSON.parse(ws);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Resolve the bearer to an identity, or null. SHARE_TOKEN is compared by
// digest so the check is constant-time regardless of how the strings differ.
async function authenticate(request, env) {
  const header = request.headers.get("authorization") || "";
  if (!header.startsWith("Bearer ")) return null;
  const bearer = header.slice("Bearer ".length).trim();
  if (!bearer) return null;

  const bearerHash = await sha256Hex(bearer);
  if (env.SHARE_TOKEN && timingEq(bearerHash, await sha256Hex(env.SHARE_TOKEN))) {
    return { role: "owner", tokenId: "root", name: "Owner", workspaces: "*", record: null, key: null };
  }

  const obj = await env.PAGES.get(tokenObjectKey(bearerHash));
  if (!obj) return null;
  let record;
  try {
    record = await obj.json();
  } catch {
    return null; // a corrupt token record is a dead credential, not a crash
  }
  if (!record || typeof record !== "object") return null;
  return {
    role: record.role === "owner" ? "owner" : "member",
    tokenId: typeof record.id === "string" ? record.id : "unknown",
    name: typeof record.name === "string" ? record.name : "Member",
    workspaces:
      record.workspaces === "*" ? "*" : Array.isArray(record.workspaces) ? record.workspaces : [],
    record,
    key: tokenObjectKey(bearerHash),
  };
}

// Owner updating a member's page must not steal it, and pages that predate
// ownership stamps belong to the owner (no stamp ≠ up for grabs).
function canTouchPage(auth, existing) {
  if (auth.role === "owner") return true;
  if (!existing) return true;
  return existing.customMetadata?.owner === auth.tokenId;
}

function pageOwner(auth, existing) {
  return existing?.customMetadata?.owner ?? auth.tokenId;
}

// Best-effort "device was here" stamp, at most once per six hours per token —
// the members list shows it, nothing depends on it.
const LAST_SEEN_INTERVAL_MS = 6 * 60 * 60 * 1000;
function touchLastSeen(env, auth, ctx) {
  const rec = auth.record;
  if (!rec || !auth.key) return;
  const last = rec.lastSeenAt ? Date.parse(rec.lastSeenAt) : 0;
  if (Number.isFinite(last) && last > 0 && Date.now() - last < LAST_SEEN_INTERVAL_MS) return;
  rec.lastSeenAt = new Date().toISOString();
  const write = env.PAGES.put(auth.key, JSON.stringify(rec), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: credentialMeta(rec),
  }).catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(write);
}

function validName(raw, fallback) {
  const name = typeof raw === "string" ? raw.trim().slice(0, MAX_NAME_LEN) : "";
  return name || fallback;
}

function parseWorkspaceScope(raw) {
  if (raw === "*") return "*";
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_INVITE_WORKSPACES) return null;
  const out = [];
  for (const ws of raw) {
    if (typeof ws !== "string" || !SYNC_ID_RE.test(ws)) return null;
    if (!out.includes(ws)) out.push(ws);
  }
  return out;
}

async function handleAuthApi(request, env, url, parts, auth) {
  // ["api", "auth", section, id?]
  const section = parts[2];

  if (section === "whoami" && parts.length === 3) {
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
    return json({
      tokenId: auth.tokenId,
      name: auth.name,
      role: auth.role,
      workspaces: auth.workspaces,
    });
  }

  // Everything below manages credentials — the owner's domain.
  if (auth.role !== "owner") return json({ error: "owner only" }, 403);

  if (section === "invites" && parts.length === 3) {
    if (request.method === "GET") {
      const invites = [];
      let cursor;
      do {
        const batch = await env.PAGES.list({
          prefix: INVITES_PREFIX,
          cursor,
          include: ["customMetadata"],
        });
        for (const obj of batch.objects) {
          const meta = obj.customMetadata || {};
          // Expired codes are useless — clean them up as we walk past.
          if (meta.expiresAt && Date.parse(meta.expiresAt) < Date.now()) {
            await env.PAGES.delete(obj.key);
            continue;
          }
          // Claimed markers only exist to 410 a double-pasted code; they're
          // not pending invites.
          if (meta.claimed === "1") continue;
          invites.push({
            id: meta.id ?? null,
            name: meta.name ?? "",
            role: meta.role === "owner" ? "owner" : "member",
            workspaces: scopeFromMeta(meta.ws),
            createdAt: meta.createdAt || null,
            expiresAt: meta.expiresAt || null,
          });
        }
        cursor = batch.truncated ? batch.cursor : undefined;
      } while (cursor);
      return json({ invites });
    }
    if (request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid json body" }, 400);
      }
      const role = body.role === "owner" ? "owner" : "member";
      // A linked device is the owner everywhere; a member's reach is exactly
      // the workspaces the invite names.
      const workspaces = role === "owner" ? "*" : parseWorkspaceScope(body.workspaces);
      if (!workspaces) return json({ error: "workspaces must be a non-empty array of ids" }, 400);
      const ttlRaw = Number(body.ttlMs);
      const ttl =
        Number.isFinite(ttlRaw) && ttlRaw > 0
          ? Math.min(ttlRaw, INVITE_MAX_TTL_MS)
          : INVITE_DEFAULT_TTL_MS;

      const existing = await env.PAGES.list({ prefix: INVITES_PREFIX });
      if (existing.objects.length >= MAX_INVITES) {
        return json({ error: "too many pending invites" }, 409);
      }

      const id = `i-${randomHex(6)}`;
      const code = `dk_i_${randomHex(32)}`;
      const now = new Date();
      const record = {
        id,
        name: validName(body.name, role === "owner" ? "Linked device" : "Member"),
        role,
        workspaces,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttl).toISOString(),
      };
      await env.PAGES.put(inviteObjectKey(await sha256Hex(code)), JSON.stringify(record), {
        httpMetadata: { contentType: "application/json" },
        customMetadata: credentialMeta(record),
      });
      // The code exists in exactly two places from here: this response and
      // wherever the owner sends it. The #fragment keeps it out of logs.
      return json({
        id,
        code,
        role,
        workspaces,
        expiresAt: record.expiresAt,
        joinUrl: `${url.origin}/join#${code}`,
      });
    }
    return json({ error: "method not allowed" }, 405);
  }

  if (section === "invites" && parts.length === 4) {
    if (request.method !== "DELETE") return json({ error: "method not allowed" }, 405);
    const key = await findCredentialKeyById(env, INVITES_PREFIX, parts[3]);
    if (!key) return json({ error: "not found" }, 404);
    await env.PAGES.delete(key);
    return json({ id: parts[3], deleted: true });
  }

  if (section === "tokens" && parts.length === 3) {
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
    const tokens = [];
    let cursor;
    do {
      const batch = await env.PAGES.list({
        prefix: TOKENS_PREFIX,
        cursor,
        include: ["customMetadata"],
      });
      for (const obj of batch.objects) {
        const meta = obj.customMetadata || {};
        tokens.push({
          id: meta.id ?? null,
          name: meta.name ?? "",
          role: meta.role === "owner" ? "owner" : "member",
          workspaces: scopeFromMeta(meta.ws),
          createdAt: meta.createdAt || null,
          lastSeenAt: meta.lastSeenAt || null,
        });
      }
      cursor = batch.truncated ? batch.cursor : undefined;
    } while (cursor);
    return json({ tokens });
  }

  if (section === "tokens" && parts.length === 4) {
    if (request.method !== "DELETE") return json({ error: "method not allowed" }, 405);
    const key = await findCredentialKeyById(env, TOKENS_PREFIX, parts[3]);
    if (!key) return json({ error: "not found" }, 404);
    // Deleting the hash-keyed object IS the revocation — the very next
    // request bearing that token fails in every isolate.
    await env.PAGES.delete(key);
    return json({ id: parts[3], deleted: true });
  }

  return json({ error: "not found" }, 404);
}

// Credentials are keyed by secret hash; humans point at them by display id.
async function findCredentialKeyById(env, prefix, id) {
  if (typeof id !== "string" || id.length > 64) return null;
  let cursor;
  do {
    const batch = await env.PAGES.list({ prefix, cursor, include: ["customMetadata"] });
    for (const obj of batch.objects) {
      if (obj.customMetadata?.id === id) return obj.key;
    }
    cursor = batch.truncated ? batch.cursor : undefined;
  } while (cursor);
  return null;
}

/* Joins are the only unauthenticated writes on the worker, so they get a
   (per-isolate, best-effort) rate limit — belt and suspenders on top of the
   256-bit code. */
const joinAttempts = new Map(); // ip -> [timestamps]

function joinRateLimited(request) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const now = Date.now();
  const recent = (joinAttempts.get(ip) || []).filter((t) => now - t < 60_000);
  recent.push(now);
  joinAttempts.set(ip, recent);
  if (joinAttempts.size > 10_000) joinAttempts.clear(); // unbounded-growth guard
  return recent.length > JOIN_RATE_LIMIT;
}

async function handleJoin(request, env, url) {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (joinRateLimited(request)) return json({ error: "too many attempts, retry later" }, 429);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid json body" }, 400);
  }
  const code = typeof body.invite === "string" ? body.invite.trim() : "";
  if (!code || code.length > 256) return json({ error: "invalid invite" }, 400);

  // The invite object is keyed by the code's hash — resolving it is one get.
  const inviteKey = inviteObjectKey(await sha256Hex(code));
  const inviteObj = await env.PAGES.get(inviteKey);
  if (!inviteObj) return json({ error: "invalid or expired invite" }, 404);
  let invite;
  try {
    invite = await inviteObj.json();
  } catch {
    return json({ error: "invalid or expired invite" }, 404);
  }
  if (invite.claimed) return json({ error: "invite already used" }, 410);
  if (invite.expiresAt && Date.parse(invite.expiresAt) < Date.now()) {
    await env.PAGES.delete(inviteKey);
    return json({ error: "invalid or expired invite" }, 410);
  }

  // Two devices racing the same code: the CAS lets exactly one of them turn
  // it into a token; the other sees the claim marker (or a lost race) and
  // gets told the code is spent. The marker outlives the join by 48h so a
  // double-pasted code gets "already used" rather than a baffling
  // "invalid" — then the expiry sweep clears it.
  const claimedRecord = {
    ...invite,
    claimed: true,
    claimedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
  };
  const claimed = await env.PAGES.put(inviteKey, JSON.stringify(claimedRecord), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { ...credentialMeta(claimedRecord), claimed: "1" },
    onlyIf: { etagMatches: inviteObj.etag },
  });
  if (!claimed) return json({ error: "invite already used" }, 410);

  const minted = await env.PAGES.list({ prefix: TOKENS_PREFIX });
  if (minted.objects.length >= MAX_TOKENS) {
    return json({ error: "token limit reached" }, 409);
  }

  const tokenId = `t-${randomHex(6)}`;
  const raw = `dk_${invite.role === "owner" ? "o" : "m"}_${randomHex(32)}`;
  const record = {
    id: tokenId,
    name: validName(body.name, invite.name),
    role: invite.role === "owner" ? "owner" : "member",
    workspaces: invite.workspaces,
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  };
  await env.PAGES.put(tokenObjectKey(await sha256Hex(raw)), JSON.stringify(record), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: credentialMeta(record),
  });

  // `token` appears exactly once, here — the worker keeps only its hash
  // (as the object key, never in a body).
  return json({
    token: raw,
    tokenId,
    name: record.name,
    role: record.role,
    workspaces: record.workspaces,
  });
}

/* ---------- Sync: private workspaces ----------

   Everything under sync/<ws>/ is private — served only through this API,
   never by the public routes. The manifest is the sole coordination point:
   one JSON object per workspace, updated by compare-and-swap on its R2 etag
   (R2 writes are strongly consistent, and a failed precondition returns
   null). File content lives in immutable, content-addressed blobs — two
   devices racing a revision can never clobber each other's bytes; the
   manifest CAS just decides which one is "current". The worker validates
   shapes and caps but leaves merge semantics to the clients: everyone who
   can write here was invited. */

const wsMetaKey = (ws) => `sync/${ws}/ws.json`;
const manifestKey = (ws) => `sync/${ws}/manifest.json`;
const presenceKey = (ws) => `sync/${ws}/presence.json`;
const blobKey = (ws, fileId, hash) => `sync/${ws}/files/${fileId}/${hash}`;
const historyKey = (ws, fileId) => `sync/${ws}/history/${fileId}.json`;

function canAccessWs(auth, ws) {
  return auth.workspaces === "*" || (Array.isArray(auth.workspaces) && auth.workspaces.includes(ws));
}

// Relative path inside a workspace: forward slashes, no traversal, bounded
// depth/length — mirrors what the app itself is willing to walk.
function validSyncPath(p) {
  if (typeof p !== "string" || p.length === 0 || p.length > MAX_SYNC_PATH_LEN) return false;
  if (p.includes("\0") || p.includes("\\")) return false;
  const segs = p.split("/");
  if (segs.length > MAX_SYNC_PATH_DEPTH) return false;
  return segs.every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}

function validHistEntry(e) {
  return (
    e &&
    typeof e === "object" &&
    Number.isInteger(e.r) &&
    e.r >= 1 &&
    typeof e.h === "string" &&
    BLOB_HASH_RE.test(e.h) &&
    Number.isInteger(e.s) &&
    e.s >= 0 &&
    typeof e.t === "number"
  );
}

// Shape-check a manifest without trusting the client. Semantics (revision
// ordering, merges) are the clients' job; corruption and traversal are ours.
function validateManifest(data) {
  if (!data || typeof data !== "object") return "manifest must be an object";
  if (data.version !== 1) return "unsupported manifest version";
  if (!Number.isInteger(data.seq) || data.seq < 0) return "seq must be a non-negative integer";
  if (data.name !== undefined && typeof data.name !== "string") return "invalid name";
  if (!data.files || typeof data.files !== "object" || Array.isArray(data.files)) {
    return "files must be an object";
  }
  const fileIds = Object.keys(data.files);
  if (fileIds.length > MAX_MANIFEST_FILES) return "too many files";
  const seenPaths = new Set();
  for (const fileId of fileIds) {
    if (!SYNC_ID_RE.test(fileId)) return `invalid file id: ${fileId}`;
    const f = data.files[fileId];
    if (!f || typeof f !== "object") return "invalid file entry";
    if (!validSyncPath(f.path)) return `invalid path for ${fileId}`;
    const pathKey = f.path.toLowerCase();
    if (seenPaths.has(pathKey)) return `duplicate path: ${f.path}`;
    seenPaths.add(pathKey);
    if (!Number.isInteger(f.rev) || f.rev < 1) return `invalid rev for ${fileId}`;
    if (typeof f.hash !== "string" || !BLOB_HASH_RE.test(f.hash)) {
      return `invalid hash for ${fileId}`;
    }
    if (!Number.isInteger(f.size) || f.size < 0 || f.size > MAX_SYNC_FILE_BYTES) {
      return `invalid size for ${fileId}`;
    }
    if (f.hist !== undefined) {
      if (!Array.isArray(f.hist) || f.hist.length > 12 || !f.hist.every(validHistEntry)) {
        return `invalid hist for ${fileId}`;
      }
    }
  }
  if (data.tombstones !== undefined) {
    if (typeof data.tombstones !== "object" || Array.isArray(data.tombstones)) {
      return "tombstones must be an object";
    }
    const ids = Object.keys(data.tombstones);
    if (ids.length > 10_000) return "too many tombstones";
    for (const id of ids) {
      if (!SYNC_ID_RE.test(id)) return `invalid tombstone id: ${id}`;
      const t = data.tombstones[id];
      if (!t || typeof t !== "object" || !validSyncPath(t.path)) {
        return `invalid tombstone for ${id}`;
      }
    }
  }
  return null;
}

async function readPresence(env, ws) {
  const obj = await env.PAGES.get(presenceKey(ws));
  if (!obj) return {};
  try {
    const parsed = await obj.json();
    return parsed && typeof parsed === "object" && parsed.devices ? parsed.devices : {};
  } catch {
    return {};
  }
}

function prunePresence(devices) {
  const now = Date.now();
  const fresh = {};
  for (const [id, entry] of Object.entries(devices)) {
    if (entry && typeof entry.ts === "number" && now - entry.ts < PRESENCE_TTL_MS) {
      fresh[id] = entry;
    }
  }
  return fresh;
}

async function handleSyncApi(request, env, url, parts, auth, ctx) {
  // ["api", "sync", "workspaces"|<ws>, ...]
  if (parts[2] === "workspaces") {
    if (parts.length === 3 && request.method === "GET") {
      return listWorkspaces(env, auth);
    }
    if (parts.length === 3 && request.method === "POST") {
      if (auth.role !== "owner") return json({ error: "owner only" }, 403);
      return createWorkspace(request, env);
    }
    if (parts.length === 4 && request.method === "DELETE") {
      if (auth.role !== "owner") return json({ error: "owner only" }, 403);
      return deleteWorkspace(env, parts[3]);
    }
    return json({ error: "method not allowed" }, 405);
  }

  const ws = parts[2];
  if (!SYNC_ID_RE.test(ws)) return json({ error: "invalid workspace id" }, 400);
  // Scope check before existence check, so a member can't probe which
  // workspace ids exist outside their grant.
  if (!canAccessWs(auth, ws)) return json({ error: "forbidden" }, 403);

  const section = parts[3];

  if (section === "poll" && parts.length === 4) {
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
    const [head, devices] = await Promise.all([
      env.PAGES.head(manifestKey(ws)),
      readPresence(env, ws),
    ]);
    if (!head) return json({ error: "no such workspace" }, 404);
    touchLastSeen(env, auth, ctx);
    return json({ manifestEtag: head.etag, presence: prunePresence(devices) });
  }

  if (section === "manifest" && parts.length === 4) {
    if (request.method === "GET") {
      const obj = await env.PAGES.get(manifestKey(ws));
      if (!obj) return json({ error: "no such workspace" }, 404);
      const since = url.searchParams.get("since");
      if (since && since === obj.etag) {
        return new Response(null, {
          status: 304,
          headers: { "x-manifest-etag": obj.etag, ...CORS_HEADERS },
        });
      }
      return new Response(obj.body, {
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          "x-manifest-etag": obj.etag,
          ...CORS_HEADERS,
        },
      });
    }
    if (request.method === "PUT") {
      const baseEtag = request.headers.get("x-base-etag");
      if (!baseEtag) return json({ error: "x-base-etag header required" }, 428);
      const text = await request.text();
      if (text.length > MAX_MANIFEST_BYTES) return json({ error: "manifest too large" }, 413);
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return json({ error: "invalid json body" }, 400);
      }
      const problem = validateManifest(data);
      if (problem) return json({ error: problem }, 400);
      const put = await env.PAGES.put(manifestKey(ws), text, {
        httpMetadata: { contentType: "application/json" },
        onlyIf: { etagMatches: baseEtag },
      });
      if (!put) {
        // Lost the race (or the workspace vanished). Tell the loser where
        // the manifest is now so its next attempt starts from reality.
        const current = await env.PAGES.head(manifestKey(ws));
        if (!current) return json({ error: "no such workspace" }, 404);
        return json({ error: "manifest changed", etag: current.etag }, 412);
      }
      return json({ etag: put.etag, seq: data.seq });
    }
    return json({ error: "method not allowed" }, 405);
  }

  if (section === "presence" && parts.length === 4) {
    if (request.method !== "PUT") return json({ error: "method not allowed" }, 405);
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid json body" }, 400);
    }
    const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
    if (!SYNC_ID_RE.test(deviceId)) return json({ error: "invalid deviceId" }, 400);
    // Presence is ephemeral and self-healing (next heartbeat repaints it), so
    // plain last-write-wins is fine — no CAS ceremony.
    const devices = prunePresence(await readPresence(env, ws));
    if (body.fileId === null || body.fileId === undefined) {
      delete devices[deviceId];
    } else {
      if (typeof body.fileId !== "string" || !SYNC_ID_RE.test(body.fileId)) {
        return json({ error: "invalid fileId" }, 400);
      }
      devices[deviceId] = {
        name: validName(body.name, auth.name),
        fileId: body.fileId,
        ...(validSyncPath(body.path) ? { path: body.path } : {}),
        ts: Date.now(),
      };
    }
    await env.PAGES.put(presenceKey(ws), JSON.stringify({ devices }), {
      httpMetadata: { contentType: "application/json" },
    });
    return json({ presence: devices });
  }

  if (section === "files" && (parts.length === 5 || parts.length === 6)) {
    const fileId = parts[4];
    if (!SYNC_ID_RE.test(fileId)) return json({ error: "invalid file id" }, 400);

    if (parts.length === 5) {
      // The blob inventory for one file — what GC diffs against the
      // manifest's live references.
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
      const blobs = [];
      let cursor;
      do {
        const batch = await env.PAGES.list({ prefix: `sync/${ws}/files/${fileId}/`, cursor });
        for (const obj of batch.objects) {
          const hash = obj.key.split("/").pop();
          blobs.push({
            hash,
            size: obj.size,
            uploaded: obj.uploaded?.toISOString?.() ?? null,
          });
        }
        cursor = batch.truncated ? batch.cursor : undefined;
      } while (cursor);
      return json({ blobs });
    }

    const hash = parts[5];
    if (!BLOB_HASH_RE.test(hash)) return json({ error: "invalid blob hash" }, 400);
    const key = blobKey(ws, fileId, hash);

    if (request.method === "GET") {
      const obj = await env.PAGES.get(key);
      if (!obj) return json({ error: "not found" }, 404);
      return new Response(obj.body, {
        headers: {
          "content-type": obj.httpMetadata?.contentType || "application/octet-stream",
          "content-length": String(obj.size),
          "cache-control": "no-store",
          ...CORS_HEADERS,
        },
      });
    }
    if (request.method === "PUT") {
      const buf = await request.arrayBuffer();
      if (buf.byteLength > MAX_SYNC_FILE_BYTES) return json({ error: "file too large" }, 413);
      await env.PAGES.put(key, buf, {
        httpMetadata: {
          contentType: request.headers.get("content-type") || "application/octet-stream",
        },
      });
      return json({ stored: true, hash, size: buf.byteLength });
    }
    if (request.method === "DELETE") {
      await env.PAGES.delete(key);
      return json({ deleted: true });
    }
    return json({ error: "method not allowed" }, 405);
  }

  if (section === "history" && parts.length === 5) {
    const fileId = parts[4];
    if (!SYNC_ID_RE.test(fileId)) return json({ error: "invalid file id" }, 400);
    if (request.method === "GET") {
      const obj = await env.PAGES.get(historyKey(ws, fileId));
      if (!obj) return json({ error: "not found" }, 404);
      return new Response(obj.body, {
        headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS },
      });
    }
    if (request.method === "PUT") {
      // The deep archive: entries the pushers rolled out of the manifest's
      // inline tail. Advisory data — last write wins, size-capped.
      const text = await request.text();
      if (text.length > MAX_HISTORY_BYTES) return json({ error: "history too large" }, 413);
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return json({ error: "invalid json body" }, 400);
      }
      if (
        !data ||
        data.version !== 1 ||
        !Array.isArray(data.entries) ||
        data.entries.length > 200 ||
        !data.entries.every(validHistEntry)
      ) {
        return json({ error: "invalid history" }, 400);
      }
      await env.PAGES.put(historyKey(ws, fileId), text, {
        httpMetadata: { contentType: "application/json" },
      });
      return json({ stored: true, entries: data.entries.length });
    }
    return json({ error: "method not allowed" }, 405);
  }

  return json({ error: "not found" }, 404);
}

async function listWorkspaces(env, auth) {
  const list = await env.PAGES.list({ prefix: "sync/", delimiter: "/" });
  const ids = (list.delimitedPrefixes || [])
    .map((p) => p.slice("sync/".length).replace(/\/$/, ""))
    .filter((id) => SYNC_ID_RE.test(id))
    .filter((id) => canAccessWs(auth, id))
    .slice(0, MAX_WORKSPACES);
  const workspaces = [];
  for (const id of ids) {
    const obj = await env.PAGES.get(wsMetaKey(id));
    if (!obj) continue;
    try {
      const meta = await obj.json();
      workspaces.push({
        id,
        name: typeof meta.name === "string" ? meta.name : id,
        createdAt: meta.createdAt ?? null,
      });
    } catch {
      workspaces.push({ id, name: id, createdAt: null });
    }
  }
  return json({ workspaces });
}

async function createWorkspace(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid json body" }, 400);
  }
  const name = validName(body.name, "Workspace");
  const id = typeof body.id === "string" && SYNC_ID_RE.test(body.id) ? body.id : `ws-${randomHex(5)}`;

  const list = await env.PAGES.list({ prefix: "sync/", delimiter: "/" });
  if ((list.delimitedPrefixes || []).length >= MAX_WORKSPACES) {
    return json({ error: "too many workspaces" }, 409);
  }
  if (await env.PAGES.head(wsMetaKey(id))) {
    return json({ error: "workspace exists" }, 409);
  }

  const now = new Date().toISOString();
  await env.PAGES.put(wsMetaKey(id), JSON.stringify({ id, name, createdAt: now }), {
    httpMetadata: { contentType: "application/json" },
  });
  const manifest = { version: 1, name, seq: 0, files: {}, tombstones: {} };
  const put = await env.PAGES.put(manifestKey(id), JSON.stringify(manifest), {
    httpMetadata: { contentType: "application/json" },
  });
  return json({ id, name, createdAt: now, manifestEtag: put.etag });
}

// Purge as much as the per-request subrequest budget allows; the client
// repeats the call until `remaining` comes back false.
async function deleteWorkspace(env, ws) {
  if (!SYNC_ID_RE.test(ws)) return json({ error: "invalid workspace id" }, 400);
  let deleted = 0;
  for (let round = 0; round < 20; round += 1) {
    const batch = await env.PAGES.list({ prefix: `sync/${ws}/`, limit: 1000 });
    if (batch.objects.length === 0) {
      return json({ id: ws, deleted: true, purged: deleted, remaining: false });
    }
    await env.PAGES.delete(batch.objects.map((o) => o.key));
    deleted += batch.objects.length;
    if (!batch.truncated && batch.objects.length < 1000) {
      return json({ id: ws, deleted: true, purged: deleted, remaining: false });
    }
  }
  return json({ id: ws, deleted: true, purged: deleted, remaining: true });
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

// The app-managed site config: landing branding + optional root page. A
// missing or corrupt object is just "no config" — the landing page stays
// generic.
async function readSiteConfig(env) {
  const obj = await env.PAGES.get(SITE_KEY);
  if (!obj) return {};
  try {
    const parsed = await obj.json();
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// The domain root: the rootPageId page when the site config names one (a
// custom home page — it can even be a collection's table of contents), the
// landing page otherwise. A dangling rootPageId (page unshared since) falls
// back to the landing page rather than 404ing the domain root.
async function serveRoot(env, url) {
  const site = await readSiteConfig(env);
  if (typeof site.rootPageId === "string" && validId(site.rootPageId)) {
    const obj = await env.PAGES.get(`pages/${site.rootPageId}.json`);
    if (obj) {
      try {
        // `await`, not a bare return: a rejection inside the render must land
        // in this catch so the domain root degrades instead of 500ing.
        return await renderPage(env, site.rootPageId, await obj.json(), url);
      } catch {
        // corrupt page object; fall through to the landing page
      }
    }
  }
  return landingPage(url, site);
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
  return renderPage(env, id, data, url);
}

async function renderPage(env, id, data, url) {
  if (data.kind === "collection") return serveCollection(env, id, data, url);

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

  // A member of a folder share gets a fixed "back to the folder" crumb (the
  // mirror of the view pill on the other side), so a reader who arrived from
  // the folder's home page — or landed here directly — can reach the rest.
  const crumb =
    data.collection && typeof data.collection.id === "string" && validId(data.collection.id)
      ? `<a class="home-crumb" href="/${data.collection.id}"><span class="home-crumb-arrow">←</span><span class="home-crumb-label">${escapeHtml(data.collection.title || "Home")}</span></a>`
      : "";

  // With both versions present, the reader picks: a fixed pill toggles between
  // the html rendition (/<id> — the polished, human-facing default, opposite
  // of the editor which leads with the markdown source) and the markdown page
  // (/<id>?v=md).
  const pill = (active) =>
    hasMd && hasHtml
      ? `<nav class="view-pill" aria-label="Document version">
<a class="view-seg ${active === "md" ? "is-active" : ""}" href="${pageUrl}?v=md">MD</a>
<a class="view-seg ${active === "html" ? "is-active" : ""}" href="${pageUrl}">HTML</a>
</nav>`
      : "";

  const wantMd = url.searchParams.get("v") === "md";
  if (hasHtml && !(hasMd && wantMd)) {
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
${crumb}
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
${crumb}
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

/* ---------- Collection (folder share) home pages ---------- */

// Rebuild the folder structure from the members' relative paths. Only
// directories that contain at least one included page exist here — the
// manifest never describes anything the owner didn't include.
function buildCollectionTree(items) {
  const root = { dirs: new Map(), files: [] };
  for (const it of items) {
    const segs = it.path.split("/").filter(Boolean);
    let node = root;
    for (const seg of segs.slice(0, -1)) {
      if (!node.dirs.has(seg)) node.dirs.set(seg, { dirs: new Map(), files: [] });
      node = node.dirs.get(seg);
    }
    node.files.push(it);
  }
  return root;
}

function countTreePages(node) {
  let n = node.files.length;
  for (const d of node.dirs.values()) n += countTreePages(d);
  return n;
}

function countTreeDirs(node) {
  let n = node.dirs.size;
  for (const d of node.dirs.values()) n += countTreeDirs(d);
  return n;
}

// Stroke-only glyphs matching the desktop sidebar's icons. Page and folder
// icons sit in small bordered tiles (.toc-icon); the chevron and arrow are
// bare row-trailing marks.
const TOC_PAGE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>`;
const TOC_DIR_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
const TOC_CHEVRON = `<svg class="toc-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>`;
const TOC_ARROW = `<svg class="toc-page-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`;

// Directories first, then pages, both alphabetical — the same order the
// desktop sidebar shows. Top-level folders start open, deeper ones closed
// (native <details>, so large trees stay scannable without any script).
// Page rows reveal a trailing arrow on hover; directory rows trail their
// page count and a rotating disclosure chevron.
function renderTocLevel(node, depth) {
  const dirs = [...node.dirs.entries()].sort((a, b) =>
    a[0].localeCompare(b[0], undefined, { sensitivity: "base" }),
  );
  const files = [...node.files].sort((a, b) =>
    a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
  );
  const parts = [];
  for (const [name, child] of dirs) {
    const count = countTreePages(child);
    parts.push(`<details class="toc-dir"${depth === 0 ? " open" : ""}>
<summary><span class="toc-icon">${TOC_DIR_ICON}</span><span class="toc-dir-name">${escapeHtml(name)}</span><span class="toc-count">${count}</span>${TOC_CHEVRON}</summary>
<div class="toc-children">${renderTocLevel(child, depth + 1)}</div>
</details>`);
  }
  for (const f of files) {
    parts.push(
      `<a class="toc-page" href="/${f.id}"><span class="toc-icon">${TOC_PAGE_ICON}</span><span class="toc-page-title">${escapeHtml(f.title)}</span>${TOC_ARROW}</a>`,
    );
  }
  return parts.join("\n");
}

// The small-share TOC: every page as one card, flat, sorted by where it lives
// and then by name. Folder structure doesn't earn a tree at this size — each
// card just wears its folder path as a quiet subtitle.
function renderTocCards(items) {
  const dirOf = (p) => p.split("/").slice(0, -1).join("/");
  const sorted = [...items].sort(
    (a, b) =>
      dirOf(a.path).localeCompare(dirOf(b.path), undefined, { sensitivity: "base" }) ||
      a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
  );
  return sorted
    .map((it) => {
      const dir = dirOf(it.path).split("/").filter(Boolean).join(" / ");
      return `<a class="toc-card" href="/${it.id}"><span class="toc-icon">${TOC_PAGE_ICON}</span><span class="toc-card-text"><span class="toc-card-title">${escapeHtml(it.title)}</span>${dir ? `<span class="toc-card-path">${escapeHtml(dir)}</span>` : ""}</span>${TOC_ARROW}</a>`;
    })
    .join("\n");
}

// The folder share's home page: title, an optional owner-written description,
// page count, and the table of contents — cards for a handful of pages, the
// collapsible tree for more (see TOC_CARDS_MAX).
async function serveCollection(env, id, data, url) {
  const title = data.title || "Untitled";
  const description = typeof data.description === "string" ? data.description.trim() : "";
  const items = Array.isArray(data.items)
    ? data.items.filter(
        (it) =>
          it &&
          typeof it.id === "string" &&
          validId(it.id) &&
          typeof it.path === "string" &&
          it.path.length > 0,
      )
    : [];
  const count = items.length;
  const desc =
    description || `${count} shared ${count === 1 ? "page" : "pages"} on ${url.hostname}`;
  const ogImage = await env.PAGES.head(`pages/${id}.png`);
  const pageUrl = `${url.origin}/${id}`;
  const updated = data.updatedAt ? new Date(data.updatedAt) : null;
  const updatedLabel =
    updated && !Number.isNaN(updated.getTime())
      ? updated.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
      : null;

  const head = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(desc)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${escapeHtml(url.hostname)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(desc)}">
<meta property="og:url" content="${pageUrl}">
${ogImage ? `<meta property="og:image" content="${pageUrl}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${pageUrl}/og.png">` : `<meta name="twitter:card" content="summary">`}`;

  const tree = buildCollectionTree(items);
  const useCards = count > 0 && count <= TOC_CARDS_MAX;
  const toc =
    count === 0
      ? `<div class="toc-empty">Nothing here yet.</div>`
      : useCards
        ? renderTocCards(items)
        : renderTocLevel(tree, 0);
  // The tree mode's meta also counts folders — at that size the shape of the
  // share is part of the story. Cards flatten folders away, so it'd be noise.
  const dirCount = useCards ? 0 : countTreeDirs(tree);
  const sep = `<span class="toc-meta-sep" aria-hidden="true"></span>`;
  const meta = [
    `${count} ${count === 1 ? "page" : "pages"}`,
    ...(dirCount > 0 ? [`${dirCount} ${dirCount === 1 ? "folder" : "folders"}`] : []),
    ...(updatedLabel ? [`Updated ${escapeHtml(updatedLabel)}`] : []),
  ].join(sep);

  const html = `<!doctype html>
<html lang="en">
<head>
${head}
<style>${PAGE_CSS}</style>
</head>
<body>
<main class="doc toc">
<header class="toc-head">
<h1 class="toc-title">${escapeHtml(title)}</h1>
${description ? `<p class="toc-desc">${escapeHtml(description)}</p>` : ""}
<p class="toc-meta">${meta}</p>
</header>
<nav class="toc-tree${useCards ? " toc-cards" : ""}" aria-label="Pages">
${toc}
</nav>
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

// The landing page reads like Doklin's own product page, personalized to the
// deployment: the Doklin wordmark leads, and the site config's ownerName /
// ownerLink fill in whose domain this is. It answers two things for a visitor
// who followed a share link here: whose notes live on this domain, and what
// Doklin is (a free, open-source Mac editor, with a feature pitch + a download
// button). The editor is presented as a product the owner uses, not one they
// own. Without ownerName the page stays a generic Doklin page. The download
// button points at the site config's downloadUrl, defaulting to the official
// GitHub release's stable latest-download alias (kept in sync by
// .github/workflows/release.yml); set downloadUrl to "" to hide it. ownerLink
// (typically a LinkedIn profile) and the project source on GitHub show as
// quiet links under the button; GitHub is where "open source" gets said.
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

function landingPage(url, site = {}) {
  const host = url.hostname;
  const owner = typeof site.ownerName === "string" ? site.ownerName.trim() : "";
  const link = typeof site.ownerLink === "string" ? site.ownerLink.trim() : "";
  const isLinkedIn = /(^|\.)linkedin\.com\//i.test(link.replace(/^https?:\/\//, ""));
  // Unset -> official release; set (even to "") -> respected verbatim, so a
  // self-hoster can point elsewhere or blank it out.
  const downloadUrl = (
    typeof site.downloadUrl === "string" ? site.downloadUrl : DEFAULT_DOWNLOAD_URL
  ).trim();

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
  // external-link glyph if the profile link is not a LinkedIn URL.
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

/* ---------- Invite landing page ----------

   Where an invite link (https://<host>/join#dk_i_…) lands. The code rides
   the #fragment, which browsers never send to the server — so it shows up
   here in page JS but never in any log. The page just walks the invitee
   through: get Doklin, open Connect, paste the code. */

function joinPage(env, url) {
  return readSiteConfig(env).then((site) => {
    const host = url.hostname;
    const owner = typeof site.ownerName === "string" ? site.ownerName.trim() : "";
    const downloadUrl = (
      typeof site.downloadUrl === "string" ? site.downloadUrl : DEFAULT_DOWNLOAD_URL
    ).trim();
    const who = owner ? escapeHtml(owner) : `whoever runs ${escapeHtml(host)}`;

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Join a shared Doklin backend</title>
<meta name="description" content="You've been invited to a shared Doklin workspace on ${escapeHtml(host)}.">
<style>${PAGE_CSS}${LANDING_CSS}${JOIN_CSS}</style>
</head>
<body>
<main class="landing join">
  <div class="landing-mark"><span class="landing-dot" aria-hidden></span>Doklin</div>
  <h1 class="landing-headline">You're invited</h1>
  <p class="landing-lead">${who} shared a workspace with you. Connect Doklin to it and the
  documents sync to your Mac — yours to read and edit, backed by this domain.</p>

  <div class="join-code-wrap" id="join-code-wrap" style="display:none">
    <code class="join-code" id="join-code"></code>
    <button class="landing-btn join-copy" id="join-copy" type="button">Copy code</button>
  </div>
  <p class="join-missing muted" id="join-missing">This link is missing its invite code —
  ask for a fresh invite link.</p>

  <ol class="join-steps">
    <li><span class="join-step-n">1</span>${
      downloadUrl
        ? `<span><a href="${escapeHtml(downloadUrl)}">Download Doklin</a> for macOS and open it.</span>`
        : `<span>Install Doklin for macOS and open it.</span>`
    }</li>
    <li><span class="join-step-n">2</span><span>In the gear menu, choose <strong>Connect to a shared backend…</strong></span></li>
    <li><span class="join-step-n">3</span><span>Paste the invite code. Your shared workspaces sync down and you're in.</span></li>
  </ol>

  <footer class="landing-footer">${escapeHtml(host)}</footer>
</main>
<script>
(function () {
  var code = location.hash.replace(/^#/, "");
  if (!/^dk_i_[a-f0-9]{24,80}$/.test(code)) return;
  var box = document.getElementById("join-code");
  box.textContent = code;
  document.getElementById("join-code-wrap").style.display = "";
  document.getElementById("join-missing").style.display = "none";
  var btn = document.getElementById("join-copy");
  btn.addEventListener("click", function () {
    navigator.clipboard.writeText(code).then(function () {
      btn.textContent = "Copied ✓";
      setTimeout(function () { btn.textContent = "Copy code"; }, 1600);
    });
  });
})();
</script>
</body>
</html>`;
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
    });
  });
}

const JOIN_CSS = `
.join .landing-lead { max-width: 30rem; }
.join-code-wrap {
  margin: 26px auto 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  width: 100%;
  max-width: 34rem;
}
.join-code {
  display: block;
  width: 100%;
  padding: 12px 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  font-size: 13px;
  word-break: break-all;
  user-select: all;
}
.join-missing { margin: 26px auto 0; font-size: 14px; color: var(--muted); }
.join-steps {
  margin: 30px auto 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 26rem;
  text-align: left;
}
.join-steps li { display: flex; align-items: baseline; gap: 12px; font-size: 15px; line-height: 1.5; }
.join-steps a { color: var(--link); }
.join-step-n {
  flex: none;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--muted);
  font-size: 12px;
  font-weight: 700;
}
`;

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
/* The document flows vertically and never scrolls sideways — mirrors the app's
   editor canvas. Wide blocks (code, tables) scroll within themselves; nothing
   pushes a page-level horizontal scrollbar. The html rendition is exempt: it
   lives in .raw-frame and scrolls internally, so it keeps horizontal scroll for
   free when its document genuinely needs it. */
html, body { margin: 0; padding: 0; background: var(--bg); overflow-x: hidden; }
/* Sticky footer: the body fills the viewport and the footer rides its bottom
   edge, so a one-line page doesn't leave "shared via …" floating mid-screen. */
body {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
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
  width: 100%;
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
  width: 100%;
  max-width: 1080px;
  /* margin-top: auto pins it to the flex column's bottom edge. */
  margin: auto auto 0;
  padding: 24px 64px 48px;
  font-size: 12px;
  color: var(--muted);
  text-align: center;
}
footer a { color: var(--muted); }
/* "Back to the folder" crumb on pages that belong to a folder share — the
   view pill's mirror image, pinned top-left. */
.home-crumb {
  position: fixed;
  top: 14px;
  left: 14px;
  z-index: 10;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 40vw;
  padding: 4px 12px 4px 10px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--bg) 78%, transparent);
  border: 1px solid var(--border);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  text-decoration: none;
}
.home-crumb:hover { color: var(--text); }
.home-crumb-arrow { font-weight: 400; flex: none; }
.home-crumb-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Folder share home page: the table of contents. A quiet editorial cover —
   title, optional description, a hairline rule — over a list of tappable
   rows: icon tile, title, and a trailing arrow that slides in on hover.
   Directories are native <details> rows with a count and a rotating chevron
   on the right, their children inset behind a hairline. */
main.toc { max-width: 680px; }
.toc-head { padding: 34px 0 24px; border-bottom: 1px solid var(--border); }
.toc-title {
  margin: 0;
  font-size: clamp(28px, 5.4vw, 36px);
  line-height: 1.15;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.toc-desc {
  margin: 12px 0 0;
  max-width: 40rem;
  font-size: 16.5px;
  line-height: 1.55;
  color: var(--muted);
}
.toc-meta {
  margin: 16px 0 0;
  font-size: 12.5px;
  font-weight: 500;
  letter-spacing: 0.02em;
  color: var(--muted);
}
.toc-meta-sep {
  display: inline-block;
  width: 3px;
  height: 3px;
  margin: 0 8px;
  vertical-align: 2.5px;
  border-radius: 50%;
  background: var(--muted);
}
.toc-tree { margin-top: 20px; display: flex; flex-direction: column; gap: 2px; }
/* Icon tile shared by page and directory rows — echoes the landing page's
   feature icons, and gives every row a steady left rhythm. */
.toc-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex: none;
  border-radius: 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--muted);
  transition: color 0.12s;
}
.toc-icon svg { width: 16px; height: 16px; }
.doc .toc-page {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 12px;
  border-radius: 10px;
  color: var(--text);
  text-decoration: none;
  font-size: 15px;
  font-weight: 500;
  transition: background 0.12s;
}
.doc .toc-page:hover { background: var(--surface); text-decoration: none; }
.doc .toc-page:hover .toc-icon { background: var(--bg); color: var(--text); }
.toc-page-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.toc-page-arrow {
  width: 15px;
  height: 15px;
  flex: none;
  margin-left: auto;
  color: var(--muted);
  opacity: 0;
  transform: translateX(-4px);
  transition: opacity 0.12s, transform 0.12s;
}
.doc .toc-page:hover .toc-page-arrow { opacity: 1; transform: none; }
.toc-dir { margin: 0; }
.toc-dir > summary {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 12px;
  border-radius: 10px;
  cursor: pointer;
  list-style: none;
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  user-select: none;
  -webkit-user-select: none;
  transition: background 0.12s;
}
.toc-dir > summary::-webkit-details-marker { display: none; }
.toc-dir > summary:hover { background: var(--surface); }
.toc-dir > summary:hover .toc-icon { background: var(--bg); color: var(--text); }
.toc-dir-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.toc-count {
  margin-left: auto;
  flex: none;
  min-width: 20px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--surface);
  border: 1px solid var(--border);
  font-size: 11.5px;
  font-weight: 500;
  text-align: center;
  color: var(--muted);
}
.toc-dir > summary .toc-chevron {
  width: 13px;
  height: 13px;
  flex: none;
  color: var(--muted);
  transition: transform 0.15s;
}
.toc-dir[open] > summary .toc-chevron { transform: rotate(90deg); }
.toc-children {
  margin: 2px 0 6px 27px;
  padding-left: 13px;
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.toc-empty {
  margin-top: 20px;
  padding: 44px 24px;
  border: 1px dashed var(--border);
  border-radius: 12px;
  text-align: center;
  font-size: 14px;
  color: var(--muted);
}
/* Small shares (≤ TOC_CARDS_MAX pages) list every page as a card: the share
   IS the deliverable, so each document gets real presence — bigger tile,
   bigger title, its folder as a quiet subtitle — instead of a sparse tree. */
.toc-cards { gap: 10px; }
.doc .toc-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 15px 18px;
  border: 1px solid var(--border);
  border-radius: 12px;
  color: var(--text);
  text-decoration: none;
  transition: background 0.12s, border-color 0.12s;
}
.doc .toc-card:hover { background: var(--surface); text-decoration: none; }
.doc .toc-card:hover .toc-icon { background: var(--bg); color: var(--text); }
.toc-card .toc-icon { width: 36px; height: 36px; border-radius: 10px; }
.toc-card .toc-icon svg { width: 17px; height: 17px; }
.toc-card-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.toc-card-title {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.01em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.toc-card-path {
  font-size: 12.5px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* A quiet staggered rise on load, so three cards and three hundred rows both
   land with the same life. Top-level rows only, delays capped — deep trees
   don't turn into a marquee. */
@media (prefers-reduced-motion: no-preference) {
  .toc-head, .toc-tree > * { animation: toc-enter 0.4s cubic-bezier(0.16, 1, 0.3, 1) both; }
  .toc-tree > *:nth-child(1) { animation-delay: 60ms; }
  .toc-tree > *:nth-child(2) { animation-delay: 95ms; }
  .toc-tree > *:nth-child(3) { animation-delay: 130ms; }
  .toc-tree > *:nth-child(4) { animation-delay: 165ms; }
  .toc-tree > *:nth-child(5) { animation-delay: 200ms; }
  .toc-tree > *:nth-child(6) { animation-delay: 235ms; }
  .toc-tree > *:nth-child(7) { animation-delay: 270ms; }
  .toc-tree > *:nth-child(n + 8) { animation-delay: 300ms; }
}
@keyframes toc-enter {
  from { opacity: 0; transform: translateY(7px); }
}
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
