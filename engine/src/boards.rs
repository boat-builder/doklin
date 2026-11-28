//! A folder's `boards.json`: how the apps show the folder as a board — by
//! which tag, and in what order its cards sit. The apps read and write it
//! (src/boards.ts); agents never see it. The engine syncs it like any file
//! and merges it by its records rather than its lines.
//!
//! A line merge's conflict copy, `boards (conflict …).json`, is no name that
//! syncs. So the file is merged as the browser merges one (`mergeBoards`,
//! src/web/merge.ts): its records are `tag`, each key a newer app wrote and
//! each card, three ways as a sidecar's are (`merge_keyed`), and nothing is
//! ever a conflict. When either side is no board this app reads, theirs is
//! kept as it is: the app never rewrites a file it can't read. Change both;
//! `verify-harness/boards-fixture.json` (`canonical`, `merge`) holds the two
//! to one answer.
//!
//! The bytes are the app's own (`serializeBoards`): the same board is always
//! the same file, so a merge the engine writes and one a browser writes are
//! the same file.

use std::collections::{BTreeMap, HashSet};

use serde_json::Value;

use crate::sidecar::{js_number, js_string, merge_keyed};

/// The file a board folder holds, named this in any case.
const BOARDS_FILE: &str = "boards.json";
/// The one version of the file this app reads and writes.
const BOARDS_V: f64 = 1.0;

/// Whether `rel` is a folder's `boards.json`.
pub fn is_boards(rel: &str) -> bool {
    rel.rsplit('/').next().unwrap_or(rel).eq_ignore_ascii_case(BOARDS_FILE)
}

/* ---------- The file ---------- */

/// A card's record: its rank, and the keys a newer app wrote.
#[derive(Clone, Debug, Default, PartialEq)]
struct Card {
    rank: Option<String>,
    extra: BTreeMap<String, Value>,
}

/// What a `boards.json` holds: the tag it is grouped by, the cards by their
/// file names, and the keys a newer app wrote.
#[derive(Clone, Debug, Default, PartialEq)]
struct Board {
    tag: String,
    cards: BTreeMap<String, Card>,
    extra: BTreeMap<String, Value>,
}

/// A board this app reads (`parseBoards`), or None: not JSON, no header, or
/// a `v` other than 1. `v` is a number, so 1.0 is 1. Lenient inside a board:
/// a `tag` that isn't text reads as none, a card that isn't a record is
/// skipped, a rank that isn't text reads as none, and of two keys for one
/// card in different cases the first in code-point order is kept.
fn parse(text: &str) -> Option<Board> {
    let Ok(Value::Object(top)) = serde_json::from_str::<Value>(text) else { return None };
    if top.get("doklin").and_then(Value::as_str) != Some("boards") || top.get("v").and_then(Value::as_f64) != Some(BOARDS_V) {
        return None;
    }
    let mut board = Board { tag: top.get("tag").and_then(Value::as_str).unwrap_or("").to_string(), ..Board::default() };
    for (key, value) in &top {
        if !matches!(key.as_str(), "doklin" | "v" | "tag" | "cards") {
            board.extra.insert(key.clone(), value.clone());
        }
    }
    if let Some(Value::Object(cards)) = top.get("cards") {
        let mut names: Vec<&String> = cards.keys().collect();
        names.sort();
        let mut seen: HashSet<String> = HashSet::new();
        for name in names {
            let Value::Object(record) = &cards[name] else { continue };
            if name.is_empty() || !seen.insert(name.to_lowercase()) {
                continue;
            }
            let card = Card {
                rank: record.get("rank").and_then(Value::as_str).map(str::to_string),
                extra: record.iter().filter(|(k, _)| *k != "rank").map(|(k, v)| (k.clone(), v.clone())).collect(),
            };
            board.cards.insert(name.clone(), card);
        }
    }
    Some(board)
}

/// A value as one line of canonical JSON (`canonicalJson`): an object's keys
/// in code-point order, numbers and strings as JavaScript writes them,
/// nothing between tokens.
fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.as_f64().map(js_number).unwrap_or_else(|| "null".to_string()),
        Value::String(s) => js_string(s),
        Value::Array(items) => format!("[{}]", items.iter().map(canonical_json).collect::<Vec<_>>().join(",")),
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys.into_iter().map(|k| format!("{}:{}", js_string(k), canonical_json(&map[k]))).collect();
            format!("{{{}}}", parts.join(","))
        }
    }
}

/// A card's record as its line holds it: `rank`, then the other keys in
/// code-point order.
fn card_json(card: &Card) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(rank) = &card.rank {
        parts.push(format!("\"rank\": {}", js_string(rank)));
    }
    parts.extend(card.extra.iter().map(|(k, v)| format!("{}: {}", js_string(k), canonical_json(v))));
    format!("{{ {} }}", parts.join(", "))
}

/// The file's bytes (`serializeBoards`): the header, `tag`, `cards` (one per
/// line, in code-point order of their names), then the keys a newer app
/// wrote, in code-point order; two-space indent and a final newline. A card
/// with nothing in its record is left out.
fn serialize(board: &Board) -> String {
    let mut lines = vec!["  \"doklin\": \"boards\"".to_string(), "  \"v\": 1".to_string(), format!("  \"tag\": {}", js_string(&board.tag))];
    let cards: Vec<String> = board
        .cards
        .iter()
        .filter(|(_, card)| card.rank.is_some() || !card.extra.is_empty())
        .map(|(name, card)| format!("    {}: {}", js_string(name), card_json(card)))
        .collect();
    lines.push(if cards.is_empty() { "  \"cards\": {}".to_string() } else { format!("  \"cards\": {{\n{}\n  }}", cards.join(",\n")) });
    lines.extend(board.extra.iter().map(|(k, v)| format!("  {}: {}", js_string(k), canonical_json(v))));
    format!("{{\n{}\n}}\n", lines.join(",\n"))
}

/* ---------- The merge ---------- */

/// What a record is of the board.
#[derive(Clone, Debug)]
enum Part {
    Tag(String),
    Extra(String, Value),
    Card(String, Card),
}

/// One of a board's records, keyed as the browser keys it (`tag`,
/// `extra:<key>`, `card:<name whatever its case>`). Two compare by `text`,
/// the record as canonical JSON, as the browser's do.
#[derive(Clone, Debug)]
struct Record {
    key: String,
    text: String,
    part: Part,
}

impl PartialEq for Record {
    fn eq(&self, other: &Record) -> bool {
        self.key == other.key && self.text == other.text
    }
}

fn records(board: &Board) -> Vec<Record> {
    let mut out = vec![Record { key: "tag".to_string(), text: js_string(&board.tag), part: Part::Tag(board.tag.clone()) }];
    for (k, v) in &board.extra {
        out.push(Record {
            key: format!("extra:{k}"),
            text: format!("[{},{}]", js_string(k), canonical_json(v)),
            part: Part::Extra(k.clone(), v.clone()),
        });
    }
    for (name, card) in &board.cards {
        let rank = card.rank.as_deref().map(js_string).unwrap_or_else(|| "null".to_string());
        let extra = canonical_json(&Value::Object(card.extra.clone().into_iter().collect()));
        out.push(Record {
            key: format!("card:{}", name.to_lowercase()),
            text: format!("[{},{rank},{extra}]", js_string(name)),
            part: Part::Card(name.clone(), card.clone()),
        });
    }
    out
}

fn from_records(records: Vec<Record>) -> Board {
    let mut board = Board::default();
    for record in records {
        match record.part {
            Part::Tag(tag) => board.tag = tag,
            Part::Extra(k, v) => {
                board.extra.insert(k, v);
            }
            Part::Card(name, card) => {
                board.cards.insert(name, card);
            }
        }
    }
    board
}

/// Two versions of a folder's `boards.json` in one, against the one both
/// started from (None: there was none; one that is no board counts as an
/// empty board). By its records: one changed on one side is that side's, one
/// changed on both is this side's, and a deletion sticks unless the other
/// side changed what was deleted. Never a conflict. When either side is no
/// board this app reads, the answer is theirs, as it is.
pub fn merge(base: Option<&str>, ours: &str, theirs: &str) -> String {
    if ours == theirs {
        return ours.to_string();
    }
    let (Some(o), Some(t)) = (parse(ours), parse(theirs)) else { return theirs.to_string() };
    let b = base.and_then(parse).unwrap_or_default();
    serialize(&from_records(merge_keyed(&records(&b), &records(&o), &records(&t), |r| r.key.as_str())))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../verify-harness/boards-fixture.json");

    fn fixture() -> Value {
        serde_json::from_str(FIXTURE).expect("the fixture is JSON")
    }

    fn text(v: &Value) -> &str {
        v.as_str().expect("a string")
    }

    #[test]
    fn a_board_is_written_as_the_apps_write_it() {
        let cases = fixture()["canonical"].as_array().cloned().expect("canonical cases");
        assert!(!cases.is_empty());
        for case in cases {
            let got = parse(text(&case["text"])).map(|board| serialize(&board));
            assert_eq!(got.as_deref(), case["out"].as_str(), "canonical {:?}", text(&case["text"]));
            if let Some(out) = case["out"].as_str() {
                assert_eq!(parse(out).map(|board| serialize(&board)).as_deref(), Some(out), "its bytes read back to themselves");
            }
        }
    }

    #[test]
    fn a_board_merges_as_the_browser_merges_one() {
        let cases = fixture()["merge"].as_array().cloned().expect("merge cases");
        assert!(!cases.is_empty());
        for case in cases {
            let (base, ours, theirs) = (case["base"].as_str(), text(&case["ours"]), text(&case["theirs"]));
            assert_eq!(merge(base, ours, theirs), text(&case["out"]), "{}", text(&case["name"]));
        }
    }

    /// `v` is a number: 1.0 is this app's, 1.5 and "1" are no board, and an
    /// integer past 1 is a newer app's, which this app doesn't read either.
    #[test]
    fn only_a_v_of_one_is_a_board_this_app_reads() {
        assert!(parse(r#"{"doklin":"boards","v":1.0,"tag":"Status"}"#).is_some());
        for no in [
            r#"{"doklin":"boards","v":1.5}"#,
            r#"{"doklin":"boards","v":"1"}"#,
            r#"{"doklin":"boards","v":2,"tag":"Status"}"#,
            r#"{"doklin":"boards","v":0}"#,
            r#"{"doklin":"boards"}"#,
            r#"{"doklin":"meta","v":1}"#,
            r#"[]"#,
            "not json",
        ] {
            assert_eq!(parse(no), None, "{no}");
        }
    }

    #[test]
    fn numbers_a_newer_app_wrote_are_kept_as_javascript_writes_them() {
        let board = r#"{"doklin":"boards","v":1,"tag":"S","zoom":1.0,"big":1e21,"small":0.0000001,"n":-0,"cards":{"a.md":{"w":12345678901234567890,"at":[0.1,1.5e-7]}}}"#;
        let want = "{\n  \"doklin\": \"boards\",\n  \"v\": 1,\n  \"tag\": \"S\",\n  \"cards\": {\n    \"a.md\": { \"at\": [0.1,1.5e-7], \"w\": 12345678901234567000 }\n  },\n  \"big\": 1e+21,\n  \"n\": 0,\n  \"small\": 1e-7,\n  \"zoom\": 1\n}\n";
        assert_eq!(serialize(&parse(board).expect("a board")), want);
    }

    #[test]
    fn a_boards_file_is_named_boards_json_in_any_case() {
        for yes in ["boards.json", "Work/boards.json", "A/B/BOARDS.JSON", "Boards.Json"] {
            assert!(is_boards(yes), "{yes}");
        }
        for no in ["boards.md", "Work/boards.json.md", "my boards.json", "boards.jsonl", "boards", "Work/boards.json/x.md"] {
            assert!(!is_boards(no), "{no}");
        }
    }
}
