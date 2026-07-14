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

mod dictation;
mod sync;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, FileIdMap};
use serde::{Deserialize, Serialize};
#[cfg(target_os = "macos")]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};

/// Folder waiting to be adopted by the main window on cold start. Files never
/// go through here — an externally opened file always gets its own window (see
/// `handle_external_open`), so it can't attach itself to a restored session.
#[derive(Default)]
struct PendingOpen {
    folder: Mutex<Option<String>>,
}

/// A window's frame in logical screen coordinates, captured from Moved/Resized
/// events so the session can restore each window where the user left it.
#[derive(Clone, Copy, Serialize, Deserialize)]
struct WindowGeometry {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// What a single window currently shows: its workspace folder (if any), the
/// real-file paths open in its tabs (in tab order), the active tab's path, and
/// its last-known frame. The renderer keeps the content current via
/// `register_window_content`; geometry is tracked backend-side from window
/// events. Serves double duty: live routing (focus an existing window that
/// already shows a path instead of opening a duplicate) and session persistence
/// (this is exactly what `session.json` stores per window).
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct WindowContent {
    folder: Option<String>,
    files: Vec<String>,
    active_file: Option<String>,
    geometry: Option<WindowGeometry>,
}

#[derive(Default)]
struct WindowRegistry(Mutex<HashMap<String, WindowContent>>);

/// The on-disk session (<app_data_dir>/session.json): every window open at the
/// last snapshot, in stable `win_order`. Non-main windows are respawned from
/// this on launch; the main window only takes its frame from here (its tabs
/// restore from the renderer's localStorage session, which also covers drafts).
#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct PersistedSession {
    version: u32,
    windows: Vec<PersistedWindow>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct PersistedWindow {
    label: String,
    #[serde(flatten)]
    content: WindowContent,
}

/// Flipped true when the app starts quitting (⌘Q, or the exit that follows the
/// last window closing), so the teardown's per-window Destroyed events don't
/// prune those windows from the persisted session — the quit-time window set is
/// exactly what the next launch restores.
#[derive(Default)]
struct Quitting(AtomicBool);

/// Monotonic counter for spawned-window labels (`win-1`, `win-2`, …). Never
/// reused within a process, so labels stay unique among live windows.
#[derive(Default)]
struct WindowSeq(Mutex<u32>);

/// Flipped true once any window has reported its content. Until then an external
/// folder open is treated as the cold-start path (handed to the first window via
/// `PendingOpen`); afterwards it routes to a focused/new window. File opens
/// bypass this entirely — they always spawn their own window.
#[derive(Default)]
struct AppReady(AtomicBool);

/// Labels of windows that still owe a `quit_flush_ack` for an in-flight quit.
/// `None` means no quit is in progress. See `begin_quit_flush`.
#[derive(Default)]
struct QuitFlush(Mutex<Option<HashSet<String>>>);

/// Menu id of the custom Quit item that replaces the predefined one (macOS-only).
const QUIT_MENU_ID: &str = "doklin-quit-flush";
/// Menu id of the custom Close Window item that replaces the predefined ⌘W ones
/// so ⌘W is free for the renderer's close-tab handler (macOS-only). See
/// `build_app_menu`.
const CLOSE_WINDOW_MENU_ID: &str = "doklin-close-window";
/// Menu id of the "Open Recent Workspace" submenu anchored under File
/// (macOS-only). Its children are (re)built from the renderer's recents list via
/// the `set_recent_workspaces` command.
const RECENT_SUBMENU_ID: &str = "doklin-recent-submenu";
/// Id prefix for each recent-workspace item; the folder path is the remainder
/// (`doklin-recent::<path>`), so a menu click resolves straight to its folder
/// without a side table.
const RECENT_ITEM_PREFIX: &str = "doklin-recent::";
/// Menu id of the disabled placeholder shown when there are no recents.
const RECENT_EMPTY_ID: &str = "doklin-recent-empty";
/// Menu id of the "Clear Menu" item at the foot of the recent submenu.
const RECENT_CLEAR_ID: &str = "doklin-recent-clear";
/// How long a quit waits for window acks before exiting anyway — the escape
/// hatch if a webview is hung, mid-load, or otherwise never answers.
const QUIT_FLUSH_TIMEOUT_MS: u64 = 1000;

/// Initial content for spawned windows, keyed by window label. Populated by
/// `spawn_window` before the window is built and drained by the renderer via
/// `take_window_init`. Passing content backend-side (rather than through the URL
/// query) keeps it reliable in release builds, where the custom asset protocol
/// can drop query strings. `file` is a fresh external/in-app open (one file,
/// recents-worthy); `files`/`active_file` carry a session-restored tab list.
#[derive(Clone, Default)]
struct PendingInit {
    folder: Option<String>,
    file: Option<String>,
    files: Vec<String>,
    active_file: Option<String>,
    restored: bool,
}

#[derive(Default)]
struct PendingWindowOpen(Mutex<HashMap<String, PendingInit>>);

/// What a freshly-mounted window should become: whether it's the main window
/// (owns the shared session) and what it was spawned to show — a fresh
/// file/folder open, or (`restored`) a saved tab list from the last session.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct WindowInit {
    is_main: bool,
    folder: Option<String>,
    file: Option<String>,
    files: Vec<String>,
    active_file: Option<String>,
    restored: bool,
}

/// Where the cross-launch window session lives.
fn session_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("session.json"))
}

fn read_persisted_session(app: &AppHandle) -> PersistedSession {
    session_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Snapshots the window registry to disk. Runs whenever a window's content
/// changes, when a window closes, and at quit — so the file always reflects the
/// windows a relaunch should bring back (a crash restores the last snapshot).
fn persist_session(app: &AppHandle) {
    let Some(path) = session_path(app) else { return };
    let windows = {
        let registry = app.state::<WindowRegistry>();
        let Ok(map) = registry.0.lock() else { return };
        let mut labels: Vec<String> = map.keys().cloned().collect();
        labels.sort_by_key(|l| win_order(l));
        labels
            .into_iter()
            .map(|label| PersistedWindow {
                content: map[&label].clone(),
                label,
            })
            .collect::<Vec<_>>()
    };
    let Ok(json) = serde_json::to_string_pretty(&PersistedSession { version: 1, windows }) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = std::fs::write(&path, json) {
        eprintln!("failed to persist session: {}", e);
    }
}

/// Refreshes the registry's frame snapshot for `label` from the live window.
/// Fullscreen and minimized frames are skipped — restoring those transient
/// coordinates would pin the window to a state it shouldn't reopen in. Runs on
/// the main thread (called from the RunEvent loop).
fn capture_window_geometry(app: &AppHandle, label: &str) {
    let Some(win) = app.get_webview_window(label) else { return };
    if win.is_fullscreen().unwrap_or(false) || win.is_minimized().unwrap_or(false) {
        return;
    }
    let Ok(scale) = win.scale_factor() else { return };
    let Ok(pos) = win.outer_position() else { return };
    let Ok(size) = win.inner_size() else { return };
    let pos = pos.to_logical::<f64>(scale);
    let size = size.to_logical::<f64>(scale);
    if size.width <= 0.0 || size.height <= 0.0 {
        return;
    }
    if let Ok(mut map) = app.state::<WindowRegistry>().0.lock() {
        map.entry(label.to_string()).or_default().geometry = Some(WindowGeometry {
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height,
        });
    }
}

/// True when the frame's title bar lands on a connected screen, so a session
/// saved on a since-disconnected display doesn't restore a window off-screen.
fn geometry_visible(app: &AppHandle, g: &WindowGeometry) -> bool {
    let Ok(monitors) = app.available_monitors() else { return false };
    let (px, py) = (g.x + g.width / 2.0, g.y + 12.0);
    monitors.iter().any(|m| {
        let scale = m.scale_factor();
        let pos = m.position().to_logical::<f64>(scale);
        let size = m.size().to_logical::<f64>(scale);
        px >= pos.x && px <= pos.x + size.width && py >= pos.y && py <= pos.y + size.height
    })
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

/// Builds a `win-N` window showing `init`. The init content is stashed for the
/// renderer to drain via `take_window_init` once it mounts (reliable across dev
/// and release builds), and the window registry is pre-seeded with the same
/// content so external opens can route to this window before its renderer has
/// registered. `geometry` (when it maps to a connected screen) fixes the frame;
/// otherwise the window cascades off the lowest-ordered live window. Must run
/// on the main thread.
fn spawn_window(
    app: &AppHandle,
    init: PendingInit,
    geometry: Option<WindowGeometry>,
) -> Option<tauri::WebviewWindow> {
    let n = {
        let seq = app.state::<WindowSeq>();
        let mut g = seq.0.lock().unwrap();
        *g += 1;
        *g
    };
    let label = format!("win-{}", n);

    let seed = WindowContent {
        folder: init.folder.clone(),
        files: if init.files.is_empty() {
            init.file.clone().into_iter().collect()
        } else {
            init.files.clone()
        },
        active_file: init.active_file.clone().or_else(|| init.file.clone()),
        geometry,
    };
    if let Ok(mut map) = app.state::<WindowRegistry>().0.lock() {
        map.insert(label.clone(), seed);
    }
    if let Ok(mut map) = app.state::<PendingWindowOpen>().0.lock() {
        map.insert(label.clone(), init);
    }

    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        &label,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("Doklin")
    .inner_size(960.0, 720.0)
    .min_inner_size(480.0, 320.0);
    match geometry {
        Some(g) if geometry_visible(app, &g) => {
            builder = builder.position(g.x, g.y).inner_size(g.width, g.height);
        }
        _ => {
            if let Some((x, y)) = cascade_position(app, n) {
                builder = builder.position(x, y);
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(16.0, 18.0));
    }
    match builder.build() {
        Ok(win) => Some(win),
        Err(e) => {
            eprintln!("failed to open new window: {}", e);
            // Drop the stashes for the label that never materialized so a dead
            // entry can't linger in the registry (and thus in session.json).
            if let Ok(mut map) = app.state::<WindowRegistry>().0.lock() {
                map.remove(&label);
            }
            if let Ok(mut map) = app.state::<PendingWindowOpen>().0.lock() {
                map.remove(&label);
            }
            None
        }
    }
}

/// Opens a fresh window for an external/in-app file or folder open. Must run on
/// the main thread.
fn spawn_open_window(app: &AppHandle, folder: Option<String>, file: Option<String>) {
    let init = PendingInit {
        folder,
        file,
        files: Vec::new(),
        active_file: None,
        restored: false,
    };
    // Bring the new window (and the app) to the foreground. When the spawn
    // is triggered from the terminal shim, Doklin is a background app, so the
    // window would otherwise open behind whatever is focused. set_focus
    // activates the app and makes the window key.
    if let Some(win) = spawn_window(app, init, None) {
        let _ = win.set_focus();
    }
}

/// Focus a window already showing this content, or spawn a new one. A file is
/// only ever *focused* in a window that already has it open — it is never
/// injected as a tab into some other window's workspace. Must run on the main
/// thread (window creation/focus is main-thread only on macOS).
fn route_open(app: &AppHandle, folder: Option<String>, file: Option<String>) {
    if let Some(label) = find_window_for(app, &folder, &file) {
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.unminimize();
            let _ = win.set_focus();
            return;
        }
    }
    spawn_open_window(app, folder, file);
}

/// Entry point for every external open (initial CLI args, CLI second-instance,
/// macOS file-open). A file open ALWAYS spawns its own window — it is never
/// routed into an existing window, so a file that doesn't belong to a workspace
/// can't attach itself to that workspace's window (or to the session the main
/// window restores on cold start). Folder-only opens keep the focus-or-spawn
/// routing (a window *is* its workspace), with the cold-start hand-off to the
/// first window via `PendingOpen`. Must run on the main thread.
fn handle_external_open(app: &AppHandle, folder: Option<PathBuf>, file: Option<PathBuf>) {
    let folder = folder.map(|p| p.to_string_lossy().to_string());
    let file = file.map(|p| p.to_string_lossy().to_string());
    if file.is_some() {
        spawn_open_window(app, folder, file);
        return;
    }
    let Some(folder) = folder else { return };
    let ready = app.state::<AppReady>().0.load(Ordering::SeqCst);
    if !ready {
        if let Ok(mut g) = app.state::<PendingOpen>().folder.lock() {
            *g = Some(folder);
        }
        return;
    }
    route_open(app, Some(folder), None);
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
        // True when this markdown row also has an html rendition folded into it
        // (a same-stem .html sibling). Lets the sidebar mark md-only, html-only,
        // and bundled md+html rows with distinct icons. Always false for a
        // standalone html file (it renders as its own html row).
        paired: bool,
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

fn is_html(path: &Path) -> bool {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => ext.eq_ignore_ascii_case("html"),
        None => false,
    }
}

pub(crate) fn is_hidden_or_ignored(name: &str) -> bool {
    if name.starts_with('.') {
        return true;
    }
    matches!(
        name,
        "node_modules" | "target" | "dist" | "build" | "__pycache__" | ".git"
    )
}

/// Recursively walks `dir`, returning a tree of every non-hidden directory and
/// the markdown/html documents inside. An html file whose stem matches a
/// markdown file in the same directory is a *rendition* of that document, not a
/// separate one — it folds into the markdown row (the app discovers it by
/// probing for the sibling path). Directories are kept even when they
/// (currently) contain no documents — the sidebar creates files and folders in
/// place, so an empty folder must stay visible as a creation target. Returns
/// None only when the directory is unreadable or a traversal cap is hit.
/// Mutates `budget` to enforce a global entry cap.
fn walk(dir: &Path, depth: usize, budget: &mut usize) -> Option<TreeNode> {
    if depth > MAX_TREE_DEPTH || *budget == 0 {
        return None;
    }

    let entries = std::fs::read_dir(dir).ok()?;
    let mut subdirs: Vec<PathBuf> = Vec::new();
    let mut files: Vec<PathBuf> = Vec::new();
    let mut html_files: Vec<PathBuf> = Vec::new();

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
        } else if ft.is_file() && is_html(&path) {
            html_files.push(path);
        }
    }

    let md_stems: std::collections::HashSet<std::ffi::OsString> =
        files.iter().filter_map(|p| p.file_stem().map(|s| s.to_os_string())).collect();
    // Stems of every html file in this directory, so a markdown row can report
    // whether a same-stem rendition folded into it (`paired`).
    let html_stems: std::collections::HashSet<std::ffi::OsString> =
        html_files.iter().filter_map(|p| p.file_stem().map(|s| s.to_os_string())).collect();
    for h in html_files {
        let paired = h.file_stem().is_some_and(|s| md_stems.contains(s));
        if !paired {
            files.push(h);
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
        // A markdown file whose stem matches an html file is a bundled pair; a
        // standalone html file (or a markdown file with no rendition) is not.
        let paired = is_markdown(&f) && f.file_stem().is_some_and(|s| html_stems.contains(s));
        children.push(TreeNode::File {
            name: f.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
            path: f.to_string_lossy().to_string(),
            paired,
        });
    }

    Some(TreeNode::Dir {
        name: dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| dir.to_string_lossy().to_string()),
        path: dir.to_string_lossy().to_string(),
        children,
    })
}

struct WatcherState {
    // Every watched path with the snapshot last seen for it. One document can
    // be watched as a pair — the markdown file plus its html rendition.
    files: Vec<(PathBuf, FileSnapshot)>,
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

// On any debounced event, re-stat every watched file and emit for the ones
// whose snapshot moved. The store — not the closure — is the authority on what
// is watched, so a stale debouncer firing after a re-watch is harmless.
fn handle_debounced_events(store: &Arc<Mutex<Option<WatcherState>>>, app: &AppHandle) {
    let mut guard = match store.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let state = match guard.as_mut() {
        Some(s) => s,
        None => return,
    };
    let mut changed: Vec<ExternalChangePayload> = Vec::new();
    for (path, last_snapshot) in state.files.iter_mut() {
        // A stat failure = file briefly missing during an atomic rename; the
        // next event covers it.
        if let Ok(new_snapshot) = stat_snapshot(path) {
            if *last_snapshot != new_snapshot {
                *last_snapshot = new_snapshot.clone();
                changed.push(ExternalChangePayload {
                    path: path.to_string_lossy().to_string(),
                    snapshot: new_snapshot,
                });
            }
        }
    }
    drop(guard);

    for payload in changed {
        let _ = app.emit("file-externally-changed", payload);
    }
}

/// Lightweight stat for the share-reconciliation pass: lets the app ask "did
/// this file change since the last push?" without reading its contents.
#[tauri::command]
fn stat_file(path: String) -> Result<FileSnapshot, String> {
    stat_snapshot(Path::new(&path)).map_err(|e| format!("stat {}: {}", path, e))
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
            for (watched, last_snapshot) in state.files.iter_mut() {
                if *watched == path_buf {
                    *last_snapshot = new_snapshot.clone();
                }
            }
        }
    }

    Ok(new_snapshot)
}

#[tauri::command]
fn watch_file(
    path: String,
    extras: Option<Vec<String>>,
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

    let mut debouncer = new_debouncer(
        Duration::from_millis(250),
        None,
        move |result: DebounceEventResult| {
            if result.is_err() {
                return;
            }
            handle_debounced_events(&store_arc, &app_clone);
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

    let mut files = vec![(path_buf, snapshot.clone())];

    // Companion files (a document's html rendition next to its markdown, and
    // the rendition's comments sidecar) ride along best-effort: any of them
    // may vanish between the caller's probe and here.
    for extra in extras.unwrap_or_default() {
        let extra_buf = PathBuf::from(&extra);
        if let Ok(extra_snapshot) = stat_snapshot(&extra_buf) {
            if debouncer
                .watcher()
                .watch(&extra_buf, RecursiveMode::NonRecursive)
                .is_ok()
            {
                debouncer
                    .cache()
                    .add_root(&extra_buf, RecursiveMode::NonRecursive);
                files.push((extra_buf, extra_snapshot));
            }
        }
    }

    *store.0.lock().unwrap() = Some(WatcherState {
        files,
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

/// Moves (or renames) a file or folder from `from` to `to` via `fs::rename`.
/// Refuses to clobber an existing destination — except when `from` and `to`
/// resolve to the same entry, which is a case-only rename on macOS's default
/// case-insensitive APFS ("notes.md" → "Notes.md") and must be allowed.
/// Backs both the sidebar's inline Rename and its drag-and-drop move; both
/// stay within one workspace, so the cross-volume limits of `rename` don't bite.
#[tauri::command]
fn move_path(from: String, to: String) -> Result<(), String> {
    let from_buf = PathBuf::from(&from);
    let to_buf = PathBuf::from(&to);
    if !from_buf.exists() {
        return Err(format!("\"{}\" no longer exists", from));
    }
    let same_entry = match (std::fs::canonicalize(&from_buf), std::fs::canonicalize(&to_buf)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    };
    if to_buf.exists() && !same_entry {
        let name = to_buf
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| to.clone());
        return Err(format!("A file or folder named \"{}\" already exists", name));
    }
    std::fs::rename(&from_buf, &to_buf).map_err(|e| format!("move {}: {}", from, e))
}

/// True if anything (file or folder) exists at `path`. The in-app Save As
/// prompt checks this before promoting a draft, because the promotion write
/// itself is deliberately unconditional (Save As overwrites its target).
#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
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
fn take_pending_folder(state: State<'_, PendingOpen>) -> Option<String> {
    state.folder.lock().ok().and_then(|mut g| g.take())
}

/// The renderer reports what this window currently shows (its workspace folder,
/// the real files open in tabs, and the active tab) so external opens can focus
/// the right window instead of duplicating it, and so the persisted session
/// tracks what a relaunch should restore. Also marks the app "ready" so
/// subsequent external opens route to windows rather than the cold-start
/// pending-open path. Geometry is tracked separately (window events), so only
/// the content fields are replaced here.
#[tauri::command]
fn register_window_content(
    app: AppHandle,
    window: tauri::Window,
    folder: Option<String>,
    files: Vec<String>,
    active_file: Option<String>,
    registry: State<'_, WindowRegistry>,
    ready: State<'_, AppReady>,
) {
    if let Ok(mut map) = registry.0.lock() {
        let entry = map.entry(window.label().to_string()).or_default();
        entry.folder = folder;
        entry.files = files;
        entry.active_file = active_file;
    }
    ready.0.store(true, Ordering::SeqCst);
    persist_session(&app);
}

/// Tells a freshly-mounted window what it is and what to open. The label is the
/// authority for window identity (read backend-side, never inferred in JS): only
/// "main" owns the shared session; every other label is a spawned window that
/// initializes from the content stashed for it by `spawn_window` — a fresh
/// file/folder open, or a restored tab list from the previous session.
#[tauri::command]
fn take_window_init(window: tauri::Window, pending: State<'_, PendingWindowOpen>) -> WindowInit {
    let label = window.label();
    let is_main = label == "main";
    let init = pending
        .0
        .lock()
        .ok()
        .and_then(|mut m| m.remove(label))
        .unwrap_or_default();
    WindowInit {
        is_main,
        folder: init.folder,
        file: init.file,
        files: init.files,
        active_file: init.active_file,
        restored: init.restored,
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

/// macOS-only: the default app menu, but with the predefined Quit item swapped
/// for a custom one (same title, same ⌘Q accelerator). The predefined item
/// invokes `NSApp terminate:` directly, which tears the process down without
/// firing any window CloseRequested events — so a ⌘Q within the renderer's
/// autosave debounce would lose the last keystrokes. The custom item instead
/// surfaces as a menu event handled by `begin_quit_flush`.
///
/// Known gap: Dock-icon → Quit (and logout/shutdown) still go straight through
/// `terminate:` and can't be intercepted here.
#[cfg(target_os = "macos")]
fn build_app_menu<R: tauri::Runtime>(handle: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(handle)?;
    // The app submenu is the menu's first entry; its last item is the
    // predefined Quit (see tauri's Menu::default).
    if let Some(app_submenu) = menu.items()?.first().and_then(|i| i.as_submenu().cloned()) {
        if let Some(quit) = app_submenu.items()?.last() {
            app_submenu.remove(quit)?;
        }
        app_submenu.append(&MenuItem::with_id(
            handle,
            QUIT_MENU_ID,
            format!("Quit {}", handle.package_info().name),
            true,
            Some("CmdOrCtrl+Q"),
        )?)?;
    }

    // Free ⌘W for the renderer's close-tab handler (src/App.tsx). The default
    // menu binds ⌘W to predefined "Close Window" items — on macOS there's one
    // under both File and Window — and native menu key equivalents are dispatched
    // before the key ever reaches the web view, so they'd shadow ⌘W-closes-tab.
    // Drop those and add a single ⌘⇧W "Close Window" (the Chrome / VS Code
    // convention), routed through CLOSE_WINDOW_MENU_ID so the window still closes
    // via the normal CloseRequested path and its autosave flushes.
    let mut added_close = false;
    for kind in menu.items()? {
        let Some(submenu) = kind.as_submenu() else { continue };
        for item in submenu.items()? {
            let Some(predefined) = item.as_predefined_menuitem() else { continue };
            if predefined.text().ok().as_deref() != Some("Close Window") {
                continue;
            }
            submenu.remove(predefined)?;
            if !added_close {
                submenu.append(&MenuItem::with_id(
                    handle,
                    CLOSE_WINDOW_MENU_ID,
                    "Close Window",
                    true,
                    Some("CmdOrCtrl+Shift+W"),
                )?)?;
                added_close = true;
            }
        }
    }

    // Anchor an "Open Recent Workspace" submenu at the top of the File menu. The
    // renderer owns the recents list (localStorage), so it fills this in via
    // `set_recent_workspaces`; here we just create it with a disabled
    // placeholder so File shows the entry from the first launch. The File menu
    // is matched by title, like the "Close Window" swap above.
    for kind in menu.items()? {
        let Some(submenu) = kind.as_submenu() else { continue };
        if submenu.text().ok().as_deref() != Some("File") {
            continue;
        }
        let recent = Submenu::with_id(handle, RECENT_SUBMENU_ID, "Open Recent Workspace", true)?;
        recent.append(&MenuItem::with_id(
            handle,
            RECENT_EMPTY_ID,
            "No Recent Workspaces",
            false,
            None::<&str>,
        )?)?;
        submenu.prepend(&recent)?;
        break;
    }

    Ok(menu)
}

/// macOS-only: rebuild the File → "Open Recent Workspace" submenu to mirror
/// `folders` (most-recent first). Each item's id is `doklin-recent::<path>`, so
/// a click resolves straight to its folder in the menu-event handler without a
/// side table. `Menu::get` isn't recursive, so the submenu (nested under File)
/// is located by probing each top-level submenu.
#[cfg(target_os = "macos")]
fn rebuild_recent_menu(app: &AppHandle, folders: &[String]) -> tauri::Result<()> {
    let Some(menu) = app.menu() else { return Ok(()) };
    let mut recent = None;
    for kind in menu.items()? {
        if let Some(submenu) = kind.as_submenu() {
            if let Some(found) = submenu.get(RECENT_SUBMENU_ID) {
                recent = found.as_submenu().cloned();
                break;
            }
        }
    }
    let Some(recent) = recent else { return Ok(()) };

    // Drop every existing item, then refill. remove_at keeps us off the
    // IsMenuItem-for-MenuItemKind path.
    for _ in 0..recent.items()?.len() {
        recent.remove_at(0)?;
    }

    if folders.is_empty() {
        recent.append(&MenuItem::with_id(
            app,
            RECENT_EMPTY_ID,
            "No Recent Workspaces",
            false,
            None::<&str>,
        )?)?;
        return Ok(());
    }

    for path in folders {
        let name = Path::new(path)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone());
        recent.append(&MenuItem::with_id(
            app,
            format!("{RECENT_ITEM_PREFIX}{path}"),
            name,
            true,
            None::<&str>,
        )?)?;
    }
    recent.append(&PredefinedMenuItem::separator(app)?)?;
    recent.append(&MenuItem::with_id(
        app,
        RECENT_CLEAR_ID,
        "Clear Menu",
        true,
        None::<&str>,
    )?)?;
    Ok(())
}

/// The renderer pushes its recents (folders only, most-recent first) here on
/// startup and whenever the list changes, so the native File → "Open Recent
/// Workspace" menu stays in sync. A no-op off macOS (no custom app menu there).
#[tauri::command]
fn set_recent_workspaces(app: AppHandle, folders: Vec<String>) {
    #[cfg(target_os = "macos")]
    if let Err(e) = rebuild_recent_menu(&app, &folders) {
        eprintln!("failed to update recent-workspaces menu: {e}");
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (&app, &folders);
}

/// Quit, but let every window persist first: broadcast `quit-flush-requested`,
/// which each renderer answers with `quit_flush_ack` once its pending autosave
/// is on disk, then exit when all acks are in. A parallel timeout thread exits
/// regardless, so a wedged window can only delay quit, never block it. Runs on
/// the main thread (menu event), so it must not wait in place — the acks arrive
/// over IPC that is itself pumped by the main run loop.
fn begin_quit_flush(app: &AppHandle) {
    let windows: Vec<String> = app.webview_windows().into_keys().collect();
    {
        let state = app.state::<QuitFlush>();
        let mut pending = state.0.lock().unwrap();
        if pending.is_some() {
            return; // a quit is already in flight; let it finish
        }
        *pending = Some(windows.iter().cloned().collect());
    }
    if windows.is_empty() {
        app.exit(0);
        return;
    }
    let _ = app.emit("quit-flush-requested", ());
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(QUIT_FLUSH_TIMEOUT_MS));
        handle.exit(0);
    });
}

/// A renderer finished flushing its pending autosave ahead of quit. Once every
/// window in the pending set has acked, exit for real (usually well before
/// `begin_quit_flush`'s timeout). An ack with no quit in flight is a no-op.
#[tauri::command]
fn quit_flush_ack(window: tauri::Window, app: AppHandle, state: State<'_, QuitFlush>) {
    let all_acked = {
        let mut pending = state.0.lock().unwrap();
        match pending.as_mut() {
            Some(set) => {
                set.remove(window.label());
                set.is_empty()
            }
            None => false,
        }
    };
    if all_acked {
        app.exit(0);
    }
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
pub(crate) fn trash_path_impl(path: &str) -> Result<String, String> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};

    let ns_path = NSString::from_str(path);
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

#[cfg(target_os = "macos")]
#[tauri::command]
fn trash_file(path: String, store: State<'_, WatcherStore>) -> Result<String, String> {
    let path_buf = PathBuf::from(&path);
    // Stop watching first so the impending removal doesn't surface as an
    // external-change conflict for the file we're deleting. Matching either
    // half of a watched pair drops the whole watcher — by the time a watched
    // document is trashed its tabs are already closed, so nothing re-arms it.
    if let Ok(mut guard) = store.0.lock() {
        if guard
            .as_ref()
            .map(|s| s.files.iter().any(|(p, _)| *p == path_buf))
            .unwrap_or(false)
        {
            *guard = None;
        }
    }

    trash_path_impl(&path)
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
                // Handle on the main thread: a second launch with a file spawns
                // a new window; a folder focuses its workspace window or opens
                // one. Nothing is ever merged into an existing window.
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    handle_external_open(&handle, folder, file);
                });
            },
        ));
        // In-app updater: checks the GitHub `latest.json` manifest, downloads the
        // signed .app.tar.gz, verifies it against the pubkey in tauri.conf.json,
        // swaps the bundle and relaunches (process plugin). See src/updater.ts.
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }

    // macOS-only: custom Quit item (see build_app_menu) so ⌘Q flushes pending
    // autosaves instead of terminating mid-debounce.
    #[cfg(target_os = "macos")]
    {
        builder = builder.menu(build_app_menu).on_menu_event(|app, event| {
            if event.id() == QUIT_MENU_ID {
                begin_quit_flush(app);
            } else if event.id() == CLOSE_WINDOW_MENU_ID {
                // ⌘⇧W: close the focused window via the normal CloseRequested
                // path (the renderer flushes its autosave, then destroys it).
                if let Some(win) = app
                    .webview_windows()
                    .into_values()
                    .find(|w| w.is_focused().unwrap_or(false))
                {
                    let _ = win.close();
                }
            } else if event.id() == RECENT_CLEAR_ID {
                // The renderer owns the recents list; ask it to clear, then it
                // re-pushes an empty list which blanks this submenu.
                let _ = app.emit("menu-clear-recent-workspaces", ());
            } else if let Some(path) = event.id().0.strip_prefix(RECENT_ITEM_PREFIX) {
                // Focus a window already showing this workspace, else spawn one.
                // Menu events run on the main thread, so route directly.
                route_open(app, Some(path.to_string()), None);
            }
        });
    }

    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .manage(QuitFlush::default())
        .manage(PendingOpen::default())
        .manage(WatcherStore::default())
        .manage(WindowRegistry::default())
        .manage(WindowSeq::default())
        .manage(AppReady::default())
        .manage(PendingWindowOpen::default())
        .manage(Quitting::default())
        .manage(dictation::Dictation::default())
        .manage(sync::SyncManager::default())
        .invoke_handler(tauri::generate_handler![
            dictation::dictation_init,
            dictation::dictation_cmd,
            dictation::dictation_request,
            dictation::dictation_running,
            dictation::dictation_shutdown,
            sync::sync_enable,
            sync::sync_connect,
            sync::sync_disable,
            sync::sync_status,
            sync::sync_now,
            sync::sync_pause,
            sync::sync_set_activity,
            sync::sync_confirm_deletes,
            sync::sync_set_shares,
            sync::sync_device,
            sync::sync_reload_connections,
            read_file,
            stat_file,
            write_file,
            watch_file,
            unwatch_file,
            list_md_tree,
            create_file,
            create_dir,
            move_path,
            path_exists,
            search_workspace,
            take_pending_folder,
            register_window_content,
            take_window_init,
            open_in_window,
            set_recent_workspaces,
            focus_next_window,
            create_draft,
            list_drafts,
            delete_draft,
            migrate_scratch,
            trash_file,
            restore_trashed,
            reveal_in_finder,
            open_external,
            delete_share_config,
            quit_flush_ack
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            // Cloud sync: one background engine per configured workspace.
            sync::init(&handle);
            let saved = read_persisted_session(&handle);
            let initial_folder_str = initial_folder.as_ref().map(|p| p.to_string_lossy().to_string());
            let initial_file_str = initial_file.as_ref().map(|p| p.to_string_lossy().to_string());
            // When a cold-start external open matches a window the session is
            // about to restore anyway, the restore covers it — spawning a fresh
            // copy on top would duplicate the folder/file.
            let mut folder_restored = false;
            let mut file_restored = false;

            for w in &saved.windows {
                if w.label == "main" {
                    // The config-created main window restores its own tabs from
                    // the renderer's localStorage; only its frame (and a registry
                    // seed, so an immediate quit keeps the entry and external
                    // opens can dedupe against its folder) comes from here.
                    if let Ok(mut map) = handle.state::<WindowRegistry>().0.lock() {
                        map.insert(w.label.clone(), w.content.clone());
                    }
                    if let (Some(g), Some(main)) =
                        (&w.content.geometry, handle.get_webview_window("main"))
                    {
                        if geometry_visible(&handle, g) {
                            let _ = main.set_position(tauri::LogicalPosition::new(g.x, g.y));
                            let _ = main.set_size(tauri::LogicalSize::new(g.width, g.height));
                        }
                    }
                    continue;
                }
                let mut content = w.content.clone();
                if content.folder.is_none() && content.files.is_empty() {
                    continue; // an empty window isn't worth resurrecting
                }
                if initial_folder_str.is_some() && content.folder == initial_folder_str {
                    folder_restored = true;
                }
                if let Some(f) = &initial_file_str {
                    if content.files.contains(f) {
                        // The externally-opened file rides the restored window —
                        // as its active tab.
                        content.active_file = Some(f.clone());
                        file_restored = true;
                    }
                }
                spawn_window(
                    &handle,
                    PendingInit {
                        folder: content.folder.clone(),
                        file: None,
                        files: content.files.clone(),
                        active_file: content.active_file.clone(),
                        restored: true,
                    },
                    content.geometry,
                );
            }

            // The config window starts hidden (tauri.conf.json) so the saved
            // frame can be applied without a visible jump; show it now.
            if let Some(main) = handle.get_webview_window("main") {
                let _ = main.show();
                let _ = main.set_focus();
            }

            // Initial CLI args go through the same external-open path as every
            // later open: a folder is handed to the main window (cold-start
            // pending-open), a file spawns its own window immediately — unless
            // a restored window already shows it (see above).
            handle_external_open(
                app.handle(),
                if folder_restored { None } else { initial_folder },
                if file_restored { None } else { initial_file },
            );
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
        match &event {
            // The quitting window set is exactly what the next launch restores:
            // flag the teardown (so any Destroyed events it produces don't prune
            // entries) and snapshot the session with the final frames. BOTH exit
            // events are handled because macOS quit paths differ: ⌘Q surfaces as
            // the custom menu item (see build_app_menu) whose flush ends in
            // exit(), which — like last-window-close — fires ExitRequested first;
            // but Dock-icon Quit still goes through NSApp terminate → tao fires
            // only `Exit` (never ExitRequested). The double persist on the
            // former path is harmless.
            RunEvent::ExitRequested { .. } | RunEvent::Exit => {
                app.state::<Quitting>().0.store(true, Ordering::SeqCst);
                persist_session(app);
            }
            RunEvent::WindowEvent {
                label,
                event: WindowEvent::Moved(_) | WindowEvent::Resized(_),
                ..
            } => {
                capture_window_geometry(app, label);
            }
            RunEvent::WindowEvent {
                label,
                event: WindowEvent::Destroyed,
                ..
            } => {
                // A window the user closed mid-session shouldn't come back on
                // relaunch. The main window is the exception: it exists every
                // launch regardless, so its entry (frame + folder) is kept.
                if !app.state::<Quitting>().0.load(Ordering::SeqCst) {
                    if label != "main" {
                        if let Ok(mut map) = app.state::<WindowRegistry>().0.lock() {
                            map.remove(label);
                        }
                    }
                    persist_session(app);
                }
            }
            _ => {}
        }
    });
}
