//! `<app_data>/versions/settings.json` — the kill switch and the horizon.
//! One file for every store, because both settings are the user's answer to
//! "how much history do I want", not a property of any one folder. Phase 5
//! puts a surface on this; phase 1 wires it so a test and the harness can
//! flip it.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::cloud::scan::{read_json, write_json};

use super::store::versions_dir;

pub const SETTINGS_VERSION: u32 = 1;
/// How far back a store keeps versions by default.
pub const DEFAULT_HORIZON_DAYS: u32 = 90;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub version: u32,
    /// False stops every versioner from capturing. They keep answering a
    /// status, and nothing already captured is touched.
    #[serde(default = "yes")]
    pub enabled: bool,
    /// Null means forever.
    #[serde(default = "default_horizon")]
    pub horizon_days: Option<u32>,
}

fn yes() -> bool {
    true
}

fn default_horizon() -> Option<u32> {
    Some(DEFAULT_HORIZON_DAYS)
}

impl Default for Settings {
    fn default() -> Settings {
        Settings { version: SETTINGS_VERSION, enabled: true, horizon_days: default_horizon() }
    }
}

pub fn settings_path(data_dir: &Path) -> std::path::PathBuf {
    versions_dir(data_dir).join("settings.json")
}

pub fn read_settings(data_dir: &Path) -> Settings {
    read_json(&settings_path(data_dir)).unwrap_or_default()
}

pub fn write_settings(data_dir: &Path, settings: &Settings) -> Result<(), String> {
    let _ = std::fs::create_dir_all(versions_dir(data_dir));
    write_json(&settings_path(data_dir), settings).map_err(|e| format!("write the versions settings: {}", e))
}
