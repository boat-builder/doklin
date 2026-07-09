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
  whatever exists locally is pushed together. CriticMarkup comments are
  stripped before upload (and again in the worker, as defense in depth).
- Every autosave of a shared document re-pushes it (debounced), so the public
  page tracks the local file. Regenerating the html rendition while the
  document is open re-pushes too.
- When a page has both versions, the reader picks: a small MD/HTML pill on the
  public page switches between `/<id>` (rendered markdown) and `/<id>?v=html`
  (the html rendition, served in a sandboxed full-page iframe via
  `/<id>/raw`).
- **Stop sharing** `DELETE`s `/api/pages/<id>`, which removes both objects from
  the bucket — the link 404s from then on.
- Pages render server-side with a vendored copy of `marked`
  (`vendor/marked.esm.js`, pinned) and CSS that mirrors the app's reading view,
  honoring light/dark via `prefers-color-scheme`. Shared pages carry
  `<meta name="robots" content="noindex">`.

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

All deployment config lives in `wrangler.toml`, which is **gitignored** (it
holds your account id, domain, and bucket). Create yours from the template:

```sh
cd share-worker

# 1. Create your config from the template, then fill in the placeholders
#    (worker name, account_id, bucket_name — comments in the file explain each).
cp wrangler.toml.example wrangler.toml

# 2. Create the R2 bucket — it must exist BEFORE deploy. Neither wrangler
#    deploy nor the app auto-creates it; the app only reads/writes objects
#    through the worker. Use the same name you put in wrangler.toml.
npx wrangler@4 r2 bucket create <your-bucket>

# 3. Generate a write token and store it as the worker secret.
openssl rand -hex 32                       # copy the output
npx wrangler@4 secret put SHARE_TOKEN      # paste it when prompted

# 4. Deploy.
npx wrangler@4 deploy                      # prints your worker URL
```

With the template's `workers_dev = true`, the worker is live at
`https://<name>.<your-subdomain>.workers.dev` — that URL is your share endpoint.

### Custom domain (optional)

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
take a minute or two on first deploy). An apex domain works the same way. If
deploy reports the zone isn't found, add the domain to Cloudflare first —
wrangler won't create the zone for you.

### Connect the app

The app ships this whole guide built in: while sharing is unconfigured, the
**Share** popover (and the gear menu's **Sharing setup…**) opens a step-by-step
setup window that ends with the endpoint + token form, verified against the
worker before saving. Set the endpoint to your worker URL (no trailing slash)
and the token to the hex string from step 3. The app stores both in a
machine-local file that never enters any repo —
`~/Library/Application Support/com.sherin.doklin/share.json`:

```json
{ "endpoint": "https://<name>.<your-subdomain>.workers.dev", "token": "<the hex token>" }
```

You can also write that file directly instead of using the form.

### Landing page branding (optional)

The root of your share domain serves a small landing page that vouches for the
links ("every page here was published by a real person") and offers a **Download
Doklin for macOS** button so visitors can grab the app. Brand it by adding to
`wrangler.toml` and redeploying:

```toml
[vars]
OWNER_NAME = "Your Name"
OWNER_LINK = "https://linkedin.com/in/your-handle"
# DOWNLOAD_URL defaults to the official release below; set it to override, or
# to "" to hide the download button entirely.
DOWNLOAD_URL = "https://github.com/boat-builder/doklin/releases/latest/download/Doklin-macos-arm64.dmg"
```

All three are optional — without `OWNER_*` the page stays generic, and the
download button shows the official release unless you set/blank `DOWNLOAD_URL`.
That download URL is a stable alias kept current by the repo's release workflow
(`.github/workflows/release.yml`), so it always resolves to the newest build.

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
  Sharing settings…** or the `endpoint` in `share.json`. If it's a
  `workers.dev` URL, use `workers_dev = true` and no `routes` instead.
- `[vars] OWNER_NAME / OWNER_LINK / DOWNLOAD_URL` — open `https://<host>/` in a
  browser: if the landing page is branded, restore `OWNER_*` to match, or the
  next deploy turns it generic. Only set `DOWNLOAD_URL` if the live button
  points somewhere other than the official release (or is hidden — then set it
  to `""`); leaving it out restores the official-release default.

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

## R2 layout

```
pages/<id>.json   {title, markdown?, html?, createdAt, updatedAt}  (+ customMetadata for listing)
pages/<id>.png    OG image
```

## API contract

The write API the app depends on (all under the endpoint, requires
`Authorization: Bearer <token>`):

```
GET    /api/pages            list shared pages -> { pages: [{ id, title, createdAt, updatedAt }] }
GET    /api/pages/<id>       existence/metadata check
PUT    /api/pages/<id>       body {title, markdown?, html?} -> create/update (at least one version)
PUT    /api/pages/<id>/og    body image/png          -> set OG image
DELETE /api/pages/<id>       stop sharing (remove page + OG image)
```

Plus the public reads a browser hits (no auth): `GET /<id>` (rendered
markdown, or the html rendition when that's all the page has), `GET
/<id>?v=html` (the html rendition, framed), `GET /<id>/raw` (the rendition
verbatim), and `GET /<id>/og.png` (OG image).

## Using a non-Cloudflare / S3 backend

This worker is Cloudflare-specific: it stores objects through the R2 *binding*
API (`env.PAGES.get/put/delete/list`) and renders the public page server-side —
so it won't run on plain S3 as-is. But the app only speaks the small HTTP
contract above, so you can reimplement it on any stack (S3 + Lambda / API
Gateway, a small Node/Go server in front of any object store, …) and point the
app's endpoint at it. R2 also exposes an S3-compatible API if you want to keep
this worker but manage the bucket with S3 tooling.
