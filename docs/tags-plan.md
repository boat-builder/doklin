# Tags — the plan (not built)

Tags on notes, set by people and agents, filtered by both. Everything marked
**decided** was agreed with the user on 2026-11-25. Everything under *My
choices* is mine and has not been confirmed. **Phases A and B are built**
(A committed, B not yet); C is not, and waits for its own go-ahead. What A
settled is in `docs/architecture.md` (*Frontmatter*, *Tags*); what B settled
is in `docs/cloud-people-agents.md` (*Document API*, *Search*, *CLI*) and
`cloud-worker/README.md`. Delete this file once the phases are built, and
put what outlives it into the docs the way every other rule is kept.

## Decided

- **One kind of tag: a choice tag.** A tag has a name and an ordered list of
  values. A note holds at most one value per tag. There are no dates, free
  text, numbers, people or multi-value labels.
- **People and agents create tags as they need them.** There is no fixed set.
- **One workspace-wide tag list, kept in a note** that syncs like any other.
- **A note's tags are lines in its frontmatter.** The allowed values are
  enforced by the code that writes them, not by the file format: the picker
  for people, and the worker's check for agents.
- **Renaming a value or a tag rewrites every note the person can open.**
- **Chips sit right below the title**, the file-name title from v0.1.140,
  which is where the frontmatter box sits now. They are plain grey, with no
  colours, and published pages leave them off.
- **Every platform gets it** (the Mac, the browser, the iPhone, the worker
  and the CLI), built in phases and released together.
- **No board.** This plan only adds tags. Nothing in it may make a board
  built from tags harder later.
- **No change to existing files or data**, and no migration. The
  `engineering/todo` file names stay as they are.
- **Agents filter through a worker index**, and people filter with
  `status:Doing` in search.

## What this builds on

- `src/frontmatter.ts` `splitFrontmatter` finds the block: line 1 is `---`
  and a later line is `---`. The editor never sees the block. Every write
  puts it back as it was (`frontmatterRef` in App.tsx). Today the Mac shows
  it raw above the note (`.doc-frontmatter`), the iPhone shows it as a closed
  *Frontmatter* disclosure under the title (`FrontmatterView`), and published
  pages leave it off (`cloud-worker/src/pages.ts`).
- **A note's title is its file name** (v0.1.140, `docs/architecture.md`
  *The title*):
  - On the Mac and in the browser, `src/DocTitle.tsx` draws it above the
    note. The order in App.tsx is title, then `.doc-frontmatter`, then the
    editor. The title is hidden in the html view.
  - Notes don't open with a `# title` line.
  - On the iPhone, the reader shows the title, then the who-edited line
    (`header` in `DocumentView.swift`), then `FrontmatterView`. The editor
    page has its own title field (`src/ios-editor/title.ts`).
- The Mac already adopts a change that touches only an open note's
  frontmatter without touching the editor (App.tsx, the active document's
  watcher: `fm.body === lastDiskMdRef.current`).
- Sync merges markdown three ways (`engine/src/cloud/merge.rs`). A tag line
  changed on one device and a body edit on another merge cleanly. The same
  tag changed on two devices at once gives a conflict copy.
- The worker already refuses agent writes that break the text's rules
  (`markersKept`, `cloud-worker/src/agentDocs.ts`). The tag check goes in
  the same place.
- The search catch-up (`cloud-worker/src/search.ts`) reads every changed
  note once and fills `search_text` and `links`. `tags` is filled the same
  way, in the same pass.
- In the user's workspace (company-os), none of its 353 notes has
  frontmatter, and 5 of its 358 documents are html-only.

## The format

### A note's tags

```
---
status: Doing
priority: p1
---
```

- **A pair** is an unindented line in the block, `key: value`, where the
  value is one scalar: bare text, `"…"` (escapes `\"` and `\\`) or `'…'`
  (`''` for a quote). The key must not start with `#`, `-` or a space.
- **Not a pair:**
  - a line with an empty value;
  - a list (`[…]`);
  - a line followed by an indented run (a block list or a map).
- **Which pairs are tags:** a pair whose key matches a tag's name in the
  list (case-insensitively) is that note's tag.
- **Everything else stays plain frontmatter.** Other pairs, and lines that
  aren't pairs, are kept byte for byte and never shown as chips.
- **A tag's line is the first line keyed by its name.** Any later line for
  the same name stays plain frontmatter. When that first line isn't a pair
  (a list, say), the note has no value, and setting the tag replaces it.
- **A value that isn't in the list is still the note's tag.** It shows as
  marked and can be filtered on. Readers never drop it.

### Writing a note's tag

- **Set:**
  - If the note has a line for the name, replace it (and its indented run,
    if any) with `<Name as the list spells it>: <value as the list spells
    it>`.
  - If it has none, add the line just before the closing fence.
  - If there's no block, start one at the very top.
- **Line endings:** the block's own (`\r\n` when its first line has one).
- **Clear:** remove the line and its run. A block left with no lines goes,
  fences and all, unless the body would then read as a block of its own (a
  rule at its top and another below): then the empty fences stay.
- **Nothing else in the file changes.** A set followed by a clear gives back
  the original bytes.
- **Quoting:** a value is written bare unless any of these holds; then it's
  written `"…"`:
  - it contains `:` `#` `,` `[` `]` `{` `}` `"` or `'`;
  - it starts with `-` `?` `!` `&` `*` `|` `>` `%` `@`, a backtick or a
    space;
  - it's one of YAML's words: `true false yes no null ~`, in any case.

  This way YAML tools such as Obsidian read the same text Doklin does.

### The tag list

```
---
status: [Todo, Doing, Done]
priority: [p1, p2, p3, p4, p5]
---
What each tag means, for people and agents.
```

- **Where it lives:** `Library/Tags.md` in a connected workspace, or
  `Tags.md` at the top of a folder that isn't connected. It's found
  case-insensitively.
- **It's an ordinary note.** It syncs, has versions and merges. Its body is
  where people and agents learn what each value means. Everyone in a
  workspace sees Library, so everyone sees the same list.
- **Format:** one line per tag, holding a YAML flow list. Values are quoted
  by the rule above. The order of the lines is the order of the tags in
  menus, and the order of a line's values is the order of that tag's values.
- **Names:** 1–40 characters: letters, digits, spaces, `_` and `-`,
  starting with a letter or digit. Unique case-insensitively.
- **Values:** 1–60 characters on one line, with no leading or trailing space
  and no control characters. Unique case-insensitively within their tag.
- **Lines that don't parse:** readers skip them (they stay on disk). The
  worker refuses an agent write that would leave one.
- **A missing note, or one with no lines,** means the workspace has no tags.
  Pairs in notes are then plain frontmatter.
- **Matching is case-insensitive everywhere.** A note's `doing` is the
  list's `Doing`, and chips show the list's spelling.

`src/tags.ts` holds all of this for the app, the browser and the worker. The
iPhone ports it to Swift, and the Mac's search reads pairs in Rust. All three
are held to `verify-harness/tags-fixture.json` (**change all**).

## The app (Mac and browser)

- **The row:**
  - Chips sit right below `DocTitle`, in the `.doc-frontmatter` slot, in the
    list's order of tags.
  - Keys moving between the title and the body (Enter and ↓ from the title,
    ↑ and Backspace from the body's first line) skip the row, as Notion
    skips properties.
  - A chip reads `Status  Doing`, with the name muted.
  - A value that isn't in the list gets a dashed outline and a tooltip
    saying it isn't one of Status's values.
  - *+ Tag* follows the chips.
- **A note with no tags:** a faint *Add tag* appears while the pointer is
  over the top of the note, and on the Mac there's an *Add Tag…* item in the
  Edit menu.
- **A chip's menu:** the tag's values with the current one checked, then
  *Remove*, then *Edit Status…*.
- ***+ Tag*'s menu:** the tags the note doesn't have yet, each opening its
  values, and *New tag…*.
- ***New tag…*:** a name, the values one per line, and which value this
  note gets. It writes the tag list (creating `Tags.md` with one sentence
  when there's none), then the note.
- ***Edit Status…*:** rename the tag; rename, add, remove or drag values to
  reorder them; *Delete tag*. Saving writes the list, plus the renames
  described under *Renaming* below.
- **The rest of the block:** when it holds anything besides the note's
  tags, a closed *Frontmatter* disclosure under the chips shows the whole
  block as the file has it, as the iPhone does today.
- **Read-only views show chips that can't be changed:** a version preview, a
  note leased elsewhere, a split's mirror, and a companion pane until it's
  promoted.
- **No row at all:** the html view (where the title is hidden too),
  html-only documents and untitled notes.
- **The tag-list note itself** shows its block as the list: each tag with
  its values as chips and *Edit* beside it, opening the same dialogs.
- **A tag change on the open note** sets `frontmatterRef` and saves through
  `writeToDisk`, the path every edit takes (the rev guard, the sidecar
  first, a version).
- **A tag change on a note that isn't open** (a rename) reads it, rewrites
  the line and saves over the rev it read. On a conflict it reads once more,
  and failing again it reports the note in a sentence.

## Search for people

- **Syntax:** `name:value` in the search box, with quotes for spaces
  (`status:"In progress"`).
- **What counts as a tag token:** only names in the list. Any other `x:y`
  is searched as text.
- **Several tokens** are ANDed with each other and with the text.
- **Tokens only, no text:** every note with those tags, listed by name with
  no lines.
- **Where the query is split:** `searchQuery(q, list)` in `src/tags.ts`
  separates tag tokens from text. The tag tokens travel to the search apart
  from the text, so the Rust and worker sides never parse the list.
- **On each platform:**
  - **Mac:** `search_workspace` (`src-tauri/src/lib.rs`) reads pairs with
    `src-tauri/src/tags.rs`.
  - **Browser:** the worker's search route, filtered by D1 `tags`.
  - **iPhone:** `WorkspaceFiles.search`.

## Renaming

- **What gets rewritten:** renaming a value or a tag rewrites that line in
  every note holding it, found with the search above, through the save path.
  - On a Mac or iPhone, that's every note on the device: the sections it
    syncs, or, for a folder that isn't connected, that folder.
  - In a browser, it's every section the person is in.
- **Order of writes:**
  1. The list gets the new name or value beside the old one.
  2. The notes are rewritten.
  3. The old name or value leaves the list.

  A rename that stops part-way leaves both in the list, and nothing reads
  as wrong.
- **Notes in sections the person isn't in** keep the old value and show it
  marked.
- **A note being edited elsewhere is written too:** leases are advisory, and
  sync merges the line.
- **Removing a value or a tag rewrites nothing.** Notes keep the line. A
  removed value shows marked, and a removed tag's lines become plain
  frontmatter.
- **Feedback:** a toast counts the notes as they're written and names any
  note it couldn't write.

## The worker

- `src/tags.ts` is bundled into the worker, as `src/frontmatter.ts` is today.
- **D1 step 12:** `tags ((space_id, fid, name) PK, value, folded)`, indexed
  on `(space_id, name, folded)`.
  - The name is stored lowercased, and so is `folded`, the value a filter
    matches (D1's `lower()` folds ASCII alone; JavaScript's folds the rest).
  - It holds every pair of a note, not only listed tags, so a tag added to
    the list later needs no re-read.
  - The search catch-up fills and clears it beside `links`, for the same
    rows read and the same rows gone.
  - `search_state.held` already hashes the text, so nothing new decides
    when a note is stale.
- **After the deploy:** hand-run `DELETE FROM search_state` on the live D1,
  with the user's OK, so every note is read once more.
- **The agent write check** (`PUT doc` for markdown; `edit` comes through
  it):
  - A listed tag whose pair the write adds or changes must hold a value
    from the list.
  - A listed tag's line that isn't a pair is refused ("status takes one
    value").
  - A pair the write leaves as it was is never checked, so a body edit
    never fails because of a value someone removed later.
  - Each refusal is a sentence that names the allowed values and where to
    add one. `--dry-run` says the same.
- **A write to the tag list itself:** every line of its block must parse as
  a tag line, with unique names and valid values. Otherwise the write is
  refused with the line named.
- **Agent routes:**
  - `GET tags` → `{note, tags: [{name, values}]}`.
  - `POST tag {path, set: {<name>: value | null}, dryRun?}` →
    `{path, version, tags}`: the same writer and the same check, written
    over the stored rev.
  - `GET tree` and `GET search` take `where=name:value` (repeatable), and
    tree rows carry `tags`.
  - `GET doc … &info=1` carries `tags`.
- **The person route:** `GET search` takes `tag=name:value` (repeatable),
  and `tag=name` for a note that has the tag with any value (what renames
  search with). The browser already sends both since phase A
  (`src/web/backend.ts`). `q` may be empty when there is a `tag`.
- **Versions:** `WORKER_VERSION` 32 (one step from main's 31; the browser
  shell's changes ride it) and D1 schema 12.

## The CLI

- `doklin tags`: the list, and the note it lives in.
- `doklin tag <doc> status=Done [priority=p1 …]`; `status=` removes the tag.
- `doklin ls [folder] [--deep] --where status=Doing`, repeatable and ANDed;
  `doklin search <text> --where …`.
- **Where tags show up:**
  - `ls` and `info` show each document's tags;
  - `read` shows the frontmatter as it is.
- **Help:**
  - a new topic, `doklin help tags`;
  - new lines in the overview;
  - in the agent brief: set tags with `doklin tag`, using values from
    `doklin tags`; never invent a value, but ask your person or add it to
    the list.
- A worker older than 32 gives exit 7 with a sentence.

## The iPhone

- **The port:**
  `ios/DoklinKit/Sources/DoklinKit/Markdown/Tags.swift` ports pairs, the
  list, set and clear, quoting and the query split, held to the fixture
  (**change all**).
- **The reader:** chips sit directly under the title, above the who-edited
  line, so all three platforms put tags in the same place. `FrontmatterView`
  stays where it is, as the disclosure for the whole block when the block
  holds other lines.
- **The editor page:** chips show under its title field, drawn from the
  head it holds, so nothing moves when editing starts. They can't be changed
  there.
- **Changing tags:**
  - a SwiftUI `Menu` on a chip and on *+ Tag*;
  - sheets for *New tag* and *Edit tag*;
  - renames as on the Mac.
- **Saving:** a tag change saves the note (`DocumentModel.save`) with its
  new head.
- **Read-only cases:**
  - Leases are honoured: on a note held elsewhere, the chips can't be
    tapped.
  - While the editor is open the chips can't be changed, because the editor
    puts its head back on save.
- **Search:** tag tokens in `WorkspaceFiles.search`, and a name with any
  value (`TagFilter.value` null), as the Mac's has.

## Phases

Each phase ends with a commit to this branch and waits for its own
go-ahead. All of them go in one PR and one release.

- **A — the format and the app (Mac and browser):**
  - `src/tags.ts`, the fixture and `verify-harness/tags.test.mjs`;
  - the Rust pair reader and its `cargo test`;
  - the row, menus, dialogs and the tag-list note's view;
  - tag tokens in the Mac's search, and renames on the Mac;
  - `verify-harness/drive-tags.mjs`;
  - in `docs/architecture.md`, the frontmatter rules and the row in *The
    title*; and `src/frontmatter.ts`'s header comment, which says the app
    never parses the block.

  In the browser, phase A shows chips and sets tags. Its search tokens and
  renames need phase B.
- **B — the worker and the CLI:**
  - D1 step 12 and the catch-up;
  - the write check and the routes;
  - the person search's `tag=`, and the browser's search tokens and renames;
  - the CLI commands and help;
  - worker tests, CLI tests and `drive-web.mjs`;
  - `docs/cloud-people-agents.md` and `cloud-worker/README.md`.
- **C — the iPhone:**
  - the Swift port;
  - chips, menus and sheets;
  - search and renames;
  - `swift test` and a UI journey;
  - `docs/ios.md`.

## Found while building phase A

- **Opening a note can already save the editor's form of it** (a `-` list
  written back as `*`). It happens on main without tags, in the harness at
  least. A tag change never adds to it: with nothing typed it writes the new
  block over the body as the disk has it.
- **`Tags.tsx` and `tags.ts` are one file on a Mac's disk**: the row is
  `src/TagsRow.tsx`. The Swift port should mind the same.
- The Mac's Edit menu *Add Tag…* is emitted to every window with the focused
  one's label (`menu-add-tag`); the window it names opens its menu.

## Found while building phase B

- **A tag alone lists every such note**, with no limit: it costs no blob
  read, and a rename in a browser asks until nothing new turns up, which a
  cap of 30 would stop short of on a case-only rename of a tag.
- **`where` names must be listed tags** (`no_tag`, with the tags there are),
  so a typo is a sentence and not an empty listing. The person's `tag=` is
  not checked: the browser sends only listed names.
- **A worker from before tags ignores `where`** and lists everything, so
  the CLI takes `where` said back as the sign the worker knows tags, and
  exit 7 without it.
- **`POST tag` applies a request's tags in the list's order**: the CLI's
  JSON object has its keys sorted, so the order typed can't be kept.
- **A tag alone still reads the list once**, to check the names; that is
  the one blob read such a search makes.
- **The harness bundle needs `dagre-d3-es`** in a worktree, as in phase A:
  a temporary `node_modules/dagre-d3-es` link to the root's, removed after.

## Traps known before building

- **An open note's save must put back the head as it is on disk now.** The
  Mac's active pane already adopts a change that touches only the
  frontmatter. The companion pane, the browser and the iPhone editor need
  the same check, or a save there undoes a tag set elsewhere.
- **The row gets a React key of its own**, as the title has
  (`title:<tab id>`). The title and the html view are siblings in one list,
  and a shared key once showed two titles.
- **Every tag change is a write of the note:** a version in history, a sync
  push and a search re-read. A rename across 100 notes is 100 writes. On a
  Mac they go through the engine's pacing; in a browser each one is one
  request.
- **The tag list merges as text.** Two devices changing the same tag's line
  at once give a conflict copy of `Tags.md`. Readers use `Tags.md` and never
  the copy.
- **The worker's check compares with the stored text**, not with what the
  agent read. A tag someone else changed in between is the agent's change
  only if the write changes it again.
- **Notes over 1 MB** (`MAX_MIRRORED_BYTES`) aren't read by the catch-up,
  so they have no tags in the index, as they have no text in search.

## My choices, not yet confirmed

- The note's name and place: `Library/Tags.md`, or `Tags.md` at the top of
  a folder that isn't connected.
- The grammar limits: 40-character names and 60-character values.
- A new tag line goes at the end of the block, not in the list's order.
- On the Mac, the rest of the block becomes a closed disclosure, as on the
  iPhone.
- No tags on untitled notes or html-only documents.
- Case-insensitive matching of names and values, with chips showing the
  list's spelling.
- `ls` shows what the index holds and says when it's behind. `--where` waits
  for it, as `search` does.
- An agent's change to the list never rewrites notes. Renames that rewrite
  notes are the app's alone.
- A rename writes notes leased elsewhere.
- On the iPhone, chips go above the who-edited line, not below it. In its
  editor page they're shown, but can't be changed.
- At most 8 tags in one `where`; a `where` listing has no folders.
- A person's writes in a browser aren't checked against the list, as a
  Mac's syncs aren't: the picker is the only way they set a tag.
- The CLI's words: `status: Doing, priority: p1` in `ls` and `info`, and
  "(not one of its values)" beside a value the list lacks.

## Not in this plan

- The board.
- Other kinds of tags: dates, people, several values.
- Colours.
- Tags on published pages.
- Tags on html-only documents.
