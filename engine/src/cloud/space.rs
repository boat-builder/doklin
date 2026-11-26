//! Where a workspace's sections are on disk.
//!
//! A connected workspace's folder holds three folders side by side:
//! `Library/` is everyone's, `My files/` this person's own, and `Shared with
//! me/` holds what others shared with them, each under its own name.
//! Anything else at the top is in no section: it stays on this device and
//! syncs nowhere.
//!
//! Sections are a tree. Something shared — a folder, or one document — is a
//! section of its own that sits where its item is: inside My files, or
//! inside another shared folder, for whoever can open that; at the top of
//! `Shared with me/` for the people it is shared with. So one folder on disk
//! can hold several sections: what a section is of it, is its [`Reach`].
//!
//! A shared folder says it is one by the marker inside it,
//! `<folder>/.doklin/space.json`, and so does My files. The marker travels
//! with the folder, so a folder moved in Finder is still that share. A
//! shared document has none: which files are its own is in its unit's state
//! (`DocPlace`, unit.rs). A folder without a marker is never deleted on the
//! domain's word.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::config::MARKER_DIR;
use super::manifest::MAX_PATH_DEPTH;
use super::scan::{read_json, write_json};

/// The three folders at the top of a workspace (`LIBRARY_FOLDER`,
/// `MY_FILES_FOLDER`, `SHARED_FOLDER`, cloud-worker/src/layout.ts;
/// `SECTION_DIRS`, src/cloud.ts; `TreeModel`, the iPhone's Tree.swift:
/// change all four). The browser version places a section's documents under
/// the same names, and names a share as `candidates` does
/// (src/web/workspace.ts): change both.
pub const LIBRARY_DIR: &str = "Library";
pub const MY_FILES_DIR: &str = "My files";
pub const SHARED_DIR: &str = "Shared with me";
pub const SECTION_DIRS: [&str; 3] = [LIBRARY_DIR, MY_FILES_DIR, SHARED_DIR];
/// Library's id among an engine's units, and what a tombstone's `to` says of
/// a file that moved to it.
pub const LIBRARY: &str = "";

const SPACE_MARKER_FILE: &str = "space.json";

/// The longest name a shared folder or document carries
/// (`MAX_ITEM_NAME_LEN`, cloud-worker/src/layout.ts — change both).
pub const MAX_ITEM_NAME_LEN: usize = 200;

/// Which of the three folders an entry at the top of the workspace is, if it
/// is one: a name is a section's in any case.
pub fn section_dir(name: &str) -> Option<&'static str> {
    SECTION_DIRS.into_iter().find(|dir| dir.eq_ignore_ascii_case(name))
}

/* ---------- What a section is of a folder ---------- */

/// A shared document's name: the one its files have on this device, and the
/// one its manifest calls it. They differ where something else there has its
/// name (`candidates`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocName {
    pub local: String,
    pub stored: String,
}

/// What of a folder one section is: everything under it but what is another
/// section's — or, for a shared document, that document's files and nothing
/// else. The sync and the version store both walk a folder by it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Reach {
    /// Folders of it that are other sections' own: relative, forward slashes.
    pub dirs: Vec<String>,
    /// Documents of it that are other sections' own: their paths, relative,
    /// without an extension.
    pub docs: Vec<String>,
    /// For a shared document: the folder is the one it sits in, and of that
    /// folder only the document's own files are this section.
    pub only: Option<DocName>,
}

impl Reach {
    /// A shared document's reach.
    pub fn document(local: &str, stored: &str) -> Reach {
        Reach { dirs: Vec::new(), docs: Vec::new(), only: Some(DocName { local: local.to_string(), stored: stored.to_string() }) }
    }

    /// Whether the folder at `rel` is another section's: a walk never enters it.
    pub fn skips_dir(&self, rel: &str) -> bool {
        self.dirs.iter().any(|dir| dir.eq_ignore_ascii_case(rel))
    }

    /// Whether the file at `rel` is another section's document.
    pub fn skips_file(&self, rel: &str) -> bool {
        if self.docs.is_empty() {
            return false;
        }
        let (dir, name) = rel.rsplit_once('/').map(|(d, n)| (Some(d), n)).unwrap_or((None, rel));
        let (stem, _) = split_name(name);
        let doc = match dir {
            Some(dir) => format!("{}/{}", dir, stem),
            None => stem.to_string(),
        };
        self.docs.iter().any(|d| d.eq_ignore_ascii_case(&doc))
    }

    /// Whether a path under the folder is this section's.
    pub fn holds(&self, rel: &str) -> bool {
        if let Some(name) = &self.only {
            return !rel.contains('/') && split_name(rel).0.eq_ignore_ascii_case(&name.stored);
        }
        if self.skips_file(rel) {
            return false;
        }
        let mut at = 0;
        while let Some(slash) = rel[at..].find('/') {
            at += slash;
            if self.skips_dir(&rel[..at]) {
                return false;
            }
            at += 1;
        }
        !self.skips_dir(rel)
    }

    /// A file's name on this device as its section's manifest names it: for
    /// a shared document, its stored name; anything else as it stands.
    pub fn stored(&self, rel: &str) -> String {
        match &self.only {
            Some(name) => renamed(rel, &name.local, &name.stored),
            None => rel.to_string(),
        }
    }

    /// The other way: a path of the section as this device's disk has it.
    pub fn local(&self, rel: &str) -> String {
        match &self.only {
            Some(name) => renamed(rel, &name.stored, &name.local),
            None => rel.to_string(),
        }
    }
}

/// A file's name as the name its document goes by, and the rest: `plan.md`,
/// `plan.html` and `plan.meta.jsonl` are one document, `plan` (`splitName`,
/// cloud-worker/src/mount.ts — change both).
pub fn split_name(name: &str) -> (&str, &str) {
    const META: &str = ".meta.jsonl";
    if name.len() > META.len() && name[name.len() - META.len()..].eq_ignore_ascii_case(META) {
        return name.split_at(name.len() - META.len());
    }
    match name.rfind('.') {
        Some(dot) if dot > 0 => name.split_at(dot),
        _ => (name, ""),
    }
}

/// A file's name, said as `to` where its document is called `from`.
fn renamed(name: &str, from: &str, to: &str) -> String {
    let (stem, rest) = split_name(name);
    if stem.eq_ignore_ascii_case(from) {
        format!("{}{}", to, rest)
    } else {
        name.to_string()
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
    /// The folder of the section it sits in that this Mac last matched it
    /// to (`Mount::dir`) — what tells a move made here from one made
    /// elsewhere. Nothing for one this person cannot place.
    #[serde(default)]
    pub dir: String,
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

/// Take a folder's marker away: it is an ordinary folder again.
pub fn remove_space_marker(dir: &Path) {
    let _ = std::fs::remove_file(space_marker_path(dir));
    let _ = std::fs::remove_dir(dir.join(MARKER_DIR));
}

/* ---------- What is on disk ---------- */

/// A folder that says it is a space of this workspace.
#[derive(Clone, Debug)]
pub struct Held {
    pub dir: PathBuf,
    /// Workspace-relative, forward slashes, as the disk spells it: `My
    /// files`, `My files/Work/Plans`, `Shared with me/Finance`.
    pub rel: String,
    pub marker: SpaceMarker,
}

/// `dir` — a folder at or under `root` — relative to it, each segment
/// spelled as the disk spells it. The disk does not tell `library` from
/// `Library`, but a path the app sends does, and a section's paths have to
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
/// a section's name is its own in any case — and where one would go when
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

pub fn is_real_dir(path: &Path) -> bool {
    std::fs::symlink_metadata(path).map(|m| m.file_type().is_dir()).unwrap_or(false)
}

/// Every folder in the workspace at `root` whose marker names a space of
/// workspace `ws_id`: My files, and each shared folder wherever it is — in
/// My files, inside another shared folder, under `Shared with me`, or
/// dragged somewhere it does not belong. A walk of the whole workspace, so
/// it is asked when an engine starts and when a folder is not where it was,
/// never on a clock.
///
/// Two folders that say they are one space are a folder and a copy of it
/// made outside the app, marker and all. The one that is where its marker
/// says — called what the space is called, in the folder it sat in — is the
/// space; the other is an ordinary folder, shared with nobody, and stops
/// saying otherwise.
pub fn held(root: &Path, ws_id: &str) -> Vec<Held> {
    let mut found = Vec::new();
    for name in SECTION_DIRS {
        let dir = top(root, name);
        if is_real_dir(&dir) {
            find_markers(root, &dir, 1, ws_id, &mut found);
        }
    }
    let fits = |held: &Held| {
        let (around, name) = held.rel.rsplit_once('/').unwrap_or(("", held.rel.as_str()));
        let named = name.eq_ignore_ascii_case(&held.marker.name);
        let placed = !held.marker.dir.is_empty()
            && around.len() >= held.marker.dir.len()
            && around[around.len() - held.marker.dir.len()..].eq_ignore_ascii_case(&held.marker.dir);
        (named, placed)
    };
    let mut out: Vec<Held> = Vec::new();
    for held in found {
        match out.iter_mut().find(|kept| kept.marker.space == held.marker.space) {
            None => out.push(held),
            Some(kept) if fits(&held) > fits(kept) => {
                remove_space_marker(&kept.dir);
                *kept = held;
            }
            Some(_) => remove_space_marker(&held.dir),
        }
    }
    out
}

fn find_markers(root: &Path, dir: &Path, depth: usize, ws_id: &str, out: &mut Vec<Held>) {
    if let Some(marker) = read_space_marker(dir).filter(|m| m.ws_id == ws_id) {
        out.push(Held { rel: spelled(root, dir), dir: dir.to_path_buf(), marker });
    }
    if depth >= MAX_PATH_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| !crate::is_hidden_or_ignored(&e.file_name().to_string_lossy()))
        .map(|e| e.path())
        .filter(|path| is_real_dir(path))
        .collect();
    dirs.sort();
    for sub in dirs {
        find_markers(root, &sub, depth + 1, ws_id, out);
    }
}

/* ---------- Names ---------- */

/// A name the domain takes for something shared — `validItemName`,
/// cloud-worker/src/layout.ts: trimmed, not hidden, one segment, capped.
pub fn valid_item_name(name: &str) -> bool {
    let trimmed = name.trim();
    !trimmed.is_empty()
        && trimmed == name
        && !name.starts_with('.')
        && !name.contains(['/', ':', '\\', '\0'])
        && name != ".."
        && name.chars().count() <= MAX_ITEM_NAME_LEN
}

/// A name a file on this device can carry (`fileName`,
/// cloud-worker/src/agentPlace.ts — change both).
pub fn item_name(name: &str) -> String {
    let cleaned: String = name.chars().map(|c| if matches!(c, '/' | ':' | '\0' | '\\') { '-' } else { c }).collect();
    let trimmed = cleaned.trim().trim_matches('.');
    if trimmed.is_empty() {
        "Untitled".to_string()
    } else {
        trimmed.chars().take(MAX_ITEM_NAME_LEN).collect()
    }
}

/// The names something shared, called `name` and owned by `owner`, may wear
/// on this device, in the order they are tried: its own name; its name and
/// its owner's, when something there has its name; then a number.
fn candidates<'a>(name: &'a str, owner: &'a str) -> impl Iterator<Item = String> + 'a {
    let base = item_name(name);
    let by_owner = (!owner.is_empty()).then(|| format!("{} ({})", base, item_name(owner)));
    let numbered = {
        let base = base.clone();
        (2u32..).map(move |n| format!("{} {}", base, n))
    };
    std::iter::once(base).chain(by_owner).chain(numbered)
}

/// The first of a share's names that `taken` says is free.
pub fn free_name(name: &str, owner: &str, taken: impl Fn(&str) -> bool) -> String {
    candidates(name, owner).take(1000).find(|candidate| !taken(candidate)).unwrap_or_else(|| item_name(name))
}

/// Whether something called `actual` here is called what this device would
/// have called a share named `name`: any other name was typed by a person,
/// and is the share's new name.
pub fn names_item(actual: &str, name: &str, owner: &str) -> bool {
    candidates(name, owner).take(64).any(|candidate| candidate == actual)
}

/// Whether the folder `dir` has something called `name`: a folder of that
/// name for a shared folder, a document of that name — any file of one —
/// for a shared document.
pub fn name_taken(dir: &Path, name: &str, document: bool) -> bool {
    if !document {
        return std::fs::symlink_metadata(dir.join(name)).is_ok();
    }
    std::fs::read_dir(dir).is_ok_and(|entries| {
        entries.flatten().any(|e| {
            let file = e.file_name().to_string_lossy().to_string();
            crate::syncs(&file) && split_name(&file).0.eq_ignore_ascii_case(name)
        })
    })
}

/// The files of the document called `stem` in `dir`: every file that syncs
/// and has its name.
pub fn document_files(dir: &Path, stem: &str) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| {
            let file = e.file_name().to_string_lossy().to_string();
            crate::syncs(&file) && split_name(&file).0.eq_ignore_ascii_case(stem)
        })
        .map(|e| e.path())
        .filter(|path| path.is_file())
        .collect();
    files.sort();
    files
}

/* ---------- Taking things off this Mac ---------- */

/// Delete a space's folder from this Mac, outright. True when nothing is
/// left at its path.
///
/// Deleting a tree cannot be taken back, so the folder has to be inside the
/// workspace and not one of its three top folders, be a real directory
/// rather than a link to one, and still say in its marker that it is that
/// space of that workspace.
pub fn remove_space_dir(root: &Path, held: &Held) -> bool {
    let inside = held.dir.starts_with(root) && held.dir.parent().is_some_and(|parent| parent != root);
    if !inside || !is_real_dir(&held.dir) {
        return false;
    }
    if read_space_marker(&held.dir).is_none_or(|m| m.ws_id != held.marker.ws_id || m.space != held.marker.space) {
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
