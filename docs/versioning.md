# Versioning

A local snapshot store per open folder, mirrored to the bucket when connected. Code: `src-tauri/src/versions/`, mirror `src-tauri/src/cloud/versions.rs`, worker `cloud-worker/src/versions.ts`. Sync: docs/cloud.md. Inspect: `scripts/versions.sh [-w] <folder>`.

## Rules

- Only `retain::sweep` deletes from a local store, by the ladder; besides it, only `stores::forget` (whole store, user-asked, refused while its folder is open), `cloud-cache/` pruning and the one-time `versions/drafts` removal in `untitled.rs`. File deletes, restores, disconnect and wipe never do. Bucket `versions/`: only the cloud sweep and a wipe.
- Stores live in `<app_data>/versions/`, never in a workspace.
- In a connected workspace (the folder carries the cloud marker) `Private/` and `Restricted/` are never in the workspace's store (`space::shared_skip`). Each section's folder has a store and a versioner of its own (`cloud::section_roots`), mirrored to that space's own `versions/`. Otherwise a Private's content would reach the store everyone reads.
- A space's folder that leaves this Mac takes its store with it (`forget_root`).
- The versioner is independent of the cloud engine: own watcher plus `edits::touched`, own `scan_local`, path-keyed snapshots (no sync file ids); works with no cloud.
- Write order: blobs → snapshot → index (`write_atomic`). Sweep order: index → snapshots → blobs. A crash leaves orphans, never a row missing bytes.
- A restore is one Rust command (`versions_restore_file`, `versions_restore_snapshot`): capture `pre-restore`, write through the app's write path, capture `restore` with `restoredFrom`. Never a capture plus `write_file` from the frontend: the cadence can land between them. Undo is another restore (of `preRestoreHash`, or `preRestoreTs` + same paths). History never branches.
- A snapshot restore checks every blob first, writes via `write_workspace_bytes` (never through `String`), and trashes via `workspace::trash_or_remove` plus `edits::touched`.
- The preview is a `readOnly` `Editor`: an old version can't be autosaved over the current one. `flushPendingAutosave` first.
- The engine only reads a local store (it writes only `cloud-cache/`). Bucket `versions/` never references sync `blobs/<fid>/`; `gc_blobs` knows nothing of snapshots.
- No `versions` worker feature: no mirror, null `CloudStatus.versions`, not an error; hourly re-probe.
- `by` is the capturing Mac (`cloud::device_name`), not the author.

## Capture and retention

- `interval`: at most one per `CAPTURE_MIN_INTERVAL` (10 min) of activity. `closing`: `SESSION_IDLE` (2 min) after the last edit. Automatic capture is wall-clock bounded, whatever the filesystem does.
- Forced: `seed` (empty index), `closing` when a folder's last window closes and at quit (`flush_all_blocking` in the `RunEvent::ExitRequested | Exit` arm; a Dock Quit skips `begin_quit_flush`), `manual` (pinned; unchanged → pins the newest row), `pre-restore`, `restore`.
- Same digest as the newest row → nothing written.
- Ladder (UTC buckets, last in each): under 1 h all, under 24 h hourly, under 30 d daily, under 365 d per ISO week, then monthly. Newest and pinned always survive; the rest past the horizon goes.
- Local horizon: `index.json` `horizonDays`, else `settings.json` (`DEFAULT_HORIZON_DAYS` 90). Cloud horizon: cloud index `horizonDays`, default null (forever).

| Constant | Value | File |
| --- | --- | --- |
| `GC_GRACE` / `SWEEP_EVERY` | 1 h (blob mtime) / 6 h | `versions/retain.rs` |
| `DELETED_WINDOW_MS` | 30 d behind newest snapshot | `versions/workspace.rs` |
| `MIRROR_EVERY` / `CLOUD_SWEEP_EVERY_MS` / `CLOUD_GC_GRACE_MS` | 1 h / 24 h / 1 h | `cloud/versions.rs` |
| `MAX_SYNC_ENTRIES` | over → `too-large`, no snapshot | `cloud/scan.rs` |

## Local store

```
<app_data>/versions/
  settings.json               {version, enabled, horizonDays}
  <key>/                      "r-" + first 16 hex of sha256(canonical root)
    index.json                {version, root, createdMs, lastCaptureMs, lastSweepMs, horizonDays?, snapshots[]}
    snapshots/<ts13>.json.gz  {version, ts, reason, restoredFrom, by, files: {path: {h, s, m}}}
    blobs/<hh>/<sha256>.gz
    cloud-cache/<id>.json.gz  mirrored snapshots; a droppable cache
```

- Row: `{ts, reason, files, bytes, digest, pinned, label, restoredFrom}`. `ts` is unique (collision → last + 1). `digest` = sha256 over `<path>\0<h>\n` in path order.
- `h` = full sha256 (sync `hash16` is its first 16 chars). `s`/`m` are the stat cache.
- `horizonDays` has three states: absent = settings default, `null` = forever, a number = days (`Option<Option<u32>>`, `chosen_horizon`).
- Reasons live in `store.rs`, `src/versions.ts` and the worker's `REASONS`; change all three (the worker 400s an unknown one).
- `scripts/versions.sh` duplicates the key derivation. A moved folder starts a new store.

## Cloud store

```
versions/index.json                           {version, horizonDays, snapshots: [row + id, device]}
versions/snapshots/<ts13>-<deviceId>.json.gz  create-only, local gzip bytes
versions/blobs/<sha256>                       create-only, local gzip bytes
```

- The index is CAS: GET answers `x-versions-etag`; PUT needs `x-base-etag` (`"*"` creates; 428 without one, 412 on a lost race). Local bookkeeping stays local. `device` is the device id.
- Mirror (after a changed cycle, and every `MIRROR_EVERY`), per local row the index lacks, oldest first: skip if the nearest older cloud row has the same digest (unless pinned) or the cloud ladder would drop it (`ladder_keeps`; else upload and sweep loop); else PUT blobs not in `versions_uploaded`, the snapshot, then CAS the index.
- Sweep: daily per device (`last_cloud_sweep_ms`). Index CAS, then dropped snapshots, then unreferenced blobs older than `CLOUD_GC_GRACE_MS`.
- `versions_history` walks local and cloud rows as one set (`history::retained_set`; same ts and digest = one row, local wins). A `cloud` version restores by `text`, a `local` one by `hash`.

## Contracts (change both sides)

- `versions/{status,history,workspace,stores}.rs` + commands in `versions/mod.rs` ⇄ `src/versions.ts`
- `cloud/versions.rs` ⇄ `cloud-worker/src/versions.ts` and `layout.ts`
- `VersionsMirror` in `cloud/status.rs` ⇄ `src/cloud.ts`

`WorkspaceState.legacy_cleanup` (`cloud/engine.rs`): one-time sweep of sync blobs the retired manifest `hist` left, `LEGACY_BATCH` fileIds per poll.
