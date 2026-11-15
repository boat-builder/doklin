//! Where a workspace's sections are on disk.
//!
//! The shared workspace is the folder itself. A person's Private is
//! `Private/` at its top, and each restricted folder they are in is a folder
//! under `Restricted/`. Both names are reserved: nothing under them is ever
//! part of the shared workspace.
//!
//! A folder says it is a space by the marker inside it,
//! `<folder>/.doklin/space.json`. The marker is the only record of which
//! folders on this Mac are spaces — the engine keeps no list of its own — so
//! it survives a restart, a reinstall and a resume, and a folder without one
//! is never deleted on the domain's word.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::config::{read_marker, sanitize_folder_name, MARKER_DIR};
use super::manifest::{cap_utf16, MAX_NAME_LEN};
use super::scan::{read_json, write_json};

/// A person's own section, at the top of the workspace.
pub const PRIVATE_DIR: &str = "Private";
/// What holds the restricted folders, at the top of the workspace.
pub const RESTRICTED_DIR: &str = "Restricted";
/// The names the shared workspace never holds anything under, whatever their
/// case (`RESERVED_FOLDERS`, cloud-worker/src/layout.ts: change both).
pub const RESERVED_DIRS: [&str; 2] = [PRIVATE_DIR, RESTRICTED_DIR];
/// The shared workspace's id among an engine's units, and what a tombstone's
/// `to` says of a file that moved to it.
pub const SHARED: &str = "";

const SPACE_MARKER_FILE: &str = "space.json";

/// The reserved name a workspace-relative path is under, if it is under one.
pub fn reserved_top(rel: &str) -> Option<&'static str> {
    let top = rel.split('/').next().unwrap_or_default();
    RESERVED_DIRS.into_iter().find(|name| name.eq_ignore_ascii_case(top))
}

/// What a walk of the shared part of `root` leaves out: the reserved folders
/// when `root` is a connected workspace — it carries the cloud marker — and
/// nothing when it is an ordinary folder, where the two names mean nothing.
/// The version store asks this too, so a snapshot of the workspace never
/// holds what is in a section of its own.
pub fn shared_skip(root: &Path) -> &'static [&'static str] {
    if read_marker(root).is_some() {
        &RESERVED_DIRS
    } else {
        &[]
    }
}

/* ---------- The marker ---------- */

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceMarker {
    /// The workspace the space is part of: a folder copied in from another
    /// workspace is nobody's here.
    pub ws_id: String,
    pub space: String,
    /// The space's name when this Mac last matched the folder to it — what
    /// tells a rename made here from one made elsewhere.
    #[serde(default)]
    pub name: String,
}

fn space_marker_path(dir: &Path) -> PathBuf {
    dir.join(MARKER_DIR).join(SPACE_MARKER_FILE)
}

pub fn read_space_marker(dir: &Path) -> Option<SpaceMarker> {
    let marker: SpaceMarker = read_json(&space_marker_path(dir))?;
    (!marker.ws_id.is_empty() && !marker.space.is_empty()).then_some(marker)
}

pub fn write_space_marker(dir: &Path, marker: &SpaceMarker) -> Result<(), String> {
    write_json(&space_marker_path(dir), marker).map_err(|e| format!("write the folder's space marker: {}", e))
}

/* ---------- What is on disk ---------- */

/// A folder that says it is a space of this workspace.
#[derive(Clone, Debug)]
pub struct Held {
    pub dir: PathBuf,
    /// Workspace-relative, forward slashes, as the disk spells it: `Private`,
    /// `Restricted/Finance`.
    pub rel: String,
    pub marker: SpaceMarker,
}

/// `dir` — a folder at or under `root` — relative to it, each segment
/// spelled as the disk spells it. The disk does not tell `private` from
/// `Private`, but a path the app sends does, and a section's paths have to
/// match those.
pub fn spelled(root: &Path, dir: &Path) -> String {
    let Ok(rel) = dir.strip_prefix(root) else { return String::new() };
    let mut at = root.to_path_buf();
    let mut out: Vec<String> = Vec::new();
    for part in rel.components() {
        let wanted = part.as_os_str().to_string_lossy().to_string();
        let actual = std::fs::read_dir(&at)
            .ok()
            .and_then(|entries| {
                let names: Vec<String> =
                    entries.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
                names.iter().find(|n| **n == wanted).or_else(|| names.iter().find(|n| n.eq_ignore_ascii_case(&wanted))).cloned()
            })
            .unwrap_or(wanted);
        at.push(&actual);
        out.push(actual);
    }
    out.join("/")
}

/// The entry at the top of `root` called `name`, however the disk spells it —
/// a reserved name is reserved in any case — and where one would go when
/// there is none.
pub fn top(root: &Path, name: &str) -> PathBuf {
    std::fs::read_dir(root)
        .ok()
        .and_then(|entries| {
            entries.flatten().map(|e| e.path()).find(|p| {
                p.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(name))
            })
        })
        .unwrap_or_else(|| root.join(name))
}

fn is_real_dir(path: &Path) -> bool {
    std::fs::symlink_metadata(path).map(|m| m.file_type().is_dir()).unwrap_or(false)
}

/// The folders directly under `Restricted/`, by name. Hidden ones are not
/// folders anybody made on purpose.
fn restricted_dirs(root: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(top(root, RESTRICTED_DIR)) else { return Vec::new() };
    let mut dirs: Vec<(String, PathBuf)> = entries
        .flatten()
        .map(|e| (e.file_name().to_string_lossy().to_string(), e.path()))
        .filter(|(name, path)| !crate::is_hidden_or_ignored(name) && is_real_dir(path))
        .collect();
    dirs.sort();
    dirs
}

/// Every folder in the workspace at `root` whose marker names a space of
/// workspace `ws_id`.
pub fn held(root: &Path, ws_id: &str) -> Vec<Held> {
    let mine = |dir: &Path| read_space_marker(dir).filter(|m| m.ws_id == ws_id);
    let mut out = Vec::new();
    let private = top(root, PRIVATE_DIR);
    if is_real_dir(&private) {
        if let Some(marker) = mine(&private) {
            out.push(Held { rel: spelled(root, &private), dir: private, marker });
        }
    }
    for (_, dir) in restricted_dirs(root) {
        if let Some(marker) = mine(&dir) {
            out.push(Held { rel: spelled(root, &dir), dir, marker });
        }
    }
    out
}

/// The folders under `Restricted/` that are no space of this workspace yet:
/// made there by hand, dragged in, or carrying another workspace's marker.
pub fn unclaimed(root: &Path, ws_id: &str) -> Vec<PathBuf> {
    restricted_dirs(root)
        .into_iter()
        .filter(|(_, dir)| !read_space_marker(dir).is_some_and(|m| m.ws_id == ws_id))
        .map(|(_, dir)| dir)
        .collect()
}

/* ---------- Names ---------- */

/// A name the domain takes for a restricted folder — `validFolderName`,
/// cloud-worker/src/layout.ts: trimmed, not hidden, one segment, capped.
pub fn valid_folder_name(name: &str) -> bool {
    let name = name.trim();
    !name.is_empty()
        && !name.starts_with('.')
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains('\0')
        && name != ".."
        && cap_utf16(name, MAX_NAME_LEN) == name
}

/// The folder names a space called `name`, made by `maker`, may wear on this
/// Mac, in the order they are tried: its own name; its name and who made it,
/// when a folder of that name is already here; then a number.
fn candidates<'a>(name: &'a str, maker: &'a str) -> impl Iterator<Item = String> + 'a {
    let base = sanitize_folder_name(name);
    let by_maker = (!maker.is_empty()).then(|| format!("{} ({})", base, sanitize_folder_name(maker)));
    let numbered = {
        let base = base.clone();
        (2u32..).map(move |n| format!("{} {}", base, n))
    };
    std::iter::once(base).chain(by_maker).chain(numbered)
}

/// Where a restricted folder called `name` goes under `Restricted/`: the
/// first of its names that nothing on disk has taken.
pub fn free_restricted_dir(root: &Path, name: &str, maker: &str) -> PathBuf {
    let parent = top(root, RESTRICTED_DIR);
    candidates(name, maker)
        .map(|candidate| parent.join(candidate))
        .find(|dir| std::fs::symlink_metadata(dir).is_err())
        .unwrap_or_else(|| parent.join(sanitize_folder_name(name)))
}

/// Whether a folder called `actual` is one this Mac would have given a space
/// called `name`: any other name was typed by the user, and is the space's
/// new name.
pub fn names_space(actual: &str, name: &str, maker: &str) -> bool {
    candidates(name, maker).take(64).any(|candidate| candidate == actual)
}

/* ---------- Taking things off this Mac ---------- */

/// Delete a space's folder from this Mac, outright. True when nothing is
/// left at its path.
///
/// Deleting a tree cannot be taken back, so the folder has to be exactly
/// where a space lives — `Private`, or directly under `Restricted` — be a
/// real directory rather than a link to one, and still say in its marker
/// that it is that space of that workspace.
pub fn remove_space_dir(root: &Path, held: &Held) -> bool {
    let in_place = match held.dir.parent() {
        Some(parent) if parent == root => held.dir == top(root, PRIVATE_DIR),
        Some(parent) => parent == top(root, RESTRICTED_DIR),
        None => false,
    };
    if !in_place || !is_real_dir(&held.dir) {
        return false;
    }
    if read_space_marker(&held.dir).as_ref() != Some(&held.marker) {
        return false;
    }
    std::fs::remove_dir_all(&held.dir).is_ok() && !held.dir.exists()
}

/// Remove `dir` and its parents while they are empty, stopping below `stop`.
/// What a file leaves behind when its folder moved to another section: a
/// husk nobody made, which would otherwise sit in the tree for ever. A
/// `.DS_Store` is Finder's, not content.
pub fn prune_empty(dir: &Path, stop: &Path) {
    let mut at = dir.to_path_buf();
    while at != stop && at.starts_with(stop) {
        let only_finder = std::fs::read_dir(&at)
            .map(|entries| entries.flatten().all(|e| e.file_name() == ".DS_Store"))
            .unwrap_or(false);
        if !only_finder {
            return;
        }
        let _ = std::fs::remove_file(at.join(".DS_Store"));
        if std::fs::remove_dir(&at).is_err() {
            return;
        }
        let Some(parent) = at.parent() else { return };
        at = parent.to_path_buf();
    }
}
