# Identity — people, invites, and the implementation plan

[cloud.md](cloud.md) §8.1 shapes invites as one thing: a code that mints a
token. This document re-shapes them as two — a **person**, who is permanent,
and a **credential**, which is disposable — and plans the build. It settles
the three questions §8.1 left open (§2), says where the data lives and why it
is not a database (§3), and breaks the work into phases that ship on their
own (§5–§10).

Read [cloud.md](cloud.md) §5.2–5.5 (the bucket, the API, the auth gate),
§6.8 (the join flow), §8.1 (the shape this replaces) and §11.1 (what it
unblocks) first. This document says *how*, *in what order*, and *what it
costs on Cloudflare's free plan*.

## 0. How to use this document

- **One phase per branch and pull request.** A phase's *Done when* list is
  the merge gate. Every phase is releasable on its own and never leaves the
  app needing the next one to be correct.
- **An older app must keep working** against anything a phase leaves in the
  bucket, and an older worker must keep answering an app that has updated.
  That rule is what §4 is about.
- Match the house style: a module opens with a comment saying what it is and
  which doc section it serves; a contract mirrored in Rust and TypeScript
  says "change both" on both sides; a number with one source is parsed from
  it, never retyped; the frontend never `fetch`es.
- When a phase changes what [cloud.md](cloud.md) describes, update it in the
  same PR (an *as built* note under the section), and update
  `.claude/skills/verify/SKILL.md` with what the new suites walk.

## 1. The idea in one page

**A person is not a token.** §8.1 conflated them: an invite minted a token,
and the token was the whole record of who had access. That makes the natural
questions unanswerable — *who has access?*, *this is the same Alice who left
last year*, *she lost her Mac, give her back what she had*.

Three records, three lifetimes:

| Record | Key | Lifetime | Holds |
| --- | --- | --- | --- |
| **Member** | `sha256(normalized email)` | permanent | who this person is |
| **Token** | `sha256(token)` | one device, until revoked | the credential |
| **Invite** | `sha256(code)` | until redeemed or expired | a pending token |

The member key is derived from the email, so **re-inviting the same address
lands on the same member record by construction** — no lookup index, no
"find member by email" query, no database. A lost Mac is: revoke that
person's tokens, mint a new invite for the same email, and the same member
record picks up a new token. Attribution, presence and history that point at
a `memberId` keep pointing at the same person across every machine they ever
use.

The credential is a **capability**: 100 bits of randomness, one-time use,
carrying no identity of its own. The email is the identity and never the
secret; the code is the secret and never the identity. The invitee types one
field.

## 2. The three open questions, settled

### 2.1 The code — a capability, not a passphrase

`amber-canyon-lantern-42` is about 31 bits. A redeemed invite yields a member
token, and a member token is not a limited account (§8.1: `PUT /api/manifest`
is not role-gated), so **the code is a full read/write credential for the
workspace**. Beside a 256-bit owner token (`src-tauri/src/cloud/scan.rs:223`)
a 31-bit one is the weakest link by a factor of 2²²⁵ — and it buys
memorability the design never uses, because §8.1 shares the code over Slack
or iMessage, not aloud.

**Settled:** 100 bits, Crockford base32, minted by the app.

```
dkln-K7QM2-9XVR4-8TBHN-3WGYD        20 chars = 100 bits
```

Crockford's alphabet drops I/L/O/U and is case-insensitive, so a mistyped or
autocorrected code either fails cleanly or normalizes to the right one. The
`dkln-` prefix is self-identifying: the app validates the shape before
touching the network, and a leaked code is greppable.

This is what makes §8.1's "nothing throttles it" a non-problem: at 100 bits,
**guessing is off the table**, and the attempt cap, the lockout and the KV or
Durable Object needed to count them all disappear. Entropy is free; a counter
is not.

If a flood guard is ever wanted, the [Workers rate limiting
binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
is the one to reach for — its `namespace_id` is a developer-chosen integer,
not a resource to create, so it flows through §7.2's update with nothing to
provision. Its counters are per-Cloudflare-location and its `period` must be
10 or 60 seconds: fine for abuse, useless as a global attempt cap, which is
exactly the shape we need and no more.

**Also settled:** the email is *not* in the code's key. §8.1's
`sha256(email + code)` makes the invitee retype a string byte-identically to
how the owner typed it — case, plus-tags, typos — for approximately zero real
bits, since emails are guessable. The invite is keyed by `sha256(code)` and
names its member inside.

### 2.2 `expiresAt` — checked at redeem, never reaped

As §8.1 proposed and as agreed: no cron trigger (it would change deploy
config every existing domain must re-apply). Expiry is checked when the code
is redeemed, and the owner's list filters expired invites out of the view.

**One addition that completes it:** the invite object is **deleted on
successful redeem**. One-time use plus expiry-at-redeem means a code is dead
the moment it is used and dead again when it ages out, and the only thing an
un-reaped record costs is a few hundred bytes.

### 2.3 `lastSeenAt` — on the member, once a day at most

The trap is real: written in `authenticate` it is an R2 put on *every*
authenticated request, and the sync loop polls every 15 s — 5,760 puts per
device per day, which would out-consume presence, already 86% of the free R2
Class A budget (§11.2).

It has exactly one consumer: the owner deciding who is safe to revoke.

**Settled, in two parts:**

- **"Here now"** comes from presence, which already carries a per-device `ts`
  (`cloud-worker/src/api.ts:349`) and costs nothing extra. Once presence
  entries carry a `memberId` (phase 4) this answers *"Alice is here"* rather
  than *"Alice's iMac is here"*.
- **"Last seen"** is a coarse write on the **member** record — updated only
  when the stored value is more than a day old. Ten members means at most ten
  puts a day. It goes on the member, not the token, because the question is
  about the person, not the machine.

Never on the request path, in either form.

### 2.4 And a fourth: no password, now or later

A password would be typed exactly once, at redeem, where the code has already
authenticated the caller. The client is a native app holding a long-lived
token in `cloud.json` (`src-tauri/src/cloud/config.rs:35`) — no sessions, no
web login, no re-auth.

The real case for one is self-serve re-enrollment on a new Mac. Two things
answer it without a password:

- **A second Mac needs no one's help today.** `cloud_token` already returns
  `{endpoint, token}` (`src/cloud.ts:134`) and the Cloud panel already shows
  "the credentials a second Mac needs". A member's panel shows *their own*
  token and their second Mac joins with it — the same flow the owner uses,
  zero new routes.
- **The invite code is already a magic link.** It is a one-time,
  high-entropy, expiring credential addressed to an email — the whole
  primitive, differing from a magic link only in delivery. When email sending
  arrives (§10), self-serve re-enrollment is the *same record* delivered a
  different way. A password would be a third credential type, wanted only
  until magic links land, and then wanted gone.

Against that it costs a KDF in the worker (realistically PBKDF2 via
WebCrypto), a stored hash, a login route, and — the point that decides it —
it **reintroduces the guessing problem §2.1 just removed**, because
human-chosen passwords are low-entropy by nature. The rate limiter comes
back, and with it the counter store, and with it the database.

"Lost my only Mac" correctly escalates to the owner: revoke, re-invite the
same email. That is an admin action you want to be deliberate.

## 3. Where it lives — R2, and why not a database

### 3.1 What the three stores actually are

- **R2** is a bucket of blobs: strongly consistent reads, last-writer-wins
  writes, no compute, no transaction, no atomic read-modify-write, no query.
- **D1** is one shared SQLite database queryable from anywhere. Tables,
  indexes, transactions, cross-row queries.
- **A Durable Object** is neither: a *named, single-threaded actor with
  storage attached*. One instance per name, globally; requests to it queue,
  so read-modify-write is atomic by construction. Its storage is an embedded
  SQLite database — so it is "a database", but one per name rather than one
  shared. It also has what neither of the others has: **alarms** (a timer
  that wakes the object — a reaper without a cron trigger), an in-memory
  cache between requests, and WebSockets with hibernation.

The natural DO for this codebase is one per workspace: everything mutable and
shared — the manifest etag, presence, leases — is exactly workspace-scoped.

### 3.2 Identity belongs in R2

The identity model is about thirty tiny objects with O(1) key derivation and
no cross-entity query anywhere in it. R2 is not a compromise here; it is the
right store. It is also the **cheapest place for the auth hot path on the
free plan**, which is the part that surprises:

| Auth lookup via | Cost per API request | Ten Macs, app left open | Against free |
| --- | --- | --- | --- |
| **R2** | 1 Class B get | 2.6 M/month | 26% of 10 M/month |
| **Durable Object** | 1 DO request | 86,400/day | **86%** of 100 k/day |
| **D1** | 1 row read | 86,400/day | 1.7% of 5 M/day |

D1 is by far the roomiest — and costs the deployment story (§3.4). A DO is
the *worst* place for it, because DO requests are billed separately from
Worker requests and both free budgets are 100 k/day: routing auth through a
DO spends 86% of a second budget to save nothing.

Note what R2 auth adds on top of §11.2's existing 4.3 M Class B/month:
roughly 2.6 M more, for about 69% of the Class B budget at ten always-on
Macs. Under the cap, worth knowing. The owner path stays free — the owner
token is compared against the env secret and reads nothing
(`cloud-worker/src/auth.ts:63`).

### 3.3 What a database *would* be for — and it isn't invites

The genuine case is presence, polling and leases, and it is unchanged by
identity:

- `presence()` (`cloud-worker/src/api.ts:335`) is a read-modify-write of one
  shared JSON object **with no CAS**. Two beats landing together and one is
  silently lost. That is a correctness smell, not only a cost one.
- Presence puts are 864 k Class A/month at ten always-on Macs — 86% of the
  free 1 M (§11.2).
- §8.2's leases need precisely what R2 cannot give: a consistent, cheap,
  frequently-written little table.

All three are a workspace DO's job, and a DO's alarms would also give §8.2's
lease expiry and any future reaper for free. **That work is a separate
project from identity** (§11) and must not be a prerequisite for it.

### 3.4 The deployment cost, which is the real tiebreaker

`wrangler.toml` is written **verbatim** by the app (`src/cloudPrompts.ts:121`)
and **regenerated from scratch** by the update script
(`scripts/doklin-cloud-update.sh:253`). That property is load-bearing for
§7.2 and §7.4.

| | Resource to pre-create | `wrangler.toml` | Update script |
| --- | --- | --- | --- |
| R2 (today) | bucket, already there | verbatim | rewrites and deploys |
| **Durable Object** | none — class name + migration tag | stays verbatim | unchanged |
| **D1** | `wrangler d1 create`, per-deployment `database_id` | breaks verbatim | needs `d1 list` discovery, like the bucket-name fallback |
| Rate limit binding | none — `namespace_id` is a chosen integer | stays verbatim | unchanged |

D1's id would have to be captured by the setup agent (a fill-in of the same
kind as `account_id`, so tolerable) *and* rediscovered by the update script,
which ships one bundled JS file and no migrations directory. A DO needs
neither: its schema is set up in code, and `wrangler delete` takes the
objects with it, so teardown does not grow a step.

**Verdict:** identity and auth in R2, now. A workspace DO for presence and
leases, when that work happens. D1 only if a cross-row query ever appears —
edit history already lives in the version store, so probably never. Moving
thirty objects into a DO later, if it ever makes sense, is a one-time loop.

## 4. Decisions this plan makes

1. **Member key is `sha256(lowercase(trim(email)))`.** Stable identity with
   no index. Normalization is one function mirrored in Rust and TypeScript.
2. **A member id is short and stable** (`m-` + the first 8 hex of that hash).
   It is what attribution and presence carry; the email is never put in the
   manifest.
3. **The token record denormalizes the member's email and display name**, so
   authenticating stays one R2 get. A rename rewrites that person's tokens —
   rare, and bounded by their device count.
4. **`POST /api/auth/join` is the only carve-out** above the `authenticate`
   gate (`cloud-worker/src/api.ts:74`), matched on method **and** path
   exactly. Every other `/api/auth/*` route is owner-only and inside the
   gate.
5. **Revoking by key, not by id.** Tokens are keyed by `sha256(token)`, which
   the owner never holds, so `GET /api/auth/tokens` returns each record's
   bucket key alongside `{id, memberId, deviceName}`, and the DELETE takes
   the key.
6. **The worker never sees a plaintext code.** The app mints it and sends
   `sha256(code)`, exactly as it mints the owner token today. A stolen bucket
   yields no working credential.
7. **`WORKER_VERSION` 3 → 4, feature `"members"`.** Every existing domain
   goes through §7.2's update before an invite works anywhere, as §8.1
   already required.
8. **Attribution is carried in `by` and `byId`, and `by` is the one to
   trust.** See §4.1 — this is the one place the compatibility rule bites.

### 4.1 The attribution compatibility trap

The worker's manifest validator checks known fields and ignores unknown ones
(`validateFiles`, `cloud-worker/src/manifest.ts:108`), so adding a `byId` per
file entry needs **no `MANIFEST_VERSION` bump**. But the Rust `ManifestFile`
struct (`src-tauri/src/cloud/manifest.rs:88`) is plain serde: unknown fields
are dropped on deserialize and **not** round-tripped. An older app that
rewrites the manifest therefore **silently strips `byId`** from every entry.

So: put the member's **display name** in `by` (a string every app already
round-trips, and a sensible thing for an old app to show), and `byId`
alongside it for the stable link. Readers trust `byId` when present and fall
back to `by`. The mixed-fleet window is bounded — invites force a worker
update, and the app auto-updates ([auto-update.md](auto-update.md)) — but it
is not zero, and a phase that assumed `byId` always survived would be wrong.

## 5. The phases at a glance

| # | Phase | What ships | Depends on | User sees |
| --- | --- | --- | --- | --- |
| 1 | Identity in the worker | members, invites, tokens, the routes, `WORKER_VERSION` 4 | — | nothing; a worker-update badge |
| 2 | The code and the redeem flow | the 100-bit code, `cloud_redeem`, the wizard's third mode | 1 | an invited Mac can join |
| 3 | The Members panel | the owner's list, Invite…, Revoke; a member's own credentials | 1, 2 | people, listed and revocable |
| 4 | Attribution and presence by person | `by`/`byId`, `memberId` in presence, coarse `lastSeenAt` | 1–3 | "Alice edited this", "Alice is here" |
| 5 | Email delivery *(optional)* | `SEND_EMAIL`, the code sent instead of copied | 1–3 | an invite that arrives by itself |

Phase 5 is optional and gated on the account (§10). Phases 1–3 are the
feature; 4 is what makes it worth having; the workspace DO (§11) is a
separate project that this plan deliberately does not depend on.

## 6. Phase 1 — Identity in the worker

**Files:** `cloud-worker/src/layout.ts` (prefixes and key helpers),
`cloud-worker/src/auth.ts` (resolve a member token),
`cloud-worker/src/members.ts` (new — the routes),
`cloud-worker/src/api.ts` (the carve-out and dispatch),
`cloud-worker/src/version.ts`, `cloud-worker/README.md`.

### 6.1 The bucket

```
auth/members/<sha256(email)>.json  {id, email, name, role, createdAt, lastSeenAt?, disabled?}
auth/tokens/<sha256(token)>.json   {id, memberId, email, name, deviceName?, createdAt}
auth/invites/<sha256(code)>.json   {id, memberId, createdAt, expiresAt}
```

`TOKENS_PREFIX` already exists (`layout.ts:25`); add `MEMBERS_PREFIX`,
`INVITES_PREFIX`, `memberKey`, `inviteKey`, and `normalizeEmail`.

### 6.2 The routes

```
POST   /api/auth/join        NO BEARER — body {code, deviceName?} → 201 {token, member}
                             401 unknown/expired code; deletes the invite on success
POST   /api/auth/invites     owner; body {email, name?, codeHash, expiresAt} → 201 {invite}
                             creates the member record if that email has none
GET    /api/auth/invites     owner; the pending, unexpired ones (with their keys)
DELETE /api/auth/invites/<key>   owner; withdraw one
GET    /api/auth/members     owner; every member, with device count and lastSeenAt
DELETE /api/auth/members/<key>   owner; the member and every token they hold
GET    /api/auth/tokens      owner; {key, id, memberId, deviceName, createdAt}
DELETE /api/auth/tokens/<key>    owner; revoke one device
```

`authenticate` returns `memberId` and `email` for a member token — the record
already holds them, so this stays one get.

### 6.3 Tests (`cloud-worker/test/run.mjs`)

The suite already plants a member token by hand (line 66); these replace that
with the real path.

- mint → redeem → sync as the member → revoke → the next request 401s;
- an expired invite is refused **and** deleted; a redeemed invite is gone;
- re-inviting the same email, in any case or with surrounding space, resolves
  to the same member record;
- deleting a member kills every token they hold;
- **the carve-out holds**: `POST /api/auth/join` answers without a bearer,
  while `GET /api/auth/join`, `POST /api/auth/joinx`, `POST /api/auth/invites`
  and every pre-existing route still 401 without one;
- a member is refused `POST /api/workspace` and `POST /api/admin/wipe`, and
  allowed `PUT /api/manifest` — §8.1's "a member is not a limited account",
  asserted rather than assumed.

**Done when:** `pnpm typecheck:worker`, `pnpm test:worker`, `pnpm
bundle:worker` under the 3 MB cap, the bundled worker passes the same suite,
and `cloud-worker/README.md` plus [cloud.md](cloud.md) §5.2–5.4 describe what
shipped.

## 7. Phase 2 — The code and the redeem flow

**Files:** `src-tauri/src/cloud/scan.rs` (mint a code beside
`random_token`), `src-tauri/src/cloud/mod.rs` (`cloud_redeem`),
`src-tauri/src/cloud/remote.rs` (the join call), `src/cloud.ts`,
`src/CloudSetup.tsx`.

- **The code.** `dkln-` plus 20 Crockford base32 characters from
  `getrandom`, grouped in fives. Parsing normalizes case, maps the
  Crockford confusables (`I`/`l` → `1`, `O` → `0`), and ignores separators, so
  a code that survived a chat client still redeems.
- **The paste blob.** The panel offers one string carrying endpoint and code,
  so the invitee pastes one thing and the wizard fills both fields. A
  `doklin://` link is deliberately *not* the route: it would add
  `tauri-plugin-deep-link` for cosmetics.
- **`cloud_redeem(endpoint, code)` → token.** A new command *ahead* of
  `cloud_probe`, because §8.1's order inverts: redeem to a credential first,
  then probe with it. It writes nothing and spawns nothing; the existing
  `cloud_join` does the rest, unchanged.
- **`CloudSetupMode` gains `"redeem"`** (`src/CloudSetup.tsx:43`). The third
  mode's screen is: paste the invite, confirm the workspace the probe names,
  choose where to download it.

**Tests:** `cargo test --lib cloud` against the in-memory worker — redeem,
redeem-twice (refused), redeem-expired, then join and sync as the member. A
round-trip property test for the code parser.

**Done when:** those pass, `verify-harness/cloudprompts.test.mjs` still
passes, and an invited Mac can join a real domain in the manual macOS pass.

## 8. Phase 3 — The Members panel

**Files:** `src/CloudPanel.tsx` (its first stateful screen), `src/cloud.ts`,
`verify-harness/drive-cloud.mjs`.

- **Owner:** a *People* view listing each member — name, email, role, device
  count, last seen — with **Invite…** (email, optional name, expiry) and
  **Revoke** (this device, or this person entirely). The freshly minted code
  is shown once, with a copy button, and never again.
- **Member:** the same panel shows *their own* credentials for their second
  Mac, exactly as the owner's does today, and their own devices, so
  re-enrollment needs nobody.
- The engine surfaces the member list through a command; the frontend never
  `fetch`es.

**Done when:** `node verify-harness/drive-cloud.mjs` covers mint → list →
revoke over the scripted engine, `.claude/skills/verify/SKILL.md` names the
new steps, and [cloud.md](cloud.md) §7.2 describes the panel.

## 9. Phase 4 — Attribution and presence by person

- **`by` becomes the member's display name; `byId` carries the member id**,
  under §4.1's rule — trust `byId` when present, fall back to `by`. Where
  there is no identity (an unconnected workspace, an old manifest) the device
  name stays, exactly as today.
- **Presence entries carry `memberId`**, so "who is here" and, later, §8.2's
  "Alice is editing" name a person rather than a Mac. §11.1's downstream item
  closes here.
- **`lastSeenAt`** lands on the member record with the once-a-day rule of
  §2.3, derived from the presence beat rather than from `authenticate`.

**Done when:** history and conflict surfaces show people, `cargo test --lib
cloud` covers the `byId`-stripped-by-an-old-app fallback, and
[cloud.md](cloud.md) §11.1 is rewritten from a blocker into an as-built note.

## 10. Phase 5 — Email delivery (optional, and gated)

Worth planning for, not worth blocking on. [Cloudflare Email
Service](https://developers.cloudflare.com/email-service/) reached public
beta in April 2026 and gives Workers a native `SEND_EMAIL` binding with no
API keys — but sending to **arbitrary** recipients requires the **Workers
Paid plan** ($5/month, 3,000 emails included, then $0.35/1k), and the sending
domain must be on Cloudflare DNS so SPF, DKIM and DMARC can be configured.
Before a domain is onboarded, the binding only reaches addresses explicitly
verified.

Two consequences:

- **A `workers.dev` workspace can never send.** Email delivery is an
  *optional capability of a custom-domain, paid-plan deployment*, not part of
  the baseline. Sharing the code out of band stays the floor, forever.
- **It changes no data.** Same member record, same invite record, same code —
  only the delivery differs. The worker feature-detects the binding; without
  it the panel behaves exactly as phase 3 shipped.

When it lands, the same mechanism becomes self-serve re-enrollment: the
member asks for a link, the worker mints an invite against their existing
member record and emails it. That is §2.4's magic link, and it is why no
password is ever needed.

## 11. What this plan deliberately leaves alone

The workspace **Durable Object** — presence without the lost-update race,
§8.2's leases, and eventually a push model that would end §11.2's heartbeat
and §11.3's fan-out. It is the right answer to those problems and the wrong
answer to this one (§3.2), it is a much larger change, and nothing in phases
1–5 depends on it or is made harder by it. When it happens, presence and
leases move; members, tokens and invites can stay exactly where this plan
puts them.

Also untouched: `PUT /api/manifest` stays un-role-gated. §8.1's "a member is
not a limited account" is still the contract — invites buy attribution and
per-person revocation, not read-only access and not per-folder scope. Owner
only is exactly bind and wipe.
