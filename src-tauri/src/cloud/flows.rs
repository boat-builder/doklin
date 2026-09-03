//! The flows that happen before an engine exists — or instead of one
//! (docs/cloud.md §6.8): bind a domain and upload a folder
//! (connect), download a workspace into a fresh folder (join), erase a
//! domain (wipe). Generic over [`Remote`] so the test matrix runs them
//! against the in-memory worker; mod.rs wraps each in a command that adds
//! the config writes and spawns the engine.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use serde_json::json;

use super::engine::{FileState, WorkspaceState};
use super::manifest::{Manifest, ManifestFile, MANIFEST_VERSION};
use super::remote::{Bound, Remote, RemoteError, WorkspaceRecord};
use super::scan::{
    content_type_for, hash16, now_ms, random_id, read_file_checked, scan_local, stat_pair, write_atomic,
    ScanEntry,
};
use super::status::{Events, EV_PROGRESS};

/// Uploads or downloads in flight at once.
const PARALLEL: usize = 4;
/// Wipe rounds before giving up (each round erases up to 1000 objects).
const MAX_WIPE_ROUNDS: usize = 200;

#[derive(Debug)]
pub enum FlowError {
    /// The domain already holds a workspace (a bind lost, or was never free).
    AlreadyBound(WorkspaceRecord),
    /// The domain answered but holds no workspace.
    NotBound,
    Unauthorized,
    Forbidden,
    Offline(String),
    Other(String),
}

impl From<RemoteError> for FlowError {
    fn from(e: RemoteError) -> Self {
        match e {
            RemoteError::AlreadyBound(w) => FlowError::AlreadyBound(w),
            RemoteError::NotFound => FlowError::NotBound,
            RemoteError::Unauthorized => FlowError::Unauthorized,
            RemoteError::Forbidden => FlowError::Forbidden,
            RemoteError::Offline(m) => FlowError::Offline(m),
            other => FlowError::Other(other.to_string()),
        }
    }
}

/// The user-facing sentence for a failed flow against `domain`.
pub fn describe(domain: &str, e: FlowError) -> String {
    match e {
        FlowError::AlreadyBound(w) => format!(
            "{} already holds \"{}\" (created on {}) — download it here, or resume the folder that is that workspace",
            domain, w.name, w.created_by.device_name
        ),
        FlowError::NotBound => format!("{} holds no workspace yet — connect a folder to it first", domain),
        FlowError::Unauthorized => format!("{} rejected this token", domain),
        FlowError::Forbidden => "only the domain's owner can do that".into(),
        FlowError::Offline(m) => format!("couldn't reach {}: {}", domain, m),
        FlowError::Other(m) => m,
    }
}

/// `POST /api/workspace` — the one call that happens before a workspace
/// exists. A `409` comes back as `AlreadyBound` with what the domain holds.
pub async fn bind_domain<R: Remote>(remote: &Arc<R>, name: &str, device_name: &str) -> Result<Bound, FlowError> {
    Ok(remote.bind(name, device_name).await?)
}

/// After a won bind: read + hash + upload everything under `root`, a few
/// files in flight at a time, then publish the first manifest over the
/// empty one the bind created. Returns the engine state to start from
/// (its base copies written under `state_dir/base`).
#[allow(clippy::too_many_arguments)]
pub async fn seed_upload<R: Remote>(
    remote: &Arc<R>,
    root: &Path,
    state_dir: &Path,
    name: &str,
    manifest_etag0: &str,
    device_name: &str,
    events: &Arc<dyn Events>,
    progress_root: &str,
) -> Result<WorkspaceState, FlowError> {
    let scan = scan_local(root).map_err(FlowError::Other)?;
    let total = scan.len();
    let _ = std::fs::create_dir_all(state_dir.join("base"));

    let mut manifest = Manifest { name: name.to_string(), seq: 1, ..Default::default() };
    let mut states: BTreeMap<String, FileState> = BTreeMap::new();
    let mut uploads: Vec<(String, String, Vec<u8>, ScanEntry)> = Vec::new(); // (fid, rel, bytes, entry)
    for (rel, entry) in &scan {
        let Some(bytes) = read_file_checked(&entry.abs) else { continue };
        uploads.push((random_id("f"), rel.clone(), bytes, entry.clone()));
    }

    let mut set = tokio::task::JoinSet::new();
    let mut queue = uploads.into_iter();
    let mut done = 0usize;
    loop {
        while set.len() < PARALLEL {
            let Some((fid, rel, bytes, entry)) = queue.next() else { break };
            let remote = remote.clone();
            set.spawn(async move {
                let hash = hash16(&bytes);
                let r = remote.put_blob(&fid, &hash, bytes.clone(), content_type_for(&rel)).await;
                (fid, rel, bytes, entry, hash, r)
            });
        }
        let Some(joined) = set.join_next().await else { break };
        let (fid, rel, bytes, entry, hash, r) =
            joined.map_err(|e| FlowError::Other(format!("upload task: {}", e)))?;
        r.map_err(|e| match e {
            RemoteError::Offline(m) => FlowError::Offline(m),
            RemoteError::Unauthorized => FlowError::Unauthorized,
            other => FlowError::Other(format!("upload {}: {}", rel, other)),
        })?;
        manifest.files.insert(
            fid.clone(),
            ManifestFile {
                path: rel.clone(),
                rev: 1,
                hash: hash.clone(),
                size: bytes.len() as u64,
                mtime: now_ms(),
                by: device_name.to_string(),
                hist: Vec::new(),
            },
        );
        states.insert(
            fid.clone(),
            FileState { path: rel, rev: 1, hash, size: entry.size, mtime_ms: entry.mtime_ms },
        );
        // Base copy: the uploaded bytes are the merge ancestor from now on.
        let _ = write_atomic(&state_dir.join("base").join(&fid), &bytes);
        done += 1;
        events.emit_json(
            EV_PROGRESS,
            json!({ "root": progress_root, "kind": "upload", "done": done, "total": total }),
        );
    }

    let etag = remote
        .put_manifest(&manifest, manifest_etag0)
        .await
        .map_err(|e| FlowError::Other(format!("publish the manifest: {}", e)))?;

    Ok(WorkspaceState {
        version: MANIFEST_VERSION,
        manifest_etag: Some(etag),
        manifest,
        files: states,
        ..Default::default()
    })
}

/// Pull a bound domain's workspace down into `dest` (an empty or absent
/// folder) — the second machine's flow. Returns the engine state to start
/// from.
pub async fn seed_download<R: Remote>(
    remote: &Arc<R>,
    dest: &Path,
    state_dir: &Path,
    events: &Arc<dyn Events>,
) -> Result<WorkspaceState, FlowError> {
    let (manifest, etag) = remote
        .fetch_manifest(None)
        .await?
        .ok_or_else(|| FlowError::Other("the domain returned no manifest".into()))?;

    if dest.exists() {
        let occupied = std::fs::read_dir(dest).map(|mut d| d.next().is_some()).unwrap_or(true);
        if occupied {
            return Err(FlowError::Other(format!(
                "\"{}\" already exists and isn't empty — pick another location",
                dest.display()
            )));
        }
    }
    std::fs::create_dir_all(dest).map_err(|e| FlowError::Other(format!("create {}: {}", dest.display(), e)))?;
    let _ = std::fs::create_dir_all(state_dir.join("base"));
    let progress_root = dest.to_string_lossy().to_string();

    let total = manifest.files.len();
    let mut done = 0usize;
    let mut states: BTreeMap<String, FileState> = BTreeMap::new();
    let mut set = tokio::task::JoinSet::new();
    let mut queue = manifest.files.clone().into_iter();
    loop {
        while set.len() < PARALLEL {
            let Some((fid, rf)) = queue.next() else { break };
            let remote = remote.clone();
            set.spawn(async move {
                let bytes = remote.get_blob(&fid, &rf.hash).await;
                (fid, rf, bytes)
            });
        }
        let Some(joined) = set.join_next().await else { break };
        let (fid, rf, bytes) = joined.map_err(|e| FlowError::Other(format!("download task: {}", e)))?;
        let bytes = bytes.map_err(|e| match e {
            RemoteError::Offline(m) => FlowError::Offline(m),
            RemoteError::Unauthorized => FlowError::Unauthorized,
            other => FlowError::Other(format!("download {}: {}", rf.path, other)),
        })?;
        let abs = dest.join(&rf.path);
        write_atomic(&abs, &bytes).map_err(|e| FlowError::Other(format!("write {}: {}", rf.path, e)))?;
        let _ = write_atomic(&state_dir.join("base").join(&fid), &bytes);
        let (size, mtime_ms) = stat_pair(&abs);
        states.insert(
            fid,
            FileState { path: rf.path.clone(), rev: rf.rev, hash: rf.hash.clone(), size, mtime_ms },
        );
        done += 1;
        events.emit_json(
            EV_PROGRESS,
            json!({ "root": progress_root, "kind": "download", "done": done, "total": total }),
        );
    }

    Ok(WorkspaceState {
        version: MANIFEST_VERSION,
        manifest_etag: Some(etag),
        manifest,
        files: states,
        ..Default::default()
    })
}

/// Erase everything on the domain, round after round, until the worker
/// reports nothing left. Returns how many objects went. The domain is free
/// for a new binding afterwards.
pub async fn wipe_all<R: Remote>(remote: &Arc<R>) -> Result<u64, FlowError> {
    let mut purged = 0u64;
    for _ in 0..MAX_WIPE_ROUNDS {
        let round = remote.wipe().await?;
        purged += round.purged;
        if !round.remaining {
            return Ok(purged);
        }
    }
    Err(FlowError::Other(format!(
        "the domain still has objects after {} rounds — run the wipe again",
        MAX_WIPE_ROUNDS
    )))
}
