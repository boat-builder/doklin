# Doklin cloud worker — wire contract

Per domain: a Worker, an R2 bucket (`DATA`), a D1 database (`DB`), two
rate-limit bindings (`DEVICE_LIMIT`, `AGENT_LIMIT`), the secret `OWNER_TOKEN`
(the domain's key). Rules and engine: [docs/cloud.md](../docs/cloud.md);
pages: [docs/cloud-publishing.md](../docs/cloud-publishing.md); people,
agents, document API: [docs/cloud-people-agents.md](../docs/cloud-people-agents.md).

## Headers and auth

- `/api/*`: `Authorization: Bearer <token>`, JSON. No CORS. Bad bearer → `401`. The one cookie is a browser's sign-in (*Browser version*).
- A bearer somebody took away (person removed, device signed out; its hash is in `removed_tokens`) → `401 {error, "removed": true}`. That body alone has the device delete its copy; every other unknown bearer (a wiped domain's, or one nobody ever held) is a bare `401`.
- Engine sends `x-doklin-device: <deviceId>` (presence, `createdBy`; must match `ID_RE`) and `x-doklin-client: <app version>`. CLI sends `x-doklin-client: cli/<version>`; the iPhone's engine sends `ios/<version>+<build>`, `+dev` from a build run from Xcode; the browser version sends `web/<release>`, the `package.json` version it was built in.
- Minimums, first on every `/api` request, before the routes that take no bearer and before the key (`src/clients.ts`): a client older than `MINIMUM_APP` (a Mac, `cli/`) or `MINIMUM_IOS` (`ios/`, compared by version, then build when the minimum names one; no build is older than any) → `410 {error}`, a sentence saying how to update. A `web/` release other than the worker's own (its `package.json` version) is refused the same way, whatever the minimums: the page is the worker's, so it is a tab left open across an update, and a reload fixes it. No header, a header that reads as none of these, and `+dev` are answered. `410` is this refusal's only use; `426` is the manifest's.
- `x-doklin-used: <integer>` — the caller's requests today (UTC day) on this domain; any authenticated route, at most every 15 min. Upserted after the answer (`ctx.waitUntil`) into `usage` under the caller's `tokenId`, replacing its last report; a report within a minute of the last is not written; a malformed header is ignored. `fleetToday` = today's sum.
- Loop catchers, right after `authenticate`: `DEVICE_LIMIT` (a person's device) and `AGENT_LIMIT` (an agent's machine), keyed by `tokenId`, numbers in `wrangler.toml`'s `[[ratelimits]]`. Over → `429 {error: "This device is sending too many requests — it will slow down by itself."}` + `Retry-After: 60`, before anything else is done (its `x-doklin-used` included). Approximate, a loop catcher only: the refused request has been counted against the account already. A binding the env lacks is not checked.
- Bearer kinds (`src/auth.ts`): `OWNER_TOKEN` → **the key**, nobody's sign-in: `GET /api/meta` and `POST /api/auth/recover` only, `403` elsewhere (`handleKey`, `api.ts`). `dka_…` → `agent_tokens` → `agent`; `dkw_…` → a browser's sign-in, `401` as a bearer (*Browser version*); else `tokens` → the person's role, read every request: `superadmin` when the `superadmin` row names them, else `members.role` (`owner` | `member`).
- Gating is `can(role, action)` over the one table in `src/roles.ts`: members hold `work`, `people.see`, `agents.own` and `devices.own`; owners also `people.invite`, `people.remove`, `people.roles`, `agents.manage`, `pages.manage`; the superadmin also `people.recover` and `workspace.manage`.
- Agent bearer off `/api/agent` → `403`; non-agent bearer on `/api/agent/*` → `403`. A browser's sign-in off `/api/web` and its few reads → `403`; anybody else's credential on `/api/web/*` → `403`. A route the role may not use → `403 {error}`, naming who may (`refusal`, `roles.ts`).
- No bearer, matched on method and path exactly: `POST /api/auth/join`, `POST /api/agent/login`, `POST /api/web/session`. A join (an invite's code, or a device code) or a trade of the key (`recover`) is how a device gets its bearer; a browser's session takes the same codes.
- No `DB` / D1 down: every bearer but the key → `503` (never `401`); `/api/meta` with the key still answers, `"d1": null`.
- Unbound: `/api/poll`, `/api/manifest`, `GET /api/workspace` → `404 {"error":"not bound"}`.

## Engine routes (`src/api.ts`, `src/versions.ts`)

```
GET  /api/meta  {version, workspace: {id,name,createdAt,createdBy}|null, d1: schema|null,
     you: {role, can: [actions], tokenId, memberId, email, name}, superadmin: {id, name}|null,
     people: [{id, name, person?}], limits}; people = members then agents, an agent with
     `person`, whose it is. With the key: {version,
     workspace, d1}. Runs the D1 migration (once per isolate).
POST /api/workspace  superadmin; {name, deviceName?} → 201 {id, name, createdAt, createdBy,
     manifestEtag}; 409 {workspace} when bound
GET  /api/workspace  {id, name, createdAt, createdBy, files, bytes}
GET  /api/poll  {manifestEtag, presence: {<deviceId>: {memberId, name, path?, space?, ts}},
     leases: [{path, space?, deviceId, memberId, name, until}]|null, spaces: [space]|null,
     limits}; writes nothing. spaces = the caller's. path/space are absent, and a lease
     unlisted, for a space the caller is not in; no space = the shared workspace
POST /api/poll  same answer; body {name, path?, space?, take?, ttl?} | {leave: true} records the
     beat (needs x-doklin-device); a space the caller is not in = no path. ttl (ms) = how long
     the beat holds, clamped to [90 s, 15 min], missing or not a number = 90 s; the presence row
     and the lease it claims hold until now + ttl. D1 failure → presence {}, leases null, spaces
     null, the Free limits with fleetToday null, etag still answered
PUT  /api/settings/plan  superadmin (`workspace.manage`); {plan: "free"|"paid"} → {limits};
     400 another plan; 503 D1 down
GET  /api/manifest[?since=e]  body + x-manifest-etag; 304 unchanged
PUT  /api/manifest  x-base-etag (428 without) → {etag, seq} + x-manifest-etag; 412 {etag} lost
     race; 400 invalid; 426 other manifest version; 413 > 4 MB; 409 {error, taken: [slug]} when
     the public map names an address another space holds
GET    /api/blobs/<fid>/<hash>  bytes, content-type as uploaded; private, immutable (Browser version)
PUT    /api/blobs/<fid>/<hash>  create-only → {stored, existed, hash, size}; 413 > 25 MB; the
                                same bytes again are stored again (the sweep's day starts over)
GET  /api/versions/index  index + x-versions-etag; 404 none
PUT  /api/versions/index  x-base-etag (428), "*" creates; 412 {etag}; 400; 413 > 1 MB
GET|PUT|DELETE /api/versions/snapshots/<id>  PUT create-only ({existed: true} on re-PUT); 413 > 4 MB
GET  /api/versions/blobs[?cursor=c]  {blobs: [{hash, size, uploaded}], cursor?} — one page
GET|PUT|DELETE /api/versions/blobs/<hash>  PUT create-only; 413 > 25 MB
POST /api/admin/wipe  superadmin; {"confirm":"wipe"}; batched, repeat until remaining:false; the
     last round empties every D1 table but meta, spent_keys, settings and usage (the account's,
     not the workspace's). Frees the domain.
```

## Limits (`src/limits.ts` ⇄ `Limits`, `engine/src/cloud/pace.rs`; the CLI reads `cliDaily`)

`limits.ts` is the one source of these numbers; clients hold none of their own.
`limits` is in `GET /api/meta` (with `you`), every poll answer, `GET
/api/agent/me`, `POST /api/agent/login`'s `201` and `PUT /api/settings/plan`'s
answer:

```
{plan: "free"|"paid", cap, bulkPerSecond, deviceBulk, deviceCeiling, fleetBulkWaits,
 fleetSlow, cliDaily, manyNew, fleetToday}
```

`null` = no such limit on this plan. `deviceBulk` and `deviceCeiling` count all
of a device's requests today. `fleetToday` = everyone's reported requests today
(`usage`), `null` when D1 could not say; public page views and other Workers on
the account are not in it. The plan is `settings.plan`, `free` until the
superadmin says otherwise; D1 down → the Free numbers and `fleetToday: null`.

## The daily sweep (`src/sweep.ts`; `scheduled` in `src/index.ts`)

A cron trigger (`[triggers] crons`, once a day) deletes every `blobs/<fid>/<hash>` — in the
shared workspace and under each `spaces/<id>/` — that its section's manifest doesn't name and
that was stored more than a day ago (`SWEEP_MIN_AGE_MS` ⇄ `UPLOADED_TTL_MS`,
`engine/src/cloud/unit.rs`, which must stay inside it). Listing first, manifest after. A manifest
that can't be read leaves its section alone; no manifest names nothing; a file outside `syncs`
is not named. At most `SWEEP_CALLS` (40) bucket calls a run (Free: 50 an invocation); each day
starts `SWEEP_STRIDE` (10) sections further round, since every shared document is a section and a
bucket soon holds more than a run goes through. `versions/` is not its: the engine collects the
version store.

The same run first ends what is over (`sweepShares`): a share deleted `DELETED_KEPT_MS` (30 days)
ago is erased — what it stored, its rows, its place in the manifest of the section it sat in —
and so is a shared document that still holds no file a day after it was made (`eraseUnfilled`).

## Spaces (`src/spaces.ts`, `src/mounts.ts`, `src/api.ts`)

A space is one person's My files (`p-` + their member id's hex, kind `private`) or a share:
a folder or one document (`s-` + 8 hex, minted by the device that shares it; kind `folder` |
`document`). **Sections are a tree**: a share sits in a My files or in a shared folder
(`parent`, never Library, never a shared document), and whoever can open the section it sits in
can open it; the people it is shared with are `space_members`. Any person may call these.

`space` = `{id, kind, name, by, createdAt, etag, parent, owner, members: [memberId], above:
[memberId], deletedAt?}` (`Space`, `wire.ts`). `etag` is its manifest's. `owner` is whose My
files it is in, in the end. `members` is who it is shared with; `above` is everyone else who
can open it, through the section it sits in. `parent` is `null` for a My files — and to
somebody who cannot open that section, who is told nothing of where it sits. `deletedAt` only
on a deleted share, told only to somebody who can restore it.

**Everything under `/api/spaces/<id>` is `404 {"error":"not found"}` to anyone who cannot open
it, owners included** — the same body an unknown id gets. Malformed id `400`.

```
GET    /api/spaces  {spaces} — the ones the caller can open, and the deleted shares they can restore
POST   /api/spaces  {id, kind: folder|document, name, parent, dir?, was?, members?: [memberId]} →
       201 {space}: a share in the section `parent`, in its folder `dir` ("" its top), which the
       worker writes into that section's manifest (`mounts`) with `was`, the item's path there
       before (a document's without its extension). The same `id` from its maker again answers
       the same share; one shared twice at once from two devices (same parent, was, dir, name,
       kind) is the first, with the people added. 409 {code: "id_taken"} somebody else's id;
       400 {unknown: [id]} for ids that are not people here; name = one file name (no "/" or
       ":", no leading ".", ≤ 200)
PUT    /api/spaces/private  {space} — the caller's My files, made on first asking
PATCH  /api/spaces/<id>  {name} → {space}, a shared folder (a shared document is renamed by renaming
       its file, and `name` follows its manifest); or {parent, dir?} → {space}: it sits there from
       now on, both manifests' `mounts` written here; 400 inside itself or into Library
DELETE /api/spaces/<id>  one that holds something is kept: {deleted, kept: true}, `deleted_at` on it
       and on everything inside it. One that holds nothing is erased, batched like the wipe:
       {deleted, kept: false, purged, remaining}, repeat while remaining
POST   /api/spaces/<id>/restore  → {space}, as it was; 409 while the folder it sat in is deleted too;
       404 once its thirty days are up
PUT    /api/spaces/<id>/members/<memberId>  → {space}; 404 not a person here
DELETE /api/spaces/<id>/members/<memberId>  204 (self = leave); 404 not on it; 409 somebody who
       opens it through the section it sits in
*      /api/spaces/<id>/manifest · /blobs/… · /versions/…  the engine routes above, on that space
```

Anyone who can open a share changes who it is shared with, and renames it. Moving it (`PATCH
{parent}`), `DELETE` and `restore` are for somebody who can open the section it sits in: `403`
with a sentence for anyone else. All of them are `409` on a My files. A deleted share answers `restore` alone. A space's manifest may not name a `root`
page (`400`); a shared document's holds that one document at its root, and a write from somebody
who cannot open its parent that would leave it without its document is `409`.

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

Owners only, except join, recover, `GET members`, the device routes and the agent routes. Deletes → `204`; unknown id `404`; malformed id `400`.
`409`: changing or removing your own row or the superadmin's; signing out the device the call is made with, or (for anybody but them) one of the superadmin's.

```
POST   /api/auth/join  no bearer; {code, deviceId?, deviceName?} → 201 {token, tokenId, member};
       400 not a code; 401 unknown or expired (identical)
POST   /api/auth/recover  the key; {email, name?, deviceId?, deviceName?} → 201 {token, tokenId,
       member}: a device sign-in as email's person (made if new, brought back if removed, an
       owner), who becomes the superadmin; 400 without a valid email; 401 {code: "key_spent"} the
       second time
POST   /api/auth/invites  {email, name?, codeHash, expiresAt ≤ 30 d} → 201 {invite}; creates the
       member if new, re-enables a removed one, replaces their pending invite; 409 when somebody
       has signed in as that address (lastSeenAt set, or the superadmin's row) unless the caller is
       the superadmin or that person
GET    /api/auth/invites  pending, unexpired
DELETE /api/auth/invites/<id>
GET    /api/auth/members  any person; everyone not removed, with role (`superadmin` for theirs), device
       count and lastSeenAt (set at the first redeem or trade, then by the beat)
PATCH  /api/auth/members/<id>  {role: owner|member} → {member}; owner → member withdraws every
       pending invite
DELETE /api/auth/members/<id>  the row stays with disabled = 1, role member; their invite, tokens,
       presence, leases, what was shared with them and agents go (their My files stays); token
       hashes go to removed_tokens; removing an owner withdraws every pending invite
POST   /api/auth/devices/code  anyone; {codeHash, expiresAt ≤ 24 h} → 201 {code: {id, createdAt, expiresAt}}:
       a code for a device of the caller's own, stored as their pending invite (replacing it) and
       redeemed by join
GET    /api/auth/devices  anyone; the caller's devices, an owner everyone's: {devices: [{id, memberId,
       email, deviceId, deviceName, createdAt}]} — never a hash
DELETE /api/auth/devices/<id>  its person, or an owner but not one of the superadmin's (409); its
       hash goes to removed_tokens. Somebody else's is `404` to a member
DELETE /api/auth/session  a device ending its own sign-in: its row, presence and lease go, nothing
       goes to removed_tokens. A browser's answer also ends it there (Browser version)
POST   /api/auth/agents  anyone; {name, scopes, codeHash, expiresAt ≤ 24 h} → 201 {agent}: the caller's
GET    /api/auth/agents  anyone; the caller's agents, an owner everyone's: {agents: [{id, name, scopes,
       createdAt, lastUsedAt, memberId, mine, machines: [{id, host, createdAt}],
       code: {id, createdAt, expiresAt}|null}]}; `code` only on the caller's own
POST   /api/auth/agents/<id>  {name?, scopes?} → {updated: true}; its person only
POST   /api/auth/agents/<id>/code  {codeHash, expiresAt} → 201 {code}; replaces a pending one; its
       person only
DELETE /api/auth/agents/<id>  agent + codes + tokens; its person, or an owner
DELETE /api/auth/agents/<id>/tokens/<tid>  its person, or an owner
```

`scopes`: subset of `read comment edit publish` holding `read`. An agent that
is not the caller's: `404` to a member; to an owner `403` on the two `POST`s.

## Document API (`src/agentApi.ts`; agent bearer only)

Under `/api/agent/`. Missing scope → `403 {error, need, scopes}`. JSON except
document bytes; refusals `{error, code?, …}`. `dry=1` / `dryRun: true`
validates without writing (`written: false`). Commit lost 5 times → `503`.

Every path is literal, as on the disk of the agent's person, and starts with
its section (`src/agentPlace.ts`): `Library/…`, `My files/…`, or
`Shared with me/<item>/…` for what others shared with them. Section names
match in any case. A path is answered in the deepest section that holds it,
so `My files/Work/Plan` reaches a shared document where it sits. Any other
path is in no section → `400 "Projects/plan is in no section. Say which:
Library/Projects/plan (everyone), "My files/Projects/plan" (only your
person) or "Shared with me/<name>/…" (something shared with them)."`, with
the path as sent; `Private/…` and `Restricted/…` are told what they are
called now. A route is answered with its section's manifest mounted where
the section is (`src/mount.ts`): the stored paths stay relative to the
section, and every answer carries the mounted path. A shared document whose
name is taken where it is shown wears another (`named {stored, shown}`).
Something the person cannot open → `404`. `""` is the workspace itself, for
`tree` and `search` only: its listing is `Library`, `My files` and `Shared
with me`, and no document. `tree` (`deep=1`), `search`, `links` and `pages`
cover every section, Library among them, opening at most 8 spaces a request
beside it; an answer that left sections out carries `next`, and the same
request with `after=<next>` goes on. Something shared is called what a Mac
calls it (`free_name`, `engine/src/cloud/space.rs`, **change both**), the
names given out in creation order.

```
POST   login  no bearer; {code, host?} → 201 {token, agent: {id, name}, scopes, workspace: {id,
       name}|null, version, limits}; 400 not a code; 401 unknown/used/expired (identical); 503
DELETE login  revoke this token (204)
GET    me     {agent, person: {id, name}|null, scopes, sections: [folder] (Library first),
       workspace, version, limits}
read:
GET tree?dir=&deep=1[&where=][&after=]  {dir, folders, documents: [{path, md?, html?, htmlBehind?,
    tags?: [{name, value, known}]} | {path, shared: true}], tagsBehind?, next?}; a version is
    {file, rev, size, changed, by}; a listing that is not deep names a shared document, and no more;
    404 empty. where=name:value | name (repeatable, ≤ 8, listed names) → only those notes, no
    folders, `where` said back; 202 {indexing, pending} while the index catches up
GET doc?path=&v=md|html[&clean=1][&info=1]  bytes + x-doklin-kind: document, -path, -file, -rev,
    -version, -html-behind: 1; values percent-encoded. clean=1 strips markers; info=1 → JSON
    row + {kind, comments, tags?, public?, linkTo: {workspace, space, file}}, byName. Markdown with link
    records: each such link where its document is now, as this agent's person can open it
GET comments?path=  {path, threads: [{id, version, on, line?|tag?, orphaned?, comments: [{author, at, body}]}]}
GET find?workspace=&space=&file=  {path}: where a link to a page leads (space "" = Library), the
    document by its stem; a file that moved to another section is followed there. 404 for every
    page this agent cannot open, alike
GET search?q=&dir=&limit=[&where=][&after=]  {query, dir, where?, results: [{path, version, matches: [{line?, text}],
    moreLines?, inName?, inComments?}], total, truncated?, notSearched?, next?} | 202
    {indexing, pending}; limit ≤ 30; named documents first. where as tree's; q may then be empty:
    every such note, no lines, no limit
GET links?path=[&from=1][&to=1][&after=]  {path, from?: [{words, path} | {words, closed: true}], to?: [{path}],
    next?} | 202 {indexing, pending}; neither flag = both. from: the markdown's links to
    documents; to: the documents this agent's person can open that link here (D1 `links`)
GET pages[?after=]  {pages: [{slug, url, kind: document|folder, path, title?, desc?, home?, by?, byName?,
    at, missing?}], next?}
GET tags  {tags: [{name, values, desc?}]}: Library's manifest's list
edit:
PUT    doc?path=&v=[&force=1][&dry=1]  bytes; if-rev: <n> | * (create only) → {kind, path, version,
       file, rev, size, created, unchanged?, htmlBehind?}; 409 {rev}; 413 > 25 MB. Markdown: the
       sidecar's link records in the same commit (cloud-people-agents.md, *Links between documents*)
DELETE doc?path=&v=[&dry=1]  document, or one version → {kind, path, versions, stillPublic, threadsRemoved?};
       409 {code: "shared"} a shared document whole: it is its owner's to delete
POST   tag {path, set: {<tag>: value | null}, dryRun?} → {path, version, rev, tags, unchanged?}; a
       note's markdown
POST   tags {name, values, dryRun?} → {tag, added, created?, unchanged?}: a new tag at the end of the
       list, or values at the end of a tag's; one it has, in any case, is left. Never a rename or
       a removal
POST   move {from, to, dryRun?}  document/folder; to ending in /, or a section's own folder,
       = into → {kind, from, to, files?, unpublished?}. `Library`, `My files` and `Shared with
       me` never move → 400. Something shared is renamed, and moved inside the section it sits
       in (its `mounts` entry; no `files`); to another section → 409 {code: "shared"}, and so
       is a folder that holds shares. Between two sections:
       ≤ 16 files,
       written where they go (the ids they had) before they are removed with a tombstone `to`;
       pages re-claimed after, and `unpublished` lists addresses that could not be
comment:
POST   comments {path, on, body, v?} → 201 {path, thread, version, on, line?|tag?}
       {path, thread, body} → 200 {path, thread, version, comments}
DELETE comments?path=&thread= → {path, thread, version, removed}
publish:
PUT    pages {path, slug?, title?, desc?}  document or folder/; a section's own folder is the
       whole section (`Library/` → path "Library", stored as "") → 201 {slug, url, kind,
       path, documents, created}
DELETE pages?path= | ?slug= → {stopped: [...]}; a path in no section that is an address is
       stopped as one
```

| `code` | Status | Means |
| --- | --- | --- |
| `needs_rev` | 409 | overwrite without `if-rev`/`force`; carries `rev` |
| `html_only` | 400 | write with no `v` on an html-only document |
| `no_html` · `no_md` | 404 | version missing (writing it creates it) |
| `last_version` | 409 | removing the only version |
| `anchor` | 404 · 409 | words absent / ambiguous or unplaceable; `occurrences` or `candidates` |
| `slug_taken` | 409 | slug in use |
| `comments` | 400 | a write would drop, change or add a comment marker, or lose an html thread's element; `threads`, `added` |
| `tag_value` | 400 | a write or `tag` gives a listed tag a value the list lacks, or more than one; `tag`, `values` |
| `no_tag` | 400 | `tag` or `where` names a tag the list lacks; `tags` |
| `tag_list` | 400 | `tags` would break the list's rules: a name, a value, the most it can hold |

There are no plain files: only documents sync (`syncs`, `src/layout.ts`). A
path is a document's stem (`plan`) or a version's full name (`plan.md`,
`plan.html`); a name with another extension that names no document and no
folder → `400 {error: "Doklin syncs markdown and html documents only — …"}`,
on every route (a version flag makes it a stem: `v1.2` + `v=md` is `v1.2.md`).
Also `400`: hidden, ignored, temp-suffix or sidecar paths. `409`:
case-insensitive collision.

## Browser version (`src/web.ts`; a browser's sign-in only)

A browser is a device: a row of `tokens`, listed and signed out with the
rest. Its token starts `dkw_` (`BROWSER_TOKEN_PREFIX`, `members.ts`; inside
what is hashed) and is never in a body: it is the cookie

```
__Host-doklin=<token>; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=34560000
```

set by `POST /api/web/session` and again by every `GET /api/meta` it
authenticates (400 days from the app's last start).

- The cookie counts only with no `Authorization` header and only on a request
  the app's own script made (`ownScript`, `auth.ts`): `Sec-Fetch-Site:
  same-origin`, `Sec-Fetch-Dest: empty`, `Sec-Fetch-Mode: cors | same-origin`.
  Anything else carrying it (an `<img>`, a frame, a link, a ping, another
  origin of the site) is nobody: `401`, cookie untouched. `POST
  /api/web/session` asks the same of its caller: `403`.
- `dkw_…` as a bearer → `401`. Any other token as the cookie → `401`.
- Answered on `/api/web/*` and on `ALSO` (`web.ts`): `GET meta`, `GET|POST
  poll`, `GET manifest`, `GET blobs/…`, the last two under `spaces/<id>/`,
  `PUT spaces/private`, `GET pages`, `DELETE pages/<slug>`, `DELETE
  auth/session`, every route under `auth/members`, `auth/invites`,
  `auth/devices` and `auth/agents` (*People*, *Agents*), each by role as for
  a Mac, and sharing (`POST spaces`, `PATCH|DELETE spaces/<id>`, `POST
  spaces/<id>/restore`, `PUT|DELETE spaces/<id>/members/<id>`), each for the
  people who can open the share as for a Mac. Everything else → `403`: a
  manifest or blob `PUT`, `versions/…`, `workspace`, `settings/plan`,
  `admin/wipe`, `GET spaces`. **A route added to `ALSO` must change nothing
  on `GET`.**
- Ended: `DELETE /api/auth/session` and `401 {removed: true}` answer a browser
  with `Set-Cookie` (`Max-Age=0`) and `Clear-Site-Data: "cache", "storage"`. A
  cookie that is nobody's → `401` + the `Set-Cookie` alone.
- `GET blobs/…` → `Cache-Control: private, max-age=31536000, immutable`,
  `Vary: Cookie, Authorization`, for every caller.

A section is its id (`""`/absent Library, else a space the person can open;
any other → `404`), a path is as that section stores it, never under a
folder that stands for a section. Signed with the person's member id. Every
change to documents answers `etag`, the section's manifest once it was made,
and `over`, the manifest it was made to (a move between sections is more than
one write and answers neither). Commit lost 5 times → `503`.

```
POST   session  no credential; {code, deviceId?, deviceName?} → 201 {tokenId, member} + the cookie;
       400 not a code; 401 unknown/expired (identical); 403 not the app's own script; 503
PUT    doc?space=&path=  {md?: {text, ifRev}, meta?: {text, ifRev}} → {md?, meta?, etag, over};
       each saved file is {fid, …its entry in the manifest}. ONE manifest write. ifRev = the
       revision read, null = the file must not exist yet. Either part moved on → 409 {part:
       "md"|"meta", rev: now|null}, nothing written. `meta` is the sidecar's whole text. No marker
       or anchor check: a thread is a person's to move or remove. An html page is never written
       here (400). The same bytes are no revision: etag = over
DELETE doc?space=&path=[&v=md|html]  the document, or one version of two (last_version → 409)
DELETE folder?space=&path=  every file under it → {kind: "folder", path, files}; 404 none
POST   move  {from: {space?, path}, to: {space?, path}, kind: "document"|"folder"} → {kind, from, to,
       files}; to exactly `to`, never "into it". Across sections: unpublished?; a document
       is ≤ 16 files; a folder goes 16 files a request, whole documents at a time, by path:
       `remaining` (files still where they were) until the same request, made again, answers
       without it. `to.path` "" = the top of another section, a folder only: what was in the
       folder is what is in the section (a folder that was just shared)
PUT    mount?space=&id=  {dir, was?} → {etag, over}: the share `id`, which sits in the section
       `space`, is in its folder `dir` ("" the top) from now on; 404 not shared from there
POST   copy  the same body → {kind, from, to, files}: every file written again at `to` as a new
       file (new id, rev 1), in the same section or another; 16 files; 409 a name that is taken.
       A copy takes no page and no link with it
GET    search?q=&limit=&tag=&after=  every section the person can open, as many as a request opens →
       {query, results: [{space, fid, path, matches, moreLines?, inName?, inComments?}], total,
       truncated?, notSearched?: [{space, path}], next?}; `next` is the `after` of the request that
       goes on. 202 {indexing, pending}. tag=name:value | name (repeatable):
       only those notes; q may then be empty, and every such note is listed
PUT    pages  {space?, path, kind, slug?, title?, desc?} → 201|200 {slug, url, kind, path, documents,
       created}; path "" + folder = the whole section
DELETE pages?slug=  in whichever section of theirs holds it; elsewhere or nowhere → 404
PUT    home  {slug | null} → {home}; a page of the shared workspace (another section's → 409)
PUT    tags  {at, tag: {name, values, desc?}} → {tags, etag}: the tag that was `at` (any case), or a
       new one at the end, is now `tag`, trimmed, in its place; another of its name goes. 400 with
       the app's sentence (src/tags.ts `tagProblem`); renames no note
DELETE tags?name=  → {tags, etag}; 404 none of that name
```

Shared with the document API, never copied: `commit.ts`; `changes.ts`
(removing a document or a version, moving in and across sections, copying,
`keepPublic`); `publishing.ts`; `search.ts` (`searchIn`).

## Public routes (`src/public.ts`; no auth; GET/HEAD, else 405)

```
/                       root page if mapped and its file exists, else landing page
/<slug>                 note: <stem>.html framed when present, else markdown; ?v=md markdown
/<slug>/raw             html rendition verbatim, CSP sandbox
/<dirSlug>              folder table of contents
/<dirSlug>/<rel/path>   nested note (md extension dropped, case-insensitive), …/raw, or an html document
                        by exact path; nothing else is served
                        a slug the shared map lacks is looked up in `addresses` and served from
                        that space (cache key carries its etag and id); held by nobody → 404, uncached
anything else            404 page
```

Every page above goes out under the page policy — `default-src 'none'`, scripts only
from `<origin>/__web/<tag>/flowchart.js`, no forms, no `<base>`
([docs/cloud-publishing.md](../docs/cloud-publishing.md)) — except an html document,
which keeps `sandbox allow-scripts allow-popups`. Every response of the worker's, the
API's included, carries `X-Content-Type-Options: nosniff`.

Static assets, served by Cloudflare from `doklin-cloud-web/` without running
the worker (free, uncounted; headers from its `_headers`, `cloud-worker/web/_headers`):

```
/__web/<tag>/flowchart.js  immutable, content-tagged (the tag is spliced into the worker);
                           the one script a public page runs
/__web/fonts/<file>      the app's bundled fonts, a week
/og.png · /favicon.ico · /apple-touch-icon.png   a week
/robots.txt
/app                     the browser version's page (`app.html`, served without its extension:
                         Cloudflare's default `html_handling`); `no-cache`; its own policy:
                         `script-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`
/app/assets/<name>-<hash>  its scripts, styles and fonts; immutable
/app/gate.js             what the page runs first, as written (`src/web/gate.js`)
/app/frame               the page an html document is shown in (`app/frame.html`); `no-cache`;
                         `sandbox allow-scripts allow-popups; frame-ancestors 'self'`
```

**No path may match two rules that set the same header**: Cloudflare joins
them with a comma, and two policies joined are two policies, both enforced.
`/app`, `/app/frame` and `/app/assets/*` are three rules that never meet.

One of those paths that reaches the worker names nothing: a 404, no bucket read.

## Bucket (`src/layout.ts`)

```
workspace.json   {id, name, createdAt, createdBy: {deviceId, deviceName}}; create-only; bound iff present
manifest.json    manifest v6; CAS on etag
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
`^[a-z0-9][a-z0-9_-]{2,63}$`.

## Manifest v6 (`src/manifest.ts` ⇄ `engine/src/cloud/manifest.rs`)

```json
{
  "version": 6, "name": "Notes", "seq": 812,
  "files": { "f-3kq8x1": { "path": "Projects/plan.md", "rev": 7, "hash": "9c1e…", "size": 4310,
                            "mtime": 1757000000000, "by": "m-1a2b3c4d" } },
  "tombstones": { "f-old": { "path": "Scratch.md", "rev": 3, "ts": 1756800000000, "by": "m-1a2b3c4d" } },
  "public": {
    "k7m2p9qx": { "kind": "file", "file": "f-3kq8x1", "path": "Projects/plan.md", "by": "…", "at": 1757000000000 },
    "roadmap":  { "kind": "dir", "path": "Projects/Roadmap", "title": "Roadmap", "desc": "…", "by": "…", "at": 1757000000000 },
    "home":     { "kind": "file", "file": "f-77a1b2", "path": "Home.md", "root": true, "by": "…", "at": 1757000000000 }
  },
  "tags": [
    { "name": "status", "values": ["Todo", "Doing", "Done"], "desc": "Where a task stands." }
  ],
  "mounts": { "s-0a1b2c3d": { "dir": "Work", "rev": 2, "by": "m-1a2b3c4d", "was": "Work/Finance" } }
}
```

- Every file, tombstone and public entry has `by`: a member's id or an agent's
  (`m-` or `a-` + 8 hex). A tombstone always has `rev` and `ts`, a public
  entry `at`.
- A tombstone may carry `to`: the file was moved to another section, not
  deleted — a space id, or `""` for the shared workspace.
- A tombstone may carry `to` for a file that became a share's, too: sharing
  is that move, for every file of the item.
- `mounts` says where each share that sits in this section is: the folder of
  it its item is in (`dir`, `""` the top), and where the item was when it was
  shared (`was`; a document's without its extension), which is how its owner's
  other devices find the files they already have. **It never decides who can
  open a share** — that is D1's `parent`. The worker writes an entry when a
  share is made or moved here and takes it out when one is erased or moved
  away (`mounts.ts`); a device writes only a new `dir`. No entry is the top.
  None is taken in Library's manifest, or in a shared document's (`400`).
- A shared document's manifest holds one document at its root and nothing
  else: every path is `<name>.<ext>`, one name (`400` with a sentence).
- PUT checks ids, hashes, relative paths (no traversal), one path per file
  case-insensitively, rev/size ranges, slug grammar and reserved words,
  reference shape, ≤ 1 `root` (none in a space), `mounts`' shape. Never existence. Merge semantics are the engine's.
- Only documents: every file, tombstone and `file` public entry names a path
  `syncs` takes (`src/layout.ts` ⇄ `engine/src/lib.rs`, **change both**): the
  last segment, ASCII-lowercased, longer than and ending in `.md` `.markdown`
  `.mdown` `.mkd` `.html` or `.meta.jsonl`. Anything else → `400` with a
  sentence. The worker's own writes (`src/commit.ts`) leave out such entries a
  stored manifest still has — giving up the address of a page they drop — and
  every read (`src/workspace.ts`) treats them as absent.
- `tags` is the workspace's tag list, in order, Library's manifest's alone
  (another section's with any → `400`). PUT holds it to the app's rules (`listProblem`,
  `src/tags.ts` ⇄ `engine/src/cloud/tags.rs`, **change both**): each name and
  value, ≥ 1 value, no name or value twice in any case, ≤ 50 tags of ≤ 50
  values, `desc` ≤ 1000 characters. Every writer keeps it as it found it but
  for its own change, over the list as it is then: the later change wins.
- Other `version` → `426`, sentence names which side is behind.

## D1 (`src/schema.ts`, schema 13)

```sql
meta         (key PK, schema_version)          survives wipe
members      (id m-…, email UNIQUE normalized, name, role, created_at, last_seen_at, disabled)
tokens       (hash PK, id t-…, member_id → members CASCADE, device_id, device_name, created_at)
invites      (hash PK, id i-…, member_id → members CASCADE, created_at, expires_at)
presence     (device_id PK, member_id, device_name, space_id '' = shared, path?, ts, until)
             read and swept by until (the beat's ttl from ts)
leases       ((space_id, path) PK, path lowercased, device_id, member_id, device_name, until)
             until = the claiming beat's
agents       (id a-…, name, scopes, created_at, last_used_at, member_id)
agent_codes  (hash PK, id c-…, agent_id → agents CASCADE, created_at, expires_at)
agent_tokens (hash PK, id t-…, agent_id → agents CASCADE, host, created_at)
search_text  ((space_id, fid) PK, folded)   space_id '' = shared; md file id, else html; NULL past 1 MB
search_state (space_id PK, etag, held)      held = {"<fid>": "<text hash>.<sidecar hash>"}, for every table
links        ((space_id, fid, target) PK)  a note's md file id → each file it links to; '' shared; by target
tags         ((space_id, fid, name) PK, value, folded)  a note's md file id → each pair of its block;
             name and folded lower-cased; by (space_id, name, folded)
superadmin     (id = 1 PK, member_id)   who last traded the key; one row or none
spent_keys     (hash PK, spent_at)      keys already traded; a wipe keeps it
removed_tokens (hash PK, removed_at)    credentials an owner took away; emptied by a wipe
spaces        (id s-…|p-…, kind private|folder|document, name, created_by, created_at, etag,
               parent, deleted_at)   etag = its manifest's; parent = the space it sits in (NULL a
               My files); deleted_at set on a deleted share and all inside it; by parent
space_members ((member_id, space_id) PK, added_by, added_at)   who a space is shared with; a My
               files holds its one person
addresses     (slug PK, space_id)       which space a public address is; '' = shared
settings      (key PK, value)           key plan: free | paid; a wipe keeps it
usage         (who PK, day, requests, at)  who = tokenId, day = floor(ms / 86400000); one report a
                                        credential, yesterday's swept by the next; a wipe keeps it
```

`members.disabled = 1` is a removed person: no tokens, not listed, still in
`/api/meta` `people`. `hash` columns are `sha256(token or code)`. Migrations: ordered `STEPS` run
on `/api/meta`, idempotent `CREATE … IF NOT EXISTS`, then `UPDATE meta SET
schema_version = <to> WHERE key = 'schema' AND schema_version = <the version read>`
so concurrent isolates converge. A table whose rows are worth keeping never
changes shape by `DROP`: a step that adds a column to one adds it only when a
read of it fails (`ALTER TABLE … ADD COLUMN` is not idempotent). One that holds
only what lapses in minutes (`presence`) is dropped and made again. Updates ship no migrations
directory: add a step, never a wrangler migration. A step that has shipped is
never renumbered or removed: a database stores only the number it reached, so a
number that changes meaning makes the runner skip a step it never ran.
Single-primary: no read replicas (a lease two Macs both believe they hold is
worse than none).

## Deploying

```sh
curl -fsSL https://github.com/boat-builder/doklin/releases/latest/download/doklin-cloud-worker.js -o doklin-cloud-worker.js
curl -fsSL https://github.com/boat-builder/doklin/releases/latest/download/doklin-cloud-web.tar.gz | tar -xz   # doklin-cloud-web/
npx -y wrangler@4 whoami
npx -y wrangler@4 r2 bucket create doklin-notes-example-com
npx -y wrangler@4 d1 create doklin-notes-example-com      # prints database_id
# wrangler.toml from cloud-worker/wrangler.toml.example: account id, database id, names, domain
npx -y wrangler@4 secret put OWNER_TOKEN
npx -y wrangler@4 deploy
curl -fsS -H "Authorization: Bearer $KEY" https://notes.example.com/api/meta     # d1 must be a number
sh doklin-cloud-update.sh https://notes.example.com       # update (release asset)
```

`wrangler.toml` serves `[assets] directory = "doklin-cloud-web"`, declares the
sweep's `[triggers] crons = ["17 3 * * *"]` (one of an account's five on Free),
and carries two `[[ratelimits]]` blocks, `DEVICE_LIMIT` and `AGENT_LIMIT`
(namespaces `1001`, `1002`). The setup prompt, the update script and the
example write the same lines, held together by
`verify-harness/cloudprompts.test.mjs`. A namespace is the account's, so two
domains on one account share it; their keys (token ids) never meet.

Names: `notes.example.com` → `doklin-notes-example-com`; workers.dev name
`sherin-notes` → `doklin-sherin-notes` (`resourceName`, `src/cloudPrompts.ts`).
Teardown: app wipe, then `wrangler delete`, `wrangler d1 delete`, `wrangler r2 bucket delete`.

## Developing

```sh
pnpm typecheck:worker
pnpm test:worker       # node cloud-worker/test/run.mjs [--bundle <file>]; fake R2, D1 on node:sqlite
pnpm bundle:worker     # node scripts/bundle-worker.mjs [--no-app] → cloud-worker/dist/ (worker + doklin-cloud-web/)
node verify-harness/serve-worker.mjs   # bundle over test/seed.mjs on :8787
node verify-harness/drive-cli.mjs      # built cli/ against the worker
node verify-harness/drive-web.mjs      # the browser version, built, in real browsers over https
```
