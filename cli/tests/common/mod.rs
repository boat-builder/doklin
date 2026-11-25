//! The built `doklin` against a loopback stand-in for a worker that answers
//! from a script, with a HOME of its own, so the credentials and the count
//! are scratch ones. Shared by the end-to-end tests here.

#![allow(dead_code)]

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::{Arc, Mutex};

use serde_json::Value;

/// A worker that answers each request with the next of `script`, and keeps
/// the request heads it was sent (lower-cased), and their bodies.
pub struct Fake {
    pub endpoint: String,
    seen: Arc<Mutex<Vec<(String, String)>>>,
}

impl Fake {
    pub fn serve(script: Vec<(u16, &'static str, String)>) -> Fake {
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
                kept.lock().unwrap().push((head, String::from_utf8_lossy(&rest).to_string()));
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

    pub fn heads(&self) -> Vec<String> {
        self.seen.lock().unwrap().iter().map(|(head, _)| head.clone()).collect()
    }

    pub fn bodies(&self) -> Vec<String> {
        self.seen.lock().unwrap().iter().map(|(_, body)| body.clone()).collect()
    }

    pub fn domain(&self) -> &str {
        self.endpoint.trim_start_matches("http://")
    }
}

pub fn home(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("doklin-cli-limits-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// `doklin <args>`, piped (so it answers in JSON), with `home` as its HOME.
pub fn doklin(home: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_doklin"))
        .args(args)
        .env("HOME", home)
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap()
}

pub fn refusal(out: &Output) -> Value {
    serde_json::from_slice(&out.stderr).unwrap_or_else(|_| panic!("not a JSON refusal: {}", String::from_utf8_lossy(&out.stderr)))
}

/// What a login answers, for an agent that may do `scopes`.
pub fn login_answer_with(cli_daily: u64, scopes: &[&str]) -> String {
    serde_json::json!({
        "token": "dka_test",
        "agent": { "id": "a-00000001", "name": "Bot" },
        "scopes": scopes,
        "workspace": { "name": "Notes" },
        "limits": { "plan": "free", "cliDaily": cli_daily, "fleetToday": null }
    })
    .to_string()
}
