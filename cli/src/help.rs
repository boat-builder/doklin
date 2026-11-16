//! Help — where the concepts live. The commands are few and plain; what a
//! reader needs is what a *document* is here, how a comment attaches to
//! text, and what public means. An agent reads `doklin help agent` once and
//! knows how to behave in a workspace it has never seen.

use crate::{Command, Failure, COMMANDS};

const OVERVIEW: &str = r#"doklin — work with a Doklin workspace from anywhere

A workspace is a folder of documents that lives on people's Macs and syncs through
a domain of their own. Doklin syncs markdown and html documents; any other file in
the folder stays on the device it is on. This program reads and changes the
workspace through that domain. Nothing is copied to this machine.

You work as one person's agent, and see what they see. A path says where a thing is:
  Private/…                    only your person sees it
  Restricted/<folder>/…        only the people in that folder
  anything else                shared with everyone in the workspace

Wherever a command takes a document, it also takes a link to one, as people copy it
in the app (https://doklin.cc/open#…); the command then runs in that link's workspace.

Getting in
  login <domain> <code>        log this machine in, with the line you were given
                               (on a Mac where Doklin is connected: Doklin → Install Command Line Tool)
  logout                       log this machine out
  whoami                       which workspace and agent this is, whose, and what it may do

Reading
  ls [folder] [--deep]         what a folder holds
  info <doc>                   a document's versions, comments and public addresses
  read <doc>                   a document's text              [--md|--html] [--clean] [-o file]
  search <text>                documents by name or text      [--in folder] [--limit n]
  comments <doc>               the comment threads on a document
  published                    everything that is public

Changing
  write <doc>                  create or replace a document   [--md|--html] [--if-rev n|--force] [--from file]
  edit <doc>                   change part of a document      --find "…" --replace "…" [--all]
  mv <from> <to>               move or rename a document or a folder
  rm <doc>                     remove a document, or one version of it   [--md|--html]
  comment <doc>                start a comment thread         --on "…" -m "…"
  reply <doc> <thread>         answer a thread                -m "…"
  comment rm <doc> <thread>    remove a thread
  publish <doc or folder>      make it public                 [--slug s] [--title t] [--desc d]
  unpublish <doc, folder or address>

This Mac
  open [path or link…]         open files, folders or links here in the Doklin app; no login

Everywhere
  -w <domain>     which workspace, when this machine is logged in to several
  --json          answer in JSON (already the case when the output is not a terminal)
  --dry-run       say what a change would do, without doing it

More
  doklin help documents        one document, two versions: markdown and html
  doklin help comments         how a comment attaches to text
  doklin help publishing       what public means
  doklin help sections         Private, Restricted and what is shared
  doklin help drawings         diagrams: how to draw one that reads well
  doklin help agent            a short brief for an AI agent using this
  doklin help <command>

Exit codes: 0 done · 2 bad usage · 3 not found · 4 not permitted · 5 conflict ·
6 not logged in · 7 the workspace's worker is too old for the command ·
8 the domain asked to slow down, or today's Cloudflare requests are used up"#;

const DOCUMENTS: &str = r#"DOCUMENTS

A document is named by its path, without an extension: Projects/plan

One document can have two versions.

  markdown   The source. People write and review it in the Doklin app.
  html       An optional designed page, usually made from the markdown. When the
             document is public and has one, visitors see it first.

They are one document: one name, one set of comments, one public address. `ls`
shows which versions a document has, and --md or --html picks one.

  doklin read Projects/plan            the markdown (the html, when that is all there is)
  doklin read Projects/plan --html     the html version
  doklin write Projects/plan --html    create or replace the html version

Keep the two in step. Changing the markdown does not change the html, which goes on
saying what the old text said. Doklin tells you when that has happened: `ls` and
`info` show "html is behind", and so does the answer to a markdown write. Then
either write the html again from the new markdown, or remove it:

  doklin rm Projects/plan --html

A document may have only an html version. Everything works on it, with one
exception: `write` with no flag is refused, so that markdown text never replaces an
html page by accident. Say --html to replace the page, or --md to add a markdown
version beside it.

Replacing needs the revision you read. `read` shows a document's revision; hand it
back with `write --if-rev <n>`. If somebody changed the document in between, the
write is refused and nothing is lost — read it again. `edit` does this for you.
--force replaces whatever is there.

Doklin syncs markdown and html documents, nothing else. Any other file in a person's
folder stays on their device: it is not part of the workspace, and a path to one is
refused.

`mv` and `rm` act on the whole document — both versions and its comments —
whatever extension you type. `rm --md` or `rm --html` removes one version, and
never the last one."#;

const COMMENTS: &str = r#"COMMENTS

A comment thread sits on some text of a document.

  doklin comments Projects/plan
  doklin comment Projects/plan --on "ships in June" -m "Is that still true?"
  doklin reply Projects/plan c7k2x9 -m "Yes."
  doklin comment rm Projects/plan c7k2x9

--on says which words the thread is on.

  In markdown   They must occur exactly once, in ordinary text — not in code, a
                link's address or another comment — and be plain words, with no
                formatting marks. If they occur more than once, quote more of the
                sentence; the refusal lists every place.
  In html       (--html) They are the opening words of one element: a heading, a
                paragraph, a list item.

In markdown, a thread's place is marked in the text itself:

  The boat {==ships in June==}{>>#c7k2x9<<} if the paint dries.

`read` shows these markers. A write must keep each one exactly as it is; it may
move with its words. A write that removes, changes or adds one is refused: start a
thread with `doklin comment`, remove one with `doklin comment rm`. In html, a write
that takes away the element a thread is on is refused the same way.

`read --clean` gives the text without markers, to read or to make an html version
from. Written back over the markdown, it is refused."#;

const PUBLISHING: &str = r#"PUBLISHING

Publishing gives a document a public address on the workspace's domain. Anyone who
has the address can read it. There is no login.

  doklin publish Projects/plan                prints the address
  doklin publish Projects/plan --slug plan    choose the last part of the address
  doklin publish Projects/                    a folder: every document in it
  doklin publish Projects/ --dry-run          list what that would make public
  doklin published                            everything that is public now
  doklin unpublish Projects/plan              stop

The page is the document, live: a change shows on the page as soon as it is made.
A document with an html version shows that first, with a switch to the markdown.
Comments are never shown.

Publishing a folder publishes everything in it, and whatever is added to it later.
Look at --dry-run before you do it.

Removing a document does not unpublish it. Its address answers "not found" until
the document is back, and then shows it again. Stop publishing with `unpublish`.

This machine can publish only if its person allowed it: `doklin whoami` says what
it may do. Publishing does not change who can open the document in the workspace:
a page from Private/ is public, and its document is still only your person's."#;

const SECTIONS: &str = r#"SECTIONS

A workspace has three kinds of place, and a path says which one a thing is in.

  Private/…                 Your person's own. Nobody else in the workspace sees it.
  Restricted/<folder>/…     A restricted folder: only the people in it. `doklin ls
                            Restricted` lists the ones your person is in.
  anything else             Shared: everyone in the workspace sees and edits it.

You are one person's agent and see exactly what they see. If they are added to a
folder you can work in it from your next command; if they are taken out, it is gone
for you too. A folder they are not in does not exist as far as you can tell.

Put new work under Private/ unless your person says where it goes:

  doklin write Private/drafts/summary < summary.md

Moving a thing changes who can see it, so do it only when asked:

  doklin mv Private/drafts/summary Projects/        now everyone sees it
  doklin mv Projects/summary Restricted/Finance/    now only that folder's people

`doklin ls` and `doklin search` with no folder cover everything you can see;
`doklin ls Private` or `doklin search "…" --in Restricted/Finance` only that place.
You cannot make a restricted folder or change who is in one — people do that in the
Doklin app. `Private` and `Restricted` themselves are not folders to move or rename."#;

const DRAWINGS: &str = r##"DRAWINGS

A diagram in a document is a drawing: a ```svg block of hand-placed SVG. The app
and a public page show it as a picture, not as code, at the full width of the
text, in the reader's theme. There is no layout engine — you place every box —
so a drawing looks as good as the rules below are kept.

    ```svg
    <svg viewBox="0 0 760 136" role="img" aria-label="…the title…">
    …
    </svg>
    ```

The frame
  · viewBox="0 0 760 H". Keep 24 clear on every side: content runs from x 24 to
    736. The frame is scaled to the text column (about 0.9), so draw at 760.
  · role="img" and an aria-label that repeats the title.
  · The first text is the title, top left at x 24, y 34: 15, weight 600. It says
    the finding ("Only a green build reaches production"), not the topic.

Colour: tokens only, never a hex value, so the drawing follows light, dark and
paper with no change.
  var(--dg-ink)       names and words           var(--dg-ink-2)  quiet words, lane labels
  var(--dg-rule)      borders, connectors       var(--dg-grid)   quiet rules inside boxes
  var(--dg-accent)    the one emphasised thing  var(--dg-tint)   a reference band
  var(--dg-good) var(--dg-warn) var(--dg-bad)   a stated status
  var(--dg-cat-1) … var(--dg-cat-8)             more hues, only when categories need them

Text
  · Three sizes: 15 the title, 13 names and words, 11.5 quiet lines. Names 600.
  · Every <text> sets fill. Centre a label with text-anchor="middle" at the box's
    centre x.
  · 13px text is about 7 wide per character, 11.5px about 6.

Boxes
  · <rect rx="8" fill="none" stroke="var(--dg-rule)" stroke-width="1.25"/>. No fill.
  · Width: the longest line plus 24. Height: 40 for a name alone, plus 16 for each
    line under it. The name's baseline is the top plus 24; each line under it, 16
    lower.
  · Everything on steps of 8, at least 16 between boxes, 40 where a connector runs
    between them.
  · Exactly one box may stand out: stroke="var(--dg-accent)" stroke-width="2"
    fill="var(--dg-accent)" fill-opacity="0.12".
  · A lane or group: its name at the top in 11.5, weight 600, var(--dg-ink-2); it
    takes 32 for that line, and what it holds sits 16 in.

Connectors
  · <line> or <path> with stroke="var(--dg-rule)" stroke-width="1.25" and an arrow:
      <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6"
        markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z"
        fill="var(--dg-rule)"/></marker></defs>
    One marker per colour. Ids are yours: each drawing gets its own copy.
  · A connector starts and ends on a box's edge and runs through the gaps; go round
    an obstacle with right angles (a path of M, H and V), never across a box.

What a drawing may hold: svg g defs marker path rect line polyline polygon circle
ellipse text tspan title desc, with presentation attributes and data-*. Anything
else — script, style, foreignObject, use, image, links, event handlers, url() to
anything but a marker in the same drawing — is dropped. A drawing that is not one
well-formed <svg> shows as its source until it is fixed.

A flow: three steps, the last one the point
  <svg viewBox="0 0 760 136" role="img" aria-label="A draft becomes a page in three steps">
  <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--dg-rule)"/></marker></defs>
  <text x="24" y="34" font-size="15" font-weight="600" fill="var(--dg-ink)">A draft becomes a page in three steps</text>
  <rect x="24" y="56" width="208" height="56" rx="8" fill="none" stroke="var(--dg-rule)" stroke-width="1.25"/>
  <text x="128" y="80" text-anchor="middle" font-size="13" font-weight="600" fill="var(--dg-ink)">Write</text>
  <text x="128" y="96" text-anchor="middle" font-size="11.5" fill="var(--dg-ink-2)">someone drafts it</text>
  <line x1="232" y1="84" x2="270" y2="84" stroke="var(--dg-rule)" stroke-width="1.25" marker-end="url(#arrow)"/>
  <rect x="272" y="56" width="208" height="56" rx="8" fill="none" stroke="var(--dg-rule)" stroke-width="1.25"/>
  <text x="376" y="80" text-anchor="middle" font-size="13" font-weight="600" fill="var(--dg-ink)">Review</text>
  <text x="376" y="96" text-anchor="middle" font-size="11.5" fill="var(--dg-ink-2)">a teammate reads it</text>
  <line x1="480" y1="84" x2="518" y2="84" stroke="var(--dg-rule)" stroke-width="1.25" marker-end="url(#arrow)"/>
  <rect x="520" y="56" width="208" height="56" rx="8" fill="var(--dg-accent)" fill-opacity="0.12" stroke="var(--dg-accent)" stroke-width="2"/>
  <text x="624" y="80" text-anchor="middle" font-size="13" font-weight="600" fill="var(--dg-ink)">Publish</text>
  <text x="624" y="96" text-anchor="middle" font-size="11.5" fill="var(--dg-ink-2)">everyone can read it</text>
  </svg>

Lanes: who does what, side by side
  <svg viewBox="0 0 760 228" role="img" aria-label="Writers and readers take turns on a draft">
  <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--dg-rule)"/></marker></defs>
  <text x="24" y="34" font-size="15" font-weight="600" fill="var(--dg-ink)">Writers and readers take turns on a draft</text>
  <text x="24" y="68" font-size="11.5" font-weight="600" fill="var(--dg-ink-2)">Writers</text>
  <text x="400" y="68" font-size="11.5" font-weight="600" fill="var(--dg-ink-2)">Readers</text>
  <rect x="24" y="84" width="336" height="40" rx="8" fill="none" stroke="var(--dg-rule)" stroke-width="1.25"/>
  <text x="192" y="108" text-anchor="middle" font-size="13" font-weight="600" fill="var(--dg-ink)">Draft</text>
  <rect x="400" y="84" width="336" height="40" rx="8" fill="none" stroke="var(--dg-rule)" stroke-width="1.25"/>
  <text x="568" y="108" text-anchor="middle" font-size="13" font-weight="600" fill="var(--dg-ink)">Read</text>
  <rect x="400" y="164" width="336" height="40" rx="8" fill="none" stroke="var(--dg-rule)" stroke-width="1.25"/>
  <text x="568" y="188" text-anchor="middle" font-size="13" font-weight="600" fill="var(--dg-ink)">Comment</text>
  <rect x="24" y="164" width="336" height="40" rx="8" fill="none" stroke="var(--dg-rule)" stroke-width="1.25"/>
  <text x="192" y="188" text-anchor="middle" font-size="13" font-weight="600" fill="var(--dg-ink)">Revise</text>
  <line x1="360" y1="104" x2="398" y2="104" stroke="var(--dg-rule)" stroke-width="1.25" marker-end="url(#arrow)"/>
  <line x1="568" y1="124" x2="568" y2="162" stroke="var(--dg-rule)" stroke-width="1.25" marker-end="url(#arrow)"/>
  <line x1="400" y1="184" x2="362" y2="184" stroke="var(--dg-rule)" stroke-width="1.25" marker-end="url(#arrow)"/>
  </svg>

A journey: stages along one axis
  <svg viewBox="0 0 760 152" role="img" aria-label="A reader moves from noticing to deciding">
  <defs>
  <marker id="step" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--dg-rule)"/></marker>
  <marker id="axis" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--dg-accent)"/></marker>
  </defs>
  <text x="24" y="34" font-size="15" font-weight="600" fill="var(--dg-ink)">A reader moves from noticing to deciding</text>
  <rect x="24" y="56" width="152" height="40" rx="8" fill="none" stroke="var(--dg-rule)" stroke-width="1.25"/>
  <text x="100" y="80" text-anchor="middle" font-size="13" font-weight="600" fill="var(--dg-ink)">Notice</text>
  <rect x="208" y="56" width="152" height="40" rx="8" fill="none" stroke="var(--dg-rule)" stroke-width="1.25"/>
  <text x="284" y="80" text-anchor="middle" font-size="13" font-weight="600" fill="var(--dg-ink)">Compare</text>
  <rect x="392" y="56" width="152" height="40" rx="8" fill="none" stroke="var(--dg-rule)" stroke-width="1.25"/>
  <text x="468" y="80" text-anchor="middle" font-size="13" font-weight="600" fill="var(--dg-ink)">Try</text>
  <rect x="576" y="56" width="152" height="40" rx="8" fill="none" stroke="var(--dg-rule)" stroke-width="1.25"/>
  <text x="652" y="80" text-anchor="middle" font-size="13" font-weight="600" fill="var(--dg-ink)">Decide</text>
  <line x1="176" y1="76" x2="206" y2="76" stroke="var(--dg-rule)" stroke-width="1.25" marker-end="url(#step)"/>
  <line x1="360" y1="76" x2="390" y2="76" stroke="var(--dg-rule)" stroke-width="1.25" marker-end="url(#step)"/>
  <line x1="544" y1="76" x2="574" y2="76" stroke="var(--dg-rule)" stroke-width="1.25" marker-end="url(#step)"/>
  <line x1="24" y1="120" x2="728" y2="120" stroke="var(--dg-accent)" stroke-width="2" marker-end="url(#axis)"/>
  <text x="24" y="140" font-size="11.5" fill="var(--dg-ink-2)">first look</text>
  <text x="736" y="140" text-anchor="end" font-size="11.5" fill="var(--dg-ink-2)">ready to buy</text>
  </svg>

A ```mermaid block is drawn in the same style, for diagrams people type by hand:
write a box as "<b>Name</b><br/>a quieter line", and mark the one box that stands
out with :::focus (A:::focus, or class A focus). Mermaid places the boxes itself,
so when the arrangement matters, draw it."##;

const AGENT: &str = r#"FOR AN AGENT

You are working in a Doklin workspace: documents that people write and review in
the Doklin app, reached through a domain of their own. Nothing is on this machine;
every command asks the domain. What you change shows up in their app within
seconds, signed with your name.

Start here
  doklin whoami                whose agent you are, and what you may do
  doklin ls --deep             everything you can see
  doklin search "<words>"      find documents by name or by what they say

Where things go
  You see what your person sees. Private/ is theirs alone, Restricted/<folder>/ is
  for the people in that folder, and everything else is shared with the whole
  workspace (doklin help sections).
  · Create anything new under Private/, unless your person tells you where it goes.
  · Do not move a document out of Private/ or a restricted folder unless asked:
    that shows it to more people.

Read before you write
  doklin read <doc>            prints the text; its revision is on stderr
  doklin write <doc> --if-rev <n> < new.md
                               replaces what you read. It is refused if the
                               document changed meanwhile: read again, and redo
                               your change on the new text.
  doklin edit <doc> --find "<old>" --replace "<new>"
                               for a small change. It handles the revision itself.

What matters here
  · A document can have a markdown and an html version (doklin help documents).
    When you change the markdown and an html version exists, the html is now out
    of date: write it again, or remove it. The answer to your write tells you.
  · Text like {==these words==}{>>#c7k2x9<<} marks a comment. Keep it exactly as
    it is, or the write is refused (doklin help comments).
  · To say something about a document without changing it, comment on it:
    doklin comment <doc> --on "<words in it>" -m "<what you think>"
  · Publishing makes a document readable by anyone. Do it only when asked, and
    look at a folder with --dry-run first (doklin help publishing).
  · A diagram is a ```svg drawing you place by hand, in the theme's colours —
    follow doklin help drawings, and it reads like the rest of the document.
  · Every command that changes something takes --dry-run.

Output is JSON whenever it is not going to a terminal. A refusal is one sentence
on stderr that says what to do next, with an exit code: 2 bad usage, 3 not found,
4 not permitted, 5 conflict (the document changed, or the name is taken), 6 not
logged in, 7 the workspace's worker is too old for the command, 8 the domain asked
to slow down, or today's Cloudflare requests are used up. On 8, stop: wait as long
as its sentence says before the next command, and never retry it in a loop."#;

/// Print the overview, a topic, or one command's own help. A topic wins over
/// a command of the same name: `doklin help comments` is how comments work,
/// and `doklin comments --help` is how that one command is typed.
pub fn print(topic: Option<&str>) -> Result<(), Failure> {
    let Some(topic) = topic else {
        println!("{}", OVERVIEW);
        return Ok(());
    };
    let words = match topic {
        "documents" | "document" | "versions" => DOCUMENTS,
        "comments" => COMMENTS,
        "publishing" => PUBLISHING,
        "sections" | "private" | "restricted" => SECTIONS,
        "agent" | "agents" => AGENT,
        "drawings" | "drawing" | "diagrams" | "diagram" => DRAWINGS,
        name => {
            let Some(found) = COMMANDS.iter().find(|c| c.name == name) else {
                return Err(Failure::usage(format!(
                    "there is no help on \"{}\" — try: documents, comments, publishing, sections, drawings, agent, or a command's name",
                    name
                )));
            };
            command(found);
            return Ok(());
        }
    };
    println!("{}", words);
    Ok(())
}

/// One command's own help: how it is typed, what it does, its options.
pub fn command(command: &Command) {
    println!("{}\n\n{}", command.usage, wrap(command.about, 84));
    let options = options_of(command.name);
    if !options.is_empty() {
        println!("\n{}", options);
    }
}

/// What each option of a command means — the ones worth a line of their own.
fn options_of(command: &str) -> &'static str {
    match command {
        "read" => {
            "  --md, --html   which version (default: the markdown; the html when that is all there is)\n  --clean        leave out comment markers\n  -o <file>      write the content to a file instead of printing it"
        }
        "write" => {
            "  --md, --html   which version (default: markdown; an html-only document needs one said)\n  --if-rev <n>   replace revision n — refused if the document has moved on\n  --force        replace whatever is there\n  --from <file>  take the new content from a file instead of what is piped in\n  --dry-run      say what would happen"
        }
        "edit" => {
            "  --find \"…\"     the text to change, exactly as `read` shows it\n  --replace \"…\"  what to put there (may be empty)\n  --all          change every occurrence\n  --md, --html   which version\n  --dry-run      say what would happen"
        }
        "comment" => {
            "  --on \"…\"       the words the thread is on (doklin help comments)\n  -m \"…\"         the comment\n  --md, --html   which version the words are in (default: the markdown, or the one the name's extension picks)"
        }
        "search" => "  --in <folder>  only under this folder\n  --limit <n>    how many documents to show (default 20, at most 30)",
        "publish" => {
            "  --slug <s>     the last part of the address (default: a random one)\n  --title <t>    the page's title, where it differs from the document's\n  --desc <d>     its description, for link previews\n  --dry-run      list what would become public"
        }
        "ls" => "  --deep         everything beneath the folder, not only what is directly in it",
        "rm" => "  --md, --html   remove one version, keeping the other and the document\n  --dry-run      say what would happen",
        _ => "",
    }
}

/// Break a paragraph into lines of at most `width` characters.
fn wrap(text: &str, width: usize) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut line = String::new();
    for word in text.split_whitespace() {
        if !line.is_empty() && line.chars().count() + 1 + word.chars().count() > width {
            lines.push(std::mem::take(&mut line));
        }
        if !line.is_empty() {
            line.push(' ');
        }
        line.push_str(word);
    }
    if !line.is_empty() {
        lines.push(line);
    }
    lines.join("\n")
}
