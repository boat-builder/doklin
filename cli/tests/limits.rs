//! The request path's guards, end to end: the built `doklin` against a
//! loopback stand-in for a worker that answers from a script, with its own
//! HOME, so the credentials and the count are scratch ones.

mod common;

use std::path::Path;

use common::{doklin, home, login_answer_with, refusal, Fake};
use serde_json::{json, Value};

fn usage_of(home: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(home.join(".config/doklin/usage.json")).unwrap()).unwrap()
}

fn used(head: &str) -> Option<&str> {
    head.lines().find_map(|l| l.strip_prefix("x-doklin-used:")).map(str::trim)
}

const SLOW_DOWN: &str = "{\"error\":\"This device is sending too many requests — it will slow down by itself.\"}";

fn login_answer(cli_daily: u64) -> String {
    login_answer_with(cli_daily, &["read"])
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
