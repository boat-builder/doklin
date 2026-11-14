//! A unit: one section of a workspace — the shared part, a person's Private,
//! one restricted folder — kept in step with its own manifest.
//!
//! Every section is a workspace-shaped thing on the domain: a manifest
//! updated by compare-and-swap, content-addressed blobs, a version store.
//! So every section syncs the same way, and this file is that way: the
//! cycle (`cycle_inner`, the only place local and remote state meet), the
//! public map's queued ops, blob collection, the version mirror. What a
//! workspace has one of — the credential's identity, the poll, presence,
//! the status — is the engine's (engine.rs), which owns the units and
//! decides when each one cycles.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::json;
use super::engine::PublishRequest;
use super::manifest::{
    clean_text, dedupe_paths, files_under, random_slug, unique_slug, valid_rel_path, valid_slug, Manifest,
    ManifestFile, PublicEntry, PublicKind, Target, Tombstone, MANIFEST_VERSION, MAX_DESC_LEN, MAX_NAME_LEN,
    MAX_TITLE_LEN,
};
use super::merge::{conflict_copy_path, merge_texts, MergeOutcome};
use super::remote::{Remote, RemoteError, RemoteResult};
use super::scan::{
    content_type_for, hash16, now_ms, random_id, read_file_checked, read_json, rel_path, scan_local, stat_pair,
    write_atomic, write_json, ScanEntry,
};
use super::space::{read_space_marker, reserved_top, RESERVED_DIRS, SHARED};
use super::status::{Events, PublicPage, EV_ADDRESS_TAKEN, EV_CONFLICT, EV_PENDING_DELETES};
// The cloud half of versioning. `crate::versions` is the local versioner —
// this module only mirrors what that one wrote.
use super::versions as version_store;
use super::versions::{MirrorReport, VersionsIndex};
use crate::versions::store::Snapshot as VersionSnapshot;

/* ---------- Tunables ---------- */

/// Tombstones older than this get dropped from the manifest by whoever
/// writes it next.
const TOMBSTONE_TTL_MS: u64 = 30 * 24 * 60 * 60 * 1000;
/// Mass-delete valve: if more than this share of a section vanishes in one
/// scan (and more than a handful of files), don't propagate — hold and ask.
/// Protects against an unmounted/renamed folder nuking the remote.
const MASS_DELETE_PCT: usize = 30;
const MASS_DELETE_MIN: usize = 5;
/// Blob GC runs opportunistically on this fraction of cycles.
const GC_EVERY_N_CYCLES: u64 = 20;
/// A blob must be at least this old before GC may take it (a racing pusher
/// may have uploaded it moments ago, ahead of its manifest CAS).
const GC_MIN_AGE_MS: u64 = 24 * 60 * 60 * 1000;
/// How many fileIds one poll of the legacy clean-up handles. Small enough
/// that the pass is invisible beside the poll it rides on; a workspace of
/// 5000 files finishes in about half an hour of polling.
pub(crate) const LEGACY_BATCH: usize = 50;
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
    /// When the cloud version store was last thinned — daily, by whichever
    /// device gets there first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_cloud_sweep_ms: Option<u64>,
    /// How far the one-time clean-up of the retired manifest history has
    /// got. Absent only on a device that has not started it.
    #[serde(default, skip_serializing_if = "LegacyCleanup::is_pristine")]
    pub legacy_cleanup: LegacyCleanup,
}

/// The bookmark of the one-time clean-up of the retired manifest history:
/// every file's retired revision blobs. It
/// had a first pass over the `history/<fid>.json` archives too, until the
/// routes it called were deleted.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct LegacyCleanup {
    /// What an older release wrote here when it finished deleting archives.
    /// Kept under its own name so that a state file written by one is read
    /// the way it meant it: false means that device's cursor belongs to a
    /// pass that no longer exists, and the blob pass starts over.
    #[serde(default)]
    pub archives_done: bool,
    /// Both passes are finished and this workspace never looks again. It is
    /// written down and stays written down: a device that forgot it had
    /// finished would walk the whole bucket again after every restart.
    #[serde(default)]
    pub done: bool,
    /// The last fileId the running pass handled; the next poll starts after
    /// it. `None` means "from the beginning", which is where each pass
    /// starts and where the other one leaves it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

impl LegacyCleanup {
    /// Nothing has happened yet, so there is nothing worth writing down —
    /// which is what keeps this out of the state file of a workspace
    /// connected after the manifest history was retired, with none to
    /// retire in the first place. Every later state is persisted, the
    /// finished one included.
    fn is_pristine(&self) -> bool {
        !self.archives_done && !self.done && self.cursor.is_none()
    }
}

/* ---------- What a cycle decides ---------- */

/// What one reconcile pass decided to do. Split out for testability.
#[derive(Default, Debug)]
pub(crate) struct Staged {
    /// fileId -> (relative path, bytes) to upload + point the manifest at.
    pushes: Vec<StagedPush>,
    /// fileId -> new relative path (content unchanged).
    moves: Vec<(String, String)>,
    /// fileIds to tombstone.
    deletes: Vec<String>,
    /// Those of `deletes` that moved to another section, and which one: what
    /// their tombstones say (`Tombstone::to`).
    moved_to: HashMap<String, String>,
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

/* ---------- What a cycle is told ---------- */

/// What a unit needs to know, for one cycle, about the workspace it is a
/// section of.
pub(crate) struct Ctx<'a> {
    /// What this Mac signs its work with (`Engine::signature`).
    pub signature: &'a str,
    /// id → display name for everyone on the workspace.
    pub people: &'a BTreeMap<String, String>,
    pub events: &'a dyn Events,
    /// The workspace's root, as every event names it.
    pub ws_root: &'a str,
    pub use_trash: bool,
    /// Public addresses another section on this Mac still has to give up.
    pub releasing: &'a HashSet<String>,
    /// Files of this unit that are in another section on this Mac now.
    pub moved_out: &'a HashMap<String, MovedOut>,
}

impl Ctx<'_> {
    fn name_of(&self, by: &str) -> String {
        self.people.get(by).cloned().unwrap_or_else(|| by.to_string())
    }
}

/// Where a file that left this unit went.
#[derive(Clone, Debug)]
pub(crate) struct MovedOut {
    /// The unit it is in now (`SHARED` for the shared workspace).
    pub to: String,
    /// That unit's manifest holds it. Until it does, the file is not
    /// removed here: the section it is going to is written first.
    pub landed: bool,
}

/// What a unit's folder looks like beside what it last synced — read off
/// the disk, with no request made.
#[derive(Default, Debug)]
pub(crate) struct Survey {
    /// Something here differs from what was last synced.
    pub dirty: bool,
    /// Synced files no longer on disk: (file id, last synced hash, path).
    pub vanished: Vec<(String, String, String)>,
    /// Files on disk this unit has never synced: (path, hash).
    pub news: Vec<(String, String)>,
}

/// What a unit is made from.
pub(crate) struct UnitConfig {
    /// The space's id; `SHARED` for the shared workspace.
    pub id: String,
    /// What a manifest this unit starts is called.
    pub name: String,
    /// The folder it keeps in step.
    pub root: PathBuf,
    /// That folder inside the workspace: empty for the shared workspace,
    /// else `Private` or `Restricted/<folder>`.
    pub prefix: String,
    /// `state.json` + `base/`.
    pub state_dir: PathBuf,
    /// `<app_data>`, for this folder's version store — read, to mirror it.
    pub data_dir: PathBuf,
    pub device_id: String,
}

pub(crate) struct Unit<R: Remote> {
    pub id: String,
    pub name: String,
    pub root: PathBuf,
    pub prefix: String,
    state_dir: PathBuf,
    data_dir: PathBuf,
    device_id: String,
    /// Aimed at this unit's section (`Remote::space`).
    remote: Arc<R>,
    pub state: WorkspaceState,
    /// The manifest fetched for the cycle about to run (`fetch`), so the
    /// engine can read it — who it names, what moved away — before the
    /// cycle applies it.
    pub incoming: Option<(Manifest, String)>,
    /// Deletions held back by the mass-delete valve, waiting for a user go.
    pub held_deletes: Vec<String>,
    allow_mass_delete: bool,
    cycles: u64,
    /// fileIds pushed since the last GC — the only ones that can have an
    /// old blob to collect. A set, because twenty cycles of edits to one
    /// file is still one file to look at.
    gc_candidates: BTreeSet<String>,
    /// Files a cycle met as moved to another section and left alone, for
    /// `Engine::relocate`.
    pub deferred: HashSet<String>,
    /// Something was queued since the last cycle — a page, a confirmed
    /// deletion — so the next pass cycles this unit whatever its folder
    /// looks like.
    pub poke: bool,
    /// The domain answered `NotFound` for this space: this person is not in
    /// it any more, or it is gone. Nothing more is asked of it until a poll
    /// says which.
    pub gone: bool,
    /// The last cloud version index this device read, so the rail still has
    /// something to show when the domain is unreachable.
    cloud_versions: Option<VersionsIndex>,
    pub mirror: Option<MirrorReport>,
    pub last_mirror_ms: Option<u64>,
}

/// The entry at the top of `root` called `name`, however it is spelled.
fn top_dir(root: &Path, name: &str) -> Option<PathBuf> {
    std::fs::read_dir(root)
        .ok()?
        .flatten()
        .find(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case(name))
        .map(|e| e.path())
        .filter(|p| p.is_dir())
}

impl<R: Remote> Unit<R> {
    pub(crate) fn new(cfg: UnitConfig, remote: Arc<R>) -> Self {
        let _ = std::fs::create_dir_all(cfg.state_dir.join("base"));
        let state: WorkspaceState = read_json(&cfg.state_dir.join("state.json")).unwrap_or_default();
        Unit {
            id: cfg.id,
            name: cfg.name,
            root: cfg.root,
            prefix: cfg.prefix,
            state_dir: cfg.state_dir,
            data_dir: cfg.data_dir,
            device_id: cfg.device_id,
            remote,
            state,
            incoming: None,
            held_deletes: Vec::new(),
            allow_mass_delete: false,
            cycles: 0,
            gc_candidates: BTreeSet::new(),
            deferred: HashSet::new(),
            poke: false,
            gone: false,
            cloud_versions: None,
            mirror: None,
            last_mirror_ms: None,
        }
    }

    pub(crate) fn is_shared(&self) -> bool {
        self.id == SHARED
    }

    /// What this unit's walk leaves out: for the shared workspace, the two
    /// folders that are other sections'.
    fn skip(&self) -> &'static [&'static str] {
        if self.is_shared() {
            &RESERVED_DIRS
        } else {
            &[]
        }
    }

    /// A path of this unit as the workspace spells it.
    pub(crate) fn ws_rel(&self, rel: &str) -> String {
        match (self.prefix.is_empty(), rel.is_empty()) {
            (true, _) => rel.to_string(),
            (false, true) => self.prefix.clone(),
            (false, false) => format!("{}/{}", self.prefix, rel),
        }
    }

    /// A workspace-relative path as this unit spells it, when it is this
    /// unit's: `Some("")` is the unit's own folder.
    pub(crate) fn in_unit(&self, ws_rel: &str) -> Option<String> {
        if self.is_shared() {
            return reserved_top(ws_rel).is_none().then(|| ws_rel.to_string());
        }
        // The folder's own name compares the way the disk does.
        let head = ws_rel.get(..self.prefix.len()).filter(|head| head.eq_ignore_ascii_case(&self.prefix))?;
        let rest = &ws_rel[head.len()..];
        if rest.is_empty() {
            return Some(String::new());
        }
        rest.strip_prefix('/').map(String::from)
    }

    pub(crate) fn base_path(&self, file_id: &str) -> PathBuf {
        self.state_dir.join("base").join(file_id)
    }

    pub(crate) fn persist_state(&self) {
        let _ = write_json(&self.state_dir.join("state.json"), &self.state);
    }

    /// Where the domain is, for the cycle about to run: the manifest when it
    /// moved since the one this unit applied, that one again when it did not.
    pub(crate) async fn fetch(&mut self) -> RemoteResult<()> {
        let fetched = self.remote.fetch_manifest(self.state.manifest_etag.as_deref()).await?;
        self.incoming = Some(match fetched {
            Some(found) => found,
            None => (self.state.manifest.clone(), self.state.manifest_etag.clone().unwrap_or_default()),
        });
        Ok(())
    }

    /// The freshest manifest this unit has seen: the one waiting to be
    /// applied, else the one it applied.
    pub(crate) fn view(&self) -> &Manifest {
        self.incoming.as_ref().map(|(m, _)| m).unwrap_or(&self.state.manifest)
    }

    /// Does this folder differ from what was last synced, and which files
    /// came or went? Stat-only for files it knows, so it costs a walk — the
    /// engine asks every unit before a pass, to cycle only the ones with
    /// something to say and to pair a file that left one section with the
    /// same file arriving in another.
    pub(crate) fn survey(&self) -> Survey {
        let mut out = Survey::default();
        let Ok(scan) = scan_local(&self.root, self.skip()) else {
            out.dirty = true; // the cycle is what reports why
            return out;
        };
        let known: HashSet<&str> = self.state.files.values().map(|st| st.path.as_str()).collect();
        for (fid, st) in &self.state.files {
            match scan.get(&st.path) {
                Some(entry) => out.dirty |= entry.size != st.size || entry.mtime_ms != st.mtime_ms,
                // Under a reserved name in the shared workspace: not gone,
                // waiting for `rescue_reserved`.
                None if self.is_shared() && reserved_top(&st.path).is_some() => out.dirty = true,
                None => out.vanished.push((fid.clone(), st.hash.clone(), st.path.clone())),
            }
        }
        for (path, entry) in &scan {
            if known.contains(path.as_str()) {
                continue;
            }
            if let Some(bytes) = read_file_checked(&entry.abs) {
                out.news.push((path.clone(), hash16(&bytes)));
            }
        }
        out.dirty |= !out.vanished.is_empty() || !out.news.is_empty();
        out
    }

    /// Whether the shared workspace holds nothing under a reserved name, as
    /// far as this Mac knows. Until it does, no space has a folder here: the
    /// folder a space would use is still shared content.
    pub(crate) fn reserved_clear(&self) -> bool {
        let reserved = |path: &str| reserved_top(path).is_some();
        !self.state.files.values().any(|f| reserved(&f.path))
            && !self.state.manifest.files.values().any(|f| reserved(&f.path))
    }

    /// The one-time rename of a shared folder called `Private` or
    /// `Restricted`, from before those names were reserved: it becomes
    /// `Private (shared)`, files and all, and the scan that follows reads
    /// the rename as moves. Run after the remote manifest is applied — a Mac
    /// that got there first has already renamed it, and then there is
    /// nothing under the old name left to do.
    fn rescue_reserved(&mut self) -> Result<(), String> {
        if !self.is_shared() {
            return Ok(());
        }
        for name in RESERVED_DIRS {
            if !self.state.files.values().any(|f| reserved_top(&f.path) == Some(name)) {
                continue;
            }
            let Some(dir) = top_dir(&self.root, name) else { continue };
            // Never a folder that is a space's: that one was not shared, and
            // must not become so.
            let a_space = read_space_marker(&dir).is_some()
                || std::fs::read_dir(&dir)
                    .map(|entries| entries.flatten().any(|e| read_space_marker(&e.path()).is_some()))
                    .unwrap_or(false);
            if a_space {
                continue;
            }
            let to = (1u32..)
                .map(|n| if n == 1 { format!("{} (shared)", name) } else { format!("{} (shared) {}", name, n) })
                .map(|candidate| self.root.join(candidate))
                .find(|candidate| !candidate.exists())
                .unwrap_or_else(|| self.root.join(format!("{} (shared)", name)));
            std::fs::rename(&dir, &to)
                .map_err(|e| format!("couldn't rename the shared folder \"{}\" out of the way: {}", name, e))?;
        }
        Ok(())
    }

    pub(crate) fn confirm_deletes(&mut self) {
        if !self.held_deletes.is_empty() {
            self.allow_mass_delete = true;
            self.held_deletes.clear();
            self.poke = true;
        }
    }

    /// Is blob collection due? Asked after a cycle.
    pub(crate) fn gc_due(&self) -> bool {
        self.cycles > 0 && self.cycles % GC_EVERY_N_CYCLES == 0
    }

    /* ----- relocation: a file arriving from another section ----- */

    /// Record `fid` as synced at `rf` while the bytes on disk are an edit of
    /// it: the next cycle reads the file as changed here and pushes it, with
    /// `base` as the ancestor a merge would need.
    pub(crate) fn plant(&mut self, fid: &str, rf: &ManifestFile, base: Option<&[u8]>) {
        let (size, mtime_ms) = stat_pair(&self.root.join(&rf.path));
        self.state.files.insert(
            fid.to_string(),
            FileState {
                path: rf.path.clone(),
                rev: rf.rev,
                hash: rf.hash.clone(),
                // Deliberately NOT the disk snapshot, as after a merge.
                size: size.wrapping_add(1),
                mtime_ms,
            },
        );
        if let Some(base) = base {
            let _ = write_atomic(&self.base_path(fid), base);
        }
        self.poke = true;
    }

    /// Stop tracking `fid`: its story here is over.
    pub(crate) fn forget(&mut self, fid: &str) {
        self.state.files.remove(fid);
        let _ = std::fs::remove_file(self.base_path(fid));
        self.deferred.remove(fid);
    }

    /* ----- the cycle ----- */

    /// One reconcile of this section: pull remote reality, apply what only
    /// changed there, work out what changed here, merge where both moved,
    /// then CAS our view in. Loops on a lost CAS with fresh remote state.
    /// Answers the paths it wrote, relative to this unit.
    ///
    /// Every fallible step of a cycle lives in here, so every way out of one
    /// reaches the engine's single status report.
    pub(crate) async fn cycle_inner(&mut self, ctx: &Ctx<'_>) -> RemoteResult<Vec<String>> {
        let mut changed_paths: Vec<String> = Vec::new();
        // Addresses the domain said are another section's, this cycle.
        let mut refused: HashSet<String> = HashSet::new();
        self.cycles += 1;
        self.poke = false;

        for attempt in 0..CAS_ATTEMPTS {
            // 1. Where is remote?
            if self.incoming.is_none() {
                self.fetch().await?;
            }
            let Some((remote_manifest, remote_etag)) = self.incoming.take() else { break };

            // 2. Apply remote-only changes to disk (downloads, renames,
            //    deletions). Local-vs-remote overlap is decided inside.
            let applied = self.apply_remote(&remote_manifest, ctx).await?;
            changed_paths.extend(applied);

            // 2½. A shared folder under a name that is now reserved moves out
            //     of the way before the scan stops looking there.
            self.rescue_reserved().map_err(RemoteError::Other)?;

            // 3. What changed locally?
            let scan = scan_local(&self.root, self.skip()).map_err(RemoteError::Other)?;
            let staged = self.stage_local(&scan, &remote_manifest, ctx).await?;

            // 3½. What the manifest would become, the public map folded in
            //     (folders re-pointed, pages following renames, dead pages
            //     re-bound, pending ops overlaid).
            let mut next = remote_manifest.clone();
            self.build_manifest(&mut next, &staged, ctx);
            let folded = self.fold_public(&mut next, &remote_manifest, &staged, ctx);
            for slug in &refused {
                next.public.remove(slug);
            }
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
                    return Ok(changed_paths);
                }
                Err(RemoteError::Conflict) if attempt + 1 < CAS_ATTEMPTS => {
                    // Someone else landed first — reconcile again from their
                    // reality. Uploaded blobs stay valid either way.
                    continue;
                }
                Err(RemoteError::Taken(slugs)) if attempt + 1 < CAS_ATTEMPTS => {
                    // Nothing was stored. The pages asking for those
                    // addresses are dropped, the user is told, and the rest
                    // goes again over the same remote state.
                    self.give_up(&slugs, ctx);
                    refused.extend(slugs);
                    self.incoming = Some((remote_manifest, remote_etag));
                    continue;
                }
                Err(e) => return Err(e),
            }
        }
        Ok(changed_paths)
    }

    /// Addresses this unit asked for and the domain holds for another
    /// section: forget the asking, and say so once.
    fn give_up(&mut self, slugs: &[String], ctx: &Ctx<'_>) {
        for slug in slugs {
            let path = match self.state.public_ops.remove(slug) {
                Some(PublicOp::Put(p)) => self.ws_rel(&p.path),
                _ => String::new(),
            };
            if self.state.root_op.as_ref().and_then(|r| r.as_deref()) == Some(slug.as_str()) {
                self.state.root_op = None;
            }
            ctx.events.emit_json(EV_ADDRESS_TAKEN, json!({ "root": ctx.ws_root, "slug": slug, "path": path }));
        }
        self.persist_state();
    }

    /* ----- status ----- */

    /// This section's public pages as this device believes them, with paths
    /// as the workspace spells them.
    pub(crate) fn public_pages(&self, people: &BTreeMap<String, String>) -> Vec<PublicPage> {
        let m = &self.state.manifest;
        self.effective_public()
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
                    path: self.ws_rel(&e.path),
                    title: e.title,
                    desc: e.desc,
                    by: people.get(&e.by).cloned().unwrap_or(e.by),
                    at: e.at,
                    alive,
                    root: e.root,
                }
            })
            .collect()
    }

    /* ----- the version store's mirror ----- */

    /// Put this device's captured history of this folder in the bucket, and
    /// once a day thin what is up there. History is not the document: a
    /// mirror that cannot finish leaves the sync's phase alone and tries
    /// again on the next pass, because a version that is late is not a
    /// change that is lost. True when a pass finished.
    pub(crate) async fn mirror_versions(&mut self) -> bool {
        let store = crate::versions::store_for_root(&self.data_dir, &self.root);
        let remote = self.remote.clone();
        let mut swept = self.state.last_cloud_sweep_ms;
        let result = version_store::mirror(remote.as_ref(), &store, &self.device_id, &mut swept, now_ms()).await;
        self.state.last_cloud_sweep_ms = swept;
        self.persist_state();
        match result {
            Ok(report) => {
                self.mirror = Some(report);
                self.last_mirror_ms = Some(now_ms());
                true
            }
            Err(e) => {
                eprintln!("cloud: could not mirror the version history of {}: {}", self.root.display(), e);
                false
            }
        }
    }

    /// How far back the bucket keeps for this section. One CAS on the cloud
    /// index, so every device that reads it next agrees; the local horizon
    /// is separate and stays this Mac's business.
    pub(crate) async fn set_cloud_horizon(&mut self, days: Option<u32>) -> Result<(), String> {
        let index = version_store::set_horizon(self.remote.as_ref(), days)
            .await
            .map_err(|e| format!("Couldn't change what the cloud keeps: {}.", e))?;
        // The panel shows what the bucket now says without waiting an hour
        // for the next pass to tell it.
        if let Some(report) = self.mirror.as_mut() {
            report.horizon_days = days;
        }
        self.cloud_versions = Some(index);
        Ok(())
    }

    /// What the bucket holds of this section's history: fresh when the
    /// domain answers, last-known when it doesn't — an unreachable bucket
    /// should not empty a rail that was full a minute ago.
    pub(crate) async fn versions_index(&mut self) -> Option<VersionsIndex> {
        if let Ok(Some((index, _))) = self.remote.get_versions_index().await {
            self.cloud_versions = Some(index);
        }
        self.cloud_versions.clone()
    }

    pub(crate) async fn version_snapshot(&self, id: &str) -> Option<VersionSnapshot> {
        let store = crate::versions::store_for_root(&self.data_dir, &self.root);
        version_store::snapshot(self.remote.as_ref(), &store, id).await
    }

    pub(crate) async fn version_blob(&self, hash: &str) -> RemoteResult<Vec<u8>> {
        version_store::blob(self.remote.as_ref(), hash).await
    }

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
    async fn apply_remote(&mut self, remote: &Manifest, ctx: &Ctx<'_>) -> RemoteResult<Vec<String>> {
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
            let tomb = remote.tombstones.get(&fid);
            let tomb_rev = tomb.map(|t| t.rev).unwrap_or(u64::MAX);
            if tomb_rev < fstate.rev {
                continue; // stale tombstone from before what we already hold
            }
            if tomb.is_some_and(|t| t.to.is_some()) {
                // Not deleted: moved to another section. What becomes of this
                // Mac's copy depends on whether this Mac is in that section,
                // which only the engine knows — it is left exactly as it is
                // until `Engine::relocate` has dealt with it.
                self.deferred.insert(fid);
                continue;
            }
            let abs = self.root.join(&fstate.path);
            let local = read_file_checked(&abs);
            match local {
                Some(bytes) if hash16(&bytes) != fstate.hash => {
                    // Edited here, deleted there: the edit wins. Withdraw the
                    // tombstone by re-pushing (stage_local sees it as new,
                    // because we drop our state entry for it below).
                }
                Some(_) => {
                    // Clean local copy — honor the deletion, recoverably.
                    self.delete_local(&abs, ctx.use_trash);
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
            let target = self.root.join(&rf.path);
            let prior = self.state.files.get(&fid).cloned();

            // A pure rename of an unedited file: move it, no bytes.
            if let Some(p) = &prior {
                if p.hash == rf.hash && p.path != rf.path {
                    let from = self.root.join(&p.path);
                    if from.exists() && !target.exists() {
                        if let Some(parent) = target.parent() {
                            let _ = std::fs::create_dir_all(parent);
                        }
                        if std::fs::rename(&from, &target).is_ok() {
                            self.record_synced(&fid, &rf, None);
                            // A rename moves no bytes, so the snapshot from
                            // before it still says whether the file was
                            // edited here meanwhile; the fresh stat would
                            // make that edit read as synced and never push.
                            if let Some(st) = self.state.files.get_mut(&fid) {
                                (st.size, st.mtime_ms) = (p.size, p.mtime_ms);
                            }
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
                            let old_abs = self.root.join(&p.path);
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
            // The content address settles it before anything is downloaded.
            if hash16(&ours) == rf.hash {
                self.record_synced(&fid, &rf, Some(&ours));
                continue;
            }
            let theirs = self.remote.get_blob(&fid, &rf.hash).await?;

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
                    // The filename carries a name, so the id is resolved
                    // here rather than shown: a file called
                    // "notes (conflict — m-1a2b3c4d…).md" helps nobody.
                    let author = ctx.name_of(&rf.by);
                    let copy = conflict_copy_path(&target, if author.is_empty() { "someone" } else { &author });
                    write_atomic(&copy, &theirs)
                        .map_err(|e| RemoteError::Other(format!("write conflict copy: {}", e)))?;
                    self.record_synced_content(&fid, &rf, &theirs);
                    let copy_rel = rel_path(&self.root, &copy).unwrap_or_default();
                    touched.push(copy_rel.clone());
                    ctx.events.emit_json(
                        EV_CONFLICT,
                        json!({
                            "root": ctx.ws_root,
                            "path": self.ws_rel(&rf.path),
                            "by": author,
                            "conflictPath": self.ws_rel(&copy_rel),
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
        ctx: &Ctx<'_>,
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
            if self.deferred.contains(&fid) {
                continue; // moved to another section, and not dealt with yet
            }
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

        // A file that is now in another section on this Mac was moved, not
        // deleted: it leaves here with a tombstone that says where it went —
        // once that section holds it, and not a cycle sooner — and it never
        // counts toward the valve below.
        let mut moved: Vec<String> = Vec::new();
        vanished.retain(|fid| match ctx.moved_out.get(fid) {
            None => true,
            Some(out) if out.landed => {
                moved.push(fid.clone());
                false
            }
            // Not there yet: it stays here, and is asked about again on the
            // next pass — the survey still finds it gone.
            Some(_) => false,
        });

        // Mass-delete valve. Renames already left `vanished`.
        if !vanished.is_empty() {
            let total = self.state.files.len().max(1);
            let big = vanished.len() >= MASS_DELETE_MIN && vanished.len() * 100 / total >= MASS_DELETE_PCT;
            if big && !self.allow_mass_delete {
                self.held_deletes = vanished.clone();
                ctx.events.emit_json(
                    EV_PENDING_DELETES,
                    json!({
                        "root": ctx.ws_root,
                        "count": vanished.len(),
                        "total": total,
                        "paths": vanished
                            .iter()
                            .filter_map(|fid| self.state.files.get(fid).map(|s| self.ws_rel(&s.path)))
                            .collect::<Vec<_>>(),
                    }),
                );
            } else {
                self.allow_mass_delete = false;
                self.held_deletes.clear();
                staged.deletes = vanished;
            }
        }
        for fid in moved {
            if let Some(out) = ctx.moved_out.get(&fid) {
                staged.moved_to.insert(fid.clone(), out.to.clone());
            }
            staged.deletes.push(fid);
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
    /// manifest).
    ///
    /// Everything this writes is signed with [`Engine::signature`] — a member
    /// id since manifest v3. Entries it does not touch keep whatever they
    /// carry, including the device names a v2 workspace was written with:
    /// rewriting those would attribute somebody else's edit to whoever
    /// happened to upgrade first.
    fn build_manifest(&self, next: &mut Manifest, staged: &Staged, ctx: &Ctx<'_>) {
        next.version = MANIFEST_VERSION;
        next.seq += 1;
        if next.name.is_empty() {
            next.name = self.name.clone();
        }
        next.name = super::manifest::cap_utf16(&next.name, MAX_NAME_LEN);

        for push in &staged.pushes {
            let prev = next.files.get(&push.file_id);
            let tomb_rev = next.tombstones.get(&push.file_id).map(|t| t.rev).unwrap_or(0);
            let rev = prev.map(|p| p.rev).unwrap_or(0).max(tomb_rev) + 1;
            next.tombstones.remove(&push.file_id); // resurrection beats deletion
            next.files.insert(
                push.file_id.clone(),
                ManifestFile {
                    path: push.path.clone(),
                    rev,
                    hash: push.hash.clone(),
                    size: push.bytes.len() as u64,
                    mtime: now_ms(),
                    by: ctx.signature.to_string(),
                },
            );
        }

        for (fid, to) in &staged.moves {
            if let Some(f) = next.files.get_mut(fid) {
                // `mtime` stays: it says when the content last changed, and a
                // move is not an edit. The document API reads it to tell an
                // html version that has fallen behind its markdown
                // (cloud-worker/src/documents.ts, `htmlBehind`), and a rename
                // that restamped both would hide exactly that. The worker's
                // own move keeps it too (commit.ts). Change both.
                f.path = to.clone();
                f.rev += 1;
                f.by = ctx.signature.to_string();
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
                        by: ctx.signature.to_string(),
                        to: staged.moved_to.get(fid).cloned(),
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
    ///      slug; one whose address another section here still has to give
    ///      up waits (`Ctx::releasing`). A custom slug another device took first yields (`-2`, `-3`,
    ///      …); a random slug for a target already published yields to the
    ///      existing page instead of doubling it.
    /// Returns the ops that made it in; the caller clears them only once the
    /// CAS carrying them wins.
    fn fold_public(&self, next: &mut Manifest, remote: &Manifest, staged: &Staged, ctx: &Ctx<'_>) -> Folded {
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
                    // An address another section on this Mac is about to let
                    // go of is still that section's on the domain: claiming
                    // it now would be refused. It waits for the release.
                    if ctx.releasing.contains(slug) {
                        continue;
                    }
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
                let abs = self.root.join(&rf.path);
                let (size, mtime_ms) = stat_pair(&abs);
                self.state.files.insert(
                    push.file_id.clone(),
                    FileState { path: rf.path.clone(), rev: rf.rev, hash: rf.hash.clone(), size, mtime_ms },
                );
                let _ = write_atomic(&self.base_path(&push.file_id), &push.bytes);
                self.gc_candidates.insert(push.file_id.clone());
            }
        }
        for (fid, to) in &staged.moves {
            let abs = self.root.join(to);
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
        let abs = self.root.join(&rf.path);
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
        let abs = self.root.join(&rf.path);
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

    fn delete_local(&self, abs: &Path, use_trash: bool) {
        if use_trash {
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

    /// Drop every blob of a pushed file but the one the manifest points at
    /// now, once it is old enough that no racing pusher still needs it.
    /// There is nothing else to keep: a file's past is the
    /// version store's, and the sync side needs exactly the current bytes.
    pub(crate) async fn gc_blobs(&mut self) {
        let candidates: Vec<String> = std::mem::take(&mut self.gc_candidates).into_iter().collect();
        self.sweep_blobs(&candidates).await;
    }

    /// One page of "keep the current hash, drop the rest" over these files.
    /// A fileId the manifest no longer holds (a deleted file) keeps nothing.
    async fn sweep_blobs(&self, fids: &[String]) {
        for fid in fids {
            let current = self.state.manifest.files.get(fid).map(|f| f.hash.as_str());
            let Ok(blobs) = self.remote.list_blobs(fid).await else { continue };
            for (hash, uploaded_ms) in blobs {
                let old_enough = now_ms().saturating_sub(uploaded_ms) > GC_MIN_AGE_MS;
                if old_enough && current != Some(hash.as_str()) {
                    let _ = self.remote.delete_blob(fid, &hash).await;
                }
            }
        }
    }

    /* ----- the retired manifest history ----- */

    /// Every fileId this workspace can name, sorted — live files and
    /// tombstones both, because a deleted file's blobs are exactly what the
    /// old system left in the bucket. Sorted, so a cursor into it means the
    /// same thing on the next poll.
    fn legacy_fids(&self) -> Vec<String> {
        let m = &self.state.manifest;
        let mut fids: BTreeSet<&String> = m.files.keys().collect();
        fids.extend(m.tombstones.keys());
        fids.into_iter().cloned().collect()
    }

    /// The one-time clean-up of what the manifest's history left behind:
    /// every blob but each file's current one. `LEGACY_BATCH` fileIds per
    /// poll, so it costs nothing on the hot path, and the bookmark is
    /// persisted, so it survives a restart and is never done twice.
    ///
    /// This used to sweep the `history/<fid>.json` archives first. Those
    /// routes are gone, and the archives with them:
    /// a workspace whose first pass never finished keeps a few small objects
    /// nothing reads, and the wipe takes them. The blobs are the part that
    /// was worth the walk — a deep revision of a large file is megabytes —
    /// and nothing else collects them: the per-cycle GC only looks at files
    /// this device has touched, so a file never edited again would keep its
    /// old revisions for ever.
    pub(crate) async fn legacy_cleanup(&mut self) {
        if self.state.legacy_cleanup.done {
            return;
        }
        if !self.state.legacy_cleanup.archives_done {
            // A device still deleting archives when this release arrived has
            // a bookmark into a pass that no longer exists. The blob pass
            // starts from the beginning rather than inheriting it — it is
            // idempotent, and skipping part of the backlog is not.
            self.state.legacy_cleanup.archives_done = true;
            self.state.legacy_cleanup.cursor = None;
            self.persist_state();
        }
        let after = self.state.legacy_cleanup.cursor.clone();
        let batch: Vec<String> = self
            .legacy_fids()
            .into_iter()
            .filter(|f| after.as_deref().map(|c| f.as_str() > c).unwrap_or(true))
            .take(LEGACY_BATCH)
            .collect();

        if batch.is_empty() {
            // Off the end of the list: this workspace never looks again.
            self.state.legacy_cleanup.done = true;
            self.state.legacy_cleanup.cursor = None;
            self.persist_state();
            return;
        }

        self.sweep_blobs(&batch).await;
        self.state.legacy_cleanup.cursor = batch.last().cloned();
        self.persist_state();
    }

    pub(crate) fn file_id_at(&self, rel: &str) -> Option<String> {
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
    /// device wins first; then the status shows the final slug). `req.rel` is
    /// relative to this unit; `elsewhere` is every address the workspace's
    /// other sections hold on this Mac. An address held by a section this
    /// Mac is not in is the domain's to refuse, when the manifest is stored.
    pub(crate) fn queue_publish(
        &mut self,
        req: PublishRequest,
        signature: &str,
        elsewhere: &BTreeSet<String>,
    ) -> Result<String, String> {
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
            if elsewhere.contains(&s) {
                return Err(format!("\"{}\" is already the address of another page", s));
            }
            s
        } else {
            existing
                .clone()
                .unwrap_or_else(|| unique_slug(&random_slug(), |s| effective.contains_key(s) || elsewhere.contains(s)))
        };

        let op = PendingPublic {
            kind: req.kind,
            file,
            path: rel,
            title: clean_text(req.title.as_deref(), MAX_TITLE_LEN),
            desc: clean_text(req.desc.as_deref(), MAX_DESC_LEN),
            custom,
            by: signature.to_string(),
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
        Ok(())
    }
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
