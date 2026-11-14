# Cloud

A workspace connects to one domain: a Cloudflare Worker + R2 bucket + D1
database on the user's own account. Connected = the whole folder is backed
up and synced on every Mac holding it; publishing is a flag in the synced
manifest, rendered by the worker from the synced files.

- [cloud-worker/README.md](../cloud-worker/README.md) — wire contract: routes, bucket, D1, manifest v4, auth.
- [cloud-publishing.md](cloud-publishing.md) — public pages.
- [cloud-people-agents.md](cloud-people-agents.md) — members, presence, leases, agents, document API, CLI, limits.
- [versioning.md](versioning.md) — history (the cloud mirrors the version store).

## Vocabulary

- **Workspace** — the folder Doklin opens; unit of sync and publishing. Untitled notes are in none.
- **Domain** — a worker's hostname (custom or `workers.dev`). "Backend" here means the Tauri side, never the worker.
- **Section** — a part of a workspace with its own people: the shared workspace (everyone), a person's Private, a restricted folder. The last two are *spaces* on the domain.
- **Engine** — the Rust task syncing a workspace. **Unit** — its sync of one section.
- **Manifest** — a section's one mutable object: every file's path, rev, hash, plus the public map.
- **Owner token** — worker secret `OWNER_TOKEN`, minted by the app at setup; whoever holds it is the workspace's creator.

## Rules

1. **One domain ⇄ one workspace.** A second bind is `409` → the app offers join, never a second binding. Only an owner's wipe frees a domain. A folder whose marker names domain A cannot connect to B.
2. **The engine is the only code that holds a token or talks to the domain.** The frontend never fetches: commands in, events out. It sees a token only to display it (`cloud_mint_token`, `cloud_token`). The worker writes the manifest only for agents (no engine), by the same CAS.
3. **The manifest is the only truth about what is public.** The frontend's view is `CloudStatus.public`; no `localStorage` registry.
4. **A public page is a rendering of synced files.** The worker stores no page content.
5. **Disk is the source of truth for content.** Merge, never clobber; overlaps become a conflict copy beside the file; deletions go to the macOS Trash.
6. **A skewed app/worker refuses legibly and never corrupts** (see Worker versions).
7. **No accounts, dashboard or terminal for the user.** Setup and teardown are prompts for an agent running wrangler; the update is a script.
8. **The worker imports only pure `src/` modules** — nothing touching Tauri or React.

## Who owns what

| Area | Where |
| --- | --- |
| Worker | `cloud-worker/src/`; bundled to one file by `scripts/bundle-worker.mjs`, released as `doklin-cloud-worker.js` |
| Engine | `src-tauri/src/cloud/`: `mod.rs` manager, commands · `engine.rs` task, poll, presence, status, sections · `unit.rs` one section's cycle · `space.rs` sections on disk · `remote.rs` `Remote` + `HttpRemote` · `flows.rs` bind, download, wipe · `merge.rs` · `scan.rs` · `bus.rs` · `config.rs` · `invite.rs` · `manifest.rs` wire types · `status.rs` · `versions.rs` version mirror · `tests.rs` in-memory worker |
| Edit bus | `src-tauri/src/edits.rs` |
| Frontend contract | `src/cloud.ts`: types, `invoke` wrappers, listeners, shared derivations |
| Prompts, naming | `src/cloudPrompts.ts` (`build*Prompt`, `resourceName`, `deploymentNames`) |
| Surfaces (`src/`) | `App.tsx` (`cloudStatuses`), `CloudPanel`, `CloudSetup` (wizard), `CloudPeople`, `CloudAgents`, `WorkerUpdate`, `LiveChip`, `PublishFolder`, `PublishedPages`, `SyncStatus`, `LeaseBanner`, `Avatar` |
| CLI | `cli/` |

## Engine ⇄ frontend contract

- Commands: `cloud_*` in `mod.rs`, wrapped in `src/cloud.ts`. Events (`status.rs`): `cloud-status` (whole `CloudStatus[]` on every change; disconnect = array without it), `cloud-applied`, `cloud-conflict`, `cloud-pending-deletes`, `cloud-progress`, `cloud-address-taken`, `cloud-removed` (this Mac's copy was deleted: [cloud-people-agents.md](cloud-people-agents.md) *Losing access*).
- Every path in a status or an event is workspace-relative, whichever section it is in (`Private/x.md`); a lease's `path` is that, lowercased.
- Payload types: `status.rs` serde structs ⇄ `src/cloud.ts`. **Change both.**
- `CloudStatus` is the frontend's whole cloud model; surfaces derive from it. Phases: `idle syncing offline paused pending-deletes revoked worker-outdated error`.
- A status `by` is already a name (resolved via `/api/meta` `people`).

## Engine behaviour

**Inputs** (each wakes a cycle or a poll):
- Edit bus: every app write command ends with `edits::touched(&app, &path)` (→ engine and versioner). A new write command must too. Settles 1.5 s (`TOUCH_SETTLE`). `scan::rel_for_touch` drops hidden segments and the engine's temp files.
- Watcher (`notify`): settles 5 s (`FS_SETTLE`); optional — the other inputs still sync.
- Poll every 15 s (`POLL_INTERVAL`): `GET /api/poll`, or `POST` when a presence beat is owed; a new etag — the shared manifest's or a space's, all in the one answer — triggers a pass, and so does a poll that gets through while the phase is `offline`.
- Commands: `EngineCmd` in `engine.rs`.
- Hints say *when*, never *what*: the cycle always walks the whole tree and decides from content.

**Sections** (`engine.rs`, `space.rs`):
- On disk: the shared workspace is the root, a Private is `Private/`, a restricted folder is `Restricted/<folder>/`. The shared unit never walks the two reserved names, nor does `seed_upload` (`RESERVED_DIRS`, `space.rs` ⇄ `RESERVED_FOLDERS`, `layout.ts`: **change both**).
- A folder is a space by its marker, `<folder>/.doklin/space.json` `{wsId, space, name}`. That marker is the only record of which folders are spaces; a folder without it is never deleted.
- `reconcile_spaces` runs after every poll that lists spaces, and before a pass when a folder under `Restricted/` has no marker or a unit's folder is missing:
  - listed, no folder → make it, download;
  - a restricted folder no longer listed → deleted outright, with its sync state and version store. Never a Private: a list without one is mended (`PUT /api/spaces/private`);
  - an unmarked folder under `Restricted/` → `POST /api/spaces` (only its maker in it);
  - renamed here → `PATCH` the name; renamed elsewhere → the folder follows (`names_space` tells the two apart);
  - a unit whose folder is gone → its state is wiped and the folder comes back whole. Never tombstones.
- `spaces: null` in a poll changes nothing. Gated on the `spaces` feature.
- A space's routes answering `404` stop that unit until the next poll says whether its person is still in it.
- No space has a folder while the shared manifest holds a file under a reserved name (`reserved_clear`): that folder is renamed `Private (shared)` once, after the remote is applied and before the scan (`rescue_reserved`), so the files move rather than vanish.
- A file directly under `Restricted/` is in no section and syncs nowhere. Nor does `Private/` for a creator who never adopted an identity: there is no member row to hang a Private on.
- The reserved names are reserved in any case (`space::top`); a section's paths are spelled as the disk spells its folder (`space::spelled`).

**A pass** (`Engine::pass`): survey every unit's folder (stat only, no request), then cycle the units that changed, were poked (a queued page, a confirmed deletion) or that the poll said moved. *Sync now* and first contact cycle all. With several units in a pass every manifest is fetched before any is applied.

**A move between sections:**
- Here (`pair_moves`): a file gone from one unit and new in another with the same name and hash. The unit it went to cycles first; the source tombstone carries `to` and is written only once the destination holds the file; it never counts toward the mass-delete valve.
- Its public page follows (`carry_pages`): a Remove in the source, a Put in the destination that waits for it (`Ctx::releasing`).
- Elsewhere (`relocate`, a tombstone with `to`): a Mac in that section moves its copy there — adopted by hash, nothing downloaded; an unsynced edit carries on when it was made from exactly what the destination holds, else lands as a conflict copy. A Mac not in it deletes the copy outright (not the Trash) and prunes the emptied folders.

**The cycle** (`Unit::cycle_inner`), one section's:
1. fetch the manifest since our etag;
2. `apply_remote`: downloads, renames, tombstoned deletions to the Trash; three-way merge (`merge.rs`, diffy) where both sides moved; conflict copy `Name (conflict — Alice, Jul 11 14.32).md` on overlap, binary content or no base. Identical bytes on both sides are adopted as synced, never merged;
3. `scan_local` + `stage_local`; mass-delete valve: > 30 % of files and ≥ 5 gone in one scan → hold, phase `pending-deletes`, wait for `cloud_confirm_deletes`;
4. `build_manifest` + `fold_public`;
5. upload blobs (idempotent), then CAS the manifest; a lost race refetches and redoes, 4 attempts.

**Traps.**
- Every fallible step lives in `cycle_inner` so every exit funnels through `pass`'s one status report; a `?` in `pass` skips offline/revoked reporting.
- `409 {taken}` on a manifest (`RemoteError::Taken`): the queued page is dropped, `cloud-address-taken` says so, the rest of the cycle goes again.
- A missing root (unmounted, renamed) touches nothing: phase `error`.
- After a merge the stored disk snapshot is left stale on purpose so the next scan re-hashes and pushes the merged bytes. Refreshing it silently drops the push.
- Tombstones expire after 30 days: `TOMBSTONE_TTL_MS` in `engine.rs` ⇄ `commit.ts`. **Change both.** A move keeps `mtime` in both (`staged.moves` ⇄ `Tx.move`).
- Blob GC: every 20th cycle, unreferenced revisions older than a day only (a racing pusher may have uploaded ahead of its CAS).
- `426` on PUT → `worker-outdated`: sync pauses, probing `/api/meta` each poll until a newer worker answers.
- `by` ids: `is_directory_id` (`manifest.rs`) ⇄ `ENTITY_ID_RE` (`members.ts`) ⇄ `AGENT_ID_RE` (`agents.ts`). **Change all three.** An unknown id refetches the directory at most every 5 min (`DIRECTORY_MIN_GAP`); unresolved ids and pre-v3 device names show as they stand.

## Flows (`flows.rs`, `mod.rs`)

- **Connect**: mint token → setup prompt → agent prints `ENDPOINT: https://…` → `cloud_probe` → `cloud_connect` binds, uploads, writes `cloud.json` + marker, spawns the engine.
- **Already bound** (probe shows a workspace): *Download it* (`cloud_join` into `~/Doklin/<name>`) or, when the open folder's marker has that `wsId`, *Resume* (`cloud_resume`). Never "bind anyway".
- **Resume**: empty engine state; `stage_local` adopts remote fileIds by path, identical bytes count as synced, merges own the rest (reinstall, restored folder).
- **Disconnect**: stop the engine, drop the `cloud.json` entry and state; folder, marker and cloud stay.
- **Wipe** (`cloud_wipe`, owner): erase via the worker, then disconnect **including the marker**, so nothing re-uploads into the freed domain; then the teardown prompt.
- Token rotation is not built.

## Local files

- `<app_data_dir>/cloud.json`: `{version, device: {id, name}, workspaces: [{root, domain, endpoint, wsId, name, token, creator}]}`. One entry per root and per domain; parsed by shape (malformed = nothing connected); the only place a token lives.
- `<root>/.doklin/cloud.json`: the marker `{domain, wsId}`. Never a secret (a copied folder must not carry a credential). Hidden, so tree walk, search and scan skip it. A marker with no `cloud.json` entry → offer *Resume*.
- `<app_data_dir>/cloud/<wsId>/state.json` + `base/`: last applied manifest and etag, per-file synced state, queued public ops; merge bases. Each space's are under `spaces/<spaceId>/` in it.
- `<folder>/.doklin/space.json`: a space's marker (*Sections*). No secret.

## Worker versions and updates

- `cloud-worker/src/version.ts` is the one source of `WORKER_VERSION`, `WORKER_FEATURES`, `MANIFEST_VERSION`, `COMPATIBILITY_DATE`. Parsed, never copied, by `src-tauri/build.rs`, `vite.config.ts` (`virtual:cloud-worker-version`) and the bundle script: keep the one-line shape `/^export const WORKER_VERSION = (\d+);$/m`.
- **Bump `WORKER_VERSION` for every wire change and any change to how a public page looks** (renderer, theme, tokens, fonts). It drives the update badge; without it deployed domains never update.
- A name in `WORKER_FEATURES` is a promise about behaviour, added only once it exists. The engine gates on `versions` (mirror), `presence` (beat; else plain `GET` polls), `leases` (claims), `spaces` (sections) and re-probes hourly while one is missing (`ASKED_AGAIN_FOR`). The CLI gates each command on its `agent-*` feature.
- Neither side must work with the other's next release; a skewed pair must say so (badge, `worker-outdated`, `426`) and never corrupt. So retired routes and fields are deleted, not kept.
- Move `COMPATIBILITY_DATE` only on purpose: it changes every new deploy's runtime.
- Bundle < 3 MB gzipped (the script fails past it; mermaid is most of it). The checked-in `cloud-worker/src/assets.ts` stays empty (`WEB_ASSETS` is `null`); the bundle script splices mermaid in.
- **Update** = `scripts/doklin-cloud-update.sh <endpoint>` (release asset; `updateCommands`). Names from the endpoint (`deploymentNames`); confirms worker and bucket exist first (deploying a missing name creates a second worker); may create only the D1 database, under the conventional name; done when unauthenticated `/api/meta` answers `401`. Overrides `WORKER_NAME=`, `BUCKET_NAME=`, `D1_NAME=`. No secret.
- **Setup prompt** checks names are free first (a same-name deploy silently replaces a worker) and that `/api/meta`'s `d1` is a number. **Teardown** runs after the wipe, never forces a non-empty bucket. `wrangler.toml` is never committed. `verify-harness/cloudprompts.test.mjs` pins prompts and script to the naming rule and compatibility date.
