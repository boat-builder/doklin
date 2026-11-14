# Cloud: people and agents

Routes, tables, status codes: [cloud-worker/README.md](../cloud-worker/README.md). Sync rules: [cloud.md](cloud.md).

## Credentials

- `auth.ts` matches the owner secret first, with no D1 read, so a D1 outage costs people, never the creator.
- The secret's holder is the **creator**: always an owner; their member row (bind, or `cloud_adopt_owner`) is the one in `creator` and is never removed or demoted.
- A token carries its person's `members.role`, read on every request, so a role change bites on the next call. There can be several owners.
- Who may do what is one table: `can(role, action)` in `roles.ts`. Every gated route asks it; `/api/meta` answers the caller's row as `you.can` and the app hides by it (`may` / `mayOn`, `src/cloud.ts`; an empty `can` on a status means not yet known, so the control shows). Change a permission there, nowhere else.
- A member is not a limited account: `PUT /api/manifest` isn't role-gated. Owners only = invite, remove, sign out, roles, agents, bind, wipe.
- Nobody removes or demotes their own row, or deletes the token the call is made with.
- Codes are 100 bits (Crockford base32): no throttle, lockout or counter. Revoking a row bites on the next request.
- `last_seen_at` (beat) and `last_used_at` (agent request) move at most hourly.

## People

- A member is keyed by normalized email (`m-` + 8 hex): re-inviting an address reaches the same person. Member ids enter the manifest, emails never.
- **A removed person's row is never deleted** (`members.disabled`): out of the People list and unable to sign in, still in the directory so what they wrote keeps their name. Inviting the address again is the same person, a member, with their Private; restricted folders they were in are not given back.
- The address is never verified, so a code is whoever redeems it. Once somebody has signed in as a person (`lastSeenAt` set — the redeem sets it — or the creator's row), a new code for them is only theirs or the creator's to make; before that the row is an invitation any owner may re-issue (`mayInviteAgain`, `src/cloud.ts` ⇄ `createInvite`, `api.ts`: **change both**).
- Invite: the owner's Mac mints `dkln-XXXXX-XXXXX-XXXXX-XXXXX` (`invite.rs`) and sends only its sha256; 7 days default; cap `MAX_DAYS` ⇄ `MAX_INVITE_TTL_MS`, **change both**. Line: `doklin-invite <endpoint> <code>`. `normalize_code` ⇄ `normalizeCode` (`members.ts`) must match exactly: **change both**.
- Redeem runs first (`/api/meta` is behind the gate): `cloud_redeem`, then probe, `cloud_join`. The code is spent at redeem; later failures retry the probe only.
- `CloudPeople.tsx` asks (`cloud_people`), never stores: no role is on disk. Everyone reads the list; lists a role may not act on come back empty.
- `cloud_join(endpoint, token)` asks for no folder: the workspace lands in `~/Doklin/<name>` (`Name 2` when taken).
- An owner's unused codes go with them: removing or demoting an owner withdraws **every** pending invite. Otherwise a removed owner returns on a code they kept.

## Losing access (`engine.rs`, `mod.rs`)

- **Only `401 {removed: true}` deletes** (`RemoteError::Removed`). Never infer it from another refusal: a D1 outage answers a bare `401` to every member at once.
- The engine exits `Exit::Removed`; `access_removed` then deletes the folder outright (not the Trash), the local version stores (the workspace's and each section's) and the sync state, drops the `cloud.json` entry and emits `cloud-removed`. Nothing in the cloud is deleted.
- `remove_copy` deletes only a folder whose marker names that domain and `wsId`, resolved through symlinks, and never a path that holds the home directory.
- The creator's Mac never obeys it (`creator` in `cloud.json`, written on the first probe that says so): that folder is the user's own.
- A removal never lapses: an offline Mac deletes when it next reaches the domain. A wipe empties `removed_tokens`, so it deletes nobody's copy.
- `cloud_removed` returns the removals since launch, for a window that was not listening; a window dedupes by `root` + `at`.

## Spaces (`spaces.ts`, `addresses.ts`)

What a Mac does with them: [cloud.md](cloud.md) *Sections*.

- A space (restricted folder, or a person's Private) is a workspace of its own under `spaces/<id>/`: the sync handlers run unchanged on an `Env` whose bucket is that prefix (`spaceEnv`). **One gate** (`openSpace`) sits before everything under `/api/spaces/<id>`; a new route goes behind it, never beside it.
- **Outside a space it does not exist**, for owners too: same `404` as an unknown id, no name, no count. Presence shows a person is here without the path; leases in it are not listed.
- Nothing about a space is in the shared manifest, the shared blobs or the shared version store.
- Everyone in a restricted folder is equal. The last person cannot leave (`409`); a folder whose last person was removed from the workspace stays stored with nobody in it.
- A Private's id is its person's (`p-<member hex>`), so it cannot be made twice; it never has a second person. A creator with no member row has none.
- `spaces.etag` mirrors the space's manifest etag so one poll covers every space. It is written after each manifest write through the worker (`noteEtag`; `commit.ts` too) and repaired by any manifest read that finds it stale. A writer that bypasses both leaves other Macs blind.
- An owner (`pages.manage`) is told of every public address and can take any page down, including one in a space they are not in — and of such a page only what its address tells anyone (`everyPage.ts`). Nothing else about a space reaches an owner.
- A public address is one space's for the whole domain: `addresses.slug` is the primary key, claimed before the manifest is stored and released after (`claimAddresses`, called by `putManifest` and `commit`). The registry may hold a claim its space failed to store, never lack one it stored. The shared workspace's claims are best effort (its sync never waits on D1), so a space's claim is also checked against the shared map.

## Presence and leases (`presence.ts`, `engine.rs`)

- The beat rides `POST /api/poll`; `GET` writes nothing. Owed every 45 s (`PRESENCE_BEAT`; TTL 90 s) and on a new edited path; a failed poll keeps it owed, no early retry. Only a new path, a cycle, the edited document's lease freeing, or a take-over bring a poll forward.
- "Editing" = opened or typed in within 5 min (`ACTIVITY_FRESH`); `cloud_set_activity` fires per tab switch, never per key.
- A beat naming a path claims its lease in one upsert (free, lapsed or already this Mac's; `take: true` regardless) and releases this Mac's others. Key = space + path lowercased (`lease_key` ⇄ `leaseKey`, **change both**). No reaper: reads filter, beats sweep.
- **Advisory, always**: nothing that writes the manifest reads a lease, agents included. A leased document opens view-only elsewhere (`LeaseBanner.tsx`); merges cover the gaps.
- Any failure (no DB, D1 error, failed poll, paused engine) shows no lock; never on the sync path.

## Agents

- An agent (`a-` + 8 hex) is a name + scopes; not a member. The sync cycle has no agent code; the owner's agent calls are `HttpRemote` methods, off the `Remote` trait.
- `publish` is off unless ticked (a remote agent can't be asked to confirm). Scopes are per route (`ROUTES`, `agentApi.ts`). The home page is set only in the app.
- The only way in: a `dkla-…` code (`AGENT_PREFIX` ⇄ `normalizeAgentCode`, **change both**), valid 1 h (`AGENT_CODE_MINUTES`; the worker's looser cap absorbs clock skew), shown once in `buildAgentLoginPrompt` (install line + `doklin login <endpoint> <code>`). Login deletes the code and mints the machine's `dka_` token in one statement.

## Document API

- **The worker is a third writer** (`commit.ts`): read manifest + etag → apply (checks `if-rev` against that manifest; a refusal writes nothing) → `validateManifest` → blobs create-only → manifest `onlyIf etagMatches`; a lost race redoes it. The precondition is the file's `rev`, never the etag. An unchanged manifest isn't written.
- `apply_remote` relies on: new file `f-` + 12 hex, `rev: 1`; edit `rev + 1`, new hash/size/mtime; move new path, `rev + 1`, same hash and mtime; removal a tombstone `{path, rev + 1, ts, by}`; a write over its own tombstone takes the next rev; `seq + 1`; `by` = agent id; a document's files in one write. `WorkerTx` (`tests.rs`) mirrors `Tx`: **change both**. Macs apply it next poll, writing nothing back.
- A **document** = a stem with up to two versions, markdown (`.md .markdown .mdown .mkd`) and html; its sidecar `<stem>.meta.jsonl` never crosses the API. Reads default to md, else html; writes default to md and never guess on html-only. Anything else is a plain file named in full (`locate`, `documents.ts`).
- Refused (would sync to nobody): hidden segments, `IGNORED_NAMES` (⇄ `is_hidden_or_ignored`, `lib.rs`, **change both**), the `.doklin-sync-tmp` suffix, sidecars. A name under an existing folder in another case takes its spelling.
- No silent overwrite: `if-rev: <n>`, `if-rev: *` or `force=1`. Same bytes: `unchanged`. `htmlBehind`: html mtime > 2 s older than md.
- A public entry follows its document: its md file, else its html.
- Comments: reads keep markers (`clean=1` strips) so read-then-write keeps them; a vanished marker orphans its thread, an unknown id is refused. New md threads need words occurring once in plain text. html threads anchor as `{path: "", tag, text}`, resolved by the app's `resolveAnchor` (`htmlBridge.ts`). Stamps are to the second; finer would make every Mac rewrite the sidecar.
- No history, presence, lease or sync in the CLI: undo is the Macs' version store.

## Boards (`agentBoards.ts`, `boardCards.ts`)

- **A board is a board, never a folder** of card `.md` files + `store.jsonl`. Views are human-only (no view, filter, sort, hidden columns); `cards` groups by the first kanban view's field, or `by=`.
- A board = any folder holding `store.jsonl` (nested: part of the outer one). Inside it only cards have names; nothing moves in; it moves whole; it isn't publishable, a card's page is.
- Uses the app's `src/store/` modules, so bytes match the app's. Values parse against field types; select values must be declared options; `rank` is never a field; undeclared keys are kept, never set.
- Titles are unique case-insensitively (`taken`, never `Title 2`); `/` `:` → `-`; a retitle moves note, sidecar, html.
- Board changes take no `if-rev` (commit over latest bytes); page writes do.
- Card page `<board>/<card>`: reads omit the properties block, writes splice it back as on disk (as `splice_body`, `src-tauri/src/store.rs`), a page starting with its own block is refused; comment and search lines count from the page.
- `board_cards`: lazy fid + hash cache, written only by reads; ≤ 32 stale cards a request (`CATCH_UP_CARDS`), then `202`. Option renames rewrite cards in `202` rounds; removing an option or field touches none.

## Search (`search.ts`)

- `search_text`: per document, lower-cased text (markers or tags stripped) + comment bodies; too big → `notSearched`. A search catches up first (≤ 8 inline, else `202` after ≤ 36). API writes catch up via `ctx.waitUntil`; a Mac's PUT never does (no D1 write per save). Query `instr(folded, ?) > 0`.

## CLI (`cli/`)

- Thin: never names a sidecar, pairs md/html, parses a store or builds a manifest.
- Token only in `~/.config/doklin/credentials.json` (`$XDG_CONFIG_HOME`), 0600 in 0700, one entry per domain; `-w` picks.
- Exit codes are a contract: `0` ok · `1` other · `2` usage · `3` not found · `4` not permitted · `5` conflict · `6` not logged in/revoked · `7` worker too old (missing feature, or an unknown route's 404/405).
- JSON when stdout isn't a TTY or with `--json`; `read` puts content on stdout, metadata on stderr. `--dry-run` on every change; re-asks on `202`; board commands read stdin only with `--from -`.
- On a Mac a non-command argument opens that path in the app. Install: `CLI_INSTALL_LINE` (`scripts/install-doklin.sh`).
- Concepts: `doklin help agent|documents|comments|publishing|boards`.

## Limits

- No Doklin rate limits; the worker counts nothing. The owner removes a runaway agent.
- Free-plan caps: 100k Worker requests/day (then errors until 00:00 UTC), 50 subrequests and 10 ms CPU a request, D1 5M rows read / 100k written a day. Hence batches and `202`s.
- An agent write costs ~`1 + 2 × Macs online` requests. Watch: `scripts/cloud-usage.sh <domain> [days]`. Unmeasured: write CPU at 5,000 files.
