//! The two files that say what is connected (docs/cloud-redesign.md §6.3):
//!
//! `<app_data_dir>/cloud.json` — this machine's device identity and, per
//! connected workspace, the folder, the domain, the endpoint, the workspace
//! id and the token. One entry per root, one per domain. Parsed by shape: a
//! malformed file reads as "nothing connected". The token lives here and
//! nowhere else.
//!
//! `<root>/.doklin/cloud.json` — the marker, no secrets: `{domain, wsId}`.
//! Hidden, so the tree walk, search and the sync scan already ignore it. It
//! makes the folder self-describing: a machine that opens a folder carrying
//! a marker with no matching cloud.json entry is offered *resume*, and a
//! folder that already carries a marker for domain A cannot be connected to
//! domain B.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::manifest::{clean_name, MAX_NAME_LEN};
use super::scan::{random_id, read_json, write_json};

pub const CLOUD_FILE_VERSION: u32 = 1;
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
    pub version: u32,
    pub device: Option<DeviceIdentity>,
    pub workspaces: Vec<WorkspaceEntry>,
}

impl CloudFile {
    /// Add (or replace) an entry — one per root, one per domain.
    pub fn upsert(&mut self, entry: WorkspaceEntry) {
        self.workspaces.retain(|w| w.root != entry.root && w.domain != entry.domain);
        self.workspaces.push(entry);
        self.version = CLOUD_FILE_VERSION;
    }

    pub fn remove_root(&mut self, root: &str) {
        self.workspaces.retain(|w| w.root != root);
    }

    pub fn by_root(&self, root: &str) -> Option<&WorkspaceEntry> {
        self.workspaces.iter().find(|w| w.root == root)
    }
}

pub fn cloud_file_path(data_dir: &Path) -> PathBuf {
    data_dir.join("cloud.json")
}

pub fn read_cloud_file(data_dir: &Path) -> CloudFile {
    let mut file: CloudFile = read_json(&cloud_file_path(data_dir)).unwrap_or_default();
    // Tolerate a hand-edited file: entries missing what an engine needs are
    // nothing to sync.
    file.workspaces.retain(|w| {
        !w.root.is_empty() && !w.endpoint.is_empty() && !w.ws_id.is_empty() && !w.token.is_empty()
    });
    for w in &mut file.workspaces {
        if w.domain.is_empty() {
            w.domain = domain_of(&w.endpoint).unwrap_or_else(|| w.endpoint.clone());
        }
    }
    file
}

pub fn write_cloud_file(data_dir: &Path, file: &CloudFile) -> Result<(), String> {
    write_json(&cloud_file_path(data_dir), file).map_err(|e| format!("write cloud.json: {}", e))
}

/// The engine's state for one workspace: `state.json` + `base/`.
pub fn state_dir(data_dir: &Path, ws_id: &str) -> PathBuf {
    data_dir.join("cloud").join(ws_id)
}

/// The device identity, minted on first use: a random id and the Mac's
/// user-facing name, capped to what the worker keeps.
pub fn ensure_device(data_dir: &Path, file: &mut CloudFile) -> DeviceIdentity {
    if let Some(d) = file.device.clone() {
        if !d.id.is_empty() {
            return d;
        }
    }
    let d = DeviceIdentity { id: random_id("d"), name: clean_name(&device_display_name(), "This Mac") };
    file.device = Some(d.clone());
    file.version = CLOUD_FILE_VERSION;
    let _ = write_cloud_file(data_dir, file);
    d
}

/* ---------- The marker ---------- */

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    pub domain: String,
    pub ws_id: String,
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

/// This Mac's user-facing name (System Settings → General → About), the
/// hostname as a fallback.
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
