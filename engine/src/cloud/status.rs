//! The engine's side of the frontend contract:
//! the status that is the frontend's entire model, the events, and the
//! small result types the commands answer with. Mirrored in TypeScript by
//! src/cloud.ts and in Swift by ios/DoklinKit/Sources/DoklinKit/Engine/
//! Payloads.swift — change all three.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;

use super::manifest::{PublicKind, SpaceKind};
use super::pace::{Cause, Mode, Plan};
use super::remote::{AgentRecord, InviteRecord, MemberRecord, DeviceRecord, WorkspaceRecord};

/// `CloudStatus[]` — the whole model, on every change.
pub const EV_STATUS: &str = "cloud-status";
/// `{root, paths}` — sync wrote these files; refresh the tree, reload tabs.
pub const EV_APPLIED: &str = "cloud-applied";
/// `{root, path, by, conflictPath}`.
pub const EV_CONFLICT: &str = "cloud-conflict";
/// `{root, count, total, paths}`.
pub const EV_PENDING_DELETES: &str = "cloud-pending-deletes";
/// `{root, count, folders: [{path, count}]}` — this many new documents
/// appeared in one pass and wait for a yes (`cloud_confirm_adds`). Folders
/// workspace-relative, most first, at most five.
pub const EV_PENDING_ADDS: &str = "cloud-pending-adds";
/// `{root, name, path}` — a restricted folder left this Mac: this person was
/// taken out of it, or it was deleted. `path` is where it was,
/// workspace-relative.
pub const EV_SPACE_LEFT: &str = "cloud-space-left";
/// `{root, kind: "upload" | "download", done, total}`.
pub const EV_PROGRESS: &str = "cloud-progress";
/// A `Removed` — an owner took this Mac's access away, and the workspace's
/// copy here is gone.
pub const EV_REMOVED: &str = "cloud-removed";
/// `{root, slug, path}` — a page asked for an address that is another
/// section's on this domain, and was not published.
pub const EV_ADDRESS_TAKEN: &str = "cloud-address-taken";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Idle,
    Syncing,
    Offline,
    Paused,
    PendingDeletes,
    /// The many-new-documents valve is holding: they stay on this device
    /// until the person says (`cloud_confirm_adds`).
    PendingAdds,
    Revoked,
    WorkerOutdated,
    /// Cloudflare's daily requests for the account are used up: nothing is
    /// sent until 00:00 UTC but a probe every half hour.
    Limited,
    Error,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudStatus {
    pub root: String,
    pub domain: String,
    pub endpoint: String,
    pub ws_id: String,
    pub name: String,
    pub phase: Phase,
    pub last_sync_ms: Option<u64>,
    pub error: Option<String>,
    pub pending_deletes: u32,
    /// New documents the valve is holding.
    pub pending_adds: u32,
    /// What this device has spent today, and what that means for its sync.
    pub usage: UsageStatus,
    /// What this Mac signs work with here, in words: the person the domain
    /// says it is, empty until it has said. What a surface compares a `by`
    /// against to know whether somebody *else* did a thing.
    pub me: String,
    /// The same person as the domain's id for them — which of a folder's
    /// `members` is this Mac. None until the domain has said.
    pub me_id: Option<String>,
    /// What this Mac's credential may do here, in the words of the worker's
    /// role table (`work`, `people.invite`, …) — what every surface hides
    /// the rest by. Empty until the domain has answered once.
    pub can: Vec<String>,
    /// The workspace's superadmin, by name — whom a surface says to ask for
    /// what only they can do (an update of the worker). None until the
    /// domain has said.
    pub superadmin: Option<String>,
    /// What `/api/meta` last reported; null until the worker answered once.
    pub worker_version: Option<u32>,
    /// The version store's mirror.
    pub versions: VersionsMirror,
    /// The public map as this device believes it: the last applied manifest
    /// overlaid with the ops queued here — so a page the user just
    /// published shows up immediately, not a CAS later.
    pub public: Vec<PublicPage>,
    /// Every other device here, from the last poll.
    pub presence: Vec<PresenceDevice>,
    /// The documents another Mac holds, from the same poll.
    /// An editor showing one of these opens view-only. Empty when this
    /// Mac cannot hear the domain — a lock nobody can confirm is no lock.
    pub leases: Vec<LeaseHolder>,
    /// This person's sections besides the shared workspace — their Private
    /// and the restricted folders they are in — that have a folder on this
    /// Mac.
    pub spaces: Vec<SpaceStatus>,
}

/// `CloudStatus.usage`: this device's requests today on this domain, and
/// the mode they put its sync in (`super::pace`).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStatus {
    pub mode: Mode,
    /// Whose spending put it there: this device's, or everyone's together.
    pub cause: Option<Cause>,
    pub today: u64,
    pub fleet_today: Option<u64>,
    /// The account's daily requests; None on Workers Paid, or before the
    /// domain has said.
    pub cap: Option<u64>,
    pub plan: Option<Plan>,
    /// The next 00:00 UTC (epoch ms), while the mode is not `normal` or the
    /// phase is `limited`: when what waits goes again.
    pub resumes_at: Option<u64>,
    /// Changes held back: uploads not sent and downloads owed.
    pub waiting: u32,
    /// This device's own allowance is what holds them, and its person has
    /// not lifted it today (`cloud_lift_wait`).
    pub liftable: bool,
    pub lifted: bool,
}

/// One section of the workspace that only some people have.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceStatus {
    pub id: String,
    pub kind: SpaceKind,
    pub name: String,
    /// Its folder on this Mac, workspace-relative: `Private`,
    /// `Restricted/Finance`.
    pub path: String,
    /// Who made it, in words — resolved like every other `by`.
    pub by: String,
    /// Everyone in it, by member id.
    pub members: Vec<String>,
}

/// How much of this device's version history is in the bucket, and how much
/// is up there in total.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionsMirror {
    pub mirrored: u64,
    pub cloud: u64,
    pub last_mirror_ms: Option<u64>,
    /// How far back the bucket keeps, `null` for forever — the second of the
    /// two horizons. Meaningful once `last_mirror_ms` is set; before that no
    /// pass has read the cloud index and the surface says as much.
    pub horizon_days: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicPage {
    pub slug: String,
    pub kind: PublicKind,
    /// Workspace-relative, whichever section the page is in; `""` is the
    /// workspace root for a folder page.
    pub path: String,
    pub title: Option<String>,
    pub desc: Option<String>,
    /// Who published it, in words: the engine resolves the manifest's member
    /// id through the workspace's directory before it gets here, so no
    /// surface has to hold a second answer to "who is m-1a2b3c4d".
    pub by: String,
    pub at: u64,
    /// False when the page's file is gone (its page 404s until stopped or
    /// the file returns) — or, for a folder, when no synced file lives
    /// under it.
    pub alive: bool,
    pub root: bool,
}

/// Another Mac here now. Resolved by the engine like every other `by`: the
/// worker says whose Mac it is, the directory says what they are called.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceDevice {
    pub device_id: String,
    /// Whose Mac it is.
    pub member_id: String,
    /// Who is here, in words: the person — or, when it is *your* other Mac,
    /// or nobody the directory can name, the Mac. "Ada is editing" says
    /// nothing to Ada; "MacBook Air is editing" does.
    pub name: String,
    /// The Mac's own name, whoever's it is.
    pub device: String,
    pub path: Option<String>,
    pub ts: u64,
}

/// A document another Mac holds. Resolved like a `PresenceDevice`: the
/// person when the directory can name them, the Mac when it is your own
/// other one (`own`) or nobody it can.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseHolder {
    /// The lease's key: workspace-relative — as this Mac's folders spell the
    /// section it is in — and lowercased.
    pub path: String,
    pub device_id: String,
    pub member_id: String,
    pub name: String,
    pub device: String,
    /// True when the holder is you, on another Mac.
    pub own: bool,
    /// When it lapses unless renewed, by the domain's clock.
    pub until: u64,
}

/// A workspace taken off this Mac because an owner took its access away —
/// the `cloud-removed` event's payload, and a row of `cloud_removed`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Removed {
    pub root: String,
    pub name: String,
    pub domain: String,
    /// False when the folder could not be deleted — it no longer says it is
    /// that workspace, or the disk refused — so the notice can say so.
    pub deleted: bool,
    /// When, in ms: with `root`, what lets a window tell one it has already
    /// shown from one it has not.
    pub at: u64,
}

/// `cloud_probe`: what a domain answered before anything is touched.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub worker_version: u32,
    /// The version this app was built against — the badge compares the two.
    pub bundled_version: u32,
    pub workspace: Option<WorkspaceRecord>,
}

/// `cloud_redeem` and `cloud_recover`: this Mac's own credential, and who the
/// domain says the person holding it is. The token goes straight into
/// `cloud_join`, `cloud_connect` (a fresh domain), or `cloud_resume` when the
/// open folder is already that workspace.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Redeemed {
    /// Normalized, so the caller probes the address the worker answered on.
    pub endpoint: String,
    pub token: String,
    pub member_id: String,
    pub email: String,
    pub name: String,
}

/// `cloud_invite`: the invite the domain now holds, plus the code itself —
/// the one moment it exists in the clear. The panel shows it once; nothing
/// on this Mac or on the domain can produce it again.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Invited {
    pub code: String,
    /// The one line to send: address and code together (`cloud/invite.rs`).
    pub blob: String,
    pub invite: InviteRecord,
}

/// `cloud_device_code`: a fresh code for another device of this person's own
/// — a Mac, an iPhone — and the line that carries it. Shown once; the domain
/// keeps only its sha256, and the device that redeems it gets a sign-in of
/// its own.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCode {
    pub code: String,
    /// The one line to paste on the other device: address and code together
    /// (`cloud/invite.rs`), the line an invite is.
    pub blob: String,
    pub expires_at: u64,
}

/// `cloud_people`: everything the People view shows.
///
/// Who this Mac is here, and what it may do, is asked rather than remembered:
/// `/api/meta` answers both, and nothing on disk records a role — it is the
/// person's, and an owner can change it while this Mac is asleep.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct People {
    /// `superadmin`, `owner` or `member`.
    pub role: String,
    /// The person this Mac is, by member id — which row in `members` is
    /// "you".
    pub me: String,
    /// What that role may do, in the worker's words (`people.invite`, …).
    pub can: Vec<String>,
    /// This Mac's own device id, so the list can mark which Mac is this one.
    pub device_id: String,
    /// The row in `devices` that is the credential this Mac syncs with.
    /// Never offered for signing out: that would delete the copy in hand.
    pub token_id: String,
    /// Everyone, newest last.
    pub members: Vec<MemberRecord>,
    /// The pending, unexpired invites. Empty for whoever may not invite.
    pub invites: Vec<InviteRecord>,
    /// The signed-in devices: this person's own, and for an owner
    /// everybody's.
    pub devices: Vec<DeviceRecord>,
}

/// A fresh login code for an agent, and the line that carries it — the one
/// moment the code exists in the clear. Shown once; the domain keeps only
/// its sha256.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLogin {
    /// The whole command to run on the agent's machine:
    /// `doklin login https://notes.example.com dkla-…`.
    pub line: String,
    pub code: String,
    pub expires_at: u64,
}

/// `cloud_agent_add`: the agent the domain now holds, and how it logs in.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAdded {
    pub agent: AgentRecord,
    pub login: AgentLogin,
}

/* ---------- Event sink (the host in an app, a collector in tests) ---------- */

pub trait Events: Send + Sync + 'static {
    fn emit_json(&self, event: &str, payload: serde_json::Value);
}

/// Every connected workspace's status, keyed by root — shared by the
/// engines (who write their own row) and the `cloud_status` command.
pub type StatusTable = Arc<Mutex<BTreeMap<String, CloudStatus>>>;

pub fn snapshot(table: &StatusTable) -> Vec<CloudStatus> {
    table.lock().map(|t| t.values().cloned().collect()).unwrap_or_default()
}

/// Emit the whole model.
pub fn emit_statuses(events: &dyn Events, table: &StatusTable) {
    let all = snapshot(table);
    events.emit_json(EV_STATUS, serde_json::to_value(all).unwrap_or(serde_json::Value::Array(vec![])));
}
