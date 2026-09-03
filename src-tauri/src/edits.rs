//! The one call every write the app makes ends with.
//!
//! `write_file`, `write_frontmatter`, `write_body`, `create_card`,
//! `create_file`, `create_dir`, `move_path`, `copy_path`, `trash_file`,
//! `restore_trashed` — each finishes with `edits::touched(&app, &path)`,
//! which fans the hint out to the two things that care when a file changed:
//!
//! - the **cloud engine** whose root contains the path (docs/cloud.md §6.4),
//!   which settles 1.5 s after the last touch instead of the watcher's 5 s;
//! - the **versioner** for that root (docs/versioning.md §6.1), which uses it
//!   to know a session is under way — one snapshot every ten minutes while
//!   it lasts, and one two minutes after it ends.
//!
//! A hint about *when*, never a substitute for a scan: both sides still walk
//! the tree and decide from content what actually changed. Either half may
//! have nothing running for the path; then it is a no-op.

use tauri::AppHandle;

pub fn touched(app: &AppHandle, path: &str) {
    crate::cloud::touched(app, path);
    crate::versions::touched(app, path);
}
