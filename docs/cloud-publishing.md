# Cloud publishing

Publishing = an entry in the manifest's `public` map (format and routes:
[cloud-worker/README.md](../cloud-worker/README.md)). Nothing is pushed; the
worker renders synced blobs on request. See also [cloud.md](cloud.md).

## The map

- A file entry holds the fileId (a rename carries the page) and a `path` snapshot (a deleted-and-recreated file at that path re-binds). A folder entry (`""` = whole workspace) publishes every note under it — no membership list; the engine re-points it when all its files moved to one new prefix in one cycle.
- An entry outlives its file: 404 while gone, back when the file is; stopping is explicit. `root: true` whose file is gone → `/` serves the landing page.
- Offline publishing: the engine queues `public_ops` in its state and `fold_public` folds them into the next won CAS (re-point renames, re-bind dead entries, apply ops, re-point folders).
- Slug grammar `^[a-z0-9][a-z0-9-]{2,63}$` and reserved words live in `layout.ts`, `manifest.rs`, `src/cloud.ts`; the random-slug alphabet (8 of `abcdefghjkmnpqrstuvwxyz23456789`) in `manifest.rs` and `agentPages.ts`. **Change all.** Custom slugs are checked against the manifest locally; two devices racing one slug: the loser gets a suffix.
- Anyone who may write the manifest may publish: members always, agents with `publish` — from any section their person can see, into that section's map.
- `CloudStatus.public` = manifest + unsynced ops, of every section this Mac holds; `alive` false when the file is gone or a folder holds no synced file.
- Each section has its own map. The page at `/` is chosen from the shared workspace's only; a space's map naming a `root` is refused.
- An owner can stop any page on the domain (`/api/pages`), but only a person in its section can open or re-publish its file.

## Addresses

- `/<slug>`; inside a folder `/<dirSlug>/<rel>` (markdown extension dropped, segments percent-encoded, case-insensitive). Non-markdown files serve by exact path only if image, PDF or html; else 404. A subfolder is not a page.
- A note can answer on its own slug and inside a published folder at once. `PublicMap.urlFor` prefers the folder the page was reached through, then the file's own slug, then the closest published folder (deepest first).
- `<stem>.html` beside a note is its rendition: framed by default, `?v=md` the markdown, `/raw` verbatim. html and svg serve under `Content-Security-Policy: sandbox allow-scripts allow-popups`.

## Rendering (`cloud-worker/src/`)

`workspace.ts` (synced tree), `publicMap.ts` (where is it public), `pages.ts` (page from files), `render.ts` (HTML), `theme.ts` (app tokens and fonts, imported at build), `public.ts` (routing, cache), `static.ts` (landing, 404, icons, OG, fonts, mermaid). They reuse the app's pure modules (`src/criticMarkup.ts`, `src/store/`, `src/metaFile.ts`, `src/docLinks.ts`) so a page cannot disagree with the app.

- Comment markers stripped; thread bodies never leave the sidecar. From `<stem>.meta.jsonl` only table widths are used, under the app's table identity (`tableSignature` in `render.ts` ⇄ `src/tableWidths.ts`, byte-compatible).
- Frontmatter → properties table coloured by the folder's `store.jsonl`; `rank` never shown.
- kanban/table fences drawn with `boardSnapshot`; at most 40 cards read (`MAX_STORE_CARDS`), the rest counted — a bigger read would blow the per-request subrequest cap.
- Links: relative targets resolve against the note's folder (`..` can't escape the workspace). Public target → its URL (`urlFor` order); unpublished → plain text; relative image → `<img>` if reachable, else alt text; other schemes, anchors, absolute paths untouched. Board card links follow the same rule.
- A note over 4 MB is refused. The manifest is read tolerantly: unknown fields never break a page.
- Every page: `<meta name="robots" content="noindex">` + `x-robots-tag`. No access codes, web editor or web comments. OG image is one static PNG.

## Cache

- `caches.default`, key `https://cache.doklin/<manifestEtag><pathname><search>`; 200s and 404s kept a day; browser gets `no-cache`; static assets bypass. A manifest change gives every URL a new key, so a page is never stale past one `head` (steady state: one head, one hit).
