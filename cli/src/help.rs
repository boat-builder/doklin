//! Help — where the concepts live. The commands are few and plain; what a
//! reader needs is what a *document* is here, how a comment attaches to
//! text, and what public means. An agent reads `doklin help agent` once and
//! knows how to behave in a workspace it has never seen.

use crate::{Command, Failure, COMMANDS};

const OVERVIEW: &str = r#"doklin — work with a Doklin workspace from anywhere

A workspace is a folder of documents that lives on people's Macs and syncs through
a domain of their own. This program reads and changes it through that domain.
Nothing is copied to this machine.

You work as one person's agent, and see what they see. A path says where a thing is:
  Private/…                    only your person sees it
  Restricted/<folder>/…        only the people in that folder
  anything else                shared with everyone in the workspace

Getting in
  login <domain> <code>        log this machine in, with the line you were given
                               (on a Mac where Doklin is connected: Doklin → Install Command Line Tool)
  logout                       log this machine out
  whoami                       which workspace and agent this is, whose, and what it may do

Reading
  ls [folder] [--deep]         what a folder holds
  info <doc>                   a document's versions, comments and public addresses
  read <doc>                   a document's text              [--md|--html] [--clean] [-o file]
  search <text>                documents containing the text  [--in folder] [--limit n]
  comments <doc>               the comment threads on a document
  published                    everything that is public

Changing
  write <doc>                  create or replace a document   [--md|--html] [--if-rev n|--force] [--from file]
  edit <doc>                   change part of a document      --find "…" --replace "…" [--all]
  mv <from> <to>               move or rename a document, a file or a folder
  rm <doc>                     remove a document, or one version of it   [--md|--html]
  comment <doc>                start a comment thread         --on "…" -m "…"
  reply <doc> <thread>         answer a thread                -m "…"
  comment rm <doc> <thread>    remove a thread
  publish <doc or folder>      make it public                 [--slug s] [--title t] [--desc d]
  unpublish <doc, folder or address>

Boards
  board show <board>           its cards, in columns          [--by field] [--where field=value]…
  board info <board>           its fields and their options
  board card <board> <card>    one card: its properties and its page
  board add <board> <title>    a new card                     [field=value…] [--first] [--from file|-]
  board set <board> <card>     change a card                  [field=value…] [--title t] [--first|--last|--before c|--after c]
  board rm <board> <card>      remove a card
  board new <path>             a new board                    [--name n]
  board field add|set|rm …     the board's fields             (doklin help boards)
  board option add|set|rm …    a field's options, which are its columns

This Mac
  open [path…]                 open files or folders here in the Doklin app; no login

Everywhere
  -w <domain>     which workspace, when this machine is logged in to several
  --json          answer in JSON (already the case when the output is not a terminal)
  --dry-run       say what a change would do, without doing it

More
  doklin help documents        one document, two versions: markdown and html
  doklin help comments         how a comment attaches to text
  doklin help publishing       what public means
  doklin help sections         Private, Restricted and what is shared
  doklin help boards           a board, its cards and their properties
  doklin help agent            a short brief for an AI agent using this
  doklin help <command>

Exit codes: 0 done · 2 bad usage · 3 not found · 4 not permitted · 5 conflict ·
6 not logged in · 7 the workspace's worker is too old for the command"#;

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

Anything that is not markdown or html is a plain file: a picture, a PDF, a CSV.
Name it in full (Projects/chart.png). It has no versions and no comments.

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

`read` shows these markers, so that what you write back keeps every comment where
it was. When you rewrite a document:

  · leave each marker as it is, and move it with its words if you move the words;
  · if you remove one, its thread is kept but has no place any more — the answer
    to the write names it;
  · do not write a marker of your own. Start a thread with `doklin comment`.

`read --clean` gives the text without markers. Use it to read, or to make an html
version from — and do not write it back over the markdown, or every thread loses
its place."#;

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

const BOARDS: &str = r#"BOARDS

A board is a set of cards in columns — a kanban board, as people see it in the
Doklin app. It is named by its path, like a document: Projects/Roadmap

  doklin board show Projects/Roadmap               every card, in its column
  doklin board info Projects/Roadmap               its fields, and their options
  doklin board card Projects/Roadmap "Ship it"     one card: its properties and its page

A card has a title, properties, and a page. Its properties are the board's fields:

  select         one of the field's options        status=Done
  multi-select   several of them                   tags=bug,auth · tags+=bug · tags-=auth
  text           anything                          owner="Ada Lovelace"
  number         a number                          points=3
  date           a day, as YYYY-MM-DD              due=2026-09-12
  checkbox       true or false                     shipped=true
  any field      left empty clears it              due=

Name a field by its name or its id, in any case, and quote it if it has spaces:
"Due date"=2026-09-12. A value that is not one of a select's options is refused,
with the options there are; add one first with `board option add`.

  doklin board add Projects/Roadmap "Rig the mast" status=Backlog tags=hull
  doklin board add Projects/Roadmap "Rig the mast" --from notes.md    with a page
  doklin board set Projects/Roadmap "Rig the mast" status="In progress"
  doklin board set Projects/Roadmap "Rig the mast" --before "Ship it"
  doklin board set Projects/Roadmap "Rig the mast" --title "Rig both masts"
  doklin board rm Projects/Roadmap "Rig the mast"

The board's columns are the options of the field it is grouped by. A card that
changes column goes to the bottom of its new one; --first, --last, --before and
--after put it elsewhere. A title is unique on its board. `board show --by tags`
groups by another field; --where status!=Done (or tags=bug, or due= for empty)
shows only the cards that match, and may be said more than once.

A card's page is a document named <board>/<card>. Read it, change it and comment
on it the way you do any document — its properties are not part of its text:

  doklin read "Projects/Roadmap/Ship it"
  doklin edit "Projects/Roadmap/Ship it" --find "June" --replace "July"
  doklin comment "Projects/Roadmap/Ship it" --on "the hull" -m "Which one?"

A board is not a folder. Nothing else goes in it, and nothing in it is moved or
removed but through `doklin board`. `doklin mv` moves a whole board.

The board itself:

  doklin board new Work/Sprint                     with Status: Backlog, In progress, Done
  doklin board field add Work/Sprint Priority --type select --options "Low, High"
  doklin board field set Work/Sprint Priority --name Urgency
  doklin board field rm Work/Sprint Urgency        cards keep their values
  doklin board option add Work/Sprint Status Review --before Done --color purple
  doklin board option set Work/Sprint Status Review --name "In review"
  doklin board option rm Work/Sprint Status "In review"

Renaming an option renames it on every card that has it. Removing an option or a
field changes no card: a card keeps its value, and shows it as what it is.
Colors: grey, brown, orange, yellow, green, blue, purple, pink, red, or none."#;

const AGENT: &str = r#"FOR AN AGENT

You are working in a Doklin workspace: documents that people write and review in
the Doklin app, reached through a domain of their own. Nothing is on this machine;
every command asks the domain. What you change shows up in their app within
seconds, signed with your name.

Start here
  doklin whoami                whose agent you are, and what you may do
  doklin ls --deep             everything you can see
  doklin search "<words>"      find documents by what they say

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
    it is when you rewrite a document (doklin help comments).
  · To say something about a document without changing it, comment on it:
    doklin comment <doc> --on "<words in it>" -m "<what you think>"
  · Publishing makes a document readable by anyone. Do it only when asked, and
    look at a folder with --dry-run first (doklin help publishing).
  · Every command that changes something takes --dry-run.

Boards
  `doklin ls` shows a board as one row: [board · 12 cards]. It is not a folder —
  never write files into it. Work with it through `doklin board` (doklin help boards):
    doklin board show <board>                        the cards, in their columns
    doklin board set <board> "<card>" status=Done    move a card, set a property
  A card's page is a document named <board>/<card>: read, edit and comment on it
  as on any other.

Output is JSON whenever it is not going to a terminal. A refusal is one sentence
on stderr that says what to do next, with an exit code: 2 bad usage, 3 not found,
4 not permitted, 5 conflict (the document changed, or the name is taken), 6 not
logged in, 7 the workspace's worker is too old for the command."#;

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
        "boards" | "cards" => BOARDS,
        name => {
            let Some(found) = COMMANDS.iter().find(|c| c.name == name) else {
                return Err(Failure::usage(format!(
                    "there is no help on \"{}\" — try: documents, comments, publishing, sections, boards, agent, or a command's name",
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
        "board" => {
            "  --by <field>      group by another select, multi-select or date field\n  --where <cond>    field=value, field!=value, field= (empty) — repeat to narrow\n  --first, --last   the top or the bottom of its column\n  --before <name>   just before another card (or option)\n  --after <name>    just after it\n  --title <t>       a card's new title\n  --from <file|->   a new card's page, from a file or from what is piped in\n  --type <type>     a field's type: select, multi_select, text, number, date, checkbox\n  --options \"…\"     a select field's first options, comma-separated\n  --name <n>        a new board's name, or a field's or option's new name\n  --color <c>       an option's color, or none\n  --dry-run         say what would happen"
        }
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
