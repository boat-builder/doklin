//! intel-mac: the Intel build's check of the web engine. Doklin's frontend
//! needs Safari 17's engine; macOS 12 ships Safari 15's, and only a Safari
//! update replaces it. `safari_check.js` runs in every window before the
//! page's own scripts. On an engine that is too old, it keeps them from
//! running and shows how to update Safari, with these commands behind its
//! buttons.

use std::process::Command;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Runtime};

/// Puts `safari_check.js` into every window's main frame, ahead of its page.
pub(crate) fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("safari-check")
        .js_init_script(include_str!("safari_check.js"))
        .build()
}

/// The installed Safari's version (e.g. "15.6"), for the message. `None` when
/// it can't be read.
#[tauri::command]
pub(crate) fn safari_check_version() -> Option<String> {
    let out = Command::new("/usr/bin/defaults")
        .args(["read", "/Applications/Safari.app/Contents/Info", "CFBundleShortVersionString"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let version = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (!version.is_empty()).then_some(version)
}

/// Opens System Preferences at Software Update, where Safari updates are.
#[tauri::command]
pub(crate) fn safari_check_open_update() -> Result<(), String> {
    let opened = Command::new("/usr/bin/open")
        .arg("x-apple.systempreferences:com.apple.preferences.softwareupdate")
        .status()
        .is_ok_and(|status| status.success());
    if opened {
        Ok(())
    } else {
        Err("Software Update didn't open. Open the Apple menu, choose System Preferences, then Software Update.".into())
    }
}

/// Quits outright: no window here has anything to save.
#[tauri::command]
pub(crate) fn safari_check_quit(app: AppHandle) {
    app.exit(0);
}
