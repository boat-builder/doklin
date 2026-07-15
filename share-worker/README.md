# Doklin share worker

The self-hostable backend behind the app's **Share** button: one Cloudflare
Worker in front of one R2 bucket. It publishes documents as public, read-only
web pages at `https://<your-host>/<id>`. No database, no user model, no other
infrastructure.

The desktop app is backend-agnostic — it talks to whatever endpoint you
configure in **Share → Sharing settings…**, authenticated by a bearer token you
choose. This README is the guide for standing up your own backend.

## How sharing works

- The app's **Share** button publishes the active document: it `PUT`s
  `{title, markdown?, html?}` to `/api/pages/<id>` and a canvas-rendered
  1200×630 OG png to `/api/pages/<id>/og`. A document can be a markdown file,
  a generated html rendition (same stem, `.html` next to the `.md`), or both —
  whatever exists locally is pushed together. The markdown travels WITH its
  CriticMarkup comments (worker version 10): the worker strips them at render
  time from everything view-role and public visitors see (pages, titles,
  descriptions, OG derivations), and serves them — the same threads the
  desktop shows — to comment/edit-role sessions.
- Every autosave of a shared document re-pushes it (debounced), so the public
  page tracks the local file. Regenerating the html rendition while the
  document is open re-pushes too.
- When a page has both versions, the link opens on the html rendition (the
  polished, human-facing one — the opposite of the editor, which leads with
  the markdown source), and a small MD/HTML pill on the public page switches
  to `/<id>?v=md` (rendered markdown). The rendition is served in a sandboxed
  full-page iframe via `/<id>/raw`.
- **Stop sharing** `DELETE`s `/api/pages/<id>`, which removes both objects from
  the bucket — the link 404s from then on.
- **Folder shares**: sharing a folder (or the whole workspace) publishes a
  *collection* — a page stored with `kind: "collection"` whose public side is
  a table-of-contents home linking to the member pages, under an owner-set
  title and optional description. The TOC adapts to its size: a handful of
  pages (≤ 8) renders as a flat list of cards, each wearing its folder path
  as a subtitle; more than that renders as a collapsible tree. Sharing a
  folder shares no documents by itself: the app pushes the membership list
  explicitly, and only listed pages appear. Members are ordinary pages that
  carry a `collection: {id, title}` back-reference, which renders as a
  "← back to the folder" crumb on their public page.
- Pages render server-side with a vendored copy of `marked`
  (`vendor/marked.esm.js`, pinned) and CSS that mirrors the app's reading view,
  honoring light/dark via `prefers-color-scheme`. Shared pages carry
  `<meta name="robots" content="noindex">`.
- **Mermaid diagrams** (worker version 12): a page whose markdown carries a
  ` ```mermaid ` block gets a small hydration script that renders each block
  into an SVG in place, themed from the page's own palette (light and dark).
  The mermaid module is embedded in the worker like the app shell and served
  at `GET /__web/<v>/mermaid.js`, so only pages that actually contain
  diagrams ever download it; the app shell's editor loads the same module.
  Without JavaScript (or for a source that doesn't parse) the block stays a
  readable code block.
- **Access codes** (worker version 7): any share can be protected with *named*
  codes — one per person or group ("Acme team" / `sunset-marble-fig`), each
  individually revocable. Visitors hit a code-entry gate (generic on purpose:
  no title, no description, no OG image — nothing leaks before the code) and
  unlock once per browser for 30 days, via an HttpOnly cookie signed with a
  random key the worker mints into the bucket on first use — no extra secret
  to configure. Codes on a folder share cover its table of contents and every
  member page; a member's own codes take precedence. The worker stores only
  SHA-256 hashes (normalized trim/lowercase/NFKC, so phone keyboards can't
  lock anyone out), compares in constant time, and rate-limits unlock attempts
  per IP. Revoking a code kills exactly the sessions it minted, on their next
  request. The app manages all of it from the Share popover ("Restrict…") and
  the folder-share dialog, keeps the plaintext codes cached locally so you can
  re-copy them, and offers a self-unlocking "link + code" format that carries
  the code in the URL #fragment (never sent to servers or logs).
- **Code roles — commenting & editing on the web** (worker version 8): every
  access code carries a role — **view** (the default; exactly what codes
  always were), **comment**, or **edit** — picked in the app when the code is
  created and changeable any time after. Unprotected shares stay read-only:
  only a restricted share has named identities to grant anything to. The
  unlock cookie names the code; the code's *current* entry supplies the role
  on every request, so a downgrade (or revocation) bites on the visitor's
  next click. Folder-share codes carry their role onto every member page.
  - **The app shell (worker version 10):** a comment- or edit-role session
    doesn't get the static page at `/<id>` at all — it gets the desktop
    app's own editor and comment surface, compiled for the browser and
    embedded in this worker (built from `web/main.tsx` by
    `scripts/build-web.mjs`; the same components, the same stylesheet). A
    shared document looks and behaves exactly like it does on the owner's
    machine: the real Milkdown editor for markdown, the sandboxed rendition
    with the hover bubble for html, and the floating comment rail beside
    both. Commenting and editing on the web need JavaScript (view-role
    pages and the code gate still work without it).
  - *Comment*: the full desktop commenting experience, on both views.
    Markdown: select text → a floating Comment bubble opens a thread card in
    the rail (the document itself is read-only for this role). Html: hover a
    block → the bubble opens an element-anchored card. Threads take replies,
    edits, and deletions like the desktop rail, and they're the SAME threads
    the owner sees in the app:
    - markdown threads are CriticMarkup in the document — a web comment is a
      save whose stripped content is unchanged (the worker enforces exactly
      that for comment-role saves via `POST /<id>/save`), and it flows back
      to the owner's file through the ordinary web-edit pull.
    - html threads live in `pages/<id>.comments.json` in the app's own
      sidecar shape (`{id, anchor: {path, tag, text}, comments}`), a small
      rev-guarded document of its own (`GET/POST /<id>/html-comments`). The
      worker stamps every web-originated entry with a stable id and the
      access code that wrote it; the app pushes its local sidecar threads in
      and merges web additions back out on its reconcile pass, so the
      desktop rail and the web rail show one conversation. The owner also
      reads/moderates the pool from the Share popover or the API.
  - *Edit*: the same shell with the document editable — typing autosaves
    through revision-guarded saves (a concurrent save surfaces a
    reload/keep-mine choice instead of clobbering), a new lead H1 retitles
    the page, and a *content* change marks any html rendition stale (the
    edited markdown becomes the default view until the app pushes a fresh
    rendition — comment-only saves never trip this). The app pulls web
    edits back into the local file on its reconcile pass (launch / window
    focus): untouched files fast-forward silently; a file with local
    changes of its own surfaces a conflict in the Share popover — "Use web
    version" or "Keep mine" — and never overwrites either side without
    being asked.

## Set up your own backend

**No terminal needed:** the desktop app ships a guided setup (gear menu →
**Sharing setup…**, or the Share button while unconfigured) with three paths:
a dashboard-only walkthrough (the app carries a bundled copy of this worker's
code to paste into the Cloudflare dashboard editor — no git, no Node, no
wrangler), a ready-made prompt to hand to an AI coding agent (Claude Code
etc.) that runs the wrangler steps for you, and the CLI path below. In every
case the app generates the token and verifies the connection at the end.

Prerequisites: a Cloudflare account (free tier is fine) and the wrangler CLI.
Use `npx -y wrangler@4` throughout — a globally installed `wrangler` may be too
old. Authenticate once with `npx wrangler@4 login`, or headlessly by exporting
`CLOUDFLARE_API_TOKEN` (an API token with *Workers Scripts: Edit*, *Workers R2
Storage: Edit*, and — only if you want a custom domain — *Zone / DNS: Edit* on
the target zone).

**No clone needed:** every app release publishes the worker as one
ready-to-deploy file at a stable URL —

```
https://github.com/boat-builder/doklin/releases/latest/download/doklin-worker.js
```

(generated by `scripts/bundle-worker.mjs` in CI; it's this folder's source
with the vendored `marked` — and, since version 10, the compiled app shell
that comment/edit sessions load, plus, since version 12, the standalone
mermaid module — inlined; the whole file is ~2.6 MB gzipped, within
Cloudflare's 3 MB free-plan worker size limit). Deploying from a checkout: run
`node scripts/bundle-worker.mjs` first and deploy the file it writes
(`share-worker/dist/doklin-worker.js`) — pointing wrangler straight at
`src/index.js` also runs, but with an empty `webAssets.js` stub, so
comment/edit sessions would get a "web assets not bundled" shell. From
scratch:

```sh
mkdir doklin-backend && cd doklin-backend

# 1. Get the worker (or use a checkout's share-worker/ with main = "src/index.js").
curl -fsSL https://github.com/boat-builder/doklin/releases/latest/download/doklin-worker.js -o doklin-worker.js

# 2. Write the deployment config — never commit this file (in the repo it's
#    gitignored as share-worker/wrangler.toml; the tracked template with all
#    the options explained is share-worker/wrangler.toml.example).
cat > wrangler.toml << 'EOF'
name = "doklin-share"
main = "doklin-worker.js"
compatibility_date = "2025-05-05"
workers_dev = true
[[r2_buckets]]
binding = "PAGES"
bucket_name = "doklin-pages"
EOF

# 3. Create the R2 bucket — it must exist BEFORE deploy. Neither wrangler
#    deploy nor the app auto-creates it; the app only reads/writes objects
#    through the worker. Use the same name you put in wrangler.toml.
npx wrangler@4 r2 bucket create doklin-pages

# 4. Generate a write token and store it as the worker secret.
openssl rand -hex 32                       # copy the output
npx wrangler@4 secret put SHARE_TOKEN      # paste it when prompted

# 5. Deploy.
npx wrangler@4 deploy                      # prints your worker URL
```

With the template's `workers_dev = true`, the worker is live at
`https://<name>.<your-subdomain>.workers.dev` — that URL is your share endpoint.

### Custom domain (optional)

The app's setup guide can do this for you: the **AI agent** path asks for your
domain and hands the agent the steps below. Doing it yourself:

The domain's zone must already be active on the **same** Cloudflare account
(added in the dashboard, nameservers pointed at Cloudflare). Then in
`wrangler.toml` set:

```toml
workers_dev = false
routes = [
  { pattern = "notes.example.com", custom_domain = true }
]
```

On the next `npx wrangler@4 deploy`, wrangler creates the Custom Domain binding
and provisions the DNS record + TLS certificate automatically (cert issuance can
take a minute or two on first deploy). An apex domain (`example.com`) and a
subdomain of a zone you already run on Cloudflare (`notes.example.com`) work
the same way — for the subdomain case there's nothing else to do, since the
zone is already there. One depth limit on the free plan: Universal SSL covers
only one label under the zone, so `notes.example.com` is fine but
`a.b.example.com` needs Cloudflare's paid Advanced Certificate Manager. If
deploy reports the zone isn't found, add the domain to Cloudflare first —
wrangler won't create the zone for you. Dashboard-only alternative (no
wrangler): on the worker's page, **Settings → Domains & Routes → Add →
Custom Domain**.

### Several domains on one account

The app can hold several connections (one per domain), and each is a full
separate stack: its own worker, its own bucket, its own token. Worker and
bucket names are unique per Cloudflare account, so give every setup fresh
names — the app's agent prompt derives them from the domain
(`doklin-share-notes-example-com` / `doklin-pages-notes-example-com`). Two
warnings worth respecting: deploying with an existing worker's `name`
doesn't error — it silently updates that worker and, after `secret put`,
overwrites its token, cutting off the other domain's connection; and
pointing two workers at one bucket publishes every page on both domains.

### Connect the app

The app ships this whole guide built in: while sharing is unconfigured, the
**Share** popover (and the gear menu's **Sharing setup…**) opens a step-by-step
setup window that ends with the endpoint + token form, verified against the
worker before saving. Set the endpoint to your worker URL (no trailing slash)
and the token to the hex string from step 3. The app can hold several such
connections (one per domain) and stores them in a machine-local file that
never enters any repo —
`~/Library/Application Support/com.sherin.doklin/share.json`:

```json
{
  "version": 2,
  "connections": [
    { "id": "c-xxxxxxxxxx", "endpoint": "https://<name>.<your-subdomain>.workers.dev", "token": "<the hex token>" }
  ],
  "defaultId": "c-xxxxxxxxxx"
}
```

You can also write that file directly instead of using the form.

### The root page: branding it, or replacing it

The root of your share domain serves a small landing page that vouches for the
links ("every page here was published by a real person") and offers a **Download
Doklin for macOS** button so visitors can grab the app. You have three levels of
control, no redeploy needed for the first two — the app writes them through the
worker's `/api/site` endpoint:

1. **Default** — the generic landing page, out of the box.
2. **Branded** — put your name (linking to your profile) on it: in the app,
   the last setup step offers it, and **Sharing settings** can change it any
   time.
3. **Replaced** — any page you've shared can *become* the root: pick **Use as
   home page** in the app's Shared pages list (`rootPageId` in the site
   config). Write the page in the editor — or share a folder and make its
   table of contents the root. The default landing page is gone until you
   unset it.

The download button defaults to the official GitHub release's stable
latest-download alias, kept current by the repo's release workflow
(`.github/workflows/release.yml`). Point it elsewhere — or hide it with `""` —
via the `downloadUrl` field of `PUT /api/site`.

### Recreating `wrangler.toml` for an existing deployment

`wrangler.toml` is gitignored, so a fresh clone won't have one — but the live
worker, bucket, custom domain, and `SHARE_TOKEN` secret all live on Cloudflare
and keep running without it. The file is only needed the next time you deploy.
To rebuild it, copy the example and fill in the values of the **existing**
deployment (assumes a logged-in wrangler CLI):

- `account_id` — `npx wrangler@4 whoami`. If the login has several accounts,
  pick the one that owns the R2 bucket (`npx wrangler@4 r2 bucket list` errors
  on the wrong one).
- `name` — must match the deployed worker, or deploy will create a *second*
  worker while the domain stays bound to the old one. Verify a guess with
  `npx wrangler@4 deployments list --name <name>`.
- `bucket_name` — `npx wrangler@4 r2 bucket list`.
- `routes` — the host the app's share endpoint points at: check **Share →
  Sharing settings…** or the connection's `endpoint` in `share.json`. If it's
  a `workers.dev` URL, use `workers_dev = true` and no `routes` instead.

Landing-page branding needs nothing here — it lives in the bucket
(`site.json`) and survives redeploys.

Do **not** re-run `secret put SHARE_TOKEN` while rebuilding the config — the
secret persists on the worker across deploys, and setting a new value would cut
off the app until its token is updated too. Only touch it to rotate:

### Rotating the token

```sh
openssl rand -hex 32                       # generate a new token
npx wrangler@4 secret put SHARE_TOKEN      # update the worker
# then paste the same value into the app's Sharing settings
```

Old links keep working; only the app's write access is re-keyed.

## Cloud sync (worker version 4; shared share-registry needs 5)

The same worker doubles as a **private sync backend**: the app can sync whole
workspaces (folders) to the bucket, bidirectionally, across machines and
people. Nothing under sync is public — the public routes above only ever serve
`pages/*` and `site.json`.

- A **workspace** is one synced folder: a manifest object (the single source
  of truth, updated by compare-and-swap on its R2 etag) plus immutable,
  content-addressed file blobs. Old blobs stay put until garbage-collected,
  which is what powers per-file version history.
- **People** join with one-time invite codes and hold per-device tokens. The
  worker stores only SHA-256 hashes of credentials (as object keys under
  `auth/`), so the bucket never contains a usable secret. Tokens carry a role:
  the **owner** (SHARE_TOKEN or a linked-device token) can do everything;
  a **member** can sync the workspaces named in their invite and publish
  pages — only their own — but can't touch the site config, tokens, invites,
  or workspace admin.
- **Shares are workspace state too** (worker version 5): the manifest carries
  the workspace's share registry (`shares` + `collections` sections), so every
  device and every member sees the same "this document is published at that
  page" truth — nobody double-publishes, and whoever edits a shared file keeps
  its public page fresh from their own machine. Pages published from a synced
  workspace are stamped with the workspace id (`ws` customMetadata) and are
  managed **collectively**: any member of that workspace can update or stop
  them, and sees them in `GET /api/pages` — the folder's files are everyone's
  to edit, so their public faces are too.
- **Invite links** look like `https://<host>/join#dk_i_…` — `GET /join` is a
  public landing page that walks the invitee through connecting the app. The
  code rides the URL fragment, which browsers never send to servers.
- Revocation is immediate: deleting a token's object is the revocation.
- Presence ("Alice is editing…") is a TTL'd, best-effort object per
  workspace; the app heartbeats it while actively editing.

## R2 layout

```
site.json         {ownerName?, ownerLink?, downloadUrl?, rootPageId?, updatedAt}  (app-managed site config)
pages/<id>.json   {title, markdown?, html?, htmlStale?, collection?, access?, rev, webEdit?, createdAt, updatedAt}
                  (+ customMetadata for listing, incl. owner: the token that published it, ws: the
                  synced workspace it was published from, when any — that stamp is what lets every
                  member manage it — protected: "1" while access codes are set, rev, and
                  webEdit/webEditBy/webEditAt while the latest write came from the web editor)
                  or {kind: "collection", title, description?, items: [{id, title, path}], access?, createdAt, updatedAt}
                  access = {codes: [{id, label, hash, role?, createdAt}], updatedAt} — visitor access
                  codes, hashes only; server-managed (content pushes carry it forward untouched).
                  role = "comment" | "edit" (absent = view). rev counts content writes (app pushes +
                  web edits); webEdit = {by, at} while the latest write came from the web editor;
                  htmlStale marks a rendition outdated by a web edit
pages/<id>.comments.json  {v: 2, rev, threads: [{id, anchor: {path, tag, text}, comments:
                  [{author, at, body, eid?, codeId?, label?}]}]} — the page's html-rendition comment
                  threads (worker version 10): the app's own sidecar shape plus per-entry provenance
                  the worker stamps on web-originated entries (eid + which access code wrote it).
                  A small rev-guarded document of its own so content pushes and comment writes never
                  race; deleted with the page. Pre-v10 flat pools ({comments: [...]}) read as one
                  thread per comment — nothing a visitor wrote is lost in the upgrade.
                  Markdown comment threads have no object here: they live IN the stored markdown
                  as CriticMarkup.
pages/<id>.png    OG image
auth/tokens/<sha256-of-token>.json    {id, name, role, workspaces, createdAt, lastSeenAt}
auth/invites/<sha256-of-code>.json    {id, name, role, workspaces, createdAt, expiresAt, claimed?}
auth/gate-key.json                    {key, createdAt} — random HMAC key for gate cookies, minted on first unlock
sync/<ws>/ws.json                     {id, name, createdAt}
sync/<ws>/manifest.json               {version, name, seq, files: {<fileId>: {path, rev, hash, size,
                                      mtime, by, hist: [{r,h,s,t,b}]}}, tombstones: {<fileId>: {...}},
                                      shares: {<fileId>: {id, path, cid?, title, by, at}},
                                      collections: {<pageId>: {path, title, desc?, by, at}}}
                                      (shares/collections = the workspace's share registry; a share
                                      may outlive its file — deleting a doc never unpublishes it)
sync/<ws>/files/<fileId>/<hash>       immutable file content, addressed by (a prefix of) its sha256
sync/<ws>/history/<fileId>.json       deep revision archive (entries rolled out of the manifest's hist)
sync/<ws>/presence.json               {devices: {<deviceId>: {name, fileId, path?, ts}}}
```

## API contract

The write API the app depends on (all under the endpoint, requires
`Authorization: Bearer <token>`):

```
GET    /api/meta             worker version + features -> { version, features: [...] }
GET    /api/site             site config -> { site: {ownerName?, ownerLink?, downloadUrl?, rootPageId?} }
PUT    /api/site             body = the same object, full record every time (missing field = unset)
GET    /api/pages            list shared pages -> { pages: [{ id, title, createdAt, updatedAt,
                             protected, rev, webEdit }] } (rev/webEdit: see below — one listing
                             tells the app every page the web edited)
GET    /api/pages/<id>       existence/metadata check (includes protected, rev,
                             webEdit: {by, at} | null, htmlStale)
PUT    /api/pages/<id>       body {title, markdown?, html?, collection?, ws?, baseRev?} -> create/update
                             a page -> {..., rev}
                             (at least one of markdown/html; collection {id, title} marks
                             folder-share membership and renders the back-home crumb;
                             ws = the synced workspace the page belongs to — the writer must
                             have access to it, the stamp is sticky once set, and it opens
                             the page to management by every member of that workspace;
                             baseRev = the rev this client last pushed or pulled — when the
                             page meanwhile took a WEB edit, a mismatch answers 409
                             {rev, webEdit} instead of clobbering it. Mismatches without a
                             pending web edit — ordinary device-to-device churn — keep
                             last-writer-wins, as do pushes that omit baseRev)
                             or body {title, kind: "collection", items, description?, ws?} ->
                             create/update a folder share (items = [{id, title, path}], path
                             relative to the shared folder; drives the public table of
                             contents; description shows under the TOC's title)
GET    /api/pages/<id>/content  the stored document -> { title, markdown, hasHtml, htmlStale,
                             rev, webEdit, protected } — how the app pulls a web edit back
                             into the local file
PUT    /api/pages/<id>/og    body image/png          -> set OG image
DELETE /api/pages/<id>       stop sharing (remove page + OG image + comments)
```

Visitor access codes (worker version 7; roles + PATCH need version 8; same
auth — whoever can update a page can manage its codes):

```
GET    /api/pages/<id>/access             -> { protected, codes: [{id, label, role, createdAt}] }
                                          (ids + labels + roles only — the worker keeps hashes,
                                          it can never echo a code back)
POST   /api/pages/<id>/access/codes       body {label?, code, role?} -> {id, label, role, createdAt}
                                          (code is normalized trim/lowercase/NFKC, 4–128
                                          chars; duplicate plaintext on one page -> 409;
                                          role = "view" (default) | "comment" | "edit")
PATCH  /api/pages/<id>/access/codes/<cid> body {label?, role?} — rename a code or change what
                                          it may do (applies to live sessions on their next
                                          request)
DELETE /api/pages/<id>/access/codes/<cid> revoke one code + exactly its visitor sessions
DELETE /api/pages/<id>/access             remove protection entirely
```

Html-rendition comment threads, owner side (worker version 10; same auth —
the same pool browser sessions read/write through `/<id>/html-comments`):

```
GET    /api/pages/<id>/comments           -> { rev, threads } — the pool in the app's sidecar
                                          shape; how the app pulls web comments back into the
                                          local sidecar (three-way merge, deletions stick)
PUT    /api/pages/<id>/comments           body {baseRev, threads} -> {rev, threads} — swap the
                                          whole list against the rev it was built on; a lost
                                          race answers 409 {rev, threads} to merge against.
                                          How the app pushes its local sidecar threads in
DELETE /api/pages/<id>/comments/<tid>     moderate one thread away
DELETE /api/pages/<id>/comments           clear the page's threads entirely
```

(`GET /api/pages` rows carry `commentsRev` — the pool's revision — so one
listing tells the app which pages have web comments to pull.)

The sync + auth API (worker version 4; same bearer auth, roles apply):

```
GET    /api/auth/whoami                  -> { tokenId, name, role, workspaces }
POST   /api/auth/invites                 owner; body {name?, role: "member"|"owner",
                                         workspaces: [ids] (member only), ttlMs?}
                                         -> { id, code, joinUrl, expiresAt, ... }
GET    /api/auth/invites                 owner; pending invites (expired ones swept)
DELETE /api/auth/invites/<id>            owner; cancel an invite
POST   /api/auth/join                    NO AUTH; body {invite, name?} -> {token, tokenId,
                                         name, role, workspaces} — single use, CAS-guarded
GET    /api/auth/tokens                  owner; every minted token (never the secrets)
DELETE /api/auth/tokens/<id>             owner; revoke — effective on the next request

GET    /api/sync/workspaces              workspaces the caller can see
POST   /api/sync/workspaces              owner; body {id?, name} -> {id, manifestEtag}
DELETE /api/sync/workspaces/<ws>         owner; purge (repeat until remaining: false)
GET    /api/sync/<ws>/poll               -> { manifestEtag, presence } — the cheap poll
GET    /api/sync/<ws>/manifest[?since=e] -> manifest JSON + x-manifest-etag (304 if same)
PUT    /api/sync/<ws>/manifest           header x-base-etag required; 412 + current etag
                                         on a lost race; body validated (paths, caps)
GET    /api/sync/<ws>/files/<fileId>     -> { blobs: [{hash, size, uploaded}] } (for GC)
GET    /api/sync/<ws>/files/<fid>/<hash> -> the bytes
PUT    /api/sync/<ws>/files/<fid>/<hash> store bytes (immutable, content-addressed)
DELETE /api/sync/<ws>/files/<fid>/<hash> garbage-collect an unreferenced revision
GET    /api/sync/<ws>/history/<fileId>   -> { version, entries } deep revision archive
PUT    /api/sync/<ws>/history/<fileId>   replace the archive (advisory, size-capped)
PUT    /api/sync/<ws>/presence           body {deviceId, name?, fileId|null, path?}

POST   /api/admin/wipe                   owner; body {"confirm":"wipe"} — erase every
                                         object in the bucket (pages, workspaces,
                                         credentials, site config); repeat until
                                         remaining: false. The erase step of tearing a
                                         backend down: R2 refuses to delete a non-empty
                                         bucket, so the app empties it through this
                                         before you delete the worker + bucket
```

Smoke-test the whole contract without deploying: `node test/run.mjs` (plain
node, an in-memory R2 fake — covers auth, invites, CAS races, scoping).

Folder shares, `/api/site`, and `/api/meta` need a worker deployed from this
version of the code or newer — an older worker rejects collection pushes with
a 400 and 404s the site/meta routes, which the app surfaces as "redeploy your
worker".

Plus the public reads a browser hits (no auth): `GET /<id>` (the html
rendition when the page has one — framed — otherwise rendered markdown; a
web-edited page whose rendition went stale leads with the markdown instead,
with `?v=html` reaching the old rendition explicitly), `GET /<id>?v=md`
(rendered markdown), `GET /<id>/raw` (the rendition verbatim), and
`GET /<id>/og.png` (OG image). On a protected share every one of those serves
the code-entry gate (401) until the browser holds the share's cookie;
`POST /<id>/unlock` (form body `code`, optional `next`) is the gate's
target — correct code ⇒ Set-Cookie + 303 back. A `#c=<code>` fragment on a
page link pre-fills and submits the gate automatically.

Behind the gate, a comment/edit-role session's `/<id>` serves the app shell
instead of the static page, and the shell talks to the write surface (worker
version 10; JSON, same-origin): `POST /<id>/save` (body `{markdown, baseRev,
force?}` — edit role saves the document; comment-role saves must leave the
stripped content unchanged, which is how markdown comments post),
`GET/POST /<id>/html-comments` (the rendition's thread pool: `{rev,
threads}`, rev-guarded whole-list swaps), and `GET
/__web/<v>/app.js|app.css|mermaid.js` (the shell's compiled frontend and the
standalone mermaid module, public + immutable). Saves and comment
writes are rate-limited per IP like the gate. The v8/v9 form routes
(`/<id>/edit`, `/<id>/comments…`) now 303 back to the page.

## Updating a deployed worker

The app probes each backend's `/api/meta` on launch and compares it against
the `WORKER_VERSION` in the worker code it bundles. When a deployment lags,
the settings gear shows an update badge and **Settings → Update backend
worker…** opens a guided redeploy: paste the new code over the old one in the
Cloudflare dashboard's worker editor (this swaps only the code — the R2
binding, the `SHARE_TOKEN` secret, and any custom domain survive), or hand
the dialog's prompt to an AI agent — it downloads the latest
`doklin-worker.js` from the release URL above and redeploys under the same
name. The dialog's "Check again" verifies the live version afterwards.
Updating by hand works the same way: fetch the latest bundle (or pull the
repo), deploy over the **same worker name** — a different name creates a
second worker instead of updating this one.

## Using a non-Cloudflare / S3 backend

This worker is Cloudflare-specific: it stores objects through the R2 *binding*
API (`env.PAGES.get/put/delete/list`) and renders the public page server-side —
so it won't run on plain S3 as-is. But the app only speaks the small HTTP
contract above, so you can reimplement it on any stack (S3 + Lambda / API
Gateway, a small Node/Go server in front of any object store, …) and point the
app's endpoint at it. R2 also exposes an S3-compatible API if you want to keep
this worker but manage the bucket with S3 tooling.
