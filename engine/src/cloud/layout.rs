//! The layout of a connected folder, and the move into it.
//!
//! A connected workspace's folder holds three folders side by side —
//! `Library/`, `My files/`, `Shared with me/` — and every path names where
//! it is (space.rs).
//!
//! The move is how a folder gets there: connecting a folder moves its files
//! into `Library/`, and so does resuming one whose files are not in it yet
//! (`cloud_connect`, `cloud_resume`). It is renames only, on one volume, so
//! every file keeps its size and mtime, and the sync state (`state.json`,
//! `base/`) holds paths relative to Library's unit's root, which is
//! `Library/` from the start. The marker's `layout` says how far it got, and
//! every step is safe to repeat after a crash:
//!
//! 1. `layout` is `"my-files"`: done.
//! 2. Make `.doklin/moving-into-library/` if it is not there.
//! 3. Write `layout: "moving"`.
//! 4. Rename every entry at the top into that folder, except hidden ones
//!    (they belong to the folder, not to a section) and anything under a
//!    section's name.
//! 5. Rename that folder to `Library`.
//! 6. Re-key the version store: the workspace's store becomes Library's.
//! 7. Write `layout: "my-files"`.
//!
//! With `"moving"`, the folder from step 2 still there means step 5 has not
//! run: 4 and 5 again. It gone means step 5 ran: on from 6. Step 2 runs
//! before step 3 so that "moving, and no folder" can only mean that.
//!
//! A folder that already holds something called `Library` at its top does
//! not move until that is renamed: it would be taken for the section.
//!
//! Never while an engine or a watcher runs for the folder: with Library's
//! unit still at the root, the moved files would read as moves into a
//! folder called `Library`, and the manifest would tell every device.
//!
//! ONE-TIME, to be deleted once every device has run it (`from_library`): a
//! folder laid out by the build before sharing in place — `layout:
//! "library"`, with `Private/` and `Restricted/<folder>/` — is brought to
//! this layout as the app starts, before any engine, watcher or versioner
//! runs on it.

use std::path::{Path, PathBuf};

use super::config::{read_marker, write_marker, Marker, MARKER_DIR};
use super::space::{self, LIBRARY, LIBRARY_DIR, MY_FILES_DIR, SHARED_DIR};

/// `layout` while the move is under way.
pub const MOVING: &str = "moving";
/// `layout` once the folder is laid out as this build syncs it.
pub const MY_FILES: &str = "my-files";
/// `layout` as the build before sharing in place left it (`from_library`).
const BEFORE: &str = "library";

/// Where step 4 gathers the shared section's entries, inside the hidden
/// marker folder so no walk ever sees it.
const STAGING: &str = "moving-into-library";

fn staging(root: &Path) -> PathBuf {
    root.join(MARKER_DIR).join(STAGING)
}

const NO_MARKER: &str = "This folder's hidden .doklin folder is missing, so Doklin can't tell how its files are laid out. Disconnect it in Cloud settings and download the workspace again.";
const NEWER: &str = "A newer version of Doklin set this folder up. Update Doklin to sync it.";
const UNFINISHED: &str = "This folder's files aren't in Library yet. Disconnect it in the Cloud panel, then join again with this folder open and choose Resume syncing this folder: Doklin moves them into Library first.";
const NAMES_TAKEN: &str = "Doklin calls your own files “My files” now, and what others share with you “Shared with me”. Something at the top of this workspace's folder already has one of those names. Rename it, then open Doklin again.";

/// Whether a sync engine may run on the workspace at `root`: only once it
/// is in the Library layout. Otherwise the sentence the status shows.
pub fn ready(root: &Path) -> Result<(), String> {
    match read_marker(root) {
        None => Err(NO_MARKER.to_string()),
        Some(marker) if marker.moved() => Ok(()),
        Some(marker) if marker.layout.as_deref().is_none_or(|layout| layout == MOVING) => Err(UNFINISHED.to_string()),
        Some(marker) if marker.layout.as_deref() == Some(BEFORE) => Err(NAMES_TAKEN.to_string()),
        Some(_) => Err(NEWER.to_string()),
    }
}

/// Steps 1 to 3. True when there is the rest to do. Once this has
/// answered true, nothing versions the folder's root (`versions::open_roots`).
pub fn begin(root: &Path) -> Result<bool, String> {
    let Some(mut marker) = read_marker(root) else { return Err(NO_MARKER.to_string()) };
    match marker.layout.as_deref() {
        Some(MY_FILES) | Some(BEFORE) => Ok(false),
        Some(MOVING) => Ok(true),
        Some(_) => Err(NEWER.to_string()),
        None => {
            if holds_library(root) {
                return Err(could_not("it already holds something called “Library”. Rename it, then open Doklin again"));
            }
            std::fs::create_dir_all(staging(root)).map_err(|e| could_not(&format!("make a folder for it: {}", e)))?;
            marker.layout = Some(MOVING.to_string());
            write_marker(root, &marker)?;
            Ok(true)
        }
    }
}

/// Whether the folder at `root` has something called `Library` at its top,
/// whatever its case: what stops a folder not in the layout from moving.
pub fn holds_library(root: &Path) -> bool {
    std::fs::symlink_metadata(space::top(root, LIBRARY_DIR)).is_ok()
}

/// Steps 4 to 7, after `begin` answered true.
pub fn finish(root: &Path, data_dir: &Path) -> Result<(), String> {
    let staging = staging(root);
    if staging.is_dir() {
        gather(root, &staging)?;
        let library = root.join(LIBRARY_DIR);
        if holds_library(root) {
            return Err(could_not("a new “Library” appeared at the top of the folder while it was moving. Move it somewhere else, then open Doklin again"));
        }
        std::fs::rename(&staging, &library).map_err(|e| could_not(&format!("name the folder Library: {}", e)))?;
    }
    let marker = read_marker(root).ok_or_else(|| NO_MARKER.to_string())?;
    rekey_versions(root, &space::top(root, LIBRARY_DIR), data_dir, &marker.ws_id)?;
    write_marker(root, &Marker { layout: Some(MY_FILES.to_string()), ..marker })
}

fn could_not(why: &str) -> String {
    format!("Doklin couldn't move this folder's files into Library: {}.", why)
}

/// Step 4. An entry whose name is already taken in `staging` stays where it
/// is: only something made at the top after a move stopped partway has a
/// name already moved, and at the top it is in no section — on this device
/// only, which loses nothing — where an overwrite would lose the other.
fn gather(root: &Path, staging: &Path) -> Result<(), String> {
    let entries = std::fs::read_dir(root).map_err(|e| could_not(&format!("read the folder: {}", e)))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with('.') || space::section_dir(&name_str).is_some() {
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

/// Step 6. The workspace's version store already holds Library alone, its
/// paths relative to it, so it becomes Library's as it is: renamed to
/// Library's key, its index told its new root. Every snapshot path is right
/// as it stands, and so is every one mirrored to the bucket.
fn rekey_versions(root: &Path, library: &Path, data_dir: &Path, ws_id: &str) -> Result<(), String> {
    let old = crate::versions::store_for_root(data_dir, root);
    rekey(data_dir, &old.key, ws_id, LIBRARY, library).map_err(|e| could_not(&e))
}

/// Give the version store kept under `old` to the section `section` of the
/// workspace `ws_id`, which is at `at` now. A store already under the
/// section's key is left as it is: this ran before.
fn rekey(data_dir: &Path, old: &str, ws_id: &str, section: &str, at: &Path) -> Result<(), String> {
    let new = crate::versions::store_for_section(data_dir, ws_id, section, at, &space::Reach::default());
    if crate::versions::stores::valid_key(old) {
        let old = crate::versions::store::Store::open(data_dir, old, at);
        if old.dir.is_dir() && std::fs::symlink_metadata(&new.dir).is_err() {
            std::fs::rename(&old.dir, &new.dir).map_err(|e| format!("move its version history: {}", e))?;
        }
    }
    retarget(&new, at)
}

/// Tell a section's store where its section is now.
fn retarget(new: &crate::versions::store::Store, at: &Path) -> Result<(), String> {
    if new.index_path().is_file() {
        let mut index = new.read_index();
        let display = at.to_string_lossy().to_string();
        if index.root != display {
            index.root = display;
            new.write_index(&index)?;
        }
    }
    Ok(())
}

/* ---------- ONE-TIME: from Private and Restricted ---------- */
//
// Everything below is run once by each device, as the app starts, on a
// folder the build before sharing in place laid out (`layout: "library"`).
// Delete it — with `BEFORE`, `NAMES_TAKEN` and their arms above, and
// `cloud::init`'s call — once every device has run it: every row under
// Devices seen since the domain's worker took sharing in place, the rest
// signed out.

/// A path the app stored under the old layout, workspace-relative, as it is
/// after `from_library` (`fromLibraryLayout`, src/cloud.ts;
/// `Sections.fromLibraryLayout`, ios/DoklinKit — change all three): what was under `Private/` is under `My files/`,
/// and what was under `Restricted/` is under `Shared with me/`. None for a
/// path that did not move.
pub fn moved_rel(rel: &str) -> Option<String> {
    let (top, rest) = rel.split_once('/').map(|(top, rest)| (top, Some(rest))).unwrap_or((rel, None));
    let now = if top.eq_ignore_ascii_case("Private") {
        MY_FILES_DIR
    } else if top.eq_ignore_ascii_case("Restricted") {
        SHARED_DIR
    } else {
        return None;
    };
    Some(match rest {
        Some(rest) => format!("{}/{}", now, rest),
        None => now.to_string(),
    })
}

/// Bring a folder laid out by the build before sharing in place to this
/// build's layout. True when it did so now. Renames only, each safe to
/// repeat after a crash:
///
/// 1. Each section's version store is re-keyed from its folder's path to
///    its section — first, while the folders are still where the old keys
///    were made from.
/// 2. `Private/` is renamed `My files/`.
/// 3. Each `Restricted/<folder>/` is moved to `Shared with me/<folder>/`,
///    and `Restricted/` goes once it is empty. The first poll then puts a
///    folder its person owns where it sits in their My files
///    (`Engine::reconcile_spaces`).
/// 4. `layout` is written `"my-files"`.
///
/// Refused, with nothing moved, while something else at the top is called
/// `My files` or `Shared with me`.
pub fn from_library(root: &Path, data_dir: &Path) -> Result<bool, String> {
    let Some(marker) = read_marker(root) else { return Ok(false) };
    if marker.layout.as_deref() != Some(BEFORE) {
        return Ok(false);
    }
    let private = space::top(root, "Private");
    let restricted = space::top(root, "Restricted");
    let mine = space::top(root, MY_FILES_DIR);
    let shared = space::top(root, SHARED_DIR);
    let exists = |path: &Path| std::fs::symlink_metadata(path).is_ok();
    let folders: Vec<std::path::PathBuf> = std::fs::read_dir(&restricted)
        .map(|entries| {
            let mut dirs: Vec<_> = entries
                .flatten()
                .filter(|e| !crate::is_hidden_or_ignored(&e.file_name().to_string_lossy()))
                .map(|e| e.path())
                .filter(|path| space::is_real_dir(path))
                .collect();
            dirs.sort();
            dirs
        })
        .unwrap_or_default();
    if (space::is_real_dir(&private) && exists(&mine)) || (!folders.is_empty() && exists(&shared) && !space::is_real_dir(&shared)) {
        return Err(NAMES_TAKEN.to_string());
    }

    // 1. Each store, to its section's key.
    let library = space::top(root, LIBRARY_DIR);
    let path_key = |dir: &Path| crate::versions::store_for_root(data_dir, dir).key;
    if library.is_dir() {
        rekey(data_dir, &path_key(&library), &marker.ws_id, LIBRARY, &library)?;
    }
    for dir in std::iter::once(&private).chain(folders.iter()).filter(|dir| space::is_real_dir(dir)) {
        if let Some(held) = space::read_space_marker(dir).filter(|m| m.ws_id == marker.ws_id) {
            rekey(data_dir, &path_key(dir), &marker.ws_id, &held.space, dir)?;
        }
    }
    // 2. Private is My files.
    if space::is_real_dir(&private) {
        std::fs::rename(&private, root.join(MY_FILES_DIR)).map_err(|e| format!("Doklin couldn't rename Private to My files: {}.", e))?;
    }
    // 3. What was under Restricted is under Shared with me.
    if !folders.is_empty() {
        let shared = root.join(SHARED_DIR);
        std::fs::create_dir_all(&shared).map_err(|e| format!("Doklin couldn't make Shared with me: {}.", e))?;
        for dir in &folders {
            let name = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let to = shared.join(space::free_name(&name, "", |cand| exists(&shared.join(cand))));
            std::fs::rename(dir, &to).map_err(|e| format!("Doklin couldn't move “{}” to Shared with me: {}.", name, e))?;
        }
    }
    space::prune_empty(&restricted, root);
    // The stores say where their sections are now.
    for held in space::held(root, &marker.ws_id) {
        let store = crate::versions::store_for_section(data_dir, &marker.ws_id, &held.marker.space, &held.dir, &space::Reach::default());
        retarget(&store, &held.dir)?;
    }
    write_marker(root, &Marker { layout: Some(MY_FILES.to_string()), ..marker })?;
    Ok(true)
}
