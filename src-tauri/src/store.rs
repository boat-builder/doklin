//! Datastores — the disk half of a kanban board.
//!
//! A datastore is a FOLDER: one markdown file per card, plus a definition
//! file (`store.jsonl`) naming the fields, the select options that are the
//! board's columns, and the saved views. See `docs/datastores-kanban.md`.
//!
//! Everything here is byte-level: locating a card's leading frontmatter
//! block, splicing a new one in, and watching the folder. The frontmatter
//! DIALECT is parsed only in TypeScript (`src/store/frontmatter.ts`) — one
//! implementation, one test suite. Rust finds the fences and moves bytes.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read as _};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, FileIdMap};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::{is_app_sidecar, is_hidden_or_ignored, is_markdown, stat_snapshot, FileSnapshot, WriteError};

/// The definition file that makes a folder a store. The name is fixed; the
/// header line inside it is the real marker (see `src/store/storeFile.ts`).
pub(crate) const STORE_FILE: &str = "store.jsonl";

/// A card whose frontmatter block is longer than this is not a card whose
/// properties we can usefully show — read the head, not the whole note.
const MAX_HEAD_BYTES: usize = 16 * 1024;
/// Reading every card's head is one IPC round trip; keep it bounded so a
/// folder someone dropped 50k files into can't hang the window.
const MAX_CARDS: usize = 5000;

#[derive(Serialize)]
pub(crate) struct CardHead {
    /// File name including the extension ("Fix login redirect.md").
    name: String,
    path: String,
    snapshot: FileSnapshot,
    /// The leading frontmatter block VERBATIM, fences included and ending in
    /// a newline — or "" when the file has none. The frontend parses it.
    head: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoreRead {
    /// `store.jsonl`'s raw text, or None when the folder has no definition
    /// file (the caller then treats the folder as an ordinary folder).
    def: Option<String>,
    def_snapshot: Option<FileSnapshot>,
    cards: Vec<CardHead>,
    /// Names of any `store (conflict — …).jsonl` copies sync left behind, so
    /// the board can say so instead of hiding it.
    conflicts: Vec<String>,
    /// True when the card list was cut short by MAX_CARDS.
    truncated: bool,
}

fn fence_line(line: &str) -> bool {
    line.trim_end_matches([' ', '\t', '\r']) == "---"
}

/// The byte length of the leading frontmatter block in `text` — fences and the
/// closing newline included — or 0 when there is none. The rule every other
/// tool uses: the very first line must be exactly `---`, and a closing `---`
/// line must follow.
pub(crate) fn head_len(text: &str) -> usize {
    let mut offset = 0usize;
    let mut first = true;
    for line in text.split_inclusive('\n') {
        let body = line.strip_suffix('\n').unwrap_or(line);
        if first {
            if !fence_line(body) {
                return 0;
            }
            // A file that is only "---" with no newline has no block.
            if !line.ends_with('\n') {
                return 0;
            }
            first = false;
            offset += line.len();
            continue;
        }
        offset += line.len();
        if fence_line(body) {
            return offset;
        }
    }
    0 // no closing fence: it was prose after all
}

/// Read at most `MAX_HEAD_BYTES` of `path` and return its frontmatter block.
/// Reads line by line and stops at the closing fence, so a 2 MB note costs
/// two lines of IO.
fn read_head(path: &Path) -> std::io::Result<String> {
    let file = std::fs::File::open(path)?;
    let mut reader = BufReader::new(file);
    let mut first = String::new();
    if reader.read_line(&mut first)? == 0 {
        return Ok(String::new());
    }
    if !first.ends_with('\n') || !fence_line(first.trim_end_matches('\n')) {
        return Ok(String::new());
    }
    let mut head = first;
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            return Ok(String::new()); // unterminated: not a block
        }
        head.push_str(&line);
        if fence_line(line.trim_end_matches('\n')) {
            return Ok(head);
        }
        if head.len() > MAX_HEAD_BYTES {
            return Ok(String::new()); // too big to be properties
        }
    }
}

/// Everything a board needs in one round trip: the definition file's text and,
/// for every card (direct-child markdown file), its name, snapshot, and
/// frontmatter block. Card BODIES are never read — the board doesn't show
/// them, and a folder of long notes must stay cheap to open.
#[tauri::command]
pub(crate) fn read_store(path: String) -> Result<StoreRead, String> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("not a directory: {}", path));
    }
    let store_path = dir.join(STORE_FILE);
    let def = std::fs::read_to_string(&store_path).ok();
    let def_snapshot = if def.is_some() {
        stat_snapshot(&store_path).ok()
    } else {
        None
    };

    let mut cards: Vec<CardHead> = Vec::new();
    let mut conflicts: Vec<String> = Vec::new();
    let mut truncated = false;
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("read {}: {}", path, e))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if is_hidden_or_ignored(&name) {
            continue;
        }
        let p = entry.path();
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        if is_store_conflict_name(&name) {
            conflicts.push(name);
            continue;
        }
        if !is_markdown(&p) || is_app_sidecar(&p) {
            continue;
        }
        if cards.len() >= MAX_CARDS {
            truncated = true;
            break;
        }
        let snapshot = match stat_snapshot(&p) {
            Ok(s) => s,
            Err(_) => continue, // vanished mid-scan; the next rescan covers it
        };
        let head = read_head(&p).unwrap_or_default();
        cards.push(CardHead {
            name,
            path: p.to_string_lossy().to_string(),
            snapshot,
            head,
        });
    }
    cards.sort_by(|a, b| a.name.cmp(&b.name));
    conflicts.sort();

    Ok(StoreRead {
        def,
        def_snapshot,
        cards,
        conflicts,
        truncated,
    })
}

/// `store (conflict — Alice, Sep 2 14.32).jsonl` — what the sync engine leaves
/// beside a definition file two people edited on the same line.
fn is_store_conflict_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.starts_with("store (conflict") && lower.ends_with(").jsonl")
}

/// Replace a card's leading frontmatter block with `head`, leaving every byte
/// of the body exactly as it is on disk right now. `head` is a complete block
/// (fences included, ending in a newline) or "" to remove one.
///
/// Same snapshot guard and same `conflict` error as `write_file`: a board's
/// drag can never lose a keystroke an open tab hasn't flushed yet, because the
/// body it keeps is the body on disk at this moment, not one the board held.
///
/// Deliberately does NOT prime the file watcher the way `write_file` does: a
/// properties change SHOULD reach an open tab of the same card, which adopts
/// it without touching the editor (see the frontmatter boundary in App.tsx).
#[tauri::command]
pub(crate) fn write_frontmatter(
    app: AppHandle,
    path: String,
    head: String,
    expected: Option<FileSnapshot>,
) -> Result<FileSnapshot, WriteError> {
    let snapshot = splice_frontmatter(path.clone(), head, expected)?;
    crate::edits::touched(&app, &path);
    Ok(snapshot)
}

pub(crate) fn splice_frontmatter(
    path: String,
    head: String,
    expected: Option<FileSnapshot>,
) -> Result<FileSnapshot, WriteError> {
    let path_buf = PathBuf::from(&path);
    let existed = path_buf.exists();
    if let Some(expected) = expected {
        if existed {
            let current = stat_snapshot(&path_buf).map_err(|e| WriteError::Io {
                message: format!("stat {}: {}", path, e),
            })?;
            if current != expected {
                return Err(WriteError::Conflict { current });
            }
        }
    }
    let body = if existed {
        let text = std::fs::read_to_string(&path_buf).map_err(|e| WriteError::Io {
            message: format!("read {}: {}", path, e),
        })?;
        text[head_len(&text)..].to_string()
    } else {
        String::new()
    };
    std::fs::write(&path_buf, format!("{}{}", head, body)).map_err(|e| WriteError::Io {
        message: format!("write {}: {}", path, e),
    })?;
    stat_snapshot(&path_buf).map_err(|e| WriteError::Io {
        message: format!("stat {}: {}", path, e),
    })
}

/// Replace a note's BODY, keeping its leading frontmatter block byte for byte
/// — the mirror image of `write_frontmatter`.
///
/// A card has two halves and two kinds of writer: a board or a properties
/// header owns the block, a peek panel owns the body. Splicing each half
/// against the file as it is on disk at THIS moment means neither writer can
/// clobber the other's half; only two writers of the SAME half race, and the
/// snapshot guard turns that into the usual `conflict`.
///
/// Like `write_frontmatter`, and unlike `write_file`, it does not prime the
/// file watcher: a body written here is a real change to anyone else showing
/// the same note, and they should hear about it.
#[tauri::command]
pub(crate) fn write_body(
    app: AppHandle,
    path: String,
    body: String,
    expected: Option<FileSnapshot>,
) -> Result<FileSnapshot, WriteError> {
    let snapshot = splice_body(path.clone(), body, expected)?;
    crate::edits::touched(&app, &path);
    Ok(snapshot)
}

pub(crate) fn splice_body(
    path: String,
    body: String,
    expected: Option<FileSnapshot>,
) -> Result<FileSnapshot, WriteError> {
    let path_buf = PathBuf::from(&path);
    let existed = path_buf.exists();
    if let Some(expected) = expected {
        if existed {
            let current = stat_snapshot(&path_buf).map_err(|e| WriteError::Io {
                message: format!("stat {}: {}", path, e),
            })?;
            if current != expected {
                return Err(WriteError::Conflict { current });
            }
        }
    }
    let head = if existed {
        let text = std::fs::read_to_string(&path_buf).map_err(|e| WriteError::Io {
            message: format!("read {}: {}", path, e),
        })?;
        text[..head_len(&text)].to_string()
    } else {
        String::new()
    };
    std::fs::write(&path_buf, format!("{}{}", head, body)).map_err(|e| WriteError::Io {
        message: format!("write {}: {}", path, e),
    })?;
    stat_snapshot(&path_buf).map_err(|e| WriteError::Io {
        message: format!("stat {}: {}", path, e),
    })
}

/// A new card: a file holding only its frontmatter block. Refuses to clobber
/// anything that already exists, like `create_file`.
#[tauri::command]
pub(crate) fn create_card(app: AppHandle, path: String, head: String) -> Result<FileSnapshot, String> {
    let path_buf = PathBuf::from(&path);
    let name = path_buf
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path_buf)
    {
        Ok(mut f) => {
            use std::io::Write;
            f.write_all(head.as_bytes())
                .map_err(|e| format!("write {}: {}", path, e))?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(format!("A file or folder named \"{}\" already exists", name));
        }
        Err(e) => return Err(format!("create {}: {}", path, e)),
    }
    crate::edits::touched(&app, &path);
    stat_snapshot(&path_buf).map_err(|e| format!("stat {}: {}", path, e))
}

/* ---------- Folder watching ----------
   `watch_file` is ONE non-recursive watcher for the active document. A board
   needs a whole folder, and several boards can be open at once (a board tab
   plus embeds), so these are keyed by folder path and live side by side. */

#[derive(Default)]
pub(crate) struct DirWatchers(
    pub(crate) Mutex<HashMap<String, Debouncer<RecommendedWatcher, FileIdMap>>>,
);

#[derive(Clone, Serialize)]
struct DirChangePayload {
    root: String,
}

/// Watch a store folder, emitting `dir-changed { root }` on any debounced
/// change beneath it. Idempotent: re-watching an already-watched folder is a
/// no-op, so two boards over one store share the watcher.
#[tauri::command]
pub(crate) fn watch_dir(
    path: String,
    app: AppHandle,
    store: State<'_, DirWatchers>,
) -> Result<(), String> {
    {
        let map = store.0.lock().map_err(|_| "watcher lock".to_string())?;
        if map.contains_key(&path) {
            return Ok(());
        }
    }
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("not a directory: {}", path));
    }
    let emit_root = path.clone();
    let app_clone = app.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(250),
        None,
        move |result: DebounceEventResult| {
            if result.is_err() {
                return;
            }
            let _ = app_clone.emit(
                "dir-changed",
                DirChangePayload {
                    root: emit_root.clone(),
                },
            );
        },
    )
    .map_err(|e| format!("watcher init: {}", e))?;
    debouncer
        .watcher()
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| format!("watch {}: {}", path, e))?;
    debouncer.cache().add_root(&root, RecursiveMode::Recursive);
    store
        .0
        .lock()
        .map_err(|_| "watcher lock".to_string())?
        .insert(path, debouncer);
    Ok(())
}

#[tauri::command]
pub(crate) fn unwatch_dir(path: String, store: State<'_, DirWatchers>) {
    // Drop OUTSIDE the lock so the worker thread can shut down without
    // contending with a watcher callback (same care `watch_file` takes).
    let removed = store.0.lock().ok().and_then(|mut m| m.remove(&path));
    drop(removed);
}

/// True when `dir` holds a `store.jsonl` with the header line that marks a
/// datastore. Cheap enough for the sidebar walk: one stat, and a read of the
/// first line only when the file exists.
pub(crate) fn is_store_dir(dir: &Path) -> bool {
    let path = dir.join(STORE_FILE);
    let file = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let mut line = String::new();
    let mut reader = BufReader::new(file).take(4096);
    if reader.read_line(&mut line).unwrap_or(0) == 0 {
        return false;
    }
    line.contains("\"doklin\"") && line.contains("\"store\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn head_len_finds_the_leading_block() {
        assert_eq!(head_len("---\na: 1\n---\nbody\n"), "---\na: 1\n---\n".len());
        // No block: prose that merely starts with a rule, or an unterminated
        // fence, or a fence that isn't the first line.
        assert_eq!(head_len("---\na: 1\nbody\n"), 0);
        assert_eq!(head_len("# Title\n---\na: 1\n---\n"), 0);
        assert_eq!(head_len("---"), 0);
        assert_eq!(head_len(""), 0);
        // An empty block, and a block with nothing after it.
        assert_eq!(head_len("---\n---\n"), 8);
        assert_eq!(head_len("---\na: 1\n---\n"), 13);
        // Trailing whitespace on a fence line is tolerated (editors add it).
        assert_eq!(head_len("---  \na: 1\n--- \nx"), "---  \na: 1\n--- \n".len());
    }

    #[test]
    fn write_frontmatter_keeps_the_body_byte_identical() {
        let dir = std::env::temp_dir().join(format!("doklin-store-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let card = dir.join("card.md");

        // Insert a block into a note that had none.
        std::fs::write(&card, "Body with ---\nand more\n").unwrap();
        splice_frontmatter(
            card.to_string_lossy().to_string(),
            "---\nstatus: Done\n---\n".into(),
            None,
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(&card).unwrap(),
            "---\nstatus: Done\n---\nBody with ---\nand more\n"
        );

        // Replace it; the body is untouched.
        splice_frontmatter(
            card.to_string_lossy().to_string(),
            "---\nstatus: Backlog\nrank: a0\n---\n".into(),
            None,
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(&card).unwrap(),
            "---\nstatus: Backlog\nrank: a0\n---\nBody with ---\nand more\n"
        );

        // Remove it: the note is plain prose again.
        splice_frontmatter(card.to_string_lossy().to_string(), String::new(), None).unwrap();
        assert_eq!(
            std::fs::read_to_string(&card).unwrap(),
            "Body with ---\nand more\n"
        );

        // The snapshot guard rejects a stale writer.
        let stale = FileSnapshot {
            mtime_ms: 1,
            size: 1,
        };
        let err = splice_frontmatter(
            card.to_string_lossy().to_string(),
            "---\nx: 1\n---\n".into(),
            Some(stale),
        )
        .unwrap_err();
        assert!(matches!(err, WriteError::Conflict { .. }));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_body_keeps_the_frontmatter_byte_identical() {
        let dir = std::env::temp_dir().join(format!("doklin-store-body-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let card = dir.join("card.md");

        // The mirror image of write_frontmatter: the block stays, the body goes.
        std::fs::write(&card, "---\nstatus: Done\nrank: a0\n---\nOld body\n").unwrap();
        splice_body(
            card.to_string_lossy().to_string(),
            "New body\nwith --- inside\n".into(),
            None,
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(&card).unwrap(),
            "---\nstatus: Done\nrank: a0\n---\nNew body\nwith --- inside\n"
        );

        // A note with no block never grows one.
        std::fs::write(&card, "Just prose\n").unwrap();
        splice_body(card.to_string_lossy().to_string(), "Other prose\n".into(), None).unwrap();
        assert_eq!(std::fs::read_to_string(&card).unwrap(), "Other prose\n");

        // The snapshot guard rejects a stale writer, exactly as it does for
        // the other half of the file.
        let stale = FileSnapshot {
            mtime_ms: 1,
            size: 1,
        };
        let err = splice_body(card.to_string_lossy().to_string(), "x".into(), Some(stale))
            .unwrap_err();
        assert!(matches!(err, WriteError::Conflict { .. }));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_store_reads_heads_and_skips_sidecars() {
        let dir = std::env::temp_dir().join(format!("doklin-store-read-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(STORE_FILE),
            "{\"doklin\":\"store\",\"v\":1,\"name\":\"P\"}\n",
        )
        .unwrap();
        std::fs::write(dir.join("A.md"), "---\nstatus: Done\n---\nbody\n").unwrap();
        std::fs::write(dir.join("B.md"), "no frontmatter\n").unwrap();
        std::fs::write(dir.join("A.meta.jsonl"), "{}\n").unwrap();
        std::fs::write(dir.join("notes.txt"), "x").unwrap();
        std::fs::write(dir.join("store (conflict — Alice, Sep 2 14.32).jsonl"), "x").unwrap();

        let out = read_store(dir.to_string_lossy().to_string()).unwrap();
        assert!(out.def.unwrap().contains("\"doklin\":\"store\""));
        let names: Vec<&str> = out.cards.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["A.md", "B.md"]);
        assert_eq!(out.cards[0].head, "---\nstatus: Done\n---\n");
        assert_eq!(out.cards[1].head, "");
        assert_eq!(out.conflicts.len(), 1);
        assert!(is_store_dir(&dir));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
