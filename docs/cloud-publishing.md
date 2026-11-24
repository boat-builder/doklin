# Cloud publishing

Publishing = an entry in the manifest's `public` map (format and routes:
[cloud-worker/README.md](../cloud-worker/README.md)). Nothing is pushed; the
worker renders synced blobs on request. See also [cloud.md](cloud.md).

## The map

- A file entry holds the fileId (a rename carries the page) and a `path` snapshot (a deleted-and-recreated file at that path re-binds). It names a document's file — its markdown, else its html: a page of anything else is refused (`syncs`, `layout.ts`), so a picture or a PDF is never a page. A folder entry (`""` = whole workspace) publishes every note under it — no membership list; the engine re-points it when all its files moved to one new prefix in one cycle.
- An entry outlives its file: 404 while gone, back when the file is; stopping is explicit. `root: true` whose file is gone → `/` serves the landing page.
- Offline publishing: the engine queues `public_ops` in its state and `fold_public` folds them into the next won CAS (re-point renames, re-bind dead entries, apply ops, re-point folders).
- Slug grammar `^[a-z0-9][a-z0-9-]{2,63}$` and reserved words live in `layout.ts`, `manifest.rs`, `src/cloud.ts` and the iPhone's `Publishing.swift`; the random-slug alphabet (8 of `abcdefghjkmnpqrstuvwxyz23456789`) in `manifest.rs` and `publishing.ts`. **Change all.** `app` is reserved for the browser version: every public address starts with a slug, so nothing is ever published under `/app`. Custom slugs are checked against the manifest locally; two devices racing one slug: the loser gets a suffix.
- Anyone who may write the manifest may publish: members always (from a browser too, `webPages.ts`), agents with `publish` — from any section their person can see, into that section's map. The rules an entry keeps are written once for the worker's own publishing (`publishing.ts`).
- `CloudStatus.public` = manifest + unsynced ops, of every section this Mac holds; `alive` false when the file is gone or a folder holds no synced file.
- Each section has its own map. The page at `/` is chosen from the shared workspace's only; a space's map naming a `root` is refused.
- An owner can stop any page on the domain (`/api/pages`), but only a person in its section can open or re-publish its file.

## Addresses

- `/<slug>`; inside a folder `/<dirSlug>/<rel>` (markdown extension dropped, segments percent-encoded, case-insensitive). An html document serves by its exact path; nothing else does — a workspace holds only documents, so there is no picture or PDF to serve. A subfolder is not a page.
- A note can answer on its own slug and inside a published folder at once. `PublicMap.urlFor` prefers the folder the page was reached through, then the file's own slug, then the closest published folder (deepest first).
- `<stem>.html` beside a note is its rendition: framed by default, `?v=md` the markdown, `/raw` verbatim. html serves under `Content-Security-Policy: sandbox allow-scripts allow-popups`.

## Rendering (`cloud-worker/src/`)

`workspace.ts` (synced tree), `publicMap.ts` (where is it public), `pages.ts` (page from files), `render.ts` (HTML), `theme.ts` (app tokens and font faces, imported at build), `public.ts` (routing, cache), `static.ts` (landing, 404). They reuse the app's pure modules (`src/criticMarkup.ts`, `src/frontmatter.ts`, `src/metaFile.ts`, `src/docLinks.ts`, `src/drawingSvg.ts`) so a page cannot disagree with the app.

The files pages ask for — fonts, icons, `og.png`, `robots.txt`, the flowchart module — are static assets in the web directory `scripts/bundle-worker.mjs` builds (`doklin-cloud-web/`; `og.png`, `robots.txt` and `_headers` from `cloud-worker/web/`). Cloudflare serves them without running the worker, so they cost none of the day's requests and a public page view is one request. An asset path that reaches the worker is a 404 without a bucket read. `_headers`: no path may match two `Cache-Control` rules (Cloudflare joins them with a comma).

- Comment markers stripped; thread bodies never leave the sidecar. From `<stem>.meta.jsonl` only table widths, under the app's table identity (`tableSignature` in `render.ts` ⇄ `src/tableWidths.ts`, byte-compatible), and link records are used.
- The frontmatter block is left off the page (`splitFrontmatter`, `src/frontmatter.ts`): only the body is rendered.
- ```` ```svg ```` drawings are drawn by the worker through the app's `sanitizeDrawing` (ids namespaced `dg<n>-` per page), so they show with scripts off; one that doesn't parse stays a code block. A ```` ```mermaid ```` flowchart stays a code block (`<pre data-dk-flowchart>`) until the flowchart module (`cloud-worker/web/flowchart-entry.ts`) draws it with the app's renderer (`src/flowchart/`); only a page with a flowchart names the module in a script tag. It is drawn in the reader's browser, never by the worker: one layout costs more processor time than the Free plan gives a request, so the worker imports `src/flowchart/kind.ts` and nothing else of the renderer. Any other kind of Mermaid diagram is a code block.
- Callouts (`> [!NOTE]`): a top-level quote whose first line is a marker alone is found before rendering (`markCallouts`: a renderer can't tell a quote's depth) and drawn as the app draws it, from `src/calloutTypes.ts`; its body is lexed again without the marker line, so a reference link defined outside a callout doesn't resolve inside one. The marker is left out of the description.
- Links (`linkResolver`, `pages.ts`): a link with a record goes by its file id, in the page's own section or Library, to that document's URL (`urlFor` order), a named one with its name now; a *Copy link* to a page of this workspace goes by its ids the same way (`src/pageLink.ts`). A document in any other section, like an unpublished one, is the link's words: a page is drawn from those two trees only, and cached under both. A link without a record goes by its path: relative targets resolve against the note's folder (`..` can't escape the section). Public target → its URL; unpublished → plain text; a relative image → its alt text (pictures stay on their device); other schemes, anchors, absolute paths — images on the web included — untouched.
- A note over 4 MB is refused. The manifest is read tolerantly: unknown fields never break a page, and a file outside `syncs`, or a page of one, reads as absent.
- Every page: `<meta name="robots" content="noindex">` + `x-robots-tag`. No access codes, web editor or web comments. OG image is one static PNG.

## What a page may do

HTML written into a note's markdown is drawn as written, on the origin the workspace's API answers on. What keeps it from acting is the page policy (`pagePolicy`, `public.ts`), not the renderer.

- Every page the worker draws — note, framed rendition, folder, landing, 404 — is served under one `Content-Security-Policy`: `default-src 'none'`; `script-src` the flowchart module's full address and nothing else; `style-src 'unsafe-inline'` (the inline sheet, `<col style>`); pictures, media and frames from anywhere; `form-action 'none'`; `base-uri 'none'`. An html document keeps its `sandbox` instead, never both.
- No page carries an inline script, and none may: `script-src` has no hash, nonce or `'self'`. Browser code a page needs goes in the flowchart module. `'self'` would let a note run any script the domain serves.
- The policy is set on the way out (`deliver`), never where a page is drawn: it names the request's origin, and the cache key names no host.
- Every answer of the worker's (`index.ts`) and every static file (`_headers`) is `X-Content-Type-Options: nosniff`, so a stored file is never loaded as a script or a stylesheet.
- The same origin answers signed-in browsers ([cloud-people-agents.md](cloud-people-agents.md) *A browser*), and their cookie goes with every request a page makes. A page reaching nothing with it rests on two lines of this policy: `default-src 'none'` (a page fetches nothing) and the one-address `script-src`. Loosen either and a note can act as whoever is reading it.

## Cache

- `caches.default`, key `https://cache.doklin/<webTag>/<manifestEtag><pathname><search>`, a space's page `<etag>@<space>+<Library's etag>` since its links lead into Library too; 200s and 404s kept a day; browser gets `no-cache`. The web tag is in the key because a page names the flowchart module by it: a deploy that changes the module serves no cached page asking for one that is gone. A manifest change gives every URL a new key, so a page is never stale past one `head` (steady state: one head, one hit).
