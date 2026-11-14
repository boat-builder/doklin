//! `doklin open` — the one command about this Mac rather than a workspace:
//! it hands files and folders on this disk to the Doklin app. Which
//! workspace a path belongs to is the app's to know, not this program's.

use std::path::{Path, PathBuf};

use serde_json::json;

use crate::args::Args;
use crate::commands::Ctx;
use crate::Failure;

pub fn open(args: &Args, ctx: &Ctx) -> Result<(), Failure> {
    if !cfg!(target_os = "macos") {
        return Err(Failure::other("open hands files to the Doklin app, which runs only on a Mac"));
    }
    let here = std::env::current_dir().map_err(|e| Failure::other(format!("could not tell which folder this is: {}", e)))?;
    let mut paths = Vec::new();
    for given in &args.positionals {
        let path = absolute(&here, given);
        if !path.exists() {
            return Err(Failure::not_found(format!("there is no file or folder at \"{}\"", given)));
        }
        paths.push(path);
    }
    let shown: Vec<String> = paths.iter().map(|p| p.display().to_string()).collect();
    if ctx.dry_run {
        ctx.answer(&json!({ "paths": shown, "opened": false }), || match args.positionals.as_slice() {
            [] => "Would open the Doklin app.".to_string(),
            given => format!("Would open {} in Doklin.", given.join(", ")),
        });
        return Ok(());
    }
    hand_to_app(&paths)?;
    // A launcher says nothing when it worked; a program still gets its answer.
    if ctx.json {
        println!("{}", json!({ "paths": shown, "opened": true }));
    }
    Ok(())
}

fn absolute(here: &Path, given: &str) -> PathBuf {
    let path = Path::new(given);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        here.join(path)
    }
}

/// macOS-only: `open(1)` does the handing over.
#[cfg(target_os = "macos")]
fn hand_to_app(paths: &[PathBuf]) -> Result<(), Failure> {
    let app = own_app().map(|p| p.into_os_string()).unwrap_or_else(|| "Doklin".into());
    let mut open = std::process::Command::new("open");
    if paths.is_empty() {
        open.arg("-a").arg(&app);
    } else {
        // -n starts a second copy so the paths arrive as its argv; the app's
        // single-instance plugin hands them to the copy already running, and
        // the second one exits. A plain `open -a` on a running app only
        // activates it and drops --args.
        open.arg("-n").arg("-a").arg(&app).arg("--args").args(paths);
    }
    match open.status() {
        Ok(status) if status.success() => Ok(()),
        _ => Err(Failure::other("could not open Doklin — is the app installed?")),
    }
}

#[cfg(not(target_os = "macos"))]
fn hand_to_app(_paths: &[PathBuf]) -> Result<(), Failure> {
    unreachable!("refused above: there is no app off a Mac")
}

/// macOS-only: the app this binary came inside — `Doklin.app/Contents/Helpers/doklin`,
/// usually reached through a link on the PATH — so a copy of the command opens
/// its own app, not whichever one Launch Services finds by name. `None` for a
/// binary that lives on its own, which then opens the app called Doklin.
#[cfg(target_os = "macos")]
fn own_app() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
    let helpers = exe.parent()?;
    let contents = helpers.parent()?;
    let bundle = contents.parent()?;
    let inside = helpers.file_name()? == "Helpers"
        && contents.file_name()? == "Contents"
        && bundle.extension()? == "app";
    inside.then(|| bundle.to_path_buf())
}
