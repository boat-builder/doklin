//! The workspace's tag list as the manifest holds it: the shared workspace's
//! `tags`, which say which of a note's frontmatter lines are tags and which
//! values each takes. The rules are src/tags.ts's, and the worker refuses a
//! manifest whose list breaks them (cloud-worker/src/manifest.ts) — which
//! would stop this device's sync — so nothing goes up from here that it
//! would refuse. Held to verify-harness/tags-fixture.json (`names`,
//! `values`, `defs`, `changes`) with src/tags.ts: change both.
//!
//! A change made on this device is queued (`TagOp`, kept in the shared
//! section's state) and folded over the list as the manifest has it when the
//! write lands, the way a published page is: two changes of one tag at once,
//! and the later one wins.

use serde::{Deserialize, Serialize};
use unicode_properties::{GeneralCategoryGroup, UnicodeGeneralCategory};

use super::parse_u32;

/* ---------- Limits (src/tags.ts, read by build.rs) ---------- */

pub const NAME_MAX: usize = parse_u32(env!("DOKLIN_TAG_NAME_MAX")) as usize;
pub const VALUE_MAX: usize = parse_u32(env!("DOKLIN_TAG_VALUE_MAX")) as usize;
pub const DESC_MAX: usize = parse_u32(env!("DOKLIN_TAG_DESC_MAX")) as usize;
pub const TAGS_MAX: usize = parse_u32(env!("DOKLIN_TAG_TAGS_MAX")) as usize;
pub const VALUES_MAX: usize = parse_u32(env!("DOKLIN_TAG_VALUES_MAX")) as usize;

/* ---------- Wire types ---------- */

/// A tag of the list: its name, the values a note can have, in order, and
/// what they mean, for the people and agents who set them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TagDef {
    pub name: String,
    pub values: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desc: Option<String>,
}

/// A change of the list this device owes the manifest. Kept, in order, until
/// a won write carries it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum TagOp {
    /// The tag that was `at` — or a new one, when none is called that — is
    /// now `def`.
    Set { at: String, def: TagDef },
    Remove { name: String },
}

impl TagOp {
    /// The list with this change made (`withTag`, `withoutTag`).
    pub fn apply(&self, list: &[TagDef]) -> Vec<TagDef> {
        match self {
            TagOp::Set { at, def } => with_tag(list, at, def),
            TagOp::Remove { name } => without_tag(list, name),
        }
    }
}

/* ---------- The rules ---------- */

fn same(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

/// What JavaScript's `trim` takes off — its white space and line ends,
/// which are not quite Rust's.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
            | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// The tag of `list` called `name`, whatever its case.
pub fn tag<'a>(list: &'a [TagDef], name: &str) -> Option<&'a TagDef> {
    list.iter().find(|d| same(&d.name, name))
}

/// `\p{L}` or `\p{N}`.
fn letter_or_digit(c: char) -> bool {
    matches!(c.general_category_group(), GeneralCategoryGroup::Letter | GeneralCategoryGroup::Number)
}

/// Why `name` can't be a tag's name in `list` (a sentence), or None.
/// `except` is the tag being renamed, whose own name doesn't count.
pub fn name_problem(name: &str, list: &[TagDef], except: Option<&str>) -> Option<String> {
    let mut chars = name.chars();
    let Some(first) = chars.next() else { return Some("A tag needs a name.".into()) };
    if name.chars().count() > NAME_MAX {
        return Some(format!("A tag's name can be {} characters at most.", NAME_MAX));
    }
    let shaped = letter_or_digit(first)
        && chars.all(|c| letter_or_digit(c) || c == ' ' || c == '_' || c == '-')
        && !name.ends_with(' ');
    if !shaped {
        return Some(
            "A tag's name holds letters, digits, spaces, _ and -, and starts and ends with a letter or a digit.".into(),
        );
    }
    list.iter()
        .find(|d| same(&d.name, name) && !except.is_some_and(|e| same(&d.name, e)))
        .map(|taken| format!("There's already a tag called {}.", taken.name))
}

/// Why `value` can't be a value beside `others` (a sentence), or None.
pub fn value_problem(value: &str, others: &[String]) -> Option<String> {
    if value.is_empty() {
        return Some("A value can't be empty.".into());
    }
    if value.chars().count() > VALUE_MAX {
        return Some(format!("A value can be {} characters at most.", VALUE_MAX));
    }
    if value.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}') {
        return Some("A value is one line of text.".into());
    }
    if value.trim_matches(js_space) != value {
        return Some("A value can't start or end with a space.".into());
    }
    others.iter().find(|o| same(o, value)).map(|twin| format!("{} is there twice.", twin))
}

/// Why `def` can't be a tag beside the others of `list` (a sentence), or
/// None. `except` is the tag being renamed, whose own name doesn't count.
pub fn tag_problem(def: &TagDef, list: &[TagDef], except: Option<&str>) -> Option<String> {
    if let Some(named) = name_problem(&def.name, list, except) {
        return Some(named);
    }
    if def.values.is_empty() {
        return Some("A tag needs at least one value.".into());
    }
    if def.values.len() > VALUES_MAX {
        return Some(format!("A tag can have {} values at most.", VALUES_MAX));
    }
    for (i, value) in def.values.iter().enumerate() {
        if let Some(wrong) = value_problem(value, &def.values[..i]) {
            return Some(wrong);
        }
    }
    if def.desc.as_ref().is_some_and(|d| d.chars().count() > DESC_MAX) {
        return Some(format!("What a tag's values mean can be {} characters at most.", DESC_MAX));
    }
    None
}

/// Why a workspace's list can't be `list` (a sentence naming the tag), or
/// None: what the worker refuses a manifest's `tags` for.
pub fn list_problem(list: &[TagDef]) -> Option<String> {
    if list.len() > TAGS_MAX {
        return Some(format!("A workspace can have {} tags at most.", TAGS_MAX));
    }
    list.iter()
        .enumerate()
        .find_map(|(i, def)| tag_problem(def, &list[..i], None).map(|wrong| format!("{}: {}", def.name, wrong)))
}

/// A tag as somebody typed it: the name and each value trimmed, and what
/// the values mean trimmed, gone when there is nothing.
pub fn cleaned(def: TagDef) -> TagDef {
    let trim = |s: &str| s.trim_matches(js_space).to_string();
    TagDef {
        name: trim(&def.name),
        values: def.values.iter().map(|v| trim(v)).collect(),
        desc: def.desc.map(|d| trim(&d)).filter(|d| !d.is_empty()),
    }
}

/* ---------- Changing the list ---------- */

/// The list with the tag that was `at` now `def` — in its place, or at the
/// end when no tag is called `at` — and no other tag of `def`'s name.
pub fn with_tag(list: &[TagDef], at: &str, def: &TagDef) -> Vec<TagDef> {
    let i = list.iter().position(|d| same(&d.name, at));
    let mut out: Vec<TagDef> = Vec::with_capacity(list.len() + 1);
    for (j, d) in list.iter().enumerate() {
        if Some(j) == i {
            out.push(def.clone());
        } else if !same(&d.name, &def.name) {
            out.push(d.clone());
        }
    }
    if i.is_none() {
        out.push(def.clone());
    }
    out
}

/// The list without the tag called `name`.
pub fn without_tag(list: &[TagDef], name: &str) -> Vec<TagDef> {
    list.iter().filter(|d| !same(&d.name, name)).cloned().collect()
}

/// `list` with `ops` made in order — each that leaves it whole. One that
/// wouldn't (two devices taking the last place in a full list at once) is
/// passed over.
pub fn folded(list: &[TagDef], ops: &[TagOp]) -> Vec<TagDef> {
    let mut out = list.to_vec();
    for op in ops {
        let next = op.apply(&out);
        if list_problem(&next).is_none() {
            out = next;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn fixture() -> Value {
        let at = concat!(env!("CARGO_MANIFEST_DIR"), "/../verify-harness/tags-fixture.json");
        serde_json::from_str(&std::fs::read_to_string(at).expect("the tags fixture")).expect("the tags fixture is JSON")
    }

    fn defs(v: &Value) -> Vec<TagDef> {
        serde_json::from_value(v.clone()).expect("a list of tags")
    }

    #[test]
    fn names_and_values_are_the_apps() {
        let fx = fixture();
        for case in fx["names"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            assert_eq!(name_problem(name, &[], None).is_none(), case["ok"].as_bool().unwrap(), "name {:?}", name);
        }
        for case in fx["values"].as_array().unwrap() {
            let value = case["value"].as_str().unwrap();
            assert_eq!(value_problem(value, &[]).is_none(), case["ok"].as_bool().unwrap(), "value {:?}", value);
        }
        // What the fixture can't hold: marks, which are no letter, and the
        // space JavaScript trims that Rust doesn't.
        assert!(name_problem("e\u{301}tape", &[], None).is_some(), "a combining mark is no letter or digit");
        assert!(value_problem("a\u{feff}", &[]).is_some());
        assert!(value_problem("a\u{85}", &[]).is_none(), "U+0085 is not a space to JavaScript");
    }

    #[test]
    fn a_tag_is_held_to_the_apps_rules() {
        for case in fixture()["defs"].as_array().unwrap() {
            let def: TagDef = serde_json::from_value(case["def"].clone()).unwrap();
            let got = tag_problem(&def, &defs(&case["list"]), case["except"].as_str());
            assert_eq!(got.as_deref(), case["problem"].as_str(), "{}", case);
        }
        let tag = |values: usize, desc: Option<String>| TagDef {
            name: "s".into(),
            values: (0..values).map(|i| format!("v{}", i)).collect(),
            desc,
        };
        assert_eq!(tag_problem(&tag(VALUES_MAX, None), &[], None), None);
        assert_eq!(tag_problem(&tag(VALUES_MAX + 1, None), &[], None), Some(format!("A tag can have {} values at most.", VALUES_MAX)));
        assert_eq!(tag_problem(&tag(1, Some("状".repeat(DESC_MAX))), &[], None), None, "characters, not bytes");
        assert!(tag_problem(&tag(1, Some("x".repeat(DESC_MAX + 1))), &[], None).is_some());
        let many: Vec<TagDef> = (0..TAGS_MAX).map(|i| TagDef { name: format!("t{}", i), ..tag(1, None) }).collect();
        assert_eq!(list_problem(&many), None);
        let over = [many.clone(), vec![TagDef { name: "one more".into(), ..tag(1, None) }]].concat();
        assert_eq!(list_problem(&over), Some(format!("A workspace can have {} tags at most.", TAGS_MAX)));
    }

    #[test]
    fn a_change_is_the_apps() {
        for case in fixture()["changes"].as_array().unwrap() {
            let op = match case["def"].is_null() {
                false => TagOp::Set { at: case["at"].as_str().unwrap().into(), def: serde_json::from_value(case["def"].clone()).unwrap() },
                true => TagOp::Remove { name: case["remove"].as_str().unwrap().into() },
            };
            let got = op.apply(&defs(&case["list"]));
            assert_eq!(got, defs(&case["out"]), "{}", case);
            assert_eq!(list_problem(&got), None);
        }
    }

    #[test]
    fn changes_fold_in_order_and_one_that_would_break_the_list_is_passed_over() {
        let tag = |name: &str| TagDef { name: name.into(), values: vec!["a".into()], desc: None };
        let full: Vec<TagDef> = (0..TAGS_MAX).map(|i| tag(&format!("t{}", i))).collect();
        let ops = [
            TagOp::Set { at: "extra".into(), def: tag("extra") },
            TagOp::Remove { name: "t0".into() },
            TagOp::Set { at: "late".into(), def: tag("late") },
        ];
        let got = folded(&full, &ops);
        assert_eq!(got.len(), TAGS_MAX);
        assert!(!got.iter().any(|d| d.name == "extra"), "no room for it");
        assert_eq!(got.last().unwrap().name, "late", "room once t0 went");
    }

    #[test]
    fn a_typed_tag_is_trimmed() {
        let typed = TagDef { name: " status ".into(), values: vec![" Todo".into(), "Done\u{feff}".into()], desc: Some("  \n ".into()) };
        assert_eq!(cleaned(typed), TagDef { name: "status".into(), values: vec!["Todo".into(), "Done".into()], desc: None });
    }
}
