//! The edit bus. Every write the app makes ends with `Core::touched(path)`:
//! a hint to the engine whose root contains the path that something under it
//! just changed. The engine settles 1.5 s after the last touch instead of
//! the watcher's 5 s, so an edit reaches the cloud about two seconds after
//! the keystroke.
//!
//! A hint about *when*, never a substitute for the scan: the cycle still
//! walks the whole tree and decides from content what changed.
//!
//! A move the app makes is told as well (`Core::moved(from, to)`), beside
//! touching both ends: which file went where, so that a document renamed and
//! edited in one look keeps its id. A tip, never taken on trust: the scan uses
//! it only where the folder agrees (`Unit::stage_local`).

use std::path::{Path, PathBuf};
use std::sync::RwLock;

use tokio::sync::mpsc::UnboundedSender;

use super::engine::EngineCmd;
use super::scan::{rel_for_touch, rel_in_scan};

struct Route {
    root: PathBuf,
    tx: UnboundedSender<EngineCmd>,
}

/// The routing table: one row per running engine. Beside the manager, not
/// inside it, so a write reaches it without touching the manager's lock.
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
        let Some(route) = Self::route(&routes, path) else { return false };
        let Some(rel) = rel_for_touch(&route.root, path) else { return false };
        route.tx.send(EngineCmd::Touched(rel)).is_ok()
    }

    /// Route a move the app made, `from` → `to` (absolute; a file or a
    /// folder), to the engine whose root holds `from`. Dropped when `to` is
    /// not under that same root, or either end is somewhere the scan never
    /// looks. Returns whether an engine heard it.
    pub fn moved(&self, from: &Path, to: &Path) -> bool {
        let Ok(routes) = self.routes.read() else { return false };
        let Some(route) = Self::route(&routes, from) else { return false };
        let (Some(from), Some(to)) = (rel_in_scan(&route.root, from), rel_in_scan(&route.root, to)) else {
            return false;
        };
        route.tx.send(EngineCmd::Moved { from, to }).is_ok()
    }

    /// The deepest root that holds `path`, should roots ever nest.
    fn route<'a>(routes: &'a [Route], path: &Path) -> Option<&'a Route> {
        routes.iter().filter(|r| path.starts_with(&r.root)).max_by_key(|r| r.root.as_os_str().len())
    }
}
