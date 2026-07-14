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
//                      A page (or the folder share it belongs to) can carry
//                      named access codes; then these routes serve a code-entry
//                      gate instead until the visitor unlocks (a signed,
//                      HttpOnly cookie per share — see "Visitor access codes"
//                      below).
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
//   POST /<id>/unlock  the gate form target: exchanges a correct access code
//                      for the share's cookie, then 303s back to the page
//   GET  /<id>/edit    the web editor (unlocked sessions whose code can edit)
//   POST /<id>/edit    save a web edit (form body markdown + baseRev; a stale
//                      baseRev re-renders the editor instead of clobbering)
//   POST /<id>/comments                 add a comment (codes that can comment)
//   POST /<id>/comments/<cid>/delete    remove a comment posted by this
//                                       session's own code
//
// Visitor access codes (version 7): a share can be protected with NAMED codes
// ("Acme team" / "sunset-marble-fig"), each individually revocable. The codes
// live INSIDE the page record ({access: {codes: [{id, label, hash}]}}) but are
// server-managed state like `createdAt`: content pushes carry them forward
// untouched and can never strip protection — only the /access API below
// changes them. Codes are stored as SHA-256 hashes; a folder share's codes
// cover its member pages via their existing `collection` back-reference (a
// member's own codes, if any, take precedence). Unlocking sets a per-share
// HttpOnly cookie signed with a random key the worker mints on first use
// (auth/gate-key.json — no new wrangler secret to configure). Revoking a code
// kills exactly the sessions minted from it, on their very next request. The
// gate page itself is deliberately generic: no title, no description, no OG
// image — nothing about the document leaks before the code.
//
// Code roles (version 8): every access code carries a role — "view" (the
// default, exactly what codes always were), "comment", or "edit" — so a
// restricted share can hand each named person/group its own level of access.
// The unlock cookie names the code; the code's CURRENT entry supplies the
// role on every request, so changing a role (or revoking the code) applies
// on the visitor's next request with no session registry. Unprotected shares
// stay read-only: there is no named identity to grant anything to.
//
//   comment  the public page grows a comments section (server-rendered,
//            works without JS): post, read, and delete your own code's
//            comments. Comments live in their own object
//            (pages/<id>.comments.json) so content pushes never touch them.
//   edit     everything "comment" gets, plus /<id>/edit — a markdown editor
//            for the page. Saves are CAS-guarded by the page's `rev` (a
//            counter bumped on every content write): a concurrent save gets
//            the editor back with a warning, never a silent clobber. A web
//            edit stamps the record {webEdit: {by, at}} and, when the page
//            also carries an html rendition, marks it stale (the markdown
//            becomes the default view until the app pushes a fresh
//            rendition). The desktop app pulls web edits back into the local
//            file (GET /api/pages/<id>/content) and its pushes can send
//            baseRev to detect web edits it hasn't seen (409 on mismatch,
//            only while a web edit is unseen — device-to-device pushes keep
//            their last-writer-wins behavior).
//
// Write API (Authorization: Bearer $SHARE_TOKEN — the desktop app only):
//   GET    /api/meta             worker version + feature list, so the app can
//                                tell an outdated deployment from a broken one
//   GET    /api/site             the site config (landing branding + root page)
//   PUT    /api/site             body {ownerName?, ownerLink?, downloadUrl?,
//                                rootPageId?} — full record every time, like
//                                page pushes (a missing field means unset)
//   GET    /api/pages            list shared pages (id, title, updatedAt)
//   GET    /api/pages/<id>       page metadata (existence check; includes rev
//                                + webEdit so the app can spot web edits)
//   GET    /api/pages/<id>/content   the stored markdown + rev/webEdit — how
//                                the app pulls a web edit into the local file
//   GET    /api/pages/<id>/comments  every visitor comment on the page
//   DELETE /api/pages/<id>/comments[/<cid>]  moderate: drop one (or all)
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
//   GET    /api/pages/<id>/access            the share's codes (ids + labels
//                                            + roles, never hashes)
//   POST   /api/pages/<id>/access/codes      body {label?, code, role?} — add
//                                            a named code (the worker stores
//                                            its hash; role defaults to view)
//   PATCH  /api/pages/<id>/access/codes/<cid>  body {label?, role?} — rename
//                                            a code or change what it may do
//   DELETE /api/pages/<id>/access/codes/<cid>  revoke one code (and exactly
//                                            the visitor sessions it minted)
//   DELETE /api/pages/<id>/access            remove protection entirely
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
//   POST /api/admin/wipe         body {confirm:"wipe"} — erase EVERYTHING in
//                                the bucket (pages, workspaces, credentials,
//                                site config), batched like workspace delete;
//                                repeat while `remaining`. The teardown step
//                                before deleting the worker + bucket, since
//                                R2 refuses to delete a non-empty bucket
//                                (owner)
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
import { FAVICON_ICO_B64, APPLE_TOUCH_PNG_B64 } from "./favicons.js";
import { injectCommentBridge, SHELL_COMMENTS_SCRIPT } from "./webComments.js";

// Bumped when the API grows; GET /api/meta reports it. 1 = pages+collections
// (never had /api/meta, so the app infers it from a 404), 2 = site config +
// root page override, 3 = collection descriptions, 4 = cloud sync + member
// tokens, 5 = workspace-stamped pages (any member of the workspace can
// update/stop them, not just their creator), 6 = admin wipe (the app-driven
// erase step of backend teardown), 7 = visitor access codes (the public gate),
// 8 = code roles (view/comment/edit) + web comments + the web editor,
// 9 = comments on html renditions (the html view of a pair grows the same
// comments section, and comments can anchor to an element of the rendition).
const WORKER_VERSION = 9;
const WORKER_FEATURES = [
  "pages",
  "collections",
  "site",
  "root-page",
  "collection-description",
  "sync",
  "auth",
  "workspace-pages",
  "wipe",
  "page-access",
  "access-roles",
  "web-comments",
  "web-edit",
  "html-comments",
];

const ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const RESERVED = new Set(["api", "join", "robots.txt", "favicon.ico"]);

// Brand favicon: served from the worker (bytes embedded in favicons.js) and
// linked from every page head. A multi-res .ico covers browser tabs/bookmarks
// (and the automatic /favicon.ico request), plus an apple-touch-icon for iOS.
const FAVICON_LINKS = `<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">`;
const FAVICON_ICO_BYTES = Uint8Array.from(atob(FAVICON_ICO_B64), (c) => c.charCodeAt(0));
const APPLE_TOUCH_BYTES = Uint8Array.from(atob(APPLE_TOUCH_PNG_B64), (c) => c.charCodeAt(0));

function iconResponse(bytes, contentType) {
  return new Response(bytes, {
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=604800, immutable",
    },
  });
}
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

/* Visitor access codes. Codes are human-typed secrets, so the guardrails do
   the heavy lifting: normalized before hashing (trim/lowercase/NFKC — phone
   keyboards auto-capitalize), stored only as SHA-256, compared in constant
   time, and the unlock endpoint is rate-limited like /api/auth/join. The
   session cookie is HMAC-signed with a random key minted into the bucket on
   first use, and bound to the specific code that opened it — revoking a code
   revokes exactly its sessions. */
const MAX_ACCESS_CODES = 20;
const MIN_ACCESS_CODE_LEN = 4;
const MAX_ACCESS_CODE_LEN = 128;
const ACCESS_CODE_ID_RE = /^a-[a-f0-9]{8}$/;
const GATE_KEY_KEY = "auth/gate-key.json";
const GATE_COOKIE_TTL_S = 30 * 24 * 60 * 60; // unlock lasts 30 days per browser
const UNLOCK_RATE_LIMIT = 10; // code attempts per IP per minute (per isolate)

/* Web comments + edits (version 8). Comments live in pages/<id>.comments.json
   — their own object, so content pushes and comment posts never race each
   other. Both surfaces exist only behind the gate (a session names the code
   that unlocked it, the code's role says what it may do), and both are plain
   form posts, so they work without JS like the gate does. */
const COMMENT_ID_RE = /^m-[a-f0-9]{8}$/;
const MAX_COMMENT_BODY = 4000;
const MAX_COMMENT_QUOTE = 300;
const MAX_COMMENTS = 500;
// An anchored comment points at an element of the html rendition: a
// structural selector plus the element's tag and leading text (the
// re-anchoring fallback). Byte-compatible with the app's sidecar anchors
// (src/htmlComments.ts), so the same comment resolves in both places.
const MAX_ANCHOR_PATH = 600;
const MAX_ANCHOR_TAG = 32;
const MAX_ANCHOR_TEXT = 200;

// The anchor carried by a comment (form fields or a stored entry), or null.
// Requires the structural pieces; text may be empty (bare structural anchor).
function sanitizeAnchor(path, tag, text) {
  if (typeof path !== "string" || typeof tag !== "string") return null;
  const cleanPath = path.trim().slice(0, MAX_ANCHOR_PATH);
  const cleanTag = tag.trim().toLowerCase().slice(0, MAX_ANCHOR_TAG);
  if (!cleanPath || !/^[a-z][a-z0-9-]*$/.test(cleanTag)) return null;
  const cleanText =
    typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, MAX_ANCHOR_TEXT) : "";
  return { path: cleanPath, tag: cleanTag, text: cleanText };
}
const COMMENT_RATE_LIMIT = 10; // posts per IP per minute (per isolate)
const EDIT_RATE_LIMIT = 20; // saves per IP per minute (per isolate)

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
  "access-control-allow-methods": "GET,PUT,POST,PATCH,DELETE,OPTIONS",
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

    // The gate form's POST target.
    const unlockMatch = path.match(/^\/([a-z0-9-]{1,64})\/unlock$/);
    if (unlockMatch && validId(unlockMatch[1])) {
      return handleUnlock(request, env, unlockMatch[1], url);
    }

    // Comment forms (unlocked sessions whose code can comment) — POSTs, like
    // the gate.
    const commentAddMatch = path.match(/^\/([a-z0-9-]{1,64})\/comments$/);
    if (commentAddMatch && validId(commentAddMatch[1])) {
      return handleCommentAdd(request, env, commentAddMatch[1], url);
    }
    const commentDelMatch = path.match(/^\/([a-z0-9-]{1,64})\/comments\/(m-[a-f0-9]{8})\/delete$/);
    if (commentDelMatch && validId(commentDelMatch[1])) {
      return handleCommentDelete(request, env, commentDelMatch[1], commentDelMatch[2], url);
    }

    // The web editor (unlocked sessions whose code can edit): GET renders it,
    // POST saves.
    const editMatch = path.match(/^\/([a-z0-9-]{1,64})\/edit$/);
    if (editMatch && validId(editMatch[1])) {
      return handleEdit(request, env, editMatch[1], url);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", { status: 405 });
    }
    if (path === "/") return serveRoot(request, env, url);
    if (path === "/join") return joinPage(env, url);
    if (path === "/robots.txt") {
      return new Response("User-agent: *\nAllow: /\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    if (path === "/favicon.ico") return iconResponse(FAVICON_ICO_BYTES, "image/x-icon");
    if (path === "/apple-touch-icon.png") return iconResponse(APPLE_TOUCH_BYTES, "image/png");

    const ogMatch = path.match(/^\/([a-z0-9-]{1,64})\/og\.png$/);
    if (ogMatch && validId(ogMatch[1])) return serveOgImage(request, env, ogMatch[1]);

    const rawMatch = path.match(/^\/([a-z0-9-]{1,64})\/raw$/);
    if (rawMatch && validId(rawMatch[1])) return serveRawHtml(request, env, rawMatch[1]);

    const pageMatch = path.match(/^\/([a-z0-9-]{1,64})$/);
    if (pageMatch && validId(pageMatch[1])) {
      return servePage(request, env, pageMatch[1], url);
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

  if (parts[1] === "admin" && parts[2] === "wipe" && parts.length === 3) {
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    if (auth.role !== "owner") return json({ error: "owner only" }, 403);
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid json body" }, 400);
    }
    if (body?.confirm !== "wipe") {
      return json({ error: 'body must be {"confirm":"wipe"}' }, 400);
    }
    return wipeBucket(env, auth);
  }

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
        protected: sanitizeAccess(data.access) !== null,
        rev: pageRev(data),
        webEdit: publicWebEdit(data),
        htmlStale: data.htmlStale === true,
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
        const wsReq = requestedPageWs(body, auth);
        if (wsReq.error) return wsReq.error;
        // The stamp sticks once set: a push that omits `ws` (an older app, a
        // device that hasn't learned of the share's workspace yet) must not
        // strip the collectively-managed bit off the page.
        const wsStamp = wsReq.ws ?? pageWorkspaceOf(existing);
        const prior = existing ? await existing.json().catch(() => null) : null;
        // Access codes are server-managed (only the /access API writes them);
        // a content push — whatever its body claims — carries them forward, so
        // an autosave can never strip protection off a share.
        const access = sanitizeAccess(prior?.access);
        const now = new Date().toISOString();
        const record = {
          kind: "collection",
          title,
          ...(description ? { description } : {}),
          items,
          ...(access ? { access } : {}),
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
            ...(wsStamp ? { ws: wsStamp } : {}),
            ...(access ? { protected: "1" } : {}),
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

      // CAS-retried like the /access API: a web edit landing between this
      // read and the put must not be silently overwritten — the etag condition
      // makes the race re-run the baseRev check against the fresh record.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const existing = await env.PAGES.get(pageKey);
        if (!canTouchPage(auth, existing)) {
          return json({ error: "page belongs to another member" }, 403);
        }
        const wsReq = requestedPageWs(body, auth);
        if (wsReq.error) return wsReq.error;
        // Sticky, same as collections above — the ws stamp and the access codes.
        const wsStamp = wsReq.ws ?? pageWorkspaceOf(existing);
        const prior = existing ? await existing.json().catch(() => null) : null;
        const access = sanitizeAccess(prior?.access);
        // The app can send the rev its copy is based on; a mismatch is only a
        // conflict while the newer rev came from the WEB (a web edit the app
        // hasn't pulled). Device-to-device pushes keep last-writer-wins — the
        // synced file is their shared truth, the page just mirrors it.
        const priorRev = prior ? pageRev(prior) : 0;
        const webEdit = prior ? publicWebEdit(prior) : null;
        if (typeof body.baseRev === "number" && webEdit && body.baseRev !== priorRev) {
          return json({ error: "page was edited on the web", rev: priorRev, webEdit }, 409);
        }
        const now = new Date().toISOString();
        // An app push clears the webEdit stamp (the app has seen or chosen to
        // override it). The html-stale flag survives until the html itself is
        // replaced: re-pushing the same pre-edit rendition must not promote it
        // back to the default view over the newer markdown.
        const htmlStale = html !== null && prior?.htmlStale === true && prior?.html === html;
        const record = {
          title,
          ...(markdown !== null ? { markdown } : {}),
          ...(html !== null ? { html } : {}),
          ...(htmlStale ? { htmlStale: true } : {}),
          ...(collection ? { collection } : {}),
          ...(access ? { access } : {}),
          rev: priorRev + 1,
          createdAt: prior?.createdAt ?? now,
          updatedAt: now,
        };
        const put = await env.PAGES.put(pageKey, JSON.stringify(record), {
          httpMetadata: { contentType: "application/json" },
          customMetadata: {
            title: title.slice(0, 256),
            updatedAt: now,
            createdAt: record.createdAt,
            owner: pageOwner(auth, existing),
            rev: String(record.rev),
            ...(wsStamp ? { ws: wsStamp } : {}),
            ...(access ? { protected: "1" } : {}),
          },
          ...(existing ? { onlyIf: { etagMatches: existing.etag } } : {}),
        });
        if (put) {
          return json({
            id,
            url: `${url.origin}/${id}`,
            createdAt: record.createdAt,
            updatedAt: now,
            rev: record.rev,
          });
        }
        // Lost a race (web edit / code change) — re-read and re-apply.
      }
      return json({ error: "conflict, retry" }, 409);
    }
    if (request.method === "DELETE") {
      if (auth.role !== "owner") {
        const existing = await env.PAGES.get(pageKey);
        if (!canTouchPage(auth, existing)) {
          return json({ error: "page belongs to another member" }, 403);
        }
      }
      await env.PAGES.delete([pageKey, ogKey, commentsKey(id)]);
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

  // The stored document + rev bookkeeping — how the app pulls a web edit back
  // into the local file. Same permission rule as pushing (canTouchPage).
  if (parts.length === 4 && parts[3] === "content") {
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
    const existing = await env.PAGES.get(pageKey);
    if (!existing) return json({ error: "not found" }, 404);
    if (!canTouchPage(auth, existing)) {
      return json({ error: "page belongs to another member" }, 403);
    }
    const data = await existing.json().catch(() => null);
    if (!data || typeof data !== "object") return json({ error: "not found" }, 404);
    return json({
      id,
      title: data.title ?? "Untitled",
      markdown: typeof data.markdown === "string" ? data.markdown : null,
      hasHtml: typeof data.html === "string" && data.html.length > 0,
      htmlStale: data.htmlStale === true,
      rev: pageRev(data),
      webEdit: publicWebEdit(data),
      protected: sanitizeAccess(data.access) !== null,
    });
  }

  // Visitor comments, owner side: read them all, moderate one, or clear the
  // page's slate. Writes CAS the comments object like every shared record.
  if (parts[3] === "comments" && (parts.length === 4 || parts.length === 5)) {
    const existing = await env.PAGES.get(pageKey);
    if (!existing) return json({ error: "not found" }, 404);
    if (!canTouchPage(auth, existing)) {
      return json({ error: "page belongs to another member" }, 403);
    }
    if (parts.length === 4) {
      if (request.method === "GET") {
        return json({ id, comments: await readComments(env, id) });
      }
      if (request.method === "DELETE") {
        await env.PAGES.delete(commentsKey(id));
        return json({ id, deleted: true });
      }
      return json({ error: "method not allowed" }, 405);
    }
    if (request.method !== "DELETE") return json({ error: "method not allowed" }, 405);
    const cid = parts[4];
    if (!COMMENT_ID_RE.test(cid)) return json({ error: "no such comment" }, 404);
    const removed = await removeComment(env, id, cid, null);
    if (removed === "missing") return json({ error: "no such comment" }, 404);
    if (removed === "conflict") return json({ error: "conflict, retry" }, 409);
    return json({ id: cid, deleted: true });
  }

  if (parts[3] === "access") {
    return handleAccessApi(request, env, parts, auth, id, pageKey);
  }

  return json({ error: "not found" }, 404);
}

/* Manage a share's visitor access codes. Same permission rule as updating the
   page itself (canTouchPage): whoever may keep a page fresh may also decide
   who gets to read it. The plaintext code exists only in the POST body — the
   record stores its hash, GET returns ids + labels. Writes are CAS-retried
   against the page's etag so a concurrent autosave push can't be clobbered by
   (or clobber) a code change. */
async function handleAccessApi(request, env, parts, auth, id, pageKey) {
  // ["api", "pages", id, "access"] (+ ["codes", cid?])
  const sub = parts[4];
  const wantsList = parts.length === 4;
  const wantsAdd = parts.length === 5 && sub === "codes";
  const wantsCode = parts.length === 6 && sub === "codes"; // revoke or update one
  if (!wantsList && !wantsAdd && !wantsCode) return json({ error: "not found" }, 404);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await env.PAGES.get(pageKey);
    if (!existing) return json({ error: "not found" }, 404);
    if (!canTouchPage(auth, existing)) {
      return json({ error: "page belongs to another member" }, 403);
    }
    const record = await existing.json().catch(() => null);
    if (!record || typeof record !== "object") return json({ error: "not found" }, 404);
    const access = sanitizeAccess(record.access);
    const codes = access ? access.codes : [];

    if (wantsList) {
      if (request.method === "GET") return json(accessSummary(id, codes));
      if (request.method !== "DELETE") return json({ error: "method not allowed" }, 405);
    }

    let nextCodes;
    let result;
    if (wantsAdd) {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid json body" }, 400);
      }
      const code = normalizeAccessCode(body.code);
      if (code.length < MIN_ACCESS_CODE_LEN || code.length > MAX_ACCESS_CODE_LEN) {
        return json(
          { error: `code must be ${MIN_ACCESS_CODE_LEN}–${MAX_ACCESS_CODE_LEN} characters` },
          400,
        );
      }
      const role = parseAccessRole(body.role);
      if (!role) return json({ error: "role must be view, comment, or edit" }, 400);
      if (codes.length >= MAX_ACCESS_CODES) return json({ error: "too many codes" }, 409);
      const hash = await sha256Hex(code);
      // Two identical codes would make revocation misleading (removing one
      // label still leaves the same string working under another).
      if (codes.some((c) => c.hash === hash)) {
        return json({ error: "that code is already set on this page" }, 409);
      }
      const entry = {
        id: `a-${randomHex(4)}`,
        label: validName(body.label, "Access code"),
        hash,
        ...(role !== "view" ? { role } : {}),
        createdAt: new Date().toISOString(),
      };
      nextCodes = [...codes, entry];
      result = { id: entry.id, label: entry.label, role, createdAt: entry.createdAt };
    } else if (wantsCode && request.method === "PATCH") {
      // Rename a code or change its role. The role reads live on every public
      // request, so a downgrade bites the visitor's very next click.
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid json body" }, 400);
      }
      const target = codes.find((c) => c.id === parts[5]);
      if (!ACCESS_CODE_ID_RE.test(parts[5]) || !target) {
        return json({ error: "no such code" }, 404);
      }
      const role = body.role === undefined ? accessCodeRole(target) : parseAccessRole(body.role);
      if (!role) return json({ error: "role must be view, comment, or edit" }, 400);
      const label = body.label === undefined ? target.label : validName(body.label, "Access code");
      const updated = { ...target, label };
      delete updated.role;
      if (role !== "view") updated.role = role;
      nextCodes = codes.map((c) => (c.id === target.id ? updated : c));
      result = { id: target.id, label, role, createdAt: target.createdAt ?? null };
    } else if (wantsCode) {
      if (request.method !== "DELETE") return json({ error: "method not allowed" }, 405);
      if (!ACCESS_CODE_ID_RE.test(parts[5]) || !codes.some((c) => c.id === parts[5])) {
        return json({ error: "no such code" }, 404);
      }
      nextCodes = codes.filter((c) => c.id !== parts[5]);
      result = { id: parts[5], deleted: true };
    } else {
      // wantsList + DELETE: drop protection entirely.
      if (request.method !== "DELETE") return json({ error: "method not allowed" }, 405);
      nextCodes = [];
      result = { id, deleted: true };
    }

    // Rewrite the record with only the access section changed. updatedAt stays
    // put — a code change is not a content change, and the listing sorts by it.
    const next = { ...record };
    if (nextCodes.length > 0) {
      next.access = { codes: nextCodes, updatedAt: new Date().toISOString() };
    } else {
      delete next.access;
    }
    const meta = { ...(existing.customMetadata ?? {}) };
    delete meta.protected;
    if (nextCodes.length > 0) meta.protected = "1";
    const put = await env.PAGES.put(pageKey, JSON.stringify(next), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: meta,
      onlyIf: { etagMatches: existing.etag },
    });
    if (put) return json(result);
    // Lost a race with a content push — re-read and re-apply.
  }
  return json({ error: "conflict, retry" }, 409);
}

function accessSummary(id, codes) {
  return {
    id,
    protected: codes.length > 0,
    codes: codes.map((c) => ({
      id: c.id,
      label: c.label ?? "",
      role: accessCodeRole(c),
      createdAt: c.createdAt ?? null,
    })),
  };
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
      // A member's view of the backend is their own pages plus every page
      // stamped with a workspace they're in; the full catalog (including the
      // owner's and other members') is the owner's to see.
      if (
        auth.role !== "owner" &&
        obj.customMetadata?.owner !== auth.tokenId &&
        !(pageWorkspaceOf(obj) !== null && canAccessWs(auth, pageWorkspaceOf(obj)))
      ) {
        continue;
      }
      const revMeta = Number(obj.customMetadata?.rev);
      pages.push({
        id: m[1],
        title: obj.customMetadata?.title ?? "Untitled",
        createdAt: obj.customMetadata?.createdAt ?? null,
        updatedAt: obj.customMetadata?.updatedAt ?? obj.uploaded?.toISOString?.() ?? null,
        protected: obj.customMetadata?.protected === "1",
        // Rev + web-edit stamp ride the listing so the app can spot pages
        // edited on the web with ONE request per backend, not one per page.
        rev: Number.isInteger(revMeta) && revMeta > 0 ? revMeta : null,
        webEdit:
          obj.customMetadata?.webEdit === "1"
            ? {
                by: obj.customMetadata?.webEditBy ?? "",
                at: obj.customMetadata?.webEditAt ?? null,
              }
            : null,
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
  if (existing.customMetadata?.owner === auth.tokenId) return true;
  // A page published from a synced workspace is stamped with that workspace's
  // id and managed collectively: the folder's files are everyone's to edit,
  // so keeping their public pages fresh (or stopping them) is too.
  return pageWorkspaceOf(existing) !== null && canAccessWs(auth, pageWorkspaceOf(existing));
}

function pageOwner(auth, existing) {
  return existing?.customMetadata?.owner ?? auth.tokenId;
}

// The workspace stamp on a stored page, or null. Shape-checked here once so
// every consumer (touch checks, listings) agrees on what counts as stamped.
function pageWorkspaceOf(existing) {
  const ws = existing?.customMetadata?.ws;
  return typeof ws === "string" && SYNC_ID_RE.test(ws) ? ws : null;
}

// The `ws` field of a page PUT: absent is fine (not every page belongs to a
// workspace), but a claimed workspace must be real-shaped and actually
// granted to the writer — otherwise stamping would be an access-escalation
// lever (stamp a page with someone else's workspace, its members can now
// touch it… which is exactly what the writer wants to GRANT, so the check is
// about the writer having the right to speak for that workspace).
function requestedPageWs(body, auth) {
  if (typeof body.ws !== "string" || body.ws.length === 0) return { ws: null };
  if (!SYNC_ID_RE.test(body.ws)) return { error: json({ error: "invalid ws" }, 400) };
  if (!canAccessWs(auth, body.ws)) {
    return { error: json({ error: "no access to that workspace" }, 403) };
  }
  return { ws: body.ws };
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

/* Joins and gate unlocks are the only unauthenticated writes on the worker,
   so each gets a (per-isolate, best-effort) per-IP rate limit — belt and
   suspenders on top of the 256-bit invite code, and the actual line of
   defense behind human-sized access codes. */
const joinAttempts = new Map(); // ip -> [timestamps]
const unlockAttempts = new Map(); // ip -> [timestamps]

function rateLimited(attempts, request, limit) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const now = Date.now();
  const recent = (attempts.get(ip) || []).filter((t) => now - t < 60_000);
  recent.push(now);
  attempts.set(ip, recent);
  if (attempts.size > 10_000) attempts.clear(); // unbounded-growth guard
  return recent.length > limit;
}

async function handleJoin(request, env, url) {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (rateLimited(joinAttempts, request, JOIN_RATE_LIMIT)) {
    return json({ error: "too many attempts, retry later" }, 429);
  }

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
  // Share metadata (app-managed; the worker never renders from it): which
  // files are published as public pages, and the folder shares (collections)
  // they roll up into. A share may reference a fileId that no longer exists
  // in `files` — a deleted file's page stays live until explicitly stopped,
  // so its registry entry outlives it. Validation is deliberately shallow:
  // version-4 workers stored these sections without looking, so a newer
  // worker must never be the stricter one about shape it doesn't consume.
  if (data.shares !== undefined) {
    if (typeof data.shares !== "object" || Array.isArray(data.shares)) {
      return "shares must be an object";
    }
    const ids = Object.keys(data.shares);
    if (ids.length > MAX_MANIFEST_FILES) return "too many shares";
    for (const fid of ids) {
      if (!SYNC_ID_RE.test(fid)) return `invalid share key: ${fid}`;
      const s = data.shares[fid];
      if (!s || typeof s !== "object") return `invalid share for ${fid}`;
      if (typeof s.id !== "string" || !ID_RE.test(s.id)) return `invalid share id for ${fid}`;
      if (!validSyncPath(s.path)) return `invalid share path for ${fid}`;
      if (s.cid !== undefined && (typeof s.cid !== "string" || !ID_RE.test(s.cid))) {
        return `invalid share cid for ${fid}`;
      }
      if (s.title !== undefined && (typeof s.title !== "string" || s.title.length > 300)) {
        return `invalid share title for ${fid}`;
      }
    }
  }
  if (data.collections !== undefined) {
    if (typeof data.collections !== "object" || Array.isArray(data.collections)) {
      return "collections must be an object";
    }
    const ids = Object.keys(data.collections);
    if (ids.length > 500) return "too many collections";
    for (const cid of ids) {
      if (!ID_RE.test(cid)) return `invalid collection key: ${cid}`;
      const c = data.collections[cid];
      if (!c || typeof c !== "object") return `invalid collection for ${cid}`;
      // "" = the workspace root itself is the shared folder.
      if (typeof c.path !== "string" || (c.path !== "" && !validSyncPath(c.path))) {
        return `invalid collection path for ${cid}`;
      }
      if (typeof c.title !== "string" || c.title.length > 300) {
        return `invalid collection title for ${cid}`;
      }
      if (c.desc !== undefined && (typeof c.desc !== "string" || c.desc.length > 600)) {
        return `invalid collection desc for ${cid}`;
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

// The erase half of tearing a backend down: delete every object in the
// bucket so `wrangler r2 bucket delete` (which refuses non-empty buckets)
// can finish the job. Batched like deleteWorkspace — the client repeats the
// call until `remaining` comes back false. The caller's own token object is
// kept until everything else is gone and deleted in the final round, so a
// linked-device owner doesn't cut itself off mid-wipe.
async function wipeBucket(env, auth) {
  let deleted = 0;
  for (let round = 0; round < 20; round += 1) {
    const batch = await env.PAGES.list({ limit: 1000 });
    const keys = batch.objects.map((o) => o.key).filter((k) => k !== auth.key);
    if (keys.length === 0) {
      if (auth.key) {
        await env.PAGES.delete(auth.key);
        deleted += 1;
      }
      return json({ wiped: true, purged: deleted, remaining: false });
    }
    await env.PAGES.delete(keys);
    deleted += keys.length;
    if (!batch.truncated && batch.objects.length < 1000) {
      if (auth.key) {
        await env.PAGES.delete(auth.key);
        deleted += 1;
      }
      return json({ wiped: true, purged: deleted, remaining: false });
    }
  }
  return json({ wiped: true, purged: deleted, remaining: true });
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

/* ---------- Visitor access codes: the public gate ----------

   A protected share's public routes serve a code-entry gate until the browser
   holds that share's cookie. The cookie is a compact signed claim —
   v1.<codeId>.<exp>.<hmac> — verified statelessly against a random signing
   key minted into the bucket on first use, PLUS a liveness check that the
   code it names still exists on the share. So sessions cost no storage, yet
   revoking a code (deleting its entry) kills exactly the sessions it minted,
   on their next request. Rotating nothing else: other codes' visitors stay
   signed in.

   The submitted code is normalized (trim, lowercase, NFKC) before hashing —
   these are human-relayed secrets, and a phone keyboard's auto-capitalize
   must not lock anyone out. The app normalizes identically when creating. */

function normalizeAccessCode(raw) {
  if (typeof raw !== "string") return "";
  return raw.trim().toLowerCase().normalize("NFKC");
}

// The access section of a stored page record, shape-checked — or null when
// absent/malformed/empty. Every consumer (gate checks, sticky merges, the
// /access API) goes through this, so a corrupt section reads as "unprotected"
// everywhere at once rather than crashing renders.
function sanitizeAccess(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.codes)) return null;
  const codes = [];
  for (const c of raw.codes) {
    if (!c || typeof c !== "object") continue;
    if (typeof c.id !== "string" || !ACCESS_CODE_ID_RE.test(c.id)) continue;
    if (typeof c.hash !== "string" || !/^[a-f0-9]{64}$/.test(c.hash)) continue;
    if (codes.some((seen) => seen.id === c.id)) continue;
    codes.push({
      id: c.id,
      label: typeof c.label === "string" ? c.label.slice(0, MAX_NAME_LEN) : "",
      hash: c.hash,
      // "view" is the absent default — only the two grants are stored, so
      // records written by older workers mean exactly what they always did.
      ...(c.role === "comment" || c.role === "edit" ? { role: c.role } : {}),
      ...(typeof c.createdAt === "string" ? { createdAt: c.createdAt } : {}),
    });
    if (codes.length >= MAX_ACCESS_CODES) break;
  }
  if (codes.length === 0) return null;
  return {
    codes,
    ...(typeof raw.updatedAt === "string" ? { updatedAt: raw.updatedAt } : {}),
  };
}

// What a stored code may do on the public page. Absent/unknown = "view".
function accessCodeRole(c) {
  return c?.role === "comment" || c?.role === "edit" ? c.role : "view";
}

// A role as claimed by an API body: absent/"view" normalizes to "view", the
// two grants pass through, anything else is a caller error (null).
function parseAccessRole(raw) {
  if (raw === undefined || raw === null || raw === "" || raw === "view") return "view";
  return raw === "comment" || raw === "edit" ? raw : null;
}

// The page's content revision: bumped on every content write (app push or web
// edit). Records from before version 8 read as rev 1.
function pageRev(record) {
  return Number.isInteger(record?.rev) && record.rev > 0 ? record.rev : 1;
}

// The web-edit stamp, shape-checked for API responses: set when the LAST
// content write came from the web editor, cleared by the next app push.
function publicWebEdit(record) {
  const w = record?.webEdit;
  if (!w || typeof w !== "object" || typeof w.by !== "string") return null;
  return { by: w.by.slice(0, MAX_NAME_LEN), at: typeof w.at === "string" ? w.at : null };
}

// The signing key for gate cookies: random, minted lazily into the bucket —
// no wrangler secret to configure, dashboard-only deployments included. Two
// isolates racing the first unlock both write, then read back the winner, so
// they converge; the one visitor whose cookie was signed by the losing key
// just re-enters the code once.
async function gateSigningKey(env) {
  let obj = await env.PAGES.get(GATE_KEY_KEY);
  if (!obj) {
    await env.PAGES.put(
      GATE_KEY_KEY,
      JSON.stringify({ key: randomHex(32), createdAt: new Date().toISOString() }),
      { httpMetadata: { contentType: "application/json" } },
    );
    obj = await env.PAGES.get(GATE_KEY_KEY);
  }
  const rec = obj ? await obj.json().catch(() => null) : null;
  return typeof rec?.key === "string" && rec.key.length >= 32 ? rec.key : null;
}

async function gateSig(key, gateId, codeId, exp) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(`${gateId}.${codeId}.${exp}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const gateCookieName = (gateId) => `dk_a_${gateId}`;

// Which access config guards this page, if any: its own codes win; otherwise
// a folder-share member inherits the folder's codes through the `collection`
// back-reference it already carries (so one unlock opens the whole folder —
// the cookie is scoped to the collection id both sides agree on).
async function accessGateFor(env, id, data) {
  const own = sanitizeAccess(data.access);
  if (own) return { gateId: id, access: own };
  const cid =
    data.collection && typeof data.collection.id === "string" && validId(data.collection.id)
      ? data.collection.id
      : null;
  if (!cid) return null;
  const colObj = await env.PAGES.get(`pages/${cid}.json`);
  const col = colObj ? await colObj.json().catch(() => null) : null;
  const colAccess = col ? sanitizeAccess(col.access) : null;
  return colAccess ? { gateId: cid, access: colAccess } : null;
}

// The live session behind a request, or null. Stateless HMAC check plus "the
// code that minted it still exists" — revocation needs no session registry.
// The returned role/label come from the code's CURRENT entry (never from the
// cookie), so a role change also applies on the very next request.
async function gateSession(request, env, gate) {
  const header = request.headers.get("cookie") || "";
  const wanted = `${gateCookieName(gate.gateId)}=`;
  let value = null;
  for (const part of header.split(/;\s*/)) {
    if (part.startsWith(wanted)) {
      value = part.slice(wanted.length);
      break;
    }
  }
  if (!value) return null;
  const m = value.match(/^v1\.(a-[a-f0-9]{8})\.(\d{1,12})\.([a-f0-9]{64})$/);
  if (!m) return null;
  const [, codeId, expRaw, sig] = m;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return null;
  const code = gate.access.codes.find((c) => c.id === codeId);
  if (!code) return null;
  const key = await gateSigningKey(env);
  if (!key) return null;
  if (!timingEq(sig, await gateSig(key, gate.gateId, codeId, exp))) return null;
  return { codeId: code.id, role: accessCodeRole(code), label: code.label || "Access code" };
}

async function gateCookieValid(request, env, gate) {
  return (await gateSession(request, env, gate)) !== null;
}

// Where the gate sends the visitor after a correct code. Site-relative page
// paths (or a page's /edit) only — this rides a hidden form field, so it must
// never become an open redirect.
function safeNext(raw, gateId) {
  if (
    typeof raw === "string" &&
    /^\/(?:[a-z0-9-]{1,64}(?:\/edit)?)?(?:\?v=md)?$/.test(raw)
  ) {
    return raw;
  }
  return `/${gateId}`;
}

// POST /<gateId>/unlock — the gate form's target. Verifies the code against
// the share's stored hashes and answers with the cookie + a 303 back to
// `next`. GETs redirect to the page (someone typed the URL); wrong codes
// re-render the gate with an error, rate-limited per IP like /api/auth/join.
async function handleUnlock(request, env, id, url) {
  if (request.method === "GET" || request.method === "HEAD") {
    return new Response(null, { status: 303, headers: { location: `/${id}` } });
  }
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  const obj = await env.PAGES.get(`pages/${id}.json`);
  if (!obj) return notFoundPage();
  const data = await obj.json().catch(() => null);
  const access = data ? sanitizeAccess(data.access) : null;

  let form;
  try {
    form = await request.formData();
  } catch {
    return gatePage(id, `/${id}`, url, { status: 400, error: "That didn't work — try again." });
  }
  const next = safeNext(form.get("next"), id);
  // Not protected (anymore): nothing to unlock, just go where they were headed.
  if (!access) {
    return new Response(null, { status: 303, headers: { location: next } });
  }

  if (rateLimited(unlockAttempts, request, UNLOCK_RATE_LIMIT)) {
    return gatePage(id, next, url, {
      status: 429,
      error: "Too many attempts — wait a minute, then try again.",
    });
  }

  const submitted = normalizeAccessCode(form.get("code"));
  if (!submitted) {
    return gatePage(id, next, url, { status: 401, error: "Enter an access code." });
  }
  const hash = await sha256Hex(submitted);
  let matched = null;
  for (const c of access.codes) {
    if (timingEq(hash, c.hash)) matched = c;
  }
  if (!matched) {
    return gatePage(id, next, url, {
      status: 401,
      error: "That code didn't match. Codes aren't case-sensitive — check for typos and try again.",
    });
  }

  const key = await gateSigningKey(env);
  if (!key) {
    return gatePage(id, next, url, { status: 500, error: "Something went wrong — try again." });
  }
  const exp = Math.floor(Date.now() / 1000) + GATE_COOKIE_TTL_S;
  const sig = await gateSig(key, id, matched.id, exp);
  return new Response(null, {
    status: 303,
    headers: {
      location: next,
      "set-cookie": `${gateCookieName(id)}=v1.${matched.id}.${exp}.${sig}; Path=/; Max-Age=${GATE_COOKIE_TTL_S}; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}

// The code-entry page. Deliberately generic — no document title, no derived
// description, no OG image reference: nothing about the content leaks until
// the code is right. Plain form, works without JS; with JS, a #c=<code>
// fragment (the app's "copy link + code" format — fragments never reach
// servers or logs, same trick as /join) fills and submits it automatically.
function gatePage(gateId, next, url, { status = 401, error = null } = {}) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${FAVICON_LINKS}
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Protected page</title>
<meta name="description" content="This page requires an access code.">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${escapeHtml(url.hostname)}">
<meta property="og:title" content="Protected page">
<meta property="og:description" content="This page requires an access code.">
<meta name="twitter:card" content="summary">
<style>${PAGE_CSS}${GATE_CSS}</style>
</head>
<body>
<main class="doc gate">
<div class="gate-card">
<div class="gate-lock" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>
<h1 class="gate-title">This page is protected</h1>
<p class="gate-lead muted">Enter the access code you were given to view it.</p>
<form class="gate-form" id="gate-form" method="post" action="/${gateId}/unlock">
<input type="hidden" name="next" value="${escapeHtml(next)}">
<input class="gate-input" id="gate-code" name="code" placeholder="access code"
  autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"
  autofocus required aria-label="Access code">
<button class="gate-btn" type="submit">Unlock</button>
</form>
${error ? `<p class="gate-error" role="alert">${escapeHtml(error)}</p>` : ""}
</div>
</main>
<footer>shared via <a href="/">${escapeHtml(url.hostname)}</a></footer>
<script>
(function () {
  var m = location.hash.match(/^#c=(.+)$/);
  if (!m) return;
  var code = "";
  try { code = decodeURIComponent(m[1]); } catch (e) { return; }
  if (!code) return;
  var input = document.getElementById("gate-code");
  input.value = code;
  // Scrub the fragment before submitting so the code doesn't linger in the
  // address bar (or get carried across the redirect).
  history.replaceState(null, "", location.pathname + location.search);
  document.getElementById("gate-form").submit();
})();
</script>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

const GATE_CSS = `
.gate {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.gate-card {
  width: 100%;
  max-width: 22rem;
  text-align: center;
  padding-bottom: 8vh;
}
.gate-lock {
  width: 44px;
  height: 44px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
  color: var(--muted);
}
.gate-lock svg { width: 20px; height: 20px; }
.gate-title { font-size: 20px; margin: 18px 0 0; }
.gate-lead { font-size: 14px; margin: 6px 0 0; }
.gate-form {
  display: flex;
  gap: 8px;
  margin-top: 22px;
}
.gate-input {
  flex: 1;
  min-width: 0;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 14px;
  outline: none;
}
.gate-input:focus { border-color: var(--link); }
.gate-btn {
  flex: none;
  padding: 9px 16px;
  border: none;
  border-radius: 8px;
  background: var(--text);
  color: var(--bg);
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.gate-btn:hover { opacity: 0.85; }
.gate-error {
  margin: 14px 0 0;
  font-size: 13px;
  line-height: 1.5;
  color: #d5484f;
}
`;

/* ---------- Web comments + edits (behind the gate) ----------

   Both surfaces exist only on protected shares: the unlock cookie names the
   code that opened the door, the code's role says what its holder may do.
   Everything is a plain form post + 303 (like the gate), so it works without
   JS. Comments live in pages/<id>.comments.json — their own object, so the
   app's content pushes and visitor comments never race each other. */

const commentsKey = (id) => `pages/${id}.comments.json`;

const commentAttempts = new Map(); // ip -> [timestamps]
const editAttempts = new Map(); // ip -> [timestamps]

// The stored comment list, shape-checked — same contract as sanitizeAccess:
// a corrupt object reads as empty everywhere at once instead of crashing.
function sanitizeComments(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.comments)) return [];
  const out = [];
  for (const c of raw.comments) {
    if (!c || typeof c !== "object") continue;
    if (typeof c.id !== "string" || !COMMENT_ID_RE.test(c.id)) continue;
    if (typeof c.body !== "string" || c.body.length === 0) continue;
    if (out.some((seen) => seen.id === c.id)) continue;
    const anchor = c.anchor ? sanitizeAnchor(c.anchor.path, c.anchor.tag, c.anchor.text) : null;
    out.push({
      id: c.id,
      body: c.body.slice(0, MAX_COMMENT_BODY),
      ...(typeof c.quote === "string" && c.quote
        ? { quote: c.quote.slice(0, MAX_COMMENT_QUOTE) }
        : {}),
      ...(anchor ? { anchor } : {}),
      ...(typeof c.name === "string" && c.name ? { name: c.name.slice(0, MAX_NAME_LEN) } : {}),
      label: typeof c.label === "string" ? c.label.slice(0, MAX_NAME_LEN) : "",
      codeId: typeof c.codeId === "string" ? c.codeId : "",
      ...(typeof c.createdAt === "string" ? { createdAt: c.createdAt } : {}),
    });
    if (out.length >= MAX_COMMENTS) break;
  }
  return out;
}

async function readComments(env, id) {
  const obj = await env.PAGES.get(commentsKey(id));
  if (!obj) return [];
  return sanitizeComments(await obj.json().catch(() => null));
}

// Remove one comment, CAS-retried. `codeId` scopes the delete to comments
// that code posted (the public path); null removes regardless (the owner's
// moderation path). Returns "ok" | "missing" | "forbidden" | "conflict".
async function removeComment(env, id, cid, codeId) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await env.PAGES.get(commentsKey(id));
    const current = existing ? sanitizeComments(await existing.json().catch(() => null)) : [];
    const target = current.find((c) => c.id === cid);
    if (!target) return "missing";
    if (codeId !== null && target.codeId !== codeId) return "forbidden";
    const next = current.filter((c) => c.id !== cid);
    const put = await env.PAGES.put(commentsKey(id), JSON.stringify({ comments: next }), {
      httpMetadata: { contentType: "application/json" },
      onlyIf: { etagMatches: existing.etag },
    });
    if (put) return "ok";
  }
  return "conflict";
}

// Resolve the {data, gate, session} triple behind a public write — answering
// with the right page (404 / gate / a plain-language 403) when a layer says
// no. `need` is the role floor: "comment" (comment or edit) or "edit".
async function publicWriteContext(request, env, id, url, need, nextPath) {
  const obj = await env.PAGES.get(`pages/${id}.json`);
  if (!obj) return { error: notFoundPage() };
  const data = await obj.json().catch(() => null);
  if (!data || typeof data !== "object" || data.kind === "collection") {
    return { error: notFoundPage() };
  }
  const gate = await accessGateFor(env, id, data);
  if (!gate) {
    // No codes, no named identities: a public share stays read-only.
    return {
      error: shellPage("Read-only page", "This page doesn't take changes from the web.", 403),
    };
  }
  const session = await gateSession(request, env, gate);
  if (!session) return { error: gatePage(gate.gateId, safeNext(nextPath, gate.gateId), url) };
  const allowed = need === "edit" ? session.role === "edit" : session.role !== "view";
  if (!allowed) {
    return {
      error: shellPage(
        "Not allowed",
        need === "edit"
          ? "Your access code can read this page, not edit it."
          : "Your access code can read this page, not comment on it.",
        403,
      ),
    };
  }
  return { data, gate, session };
}

// Where a comment form returns to: the view the visitor posted from. Both
// views of a pair render the comments section now; the hidden `view` field
// says which one the form was on ("html" → the default rendition view,
// anything else → the markdown view when the page has both).
function commentsReturnPath(data, id, fromView) {
  const both =
    typeof data.markdown === "string" && typeof data.html === "string" && data.html.length > 0;
  return both && fromView !== "html" ? `/${id}?v=md#comments` : `/${id}#comments`;
}

// POST /<id>/comments — add a comment (codes with the comment or edit role).
async function handleCommentAdd(request, env, id, url) {
  if (request.method !== "POST") {
    return new Response(null, { status: 303, headers: { location: `/${id}` } });
  }
  const ctx = await publicWriteContext(request, env, id, url, "comment", `/${id}`);
  if (ctx.error) return ctx.error;
  if (rateLimited(commentAttempts, request, COMMENT_RATE_LIMIT)) {
    return shellPage("Slow down", "Too many comments at once — wait a minute, then try again.", 429);
  }
  let form;
  try {
    form = await request.formData();
  } catch {
    return shellPage("That didn't work", "The comment didn't come through — go back and try again.", 400);
  }
  const body = String(form.get("body") ?? "").replace(/\r\n?/g, "\n").trim();
  if (!body) return shellPage("Empty comment", "Write something first, then post.", 400);
  if (body.length > MAX_COMMENT_BODY) {
    return shellPage("Too long", `Comments are capped at ${MAX_COMMENT_BODY} characters.`, 413);
  }
  const name = String(form.get("name") ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LEN);
  const quote = String(form.get("quote") ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_COMMENT_QUOTE);
  // An element anchor, when the html view's picker filled the fields. A
  // malformed anchor never sinks the comment — it just posts unanchored.
  const anchor = sanitizeAnchor(
    String(form.get("anchor_path") ?? ""),
    String(form.get("anchor_tag") ?? ""),
    String(form.get("anchor_text") ?? ""),
  );
  const fromView = String(form.get("view") ?? "") === "html" ? "html" : "md";

  const entry = {
    id: `m-${randomHex(4)}`,
    body,
    ...(quote ? { quote } : {}),
    ...(anchor ? { anchor } : {}),
    ...(name ? { name } : {}),
    label: ctx.session.label,
    codeId: ctx.session.codeId,
    createdAt: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await env.PAGES.get(commentsKey(id));
    const current = existing ? sanitizeComments(await existing.json().catch(() => null)) : [];
    if (current.length >= MAX_COMMENTS) {
      return shellPage("Comments are full", "This page has reached its comment limit.", 409);
    }
    const put = await env.PAGES.put(
      commentsKey(id),
      JSON.stringify({ comments: [...current, entry] }),
      {
        httpMetadata: { contentType: "application/json" },
        ...(existing ? { onlyIf: { etagMatches: existing.etag } } : {}),
      },
    );
    if (put) {
      return new Response(null, {
        status: 303,
        headers: { location: commentsReturnPath(ctx.data, id, fromView) },
      });
    }
    // Lost a race with another comment — re-read and re-append.
  }
  return shellPage("Try again", "Two comments landed at once — go back and post again.", 409);
}

// POST /<id>/comments/<cid>/delete — a session may remove its own code's
// comments; everything else is the owner's moderation API.
async function handleCommentDelete(request, env, id, cid, url) {
  if (request.method !== "POST") {
    return new Response(null, { status: 303, headers: { location: `/${id}` } });
  }
  const ctx = await publicWriteContext(request, env, id, url, "comment", `/${id}`);
  if (ctx.error) return ctx.error;
  const form = await request.formData().catch(() => null);
  const fromView = String(form?.get("view") ?? "") === "html" ? "html" : "md";
  const removed = await removeComment(env, id, cid, ctx.session.codeId);
  if (removed === "forbidden") {
    return shellPage("Not yours", "Only the code that posted a comment can remove it here.", 403);
  }
  if (removed === "conflict") {
    return shellPage("Try again", "Something raced that delete — go back and retry.", 409);
  }
  // "missing" = already gone (double-click); the outcome stands either way.
  return new Response(null, {
    status: 303,
    headers: { location: commentsReturnPath(ctx.data, id, fromView) },
  });
}

// A document that opens with an H1 names itself — mirror of the app's
// markdownLeadTitle (share.ts), so a web edit retitles the page exactly like
// a local edit would. Null = keep the stored title.
function markdownLeadTitle(md) {
  const lines = md.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i += 1;
  const m = lines[i]?.match(/^#[ \t]+(.+?)[ \t]*#*[ \t]*$/);
  if (!m) return null;
  const text = m[1]
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .trim();
  return text ? text.slice(0, 256) : null;
}

// GET /<id>/edit renders the web editor; POST saves. Saves are CAS-guarded
// twice over: baseRev (the revision the editor loaded) must still be current,
// and the put itself is conditional on the record's etag — a lost race
// re-renders the editor with the visitor's text intact, never a clobber.
async function handleEdit(request, env, id, url) {
  if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  const ctx = await publicWriteContext(request, env, id, url, "edit", `/${id}/edit`);
  if (ctx.error) return ctx.error;
  const { data, session } = ctx;
  if (typeof data.markdown !== "string") {
    // An html-only rendition page: nothing editable here.
    return new Response(null, { status: 303, headers: { location: `/${id}` } });
  }
  const hasHtml = typeof data.html === "string" && data.html.length > 0;

  if (request.method !== "POST") {
    return editorPage(id, data.title || "Untitled", data.markdown, pageRev(data), { hasHtml });
  }

  if (rateLimited(editAttempts, request, EDIT_RATE_LIMIT)) {
    return shellPage("Slow down", "Too many saves at once — wait a minute, then try again.", 429);
  }
  let form;
  try {
    form = await request.formData();
  } catch {
    return shellPage("That didn't work", "The save didn't come through — go back and try again.", 400);
  }
  // Strip CriticMarkup like the app does before publishing — the public copy
  // never carries editorial braces, whoever wrote them.
  const markdown = stripComments(String(form.get("markdown") ?? "").replace(/\r\n?/g, "\n"));
  const baseRev = Number(form.get("baseRev"));
  if (!Number.isInteger(baseRev) || baseRev < 1) {
    return shellPage("That didn't work", "The save didn't come through — go back and try again.", 400);
  }
  if (markdown.trim().length === 0) {
    return editorPage(id, data.title || "Untitled", markdown, baseRev, {
      hasHtml,
      status: 400,
      error: "There's nothing to save — the document can't be emptied from here.",
    });
  }
  if (markdown.length > MAX_MARKDOWN_BYTES) {
    return shellPage("Too large", "That document is beyond the size limit.", 413);
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await env.PAGES.get(`pages/${id}.json`);
    if (!existing) return notFoundPage();
    const record = await existing.json().catch(() => null);
    if (!record || typeof record !== "object" || typeof record.markdown !== "string") {
      return notFoundPage();
    }
    const currentRev = pageRev(record);
    const recordHasHtml = typeof record.html === "string" && record.html.length > 0;
    if (currentRev !== baseRev) {
      const by = publicWebEdit(record)?.by;
      return editorPage(id, record.title || "Untitled", markdown, currentRev, {
        hasHtml: recordHasHtml,
        status: 409,
        error: `This page changed while you were editing${by ? ` (last saved by ${by})` : ""}. Your text is kept below — saving now overwrites the newer version, so open the live page in another tab first if you need to merge.`,
      });
    }
    const now = new Date().toISOString();
    const title = markdownLeadTitle(markdown) ?? record.title ?? "Untitled";
    const next = {
      ...record,
      title,
      markdown,
      // The rendition (if any) no longer matches the document; the markdown
      // takes the default view until the app pushes a fresh one.
      ...(recordHasHtml ? { htmlStale: true } : {}),
      rev: currentRev + 1,
      webEdit: { by: session.label, at: now },
      updatedAt: now,
    };
    const meta = { ...(existing.customMetadata ?? {}) };
    meta.title = title.slice(0, 256);
    meta.updatedAt = now;
    meta.rev = String(next.rev);
    meta.webEdit = "1";
    meta.webEditBy = session.label.slice(0, MAX_NAME_LEN);
    meta.webEditAt = now;
    const put = await env.PAGES.put(`pages/${id}.json`, JSON.stringify(next), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: meta,
      onlyIf: { etagMatches: existing.etag },
    });
    if (put) {
      return new Response(null, {
        status: 303,
        headers: { location: recordHasHtml ? `/${id}?v=md` : `/${id}` },
      });
    }
    // Lost a race (concurrent save / app push) — re-read; the rev check above
    // turns a real content change into the 409 editor.
  }
  return shellPage("Try again", "Something raced that save — go back and retry.", 409);
}

// The web editor: one full-height form, no JS required. The document rides a
// <textarea>; baseRev pins the revision it was loaded from.
function editorPage(id, title, markdown, rev, { status = 200, error = null, hasHtml = false } = {}) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${FAVICON_LINKS}
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Edit · ${escapeHtml(title)}</title>
<style>${PAGE_CSS}${EDITOR_CSS}</style>
</head>
<body class="editor-page">
<form class="editor" method="post" action="/${id}/edit">
<header class="editor-bar">
<div class="editor-name">Editing <strong>${escapeHtml(title)}</strong></div>
<div class="editor-actions">
<a class="editor-cancel" href="/${id}">Cancel</a>
<button class="editor-save" type="submit">Save</button>
</div>
</header>
${error ? `<div class="editor-warn" role="alert">${escapeHtml(error)}</div>` : ""}
${
  hasHtml && !error
    ? `<div class="editor-note muted">This page also carries a polished HTML rendition. Saving marks it out of date — readers see your markdown until the owner regenerates it.</div>`
    : ""
}
<textarea class="editor-text" name="markdown" spellcheck="false" autocapitalize="off" autocorrect="off" aria-label="Markdown document">${escapeHtml(markdown)}</textarea>
<input type="hidden" name="baseRev" value="${rev}">
</form>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

const EDIT_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>`;
const COMMENT_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;

function commentDateLabel(iso) {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
    : "";
}

// The comments section under a page (rendered only for sessions that may
// comment — the panel and its contents stay invisible to view-only codes).
// Deleting is offered on the session's own code's comments; the tiny script
// only remembers the visitor's name between posts.
// `view` says which page view hosts the section ("md" | "html"): it rides the
// forms as a hidden field (the post returns to the view it came from), and on
// the html view the section also carries what the anchoring layer needs —
// per-item ids + "Show in document" buttons (inert without JS), the hidden
// anchor/quote fields with the "Commenting on" chip, the anchor list JSON,
// and the shell script that wires it all to the frame bridge.
function renderCommentsSection(id, comments, session, view = "md") {
  const isHtmlView = view === "html";
  const items = comments
    .map((c) => {
      const name = c.name || c.label || "Someone";
      const via =
        c.name && c.label && c.label !== c.name
          ? `<span class="comment-via">· ${escapeHtml(c.label)}</span>`
          : "";
      const when = commentDateLabel(c.createdAt);
      const del =
        c.codeId === session.codeId
          ? `<form class="comment-delete-form" method="post" action="/${id}/comments/${c.id}/delete"><input type="hidden" name="view" value="${view}"><button class="comment-delete" type="submit" title="Delete this comment">Delete</button></form>`
          : "";
      const reveal =
        isHtmlView && c.anchor
          ? `<button class="comment-reveal" type="button" data-comment-id="${c.id}">Show in document</button>`
          : "";
      return `<li class="comment" id="c-${c.id}">
<div class="comment-head"><span class="comment-author">${escapeHtml(name)}</span>${via}${when ? `<span class="comment-date">${escapeHtml(when)}</span>` : ""}${del}</div>
${c.quote ? `<blockquote class="comment-quote">${escapeHtml(c.quote)}</blockquote>` : ""}
<p class="comment-body">${escapeHtml(c.body)}</p>
${reveal}
</li>`;
    })
    .join("\n");
  // The anchor list the shell script feeds the frame bridge. `<` is escaped
  // so page content can never close this script block.
  const anchorData = isHtmlView
    ? `<script type="application/json" id="dkw-data">${JSON.stringify(
        comments.filter((c) => c.anchor).map((c) => ({ id: c.id, anchor: c.anchor })),
      ).replace(/</g, "\\u003c")}</script>`
    : "";
  const chip = isHtmlView
    ? `<div class="comment-anchor-chip" id="dkw-chip" hidden>Commenting on <q id="dkw-chip-quote"></q><button type="button" class="comment-chip-clear" id="dkw-chip-clear" title="Comment on the whole page instead" aria-label="Remove the anchor">×</button></div>`
    : "";
  const anchorFields = isHtmlView
    ? `<input type="hidden" name="anchor_path" value=""><input type="hidden" name="anchor_tag" value=""><input type="hidden" name="anchor_text" value=""><input type="hidden" name="quote" value="">`
    : "";
  return `<section class="comments" id="comments" aria-label="Comments">
<div class="comments-inner">
<h2 class="comments-title">Comments${comments.length > 0 ? ` <span class="comments-count">${comments.length}</span>` : ""}</h2>
${comments.length > 0 ? `<ol class="comment-list">\n${items}\n</ol>` : `<p class="comments-empty muted">No comments yet.</p>`}
<form class="comment-form" method="post" action="/${id}/comments">
<input type="hidden" name="view" value="${view}">
${anchorFields}${chip}
<textarea class="comment-text" name="body" required maxlength="${MAX_COMMENT_BODY}" rows="3" placeholder="Write a comment…" aria-label="Comment"></textarea>
<div class="comment-form-foot">
<input class="comment-name" id="comment-name" name="name" maxlength="${MAX_NAME_LEN}" placeholder="Your name (optional)" autocomplete="name" aria-label="Your name">
<button class="comment-post" type="submit">Post comment</button>
</div>
</form>
${anchorData}
</div>
</section>
<script>
(function () {
  var f = document.getElementById("comment-name");
  if (!f) return;
  try { var v = localStorage.getItem("dk-comment-name"); if (v && !f.value) f.value = v; } catch (e) {}
  var form = f.closest("form");
  if (form) form.addEventListener("submit", function () {
    try { localStorage.setItem("dk-comment-name", f.value.trim()); } catch (e) {}
  });
})();
</script>`;
}

const COMMENTS_CSS = `
.comments { width: 100%; border-top: 1px solid var(--border); margin-top: 24px; }
.comments-inner { width: 100%; max-width: 1080px; margin: 0 auto; padding: 32px 64px 16px; }
@media (max-width: 720px) { .comments-inner { padding: 28px 24px 12px; } }
.comments-title { font-size: 16px; font-weight: 700; margin: 0 0 14px; display: flex; align-items: center; gap: 8px; }
.comments-count {
  min-width: 20px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--surface);
  border: 1px solid var(--border);
  font-size: 11.5px;
  font-weight: 500;
  color: var(--muted);
  text-align: center;
}
.comments-empty { font-size: 13.5px; margin: 0 0 16px; }
.comment-list { list-style: none; margin: 0 0 20px; padding: 0; display: flex; flex-direction: column; gap: 12px; }
.comment { padding: 12px 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); }
.comment-head { display: flex; align-items: baseline; gap: 8px; font-size: 12.5px; }
.comment-author { font-weight: 600; color: var(--text); }
.comment-via { color: var(--muted); }
.comment-date { color: var(--muted); }
.comment-delete-form { margin-left: auto; }
.comment-delete { border: none; background: none; padding: 0; font: inherit; font-size: 12px; color: var(--muted); cursor: pointer; }
.comment-delete:hover { color: #d5484f; }
.comment-quote { margin: 8px 0 0; padding: 2px 0 2px 10px; border-left: 3px solid var(--border); font-size: 12.5px; color: var(--muted); }
.comment-body { margin: 6px 0 0; font-size: 14px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.comment-form { display: flex; flex-direction: column; gap: 8px; }
.comment-text {
  width: 100%;
  min-height: 72px;
  resize: vertical;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text);
  font: inherit;
  font-size: 14px;
  line-height: 1.5;
  outline: none;
}
.comment-text:focus { border-color: var(--link); }
.comment-form-foot { display: flex; gap: 8px; align-items: center; }
.comment-name {
  flex: 1;
  min-width: 0;
  max-width: 240px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text);
  font: inherit;
  font-size: 13px;
  outline: none;
}
.comment-name:focus { border-color: var(--link); }
.comment-post {
  margin-left: auto;
  flex: none;
  padding: 8px 16px;
  border: none;
  border-radius: 8px;
  background: var(--text);
  color: var(--bg);
  font: inherit;
  font-size: 13.5px;
  font-weight: 600;
  cursor: pointer;
}
.comment-post:hover { opacity: 0.85; }

/* Anchored comments (the html view). "Show in document" is server-rendered
   but inert until the shell script marks it live; the chip appears when the
   frame's bubble picked an element for the next comment. */
.comment-reveal { display: none; margin-top: 6px; border: none; background: none; padding: 0; font: inherit; font-size: 12px; color: var(--accent, #2f6fdd); cursor: pointer; }
.comment-reveal.is-live { display: inline-block; }
.comment-reveal:hover { text-decoration: underline; }
.comment-anchor-chip[hidden] { display: none; }
.comment-anchor-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-left: 3px solid #2f6fdd;
  border-radius: 8px;
  background: var(--surface);
  font-size: 12.5px;
  color: var(--muted);
}
.comment-anchor-chip q { font-style: italic; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.comment-chip-clear { margin-left: auto; flex: none; border: none; background: none; padding: 0 2px; font-size: 15px; line-height: 1; color: var(--muted); cursor: pointer; }
.comment-chip-clear:hover { color: var(--text); }
@keyframes dkw-li-flash { 0% { background-color: rgba(47, 111, 221, 0.14); } 100% { background-color: transparent; } }
.comment.is-flash { animation: dkw-li-flash 1.1s ease-out; border-radius: 8px; }
`;

const EDITOR_CSS = `
body.editor-page { height: 100dvh; overflow: hidden; }
.editor { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.editor-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
.editor-name { font-size: 13.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.editor-name strong { color: var(--text); font-weight: 600; }
.editor-actions { margin-left: auto; display: flex; align-items: center; gap: 12px; }
.editor-cancel { font-size: 13px; color: var(--muted); text-decoration: none; }
.editor-cancel:hover { color: var(--text); }
.editor-save {
  flex: none;
  padding: 7px 16px;
  border: none;
  border-radius: 8px;
  background: var(--text);
  color: var(--bg);
  font: inherit;
  font-size: 13.5px;
  font-weight: 600;
  cursor: pointer;
}
.editor-save:hover { opacity: 0.85; }
.editor-warn {
  padding: 10px 16px;
  font-size: 13.5px;
  line-height: 1.5;
  background: rgba(213, 72, 79, 0.1);
  color: #d5484f;
  border-bottom: 1px solid var(--border);
}
.editor-note { padding: 8px 16px; font-size: 12.5px; border-bottom: 1px solid var(--border); }
.editor-text {
  flex: 1;
  width: 100%;
  min-height: 0;
  resize: none;
  border: none;
  outline: none;
  padding: 20px 24px;
  background: var(--bg);
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13.5px;
  line-height: 1.6;
  tab-size: 2;
}
`;

/* The html-only frame variant used when comments render below the rendition:
   the iframe takes one viewport-height block in the normal flow (the page
   scrolls past it), instead of owning the whole viewport. */
const FRAME_FLOW_CSS = `
.raw-frame-flow {
  display: block;
  width: 100%;
  height: 100dvh;
  border: 0;
  border-bottom: 1px solid var(--border);
  background: #ffffff;
}
`;

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
async function serveRoot(request, env, url) {
  const site = await readSiteConfig(env);
  if (typeof site.rootPageId === "string" && validId(site.rootPageId)) {
    const obj = await env.PAGES.get(`pages/${site.rootPageId}.json`);
    if (obj) {
      try {
        // `await`, not a bare return: a rejection inside the render must land
        // in this catch so the domain root degrades instead of 500ing.
        return await renderPage(request, env, site.rootPageId, await obj.json(), url);
      } catch {
        // corrupt page object; fall through to the landing page
      }
    }
  }
  return landingPage(url, site);
}

async function servePage(request, env, id, url) {
  const obj = await env.PAGES.get(`pages/${id}.json`);
  if (!obj) return notFoundPage();
  let data;
  try {
    data = await obj.json();
  } catch {
    return notFoundPage();
  }
  return renderPage(request, env, id, data, url);
}

async function renderPage(request, env, id, data, url) {
  // A protected share (or a member of a protected folder) shows the gate
  // until this browser has unlocked it. The gate keeps the visitor's view
  // (?v=md) through the unlock, and at the domain root sends them back to /.
  const gate = await accessGateFor(env, id, data);
  const session = gate ? await gateSession(request, env, gate) : null;
  if (gate && !session) {
    const next = `${url.pathname}${url.searchParams.get("v") === "md" ? "?v=md" : ""}`;
    return gatePage(gate.gateId, safeNext(next, gate.gateId), url);
  }
  // Unlocked views of protected content stay out of shared caches.
  const cacheControl = gate ? "no-store" : "no-cache";

  if (data.kind === "collection") return serveCollection(env, id, data, url, cacheControl);

  const hasMd = typeof data.markdown === "string";
  const hasHtml = typeof data.html === "string" && data.html.length > 0;
  if (!hasMd && !hasHtml) return notFoundPage();

  // What this session's code may do here (nothing extra on public shares —
  // there's no named identity to grant anything to).
  const canComment = session !== null && session.role !== "view";
  const canEdit = session !== null && session.role === "edit" && hasMd;
  const comments = canComment ? await readComments(env, id) : null;
  // A web edit outdates the html rendition: the markdown (the edited truth)
  // becomes the default view until the app pushes a fresh rendition.
  const htmlStale = data.htmlStale === true && hasMd;

  const title = data.title || "Untitled";
  const clean = hasMd ? stripComments(data.markdown) : "";
  const desc = hasMd ? deriveDescription(clean) : deriveDescriptionFromHtml(data.html);
  const ogImage = await env.PAGES.head(`pages/${id}.png`);
  const pageUrl = `${url.origin}/${id}`;

  const head = `<meta charset="utf-8">
${FAVICON_LINKS}
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
  // (/<id>?v=md). While the rendition is stale (a web edit outdated it), the
  // markdown takes the default spot and the HTML side is reachable only
  // explicitly (?v=html).
  const pill = (active) =>
    hasMd && hasHtml
      ? `<nav class="view-pill" aria-label="Document version">
<a class="view-seg ${active === "md" ? "is-active" : ""}" href="${pageUrl}?v=md">MD</a>
<a class="view-seg ${active === "html" ? "is-active" : ""}${htmlStale ? " is-stale" : ""}" href="${pageUrl}${htmlStale ? "?v=html" : ""}"${htmlStale ? ' title="Rendition from before the latest web edit"' : ""}>HTML</a>
</nav>`
      : "";

  // The fixed top-right cluster: session actions (edit / comments) + the pill.
  const editBtn = canEdit
    ? `<a class="top-action" href="${pageUrl}/edit">${EDIT_ICON}<span>Edit</span></a>`
    : "";
  const topBar = (...segs) => {
    const inner = segs.filter(Boolean).join("");
    return inner ? `<div class="page-top">${inner}</div>` : "";
  };

  const wantMd = url.searchParams.get("v") === "md";
  const wantHtml = url.searchParams.get("v") === "html";
  if (hasHtml && !(hasMd && wantMd) && (wantHtml || !htmlStale)) {
    // The rendition is an arbitrary standalone document; framing it (instead of
    // serving it at /<id> directly) keeps our meta tags, the toggle, and the
    // sandbox — its scripts run under an opaque origin. A commenting session
    // gets the frame flowing in the document with the comments section below
    // it (and the anchoring layer wiring the two together — see
    // webComments.js); everyone else gets the plain fixed frame.
    const flow = canComment;
    const commentsBtn = flow
      ? `<a class="top-action" href="#comments">${COMMENT_ICON}<span>Comments${comments.length > 0 ? ` · ${comments.length}` : ""}</span></a>`
      : "";
    const html = `<!doctype html>
<html lang="en">
<head>
${head}
<style>${PAGE_CSS}${flow ? FRAME_FLOW_CSS + COMMENTS_CSS : FRAME_CSS}</style>
</head>
<body>
${crumb}
${topBar(commentsBtn, editBtn, pill("html"))}
<iframe class="${flow ? "raw-frame-flow" : "raw-frame"}" src="${pageUrl}/raw" sandbox="allow-scripts allow-popups" title="${escapeHtml(title)}"></iframe>
${flow ? renderCommentsSection(id, comments, session, "html") : ""}
${flow ? `<script>${SHELL_COMMENTS_SCRIPT}</script>` : ""}
${flow ? `<footer>shared via <a href="/">${escapeHtml(url.hostname)}</a></footer>` : ""}
</body>
</html>`;
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": cacheControl },
    });
  }

  const body = marked.parse(clean, { gfm: true, breaks: false, async: false });
  const html = `<!doctype html>
<html lang="en">
<head>
${head}
<style>${PAGE_CSS}${canComment ? COMMENTS_CSS : ""}</style>
</head>
<body>
${crumb}
${topBar(editBtn, pill("md"))}
<main class="doc">
${body}
</main>
${canComment ? renderCommentsSection(id, comments, session) : ""}
<footer>shared via <a href="/">${escapeHtml(url.hostname)}</a></footer>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": cacheControl,
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
async function serveCollection(env, id, data, url, cacheControl = "no-cache") {
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
${FAVICON_LINKS}
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
      "cache-control": cacheControl,
    },
  });
}

// The html rendition, verbatim. Loaded by the ?v=html page's sandboxed iframe;
// direct hits are fine too — the content is as public as the page. On a
// protected share the gate answers instead, pointing at the framed page
// (never at /raw itself: the sandbox blocks form posts, so a gate rendered
// inside the iframe would be a dead end — the parent's cookie covers the
// iframe's request anyway, both being same-site).
async function serveRawHtml(request, env, id) {
  const obj = await env.PAGES.get(`pages/${id}.json`);
  if (!obj) return new Response("not found", { status: 404 });
  let data;
  try {
    data = await obj.json();
  } catch {
    return new Response("not found", { status: 404 });
  }
  const gate = await accessGateFor(env, id, data);
  const session = gate ? await gateSession(request, env, gate) : null;
  if (gate && !session) {
    return gatePage(gate.gateId, `/${id}`, new URL(request.url));
  }
  if (typeof data.html !== "string" || data.html.length === 0) {
    return new Response("not found", { status: 404 });
  }
  // A commenting session's frame carries the anchoring bridge (highlights,
  // the hover bubble — see webComments.js); every other visitor gets the
  // rendition byte-for-byte as pushed.
  const canComment = session !== null && session.role !== "view";
  return new Response(canComment ? injectCommentBridge(data.html) : data.html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": gate ? "no-store" : "no-cache",
      "x-robots-tag": "noindex",
    },
  });
}

// The OG image is derived content (title + host), so it hides behind the same
// gate — link-preview bots get nothing from a protected share. That costs a
// page-record read before the image; unprotected pages pay it too, but R2
// reads are the cheap half of the free tier and OG fetches are rare
// (unfurl bots and first paints, not every view).
async function serveOgImage(request, env, id) {
  const pageObj = await env.PAGES.get(`pages/${id}.json`);
  const data = pageObj ? await pageObj.json().catch(() => null) : null;
  if (data) {
    const gate = await accessGateFor(env, id, data);
    if (gate && !(await gateCookieValid(request, env, gate))) {
      return new Response("unauthorized", { status: 401, headers: { "cache-control": "no-store" } });
    }
  }
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
${FAVICON_LINKS}
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

// Newsreader (optical size pinned, weights 400-500), subset to Latin plus
// common punctuation and embedded as woff2 so the landing page stays fully
// self-contained — the serif wordmark and headlines render without any visitor
// request leaking to a font CDN, the same reason our other assets are inlined.
const LANDING_FONT = `@font-face{font-family:'Newsreader';font-style:normal;font-weight:400 500;font-display:swap;src:url(data:font/woff2;base64,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) format('woff2')}`;

// The six feature lines under the lead: a two-line label + note per cell, laid
// out as a wrapping grid. Generic on purpose, so the strip reads the same on
// every deployment. Sync is framed as local-first (files stay on disk, sync
// just carries them between your Macs), not "cloud".
const FEATURES = [
  { title: "Notion-style editor", desc: "on local, private files" },
  { title: "Markdown for agents", desc: "HTML for humans" },
  { title: "On-device AI", desc: "dictation, plus LLM polish" },
  { title: "Files and workspaces", desc: "or a quick scratch note" },
  { title: "Sync across your Macs", desc: "your files, still on disk" },
  { title: "Instant sharing", desc: "any page, one public URL" },
];

// The collaboration aside — the pitch for Doklin's shared, self-owned backend:
// Notion-grade multiplayer where the data still lives on infrastructure the
// owner controls (their Cloudflare account), with the setup handed to an agent.
const COLLAB = [
  {
    title: "Multiplayer",
    desc: "Invite people to a workspace — edits sync both ways, across everyone's Macs. Concurrent edits merge, and every revision stays restorable.",
  },
  {
    title: "Yours, end to end",
    desc: "Your data, your Cloudflare — not our servers. Everything runs on your own Cloudflare account: your worker, your storage. No Doklin server in the middle.",
  },
  {
    title: "Setup, handed off",
    desc: "An AI coding agent like Claude Code runs the Cloudflare setup from a ready-made prompt Doklin gives it — or follow the click-through dashboard walkthrough. All it needs is a free Cloudflare account.",
  },
];

// The landing page reads like Doklin's own product page, personalized to the
// deployment: the Doklin wordmark leads, and the site config's ownerName /
// ownerLink fill in whose domain this is. It answers two things for a visitor
// who followed a share link here — whose notes live on this domain, and what
// Doklin is (a free, open-source Mac editor, with a feature pitch, a
// collaboration story, and a download button). The editor is presented as a
// product the owner uses, not one they own. Without ownerName the page stays a
// generic Doklin page. The download button points at the site config's
// downloadUrl, defaulting to the official GitHub release's stable
// latest-download alias (kept in sync by .github/workflows/release.yml); set
// downloadUrl to "" to hide it. ownerLink (typically a LinkedIn profile) shows
// as the underlined name in the headline; the project source on GitHub sits in
// the header, where "open source" gets said.
function landingPage(url, site = {}) {
  const host = url.hostname;
  const owner = typeof site.ownerName === "string" ? site.ownerName.trim() : "";
  const link = typeof site.ownerLink === "string" ? site.ownerLink.trim() : "";
  // Unset -> official release; set (even to "") -> respected verbatim, so a
  // self-hoster can point elsewhere or blank it out.
  const downloadUrl = (
    typeof site.downloadUrl === "string" ? site.downloadUrl : DEFAULT_DOWNLOAD_URL
  ).trim();

  const title = owner ? `Notes by ${owner}, written in Doklin` : `Notes written in Doklin`;
  const desc = owner
    ? `${host} is where ${owner} publishes notes written in Doklin, a free, open-source markdown editor for macOS with on-device dictation.`
    : `${host} publishes notes written in Doklin, a free, open-source markdown editor for macOS with on-device dictation.`;
  // Lead is Doklin product copy. With an owner it opens with "Written in
  // Doklin", a phrase kept out of the headline so the name can end the headline
  // line and carry its profile link cleanly.
  const lead = owner
    ? `Written in Doklin, a free and open-source markdown editor for macOS. It keeps your writing on your machine, and it's yours to download too.`
    : `Doklin is a free and open-source markdown editor for macOS. It keeps your writing on your machine, and it's yours to download too.`;

  // Headline: the generic Doklin line, or "Notes by <owner>" where the name
  // links out to the owner's profile (underlined) when a link is configured,
  // and is plain text otherwise.
  const nameHtml =
    owner && link
      ? `<a class="dk-name" href="${escapeHtml(link)}" target="_blank" rel="me noopener">${escapeHtml(owner)}</a>`
      : owner
        ? escapeHtml(owner)
        : "";
  const headlineHtml = owner ? `Notes by ${nameHtml}` : `Notes written in Doklin`;

  const featureCells = FEATURES.map(
    (f) =>
      `<div class="dk-feature"><span class="dk-feature-title">${escapeHtml(f.title)}</span><span class="dk-feature-desc">${escapeHtml(f.desc)}</span></div>`
  ).join("\n          ");

  const collabItems = COLLAB.map(
    (c) =>
      `<div class="dk-collab-item"><span class="dk-collab-title">${escapeHtml(c.title)}</span><span class="dk-collab-desc">${escapeHtml(c.desc)}</span></div>`
  ).join("\n          ");

  const downloadButton = downloadUrl
    ? `<div class="dk-cta">
          <a class="dk-btn" href="${escapeHtml(downloadUrl)}">Download for macOS</a>
          <span class="dk-btn-note">Free&nbsp;·&nbsp;For Apple silicon Macs</span>
        </div>`
    : "";

  const footer = owner ? `${host} · notes by ${owner}` : host;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${FAVICON_LINKS}
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(desc)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${escapeHtml(host)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(desc)}">
<meta property="og:url" content="${url.origin}/">
<style>${LANDING_FONT}${ROOT_LANDING_CSS}</style>
</head>
<body>
<div class="dk-root">
  <div class="dk-drift" aria-hidden="true">
    <div class="dk-blob dk-blob-a"></div>
    <div class="dk-blob dk-blob-b"></div>
    <div class="dk-blob dk-blob-c"></div>
  </div>
  <div class="dk-shell">
    <header class="dk-header">
      <div class="dk-brand">
        <span class="dk-brand-dot" aria-hidden="true"></span>
        <span class="dk-brand-name">Doklin</span>
      </div>
      <a class="dk-gh" href="${REPO_URL}" target="_blank" rel="noopener">Source on GitHub&nbsp;↗</a>
    </header>

    <main class="dk-main">
      <div class="dk-lead">
        <h1 class="dk-h1">${headlineHtml}</h1>
        <p class="dk-sub">${escapeHtml(lead)}</p>
        ${downloadButton}
        <div class="dk-features">
          ${featureCells}
        </div>
      </div>

      <aside class="dk-aside">
        <span class="dk-eyebrow">Collaboration</span>
        <h2 class="dk-h2">A shared workspace, on a backend you own</h2>
        <p class="dk-aside-lead">Notion-grade collaboration, without your notes living on someone else's servers.</p>
        <div class="dk-collab">
          ${collabItems}
        </div>
      </aside>
    </main>

    <footer class="dk-footer">${escapeHtml(footer)}</footer>
  </div>
</div>
</body>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
  });
}

// Bespoke, self-contained styles for the domain root. Unlike the shared page
// chrome (PAGE_CSS) this page owns its whole look — a light, glassy gradient
// with slow-drifting background blobs, a serif display face, and a two-column
// lead / collaboration layout that collapses to one column on narrow screens.
// Light only, by design; the join page keeps using the theme-aware LANDING_CSS.
const ROOT_LANDING_CSS = `
*{box-sizing:border-box}
html,body{margin:0}
body{background:#edf3f9;color:#243140;color-scheme:light;font-family:system-ui,-apple-system,"Helvetica Neue",Helvetica,sans-serif;-webkit-font-smoothing:antialiased;}
a{color:#35547e;text-decoration:none}
a:hover{color:#22405f}
@keyframes dk-drift-a{from{transform:translate3d(-3%,-2%,0) scale(1)}to{transform:translate3d(4%,3%,0) scale(1.07)}}
@keyframes dk-drift-b{from{transform:translate3d(3%,2%,0) scale(1.04)}to{transform:translate3d(-4%,-3%,0) scale(0.98)}}
.dk-root{position:relative;min-height:100dvh;overflow:hidden;background:linear-gradient(180deg,#f7fafd 0%,#edf3f9 48%,#e5eef7 100%);display:flex;flex-direction:column}
.dk-drift{position:absolute;inset:-12%;z-index:0;pointer-events:none}
.dk-blob{position:absolute;border-radius:50%;filter:blur(56px);will-change:transform}
.dk-blob-a{width:52vw;height:52vw;left:-8%;top:-22%;background:radial-gradient(circle at 35% 35%,rgba(168,199,233,0.65),rgba(168,199,233,0) 66%);animation:dk-drift-a 30s ease-in-out infinite alternate}
.dk-blob-b{width:46vw;height:46vw;right:-10%;top:8%;background:radial-gradient(circle at 60% 40%,rgba(196,199,238,0.45),rgba(196,199,238,0) 66%);animation:dk-drift-b 36s ease-in-out infinite alternate}
.dk-blob-c{width:58vw;height:42vw;left:18%;bottom:-28%;background:radial-gradient(ellipse at 50% 50%,rgba(215,234,246,0.85),rgba(215,234,246,0) 70%);animation:dk-drift-a 40s ease-in-out infinite alternate-reverse}
.dk-shell{position:relative;z-index:1;flex:1;display:flex;flex-direction:column;width:100%;max-width:1280px;margin:0 auto;padding:clamp(20px,3.2vh,36px) clamp(22px,4.5vw,56px)}
.dk-header{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.dk-brand{display:flex;align-items:center;gap:10px}
.dk-brand-dot{width:9px;height:9px;border-radius:50%;background:linear-gradient(135deg,#66a3f5,#2f66d6);box-shadow:0 0 0 4px rgba(94,155,240,0.2)}
.dk-brand-name{font-family:'Newsreader',Georgia,serif;font-size:21px;font-weight:500;letter-spacing:-0.01em;color:#1e2c3c}
.dk-gh{font-size:13.5px;color:rgba(36,49,64,0.62);transition:color 0.15s ease}
.dk-gh:hover{color:#22405f}
.dk-main{flex:1;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,400px),1fr));gap:clamp(36px,5vw,84px);align-items:center;padding:clamp(28px,4.5vh,48px) 0}
.dk-lead{display:flex;flex-direction:column;gap:clamp(18px,2.6vh,26px);min-width:0}
.dk-h1{margin:0;font-family:'Newsreader',Georgia,serif;font-weight:400;font-size:clamp(38px,4.4vw,58px);line-height:1.06;letter-spacing:-0.02em;color:#1e2c3c;text-wrap:balance}
.dk-name{color:#35547e;text-decoration:underline;text-decoration-color:rgba(78,121,171,0.4);text-decoration-thickness:1.5px;text-underline-offset:6px}
.dk-name:hover{color:#22405f}
.dk-sub{margin:0;max-width:50ch;font-size:clamp(15px,1.2vw,16.5px);line-height:1.6;color:rgba(36,49,64,0.72);text-wrap:pretty}
.dk-cta{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-top:2px}
.dk-btn{display:inline-flex;align-items:center;padding:14px 28px;border-radius:999px;background:linear-gradient(160deg,#66a3f5 0%,#3d7ae8 50%,#2f66d6 100%);color:#fff;font-size:15px;font-weight:600;letter-spacing:0.01em;box-shadow:0 14px 34px -10px rgba(47,102,214,0.6),0 0 0 1px rgba(255,255,255,0.3) inset,0 1.5px 0 rgba(255,255,255,0.4) inset,0 3px 14px rgba(94,155,240,0.35);text-shadow:0 1px 2px rgba(25,60,130,0.25);transition:transform 0.18s ease,box-shadow 0.18s ease,filter 0.18s ease}
.dk-btn:hover{transform:translateY(-1.5px);filter:brightness(1.07) saturate(1.05);box-shadow:0 18px 42px -10px rgba(47,102,214,0.68),0 0 0 1px rgba(255,255,255,0.35) inset,0 1.5px 0 rgba(255,255,255,0.45) inset,0 5px 20px rgba(94,155,240,0.45);color:#fff}
.dk-btn-note{font-size:13px;color:rgba(36,49,64,0.58)}
.dk-features{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,230px),1fr));gap:clamp(14px,2.2vh,20px) 28px;border-top:1px solid rgba(36,49,64,0.1);padding-top:clamp(16px,2.4vh,24px);margin-top:clamp(4px,1vh,10px)}
.dk-feature{display:flex;flex-direction:column;gap:3px}
.dk-feature-title{font-size:14.5px;font-weight:600;color:#25344a}
.dk-feature-desc{font-size:13.5px;color:rgba(36,49,64,0.6)}
.dk-aside{position:relative;background:rgba(255,255,255,0.58);border:1px solid rgba(255,255,255,0.85);border-radius:22px;padding:clamp(24px,3vw,38px);box-shadow:0 24px 60px -20px rgba(52,84,126,0.25),0 2px 8px rgba(52,84,126,0.06);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);display:flex;flex-direction:column;gap:clamp(12px,1.8vh,18px)}
.dk-eyebrow{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#4e79ab}
.dk-h2{margin:0;font-family:'Newsreader',Georgia,serif;font-weight:500;font-size:clamp(24px,2.2vw,30px);line-height:1.15;letter-spacing:-0.01em;color:#1e2c3c;text-wrap:balance}
.dk-aside-lead{margin:0;font-size:14.5px;line-height:1.55;color:rgba(36,49,64,0.72);text-wrap:pretty}
.dk-collab{display:flex;flex-direction:column}
.dk-collab-item{padding:clamp(11px,1.6vh,15px) 0;border-top:1px solid rgba(36,49,64,0.09);display:flex;flex-direction:column;gap:4px}
.dk-collab-item:last-child{padding-bottom:0}
.dk-collab-title{font-size:14px;font-weight:600;color:#25344a}
.dk-collab-desc{font-size:13.5px;line-height:1.5;color:rgba(36,49,64,0.62);text-wrap:pretty}
.dk-footer{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;letter-spacing:0.03em;color:rgba(36,49,64,0.55);padding-top:8px}
@media (prefers-reduced-motion: reduce){.dk-blob{animation:none}}
`;

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
${FAVICON_LINKS}
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
.view-seg.is-stale { opacity: 0.55; }
/* Fixed top-right cluster: session actions (Edit / Comments) + the view pill.
   The pill keeps its own look but gives up its fixed position in here. */
.page-top {
  position: fixed;
  top: 14px;
  right: 14px;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 8px;
}
.page-top .view-pill { position: static; }
.top-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
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
.top-action:hover { color: var(--text); }
.top-action svg { width: 13px; height: 13px; flex: none; }
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
