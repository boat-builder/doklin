//! A document's sidecar, `<stem>.meta.jsonl`: what the document owns that
//! isn't its prose (comment-thread bodies, table widths, and records a newer
//! app writes). The app writes it (src/metaFile.ts); the engine only merges
//! it, and does so by its records rather than its lines.
//!
//! A line merge of a sorted list of records calls two records added next to
//! each other an overlap, and the conflict copy it would make,
//! `x.meta (conflict …).jsonl`, is no name that syncs: its records would be
//! lost for everyone. So a sidecar is merged as the browser merges one
//! (`mergeMeta`, src/web/merge.ts): a thread's replies on either side are
//! kept, a deletion sticks, and nothing is ever a conflict. Change both;
//! `verify-harness/comments-fixture.json` (`mergeMeta`) holds the two to one
//! answer.
//!
//! The bytes are the app's own: records sorted by type and id, each with a
//! fixed key order (`serializeEntityMeta`), so a merge the engine writes and
//! one a browser writes are the same file.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

const HEADER: &str = r#"{"doklin":"meta","v":1}"#;

/// Whether `rel` is a sidecar.
pub fn is_sidecar(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel).to_ascii_lowercase();
    name.len() > ".meta.jsonl".len() && name.ends_with(".meta.jsonl")
}

/// The sidecar of the document at `rel`: its path without a markdown
/// extension, then without `.html`, and `.meta.jsonl` (`metaFileOf`,
/// src/metaFile.ts).
pub fn sidecar_of(rel: &str) -> String {
    let lower = rel.to_ascii_lowercase();
    let mut stem = rel;
    for ext in [".markdown", ".mdown", ".mkd", ".md"] {
        if lower.ends_with(ext) {
            stem = &rel[..rel.len() - ext.len()];
            break;
        }
    }
    if stem.to_ascii_lowercase().ends_with(".html") {
        stem = &stem[..stem.len() - ".html".len()];
    }
    format!("{stem}.meta.jsonl")
}

/* ---------- Records ---------- */

/// An entry of a thread. `at` is the number as JavaScript writes it, which
/// is how two of them compare too.
#[derive(Clone, Debug, PartialEq)]
struct Entry {
    author: String,
    at: String,
    body: String,
}

#[derive(Clone, Debug, PartialEq)]
struct Anchor {
    path: String,
    tag: String,
    text: String,
}

/// A thread: an html one has an anchor, a markdown one's is in its text.
#[derive(Clone, Debug, PartialEq)]
struct Thread {
    id: String,
    anchor: Option<Anchor>,
    comments: Vec<Entry>,
}

#[derive(Clone, Debug, PartialEq)]
struct Cols {
    id: String,
    cols: Vec<String>,
}

/// A record this engine doesn't know, carried as it was written.
#[derive(Clone, Debug, PartialEq)]
struct Foreign {
    t: String,
    id: String,
    raw: String,
}

#[derive(Default, Debug)]
struct Meta {
    hthreads: Vec<Thread>,
    mthreads: Vec<Thread>,
    tcols: Vec<Cols>,
    foreign: Vec<Foreign>,
}

/// A number as JavaScript writes one (`Number.prototype.toString`): the
/// shortest digits that read back as it, plainly from 1e-6 to 1e21 and with
/// an exponent outside that.
fn js_number(f: f64) -> String {
    if f == 0.0 {
        return "0".to_string();
    }
    let sign = if f < 0.0 { "-" } else { "" };
    let sci = format!("{:e}", f.abs());
    let (mantissa, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let k = digits.len() as i32;
    let n = exp.parse::<i32>().unwrap_or(0) + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let e = if e < 0 { format!("-{}", -e) } else { format!("+{e}") };
        if k == 1 { format!("{digits}e{e}") } else { format!("{}.{}e{e}", &digits[..1], &digits[1..]) }
    };
    format!("{sign}{body}")
}

/// A string as JSON writes it: escaped as JavaScript escapes it.
fn js_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_default()
}

fn entries(value: Option<&Value>) -> Option<Vec<Entry>> {
    value?
        .as_array()?
        .iter()
        .map(|e| {
            Some(Entry {
                author: e.get("author")?.as_str()?.to_string(),
                at: js_number(e.get("at")?.as_f64()?),
                body: e.get("body")?.as_str()?.to_string(),
            })
        })
        .collect()
}

fn anchor(value: Option<&Value>) -> Option<Anchor> {
    let a = value?;
    Some(Anchor {
        path: a.get("path")?.as_str()?.to_string(),
        tag: a.get("tag")?.as_str()?.to_string(),
        text: a.get("text")?.as_str()?.to_string(),
    })
}

/// Column widths: finite, not negative, at least one; rounded as the app
/// rounds them.
fn cols(value: Option<&Value>) -> Option<Vec<String>> {
    let list = value?.as_array()?;
    if list.is_empty() {
        return None;
    }
    list.iter()
        .map(|n| n.as_f64().filter(|f| f.is_finite() && *f >= 0.0).map(|f| js_number((f + 0.5).floor())))
        .collect()
}

/// The app's tolerant parse (`parseEntityMeta`): the header and any line
/// that isn't a record are skipped, and of two records of one type and id
/// the first is kept.
fn parse(raw: &str) -> Meta {
    let mut meta = Meta::default();
    let mut seen: HashSet<String> = HashSet::new();
    for line in raw.split('\n') {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Half a character (a lone surrogate) is JSON to JavaScript and not
        // to serde: such a record is kept exactly as it was written.
        let (parsed, verbatim) = match serde_json::from_str::<Value>(trimmed) {
            Ok(v) => (v, false),
            Err(_) => match serde_json::from_str::<Value>(&without_surrogates(trimmed)) {
                Ok(v) => (v, true),
                Err(_) => continue,
            },
        };
        let Value::Object(r) = parsed else { continue };
        if r.get("doklin").is_some_and(Value::is_string) {
            continue;
        }
        let Some(t) = r.get("t").and_then(Value::as_str).filter(|t| !t.is_empty()) else { continue };
        let id = r.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let key = format!("{t} {id}");
        if seen.contains(&key) {
            continue;
        }
        if verbatim {
            meta.foreign.push(Foreign { t: t.to_string(), id, raw: trimmed.to_string() });
            seen.insert(key);
            continue;
        }
        match t {
            "mthread" => {
                let Some(comments) = entries(r.get("comments")).filter(|_| !id.is_empty()) else { continue };
                meta.mthreads.push(Thread { id, anchor: None, comments });
            }
            "hthread" => {
                let (Some(at), Some(comments)) = (anchor(r.get("anchor")), entries(r.get("comments"))) else { continue };
                if id.is_empty() {
                    continue;
                }
                meta.hthreads.push(Thread { id, anchor: Some(at), comments });
            }
            "tcols" => {
                let Some(cols) = cols(r.get("cols")).filter(|_| !id.is_empty()) else { continue };
                meta.tcols.push(Cols { id, cols });
            }
            _ => meta.foreign.push(Foreign { t: t.to_string(), id, raw: trimmed.to_string() }),
        }
        seen.insert(key);
    }
    meta
}

/// `text` with each `\\uXXXX` escape of a surrogate made U+FFFD's.
fn without_surrogates(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("\\u") {
        let (before, after) = rest.split_at(at);
        out.push_str(before);
        let end = 6.min(after.len());
        let surrogate = after.get(2..6).and_then(|hex| u16::from_str_radix(hex, 16).ok()).is_some_and(|n| (0xd800..0xe000).contains(&n));
        out.push_str(if surrogate { "\\ufffd" } else { &after[..end] });
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

fn comments_json(comments: &[Entry]) -> String {
    let each: Vec<String> = comments
        .iter()
        .map(|e| format!(r#"{{"author":{},"at":{},"body":{}}}"#, js_string(&e.author), e.at, js_string(&e.body)))
        .collect();
    format!("[{}]", each.join(","))
}

/// The app's bytes for `meta` (`serializeEntityMeta`): its key order, its
/// escapes, its numbers.
fn serialize(meta: &Meta) -> String {
    let mut rows: Vec<(String, String)> = Vec::new();
    for t in &meta.hthreads {
        let none = Anchor { path: String::new(), tag: String::new(), text: String::new() };
        let a = t.anchor.as_ref().unwrap_or(&none);
        let anchor = format!(r#"{{"path":{},"tag":{},"text":{}}}"#, js_string(&a.path), js_string(&a.tag), js_string(&a.text));
        let line = format!(r#"{{"t":"hthread","id":{},"anchor":{anchor},"comments":{}}}"#, js_string(&t.id), comments_json(&t.comments));
        rows.push((format!("hthread {}", t.id), line));
    }
    for t in &meta.mthreads {
        let line = format!(r#"{{"t":"mthread","id":{},"comments":{}}}"#, js_string(&t.id), comments_json(&t.comments));
        rows.push((format!("mthread {}", t.id), line));
    }
    for c in &meta.tcols {
        let line = format!(r#"{{"t":"tcols","id":{},"cols":[{}]}}"#, js_string(&c.id), c.cols.join(","));
        rows.push((format!("tcols {}", c.id), line));
    }
    for f in &meta.foreign {
        rows.push((format!("{} {} {}", f.t, f.id, f.raw), f.raw.clone()));
    }
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    let mut out = String::from(HEADER);
    for (_, line) in rows {
        out.push('\n');
        out.push_str(&line);
    }
    out.push('\n');
    out
}

/* ---------- The merge ---------- */

fn same_entry(a: &Entry, b: &Entry) -> bool {
    a.author == b.author && a.at == b.at
}

/// One thread's entries, three ways (`mergeEntries`, src/htmlComments.ts):
/// an entry is known by who wrote it and when; its body follows whichever
/// side changed it, this one when both did; a deletion sticks.
fn merge_entries(base: &[Entry], mine: &[Entry], theirs: &[Entry]) -> Vec<Entry> {
    let mut out = Vec::new();
    for e in mine {
        let b = base.iter().find(|b| same_entry(b, e));
        match theirs.iter().find(|t| same_entry(t, e)) {
            Some(t) => {
                let body = if b.is_some_and(|b| b.body == e.body) { t.body.clone() } else { e.body.clone() };
                out.push(Entry { body, ..t.clone() });
            }
            None if b.is_none() => out.push(e.clone()),
            None => {}
        }
    }
    for e in theirs {
        if !mine.iter().any(|m| same_entry(m, e)) && !base.iter().any(|b| same_entry(b, e)) {
            out.push(e.clone());
        }
    }
    out
}

/// Threads, three ways (`mergeHtmlThreads`): one on both sides merges its
/// entries, and goes when none are left; one new on a side is kept; one
/// deleted on a side stays deleted.
fn merge_threads(base: &[Thread], mine: &[Thread], theirs: &[Thread]) -> Vec<Thread> {
    let base_by: HashMap<&str, &Thread> = base.iter().map(|t| (t.id.as_str(), t)).collect();
    let mine_ids: HashSet<&str> = mine.iter().map(|t| t.id.as_str()).collect();
    let theirs_by: HashMap<&str, &Thread> = theirs.iter().map(|t| (t.id.as_str(), t)).collect();
    let mut out = Vec::new();
    for t in mine {
        let b = base_by.get(t.id.as_str());
        match theirs_by.get(t.id.as_str()) {
            Some(other) => {
                let comments = merge_entries(b.map(|b| b.comments.as_slice()).unwrap_or(&[]), &t.comments, &other.comments);
                if !comments.is_empty() {
                    let anchor = if b.is_some_and(|b| b.anchor == t.anchor) { other.anchor.clone() } else { t.anchor.clone() };
                    out.push(Thread { id: t.id.clone(), anchor, comments });
                }
            }
            None if b.is_none() => out.push(t.clone()),
            None => {}
        }
    }
    for t in theirs {
        if !mine_ids.contains(t.id.as_str()) && !base_by.contains_key(t.id.as_str()) {
            out.push(t.clone());
        }
    }
    out
}

/// Whole records, three ways (`mergeKeyed`): one changed on one side is that
/// side's, one changed on both is this side's, and a deletion sticks unless
/// the other side changed what was deleted.
fn merge_keyed<T: Clone + PartialEq>(base: &[T], ours: &[T], theirs: &[T], key: impl Fn(&T) -> &str) -> Vec<T> {
    let was: HashMap<&str, &T> = base.iter().map(|t| (key(t), t)).collect();
    let mine: HashSet<&str> = ours.iter().map(&key).collect();
    let other: HashMap<&str, &T> = theirs.iter().map(|t| (key(t), t)).collect();
    let mut out = Vec::new();
    for t in ours {
        let b = was.get(key(t));
        match other.get(key(t)) {
            Some(o) => out.push(if b.is_some_and(|b| *b == t) { (*o).clone() } else { t.clone() }),
            None if b.is_none_or(|b| *b != t) => out.push(t.clone()),
            None => {}
        }
    }
    for t in theirs {
        let b = was.get(key(t));
        if !mine.contains(key(t)) && b.is_none_or(|b| *b != t) {
            out.push(t.clone());
        }
    }
    out
}

/// Two versions of a sidecar in one, against the one both started from
/// (None: it had none). Never fails: a sidecar never gets a conflict copy.
pub fn merge(base: Option<&str>, ours: &str, theirs: &str) -> String {
    if ours == theirs {
        return ours.to_string();
    }
    let b = parse(base.unwrap_or(""));
    let o = parse(ours);
    let t = parse(theirs);
    serialize(&Meta {
        hthreads: merge_threads(&b.hthreads, &o.hthreads, &t.hthreads),
        mthreads: merge_threads(&b.mthreads, &o.mthreads, &t.mthreads),
        tcols: merge_keyed(&b.tcols, &o.tcols, &t.tcols, |c| c.id.as_str()),
        foreign: merge_keyed(&b.foreign, &o.foreign, &t.foreign, |f| f.raw.as_str()),
    })
}

/// The sidecar there now (`current`; None: there is none) with every record
/// of `other` it doesn't have. A record both have is kept as it is now. A
/// version restore puts a note's old text back beside this: the old text
/// finds every record it uses, and nothing the sidecar holds now is lost.
pub fn with_records_of(current: Option<&str>, other: &str) -> String {
    let mut now = parse(current.unwrap_or(""));
    let then = parse(other);
    fn add<T: Clone>(mine: &mut Vec<T>, theirs: &[T], key: impl Fn(&T) -> String) {
        let have: HashSet<String> = mine.iter().map(&key).collect();
        mine.extend(theirs.iter().filter(|t| !have.contains(&key(t))).cloned());
    }
    add(&mut now.hthreads, &then.hthreads, |t| t.id.clone());
    add(&mut now.mthreads, &then.mthreads, |t| t.id.clone());
    add(&mut now.tcols, &then.tcols, |c| c.id.clone());
    add(&mut now.foreign, &then.foreign, |f| format!("{} {}", f.t, f.id));
    serialize(&now)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../verify-harness/comments-fixture.json");

    /// The fixture as serde reads it: each surrogate escape made U+FFFD's.
    fn fixture() -> Value {
        serde_json::from_str(&without_surrogates(FIXTURE)).expect("the fixture is JSON")
    }

    fn text(v: &Value) -> &str {
        v.as_str().expect("a string")
    }

    #[test]
    fn parse_and_serialize_write_the_apps_bytes() {
        for case in fixture()["meta"].as_array().unwrap() {
            let about = text(&case["about"]);
            if text(&case["raw"]).contains("\\ufffd") {
                continue; // half a character: kept as written (the next test)
            }
            assert_eq!(serialize(&parse(text(&case["raw"]))), text(&case["serialized"]), "{about}");
            assert_eq!(serialize(&parse(text(&case["serialized"]))), text(&case["serialized"]), "again: {about}");
        }
    }

    #[test]
    fn merges_as_the_browser_merges() {
        let cases = fixture()["mergeMeta"].as_array().cloned().expect("mergeMeta cases");
        assert!(!cases.is_empty());
        for case in cases {
            let base = case["base"].as_str();
            let out = merge(base, text(&case["ours"]), text(&case["theirs"]));
            assert_eq!(out, text(&case["out"]), "{}", text(&case["about"]));
        }
    }

    #[test]
    fn a_record_with_half_a_character_is_kept_as_it_was_written() {
        let odd = r#"{"t":"mthread","id":"m1","comments":[{"author":"A","at":1,"body":"half \ud83d"}]}"#;
        let ours = format!("{HEADER}\n{odd}\n");
        let theirs = format!("{HEADER}\n{}\n", r#"{"t":"mthread","id":"m2","comments":[{"author":"B","at":2,"body":"x"}]}"#);
        let merged = merge(Some(&format!("{HEADER}\n")), &ours, &theirs);
        assert!(merged.contains(odd), "{merged}");
        assert!(merged.contains(r#""id":"m2""#), "{merged}");
    }

    #[test]
    fn a_restore_adds_the_records_it_needs_and_keeps_the_rest() {
        let mt = |id: &str, body: &str| format!(r#"{{"t":"mthread","id":"{id}","comments":[{{"author":"A","at":1,"body":"{body}"}}]}}"#);
        let now = format!("{HEADER}\n{}\n{}\n", mt("a1", "now"), mt("b2", "only now"));
        let then = format!("{HEADER}\n{}\n{}\n", mt("a1", "then"), mt("c3", "only then"));
        let out = with_records_of(Some(&now), &then);
        assert_eq!(out, format!("{HEADER}\n{}\n{}\n{}\n", mt("a1", "now"), mt("b2", "only now"), mt("c3", "only then")));
        assert_eq!(with_records_of(None, &then), then);
    }

    #[test]
    fn a_sidecar_is_named_as_the_app_names_it() {
        for case in fixture()["metaFile"].as_array().unwrap() {
            assert_eq!(sidecar_of(text(&case["path"])), text(&case["meta"]));
        }
        assert!(is_sidecar("Notes/plan.meta.jsonl") && is_sidecar("PLAN.META.JSONL"));
        assert!(!is_sidecar(".meta.jsonl") && !is_sidecar("plan.md") && !is_sidecar("plan.jsonl"));
    }
}
