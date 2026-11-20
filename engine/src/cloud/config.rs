//! The two files that say what is connected:
//!
//! `<app_data_dir>/cloud.json` — this machine's device identity and, per
//! connected workspace, the folder, the domain, the endpoint, the workspace
//! id and the token. One entry per root, one per domain. Parsed by shape: a
//! malformed file reads as "nothing connected". The token lives here and
//! nowhere else — unless the app keeps sign-ins itself (`Host::secrets`, the
//! iPhone's Keychain): then the token is there, by workspace id, and the
//! entry here has none. Both functions below are the one way in and out, so
//! nothing else knows which.
//!
//! `<root>/.doklin/cloud.json` — the marker, no secrets: `{domain, wsId,
//! layout}`, `layout` saying how far the folder has moved into the Library
//! layout (layout.rs). Hidden, so the tree walk, search and the sync scan
//! already ignore it. It
//! makes the folder self-describing: a machine that opens a folder carrying
//! a marker with no matching cloud.json entry is offered *resume*, and a
//! folder that already carries a marker for domain A cannot be connected to
//! domain B.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::manifest::{clean_name, MAX_NAME_LEN};
use crate::Secrets;
use super::scan::{random_id, read_json, write_json};

pub const MARKER_DIR: &str = ".doklin";
pub const MARKER_FILE: &str = "cloud.json";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeviceIdentity {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub root: String,
    pub domain: String,
    pub endpoint: String,
    pub ws_id: String,
    pub name: String,
    pub token: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CloudFile {
    pub device: Option<DeviceIdentity>,
    pub workspaces: Vec<WorkspaceEntry>,
    /// Entries whose sign-in the app's keeper could not read just now: not
    /// connected for as long as that lasts, and written back as they were —
    /// a passing failure to read is never taken to mean the sign-in is gone.
    #[serde(skip)]
    pub unread: Vec<WorkspaceEntry>,
}

impl CloudFile {
    /// Add (or replace) an entry — one per root, one per domain.
    pub fn upsert(&mut self, entry: WorkspaceEntry) {
        self.workspaces.retain(|w| w.root != entry.root && w.domain != entry.domain);
        self.unread.retain(|w| w.root != entry.root && w.domain != entry.domain);
        self.workspaces.push(entry);
    }

    pub fn remove_root(&mut self, root: &str) {
        self.workspaces.retain(|w| w.root != root);
        self.unread.retain(|w| w.root != root);
    }

    pub fn by_root(&self, root: &str) -> Option<&WorkspaceEntry> {
        self.workspaces.iter().find(|w| w.root == root)
    }
}

pub fn cloud_file_path(data_dir: &Path) -> PathBuf {
    data_dir.join("cloud.json")
}

/// cloud.json as the engine works with it: roots resolved, and each token
/// where `secrets` keeps it when it keeps them.
pub fn read_cloud_file(data_dir: &Path, secrets: Option<&dyn Secrets>) -> CloudFile {
    let mut file: CloudFile = read_json(&cloud_file_path(data_dir)).unwrap_or_default();
    // A root is written the way `paths` writes one: relative, where the
    // platform can move the app's folder.
    for w in &mut file.workspaces {
        w.root = crate::paths::resolved(&w.root);
    }
    if let Some(secrets) = secrets {
        let mut read = Vec::new();
        for mut w in std::mem::take(&mut file.workspaces) {
            match secrets.secret(&w.ws_id) {
                Ok(token) => {
                    w.token = token.unwrap_or_default();
                    read.push(w);
                }
                Err(_) => file.unread.push(w),
            }
        }
        file.workspaces = read;
    }
    // Tolerate a hand-edited file: entries missing what an engine needs are
    // nothing to sync.
    file.workspaces.retain(|w| {
        !w.root.is_empty()
            && !w.domain.is_empty()
            && !w.endpoint.is_empty()
            && !w.ws_id.is_empty()
            && !w.token.is_empty()
    });
    file
}

/// Write cloud.json. With `secrets`, each token goes to the keeper first and
/// the file holds none; a workspace the file no longer names has its sign-in
/// forgotten once the file is down, so nothing outlives its entry. Entries
/// whose sign-in could not be read go back as they were, theirs untouched.
pub fn write_cloud_file(data_dir: &Path, file: &CloudFile, secrets: Option<&dyn Secrets>) -> Result<(), String> {
    let path = cloud_file_path(data_dir);
    let mut written = file.clone();
    let mut gone = Vec::new();
    if let Some(secrets) = secrets {
        for w in &mut written.workspaces {
            if secrets.secret(&w.ws_id)?.as_deref() != Some(w.token.as_str()) {
                secrets.set_secret(&w.ws_id, Some(&w.token))?;
            }
            w.token = String::new();
        }
        written.workspaces.extend(file.unread.iter().cloned());
        let before: CloudFile = read_json(&path).unwrap_or_default();
        gone = before
            .workspaces
            .into_iter()
            .map(|w| w.ws_id)
            .filter(|id| !written.workspaces.iter().any(|w| &w.ws_id == id))
            .collect();
    }
    for w in &mut written.workspaces {
        w.root = crate::paths::stored(&w.root);
    }
    write_json(&path, &written).map_err(|e| format!("write cloud.json: {}", e))?;
    if let Some(secrets) = secrets {
        for ws_id in gone {
            secrets.set_secret(&ws_id, None)?;
        }
    }
    Ok(())
}

/// The engine's state for one workspace: `state.json` + `base/`.
pub fn state_dir(data_dir: &Path, ws_id: &str) -> PathBuf {
    data_dir.join("cloud").join(ws_id)
}

/// The device identity, minted on first use: a random id and the device's
/// user-facing name (`Setup::device_name`), capped to what the worker keeps.
pub fn ensure_device(
    data_dir: &Path,
    file: &mut CloudFile,
    display_name: &str,
    secrets: Option<&dyn Secrets>,
) -> DeviceIdentity {
    if let Some(d) = file.device.clone() {
        if !d.id.is_empty() {
            return d;
        }
    }
    let d = DeviceIdentity { id: random_id("d"), name: clean_name(display_name, "This device") };
    file.device = Some(d.clone());
    let _ = write_cloud_file(data_dir, file, secrets);
    d
}

/* ---------- The marker ---------- */

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    pub domain: String,
    pub ws_id: String,
    /// Absent: the folder's files are not in Library yet — connect writes
    /// the marker before its move begins. `"moving"`, then `"library"`: the
    /// move (layout.rs). Anything else is a layout a later build made, which
    /// this one does not know.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<String>,
}

impl Marker {
    /// Whether the folder is in the Library layout.
    pub fn moved(&self) -> bool {
        self.layout.as_deref() == Some(super::layout::LIBRARY)
    }
}

pub fn marker_path(root: &Path) -> PathBuf {
    root.join(MARKER_DIR).join(MARKER_FILE)
}

pub fn read_marker(root: &Path) -> Option<Marker> {
    let m: Marker = read_json(&marker_path(root))?;
    if m.domain.is_empty() || m.ws_id.is_empty() {
        return None;
    }
    Some(m)
}

pub fn write_marker(root: &Path, marker: &Marker) -> Result<(), String> {
    write_json(&marker_path(root), marker).map_err(|e| format!("write the folder's cloud marker: {}", e))
}

pub fn remove_marker(root: &Path) {
    let _ = std::fs::remove_file(marker_path(root));
    let _ = std::fs::remove_dir(root.join(MARKER_DIR)); // only when it is now empty
}

/* ---------- Endpoints and names ---------- */

/// A pasted endpoint as the engine keeps it: `https://`, no trailing slash,
/// no path. `http://` is accepted for a loopback address only (a worker
/// under `wrangler dev`).
pub fn normalize_endpoint(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("enter the domain's address".into());
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{}", trimmed)
    };
    let url = url::Url::parse(&with_scheme).map_err(|_| format!("\"{}\" isn't a valid address", raw.trim()))?;
    let host = url.host_str().ok_or_else(|| format!("\"{}\" has no host name", raw.trim()))?;
    let loopback = host == "localhost" || host == "127.0.0.1" || host == "[::1]";
    match url.scheme() {
        "https" => {}
        "http" if loopback => {}
        "http" => return Err("the domain must be served over https".into()),
        other => return Err(format!("unsupported scheme \"{}\"", other)),
    }
    if url.path() != "/" && !url.path().is_empty() {
        return Err("enter just the domain, without a path".into());
    }
    let port = url.port().map(|p| format!(":{}", p)).unwrap_or_default();
    Ok(format!("{}://{}{}", url.scheme(), host, port))
}

/// The host of an endpoint — what the UI calls the domain.
pub fn domain_of(endpoint: &str) -> Option<String> {
    let url = url::Url::parse(endpoint).ok()?;
    let host = url.host_str()?.to_string();
    Some(match url.port() {
        Some(p) => format!("{}:{}", host, p),
        None => host,
    })
}

/// A workspace name as a folder name on disk.
pub fn sanitize_folder_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c == '/' || c == ':' || c == '\0' || c == '\\' { '-' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    if trimmed.is_empty() {
        "Workspace".to_string()
    } else {
        trimmed.chars().take(MAX_NAME_LEN).collect()
    }
}

/// A Mac's user-facing name (System Settings → General → About), the
/// hostname as a fallback: what the Mac app gives as `Setup::device_name`.
pub fn device_display_name() -> String {
    // macOS-only: `scutil --get ComputerName`; the hostname elsewhere.
    let pretty = std::process::Command::new("scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    pretty
        .or_else(|| {
            std::process::Command::new("hostname")
                .output()
                .ok()
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| "This Mac".to_string())
}
