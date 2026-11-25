//! A note's tags, read for the search: the unindented `key: value` lines of
//! its frontmatter block. The app's rules are `src/tags.ts`; this is the part
//! a search needs (which lines a block holds, and whether a note has the
//! tags asked for), held to the same cases in
//! verify-harness/tags-fixture.json (`lines`, `match`): change all three
//! (with the iPhone's Markdown/Tags.swift).
//!
//! The tag list is never read here. The search box splits its text into
//! words and tag tokens (`searchQuery`, src/tags.ts) and sends the tokens on
//! their own, spelled as the list spells them.

use serde::Deserialize;

/// A search's tag token: a note's tag holds `value`, or (None) the note has
/// the tag at all.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct TagFilter {
    pub name: String,
    pub value: Option<String>,
}

/// A block's line keyed `key`; `value` is None when the line isn't a pair.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct KeyedLine {
    pub key: String,
    pub value: Option<String>,
}

fn is_fence(line: &str) -> bool {
    line.trim_end_matches([' ', '\t', '\r']) == "---"
}

/// The lines inside a leading frontmatter block (`splitFrontmatter`,
/// src/frontmatter.ts): line 1 is `---` and a later line is `---`. None
/// when the note has no block.
fn block_lines(text: &str) -> Option<Vec<&str>> {
    let mut lines = text.split('\n');
    if !is_fence(lines.next()?) {
        return None;
    }
    let mut inner = Vec::new();
    // The last piece of a split has no newline after it: a closing fence
    // there still closes, but a line that isn't one leaves no block.
    for line in lines {
        if is_fence(line) {
            return Some(inner.into_iter().map(|l: &str| l.strip_suffix('\r').unwrap_or(l)).collect());
        }
        inner.push(line);
    }
    None
}

fn indented(line: &str) -> bool {
    line.starts_with(' ') || line.starts_with('\t')
}

fn blank(line: &str) -> bool {
    line.trim().is_empty()
}

/// What may follow a quoted value: nothing, or a comment.
fn trailer_ok(rest: &str) -> bool {
    rest.trim().is_empty() || {
        let after = rest.trim_start_matches([' ', '\t']);
        after.len() < rest.len() && after.starts_with('#')
    }
}

/// A double-quoted value at the start of `s` (`\"` and `\\` its only
/// escapes), with the byte where it ends.
fn double_quoted(s: &str) -> Option<(String, usize)> {
    let mut out = String::new();
    let mut chars = s.char_indices().skip(1);
    while let Some((i, c)) = chars.next() {
        match c {
            '"' => return Some((out, i + 1)),
            '\\' => match chars.next() {
                Some((_, n @ ('"' | '\\'))) => out.push(n),
                _ => return None,
            },
            _ => out.push(c),
        }
    }
    None
}

/// A single-quoted value at the start of `s` (`''` is a quote).
fn single_quoted(s: &str) -> Option<(String, usize)> {
    let mut out = String::new();
    let mut chars = s.char_indices().skip(1).peekable();
    while let Some((i, c)) = chars.next() {
        if c != '\'' {
            out.push(c);
        } else if matches!(chars.peek(), Some((_, '\''))) {
            out.push('\'');
            chars.next();
        } else {
            return Some((out, i + 1));
        }
    }
    None
}

/// One scalar, or None (`scalarOf`, src/tags.ts).
fn scalar_of(rest: &str) -> Option<String> {
    let first = rest.chars().next()?;
    if first == '"' || first == '\'' {
        let (value, end) = if first == '"' { double_quoted(rest)? } else { single_quoted(rest)? };
        return trailer_ok(&rest[end..]).then_some(value);
    }
    if "[{|>&*!%@`".contains(first) {
        return None;
    }
    // A bare value ends at a `#` that a space or a tab comes before.
    let mut cut = rest.len();
    let bytes = rest.as_bytes();
    for (i, b) in bytes.iter().enumerate() {
        if *b == b'#' && i > 0 && (bytes[i - 1] == b' ' || bytes[i - 1] == b'\t') {
            cut = i;
            break;
        }
    }
    let bare = rest[..cut].trim_end();
    (!bare.is_empty()).then(|| bare.to_string())
}

/// A line's key and the text after its colon (`keyedLine`, src/tags.ts).
fn keyed_line(line: &str) -> Option<(String, Option<String>)> {
    let first = line.chars().next()?;
    if first.is_whitespace() || first == '#' || first == '-' {
        return None;
    }
    let bytes = line.as_bytes();
    for (i, b) in bytes.iter().enumerate() {
        if *b != b':' {
            continue;
        }
        let next = bytes.get(i + 1);
        if next.is_none() || next == Some(&b' ') || next == Some(&b'\t') {
            let key = line[..i].trim_end();
            if key.is_empty() {
                return None;
            }
            return Some((key.to_string(), scalar_of(line[i + 1..].trim())));
        }
    }
    None
}

/// The unindented `key: …` lines of a note's block, in order.
pub(crate) fn keyed_lines(text: &str) -> Vec<KeyedLine> {
    let Some(lines) = block_lines(text) else { return Vec::new() };
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let Some((key, value)) = keyed_line(lines[i]) else {
            i += 1;
            continue;
        };
        // Its run: the indented lines after it, blank lines between them
        // included, up to the last indented one.
        let mut run_end = i;
        for (j, line) in lines.iter().enumerate().skip(i + 1) {
            if indented(line) && !blank(line) {
                run_end = j;
            } else if !blank(line) {
                break;
            }
        }
        out.push(KeyedLine { key, value: if run_end > i { None } else { value } });
        i = run_end + 1;
    }
    out
}

/// Whether a note's text has every tag a search asks for. A tag's line is
/// the first line keyed by its name; names and values match whatever their
/// case.
pub(crate) fn matches_tags(text: &str, filters: &[TagFilter]) -> bool {
    if filters.is_empty() {
        return true;
    }
    let lines = keyed_lines(text);
    filters.iter().all(|f| {
        let name = f.name.to_lowercase();
        match lines.iter().find(|l| l.key.to_lowercase() == name) {
            Some(KeyedLine { value: Some(v), .. }) => {
                f.value.as_ref().is_none_or(|want| want.to_lowercase() == v.to_lowercase())
            }
            _ => false,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn fixture() -> Value {
        let at = concat!(env!("CARGO_MANIFEST_DIR"), "/../verify-harness/tags-fixture.json");
        serde_json::from_str(&std::fs::read_to_string(at).unwrap()).unwrap()
    }

    #[test]
    fn lines_answer_the_shared_cases() {
        let fx = fixture();
        for case in fx["lines"].as_array().unwrap() {
            let text = case["text"].as_str().unwrap();
            let want: Vec<KeyedLine> = case["lines"]
                .as_array()
                .unwrap()
                .iter()
                .map(|l| KeyedLine {
                    key: l["key"].as_str().unwrap().to_string(),
                    value: l["value"].as_str().map(str::to_string),
                })
                .collect();
            assert_eq!(keyed_lines(text), want, "lines of {text:?}");
        }
    }

    #[test]
    fn matches_answer_the_shared_cases() {
        let fx = fixture();
        for case in fx["match"].as_array().unwrap() {
            let text = case["text"].as_str().unwrap();
            let filters: Vec<TagFilter> = serde_json::from_value(case["filters"].clone()).unwrap();
            assert_eq!(
                matches_tags(text, &filters),
                case["matches"].as_bool().unwrap(),
                "{filters:?} in {text:?}"
            );
        }
    }
}
