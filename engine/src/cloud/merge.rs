//! Concurrent edits to one file: a three-way text merge against the last
//! synced base, and — when the edits overlap or the content isn't text — a
//! conflict copy beside the file, so nothing is ever lost.

use std::path::{Path, PathBuf};

use super::scan::now_ms;

pub enum MergeOutcome {
    Clean(String),
    Conflicted,
}

/// Three-way text merge. Binary content (any side) or a missing base means
/// no merge — the caller falls back to a conflict copy.
pub fn merge_texts(base: Option<&[u8]>, ours: &[u8], theirs: &[u8]) -> MergeOutcome {
    let (Some(base), Ok(ours), Ok(theirs)) = (
        base.map(std::str::from_utf8).and_then(Result::ok),
        std::str::from_utf8(ours),
        std::str::from_utf8(theirs),
    ) else {
        return MergeOutcome::Conflicted;
    };
    match diffy::merge(base, ours, theirs) {
        Ok(merged) => MergeOutcome::Clean(merged),
        Err(_) => MergeOutcome::Conflicted,
    }
}

/// "Meeting notes.md" + Alice -> "Meeting notes (conflict — Alice, Jul 11
/// 14.32).md", uniquified if that too is taken. Dots in the time because a
/// colon is the one character macOS filenames can't wear.
pub fn conflict_copy_path(original: &Path, who: &str) -> PathBuf {
    let stem = original
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Untitled".into());
    let ext = original
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let who: String = who
        .chars()
        .map(|c| if c == '/' || c == ':' || c == '\0' || c == '\\' { '-' } else { c })
        .take(40)
        .collect();
    let when = chrono::Local::now().format("%b %-d %H.%M");
    let dir = original.parent().unwrap_or(Path::new(""));
    for n in 0..100 {
        let suffix = if n == 0 { String::new() } else { format!(" {}", n + 1) };
        let name = format!("{} (conflict — {}, {}{}){}", stem, who, when, suffix, ext);
        let candidate = dir.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{} (conflict {}){}", stem, now_ms(), ext))
}
