# Cloud: people and agents

Routes, tables, status codes: [cloud-worker/README.md](../cloud-worker/README.md). Sync rules: [cloud.md](cloud.md).

## Credentials

- **Every credential is a row.** No device is matched any other way, so none is special. A database that cannot answer is `503` for every bearer, never `401`: a `401` is what stops a Mac for good.
- **The key** (`OWNER_TOKEN`) is nobody's sign-in. As a bearer it is answered on `GET /api/meta` (no `you`) and `POST /api/auth/recover`, and `403` on every other route. The recover trades it for a device token as the superadmin and spends it in the same batch, first (`spent_keys`, by sha256; a wipe keeps it), so a copy left in an agent's chat lets nobody in.
- **The superadmin** is the one person the `superadmin` table names: whoever last traded a key, which only the Cloudflare account can set. A trade naming another email moves the role to them — the only way it moves; nothing in the app hands it over — and the one before keeps `owner` on their row. The role is theirs on every device of theirs. Their row is never removed or demoted, and only they sign out a device of theirs.
- A token carries its person's role (`superadmin` off that table, else `members.role`), read on every request, so a role change bites on the next call. There can be several owners.
- Who may do what is one table: `can(role, action)` in `roles.ts`. Every gated route asks it; `/api/meta` answers the caller's row as `you.can` and the app hides by it (`may` / `mayOn`, `src/cloud.ts`). An empty `can` on a status means not yet known: `mayOn` hides the control until the domain answers, and the iPhone's `CloudStatus.may` shows it, since what it gates includes editing, which works offline. Change a permission there, nowhere else.
- A member is not a limited account: `PUT /api/manifest` isn't role-gated. Owners = invite, remove, sign out, roles, other people's agents, every public address. The superadmin alone = bind, wipe, the update card (`workspace.manage`), and a new code for somebody who has signed in before (`people.recover`).
- Nobody removes or demotes their own row, or signs out the device the call is made with.
- Codes are 100 bits (Crockford base32): no throttle, lockout or counter. Revoking a row bites on the next request.
- `last_seen_at` (beat) and `last_used_at` (agent request) move at most hourly.

## People

- A member is keyed by normalized email (`m-` + 8 hex): re-inviting an address reaches the same person. Member ids enter the manifest, emails never.
- **A removed person's row is never deleted** (`members.disabled`): out of the People list and unable to sign in, still in the directory so what they wrote keeps their name. Inviting the address again is the same person, a member, with their Private; restricted folders they were in are not given back.
- The address is never verified, so a code is whoever redeems it. Once somebody has signed in as a person (`lastSeenAt` set — a redeem or a trade sets it — or the superadmin's row), a new code for them is only theirs or the superadmin's to make: the superadmin controls the account the workspace is stored on and can read all of it anyway. Before that the row is an invitation any owner may re-issue (`mayInviteAgain`, `src/cloud.ts` ⇄ `mayInviteAgain`, the iPhone's `People.swift` ⇄ `createInvite`, `api.ts`: **change all three**).
- Invite: the owner's Mac mints `dkln-XXXXX-XXXXX-XXXXX-XXXXX` (`invite.rs`) and sends only its sha256; 7 days default; cap `MAX_DAYS` ⇄ `MAX_INVITE_TTL_MS`, **change both**. Line: `doklin-invite <endpoint> <code>`. `normalize_code` ⇄ `normalizeCode` (`members.ts`) must match exactly: **change both**.
- Redeem runs first (`/api/meta` is behind the gate): `cloud_redeem`, then probe, `cloud_join`. The code is spent at redeem; later failures retry the probe only.
- `CloudPeople.tsx` asks (`cloud_people`), never stores: no role is on disk. Everyone reads the list; lists a role may not act on come back empty.
- `cloud_join(endpoint, token)` asks for no folder: the workspace lands in `~/Doklin/<name>` (`Name 2` when taken).
- An owner's unused codes go with them: removing or demoting an owner withdraws **every** pending invite, device codes among them. Otherwise a removed owner returns on a code they kept.

## Devices

- A device (a Mac, an iPhone) is a row in `tokens`: one sign-in, one device. It gets there by `POST /api/auth/join` and no other way — with an invite somebody made for its person, or a **device code** that person made for themselves (`cloud_device_code` → `POST /api/auth/devices/code`).
- To the domain a device code is that person's pending invite: same table, same grammar, same line (`doklin-invite <endpoint> <code>`), same redeem, one pending code a person. Never give it a prefix, a table or a route of its own to redeem.
- **No token or key is ever shown or carried between two devices.** Lost every device: a member asks the superadmin for a new code; the superadmin recovers with the Cloudflare account ([cloud.md](cloud.md) *Flows*).
- Everyone lists and signs out their own (`devices.own`); an owner anybody's but the superadmin's (`people.remove`; `409` for one of theirs). Somebody else's is a `404` to a member.
- Signing a device out is a removal (`removed_tokens`: it deletes its copy). A device leaving is not: `DELETE /api/auth/session` forgets the row and says nothing. Disconnect calls it, bounded by `END_SESSION_WAIT` and never waited on to succeed; a wipe does not (it empties the table).
- `DEVICE_CODE_MINUTES` (`invite.rs`) is the lifetime; the worker's `MAX_DEVICE_CODE_TTL_MS` is looser only to absorb clock skew.
- A join whose open folder carries that workspace's marker offers *Resume* (`CloudSetup.tsx`): the only way a disconnected Mac's folder syncs again, since nobody can type a token for it.

## Losing access (`engine.rs`, `mod.rs`)

- **Only `401 {removed: true}` deletes** (`RemoteError::Removed`). Never infer it from another refusal: a D1 outage answers a bare `401` to every member at once.
- The engine exits `Exit::Removed`; `access_removed` then deletes the folder outright (not the Trash), the local version stores (the workspace's and each section's) and the sync state, drops the `cloud.json` entry and emits `cloud-removed`. Nothing in the cloud is deleted.
- `remove_copy` deletes only a folder whose marker names that domain and `wsId`, resolved through symlinks, and never a path that holds the home directory.
- Every device obeys it, the superadmin's included.
- A removal never lapses: an offline Mac deletes when it next reaches the domain. A wipe empties `removed_tokens`, so it deletes nobody's copy.
- `cloud_removed` returns the removals since launch, for a window that was not listening; a window dedupes by `root` + `at`.

## Spaces (`spaces.ts`, `addresses.ts`)

What a Mac does with them: [cloud.md](cloud.md) *Sections*.

- A space (restricted folder, or a person's Private) is a workspace of its own under `spaces/<id>/`: the sync handlers run unchanged on an `Env` whose bucket is that prefix (`spaceEnv`). **One gate** (`openSpace`) sits before everything under `/api/spaces/<id>`; a new route goes behind it, never beside it.
- **Outside a space it does not exist**, for owners too: same `404` as an unknown id, no name, no count. Presence shows a person is here without the path; leases in it are not listed.
- Nothing about a space is in the shared manifest, the shared blobs or the shared version store.
- Everyone in a restricted folder is equal. The last person cannot leave (`409`); a folder whose last person was removed from the workspace stays stored with nobody in it.
- A Private's id is its person's (`p-<member hex>`), so it cannot be made twice; it never has a second person.
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

- An agent (`a-` + 8 hex) is a name, scopes and the person it belongs to (`agents.member_id`); not a member. The sync cycle has no agent code; the app's agent calls are `HttpRemote` methods, off the `Remote` trait.
- **An agent sees exactly what its person sees**: the shared workspace, their Private, the restricted folders they are in. Its token's `Auth.memberId` is its person, so every "is this person in this space" is the question a Mac's token is asked, on every request: added to a folder, taken out, the agent follows on its next call. Scopes limit what it does there, never where. Nothing else widens or narrows it.
- Anyone has agents of their own (`agents.own`). Only its person changes one or mints it a login code: a code is a way in as that person, the reason an invite code for somebody who has signed in is theirs to make. An owner (`agents.manage`) is listed everybody's and may remove one or log a machine out, nothing more; to anyone else another person's agent is a `404`.
- Removing a person deletes their agents. Inviting them again brings none back.
- `publish` is off unless ticked (a remote agent can't be asked to confirm). Scopes are per route (`ROUTES`, `agentApi.ts`). The home page is set only in the app.
- **The terminal** (`terminal.rs`): on a Mac the app logs its own `doklin` in to each connected workspace as an agent of the person's, `<name>'s terminal (<Mac>)`, with all four scopes (the person is at the keyboard). It is found by that name among their own agents (`mine`), never remembered — Disconnect forgets the `cloud.json` entry, and a remembered id would make a second agent on reconnect — else made. The code is minted like any other and piped to `doklin login <endpoint> -`, never put in argv; the CLI's `login` stays the one writer of `credentials.json`. A workspace `doklin whoami -w` already answers for is left alone. It runs on *Install Command Line Tool* (every connected workspace; the dialog says how each went) and after connect, join and resume when the terminal runs this app's `doklin`. Disconnect leaves the login.
- The only way in: a `dkla-…` code (`AGENT_PREFIX` ⇄ `normalizeAgentCode`, **change both**), valid 1 h (`AGENT_CODE_MINUTES`; the worker's looser cap absorbs clock skew), shown once in `buildAgentLoginPrompt` (install line + `doklin login <endpoint> <code>`; the iPhone's `AgentPrompt` writes the same words, **change both**). Login deletes the code and mints the machine's `dka_` token in one statement.
- New work goes under `Private/` unless the person names a place — by instruction only: the login prompt and `doklin help agent|sections` say so. Never a setting, a flag or a default folder: a path already says where a thing is.

## Document API

- **Paths are literal** (`agentPlace.ts`), the ones on the person's disk: `Private/…` their Private, `Restricted/<folder>/…` a folder they are in, anything else shared. A call runs in the space its path names, on that space's manifest mounted at its folder (`mount.ts`): every lookup, refusal and answer carries the path as typed, and `commit` takes the change back to the stored form before it is checked. A folder the person is not in answers what a folder nobody made answers.
- A restricted folder is called what a Mac calls it: `folderNames` ⇄ `candidates` (`space.rs`), `folderName` ⇄ `sanitize_folder_name` (`config.rs`). **Change both.** The worker hands the names out in the order the folders were made, a Mac in the order they reached it, so of two folders with one name a Mac may have the other first; `doklin ls Restricted` is what the agent calls each.
- An agent makes, renames and deletes no section and changes nobody's membership; `Private` and `Restricted/<folder>` themselves do not move.
- A move between sections (`moveAcross`) is the one change that is two manifest writes: ≤ 16 files, written where they go first under new file ids, then removed with a tombstone `to` — what a Mac's own cross-section move leaves (`WorkerTx::moved_to`, `tests.rs`). A file that changed in between stays where it is. A page is given up by the write that removes its file and claimed after by the section it went to; one that could not be is answered as `unpublished`.
- A listing, a search or the page list of the workspace itself covers every section, opening ≤ 8 spaces a request (`MAX_SECTIONS_READ`) and naming the ones it left out.
- `find` is where a link to a page leads (`getFind`; the link's format: [cloud.md](cloud.md) *Links*): workspace, space and file id in, the path as this person names it out. Another workspace, a space they are not in, a file gone and one never made are one `404`.
- **The worker is a third writer** (`commit.ts`): read manifest + etag → apply (checks `if-rev` against that manifest; a refusal writes nothing) → `validateManifest` → blobs create-only → manifest `onlyIf etagMatches`; a lost race redoes it. The precondition is the file's `rev`, never the etag. An unchanged manifest isn't written.
- `apply_remote` relies on: new file `f-` + 12 hex, `rev: 1`; edit `rev + 1`, new hash/size/mtime; move new path, `rev + 1`, same hash and mtime; removal a tombstone `{path, rev + 1, ts, by}`; a write over its own tombstone takes the next rev; `seq + 1`; `by` = agent id; a document's files in one write. `WorkerTx` (`tests.rs`) mirrors `Tx`: **change both**. Macs apply it next poll, writing nothing back.
- A **document** = a stem with up to two versions, markdown (`.md .markdown .mdown .mkd`) and html; its sidecar `<stem>.meta.jsonl` never crosses the API. Reads default to md, else html; writes default to md and never guess on html-only. Anything else is a plain file named in full (`locate`, `documents.ts`).
- Refused (would sync to nobody): hidden segments, `IGNORED_NAMES` (⇄ `is_hidden_or_ignored` in engine/src/lib.rs ⇄ `isHiddenOrIgnored` in the iPhone's `Files.swift`, **change all three**), the `.doklin-sync-tmp` suffix, sidecars. A name under an existing folder in another case takes its spelling.
- No silent overwrite: `if-rev: <n>`, `if-rev: *` or `force=1`. Same bytes: `unchanged`. `htmlBehind`: html mtime > 2 s older than md.
- A public entry follows its document: its md file, else its html.
- Comments: reads keep markers (`clean=1` strips) so read-then-write keeps them. **A content write never moves a thread** (`markersKept`, `anchorsKept`): md must carry exactly the old markers, compared as written (moving one with its words is fine); html must leave every thread that resolves resolving. Else `400 comments`, `--force` included — threads change only through the comments routes. New md threads need words occurring once in plain text. html threads anchor as `{path: "", tag, text}`, resolved by the app's `resolveAnchor` (`htmlBridge.ts`). Stamps are to the second; finer would make every Mac rewrite the sidecar.
- No history, presence, lease or sync in the CLI: undo is the Macs' version store.
- The iPhone writes comments into its own copy by the same rules (`placeForMarker`, `anchorProblem`, `threadsOf` here; `src/criticMarkup.ts`, `src/metaFile.ts` on the Mac): its port (`ios/DoklinKit/Sources/DoklinKit/Comments/`) and the TS are held to one set of cases, `verify-harness/comments-fixture.json` (`comments.test.mjs` for the TS, `CommentsTests` for Swift). **Change all of them together.**

## Search (`search.ts`)

- `search_text`: per document, lower-cased text (markers or tags stripped) + comment bodies; too big → `notSearched`. A search catches up first (≤ 8 inline, else `202` after ≤ 36). API writes catch up via `ctx.waitUntil`; a Mac's PUT never does (no D1 write per save). Query `instr(folded, ?) > 0`.
- One mirror per space (`space_id`, `''` shared), keyed `(space_id, fid)`: a file that changes section is in both manifests for a moment, and one section's catch-up must not drop the other's row. A search scans `space_id IN (…)` — the sections its person is in — and never another space's rows.

## CLI (`cli/`)

- Thin: never names a sidecar, pairs md/html or builds a manifest.
- Token only in `~/.config/doklin/credentials.json` (`$XDG_CONFIG_HOME`), 0600 in 0700, one entry per domain; `-w` picks. Trap: the app runs the bundled `doklin` with the app's environment, so an `XDG_CONFIG_HOME` set only in a shell's startup files is not the one its login writes under.
- `login <domain> -` takes the code from the first line piped in — how the app hands one over.
- Exit codes are a contract: `0` ok · `1` other · `2` usage · `3` not found · `4` not permitted · `5` conflict · `6` not logged in/revoked · `7` worker too old (an unknown route's 404/405).
- JSON when stdout isn't a TTY or with `--json`; `read` puts content on stdout, metadata on stderr. `--dry-run` on every change; re-asks on `202`.
- Every word after `doklin` is a command on every system; an unknown one is exit `2`, `doklin` alone is the overview. `open` is the one command about this Mac: it hands paths on this disk, and links, to the app (refused off a Mac, needs no login) and never knows workspaces — the app places them.
- A link to a page is taken wherever a document is named (`TAKE_LINKS`, `main.rs`): one `GET find` turns it into the path before the command runs, in the link's workspace; `-w` naming another is exit `2`.
- One `doklin` per Mac. The app carries it at `Doklin.app/Contents/Helpers/doklin` (`bundle.macOS.files`); *Doklin → Install Command Line Tool* (`cli_install.rs`) links `/usr/local/bin/doklin` to it, replacing what is there and naming a `doklin` the terminal finds first. `CLI_INSTALL_LINE` (`scripts/install-doklin.sh`) is for everything else; on a Mac with the app it links to that copy instead of downloading.
- Concepts: `doklin help agent|sections|documents|comments|publishing`.

## Limits

- No Doklin rate limits; the worker counts nothing. Its person, or an owner, removes a runaway agent.
- Free-plan caps: 100k Worker requests/day (then errors until 00:00 UTC), 50 subrequests and 10 ms CPU a request, D1 5M rows read / 100k written a day. Hence batches and `202`s.
- An agent write costs ~`1 + 2 × Macs online` requests. Watch: `scripts/cloud-usage.sh <domain> [days]`. Unmeasured: write CPU at 5,000 files.
