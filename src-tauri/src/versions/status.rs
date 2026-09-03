//! The versioner's side of the frontend contract
//! (docs/versioning-plan.md §4.5): the status that is the frontend's whole
//! model of the local store, the event that carries it, and the snapshot row
//! the commands answer with. Mirrored in TypeScript by src/versions.ts —
//! change both.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;

use super::store::SnapshotRow;

/// `VersionsStatus[]` — the whole model, on every change.
pub const EV_STATUS: &str = "versions-status";

/// `{root, paths}` — a restore landed on disk. Deliberately the same shape
/// as `cloud-applied`, and App.tsx handles it the same way: refresh the
/// tree, reload the open document.
pub const EV_APPLIED: &str = "versions-applied";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Idle,
    Capturing,
    /// Past the sync's entry cap: nothing is captured, on purpose.
    TooLarge,
    Disabled,
    Error,
}

#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreBytes {
    pub blobs: u64,
    pub snapshots: u64,
}

/// One version store, as the frontend sees it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionsStatus {
    /// The display root; the drafts folder for drafts.
    pub root: String,
    pub key: String,
    pub phase: Phase,
    pub error: Option<String>,
    pub snapshots: u64,
    pub oldest_ms: Option<u64>,
    pub newest_ms: Option<u64>,
    pub last_capture_ms: Option<u64>,
    pub bytes: StoreBytes,
    /// How far back this store keeps versions; null = forever.
    pub horizon_days: Option<u32>,
}

/// What `versions_snapshots` answers: one row per retained snapshot, newest
/// first. The index's digest stays inside the store.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotMeta {
    pub ts: u64,
    pub reason: String,
    pub files: u64,
    pub bytes: u64,
    pub pinned: bool,
    pub label: Option<String>,
    pub restored_from: Option<u64>,
}

impl From<&SnapshotRow> for SnapshotMeta {
    fn from(row: &SnapshotRow) -> SnapshotMeta {
        SnapshotMeta {
            ts: row.ts,
            reason: row.reason.as_str().to_string(),
            files: row.files,
            bytes: row.bytes,
            pinned: row.pinned,
            label: row.label.clone(),
            restored_from: row.restored_from,
        }
    }
}

/// What `versions_restore_file` answers. The state a restore leaves is a
/// version like any other, and this is how the toast's *Undo* names it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOutcome {
    /// The snapshot holding the document as it was a moment ago: the one
    /// the pre-restore capture made, or the newest already there when
    /// nothing had changed since.
    pub pre_restore_ts: Option<u64>,
    /// That document's content hash — what *Undo* restores.
    pub pre_restore_hash: Option<String>,
    /// The snapshot the restore itself made.
    pub ts: Option<u64>,
}

/// Every store's status, keyed by root — shared by the versioners (each
/// writes its own row) and the `versions_status` command.
pub type StatusTable = Arc<Mutex<BTreeMap<String, VersionsStatus>>>;

pub fn snapshot(table: &StatusTable) -> Vec<VersionsStatus> {
    table.lock().map(|t| t.values().cloned().collect()).unwrap_or_default()
}

/// Emit the whole model.
pub fn emit_statuses(events: &dyn crate::cloud::status::Events, table: &StatusTable) {
    let all = snapshot(table);
    events.emit_json(EV_STATUS, serde_json::to_value(all).unwrap_or(serde_json::Value::Array(vec![])));
}
