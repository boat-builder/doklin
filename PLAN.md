# Rate limits — the plan

A working file for this branch, deleted when the last release ships (as the
iPhone app's PLAN.md was). Rules that outlive it go into `docs/cloud.md`,
`docs/cloud-people-agents.md` and `cloud-worker/README.md` with each release.

## The goal

Normal work never notices a limit. An accident — a folder of thousands of
files, a loop, an agent gone wrong — is slowed or held instead of spending the
day. Every device keeps syncing until midnight UTC, on Cloudflare's free plan.

## What we protect

- **Workers Free: 100,000 requests a day for the whole account**, shared with
  every other Worker on it; reset 00:00 UTC. Past it, every request — sync,
  CLI, public pages — gets Cloudflare's 1027 error page until the reset.
- A request the worker refuses with a 429 has already been counted. **Only a
  client that doesn't send protects the budget**; the worker's limits signal
  and catch loops, they cannot shield.
- Durable Objects (release 2) have their own 100,000 requests a day. D1: 5M
  rows read, 100k written a day. R2 Class A/B ops are monthly and billed past
  the free amount, never cut off.

## Decisions (the user's, 2026-11-16 — not to be re-litigated)

1. **Only what Doklin understands syncs: markdown and html documents**, with
   each document's `<stem>.meta.jsonl` (its comments). Images, PDFs and every
   other file stay on their device. (Read from "just html and PDFs are good
   enough" as md + html, since the sentence before skips PDFs — confirm.)
2. **No rule for folders with their own `.git`**: the md + html rule is enough.
3. **No Wi-Fi rule on the phone.** Big transfers are rare with md + html only,
   and people are on the road. iOS needs no permission for mobile data.
4. **Workers Free until it has to change.** The plan is a setting the
   superadmin answers — "Free" or "Workers Paid" — and every number below is
   derived from it.
5. **Push, if any, is Durable Objects with WebSocket hibernation** (release 2).
   Cloudflare Queues: no (one consumer per message, pull needs a Cloudflare API
   token, 10,000 operations a day on Free, and pulling is polling). **Deferred
   (2026-11-16):** release 1 polls by attention instead (1.8); the doorbell is
   built when one of release 2's triggers holds.
6. Releases in this order: guards (with polling by attention) → public pages;
   the doorbell when it's triggered.

## Today (facts, origin/main at 0e0274c)

- Everything syncs, every file type (`scan_local`, `engine/src/cloud/scan.rs:37`);
  the version store and the backup export use the same scan
  (`versions/capture.rs:124`, `versions/workspace.rs:90`, `versions/stores.rs:130`).
- The scan's 5,000-entry budget counts **every** entry, so one cloned repo with
  more than 5,000 files stops sync for the whole workspace with an error.
- **The runaway.** A new file gets a new random id on every attempt
  (`unit.rs:1030`), so its upload lands under a new key; blobs go up one by one
  (`unit.rs:486`) and the manifest is written only at the end; a lost race
  redoes everything, 4 attempts (`unit.rs:502`); the next poll sees the section
  behind (`engine.rs:1508`) and runs the whole push again. Abandoned uploads
  are never collected (GC only knows ids that reached a won manifest,
  `unit.rs:1306`).
- Absence from a manifest without a tombstone is a deletion: `apply_remote`
  trashes the copy (`unit.rs:704`). Anything that leaves a manifest by a rule
  must leave every device's state first.
- Polling every 15 s (`POLL_INTERVAL`, `engine.rs:52`); a presence beat on
  every third poll (`PRESENCE_BEAT`, `engine.rs:65`), which writes D1. A Mac
  left on: 5,760 requests a day. The iPhone polls only while on screen.
- Failures have no backoff: `heard_failure` (`engine.rs:706`) sets a phase; an
  offline-phase poll runs a pass every 15 s (`engine.rs:1527`). Cloudflare's
  1027 page lands in the catch-all (`remote.rs:808`) as `http …: <html…>`.
- The CLI has one request path (`cli/src/http.rs:64`) and no 429 handling.
- Requests counted nowhere; `docs/cloud-people-agents.md` *Limits* says so.

---

## Release 1 — the guards

One `WORKER_VERSION` bump (19 → 20), one D1 schema step (9 → 10),
`MANIFEST_VERSION` stays 4.

**Built 2026-11-16.** The rollout below is done by hand, in order, after the merge.

### 1.1 Only md + html sync

**Engine** (`engine/`)
- `pub fn syncs(rel: &str) -> bool` in `engine/src/lib.rs`, beside
  `is_hidden_or_ignored`: the last segment ends in `.md .markdown .mdown .mkd
  .html` (case-insensitive) or `.meta.jsonl`. Mirrored by the worker's
  `syncs` (`documents.ts`): **change both**, said on both sides.
- `scan_local` takes the rule: a file outside it is invisible. The 5,000 budget
  counts only files that sync; a separate walk cap (100,000 entries visited)
  bounds the local walk and is the only thing that can still say "too large".
- `rel_for_touch` drops paths outside the rule, so the edit bus never wakes the
  engine for them. The survey (`unit.rs:361`) uses the scan, so a `.py` written
  by an agent costs no request: test it.
- The version store follows the same rule (history is what syncs), and so does
  the history export (Versions settings → Export…, `stores.rs:130`): one rule,
  no `Scope` argument. *(recommended 2026-11-16, awaiting the user's OK)*
- **Leaving without deleting**:
  - loading a unit's state forgets every file entry outside the rule (state and
    `base/` only — the disk is never touched);
  - `apply_remote` ignores remote entries outside the rule: never downloaded,
    never a deletion;
  - `build_manifest` drops them — files, tombstones, and `file` public
    entries whose path is outside the rule — so the first write from a new app
    cleans each manifest.
- Version mirror: snapshots captured before the change are mirrored as they
  are (accepted; most are mirrored within the hour anyway).

**Worker** (`cloud-worker/src/`)
- `validateManifest` (`manifest.ts:188`) refuses a file, tombstone or `file`
  public entry outside `syncs`: `400` with a sentence.
- Document API: `pathProblem` (`documents.ts`) refuses any path outside the
  rule — "Doklin syncs markdown and html documents only" — so plain files
  disappear from `tree`, `doc`, `move`. `agentPages.ts:50` `SERVED_AS_FILE`
  becomes html only; publishing a picture or PDF is refused.
- Public routes: a file is served by exact path only if html; a note's
  relative image becomes its alt text (the renderer already does this for an
  unreachable image). `pages.ts:176` loses images and PDFs.
- CLI help text (`cli/src/help.rs`) stops mentioning plain files.

**App**: the sidebar already greys non-documents; their tooltip says "Stays on
this Mac — Doklin syncs markdown and html". The phone only ever holds what
syncs: nothing to draw.

**Tests**: engine — a `.py`, `.png`, `.pdf` never reach the fake worker; a
state holding a `.png` from before forgets it and the file stays on disk; a
remote manifest still listing one never trashes it; a 6,000-file repo with 40
md files syncs the 40. Worker — `validateManifest` and every API path refusal;
public image route gone.

### 1.2 The runaway, fixed

- **Stable ids**: `UnitState.pending_new: BTreeMap<path, fid>`, persisted. A
  path still pending reuses its id on every attempt; cleared when a won CAS
  carries it.
- **Remember uploads**: `UnitState.uploaded: BTreeMap<(fid, hash), at_ms>`,
  persisted; a blob in it is not PUT again. An entry older than 12 h is
  forgotten (GC may take an unreferenced blob after 24 h,
  `GC_MIN_AGE_MS`), and the create-only PUT answers `existed` anyway.
- **Batched commits**: a cycle with more than 50 pushes (the express limit,
  1.3) commits in batches of 100 files or 8 MB. Moves, deletions and public
  ops ride the first batch. Each batch: its blobs, then a CAS with only its
  files. A lost race refetches and re-stages — cheap now.
- **One batch per cycle in bulk mode**, then the cycle ends and the unit is
  owed another; the pacer (1.3) decides when. Pushes are ordered: paths the
  edit bus touched, then edits to known files, then new files, smallest first.
  So a person's own edit never waits behind a bulk job.
- **Downloads too**: in bulk mode `apply_remote` downloads at most one batch
  per cycle and the unit keeps its old etag until everything is applied (the
  next cycle refetches and continues; applied files are already in state).
- Orphans from before: one hand-run on the live bucket (Rollout).

**Tests**: a lost race mid-push re-sends no blob; a push of 1,000 files lands
as 10 CASes with a colleague saving between them; a restart mid-push resumes
with the same ids; a 1,000-file download survives a stop after 300.

### 1.3 Pacing and allowances

- **`engine/src/cloud/pace.rs`**: one `Pacer` per domain, shared by every unit
  of the workspace (sections count together).
  - **Counter**: every request the engine sends counts, at one place
    (`HttpRemote::auth`, `remote.rs:586`), per UTC day, persisted in the
    workspace's state dir so a restart does not reset it.
  - **Express lane**: a cycle with ≤ 50 pushes or downloads, polls, manifest
    reads and writes. Never waits; always counted.
  - **Bulk lane**: blob uploads and downloads past 50, version-mirror uploads,
    GC listing and deletes. Waits on a token bucket (capacity 200, refill
    `bulkPerSecond`).
- **Modes** (`CloudStatus.usage.mode`):
  - `normal`;
  - `bulk-waits` — this device's bulk allowance is spent, or the fleet passed
    its first threshold: bulk resumes after 00:00 UTC; express goes on. When
    the cause is this device's own allowance, its person may lift it for this
    device until 00:00 UTC (see *Lifting the wait*); a fleet cause can't be
    lifted;
  - `slow` — this device passed its ceiling, or the fleet passed its second
    threshold: polls every 60 s, at most one cycle a minute (touches
    coalesce), no bulk, mirror deferred to tomorrow. Edits still go out. Not
    liftable;
  - the 1027 case is a phase, not a mode (1.5).
- **Sentences** (status `message`): "Big changes wait until 05:30 to keep
  inside today's Cloudflare requests" (00:00 UTC in local time); "Sync is
  slower for the rest of today to stay inside Cloudflare's free requests —
  edits still go out, about once a minute".
- **Lifting the wait** — no popup and no system notification; it lives where
  sync state already lives:
  - Mac: the sidebar's sync footer (`SyncStatus.tsx`) turns warn-toned:
    "412 changes wait until 05:30". A click opens the Cloud panel, which says
    "This Mac has sent its share of big changes for today. The rest go out
    after 05:30, so nothing else on this workspace slows down." with
    [Send them now] and a quiet line "About 900 requests · everyone today:
    31,000 of 100,000".
  - iPhone: the sync line (`WorkspaceView.swift`) shows the same words and a
    "Send now" button beside them — where "Review" sits for held deletions —
    opening a confirmation dialog with the same sentence.
  - After the click: "Sending 412 changes…", counting down. The lift holds on
    this device until 00:00 UTC: never asked twice in a day.
  - Fleet cause: the same words, no button; the panel says everyone together
    is near today's limit. The superadmin also sees one line pointing at the
    plan row.
  - Saying "Sync them" to the many-new-documents question (1.4) lifts the
    wait for those documents too: one question, never two.
  - Engine: `cloud_lift_wait {root}`; `CloudStatus.usage.liftable`.
- **Numbers come from the worker** (decision 4): `cloud-worker/src/limits.ts`
  holds the table below, keyed by plan; `/api/meta` and every poll answer
  carry `limits` for the domain's plan. The engine and CLI keep the last
  answer in their state and have no numbers of their own.
- **The plan setting**: D1 `settings (key PK, value)`, key `plan`, values
  `free | paid`, default `free`. `PUT /api/settings/plan {plan}` needs
  `workspace.manage` (the superadmin, `roles.ts`). App: a row in the Cloud
  panel, "Cloudflare plan: Free / Workers Paid", the superadmin's to change,
  read-only to others, with one line on what changes.
- **The fleet** (everyone's spend, roughly):
  - a client adds `x-doklin-used: <requests today>` to a request at most every
    15 min; the worker upserts D1 `usage (who PK, day, requests, at)` in
    `ctx.waitUntil` — `who` = the device id, or the agent token id;
  - the poll answer's `limits.fleetToday` = the sum for today. Public page
    views and other Workers on the account are not in it: the thresholds leave
    that room.
  - A self-reported number can be wrong; it can only make devices slower.

**Contracts**: `CloudStatus.usage {mode, today, fleetToday?, cap?,
resumesAt?}` and `limits` in the poll — `status.rs` ⇄ `src/cloud.ts` ⇄
`Payloads.swift`; `manifest.rs` `PollResponse` ⇄ `presence.ts`. **Change all.**

### 1.4 Ask before many new documents

- After staging, the engine sums new documents across all units of the pass.
  **200 or more** → those new files are held (edits, moves and deletions go
  on), phase `pending-adds`, event `cloud-pending-adds {root, count, folders:
  [{path, count}]}`, command `cloud_confirm_adds`. The same shape as the
  mass-delete valve (`held_deletes`, `cloud_confirm_deletes`); held in memory,
  re-detected after a restart.
- Mac: the banner the pending-deletes phase uses — "212 new documents appeared
  in Projects/foo. Sync them?" [Sync them] [Not now]. "Not now" leaves them on
  this Mac until asked again (next new file in that folder, or Sync now).
- iPhone: the same phase as a notice with the same two answers (rare there: no
  watcher, one write at a time).
- Agents never meet it: their writes are the worker's (`commit.ts`), paced by
  1.6.
- Phase list: `status.rs` ⇄ `src/cloud.ts` ⇄ `Payloads.swift`.

### 1.5 One retry clock

- Every failed pass or poll sets `retry_at = now + backoff(n)`: 15 s, 30 s,
  1 min, 2 min, 5 min, then 10 min, ±20 % jitter; success resets `n`. Polls
  obey it too. A touch during backoff marks dirty and waits for the clock.
- `429` with `Retry-After`: `retry_at = max(backoff, Retry-After)`; phase
  stays what it was, message "The domain asked this Mac to slow down".
- **Cloudflare's daily limit**: a non-JSON body that names error 1027 →
  `RemoteError::DailyLimit` → new phase `limited`, message "Today's Cloudflare
  requests are used up. Sync resumes at 05:30." Nothing is sent until 00:00
  UTC plus a random 0–10 min, except one probe every 30 min (a plan upgrade
  lifts it early). Confirm the page's exact shape when building (status and
  body), from Cloudflare's error docs.
- Phase list again (`limited`): change all three.

### 1.6 The worker's backstop and the CLI

- **Checked 2026-11-16** on the account behind base.aeoxoxo.ai (Free, per the
  user; billing isn't readable through the wrangler login): a throwaway worker
  with `[[ratelimits]]` (wrangler 4.131) deployed and refused requests; it was
  deleted after. The binding is approximate — `limit = 5, period = 10` let 6
  of 10 through per burst, and a second burst right after also got 6 before
  the count settled. That's fine for loop catchers. It is never the budget's
  guard: the engine and CLI are.
- Two bindings, fixed numbers, loop catchers rather than budgets:
  `DEVICE_LIMIT` 600 / 60 s keyed by token id, `AGENT_LIMIT` 120 / 60 s keyed
  by agent token id. Checked in `handleApi` right after `authenticate`
  (`auth.ts:94`). Over → `429 {error: "This device is sending too many
  requests — it will slow down by itself."}` + `Retry-After: 60`.
- The numbers live in the `wrangler.toml` the update script and the setup
  prompt write; `verify-harness/cloudprompts.test.mjs` pins the two to each
  other, as it pins the compatibility date.
- **CLI**: in `send` (`http.rs:64`) — a `429` waits `Retry-After` (≤ 60 s) and
  retries once, then exits; the 1027 page exits at once. New exit code `8`,
  "the domain asked to slow down, or today's Cloudflare requests are used up"
  (the exit codes are a contract: `docs/cloud-people-agents.md` *CLI*).
- **CLI allowance**: the CLI counts its requests per domain per UTC day in
  `~/.config/doklin/usage.json` (0600, beside the credentials) and stops at
  `limits.cliDaily` with exit 8 and a sentence. It sends `x-doklin-used` like a
  device. `limits` reaches it through `GET /api/agent/me` and `login`.

### 1.7 Surfaces

- Mac (`src/`): `SyncStatus` and `CloudPanel` show the modes' sentences, the
  `pending-adds` banner, the `limited` phase; the Cloud panel gets the plan row
  and "This Mac today: 1,240 requests · everyone ≈ 8,900 of 100,000".
- iPhone (`ios/`): the same phases in the sync line and notices; the plan row
  read-only in the workspace's Cloud screen (changing it is the superadmin's,
  from any device of theirs — allowed on the phone too).

### 1.8 Poll by attention *(decided 2026-11-16, in place of release 2 for now)*

- Mac: a window of the workspace focused and active in the last 5 min → poll
  every 15 s; not focused, or idle 5–30 min → 60 s; idle over 30 min → 5 min.
  Focusing a window or an edit polls at once and goes back to 15 s.
- Focus comes from the Mac app's Rust side (Tauri window focus events, mapped
  to the window's workspace) as an engine command, `cloud_set_focus`: no
  frontend change. iPhone: active = focused, from `woke` / `settle`.
- Presence: the beat rides each poll and says how long it holds — `ttl` =
  2.5 × the next poll gap, capped at 15 min — so an idle device stays listed
  as around (not editing) instead of dropping out after 90 s. Worker: the
  presence row gets `until` from the beat. Leases are unchanged: an idle beat
  names no path, so `ACTIVITY_FRESH` already lets go of them.
- A Mac left on overnight: 5,760 requests a day → about 350; a Mac in the
  background all day: about a quarter of today's cost.

### 1.9 Deploy config, docs

- `scripts/doklin-cloud-update.sh:306` and the setup prompt's `wrangler.toml`
  (`src/cloudPrompts.ts:202`) gain the two `[[ratelimits]]` blocks;
  `cloud-worker/wrangler.toml.example` too.
- `docs/cloud.md`: *Engine behaviour* — the scope rule, pacing, batches, the
  two valves, the retry clock, `limited`. `docs/cloud-people-agents.md`
  *Limits* rewritten; exit code 8. `cloud-worker/README.md`: settings route,
  `x-doklin-used`, `usage` and `settings` tables, `limits` in meta and poll,
  429, refusals of non-documents, public routes. `docs/ios.md`: phases.

### 1.10 The contracts, exactly (fixed 2026-11-16 when building)

Every name below is the one the code uses. Parts built in parallel build to
this; a change here changes every side.

**Wire: worker ⇄ engine and CLI**
- `Limits` (JSON), from `cloud-worker/src/limits.ts`, for the domain's plan:
  `{plan: "free"|"paid", cap: number|null, bulkPerSecond: number,
  deviceBulk: number|null, deviceCeiling: number, fleetBulkWaits:
  number|null, fleetSlow: number|null, cliDaily: number, manyNew: number,
  fleetToday: number|null}`. `null` = no such limit (Workers Paid);
  `fleetToday` is `null` when D1 could not answer. The numbers are the table
  in *The numbers*. `deviceBulk` and `deviceCeiling` count **all** of a
  device's requests today, not only bulk ones.
- `limits` is in: `GET /api/meta` when a bearer is signed in (`you` set);
  every `GET`/`POST /api/poll` answer; `GET /api/agent/me`; `POST
  /api/agent/login`'s `201`; `PUT /api/settings/plan`'s answer. When D1 is
  down: the Free numbers, `fleetToday: null`.
- `PUT /api/settings/plan {plan}` → `{limits}`. `workspace.manage` only
  (else 403). D1 `settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`, key
  `plan`, default `free`.
- `x-doklin-used: <integer>` — the caller's requests today (UTC day) on this
  domain. On any authenticated route; the worker upserts D1 `usage (who TEXT
  PRIMARY KEY, day INTEGER NOT NULL, requests INTEGER NOT NULL, at INTEGER
  NOT NULL)` in `ctx.waitUntil`: `who` = the caller's token id (`Auth.tokenId`,
  a device's or an agent machine's), `day` = `floor(now / 86_400_000)`.
  `fleetToday` = `SUM(requests) WHERE day = today`. A malformed header is
  ignored. Clients send it at most every 15 min.
- `POST /api/poll` beat body gains `ttl` (ms): how long the beat holds. The
  worker clamps it to `[PRESENCE_TTL_MS (90 s), 15 min]`, missing = 90 s.
  `presence` gets a column `until INTEGER NOT NULL`, = now + ttl; reads and
  sweeps use `until` instead of `ts + PRESENCE_TTL_MS`. A lease's `until` is
  the same now + ttl.
- `429` from the worker: `{error: "This device is sending too many requests
  — it will slow down by itself."}` + `Retry-After: 60`. Bindings
  `DEVICE_LIMIT` (600 / 60 s, key = token id, people) and `AGENT_LIMIT`
  (120 / 60 s, key = token id, agents), checked right after `authenticate`;
  a binding the env lacks is not checked (tests, the harness).
- Cloudflare's daily limit (error 1027): status not documented, so it is
  recognised by the body — not JSON, and contains `1027` (`error code: 1027`
  / `Error 1027`). Engine: `RemoteError::DailyLimit`; CLI: exit 8.
- D1 schema 9 → 10 adds `settings`, `usage`, `presence.until`.
  `WORKER_VERSION` 19 → 20.
- Out of scope is refused: a manifest `PUT` whose files, tombstones or
  `file` public entries name a path outside `syncs` → `400`; the document
  API has no plain files any more (`tree` answers `{dir, folders,
  documents}`); the worker's own commits (`commit.ts`) drop out-of-scope
  entries from the manifest they write, as the engine does.

**Engine ⇄ apps** (`status.rs` ⇄ `src/cloud.ts` ⇄ `Payloads.swift`)
- Phases gain `pending-adds` and `limited`:
  `idle syncing offline paused pending-deletes pending-adds revoked
  worker-outdated limited error`.
- `CloudStatus.pendingAdds: number` — new documents held by the valve.
- `CloudStatus.usage`:
  `{mode: "normal"|"bulk-waits"|"slow", cause: "device"|"fleet"|null,
  today: number, fleetToday: number|null, cap: number|null, plan:
  "free"|"paid"|null, resumesAt: number|null, waiting: number, liftable:
  boolean, lifted: boolean}`. `today` = this device's requests today on this
  domain; `resumesAt` (epoch ms, the next 00:00 UTC) is set when the mode is
  not `normal` or the phase is `limited`; `waiting` = changes held back
  (uploads not sent + downloads owed); `liftable` = the cause is this
  device's own allowance and it was not lifted today; `plan` is `null` until
  the domain has said.
- Event `cloud-pending-adds {root, count, folders: [{path, count}]}` (folders
  workspace-relative, most first, at most 5).
- Commands (engine `cloud/mod.rs`, an arm in `command.rs`, a Tauri wrapper
  in `src-tauri/src/cloud.rs` for the first three, wrapped in `src/cloud.ts`):
  `cloud_confirm_adds {root, sync: bool}` (false = "Not now"),
  `cloud_lift_wait {root}`, `cloud_set_plan {root, plan: "free"|"paid"}`,
  `cloud_set_focus {window, folder: string|null, focused: bool}` — the Mac
  calls it from Rust on window focus; the iPhone from `woke`/`settle` with
  window `"main"` and the open workspace's root.
- Sentences the engine puts in `error` for its own phases: `limited` —
  "Today's Cloudflare requests are used up. Sync resumes at 05:30."; a 429
  leaves the phase and says "The domain asked this Mac to slow down." Mode
  sentences are the surfaces' own, from `usage`.

**CLI**: exit code `8`; `~/.config/doklin/usage.json` (0600) `{"<domain>":
{day, requests, reportedAt, limits}}`; never sends `x-doklin-used` on a
`login` route (that request holds a token being replaced or revoked).

---

## Release 2 — the doorbell

**Deferred (the user's decision, 2026-11-16).** Release 1 ships 1.8 instead.
Build this when one of these holds:
- release 1's counters show polls are still over a quarter of a day's
  requests;
- live work is a product goal (watching an agent write, handing a note over
  instantly);
- the workspace has more than about 15 devices left on.

The design below stays ready for then.

`WORKER_VERSION` 20 → 21. A Durable Object class rings devices when something
they can see has changed; presence and leases move onto the socket. Polling
stays only as the catch-up after a gap and a slow safety net.

### 2.1 The object (`cloud-worker/src/live.ts`)

- `export class Live` (SQLite-backed — Free requires `new_sqlite_classes`),
  exported from `index.ts`; one per workspace, `env.LIVE.idFromName("ws")`.
- **Connect**: `GET /api/live` (WebSocket upgrade). The worker authenticates
  (devices only: agents get `403`), reads the person's spaces from D1, moves
  `members.last_seen_at` (at most hourly, the rule the beat had), and forwards
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
  - a closed socket leaves presence and frees its leases after 90 s (an alarm),
    so a reconnect doesn't flap;
  - a new socket gets a snapshot of what it may see.
- `setWebSocketAutoResponse` answers the client's `ping` without waking the
  object.

### 2.2 The poll after it

- `GET /api/poll` → `{manifestEtag, spaces, limits}`: presence and leases
  leave it. `POST /api/poll` is deleted (usage rides `x-doklin-used`).
- D1 `presence` and `leases` go, by the README's schema rules; on the live D1
  the drop is a hand-run after v21 is live, as with boards.

### 2.3 The engine (`engine/src/cloud/live.rs`)

- A WebSocket client (`tokio-tungstenite` with rustls, matching reqwest's TLS)
  to `wss://<domain>/api/live`, bearer and `x-doklin-device` as on every
  request. A read task feeds the engine task's `select!`: `Ring`, presence and
  lease updates, `Closed(code)`.
- **Rings**: the first is answered with a poll at once; more within 10 s fold
  into one poll at the end of that window. A colleague typing never makes a
  device fetch faster than today's poll.
- **Socket down** (offline, refused, `4001`, a deploy): reconnect on the retry
  clock (1.5); meanwhile poll every `POLL_INTERVAL`. Every connect begins with
  one poll (catch-up). `4003` is the existing removed path.
- **Safety poll**: while connected, a poll every 5 min anyway — a ring is best
  effort (`waitUntil` can fail; the object can be out of its daily requests).
- Presence: `PRESENCE_BEAT`, `beat_due`, `Beat` and the beat-carrying poll are
  deleted; `set_activity` and `take_over` send `here`; `CloudStatus.presence`
  and lease holders come from the socket. Socket down = no lock shown (today's
  rule for a failed poll).
- Pings every 30 s; no pong within 10 s = down.

### 2.4 The iPhone

- The socket lives while the app is active: `settle` sends `leave` and closes
  it; `woke` opens it (both already reach the engine,
  `ios/Doklin/DoklinApp.swift`). Nothing else changes in Swift: screens read
  presence from `CloudStatus` as now. Waking a suspended phone (APNs) is out of
  scope.

### 2.5 Tests, harness, config

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
  `[[migrations]] tag = "live-1" new_sqlite_classes = ["Live"]`; the test pins
  them.
- Docs: `docs/cloud.md` (inputs: ring, safety poll), `docs/cloud-people-agents.md`
  *Presence and leases* rewritten, README (`/api/live`, poll shape, D1).

**Cost after it**: a device left on spends tens of Worker requests on a quiet
day (connects, safety polls) instead of 5,760; Durable Object requests stay in
the hundreds per device.

---

## Release 3 — public pages *(built 2026-11-16, on `claude/rate-limits-release-3`)*

- Fonts, mermaid, `og.png`, `favicon.ico`, `apple-touch-icon.png`,
  `robots.txt` are **static assets** (`[assets] directory =
  "doklin-cloud-web"` in `wrangler.toml`): Cloudflare serves them without
  invoking the worker, so they cost nothing. A page view is one request. Their
  headers come from `cloud-worker/web/_headers` (no path matches two
  Cache-Control rules: Cloudflare would join them). An asset path that reaches
  the worker is a 404 without a bucket read.
- `scripts/bundle-worker.mjs` writes `doklin-cloud-web/` beside the worker
  (paths as before; the mermaid module content-tagged), and the worker
  itself drops to 85 KB gzipped. The release ships
  `doklin-cloud-web.tar.gz` beside `doklin-cloud-worker.js`; the update script
  and the setup prompt fetch and unpack it. `og.png` is a file in
  `cloud-worker/web/`; the icons are copied from `public/`, the fonts from
  `src/assets/fonts/`. The worker keeps only the tag (`assets.ts`,
  `WEB_TAG`), which also rides in the render cache's key, so a deploy that
  changes the module serves no cached page asking for a gone one.
- `cloud-worker/test/assets.mjs` plays Cloudflare's asset layer in front of a
  bundle (`run.mjs --bundle`, `serve-worker.mjs`).
- `WORKER_VERSION` 20 → 21 (release 2 being deferred). PR #133 also takes 21:
  whichever merges second moves to 22.
- Workers Paid stays the superadmin's call; the plan setting (1.3) is where it
  takes effect.

### 3.1 Left over from release 1 (the user's call, 2026-11-16: done with this release)

- **Uploads no manifest names.** *(Done, as a lasting sweep — the user's
  call, 2026-11-16: the bucket is small, but clean.)* Reading the app's own
  collector showed more than the runaway: a deleted file's copies were never
  collected (deletions never fed it), a version replaced less than a day
  before its round stayed for good, and a Mac that quit before its round
  forgot its list. So the worker sweeps once a day (`cloud-worker/src/sweep.ts`,
  a cron trigger): every `blobs/` copy, in every section, that its manifest
  doesn't name and that is more than a day old. The app's collector, and the
  routes it used (`GET /api/blobs/<fid>`, `DELETE /api/blobs/<fid>/<hash>`),
  are gone — no device deletes a copy. A re-upload of a copy's own bytes
  stores it again, so a file back to an old version restarts its day.
- **The Mac footer's wording is cut off.** *(Done.)* The footer says
  "412 held until 5:30 AM" (`heldWords`, `src/cloud.ts`); the tooltip and the
  panel keep "412 changes wait until 5:30 AM". The iPhone's sync line spans
  the screen and keeps the whole words. `drive-limits.mjs` checks the footer
  fits at the default width, 12,400 included.

---

## The numbers (`cloud-worker/src/limits.ts`, the one source)

| | Free | Workers Paid |
| --- | --- | --- |
| Account's daily requests (`cap`) | 100,000, reset 00:00 UTC | none (10M a month included) |
| Express lane | ≤ 50 files a cycle | ≤ 50 |
| Batch | 100 files or 8 MB | same |
| `bulkPerSecond` | 4 | 20 |
| Device bulk allowance a day | 10,000 | none |
| Device ceiling a day → `slow` | 15,000 | 200,000 |
| Fleet → `bulk-waits` everywhere | 60,000 | none |
| Fleet → `slow` everywhere | 85,000 | none |
| `cliDaily` per agent machine | 5,000 | 50,000 |
| Many new documents | 200 in one pass | 200 |
| Worker loop catchers (`wrangler.toml`) | 600/min a device, 120/min an agent | same |

Engine mechanics that are not budgets — batch size, the express limit, the
backoff ladder, ring coalescing — stay engine constants.

## Rollout on base.aeoxoxo.ai (each step with the user's OK)

**Release 1**
1. (Done 2026-11-16: the `[[ratelimits]]` check, 1.6.)
2. Ship the app; the phone gets a TestFlight build. **Every device updates
   before the worker**: a new app pauses as `worker-outdated` until then, while
   an old app reading a manifest that dropped a `.png` would trash its copy
   (the phone: outright).
3. `sh doklin-cloud-update.sh https://base.aeoxoxo.ai` — writes the new
   bindings, runs D1 step 10.
4. Hand-runs: list `blobs/<fid>/` and `spaces/*/blobs/<fid>/` for ids no
   manifest names and delete them (the runaway's orphans and the dropped
   files'); list public entries pointing at pictures or PDFs and remove them.
5. The plan row reads Free.

**Release 2**: app and TestFlight first, then the update (adds `LIVE` and its
migration), then the hand-run drop of `presence` and `leases`.

**Release 3**: the app ships as usual (an app built for 21 keeps syncing
with worker 20 and shows the update badge, so the order doesn't matter), then
the update (fetches the worker and `doklin-cloud-web.tar.gz`, declares the
daily trigger), then a look at a public page: fonts, a diagram, the icon. The
phone needs no TestFlight build for this: its old engine still calls the two
removed routes now and then, which fail quietly. Its next build drops them.

## Calls I made (unconfirmed)

- Comment sidecars (`.meta.jsonl`) sync with their documents — without them a
  note's comments would stay on one device.
- A device can lift its own bulk wait for the day; nobody can lift a fleet
  cause.
- The usage report rides a header every 15 min rather than a route; agents are
  in the fleet sum through the CLI; public views are not counted anywhere.
- Rings carry no content; presence paths are filtered inside the object by
  the space list each socket was opened with, and a change of access closes
  the affected sockets rather than updating them in place.
- A 5-minute safety poll while connected.

## Out of scope

APNs pushes to a suspended phone; counting public page views; a per-person
Cloudflare usage view from Cloudflare's own analytics (needs an account API
token on a device — the app never holds one).
