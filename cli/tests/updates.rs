//! A doklin older than the release the domain marks mandatory: the worker
//! answers every request `410` with a sentence saying how to update
//! (cloud-worker/src/clients.ts), and the command exits `9` with it.

mod common;

use common::{doklin, home, login_answer_with, refusal, Fake};
use serde_json::json;

const SAID: &str = "This is doklin 0.1.1, and notes.example.com needs 0.1.2 or newer. Update it: curl -fsSL https://github.com/boat-builder/doklin/releases/latest/download/install-doklin.sh | sh — or, on a Mac with the Doklin app, update the app.";

#[test]
fn a_410_is_exit_9_in_the_worker_s_words_a_login_included() {
    let home = home("too-old");
    let too_old = json!({ "error": SAID }).to_string();
    let worker = Fake::serve(vec![
        (201, "", login_answer_with(100, &["read"])),
        (410, "", too_old.clone()),
        (410, "", too_old),
    ]);

    let login = doklin(&home, &["login", &worker.endpoint, "dkla-TEST"]);
    assert_eq!(login.status.code(), Some(0), "{}", String::from_utf8_lossy(&login.stderr));
    let client = format!("x-doklin-client: cli/{}", env!("CARGO_PKG_VERSION"));
    assert!(worker.heads()[0].contains(&client), "the worker is told which doklin asks: {}", worker.heads()[0]);

    let ls = doklin(&home, &["ls"]);
    assert_eq!(ls.status.code(), Some(9));
    let said = refusal(&ls);
    assert_eq!(said["exit"], 9);
    assert_eq!(said["error"], SAID);
    assert_eq!(worker.heads().len(), 2, "asked once: there is nothing to wait for");

    let again = doklin(&home, &["login", &worker.endpoint, "dkla-TEST"]);
    assert_eq!(again.status.code(), Some(9), "a login is turned away the same way");
    assert_eq!(refusal(&again)["error"], SAID);
    let _ = std::fs::remove_dir_all(&home);
}
