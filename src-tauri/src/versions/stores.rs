//! Every store on this Mac, and what the user can do with the set of them
//! (docs/versioning.md §8, docs/versioning-plan.md §8): how much disk each
//! one holds, forgetting one whose folder is gone, and writing a single
//! archive that holds a workspace and its history together.
//!
//! This is the one module besides `retain.rs` that deletes inside a store —
//! and it only ever deletes a whole one, by the user's explicit say-so.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use flate2::write::GzEncoder;
use flate2::Compression;
use serde::Serialize;

use crate::cloud::scan::{read_file_checked, scan_local};

use super::store::{versions_dir, Index, Store};

/// One row of *Other folders*: a store directory, what it holds, and whether
/// the folder it versions is still there.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreInfo {
    pub key: String,
    /// The display root the store was opened on, as its index records it.
    pub root: String,
    /// Is that folder still on this Mac? A store whose root is gone is what
    /// *Forget* is for.
    pub exists: bool,
    /// Everything under the store directory, compressed as it sits.
    pub bytes: u64,
    pub snapshots: u64,
    pub newest_ms: Option<u64>,
}

/// What an export wrote.
#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub bytes: u64,
    pub files: u64,
}

/// A store key is a directory name this code builds (`r-<16 hex>`, or
/// `drafts`); anything else came from somewhere it shouldn't have, and is
/// never joined onto a path.
pub fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 64
        && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Every store directory under `<app_data>/versions/`, newest first. Reading
/// one is an index decode and a directory walk — cheap enough to do on the
/// settings modal opening, and never on the status's path.
pub fn list(data_dir: &Path) -> Vec<StoreInfo> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(versions_dir(data_dir)) else { return out };
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let key = entry.file_name().to_string_lossy().to_string();
        if !valid_key(&key) {
            continue;
        }
        let index: Index = crate::cloud::scan::read_json(&entry.path().join("index.json")).unwrap_or_default();
        out.push(StoreInfo {
            exists: !index.root.is_empty() && Path::new(&index.root).is_dir(),
            root: index.root,
            bytes: dir_bytes(&entry.path()),
            snapshots: index.snapshots.len() as u64,
            newest_ms: index.snapshots.last().map(|row| row.ts),
            key,
        });
    }
    out.sort_by(|a, b| b.newest_ms.cmp(&a.newest_ms).then_with(|| a.key.cmp(&b.key)));
    out
}

/// Delete a whole store directory. Refused while its folder is open — a
/// running versioner holds an index it would write back a moment later, and
/// the user asked to forget that history, not to restart it.
pub fn forget(data_dir: &Path, key: &str, open: &BTreeSet<String>) -> Result<(), String> {
    if !valid_key(key) {
        return Err("That isn't a version store.".to_string());
    }
    if open.contains(key) {
        return Err("That folder is open — close its window first.".to_string());
    }
    let dir = versions_dir(data_dir).join(key);
    if !dir.is_dir() {
        return Err("that folder's history has already been removed.".to_string());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("Couldn't remove that history: {}.", e))
}

/// Every byte under a directory, recursively.
fn dir_bytes(dir: &Path) -> u64 {
    let mut total = 0;
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    for entry in entries.flatten() {
        match entry.file_type() {
            Ok(kind) if kind.is_dir() => total += dir_bytes(&entry.path()),
            Ok(_) => total += entry.metadata().map(|m| m.len()).unwrap_or(0),
            Err(_) => {}
        }
    }
    total
}

/* ---------- The export ---------- */

/// What one archive is called: the folder, the day, and a suffix that says
/// what is inside without needing this app to open it.
pub fn archive_name(root: &Path, day: &str) -> String {
    let folder = root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let folder = folder.replace(['/', ':'], "-");
    let folder = if folder.trim().is_empty() { "Workspace".to_string() } else { folder };
    format!("{} — {}.doklin-backup.tar.gz", folder, day)
}

/// Everything an export will hold: the workspace as `scan_local` sees it,
/// and the store directory verbatim. Both as (path in the archive, path on
/// disk), so the writer below is a loop and nothing else.
fn manifest(root: &Path, store: &Store) -> Result<Vec<(String, PathBuf)>, String> {
    let mut out: Vec<(String, PathBuf)> = Vec::new();
    let tree: BTreeMap<String, _> = scan_local(root)?;
    for (rel, entry) in tree {
        out.push((format!("workspace/{}", rel), entry.abs));
    }
    walk_into(&store.dir, &store.dir, "versions", &mut out);
    Ok(out)
}

fn walk_into(base: &Path, dir: &Path, prefix: &str, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut rows: Vec<_> = entries.flatten().collect();
    rows.sort_by_key(|e| e.file_name());
    for entry in rows {
        let path = entry.path();
        if path.is_dir() {
            walk_into(base, &path, prefix, out);
        } else if let Ok(rel) = path.strip_prefix(base) {
            out.push((format!("{}/{}", prefix, rel.to_string_lossy()), path));
        }
    }
}

/// Write the archive, calling `progress(done, total)` as each file goes in.
/// A file that can't be read is skipped rather than failing the export: the
/// point of this is to get as much out as possible, and the count says how
/// much made it.
pub fn export(
    root: &Path,
    store: &Store,
    dest: &Path,
    day: &str,
    progress: &dyn Fn(u64, u64),
) -> Result<(PathBuf, ExportReport), String> {
    if !dest.is_dir() {
        return Err("That folder isn't there to write into.".to_string());
    }
    let rows = manifest(root, store)?;
    let total = rows.len() as u64;
    let path = dest.join(archive_name(root, day));

    let file = std::fs::File::create(&path).map_err(|e| format!("Couldn't write the archive: {}.", e))?;
    let mut tar = tar::Builder::new(GzEncoder::new(file, Compression::default()));
    let mut report = ExportReport::default();
    for (name, from) in rows {
        progress(report.files, total);
        let Some(bytes) = read_file_checked(&from) else { continue };
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o644);
        header.set_mtime(mtime_secs(&from));
        header.set_cksum();
        if tar.append_data(&mut header, &name, bytes.as_slice()).is_err() {
            continue;
        }
        report.files += 1;
    }
    let gz = tar.into_inner().map_err(|e| format!("Couldn't finish the archive: {}.", e))?;
    gz.finish().map_err(|e| format!("Couldn't finish the archive: {}.", e))?;
    progress(total, total);

    report.bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    Ok((path, report))
}

fn mtime_secs(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
