//! The cloud commands the frontend calls (from src/mac/backend.ts, answering
//! `Cloud` in src/backend.ts; what they carry is mirrored in src/cloud.ts). Each is
//! the engine's command of the same name (engine/src/cloud/mod.rs, where what
//! it does is written down) with this app's running engine handed in.

use doklin_engine::cloud;
use doklin_engine::cloud::config::Marker;
use doklin_engine::cloud::invite::Pasted;
use doklin_engine::cloud::remote::{AgentRecord, EveryPages, MemberRecord};
use doklin_engine::cloud::status::{
    AgentAdded, AgentLogin, CloudStatus, DeviceCode, HeldWorkspace, Invited, PageLinkCopy, People, Probe, RecentFiles,
    Redeemed, Removed, SpaceStatus, WorkspaceDocument,
};
use tauri::{AppHandle, Manager};

use crate::engine::{core, try_core};
use crate::WindowRegistry;

#[tauri::command]
pub(crate) fn cloud_status(app: AppHandle) -> Result<Vec<CloudStatus>, String> {
    cloud::cloud_status(&core(&app)?)
}

#[tauri::command]
pub(crate) fn cloud_mint_token() -> String {
    cloud::cloud_mint_token()
}

#[tauri::command]
pub(crate) fn cloud_parse_invite(text: String) -> Pasted {
    cloud::cloud_parse_invite(text)
}

#[tauri::command]
pub(crate) async fn cloud_redeem(app: AppHandle, endpoint: String, code: String) -> Result<Redeemed, String> {
    cloud::cloud_redeem(&core(&app)?, endpoint, code).await
}

#[tauri::command]
pub(crate) async fn cloud_probe(app: AppHandle, endpoint: String, token: String) -> Result<Probe, String> {
    cloud::cloud_probe(&core(&app)?, endpoint, token).await
}

#[tauri::command]
pub(crate) fn cloud_marker(root: String) -> Option<Marker> {
    cloud::cloud_marker(root)
}

#[tauri::command]
pub(crate) fn cloud_held(app: AppHandle, endpoint: String) -> Result<Option<HeldWorkspace>, String> {
    cloud::cloud_held(&core(&app)?, endpoint)
}

#[tauri::command]
pub(crate) async fn cloud_device_code(app: AppHandle, root: String) -> Result<DeviceCode, String> {
    cloud::cloud_device_code(&core(&app)?, root).await
}

#[tauri::command]
pub(crate) async fn cloud_invite(
    app: AppHandle,
    root: String,
    email: String,
    name: Option<String>,
    days: Option<u32>,
) -> Result<Invited, String> {
    cloud::cloud_invite(&core(&app)?, root, email, name, days).await
}

#[tauri::command]
pub(crate) async fn cloud_people(app: AppHandle, root: String) -> Result<People, String> {
    cloud::cloud_people(&core(&app)?, root).await
}

#[tauri::command]
pub(crate) async fn cloud_recover(
    app: AppHandle,
    endpoint: String,
    key: String,
    email: String,
    name: Option<String>,
) -> Result<Redeemed, String> {
    cloud::cloud_recover(&core(&app)?, endpoint, key, email, name).await
}

#[tauri::command]
pub(crate) fn cloud_removed(app: AppHandle) -> Result<Vec<Removed>, String> {
    cloud::cloud_removed(&core(&app)?)
}

#[tauri::command]
pub(crate) async fn cloud_set_role(
    app: AppHandle,
    root: String,
    member_id: String,
    role: String,
) -> Result<MemberRecord, String> {
    cloud::cloud_set_role(&core(&app)?, root, member_id, role).await
}

#[tauri::command]
pub(crate) async fn cloud_revoke_person(app: AppHandle, root: String, member_id: String) -> Result<(), String> {
    cloud::cloud_revoke_person(&core(&app)?, root, member_id).await
}

#[tauri::command]
pub(crate) async fn cloud_revoke_device(app: AppHandle, root: String, token_id: String) -> Result<(), String> {
    cloud::cloud_revoke_device(&core(&app)?, root, token_id).await
}

#[tauri::command]
pub(crate) async fn cloud_withdraw_invite(app: AppHandle, root: String, invite_id: String) -> Result<(), String> {
    cloud::cloud_withdraw_invite(&core(&app)?, root, invite_id).await
}

#[tauri::command]
pub(crate) async fn cloud_agents(app: AppHandle, root: String) -> Result<Vec<AgentRecord>, String> {
    cloud::cloud_agents(&core(&app)?, root).await
}

#[tauri::command]
pub(crate) async fn cloud_agent_add(
    app: AppHandle,
    root: String,
    name: String,
    scopes: Vec<String>,
) -> Result<AgentAdded, String> {
    cloud::cloud_agent_add(&core(&app)?, root, name, scopes).await
}

#[tauri::command]
pub(crate) async fn cloud_agent_code(app: AppHandle, root: String, agent_id: String) -> Result<AgentLogin, String> {
    cloud::cloud_agent_code(&core(&app)?, root, agent_id).await
}

#[tauri::command]
pub(crate) async fn cloud_agent_update(
    app: AppHandle,
    root: String,
    agent_id: String,
    name: Option<String>,
    scopes: Option<Vec<String>>,
) -> Result<(), String> {
    cloud::cloud_agent_update(&core(&app)?, root, agent_id, name, scopes).await
}

#[tauri::command]
pub(crate) async fn cloud_agent_remove(app: AppHandle, root: String, agent_id: String) -> Result<(), String> {
    cloud::cloud_agent_remove(&core(&app)?, root, agent_id).await
}

#[tauri::command]
pub(crate) async fn cloud_agent_revoke_machine(
    app: AppHandle,
    root: String,
    agent_id: String,
    token_id: String,
) -> Result<(), String> {
    cloud::cloud_agent_revoke_machine(&core(&app)?, root, agent_id, token_id).await
}

#[tauri::command]
pub(crate) fn cloud_check_worker(app: AppHandle, root: String) -> Result<(), String> {
    cloud::cloud_check_worker(&core(&app)?, root)
}

#[tauri::command]
pub(crate) async fn cloud_connect(
    app: AppHandle,
    root: String,
    endpoint: String,
    token: String,
    name: String,
) -> Result<String, String> {
    cloud::cloud_connect(&core(&app)?, root, endpoint, token, name).await
}

#[tauri::command]
pub(crate) async fn cloud_join(app: AppHandle, endpoint: String, token: String) -> Result<String, String> {
    cloud::cloud_join(&core(&app)?, endpoint, token).await
}

#[tauri::command]
pub(crate) async fn cloud_resume(
    app: AppHandle,
    root: String,
    endpoint: String,
    token: String,
) -> Result<String, String> {
    cloud::cloud_resume(&core(&app)?, root, endpoint, token).await
}

#[tauri::command]
pub(crate) async fn cloud_disconnect(app: AppHandle, root: String) -> Result<(), String> {
    cloud::cloud_disconnect(&core(&app)?, root).await
}

#[tauri::command]
pub(crate) fn cloud_sync_now(app: AppHandle, root: String) -> Result<(), String> {
    cloud::cloud_sync_now(&core(&app)?, root)
}

#[tauri::command]
pub(crate) fn cloud_pause(app: AppHandle, root: String, paused: bool) -> Result<(), String> {
    cloud::cloud_pause(&core(&app)?, root, paused)
}

#[tauri::command]
pub(crate) fn cloud_confirm_deletes(app: AppHandle, root: String) -> Result<(), String> {
    cloud::cloud_confirm_deletes(&core(&app)?, root)
}

#[tauri::command]
pub(crate) fn cloud_confirm_adds(app: AppHandle, root: String, sync: bool) -> Result<(), String> {
    cloud::cloud_confirm_adds(&core(&app)?, root, sync)
}

#[tauri::command]
pub(crate) fn cloud_lift_wait(app: AppHandle, root: String) -> Result<(), String> {
    cloud::cloud_lift_wait(&core(&app)?, root)
}

#[tauri::command]
pub(crate) async fn cloud_set_plan(app: AppHandle, root: String, plan: String) -> Result<(), String> {
    cloud::cloud_set_plan(&core(&app)?, root, plan).await
}

/// A window gained focus or lost it — not a command: the window's own event
/// calls this (lib.rs), and the registry says which folder it shows. What a
/// workspace's engine polls by.
pub(crate) fn window_focus(app: &AppHandle, label: &str, focused: bool) {
    let folder = app
        .state::<WindowRegistry>()
        .0
        .lock()
        .ok()
        .and_then(|map| map.get(label).and_then(|content| content.folder.clone()));
    if let Some(core) = try_core(app) {
        let _ = cloud::cloud_set_focus(&core, label, folder, focused);
    }
}

#[tauri::command]
pub(crate) fn cloud_set_activity(app: AppHandle, window: tauri::Window, path: Option<String>) -> Result<(), String> {
    cloud::cloud_set_activity(&core(&app)?, window.label(), path)
}

#[tauri::command]
pub(crate) fn cloud_take_over(app: AppHandle, root: String, path: String) -> Result<(), String> {
    cloud::cloud_take_over(&core(&app)?, root, path)
}

#[tauri::command]
pub(crate) async fn cloud_publish(
    app: AppHandle,
    path: String,
    slug: Option<String>,
    title: Option<String>,
    desc: Option<String>,
) -> Result<String, String> {
    cloud::cloud_publish(&core(&app)?, path, slug, title, desc).await
}

#[tauri::command]
pub(crate) async fn cloud_unpublish(app: AppHandle, root: String, slug: String) -> Result<(), String> {
    cloud::cloud_unpublish(&core(&app)?, root, slug).await
}

#[tauri::command]
pub(crate) async fn cloud_set_root(app: AppHandle, root: String, slug: Option<String>) -> Result<(), String> {
    cloud::cloud_set_root(&core(&app)?, root, slug).await
}

#[tauri::command]
pub(crate) async fn cloud_space_create(
    app: AppHandle,
    root: String,
    name: String,
    members: Vec<String>,
    from: Option<String>,
) -> Result<SpaceStatus, String> {
    cloud::cloud_space_create(&core(&app)?, root, name, members, from).await
}

#[tauri::command]
pub(crate) async fn cloud_space_member(
    app: AppHandle,
    root: String,
    id: String,
    member_id: String,
    add: bool,
) -> Result<(), String> {
    cloud::cloud_space_member(&core(&app)?, root, id, member_id, add).await
}

#[tauri::command]
pub(crate) async fn cloud_space_delete(app: AppHandle, root: String, id: String) -> Result<(), String> {
    cloud::cloud_space_delete(&core(&app)?, root, id).await
}

#[tauri::command]
pub(crate) async fn cloud_pages(app: AppHandle, root: String) -> Result<EveryPages, String> {
    cloud::cloud_pages(&core(&app)?, root).await
}

#[tauri::command]
pub(crate) async fn cloud_page_take_down(app: AppHandle, root: String, slug: String) -> Result<(), String> {
    cloud::cloud_page_take_down(&core(&app)?, root, slug).await
}

#[tauri::command]
pub(crate) async fn cloud_wipe(app: AppHandle, root: String) -> Result<u64, String> {
    cloud::cloud_wipe(&core(&app)?, root).await
}

/// What changed lately in a workspace: its documents by when they last
/// changed, newest first (what the iPhone's Home lists).
#[tauri::command]
pub(crate) async fn cloud_recent(app: AppHandle, root: String, limit: Option<usize>) -> Result<RecentFiles, String> {
    cloud::cloud_recent(&core(&app)?, root, limit).await
}

/// Every document of a workspace on this Mac, in every section, with its
/// file id; None for a folder that doesn't sync (the app lists its tree).
#[tauri::command]
pub(crate) async fn cloud_documents(app: AppHandle, root: String) -> Result<Option<Vec<WorkspaceDocument>>, String> {
    cloud::cloud_documents(&core(&app)?, root).await
}

/// *Copy link*.
#[tauri::command]
pub(crate) async fn cloud_link(app: AppHandle, path: String) -> Result<PageLinkCopy, String> {
    cloud::cloud_link(&core(&app)?, path).await
}

/// Where a link to a page leads on this Mac, for a click in a note, which
/// the note's own tab follows: the file's absolute path, or None for an
/// address that is no such link. A link that reaches the Mac from outside
/// is links.rs's, which opens it in its workspace's window.
#[tauri::command]
pub(crate) async fn cloud_follow_link(app: AppHandle, url: String) -> Result<Option<String>, String> {
    if !crate::links::is_page_link(&url) {
        return Ok(None);
    }
    cloud::cloud_follow_link(&core(&app)?, url).await.map(Some).map_err(|words| crate::links::sentence(&words))
}
