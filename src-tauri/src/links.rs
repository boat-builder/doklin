//! A link to a page (engine/src/cloud/link.rs), followed on this Mac. It
//! arrives from macOS — the page at doklin.cc hands it on as
//! `doklin://open#…`, the scheme Info.plist registers — or from a click in a
//! note or an html page (`open_external`). The engine finds the file; the
//! workspace's window shows it, as a file opened from Finder is shown
//! (external_open.rs). A link that opens nothing says why, in a dialog: it
//! can arrive with no window up to say it in.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use doklin_engine::cloud::link::PageLink;
use doklin_engine::Core;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

/// How long a link that launched the app waits for the engine to be up.
const READY_WAIT: Duration = Duration::from_secs(10);

/// Whether `url` is a link to a page, which the app follows rather than a
/// browser.
pub(crate) fn is_page_link(url: &str) -> bool {
    PageLink::parse(url).is_some()
}

/// Open the file `url` names in its workspace's window, or say why it can't
/// be. Returns at once: the engine may first poll for a page written a
/// moment ago.
pub(crate) fn follow(app: &AppHandle, url: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(core) = ready_core(&app).await else {
            say(&app, "Doklin wasn't ready to open that link. Try it again in a moment.");
            return;
        };
        match doklin_engine::cloud::cloud_follow_link(&core, url).await {
            Ok(path) => {
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    crate::external_open::handle_external_open(&handle, vec![PathBuf::from(path)]);
                });
            }
            Err(words) => say(&app, &sentence(&words)),
        }
    });
}

/// The engine, once the app's setup has made it and its cloud manager is
/// up. A link that launched the app arrives before either.
async fn ready_core(app: &AppHandle) -> Option<Arc<Core>> {
    let started = std::time::Instant::now();
    loop {
        if let Some(core) = crate::engine::try_core(app) {
            if doklin_engine::cloud::cloud_status(&core).is_ok() {
                return Some(core);
            }
        }
        if started.elapsed() > READY_WAIT {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// The engine answers a refusal as a phrase; a dialog says it as a sentence.
fn sentence(words: &str) -> String {
    let words = words.trim();
    let mut chars = words.chars();
    let Some(first) = chars.next() else { return String::new() };
    let capital: String = first.to_uppercase().chain(chars).collect();
    if capital.ends_with(['.', '?', '!']) {
        capital
    } else {
        format!("{}.", capital)
    }
}

fn say(app: &AppHandle, words: &str) {
    app.dialog().message(words).title("Can't open that link").kind(MessageDialogKind::Info).show(|_| {});
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refusal_is_said_as_a_sentence() {
        assert_eq!(sentence("that page is in notes.example.com"), "That page is in notes.example.com.");
        assert_eq!(sentence(" done already. "), "Done already.");
        assert_eq!(sentence(""), "");
    }

    #[test]
    fn only_a_link_to_a_page_is_kept_from_the_browser() {
        assert!(is_page_link("https://doklin.cc/open#d=notes.example.com&w=w-0a1b2c3d4e5f&f=f-9c8b7a6d5e4f"));
        assert!(!is_page_link("https://doklin.cc/"));
        assert!(!is_page_link("https://notes.example.com/roadmap"));
    }
}
