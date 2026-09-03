//! Capture (docs/versioning.md §6.1): the cadence rule that decides *when* a
//! snapshot is taken, and the scan that takes it.
//!
//! The rule is Notion's, and it is the whole reason the history reads like a
//! list of sessions rather than a list of keystrokes: while a workspace is
//! being edited, one snapshot every ten minutes; two minutes after the last
//! edit, one closing snapshot. A quiet hour produces nothing at all.

use std::collections::BTreeMap;

use tokio::time::{Duration, Instant};

use crate::cloud::scan::{read_file_checked, scan_local};

use super::store::{digest_of, hash_full, FileEntry, Index, Reason, Snapshot, SnapshotRow, Store, STORE_VERSION};

/// At most one snapshot per this much editing.
pub const CAPTURE_MIN_INTERVAL: Duration = Duration::from_secs(10 * 60);
/// A session is over this long after the last edit; that state is captured.
pub const SESSION_IDLE: Duration = Duration::from_secs(2 * 60);
/// How long an idle versioner sleeps before looking at the clock again.
/// Nothing is due while it is idle; this only bounds the wait.
pub const IDLE_WAKE: Duration = Duration::from_secs(60 * 60);

/// The cadence state machine. Pure — it knows only when edits arrived and
/// when the last capture was, so every consequence of the rule is testable
/// without a filesystem or a runtime.
#[derive(Clone, Copy, Debug)]
pub struct Cadence {
    dirty: bool,
    last_activity: Instant,
    last_capture: Instant,
}

impl Cadence {
    pub fn new(now: Instant) -> Cadence {
        Cadence { dirty: false, last_activity: now, last_capture: now }
    }

    /// An edit arrived — from the edit bus or the folder watcher.
    pub fn touched(&mut self, now: Instant) {
        self.dirty = true;
        self.last_activity = now;
    }

    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    /// When the versioner should next look at the clock.
    pub fn wake(&self, now: Instant) -> Instant {
        if !self.dirty {
            return now + IDLE_WAKE;
        }
        (self.last_activity + SESSION_IDLE).min(self.last_capture + CAPTURE_MIN_INTERVAL)
    }

    /// What is due at `now`, if anything — and the clock restarts from here
    /// when something is. The session's end wins over the interval, so a
    /// burst that ends just before the ten minutes are up is still captured
    /// exactly once.
    pub fn due(&mut self, now: Instant) -> Option<Reason> {
        if !self.dirty {
            return None;
        }
        let reason = if now >= self.last_activity + SESSION_IDLE {
            Reason::Closing
        } else if now >= self.last_capture + CAPTURE_MIN_INTERVAL {
            Reason::Interval
        } else {
            return None;
        };
        self.captured(now);
        Some(reason)
    }

    /// A capture happened outside the cadence (a manual one, a restore, the
    /// quit flush): the interval starts again from here.
    pub fn captured(&mut self, now: Instant) {
        self.dirty = false;
        self.last_capture = now;
    }
}

/* ---------- The scan ---------- */

#[derive(Clone, Debug, Default)]
pub struct Captured {
    /// None when the workspace is byte-for-byte what the newest snapshot
    /// already holds: a capture that finds nothing new writes nothing.
    pub row: Option<SnapshotRow>,
    /// Files read and hashed, and files whose hash came from the stat cache.
    pub hashed: usize,
    pub reused: usize,
    pub blobs_written: usize,
    /// Compressed bytes this capture added to the store.
    pub blob_bytes: u64,
    pub snapshot_bytes: u64,
}

#[derive(Clone, Debug)]
pub enum CaptureError {
    /// The root is past the sync's entry cap — never a partial snapshot.
    TooLarge,
    Io(String),
}

/// Take one snapshot of `store.root`.
///
/// Blobs first, then the snapshot file, then the index: a crash between any
/// two steps leaves bytes the sweep collects, never an index row whose
/// content is missing. `last` is the newest snapshot's file map, in and out —
/// it is the stat cache, so an untouched file is never re-hashed.
pub fn capture(
    store: &Store,
    index: &mut Index,
    last: &mut BTreeMap<String, FileEntry>,
    by: &str,
    reason: Reason,
    restored_from: Option<u64>,
    now_ms: u64,
) -> Result<Captured, CaptureError> {
    let scanned = scan_local(&store.root).map_err(|_| CaptureError::TooLarge)?;
    let mut out = Captured::default();
    let mut files: BTreeMap<String, FileEntry> = BTreeMap::new();
    let mut total_bytes = 0u64;

    for (rel, entry) in &scanned {
        let cached = last.get(rel).filter(|c| c.s == entry.size && c.m == entry.mtime_ms && !c.h.is_empty());
        let hash = match cached {
            // Unchanged since the last capture, and its bytes are still in
            // the store: nothing to read.
            Some(c) if store.has_blob(&c.h) => {
                out.reused += 1;
                c.h.clone()
            }
            _ => {
                let Some(bytes) = read_file_checked(&entry.abs) else { continue };
                out.hashed += 1;
                let hash = hash_full(&bytes);
                match store.write_blob(&hash, &bytes) {
                    Ok(0) => {}
                    Ok(n) => {
                        out.blobs_written += 1;
                        out.blob_bytes += n;
                    }
                    Err(e) => return Err(CaptureError::Io(e)),
                }
                hash
            }
        };
        total_bytes += entry.size;
        files.insert(rel.clone(), FileEntry { h: hash, s: entry.size, m: entry.mtime_ms });
    }

    let digest = digest_of(&files);
    if index.newest().map(|n| n.digest == digest).unwrap_or(false) {
        // Nothing changed. Keep the fresher stat pairs, so a file rewritten
        // with the same bytes isn't re-hashed on every capture from here on.
        *last = files;
        return Ok(out);
    }

    let ts = match index.newest() {
        Some(n) if now_ms <= n.ts => n.ts + 1,
        _ => now_ms,
    };
    let snapshot = Snapshot {
        version: STORE_VERSION,
        ts,
        reason,
        restored_from,
        by: by.to_string(),
        files: files.clone(),
    };
    out.snapshot_bytes = store.write_snapshot(&snapshot).map_err(CaptureError::Io)?;

    let row = SnapshotRow {
        ts,
        reason,
        files: files.len() as u64,
        bytes: total_bytes,
        digest,
        pinned: reason == Reason::Manual,
        label: None,
        restored_from,
    };
    if index.created_ms == 0 {
        index.created_ms = ts;
    }
    index.last_capture_ms = ts;
    index.snapshots.push(row.clone());
    store.write_index(index).map_err(CaptureError::Io)?;

    *last = files;
    out.row = Some(row);
    Ok(out)
}
