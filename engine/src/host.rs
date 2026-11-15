//! The app, as the engine sees it.
//!
//! `Core` is one running engine: the cloud manager, the versions manager and
//! the two buses every write rings. `Setup` is what an app says once, at
//! boot; `Host` is what the engine asks of it afterwards. The Mac app's are
//! in src-tauri/src/engine.rs, the iPhone's in ffi/src/lib.rs.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::cloud::status::Events;
use crate::cloud::EditBus;
use crate::versions::VersionBus;

/// What the engine asks of the app it runs inside.
pub trait Host: Send + Sync + 'static {
    /// An event for whoever draws the screens (the names are `EV_*` in
    /// cloud/status.rs and versions/status.rs).
    fn emit(&self, event: &str, payload: serde_json::Value);

    /// The folders that are open: each gets a versioner, and so do the
    /// sections inside a connected one.
    fn open_folders(&self) -> BTreeSet<String>;

    /// Put a workspace file down the way the app does everywhere else, edit
    /// bus included. A restore writes through here, never around it.
    fn write_file(&self, path: &Path, bytes: &[u8]) -> Result<(), String>;

    /// Move a file to the platform's trash. An error — or a platform with no
    /// trash — has the caller remove the file outright.
    fn trash(&self, path: &Path) -> Result<(), String>;

    /// A workspace was just connected on this device.
    fn connected(&self, _root: &str) {}

    /// Where this device's sign-ins are kept, when the app keeps them itself
    /// (the iPhone: its Keychain). None — the Mac — keeps each one in
    /// cloud.json, with the rest of its workspace's entry.
    fn secrets(&self) -> Option<&dyn Secrets> {
        None
    }
}

/// A keeper of sign-ins, by workspace id. What it holds is read whenever
/// cloud.json is, and the entry there carries no token (cloud/config.rs).
pub trait Secrets: Send + Sync {
    /// The sign-in kept for the workspace, if there is one.
    fn secret(&self, ws_id: &str) -> Option<String>;
    /// Keep `token` for the workspace, or forget what is kept when it is None.
    fn set_secret(&self, ws_id: &str, token: Option<&str>) -> Result<(), String>;
}

/// What an app says once, at boot.
pub struct Setup {
    /// Where the engine keeps what is its own: `cloud.json`, the sync state,
    /// the version stores.
    pub data_dir: PathBuf,
    /// The person's home folder, when there is one: no folder wide enough to
    /// hold it is ever deleted.
    pub home: Option<PathBuf>,
    /// Where a workspace this device joins is downloaded, one folder each.
    pub join_dir: Option<PathBuf>,
    /// The folder the platform can move under the app (`paths`), if it can.
    pub anchor: Option<PathBuf>,
    /// `x-doklin-client`: which app, and which version of it.
    pub client: String,
    /// This device's own name, as its person knows it.
    pub device_name: String,
    /// Watch connected folders for changes made outside the app.
    pub watch: bool,
    /// The runtime every engine task runs on.
    pub runtime: tokio::runtime::Handle,
    pub host: Arc<dyn Host>,
}

/// One running engine. Made once (`Core::new`), then started in two steps the
/// app orders around its own boot: `cloud::init`, `versions::init`.
pub struct Core {
    pub(crate) host: Arc<dyn Host>,
    pub(crate) runtime: tokio::runtime::Handle,
    pub(crate) data_dir: PathBuf,
    pub(crate) home: Option<PathBuf>,
    pub(crate) join_dir: Option<PathBuf>,
    pub(crate) client: String,
    pub(crate) device_name: String,
    pub(crate) watch: bool,
    pub(crate) cloud: Mutex<Option<crate::cloud::ManagerInner>>,
    pub(crate) versions: Mutex<Option<crate::versions::ManagerInner>>,
    pub(crate) edit_bus: EditBus,
    pub(crate) version_bus: VersionBus,
}

impl Core {
    pub fn new(setup: Setup) -> Arc<Core> {
        if let Some(anchor) = setup.anchor {
            crate::paths::set_anchor(anchor);
        }
        Arc::new(Core {
            host: setup.host,
            runtime: setup.runtime,
            data_dir: setup.data_dir,
            home: setup.home,
            join_dir: setup.join_dir,
            client: setup.client,
            device_name: setup.device_name,
            watch: setup.watch,
            cloud: Mutex::new(None),
            versions: Mutex::new(None),
            edit_bus: EditBus::default(),
            version_bus: VersionBus::default(),
        })
    }

    /// The one call every write the app makes ends with: a hint to the cloud
    /// engine and the versioner whose folder holds `path` that something
    /// under it just changed. About *when*, never a substitute for a scan:
    /// both still walk the tree and decide from content what changed. A
    /// no-op for a path under no connected or open folder.
    pub fn touched(&self, path: &str) {
        self.edit_bus.touch(Path::new(path));
        self.version_bus.touch(Path::new(path));
    }

    /// Where sign-ins are kept: the app's keeper, or cloud.json itself.
    pub(crate) fn secrets(&self) -> Option<&dyn Secrets> {
        self.host.secrets()
    }

    pub(crate) fn events(&self) -> Arc<dyn Events> {
        Arc::new(HostEvents(self.host.clone()))
    }
}

/// The host as the engine's event sink.
pub(crate) struct HostEvents(pub Arc<dyn Host>);

impl Events for HostEvents {
    fn emit_json(&self, event: &str, payload: serde_json::Value) {
        self.0.emit(event, payload);
    }
}
