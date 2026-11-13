//! What each command does: one or two requests to the document API, and
//! then either the worker's answer as JSON or a sentence about it.
//!
//! Nothing here knows Doklin's rules — which files make a document, where a
//! comment's marker goes, what a public page is. Those run in the worker, so
//! that this program stays a thin way of asking (docs/cloud.md §8.6).

use std::io::{IsTerminal, Read, Write};

use serde_json::{json, Value};

use crate::args::Args;
use crate::creds::{self, Workspace};
use crate::http::{Body, Client, Reply};
use crate::text::{ago, list, plural, size, stamp, version_word};
use crate::Failure;

/// What every command is told about the line it was run from.
pub struct Ctx {
    /// Answer in JSON: asked for, or stdout is not a terminal.
    pub json: bool,
    pub dry_run: bool,
    /// `-w <domain>`.
    pub workspace: Option<String>,
}

impl Ctx {
    /// The worker's answer as it came, or the sentence a person reads.
    fn answer(&self, v: &Value, words: impl FnOnce() -> String) {
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

/// The workspace this command means and a client for it — after making sure
/// its worker can do what the command needs. What the worker could do is
/// remembered from the last time it was asked, and asked again only when
/// something is not on the list.
fn session(ctx: &Ctx, feature: &str) -> Result<Session, Failure> {
    let mut all = creds::load()?;
    let ws = creds::pick(&all, ctx.workspace.as_deref())?.clone();
    let client = Client::new(&ws.endpoint, Some(&ws.token));
    if ws.features.iter().any(|f| f == feature) {
        return Ok(Session { client, ws });
    }
    let me = client.send("GET", "me", &[], &[], None)?.json()?;
    let features = strings(&me["features"]);
    if let Some(entry) = all.workspaces.iter_mut().find(|w| w.endpoint == ws.endpoint) {
        entry.features = features.clone();
        creds::save(&all)?;
    }
    if !features.iter().any(|f| f == feature) {
        return Err(Failure::too_old(format!(
            "the worker on {} is too old for this command — the workspace's owner can update it from Doklin's Cloud panel",
            ws.domain()
        )));
    }
    Ok(Session { client, ws: Workspace { features, ..ws } })
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
    let with_scheme = if raw.contains("://") { raw.to_string() } else { format!("https://{}", raw) };
    let host = creds::domain_of(&with_scheme);
    if host.is_empty() || host.contains(char::is_whitespace) || !(with_scheme.starts_with("https://") || with_scheme.starts_with("http://")) {
        return Err(Failure::usage(format!(
            "\"{}\" is not a workspace's address — it looks like notes.example.com",
            raw
        )));
    }
    let scheme = if with_scheme.starts_with("http://") { "http" } else { "https" };
    Ok(format!("{}://{}", scheme, host.to_ascii_lowercase()))
}

pub fn login(args: &Args, ctx: &Ctx) -> Result<(), Failure> {
    let usage = "the whole line the workspace's owner gave you — doklin login <domain> <code>";
    let endpoint = normalize_endpoint(args.need(0, usage)?)?;
    let code = args.need(1, usage)?;
    args.at_most(2)?;
    let domain = creds::domain_of(&endpoint).to_string();

    let host = gethostname::gethostname().to_string_lossy().to_string();
    let reply = Client::new(&endpoint, None)
        .send("POST", "login", &[], &[], Some(Body::Json(&json!({ "code": code, "host": host }))))
        .map_err(|f| match f.status {
            // No bearer was sent, so the gate's bare word can only mean the
            // route above the gate is not there: a worker from before agents.
            Some(401) if f.message == "unauthorized" => Failure::too_old(format!(
                "the worker on {} is too old for agents — the workspace's owner can update it from Doklin's Cloud panel",
                domain
            )),
            _ => f,
        })?;
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
        features: strings(&v["features"]),
    });
    creds::save(&all)?;
    // The login this one replaces is no use to anybody now: let it go, so
    // the owner's list shows one machine and not two. Best effort.
    if let Some(old) = before {
        let _ = Client::new(&endpoint, Some(&old)).send("DELETE", "login", &[], &[], None);
    }

    // Never the token: it is in the credentials file and nowhere else.
    let shown = json!({ "workspace": v["workspace"], "agent": v["agent"], "scopes": v["scopes"], "endpoint": endpoint });
    ctx.answer(&shown, || {
        format!(
            "Logged in to {} ({}) as {}. It may {}.\nRun `doklin help agent` for what to do next.",
            text(&v["workspace"], "name"),
            domain,
            text(&v["agent"], "name"),
            may(&strings(&v["scopes"]))
        )
    });
    Ok(())
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
    let s = session(ctx, "agents")?;
    let v = s.client.send("GET", "me", &[], &[], None)?.json()?;
    ctx.answer(&v, || {
        format!(
            "{} on {} ({})\nIt may {}.\nWorker version {}.",
            text(&v["agent"], "name"),
            text(&v["workspace"], "name"),
            s.ws.domain(),
            may(&strings(&v["scopes"])),
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

fn public_of(row: &Value) -> String {
    let urls = strings(&row["public"]);
    if urls.is_empty() {
        String::new()
    } else {
        format!("  public: {}", urls.join(", "))
    }
}

pub fn ls(args: &Args, ctx: &Ctx) -> Result<(), Failure> {
    args.at_most(1)?;
    let s = session(ctx, "agent-docs")?;
    let dir = args.positionals.first().map(String::as_str).unwrap_or("");
    let mut query = vec![("dir", dir)];
    if args.has("deep") {
        query.push(("deep", "1"));
    }
    let v = s.client.send("GET", "tree", &query, &[], None)?.json()?;
    ctx.answer(&v, || {
        let mut lines = Vec::new();
        for folder in strings(&v["folders"]) {
            lines.push(format!("{}/", folder));
        }
        for doc in v["documents"].as_array().into_iter().flatten() {
            lines.push(format!("{}  {}{}", text(doc, "path"), versions_of(doc), public_of(doc)));
        }
        for file in v["files"].as_array().into_iter().flatten() {
            lines.push(format!("{}  (file, {}){}", text(file, "path"), size(file["size"].as_u64().unwrap_or(0)), public_of(file)));
        }
        if lines.is_empty() {
            "Nothing here yet.".to_string()
        } else {
            lines.join("\n")
        }
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
    let s = session(ctx, "agent-docs")?;
    let v = s.client.send("GET", "doc", &[("path", path), ("info", "1")], &[], None)?.json()?;
    ctx.answer(&v, || {
        let mut lines = Vec::new();
        if text(&v, "kind") == "file" {
            lines.push(format!("{} — a plain file", text(&v, "path")));
            lines.push(version_line("content", &v));
        } else {
            lines.push(format!("{} — a document", text(&v, "path")));
            if let Some(md) = v.get("md") {
                lines.push(version_line("markdown", md));
            }
            if let Some(html) = v.get("html") {
                let behind = if v.get("htmlBehind").is_some() { "   (made from an older text than the markdown)" } else { "" };
                lines.push(format!("{}{}", version_line("html", html), behind));
            }
            let threads = v["comments"].as_u64().unwrap_or(0) as usize;
            lines.push(format!("  {:<9} {}", "comments", if threads == 0 { "none".to_string() } else { plural(threads, "thread", "threads") }));
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
        "kind": reply.header("x-doklin-kind").unwrap_or("file"),
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
    let s = session(ctx, "agent-docs")?;
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
    let what = if text(v, "kind") == "file" {
        text(v, "path").to_string()
    } else {
        format!("the {} version of {}", version_word(text(v, "version")), text(v, "path"))
    };
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
    for id in strings(&v["orphaned"]) {
        out.push_str(&format!("\nThread #{} lost the words it was on — it is kept, with no place in the text.", id));
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
    let s = session(ctx, "agent-docs")?;
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
    let s = session(ctx, "agent-docs")?;

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
    let s = session(ctx, "agent-docs")?;
    let body = json!({ "from": from, "to": to, "dryRun": ctx.dry_run });
    let v = s.client.send("POST", "move", &[], &[], Some(Body::Json(&body)))?.json()?;
    ctx.answer(&v, || {
        let kind = match text(&v, "kind") {
            "folder" => "the folder",
            "file" => "the file",
            _ => "the document",
        };
        format!(
            "{} {} {} to {} ({}).",
            if ctx.dry_run { "Would move" } else { "Moved" },
            kind,
            text(&v, "from"),
            text(&v, "to"),
            plural(v["files"].as_u64().unwrap_or(0) as usize, "file", "files")
        )
    });
    Ok(())
}

pub fn rm(args: &Args, ctx: &Ctx) -> Result<(), Failure> {
    let path = args.need(0, "which document — doklin rm <doc>")?;
    args.at_most(1)?;
    let version = version_flag(args)?;
    let s = session(ctx, "agent-docs")?;
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
        let mut out = if text(&v, "kind") == "file" {
            format!("{} the file {}.", verb, text(&v, "path"))
        } else if version.is_some() {
            format!("{} the {} version of {}.", verb, version_word(version.unwrap_or("md")), text(&v, "path"))
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
    let s = session(ctx, "agent-pages")?;
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
            if text(&v, "path").is_empty() { "the whole workspace".to_string() } else { format!("the folder {}", text(&v, "path")) }
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
    let s = session(ctx, "agent-pages")?;
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
    let s = session(ctx, "agent-pages")?;
    let v = s.client.send("GET", "pages", &[], &[], None)?.json()?;
    ctx.answer(&v, || {
        let pages = v["pages"].as_array().cloned().unwrap_or_default();
        if pages.is_empty() {
            return "Nothing in this workspace is public.".to_string();
        }
        pages
            .iter()
            .map(|p| {
                let what = match text(p, "kind") {
                    "folder" if text(p, "path").is_empty() => "the whole workspace".to_string(),
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
    let s = session(ctx, "agent-comments")?;
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
        let s = session(ctx, "agent-comments")?;
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
    let s = session(ctx, "agent-comments")?;
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
    let s = session(ctx, "agent-comments")?;
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

/* ---------- search ---------- */

/// How many times a search asks again while the domain reads documents into
/// its index — the first search of a large workspace takes a few rounds.
const SEARCH_ROUNDS: usize = 200;

pub fn search(args: &Args, ctx: &Ctx) -> Result<(), Failure> {
    if args.positionals.is_empty() {
        return Err(Failure::usage("say what to search for — doklin search <text>"));
    }
    // `doklin search boat ships` means the phrase, quoted or not.
    let query_text = args.positionals.join(" ");
    let s = session(ctx, "agent-search")?;
    let mut query = vec![("q", query_text.as_str())];
    if let Some(dir) = args.value("in") {
        query.push(("dir", dir));
    }
    if let Some(limit) = args.value("limit") {
        if limit.parse::<u32>().map(|n| n == 0).unwrap_or(true) {
            return Err(Failure::usage("--limit takes a number of documents"));
        }
        query.push(("limit", limit));
    }

    let mut v = Value::Null;
    for round in 0..SEARCH_ROUNDS {
        let reply = s.client.send("GET", "search", &query, &[], None)?;
        v = reply.json()?;
        if reply.status != 202 {
            break;
        }
        if round == 0 && !ctx.json {
            eprintln!("Reading the workspace into its search index — this happens after documents change…");
        }
        if round + 1 == SEARCH_ROUNDS {
            return Err(Failure::other("the search index is still being built — try again in a moment"));
        }
    }

    ctx.answer(&v, || {
        let results = v["results"].as_array().cloned().unwrap_or_default();
        let mut lines = Vec::new();
        for r in &results {
            let html = if text(r, "version") == "html" { " (html)" } else { "" };
            let comments = if r.get("inComments").is_some() { " — in a comment (see `doklin comments`)" } else { "" };
            lines.push(format!("{}{}{}", text(r, "path"), html, comments));
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
        lines.push(if total == 0 {
            format!("Nothing contains \"{}\".", query_text)
        } else if v.get("truncated").is_some() {
            format!(
                "{} contain it; these are the first {} — narrow it with --in <folder>, or raise --limit.",
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
