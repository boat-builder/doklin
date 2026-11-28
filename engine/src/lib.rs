//! Doklin's sync engine and version store, with no app around them.
//!
//! Two apps build this in: the Mac app (src-tauri/, whose Tauri commands are
//! thin wrappers over the functions here) and the iPhone app (ffi/, which
//! hands the same commands to Swift by name). Whatever differs between the
//! two is said once, in `Setup` and `Host`; nothing in here knows which app
//! it is running in.
//!
//! ```text
//! host.rs       Core, Setup and the Host trait: the app, as the engine sees it
//! paths.rs      paths as they are written down, where the app's folder can move
//! cloud/        the sync engine, its manager and its commands
//! https.rs      every HTTPS client the apps build: the OS checks certificates
//! versions/     the version store, its manager and its commands
//! sidecar.rs    a document's `.meta.jsonl`, merged by its records
//! boards.rs     a folder's `boards.json`, merged by its records
//! command.rs    every command by name, JSON in and JSON out
//! ```

pub mod boards;
pub mod cloud;
pub mod command;
mod host;
pub mod https;
pub mod paths;
pub mod sidecar;
pub mod versions;

pub use host::{Core, Host, Secrets, Setup};

/// A name no tree walk, search or sync scan ever looks at: hidden files, and
/// the folders build tools fill. Mirrored by the worker (`IGNORED_NAMES`,
/// cloud-worker/src/documents.ts) and the iPhone app (`isHiddenOrIgnored`,
/// ios/DoklinKit/Sources/DoklinKit/Models/Files.swift) — change all three.
pub fn is_hidden_or_ignored(name: &str) -> bool {
    if name.starts_with('.') {
        return true;
    }
    matches!(name, "node_modules" | "target" | "dist" | "build" | "__pycache__" | ".git")
}

/// The files Doklin syncs, versions and exports: markdown and html
/// documents, a document's comments (`<stem>.meta.jsonl`), and a folder's
/// `boards.json` (how the apps show it as a board). Everything else — a
/// picture, a PDF, a script an agent wrote, a cloned repository's sources —
/// stays on its device and costs no request. Mirrored by the worker
/// (`syncs`, cloud-worker/src/layout.ts), which refuses anything else:
/// change both.
pub fn syncs(rel: &str) -> bool {
    is_document(rel) || sidecar::is_sidecar(rel) || boards::is_boards(rel)
}

/// Whether `rel` is a document: a markdown or html file. Of the files that
/// sync, only a document is shared, published or linked to by itself; a
/// sidecar is its document's, and `boards.json` its folder's.
pub fn is_document(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel).to_ascii_lowercase();
    DOCUMENT_SUFFIXES.iter().any(|suffix| name.len() > suffix.len() && name.ends_with(suffix))
}

const DOCUMENT_SUFFIXES: [&str; 5] = [".md", ".markdown", ".mdown", ".mkd", ".html"];
