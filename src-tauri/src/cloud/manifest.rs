//! The workspace manifest — the one mutable object in the bucket — as the
//! engine and the worker both see it (docs/cloud.md §6.6). These
//! are the wire types the worker shape-checks on every `PUT`
//! (cloud-worker/src/manifest.ts); the caps and grammars below mirror
//! cloud-worker/src/layout.ts so the engine never builds a manifest the
//! worker would refuse. Semantics — which revision wins, merges, what a
//! tombstone means — live in engine.rs; this file is the vocabulary plus
//! the pure helpers that keep a manifest valid.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use serde::{Deserialize, Serialize};

/// The schema this engine writes; parsed out of cloud-worker/src/version.ts
/// at build time (build.rs) so the app and its worker can't drift apart.
pub const MANIFEST_VERSION: u32 = super::parse_u32(env!("DOKLIN_MANIFEST_VERSION"));

/* ---------- Caps and grammars (cloud-worker/src/layout.ts) ---------- */

/// Names — a device, a workspace, a `by` attribution — in UTF-16 units, the
/// unit the worker's `.length` counts in.
pub const MAX_NAME_LEN: usize = 80;
pub const MAX_TITLE_LEN: usize = 300;
pub const MAX_DESC_LEN: usize = 600;
pub const MAX_PATH_LEN: usize = 1024;
/// Segments in a workspace-relative path.
pub const MAX_PATH_DEPTH: usize = 12;

/// Slugs the worker's own routes speak for — never a public page's.
pub const RESERVED_SLUGS: &[&str] = &[
    "api",
    "__web",
    "raw",
    "og.png",
    "robots.txt",
    "favicon.ico",
    "apple-touch-icon.png",
    "join",
];

/// The unambiguous alphabet a random slug is drawn from: no `0`/`o`,
/// `1`/`l`/`i` look-alikes, so a slug read off a screen types back right.
const SLUG_ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";
pub const RANDOM_SLUG_LEN: usize = 8;
const MAX_SLUG_LEN: usize = 64;

/* ---------- Wire types ---------- */

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Manifest {
    pub version: u32,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub seq: u64,
    #[serde(default)]
    pub files: BTreeMap<String, ManifestFile>,
    #[serde(default)]
    pub tombstones: BTreeMap<String, Tombstone>,
    /// The public map, keyed by slug — the only truth about what is public.
    #[serde(default)]
    pub public: BTreeMap<String, PublicEntry>,
}

impl Default for Manifest {
    fn default() -> Self {
        Manifest {
            version: MANIFEST_VERSION,
            name: String::new(),
            seq: 0,
            files: BTreeMap::new(),
            tombstones: BTreeMap::new(),
            public: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ManifestFile {
    pub path: String,
    pub rev: u64,
    pub hash: String,
    pub size: u64,
    #[serde(default)]
    pub mtime: u64,
    #[serde(default)]
    pub by: String,
    /// **Deprecated since phase 6** (docs/versioning-plan.md §9). This
    /// engine always writes an empty array; a file's past is the version
    /// store's now. The field stays because an empty one is a valid v2
    /// manifest to every worker and app that exists, and because an older
    /// device on the same workspace still writes entries we have to read.
    #[serde(default)]
    pub hist: Vec<HistEntry>,
}

/// One earlier revision of a file: rev, hash, size, time, by. Read-only
/// since phase 6 — see `ManifestFile::hist`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HistEntry {
    pub r: u64,
    pub h: String,
    pub s: u64,
    pub t: u64,
    #[serde(default)]
    pub b: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Tombstone {
    pub path: String,
    pub rev: u64,
    pub ts: u64,
    #[serde(default)]
    pub by: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PublicKind {
    File,
    Dir,
}

/// One public page. A file entry references the file id — a rename carries
/// the page for free — and snapshots the path, so a file deleted and
/// recreated at the same path can be re-bound; a folder entry is keyed by
/// path (`""` is the workspace root) and exposes every note under it.
/// `root` on at most one entry makes it the page at `/`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PublicEntry {
    pub kind: PublicKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desc: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub root: bool,
    #[serde(default)]
    pub by: String,
    #[serde(default)]
    pub at: u64,
}

/// What a public entry exposes — the identity two entries are compared by.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Target {
    File(String),
    Dir(String),
}

impl PublicEntry {
    /// A file entry with no file id yet (queued before its file synced) has
    /// no target to compare — `None`.
    pub fn target(&self) -> Option<Target> {
        match self.kind {
            PublicKind::File => self.file.clone().map(Target::File),
            PublicKind::Dir => Some(Target::Dir(self.path.clone())),
        }
    }
}

/// `GET /api/poll`.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct PollResponse {
    #[serde(rename = "manifestEtag")]
    pub manifest_etag: String,
    #[serde(default)]
    pub presence: BTreeMap<String, PresenceEntry>,
}

/// One device in `presence.json`: here, and editing `path` when set.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PresenceEntry {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub ts: u64,
}

/* ---------- Grammars ---------- */

/// A path relative to the workspace root as the worker accepts it: forward
/// slashes, no traversal, bounded depth and length (layout.ts `validPath`).
pub fn valid_rel_path(p: &str) -> bool {
    if p.is_empty() || p.len() > MAX_PATH_LEN || p.contains('\0') || p.contains('\\') {
        return false;
    }
    let segs: Vec<&str> = p.split('/').collect();
    segs.len() <= MAX_PATH_DEPTH && segs.iter().all(|s| !s.is_empty() && *s != "." && *s != "..")
}

/// A public page's slug: `^[a-z0-9][a-z0-9-]{2,63}$`, not a reserved word.
pub fn valid_slug(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() < 3 || bytes.len() > MAX_SLUG_LEN {
        return false;
    }
    let first_ok = bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit();
    first_ok
        && bytes[1..].iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
        && !RESERVED_SLUGS.contains(&s)
}

pub fn random_slug() -> String {
    let mut buf = [0u8; RANDOM_SLUG_LEN];
    let _ = getrandom::getrandom(&mut buf);
    buf.iter().map(|b| SLUG_ALPHABET[(*b as usize) % SLUG_ALPHABET.len()] as char).collect()
}

/// `base` if free, else `base-2`, `base-3`, … — the same deterministic rule
/// on every device, so two devices racing one custom slug agree on who
/// yields without coordinating. Falls back to a random slug after a long
/// run of taken names, and never grows past the slug cap.
pub fn unique_slug(base: &str, taken: impl Fn(&str) -> bool) -> String {
    if !taken(base) {
        return base.to_string();
    }
    for n in 2..=60u32 {
        let suffix = format!("-{}", n);
        let room = MAX_SLUG_LEN.saturating_sub(suffix.len());
        let head: String = base.chars().take(room).collect();
        let head = head.trim_end_matches('-').to_string();
        let candidate = format!("{}{}", head, suffix);
        if valid_slug(&candidate) && !taken(&candidate) {
            return candidate;
        }
    }
    loop {
        let candidate = random_slug();
        if !taken(&candidate) {
            return candidate;
        }
    }
}

/// Truncate to `max` UTF-16 code units — the length the worker measures —
/// on a character boundary.
pub fn cap_utf16(s: &str, max: usize) -> String {
    let mut units = 0usize;
    let mut out = String::new();
    for ch in s.chars() {
        units += ch.len_utf16();
        if units > max {
            break;
        }
        out.push(ch);
    }
    out
}

/// A human-facing name as the worker keeps it: trimmed and capped, the
/// fallback when blank.
pub fn clean_name(raw: &str, fallback: &str) -> String {
    let name = cap_utf16(raw.trim(), MAX_NAME_LEN);
    if name.is_empty() {
        fallback.to_string()
    } else {
        name
    }
}

/// An optional public title or description: trimmed, capped, `None` when
/// blank.
pub fn clean_text(raw: Option<&str>, max: usize) -> Option<String> {
    let text = cap_utf16(raw?.trim(), max);
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/* ---------- Keeping a manifest valid ---------- */

/// Two manifest entries claiming one path (a raced create): keep the
/// lexicographically-smaller fileId on the path, suffix the other. Every
/// device runs the same rule, so they agree without coordinating. Paths
/// compare case-insensitively, as the worker checks them — the workspace
/// lives on a case-insensitive disk.
pub fn dedupe_paths(m: &mut Manifest) {
    let mut by_path: HashMap<String, String> = HashMap::new();
    let ids: Vec<String> = m.files.keys().cloned().collect();
    for fid in ids {
        let path = m.files.get(&fid).map(|f| f.path.clone()).unwrap_or_default();
        let key = path.to_lowercase();
        match by_path.get(&key) {
            None => {
                by_path.insert(key, fid);
            }
            Some(winner) => {
                let (keep, bump) = if *winner < fid {
                    (winner.clone(), fid.clone())
                } else {
                    (fid.clone(), winner.clone())
                };
                by_path.insert(key, keep);
                if let Some(f) = m.files.get_mut(&bump) {
                    let p = Path::new(&f.path);
                    let stem = p
                        .file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let ext = p
                        .extension()
                        .map(|e| format!(".{}", e.to_string_lossy()))
                        .unwrap_or_default();
                    let dir = p
                        .parent()
                        .map(|d| d.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let new_name =
                        format!("{} ({}){}", stem, &bump[bump.len().saturating_sub(4)..], ext);
                    f.path = if dir.is_empty() { new_name } else { format!("{}/{}", dir, new_name) };
                    f.rev += 1;
                    let new_key = f.path.to_lowercase();
                    by_path.insert(new_key, bump);
                }
            }
        }
    }
}

/// Every manifest file living under `dir` (`""` = all of them).
pub fn files_under<'a>(m: &'a Manifest, dir: &str) -> impl Iterator<Item = (&'a String, &'a ManifestFile)> {
    let prefix = if dir.is_empty() { String::new() } else { format!("{}/", dir) };
    m.files.iter().filter(move |(_, f)| prefix.is_empty() || f.path.starts_with(&prefix))
}
