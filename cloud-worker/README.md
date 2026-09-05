# Doklin cloud worker

One Cloudflare Worker in front of one R2 bucket, serving one workspace's
cloud at one domain: the private sync API the app's engine speaks, and the
public pages rendered from the synced files.
The whole system — the engine, this worker, the app's surfaces, the
decisions — is described in [docs/cloud.md](../docs/cloud.md); this file is
the worker's contract.

**What it serves.** Version 2: the sync API, the meta probe and the owner's
wipe, and publishing — the public map served as pages rendered from synced
blobs: a note, its html rendition behind the MD/HTML pill, a folder's table
of contents with nested addresses, boards and tables derived from a
datastore, a card's properties, column widths, links between public notes,
the root page, a static OG image, and a cache keyed by the manifest's etag.
The engine that drives this API from the app is `src-tauri/src/cloud/`; the
app's setup wizard, update card and teardown step write the prompts that
deploy, update and remove a worker — `src/cloudPrompts.ts` is their one
source, and the deploy steps below are the same procedure by hand.

## The rules it keeps

- **One domain ⇄ one workspace.** `workspace.json` is written with R2's
  create-only put; a second bind answers `409` with what the domain holds
  and never overwrites. A domain is bound iff that object exists, and the
  only thing that removes it is the owner's wipe.
- **The engine is the only caller.** Bearer auth on every `/api` route, no
  CORS, no preflight, no cookies, no sessions. The visitor's surface is
  URLs, `GET`/`HEAD`, and nothing to unlock.
- **Nothing public is stored.** The bucket is the synced workspace — a
  manifest and content-addressed blobs. A public page is a rendering of
  those files, so it can never be staler than the sync, or fresher.
- **The API only grows; an old worker fails legibly.** One version integer
  (`src/version.ts`), reported by `/api/meta`, compared by the app with the
  integer it was built against. A manifest whose schema this worker
  predates gets `426`, which the engine turns into "update the worker".

## The bucket

```
workspace.json              {id, name, createdAt, createdBy: {deviceId, deviceName}}
                            — the binding. Written once, create-only.
manifest.json               the workspace manifest (v2, below) — CAS by etag
blobs/<fileId>/<hash>       immutable file content, addressed by (a prefix of) its sha256
history/<fileId>.json       deep revision archive (entries rolled out of the manifest's hist)
presence.json               {devices: {<deviceId>: {name, path?, ts}}} — TTL'd, best effort
versions/index.json         {version, horizonDays, snapshots: [...]} — the version store — CAS by etag
versions/snapshots/<id>.json.gz   one workspace state, gzip'd; immutable. <id> is <ts13>-<deviceId>
versions/blobs/<hash>       one file's content, gzip'd; immutable, keyed by its full sha256
auth/tokens/<sha256>.json   {id, name, email?, role, createdAt, lastSeenAt}   ← empty until invites exist
auth/invites/<sha256>.json  {email, role, createdAt, expiresAt}               ← empty until invites exist
```

### The manifest (v2)

```json
{
  "version": 2,
  "name": "Notes",
  "seq": 812,
  "files": {
    "f-3kq8x1": { "path": "Projects/plan.md", "rev": 7, "hash": "9c1e…", "size": 4310,
                  "mtime": 1757000000000, "by": "Sherin's MacBook Pro",
                  "hist": [ { "r": 6, "h": "…", "s": 4211, "t": 1756900000000, "b": "…" } ] }
  },
  "tombstones": { "f-old": { "path": "Scratch.md", "rev": 3, "ts": 1756800000000, "by": "…" } },
  "public": {
    "k7m2p9qx": { "kind": "file", "file": "f-3kq8x1", "path": "Projects/plan.md", "by": "…", "at": 1757000000000 },
    "roadmap":  { "kind": "dir",  "path": "Projects/Roadmap", "title": "Roadmap", "desc": "…", "by": "…", "at": 1757000000000 },
    "home":     { "kind": "file", "file": "f-77a1b2", "path": "Home.md", "root": true, "by": "…", "at": 1757000000000 }
  }
}
```

`public` is the public map, keyed by slug (`^[a-z0-9][a-z0-9-]{2,63}$`, not
one of `api`, `__web`, `raw`, `og.png`, `robots.txt`, `favicon.ico`,
`apple-touch-icon.png`, `join`). A file entry references the file id — a
rename carries the page — and snapshots the path, so a file deleted and
recreated at the same path can be re-bound; a folder entry (`""` is the
workspace root) exposes every note under it. `root: true` on at most one
entry makes it the page at `/`.

Every `PUT` is shape-checked (`src/manifest.ts`): ids, hashes, relative
paths with no traversal, one path per file (case-insensitive), revision
and size ranges, the inline history cap, slug grammar and reserved words,
well-formed references, one root. References are **not** checked for
existence: a public entry outlives its file on purpose (the page 404s while
the file is gone and comes back when the file does — stopping is explicit),
and a folder entry may cover a folder that is empty right now. Semantics
(which revision wins, merges, what to do with a tombstone) are the engine's.

## The API

All `/api/*` routes require `Authorization: Bearer <token>` and answer JSON.
The engine also sends `x-doklin-device: <deviceId>` (attribution: presence,
the binding's `createdBy`) and `x-doklin-client: <app version>` (for the
logs; nothing reads it).

```
GET    /api/meta                 {version, features, workspace: {id, name, createdAt, createdBy} | null}
                                 — liveness, the credential and "is this domain bound" in one call
POST   /api/workspace            owner; bind: body {name, deviceName?} → 201 {id, name, createdAt,
                                 createdBy, manifestEtag}; 409 {workspace} when already bound
GET    /api/workspace            {id, name, createdAt, createdBy, files, bytes}
GET    /api/poll                 {manifestEtag, presence} — the cheap 15 s poll
GET    /api/manifest[?since=e]   the manifest + x-manifest-etag (304 when unchanged)
PUT    /api/manifest             header x-base-etag required (428 without); 412 + current etag
                                 on a lost race; 400 on garbage; 426 on a newer schema; 413 past 4 MB
GET    /api/blobs/<fid>          {blobs: [{hash, size, uploaded}]} — the inventory GC diffs
GET    /api/blobs/<fid>/<hash>   the bytes (content-type as uploaded)
PUT    /api/blobs/<fid>/<hash>   store bytes (immutable: a re-PUT of a stored hash is a no-op,
                                 {existed: true}); 413 past 25 MB
DELETE /api/blobs/<fid>/<hash>   garbage-collect an unreferenced revision
GET    /api/history/<fid>        {version: 1, entries: [{r, h, s, t, b?}]}; 404 when there is none
PUT    /api/history/<fid>        replace the archive (advisory, ≤ 200 entries, ≤ 256 KB)
DELETE /api/history/<fid>        drop the archive; 204 whether or not one was there
GET    /api/versions/index       the version store's index + x-versions-etag; 404 when there is none
PUT    /api/versions/index       header x-base-etag required (428 without), "*" creates; 412 + etag
                                 on a lost race; 400 on garbage; 413 past 1 MB
GET    /api/versions/snapshots/<id>   the gzip'd workspace state; 404
PUT    /api/versions/snapshots/<id>   store it (immutable: a re-PUT is {existed: true}); 413 past 4 MB
DELETE /api/versions/snapshots/<id>   drop one the ladder thinned away
GET    /api/versions/blobs[?cursor=c] {blobs: [{hash, size, uploaded}], cursor?} — one page
GET    /api/versions/blobs/<hash>     the bytes
PUT    /api/versions/blobs/<hash>     store bytes (immutable, {existed: true} on a re-PUT); 413 past 25 MB
DELETE /api/versions/blobs/<hash>     garbage-collect a version no retained snapshot references
PUT    /api/presence             body {name?, path?} — "this device is here, editing path"
                                 (path absent or null: here, idle); needs x-doklin-device
DELETE /api/presence             this device left
POST   /api/admin/wipe           owner; body {"confirm":"wipe"} — erase everything, batched;
                                 repeat until remaining:false. Frees the domain for a new binding.
```

Not bound yet? `/api/poll`, `/api/manifest` and `/api/workspace` answer
`404 {"error":"not bound"}`.

Reserved for invites (docs/cloud.md §8.1), not built: `POST /api/auth/join`,
`GET/POST/DELETE /api/auth/invites`, `GET/DELETE /api/auth/tokens`.

### Public (no auth, `GET`/`HEAD` only)

```
GET /                          the root page when the map names one (and its file exists),
                               else the landing page (the workspace's name, "Download Doklin")
GET /<slug>                    a published note: its html rendition, framed, when the workspace
                               holds <stem>.html beside it; the markdown otherwise
GET /<slug>?v=md               the markdown rendering explicitly (the MD/HTML pill)
GET /<slug>/raw                the html rendition verbatim, under Content-Security-Policy: sandbox
GET /<dirSlug>                 a published folder: every note under it, as a table of contents
GET /<dirSlug>/<rel/path>      a note inside it (markdown extension dropped, segments
                               percent-encoded, case-insensitive), its rendition at …/raw, or an
                               image / PDF / html file by its exact path (anything else 404s)
GET /og.png · /<slug>/og.png   the site's static Open Graph image
GET /robots.txt · /favicon.ico · /apple-touch-icon.png
GET /__web/<tag>/mermaid.js    the standalone mermaid module (immutable, content-tagged)
everything else                a 404 page — an unpublished path, a slug whose file is gone
```

Every page carries `<meta name="robots" content="noindex">` (and the
`x-robots-tag` header). A note renders from its blob with comment markers
stripped (`src/criticMarkup.ts`), its frontmatter as a properties table
coloured by the folder's `store.jsonl`, each ` ```kanban ` / ` ```table `
fence drawn from the store it names (`src/store/board.ts` — the app's own
derivation; at most 40 cards read, the rest counted), table column widths
from `<stem>.meta.jsonl`, and relative links rewritten to public addresses
— inside the folder the page was reached through first, then the target's
own slug, then the closest published folder — or dropped to their text.
Renders are cached in `caches.default` under
`https://cache.doklin/<manifestEtag><path><search>`: a manifest change
gives every URL a new key, so a page is never stale past one `head`.

## Auth

`OWNER_TOKEN` (the worker secret; 32 random bytes hex, minted by the app at
setup) is compared by SHA-256 in constant time — role `owner`. Any other
bearer is looked up as `auth/tokens/<sha256(token)>.json`, the record an
invite will mint for a member: role `member`, may sync and publish; only
the owner may bind, wipe, invite or revoke. No invite exists yet, so the
lookup finds nothing today — it is there so *resolving* a member token is an
addition, not a change. The route that mints one is not: `POST
/api/auth/join` has to answer without a bearer, so it carves out above the
gate (docs/cloud.md §8.1). Revocation is deleting the object.

A member is not a limited account: `PUT /api/manifest` is not role-gated, so
any valid bearer can rewrite the manifest wholesale. Owner-only is exactly
bind and wipe.

## Deploying

The app writes the whole procedure into a prompt for an agent
(`buildSetupPrompt` in `src/cloudPrompts.ts`; docs/cloud.md §7.4 walks its
nine steps). By hand, the same steps:

Names derive from the domain — `notes.example.com` → worker and bucket
`doklin-notes-example-com`; a free `workers.dev` address with the chosen
name `sherin-notes` → `doklin-sherin-notes` — so two setups can never
collide. The secret is `OWNER_TOKEN`, the R2 binding is `DATA`.

```sh
mkdir doklin-cloud && cd doklin-cloud
curl -fsSL https://github.com/boat-builder/doklin/releases/latest/download/doklin-cloud-worker.js \
     -o doklin-cloud-worker.js        # or: node scripts/bundle-worker.mjs in this repo
npx -y wrangler@4 whoami              # `wrangler login` first if it asks
# wrangler.toml: copy wrangler.toml.example, fill in the account id, domain, names
npx -y wrangler@4 r2 bucket create doklin-notes-example-com   # before deploy — it must exist
npx -y wrangler@4 secret put OWNER_TOKEN                     # paste the token the app shows
npx -y wrangler@4 deploy
curl -fsS -H "Authorization: Bearer $TOKEN" https://notes.example.com/api/meta
# → {"version":2,"features":["sync","wipe","publish","boards"],"workspace":null}
```

A custom domain needs its zone active on the same Cloudflare account, and
the first TLS certificate can take a minute after deploy.

**Update:** fetch the new bundle, `wrangler deploy` over the same name; the
secret and the bucket stay. **Teardown:** the app's wipe empties the bucket
(R2 refuses to delete a non-empty one), then `wrangler delete --name …` and
`wrangler r2 bucket delete …`.

**The prompts** are these steps written for an agent, with the checks a
person would skip: setup verifies the names are free before it creates
anything (a same-name deploy silently replaces a worker), pauses for an
account that has never enabled R2 or whose zone isn't on Cloudflare yet,
carries the token to `secret put` — it is the one secret the setup prompt
holds — and ends with one line back, `ENDPOINT: https://…`. Update carries
no secret, confirms the worker's name before deploying over it (certain for
a workers.dev address, a convention to verify for a custom domain) and
verifies with an unauthenticated `/api/meta` (a `401` means the new worker
is up), ending with `UPDATED:`. Teardown carries no secret either, runs
only after the app's wipe, refuses to force a non-empty bucket, and ends
with `TORN DOWN:`. Every prompt closes with the negative scope: no other
Cloudflare resource is touched, `wrangler.toml` is committed nowhere.

## Developing

```sh
pnpm typecheck:worker      # tsc against the Workers runtime types (no DOM)
pnpm test:worker           # node cloud-worker/test/run.mjs — an in-memory R2, every route,
                           # the renderer over test/seed.mjs (a workspace with a bit of everything)
pnpm bundle:worker         # → cloud-worker/dist/doklin-cloud-worker.js, size printed
node scripts/bundle-worker.mjs --no-mermaid    # a quick bundle without the mermaid module
node verify-harness/serve-worker.mjs           # the bundled worker over the seed, on :8787 —
                                               # open it in a browser, or run drive-public.mjs
```

The sources are TypeScript (`src/`), and the renderer imports the app's own
pure modules (`src/store/`, `src/metaFile.ts`, `src/criticMarkup.ts`,
`src/docLinks.ts`) so a published board can't disagree with the board in
the app; `scripts/bundle-worker.mjs` flattens them with vite into one
readable file — people are asked to trust-deploy it
— with the standalone mermaid module (`web/mermaid-entry.ts`) spliced into
`src/assets.ts` as a string. The checked-in `assets.ts` is empty so the
tests compile the worker without building mermaid. The bundle prints its
size raw and gzipped and fails past Cloudflare's 3 MB compressed ceiling;
mermaid is most of what it carries. CI runs all three; the release workflow
attaches the bundle to every GitHub release.

`src/version.ts` is the one place the version lives. Bump `WORKER_VERSION`
when the API grows, keep the declaration on its own line in the shape the
regex expects, and add the feature name to `WORKER_FEATURES`.
