//! The versions commands the frontend calls (mirrored in src/versions.ts).
//! Each is the engine's command of the same name (engine/src/versions/mod.rs,
//! where what it does is written down) with this app's running engine handed
//! in.

use doklin_engine::versions;
use doklin_engine::versions::history::FileHistory;
use doklin_engine::versions::status::{RestoreOutcome, SnapshotMeta, VersionsStatus};
use doklin_engine::versions::stores::{ExportReport, StoreInfo};
use doklin_engine::versions::workspace::{DeletedFile, RestoreReport, SnapshotDiff};
use tauri::AppHandle;

use crate::engine::core;

#[tauri::command]
pub(crate) fn versions_status(app: AppHandle) -> Result<Vec<VersionsStatus>, String> {
    versions::versions_status(&core(&app)?)
}

#[tauri::command]
pub(crate) async fn versions_snapshots(app: AppHandle, root: String) -> Result<Vec<SnapshotMeta>, String> {
    versions::versions_snapshots(&core(&app)?, root).await
}

#[tauri::command]
pub(crate) async fn versions_capture_now(
    app: AppHandle,
    root: String,
    reason: Option<String>,
    label: Option<String>,
) -> Result<Option<SnapshotMeta>, String> {
    versions::versions_capture_now(&core(&app)?, root, reason, label).await
}

#[tauri::command]
pub(crate) async fn versions_set_pinned(
    app: AppHandle,
    root: String,
    ts: u64,
    pinned: bool,
    label: Option<String>,
) -> Result<(), String> {
    versions::versions_set_pinned(&core(&app)?, root, ts, pinned, label).await
}

#[tauri::command]
pub(crate) fn versions_set_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    versions::versions_set_enabled(&core(&app)?, enabled)
}

#[tauri::command]
pub(crate) async fn versions_history(app: AppHandle, path: String) -> Result<FileHistory, String> {
    versions::versions_history(&core(&app)?, path).await
}

#[tauri::command]
pub(crate) async fn versions_read(app: AppHandle, root: String, hash: String) -> Result<String, String> {
    versions::versions_read(&core(&app)?, root, hash).await
}

#[tauri::command]
pub(crate) async fn versions_diff(
    app: AppHandle,
    root: String,
    path: Option<String>,
    from: Option<String>,
    to: Option<String>,
) -> Result<String, String> {
    versions::versions_diff(&core(&app)?, root, path, from, to).await
}

#[tauri::command]
pub(crate) async fn versions_snapshot_diff(app: AppHandle, root: String, ts: u64) -> Result<SnapshotDiff, String> {
    versions::versions_snapshot_diff(&core(&app)?, root, ts).await
}

#[tauri::command]
pub(crate) async fn versions_deleted(app: AppHandle, root: String) -> Result<Vec<DeletedFile>, String> {
    versions::versions_deleted(&core(&app)?, root).await
}

#[tauri::command]
pub(crate) async fn versions_restore_snapshot(
    app: AppHandle,
    root: String,
    ts: u64,
    paths: Option<Vec<String>>,
) -> Result<RestoreReport, String> {
    versions::versions_restore_snapshot(&core(&app)?, root, ts, paths).await
}

#[tauri::command]
pub(crate) async fn versions_set_horizon(app: AppHandle, root: String, days: Option<u32>) -> Result<(), String> {
    versions::versions_set_horizon(&core(&app)?, root, days).await
}

#[tauri::command]
pub(crate) async fn versions_set_cloud_horizon(
    app: AppHandle,
    root: String,
    days: Option<u32>,
) -> Result<(), String> {
    versions::versions_set_cloud_horizon(&core(&app)?, root, days).await
}

#[tauri::command]
pub(crate) async fn versions_stores(app: AppHandle) -> Result<Vec<StoreInfo>, String> {
    versions::versions_stores(&core(&app)?).await
}

#[tauri::command]
pub(crate) async fn versions_forget(app: AppHandle, key: String) -> Result<(), String> {
    versions::versions_forget(&core(&app)?, key).await
}

#[tauri::command]
pub(crate) async fn versions_export(app: AppHandle, root: String, dest: String) -> Result<ExportReport, String> {
    versions::versions_export(&core(&app)?, root, dest).await
}

#[tauri::command]
pub(crate) async fn versions_restore_file(
    app: AppHandle,
    root: String,
    path: String,
    ts: Option<u64>,
    hash: Option<String>,
    text: Option<String>,
) -> Result<RestoreOutcome, String> {
    versions::versions_restore_file(&core(&app)?, root, path, ts, hash, text).await
}
