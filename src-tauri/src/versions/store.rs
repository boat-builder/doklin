//! The store on disk (docs/versioning.md §6.3, docs/versioning-plan.md §4.2):
//! where a workspace's history lives, what an index row and a snapshot file
//! say, and the gzip'd, atomically written bytes underneath. Nothing here
//! decides *when* to capture (capture.rs) or *what* to keep (retain.rs) —
//! this module only knows how to put bytes down and get them back.
//!
//! ```text
//! <app_data>/versions/
//!   settings.json               settings.rs
//!   <key>/
//!     index.json                the retained set, newest last
//!     snapshots/<ts>.json.gz    one workspace state; <ts> zero-padded to 13
//!     blobs/<hh>/<hash>.gz      one file's content; <hash> full sha256 hex
//!     cloud-cache/<id>.json.gz  a snapshot another device mirrored, kept so
//!                               the rail and the cloud sweep read it once
//! ```
//!
//! `cloud-cache/` is a cache, not the store: it holds copies of what the
//! bucket already has, and anything in it may be dropped and refetched.
//!
//! The store never lives under the workspace it versions, and the only code
//! that deletes inside one is retain.rs's sweep — plus `stores::forget`,
//! which deletes a whole store the user named and nothing smaller.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::cloud::scan::write_atomic;

/// The format of `index.json` and of a snapshot file.
pub const STORE_VERSION: u32 = 1;

/// Why a snapshot was taken. `pre-restore` is the state a restore is about
/// to leave, `restore` the state it made; both are forced captures.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Reason {
    /// Ten minutes of continuous editing.
    #[default]
    Interval,
    /// Two minutes after the last edit — the end of a session.
    Closing,
    /// The folder as it was when this Mac first saw it.
    Seed,
    PreRestore,
    Restore,
    /// The user asked for this one; it is pinned and never thinned.
    Manual,
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::Interval => "interval",
            Reason::Closing => "closing",
            Reason::Seed => "seed",
            Reason::PreRestore => "pre-restore",
            Reason::Restore => "restore",
            Reason::Manual => "manual",
        }
    }

    pub fn parse(s: &str) -> Option<Reason> {
        Some(match s {
            "interval" => Reason::Interval,
            "closing" => Reason::Closing,
            "seed" => Reason::Seed,
            "pre-restore" => Reason::PreRestore,
            "restore" => Reason::Restore,
            "manual" => Reason::Manual,
            _ => return None,
        })
    }
}

/// One row of `index.json`: everything a list of versions needs without
/// opening a snapshot file.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SnapshotRow {
    pub ts: u64,
    pub reason: Reason,
    /// How many files the snapshot holds, and their total (uncompressed) size.
    pub files: u64,
    pub bytes: u64,
    /// sha256 over `<path>\0<hash>\n` in path order: equal digests mean the
    /// same workspace, so a capture that finds one writes nothing.
    pub digest: String,
    /// Never thinned by the ladder. Set by a `manual` capture and by
    /// `versions_set_pinned` (phase 2's *Name this version*).
    pub pinned: bool,
    pub label: Option<String>,
    /// For a `restore`: the `ts` of the snapshot its content came from.
    pub restored_from: Option<u64>,
}

/// `index.json` — the whole retained set, sorted by `ts` ascending.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Index {
    pub version: u32,
    /// The display root, as the app knows it (never canonicalised away).
    pub root: String,
    pub created_ms: u64,
    pub last_capture_ms: u64,
    pub last_sweep_ms: u64,
    /// This store's own horizon, when the user has set one: `Some(Some(30))`
    /// is thirty days, `Some(None)` is forever, and the field's absence
    /// means settings.json's default still applies. Three states, because
    /// "the user chose forever" and "the user has never chosen" must not be
    /// the same answer for a store written before phase 5.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "chosen_horizon")]
    pub horizon_days: Option<Option<u32>>,
    pub snapshots: Vec<SnapshotRow>,
}

/// A present `horizonDays` is a choice, `null` included.
fn chosen_horizon<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<u32>>, D::Error> {
    Option::<u32>::deserialize(d).map(Some)
}

impl Index {
    pub fn newest(&self) -> Option<&SnapshotRow> {
        self.snapshots.last()
    }

    pub fn row(&self, ts: u64) -> Option<&SnapshotRow> {
        self.snapshots.iter().find(|s| s.ts == ts)
    }

    pub fn row_mut(&mut self, ts: u64) -> Option<&mut SnapshotRow> {
        self.snapshots.iter_mut().find(|s| s.ts == ts)
    }
}

/// One file inside a snapshot: its full sha256, size and mtime. The last two
/// are the stat cache — a file whose pair is unchanged is not re-hashed.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct FileEntry {
    pub h: String,
    pub s: u64,
    pub m: u64,
}

/// A snapshot file: one workspace state, keyed by path.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Snapshot {
    pub version: u32,
    pub ts: u64,
    pub reason: Reason,
    pub restored_from: Option<u64>,
    /// The device that took it.
    pub by: String,
    pub files: BTreeMap<String, FileEntry>,
}

/* ---------- The store ---------- */

#[derive(Clone, Debug)]
pub struct Store {
    /// `r-<16 hex>` for a workspace folder, `drafts` for the drafts directory.
    pub key: String,
    /// The display root this store versions.
    pub root: PathBuf,
    /// `<app_data>/versions/<key>`.
    pub dir: PathBuf,
}

/// `<app_data>/versions` — every store, and the settings beside them.
pub fn versions_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("versions")
}

/// A store key from a folder's path: `r-` and the first 16 hex of the
/// sha256 of its canonical path. No marker is ever written into the folder,
/// so a folder that isn't connected to a cloud still gets a stable key —
/// and a moved folder simply starts a new store.
pub fn store_key(root: &Path) -> String {
    let canonical = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let mut hasher = Sha256::new();
    hasher.update(canonical.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    let hex: String = digest.iter().take(8).map(|b| format!("{:02x}", b)).collect();
    format!("r-{}", hex)
}

/// The full sha256, hex — the store's content address. (The sync engine's
/// `hash16` is the first 16 characters of this same string.)
pub fn hash_full(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().iter().map(|b| format!("{:02x}", b)).collect()
}

/// The digest of a file map: sha256 over `<path>\0<hash>\n` in path order.
pub fn digest_of(files: &BTreeMap<String, FileEntry>) -> String {
    let mut hasher = Sha256::new();
    for (path, entry) in files {
        hasher.update(path.as_bytes());
        hasher.update(b"\0");
        hasher.update(entry.h.as_bytes());
        hasher.update(b"\n");
    }
    hasher.finalize().iter().map(|b| format!("{:02x}", b)).collect()
}

impl Store {
    pub fn open(data_dir: &Path, key: &str, root: &Path) -> Store {
        Store { key: key.to_string(), root: root.to_path_buf(), dir: versions_dir(data_dir).join(key) }
    }

    pub fn index_path(&self) -> PathBuf {
        self.dir.join("index.json")
    }

    pub fn snapshots_dir(&self) -> PathBuf {
        self.dir.join("snapshots")
    }

    pub fn blobs_dir(&self) -> PathBuf {
        self.dir.join("blobs")
    }

    pub fn snapshot_path(&self, ts: u64) -> PathBuf {
        self.snapshots_dir().join(format!("{:013}.json.gz", ts))
    }

    /// Where a mirrored snapshot is kept once it has been downloaded.
    pub fn cloud_cache_dir(&self) -> PathBuf {
        self.dir.join("cloud-cache")
    }

    pub fn cloud_snapshot_path(&self, id: &str) -> PathBuf {
        self.cloud_cache_dir().join(format!("{}.json.gz", id))
    }

    pub fn blob_path(&self, hash: &str) -> PathBuf {
        let shard = hash.get(0..2).unwrap_or("00");
        self.blobs_dir().join(shard).join(format!("{}.gz", hash))
    }

    /// The index, or a fresh one for a store that has none yet.
    pub fn read_index(&self) -> Index {
        let mut index: Index = crate::cloud::scan::read_json(&self.index_path()).unwrap_or_default();
        index.version = STORE_VERSION;
        if index.root.is_empty() {
            index.root = self.root.to_string_lossy().to_string();
        }
        index.snapshots.sort_by_key(|s| s.ts);
        index
    }

    pub fn write_index(&self, index: &Index) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| format!("create the version store: {}", e))?;
        crate::cloud::scan::write_json(&self.index_path(), index)
            .map_err(|e| format!("write the version index: {}", e))
    }

    pub fn read_snapshot(&self, ts: u64) -> Option<Snapshot> {
        let bytes = std::fs::read(self.snapshot_path(ts)).ok()?;
        serde_json::from_slice(&gunzip(&bytes).ok()?).ok()
    }

    /// Answers the bytes written, so the status's size doesn't need a walk
    /// of the whole store after every capture.
    pub fn write_snapshot(&self, snap: &Snapshot) -> Result<u64, String> {
        let json = serde_json::to_vec(snap).map_err(|e| format!("encode the snapshot: {}", e))?;
        let gz = gzip(&json).map_err(|e| format!("compress the snapshot: {}", e))?;
        write_atomic(&self.snapshot_path(snap.ts), &gz).map_err(|e| format!("write the snapshot: {}", e))?;
        Ok(gz.len() as u64)
    }

    /// A snapshot's bytes exactly as they sit on disk — gzip'd, ready to
    /// upload without a decompress-and-recompress round trip.
    pub fn read_snapshot_gz(&self, ts: u64) -> Option<Vec<u8>> {
        std::fs::read(self.snapshot_path(ts)).ok()
    }

    /// One mirrored snapshot from the cache, or None when it hasn't been
    /// downloaded (or the cached bytes are unreadable).
    pub fn read_cloud_snapshot(&self, id: &str) -> Option<Snapshot> {
        let bytes = std::fs::read(self.cloud_snapshot_path(id)).ok()?;
        serde_json::from_slice(&gunzip(&bytes).ok()?).ok()
    }

    /// Keep a mirrored snapshot's bytes. Best effort — a cache that fails to
    /// write just means the next reader downloads it again.
    pub fn write_cloud_snapshot(&self, id: &str, gz: &[u8]) {
        let _ = write_atomic(&self.cloud_snapshot_path(id), gz);
    }

    /// Drop cached snapshots the cloud index no longer names.
    pub fn prune_cloud_cache(&self, live: &std::collections::BTreeSet<String>) {
        let Ok(entries) = std::fs::read_dir(self.cloud_cache_dir()) else { return };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(id) = name.strip_suffix(".json.gz") else { continue };
            if !live.contains(id) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    pub fn has_blob(&self, hash: &str) -> bool {
        self.blob_path(hash).exists()
    }

    /// One version's bytes. None when the blob is gone — a store older than
    /// the horizon, or a hash from a device whose sweep ran first.
    pub fn read_blob(&self, hash: &str) -> Option<Vec<u8>> {
        gunzip(&std::fs::read(self.blob_path(hash)).ok()?).ok()
    }

    /// One version's bytes as stored — gzip'd, for the same reason
    /// `read_snapshot_gz` is.
    pub fn read_blob_gz(&self, hash: &str) -> Option<Vec<u8>> {
        std::fs::read(self.blob_path(hash)).ok()
    }

    /// Write a blob unless it is already there. Answers the bytes written
    /// (0 when the content was already stored).
    pub fn write_blob(&self, hash: &str, bytes: &[u8]) -> Result<u64, String> {
        let path = self.blob_path(hash);
        if path.exists() {
            return Ok(0);
        }
        let gz = gzip(bytes).map_err(|e| format!("compress a version: {}", e))?;
        let len = gz.len() as u64;
        write_atomic(&path, &gz).map_err(|e| format!("write a version: {}", e))?;
        Ok(len)
    }

    /// Every snapshot file present, by `ts` — including any the index does
    /// not name (an orphan the sweep removes).
    pub fn snapshot_files(&self) -> Vec<(u64, PathBuf)> {
        let mut out = Vec::new();
        let Ok(entries) = std::fs::read_dir(self.snapshots_dir()) else { return out };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(stem) = name.strip_suffix(".json.gz") else { continue };
            let Ok(ts) = stem.parse::<u64>() else { continue };
            out.push((ts, entry.path()));
        }
        out.sort_by_key(|(ts, _)| *ts);
        out
    }

    /// Every file under `blobs/`, as (hash, path). A name that isn't
    /// `<hash>.gz` comes back with an empty hash — an interrupted write the
    /// sweep collects once it is old enough.
    pub fn blob_files(&self) -> Vec<(String, PathBuf)> {
        let mut out = Vec::new();
        let Ok(shards) = std::fs::read_dir(self.blobs_dir()) else { return out };
        for shard in shards.flatten() {
            let Ok(entries) = std::fs::read_dir(shard.path()) else { continue };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                let hash = name.strip_suffix(".gz").unwrap_or("").to_string();
                out.push((hash, entry.path()));
            }
        }
        out
    }

    /// (blob bytes, snapshot bytes) on disk, compressed — what the status
    /// reports and what a sweep frees.
    pub fn measure(&self) -> (u64, u64) {
        let size = |p: &PathBuf| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
        let blobs = self.blob_files().iter().map(|(_, p)| size(p)).sum();
        let snapshots = self.snapshot_files().iter().map(|(_, p)| size(p)).sum();
        (blobs, snapshots)
    }
}

/* ---------- gzip ---------- */

pub fn gzip(bytes: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(bytes)?;
    encoder.finish()
}

pub fn gunzip(bytes: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut out = Vec::new();
    GzDecoder::new(bytes).read_to_end(&mut out)?;
    Ok(out)
}
