//! Tags, end to end: what `doklin tags`, `doklin tag` and `--where` send, and
//! what a worker from before tags is told — exit 7, never a listing that
//! quietly ignored the filter.

mod common;

use common::{doklin, home, login_answer_with, refusal, Fake};
use serde_json::{json, Value};

fn logged_in(name: &str, script: Vec<(u16, &'static str, String)>) -> (std::path::PathBuf, Fake) {
    let home = home(&format!("tags-{}", name));
    let mut all = vec![(201, "", login_answer_with(5000, &["read", "edit"]))];
    all.extend(script);
    let worker = Fake::serve(all);
    let login = doklin(&home, &["login", &worker.endpoint, "dkla-TEST"]);
    assert_eq!(login.status.code(), Some(0), "{}", String::from_utf8_lossy(&login.stderr));
    (home, worker)
}

fn answer(out: &std::process::Output) -> Value {
    serde_json::from_slice(&out.stdout).unwrap_or_else(|_| panic!("not JSON: {}", String::from_utf8_lossy(&out.stdout)))
}

#[test]
fn where_narrows_ls_and_search_and_a_worker_from_before_tags_is_exit_7() {
    let narrowed = json!({
        "dir": "Library",
        "folders": [],
        "where": [{ "name": "status", "value": "Doing" }],
        "documents": [{ "path": "Library/a", "md": { "rev": 1 }, "tags": [{ "name": "status", "value": "Doing", "known": true }] }]
    });
    let (home, worker) = logged_in(
        "where",
        vec![
            (200, "", narrowed.to_string()),
            (200, "", json!({ "dir": "Library", "folders": [], "documents": [] }).to_string()),
            (200, "", json!({ "query": "", "dir": "", "where": [{ "name": "status", "value": null }], "results": [], "total": 0 }).to_string()),
            (200, "", json!({ "query": "", "dir": "", "results": [], "total": 0 }).to_string()),
        ],
    );

    let out = doklin(&home, &["ls", "Library", "--where", "status=Doing", "--where", "priority"]);
    assert_eq!(out.status.code(), Some(0), "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(answer(&out), narrowed, "the worker's answer, as it came");
    let sent = &worker.heads()[1];
    assert!(sent.starts_with("get /api/agent/tree?dir=library&where=status%3adoing&where=priority "), "{}", sent);

    let old = doklin(&home, &["ls", "Library", "--where", "status=Doing"]);
    assert_eq!(old.status.code(), Some(7), "a listing that says nothing of the filter is from before tags");
    assert!(refusal(&old)["error"].as_str().unwrap().contains("is too old for this command"));

    let only = doklin(&home, &["search", "--where", "status"]);
    assert_eq!(only.status.code(), Some(0), "{}", String::from_utf8_lossy(&only.stderr));
    assert!(worker.heads()[3].starts_with("get /api/agent/search?q=&where=status "), "{}", worker.heads()[3]);
    assert_eq!(doklin(&home, &["search", "--where", "status"]).status.code(), Some(7));

    // Refused before anything is sent.
    for bad in [&["ls", "--where", "status="][..], &["ls", "--where", "=Doing"], &["search"]] {
        assert_eq!(doklin(&home, bad).status.code(), Some(2), "{:?}", bad);
    }
    assert_eq!(worker.heads().len(), 5);
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn tag_sends_each_value_or_a_removal_and_tags_asks_for_the_list() {
    let list = json!({ "tags": [{ "name": "status", "values": ["Todo", "Done"], "desc": "Where it stands." }] });
    let set = json!({ "path": "Library/a", "version": "md", "rev": 3, "tags": [{ "name": "status", "value": "Done", "known": true }] });
    let (home, worker) = logged_in(
        "set",
        vec![
            (200, "", list.to_string()),
            (200, "", set.to_string()),
            (200, "", json!({ "path": "Library/a", "version": "md", "rev": 4, "tags": [], "written": false }).to_string()),
            (404, "", json!({ "error": "not found" }).to_string()),
        ],
    );

    let out = doklin(&home, &["tags"]);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(answer(&out), list);
    assert!(worker.heads()[1].starts_with("get /api/agent/tags "));

    let out = doklin(&home, &["tag", "Library/a", "status=Done", "Due date = Monday", "priority="]);
    assert_eq!(out.status.code(), Some(0), "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(answer(&out), set);
    assert!(worker.heads()[2].starts_with("post /api/agent/tag "));
    let body: Value = serde_json::from_str(&worker.bodies()[2]).unwrap();
    assert_eq!(
        body,
        json!({ "path": "Library/a", "set": { "status": "Done", "Due date": "Monday", "priority": null }, "dryRun": false })
    );

    assert_eq!(doklin(&home, &["tag", "Library/a", "status=", "--dry-run"]).status.code(), Some(0));
    let body: Value = serde_json::from_str(&worker.bodies()[3]).unwrap();
    assert_eq!(body, json!({ "path": "Library/a", "set": { "status": null }, "dryRun": true }));

    // Refused before anything is sent: no tags, or a word that is no tag and value.
    for bad in [&["tag", "Library/a"][..], &["tag", "Library/a", "status"], &["tag", "Library/a", "=Done"], &["tag"]] {
        let out = doklin(&home, bad);
        assert_eq!(out.status.code(), Some(2), "{:?}", bad);
    }
    assert_eq!(worker.heads().len(), 4);

    // A worker from before tags has no such route.
    let old = doklin(&home, &["tags"]);
    assert_eq!(old.status.code(), Some(7));
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn tags_add_sends_the_tag_and_its_values_and_a_worker_from_before_it_is_exit_7() {
    let added = json!({ "tag": { "name": "status", "values": ["Todo", "Done", "Blocked"] }, "added": ["Blocked"] });
    let made = json!({ "tag": { "name": "Due date", "values": ["This week"] }, "added": ["This week"], "created": true, "written": false });
    let (home, worker) = logged_in(
        "add",
        vec![
            (200, "", added.to_string()),
            (200, "", made.to_string()),
            (405, "", json!({ "error": "method not allowed" }).to_string()),
        ],
    );

    let out = doklin(&home, &["tags", "add", "status", "Blocked"]);
    assert_eq!(out.status.code(), Some(0), "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(answer(&out), added);
    assert!(worker.heads()[1].starts_with("post /api/agent/tags "), "{}", worker.heads()[1]);
    let body: Value = serde_json::from_str(&worker.bodies()[1]).unwrap();
    assert_eq!(body, json!({ "name": "status", "values": ["Blocked"], "dryRun": false }));

    assert_eq!(doklin(&home, &["tags", "add", "Due date", "This week", "--dry-run"]).status.code(), Some(0));
    let body: Value = serde_json::from_str(&worker.bodies()[2]).unwrap();
    assert_eq!(body, json!({ "name": "Due date", "values": ["This week"], "dryRun": true }));

    // Refused before anything is sent: no tag, no value, or no such thing to do.
    for bad in [&["tags", "add"][..], &["tags", "add", "status"], &["tags", "rename", "status"]] {
        assert_eq!(doklin(&home, bad).status.code(), Some(2), "{:?}", bad);
    }
    assert_eq!(worker.heads().len(), 3);

    let old = doklin(&home, &["tags", "add", "status", "Blocked"]);
    assert_eq!(old.status.code(), Some(7), "a worker whose list was a document");
    let _ = std::fs::remove_dir_all(&home);
}
