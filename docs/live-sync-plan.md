# Live sync — the plan (not built)

Instant updates between devices: a Cloudflare Durable Object rings every
device when something it can see has changed, so devices stop polling on a
clock; presence and leases move onto the same socket. Designed with the
Cloudflare rate-limit work and **deferred by the user on 2026-11-16** until
one of the triggers below holds. Delete this file once it is built, and put
what outlives it into the docs the way every other rule is kept.

The rate limiting that shipped (pacing, allowances, the plan setting, polling
by attention, static public-page files, the daily sweep) is in
`docs/cloud.md`, `docs/cloud-people-agents.md` (*Limits*, *Presence and
leases*) and `cloud-worker/README.md`.

## When to build it

- The Cloud panel's usage line shows polls still take more than a quarter of
  a day's requests;
- live work becomes a product goal (watching an agent write, handing a note
  over instantly);
- the workspace has more than about 15 devices left on.

## What it saves

- Workers Free allows **100,000 requests a day for the whole account**,
  reset 00:00 UTC, shared with every other Worker on it and with public page
  views. Past it, every request gets Cloudflare's 1027 page until the reset.
- Today a device polls by attention (`engine.rs`): every 15 s while someone
  works (`POLL_INTERVAL`), every minute in the background (`POLL_BACKGROUND`),
  every 5 min after 30 idle minutes (`POLL_AWAY`). A Mac left on spends 288 to
  5,760 requests a day.
- After it: tens of Worker requests a day per device (connects, safety
  polls). Durable Objects have their own 100,000 requests a day on Free; a
  device costs them hundreds.

## Decided (the user's, 2026-11-16)

- **Push is Durable Objects with WebSocket hibernation.** Cloudflare Queues:
  no — one consumer per message, pulling needs a Cloudflare API token (the
  app never holds one), 10,000 operations a day on Free, and pulling is
  polling.
- Waking a suspended phone (APNs) is out of scope.

## The design

One `WORKER_VERSION` bump. Polling stays only as the catch-up after a gap and
a slow safety net.

### The object (`cloud-worker/src/live.ts`)

- `export class Live` (SQLite-backed — Free requires `new_sqlite_classes`),
  exported from `index.ts`; one per workspace, `env.LIVE.idFromName("ws")`.
- **Connect**: `GET /api/live` (WebSocket upgrade). The worker authenticates
  (devices only: agents get `403`), reads the person's spaces from D1, moves
  `members.last_seen_at` (at most hourly, the rule the beat has), and forwards
  to the object with `{deviceId, memberId, name, kind, spaces: [id]}`. The
  object `acceptWebSocket(ws, [memberId, deviceId])` and keeps that record
  with `serializeAttachment` (≤ 2 KB: about 150 space ids — enough, but say
  so in the README).
- **Rings** — the worker calls the object (RPC, in `ctx.waitUntil`, one
  subrequest) after:
  - a won `PUT /api/manifest` → everyone;
  - a won space manifest, an agent commit in a space (`commit.ts`) → that
    space's members;
  - spaces made, renamed, deleted, people added or removed → the people
    affected, and their sockets are closed with code `4001` ("connect again")
    so the next connect carries their new spaces;
  - a person removed or a device signed out → those sockets closed with
    `4003`; a wipe → every socket closed.
- A ring is `{"ring": 1}`: no path, no space, no content. The device polls,
  and the poll route keeps every permission rule it has.
- **Presence and leases live here**, in memory plus the object's storage:
  - device → object: `{here: {path?, space?, take?}}` when the edited
    document changes or on a take-over; `{leave: true}` before closing;
  - the object answers each change to the sockets that may see it: a shared
    path → everyone; a path in a space → only sockets whose attachment lists
    it; others see the device with no path (today's poll rule). Outgoing
    messages are free;
  - a lease is claimed by `here` when free, lapsed or this device's, or by
    `take`; one writer, so two Macs can never both hold it;
  - a closed socket leaves presence and frees its leases after 90 s (an
    alarm), so a reconnect doesn't flap;
  - a new socket gets a snapshot of what it may see.
- `setWebSocketAutoResponse` answers the client's `ping` without waking the
  object.

### The poll after it

- `GET /api/poll` → `{manifestEtag, spaces, limits}`: presence and leases
  leave it. `POST /api/poll` is deleted (usage rides `x-doklin-used`).
- D1 `presence` and `leases` go, by the README's schema rules; on the live D1
  the drop is a hand-run once the worker that stops using them is live.

### The engine (`engine/src/cloud/live.rs`)

- A WebSocket client (`tokio-tungstenite` with rustls, matching reqwest's TLS)
  to `wss://<domain>/api/live`, bearer and `x-doklin-device` as on every
  request. A read task feeds the engine task's `select!`: `Ring`, presence and
  lease updates, `Closed(code)`.
- **Rings**: the first is answered with a poll at once; more within 10 s fold
  into one poll at the end of that window. A colleague typing never makes a
  device fetch faster than a working device's poll.
- **Socket down** (offline, refused, `4001`, a deploy): reconnect on the retry
  clock (`BACKOFF`, `engine.rs`); meanwhile poll by attention as today. Every
  connect begins with one poll (catch-up). `4003` is the existing removed
  path.
- **Safety poll**: while connected, a poll every 5 min anyway — a ring is best
  effort (`waitUntil` can fail; the object can be out of its daily requests).
- Presence: `PRESENCE_BEAT`, `beat_due`, `Beat` and the beat-carrying poll are
  deleted; `set_activity` and `take_over` send `here`; `CloudStatus.presence`
  and lease holders come from the socket. Socket down = no lock shown (the
  rule for a failed poll).
- Pings every 30 s; no pong within 10 s = down.

### The iPhone

- The socket lives while the app is active: `settle` sends `leave` and closes
  it; `woke` opens it (both already reach the engine,
  `ios/Doklin/DoklinApp.swift`). Nothing else changes in Swift: screens read
  presence from `CloudStatus` as now.

### Tests, harness, config

- Worker tests: a fake `LIVE` namespace and `WebSocketPair` shim in
  `cloud-worker/test/`; ring routing by member; a removed person's sockets
  closed; presence paths never sent to a socket outside the space.
- Engine tests (`tests.rs`): the in-memory worker gets a bell; a ring makes
  one poll; ten rings in 10 s make two; a dropped socket polls on the clock
  and catches up on reconnect.
- `verify-harness/serve-worker.mjs`: a WebSocket server for `/api/live`
  (`ws` as a dev dependency there) so `drive-ios.mjs` and the Mac drives run
  the real path.
- `wrangler.toml` (update script, setup prompt, example):
  `[[durable_objects.bindings]] name = "LIVE" class_name = "Live"` and
  `[[migrations]] tag = "live-1" new_sqlite_classes = ["Live"]`;
  `verify-harness/cloudprompts.test.mjs` pins them.
- Docs: `docs/cloud.md` (inputs: ring, safety poll), `docs/cloud-people-agents.md`
  *Presence and leases* rewritten, README (`/api/live`, poll shape, D1).

## Rollout on base.aeoxoxo.ai (each step with the user's OK)

1. Ship the app; the phone gets a TestFlight build.
2. `sh doklin-cloud-update.sh https://base.aeoxoxo.ai` — adds `LIVE` and its
   migration.
3. The hand-run drop of D1 `presence` and `leases`.

## Calls I made (unconfirmed)

- Rings carry no content; presence paths are filtered inside the object by
  the space list each socket was opened with, and a change of access closes
  the affected sockets rather than updating them in place.
- A 5-minute safety poll while connected.

## Out of scope

APNs pushes to a suspended phone; counting public page views; a per-person
Cloudflare usage view from Cloudflare's own analytics (needs an account API
token on a device — the app never holds one).
