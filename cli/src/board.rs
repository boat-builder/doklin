//! `doklin board` — a board as one thing (docs/cloud.md §8.6).
//!
//! On a Mac a board is a folder of notes and a definition file. Here it is
//! never that: it is named by its path, its cards by their titles, its fields
//! and options by their names, and everything is asked of the worker's board
//! routes (cloud-worker/src/agentBoards.ts). A property is sent exactly as it
//! was typed — `status=Done`, `tags+=bug` — and read there, against the
//! field's type, so the rules of a board live in one place and not here.

use std::io::{IsTerminal, Read};

use serde_json::{json, Value};

use crate::args::Args;
use crate::commands::{session, strings, text, Ctx, Session};
use crate::http::Body;
use crate::text::{ago, list, plural};
use crate::Failure;

const FEATURE: &str = "agent-boards";
/// How many times a request is repeated while the worker reads a board's
/// cards, or rewrites them for a rename — a large board takes a few rounds.
const ROUNDS: usize = 200;
const PLACES: &[&str] = &["first", "last", "before", "after"];

pub fn board(args: &Args, ctx: &Ctx) -> Result<(), Failure> {
    match args.positionals.first().map(String::as_str).unwrap_or("") {
        "info" => info(args, ctx),
        "show" => show(args, ctx),
        "card" => card(args, ctx),
        "add" => add(args, ctx),
        "set" => set(args, ctx),
        "rm" => rm(args, ctx),
        "new" => new(args, ctx),
        "field" => field(args, ctx),
        "option" => option(args, ctx),
        "" => Err(Failure::usage("say what to do with a board — doklin board show <board>, or see doklin help boards")),
        other => Err(Failure::usage(format!(
            "\"{}\" is not something a board does — info, show, card, add, set, rm, new, field or option (doklin help boards)",
            other
        ))),
    }
}

/* ---------- Asking ---------- */

/// One request, repeated while the worker answers 202 — it is still reading
/// the board's cards into its copy. `waiting` is said once, to a person.
fn until_done(s: &Session, ctx: &Ctx, method: &str, route: &str, query: &[(&str, &str)], body: Option<&Value>, waiting: &str) -> Result<Value, Failure> {
    for round in 0..ROUNDS {
        let reply = s.client.send(method, route, query, &[], body.map(Body::Json))?;
        let v = reply.json()?;
        if reply.status != 202 {
            return Ok(v);
        }
        if round == 0 && !ctx.json {
            eprintln!("{}", waiting);
        }
    }
    Err(Failure::other("the board is still being read — try again in a moment"))
}

const READING: &str = "Reading the board's cards — this happens after they change…";

/// `--first`, `--last`, `--before <x>`, `--after <x>` as the body says them.
fn place(args: &Args, body: &mut Value) -> Result<(), Failure> {
    let given: Vec<&str> = PLACES.iter().copied().filter(|p| args.has(p) || args.value(p).is_some()).collect();
    if given.len() > 1 {
        return Err(Failure::usage("say one place — --first, --last, --before or --after"));
    }
    for p in ["first", "last"] {
        if args.has(p) {
            body[p] = json!(true);
        }
    }
    for p in ["before", "after"] {
        if let Some(name) = args.value(p) {
            body[p] = json!(name);
        }
    }
    Ok(())
}

/// The assignments after the names a verb takes: `status=Done tags+=bug`.
fn assignments(args: &Args, from: usize) -> Result<Vec<String>, Failure> {
    let rest: Vec<String> = args.positionals.iter().skip(from).cloned().collect();
    for a in &rest {
        if !a.contains('=') {
            return Err(Failure::usage(format!(
                "\"{}\" is not a property to set — write it as <field>=<value>, like status=Done (quote a name with spaces)",
                a
            )));
        }
    }
    Ok(rest)
}

/* ---------- Words ---------- */

/// A property's value as a person reads it.
fn plain(v: &Value) -> String {
    match v {
        Value::Array(items) => items.iter().map(plain).collect::<Vec<_>>().join(", "),
        Value::Bool(true) => "yes".to_string(),
        Value::Bool(false) => "no".to_string(),
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// `Owner Ada · Tags hull` — a card's properties on one line, leaving out the
/// one its column already says.
fn props_line(props: &Value, except: Option<&str>) -> String {
    props
        .as_object()
        .map(|m| m.iter().filter(|(k, _)| Some(k.as_str()) != except).map(|(k, v)| format!("{} {}", k, plain(v))).collect::<Vec<_>>().join(" · "))
        .unwrap_or_default()
}

fn field_line(f: &Value) -> String {
    let kind = match text(f, "type") {
        "multi_select" => "multi-select",
        t => t,
    };
    let options: Vec<String> = f["options"].as_array().into_iter().flatten().map(|o| text(o, "name").to_string()).collect();
    if f.get("options").is_some() {
        format!("{} ({}: {})", text(f, "name"), kind, if options.is_empty() { "no options yet".to_string() } else { options.join(", ") })
    } else {
        format!("{} ({})", text(f, "name"), kind)
    }
}

fn conflicts_note(v: &Value) -> Option<String> {
    let copies = strings(&v["conflicts"]);
    (!copies.is_empty()).then(|| {
        format!(
            "Its definition has a sync conflict copy ({}) — the board's columns may disagree between Macs until someone settles it in Doklin.",
            copies.join(", ")
        )
    })
}

fn verb(ctx: &Ctx, done: &str, would: &str) -> String {
    (if ctx.dry_run { would } else { done }).to_string()
}

/* ---------- Reading ---------- */

fn info(args: &Args, ctx: &Ctx) -> Result<(), Failure> {
    args.only(&[], "board info")?;
    let board = args.need(1, "which board — doklin board info <board>")?;
    args.at_most(2)?;
    let s = session(ctx, FEATURE)?;
    let v = s.client.send("GET", "board", &[("path", board)], &[], None)?.json()?;
    ctx.answer(&v, || {
        let cards = plural(v["cards"].as_u64().unwrap_or(0) as usize, "card", "cards");
        let by = v.get("by").and_then(Value::as_str).map(|f| format!(", in columns by {}", f)).unwrap_or_default();
        let mut lines = vec![format!("{} — the board {} · {}{}", text(&v, "name"), text(&v, "board"), cards, by)];
        let fields = v["fields"].as_array().cloned().unwrap_or_default();
        if fields.is_empty() {
            lines.push("  no fields yet — add one with `doklin board field add`".to_string());
        }
        for f in &fields {
            lines.push(format!("  {}", field_line(f)));
        }
        lines.extend(conflicts_note(&v));
        lines.join("\n")
    });
    Ok(())
}

fn show(args: &Args, ctx: &Ctx) -> Result<(), Failure> {
    args.only(&["by", "where"], "board show")?;
    let board = args.need(1, "which board — doklin board show <board>")?;
    args.at_most(2)?;
    let s = session(ctx, FEATURE)?;
    let mut query = vec![("path", board)];
    if let Some(by) = args.value("by") {
        query.push(("by", by));
    }
    for w in args.values("where") {
        query.push(("where", w));
    }
    let v = until_done(&s, ctx, "GET", "cards", &query, None, READING)?;
    ctx.answer(&v, || {
        let total = v["cards"].as_u64().unwrap_or(0) as usize;
        let count = match v.get("shown").and_then(Value::as_u64) {
            Some(shown) => format!("{} of {}", shown, plural(total, "card", "cards")),
            None => plural(total, "card", "cards"),
        };
        let by = v.get("by").and_then(Value::as_str);
        let mut lines = vec![format!("{} — {}{}", text(&v, "name"), count, by.map(|f| format!(", by {}", f)).unwrap_or_default())];
        for col in v["columns"].as_array().into_iter().flatten() {
            let cards = col["cards"].as_array().cloned().unwrap_or_default();
            lines.push(String::new());
            if let Some(name) = col.get("name").and_then(Value::as_str) {
                lines.push(format!("{} ({})", name, cards.len()));
            }
            for c in &cards {
                let conflict = if c.get("conflict").is_some() { "  (a sync conflict copy)" } else { "" };
                let props = props_line(&c["props"], by);
                lines.push(format!("  {:<30} {}{}", text(c, "title"), props, conflict).trim_end().to_string());
            }
        }
        if total == 0 {
            lines.push(format!("\nNo cards yet — add one with `doklin board add {} \"<title>\"`.", text(&v, "board")));
        }
        if let Some(note) = conflicts_note(&v) {
            lines.push(format!("\n{}", note));
        }
        lines.join("\n")
    });
    Ok(())
}

fn card(args: &Args, ctx: &Ctx) -> Result<(), Failure> {
    args.only(&[], "board card")?;
    let usage = "which card — doklin board card <board> <card>";
    let board = args.need(1, usage)?;
    let title = args.need(2, usage)?;
    args.at_most(3)?;
    let s = session(ctx, FEATURE)?;
    let v = s.client.send("GET", "card", &[("path", board), ("card", title)], &[], None)?.json()?;
    ctx.answer(&v, || {
        let who = v.get("byName").and_then(Value::as_str).or_else(|| v.get("by").and_then(Value::as_str));
        let when = v.get("changed").and_then(Value::as_u64).map(ago);
        let changed = match (when, who) {
            (Some(when), Some(who)) => format!(", changed {} by {}", when, who),
            (Some(when), None) => format!(", changed {}", when),
            (None, Some(who)) => format!(", changed by {}", who),
            (None, None) => String::new(),
        };
        let conflict = if v.get("conflict").is_some() { " · a sync conflict copy" } else { "" };
        let mut lines = vec![format!("{} — a card on {} · revision {}{}{}", text(&v, "title"), text(&v, "board"), v["rev"], changed, conflict)];
        let props = v["props"].as_object().cloned().unwrap_or_default();
        let width = props.keys().map(|k| k.chars().count()).max().unwrap_or(0).max(6);
        for (k, value) in &props {
            lines.push(format!("  {:<width$}  {}", k, plain(value), width = width));
        }
        if props.is_empty() {
            lines.push("  no properties set".to_string());
        }
        if let Some(other) = v["other"].as_object() {
            let said: Vec<String> = other.iter().map(|(k, value)| format!("{} {}", k, plain(value))).collect();
            lines.push(format!("  (not the board's fields, kept as they are: {})", said.join(" · ")));
        }
        let threads = v["comments"].as_u64().unwrap_or(0) as usize;
        if threads > 0 {
            lines.push(format!("  {} — `doklin comments \"{}\"`", plural(threads, "comment thread", "comment threads"), text(&v, "path")));
        }
        let page = text(&v, "page");
        lines.push(String::new());
        lines.push(if page.trim().is_empty() { "(its page is empty)".to_string() } else { page.trim_end().to_string() });
        lines.join("\n")
    });
    Ok(())
}

/* ---------- Cards ---------- */

/// A new card's page: `--from <file>`, or `--from -` for what is piped in —
/// never stdin unasked, so a shell that leaves it open cannot hang this.
fn page(args: &Args) -> Result<Option<String>, Failure> {
    let Some(from) = args.value("from") else { return Ok(None) };
    let bytes = if from == "-" {
        let mut stdin = std::io::stdin();
        if stdin.is_terminal() {
            return Err(Failure::usage("--from - reads the page from what is piped in, and nothing is"));
        }
        let mut bytes = Vec::new();
        stdin.read_to_end(&mut bytes).map_err(|e| Failure::other(format!("could not read what was piped in: {}", e)))?;
        bytes
    } else {
        std::fs::read(from).map_err(|e| Failure::usage(format!("could not read {}: {}", from, e)))?
    };
    String::from_utf8(bytes).map(Some).map_err(|_| Failure::usage("a card's page is text — that is not UTF-8"))
}

fn add(args: &Args, ctx: &Ctx) -> Result<(), Failure> {
    args.only(&["first", "from"], "board add")?;
    let usage = "the board and the card's title — doklin board add <board> <title> [<field>=<value>…]";
    let board = args.need(1, usage)?;
    let title = args.need(2, usage)?;
    let set = assignments(args, 3)?;
    let page = page(args)?;
    let s = session(ctx, FEATURE)?;
    let mut body = json!({ "path": board, "title": title, "set": set, "dryRun": ctx.dry_run });
    if args.has("first") {
        body["first"] = json!(true);
    }
    if let Some(page) = page {
        body["page"] = json!(page);
    }
    let v = until_done(&s, ctx, "POST", "card", &[], Some(&body), READING)?;
    ctx.answer(&v, || {
        let mut out = format!(
            "{} \"{}\" to {}{}.",
            verb(ctx, "Added", "Would add"),
            text(&v, "title"),
            text(&v, "board"),
            if ctx.dry_run { String::new() } else { format!(" — revision {}", v["rev"]) }
        );
        let props = props_line(&v["props"], None);
        if !props.is_empty() {
            out.push_str(&format!("\n  {}", props));
        }
        if text(&v, "title") != title.trim() {
            out.push_str("\nIts title is its file's name, which cannot hold / or :.");
        }
        out.push_str(&format!("\nIts page is the document \"{}\".", text(&v, "path")));
        out
    });
    Ok(())
}

fn set(args: &Args, ctx: &Ctx) -> Result<(), Failure> {
    args.only(&["title", "first", "last", "before", "after"], "board set")?;
    let usage = "the board and the card — doklin board set <board> <card> [<field>=<value>…] [--title <new>]";
    let board = args.need(1, usage)?;
    let title = args.need(2, usage)?;
    let set = assignments(args, 3)?;
    let mut body = json!({ "path": board, "card": title, "set": set, "dryRun": ctx.dry_run });
    if let Some(t) = args.value("title") {
        body["title"] = json!(t);
    }
    place(args, &mut body)?;
    let s = session(ctx, FEATURE)?;
    let v = until_done(&s, ctx, "PATCH", "card", &[], Some(&body), READING)?;
    ctx.answer(&v, || {
        if v.get("changed") == Some(&json!(false)) {
            return format!("\"{}\" already says that — nothing was written.", text(&v, "title"));
        }
        let mut out = format!(
            "{} \"{}\" on {}{}.",
            verb(ctx, "Changed", "Would change"),
            text(&v, "title"),
            text(&v, "board"),
            if ctx.dry_run { String::new() } else { format!(" — revision {}", v["rev"]) }
        );
        if let Some(r) = v.get("renamed") {
            out.push_str(&format!("\nIt was \"{}\"; its page is now \"{}\".", text(r, "from"), text(&v, "path")));
        }
        let props = props_line(&v["props"], None);
        out.push_str(&format!("\n  {}", if props.is_empty() { "no properties set".to_string() } else { props }));
        out
    });
    Ok(())
}

fn rm(args: &Args, ctx: &Ctx) -> Result<(), Failure> {
    args.only(&[], "board rm")?;
    let usage = "the board and the card — doklin board rm <board> <card>";
    let board = args.need(1, usage)?;
    let title = args.need(2, usage)?;
    args.at_most(3)?;
    let s = session(ctx, FEATURE)?;
    let mut query = vec![("path", board), ("card", title)];
    if ctx.dry_run {
        query.push(("dry", "1"));
    }
    let v = s.client.send("DELETE", "card", &query, &[], None)?.json()?;
    ctx.answer(&v, || {
        let mut out = format!("{} the card \"{}\" from {}, with its comments.", verb(ctx, "Removed", "Would remove"), text(&v, "title"), text(&v, "board"));
        let still = strings(&v["stillPublic"]);
        if !still.is_empty() {
            out.push_str(&format!(
                "\nIts page stays published at {} — the address answers 404 until the card is back. Stop with `doklin unpublish`.",
                still.join(", ")
            ));
        }
        if !ctx.dry_run {
            out.push_str("\nA Mac that syncs this workspace keeps a copy in its Trash and its version history.");
        }
        out
    });
    Ok(())
}

/* ---------- The board itself ---------- */

fn new(args: &Args, ctx: &Ctx) -> Result<(), Failure> {
    args.only(&["name"], "board new")?;
    let path = args.need(1, "where the board goes — doklin board new <path>")?;
    args.at_most(2)?;
    let s = session(ctx, FEATURE)?;
    let mut body = json!({ "path": path, "dryRun": ctx.dry_run });
    if let Some(name) = args.value("name") {
        body["name"] = json!(name);
    }
    let v = s.client.send("POST", "board", &[], &[], Some(Body::Json(&body)))?.json()?;
    ctx.answer(&v, || {
        let fields: Vec<String> = v["fields"].as_array().into_iter().flatten().map(field_line).collect();
        format!(
            "{} the board {} (\"{}\"), with {}.\nAdd cards with `doklin board add {} \"<title>\"`.",
            verb(ctx, "Made", "Would make"),
            text(&v, "board"),
            text(&v, "name"),
            list(&fields),
            text(&v, "board")
        )
    });
    Ok(())
}

fn field(args: &Args, ctx: &Ctx) -> Result<(), Failure> {
    let usage = "doklin board field add|set|rm <board> <field> …";
    let action = args.positionals.get(1).map(String::as_str).unwrap_or("");
    let board = args.need(2, &format!("which board — {}", usage))?;
    let name = args.need(3, &format!("which field — {}", usage))?;
    args.at_most(4)?;
    let s = || session(ctx, FEATURE);
    match action {
        "add" => {
            args.only(&["type", "options"], "board field add")?;
            let kind = args.value("type").ok_or_else(|| {
                Failure::usage("say what the field holds with --type: select, multi_select, text, number, date or checkbox")
            })?;
            let mut body = json!({ "path": board, "name": name, "type": kind, "dryRun": ctx.dry_run });
            if let Some(options) = args.value("options") {
                body["options"] = json!(options);
            }
            let v = s()?.client.send("POST", "field", &[], &[], Some(Body::Json(&body)))?.json()?;
            ctx.answer(&v, || format!("{} the field {} to {}.", verb(ctx, "Added", "Would add"), field_line(&v["field"]), text(&v, "board")));
        }
        "set" => {
            args.only(&["name"], "board field set")?;
            let to = args.value("name").ok_or_else(|| Failure::usage("say the field's new name with --name"))?;
            let body = json!({ "path": board, "field": name, "name": to, "dryRun": ctx.dry_run });
            let v = s()?.client.send("PATCH", "field", &[], &[], Some(Body::Json(&body)))?.json()?;
            ctx.answer(&v, || {
                format!(
                    "{} the field {} to {} on {}. Its cards keep their values.",
                    verb(ctx, "Renamed", "Would rename"),
                    text(&v["renamed"], "from"),
                    text(&v["renamed"], "to"),
                    text(&v, "board")
                )
            });
        }
        "rm" => {
            args.only(&[], "board field rm")?;
            let mut query = vec![("path", board), ("field", name)];
            if ctx.dry_run {
                query.push(("dry", "1"));
            }
            let v = s()?.client.send("DELETE", "field", &query, &[], None)?.json()?;
            ctx.answer(&v, || {
                format!(
                    "{} the field {} from {}. No card is changed: each keeps what it had, and `doklin board card` shows it as not the board's.",
                    verb(ctx, "Removed", "Would remove"),
                    text(&v["field"], "name"),
                    text(&v, "board")
                )
            });
        }
        _ => return Err(Failure::usage(format!("say add, set or rm — {}", usage))),
    }
    Ok(())
}

fn options_now(v: &Value) -> String {
    let names: Vec<String> = v["options"].as_array().into_iter().flatten().map(|o| text(o, "name").to_string()).collect();
    names.join(", ")
}

fn option(args: &Args, ctx: &Ctx) -> Result<(), Failure> {
    let usage = "doklin board option add|set|rm <board> <field> <option> …";
    let action = args.positionals.get(1).map(String::as_str).unwrap_or("");
    let board = args.need(2, &format!("which board — {}", usage))?;
    let field = args.need(3, &format!("which field — {}", usage))?;
    let name = args.need(4, &format!("which option — {}", usage))?;
    args.at_most(5)?;
    let s = || session(ctx, FEATURE);
    match action {
        "add" => {
            args.only(&["color", "first", "last", "before", "after"], "board option add")?;
            let mut body = json!({ "path": board, "field": field, "name": name, "dryRun": ctx.dry_run });
            if let Some(color) = args.value("color") {
                body["color"] = json!(color);
            }
            place(args, &mut body)?;
            let v = s()?.client.send("POST", "option", &[], &[], Some(Body::Json(&body)))?.json()?;
            ctx.answer(&v, || {
                format!(
                    "{} {} to {} on {} — its options are now: {}.",
                    verb(ctx, "Added", "Would add"),
                    text(&v["option"], "name"),
                    text(&v, "field"),
                    text(&v, "board"),
                    options_now(&v)
                )
            });
        }
        "set" => {
            args.only(&["name", "color", "first", "last", "before", "after"], "board option set")?;
            let mut body = json!({ "path": board, "field": field, "option": name, "dryRun": ctx.dry_run });
            if let Some(to) = args.value("name") {
                body["name"] = json!(to);
            }
            if let Some(color) = args.value("color") {
                body["color"] = json!(color);
            }
            place(args, &mut body)?;
            let session = s()?;
            // A rename rewrites every card that carries the old name, a round
            // at a time: the same request again carries on until none is left.
            let mut cards = 0;
            let mut v = Value::Null;
            for round in 0..ROUNDS {
                let reply = session.client.send("PATCH", "option", &[], &[], Some(Body::Json(&body)))?;
                v = reply.json()?;
                cards += v["cards"].as_u64().unwrap_or(0);
                if reply.status != 202 {
                    break;
                }
                if round == 0 && !ctx.json {
                    eprintln!("Renaming it on every card that carries it…");
                }
                if round + 1 == ROUNDS {
                    return Err(Failure::other("the rename is still being made on the board's cards — run the same command again"));
                }
            }
            if v.get("renamed").is_some() {
                v["cards"] = json!(cards);
            }
            ctx.answer(&v, || {
                let mut out = format!(
                    "{} {} on {} on {} — its options are now: {}.",
                    verb(ctx, "Changed", "Would change"),
                    text(&v["option"], "name"),
                    text(&v, "field"),
                    text(&v, "board"),
                    options_now(&v)
                );
                if let Some(r) = v.get("renamed") {
                    out.push_str(&format!(
                        "\nEvery card that had {} {} {} ({} {}).",
                        text(r, "from"),
                        if ctx.dry_run { "would have" } else { "has" },
                        text(r, "to"),
                        plural(cards as usize, "card", "cards"),
                        if ctx.dry_run { "to rewrite" } else { "rewritten" }
                    ));
                }
                out
            });
        }
        "rm" => {
            args.only(&[], "board option rm")?;
            let mut query = vec![("path", board), ("field", field), ("option", name)];
            if ctx.dry_run {
                query.push(("dry", "1"));
            }
            let v = s()?.client.send("DELETE", "option", &query, &[], None)?.json()?;
            ctx.answer(&v, || {
                format!(
                    "{} {} from {} on {}. No card is changed: one that has it keeps it, in a column of its own. Its options are now: {}.",
                    verb(ctx, "Removed", "Would remove"),
                    text(&v["option"], "name"),
                    text(&v, "field"),
                    text(&v, "board"),
                    options_now(&v)
                )
            });
        }
        _ => return Err(Failure::usage(format!("say add, set or rm — {}", usage))),
    }
    Ok(())
}
