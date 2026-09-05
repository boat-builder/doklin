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
- **The end is a different question.** *Done when* says the phase is
  correct; [versioning-testing.md](versioning-testing.md) is the pass, run
  through the app by hand, that says the promise holds. Run its sections as
  the phases that build them land, and the whole list before calling
  versioning done.
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
| 1 ✅ | The local store | capture, the ladder, blob GC, status; no UI | — | nothing — history starts accruing from this release |
| 2 ✅ | File history, ungated | the history rail with an in-place preview, a diff, named versions, drafts | 1 | version history for every workspace, cloud or not |
| 3 ✅ | The cloud mirror | worker routes, upload, the cloud horizon, read-through | 1, 2 | history beyond the laptop; badge asks for a worker update |
| 4 ✅ | Workspace history, deleted files | the workspace timeline, restore-all, the *Recently deleted* row | 1, 2 | "as it was on Tuesday"; a deleted note back |
| 5 | Settings and export | horizons, sizes, orphaned stores, one-archive export | 1, 2 | control and an offline copy |
| 6 | Retire the manifest history | `hist` stops being written; the old commands, archives and orphaned blobs go | 3 | nothing — a smaller manifest |

Phases 3, 4 and 5 are independent of one another and may ship in any order
after 2. Phase 6 needs 3 to have shipped (and, in practice, to have run for a
while on every device the user has). The acceptance pass
([versioning-testing.md](versioning-testing.md)) is organised the same way:
one section per phase, then the crossings and the promises no single phase
owns.

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
- A restore never branches. It captures the state it is leaving
  (`pre-restore`) before it writes, writes through the ordinary path, then
  captures the state it made (`restore`, naming its source in
  `restoredFrom`). The timeline stays a sequence of states; the only way to
  fork is *Make a copy*, which is a second file.

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
      "digest": "<sha256 hex>", "pinned": false, "label": null, "restoredFrom": null }
  ]
}
```

Sorted by `ts` ascending; `ts` is unique (a capture in the same millisecond
as the last takes `last + 1`). `digest` is sha256 over the lines
`<path>\0<hash>\n` in path order — two snapshots with equal digests hold the
same workspace. `pinned` and `label` exist now so phase 2's *Name this
version* needs no format change: a `manual` capture sets both, and the
ladder never drops a pinned snapshot. In this phase only
`versions_capture_now` with `reason: "manual"` sets them — and when the
digest equals the newest snapshot's, it labels and pins *that* snapshot
instead of writing a duplicate.

A snapshot file, before gzip:

```json
{
  "version": 1,
  "ts": 1757000000000,
  "reason": "interval" | "closing" | "seed" | "pre-restore" | "restore" | "manual",
  "restoredFrom": null,
  "by": "Sherin's MacBook Pro",
  "files": {
    "Projects/plan.md": { "h": "<sha256 hex>", "s": 4310, "m": 1757000000000 }
  }
}
```

`pre-restore` is the state a restore is about to leave; `restore` the state
it made, with `restoredFrom` the `ts` of the snapshot the content came from
(§5.4, §7.1). Both are forced captures — they bypass the cadence — and the
first is digest-deduped like any other, so a restore from a fully captured
state adds one row, not two.

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
On quit, `versions::flush_all_blocking(&app, Duration::from_secs(2))`
captures what is pending: each dirty versioner captures synchronously,
bounded by the deadline. *As built*: the hook is the
`RunEvent::ExitRequested { .. } | RunEvent::Exit` arm in `lib.rs`, not
`begin_quit_flush`. `begin_quit_flush` is the ⌘Q menu path alone — a
Dock-icon Quit goes straight to `RunEvent::Exit` and never reaches it —
whereas the run-event arm is on every path and fires after the windows have
acked their autosaves, which is exactly the state worth capturing. It runs
once, guarded by the `Quitting` flag's swap.

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
export type SnapshotMeta = {
  ts: number; reason: string; files: number; bytes: number; pinned: boolean; label: string | null;
  restoredFrom: number | null;
  // phase 4: what this moment changed against the one before it. Only
  // versions_snapshots fills it — working it out is a snapshot decode per row.
  delta: { added: number; removed: number; changed: number } | null;
};
// event "versions-status": VersionsStatus[]  (the whole model, on every change)
```

Commands (phase 1 — the minimum that makes the store observable):

```
versions_status()                          -> VersionsStatus[]
versions_snapshots(root)                   -> SnapshotMeta[]      newest first
versions_capture_now(root, reason?, label?) -> SnapshotMeta | null (null: nothing changed; "manual"
                                              pins and labels — the newest snapshot when nothing changed)
versions_set_pinned(root, ts, pinned, label?) -> void
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

- [x] `cargo test --lib versions` (24 tests) and `cargo test --lib cloud`
      pass; `cargo check` is warning-free for the new module.
- [x] `pnpm lint`, `pnpm exec tsc --noEmit` pass (`src/versions.ts` compiles
      even though nothing imports it yet).
- [ ] A manual pass on macOS (`pnpm tauri dev`), with
      `scripts/versions.sh -w <folder>` open beside it: open a folder, see
      `<app_data>/versions/<key>/` appear with a `seed` snapshot; edit for a
      minute, stop, see a `closing` snapshot two minutes later; quit mid-edit
      and see a `closing` snapshot from the flush; the drafts store exists.
      **Not run** — this branch was built on a Linux runner, which can
      compile and test the crate but cannot launch the app. The seed, the
      closing capture and the quit flush each have a test standing in for
      them (`a_versioner_captures_the_session_on_the_way_out`,
      `a_flush_captures_what_is_pending_and_answers`); what only the manual
      pass can show is the wiring in `lib.rs` — the window registry starting
      and stopping versioners, and the exit event reaching the flush.
- [x] `settings.json` with `enabled: false` stops capture
      (`disabled_captures_nothing_and_reports_phase`).
- [x] Docs updated as in 4.7.

---

## 5. Phase 2 — File history, ungated

**Goal.** The History panel reads the local store, appears for every file in
every workspace (connected or not), shows what changed between versions, and
still surfaces the cloud's `hist` revisions where they reach further back.
Releasable because it replaces one read path with another and leaves every
write path as it is.

### 5.1 Files

Add `src-tauri/src/versions/history.rs` (derivations over snapshots),
`src/HistoryRail.tsx` (the version list) and `src/VersionPreview.tsx` (the
document area while a version is shown). Modify: `versions/mod.rs`
(commands), `versions/status.rs` + `src/versions.ts` (types),
`src/Sidebar.tsx:857` (drop the `cloud &&`), `src/TabBar.tsx` and
`src/DraftsPanel.tsx` (entry points), `src/App.tsx` (the rail's open state,
the preview swap, the shortcut), `src/App.css`. Delete `src/HistoryPanel.tsx`
once the rail covers its two exits — the modal is what §12 argues against.

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
  label: string | null; pinned: boolean; restoredFrom: number | null;
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

The design and its reasons are §12; this is what phase 2 builds of it.

- **The history rail** (`HistoryRail.tsx`) — a right rail in the place the
  comments rail takes (`.comments-rail` in `App.css` is the pattern), listing
  the document's versions newest first, **grouped by day** with the ladder
  visible: today's and yesterday's rows show every retained version with a
  time; older days show as one row per day that expands to the versions it
  holds; older weeks and months the same. Each row: the time, `by`, a small
  reason word (`end of session`, `while editing`, `first seen`, `before a
  restore`), and the label in bold when there is one. A pinned row keeps a
  pin glyph. The header says how far back history reaches ("Every change
  since 3 Jun") and, when the workspace is connected, where it lives ("14
  here · 212 in the cloud"). Top of the rail: **Name this version** — a
  one-line input that calls `versions_capture_now(root, "manual", label)`.
- **The preview** (`VersionPreview.tsx`) — selecting a row shows that
  version **in the document area, in place, read-only**: the live editor's
  pending autosave is flushed (`flushPendingAutosave`), the live editor is
  hidden, and a read-only `Editor` (`readOnly`, which Crepe already
  supports — `Editor.tsx:180`) mounts with the version's text under a
  banner: "Viewing the version from Tue 2 Sep, 14:32 · *Restore this
  version* · *Make a copy* · *Back to now*". Read-only means no autosave
  path exists for the old text, which is the whole safety argument for the
  swap. *Back to now* (and `Esc`, and closing the rail) unmounts the preview
  and shows the live editor again.
- **Show changes** — a toggle in the banner that swaps the rendered preview
  for `versions_diff` against the next-newer version (or the current file
  for the newest), rendered as a line diff with `+`/`-` classes. A rendered
  block-level diff inside the editor is the §12 refinement, not this phase.
- **Restore** — `versions_restore_file(root, path, hash)`, a Rust command
  that does three things in order: capture `pre-restore` (forced, bypassing
  the cadence, digest-deduped — the preview already flushed autosave, so
  this is the user's latest text), write the blob's bytes through a shared
  `fn write_workspace_file(app, path, bytes)` that does what `write_file`
  does (stat, write, refresh the watcher store, `edits::touched`), then
  capture `restore` with `restoredFrom` set to the source version's `ts`.
  It answers `{preRestoreTs, preRestoreHash}` and emits `versions-applied
  {root, paths}`, which `App.tsx` handles like `cloud-applied` (refresh the
  tree, reload open tabs). The preview closes, the live document reloads,
  and the rail's newest row reads "restored from Mon 1 Sep 09:10". A toast
  says "Restored the version from 1 Sep — *Undo*", and Undo is
  `versions_restore_file(root, path, preRestoreHash)` — the same command,
  so undoing a restore is itself a restore (the app's undo-toast pattern
  from stop-publishing). ⌘Z is not promised for a restore; the timeline is
  the undo. Never two calls from the frontend (a capture, then a
  `write_file`) — the cadence could capture between them.
- **Make a copy** — a plain `write_file` of the version's text to
  `<stem> (version 1 Sep 09.10)<ext>` beside the original (the naming of
  `merge.rs`'s conflict copies: a dot in the time, never a colon), the
  numbered-suffix loop from `HistoryPanel.tsx` kept for collisions, then
  `onOpenFile`. The copy's own history begins at its creation; the
  original's is untouched. This is the only way a history forks, and it
  forks into a second file, never a branch.
- **Entry points** — the sidebar's file menu (`Version history…`, no cloud
  condition), the tab's context menu, the drafts panel's row menu (the
  draft's root is the drafts store), and `⌘⌥H`, which toggles the rail for
  the active document. Nothing is behind the Cloud panel.

### 5.5 Tests and the harness

Rust (`history.rs`): `versions_follow_a_rename_backwards`,
`a_recreated_path_starts_a_new_history`, `equal_hashes_collapse_to_one_entry`,
`current_marks_the_version_on_disk`, `diff_is_unified_and_capped`,
`cloud_prefix_matches_dedupe_against_local`; and for the restore:
`restore_captures_the_state_it_leaves_then_the_state_it_made`,
`restore_names_its_source`,
`restore_with_nothing_unsaved_dedupes_the_pre_restore_capture`,
`undo_of_a_restore_is_a_restore_of_the_pre_restore_hash`,
`restore_never_removes_a_snapshot`.

Harness: a new `verify-harness/drive-versions.mjs` over `cloud.html` (it
already boots the real `<App/>` with a `/docs` workspace). Extend the IPC
stub with `versions_*` answering from a scripted `window.__versions` (the
pattern of `window.__cloud`, including `calls`), and walk: *Version history…*
present with **no** cloud status; the rail's day groups and an expanded
older day; selecting a version swaps the document area for a read-only
preview with the banner (and the live editor's text is untouched
afterwards); `Esc` returns to now; *Show changes* renders a `+` line;
*Restore* calls `versions_restore_file`, the rail gains a row reading
"restored from …", and the toast's *Undo* calls it again with the
pre-restore hash; *Make a copy* opens a tab named with the version's date;
*Name this version* calls
`versions_capture_now` with the label and the row shows it; the tab menu
and `⌘⌥H` open the rail; a draft's history opens; with a cloud status set, a
cloud-only revision appears with its badge and reads through
`cloud_revision`. `drive-cloud.mjs`'s history step is rewritten for the
rail (it now exercises the read-through).

### 5.6 Docs and done

- `versioning.md` §8 (surfaces) *as built*; `cloud.md` §6.9 says history is
  read from the version store with the manifest's `hist` as a fallback until
  phase 6; `README.md` Features: the autosave bullet gains a sentence on
  version history; `SKILL.md` gains `drive-versions.mjs`.
- [x] Rust, lint, tsc green; `drive-versions.mjs` and `drive-cloud.mjs` pass.
- [ ] Manual: history for a file in an unconnected folder; restore; the diff.
      (Built on a Linux runner, which compiles and tests the crate and drives
      the real `<App/>` in Chromium but cannot launch the app;
      [versioning-testing.md](versioning-testing.md) §2–§4 is that walk.)

### 5.7 As built

What phase 2 settled, or decided differently from the sketch above:

1. **A version is dated where its content first appeared.** The walk emits
   one row per run of equal hashes, keeping the *oldest* of the run — a
   document untouched for a week reads as "last changed a week ago" rather
   than as a version at every snapshot since. A **pinned** row is never
   collapsed into its neighbour: *Name this version* on a document nothing
   has changed in has to leave a moment behind, which is the whole point of
   naming one.
2. **`file_versions` cannot fail**, so it answers a `Vec` rather than a
   `Result`; a snapshot file that has gone missing is skipped. It takes the
   index and the versioner's decode cache (32 snapshots) alongside the
   store, and the file's hash on disk, which is what marks the current row —
   only the newest match wears the badge, since after a restore an older row
   holds the same bytes and is still an older row.
3. **A path missing from the newest snapshots does not end the walk** before
   it has started: a file created (or restored) since the last capture, and
   a deleted one, still list what the older snapshots hold. Only a path that
   vanishes *mid-walk* with no rename to follow ends it — which is what
   makes a recreated path a new history.
4. **`FileHistory` carries the store's `root`.** Every other version command
   is keyed by it, and a caller (a draft's rail especially) has no other way
   to know which folder a document belongs to.
5. **`versions_diff(root, path, from, to)`** — either side's hash may be
   null, meaning the file on disk. That is how the newest version is
   compared against now, and it keeps one command for every pair.
6. **`versions_restore_file(root, path, ts, hash, text)`** — `ts` becomes
   the new snapshot's `restoredFrom`, and `text` names content the local
   store never saw, so a revision only the cloud still holds restores
   through the same single command. The versioner takes the write as a
   closure rather than an `AppHandle`, which keeps Tauri out of it and the
   restore's three steps testable.
7. **The rail groups by day only.** Older weeks and months are already one
   snapshot apiece by the time the ladder has thinned them, so day groups
   give the shape §5.4 asks for without a second level of nesting.
8. **The rail follows the document.** Opening history for a file in the tree
   opens the file first — a version shows in the document area, so the
   document has to be the one standing in it — and switching tabs while the
   rail is open re-points it and drops any preview.
9. **`ContextMenu` moved to `src/ContextMenu.tsx`** out of `Sidebar.tsx`, so
   the tree, a tab and a draft row raise the same menu and *Version
   history…* reads identically from all three.

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
DELETE /api/history/<fid>                  new beside the old GET/PUT: phase 6 deletes the archives
```

Id grammar: `^\d{13}-[a-z0-9][a-z0-9_-]{2,63}$`; hash `^[a-f0-9]{64}$`. The
index's shape check mirrors the local index plus `horizonDays: number | null`
and, per entry, `id` and `device`. `version.ts`: `WORKER_VERSION = 3`,
`"versions"` in `WORKER_FEATURES`, a comment line for 3. `README.md` (the
worker's) and `cloud.md` §5.2–5.3 gain the routes. `run.mjs`: auth on the
routes, create-only on snapshot and blob, index CAS (428/412/"*"), caps, the
listing's paging, `DELETE /api/history/<fid>` (204 on a missing one too),
and that wipe leaves no `versions/` key.

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

- [x] `pnpm typecheck:worker`, `pnpm test:worker`, `pnpm bundle:worker` and
      the bundle run green; the bundle stays under the ceiling.
- [x] Rust and harness green.
- [ ] Manual, against a deployed worker: update it with the app's prompt,
      watch `versions/` fill, open history on a second Mac and see the
      first Mac's versions. *Not run: this runner is Linux and the app is
      macOS-only. It is the pass [versioning-testing.md](versioning-testing.md)
      §4 describes.*

### 6.5 As built

Everything above landed as specified, with these decisions the plan left to
the build. Each is carried into [versioning.md](versioning.md) §6.3, §8 or
[cloud.md](cloud.md) §6.9.

1. **The cloud index carries only what several devices must agree on** —
   `{version, horizonDays, snapshots: [{id, ts, device, reason, files,
   bytes, digest, pinned?, label?, restoredFrom?}]}`. The local index's own
   bookkeeping (`root`, `createdMs`, `lastCaptureMs`, `lastSweepMs`) is this
   Mac's business and stays here.
2. **A snapshot the cloud ladder would not keep is never uploaded.** The
   plan's step 2 skips a snapshot by digest; that is not enough. With
   several devices in one workspace the bucket's bucket-winners are not this
   Mac's, so a snapshot this Mac keeps locally can be one the cloud ladder
   thins — and without this check the device would re-upload it, and the
   sweep drop it, on every pass, forever.
3. **A named version is exempt from every skip**, digest included. *Name
   this version* is a user act on a moment; the name lives in the index and
   has to reach the bucket even when the content is already up there.
4. **A downloaded snapshot is cached at `<store>/cloud-cache/<id>.json.gz`.**
   Snapshots are immutable, so a cached copy is never stale. The plan gave
   the cache to the read-through; the daily sweep uses the same one to
   answer "what do the retained snapshots reference?", which is what keeps
   that pass to one download per snapshot rather than one per day.
5. **The read-through is one walk, not a merge.** Mirrored snapshots join
   this Mac's own retained set ordered by time (`history::retained_set`), so
   a rename another Mac made is followed exactly like one made here and a
   run of equal content collapses across both stores. The rail's history
   call pre-fetches up to `CLOUD_PREFETCH` (48) missing snapshots, newest
   first, so the first open on a freshly connected Mac costs a moment rather
   than the whole bucket; the mirror's own sweep fills the rest.
6. **`source` has three values, not two.** Phase 2 used `cloud` for the sync
   manifest's revisions; those are now `manifest`, and `cloud` means the
   mirrored version store. The distinction is real — a `cloud` version is
   read and diffed through the version store, a `manifest` one only through
   `cloud_revision` — and phase 6 deletes exactly the `manifest` case. Only
   a `local` version is restored by hash; the other two hand
   `versions_restore_file` their text.
7. **`versions_diff` resolves both sides before comparing**, so *Show
   changes* works on a mirrored version. `history::diff` became
   `history::diff_texts` plus a resolver in the command.
8. **`uploaded` is pruned to what the store still holds** on every pass, so
   the engine's persisted state cannot grow without bound.
9. **`DELETE /api/history/<fid>` ships now, unused.** The route is phase 6's;
   adding it here keeps the worker's version bump to one. No `Remote` method
   goes with it until phase 6 calls it, so the trait has no dead code.
10. **The engine opens the version store from its path** (`data_dir` on
    `EngineConfig` plus `versions::store_for_root`), not through the
    versions manager. Reads only: the mirror never writes into a local
    store, so "nothing outside `retain.rs` deletes" still holds.
11. **The Cloud panel gains a *Version history* line** (`versionsLine` in
    `src/cloud.ts`): what the domain holds, or that its worker is too old to
    hold any — beside the update card that fixes it. A worker that has never
    answered `/api/meta` is a third case, and says so: never having heard is
    not the same as having heard "too old", and only one of those asks the
    user to do something.
12. **The hourly pass re-probes a worker without the feature.** The engine
    probes `/api/meta` at start and after a 426, so a device that started
    offline — or one whose worker was updated while it ran — would otherwise
    never learn it can mirror. The re-probe rides the hourly pass only,
    never the per-cycle one, so a domain that will never answer differently
    costs one request an hour rather than one per cycle.

### 6.6 What the mirror costs at ten devices

The phase was sized for one Mac and a second one. Three of its choices are
per-device and therefore multiply by the number of people in the workspace.
None is a blocker on its own — the totals stay in the low percentages of R2's
free Class A allowance ([versioning.md](versioning.md) §7.1) — and none is
worth a change until the ceiling in [cloud.md](cloud.md) §11 moves, because
that is what a team actually hits first. They are written down so the next
person sizing this does not size it for one Mac again.

1. **`uploaded` is per device** (`engine.rs:157`), so every Mac create-only
   `PUT`s every blob its snapshots reference. After a sync that is the whole
   workspace, so one version of one note can cost ten Class A writes, nine of
   which store nothing. A shared "what is up there" — the blob listing the
   sweep already pages — would collapse it.
2. **`load()` reads the cloud index on every pass** (`cloud/versions.rs:155`),
   and a pass runs per changed cycle (`engine.rs:547`), so this is one request
   per edit per device rather than one an hour. The index's etag is already
   held across a pass; holding it *between* passes and revalidating would make
   it conditional.
3. **`last_cloud_sweep_ms` is per device** (`engine.rs:161`), so ten Macs each
   run the daily sweep: ten index rewrites, ten walks of the retained set
   (cached, so cheap) and ten full paged blob `LIST`s, which are Class A. A
   `lastSweepMs` in the cloud index would make it one sweeper a day for the
   workspace instead of one per Mac.

A fourth is a correctness-of-attribution gap rather than a cost:
**`by` is the capturing device, not the authoring one**
([versioning.md](versioning.md) §6.3). It cannot be fixed inside this phase —
it needs an identity to attribute to, which is [cloud.md](cloud.md) §11.1.

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
                                  -> { written: number, trashed: number, preRestoreTs: number }
versions_deleted(root)            -> [{ path, lastSeenMs, hash, size }]
versions_restore_file             phase 2's command, reused for a deleted file (it recreates
                                  the parent directories)
```

`versions_restore_snapshot` is the file restore's shape at workspace scale:
capture `pre-restore` first (forced, digest-deduped) so the restore is
itself undoable; then, for each path in scope, write the blob's bytes
through phase 2's `write_workspace_file`, creating parent directories;
trash files that are on disk now and were not then through
`trash_path_impl` (`macOS-only`, as it is); then capture `restore` with
`restoredFrom` = the chosen snapshot's `ts`, and emit `versions-applied
{root, paths}`. The timeline then shows both rows, and the toast's *Undo*
is `versions_restore_snapshot(root, preRestoreTs, the same paths)`. The
cloud engine's mass-delete valve still applies to a restore that trashes
many files — that is correct and stays.

`versions_deleted` walks retained snapshots newest → oldest and reports paths
present in some snapshot, absent from the newest, and not on disk;
`lastSeenMs` is the newest snapshot that held it, `hash` its content then.

### 7.2 Surfaces

Per §12: the workspace timeline is a modal (a workspace-level act, not an
in-document one); deleted files are a sidebar row, because deletion is the
moment nobody goes looking for a menu.

- **`WorkspaceHistory.tsx`** — a modal in the `cloud-modal` chrome: the
  retained snapshots as a timeline grouped by day (newest first), each row
  carrying its delta against the previous snapshot ("+2 −1 ~5", from two
  adjacent snapshots' maps) and its label when it has one; selecting a row
  shows *what restoring it would do* — `changed`, `added` (on disk now, not
  then: these would be trashed) and `missing` (then, not now: these come
  back) — with per-file checkboxes, *Restore selected* and *Restore all*,
  and an inline confirm that says the counts ("Write 5 files, bring back 1,
  move 2 to the Trash?") — never `window.confirm`, which the harness
  auto-dismisses. A note under the list: "A snapshot of now is taken first,
  so this can be undone." Reached from the sidebar root's context menu
  (*Workspace history…*) and the Cloud panel.
- **Recently deleted** — a dimmed row at the bottom of the workspace
  sidebar, shown only when `versions_deleted` is non-empty, with the count
  ("Recently deleted · 3"). It opens `RecentlyDeleted.tsx` in the sidebar's
  own column (the search mode is the pattern): each file's name, its old
  folder, when it was last seen, *Restore* (to the old path; a collision
  appends ` (restored)`) and *Open* (the last content, read-only, in the
  preview from phase 2). Also in the root's context menu.
- `data-testid`s on every control both drives use.

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

- [x] Rust, lint, tsc, harness green.
- [ ] Manual: reorganise a folder, restore yesterday's snapshot, see the
      restore itself in the history; delete a note on one Mac, restore it
      from the other.

### 7.4 As built

Shipped as written, with these decisions the plan left to the phase. The
first four are carried into [versioning.md](versioning.md) §8 as an *as
built* note.

1. **The diff is against disk, not against the last capture.**
   `versions_snapshot_diff` scans the folder as it stands this second, using
   the newest snapshot's map as a stat cache (a file whose size and mtime
   are unchanged is not re-read). A modal that says "what restoring would
   do" has to mean *now*, or it lies for the ten minutes between captures.
   A file the snapshot and the folder agree on is in none of the three
   lists, so a restore never rewrites what it need not touch — and the
   `versions-applied` event stays the size of the change rather than the
   size of the folder.
2. **A restore refuses before it starts, or not at all.** Every blob the
   plan needs is checked present before the pre-restore capture runs. A
   folder half-restored because the store ran out of bytes partway is not a
   state the app can reach.
3. **`SnapshotMeta` gained a `delta`.** The plan's timeline row shows
   "+2 −1 ~5"; the index cannot answer that, so `versions_snapshots` reads
   both file maps per row and counts. It is the only command that fills the
   field — a capture's answer leaves it null — because the walk costs one
   decode per retained snapshot, and the status must stay free.
4. **Recently deleted has a window: 30 days behind the newest snapshot.**
   The list is the union of the retained snapshots' paths minus what is on
   disk, which is a decode per snapshot; bounding it to the ladder's dense
   end keeps a surface the sidebar re-reads on every tree refresh cheap, and
   *recently* is what the row promises. The newest snapshot is always read
   however old it is, so a folder nobody has opened in months still answers.
   Deeper than that, the workspace timeline is the surface: restore the
   moment the file was last in.
5. **A restored file keeps its history.** Phase 2's walk stops where a path
   reappears from nothing — that is what makes a new note at an old note's
   path a new note. But a file brought back from *Recently deleted*
   reappears the same way, and "restore puts it back with its history" is
   this phase's promise. The walk now steps over the gap when the snapshot
   that holds the path again is a restore that says which moment its content
   came from, and only down to that moment. A plain recreation still starts
   its own story.
6. **`write_workspace_bytes`.** A snapshot holds every file type; a restore
   that round-tripped an image through `String` would corrupt it. The text
   entry point is unchanged and delegates.
7. **The parent directories come back with the files.** Both restores create
   them, so a folder deleted whole is restorable — from the timeline as
   `missing` rows, or a file at a time from *Recently deleted*.
8. **Trashing follows `cloud/engine.rs`'s `delete_local`**: the macOS Trash,
   falling back to a plain remove when it refuses (and off macOS, where the
   Rust tests run). Each trashed path rings the edit bus, so a connected
   workspace propagates the deletion like any other.
9. **The deleted list is read once.** `App.tsx` owns it: the sidebar's row
   needs the count and the column needs the list, and it is a walk of the
   store either way. It re-reads with the tree.
10. **The preview of a deleted file is `detached`.** `VersionPreview` shows
    over the pane holding its document; a file that is not on disk has no
    tab to stand in, so its preview carries its own `docPath` and shows over
    whatever pane is focused. `versionPreview` gained both fields.
11. **The confirm is inline, in the modal, never `window.confirm`** — as
    §7.2 requires, and because the harness auto-dismisses a system dialog.
    Its sentence is built from what is actually ticked.
12. **Both surfaces are ungated on the cloud**, like the rail: they read the
    local store, and `drive-versions.mjs` walks them with no cloud status at
    all.

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

### 9.0 The old system, piece by piece

So the clean-up can be checked as complete rather than assumed:

| Piece | Where | What happens to it | Phase |
| --- | --- | --- | --- |
| `hist` on each manifest file entry | `engine.rs` `build_manifest`, `manifest.rs` `HistEntry` | no longer written; the field stays (an empty array is valid v2) | 6 |
| The archive rollover | `engine.rs` `roll_archives`, `MANIFEST_HIST_MAX`, `ARCHIVE_HIST_MAX` | deleted | 6 |
| `history/<fid>.json` objects in the bucket | R2 | deleted once, lazily (below) | 6 |
| Sync blobs referenced only by `hist` / the archive | R2 `blobs/<fid>/` | collected by a one-time full inventory sweep (below) | 6 |
| `gc_candidates` (fids that rolled history) | `engine.rs` | replaced by "every fid pushed since the last GC" | 6 |
| `EngineCmd::History` / `Revision`, `Engine::history` / `revision` | `engine.rs` | deleted | 6 |
| `cloud_history` / `cloud_revision` commands | `cloud/mod.rs` | deleted | 6 |
| `Revision` | `cloud/status.rs` | deleted | 6 |
| `cloudHistory` / `cloudRevision` / `CloudRevision` | `src/cloud.ts` | deleted | 6 |
| The read-through branch | `HistoryRail.tsx` | deleted | 6 |
| `HistoryPanel.tsx` (the modal) | `src/` | replaced by the rail and the preview | 2 |
| `GET/PUT /api/history/<fid>`, `MAX_INLINE_HIST`, `MAX_HISTORY_*`, `validHistoryArchive` | the worker | **kept**, marked deprecated — older apps still send them; the API only grows | 6 (docs only) |
| The engine tests that pin history | `cloud/tests.rs` | replaced (below) | 6 |

### 9.1 Changes

- `engine.rs`: `build_manifest` no longer inserts the previous revision into
  `hist` (leave the field, always empty); delete `roll_archives`,
  `ARCHIVE_HIST_MAX`, `MANIFEST_HIST_MAX` and its assert, `gc_candidates`'
  dependence on rollover — `gc_blobs` now considers every fid pushed since
  the last run and keeps only the current hash (still behind `GC_MIN_AGE_MS`,
  still every 20th cycle); delete `history`, `revision`,
  `EngineCmd::History` / `Revision`; `status.rs` drops `Revision`.
- **A one-time clean-up of the bucket**, driven from the engine's poll so it
  costs nothing on the hot path and survives restarts: `WorkspaceState`
  gains `legacy_cleanup: {archives_done: bool, inventory_cursor: Option<String>}`.
  While `archives_done` is false, each poll deletes the archive of up to 50
  fids (`DELETE /api/history/<fid>`, phase 3's route; a `404` counts as
  done) and advances; then, while `inventory_cursor` is set, each poll
  lists the blobs of up to 50 fids and deletes every hash that is not the
  file's current one and is older than `GC_MIN_AGE_MS`. A workspace of 5000
  files finishes both passes in about an hour of polling. A worker without
  the DELETE route (older than 3) leaves `archives_done` false and the pass
  waits — never an error.
- `mod.rs`: delete `cloud_history` / `cloud_revision`; `src/cloud.ts` drops
  their wrappers and `CloudRevision`; `HistoryRail.tsx` drops the
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
- [ ] `legacy_cleanup_deletes_archives_then_sweeps_old_blobs_across_polls` and
      `legacy_cleanup_waits_on_a_worker_without_the_route` pass; after the
      sweep the fake bucket holds one blob per file and no `history/` key.
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
versions_capture_now(root, reason?, label?)          -> SnapshotMeta | null
versions_set_pinned(root, ts, pinned, label?)
versions_set_enabled(enabled)
versions_history(path)                               -> FileHistory
versions_read(root, hash)                            -> string
versions_diff(root, fromHash, toHash)                -> string
versions_snapshot_diff(root, ts)                     -> SnapshotDiff
versions_restore_snapshot(root, ts, paths | null)    -> RestoreReport
versions_deleted(root)                               -> DeletedFile[]
versions_restore_file(root, path, hash)              -> {preRestoreTs, preRestoreHash}
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
| `DELETED_WINDOW_MS` | 30 days | `versions/workspace.rs` | 4 |

## 12. The surfaces — the UX, decided

The phases above build these; this section is why they look the way they
do, so the reasoning is not re-litigated one PR at a time. It is an honest
comparison of what exists, against what Doklin already is.

### 12.1 What the field does

- **Notion** — *Page history* is a full-window overlay: the page rendered
  read-only in the middle, a list of versions down the right grouped by
  date with times and avatars, *Restore*. Recently a diff highlight on
  changed blocks. No names, no comparison between two arbitrary versions,
  no workspace-level view. Trash is a separate sidebar item with its own
  clock; deleted pages never appear in history.
- **Google Docs** — *Version history* is the reference everyone else
  measures against: a right rail listing versions grouped by day, each day
  expandable to the finer versions inside it (the retention shape is
  visible in the list itself); the document stays in place and shows the
  selected version with changes highlighted (additions coloured, deletions
  struck through); *Show changes* toggles the highlighting; *Name this
  version*; *Restore*; *Make a copy*. Whole-document only.
- **Obsidian** — *File recovery* and Sync's history are a modal with a list
  of timestamps and a raw diff. Functional, joyless, out of context.
- **Dropbox Rewind** — the reference for whole-folder restore: a timeline
  of activity, pick a moment, a summary of what restoring it would do
  ("12 files change, 3 deletions undone"), confirm; itself undoable.
- **Apple Notes / Photos** — *Recently Deleted* is a folder in the sidebar,
  always where the user already is. It needs no discovering, which is the
  entire point at the moment of a panic.
- **macOS Time Machine** — the cascade is beautiful, whole-screen and
  heavy; a 3D metaphor for a list. Not for a notes app.

### 12.2 What Doklin already is

A document in the middle, a sidebar of files, tabs; a **right rail** that
already exists for comments (`CommentsRail`); an `Editor` that already
renders **read-only** (the split view's mirror pane uses it); a peek panel
beside a board; modals for cloud administration. The history UI should be
made of those parts, not of a new kind of surface.

### 12.3 The decision

**Google Docs' model for a document, Apple's for deletion, Dropbox's for
the workspace.** Notion's is not chosen on its merits, not on taste: the
overlay takes the user out of their document, offers no way to see what
changed until recently and no way to name a moment, and its deletion story
lives in a second system with a second clock — the exact shape the spec
rejects.

1. **A document's history is a rail, and a version shows in place.** The
   rail lists versions grouped by day, older days collapsed to one row each,
   so the list *is* the ladder: dense for today, one line per day for the
   month, one per week for the year. Selecting a version shows it in the
   document area, rendered by the same editor the user writes in, read-only,
   under a banner with the three exits. The user never leaves the page, and
   the old version can never be autosaved over the new one because the
   preview has no write path at all.
2. **Changes are a toggle, not a mode.** *Show changes* on the banner. A
   line diff first (phase 2: `diffy`, coloured `+`/`-`), because it is
   correct for a markdown tool and cheap; a rendered block-level diff in the
   editor (added blocks tinted, removed blocks shown struck) is the
   refinement once the rail exists — a decoration plugin over the
   ProseMirror document, computed from a block-sequence diff of the two
   markdown texts. Worth doing; not worth blocking phase 2 on.
3. **Named versions.** One input at the top of the rail. The store pins a
   named snapshot so the ladder never thins it, and *Name this version* on
   a moment nothing changed since simply names that moment. This is the
   thing Notion lacks that people ask for most, and it costs a text field.
4. **Deleted files are a sidebar row.** *Recently deleted · 3* at the foot
   of the tree, only when there is something in it, opening in the sidebar's
   own column. Also on the root's menu, but the row is the point.
5. **The workspace is a timeline in a modal.** Choosing a moment for the
   whole folder is a deliberate, occasional act; a modal with a confirm that
   states the counts is right for it, and a snapshot of *now* is taken first
   so the restore itself appears in the timeline and can be undone from it.
   Browsing the tree *as of* a moment inside the sidebar is the elegant
   version of this and is a later refinement, not the first cut.
6. **Reachable from where the document is.** The sidebar's file menu, the
   tab's menu, the drafts panel and `⌘⌥H` — never only behind the Cloud
   panel, because history is no longer a cloud feature.
7. **The trust line.** The rail's header says how far back history goes
   ("Every change since 3 Jun"), and the Cloud panel says where it lives.
   The promise the user asked for — *you cannot lose this* — is a sentence
   they can read, not a feature they have to find.
8. **A restore never branches.** The timeline is a sequence of states, not
   a graph of edits: an old version cannot be edited in place (the preview
   is read-only), so restoring it writes it as the *new* current state and
   everything between stays as older rows — after Monday is restored on
   Thursday, Tuesday and Wednesday are not on an abandoned branch; they are
   just older. Both the state being left and the state being made are
   captured, the second naming its source, and the toast's *Undo* is
   another restore. The only fork is *Make a copy*, and it forks into a
   second file. This is what every mainstream product does, for the same
   reason: people ask "what did this look like on Tuesday", never "which
   branch". One consequence to say out loud: the state a restore leaves
   follows the ladder like any other row, so *Name this version* is how a
   moment is kept forever, and the restore confirm says so in a line.

### 12.4 What was rejected

- **A modal for a document's history** (what exists today, and Obsidian's
  shape) — out of context, no comparison with the live text, and a `<pre>`
  of raw markdown for a WYSIWYG editor.
- **A split pane for the preview** — the split view is real and would give
  synchronised scrolling between now and then for free, but it couples the
  history UI to the most intricate state in `App.tsx`. Kept as an option
  for later ("Open in split" on the banner); not the first cut.
- **A slider or timeline scrubber** — appealing for a demo, poor for
  finding "the version before I rewrote the intro"; a list with day groups
  answers that in one glance.
- **Auto-showing a diff on every selection** — noisy on a version that
  differs by a paragraph; a toggle that remembers its state is calmer.
- **A first-run toast announcing history** — tempting for discoverability,
  but an announcement is not a surface. The sidebar row and the tab menu
  are where the user already looks; the trust line in the rail does the
  telling.
