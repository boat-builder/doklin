//! The engine: one task per connected workspace, the only code that holds a
//! token or talks to the worker.
//!
//! A workspace is several *sections* — the shared part everyone has, this
//! person's Private, each restricted folder they are in — and each one is a
//! unit (unit.rs): its own folder, its own manifest, its own state. The unit
//! knows how one folder is kept in step with one manifest; this file is what
//! a workspace has one of: who the domain says this Mac is, the poll and the
//! beat that rides it, presence and leases, the status that is the
//! frontend's entire model, and the task that decides when which unit
//! cycles. It is also the only place two units meet: a space arriving or
//! leaving (`reconcile_spaces`), a file moving between sections on this Mac
//! (`pair_moves`) and on another (`relocate`).
//!
//! The engine wakes on four things — the edit bus, the filesystem watcher,
//! the poll clock, commands — and does one of two: a *pass* (the units with
//! something to say each run a cycle) or a *poll* (etags + presence, and
//! this Mac's own beat when one is due — the beat has no request of its
//! own). Generic over [`Remote`] so all of it runs in tests against an
//! in-memory worker.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use super::manifest::{
    lease_key, valid_rel_path, Beat, LeaseEntry, Manifest, PollResponse, PublicKind, SpaceEntry,
    SpaceKind,
};
use super::merge::conflict_copy_path;
use super::pace::{next_midnight_ms, Mode, Pacer, MIN_BATCH};
use super::remote::{Remote, RemoteError, RemoteResult};
use super::scan::{hash16, now_ms, read_file_checked, rel_path};
use super::space::{self, SpaceMarker, PRIVATE_DIR, SHARED};
use super::status::{
    emit_statuses, CloudStatus, DirectoryPerson, Events, LeaseHolder, Phase, PresenceDevice, PublicPage, RecentFiles,
    SpaceStatus, StatusTable, UsageStatus, VersionsMirror, EV_APPLIED, EV_CONFLICT, EV_PENDING_ADDS, EV_SPACE_LEFT,
};
use super::unit::{lock, Ctx, MovedOut, PendingPublic, PublicOp, Survey, Unit, UnitConfig};
use super::versions::{VersionsIndex, MIRROR_EVERY};
use crate::versions::store::Snapshot as VersionSnapshot;

/* ---------- Tunables ---------- */

/// Poll cadence while a window of the workspace has focus and is in use.
/// Edits trigger cycles through the bus and the watcher, so this is the
/// ceiling on how stale a workspace someone is looking at can get, not the
/// feel of sync. Attention sets the rest (`Engine::poll_gap`): every poll is
/// a request against the account's day, and a Mac left on overnight need
/// not spend thousands of them on a folder nobody is looking at.
pub const POLL_INTERVAL: Duration = Duration::from_secs(15);
/// No window of it focused, or nothing done in it for `IDLE_AFTER`.
pub(crate) const POLL_BACKGROUND: Duration = Duration::from_secs(60);
/// Nothing done in it for `AWAY_AFTER`.
pub(crate) const POLL_AWAY: Duration = Duration::from_secs(5 * 60);
pub(crate) const IDLE_AFTER: Duration = Duration::from_secs(5 * 60);
pub(crate) const AWAY_AFTER: Duration = Duration::from_secs(30 * 60);
/// How long a beat says it holds (`Beat::Here::ttl`): two and a half of the
/// gaps to the next one, so one lost beat is survivable, within the
/// worker's bounds.
const BEAT_TTL_MIN: Duration = Duration::from_secs(90);
const BEAT_TTL_MAX: Duration = Duration::from_secs(15 * 60);
/// The retry clock: how long after the n-th failure in a row the next try
/// may go, each ± `BACKOFF_JITTER`. A success starts it again.
pub(crate) const BACKOFF: [Duration; 6] = [
    Duration::from_secs(15),
    Duration::from_secs(30),
    Duration::from_secs(60),
    Duration::from_secs(120),
    Duration::from_secs(300),
    Duration::from_secs(600),
];
/// While the account's daily requests are used up: one probe this often.
const LIMITED_PROBE: Duration = Duration::from_secs(30 * 60);
/// How far a step of the retry clock is moved, either way, so devices that
/// failed together do not come back together.
pub(crate) const BACKOFF_JITTER: f64 = 0.2;
/// Devices come back after the daily reset spread over this long, rather
/// than all in its first second.
const LIMITED_SPREAD_MS: u64 = 10 * 60 * 1000;
/// In slow mode, a pass at most this often (touches coalesce).
const SLOW_PASS_GAP: Duration = Duration::from_secs(60);
/// The most the version mirror sends in one pass.
const MIRROR_BUDGET: usize = 200;
/// Filesystem events (external editors, git, Finder) batch this long before
/// a pass runs.
pub const FS_SETTLE: Duration = Duration::from_millis(5000);
/// The app's own writes (the edit bus) settle this long after the last
/// touch — autosave is already debounced 600 ms upstream, so an edit reaches
/// the cloud about two seconds after the keystroke.
pub const TOUCH_SETTLE: Duration = Duration::from_millis(1500);
/// Presence heartbeat cadence. The beat rides the poll:
/// it goes out on the first poll at least this long after the last one landed
/// — every third, at a 15 s poll — and well inside the worker's 90 s TTL, so
/// one lost beat is survivable and two are not. It is also what renews a
/// lease, which lives exactly as long as presence does.
pub(crate) const PRESENCE_BEAT: Duration = Duration::from_secs(45);
/// How long a document counts as being edited here after it was last opened
/// or typed in: what presence reports as "editing <path>", and how long this
/// Mac keeps the document's lease. Long enough to stop
/// and think without the document going to somebody else; short enough that a
/// Mac left on with a note open lets go of it by the time anyone minds.
pub(crate) const ACTIVITY_FRESH: Duration = Duration::from_secs(5 * 60);
/// The least time between two fetches of the workspace's directory. A
/// manifest naming somebody this engine cannot name asks for it again — a
/// colleague invited an hour ago should not need a restart to get a name —
/// but an id belonging to somebody since removed never resolves, and that
/// must cost one request every so often rather than one per cycle.
pub(crate) const DIRECTORY_MIN_GAP: Duration = Duration::from_secs(300);

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
    /// Ask the worker what it is again — "Check again" after an update.
    /// A 426 pause resumes on its own the moment a newer version answers.
    Probe,
    /// The edit bus: a workspace-relative path the app just wrote.
    Touched(String),
    /// The absolute path the user is editing, or nothing.
    SetActivity(Option<String>),
    /// The user chose *Take over* on a document another Mac holds (absolute
    /// path): the next beat claims it from whoever has it.
    TakeOver(String),
    /// A window of this workspace gained focus, or none has it any more.
    Focus(bool),
    Pause(bool),
    ConfirmDeletes,
    /// The many-new-documents valve: true is *Sync them*, false *Not now*.
    ConfirmAdds(bool),
    /// *Send them now*: this device's bulk wait is lifted until 00:00 UTC.
    LiftWait,
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
    /// The cloud version store, for the history rail's read-through: what
    /// the bucket holds, one mirrored snapshot, one mirrored version's bytes.
    /// `rel` is a workspace-relative path in the section whose store is
    /// meant — every section has its own.
    VersionsIndex {
        rel: String,
        reply: oneshot::Sender<Result<Option<VersionsIndex>, String>>,
    },
    VersionSnapshot {
        rel: String,
        id: String,
        reply: oneshot::Sender<Result<VersionSnapshot, String>>,
    },
    SetCloudHorizon {
        rel: String,
        days: Option<u32>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    VersionBlob {
        rel: String,
        hash: String,
        reply: oneshot::Sender<Result<Vec<u8>, String>>,
    },
    /// Make a restricted folder holding this person and `members` (member
    /// ids). With `from` — the absolute path of a folder in this workspace —
    /// that folder becomes it; otherwise it starts empty.
    MakeSpace {
        name: String,
        members: Vec<String>,
        from: Option<String>,
        reply: oneshot::Sender<Result<SpaceStatus, String>>,
    },
    /// Add a person to a restricted folder, or take one out — this person
    /// included, which is leaving it.
    SpaceMember {
        id: String,
        member: String,
        add: bool,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Delete a restricted folder for everyone in it.
    DeleteSpace {
        id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// *Copy link*: the section and file id of `rel` (workspace-relative),
    /// and who can open it. A file made a moment ago has no id until a pass
    /// has taken it in, so one runs first when it has none.
    LinkTo {
        rel: String,
        reply: oneshot::Sender<Result<Linked, String>>,
    },
    /// A link followed: where the file it names is on this device,
    /// workspace-relative. What another device wrote a moment ago reaches
    /// this one on a poll, so one runs first when it is not here.
    Follow {
        space: Option<String>,
        file: String,
        reply: oneshot::Sender<Result<String, String>>,
    },
    /// `cloud_recent`: the documents by when they last changed, newest first.
    Recent {
        limit: usize,
        reply: oneshot::Sender<Result<RecentFiles, String>>,
    },
    Shutdown,
}

/// What a link to one file needs from the engine that holds it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Linked {
    /// The space the file is in; None is the shared workspace.
    pub space: Option<String>,
    pub file: String,
    /// Who can open the link, as a sentence: "Everyone in Acme can open it."
    pub who: String,
}

/// Why an engine's task ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Exit {
    /// It was told to stop: the app is quitting, or the workspace was
    /// disconnected on this Mac.
    Shutdown,
    /// The domain said this Mac's access was taken away (`RemoteError::Removed`).
    /// The engine touches nothing on its way out; whoever spawned it deletes
    /// this Mac's copy of the workspace (`access_removed`, mod.rs).
    Removed,
}

/// Which folders on this Mac are spaces just changed.
#[derive(Default)]
pub struct SpacesChanged {
    /// Space folders taken off this Mac: where each was, and where its
    /// version store is — found while the folder still existed, because a
    /// store's key is the folder's canonical path.
    pub removed: Vec<(String, PathBuf)>,
}

/// Moves a file to the platform's trash; true when it did.
pub type Trash = Arc<dyn Fn(&Path) -> bool + Send + Sync>;

/* ---------- The engine ---------- */

pub struct EngineConfig {
    pub ws_id: String,
    pub name: String,
    pub root: PathBuf,
    pub domain: String,
    pub endpoint: String,
    /// The shared workspace's `state.json` + `base/`; each space's are under
    /// `spaces/<id>/` in here.
    pub state_dir: PathBuf,
    /// `<app_data>`, so the engine can open each section's version store —
    /// read-only, and only to mirror it.
    pub data_dir: PathBuf,
    pub device_id: String,
    pub device_name: String,
    /// `Mac`, `iPhone`, `iPad`: what the sentences about this device call it.
    pub device_kind: String,
    /// Where a real deletion goes: the platform's trash (`Host::trash`).
    /// None — the tests, and a platform with no trash — removes outright.
    pub trash: Option<Trash>,
    /// Called when a space's folder appears on this Mac or leaves it, so the
    /// manager can start and stop what follows a folder — its versioner.
    pub on_spaces: Option<Box<dyn Fn(SpacesChanged) + Send + Sync>>,
}

/// Which units a pass cycles besides the ones whose folder changed.
pub(crate) enum Which {
    /// Every one: first contact, *Sync now*.
    All,
    /// None: something on this Mac changed, and the survey says where.
    Dirty,
    /// The ones a poll said moved on the domain.
    Moved(BTreeSet<String>),
}

/// The account's daily requests are used up (`Phase::Limited`).
struct Limited {
    /// After the reset, spread: when sync goes again by itself.
    until_ms: u64,
    /// The next probe — sooner than that only if a plan upgrade lifted it.
    next_try: Instant,
}

/// The many-new-documents valve: what the last pass found, and what the
/// person said.
#[derive(Default)]
struct Adds {
    /// New documents the last pass found, when that was enough to hold.
    held: u32,
    /// Where they are: workspace-relative folders, most first.
    folders: Vec<(String, u32)>,
    /// *Sync them*: they go, until a pass finds fewer than the threshold.
    confirmed: bool,
    /// *Not now*, said when this many were held: not asked again until more
    /// arrive, or *Sync now*.
    declined: Option<u32>,
}

impl Adds {
    fn asking(&self) -> bool {
        self.held > 0 && !self.confirmed && self.declined.map_or(true, |d| self.held > d)
    }
}

/// A file that left one unit on this Mac and is the same file in another.
struct CrossMove {
    from: String,
    fid: String,
    to: String,
    /// Where it is now, relative to the unit it went to.
    path: String,
    hash: String,
}

pub struct Engine<R: Remote> {
    cfg: EngineConfig,
    remote: Arc<R>,
    events: Arc<dyn Events>,
    statuses: StatusTable,
    /// Every section this Mac holds, by id. The shared workspace is `SHARED`
    /// and always here; a unit is out of the map only while its cycle runs.
    units: BTreeMap<String, Unit<R>>,
    /// The spaces this person is in, as the last poll that could say listed
    /// them. `None` until one has.
    spaces: Option<Vec<SpaceEntry>>,
    /// How many times the domain would not make this person a Private. After
    /// a few it is not asked again until the app restarts.
    private_refusals: u8,
    /// Folders under `Restricted/` the domain would not make a restricted
    /// folder of, so each is asked about once rather than on every poll.
    unclaimable: HashSet<PathBuf>,
    phase: Phase,
    error: Option<String>,
    last_sync_ms: Option<u64>,
    paused: bool,
    /// Set when the worker answered `426`: the worker version we saw it at.
    /// Cycles stop until `/api/meta` reports a newer worker.
    outdated: Option<u32>,
    worker_version: Option<u32>,
    /// The member id this Mac signs with here, as `/api/meta` last said it.
    /// None until the domain has answered, and nothing syncs until it has:
    /// there is nobody to sign the work with.
    me: Option<String>,
    /// What this Mac's credential may do here, as the same answer spelled it
    /// (`you.can` — the worker's role table). Empty until the domain has
    /// answered.
    can: Vec<String>,
    /// The domain answered `Removed`: an owner took this Mac's access away.
    /// Set wherever a request can hear it (`heard_removed`), read by the task
    /// loop — which stops the engine and hands the rest to the manager.
    removed: bool,
    /// The superadmin's name, as the probe last said — whom to ask.
    superadmin: Option<String>,
    /// id → display name for everyone on this workspace, from the same
    /// answer. What a `by` is read with; a miss is shown as it stands.
    people: BTreeMap<String, String>,
    /// Agent id → its person's member id, from the same answer: whose agent
    /// changed something (`cloud_recent`).
    owners: BTreeMap<String, String>,
    /// When the directory was last fetched, so meeting an id nobody can name
    /// asks again — once, not once a cycle (`DIRECTORY_MIN_GAP`).
    people_at: Option<Instant>,
    /// When the hourly pass last ran: the mirror's floor.
    last_hourly: Option<Instant>,
    /// Absolute path the user is actively editing (frontend-reported).
    activity: Option<(String, Instant)>,
    /// When the last beat that landed was sent, and the workspace-relative
    /// path it named — what makes the next one due.
    last_beat: Option<Instant>,
    beaconed: Option<String>,
    presence: Vec<PresenceDevice>,
    /// Every live lease, from the last poll that answered; `None` before one
    /// has, after one failed, and from a worker or database that cannot say.
    leases: Option<Vec<LeaseEntry>>,
    /// A *Take over* waiting for the beat that carries it (workspace-relative).
    take_over: Option<String>,
    /// The request count, the allowances, the bulk lane (pace.rs).
    pacer: Mutex<Pacer>,
    /// Workspace-relative paths the app wrote since they last went up: a
    /// person's own edits, which go before any bulk work.
    touched: HashSet<String>,
    /// A window of this workspace has focus.
    focused: bool,
    /// When this device was last used here: an edit, a document opened, a
    /// window focused. What the poll's cadence follows.
    active_at: Instant,
    /// The retry clock: failures in a row, and when the next try may go.
    failures: u32,
    retry_at: Option<Instant>,
    limited: Option<Limited>,
    adds: Adds,
    /// When the last pass ran, for slow mode's one a minute.
    last_pass_at: Option<Instant>,
}

impl<R: Remote> Engine<R> {
    pub fn new(cfg: EngineConfig, remote: Arc<R>, events: Arc<dyn Events>, statuses: StatusTable) -> Self {
        let mut units = BTreeMap::new();
        let shared = UnitConfig {
            id: SHARED.to_string(),
            name: cfg.name.clone(),
            root: cfg.root.clone(),
            prefix: String::new(),
            state_dir: cfg.state_dir.clone(),
            data_dir: cfg.data_dir.clone(),
            device_id: cfg.device_id.clone(),
        };
        units.insert(SHARED.to_string(), Unit::new(shared, remote.clone()));
        // The folders that say they are spaces are the record of which spaces
        // this Mac holds: each one syncs from where it left off. Whether this
        // person is still in each is the first poll's to say.
        for held in space::held(&cfg.root, &cfg.ws_id) {
            let marker = held.marker;
            units
                .entry(marker.space.clone())
                .or_insert_with(|| Self::space_unit(&cfg, &remote, &marker, held.dir, held.rel));
        }
        let pacer = Mutex::new(Pacer::new(remote.usage().clone()));
        Engine {
            cfg,
            remote,
            events,
            statuses,
            units,
            spaces: None,
            private_refusals: 0,
            unclaimable: HashSet::new(),
            phase: Phase::Idle,
            error: None,
            last_sync_ms: None,
            paused: false,
            outdated: None,
            worker_version: None,
            me: None,
            can: Vec::new(),
            removed: false,
            superadmin: None,
            people: BTreeMap::new(),
            owners: BTreeMap::new(),
            people_at: None,
            last_hourly: None,
            activity: None,
            last_beat: None,
            beaconed: None,
            presence: Vec::new(),
            leases: None,
            take_over: None,
            pacer,
            touched: HashSet::new(),
            focused: true,
            active_at: Instant::now(),
            failures: 0,
            retry_at: None,
            limited: None,
            adds: Adds::default(),
            last_pass_at: None,
        }
    }

    fn space_state_dir(cfg: &EngineConfig, id: &str) -> PathBuf {
        cfg.state_dir.join("spaces").join(id)
    }

    fn space_unit(cfg: &EngineConfig, remote: &Arc<R>, marker: &SpaceMarker, dir: PathBuf, rel: String) -> Unit<R> {
        Unit::new(
            UnitConfig {
                id: marker.space.clone(),
                name: marker.name.clone(),
                root: dir,
                prefix: rel,
                state_dir: Self::space_state_dir(cfg, &marker.space),
                data_dir: cfg.data_dir.clone(),
                device_id: cfg.device_id.clone(),
            },
            Arc::new(remote.space(&marker.space)),
        )
    }

    fn root_key(&self) -> String {
        self.cfg.root.to_string_lossy().to_string()
    }

    /// Whether a pass may run: not paused, not waiting on a worker update,
    /// and the domain has said who this device is.
    fn can_cycle(&self) -> bool {
        !self.paused && self.answered()
    }

    /// The domain answers this engine: its worker is not one this app
    /// waits to see updated, and it has said who this device is.
    fn answered(&self) -> bool {
        self.outdated.is_none() && self.me.is_some()
    }

    /// The shared workspace's unit.
    pub(crate) fn shared(&self) -> &Unit<R> {
        &self.units[SHARED]
    }

    #[cfg(test)]
    pub(crate) fn shared_mut(&mut self) -> &mut Unit<R> {
        self.units.get_mut(SHARED).expect("the shared unit")
    }

    /// Which unit a workspace-relative path is in, and the path as that unit
    /// spells it. None for a path that is no section's: `Restricted` itself,
    /// a file directly under it, a folder there that is not a space yet.
    fn place(&self, ws_rel: &str) -> Option<(String, String)> {
        self.units
            .values()
            .filter(|unit| !unit.is_shared())
            .find_map(|unit| unit.in_unit(ws_rel).map(|rel| (unit.id.clone(), rel)))
            .or_else(|| self.shared().in_unit(ws_rel).map(|rel| (SHARED.to_string(), rel)))
    }

    /* ----- links ----- */

    /// What a link to the file at `ws_rel` names, and who can open it. None
    /// for a path in no section, and for a file with no id yet.
    pub(crate) fn linked(&self, ws_rel: &str) -> Option<Linked> {
        let (id, rel) = self.place(ws_rel)?;
        let unit = self.units.get(&id)?;
        let file = unit.file_id_at(&rel)?;
        let who = if id == SHARED {
            format!("Everyone in {} can open it.", self.cfg.name)
        } else if id.starts_with("p-") {
            "Only you can open it, on any device of yours.".to_string()
        } else {
            format!("Only the people in “{}” can open it.", unit.name)
        };
        Some(Linked { space: (id != SHARED).then_some(id), file, who })
    }

    /// Where the file a link names is here, workspace-relative: only one
    /// this device holds and has on disk. A section this person is not in
    /// is no unit here, so a link into it finds nothing — the same as one to
    /// a page that was deleted, and as one to a page that never was.
    pub(crate) fn follow(&self, space: Option<&str>, file: &str) -> Option<String> {
        let unit = self.units.get(space.unwrap_or(SHARED))?;
        let synced = unit.state.files.get(file)?;
        unit.root.join(&synced.path).is_file().then(|| unit.ws_rel(&synced.path))
    }

    /// `cloud_recent`: every section's documents by when their content last
    /// changed, newest first, at most `limit` — with the directory their
    /// `by`s are read with.
    pub(crate) fn recent(&self, limit: usize) -> RecentFiles {
        let me = self.me.as_deref().unwrap_or("");
        let mut files: Vec<_> = self.units.values().flat_map(|unit| unit.recent(me)).collect();
        files.sort_by(|a, b| b.mtime.cmp(&a.mtime).then_with(|| a.path.cmp(&b.path)));
        files.truncate(limit);
        let people = self
            .people
            .iter()
            .map(|(id, name)| DirectoryPerson { id: id.clone(), name: name.clone(), person: self.owners.get(id).cloned() })
            .collect();
        RecentFiles { files, people, me: self.me.clone() }
    }

    /* ----- status ----- */

    fn public_pages(&self) -> Vec<PublicPage> {
        let mut pages: Vec<PublicPage> = self.units.values().flat_map(|unit| unit.public_pages(&self.people)).collect();
        // Folders above files, then by path — the Published list's order.
        pages.sort_by(|a, b| {
            let rank = |p: &PublicPage| if p.kind == PublicKind::Dir { 0 } else { 1 };
            rank(a).cmp(&rank(b)).then_with(|| a.path.cmp(&b.path)).then_with(|| a.slug.cmp(&b.slug))
        });
        pages
    }

    /// The spaces that have a folder on this Mac, as the status lists them.
    /// A folder says it is one before the domain has said anything this run
    /// — a Mac that started offline — and is listed by what the folder says:
    /// where it is, what it is called, and nobody in it that can be named.
    fn space_statuses(&self) -> Vec<SpaceStatus> {
        self.units
            .values()
            .filter(|unit| !unit.is_shared())
            .map(|unit| {
                let listed = self.spaces.iter().flatten().find(|s| s.id == unit.id);
                let at_top = unit.root.parent() == Some(self.cfg.root.as_path());
                SpaceStatus {
                    id: unit.id.clone(),
                    kind: listed.map(|s| s.kind).unwrap_or(if at_top { SpaceKind::Private } else { SpaceKind::Restricted }),
                    name: listed.map(|s| s.name.clone()).unwrap_or_else(|| unit.name.clone()),
                    path: unit.prefix.clone(),
                    by: listed.map(|s| self.name_of(&s.by)).unwrap_or_default(),
                    members: listed.map(|s| s.members.clone()).unwrap_or_default(),
                }
            })
            .collect()
    }

    fn set_status(&mut self, phase: Phase, error: Option<String>) {
        self.phase = phase;
        self.error = error;
        self.refresh_status();
    }

    /// Re-emit the current phase (presence moved, an op was queued).
    fn refresh_status(&self) {
        let mirror = self.shared().mirror;
        let status = CloudStatus {
            root: self.root_key(),
            domain: self.cfg.domain.clone(),
            endpoint: self.cfg.endpoint.clone(),
            ws_id: self.cfg.ws_id.clone(),
            name: self.cfg.name.clone(),
            phase: self.phase,
            last_sync_ms: self.last_sync_ms,
            error: self.error.clone(),
            pending_deletes: self.units.values().map(|u| u.held_deletes.len() as u32).sum(),
            pending_adds: if self.adds.confirmed { 0 } else { self.adds.held },
            usage: self.usage_status(),
            me: self.me.as_deref().map(|id| self.name_of(id)).unwrap_or_default(),
            me_id: self.me.clone(),
            can: self.can.clone(),
            superadmin: self.superadmin.clone(),
            worker_version: self.worker_version,
            versions: VersionsMirror {
                mirrored: mirror.map(|m| m.mirrored).unwrap_or(0),
                cloud: mirror.map(|m| m.cloud).unwrap_or(0),
                last_mirror_ms: self.shared().last_mirror_ms,
                horizon_days: mirror.and_then(|m| m.horizon_days),
            },
            public: self.public_pages(),
            presence: self.presence.clone(),
            leases: self.lease_holders(),
            spaces: self.space_statuses(),
        };
        if let Ok(mut table) = self.statuses.lock() {
            table.insert(self.root_key(), status);
        }
        emit_statuses(self.events.as_ref(), &self.statuses);
    }

    /// `CloudStatus.usage`.
    fn usage_status(&self) -> UsageStatus {
        let pacer = lock(&self.pacer);
        let (mode, cause) = pacer.mode();
        let limits = pacer.limits();
        let resumes_at = match &self.limited {
            Some(limited) => Some(limited.until_ms),
            None => (mode != Mode::Normal).then(next_midnight_ms),
        };
        UsageStatus {
            mode,
            cause,
            today: pacer.usage.today(),
            fleet_today: pacer.fleet_today(),
            cap: limits.and_then(|l| l.cap),
            plan: limits.map(|l| l.plan),
            resumes_at,
            waiting: self.units.values().map(|u| u.waiting).sum(),
            liftable: pacer.liftable(),
            lifted: pacer.lifted(),
        }
    }

    /// The phase a pass that went through leaves: what still waits on the
    /// person, else idle.
    fn settled_phase(&self) -> Phase {
        if self.units.values().any(|u| !u.held_deletes.is_empty()) {
            Phase::PendingDeletes
        } else if self.adds.asking() {
            Phase::PendingAdds
        } else {
            Phase::Idle
        }
    }

    fn slow(&self) -> bool {
        lock(&self.pacer).mode().0 == Mode::Slow
    }

    /* ----- who the domain says this Mac is ----- */

    /// `/api/meta`: learn the worker's version — and, after a `426`, whether
    /// the worker has been updated since.
    pub(crate) async fn probe_worker(&mut self) {
        let _ = self.probe().await;
    }

    /// The same, answering how it went — what the retry clock reads.
    async fn probe(&mut self) -> RemoteResult<()> {
        match self.remote.meta().await {
            Ok(meta) => {
                self.worker_version = Some(meta.version);
                // Identity rides on the probe because the probe is what happens
                // before this engine writes anything: `me` is what a manifest it
                // publishes signs with, `can` is what this Mac's role may do,
                // and `people` is what the `by` in a manifest it reads is shown
                // as.
                if let Some(you) = meta.you {
                    self.me = Some(you.member_id);
                    self.can = you.can;
                }
                self.superadmin = meta.superadmin.map(|p| p.name);
                self.owners = meta.people.iter().filter_map(|p| Some((p.id.clone(), p.person.clone()?))).collect();
                self.people = meta.people.into_iter().map(|p| (p.id, p.name)).collect();
                self.people_at = Some(Instant::now());
                if let Some(seen_at) = self.outdated {
                    if meta.version > seen_at {
                        self.outdated = None;
                    }
                }
                match meta.limits {
                    Some(limits) => lock(&self.pacer).set_limits(limits),
                    // A worker from before the request limits: everything this
                    // engine sends assumes them, so it waits for the update.
                    None if self.outdated.is_none() => {
                        self.outdated = Some(meta.version);
                        self.set_status(
                            Phase::WorkerOutdated,
                            Some(format!("this {}'s changes are waiting on a worker update", self.cfg.device_kind)),
                        );
                    }
                    None => {}
                }
                Ok(())
            }
            Err(RemoteError::Removed) => {
                self.heard_removed();
                Err(RemoteError::Removed)
            }
            // Until the domain has answered once, the probe is the only
            // request this engine makes, so its failure is the status — and
            // so is the account's daily limit, whenever it is heard.
            Err(e) => {
                if self.me.is_none() || matches!(e, RemoteError::DailyLimit) {
                    self.heard_failure(&e);
                }
                Err(e)
            }
        }
    }

    /// The domain said this Mac's access was removed: the task ends and the
    /// copy leaves this Mac. Every device obeys it alike — none is special.
    fn heard_removed(&mut self) {
        self.removed = true;
    }

    /// Whether the domain has said this Mac's access was taken away.
    #[cfg(test)]
    pub(crate) fn was_removed(&self) -> bool {
        self.removed
    }

    /// A `by` in words: a person's or an agent's id, resolved through the
    /// directory. An id nobody can name (a person since removed) stays an id
    /// rather than becoming "someone".
    pub(crate) fn name_of(&self, by: &str) -> String {
        self.people.get(by).cloned().unwrap_or_else(|| by.to_string())
    }

    /// Ask for the directory again when a manifest names somebody this
    /// engine cannot: a person invited, or an agent added, since it last
    /// probed. Rate-limited by
    /// `DIRECTORY_MIN_GAP`, because an id belonging to somebody since removed
    /// never resolves, and must not cost a request every cycle for ever.
    async fn learn_people(&mut self, m: &Manifest) {
        let stranger = m
            .files
            .values()
            .map(|f| f.by.as_str())
            .chain(m.tombstones.values().map(|t| t.by.as_str()))
            .chain(m.public.values().map(|e| e.by.as_str()))
            .any(|by| !self.people.contains_key(by));
        if !stranger || self.people_at.map(|at| at.elapsed() < DIRECTORY_MIN_GAP).unwrap_or(false) {
            return;
        }
        self.probe_worker().await;
    }

    /* ----- the pass ----- */

    /// Every unit, cycled: what first contact and *Sync now* run.
    pub async fn cycle(&mut self) -> RemoteResult<()> {
        self.pass(Which::All).await
    }

    /// One pass over the workspace: the units with something to say each run
    /// a cycle, in an order that writes a moved file's new section before it
    /// leaves the old one, and the workspace's one status says how it went.
    pub(crate) async fn pass(&mut self, which: Which) -> RemoteResult<()> {
        if !self.answered() {
            return Ok(()); // waiting for the worker update, or to be told who this device is
        }
        if !self.cfg.root.is_dir() {
            // Root missing (unmounted disk, renamed folder…): touch nothing.
            self.set_status(Phase::Error, Some("workspace folder is missing — sync is paused".into()));
            return Ok(());
        }
        // A folder dropped under `Restricted/` becomes a space before the
        // shared workspace reads its files as gone, so that they leave it as
        // a move. And a space whose folder was deleted here is made whole
        // again before its unit could read every file in it as deleted.
        let lost = self.units.values().any(|u| !u.is_shared() && !u.root.is_dir());
        if lost || !space::unclaimed(&self.cfg.root, &self.cfg.ws_id).is_empty() {
            self.reconcile_spaces().await;
        }

        // What each folder looks like, with no request made: which units
        // have something to push, and which files changed section. A unit
        // with no folder has nothing to say until it has one again.
        let surveys: BTreeMap<String, Survey> = self
            .units
            .values()
            .filter(|u| !u.gone && u.root.is_dir())
            .map(|u| (u.id.clone(), u.survey()))
            .collect();
        let moves = pair_moves(&surveys);
        self.carry_pages(&moves);
        let hold_new = self.weigh_new(&surveys, &moves);
        let bulk_open = lock(&self.pacer).bulk_open();
        self.last_pass_at = Some(Instant::now());

        // A pass after one that failed goes everywhere again: the phase it
        // left behind is only cleared by a pass that succeeds.
        let recovering = !matches!(
            self.phase,
            Phase::Idle | Phase::Syncing | Phase::PendingDeletes | Phase::PendingAdds | Phase::Paused
        );
        let wanted = |id: &str| match &which {
            Which::All => true,
            Which::Dirty => recovering,
            Which::Moved(ids) => recovering || ids.contains(id),
        };
        let chosen: Vec<String> = surveys
            .iter()
            .filter(|(id, survey)| {
                wanted(id) || survey.dirty || self.units.get(*id).is_some_and(|u| u.poke || (u.owes && bulk_open))
            })
            .map(|(id, _)| id.clone())
            .collect();
        if chosen.is_empty() {
            return Ok(());
        }
        // Where files are arriving goes first.
        let arriving: HashSet<&str> = moves.iter().map(|m| m.to.as_str()).collect();
        let mut order = chosen;
        order.sort_by_key(|id| !arriving.contains(id.as_str()));

        self.set_status(Phase::Syncing, None);
        // With more than one unit in the pass, where the domain is gets read
        // for all of them before any is applied: a file that moved between
        // two sections is then found in the one it went to (`relocate`).
        if order.len() > 1 {
            for id in &order {
                if let Some(unit) = self.units.get_mut(id) {
                    let _ = unit.fetch().await; // a failure is the cycle's to report
                }
            }
        }
        let mut changed: Vec<String> = Vec::new();
        let mut failure: Option<RemoteError> = None;
        // A second round is for what the first one set off: a page whose
        // address another section has just let go of, a file another
        // section's relocation put here.
        for round in 0..2 {
            let ids: Vec<String> = if round == 0 {
                order.clone()
            } else {
                self.units.values().filter(|u| u.poke && !u.gone && u.root.is_dir()).map(|u| u.id.clone()).collect()
            };
            for id in ids {
                match self.cycle_unit(&id, &moves, hold_new).await {
                    Ok(paths) => changed.extend(paths),
                    // A space that answers "not found" is one this person is
                    // not in any more, or one that is gone. Which, the next
                    // poll says; until then it is left exactly as it is.
                    Err(RemoteError::NotFound) if id != SHARED => {
                        if let Some(unit) = self.units.get_mut(&id) {
                            unit.gone = true;
                        }
                    }
                    Err(e) => {
                        let whole = matches!(
                            e,
                            RemoteError::Offline(_)
                                | RemoteError::Unauthorized
                                | RemoteError::Removed
                                | RemoteError::Outdated(_)
                        );
                        if failure.is_none() {
                            failure = Some(e);
                        }
                        if whole {
                            break; // the domain, not this section: nothing else will fare better
                        }
                    }
                }
            }
            if failure.is_some() {
                break;
            }
        }

        // What a unit read and did not get to apply is stale by the next pass.
        for unit in self.units.values_mut() {
            unit.incoming = None;
        }
        if !changed.is_empty() {
            changed.sort();
            changed.dedup();
            self.events.emit_json(EV_APPLIED, json!({ "root": self.root_key(), "paths": changed }));
        }
        match &failure {
            None => {
                self.last_sync_ms = Some(now_ms());
                // What the app wrote has gone — the express lane never waits.
                self.touched.clear();
                self.set_status(self.settled_phase(), None);
                if !changed.is_empty() {
                    // Something arrived from another device, so the versioner
                    // has (or is about to have) new snapshots worth sending.
                    self.mirror_versions().await;
                }
            }
            Some(e) => self.heard_failure(e),
        }
        self.remote.usage().save();
        match failure {
            None | Some(RemoteError::Conflict) | Some(RemoteError::Outdated(_)) => Ok(()),
            Some(e) => Err(e),
        }
    }

    /// What a request that failed says about this workspace, in the status.
    fn heard_failure(&mut self, e: &RemoteError) {
        match e {
            RemoteError::Offline(m) => self.set_status(Phase::Offline, Some(m.clone())),
            RemoteError::Unauthorized => self.set_status(
                Phase::Revoked,
                Some(format!("the domain no longer accepts this {}'s token", self.cfg.device_kind)),
            ),
            // It has no status of its own: the task loop ends the engine, and
            // the workspace leaves this Mac — row and all — a moment later.
            RemoteError::Removed => self.heard_removed(),
            RemoteError::Outdated(m) => {
                self.outdated = Some(self.worker_version.unwrap_or(0));
                self.set_status(
                    Phase::WorkerOutdated,
                    Some(format!("this {}'s changes are waiting on a worker update ({})", self.cfg.device_kind, m)),
                );
            }
            RemoteError::NotFound => self.set_status(
                Phase::Error,
                Some(format!("{} no longer holds this workspace", self.cfg.domain)),
            ),
            RemoteError::DailyLimit => self.enter_limited(),
            // Heard from the domain, which is all it wants this Mac to know:
            // the retry clock does the slowing down.
            RemoteError::Slowed(_) => self.set_status(
                self.settled_phase(),
                Some(format!("The domain asked this {} to slow down.", self.cfg.device_kind)),
            ),
            e => self.set_status(Phase::Error, Some(e.to_string())),
        }
    }

    /// The account's daily requests are used up: nothing goes until the
    /// reset — spread, so every device does not come back in its first
    /// second — but a probe every half hour, which a plan upgrade answers.
    fn enter_limited(&mut self) {
        if self.limited.is_none() {
            let until_ms = next_midnight_ms() + jitter_ms(LIMITED_SPREAD_MS);
            self.limited = Some(Limited { until_ms, next_try: Instant::now() + LIMITED_PROBE });
        }
        let until = self.limited.as_ref().map(|l| l.until_ms).unwrap_or_else(next_midnight_ms);
        self.set_status(
            Phase::Limited,
            Some(format!("Today's Cloudflare requests are used up. Sync resumes at {}.", local_time(until))),
        );
    }

    /// The retry clock, after a pass or a poll: a success starts it again;
    /// a failure pushes the next try out along the ladder — or as far as the
    /// domain asked, when it asked.
    fn clock(&mut self, result: &RemoteResult<()>) {
        let wait = match result {
            Ok(()) | Err(RemoteError::Removed) | Err(RemoteError::DailyLimit) => {
                if result.is_ok() {
                    self.failures = 0;
                    self.retry_at = None;
                }
                return;
            }
            Err(e) => {
                self.failures += 1;
                let step = BACKOFF[(self.failures as usize - 1).min(BACKOFF.len() - 1)];
                let step = step.mul_f64(1.0 - BACKOFF_JITTER + 2.0 * BACKOFF_JITTER * unit_random());
                match e {
                    RemoteError::Slowed(secs) => step.max(Duration::from_secs(*secs)),
                    _ => step,
                }
            }
        };
        self.retry_at = Some(Instant::now() + wait);
    }

    /// The many-new-documents valve, read off the surveys: how many
    /// documents this pass would send for the first time — not the far side
    /// of a rename, nor a file moving between sections. At the plan's
    /// `manyNew` or more they wait for the person, who is asked once (the
    /// event) and answers with `cloud_confirm_adds`. True while they wait.
    fn weigh_new(&mut self, surveys: &BTreeMap<String, Survey>, moves: &[CrossMove]) -> bool {
        let threshold = lock(&self.pacer).limits().map(|l| l.many_new).unwrap_or(u64::MAX);
        let mut news: Vec<String> = Vec::new();
        for (id, survey) in surveys {
            let Some(unit) = self.units.get(id) else { continue };
            let renamed: HashSet<&str> = survey.vanished.iter().map(|(_, hash, _)| hash.as_str()).collect();
            for (path, hash) in &survey.news {
                let arriving = moves.iter().any(|m| &m.to == id && &m.path == path);
                if arriving || renamed.contains(hash.as_str()) || path.to_lowercase().ends_with(".meta.jsonl") {
                    continue;
                }
                news.push(unit.ws_rel(path));
            }
        }
        if (news.len() as u64) < threshold {
            self.adds = Adds::default();
            return false;
        }
        if self.adds.confirmed {
            return false;
        }
        let count = news.len() as u32;
        let was_asking = self.adds.asking() && self.adds.held == count;
        self.adds.held = count;
        self.adds.folders = folders_of(&news);
        if self.adds.asking() && !was_asking {
            let folders: Vec<serde_json::Value> =
                self.adds.folders.iter().map(|(path, n)| json!({ "path": path, "count": n })).collect();
            self.events.emit_json(EV_PENDING_ADDS, json!({ "root": self.root_key(), "count": count, "folders": folders }));
        }
        true
    }

    /// One unit's cycle. The unit is out of the map while it runs, so what
    /// the cycle is told about the rest of the workspace is read from the
    /// units that are in it. Answers the workspace-relative paths written.
    async fn cycle_unit(&mut self, id: &str, moves: &[CrossMove], hold_new: bool) -> RemoteResult<Vec<String>> {
        let Some(mut unit) = self.units.remove(id) else { return Ok(Vec::new()) };
        let result = self.cycle_taken(&mut unit, moves, hold_new).await;
        self.units.insert(id.to_string(), unit);
        result
    }

    async fn cycle_taken(
        &mut self,
        unit: &mut Unit<R>,
        moves: &[CrossMove],
        hold_new: bool,
    ) -> RemoteResult<Vec<String>> {
        // Nothing is written before the domain has said whom to sign it
        // with (`answered`, which the pass checks first).
        let Some(signature) = self.me.clone() else { return Ok(Vec::new()) };
        // Where the domain is — read before it is applied, for two things
        // only the engine can do: put a name to somebody new, and deal with
        // files that moved to another section.
        if unit.incoming.is_none() {
            unit.fetch().await?;
        }
        self.learn_people(unit.view()).await;
        let mut touched = self.relocate(unit);

        let releasing: HashSet<String> = self.units.values().flat_map(|other| removals(other)).collect();
        let mine: Vec<String> = removals(unit).collect();
        let moved_out: HashMap<String, MovedOut> = moves
            .iter()
            .filter(|m| m.from == unit.id)
            .map(|m| {
                let landed = self
                    .units
                    .get(&m.to)
                    .is_some_and(|to| to.state.files.values().any(|st| st.path == m.path && st.hash == m.hash));
                (m.fid.clone(), MovedOut { to: m.to.clone(), landed })
            })
            .collect();
        let ws_root = self.root_key();
        let own_edits: HashSet<String> =
            self.touched.iter().filter_map(|p| unit.in_unit(p)).filter(|rel| !rel.is_empty()).collect();
        let ctx = Ctx {
            signature: &signature,
            people: &self.people,
            events: self.events.as_ref(),
            ws_root: &ws_root,
            trash: self.cfg.trash.clone(),
            releasing: &releasing,
            moved_out: &moved_out,
            pacer: &self.pacer,
            touched: &own_edits,
            hold_new,
        };
        let written = unit.cycle_inner(&ctx).await?;
        touched.extend(written.iter().map(|p| unit.ws_rel(p)));
        // What the cycle met as moved away on a manifest it refetched.
        touched.extend(self.relocate(unit));

        // An address this unit just gave up is free: whoever was waiting for
        // it goes again.
        for slug in mine {
            if unit.state.public_ops.contains_key(&slug) {
                continue;
            }
            for other in self.units.values_mut() {
                if matches!(other.state.public_ops.get(&slug), Some(PublicOp::Put(_))) {
                    other.poke = true;
                }
            }
        }
        Ok(touched)
    }

    /// Files another Mac moved out of `unit` to another section: a tombstone
    /// that says where its file went (`Tombstone::to`). When this Mac is in
    /// that section the copy here moves there, so nothing is downloaded
    /// again and an edit not yet synced goes with its document. When it is
    /// not, the copy is deleted outright — the file was taken out of this
    /// person's reach, and a copy in the Trash would still be in it.
    /// Answers the workspace-relative paths touched.
    fn relocate(&mut self, unit: &mut Unit<R>) -> Vec<String> {
        let moved: Vec<(String, String, String)> = unit
            .view()
            .tombstones
            .iter()
            .filter_map(|(fid, tomb)| {
                let to = tomb.to.clone()?;
                let held = unit.state.files.get(fid)?;
                (tomb.rev >= held.rev).then(|| (fid.clone(), to, tomb.by.clone()))
            })
            .collect();
        let mut touched = Vec::new();
        for (fid, to, by) in moved {
            let Some(held) = unit.state.files.get(&fid).cloned() else { continue };
            let from = unit.root.join(&held.path);
            if let Some(bytes) = read_file_checked(&from) {
                let base = std::fs::read(unit.base_path(&fid)).ok();
                let who = self.name_of(&by);
                match self.units.get_mut(&to) {
                    None => {
                        let _ = std::fs::remove_file(&from);
                    }
                    Some(dest) => {
                        match receive(dest, &from, &bytes, &held.hash, base.as_deref(), &who) {
                            Received::Dropped => {}
                            Received::Placed(path) => touched.push(dest.ws_rel(&path)),
                            Received::Beside { path, copy } => {
                                touched.push(dest.ws_rel(&copy));
                                self.events.emit_json(
                                    EV_CONFLICT,
                                    json!({
                                        "root": self.cfg.root.to_string_lossy(),
                                        "path": dest.ws_rel(&path),
                                        "by": who,
                                        "conflictPath": dest.ws_rel(&copy),
                                    }),
                                );
                            }
                        }
                        dest.persist_state();
                    }
                }
                touched.push(unit.ws_rel(&held.path));
                if let Some(parent) = from.parent() {
                    space::prune_empty(parent, &unit.root);
                }
            }
            unit.forget(&fid);
        }
        if !touched.is_empty() {
            unit.persist_state();
        }
        touched
    }

    /// A published file that changed section on this Mac keeps its address:
    /// the section it left queues giving the address up, the one it went to
    /// queues asking for it — which waits for the first (`Ctx::releasing`).
    /// A published folder whose every file went the same way does the same.
    fn carry_pages(&mut self, moves: &[CrossMove]) {
        let mut carried: Vec<(String, String, String, PendingPublic)> = Vec::new(); // (from, to, slug, page)
        for (from, unit) in &self.units {
            let out: HashMap<&str, (&str, &str)> = moves
                .iter()
                .filter(|m| &m.from == from)
                .map(|m| (m.fid.as_str(), (m.to.as_str(), m.path.as_str())))
                .collect();
            if out.is_empty() {
                continue;
            }
            for (slug, entry) in unit.effective_public() {
                let went: Option<(String, String)> = match entry.kind {
                    PublicKind::File => entry
                        .file
                        .as_deref()
                        .and_then(|fid| out.get(fid))
                        .map(|(to, path)| (to.to_string(), path.to_string())),
                    PublicKind::Dir if entry.path.is_empty() => None,
                    PublicKind::Dir => folder_went(&entry.path, &unit.state.manifest, &out),
                };
                let Some((to, path)) = went else { continue };
                let page = PendingPublic {
                    kind: entry.kind,
                    file: None,
                    path,
                    title: entry.title.clone(),
                    desc: entry.desc.clone(),
                    custom: true,
                    by: entry.by.clone(),
                    at: entry.at,
                };
                carried.push((from.clone(), to, slug, page));
            }
        }
        for (from, to, slug, page) in carried {
            if !self.units.contains_key(&to) {
                continue;
            }
            if let Some(unit) = self.units.get_mut(&from) {
                unit.state.public_ops.insert(slug.clone(), PublicOp::Remove);
                if unit.state.root_op.as_ref().and_then(|r| r.as_deref()) == Some(slug.as_str()) {
                    unit.state.root_op = None;
                }
                unit.poke = true;
                unit.persist_state();
            }
            if let Some(unit) = self.units.get_mut(&to) {
                unit.state.public_ops.insert(slug, PublicOp::Put(page));
                unit.poke = true;
                unit.persist_state();
            }
        }
    }

    /* ----- spaces coming and going ----- */

    /// Bring this Mac's folders in line with the spaces this person is in:
    /// the last poll's list on one side, the folders that say they are
    /// spaces on the other.
    ///
    /// A space with no folder here gets one, and its unit downloads it. A
    /// restricted folder this person is no longer in is deleted from this
    /// Mac outright, with its sync state and its local history; nothing in
    /// the cloud is touched. A folder made under `Restricted/` by hand
    /// becomes a restricted folder with only this person in it, and one
    /// renamed here is renamed for everyone in it.
    pub(crate) async fn reconcile_spaces(&mut self) {
        let Some(mut list) = self.spaces.clone() else { return };
        let root = self.cfg.root.clone();
        if !root.is_dir() {
            return;
        }
        let ws_id = self.cfg.ws_id.clone();
        let mut changed: Option<SpacesChanged> = None;

        // Everyone has a Private.
        if !list.iter().any(|s| s.kind == SpaceKind::Private) && self.private_refusals < 3 {
            match self.remote.ensure_private().await {
                Ok(mine) => list.push(mine),
                Err(RemoteError::Offline(_)) => {}
                Err(RemoteError::Removed) => {
                    self.heard_removed();
                    return;
                }
                Err(_) => self.private_refusals += 1,
            }
        }

        // A folder made under `Restricted/` that is no space yet.
        for dir in space::unclaimed(&root, &ws_id) {
            let name = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            if !space::valid_folder_name(&name) || self.unclaimable.contains(&dir) {
                continue;
            }
            match self.remote.create_space(&name, &[]).await {
                Ok(made) => {
                    let marker = SpaceMarker { ws_id: ws_id.clone(), space: made.id.clone(), name: made.name.clone() };
                    if space::write_space_marker(&dir, &marker).is_ok() {
                        let _ = std::fs::remove_dir_all(Self::space_state_dir(&self.cfg, &made.id));
                        list.push(made);
                    }
                }
                Err(RemoteError::Offline(_)) => break,
                Err(_) => {
                    self.unclaimable.insert(dir);
                }
            }
        }

        let listed: HashSet<String> = list.iter().map(|s| s.id.clone()).collect();
        let mut held = space::held(&root, &ws_id);

        // Folders of spaces this person is no longer in. A Private is its
        // person's for as long as they are in the workspace, so a list
        // without it is a list to mend (above), never a folder to delete.
        let mut left: Vec<(String, String)> = Vec::new();
        held.retain(|folder| {
            if listed.contains(&folder.marker.space) || folder.dir.parent() == Some(root.as_path()) {
                return true;
            }
            let store = crate::versions::store_for_root(&self.cfg.data_dir, &folder.dir).dir;
            self.units.remove(&folder.marker.space);
            if space::remove_space_dir(&root, folder) {
                let _ = std::fs::remove_dir_all(Self::space_state_dir(&self.cfg, &folder.marker.space));
                changed
                    .get_or_insert_with(SpacesChanged::default)
                    .removed
                    .push((folder.dir.to_string_lossy().to_string(), store));
                left.push((folder.marker.name.clone(), folder.rel.clone()));
            }
            false
        });
        for (name, path) in left {
            self.events.emit_json(EV_SPACE_LEFT, json!({ "root": self.root_key(), "name": name, "path": path }));
        }
        // A unit whose folder is gone from this Mac: forget what it had
        // synced, so the folder comes back whole rather than as deletions.
        let present: HashSet<String> = held.iter().map(|folder| folder.marker.space.clone()).collect();
        let orphaned: Vec<String> =
            self.units.keys().filter(|id| id.as_str() != SHARED && !present.contains(*id)).cloned().collect();
        for id in orphaned {
            self.units.remove(&id);
            let _ = std::fs::remove_dir_all(Self::space_state_dir(&self.cfg, &id));
            changed.get_or_insert_with(SpacesChanged::default);
        }

        for at in 0..list.len() {
            let entry = list[at].clone();
            let maker = self.people.get(&entry.by).cloned().unwrap_or_default();
            let found = held.iter().find(|folder| folder.marker.space == entry.id).cloned();
            let mut marker = SpaceMarker { ws_id: ws_id.clone(), space: entry.id.clone(), name: entry.name.clone() };
            let (dir, rel) = match (entry.kind, found) {
                (SpaceKind::Private, Some(folder)) => (folder.dir, folder.rel),
                (SpaceKind::Private, None) => {
                    // Whatever is at `Private/` already is this person's own:
                    // it was never shared, and it stays theirs.
                    let dir = space::top(&root, PRIVATE_DIR);
                    if std::fs::create_dir_all(&dir).is_err() || space::write_space_marker(&dir, &marker).is_err() {
                        continue;
                    }
                    let _ = std::fs::remove_dir_all(Self::space_state_dir(&self.cfg, &entry.id));
                    let rel = space::spelled(&root, &dir);
                    (dir, rel)
                }
                (SpaceKind::Restricted, Some(folder)) => {
                    let actual = folder.dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                    let mut dir = folder.dir.clone();
                    if entry.name != folder.marker.name {
                        // Renamed by somebody in it: the folder follows.
                        if !space::names_space(&actual, &entry.name, &maker) {
                            let to = space::free_restricted_dir(&root, &entry.name, &maker);
                            if std::fs::rename(&dir, &to).is_ok() {
                                dir = to;
                            }
                        }
                        let _ = space::write_space_marker(&dir, &marker);
                    } else if !space::names_space(&actual, &entry.name, &maker) && space::valid_folder_name(&actual) {
                        // Renamed here: that is the folder's new name, for
                        // everyone in it.
                        if self.remote.rename_space(&entry.id, &actual).await.is_ok() {
                            list[at].name = actual.clone();
                            marker.name = actual;
                            let _ = space::write_space_marker(&dir, &marker);
                        }
                    }
                    let rel = space::spelled(&root, &dir);
                    (dir, rel)
                }
                (SpaceKind::Restricted, None) => {
                    let dir = space::free_restricted_dir(&root, &entry.name, &maker);
                    if std::fs::create_dir_all(&dir).is_err() || space::write_space_marker(&dir, &marker).is_err() {
                        continue;
                    }
                    let _ = std::fs::remove_dir_all(Self::space_state_dir(&self.cfg, &entry.id));
                    let rel = space::spelled(&root, &dir);
                    (dir, rel)
                }
            };
            match self.units.get_mut(&entry.id) {
                Some(unit) => {
                    if unit.root != dir {
                        changed.get_or_insert_with(SpacesChanged::default);
                    }
                    unit.root = dir;
                    unit.prefix = rel;
                    unit.name = list[at].name.clone();
                    unit.gone = false;
                }
                None => {
                    self.units.insert(entry.id.clone(), Self::space_unit(&self.cfg, &self.remote, &marker, dir, rel));
                    changed.get_or_insert_with(SpacesChanged::default);
                }
            }
        }

        self.spaces = Some(list);
        if let Some(changed) = changed {
            if let Some(tell) = &self.cfg.on_spaces {
                tell(changed);
            }
            self.refresh_status();
        }
    }

    /* ----- restricted folders, by hand ----- */

    /// A failed call about a restricted folder, in a sentence.
    fn describe_space(&self, e: RemoteError) -> String {
        match e {
            RemoteError::NotFound => "That folder is not there any more, or you are no longer in it.".to_string(),
            other => super::flows::describe(&self.cfg.domain, other.into()),
        }
    }

    /// Why a command that needs the domain's word cannot run yet.
    fn not_caught_up(&self) -> String {
        format!("This {} has not caught up with the workspace yet — try again in a moment.", self.cfg.device_kind)
    }

    /// Make a restricted folder holding this person and `members`. With
    /// `from` — a folder in this workspace — that folder becomes it: what was
    /// in it leaves the section it was in as a move, so it is deleted
    /// outright from the Macs of everyone not chosen and stays in place on
    /// the Macs of everyone who is. Otherwise the folder starts empty.
    pub(crate) async fn make_space(
        &mut self,
        name: &str,
        members: &[String],
        from: Option<&Path>,
    ) -> Result<SpaceStatus, String> {
        // The list of this person's spaces is what decides which folders
        // stay here: a folder is only added to one the domain gave.
        if self.spaces.is_none() {
            return Err(self.not_caught_up());
        }
        let name = name.trim();
        if !space::valid_folder_name(name) {
            return Err("A folder needs a name that can be a folder's: no slashes, and not starting with a dot.".to_string());
        }
        let root = self.cfg.root.clone();
        if let Some(from) = from {
            let inside = from.starts_with(&root) && from != root.as_path();
            let real = std::fs::symlink_metadata(from).map(|m| m.file_type().is_dir()).unwrap_or(false);
            let reserved = from.parent() == Some(root.as_path())
                && from.file_name().is_some_and(|n| space::reserved_top(&n.to_string_lossy()).is_some());
            if !inside || !real || reserved {
                return Err("That is not a folder of this workspace that can be restricted.".to_string());
            }
            if self.units.values().any(|unit| !unit.is_shared() && unit.root == from) {
                return Err("That folder is restricted already.".to_string());
            }
        }

        let made = self.remote.create_space(name, members).await.map_err(|e| self.describe_space(e))?;
        let maker = self.people.get(&made.by).cloned().unwrap_or_default();
        let dir = space::free_restricted_dir(&root, &made.name, &maker);
        let marker = SpaceMarker { ws_id: self.cfg.ws_id.clone(), space: made.id.clone(), name: made.name.clone() };
        let placed = dir
            .parent()
            .map(std::fs::create_dir_all)
            .unwrap_or(Ok(()))
            .and_then(|_| match from {
                Some(from) => std::fs::rename(from, &dir),
                None => std::fs::create_dir_all(&dir),
            })
            .map_err(|e| e.to_string())
            .and_then(|_| space::write_space_marker(&dir, &marker));
        if let Err(e) = placed {
            // The domain has the folder; the next poll gives it a folder
            // here. What was to go into it is where it was.
            return Err(format!("The folder was made, but this {} could not put it in place: {}.", self.cfg.device_kind, e));
        }
        let _ = std::fs::remove_dir_all(Self::space_state_dir(&self.cfg, &made.id));
        let rel = space::spelled(&root, &dir);
        self.units.insert(made.id.clone(), Self::space_unit(&self.cfg, &self.remote, &marker, dir, rel));
        let id = made.id.clone();
        self.spaces.get_or_insert_with(Vec::new).push(made);
        if let Some(tell) = &self.cfg.on_spaces {
            tell(SpacesChanged::default());
        }
        self.refresh_status();
        self.space_statuses()
            .into_iter()
            .find(|space| space.id == id)
            .ok_or_else(|| "The folder was made, and will be here in a moment.".to_string())
    }

    /// Add a person to a restricted folder, or take one out. Taking this
    /// person out is leaving it: its folder leaves this Mac with them.
    pub(crate) async fn change_space_member(&mut self, id: &str, member: &str, add: bool) -> Result<(), String> {
        if add {
            let now = self.remote.add_space_member(id, member).await.map_err(|e| match e {
                RemoteError::NotFound => {
                    "That person is not in this workspace any more, or the folder is gone.".to_string()
                }
                other => self.describe_space(other),
            })?;
            if let Some(entry) = self.spaces.iter_mut().flatten().find(|s| s.id == id) {
                *entry = now;
            }
        } else {
            self.remote.remove_space_member(id, member).await.map_err(|e| self.describe_space(e))?;
            if self.me.as_deref() == Some(member) {
                self.forget_space(id).await;
            } else if let Some(entry) = self.spaces.iter_mut().flatten().find(|s| s.id == id) {
                entry.members.retain(|m| m != member);
            }
        }
        self.refresh_status();
        Ok(())
    }

    /// Delete a restricted folder for everyone in it: everything it stored
    /// on the domain, then its folder here. Each other Mac deletes its copy
    /// when its next poll no longer lists the folder.
    pub(crate) async fn delete_space(&mut self, id: &str) -> Result<(), String> {
        loop {
            let round = self.remote.delete_space(id).await.map_err(|e| self.describe_space(e))?;
            if !round.remaining {
                break;
            }
        }
        self.forget_space(id).await;
        self.refresh_status();
        Ok(())
    }

    /// This person is out of a space, by something done on this Mac: the
    /// list says so now rather than at the next poll, and the folder goes.
    async fn forget_space(&mut self, id: &str) {
        if let Some(list) = &mut self.spaces {
            list.retain(|s| s.id != id);
        }
        self.reconcile_spaces().await;
    }

    /* ----- the version store's mirror ----- */

    /// Is the hourly pass due? A pass that brought something in mirrors at
    /// once; this is the floor under a workspace nothing is happening in.
    fn hourly_due(&self) -> bool {
        self.last_hourly.map(|t| t.elapsed() >= MIRROR_EVERY).unwrap_or(true)
    }

    /// Put this device's captured history in the bucket — every section's
    /// into its own store — and once a day thin what is up there.
    ///
    /// Bulk work: it waits while the bulk lane does, and sends no more than
    /// the lane gives (`MIRROR_BUDGET` at most) — what is left goes on the
    /// next pass that has room.
    pub(crate) async fn mirror_versions(&mut self) {
        if self.paused || self.outdated.is_some() || self.limited.is_some() {
            return;
        }
        let mut budget = lock(&self.pacer).take(MIRROR_BUDGET);
        if budget == 0 {
            return;
        }
        self.last_hourly = Some(Instant::now());
        let mut landed = false;
        for unit in self.units.values_mut().filter(|u| !u.gone) {
            landed |= unit.mirror_versions(&mut budget).await;
        }
        lock(&self.pacer).give_back(budget);
        if landed {
            self.refresh_status();
        }
    }

    /// How far back the bucket keeps, for the section `rel` is in.
    pub(crate) async fn set_cloud_horizon(&mut self, rel: &str, days: Option<u32>) -> Result<(), String> {
        let Some((id, _)) = self.place(rel) else { return Err("That folder isn't connected.".to_string()) };
        let Some(unit) = self.units.get_mut(&id) else { return Err("That folder isn't connected.".to_string()) };
        unit.set_cloud_horizon(days).await?;
        self.refresh_status();
        Ok(())
    }

    /* ----- the public map: queued ops ----- */

    /// Queue "publish this file or folder" in whichever section holds it.
    pub(crate) fn queue_publish(&mut self, req: PublishRequest) -> Result<String, String> {
        let ws_rel = req.rel.trim_matches('/').to_string();
        let Some((id, rel)) = self.place(&ws_rel) else {
            return Err(match req.kind {
                PublicKind::File => "that path can't be published".to_string(),
                PublicKind::Dir => "that folder can't be published".to_string(),
            });
        };
        let elsewhere: BTreeSet<String> = self
            .units
            .iter()
            .filter(|(other, _)| **other != id)
            .flat_map(|(_, unit)| unit.effective_public().into_keys())
            .collect();
        let Some(signature) = self.me.clone() else { return Err(self.not_caught_up()) };
        let Some(unit) = self.units.get_mut(&id) else { return Err("that path can't be published".to_string()) };
        let slug = unit.queue_publish(PublishRequest { rel, ..req }, &signature, &elsewhere)?;
        unit.poke = true;
        self.refresh_status();
        Ok(slug)
    }

    pub(crate) fn queue_unpublish(&mut self, slug: &str) -> Result<(), String> {
        let slug = slug.trim().to_lowercase();
        let holder = self.units.values_mut().find(|unit| unit.effective_public().contains_key(&slug));
        let Some(unit) = holder else { return Err("that page isn't published".into()) };
        unit.queue_unpublish(&slug)?;
        unit.poke = true;
        self.refresh_status();
        Ok(())
    }

    /// The page at `/` is chosen from the shared workspace.
    pub(crate) fn queue_set_root(&mut self, slug: Option<String>) -> Result<(), String> {
        let wanted = slug.as_deref().map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty());
        if let Some(wanted) = &wanted {
            let elsewhere = self
                .units
                .values()
                .any(|unit| !unit.is_shared() && unit.effective_public().contains_key(wanted));
            if elsewhere && !self.shared().effective_public().contains_key(wanted) {
                return Err("the home page is chosen from the shared workspace".into());
            }
        }
        let Some(shared) = self.units.get_mut(SHARED) else { return Err("that workspace isn't connected".into()) };
        shared.queue_set_root(slug)?;
        shared.poke = true;
        self.refresh_status();
        Ok(())
    }

    /* ----- activity + presence ----- */

    pub(crate) fn set_activity(&mut self, abs_path: Option<String>) {
        self.activity = abs_path.map(|p| (p, Instant::now()));
        self.active_at = Instant::now();
    }

    /// A window of this workspace gained focus, or none has it now. Gaining
    /// it is being used again: the poll goes back to its quickest.
    pub(crate) fn set_focus(&mut self, focused: bool) {
        self.focused = focused;
        if focused {
            self.active_at = Instant::now();
        }
    }

    /// How long until the next poll, by attention: quickest while a window
    /// of the workspace is focused and in use, a minute while it is in the
    /// background or idle, five once nobody has touched it for half an hour.
    /// Never quicker than a minute in slow mode.
    pub(crate) fn poll_gap(&self) -> Duration {
        let idle = self.active_at.elapsed();
        let gap = if idle >= AWAY_AFTER {
            POLL_AWAY
        } else if !self.focused || idle >= IDLE_AFTER {
            POLL_BACKGROUND
        } else {
            POLL_INTERVAL
        };
        if self.slow() {
            gap.max(POLL_BACKGROUND)
        } else {
            gap
        }
    }

    /// How long the beat sent now holds, in ms (`Beat::Here::ttl`).
    fn beat_ttl(&self) -> u64 {
        let gap = self.poll_gap().max(PRESENCE_BEAT).mul_f64(2.5);
        gap.clamp(BEAT_TTL_MIN, BEAT_TTL_MAX).as_millis() as u64
    }

    /// The app just wrote `rel`. When that is the document being edited, the
    /// editing is fresh again — typing is what keeps a document yours, not
    /// only having opened it.
    pub(crate) fn touch_activity(&mut self, rel: &str) {
        self.active_at = Instant::now();
        self.touched.insert(rel.to_string());
        let Some((abs, at)) = self.activity.as_mut() else { return };
        if rel_path(&self.cfg.root, Path::new(abs.as_str())).as_deref() == Some(rel) {
            *at = Instant::now();
        }
    }

    /// *Take over*: the document is the one being edited from this moment —
    /// asking for it is touching it — and the next beat claims it from
    /// whoever holds it. A path outside this workspace is not this engine's.
    pub(crate) fn take_over(&mut self, abs_path: String) {
        let Some(rel) = rel_path(&self.cfg.root, Path::new(&abs_path)).filter(|r| !r.is_empty()) else {
            return;
        };
        self.activity = Some((abs_path, Instant::now()));
        self.active_at = Instant::now();
        self.take_over = Some(rel);
    }

    pub(crate) fn confirm_deletes(&mut self) {
        for unit in self.units.values_mut() {
            unit.confirm_deletes();
        }
    }

    /// The person's answer to the many-new-documents question. *Sync them*
    /// also lifts this device's bulk wait for the day: one question, never
    /// two. *Not now* leaves them here until more arrive, or *Sync now*.
    pub(crate) fn confirm_adds(&mut self, sync: bool) {
        if sync {
            self.adds.confirmed = true;
            self.adds.declined = None;
            let mut pacer = lock(&self.pacer);
            if pacer.liftable() {
                pacer.lift();
            }
        } else {
            self.adds.declined = Some(self.adds.held);
        }
        if self.phase == Phase::PendingAdds && !self.adds.asking() {
            self.set_status(self.settled_phase(), None);
        } else {
            self.refresh_status();
        }
    }

    /// *Send them now*: this device's own bulk wait is lifted until 00:00
    /// UTC. Never the ceiling, and never everyone's.
    pub(crate) fn lift_wait(&mut self) {
        let mut pacer = lock(&self.pacer);
        if pacer.liftable() {
            pacer.lift();
        }
    }

    pub(crate) fn set_paused(&mut self, paused: bool) {
        self.paused = paused;
        self.set_status(if paused { Phase::Paused } else { Phase::Idle }, None);
    }

    /// The workspace-relative path this device is editing, if the activity
    /// is fresh and inside the workspace.
    fn activity_rel(&self) -> Option<String> {
        let (abs, at) = self.activity.as_ref()?;
        if at.elapsed() >= ACTIVITY_FRESH {
            return None;
        }
        rel_path(&self.cfg.root, Path::new(abs)).filter(|r| !r.is_empty())
    }

    /// The same, as the domain is told it: the section it is in, and the
    /// path inside that section. None for a path that is in no section.
    fn activity_place(&self) -> Option<(String, String)> {
        self.activity_rel().and_then(|rel| self.place(&rel)).filter(|(_, rel)| !rel.is_empty())
    }

    /// Is a beat owed — "this Mac is here (editing <path>)"? On a cadence,
    /// at once when the edited path changes, and at once when the document
    /// being edited is there to claim. Every device beats, editing or idle,
    /// so the others see who is around; one that goes quiet falls out of
    /// presence by the worker's TTL, and out of its lease with it.
    fn beat_due(&self) -> bool {
        self.last_beat.map(|t| t.elapsed() >= PRESENCE_BEAT).unwrap_or(true)
            || self.beaconed != self.activity_rel()
            || self.claim_owed()
    }

    /// When the next beat is owed: now, when the edited path has moved since
    /// the last one or its document is free to claim, and a beat's length
    /// after the last one otherwise.
    fn beat_deadline(&self) -> Instant {
        if self.beaconed != self.activity_rel() || self.claim_owed() {
            return Instant::now();
        }
        self.last_beat.map(|t| t + PRESENCE_BEAT).unwrap_or_else(Instant::now)
    }

    /// The document being edited is owed a claim now rather than at the next
    /// beat: the user asked to take it over, or the last poll said nobody
    /// holds it — this Mac included, which is what a lease another Mac has
    /// just let go of looks like from here. Not while somebody else holds it
    /// (the poll will say when they stop), and not when the domain could not
    /// say who holds what: then there is no lock to claim.
    fn claim_owed(&self) -> bool {
        // A path the worker would not take records no claim, so it could
        // never stop being owed one.
        let Some((id, rel)) = self.activity_place().filter(|(_, rel)| valid_rel_path(rel)) else { return false };
        if self.take_over.is_some() && self.take_over == self.activity_rel() {
            return true;
        }
        let key = lease_key(&rel);
        self.leases
            .as_ref()
            .is_some_and(|all| !all.iter().any(|l| l.path == key && l.space.as_deref().unwrap_or(SHARED) == id))
    }

    /// When to poll next, after anything that was not itself a poll: the
    /// poll clock, or sooner when a beat is owed — a beat has no request of
    /// its own, so a poll is the only thing that can carry it. This is what
    /// keeps an editing Mac visible: every settled edit runs a cycle and
    /// pushes the poll clock back, and a beat that waited for the clock would
    /// wait for the typing to stop.
    ///
    /// Not after a poll: one that failed leaves its beat owed, and pulling
    /// the next one forward would spin on a domain that is not answering.
    fn next_poll_after_cycle(&self) -> Instant {
        let clock = Instant::now() + self.poll_gap();
        if self.outdated.is_none() && !self.paused {
            clock.min(self.beat_deadline())
        } else {
            clock
        }
    }

    /// The last poll a quitting engine makes: "this Mac is leaving", so the
    /// others stop showing it now rather than at the end of the TTL.
    /// Best effort — the TTL is what catches a Mac that could not say so.
    async fn leave(&mut self) {
        if self.last_beat.is_some() {
            let _ = self.remote.poll(Some(&Beat::Leave)).await;
        }
    }

    #[cfg(test)]
    pub(crate) fn device_id_for_test(&self) -> &str {
        &self.cfg.device_id
    }

    #[cfg(test)]
    pub(crate) fn device_name_for_test(&self) -> &str {
        &self.cfg.device_name
    }

    #[cfg(test)]
    pub(crate) fn me_for_test(&self) -> Option<&str> {
        self.me.as_deref()
    }

    #[cfg(test)]
    pub(crate) async fn poll_for_test(&mut self) {
        let _ = self.poll_and_maybe_cycle().await;
    }

    /// Poll cheaply; a moved etag is what makes a cycle worth running — the
    /// shared workspace's, or any space's, all in the one answer. This Mac's
    /// beat rides along when one is owed, and the others' presence comes
    /// back in the answer and only re-emits when it changed.
    async fn poll_and_maybe_cycle(&mut self) -> RemoteResult<()> {
        let beat = self.beat_due().then(|| {
            let place = self.activity_place();
            let take = place.is_some() && self.take_over.is_some() && self.take_over == self.activity_rel();
            let (space, path) = match place {
                Some((id, rel)) => ((id != SHARED).then_some(id), Some(rel)),
                None => (None, None),
            };
            Beat::Here { name: self.cfg.device_name.clone(), space, path, take, ttl: self.beat_ttl() }
        });
        let editing = self.activity_rel();
        let sent = Instant::now();
        let poll = match self.remote.poll(beat.as_ref()).await {
            Ok(poll) => poll,
            Err(e) => {
                match e {
                    RemoteError::Removed => self.heard_removed(),
                    // What the account or the worker says of this device is
                    // the status, whichever request heard it.
                    RemoteError::DailyLimit | RemoteError::Slowed(_) => self.heard_failure(&e),
                    _ => {}
                }
                // A lock nobody can confirm is no lock: an editor kept
                // view-only by a lease this Mac can no longer hear about
                // would be the one way a lease could get in anybody's way.
                if self.leases.take().is_some_and(|l| !l.is_empty()) {
                    self.refresh_status();
                }
                return Err(e);
            }
        };
        if let Some(Beat::Here { take, .. }) = beat {
            // From when it was sent, not when it was answered: the next beat
            // is then owed a little early rather than a poll late.
            self.last_beat = Some(sent);
            self.beaconed = editing;
            if take {
                self.take_over = None;
            }
        }
        if let Some(limits) = poll.limits.clone() {
            lock(&self.pacer).set_limits(limits);
        }
        self.learn_people_here(&poll).await;

        // Which spaces this person is in comes first: presence and leases
        // are read against the folders they have on this Mac.
        let listed = poll.spaces.is_some();
        if let Some(spaces) = &poll.spaces {
            self.spaces = Some(spaces.clone());
            self.reconcile_spaces().await;
        }

        let presence = self.presence_of(&poll);
        let presence_changed = presence.len() != self.presence.len()
            || presence.iter().zip(self.presence.iter()).any(|(a, b)| {
                a.device_id != b.device_id || a.path != b.path || a.name != b.name || a.device != b.device
            });
        self.presence = presence;
        let holders = self.lease_holders();
        self.leases = poll.leases.clone();
        let leases_changed = self.lease_holders() != holders;

        let mut moved: BTreeSet<String> = BTreeSet::new();
        if Some(poll.manifest_etag.as_str()) != self.shared().state.manifest_etag.as_deref() {
            moved.insert(SHARED.to_string());
        }
        if listed {
            // Read off the list as `reconcile_spaces` left it: a space made a
            // moment ago is in it, and its unit has everything to download.
            for entry in self.spaces.iter().flatten() {
                let behind = self
                    .units
                    .get(&entry.id)
                    .is_some_and(|unit| unit.state.manifest_etag.as_deref() != Some(entry.etag.as_str()));
                if behind {
                    moved.insert(entry.id.clone());
                }
            }
        }
        // The domain answering again after a pass that could not reach it is
        // itself a reason for one: what that pass was carrying is still here.
        if !moved.is_empty() || self.phase == Phase::Offline {
            self.pass(Which::Moved(moved)).await?;
        } else if presence_changed || leases_changed {
            self.refresh_status();
        }
        Ok(())
    }

    /// The documents another Mac holds, in words — resolved the way presence
    /// is, and spelled as this Mac's folders spell them. None at all while
    /// this engine is not hearing the domain: a paused or outdated engine is
    /// not polling, and a lease it last heard about may have lapsed a minute
    /// ago.
    fn lease_holders(&self) -> Vec<LeaseHolder> {
        if self.paused || self.outdated.is_some() {
            return Vec::new();
        }
        let Some(leases) = &self.leases else { return Vec::new() };
        leases
            .iter()
            .filter(|l| l.device_id != self.cfg.device_id)
            .filter_map(|l| {
                let unit = self.units.get(l.space.as_deref().unwrap_or(SHARED))?;
                let own = self.me.as_deref() == Some(l.member_id.as_str());
                let person = Some(&l.member_id).filter(|_| !own).and_then(|m| self.people.get(m));
                Some(LeaseHolder {
                    path: lease_key(&unit.ws_rel(&l.path)),
                    device_id: l.device_id.clone(),
                    member_id: l.member_id.clone(),
                    name: person.cloned().unwrap_or_else(|| l.name.clone()),
                    device: l.name.clone(),
                    own,
                    until: l.until,
                })
            })
            .collect()
    }

    /// Whether this Mac holds the lease of the document at `rel`
    /// (workspace-relative), by the last poll.
    #[cfg(test)]
    pub(crate) fn holds_for_test(&self, rel: &str) -> bool {
        let Some((id, rel)) = self.place(rel) else { return false };
        let key = lease_key(&rel);
        self.leases.as_ref().is_some_and(|all| {
            all.iter().any(|l| {
                l.path == key && l.space.as_deref().unwrap_or(SHARED) == id && l.device_id == self.cfg.device_id
            })
        })
    }

    /// Everybody else here, in words. The worker says whose Mac each one is;
    /// the directory says what they are called — the same resolution every
    /// `by` gets. Your own other Mac is named as a
    /// Mac, and so is one whose person the directory cannot name yet. A path
    /// in a space is spelled as that space's folder on this Mac spells it.
    fn presence_of(&self, poll: &PollResponse) -> Vec<PresenceDevice> {
        let mut presence: Vec<PresenceDevice> = poll
            .presence
            .iter()
            .filter(|(id, _)| id.as_str() != self.cfg.device_id)
            .map(|(id, e)| {
                let person = Some(e.member_id.as_str())
                    .filter(|m| Some(*m) != self.me.as_deref())
                    .and_then(|m| self.people.get(m));
                let path = e.path.as_ref().and_then(|path| {
                    self.units.get(e.space.as_deref().unwrap_or(SHARED)).map(|unit| unit.ws_rel(path))
                });
                PresenceDevice {
                    device_id: id.clone(),
                    member_id: e.member_id.clone(),
                    name: person.cloned().unwrap_or_else(|| e.name.clone()),
                    device: e.name.clone(),
                    path,
                    ts: e.ts,
                }
            })
            .collect();
        presence.sort_by(|a, b| {
            a.name.cmp(&b.name).then_with(|| a.device.cmp(&b.device)).then_with(|| a.device_id.cmp(&b.device_id))
        });
        presence
    }

    /// A Mac here belongs to somebody this engine cannot name — someone who
    /// joined since it last probed. Ask once, under the same gap as a
    /// stranger in the manifest (`learn_people`).
    async fn learn_people_here(&mut self, poll: &PollResponse) {
        let stranger = poll.presence.values().any(|e| !self.people.contains_key(&e.member_id));
        if !stranger || self.people_at.map(|at| at.elapsed() < DIRECTORY_MIN_GAP).unwrap_or(false) {
            return;
        }
        self.probe_worker().await;
    }

    /* ----- the task ----- */

    /// The engine task: wake on commands, the edit bus, filesystem events, or
    /// the poll clock; run a pass when something might have moved. It ends
    /// when it is told to, or the moment the domain says this Mac's access
    /// was removed — which any request it makes may be the one to hear.
    ///
    /// Three things can hold a pass or a poll back: the retry clock after a
    /// failure, slow mode's one pass a minute, and Cloudflare's daily limit,
    /// under which nothing goes but a probe. A command from the person —
    /// *Sync now*, a page published — is not held by the first two.
    pub async fn run(
        mut self,
        mut cmds: mpsc::UnboundedReceiver<EngineCmd>,
        mut fs_events: mpsc::UnboundedReceiver<()>,
    ) -> Exit {
        // First contact: learn the worker, then a full pass brings a stale
        // device current.
        let probed = self.probe().await;
        self.clock(&probed);
        if self.can_cycle() && !self.removed && self.limited.is_none() {
            let result = self.cycle().await;
            self.clock(&result);
        } else {
            self.refresh_status();
        }
        self.remote.usage().save();
        if self.removed {
            return Exit::Removed;
        }
        let mut fs_dirty_at: Option<Instant> = None;
        let mut touch_dirty_at: Option<Instant> = None;
        // When the bulk lane is owed a pass (`Unit::owes`).
        let mut bulk_at: Option<Instant> = self.bulk_due();
        let mut polled_at: Option<Instant> = None;
        // A Mac that has never beaten owes one now, so it shows up as soon as
        // it has synced rather than a poll later.
        let mut next_poll = self.next_poll_after_cycle();
        // False once the watcher channel is closed — either it never started
        // (`spawn_engine` says so) or it has gone away. The engine carries on
        // without it; a closed channel would otherwise answer `None` forever
        // and spin the select.
        let mut watching = true;

        loop {
            let wake = self.wake_at(next_poll, fs_dirty_at, touch_dirty_at, bulk_at);
            let mut cycle_now = false;
            let mut everywhere = false;

            tokio::select! {
                cmd = cmds.recv() => match cmd {
                    None | Some(EngineCmd::Shutdown) => {
                        self.leave().await;
                        self.remote.usage().save();
                        return Exit::Shutdown;
                    }
                    Some(EngineCmd::SyncNow) => {
                        cycle_now = true;
                        everywhere = true;
                        self.active_at = Instant::now();
                        // Asked again, now that the person asked.
                        self.adds.declined = None;
                    }
                    Some(EngineCmd::Probe) => {
                        let was_outdated = self.outdated.is_some();
                        self.probe_worker().await;
                        if was_outdated && self.outdated.is_none() {
                            cycle_now = true;
                            everywhere = true;
                        } else {
                            self.refresh_status();
                        }
                        // A plan changed may have opened the bulk lane.
                        bulk_at = self.bulk_due();
                    }
                    Some(EngineCmd::Touched(rel)) => {
                        self.touch_activity(&rel);
                        touch_dirty_at = Some(Instant::now());
                    }
                    Some(EngineCmd::SetActivity(p)) => {
                        // A new path is owed a beat now; the poll is what
                        // carries it, so the poll comes forward. The frontend
                        // reports a path when the tab changes, not as you
                        // type, so this is one request per switch.
                        self.set_activity(p);
                        next_poll = next_poll.min(self.next_poll_after_cycle());
                    }
                    Some(EngineCmd::TakeOver(p)) => {
                        // The claim is the beat's, and the beat is the poll's:
                        // bring it forward, as a new path does.
                        self.take_over(p);
                        next_poll = next_poll.min(self.next_poll_after_cycle());
                    }
                    Some(EngineCmd::Focus(focused)) => {
                        let was = self.focused;
                        self.set_focus(focused);
                        if focused && !was {
                            // Back at it: catch up now — unless a poll went
                            // out moments ago, so that switching windows back
                            // and forth costs nothing.
                            let soonest = polled_at.map(|t| t + POLL_INTERVAL).unwrap_or_else(Instant::now);
                            next_poll = next_poll.min(soonest);
                        }
                    }
                    Some(EngineCmd::Pause(p)) => self.set_paused(p),
                    Some(EngineCmd::ConfirmDeletes) => {
                        self.confirm_deletes();
                        cycle_now = true;
                    }
                    Some(EngineCmd::ConfirmAdds(sync)) => {
                        self.confirm_adds(sync);
                        cycle_now = sync;
                    }
                    Some(EngineCmd::LiftWait) => {
                        self.lift_wait();
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
                    Some(EngineCmd::VersionsIndex { rel, reply }) => {
                        let unit = self.place(&rel).map(|(id, _)| id);
                        let found = match unit.and_then(|id| self.units.get_mut(&id)) {
                            Some(unit) => unit.versions_index().await,
                            None => None,
                        };
                        let _ = reply.send(Ok(found));
                    }
                    Some(EngineCmd::VersionSnapshot { rel, id, reply }) => {
                        let found = match self.place(&rel).and_then(|(unit, _)| self.units.get(&unit)) {
                            Some(unit) => unit.version_snapshot(&id).await,
                            None => None,
                        };
                        let _ = reply
                            .send(found.ok_or_else(|| "that version isn't reachable right now".to_string()));
                    }
                    Some(EngineCmd::SetCloudHorizon { rel, days, reply }) => {
                        let _ = reply.send(self.set_cloud_horizon(&rel, days).await);
                    }
                    Some(EngineCmd::VersionBlob { rel, hash, reply }) => {
                        let got = match self.place(&rel).and_then(|(unit, _)| self.units.get(&unit)) {
                            Some(unit) => unit.version_blob(&hash).await.map_err(|e| e.to_string()),
                            None => Err("that version isn't reachable right now".to_string()),
                        };
                        let _ = reply.send(got);
                    }
                    Some(EngineCmd::MakeSpace { name, members, from, reply }) => {
                        let made = self.make_space(&name, &members, from.as_deref().map(Path::new)).await;
                        // What a folder brought with it left another section:
                        // that is a pass's to carry.
                        cycle_now = made.is_ok();
                        let _ = reply.send(made);
                    }
                    Some(EngineCmd::SpaceMember { id, member, add, reply }) => {
                        let _ = reply.send(self.change_space_member(&id, &member, add).await);
                    }
                    Some(EngineCmd::DeleteSpace { id, reply }) => {
                        let _ = reply.send(self.delete_space(&id).await);
                    }
                    Some(EngineCmd::LinkTo { rel, reply }) => {
                        let linked = if !crate::syncs(&rel) {
                            Err("only a markdown or html document has a link: other files stay on this device".to_string())
                        } else if self.place(&rel).is_none() {
                            Err("that file is in no section, so it syncs nowhere and has no link".to_string())
                        } else {
                            if self.linked(&rel).is_none() && self.can_cycle() {
                                let _ = self.pass(Which::Dirty).await;
                                next_poll = self.next_poll_after_cycle();
                            }
                            self.linked(&rel).ok_or_else(|| {
                                "that file hasn't synced yet, so it has no link: try again once it has".to_string()
                            })
                        };
                        let _ = reply.send(linked);
                    }
                    Some(EngineCmd::Recent { limit, reply }) => {
                        let _ = reply.send(Ok(self.recent(limit)));
                    }
                    Some(EngineCmd::Follow { space, file, reply }) => {
                        if self.follow(space.as_deref(), &file).is_none() && self.can_cycle() {
                            let _ = self.poll_and_maybe_cycle().await;
                            next_poll = Instant::now() + POLL_INTERVAL;
                        }
                        let _ = reply.send(self.follow(space.as_deref(), &file).ok_or_else(|| {
                            format!(
                                "that page isn't one you can open in {}: it may have been deleted, or moved where you can't see it",
                                self.cfg.name
                            )
                        }));
                    }
                },
                ev = fs_events.recv(), if watching => match ev {
                    // No watcher on this workspace: the edit bus still
                    // carries everything the app writes, and the poll still
                    // brings in what other devices do. Only edits made by
                    // another program go unnoticed until one of those.
                    None => watching = false,
                    Some(()) => fs_dirty_at = Some(Instant::now()),
                },
                _ = tokio::time::sleep_until(wake) => {}
            }

            if self.removed {
                return Exit::Removed;
            }
            if self.paused {
                continue;
            }
            let now = Instant::now();

            if let Some(limited) = &self.limited {
                // Nothing goes but the probe: at its half hour, at the reset,
                // or when the person asks.
                let due = cycle_now || now >= limited.next_try || now_ms() >= limited.until_ms;
                if !due {
                    continue;
                }
                if self.probe().await.is_err() {
                    if let Some(limited) = self.limited.as_mut() {
                        limited.next_try = Instant::now() + LIMITED_PROBE;
                    }
                    self.remote.usage().save();
                    continue;
                }
                self.limited = None;
                self.failures = 0;
                self.retry_at = None;
                cycle_now = true;
                everywhere = true;
            }

            let pass_at = self.pass_at(fs_dirty_at, touch_dirty_at, bulk_at);
            if cycle_now || pass_at.is_some_and(|at| now >= at) {
                // One pass covers every pending hint: it looks at every
                // section's folder, and cycles the ones that changed.
                touch_dirty_at = None;
                fs_dirty_at = None;
                if self.can_cycle() {
                    let result = self.pass(if everywhere { Which::All } else { Which::Dirty }).await;
                    self.clock(&result);
                }
                bulk_at = self.bulk_due();
                next_poll = self.next_poll_after_cycle();
            } else if now >= next_poll {
                if !self.answered() {
                    // Waiting on a worker update, or for the domain to say
                    // who this device is — an engine that started offline:
                    // ask, and resume the moment it answers.
                    let probed = self.probe().await;
                    self.clock(&probed);
                    if self.can_cycle() && self.limited.is_none() {
                        let result = self.cycle().await;
                        self.clock(&result);
                    } else {
                        self.refresh_status();
                    }
                } else {
                    polled_at = Some(Instant::now());
                    let result = self.poll_and_maybe_cycle().await;
                    self.clock(&result);
                }
                if self.hourly_due() && !self.removed {
                    self.mirror_versions().await;
                }
                bulk_at = self.bulk_due();
                next_poll = Instant::now() + self.poll_gap();
            }
            if let Some(at) = self.retry_at {
                next_poll = next_poll.max(at);
            }
            self.remote.usage().save();
            if self.removed {
                return Exit::Removed;
            }
        }
    }

    /// When a pass that is wanted may run: the soonest pending hint, held
    /// back by the retry clock and by slow mode's one pass a minute.
    fn pass_at(&self, fs_dirty_at: Option<Instant>, touch_dirty_at: Option<Instant>, bulk_at: Option<Instant>) -> Option<Instant> {
        let wanted = [fs_dirty_at.map(|t| t + FS_SETTLE), touch_dirty_at.map(|t| t + TOUCH_SETTLE), bulk_at]
            .into_iter()
            .flatten()
            .min()?;
        let mut at = wanted;
        if let Some(retry) = self.retry_at {
            at = at.max(retry);
        }
        if let (true, Some(last)) = (self.slow(), self.last_pass_at) {
            at = at.max(last + SLOW_PASS_GAP);
        }
        Some(at)
    }

    /// When the task next has something to do by itself: the poll clock, or
    /// sooner for a pending hint — a touch settles in `TOUCH_SETTLE`, a
    /// filesystem event in `FS_SETTLE` — within what holds passes back.
    pub(crate) fn wake_at(
        &self,
        next_poll: Instant,
        fs_dirty_at: Option<Instant>,
        touch_dirty_at: Option<Instant>,
        bulk_at: Option<Instant>,
    ) -> Instant {
        if self.paused {
            // Only a command ends a pause.
            return Instant::now() + POLL_AWAY;
        }
        if let Some(limited) = &self.limited {
            let reset = Instant::now() + Duration::from_millis(limited.until_ms.saturating_sub(now_ms()));
            return limited.next_try.min(reset);
        }
        let poll = match self.retry_at {
            Some(retry) => next_poll.max(retry),
            None => next_poll,
        };
        match self.pass_at(fs_dirty_at, touch_dirty_at, bulk_at) {
            Some(pass) => poll.min(pass),
            None => poll,
        }
    }

    /// When the bulk lane is owed a pass: some unit left work for it — as
    /// soon as the bucket holds a batch while the lane is open, and at the
    /// reset (spread) while it waits.
    fn bulk_due(&self) -> Option<Instant> {
        if !self.units.values().any(|u| u.owes) {
            return None;
        }
        let mut pacer = lock(&self.pacer);
        if pacer.bulk_open() {
            return Some(Instant::now() + pacer.wait_for(MIN_BATCH).max(Duration::from_secs(1)));
        }
        let reset = next_midnight_ms().saturating_sub(now_ms()) + jitter_ms(LIMITED_SPREAD_MS);
        Some(Instant::now() + Duration::from_millis(reset))
    }
}

/// A number in [0, 1), for the retry clock's jitter.
fn unit_random() -> f64 {
    let mut buf = [0u8; 4];
    let _ = getrandom::getrandom(&mut buf);
    u32::from_le_bytes(buf) as f64 / (u32::MAX as f64 + 1.0)
}

/// Up to `max` ms, at random.
fn jitter_ms(max: u64) -> u64 {
    (unit_random() * max as f64) as u64
}

/// An epoch-ms moment as this device's clock reads it: "05:30".
fn local_time(ms: u64) -> String {
    chrono::DateTime::from_timestamp_millis(ms as i64)
        .map(|at| at.with_timezone(&chrono::Local).format("%H:%M").to_string())
        .unwrap_or_default()
}

/// Where new documents are, for the valve's question: each path's folder,
/// two levels deep at most, counted — most first, five at most.
fn folders_of(paths: &[String]) -> Vec<(String, u32)> {
    let mut counts: BTreeMap<String, u32> = BTreeMap::new();
    for path in paths {
        let dirs: Vec<&str> = path.split('/').collect();
        let dirs = &dirs[..dirs.len().saturating_sub(1)];
        *counts.entry(dirs[..dirs.len().min(2)].join("/")).or_default() += 1;
    }
    let mut out: Vec<(String, u32)> = counts.into_iter().collect();
    out.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    out.truncate(5);
    out
}

/// The addresses a unit has queued giving up.
fn removals<R: Remote>(unit: &Unit<R>) -> impl Iterator<Item = String> + '_ {
    unit.state.public_ops.iter().filter(|(_, op)| matches!(op, PublicOp::Remove)).map(|(slug, _)| slug.clone())
}

fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Pair each file that vanished from one unit with the same file appearing
/// in another: same content, same name. That is a move between sections —
/// made in the sidebar, in Finder, by dropping a folder into `Restricted/` —
/// and not a deletion and a new file.
fn pair_moves(surveys: &BTreeMap<String, Survey>) -> Vec<CrossMove> {
    let mut moves = Vec::new();
    let mut taken: HashSet<(&str, &str)> = HashSet::new();
    for (from, survey) in surveys {
        for (fid, hash, path) in &survey.vanished {
            let name = file_name(path);
            let arrival = surveys
                .iter()
                .filter(|(to, _)| *to != from)
                .flat_map(|(to, other)| other.news.iter().map(move |(new_path, new_hash)| (to, new_path, new_hash)))
                .find(|(to, new_path, new_hash)| {
                    *new_hash == hash
                        && file_name(new_path).eq_ignore_ascii_case(name)
                        && !taken.contains(&(to.as_str(), new_path.as_str()))
                });
            if let Some((to, new_path, _)) = arrival {
                taken.insert((to.as_str(), new_path.as_str()));
                moves.push(CrossMove {
                    from: from.clone(),
                    fid: fid.clone(),
                    to: to.clone(),
                    path: new_path.clone(),
                    hash: hash.clone(),
                });
            }
        }
    }
    moves
}

/// Where folder `dir` of a unit went, if every file its manifest held under
/// it moved to one folder of one other unit: that unit, and the folder there
/// (`""` when the folder became the unit's own root).
fn folder_went(dir: &str, manifest: &Manifest, out: &HashMap<&str, (&str, &str)>) -> Option<(String, String)> {
    let prefix = format!("{}/", dir);
    let mut target: Option<(String, String)> = None;
    for (fid, file) in manifest.files.iter().filter(|(_, f)| f.path.starts_with(&prefix)) {
        let (to, new_path) = out.get(fid.as_str())?; // not every file moved → the page stays
        let rest = &file.path[prefix.len()..];
        let new_dir = if *new_path == rest { "" } else { new_path.strip_suffix(rest)?.strip_suffix('/')? };
        match &target {
            None => target = Some((to.to_string(), new_dir.to_string())),
            Some((t, d)) if t == to && d == new_dir => {}
            Some(_) => return None,
        }
    }
    target
}

/// What became of a file another Mac moved into `dest`, a section this Mac
/// is in.
enum Received {
    /// The section already has it, or will download it: this Mac's copy from
    /// the old section is gone.
    Dropped,
    /// This Mac's copy is at this path of the section now.
    Placed(String),
    /// An edit made here could not carry on in the moved file, and is beside
    /// it as a conflict copy.
    Beside { path: String, copy: String },
}

/// Bring this Mac's copy of a file that moved to `dest` into `dest`'s
/// folder. `bytes` is the copy at `from`, `synced` the hash it last synced
/// at in the section it left, `base` those synced bytes.
///
/// The file as `dest` holds it is found by name and content. An untouched
/// copy takes its place, to be adopted by its hash with nothing downloaded.
/// A copy edited here since carries on as an edit of the moved file when it
/// was edited from exactly what `dest` holds; anything else lands beside it,
/// so no edit is lost and none is pushed over somebody's work.
fn receive<R: Remote>(
    dest: &mut Unit<R>,
    from: &Path,
    bytes: &[u8],
    synced: &str,
    base: Option<&[u8]>,
    who: &str,
) -> Received {
    let name = from.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let now = hash16(bytes);
    let clean = now == synced;
    let rel_of = |dest: &Unit<R>, abs: &Path| rel_path(&dest.root, abs).unwrap_or_default();
    let land = |to: &Path| {
        if let Some(parent) = to.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::rename(from, to).is_ok()
    };
    let candidate = dest
        .view()
        .files
        .iter()
        .filter(|(_, f)| file_name(&f.path).eq_ignore_ascii_case(&name))
        .max_by_key(|(_, f)| (f.hash == synced) as u8 * 2 + (f.hash == now) as u8)
        .map(|(fid, f)| (fid.clone(), f.clone()));

    let Some((fid, theirs)) = candidate else {
        if clean {
            let _ = std::fs::remove_file(from);
            return Received::Dropped;
        }
        // An edit with nothing to carry on in: it arrives as a document.
        let wanted = dest.root.join(&name);
        let to = if wanted.exists() { conflict_copy_path(&wanted, who) } else { wanted };
        if !land(&to) {
            return Received::Dropped;
        }
        dest.poke = true;
        return Received::Placed(rel_of(dest, &to));
    };

    let target = dest.root.join(&theirs.path);
    let there = read_file_checked(&target);
    if clean || now == theirs.hash {
        if there.is_some() {
            let _ = std::fs::remove_file(from);
            return Received::Dropped;
        }
        if !land(&target) {
            return Received::Dropped;
        }
        dest.poke = true;
        return Received::Placed(theirs.path);
    }
    let untouched_there = there.as_ref().map(|t| hash16(t) == theirs.hash).unwrap_or(true);
    if synced == theirs.hash && untouched_there {
        if !land(&target) {
            return Received::Dropped;
        }
        dest.plant(&fid, &theirs, base);
        return Received::Placed(theirs.path);
    }
    let copy = conflict_copy_path(&target, who);
    if !land(&copy) {
        return Received::Dropped;
    }
    dest.poke = true;
    Received::Beside { path: theirs.path, copy: rel_of(dest, &copy) }
}
