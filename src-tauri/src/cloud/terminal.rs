//! The terminal's login. On a Mac where a workspace is connected, the app
//! logs the `doklin` inside its bundle in to it, so nobody makes a login
//! code and pastes it. The terminal is an agent of this person's, named
//! after them and this Mac — its own row under their agents, its edits and
//! comments signed with that name — and it may do everything an agent may:
//! the person is at the keyboard.
//!
//! The app never writes the CLI's credentials file. It mints a code exactly
//! as the Agents view does (only the hash goes up) and hands it to
//! `doklin login <endpoint> -` on stdin: the CLI's own login stays the one
//! writer of that file, and the code never shows in a process list.

use std::io::Write as _;
use std::path::Path;
use std::process::{Command, Stdio};

use serde_json::Value;
use tauri::AppHandle;

use super::manifest::clean_name;
use super::remote::{AgentRecord, Remote as _};
use super::{describe_agents, flows, mint_agent_login, workspace_call, WorkspaceCall};

/// Everything an agent may do.
const SCOPES: [&str; 4] = ["read", "comment", "edit", "publish"];

/// Log the terminal in to the workspace at `root`, by running `helper` (the
/// bundled `doklin`). A terminal that is already logged in there — by an
/// earlier login, or a line somebody ran by hand — is left alone. Answers a
/// sentence either way. Blocking: it runs the helper and waits on the domain.
pub(crate) fn log_cli_in(app: &AppHandle, root: &str, helper: &Path) -> Result<String, String> {
    let call = workspace_call(app, root).map_err(|why| format!("Could not log doklin in to {}: {}.", root, why))?;
    let domain = call.domain.clone();
    let failed = |why: String| format!("Could not log doklin in to {}: {}.", domain, why.trim_end_matches('.'));
    match run(helper, &["whoami", "-w", &domain, "--json"], None) {
        Ok(me) => return Ok(format!("doklin was already logged in to {}, as {}.", domain, agent_of(&me))),
        // Not logged in, or the login stopped working: log in afresh.
        Err(refused) if refused.exit == NOT_LOGGED_IN => {}
        Err(refused) => return Err(failed(refused.message)),
    }
    let code = tauri::async_runtime::block_on(terminal_code(&call)).map_err(failed)?;
    let answer = run(helper, &["login", &call.endpoint, "-", "--json"], Some(&code)).map_err(|r| failed(r.message))?;
    Ok(format!("Logged doklin in to {} as {}.", domain, agent_of(&answer)))
}

/// A login code for this Mac's terminal agent: the one already among this
/// person's agents, found by its name, or a new one. Found rather than
/// remembered, so a workspace disconnected and connected again finds the
/// same agent instead of adding a second. An agent that was removed is
/// simply not found, and is made again.
async fn terminal_code(call: &WorkspaceCall) -> Result<String, String> {
    let meta = call.remote.meta().await.map_err(|e| flows::describe(&call.domain, e.into()))?;
    let person = meta.you.map(|you| you.name).unwrap_or_default();
    let name = terminal_name(&person, &call.device.name);
    let agents = call.remote.list_agents().await.map_err(|e| describe_agents(&call.domain, e))?;
    let (login, hash) = mint_agent_login(&call.endpoint);
    let minted = match find_terminal(&agents, &name) {
        // Its permissions stay what its person last chose for it.
        Some(agent) => call.remote.new_agent_code(&agent.id, &hash, login.expires_at).await.map(drop),
        None => {
            let scopes = SCOPES.map(String::from);
            call.remote.create_agent(&name, &scopes, &hash, login.expires_at).await.map(drop)
        }
    };
    minted.map_err(|e| describe_agents(&call.domain, e))?;
    Ok(login.code)
}

/// `Sherin's terminal (Sherin's MacBook Pro)` — or, for a creator who has
/// not said who they are, `Terminal (…)`. Capped as the worker caps it, so
/// the name looked for is the name it keeps.
fn terminal_name(person: &str, mac: &str) -> String {
    let person = person.trim();
    let name = if person.is_empty() {
        format!("Terminal ({})", mac)
    } else {
        format!("{}'s terminal ({})", person, mac)
    };
    clean_name(&name, "Terminal")
}

/// The asker's own agent of that name. The list holds everybody's for an
/// owner, and somebody else's agent is never this Mac's terminal.
fn find_terminal<'a>(agents: &'a [AgentRecord], name: &str) -> Option<&'a AgentRecord> {
    agents.iter().find(|agent| agent.mine && agent.name == name)
}

fn agent_of(answer: &Value) -> &str {
    answer["agent"]["name"].as_str().unwrap_or("an agent")
}

/// The CLI's exit code for "not logged in, or the login was revoked"
/// (cli/src/main.rs — change both).
const NOT_LOGGED_IN: i32 = 6;

/// A refusal from the helper: its exit code, and its sentence.
struct Refused {
    exit: i32,
    message: String,
}

/// Run the helper with `--json`, so its answer is the JSON on stdout and a
/// refusal is `{"error", "exit"}` on stderr. `input` is piped in, then
/// closed.
fn run(helper: &Path, args: &[&str], input: Option<&str>) -> Result<Value, Refused> {
    let fail = |e: std::io::Error| Refused { exit: -1, message: format!("could not run {}: {}", helper.display(), e) };
    let mut child = Command::new(helper)
        .args(args)
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(fail)?;
    if let (Some(input), Some(mut pipe)) = (input, child.stdin.take()) {
        writeln!(pipe, "{}", input).map_err(fail)?;
    }
    let out = child.wait_with_output().map_err(fail)?;
    if out.status.success() {
        return Ok(serde_json::from_slice(&out.stdout).unwrap_or(Value::Null));
    }
    let said: Value = serde_json::from_slice(&out.stderr).unwrap_or(Value::Null);
    Err(Refused {
        exit: out.status.code().unwrap_or(-1),
        message: said["error"]
            .as_str()
            .map(String::from)
            .unwrap_or_else(|| String::from_utf8_lossy(&out.stderr).trim().to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(id: &str, name: &str, mine: bool) -> AgentRecord {
        AgentRecord { id: id.into(), name: name.into(), mine, ..Default::default() }
    }

    #[test]
    fn the_terminal_is_named_after_its_person_and_mac() {
        assert_eq!(terminal_name("Sherin", "Sherin's MacBook Pro"), "Sherin's terminal (Sherin's MacBook Pro)");
        assert_eq!(terminal_name("  ", "Studio"), "Terminal (Studio)");
        let long = terminal_name(&"a".repeat(100), "Studio");
        assert_eq!(long.encode_utf16().count(), super::super::manifest::MAX_NAME_LEN);
    }

    #[test]
    fn the_terminal_is_found_among_ones_own_agents_by_name() {
        let name = "Sherin's terminal (Studio)";
        let agents = vec![
            // An owner's list holds everybody's: another person's agent of
            // the same name is not this Mac's terminal.
            agent("a-1", name, false),
            agent("a-2", "Sherin's terminal (Laptop)", true),
            agent("a-3", name, true),
        ];
        assert_eq!(find_terminal(&agents, name).map(|a| a.id.as_str()), Some("a-3"));
        // Removed (or renamed): not found, so a new one is made.
        assert!(find_terminal(&agents[..2], name).is_none());
    }

    #[test]
    fn a_new_terminal_may_do_everything() {
        assert_eq!(super::super::clean_scopes(SCOPES.map(String::from).to_vec()), SCOPES.map(String::from).to_vec());
    }
}
