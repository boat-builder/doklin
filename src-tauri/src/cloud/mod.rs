//! The cloud: one domain per workspace, one engine per connected workspace,
//! the engine as the only writer (docs/cloud.md). This file is the
//! manager — the engines, their watchers, the edit-bus routes, `cloud.json`
//! and the folder marker — and the Tauri commands the frontend calls
//! (§6.7; mirrored in src/cloud.ts). The engine itself is engine.rs; what it
//! says to the worker is remote.rs; the flows that run before an engine
//! exists are flows.rs.
//!
//! ```text
//! mod.rs        the manager, the commands, init at boot
//! engine.rs     Engine<R>: the cycle, fold_public, presence, history, status
//! manifest.rs   the wire types (manifest v2, the public map) + their grammar
//! remote.rs     the Remote trait; HttpRemote (the real worker)
//! flows.rs      bind + upload, download, wipe — generic, tested
//! merge.rs      the three-way merge and conflict copies
//! scan.rs       the local walk, hashing, atomic writes
//! bus.rs        the edit bus (every write command → the engine)
//! config.rs     cloud.json, the marker, endpoints and names
//! status.rs     the status/event contract
//! tests.rs      the in-memory worker and the two-device matrix
//! ```

pub mod bus;
mod config;
mod engine;
mod flows;
mod manifest;
mod merge;
mod remote;
mod scan;
mod status;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::Watcher as _;
use tauri::{AppHandle, Manager};
use tokio::sync::{mpsc, oneshot};

pub use bus::{touched, EditBus};
pub use config::device_display_name;

use config::{
    domain_of, ensure_device, normalize_endpoint, read_cloud_file, read_marker, remove_marker, sanitize_folder_name,
    state_dir, write_cloud_file, write_marker, DeviceIdentity, Marker, WorkspaceEntry,
};
use engine::{Engine, EngineCmd, EngineConfig, PublishRequest};
use manifest::{clean_name, PublicKind};
use remote::HttpRemote;
use scan::{rel_path, write_json};
use status::{emit_statuses, snapshot, AppEvents, CloudStatus, Credentials, Events, Probe, Revision, StatusTable};

/// The worker version this app was built against, parsed out of
/// cloud-worker/src/version.ts by build.rs — the number the update badge
/// compares a domain's `/api/meta` against.
pub const BUNDLED_WORKER_VERSION: u32 = parse_u32(env!("DOKLIN_WORKER_VERSION"));

/// A decimal integer, at compile time (build.rs hands the versions over as
/// strings).
pub(crate) const fn parse_u32(s: &str) -> u32 {
    let bytes = s.as_bytes();
    assert!(!bytes.is_empty(), "empty version");
    let mut i = 0;
    let mut n: u32 = 0;
    while i < bytes.len() {
        let b = bytes[i];
        assert!(b >= b'0' && b <= b'9', "version is not a decimal integer");
        n = n * 10 + (b - b'0') as u32;
        i += 1;
    }
    n
}

/* ---------- The manager ---------- */

struct EngineHandle {
    tx: mpsc::UnboundedSender<EngineCmd>,
    root: PathBuf,
    // Held so the recursive watcher lives exactly as long as the engine.
    // None when the watcher couldn't start: the bus and the poll still
    // carry the engine.
    _watcher: Option<notify_debouncer_full::Debouncer<notify::RecommendedWatcher, notify_debouncer_full::FileIdMap>>,
}

struct ManagerInner {
    app: AppHandle,
    data_dir: PathBuf,
    device: DeviceIdentity,
    /// Keyed by root.
    engines: HashMap<String, EngineHandle>,
    statuses: StatusTable,
    /// What each window is editing (absolute path), with a sequence number
    /// so the freshest report wins when two windows share a workspace.
    activity: HashMap<String, (Option<String>, u64)>,
    activity_seq: u64,
}

#[derive(Default)]
pub struct CloudManager {
    inner: Mutex<Option<ManagerInner>>,
}

/// Called once from tauri's setup: load cloud.json, mint a device identity
/// on first run, spawn an engine per connected workspace.
pub(crate) fn init(app: &AppHandle) {
    let Ok(data_dir) = app.path().app_data_dir() else { return };
    let _ = std::fs::create_dir_all(&data_dir);

    let mut file = read_cloud_file(&data_dir);
    let device = ensure_device(&data_dir, &mut file);

    let mut inner = ManagerInner {
        app: app.clone(),
        data_dir,
        device,
        engines: HashMap::new(),
        statuses: Arc::new(Mutex::new(Default::default())),
        activity: HashMap::new(),
        activity_seq: 0,
    };
    for ws in &file.workspaces {
        spawn_engine(&mut inner, ws);
    }

    let manager = app.state::<CloudManager>();
    *manager.inner.lock().unwrap() = Some(inner);
}

fn spawn_engine(inner: &mut ManagerInner, ws: &WorkspaceEntry) {
    let root = PathBuf::from(&ws.root);
    let state_dir = state_dir(&inner.data_dir, &ws.ws_id);
    let _ = std::fs::create_dir_all(state_dir.join("base"));

    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<EngineCmd>();
    let (fs_tx, fs_rx) = mpsc::unbounded_channel::<()>();

    // Recursive workspace watcher (external editors, git, Finder): any
    // debounced event just pokes the engine; the engine's scan decides what
    // actually changed.
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
        w.watcher().watch(&root, notify::RecursiveMode::Recursive).ok()?;
        w.cache().add_root(&root, notify::RecursiveMode::Recursive);
        Some(w)
    });
    if watcher.is_none() {
        eprintln!("cloud: no filesystem watcher for {} — syncing on the edit bus and the poll", ws.root);
    }

    let engine = Engine::new(
        EngineConfig {
            ws_id: ws.ws_id.clone(),
            name: ws.name.clone(),
            root: root.clone(),
            domain: ws.domain.clone(),
            endpoint: ws.endpoint.clone(),
            state_dir,
            device_id: inner.device.id.clone(),
            device_name: inner.device.name.clone(),
            use_trash: true,
        },
        Arc::new(HttpRemote::new(&ws.endpoint, &ws.token, &inner.device.id)),
        Arc::new(AppEvents(inner.app.clone())),
        inner.statuses.clone(),
    );
    tauri::async_runtime::spawn(engine.run(cmd_rx, fs_rx));

    if let Some(bus) = inner.app.try_state::<EditBus>() {
        bus.register(root.clone(), cmd_tx.clone());
    }
    inner.engines.insert(ws.root.clone(), EngineHandle { tx: cmd_tx, root, _watcher: watcher });
}

/// Stop the engine for `root` (its presence beat clears on the way out) and
/// forget its status row. True when there was one.
fn stop_engine(inner: &mut ManagerInner, root: &str) -> bool {
    let Some(handle) = inner.engines.remove(root) else { return false };
    let _ = handle.tx.send(EngineCmd::Shutdown);
    if let Some(bus) = inner.app.try_state::<EditBus>() {
        bus.unregister(&handle.root);
    }
    if let Ok(mut table) = inner.statuses.lock() {
        table.remove(root);
    }
    true
}

fn with_inner<T>(app: &AppHandle, f: impl FnOnce(&mut ManagerInner) -> Result<T, String>) -> Result<T, String> {
    let manager = app.state::<CloudManager>();
    let mut guard = manager.inner.lock().map_err(|_| "cloud manager poisoned".to_string())?;
    let inner = guard.as_mut().ok_or_else(|| "the cloud engine isn't ready yet".to_string())?;
    f(inner)
}

fn events_of(app: &AppHandle) -> Arc<dyn Events> {
    Arc::new(AppEvents(app.clone()))
}

/// The engine whose root contains `path`, with the path made relative.
fn route(inner: &ManagerInner, path: &str) -> Option<(mpsc::UnboundedSender<EngineCmd>, String)> {
    let p = Path::new(path);
    let handle = inner
        .engines
        .values()
        .filter(|h| p.starts_with(&h.root))
        .max_by_key(|h| h.root.as_os_str().len())?;
    let rel = rel_path(&handle.root, p)?;
    Some((handle.tx.clone(), rel))
}

/// Ask an engine something and wait for its answer.
async fn ask<T>(
    tx: mpsc::UnboundedSender<EngineCmd>,
    make: impl FnOnce(oneshot::Sender<Result<T, String>>) -> EngineCmd,
) -> Result<T, String> {
    let (reply_tx, reply_rx) = oneshot::channel();
    tx.send(make(reply_tx)).map_err(|_| "that workspace's engine has stopped".to_string())?;
    reply_rx.await.map_err(|_| "that workspace's engine has stopped".to_string())?
}

/// Refuse a root that is (or contains, or lies inside) a connected one.
fn check_root_free(inner: &ManagerInner, root: &Path) -> Result<(), String> {
    for h in inner.engines.values() {
        if h.root == root || root.starts_with(&h.root) || h.root.starts_with(root) {
            return Err("this folder (or one containing it) is already connected".into());
        }
    }
    let file = read_cloud_file(&inner.data_dir);
    if file.by_root(&root.to_string_lossy()).is_some() {
        return Err("this folder is already connected".into());
    }
    Ok(())
}

fn check_domain_free(inner: &ManagerInner, domain: &str, root: &Path) -> Result<(), String> {
    let file = read_cloud_file(&inner.data_dir);
    if let Some(w) = file.workspaces.iter().find(|w| w.domain == domain) {
        if Path::new(&w.root) != root {
            return Err(format!("{} is already connected to \"{}\" on this Mac", domain, w.root));
        }
    }
    Ok(())
}

fn record_and_spawn(app: &AppHandle, entry: WorkspaceEntry) -> Result<(), String> {
    with_inner(app, |inner| {
        let mut file = read_cloud_file(&inner.data_dir);
        ensure_device(&inner.data_dir, &mut file);
        file.upsert(entry.clone());
        write_cloud_file(&inner.data_dir, &file)?;
        stop_engine(inner, &entry.root);
        spawn_engine(inner, &entry);
        Ok(())
    })
}

/* ---------- Tauri commands ---------- */

/// Every connected workspace's status — the frontend's whole model.
#[tauri::command]
pub(crate) fn cloud_status(app: AppHandle) -> Result<Vec<CloudStatus>, String> {
    with_inner(&app, |inner| Ok(snapshot(&inner.statuses)))
}

/// 32 random bytes, hex: the owner token the setup wizard hands the agent.
#[tauri::command]
pub(crate) fn cloud_mint_token() -> String {
    scan::random_token()
}

/// Ask a domain what it is before touching anything: the worker's version
/// and whether it already holds a workspace.
#[tauri::command]
pub(crate) async fn cloud_probe(app: AppHandle, endpoint: String, token: String) -> Result<Probe, String> {
    let endpoint = normalize_endpoint(&endpoint)?;
    let domain = domain_of(&endpoint).unwrap_or_else(|| endpoint.clone());
    let device = with_inner(&app, |inner| Ok(inner.device.clone()))?;
    let remote = HttpRemote::new(&endpoint, token.trim(), &device.id);
    let meta = remote::Remote::meta(&remote).await.map_err(|e| flows::describe(&domain, e.into()))?;
    Ok(Probe {
        worker_version: meta.version,
        bundled_version: BUNDLED_WORKER_VERSION,
        features: meta.features,
        workspace: meta.workspace,
    })
}

/// The marker a folder carries, if any — what the setup wizard reads to
/// offer "resume syncing this folder" when a domain already holds the
/// workspace the folder is.
#[tauri::command]
pub(crate) fn cloud_marker(root: String) -> Option<Marker> {
    read_marker(Path::new(&root))
}

/// The endpoint and the owner token of a connected workspace — what a
/// second Mac needs to download it ("Connect another Mac…" in the panel).
#[tauri::command]
pub(crate) fn cloud_token(app: AppHandle, root: String) -> Result<Credentials, String> {
    with_inner(&app, |inner| {
        let file = read_cloud_file(&inner.data_dir);
        let entry = file.by_root(&root).ok_or_else(|| "that workspace isn't connected".to_string())?;
        Ok(Credentials { endpoint: entry.endpoint.clone(), token: entry.token.clone() })
    })
}

/// Ask the engine to probe the worker again — "Check again" after an
/// update. The fresh version lands in the next `cloud-status`.
#[tauri::command]
pub(crate) fn cloud_check_worker(app: AppHandle, root: String) -> Result<(), String> {
    with_inner(&app, |inner| {
        if let Some(h) = inner.engines.get(&root) {
            let _ = h.tx.send(EngineCmd::Probe);
        }
        Ok(())
    })
}

/// Connect a folder to a fresh domain: bind, upload everything, remember
/// the pair (cloud.json + the marker), start the engine. Answers the
/// workspace id.
#[tauri::command]
pub(crate) async fn cloud_connect(
    app: AppHandle,
    root: String,
    endpoint: String,
    token: String,
    name: String,
) -> Result<String, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err("that folder doesn't exist".into());
    }
    let endpoint = normalize_endpoint(&endpoint)?;
    let domain = domain_of(&endpoint).unwrap_or_else(|| endpoint.clone());
    let token = token.trim().to_string();
    let (data_dir, device) = with_inner(&app, |inner| {
        check_root_free(inner, &root_path)?;
        check_domain_free(inner, &domain, &root_path)?;
        Ok((inner.data_dir.clone(), inner.device.clone()))
    })?;
    if let Some(marker) = read_marker(&root_path) {
        if marker.domain != domain {
            return Err(format!(
                "this folder already belongs to {} — resume it there, or disconnect it first",
                marker.domain
            ));
        }
    }
    let folder_name = root_path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let name = clean_name(&name, if folder_name.is_empty() { "Notes" } else { &folder_name });

    let remote = Arc::new(HttpRemote::new(&endpoint, &token, &device.id));
    let bound = flows::bind_domain(&remote, &name, &device.name)
        .await
        .map_err(|e| flows::describe(&domain, e))?;
    let ws_id = bound.workspace.id.clone();
    // The marker goes down the moment the domain is ours: a connect that
    // dies mid-upload leaves a folder that can be resumed, not a bound
    // domain nothing remembers.
    write_marker(&root_path, &Marker { domain: domain.clone(), ws_id: ws_id.clone() })?;

    let sdir = state_dir(&data_dir, &ws_id);
    let _ = std::fs::remove_dir_all(&sdir);
    let events = events_of(&app);
    let state = flows::seed_upload(&remote, &root_path, &sdir, &name, &bound.manifest_etag, &device.name, &events, &root)
        .await
        .map_err(|e| flows::describe(&domain, e))?;
    write_json(&sdir.join("state.json"), &state).map_err(|e| format!("save the sync state: {}", e))?;

    record_and_spawn(&app, WorkspaceEntry { root, domain, endpoint, ws_id: ws_id.clone(), name, token })?;
    Ok(ws_id)
}

/// Download a domain's workspace into `<dest_parent>/<name>` and start
/// syncing it — the second Mac's flow. Answers the new folder's path.
#[tauri::command]
pub(crate) async fn cloud_join(
    app: AppHandle,
    endpoint: String,
    token: String,
    dest_parent: String,
) -> Result<String, String> {
    let endpoint = normalize_endpoint(&endpoint)?;
    let domain = domain_of(&endpoint).unwrap_or_else(|| endpoint.clone());
    let token = token.trim().to_string();
    let parent = PathBuf::from(&dest_parent);
    if !parent.is_dir() {
        return Err("pick a folder to download into".into());
    }
    let (data_dir, device) = with_inner(&app, |inner| Ok((inner.data_dir.clone(), inner.device.clone())))?;

    let remote = Arc::new(HttpRemote::new(&endpoint, &token, &device.id));
    let meta = remote::Remote::meta(remote.as_ref()).await.map_err(|e| flows::describe(&domain, e.into()))?;
    let Some(workspace) = meta.workspace else {
        return Err(flows::describe(&domain, flows::FlowError::NotBound));
    };
    let dest = parent.join(sanitize_folder_name(&workspace.name));
    let root = dest.to_string_lossy().to_string();
    with_inner(&app, |inner| {
        check_root_free(inner, &dest)?;
        check_domain_free(inner, &domain, &dest)
    })?;

    let sdir = state_dir(&data_dir, &workspace.id);
    let _ = std::fs::remove_dir_all(&sdir);
    let events = events_of(&app);
    let state = flows::seed_download(&remote, &dest, &sdir, &events)
        .await
        .map_err(|e| flows::describe(&domain, e))?;
    write_json(&sdir.join("state.json"), &state).map_err(|e| format!("save the sync state: {}", e))?;
    write_marker(&dest, &Marker { domain: domain.clone(), ws_id: workspace.id.clone() })?;

    record_and_spawn(
        &app,
        WorkspaceEntry { root: root.clone(), domain, endpoint, ws_id: workspace.id, name: workspace.name, token },
    )?;
    Ok(root)
}

/// A folder carrying the marker of the workspace this domain holds — a
/// reinstall, a restore from a backup — adopts it in place: the engine
/// starts from empty state, and its first cycle reconciles file by file.
/// Answers the workspace id.
#[tauri::command]
pub(crate) async fn cloud_resume(
    app: AppHandle,
    root: String,
    endpoint: String,
    token: String,
) -> Result<String, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err("that folder doesn't exist".into());
    }
    let endpoint = normalize_endpoint(&endpoint)?;
    let domain = domain_of(&endpoint).unwrap_or_else(|| endpoint.clone());
    let token = token.trim().to_string();
    let (data_dir, device) = with_inner(&app, |inner| {
        check_root_free(inner, &root_path)?;
        check_domain_free(inner, &domain, &root_path)?;
        Ok((inner.data_dir.clone(), inner.device.clone()))
    })?;
    let Some(marker) = read_marker(&root_path) else {
        return Err("this folder carries no cloud marker — download the workspace into a new folder instead".into());
    };
    if marker.domain != domain {
        return Err(format!("this folder belongs to {}, not {}", marker.domain, domain));
    }

    let remote = HttpRemote::new(&endpoint, &token, &device.id);
    let meta = remote::Remote::meta(&remote).await.map_err(|e| flows::describe(&domain, e.into()))?;
    let Some(workspace) = meta.workspace else {
        return Err(flows::describe(&domain, flows::FlowError::NotBound));
    };
    if workspace.id != marker.ws_id {
        return Err(format!(
            "{} now holds a different workspace (\"{}\") than this folder came from",
            domain, workspace.name
        ));
    }

    let sdir = state_dir(&data_dir, &workspace.id);
    let _ = std::fs::remove_dir_all(&sdir);
    let _ = std::fs::create_dir_all(sdir.join("base"));
    record_and_spawn(
        &app,
        WorkspaceEntry { root, domain, endpoint, ws_id: workspace.id.clone(), name: workspace.name, token },
    )?;
    Ok(workspace.id)
}

/// Forget a workspace on this Mac: the engine stops, the entry and the
/// sync state go; the folder, its marker and the cloud stay.
#[tauri::command]
pub(crate) fn cloud_disconnect(app: AppHandle, root: String) -> Result<(), String> {
    with_inner(&app, |inner| {
        stop_engine(inner, &root);
        let mut file = read_cloud_file(&inner.data_dir);
        let ws_id = file.by_root(&root).map(|w| w.ws_id.clone());
        file.remove_root(&root);
        write_cloud_file(&inner.data_dir, &file)?;
        if let Some(ws_id) = ws_id {
            let _ = std::fs::remove_dir_all(state_dir(&inner.data_dir, &ws_id));
        }
        emit_statuses(&AppEvents(inner.app.clone()), &inner.statuses);
        Ok(())
    })
}

#[tauri::command]
pub(crate) fn cloud_sync_now(app: AppHandle, root: String) -> Result<(), String> {
    with_inner(&app, |inner| {
        if let Some(h) = inner.engines.get(&root) {
            let _ = h.tx.send(EngineCmd::SyncNow);
        }
        Ok(())
    })
}

#[tauri::command]
pub(crate) fn cloud_pause(app: AppHandle, root: String, paused: bool) -> Result<(), String> {
    with_inner(&app, |inner| {
        if let Some(h) = inner.engines.get(&root) {
            let _ = h.tx.send(EngineCmd::Pause(paused));
        }
        Ok(())
    })
}

/// The user confirmed a mass deletion was intentional — let it propagate.
#[tauri::command]
pub(crate) fn cloud_confirm_deletes(app: AppHandle, root: String) -> Result<(), String> {
    with_inner(&app, |inner| {
        if let Some(h) = inner.engines.get(&root) {
            let _ = h.tx.send(EngineCmd::ConfirmDeletes);
        }
        Ok(())
    })
}

/// A window reports which document it is editing (or none). Every engine
/// then hears the freshest path any window is editing under its root — so
/// a second window switching to a draft doesn't clear the first one's
/// presence.
#[tauri::command]
pub(crate) fn cloud_set_activity(
    app: AppHandle,
    window: tauri::Window,
    path: Option<String>,
) -> Result<(), String> {
    with_inner(&app, |inner| {
        inner.activity_seq += 1;
        let seq = inner.activity_seq;
        inner.activity.insert(window.label().to_string(), (path, seq));
        for h in inner.engines.values() {
            let freshest = inner
                .activity
                .values()
                .filter_map(|(p, seq)| p.as_ref().map(|p| (p, *seq)))
                .filter(|(p, _)| Path::new(p).starts_with(&h.root))
                .max_by_key(|(_, seq)| *seq)
                .map(|(p, _)| p.clone());
            let _ = h.tx.send(EngineCmd::SetActivity(freshest));
        }
        Ok(())
    })
}

/// Publish a file or a folder (`path` decides which — a directory publishes
/// as a folder page). Answers the slug; the page is queued and rides the
/// next won CAS, so publishing works offline.
#[tauri::command]
pub(crate) async fn cloud_publish(
    app: AppHandle,
    path: String,
    slug: Option<String>,
    title: Option<String>,
    desc: Option<String>,
) -> Result<String, String> {
    let kind = if Path::new(&path).is_dir() { PublicKind::Dir } else { PublicKind::File };
    let (tx, rel) = with_inner(&app, |inner| {
        route(inner, &path).ok_or_else(|| "that path isn't in a connected workspace".to_string())
    })?;
    ask(tx, |reply| EngineCmd::Publish { req: PublishRequest { rel, kind, slug, title, desc }, reply }).await
}

#[tauri::command]
pub(crate) async fn cloud_unpublish(app: AppHandle, root: String, slug: String) -> Result<(), String> {
    let tx = with_inner(&app, |inner| {
        inner.engines.get(&root).map(|h| h.tx.clone()).ok_or_else(|| "that workspace isn't connected".to_string())
    })?;
    ask(tx, |reply| EngineCmd::Unpublish { slug, reply }).await
}

/// Make a published page the one at `/` (or, with no slug, have none).
#[tauri::command]
pub(crate) async fn cloud_set_root(app: AppHandle, root: String, slug: Option<String>) -> Result<(), String> {
    let tx = with_inner(&app, |inner| {
        inner.engines.get(&root).map(|h| h.tx.clone()).ok_or_else(|| "that workspace isn't connected".to_string())
    })?;
    ask(tx, |reply| EngineCmd::SetRoot { slug, reply }).await
}

/// Every revision of a document, newest first — for the History panel.
#[tauri::command]
pub(crate) async fn cloud_history(app: AppHandle, path: String) -> Result<Vec<Revision>, String> {
    let (tx, rel) = with_inner(&app, |inner| {
        route(inner, &path).ok_or_else(|| "that document isn't in a connected workspace".to_string())
    })?;
    ask(tx, |reply| EngineCmd::History { rel, reply }).await
}

/// One revision's text.
#[tauri::command]
pub(crate) async fn cloud_revision(app: AppHandle, path: String, hash: String) -> Result<String, String> {
    let (tx, rel) = with_inner(&app, |inner| {
        route(inner, &path).ok_or_else(|| "that document isn't in a connected workspace".to_string())
    })?;
    ask(tx, |reply| EngineCmd::Revision { rel, hash, reply }).await
}

/// Erase everything on the workspace's domain (owner only) — the step that
/// frees the domain before the teardown prompt — then forget the workspace
/// on this Mac, marker included: no engine may re-upload into a domain the
/// user just emptied. Answers how many objects were purged.
#[tauri::command]
pub(crate) async fn cloud_wipe(app: AppHandle, root: String) -> Result<u64, String> {
    let (entry, device) = with_inner(&app, |inner| {
        let file = read_cloud_file(&inner.data_dir);
        let entry = file.by_root(&root).cloned().ok_or_else(|| "that workspace isn't connected".to_string())?;
        stop_engine(inner, &root);
        Ok((entry, inner.device.clone()))
    })?;
    let remote = Arc::new(HttpRemote::new(&entry.endpoint, &entry.token, &device.id));
    let purged = flows::wipe_all(&remote).await.map_err(|e| flows::describe(&entry.domain, e));
    match purged {
        Ok(n) => {
            remove_marker(Path::new(&root));
            cloud_disconnect(app, root)?;
            Ok(n)
        }
        Err(e) => {
            // The wipe didn't happen: bring the engine back.
            with_inner(&app, |inner| {
                spawn_engine(inner, &entry);
                Ok(())
            })?;
            Err(e)
        }
    }
}
