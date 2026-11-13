//! The credentials file — the one thing this program keeps.
//!
//! `~/.config/doklin/credentials.json` (`$XDG_CONFIG_HOME` honoured), mode
//! 0600 in a 0700 directory: one entry per domain, each holding the token a
//! `doklin login` left on this machine. There is deliberately no other place
//! a credential can come from — no environment variable, no flag, no
//! keychain — so there is one thing to protect and one thing to remove.

use std::fs;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::Failure;

const FILE_VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Workspace {
    /// `https://notes.example.com` — no trailing slash.
    pub endpoint: String,
    /// The workspace's name, as the domain gave it at login.
    #[serde(default)]
    pub name: String,
    /// The agent this machine is logged in as.
    #[serde(default)]
    pub agent: String,
    pub token: String,
    /// What the domain's worker could do when it was last asked — refreshed
    /// when a command needs something that is not listed.
    #[serde(default)]
    pub features: Vec<String>,
}

impl Workspace {
    /// The domain alone: what `-w` is compared against, and what messages say.
    pub fn domain(&self) -> &str {
        domain_of(&self.endpoint)
    }
}

pub fn domain_of(endpoint: &str) -> &str {
    let rest = endpoint.split_once("://").map(|(_, r)| r).unwrap_or(endpoint);
    rest.split('/').next().unwrap_or(rest)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Credentials {
    pub version: u32,
    #[serde(default)]
    pub workspaces: Vec<Workspace>,
}

impl Default for Credentials {
    fn default() -> Self {
        Credentials { version: FILE_VERSION, workspaces: Vec::new() }
    }
}

fn config_dir() -> Result<PathBuf, Failure> {
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(xdg).join("doklin"));
    }
    let home = std::env::var_os("HOME")
        .filter(|v| !v.is_empty())
        .ok_or_else(|| Failure::other("there is no home directory to keep the login in — set HOME"))?;
    Ok(PathBuf::from(home).join(".config").join("doklin"))
}

pub fn path() -> Result<PathBuf, Failure> {
    Ok(config_dir()?.join("credentials.json"))
}

/// What is on disk, or nothing. A file that does not parse is an error
/// rather than an empty login: overwriting it would throw tokens away.
pub fn load() -> Result<Credentials, Failure> {
    let file = path()?;
    let text = match fs::read_to_string(&file) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Credentials::default()),
        Err(e) => return Err(Failure::other(format!("could not read {}: {}", file.display(), e))),
    };
    serde_json::from_str(&text)
        .map_err(|e| Failure::other(format!("{} is not a credentials file ({}) — remove it and log in again", file.display(), e)))
}

/// Write the whole file, readable by this user alone, through a temp file
/// so a crash never leaves half a login.
pub fn save(creds: &Credentials) -> Result<(), Failure> {
    let dir = config_dir()?;
    let fail = |what: &str, e: std::io::Error| Failure::other(format!("could not {} {}: {}", what, dir.display(), e));
    fs::create_dir_all(&dir).map_err(|e| fail("create", e))?;
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(|e| fail("protect", e))?;
    let file = dir.join("credentials.json");
    let tmp = dir.join("credentials.json.tmp");
    let body = serde_json::to_vec_pretty(creds).unwrap_or_default();
    let mut out = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(|e| fail("write in", e))?;
    out.write_all(&body).and_then(|_| out.write_all(b"\n")).map_err(|e| fail("write in", e))?;
    drop(out);
    fs::rename(&tmp, &file).map_err(|e| fail("write in", e))
}

/// The workspace a command means: the only one, or the one `-w` names.
pub fn pick<'a>(creds: &'a Credentials, wanted: Option<&str>) -> Result<&'a Workspace, Failure> {
    let all = &creds.workspaces;
    if let Some(wanted) = wanted {
        let wanted = domain_of(wanted.trim_end_matches('/'));
        return all.iter().find(|w| w.domain().eq_ignore_ascii_case(wanted)).ok_or_else(|| {
            Failure::not_logged_in(format!(
                "this machine is not logged in to {} — run: doklin login {} <code>",
                wanted, wanted
            ))
        });
    }
    match all.as_slice() {
        [] => Err(Failure::not_logged_in(
            "this machine is not logged in — ask the workspace's owner for a login line (Doklin → Cloud → Agents) and run it",
        )),
        [one] => Ok(one),
        many => Err(Failure::usage(format!(
            "this machine is logged in to {} — say which with -w <domain>",
            many.iter().map(|w| w.domain().to_string()).collect::<Vec<_>>().join(", ")
        ))),
    }
}
