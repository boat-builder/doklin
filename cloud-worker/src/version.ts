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
//   4 = a D1 database beside the bucket (docs/teams-plan.md §8): the binding,
//       the worker's own migration runner, a schema version reported by
//       /api/meta as `d1`, and a wipe that empties it. Nothing reads or
//       writes a table yet — the bump exists so the update badge lands the
//       plumbing before any feature rides on it, and a worker still running 3
//       has no binding and answers `d1: null`.
//   5 = people (docs/teams-plan.md §9): members keyed by a normalized email,
//       per-device tokens stored as their own sha256, one-time invites, and
//       the /api/auth routes that mint, list and revoke them. A member's
//       bearer now resolves through D1; the owner's is still the env secret
//       and still reads no row, so a database that is gone costs a workspace
//       its people and never its owner.
//   6 = attribution by person (docs/teams-plan.md §12): a manifest's `by` is
//       a member id rather than a device name (MANIFEST_VERSION 3), and
//       /api/meta says who the bearer is and what this workspace's people are
//       called, so any Mac can put a name to an id without being the owner.
//       The three deprecated /api/history/<fid> routes go with it: the
//       manifest has carried no revisions since the version store landed, and
//       what reads them is a release nobody is running.
export const WORKER_VERSION = 6;

// What this build can do, for the app's feature checks. A name here is a
// promise about behaviour, not a version number: "publish" (the public map
// is served) and "boards" (embedded stores render) joined when the renderer
// landed, not before.
export const WORKER_FEATURES: readonly string[] = ["sync", "wipe", "publish", "boards", "versions", "members"];
// "members" is a promise the app can act on: this worker mints and resolves
// per-person tokens, so the People panel has something to talk to. A bare
// "d1" is still deliberately absent — that is plumbing, and /api/meta's `d1`
// reports it more precisely than a name in this list could.

// The manifest schema this worker understands (docs/cloud.md §6.6).
// A PUT carrying any other version is a 426 in both directions, with a
// sentence naming which side is behind: an app newer than this worker pauses
// in `worker-outdated` until the worker is updated, and an app older than it
// is told to update itself (docs/teams-plan.md §2 — refuse politely, never
// corrupt). Version 3 is where `by` became a member id.
export const MANIFEST_VERSION = 3;

// The Workers runtime compatibility date wrangler.toml pins — the app writes
// that file verbatim into the setup prompt, so this is its one source.
// Moving it changes runtime behaviour for every new deploy; do it on purpose.
export const COMPATIBILITY_DATE = "2025-05-05";
