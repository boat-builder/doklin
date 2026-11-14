//! macOS-only: Doklin → Install Command Line Tool. The `doklin` command ships
//! inside the app, at `Contents/Helpers/doklin`; this puts a link to it at
//! `/usr/local/bin/doklin`, a folder every macOS shell has on its PATH. A
//! link, not a copy, so each app update updates the command too.
//!
//! One `doklin` per Mac: whatever sits at that path (a copy the install
//! script downloaded, an older link) is replaced, and a `doklin` the
//! terminal would still find first is named, with an offer to remove it.
//!
//! Installing also logs the command in to every workspace connected here,
//! and from then on connecting one does too (cloud/terminal.rs).

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

pub(crate) const MENU_ID: &str = "install-cli";
const LINK_DIR: &str = "/usr/local/bin";
const LINK: &str = "/usr/local/bin/doklin";
const TITLE: &str = "Command Line Tool";

/// Off the main thread: it may wait on a password prompt, a shell and dialogs.
pub(crate) fn install(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(message) = run(&app) {
            say(&app, MessageDialogKind::Error, &message);
        }
    });
}

fn run(app: &AppHandle) -> Result<(), String> {
    let helper = bundled_cli().ok_or("This build of Doklin has no command line tool inside it; release builds do.")?;
    let before = std::fs::symlink_metadata(LINK).ok();
    let already = before.is_some() && std::fs::read_link(LINK).ok().as_deref() == Some(helper.as_path());
    if !already && !make_link(&helper)? {
        return Ok(()); // the password prompt was cancelled: nothing changed
    }
    let mut installed = if already {
        format!("The doklin command is already installed at {}.", LINK)
    } else if before.is_some() {
        format!("Installed the doklin command at {}, in place of the one that was there.", LINK)
    } else {
        format!("Installed the doklin command at {}.", LINK)
    };
    let found = first_on_terminal_path();
    if matches!(found, Found::Nothing) {
        installed.push_str(&format!(" Your terminal's PATH leaves out {} — add it to use doklin.", LINK_DIR));
    }
    let roots = crate::cloud::connected_roots(app);
    let logins: Vec<String> = if roots.is_empty() {
        vec!["Connect a workspace and doklin is logged in to it too.".into()]
    } else {
        roots.iter().map(|root| crate::cloud::log_cli_in(app, root, &helper).unwrap_or_else(|why| why)).collect()
    };
    let words = format!("{}\n\n{}", installed, logins.join("\n"));
    let Found::Other(other) = found else {
        say(app, MessageDialogKind::Info, &words);
        return Ok(());
    };
    let question = format!(
        "{}\n\nYour terminal finds another doklin first, at {}, and would keep running that one. Remove it?",
        words,
        other.display()
    );
    let remove = app
        .dialog()
        .message(question)
        .title(TITLE)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Remove It".into(), "Keep It".into()))
        .blocking_show();
    if remove {
        std::fs::remove_file(&other).map_err(|e| format!("Could not remove {}: {}.", other.display(), e))?;
    }
    Ok(())
}

/// A workspace was just connected on this Mac (connect, join, resume): when
/// the terminal runs this app's `doklin`, log it in there too. Quietly, off
/// the main thread — the command was installed, so nobody is waiting on a
/// dialog, and a terminal that is not logged in says how to fix it.
pub(crate) fn after_connect(app: &AppHandle, root: &str) {
    let (app, root) = (app.clone(), root.to_string());
    std::thread::spawn(move || {
        let Some(helper) = bundled_cli() else { return };
        if !matches!(first_on_terminal_path(), Found::Same) {
            return;
        }
        if let Err(why) = crate::cloud::log_cli_in(&app, &root, &helper) {
            eprintln!("cli: {}", why);
        }
    });
}

/// `Contents/Helpers/doklin` of the app this is running from.
fn bundled_cli() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let contents = exe.parent()?.parent()?;
    let cli = contents.join("Helpers").join("doklin");
    cli.is_file().then_some(cli)
}

/// Point `LINK` at `helper`, asking for an administrator's password when
/// this user may not write there. False when that prompt was cancelled.
fn make_link(helper: &Path) -> Result<bool, String> {
    match link_directly(helper) {
        Ok(()) => return Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {}
        Err(e) => return Err(format!("Could not install the command at {}: {}.", LINK, e)),
    }
    let script = format!(
        "do shell script \"mkdir -p {dir} && ln -sfn \" & quoted form of \"{helper}\" & \" {link}\" \
         with prompt \"Doklin wants to put the doklin command in {dir}.\" with administrator privileges",
        dir = LINK_DIR,
        link = LINK,
        helper = applescript_text(&helper.to_string_lossy()),
    );
    let out = Command::new("/usr/bin/osascript")
        .args(["-e", &script])
        .output()
        .map_err(|e| format!("Could not ask for permission to install the command: {}.", e))?;
    if out.status.success() {
        return Ok(true);
    }
    let err = String::from_utf8_lossy(&out.stderr);
    if err.contains("(-128)") {
        return Ok(false);
    }
    Err(format!("Could not install the command at {}: {}.", LINK, err.trim().trim_end_matches('.')))
}

/// A link beside `LINK`, renamed over it: the command is never missing, and
/// whatever was there is replaced whole.
fn link_directly(helper: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(LINK_DIR)?;
    let staged = Path::new(LINK_DIR).join(format!(".doklin-link-{}", std::process::id()));
    let _ = std::fs::remove_file(&staged);
    std::os::unix::fs::symlink(helper, &staged)?;
    std::fs::rename(&staged, LINK).inspect_err(|_| {
        let _ = std::fs::remove_file(&staged);
    })
}

/// Inside an AppleScript string literal.
fn applescript_text(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

enum Found {
    /// The terminal runs this app's command.
    Same,
    /// It runs another `doklin` first.
    Other(PathBuf),
    /// It finds no `doklin` at all.
    Nothing,
    /// The shell could not be asked.
    Unknown,
}

/// What `doklin` means in a new terminal window: the user's own shell, as
/// login and interactive so it reads the files that set PATH, asked with a
/// time limit — a shell's startup files can wait on anything.
fn first_on_terminal_path() -> Found {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let Ok(mut child) = Command::new(&shell)
        .args(["-ilc", "command -v doklin"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return Found::Unknown;
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Found::Unknown;
            }
        }
    };
    let mut out = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = std::io::Read::read_to_string(&mut stdout, &mut out);
    }
    // Startup files may print anything first; the answer is the last line.
    let found = out.lines().rev().map(str::trim).find(|l| l.starts_with('/'));
    match found {
        None if status.code() == Some(1) => Found::Nothing,
        None => Found::Unknown,
        Some(path) => {
            let path = PathBuf::from(path);
            let ours = bundled_cli().and_then(|h| h.canonicalize().ok());
            if path.canonicalize().ok().is_some_and(|p| Some(p) == ours) {
                Found::Same
            } else {
                Found::Other(path)
            }
        }
    }
}

fn say(app: &AppHandle, kind: MessageDialogKind, words: &str) {
    app.dialog().message(words).title(TITLE).kind(kind).blocking_show();
}
