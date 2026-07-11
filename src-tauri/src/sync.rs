//! Cloud sync engine.
//!
//! Bidirectional, state-based sync between a local workspace folder and the
//! user's share worker (see share-worker/README.md for the wire contract).
//! Disk stays the source of truth; the remote side is a per-workspace
//! manifest (updated by compare-and-swap on its R2 etag) plus immutable,
//! content-addressed blobs — so concurrent writers can never clobber each
//! other's bytes, and every revision stays retrievable for version history.
//!
//! Concurrency model ("soft mode", the only mode): edits to different files
//! always converge; concurrent edits to the same file get a three-way text
//! merge against the last-synced base, and genuinely overlapping edits fall
//! back to a conflict copy next to the original — nothing is ever lost.
//! Presence heartbeats ("Alice is editing…") make that rare in practice.
//!
//! One `Engine` task runs per synced workspace: a recursive watcher and a
//! poll interval both funnel into `cycle()`, which is deliberately the only
//! place local and remote state reconcile. The engine is generic over
//! [`Remote`] so the whole merge/conflict/tombstone machinery is exercised
//! in tests against an in-memory backend that mimics the worker's CAS.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use notify::Watcher as _;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

/* ---------- Tunables ---------- */

/// Mirrors the worker's caps (and the app's own tree caps) so the engine
/// never builds a workspace the other side would reject.
const MAX_SYNC_FILE_BYTES: u64 = 25 * 1024 * 1024;
const MAX_SYNC_ENTRIES: usize = 5000;
const MAX_SYNC_DEPTH: usize = 12;
/// How much per-file history rides inline in the manifest; older entries roll
/// into the per-file archive object (worker cap: 200).
const MANIFEST_HIST_MAX: usize = 10;
const ARCHIVE_HIST_MAX: usize = 200;
/// Poll cadence. Saves also trigger cycles through the watcher, so this is
/// the ceiling on how stale a quiet workspace can get, not the feel of sync.
const POLL_INTERVAL: Duration = Duration::from_secs(15);
/// Local filesystem events are batched this long before a cycle runs — long
/// enough to coalesce an autosave burst (600ms debounce upstream) into one
/// revision, short enough to still feel immediate.
const FS_SETTLE: Duration = Duration::from_millis(5000);
/// Presence heartbeat cadence + how recent activity must be to keep beating.
const PRESENCE_BEAT: Duration = Duration::from_secs(25);
const ACTIVITY_FRESH: Duration = Duration::from_secs(90);
/// Tombstones older than this get dropped from the manifest by whoever
/// writes it next.
const TOMBSTONE_TTL_MS: u64 = 30 * 24 * 60 * 60 * 1000;
/// Mass-delete valve: if more than this share of the workspace vanishes in
/// one scan (and more than a handful of files), don't propagate — pause and
/// ask. Protects against an unmounted/renamed folder nuking the remote.
const MASS_DELETE_PCT: usize = 30;
const MASS_DELETE_MIN: usize = 5;
/// Blob GC runs opportunistically on this fraction of cycles.
const GC_EVERY_N_CYCLES: u64 = 20;
/// A blob must be at least this old before GC may take it (a racing pusher
/// may have uploaded it moments ago, ahead of its manifest CAS).
const GC_MIN_AGE_MS: u64 = 24 * 60 * 60 * 1000;
const CAS_ATTEMPTS: usize = 4;

/* ---------- Wire types (mirror the worker) ---------- */

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub(crate) struct Manifest {
    pub version: u32,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub seq: u64,
    #[serde(default)]
    pub files: BTreeMap<String, ManifestFile>,
    #[serde(default)]
    pub tombstones: BTreeMap<String, Tombstone>,
    /// Public-share registry for this workspace, keyed by fileId: every
    /// device (and every person on the backend) sees the same "this file is
    /// published at that page" truth, so nobody double-publishes and whoever
    /// edits a shared file keeps its public page fresh. A share may outlive
    /// its file (key no longer in `files`): deleting a document doesn't
    /// unpublish it — that stays an explicit act, same as local-only shares.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub shares: BTreeMap<String, ShareRef>,
    /// Folder shares (public table-of-contents pages), keyed by page id.
    /// Membership isn't stored here — it's each file share's `cid` — so the
    /// two can't drift apart.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub collections: BTreeMap<String, CollectionRef>,
}

/// One published file: which public page it feeds, where the file lives (the
/// engine re-points `path` whenever the file moves, so the share follows
/// renames without anyone's help), and which folder share lists it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct ShareRef {
    pub id: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cid: Option<String>,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub by: String,
    #[serde(default)]
    pub at: u64,
}

/// One folder share: the directory it covers ("" = the workspace root) and
/// the title/description its public TOC renders under.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct CollectionRef {
    pub path: String,
    #[serde(default)]
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desc: Option<String>,
    #[serde(default)]
    pub by: String,
    #[serde(default)]
    pub at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct ManifestFile {
    pub path: String,
    pub rev: u64,
    pub hash: String,
    pub size: u64,
    #[serde(default)]
    pub mtime: u64,
    #[serde(default)]
    pub by: String,
    #[serde(default)]
    pub hist: Vec<HistEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct HistEntry {
    pub r: u64,
    pub h: String,
    pub s: u64,
    pub t: u64,
    #[serde(default)]
    pub b: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Tombstone {
    pub path: String,
    pub rev: u64,
    pub ts: u64,
    #[serde(default)]
    pub by: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub(crate) struct HistoryArchive {
    pub version: u32,
    #[serde(default)]
    pub entries: Vec<HistEntry>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub(crate) struct PollResponse {
    #[serde(rename = "manifestEtag")]
    pub manifest_etag: String,
    #[serde(default)]
    pub presence: BTreeMap<String, PresenceEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct PresenceEntry {
    #[serde(default)]
    pub name: String,
    #[serde(default, rename = "fileId")]
    pub file_id: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub ts: u64,
}

/* ---------- Remote abstraction ---------- */

#[derive(Debug)]
pub(crate) enum RemoteError {
    /// Transport-level failure — the backend is unreachable, not wrong.
    Offline(String),
    /// Token rejected: rotated or revoked.
    Unauthorized,
    /// Workspace (or object) gone.
    NotFound,
    /// Manifest CAS lost; carries the winner's etag (diagnostic — the retry
    /// path refetches rather than trusting it).
    Conflict {
        #[allow(dead_code)]
        etag: String,
    },
    Other(String),
}

impl std::fmt::Display for RemoteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RemoteError::Offline(m) => write!(f, "offline: {}", m),
            RemoteError::Unauthorized => write!(f, "unauthorized"),
            RemoteError::NotFound => write!(f, "not found"),
            RemoteError::Conflict { .. } => write!(f, "manifest conflict"),
            RemoteError::Other(m) => write!(f, "{}", m),
        }
    }
}

type RemoteResult<T> = Result<T, RemoteError>;

/// Everything the engine needs from the backend, factored so tests can run
/// the full engine against an in-memory fake with real CAS semantics.
/// Methods return `impl Future + Send` (rather than plain `async fn`) so the
/// engine's task stays spawnable on the multithreaded runtime.
pub(crate) trait Remote: Send + Sync + 'static {
    fn poll(&self) -> impl std::future::Future<Output = RemoteResult<PollResponse>> + Send;
    fn fetch_manifest(
        &self,
        since: Option<&str>,
    ) -> impl std::future::Future<Output = RemoteResult<Option<(Manifest, String)>>> + Send;
    fn put_manifest(
        &self,
        manifest: &Manifest,
        base_etag: &str,
    ) -> impl std::future::Future<Output = RemoteResult<String>> + Send;
    fn get_blob(
        &self,
        file_id: &str,
        hash: &str,
    ) -> impl std::future::Future<Output = RemoteResult<Vec<u8>>> + Send;
    fn put_blob(
        &self,
        file_id: &str,
        hash: &str,
        bytes: Vec<u8>,
        content_type: &str,
    ) -> impl std::future::Future<Output = RemoteResult<()>> + Send;
    fn list_blobs(
        &self,
        file_id: &str,
    ) -> impl std::future::Future<Output = RemoteResult<Vec<(String, u64)>>> + Send;
    fn delete_blob(
        &self,
        file_id: &str,
        hash: &str,
    ) -> impl std::future::Future<Output = RemoteResult<()>> + Send;
    fn get_history(
        &self,
        file_id: &str,
    ) -> impl std::future::Future<Output = RemoteResult<Option<HistoryArchive>>> + Send;
    fn put_history(
        &self,
        file_id: &str,
        archive: &HistoryArchive,
    ) -> impl std::future::Future<Output = RemoteResult<()>> + Send;
    fn put_presence(
        &self,
        device_id: &str,
        name: &str,
        file_id: Option<&str>,
        path: Option<&str>,
    ) -> impl std::future::Future<Output = RemoteResult<()>> + Send;
}

/* ---------- Event sink (AppHandle in prod, collector in tests) ---------- */

pub(crate) trait Events: Send + Sync + 'static {
    fn emit_json(&self, event: &str, payload: serde_json::Value);
}

#[cfg(test)]
pub(crate) struct NullEvents;
#[cfg(test)]
impl Events for NullEvents {
    fn emit_json(&self, _event: &str, _payload: serde_json::Value) {}
}

/* ---------- Local persistent state ---------- */

/// Per-file record of the last state this device synced: enough to detect
/// local edits cheaply (snapshot first, hash only on drift) and to name the
/// base content for three-way merges (base/<fileId> holds those bytes).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct FileState {
    pub path: String,
    pub rev: u64,
    pub hash: String,
    pub size: u64,
    pub mtime_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub(crate) struct WorkspaceState {
    pub version: u32,
    /// Etag of the last manifest this device applied.
    pub manifest_etag: Option<String>,
    /// The manifest as of that etag — what remote diffs compare against.
    pub manifest: Manifest,
    /// fileId -> last-synced local state.
    pub files: BTreeMap<String, FileState>,
    /// Share edits this device owes the manifest, keyed by workspace-relative
    /// path: Some = publish/update the share record, None = forget it. Kept
    /// (and persisted, so an offline share survives a restart) until a won
    /// CAS carries them; a set on a path with no manifest file yet stays
    /// pending until the file lands.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub share_ops: BTreeMap<String, Option<ShareRef>>,
    /// Same, for folder shares — keyed by collection (page) id.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub collection_ops: BTreeMap<String, Option<CollectionRef>>,
}

/* ---------- Status reporting ---------- */

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WsStatus {
    pub ws_id: String,
    pub name: String,
    pub root: String,
    pub connection_id: String,
    /// "idle" | "syncing" | "offline" | "paused" | "pending-deletes" |
    /// "revoked" | "error"
    pub phase: String,
    pub pending_deletes: u32,
    pub last_sync_ms: Option<u64>,
    pub error: Option<String>,
    /// The workspace's share registry as this device believes it: the last
    /// applied manifest overlaid with this device's not-yet-committed ops —
    /// so a share the user just made shows up here immediately, not a CAS
    /// later. The frontend mirrors these into its localStorage registry.
    pub shares: Vec<WsShare>,
    pub collections: Vec<WsCollection>,
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WsShare {
    /// Workspace-relative path.
    pub path: String,
    /// Public page id.
    pub id: String,
    /// Folder share (collection page id) this file is listed on, if any.
    pub cid: Option<String>,
    pub title: String,
    pub by: String,
    pub at: u64,
    /// False when the shared file has been deleted (its page lives on until
    /// stopped, but it should drop off TOCs and grow no mirror entries).
    pub alive: bool,
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WsCollection {
    /// Public page id of the TOC.
    pub id: String,
    /// Workspace-relative directory ("" = the workspace root).
    pub path: String,
    pub title: String,
    pub desc: Option<String>,
    pub by: String,
    pub at: u64,
}

/* ---------- Small helpers ---------- */

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn random_id(prefix: &str) -> String {
    let mut buf = [0u8; 6];
    let _ = getrandom::getrandom(&mut buf);
    let hex: String = buf.iter().map(|b| format!("{:02x}", b)).collect();
    format!("{}-{}", prefix, hex)
}

/// Content address: the first 16 hex chars of the sha256. 64 bits is beyond
/// plenty for distinguishing revisions of one file, and keeps keys short.
pub(crate) fn hash16(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    digest.iter().take(8).map(|b| format!("{:02x}", b)).collect()
}

fn content_type_for(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "md" | "markdown" | "mdown" | "mkd" => "text/markdown",
        "html" => "text/html",
        "txt" => "text/plain",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// Atomic-enough write: temp file in the same directory, then rename over.
/// The editor's watcher never sees a half-written document.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!(
        "{}.doklin-sync-tmp",
        path.extension().and_then(|e| e.to_str()).unwrap_or("")
    ));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    write_atomic(path, serde_json::to_vec_pretty(value)?.as_slice())
}

/// "Meeting notes.md" + Alice -> "Meeting notes (conflict — Alice, Jul 11
/// 14.32).md", uniquified if that too is taken. Dots in the time because a
/// colon is the one character macOS filenames can't wear.
fn conflict_copy_path(original: &Path, who: &str) -> PathBuf {
    let stem = original
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Untitled".into());
    let ext = original
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let who: String = who
        .chars()
        .map(|c| if c == '/' || c == ':' || c == '\0' { '-' } else { c })
        .take(40)
        .collect();
    let when = chrono::Local::now().format("%b %-d %H.%M");
    let dir = original.parent().unwrap_or(Path::new(""));
    for n in 0..100 {
        let suffix = if n == 0 { String::new() } else { format!(" {}", n + 1) };
        let name = format!("{} (conflict — {}, {}{}){}", stem, who, when, suffix, ext);
        let candidate = dir.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{} (conflict {}){}", stem, now_ms(), ext))
}

/* ---------- Local scanning ---------- */

#[derive(Clone, Debug)]
struct ScanEntry {
    abs: PathBuf,
    size: u64,
    mtime_ms: u64,
}

/// Walk the workspace with the same eyes as the sidebar tree: skip dotfiles
/// and build junk, bounded depth and entry count — but include every file
/// type (images and assets sync too), skipping only oversized ones.
fn scan_local(root: &Path) -> Result<BTreeMap<String, ScanEntry>, String> {
    let mut out = BTreeMap::new();
    let mut budget = MAX_SYNC_ENTRIES;
    scan_dir(root, root, 0, &mut budget, &mut out)?;
    Ok(out)
}

fn scan_dir(
    root: &Path,
    dir: &Path,
    depth: usize,
    budget: &mut usize,
    out: &mut BTreeMap<String, ScanEntry>,
) -> Result<(), String> {
    if depth > MAX_SYNC_DEPTH {
        return Ok(());
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Ok(()), // unreadable directory: skip, don't fail the scan
    };
    for entry in entries.flatten() {
        if *budget == 0 {
            return Err(format!(
                "workspace has more than {} entries — too large to sync",
                MAX_SYNC_ENTRIES
            ));
        }
        *budget -= 1;
        let name = entry.file_name().to_string_lossy().to_string();
        if crate::is_hidden_or_ignored(&name) || name.ends_with(".doklin-sync-tmp") {
            continue;
        }
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if ft.is_symlink() {
            continue;
        }
        let path = entry.path();
        if ft.is_dir() {
            scan_dir(root, &path, depth + 1, budget, out)?;
        } else if ft.is_file() {
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.len() > MAX_SYNC_FILE_BYTES {
                continue; // too big to sync; deliberately invisible to the engine
            }
            let rel = match path.strip_prefix(root) {
                Ok(r) => r.to_string_lossy().to_string(),
                Err(_) => continue,
            };
            let mtime_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            out.insert(
                rel,
                ScanEntry {
                    abs: path,
                    size: meta.len(),
                    mtime_ms,
                },
            );
        }
    }
    Ok(())
}

/* ---------- The engine ---------- */

pub(crate) struct EngineConfig {
    pub ws_id: String,
    pub name: String,
    pub root: PathBuf,
    pub connection_id: String,
    pub state_dir: PathBuf,
    pub device_id: String,
    pub device_name: String,
    /// Real deletions go to the macOS Trash; tests flip this off.
    pub use_trash: bool,
}

pub(crate) struct Engine<R: Remote> {
    cfg: EngineConfig,
    remote: Arc<R>,
    events: Arc<dyn Events>,
    statuses: Arc<Mutex<HashMap<String, WsStatus>>>,
    state: WorkspaceState,
    paused: bool,
    /// Absolute path the user is actively editing (frontend-reported).
    activity: Option<(String, Instant)>,
    last_beat: Option<Instant>,
    beaconed: Option<String>,
    /// Deletions held back by the mass-delete valve, waiting for a user go.
    held_deletes: Vec<String>,
    allow_mass_delete: bool,
    cycles: u64,
    /// fileIds whose blobs are worth a GC look (they rolled history).
    gc_candidates: Vec<String>,
}

/// What one reconcile pass decided to do. Split out for testability.
#[derive(Default, Debug)]
struct Staged {
    /// fileId -> (relative path, bytes) to upload + point the manifest at.
    pushes: Vec<StagedPush>,
    /// fileId -> new relative path (content unchanged).
    moves: Vec<(String, String)>,
    /// fileIds to tombstone.
    deletes: Vec<String>,
}

#[derive(Debug)]
struct StagedPush {
    file_id: String,
    path: String,
    bytes: Vec<u8>,
    hash: String,
}

impl Staged {
    fn is_empty(&self) -> bool {
        self.pushes.is_empty() && self.moves.is_empty() && self.deletes.is_empty()
    }
}

impl<R: Remote> Engine<R> {
    pub(crate) fn new(
        cfg: EngineConfig,
        remote: Arc<R>,
        events: Arc<dyn Events>,
        statuses: Arc<Mutex<HashMap<String, WsStatus>>>,
    ) -> Self {
        let state: WorkspaceState =
            read_json(&cfg.state_dir.join("state.json")).unwrap_or_default();
        Engine {
            cfg,
            remote,
            events,
            statuses,
            state,
            paused: false,
            activity: None,
            last_beat: None,
            beaconed: None,
            held_deletes: Vec::new(),
            allow_mass_delete: false,
            cycles: 0,
            gc_candidates: Vec::new(),
        }
    }

    fn base_path(&self, file_id: &str) -> PathBuf {
        self.cfg.state_dir.join("base").join(file_id)
    }

    fn persist_state(&self) {
        let _ = write_json(&self.cfg.state_dir.join("state.json"), &self.state);
    }

    /// The share registry as this device believes it: the last applied
    /// manifest, overlaid with the ops the user has queued here but a CAS
    /// hasn't carried yet — so the frontend's mirror never sees its own
    /// fresh share as "missing" and un-mirrors it.
    fn effective_shares(&self) -> (Vec<WsShare>, Vec<WsCollection>) {
        let m = &self.state.manifest;
        let mut shares: BTreeMap<String, WsShare> = BTreeMap::new();
        for (fid, s) in &m.shares {
            shares.insert(
                s.path.clone(),
                WsShare {
                    path: s.path.clone(),
                    id: s.id.clone(),
                    cid: s.cid.clone(),
                    title: s.title.clone(),
                    by: s.by.clone(),
                    at: s.at,
                    alive: m.files.contains_key(fid),
                },
            );
        }
        for (path, op) in &self.state.share_ops {
            match op {
                Some(s) => {
                    shares.insert(
                        path.clone(),
                        WsShare {
                            path: path.clone(),
                            id: s.id.clone(),
                            cid: s.cid.clone(),
                            title: s.title.clone(),
                            by: s.by.clone(),
                            at: s.at,
                            alive: true,
                        },
                    );
                }
                None => {
                    shares.remove(path);
                }
            }
        }
        let mut cols: BTreeMap<String, WsCollection> = BTreeMap::new();
        for (cid, c) in &m.collections {
            cols.insert(
                cid.clone(),
                WsCollection {
                    id: cid.clone(),
                    path: c.path.clone(),
                    title: c.title.clone(),
                    desc: c.desc.clone(),
                    by: c.by.clone(),
                    at: c.at,
                },
            );
        }
        for (cid, op) in &self.state.collection_ops {
            match op {
                Some(c) => {
                    cols.insert(
                        cid.clone(),
                        WsCollection {
                            id: cid.clone(),
                            path: c.path.clone(),
                            title: c.title.clone(),
                            desc: c.desc.clone(),
                            by: c.by.clone(),
                            at: c.at,
                        },
                    );
                }
                None => {
                    cols.remove(cid);
                }
            }
        }
        (shares.into_values().collect(), cols.into_values().collect())
    }

    fn set_status(&self, phase: &str, error: Option<String>) {
        let (shares, collections) = self.effective_shares();
        let status = WsStatus {
            ws_id: self.cfg.ws_id.clone(),
            name: self.cfg.name.clone(),
            root: self.cfg.root.to_string_lossy().to_string(),
            connection_id: self.cfg.connection_id.clone(),
            phase: phase.to_string(),
            pending_deletes: self.held_deletes.len() as u32,
            last_sync_ms: if phase == "idle" { Some(now_ms()) } else { None },
            error,
            shares,
            collections,
        };
        if let Ok(mut map) = self.statuses.lock() {
            // Keep the last successful sync time visible through later states.
            let last = map
                .get(&self.cfg.ws_id)
                .and_then(|s| s.last_sync_ms)
                .or(status.last_sync_ms);
            let mut s = status.clone();
            s.last_sync_ms = status.last_sync_ms.or(last);
            map.insert(self.cfg.ws_id.clone(), s.clone());
            self.events.emit_json("sync-status", serde_json::to_value(&s).unwrap_or(json!({})));
        }
    }

    /// The whole engine in one place: pull remote reality, apply what only
    /// changed there, work out what changed here, merge where both moved,
    /// then CAS our view in. Loops on a lost CAS with fresh remote state.
    pub(crate) async fn cycle(&mut self) -> RemoteResult<()> {
        if !self.cfg.root.is_dir() {
            // Root missing (unmounted disk, renamed folder…): touch nothing.
            self.set_status(
                "error",
                Some("workspace folder is missing — sync is paused".into()),
            );
            return Ok(());
        }
        self.set_status("syncing", None);
        self.cycles += 1;

        // All the fallible work lives in cycle_inner so that EVERY exit —
        // offline mid-download, a revoked token, a lost CAS — funnels through
        // this one status report.
        let result = self.cycle_inner().await;

        match &result {
            Ok(changed_paths) => {
                if !changed_paths.is_empty() {
                    self.events.emit_json(
                        "sync-applied",
                        json!({ "wsId": self.cfg.ws_id, "paths": changed_paths }),
                    );
                }
                if !self.held_deletes.is_empty() {
                    self.set_status("pending-deletes", None);
                } else {
                    self.set_status("idle", None);
                }
                if self.cycles % GC_EVERY_N_CYCLES == 0 {
                    self.gc_blobs().await;
                }
            }
            Err(RemoteError::Offline(m)) => self.set_status("offline", Some(m.clone())),
            Err(RemoteError::Unauthorized) => self.set_status(
                "revoked",
                Some("this device's access was revoked or the token rotated".into()),
            ),
            Err(e) => self.set_status("error", Some(e.to_string())),
        }
        match result {
            Ok(_) => Ok(()),
            Err(RemoteError::Conflict { .. }) => Ok(()), // next cycle continues
            Err(e) => Err(e),
        }
    }

    async fn cycle_inner(&mut self) -> RemoteResult<Vec<String>> {
        let mut changed_paths: Vec<String> = Vec::new();

        for attempt in 0..CAS_ATTEMPTS {
            // 1. Where is remote?
            let fetched = self
                .remote
                .fetch_manifest(self.state.manifest_etag.as_deref())
                .await?;
            let (remote_manifest, remote_etag) = match fetched {
                Some((m, e)) => (m, e),
                None => (
                    self.state.manifest.clone(),
                    self.state.manifest_etag.clone().unwrap_or_default(),
                ),
            };

            // 2. Apply remote-only changes to disk (downloads, renames,
            //    deletions). Local-vs-remote overlap is decided inside.
            let applied = self.apply_remote(&remote_manifest).await?;
            changed_paths.extend(applied);

            // 3. What changed locally?
            let scan = scan_local(&self.cfg.root).map_err(RemoteError::Other)?;
            let staged = self.stage_local(&scan, &remote_manifest).await?;

            // 3½. What the manifest would become, share bookkeeping folded in
            //     (renamed shares re-pointed, dead shares re-bound, pending
            //     share ops overlaid).
            let mut next = remote_manifest.clone();
            let rollover = self.build_manifest(&mut next, &staged);
            let (op_files, op_cols) = self.apply_share_state(&mut next);
            let shares_changed = next.shares != remote_manifest.shares
                || next.collections != remote_manifest.collections;

            // Remote moved under us but we have nothing to say: adopt theirs.
            if staged.is_empty() && !shares_changed {
                // Ops that resolved to exactly what the manifest already says
                // are spent — a CAS carrying no change would be pure waste.
                for k in &op_files {
                    self.state.share_ops.remove(k);
                }
                for k in &op_cols {
                    self.state.collection_ops.remove(k);
                }
                self.state.manifest = remote_manifest;
                self.state.manifest_etag = Some(remote_etag);
                self.persist_state();
                return Ok(changed_paths);
            }

            // 4. Upload content first (idempotent, content-addressed), then
            //    try to win the manifest.
            for push in &staged.pushes {
                self.remote
                    .put_blob(
                        &push.file_id,
                        &push.hash,
                        push.bytes.clone(),
                        content_type_for(&push.path),
                    )
                    .await?;
            }

            match self.remote.put_manifest(&next, &remote_etag).await {
                Ok(new_etag) => {
                    // The ops the manifest now carries are done; unresolved
                    // ones (a share for a file that hasn't landed yet) stay
                    // pending for a later cycle.
                    for k in &op_files {
                        self.state.share_ops.remove(k);
                    }
                    for k in &op_cols {
                        self.state.collection_ops.remove(k);
                    }
                    self.commit_staged(&staged, &next, new_etag);
                    changed_paths.extend(staged.pushes.iter().map(|p| p.path.clone()));
                    self.roll_archives(rollover).await;
                    return Ok(changed_paths);
                }
                Err(RemoteError::Conflict { .. }) if attempt + 1 < CAS_ATTEMPTS => {
                    // Someone else landed first — reconcile again from their
                    // reality. Uploaded blobs stay valid either way.
                    continue;
                }
                Err(e) => return Err(e),
            }
        }
        Ok(changed_paths)
    }

    /// Bring the local tree up to date with what changed remotely since the
    /// last applied manifest. Returns relative paths it touched. Files the
    /// user also edited locally are merged here (that's the one both-sides
    /// case); everything else is plain download/rename/trash.
    async fn apply_remote(&mut self, remote: &Manifest) -> RemoteResult<Vec<String>> {
        let mut touched = Vec::new();

        // Deletions: in our applied manifest (or state) but tombstoned now.
        let deleted_ids: Vec<String> = self
            .state
            .files
            .keys()
            .filter(|fid| !remote.files.contains_key(*fid))
            .cloned()
            .collect();
        for fid in deleted_ids {
            let Some(fstate) = self.state.files.get(&fid).cloned() else { continue };
            let tomb_rev = remote.tombstones.get(&fid).map(|t| t.rev).unwrap_or(u64::MAX);
            if tomb_rev < fstate.rev {
                continue; // stale tombstone from before what we already hold
            }
            let abs = self.cfg.root.join(&fstate.path);
            let local = read_file_checked(&abs);
            match local {
                Some(bytes) if hash16(&bytes) != fstate.hash => {
                    // Edited here, deleted there: the edit wins. Withdraw the
                    // tombstone by re-pushing (stage_local sees it as new,
                    // because we drop our state entry for it below).
                }
                Some(_) => {
                    // Clean local copy — honor the deletion, recoverably.
                    self.delete_local(&abs);
                    touched.push(fstate.path.clone());
                }
                None => {}
            }
            // Either way this fileId's story is over for our state; an
            // edited survivor re-enters as a brand-new file next scan.
            self.state.files.remove(&fid);
            let _ = std::fs::remove_file(self.base_path(&fid));
        }

        // New or changed files.
        let changed: Vec<(String, ManifestFile)> = remote
            .files
            .iter()
            .filter(|(fid, rf)| {
                self.state
                    .manifest
                    .files
                    .get(*fid)
                    .map(|old| old.rev != rf.rev || old.hash != rf.hash || old.path != rf.path)
                    .unwrap_or(true)
            })
            .map(|(fid, rf)| (fid.clone(), rf.clone()))
            .collect();

        for (fid, rf) in changed {
            let target = self.cfg.root.join(&rf.path);
            let prior = self.state.files.get(&fid).cloned();

            // A pure rename of an unedited file: move it, no bytes.
            if let Some(p) = &prior {
                if p.hash == rf.hash && p.path != rf.path {
                    let from = self.cfg.root.join(&p.path);
                    if from.exists() && !target.exists() {
                        if let Some(parent) = target.parent() {
                            let _ = std::fs::create_dir_all(parent);
                        }
                        if std::fs::rename(&from, &target).is_ok() {
                            self.record_synced(&fid, &rf, None);
                            touched.push(rf.path.clone());
                            continue;
                        }
                    }
                }
                if p.hash == rf.hash && p.path == rf.path {
                    // Only metadata (rev/hist) moved. Adopt the revision but
                    // DON'T refresh the disk snapshot: right after a merge the
                    // stored snapshot is deliberately stale so the next scan
                    // re-hashes the file and pushes the merged content —
                    // stamping fresh stats here would erase that signal.
                    if let Some(st) = self.state.files.get_mut(&fid) {
                        st.rev = rf.rev;
                    }
                    continue;
                }
            }

            let local_now = read_file_checked(&target);
            let locally_edited = match (&prior, &local_now) {
                (Some(p), Some(bytes)) => hash16(bytes) != p.hash,
                (None, Some(_)) => true, // exists here but we never synced it
                _ => false,
            };

            if !locally_edited {
                // Plain download (or first appearance).
                let bytes = self.remote.get_blob(&fid, &rf.hash).await?;
                // The file may have changed in the window since we looked;
                // if so, leave it — the next cycle will see a merge case.
                let still = read_file_checked(&target);
                let safe = match (&local_now, &still) {
                    (Some(a), Some(b)) => a == b,
                    (None, None) => true,
                    _ => false,
                };
                if safe {
                    if let Some(p) = &prior {
                        if p.path != rf.path {
                            let old_abs = self.cfg.root.join(&p.path);
                            if old_abs.exists()
                                && read_file_checked(&old_abs)
                                    .map(|b| hash16(&b) == p.hash)
                                    .unwrap_or(false)
                            {
                                self.delete_local_silent(&old_abs);
                            }
                        }
                    }
                    write_atomic(&target, &bytes)
                        .map_err(|e| RemoteError::Other(format!("write {}: {}", rf.path, e)))?;
                    self.record_synced(&fid, &rf, Some(&bytes));
                    touched.push(rf.path.clone());
                }
                continue;
            }

            // Both sides changed: three-way merge against the stored base.
            let ours = local_now.unwrap_or_default();
            let theirs = self.remote.get_blob(&fid, &rf.hash).await?;
            let base = std::fs::read(self.base_path(&fid)).ok();
            let merged = merge_texts(base.as_deref(), &ours, &theirs);
            match merged {
                MergeOutcome::Clean(text) => {
                    write_atomic(&target, text.as_bytes())
                        .map_err(|e| RemoteError::Other(format!("write {}: {}", rf.path, e)))?;
                    // Adopt their revision as the synced point; the merged
                    // content (≠ theirs) now reads as a local edit and gets
                    // pushed as rev+1 by stage_local in this same cycle.
                    self.record_synced_content(&fid, &rf, &theirs);
                    touched.push(rf.path.clone());
                }
                MergeOutcome::Conflicted => {
                    // Keep ours as the live document; their version lands
                    // beside it as a conflict copy (a normal file that syncs
                    // to everyone). Ours pushes as rev+1 this cycle.
                    let copy = conflict_copy_path(&target, if rf.by.is_empty() { "someone" } else { &rf.by });
                    write_atomic(&copy, &theirs)
                        .map_err(|e| RemoteError::Other(format!("write conflict copy: {}", e)))?;
                    self.record_synced_content(&fid, &rf, &theirs);
                    let copy_rel = copy
                        .strip_prefix(&self.cfg.root)
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_default();
                    touched.push(copy_rel.clone());
                    self.events.emit_json(
                        "sync-conflict",
                        json!({
                            "wsId": self.cfg.ws_id,
                            "path": rf.path,
                            "by": rf.by,
                            "conflictPath": copy_rel,
                        }),
                    );
                }
            }
        }
        Ok(touched)
    }

    /// Detect local edits/creates/renames/deletes against the synced state
    /// and stage them for push. Deletions pass the mass-delete valve.
    async fn stage_local(
        &mut self,
        scan: &BTreeMap<String, ScanEntry>,
        remote: &Manifest,
    ) -> RemoteResult<Staged> {
        let mut staged = Staged::default();
        let mut vanished: Vec<String> = Vec::new();

        let by_path: HashMap<String, String> = self
            .state
            .files
            .iter()
            .map(|(fid, st)| (st.path.clone(), fid.clone()))
            .collect();

        // Pass 1: files we know — modified or gone?
        let known: Vec<(String, FileState)> =
            self.state.files.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        for (fid, fstate) in known {
            match scan.get(&fstate.path) {
                None => vanished.push(fid),
                Some(entry) => {
                    if entry.size == fstate.size && entry.mtime_ms == fstate.mtime_ms {
                        continue; // snapshot says untouched
                    }
                    let Some(bytes) = read_file_checked(&entry.abs) else { continue };
                    let hash = hash16(&bytes);
                    if hash == fstate.hash {
                        // touched but identical: refresh the snapshot only
                        if let Some(st) = self.state.files.get_mut(&fid) {
                            st.size = entry.size;
                            st.mtime_ms = entry.mtime_ms;
                        }
                        continue;
                    }
                    staged.pushes.push(StagedPush {
                        file_id: fid,
                        path: fstate.path.clone(),
                        hash,
                        bytes,
                    });
                }
            }
        }

        // Pass 2: paths we don't know — new files (or the far side of a
        // rename, matched by content below).
        let mut news: Vec<(String, Vec<u8>, String)> = Vec::new(); // (path, bytes, hash)
        for (path, entry) in scan {
            if by_path.contains_key(path) {
                continue;
            }
            let Some(bytes) = read_file_checked(&entry.abs) else { continue };
            let hash = hash16(&bytes);
            news.push((path.clone(), bytes, hash));
        }

        // Pass 3: pair vanished + new with identical content = a move.
        let mut remaining_news = Vec::new();
        for (path, bytes, hash) in news {
            let matched = vanished.iter().position(|fid| {
                self.state.files.get(fid).map(|st| st.hash == hash).unwrap_or(false)
            });
            match matched {
                Some(idx) => {
                    let fid = vanished.remove(idx);
                    staged.moves.push((fid, path));
                }
                None => remaining_news.push((path, bytes, hash)),
            }
        }

        // Mass-delete valve. Renames already left `vanished`.
        if !vanished.is_empty() {
            let total = self.state.files.len().max(1);
            let big = vanished.len() >= MASS_DELETE_MIN
                && vanished.len() * 100 / total >= MASS_DELETE_PCT;
            if big && !self.allow_mass_delete {
                self.held_deletes = vanished.clone();
                self.events.emit_json(
                    "sync-pending-deletes",
                    json!({
                        "wsId": self.cfg.ws_id,
                        "count": vanished.len(),
                        "total": total,
                        "paths": vanished
                            .iter()
                            .filter_map(|fid| self.state.files.get(fid).map(|s| s.path.clone()))
                            .collect::<Vec<_>>(),
                    }),
                );
            } else {
                self.allow_mass_delete = false;
                self.held_deletes.clear();
                staged.deletes = vanished;
            }
        }

        // Brand-new files get ids; a path that already exists in the remote
        // manifest under some fileId we never synced (two devices created the
        // same name independently) adopts that id instead — apply_remote just
        // stored their version's state, so this becomes a plain edit push and
        // the merge machinery owns any content difference next cycle.
        for (path, bytes, hash) in remaining_news {
            let existing = remote.files.iter().find(|(_, rf)| rf.path == path);
            match existing {
                Some((fid, _)) if self.state.files.contains_key(fid) => {
                    if self.state.files.get(fid).map(|s| s.hash != hash).unwrap_or(true) {
                        staged.pushes.push(StagedPush {
                            file_id: fid.clone(),
                            path,
                            hash,
                            bytes,
                        });
                    }
                }
                _ => staged.pushes.push(StagedPush {
                    file_id: random_id("f"),
                    path,
                    hash,
                    bytes,
                }),
            }
        }

        Ok(staged)
    }

    /// Fold the staged changes into `next` (a clone of the freshest remote
    /// manifest). Returns per-file history entries that overflowed the
    /// inline cap and belong in the archive.
    fn build_manifest(&self, next: &mut Manifest, staged: &Staged) -> Vec<(String, Vec<HistEntry>)> {
        let mut rollover = Vec::new();
        next.version = 1;
        next.seq += 1;
        if next.name.is_empty() {
            next.name = self.cfg.name.clone();
        }

        for push in &staged.pushes {
            let prev = next.files.get(&push.file_id).cloned();
            let tomb_rev = next.tombstones.get(&push.file_id).map(|t| t.rev).unwrap_or(0);
            let rev = prev.as_ref().map(|p| p.rev).unwrap_or(0).max(tomb_rev) + 1;
            let mut hist = prev.as_ref().map(|p| p.hist.clone()).unwrap_or_default();
            if let Some(p) = &prev {
                hist.insert(
                    0,
                    HistEntry { r: p.rev, h: p.hash.clone(), s: p.size, t: p.mtime, b: p.by.clone() },
                );
            }
            if hist.len() > MANIFEST_HIST_MAX {
                rollover.push((push.file_id.clone(), hist.split_off(MANIFEST_HIST_MAX)));
            }
            next.tombstones.remove(&push.file_id); // resurrection beats deletion
            next.files.insert(
                push.file_id.clone(),
                ManifestFile {
                    path: push.path.clone(),
                    rev,
                    hash: push.hash.clone(),
                    size: push.bytes.len() as u64,
                    mtime: now_ms(),
                    by: self.cfg.device_name.clone(),
                    hist,
                },
            );
        }

        for (fid, to) in &staged.moves {
            if let Some(f) = next.files.get_mut(fid) {
                f.path = to.clone();
                f.rev += 1;
                f.mtime = now_ms();
                f.by = self.cfg.device_name.clone();
            }
        }

        for fid in &staged.deletes {
            if let Some(f) = next.files.remove(fid) {
                next.tombstones.insert(
                    fid.clone(),
                    Tombstone {
                        path: f.path,
                        rev: f.rev + 1,
                        ts: now_ms(),
                        by: self.cfg.device_name.clone(),
                    },
                );
            }
        }

        // Duplicate paths can slip in when two devices raced a create between
        // our fetch and CAS: deterministically suffix the younger id so the
        // manifest stays valid; the loser's device renames on next apply.
        dedupe_paths(next);

        // Elderly tombstones age out with whoever writes next.
        let cutoff = now_ms().saturating_sub(TOMBSTONE_TTL_MS);
        next.tombstones.retain(|_, t| t.ts >= cutoff);

        rollover
    }

    /// Fold this device's share bookkeeping into the manifest about to be
    /// published. Three passes, in order:
    ///   1. rename-follow — shares are fileId-keyed, so a moved file carries
    ///      its share; only the recorded path needs re-pointing.
    ///   2. re-bind — a dead share (fileId gone) whose path holds a share-less
    ///      file again (delete + recreate, an edit-beats-delete resurrection)
    ///      adopts the new fileId, so the page keeps flowing.
    ///   3. pending ops — the user's share/unshare edits, keyed by relative
    ///      path (files) or page id (collections).
    /// Returns the op keys that made it in; the caller clears them only once
    /// the CAS carrying them wins.
    fn apply_share_state(&self, next: &mut Manifest) -> (Vec<String>, Vec<String>) {
        let live_paths: Vec<(String, String)> = next
            .shares
            .keys()
            .filter_map(|fid| next.files.get(fid).map(|f| (fid.clone(), f.path.clone())))
            .collect();
        for (fid, path) in live_paths {
            if let Some(s) = next.shares.get_mut(&fid) {
                s.path = path;
            }
        }

        let rebinds: Vec<(String, String)> = next
            .shares
            .iter()
            .filter(|(fid, _)| !next.files.contains_key(*fid))
            .filter_map(|(fid, s)| {
                next.files
                    .iter()
                    .find(|(lfid, lf)| lf.path == s.path && !next.shares.contains_key(*lfid))
                    .map(|(lfid, _)| (fid.clone(), lfid.clone()))
            })
            .collect();
        for (dead, live) in rebinds {
            if let Some(s) = next.shares.remove(&dead) {
                next.shares.insert(live, s);
            }
        }

        let mut op_files = Vec::new();
        for (path, op) in &self.state.share_ops {
            match op {
                Some(share) => {
                    let target = next
                        .files
                        .iter()
                        .find(|(_, f)| &f.path == path)
                        .map(|(fid, _)| fid.clone())
                        .or_else(|| {
                            // No live file — a dead share at this path can
                            // still be updated (or re-pointed) in place.
                            next.shares
                                .iter()
                                .find(|(fid, s)| {
                                    &s.path == path && !next.files.contains_key(*fid)
                                })
                                .map(|(fid, _)| fid.clone())
                        });
                    if let Some(fid) = target {
                        let mut s = share.clone();
                        s.path = path.clone();
                        next.shares.insert(fid, s);
                        op_files.push(path.clone());
                    }
                    // Otherwise the file hasn't landed in the manifest yet:
                    // the op stays pending and rides a later cycle.
                }
                None => {
                    next.shares.retain(|_, s| &s.path != path);
                    op_files.push(path.clone());
                }
            }
        }

        let mut op_cols = Vec::new();
        for (cid, op) in &self.state.collection_ops {
            match op {
                Some(c) => {
                    next.collections.insert(cid.clone(), c.clone());
                }
                None => {
                    next.collections.remove(cid);
                    // A stopped folder share releases its members' listing
                    // bit everywhere, including shares no device has in its
                    // local registry anymore (dead ones).
                    for s in next.shares.values_mut() {
                        if s.cid.as_deref() == Some(cid) {
                            s.cid = None;
                        }
                    }
                }
            }
            op_cols.push(cid.clone());
        }
        (op_files, op_cols)
    }

    /// After a won CAS: make local state mirror what we just published.
    fn commit_staged(&mut self, staged: &Staged, next: &Manifest, etag: String) {
        for push in &staged.pushes {
            if let Some(rf) = next.files.get(&push.file_id) {
                let abs = self.cfg.root.join(&rf.path);
                let (size, mtime_ms) = stat_pair(&abs);
                self.state.files.insert(
                    push.file_id.clone(),
                    FileState {
                        path: rf.path.clone(),
                        rev: rf.rev,
                        hash: rf.hash.clone(),
                        size,
                        mtime_ms,
                    },
                );
                let _ = write_atomic(&self.base_path(&push.file_id), &push.bytes);
                if !rf.hist.is_empty() {
                    self.gc_candidates.push(push.file_id.clone());
                }
            }
        }
        for (fid, to) in &staged.moves {
            let abs = self.cfg.root.join(to);
            let (size, mtime_ms) = stat_pair(&abs);
            if let (Some(st), Some(rf)) = (self.state.files.get_mut(fid), next.files.get(fid)) {
                st.path = to.clone();
                st.rev = rf.rev;
                st.size = size;
                st.mtime_ms = mtime_ms;
            }
        }
        for fid in &staged.deletes {
            self.state.files.remove(fid);
            let _ = std::fs::remove_file(self.base_path(fid));
        }
        self.state.manifest = next.clone();
        self.state.manifest_etag = Some(etag);
        self.persist_state();
    }

    /// Adopt a remote file's state after applying its content to disk.
    fn record_synced(&mut self, fid: &str, rf: &ManifestFile, bytes: Option<&[u8]>) {
        let abs = self.cfg.root.join(&rf.path);
        let (size, mtime_ms) = stat_pair(&abs);
        self.state.files.insert(
            fid.to_string(),
            FileState {
                path: rf.path.clone(),
                rev: rf.rev,
                hash: rf.hash.clone(),
                size,
                mtime_ms,
            },
        );
        if let Some(b) = bytes {
            let _ = write_atomic(&self.base_path(fid), b);
        }
    }

    /// Like `record_synced`, but for merge cases where the bytes on disk
    /// deliberately differ from the remote revision: the base becomes THEIR
    /// content (the revision we reconciled against), while the snapshot
    /// fields track the actual disk file so it reads as locally edited.
    fn record_synced_content(&mut self, fid: &str, rf: &ManifestFile, theirs: &[u8]) {
        let abs = self.cfg.root.join(&rf.path);
        let (size, mtime_ms) = stat_pair(&abs);
        self.state.files.insert(
            fid.to_string(),
            FileState {
                path: rf.path.clone(),
                rev: rf.rev,
                hash: rf.hash.clone(),
                // Deliberately NOT the disk snapshot: forces the next scan to
                // hash the file, see it differs from `hash`, and push it.
                size: size.wrapping_add(1),
                mtime_ms,
            },
        );
        let _ = write_atomic(&self.base_path(fid), theirs);
    }

    fn delete_local(&self, abs: &Path) {
        if self.cfg.use_trash {
            #[cfg(target_os = "macos")]
            {
                if crate::trash_path_impl(&abs.to_string_lossy()).is_ok() {
                    return;
                }
            }
        }
        let _ = std::fs::remove_file(abs);
    }

    fn delete_local_silent(&self, abs: &Path) {
        let _ = std::fs::remove_file(abs);
    }

    /// Roll history entries that overflowed the manifest's inline cap into
    /// the per-file archive object. Best-effort: a lost archive write only
    /// shortens deep history.
    async fn roll_archives(&mut self, rollover: Vec<(String, Vec<HistEntry>)>) {
        for (fid, entries) in rollover {
            let mut archive = match self.remote.get_history(&fid).await {
                Ok(Some(a)) => a,
                Ok(None) => HistoryArchive { version: 1, entries: Vec::new() },
                Err(_) => continue,
            };
            for e in entries {
                if !archive.entries.iter().any(|x| x.r == e.r) {
                    archive.entries.push(e);
                }
            }
            archive.entries.sort_by(|a, b| b.r.cmp(&a.r));
            archive.entries.truncate(ARCHIVE_HIST_MAX);
            archive.version = 1;
            let _ = self.remote.put_history(&fid, &archive).await;
        }
    }

    /// Drop blobs no longer referenced by the manifest hist or the archive,
    /// once they're old enough that no racing pusher still needs them.
    async fn gc_blobs(&mut self) {
        let candidates: Vec<String> = self.gc_candidates.drain(..).collect();
        for fid in candidates {
            let Some(current) = self.state.manifest.files.get(&fid) else { continue };
            let mut referenced: Vec<String> = vec![current.hash.clone()];
            referenced.extend(current.hist.iter().map(|h| h.h.clone()));
            if let Ok(Some(archive)) = self.remote.get_history(&fid).await {
                referenced.extend(archive.entries.iter().map(|e| e.h.clone()));
            }
            let Ok(blobs) = self.remote.list_blobs(&fid).await else { continue };
            for (hash, uploaded_ms) in blobs {
                let old_enough = now_ms().saturating_sub(uploaded_ms) > GC_MIN_AGE_MS;
                if old_enough && !referenced.contains(&hash) {
                    let _ = self.remote.delete_blob(&fid, &hash).await;
                }
            }
        }
    }

    /* ----- activity + presence ----- */

    pub(crate) fn set_activity(&mut self, abs_path: Option<String>) {
        self.activity = abs_path.map(|p| (p, Instant::now()));
    }

    pub(crate) fn confirm_deletes(&mut self) {
        self.allow_mass_delete = true;
        self.held_deletes.clear();
    }

    pub(crate) fn set_paused(&mut self, paused: bool) {
        self.paused = paused;
        self.set_status(if paused { "paused" } else { "idle" }, None);
    }

    /// Heartbeat "this device is editing <file>" while activity is fresh;
    /// send one clearing beat when it goes stale.
    async fn presence_tick(&mut self) {
        let fresh = self
            .activity
            .as_ref()
            .filter(|(_, at)| at.elapsed() < ACTIVITY_FRESH)
            .map(|(p, _)| p.clone());

        let file = fresh.and_then(|abs| {
            let rel = Path::new(&abs)
                .strip_prefix(&self.cfg.root)
                .ok()?
                .to_string_lossy()
                .to_string();
            let fid = self
                .state
                .files
                .iter()
                .find(|(_, st)| st.path == rel)
                .map(|(fid, _)| fid.clone())?;
            Some((fid, rel))
        });

        match file {
            Some((fid, rel)) => {
                let due = self
                    .last_beat
                    .map(|t| t.elapsed() >= PRESENCE_BEAT)
                    .unwrap_or(true)
                    || self.beaconed.as_deref() != Some(&fid);
                if due {
                    let ok = self
                        .remote
                        .put_presence(&self.cfg.device_id, &self.cfg.device_name, Some(&fid), Some(&rel))
                        .await;
                    if ok.is_ok() {
                        self.last_beat = Some(Instant::now());
                        self.beaconed = Some(fid);
                    }
                }
            }
            None => {
                if self.beaconed.take().is_some() {
                    let _ = self
                        .remote
                        .put_presence(&self.cfg.device_id, &self.cfg.device_name, None, None)
                        .await;
                }
                self.last_beat = None;
            }
        }
    }

    /// Poll cheaply; a moved etag (or fresh presence) is what makes the full
    /// cycle worth running.
    async fn poll_and_maybe_cycle(&mut self) -> RemoteResult<()> {
        let poll = self.remote.poll().await?;
        self.events.emit_json(
            "sync-presence",
            json!({
                "wsId": self.cfg.ws_id,
                "devices": poll
                    .presence
                    .iter()
                    .filter(|(id, _)| id.as_str() != self.cfg.device_id)
                    .map(|(id, e)| json!({
                        "deviceId": id,
                        "name": e.name,
                        "fileId": e.file_id,
                        "path": e.path,
                        "ts": e.ts,
                    }))
                    .collect::<Vec<_>>(),
            }),
        );
        if Some(poll.manifest_etag.as_str()) != self.state.manifest_etag.as_deref() {
            self.cycle().await?;
        }
        Ok(())
    }

    /// The engine task: wake on commands, filesystem events, or the poll
    /// clock; run cycles when something might have moved.
    pub(crate) async fn run(
        mut self,
        mut cmds: tokio::sync::mpsc::UnboundedReceiver<EngineCmd>,
        mut fs_events: tokio::sync::mpsc::UnboundedReceiver<()>,
    ) {
        // First contact: full cycle brings a stale device current.
        if !self.paused {
            let _ = self.cycle().await;
        }
        let mut fs_dirty_at: Option<Instant> = None;
        let mut next_poll = Instant::now() + POLL_INTERVAL;

        loop {
            let now = Instant::now();
            let mut wake = next_poll;
            if let Some(t) = fs_dirty_at {
                let due = t + FS_SETTLE;
                if due < wake {
                    wake = due;
                }
            }
            let sleep_for = wake.saturating_duration_since(now);

            tokio::select! {
                cmd = cmds.recv() => match cmd {
                    None | Some(EngineCmd::Shutdown) => {
                        // Clear our presence on the way out, best-effort.
                        if self.beaconed.take().is_some() {
                            let _ = self.remote
                                .put_presence(&self.cfg.device_id, &self.cfg.device_name, None, None)
                                .await;
                        }
                        return;
                    }
                    Some(EngineCmd::SyncNow) => {
                        if !self.paused { let _ = self.cycle().await; }
                        next_poll = Instant::now() + POLL_INTERVAL;
                    }
                    Some(EngineCmd::SetActivity(p)) => {
                        self.set_activity(p);
                        self.presence_tick().await;
                    }
                    Some(EngineCmd::Pause(p)) => self.set_paused(p),
                    Some(EngineCmd::ConfirmDeletes) => {
                        self.confirm_deletes();
                        if !self.paused { let _ = self.cycle().await; }
                    }
                    Some(EngineCmd::SetShares { files, collections }) => {
                        for (k, v) in files { self.state.share_ops.insert(k, v); }
                        for (k, v) in collections { self.state.collection_ops.insert(k, v); }
                        // Persist before anything can go wrong: a share made
                        // offline must survive a restart, or the frontend's
                        // mirror would read its own entry as remotely removed.
                        self.persist_state();
                        if !self.paused {
                            let _ = self.cycle().await;
                            next_poll = Instant::now() + POLL_INTERVAL;
                        } else {
                            // Paused: no cycle, but the status mirror must
                            // still see the op in the effective view.
                            self.set_status("paused", None);
                        }
                    }
                },
                ev = fs_events.recv() => {
                    if ev.is_none() { return; } // watcher died with the manager
                    fs_dirty_at = Some(Instant::now());
                },
                _ = tokio::time::sleep(sleep_for) => {}
            }

            if self.paused {
                continue;
            }
            let now = Instant::now();
            let fs_due = fs_dirty_at.map(|t| now >= t + FS_SETTLE).unwrap_or(false);
            if fs_due {
                fs_dirty_at = None;
                let _ = self.cycle().await;
                next_poll = Instant::now() + POLL_INTERVAL;
            } else if now >= next_poll {
                let _ = self.poll_and_maybe_cycle().await;
                self.presence_tick().await;
                next_poll = Instant::now() + POLL_INTERVAL;
            }
        }
    }
}

pub(crate) enum EngineCmd {
    SyncNow,
    SetActivity(Option<String>),
    Pause(bool),
    ConfirmDeletes,
    SetShares {
        files: BTreeMap<String, Option<ShareRef>>,
        collections: BTreeMap<String, Option<CollectionRef>>,
    },
    Shutdown,
}

/* ---------- Merge ---------- */

enum MergeOutcome {
    Clean(String),
    Conflicted,
}

/// Three-way text merge. Binary content (any side) or a missing base means
/// no merge — the caller falls back to a conflict copy.
fn merge_texts(base: Option<&[u8]>, ours: &[u8], theirs: &[u8]) -> MergeOutcome {
    let (Some(base), Ok(ours), Ok(theirs)) = (
        base.map(|b| std::str::from_utf8(b)).and_then(Result::ok),
        std::str::from_utf8(ours),
        std::str::from_utf8(theirs),
    ) else {
        return MergeOutcome::Conflicted;
    };
    match diffy::merge(base, ours, theirs) {
        Ok(merged) => MergeOutcome::Clean(merged),
        Err(_) => MergeOutcome::Conflicted,
    }
}

/// Two manifest entries claiming one path (a raced create): keep the
/// lexicographically-smaller fileId on the path, suffix the other. Every
/// device runs the same rule, so they agree without coordinating.
fn dedupe_paths(m: &mut Manifest) {
    let mut by_path: HashMap<String, String> = HashMap::new();
    let ids: Vec<String> = m.files.keys().cloned().collect();
    for fid in ids {
        let path = m.files.get(&fid).map(|f| f.path.clone()).unwrap_or_default();
        let key = path.to_lowercase();
        match by_path.get(&key) {
            None => {
                by_path.insert(key, fid);
            }
            Some(winner) => {
                let (keep, bump) = if *winner < fid {
                    (winner.clone(), fid.clone())
                } else {
                    (fid.clone(), winner.clone())
                };
                by_path.insert(key, keep);
                if let Some(f) = m.files.get_mut(&bump) {
                    let p = Path::new(&f.path);
                    let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
                    let dir = p.parent().map(|d| d.to_string_lossy().to_string()).unwrap_or_default();
                    let new_name = format!("{} ({}){}", stem, &bump[bump.len().saturating_sub(4)..], ext);
                    f.path = if dir.is_empty() { new_name } else { format!("{}/{}", dir, new_name) };
                    f.rev += 1;
                    let new_key = f.path.to_lowercase();
                    by_path.insert(new_key, bump);
                }
            }
        }
    }
}

/* ---------- misc fs helpers ---------- */

/// Read a file if it exists and is small enough to sync.
fn read_file_checked(path: &Path) -> Option<Vec<u8>> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_SYNC_FILE_BYTES {
        return None;
    }
    std::fs::read(path).ok()
}

fn stat_pair(path: &Path) -> (u64, u64) {
    match std::fs::metadata(path) {
        Ok(meta) => {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            (meta.len(), mtime)
        }
        Err(_) => (0, 0),
    }
}

/* ---------- HTTP remote (the real worker) ---------- */

use tauri::{AppHandle, Emitter, Manager};

pub(crate) struct HttpRemote {
    client: reqwest::Client,
    endpoint: String,
    token: String,
    ws: String,
}

impl HttpRemote {
    pub(crate) fn new(endpoint: &str, token: &str, ws: &str) -> Self {
        HttpRemote {
            client: http_client(),
            endpoint: endpoint.trim_end_matches('/').to_string(),
            token: token.to_string(),
            ws: ws.to_string(),
        }
    }

    fn url(&self, tail: &str) -> String {
        format!("{}/api/sync/{}/{}", self.endpoint, self.ws, tail)
    }

    fn auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        req.header("authorization", format!("Bearer {}", self.token))
    }
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .connect_timeout(Duration::from_secs(10))
        .build()
        .expect("reqwest client")
}

fn transport_err(e: reqwest::Error) -> RemoteError {
    RemoteError::Offline(e.to_string())
}

async fn expect_status(res: reqwest::Response) -> RemoteResult<reqwest::Response> {
    match res.status().as_u16() {
        200..=299 | 304 => Ok(res),
        401 => Err(RemoteError::Unauthorized),
        404 => Err(RemoteError::NotFound),
        412 => {
            let etag = res
                .json::<serde_json::Value>()
                .await
                .ok()
                .and_then(|v| v.get("etag").and_then(|e| e.as_str()).map(String::from))
                .unwrap_or_default();
            Err(RemoteError::Conflict { etag })
        }
        code => {
            let body = res.text().await.unwrap_or_default();
            Err(RemoteError::Other(format!("http {}: {}", code, body.chars().take(200).collect::<String>())))
        }
    }
}

impl Remote for HttpRemote {
    fn poll(&self) -> impl std::future::Future<Output = RemoteResult<PollResponse>> + Send {
        async move {
            let res = self
                .auth(self.client.get(self.url("poll")))
                .send()
                .await
                .map_err(transport_err)?;
            let res = expect_status(res).await?;
            res.json::<PollResponse>().await.map_err(transport_err)
        }
    }

    fn fetch_manifest(
        &self,
        since: Option<&str>,
    ) -> impl std::future::Future<Output = RemoteResult<Option<(Manifest, String)>>> + Send {
        let since = since.map(String::from);
        async move {
            let mut req = self.client.get(self.url("manifest"));
            if let Some(s) = &since {
                req = req.query(&[("since", s.as_str())]);
            }
            let res = self.auth(req).send().await.map_err(transport_err)?;
            if res.status().as_u16() == 304 {
                return Ok(None);
            }
            let res = expect_status(res).await?;
            let etag = res
                .headers()
                .get("x-manifest-etag")
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_string();
            let manifest = res.json::<Manifest>().await.map_err(transport_err)?;
            Ok(Some((manifest, etag)))
        }
    }

    fn put_manifest(
        &self,
        manifest: &Manifest,
        base_etag: &str,
    ) -> impl std::future::Future<Output = RemoteResult<String>> + Send {
        let body = serde_json::to_vec(manifest).unwrap_or_default();
        let base = base_etag.to_string();
        async move {
            let res = self
                .auth(self.client.put(self.url("manifest")))
                .header("x-base-etag", base)
                .header("content-type", "application/json")
                .body(body)
                .send()
                .await
                .map_err(transport_err)?;
            let res = expect_status(res).await?;
            let v = res.json::<serde_json::Value>().await.map_err(transport_err)?;
            Ok(v.get("etag").and_then(|e| e.as_str()).unwrap_or_default().to_string())
        }
    }

    fn get_blob(
        &self,
        file_id: &str,
        hash: &str,
    ) -> impl std::future::Future<Output = RemoteResult<Vec<u8>>> + Send {
        let url = self.url(&format!("files/{}/{}", file_id, hash));
        async move {
            let res = self.auth(self.client.get(url)).send().await.map_err(transport_err)?;
            let res = expect_status(res).await?;
            Ok(res.bytes().await.map_err(transport_err)?.to_vec())
        }
    }

    fn put_blob(
        &self,
        file_id: &str,
        hash: &str,
        bytes: Vec<u8>,
        content_type: &str,
    ) -> impl std::future::Future<Output = RemoteResult<()>> + Send {
        let url = self.url(&format!("files/{}/{}", file_id, hash));
        let ct = content_type.to_string();
        async move {
            let res = self
                .auth(self.client.put(url))
                .header("content-type", ct)
                .body(bytes)
                .send()
                .await
                .map_err(transport_err)?;
            expect_status(res).await.map(|_| ())
        }
    }

    fn list_blobs(
        &self,
        file_id: &str,
    ) -> impl std::future::Future<Output = RemoteResult<Vec<(String, u64)>>> + Send {
        let url = self.url(&format!("files/{}", file_id));
        async move {
            let res = self.auth(self.client.get(url)).send().await.map_err(transport_err)?;
            let res = expect_status(res).await?;
            let v = res.json::<serde_json::Value>().await.map_err(transport_err)?;
            let blobs = v
                .get("blobs")
                .and_then(|b| b.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|b| {
                            let hash = b.get("hash")?.as_str()?.to_string();
                            let uploaded = b
                                .get("uploaded")
                                .and_then(|u| u.as_str())
                                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                                .map(|d| d.timestamp_millis() as u64)
                                .unwrap_or(0);
                            Some((hash, uploaded))
                        })
                        .collect()
                })
                .unwrap_or_default();
            Ok(blobs)
        }
    }

    fn delete_blob(
        &self,
        file_id: &str,
        hash: &str,
    ) -> impl std::future::Future<Output = RemoteResult<()>> + Send {
        let url = self.url(&format!("files/{}/{}", file_id, hash));
        async move {
            let res = self.auth(self.client.delete(url)).send().await.map_err(transport_err)?;
            expect_status(res).await.map(|_| ())
        }
    }

    fn get_history(
        &self,
        file_id: &str,
    ) -> impl std::future::Future<Output = RemoteResult<Option<HistoryArchive>>> + Send {
        let url = self.url(&format!("history/{}", file_id));
        async move {
            let res = self.auth(self.client.get(url)).send().await.map_err(transport_err)?;
            match expect_status(res).await {
                Ok(res) => Ok(Some(res.json::<HistoryArchive>().await.map_err(transport_err)?)),
                Err(RemoteError::NotFound) => Ok(None),
                Err(e) => Err(e),
            }
        }
    }

    fn put_history(
        &self,
        file_id: &str,
        archive: &HistoryArchive,
    ) -> impl std::future::Future<Output = RemoteResult<()>> + Send {
        let url = self.url(&format!("history/{}", file_id));
        let body = serde_json::to_vec(archive).unwrap_or_default();
        async move {
            let res = self
                .auth(self.client.put(url))
                .header("content-type", "application/json")
                .body(body)
                .send()
                .await
                .map_err(transport_err)?;
            expect_status(res).await.map(|_| ())
        }
    }

    fn put_presence(
        &self,
        device_id: &str,
        name: &str,
        file_id: Option<&str>,
        path: Option<&str>,
    ) -> impl std::future::Future<Output = RemoteResult<()>> + Send {
        let body = json!({
            "deviceId": device_id,
            "name": name,
            "fileId": file_id,
            "path": path,
        });
        async move {
            let res = self
                .auth(self.client.put(self.url("presence")))
                .header("content-type", "application/json")
                .body(serde_json::to_vec(&body).unwrap_or_default())
                .send()
                .await
                .map_err(transport_err)?;
            expect_status(res).await.map(|_| ())
        }
    }
}

/// POST /api/sync/workspaces — the one call that happens before a
/// workspace-scoped remote exists.
async fn http_create_workspace(
    endpoint: &str,
    token: &str,
    name: &str,
) -> RemoteResult<(String, String)> {
    let client = http_client();
    let res = client
        .post(format!("{}/api/sync/workspaces", endpoint.trim_end_matches('/')))
        .header("authorization", format!("Bearer {}", token))
        .header("content-type", "application/json")
        .body(serde_json::to_vec(&json!({ "name": name })).unwrap_or_default())
        .send()
        .await
        .map_err(transport_err)?;
    let res = expect_status(res).await?;
    let v = res.json::<serde_json::Value>().await.map_err(transport_err)?;
    let id = v.get("id").and_then(|x| x.as_str()).unwrap_or_default().to_string();
    let etag = v
        .get("manifestEtag")
        .and_then(|x| x.as_str())
        .unwrap_or_default()
        .to_string();
    if id.is_empty() || etag.is_empty() {
        return Err(RemoteError::Other("workspace create returned no id/etag".into()));
    }
    Ok((id, etag))
}

/* ---------- Config files ---------- */

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct DeviceIdentity {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceConfig {
    pub id: String,
    pub root: String,
    pub connection_id: String,
    pub name: String,
}

/// <app_data_dir>/sync.json — this machine's device identity + which local
/// folders sync where. Credentials stay in share.json (one source of truth).
#[derive(Default, Serialize, Deserialize)]
struct SyncConfigFile {
    version: u32,
    device: Option<DeviceIdentity>,
    #[serde(default)]
    workspaces: Vec<WorkspaceConfig>,
}

#[derive(Deserialize)]
struct ShareFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    connections: Vec<ShareConn>,
}

#[derive(Clone, Deserialize)]
pub(crate) struct ShareConn {
    pub id: String,
    pub endpoint: String,
    pub token: String,
}

fn sync_config_path(data_dir: &Path) -> PathBuf {
    data_dir.join("sync.json")
}

fn read_sync_config(data_dir: &Path) -> SyncConfigFile {
    read_json(&sync_config_path(data_dir)).unwrap_or_default()
}

fn write_sync_config(data_dir: &Path, cfg: &SyncConfigFile) -> Result<(), String> {
    write_json(&sync_config_path(data_dir), cfg).map_err(|e| format!("write sync.json: {}", e))
}

/// Resolve a connection id to its endpoint + token from share.json (v2).
fn read_connection(data_dir: &Path, connection_id: &str) -> Result<ShareConn, String> {
    let share: ShareFile = read_json(&data_dir.join("share.json"))
        .ok_or_else(|| "sharing is not configured on this machine".to_string())?;
    if share.version != 2 {
        return Err("share.json has an unsupported version".to_string());
    }
    share
        .connections
        .into_iter()
        .find(|c| c.id == connection_id)
        .ok_or_else(|| "that backend connection no longer exists".to_string())
}

fn device_display_name() -> String {
    // macOS-only: the Mac's user-facing name; hostname as fallback.
    let pretty = std::process::Command::new("scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    pretty
        .or_else(|| {
            std::process::Command::new("hostname")
                .output()
                .ok()
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| "This Mac".to_string())
}

/* ---------- Manager: one engine task per synced workspace ---------- */

struct AppEvents(AppHandle);
impl Events for AppEvents {
    fn emit_json(&self, event: &str, payload: serde_json::Value) {
        let _ = self.0.emit(event, payload);
    }
}

struct EngineHandle {
    tx: tokio::sync::mpsc::UnboundedSender<EngineCmd>,
    root: PathBuf,
    // Held so the recursive watcher lives exactly as long as the engine.
    _watcher: notify_debouncer_full::Debouncer<notify::RecommendedWatcher, notify_debouncer_full::FileIdMap>,
}

struct ManagerInner {
    app: AppHandle,
    data_dir: PathBuf,
    device: DeviceIdentity,
    engines: HashMap<String, EngineHandle>,
    statuses: Arc<Mutex<HashMap<String, WsStatus>>>,
}

#[derive(Default)]
pub struct SyncManager {
    inner: Mutex<Option<ManagerInner>>,
}

/// Called once from tauri's setup: load config, mint a device identity on
/// first run, spawn an engine per configured workspace.
pub(crate) fn init(app: &AppHandle) {
    let Ok(data_dir) = app.path().app_data_dir() else { return };
    let _ = std::fs::create_dir_all(&data_dir);

    let mut cfg = read_sync_config(&data_dir);
    let device = match cfg.device.clone() {
        Some(d) => d,
        None => {
            let d = DeviceIdentity { id: random_id("d"), name: device_display_name() };
            cfg.device = Some(d.clone());
            cfg.version = 1;
            let _ = write_sync_config(&data_dir, &cfg);
            d
        }
    };

    let statuses: Arc<Mutex<HashMap<String, WsStatus>>> = Arc::new(Mutex::new(HashMap::new()));
    let mut inner = ManagerInner {
        app: app.clone(),
        data_dir,
        device,
        engines: HashMap::new(),
        statuses,
    };
    let workspaces = cfg.workspaces.clone();
    for ws in workspaces {
        spawn_engine(&mut inner, &ws);
    }

    let manager = app.state::<SyncManager>();
    *manager.inner.lock().unwrap() = Some(inner);
}

fn spawn_engine(inner: &mut ManagerInner, ws: &WorkspaceConfig) {
    let conn = match read_connection(&inner.data_dir, &ws.connection_id) {
        Ok(c) => c,
        Err(e) => {
            let status = WsStatus {
                ws_id: ws.id.clone(),
                name: ws.name.clone(),
                root: ws.root.clone(),
                connection_id: ws.connection_id.clone(),
                phase: "error".into(),
                error: Some(e),
                ..Default::default()
            };
            if let Ok(mut map) = inner.statuses.lock() {
                map.insert(ws.id.clone(), status.clone());
            }
            let _ = inner.app.emit("sync-status", status);
            return;
        }
    };

    let state_dir = inner.data_dir.join("sync").join(&ws.id);
    let _ = std::fs::create_dir_all(state_dir.join("base"));

    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel::<EngineCmd>();
    let (fs_tx, fs_rx) = tokio::sync::mpsc::unbounded_channel::<()>();

    // Recursive workspace watcher: any debounced event just pokes the engine;
    // the engine's scan decides what actually changed.
    let root = PathBuf::from(&ws.root);
    let watcher = notify_debouncer_full::new_debouncer(
        Duration::from_millis(500),
        None,
        move |result: notify_debouncer_full::DebounceEventResult| {
            if result.is_ok() {
                let _ = fs_tx.send(());
            }
        },
    );
    let mut watcher = match watcher {
        Ok(w) => w,
        Err(_) => return,
    };
    let _ = watcher.watcher().watch(&root, notify::RecursiveMode::Recursive);
    watcher.cache().add_root(&root, notify::RecursiveMode::Recursive);

    let engine = Engine::new(
        EngineConfig {
            ws_id: ws.id.clone(),
            name: ws.name.clone(),
            root: root.clone(),
            connection_id: ws.connection_id.clone(),
            state_dir,
            device_id: inner.device.id.clone(),
            device_name: inner.device.name.clone(),
            use_trash: true,
        },
        Arc::new(HttpRemote::new(&conn.endpoint, &conn.token, &ws.id)),
        Arc::new(AppEvents(inner.app.clone())),
        inner.statuses.clone(),
    );
    tauri::async_runtime::spawn(engine.run(cmd_rx, fs_rx));

    inner.engines.insert(
        ws.id.clone(),
        EngineHandle { tx: cmd_tx, root, _watcher: watcher },
    );
}

fn with_inner<T>(
    app: &AppHandle,
    f: impl FnOnce(&mut ManagerInner) -> Result<T, String>,
) -> Result<T, String> {
    let manager = app.state::<SyncManager>();
    let mut guard = manager.inner.lock().map_err(|_| "sync manager poisoned".to_string())?;
    let inner = guard.as_mut().ok_or_else(|| "sync engine not ready yet".to_string())?;
    f(inner)
}

fn sanitize_folder_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c == '/' || c == ':' || c == '\0' { '-' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    if trimmed.is_empty() { "Workspace".to_string() } else { trimmed }
}

/* ---------- Tauri commands ---------- */

/// Turn a local folder into a synced workspace: create it on the backend,
/// upload everything, then hand it to a live engine.
#[tauri::command]
pub(crate) async fn sync_enable(
    app: AppHandle,
    root: String,
    connection_id: String,
    name: String,
) -> Result<String, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err("that folder doesn't exist".into());
    }

    // Everything we need from the manager, without holding its lock across IO.
    let (data_dir, device) = with_inner(&app, |inner| {
        for ws in inner.engines.values() {
            if ws.root == root_path || root_path.starts_with(&ws.root) || ws.root.starts_with(&root_path) {
                return Err("this folder (or one containing it) already syncs".into());
            }
        }
        Ok((inner.data_dir.clone(), inner.device.clone()))
    })?;
    let conn = read_connection(&data_dir, &connection_id)?;

    let scan = scan_local(&root_path)?;
    let total = scan.len();

    let (ws_id, etag0) = http_create_workspace(&conn.endpoint, &conn.token, &name)
        .await
        .map_err(|e| match e {
            RemoteError::Unauthorized => "the backend rejected this connection's token".to_string(),
            other => format!("couldn't create the workspace: {}", other),
        })?;
    let remote = Arc::new(HttpRemote::new(&conn.endpoint, &conn.token, &ws_id));

    // Read + hash + upload, a few files in flight at a time.
    let mut manifest = Manifest {
        version: 1,
        name: name.clone(),
        seq: 1,
        ..Default::default()
    };
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
        while set.len() < 4 {
            let Some((fid, rel, bytes, entry)) = queue.next() else { break };
            let remote = remote.clone();
            set.spawn(async move {
                let hash = hash16(&bytes);
                let r = remote
                    .put_blob(&fid, &hash, bytes.clone(), content_type_for(&rel))
                    .await;
                (fid, rel, bytes, entry, hash, r)
            });
        }
        let Some(joined) = set.join_next().await else { break };
        let (fid, rel, bytes, entry, hash, r) =
            joined.map_err(|e| format!("upload task: {}", e))?;
        r.map_err(|e| format!("upload {}: {}", rel, e))?;
        manifest.files.insert(
            fid.clone(),
            ManifestFile {
                path: rel.clone(),
                rev: 1,
                hash: hash.clone(),
                size: bytes.len() as u64,
                mtime: now_ms(),
                by: device.name.clone(),
                hist: Vec::new(),
            },
        );
        states.insert(
            fid.clone(),
            FileState { path: rel, rev: 1, hash, size: entry.size, mtime_ms: entry.mtime_ms },
        );
        // Base copy: the uploaded bytes are the merge ancestor from now on.
        let base = data_dir.join("sync").join(&ws_id).join("base").join(&fid);
        let _ = write_atomic(&base, &bytes);
        done += 1;
        let _ = app.emit(
            "sync-progress",
            json!({ "wsId": ws_id, "kind": "upload", "done": done, "total": total }),
        );
    }

    let etag = remote
        .put_manifest(&manifest, &etag0)
        .await
        .map_err(|e| format!("publish manifest: {}", e))?;

    let state_dir = data_dir.join("sync").join(&ws_id);
    let _ = std::fs::create_dir_all(state_dir.join("base"));
    let state = WorkspaceState {
        version: 1,
        manifest_etag: Some(etag),
        manifest,
        files: states,
        ..Default::default()
    };
    write_json(&state_dir.join("state.json"), &state).map_err(|e| format!("save state: {}", e))?;

    let ws_cfg = WorkspaceConfig {
        id: ws_id.clone(),
        root: root_path.to_string_lossy().to_string(),
        connection_id,
        name,
    };
    with_inner(&app, |inner| {
        let mut cfg = read_sync_config(&inner.data_dir);
        cfg.version = 1;
        cfg.device.get_or_insert_with(|| inner.device.clone());
        // One config per workspace id AND per root — re-enabling a folder
        // whose old engine died must not leave a zombie entry behind.
        cfg.workspaces.retain(|w| w.id != ws_cfg.id && w.root != ws_cfg.root);
        cfg.workspaces.push(ws_cfg.clone());
        write_sync_config(&inner.data_dir, &cfg)?;
        spawn_engine(inner, &ws_cfg);
        Ok(())
    })?;

    Ok(ws_id)
}

/// Pull a workspace we were granted down into a fresh local folder and start
/// syncing it. Returns the folder path (the app opens it as a workspace).
#[tauri::command]
pub(crate) async fn sync_connect(
    app: AppHandle,
    ws_id: String,
    name: String,
    dest_parent: String,
    connection_id: String,
) -> Result<String, String> {
    let (data_dir, _device) = with_inner(&app, |inner| {
        if inner.engines.contains_key(&ws_id) {
            return Err("this workspace already syncs on this machine".into());
        }
        Ok((inner.data_dir.clone(), inner.device.clone()))
    })?;
    let conn = read_connection(&data_dir, &connection_id)?;
    let remote = Arc::new(HttpRemote::new(&conn.endpoint, &conn.token, &ws_id));

    let (manifest, etag) = remote
        .fetch_manifest(None)
        .await
        .map_err(|e| match e {
            RemoteError::NotFound => "no such workspace on that backend (or not granted to you)".to_string(),
            RemoteError::Unauthorized => "the backend rejected this connection's token".to_string(),
            other => format!("couldn't reach the backend: {}", other),
        })?
        .ok_or_else(|| "backend returned no manifest".to_string())?;

    let dest = PathBuf::from(&dest_parent).join(sanitize_folder_name(&name));
    if dest.exists() {
        let occupied = std::fs::read_dir(&dest)
            .map(|mut d| d.next().is_some())
            .unwrap_or(true);
        if occupied {
            return Err(format!(
                "\"{}\" already exists and isn't empty — pick another location",
                dest.display()
            ));
        }
    }
    std::fs::create_dir_all(&dest).map_err(|e| format!("create {}: {}", dest.display(), e))?;

    let state_dir = data_dir.join("sync").join(&ws_id);
    let _ = std::fs::create_dir_all(state_dir.join("base"));

    let total = manifest.files.len();
    let mut done = 0usize;
    let mut states: BTreeMap<String, FileState> = BTreeMap::new();
    let mut set = tokio::task::JoinSet::new();
    let mut queue = manifest.files.clone().into_iter();
    loop {
        while set.len() < 4 {
            let Some((fid, rf)) = queue.next() else { break };
            let remote = remote.clone();
            set.spawn(async move {
                let bytes = remote.get_blob(&fid, &rf.hash).await;
                (fid, rf, bytes)
            });
        }
        let Some(joined) = set.join_next().await else { break };
        let (fid, rf, bytes) = joined.map_err(|e| format!("download task: {}", e))?;
        let bytes = bytes.map_err(|e| format!("download {}: {}", rf.path, e))?;
        let abs = dest.join(&rf.path);
        write_atomic(&abs, &bytes).map_err(|e| format!("write {}: {}", rf.path, e))?;
        let _ = write_atomic(&state_dir.join("base").join(&fid), &bytes);
        let (size, mtime_ms) = stat_pair(&abs);
        states.insert(
            fid,
            FileState { path: rf.path.clone(), rev: rf.rev, hash: rf.hash.clone(), size, mtime_ms },
        );
        done += 1;
        let _ = app.emit(
            "sync-progress",
            json!({ "wsId": ws_id, "kind": "download", "done": done, "total": total }),
        );
    }

    let state = WorkspaceState {
        version: 1,
        manifest_etag: Some(etag),
        manifest,
        files: states,
        ..Default::default()
    };
    write_json(&state_dir.join("state.json"), &state).map_err(|e| format!("save state: {}", e))?;

    let ws_cfg = WorkspaceConfig {
        id: ws_id.clone(),
        root: dest.to_string_lossy().to_string(),
        connection_id,
        name,
    };
    with_inner(&app, |inner| {
        let mut cfg = read_sync_config(&inner.data_dir);
        cfg.version = 1;
        cfg.device.get_or_insert_with(|| inner.device.clone());
        cfg.workspaces.retain(|w| w.id != ws_cfg.id);
        cfg.workspaces.push(ws_cfg.clone());
        write_sync_config(&inner.data_dir, &cfg)?;
        spawn_engine(inner, &ws_cfg);
        Ok(())
    })?;

    Ok(dest.to_string_lossy().to_string())
}

/// Stop syncing a workspace on this machine. Local files stay; the remote
/// copy stays; only this device's engine + state go away.
#[tauri::command]
pub(crate) fn sync_disable(app: AppHandle, ws_id: String) -> Result<(), String> {
    with_inner(&app, |inner| {
        if let Some(handle) = inner.engines.remove(&ws_id) {
            let _ = handle.tx.send(EngineCmd::Shutdown);
        }
        let mut cfg = read_sync_config(&inner.data_dir);
        cfg.workspaces.retain(|w| w.id != ws_id);
        write_sync_config(&inner.data_dir, &cfg)?;
        let _ = std::fs::remove_dir_all(inner.data_dir.join("sync").join(&ws_id));
        if let Ok(mut map) = inner.statuses.lock() {
            map.remove(&ws_id);
        }
        let _ = inner.app.emit("sync-status", json!({ "wsId": ws_id, "phase": "removed" }));
        Ok(())
    })
}

#[tauri::command]
pub(crate) fn sync_status(app: AppHandle) -> Result<Vec<WsStatus>, String> {
    with_inner(&app, |inner| {
        let map = inner.statuses.lock().map_err(|_| "statuses poisoned".to_string())?;
        let mut out: Vec<WsStatus> = map.values().cloned().collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    })
}

#[tauri::command]
pub(crate) fn sync_now(app: AppHandle, ws_id: String) -> Result<(), String> {
    with_inner(&app, |inner| {
        if let Some(h) = inner.engines.get(&ws_id) {
            let _ = h.tx.send(EngineCmd::SyncNow);
        }
        Ok(())
    })
}

#[tauri::command]
pub(crate) fn sync_pause(app: AppHandle, ws_id: String, paused: bool) -> Result<(), String> {
    with_inner(&app, |inner| {
        if let Some(h) = inner.engines.get(&ws_id) {
            let _ = h.tx.send(EngineCmd::Pause(paused));
        }
        Ok(())
    })
}

/// The frontend reports which document the user is actively editing (or
/// none). Routed to whichever engine's root contains the path.
#[tauri::command]
pub(crate) fn sync_set_activity(app: AppHandle, path: Option<String>) -> Result<(), String> {
    with_inner(&app, |inner| {
        match path {
            Some(p) => {
                let pb = PathBuf::from(&p);
                for h in inner.engines.values() {
                    if pb.starts_with(&h.root) {
                        let _ = h.tx.send(EngineCmd::SetActivity(Some(p.clone())));
                    } else {
                        let _ = h.tx.send(EngineCmd::SetActivity(None));
                    }
                }
            }
            None => {
                for h in inner.engines.values() {
                    let _ = h.tx.send(EngineCmd::SetActivity(None));
                }
            }
        }
        Ok(())
    })
}

/// User confirmed a mass deletion was intentional — let it propagate.
#[tauri::command]
pub(crate) fn sync_confirm_deletes(app: AppHandle, ws_id: String) -> Result<(), String> {
    with_inner(&app, |inner| {
        if let Some(h) = inner.engines.get(&ws_id) {
            let _ = h.tx.send(EngineCmd::ConfirmDeletes);
        }
        Ok(())
    })
}

/// The frontend mirrors share-registry changes for documents under a synced
/// root into the workspace manifest. `files` is keyed by workspace-relative
/// path, `collections` by collection page id; Some = publish/update the
/// record, None = forget it. Fire-and-forget: the engine queues the ops,
/// persists them, and carries them on its next won CAS.
#[tauri::command]
pub(crate) fn sync_set_shares(
    app: AppHandle,
    ws_id: String,
    files: BTreeMap<String, Option<ShareRef>>,
    collections: BTreeMap<String, Option<CollectionRef>>,
) -> Result<(), String> {
    with_inner(&app, |inner| {
        if let Some(h) = inner.engines.get(&ws_id) {
            let _ = h.tx.send(EngineCmd::SetShares { files, collections });
        }
        Ok(())
    })
}

/// This machine's stable device identity (id + editable display name) — the
/// frontend sends it along when joining a backend.
#[tauri::command]
pub(crate) fn sync_device(app: AppHandle) -> Result<DeviceIdentity, String> {
    with_inner(&app, |inner| Ok(inner.device.clone()))
}

/// Re-resolve connections after share.json changed (added/removed/rotated):
/// tear every engine down and spawn them fresh against the new credentials.
#[tauri::command]
pub(crate) fn sync_reload_connections(app: AppHandle) -> Result<(), String> {
    with_inner(&app, |inner| {
        for (_, handle) in inner.engines.drain() {
            let _ = handle.tx.send(EngineCmd::Shutdown);
        }
        if let Ok(mut map) = inner.statuses.lock() {
            map.clear();
        }
        let cfg = read_sync_config(&inner.data_dir);
        for ws in cfg.workspaces {
            spawn_engine(inner, &ws);
        }
        Ok(())
    })
}

/* ---------- Tests: the whole engine against an in-memory backend ---------- */

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    /// In-memory stand-in for the worker: a manifest with CAS-by-etag,
    /// content-addressed blobs, history archives. `racer` lets a test inject
    /// "another device won the CAS between your fetch and your put".
    #[derive(Default)]
    struct FakeBackend {
        manifest: Manifest,
        etag: u64,
        blobs: HashMap<(String, String), Vec<u8>>,
        histories: HashMap<String, HistoryArchive>,
        offline: bool,
        racer: Option<Manifest>,
        put_manifest_calls: u64,
    }

    impl FakeBackend {
        fn etag_str(&self) -> String {
            format!("e{}", self.etag)
        }
    }

    #[derive(Clone)]
    struct FakeRemote(Arc<StdMutex<FakeBackend>>);

    impl FakeRemote {
        fn check_offline(&self) -> RemoteResult<()> {
            if self.0.lock().unwrap().offline {
                Err(RemoteError::Offline("fake backend down".into()))
            } else {
                Ok(())
            }
        }
    }

    impl Remote for FakeRemote {
        fn poll(&self) -> impl std::future::Future<Output = RemoteResult<PollResponse>> + Send {
            let this = self.clone();
            async move {
                this.check_offline()?;
                let b = this.0.lock().unwrap();
                Ok(PollResponse { manifest_etag: b.etag_str(), presence: BTreeMap::new() })
            }
        }

        fn fetch_manifest(
            &self,
            since: Option<&str>,
        ) -> impl std::future::Future<Output = RemoteResult<Option<(Manifest, String)>>> + Send
        {
            let this = self.clone();
            let since = since.map(String::from);
            async move {
                this.check_offline()?;
                let b = this.0.lock().unwrap();
                if since.as_deref() == Some(b.etag_str().as_str()) {
                    return Ok(None);
                }
                Ok(Some((b.manifest.clone(), b.etag_str())))
            }
        }

        fn put_manifest(
            &self,
            manifest: &Manifest,
            base_etag: &str,
        ) -> impl std::future::Future<Output = RemoteResult<String>> + Send {
            let this = self.clone();
            let manifest = manifest.clone();
            let base = base_etag.to_string();
            async move {
                this.check_offline()?;
                let mut b = this.0.lock().unwrap();
                b.put_manifest_calls += 1;
                if let Some(racer) = b.racer.take() {
                    b.manifest = racer;
                    b.etag += 1;
                }
                if base != b.etag_str() {
                    return Err(RemoteError::Conflict { etag: b.etag_str() });
                }
                b.manifest = manifest;
                b.etag += 1;
                Ok(b.etag_str())
            }
        }

        fn get_blob(
            &self,
            file_id: &str,
            hash: &str,
        ) -> impl std::future::Future<Output = RemoteResult<Vec<u8>>> + Send {
            let this = self.clone();
            let key = (file_id.to_string(), hash.to_string());
            async move {
                this.check_offline()?;
                let b = this.0.lock().unwrap();
                b.blobs.get(&key).cloned().ok_or(RemoteError::NotFound)
            }
        }

        fn put_blob(
            &self,
            file_id: &str,
            hash: &str,
            bytes: Vec<u8>,
            _content_type: &str,
        ) -> impl std::future::Future<Output = RemoteResult<()>> + Send {
            let this = self.clone();
            let key = (file_id.to_string(), hash.to_string());
            async move {
                this.check_offline()?;
                this.0.lock().unwrap().blobs.insert(key, bytes);
                Ok(())
            }
        }

        fn list_blobs(
            &self,
            file_id: &str,
        ) -> impl std::future::Future<Output = RemoteResult<Vec<(String, u64)>>> + Send {
            let this = self.clone();
            let fid = file_id.to_string();
            async move {
                this.check_offline()?;
                let b = this.0.lock().unwrap();
                Ok(b.blobs
                    .keys()
                    .filter(|(f, _)| *f == fid)
                    .map(|(_, h)| (h.clone(), 0u64))
                    .collect())
            }
        }

        fn delete_blob(
            &self,
            file_id: &str,
            hash: &str,
        ) -> impl std::future::Future<Output = RemoteResult<()>> + Send {
            let this = self.clone();
            let key = (file_id.to_string(), hash.to_string());
            async move {
                this.0.lock().unwrap().blobs.remove(&key);
                Ok(())
            }
        }

        fn get_history(
            &self,
            file_id: &str,
        ) -> impl std::future::Future<Output = RemoteResult<Option<HistoryArchive>>> + Send
        {
            let this = self.clone();
            let fid = file_id.to_string();
            async move {
                this.check_offline()?;
                let b = this.0.lock().unwrap();
                Ok(b.histories.get(&fid).cloned())
            }
        }

        fn put_history(
            &self,
            file_id: &str,
            archive: &HistoryArchive,
        ) -> impl std::future::Future<Output = RemoteResult<()>> + Send {
            let this = self.clone();
            let fid = file_id.to_string();
            let archive = archive.clone();
            async move {
                this.0.lock().unwrap().histories.insert(fid, archive);
                Ok(())
            }
        }

        fn put_presence(
            &self,
            _device_id: &str,
            _name: &str,
            _file_id: Option<&str>,
            _path: Option<&str>,
        ) -> impl std::future::Future<Output = RemoteResult<()>> + Send {
            async move { Ok(()) }
        }
    }

    struct Device {
        engine: Engine<FakeRemote>,
        root: tempfile::TempDir,
        _state: tempfile::TempDir,
        statuses: Arc<Mutex<HashMap<String, WsStatus>>>,
    }

    fn device(name: &str, backend: &Arc<StdMutex<FakeBackend>>) -> Device {
        let root = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(state.path().join("base")).unwrap();
        let statuses: Arc<Mutex<HashMap<String, WsStatus>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let engine = Engine::new(
            EngineConfig {
                ws_id: "ws-test".into(),
                name: "Test".into(),
                root: root.path().to_path_buf(),
                connection_id: "c-test".into(),
                state_dir: state.path().to_path_buf(),
                device_id: format!("d-{}", name),
                device_name: name.to_string(),
                use_trash: false,
            },
            Arc::new(FakeRemote(backend.clone())),
            Arc::new(NullEvents),
            statuses.clone(),
        );
        Device { engine, root, _state: state, statuses }
    }

    impl Device {
        fn write(&self, rel: &str, content: &str) {
            let abs = self.root.path().join(rel);
            std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
            std::fs::write(abs, content).unwrap();
        }
        fn read(&self, rel: &str) -> Option<String> {
            std::fs::read_to_string(self.root.path().join(rel)).ok()
        }
        fn delete(&self, rel: &str) {
            let _ = std::fs::remove_file(self.root.path().join(rel));
        }
        fn rename(&self, from: &str, to: &str) {
            std::fs::rename(self.root.path().join(from), self.root.path().join(to)).unwrap();
        }
        fn files(&self) -> Vec<String> {
            scan_local(self.root.path()).unwrap().keys().cloned().collect()
        }
        async fn cycle(&mut self) {
            self.engine.cycle().await.expect("cycle failed");
        }
        fn phase(&self) -> String {
            self.statuses
                .lock()
                .unwrap()
                .get("ws-test")
                .map(|s| s.phase.clone())
                .unwrap_or_default()
        }
    }

    fn backend() -> Arc<StdMutex<FakeBackend>> {
        Arc::new(StdMutex::new(FakeBackend::default()))
    }

    #[tokio::test]
    async fn initial_push_then_second_device_pulls() {
        let be = backend();
        let mut a = device("Alice", &be);
        a.write("notes/hello.md", "# hello\n");
        a.write("readme.md", "root doc\n");
        a.cycle().await;

        {
            let b = be.lock().unwrap();
            assert_eq!(b.manifest.files.len(), 2);
            assert!(b.manifest.files.values().all(|f| f.rev == 1 && f.by == "Alice"));
        }

        let mut bdev = device("Bob", &be);
        bdev.cycle().await;
        assert_eq!(bdev.read("notes/hello.md").as_deref(), Some("# hello\n"));
        assert_eq!(bdev.read("readme.md").as_deref(), Some("root doc\n"));
    }

    #[tokio::test]
    async fn edit_propagates_and_builds_history() {
        let be = backend();
        let mut a = device("Alice", &be);
        let mut b = device("Bob", &be);
        a.write("doc.md", "v1 content\n");
        a.cycle().await;
        b.cycle().await;

        a.write("doc.md", "v2 content, longer\n");
        a.cycle().await;
        b.cycle().await;
        assert_eq!(b.read("doc.md").as_deref(), Some("v2 content, longer\n"));

        let be2 = be.lock().unwrap();
        let f = be2.manifest.files.values().next().unwrap();
        assert_eq!(f.rev, 2);
        assert_eq!(f.hist.len(), 1);
        assert_eq!(f.hist[0].r, 1);
    }

    #[tokio::test]
    async fn concurrent_distinct_files_converge_via_cas_retry() {
        let be = backend();
        let mut a = device("Alice", &be);
        let mut b = device("Bob", &be);
        a.write("a.md", "alpha v1\n");
        a.cycle().await;
        b.cycle().await;

        // Alice pushes an edit normally…
        a.write("a.md", "alpha v2 — bigger\n");
        a.cycle().await;

        // …and a "third device" steals the CAS from Bob mid-put: build a
        // racer manifest on top of the current one adding x.md.
        let racer = {
            let mut be2 = be.lock().unwrap();
            let mut m = be2.manifest.clone();
            m.seq += 1;
            let bytes = b"from the racer\n".to_vec();
            let hash = hash16(&bytes);
            be2.blobs.insert(("f-racer".into(), hash.clone()), bytes.clone());
            m.files.insert(
                "f-racer".into(),
                ManifestFile {
                    path: "x.md".into(),
                    rev: 1,
                    hash,
                    size: bytes.len() as u64,
                    mtime: now_ms(),
                    by: "Racer".into(),
                    hist: vec![],
                },
            );
            be2.racer = Some(m);
            be2.put_manifest_calls
        };
        let _ = racer;

        b.write("b.md", "bob's brand new file\n");
        b.cycle().await; // loses first CAS, retries, lands everything

        let be2 = be.lock().unwrap();
        let paths: Vec<String> = be2.manifest.files.values().map(|f| f.path.clone()).collect();
        assert!(paths.contains(&"a.md".to_string()));
        assert!(paths.contains(&"b.md".to_string()));
        assert!(paths.contains(&"x.md".to_string()));
        assert!(be2.put_manifest_calls >= 2, "bob must have retried the CAS");
        drop(be2);

        // Bob also picked up both other-device files on the way.
        assert_eq!(b.read("a.md").as_deref(), Some("alpha v2 — bigger\n"));
        assert_eq!(b.read("x.md").as_deref(), Some("from the racer\n"));
    }

    #[tokio::test]
    async fn same_file_different_lines_merges_clean() {
        let be = backend();
        let mut a = device("Alice", &be);
        let mut b = device("Bob", &be);
        a.write("doc.md", "line one\nline two\nline three\n");
        a.cycle().await;
        b.cycle().await;

        a.write("doc.md", "line one — ALICE\nline two\nline three\n");
        a.cycle().await;
        // Bob edits the far end without having seen Alice's change.
        b.write("doc.md", "line one\nline two\nline three — BOB\n");
        b.cycle().await;

        let merged = "line one — ALICE\nline two\nline three — BOB\n";
        assert_eq!(b.read("doc.md").as_deref(), Some(merged));
        a.cycle().await;
        assert_eq!(a.read("doc.md").as_deref(), Some(merged));
        // No conflict copies anywhere.
        assert_eq!(a.files().len(), 1);
        assert_eq!(b.files().len(), 1);
    }

    #[tokio::test]
    async fn same_line_conflict_keeps_both_versions() {
        let be = backend();
        let mut a = device("Alice", &be);
        let mut b = device("Bob", &be);
        a.write("doc.md", "shared line\n");
        a.cycle().await;
        b.cycle().await;

        a.write("doc.md", "alice's take on the line\n");
        a.cycle().await;
        b.write("doc.md", "bob's very different take\n");
        b.cycle().await;

        // Bob keeps his content in the live doc; Alice's lands as a copy.
        assert_eq!(b.read("doc.md").as_deref(), Some("bob's very different take\n"));
        let copies: Vec<String> =
            b.files().into_iter().filter(|p| p.contains("(conflict — Alice")).collect();
        assert_eq!(copies.len(), 1, "exactly one conflict copy, got {:?}", b.files());
        assert_eq!(b.read(&copies[0]).as_deref(), Some("alice's take on the line\n"));

        // Alice converges to the same pair of files.
        a.cycle().await;
        assert_eq!(a.read("doc.md").as_deref(), Some("bob's very different take\n"));
        assert_eq!(a.read(&copies[0]).as_deref(), Some("alice's take on the line\n"));
    }

    #[tokio::test]
    async fn delete_propagates() {
        let be = backend();
        let mut a = device("Alice", &be);
        let mut b = device("Bob", &be);
        a.write("keep.md", "keeper\n");
        a.write("gone.md", "doomed\n");
        a.cycle().await;
        b.cycle().await;

        a.delete("gone.md");
        a.cycle().await;
        {
            let be2 = be.lock().unwrap();
            assert_eq!(be2.manifest.files.len(), 1);
            assert_eq!(be2.manifest.tombstones.len(), 1);
        }
        b.cycle().await;
        assert!(b.read("gone.md").is_none());
        assert_eq!(b.read("keep.md").as_deref(), Some("keeper\n"));
    }

    #[tokio::test]
    async fn local_edit_beats_remote_delete() {
        let be = backend();
        let mut a = device("Alice", &be);
        let mut b = device("Bob", &be);
        a.write("doc.md", "original\n");
        a.cycle().await;
        b.cycle().await;

        a.delete("doc.md");
        a.cycle().await;
        // Bob edited before learning of the deletion.
        b.write("doc.md", "bob kept working on this\n");
        b.cycle().await;

        assert_eq!(b.read("doc.md").as_deref(), Some("bob kept working on this\n"));
        {
            let be2 = be.lock().unwrap();
            assert_eq!(be2.manifest.files.len(), 1, "the edit resurrected the doc");
        }
        a.cycle().await;
        assert_eq!(a.read("doc.md").as_deref(), Some("bob kept working on this\n"));
    }

    #[tokio::test]
    async fn mass_delete_holds_until_confirmed() {
        let be = backend();
        let mut a = device("Alice", &be);
        for i in 0..10 {
            a.write(&format!("doc{}.md", i), &format!("content number {}\n", i));
        }
        a.cycle().await;

        for i in 0..6 {
            a.delete(&format!("doc{}.md", i));
        }
        a.cycle().await;
        {
            let be2 = be.lock().unwrap();
            assert_eq!(be2.manifest.files.len(), 10, "deletes must be held");
        }
        assert_eq!(a.phase(), "pending-deletes");

        a.engine.confirm_deletes();
        a.cycle().await;
        {
            let be2 = be.lock().unwrap();
            assert_eq!(be2.manifest.files.len(), 4);
            assert_eq!(be2.manifest.tombstones.len(), 6);
        }
        assert_eq!(a.phase(), "idle");
    }

    #[tokio::test]
    async fn rename_is_metadata_only_and_propagates() {
        let be = backend();
        let mut a = device("Alice", &be);
        let mut b = device("Bob", &be);
        a.write("old-name.md", "stable content that does not change\n");
        a.cycle().await;
        b.cycle().await;

        let fid_before: String = {
            let be2 = be.lock().unwrap();
            be2.manifest.files.keys().next().unwrap().clone()
        };

        a.rename("old-name.md", "new-name.md");
        a.cycle().await;
        {
            let be2 = be.lock().unwrap();
            assert_eq!(be2.manifest.files.len(), 1, "a rename must not fork the file");
            let (fid, f) = be2.manifest.files.iter().next().unwrap();
            assert_eq!(*fid, fid_before, "same identity across the rename");
            assert_eq!(f.path, "new-name.md");
        }

        b.cycle().await;
        assert!(b.read("old-name.md").is_none());
        assert_eq!(b.read("new-name.md").as_deref(), Some("stable content that does not change\n"));
    }

    #[tokio::test]
    async fn history_rolls_over_into_archive() {
        let be = backend();
        let mut a = device("Alice", &be);
        a.write("doc.md", "revision 0 --------\n");
        a.cycle().await;
        for i in 1..=13 {
            a.write("doc.md", &format!("revision {} {}\n", i, "-".repeat(i)));
            a.cycle().await;
        }
        let be2 = be.lock().unwrap();
        let (fid, f) = be2.manifest.files.iter().next().unwrap();
        assert_eq!(f.rev, 14);
        assert_eq!(f.hist.len(), MANIFEST_HIST_MAX);
        let archive = be2.histories.get(fid).expect("archive exists after rollover");
        assert!(!archive.entries.is_empty());
        // Every past revision is retrievable from inline hist + archive.
        let mut revs: Vec<u64> = f.hist.iter().map(|h| h.r).collect();
        revs.extend(archive.entries.iter().map(|h| h.r));
        revs.sort_unstable();
        revs.dedup();
        assert_eq!(revs, (1..=13).collect::<Vec<u64>>());
        // And every referenced blob actually exists.
        for h in f.hist.iter().map(|h| &h.h).chain(archive.entries.iter().map(|h| &h.h)) {
            assert!(be2.blobs.contains_key(&(fid.clone(), h.clone())));
        }
    }

    #[tokio::test]
    async fn offline_reports_and_recovers() {
        let be = backend();
        let mut a = device("Alice", &be);
        a.write("doc.md", "important words\n");
        be.lock().unwrap().offline = true;
        assert!(a.engine.cycle().await.is_err());
        assert_eq!(a.phase(), "offline");

        be.lock().unwrap().offline = false;
        a.cycle().await;
        assert_eq!(a.phase(), "idle");
        let be2 = be.lock().unwrap();
        assert_eq!(be2.manifest.files.len(), 1);
    }

    #[tokio::test]
    async fn quiet_cycles_change_nothing() {
        let be = backend();
        let mut a = device("Alice", &be);
        a.write("doc.md", "steady state\n");
        a.cycle().await;
        let (seq, etag, calls) = {
            let be2 = be.lock().unwrap();
            (be2.manifest.seq, be2.etag, be2.put_manifest_calls)
        };
        a.cycle().await;
        a.cycle().await;
        let be2 = be.lock().unwrap();
        assert_eq!(be2.manifest.seq, seq);
        assert_eq!(be2.etag, etag);
        assert_eq!(be2.put_manifest_calls, calls, "no-op cycles must not write");
    }

    #[tokio::test]
    async fn raced_same_path_creates_deduped_deterministically() {
        let be = backend();
        let mut a = device("Alice", &be);
        let mut b = device("Bob", &be);
        // Both invent the same filename before ever syncing.
        a.write("ideas.md", "alice ideas\n");
        b.write("ideas.md", "bob ideas — different\n");
        a.cycle().await;
        b.cycle().await; // b fetches a's manifest first, adopts the fid, merges

        a.cycle().await;
        b.cycle().await;

        // Converged: no duplicate path in the manifest, both devices hold the
        // same file set, and no content vanished.
        let be2 = be.lock().unwrap();
        let mut paths: Vec<String> =
            be2.manifest.files.values().map(|f| f.path.clone()).collect();
        paths.sort();
        let mut deduped = paths.clone();
        deduped.dedup();
        assert_eq!(paths, deduped, "no two files may share a path");
        drop(be2);
        let a_files = a.files();
        let b_files = b.files();
        assert_eq!(a_files, b_files, "device file sets must converge");
        let joined: String = a_files.iter().filter_map(|p| a.read(p)).collect();
        assert!(joined.contains("alice ideas") || joined.contains("bob ideas"));
    }

    /* ---------- Share registry riding the manifest ---------- */

    impl Device {
        fn queue_share(&mut self, path: &str, share: Option<ShareRef>) {
            self.engine.state.share_ops.insert(path.to_string(), share);
        }
        fn queue_collection(&mut self, cid: &str, col: Option<CollectionRef>) {
            self.engine.state.collection_ops.insert(cid.to_string(), col);
        }
        fn ws_shares(&self) -> Vec<WsShare> {
            self.statuses
                .lock()
                .unwrap()
                .get("ws-test")
                .map(|s| s.shares.clone())
                .unwrap_or_default()
        }
    }

    fn share(id: &str, title: &str) -> ShareRef {
        ShareRef {
            id: id.into(),
            path: String::new(), // the engine stamps the real path on apply
            cid: None,
            title: title.into(),
            by: "Alice".into(),
            at: 1,
        }
    }

    #[tokio::test]
    async fn share_op_publishes_and_mirrors_to_other_device() {
        let be = backend();
        let mut a = device("Alice", &be);
        let mut b = device("Bob", &be);
        a.write("doc.md", "# doc\n");
        a.cycle().await;
        b.cycle().await;

        a.queue_share("doc.md", Some(share("page1", "Doc")));
        a.cycle().await;
        assert!(a.engine.state.share_ops.is_empty(), "carried op must clear");
        {
            let be2 = be.lock().unwrap();
            assert_eq!(be2.manifest.shares.len(), 1);
            let (fid, s) = be2.manifest.shares.iter().next().unwrap();
            assert!(be2.manifest.files.contains_key(fid));
            assert_eq!(s.path, "doc.md");
            assert_eq!(s.id, "page1");
        }

        b.cycle().await;
        let seen = b.ws_shares();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].id, "page1");
        assert_eq!(seen[0].path, "doc.md");
        assert!(seen[0].alive);
    }

    #[tokio::test]
    async fn share_follows_rename_and_survives_lost_cas() {
        let be = backend();
        let mut a = device("Alice", &be);
        let mut b = device("Bob", &be);
        a.write("doc.md", "# doc\n");
        a.write("other.md", "# other\n");
        a.queue_share("doc.md", Some(share("page1", "Doc")));
        a.cycle().await;
        b.cycle().await;

        // Bob renames the shared file — no ops anywhere, the share is
        // fileId-keyed and only its recorded path re-points.
        std::fs::create_dir_all(b.root.path().join("sub")).unwrap();
        b.rename("doc.md", "sub/renamed.md");
        b.cycle().await;
        {
            let be2 = be.lock().unwrap();
            let s = be2.manifest.shares.values().next().unwrap();
            assert_eq!(s.id, "page1");
            assert_eq!(s.path, "sub/renamed.md");
        }

        // A share op queued behind a lost CAS lands on the retry, on top of
        // whatever the winner wrote.
        a.cycle().await; // catch up with the rename first
        a.queue_share("other.md", Some(share("page2", "Other")));
        {
            let mut be2 = be.lock().unwrap();
            let mut raced = be2.manifest.clone();
            raced.seq += 1;
            raced.name = "Raced".into();
            be2.racer = Some(raced);
        }
        a.cycle().await;
        let be2 = be.lock().unwrap();
        assert_eq!(be2.manifest.name, "Raced", "the racer's write must survive");
        assert_eq!(be2.manifest.shares.len(), 2);
        assert!(be2.manifest.shares.values().any(|s| s.id == "page2" && s.path == "other.md"));
    }

    #[tokio::test]
    async fn share_only_change_commits_once_then_stays_quiet() {
        let be = backend();
        let mut a = device("Alice", &be);
        a.write("doc.md", "# doc\n");
        a.cycle().await;

        let before = be.lock().unwrap().put_manifest_calls;
        a.queue_share("doc.md", Some(share("page1", "Doc")));
        a.cycle().await;
        let after_op = be.lock().unwrap().put_manifest_calls;
        assert_eq!(after_op, before + 1, "a share toggle alone must still commit");

        a.cycle().await;
        assert_eq!(
            be.lock().unwrap().put_manifest_calls,
            after_op,
            "a no-op cycle must not CAS"
        );
    }

    #[tokio::test]
    async fn deleted_file_share_goes_dead_then_rebinds_on_recreate() {
        let be = backend();
        let mut a = device("Alice", &be);
        a.write("doc.md", "# doc\n");
        a.queue_share("doc.md", Some(share("page1", "Doc")));
        a.cycle().await;
        let old_fid = be.lock().unwrap().manifest.shares.keys().next().unwrap().clone();

        // Delete: the file tombstones, the share stays (its page lives until
        // stopped explicitly) — but flagged dead, so mirrors and TOCs drop it.
        a.delete("doc.md");
        a.cycle().await;
        {
            let be2 = be.lock().unwrap();
            assert!(be2.manifest.files.is_empty());
            assert_eq!(be2.manifest.shares.len(), 1);
            assert_eq!(be2.manifest.shares[&old_fid].path, "doc.md");
        }
        let seen = a.ws_shares();
        assert_eq!(seen.len(), 1);
        assert!(!seen[0].alive);

        // Recreate at the same path: the share adopts the new fileId and the
        // page keeps flowing.
        a.write("doc.md", "# reborn\n");
        a.cycle().await;
        let be2 = be.lock().unwrap();
        assert_eq!(be2.manifest.shares.len(), 1);
        let (fid, s) = be2.manifest.shares.iter().next().unwrap();
        assert_ne!(*fid, old_fid, "recreated file gets a fresh fileId");
        assert!(be2.manifest.files.contains_key(fid));
        assert_eq!(s.id, "page1");
        drop(be2);
        assert!(a.ws_shares()[0].alive);
    }

    #[tokio::test]
    async fn stopping_a_collection_releases_member_cids() {
        let be = backend();
        let mut a = device("Alice", &be);
        a.write("notes/doc.md", "# doc\n");
        let mut s = share("page1", "Doc");
        s.cid = Some("toc1".into());
        a.queue_share("notes/doc.md", Some(s));
        a.queue_collection(
            "toc1",
            Some(CollectionRef {
                path: "notes".into(),
                title: "Notes".into(),
                desc: Some("the notes".into()),
                by: "Alice".into(),
                at: 1,
            }),
        );
        a.cycle().await;
        {
            let be2 = be.lock().unwrap();
            assert_eq!(be2.manifest.collections["toc1"].title, "Notes");
            assert_eq!(
                be2.manifest.shares.values().next().unwrap().cid.as_deref(),
                Some("toc1")
            );
        }

        a.queue_collection("toc1", None);
        a.cycle().await;
        let be2 = be.lock().unwrap();
        assert!(be2.manifest.collections.is_empty());
        assert_eq!(be2.manifest.shares.values().next().unwrap().cid, None);
    }

    #[tokio::test]
    async fn share_op_for_missing_file_waits_but_shows_in_effective_view() {
        let be = backend();
        let mut a = device("Alice", &be);
        a.write("doc.md", "# doc\n");
        a.cycle().await;

        let before = be.lock().unwrap().put_manifest_calls;
        a.queue_share("later.md", Some(share("page9", "Later")));
        a.cycle().await;
        // Nothing to bind to yet: no CAS wasted, op still queued — but the
        // status mirror already reports it, so the frontend never un-mirrors
        // the user's fresh share.
        assert_eq!(be.lock().unwrap().put_manifest_calls, before);
        assert_eq!(a.engine.state.share_ops.len(), 1);
        assert!(a.ws_shares().iter().any(|s| s.path == "later.md" && s.id == "page9"));

        a.write("later.md", "# here now\n");
        a.cycle().await;
        assert!(a.engine.state.share_ops.is_empty());
        let be2 = be.lock().unwrap();
        assert!(be2.manifest.shares.values().any(|s| s.path == "later.md" && s.id == "page9"));
    }
}
