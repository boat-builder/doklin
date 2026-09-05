//! The cloud mirror of the local version store (docs/versioning.md §6.4,
//! docs/versioning-plan.md §6). The versioner captures; this uploads what it
//! captured, thins what is up there on the same ladder, and never writes a
//! byte into a local store.
//!
//! Three objects, mirroring cloud-worker/src/versions.ts — change both:
//!
//! ```text
//! versions/index.json                      the retained set — compare-and-swap on its etag
//! versions/snapshots/<ts13>-<device>.json.gz  immutable; the bytes the device wrote
//! versions/blobs/<hash>                    immutable; gzip'd content, full sha256 key
//! ```
//!
//! Snapshots and blobs are immutable and create-only, so two devices writing
//! the same content agree by construction; the index is the only thing that
//! moves, and it moves by CAS. That is the whole concurrency story.

use std::collections::BTreeSet;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::versions::retain::retain;
use crate::versions::store::{gunzip, Index, Snapshot, SnapshotRow, Store};

use super::remote::{Remote, RemoteError, RemoteResult};

/// How often a connected workspace mirrors, whatever else happens.
pub const MIRROR_EVERY: Duration = Duration::from_secs(60 * 60);
/// How often it thins what it put there.
pub const CLOUD_SWEEP_EVERY_MS: u64 = 24 * 60 * 60 * 1000;
/// A cloud blob younger than this is never collected: another device may
/// have uploaded it and not yet won the CAS naming the snapshot that holds
/// it. The local store's `GC_GRACE` is the same hour for the same reason.
pub const CLOUD_GC_GRACE_MS: u64 = 60 * 60 * 1000;
/// How many lost CAS races one mirror pass will re-read the index for.
const CAS_ATTEMPTS: usize = 4;

/// The format of `versions/index.json`.
pub const VERSIONS_INDEX_VERSION: u32 = 1;

/// The base etag that means "there is no index yet — create it".
pub const NO_INDEX: &str = "*";

/* ---------- The wire ---------- */

/// One row of the cloud index: the local index's row, plus which device
/// wrote it and under what object id.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct VersionsEntry {
    pub id: String,
    pub ts: u64,
    pub device: String,
    pub reason: String,
    pub files: u64,
    pub bytes: u64,
    pub digest: String,
    pub pinned: bool,
    pub label: Option<String>,
    pub restored_from: Option<u64>,
}

/// `versions/index.json`. The horizon lives here rather than in settings so
/// every device agrees about how far back the bucket reaches.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionsIndex {
    pub version: u32,
    pub horizon_days: Option<u32>,
    pub snapshots: Vec<VersionsEntry>,
}

impl Default for VersionsIndex {
    fn default() -> Self {
        VersionsIndex { version: VERSIONS_INDEX_VERSION, horizon_days: None, snapshots: Vec::new() }
    }
}

impl VersionsIndex {
    pub fn ids(&self) -> BTreeSet<String> {
        self.snapshots.iter().map(|e| e.id.clone()).collect()
    }
}

/// `<ts zero-padded to 13>-<deviceId>` — when it was taken and by whom, so
/// two devices capturing in the same millisecond write two objects instead
/// of racing over one.
pub fn snapshot_id(ts: u64, device_id: &str) -> String {
    format!("{:013}-{}", ts, device_id)
}

/// The cloud index as one pass is holding it: what it last said, and the
/// etag the next write has to match.
struct Held {
    index: VersionsIndex,
    etag: String,
}

/// What one pass put there and what is up there in total — the status line.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MirrorReport {
    /// This device's local snapshots the cloud index now names.
    pub mirrored: u64,
    /// Every snapshot in the cloud index, from every device.
    pub cloud: u64,
    /// The bucket's horizon as the index gave it, `None` for forever. Only
    /// meaningful because a pass has run: before that, no device on this Mac
    /// has read the index and the settings surface says so.
    pub horizon_days: Option<u32>,
}

/* ---------- The pass ---------- */

/// Upload what this device has captured and the cloud has not, then — once a
/// day — thin what is up there. `uploaded` and `last_sweep_ms` live in the
/// engine's persisted state, so a restart doesn't re-PUT the whole store.
pub async fn mirror<R: Remote>(
    remote: &R,
    store: &Store,
    device_id: &str,
    uploaded: &mut BTreeSet<String>,
    last_sweep_ms: &mut Option<u64>,
    now_ms: u64,
) -> RemoteResult<MirrorReport> {
    let local = store.read_index();
    let mut held = load(remote).await?;

    for attempt in 0..CAS_ATTEMPTS {
        match push(remote, store, &local, &mut held, device_id, uploaded, now_ms).await {
            Ok(()) => break,
            // Another device moved the index between our read and our write.
            // Start again from what it says now; our uploads still stand.
            Err(RemoteError::Conflict) if attempt + 1 < CAS_ATTEMPTS => held = load(remote).await?,
            Err(RemoteError::Conflict) => break,
            Err(e) => return Err(e),
        }
    }

    let due = last_sweep_ms.map(|t| now_ms.saturating_sub(t) >= CLOUD_SWEEP_EVERY_MS).unwrap_or(true);
    if due {
        // A sweep that loses its race simply waits for tomorrow: nothing is
        // wrong with a store that holds one day too much.
        match sweep(remote, store, &mut held, now_ms).await {
            Ok(()) => *last_sweep_ms = Some(now_ms),
            Err(RemoteError::Conflict) => {}
            Err(e) => return Err(e),
        }
    }
    // Keep "already uploaded" from growing forever: a hash this store no
    // longer holds is one nothing will ask us to upload again.
    let here: BTreeSet<String> = store.blob_files().into_iter().map(|(hash, _)| hash).collect();
    uploaded.retain(|hash| here.contains(hash));
    store.prune_cloud_cache(&held.index.ids());

    Ok(report(&local, &held.index, device_id))
}

async fn load<R: Remote>(remote: &R) -> RemoteResult<Held> {
    Ok(match remote.get_versions_index().await? {
        Some((index, etag)) => Held { index, etag },
        None => Held { index: VersionsIndex::default(), etag: NO_INDEX.to_string() },
    })
}

/// Every local snapshot the cloud is missing, oldest first: its blobs, then
/// the snapshot, then the index entry. Blobs before the snapshot and the
/// snapshot before the index means an interrupted pass leaves unreferenced
/// bytes (the sweep collects them) and never an index row pointing at
/// nothing.
async fn push<R: Remote>(
    remote: &R,
    store: &Store,
    local: &Index,
    held: &mut Held,
    device_id: &str,
    uploaded: &mut BTreeSet<String>,
    now_ms: u64,
) -> RemoteResult<()> {
    for row in &local.snapshots {
        let id = snapshot_id(row.ts, device_id);
        if held.index.snapshots.iter().any(|e| e.id == id) {
            continue;
        }
        if already_there(&held.index, row) || !ladder_keeps(&held.index, row, now_ms) {
            continue;
        }
        // The local sweep may have taken it since we read the index; that is
        // its right, and there is then nothing to mirror.
        let (Some(snap), Some(bytes)) = (store.read_snapshot(row.ts), store.read_snapshot_gz(row.ts)) else {
            continue;
        };
        for hash in snap.files.values().map(|f| f.h.clone()).collect::<BTreeSet<String>>() {
            if uploaded.contains(&hash) {
                continue;
            }
            let Some(blob) = store.read_blob_gz(&hash) else { continue };
            remote.put_version_blob(&hash, blob).await?;
            uploaded.insert(hash);
        }
        remote.put_version_snapshot(&id, bytes).await?;
        held.index.snapshots.push(entry_for(&id, row, device_id));
        held.index.snapshots.sort_by(|a, b| a.ts.cmp(&b.ts).then_with(|| a.id.cmp(&b.id)));
        held.etag = remote.put_versions_index(&held.etag, &held.index).await?;
    }
    Ok(())
}

/// Is this content already up there? Two devices in one workspace see the
/// same files and capture the same digests; only one copy needs to go. A
/// named version always goes: the user marked that moment, and the name
/// lives in the index.
fn already_there(index: &VersionsIndex, row: &SnapshotRow) -> bool {
    if row.pinned {
        return false;
    }
    index
        .snapshots
        .iter()
        .filter(|e| e.ts <= row.ts)
        .max_by_key(|e| e.ts)
        .map(|e| e.digest == row.digest)
        .unwrap_or(false)
}

/// Would the cloud ladder keep this snapshot if it were up there? Without
/// this a device re-uploads, every pass, exactly what yesterday's sweep
/// thinned away — the ladder decides once, before the bytes move.
fn ladder_keeps(index: &VersionsIndex, row: &SnapshotRow, now_ms: u64) -> bool {
    let mut rows = ladder_rows(index);
    rows.push(row.clone());
    retain(&rows, now_ms, index.horizon_days).contains(&row.ts)
}

/// The cloud index as the ladder reads it: it only ever looks at `ts` and
/// `pinned`.
fn ladder_rows(index: &VersionsIndex) -> Vec<SnapshotRow> {
    index
        .snapshots
        .iter()
        .map(|e| SnapshotRow { ts: e.ts, pinned: e.pinned, ..Default::default() })
        .collect()
}

fn entry_for(id: &str, row: &SnapshotRow, device_id: &str) -> VersionsEntry {
    VersionsEntry {
        id: id.to_string(),
        ts: row.ts,
        device: device_id.to_string(),
        reason: row.reason.as_str().to_string(),
        files: row.files,
        bytes: row.bytes,
        digest: row.digest.clone(),
        pinned: row.pinned,
        label: row.label.clone(),
        restored_from: row.restored_from,
    }
}

fn report(local: &Index, index: &VersionsIndex, device_id: &str) -> MirrorReport {
    let ids = index.ids();
    MirrorReport {
        mirrored: local.snapshots.iter().filter(|r| ids.contains(&snapshot_id(r.ts, device_id))).count() as u64,
        cloud: index.snapshots.len() as u64,
        horizon_days: index.horizon_days,
    }
}

/// Set how far back the bucket keeps: read the index, change the one field
/// every device reads it for, write it back on its etag. A lost race is
/// another device moving the index in the same moment — re-read and try
/// again, because there is nothing here to merge and someone is waiting on
/// the answer.
pub async fn set_horizon<R: Remote>(remote: &R, days: Option<u32>) -> RemoteResult<VersionsIndex> {
    for attempt in 0..CAS_ATTEMPTS {
        let mut held = load(remote).await?;
        held.index.horizon_days = days;
        match remote.put_versions_index(&held.etag, &held.index).await {
            Ok(_) => return Ok(held.index),
            Err(RemoteError::Conflict) if attempt + 1 < CAS_ATTEMPTS => continue,
            Err(e) => return Err(e),
        }
    }
    Err(RemoteError::Conflict)
}

/* ---------- The cloud sweep ---------- */

/// The retention ladder, applied to the bucket: rewrite the index, delete
/// the snapshots it no longer names, then collect every blob no retained
/// snapshot references. The index goes first and by CAS, so a pass that dies
/// halfway leaves objects nothing points at — never a row pointing at
/// nothing.
async fn sweep<R: Remote>(remote: &R, store: &Store, held: &mut Held, now_ms: u64) -> RemoteResult<()> {
    let keep = retain(&ladder_rows(&held.index), now_ms, held.index.horizon_days);
    let dropped: Vec<String> =
        held.index.snapshots.iter().filter(|e| !keep.contains(&e.ts)).map(|e| e.id.clone()).collect();
    if !dropped.is_empty() {
        held.index.snapshots.retain(|e| keep.contains(&e.ts));
        held.etag = remote.put_versions_index(&held.etag, &held.index).await?;
        for id in &dropped {
            let _ = remote.delete_version_snapshot(id).await;
        }
    }

    // What survives references what? Snapshots are immutable, so the answer
    // for one never changes — the cache the rail reads is the same cache
    // that makes this cost one download per snapshot, ever.
    let mut referenced: BTreeSet<String> = BTreeSet::new();
    for entry in held.index.snapshots.clone() {
        if let Some(snap) = snapshot(remote, store, &entry.id).await {
            referenced.extend(snap.files.into_values().map(|f| f.h));
        }
    }

    let mut cursor: Option<String> = None;
    loop {
        let (blobs, next) = remote.list_version_blobs(cursor.as_deref()).await?;
        for (hash, uploaded_ms) in blobs {
            let young = now_ms.saturating_sub(uploaded_ms) < CLOUD_GC_GRACE_MS;
            if young || referenced.contains(&hash) {
                continue;
            }
            let _ = remote.delete_version_blob(&hash).await;
        }
        match next {
            Some(c) => cursor = Some(c),
            None => break,
        }
    }
    Ok(())
}

/* ---------- Reading a mirrored snapshot ---------- */

/// One mirrored snapshot, from the cache or from the bucket. Immutable, so a
/// cached copy is never stale; a download that fails is a None the caller
/// treats as "not reachable right now", never as "never existed".
pub async fn snapshot<R: Remote>(remote: &R, store: &Store, id: &str) -> Option<Snapshot> {
    if let Some(cached) = store.read_cloud_snapshot(id) {
        return Some(cached);
    }
    let bytes = remote.get_version_snapshot(id).await.ok()?;
    let snap: Snapshot = serde_json::from_slice(&gunzip(&bytes).ok()?).ok()?;
    store.write_cloud_snapshot(id, &bytes);
    Some(snap)
}

/// One mirrored version's content, decompressed.
pub async fn blob<R: Remote>(remote: &R, hash: &str) -> RemoteResult<Vec<u8>> {
    let bytes = remote.get_version_blob(hash).await?;
    gunzip(&bytes).map_err(|_| RemoteError::Other("that version's content couldn't be read".into()))
}
