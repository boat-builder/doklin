// The worker's API version, in a file of its own so the
// app's build can read the integer straight out of the source (a virtual
// module in vite.config.ts) without bundling
// the worker. Keep the declaration on one line in exactly this shape: the
// bundle script and the app parse it with /^export const WORKER_VERSION = (\d+);$/m.
//
// Bump it when a deployed domain needs this build: the API grew, or a rule
// or a page's look changed — the update badge is the only way a new worker
// reaches a domain. Once per release, from the number main has. GET /api/meta
// reports it, the engine compares it with the integer the app was built
// with, and a worker that is behind becomes an "update the worker" state
// rather than an error. The counter starts at 1: nothing older speaks this
// API, so no version below 1 can ever show up.
export const WORKER_VERSION = 30;

// The manifest schema this worker understands.
// A PUT carrying any other version is a 426 in both directions, with a
// sentence naming which side is behind: an app newer than this worker pauses
// in `worker-outdated` until the worker is updated, and an app older than it
// is told to update itself (refuse politely, never
// corrupt).
export const MANIFEST_VERSION = 4;

// The Workers runtime compatibility date wrangler.toml pins — the app writes
// that file verbatim into the setup prompt, so this is its one source.
// Moving it changes runtime behaviour for every new deploy; do it on purpose.
export const COMPATIBILITY_DATE = "2025-05-05";
