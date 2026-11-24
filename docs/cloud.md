# Cloud

A workspace connects to one domain: a Cloudflare Worker + R2 bucket + D1
database on the user's own account. Connected = the folder's documents are
backed up and synced on every Mac holding it; publishing is a flag in the
synced manifest, rendered by the worker from the synced files.

- [cloud-worker/README.md](../cloud-worker/README.md) — wire contract: routes, bucket, D1, manifest v4, auth.
- [cloud-publishing.md](cloud-publishing.md) — public pages.
- [cloud-people-agents.md](cloud-people-agents.md) — members, presence, leases, agents, document API, CLI, limits.
- [versioning.md](versioning.md) — history (the cloud mirrors the version store).

## Vocabulary

- **Workspace** — the folder Doklin opens; unit of sync and publishing. Untitled notes are in none.
- **Domain** — a worker's hostname (custom or `workers.dev`). "Backend" here means the app's Rust side, never the worker.
- **Section** — a part of a workspace with its own people: Library (everyone; the *shared section*), a person's Private, a restricted folder. The last two are *spaces* on the domain; the shared section is the bucket's root, space id `""`.
- **Engine** — the Rust task syncing a workspace. **Unit** — its sync of one section.
- **Manifest** — a section's one mutable object: every file's path, rev, hash, plus the public map.
- **Key** — worker secret `OWNER_TOKEN`, minted by the app for setup and for each recovery and set on the worker by an agent. Never a sign-in: traded once for a device sign-in as the superadmin. No device keeps it.
- **Superadmin** — the one person who last traded a key, i.e. whoever controls the Cloudflare account. Theirs on every device; no device is special ([cloud-people-agents.md](cloud-people-agents.md) *Credentials*).

## Rules

1. **One domain ⇄ one workspace.** A second bind is `409` → the app offers join, never a second binding. Only the superadmin's wipe frees a domain. A folder whose marker names domain A cannot connect to B.
2. **The engine is the only code that holds a token or talks to the domain.** The frontend never fetches: commands in, events out. It sees a key only to put it in a prompt (`cloud_mint_token`), and a token only to hand it from one command to the next. The worker writes the manifest only for callers with no engine — an agent, a person in a browser — by the same CAS. A browser holds no token either: its sign-in is a cookie no script can read ([cloud-people-agents.md](cloud-people-agents.md) *A browser*). True of the iPhone's screens too: Swift calls the same commands, and the token it hands from `cloud_redeem` to `cloud_join` is kept by the engine, in the Keychain (`Host::secrets`).
3. **The manifest is the only truth about what is public.** The frontend's view is `CloudStatus.public`; no `localStorage` registry.
4. **A public page is a rendering of synced files.** The worker stores no page content.
5. **Disk is the source of truth for content.** Merge, never clobber; overlaps become a conflict copy beside the file; deletions go to the macOS Trash (`Host::trash`). The iPhone has none: a deletion there is outright, and the version store keeps what went.
6. **A skewed app/worker refuses legibly and never corrupts** (see Worker versions).
7. **No accounts, dashboard or terminal for the user.** Setup and teardown are prompts for an agent running wrangler; the update is a script.
8. **The worker imports only pure `src/` modules** — nothing touching Tauri or React.
9. **The engine crate (`engine/`) knows nothing of the app around it**: no Tauri, no Swift, no `cfg` on which app. What differs is said once in `Setup` and asked through `Host` (`engine/src/host.rs`). A command is written once, in the engine; each app only reaches it. The browser version builds in no engine and answers the few commands it has (the status, a page's link, publishing, the beat) in TypeScript (`src/web/`): each says which engine function it follows, **change both**.
10. **Only documents sync**: markdown, html and each document's comments (`<stem>.meta.jsonl`) — `syncs` (`engine/src/lib.rs` ⇄ `cloud-worker/src/layout.ts`, **change both**). Everything else stays on its device: the scan, the edit bus, the version store and the export never see it, and the worker refuses it.
11. **Only a client that does not send protects the account's day** (Workers Free: 100,000 requests a day for the whole account, reset 00:00 UTC; past it every request gets Cloudflare's 1027 page). A request the worker refuses is already counted. So the engine and the CLI pace themselves; the worker's `[[ratelimits]]` only catch loops.

## Who owns what

| Area | Where |
| --- | --- |
| Worker | `cloud-worker/src/`; bundled to one file by `scripts/bundle-worker.mjs`, released as `doklin-cloud-worker.js` beside its static assets, `doklin-cloud-web.tar.gz` |
| Engine crate | `engine/`: `host.rs` `Core`, `Setup`, `Host` · `paths.rs` paths as written down · `command.rs` every command by name · `cloud/` · `versions/` ([versioning.md](versioning.md)) · `ffi/` the C interface for the iPhone ([ios.md](ios.md)) |
| Engine | `engine/src/cloud/`: `mod.rs` manager, commands · `engine.rs` task, poll, presence, status, sections · `unit.rs` one section's cycle · `space.rs` sections on disk · `remote.rs` `Remote` + `HttpRemote` · `pace.rs` request count, allowances, bulk lane · `flows.rs` bind, download, wipe · `merge.rs` · `scan.rs` · `bus.rs` · `config.rs` · `invite.rs` · `manifest.rs` wire types · `status.rs` · `versions.rs` version mirror · `tests.rs` in-memory worker |
| Mac app's side | `src-tauri/src/engine.rs` its `Setup` and `Host` · `cloud.rs`, `versions.rs` one Tauri command per engine command · `edits.rs` the edit bus (`Core::touched`) |
| Frontend contract | `src/cloud.ts`: types, shared derivations · `Cloud` in `src/backend.ts`: a method per command and per event, answered by `src/mac/backend.ts` |
| Prompts, naming | `src/cloudPrompts.ts` (`build*Prompt`, `resourceName`, `deploymentNames`) |
| Surfaces (`src/`) | `App.tsx` (`cloudStatuses`), `CloudPanel`, `CloudSetup` (wizard), `CloudPeople`, `CloudAgents`, `WorkerUpdate`, `LiveChip`, `PublishFolder`, `PublishedPages`, `SyncStatus`, `LeaseBanner`, `Avatar` |
| CLI | `cli/` |

## Engine ⇄ frontend contract

- Commands: `cloud_*` in `engine/src/cloud/mod.rs`, each with a Tauri wrapper in `src-tauri/src/cloud.rs` and an arm in `engine/src/command.rs` (a test fails without the arm), and a method of `Cloud` (`src/backend.ts`) that `src/mac/backend.ts` answers with it. Events (`status.rs`): `cloud-status` (whole `CloudStatus[]` on every change; disconnect = array without it), `cloud-applied`, `cloud-conflict`, `cloud-pending-deletes`, `cloud-pending-adds`, `cloud-progress`, `cloud-address-taken`, `cloud-space-left` (a restricted folder was deleted from this Mac), `cloud-removed` (this Mac's copy was deleted: [cloud-people-agents.md](cloud-people-agents.md) *Losing access*).
- Every path in a status or an event is workspace-relative, whichever section it is in (`Library/x.md`, `Private/x.md`); a lease's `path` is that, lowercased. A section's whole folder is its name: publishing `Library` (a folder) publishes the shared section, and its page's `path` is `Library`; `""` is no section. Pending adds are grouped two levels below a section's folder (`Library` for one directly in it).
- Payload types: `status.rs` serde structs ⇄ `src/cloud.ts` ⇄ `ios/DoklinKit/Sources/DoklinKit/Engine/Payloads.swift`. **Change all three.**
- `CloudStatus` is the frontend's whole cloud model; surfaces derive from it. Phases: `idle syncing offline paused pending-deletes pending-adds revoked worker-outdated limited error`. `usage` says what this device spent today and the mode it puts sync in (*Pacing*); its sentences are the surfaces', from `usage`, except `limited`'s, which is the engine's `error`.
- The Mac reports window focus from Rust (`WindowEvent::Focused` → `cloud_set_focus`, the window's folder from the registry); the iPhone from `woke`/`settle`. No frontend code is involved.
- A status `by` is already a name (resolved via `/api/meta` `people`).

## Engine behaviour

**Inputs** (each wakes a cycle or a poll):
- Edit bus: every app write command ends with `edits::touched(&app, &path)` (→ engine and versioner). A new write command must too. Settles 1.5 s (`TOUCH_SETTLE`). `scan::rel_for_touch` drops hidden segments, the engine's temp files and files that do not sync.
- Watcher (`notify`): settles 5 s (`FS_SETTLE`); optional — the other inputs still sync.
- Poll by attention (`Engine::poll_gap`): every 15 s (`POLL_INTERVAL`) while a window of the workspace is focused and used in the last 5 min; 60 s unfocused or idle 5–30 min; 5 min idle longer; a focus after a quiet spell polls at once. `GET /api/poll`, or `POST` when a presence beat is owed (at most every 45 s, `PRESENCE_BEAT`); the beat's `ttl` is 2.5 × the gap to the next one (90 s–15 min), so an idle device stays listed. A new etag — the shared manifest's or a space's, all in the one answer — triggers a pass, and so does a poll that gets through while the phase is `offline`.
- Commands: `EngineCmd` in `engine.rs`.
- Hints say *when*, never *what*: the cycle always walks the whole tree and decides from content.

**Sections** (`engine.rs`, `space.rs`):
- On disk the sections sit side by side, and every path names its section: `Library/` (the shared unit, `LIBRARY_DIR` ⇄ `LIBRARY_FOLDER` in `layout.ts` ⇄ `src/cloud.ts` ⇄ `TreeModel.libraryFolder` in the iPhone's `Tree.swift`: **change all four**), `Private/`, `Restricted/<folder>/`. The three names are found in any case (`space::top`). Hidden entries at the root are the folder's, not a section's.
- **Anything else at the root is in no section**: it stays on this device and syncs nowhere (`Engine::place` answers none, so the edit bus drops its touch). So is the root itself.
- Inside Library, a folder called `Library`, `Private` or `Restricted` at its top is in no section: the shared unit and `seed_upload` never walk them, and the worker refuses a shared manifest that names a path under one (`RESERVED_DIRS`, `space.rs` ⇄ `RESERVED_FOLDERS`, `layout.ts`: **change both**). `Private` and `Restricted` because a device in the layout from before Library mounts the shared section at its root, where a shared `Private/x.md` would land in its own Private. `Library` because a build from before the layout, run on a moved folder, sends every shared file as moved under `Library/`: the refusal stops it there. The apps refuse to make or rename a folder to one of the three there; one Finder makes shows as not synced.
- **`Library/` missing** (deleted, or renamed in Finder — it is then a stray) is a section to bring back whole, never a folder whose files were deleted (`Engine::mend_library`): the shared unit's sync state is dropped and everything downloads again. Never tombstones. Something that is not a folder under that name is phase `error` with a sentence, and nothing is dropped.
- Manifests, tombstones' `to`, presence, leases and every wire path stay relative to their section.
- A folder is a space by its marker, `<folder>/.doklin/space.json` `{wsId, space, name}`. That marker is the only record of which folders are spaces; a folder without it is never deleted.
- `reconcile_spaces` runs after every poll that lists spaces, and before a pass when a folder under `Restricted/` has no marker or a unit's folder is missing:
  - listed, no folder → make it, download;
  - a restricted folder no longer listed → deleted outright, with its sync state and version store. Never a Private: a list without one is mended (`PUT /api/spaces/private`);
  - an unmarked folder under `Restricted/` → `POST /api/spaces` (only its maker in it);
  - renamed here → `PATCH` the name; renamed elsewhere → the folder follows (`names_space` tells the two apart);
  - a unit whose folder is gone → its state is wiped and the folder comes back whole. Never tombstones.
- `spaces: null` in a poll changes nothing.
- A space's routes answering `404` stop that unit until the next poll says whether its person is still in it.
- A file directly under `Restricted/` is in no section and syncs nowhere.
- The reserved names are reserved in any case (`space::top`); a section's paths are spelled as the disk spells its folder (`space::spelled`).
- A folder's name on a Mac must be one `names_space` accepts for the space's name, or the next reconcile reads it as a rename and `PATCH`es the space. So only the engine names a new restricted folder (`free_restricted_dir`): the app asks it to (`make_space`), and never makes one under `Restricted/` itself.
- `make_space` with a folder renames that folder into `Restricted/`: its files then leave their section as moves. It refuses while `spaces` is `None`: adding to a list the domain has not given would make every folder missing from it look left.
- Leaving or deleting a folder on this Mac drops it from `spaces` and reconciles at once; other Macs learn from their poll. Either way the folder's going emits `cloud-space-left`.
- `CloudStatus.spaces` is drawn from the units, so a Mac that started offline still lists its folders (no members, kind by where the folder is).

**The move into Library** (`layout.rs`), what connecting a folder does to its files:
- The marker's `layout`: absent (not moved yet), `"moving"`, `"library"`. The steps and how each is resumed after a crash are in `layout.rs`'s header. Renames only, never copies.
- When: `cloud_connect` (after the marker, before `seed_upload`, which uploads `Library/`) and `cloud_resume` (a folder whose files are not in Library yet). Both stop the root's versioner once the move has begun (`versions::release_root`) and reconcile after. The Mac moves what it stores about the folder's paths with it (*Sections in the app*).
- **A folder that holds something called `Library` at its top does not move** until that is renamed (`layout::begin`), and `cloud_connect` refuses it before the domain is bound: carried into Library it would be under a reserved name, and a shared folder there would read as deleted.
- **No engine syncs a folder that is not in the Library layout** (`layout::ready`, checked at the start of every pass and of `reconcile_spaces`): no marker, an unfinished move, or a layout a later build wrote is phase `error` with a sentence. A connected folder whose files are not in Library is disconnected and resumed, which moves them.
- **Traps.** Never move while an engine or a watcher runs for the root: with the shared unit at the root, `x` → `Library/x` reads as a move and every device follows it. Never point the shared unit at `Library/` before every file is in it: a partly moved tree reads as deletions. Never run an older build on a moved folder — the first trap from the other side; a revert of this layout on `main` ships exactly that, so fix forward. A worker that reserves `Library` refuses what such a build sends, so it stops syncing instead of moving every device's files; a worker from before that takes it.

**Sections in the app** (`Sidebar.tsx`, `App.tsx`, `src/cloud.ts`):
- `placeOf(cloud, rel)` is the one answer to "who can open this path". `nowhere` = the root, anything at it outside the three sections, a section's name at the top of Library, a file directly under `Restricted/` and a folder there that is no space.
- The tree of a connected workspace is three headings — Library, Restricted, Private — and never says "Workspace". Each heading stands for its folder (found however the disk spells it) and is never a row of its own. Strays follow under "In no section", each marked as not synced. A folder that is not connected is one "Files" list.
- Whatever would land at a connected root lands in Library: nothing selected, empty space, ⌘V, saving an untitled note, the redirect away from `Restricted/`. The root is never a drop or paste target.
- The Library heading carries the shared section's own items: *Library history…*, *Recently deleted*, *Publish Library…* (a publish of `<root>/Library`). The shared section's history is Library's store (`libraryDirOf`); every versions command for it names `<root>/Library`.
- The Live chip shows only for a file in a section; *Copy link*, *Copy path* and *Restrict access…* are never offered on `nowhere`.
- *Copy path* (`agentPath`) is the path an agent's `doklin` takes, worked out locally: the section spelled as the worker spells it (`SECTION_DIRS` ⇄ `agentPlace.ts`, **change both**), a folder ending in `/`, a document without its extension. No domain: an agent's `doklin` already has it. `Private/…` is the agent's own person's Private.
- Around `cloud_connect`/`cloud_resume`, once the marker says `layout: "library"`, what the app stores about the folder's paths follows by the move's rule (`toLibraryLayout`): the open tabs (autosaves flushed first), `doklin:session` and the open folders of `doklin:sidebar-tree`.
- A move that lets more people see something is confirmed first (`widerAudience`, `confirmMove`; "Move … to Library?"): every drag and every cut-paste goes through it. So is a move into `nowhere`, which takes a file off every other device. Any other move that narrows is not asked about.
- A restricted folder's row is not dragged, cut or trashed: trashing it would only bring it back whole. It is left or deleted from *Manage access…*.
- A note is never dropped straight under `Restricted/` (`canDrop`); a folder dropped there is a new restricted folder, and is confirmed.

**A pass** (`Engine::pass`): survey every unit's folder (stat only, no request), then cycle the units that changed, were poked (a queued page, a confirmed deletion), owe bulk work, or that the poll said moved. *Sync now* and first contact cycle all. With several units in a pass every manifest is fetched before any is applied.

**Pacing** (`pace.rs`; the numbers are the worker's, `limits` in `/api/meta` and every poll, per the plan setting — the engine has none of its own):
- Every request with a bearer is counted in `HttpRemote::auth`, per UTC day, in `<state_dir>/usage.json`; every 15 min one carries `x-doklin-used`, and the poll's `limits.fleetToday` is everyone's sum.
- Express lane: polls, manifest reads/writes, and a cycle's transfers while ≤ 50 (`EXPRESS`). Past that, the bulk lane: a batch (100 files / 8 MB) a cycle from a token bucket (200, refilling at `bulkPerSecond`); the app's own edits (the edit bus) always go express. Downloads too: what a cycle cannot take is `owed` (persisted), never pushed over or read as deleted until it arrives. The mirror draws on the same bucket.
- Modes: `bulk-waits` (this device past `deviceBulk`, liftable for the day by `cloud_lift_wait`; or everyone past `fleetBulkWaits`, not liftable) — bulk waits for 00:00 UTC; `slow` (past `deviceCeiling` or `fleetSlow`) — no bulk, a poll and a pass a minute at most.
- A worker whose `/api/meta` carries no `limits` predates them: `worker-outdated` until it is updated.
- A connect or a join is a person's own act and is not paced.

**The retry clock** (`Engine::clock`): a failed pass, poll or probe pushes the next try out 15 s, 30 s, 1, 2, 5, then 10 min (±20 %); a success resets it; a touch during it waits for it; a command from the person does not. `429` (`RemoteError::Slowed`) waits at least its `Retry-After` and leaves the phase, with "The domain asked this Mac to slow down." Cloudflare's 1027 page (`RemoteError::DailyLimit`, recognised by a non-JSON body naming 1027): phase `limited`, nothing sent but a probe every 30 min until 00:00 UTC plus up to 10 min.

**A move between sections:**
- Here (`pair_moves`): a file gone from one unit and new in another with the same name and hash. The unit it went to cycles first; the source tombstone carries `to` and is written only once the destination holds the file; it never counts toward the mass-delete valve.
- Its public page follows (`carry_pages`): a Remove in the source, a Put in the destination that waits for it (`Ctx::releasing`).
- Elsewhere (`relocate`, a tombstone with `to`): a Mac in that section moves its copy there — adopted by hash, nothing downloaded; an unsynced edit carries on when it was made from exactly what the destination holds, else lands as a conflict copy. A Mac not in it deletes the copy outright (not the Trash) and prunes the emptied folders.

**The cycle** (`Unit::cycle_inner`), one section's:
1. fetch the manifest since our etag;
2. `apply_remote`: downloads, renames, tombstoned deletions to the Trash; three-way merge (`merge.rs`, diffy) where both sides moved; conflict copy `Name (conflict — Alice, Jul 11 14.32).md` on overlap, binary content or no base. A sidecar is merged by its records, never conflicts and never gets a copy (`engine/src/sidecar.rs` ⇄ `mergeMeta` in `src/web/merge.ts`, **change both**; `comments-fixture.json`'s `mergeMeta` holds them alike). When both sides file one link destination under two different files, the one whose file is in any section's manifest wins, else the lowest id. A document's conflict copy gets a copy of its sidecar, made once the pass is done, so it holds both sides' records. Identical bytes on both sides are adopted as synced, never merged;
3. `scan_local` + `stage_local`; mass-delete valve: > 30 % of files and ≥ 5 gone in one scan → hold, phase `pending-deletes`, wait for `cloud_confirm_deletes`. Many-new-documents valve (`Engine::weigh_new`, from the surveys, across units): `manyNew` (200) or more new documents in one pass — not renames, not moves between sections — are held, phase `pending-adds`, `cloud-pending-adds` once; `cloud_confirm_adds {sync: true}` sends them (and lifts this device's bulk wait for the day), `false` leaves them until more arrive or *Sync now*. Held in memory, found again after a restart;
4. `build_manifest` + `fold_public`;
5. upload blobs, then CAS the manifest; a lost race refetches and redoes, 4 attempts. A new file's id is written down before its bytes go (`pending_new`) and each upload once it lands (`uploaded`, 12 h), so a lost race, a batch, a quit or a crash sends nothing twice and leaves nothing under an id no manifest names.

**Traps.**
- Leaving a manifest without a tombstone is a deletion (`apply_remote`). So anything a rule takes out of the manifests (the md + html rule) leaves every device's state first (`forget_out_of_scope`, on load), and every device updates before the worker.
- A cycle that holds bulk work leaves `Unit::owes`; the task comes back for it when the bucket holds a batch (`bulk_due`), or at the reset while bulk waits.
- Every fallible step lives in `cycle_inner` so every exit funnels through `pass`'s one status report; a `?` in `pass` skips offline/revoked reporting.
- `409 {taken}` on a manifest (`RemoteError::Taken`): the queued page is dropped, `cloud-address-taken` says so, the rest of the cycle goes again.
- A missing root (unmounted, renamed) touches nothing: phase `error`.
- After a merge the stored disk snapshot is left stale on purpose so the next scan re-hashes and pushes the merged bytes. Refreshing it silently drops the push.
- Tombstones expire after 30 days: `TOMBSTONE_TTL_MS` in `engine.rs` ⇄ `commit.ts`. **Change both.** A move keeps `mtime` in both (`staged.moves` ⇄ `Tx.move`).
- No device deletes a stored copy (`blobs/<fid>/<hash>`): the worker's daily sweep does (`cloud-worker/src/sweep.ts`, a cron trigger), taking every copy its section's manifest doesn't name once it is a day old (`SWEEP_MIN_AGE_MS`). A push uploads before its manifest write, so `UPLOADED_TTL_MS` (12 h) stays inside that day — **change both**. A re-upload of a stored copy's own bytes stores it again, so a file back to an old version restarts that copy's day. Trap: a copy named in the second between a sweep's listing and its delete is still lost; a download of it 404s until the file's next edit.
- `426` on PUT → `worker-outdated`: sync pauses, probing `/api/meta` each poll until a newer worker answers.
- `by` is a member id (`MEMBER_ID_RE`) or an agent id (`AGENT_ID_RE`), both `layout.ts`. An unknown id refetches the directory at most every 5 min (`DIRECTORY_MIN_GAP`); an id it cannot name shows as it stands.

## Links (`link.rs`, `mod.rs`)

*Copy link* gives a link that opens a document in Doklin for anybody who can see it, wherever it is clicked (only documents sync, so only they have one): `https://doklin.cc/open#d=<domain>&w=<wsId>&s=<space id>&f=<file id>` (`s` absent for the shared workspace).

- **Everything is after the `#`**, which no browser sends to a server: doklin.cc, its logs and a chat app's preview bot never learn the workspace or the page. doklin.cc serves one static page for every link (`site/public/open.html`) and stores nothing.
- **Ids, never a path or a title**: a rename or a move keeps the link. A file keeps its id when it moves to another section — the engine's move (`moved_in`, `unit.rs`) and the worker's (`land`, `changes.ts`): **change both** — so an id is looked for in every section this person holds, the link's `s` first (`Engine::follow`, `pathOfFile` in `src/web/workspace.ts`, `getFind`: **change all three**). While a move is half done one id is in two sections: `s` wins, else the lowest section id. A section that already holds a file by that id gives the arrival a new one.
- **An address, never access.** Being in that section is what opens it; a link never carries a code. A space this person is not in, a deleted file and one that never was are one answer, so a restricted folder is never told apart from nothing.
- `cloud_link` (absolute path → `{url, who}`) asks the engine for the file's section and id; a file with no id yet waits one pass. `cloud_follow_link` (link → absolute path) finds the workspace by `wsId` in `cloud.json` and the file in that section's synced state, offline; one not here yet waits one poll. Same domain, other `wsId` = the domain was set up again. `cloud_link_target` (link → `{domain, wsId, root}`) reads only the link and `cloud.json`: which workspace it is in, and whether this device holds it.
- **A link from one note to another is an ordinary relative markdown link**; its note's sidecar files the id of the file it means, one record per destination (`{"t":"link","id":<destination, decoded and folded>,"file":<fid>}`, `src/metaFile.ts`). A link with a record opens the file with that id in any section, never the one at its path, which may be another person's; one without goes by its path. The rules (the key, resolving, the words a named link shows, what a save writes) are `src/docLinks.ts`'s, ported for the iPhone's reader (`Markdown/Links.swift`) and held to `verify-harness/links-fixture.json`: **change both**. The worker uses the module itself for agents and public pages (`agentLinks.ts`, `pages.ts`). Who can open a document is one sentence in three places: `linked` (`engine.rs`), `linkTo` (`src/web/address.ts`) and `whoCanOpen` (`src/docLinks.ts`), **change all three**.
- `cloud_documents` (`{root}` → every document on this device, every section, with its file id; null for a folder that doesn't sync, whose tree the app lists) is what links are resolved against, read off the synced state and the folders, offline. A note's html rendition is part of the note (`documents_of` ⇄ `documentsOf`, **change both**). `WorkspaceDocument` in `status.rs` ⇄ `src/docLinks.ts` ⇄ `Payloads.swift`: **change all three**.
- `cloud_recent` (`{root, limit}` → `{files, people, me}`) is what changed lately, read off each section's last applied manifest (`mtime`, `by`, `rev`, `hash`) and the folder — a file changed here since it last synced is this device's, unsynced (`hash` null); a move keeps `mtime` — with the directory beside it. It asks the domain nothing. `RecentFiles` in `status.rs` ⇄ `Payloads.swift` ⇄ `src/cloud.ts`: **change all three**.
- How a link reaches an app: an iPhone opens it straight from doklin.cc (`ios/Doklin.entitlements` + `site/public/.well-known/apple-app-site-association`); anything else gets the page, which hands it on as `doklin://open#…` (the scheme in `src-tauri/Info.plist`, `ios/Info.plist`) — at once on a Mac, on a tap elsewhere. A click on one inside a note never leaves the app (`open_external`, `src-tauri/src/links.rs`; `Workspaces.isPageLink` on the iPhone). `doklin` takes one wherever a document is named (`GET find`), and `doklin info` gives one.
- On a computer the page also offers the browser version, `https://<d>/app#w=…&s=…&f=…` (`takeLink`, `src/web/address.ts`): beside the app on a Mac, the one button anywhere else. **doklin.cc never sends anybody to a domain they did not choose on a page that names it**: a first visit waits for a click, and only a domain ticked *Always* (`browser:<domain>` in doklin.cc's `localStorage`) is gone to without one. A page that skips itself is never in the browser's history, so Back cannot undo that: `doklin.cc/open` with no link after it is where it is undone. `d` must be `is_domain` (`isDomain` in `open.html`: **change both**) or the link is cut short.
- A phone or a tablet is never offered the browser version, whatever was ticked: an iPhone and an iPad keep the app's button, anything else is told to use a computer. What counts as one is `src/web/gate.js`'s, said again in `open.html`: **change both** (`link.rs`'s tests hold the two together).
- `doklin://` only ever navigates: any web page can fire it.
- The address, scheme and keys are said in `link.rs`, `open.html`, `src/pageLink.ts`, both `Info.plist`s, the entitlements, `cli/src/link.rs` and `Workspaces.isPageLink`; the association file names the app as the Xcode project does. `link.rs`'s tests hold every one of them to it: **change all of them together.**

## Flows (`flows.rs`, `mod.rs`)

- **Connect**: name + email asked first → mint key → setup prompt → agent prints `ENDPOINT: https://…` → `cloud_probe` (with the key) → `cloud_recover` trades it for this Mac's sign-in → `cloud_connect` binds with that, writes the marker, moves the folder's files into `Library/` (hidden ones stay), uploads `Library/`, writes `cloud.json`, spawns the engine.
- **Recover** (every device lost): address + name + email → mint key → recovery prompt (`secret put OWNER_TOKEN --name <worker>`, nothing else) → probe → `cloud_recover` → `cloud_join` or `cloud_resume`. Whoever recovers is the superadmin from then on.
- **A key works once** (`spent_keys`): a step after the trade that fails is retried with the token it bought, never the key. A lost key costs nothing — the next recovery mints another, and no device syncs on one.
- **Already bound** (probe shows a workspace): *Download it* (`cloud_join` into `~/Doklin/<name>/Library/`, made even when the workspace is empty; the marker says `layout: "library"`) or, when the open folder's marker has that `wsId`, *Resume* (`cloud_resume`). Never "bind anyway".
- **Resume**: the move first, for a folder whose files are not in Library yet; then empty engine state; `stage_local` adopts remote fileIds by path, identical bytes count as synced, merges own the rest (reinstall, restored folder).
- **Join** (a line: an invite, or a device code from another device of the person's): `cloud_redeem` → `cloud_join`, or `cloud_resume` when the open folder's marker has that `wsId`.
- **Never trade for a domain this device holds.** One copy a device per domain, and every step after a trade refuses a second, so `cloud_redeem` and `cloud_recover` refuse first and what was to be spent still works. The wizard asks `cloud_held` before it trades: a copy that syncs is opened; one that has stopped (`revoked`, or its folder gone) is disconnected, then the trade goes on.
- **Disconnect**: stop the engine, end this Mac's sign-in, drop the `cloud.json` entry and state; folder, marker and cloud stay.
- **Wipe** (`cloud_wipe`, superadmin): erase via the worker, then disconnect **including the marker**, so nothing re-uploads into the freed domain; then the teardown prompt.

## Local files

- `<app_data_dir>/cloud.json`: `{version, device: {id, name}, workspaces: [{root, domain, endpoint, wsId, name, token}]}`. One entry per root and per domain; parsed by shape (malformed = nothing connected; an entry with no token = not connected). It is read and written only by `read_cloud_file`/`write_cloud_file` (`cloud/config.rs`).
- Where the token lives: in that entry on a Mac. An app whose `Host::secrets` keeps sign-ins (the iPhone: its Keychain, by `wsId`, this device only, never in a backup) gets each token there and finds `token: ""` in the file; a workspace dropped from the file has its kept sign-in deleted with it. A sign-in the keeper cannot read just now leaves that entry out of the engine and writes it back untouched. The phone keeps its engine files out of backups, so a restored phone has no device id or entries either, and joins again as a new device.
- `<root>/.doklin/cloud.json`: the marker `{domain, wsId, layout}` (`layout`: *The move into Library*). Never a secret (a copied folder must not carry a credential). Hidden, so tree walk, search and scan skip it. A marker with no `cloud.json` entry → offer *Resume*.
- `<app_data_dir>/cloud/<wsId>/state.json` + `base/`: last applied manifest and etag, per-file synced state, queued public ops; merge bases. Each space's are under `spaces/<spaceId>/` in it.
- `<folder>/.doklin/space.json`: a space's marker (*Sections*). No secret.

## Worker versions and updates

- `cloud-worker/src/version.ts` is the one source of `WORKER_VERSION`, `MANIFEST_VERSION`, `COMPATIBILITY_DATE`. Parsed, never copied, by `engine/build.rs`, `vite.config.ts` (`virtual:cloud-worker-version`) and the bundle script: keep the one-line shape `/^export const WORKER_VERSION = (\d+);$/m`.
- **Bump `WORKER_VERSION` for every wire change and any change to how a public page looks** (renderer, theme, tokens, fonts). It drives the update badge; without it deployed domains never update.
- `WORKER_VERSION` is the one thing read off a worker about what it does: no feature list, nothing gated on one. The engine, app and CLI expect every route and field of the version they were built with.
- Neither side must work with the other's next release; a skewed pair must say so (badge, `worker-outdated`, `426`) and never corrupt. So retired routes and fields are deleted, not kept.
- Move `COMPATIBILITY_DATE` only on purpose: it changes every new deploy's runtime.
- Bundle < 3 MB gzipped (the script fails past it). What public pages ask for — fonts, icons, the flowchart module — is not in it: the script writes it to `doklin-cloud-web/` beside the worker, which Cloudflare serves as static assets. The checked-in `cloud-worker/src/assets.ts` says `WEB_TAG = "dev"`; the bundle script splices in the build's tag (the flowchart module's hash).
- **Update** = `scripts/doklin-cloud-update.sh <endpoint>` (release asset; `updateCommands`). Names from the endpoint (`deploymentNames`); confirms worker, bucket and D1 database exist first (deploying a missing name creates a second worker) and creates nothing; done when unauthenticated `/api/meta` answers `401`. Overrides `WORKER_NAME=`, `BUCKET_NAME=`, `D1_NAME=`. No secret.
- **Setup prompt** checks names are free first (a same-name deploy silently replaces a worker) and that `/api/meta`'s `d1` is a number. **Teardown** runs after the wipe, never forces a non-empty bucket. `wrangler.toml` is never committed. `verify-harness/cloudprompts.test.mjs` pins prompts and script to the naming rule and compatibility date.
