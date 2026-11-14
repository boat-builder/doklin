# Doklin cloud worker — wire contract

Per domain: a Worker, an R2 bucket (`DATA`), a D1 database (`DB`), the
secret `OWNER_TOKEN`. Rules and engine: [docs/cloud.md](../docs/cloud.md);
pages: [docs/cloud-publishing.md](../docs/cloud-publishing.md); people,
agents, document API: [docs/cloud-people-agents.md](../docs/cloud-people-agents.md).

## Headers and auth

- `/api/*`: `Authorization: Bearer <token>`, JSON. No CORS, cookies, sessions. Bad bearer → `401`.
- Engine sends `x-doklin-device: <deviceId>` (presence, `createdBy`; must match `ID_RE`) and `x-doklin-client: <app version>` (logs only). CLI sends `x-doklin-client: cli/<version>`.
- Bearer kinds (`src/auth.ts`): `OWNER_TOKEN` → `owner`; `dka_…` → `agent_tokens` → `agent`; else `tokens` → `member`.
- Agent bearer off `/api/agent` → `403`; non-agent bearer on `/api/agent/*` → `403`. Owner-only route, member bearer → `403 {"error":"owner only"}`.
- No bearer, matched on method and path exactly: `POST /api/auth/join`, `POST /api/agent/login`.
- No `DB` / D1 down: `/api/auth/*`, search, board routes → `503`; member/agent bearers → `401`; sync unaffected; `/api/meta` `"d1": null`.
- Unbound: `/api/poll`, `/api/manifest`, `GET /api/workspace` → `404 {"error":"not bound"}`.

## Engine routes (`src/api.ts`, `src/versions.ts`)

```
GET  /api/meta  {version, features, workspace: {id,name,createdAt,createdBy}|null, d1: schema|null,
     you: {role, memberId, email, name}, people: [{id, name}]}  people = members then agents.
     Runs the D1 migration (once per isolate).
POST /api/workspace  owner; {name, deviceName?, ownerEmail?, ownerName?} → 201 {id, name, createdAt,
     createdBy, manifestEtag, owner?}; 409 {workspace} when bound
GET  /api/workspace  {id, name, createdAt, createdBy, files, bytes}
GET  /api/poll  {manifestEtag, presence: {<deviceId>: {memberId, name, path?, ts}},
     leases: [{path, deviceId, memberId, name, until}]|null}; writes nothing
POST /api/poll  same answer; body {name, path?, take?} | {leave: true} records the beat (needs
     x-doklin-device). D1 failure → presence {}, leases null, etag still answered
GET  /api/manifest[?since=e]  body + x-manifest-etag; 304 unchanged
PUT  /api/manifest  x-base-etag (428 without) → {etag, seq}; 412 {etag} lost race; 400 invalid;
     426 other manifest version; 413 > 4 MB
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

## Auth routes (`src/api.ts`, `src/agentApi.ts`)

Owner-only except join. Deletes → `204`; unknown id `404`; malformed id `400`.

```
POST   /api/auth/join  no bearer; {code, deviceId?, deviceName?} → 201 {token, tokenId, member};
       400 not a code; 401 unknown or expired (identical)
POST   /api/auth/invites  {email, name?, codeHash, expiresAt ≤ 30 d} → 201 {invite}; creates the
       member if new, replaces their pending invite
GET    /api/auth/invites  pending, unexpired
DELETE /api/auth/invites/<id>
GET    /api/auth/members  everyone, with device count and lastSeenAt
POST   /api/auth/members  {email, name?} — adopt/rename the owner's identity
DELETE /api/auth/members/<id>  person + invite + tokens + presence + leases
GET    /api/auth/tokens  [{id, memberId, email, deviceName, createdAt}] — never a hash
DELETE /api/auth/tokens/<id>
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
/og.png · /<slug>/og.png · /robots.txt · /favicon.ico · /apple-touch-icon.png
/__web/<tag>/mermaid.js  immutable, content-tagged
/__web/fonts/<file>      bundled Newsreader
anything else            404 page
```

## Bucket (`src/layout.ts`)

```
workspace.json   {id, name, createdAt, createdBy: {deviceId, deviceName}}; create-only; bound iff present
manifest.json    manifest v3; CAS on etag
blobs/<fileId>/<hash>   immutable; hash = sha256 hex prefix, 16–64 chars
versions/index.json     {version, horizonDays, snapshots: [{id, ts, device, reason, files, bytes,
                        digest, pinned?, label?, restoredFrom?}]}; CAS on etag
versions/snapshots/<id>.json.gz  id = <ts13>-<deviceId>; immutable
versions/blobs/<hash>   gzip'd, FULL sha256; immutable
```

Bind puts the empty manifest, then `workspace.json`, both
`onlyIf: {etagDoesNotMatch: "*"}`: a bind dying midway leaves a free domain.
Caps: file 25 MB; manifest 4 MB, 5000 files, 10,000 tombstones, 5000 public
entries; path 1024 chars, 12 segments; name 80; title 300; desc 600. Ids
`^[a-z0-9][a-z0-9_-]{2,63}$`. Old `presence.json` / `history/` are dead.

## Manifest v3 (`src/manifest.ts` ⇄ `src-tauri/src/cloud/manifest.rs`)

```json
{
  "version": 3, "name": "Notes", "seq": 812,
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
- PUT checks ids, hashes, relative paths (no traversal), one path per file
  case-insensitively, rev/size ranges, slug grammar and reserved words,
  reference shape, ≤ 1 `root`. Never existence. Merge semantics are the engine's.
- Other `version` → `426`, sentence names which side is behind.

## D1 (`src/schema.ts`, schema 7)

```sql
meta         (key PK, schema_version)          survives wipe
members      (id m-…, email UNIQUE normalized, name, role, created_at, last_seen_at, disabled)
tokens       (hash PK, id t-…, member_id → members CASCADE, device_id, device_name, created_at)
invites      (hash PK, id i-…, member_id → members CASCADE, created_at, expires_at)
presence     (device_id PK, member_id?, device_name, path?, ts)
leases       (path PK lowercased, device_id, member_id?, device_name, until)
agents       (id a-…, name, scopes, created_at, last_used_at, disabled)
agent_codes  (hash PK, id c-…, agent_id → agents CASCADE, created_at, expires_at)
agent_tokens (hash PK, id t-…, agent_id → agents CASCADE, host, created_at)
search_text  (fid PK, folded)        md file id, else html; NULL past 1 MB
search_state (key 'mirror', etag, held)   held = {"<fid>": "<text hash>.<sidecar hash>"}
board_cards  (fid PK, hash, head)    a card's frontmatter block as last read
```

`hash` columns are `sha256(token or code)`. Migrations: ordered `STEPS` run
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
