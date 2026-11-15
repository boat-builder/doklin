// The worker's API version and feature list, in a file of their own so the
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
export const WORKER_VERSION = 15;

// What this build can do, for the app's feature checks. A name here is a
// promise about behaviour, not a version number: "publish" is the promise
// that the public map is served.
export const WORKER_FEATURES: readonly string[] = [
  "sync",
  "wipe",
  "publish",
  "versions",
  "members",
  "roles",
  "spaces",
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
// "roles" is the promise that `/api/meta` says what the caller may do
// (`you.can`), that the People list answers anyone here, and that a removed
// credential is told so. The People view asks for it before it draws: against
// a worker without the name it has no way to know what to offer, and says the
// worker needs updating instead.
// "spaces" is the promise that `/api/spaces` answers, that the poll lists the
// caller's spaces, and that a beat may name the space its document is in.
// "presence" is the promise that `POST /api/poll` carries a beat. Every
// worker has had presence of some kind; before this one it was a route of its
// own, and an app that beats into a worker without the name would be POSTing
// to a poll that answers 405 — so it polls with GET and stays quiet instead.
// "leases" is the promise that a beat's path claims the document and that the
// poll says who holds what. Without it the app opens every document as it
// always has and shows no lock — which is exactly what an older worker can
// honestly offer.
// The five "agent" names are what the `doklin` command line checks before it
// offers a command: "agents" is the login and the People
// view's Agents section; "agent-docs" reading and changing documents;
// "agent-pages" publishing; "agent-comments" threads; "agent-search" the
// mirror and the search over it. They stay separate names so a later worker
// can grow one without the others. A bare
// "d1" is still deliberately absent — that is plumbing, and /api/meta's `d1`
// reports it more precisely than a name in this list could.

// The manifest schema this worker understands.
// A PUT carrying any other version is a 426 in both directions, with a
// sentence naming which side is behind: an app newer than this worker pauses
// in `worker-outdated` until the worker is updated, and an app older than it
// is told to update itself (refuse politely, never
// corrupt). Version 3 is where `by` became a member id; version 4 reserves
// `Private` and `Restricted` at the top of the shared workspace and gives a
// tombstone its `to`.
export const MANIFEST_VERSION = 4;

// The Workers runtime compatibility date wrangler.toml pins — the app writes
// that file verbatim into the setup prompt, so this is its one source.
// Moving it changes runtime behaviour for every new deploy; do it on purpose.
export const COMPATIBILITY_DATE = "2025-05-05";
