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
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::json;
use super::engine::{PublishRequest, Trash};
use super::manifest::{
    clean_text, dedupe_paths, files_under, random_slug, unique_slug, valid_rel_path, valid_slug, Manifest,
    ManifestFile, PublicEntry, PublicKind, Target, Tombstone, MANIFEST_VERSION, MAX_DESC_LEN, MAX_NAME_LEN,
    MAX_TITLE_LEN,
};
use super::merge::{conflict_copy_path, merge_texts, MergeOutcome};
use crate::sidecar::sidecar_of;
use super::pace::{Pacer, BATCH_BYTES, BATCH_FILES, EXPRESS};
use super::remote::{Remote, RemoteError, RemoteResult};
use super::scan::{
    content_type_for, hash16, now_ms, random_id, read_file_checked, read_json, rel_path, scan_local, stat_pair,
    write_atomic, write_json, ScanEntry,
};
use super::space::{reserved_top, RESERVED_DIRS, SHARED};
use super::status::{Events, PublicPage, RecentFile, EV_ADDRESS_TAKEN, EV_CONFLICT, EV_PENDING_DELETES};
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
const CAS_ATTEMPTS: usize = 4;
/// How long an upload is remembered (`WorkspaceState::uploaded`): well
/// inside the day the worker's sweep leaves a blob no manifest names
/// (`SWEEP_MIN_AGE_MS`, cloud-worker/src/sweep.ts), so a blob remembered here
/// is still on the domain. Change both.
const UPLOADED_TTL_MS: u64 = 12 * 60 * 60 * 1000;

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
    /// A new file's id, by path, from the moment its bytes first go up until
    /// a won manifest carries it. A push that loses a race, is cut short, or
    /// goes in batches sends the same file under the same id again — so the
    /// upload it already made is found rather than repeated, and nothing is
    /// left on the domain under an id no manifest will ever name.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub pending_new: BTreeMap<String, String>,
    /// Blobs this device has put up, `<fileId>/<hash>` → when. One of these
    /// is not sent again (`UPLOADED_TTL_MS`).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub uploaded: BTreeMap<String, u64>,
    /// Files whose newest revision on the domain is not on this device yet:
    /// downloads the bulk lane still owes. Never pushed over, never read as
    /// deleted, until they have arrived.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub owed: BTreeSet<String>,
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
    /// A file no manifest has carried yet.
    new: bool,
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
    pub trash: Option<Trash>,
    /// Public addresses another section on this Mac still has to give up.
    pub releasing: &'a HashSet<String>,
    /// Files of this unit that are in another section on this Mac now.
    pub moved_out: &'a HashMap<String, MovedOut>,
    /// Files that came into this unit from another section on this Mac:
    /// their path here, and the id they had there, which they keep. Links
    /// and *Copy link*s name a file by its id, so a move never breaks one.
    pub moved_in: &'a HashMap<String, String>,
    /// Every file id the other sections on this device last applied: with
    /// this unit's own, whether a link's file exists (`sidecar::merge`).
    pub elsewhere: &'a HashSet<String>,
    /// The workspace's bulk lane (pace.rs).
    pub pacer: &'a Mutex<Pacer>,
    /// Paths of this unit the app itself wrote since they last went up: a
    /// person's own edits, which never wait behind a bulk job.
    pub touched: &'a HashSet<String>,
    /// The many-new-documents valve is holding: files no manifest has
    /// carried stay on this device until the person says.
    pub hold_new: bool,
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
    /// That folder inside the workspace: `Library`, `Private` or
    /// `Restricted/<folder>`, as the disk spells it.
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
    /// The last cycle left work for the bulk lane: uploads it did not send,
    /// or downloads it still owes. The engine comes back for it.
    pub owes: bool,
    /// How many changes that work is.
    pub waiting: u32,
}

impl<R: Remote> Unit<R> {
    pub(crate) fn new(cfg: UnitConfig, remote: Arc<R>) -> Self {
        let _ = std::fs::create_dir_all(cfg.state_dir.join("base"));
        let mut state: WorkspaceState = read_json(&cfg.state_dir.join("state.json")).unwrap_or_default();
        if forget_out_of_scope(&mut state, &cfg.state_dir) {
            let _ = write_json(&cfg.state_dir.join("state.json"), &state);
        }
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
            deferred: HashSet::new(),
            poke: false,
            gone: false,
            cloud_versions: None,
            mirror: None,
            last_mirror_ms: None,
            owes: false,
            waiting: 0,
        }
    }

    pub(crate) fn is_shared(&self) -> bool {
        self.id == SHARED
    }

    /// What this unit's walk leaves out: for the shared section, the two
    /// names it keeps at its own top (`RESERVED_DIRS`).
    fn skip(&self) -> &'static [&'static str] {
        if self.is_shared() {
            &RESERVED_DIRS
        } else {
            &[]
        }
    }

    /// A path of this unit as the workspace spells it.
    pub(crate) fn ws_rel(&self, rel: &str) -> String {
        if rel.is_empty() {
            self.prefix.clone()
        } else {
            format!("{}/{}", self.prefix, rel)
        }
    }

    /// A workspace-relative path as this unit spells it, when it is this
    /// unit's: `Some("")` is the unit's own folder. Inside the shared
    /// section, a section's name at its top is nobody's.
    pub(crate) fn in_unit(&self, ws_rel: &str) -> Option<String> {
        // The folder's own name compares the way the disk does.
        let head = ws_rel.get(..self.prefix.len()).filter(|head| head.eq_ignore_ascii_case(&self.prefix))?;
        let rest = match &ws_rel[head.len()..] {
            "" => "",
            rest => rest.strip_prefix('/')?,
        };
        if self.is_shared() && reserved_top(rest).is_some() {
            return None;
        }
        Some(rest.to_string())
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

    pub(crate) fn confirm_deletes(&mut self) {
        if !self.held_deletes.is_empty() {
            self.allow_mass_delete = true;
            self.held_deletes.clear();
            self.poke = true;
        }
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
        let cutoff = now_ms().saturating_sub(UPLOADED_TTL_MS);
        self.state.uploaded.retain(|_, at| *at >= cutoff);
        // What the bulk lane gives this cycle, once asked: a lost race goes
        // again on the same allowance rather than drawing more of it.
        let mut downloads: Option<usize> = None;
        let mut batch: Option<usize> = None;

        for attempt in 0..CAS_ATTEMPTS {
            // 1. Where is remote?
            if self.incoming.is_none() {
                self.fetch().await?;
            }
            let Some((remote_manifest, remote_etag)) = self.incoming.take() else { break };

            // 2. Apply remote-only changes to disk (downloads, renames,
            //    deletions). Local-vs-remote overlap is decided inside.
            let applied = self.apply_remote(&remote_manifest, ctx, &mut downloads).await?;
            changed_paths.extend(applied);

            // 3. What changed locally — and of that, what goes this cycle.
            let scan = scan_local(&self.root, self.skip()).map_err(RemoteError::Other)?;
            let mut staged = self.stage_local(&scan, &remote_manifest, ctx).await?;
            let held = self.pace_pushes(&mut staged, ctx, &mut batch);
            self.waiting = held + self.state.owed.len() as u32;
            self.owes = self.waiting > 0;

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
            // A manifest from before the md + html rule still names files
            // nobody syncs; the first write cleans it.
            let cleans = !in_scope(&remote_manifest);

            // Remote moved under us but we have nothing to say: adopt theirs.
            if staged.is_empty() && !public_changed && !cleans {
                // Ops that resolved to exactly what the manifest already says
                // are spent — a CAS carrying no change would be pure waste.
                self.clear_folded(&folded);
                self.state.manifest = remote_manifest;
                self.state.manifest_etag = Some(remote_etag);
                self.persist_state();
                return Ok(changed_paths);
            }

            // 4. Upload content first (idempotent, content-addressed), then
            //    try to win the manifest. A new file's id is written down
            //    before its bytes go, and each upload once it has landed: a
            //    push cut short anywhere resumes with what it already sent.
            for push in staged.pushes.iter().filter(|p| p.new) {
                self.state.pending_new.insert(push.path.clone(), push.file_id.clone());
            }
            self.persist_state();
            for push in &staged.pushes {
                let key = format!("{}/{}", push.file_id, push.hash);
                if self.state.uploaded.contains_key(&key) {
                    continue;
                }
                let sent = self
                    .remote
                    .put_blob(&push.file_id, &push.hash, push.bytes.clone(), content_type_for(&push.path))
                    .await;
                if let Err(e) = sent {
                    self.persist_state();
                    return Err(e);
                }
                self.state.uploaded.insert(key, now_ms());
            }
            self.persist_state();

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
                    // reality. What went up stays up, and is not sent again.
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

    /// Which staged pushes go this cycle. All of them while there are no
    /// more than `EXPRESS`. Past that, the paths the app itself just wrote go
    /// at once — a person's own edit never waits behind a bulk job — and the
    /// rest go one batch a cycle, as many as the bulk lane gives (none while
    /// it waits), edits to known files before new ones, smallest first.
    /// Answers how many are left for later.
    fn pace_pushes(&self, staged: &mut Staged, ctx: &Ctx<'_>, batch: &mut Option<usize>) -> u32 {
        if staged.pushes.len() <= EXPRESS {
            return 0;
        }
        staged.pushes.sort_by_key(|p| (!ctx.touched.contains(&p.path), p.new, p.bytes.len()));
        let express = staged.pushes.iter().take_while(|p| ctx.touched.contains(&p.path)).count().min(EXPRESS);
        let rest = staged.pushes.len() - express;
        let allowed = *batch.get_or_insert_with(|| lock(ctx.pacer).take(rest.min(BATCH_FILES)));
        let mut keep = express;
        let mut bytes = 0u64;
        for push in &staged.pushes[express..] {
            let size = push.bytes.len() as u64;
            if keep - express >= allowed || (keep > express && bytes + size > BATCH_BYTES) {
                break;
            }
            bytes += size;
            keep += 1;
        }
        let held = staged.pushes.len() - keep;
        staged.pushes.truncate(keep);
        held as u32
    }

    /* ----- status ----- */

    /// This section's documents as `cloud_recent` lists them: what the last
    /// manifest this device applied says of each — unless the file here has
    /// changed since this device last synced it, or no manifest carries it
    /// yet: then the change is this device's, signed `me`, at the file's own
    /// time, with no hash until it syncs. Comment files are not documents,
    /// and what is not on this device is not listed.
    pub(crate) fn recent(&self, me: &str) -> Vec<RecentFile> {
        let section = (!self.is_shared()).then(|| self.id.clone());
        let is_document = |path: &str| !path.to_ascii_lowercase().ends_with(".meta.jsonl");
        let disk = scan_local(&self.root, self.skip()).unwrap_or_default();
        let mut listed: HashSet<&str> = HashSet::new();
        let mut out = Vec::new();
        for (fid, file) in &self.state.manifest.files {
            if !is_document(&file.path) {
                continue;
            }
            let Some(here) = disk.get(&file.path) else { continue };
            listed.insert(file.path.as_str());
            let untouched = self
                .state
                .files
                .get(fid)
                .is_some_and(|synced| synced.path == file.path && synced.size == here.size && synced.mtime_ms == here.mtime_ms);
            out.push(if untouched {
                RecentFile {
                    path: self.ws_rel(&file.path),
                    file_id: Some(fid.clone()),
                    hash: Some(file.hash.clone()),
                    mtime: file.mtime,
                    by: file.by.clone(),
                    rev: file.rev,
                    section: section.clone(),
                }
            } else {
                RecentFile {
                    path: self.ws_rel(&file.path),
                    file_id: Some(fid.clone()),
                    hash: None,
                    mtime: here.mtime_ms.max(file.mtime),
                    by: me.to_string(),
                    rev: file.rev,
                    section: section.clone(),
                }
            });
        }
        for (rel, here) in &disk {
            if listed.contains(rel.as_str()) || !is_document(rel) {
                continue;
            }
            out.push(RecentFile {
                path: self.ws_rel(rel),
                file_id: None,
                hash: None,
                mtime: here.mtime_ms,
                by: me.to_string(),
                rev: 0,
                section: section.clone(),
            });
        }
        out
    }

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
    /// change that is lost. True when a pass finished. `budget` is the bulk
    /// lane's: what it does not cover goes up on a later pass.
    pub(crate) async fn mirror_versions(&mut self, budget: &mut usize) -> bool {
        let store = crate::versions::store_for_root(&self.data_dir, &self.root);
        let remote = self.remote.clone();
        let mut swept = self.state.last_cloud_sweep_ms;
        let result =
            version_store::mirror(remote.as_ref(), &store, &self.device_id, &mut swept, now_ms(), budget).await;
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
    ///
    /// Downloads are paced like uploads: what this manifest changed goes at
    /// once while it is no more than `EXPRESS` downloads; past that, and for
    /// whatever an earlier cycle still owes, one batch a cycle as the bulk
    /// lane allows (`downloads`, drawn once per cycle). What is left is
    /// `owed`, and the next cycle carries on with it.
    async fn apply_remote(
        &mut self,
        remote: &Manifest,
        ctx: &Ctx<'_>,
        downloads: &mut Option<usize>,
    ) -> RemoteResult<Vec<String>> {
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
                    self.delete_local(&abs, ctx.trash.as_ref());
                    touched.push(fstate.path.clone());
                }
                None => {}
            }
            // Either way this fileId's story is over for our state; an
            // edited survivor re-enters as a brand-new file next scan.
            self.state.files.remove(&fid);
            let _ = std::fs::remove_file(self.base_path(&fid));
        }

        // New or changed files: what this manifest changed, and what an
        // earlier cycle still owes. Never a file outside what syncs.
        let fresh: Vec<(String, ManifestFile)> = remote
            .files
            .iter()
            .filter(|(_, rf)| crate::syncs(&rf.path))
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
        self.state.owed.retain(|fid| remote.files.get(fid).is_some_and(|rf| crate::syncs(&rf.path)));
        let owed: Vec<(String, ManifestFile)> = self
            .state
            .owed
            .iter()
            .filter(|fid| !fresh.iter().any(|(f, _)| f == *fid))
            .map(|fid| (fid.clone(), remote.files[fid].clone()))
            .collect();
        let needs_bytes = |state: &WorkspaceState, fid: &str, rf: &ManifestFile| {
            state.files.get(fid).map(|held| held.hash != rf.hash).unwrap_or(true)
        };
        let fresh_bytes = fresh.iter().filter(|(fid, rf)| needs_bytes(&self.state, fid, rf)).count();
        let (express, bulk) = if fresh_bytes <= EXPRESS {
            (fresh, owed)
        } else {
            (Vec::new(), fresh.into_iter().chain(owed).collect())
        };

        // Conflict copies made in this pass, beside the document each is of.
        let mut copies: Vec<(String, String)> = Vec::new();
        for (fid, rf) in express {
            if !self.apply_file(&fid, &rf, remote, ctx, &mut touched, &mut copies).await? {
                self.state.owed.insert(fid);
            }
        }

        let wanted = bulk.iter().filter(|(fid, rf)| needs_bytes(&self.state, fid, rf)).count();
        let mut left = *downloads.get_or_insert_with(|| lock(ctx.pacer).take(wanted.min(BATCH_FILES)));
        let mut bytes = 0u64;
        for (fid, rf) in bulk {
            if needs_bytes(&self.state, &fid, &rf) {
                if left == 0 || bytes >= BATCH_BYTES {
                    self.state.owed.insert(fid);
                    continue;
                }
                left -= 1;
                bytes += rf.size;
            }
            if self.apply_file(&fid, &rf, remote, ctx, &mut touched, &mut copies).await? {
                self.state.owed.remove(&fid);
            } else {
                self.state.owed.insert(fid);
            }
        }
        *downloads = Some(left);
        // A conflict copy's markers and links name records in its document's
        // sidecar, so the copy gets one of its own: the document's, as this
        // pass left it, which holds both sides' records.
        for (doc, copy) in copies {
            let (from, to) = (self.root.join(sidecar_of(&doc)), self.root.join(sidecar_of(&copy)));
            if to.exists() {
                continue;
            }
            if let Some(bytes) = read_file_checked(&from) {
                if write_atomic(&to, &bytes).is_ok() {
                    touched.push(sidecar_of(&copy));
                }
            }
        }
        Ok(touched)
    }

    /// Apply one file the remote changed. False when it could not be applied
    /// this cycle — the copy here changed while its download was in flight —
    /// and is owed to the next.
    async fn apply_file(
        &mut self,
        fid: &str,
        rf: &ManifestFile,
        remote: &Manifest,
        ctx: &Ctx<'_>,
        touched: &mut Vec<String>,
        copies: &mut Vec<(String, String)>,
    ) -> RemoteResult<bool> {
        let (fid, rf) = (fid.to_string(), rf.clone());
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
                        return Ok(true);
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
                return Ok(true);
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
            // The file may have changed in the window since we looked; if
            // so, leave it — it is owed, and the next cycle merges it.
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
            return Ok(safe);
        }

        // Both sides have this file. Identical bytes are not a conflict
        // — a folder resumed in place, or two devices that wrote the
        // same thing: adopt the revision as synced and move on.
        let ours = local_now.unwrap_or_default();
        // The content address settles it before anything is downloaded.
        if hash16(&ours) == rf.hash {
            self.record_synced(&fid, &rf, Some(&ours));
            return Ok(true);
        }
        let theirs = self.remote.get_blob(&fid, &rf.hash).await?;

        // Both sides changed: three-way merge against the stored base. A
        // sidecar is merged by its records, and never conflicts.
        let base = std::fs::read(self.base_path(&fid)).ok();
        let merged = if crate::sidecar::is_sidecar(&rf.path) {
            let text = |b: &[u8]| String::from_utf8_lossy(b).into_owned();
            let exists = |file: &str| remote.files.contains_key(file) || self.state.files.contains_key(file) || ctx.elsewhere.contains(file);
            MergeOutcome::Clean(crate::sidecar::merge(base.as_deref().map(text).as_deref(), &text(&ours), &text(&theirs), &exists))
        } else {
            merge_texts(base.as_deref(), &ours, &theirs)
        };
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
                copies.push((rf.path.clone(), copy_rel.clone()));
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
        Ok(true)
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
            if self.state.owed.contains(&fid) {
                // A newer revision is on its way: pushing this copy would
                // write over it unmerged, and reading it gone would delete it.
                continue;
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
                    staged.pushes.push(StagedPush { file_id: fid, path: fstate.path.clone(), hash, bytes, new: false });
                }
            }
        }

        // Pass 2: paths we don't know — new files (or the far side of a
        // rename, matched by content below).
        // A path where a file the domain has and this device is still owed
        // will land is that file's: it is merged when it arrives.
        let arriving: HashSet<&str> =
            self.state.owed.iter().filter_map(|fid| remote.files.get(fid)).map(|rf| rf.path.as_str()).collect();
        let mut news: Vec<(String, Vec<u8>, String)> = Vec::new(); // (path, bytes, hash)
        for (path, entry) in scan {
            if by_path.contains_key(path) || arriving.contains(path.as_str()) {
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
        //
        // A new file keeps the id it was first sent under (`pending_new`).
        // While the many-new-documents valve holds, new files stay here.
        self.state.pending_new.retain(|path, _| scan.contains_key(path) && !by_path.contains_key(path));
        for (path, bytes, hash) in remaining_news {
            let existing = remote.files.iter().find(|(_, rf)| rf.path == path);
            match existing {
                Some((fid, _)) if self.state.files.contains_key(fid) => {
                    if self.state.files.get(fid).map(|s| s.hash != hash).unwrap_or(true) {
                        staged.pushes.push(StagedPush { file_id: fid.clone(), path, hash, bytes, new: false });
                    }
                }
                _ if ctx.hold_new => {}
                _ => {
                    // A file moved in from another section keeps its id,
                    // unless this section already has a file by it.
                    let kept = ctx
                        .moved_in
                        .get(&path)
                        .filter(|fid| !self.state.files.contains_key(*fid) && !remote.files.contains_key(*fid));
                    let fid = self
                        .state
                        .pending_new
                        .get(&path)
                        .or(kept)
                        .cloned()
                        .unwrap_or_else(|| random_id("f"));
                    staged.pushes.push(StagedPush { file_id: fid, path, hash, bytes, new: true });
                }
            }
        }

        Ok(staged)
    }

    /// Fold the staged changes into `next` (a clone of the freshest remote
    /// manifest).
    ///
    /// Everything this writes is signed with `ctx.signature` — the member
    /// id the domain says this device signs in as. Entries it does not touch
    /// keep the `by` they carry.
    fn build_manifest(&self, next: &mut Manifest, staged: &Staged, ctx: &Ctx<'_>) {
        next.version = MANIFEST_VERSION;
        next.seq += 1;
        if next.name.is_empty() {
            next.name = self.name.clone();
        }
        next.name = super::manifest::cap_utf16(&next.name, MAX_NAME_LEN);
        // Only what syncs is in a manifest. One written before that rule is
        // cleaned here: every device has already forgotten those files
        // (`forget_out_of_scope`), so leaving the manifest deletes nothing.
        next.files.retain(|_, f| crate::syncs(&f.path));
        next.tombstones.retain(|_, t| crate::syncs(&t.path));
        next.public.retain(|_, e| e.kind != PublicKind::File || crate::syncs(&e.path));

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
            }
            if push.new {
                self.state.pending_new.remove(&push.path);
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

    fn delete_local(&self, abs: &Path, trash: Option<&Trash>) {
        if trash.is_some_and(|trash| trash(abs)) {
            return;
        }
        let _ = std::fs::remove_file(abs);
    }

    fn delete_local_silent(&self, abs: &Path) {
        let _ = std::fs::remove_file(abs);
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
            PublicKind::File if !crate::syncs(&rel) => {
                return Err("Only markdown and html documents can be published.".into())
            }
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
                    return Err(format!("\"{}\" is already the address of {}", s, describe(e, &self.ws_rel(&e.path))));
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

/// What a page is of, named by its workspace-relative path: a section's
/// whole folder by the section's name.
fn describe(e: &PublicEntry, ws_path: &str) -> String {
    match e.kind {
        PublicKind::Dir if !e.path.is_empty() => format!("the folder {}", ws_path),
        _ => ws_path.to_string(),
    }
}

/// A lock that a panic elsewhere has not made useless: the pacer holds
/// counts, and a count is still a count.
pub(crate) fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Whether a manifest names only what syncs.
fn in_scope(m: &Manifest) -> bool {
    m.files.values().all(|f| crate::syncs(&f.path))
        && m.tombstones.values().all(|t| crate::syncs(&t.path))
        && m.public.values().all(|e| e.kind != PublicKind::File || crate::syncs(&e.path))
}

/// Forget every file a unit's state holds that does not sync — its record
/// and its merge base; the file on disk is never touched. What a device kept
/// before the md + html rule leaves its state this way, before any manifest
/// leaves it: a file absent from a manifest with no tombstone is a deletion
/// (`apply_remote`), so the state must let go first. True when it changed.
fn forget_out_of_scope(state: &mut WorkspaceState, state_dir: &Path) -> bool {
    let gone: Vec<String> =
        state.files.iter().filter(|(_, st)| !crate::syncs(&st.path)).map(|(fid, _)| fid.clone()).collect();
    for fid in &gone {
        state.files.remove(fid);
        let _ = std::fs::remove_file(state_dir.join("base").join(fid));
    }
    let before = state.pending_new.len();
    state.pending_new.retain(|path, _| crate::syncs(path));
    !gone.is_empty() || state.pending_new.len() != before
}
