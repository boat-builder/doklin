//! `doklin` — work with a Doklin workspace from anywhere (docs/cloud.md §8.6).
//!
//! A workspace is a folder of documents on somebody's Mac, synced through a
//! domain of their own. An agent on another computer has no such folder, and
//! this program does not give it one: every command is a request or two to
//! that domain's document API, and the only thing kept here is the token a
//! `doklin login` left behind.
//!
//! On macOS the same word has always opened files in the app
//! (`doklin notes.md`), so an argument that is not a command is still that.

mod args;
mod commands;
mod creds;
mod help;
mod http;
mod text;

use std::io::IsTerminal;

use args::{Accepts, Args};
use commands::Ctx;
use serde_json::Value;

/// Why a command did not do what was asked, and the exit code that says so:
/// `2` bad usage · `3` not found · `4` not permitted · `5` conflict ·
/// `6` not logged in, or the login was revoked · `7` the workspace's worker
/// is too old for this command · `1` anything else.
#[derive(Debug)]
pub struct Failure {
    pub exit: i32,
    pub message: String,
    /// The HTTP status behind it, when the domain is what refused.
    pub status: Option<u16>,
    /// The domain's whole answer: where the words occur, what the revision is now.
    pub detail: Option<Value>,
}

impl Failure {
    fn with(exit: i32, message: impl Into<String>) -> Self {
        Failure { exit, message: message.into(), status: None, detail: None }
    }
    pub fn other(message: impl Into<String>) -> Self {
        Self::with(1, message)
    }
    pub fn usage(message: impl Into<String>) -> Self {
        Self::with(2, message)
    }
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::with(3, message)
    }
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::with(5, message)
    }
    pub fn not_logged_in(message: impl Into<String>) -> Self {
        Self::with(6, message)
    }
    pub fn too_old(message: impl Into<String>) -> Self {
        Self::with(7, message)
    }
}

pub struct Command {
    pub name: &'static str,
    /// How it is typed, for its own help.
    pub usage: &'static str,
    /// What it does, in a line.
    pub about: &'static str,
    pub accepts: Accepts,
    run: fn(&Args, &Ctx) -> Result<(), Failure>,
}

const VERSION_FLAGS: &[&str] = &["md", "html"];

pub const COMMANDS: &[Command] = &[
    Command {
        name: "login",
        usage: "doklin login <domain> <code>",
        about: "Log this machine in, with the line the workspace's owner gave you. The code works once.",
        accepts: Accepts { values: &[], switches: &[] },
        run: commands::login,
    },
    Command {
        name: "logout",
        usage: "doklin logout",
        about: "Log this machine out: its token is revoked on the domain and forgotten here.",
        accepts: Accepts { values: &[], switches: &[] },
        run: commands::logout,
    },
    Command {
        name: "whoami",
        usage: "doklin whoami",
        about: "Which workspace and agent this is, and what it may do.",
        accepts: Accepts { values: &[], switches: &[] },
        run: commands::whoami,
    },
    Command {
        name: "ls",
        usage: "doklin ls [folder] [--deep]",
        about: "What a folder holds: its folders, its documents (with their versions and public addresses) and its plain files. --deep lists everything beneath it.",
        accepts: Accepts { values: &[], switches: &["deep"] },
        run: commands::ls,
    },
    Command {
        name: "info",
        usage: "doklin info <doc>",
        about: "A document's versions — revision, size, who changed it and when — its comment threads and its public addresses.",
        accepts: Accepts { values: &[], switches: &[] },
        run: commands::info,
    },
    Command {
        name: "read",
        usage: "doklin read <doc> [--md|--html] [--clean] [-o <file>]",
        about: "Print a document's text. Its revision goes to stderr, for `write --if-rev`. --clean leaves out comment markers.",
        accepts: Accepts { values: &["output"], switches: &["md", "html", "clean"] },
        run: commands::read,
    },
    Command {
        name: "search",
        usage: "doklin search <text> [--in <folder>] [--limit <n>]",
        about: "Documents containing the text, whatever its case, with the matching lines.",
        accepts: Accepts { values: &["in", "limit"], switches: &[] },
        run: commands::search,
    },
    Command {
        name: "comments",
        usage: "doklin comments <doc>",
        about: "Every comment thread on a document: its id, the text it is on, and who said what.",
        accepts: Accepts { values: &[], switches: &[] },
        run: commands::comments,
    },
    Command {
        name: "comment",
        usage: "doklin comment <doc> --on \"<text>\" -m \"<comment>\" [--md|--html]\n       doklin comment rm <doc> <thread>",
        about: "Start a comment thread on some text of a document — or, with rm, remove a thread.",
        accepts: Accepts { values: &["on", "message"], switches: VERSION_FLAGS },
        run: commands::comment,
    },
    Command {
        name: "reply",
        usage: "doklin reply <doc> <thread> -m \"<comment>\"",
        about: "Answer a comment thread. `doklin comments` shows the thread ids.",
        accepts: Accepts { values: &["message"], switches: &[] },
        run: commands::reply,
    },
    Command {
        name: "write",
        usage: "doklin write <doc> [--md|--html] [--if-rev <n> | --force] [--from <file>]",
        about: "Create a document, or replace one version of it, with what is piped in (or --from a file). Replacing needs --if-rev with the revision you read, or --force.",
        accepts: Accepts { values: &["if-rev", "from"], switches: &["md", "html", "force"] },
        run: commands::write,
    },
    Command {
        name: "edit",
        usage: "doklin edit <doc> --find \"<old>\" --replace \"<new>\" [--all] [--md|--html]",
        about: "Change part of a document. --find must occur exactly once, unless --all. Refused if the document changed while this ran.",
        accepts: Accepts { values: &["find", "replace"], switches: &["md", "html", "all"] },
        run: commands::edit,
    },
    Command {
        name: "mv",
        usage: "doklin mv <from> <to>",
        about: "Move or rename a document (both versions and its comments), a plain file or a folder. A destination that is a folder means into it.",
        accepts: Accepts { values: &[], switches: &[] },
        run: commands::mv,
    },
    Command {
        name: "rm",
        usage: "doklin rm <doc> [--md|--html]",
        about: "Remove a document, with its comments — or one version of it with --md or --html, never the last.",
        accepts: Accepts { values: &[], switches: VERSION_FLAGS },
        run: commands::rm,
    },
    Command {
        name: "publish",
        usage: "doklin publish <doc or folder> [--slug <address>] [--title <t>] [--desc <d>]",
        about: "Make a document public — or, for a folder, everything in it. Prints the address. Try a folder with --dry-run first.",
        accepts: Accepts { values: &["slug", "title", "desc"], switches: &[] },
        run: commands::publish,
    },
    Command {
        name: "unpublish",
        usage: "doklin unpublish <doc, folder or address> [--slug]",
        about: "Stop publishing. Name the document or folder, or the last part of its address; --slug says it is the address.",
        accepts: Accepts { values: &[], switches: &["slug"] },
        run: commands::unpublish,
    },
    Command {
        name: "published",
        usage: "doklin published",
        about: "Everything that is public: its address, what it shows, who published it.",
        accepts: Accepts { values: &[], switches: &[] },
        run: commands::published,
    },
];

fn main() {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    // Decided before anything runs, so a refusal is reported the same way
    // the answer would have been.
    let json = raw.iter().any(|a| a == "--json") || !std::io::stdout().is_terminal();
    let code = match run(&raw, json) {
        Ok(()) => 0,
        Err(failure) => {
            report(&failure, json);
            failure.exit
        }
    };
    std::process::exit(code);
}

fn run(raw: &[String], json: bool) -> Result<(), Failure> {
    let Some(first) = raw.first() else {
        return no_arguments();
    };
    match first.as_str() {
        "help" | "--help" | "-h" => return help::print(raw.get(1).map(String::as_str)),
        "version" | "--version" | "-V" => {
            println!("doklin {}", env!("CARGO_PKG_VERSION"));
            return Ok(());
        }
        _ => {}
    }
    let Some(command) = COMMANDS.iter().find(|c| c.name == first) else {
        return not_a_command(raw);
    };
    let args = args::parse(&raw[1..], &command.accepts)?;
    if args.has("help") {
        help::command(command);
        return Ok(());
    }
    let ctx = Ctx { json, dry_run: args.has("dry-run"), workspace: args.value("workspace").map(String::from) };
    (command.run)(&args, &ctx)
}

/// A refusal, on stderr: a sentence for a person, or the domain's own JSON
/// for a program — either way with what is needed to act on it.
fn report(failure: &Failure, json: bool) {
    if json {
        let mut body = match &failure.detail {
            Some(Value::Object(map)) => Value::Object(map.clone()),
            _ => serde_json::json!({}),
        };
        body["error"] = Value::String(failure.message.clone());
        body["exit"] = failure.exit.into();
        eprintln!("{}", body);
        return;
    }
    eprintln!("doklin: {}", failure.message);
    let Some(detail) = &failure.detail else { return };
    // Where the words of a refused comment occur, so more of them can be quoted.
    for at in detail["occurrences"].as_array().into_iter().flatten() {
        let inside = at.get("inside").and_then(Value::as_str).map(|w| format!("   (inside {})", w)).unwrap_or_default();
        eprintln!("  line {}: {}{}", at["line"], at["text"].as_str().unwrap_or(""), inside);
    }
    for el in detail["candidates"].as_array().into_iter().flatten() {
        eprintln!("  <{}> {}", el["tag"].as_str().unwrap_or(""), el["text"].as_str().unwrap_or(""));
    }
}

#[cfg(target_os = "macos")]
fn no_arguments() -> Result<(), Failure> {
    open_in_app(&[])
}

#[cfg(not(target_os = "macos"))]
fn no_arguments() -> Result<(), Failure> {
    help::print(None)
}

#[cfg(target_os = "macos")]
fn not_a_command(raw: &[String]) -> Result<(), Failure> {
    if raw[0].starts_with('-') {
        return Err(Failure::usage(format!("there is no {} option — run `doklin help`", raw[0])));
    }
    open_in_app(raw)
}

#[cfg(not(target_os = "macos"))]
fn not_a_command(raw: &[String]) -> Result<(), Failure> {
    Err(Failure::usage(format!("\"{}\" is not a doklin command — run `doklin help`", raw[0])))
}

/// Open files or a folder in the Doklin app — what `doklin <path>` has
/// always meant on a Mac. Each path gets a window of its own.
#[cfg(target_os = "macos")]
fn open_in_app(paths: &[String]) -> Result<(), Failure> {
    let mut open = std::process::Command::new("open");
    if paths.is_empty() {
        open.args(["-a", "Doklin"]);
    } else {
        let here = std::env::current_dir().unwrap_or_default();
        open.args(["-n", "-a", "Doklin", "--args"]);
        for path in paths {
            open.arg(if path.starts_with('/') { std::path::PathBuf::from(path) } else { here.join(path) });
        }
    }
    match open.status() {
        Ok(status) if status.success() => Ok(()),
        _ => Err(Failure::other("could not open Doklin — is the app installed? For the commands, run `doklin help`")),
    }
}
