# Teams — people, presence and locking: the implementation plan

[cloud.md](cloud.md) §11 lists what a workspace shared with *people* runs
into. This document closes three of those blockers and plans the build:

- **§11.1 — there is one credential, so there are no people.** A member
  keyed by their email, permanent, outliving every machine and token they
  ever use.
- **§11.2 — the idle heartbeat is the free plan's real budget.** The
  presence beat stops being its own request and stops being an R2 write.
- **§11.7 — two people on one file find out afterwards.** §8.2's leases,
  in a store that can actually hold a lock.

The store for all three is **D1**, added to the deployment alongside R2.
§3 is the design, §4 is what D1 costs the setup and update story and how
each piece pays it, §5 is the free-plan arithmetic, and §7 onward is the
phased build — **eight phases, every one of them deployable on its own,
several with nothing for the user to see.**

Read [cloud.md](cloud.md) §5.2–5.5 (the bucket, the API, the auth gate),
§6.4–6.8 (the engine's cycle and flows), §8.1–8.2 (the shapes this
replaces) and §11 (the blockers) first.

## 0. How to use this document

- **One phase per branch and pull request.** A phase's *Done when* list is
  the merge gate. Do not start the next phase's work in the same branch.
- **Every phase deploys on its own.** A phase either ships a user-visible
  change or ships none at all — but it is always complete, releasable, and
  correct standing alone. Phases 1, 5, 6 and 8 are invisible by design;
  that is the point, not a shortfall. Every push to `main` cuts a release
  ([release-pipeline.md](release-pipeline.md)), so "releasable" is literal.
- **The update order never varies:** the app updates itself
  ([auto-update.md](auto-update.md)), then tells you the worker is behind,
  then you run the script of §7.2. Every phase that changes the wire bumps
  `WORKER_VERSION`, so a skewed pair says so instead of misbehaving (§2).
- Match the house style: a module opens with a comment saying what it is
  and which doc section it serves; a contract mirrored in Rust and
  TypeScript says "change both" on both sides; a number with one source is
  parsed from it, never retyped; user-facing errors are sentences; the
  frontend never `fetch`es.
- When a phase changes what [cloud.md](cloud.md) describes, update it in
  the same PR (an *as built* note under the section), and update
  `.claude/skills/verify/SKILL.md` with what the new suites walk.

## 1. What this builds

**A person is not a token.** §8.1 conflated them: an invite minted a token,
and the token was the whole record of who had access. That leaves the real
questions unanswerable — *who has access?*, *is this the same Alice?*, *she
lost her Mac, give her back what she had.*

Three records, three lifetimes:

| Record | Key | Lifetime | Holds |
| --- | --- | --- | --- |
| **Member** | normalized email | permanent | who this person is |
| **Token** | `sha256(token)` | one device, until revoked | the credential |
| **Invite** | `sha256(code)` | until redeemed or expired | a pending token |

A member is found by their email, so **re-inviting the same address reaches
the same person**. A lost Mac is: revoke that person's tokens, mint a new
invite for the same email, and the same member picks up a new token.
Everything that points at a `memberId` — a revision's author, a presence
entry, a lease — keeps pointing at the same person across every machine
they ever use.

The credential is a **capability**: 100 bits of randomness, one-time use,
carrying no identity of its own. The email is the identity and never the
secret; the code is the secret and never the identity.

## 2. The compatibility rule

**No released app and no deployed worker has to keep working.** That is
decided, and it is what makes this plan small. What replaces it is a
narrower promise:

> A skewed app and worker must **refuse politely**, never corrupt.

The machinery for that already exists and every phase uses it: the app
compares `GET /api/meta`'s `version` against the integer it was built with
and pauses in `Phase::WorkerOutdated` when the worker is behind, and the
worker answers `426` to a manifest schema it predates
(`cloud-worker/src/version.ts`, `src-tauri/src/cloud/status.rs:34`).

What the rule buys, immediately:

- **The three deprecated `/api/history/<fid>` routes go.** They exist only
  for an app on an older release ([cloud.md](cloud.md) §5.3).
- **`hist` leaves the manifest**, and `MANIFEST_VERSION` goes to 3.
  ([versioning.md](versioning.md) §6.5 wanted this; only compatibility was
  holding it.)
- **`by` becomes a member id outright** — no parallel `byId` field, no
  worrying whether an older app round-trips it. The Rust `ManifestFile`
  struct (`src-tauri/src/cloud/manifest.rs:88`) drops unknown fields on
  deserialize, which would have made a shim leaky; nothing needs one now.
- **`presence.json` and `PUT`/`DELETE /api/presence` simply disappear**
  when presence moves (phase 6), rather than lingering as dead routes.
- **`x-base-etag` can become `x-base-seq`** (phase 8) instead of both
  existing.

What the rule does **not** buy: skipping the version bumps. A user who
updates the app before running the worker script is a *normal Tuesday*, not
a broken install, and each phase must land on the right side of it.

## 3. The design

### 3.1 The invite code — a capability, not a passphrase

§8.1's `amber-canyon-lantern-42` is about 31 bits. A redeemed invite yields
a member token, and a member token is not a limited account (§8.1:
`PUT /api/manifest` is not role-gated), so **the code is a full read/write
credential for the workspace**. Beside a 256-bit owner token
(`src-tauri/src/cloud/scan.rs:223`) that is the weakest link by a factor of
2²²⁵ — and it buys memorability the design never uses, because §8.1 shares
the code over Slack or iMessage, not aloud.

**100 bits, Crockford base32, minted by the app:**

```
dkln-K7QM2-9XVR4-8TBHN-3WGYD        20 chars = 100 bits
```

Crockford's alphabet drops I/L/O/U and is case-insensitive, so a mistyped
or autocorrected code either normalizes to the right one or fails cleanly.
The `dkln-` prefix is self-identifying: the app validates the shape before
touching the network, and a leaked code is greppable.

This is what makes §8.1's "nothing throttles it" a non-problem: at 100 bits
**guessing is off the table**, and the attempt cap, the lockout and the
store to count them all disappear. Entropy is free; a counter is not. If a
flood guard is ever wanted, the [Workers rate limiting
binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
needs no resource to create — its `namespace_id` is a chosen integer — so
it flows through §7.2's update with nothing to provision.

The email is **not** in the code's key. §8.1's `sha256(email + code)` made
the invitee retype a string byte-identically to how the owner typed it for
approximately zero real bits. The invite is keyed by `sha256(code)` and
names its member in a column.

**No password, now or later.** The invite code *is* a magic link — one-time,
high-entropy, expiring, addressed to an email — differing only in delivery.
A second Mac already needs nobody: `cloud_token` returns `{endpoint, token}`
(`src/cloud.ts:134`) and the panel already shows it. A password would be
typed once, at redeem, where the code has already authenticated the caller;
it would need a KDF, a login route and recovery-without-email, and it would
**reintroduce the guessing problem the 100-bit code just removed**.

### 3.2 The owner keeps a credential that D1 cannot break

`OWNER_TOKEN` stays the worker's env secret, compared in constant time with
no database read (`cloud-worker/src/auth.ts:63`). That is deliberate: **a D1
outage must never lock the owner out of their own workspace.** The owner
still gets a member row, for attribution and for the People list, but it is
never what authenticates them.

Every phase below states its D1 failure posture, and the rule is the same
one: D1 carries *people, presence and leases*; R2 carries *the workspace*.
Losing D1 degrades a team workspace to what it is today — one credential,
no presence, no locks — and never loses a byte.

### 3.3 Presence — folded into the poll

Today a connected device makes two kinds of idle request: `GET /api/poll`
every 15 s (`POLL_INTERVAL`, `engine.rs:60`) and `PUT /api/presence` on a
25 s cadence tested on the poll tick (`PRESENCE_BEAT`, `engine.rs:70`), so
in practice every 30 s. That is six requests a minute per device with
nobody typing, and the presence write is an R2 `put` of one shared object —
86% of the free Class A budget at ten always-on Macs (§11.2).

It is also, quietly, **a lost update**: `presence()`
(`cloud-worker/src/api.ts:335`) reads that object, mutates it and writes it
back with no CAS. Two beats landing together and one vanishes.

The fix is one idea: **the beat rides the poll.**

- `GET /api/poll` becomes `POST /api/poll` with an optional body
  `{path?}` — "I am here, editing *path*".
- The engine keeps the cadence logic it already has (`presence_tick`,
  `engine.rs:1639`: due on the beat interval *or* the moment the edited
  path changes) and simply attaches the beat to the next poll instead of
  making its own request. `PRESENCE_BEAT` goes 25 s → 45 s, still well
  inside the 90 s TTL (`PRESENCE_TTL_MS`, `layout.ts:78`).
- The worker writes a presence row only when the poll carries a body, so
  the client decides when a write happens and an idle poll writes nothing.

**28,800 requests a day disappear**, R2 Class A goes to approximately zero,
and the lost update goes with it — a row per device, upserted, is atomic by
itself.

### 3.4 Leases

A lease is §8.2's shape, in a table: `{path, deviceId, memberId, name,
until}`. Acquired when a document gains editing focus, renewed on the poll,
released on blur or close, and lapsed when it stops being renewed.

**Advisory, always.** A lease never gates `PUT /api/manifest`. It changes
what the *editor* does — opens read-only with "Alice is editing — view
only" and a *Take over* — and the three-way merge stays exactly as it is
for the window a lease cannot cover. A lock that could wedge a workspace
would be worse than no lock; §11.7 is a UX floor, not a correctness one.

Acquiring is one atomic statement — free if nobody holds it, free if it
lapsed, free if it is already yours, refused otherwise:

```sql
INSERT INTO leases (path, device_id, member_id, name, until)
VALUES (?path, ?device, ?member, ?name, ?until)
ON CONFLICT(path) DO UPDATE SET
  device_id = excluded.device_id, member_id = excluded.member_id,
  name      = excluded.name,      until     = excluded.until
WHERE leases.device_id = excluded.device_id OR leases.until <= ?now;
```

`changes == 1` means you hold it; `0` means someone else does, and the
follow-up `SELECT` says who. *Take over* is the same statement once `until`
has passed. Renewal is `UPDATE … WHERE path = ? AND device_id = ?` and
rides the poll; release is the matching `DELETE`. **No reaper**: every read
filters `until > ?now`, and any write may opportunistically
`DELETE FROM leases WHERE until <= ?now`.

Lease TTL is 45 s, renewed on the 15 s poll: two missed polls and it lapses.

### 3.5 The schema

One database per workspace, named for the worker. Written by the worker
itself (§4.3), never by `wrangler d1 migrations`.

```sql
CREATE TABLE meta (              -- one row; the migration runner's anchor
  key            TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL
);

CREATE TABLE members (
  id           TEXT PRIMARY KEY,          -- m-xxxxxxxx
  email        TEXT NOT NULL UNIQUE,      -- normalized: trimmed, lowercased
  name         TEXT NOT NULL,
  role         TEXT NOT NULL,             -- 'owner' | 'member'
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER,
  disabled     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE tokens (
  hash        TEXT PRIMARY KEY,           -- sha256(token) — the auth lookup
  id          TEXT NOT NULL,              -- t-xxxxxxxx, what revocation names
  member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  device_id   TEXT,
  device_name TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX tokens_by_member ON tokens(member_id);

CREATE TABLE invites (
  hash       TEXT PRIMARY KEY,            -- sha256(code) — never the plaintext
  id         TEXT NOT NULL,
  member_id  TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE presence (
  device_id   TEXT PRIMARY KEY,
  member_id   TEXT NOT NULL,
  device_name TEXT NOT NULL,
  path        TEXT,
  ts          INTEGER NOT NULL
);

CREATE TABLE leases (
  path      TEXT PRIMARY KEY,             -- lowercased workspace-relative path
  device_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  name      TEXT NOT NULL,                -- display name, denormalized
  until     INTEGER NOT NULL
);

CREATE TABLE workspace (                  -- phase 8 only
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  manifest_hash TEXT,
  seq           INTEGER NOT NULL DEFAULT 0
);
```

Two denormalizations, both deliberate: `tokens` carries `device_name` and
`leases` carries `name`, so authenticating and reading a lease each stay a
single-row lookup. A member rename rewrites that person's rows — rare, and
bounded by their device count.

**No read replicas.** D1's Sessions API trades strong consistency for
replica reads; a lease acquire cannot afford that. The database stays
single-primary.

## 4. D1 in the deployment story

This is the real cost of choosing D1 over a Durable Object, and it is
concentrated in one place: `wrangler.toml` is written **verbatim** by the
app (`src/cloudPrompts.ts:121`) and **regenerated from scratch** by the
update script (`scripts/doklin-cloud-update.sh:253`). A D1 binding needs a
per-deployment `database_id` that neither of them knows. Three answers,
one per surface.

### 4.1 Setup — the agent captures it

`buildSetupPrompt` gains a step between the bucket and the secret:

```
npx -y wrangler@4 d1 create doklin-notes-example-com
```

Wrangler prints the `database_id`; the agent writes it into `wrangler.toml`
beside the `account_id` it already captures from `whoami`. It is the same
*kind* of fill-in the prompt already handles, with the same guard rail: the
prompt requires `wrangler d1 list` to show the database before deploying,
and forbids inventing a name.

### 4.2 Update — the script discovers it

The script already derives the bucket name from the endpoint, confirms it
with `wrangler r2 bucket list`, and falls back to asking (or to a
`BUCKET_NAME=` override when there is no terminal). The D1 id gets the
identical treatment: derive the name, `wrangler d1 list --json`, match,
read the uuid, with a `D1_NAME=` override and the same
never-deploy-on-a-guess precondition — a wrong name would point the worker
at someone else's database.

With one exception, which is the whole reason phase 1 exists: the database
is the one resource that may legitimately be missing. Every domain set up
before this lands has none, and the update is the only route by which it
gets one. So a miss under the *conventional* name is created rather than
refused — an empty D1 database, free, holding nothing until people are
invited — while a name given by hand with `D1_NAME=` is a pointer at
something that already exists, so a miss there is a typo and stops the
script. That makes the update script the one place that creates a
Cloudflare resource, and its header says so.

### 4.3 Migrations — the worker owns its schema

The update ships **one bundled JS file and no migrations directory**, so
`wrangler d1 migrations apply` is not available to it. The worker therefore
migrates itself: a `schema.ts` with an ordered list of steps, a
`schema_version` in `meta`, and a check that runs at most once per isolate
(a module-level flag, flipped after a successful run — the flag only ever
goes false → true, so a stale one costs one extra query, never a wrong
answer).

`CREATE TABLE IF NOT EXISTS` is idempotent, so two isolates racing the
first migration converge. A step that moves *data* guards itself with a
conditional bump — `UPDATE meta SET schema_version = ?next WHERE key =
'schema' AND schema_version = ?prev` — and only proceeds when `changes ==
1`.

### 4.4 Wipe and teardown

- `POST /api/admin/wipe` empties the D1 tables as well as the bucket, then
  re-runs the schema. Otherwise a rebound domain inherits ghost members.
- `buildTeardownPrompt` gains `wrangler d1 delete`, after the worker and
  before the bucket, with the same confirm-the-name discipline.

## 5. What it costs on the free plan

Ten Macs, app left open all day — §11.2's worst case, which is the one that
matters.

| Budget | Free | Today | After phase 6 | After phase 8 |
| --- | --- | --- | --- | --- |
| Workers requests | 100 k/day | 86,400 — **86%** | 57,600 — 58% | 57,600 — 58% |
| R2 Class A (writes) | 1 M/month | 864 k — **86%** | ~0 | ~0 |
| R2 Class B (reads) | 10 M/month | 3.5 M — 35% | 1.7 M — 17% | ~0 |
| D1 rows read | 5 M/day | — | ~900 k — 18% | ~950 k — 19% |
| D1 rows written | 100 k/day | — | ~24 k — 24% | ~25 k — 25% |

The presence write is 10 devices × (86,400 / 45 s) ≈ 19,200 rows a day;
lease renewals only happen while someone is editing and only when the lease
is past half its life. Reads are dominated by the poll: one workspace row,
about ten presence rows and a handful of leases, 57,600 times.

Note what does **not** move: **Workers requests stay the binding
constraint**, because they are set by the poll interval, and phase 6 fixes
them only by deleting the separate beat. Halving them again means a longer
poll (latency) or a push model (a much larger change). 58% of the free plan
for ten always-on Macs is comfortable; that is the honest ceiling this plan
reaches.

Also note that D1's free daily limits are now **enforced** — since
1 September 2026, queries past them fail rather than degrade — so the 24%
write figure is a number to keep an eye on, not a soft target. It is the
reason presence writes are client-gated (§3.3) rather than issued on every
poll: writing on every poll would be 57,600 rows a day, 58% of the write
budget, for no extra freshness.

## 6. Decisions this plan makes

1. **A member is found by normalized email** — trimmed, lowercased —
   through a `UNIQUE` column. One normalization function, mirrored in Rust
   and TypeScript, tested on both sides.
2. **Ids are short and stable**: `m-` and `t-` plus 8 hex characters. The
   member id is what the manifest, presence and leases carry; an email
   never enters the manifest.
3. **The worker never sees a plaintext code.** The app mints it and sends
   `sha256(code)`, exactly as it mints the owner token today.
4. **`POST /api/auth/join` is the only route above the `authenticate`
   gate** (`cloud-worker/src/api.ts:74`), matched on method **and** path
   exactly. Every other `/api/auth/*` route is owner-only and inside it.
5. **Revocation names a token id, not a hash.** The owner never holds the
   token, so `GET /api/auth/tokens` returns `{id, memberId, deviceName}`
   and `DELETE /api/auth/tokens/<id>` finds the row by `id`.
6. **Invites are one-time and expire at redeem.** The row is deleted on
   success and on discovering it has expired; the owner's list filters
   expired ones. No cron trigger, no reaper — §8.1's cheap answer, made
   complete by the delete.
7. **`lastSeenAt` lives on the member and is written at most once a day**,
   from the presence beat — never in `authenticate`, which would be a write
   on every request. "Here now" comes from the `presence` table for free.
8. **The owner authenticates without D1** (§3.2), and gets a member row for
   attribution only.
9. **Leases are advisory** and never gate a write (§3.4).
10. **`by` becomes a member id** and `MANIFEST_VERSION` goes to 3 (§2).

## 7. The phases at a glance

| # | Phase | Ships | Depends on | User sees |
| --- | --- | --- | --- | --- |
| 1 | D1 in the deployment | the binding, the schema runner, wipe and teardown | — | **nothing** (an update badge) |
| 2 | Identity in the worker | members, tokens, invites, the routes | 1 | **nothing** (an update badge) |
| 3 | The code and the redeem flow | the 100-bit code, `cloud_redeem`, the wizard's third mode | 2 | an invited Mac can join |
| 4 | The People panel | the owner's list, Invite…, Revoke, own credentials | 3 | people, listed and revocable |
| 5 | Attribution by person | manifest v3, `by` as a member id, `hist` and the history routes gone | 4 | history says *who*, not *which Mac* |
| 6 | Presence in D1, folded into the poll | the presence table, `POST /api/poll`, the beat's own request gone | 2 | **nothing** — 33% fewer requests |
| 7 | Leases | acquire, renew on the poll, release; the editor's banner and *Take over* | 6 | §11.7 closes |
| 8 | The manifest pointer in D1 *(optional)* | `seq` CAS, immutable manifest blobs, no R2 head on the poll | 6 | **nothing** |

Phases 1 → 2 → 3 → 4 are a chain. 5 needs 4 (a name to show). 6 needs only
2 (a `memberId` to record) and may ship before 3, 4 or 5 if the free-plan
budget is the more pressing problem — it is the phase that takes Class A
from 86% to nothing. 7 needs 6. **8 is optional and deliberately last**:
see §15.

## 8. Phase 1 — D1 in the deployment

Nothing reads or writes a table. This phase exists to land the riskiest
part — the deployment plumbing — with no feature riding on it, so a failure
is a failed deploy and not a broken workspace.

**Files:** `src/cloudPrompts.ts`, `scripts/doklin-cloud-update.sh`,
`cloud-worker/wrangler.toml.example`, `cloud-worker/src/env.ts`,
`cloud-worker/src/schema.ts` (new), `cloud-worker/src/api.ts` (meta, wipe),
`cloud-worker/src/version.ts`, `cloud-worker/test/fake-d1.mjs` (new),
`verify-harness/cloudprompts.test.mjs`, and the one-word honesty edits in
`src/CloudSetup.tsx`, `src/CloudPanel.tsx` and `src/WorkerUpdate.tsx` — the
setup now creates three resources and the teardown removes three, so the
copy that lists them has to say so.

- `wrangler.toml` gains `[[d1_databases]] binding = "DB"`, with
  `database_name` derived by `resourceName` exactly as the bucket is, and
  `database_id` filled in by whoever writes the file (§4.1, §4.2). The
  setup prompt's steps reorder to put both resources before the config: an
  id cannot be written down before it exists.
- `schema.ts` creates `meta` and sets `schema_version = 1`. No other table
  yet — a phase that ships an empty schema ships an empty schema.
- `GET /api/meta` reports `d1: <schema version>` so the app and the update
  script can both see the database is wired, and running the migration
  there is what makes it happen at most once per isolate.
- Wipe clears D1 and re-runs the schema (§4.4); teardown deletes it.
- `WORKER_VERSION` → 4, which is the point: the badge is the only thing
  that carries the binding to a domain already deployed, and a phase whose
  plumbing never reaches anyone has not de-risked anything. No
  `WORKER_FEATURES` name — a name there promises behaviour, and there is
  none yet; `d1: null` says it better.

**Tests:** `node verify-harness/cloudprompts.test.mjs` — the setup prompt
names the create step and the confirmation, the update script's discovery
and its `D1_NAME=` override, the teardown's delete, and the generated
`wrangler.toml` in all four routing shapes. `pnpm test:worker` gets a
migration test: a fresh database migrates, a second call is a no-op, and a
wipe leaves it migrated.

**D1 failure posture:** nothing depends on it. A worker whose `DB` binding
is missing or broken serves every existing route unchanged, and
`/api/meta` reports `d1: null`. Both are asserted, and asserted *first* in
the suite — the runner remembers a successful migration for the life of the
isolate, so a cold start is only observable before one.

**Done when:** `pnpm typecheck:worker`, `pnpm test:worker`, `pnpm
bundle:worker` under the 3 MB cap; a fresh setup *and* an update of an
existing domain both report a schema version; [cloud.md](cloud.md) §5.1,
§7.4 and `cloud-worker/README.md` describe the binding.

## 9. Phase 2 — Identity in the worker

**Files:** `cloud-worker/src/schema.ts` (version 2: members, tokens,
invites), `cloud-worker/src/auth.ts`, `cloud-worker/src/members.ts` (new),
`cloud-worker/src/api.ts`, `cloud-worker/src/version.ts`,
`cloud-worker/test/run.mjs`.

### 9.1 The routes

```
POST   /api/auth/join         NO BEARER — {code, deviceId, deviceName?}
                              → 201 {token, member}; 401 unknown or expired
                              (deletes the invite either way)
POST   /api/auth/invites      owner — {email, name?, codeHash, expiresAt}
                              → 201 {invite}; creates the member if new
GET    /api/auth/invites      owner — the pending, unexpired ones
DELETE /api/auth/invites/<id> owner — withdraw one
GET    /api/auth/members      owner — everyone, with device count and lastSeenAt
POST   /api/auth/members      owner — adopt or rename the owner's own identity
DELETE /api/auth/members/<id> owner — the member and every token they hold
GET    /api/auth/tokens       owner — {id, memberId, deviceName, createdAt}
DELETE /api/auth/tokens/<id>  owner — revoke one device
```

`authenticate` resolves a member token to `{role: "member", memberId,
email, name}` in one indexed row read; the owner still short-circuits on
the env secret before touching D1 (§3.2).

`POST /api/workspace` gains optional `ownerEmail` and `ownerName` and
writes the owner's member row at bind. A domain bound before this phase has
no owner row — `POST /api/auth/members` is how the panel adopts one later
(phase 4).

### 9.2 Tests (`cloud-worker/test/run.mjs`)

The suite currently plants a member token by hand (line 66); this replaces
that with the real path.

- mint → redeem → sync as the member → revoke → the next request 401s;
- an expired invite is refused **and** deleted; a redeemed invite is gone;
- re-inviting the same email in any case, or with surrounding space,
  reaches the same member row;
- deleting a member cascades to every token they hold;
- **the carve-out holds** — `POST /api/auth/join` answers without a bearer,
  while `GET /api/auth/join`, `POST /api/auth/joinx`, `POST
  /api/auth/invites` and every pre-existing route still 401 without one;
- a member is refused `POST /api/workspace` and `POST /api/admin/wipe` and
  allowed `PUT /api/manifest` — §8.1's "a member is not a limited account",
  asserted rather than assumed;
- **the owner authenticates with the `DB` binding removed.**

**D1 failure posture:** members cannot authenticate; the owner is
unaffected, and so is every route the owner drives.

**Done when:** the worker suites pass against source and bundle,
`WORKER_VERSION` is bumped with feature `"members"`, and
[cloud.md](cloud.md) §5.3–5.4 and `cloud-worker/README.md` are rewritten
from "reserved, not built" to what shipped.

## 10. Phase 3 — The code and the redeem flow

**Files:** `src-tauri/src/cloud/scan.rs`, `src-tauri/src/cloud/mod.rs`,
`src-tauri/src/cloud/remote.rs`, `src-tauri/src/cloud/tests.rs`,
`src/cloud.ts`, `src/CloudSetup.tsx`.

- **The code.** `dkln-` plus 20 Crockford base32 characters from
  `getrandom`, grouped in fives, beside `random_token`
  (`scan.rs:223`). Parsing normalizes case, maps the confusables
  (`I`/`l` → `1`, `O` → `0`) and ignores separators, so a code that
  survived a chat client still redeems.
- **The paste blob.** One string carrying endpoint and code, so the invitee
  pastes one thing and the wizard fills both fields. A `doklin://` link is
  deliberately not the route — it would add `tauri-plugin-deep-link` for
  cosmetics.
- **`cloud_redeem(endpoint, code)` → token.** A new command *ahead* of
  `cloud_probe`, because §8.1's order inverts: redeem to a credential
  first, then probe with it. It writes nothing and spawns nothing; the
  existing `cloud_join` does the rest, untouched.
- **`CloudSetupMode` gains `"redeem"`** (`src/CloudSetup.tsx:43`). The
  screen is: paste the invite, confirm the workspace the probe names,
  choose where to download it.

**Tests:** `cargo test --lib cloud` against the in-memory worker — redeem,
redeem twice (refused), redeem expired, then join and sync as the member; a
round-trip property test for the code parser.

**Done when:** those pass, `verify-harness/cloudprompts.test.mjs` still
passes, and an invited Mac joins a real domain in the manual macOS pass.

## 11. Phase 4 — The People panel

**Files:** `src/CloudPanel.tsx`, `src/cloud.ts`,
`src-tauri/src/cloud/mod.rs` (the commands behind it),
`verify-harness/drive-cloud.mjs`.

- **Owner:** a *People* view — name, email, role, device count, last seen —
  with **Invite…** (email, optional name, expiry) and **Revoke** (this
  device, or this person entirely). A freshly minted code is shown once,
  with a copy button, and never again.
- **The owner's own identity:** when the workspace has no owner member row,
  the panel asks for an email once and calls `POST /api/auth/members`. This
  is the only place the app learns the user's email, and it is what phase 5
  attributes revisions to.
- **Member:** the same panel shows *their own* credentials for their second
  Mac, and their own devices, so re-enrollment needs nobody.
- The engine surfaces all of it through commands; the frontend never
  `fetch`es.

**Done when:** `node verify-harness/drive-cloud.mjs` covers adopt → invite
→ list → revoke over the scripted engine, `.claude/skills/verify/SKILL.md`
names the new steps, and [cloud.md](cloud.md) §7.2 describes the panel.

## 12. Phase 5 — Attribution by person

The clean break §2 pays for.

- **`by` becomes a member id.** `MANIFEST_VERSION` → 3; the worker's
  validator takes an id where it took a name. Where there is no identity —
  an unconnected workspace — the field is empty, as it already may be.
- **`hist` leaves the manifest** and the three deprecated
  `/api/history/<fid>` routes are deleted, with their caps
  (`MAX_INLINE_HIST`, `MAX_HISTORY_ENTRIES`, `MAX_HISTORY_BYTES`) and the
  app's one-time cleanup call. [versioning.md](versioning.md) §6.5 has
  wanted this since phase 6 of that plan; only compatibility held it.
- **The surfaces resolve ids to people** — the history rail, the conflict
  toast (`CloudConflictEvent.by`, `src/cloud.ts:111`), the version
  timeline — from the member list the panel already fetches, cached, with
  the raw id as the fallback when a member has been deleted.

**Tests:** `cargo test --lib cloud` for the v3 round trip and the
empty-`by` path; `pnpm test:worker` for the 426 an app on v2 now gets, and
for the history routes' absence; `drive-versions.mjs` for the rail.

**Done when:** those pass, [versioning.md](versioning.md) §6.5 and
[cloud.md](cloud.md) §5.3, §6.6 record the removal, and §11.1's downstream
item — "`by` is a device name, never a person" — is struck.

## 13. Phase 6 — Presence in D1, folded into the poll

Invisible, and the phase that fixes the budget.

**Files:** `cloud-worker/src/schema.ts` (version 3: `presence`),
`cloud-worker/src/api.ts`, `cloud-worker/src/layout.ts` (drop
`PRESENCE_KEY`), `src-tauri/src/cloud/engine.rs`,
`src-tauri/src/cloud/remote.rs`.

- `GET /api/poll` → `POST /api/poll`, optional body `{path?}`. With a body
  it upserts the caller's presence row; without one it only reads.
- `PUT /api/presence` and `DELETE /api/presence` are **deleted**, and so is
  `presence.json` — wipe stops writing it, and phase 1's wipe already
  clears D1.
- The engine keeps `presence_tick`'s due-logic (`engine.rs:1639`) and
  attaches the beat to the next poll rather than issuing its own request.
  `PRESENCE_BEAT` 25 s → 45 s.
- Presence entries carry `memberId`, so "who else is here" names people.
- A device that quits sends one last poll with an explicit leave.

**D1 failure posture — the important one:** the poll's presence half is
**best effort**. If the D1 query throws, the poll still answers with the
manifest etag from R2 and an empty presence list, and sync carries on. That
is exactly today's contract for presence ("TTL'd, best effort") and it is
what keeps phase 6 off the sync critical path.

**Tests:** `pnpm test:worker` — a poll with a body writes, a poll without
one does not, a stale row falls out of the TTL window, and a poll with the
`DB` binding removed still returns the etag. `cargo test --lib cloud` — the
beat cadence, the leave, and that an idle device makes exactly four
requests a minute.

**Done when:** those pass and [cloud.md](cloud.md) §5.2–5.3 and §11.2 are
rewritten — §11.2 from a blocker into the arithmetic of §5 here.

## 14. Phase 7 — Leases

**Files:** `cloud-worker/src/schema.ts` (version 4: `leases`),
`cloud-worker/src/api.ts`, `src-tauri/src/cloud/engine.rs`,
`src-tauri/src/cloud/status.rs`, `src/cloud.ts`, `src/Editor.tsx`,
`src/App.tsx`.

- `POST /api/leases` `{path}` → `{held: bool, by: {memberId, name, until}}`
  — the atomic statement of §3.4. `DELETE /api/leases` `{path}` releases.
  Renewal rides the poll body, which already carries the edited path.
- The poll's answer gains `leases: [{path, memberId, name, until}]`, so
  every device knows the state of the ones it cares about within 15 s.
- The engine acquires on editing focus (it already reports activity per
  path), renews on the poll, releases on blur and on close, and surfaces
  `lockedBy` in `cloud-status`.
- The editor opens read-only with "Alice is editing — view only" and a
  *Take over* that waits for the lease to lapse, or breaks one already
  stale.

**D1 failure posture:** no lease is no lock. The editor opens normally and
the three-way merge is the fallback — which is today's behaviour, so a D1
outage costs the *warning*, never the edit.

**Tests:** `pnpm test:worker` — two devices race one path and exactly one
wins; a lapsed lease is takeable; a release frees it; a renewal by the
non-holder does nothing. `cargo test --lib cloud` — focus acquires, blur
releases, a missed renewal lapses. A `drive-cloud.mjs` step for the banner
and *Take over*.

**Done when:** those pass, [cloud.md](cloud.md) §8.2 becomes an as-built
section and §11.7 is struck, and the manual macOS pass shows two Macs
seeing each other's lock.

## 15. Phase 8 — The manifest pointer in D1 *(optional)*

**Ship this only if the R2 Class B budget becomes a problem. It probably
will not.**

The design is sound: the manifest becomes an immutable content-addressed
blob (`manifests/<hash>`), D1's `workspace` row holds `manifest_hash` and a
monotonic `seq`, and the CAS becomes `UPDATE workspace SET manifest_hash =
?, seq = seq + 1 WHERE id = 1 AND seq = ?` with `changes == 1` as the
verdict. Writing the blob first and flipping the pointer second leaves only
a collectable orphan on a crash — the same discipline the version store
already uses. `x-base-etag` becomes `x-base-seq`, and the engine gets a
monotonic counter instead of an opaque etag, which is strictly better: it
can tell *how far* behind it is, not merely *that* it is. The poll stops
touching R2 entirely.

**What it costs is the reason it is last:** it puts D1 on the **sync
critical path**. Every phase before this one degrades gracefully when D1 is
unavailable — the owner still authenticates, presence goes quiet, leases
stop existing, and sync runs. After this phase, a D1 outage stops sync for
everyone, because nothing else knows which manifest is current.

The gain is roughly 1.7 M Class B operations a month against a 10 M budget.
Trading a graceful degradation for 17% of a budget that is at 17% is not a
good trade today. Revisit it if the workspace grows enough that blob reads
start crowding the same budget.

## 16. What this plan leaves alone

- **`PUT /api/manifest` stays un-role-gated.** §8.1's "a member is not a
  limited account" is still the contract — invites buy attribution and
  per-person revocation, not read-only access and not per-folder scope.
  Owner-only is exactly bind, wipe and administer.
- **Nothing backs off (§11.4) and the CAS retries in lockstep (§11.5).**
  Both are real, both are cheap to fix, and neither belongs in a phase
  about people. `CAS_ATTEMPTS` is 4 with a bare `continue`
  (`engine.rs:610`, `engine.rs:667`); jitter is a few lines whenever
  someone wants it.
- **The 5,000-file workspace cap (§11.6).**
- **A push model.** Phase 6 takes the request count to 58% of the free plan
  by deleting a request, not by changing the shape of the protocol. Going
  further means WebSockets, which means a Durable Object, which is a
  different project — and one nothing here forecloses: presence and leases
  are two tables and a handful of routes, and moving them is a rewrite of
  the worker's storage layer, not of the engine's contract.
