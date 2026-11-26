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

You work as one person's agent, and see what they see. Every path starts with the
section it is in, and a path with no section is refused:
  Library/…                    everyone in the workspace sees it
  Private/…                    only your person sees it
  Restricted/<folder>/…        only the people in that folder

Wherever a command takes a document, it also takes a link to one, as people copy it
in the app (https://doklin.cc/open#…); the command then runs in that link's workspace.
`info` gives a document's link.

Getting in
  login <domain> <code>        log this machine in, with the line you were given
                               (on a Mac where Doklin is connected: Doklin → Install Command Line Tool)
  logout                       log this machine out
  whoami                       which workspace and agent this is, whose, and what it may do

Reading
  ls [folder] [--deep]         what a folder holds            [--where tag=value]
  info <doc>                   a document's versions, tags, comments, link and public addresses
  read <doc>                   a document's text              [--md|--html] [--clean] [-o file]
  search <text>                documents by name or text      [--in folder] [--limit n] [--where tag=value]
  links <doc>                  what it links to, and what links to it   [--from|--to]
  comments <doc>               the comment threads on a document
  tags                         the workspace's tags and the values each takes
  published                    everything that is public

Changing
  write <doc>                  create or replace a document   [--md|--html] [--if-rev n|--force] [--from file]
  edit <doc>                   change part of a document      --find "…" --replace "…" [--all]
  tag <doc> <tag>=<value>…     set a document's tags; <tag>= removes one
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
  doklin help tags             tags: the list, a document's values, finding by them
  doklin help publishing       what public means
  doklin help sections         Library, Private and Restricted: who sees what
  doklin help writing          how a document reads well: its name, sections, callouts
  doklin help drawings         diagrams: how to draw one that reads well
  doklin help agent            a short brief for an AI agent using this
  doklin help <command>

Exit codes: 0 done · 2 bad usage · 3 not found · 4 not permitted · 5 conflict ·
6 not logged in · 7 the workspace's worker is too old for the command ·
8 the domain asked to slow down, or today's Cloudflare requests are used up ·
9 this doklin is too old for the domain: update it"#;

const DOCUMENTS: &str = r#"DOCUMENTS

A document is named by its path, without an extension: Library/Projects/plan

One document can have two versions.

  markdown   The source. People write and review it in the Doklin app.
  html       An optional designed page, usually made from the markdown. When the
             document is public and has one, visitors see it first.

They are one document: one name, one set of comments, one public address. `ls`
shows which versions a document has, and --md or --html picks one.

  doklin read Library/Projects/plan            the markdown (the html, when that is all there is)
  doklin read Library/Projects/plan --html     the html version
  doklin write Library/Projects/plan --html    create or replace the html version

Keep the two in step. Changing the markdown does not change the html, which goes on
saying what the old text said. Doklin tells you when that has happened: `ls` and
`info` show "html is behind", and so does the answer to a markdown write. Then
either write the html again from the new markdown, or remove it:

  doklin rm Library/Projects/plan --html

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

const COMMENTS: &str = r##"COMMENTS

A comment thread sits on some text of a document.

  doklin comments Library/Projects/plan
  doklin comment Library/Projects/plan --on "ships in June" -m "Is that still true?"
  doklin reply Library/Projects/plan c7k2x9 -m "Yes."
  doklin comment rm Library/Projects/plan c7k2x9

--on says which words the thread is on.

  In markdown   They must occur exactly once, in ordinary text — not in code, a
                link's address or another comment — and be plain words, with no
                formatting marks. If they occur more than once, quote more of the
                sentence; the refusal lists every place.
  In html       (--html) They are the opening words of one element: a heading, a
                paragraph, a list item. Or the element's id, as #id: the way
                to comment on a picture or a chart, which has no words.

                  doklin comment Library/Projects/plan --html --on "#revenue-chart" -m "Which year?"

In markdown, a thread's place is marked in the text itself:

  The boat {==ships in June==}{>>#c7k2x9<<} if the paint dries.

`read` shows these markers. A write must keep each one exactly as it is; it may
move with its words. A write that removes, changes or adds one is refused: start a
thread with `doklin comment`, remove one with `doklin comment rm`.

In html, a thread is on words of the page or on one element of it, and is found
again by what the page says. A write may reword what a thread is on a little, and
may move it. A write that takes it away is refused the same way: the refusal says
which words or which element to keep.

So that comments keep their place when you write a page again, give its sections,
figures, charts and tables an id that says what they are (id="revenue-chart", not
id="s3"), and keep the ids a page already has.

`read --clean` gives the text without markers, to read or to make an html version
from. Written back over the markdown, it is refused."##;

const TAGS: &str = r#"TAGS

A tag is a name and a short list of values, the same for the whole workspace:
status takes Todo, Doing or Done. A document holds at most one value of each tag.
People set them in the Doklin app, under a document's title; you set them here.

  doklin tags                                        every tag and its values
  doklin tag Library/Projects/plan status=Doing      set one, or several at once
  doklin tag Library/Projects/plan status=           remove one
  doklin ls Library/Projects --where status=Doing    the documents that have it
  doklin ls --deep --where status                    the ones with any status
  doklin search "launch" --where priority=p1         text and tags together

Only a value the tag lists can be set, in any case. A write that gives a tag any
other value is refused, and so is one that gives it two. Never invent a value: ask
your person, or add it to the list.

The list is a document of its own, Library/Tags. Each line at its top is a tag
and its values, in order:

  ---
  status: [Todo, Doing, Done]
  priority: [p1, p2, p3]
  ---
  What each value means, for the people and agents who set them.

Change it with `doklin edit`: every line at its top must be a tag like these, or
the write is refused. Renaming a value there leaves every document that holds the
old one as it was — ask your person to rename it in the app, which changes them.

In a document, a tag is a line at the top of its markdown, between two --- lines:

  ---
  status: Doing
  ---

`read` shows these lines as they are, and `doklin tag` writes them for you. Any
other line there is the document's own, never a tag. `ls` and `info` show a
document's tags. `ls` shows what Doklin's index holds and says when it hasn't read
the latest changes; --where waits for it."#;

const PUBLISHING: &str = r#"PUBLISHING

Publishing gives a document a public address on the workspace's domain. Anyone who
has the address can read it. There is no login.

  doklin publish Library/Projects/plan                prints the address
  doklin publish Library/Projects/plan --slug plan    choose the last part of the address
  doklin publish Library/Projects/                    a folder: every document in it
  doklin publish Library/Projects/ --dry-run          list what that would make public
  doklin published                                    everything that is public now
  doklin unpublish Library/Projects/plan              stop

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

A workspace has three sections, and every path starts with the one it is in.

  Library/…                 Everyone in the workspace sees and edits it.
  Private/…                 Your person's own. Nobody else in the workspace sees it.
  Restricted/<folder>/…     A restricted folder: only the people in it. `doklin ls
                            Restricted` lists the ones your person is in.

A path with no section is refused. For Projects/plan, say which one you mean:
Library/Projects/plan, Private/Projects/plan or Restricted/<folder>/Projects/plan.

You are one person's agent and see exactly what they see. If they are added to a
folder you can work in it from your next command; if they are taken out, it is gone
for you too. A folder they are not in does not exist as far as you can tell.

Put new work under Private/ unless your person says where it goes:

  doklin write Private/drafts/summary < summary.md

Moving a thing changes who can see it, so do it only when asked:

  doklin mv Private/drafts/summary Library/                now everyone sees it
  doklin mv Library/Projects/summary Restricted/Finance/   now only that folder's people

`doklin ls` lists the sections you can see, `doklin ls --deep` everything in them,
and `doklin search` with no folder searches all of it. `doklin ls Private` or
`doklin search "…" --in Restricted/Finance` keeps to that place.
You cannot make a restricted folder or change who is in one — people do that in the
Doklin app. A section itself — Library, Private, a restricted folder — is not a
folder to move or rename."#;

// The callout kinds and their meanings are src/calloutTypes.ts's (the app's
// type picker shows the same lines): change both. The examples are the
// fixture verify-harness/callouts.tsx opens and saves byte for byte.
const WRITING: &str = r#"WRITING

How a document reads well in Doklin. Write plain markdown: the app, the iPhone
and a public page all draw it the same way.

Structure
  · The name is the title. The app shows a document's name above its text, and
    renaming one is changing its title, so name it the way a title reads:
    Library/Projects/Launch plan. The text starts with what it says, never with
    a # line that repeats the name.
  · Sections are ## and ###: the app's outline ("On this page") is built from
    them, so a long document gets one for free.
  · Short paragraphs, one idea each. Lists for parallel items.

Callouts
  A quote whose first line is a marker, alone on that line, is a callout: a box
  with the kind's name and icon. It is GitHub's alert syntax, so the document
  reads the same on GitHub.

    > [!NOTE]
    > Polling stays as the catch-up after a gap.

  The five kinds:
    NOTE        Worth knowing, even when skimming
    TIP         A better or easier way to do it
    IMPORTANT   Needed to get it right
    WARNING     Needs attention to avoid a problem
    CAUTION     A risk: what could go wrong

    > [!WARNING]
    > Workers Free allows 100,000 requests a day for the whole account.
    >
    > Past it, every request gets Cloudflare's 1027 page until 00:00 UTC.

  · One or two in a document, never two in a row: a callout is for what must
    not be missed.
  · The body can hold paragraphs, lists, code and tables. Every line of it
    keeps its "> ", the blank ones too.
  · Top level only: never inside a list or another quote. Nothing follows the
    marker on its line; "> [!NOTE] A title" stays a plain quote.

Pictures and pages
  · A diagram is a ```svg drawing: doklin help drawings.
  · A designed page (layout, columns, colour) is the document's html version:
    doklin help documents. Give its sections, figures, charts and tables an id
    that says what they are, and keep those ids when you write the page again:
    comments find their place by them (doklin help comments)."#;

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

A ```mermaid block that holds a flowchart is drawn in the same style, with the
boxes placed for you. Only flowcharts are drawn (flowchart or graph; TB, BT, LR,
RL): any other kind of Mermaid diagram is shown as its source. What is drawn:

    A["<b>Name</b><br/>a quieter line"]   a box: a label with a bold part is a
                                          name over quiet lines
    A(["pill"])  A[("database")]  A{"decision"}  A(("circle"))  A[["subroutine"]]
    A --> B    A --- B    A -.-> B    A ==> B    A <--> B    A --o B    A --x B
    A -->|label| B    A ---> B (one rank further)    A ~~~ B (placed, not drawn)
    subgraph id [Title] … end             a group: it may hold groups, and name
                                          a direction of its own
    A:::focus    class A,B focus          a mark on a box: focus (the one that
                                          stands out), good, warn or bad

Colours and styles written in the source (classDef, style, linkStyle) are not
used: the look is the document's. The boxes are placed for you, and a flowchart
too wide to read on a phone is turned there (a row of boxes becomes a column),
so when the arrangement itself matters, draw it."##;

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
  You see what the person who gave you this sees. Every path starts with its
  section: Library/ is what everyone sees, Private/ only them, Restricted/<folder>/
  that folder's people. Put anything new under Private/ unless they tell you where
  it goes (doklin help sections).
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
  · An html page's comments are on its words and its elements. When you write a
    page again, keep what they are on and the ids the page has; a write that
    takes a commented part away is refused, and says what to keep.
  · To say something about a document without changing it, comment on it:
    doklin comment <doc> --on "<words in it>" -m "<what you think>"
  · To point your person at a document, give its link from doklin info, not its
    path: it opens in their Doklin app, for whoever can see the document. It is
    not public — publishing is. A rename or a move keeps the link.
  · Inside a document, link to another one with an ordinary markdown link and
    the path from this document's folder: [plan](../Projects/plan.md). It keeps
    working when that document is renamed or moved. doklin links <doc> lists
    what a document links to, and what links to it.
  · Set a document's tags with doklin tag <doc> status=Done, to a value that
    doklin tags lists. Never invent one: ask your person, or add it to the list
    in Library/Tags (doklin help tags).
  · Publishing makes a document readable by anyone. Do it only when asked, and
    look at a folder with --dry-run first (doklin help publishing).
  · A diagram is a ```svg drawing you place by hand, in the theme's colours —
    follow doklin help drawings, and it reads like the rest of the document.
  · A document's name is its title: name a new one the way a title reads
    (Private/Launch plan), and don't open its text with a # line that says it
    again (doklin help writing).
  · To set something apart (a note, a warning), use a callout: "> [!NOTE]" on
    its own line, the text on the "> " lines after it (doklin help writing).
  · Every command that changes something takes --dry-run.

Output is JSON whenever it is not going to a terminal. A refusal is one sentence
on stderr that says what to do next, with an exit code: 2 bad usage, 3 not found,
4 not permitted, 5 conflict (the document changed, or the name is taken), 6 not
logged in, 7 the workspace's worker is too old for the command, 8 the domain asked
to slow down, or today's Cloudflare requests are used up, 9 this doklin is too old
for the domain. On 8, stop: wait as long as its sentence says before the next
command, and never retry it in a loop. On 9, update doklin the way its sentence
says, then run the command again."#;

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
        "tags" => TAGS,
        "publishing" => PUBLISHING,
        "sections" | "private" | "restricted" => SECTIONS,
        "agent" | "agents" => AGENT,
        "drawings" | "drawing" | "diagrams" | "diagram" => DRAWINGS,
        "writing" | "callouts" | "callout" => WRITING,
        name => {
            let Some(found) = COMMANDS.iter().find(|c| c.name == name) else {
                return Err(Failure::usage(format!(
                    "there is no help on \"{}\" — try: documents, comments, tags, publishing, sections, writing, drawings, agent, or a command's name",
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
        "search" => {
            "  --in <folder>  only under this folder\n  --limit <n>    how many documents to show (default 20, at most 30)\n  --where <tag>=<value>\n                 only documents with that tag; a tag alone is any value. Repeat it for\n                 several. With no text, every document that has them"
        }
        "links" => "  --from         only what the document links to\n  --to           only the documents that link to it",
        "publish" => {
            "  --slug <s>     the last part of the address (default: a random one)\n  --title <t>    the page's title, where it differs from the document's\n  --desc <d>     its description, for link previews\n  --dry-run      list what would become public"
        }
        "ls" => {
            "  --deep         everything beneath the folder, not only what is directly in it\n  --where <tag>=<value>\n                 only documents with that tag; a tag alone is any value. Repeat it for\n                 several"
        }
        "tag" => "  <tag>=<value>  a value the tag lists, in any case (doklin tags)\n  <tag>=         remove the tag\n  --dry-run      say what would happen",
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
