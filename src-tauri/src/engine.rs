//! The sync engine and the version store, as this app holds them.
//!
//! Both live in the `doklin-engine` crate (engine/), which knows nothing of
//! Tauri: the iPhone app builds the same crate in. This file is what the Mac
//! app says to it — `Setup` once at boot, `Host` afterwards — and where the
//! running `Core` is kept. The commands the frontend calls are thin wrappers
//! over the engine's, in cloud.rs and versions.rs.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use doklin_engine::{Core, Host, Setup};
use tauri::{AppHandle, Emitter, Manager};

/// The Mac app, as the engine sees it.
struct MacHost(AppHandle);

impl Host for MacHost {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        let _ = self.0.emit(event, payload);
    }

    /// Which folders are open, from the window registry — the only place
    /// that knows.
    fn open_folders(&self) -> BTreeSet<String> {
        let mut roots = BTreeSet::new();
        if let Some(registry) = self.0.try_state::<crate::WindowRegistry>() {
            if let Ok(map) = registry.0.lock() {
                for content in map.values() {
                    if let Some(folder) = content.folder.as_ref().filter(|f| !f.is_empty()) {
                        roots.insert(folder.clone());
                    }
                }
            }
        }
        roots
    }

    fn write_file(&self, path: &Path, bytes: &[u8]) -> Result<(), String> {
        crate::write_workspace_bytes(&self.0, path, bytes).map(|_| ())
    }

    fn trash(&self, path: &Path) -> Result<(), String> {
        #[cfg(target_os = "macos")] // macOS-only: the Trash, via NSFileManager
        {
            crate::trash_path_impl(&path.to_string_lossy()).map(|_| ())
        }
        #[cfg(not(target_os = "macos"))]
        {
            Err(format!("no trash to move {} to", path.display()))
        }
    }

    /// A workspace new on this Mac is one its terminal can work in too.
    fn connected(&self, root: &str) {
        #[cfg(target_os = "macos")] // macOS-only: the command ships inside the app
        crate::cli_install::after_connect(&self.0, root);
        #[cfg(not(target_os = "macos"))]
        let _ = root;
    }
}

/// Where a workspace this Mac joins is kept: `~/Doklin`, one folder per
/// workspace. Visible, so the files are the user's to find in Finder; fixed,
/// so joining never stops to ask where.
fn join_parent(home: &Path) -> PathBuf {
    home.join("Doklin")
}

/// The running engine, once `init` has made it.
pub(crate) fn try_core(app: &AppHandle) -> Option<Arc<Core>> {
    app.try_state::<Arc<Core>>().map(|core| core.inner().clone())
}

/// The running engine, for a command: an error in words before it exists.
pub(crate) fn core(app: &AppHandle) -> Result<Arc<Core>, String> {
    try_core(app).ok_or_else(|| "the cloud engine isn't ready yet".to_string())
}

/// Called once from tauri's setup: make the engine, and start the cloud half
/// — one sync engine per connected workspace, from cloud.json. Answers the
/// workspaces that moved into the Library layout just now (`cloud::init`).
pub(crate) fn init(app: &AppHandle) -> Vec<String> {
    let Ok(data_dir) = app.path().app_data_dir() else { return Vec::new() };
    let home = app.path().home_dir().ok();
    let core = Core::new(Setup {
        data_dir,
        join_dir: home.as_deref().map(join_parent),
        home,
        anchor: None,
        client: env!("CARGO_PKG_VERSION").to_string(),
        device_name: doklin_engine::cloud::device_display_name(),
        device_kind: "Mac".to_string(),
        watch: true,
        runtime: tauri::async_runtime::handle().inner().clone(),
        host: Arc::new(MacHost(app.clone())),
    });
    app.manage(core.clone());
    doklin_engine::cloud::init(&core)
}

/// The versions half, after `init`: one versioner per open folder.
/// `reconcile_versions` starts the rest as windows report in.
pub(crate) fn init_versions(app: &AppHandle) {
    if let Some(core) = try_core(app) {
        doklin_engine::versions::init(&core);
    }
}

/// Which folders are open changed (a window reported its content, or one was
/// destroyed): bring the running versioners in line.
pub(crate) fn reconcile_versions(app: &AppHandle) {
    if let Some(core) = try_core(app) {
        doklin_engine::versions::reconcile(&core);
    }
}

/// Capture whatever is pending in every open folder, within `deadline` — the
/// quit flush. Blocks; never call it inside the async runtime.
pub(crate) fn flush_versions_blocking(app: &AppHandle, deadline: Duration) {
    if let Some(core) = try_core(app) {
        doklin_engine::versions::flush_all_blocking(&core, deadline);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_joined_workspace_is_kept_under_doklin_in_the_home_folder() {
        assert_eq!(join_parent(Path::new("/Users/ada")), PathBuf::from("/Users/ada/Doklin"));
    }
}
