//! Sections, a page at a time, end to end: a listing, a search, the linkers
//! of a document and the public pages each read as many sections as one
//! request opens and answer `next` when there are more — everything shared
//! is a section of its own. The command asks again from there, and what it
//! prints is one answer with no cursor in it.

mod common;

use common::{doklin, home, login_answer_with, refusal, Fake};
use serde_json::{json, Value};

fn logged_in(name: &str, script: Vec<(u16, &'static str, String)>) -> (std::path::PathBuf, Fake) {
    let home = home(&format!("paging-{}", name));
    let mut all = vec![(201, "", login_answer_with(5000, &["read", "edit"]))];
    all.extend(script);
    let worker = Fake::serve(all);
    let login = doklin(&home, &["login", &worker.endpoint, "dkla-TEST"]);
    assert_eq!(login.status.code(), Some(0), "{}", String::from_utf8_lossy(&login.stderr));
    (home, worker)
}

fn answer(out: &std::process::Output) -> Value {
    assert_eq!(out.status.code(), Some(0), "{}", String::from_utf8_lossy(&out.stderr));
    serde_json::from_slice(&out.stdout).unwrap_or_else(|_| panic!("not JSON: {}", String::from_utf8_lossy(&out.stdout)))
}

/// The request line of each request the worker was sent after the login.
fn asked(worker: &Fake) -> Vec<String> {
    worker.heads()[1..].iter().map(|head| head.lines().next().unwrap_or("").trim_end_matches(" http/1.1").to_string()).collect()
}

#[test]
fn a_deep_listing_follows_the_cursor_and_a_shared_document_is_a_row_of_its_own() {
    let shallow = json!({
        "dir": "My files/plans",
        "folders": [],
        "documents": [{ "path": "My files/plans/budget", "md": { "rev": 1 } }, { "path": "My files/plans/Forecast", "shared": true }]
    });
    let (home, worker) = logged_in(
        "ls",
        vec![
            (200, "", shallow.to_string()),
            (200, "", json!({ "dir": "", "folders": ["Library", "My files"], "documents": [{ "path": "My files/plans/Forecast", "md": { "rev": 3 } }], "next": 9 }).to_string()),
            (200, "", json!({ "dir": "", "folders": ["Library", "My files"], "documents": [{ "path": "Library/Home", "md": { "rev": 1 } }] }).to_string()),
        ],
    );

    let out = doklin(&home, &["ls", "My files/plans"]);
    assert_eq!(answer(&out), shallow, "not deep, nothing shared is opened: the worker's answer as it came");

    let deep = answer(&doklin(&home, &["ls", "--deep"]));
    assert_eq!(
        deep,
        json!({
            "dir": "",
            "folders": ["Library", "My files"],
            "documents": [{ "path": "Library/Home", "md": { "rev": 1 } }, { "path": "My files/plans/Forecast", "md": { "rev": 3 } }]
        })
    );
    assert_eq!(asked(&worker), ["get /api/agent/tree?dir=my%20files%2fplans", "get /api/agent/tree?dir=&deep=1", "get /api/agent/tree?dir=&deep=1&after=9"]);
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn a_search_waits_for_the_index_on_any_page_and_adds_the_pages_up() {
    let hit = |path: &str| json!({ "path": path, "version": "md", "matches": [{ "line": 1, "text": "The regatta." }] });
    let (home, worker) = logged_in(
        "search",
        vec![
            (200, "", json!({ "query": "regatta", "dir": "", "results": [hit("My files/plans/Forecast")], "total": 1, "next": 9 }).to_string()),
            (202, "", json!({ "indexing": true, "pending": 3 }).to_string()),
            (200, "", json!({ "query": "regatta", "dir": "", "results": [hit("Library/Regatta")], "total": 4, "truncated": true }).to_string()),
        ],
    );
    let found = answer(&doklin(&home, &["search", "regatta", "--limit", "1"]));
    assert_eq!(
        found,
        json!({ "query": "regatta", "dir": "", "results": [hit("Library/Regatta"), hit("My files/plans/Forecast")], "total": 5, "truncated": true })
    );
    assert_eq!(
        asked(&worker),
        [
            "get /api/agent/search?q=regatta&limit=1",
            "get /api/agent/search?q=regatta&limit=1&after=9",
            "get /api/agent/search?q=regatta&limit=1&after=9",
        ],
        "the page that was still being read is asked for again, from the same place"
    );
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn links_and_published_follow_it_too_and_a_cursor_that_stands_still_is_exit_1() {
    let page = |slug: &str| json!({ "slug": slug, "url": format!("http://notes.test/{}", slug), "kind": "document", "path": "Library/Home", "at": 1 });
    let (home, worker) = logged_in(
        "links",
        vec![
            (200, "", json!({ "path": "Library/a", "to": [{ "path": "Shared with me/Deals/q3" }], "next": 9 }).to_string()),
            (200, "", json!({ "path": "Library/a", "to": [{ "path": "Library/b" }] }).to_string()),
            (200, "", json!({ "pages": [page("plan")], "next": 9 }).to_string()),
            (200, "", json!({ "pages": [page("home")] }).to_string()),
            (200, "", json!({ "pages": [], "next": 9 }).to_string()),
            (200, "", json!({ "pages": [], "next": 9 }).to_string()),
        ],
    );
    let linked = answer(&doklin(&home, &["links", "Library/a", "--to"]));
    assert_eq!(linked, json!({ "path": "Library/a", "to": [{ "path": "Library/b" }, { "path": "Shared with me/Deals/q3" }] }));
    let public = answer(&doklin(&home, &["published"]));
    assert_eq!(public, json!({ "pages": [page("home"), page("plan")] }));

    let stuck = doklin(&home, &["published"]);
    assert_eq!(stuck.status.code(), Some(1));
    assert_eq!(refusal(&stuck)["error"], "the domain's answer was not what a Doklin worker sends");
    assert!(stuck.stdout.is_empty(), "half an answer is not printed");
    assert_eq!(
        asked(&worker),
        [
            "get /api/agent/links?path=library%2fa&to=1",
            "get /api/agent/links?path=library%2fa&to=1&after=9",
            "get /api/agent/pages",
            "get /api/agent/pages?after=9",
            "get /api/agent/pages",
            "get /api/agent/pages?after=9",
        ]
    );
    let _ = std::fs::remove_dir_all(&home);
}
