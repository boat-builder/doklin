//! What each command does: one or two requests to the document API — more
//! where an answer comes a page of sections at a time (`Pages`) — and then
//! either the worker's answer as JSON or a sentence about it.
//!
//! Nothing here knows Doklin's rules — which files make a document, where a
//! comment's marker goes, what a public page is. Those run in the worker, so
//! that this program stays a thin way of asking.

use std::cell::Cell;
use std::io::{IsTerminal, Read, Write};

use serde_json::{json, Value};

use crate::args::Args;
use crate::creds::{self, Workspace};
use crate::http::{not_a_worker, too_old, Body, Client, Reply};
use crate::link::PageLink;
use crate::text::{ago, list, plural, size, stamp, version_word};
use crate::{usage, Failure};

/// What every command is told about the line it was run from.
pub struct Ctx {
    /// Answer in JSON: asked for, or stdout is not a terminal.
    pub json: bool,
    pub dry_run: bool,
    /// `-w <domain>`.
    pub workspace: Option<String>,
}

impl Ctx {
    /// The worker's answer — as it came, or its pages as one (`Pages`) — or
    /// the sentence a person reads.
    pub(crate) fn answer(&self, v: &Value, words: impl FnOnce() -> String) {
        if self.json {
            println!("{}", v);
        } else {
            println!("{}", words());
        }
    }
}

/* ---------- The session a command runs in ---------- */

struct Session {
    client: Client,
    ws: Workspace,
}

/// The workspace this command means, and a client for it.
fn session(ctx: &Ctx) -> Result<Session, Failure> {
    let all = creds::load()?;
    let ws = creds::pick(&all, ctx.workspace.as_deref())?.clone();
    let client = Client::new(&ws.endpoint, Some(&ws.token));
    Ok(Session { client, ws })
}

/// Every word that is a link to a page becomes the path it leads to, as this
/// agent's person names it — asked of the domain the link is to, which is
/// then the workspace the command runs in. A link only names ids; the domain
/// says where they lead, and says the same of every page this agent cannot
/// open.
pub fn follow_links(args: &mut Args, ctx: &mut Ctx) -> Result<(), Failure> {
    for i in 0..args.positionals.len() {
        let Some(link) = PageLink::parse(&args.positionals[i]) else { continue };
        if let Some(wanted) = ctx.workspace.as_deref() {
            let wanted = creds::domain_of(wanted.trim_end_matches('/'));
            if !wanted.eq_ignore_ascii_case(&link.domain) {
                return Err(Failure::usage(format!("that link is to a page in {}, not in {}", link.domain, wanted)));
            }
        }
        ctx.workspace = Some(link.domain.clone());
        let s = session(ctx)?;
        let query = [("workspace", link.ws_id.as_str()), ("space", link.space.as_str()), ("file", link.file.as_str())];
        let found = s.client.send("GET", "find", &query, &[], None)?.json()?;
        args.positionals[i] = text(&found, "path").to_string();
    }
    Ok(())
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect()).unwrap_or_default()
}

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

/// `--md` / `--html`, as the query value the worker reads — and a refusal
/// when both are given.
fn version_flag(args: &Args) -> Result<Option<&'static str>, Failure> {
    match (args.has("md"), args.has("html")) {
        (true, true) => Err(Failure::usage("say --md or --html, not both")),
        (true, false) => Ok(Some("md")),
        (false, true) => Ok(Some("html")),
        (false, false) => Ok(None),
    }
}

/// What may be done, in words: "read, comment and edit".
fn may(scopes: &[String]) -> String {
    list(scopes)
}

/* ---------- login, logout, whoami ---------- */

fn normalize_endpoint(raw: &str) -> Result<String, Failure> {
    let raw = raw.trim().trim_end_matches('/');
    // A scheme is the same word in any case, and so is a host; no scheme means https.
    let (scheme, rest) = match raw.split_once("://") {
        Some((scheme, rest)) => (scheme.to_ascii_lowercase(), rest),
        None => ("https".to_string(), raw),
    };
    let host = rest.split('/').next().unwrap_or(rest);
    if host.is_empty() || host.contains(char::is_whitespace) || !(scheme == "https" || scheme == "http") {
        return Err(Failure::usage(format!(
            "\"{}\" is not a workspace's address — it looks like notes.example.com",
            raw
        )));
    }
    Ok(format!("{}://{}", scheme, host.to_ascii_lowercase()))
}

pub fn login(args: &Args, ctx: &Ctx) -> Result<(), Failure> {
    let usage = "the whole line you were given — doklin login <domain> <code>";
    let endpoint = normalize_endpoint(args.need(0, usage)?)?;
    let code = match args.need(1, usage)? {
        "-" => piped_code()?,
        code => code.to_string(),
    };
    args.at_most(2)?;
    let domain = creds::domain_of(&endpoint).to_string();

    let host = gethostname::gethostname().to_string_lossy().to_string();
    let reply = Client::new(&endpoint, None)
        .send("POST", "login", &[], &[], Some(Body::Json(&json!({ "code": code, "host": host }))))?;
    let v = reply.json()?;
    let token = text(&v, "token");
    if token.is_empty() {
        return Err(Failure::other(format!("{} did not answer with a login — is it a Doklin workspace?", domain)));
    }

    let mut all = creds::load()?;
    let before = all.workspaces.iter().find(|w| w.endpoint == endpoint).map(|w| w.token.clone());
    all.workspaces.retain(|w| w.endpoint != endpoint);
    all.workspaces.push(Workspace {
        endpoint: endpoint.clone(),
        name: text(&v["workspace"], "name").to_string(),
        agent: text(&v["agent"], "name").to_string(),
        token: token.to_string(),
    });
    creds::save(&all)?;
    // The login this one replaces is no use to anybody now: let it go, so
    // its person's list shows one machine and not two. Best effort.
    if let Some(old) = before {
        let _ = Client::new(&endpoint, Some(&old)).send("DELETE", "login", &[], &[], None);
    }
    // The allowance for the requests to come. Best effort: the login is
    // made, and a usage file that cannot be written stops the next command
    // with its own sentence.
    let _ = usage::keep_limits(&domain, &v["limits"]);

    // Never the token: it is in the credentials file and nowhere else.
    let shown = json!({ "workspace": v["workspace"], "agent": v["agent"], "scopes": v["scopes"], "endpoint": endpoint });
    ctx.answer(&shown, || {
        format!(
            "Logged in to {} ({}) as {}. It may {}.\nEvery path starts with its section: Library/, My files/ or Shared with me/.\nPut new work under My files/ unless you are told where it goes, and put a path with a space in quotes.\nRun `doklin help agent` for what to do next.",
            text(&v["workspace"], "name"),
            domain,
            text(&v["agent"], "name"),
            may(&strings(&v["scopes"]))
        )
    });
    Ok(())
}

/// `doklin login <domain> -`: the code from the first line piped in, which
/// is how the Doklin app hands one over — a process list shows the
/// arguments of a command, never what was piped into it.
fn piped_code() -> Result<String, Failure> {
    let mut stdin = std::io::stdin();
    if stdin.is_terminal() {
        return Err(Failure::usage("pipe the code in after `-`, or put the code itself in its place"));
    }
    let mut piped = String::new();
    stdin.read_to_string(&mut piped).map_err(|e| Failure::other(format!("could not read what was piped in: {}", e)))?;
    match piped.lines().next().map(str::trim) {
        Some(code) if !code.is_empty() => Ok(code.to_string()),
        _ => Err(Failure::usage("nothing was piped in — pipe the code in after `-`")),
    }
}

pub fn logout(args: &Args, ctx: &Ctx) -> Result<(), Failure> {
    args.at_most(0)?;
    let mut all = creds::load()?;
    let ws = creds::pick(&all, ctx.workspace.as_deref())?.clone();
    if ctx.dry_run {
        ctx.answer(&json!({ "endpoint": ws.endpoint, "loggedOut": false }), || {
            format!("Would log this machine out of {}.", ws.domain())
        });
        return Ok(());
    }
    // A login the domain has already forgotten is still a logout here.
    match Client::new(&ws.endpoint, Some(&ws.token)).send("DELETE", "login", &[], &[], None) {
        Ok(_) => {}
        Err(f) if f.status == Some(401) => {}
        Err(f) => return Err(f),
    }
    all.workspaces.retain(|w| w.endpoint != ws.endpoint);
    creds::save(&all)?;
    ctx.answer(&json!({ "endpoint": ws.endpoint, "loggedOut": true }), || {
        format!("Logged out of {}. This machine's token no longer works anywhere.", ws.domain())
    });
    Ok(())
}

pub fn whoami(args: &Args, ctx: &Ctx) -> Result<(), Failure> {
    args.at_most(0)?;
    let s = session(ctx)?;
    let v = s.client.send("GET", "me", &[], &[], None)?.json()?;
    usage::keep_limits(s.ws.domain(), &v["limits"])?;
    ctx.answer(&v, || {
        // Whose it is, and the sections that lets it work in — none listed
        // when the domain's database could not say.
        let whose = match v["person"].get("name").and_then(Value::as_str) {
            Some(name) if !name.is_empty() => format!(", {}'s agent", name),
            _ => String::new(),
        };
        let sections: Vec<String> = strings(&v["sections"]).iter().map(|s| format!("{}/", s)).collect();
        let places = if sections.is_empty() { String::new() } else { format!("\nIt sees {}.", list(&sections)) };
        format!(
            "{}{} on {} ({})\nIt may {}.{}\nWorker version {}.",
            text(&v["agent"], "name"),
            whose,
            text(&v["workspace"], "name"),
            s.ws.domain(),
            may(&strings(&v["scopes"])),
            places,
            v["version"]
        )
    });
    Ok(())
}

/* ---------- ls, info, read ---------- */

/// A document row's versions in brackets: `[md · html, html is behind]`.
fn versions_of(row: &Value) -> String {
    let mut have = Vec::new();
    if row.get("md").is_some() {
        have.push("md");
    }
    if row.get("html").is_some() {
        have.push("html");
    }
    let behind = if row.get("htmlBehind").is_some() { ", html is behind" } else { "" };
    format!("[{}{}]", have.join(" · "), behind)
}

/// `--where status=Doing` (repeatable), as the worker reads it:
/// `status:Doing`, or a tag's name alone for any value.
fn wheres(args: &Args) -> Result<Vec<String>, Failure> {
    args.values("where")
        .iter()
        .map(|w| {
            let (name, value) = match w.split_once('=') {
                Some((name, value)) => (name.trim(), Some(value.trim())),
                None => (w.trim(), None),
            };
            if name.is_empty() || value == Some("") {
                return Err(Failure::usage("--where takes a tag and a value, as status=Doing — or a tag's name alone, for any value"));
            }
            Ok(match value {
                Some(value) => format!("{}:{}", name, value),
                None => name.to_string(),
            })
        })
        .collect()
}

/// What `--where` asked for, as the worker said it back: "status: Doing and a priority".
fn where_words(v: &Value) -> String {
    let said: Vec<String> = v["where"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|f| match f.get("value").and_then(Value::as_str) {
            Some(value) => format!("{}: {}", text(f, "name"), value),
            None => format!("a {}", text(f, "name")),
        })
        .collect();
    said.join(" and ")
}

/// A document's tags in words — `status: Doing, priority: p1` — a value the
/// list doesn't have said so.
fn tags_of(row: &Value) -> Option<String> {
    let tags = row["tags"].as_array().filter(|t| !t.is_empty())?;
    let words: Vec<String> = tags
        .iter()
        .map(|t| {
            let odd = if t["known"].as_bool() == Some(false) { " (not one of its values)" } else { "" };
            format!("{}: {}{}", text(t, "name"), text(t, "value"), odd)
        })
        .collect();
    Some(words.join(", "))
}

/// How many times a command asks again while the domain reads documents
/// into its index — the first time in a large workspace takes a few rounds.
const INDEX_ROUNDS: usize = 200;

/// A GET that the domain answers `202` while its `index` catches up, asked
/// again until it answers — said once a command, on a terminal: `said` is
/// whether it has been.
fn indexed(s: &Session, ctx: &Ctx, route: &str, query: &[(&str, &str)], index: &str, said: &Cell<bool>) -> Result<Value, Failure> {
    for _ in 0..INDEX_ROUNDS {
        let reply = s.client.send("GET", route, query, &[], None)?;
        let v = reply.json()?;
        if reply.status != 202 {
            return Ok(v);
        }
        if !said.replace(true) && !ctx.json {
            eprintln!("Reading the workspace into its {} — this happens after documents change…", index);
        }
    }
    Err(Failure::other(format!("the {} is still being built — try again in a moment", index)))
}

/* ---------- Answers that come a page of sections at a time ---------- */

/// What the pages of one route's answer add up to.
///
/// A listing or a search across sections opens as many as one request can —
/// and everything shared is a section of its own — and answers `next` when
/// there are more: it is asked again with `after` set to that, until an
/// answer has none (`cursorOf`, cloud-worker/src/agentCall.ts). The pages are
/// then one answer: each list joined and put in one order, each count added
/// up, a flag any page raised kept, and the rest as the first page said it.
/// An answer that came whole is left exactly as it came.
struct Pages {
    /// Each list, and what its rows are in order by — "" for a list of names.
    lists: &'static [(&'static str, &'static str)],
    counts: &'static [&'static str],
    flags: &'static [&'static str],
}

/// `GET tree`: folders by name, documents by path.
const LISTING: Pages = Pages { lists: &[("folders", ""), ("documents", "path")], counts: &[], flags: &["tagsBehind"] };
/// `GET search`: documents by path, the named ones first.
const FOUND: Pages = Pages { lists: &[("results", "path"), ("notSearched", "")], counts: &["total"], flags: &["truncated"] };
/// `GET links`: the documents that link to one. What it links to is the same on every page.
const LINKED: Pages = Pages { lists: &[("to", "path")], counts: &[], flags: &[] };
/// `GET pages`: by address.
const PUBLIC: Pages = Pages { lists: &[("pages", "slug")], counts: &[], flags: &[] };

/// The cursor an answer carries when there are sections it did not reach,
/// taken out of it: the answer a command gives has none.
fn next_of(answer: &mut Value) -> Option<Value> {
    answer.as_object_mut()?.remove("next")
}

impl Pages {
    /// The whole answer to `query`: `ask` sends it, and is asked again for
    /// each page after the first.
    fn all(&self, query: &[(&str, &str)], ask: impl Fn(&[(&str, &str)]) -> Result<Value, Failure>) -> Result<Value, Failure> {
        let mut whole = ask(query)?;
        let mut next = next_of(&mut whole);
        let mut after = 0;
        let paged = next.is_some();
        while let Some(cursor) = next {
            // A cursor that does not move on would be asked for ever.
            after = cursor.as_u64().filter(|n| *n > after).ok_or_else(not_a_worker)?;
            let from = after.to_string();
            let mut asked = query.to_vec();
            asked.push(("after", from.as_str()));
            let mut page = ask(&asked)?;
            next = next_of(&mut page);
            self.join(&mut whole, page);
        }
        if paged {
            self.order(&mut whole);
        }
        Ok(whole)
    }

    /// Add a later page to the answer so far.
    fn join(&self, whole: &mut Value, page: Value) {
        let (Some(whole), Value::Object(mut page)) = (whole.as_object_mut(), page) else { return };
        for (list, _) in self.lists {
            let Some(Value::Array(more)) = page.remove(*list) else { continue };
            if let Value::Array(rows) = whole.entry(*list).or_insert_with(|| json!([])) {
                rows.extend(more);
            }
        }
        for count in self.counts {
            let sum = whole.get(*count).and_then(Value::as_u64).unwrap_or(0) + page.get(*count).and_then(Value::as_u64).unwrap_or(0);
            whole.insert(count.to_string(), json!(sum));
        }
        for flag in self.flags {
            if let Some(raised) = page.remove(*flag) {
                whole.insert(flag.to_string(), raised);
            }
        }
    }

    /// One order for the joined lists, as the domain orders a page: whatever
    /// the case, a search's named documents first — and a folder that two
    /// pages named, once.
    fn order(&self, whole: &mut Value) {
        for (list, by) in self.lists {
            let Some(Value::Array(rows)) = whole.get_mut(*list) else { continue };
            let key = |row: &Value| {
                let name = if by.is_empty() { row.as_str() } else { row.get(*by).and_then(Value::as_str) };
                (row.get("inName").is_none(), name.unwrap_or("").to_lowercase())
            };
            rows.sort_by_cached_key(key);
            if by.is_empty() {
                rows.dedup_by_key(|row| key(row));
            }
        }
    }
}

/// A listing's line for a document: its versions and tags — or, for one
/// shared right there, only that it is: a listing that is not deep does not
/// open what is shared, so `--deep` and `info` are what show its versions.
fn row_words(doc: &Value) -> String {
    if doc.get("shared").is_some() {
        return format!("{}  (shared)", text(doc, "path"));
    }
    let tags = tags_of(doc).map(|t| format!("  {}", t)).unwrap_or_default();
    format!("{}  {}{}", text(doc, "path"), versions_of(doc), tags)
}

pub fn ls(args: &Args, ctx: &Ctx) -> Result<(), Failure> {
    args.at_most(1)?;
    let wheres = wheres(args)?;
    let s = session(ctx)?;
    let dir = args.positionals.first().map(String::as_str).unwrap_or("");
    let mut query = vec![("dir", dir)];
    if args.has("deep") {
        query.push(("deep", "1"));
    }
    query.extend(wheres.iter().map(|w| ("where", w.as_str())));
    let said = Cell::new(false);
    let v = LISTING.all(&query, |q| {
        if wheres.is_empty() {
            s.client.send("GET", "tree", q, &[], None)?.json()
        } else {
            indexed(&s, ctx, "tree", q, "search index", &said)
        }
    })?;
    // A worker from before tags lists everything, and says nothing of them.
    if !wheres.is_empty() && v.get("where").is_none() {
        return Err(too_old(s.ws.domain()));
    }
    ctx.answer(&v, || {
        let mut lines = Vec::new();
        for folder in strings(&v["folders"]) {
            lines.push(format!("{}/", folder));
        }
        for doc in v["documents"].as_array().into_iter().flatten() {
            lines.push(row_words(doc));
        }
        if lines.is_empty() {
            lines.push(if wheres.is_empty() { "Nothing here yet.".to_string() } else { format!("No document here has {}.", where_words(&v)) });
        }
        if v.get("tagsBehind").is_some() {
            lines.push("Tags may be behind: Doklin's index hasn't read the latest changes yet. --where waits for it.".to_string());
        }
        lines.join("\n")
    });
    Ok(())
}

/// One version's line in `info`: its file, revision, size, and who changed it when.
fn version_line(label: &str, v: &Value) -> String {
    let who = v.get("byName").and_then(Value::as_str).or_else(|| v.get("by").and_then(Value::as_str));
    let when = v.get("changed").and_then(Value::as_u64).map(ago);
    let changed = match (when, who) {
        (Some(when), Some(who)) => format!(" · changed {} by {}", when, who),
        (Some(when), None) => format!(" · changed {}", when),
        (None, Some(who)) => format!(" · changed by {}", who),
        (None, None) => String::new(),
    };
    let file = v.get("file").and_then(Value::as_str).map(|f| format!("{}  ", f)).unwrap_or_default();
    format!("  {:<9} {}revision {} · {}{}", label, file, v["rev"], size(v["size"].as_u64().unwrap_or(0)), changed)
}

pub fn info(args: &Args, ctx: &Ctx) -> Result<(), Failure> {
    let path = args.need(0, "which document — doklin info <doc>")?;
    args.at_most(1)?;
    let s = session(ctx)?;
    let mut v = s.client.send("GET", "doc", &[("path", path), ("info", "1")], &[], None)?.json()?;
    // The domain names what a link to the document names; the link is written here.
    if let Some(row) = v.as_object_mut() {
        if let Some(to) = row.remove("linkTo") {
            let link = PageLink::new(s.ws.domain(), text(&to, "workspace"), text(&to, "space"), text(&to, "file"));
            row.insert("link".to_string(), Value::String(link.url()));
        }
    }
    ctx.answer(&v, || {
        let mut lines = vec![format!("{} — a document", text(&v, "path"))];
        if let Some(md) = v.get("md") {
            lines.push(version_line("markdown", md));
        }
        if let Some(html) = v.get("html") {
            let behind = if v.get("htmlBehind").is_some() { "   (made from an older text than the markdown)" } else { "" };
            lines.push(format!("{}{}", version_line("html", html), behind));
        }
        let threads = v["comments"].as_u64().unwrap_or(0) as usize;
        lines.push(format!("  {:<9} {}", "comments", if threads == 0 { "none".to_string() } else { plural(threads, "thread", "threads") }));
        if let Some(tags) = tags_of(&v) {
            lines.push(format!("  {:<9} {}", "tags", tags));
        }
        if let Some(link) = v.get("link").and_then(Value::as_str) {
            lines.push(format!("  {:<9} {}", "link", link));
        }
        let urls = strings(&v["public"]);
        lines.push(format!("  {:<9} {}", "public", if urls.is_empty() { "no".to_string() } else { urls.join(", ") }));
        lines.join("\n")
    });
    Ok(())
}

/// What a read answered about the content, from its headers.
fn read_meta(reply: &Reply) -> Value {
    let mut meta = json!({
        "kind": reply.header("x-doklin-kind").unwrap_or("document"),
        "path": reply.header("x-doklin-path").unwrap_or(""),
        "file": reply.header("x-doklin-file").unwrap_or(""),
        "rev": reply.header("x-doklin-rev").and_then(|r| r.parse::<u64>().ok()),
    });
    if let Some(version) = reply.header("x-doklin-version") {
        meta["version"] = json!(version);
    }
    if reply.header("x-doklin-html-behind").is_some() {
        meta["htmlBehind"] = json!(true);
    }
    meta
}

pub fn read(args: &Args, ctx: &Ctx) -> Result<(), Failure> {
    let path = args.need(0, "which document — doklin read <doc>")?;
    args.at_most(1)?;
    let version = version_flag(args)?;
    let s = session(ctx)?;
    let mut query = vec![("path", path)];
    if let Some(v) = version {
        query.push(("v", v));
    }
    if args.has("clean") {
        query.push(("clean", "1"));
    }
    let reply = s.client.send("GET", "doc", &query, &[], None)?;
    let meta = read_meta(&reply);

    // The content goes to stdout — or the file asked for — and what is known
    // about it to stderr, so `doklin read plan > plan.md` is exactly the text.
    match args.value("output") {
        Some(file) => std::fs::write(file, &reply.bytes).map_err(|e| Failure::other(format!("could not write {}: {}", file, e)))?,
        None => {
            let mut out = std::io::stdout().lock();
            out.write_all(&reply.bytes).and_then(|_| out.flush()).map_err(|e| Failure::other(format!("could not write the content: {}", e)))?;
        }
    }
    if ctx.json {
        eprintln!("{}", meta);
    } else {
        let what = match meta.get("version").and_then(Value::as_str) {
            Some(v) => format!("{} · {}", text(&meta, "path"), version_word(v)),
            None => text(&meta, "path").to_string(),
        };
        let behind = if meta.get("htmlBehind").is_some() { " · its html version is behind this text" } else { "" };
        eprintln!("{} · revision {}{}", what, meta["rev"], behind);
    }
    Ok(())
}

/* ---------- write, edit, mv, rm ---------- */

/// The new content: the file named, or what was piped in.
fn incoming(args: &Args) -> Result<Vec<u8>, Failure> {
    if let Some(file) = args.value("from") {
        return std::fs::read(file).map_err(|e| Failure::usage(format!("could not read {}: {}", file, e)));
    }
    let mut stdin = std::io::stdin();
    if stdin.is_terminal() {
        return Err(Failure::usage("pipe the new content in, or name a file with --from <file>"));
    }
    let mut bytes = Vec::new();
    stdin.read_to_end(&mut bytes).map_err(|e| Failure::other(format!("could not read what was piped in: {}", e)))?;
    Ok(bytes)
}

/// The sentence for what a write did, from the worker's answer.
fn wrote_words(v: &Value, dry: bool) -> String {
    let what = format!("the {} version of {}", version_word(text(v, "version")), text(v, "path"));
    if v.get("unchanged").is_some() {
        return format!("{} already says exactly that — nothing was written.", capitalize(&what));
    }
    let created = v["created"].as_bool().unwrap_or(false);
    let mut out = match (dry, created) {
        (true, true) => format!("Would create {}.", what),
        (true, false) => format!("Would replace {}, making it revision {}.", what, v["rev"]),
        (false, true) => format!("Created {} — revision {}.", what, v["rev"]),
        (false, false) => format!("Wrote {} — revision {}.", what, v["rev"]),
    };
    if v.get("htmlBehind").is_some() {
        out.push_str("\nIts html version is now behind: it was made from an older text. Rewrite it with --html, or remove it with `doklin rm --html`.");
    }
    out
}

fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// PUT new content. `if_rev` is the revision it replaces; without one the
/// worker refuses to replace anything unless `force`.
fn put_content(
    s: &Session,
    ctx: &Ctx,
    path: &str,
    version: Option<&str>,
    if_rev: Option<&str>,
    force: bool,
    bytes: &[u8],
) -> Result<Value, Failure> {
    let mut query = vec![("path", path)];
    if let Some(v) = version {
        query.push(("v", v));
    }
    if force {
        query.push(("force", "1"));
    }
    if ctx.dry_run {
        query.push(("dry", "1"));
    }
    let headers: Vec<(&str, &str)> = if_rev.map(|r| ("if-rev", r)).into_iter().collect();
    s.client.send("PUT", "doc", &query, &headers, Some(Body::Bytes(bytes)))?.json()
}

pub fn write(args: &Args, ctx: &Ctx) -> Result<(), Failure> {
    let path = args.need(0, "which document — doklin write <doc>")?;
    args.at_most(1)?;
    let version = version_flag(args)?;
    let if_rev = args.value("if-rev");
    if let Some(rev) = if_rev {
        if rev.is_empty() || !rev.bytes().all(|b| b.is_ascii_digit()) {
            return Err(Failure::usage("--if-rev takes the revision number that reading the document showed"));
        }
    }
    let bytes = incoming(args)?;
    let s = session(ctx)?;
    let v = put_content(&s, ctx, path, version, if_rev, args.has("force"), &bytes)?;
    ctx.answer(&v, || wrote_words(&v, ctx.dry_run));
    Ok(())
}

pub fn edit(args: &Args, ctx: &Ctx) -> Result<(), Failure> {
    let path = args.need(0, "which document — doklin edit <doc> --find \"…\" --replace \"…\"")?;
    args.at_most(1)?;
    let version = version_flag(args)?;
    let find = args.value("find").filter(|f| !f.is_empty()).ok_or_else(|| Failure::usage("say what to change with --find \"…\""))?;
    let replace = args.value("replace").ok_or_else(|| Failure::usage("say what to put there with --replace \"…\" (it may be empty)"))?;
    let s = session(ctx)?;

    // A read and a conditional write: the write names the revision that was
    // read, so a change made in between is refused rather than overwritten.
    let mut query = vec![("path", path)];
    if let Some(v) = version {
        query.push(("v", v));
    }
    let reply = s.client.send("GET", "doc", &query, &[], None)?;
    let meta = read_meta(&reply);
    let name = match meta.get("version").and_then(Value::as_str) {
        Some(v) => format!("the {} version of {}", version_word(v), text(&meta, "path")),
        None => text(&meta, "path").to_string(),
    };
    let before = String::from_utf8(reply.bytes).map_err(|_| Failure::usage(format!("{} is not text, so there is nothing to find in it", name)))?;
    let count = before.matches(find).count();
    if count == 0 {
        return Err(Failure::not_found(format!("\"{}\" does not occur in {} — quote it exactly as `doklin read` shows it", find, name)));
    }
    if count > 1 && !args.has("all") {
        return Err(Failure::conflict(format!(
            "\"{}\" occurs {} times in {} — quote more of it so that it occurs once, or pass --all to change every one",
            find, count, name
        )));
    }
    let after = before.replace(find, replace);
    let rev = meta["rev"].to_string();
    let v = put_content(&s, ctx, path, meta.get("version").and_then(Value::as_str), Some(&rev), false, after.as_bytes())?;
    ctx.answer(&v, || {
        let places = plural(count, "place", "places");
        if ctx.dry_run {
            format!("Would change {} in {}, making it revision {}.", places, name, v["rev"])
        } else {
            let tail = wrote_words(&v, false);
            // The first line of that says "Wrote …"; this command's own word is "changed".
            let rest = tail.split_once('\n').map(|(_, rest)| format!("\n{}", rest)).unwrap_or_default();
            format!("Changed {} in {} — revision {}.{}", places, name, v["rev"], rest)
        }
    });
    Ok(())
}

pub fn mv(args: &Args, ctx: &Ctx) -> Result<(), Failure> {
    let usage = "what to move and where — doklin mv <from> <to>";
    let from = args.need(0, usage)?;
    let to = args.need(1, usage)?;
    args.at_most(2)?;
    let s = session(ctx)?;
    let body = json!({ "from": from, "to": to, "dryRun": ctx.dry_run });
    let v = s.client.send("POST", "move", &[], &[], Some(Body::Json(&body)))?.json()?;
    ctx.answer(&v, || moved_words(&v, ctx.dry_run));
    Ok(())
}

/// The sentence for what a move did, from the worker's answer. Something
/// shared is said to be: it goes on being shared with the same people, and
/// its files stay in the section that is its own, so none are counted.
fn moved_words(v: &Value, dry: bool) -> String {
    let kind = if text(v, "kind") == "folder" { "folder" } else { "document" };
    let what = format!("the {}{} {}", if v.get("shared").is_some() { "shared " } else { "" }, kind, text(v, "from"));
    // Asked to move it to where it is.
    if !dry && v["moved"].as_bool() == Some(false) {
        return format!("{} is already there — nothing was moved.", capitalize(&what));
    }
    let files = match v.get("files").and_then(Value::as_u64) {
        Some(n) => format!(" ({})", plural(n as usize, "file", "files")),
        None => String::new(),
    };
    let mut out = format!("{} {} to {}{}.", if dry { "Would move" } else { "Moved" }, what, text(v, "to"), files);
    let unpublished = strings(&v["unpublished"]);
    if !unpublished.is_empty() {
        out.push_str(&format!(" It is no longer public at {} — publish it again.", list(&unpublished)));
    }
    out
}

pub fn rm(args: &Args, ctx: &Ctx) -> Result<(), Failure> {
    let path = args.need(0, "which document — doklin rm <doc>")?;
    args.at_most(1)?;
    let version = version_flag(args)?;
    let s = session(ctx)?;
    let mut query = vec![("path", path)];
    if let Some(v) = version {
        query.push(("v", v));
    }
    if ctx.dry_run {
        query.push(("dry", "1"));
    }
    let v = s.client.send("DELETE", "doc", &query, &[], None)?.json()?;
    ctx.answer(&v, || {
        let verb = if ctx.dry_run { "Would remove" } else { "Removed" };
        let mut out = if let Some(version) = version {
            format!("{} the {} version of {}.", verb, version_word(version), text(&v, "path"))
        } else {
            let versions: Vec<String> = strings(&v["versions"]).iter().map(|x| version_word(x).to_string()).collect();
            format!("{} the document {} ({}), and its comments.", verb, text(&v, "path"), list(&versions))
        };
        if let Some(n) = v.get("threadsRemoved").and_then(Value::as_u64) {
            out.push_str(&format!("\n{} on that version went with it.", capitalize(&plural(n as usize, "comment thread", "comment threads"))));
        }
        let still = strings(&v["stillPublic"]);
        if !still.is_empty() {
            out.push_str(&format!(
                "\nIt stays published at {} — the page answers 404 until the document is back. Stop with `doklin unpublish`.",
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

/* ---------- publish, unpublish, published ---------- */

pub fn publish(args: &Args, ctx: &Ctx) -> Result<(), Failure> {
    let path = args.need(0, "what to publish — doklin publish <doc or folder>")?;
    args.at_most(1)?;
    let s = session(ctx)?;
    let mut body = json!({ "path": path, "dryRun": ctx.dry_run });
    for key in ["slug", "title", "desc"] {
        if let Some(value) = args.value(key) {
            body[key] = json!(value);
        }
    }
    let v = s.client.send("PUT", "pages", &[], &[], Some(Body::Json(&body)))?.json()?;
    ctx.answer(&v, || {
        let docs = strings(&v["documents"]);
        let created = v["created"].as_bool().unwrap_or(false);
        let folder = text(&v, "kind") == "folder";
        let name = if folder {
            format!("the folder {}", text(&v, "path"))
        } else {
            text(&v, "path").to_string()
        };
        let mut out = match (ctx.dry_run, created) {
            (true, _) => format!("Would publish {} at {}", name, text(&v, "url")),
            (false, true) => format!("Published {} at {}", name, text(&v, "url")),
            (false, false) => format!("{} is published at {}", capitalize(&name), text(&v, "url")),
        };
        if folder {
            out.push_str(&format!(
                " — {} {} public:",
                plural(docs.len(), "document", "documents"),
                match (ctx.dry_run, docs.len() == 1) {
                    (true, _) => "would be",
                    (false, true) => "is",
                    (false, false) => "are",
                }
            ));
            for doc in docs.iter().take(40) {
                out.push_str(&format!("\n  {}", doc));
            }
            if docs.len() > 40 {
                out.push_str(&format!("\n  … and {} more", docs.len() - 40));
            }
        }
        out
    });
    Ok(())
}

pub fn unpublish(args: &Args, ctx: &Ctx) -> Result<(), Failure> {
    let target = args.need(0, "which page — doklin unpublish <doc, folder or address>")?;
    args.at_most(1)?;
    let s = session(ctx)?;
    let mut query = vec![(if args.has("slug") { "slug" } else { "path" }, target)];
    if ctx.dry_run {
        query.push(("dry", "1"));
    }
    let v = s.client.send("DELETE", "pages", &query, &[], None)?.json()?;
    ctx.answer(&v, || {
        let urls: Vec<String> = v["stopped"].as_array().into_iter().flatten().map(|p| text(p, "url").to_string()).collect();
        format!("{} {}.", if ctx.dry_run { "Would stop publishing" } else { "Stopped publishing" }, list(&urls))
    });
    Ok(())
}

pub fn published(args: &Args, ctx: &Ctx) -> Result<(), Failure> {
    args.at_most(0)?;
    let s = session(ctx)?;
    let v = PUBLIC.all(&[], |q| s.client.send("GET", "pages", q, &[], None)?.json())?;
    ctx.answer(&v, || {
        let pages = v["pages"].as_array().cloned().unwrap_or_default();
        if pages.is_empty() {
            return "Nothing this agent can see is public.".to_string();
        }
        pages
            .iter()
            .map(|p| {
                let what = match text(p, "kind") {
                    "folder" => format!("folder {}/", text(p, "path")),
                    _ => text(p, "path").to_string(),
                };
                let mut notes = Vec::new();
                if p.get("home").is_some() {
                    notes.push("the home page".to_string());
                }
                if p.get("missing").is_some() {
                    notes.push("its document is gone, so it answers 404".to_string());
                }
                if let Some(who) = p.get("byName").and_then(Value::as_str).or_else(|| p.get("by").and_then(Value::as_str)) {
                    notes.push(format!("published by {}", who));
                }
                let notes = if notes.is_empty() { String::new() } else { format!("  ({})", notes.join("; ")) };
                format!("{}  {}{}", text(p, "url"), what, notes)
            })
            .collect::<Vec<_>>()
            .join("\n")
    });
    Ok(())
}

/* ---------- comments ---------- */

pub fn comments(args: &Args, ctx: &Ctx) -> Result<(), Failure> {
    let path = args.need(0, "which document — doklin comments <doc>")?;
    args.at_most(1)?;
    let s = session(ctx)?;
    let v = s.client.send("GET", "comments", &[("path", path)], &[], None)?.json()?;
    ctx.answer(&v, || {
        let threads = v["threads"].as_array().cloned().unwrap_or_default();
        if threads.is_empty() {
            return format!("{} has no comments.", text(&v, "path"));
        }
        let mut lines = Vec::new();
        for t in &threads {
            let place = if text(t, "version") == "html" {
                format!("html, <{}>", text(t, "tag"))
            } else {
                match t.get("line").and_then(Value::as_u64) {
                    Some(line) => format!("markdown, line {}", line),
                    None => "markdown".to_string(),
                }
            };
            let on = if text(t, "on").is_empty() { String::new() } else { format!(" — on \"{}\"", text(t, "on")) };
            let orphaned = if t.get("orphaned").is_some() { "   (orphaned: the text it was on is gone)" } else { "" };
            lines.push(format!("#{}  {}{}{}", text(t, "id"), place, on, orphaned));
            for c in t["comments"].as_array().into_iter().flatten() {
                let author = if text(c, "author").is_empty() { "someone" } else { text(c, "author") };
                lines.push(format!("    {} · {}: {}", author, stamp(c["at"].as_u64().unwrap_or(0)), text(c, "body")));
            }
        }
        lines.join("\n")
    });
    Ok(())
}

/// The body of a comment: `-m`, and nothing else — a comment is a line.
fn message(args: &Args) -> Result<&str, Failure> {
    args.value("message").map(str::trim).filter(|m| !m.is_empty()).ok_or_else(|| Failure::usage("say the comment with -m \"…\""))
}

pub fn comment(args: &Args, ctx: &Ctx) -> Result<(), Failure> {
    // `doklin comment rm <doc> <thread>`.
    if args.positionals.first().map(String::as_str) == Some("rm") && args.value("on").is_none() {
        let usage = "which thread — doklin comment rm <doc> <thread>";
        let path = args.need(1, usage)?;
        let thread = args.need(2, usage)?;
        args.at_most(3)?;
        let s = session(ctx)?;
        let mut query = vec![("path", path), ("thread", thread)];
        if ctx.dry_run {
            query.push(("dry", "1"));
        }
        let v = s.client.send("DELETE", "comments", &query, &[], None)?.json()?;
        ctx.answer(&v, || {
            format!(
                "{} thread #{} from {}.",
                if ctx.dry_run { "Would remove" } else { "Removed" },
                text(&v, "thread"),
                text(&v, "path")
            )
        });
        return Ok(());
    }

    let path = args.need(0, "which document — doklin comment <doc> --on \"…\" -m \"…\"")?;
    args.at_most(1)?;
    let on = args.value("on").filter(|o| !o.trim().is_empty()).ok_or_else(|| {
        Failure::usage("say which words the comment is on with --on \"…\" — or answer a thread with `doklin reply`")
    })?;
    let said = message(args)?;
    let version = version_flag(args)?;
    let s = session(ctx)?;
    let mut body = json!({ "path": path, "on": on, "body": said, "dryRun": ctx.dry_run });
    if let Some(v) = version {
        body["v"] = json!(v);
    }
    let v = s.client.send("POST", "comments", &[], &[], Some(Body::Json(&body)))?.json()?;
    ctx.answer(&v, || {
        let place = if text(&v, "version") == "html" {
            format!("the <{}> that begins \"{}\"", text(&v, "tag"), text(&v, "on"))
        } else {
            format!("\"{}\", line {}", text(&v, "on"), v["line"])
        };
        format!(
            "{} thread #{} on {} in {}.",
            if ctx.dry_run { "Would start" } else { "Started" },
            text(&v, "thread"),
            place,
            text(&v, "path")
        )
    });
    Ok(())
}

pub fn reply(args: &Args, ctx: &Ctx) -> Result<(), Failure> {
    let usage = "which thread — doklin reply <doc> <thread> -m \"…\"";
    let path = args.need(0, usage)?;
    let thread = args.need(1, usage)?;
    args.at_most(2)?;
    let said = message(args)?;
    let s = session(ctx)?;
    let body = json!({ "path": path, "thread": thread, "body": said, "dryRun": ctx.dry_run });
    let v = s.client.send("POST", "comments", &[], &[], Some(Body::Json(&body)))?.json()?;
    ctx.answer(&v, || {
        format!(
            "{} thread #{} in {} — it has {} now.",
            if ctx.dry_run { "Would answer" } else { "Answered" },
            text(&v, "thread"),
            text(&v, "path"),
            plural(v["comments"].as_u64().unwrap_or(0) as usize, "comment", "comments")
        )
    });
    Ok(())
}

/* ---------- links ---------- */

pub fn links(args: &Args, ctx: &Ctx) -> Result<(), Failure> {
    let path = args.need(0, "which document — doklin links <doc>")?;
    args.at_most(1)?;
    let s = session(ctx)?;
    let mut query = vec![("path", path)];
    if args.has("from") {
        query.push(("from", "1"));
    }
    if args.has("to") {
        query.push(("to", "1"));
    }
    let said = Cell::new(false);
    let v = LINKED.all(&query, |q| indexed(&s, ctx, "links", q, "index of links", &said))?;

    ctx.answer(&v, || {
        let doc = text(&v, "path");
        let mut lines = Vec::new();
        if let Some(from) = v["from"].as_array() {
            if from.is_empty() {
                lines.push(format!("{} links to no other document.", doc));
            } else {
                lines.push(format!("{} links to:", doc));
                for l in from {
                    let to = if l.get("closed").is_some() { "can't be opened" } else { text(l, "path") };
                    lines.push(format!("  \"{}\" → {}", text(l, "words"), to));
                }
            }
        }
        if let Some(to) = v["to"].as_array() {
            if to.is_empty() {
                lines.push(format!("No document links to {}.", doc));
            } else {
                lines.push(format!("Linked from {}:", plural(to.len(), "document", "documents")));
                for l in to {
                    lines.push(format!("  {}", text(l, "path")));
                }
            }
        }
        lines.join("\n")
    });
    Ok(())
}

/* ---------- search ---------- */

pub fn search(args: &Args, ctx: &Ctx) -> Result<(), Failure> {
    let wheres = wheres(args)?;
    if args.positionals.is_empty() && wheres.is_empty() {
        return Err(Failure::usage("say what to search for — doklin search <text>, or --where <tag>=<value>"));
    }
    // `doklin search boat ships` means the phrase, quoted or not.
    let query_text = args.positionals.join(" ");
    let limit = args.value("limit");
    if limit.is_some_and(|n| n.parse::<u32>().map(|n| n == 0).unwrap_or(true)) {
        return Err(Failure::usage("--limit takes a number of documents"));
    }
    let s = session(ctx)?;
    let mut query = vec![("q", query_text.as_str())];
    if let Some(dir) = args.value("in") {
        query.push(("dir", dir));
    }
    if let Some(limit) = limit {
        query.push(("limit", limit));
    }
    query.extend(wheres.iter().map(|w| ("where", w.as_str())));
    let said = Cell::new(false);
    let v = FOUND.all(&query, |q| indexed(&s, ctx, "search", q, "search index", &said))?;
    // A worker from before tags searches the text alone, and says nothing of them.
    if !wheres.is_empty() && v.get("where").is_none() {
        return Err(too_old(s.ws.domain()));
    }

    ctx.answer(&v, || {
        let results = v["results"].as_array().cloned().unwrap_or_default();
        let mut lines = Vec::new();
        for r in &results {
            let html = if text(r, "version") == "html" { " (html)" } else { "" };
            // Where it was found, when no line shows it.
            let found = match (r.get("inName").is_some(), r.get("inComments").is_some()) {
                (true, true) => " — in its name and a comment (see `doklin comments`)",
                (false, true) => " — in a comment (see `doklin comments`)",
                (true, false) if r["matches"].as_array().is_none_or(|m| m.is_empty()) => " — in its name",
                _ => "",
            };
            lines.push(format!("{}{}{}", text(r, "path"), html, found));
            for m in r["matches"].as_array().into_iter().flatten() {
                match m.get("line").and_then(Value::as_u64) {
                    Some(line) => lines.push(format!("  {}: {}", line, text(m, "text"))),
                    None => lines.push(format!("  {}", text(m, "text"))),
                }
            }
            if let Some(more) = r.get("moreLines").and_then(Value::as_u64) {
                lines.push(format!("  … and {} more", plural(more as usize, "line", "lines")));
            }
        }
        let total = v["total"].as_u64().unwrap_or(0) as usize;
        lines.push(if total == 0 && query_text.is_empty() {
            format!("No document has {}.", where_words(&v))
        } else if total == 0 && !wheres.is_empty() {
            format!("Nothing with {} has \"{}\" in its name or its text.", where_words(&v), query_text)
        } else if total == 0 {
            format!("Nothing has \"{}\" in its name or its text.", query_text)
        } else if v.get("truncated").is_some() {
            // Not "the first": where much is shared, these are the first of each request's.
            format!(
                "{} match; {} of them are shown — narrow it with --in <folder>, or raise --limit.",
                plural(total, "document", "documents"),
                results.len()
            )
        } else {
            format!("{}.", plural(total, "document", "documents"))
        });
        let skipped = strings(&v["notSearched"]);
        if !skipped.is_empty() {
            lines.push(format!("Too large to search: {}.", skipped.join(", ")));
        }
        lines.join("\n")
    });
    Ok(())
}

/* ---------- tags ---------- */

pub fn tags(args: &Args, ctx: &Ctx) -> Result<(), Failure> {
    match args.positionals.first().map(String::as_str) {
        None => list_tags(ctx),
        Some("add") => add_tag(args, ctx),
        Some(word) => Err(Failure::usage(format!(
            "\"{}\" is not something tags does — doklin tags lists them, doklin tags add <tag> <value>… adds one",
            word
        ))),
    }
}

fn list_tags(ctx: &Ctx) -> Result<(), Failure> {
    let s = session(ctx)?;
    let v = s.client.send("GET", "tags", &[], &[], None)?.json()?;
    ctx.answer(&v, || {
        let tags = v["tags"].as_array().cloned().unwrap_or_default();
        if tags.is_empty() {
            return "This workspace has no tags yet. People make them in Doklin's Settings, and `doklin tags add <tag> <value>…` makes one — ask your person first.".to_string();
        }
        let width = tags.iter().map(|t| text(t, "name").chars().count()).max().unwrap_or(0);
        let mut lines = vec!["The tags:".to_string()];
        for t in &tags {
            lines.push(format!("  {:<width$}  {}", text(t, "name"), strings(&t["values"]).join(" · "), width = width));
            // What its values mean, under them.
            for line in text(t, "desc").lines() {
                lines.push(format!("  {:<width$}  {}", "", line, width = width).trim_end().to_string());
            }
        }
        lines.push("Set one with `doklin tag <doc> <tag>=<value>`; add a tag, or a value, with `doklin tags add <tag> <value>…`.".to_string());
        lines.join("\n")
    });
    Ok(())
}

/// `doklin tags add <tag> <value>…`: a new tag with those values, or the
/// values at the end of a tag the list has. Renaming and removing are the
/// app's.
fn add_tag(args: &Args, ctx: &Ctx) -> Result<(), Failure> {
    let usage = "which tag and which values — doklin tags add status Blocked";
    let name = args.need(1, usage)?;
    let values = &args.positionals[2..];
    if values.is_empty() {
        return Err(Failure::usage(format!("say {}", usage)));
    }
    let s = session(ctx)?;
    let body = json!({ "name": name, "values": values, "dryRun": ctx.dry_run });
    let v = s.client.send("POST", "tags", &[], &[], Some(Body::Json(&body)))?.json()?;
    ctx.answer(&v, || {
        let tag = &v["tag"];
        let all = strings(&tag["values"]).join(" · ");
        let name = text(tag, "name");
        if v.get("unchanged").is_some() {
            format!("{} has those already — {}. Nothing was written.", name, all)
        } else if ctx.dry_run && v.get("created").is_some() {
            format!("There would be a tag {}, taking {}.", name, all)
        } else if ctx.dry_run {
            format!("{} would take {}.", name, all)
        } else if v.get("created").is_some() {
            format!("Added the tag {}, taking {}.", name, all)
        } else {
            format!("{} now takes {}.", name, all)
        }
    });
    Ok(())
}

pub fn tag(args: &Args, ctx: &Ctx) -> Result<(), Failure> {
    let usage = "which document and which tags — doklin tag <doc> status=Done";
    let path = args.need(0, usage)?;
    if args.positionals.len() < 2 {
        return Err(Failure::usage(format!("say {}", usage)));
    }
    let mut set = serde_json::Map::new();
    for word in &args.positionals[1..] {
        let parsed = word.split_once('=').map(|(name, value)| (name.trim(), value.trim())).filter(|(name, _)| !name.is_empty());
        let Some((name, value)) = parsed else {
            return Err(Failure::usage(format!("\"{}\" is not a tag and its value — write status=Done, or status= to remove it", word)));
        };
        set.insert(name.to_string(), if value.is_empty() { Value::Null } else { json!(value) });
    }
    let s = session(ctx)?;
    let body = json!({ "path": path, "set": set, "dryRun": ctx.dry_run });
    let v = s.client.send("POST", "tag", &[], &[], Some(Body::Json(&body)))?.json()?;
    ctx.answer(&v, || {
        let now = tags_of(&v).unwrap_or_else(|| "no tags".to_string());
        if v.get("unchanged").is_some() {
            format!("{} already has {} — nothing was written.", text(&v, "path"), now)
        } else if ctx.dry_run {
            format!("{} would have {} — revision {}.", text(&v, "path"), now, v["rev"])
        } else {
            format!("{} now has {} — revision {}.", text(&v, "path"), now, v["rev"])
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::VecDeque;

    use super::*;

    /// A domain that answers one page after another, and keeps what it was asked.
    struct Scripted {
        pages: RefCell<VecDeque<Value>>,
        asked: RefCell<Vec<String>>,
    }

    impl Scripted {
        fn new(pages: &[Value]) -> Scripted {
            Scripted { pages: RefCell::new(pages.iter().cloned().collect()), asked: RefCell::new(Vec::new()) }
        }

        fn ask(&self, query: &[(&str, &str)]) -> Result<Value, Failure> {
            self.asked.borrow_mut().push(query.iter().map(|(k, v)| format!("{}={}", k, v)).collect::<Vec<_>>().join("&"));
            Ok(self.pages.borrow_mut().pop_front().expect("asked for a page the domain never promised"))
        }
    }

    #[test]
    fn an_answer_that_came_whole_is_left_as_it_came() {
        let whole = json!({ "dir": "Library", "folders": ["Library/b", "Library/A"], "documents": [{ "path": "Library/z" }, { "path": "Library/a" }] });
        let domain = Scripted::new(std::slice::from_ref(&whole));
        assert_eq!(LISTING.all(&[("dir", "Library")], |q| domain.ask(q)).unwrap(), whole);
        assert_eq!(*domain.asked.borrow(), ["dir=Library"]);
    }

    #[test]
    fn a_listing_is_asked_for_page_after_page_and_joined_into_one() {
        let domain = Scripted::new(&[
            json!({
                "dir": "",
                "folders": ["Library", "My files", "Shared with me", "My files/work"],
                "documents": [{ "path": "Library/Home", "md": { "rev": 1 } }, { "path": "My files/work/plan", "md": { "rev": 2 } }],
                "next": 9
            }),
            json!({ "dir": "", "folders": ["Library", "My files", "Shared with me"], "documents": [{ "path": "My files/Budget", "md": { "rev": 1 } }], "tagsBehind": true, "next": 18 }),
            json!({ "dir": "", "folders": ["library", "Shared with me/Deals"], "documents": [{ "path": "Shared with me/Deals/q3", "html": { "rev": 4 } }] }),
        ]);
        let v = LISTING.all(&[("dir", ""), ("deep", "1")], |q| domain.ask(q)).unwrap();
        assert_eq!(*domain.asked.borrow(), ["dir=&deep=1", "dir=&deep=1&after=9", "dir=&deep=1&after=18"]);
        assert_eq!(
            v,
            json!({
                "dir": "",
                // Each once, however many pages named it, spelled as the first did.
                "folders": ["Library", "My files", "My files/work", "Shared with me", "Shared with me/Deals"],
                "documents": [
                    { "path": "Library/Home", "md": { "rev": 1 } },
                    { "path": "My files/Budget", "md": { "rev": 1 } },
                    { "path": "My files/work/plan", "md": { "rev": 2 } },
                    { "path": "Shared with me/Deals/q3", "html": { "rev": 4 } }
                ],
                "tagsBehind": true
            }),
            "one listing, in one order, with no cursor left in it"
        );
    }

    #[test]
    fn a_search_adds_its_pages_up_and_keeps_the_named_documents_first() {
        let hit = |path: &str| json!({ "path": path, "version": "md", "matches": [{ "line": 1, "text": "boat" }] });
        let named = json!({ "path": "Shared with me/Boat", "version": "md", "matches": [], "inName": true });
        let domain = Scripted::new(&[
            json!({ "query": "boat", "dir": "", "where": [{ "name": "status", "value": null }], "results": [hit("My files/b"), hit("Library/a")], "total": 7, "truncated": true, "next": 9 }),
            json!({ "query": "boat", "dir": "", "where": [{ "name": "status", "value": null }], "results": [named.clone(), hit("My files/a")], "total": 2, "notSearched": ["Shared with me/Atlas"] }),
        ]);
        let v = FOUND.all(&[("q", "boat"), ("limit", "2")], |q| domain.ask(q)).unwrap();
        assert_eq!(*domain.asked.borrow(), ["q=boat&limit=2", "q=boat&limit=2&after=9"]);
        assert_eq!(
            v,
            json!({
                "query": "boat",
                "dir": "",
                "where": [{ "name": "status", "value": null }],
                "results": [named, hit("Library/a"), hit("My files/a"), hit("My files/b")],
                "total": 9,
                "truncated": true,
                "notSearched": ["Shared with me/Atlas"]
            })
        );
    }

    #[test]
    fn what_a_document_links_to_is_said_once_and_its_linkers_and_the_pages_are_joined() {
        let from = json!([{ "words": "c", "path": "Library/c" }]);
        let domain = Scripted::new(&[
            json!({ "path": "Library/a", "to": [{ "path": "My files/z" }], "from": from, "next": 9 }),
            json!({ "path": "Library/a", "to": [{ "path": "Library/b" }], "from": from }),
        ]);
        let v = LINKED.all(&[("path", "Library/a")], |q| domain.ask(q)).unwrap();
        assert_eq!(v, json!({ "path": "Library/a", "to": [{ "path": "Library/b" }, { "path": "My files/z" }], "from": from }));

        let page = |slug: &str| json!({ "slug": slug, "url": format!("https://notes.example.com/{}", slug), "kind": "document", "path": "Library/Zed" });
        let domain = Scripted::new(&[json!({ "pages": [page("plan")], "next": 9 }), json!({ "pages": [page("home")] })]);
        let v = PUBLIC.all(&[], |q| domain.ask(q)).unwrap();
        assert_eq!(*domain.asked.borrow(), ["", "after=9"]);
        assert_eq!(v, json!({ "pages": [page("home"), page("plan")] }), "by address, as the domain orders a page");
    }

    #[test]
    fn a_cursor_that_leads_nowhere_is_refused_rather_than_followed_for_ever() {
        for stuck in [json!(0), json!("9"), json!(-3), json!(null)] {
            let domain = Scripted::new(&[json!({ "pages": [], "next": stuck })]);
            let failure = PUBLIC.all(&[], |q| domain.ask(q)).unwrap_err();
            assert_eq!((failure.exit, failure.message.as_str()), (1, "the domain's answer was not what a Doklin worker sends"), "{}", stuck);
            assert_eq!(domain.asked.borrow().len(), 1, "nothing more was asked");
        }
        // The same cursor twice is as stuck as none.
        let domain = Scripted::new(&[json!({ "pages": [], "next": 9 }), json!({ "pages": [], "next": 9 })]);
        assert_eq!(PUBLIC.all(&[], |q| domain.ask(q)).unwrap_err().exit, 1);
        assert_eq!(*domain.asked.borrow(), ["", "after=9"]);
    }

    #[test]
    fn a_shared_document_is_listed_as_shared_and_any_other_with_its_versions_and_tags() {
        assert_eq!(row_words(&json!({ "path": "Shared with me/Forecast", "shared": true })), "Shared with me/Forecast  (shared)");
        let row = json!({ "path": "My files/plan", "md": { "rev": 1 }, "html": { "rev": 1 }, "htmlBehind": true, "tags": [{ "name": "status", "value": "Doing", "known": true }] });
        assert_eq!(row_words(&row), "My files/plan  [md · html, html is behind]  status: Doing");
    }

    #[test]
    fn a_move_says_what_moved_and_that_something_shared_is() {
        let plain = json!({ "kind": "document", "from": "Library/a", "to": "My files/a", "files": 3, "unpublished": ["https://notes.example.com/a"] });
        assert_eq!(
            moved_words(&plain, false),
            "Moved the document Library/a to My files/a (3 files). It is no longer public at https://notes.example.com/a — publish it again."
        );
        let folder = json!({ "kind": "folder", "from": "Library/old", "to": "Library/new", "files": 1, "moved": false });
        assert_eq!(moved_words(&folder, true), "Would move the folder Library/old to Library/new (1 file).");
        let shared = json!({ "kind": "folder", "from": "My files/Deals", "to": "My files/attic/Deals 2026", "shared": true });
        assert_eq!(moved_words(&shared, false), "Moved the shared folder My files/Deals to My files/attic/Deals 2026.");
        let dry = json!({ "kind": "document", "from": "Shared with me/Forecast", "to": "Shared with me/Outlook", "shared": true, "moved": false });
        assert_eq!(moved_words(&dry, true), "Would move the shared document Shared with me/Forecast to Shared with me/Outlook.");
        let nowhere = json!({ "kind": "document", "from": "Shared with me/Outlook", "to": "Shared with me/Outlook", "files": 0, "moved": false });
        assert_eq!(moved_words(&nowhere, false), "The document Shared with me/Outlook is already there — nothing was moved.");
    }
}
