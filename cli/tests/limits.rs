//! The request path's guards, end to end: the built `doklin` against a
//! loopback stand-in for a worker that answers from a script, with its own
//! HOME, so the credentials and the count are scratch ones.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

/// A worker that answers each request with the next of `script`, and keeps
/// the request heads it was sent (lower-cased).
struct Fake {
    endpoint: String,
    seen: Arc<Mutex<Vec<String>>>,
}

impl Fake {
    fn serve(script: Vec<(u16, &'static str, String)>) -> Fake {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let kept = seen.clone();
        std::thread::spawn(move || {
            for (status, extra, body) in script {
                let Ok((mut conn, _)) = listener.accept() else { return };
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") && conn.read(&mut byte).map(|n| n == 1).unwrap_or(false) {
                    head.push(byte[0]);
                }
                let head = String::from_utf8_lossy(&head).to_lowercase();
                let length = head
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length:"))
                    .and_then(|n| n.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                let mut rest = vec![0u8; length];
                let _ = conn.read_exact(&mut rest);
                kept.lock().unwrap().push(head);
                let kind = if body.starts_with('{') { "application/json" } else { "text/plain" };
                let _ = write!(
                    conn,
                    "HTTP/1.1 {} X\r\ncontent-type: {}\r\ncontent-length: {}\r\nconnection: close\r\n{}\r\n{}",
                    status,
                    kind,
                    body.len(),
                    extra,
                    body
                );
            }
        });
        Fake { endpoint, seen }
    }

    fn heads(&self) -> Vec<String> {
        self.seen.lock().unwrap().clone()
    }

    fn domain(&self) -> &str {
        self.endpoint.trim_start_matches("http://")
    }
}

fn home(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("doklin-cli-limits-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// `doklin <args>`, piped (so it answers in JSON), with `home` as its HOME.
fn doklin(home: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_doklin"))
        .args(args)
        .env("HOME", home)
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap()
}

fn refusal(out: &Output) -> Value {
    serde_json::from_slice(&out.stderr).unwrap_or_else(|_| panic!("not a JSON refusal: {}", String::from_utf8_lossy(&out.stderr)))
}

fn usage_of(home: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(home.join(".config/doklin/usage.json")).unwrap()).unwrap()
}

fn used(head: &str) -> Option<&str> {
    head.lines().find_map(|l| l.strip_prefix("x-doklin-used:")).map(str::trim)
}

const SLOW_DOWN: &str = "{\"error\":\"This device is sending too many requests — it will slow down by itself.\"}";

fn login_answer(cli_daily: u64) -> String {
    json!({
        "token": "dka_test",
        "agent": { "id": "a-00000001", "name": "Bot" },
        "scopes": ["read"],
        "workspace": { "name": "Notes" },
        "limits": { "plan": "free", "cliDaily": cli_daily, "fleetToday": null }
    })
    .to_string()
}

fn tree() -> String {
    json!({ "dir": "", "folders": [], "documents": [] }).to_string()
}

#[test]
fn a_429_is_asked_once_more_every_request_counts_and_the_allowance_holds() {
    let home = home("allowance");
    let worker = Fake::serve(vec![
        (429, "retry-after: 0\r\n", SLOW_DOWN.to_string()),
        (201, "", login_answer(4)),
        (200, "", tree()),
        (200, "", tree()),
        // Only reached after the day turns over.
        (200, "", tree()),
    ]);

    let login = doklin(&home, &["login", &worker.endpoint, "dkla-TEST"]);
    assert_eq!(login.status.code(), Some(0), "{}", String::from_utf8_lossy(&login.stderr));
    let heads = worker.heads();
    assert_eq!(heads.len(), 2, "the 429 was asked once more");
    assert!(heads.iter().all(|h| h.starts_with("post /api/agent/login") && used(h).is_none()), "a login reports nothing");
    let count = &usage_of(&home)[worker.domain()];
    assert_eq!(count["requests"], 2);
    assert_eq!(count["limits"]["cliDaily"], 4);

    assert_eq!(doklin(&home, &["ls"]).status.code(), Some(0));
    assert_eq!(used(&worker.heads()[2]), Some("3"), "the first signed-in request reports every request today");
    assert_eq!(doklin(&home, &["ls"]).status.code(), Some(0));
    assert_eq!(used(&worker.heads()[3]), None, "and the next one, within 15 minutes, does not");

    let spent = doklin(&home, &["ls"]);
    assert_eq!(spent.status.code(), Some(8));
    let said = refusal(&spent);
    assert_eq!(said["exit"], 8);
    assert!(said["error"].as_str().unwrap().starts_with(&format!("this machine has sent its 4 requests to {} for today", worker.domain())));
    assert_eq!(worker.heads().len(), 4, "past the allowance nothing is sent");
    assert_eq!(usage_of(&home)[worker.domain()]["requests"], 4);

    // Yesterday's count: a new UTC day starts afresh, and reports at once.
    let mut file = usage_of(&home);
    let day = file[worker.domain()]["day"].as_u64().unwrap();
    file[worker.domain()]["day"] = json!(day - 1);
    std::fs::write(home.join(".config/doklin/usage.json"), file.to_string()).unwrap();
    assert_eq!(doklin(&home, &["ls"]).status.code(), Some(0));
    assert_eq!(used(&worker.heads()[4]), Some("1"));
    assert_eq!(usage_of(&home)[worker.domain()]["day"].as_u64().unwrap(), day);
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn a_second_429_is_exit_8() {
    let home = home("twice");
    let worker = Fake::serve(vec![
        (429, "retry-after: 0\r\n", SLOW_DOWN.to_string()),
        (429, "retry-after: 0\r\n", SLOW_DOWN.to_string()),
        (201, "", login_answer(4)),
    ]);
    let out = doklin(&home, &["login", &worker.endpoint, "dkla-TEST"]);
    assert_eq!(out.status.code(), Some(8));
    assert_eq!(worker.heads().len(), 2, "asked once more, and no more");
    let said = refusal(&out);
    assert!(said["error"].as_str().unwrap().contains("is sending too many requests — wait a minute"), "{}", said);
    assert!(!home.join(".config/doklin/credentials.json").exists());
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn cloudflare_s_daily_limit_is_exit_8_at_once() {
    let home = home("daily");
    let worker = Fake::serve(vec![
        (429, "retry-after: 0\r\n", "error code: 1027".to_string()),
        (201, "", login_answer(4)),
    ]);
    let out = doklin(&home, &["login", &worker.endpoint, "dkla-TEST"]);
    assert_eq!(out.status.code(), Some(8));
    assert_eq!(worker.heads().len(), 1, "never asked again");
    let said = refusal(&out);
    assert!(said["error"].as_str().unwrap().starts_with(&format!("today's Cloudflare requests for {} are used up", worker.domain())), "{}", said);
    let _ = std::fs::remove_dir_all(&home);
}
