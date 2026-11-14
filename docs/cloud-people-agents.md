# Cloud: people and agents

Routes, tables, status codes: [cloud-worker/README.md](../cloud-worker/README.md). Sync rules: [cloud.md](cloud.md).

## Credentials

- `auth.ts` matches the owner secret first, with no D1 read, so a D1 outage costs people, never the owner.
- Owner authority is that secret only: a token is always `member`, whatever `members.role` says; the owner's member row (bind, or `cloud_adopt_owner`) is attribution, never authority.
- A member is not a limited account: `PUT /api/manifest` isn't role-gated. Owner-only = bind, wipe, people and agent admin.
- Codes are 100 bits (Crockford base32): no throttle, lockout or counter. Revoking a row bites on the next request.
- `last_seen_at` (beat) and `last_used_at` (agent request) move at most hourly.

## People

- A member is keyed by normalized email (`m-` + 8 hex): re-inviting an address reaches the same person. Member ids enter the manifest, emails never.
- Invite: the owner's Mac mints `dkln-XXXXX-XXXXX-XXXXX-XXXXX` (`invite.rs`) and sends only its sha256; 7 days default; cap `MAX_DAYS` ⇄ `MAX_INVITE_TTL_MS`, **change both**. Line: `doklin-invite <endpoint> <code>`. `normalize_code` ⇄ `normalizeCode` (`members.ts`) must match exactly: **change both**.
- Redeem runs first (`/api/meta` is behind the gate): `cloud_redeem`, then probe, `cloud_join`. The code is spent at redeem; later failures retry the probe only.
- `CloudPeople.tsx` asks the role, never stores it: a `403` from the members route means member.

## Presence and leases (`presence.ts`, `engine.rs`)

- The beat rides `POST /api/poll`; `GET` writes nothing. Owed every 45 s (`PRESENCE_BEAT`; TTL 90 s) and on a new edited path; a failed poll keeps it owed, no early retry. Only a new path, a cycle, the edited document's lease freeing, or a take-over bring a poll forward.
- "Editing" = opened or typed in within 5 min (`ACTIVITY_FRESH`); `cloud_set_activity` fires per tab switch, never per key.
- A beat naming a path claims its lease in one upsert (free, lapsed or already this Mac's; `take: true` regardless) and releases this Mac's others. Key = path lowercased (`lease_key` ⇄ `leaseKey`, **change both**). No reaper: reads filter, beats sweep.
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
