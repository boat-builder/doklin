//! Versioning (docs/versioning.md): every open folder gets a local store
//! that captures snapshots on the cadence rule, thins them on the retention
//! ladder, and never deletes anything anywhere else. This file is the
//! manager — one versioner task per open root plus the drafts folder, the
//! routing table the edit bus writes into, and the Tauri commands
//! (mirrored in src/versions.ts).
//!
//! ```text
//! mod.rs        the manager, the versioner task, the commands, init at boot
//! store.rs      the store on disk: the index, snapshot files, blobs, gzip
//! capture.rs    the cadence state machine and the scan that takes a snapshot
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
mod retain;
mod settings;
mod status;
mod store;
#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use notify::Watcher as _;
use tauri::{AppHandle, Manager};
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use crate::cloud::scan::{rel_for_touch, MAX_SYNC_ENTRIES};
use crate::cloud::status::{AppEvents, Events};

use capture::{Cadence, CaptureError};
use retain::SWEEP_EVERY;
use settings::{read_settings, write_settings, Settings};
use status::{emit_statuses, Phase, SnapshotMeta, StatusTable, StoreBytes, VersionsStatus};
use store::{store_key, versions_dir, FileEntry, Index, Reason, SnapshotRow, Store};

/// The folder holding drafts is a root like any workspace, under a fixed
/// key — so the one thing in the app with nowhere else to live has a
/// history too.
pub const DRAFTS_KEY: &str = "drafts";

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
    by: String,
    enabled: bool,
    horizon_days: Option<u32>,
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
            by,
            enabled: settings.enabled,
            horizon_days: settings.horizon_days,
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
                self.error = Some(format!(
                    "this folder holds more than {} files — too large to keep versions of",
                    MAX_SYNC_ENTRIES
                ));
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

    /// The ladder, applied. `force` runs it whatever the clock says (at
    /// start); otherwise it runs at most every `SWEEP_EVERY`.
    fn sweep(&mut self, force: bool) {
        let now = self.clock.now_ms();
        let due = now.saturating_sub(self.index.last_sweep_ms) >= SWEEP_EVERY.as_millis() as u64;
        if !force && !due {
            return;
        }
        let mut index = std::mem::take(&mut self.index);
        let report = retain::sweep(&self.store, &mut index, now, self.horizon_days);
        self.index = index;
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

    fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
        self.phase = if enabled { Phase::Idle } else { Phase::Disabled };
        self.error = None;
        self.refresh_status();
    }

    fn snapshots(&self) -> Vec<SnapshotMeta> {
        self.index.snapshots.iter().rev().map(SnapshotMeta::from).collect()
    }

    fn status(&self) -> VersionsStatus {
        VersionsStatus {
            root: self.store.root.to_string_lossy().to_string(),
            key: self.store.key.clone(),
            phase: self.phase,
            error: self.error.clone(),
            snapshots: self.index.snapshots.len() as u64,
            oldest_ms: self.index.snapshots.first().map(|s| s.ts),
            newest_ms: self.index.newest().map(|s| s.ts),
            last_capture_ms: Some(self.index.last_capture_ms).filter(|ms| *ms > 0),
            bytes: StoreBytes { blobs: self.bytes.0, snapshots: self.bytes.1 },
            horizon_days: self.horizon_days,
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
    SetEnabled(bool),
    /// Capture what is pending and answer — the quit flush.
    Flush {
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
                Some(VersionerCmd::Flush { reply }) => {
                    if cadence.is_dirty() {
                        blocking(&state, |v| { v.capture(Reason::Closing, None); }).await;
                        cadence.captured(Instant::now());
                    }
                    let _ = reply.send(());
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
    root: PathBuf,
    tx: mpsc::UnboundedSender<VersionerCmd>,
}

/// One row per running versioner, as Tauri state — so a write command
/// reaches it without touching the manager's lock. The cloud's edit bus is
/// the same shape; both filter with `cloud::scan::rel_for_touch`.
#[derive(Default)]
pub struct VersionBus {
    routes: RwLock<Vec<Route>>,
}

impl VersionBus {
    fn register(&self, root: PathBuf, tx: mpsc::UnboundedSender<VersionerCmd>) {
        if let Ok(mut routes) = self.routes.write() {
            routes.retain(|r| r.root != root);
            routes.push(Route { root, tx });
        }
    }

    fn unregister(&self, root: &Path) {
        if let Ok(mut routes) = self.routes.write() {
            routes.retain(|r| r.root != root);
        }
    }

    /// Route a touched absolute path to the versioner whose root contains it
    /// (the deepest, should roots ever nest). Returns whether one did.
    pub fn touch(&self, path: &Path) -> bool {
        let Ok(routes) = self.routes.read() else { return false };
        let Some(route) = routes
            .iter()
            .filter(|r| path.starts_with(&r.root))
            .max_by_key(|r| r.root.as_os_str().len())
        else {
            return false;
        };
        let Some(rel) = rel_for_touch(&route.root, path) else { return false };
        route.tx.send(VersionerCmd::Touched(rel)).is_ok()
    }
}

/// Half of `edits::touched`. A no-op before the manager exists, or for a
/// path under no open root.
pub(crate) fn touched(app: &AppHandle, path: &str) {
    if let Some(bus) = app.try_state::<VersionBus>() {
        bus.touch(Path::new(path));
    }
}

/* ---------- The manager ---------- */

struct VersionerHandle {
    tx: mpsc::UnboundedSender<VersionerCmd>,
    root: PathBuf,
    /// The store this versioner owns; no two may share one.
    key: String,
    // Held so the folder watcher lives exactly as long as the versioner.
    _watcher: Option<notify_debouncer_full::Debouncer<notify::RecommendedWatcher, notify_debouncer_full::FileIdMap>>,
}

struct ManagerInner {
    app: AppHandle,
    data_dir: PathBuf,
    /// The name a snapshot is attributed to.
    by: String,
    settings: Settings,
    /// Keyed by the display root.
    versioners: HashMap<String, VersionerHandle>,
    statuses: StatusTable,
}

#[derive(Default)]
pub struct VersionsManager {
    inner: Mutex<Option<ManagerInner>>,
}

/// Called once from tauri's setup, after `cloud::init`: read the settings,
/// then start a versioner for every root already open (and for drafts).
pub(crate) fn init(app: &AppHandle) {
    let Ok(data_dir) = app.path().app_data_dir() else { return };
    let _ = std::fs::create_dir_all(versions_dir(&data_dir));
    let settings = read_settings(&data_dir);
    let by = crate::cloud::device_name(&data_dir);

    let inner = ManagerInner {
        app: app.clone(),
        data_dir,
        by,
        settings,
        versioners: HashMap::new(),
        statuses: Arc::new(Mutex::new(Default::default())),
    };
    if let Ok(mut guard) = app.state::<VersionsManager>().inner.lock() {
        *guard = Some(inner);
    }
    reconcile(app);
}

/// Which folders are open, from the window registry — plus the drafts
/// directory, which is always one. Called whenever a window reports its
/// content and when one is destroyed, so no new frontend call is needed to
/// start or stop a versioner.
fn open_roots(app: &AppHandle) -> BTreeSet<String> {
    let mut roots = BTreeSet::new();
    if let Some(registry) = app.try_state::<crate::WindowRegistry>() {
        if let Ok(map) = registry.0.lock() {
            for content in map.values() {
                if let Some(folder) = content.folder.as_ref().filter(|f| !f.is_empty()) {
                    roots.insert(folder.clone());
                }
            }
        }
    }
    if let Ok(data_dir) = app.path().app_data_dir() {
        let drafts = data_dir.join("drafts");
        let _ = std::fs::create_dir_all(&drafts);
        roots.insert(drafts.to_string_lossy().to_string());
    }
    roots
}

/// Bring the running versioners in line with what is open.
pub(crate) fn reconcile(app: &AppHandle) {
    let open = open_roots(app);
    let _ = with_inner(app, |inner| {
        let stale: Vec<String> = inner.versioners.keys().filter(|root| !open.contains(*root)).cloned().collect();
        for root in stale {
            stop_versioner(inner, &root);
        }
        for root in &open {
            if !inner.versioners.contains_key(root) {
                start_versioner(inner, root);
            }
        }
        Ok(())
    });
}

fn start_versioner(inner: &mut ManagerInner, display_root: &str) {
    let root = PathBuf::from(display_root);
    if !root.is_dir() {
        return;
    }
    // A store never versions itself, and nothing versions the folder the
    // stores live in.
    let stores = versions_dir(&inner.data_dir);
    if root.starts_with(&stores) || stores.starts_with(&root) {
        return;
    }
    let key = if root == inner.data_dir.join("drafts") { DRAFTS_KEY.to_string() } else { store_key(&root) };
    // One store, one versioner. Two windows on the same folder are one root
    // and never get here; two spellings of one path (a symlink, a `..`)
    // would, and two tasks writing one index would lose rows to each other.
    if inner.versioners.values().any(|h| h.key == key) {
        return;
    }

    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<VersionerCmd>();
    let (fs_tx, fs_rx) = mpsc::unbounded_channel::<()>();

    // The same recursive watcher the engine uses, for the same reason: an
    // edit made outside the app still ends a session.
    let watch_root = root.clone();
    let watcher = notify_debouncer_full::new_debouncer(
        Duration::from_millis(500),
        None,
        move |result: notify_debouncer_full::DebounceEventResult| {
            if result.is_ok() {
                let _ = fs_tx.send(());
            }
        },
    )
    .ok()
    .and_then(|mut w| {
        w.watcher().watch(&watch_root, notify::RecursiveMode::Recursive).ok()?;
        w.cache().add_root(&watch_root, notify::RecursiveMode::Recursive);
        Some(w)
    });
    if watcher.is_none() {
        eprintln!("versions: no filesystem watcher for {} — capturing on the edit bus alone", display_root);
    }

    let versioner = Versioner::new(
        Store::open(&inner.data_dir, &key, &root),
        inner.by.clone(),
        &inner.settings,
        inner.statuses.clone(),
        Arc::new(AppEvents(inner.app.clone())),
        Clock::wall(),
    );
    tauri::async_runtime::spawn(run(Arc::new(Mutex::new(versioner)), cmd_rx, fs_rx));

    if let Some(bus) = inner.app.try_state::<VersionBus>() {
        bus.register(root.clone(), cmd_tx.clone());
    }
    inner
        .versioners
        .insert(display_root.to_string(), VersionerHandle { tx: cmd_tx, root, key, _watcher: watcher });
}

/// Stop the versioner for `root` — it captures the session's last state on
/// the way out — and forget its status row.
fn stop_versioner(inner: &mut ManagerInner, root: &str) {
    let Some(handle) = inner.versioners.remove(root) else { return };
    let _ = handle.tx.send(VersionerCmd::Shutdown);
    if let Some(bus) = inner.app.try_state::<VersionBus>() {
        bus.unregister(&handle.root);
    }
    if let Ok(mut table) = inner.statuses.lock() {
        table.remove(root);
    }
    emit_statuses(&AppEvents(inner.app.clone()), &inner.statuses);
}

fn with_inner<T>(app: &AppHandle, f: impl FnOnce(&mut ManagerInner) -> Result<T, String>) -> Result<T, String> {
    let manager = app.state::<VersionsManager>();
    let mut guard = manager.inner.lock().map_err(|_| "the versions manager is wedged".to_string())?;
    let inner = guard.as_mut().ok_or_else(|| "versions aren't ready yet".to_string())?;
    f(inner)
}

fn sender_for(app: &AppHandle, root: &str) -> Result<mpsc::UnboundedSender<VersionerCmd>, String> {
    with_inner(app, |inner| {
        inner
            .versioners
            .get(root)
            .map(|h| h.tx.clone())
            .ok_or_else(|| "that folder has no version store yet".to_string())
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

/// Capture whatever is pending everywhere, within `deadline` — the last
/// thing that happens before the app exits, so a session that ends mid-edit
/// still ends in a snapshot. Blocks the caller; runs on the main thread at
/// quit, never inside the async runtime.
pub(crate) fn flush_all_blocking(app: &AppHandle, deadline: Duration) {
    let mut waiting = Vec::new();
    let _ = with_inner(app, |inner| {
        for handle in inner.versioners.values() {
            let (reply, rx) = oneshot::channel();
            if handle.tx.send(VersionerCmd::Flush { reply }).is_ok() {
                waiting.push(rx);
            }
        }
        Ok(())
    });
    if waiting.is_empty() {
        return;
    }
    tauri::async_runtime::block_on(async move {
        let _ = tokio::time::timeout(deadline, futures_util::future::join_all(waiting)).await;
    });
}

/* ---------- Tauri commands ---------- */

/// Every version store's status — the frontend's whole model.
#[tauri::command]
pub(crate) fn versions_status(app: AppHandle) -> Result<Vec<VersionsStatus>, String> {
    with_inner(&app, |inner| Ok(status::snapshot(&inner.statuses)))
}

/// A folder's retained snapshots, newest first.
#[tauri::command]
pub(crate) async fn versions_snapshots(app: AppHandle, root: String) -> Result<Vec<SnapshotMeta>, String> {
    let tx = sender_for(&app, &root)?;
    ask(tx, |reply| VersionerCmd::Snapshots { reply }).await
}

/// Capture now, whatever the cadence says. A `manual` capture (the default)
/// is pinned and may carry a name; the answer is null when the folder is
/// already exactly what the newest snapshot holds and no name was given.
#[tauri::command]
pub(crate) async fn versions_capture_now(
    app: AppHandle,
    root: String,
    reason: Option<String>,
    label: Option<String>,
) -> Result<Option<SnapshotMeta>, String> {
    let reason = match reason.as_deref() {
        None => Reason::Manual,
        Some(name) => Reason::parse(name).ok_or_else(|| format!("\"{}\" isn't a kind of snapshot", name))?,
    };
    let tx = sender_for(&app, &root)?;
    ask(tx, |reply| VersionerCmd::CaptureNow { reason, label, reply }).await?
}

/// Keep a version out of the ladder's reach, and optionally name it.
#[tauri::command]
pub(crate) async fn versions_set_pinned(
    app: AppHandle,
    root: String,
    ts: u64,
    pinned: bool,
    label: Option<String>,
) -> Result<(), String> {
    let tx = sender_for(&app, &root)?;
    ask(tx, |reply| VersionerCmd::SetPinned { ts, pinned, label, reply }).await?
}

/// The kill switch. Nothing already captured is touched; capture simply
/// stops until it is turned back on.
#[tauri::command]
pub(crate) fn versions_set_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    with_inner(&app, |inner| {
        inner.settings.enabled = enabled;
        write_settings(&inner.data_dir, &inner.settings)?;
        for handle in inner.versioners.values() {
            let _ = handle.tx.send(VersionerCmd::SetEnabled(enabled));
        }
        Ok(())
    })
}
