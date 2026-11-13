// The worker's API version and feature list, in a file of their own so the
// app's build can read the integer straight out of the source (a virtual
// module in vite.config.ts — docs/cloud.md §7.1) without bundling
// the worker. Keep the declaration on one line in exactly this shape: the
// bundle script and the app parse it with /^export const WORKER_VERSION = (\d+);$/m.
//
// Bump it when the API grows. GET /api/meta reports it, the engine compares
// it with the integer the app was built with, and a worker that is behind
// becomes an "update the worker" state rather than an error. The counter
// starts at 1: nothing older speaks this API, so no version below 1 can
// ever show up.
//
//   1 = the sync API — a workspace bound once per domain, the v2 manifest
//       (files, tombstones, the public map) updated by compare-and-swap,
//       content-addressed blobs, per-file history, presence — plus the meta
//       probe and the owner's wipe. Public pages are not rendered yet: every
//       public path but the landing page and the static assets is a 404.
//   2 = publishing: the public map is served. A published note renders from
//       its synced blob (comments stripped, frontmatter as a properties
//       table, boards and tables derived from the folder's datastore, column
//       widths from the meta sidecar, the html rendition behind the MD/HTML
//       pill), a published folder is a table of contents with Notion-style
//       nested URLs, links between public notes rewrite, the root page
//       serves at /, a static OG image, and renders cache by manifest etag.
//   3 = the version store under versions/: a compare-and-swap index,
//       immutable gzip'd snapshots of the whole workspace and the blobs they
//       reference, plus DELETE on a per-file history archive. Where 1's
//       history is one file's revisions, this is the folder's — what every
//       device keeps locally, mirrored so it outlives the laptop.
//   4 = a D1 database beside the bucket (docs/cloud.md §5.1): the binding,
//       the worker's own migration runner, a schema version reported by
//       /api/meta as `d1`, and a wipe that empties it. Nothing reads or
//       writes a table yet — the bump exists so the update badge lands the
//       plumbing before any feature rides on it, and a worker still running 3
//       has no binding and answers `d1: null`.
//   5 = people (docs/cloud.md §8.1): members keyed by a normalized email,
//       per-device tokens stored as their own sha256, one-time invites, and
//       the /api/auth routes that mint, list and revoke them. A member's
//       bearer now resolves through D1; the owner's is still the env secret
//       and still reads no row, so a database that is gone costs a workspace
//       its people and never its owner.
//   6 = attribution by person (docs/cloud.md §6.6): a manifest's `by` is
//       a member id rather than a device name (MANIFEST_VERSION 3), and
//       /api/meta says who the bearer is and what this workspace's people are
//       called, so any Mac can put a name to an id without being the owner.
//       The three deprecated /api/history/<fid> routes go with it: the
//       manifest has carried no revisions since the version store landed, and
//       what reads them is a release nobody is running.
//   7 = presence in D1, folded into the poll (docs/cloud.md §5.3): a row
//       per device instead of one shared presence.json, written by
//       `POST /api/poll` when the engine has a beat to send and never by a
//       `GET`, which still only reads. Entries carry the member id, so "who
//       else is here" names people. PUT and DELETE /api/presence are gone,
//       and with them the separate beat request and nearly every R2 write an
//       idle workspace made. A revoked device or a removed person leaves
//       presence at once rather than at the end of the TTL.
//   8 = leases (docs/cloud.md §8.2): a beat that names a document claims it
//       — one atomic upsert on a `leases` table keyed by the path, which
//       acquires a free or lapsed lease, renews this Mac's own and refuses
//       anybody else's — and a beat that names another document, or none,
//       lets go. `take` claims it from whoever holds it. The poll answers the
//       live leases beside presence, so every Mac knows within one poll which
//       documents are open elsewhere. Advisory: nothing that writes the
//       manifest reads a lease, and a database that cannot answer costs the
//       warning, never the edit.
//   9 = the public pages wear the app's look (theme.ts): its own tokens,
//       light and pitch-black dark from the reader's preference, the
//       Newsreader serif the app bundles (served at /__web/fonts/), the
//       reading measure, and boards drawn as the app's embed draws them —
//       tinted columns with their stage glyphs, progress, card excerpts and
//       dates. No API change: the bump is how the new look reaches a deployed
//       domain, through the update badge.
//  10 = agents (docs/cloud.md §8.3–8.5): identities that are not people,
//       added by the owner with a set of permissions, logged in by a one-time
//       code, and answered on the document API under /api/agent and nowhere
//       else. There the worker reads and changes the workspace itself — it
//       writes blobs and compare-and-swaps the manifest the way a Mac does —
//       so an agent with no copy of the folder can read, write, move and
//       remove documents, comment on them, publish them and search them. A
//       document is one name with a markdown and an html version; its sidecar
//       never crosses the wire. `/api/meta`'s directory lists agents too, so
//       a Mac can name the `a-` id on what an agent changed. D1 gains the
//       agents' tables and the search mirror.
export const WORKER_VERSION = 10;

// What this build can do, for the app's feature checks. A name here is a
// promise about behaviour, not a version number: "publish" (the public map
// is served) and "boards" (embedded stores render) joined when the renderer
// landed, not before.
export const WORKER_FEATURES: readonly string[] = [
  "sync",
  "wipe",
  "publish",
  "boards",
  "versions",
  "members",
  "presence",
  "leases",
  "agents",
  "agent-docs",
  "agent-pages",
  "agent-comments",
  "agent-search",
];
// "members" is a promise the app can act on: this worker mints and resolves
// per-person tokens, so the People panel has something to talk to.
// "presence" is the promise that `POST /api/poll` carries a beat. Every
// worker has had presence of some kind; before this one it was a route of its
// own, and an app that beats into a worker without the name would be POSTing
// to a poll that answers 405 — so it polls with GET and stays quiet instead.
// "leases" is the promise that a beat's path claims the document and that the
// poll says who holds what. Without it the app opens every document as it
// always has and shows no lock — which is exactly what an older worker can
// honestly offer.
// The five "agent" names are what the `doklin` command line checks before it
// offers a command (docs/cloud.md §8.6): "agents" is the login and the People
// view's Agents section; "agent-docs" reading and changing documents;
// "agent-pages" publishing; "agent-comments" threads; "agent-search" the
// mirror and the search over it. They landed together, and stay separate
// names so a later worker can grow one without the others. A bare
// "d1" is still deliberately absent — that is plumbing, and /api/meta's `d1`
// reports it more precisely than a name in this list could.

// The manifest schema this worker understands (docs/cloud.md §6.6).
// A PUT carrying any other version is a 426 in both directions, with a
// sentence naming which side is behind: an app newer than this worker pauses
// in `worker-outdated` until the worker is updated, and an app older than it
// is told to update itself (docs/cloud.md §5.7 — refuse politely, never
// corrupt). Version 3 is where `by` became a member id.
export const MANIFEST_VERSION = 3;

// The Workers runtime compatibility date wrangler.toml pins — the app writes
// that file verbatim into the setup prompt, so this is its one source.
// Moving it changes runtime behaviour for every new deploy; do it on purpose.
export const COMPATIBILITY_DATE = "2025-05-05";
