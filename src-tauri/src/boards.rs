//! A folder's `boards.json` on this Mac (src/boards.ts has the format and
//! its rules), and what a board shows of each note: its tag pairs, read from
//! its frontmatter. A board's write never conflicts: when the file moved on
//! since it was read, the two are merged by record as the sync merges them
//! (`doklin_engine::boards::merge`), and the merge is written.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::AppHandle;

use crate::{is_hidden_or_ignored, is_markdown, stat_snapshot, write_workspace_file, FileSnapshot, ReadFileResult};

/// The file a board folder holds (`BOARDS_FILE`, src/boards.ts).
const BOARDS_FILE: &str = "boards.json";

/// How deep `board_folders` looks: the tree's own cap.
const MAX_DEPTH: usize = 12;

/// Whether a file name is a folder's `boards.json`, whatever its case.
pub(crate) fn is_boards_file(name: &str) -> bool {
    name.eq_ignore_ascii_case(BOARDS_FILE)
}

/// The folder's `boards.json` as it is spelled there, or where a new one
/// goes.
fn boards_path(dir: &Path) -> PathBuf {
    std::fs::read_dir(dir)
        .ok()
        .and_then(|entries| {
            entries
                .flatten()
                .find(|e| is_boards_file(&e.file_name().to_string_lossy()) && e.file_type().is_ok_and(|t| t.is_file()))
                .map(|e| e.path())
        })
        .unwrap_or_else(|| dir.join(BOARDS_FILE))
}

/// The folder's `boards.json` with what it was read at; None when there is none.
#[tauri::command]
pub(crate) fn board_read(dir: String) -> Result<Option<ReadFileResult>, String> {
    let path = boards_path(Path::new(&dir));
    if !path.is_file() {
        return Ok(None);
    }
    let contents = std::fs::read_to_string(&path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    let snapshot = stat_snapshot(&path).map_err(|e| format!("stat {}: {}", path.display(), e))?;
    Ok(Some(ReadFileResult { contents, snapshot }))
}

/// Write `text`, made from `base` (the text read at `over`; None for a
/// board that had no file). When the file moved on since, the two are
/// merged and the merge is written. Answers the file as written.
#[tauri::command]
pub(crate) fn board_write(
    app: AppHandle,
    dir: String,
    text: String,
    base: Option<String>,
    over: Option<FileSnapshot>,
) -> Result<ReadFileResult, String> {
    let path = boards_path(Path::new(&dir));
    let contents = to_write(&path, text, base.as_deref(), over.as_ref())?;
    let snapshot = write_workspace_file(&app, &path, &contents)?;
    Ok(ReadFileResult { contents, snapshot })
}

/// What `board_write` puts at `path`: `text`, or its merge with what the
/// file holds when that moved on since `over`.
fn to_write(path: &Path, text: String, base: Option<&str>, over: Option<&FileSnapshot>) -> Result<String, String> {
    match std::fs::read_to_string(path) {
        Ok(current) => {
            let moved = over.is_none_or(|o| stat_snapshot(path).map_or(true, |now| &now != o));
            Ok(if moved { doklin_engine::boards::merge(base, &text, &current) } else { text })
        }
        // Shown as a folder somewhere else meanwhile: that stands.
        Err(_) if base.is_some() => Err("This folder isn't shown as a board any more.".to_string()),
        Err(_) => Ok(text),
    }
}

/// Every folder under `root` that holds a `boards.json`, `root` itself
/// left out (a section's own folder is never a board).
#[tauri::command]
pub(crate) fn board_folders(root: String) -> Vec<String> {
    fn walk(dir: &Path, depth: usize, out: &mut Vec<String>, top: bool) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        let mut board = false;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if is_hidden_or_ignored(&name) {
                continue;
            }
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() && depth < MAX_DEPTH {
                walk(&entry.path(), depth + 1, out, false);
            } else if kind.is_file() && is_boards_file(&name) {
                board = true;
            }
        }
        if board && !top {
            out.push(dir.to_string_lossy().to_string());
        }
    }
    let mut out = Vec::new();
    walk(Path::new(&root), 0, &mut out, true);
    out.sort();
    out
}

/// A note's tag pair, as its frontmatter spells it.
#[derive(Serialize)]
pub(crate) struct Pair {
    name: String,
    value: String,
}

/// Every markdown note directly in `dir`, by file name, with the pairs of
/// its frontmatter block (`keyedLines`, src/tags.ts). Nothing in a
/// subfolder; a note that can't be read is left out.
#[tauri::command]
pub(crate) fn board_cards(dir: String) -> Result<HashMap<String, Vec<Pair>>, String> {
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("read {}: {}", dir, e))?;
    let mut out = HashMap::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        if is_hidden_or_ignored(&name) || !entry.file_type().is_ok_and(|t| t.is_file()) || !is_markdown(&path) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let pairs = crate::tags::keyed_lines(&text)
            .into_iter()
            .filter_map(|l| Some(Pair { name: l.key, value: l.value? }))
            .collect();
        out.insert(name, pairs);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOARD: &str = "{\n  \"doklin\": \"boards\",\n  \"v\": 1,\n  \"tag\": \"Status\",\n  \"cards\": {\n    \"a.md\": { \"rank\": \"a0\" }\n  }\n}\n";

    /// A workspace of its own for each test, under the system's temp folder.
    fn folder(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("doklin-boards-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("Launch/Archive")).unwrap();
        std::fs::write(dir.join("Launch/Boards.JSON"), BOARD).unwrap();
        std::fs::write(dir.join("Launch/a.md"), "---\nStatus: Doing\nowner:\n---\nBody\n").unwrap();
        std::fs::write(dir.join("Launch/b.md"), "No block.\n").unwrap();
        std::fs::write(dir.join("Launch/Page.html"), "<p>html</p>").unwrap();
        std::fs::write(dir.join("Launch/Archive/c.md"), "---\nStatus: Done\n---\n").unwrap();
        std::fs::write(dir.join("boards.json"), BOARD).unwrap();
        std::fs::create_dir_all(dir.join(".hidden")).unwrap();
        std::fs::write(dir.join(".hidden/boards.json"), BOARD).unwrap();
        dir
    }

    #[test]
    fn a_folders_board_is_found_whatever_its_case() {
        let dir = folder("read");
        let launch = dir.join("Launch").to_string_lossy().to_string();
        assert_eq!(board_read(launch).unwrap().map(|r| r.contents), Some(BOARD.to_string()));
        let none = dir.join("Launch/Archive").to_string_lossy().to_string();
        assert!(board_read(none).unwrap().is_none());
    }

    #[test]
    fn board_folders_leave_out_the_top_and_hidden_folders() {
        let dir = folder("folders");
        let found = board_folders(dir.to_string_lossy().to_string());
        assert_eq!(found, vec![dir.join("Launch").to_string_lossy().to_string()]);
    }

    #[test]
    fn a_boards_cards_are_the_notes_directly_in_it_with_their_pairs() {
        let dir = folder("cards");
        let cards = board_cards(dir.join("Launch").to_string_lossy().to_string()).unwrap();
        let mut names: Vec<&String> = cards.keys().collect();
        names.sort();
        assert_eq!(names, vec!["a.md", "b.md"]);
        let pairs: Vec<(&str, &str)> = cards["a.md"].iter().map(|p| (p.name.as_str(), p.value.as_str())).collect();
        assert_eq!(pairs, vec![("Status", "Doing")]);
        assert!(cards["b.md"].is_empty());
    }

    #[test]
    fn a_write_over_a_file_that_moved_on_is_merged() {
        let dir = folder("write");
        let path = boards_path(&dir.join("Launch"));
        let read = stat_snapshot(&path).unwrap();
        let ours = BOARD.replace("\"a0\"", "\"a1\"");
        // Unchanged since it was read: ours as it is.
        assert_eq!(to_write(&path, ours.clone(), Some(BOARD), Some(&read)).unwrap(), ours);
        // Somebody else ranked another card meanwhile: both stay.
        let theirs = BOARD.replace("\"a.md\": { \"rank\": \"a0\" }", "\"a.md\": { \"rank\": \"a0\" },\n    \"b.md\": { \"rank\": \"a2\" }");
        std::fs::write(&path, &theirs).unwrap();
        let merged = to_write(&path, ours, Some(BOARD), None).unwrap();
        assert!(merged.contains("\"a.md\": { \"rank\": \"a1\" }") && merged.contains("\"b.md\": { \"rank\": \"a2\" }"), "{merged}");
        // Shown as a folder somewhere else since it was read: no write.
        std::fs::remove_file(&path).unwrap();
        assert!(to_write(&path, BOARD.to_string(), Some(BOARD), None).is_err());
        assert_eq!(to_write(&path, BOARD.to_string(), None, None).unwrap(), BOARD);
    }
}
