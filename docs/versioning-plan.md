# Versioning — the implementation plan

The phased build of [docs/versioning.md](versioning.md), written to be handed
to an agent one phase at a time. Every phase ships on its own: it is a
complete, releasable change with its own tests, docs and verification, it
never leaves the app in a state that needs the next phase to be correct, and
an older build can run against anything it leaves on disk or in the bucket.
Read the spec first; this document says *how* and *in what order*, and it
settles the handful of details the spec left open (§2).

## 0. How to use this document

- **One phase per branch and pull request.** A phase's *Done when* list is
  the merge gate. Do not start the next phase's work in the same branch.
- **Every push to `main` cuts a release** ([release-pipeline.md](release-pipeline.md)),
  so "releasable" is literal: what merges, ships.
- Before touching code, read: [versioning.md](versioning.md) (the design),
  [cloud.md](cloud.md) §3, §6.2–6.7 (the engine you sit beside),
  `src-tauri/src/cloud/{mod,engine,bus,scan,status}.rs`, `src/cloud.ts`,
  `src/HistoryPanel.tsx`, and `.claude/skills/verify/SKILL.md` (how anything
  here is verified).
- Match the house style: every module opens with a `//!` comment that says
  what it is and points at the doc section; a contract mirrored in Rust and
  TypeScript says "change both" on both sides; a number that has one source
  is parsed from it, never retyped; user-facing errors are sentences; the
  frontend never `fetch`es; platform calls carry the `macOS-only` tag.
- When a phase changes behaviour the spec describes, update the spec in the
  same PR (an *as built* note under the section), and update
  `.claude/skills/verify/SKILL.md` with what the new suites walk.

## 1. The phases at a glance

| # | Phase | What ships | Depends on | User sees |
| --- | --- | --- | --- | --- |
| 1 | The local store | capture, the ladder, blob GC, status; no UI | — | nothing — history starts accruing from this release |
| 2 | File history, ungated | the History panel on the local store, a diff, drafts | 1 | version history for every workspace, cloud or not |
| 3 | The cloud mirror | worker routes, upload, the cloud horizon, read-through | 1, 2 | history beyond the laptop; badge asks for a worker update |
| 4 | Workspace history, deleted files | snapshot browser, restore-all, recently deleted | 1, 2 | "as it was on Tuesday"; a deleted note back |
| 5 | Settings and export | horizons, sizes, orphaned stores, one-archive export | 1, 2 | control and an offline copy |
| 6 | Retire the manifest history | `hist` stops being written; the old commands go | 3 | nothing — a smaller manifest |

Phases 3, 4 and 5 are independent of one another and may ship in any order
after 2. Phase 6 needs 3 to have shipped (and, in practice, to have run for a
while on every device the user has).

## 2. Decisions this plan makes

The spec left these open or said them loosely; they are settled here so the
phases do not re-open them. Each is carried back into the spec as an *as
built* note by the phase that lands it.

1. **The store is keyed by the folder's path, not a workspace id.**
   `key = "r-" + first 16 hex of sha256(canonical root path)`. No marker is
   written into a folder that isn't connected (the spec's §6.3 proposed
   minting a `wsId` at first capture; that puts a hidden directory into every
   folder the user opens, and it is not needed to ship). A moved folder
   starts a fresh store; the old one shows up as *orphaned* in phase 5's
   settings, where it can be forgotten or kept. Adopting the marker's `wsId`
   when present is a refinement for later, not a blocker.
2. **Snapshots are keyed by path, with no file ids.** A snapshot is a map
   `path → {hash, size, mtime}` produced by scanning the disk. The cloud
   engine's fids never enter the store, so the versioner has no dependency on
   the engine and works identically for an unconnected folder. Renames are
   followed the way git does it — a path that vanished and a path that
   appeared with the same hash between two snapshots — which is exactly the
   engine's own pass-3 rule.
3. **The versioner scans on its own; it does not ride the engine's cycle.**
   One `Versioner` task per open workspace root, fed by the same edit bus and
   its own recursive watcher, doing its own (cheap, stat-cached) scan on the
   cadence rule. Coupling to `Engine::cycle` would leave unconnected
   workspaces with nothing and make the engine the versioner's clock.
4. **The cloud store is an independent prefix that mirrors the local store
   byte for byte.** `versions/` in the bucket, with its own blobs keyed by
   full sha256, never `blobs/<fid>/<hash>`. The spec proposed pointing cloud
   snapshots at the sync's blobs and swapping the sync GC's predicate; that
   makes a device running an *older* app — whose `gc_blobs` knows nothing
   about snapshots — able to delete a blob a snapshot references. An
   independent prefix costs a second copy of the current content (a few
   megabytes; §7 of the spec says why that is nothing) and removes the whole
   class of mixed-version hazards. The sync's blob store and its GC are not
   touched by any phase.
5. **gzip, not zstd.** `flate2` (pure Rust via `miniz_oxide`) is already in
   `Cargo.lock` as a transitive dependency; `zstd` would add a C build on
   three platforms for a ratio that does not matter at these sizes. So is
   `tar`, which phase 5's export uses. Neither adds a crate source.
6. **Which folders are open comes from the window registry.**
   `register_window_content` (`lib.rs`) already receives every window's
   folder; the versions manager reconciles its set of running versioners
   against the registry's folders there and on `WindowEvent::Destroyed`. No
   new frontend call is needed to start or stop a versioner.
7. **The drafts directory is a root too.** `<app_data>/drafts` runs a
   versioner like any workspace (key `drafts`), so the one thing with no
   versioning today gets it in phase 1 and a surface in phase 2.
8. **`hist` is retired without bumping `MANIFEST_VERSION`.** An empty `hist`
   array is a valid v2 manifest, and old workers and old apps keep working
   against it. The spec's §6.5 said v3; a schema bump would force every user
   through a worker update (`426`) for no gain. Nothing is seeded from the
   old `hist` either: by phase 6 the snapshots cover far more than the hours
   `hist` ever held, and phase 2 keeps those entries readable in the
   meantime.
9. **The sync's own hashes stay 16 hex characters; the store's are 64.** The
   two meet only in phase 2's read-through, where a cloud revision's `h` is
   by construction a prefix of the store's full sha256 of the same bytes.

## 3. Ground rules every phase keeps

The spec's §5 invariants, restated as things a reviewer can check in a diff:

- No code path outside `retain.rs` deletes a snapshot or a blob. Not
  `trash_file`, not a restore, not a disconnect, not a wipe of the *local*
  store (that is phase 5's explicit *forget*, which deletes a whole store
  directory the user named).
- A snapshot file is complete before the index names it; blobs are complete
  before the snapshot that references them is written. Writes are
  `write_atomic` (temp + rename) — the same helper the engine uses.
- Capture never blocks the runtime: the scan, the hashing and the writes run
  under `tokio::task::spawn_blocking`.
- No snapshot is ever written more often than the cadence rule allows, whatever
  the filesystem does.
- The store never lives under the workspace root. Its path is
  `<app_data>/versions/<key>/` and nothing else.
- A restore is an ordinary write through the existing commands, so the edit
  bus, the watcher, the open tabs and the cloud engine all see it as an edit.

---

## 4. Phase 1 — The local store

**Goal.** Every open workspace (and the drafts folder) gets a local version
store that captures on the cadence rule, thins on the ladder, and reports a
status. No UI beyond the status event. Releasable because it is invisible and
self-contained: nothing else reads it yet, an older build ignores
`<app_data>/versions/`, and the settings file carries a kill switch.

### 4.1 Files

```
src-tauri/src/versions/
  mod.rs        the manager: one Versioner per open root, the window-registry
                reconcile, the drafts root, the commands, init at boot
  store.rs      the on-disk store: paths, the index, snapshot files, blobs,
                gzip, atomic writes, size accounting
  capture.rs    the cadence state machine and scan → snapshot
  retain.rs     the ladder (pure) and the sweep (snapshot files, then blobs)
  status.rs     the status/event contract (mirrored by src/versions.ts)
  settings.rs   <app_data>/versions/settings.json
  tests.rs
src-tauri/src/edits.rs    one `touched(app, path)` fanning out to cloud and versions
src/versions.ts           the TS half of the contract: types, wrappers, listeners
```

Modify: `src-tauri/src/lib.rs` (register the manager and the commands; call
`versions::init` in `setup` after `cloud::init`; call
`versions::reconcile(&app)` at the end of `register_window_content` and in the
`WindowEvent::Destroyed` arm; the quit flush; every `cloud::touched(` call
site → `edits::touched(`), `src-tauri/src/store.rs` (same call-site rename),
`src-tauri/src/cloud/mod.rs` (`mod scan;` → `pub(crate) mod scan;` so the
versioner reuses `scan_local`, `read_file_checked`, `write_atomic`,
`read_json`, `write_json`, `now_ms`, `rel_path`), `src-tauri/Cargo.toml`
(`flate2 = "1"`; `chrono` gains nothing — `Datelike` is in the crate already).

### 4.2 The store on disk

```
<app_data>/versions/
  settings.json                       {version: 1, enabled: true, horizonDays: 90}
  <key>/
    index.json                        the retained set (below)
    snapshots/<ts>.json.gz            gzip of the snapshot JSON; <ts> zero-padded to 13 digits
    blobs/<hh>/<hash>.gz              gzip of the content; <hash> full sha256 hex, <hh> its first two
```

`key` per decision 1; `drafts` for the drafts directory. Canonicalise with
`std::fs::canonicalize` when it succeeds, else the path as given; the index
records the display path either way.

`index.json`:

```json
{
  "version": 1,
  "root": "/Users/sherin/Notes",
  "createdMs": 1757000000000,
  "lastCaptureMs": 1757000000000,
  "lastSweepMs": 1757000000000,
  "snapshots": [
    { "ts": 1757000000000, "reason": "seed", "files": 512, "bytes": 2100000,
      "digest": "<sha256 hex>", "pinned": false }
  ]
}
```

Sorted by `ts` ascending; `ts` is unique (a capture in the same millisecond
as the last takes `last + 1`). `digest` is sha256 over the lines
`<path>\0<hash>\n` in path order — two snapshots with equal digests hold the
same workspace. `pinned` exists now so a later "save a version" button needs
no format change; nothing sets it in this phase.

A snapshot file, before gzip:

```json
{
  "version": 1,
  "ts": 1757000000000,
  "reason": "interval" | "closing" | "seed" | "restore" | "manual",
  "by": "Sherin's MacBook Pro",
  "files": {
    "Projects/plan.md": { "h": "<sha256 hex>", "s": 4310, "m": 1757000000000 }
  }
}
```

`by` is the device name from `cloud.json` (`cloud::device_display_name`
through the cloud manager's `DeviceIdentity`; the versions manager reads
`read_cloud_file(data_dir).device` at init and falls back to
`device_display_name()`).

Caps: a file over `MAX_SYNC_FILE_BYTES` (25 MB) is not versioned, exactly as
it is not synced; a root over `MAX_SYNC_ENTRIES` (5000) puts the versioner in
phase `too-large` and captures nothing — never a partial snapshot. Both are
the scan's own rules already.

Settings: `enabled: false` stops every versioner from capturing (they still
answer status). Read at init and on `versions_set_enabled` (a command with
no UI until phase 5; wire it so the switch can be flipped from the harness
and from a test).

### 4.3 Capture — the cadence rule

```rust
pub const CAPTURE_MIN_INTERVAL: Duration = Duration::from_secs(10 * 60);
pub const SESSION_IDLE: Duration = Duration::from_secs(2 * 60);
```

State per versioner: `dirty: bool`, `last_activity: Instant`,
`last_capture: Instant` (set to `Instant::now()` at start), and the newest
snapshot's file map held in memory (`last: BTreeMap<String, Entry>`, plus its
digest).

Inputs, each setting `dirty = true; last_activity = now`:

- the edit bus — `edits::touched` routes an absolute path to the versioner
  whose root contains it, dropping hidden/ignored components and the
  engine's temp files exactly as `cloud::bus::EditBus::touch` does (copy the
  filter, or lift it into `scan.rs` and call it from both);
- a recursive watcher on the root, `notify_debouncer_full` at 500 ms, the
  pattern of `cloud/mod.rs` `spawn_engine` (a connected root then has two
  watchers; that is fine).

The loop (`Versioner::run`), one `tokio::select!` over commands, the watcher
channel and `sleep_until(wake)`:

```
wake = if dirty { min(last_activity + SESSION_IDLE, last_capture + CAPTURE_MIN_INTERVAL) } else { far }
on wake, if dirty:
  if now >= last_activity + SESSION_IDLE            → capture("closing")
  else if now >= last_capture + CAPTURE_MIN_INTERVAL → capture("interval")
capture(): last_capture = now; dirty = false; then the scan below
```

Consequences to keep (and to test): an hour of steady edits yields six
`interval` snapshots and one `closing`; a quiet hour yields none; the end of
every session is captured; a tool rewriting a file in a loop yields one
snapshot per ten minutes and no more; two short sessions two minutes apart
yield two `closing` snapshots, and that is the worst case.

`capture(reason)`, under `spawn_blocking`:

1. `scan_local(root)` → on `Err` (too large) set phase `too-large`, return.
2. For each scanned path: if `last` has it with equal `(size, mtime)`, reuse
   its hash; else `read_file_checked`, sha256 (full hex), and if
   `blobs/<hh>/<hash>.gz` does not exist, gzip and `write_atomic` it.
3. Build the file map and its digest. If the digest equals the newest
   snapshot's, write nothing (still counts as a capture for the cadence).
4. `write_atomic` the snapshot file; then append to the index and
   `write_json` it; update `last`.
5. Emit `versions-status`.

Order matters: blobs, then the snapshot, then the index — a crash between
steps leaves orphans the sweep removes, never an index entry whose bytes are
missing.

**Seed.** A versioner whose index has no snapshots captures `seed` at start,
so the folder's state is recorded before the user touches anything (this is
what makes "opened it, deleted half of it by accident" recoverable).

**Shutdown.** `VersionerCmd::Shutdown` captures `closing` if dirty, then
exits. The manager sends it when a root's last window closes (decision 6).
On quit, the existing quit flush (`QuitFlush` / `begin_quit_flush` in
`lib.rs` — the path that ends in `exit` once every window acked or timed
out) calls `versions::flush_all_blocking(&app, Duration::from_secs(2))`
first: each dirty versioner captures synchronously, bounded by the deadline.

### 4.4 Retention — the ladder and the sweep

`retain.rs` is two functions and no state.

```rust
/// Which of `snaps` survive at `now`, given a horizon in days (None = forever).
pub fn retain(snaps: &[SnapshotMeta], now_ms: u64, horizon_days: Option<u32>) -> BTreeSet<u64>
```

Rules, in order: the newest snapshot always survives; a `pinned` one always
survives; anything past the horizon goes; then by age (`now - ts`): under one
hour every snapshot; under 24 hours the last in each UTC hour; under 30 days
the last in each UTC day; under 365 days the last in each ISO week (Monday
start, UTC); beyond that the last in each UTC month. Bucket keys come from
`chrono` (`DateTime<Utc>` + `Datelike`/`Timelike`, `iso_week()`). Pure,
deterministic, idempotent — calling it on its own output changes nothing.

```rust
/// Apply `retain` to a store: rewrite the index, delete dropped and orphaned
/// snapshot files, then delete blobs no retained snapshot references and
/// that are older than GC_GRACE.
pub fn sweep(store: &Store, now_ms: u64, horizon_days: Option<u32>) -> SweepReport
```

`GC_GRACE = 1 h` by file mtime, so a blob written by a capture in flight is
never collected. Order: index first (atomic), then snapshot files, then
blobs. A snapshot file the index does not name is an orphan and goes. The
sweep runs at versioner start (after the seed) and after any capture when
`now - lastSweepMs >= SWEEP_EVERY = 6 h`. It reads every retained snapshot to
build the referenced set — ~140 small gzip files; measure it, and if a
5000-file store makes it slow, cache each snapshot's hash set beside it
(`<ts>.hashes`) rather than redesigning.

### 4.5 The contract

`status.rs` ↔ `src/versions.ts` — change both:

```ts
export type VersionsPhase = "idle" | "capturing" | "too-large" | "disabled" | "error";
export type VersionsStatus = {
  root: string;                 // the display root; the drafts folder for drafts
  key: string;
  phase: VersionsPhase;
  error: string | null;
  snapshots: number;
  oldestMs: number | null;
  newestMs: number | null;
  lastCaptureMs: number | null;
  bytes: { blobs: number; snapshots: number };
  horizonDays: number | null;   // null = forever
};
export type SnapshotMeta = { ts: number; reason: string; files: number; bytes: number; pinned: boolean };
// event "versions-status": VersionsStatus[]  (the whole model, on every change)
```

Commands (phase 1 — the minimum that makes the store observable):

```
versions_status()                          -> VersionsStatus[]
versions_snapshots(root)                   -> SnapshotMeta[]      newest first
versions_capture_now(root, reason?)        -> SnapshotMeta | null (null: nothing changed)
versions_set_enabled(enabled)              -> void
```

`root` is the display root; the manager resolves it to the key. Errors are
sentences ("That folder has no version store yet.").

### 4.6 Tests (`cargo test --lib versions`)

Use `tempfile` roots and stores, a `Clock` the versioner reads `now_ms` from
(an `Arc<AtomicU64>` in tests; wall clock in the app), and
`#[tokio::test(start_paused = true)]` with `tokio::time::advance` for the
cadence, the way `touched_path_settles_faster_than_a_watched_one` does it.

- `seed_captures_on_first_start` · `identical_scan_writes_no_snapshot`
- `burst_inside_an_interval_yields_one_snapshot` · `steady_hour_yields_six_plus_closing`
- `quiet_hour_yields_nothing` · `session_end_is_always_captured`
- `write_loop_is_bounded_to_one_per_interval`
- `stat_cache_skips_hashing_untouched_files` (count reads)
- `blob_dedupes_across_paths` (two files, same bytes, one blob)
- `ladder_keeps_expected_counts_over_two_synthetic_years` (build 2 years of
  hourly `ts`s; assert per-band counts; assert `retain(retain(x)) == retain(x)`)
- `ladder_never_drops_newest_or_pinned` · `horizon_drops_everything_older`
- `sweep_removes_dropped_and_orphaned_snapshots_then_unreferenced_blobs`
- `sweep_spares_blobs_younger_than_grace`
- `deleting_files_on_disk_removes_nothing_from_the_store` (rule 1)
- `too_large_root_captures_nothing_and_reports_phase`
- `disabled_captures_nothing_and_reports_phase`
- `edit_bus_routes_a_touch_to_the_versioner_whose_root_holds_it`
  (mirror the cloud bus test; hidden segments dropped)
- `index_and_snapshot_round_trip_through_gzip`

### 4.7 Docs and verification

- `versioning.md`: an *as built* note under §6.1–6.3 for decisions 1, 2, 3,
  5, 7; §9's build order replaced by a pointer to this document.
- `cloud.md` §6.4: the edit bus now fans out through `edits::touched`.
- `.claude/skills/verify/SKILL.md` → *Rust side*: `cargo test --lib versions`
  and what it pins.
- `development.md` → Architecture: the versions module in one line.

### 4.8 Done when

- [ ] `cargo test --lib versions` and `cargo test --lib cloud` pass; `cargo
      check` is warning-free for the new module.
- [ ] `pnpm lint`, `pnpm exec tsc --noEmit` pass (`src/versions.ts` compiles
      even though nothing imports it yet).
- [ ] A manual pass on macOS (`pnpm tauri dev`): open a folder, see
      `<app_data>/versions/<key>/` appear with a `seed` snapshot; edit for a
      minute, stop, see a `closing` snapshot two minutes later; quit mid-edit
      and see a `closing` snapshot from the flush; the drafts store exists.
- [ ] `settings.json` with `enabled: false` stops capture.
- [ ] Docs updated as in 4.7.

---

## 5. Phase 2 — File history, ungated

**Goal.** The History panel reads the local store, appears for every file in
every workspace (connected or not), shows what changed between versions, and
still surfaces the cloud's `hist` revisions where they reach further back.
Releasable because it replaces one read path with another and leaves every
write path as it is.

### 5.1 Files

Add `src-tauri/src/versions/history.rs` (derivations over snapshots).
Modify: `versions/mod.rs` (commands), `versions/status.rs` + `src/versions.ts`
(types), `src/HistoryPanel.tsx`, `src/Sidebar.tsx:857` (drop the `cloud &&`),
`src/App.tsx` (the history entry for drafts — see 5.4), `src/App.css`
(the diff view).

### 5.2 Derivations

```rust
/// Every distinct version of the file at `rel`, newest first, following
/// renames backwards through the retained snapshots.
pub fn file_versions(store: &Store, rel: &str) -> Result<Vec<FileVersion>, String>
```

Walk the index newest → oldest, decoding each snapshot (cache the last 32
decoded snapshots in the versioner — the panel opens them one file at a
time). Track `path`. When the snapshot lacks `path` but the next-newer one
had it with hash `h`, look for a path in this snapshot with hash `h` that the
next-newer one lacks; if exactly one, continue under that name (a rename);
otherwise the walk ends (the file was created there). Emit an entry whenever
the hash differs from the last emitted:

```ts
export type FileVersion = {
  ts: number; hash: string; size: number; by: string; reason: string;
  path: string;        // the path as of that snapshot (differs across renames)
  source: "local" | "cloud";
  current: boolean;    // equals the file on disk right now
};
export type FileHistory = { currentHash: string | null; versions: FileVersion[] };
```

`currentHash` is the sha256 of the file on disk now (null when it is gone).

Commands:

```
versions_history(path)                     -> FileHistory
versions_read(root, hash)                  -> string    the blob as text; a non-UTF-8 blob is an error
versions_diff(root, fromHash, toHash)      -> string    a unified diff, from `diffy::create_patch`
```

`versions_diff` reuses the engine's `diffy` dependency; the panel renders the
patch in a `<pre>` with `+`/`-` line classes. Cap both sides at 4 MB (the
worker's note cap) with a sentence past it.

### 5.3 The cloud read-through

When the workspace is connected and `cloud_history(path)` answers, merge its
revisions into the list: a cloud revision whose `h` is a prefix of a local
entry's hash is the same version (drop it); the rest are appended with
`source: "cloud"` and read through `cloud_revision`. Sort by time. This keeps
what users can see today visible on the day this phase ships, when the local
store is hours old and the cloud's `hist` may reach a day back. Phase 6
removes this branch.

### 5.4 The surfaces

- **`HistoryPanel.tsx`**: `versionsHistory` / `versionsRead` instead of the
  cloud wrappers; rows labelled by time and `by` (the existing `revLabel`),
  with a small reason word (`end of session`, `while editing`, `first seen`,
  `before a restore`); a *Changes* toggle showing `versions_diff` against
  the next-newer version (or the current file); *Restore* and *Save as new
  doc* unchanged — both remain plain `write_file`s.
- **Sidebar**: `Version history…` for every file; no cloud condition.
- **Drafts**: the drafts panel's row menu gets `Version history…`, opening
  the same panel on the draft's path (its root is the drafts store).
- The panel's title says which store answered when the workspace is
  connected: "3 versions here · 12 in the cloud" — a one-line summary, no
  new surface.

### 5.5 Tests and the harness

Rust (`history.rs`): `versions_follow_a_rename_backwards`,
`a_recreated_path_starts_a_new_history`, `equal_hashes_collapse_to_one_entry`,
`current_marks_the_version_on_disk`, `diff_is_unified_and_capped`,
`cloud_prefix_matches_dedupe_against_local`.

Harness: a new `verify-harness/drive-versions.mjs` over `cloud.html` (it
already boots the real `<App/>` with a `/docs` workspace). Extend the IPC
stub with `versions_*` answering from a scripted `window.__versions` (the
pattern of `window.__cloud`, including `calls`), and walk: *Version history…*
present with **no** cloud status; the list; selecting a version previews it;
*Changes* shows a diff with a `+` line; *Restore* issues `write_file` with the
version's text; *Save as new doc* opens a tab; with a cloud status set, a
cloud-only revision appears with its badge and reads through
`cloud_revision`; a draft's history opens. `drive-cloud.mjs`'s existing
history step keeps passing (it now exercises the read-through).

### 5.6 Docs and done

- `versioning.md` §8 (surfaces) *as built*; `cloud.md` §6.9 says history is
  read from the version store with the manifest's `hist` as a fallback until
  phase 6; `README.md` Features: the autosave bullet gains a sentence on
  version history; `SKILL.md` gains `drive-versions.mjs`.
- [ ] Rust, lint, tsc green; `drive-versions.mjs` and `drive-cloud.mjs` pass.
- [ ] Manual: history for a file in an unconnected folder; restore; the diff.

---

## 6. Phase 3 — The cloud mirror

**Goal.** A connected workspace's engine mirrors the local store into the
bucket under `versions/`, thins it on the cloud horizon, and the History
panel reads cloud snapshots beyond the local horizon. Releasable because the
API only grows: an old worker keeps syncing and reports no `versions`
feature (the existing update badge lights, since `WORKER_VERSION` moves to
3); an old app ignores the prefix; a wipe already erases every key.

### 6.1 The worker

`cloud-worker/src/layout.ts`:

```
versions/index.json                          {version, horizonDays, snapshots: [...]}  — CAS by etag
versions/snapshots/<ts13>-<deviceId>.json.gz  immutable; bytes as the device wrote them
versions/blobs/<hash>                         immutable; gzip bytes, full sha256 hex key
```

Routes (`api.ts`, beside the manifest's), owner and member:

```
GET    /api/versions/index                 the index + x-versions-etag; 404 when none
PUT    /api/versions/index                 x-base-etag required (428); "*" creates; 412 + etag on a race;
                                           400 on shape; 413 past 1 MB
GET    /api/versions/snapshots/<id>        bytes; 404
PUT    /api/versions/snapshots/<id>        create-only ({existed: true} on a re-PUT); 413 past 4 MB
DELETE /api/versions/snapshots/<id>
GET    /api/versions/blobs?cursor=…        {blobs: [{hash, size, uploaded}], cursor?} — paged listing
GET    /api/versions/blobs/<hash>          bytes; 404
PUT    /api/versions/blobs/<hash>          create-only; 413 past 25 MB
DELETE /api/versions/blobs/<hash>
```

Id grammar: `^\d{13}-[a-z0-9][a-z0-9_-]{2,63}$`; hash `^[a-f0-9]{64}$`. The
index's shape check mirrors the local index plus `horizonDays: number | null`
and, per entry, `id` and `device`. `version.ts`: `WORKER_VERSION = 3`,
`"versions"` in `WORKER_FEATURES`, a comment line for 3. `README.md` (the
worker's) and `cloud.md` §5.2–5.3 gain the routes. `run.mjs`: auth on the
routes, create-only on snapshot and blob, index CAS (428/412/"*"), caps, the
listing's paging, and that wipe leaves no `versions/` key.

### 6.2 The engine

`remote.rs`: the trait grows one method per route (`get_versions_index`,
`put_versions_index(base_etag, body)`, `put_version_snapshot`,
`get_version_snapshot`, `delete_version_snapshot`, `list_version_blobs`,
`put_version_blob`, `get_version_blob`, `delete_version_blob`); `HttpRemote`
and the test `FakeRemote` implement them. This is the only place a token is
used — cloud.md rule 2 holds.

`engine.rs`: a `mirror_versions()` step after each cycle that changed
anything, and on the poll every `MIRROR_EVERY = 1 h` regardless, gated on the
worker's features containing `versions`:

1. Read the local index through a shared read-only handle the versions
   manager exposes (`versions::store_for(root) -> Option<StoreReader>`); read
   the cloud index (etag).
2. For each local snapshot not in the cloud index, oldest first: skip it if
   its digest equals the digest of the cloud entry immediately before its
   `ts` (another device already captured this content); otherwise PUT every
   blob it references that is not known uploaded (keep a persisted
   `uploaded: HashSet<hash>` in `WorkspaceState`; on a `404` from a later
   GET, clear it), PUT the snapshot, then CAS the index with the entry
   appended. On 412, refetch and continue.
3. Once a day (`lastCloudSweepMs` in state): `retain(cloud entries, now,
   index.horizonDays)`; DELETE the dropped snapshots, CAS the index, then
   list blobs and DELETE those no retained cloud snapshot references and
   whose `uploaded` is older than one hour.

The cloud horizon lives in the cloud index (all devices agree); default
`null` (forever). Status: `CloudStatus` gains `versions: {mirrored: number,
cloud: number, lastMirrorMs: number | null} | null` (null when the worker has
no `versions` feature).

### 6.3 Read-through

`versions_history` for a connected root also asks the cloud manager for the
cloud index (the engine keeps its last-read copy in state; expose
`cloud::versions_index_for(root)`), and for entries not held locally fetches
the snapshot through a new `EngineCmd::VersionSnapshot { id, reply }`, caching
the bytes under `<store>/cloud-cache/`. Those entries carry `source:
"cloud"`. `versions_read` falls back to `EngineCmd::VersionBlob` the same
way.

### 6.4 Tests, docs, done

Rust (`cloud/tests.rs`): `mirror_uploads_local_snapshots_and_their_blobs`,
`mirror_skips_a_snapshot_another_device_already_holds`,
`mirror_survives_a_lost_index_cas`, `cloud_sweep_thins_on_the_cloud_horizon`,
`cloud_sweep_spares_young_blobs`, `no_versions_feature_means_no_mirror_and_a_null_status`,
`read_through_lists_cloud_only_versions`.

Worker (`run.mjs`): as in 6.1. Harness: `drive-cloud.mjs` gains the status's
`versions` line in the panel and the badge for a v2 worker (the fake
engine's `workerVersion` already comes from `version.ts`).

Docs: `cloud.md` §5.2, §5.3, §5.7 (version 3), §6.7 (the status field);
`versioning.md` §6.3 *as built* (decision 4); `SKILL.md` counts.

- [ ] `pnpm typecheck:worker`, `pnpm test:worker`, `pnpm bundle:worker` and
      the bundle run green; the bundle stays under the ceiling.
- [ ] Rust and harness green.
- [ ] Manual, against a deployed worker: update it with the app's prompt,
      watch `versions/` fill, open history on a second Mac and see the
      first Mac's versions.

---

## 7. Phase 4 — Workspace history and deleted files

**Goal.** Two surfaces over the store that exists: the workspace as it was at
any retained snapshot, restorable in whole or in part, and every file that
was in a retained snapshot and is not on disk now. Releasable because both
are reads plus ordinary writes.

### 7.1 Commands

```
versions_snapshot_diff(root, ts)  -> { changed: [{path, thenHash, nowHash}], added: [path], missing: [path] }
                                     "added" is on disk now and not then; "missing" the reverse
versions_restore_snapshot(root, ts, paths: string[] | null)
                                  -> { written: number, trashed: number, snapshotTs: number }
versions_deleted(root)            -> [{ path, lastSeenMs, hash, size }]
versions_restore_file(root, path, hash) -> void
```

`versions_restore_snapshot` first captures a `restore` snapshot (forced,
bypassing the cadence, digest-deduped as usual) so the restore is itself
undoable; then, for each path in scope, writes the blob's bytes through the
same code `write_file` runs (a shared `fn write_workspace_file(app, path,
bytes)` that stats, writes, refreshes the watcher store and calls
`edits::touched`), creating parent directories; trashes files that are on
disk now and were not then through `trash_path_impl` (`macOS-only`, as it
is); then emits `versions-applied {root, paths}`. `App.tsx` handles
`versions-applied` with the same handler as `cloud-applied` (refresh the
tree, reload open tabs). The cloud engine's mass-delete valve still applies
to a restore that trashes many files — that is correct and stays.

`versions_deleted` walks retained snapshots newest → oldest and reports paths
present in some snapshot, absent from the newest, and not on disk;
`lastSeenMs` is the newest snapshot that held it, `hash` its content then.

### 7.2 Surfaces

- **`WorkspaceHistory.tsx`** — a modal: retained snapshots grouped by day
  (newest first), each row's file count; selecting one shows `changed`,
  `added`, `missing` with per-file *Restore* and *Restore all*; a confirm
  inline (never `window.confirm` — the harness auto-dismisses it). Reached
  from the sidebar root's context menu (*Workspace history…*) and the Cloud
  panel.
- **`RecentlyDeleted.tsx`** — a list of deleted paths with when last seen
  and *Restore* (to the old path; a name collision appends ` (restored)`).
  Reached from the sidebar root's context menu and the Cloud panel.
- Both use the `cloud-modal` chrome and `data-testid`s.

### 7.3 Tests, docs, done

Rust: `snapshot_diff_classifies_changed_added_missing`,
`restore_snapshot_captures_first_then_writes_and_trashes`,
`restore_subset_touches_only_those_paths`, `deleted_lists_what_no_longer_exists`,
`restore_file_recreates_directories`.

Harness: `drive-versions.mjs` grows the two modals: a snapshot's diff, a
partial restore issuing writes, a full restore emitting `versions-applied`
and the tree refreshing, a deleted file restored.

Docs: `versioning.md` §8 *as built*; `README.md` Features (a sentence on
workspace history and deleted files); `SKILL.md`.

- [ ] Rust, lint, tsc, harness green.
- [ ] Manual: reorganise a folder, restore yesterday's snapshot, see the
      restore itself in the history; delete a note on one Mac, restore it
      from the other.

---

## 8. Phase 5 — Settings and export

**Goal.** The user can see and set what is kept, and take an offline copy.
Releasable because it is configuration over machinery that already runs.

### 8.1 Commands

```
versions_set_horizon(root, days | null)          local, per store (index.json gains horizonDays;
                                                 settings.json's value is the default for new stores)
versions_set_cloud_horizon(root, days | null)    through the engine: a CAS on the cloud index
versions_stores()                                -> [{key, root, exists: bool, bytes, snapshots, newestMs}]
versions_forget(key)                             delete a store directory — only when its root is not open
versions_export(root, dest)                      -> {bytes, files}
```

`versions_export` writes `<dest>/<folder name> — <YYYY-MM-DD>.doklin-backup.tar.gz`:
`workspace/…` (the current tree, as `scan_local` sees it) and `versions/…`
(the store directory verbatim). `tar` + `flate2`, both already in the lock.
Progress via a `versions-progress {root, done, total}` event. Import is out
of scope: the archive is plain tar, and unpacking `versions/` into
`<app_data>/versions/<key>/` is a documented manual step, not a feature.

### 8.2 Surfaces

The Settings popover (`Settings` in `App.tsx`) gains a *Versions* section:
the local horizon (30 days / 90 days / a year / forever), the cloud horizon
when connected, the space each store uses, *Export…* (a folder picker via
`tauri-plugin-dialog`), and *Other folders* listing orphaned stores with
*Forget*. The Cloud panel's *This Mac* section links to it.

### 8.3 Tests, docs, done

Rust: `horizon_change_is_applied_on_the_next_sweep`,
`forget_refuses_an_open_root`, `export_holds_the_tree_and_the_store`,
`cloud_horizon_is_a_cas_on_the_cloud_index`.

Harness: `drive-versions.mjs` — the settings section, a horizon change
issuing the command, export invoking the picker and the command.

- [ ] Green everywhere; `versioning.md` §8 *as built*; `SKILL.md`.
- [ ] Manual: export, unpack, confirm the tree and the store are complete.

---

## 9. Phase 6 — Retire the manifest history

**Goal.** The manifest stops carrying `hist`, the archive rollover goes, and
the old history commands go with the read-through. Releasable because an
empty `hist` is a valid v2 manifest to every worker and app that exists;
`MANIFEST_VERSION` does not move (decision 8). Ship it only after phase 3 has
been out long enough that every device the user runs has mirrored its store.

### 9.1 Changes

- `engine.rs`: `build_manifest` no longer inserts the previous revision into
  `hist` (leave the field, always empty); delete `roll_archives`,
  `ARCHIVE_HIST_MAX`, `MANIFEST_HIST_MAX` and its assert, `gc_candidates`'
  dependence on rollover — `gc_blobs` now considers every fid pushed since
  the last run and keeps only the current hash (still behind `GC_MIN_AGE_MS`,
  still every 20th cycle); delete `history`, `revision`,
  `EngineCmd::History` / `Revision`; `status.rs` drops `Revision`.
- `mod.rs`: delete `cloud_history` / `cloud_revision`; `src/cloud.ts` drops
  their wrappers and `CloudRevision`; `HistoryPanel.tsx` drops the
  read-through branch.
- The worker keeps accepting `hist` and keeps `/api/history/<fid>` — old apps
  still send both; mark them *deprecated* in the README and cloud.md rather
  than removing wire surface.
- Tests: `edit_propagates_and_builds_history` becomes
  `edit_propagates_and_hist_stays_empty`; delete
  `history_rolls_over_into_archive` and `history_lists_every_revision_and_fetches_one`;
  add `an_old_manifest_with_hist_is_read_and_rewritten_without_it`.

### 9.2 Done when

- [ ] `cargo test --lib cloud` green with the tests above.
- [ ] `manifest_wire_shape_matches_the_worker` still passes against
      `hist: []`.
- [ ] `cloud.md` §6.6 (the manifest), §6.9 (history) and §5.3 (the
      deprecated route) updated; `versioning.md` §6.5 *as built*.
- [ ] Manual: two devices, one on the previous release, editing the same
      workspace — sync works both ways; the older one's history panel still
      answers from the store.

---

## 10. Reference: the contract after phase 5

Everything `src/versions.ts` wraps, in one place, so a phase can check it is
adding to this rather than inventing beside it.

```
versions_status()                                    -> VersionsStatus[]
versions_snapshots(root)                             -> SnapshotMeta[]
versions_capture_now(root, reason?)                  -> SnapshotMeta | null
versions_set_enabled(enabled)
versions_history(path)                               -> FileHistory
versions_read(root, hash)                            -> string
versions_diff(root, fromHash, toHash)                -> string
versions_snapshot_diff(root, ts)                     -> SnapshotDiff
versions_restore_snapshot(root, ts, paths | null)    -> RestoreReport
versions_deleted(root)                               -> DeletedFile[]
versions_restore_file(root, path, hash)
versions_set_horizon(root, days | null)
versions_set_cloud_horizon(root, days | null)
versions_stores()                                    -> StoreInfo[]
versions_forget(key)
versions_export(root, dest)                          -> ExportReport

events: versions-status, versions-applied, versions-progress
```

## 11. Reference: constants

| Name | Value | Where | Phase |
| --- | --- | --- | --- |
| `CAPTURE_MIN_INTERVAL` | 10 min | `versions/capture.rs` | 1 |
| `SESSION_IDLE` | 2 min | `versions/capture.rs` | 1 |
| `SWEEP_EVERY` | 6 h | `versions/retain.rs` | 1 |
| `GC_GRACE` | 1 h | `versions/retain.rs` | 1 |
| default local horizon | 90 days | `versions/settings.rs` | 1 |
| default cloud horizon | forever | the cloud index | 3 |
| `MIRROR_EVERY` | 1 h | `cloud/engine.rs` | 3 |
| cloud sweep cadence | 24 h | `cloud/engine.rs` | 3 |
| snapshot cap | 4 MB | `cloud-worker/src/layout.ts` | 3 |
| index cap | 1 MB | `cloud-worker/src/layout.ts` | 3 |
| `WORKER_VERSION` | 3 | `cloud-worker/src/version.ts` | 3 |
