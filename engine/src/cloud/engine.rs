//! The engine: one task per connected workspace, the only code that holds a
//! token or talks to the worker.
//!
//! A workspace is several *sections* — Library, which everyone has, this
//! person's My files, and each thing that is shared: a folder, or one
//! document — and each one is a unit (unit.rs): its own manifest, its own
//! state, and its own part of a folder. Sections are a tree: something
//! shared sits where its item is, inside My files or another shared folder
//! for whoever can open that, under `Shared with me` for the people it is
//! shared with. The unit knows how one section is kept in step with one
//! manifest; this file is what a workspace has one of: who the domain says
//! this Mac is, the poll and the beat that rides it, presence and leases,
//! the status that is the frontend's entire model, and the task that decides
//! when which unit cycles. It is also the only place two units meet: a share
//! arriving, moving or leaving (`reconcile_spaces`), something shared on
//! this Mac (`share`), a file moving between sections on this Mac
//! (`pair_moves`) and on another (`relocate`), and what the app said it
//! renamed or moved (`heed_moves`).
//!
//! The engine wakes on four things — the edit bus, the filesystem watcher,
//! the poll clock, commands — and does one of two: a *pass* (the units with
//! something to say each run a cycle) or a *poll* (etags + presence, and
//! this Mac's own beat when one is due — the beat has no request of its
//! own). Generic over [`Remote`] so all of it runs in tests against an
//! in-memory worker.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
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
use super::remote::{NewShare, Remote, RemoteError, RemoteResult};
use super::scan::{hash16, now_ms, read_file_checked, read_json, rel_path, write_json};
use super::layout;
use super::space::{self, split_name, DocName, Reach, SpaceMarker, LIBRARY, LIBRARY_DIR, MY_FILES_DIR, SHARED_DIR};
use super::status::{
    documents_of, emit_statuses, CloudStatus, DirectoryPerson, Events, LeaseHolder, Phase, PresenceDevice, PublicPage,
    RecentFiles, SectionAt, SectionTable, SpaceStatus, StatusTable, UsageStatus, VersionsMirror, WorkspaceDocument,
    EV_APPLIED, EV_CONFLICT, EV_PENDING_ADDS, EV_SPACE_LEFT, EV_SPACE_MOVED,
};
use super::tags::TagOp;
use super::unit::{lock, Ctx, FileState, MovedOut, PendingPublic, PublicOp, Survey, Unit, UnitConfig};
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
/// worker's bounds. A browser beats by these and the two numbers below
/// (`BEAT_MS`, `ACTIVITY_FRESH_MS`, src/web/workspace.ts): change both.
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

/// A shared document's place, beside its unit's state.
const DOC_FILE: &str = "doc.json";
/// Beside a unit's state: its share is ending (`Engine::ending`).
const ENDING_FILE: &str = "ending";
/// What this device was sharing when it last stopped (`PendingShare`).
const PENDING_SHARE_FILE: &str = "pending-share.json";

/// The spaces this device holds sync state for, by id.
fn space_states(cfg: &EngineConfig) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(cfg.state_dir.join("spaces")) else { return Vec::new() };
    let mut ids: Vec<String> = entries.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
    ids.sort();
    ids
}

/* ---------- Commands ---------- */

pub struct PublishRequest {
    /// Workspace-relative; a section's own folder (`Library`) publishes the
    /// whole section as a folder.
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
    /// The edit bus: the app moved a file or a folder, workspace-relative.
    Moved { from: String, to: String },
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
    /// A change of the workspace's tag list.
    Tag {
        op: TagOp,
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
    /// Share the folder or the document at `path` (absolute) with `members`
    /// (member ids). It stays where it is. Something shared already gets
    /// those people as well.
    Share {
        path: String,
        members: Vec<String>,
        reply: oneshot::Sender<Result<SpaceStatus, String>>,
    },
    /// Share something with one more person, or stop — this person included,
    /// which is leaving it.
    ShareMember {
        id: String,
        member: String,
        add: bool,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Delete something shared, for everyone: kept thirty days, to restore.
    DeleteShare {
        id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Bring a deleted share back, as it was.
    RestoreShare {
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
    Documents {
        reply: oneshot::Sender<Result<Vec<WorkspaceDocument>, String>>,
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

/// Which sections this Mac holds, or where they are, just changed.
#[derive(Default)]
pub struct SpacesChanged {
    /// Sections taken off this Mac, by id: their local history goes with
    /// them — it holds every file's content.
    pub removed: Vec<String>,
}

/// Where a shared document is on this device, kept with its unit's state
/// (`doc.json`): a document carries no marker of its own.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocPlace {
    /// The folder it sits in, workspace-relative.
    dir: String,
    /// The name its files have here, and the one its manifest has.
    local: String,
    stored: String,
    /// The folder of the section it sits in that this Mac last matched it
    /// to (`Mount::dir`), as a shared folder's marker says of a folder.
    #[serde(default)]
    at: String,
}

/// Something this device was sharing when it last stopped: written down
/// before the domain is asked, so a share cut short is finished at the next
/// start rather than left half made.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingShare {
    id: String,
    kind: SpaceKind,
    name: String,
    parent: String,
    dir: String,
    was: String,
    members: Vec<String>,
}

/// How a section's copy leaves this device.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Leaving {
    /// It is not this person's any more: deleted outright, so nothing of it
    /// stays within their reach.
    Outright,
    /// This person deleted it, here: to the Trash, like anything they delete.
    Trash,
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
    /// The shared section's `state.json` + `base/`; each space's are under
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
    /// Where every section of every connected workspace is on this device:
    /// this engine keeps its own row true, for whatever walks a section's
    /// folder without asking it — the versioners.
    pub sections: SectionTable,
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

/// Where a share sits, as the section it sits in has it.
struct Agreed {
    /// That section.
    parent: String,
    /// The folder of it the share sits in, as this Mac last knew: what it
    /// has queued, else what the manifest says.
    dir: String,
    /// What the freshest manifest says, whatever this Mac has queued.
    said: String,
    /// Where the item was in that section before it was shared.
    was: Option<String>,
}

/// A share's id, as a device mints one: `s-` and eight hex characters.
fn share_id() -> String {
    let mut buf = [0u8; 4];
    let _ = getrandom::getrandom(&mut buf);
    format!("s-{}", buf.iter().map(|b| format!("{:02x}", b)).collect::<String>())
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
    /// Set by the manager, under the status table's lock, when it stops this
    /// engine and takes its row out (`stop_engine`): a pass still running
    /// then never writes the row back for a workspace that has gone.
    stopped: Arc<AtomicBool>,
    /// Every section this Mac holds, by id. Library is `LIBRARY` and always
    /// here; a unit is out of the map only while its cycle runs.
    units: BTreeMap<String, Unit<R>>,
    /// The spaces this person can open — and the deleted shares they can
    /// restore — as the last poll that could say listed them. `None` until
    /// one has.
    spaces: Option<Vec<SpaceEntry>>,
    /// How many times the domain would not make this person a My files.
    /// After a few it is not asked again until the app restarts.
    private_refusals: u8,
    /// Shares whose item this person moved into Library: they end. Their
    /// files leave them as a move, and then the share is erased.
    ending: HashSet<String>,
    /// Sections a file was moved to (`Tombstone::to`) that this device holds
    /// no unit of, and has not yet heard of from a poll: the file waits for
    /// the next one to say whether this person can open it there.
    asked_about: HashSet<String>,
    /// Those a poll has since answered for: not this person's. A file that
    /// moved to one is deleted from this device outright.
    absent: HashSet<String>,
    phase: Phase,
    error: Option<String>,
    last_sync_ms: Option<u64>,
    paused: bool,
    /// Set when the worker answered `426`: the worker version we saw it at.
    /// Cycles stop until `/api/meta` reports a newer worker.
    outdated: Option<u32>,
    /// Set when the worker answered `410`: this app is older than the domain
    /// answers. Cycles stop until a probe is answered — after the update,
    /// which restarts the app, or once the domain's minimum comes down.
    too_old: bool,
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
    /// What the app moved since the last pass that went through, in the
    /// order it moved them: (from, to), workspace-relative, a file or a
    /// folder. Tips for the scan (`Ctx::app_moves`), and where a share's
    /// item went (`heed_moves`); kept like `touched` until a pass has gone
    /// through.
    app_moves: Vec<(String, String)>,
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
        units.insert(LIBRARY.to_string(), Self::library_unit(&cfg, &remote));
        // The folders that say they are spaces, and the documents this
        // device wrote down as shared, are the record of which sections it
        // holds: each one syncs from where it left off. Whether this person
        // can still open each is the first poll's to say.
        for held in space::held(&cfg.root, &cfg.ws_id) {
            let marker = held.marker;
            units
                .entry(marker.space.clone())
                .or_insert_with(|| Self::folder_unit(&cfg, &remote, &marker.space, &marker.name, held.dir, held.rel));
        }
        let mut ending = HashSet::new();
        for id in space_states(&cfg) {
            let state_dir = Self::space_state_dir(&cfg, &id);
            if state_dir.join(ENDING_FILE).is_file() {
                ending.insert(id.clone());
            }
            let Some(place) = read_json::<DocPlace>(&state_dir.join(DOC_FILE)) else { continue };
            units.entry(id.clone()).or_insert_with(|| Self::document_unit(&cfg, &remote, &id, &place));
        }
        let pacer = Mutex::new(Pacer::new(remote.usage().clone()));
        let mut engine = Engine {
            cfg,
            remote,
            events,
            statuses,
            stopped: Arc::new(AtomicBool::new(false)),
            units,
            spaces: None,
            private_refusals: 0,
            ending,
            asked_about: HashSet::new(),
            absent: HashSet::new(),
            phase: Phase::Idle,
            error: None,
            last_sync_ms: None,
            paused: false,
            outdated: None,
            too_old: false,
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
            app_moves: Vec::new(),
            focused: true,
            active_at: Instant::now(),
            failures: 0,
            retry_at: None,
            limited: None,
            adds: Adds::default(),
            last_pass_at: None,
        };
        engine.set_reaches();
        engine
    }

    /// Library's unit: `Library/`, however the disk spells it.
    fn library_unit(cfg: &EngineConfig, remote: &Arc<R>) -> Unit<R> {
        let root = space::top(&cfg.root, LIBRARY_DIR);
        let prefix = root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        Unit::new(
            UnitConfig {
                id: LIBRARY.to_string(),
                name: cfg.name.clone(),
                root,
                prefix,
                document: None,
                state_dir: cfg.state_dir.clone(),
                data_dir: cfg.data_dir.clone(),
                device_id: cfg.device_id.clone(),
                ws_id: cfg.ws_id.clone(),
            },
            remote.clone(),
        )
    }

    fn space_state_dir(cfg: &EngineConfig, id: &str) -> PathBuf {
        cfg.state_dir.join("spaces").join(id)
    }

    /// The unit of a folder that is a section: My files, or a shared folder.
    fn folder_unit(cfg: &EngineConfig, remote: &Arc<R>, id: &str, name: &str, dir: PathBuf, rel: String) -> Unit<R> {
        Unit::new(
            UnitConfig {
                id: id.to_string(),
                name: name.to_string(),
                root: dir,
                prefix: rel,
                document: None,
                state_dir: Self::space_state_dir(cfg, id),
                data_dir: cfg.data_dir.clone(),
                device_id: cfg.device_id.clone(),
                ws_id: cfg.ws_id.clone(),
            },
            Arc::new(remote.space(id)),
        )
    }

    /// The unit of a shared document, where this device wrote down it is.
    fn document_unit(cfg: &EngineConfig, remote: &Arc<R>, id: &str, place: &DocPlace) -> Unit<R> {
        Unit::new(
            UnitConfig {
                id: id.to_string(),
                name: place.stored.clone(),
                root: cfg.root.join(&place.dir),
                prefix: place.dir.clone(),
                document: Some(DocName { local: place.local.clone(), stored: place.stored.clone() }),
                state_dir: Self::space_state_dir(cfg, id),
                data_dir: cfg.data_dir.clone(),
                device_id: cfg.device_id.clone(),
                ws_id: cfg.ws_id.clone(),
            },
            Arc::new(remote.space(id)),
        )
    }

    /// Where a unit's item is on this device, and for a shared document what
    /// its files are called here.
    fn item_at(unit: &Unit<R>) -> (String, Option<String>) {
        (unit.prefix.clone(), unit.reach.only.as_ref().map(|name| name.local.clone()))
    }

    /// Tell the app that the item of the unit `id` is not where `was` says
    /// any more (`EV_SPACE_MOVED`): a folder as one move, a document as one
    /// for each of its files.
    fn tell_moved(&self, id: &str, was: &(String, Option<String>)) {
        let Some(now) = self.units.get(id).map(Self::item_at) else { return };
        if *was == now {
            return;
        }
        let moves: Vec<serde_json::Value> = match (&was.1, &now.1) {
            (Some(was_local), Some(now_local)) => space::document_files(&self.cfg.root.join(&now.0), now_local)
                .into_iter()
                .filter_map(|file| {
                    let ext = split_name(&file.file_name()?.to_string_lossy()).1.to_string();
                    Some(json!({
                        "from": format!("{}/{}{}", was.0, was_local, ext),
                        "to": format!("{}/{}{}", now.0, now_local, ext),
                        "dir": false,
                    }))
                })
                .collect(),
            _ => vec![json!({ "from": was.0, "to": now.0, "dir": true })],
        };
        if !moves.is_empty() {
            self.events.emit_json(EV_SPACE_MOVED, json!({ "root": self.root_key(), "moves": moves }));
        }
    }

    /// Write down where a shared document's unit is (`DocPlace`), as its
    /// unit now has it. `at` is the folder of the section it sits in that
    /// this device has matched it to; None keeps what was written.
    fn note_document(&self, id: &str, at: Option<&str>) {
        let Some(unit) = self.units.get(id) else { return };
        let Some(name) = &unit.reach.only else { return };
        let path = Self::space_state_dir(&self.cfg, id).join(DOC_FILE);
        let was: Option<DocPlace> = read_json(&path);
        let place = DocPlace {
            dir: unit.prefix.clone(),
            local: name.local.clone(),
            stored: name.stored.clone(),
            at: at.map(str::to_string).or_else(|| was.as_ref().map(|w| w.at.clone())).unwrap_or_default(),
        };
        if was.as_ref() != Some(&place) {
            let _ = write_json(&path, &place);
        }
    }

    fn root_key(&self) -> String {
        self.cfg.root.to_string_lossy().to_string()
    }

    /// Whether a pass may run: not paused, not waiting on a worker update,
    /// and the domain has said who this device is.
    fn can_cycle(&self) -> bool {
        !self.paused && self.answered()
    }

    /// The domain answers this engine: neither side waits on an update, and
    /// it has said who this device is.
    fn answered(&self) -> bool {
        !self.waiting_on_update() && self.me.is_some()
    }

    /// One side is too old for the other: the worker for this app (`426`,
    /// a worker from before the limits) or this app for the worker (`410`).
    fn waiting_on_update(&self) -> bool {
        self.outdated.is_some() || self.too_old
    }

    /// Library's unit.
    pub(crate) fn library(&self) -> &Unit<R> {
        &self.units[LIBRARY]
    }

    #[cfg(test)]
    pub(crate) fn library_mut(&mut self) -> &mut Unit<R> {
        self.units.get_mut(LIBRARY).expect("Library's unit")
    }

    /// Which unit a workspace-relative path is in, and the path as that unit
    /// spells it: the most specific one — a shared document's before the
    /// folder it sits in, a shared folder's before the section around it.
    /// None for a path that is no section's: the workspace's root, anything
    /// at its top that is not one of the three folders, `Shared with me`
    /// itself and a file loose in it.
    fn place(&self, ws_rel: &str) -> Option<(String, String)> {
        self.units
            .values()
            .filter_map(|unit| unit.in_unit(ws_rel).map(|rel| (unit, rel)))
            .max_by_key(|(unit, _)| (unit.is_document(), unit.prefix.len()))
            .map(|(unit, rel)| (unit.id.clone(), rel))
    }

    /// The unit whose own files the folder `dir` (absolute) holds: the
    /// deepest folder section around it, itself included. Never a shared
    /// document's — that is a document, not a folder.
    fn section_of_dir(&self, dir: &Path) -> Option<&Unit<R>> {
        self.units
            .values()
            .filter(|unit| !unit.is_document() && dir.starts_with(&unit.root))
            .max_by_key(|unit| unit.root.as_os_str().len())
    }

    /// Say what of each unit's folder is its own: everything but the shares
    /// that sit inside it. Then tell whoever else walks a section (the
    /// versioners) where each is.
    fn set_reaches(&mut self) {
        let mut holes: HashMap<String, (Vec<String>, Vec<String>)> = HashMap::new();
        for unit in self.units.values() {
            // What is inside which: a shared folder inside the deepest
            // section around its parent folder, a shared document inside the
            // deepest section its folder is in.
            let inside = if unit.is_document() { Some(unit.root.as_path()) } else { unit.root.parent() };
            let Some(around) = inside.and_then(|dir| self.section_of_dir(dir)).filter(|a| a.id != unit.id) else { continue };
            let Some(rel) = rel_path(&around.root, &unit.root) else { continue };
            let entry = holes.entry(around.id.clone()).or_default();
            match &unit.reach.only {
                Some(name) => entry.1.push(if rel.is_empty() { name.local.clone() } else { format!("{}/{}", rel, name.local) }),
                None => entry.0.push(rel),
            }
        }
        for unit in self.units.values_mut().filter(|unit| !unit.is_document()) {
            let (mut dirs, mut docs) = holes.remove(&unit.id).unwrap_or_default();
            dirs.sort();
            docs.sort();
            unit.reach = Reach { dirs, docs, only: None };
        }
        let sections: Vec<SectionAt> = self
            .units
            .values()
            .filter(|unit| unit.root.is_dir())
            .map(|unit| SectionAt {
                ws_id: self.cfg.ws_id.clone(),
                id: unit.id.clone(),
                root: unit.root.clone(),
                reach: unit.reach.clone(),
                from: self.spaces.iter().flatten().find(|s| s.id == unit.id).and_then(|s| s.parent.clone()).and_then(|parent| {
                    let was = self.units.get(&parent)?.view().mounts.get(&unit.id)?.was.clone()?;
                    Some((parent, was))
                }),
            })
            .collect();
        let changed = match self.cfg.sections.lock() {
            Ok(mut table) => table.insert(self.root_key(), sections.clone()).as_ref() != Some(&sections),
            Err(_) => false,
        };
        if changed {
            if let Some(tell) = &self.cfg.on_spaces {
                tell(SpacesChanged::default());
            }
        }
    }

    /* ----- links ----- */

    /// What a link to the file at `ws_rel` names, and who can open it. None
    /// for a path in no section, and for a file with no id yet. The browser
    /// version says who in the same words (`linkTo`, src/web/address.ts),
    /// and so does the `@` list (`whoCanOpen`, src/docLinks.ts): change all
    /// three.
    pub(crate) fn linked(&self, ws_rel: &str) -> Option<Linked> {
        let (id, rel) = self.place(ws_rel)?;
        let unit = self.units.get(&id)?;
        let file = unit.file_id_at(&rel)?;
        let listed = self.spaces.iter().flatten().find(|s| s.id == id);
        let alone = listed.is_some_and(|s| {
            s.members.iter().chain(s.above.iter()).all(|person| Some(person.as_str()) == self.me.as_deref())
        });
        let who = if id == LIBRARY {
            format!("Everyone in {} can open it.", self.cfg.name)
        } else if id.starts_with("p-") || alone {
            "Only you can open it, on any device of yours.".to_string()
        } else {
            format!("Only the people “{}” is shared with can open it.", listed.map(|s| s.name.as_str()).unwrap_or(&unit.name))
        };
        Some(Linked { space: (id != LIBRARY).then_some(id), file, who })
    }

    /// Where the file a link names is here, workspace-relative: only one
    /// this device holds and has on disk. A section this person is not in
    /// is no unit here, so a link into it finds nothing — the same as one to
    /// a page that was deleted, and as one to a page that never was.
    ///
    /// A file keeps its id when it moves to another section, so the id is
    /// looked for in every section, the one the link names (`space`) first.
    /// While a move is half done one id is in two sections: then the named
    /// one wins, else the lowest section id, which is the shared section's.
    /// The browser looks the same way (`pathOfFile`, src/web/workspace.ts):
    /// change both.
    pub(crate) fn follow(&self, space: Option<&str>, file: &str) -> Option<String> {
        let named = space.unwrap_or(LIBRARY);
        let found = |unit: &Unit<R>| {
            let synced = unit.state.files.get(file)?;
            unit.abs(&synced.path).is_file().then(|| unit.ws_rel(&synced.path))
        };
        // `units` is in section-id order.
        self.units.get(named).and_then(found).or_else(|| self.units.values().find_map(found))
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

    /// `cloud_documents`: every section's documents on this device, by path,
    /// each with its file id once a manifest carries it.
    pub(crate) fn documents(&self) -> Vec<WorkspaceDocument> {
        documents_of(self.units.values().flat_map(|unit| unit.recent("")).map(|file| WorkspaceDocument {
            path: file.path,
            file_id: file.file_id,
            section: file.section,
        }))
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

    /// The sections beside Library, as the status lists them: the ones this
    /// device holds, and the deleted shares this person can restore. A
    /// folder says it is one before the domain has said anything this run —
    /// a Mac that started offline — and is listed by what the folder says:
    /// where it is, what it is called, and nobody that can be named.
    fn space_statuses(&self) -> Vec<SpaceStatus> {
        let listed = |id: &str| self.spaces.iter().flatten().find(|s| s.id == id);
        let mut out: Vec<SpaceStatus> = self
            .units
            .values()
            .filter(|unit| !unit.is_library() && !self.ending.contains(&unit.id))
            .map(|unit| {
                let entry = listed(&unit.id);
                SpaceStatus {
                    id: unit.id.clone(),
                    kind: entry.map(|s| s.kind).unwrap_or_else(|| unit.kind()),
                    name: entry.map(|s| s.name.clone()).unwrap_or_else(|| unit.name.clone()),
                    path: unit.item(),
                    by: entry.map(|s| self.name_of(&s.by)).unwrap_or_default(),
                    owner: entry.map(|s| s.owner.clone()).unwrap_or_default(),
                    parent: entry.and_then(|s| s.parent.clone()),
                    placed: entry.is_some_and(|s| s.kind == SpaceKind::Private || s.parent.is_some()),
                    members: entry.map(|s| s.members.clone()).unwrap_or_default(),
                    above: entry.map(|s| s.above.clone()).unwrap_or_default(),
                    deleted_at: None,
                }
            })
            .collect();
        for s in self.spaces.iter().flatten().filter(|s| s.deleted()) {
            out.push(SpaceStatus {
                id: s.id.clone(),
                kind: s.kind,
                name: s.name.clone(),
                path: String::new(),
                by: self.name_of(&s.by),
                owner: s.owner.clone(),
                parent: s.parent.clone(),
                placed: s.parent.is_some(),
                members: s.members.clone(),
                above: s.above.clone(),
                deleted_at: s.deleted_at,
            });
        }
        out
    }

    fn set_status(&mut self, phase: Phase, error: Option<String>) {
        self.phase = phase;
        self.error = error;
        self.refresh_status();
    }

    /// Re-emit the current phase (presence moved, an op was queued).
    fn refresh_status(&self) {
        let mirror = self.library().mirror;
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
                last_mirror_ms: self.library().last_mirror_ms,
                horizon_days: mirror.and_then(|m| m.horizon_days),
            },
            public: self.public_pages(),
            tags: self.library().effective_tags(),
            presence: self.presence.clone(),
            leases: self.lease_holders(),
            spaces: self.space_statuses(),
        };
        if let Ok(mut table) = self.statuses.lock() {
            if !self.stopped.load(Ordering::SeqCst) {
                table.insert(self.root_key(), status);
            }
        }
        emit_statuses(self.events.as_ref(), &self.statuses);
    }

    /// What the manager sets when it stops this engine.
    pub(crate) fn stopped(&self) -> Arc<AtomicBool> {
        self.stopped.clone()
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
    /// the worker has been updated since; after a `410`, whether the domain
    /// answers this app again.
    pub(crate) async fn probe_worker(&mut self) {
        let _ = self.probe().await;
    }

    /// The same, answering how it went — what the retry clock reads.
    async fn probe(&mut self) -> RemoteResult<()> {
        match self.remote.meta().await {
            Ok(meta) => {
                self.worker_version = Some(meta.version);
                self.too_old = false;
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
                if self.me.is_none() || matches!(e, RemoteError::DailyLimit | RemoteError::TooOld(_)) {
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
            return Ok(()); // waiting on an update, or to be told who this device is
        }
        if !self.cfg.root.is_dir() {
            // Root missing (unmounted disk, renamed folder…): touch nothing.
            self.set_status(Phase::Error, Some("workspace folder is missing — sync is paused".into()));
            return Ok(());
        }
        // A folder that is not in the Library layout is never synced: every
        // file would read as moved, and the manifest would tell every device.
        // The move is connect's and resume's (layout.rs).
        if let Err(why) = layout::ready(&self.cfg.root) {
            self.set_status(Phase::Error, Some(why));
            return Ok(());
        }
        if !self.library().root.is_dir() && !self.mend_library() {
            self.set_status(
                Phase::Error,
                Some("Something called “Library” that isn't a folder is at the top of this workspace's folder. Move it away, and Doklin brings Library back.".into()),
            );
            return Ok(());
        }
        // What the app said it moved comes first: a share's item moved on
        // this Mac is still that share, wherever it went.
        self.heed_moves().await;
        // A shared folder that is not where this Mac had it — moved by hand,
        // or gone — is found again, or made whole again, before the section
        // around it could read its files as its own, or as deleted. So is a
        // shared document: followed by its content, or brought back.
        if self.units.values().any(|u| self.misplaced(u)) {
            self.reconcile_spaces().await;
        }
        self.follow_documents();
        self.set_reaches();

        // What each section looks like, with no request made: which units
        // have something to push, and which files changed section. A unit
        // with no folder has nothing to say until it has one again — but one
        // whose share is ending says that every file of it has left.
        let surveys: BTreeMap<String, Survey> = self
            .units
            .values()
            .filter(|u| !u.gone && (u.root.is_dir() || self.ending.contains(&u.id)))
            .map(|u| (u.id.clone(), u.survey()))
            .collect();
        let said = self.said_between();
        let moves = pair_moves(&surveys, &said);
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
                self.units
                    .values()
                    .filter(|u| u.poke && !u.gone && (u.root.is_dir() || self.ending.contains(&u.id)))
                    .map(|u| u.id.clone())
                    .collect()
            };
            for id in ids {
                match self.cycle_unit(&id, &moves, hold_new).await {
                    Ok(paths) => changed.extend(paths),
                    // A space that answers "not found" is one this person is
                    // not in any more, or one that is gone. Which, the next
                    // poll says; until then it is left exactly as it is.
                    Err(RemoteError::NotFound) if id != LIBRARY => {
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
                                | RemoteError::TooOld(_)
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
                // What the app wrote has gone — the express lane never waits —
                // and so have the moves it made.
                self.touched.clear();
                self.app_moves.clear();
                self.end_shares().await;
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
            None | Some(RemoteError::Conflict) | Some(RemoteError::Outdated(_)) | Some(RemoteError::TooOld(_)) => Ok(()),
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
            RemoteError::TooOld(m) => {
                self.too_old = true;
                self.set_status(Phase::AppOutdated, Some(m.clone()));
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
                if arriving || renamed.contains(hash.as_str()) || !crate::is_document(path) {
                    continue;
                }
                news.push(unit.ws_rel(&counted_under(path)));
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
        self.follow_document_rename(unit);
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
        let moved_in: HashMap<String, String> =
            moves.iter().filter(|m| m.to == unit.id).map(|m| (m.path.clone(), m.fid.clone())).collect();
        let elsewhere: HashSet<String> = self.units.values().flat_map(|other| other.state.manifest.files.keys().cloned()).collect();
        let ws_root = self.root_key();
        let own_edits: HashSet<String> =
            self.touched.iter().filter_map(|p| unit.in_unit(p)).filter(|rel| !rel.is_empty()).collect();
        // What the app moved inside this section, both ends in it: a move
        // into another section is that one's to pair (`moves`).
        let mut app_moves: Vec<(String, String)> = self
            .app_moves
            .iter()
            .filter_map(|(from, to)| Some((unit.in_unit(from)?, unit.in_unit(to)?)))
            .filter(|(from, to)| !from.is_empty() && !to.is_empty())
            .collect();
        // And what the engine itself renamed here.
        app_moves.append(&mut unit.renamed);
        // A shared document this person cannot place sits in no folder of
        // theirs: a conflict copy of it goes to their My files.
        let unplaced = unit.is_document()
            && !self.spaces.iter().flatten().any(|s| s.id == unit.id && s.parent.is_some());
        let my_files = space::top(&self.cfg.root, MY_FILES_DIR);
        let ctx = Ctx {
            signature: &signature,
            people: &self.people,
            events: self.events.as_ref(),
            ws_root: &ws_root,
            trash: self.cfg.trash.clone(),
            releasing: &releasing,
            moved_out: &moved_out,
            moved_in: &moved_in,
            elsewhere: &elsewhere,
            pacer: &self.pacer,
            touched: &own_edits,
            app_moves: &app_moves,
            hold_new,
            copies_in: unplaced.then_some(my_files.as_path()),
        };
        let written = unit.cycle_inner(&ctx).await?;
        touched.extend(written);
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
        let mut kept = false;
        for (fid, to, by) in moved {
            let Some(held) = unit.state.files.get(&fid).cloned() else { continue };
            let from = unit.abs(&held.path);
            // A section this device holds no unit of is one this person
            // cannot open — or one a poll has not told it of yet: something
            // shared a moment ago on another device of theirs. Only a poll
            // says which, so the file waits for one rather than be deleted
            // from under an edit.
            if !self.units.contains_key(&to) && !self.absent.contains(&to) {
                self.asked_about.insert(to);
                continue;
            }
            if let Some(bytes) = read_file_checked(&from) {
                let base = std::fs::read(unit.base_path(&fid)).ok();
                let who = self.name_of(&by);
                match self.units.get_mut(&to) {
                    None => {
                        let _ = std::fs::remove_file(&from);
                    }
                    Some(dest) => {
                        match receive(dest, &fid, &from, &bytes, &held.hash, base.as_deref(), &who) {
                            Received::Kept => {
                                dest.persist_state();
                                unit.forget(&fid);
                                kept = true;
                                continue;
                            }
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
        if !touched.is_empty() || kept {
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

    /* ----- shares coming, moving and going ----- */

    /// A member's name for a share's second name on disk (`space::candidates`).
    fn owner_name(&self, entry: &SpaceEntry) -> String {
        self.people.get(&entry.owner).cloned().unwrap_or_default()
    }

    /// Whether a shared folder's unit is not where this Mac had it: its
    /// folder is gone, or is some other folder now.
    fn misplaced(&self, unit: &Unit<R>) -> bool {
        if unit.is_library() || unit.is_document() || self.ending.contains(&unit.id) {
            return false;
        }
        !unit.root.is_dir() || space::read_space_marker(&unit.root).is_none_or(|m| m.space != unit.id)
    }

    /// Take a section's copy off this device, and everything kept for it:
    /// its sync state, its local history.
    fn drop_unit(&mut self, id: &str, how: Leaving, changed: &mut SpacesChanged) {
        let Some(unit) = self.units.remove(id) else { return };
        let (name, path) = (unit.name.clone(), unit.item());
        let trash = |path: &Path| how == Leaving::Trash && self.cfg.trash.as_ref().is_some_and(|trash| trash(path));
        let gone = match &unit.reach.only {
            Some(doc) => {
                for file in space::document_files(&unit.root, &doc.local) {
                    if !trash(&file) {
                        let _ = std::fs::remove_file(&file);
                    }
                }
                true
            }
            None => match space::read_space_marker(&unit.root) {
                Some(marker) => {
                    let held = space::Held { dir: unit.root.clone(), rel: unit.prefix.clone(), marker };
                    trash(&unit.root) || space::remove_space_dir(&self.cfg.root, &held)
                }
                // No folder of it here: nothing to take away.
                None => !unit.root.exists(),
            },
        };
        let _ = std::fs::remove_dir_all(Self::space_state_dir(&self.cfg, id));
        self.ending.remove(id);
        changed.removed.push(id.to_string());
        if gone {
            self.events.emit_json(EV_SPACE_LEFT, json!({ "root": self.root_key(), "name": name, "path": path }));
        }
    }

    /// Bring this Mac in line with the sections this person can open: the
    /// last poll's list on one side, the folders that say they are spaces
    /// and the documents this Mac wrote down as shared on the other.
    ///
    /// A section with nothing here gets its place, and its unit downloads
    /// it — unless its item is here already, where the section it sits in
    /// had it: sharing moves nothing. One this person can no longer open is
    /// deleted from this Mac outright, with its sync state and its local
    /// history; nothing in the cloud is touched. One found somewhere it
    /// does not sit is moved there — or, moved on this Mac inside the
    /// section it sits in, that section is told. A shared folder renamed
    /// here is renamed for everyone.
    pub(crate) async fn reconcile_spaces(&mut self) {
        let Some(mut list) = self.spaces.clone() else { return };
        let root = self.cfg.root.clone();
        if !root.is_dir() || layout::ready(&root).is_err() {
            return;
        }
        let ws_id = self.cfg.ws_id.clone();
        let mut changed = SpacesChanged::default();
        let mut moved = false;

        // Everyone has a My files.
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
        // A share this Mac was making when it last stopped is finished
        // first: the same id again is the same share.
        let mut made_in = None;
        if let Some(made) = self.finish_pending_share().await {
            made_in = made.parent.clone();
            if !list.iter().any(|s| s.id == made.id) {
                list.push(made);
            }
        }

        // What this person can no longer open leaves this Mac. My files is
        // its person's for as long as they are in the workspace, so a list
        // without it is a list to mend (above), never a folder to delete.
        let live: HashSet<String> = list.iter().filter(|s| !s.deleted()).map(|s| s.id.clone()).collect();
        let left: Vec<String> = self
            .units
            .values()
            .filter(|u| !u.is_library() && !live.contains(&u.id) && u.kind() != SpaceKind::Private)
            .map(|u| u.id.clone())
            .collect();
        for id in left {
            self.drop_unit(&id, Leaving::Outright, &mut changed);
        }

        // Parents before what sits in them: a share is placed against the
        // folder of the section it sits in.
        let mut order: Vec<SpaceEntry> = Vec::new();
        let mut rest: Vec<SpaceEntry> = list.iter().filter(|s| !s.deleted()).cloned().collect();
        rest.sort_by_key(|s| (s.kind != SpaceKind::Private, s.created_at, s.id.clone()));
        while !rest.is_empty() {
            let ready: Vec<SpaceEntry> = rest
                .iter()
                .filter(|s| s.parent.as_ref().is_none_or(|p| order.iter().any(|o| &o.id == p) || !rest.iter().any(|r| &r.id == p)))
                .cloned()
                .collect();
            if ready.is_empty() {
                order.append(&mut rest);
                break;
            }
            rest.retain(|s| !ready.iter().any(|r| r.id == s.id));
            order.extend(ready);
        }

        // Where a share sits is the manifest of the section it sits in's to
        // say: read the one the list speaks of before placing by it.
        for parent in order.iter().filter(|p| order.iter().any(|s| s.parent.as_deref() == Some(p.id.as_str()))) {
            if let Some(unit) = self.units.get_mut(&parent.id) {
                // …and the one a share was just made in, whatever the list said of it.
                let stale = unit.state.manifest_etag.as_deref() != Some(parent.etag.as_str()) || made_in.as_deref() == Some(parent.id.as_str());
                if unit.incoming.is_none() && stale {
                    let _ = unit.fetch().await; // a failure is the cycle's to report
                }
            }
        }

        // The folders that say they are spaces: asked of the disk only when
        // some folder is not where its unit has it, or has no unit yet.
        let walk = order.iter().any(|s| s.kind != SpaceKind::Document && self.units.get(&s.id).is_none_or(|u| self.misplaced(u)));
        let held: Vec<space::Held> = if walk { space::held(&root, &ws_id) } else { Vec::new() };

        for at in 0..order.len() {
            let entry = order[at].clone();
            let before = self.units.get(&entry.id).map(|u| (u.root.clone(), u.reach.only.clone()));
            let was = self.units.get(&entry.id).map(Self::item_at);
            match entry.kind {
                SpaceKind::Private => self.place_private(&entry, &held),
                SpaceKind::Folder => {
                    if let Some(name) = self.place_folder(&entry, &held).await {
                        order[at].name = name;
                    }
                }
                SpaceKind::Document => self.place_document(&entry),
            }
            let after = self.units.get(&entry.id).map(|u| (u.root.clone(), u.reach.only.clone()));
            moved |= before != after;
            if let Some(was) = was {
                self.tell_moved(&entry.id, &was);
            }
        }
        for entry in &mut list {
            if let Some(placed) = order.iter().find(|o| o.id == entry.id) {
                entry.name = placed.name.clone();
            }
        }

        self.spaces = Some(list);
        self.set_reaches();
        if !changed.removed.is_empty() || moved {
            if let Some(tell) = &self.cfg.on_spaces {
                tell(changed);
            }
            self.refresh_status();
        }
    }

    /// My files: `My files/`, with its marker.
    fn place_private(&mut self, entry: &SpaceEntry, held: &[space::Held]) {
        let root = self.cfg.root.clone();
        if self.units.get(&entry.id).is_some_and(|u| !self.misplaced(u)) {
            return;
        }
        let marker = SpaceMarker { ws_id: self.cfg.ws_id.clone(), space: entry.id.clone(), name: entry.name.clone(), dir: String::new() };
        let found = held.iter().find(|h| h.marker.space == entry.id && h.dir.parent() == Some(root.as_path()));
        let dir = match found {
            Some(folder) => folder.dir.clone(),
            None => {
                // Whatever is at `My files/` already is this person's own: it
                // was never shared, and it stays theirs.
                let dir = space::top(&root, MY_FILES_DIR);
                if std::fs::create_dir_all(&dir).is_err() || space::write_space_marker(&dir, &marker).is_err() {
                    return;
                }
                let _ = std::fs::remove_dir_all(Self::space_state_dir(&self.cfg, &entry.id));
                self.units.remove(&entry.id);
                dir
            }
        };
        let rel = space::spelled(&root, &dir);
        match self.units.get_mut(&entry.id) {
            Some(unit) => {
                unit.root = dir;
                unit.prefix = rel;
                unit.gone = false;
            }
            None => {
                let unit = Self::folder_unit(&self.cfg, &self.remote, &entry.id, &entry.name, dir, rel);
                self.units.insert(entry.id.clone(), unit);
            }
        }
    }

    /// Where a share's item belongs on this Mac: the folder it sits in, and
    /// that folder as the section it sits in spells it (`Mount::dir`) — None
    /// for one this person cannot place, which sits under `Shared with me`.
    /// `said` is what the domain's manifest says, before anything this Mac
    /// has queued.
    fn home_of(&self, entry: &SpaceEntry) -> (PathBuf, Option<Agreed>) {
        let parent = entry.parent.as_ref().and_then(|p| self.units.get(p)).filter(|p| !p.is_document());
        match parent {
            Some(parent) => {
                let dir = parent.mount_dir(&entry.id);
                let mount = parent.view().mounts.get(&entry.id);
                let home = if dir.is_empty() { parent.root.clone() } else { parent.root.join(&dir) };
                let agreed = Agreed {
                    parent: parent.id.clone(),
                    dir,
                    said: mount.map(|m| m.dir.clone()).unwrap_or_default(),
                    was: mount.and_then(|m| m.was.clone()),
                };
                (home, Some(agreed))
            }
            None => (space::top(&self.cfg.root, SHARED_DIR), None),
        }
    }

    /// The folder of the section `parent` that `dir` (absolute) is, when it
    /// is one of that section's own folders.
    fn dir_in(&self, parent: &str, dir: &Path) -> Option<String> {
        let unit = self.units.get(parent)?;
        let rel = rel_path(&unit.root, dir)?;
        (self.section_of_dir(dir).map(|u| u.id.as_str()) == Some(parent)).then_some(rel)
    }

    /// A shared folder: found where it sits, moved there, adopted where its
    /// item already is, or made. Answers its name when this Mac changed it.
    async fn place_folder(&mut self, entry: &SpaceEntry, held: &[space::Held]) -> Option<String> {
        let root = self.cfg.root.clone();
        let owner = self.owner_name(entry);
        let (home, agreed) = self.home_of(entry);
        let mut marker = SpaceMarker {
            ws_id: self.cfg.ws_id.clone(),
            space: entry.id.clone(),
            name: entry.name.clone(),
            dir: agreed.as_ref().map(|a| a.dir.clone()).unwrap_or_default(),
        };
        let free = |home: &Path, skip: Option<&Path>| {
            home.join(space::free_name(&entry.name, &owner, |name| {
                let at = home.join(name);
                Some(at.as_path()) != skip && space::name_taken(home, name, false)
            }))
        };
        // Where this Mac has it: its unit, when that still is the folder —
        // else wherever a folder says it is this space.
        let known = self.units.get(&entry.id).filter(|u| !self.misplaced(u)).map(|u| u.root.clone());
        let found = known.or_else(|| held.iter().find(|h| h.marker.space == entry.id).map(|h| h.dir.clone()));
        let mut renamed = None;
        let dir = match found {
            Some(mut dir) => {
                let was = space::read_space_marker(&dir).unwrap_or_else(|| marker.clone());
                let actual = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                let around = dir.parent().map(Path::to_path_buf).unwrap_or_default();
                // Where: in the folder it sits in, or to be moved there —
                // unless this Mac moved it, inside the section it sits in.
                let here = agreed.as_ref().and_then(|a| self.dir_in(&a.parent, &around));
                let in_place = match (&agreed, &here) {
                    (Some(a), Some(here)) if here.eq_ignore_ascii_case(&a.dir) => true,
                    (Some(a), Some(here)) if a.dir == was.dir => {
                        // Its marker agrees with its section about where it
                        // sat, and it is somewhere else in that section: it
                        // was moved on this Mac, and its section says so
                        // from now on.
                        if let Some(parent) = self.units.get_mut(&a.parent) {
                            parent.queue_mount(&entry.id, here);
                        }
                        marker.dir = here.clone();
                        true
                    }
                    (None, _) => around == home,
                    _ => false,
                };
                if !in_place {
                    let to = free(&home, None);
                    if std::fs::create_dir_all(&home).is_ok() && std::fs::rename(&dir, &to).is_ok() {
                        dir = to;
                    }
                }
                // What it is called.
                let actual = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or(actual);
                if entry.name != was.name {
                    // Renamed by somebody on it: the folder follows.
                    if !space::names_item(&actual, &entry.name, &owner) {
                        let to = free(dir.parent().unwrap_or(&home), Some(&dir));
                        if std::fs::rename(&dir, &to).is_ok() {
                            dir = to;
                        }
                    }
                } else if !space::names_item(&actual, &entry.name, &owner) && space::valid_item_name(&actual) {
                    // Renamed here: that is its new name, for everyone.
                    if self.remote.rename_space(&entry.id, &actual).await.is_ok() {
                        marker.name = actual.clone();
                        renamed = Some(actual);
                    }
                }
                if space::read_space_marker(&dir).as_ref() != Some(&marker) {
                    let _ = space::write_space_marker(&dir, &marker);
                }
                dir
            }
            None => {
                // Not on this Mac as a share. Its item may be here all the
                // same, where the section it sits in had it: then that
                // folder is it, and its files stay where they are.
                let here = agreed
                    .as_ref()
                    .and_then(|a| Some((a, a.was.as_ref()?)))
                    .and_then(|(a, was)| Some(self.units.get(&a.parent)?.root.join(was)))
                    .filter(|dir| space::is_real_dir(dir) && space::read_space_marker(dir).is_none() && dir.parent() == Some(home.as_path()));
                let dir = match here {
                    Some(dir) => {
                        marker.name = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                        dir
                    }
                    None => free(&home, None),
                };
                if std::fs::create_dir_all(&dir).is_err() || space::write_space_marker(&dir, &marker).is_err() {
                    return None;
                }
                // A folder taken for it is asked again what it is called.
                if marker.name != entry.name {
                    self.units.remove(&entry.id);
                } else if let Some(unit) = self.units.get_mut(&entry.id) {
                    // Its folder was lost: it comes back whole.
                    unit.forget_synced();
                } else {
                    let _ = std::fs::remove_dir_all(Self::space_state_dir(&self.cfg, &entry.id));
                }
                dir
            }
        };
        let rel = space::spelled(&root, &dir);
        let name = renamed.clone().unwrap_or_else(|| entry.name.clone());
        match self.units.get_mut(&entry.id) {
            Some(unit) => {
                unit.root = dir;
                unit.prefix = rel;
                unit.name = name;
                unit.gone = false;
            }
            None => {
                let unit = Self::folder_unit(&self.cfg, &self.remote, &entry.id, &name, dir, rel);
                self.units.insert(entry.id.clone(), unit);
            }
        }
        renamed
    }

    /// A shared document: where this Mac has it, moved to the folder it
    /// sits in, adopted where its item already is, or given a place to be
    /// downloaded to. What it is called follows its manifest, in the cycle
    /// (`follow_document_rename`).
    fn place_document(&mut self, entry: &SpaceEntry) {
        let root = self.cfg.root.clone();
        let owner = self.owner_name(entry);
        let (home, agreed) = self.home_of(entry);
        let said = agreed.as_ref().map(|a| a.said.clone());
        if let Some(unit) = self.units.get(&entry.id) {
            let Some(name) = unit.reach.only.clone() else { return };
            let around = unit.root.clone();
            let here = agreed.as_ref().and_then(|a| self.dir_in(&a.parent, &around));
            let in_place = match (&agreed, &here) {
                (Some(a), Some(here)) => here.eq_ignore_ascii_case(&a.dir),
                (None, _) => around == home,
                _ => false,
            };
            if !in_place && std::fs::create_dir_all(&home).is_ok() {
                // It sits in another folder now: its files go there, under
                // the first of its names that is free.
                let local = space::free_name(&name.stored, &owner, |cand| space::name_taken(&home, cand, true));
                for file in space::document_files(&around, &name.local) {
                    let ext = file.file_name().map(|n| split_name(&n.to_string_lossy()).1.to_string()).unwrap_or_default();
                    let _ = std::fs::rename(&file, home.join(format!("{}{}", local, ext)));
                }
                let prefix = space::spelled(&root, &home);
                if let Some(unit) = self.units.get_mut(&entry.id) {
                    unit.root = home;
                    unit.prefix = prefix;
                    unit.reach.only = Some(DocName { local, stored: name.stored });
                }
            }
            if let Some(unit) = self.units.get_mut(&entry.id) {
                unit.gone = false;
            }
            self.note_document(&entry.id, said.as_deref());
            return;
        }
        // Not on this Mac as a share. Its item may be here all the same,
        // where the section it sits in had it: then those files are it.
        let here = agreed
            .as_ref()
            .and_then(|a| Some((a, a.was.as_ref()?)))
            .and_then(|(a, was)| {
                let at = self.units.get(&a.parent)?.root.join(was);
                let stem = at.file_name()?.to_string_lossy().to_string();
                let dir = at.parent()?.to_path_buf();
                (dir == home && !space::document_files(&dir, &stem).is_empty()).then_some(stem)
            })
            .filter(|stem| !self.units.values().any(|u| u.root == home && u.reach.only.as_ref().is_some_and(|n| n.local.eq_ignore_ascii_case(stem))));
        let name = match here {
            Some(stem) => DocName { local: stem.clone(), stored: stem },
            None => {
                if std::fs::create_dir_all(&home).is_err() {
                    return;
                }
                DocName { local: space::free_name(&entry.name, &owner, |cand| space::name_taken(&home, cand, true)), stored: entry.name.clone() }
            }
        };
        let _ = std::fs::remove_dir_all(Self::space_state_dir(&self.cfg, &entry.id));
        let place = DocPlace { dir: space::spelled(&root, &home), local: name.local, stored: name.stored, at: said.clone().unwrap_or_default() };
        let unit = Self::document_unit(&self.cfg, &self.remote, &entry.id, &place);
        self.units.insert(entry.id.clone(), unit);
        self.note_document(&entry.id, said.as_deref());
    }

    /// A shared document renamed on another device: its manifest names its
    /// files differently from the one this Mac last applied. Its files here
    /// take the new name before the cycle looks for them.
    fn follow_document_rename(&mut self, unit: &mut Unit<R>) {
        let Some(name) = unit.reach.only.clone() else { return };
        let Some(now) = unit.document_name() else { return };
        let applied = unit.state.manifest.files.values().find(|f| !crate::sidecar::is_sidecar(&f.path)).map(|f| split_name(&f.path).0.to_string());
        if now == name.stored || applied.as_deref() == Some(now.as_str()) {
            return;
        }
        let owner = self.spaces.iter().flatten().find(|s| s.id == unit.id).map(|s| self.owner_name(s)).unwrap_or_default();
        // A name this Mac gave it stays; one it wore for its old name changes with it.
        let local = if space::names_item(&name.local, &name.stored, &owner) {
            space::free_name(&now, &owner, |cand| !cand.eq_ignore_ascii_case(&name.local) && space::name_taken(&unit.root, cand, true))
        } else {
            name.local.clone()
        };
        let was = Self::item_at(unit);
        unit.follow_document_name(&now, &local);
        // The unit is out of the table while it cycles: told from here.
        let moves: Vec<serde_json::Value> = space::document_files(&unit.root, &local)
            .into_iter()
            .filter_map(|file| {
                let ext = split_name(&file.file_name()?.to_string_lossy()).1.to_string();
                Some(json!({
                    "from": format!("{}/{}{}", was.0, was.1.as_deref().unwrap_or_default(), ext),
                    "to": format!("{}/{}{}", unit.prefix, local, ext),
                    "dir": false,
                }))
            })
            .collect();
        if !moves.is_empty() && was.1.as_deref() != Some(local.as_str()) {
            self.events.emit_json(EV_SPACE_MOVED, json!({ "root": self.root_key(), "moves": moves }));
        }
        let place = DocPlace { dir: unit.prefix.clone(), local, stored: now, at: String::new() };
        let path = Self::space_state_dir(&self.cfg, &unit.id).join(DOC_FILE);
        let at = read_json::<DocPlace>(&path).map(|was| was.at).unwrap_or_default();
        let _ = write_json(&path, &DocPlace { at, ..place });
    }

    /// A shared document with a file that is not where this Mac had it, and
    /// that the app did not say it deleted: moved, renamed or deleted by
    /// hand. Followed by its content when the same bytes are now a file of
    /// the section it sits in — its other files go with it. Otherwise the
    /// document comes back whole, and whatever was moved or renamed is a
    /// note of this person's own: by hand, nothing shared is ever deleted.
    fn follow_documents(&mut self) {
        let astray: Vec<(String, Vec<FileState>)> = self
            .units
            .values()
            .filter(|u| u.is_document() && !u.gone && !self.ending.contains(&u.id))
            .filter_map(|u| {
                let said = |path: &str| self.touched.iter().any(|p| u.in_unit(p).as_deref() == Some(path));
                // A file this unit is about to say was renamed is where its new name is.
                let now = |path: &str| u.renamed.iter().find(|(from, _)| from == path).map(|(_, to)| to.clone()).unwrap_or_else(|| path.to_string());
                let missing: Vec<FileState> = u
                    .state
                    .files
                    .values()
                    .filter(|st| !crate::sidecar::is_sidecar(&st.path))
                    .filter(|st| std::fs::symlink_metadata(u.abs(&now(&st.path))).is_err() && !said(&st.path))
                    .cloned()
                    .collect();
                (!missing.is_empty()).then(|| (u.id.clone(), missing))
            })
            .collect();
        for (id, missing) in astray {
            let parent = self.spaces.iter().flatten().find(|s| s.id == id).and_then(|e| e.parent.clone());
            // By its content, among the files of the section it sits in that
            // no section has synced.
            let found = parent.as_ref().and_then(|p| self.units.get(p)).and_then(|around| {
                let survey = around.survey();
                missing.iter().find_map(|lost| {
                    let ext = split_name(&lost.path).1.to_string();
                    survey
                        .news
                        .iter()
                        .find(|(path, hash)| *hash == lost.hash && split_name(path).1.eq_ignore_ascii_case(&ext))
                        .map(|(path, _)| around.abs(path))
                })
            });
            match found {
                Some(file) => self.claim_document(&id, &file),
                None => {
                    if let Some(unit) = self.units.get_mut(&id) {
                        unit.forget_synced();
                    }
                }
            }
        }
    }

    /// The shared document `id` is the file at `file` now: this person moved
    /// or renamed it, inside the section it sits in. Its other files go with
    /// it, the section is told where it sits, and a new name is its name.
    fn claim_document(&mut self, id: &str, file: &Path) {
        let (Some(dir), Some(file_name)) = (file.parent(), file.file_name().map(|n| n.to_string_lossy().to_string())) else { return };
        let local = split_name(&file_name).0.to_string();
        let Some(unit) = self.units.get(id) else { return };
        let Some(was) = unit.reach.only.clone() else { return };
        let old_root = unit.root.clone();
        let item_was = Self::item_at(unit);
        // Its html and its comments, still where they were.
        for other in space::document_files(&old_root, &was.local) {
            let ext = other.file_name().map(|n| split_name(&n.to_string_lossy()).1.to_string()).unwrap_or_default();
            let to = dir.join(format!("{}{}", local, ext));
            if std::fs::symlink_metadata(&to).is_err() {
                let _ = std::fs::rename(&other, &to);
            }
        }
        let entry = self.spaces.iter().flatten().find(|s| s.id == id).cloned();
        let owner = entry.as_ref().map(|e| self.owner_name(e)).unwrap_or_default();
        let here = entry.as_ref().and_then(|e| e.parent.clone()).and_then(|p| Some((p.clone(), self.dir_in(&p, dir)?)));
        let prefix = space::spelled(&self.cfg.root, dir);
        // A name this Mac would not have given it is one a person typed.
        let stored = if space::names_item(&local, &was.stored, &owner) || !space::valid_item_name(&local) {
            was.stored.clone()
        } else {
            local.clone()
        };
        if let Some(unit) = self.units.get_mut(id) {
            unit.root = dir.to_path_buf();
            unit.prefix = prefix;
            if stored != was.stored {
                let files: Vec<String> = unit.state.files.values().map(|st| st.path.clone()).collect();
                unit.renamed.extend(files.into_iter().map(|path| {
                    let to = format!("{}{}", stored, split_name(&path).1);
                    (path, to)
                }));
            }
            unit.reach.only = Some(DocName { local, stored });
            unit.poke = true;
        }
        if let Some((parent, here)) = here {
            if let Some(around) = self.units.get_mut(&parent) {
                around.queue_mount(id, &here);
                around.poke = true;
            }
            self.note_document(id, Some(&here));
        } else {
            self.note_document(id, None);
        }
        self.set_reaches();
        self.tell_moved(id, &item_was);
    }

    /* ----- what the app said it moved ----- */

    /// What the app said it moved from one section to another, each end as
    /// its unit spells it: what `pair_moves` reads as the same files.
    fn said_between(&self) -> Vec<SaidAcross> {
        self.app_moves
            .iter()
            .filter_map(|(from, to)| {
                // Where it was is asked of the units as they were told: the
                // section whose state still has a file at or under it.
                let left = self.units.values().find_map(|unit| {
                    let rel = unit.in_unit(from)?;
                    unit.state.files.values().any(|st| rebased(&st.path, &rel, &rel).is_some()).then(|| (unit.id.clone(), rel))
                })?;
                let arrived = self.place(to)?;
                (left.0 != arrived.0).then(|| SaidAcross { from: left.0, from_path: left.1, to: arrived.0, to_path: arrived.1 })
            })
            .collect()
    }

    /// The app renamed or moved something. A share's item is still that
    /// share wherever it went: its section is told where it sits now, or —
    /// moved into another section — it sits in that one from now on; moved
    /// into Library, it is everyone's and the share ends. The app asked the
    /// person first where that changes who can open it.
    async fn heed_moves(&mut self) {
        let said: Vec<(String, String)> = self.app_moves.clone();
        for (from, to) in said {
            // Shares whose item is what moved, or inside the folder that did.
            let inside: Vec<(String, String)> = self
                .units
                .values()
                .filter(|u| !u.is_library() && u.kind() != SpaceKind::Private && !self.ending.contains(&u.id))
                .filter_map(|u| match &u.reach.only {
                    // A document: one of its own files was renamed, or the folder it is in.
                    Some(name) => {
                        let stem = format!("{}/{}", u.prefix, name.local);
                        let (dir, file) = from.rsplit_once('/')?;
                        let own = dir.eq_ignore_ascii_case(&u.prefix) && space::of_document(file, &name.local);
                        let now = if own { to.clone() } else { rebased(&stem, &from, &to)? };
                        Some((u.id.clone(), now))
                    }
                    None => rebased(&u.prefix, &from, &to).map(|now| (u.id.clone(), now)),
                })
                .collect();
            for (id, now) in inside {
                self.moved_share(&id, &now).await;
            }
        }
    }

    /// The item of the share `id` is at `now` (workspace-relative: a folder,
    /// or one of a document's files) — the app put it there.
    async fn moved_share(&mut self, id: &str, now: &str) {
        let abs = self.cfg.root.join(now);
        let Some(unit) = self.units.get(id) else { return };
        let document = unit.is_document();
        let (was_root, was_name) = (unit.root.clone(), unit.reach.only.clone());
        // It is there: a document's file, or the folder that says it is this share.
        let there = if document { abs.is_file() } else { space::read_space_marker(&abs).is_some_and(|m| m.space == id) };
        let Some(around) = abs.parent().map(Path::to_path_buf).filter(|_| there) else { return };
        let Some(entry) = self.spaces.iter().flatten().find(|s| s.id == id).cloned() else { return };
        let section = self.section_of_dir(&around).map(|u| (u.id.clone(), rel_path(&u.root, &around).unwrap_or_default()));
        match (entry.parent.as_deref(), section) {
            // Inside the section it sits in: that section says where from now on.
            (Some(parent), Some((at, dir))) if at == parent => self.settle_share(id, &abs, &at, &dir),
            // Into Library: it is everyone's now, and no share. Its unit
            // stays where the item was, which is where its files are read
            // as having left from.
            (Some(_), Some((at, _))) if at == LIBRARY => {
                if !document {
                    space::remove_space_marker(&abs);
                }
                let _ = std::fs::write(Self::space_state_dir(&self.cfg, id).join(ENDING_FILE), b"");
                self.ending.insert(id.to_string());
                if let Some(unit) = self.units.get_mut(id) {
                    unit.poke = true;
                }
                self.set_reaches();
            }
            // Into another folder of this person's, or another shared
            // folder: it sits there from now on, and that folder's people
            // open it.
            (Some(_), Some((at, dir))) => match self.remote.move_space(id, &at, &dir).await {
                Ok(moved) => {
                    if let Some(listed) = self.spaces.iter_mut().flatten().find(|s| s.id == id) {
                        *listed = moved;
                    }
                    self.settle_share(id, &abs, &at, &dir);
                }
                // Refused, or unreachable: it sits where it sat, so it goes
                // back there — and what the app has open from it follows.
                Err(_) => {
                    let spelled = |path: &Path| rel_path(&self.cfg.root, path).unwrap_or_default();
                    let mut back: Vec<serde_json::Value> = Vec::new();
                    match &was_name {
                        Some(name) => {
                            let stem = abs.file_name().map(|n| split_name(&n.to_string_lossy()).0.to_string()).unwrap_or_default();
                            for file in space::document_files(&around, &stem) {
                                let ext = file.file_name().map(|n| split_name(&n.to_string_lossy()).1.to_string()).unwrap_or_default();
                                let to = was_root.join(format!("{}{}", name.local, ext));
                                if std::fs::symlink_metadata(&to).is_err() && std::fs::rename(&file, &to).is_ok() {
                                    back.push(json!({ "from": spelled(&file), "to": spelled(&to), "dir": false }));
                                }
                            }
                        }
                        None => {
                            if std::fs::symlink_metadata(&was_root).is_err() && std::fs::rename(&abs, &was_root).is_ok() {
                                back.push(json!({ "from": spelled(&abs), "to": spelled(&was_root), "dir": true }));
                            }
                        }
                    }
                    if !back.is_empty() {
                        self.events.emit_json(EV_SPACE_MOVED, json!({ "root": self.root_key(), "moves": back }));
                    }
                }
            },
            // Pinned under Shared with me, a document renamed where it is
            // has a new name for everyone. Anything else — moved somewhere
            // that is no section, or by somebody who cannot place it — comes
            // back at the next look at the folders.
            (None, _) if document && around == was_root => self.claim_document(id, &abs),
            _ => {}
        }
    }

    /// The item of the share `id` is at `abs`, in the folder `dir` of the
    /// section `at` it sits in: its unit is there, and that section is told.
    fn settle_share(&mut self, id: &str, abs: &Path, at: &str, dir: &str) {
        if self.units.get(id).is_some_and(|u| u.is_document()) {
            self.claim_document(id, abs);
            return;
        }
        let prefix = space::spelled(&self.cfg.root, abs);
        if let Some(unit) = self.units.get_mut(id) {
            unit.root = abs.to_path_buf();
            unit.prefix = prefix;
        }
        if let Some(mut marker) = space::read_space_marker(abs).filter(|m| m.dir != dir) {
            marker.dir = dir.to_string();
            let _ = space::write_space_marker(abs, &marker);
        }
        if let Some(parent) = self.units.get_mut(at) {
            parent.queue_mount(id, dir);
            parent.poke = true;
        }
        self.set_reaches();
    }

    /// A share that is ending has handed every file to Library: it is erased
    /// on the domain, and forgotten here.
    async fn end_shares(&mut self) {
        let done: Vec<String> = self
            .ending
            .iter()
            .filter(|id| self.units.get(*id).is_none_or(|u| u.state.files.is_empty() && u.held_deletes.is_empty()))
            .cloned()
            .collect();
        for id in done {
            loop {
                match self.remote.delete_space(&id).await {
                    Ok(round) if round.remaining => continue,
                    // Kept: something landed in it meanwhile. It is a share
                    // still, deleted — its people's to restore.
                    Ok(_) | Err(RemoteError::NotFound) => break,
                    Err(_) => return, // tried again after the next pass
                }
            }
            self.units.remove(&id);
            self.ending.remove(&id);
            let _ = std::fs::remove_dir_all(Self::space_state_dir(&self.cfg, &id));
            if let Some(list) = &mut self.spaces {
                list.retain(|s| s.id != id);
            }
            self.set_reaches();
            if let Some(tell) = &self.cfg.on_spaces {
                tell(SpacesChanged { removed: vec![id] });
            }
        }
    }

    /// `Library/` is gone from this device — deleted, or renamed in Finder,
    /// which leaves it at the top in no section. Like a share's missing
    /// folder (`reconcile_spaces`), it is a section to bring back whole, never
    /// a folder whose every file was deleted: what Library's unit had synced
    /// is forgotten, and its next cycle downloads everything into a new one.
    /// False when the folder cannot be made — a file has its name — and then
    /// nothing is forgotten.
    fn mend_library(&mut self) -> bool {
        if std::fs::create_dir_all(self.cfg.root.join(LIBRARY_DIR)).is_err() {
            return false;
        }
        let _ = std::fs::remove_file(self.cfg.state_dir.join("state.json"));
        let _ = std::fs::remove_dir_all(self.cfg.state_dir.join("base"));
        self.units.insert(LIBRARY.to_string(), Self::library_unit(&self.cfg, &self.remote));
        self.set_reaches();
        true
    }

    /* ----- sharing, by hand ----- */

    /// A failed call about a share, in a sentence.
    fn describe_space(&self, e: RemoteError) -> String {
        match e {
            RemoteError::NotFound => "That is not there any more, or it is no longer shared with you.".to_string(),
            RemoteError::Forbidden => {
                "This is shared with you: only the people of the folder it sits in can move or delete it. You can leave it instead.".to_string()
            }
            other => super::flows::describe(&self.cfg.domain, other.into()),
        }
    }

    /// Why a command that needs the domain's word cannot run yet.
    fn not_caught_up(&self) -> String {
        format!("This {} has not caught up with the workspace yet — try again in a moment.", self.cfg.device_kind)
    }

    fn pending_share_path(&self) -> PathBuf {
        self.cfg.state_dir.join(PENDING_SHARE_FILE)
    }

    /// Ask the domain for the share this device wrote down it was making.
    /// The same id from its maker again is the same share, so asking twice
    /// makes one. None when nothing was pending, or the domain cannot be
    /// asked yet — then it stays written down.
    async fn finish_pending_share(&mut self) -> Option<SpaceEntry> {
        let pending: PendingShare = read_json(&self.pending_share_path())?;
        let made = self.post_share(&pending).await;
        match made {
            Ok(entry) => {
                let _ = std::fs::remove_file(self.pending_share_path());
                Some(entry)
            }
            Err(RemoteError::Offline(_) | RemoteError::Slowed(_) | RemoteError::DailyLimit) => None,
            // Refused: the item is not there to share any more, or not this
            // person's to. Nothing was made, and nothing is owed.
            Err(_) => {
                let _ = std::fs::remove_file(self.pending_share_path());
                None
            }
        }
    }

    /// `POST /api/spaces`, minting another id when the one written down
    /// turns out to be somebody else's.
    async fn post_share(&mut self, pending: &PendingShare) -> RemoteResult<SpaceEntry> {
        let mut ask = NewShare {
            id: pending.id.clone(),
            kind: pending.kind,
            name: pending.name.clone(),
            parent: pending.parent.clone(),
            dir: pending.dir.clone(),
            was: pending.was.clone(),
            members: pending.members.clone(),
        };
        for _ in 0..3 {
            match self.remote.create_space(&ask).await {
                Err(RemoteError::IdTaken) => {
                    ask.id = share_id();
                    let _ = write_json(&self.pending_share_path(), &PendingShare { id: ask.id.clone(), ..pending.clone() });
                }
                other => return other,
            }
        }
        Err(RemoteError::IdTaken)
    }

    /// Share the folder or the document at `path` with `members`. It stays
    /// where it is: it becomes a section of its own in place, whose files
    /// leave the section around it as a move — so they are untouched on the
    /// devices of everyone who could open them already, and arrive on those
    /// of the people it is now shared with. What is shared from inside a
    /// folder that is shared stays its own share, and sits in the new one.
    /// Something shared already gets those people as well.
    pub(crate) async fn share(&mut self, path: &Path, members: &[String]) -> Result<SpaceStatus, String> {
        // The list of what this person can open is what decides which
        // folders stay here: a share is only added to one the domain gave.
        if self.spaces.is_none() {
            return Err(self.not_caught_up());
        }
        let root = self.cfg.root.clone();
        let not_shareable = || "Only a folder or a document in My files, or in a folder shared with you, can be shared. Nothing in Library is shared separately: it is everyone's.".to_string();
        let folder = space::is_real_dir(path);
        let Some(ws_rel) = rel_path(&root, path) else { return Err(not_shareable()) };
        if !folder && !crate::is_document(&ws_rel) {
            return Err("Only a folder, or a markdown or html document, can be shared.".to_string());
        }
        self.set_reaches();
        let Some((at, rel)) = self.place(&ws_rel) else { return Err(not_shareable()) };
        let around = self.units.get(&at).ok_or_else(not_shareable)?;
        // Shared already: its people grow.
        let own_item = if folder { rel.is_empty() && around.kind() == SpaceKind::Folder } else { around.is_document() };
        if own_item {
            for member in members {
                self.change_share_member(&at, member, true).await?;
            }
            return self.status_of(&at).ok_or_else(|| self.not_caught_up());
        }
        if at == LIBRARY || rel.is_empty() || around.is_document() {
            return Err(not_shareable());
        }
        let (name, was) = if folder {
            (rel.rsplit('/').next().unwrap_or(&rel).to_string(), rel.clone())
        } else {
            let (dir, file) = rel.rsplit_once('/').map(|(d, f)| (format!("{}/", d), f)).unwrap_or((String::new(), rel.as_str()));
            let stem = split_name(file).0.to_string();
            (stem.clone(), format!("{}{}", dir, stem))
        };
        if !space::valid_item_name(&name) {
            return Err("That name can't be shared: it starts with a dot or a space, or holds a slash or a colon. Rename it first.".to_string());
        }
        let dir = was.rsplit_once('/').map(|(dir, _)| dir.to_string()).unwrap_or_default();
        let pending = PendingShare {
            id: share_id(),
            kind: if folder { SpaceKind::Folder } else { SpaceKind::Document },
            name,
            parent: at.clone(),
            dir,
            was,
            members: members.to_vec(),
        };
        let _ = write_json(&self.pending_share_path(), &pending);
        let made = self.post_share(&pending).await.map_err(|e| {
            let _ = std::fs::remove_file(self.pending_share_path());
            self.describe_space(e)
        })?;
        let _ = std::fs::remove_file(self.pending_share_path());
        let id = made.id.clone();

        // The section around it wrote where the share sits: read that again
        // before anything is placed by it.
        if let Some(parent) = self.units.get_mut(&at) {
            let _ = parent.fetch().await;
            parent.poke = true;
        }
        // What was shared from inside the folder sits in the new share now.
        let inside: Vec<(String, String)> = if folder {
            self.units
                .values()
                .filter(|u| !u.is_library() && u.id != at && u.root.starts_with(path) && self.spaces.iter().flatten().any(|s| s.id == u.id && s.parent.as_deref() == Some(at.as_str())))
                .filter_map(|u| {
                    let dir = if u.is_document() { u.root.clone() } else { u.root.parent()?.to_path_buf() };
                    Some((u.id.clone(), rel_path(path, &dir)?))
                })
                .collect()
        } else {
            Vec::new()
        };
        self.spaces.get_or_insert_with(Vec::new).retain(|s| s.id != id);
        self.spaces.get_or_insert_with(Vec::new).push(made);
        self.reconcile_spaces().await;
        for (child, dir) in inside {
            if let Ok(moved) = self.remote.move_space(&child, &id, &dir).await {
                if let Some(listed) = self.spaces.iter_mut().flatten().find(|s| s.id == child) {
                    *listed = moved;
                }
            }
        }
        self.refresh_status();
        self.status_of(&id).ok_or_else(|| "It is shared, and will show as shared in a moment.".to_string())
    }

    fn status_of(&self, id: &str) -> Option<SpaceStatus> {
        self.space_statuses().into_iter().find(|space| space.id == id)
    }

    /// Share something with one more person, or stop. Stopping with this
    /// person is leaving it: its copy leaves this Mac with them.
    pub(crate) async fn change_share_member(&mut self, id: &str, member: &str, add: bool) -> Result<(), String> {
        if add {
            let now = self.remote.add_space_member(id, member).await.map_err(|e| match e {
                RemoteError::NotFound => "That person is not in this workspace any more, or what you are sharing is gone.".to_string(),
                other => self.describe_space(other),
            })?;
            if let Some(entry) = self.spaces.iter_mut().flatten().find(|s| s.id == id) {
                *entry = now;
            }
        } else {
            self.remote.remove_space_member(id, member).await.map_err(|e| self.describe_space(e))?;
            let mine = self.me.as_deref() == Some(member);
            let through = self.spaces.iter().flatten().any(|s| s.id == id && s.parent.is_some());
            if mine && !through {
                self.forget_space(id).await;
            } else if let Some(entry) = self.spaces.iter_mut().flatten().find(|s| s.id == id) {
                entry.members.retain(|m| m != member);
            }
        }
        self.refresh_status();
        Ok(())
    }

    /// Delete something shared, for everyone it is shared with. The domain
    /// keeps it thirty days, and whoever can open the folder it sat in can
    /// restore it; here it goes to the Trash, like anything this person
    /// deletes. Each other device deletes its copy when its next poll no
    /// longer lists it.
    pub(crate) async fn delete_share(&mut self, id: &str) -> Result<(), String> {
        let entry = self.spaces.iter().flatten().find(|s| s.id == id).cloned();
        if entry.as_ref().is_some_and(|s| s.parent.is_none()) {
            return Err(self.describe_space(RemoteError::Forbidden));
        }
        let kept = loop {
            let round = self.remote.delete_space(id).await.map_err(|e| self.describe_space(e))?;
            if !round.remaining {
                break round.kept;
            }
        };
        let mut changed = SpacesChanged::default();
        // What is shared from inside it went with it.
        let inside: Vec<String> = self
            .units
            .values()
            .filter(|u| self.units.get(id).is_some_and(|gone| !gone.is_document() && u.id != id && u.root.starts_with(&gone.root)))
            .map(|u| u.id.clone())
            .collect();
        for child in &inside {
            if let Some(unit) = self.units.remove(child) {
                drop(unit);
                let _ = std::fs::remove_dir_all(Self::space_state_dir(&self.cfg, child));
                changed.removed.push(child.clone());
            }
        }
        self.drop_unit(id, Leaving::Trash, &mut changed);
        if let Some(list) = &mut self.spaces {
            list.retain(|s| !inside.contains(&s.id) && (kept || s.id != id));
            if let Some(entry) = list.iter_mut().find(|s| s.id == id) {
                entry.deleted_at = Some(now_ms());
            }
        }
        self.set_reaches();
        if let Some(tell) = &self.cfg.on_spaces {
            tell(changed);
        }
        self.refresh_status();
        Ok(())
    }

    /// Bring a deleted share back: its files, its people, its history and
    /// its pages are as they were, and it is downloaded where it sat.
    pub(crate) async fn restore_share(&mut self, id: &str) -> Result<(), String> {
        let back = self.remote.restore_space(id).await.map_err(|e| match e {
            RemoteError::NotFound => "That can't be restored any more: its thirty days are up, or it was restored already.".to_string(),
            other => self.describe_space(other),
        })?;
        let list = self.spaces.get_or_insert_with(Vec::new);
        list.retain(|s| s.id != id);
        list.push(back);
        // What was deleted with it is listed again by the next poll.
        self.reconcile_spaces().await;
        self.refresh_status();
        Ok(())
    }

    /// This person is off a share, by something done on this Mac: the list
    /// says so now rather than at the next poll, and its copy goes.
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
        if self.paused || self.waiting_on_update() || self.limited.is_some() {
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
                .any(|unit| !unit.is_library() && unit.effective_public().contains_key(wanted));
            if elsewhere && !self.library().effective_public().contains_key(wanted) {
                return Err("The home page is chosen from Library.".into());
            }
        }
        let Some(shared) = self.units.get_mut(LIBRARY) else { return Err("that workspace isn't connected".into()) };
        shared.queue_set_root(slug)?;
        shared.poke = true;
        self.refresh_status();
        Ok(())
    }

    /* ----- the tag list: queued changes ----- */

    /// Queue a change of the workspace's tag list, which the shared
    /// workspace's manifest holds.
    pub(crate) fn queue_tag(&mut self, op: TagOp) -> Result<(), String> {
        let Some(shared) = self.units.get_mut(LIBRARY) else { return Err("that workspace isn't connected".into()) };
        shared.queue_tag(op)?;
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
    /// Never quicker than a minute in slow mode. A browser paces itself by
    /// the same numbers (`gap`, src/web/workspace.ts): change both.
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

    /// The app moved `from` to `to` (workspace-relative): a tip for the next
    /// pass that goes through.
    pub(crate) fn app_moved(&mut self, from: String, to: String) {
        self.app_moves.push((from, to));
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
    /// say who holds what: then there is no lock to claim. A browser claims
    /// by the same rule (`claimOwed`, src/web/workspace.ts): change both.
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
            .is_some_and(|all| !all.iter().any(|l| l.path == key && l.space.as_deref().unwrap_or(LIBRARY) == id))
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
        // A file is waiting to hear whether its new section is this
        // person's: only a poll says.
        if !self.asked_about.is_empty() && !self.waiting_on_update() && !self.paused {
            return Instant::now();
        }
        let clock = Instant::now() + self.poll_gap();
        if !self.waiting_on_update() && !self.paused {
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

    /// Where this engine last said each of its sections is.
    #[cfg(test)]
    pub(crate) fn sections_for_test(&self) -> Vec<SectionAt> {
        self.cfg.sections.lock().unwrap().get(&self.root_key()).cloned().unwrap_or_default()
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
                Some((id, rel)) => ((id != LIBRARY).then_some(id), Some(rel)),
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
            // A file that was moved to a section this device held no unit of
            // has waited for this: the list says whether the section is this
            // person's — then it has a unit now — or not, and the file goes.
            let open: HashSet<&str> = spaces.iter().filter(|s| !s.deleted()).map(|s| s.id.as_str()).collect();
            self.absent.retain(|id| !open.contains(id.as_str()));
            let asked = std::mem::take(&mut self.asked_about);
            if !asked.is_empty() {
                self.absent.extend(asked.into_iter().filter(|id| !open.contains(id.as_str())));
                for unit in self.units.values_mut().filter(|u| !u.deferred.is_empty()) {
                    unit.poke = true;
                }
            }
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
        if Some(poll.manifest_etag.as_str()) != self.library().state.manifest_etag.as_deref() {
            moved.insert(LIBRARY.to_string());
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
        if !moved.is_empty() || self.phase == Phase::Offline || self.units.values().any(|u| u.poke) {
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
        if self.paused || self.waiting_on_update() {
            return Vec::new();
        }
        let Some(leases) = &self.leases else { return Vec::new() };
        leases
            .iter()
            .filter(|l| l.device_id != self.cfg.device_id)
            .filter_map(|l| {
                let unit = self.units.get(l.space.as_deref().unwrap_or(LIBRARY))?;
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
                l.path == key && l.space.as_deref().unwrap_or(LIBRARY) == id && l.device_id == self.cfg.device_id
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
                    self.units.get(e.space.as_deref().unwrap_or(LIBRARY)).map(|unit| unit.ws_rel(path))
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
                        let was_waiting = self.waiting_on_update();
                        self.probe_worker().await;
                        if was_waiting && !self.waiting_on_update() {
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
                    // The app touches both ends as well, which is what brings
                    // the pass.
                    Some(EngineCmd::Moved { from, to }) => self.app_moved(from, to),
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
                    Some(EngineCmd::Tag { op, reply }) => {
                        let _ = reply.send(self.queue_tag(op));
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
                    Some(EngineCmd::Share { path, members, reply }) => {
                        let made = self.share(Path::new(&path), &members).await;
                        // What was shared leaves the section around it:
                        // that is a pass's to carry.
                        cycle_now = made.is_ok();
                        let _ = reply.send(made);
                    }
                    Some(EngineCmd::ShareMember { id, member, add, reply }) => {
                        let _ = reply.send(self.change_share_member(&id, &member, add).await);
                    }
                    Some(EngineCmd::DeleteShare { id, reply }) => {
                        let _ = reply.send(self.delete_share(&id).await);
                    }
                    Some(EngineCmd::RestoreShare { id, reply }) => {
                        let restored = self.restore_share(&id).await;
                        cycle_now = restored.is_ok();
                        let _ = reply.send(restored);
                    }
                    Some(EngineCmd::LinkTo { rel, reply }) => {
                        let linked = if !crate::is_document(&rel) {
                            Err("only a markdown or html document has a link".to_string())
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
                    Some(EngineCmd::Documents { reply }) => {
                        let _ = reply.send(Ok(self.documents()));
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
                    // Waiting on an update, or for the domain to say
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

/// The folder a new document is counted under, for the valve's question:
/// at most two levels below its section's folder, `""` for one directly in
/// it.
fn counted_under(path: &str) -> String {
    let dirs: Vec<&str> = path.split('/').collect();
    let dirs = &dirs[..dirs.len().saturating_sub(1)];
    dirs[..dirs.len().min(2)].join("/")
}

/// The folders with the most new documents (`counted_under`, made
/// workspace-relative), the most first — five at most.
fn folders_of(folders: &[String]) -> Vec<(String, u32)> {
    let mut counts: BTreeMap<String, u32> = BTreeMap::new();
    for folder in folders {
        *counts.entry(folder.clone()).or_default() += 1;
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

/// Something the app said it moved from one unit to another, each end as
/// its own unit spells it: a file, or a folder.
struct SaidAcross {
    from: String,
    from_path: String,
    to: String,
    to_path: String,
}

/// A path at or under `at`, as it is once `at` is `now`.
fn rebased(path: &str, at: &str, now: &str) -> Option<String> {
    if path.eq_ignore_ascii_case(at) {
        return Some(now.to_string());
    }
    let head = path.get(..at.len()).filter(|head| head.eq_ignore_ascii_case(at))?;
    path[head.len()..].strip_prefix('/').map(|rest| format!("{}/{}", now, rest))
}

/// Pair each file that vanished from one unit with the same file appearing
/// in another. That is a move between sections — made in the sidebar, in
/// Finder, by sharing the folder it is in — and not a deletion and a new
/// file. What the app said it moved is that file whatever its content now;
/// anything else is paired by the same content and the same name.
fn pair_moves(surveys: &BTreeMap<String, Survey>, said: &[SaidAcross]) -> Vec<CrossMove> {
    let mut moves = Vec::new();
    let mut taken: HashSet<(&str, &str)> = HashSet::new();
    let mut paired: HashSet<(&str, &str)> = HashSet::new();
    for word in said {
        let (Some(left), Some(arrived)) = (surveys.get(&word.from), surveys.get_key_value(&word.to)) else { continue };
        for (fid, _, path) in &left.vanished {
            let Some(now) = rebased(path, &word.from_path, &word.to_path) else { continue };
            let Some((new_path, new_hash)) = arrived.1.news.iter().find(|(p, _)| p.eq_ignore_ascii_case(&now)) else { continue };
            if !taken.insert((arrived.0.as_str(), new_path.as_str())) {
                continue;
            }
            paired.insert((word.from.as_str(), fid.as_str()));
            moves.push(CrossMove {
                from: word.from.clone(),
                fid: fid.clone(),
                to: word.to.clone(),
                path: new_path.clone(),
                hash: new_hash.clone(),
            });
        }
    }
    for (from, survey) in surveys {
        for (fid, hash, path) in &survey.vanished {
            if paired.contains(&(from.as_str(), fid.as_str())) {
                continue;
            }
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
    /// It is where its new section has it already: sharing a folder or a
    /// document moves nothing on disk.
    Kept,
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
/// The file as `dest` holds it is the one with its id `fid`, which a move
/// keeps; failing that, it is found by name and content. An untouched
/// copy takes its place, to be adopted by its hash with nothing downloaded.
/// A copy edited here since carries on as an edit of the moved file when it
/// was edited from exactly what `dest` holds; anything else lands beside it,
/// so no edit is lost and none is pushed over somebody's work.
fn receive<R: Remote>(
    dest: &mut Unit<R>,
    fid: &str,
    from: &Path,
    bytes: &[u8],
    synced: &str,
    base: Option<&[u8]>,
    who: &str,
) -> Received {
    let name = from.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let now = hash16(bytes);
    let clean = now == synced;
    let rel_of = |dest: &Unit<R>, abs: &Path| dest.rel_of(abs).unwrap_or_default();
    let land = |to: &Path| {
        if let Some(parent) = to.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::rename(from, to).is_ok()
    };
    let files = &dest.view().files;
    let candidate = files
        .get_key_value(fid)
        .or_else(|| {
            files
                .iter()
                .filter(|(_, f)| file_name(&f.path).eq_ignore_ascii_case(&name))
                .max_by_key(|(_, f)| (f.hash == synced) as u8 * 2 + (f.hash == now) as u8)
        })
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

    let target = dest.abs(&theirs.path);
    if target == from {
        // Nothing to move. An edit made here since carries on as an edit of
        // the file where it was made from exactly what `dest` holds; anything
        // else is the cycle's to merge, like a file both sides changed.
        if !clean && now != theirs.hash && synced == theirs.hash {
            dest.plant(&fid, &theirs, base);
        } else {
            dest.poke = true;
        }
        return Received::Kept;
    }
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
