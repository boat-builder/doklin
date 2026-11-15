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
//! versions/     the version store, its manager and its commands
//! command.rs    every command by name, JSON in and JSON out
//! ```

pub mod cloud;
pub mod command;
mod host;
pub mod paths;
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
