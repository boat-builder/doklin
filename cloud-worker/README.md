# Doklin cloud worker

One Cloudflare Worker in front of one R2 bucket and one D1 database, serving
one workspace's cloud at one domain: the private sync API the app's engine
speaks, and the public pages rendered from the synced files.
The whole system — the engine, this worker, the app's surfaces, the
decisions — is described in [docs/cloud.md](../docs/cloud.md); this file is
the worker's contract.

**What it serves.** Version 5: the sync API, the meta probe and the owner's
wipe; publishing — the public map served as pages rendered from synced
blobs: a note, its html rendition behind the MD/HTML pill, a folder's table
of contents with nested addresses, boards and tables derived from a
datastore, a card's properties, column widths, links between public notes,
the root page, a static OG image, and a cache keyed by the manifest's etag;
the mirrored version store; and people — members, per-device tokens and
one-time invites in the D1 database beside the bucket.
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
manifest.json               the workspace manifest (v3, below) — CAS by etag
blobs/<fileId>/<hash>       immutable file content, addressed by (a prefix of) its sha256
presence.json               {devices: {<deviceId>: {name, path?, ts}}} — TTL'd, best effort
versions/index.json         {version, horizonDays, snapshots: [...]} — the version store — CAS by etag
versions/snapshots/<id>.json.gz   one workspace state, gzip'd; immutable. <id> is <ts13>-<deviceId>
versions/blobs/<hash>       one file's content, gzip'd; immutable, keyed by its full sha256
```

Nobody is stored here — people and their credentials are rows next door.

## The database

A D1 database beside the bucket, bound as `DB`, for the state a blob store
cannot hold: people, presence and file leases
([docs/teams-plan.md](../docs/teams-plan.md)). Today it holds the first:

```sql
meta     (key, schema_version)                   one row — the runner's anchor
members  (id, email UNIQUE, name, role, created_at, last_seen_at, disabled)
tokens   (hash, id, member_id, device_id, device_name, created_at)
invites  (hash, id, member_id, created_at, expires_at)
```

An *identity* is not a *credential*, and the three tables are that sentence.
A **member** is permanent and keyed by their normalized email, so a new Mac
re-reaches the same person and a lost laptop costs nothing but a re-invite.
A **token** is per-device and disposable. An **invite** is a token nobody has
claimed yet. Neither secret is stored: `tokens.hash` is `sha256(token)` and
`invites.hash` is `sha256(code)`, so the database is a list of people rather
than a list of credentials — and `last_seen_at` is written by the presence
beat, never by authenticating, which would be a write on every request.

The worker owns its schema (`src/schema.ts`). An update ships one bundled
file and no migrations directory, so `wrangler d1 migrations apply` is not
available to a domain being updated: instead an ordered list of steps runs
on the `/api/meta` probe, at most once per isolate, with idempotent
`CREATE TABLE IF NOT EXISTS` statements and a guarded
`UPDATE meta SET schema_version = <to> WHERE schema_version = <to-1>`, so
two isolates reaching a fresh database converge rather than collide.

The binding is optional and the whole sync API is indifferent to it: a
domain deployed before it existed has no `DB`, and one whose database is
broken or deleted keeps serving every sync route — `/api/meta` reports
`"d1": null`. What it cannot do is resolve a member's token (they get a
`401`) or answer an identity route (a `503`). The owner is unaffected either
way, because `OWNER_TOKEN` is matched against the worker's env secret with
no database read at all; losing D1 costs a workspace its people, never its
owner. The owner's wipe empties the tables and re-runs the schema, so a
rebound domain inherits nobody.

### The manifest (v3)

```json
{
  "version": 3,
  "name": "Notes",
  "seq": 812,
  "files": {
    "f-3kq8x1": { "path": "Projects/plan.md", "rev": 7, "hash": "9c1e…", "size": 4310,
                  "mtime": 1757000000000, "by": "m-1a2b3c4d" }
  },
  "tombstones": { "f-old": { "path": "Scratch.md", "rev": 3, "ts": 1756800000000, "by": "m-1a2b3c4d" } },
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
and size ranges, slug grammar and reserved words,
well-formed references, one root. References are **not** checked for
existence: a public entry outlives its file on purpose (the page 404s while
the file is gone and comes back when the file does — stopping is explicit),
and a folder entry may cover a folder that is empty right now. Semantics
(which revision wins, merges, what to do with a tombstone) are the engine's.

`by` is a **member id** (`m-` and eight hex characters) since v3: who
changed the file, not which Mac did. The check on it is a bounded string
rather than the id grammar, because a workspace upgraded from v2 carries the
device names it was written with, and refusing those would throw away the
attribution it already has. An app puts a name to an id through
`GET /api/meta`'s `people`.

A manifest of any other version is a **`426`**, in both directions, with a
sentence naming which side is behind — an app newer than this worker is told
to update the worker, an older one to update itself. That is the whole
compatibility promise ([docs/teams-plan.md](../docs/teams-plan.md) §2):
refuse politely, never corrupt.

### `hist` and `history/<fid>.json` — gone

The manifest used to carry each file's last revisions inline in `hist`, with
the overflow in a per-file `history/<fileId>.json` archive; between them they
were the app's version history. They are not any more — the app keeps a
version store of its own and mirrors it to `versions/` (see
[docs/versioning.md](../docs/versioning.md)).

The field, the three `/api/history/<fid>` routes, the `history/` prefix and
the caps that bounded them were all deleted in worker v6. They had been dead
since the version store landed; what kept them was compatibility with a
release nobody runs, and v6 is where that stopped being a reason. A bucket
that still holds archives keeps them until it is wiped: nothing reads one.

## The API

All `/api/*` routes require `Authorization: Bearer <token>` and answer JSON.
The engine also sends `x-doklin-device: <deviceId>` (attribution: presence,
the binding's `createdBy`) and `x-doklin-client: <app version>` (for the
logs; nothing reads it).

```
GET    /api/meta                 {version, features, workspace: {id, name, createdAt, createdBy} | null,
                                 d1: <schema version> | null,
                                 you: {role, memberId, email, name}, people: [{id, name}]}
                                 — liveness, the credential, "is this domain bound", who you are and
                                 what everyone here is called; also runs the D1 migration
POST   /api/auth/join            NO BEARER — {code, deviceId?, deviceName?} → 201 {token, tokenId, member}
                                 401 when the code is unknown or expired, which answer identically
POST   /api/auth/invites         owner; {email, name?, codeHash, expiresAt} → 201 {invite}
GET    /api/auth/invites         owner; the pending, unexpired ones
DELETE /api/auth/invites/<id>    owner; withdraw one (204)
GET    /api/auth/members         owner; everyone, with a device count and lastSeenAt
POST   /api/auth/members         owner; {email, name?} — adopt or rename the owner's own identity
DELETE /api/auth/members/<id>    owner; the person and every credential they hold (204)
GET    /api/auth/tokens          owner; {id, memberId, email, deviceName, createdAt} — never a hash
DELETE /api/auth/tokens/<id>     owner; revoke one device (204)
POST   /api/workspace            owner; bind: body {name, deviceName?} → 201 {id, name, createdAt,
                                 createdBy, manifestEtag}; 409 {workspace} when already bound
GET    /api/workspace            {id, name, createdAt, createdBy, files, bytes}
GET    /api/poll                 {manifestEtag, presence} — the cheap 15 s poll
GET    /api/manifest[?since=e]   the manifest + x-manifest-etag (304 when unchanged)
PUT    /api/manifest             header x-base-etag required (428 without); 412 + current etag
                                 on a lost race; 400 on garbage; 426 on ANY other schema version;
                                 413 past 4 MB
GET    /api/blobs/<fid>          {blobs: [{hash, size, uploaded}]} — the inventory GC diffs
GET    /api/blobs/<fid>/<hash>   the bytes (content-type as uploaded)
PUT    /api/blobs/<fid>/<hash>   store bytes (immutable: a re-PUT of a stored hash is a no-op,
                                 {existed: true}); 413 past 25 MB
DELETE /api/blobs/<fid>/<hash>   garbage-collect an unreferenced revision
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
`404 {"error":"not bound"}`. No `DB` binding? Everything under `/api/auth`
answers `503`, and nothing else changes.

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
setup) is compared by SHA-256 in constant time against the worker's env —
**with no database read**. Role `owner`. That order is the design: a D1
outage degrades a workspace to one credential rather than locking its owner
out of their own domain.

Only a bearer that is *not* the owner's costs a row read: `tokens.hash =
sha256(bearer)`, joined to the member holding it — one primary-key lookup.
Revoking is deleting that row, and it lands on that device's very next
request; there is no session, so there is nothing to expire.

A token always authenticates as `member`, whatever `members.role` says. That
column describes a *person* — what the People list shows — and never confers
authority: owner is the env secret and nothing else, so no row anybody can
write can grant it.

`POST /api/auth/join` is the one route above the gate — answering it is how
a Mac gets a bearer at all — matched on method **and** path exactly, so
`GET /api/auth/join` and `POST /api/auth/joinx` still meet it. Everything
else under `/api/auth` is owner-only and inside it.

A member is not a limited account: `PUT /api/manifest` is not role-gated, so
any valid bearer can rewrite the manifest wholesale. What a member cannot do
is administer the domain — bind, wipe, invite, list people and revoke are
owner-only. Identity buys attribution and per-person revocation, not
read-only access and not per-folder scope.

An invite code is 100 bits of Crockford base32, so guessing is off the table
rather than throttled: no attempt cap, no lockout, no counter to store. The
app mints the code and sends only `sha256(code)`, so the plaintext reaches
the worker at one place only — the redeem — which is exactly what makes the
stored hash useless to whoever reads the database.

## Deploying

The app writes the whole procedure into a prompt for an agent
(`buildSetupPrompt` in `src/cloudPrompts.ts`; docs/cloud.md §7.4 walks its
ten steps). By hand, the same steps:

Names derive from the domain — `notes.example.com` → worker, bucket and
database `doklin-notes-example-com`; a free `workers.dev` address with the
chosen name `sherin-notes` → `doklin-sherin-notes` — so two setups can never
collide. The secret is `OWNER_TOKEN`, the R2 binding is `DATA`, the D1
binding is `DB`.

```sh
mkdir doklin-cloud && cd doklin-cloud
curl -fsSL https://github.com/boat-builder/doklin/releases/latest/download/doklin-cloud-worker.js \
     -o doklin-cloud-worker.js        # or: node scripts/bundle-worker.mjs in this repo
npx -y wrangler@4 whoami              # `wrangler login` first if it asks
npx -y wrangler@4 r2 bucket create doklin-notes-example-com   # before deploy — it must exist
npx -y wrangler@4 d1 create doklin-notes-example-com          # prints the database_id
# wrangler.toml: copy wrangler.toml.example, fill in the account id, database id, domain, names
npx -y wrangler@4 secret put OWNER_TOKEN                     # paste the token the app shows
npx -y wrangler@4 deploy
curl -fsS -H "Authorization: Bearer $TOKEN" https://notes.example.com/api/meta
# → {"version":5,"features":["sync","wipe","publish","boards","versions","members"],"workspace":null,"d1":2}
```

`"d1"` is the database's schema version, or `null` on a deployment with no
`DB` binding — the sync API works either way (see **The database** above).
The worker owns its schema: it creates and migrates the tables itself on the
`/api/meta` probe, so there is no migrations directory to apply.

A custom domain needs its zone active on the same Cloudflare account, and
the first TLS certificate can take a minute after deploy.

**Update:** fetch the new bundle, `wrangler deploy` over the same name; the
secret and the bucket stay. That sequence is a script — nothing in it needs
a decision — so it ships as one, attached to every release:

```sh
curl -fsSL https://github.com/boat-builder/doklin/releases/latest/download/doklin-cloud-update.sh \
     -o doklin-cloud-update.sh        # or: scripts/doklin-cloud-update.sh in this repo
sh doklin-cloud-update.sh https://notes.example.com
```

**Teardown:** the app's wipe empties the bucket (R2 refuses to delete a
non-empty one) and the database's tables, then `wrangler delete --name …`,
`wrangler d1 delete …` and `wrangler r2 bucket delete …`.

**The prompts** are these steps written for an agent, with the checks a
person would skip: setup verifies the names are free before it creates
anything (a same-name deploy silently replaces a worker), pauses for an
account that has never enabled R2 or whose zone isn't on Cloudflare yet,
carries the token to `secret put` — it is the one secret the setup prompt
holds — and ends with one line back, `ENDPOINT: https://…`. Teardown
carries no secret, runs only after the app's wipe, refuses to force a
non-empty bucket, and ends with `TORN DOWN:`. Both close with the negative
scope: no other Cloudflare resource is touched, `wrangler.toml` is
committed nowhere.

**The update script** carries the same checks in shell. It reads the worker,
bucket and database names off the endpoint (certain for a workers.dev
address, a convention to verify for a custom domain), confirms them against
the account before writing anything — deploying under a name that doesn't
exist would create a *second* worker rather than update yours — resolves the
database's uuid out of `wrangler d1 list --json`, and verifies with an
unauthenticated `/api/meta`, where a `401` means the new worker is up. It
ends with `UPDATED:`. Nothing in it is secret: the `OWNER_TOKEN`, the bucket
binding and the routing all survive a same-name deploy. The database is the
one resource it may create, and only under the conventional name: a domain
set up before Doklin bound one has none, and the update is how it gets one.
The app's update card hands out those two commands, and its agent prompt
asks for nothing more than running them.

## Developing

```sh
pnpm typecheck:worker      # tsc against the Workers runtime types (no DOM)
pnpm test:worker           # node cloud-worker/test/run.mjs — an in-memory R2 and a D1 over
                           # node:sqlite, every route (identity end to end: the suite's own
                           # member token comes from a real invite and redeem), and the
                           # renderer over test/seed.mjs (a workspace with a bit of everything)
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
