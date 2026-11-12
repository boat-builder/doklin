//! Untitled notes: documents that have not been saved to a file yet.
//!
//! An untitled note belongs to the tab showing it. Its text lives in a buffer
//! of the app's own — `<app_data>/untitled/<tab id>.md`, with the usual
//! entity meta beside it — so the document machinery (load, autosave,
//! comments, table widths) treats it like any other markdown file, and so it
//! survives a quit: the window session names the tab, the buffer holds what
//! was typed, and the next launch puts both back as an unsaved note.
//!
//! That is the buffer's whole life. Saving the note to a real file, or
//! closing its tab, deletes it. It has no list, no history and no sync.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, State};

use crate::{is_app_sidecar, is_markdown, meta_file_of, TabKind, WindowRegistry};

const META_SUFFIX: &str = ".meta.jsonl";

fn dir_in(data_dir: &Path) -> PathBuf {
    data_dir.join("untitled")
}

fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {}", e))?;
    let dir = dir_in(&data_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {}", dir.display(), e))?;
    Ok(dir)
}

/// Delete a buffer and the entity meta beside it. Either may never have been
/// written (a note nobody typed in has no buffer at all), so a file that is
/// not there is not an error.
fn remove(buffer: &Path) -> Result<(), String> {
    let meta = PathBuf::from(meta_file_of(&buffer.to_string_lossy()));
    for path in [buffer, meta.as_path()] {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("delete {}: {}", path.display(), e)),
        }
    }
    Ok(())
}

/// Where the buffers live. The renderer names a new note's buffer itself —
/// `<dir>/<tab id>.md` — and the file appears with the note's first autosave.
#[tauri::command]
pub fn untitled_dir(app: AppHandle) -> Result<String, String> {
    Ok(dir(&app)?.to_string_lossy().to_string())
}

/// The note's tab closed, or the note was saved to a real file: its buffer
/// is finished with. Refuses any path that is not directly inside the
/// untitled folder, so this can never delete a document of the user's.
#[tauri::command]
pub fn discard_untitled(app: AppHandle, path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if target.parent() != Some(dir(&app)?.as_path()) {
        return Err(format!("not an untitled note: {}", path));
    }
    remove(&target)
}

/// The notes no window has open, oldest first. The main window asks once per
/// launch — naming the notes it has just restored, since the registry's entry
/// for it still describes the previous run — and opens what comes back.
///
/// Normally nothing does: a buffer is deleted with its tab. One is left over
/// only when the app died between the two, or a session was lost, and then
/// the note is still the user's — so it is handed back rather than swept.
#[tauri::command]
pub fn orphaned_untitled(
    app: AppHandle,
    window: tauri::Window,
    open: Vec<String>,
    registry: State<'_, WindowRegistry>,
) -> Result<Vec<String>, String> {
    let dir = dir(&app)?;
    let mut held: HashSet<PathBuf> = open.into_iter().map(PathBuf::from).collect();
    if let Ok(map) = registry.0.lock() {
        for (label, content) in map.iter() {
            if label == window.label() {
                continue;
            }
            held.extend(
                content
                    .tabs
                    .iter()
                    .filter(|t| t.kind == TabKind::Untitled)
                    .map(|t| PathBuf::from(&t.path)),
            );
        }
    }
    Ok(orphans_in(&dir, &held))
}

/// Every buffer in `dir` that `held` does not name and that has text in it,
/// oldest first. What cannot be a note is removed on the way: a buffer with
/// nothing in it, and meta whose buffer is gone.
fn orphans_in(dir: &Path, held: &HashSet<PathBuf>) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut notes: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    let mut metas: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if is_app_sidecar(&path) {
            metas.push(path);
            continue;
        }
        if !is_markdown(&path) || held.contains(&path) {
            continue;
        }
        // Unreadable right now: leave it be, and ask again next launch.
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        if text.trim().is_empty() {
            let _ = remove(&path);
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        notes.push((modified, path));
    }
    for meta in metas {
        let name = meta.to_string_lossy();
        let buffer = format!("{}.md", &name[..name.len() - META_SUFFIX.len()]);
        if !Path::new(&buffer).exists() {
            let _ = std::fs::remove_file(&meta);
        }
    }
    notes.sort();
    notes
        .into_iter()
        .map(|(_, path)| path.to_string_lossy().to_string())
        .collect()
}

/// One-time migration: builds up to 0.1.87 kept every untitled note as a
/// "draft" in `<app_data>/drafts` — listed in a Drafts panel whether or not a
/// tab showed it, with a version store of its own. Move those files into the
/// untitled folder, where this launch's orphan pass reopens each one that has
/// text as an unsaved note, so nothing a user wrote is dropped; and delete
/// the drafts' version store, which nothing reads any more. Runs before any
/// window asks for anything, and does nothing once the old folder is gone.
pub fn adopt_legacy_drafts(data_dir: &Path) {
    let legacy = data_dir.join("drafts");
    if !legacy.is_dir() {
        return;
    }
    let dest = dir_in(data_dir);
    if std::fs::create_dir_all(&dest).is_err() {
        return;
    }
    if let Ok(entries) = std::fs::read_dir(&legacy) {
        for entry in entries.flatten() {
            let _ = std::fs::rename(entry.path(), dest.join(entry.file_name()));
        }
    }
    // Fails, harmlessly, while anything is still inside: the next launch
    // tries the rest again.
    let _ = std::fs::remove_dir(&legacy);
    let _ = std::fs::remove_dir_all(data_dir.join("versions").join("drafts"));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("doklin-untitled-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn names(paths: &[String]) -> Vec<String> {
        paths
            .iter()
            .map(|p| Path::new(p).file_name().unwrap().to_string_lossy().to_string())
            .collect()
    }

    /// A buffer no window holds comes back if it has text; an empty one, and
    /// meta left without its buffer, are deleted. A held buffer is not
    /// touched either way.
    #[test]
    fn orphans_are_the_unheld_notes_with_text() {
        let dir = scratch("orphans");
        std::fs::write(dir.join("held.md"), "open in a window\n").unwrap();
        std::fs::write(dir.join("held-empty.md"), "").unwrap();
        std::fs::write(dir.join("lost.md"), "# typed, then the app died\n").unwrap();
        std::fs::write(dir.join("lost.meta.jsonl"), "{}\n").unwrap();
        std::fs::write(dir.join("blank.md"), " \n\n").unwrap();
        std::fs::write(dir.join("blank.meta.jsonl"), "{}\n").unwrap();
        std::fs::write(dir.join("stray.meta.jsonl"), "{}\n").unwrap();

        let held: HashSet<PathBuf> = [dir.join("held.md"), dir.join("held-empty.md")].into();
        assert_eq!(names(&orphans_in(&dir, &held)), vec!["lost.md"]);

        let mut left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        left.sort();
        assert_eq!(left, vec!["held-empty.md", "held.md", "lost.md", "lost.meta.jsonl"]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Removing a buffer takes its meta with it, and a note that was never
    /// written is removed without complaint.
    #[test]
    fn remove_takes_the_meta_and_tolerates_nothing_there() {
        let dir = scratch("remove");
        std::fs::write(dir.join("a.md"), "x").unwrap();
        std::fs::write(dir.join("a.meta.jsonl"), "{}\n").unwrap();
        remove(&dir.join("a.md")).unwrap();
        assert!(!dir.join("a.md").exists() && !dir.join("a.meta.jsonl").exists());
        remove(&dir.join("never-written.md")).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The old drafts folder empties into the untitled one, and its version
    /// store goes; a second run has nothing to do.
    #[test]
    fn legacy_drafts_move_over_once() {
        let data = scratch("legacy");
        std::fs::create_dir_all(data.join("drafts")).unwrap();
        std::fs::create_dir_all(data.join("versions").join("drafts")).unwrap();
        std::fs::create_dir_all(data.join("versions").join("r-0123456789abcdef")).unwrap();
        std::fs::write(data.join("drafts").join("one.md"), "kept\n").unwrap();
        std::fs::write(data.join("drafts").join("one.meta.jsonl"), "{}\n").unwrap();

        adopt_legacy_drafts(&data);
        adopt_legacy_drafts(&data);

        assert!(!data.join("drafts").exists());
        assert!(!data.join("versions").join("drafts").exists());
        assert!(data.join("versions").join("r-0123456789abcdef").exists());
        assert_eq!(std::fs::read_to_string(dir_in(&data).join("one.md")).unwrap(), "kept\n");
        assert!(dir_in(&data).join("one.meta.jsonl").exists());

        let _ = std::fs::remove_dir_all(&data);
    }
}
