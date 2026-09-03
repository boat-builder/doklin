//! The engine: one task per connected workspace, the only code that holds a
//! token or talks to the worker (docs/cloud-redesign.md §6).
//!
//! Bidirectional, state-based sync between a local workspace folder and its
//! domain. Disk stays the source of truth; the remote side is a manifest
//! (updated by compare-and-swap on its R2 etag) plus immutable,
//! content-addressed blobs — so concurrent writers can never clobber each
//! other's bytes, and every revision stays retrievable for version history.
//!
//! Concurrency model: edits to different files always converge; concurrent
//! edits to the same file get a three-way text merge against the last-synced
//! base, and genuinely overlapping edits fall back to a conflict copy next
//! to the original — nothing is ever lost. Presence ("Alice is editing…")
//! makes that rare in practice.
//!
//! The engine wakes on four things — the edit bus, the filesystem watcher,
//! the poll clock, commands — and does one of two: a *cycle* (full
//! reconcile, `cycle()`, deliberately the only place local and remote state
//! meet) or a *poll* (etag + presence). It also owns the public map's queued
//! ops (folded into the manifest it publishes), history reads, presence, and
//! the one status event that is the frontend's entire model. Generic over
//! [`Remote`] so all of it runs in tests against an in-memory worker.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use super::manifest::{
    clean_text, dedupe_paths, files_under, random_slug, unique_slug, valid_rel_path, valid_slug,
    HistEntry, HistoryArchive, Manifest, ManifestFile, PublicEntry, PublicKind, Target, Tombstone,
    HISTORY_VERSION, MANIFEST_VERSION, MAX_DESC_LEN, MAX_NAME_LEN, MAX_TITLE_LEN,
};
use super::merge::{conflict_copy_path, merge_texts, MergeOutcome};
use super::remote::{Remote, RemoteError, RemoteResult};
use super::scan::{
    content_type_for, hash16, now_ms, random_id, read_file_checked, read_json, rel_path, scan_local,
    stat_pair, write_atomic, write_json, ScanEntry,
};
use super::status::{
    emit_statuses, CloudStatus, Events, Phase, PresenceDevice, PublicPage, Revision, StatusTable,
    EV_APPLIED, EV_CONFLICT, EV_PENDING_DELETES,
};

/* ---------- Tunables ---------- */

/// How much per-file history rides inline in the manifest (the worker
/// accepts up to `MAX_INLINE_HIST`); older entries roll into the per-file
/// archive object (worker cap: 200).
pub const MANIFEST_HIST_MAX: usize = 10;
const _: () = assert!(MANIFEST_HIST_MAX <= super::manifest::MAX_INLINE_HIST, "the worker would refuse the inline history");
const ARCHIVE_HIST_MAX: usize = 200;
/// Poll cadence. Edits trigger cycles through the bus and the watcher, so
/// this is the ceiling on how stale a quiet workspace can get, not the feel
/// of sync.
pub const POLL_INTERVAL: Duration = Duration::from_secs(15);
/// Filesystem events (external editors, git, Finder) batch this long before
/// a cycle runs.
pub const FS_SETTLE: Duration = Duration::from_millis(5000);
/// The app's own writes (the edit bus) settle this long after the last
/// touch — autosave is already debounced 600 ms upstream, so an edit reaches
/// the cloud about two seconds after the keystroke.
pub const TOUCH_SETTLE: Duration = Duration::from_millis(1500);
/// Presence heartbeat cadence + how recent activity must be to count as
/// "editing".
const PRESENCE_BEAT: Duration = Duration::from_secs(25);
const ACTIVITY_FRESH: Duration = Duration::from_secs(90);
/// Tombstones older than this get dropped from the manifest by whoever
/// writes it next.
const TOMBSTONE_TTL_MS: u64 = 30 * 24 * 60 * 60 * 1000;
/// Mass-delete valve: if more than this share of the workspace vanishes in
/// one scan (and more than a handful of files), don't propagate — hold and
/// ask. Protects against an unmounted/renamed folder nuking the remote.
const MASS_DELETE_PCT: usize = 30;
const MASS_DELETE_MIN: usize = 5;
/// Blob GC runs opportunistically on this fraction of cycles.
const GC_EVERY_N_CYCLES: u64 = 20;
/// A blob must be at least this old before GC may take it (a racing pusher
/// may have uploaded it moments ago, ahead of its manifest CAS).
const GC_MIN_AGE_MS: u64 = 24 * 60 * 60 * 1000;
const CAS_ATTEMPTS: usize = 4;

/* ---------- Local persistent state ---------- */

/// Per-file record of the last state this device synced: enough to detect
/// local edits cheaply (snapshot first, hash only on drift) and to name the
/// base content for three-way merges (base/<fileId> holds those bytes).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FileState {
    pub path: String,
    pub rev: u64,
    pub hash: String,
    pub size: u64,
    pub mtime_ms: u64,
}

/// A public-map edit this device owes the manifest, keyed by slug. Kept
/// (and persisted, so a page published offline survives a restart) until a
/// won CAS carries it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum PublicOp {
    Put(PendingPublic),
    Remove,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PendingPublic {
    pub kind: PublicKind,
    /// The file id when it was known at queue time; resolved by path at
    /// fold time otherwise (a file created offline has no id yet).
    #[serde(default)]
    pub file: Option<String>,
    pub path: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub desc: Option<String>,
    /// The user chose this slug (a race re-keys the loser); a random slug
    /// yields to an existing page for the same target instead.
    #[serde(default)]
    pub custom: bool,
    #[serde(default)]
    pub by: String,
    #[serde(default)]
    pub at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct WorkspaceState {
    pub version: u32,
    /// Etag of the last manifest this device applied.
    pub manifest_etag: Option<String>,
    /// The manifest as of that etag — what remote diffs compare against.
    pub manifest: Manifest,
    /// fileId -> last-synced local state.
    pub files: BTreeMap<String, FileState>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub public_ops: BTreeMap<String, PublicOp>,
    /// A pending "make this the root page" (`Some(None)` clears the root).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_op: Option<Option<String>>,
}

/* ---------- Commands ---------- */

pub struct PublishRequest {
    /// Workspace-relative; `""` publishes the workspace root as a folder.
    pub rel: String,
    pub kind: PublicKind,
    pub slug: Option<String>,
    pub title: Option<String>,
    pub desc: Option<String>,
}

pub enum EngineCmd {
    SyncNow,
    /// The edit bus: a workspace-relative path the app just wrote.
    Touched(String),
    /// The absolute path the user is editing, or nothing.
    SetActivity(Option<String>),
    Pause(bool),
    ConfirmDeletes,
    Publish {
        req: PublishRequest,
        reply: oneshot::Sender<Result<String, String>>,
    },
    Unpublish {
        slug: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    SetRoot {
        slug: Option<String>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    History {
        rel: String,
        reply: oneshot::Sender<Result<Vec<Revision>, String>>,
    },
    Revision {
        rel: String,
        hash: String,
        reply: oneshot::Sender<Result<String, String>>,
    },
    Shutdown,
}

/* ---------- The engine ---------- */

pub struct EngineConfig {
    pub ws_id: String,
    pub name: String,
    pub root: PathBuf,
    pub domain: String,
    pub endpoint: String,
    pub state_dir: PathBuf,
    pub device_id: String,
    pub device_name: String,
    /// Real deletions go to the macOS Trash; tests flip this off.
    pub use_trash: bool,
}

pub struct Engine<R: Remote> {
    cfg: EngineConfig,
    remote: Arc<R>,
    events: Arc<dyn Events>,
    statuses: StatusTable,
    pub(crate) state: WorkspaceState,
    phase: Phase,
    error: Option<String>,
    last_sync_ms: Option<u64>,
    paused: bool,
    /// Set when the worker answered `426`: the worker version we saw it at.
    /// Cycles stop until `/api/meta` reports a newer worker.
    outdated: Option<u32>,
    worker_version: Option<u32>,
    /// Absolute path the user is actively editing (frontend-reported).
    activity: Option<(String, Instant)>,
    last_beat: Option<Instant>,
    beaconed: Option<String>,
    presence: Vec<PresenceDevice>,
    /// Deletions held back by the mass-delete valve, waiting for a user go.
    held_deletes: Vec<String>,
    allow_mass_delete: bool,
    cycles: u64,
    /// fileIds whose blobs are worth a GC look (they rolled history).
    gc_candidates: Vec<String>,
    /// Paths the edit bus reported since the last cycle — a hint about when,
    /// never what: the scan decides.
    dirty: HashSet<String>,
}

/// What one reconcile pass decided to do. Split out for testability.
#[derive(Default, Debug)]
pub(crate) struct Staged {
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

/// What `fold_public` folded in: the op keys the caller clears once the CAS
/// carrying them wins.
#[derive(Default, Debug)]
struct Folded {
    slugs: Vec<String>,
    root: bool,
}

impl<R: Remote> Engine<R> {
    pub fn new(cfg: EngineConfig, remote: Arc<R>, events: Arc<dyn Events>, statuses: StatusTable) -> Self {
        let state: WorkspaceState = read_json(&cfg.state_dir.join("state.json")).unwrap_or_default();
        Engine {
            cfg,
            remote,
            events,
            statuses,
            state,
            phase: Phase::Idle,
            error: None,
            last_sync_ms: None,
            paused: false,
            outdated: None,
            worker_version: None,
            activity: None,
            last_beat: None,
            beaconed: None,
            presence: Vec::new(),
            held_deletes: Vec::new(),
            allow_mass_delete: false,
            cycles: 0,
            gc_candidates: Vec::new(),
            dirty: HashSet::new(),
        }
    }


    fn root_key(&self) -> String {
        self.cfg.root.to_string_lossy().to_string()
    }

    fn base_path(&self, file_id: &str) -> PathBuf {
        self.cfg.state_dir.join("base").join(file_id)
    }

    fn persist_state(&self) {
        let _ = write_json(&self.cfg.state_dir.join("state.json"), &self.state);
    }

    fn can_cycle(&self) -> bool {
        !self.paused && self.outdated.is_none()
    }

    /* ----- status ----- */

    /// The public map as this device believes it: the last applied manifest
    /// overlaid with the ops queued here — the same resolution `fold_public`
    /// will apply, so the frontend never sees its own fresh page as missing.
    pub(crate) fn effective_public(&self) -> BTreeMap<String, PublicEntry> {
        let mut map = self.state.manifest.public.clone();
        for (slug, op) in &self.state.public_ops {
            match op {
                PublicOp::Remove => {
                    map.remove(slug);
                }
                PublicOp::Put(p) => {
                    let file = match p.kind {
                        PublicKind::File => p
                            .file
                            .clone()
                            .filter(|f| self.state.files.contains_key(f))
                            .or_else(|| self.file_id_at(&p.path)),
                        PublicKind::Dir => None,
                    };
                    let target = match p.kind {
                        PublicKind::File => file.clone().map(Target::File),
                        PublicKind::Dir => Some(Target::Dir(p.path.clone())),
                    };
                    let mut at = slug.clone();
                    let mut carried: Option<PublicEntry> = None;
                    if let Some(t) = &target {
                        let other = map
                            .iter()
                            .find(|(s, e)| *s != slug && e.target().as_ref() == Some(t))
                            .map(|(s, _)| s.clone());
                        if let Some(other) = other {
                            if p.custom {
                                carried = map.remove(&other);
                            } else {
                                at = other;
                            }
                        }
                    }
                    let prev = map
                        .get(&at)
                        .filter(|e| target.is_some() && e.target() == target)
                        .cloned()
                        .or(carried);
                    map.insert(at, merged_entry(p, file, prev));
                }
            }
        }
        if let Some(op) = &self.state.root_op {
            for e in map.values_mut() {
                e.root = false;
            }
            if let Some(slug) = op {
                if let Some(e) = map.get_mut(slug) {
                    e.root = true;
                }
            }
        }
        map
    }

    fn public_pages(&self) -> Vec<PublicPage> {
        let m = &self.state.manifest;
        let mut pages: Vec<PublicPage> = self
            .effective_public()
            .into_iter()
            .map(|(slug, e)| {
                let alive = match e.kind {
                    PublicKind::File => match &e.file {
                        Some(fid) => m.files.contains_key(fid) || self.state.files.contains_key(fid),
                        None => true, // queued for a file that hasn't synced yet
                    },
                    PublicKind::Dir => e.path.is_empty() || files_under(m, &e.path).next().is_some(),
                };
                PublicPage {
                    slug,
                    kind: e.kind,
                    path: e.path,
                    title: e.title,
                    desc: e.desc,
                    by: e.by,
                    at: e.at,
                    alive,
                    root: e.root,
                }
            })
            .collect();
        // Folders above files, then by path — the Published list's order.
        pages.sort_by(|a, b| {
            let rank = |p: &PublicPage| if p.kind == PublicKind::Dir { 0 } else { 1 };
            rank(a).cmp(&rank(b)).then_with(|| a.path.cmp(&b.path)).then_with(|| a.slug.cmp(&b.slug))
        });
        pages
    }

    fn set_status(&mut self, phase: Phase, error: Option<String>) {
        self.phase = phase;
        self.error = error;
        self.refresh_status();
    }

    /// Re-emit the current phase (presence moved, an op was queued).
    fn refresh_status(&self) {
        let status = CloudStatus {
            root: self.root_key(),
            domain: self.cfg.domain.clone(),
            endpoint: self.cfg.endpoint.clone(),
            ws_id: self.cfg.ws_id.clone(),
            name: self.cfg.name.clone(),
            phase: self.phase,
            last_sync_ms: self.last_sync_ms,
            error: self.error.clone(),
            pending_deletes: self.held_deletes.len() as u32,
            worker_version: self.worker_version,
            public: self.public_pages(),
            presence: self.presence.clone(),
        };
        if let Ok(mut table) = self.statuses.lock() {
            table.insert(self.root_key(), status);
        }
        emit_statuses(self.events.as_ref(), &self.statuses);
    }

    /// `/api/meta`: learn the worker's version — and, after a `426`, whether
    /// the worker has been updated since.
    pub(crate) async fn probe_worker(&mut self) {
        if let Ok(meta) = self.remote.meta().await {
            self.worker_version = Some(meta.version);
            if let Some(seen_at) = self.outdated {
                if meta.version > seen_at {
                    self.outdated = None;
                }
            }
        }
    }

    /* ----- the cycle ----- */

    /// The whole engine in one place: pull remote reality, apply what only
    /// changed there, work out what changed here, merge where both moved,
    /// then CAS our view in. Loops on a lost CAS with fresh remote state.
    pub async fn cycle(&mut self) -> RemoteResult<()> {
        if self.outdated.is_some() {
            return Ok(()); // waiting for the worker update; nothing to do
        }
        if !self.cfg.root.is_dir() {
            // Root missing (unmounted disk, renamed folder…): touch nothing.
            self.set_status(Phase::Error, Some("workspace folder is missing — sync is paused".into()));
            return Ok(());
        }
        self.set_status(Phase::Syncing, None);
        self.cycles += 1;
        self.dirty.clear();

        // All the fallible work lives in cycle_inner so that EVERY exit —
        // offline mid-download, a revoked token, a lost CAS — funnels through
        // this one status report.
        let result = self.cycle_inner().await;

        match &result {
            Ok(changed_paths) => {
                if !changed_paths.is_empty() {
                    self.events.emit_json(
                        EV_APPLIED,
                        json!({ "root": self.root_key(), "paths": changed_paths }),
                    );
                }
                self.last_sync_ms = Some(now_ms());
                if !self.held_deletes.is_empty() {
                    self.set_status(Phase::PendingDeletes, None);
                } else {
                    self.set_status(Phase::Idle, None);
                }
                if self.cycles % GC_EVERY_N_CYCLES == 0 {
                    self.gc_blobs().await;
                }
            }
            Err(RemoteError::Offline(m)) => self.set_status(Phase::Offline, Some(m.clone())),
            Err(RemoteError::Unauthorized) => self.set_status(
                Phase::Revoked,
                Some("this device's access was revoked or the token rotated".into()),
            ),
            Err(RemoteError::Outdated(m)) => {
                self.outdated = Some(self.worker_version.unwrap_or(0));
                self.set_status(
                    Phase::WorkerOutdated,
                    Some(format!("this Mac's changes are waiting on a worker update ({})", m)),
                );
            }
            Err(RemoteError::NotFound) => self.set_status(
                Phase::Error,
                Some(format!("{} no longer holds this workspace", self.cfg.domain)),
            ),
            Err(e) => self.set_status(Phase::Error, Some(e.to_string())),
        }
        match result {
            Ok(_) => Ok(()),
            Err(RemoteError::Conflict { .. }) | Err(RemoteError::Outdated(_)) => Ok(()),
            Err(e) => Err(e),
        }
    }

    async fn cycle_inner(&mut self) -> RemoteResult<Vec<String>> {
        let mut changed_paths: Vec<String> = Vec::new();

        for attempt in 0..CAS_ATTEMPTS {
            // 1. Where is remote?
            let fetched = self.remote.fetch_manifest(self.state.manifest_etag.as_deref()).await?;
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

            // 3½. What the manifest would become, the public map folded in
            //     (folders re-pointed, pages following renames, dead pages
            //     re-bound, pending ops overlaid).
            let mut next = remote_manifest.clone();
            let rollover = self.build_manifest(&mut next, &staged);
            let folded = self.fold_public(&mut next, &remote_manifest, &staged);
            let public_changed = next.public != remote_manifest.public;

            // Remote moved under us but we have nothing to say: adopt theirs.
            if staged.is_empty() && !public_changed {
                // Ops that resolved to exactly what the manifest already says
                // are spent — a CAS carrying no change would be pure waste.
                self.clear_folded(&folded);
                self.state.manifest = remote_manifest;
                self.state.manifest_etag = Some(remote_etag);
                self.persist_state();
                return Ok(changed_paths);
            }

            // 4. Upload content first (idempotent, content-addressed), then
            //    try to win the manifest.
            for push in &staged.pushes {
                self.remote
                    .put_blob(&push.file_id, &push.hash, push.bytes.clone(), content_type_for(&push.path))
                    .await?;
            }

            match self.remote.put_manifest(&next, &remote_etag).await {
                Ok(new_etag) => {
                    // The ops the manifest now carries are done; unresolved
                    // ones (a page for a file that hasn't landed yet) stay
                    // pending for a later cycle.
                    self.clear_folded(&folded);
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

    fn clear_folded(&mut self, folded: &Folded) {
        for slug in &folded.slugs {
            self.state.public_ops.remove(slug);
        }
        if folded.root {
            self.state.root_op = None;
        }
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

            // Both sides have this file. Identical bytes are not a conflict
            // — a folder resumed in place, or two devices that wrote the
            // same thing: adopt the revision as synced and move on.
            let ours = local_now.unwrap_or_default();
            let theirs = self.remote.get_blob(&fid, &rf.hash).await?;
            if ours == theirs {
                self.record_synced(&fid, &rf, Some(&theirs));
                continue;
            }

            // Both sides changed: three-way merge against the stored base.
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
                    let copy =
                        conflict_copy_path(&target, if rf.by.is_empty() { "someone" } else { &rf.by });
                    write_atomic(&copy, &theirs)
                        .map_err(|e| RemoteError::Other(format!("write conflict copy: {}", e)))?;
                    self.record_synced_content(&fid, &rf, &theirs);
                    let copy_rel = rel_path(&self.cfg.root, &copy).unwrap_or_default();
                    touched.push(copy_rel.clone());
                    self.events.emit_json(
                        EV_CONFLICT,
                        json!({
                            "root": self.root_key(),
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
                    staged.pushes.push(StagedPush { file_id: fid, path: fstate.path.clone(), hash, bytes });
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
            let matched = vanished
                .iter()
                .position(|fid| self.state.files.get(fid).map(|st| st.hash == hash).unwrap_or(false));
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
            let big = vanished.len() >= MASS_DELETE_MIN && vanished.len() * 100 / total >= MASS_DELETE_PCT;
            if big && !self.allow_mass_delete {
                self.held_deletes = vanished.clone();
                self.events.emit_json(
                    EV_PENDING_DELETES,
                    json!({
                        "root": self.root_key(),
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
                        staged.pushes.push(StagedPush { file_id: fid.clone(), path, hash, bytes });
                    }
                }
                _ => staged.pushes.push(StagedPush { file_id: random_id("f"), path, hash, bytes }),
            }
        }

        Ok(staged)
    }

    /// Fold the staged changes into `next` (a clone of the freshest remote
    /// manifest). Returns per-file history entries that overflowed the
    /// inline cap and belong in the archive.
    fn build_manifest(&self, next: &mut Manifest, staged: &Staged) -> Vec<(String, Vec<HistEntry>)> {
        let mut rollover = Vec::new();
        next.version = MANIFEST_VERSION;
        next.seq += 1;
        if next.name.is_empty() {
            next.name = self.cfg.name.clone();
        }
        next.name = super::manifest::cap_utf16(&next.name, MAX_NAME_LEN);

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
                    Tombstone { path: f.path, rev: f.rev + 1, ts: now_ms(), by: self.cfg.device_name.clone() },
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

    /// Fold this device's public-map bookkeeping into the manifest about to
    /// be published. Four passes, in order:
    ///   0. folder re-point — a folder page follows its folder when every
    ///      file the folder held moved to one new prefix in this cycle.
    ///   1. rename-follow — file pages are fileId-keyed, so a moved file
    ///      carries its page; only the recorded path needs re-pointing.
    ///   2. re-bind — a dead page (fileId gone) whose path holds a page-less
    ///      file again (delete + recreate, an edit-beats-delete
    ///      resurrection) adopts the new fileId, so the page keeps flowing.
    ///   3. pending ops — the user's publish/unpublish/root edits, keyed by
    ///      slug. A custom slug another device took first yields (`-2`, `-3`,
    ///      …); a random slug for a target already published yields to the
    ///      existing page instead of doubling it.
    /// Returns the ops that made it in; the caller clears them only once the
    /// CAS carrying them wins.
    fn fold_public(&self, next: &mut Manifest, remote: &Manifest, staged: &Staged) -> Folded {
        let mut folded = Folded::default();

        // 0. Folder re-point.
        if !staged.moves.is_empty() {
            let moves: HashMap<&str, &str> =
                staged.moves.iter().map(|(f, p)| (f.as_str(), p.as_str())).collect();
            let dirs: Vec<(String, String)> = next
                .public
                .iter()
                .filter(|(_, e)| e.kind == PublicKind::Dir && !e.path.is_empty())
                .map(|(s, e)| (s.clone(), e.path.clone()))
                .collect();
            for (slug, dir) in dirs {
                if let Some(new_dir) = moved_folder(&dir, remote, &moves) {
                    if let Some(e) = next.public.get_mut(&slug) {
                        e.path = new_dir;
                    }
                }
            }
        }

        // 1. Rename-follow.
        let live: Vec<(String, String)> = next
            .public
            .iter()
            .filter(|(_, e)| e.kind == PublicKind::File)
            .filter_map(|(s, e)| {
                let fid = e.file.as_ref()?;
                next.files.get(fid).map(|f| (s.clone(), f.path.clone()))
            })
            .collect();
        for (slug, path) in live {
            if let Some(e) = next.public.get_mut(&slug) {
                e.path = path;
            }
        }

        // 2. Re-bind.
        let mut referenced: HashSet<String> = next
            .public
            .values()
            .filter_map(|e| e.file.clone())
            .collect();
        let dead: Vec<(String, String)> = next
            .public
            .iter()
            .filter(|(_, e)| {
                e.kind == PublicKind::File
                    && e.file.as_ref().map(|f| !next.files.contains_key(f)).unwrap_or(true)
            })
            .map(|(s, e)| (s.clone(), e.path.clone()))
            .collect();
        for (slug, path) in dead {
            let adopt = next
                .files
                .iter()
                .find(|(lfid, lf)| lf.path == path && !referenced.contains(*lfid))
                .map(|(lfid, _)| lfid.clone());
            if let Some(lfid) = adopt {
                referenced.insert(lfid.clone());
                if let Some(e) = next.public.get_mut(&slug) {
                    e.file = Some(lfid);
                }
            }
        }

        // 3. Pending ops.
        let mut renamed: HashMap<String, String> = HashMap::new();
        for (slug, op) in &self.state.public_ops {
            match op {
                PublicOp::Remove => {
                    next.public.remove(slug);
                    folded.slugs.push(slug.clone());
                }
                PublicOp::Put(p) => {
                    let resolved: Option<(Option<String>, String)> = match p.kind {
                        PublicKind::Dir => Some((None, p.path.clone())),
                        PublicKind::File => {
                            if let Some(fid) = p.file.as_ref().filter(|f| next.files.contains_key(*f)) {
                                Some((Some(fid.clone()), next.files[fid].path.clone()))
                            } else if let Some((fid, _)) = next.files.iter().find(|(_, f)| f.path == p.path) {
                                Some((Some(fid.clone()), p.path.clone()))
                            } else if let Some(existing) = next
                                .public
                                .get(slug)
                                .filter(|e| e.kind == PublicKind::File && e.path == p.path && e.file.is_some())
                            {
                                // No live file, but the page exists dead at
                                // this path: update it in place.
                                Some((existing.file.clone(), p.path.clone()))
                            } else {
                                None
                            }
                        }
                    };
                    // The file hasn't landed in the manifest yet: the op
                    // stays pending and rides a later cycle.
                    let Some((file, path)) = resolved else { continue };
                    let target = match p.kind {
                        PublicKind::File => Target::File(file.clone().unwrap_or_default()),
                        PublicKind::Dir => Target::Dir(path.clone()),
                    };

                    let mut final_slug = slug.clone();
                    let mut carried: Option<PublicEntry> = None;
                    // The same page under another slug?
                    let other = next
                        .public
                        .iter()
                        .find(|(s, e)| *s != slug && e.target().as_ref() == Some(&target))
                        .map(|(s, _)| s.clone());
                    if let Some(other) = other {
                        if p.custom {
                            // The user re-keyed the page: the old slug goes,
                            // the page's root flag and dates carry over.
                            carried = next.public.remove(&other);
                        } else {
                            final_slug = other;
                        }
                    }
                    // The slug taken by a different page (a custom-slug race)?
                    if next.public.get(&final_slug).map(|e| e.target().as_ref() != Some(&target)).unwrap_or(false) {
                        final_slug = unique_slug(&final_slug, |s| next.public.contains_key(s));
                    }
                    if final_slug != *slug {
                        renamed.insert(slug.clone(), final_slug.clone());
                    }
                    let prev = next.public.remove(&final_slug).or(carried);
                    next.public.insert(final_slug, merged_entry(p, file, prev));
                    folded.slugs.push(slug.clone());
                }
            }
        }

        // The root page.
        if let Some(op) = &self.state.root_op {
            match op {
                Some(slug) => {
                    let actual = renamed.get(slug).cloned().unwrap_or_else(|| slug.clone());
                    if next.public.contains_key(&actual) {
                        for e in next.public.values_mut() {
                            e.root = false;
                        }
                        if let Some(e) = next.public.get_mut(&actual) {
                            e.root = true;
                        }
                        folded.root = true;
                    } else if !matches!(self.state.public_ops.get(slug), Some(PublicOp::Put(_))) {
                        // No such page and none on its way: nothing to do.
                        folded.root = true;
                    }
                }
                None => {
                    for e in next.public.values_mut() {
                        e.root = false;
                    }
                    folded.root = true;
                }
            }
        }

        folded
    }

    /// After a won CAS: make local state mirror what we just published.
    fn commit_staged(&mut self, staged: &Staged, next: &Manifest, etag: String) {
        for push in &staged.pushes {
            if let Some(rf) = next.files.get(&push.file_id) {
                let abs = self.cfg.root.join(&rf.path);
                let (size, mtime_ms) = stat_pair(&abs);
                self.state.files.insert(
                    push.file_id.clone(),
                    FileState { path: rf.path.clone(), rev: rf.rev, hash: rf.hash.clone(), size, mtime_ms },
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
            FileState { path: rf.path.clone(), rev: rf.rev, hash: rf.hash.clone(), size, mtime_ms },
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
                Ok(None) => HistoryArchive { version: HISTORY_VERSION, entries: Vec::new() },
                Err(_) => continue,
            };
            for e in entries {
                if !archive.entries.iter().any(|x| x.r == e.r) {
                    archive.entries.push(e);
                }
            }
            archive.entries.sort_by(|a, b| b.r.cmp(&a.r));
            archive.entries.truncate(ARCHIVE_HIST_MAX);
            archive.version = HISTORY_VERSION;
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

    /* ----- the public map: queued ops ----- */

    fn file_id_at(&self, rel: &str) -> Option<String> {
        self.state
            .files
            .iter()
            .find(|(_, st)| st.path == rel)
            .map(|(fid, _)| fid.clone())
            .or_else(|| {
                self.state
                    .manifest
                    .files
                    .iter()
                    .find(|(_, f)| f.path == rel)
                    .map(|(fid, _)| fid.clone())
            })
    }

    /// Queue "publish this file or folder": validates the slug locally,
    /// checks uniqueness against the manifest — instantly, no network — and
    /// answers with the slug the page will have (barring a race another
    /// device wins first; then the status shows the final slug).
    pub(crate) fn queue_publish(&mut self, req: PublishRequest) -> Result<String, String> {
        let rel = req.rel.trim_matches('/').to_string();
        match req.kind {
            PublicKind::File if !valid_rel_path(&rel) => return Err("that path can't be published".into()),
            PublicKind::Dir if !rel.is_empty() && !valid_rel_path(&rel) => {
                return Err("that folder can't be published".into())
            }
            _ => {}
        }
        let file = match req.kind {
            PublicKind::File => self.file_id_at(&rel),
            PublicKind::Dir => None,
        };
        let target = match req.kind {
            PublicKind::File => file.clone().map(Target::File),
            PublicKind::Dir => Some(Target::Dir(rel.clone())),
        };
        let effective = self.effective_public();
        // The page this target already has, if any: by identity, or — for a
        // file that hasn't synced yet — by path.
        let existing = effective
            .iter()
            .find(|(_, e)| match &target {
                Some(t) => e.target().as_ref() == Some(t),
                None => e.kind == PublicKind::File && e.path == rel,
            })
            .map(|(s, _)| s.clone());

        let custom = req.slug.as_ref().map(|s| !s.trim().is_empty()).unwrap_or(false);
        let slug = if custom {
            let s = req.slug.unwrap_or_default().trim().to_lowercase();
            if !valid_slug(&s) {
                return Err(
                    "a slug is 3 to 64 characters: lowercase letters, digits and dashes, starting with a letter or digit"
                        .into(),
                );
            }
            if let Some(e) = effective.get(&s) {
                let same = match &target {
                    Some(t) => e.target().as_ref() == Some(t),
                    None => e.kind == PublicKind::File && e.path == rel,
                };
                if !same {
                    return Err(format!("\"{}\" is already the address of {}", s, describe(e)));
                }
            }
            s
        } else {
            existing.clone().unwrap_or_else(|| unique_slug(&random_slug(), |s| effective.contains_key(s)))
        };

        let op = PendingPublic {
            kind: req.kind,
            file,
            path: rel,
            title: clean_text(req.title.as_deref(), MAX_TITLE_LEN),
            desc: clean_text(req.desc.as_deref(), MAX_DESC_LEN),
            custom,
            by: self.cfg.device_name.clone(),
            at: now_ms(),
        };
        // A re-key: a page still only queued under the old slug is
        // superseded outright; one the manifest holds is re-keyed by the
        // fold, which carries its root flag and dates to the new slug (a
        // queued Remove would drop it before the fold could).
        if let Some(old) = existing.filter(|old| *old != slug) {
            if custom && matches!(self.state.public_ops.get(&old), Some(PublicOp::Put(_))) {
                self.state.public_ops.remove(&old);
            }
        }
        self.state.public_ops.insert(slug.clone(), PublicOp::Put(op));
        // Persist before anything can go wrong: a page published offline must
        // survive a restart.
        self.persist_state();
        self.refresh_status();
        Ok(slug)
    }

    pub(crate) fn queue_unpublish(&mut self, slug: &str) -> Result<(), String> {
        let slug = slug.trim().to_lowercase();
        if !self.effective_public().contains_key(&slug) {
            return Err("that page isn't published".into());
        }
        self.state.public_ops.insert(slug.clone(), PublicOp::Remove);
        if self.state.root_op.as_ref().and_then(|r| r.as_deref()) == Some(slug.as_str()) {
            self.state.root_op = None;
        }
        self.persist_state();
        self.refresh_status();
        Ok(())
    }

    pub(crate) fn queue_set_root(&mut self, slug: Option<String>) -> Result<(), String> {
        let slug = slug.map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty());
        if let Some(s) = &slug {
            if !self.effective_public().contains_key(s) {
                return Err("that page isn't published".into());
            }
        }
        self.state.root_op = Some(slug);
        self.persist_state();
        self.refresh_status();
        Ok(())
    }

    /* ----- history ----- */

    /// Every revision of a file: the manifest's inline tail plus the deep
    /// archive, newest first.
    pub(crate) async fn history(&self, rel: &str) -> Result<Vec<Revision>, String> {
        let m = &self.state.manifest;
        let Some((fid, f)) = m.files.iter().find(|(_, f)| f.path == rel) else {
            return Err("This document hasn't synced yet — history appears after its first sync.".into());
        };
        let mut seen: HashSet<u64> = HashSet::new();
        let mut out: Vec<Revision> = Vec::new();
        let mut push = |r: u64, h: &str, s: u64, t: u64, b: &str, current: bool| {
            if seen.insert(r) {
                out.push(Revision { rev: r, hash: h.to_string(), size: s, time_ms: t, by: b.to_string(), current });
            }
        };
        push(f.rev, &f.hash, f.size, f.mtime, &f.by, true);
        for h in &f.hist {
            push(h.r, &h.h, h.s, h.t, &h.b, false);
        }
        if let Ok(Some(archive)) = self.remote.get_history(fid).await {
            for h in &archive.entries {
                push(h.r, &h.h, h.s, h.t, &h.b, false);
            }
        }
        out.sort_by(|a, b| b.rev.cmp(&a.rev));
        Ok(out)
    }

    pub(crate) async fn revision(&self, rel: &str, hash: &str) -> Result<String, String> {
        let Some(fid) = self.file_id_at(rel) else {
            return Err("This document hasn't synced yet.".into());
        };
        match self.remote.get_blob(&fid, hash).await {
            Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).to_string()),
            Err(RemoteError::NotFound) => Err("That revision's content was already cleaned up.".into()),
            Err(e) => Err(format!("couldn't fetch the revision: {}", e)),
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
        self.set_status(if paused { Phase::Paused } else { Phase::Idle }, None);
    }

    /// The path this device is editing, if the activity is fresh and inside
    /// the workspace.
    fn activity_rel(&self) -> Option<String> {
        let (abs, at) = self.activity.as_ref()?;
        if at.elapsed() >= ACTIVITY_FRESH {
            return None;
        }
        rel_path(&self.cfg.root, Path::new(abs)).filter(|r| !r.is_empty())
    }

    /// Heartbeat "this device is here (editing <path>)": on a cadence, and
    /// at once when the edited path changes. Every device beats, editing
    /// or idle, so the others see who is around; a device that goes quiet
    /// falls out of presence by the worker's TTL.
    pub(crate) async fn presence_tick(&mut self) {
        let rel = self.activity_rel();
        let due = self.last_beat.map(|t| t.elapsed() >= PRESENCE_BEAT).unwrap_or(true) || self.beaconed != rel;
        if !due {
            return;
        }
        if self.remote.put_presence(&self.cfg.device_name, rel.as_deref()).await.is_ok() {
            self.last_beat = Some(Instant::now());
            self.beaconed = rel;
        }
    }

    #[cfg(test)]
    pub(crate) async fn poll_for_test(&mut self) {
        let _ = self.poll_and_maybe_cycle().await;
    }

    /// Poll cheaply; a moved etag is what makes the full cycle worth
    /// running. Presence rides along and only re-emits when it changed.
    async fn poll_and_maybe_cycle(&mut self) -> RemoteResult<()> {
        let poll = self.remote.poll().await?;
        let mut presence: Vec<PresenceDevice> = poll
            .presence
            .iter()
            .filter(|(id, _)| id.as_str() != self.cfg.device_id)
            .map(|(id, e)| PresenceDevice {
                device_id: id.clone(),
                name: e.name.clone(),
                path: e.path.clone(),
                ts: e.ts,
            })
            .collect();
        presence.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.device_id.cmp(&b.device_id)));
        let presence_changed = presence.len() != self.presence.len()
            || presence
                .iter()
                .zip(self.presence.iter())
                .any(|(a, b)| a.device_id != b.device_id || a.path != b.path || a.name != b.name);
        self.presence = presence;
        if Some(poll.manifest_etag.as_str()) != self.state.manifest_etag.as_deref() {
            self.cycle().await?;
        } else if presence_changed {
            self.refresh_status();
        }
        Ok(())
    }

    /* ----- the task ----- */

    /// The engine task: wake on commands, the edit bus, filesystem events, or
    /// the poll clock; run cycles when something might have moved.
    pub async fn run(
        mut self,
        mut cmds: mpsc::UnboundedReceiver<EngineCmd>,
        mut fs_events: mpsc::UnboundedReceiver<()>,
    ) {
        // First contact: learn the worker, then a full cycle brings a stale
        // device current.
        self.probe_worker().await;
        if self.can_cycle() {
            let _ = self.cycle().await;
        } else {
            self.refresh_status();
        }
        let mut fs_dirty_at: Option<Instant> = None;
        let mut touch_dirty_at: Option<Instant> = None;
        let mut next_poll = Instant::now() + POLL_INTERVAL;

        loop {
            let wake = next_wake(next_poll, fs_dirty_at, touch_dirty_at);
            let mut cycle_now = false;

            tokio::select! {
                cmd = cmds.recv() => match cmd {
                    None | Some(EngineCmd::Shutdown) => {
                        // Leave presence on the way out, best-effort.
                        let _ = self.remote.delete_presence().await;
                        return;
                    }
                    Some(EngineCmd::SyncNow) => cycle_now = true,
                    Some(EngineCmd::Touched(rel)) => {
                        self.dirty.insert(rel);
                        touch_dirty_at = Some(Instant::now());
                    }
                    Some(EngineCmd::SetActivity(p)) => {
                        self.set_activity(p);
                        self.presence_tick().await;
                    }
                    Some(EngineCmd::Pause(p)) => self.set_paused(p),
                    Some(EngineCmd::ConfirmDeletes) => {
                        self.confirm_deletes();
                        cycle_now = true;
                    }
                    Some(EngineCmd::Publish { req, reply }) => {
                        let _ = reply.send(self.queue_publish(req));
                        cycle_now = true;
                    }
                    Some(EngineCmd::Unpublish { slug, reply }) => {
                        let _ = reply.send(self.queue_unpublish(&slug));
                        cycle_now = true;
                    }
                    Some(EngineCmd::SetRoot { slug, reply }) => {
                        let _ = reply.send(self.queue_set_root(slug));
                        cycle_now = true;
                    }
                    Some(EngineCmd::History { rel, reply }) => {
                        let _ = reply.send(self.history(&rel).await);
                    }
                    Some(EngineCmd::Revision { rel, hash, reply }) => {
                        let _ = reply.send(self.revision(&rel, &hash).await);
                    }
                },
                ev = fs_events.recv() => {
                    if ev.is_none() { return; } // watcher died with the manager
                    fs_dirty_at = Some(Instant::now());
                },
                _ = tokio::time::sleep_until(wake) => {}
            }

            if self.paused {
                continue;
            }
            let now = Instant::now();
            let touch_due = touch_dirty_at.map(|t| now >= t + TOUCH_SETTLE).unwrap_or(false);
            let fs_due = fs_dirty_at.map(|t| now >= t + FS_SETTLE).unwrap_or(false);
            if cycle_now || touch_due || fs_due {
                // One cycle covers every pending hint: it scans everything.
                touch_dirty_at = None;
                fs_dirty_at = None;
                if self.can_cycle() {
                    let _ = self.cycle().await;
                }
                next_poll = Instant::now() + POLL_INTERVAL;
            } else if now >= next_poll {
                if self.outdated.is_some() {
                    // Waiting on a worker update: ask, and resume the moment
                    // it has happened.
                    self.probe_worker().await;
                    if self.outdated.is_none() {
                        let _ = self.cycle().await;
                    } else {
                        self.refresh_status();
                    }
                } else {
                    let _ = self.poll_and_maybe_cycle().await;
                }
                self.presence_tick().await;
                next_poll = Instant::now() + POLL_INTERVAL;
            }
        }
    }
}

/// When the task should next wake: the poll clock, or sooner for a pending
/// hint — a touch settles in `TOUCH_SETTLE`, a filesystem event in
/// `FS_SETTLE`. Pure, so the timing is testable without a runtime.
pub(crate) fn next_wake(next_poll: Instant, fs_dirty_at: Option<Instant>, touch_dirty_at: Option<Instant>) -> Instant {
    let mut wake = next_poll;
    if let Some(t) = fs_dirty_at {
        wake = wake.min(t + FS_SETTLE);
    }
    if let Some(t) = touch_dirty_at {
        wake = wake.min(t + TOUCH_SETTLE);
    }
    wake
}

/// Where folder `dir` went, if every file it held (in `remote`, the manifest
/// before this cycle's moves) moved to one new prefix in `moves`.
fn moved_folder(dir: &str, remote: &Manifest, moves: &HashMap<&str, &str>) -> Option<String> {
    let prefix = format!("{}/", dir);
    let mut target: Option<String> = None;
    let mut held = 0usize;
    for (fid, f) in remote.files.iter().filter(|(_, f)| f.path.starts_with(&prefix)) {
        held += 1;
        let new_path = moves.get(fid.as_str())?; // not every file moved → no re-point
        let rest = &f.path[prefix.len()..];
        let new_dir = new_path.strip_suffix(rest)?.strip_suffix('/')?;
        if new_dir.is_empty() {
            return None;
        }
        match &target {
            None => target = Some(new_dir.to_string()),
            Some(t) if t == new_dir => {}
            Some(_) => return None,
        }
    }
    if held == 0 {
        return None;
    }
    target.filter(|t| t != dir)
}

/// The entry a pending op produces, keeping what an update shouldn't reset
/// (`root`, `at`, `by`) from the page it updates.
fn merged_entry(p: &PendingPublic, file: Option<String>, prev: Option<PublicEntry>) -> PublicEntry {
    let (title, desc) = match &prev {
        Some(e) => (
            match &p.title {
                Some(t) => Some(t.clone()),
                None => e.title.clone(),
            },
            match &p.desc {
                Some(d) => Some(d.clone()),
                None => e.desc.clone(),
            },
        ),
        None => (p.title.clone(), p.desc.clone()),
    };
    PublicEntry {
        kind: p.kind,
        file: match p.kind {
            PublicKind::File => file,
            PublicKind::Dir => None,
        },
        path: p.path.clone(),
        title,
        desc,
        root: prev.as_ref().map(|e| e.root).unwrap_or(false),
        by: prev.as_ref().map(|e| e.by.clone()).unwrap_or_else(|| p.by.clone()),
        at: prev.as_ref().map(|e| e.at).unwrap_or(p.at),
    }
}

fn describe(e: &PublicEntry) -> String {
    match e.kind {
        PublicKind::File => e.path.clone(),
        PublicKind::Dir if e.path.is_empty() => "the workspace".to_string(),
        PublicKind::Dir => format!("the folder {}", e.path),
    }
}
