//! The one call every write the app makes ends with.
//!
//! `write_file`, `create_file`, `create_dir`, `move_path`, `copy_path`,
//! `trash_file`, `restore_trashed` — each finishes with `edits::touched(&app, &path)`,
//! which fans the hint out to the two things that care when a file changed
//! (`Core::touched`, in the engine crate):
//!
//! - the **cloud engine** whose root contains the path,
//!   which settles 1.5 s after the last touch instead of the watcher's 5 s;
//! - the **versioner** for that root, which uses it
//!   to know a session is under way — one snapshot every ten minutes while
//!   it lasts, and one two minutes after it ends.
//!
//! A hint about *when*, never a substitute for a scan: both sides still walk
//! the tree and decide from content what actually changed. Either half may
//! have nothing running for the path; then it is a no-op, as it is before
//! the engine exists.

use tauri::AppHandle;

pub fn touched(app: &AppHandle, path: &str) {
    if let Some(core) = crate::engine::try_core(app) {
        core.touched(path);
    }
}
