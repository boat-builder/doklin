// The public surface — no auth, GET/HEAD only.
// Pages are resolved against a public map and rendered from synced blobs
// (pages.ts), through a cache keyed by that manifest's etag. The map is the
// shared workspace's own — or, for an address it does not hold, the map of
// the space the address registry names (addresses.ts):
//
//   GET /                        the root page when the map names one, else the landing page
//   GET /<slug>                  a published note (html rendition when it has one; ?v=md the markdown)
//   GET /<slug>/raw              the html rendition verbatim, sandboxed (what the framed page loads)
//   GET /<dirSlug>               a published folder: its table of contents
//   GET /<dirSlug>/<rel/path>    a note inside it (`.md` dropped, segments percent-encoded), its
//                                rendition at …/raw, or an html document by exact path
//
// The files pages ask for never reach the worker: Cloudflare serves them
// from the web directory deployed beside it (scripts/bundle-worker.mjs),
// free and uncounted —
//
//   /__web/<tag>/mermaid.js      the standalone mermaid module (immutable, content-tagged)
//   /__web/fonts/<file>          the font files the app bundles (theme.ts)
//   /og.png                      the site's static Open Graph image
//   robots.txt, favicon.ico, apple-touch-icon.png
//
// — so one of those paths that does reach it names nothing, and is a 404
// without a look at the workspace.
//
// Every page carries <meta name="robots" content="noindex">, and goes out
// under the page policy below.

import { spaceAt } from "./addresses";
import { WEB_TAG } from "./assets";
import type { Env } from "./env";
import { RESERVED_SLUGS, SLUG_RE, validPath } from "./layout";
import { dirTitle, htmlFile, notePage, rawRendition, tocPage } from "./pages";
import { PublicMap, nestedUrl, type DirPage, type Page } from "./publicMap";
import { mermaidModulePath } from "./render";
import { landingPage, notFoundPage } from "./static";
import { spaceEnv } from "./spaces";
import { isMarkdownPath, openWorkspace, type Workspace } from "./workspace";

/* ---------- The cache ----------

   A render is a handful of R2 reads.
   Rendered responses are kept in the Workers cache under a synthetic key
   that carries the manifest's etag, so a manifest change gives every URL a
   new key: a page is never served stale past one `head`, and old entries
   age out on their own. Steady state per public request: one head, one
   cache hit. The visitor's browser is told no-cache all the same — the
   cache's day-long TTL is the worker's business, not the reader's. */

const CACHE_TTL_S = 86400;

type CacheLike = {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
};

/** The Workers cache when the runtime has one (a node harness has not). */
function cacheStore(): CacheLike | null {
  const c = (globalThis as { caches?: { default?: CacheLike } }).caches;
  return c?.default ?? null;
}

// The web tag rides in the key too: a cached page names the mermaid module by
// it, and a deploy that changes the module serves no page asking for one
// that is gone.
const cacheKey = (ws: Workspace, url: URL): string =>
  `https://cache.doklin/${WEB_TAG}/${ws.etag}${ws.space ? `@${ws.space}` : ""}${url.pathname}${url.search}`;

const cacheable = (res: Response): boolean =>
  (res.status === 200 || res.status === 404) && !res.headers.has("set-cookie");

function withCacheControl(res: Response, value: string): Response {
  const headers = new Headers(res.headers);
  headers.set("cache-control", value);
  return new Response(res.body, { status: res.status, headers });
}

/* ---------- What a page may do ----------

   A note's markdown may carry HTML of its own, and its page draws that as
   written — on the address the workspace's API answers on. So every page the
   worker draws goes out under a policy that lets it show and never act. The
   one script it runs is the mermaid module, named by its whole address (a
   policy has no other way to say "this path, on this domain"): a script, a
   handler or a `javascript:` link written into a note does nothing. A form
   posts nowhere, a <base> re-points nothing, nothing is fetched or embedded
   as a plugin. Styles stay open — the page's sheet is inline, and stored
   column widths and drawn diagrams are style attributes — and so do the
   pictures, media and frames a note shows from the web.

   The policy is set here, on the way out, and not where a page is drawn: it
   names the domain the request came to, and the cache keeps a page under a
   key that names none. An html document is not the worker's drawing: it
   brings its sandbox (pages.ts) and keeps it. */

const POLICY = "content-security-policy";

const pagePolicy = (origin: string): string =>
  [
    "default-src 'none'",
    `script-src ${origin}${mermaidModulePath(WEB_TAG)}`,
    "style-src 'unsafe-inline'",
    "img-src * data:",
    "media-src *",
    "font-src 'self'",
    "frame-src *",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");

/** A response on its way out: under the page policy unless it brought its own, and its headers alone for HEAD. */
function deliver(res: Response, request: Request, url: URL): Response {
  const headers = new Headers(res.headers);
  if (!headers.has(POLICY)) headers.set(POLICY, pagePolicy(url.origin));
  return new Response(request.method === "HEAD" ? null : res.body, { status: res.status, headers });
}

/* ---------- Routing ---------- */

/** The web directory's files outside /__web/ (cloud-worker/web/). */
const WEB_FILES: ReadonlySet<string> = new Set(["/robots.txt", "/favicon.ico", "/apple-touch-icon.png", "/og.png"]);

export async function handlePublic(
  request: Request,
  env: Env,
  ctx: ExecutionContext | undefined,
  url: URL,
): Promise<Response> {
  const path = url.pathname;
  if (path.startsWith("/__web/") || WEB_FILES.has(path)) return deliver(notFoundPage(), request, url);

  const shared = await openWorkspace(env);
  if (!shared) return deliver(path === "/" ? landingPage(null) : notFoundPage(), request, url);
  const ws = await serving(env, shared, url);
  if (!ws) return deliver(notFoundPage(), request, url);

  const cache = cacheStore();
  const key = cacheKey(ws, url);
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return deliver(withCacheControl(hit, "no-cache"), request, url);
  }
  const res = await route(ws, url);
  if (cache && cacheable(res)) {
    const put = cache.put(key, withCacheControl(res.clone(), `public, max-age=${CACHE_TTL_S}`));
    if (ctx) ctx.waitUntil(put);
    else await put;
  }
  return deliver(res, request, url);
}

/**
 * The workspace a path is served from. The shared one answers `/`, its own
 * addresses, and everything that could not be an address; an address it does
 * not hold is looked up once and served from the space that does. Null when
 * nobody holds it — a 404 that is never cached, because no manifest it could
 * be keyed by moves when some space later claims the address.
 */
async function serving(env: Env, shared: Workspace, url: URL): Promise<Workspace | null> {
  let slug: string;
  try {
    slug = decodeURIComponent(url.pathname.split("/")[1] ?? "");
  } catch {
    return shared;
  }
  if (!SLUG_RE.test(slug) || RESERVED_SLUGS.has(slug) || Object.hasOwn(shared.manifest.public ?? {}, slug)) return shared;
  const space = await spaceAt(env, slug);
  return space ? openWorkspace(spaceEnv(env, space), shared.name) : null;
}

/** The path's segments, percent-decoded; null when one is malformed or would create a segment of its own. */
function decodeSegments(pathname: string): string[] | null {
  const raw = pathname.split("/").slice(1);
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop(); // a trailing slash
  const out: string[] = [];
  for (const seg of raw) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      return null;
    }
    if (decoded === "" || decoded === "." || decoded === ".." || /[/\\\0]/.test(decoded)) return null;
    out.push(decoded);
  }
  return out;
}

async function route(ws: Workspace, url: URL): Promise<Response> {
  const pub = new PublicMap(ws);
  const segs = decodeSegments(url.pathname);
  if (!segs) return notFoundPage();
  const view = url.searchParams.get("v") === "md" ? "md" : "auto";

  if (segs.length === 0) {
    // The root page — unless the map names none, or names a file that is
    // gone: the domain root then falls back to the landing page instead of
    // 404ing the whole site (the page itself still 404s under its slug).
    const dangling = pub.root?.entry.kind === "file" && !ws.file(pub.root.entry.file);
    if (!pub.root || dangling) return landingPage(ws.name);
    return pageResponse(ws, pub, pub.root, [], url, view, true);
  }
  // The root page's own rendition: `/raw` is reserved, so it can't be a slug.
  if (segs.length === 1 && segs[0] === "raw") {
    if (!pub.root || pub.root.entry.kind !== "file") return notFoundPage();
    const loc = ws.file(pub.root.entry.file);
    return loc ? rawRendition(ws, loc) : notFoundPage();
  }
  const page = pub.page(segs[0]);
  if (!page) return notFoundPage();
  return pageResponse(ws, pub, page, segs.slice(1), url, view, false);
}

/** A public entry at `/<slug>` (or at `/`, when it is the root page), plus whatever comes after. */
async function pageResponse(
  ws: Workspace,
  pub: PublicMap,
  page: Page,
  rest: string[],
  url: URL,
  view: "auto" | "md",
  atRoot: boolean,
): Promise<Response> {
  const own = atRoot ? "/" : `/${page.slug}`;
  if (page.entry.kind === "file") {
    // The entry outlives its file by design: while the file is gone, so is the page.
    const loc = ws.file(page.entry.file);
    if (!loc) return notFoundPage();
    if (rest.length === 0) {
      return notePage(ws, pub, loc, {
        url,
        pagePath: own,
        dirSlug: null,
        crumb: null,
        title: page.entry.title,
        desc: page.entry.desc,
        view,
      });
    }
    if (rest.length === 1 && rest[0] === "raw") return rawRendition(ws, loc);
    return notFoundPage();
  }

  const dir: DirPage = { slug: page.slug, entry: page.entry };
  if (rest.length === 0) return tocPage(ws, dir, { url, pagePath: own });

  // Inside the folder: a note (its extension dropped), its rendition at
  // …/raw, or an html document by its exact path.
  const wantRaw = rest.length >= 2 && rest[rest.length - 1] === "raw";
  const inner = wantRaw ? rest.slice(0, -1) : rest;
  const relPath = inner.join("/");
  const full = dir.entry.path ? `${dir.entry.path}/${relPath}` : relPath;
  if (!validPath(full)) return notFoundPage();
  const note = ws.noteAt(full) ?? (isMarkdownPath(full) ? ws.fileAt(full) : null);
  if (note) {
    if (wantRaw) return rawRendition(ws, note);
    return notePage(ws, pub, note, {
      url,
      pagePath: nestedUrl(dir, note.file.path),
      dirSlug: dir.slug,
      crumb: { href: atRoot ? "/" : own, label: dirTitle(ws, dir) },
      view,
    });
  }
  if (wantRaw) return notFoundPage();
  const exact = ws.fileAt(full);
  return exact ? htmlFile(ws, exact) : notFoundPage();
}
