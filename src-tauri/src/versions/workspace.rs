//! The workspace-scale derivations (docs/versioning-plan.md §7.1): what a
//! retained snapshot differs from the folder on disk, every file some
//! snapshot held that is not on disk any more, and the restore that puts a
//! whole moment back.
//!
//! Everything here reads the store; the one thing that writes writes into
//! the *workspace*, through the same `write_workspace_file` the rest of the
//! app uses, and never into a store. Only `retain.rs` deletes from a store.
//!
//! A restore at this scale is the file restore's shape (§5.2), one size up:
//! capture the state it is about to leave, write, trash what was not there
//! then, capture the state it made. The moments in between stay exactly
//! where they are — a restore never branches (docs/versioning-plan.md §12.3).

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::Serialize;

use crate::cloud::scan::{read_file_checked, scan_local};

use super::status::SnapshotDelta;
use super::store::{hash_full, FileEntry, Index, Store};

/// How far back *Recently deleted* looks, measured from the newest retained
/// snapshot rather than from now — a folder nobody has opened for six weeks
/// still shows what was deleted out of it. Beyond this the workspace
/// timeline is the surface: the row is *recently* deleted, and the walk it
/// costs is one snapshot decode per row.
pub const DELETED_WINDOW_MS: u64 = 30 * 24 * 60 * 60 * 1000;

/// One file the folder and a snapshot disagree about.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    /// The content the snapshot holds — what a restore would write.
    pub then_hash: String,
    /// The content on disk now.
    pub now_hash: String,
}

/// What `versions_snapshot_diff` answers: the whole of what restoring one
/// snapshot would do, before anything happens.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotDiff {
    pub changed: Vec<ChangedFile>,
    /// On disk now and not in the snapshot: a restore moves these to the
    /// Trash.
    pub added: Vec<String>,
    /// In the snapshot and not on disk: a restore brings these back.
    pub missing: Vec<String>,
}

/// One file that was here and is not — a row of *Recently deleted*.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedFile {
    /// Workspace-relative, as the snapshot held it.
    pub path: String,
    /// The newest snapshot that still had it.
    pub last_seen_ms: u64,
    /// Its content then, for the preview and the restore.
    pub hash: String,
    pub size: u64,
}

/// What `versions_restore_snapshot` answers. `preRestoreTs` is the snapshot
/// holding the workspace as it was a moment ago — the *Undo* is a restore
/// of that one, with the same paths.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    pub written: u64,
    pub trashed: u64,
    pub pre_restore_ts: Option<u64>,
}

/* ---------- The folder, now ---------- */

/// The workspace as it is this second, hashed the way a capture hashes it:
/// `last` (the newest snapshot's file map) is the stat cache, so a file
/// whose size and mtime are unchanged is never read again. The error is the
/// scan's own — a folder past the entry cap has no diff, only a sentence.
pub fn disk_now(store: &Store, last: &BTreeMap<String, FileEntry>) -> Result<BTreeMap<String, FileEntry>, String> {
    let scanned = scan_local(&store.root).map_err(|_| too_large())?;
    let mut out = BTreeMap::new();
    for (rel, entry) in &scanned {
        let cached = last.get(rel).filter(|c| c.s == entry.size && c.m == entry.mtime_ms && !c.h.is_empty());
        let hash = match cached {
            Some(c) => c.h.clone(),
            // Unreadable, or past the file cap the worker enforces: capture
            // skips it too, so no snapshot holds it and the diff must not
            // see it either — an oversized asset is not something a restore
            // moves to the Trash.
            None => match read_file_checked(&entry.abs) {
                Some(bytes) => hash_full(&bytes),
                None => continue,
            },
        };
        out.insert(rel.clone(), FileEntry { h: hash, s: entry.size, m: entry.mtime_ms });
    }
    Ok(out)
}

/// The paths the folder holds right now — the cheap half of `disk_now`,
/// with nothing hashed. All *Recently deleted* needs.
pub fn disk_paths(store: &Store) -> Result<BTreeSet<String>, String> {
    Ok(scan_local(&store.root).map_err(|_| too_large())?.into_keys().collect())
}

fn too_large() -> String {
    format!(
        "this folder holds more than {} files — too large to keep versions of",
        crate::cloud::scan::MAX_SYNC_ENTRIES
    )
}

/* ---------- The diff ---------- */

/// What separates a snapshot's file map from the folder on disk. A file
/// whose bytes are the same in both is in none of the three lists: a
/// restore has nothing to do to it.
pub fn diff(then: &BTreeMap<String, FileEntry>, now: &BTreeMap<String, FileEntry>) -> SnapshotDiff {
    let mut out = SnapshotDiff::default();
    for (path, entry) in then {
        match now.get(path) {
            None => out.missing.push(path.clone()),
            Some(current) if current.h != entry.h => out.changed.push(ChangedFile {
                path: path.clone(),
                then_hash: entry.h.clone(),
                now_hash: current.h.clone(),
            }),
            Some(_) => {}
        }
    }
    for path in now.keys() {
        if !then.contains_key(path) {
            out.added.push(path.clone());
        }
    }
    out
}

/// What separates two adjacent snapshots, counted rather than listed — the
/// timeline's "+2 −1 ~5", from the same classification a restore plans by.
pub fn delta(before: &BTreeMap<String, FileEntry>, after: &BTreeMap<String, FileEntry>) -> SnapshotDelta {
    let mut out = SnapshotDelta::default();
    for (path, entry) in before {
        match after.get(path) {
            None => out.removed += 1,
            Some(now) if now.h != entry.h => out.changed += 1,
            Some(_) => {}
        }
    }
    out.added = after.keys().filter(|path| !before.contains_key(*path)).count() as u64;
    out
}

/* ---------- Recently deleted ---------- */

/// Every file a retained snapshot held that the folder does not hold now,
/// most recently seen first.
///
/// The walk runs newest → oldest and stops at `DELETED_WINDOW_MS` behind the
/// newest snapshot, so its cost is bounded by the ladder's dense end rather
/// than by the whole horizon; the newest snapshot is always read, however
/// old it is, so a folder nobody has touched in months still answers.
pub fn deleted(store: &Store, index: &Index, on_disk: &BTreeSet<String>) -> Vec<DeletedFile> {
    let Some(newest) = index.newest().map(|row| row.ts) else { return Vec::new() };
    let mut out: Vec<DeletedFile> = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for (nth, row) in index.snapshots.iter().rev().enumerate() {
        if nth > 0 && newest.saturating_sub(row.ts) > DELETED_WINDOW_MS {
            break;
        }
        let Some(snap) = store.read_snapshot(row.ts) else { continue };
        for (path, entry) in &snap.files {
            if on_disk.contains(path) || !seen.insert(path.clone()) {
                continue;
            }
            out.push(DeletedFile {
                path: path.clone(),
                last_seen_ms: row.ts,
                hash: entry.h.clone(),
                size: entry.s,
            });
        }
    }
    out
}

/* ---------- The restore ---------- */

/// The paths a restore of `then` would touch, narrowed to `only` when the
/// user ticked a subset. Answers (write, trash) — write is what the
/// snapshot holds and disk does not match, trash what disk holds and the
/// snapshot never did.
pub fn plan(diff: &SnapshotDiff, only: Option<&BTreeSet<String>>) -> (Vec<String>, Vec<String>) {
    let wanted = |path: &String| only.map(|set| set.contains(path)).unwrap_or(true);
    let mut write: Vec<String> = diff.changed.iter().map(|c| c.path.clone()).filter(wanted).collect();
    write.extend(diff.missing.iter().filter(|p| wanted(p)).cloned());
    write.sort();
    let trash: Vec<String> = diff.added.iter().filter(|p| wanted(p)).cloned().collect();
    (write, trash)
}

/// Move a file out of the workspace the way the app does: to the Trash on
/// macOS, and — when the Trash refuses, or off macOS — by removing it. The
/// engine's `delete_local` makes the same choice for the same reason.
pub fn trash_or_remove(path: &Path) -> bool {
    #[cfg(target_os = "macos")]
    {
        if crate::trash_path_impl(&path.to_string_lossy()).is_ok() {
            return true;
        }
    }
    std::fs::remove_file(path).is_ok()
}
