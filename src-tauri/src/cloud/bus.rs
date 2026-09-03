//! The edit bus (docs/cloud-redesign.md §6.4). Every write the app makes
//! already goes through a Rust command — `write_file`, `write_frontmatter`,
//! `write_body`, `create_card`, `create_file`, `create_dir`, `move_path`,
//! `copy_path`, `trash_file`, `restore_trashed` — and each ends with
//! `cloud::touched(&app, &path)`: a hint to the engine whose root contains
//! the path that something under it just changed. The engine settles 1.5 s
//! after the last touch instead of the watcher's 5 s, so an edit reaches
//! the cloud about two seconds after the keystroke.
//!
//! A hint about *when*, never a substitute for the scan: the cycle still
//! walks the whole tree and decides from content what changed.

use std::path::{Path, PathBuf};
use std::sync::RwLock;

use tauri::{AppHandle, Manager};
use tokio::sync::mpsc::UnboundedSender;

use super::engine::EngineCmd;
use super::scan::rel_path;

struct Route {
    root: PathBuf,
    tx: UnboundedSender<EngineCmd>,
}

/// The routing table: one row per running engine. Managed as Tauri state
/// so a write command reaches it without touching the manager's lock.
#[derive(Default)]
pub struct EditBus {
    routes: RwLock<Vec<Route>>,
}

impl EditBus {
    pub fn register(&self, root: PathBuf, tx: UnboundedSender<EngineCmd>) {
        if let Ok(mut routes) = self.routes.write() {
            routes.retain(|r| r.root != root);
            routes.push(Route { root, tx });
        }
    }

    pub fn unregister(&self, root: &Path) {
        if let Ok(mut routes) = self.routes.write() {
            routes.retain(|r| r.root != root);
        }
    }

    /// Route a touched absolute path to the engine whose root contains it
    /// (the deepest root, should roots ever nest). Returns whether one did.
    /// Paths the scan would never see — hidden or ignored components, the
    /// engine's own temp files — are dropped here, so they never wake it.
    pub fn touch(&self, path: &Path) -> bool {
        let Ok(routes) = self.routes.read() else { return false };
        let Some(route) = routes
            .iter()
            .filter(|r| path.starts_with(&r.root))
            .max_by_key(|r| r.root.as_os_str().len())
        else {
            return false;
        };
        let Some(rel) = rel_path(&route.root, path) else { return false };
        if rel.is_empty()
            || rel
                .split('/')
                .any(|seg| crate::is_hidden_or_ignored(seg) || seg.ends_with(super::scan::TMP_SUFFIX))
        {
            return false;
        }
        route.tx.send(EngineCmd::Touched(rel)).is_ok()
    }
}

/// The one call every write command makes. A no-op before the cloud
/// manager exists or for a path under no connected workspace.
pub fn touched(app: &AppHandle, path: &str) {
    if let Some(bus) = app.try_state::<EditBus>() {
        bus.touch(Path::new(path));
    }
}
