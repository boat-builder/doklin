// The public surface — no auth, GET/HEAD only (docs/cloud-redesign.md §5.3,
// §5.6). The static assets and the landing page answer without touching the
// workspace; everything else is resolved against the manifest's public map
// and rendered from synced blobs (pages.ts), through a cache keyed by the
// manifest's etag:
//
//   GET /                        the root page when the map names one, else the landing page
//   GET /<slug>                  a published note (html rendition when it has one; ?v=md the markdown)
//   GET /<slug>/raw              the html rendition verbatim, sandboxed (what the framed page loads)
//   GET /<dirSlug>               a published folder: its table of contents
//   GET /<dirSlug>/<rel/path>    a note inside it (`.md` dropped, segments percent-encoded), its
//                                rendition at …/raw, or an image / PDF / html file by exact path
//   GET /og.png · /<slug>/og.png the site's static Open Graph image
//   GET /__web/<tag>/mermaid.js  the standalone mermaid module (immutable, content-tagged)
//   robots.txt, favicon.ico, apple-touch-icon.png
//
// Every page carries <meta name="robots" content="noindex">.

import type { Env } from "./env";
import { validPath } from "./layout";
import { dirTitle, fileResponse, notePage, rawRendition, tocPage } from "./pages";
import { PublicMap, nestedUrl, type DirPage, type Page } from "./publicMap";
import {
  appleTouchIcon,
  favicon,
  landingPage,
  mermaidModule,
  notFoundPage,
  ogImage,
  robotsTxt,
} from "./static";
import { isMarkdownPath, openWorkspace, type Workspace } from "./workspace";

/* ---------- The cache ----------

   A render is a handful of R2 reads (a board with forty cards is forty).
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

export const cacheKey = (etag: string, url: URL): string =>
  `https://cache.doklin/${etag}${url.pathname}${url.search}`;

const cacheable = (res: Response): boolean =>
  (res.status === 200 || res.status === 404) && !res.headers.has("set-cookie");

function withCacheControl(res: Response, value: string): Response {
  const headers = new Headers(res.headers);
  headers.set("cache-control", value);
  return new Response(res.body, { status: res.status, headers });
}

/** A GET response, or its headers alone for HEAD. */
const deliver = (res: Response, method: string): Response =>
  method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;

/* ---------- Routing ---------- */

export async function handlePublic(
  request: Request,
  env: Env,
  ctx: ExecutionContext | undefined,
  url: URL,
): Promise<Response> {
  const path = url.pathname;
  if (path === "/robots.txt") return deliver(robotsTxt(), request.method);
  if (path === "/favicon.ico") return deliver(favicon(), request.method);
  if (path === "/apple-touch-icon.png") return deliver(appleTouchIcon(), request.method);
  if (path === "/og.png" || /^\/[^/]+\/og\.png$/.test(path)) return deliver(ogImage(), request.method);
  if (/^\/__web\/[a-z0-9]+\/mermaid\.js$/.test(path)) return deliver(mermaidModule(), request.method);

  const ws = await openWorkspace(env);
  if (!ws) return deliver(path === "/" ? landingPage(null) : notFoundPage(), request.method);

  const cache = cacheStore();
  const key = cacheKey(ws.etag, url);
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return deliver(withCacheControl(hit, "no-cache"), request.method);
  }
  const res = await route(ws, url);
  if (cache && cacheable(res)) {
    const put = cache.put(key, withCacheControl(res.clone(), `public, max-age=${CACHE_TTL_S}`));
    if (ctx) ctx.waitUntil(put);
    else await put;
  }
  return deliver(res, request.method);
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
  // …/raw, or a file by its exact path.
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
  return exact ? fileResponse(ws, exact) : notFoundPage();
}
