//! Opens from outside the app — `doklin open`, Finder, a second launch — and
//! the window each one lands in.
//!
//! A path inside a connected workspace goes to that workspace's window: a
//! file as a tab, a board as its board tab, a folder shown in the sidebar.
//! The workspace's own folder is that window. Anything else keeps a window
//! of its own, so a file never attaches to a workspace it is not part of.
//!
//! What a window should show is queued here per window and drained by the
//! window itself (`take_window_shows`) once it is ready and on every
//! `window-shows` ping, so it arrives whether the window was up, still
//! restoring, or just spawned. The ping goes to every window and carries
//! nothing: each takes only its own queue.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{find_window_for, spawn_open_window, spawn_window, AppReady, PendingInit, PendingOpen, WindowRegistry};

/// The event a window gets when something was queued for it. Listened to in
/// src/App.tsx — change both.
const SHOWS_EVENT: &str = "window-shows";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ShowKind {
    File,
    Board,
    Folder,
}

/// One thing a window is asked to show. Mirrored by `WindowShow` in
/// src/App.tsx — change both.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct Show {
    path: String,
    kind: ShowKind,
}

#[derive(Default)]
pub(crate) struct PendingShows(Mutex<HashMap<String, Vec<Show>>>);

/// What a window takes from the queue: everything asked of it so far.
#[tauri::command]
pub(crate) fn take_window_shows(window: tauri::WebviewWindow, shows: State<'_, PendingShows>) -> Vec<Show> {
    shows.0.lock().map(|mut q| q.remove(window.label()).unwrap_or_default()).unwrap_or_default()
}

/// The paths in a launch's argv: everything after the program that is not a
/// flag, `file://` URLs included.
pub(crate) fn argv_paths(argv: &[String]) -> Vec<PathBuf> {
    argv.iter()
        .skip(1)
        .filter_map(|a| {
            if a.starts_with("file://") {
                url::Url::parse(a).ok().and_then(|u| u.to_file_path().ok())
            } else if !a.is_empty() && !a.starts_with('-') {
                Some(PathBuf::from(a))
            } else {
                None
            }
        })
        .collect()
}

/// Send each opened path to its window. Must run on the main thread: it may
/// create or focus windows.
pub(crate) fn handle_external_open(app: &AppHandle, opened: Vec<PathBuf>) {
    if opened.is_empty() {
        return;
    }
    let roots: Vec<(String, PathBuf)> = crate::cloud::connected_roots(app)
        .into_iter()
        .map(|root| {
            let resolved = std::fs::canonicalize(&root).unwrap_or_else(|_| PathBuf::from(&root));
            (root, resolved)
        })
        .collect();
    for path in opened {
        let path = std::fs::canonicalize(&path).unwrap_or(path);
        let kind = if !path.is_dir() {
            ShowKind::File
        } else if crate::store::is_store_dir(&path) {
            ShowKind::Board
        } else {
            ShowKind::Folder
        };
        match place(&path, kind, &roots) {
            Placement::Folder(folder) => deliver(app, folder, None),
            Placement::InWorkspace { root, show } => deliver(app, root, Some(show)),
            Placement::LoneFile(file) => deliver_lone(app, file),
        }
    }
}

#[derive(Debug, PartialEq)]
enum Placement {
    /// A folder's own window: a workspace's root, or a folder of no workspace.
    Folder(String),
    /// A file of no connected workspace: a window of its own.
    LoneFile(String),
    /// Inside a connected workspace: that workspace's window, showing this.
    InWorkspace { root: String, show: Show },
}

/// Where `path` (resolved) goes, given each connected workspace's root as
/// cloud.json spells it and resolved. The innermost root that holds the path
/// wins. What comes back uses the root's own spelling — the workspace's name
/// everywhere else in the app — so a root reached through a link keeps it.
fn place(path: &Path, kind: ShowKind, roots: &[(String, PathBuf)]) -> Placement {
    let home = roots
        .iter()
        .filter(|(_, resolved)| path.starts_with(resolved))
        .max_by_key(|(_, resolved)| resolved.components().count());
    match home {
        Some((root, resolved)) if path == resolved.as_path() => Placement::Folder(root.clone()),
        Some((root, resolved)) => {
            let inside = path.strip_prefix(resolved).unwrap_or(path);
            let spelled = Path::new(root).join(inside).to_string_lossy().to_string();
            Placement::InWorkspace { root: root.clone(), show: Show { path: spelled, kind } }
        }
        None if kind == ShowKind::File => Placement::LoneFile(path.to_string_lossy().to_string()),
        None => Placement::Folder(path.to_string_lossy().to_string()),
    }
}

/// The window showing `folder` — focused, with `show` queued for it — or a
/// new one.
fn deliver(app: &AppHandle, folder: String, show: Option<Show>) {
    let ready = app.state::<AppReady>().0.load(Ordering::SeqCst);
    if let Some(label) = window_for_folder(app, &folder, ready) {
        if let Some(show) = show {
            queue(app, &label, show);
        }
        if ready {
            focus(app, &label);
        }
        return;
    }
    let init = PendingInit { folder: Some(folder), file: None, tabs: Vec::new(), active_id: None, restored: false };
    if let Some(win) = spawn_window(app, init, None) {
        if let Some(show) = show {
            queue(app, win.label(), show);
        }
        let _ = win.set_focus();
    }
}

/// A file of no workspace: focused where it is already open as a tab,
/// otherwise in a window of its own.
fn deliver_lone(app: &AppHandle, file: String) {
    let ready = app.state::<AppReady>().0.load(Ordering::SeqCst);
    if let Some(label) = find_window_for(app, &None, &Some(file.clone())) {
        queue(app, &label, Show { path: file, kind: ShowKind::File });
        if ready {
            focus(app, &label);
        }
        return;
    }
    spawn_open_window(app, None, Some(file));
}

/// Once the main window has asked for its folder, the window already showing
/// `folder`. Before that, a window the session just restored may show it —
/// or else the main window can still be told what to open: the first folder
/// asked for becomes its own.
fn window_for_folder(app: &AppHandle, folder: &str, ready: bool) -> Option<String> {
    if ready {
        return find_window_for(app, &Some(folder.to_string()), &None);
    }
    let restored = app.state::<WindowRegistry>().0.lock().ok().and_then(|map| {
        map.iter()
            .find(|(label, c)| {
                label.as_str() != "main"
                    && c.folder.as_deref() == Some(folder)
                    && app.get_webview_window(label).is_some()
            })
            .map(|(label, _)| label.clone())
    });
    if restored.is_some() {
        return restored;
    }
    let pending = app.state::<PendingOpen>();
    let mut slot = pending.folder.lock().ok()?;
    match slot.as_deref() {
        None => {
            *slot = Some(folder.to_string());
            Some("main".to_string())
        }
        Some(taken) if taken == folder => Some("main".to_string()),
        Some(_) => None,
    }
}

fn queue(app: &AppHandle, label: &str, show: Show) {
    if let Ok(mut q) = app.state::<PendingShows>().0.lock() {
        q.entry(label.to_string()).or_default().push(show);
    }
    let _ = app.emit(SHOWS_EVENT, ());
}

fn focus(app: &AppHandle, label: &str) {
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roots(list: &[(&str, &str)]) -> Vec<(String, PathBuf)> {
        list.iter().map(|(spelled, resolved)| (spelled.to_string(), PathBuf::from(resolved))).collect()
    }

    fn show(path: &str, kind: ShowKind) -> Show {
        Show { path: path.to_string(), kind }
    }

    #[test]
    fn a_workspace_root_is_its_own_window() {
        let r = roots(&[("/Users/a/company-os", "/Users/a/company-os")]);
        assert_eq!(
            place(Path::new("/Users/a/company-os"), ShowKind::Folder, &r),
            Placement::Folder("/Users/a/company-os".into())
        );
    }

    #[test]
    fn what_is_inside_a_workspace_goes_to_its_window() {
        let r = roots(&[("/Users/a/company-os", "/Users/a/company-os")]);
        assert_eq!(
            place(Path::new("/Users/a/company-os/Projects/plan.md"), ShowKind::File, &r),
            Placement::InWorkspace {
                root: "/Users/a/company-os".into(),
                show: show("/Users/a/company-os/Projects/plan.md", ShowKind::File)
            }
        );
        assert_eq!(
            place(Path::new("/Users/a/company-os/Projects"), ShowKind::Folder, &r),
            Placement::InWorkspace {
                root: "/Users/a/company-os".into(),
                show: show("/Users/a/company-os/Projects", ShowKind::Folder)
            }
        );
        assert_eq!(
            place(Path::new("/Users/a/company-os/Roadmap"), ShowKind::Board, &r),
            Placement::InWorkspace {
                root: "/Users/a/company-os".into(),
                show: show("/Users/a/company-os/Roadmap", ShowKind::Board)
            }
        );
    }

    #[test]
    fn anything_else_keeps_its_own_window() {
        let r = roots(&[("/Users/a/company-os", "/Users/a/company-os")]);
        assert_eq!(place(Path::new("/Users/a/notes.md"), ShowKind::File, &r), Placement::LoneFile("/Users/a/notes.md".into()));
        assert_eq!(place(Path::new("/Users/a/notes"), ShowKind::Folder, &r), Placement::Folder("/Users/a/notes".into()));
        // A board of no workspace opens like any folder.
        assert_eq!(place(Path::new("/Users/a/Board"), ShowKind::Board, &r), Placement::Folder("/Users/a/Board".into()));
    }

    #[test]
    fn a_neighbour_with_the_same_beginning_is_not_inside() {
        let r = roots(&[("/Users/a/company-os", "/Users/a/company-os")]);
        assert_eq!(
            place(Path::new("/Users/a/company-os-old/plan.md"), ShowKind::File, &r),
            Placement::LoneFile("/Users/a/company-os-old/plan.md".into())
        );
    }

    #[test]
    fn the_innermost_workspace_wins() {
        let r = roots(&[("/Users/a/outer", "/Users/a/outer"), ("/Users/a/outer/inner", "/Users/a/outer/inner")]);
        assert_eq!(
            place(Path::new("/Users/a/outer/inner/x.md"), ShowKind::File, &r),
            Placement::InWorkspace { root: "/Users/a/outer/inner".into(), show: show("/Users/a/outer/inner/x.md", ShowKind::File) }
        );
    }

    #[test]
    fn a_root_reached_through_a_link_keeps_its_spelling() {
        // cloud.json says /Users/a/ws; the folder behind it is /Volumes/d/ws.
        let r = roots(&[("/Users/a/ws", "/Volumes/d/ws")]);
        assert_eq!(place(Path::new("/Volumes/d/ws"), ShowKind::Folder, &r), Placement::Folder("/Users/a/ws".into()));
        assert_eq!(
            place(Path::new("/Volumes/d/ws/Projects/plan.md"), ShowKind::File, &r),
            Placement::InWorkspace { root: "/Users/a/ws".into(), show: show("/Users/a/ws/Projects/plan.md", ShowKind::File) }
        );
    }

    #[test]
    fn argv_keeps_paths_and_file_urls_and_drops_flags() {
        let argv: Vec<String> =
            ["/Applications/Doklin.app/Contents/MacOS/doklin", "-psn_0_1", "/a/b.md", "file:///a/c%20d.md", "", "rel/x"]
                .iter()
                .map(|s| s.to_string())
                .collect();
        assert_eq!(
            argv_paths(&argv),
            vec![PathBuf::from("/a/b.md"), PathBuf::from("/a/c d.md"), PathBuf::from("rel/x")]
        );
    }
}
