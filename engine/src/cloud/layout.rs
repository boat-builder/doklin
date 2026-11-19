//! The Library layout, and the one move into it.
//!
//! A connected workspace's folder holds its sections side by side —
//! `Library/`, `Private/`, `Restricted/<folder>/` — and every path names its
//! section (space.rs). Before it, the shared section was the folder itself.
//!
//! The move is a one-time stored-data migration: each device moves its own
//! folder once, before anything syncs it, and nothing is sent. It is renames
//! only, on one volume, so every file keeps its size and mtime and the first
//! survey after it finds nothing changed; the sync state (`state.json`,
//! `base/`) holds paths relative to the shared unit's root and needs no
//! rewrite once that root is `Library/`. The marker's `layout` says how far
//! it got, and every step is safe to repeat after a crash:
//!
//! 1. `layout` is `"library"`: done.
//! 2. Make `.doklin/moving-into-library/` if it is not there.
//! 3. Write `layout: "moving"`.
//! 4. Rename every entry at the top into that folder, except hidden ones
//!    (they belong to the folder, not to a section) and the `Private` and
//!    `Restricted` folders. A shared folder already called `Library` goes in
//!    with the rest.
//! 5. Rename that folder to `Library`.
//! 6. Re-key the version store: the workspace's store becomes Library's.
//! 7. Write `layout: "library"`.
//!
//! With `"moving"`, the folder from step 2 still there means step 5 has not
//! run: 4 and 5 again. It gone means step 5 ran: on from 6. Step 2 runs
//! before step 3 so that "moving, and no folder" can only mean that.
//!
//! Never while an engine or a watcher runs for the folder: with the shared
//! unit still at the root, the moved files would read as moves into a shared
//! folder called `Library`, and the manifest would tell every device.

use std::path::{Path, PathBuf};

use super::config::{read_marker, write_marker, Marker, MARKER_DIR};
use super::space::{self, LIBRARY_DIR, PRIVATE_DIR, RESTRICTED_DIR};

/// `layout` while the move is under way.
pub const MOVING: &str = "moving";
/// `layout` once the folder is in the Library layout.
pub const LIBRARY: &str = "library";

/// Where step 4 gathers the shared section's entries, inside the hidden
/// marker folder so no walk ever sees it.
const STAGING: &str = "moving-into-library";

fn staging(root: &Path) -> PathBuf {
    root.join(MARKER_DIR).join(STAGING)
}

const NO_MARKER: &str = "This folder's hidden .doklin folder is missing, so Doklin can't tell how its files are laid out. Disconnect it in Cloud settings and download the workspace again.";
const NEWER: &str = "A newer version of Doklin set this folder up. Update Doklin to sync it.";
const UNFINISHED: &str = "Doklin hasn't finished moving this folder's files into Library. Quit Doklin and open it again to finish.";

/// Whether a sync engine may run on the workspace at `root`: only once it
/// is in the Library layout. Otherwise the sentence the status shows — for
/// a move that is not finished, what stopped this launch's try at it
/// (`stopped`), when one did.
pub fn ready(root: &Path, stopped: Option<&str>) -> Result<(), String> {
    match read_marker(root) {
        None => Err(NO_MARKER.to_string()),
        Some(marker) if marker.moved() => Ok(()),
        Some(marker) if marker.layout.as_deref().is_none_or(|layout| layout == MOVING) => {
            Err(stopped.unwrap_or(UNFINISHED).to_string())
        }
        Some(_) => Err(NEWER.to_string()),
    }
}

/// The whole move, for a folder nothing is watching (`begin`, then
/// `finish`). True when the folder moved just now.
pub fn move_into_library(root: &Path, data_dir: &Path) -> Result<bool, String> {
    let moving = begin(root)?;
    if moving {
        finish(root, data_dir)?;
    }
    Ok(moving)
}

/// Steps 1 to 3. True when there is the rest to do. Once this has
/// answered true, nothing versions the folder's root (`versions::open_roots`).
pub fn begin(root: &Path) -> Result<bool, String> {
    let Some(mut marker) = read_marker(root) else { return Err(NO_MARKER.to_string()) };
    match marker.layout.as_deref() {
        Some(LIBRARY) => Ok(false),
        Some(MOVING) => Ok(true),
        Some(_) => Err(NEWER.to_string()),
        None => {
            std::fs::create_dir_all(staging(root)).map_err(|e| could_not(&format!("make a folder for it: {}", e)))?;
            marker.layout = Some(MOVING.to_string());
            write_marker(root, &marker)?;
            Ok(true)
        }
    }
}

/// Steps 4 to 7, after `begin` answered true.
pub fn finish(root: &Path, data_dir: &Path) -> Result<(), String> {
    let staging = staging(root);
    if staging.is_dir() {
        gather(root, &staging)?;
        let library = root.join(LIBRARY_DIR);
        if std::fs::symlink_metadata(&library).is_ok() {
            return Err(could_not("a new “Library” appeared at the top of the folder while it was moving. Move it somewhere else, then open Doklin again"));
        }
        std::fs::rename(&staging, &library).map_err(|e| could_not(&format!("name the folder Library: {}", e)))?;
    }
    rekey_versions(root, &space::top(root, LIBRARY_DIR), data_dir)?;
    let marker = read_marker(root).ok_or_else(|| NO_MARKER.to_string())?;
    write_marker(root, &Marker { layout: Some(LIBRARY.to_string()), ..marker })
}

fn could_not(why: &str) -> String {
    format!("Doklin couldn't move this folder's files into Library: {}.", why)
}

/// Step 4. An entry whose name is already taken in `staging` stays where it
/// is: only something made at the top after a move stopped partway has a
/// name already moved, and at the top it is in no section — on this device
/// only, which loses nothing — where an overwrite would lose the other.
fn gather(root: &Path, staging: &Path) -> Result<(), String> {
    let private = space::top(root, PRIVATE_DIR);
    let restricted = space::top(root, RESTRICTED_DIR);
    let entries = std::fs::read_dir(root).map_err(|e| could_not(&format!("read the folder: {}", e)))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') || path == private || path == restricted {
            continue;
        }
        let to = staging.join(&name);
        if std::fs::symlink_metadata(&to).is_ok() {
            continue;
        }
        std::fs::rename(&path, &to)
            .map_err(|e| could_not(&format!("move “{}”: {}", name.to_string_lossy(), e)))?;
    }
    Ok(())
}

/// Step 6. The workspace's version store already holds the shared section
/// alone, its paths relative to it (`space::shared_skip`), so it becomes
/// Library's as it is: renamed to Library's key, its index told its new
/// root. Every snapshot path is right as it stands, and so is every one
/// mirrored to the bucket.
fn rekey_versions(root: &Path, library: &Path, data_dir: &Path) -> Result<(), String> {
    let old = crate::versions::store_for_root(data_dir, root);
    let new = crate::versions::store_for_root(data_dir, library);
    if old.dir.is_dir() && std::fs::symlink_metadata(&new.dir).is_err() {
        std::fs::rename(&old.dir, &new.dir).map_err(|e| could_not(&format!("move its version history: {}", e)))?;
    }
    if new.index_path().is_file() {
        let mut index = new.read_index();
        let display = library.to_string_lossy().to_string();
        if index.root != display {
            index.root = display;
            new.write_index(&index).map_err(|e| could_not(&e))?;
        }
    }
    Ok(())
}

/// A path under a workspace that has just moved, as it is now: what a path
/// an app stored before the move — a tab, an open folder — becomes. `rel` is
/// relative to the workspace's root; one that already starts with a section
/// or a hidden name is left as it is (`toLibraryLayout`, src/cloud.ts;
/// `Sections.moved`, the iPhone's Sections.swift: change all three).
pub fn moved_rel(rel: &str) -> String {
    let top = rel.split('/').next().unwrap_or_default();
    if rel.is_empty() || top.starts_with('.') || space::SECTION_DIRS.iter().any(|name| name.eq_ignore_ascii_case(top)) {
        rel.to_string()
    } else {
        format!("{}/{}", LIBRARY_DIR, rel)
    }
}
