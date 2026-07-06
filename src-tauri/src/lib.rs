//! Doklin backend.
//!
//! This app currently targets **macOS only** (see the README). Anywhere we lean
//! on a platform-specific API we tag the spot with the literal comment
//! `macOS-only` so a future cross-platform effort can `grep "macOS-only"` to find
//! every place that needs a portable fallback.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, FileIdMap};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

#[derive(Default)]
struct PendingOpen {
    file: Mutex<Option<String>>,
    folder: Mutex<Option<String>>,
}

/// What a single window currently shows: its workspace folder (if any) and the
/// real-file paths open in its tabs. The renderer keeps this current via
/// `register_window_content`, so the backend can focus an existing window that
/// already shows a path instead of opening a duplicate.
#[derive(Default)]
struct WindowContent {
    folder: Option<String>,
    files: HashSet<String>,
}

#[derive(Default)]
struct WindowRegistry(Mutex<HashMap<String, WindowContent>>);

/// Monotonic counter for spawned-window labels (`win-1`, `win-2`, …). Never
/// reused within a process, so labels stay unique among live windows.
#[derive(Default)]
struct WindowSeq(Mutex<u32>);

/// Flipped true once any window has reported its content. Until then an external
/// open is treated as the cold-start path (handed to the first window via
/// `PendingOpen`); afterwards it routes to a focused/new window.
#[derive(Default)]
struct AppReady(AtomicBool);

/// Initial content for spawned windows, keyed by window label. Populated by
/// `spawn_open_window` before the window is built and drained by the renderer via
/// `take_window_init`. Passing content backend-side (rather than through the URL
/// query) keeps it reliable in release builds, where the custom asset protocol
/// can drop query strings.
#[derive(Default)]
struct PendingWindowOpen(Mutex<HashMap<String, (Option<String>, Option<String>)>>);

/// What a freshly-mounted window should become: whether it's the main window
/// (owns the shared session) and the file/folder it was spawned to show.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct WindowInit {
    is_main: bool,
    folder: Option<String>,
    file: Option<String>,
}

/// Stable cross-window ordering for ⌘` cycling: the config window ("main")
/// first, then spawned windows ("win-N") in creation order.
fn win_order(label: &str) -> (u8, u32) {
    if label == "main" {
        (0, 0)
    } else if let Some(n) = label.strip_prefix("win-").and_then(|s| s.parse::<u32>().ok()) {
        (1, n)
    } else {
        (2, 0)
    }
}

/// Per-window diagonal offset (logical px) so stacked windows are visibly
/// staggered (like VS Code) — otherwise toggling between instances looks like
/// one window whose content just changed.
const CASCADE_STEP: f64 = 32.0;
/// How many steps before the cascade wraps back, so windows never march off the
/// bottom-right of the screen.
const CASCADE_WRAP: u32 = 8;

/// Where to place spawned window number `n`: anchored on the lowest-ordered live
/// window (the main window when present) and offset diagonally by a bounded,
/// cycling step. Logical screen coordinates. None when no anchor/position is
/// available, in which case the OS default placement is used.
fn cascade_position(app: &AppHandle, n: u32) -> Option<(f64, f64)> {
    let wins = app.webview_windows();
    let anchor = wins.values().min_by_key(|w| win_order(w.label()))?;
    let scale = anchor.scale_factor().ok()?;
    let base = anchor.outer_position().ok()?.to_logical::<f64>(scale);
    let step = CASCADE_STEP * (((n - 1) % CASCADE_WRAP) + 1) as f64;
    Some((base.x + step, base.y + step))
}

/// Finds a live window already showing the requested content. Folder identity
/// wins (a window *is* its workspace); otherwise match a window that has the
/// file open. Stale registry entries (window already closed) are skipped.
fn find_window_for(
    app: &AppHandle,
    folder: &Option<String>,
    file: &Option<String>,
) -> Option<String> {
    let map = app.state::<WindowRegistry>();
    let map = map.0.lock().ok()?;
    if let Some(f) = folder {
        for (label, c) in map.iter() {
            if c.folder.as_deref() == Some(f.as_str()) && app.get_webview_window(label).is_some() {
                return Some(label.clone());
            }
        }
    }
    if let Some(f) = file {
        for (label, c) in map.iter() {
            if c.files.contains(f) && app.get_webview_window(label).is_some() {
                return Some(label.clone());
            }
        }
    }
    None
}

/// Opens a fresh window initialized with `folder`/`file`, passed through the URL
/// query so the renderer can read its own initial content without racing on
/// shared state. Must run on the main thread.
fn spawn_open_window(app: &AppHandle, folder: Option<String>, file: Option<String>) {
    let n = {
        let seq = app.state::<WindowSeq>();
        let mut g = seq.0.lock().unwrap();
        *g += 1;
        *g
    };
    let label = format!("win-{}", n);

    // Stash the initial content for this label; the renderer drains it via
    // take_window_init once it mounts (reliable across dev and release builds).
    if let Ok(mut map) = app.state::<PendingWindowOpen>().0.lock() {
        map.insert(label.clone(), (folder, file));
    }

    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        &label,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("Doklin")
    .inner_size(960.0, 720.0)
    .min_inner_size(480.0, 320.0);
    if let Some((x, y)) = cascade_position(app, n) {
        builder = builder.position(x, y);
    }
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(16.0, 18.0));
    }
    match builder.build() {
        // Bring the new window (and the app) to the foreground. When the spawn
        // is triggered from the terminal shim, Doklin is a background app, so the
        // window would otherwise open behind whatever is focused. set_focus
        // activates the app and makes the window key.
        Ok(win) => {
            let _ = win.set_focus();
        }
        Err(e) => eprintln!("failed to open new window: {}", e),
    }
}

/// Focus a window already showing this content, or spawn a new one. When we
/// focus an existing folder window that doesn't yet have the requested file
/// open, we ask just that window to open it as a tab. Must run on the main
/// thread (window creation/focus is main-thread only on macOS).
fn route_open(app: &AppHandle, folder: Option<String>, file: Option<String>) {
    if let Some(label) = find_window_for(app, &folder, &file) {
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.unminimize();
            let _ = win.set_focus();
            if let Some(f) = &file {
                let already_open = app
                    .state::<WindowRegistry>()
                    .0
                    .lock()
                    .ok()
                    .and_then(|m| m.get(&label).map(|c| c.files.contains(f)))
                    .unwrap_or(false);
                if !already_open {
                    // emit_to (not emit): emit broadcasts to every window; we
                    // want only the focused one to open the file as a tab.
                    let _ = app.emit_to(label.as_str(), "open-file", OpenFilePayload { path: f.clone() });
                }
            }
            return;
        }
    }
    spawn_open_window(app, folder, file);
}

/// Entry point for every external open (CLI second-instance, macOS file-open).
/// Before any window has reported readiness this is a cold start, so the path is
/// handed to the first window via `PendingOpen`; afterwards it routes to a
/// focused or freshly spawned window.
fn handle_external_open(app: &AppHandle, folder: Option<PathBuf>, file: Option<PathBuf>) {
    let folder = folder.map(|p| p.to_string_lossy().to_string());
    let file = file.map(|p| p.to_string_lossy().to_string());
    if folder.is_none() && file.is_none() {
        return;
    }
    let ready = app.state::<AppReady>().0.load(Ordering::SeqCst);
    if !ready {
        let st = app.state::<PendingOpen>();
        if let (Some(f), Ok(mut g)) = (&folder, st.folder.lock()) {
            *g = Some(f.clone());
        }
        if let (Some(f), Ok(mut g)) = (&file, st.file.lock()) {
            *g = Some(f.clone());
        }
        return;
    }
    route_open(app, folder, file);
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
struct FileSnapshot {
    mtime_ms: u64,
    size: u64,
}

#[derive(Clone, Serialize)]
struct ReadFileResult {
    contents: String,
    snapshot: FileSnapshot,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind")]
enum WriteError {
    #[serde(rename = "io")]
    Io { message: String },
    #[serde(rename = "conflict")]
    Conflict { current: FileSnapshot },
}

#[derive(Clone, Serialize)]
struct OpenFilePayload {
    path: String,
}

#[derive(Clone, Serialize)]
struct ExternalChangePayload {
    path: String,
    snapshot: FileSnapshot,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum TreeNode {
    File {
        name: String,
        path: String,
    },
    Dir {
        name: String,
        path: String,
        children: Vec<TreeNode>,
    },
}

const MAX_TREE_DEPTH: usize = 12;
const MAX_TREE_ENTRIES: usize = 5000;

// Caps for workspace search, so a one-character query over a huge folder stays
// bounded in time and payload size.
const MAX_SEARCH_FILES: usize = 2000;
const MAX_MATCHES_PER_FILE: usize = 200;
const MAX_TOTAL_MATCHES: usize = 5000;
const SEARCH_PREVIEW_MAX: usize = 200;

fn is_markdown(path: &Path) -> bool {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => matches!(ext.to_ascii_lowercase().as_str(), "md" | "markdown" | "mdown" | "mkd"),
        None => false,
    }
}

fn is_hidden_or_ignored(name: &str) -> bool {
    if name.starts_with('.') {
        return true;
    }
    matches!(
        name,
        "node_modules" | "target" | "dist" | "build" | "__pycache__" | ".git"
    )
}

/// Recursively walks `dir`, returning a tree of every non-hidden directory and
/// the markdown files inside. Directories are kept even when they (currently)
/// contain no markdown — the sidebar creates files and folders in place, so an
/// empty folder must stay visible as a creation target. Returns None only when
/// the directory is unreadable or a traversal cap is hit. Mutates `budget` to
/// enforce a global entry cap.
fn walk(dir: &Path, depth: usize, budget: &mut usize) -> Option<TreeNode> {
    if depth > MAX_TREE_DEPTH || *budget == 0 {
        return None;
    }

    let entries = std::fs::read_dir(dir).ok()?;
    let mut subdirs: Vec<PathBuf> = Vec::new();
    let mut files: Vec<PathBuf> = Vec::new();

    for entry in entries.flatten() {
        if *budget == 0 {
            break;
        }
        *budget -= 1;
        let path = entry.path();
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if is_hidden_or_ignored(&name_str) {
            continue;
        }
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if ft.is_dir() {
            subdirs.push(path);
        } else if ft.is_file() && is_markdown(&path) {
            files.push(path);
        }
    }

    subdirs.sort_by(|a, b| a.file_name().cmp(&b.file_name()));
    files.sort_by(|a, b| a.file_name().cmp(&b.file_name()));

    let mut children: Vec<TreeNode> = Vec::new();
    for sub in subdirs {
        if let Some(node) = walk(&sub, depth + 1, budget) {
            children.push(node);
        }
    }
    for f in files {
        children.push(TreeNode::File {
            name: f.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
            path: f.to_string_lossy().to_string(),
        });
    }

    Some(TreeNode::Dir {
        name: dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| dir.to_string_lossy().to_string()),
        path: dir.to_string_lossy().to_string(),
        children,
    })
}

struct WatcherState {
    path: PathBuf,
    last_snapshot: FileSnapshot,
    _debouncer: Debouncer<RecommendedWatcher, FileIdMap>,
}

#[derive(Clone)]
struct WatcherStore(Arc<Mutex<Option<WatcherState>>>);

impl Default for WatcherStore {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(None)))
    }
}

fn stat_snapshot(path: &Path) -> std::io::Result<FileSnapshot> {
    let meta = std::fs::metadata(path)?;
    let size = meta.len();
    let mtime_ms = meta
        .modified()?
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(FileSnapshot { mtime_ms, size })
}

fn handle_debounced_events(
    store: &Arc<Mutex<Option<WatcherState>>>,
    app: &AppHandle,
    watched_path: &Path,
) {
    let new_snapshot = match stat_snapshot(watched_path) {
        Ok(s) => s,
        Err(_) => return, // file briefly missing during atomic rename; next event covers it
    };

    let mut guard = match store.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let state = match guard.as_mut() {
        Some(s) => s,
        None => return,
    };
    if state.path != watched_path {
        return;
    }
    if state.last_snapshot == new_snapshot {
        return;
    }
    state.last_snapshot = new_snapshot.clone();
    drop(guard);

    let _ = app.emit(
        "file-externally-changed",
        ExternalChangePayload {
            path: watched_path.to_string_lossy().to_string(),
            snapshot: new_snapshot,
        },
    );
}

#[tauri::command]
fn read_file(path: String) -> Result<ReadFileResult, String> {
    let path_buf = PathBuf::from(&path);
    let contents =
        std::fs::read_to_string(&path_buf).map_err(|e| format!("read {}: {}", path, e))?;
    let snapshot = stat_snapshot(&path_buf).map_err(|e| format!("stat {}: {}", path, e))?;
    Ok(ReadFileResult { contents, snapshot })
}

#[tauri::command]
fn write_file(
    path: String,
    contents: String,
    expected: Option<FileSnapshot>,
    store: State<'_, WatcherStore>,
) -> Result<FileSnapshot, WriteError> {
    let path_buf = PathBuf::from(&path);

    if let Some(expected) = expected {
        if path_buf.exists() {
            let current = stat_snapshot(&path_buf).map_err(|e| WriteError::Io {
                message: format!("stat {}: {}", path, e),
            })?;
            if current != expected {
                return Err(WriteError::Conflict { current });
            }
        }
    }

    std::fs::write(&path_buf, contents).map_err(|e| WriteError::Io {
        message: format!("write {}: {}", path, e),
    })?;

    let new_snapshot = stat_snapshot(&path_buf).map_err(|e| WriteError::Io {
        message: format!("stat {}: {}", path, e),
    })?;

    if let Ok(mut guard) = store.0.lock() {
        if let Some(state) = guard.as_mut() {
            if state.path == path_buf {
                state.last_snapshot = new_snapshot.clone();
            }
        }
    }

    Ok(new_snapshot)
}

#[tauri::command]
fn watch_file(
    path: String,
    app: AppHandle,
    store: State<'_, WatcherStore>,
) -> Result<FileSnapshot, String> {
    let path_buf = PathBuf::from(&path);
    let snapshot = stat_snapshot(&path_buf).map_err(|e| format!("stat {}: {}", path, e))?;

    // Drop the previous watcher OUTSIDE the lock so its worker thread can shut down
    // without contending with the lock our event handler will try to take.
    let previous = store.0.lock().unwrap().take();
    drop(previous);

    let store_arc = store.0.clone();
    let app_clone = app.clone();
    let path_for_closure = path_buf.clone();

    let mut debouncer = new_debouncer(
        Duration::from_millis(250),
        None,
        move |result: DebounceEventResult| {
            if result.is_err() {
                return;
            }
            handle_debounced_events(&store_arc, &app_clone, &path_for_closure);
        },
    )
    .map_err(|e| format!("watcher init: {}", e))?;

    debouncer
        .watcher()
        .watch(&path_buf, RecursiveMode::NonRecursive)
        .map_err(|e| format!("watch {}: {}", path, e))?;
    debouncer
        .cache()
        .add_root(&path_buf, RecursiveMode::NonRecursive);

    *store.0.lock().unwrap() = Some(WatcherState {
        path: path_buf,
        last_snapshot: snapshot.clone(),
        _debouncer: debouncer,
    });

    Ok(snapshot)
}

#[tauri::command]
fn unwatch_file(store: State<'_, WatcherStore>) {
    let previous = store.0.lock().unwrap().take();
    drop(previous);
}

/// Creates a new empty file at `path`, refusing to clobber anything that already
/// exists (the sidebar's inline-create flow surfaces the error next to the name
/// input). The parent directory must already exist — creation targets always
/// come from the visible tree.
#[tauri::command]
fn create_file(path: String) -> Result<(), String> {
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
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(format!("A file or folder named \"{}\" already exists", name))
        }
        Err(e) => Err(format!("create {}: {}", path, e)),
    }
}

/// Creates a new directory at `path`. Same contract as `create_file`: fails if
/// the name is taken, parent must exist.
#[tauri::command]
fn create_dir(path: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    let name = path_buf
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    match std::fs::create_dir(&path_buf) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(format!("A file or folder named \"{}\" already exists", name))
        }
        Err(e) => Err(format!("create folder {}: {}", path, e)),
    }
}

#[tauri::command]
fn list_md_tree(path: String) -> Result<TreeNode, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("not a directory: {}", path));
    }
    let mut budget = MAX_TREE_ENTRIES;
    // Always return a Dir node for the root, even when empty, so the UI can
    // show "no markdown files here" rather than an error.
    if let Some(node) = walk(&root, 0, &mut budget) {
        Ok(node)
    } else {
        Ok(TreeNode::Dir {
            name: root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| root.to_string_lossy().to_string()),
            path: root.to_string_lossy().to_string(),
            children: Vec::new(),
        })
    }
}

#[derive(Serialize)]
struct SearchMatchInfo {
    /// 1-based line number of the match within the file.
    line: usize,
    /// 0-based character column of the first match on the line.
    column: usize,
    /// The (trimmed, truncated) line text, for display in the results list.
    preview: String,
}

#[derive(Serialize)]
struct FileMatches {
    path: String,
    name: String,
    matches: Vec<SearchMatchInfo>,
}

/// Collects markdown file paths under `dir` (depth-first), skipping the same
/// hidden/ignored directories as the file tree. Mirrors `walk`'s traversal but
/// gathers a flat file list instead of building a pruned tree.
fn collect_md_files(dir: &Path, depth: usize, budget: &mut usize, out: &mut Vec<PathBuf>) {
    if depth > MAX_TREE_DEPTH || *budget == 0 {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut subdirs: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        if *budget == 0 {
            break;
        }
        *budget -= 1;
        let path = entry.path();
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if is_hidden_or_ignored(&name_str) {
            continue;
        }
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if ft.is_dir() {
            subdirs.push(path);
        } else if ft.is_file() && is_markdown(&path) {
            out.push(path);
        }
    }
    subdirs.sort();
    for sub in subdirs {
        collect_md_files(&sub, depth + 1, budget, out);
    }
}

/// Greps every markdown file under `root` for `query`, returning per-file
/// matches with 1-based line numbers and a preview of each matching line.
/// Case-insensitive unless `case_sensitive`. Results are bounded by the
/// MAX_* caps so a broad query stays responsive.
#[tauri::command]
fn search_workspace(
    root: String,
    query: String,
    case_sensitive: bool,
) -> Result<Vec<FileMatches>, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {}", root));
    }
    let needle_raw = query.trim();
    if needle_raw.is_empty() {
        return Ok(Vec::new());
    }
    let needle = if case_sensitive {
        needle_raw.to_string()
    } else {
        needle_raw.to_lowercase()
    };

    let mut files: Vec<PathBuf> = Vec::new();
    let mut budget = MAX_TREE_ENTRIES;
    collect_md_files(&root_path, 0, &mut budget, &mut files);
    files.sort();
    files.truncate(MAX_SEARCH_FILES);

    let mut results: Vec<FileMatches> = Vec::new();
    let mut total = 0usize;
    'files: for file in files {
        if total >= MAX_TOTAL_MATCHES {
            break;
        }
        let contents = match std::fs::read_to_string(&file) {
            Ok(c) => c,
            Err(_) => continue, // skip binary/unreadable files
        };
        let mut matches: Vec<SearchMatchInfo> = Vec::new();
        for (i, line) in contents.lines().enumerate() {
            let hay = if case_sensitive {
                line.to_string()
            } else {
                line.to_lowercase()
            };
            if let Some(byte_idx) = hay.find(&needle) {
                let column = hay[..byte_idx].chars().count();
                let preview: String = line.trim().chars().take(SEARCH_PREVIEW_MAX).collect();
                matches.push(SearchMatchInfo {
                    line: i + 1,
                    column,
                    preview,
                });
                total += 1;
                if matches.len() >= MAX_MATCHES_PER_FILE || total >= MAX_TOTAL_MATCHES {
                    break;
                }
            }
        }
        if !matches.is_empty() {
            results.push(FileMatches {
                path: file.to_string_lossy().to_string(),
                name: file
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default(),
                matches,
            });
        }
        if total >= MAX_TOTAL_MATCHES {
            break 'files;
        }
    }
    Ok(results)
}

#[tauri::command]
fn take_pending_open(state: State<'_, PendingOpen>) -> Option<String> {
    state.file.lock().ok().and_then(|mut g| g.take())
}

#[tauri::command]
fn take_pending_folder(state: State<'_, PendingOpen>) -> Option<String> {
    state.folder.lock().ok().and_then(|mut g| g.take())
}

/// The renderer reports what this window currently shows (its workspace folder
/// and the real files open in tabs) so external opens can focus the right
/// window instead of duplicating it. Also marks the app "ready" so subsequent
/// external opens route to windows rather than the cold-start pending-open path.
#[tauri::command]
fn register_window_content(
    window: tauri::Window,
    folder: Option<String>,
    files: Vec<String>,
    registry: State<'_, WindowRegistry>,
    ready: State<'_, AppReady>,
) {
    if let Ok(mut map) = registry.0.lock() {
        map.insert(
            window.label().to_string(),
            WindowContent {
                folder,
                files: files.into_iter().collect(),
            },
        );
    }
    ready.0.store(true, Ordering::SeqCst);
}

/// Tells a freshly-mounted window what it is and what to open. The label is the
/// authority for window identity (read backend-side, never inferred in JS): only
/// "main" owns the shared session; every other label is a spawned window that
/// initializes from the file/folder stashed for it by `spawn_open_window`.
#[tauri::command]
fn take_window_init(window: tauri::Window, pending: State<'_, PendingWindowOpen>) -> WindowInit {
    let label = window.label();
    let is_main = label == "main";
    let (folder, file) = pending
        .0
        .lock()
        .ok()
        .and_then(|mut m| m.remove(label))
        .unwrap_or((None, None));
    WindowInit {
        is_main,
        folder,
        file,
    }
}

/// Open a file/folder in a new window (focusing an existing window that already
/// shows it). Invoked by the in-app "open in new window" shortcuts. Dispatches
/// to the main thread because window creation is main-thread only on macOS.
#[tauri::command]
fn open_in_window(app: AppHandle, folder: Option<String>, file: Option<String>) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || route_open(&handle, folder, file));
}

/// Cycle focus to the next (or previous, with `backward`) app window — the
/// backing for ⌘` (Safari-style window switching). Windows are visited in a
/// stable order (main, then win-N). Main-thread only on macOS.
#[tauri::command]
fn focus_next_window(window: tauri::Window, app: AppHandle, backward: bool) {
    let current = window.label().to_string();
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let mut labels: Vec<String> = handle.webview_windows().into_keys().collect();
        if labels.len() < 2 {
            return;
        }
        labels.sort_by_key(|l| win_order(l));
        let idx = labels.iter().position(|l| l == &current).unwrap_or(0);
        let n = labels.len();
        let next = if backward { (idx + n - 1) % n } else { (idx + 1) % n };
        if let Some(win) = handle.get_webview_window(&labels[next]) {
            let _ = win.unminimize();
            let _ = win.set_focus();
        }
    });
}

#[derive(Serialize)]
struct DraftInfo {
    id: String,
    path: String,
    snapshot: FileSnapshot,
    preview: String,
}

/// Returns `app_data_dir/drafts`, creating it on first use. This directory holds
/// the app-managed "untitled" buffers (one file per draft), so unsaved notes are
/// durably persisted and survive restarts even before the user names a file.
fn drafts_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {}", e))?
        .join("drafts");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create drafts dir: {}", e))?;
    Ok(dir)
}

/// Creates an empty draft file `drafts/<id>.md` (if absent) and returns its path.
/// The renderer owns draft identity (a uuid), so naming stays stable across calls.
#[tauri::command]
fn create_draft(app: AppHandle, id: String) -> Result<String, String> {
    let file = drafts_dir(&app)?.join(format!("{}.md", id));
    if !file.exists() {
        std::fs::write(&file, "").map_err(|e| format!("create draft {}: {}", id, e))?;
    }
    Ok(file.to_string_lossy().to_string())
}

/// Lists all drafts (newest first) with a one-line preview, so the drafts view
/// can show closed-tab drafts without the renderer reading each file.
#[tauri::command]
fn list_drafts(app: AppHandle) -> Result<Vec<DraftInfo>, String> {
    let dir = drafts_dir(&app)?;
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("read drafts dir: {}", e))?;
    let mut out: Vec<DraftInfo> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !is_markdown(&path) {
            continue;
        }
        let id = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let snapshot = match stat_snapshot(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let preview = std::fs::read_to_string(&path)
            .ok()
            .and_then(|c| {
                c.lines()
                    .find(|l| !l.trim().is_empty())
                    .map(|l| l.trim().chars().take(120).collect::<String>())
            })
            .unwrap_or_default();
        out.push(DraftInfo {
            id,
            path: path.to_string_lossy().to_string(),
            snapshot,
            preview,
        });
    }
    out.sort_by(|a, b| b.snapshot.mtime_ms.cmp(&a.snapshot.mtime_ms));
    Ok(out)
}

/// Permanently deletes a draft file. Drafts are app-internal temp files, so a
/// hard delete (no Trash) is appropriate — they're recoverable from the drafts
/// view only while they exist.
#[tauri::command]
fn delete_draft(path: String) -> Result<(), String> {
    std::fs::remove_file(&path).map_err(|e| format!("delete draft {}: {}", path, e))
}

/// One-shot migration from the legacy single scratchpad to the drafts model. If
/// `scratch/current.md` exists and is non-empty, moves its content into
/// `drafts/<id>.md` and returns that path; otherwise removes the stale scratch
/// file and returns None.
#[tauri::command]
fn migrate_scratch(app: AppHandle, id: String) -> Result<Option<String>, String> {
    let scratch = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {}", e))?
        .join("scratch")
        .join("current.md");
    if !scratch.exists() {
        return Ok(None);
    }
    let contents = std::fs::read_to_string(&scratch).unwrap_or_default();
    if contents.trim().is_empty() {
        let _ = std::fs::remove_file(&scratch);
        return Ok(None);
    }
    let dest = drafts_dir(&app)?.join(format!("{}.md", id));
    std::fs::write(&dest, contents).map_err(|e| format!("migrate scratch: {}", e))?;
    let _ = std::fs::remove_file(&scratch);
    Ok(Some(dest.to_string_lossy().to_string()))
}

/// macOS-only: moves `path` to the system Trash via `NSFileManager` and returns
/// the resulting location inside the Trash. The renderer keeps that location so
/// `restore_trashed` can move the file straight back out of the Trash on undo —
/// a true restore that leaves no stale copy behind. NSFileManager (rather than
/// the Finder/AppleScript route) is what hands back the resulting Trash URL.
#[cfg(target_os = "macos")]
#[tauri::command]
fn trash_file(path: String, store: State<'_, WatcherStore>) -> Result<String, String> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};

    let path_buf = PathBuf::from(&path);
    // Stop watching first so the impending removal doesn't surface as an
    // external-change conflict for the file we're deleting.
    if let Ok(mut guard) = store.0.lock() {
        if guard.as_ref().map(|s| s.path == path_buf).unwrap_or(false) {
            *guard = None;
        }
    }

    let ns_path = NSString::from_str(&path);
    let url = NSURL::fileURLWithPath(&ns_path);
    let mut resulting = None;
    NSFileManager::defaultManager()
        .trashItemAtURL_resultingItemURL_error(&url, Some(&mut resulting))
        .map_err(|e| format!("trash {}: {}", path, e))?;

    resulting
        .and_then(|u| u.path())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("trash {}: no resulting trash path", path))
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn trash_file(_path: String, _store: State<'_, WatcherStore>) -> Result<String, String> {
    // macOS-only: see the macOS implementation above for a cross-platform port.
    Err("trash_file is only supported on macOS".to_string())
}

/// Restores a trashed file by moving it from its Trash location (returned by
/// `trash_file`) back to its original path. `rename` itself is portable, but the
/// Trash path it operates on is produced by the macOS-only `trash_file`.
#[tauri::command]
fn restore_trashed(trash_path: String, original_path: String) -> Result<(), String> {
    std::fs::rename(&trash_path, &original_path)
        .map_err(|e| format!("restore {} -> {}: {}", trash_path, original_path, e))
}

/// macOS-only: reveals `path` in Finder via `open -R`. The non-macOS arm just
/// errors; a cross-platform port would shell out to the host file manager.
#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("reveal {}: {}", path, e))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err("reveal_in_finder is only supported on macOS".to_string())
    }
}

/// Removes <app_data_dir>/share.json — the stored sharing endpoint + token —
/// from disk. A missing file counts as success so the UI action is idempotent.
#[tauri::command]
fn delete_share_config(app: AppHandle) -> Result<(), String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {}", e))?
        .join("share.json");
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("delete {}: {}", path.display(), e)),
    }
}

/// Opens an http(s) URL in the default browser (share links). macOS-only, like
/// `reveal_in_finder`; a cross-platform port would use xdg-open / `start`.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err(format!("refusing to open non-http url: {}", url));
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("open {}: {}", url, e))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("open_external is only supported on macOS".to_string())
    }
}

enum CliPath {
    File(PathBuf),
    Folder(PathBuf),
}

fn classify_arg(arg: &str) -> Option<CliPath> {
    let pb = if arg.starts_with("file://") {
        url::Url::parse(arg).ok().and_then(|u| u.to_file_path().ok())?
    } else if !arg.is_empty() && !arg.starts_with('-') {
        PathBuf::from(arg)
    } else {
        return None;
    };
    // Resolve relative args like "." to an absolute path so the UI can show a
    // real directory name. Falls back to the original for nonexistent paths.
    let pb = std::fs::canonicalize(&pb).unwrap_or(pb);
    if pb.is_dir() {
        Some(CliPath::Folder(pb))
    } else {
        Some(CliPath::File(pb))
    }
}

/// Returns (folder, file) extracted from argv. A directory arg becomes the
/// folder; the first non-directory arg becomes the file. Either may be None.
fn classify_argv(argv: &[String]) -> (Option<PathBuf>, Option<PathBuf>) {
    let mut folder = None;
    let mut file = None;
    for a in argv.iter().skip(1) {
        match classify_arg(a) {
            Some(CliPath::Folder(p)) if folder.is_none() => folder = Some(p),
            Some(CliPath::File(p)) if file.is_none() => file = Some(p),
            _ => {}
        }
    }
    (folder, file)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let (initial_folder, initial_file) = classify_argv(&std::env::args().collect::<Vec<_>>());

    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(
            |app, argv, _cwd| {
                let (folder, file) = classify_argv(&argv);
                // Route on the main thread: a second launch opens (or focuses) a
                // window rather than reusing the existing one.
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    handle_external_open(&handle, folder, file);
                });
            },
        ));
    }

    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .manage(PendingOpen::default())
        .manage(WatcherStore::default())
        .manage(WindowRegistry::default())
        .manage(WindowSeq::default())
        .manage(AppReady::default())
        .manage(PendingWindowOpen::default())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            watch_file,
            unwatch_file,
            list_md_tree,
            create_file,
            create_dir,
            search_workspace,
            take_pending_open,
            take_pending_folder,
            register_window_content,
            take_window_init,
            open_in_window,
            focus_next_window,
            create_draft,
            list_drafts,
            delete_draft,
            migrate_scratch,
            trash_file,
            restore_trashed,
            reveal_in_finder,
            open_external,
            delete_share_config
        ])
        .setup(move |app| {
            let state = app.state::<PendingOpen>();
            if let Some(p) = &initial_folder {
                if let Ok(mut g) = state.folder.lock() {
                    *g = Some(p.to_string_lossy().to_string());
                }
            }
            if let Some(p) = &initial_file {
                if let Ok(mut g) = state.file.lock() {
                    *g = Some(p.to_string_lossy().to_string());
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let RunEvent::Opened { urls } = &event {
            // The RunEvent loop is already on the main thread, so routing
            // (which may create/focus a window) is safe to call directly.
            for u in urls {
                if let Ok(p) = u.to_file_path() {
                    if p.is_dir() {
                        handle_external_open(app, Some(p), None);
                    } else {
                        handle_external_open(app, None, Some(p));
                    }
                }
            }
        }
        let _ = event;
    });
}
