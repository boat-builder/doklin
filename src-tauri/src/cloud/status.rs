//! The engine's side of the frontend contract (docs/cloud.md §6.7):
//! the status that is the frontend's entire model, the events, and the
//! small result types the commands answer with. Mirrored in TypeScript by
//! src/cloud.ts — change both.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::manifest::PublicKind;
use super::remote::WorkspaceRecord;

/// `CloudStatus[]` — the whole model, on every change.
pub const EV_STATUS: &str = "cloud-status";
/// `{root, paths}` — sync wrote these files; refresh the tree, reload tabs.
pub const EV_APPLIED: &str = "cloud-applied";
/// `{root, path, by, conflictPath}`.
pub const EV_CONFLICT: &str = "cloud-conflict";
/// `{root, count, total, paths}`.
pub const EV_PENDING_DELETES: &str = "cloud-pending-deletes";
/// `{root, kind: "upload" | "download", done, total}`.
pub const EV_PROGRESS: &str = "cloud-progress";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Idle,
    Syncing,
    Offline,
    Paused,
    PendingDeletes,
    Revoked,
    WorkerOutdated,
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
    /// What `/api/meta` last reported; null until the worker answered once.
    pub worker_version: Option<u32>,
    /// The version store's mirror — null when this worker has no `versions`
    /// feature, which is what the update badge is for.
    pub versions: Option<VersionsMirror>,
    /// The public map as this device believes it: the last applied manifest
    /// overlaid with the ops queued here — so a page the user just
    /// published shows up immediately, not a CAS later.
    pub public: Vec<PublicPage>,
    /// Every other device here, from the last poll.
    pub presence: Vec<PresenceDevice>,
}

/// How much of this device's version history is in the bucket, and how much
/// is up there in total (docs/versioning-plan.md §6.2).
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
    /// Workspace-relative; `""` is the workspace root for a folder page.
    pub path: String,
    pub title: Option<String>,
    pub desc: Option<String>,
    pub by: String,
    pub at: u64,
    /// False when the page's file is gone (its page 404s until stopped or
    /// the file returns) — or, for a folder, when no synced file lives
    /// under it.
    pub alive: bool,
    pub root: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceDevice {
    pub device_id: String,
    pub name: String,
    pub path: Option<String>,
    pub ts: u64,
}

/// `cloud_probe`: what a domain answered before anything is touched.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub worker_version: u32,
    /// The version this app was built against — the badge compares the two.
    pub bundled_version: u32,
    pub features: Vec<String>,
    pub workspace: Option<WorkspaceRecord>,
}

/// What a second Mac needs to download a workspace: shown in the Cloud
/// panel behind "Connect another Mac…", never carried by a status.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Credentials {
    pub endpoint: String,
    pub token: String,
}

/* ---------- Event sink (AppHandle in prod, a collector in tests) ---------- */

pub trait Events: Send + Sync + 'static {
    fn emit_json(&self, event: &str, payload: serde_json::Value);
}

pub struct AppEvents(pub AppHandle);

impl Events for AppEvents {
    fn emit_json(&self, event: &str, payload: serde_json::Value) {
        let _ = self.0.emit(event, payload);
    }
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
