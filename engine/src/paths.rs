//! Paths as they are written down.
//!
//! On a Mac a folder stays where it is, and what is written down is its path.
//! iOS gives an app's own folder a new path on an update or a restore, so
//! there nothing written down may hold one: `Setup::anchor` names that
//! folder, and every path kept on disk — a workspace's root in `cloud.json`,
//! the root in a version store's index, the path a store's key is made from —
//! is kept relative to it, and resolved against wherever it is now.
//!
//! With no anchor (the Mac, every test) both functions hand back what they
//! were given.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static ANCHOR: OnceLock<PathBuf> = OnceLock::new();

/// Said once, at boot (`Core::new`). A second call is ignored.
pub(crate) fn set_anchor(dir: PathBuf) {
    let _ = ANCHOR.set(dir);
}

/// A path as it is written down.
pub fn stored(path: &str) -> String {
    stored_under(ANCHOR.get().map(PathBuf::as_path), path)
}

/// A written-down path as it is now.
pub fn resolved(stored: &str) -> String {
    resolved_under(ANCHOR.get().map(PathBuf::as_path), stored)
}

fn stored_under(anchor: Option<&Path>, path: &str) -> String {
    let Some(anchor) = anchor else { return path.to_string() };
    // Asked of the anchor as it was given and as it resolves: iOS spells the
    // same folder through `/var` and `/private/var`.
    let real = std::fs::canonicalize(anchor).ok();
    let under = |base: &Path| Path::new(path).strip_prefix(base).ok().map(|rel| rel.to_string_lossy().to_string());
    under(anchor).or_else(|| real.as_deref().and_then(under)).unwrap_or_else(|| path.to_string())
}

fn resolved_under(anchor: Option<&Path>, stored: &str) -> String {
    match anchor {
        Some(anchor) if Path::new(stored).is_relative() => anchor.join(stored).to_string_lossy().to_string(),
        _ => stored.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn with_no_anchor_a_path_is_written_as_it_is() {
        assert_eq!(stored_under(None, "/Users/ada/Doklin/Notes"), "/Users/ada/Doklin/Notes");
        assert_eq!(resolved_under(None, "/Users/ada/Doklin/Notes"), "/Users/ada/Doklin/Notes");
        assert_eq!(resolved_under(None, "Documents/Notes"), "Documents/Notes");
    }

    #[test]
    fn under_an_anchor_a_path_is_written_relative_and_follows_it() {
        let then = tempfile::tempdir().unwrap();
        let root = then.path().join("Documents").join("Notes");
        std::fs::create_dir_all(&root).unwrap();
        let written = stored_under(Some(then.path()), &root.to_string_lossy());
        assert_eq!(written, "Documents/Notes");

        // The folder moved: what was written resolves under where it is now.
        let now = Path::new("/somewhere/else");
        assert_eq!(resolved_under(Some(now), &written), "/somewhere/else/Documents/Notes");
    }

    #[test]
    fn a_path_spelled_through_a_link_is_still_under_the_anchor() {
        let dir = tempfile::tempdir().unwrap();
        let real = std::fs::canonicalize(dir.path()).unwrap();
        let link = dir.path().join("link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, &link).unwrap();
        #[cfg(unix)]
        assert_eq!(stored_under(Some(&link), &real.join("Notes").to_string_lossy()), "Notes");
    }

    #[test]
    fn a_path_outside_the_anchor_is_left_alone() {
        let anchor = Path::new("/var/app");
        assert_eq!(stored_under(Some(anchor), "/elsewhere/Notes"), "/elsewhere/Notes");
        assert_eq!(resolved_under(Some(anchor), "/elsewhere/Notes"), "/elsewhere/Notes");
    }
}
