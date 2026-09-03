//! The local half of the engine's world: walking the workspace with the
//! sidebar's eyes, content hashing, checked reads, the atomic write, the
//! small stat and id helpers. Nothing in here knows about the worker.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::manifest::{valid_rel_path, MAX_PATH_DEPTH};

/// Mirrors the worker's caps (and the app's own tree caps) so the engine
/// never builds a workspace the other side would reject.
pub const MAX_SYNC_FILE_BYTES: u64 = 25 * 1024 * 1024;
pub const MAX_SYNC_ENTRIES: usize = 5000;
/// The suffix of the engine's own in-flight writes; a scan never sees them.
pub const TMP_SUFFIX: &str = ".doklin-sync-tmp";

#[derive(Clone, Debug)]
pub struct ScanEntry {
    pub abs: PathBuf,
    pub size: u64,
    pub mtime_ms: u64,
}

/// Walk the workspace with the same eyes as the sidebar tree: skip dotfiles
/// and build junk (`crate::is_hidden_or_ignored` — which also hides the
/// `.doklin/` marker), bounded depth and entry count — but include every
/// file type (images and assets sync too), skipping only what the worker
/// would refuse: oversized files and paths outside its grammar.
pub fn scan_local(root: &Path) -> Result<BTreeMap<String, ScanEntry>, String> {
    let mut out = BTreeMap::new();
    let mut budget = MAX_SYNC_ENTRIES;
    scan_dir(root, root, 1, &mut budget, &mut out)?;
    Ok(out)
}

/// `depth` is the number of path segments a file directly in `dir` has.
fn scan_dir(
    root: &Path,
    dir: &Path,
    depth: usize,
    budget: &mut usize,
    out: &mut BTreeMap<String, ScanEntry>,
) -> Result<(), String> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Ok(()), // unreadable directory: skip, don't fail the scan
    };
    for entry in entries.flatten() {
        if *budget == 0 {
            return Err(format!(
                "workspace has more than {} entries — too large to sync",
                MAX_SYNC_ENTRIES
            ));
        }
        *budget -= 1;
        let name = entry.file_name().to_string_lossy().to_string();
        if crate::is_hidden_or_ignored(&name) || name.ends_with(TMP_SUFFIX) {
            continue;
        }
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if ft.is_symlink() {
            continue;
        }
        let path = entry.path();
        if ft.is_dir() {
            if depth < MAX_PATH_DEPTH {
                scan_dir(root, &path, depth + 1, budget, out)?;
            }
        } else if ft.is_file() {
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.len() > MAX_SYNC_FILE_BYTES {
                continue; // too big to sync; deliberately invisible to the engine
            }
            let Some(rel) = rel_path(root, &path) else { continue };
            if !valid_rel_path(&rel) {
                continue; // a name the worker's grammar refuses: invisible too
            }
            let mtime_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            out.insert(rel, ScanEntry { abs: path, size: meta.len(), mtime_ms });
        }
    }
    Ok(())
}

/// The edit bus's filter: `abs` as a workspace-relative path, or None when
/// it is not a file the scan would ever see — outside the root, the root
/// itself, a hidden or ignored segment, one of our own temp files. The
/// cloud's bus and the versioner's share it so they can't drift.
pub fn rel_for_touch(root: &Path, abs: &Path) -> Option<String> {
    let rel = rel_path(root, abs)?;
    if rel.is_empty() {
        return None;
    }
    let bad = rel
        .split('/')
        .any(|seg| crate::is_hidden_or_ignored(seg) || seg.ends_with(TMP_SUFFIX));
    if bad {
        None
    } else {
        Some(rel)
    }
}

/// `abs` relative to `root` with forward slashes, or None when it lies
/// outside the root.
pub fn rel_path(root: &Path, abs: &Path) -> Option<String> {
    let rel = abs.strip_prefix(root).ok()?;
    let parts: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect();
    Some(parts.join("/"))
}

/// Content address: the first 16 hex chars of the sha256. 64 bits is beyond
/// plenty for distinguishing revisions of one file, and keeps keys short.
pub fn hash16(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    digest.iter().take(8).map(|b| format!("{:02x}", b)).collect()
}

pub fn content_type_for(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "md" | "markdown" | "mdown" | "mkd" => "text/markdown",
        "html" => "text/html",
        "txt" => "text/plain",
        "json" | "jsonl" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// Atomic-enough write: temp file in the same directory, then rename over.
/// The editor's watcher never sees a half-written document.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().unwrap_or(Path::new(""));
    if !parent.as_os_str().is_empty() {
        std::fs::create_dir_all(parent)?;
    }
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let tmp = parent.join(format!("{}{}", name, TMP_SUFFIX));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn write_json<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    write_atomic(path, serde_json::to_vec_pretty(value)?.as_slice())
}

/// Read a file if it exists and is small enough to sync.
pub fn read_file_checked(path: &Path) -> Option<Vec<u8>> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_SYNC_FILE_BYTES {
        return None;
    }
    std::fs::read(path).ok()
}

/// (size, mtime in ms) — the cheap snapshot that says "untouched since".
pub fn stat_pair(path: &Path) -> (u64, u64) {
    match std::fs::metadata(path) {
        Ok(meta) => {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            (meta.len(), mtime)
        }
        Err(_) => (0, 0),
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `<prefix>-<12 hex>`: a file id (`f-`), a device id (`d-`).
pub fn random_id(prefix: &str) -> String {
    let mut buf = [0u8; 6];
    let _ = getrandom::getrandom(&mut buf);
    let hex: String = buf.iter().map(|b| format!("{:02x}", b)).collect();
    format!("{}-{}", prefix, hex)
}

/// 32 random bytes as hex — the owner token the app mints at setup.
pub fn random_token() -> String {
    let mut buf = [0u8; 32];
    let _ = getrandom::getrandom(&mut buf);
    buf.iter().map(|b| format!("{:02x}", b)).collect()
}
