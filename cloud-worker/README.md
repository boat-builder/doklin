# Doklin cloud worker — wire contract

Per domain: a Worker, an R2 bucket (`DATA`), a D1 database (`DB`), the
secret `OWNER_TOKEN`. Rules and engine: [docs/cloud.md](../docs/cloud.md);
pages: [docs/cloud-publishing.md](../docs/cloud-publishing.md); people,
agents, document API: [docs/cloud-people-agents.md](../docs/cloud-people-agents.md).

## Headers and auth

- `/api/*`: `Authorization: Bearer <token>`, JSON. No CORS, cookies, sessions. Bad bearer → `401`.
- A bearer an owner took away (person removed, Mac signed out; its hash is in `removed_tokens`) → `401 {error, "removed": true}`. That body alone has the Mac delete its copy; every other unknown bearer (D1 down, wiped domain, rotated secret) is a bare `401`.
- Engine sends `x-doklin-device: <deviceId>` (presence, `createdBy`; must match `ID_RE`) and `x-doklin-client: <app version>` (logs only). CLI sends `x-doklin-client: cli/<version>`.
- Bearer kinds (`src/auth.ts`): `OWNER_TOKEN` → `owner`, the **creator** (no D1 read); `dka_…` → `agent_tokens` → `agent`; else `tokens` → the role on that person's `members` row (`owner` | `member`), read every request.
- Gating is `can(role, action)` over the one table in `src/roles.ts`: members hold `work` and `people.see`; owners also `people.invite`, `people.remove`, `people.roles`, `agents.manage`, `pages.manage`, `workspace.manage`.
- Agent bearer off `/api/agent` → `403`; non-agent bearer on `/api/agent/*` → `403`. A route the role may not use → `403 {"error":"only an owner can do that"}`.
- No bearer, matched on method and path exactly: `POST /api/auth/join`, `POST /api/agent/login`.
- No `DB` / D1 down: `/api/auth/*`, `/api/spaces/*`, search, board routes → `503`; member/agent bearers → `401`; the shared workspace's sync unaffected; `/api/meta` `"d1": null`.
- Unbound: `/api/poll`, `/api/manifest`, `GET /api/workspace` → `404 {"error":"not bound"}`.

## Engine routes (`src/api.ts`, `src/versions.ts`)

```
GET  /api/meta  {version, features, workspace: {id,name,createdAt,createdBy}|null, d1: schema|null,
     you: {role, creator, can: [actions], tokenId, memberId, email, name}, people: [{id, name}]}
     people = members then agents.
     Runs the D1 migration (once per isolate).
POST /api/workspace  owner; {name, deviceName?, ownerEmail?, ownerName?} → 201 {id, name, createdAt,
     createdBy, manifestEtag, owner?}; 409 {workspace} when bound
GET  /api/workspace  {id, name, createdAt, createdBy, files, bytes}
GET  /api/poll  {manifestEtag, presence: {<deviceId>: {memberId, name, path?, space?, ts}},
     leases: [{path, space?, deviceId, memberId, name, until}]|null, spaces: [space]|null};
     writes nothing. spaces = the caller's. path/space are absent, and a lease unlisted, for a
     space the caller is not in; no space = the shared workspace
POST /api/poll  same answer; body {name, path?, space?, take?} | {leave: true} records the beat
     (needs x-doklin-device); a space the caller is not in = no path. D1 failure → presence {},
     leases null, spaces null, etag still answered
GET  /api/manifest[?since=e]  body + x-manifest-etag; 304 unchanged
PUT  /api/manifest  x-base-etag (428 without) → {etag, seq} + x-manifest-etag; 412 {etag} lost
     race; 400 invalid; 426 other manifest version; 413 > 4 MB; 409 {error, taken: [slug]} when
     the public map names an address another space holds
GET    /api/blobs/<fid>         {blobs: [{hash, size, uploaded}]}
GET    /api/blobs/<fid>/<hash>  bytes, content-type as uploaded
PUT    /api/blobs/<fid>/<hash>  create-only → {stored, existed, hash, size}; 413 > 25 MB
DELETE /api/blobs/<fid>/<hash>  {deleted: true}
GET  /api/versions/index  index + x-versions-etag; 404 none
PUT  /api/versions/index  x-base-etag (428), "*" creates; 412 {etag}; 400; 413 > 1 MB
GET|PUT|DELETE /api/versions/snapshots/<id>  PUT create-only ({existed: true} on re-PUT); 413 > 4 MB
GET  /api/versions/blobs[?cursor=c]  {blobs: [{hash, size, uploaded}], cursor?} — one page
GET|PUT|DELETE /api/versions/blobs/<hash>  PUT create-only; 413 > 25 MB
POST /api/admin/wipe  owner; {"confirm":"wipe"}; batched, repeat until remaining:false; the last
     round empties every D1 table but meta. Frees the domain.
```

## Spaces (`src/spaces.ts`, `src/api.ts`)

A space is a restricted folder (`s-` + 8 hex) or one person's Private
(`p-` + their member id's hex). Any person may call these. `space` =
`{id, kind: restricted|private, name, by, createdAt, etag, members: [memberId]}`;
`etag` is its manifest's. **Everything under `/api/spaces/<id>` is `404
{"error":"not found"}` to anyone not in it, owners included** — the same
body an unknown id gets. Malformed id `400`.

```
GET    /api/spaces  {spaces} — the caller's
POST   /api/spaces  {name, members?: [memberId]} → 201 {space}; the caller is always in it;
       400 {unknown: [id]} for ids that are not people here; name = one folder name (no "/",
       no leading ".", ≤ 80)
PUT    /api/spaces/private  {space} — the caller's Private, created on first call
PATCH  /api/spaces/<id>  {name} → {space}
DELETE /api/spaces/<id>  → {deleted, purged, remaining}; batched like the wipe, repeat while remaining
PUT    /api/spaces/<id>/members/<memberId>  → {space}; 404 not a person here
DELETE /api/spaces/<id>/members/<memberId>  204 (self = leave); 404 not in it; 409 the last one
*      /api/spaces/<id>/manifest · /blobs/… · /versions/…  the engine routes above, on that space
```

`409`: PATCH, DELETE or members on a Private; any call by a creator with no
member row. A space's manifest may not name a `root` page (`400`).

## Every public address (`src/everyPage.ts`; `pages.manage`)

```
GET    /api/pages  {pages: [{slug, kind, title, by, at, shared}], truncated}
DELETE /api/pages/<slug>  204; 404 nothing is published there
```

Every page the domain serves, whichever space published it. Of a page in a
space it says only what the address tells anyone: `title` (the entry's, else
the file's or folder's name, else the space's), `by` as a name, `at`. Never
the space, the path or the file. `shared` = in the shared workspace.
`truncated`: more spaces hold addresses than one request reads (40). The
`DELETE` edits that space's public map through `commit`.

## Auth routes (`src/api.ts`, `src/agentApi.ts`)

Owners only, except join and `GET members`. Deletes → `204`; unknown id `404`; malformed id `400`.
`409`: changing or removing your own row or the creator's; deleting the token the call is made with.

```
POST   /api/auth/join  no bearer; {code, deviceId?, deviceName?} → 201 {token, tokenId, member};
       400 not a code; 401 unknown or expired (identical)
POST   /api/auth/invites  {email, name?, codeHash, expiresAt ≤ 30 d} → 201 {invite}; creates the
       member if new, re-enables a removed one, replaces their pending invite; 409 when somebody
       has signed in as that address (lastSeenAt set, or the creator's row) unless the caller is
       the creator or that person
GET    /api/auth/invites  pending, unexpired
DELETE /api/auth/invites/<id>
GET    /api/auth/members  any person; everyone not removed, with role, creator, device count and
       lastSeenAt (set at first redeem, then by the beat)
POST   /api/auth/members  creator only; {email, name?} — adopt/rename the creator's identity
PATCH  /api/auth/members/<id>  {role: owner|member} → {member}; owner → member withdraws every
       pending invite
DELETE /api/auth/members/<id>  the row stays with disabled = 1, role member; their invite, tokens,
       presence, leases and restricted-folder memberships go (their Private stays); token hashes
       go to removed_tokens; removing an owner withdraws every pending invite
GET    /api/auth/tokens  [{id, memberId, email, deviceName, createdAt}] — never a hash
DELETE /api/auth/tokens/<id>  its hash goes to removed_tokens
POST   /api/auth/agents  {name, scopes, codeHash, expiresAt ≤ 24 h} → 201 {agent}
GET    /api/auth/agents  {agents: [{id, name, scopes, createdAt, lastUsedAt,
       machines: [{id, host, createdAt}], code: {id, createdAt, expiresAt}|null}]}
POST   /api/auth/agents/<id>  {name?, scopes?} → {updated: true}
POST   /api/auth/agents/<id>/code  {codeHash, expiresAt} → 201 {code}; replaces a pending one
DELETE /api/auth/agents/<id>  agent + codes + tokens
DELETE /api/auth/agents/<id>/tokens/<tid>
```

`scopes`: subset of `read comment edit publish` holding `read`.

## Document API (`src/agentApi.ts`, `src/agentBoards.ts`; agent bearer only)

Under `/api/agent/`. Missing scope → `403 {error, need, scopes}`. JSON except
document bytes; refusals `{error, code?, …}`. `dry=1` / `dryRun: true`
validates without writing (`written: false`). Commit lost 5 times → `503`.

```
POST   login  no bearer; {code, host?} → 201 {token, agent: {id, name}, scopes, workspace: {id,
       name}|null, version, features}; 400 not a code; 401 unknown/used/expired (identical); 503
DELETE login  revoke this token (204)
GET    me     {agent, scopes, workspace, version, features}
read:
GET tree?dir=&deep=1  {dir, folders, boards: [{path, cards}], documents: [{path, md?, html?,
    htmlBehind?, public?}], files: [{path, rev, size, changed, by, public?}]}; a version is
    {file, rev, size, changed, by}; deep skips board insides; 404 empty; 400 a board
GET doc?path=&v=md|html[&clean=1][&info=1]  bytes + x-doklin-kind (document|file), -path, -file,
    -rev, -version, -html-behind: 1, -board (card page, sent without its properties block);
    values percent-encoded. clean=1 strips markers; info=1 → JSON row + {kind, comments}, byName
GET comments?path=  {path, threads: [{id, version, on, line?|tag?, orphaned?, comments: [{author, at, body}]}]}
GET search?q=&dir=&limit=  {query, dir, results: [{path, version, matches: [{line?, text}],
    moreLines?, inComments?}], total, truncated?, notSearched?} | 202 {indexing, pending}; limit ≤ 30
GET pages  {pages: [{slug, url, kind: document|file|folder, path, title?, desc?, home?, by?, byName?, at?, missing?}]}
GET board?path=  {board, name, cards, by, fields: [{id, name, type, options?: [{name, color?}]}], conflicts?}
GET cards?path=&by=&where=  {board, name, cards, shown?, by, fields, columns: [{name, empty?, color?,
    cards: [{title, props, rev, changed, by, byName?, conflict?}]}], conflicts?} | 202 {indexing,
    pending}; where: f=v · f!=v · f= · f!= (ANDed)
GET card?path=&card=  {board, title, path, rev, changed, by, byName?, size, props, other?, comments, public?, conflict?, page}
edit:
PUT    doc?path=&v=[&force=1][&dry=1]  bytes; if-rev: <n> | * (create only) → {kind, path, version?,
       file, rev, size, created, unchanged?, htmlBehind?, orphaned?}; 409 {rev}; 413 > 25 MB
DELETE doc?path=&v=[&dry=1]  document, or one version → {kind, path, versions, stillPublic, threadsRemoved?}
POST   move {from, to, dryRun?}  document/file/folder/board; to ending in / = into → {kind, from, to, files, name?}
POST   board {path, name?} → 201 {board, name, fields, created}
POST   card {path, title, set?, first?, page?} → 201 {board, title, path, rev, props, created}
PATCH  card {path, card, set?, title?, <place>} → {board, title, path, rev, props, renamed?, placed?}
DELETE card?path=&card= → {board, title, path, stillPublic}
POST   field {path, name, type, options?} → 201 {board, field, created}
PATCH  field {path, field, name} → {board, field, renamed}
DELETE field?path=&field= → {board, field}
POST   option {path, field, name, color?, <place>} → 201 {board, field, option, options, created}
PATCH  option {path, field, option, name?, color?, <place>} → {…, renamed?, cards?, pending?};
       202 while a rename has cards left — repeat the request
DELETE option?path=&field=&option= → {board, field, option, options}
       set: status=Done · tags=a,b · tags+=a · tags-=a · due= (clears)
       <place>: first: true | last: true | before: "<name>" | after: "<name>"
comment:
POST   comments {path, on, body, v?} → 201 {path, thread, version, on, line?|tag?}
       {path, thread, body} → 200 {path, thread, version, comments}
DELETE comments?path=&thread= → {path, thread, version, removed}
publish:
PUT    pages {path, slug?, title?, desc?}  document, picture/PDF, folder/ or "/" → 201 {slug, url,
       kind, path, documents, created}
DELETE pages?path= | ?slug= → {stopped: [...]}
```

| `code` | Status | Means |
| --- | --- | --- |
| `needs_rev` | 409 | overwrite without `if-rev`/`force`; carries `rev` |
| `html_only` | 400 | write with no `v` on an html-only document |
| `no_html` · `no_md` | 404 | version missing (writing it creates it) |
| `last_version` | 409 | removing the only version |
| `anchor` | 404 · 409 | words absent / ambiguous or unplaceable; `occurrences` or `candidates` |
| `slug_taken` | 409 | slug in use |
| `board` | 400 | path is a board or inside one |
| `no_card` · `no_field` · `no_option` | 404 | not on the board; `fields`/`options` list what is |
| `taken` | 409 | card title / field / option name in use |

Also `400`: unknown marker id in an md write (`unknownMarkers`); hidden,
ignored, temp-suffix or sidecar paths. `409`: case-insensitive collision; a
`store.jsonl` that isn't Doklin's.

## Public routes (`src/public.ts`; no auth; GET/HEAD, else 405)

```
/                       root page if mapped and its file exists, else landing page
/<slug>                 note: <stem>.html framed when present, else markdown; ?v=md markdown
/<slug>/raw             html rendition verbatim, CSP sandbox
/<dirSlug>              folder table of contents
/<dirSlug>/<rel/path>   nested note (md extension dropped, case-insensitive), …/raw, or image/PDF/html
                        a slug the shared map lacks is looked up in `addresses` and served from
                        that space (cache key carries its etag and id); held by nobody → 404, uncached
/og.png · /<slug>/og.png · /robots.txt · /favicon.ico · /apple-touch-icon.png
/__web/<tag>/mermaid.js  immutable, content-tagged
/__web/fonts/<file>      bundled Newsreader
anything else            404 page
```

## Bucket (`src/layout.ts`)

```
workspace.json   {id, name, createdAt, createdBy: {deviceId, deviceName}}; create-only; bound iff present
manifest.json    manifest v4; CAS on etag
blobs/<fileId>/<hash>   immutable; hash = sha256 hex prefix, 16–64 chars
versions/index.json     {version, horizonDays, snapshots: [{id, ts, device, reason, files, bytes,
                        digest, pinned?, label?, restoredFrom?}]}; CAS on etag
versions/snapshots/<id>.json.gz  id = <ts13>-<deviceId>; immutable
versions/blobs/<hash>   gzip'd, FULL sha256; immutable
spaces/<spaceId>/…      one space: manifest.json, blobs/, versions/ again, under its prefix
```

Bind puts the empty manifest, then `workspace.json`, both
`onlyIf: {etagDoesNotMatch: "*"}`: a bind dying midway leaves a free domain.
Caps: file 25 MB; manifest 4 MB, 5000 files, 10,000 tombstones, 5000 public
entries; path 1024 chars, 12 segments; name 80; title 300; desc 600. Ids
`^[a-z0-9][a-z0-9_-]{2,63}$`. Old `presence.json` / `history/` are dead.

## Manifest v4 (`src/manifest.ts` ⇄ `src-tauri/src/cloud/manifest.rs`)

```json
{
  "version": 4, "name": "Notes", "seq": 812,
  "files": { "f-3kq8x1": { "path": "Projects/plan.md", "rev": 7, "hash": "9c1e…", "size": 4310,
                            "mtime": 1757000000000, "by": "m-1a2b3c4d" } },
  "tombstones": { "f-old": { "path": "Scratch.md", "rev": 3, "ts": 1756800000000, "by": "m-1a2b3c4d" } },
  "public": {
    "k7m2p9qx": { "kind": "file", "file": "f-3kq8x1", "path": "Projects/plan.md", "by": "…", "at": 1757000000000 },
    "roadmap":  { "kind": "dir", "path": "Projects/Roadmap", "title": "Roadmap", "desc": "…", "by": "…", "at": 1757000000000 },
    "home":     { "kind": "file", "file": "f-77a1b2", "path": "Home.md", "root": true, "by": "…", "at": 1757000000000 }
  }
}
```

- `by`: `m-` or `a-` + 8 hex; checked only as a bounded string (v2 device names survive).
- A tombstone may carry `to`: the file was moved to another section, not
  deleted — a space id, or `""` for the shared workspace.
- The shared manifest holds no file under `Private/` or `Restricted/`, in any
  case (`RESERVED_FOLDERS`, `layout.ts` ⇄ `RESERVED_DIRS`, `space.rs`:
  **change both**); a space's manifest may. Tombstones are not checked for it.
- PUT checks ids, hashes, relative paths (no traversal), one path per file
  case-insensitively, rev/size ranges, slug grammar and reserved words,
  reference shape, ≤ 1 `root` (none in a space). Never existence. Merge semantics are the engine's.
- Other `version` → `426`, sentence names which side is behind.

## D1 (`src/schema.ts`, schema 9)

```sql
meta         (key PK, schema_version)          survives wipe
members      (id m-…, email UNIQUE normalized, name, role, created_at, last_seen_at, disabled)
tokens       (hash PK, id t-…, member_id → members CASCADE, device_id, device_name, created_at)
invites      (hash PK, id i-…, member_id → members CASCADE, created_at, expires_at)
presence     (device_id PK, member_id?, device_name, space_id '' = shared, path?, ts)
leases       ((space_id, path) PK, path lowercased, device_id, member_id?, device_name, until)
agents       (id a-…, name, scopes, created_at, last_used_at, disabled)
agent_codes  (hash PK, id c-…, agent_id → agents CASCADE, created_at, expires_at)
agent_tokens (hash PK, id t-…, agent_id → agents CASCADE, host, created_at)
search_text  (fid PK, folded)        md file id, else html; NULL past 1 MB
search_state (key 'mirror', etag, held)   held = {"<fid>": "<text hash>.<sidecar hash>"}
board_cards  (fid PK, hash, head)    a card's frontmatter block as last read
creator        (id = 1 PK, member_id)   whose row holds OWNER_TOKEN; one row or none
removed_tokens (hash PK, removed_at)    credentials an owner took away; emptied by a wipe
spaces        (id s-…|p-…, kind, name, created_by, created_at, etag)   etag = its manifest's
space_members ((member_id, space_id) PK, added_by, added_at)
addresses     (slug PK, space_id)       which space a public address is; '' = shared
```

`members.disabled = 1` is a removed person: no tokens, not listed, still in
`/api/meta` `people`. `hash` columns are `sha256(token or code)`. Migrations: ordered `STEPS` run
on `/api/meta`, idempotent `CREATE … IF NOT EXISTS`, then `UPDATE meta SET
schema_version = <to> WHERE key = 'schema' AND schema_version = <to-1>` so
concurrent isolates converge. Updates ship no migrations directory: add a
step, never a wrangler migration. Single-primary: no read replicas (a lease
two Macs both believe they hold is worse than none).

## Deploying

```sh
curl -fsSL https://github.com/boat-builder/doklin/releases/latest/download/doklin-cloud-worker.js -o doklin-cloud-worker.js
npx -y wrangler@4 whoami
npx -y wrangler@4 r2 bucket create doklin-notes-example-com
npx -y wrangler@4 d1 create doklin-notes-example-com      # prints database_id
# wrangler.toml from cloud-worker/wrangler.toml.example: account id, database id, names, domain
npx -y wrangler@4 secret put OWNER_TOKEN
npx -y wrangler@4 deploy
curl -fsS -H "Authorization: Bearer $TOKEN" https://notes.example.com/api/meta   # d1 must be a number
sh doklin-cloud-update.sh https://notes.example.com       # update (release asset)
```

Names: `notes.example.com` → `doklin-notes-example-com`; workers.dev name
`sherin-notes` → `doklin-sherin-notes` (`resourceName`, `src/cloudPrompts.ts`).
Teardown: app wipe, then `wrangler delete`, `wrangler d1 delete`, `wrangler r2 bucket delete`.

## Developing

```sh
pnpm typecheck:worker
pnpm test:worker       # node cloud-worker/test/run.mjs [--bundle <file>]; fake R2, D1 on node:sqlite
pnpm bundle:worker     # node scripts/bundle-worker.mjs [--no-mermaid] → cloud-worker/dist/
node verify-harness/serve-worker.mjs   # bundle over test/seed.mjs on :8787
node verify-harness/drive-cli.mjs      # built cli/ against the worker
```
