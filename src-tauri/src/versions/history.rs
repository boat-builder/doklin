//! Derivations over the retained snapshots (docs/versioning-plan.md §5.2):
//! every version of one file, the text of a version, and the diff between
//! two. Nothing here writes — the store is read-only from this module, and
//! only `retain.rs` ever deletes.
//!
//! A snapshot is a whole workspace keyed by path, so a file's history is a
//! walk back through the retained set: follow the path, follow a rename
//! when the path disappears under it, and emit one row per distinct
//! content. The contract this answers with is mirrored in src/versions.ts —
//! change both.

use std::path::Path;
use std::sync::Arc;

use serde::Serialize;

use crate::cloud::status::Revision;

use super::store::{hash_full, FileEntry, Index, Snapshot, Store};

/// Neither side of a diff may be larger than this — the worker's note cap
/// (`MAX_RENDER_BYTES` in cloud-worker/src/workspace.ts). Past it the user
/// gets a sentence: a patch nobody can read is worse than an honest no.
pub const MAX_DIFF_BYTES: usize = 4 * 1024 * 1024;

/// How many decoded snapshots the versioner keeps. Decoding one is gzip
/// plus serde over a whole workspace map, and the rail asks for a file at a
/// time, so the same handful is read over and over.
pub const SNAPSHOT_CACHE: usize = 32;

/// One version of one file, as the rail lists it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileVersion {
    pub ts: u64,
    pub hash: String,
    pub size: u64,
    /// The device that took the snapshot.
    pub by: String,
    /// The capture's reason, or empty for a revision only the cloud has.
    pub reason: String,
    pub label: Option<String>,
    pub pinned: bool,
    pub restored_from: Option<u64>,
    /// The path as of that snapshot — not the one asked for, when the file
    /// has been renamed since.
    pub path: String,
    /// `local` (a blob in this store) or `cloud` (read through
    /// `cloud_revision`; phase 6 removes the second kind).
    pub source: String,
    /// This version is byte-for-byte the file on disk right now.
    pub current: bool,
}

/// What `versions_history` answers.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistory {
    /// The store's display root — what `versions_read`, `versions_diff` and
    /// `versions_restore_file` are keyed by, so the caller never has to
    /// work out which folder a document belongs to.
    pub root: String,
    /// sha256 of the file on disk now; null when it is gone.
    pub current_hash: Option<String>,
    pub versions: Vec<FileVersion>,
}

/* ---------- The snapshot cache ---------- */

/// The last few decoded snapshots, most recently used first.
#[derive(Default)]
pub struct SnapshotCache {
    entries: Vec<(u64, Arc<Snapshot>)>,
}

impl SnapshotCache {
    pub fn get(&mut self, store: &Store, ts: u64) -> Option<Arc<Snapshot>> {
        if let Some(at) = self.entries.iter().position(|(k, _)| *k == ts) {
            let hit = self.entries.remove(at);
            let snap = hit.1.clone();
            self.entries.insert(0, hit);
            return Some(snap);
        }
        let snap = Arc::new(store.read_snapshot(ts)?);
        self.entries.insert(0, (ts, snap.clone()));
        self.entries.truncate(SNAPSHOT_CACHE);
        Some(snap)
    }

    /// Forget a snapshot the sweep may have removed. Cheap enough to call
    /// for the whole store after a sweep.
    pub fn clear(&mut self) {
        self.entries.clear();
    }
}

/* ---------- The walk ---------- */

/// Every distinct version of the file at `rel`, newest first, following
/// renames backwards through the retained snapshots.
///
/// `current_hash` is the file on disk, and marks the row that matches it.
pub fn file_versions(
    store: &Store,
    index: &Index,
    cache: &mut SnapshotCache,
    rel: &str,
    current_hash: Option<&str>,
) -> Vec<FileVersion> {
    let mut trail: Vec<FileVersion> = Vec::new();
    let mut path = rel.to_string();
    // The newest snapshot that held the tracked path — what the rename rule
    // compares against, and never a snapshot the file was simply missing
    // from.
    let mut newer: Option<Arc<Snapshot>> = None;

    for row in index.snapshots.iter().rev() {
        let Some(snap) = cache.get(store, row.ts) else { continue };
        let entry: FileEntry = match snap.files.get(&path) {
            Some(entry) => entry.clone(),
            None => match newer.as_deref() {
                // The path is missing from the newest snapshots: the file
                // was made (or restored) after the last capture, and its
                // history starts further back rather than not at all.
                None => continue,
                Some(newer) => match renamed_from(&snap, newer, &path) {
                    Some((old, entry)) => {
                        path = old;
                        entry
                    }
                    // Nothing older carries this content under any name:
                    // the file was created in the snapshot after this one.
                    None => break,
                },
            },
        };
        trail.push(FileVersion {
            ts: row.ts,
            hash: entry.h.clone(),
            size: entry.s,
            by: snap.by.clone(),
            reason: row.reason.as_str().to_string(),
            label: row.label.clone(),
            pinned: row.pinned,
            restored_from: row.restored_from,
            path: path.clone(),
            source: "local".to_string(),
            current: false,
        });
        newer = Some(snap);
    }

    let mut out = collapse(trail);
    // Only the newest match wears the badge: after a restore, an older row
    // holds the same bytes and is still an older row.
    if let Some(hash) = current_hash {
        if let Some(first) = out.iter_mut().find(|v| v.hash == hash) {
            first.current = true;
        }
    }
    out
}

/// One row per run of equal content, timestamped where that content first
/// appeared — a file untouched for a week reads as "last changed a week
/// ago", not as a version at every snapshot since. A named version is never
/// collapsed away: the user marked that moment, and *Name this version* on
/// a document nothing changed in has to leave a row behind.
fn collapse(trail: Vec<FileVersion>) -> Vec<FileVersion> {
    let mut out: Vec<FileVersion> = Vec::new();
    for version in trail {
        match out.last_mut() {
            Some(newer) if newer.hash == version.hash && !newer.pinned && !version.pinned => {
                *newer = version;
            }
            _ => out.push(version),
        }
    }
    out
}

/// Git's rename rule, walked backwards. The tracked path is missing from
/// `older`, and `newer` held it with some hash; if exactly one path in
/// `older` carries that same content and is gone from `newer`, the file was
/// renamed and the walk continues under the old name. Two candidates mean a
/// copy, not a rename, and the walk stops rather than guess.
fn renamed_from(older: &Snapshot, newer: &Snapshot, path: &str) -> Option<(String, FileEntry)> {
    let hash = &newer.files.get(path)?.h;
    let mut found: Option<(String, FileEntry)> = None;
    for (candidate, entry) in &older.files {
        if &entry.h != hash || newer.files.contains_key(candidate) {
            continue;
        }
        if found.is_some() {
            return None;
        }
        found = Some((candidate.clone(), entry.clone()));
    }
    found
}

/* ---------- The cloud read-through (phase 6 removes this) ---------- */

/// Fold the manifest's revisions into a local history. A cloud revision is
/// named by the first 16 characters of the same sha256 the store uses, so
/// one that prefixes a local version — or the file on disk — is the same
/// bytes under a shorter name and is dropped. What survives is what only
/// the cloud still reaches back to, which on the day this ships is most of
/// it: the local store is hours old and `hist` is not.
pub fn merge_cloud(
    mut local: Vec<FileVersion>,
    cloud: &[Revision],
    current_hash: Option<&str>,
    path: &str,
) -> Vec<FileVersion> {
    for revision in cloud {
        let known = local.iter().any(|v| v.hash.starts_with(&revision.hash))
            || current_hash.map(|h| h.starts_with(&revision.hash)).unwrap_or(false);
        if known {
            continue;
        }
        local.push(FileVersion {
            ts: revision.time_ms,
            hash: revision.hash.clone(),
            size: revision.size,
            by: revision.by.clone(),
            reason: String::new(),
            label: None,
            pinned: false,
            restored_from: None,
            path: path.to_string(),
            source: "cloud".to_string(),
            current: false,
        });
    }
    local.sort_by(|a, b| b.ts.cmp(&a.ts));
    local
}

/* ---------- Reading and comparing ---------- */

/// One version's text. A blob that isn't UTF-8 is an error rather than
/// mojibake — the editor has nothing to show for it.
pub fn read_version(store: &Store, hash: &str) -> Result<String, String> {
    let bytes = store
        .read_blob(hash)
        .ok_or_else(|| "that version's content is no longer in this folder's history".to_string())?;
    text_of(bytes)
}

/// A unified diff between two versions. Either side may be the file on disk
/// instead of a stored version — pass its hash as null — which is how the
/// newest version is compared against now.
pub fn diff(store: &Store, path: Option<&Path>, from: Option<&str>, to: Option<&str>) -> Result<String, String> {
    let side = |hash: Option<&str>| -> Result<String, String> {
        match hash {
            Some(hash) => read_version(store, hash),
            None => {
                let path = path.ok_or_else(|| "there's no file to compare with".to_string())?;
                let bytes = std::fs::read(path).map_err(|_| "that file isn't on this Mac any more".to_string())?;
                text_of(bytes)
            }
        }
    };
    let before = side(from)?;
    let after = side(to)?;
    if before.len() > MAX_DIFF_BYTES || after.len() > MAX_DIFF_BYTES {
        return Err("this document is too large to compare version by version".to_string());
    }
    Ok(diffy::create_patch(&before, &after).to_string())
}

fn text_of(bytes: Vec<u8>) -> Result<String, String> {
    String::from_utf8(bytes).map_err(|_| "that version isn't text — there's nothing to show".to_string())
}

/// The file on disk, hashed the way the store hashes it. None when it is
/// gone, unreadable, or larger than the sync will carry.
pub fn hash_on_disk(path: &Path) -> Option<String> {
    crate::cloud::scan::read_file_checked(path).map(|bytes| hash_full(&bytes))
}
