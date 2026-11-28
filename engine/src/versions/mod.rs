//! Versioning: every open folder gets a local store
//! that captures snapshots on the cadence rule, thins them on the retention
//! ladder, and never deletes anything anywhere else. This file is the
//! manager — one versioner task per open root, the routing table the edit
//! bus writes into, and the commands an app calls (`versions_*`: the Mac
//! frontend through src-tauri/src/versions.rs, mirrored in src/versions.ts;
//! the iPhone through command.rs).
//!
//! ```text
//! mod.rs        the manager, the versioner task, the commands, init at boot
//! store.rs      the store on disk: the index, snapshot files, blobs, gzip
//! capture.rs    the cadence state machine and the scan that takes a snapshot
//! history.rs    one file's versions, read out of the snapshots; the diff
//! workspace.rs  the whole folder: a snapshot's diff, deleted files, restore
//! stores.rs     every store on this Mac: sizes, forgetting one, the export
//! retain.rs     the ladder (pure) and the sweep
//! status.rs     the status/event contract
//! settings.rs   <app_data>/versions/settings.json
//! tests.rs      the cadence's consequences, the ladder, the sweep, the store
//! ```
//!
//! The versioner is deliberately independent of the cloud engine: it scans
//! on its own clock, keys snapshots by path rather than by the engine's file
//! ids, and works exactly the same for a folder that is not connected to
//! anything. What it borrows from `cloud::scan` is the local walk, the
//! hashing and the atomic write — so the two can never disagree about what
//! a workspace contains.

mod capture;
pub mod history;
// The cloud mirror reads the ladder and the store on disk; nothing outside
// this module ever writes into one.
pub(crate) mod retain;
mod settings;
pub mod status;
pub mod store;
pub mod stores;
#[cfg(test)]
mod tests;
pub mod workspace;

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use crate::cloud::space::Reach;
use crate::cloud::status::Events;
use crate::cloud::versions::VersionsEntry;
use crate::Core;

use capture::{Cadence, CaptureError};
use history::{FileHistory, SnapshotCache};
use retain::SWEEP_EVERY;
use settings::{read_settings, write_settings, Settings};
use status::{
    emit_statuses, Phase, RestoreOutcome, SnapshotMeta, StatusTable, StoreBytes, VersionsStatus, EV_APPLIED,
    EV_PROGRESS,
};
use store::{section_key, store_key, versions_dir, FileEntry, Index, Reason, SnapshotRow, Store};
use stores::{ExportReport, StoreInfo};
use workspace::{DeletedFile, RestoreReport, SnapshotDiff};

/// Where a versioner reads the time — the wall clock in the app, one the
/// test can move by hand in `tests.rs`. Only snapshot timestamps come from
/// here; the cadence measures elapsed time with `tokio::time::Instant`.
#[derive(Clone)]
pub struct Clock(pub Arc<dyn Fn() -> u64 + Send + Sync>);

impl Clock {
    pub fn wall() -> Clock {
        Clock(Arc::new(crate::cloud::scan::now_ms))
    }

    pub fn now_ms(&self) -> u64 {
        (self.0)()
    }
}

/* ---------- The versioner ---------- */

/// One folder's version store, and everything that decides what goes into
/// it. Every method here blocks: the async task around it (`run`) only ever
/// touches this inside `spawn_blocking`.
struct Versioner {
    store: Store,
    index: Index,
    /// The newest snapshot's file map — the stat cache.
    last: BTreeMap<String, FileEntry>,
    /// Decoded snapshots, for the rail's walk back through them.
    cache: SnapshotCache,
    by: String,
    enabled: bool,
    /// settings.json's horizon — what a store that has never chosen one
    /// follows.
    default_horizon: Option<u32>,
    phase: Phase,
    error: Option<String>,
    /// (blobs, snapshots) on disk, kept current as captures and sweeps run.
    bytes: (u64, u64),
    statuses: StatusTable,
    events: Arc<dyn Events>,
    clock: Clock,
}

impl Versioner {
    fn new(
        store: Store,
        by: String,
        settings: &Settings,
        statuses: StatusTable,
        events: Arc<dyn Events>,
        clock: Clock,
    ) -> Versioner {
        let index = store.read_index();
        Versioner {
            store,
            index,
            last: BTreeMap::new(),
            cache: SnapshotCache::default(),
            by,
            enabled: settings.enabled,
            default_horizon: settings.horizon_days,
            phase: if settings.enabled { Phase::Idle } else { Phase::Disabled },
            error: None,
            bytes: (0, 0),
            statuses,
            events,
            clock,
        }
    }

    /// Everything that happens before the first edit: adopt the newest
    /// snapshot as the stat cache, capture the folder as it was found if
    /// this store is new, then sweep.
    fn start(&mut self) {
        if let Some(ts) = self.index.newest().map(|n| n.ts) {
            if let Some(snap) = self.store.read_snapshot(ts) {
                self.last = snap.files;
            }
        }
        self.bytes = self.store.measure();
        if self.index.snapshots.is_empty() {
            // "Opened it, deleted half of it by accident" is recoverable
            // only if the folder was recorded before anything was touched.
            self.capture(Reason::Seed, None);
        }
        self.sweep(true);
    }

    fn capture(&mut self, reason: Reason, restored_from: Option<u64>) -> Option<SnapshotRow> {
        if !self.enabled {
            self.phase = Phase::Disabled;
            self.error = None;
            self.refresh_status();
            return None;
        }
        self.phase = Phase::Capturing;
        self.refresh_status();

        let now = self.clock.now_ms();
        let mut index = std::mem::take(&mut self.index);
        let mut last = std::mem::take(&mut self.last);
        let outcome = capture::capture(&self.store, &mut index, &mut last, &self.by, reason, restored_from, now);
        self.index = index;
        self.last = last;

        let row = match outcome {
            Ok(captured) => {
                self.phase = Phase::Idle;
                self.error = None;
                self.bytes.0 += captured.blob_bytes;
                self.bytes.1 += captured.snapshot_bytes;
                captured.row
            }
            Err(CaptureError::TooLarge) => {
                self.phase = Phase::TooLarge;
                self.error = Some(workspace::too_large());
                None
            }
            Err(CaptureError::Io(message)) => {
                self.phase = Phase::Error;
                self.error = Some(message);
                None
            }
        };
        self.refresh_status();
        row
    }

    /// How far back this store keeps: its own answer when the user has given
    /// one, settings.json's default until then.
    fn horizon(&self) -> Option<u32> {
        self.index.horizon_days.unwrap_or(self.default_horizon)
    }

    /// The user's answer for this folder, written into the index and applied
    /// at once — a shorter horizon should free the disk it promises, not on
    /// the next six-hourly sweep.
    fn set_horizon(&mut self, days: Option<u32>) -> Result<(), String> {
        self.index.horizon_days = Some(days);
        self.store.write_index(&self.index)?;
        self.sweep(true);
        Ok(())
    }

    /// The ladder, applied. `force` runs it whatever the clock says (at
    /// start); otherwise it runs at most every `SWEEP_EVERY`.
    fn sweep(&mut self, force: bool) {
        let now = self.clock.now_ms();
        let due = now.saturating_sub(self.index.last_sweep_ms) >= SWEEP_EVERY.as_millis() as u64;
        if !force && !due {
            return;
        }
        // Read before the take: an emptied `index` has no horizon of its own.
        let horizon = self.horizon();
        let mut index = std::mem::take(&mut self.index);
        let report = retain::sweep(&self.store, &mut index, now, horizon);
        self.index = index;
        if report.snapshots_dropped > 0 {
            // Decoded copies of snapshots that are no longer there.
            self.cache.clear();
        }
        if report.snapshots_dropped > 0 || report.blobs_dropped > 0 {
            eprintln!(
                "versions: {} thinned {} snapshot(s) and {} blob(s), {} KB",
                self.store.key,
                report.snapshots_dropped,
                report.blobs_dropped,
                report.bytes_freed / 1024
            );
        }
        self.bytes = self.store.measure();
        self.refresh_status();
    }

    /// A capture the user asked for. A `manual` one is pinned and may carry
    /// a name; when the workspace is exactly what the newest snapshot
    /// already holds, that snapshot takes the pin and the name instead of a
    /// duplicate being written.
    fn capture_now(
        &mut self,
        reason: Reason,
        label: Option<String>,
        restored_from: Option<u64>,
    ) -> Result<Option<SnapshotMeta>, String> {
        let newest_before = self.index.newest().map(|n| n.ts);
        let row = self.capture(reason, restored_from);
        if row.is_none() {
            if let Some(message) = self.error.clone() {
                return Err(message);
            }
        }
        let ts = match (row.as_ref(), reason, newest_before) {
            (Some(row), Reason::Manual, _) => row.ts,
            (Some(row), _, _) => return Ok(Some(SnapshotMeta::from(row))),
            (None, Reason::Manual, Some(ts)) => ts,
            (None, _, _) => return Ok(None),
        };
        self.set_pinned(ts, true, label)?;
        Ok(self.index.row(ts).map(SnapshotMeta::from))
    }

    fn set_pinned(&mut self, ts: u64, pinned: bool, label: Option<String>) -> Result<(), String> {
        let label = label.map(|l| l.trim().to_string()).filter(|l| !l.is_empty());
        let Some(row) = self.index.row_mut(ts) else {
            return Err("that version is no longer in this folder's history".to_string());
        };
        row.pinned = pinned;
        if label.is_some() {
            row.label = label;
        }
        let index = std::mem::take(&mut self.index);
        let written = self.store.write_index(&index);
        self.index = index;
        written?;
        self.refresh_status();
        Ok(())
    }

    /// One document's versions, and what is on disk right now. `cloud` is
    /// what the bucket holds — empty for a folder that isn't connected, and
    /// walked exactly like this Mac's own snapshots when it isn't.
    fn history(&mut self, rel: &str, cloud: &[VersionsEntry]) -> FileHistory {
        let current_hash = history::hash_on_disk(&self.store.abs(rel));
        let retained = history::retained_set(&self.index, cloud);
        let versions =
            history::file_versions(&self.store, &retained, &mut self.cache, rel, current_hash.as_deref());
        FileHistory { root: self.store.display(), current_hash, versions }
    }

    /// What restoring one retained snapshot would do to the folder as it
    /// stands this second — the modal shows
    /// this before anything happens, and the restore plans from the same
    /// three lists.
    fn snapshot_diff(&self, ts: u64) -> Result<SnapshotDiff, String> {
        let then = self.snapshot_at(ts)?;
        let now = workspace::disk_now(&self.store, &self.last)?;
        Ok(workspace::diff(&then.files, &now))
    }

    /// Every file some retained snapshot held that the folder does not hold
    /// now — *Recently deleted*, and the reason emptying the macOS Trash
    /// does not lose a note.
    fn deleted(&self) -> Result<Vec<DeletedFile>, String> {
        let on_disk = workspace::disk_paths(&self.store)?;
        Ok(workspace::deleted(&self.store, &self.index, &on_disk))
    }

    /// A retained snapshot, as much of it as is this store's section still:
    /// what was shared since from inside it is another section's now, and a
    /// restore here neither brings it back nor counts it missing.
    fn snapshot_at(&self, ts: u64) -> Result<store::Snapshot, String> {
        let mut snap = self
            .store
            .read_snapshot(ts)
            .ok_or_else(|| "that version of this folder is no longer in its history".to_string())?;
        snap.files.retain(|path, _| self.store.reach.holds(path));
        Ok(snap)
    }

    /// The file restore, one size up: the state the workspace is about to
    /// leave, the writes and the trashings, then the state they made. Same
    /// three steps, same reason they are one command — and the same rule
    /// that nothing older is ever removed, so *Undo* is simply a restore of
    /// `preRestoreTs` with the same paths.
    ///
    /// `only` is the subset the user ticked; None means the whole snapshot.
    fn restore_snapshot(
        &mut self,
        ts: u64,
        only: Option<&[String]>,
        write: WriteBytes,
        trash: TrashFile,
    ) -> Result<RestoreReport, String> {
        if !self.enabled {
            return Err("versions are turned off on this Mac — turn them back on to restore".to_string());
        }
        let then = self.snapshot_at(ts)?;
        let now = workspace::disk_now(&self.store, &self.last)?;
        let only: Option<BTreeSet<String>> = only.map(|paths| paths.iter().cloned().collect());
        let (to_write, to_trash) = workspace::plan(&workspace::diff(&then.files, &now), only.as_ref());
        // Every byte accounted for before the first one lands: a restore
        // that ran out of blobs halfway would leave the folder in a state
        // that was never real.
        for rel in &to_write {
            let hash = then.files.get(rel).map(|e| e.h.as_str()).unwrap_or_default();
            if !self.store.has_blob(hash) {
                return Err(format!(
                    "{} is no longer in this folder's history — nothing was changed",
                    rel
                ));
            }
        }

        let pre = self.capture(Reason::PreRestore, None);
        if pre.is_none() {
            if let Some(message) = self.error.clone() {
                return Err(message);
            }
        }
        let mut report = RestoreReport {
            pre_restore_ts: pre.map(|row| row.ts).or_else(|| self.index.newest().map(|n| n.ts)),
            ..Default::default()
        };

        let mut touched: Vec<String> = Vec::new();
        for rel in &to_write {
            let Some(entry) = then.files.get(rel) else { continue };
            let Some(bytes) = self.store.read_blob(&entry.h) else { continue };
            let abs = self.store.abs(rel);
            // A folder that was deleted along with everything in it comes
            // back with the files that were in it.
            if let Some(parent) = abs.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {}", parent.display(), e))?;
            }
            write(&abs, &bytes)?;
            report.written += 1;
            touched.push(abs.to_string_lossy().to_string());
        }
        for rel in &to_trash {
            let abs = self.store.abs(rel);
            if trash(&abs) {
                report.trashed += 1;
                touched.push(abs.to_string_lossy().to_string());
            }
        }

        let made = self.capture(Reason::Restore, Some(ts));
        if made.is_none() {
            if let Some(message) = self.error.clone() {
                return Err(message);
            }
        }
        self.events.emit_json(
            EV_APPLIED,
            serde_json::json!({
                "root": self.store.display(),
                "paths": touched,
            }),
        );
        Ok(report)
    }

    /// A restore, whole: the state it is about to leave, the write, then the
    /// state it made — three steps the cadence must not get between, which
    /// is why this is one command and not a capture plus a `write_file` from
    /// the frontend.
    ///
    /// It never removes anything. The versions between the one being
    /// restored and now stay exactly where they are; the restored content
    /// simply becomes the newest.
    fn restore_file(
        &mut self,
        path: &Path,
        from_ts: Option<u64>,
        hash: Option<String>,
        text: Option<String>,
        write: &dyn Fn(&Path, &str) -> Result<(), String>,
    ) -> Result<RestoreOutcome, String> {
        if !self.enabled {
            return Err("versions are turned off on this Mac — turn them back on to restore".to_string());
        }
        let rel = self
            .store
            .rel_of(path)
            .ok_or_else(|| "that file isn't in a folder with version history".to_string())?;
        // A revision only the cloud still holds arrives as text; everything
        // else is a blob in this store.
        let local = text.is_none();
        let contents = match (text, hash.as_deref()) {
            (Some(text), _) => text,
            (None, Some(hash)) => history::read_version(&self.store, hash)?,
            (None, None) => return Err("there's no version to restore".to_string()),
        };

        let pre = self.capture(Reason::PreRestore, None);
        if pre.is_none() {
            if let Some(message) = self.error.clone() {
                return Err(message);
            }
        }
        // Taken before the write, from the stat cache the capture just
        // refreshed: this is the document as the user last had it.
        let pre_restore_ts = pre.map(|row| row.ts).or_else(|| self.index.newest().map(|n| n.ts));
        let pre_restore_hash = self.last.get(&rel).map(|entry| entry.h.clone());

        // A file restored after its folder was deleted brings the folder
        // back with it.
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {}", parent.display(), e))?;
        }
        // A document's sidecar from the same snapshot goes down first, beside
        // what the sidecar holds now: the old text finds every record it
        // uses (its comments' bodies, its links' ids) and nothing is lost.
        // What no text uses any more goes at the app's next save.
        let mut paths = vec![path.to_string_lossy().to_string()];
        let then = hash.as_deref().zip(from_ts).filter(|_| local).and_then(|(hash, ts)| self.sidecar_then(&rel, ts, hash));
        if let Some(then) = then {
            let sidecar = path.with_file_name(crate::sidecar::sidecar_of(&path.file_name().unwrap_or_default().to_string_lossy()));
            let now = std::fs::read_to_string(&sidecar).ok();
            let both = crate::sidecar::with_records_of(now.as_deref(), &then);
            if now.as_deref() != Some(both.as_str()) {
                write(&sidecar, &both)?;
                paths.push(sidecar.to_string_lossy().to_string());
            }
        }
        write(path, &contents)?;

        let made = self.capture(Reason::Restore, from_ts);
        if made.is_none() {
            if let Some(message) = self.error.clone() {
                return Err(message);
            }
        }
        self.events.emit_json(
            EV_APPLIED,
            serde_json::json!({
                "root": self.store.display(),
                "paths": paths,
            }),
        );
        Ok(RestoreOutcome { pre_restore_ts, pre_restore_hash, ts: made.map(|row| row.ts) })
    }

    /// The sidecar of the document at `rel` in the snapshot taken at `ts`,
    /// when that snapshot holds the document at `hash`: the comments and
    /// links its text had then. None for a file that is no document.
    fn sidecar_then(&self, rel: &str, ts: u64, hash: &str) -> Option<String> {
        if !crate::is_document(rel) {
            return None;
        }
        let snap = self.store.read_snapshot(ts)?;
        if snap.files.get(rel)?.h != hash {
            return None;
        }
        let entry = snap.files.get(&crate::sidecar::sidecar_of(rel))?;
        history::read_version(&self.store, &entry.h).ok()
    }

    fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
        self.phase = if enabled { Phase::Idle } else { Phase::Disabled };
        self.error = None;
        self.refresh_status();
    }

    /// The timeline's model: every retained snapshot, newest first, each
    /// carrying what it changed against the one before it. Working that out
    /// costs one decode per row — which is why it is this command's job and
    /// not the status's.
    fn snapshots(&self) -> Vec<SnapshotMeta> {
        let mut out: Vec<SnapshotMeta> = Vec::with_capacity(self.index.snapshots.len());
        let mut before: Option<BTreeMap<String, FileEntry>> = None;
        for row in &self.index.snapshots {
            let mut meta = SnapshotMeta::from(row);
            let after = self.store.read_snapshot(row.ts).map(|snap| snap.files);
            if let (Some(before), Some(after)) = (before.as_ref(), after.as_ref()) {
                meta.delta = Some(workspace::delta(before, after));
            }
            out.push(meta);
            if let Some(after) = after {
                before = Some(after);
            }
        }
        out.reverse();
        out
    }

    fn status(&self) -> VersionsStatus {
        VersionsStatus {
            root: self.store.display(),
            key: self.store.key.clone(),
            phase: self.phase,
            error: self.error.clone(),
            snapshots: self.index.snapshots.len() as u64,
            oldest_ms: self.index.snapshots.first().map(|s| s.ts),
            newest_ms: self.index.newest().map(|s| s.ts),
            last_capture_ms: Some(self.index.last_capture_ms).filter(|ms| *ms > 0),
            bytes: StoreBytes { blobs: self.bytes.0, snapshots: self.bytes.1 },
            horizon_days: self.horizon(),
        }
    }

    fn refresh_status(&self) {
        let status = self.status();
        if let Ok(mut table) = self.statuses.lock() {
            table.insert(status.root.clone(), status);
        }
        emit_statuses(self.events.as_ref(), &self.statuses);
    }
}

/// How a restore puts bytes down and how it takes a file away: the app's own
/// write path and trash (`Host`), handed in rather than reached for, so the
/// versioner stays testable without an app around it.
type WriteBytes<'a> = &'a dyn Fn(&Path, &[u8]) -> Result<(), String>;
type TrashFile<'a> = &'a dyn Fn(&Path) -> bool;

/* ---------- The task ---------- */

enum VersionerCmd {
    /// The edit bus: a workspace-relative path the app just wrote. The
    /// versioner scans everything, so the path is a hint about *when*.
    Touched(String),
    CaptureNow {
        reason: Reason,
        label: Option<String>,
        reply: oneshot::Sender<Result<Option<SnapshotMeta>, String>>,
    },
    SetPinned {
        ts: u64,
        pinned: bool,
        label: Option<String>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Snapshots {
        reply: oneshot::Sender<Vec<SnapshotMeta>>,
    },
    History {
        rel: String,
        cloud: Vec<VersionsEntry>,
        reply: oneshot::Sender<FileHistory>,
    },
    RestoreFile {
        core: Arc<Core>,
        path: PathBuf,
        from_ts: Option<u64>,
        hash: Option<String>,
        text: Option<String>,
        reply: oneshot::Sender<Result<RestoreOutcome, String>>,
    },
    SnapshotDiff {
        ts: u64,
        reply: oneshot::Sender<Result<SnapshotDiff, String>>,
    },
    Deleted {
        reply: oneshot::Sender<Result<Vec<DeletedFile>, String>>,
    },
    RestoreSnapshot {
        core: Arc<Core>,
        ts: u64,
        paths: Option<Vec<String>>,
        reply: oneshot::Sender<Result<RestoreReport, String>>,
    },
    SetEnabled(bool),
    SetHorizon {
        days: Option<u32>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Capture what is pending and answer — the quit flush.
    Flush {
        reply: oneshot::Sender<()>,
    },
    /// Stop without the closing capture, and answer once nothing more will be
    /// written: the folder is being taken off this Mac, and its history goes
    /// with it (`forget_store`).
    Abandon {
        reply: oneshot::Sender<()>,
    },
    Shutdown,
}

type Shared = Arc<Mutex<Versioner>>;

/// Run one blocking step against the versioner. Every scan, hash and write
/// goes through here, so the runtime is never blocked by a capture.
async fn blocking<T, F>(state: &Shared, f: F) -> Option<T>
where
    T: Send + 'static,
    F: FnOnce(&mut Versioner) -> T + Send + 'static,
{
    let state = state.clone();
    match tokio::task::spawn_blocking(move || {
        // A poisoned lock means an earlier step panicked; the store on disk
        // is still consistent (writes are atomic and ordered), so carry on.
        let mut versioner = state.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut versioner)
    })
    .await
    {
        Ok(value) => Some(value),
        Err(e) => {
            eprintln!("versions: a background step failed: {}", e);
            None
        }
    }
}

/// The versioner task: wake on the edit bus, the folder watcher, a command
/// or the cadence clock; capture when the rule says to.
async fn run(state: Shared, mut cmds: mpsc::UnboundedReceiver<VersionerCmd>, mut fs: mpsc::UnboundedReceiver<()>) {
    blocking(&state, |v| v.start()).await;
    let mut cadence = Cadence::new(Instant::now());
    let mut watching = true;

    loop {
        let wake = cadence.wake(Instant::now());
        // Whether this turn of the loop is the clock's rather than an
        // edit's — the moment to let the ladder advance on an idle folder.
        let mut on_the_clock = false;
        tokio::select! {
            cmd = cmds.recv() => match cmd {
                None | Some(VersionerCmd::Shutdown) => {
                    // The last window on this folder closed: the session's
                    // final state is captured on the way out.
                    if cadence.is_dirty() {
                        blocking(&state, |v| { v.capture(Reason::Closing, None); }).await;
                    }
                    return;
                }
                Some(VersionerCmd::Touched(_rel)) => cadence.touched(Instant::now()),
                Some(VersionerCmd::SetEnabled(enabled)) => {
                    blocking(&state, move |v| v.set_enabled(enabled)).await;
                }
                Some(VersionerCmd::SetHorizon { days, reply }) => {
                    let answer = blocking(&state, move |v| v.set_horizon(days)).await;
                    let _ = reply.send(answer.unwrap_or_else(|| Err("That change didn't finish.".to_string())));
                }
                Some(VersionerCmd::CaptureNow { reason, label, reply }) => {
                    let answer = blocking(&state, move |v| v.capture_now(reason, label, None)).await;
                    cadence.captured(Instant::now());
                    let _ = reply.send(answer.unwrap_or_else(|| Err("that capture didn't finish".to_string())));
                }
                Some(VersionerCmd::SetPinned { ts, pinned, label, reply }) => {
                    let answer = blocking(&state, move |v| v.set_pinned(ts, pinned, label)).await;
                    let _ = reply.send(answer.unwrap_or_else(|| Err("that version couldn't be named".to_string())));
                }
                Some(VersionerCmd::Snapshots { reply }) => {
                    let answer = blocking(&state, |v| v.snapshots()).await;
                    let _ = reply.send(answer.unwrap_or_default());
                }
                Some(VersionerCmd::History { rel, cloud, reply }) => {
                    if let Some(history) = blocking(&state, move |v| v.history(&rel, &cloud)).await {
                        let _ = reply.send(history);
                    }
                }
                Some(VersionerCmd::RestoreFile { core, path, from_ts, hash, text, reply }) => {
                    let answer = blocking(&state, move |v| {
                        v.restore_file(&path, from_ts, hash, text, &|path, contents| {
                            core.host.write_file(path, contents.as_bytes())
                        })
                    })
                    .await;
                    cadence.captured(Instant::now());
                    let _ = reply.send(answer.unwrap_or_else(|| Err("that restore didn't finish".to_string())));
                }
                Some(VersionerCmd::SnapshotDiff { ts, reply }) => {
                    let answer = blocking(&state, move |v| v.snapshot_diff(ts)).await;
                    let _ = reply.send(answer.unwrap_or_else(|| Err("that comparison didn't finish".to_string())));
                }
                Some(VersionerCmd::Deleted { reply }) => {
                    let answer = blocking(&state, |v| v.deleted()).await;
                    let _ = reply
                        .send(answer.unwrap_or_else(|| Err("that folder's deleted files couldn't be read".to_string())));
                }
                Some(VersionerCmd::RestoreSnapshot { core, ts, paths, reply }) => {
                    let answer = blocking(&state, move |v| {
                        v.restore_snapshot(
                            ts,
                            paths.as_deref(),
                            &|path, bytes| core.host.write_file(path, bytes),
                            &|path| {
                                let gone = workspace::trash_or_remove(core.host.as_ref(), path);
                                // The cloud engine hears the deletion the
                                // same way it hears a write.
                                if gone {
                                    core.touched(&path.to_string_lossy());
                                }
                                gone
                            },
                        )
                    })
                    .await;
                    cadence.captured(Instant::now());
                    let _ = reply.send(answer.unwrap_or_else(|| Err("that restore didn't finish".to_string())));
                }
                Some(VersionerCmd::Flush { reply }) => {
                    if cadence.is_dirty() {
                        blocking(&state, |v| { v.capture(Reason::Closing, None); }).await;
                        cadence.captured(Instant::now());
                    }
                    let _ = reply.send(());
                }
                Some(VersionerCmd::Abandon { reply }) => {
                    // Commands are taken one at a time, so any capture that
                    // was running has finished: from here this task writes
                    // nothing, which is what the answer promises.
                    let _ = reply.send(());
                    return;
                }
            },
            event = fs.recv(), if watching => match event {
                // The watcher never started (or died): the edit bus still
                // carries every edit the app itself makes.
                None => watching = false,
                Some(()) => cadence.touched(Instant::now()),
            },
            _ = tokio::time::sleep_until(wake) => on_the_clock = true,
        }

        if let Some(reason) = cadence.due(Instant::now()) {
            blocking(&state, move |v| {
                v.capture(reason, None);
                v.sweep(false);
            })
            .await;
        } else if on_the_clock {
            // A folder nobody is editing still ages past its horizon.
            blocking(&state, |v| v.sweep(false)).await;
        }
    }
}

/* ---------- The routing table ---------- */

struct Route {
    /// What it versions: a folder, or a section's part of one.
    store: Store,
    tx: mpsc::UnboundedSender<VersionerCmd>,
}

/// Of the stores that version `path`, the one it is: a shared document's
/// before the folder it sits in, a deeper folder before the one around it.
fn store_of<'a, T>(stores: impl Iterator<Item = (&'a Store, T)>, path: &Path) -> Option<(String, T)> {
    stores
        .filter_map(|(store, with)| store.rel_of(path).map(|rel| (store, rel, with)))
        .max_by_key(|(store, _, _)| (store.reach.only.is_some(), store.root.as_os_str().len()))
        .map(|(_, rel, with)| (rel, with))
}

/// One row per running versioner, beside the manager — so a write reaches
/// it without touching the manager's lock. The cloud's edit bus is the same
/// shape; both filter with `cloud::scan::rel_for_touch`.
#[derive(Default)]
pub struct VersionBus {
    routes: RwLock<Vec<Route>>,
}

impl VersionBus {
    fn register(&self, store: Store, tx: mpsc::UnboundedSender<VersionerCmd>) {
        if let Ok(mut routes) = self.routes.write() {
            routes.retain(|r| r.store.key != store.key);
            routes.push(Route { store, tx });
        }
    }

    fn unregister(&self, key: &str) {
        if let Ok(mut routes) = self.routes.write() {
            routes.retain(|r| r.store.key != key);
        }
    }

    /// Route a touched absolute path to the versioner that versions it.
    /// Returns whether one did.
    pub fn touch(&self, path: &Path) -> bool {
        let Ok(routes) = self.routes.read() else { return false };
        let Some((rel, tx)) = store_of(routes.iter().map(|r| (&r.store, &r.tx)), path) else { return false };
        tx.send(VersionerCmd::Touched(rel)).is_ok()
    }
}

/* ---------- The manager ---------- */

struct VersionerHandle {
    tx: mpsc::UnboundedSender<VersionerCmd>,
    /// The store this versioner owns; no two may share one.
    store: Store,
    // Held so the folder watcher lives exactly as long as the versioner.
    _watcher: Option<crate::cloud::Watcher>,
}

pub(crate) struct ManagerInner {
    data_dir: PathBuf,
    /// The name a snapshot is attributed to.
    by: String,
    settings: Settings,
    /// Keyed by what each store is called (`Store::display`): its folder —
    /// or, for a shared document's, the document.
    versioners: HashMap<String, VersionerHandle>,
    statuses: StatusTable,
}

/// Called once as the app boots, after `cloud::init`: read the settings,
/// then start a versioner for every root already open.
pub fn init(core: &Arc<Core>) {
    let data_dir = core.data_dir.clone();
    let _ = std::fs::create_dir_all(versions_dir(&data_dir));
    let settings = read_settings(&data_dir);
    let by = crate::cloud::device_name(core);

    let inner = ManagerInner {
        data_dir,
        by,
        settings,
        versioners: HashMap::new(),
        statuses: Arc::new(Mutex::new(Default::default())),
    };
    if let Ok(mut guard) = core.versions.lock() {
        *guard = Some(inner);
    }
    reconcile(core);
}

/// The stores to version now, by what each is called: every folder the app
/// says is open (`Host::open_folders`) — and of one that is a connected
/// workspace, each section's own instead: Library, My files and everything
/// shared keep their history in a store apiece, which only their own
/// people's devices have, and the workspace's root keeps none
/// (`keeps_own_versions`). Where each section is, and what of its folder is
/// its own, is the engine's to say (`cloud::sections_of`). Asked whenever
/// what is open may have changed (`reconcile`), so nothing else is needed to
/// start or stop a versioner. An untitled note is in no folder, so it has no
/// history: it is unsaved, and gone when its tab closes.
fn open_stores(core: &Core, data_dir: &Path) -> BTreeMap<String, Store> {
    let mut stores = BTreeMap::new();
    for root in core.host.open_folders() {
        let path = PathBuf::from(&root);
        if crate::cloud::keeps_own_versions(&path) {
            let store = Store::open(data_dir, &store_key(&path), &path);
            stores.insert(store.display(), store);
            continue;
        }
        for section in crate::cloud::sections_of(core, &root) {
            let key = section_key(&section.ws_id, &section.id);
            let store = Store::open_section(data_dir, &key, &section.root, &section.reach);
            stores.insert(store.display(), store);
        }
    }
    stores
}

/// Bring the running versioners in line with what is open: one that is not
/// open any more stops, and so does one whose section is somewhere else
/// now, or is another part of its folder — its store carries on under the
/// versioner started for it as it is.
pub fn reconcile(core: &Arc<Core>) {
    let _ = with_inner(core, |inner| {
        let open = open_stores(core, &inner.data_dir);
        let same = |handle: &VersionerHandle, store: &Store| {
            handle.store.key == store.key && handle.store.root == store.root && handle.store.reach == store.reach
        };
        let stale: Vec<String> = inner
            .versioners
            .iter()
            .filter(|(name, handle)| !open.get(*name).is_some_and(|store| same(handle, store)))
            .map(|(name, _)| name.clone())
            .collect();
        for name in stale {
            stop_versioner(core, inner, &name);
        }
        for (name, store) in open {
            if !inner.versioners.contains_key(&name) {
                start_versioner(core, inner, store);
            }
        }
        Ok(())
    });
}

fn start_versioner(core: &Arc<Core>, inner: &mut ManagerInner, store: Store) {
    let root = store.root.clone();
    if !root.is_dir() {
        return;
    }
    // A store never versions itself, and nothing versions the folder the
    // stores live in.
    let stores = versions_dir(&inner.data_dir);
    if root.starts_with(&stores) || stores.starts_with(&root) {
        return;
    }
    // One store, one versioner. Two windows on the same folder are one root
    // and never get here; two spellings of one path (a symlink, a `..`)
    // would, and two tasks writing one index would lose rows to each other.
    if inner.versioners.values().any(|h| h.store.key == store.key) {
        return;
    }

    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<VersionerCmd>();
    // The same recursive watcher the engine uses, for the same reason: an
    // edit made outside the app still ends a session.
    let (watcher, fs_rx) = crate::cloud::watch_folder(core, &root, "versions");

    let versioner = Versioner::new(
        store.clone(),
        inner.by.clone(),
        &inner.settings,
        inner.statuses.clone(),
        core.events(),
        Clock::wall(),
    );
    core.runtime.spawn(run(Arc::new(Mutex::new(versioner)), cmd_rx, fs_rx));

    core.version_bus.register(store.clone(), cmd_tx.clone());
    inner.versioners.insert(store.display(), VersionerHandle { tx: cmd_tx, store, _watcher: watcher });
}

/// Stop the versioner for `root` — it captures the session's last state on
/// the way out — and forget its status row.
fn stop_versioner(core: &Core, inner: &mut ManagerInner, root: &str) {
    let Some(handle) = inner.versioners.remove(root) else { return };
    let _ = handle.tx.send(VersionerCmd::Shutdown);
    core.version_bus.unregister(&handle.store.key);
    if let Ok(mut table) = inner.statuses.lock() {
        table.remove(root);
    }
    emit_statuses(core.events().as_ref(), &inner.statuses);
}

fn with_inner<T>(core: &Core, f: impl FnOnce(&mut ManagerInner) -> Result<T, String>) -> Result<T, String> {
    let mut guard = core.versions.lock().map_err(|_| "the versions manager is wedged".to_string())?;
    let inner = guard.as_mut().ok_or_else(|| "versions aren't ready yet".to_string())?;
    f(inner)
}

fn sender_for(core: &Arc<Core>, root: &str) -> Result<mpsc::UnboundedSender<VersionerCmd>, String> {
    with_inner(core, |inner| {
        inner
            .versioners
            .get(root)
            .map(|h| h.tx.clone())
            .ok_or_else(|| "that folder has no version store yet".to_string())
    })
}

/// The versioner that versions `path`, with what its store is called and
/// the path as the store names it.
fn route(core: &Arc<Core>, path: &str) -> Result<(mpsc::UnboundedSender<VersionerCmd>, String, String), String> {
    let abs = PathBuf::from(path);
    with_inner(core, move |inner| {
        let handles = inner.versioners.iter().map(|(name, handle)| (&handle.store, (name, handle)));
        // Told apart: a file in no folder that keeps versions, and a file
        // such a folder does not version.
        if !inner.versioners.values().any(|handle| abs.starts_with(&handle.store.root)) {
            return Err("that file isn't in a folder with version history".to_string());
        }
        let (rel, (name, handle)) =
            store_of(handles, &abs).ok_or_else(|| "this folder doesn't keep versions of that file".to_string())?;
        Ok((handle.tx.clone(), name.clone(), rel))
    })
}

/// Stop the versioner called `root` and wait until it has: it captures what
/// is pending first, then writes nothing more. For a folder about to move
/// into the Library layout (`cloud::layout`), whose store is about to become
/// Library's; by then `open_stores` no longer names the root, so nothing
/// starts it again.
pub(crate) async fn release_root(core: &Core, root: &str) {
    let stopping = with_inner(core, |inner| {
        let Some(handle) = inner.versioners.remove(root) else { return Ok(None) };
        core.version_bus.unregister(&handle.store.key);
        if let Ok(mut table) = inner.statuses.lock() {
            table.remove(root);
        }
        emit_statuses(core.events().as_ref(), &inner.statuses);
        let (flushed, _) = oneshot::channel();
        let _ = handle.tx.send(VersionerCmd::Flush { reply: flushed });
        let (reply_tx, reply_rx) = oneshot::channel();
        let _ = handle.tx.send(VersionerCmd::Abandon { reply: reply_tx });
        Ok(Some(reply_rx))
    })
    .ok()
    .flatten();
    if let Some(stopped) = stopping {
        let _ = tokio::time::timeout(ABANDON_TIMEOUT, stopped).await;
    }
}

/// The version store for a folder that is no workspace, opened straight
/// from its path — no manager, no running versioner.
pub(crate) fn store_for_root(data_dir: &Path, root: &Path) -> Store {
    Store::open(data_dir, &store_key(root), root)
}

/// The version store of one section of a connected workspace, opened with
/// no manager and no running versioner. What the cloud engine mirrors from:
/// it reads, and never writes.
pub(crate) fn store_for_section(data_dir: &Path, ws_id: &str, section: &str, root: &Path, reach: &Reach) -> Store {
    Store::open_section(data_dir, &section_key(ws_id, section), root, reach)
}

/// How long `forget_store` waits for a versioner to say it has stopped.
const ABANDON_TIMEOUT: Duration = Duration::from_secs(20);

/// Delete this Mac's whole version history kept under `key`, stopping its
/// versioner first — with no closing capture, which would only write the
/// store back. For a workspace this Mac has lost access to
/// (`access_removed`, cloud/mod.rs), and for a section this person can no
/// longer open: the history holds every file's content, so it leaves with
/// the files.
pub(crate) async fn forget_store(core: &Core, key: &str) {
    if !stores::valid_key(key) {
        return;
    }
    let stopping = with_inner(core, |inner| {
        let Some(name) = inner.versioners.iter().find(|(_, handle)| handle.store.key == key).map(|(name, _)| name.clone()) else {
            return Ok(None);
        };
        let Some(handle) = inner.versioners.remove(&name) else { return Ok(None) };
        core.version_bus.unregister(&handle.store.key);
        if let Ok(mut table) = inner.statuses.lock() {
            table.remove(&name);
        }
        emit_statuses(core.events().as_ref(), &inner.statuses);
        let (reply_tx, reply_rx) = oneshot::channel();
        let _ = handle.tx.send(VersionerCmd::Abandon { reply: reply_tx });
        // The handle drops here, and its watcher with it.
        Ok(Some(reply_rx))
    })
    .ok()
    .flatten();
    if let Some(stopped) = stopping {
        let _ = tokio::time::timeout(ABANDON_TIMEOUT, stopped).await;
    }
    let Some(dir) = with_inner(core, |inner| Ok(versions_dir(&inner.data_dir).join(key))).ok() else { return };
    let _ = tokio::task::spawn_blocking(move || std::fs::remove_dir_all(&dir)).await;
}

/// A store to read from without going through its versioner: reads are pure
/// filesystem and have no business queueing behind a capture.
fn store_for(core: &Arc<Core>, root: &str) -> Result<Store, String> {
    with_inner(core, |inner| {
        let handle = inner
            .versioners
            .get(root)
            .ok_or_else(|| "that folder has no version store yet".to_string())?;
        Ok(handle.store.clone())
    })
}

/// Ask a versioner something and wait for its answer.
async fn ask<T>(
    tx: mpsc::UnboundedSender<VersionerCmd>,
    make: impl FnOnce(oneshot::Sender<T>) -> VersionerCmd,
) -> Result<T, String> {
    let (reply_tx, reply_rx) = oneshot::channel();
    tx.send(make(reply_tx)).map_err(|_| "that folder's versioner has stopped".to_string())?;
    reply_rx.await.map_err(|_| "that folder's versioner has stopped".to_string())
}

/// Ask every versioner to capture what is pending; the answers to wait on.
fn ask_all_to_flush(core: &Core) -> Vec<oneshot::Receiver<()>> {
    let mut waiting = Vec::new();
    let _ = with_inner(core, |inner| {
        for handle in inner.versioners.values() {
            let (reply, rx) = oneshot::channel();
            if handle.tx.send(VersionerCmd::Flush { reply }).is_ok() {
                waiting.push(rx);
            }
        }
        Ok(())
    });
    waiting
}

/// Capture whatever is pending everywhere, within `deadline` — the last
/// thing that happens before the app exits, so a session that ends mid-edit
/// still ends in a snapshot. Blocks the caller; runs on the main thread at
/// quit, never inside the async runtime.
pub fn flush_all_blocking(core: &Core, deadline: Duration) {
    let waiting = ask_all_to_flush(core);
    if waiting.is_empty() {
        return;
    }
    core.runtime.block_on(async move {
        let _ = tokio::time::timeout(deadline, futures_util::future::join_all(waiting)).await;
    });
}

/// `flush_all_blocking` for a caller already inside the runtime: an app that
/// is told it is leaving the screen, not quitting.
pub async fn flush_all(core: &Core, deadline: Duration) {
    let waiting = ask_all_to_flush(core);
    if !waiting.is_empty() {
        let _ = tokio::time::timeout(deadline, futures_util::future::join_all(waiting)).await;
    }
}

/* ---------- The commands ---------- */

/// Every version store's status — the frontend's whole model.
pub fn versions_status(core: &Arc<Core>) -> Result<Vec<VersionsStatus>, String> {
    with_inner(core, |inner| Ok(status::snapshot(&inner.statuses)))
}

/// A folder's retained snapshots, newest first.
pub async fn versions_snapshots(core: &Arc<Core>, root: String) -> Result<Vec<SnapshotMeta>, String> {
    let tx = sender_for(core, &root)?;
    ask(tx, |reply| VersionerCmd::Snapshots { reply }).await
}

/// Capture now, whatever the cadence says. A `manual` capture (the default)
/// is pinned and may carry a name; the answer is null when the folder is
/// already exactly what the newest snapshot holds and no name was given.
pub async fn versions_capture_now(
    core: &Arc<Core>,
    root: String,
    reason: Option<String>,
    label: Option<String>,
) -> Result<Option<SnapshotMeta>, String> {
    let reason = match reason.as_deref() {
        None => Reason::Manual,
        Some(name) => Reason::parse(name).ok_or_else(|| format!("\"{}\" isn't a kind of snapshot", name))?,
    };
    let tx = sender_for(core, &root)?;
    ask(tx, |reply| VersionerCmd::CaptureNow { reason, label, reply }).await?
}

/// Keep a version out of the ladder's reach, and optionally name it.
pub async fn versions_set_pinned(
    core: &Arc<Core>,
    root: String,
    ts: u64,
    pinned: bool,
    label: Option<String>,
) -> Result<(), String> {
    let tx = sender_for(core, &root)?;
    ask(tx, |reply| VersionerCmd::SetPinned { ts, pinned, label, reply }).await?
}

/// The kill switch. Nothing already captured is touched; capture simply
/// stops until it is turned back on.
pub fn versions_set_enabled(core: &Arc<Core>, enabled: bool) -> Result<(), String> {
    with_inner(core, |inner| {
        inner.settings.enabled = enabled;
        write_settings(&inner.data_dir, &inner.settings)?;
        for handle in inner.versioners.values() {
            let _ = handle.tx.send(VersionerCmd::SetEnabled(enabled));
        }
        Ok(())
    })
}

/// How many mirrored snapshots one history call will download before it
/// answers. Opening the rail on a Mac that connected a minute ago should
/// cost a moment, not the whole bucket; the mirror's daily sweep fetches
/// the rest into the same cache in the background.
const CLOUD_PREFETCH: usize = 48;

/// What the bucket holds for the workspace `path` is in, with the snapshots
/// the rail is about to read pulled into the store's cache. Empty for a
/// folder that isn't connected — history is ungated, so that is no error.
async fn mirrored_set(core: &Arc<Core>, path: &str, root: &str) -> Vec<VersionsEntry> {
    let Ok(Some(index)) = crate::cloud::versions_index_for(core, path).await else { return Vec::new() };
    let Ok(store) = store_for(core, root) else { return index.snapshots };
    let mut newest = index.snapshots.clone();
    newest.sort_by(|a, b| b.ts.cmp(&a.ts));
    let mut fetched = 0;
    for entry in &newest {
        if fetched >= CLOUD_PREFETCH {
            break;
        }
        if store.read_cloud_snapshot(&entry.id).is_some() {
            continue;
        }
        // Offline, or a snapshot another device's sweep has since dropped:
        // stop asking rather than time out once per row.
        if crate::cloud::version_snapshot(core, path, &entry.id).await.is_err() {
            break;
        }
        fetched += 1;
    }
    index.snapshots
}

/// Every version of one document, newest first — the rail's whole model.
/// This Mac's snapshots and the ones other devices mirrored are one walk,
/// and that walk is the whole answer.
///
/// A document in something shared has its history from before it was shared
/// in the section it was shared from. Somebody who can open that section —
/// this device has its store then — reads on into it: the same document,
/// one list. For anyone else it starts at the share.
pub async fn versions_history(core: &Arc<Core>, path: String) -> Result<FileHistory, String> {
    let (tx, root, rel) = route(core, &path)?;
    let cloud = mirrored_set(core, &path, &root).await;
    let before = earlier(core, &root, Some(&rel));
    let mut history: FileHistory = ask(tx, move |reply| VersionerCmd::History { rel, cloud, reply }).await?;
    if let Some((from, Some(rel))) = before {
        if let Ok(tx) = sender_for(core, &from) {
            let cloud = mirrored_set(core, &from, &from).await;
            if let Ok(older) = ask(tx, move |reply| VersionerCmd::History { rel, cloud, reply }).await {
                history::carry_on(&mut history, older);
            }
        }
    }
    Ok(history)
}

/// Where the history of the store called `root` carries on from: the store
/// of the section its item was shared from, when this device versions that
/// one too — and the file `rel` as that store names it.
fn earlier(core: &Arc<Core>, root: &str, rel: Option<&str>) -> Option<(String, Option<String>)> {
    with_inner(core, |inner| {
        let Some(store) = inner.versioners.get(root).map(|handle| &handle.store) else { return Ok(None) };
        let sections = core.sections.lock().map(|table| table.values().flatten().cloned().collect::<Vec<_>>()).unwrap_or_default();
        let Some((ws_id, (parent, was))) = sections
            .into_iter()
            .find(|section| section_key(&section.ws_id, &section.id) == store.key)
            .and_then(|section| Some((section.ws_id, section.from?)))
        else {
            return Ok(None);
        };
        let key = section_key(&ws_id, &parent);
        let Some(from) = inner.versioners.values().find(|handle| handle.store.key == key).map(|handle| handle.store.display()) else {
            return Ok(None);
        };
        // A shared document's files were `<was>.<ext>`; a shared folder's, under `<was>/`.
        let there = rel.map(|rel| match &store.reach.only {
            Some(_) => format!("{}{}", was, crate::cloud::space::split_name(rel).1),
            None => format!("{}/{}", was, rel),
        });
        Ok(Some((from, there)))
    })
    .ok()
    .flatten()
}

/// One version's text: this Mac's blob, or — for a version only another
/// device ever held — the mirrored one, fetched through the engine.
///
/// A version from before its document was shared is in the store of the
/// section it was shared from (`versions_history`): looked for there next.
async fn version_text(core: &Arc<Core>, root: &str, hash: &str) -> Result<String, String> {
    let mut at = root.to_string();
    let mut refusal: Option<String> = None;
    // A share inside a share inside My files is three stores deep.
    for _ in 0..4 {
        let store = store_for(core, &at)?;
        let owned = hash.to_string();
        let local = tokio::task::spawn_blocking(move || history::read_version(&store, &owned))
            .await
            .map_err(|_| "that version couldn't be read".to_string())?;
        match local {
            Ok(text) => return Ok(text),
            Err(missing) => match crate::cloud::version_blob(core, &at, hash).await {
                Ok(bytes) => return history::text_of(bytes),
                Err(_) => refusal = refusal.or(Some(missing)),
            },
        }
        match earlier(core, &at, None) {
            Some((from, _)) => at = from,
            None => break,
        }
    }
    Err(refusal.unwrap_or_else(|| "that version's content is no longer in this folder's history".to_string()))
}

/// One version's text, for the preview.
pub async fn versions_read(core: &Arc<Core>, root: String, hash: String) -> Result<String, String> {
    version_text(core, &root, &hash).await
}

/// A unified diff between two versions. A null hash means the file on disk,
/// which is how the newest version is compared against now.
pub async fn versions_diff(
    core: &Arc<Core>,
    root: String,
    path: Option<String>,
    from: Option<String>,
    to: Option<String>,
) -> Result<String, String> {
    let side = |hash: Option<String>| async {
        match hash {
            Some(hash) => version_text(core, &root, &hash).await,
            None => {
                let on_disk = path.clone().ok_or_else(|| "there's no file to compare with".to_string())?;
                let kind = core.device_kind.clone();
                tokio::task::spawn_blocking(move || history::read_disk(Path::new(&on_disk), &kind))
                    .await
                    .map_err(|_| "that comparison didn't finish".to_string())?
            }
        }
    };
    let before = side(from).await?;
    let after = side(to).await?;
    history::diff_texts(&before, &after)
}

/// What restoring one snapshot would do to the folder as it is now — the
/// three lists the workspace timeline shows before anything happens.
pub async fn versions_snapshot_diff(core: &Arc<Core>, root: String, ts: u64) -> Result<SnapshotDiff, String> {
    let tx = sender_for(core, &root)?;
    ask(tx, |reply| VersionerCmd::SnapshotDiff { ts, reply }).await?
}

/// Every file this folder's history holds and the folder itself does not —
/// *Recently deleted*, newest sighting first.
pub async fn versions_deleted(core: &Arc<Core>, root: String) -> Result<Vec<DeletedFile>, String> {
    let tx = sender_for(core, &root)?;
    ask(tx, |reply| VersionerCmd::Deleted { reply }).await?
}

/// Put a whole moment back — or the part of it the user ticked. Like the
/// file restore it captures the state it leaves first, so the whole thing
/// is undone by restoring `preRestoreTs` with the same paths.
pub async fn versions_restore_snapshot(
    core: &Arc<Core>,
    root: String,
    ts: u64,
    paths: Option<Vec<String>>,
) -> Result<RestoreReport, String> {
    let tx = sender_for(core, &root)?;
    let core = core.clone();
    ask(tx, move |reply| VersionerCmd::RestoreSnapshot { core, ts, paths, reply }).await?
}

/* ---------- Settings: the horizons, the stores, the export ---------- */

/// How far back this folder keeps, `null` for forever. Written into the
/// store's own index — a folder the user has never answered for follows
/// settings.json's default — and applied at once.
pub async fn versions_set_horizon(core: &Arc<Core>, root: String, days: Option<u32>) -> Result<(), String> {
    let tx = sender_for(core, &root)?;
    ask(tx, |reply| VersionerCmd::SetHorizon { days, reply }).await?
}

/// How far back the *bucket* keeps. One CAS on the cloud index, because a
/// horizon every device disagreed about would be no horizon at all.
pub async fn versions_set_cloud_horizon(core: &Arc<Core>, root: String, days: Option<u32>) -> Result<(), String> {
    crate::cloud::set_cloud_horizon(core, &root, days).await
}

/// Every version store on this Mac, whether or not its folder is open —
/// what *Other folders* lists, and where the space goes.
pub async fn versions_stores(core: &Arc<Core>) -> Result<Vec<StoreInfo>, String> {
    let data_dir = with_inner(core, |inner| Ok(inner.data_dir.clone()))?;
    tokio::task::spawn_blocking(move || stores::list(&data_dir))
        .await
        .map_err(|_| "That list didn't finish.".to_string())
}

/// Delete one store outright. Refused while its folder is open: a running
/// versioner holds an index it would write back a moment later, and the
/// user asked to forget the history, not to restart it.
pub async fn versions_forget(core: &Arc<Core>, key: String) -> Result<(), String> {
    let (data_dir, open) = with_inner(core, |inner| {
        let open: BTreeSet<String> = inner.versioners.values().map(|handle| handle.store.key.clone()).collect();
        Ok((inner.data_dir.clone(), open))
    })?;
    tokio::task::spawn_blocking(move || stores::forget(&data_dir, &key, &open))
        .await
        .map_err(|_| "That didn't finish.".to_string())?
}

/// One archive holding the folder as it is now and its whole history, written
/// into `dest`. The answer to "what if the cloud goes away": plain tar.gz,
/// readable by anything, with no Doklin needed to open it.
pub async fn versions_export(core: &Arc<Core>, root: String, dest: String) -> Result<ExportReport, String> {
    let store = store_for(core, &root)?;
    let day = chrono::Local::now().format("%Y-%m-%d").to_string();
    let events = core.events();
    let for_event = root.clone();
    tokio::task::spawn_blocking(move || {
        stores::export(Path::new(&root), &store, Path::new(&dest), &day, &|done, total| {
            events.emit_json(EV_PROGRESS, serde_json::json!({ "root": for_event, "done": done, "total": total }));
        })
        .map(|(_path, report)| report)
    })
    .await
    .map_err(|_| "That export didn't finish.".to_string())?
}

/// Put an earlier version back. The content is named either by `hash` (a
/// version in this store) or by `text` (one only the cloud still holds);
/// `ts` is the version's own, and the snapshot this makes records it as
/// where the content came from.
pub async fn versions_restore_file(
    core: &Arc<Core>,
    root: String,
    path: String,
    ts: Option<u64>,
    hash: Option<String>,
    text: Option<String>,
) -> Result<RestoreOutcome, String> {
    let tx = sender_for(core, &root)?;
    // A version this store does not hold the bytes of — one from before the
    // document was shared — is restored as the text it was.
    let text = match (&text, &hash) {
        (None, Some(hash)) if !store_for(core, &root)?.has_blob(hash) => Some(version_text(core, &root, hash).await?),
        _ => text,
    };
    let core = core.clone();
    ask(tx, move |reply| VersionerCmd::RestoreFile {
        core,
        path: PathBuf::from(path),
        from_ts: ts,
        hash,
        text,
        reply,
    })
    .await?
}
