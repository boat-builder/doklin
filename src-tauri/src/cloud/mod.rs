//! The cloud: one domain per workspace, one engine per connected workspace,
//! the engine as the only writer. This file is the
//! manager — the engines, their watchers, the edit-bus routes, `cloud.json`
//! and the folder marker — and the Tauri commands the frontend calls
//! (mirrored in src/cloud.ts). The engine itself is engine.rs; what it
//! says to the worker is remote.rs; the flows that run before an engine
//! exists are flows.rs.
//!
//! ```text
//! mod.rs        the manager, the commands, init at boot
//! engine.rs     Engine<R>: the cycle, fold_public, presence, history, status
//! manifest.rs   the wire types (manifest v2, the public map) + their grammar
//! remote.rs     the Remote trait; HttpRemote (the real worker)
//! flows.rs      bind + upload, download, wipe — generic, tested
//! invite.rs     the invite code and the paste blob — the grammar, and the
//!               only place a code is ever in the clear
//! merge.rs      the three-way merge and conflict copies
//! scan.rs       the local walk, hashing, atomic writes
//! bus.rs        the edit bus (every write command → the engine)
//! config.rs     cloud.json, the marker, endpoints and names
//! status.rs     the status/event contract
//! tests.rs      the in-memory worker and the two-device matrix
//! versions.rs   the version store's mirror: upload, the cloud ladder, reads
//! ```

pub mod bus;
mod config;
mod engine;
mod flows;
mod invite;
mod manifest;
mod merge;
mod remote;
// The versioner reuses the local walk, the hashing and the atomic write
// (scan) and the event sink (status) — see src/versions/.
pub(crate) mod scan;
pub(crate) mod status;
#[cfg(test)]
mod tests;
pub(crate) mod versions;

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
use engine::{Engine, EngineCmd, EngineConfig, Exit, PublishRequest};
use manifest::{clean_name, PublicKind};
use remote::{HttpRemote, Remote as _};
use scan::{rel_path, write_json};
use status::{
    emit_statuses, snapshot, AgentAdded, AgentLogin, AppEvents, CloudStatus, Credentials, Events, Invited, People,
    Probe, Redeemed, Removed, StatusTable, EV_REMOVED,
};

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

/// The name this Mac signs work with: the cloud identity's when there is
/// one (so a device that renamed itself keeps signing as it always has),
/// else the Mac's display name. The versions store's `by` comes from here
/// too — a snapshot is attributed the same way a revision is.
pub(crate) fn device_name(data_dir: &Path) -> String {
    read_cloud_file(data_dir)
        .device
        .map(|d| d.name)
        .filter(|n| !n.is_empty())
        .unwrap_or_else(device_display_name)
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
    /// Every workspace taken off this Mac since the app started
    /// (`access_removed`). An event says so as it happens, but an engine can
    /// hear it on first contact — before any window is listening — so a
    /// window also asks for this list once it is up (`cloud_removed`).
    removed: Vec<Removed>,
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
        removed: Vec::new(),
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
            data_dir: inner.data_dir.clone(),
            device_id: inner.device.id.clone(),
            device_name: inner.device.name.clone(),
            use_trash: true,
            creator: ws.creator,
            on_creator: (!ws.creator).then(|| {
                let (app, root) = (inner.app.clone(), ws.root.clone());
                Box::new(move || mark_creator(&app, &root)) as Box<dyn Fn() + Send + Sync>
            }),
        },
        Arc::new(HttpRemote::new(&ws.endpoint, &ws.token, &inner.device.id)),
        Arc::new(AppEvents(inner.app.clone())),
        inner.statuses.clone(),
    );
    // The one way an engine ends by itself: the domain said this Mac's access
    // was taken away. The engine stops there and touches nothing; taking the
    // workspace off this Mac is the manager's, because the manager is what
    // holds everything that has to go with it.
    let (app, entry) = (inner.app.clone(), ws.clone());
    tauri::async_runtime::spawn(async move {
        if engine.run(cmd_rx, fs_rx).await == Exit::Removed {
            access_removed(app, entry).await;
        }
    });

    if let Some(bus) = inner.app.try_state::<EditBus>() {
        bus.register(root.clone(), cmd_tx.clone());
    }
    inner.engines.insert(ws.root.clone(), EngineHandle { tx: cmd_tx, root, _watcher: watcher });
}

/// Write down that this Mac holds the domain's own token for the workspace at
/// `root` — what its engine just heard from the domain (`EngineConfig::
/// on_creator`). From then on that folder is never deleted on a `removed`
/// answer, whatever answers at that address later.
fn mark_creator(app: &AppHandle, root: &str) {
    let _ = with_inner(app, |inner| {
        let mut file = read_cloud_file(&inner.data_dir);
        if let Some(entry) = file.workspaces.iter_mut().find(|w| w.root == root) {
            entry.creator = true;
        }
        write_cloud_file(&inner.data_dir, &file)
    });
}

/// Take a workspace off this Mac, because an owner took this Mac's access to
/// it away. What goes: the
/// folder — outright, not to the Trash — and everything Doklin kept for it
/// here: the credential, the sync state, the local version history. What is
/// touched in the cloud: nothing.
///
/// Reached only from an engine that heard `RemoteError::Removed`, which the
/// worker says of a credential it remembers an owner removing and of nothing
/// else — never of an outage, a wiped domain or a rotated secret.
async fn access_removed(app: AppHandle, entry: WorkspaceEntry) {
    // Forget it first, under the lock: no engine, no watcher, no credential.
    let forgotten = with_inner(&app, |inner| {
        let mut file = read_cloud_file(&inner.data_dir);
        // Only if this is still the connection that engine was syncing. A
        // folder disconnected and connected again since holds a credential
        // of its own, and that one was not removed. And never the creator's:
        // the engine does not end this way for one (`heard_removed`), and
        // this is the same rule, asked of what is written down.
        if !file.by_root(&entry.root).is_some_and(|held| held.token == entry.token && !held.creator) {
            return Ok(None);
        }
        stop_engine(inner, &entry.root);
        file.remove_root(&entry.root);
        write_cloud_file(&inner.data_dir, &file)?;
        emit_statuses(&AppEvents(inner.app.clone()), &inner.statuses);
        Ok(Some(inner.data_dir.clone()))
    });
    let Ok(Some(data_dir)) = forgotten else { return };

    let root = PathBuf::from(&entry.root);
    // Found while the folder still exists: a store's key is the folder's
    // canonical path.
    let store_dir = crate::versions::store_for_root(&data_dir, &root).dir;
    let home = app.path().home_dir().ok();
    let copy = entry.clone();
    let deleted = tokio::task::spawn_blocking(move || remove_copy(&copy, home.as_deref())).await.unwrap_or(false);
    crate::versions::forget_root(&app, &entry.root, store_dir).await;
    let _ = std::fs::remove_dir_all(state_dir(&data_dir, &entry.ws_id));

    // Said twice, on purpose: the event reaches the windows that are
    // listening now, and the list answers one that was not up yet — an
    // engine hears this on first contact, which can beat the first window.
    let removed = Removed { root: entry.root, name: entry.name, domain: entry.domain, deleted, at: scan::now_ms() };
    let _ = with_inner(&app, |inner| {
        inner.removed.push(removed.clone());
        Ok(())
    });
    AppEvents(app).emit_json(EV_REMOVED, serde_json::to_value(&removed).unwrap_or_default());
}

/// Delete this Mac's copy of a workspace — the folder and everything in it,
/// outright. True when no folder is left at that path.
///
/// Deleting a tree is the one thing here that cannot be taken back, so the
/// folder has to say it is that workspace: it must carry the marker
/// `cloud_join` and `cloud_connect` wrote into it, naming this domain and
/// this workspace id. A folder that does not — replaced by something else
/// since, or stripped of its marker — is left alone, and so is any path wide
/// enough to hold the home folder.
fn remove_copy(entry: &WorkspaceEntry, home: Option<&Path>) -> bool {
    let root = Path::new(&entry.root);
    if !root.exists() {
        return true;
    }
    // The folder itself, wherever the path leads: a root reached through a
    // symlink is the directory behind it, and removing only the link would
    // leave every file where it was.
    let Ok(real) = std::fs::canonicalize(root) else { return false };
    let is_that_workspace =
        read_marker(&real).is_some_and(|marker| marker.ws_id == entry.ws_id && marker.domain == entry.domain);
    // Asked of the path as it was written and as it resolves, against the
    // home folder both ways: on macOS one of a pair is often spelled through
    // a symlink (`/var` for `/private/var`) and the other is not.
    let home_real = home.and_then(|home| std::fs::canonicalize(home).ok());
    let holds_home = |dir: &Path| {
        home.is_some_and(|home| home.starts_with(dir)) || home_real.as_deref().is_some_and(|home| home.starts_with(dir))
    };
    let too_wide = real.parent().is_none() || holds_home(root) || holds_home(&real);
    if !is_that_workspace || too_wide {
        return false;
    }
    if std::fs::remove_dir_all(&real).is_err() {
        return false;
    }
    // What is left at the path when it was a link: the link, now dangling.
    if root.is_symlink() {
        let _ = std::fs::remove_file(root);
    }
    !root.exists() && !root.is_symlink()
}

/// Where a workspace this Mac joins is kept: `~/Doklin`, one folder per
/// workspace. Visible, so the files are the
/// user's to find in Finder; fixed, so joining never stops to ask where.
fn join_parent(home: &Path) -> PathBuf {
    home.join("Doklin")
}

/// The folder a workspace called `name` downloads into under `parent`: its
/// own name — or, when a folder of that name is already there with something
/// in it, the name and the first number that is free ("Notes 2").
fn free_folder(parent: &Path, name: &str) -> PathBuf {
    let base = sanitize_folder_name(name);
    let free = |dir: &Path| !dir.exists() || std::fs::read_dir(dir).map(|mut d| d.next().is_none()).unwrap_or(false);
    let mut dest = parent.join(&base);
    let mut n = 2u32;
    while !free(&dest) {
        dest = parent.join(format!("{} {}", base, n));
        n += 1;
    }
    dest
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
        // A workspace that left this folder earlier in this run is not the
        // one arriving now: a window that asks what was removed must not be
        // told to let go of it (`cloud_removed`).
        inner.removed.retain(|gone| gone.root != entry.root);
        spawn_engine(inner, &entry);
        Ok(())
    })
}

/// What a command aimed at one connected workspace opens with: the credential
/// that workspace holds, already wrapped in a remote, beside the two things
/// every sentence about it needs — the domain's name and this Mac's identity.
struct WorkspaceCall {
    remote: HttpRemote,
    endpoint: String,
    domain: String,
    device: DeviceIdentity,
}

fn workspace_call(app: &AppHandle, root: &str) -> Result<WorkspaceCall, String> {
    let (endpoint, token, domain, device) = with_inner(app, |inner| {
        let file = read_cloud_file(&inner.data_dir);
        let entry = file.by_root(root).ok_or_else(|| "that workspace isn't connected".to_string())?;
        Ok((entry.endpoint.clone(), entry.token.clone(), entry.domain.clone(), inner.device.clone()))
    })?;
    let remote = HttpRemote::new(&endpoint, &token, &device.id);
    Ok(WorkspaceCall { remote, endpoint, domain, device })
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

/// Split one paste into the two halves of an invite — the address and the
/// code — so the redeem screen fills both boxes from whatever arrived: the
/// line as it was sent, the whole chat message around it, or one half on its
/// own. Pure: it touches no domain and no file.
#[tauri::command]
pub(crate) fn cloud_parse_invite(text: String) -> invite::Pasted {
    invite::parse_pasted(&text)
}

/// Trade an invite code for this Mac's own credential.
///
/// The one command that runs before this Mac holds any credential at all,
/// which inverts the order every other entrance uses: redeem first, then
/// probe with what the redeem minted. An invitee cannot ask a domain
/// anything until they have a token, because `/api/meta` is inside the gate
/// and `POST /api/auth/join` is the only route above it.
///
/// It writes nothing and spawns nothing: `cloud_join` with the token this
/// answers is the second Mac's flow, unchanged.
#[tauri::command]
pub(crate) async fn cloud_redeem(app: AppHandle, endpoint: String, code: String) -> Result<Redeemed, String> {
    let endpoint = normalize_endpoint(&endpoint)?;
    let domain = domain_of(&endpoint).unwrap_or_else(|| endpoint.clone());
    let Some(canonical) = invite::normalize_code(&code) else {
        return Err("that isn't a Doklin invite code — one looks like dkln-K7QM2-9XVR4-8TBHN-3WGYD".into());
    };
    let device = with_inner(&app, |inner| Ok(inner.device.clone()))?;
    // No token, on purpose: there is none yet, and the route that answers
    // this is the one above the worker's auth gate.
    let remote = HttpRemote::new(&endpoint, "", &device.id);
    let redeemed = remote.redeem(&canonical, &device.name).await.map_err(|e| describe_redeem(&domain, e))?;
    Ok(Redeemed {
        endpoint,
        token: redeemed.token,
        member_id: redeemed.member.id,
        email: redeemed.member.email,
        name: redeemed.member.name,
    })
}

/// A failed redeem in words. `Unauthorized` is the one that carries weight:
/// the worker answers unknown and expired identically on purpose — a caller
/// learns whether a code works, never whether it once existed or whom it was
/// for — so this sentence has to cover both without guessing between them.
fn describe_redeem(domain: &str, e: remote::RemoteError) -> String {
    match e {
        remote::RemoteError::Unauthorized => {
            "that invite code doesn't work — it may have been used already, or run out. Ask for a fresh one.".into()
        }
        remote::RemoteError::Outdated(_) | remote::RemoteError::NotFound => {
            format!("{} runs a worker too old to take invites — whoever set it up needs to update it", domain)
        }
        other => flows::describe(domain, other.into()),
    }
}

/// Ask a domain what it is before touching anything: the worker's version
/// and whether it already holds a workspace.
#[tauri::command]
pub(crate) async fn cloud_probe(app: AppHandle, endpoint: String, token: String) -> Result<Probe, String> {
    let endpoint = normalize_endpoint(&endpoint)?;
    let domain = domain_of(&endpoint).unwrap_or_else(|| endpoint.clone());
    let device = with_inner(&app, |inner| Ok(inner.device.clone()))?;
    let remote = HttpRemote::new(&endpoint, token.trim(), &device.id);
    let meta = remote.meta().await.map_err(|e| flows::describe(&domain, e.into()))?;
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

/// Invite someone to this workspace by email (owner only): the code is
/// minted here, hashed here, and only its sha256 goes up — a worker log, a
/// database backup and the request body are all incapable of letting anyone
/// in. The code comes back once, in the answer, and nothing stores it.
///
/// Re-inviting an address reaches the same person: their row is found by
/// their email, and the invite they had stops working the moment this one is
/// made. That is what "they lost the code" costs — one call, same member.
#[tauri::command]
pub(crate) async fn cloud_invite(
    app: AppHandle,
    root: String,
    email: String,
    name: Option<String>,
    days: Option<u32>,
) -> Result<Invited, String> {
    let call = workspace_call(&app, &root)?;
    let canonical = invite::random_code();
    let code = invite::format_code(&canonical);
    let record = call
        .remote
        .create_invite(
            email.trim(),
            name.as_deref().map(str::trim).filter(|n| !n.is_empty()),
            &invite::code_hash(&canonical),
            invite::expires_at(scan::now_ms(), days),
        )
        .await
        .map_err(|e| describe_people(&call.domain, e))?;

    Ok(Invited { blob: invite::blob(&call.endpoint, &code), code, invite: record })
}

/// Who is on this workspace, who this Mac is among them and what it may do
/// about it — the whole People view in one answer, so
/// the panel never draws half a roster.
#[tauri::command]
pub(crate) async fn cloud_people(app: AppHandle, root: String) -> Result<People, String> {
    let call = workspace_call(&app, &root)?;
    let people = people_of(&call.remote, &call.device.id, &call.domain).await?;
    // The engine learned what this Mac may do when it last probed, and a role
    // can have changed since. Whoever opens this view is looking at the
    // answer; have the engine ask again, so the rest of the panel agrees.
    let _ = with_inner(&app, |inner| {
        if let Some(handle) = inner.engines.get(&root) {
            let _ = handle.tx.send(EngineCmd::Probe);
        }
        Ok(())
    });
    Ok(people)
}

/// The creator saying who they are — once, and only here. Identity,
/// never authority: the domain's env secret is what authenticates them either
/// way, so this row is what puts a name in the People list, and losing it
/// costs a name rather than access. Only the Mac that holds that secret is
/// answered; everybody else already is somebody.
#[tauri::command]
pub(crate) async fn cloud_adopt_owner(
    app: AppHandle,
    root: String,
    email: String,
    name: Option<String>,
) -> Result<remote::MemberRecord, String> {
    let call = workspace_call(&app, &root)?;
    call.remote
        .adopt_owner(email.trim(), name.as_deref().map(str::trim).filter(|n| !n.is_empty()))
        .await
        .map_err(|e| describe_people(&call.domain, e))
}

/// The workspaces taken off this Mac since the app started — what a window
/// asks once it is up, in case one left before it was listening
/// (`access_removed`). Never drained: every window asks for itself, and each
/// knows which of these it has already shown.
#[tauri::command]
pub(crate) fn cloud_removed(app: AppHandle) -> Result<Vec<Removed>, String> {
    with_inner(&app, |inner| Ok(inner.removed.clone()))
}

/// Make someone an owner, or a member again (an owner's to do). Every Mac
/// they are signed in on carries the new role on its next request. The
/// domain refuses the caller's own row and the creator's, and its sentence
/// says which.
#[tauri::command]
pub(crate) async fn cloud_set_role(
    app: AppHandle,
    root: String,
    member_id: String,
    role: String,
) -> Result<remote::MemberRecord, String> {
    let call = workspace_call(&app, &root)?;
    call.remote.set_member_role(&member_id, &role).await.map_err(|e| describe_people(&call.domain, e))
}

/// Take a person off this workspace: their row, the invite they had and every
/// Mac they signed in on, in one batch. Each of those Macs is refused on its
/// very next request — the bearer resolves through the table the batch
/// emptied, so there is no session left to expire — and, told why, deletes
/// its copy of the workspace (`access_removed`).
#[tauri::command]
pub(crate) async fn cloud_revoke_person(app: AppHandle, root: String, member_id: String) -> Result<(), String> {
    let call = workspace_call(&app, &root)?;
    revoked(&call.domain, call.remote.delete_member(&member_id).await)
}

/// Sign one Mac out, leaving the person and their other Macs alone; that Mac
/// deletes its copy when it hears. What is named here is not the credential —
/// the domain never had it in the clear — it is the row that resolves it.
#[tauri::command]
pub(crate) async fn cloud_revoke_device(app: AppHandle, root: String, token_id: String) -> Result<(), String> {
    let call = workspace_call(&app, &root)?;
    revoked(&call.domain, call.remote.delete_token(&token_id).await)
}

/// Withdraw a code nobody has traded in yet. The person's row stays: they
/// were invited, not signed in, and inviting them again reaches it.
#[tauri::command]
pub(crate) async fn cloud_withdraw_invite(app: AppHandle, root: String, invite_id: String) -> Result<(), String> {
    let call = workspace_call(&app, &root)?;
    revoked(&call.domain, call.remote.delete_invite(&invite_id).await)
}

/// The People view's whole answer: who this Mac is, then the lists its role
/// may read.
///
/// Generic over the remote so the in-memory worker can prove the part that
/// carries the design: what a Mac may do is asked of the domain every time
/// the view opens, never remembered. `cloud.json` holds a credential, not a
/// claim about one — a role is the person's, and an owner can change it while
/// this Mac is asleep. Each list is asked for only when `you.can` says it
/// will be answered, so a member's view costs no refusals.
async fn people_of<R: remote::Remote>(remote: &R, device_id: &str, domain: &str) -> Result<People, String> {
    let meta = remote.meta().await.map_err(|e| describe_people(domain, e))?;
    if !meta.features.iter().any(|f| f == "roles") {
        // Without the role table there is no telling what to offer, and
        // guessing would draw buttons the domain refuses.
        return Err(format!(
            "{} runs a worker too old to say who may do what here — whoever set the domain up needs to update it",
            domain
        ));
    }
    let you = meta.you.unwrap_or_default();
    let may = |action: &str| you.can.iter().any(|held| held == action);
    let (members, invites, devices) = tokio::try_join!(
        async { if may("people.see") { remote.list_members().await } else { Ok(Vec::new()) } },
        async { if may("people.invite") { remote.list_invites().await } else { Ok(Vec::new()) } },
        async { if may("people.remove") { remote.list_tokens().await } else { Ok(Vec::new()) } },
    )
    .map_err(|e| describe_people(domain, e))?;
    Ok(People {
        role: you.role,
        creator: you.creator,
        me: you.member_id,
        can: you.can,
        device_id: device_id.to_string(),
        token_id: you.token_id,
        members,
        invites,
        devices,
    })
}

/// A failed people call in words. The arm that earns its place is `NotFound`:
/// a worker predating the identity routes has no `/api/auth` to miss, so it
/// 404s — which `flows::describe` would otherwise read as "that domain holds
/// no workspace yet", which is both wrong and unactionable.
fn describe_people(domain: &str, e: remote::RemoteError) -> String {
    match e {
        remote::RemoteError::NotFound => {
            format!("{} runs a worker too old to hold people — update it from the Cloud panel", domain)
        }
        other => flows::describe(domain, other.into()),
    }
}

/// A revocation's answer, where `NotFound` is success: the row is gone, which
/// is what was asked for. It cannot be the old worker `describe_people`
/// blames for a 404 either — a Remove button only exists on a list that route
/// answered.
fn revoked(domain: &str, r: remote::RemoteResult<()>) -> Result<(), String> {
    match r {
        Ok(()) | Err(remote::RemoteError::NotFound) => Ok(()),
        Err(e) => Err(describe_people(domain, e)),
    }
}

/* ---------- Agents ---------- */

/// A fresh login code and the line that carries it. The code is minted and
/// hashed here, exactly as an invite's is: only its sha256 goes up, so a
/// worker log, a database backup and the request body are all incapable of
/// logging anything in.
fn mint_agent_login(endpoint: &str) -> (AgentLogin, String) {
    let canonical = invite::random_code();
    let code = invite::format_agent_code(&canonical);
    let login = AgentLogin {
        line: invite::agent_login_line(endpoint, &code),
        code,
        expires_at: invite::agent_code_expires_at(scan::now_ms()),
    };
    (login, invite::code_hash(&canonical))
}

/// A failed agent call in words. As with people, the arm that earns its
/// place is `NotFound`: a worker that predates agents has no such route.
fn describe_agents(domain: &str, e: remote::RemoteError) -> String {
    match e {
        remote::RemoteError::NotFound => {
            format!("{} runs a worker too old for agents — update it from the Cloud panel", domain)
        }
        other => flows::describe(domain, other.into()),
    }
}

/// The permissions as the worker spells them, with nothing it would refuse.
fn clean_scopes(scopes: Vec<String>) -> Vec<String> {
    const KNOWN: [&str; 4] = ["read", "comment", "edit", "publish"];
    KNOWN.iter().filter(|k| **k == "read" || scopes.iter().any(|s| s == *k)).map(|k| k.to_string()).collect()
}

/// Every agent on this workspace (owner only): what each may do, the
/// machines it is logged in on, and whether a login code is still waiting.
#[tauri::command]
pub(crate) async fn cloud_agents(app: AppHandle, root: String) -> Result<Vec<remote::AgentRecord>, String> {
    let call = workspace_call(&app, &root)?;
    call.remote.list_agents().await.map_err(|e| describe_agents(&call.domain, e))
}

/// Add an agent (owner only) and mint the code its first machine logs in
/// with. The line comes back once, in the answer, and nothing stores it.
#[tauri::command]
pub(crate) async fn cloud_agent_add(
    app: AppHandle,
    root: String,
    name: String,
    scopes: Vec<String>,
) -> Result<AgentAdded, String> {
    let call = workspace_call(&app, &root)?;
    let name = name.trim();
    if name.is_empty() {
        return Err("give the agent a name — it is what its comments and changes are signed with".into());
    }
    let (login, hash) = mint_agent_login(&call.endpoint);
    let agent = call
        .remote
        .create_agent(name, &clean_scopes(scopes), &hash, login.expires_at)
        .await
        .map_err(|e| describe_agents(&call.domain, e))?;
    Ok(AgentAdded { agent, login })
}

/// A new login code for an agent that exists — for another machine, or
/// because the first one ran out. Whatever code it had stops working.
#[tauri::command]
pub(crate) async fn cloud_agent_code(app: AppHandle, root: String, agent_id: String) -> Result<AgentLogin, String> {
    let call = workspace_call(&app, &root)?;
    let (login, hash) = mint_agent_login(&call.endpoint);
    call.remote
        .new_agent_code(&agent_id, &hash, login.expires_at)
        .await
        .map_err(|e| describe_agents(&call.domain, e))?;
    Ok(login)
}

/// Rename an agent, or change what it may do. The agent finds out on its
/// next request: its permissions are read off its row every time.
#[tauri::command]
pub(crate) async fn cloud_agent_update(
    app: AppHandle,
    root: String,
    agent_id: String,
    name: Option<String>,
    scopes: Option<Vec<String>>,
) -> Result<(), String> {
    let call = workspace_call(&app, &root)?;
    let name = name.as_deref().map(str::trim).filter(|n| !n.is_empty());
    let scopes = scopes.map(clean_scopes);
    call.remote
        .update_agent(&agent_id, name, scopes.as_deref())
        .await
        .map_err(|e| describe_agents(&call.domain, e))
}

/// Remove an agent: its row, its pending code and every machine it is
/// logged in on. Each of them is refused on its very next request.
#[tauri::command]
pub(crate) async fn cloud_agent_remove(app: AppHandle, root: String, agent_id: String) -> Result<(), String> {
    let call = workspace_call(&app, &root)?;
    agent_gone(&call.domain, call.remote.delete_agent(&agent_id).await)
}

/// Log one machine out, leaving the agent and its other machines alone.
#[tauri::command]
pub(crate) async fn cloud_agent_revoke_machine(
    app: AppHandle,
    root: String,
    agent_id: String,
    token_id: String,
) -> Result<(), String> {
    let call = workspace_call(&app, &root)?;
    agent_gone(&call.domain, call.remote.delete_agent_machine(&agent_id, &token_id).await)
}

/// A removal's answer, where `NotFound` is success — the row is gone, which
/// is what was asked for (see `revoked`).
fn agent_gone(domain: &str, r: remote::RemoteResult<()>) -> Result<(), String> {
    match r {
        Ok(()) | Err(remote::RemoteError::NotFound) => Ok(()),
        Err(e) => Err(describe_agents(domain, e)),
    }
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

    // Whether this Mac is the creator is the domain's to say: the engine's
    // first probe asks, a moment from now, and writes it down.
    record_and_spawn(&app, WorkspaceEntry { root, domain, endpoint, ws_id: ws_id.clone(), name, token, creator: false })?;
    Ok(ws_id)
}

/// Download a domain's workspace into `~/Doklin/<name>` and start syncing it
/// — how a Mac joins a workspace, whether somebody invited it or it is
/// another Mac of the creator's. No folder is asked for (`join_parent`).
/// Answers the new folder's path.
#[tauri::command]
pub(crate) async fn cloud_join(app: AppHandle, endpoint: String, token: String) -> Result<String, String> {
    let endpoint = normalize_endpoint(&endpoint)?;
    let domain = domain_of(&endpoint).unwrap_or_else(|| endpoint.clone());
    let token = token.trim().to_string();
    let home = app.path().home_dir().map_err(|e| format!("couldn't find your home folder: {}", e))?;
    let parent = join_parent(&home);
    let (data_dir, device) = with_inner(&app, |inner| Ok((inner.data_dir.clone(), inner.device.clone())))?;

    let remote = Arc::new(HttpRemote::new(&endpoint, &token, &device.id));
    let meta = remote.meta().await.map_err(|e| flows::describe(&domain, e.into()))?;
    let creator = meta.you.as_ref().is_some_and(|you| you.creator);
    let Some(workspace) = meta.workspace else {
        return Err(flows::describe(&domain, flows::FlowError::NotBound));
    };
    std::fs::create_dir_all(&parent).map_err(|e| format!("create {}: {}", parent.display(), e))?;
    let dest = free_folder(&parent, &workspace.name);
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
        WorkspaceEntry {
            root: root.clone(),
            domain,
            endpoint,
            ws_id: workspace.id,
            name: workspace.name,
            token,
            creator,
        },
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
    let meta = remote.meta().await.map_err(|e| flows::describe(&domain, e.into()))?;
    let creator = meta.you.as_ref().is_some_and(|you| you.creator);
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
        WorkspaceEntry { root, domain, endpoint, ws_id: workspace.id.clone(), name: workspace.name, token, creator },
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

/// *Take over* on a document another Mac holds: the
/// engine for `root` claims it on its next beat, from whoever has it. Advisory
/// like the lease itself — the Mac it is taken from goes view-only on its next
/// poll, and anything both typed in between merges as any overlap does.
#[tauri::command]
pub(crate) fn cloud_take_over(app: AppHandle, root: String, path: String) -> Result<(), String> {
    with_inner(&app, |inner| {
        if let Some(h) = inner.engines.get(&root) {
            let _ = h.tx.send(EngineCmd::TakeOver(path));
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

/// The cloud version store's index for the workspace holding `path` — what
/// the history rail merges with this Mac's own snapshots. `Ok(None)` when
/// the workspace is connected to a worker that has no `versions` feature.
pub(crate) async fn versions_index_for(
    app: &AppHandle,
    path: &str,
) -> Result<Option<crate::cloud::versions::VersionsIndex>, String> {
    let (tx, _rel) = with_inner(app, |inner| {
        route(inner, path).ok_or_else(|| "that folder isn't a connected workspace".to_string())
    })?;
    ask(tx, |reply| EngineCmd::VersionsIndex { reply }).await
}

/// How far back the bucket keeps for this workspace — a CAS on the cloud
/// index, so it is one answer for every device rather than a per-Mac
/// setting. Errors when the workspace isn't connected: there is no bucket to
/// set a horizon on.
pub(crate) async fn set_cloud_horizon(app: &AppHandle, root: &str, days: Option<u32>) -> Result<(), String> {
    let root = root.to_string();
    let tx = with_inner(app, |inner| {
        inner.engines.get(&root).map(|h| h.tx.clone()).ok_or_else(|| "That folder isn't connected.".to_string())
    })?;
    ask(tx, |reply| EngineCmd::SetCloudHorizon { days, reply }).await
}

/// One mirrored snapshot, downloaded and cached if this Mac hasn't seen it.
pub(crate) async fn version_snapshot(
    app: &AppHandle,
    path: &str,
    id: &str,
) -> Result<crate::versions::store::Snapshot, String> {
    let (tx, _rel) = with_inner(app, |inner| {
        route(inner, path).ok_or_else(|| "that folder isn't a connected workspace".to_string())
    })?;
    let id = id.to_string();
    ask(tx, move |reply| EngineCmd::VersionSnapshot { id, reply }).await
}

/// One mirrored version's content, for a document whose blob this Mac's
/// store no longer holds (or never did).
pub(crate) async fn version_blob(app: &AppHandle, path: &str, hash: &str) -> Result<Vec<u8>, String> {
    let (tx, _rel) = with_inner(app, |inner| {
        route(inner, path).ok_or_else(|| "that folder isn't a connected workspace".to_string())
    })?;
    let hash = hash.to_string();
    ask(tx, move |reply| EngineCmd::VersionBlob { hash, reply }).await
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
