// The worker's API version and feature list, in a file of their own so the
// app's build can read the integer straight out of the source (a virtual
// module in vite.config.ts — docs/cloud-redesign.md §7.1) without bundling
// the worker. Keep the declaration on one line in exactly this shape: the
// bundle script and the app parse it with /^export const WORKER_VERSION = (\d+);$/m.
//
// Bump it when the API grows. GET /api/meta reports it, the engine compares
// it with the integer the app was built with, and a worker that is behind
// becomes an "update the worker" state rather than an error. The counter
// restarted at 1 with the one-domain-per-workspace design: nothing older
// speaks this API (new resource names, a new secret name, a new binding), so
// no version below 1 can ever show up.
//
//   1 = the sync API — a workspace bound once per domain, the v2 manifest
//       (files, tombstones, the public map) updated by compare-and-swap,
//       content-addressed blobs, per-file history, presence — plus the meta
//       probe and the owner's wipe. Public pages are not rendered yet: every
//       public path but the landing page and the static assets is a 404.
export const WORKER_VERSION = 1;

// What this build can do, for the app's feature checks. A name here is a
// promise about behaviour, not a version number: "publish" and "boards"
// join the list when the renderer lands (docs/cloud-redesign.md, PR 4).
export const WORKER_FEATURES = ["sync", "wipe"] as const;

// The manifest schema this worker validates and stores. A manifest with a
// higher version comes from a newer app: the worker answers 426 and the
// engine pauses with phase `worker-outdated` until the worker is updated.
export const MANIFEST_VERSION = 2;

// The Workers runtime compatibility date wrangler.toml pins — the app writes
// that file verbatim into the setup prompt, so this is its one source.
// Moving it changes runtime behaviour for every new deploy; do it on purpose.
export const COMPATIBILITY_DATE = "2025-05-05";
