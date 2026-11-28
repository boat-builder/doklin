# Boards (plan)

A design that is not built yet. Read it only to build it; delete it once it
is. Every design question in it was answered on 2026-11-27. Phase A (the
file, its sync, the worker, the Mac and the browser) is built: its rules are
in architecture.md (*Boards*), cloud.md and `cloud-worker/README.md`. What
is left is phase B, the iPhone and iPad.

## What a board is

A board is a way to look at a folder. A file in the folder, `boards.json`,
says how: by which tag (from the tag list, [architecture.md](architecture.md)
*Tags*), and in what order the cards sit. Each of the tag's values is a
column, and every document directly in the folder is a card in the column of
its value. Moving a card to another column sets the note's tag. Moving it up
or down changes only `boards.json`.

Only the apps (the Mac, the browser, the iPhone) read `boards.json`. The
data stays a folder of notes with tags: agents and the CLI never see the
file, never see a board, and work with the notes as they do today. That is
the difference from the old boards, where agents worked with a board
through an API of its own.

The file is the first way a folder can say how it is shown. Other kinds of
view can come later the same way.

Everyone who can open the folder sees the same board.

## Decided

- One tag per board. Columns are that tag's values, in the tag list's
  order.
- Cards can be put in any order within a column (a rank in `boards.json`).
- A card shows the note's title (its file name) and its other tags as grey
  chips, nothing from its body.
- Clicking a card opens the note in a tab, never in a side panel or a split.
- The iPhone gets the standard kanban: columns side by side, cards dragged
  between and within them.
- The Mac and the browser come first (phase A), the iPhone in the same
  release (phase B).
- One board per folder. `v` lets a later file hold more than one.
- Cards are keyed by file name alone. A rename made outside the apps (in
  Finder, by an agent) sends the card to the end of its column.
- A card with no rank goes after the ranked ones in its column, by name.
- Anyone who can write in the folder's section makes or changes its board.
- A list's heading (Library, My files, Shared with me) is never a board. A
  shared folder's top is a folder row, and can be one.
- "No Status" shows only when it has cards, and while a card is dragged.
- An html-only document is a card in "No Status" that can't change column.
- A browser gets every card's tags in one request, never one per card (see
  *Reading the cards*).
- Right-clicking a card gives the sidebar's menu for that file.
- Clicking a board folder's name in the sidebar opens the board; its
  chevron still opens the folder.
- The board's own order is the only order: no sort options.

## From the old boards

Kept:

- **`rank.ts`**: fractional order keys (`a0 < a0V < a1`), so placing a
  card between two others writes one key. It comes back from fa3ec28^
  as it was.
- **Pointer-based drag.** Tauri takes native drag events for its own file
  drops, so HTML5 drag-and-drop doesn't reach the page. The sidebar and the
  tab strip drag the same way.
- **Canonical bytes**: the same state always writes the same file.
- **A visible file, never a dotfile**: dotfiles never sync.
- **The sidebar row opens the board.**
- **The board's look** (header, tinted columns) from the UI refresh,
  minus the card excerpts.

Not coming back, in any form:

- fields, typed properties, options and colours;
- saved views, filters and sorts;
- `rank` lines in notes;
- the card peek;
- boards inside notes, and boards on published pages;
- `doklin board`, and D1 `board_cards`.

## `boards.json`

### The format

```json
{
  "doklin": "boards",
  "v": 1,
  "tag": "Status",
  "cards": {
    "Fix the login.md": { "rank": "a0" },
    "Write the docs.md": { "rank": "a0V" }
  }
}
```

- **`doklin` and `v`** mark the file as Doklin's, as the sidecar's header
  does. A `boards.json` without them, with a `v` this app doesn't know, or
  that isn't JSON makes no board. The folder shows as a folder, and the app
  never rewrites or deletes the file. A newer `v` says so in a sentence
  where *Show as Board…* would be.
- **`tag`** is the tag's name as the list spelled it when it was chosen,
  matched case-insensitively.
- **`cards`** is keyed by a card's file name in the folder, extension
  included, matched case-insensitively. `rank` is a
  `rank.ts` key. A card with no entry has no rank.
- **Keys this app doesn't know are kept as they are**, at the top level and
  in a card's record, so a newer app's fields survive an older app's write.
- **Canonical bytes** (`serializeBoards`): keys in the order above, then
  unknown keys sorted; cards sorted by name; two-space indent, one card per
  line; a final newline. A merge the engine writes and one a browser writes
  are the same file.

### Where it is, and what follows from that

- **`<folder>/boards.json`**, found whatever its case. It is listed in the
  sidebar only under *Show all files*, as a file that isn't a document.
- **Because it is a file in the folder,** it moves, copies and goes to the
  Trash with the folder. It syncs, comes back with the folder's history
  (versions take every file that syncs), and works the same in Library,
  Private, a restricted folder and a folder that isn't connected.
- **A section's own folder** never holds one: its heading isn't a row.

### It syncs, and merges by record

- **`syncs` takes a file named exactly `boards.json`, in any case,**
  besides the documents and their sidecars (`engine/src/lib.rs` ⇄
  `cloud-worker/src/layout.ts`: change both).
- **It merges by record, never as text, and never gets a conflict copy.**
  A conflict copy, `boards (conflict — …).json`, would be a name that
  doesn't sync. The records are `tag`, each unknown top-level key and each
  card. A record changed on one side is that side's, one changed on both
  is this side's, and a deletion sticks unless the other side changed what
  was deleted. That is the sidecar's `merge_keyed`, done by a new
  `engine/src/boards.rs` and by the browser's `mergeBoards`
  (`src/web/merge.ts`, beside `mergeMeta`). Change both; the fixture holds
  them to one answer.

### Agents never see it

- The worker stores it and syncs it like any file. Every agent surface
  leaves it out: `tree`/`ls`, `read`, `info`, `find`, search and its index,
  the tags index, comments and publishing. It can't be named as a document
  (it has no document extension), so no agent can read or write it.
- **What agents do to the folder takes it along:** a folder `mv` within a
  section or to another one, `cp`, `rm`. The worker's folder moves, copies
  and deletes (`changes.ts`) handle every file under the folder, not only
  documents.
- A note an agent adds has no rank, and a tag it sets moves the card.
  Nothing else is needed for agents.

### Versions

- **`MANIFEST_VERSION` 5 → 6** (on top of the sharing release's 5). The
  manifest's shape doesn't change. What
  changes is what may be in it: a v4 engine drops every path `syncs`
  refuses from the manifests it writes (`unit.rs`, *only what syncs is in a
  manifest*), so an older app would delete every board for everyone.
  At v6 the worker refuses it with its `426` sentence until it is updated.
  The same `426` stops a new app talking to a worker that doesn't take
  `boards.json` yet. So the release is mandatory in effect, for the Mac and
  the iPhone alike.
- **`WORKER_VERSION` 37**, one past the sharing release's 36, once for the
  release. It also ships the browser's board.
- No D1 step.

## The rules of a board (`src/boards.ts`)

A new `src/boards.ts` holds the format and what follows from it: parse,
`serializeBoards`, the columns from the tag list and the cards, where a
drop puts a card, and keys renamed and pruned. The iPhone ports it as
`Markdown/Boards.swift`, and the engine's `boards.rs` merges it.
`verify-harness/boards-fixture.json` holds all three to one answer:
change all three.

- **Columns:**
  - one per value of the tag, in the list's order;
  - "No Status" first (named for the tag), holding the notes with no value
    for it;
  - a column of its own, after the listed ones, for each value a note has
    that the list lacks, marked as the chip marks it. Readers never drop a
    value.
  - When the tag isn't in the list (deleted, or never there), the board
    says so in a sentence and offers *Group by ▾*.
- **Order within a column:** ranked cards by rank, then cards with no rank
  by name.
- **A drop:**
  - gives the card a rank between its new neighbours;
  - first ranks the unranked cards of that column, in the order shown, so
    what you see is what stays. Both are one write of `boards.json`.
  - A drop into another column also sets the tag: the note is written
    first, then `boards.json`.
- **Keys follow the apps' own changes:** a rename or move made in a Doklin
  app rewrites the card's key in the same step. A key whose file is gone is
  dropped at the next write. A rename made elsewhere (Finder, an agent)
  leaves the card unranked, so it goes to the end of its column.

## The board, on the Mac and in a browser

`src/Board.tsx` draws it; the UI is in `src/`, so both get it.

### A tab of its own

- **A new tab kind, `board`, with the folder's path** (`src/tabs.ts`). It
  is stored with the session, follows moves as a file tab does, and goes
  ghost when the folder is missing or is no longer a board. Its label is
  the folder's name with a board glyph. The document machinery stands down
  for it: no editor, no autosave.
- **The header:**
  - the folder's name;
  - *Group by ▾*, listing the tags in the list's order;
  - *Show as Folder*, which deletes `boards.json` (the folder's history
    keeps it) and closes the tab.

### Cards

- **Every document directly in the folder is a card.** Subfolders and the
  notes inside them are not on the board: the sidebar still lists them.
- **An html-only document** can't have tags, so it sits in "No Status".
  It can be reordered there, never moved to another column.
- **A card that can't change columns is read-only for that**, and says why
  on hover: another device holds the note (its lease), the person may not
  write in the section, or the note can't be read. Reordering it is still
  fine, since that writes only `boards.json`.

### What you can do

- **Click a card:** the note opens in its own tab, placed right after the
  board's tab, and takes the focus. If the note already has a tab, that tab
  comes forward. Closing it goes back to the board, as a browser goes back
  to the tab that opened another.
- **⌘-click a card:** the note opens in a tab behind and the board keeps
  the focus, as with ⌘-click on a link (`openBeside`).
- **Drag a card**, within a column or to another one, as the rules above
  say.
  - The tag is set through the code a tag chip uses: the note's save path
    when it is open, else a read and a write over the rev it read, once
    more on a conflict.
  - The card moves at once and moves back, with a sentence, if a write is
    refused.
- **"+ New" at the foot of a column:**
  - makes "Untitled" (then "Untitled 2", …) in the folder, with the
    column's value and a rank at the column's end;
  - opens it in its own tab with the caret in the title, as the sidebar's
    New Document does;
  - in "No Status", makes a note with no tag.
- **Right-click a card:** the sidebar's menu for that file (rename, copy
  path, move to Trash, …), with no items of the board's own.

### The sidebar

- **A board folder's row has a board glyph.** Clicking its name opens the
  board (or brings its tab forward). The chevron still opens the folder,
  and its notes list as they do today: the folder stays a folder.
- **A folder's menu gets *Show as Board…***, a small dialog listing the
  tags. With no tags yet, it offers *New tag…* (`TagDialogs.tsx`) and
  continues with the tag that was made. On a board folder the item reads
  *Show as Folder*.

### Reading and writing it

- **A new `Boards` interface on `backend.ts`:**
  - read a folder's `boards.json` with its rev;
  - write it over a rev, which rejects with `SaveConflict`;
  - delete it;
  - list every board folder under a root (for a tag rename).
- **The Mac's backend** reads and writes the file in Rust under the same
  rev guard as a document. Each write ends with `edits::touched`, so the
  engine and the versioner hear it.
- **The browser** reads it as it reads any file of a manifest it holds.
  It writes through one new route, `PUT /api/web/board?space=&path=<folder>
  {text, ifRev}` → `{rev, etag, over}`, with `409 {rev}` when the file moved
  on. The browser then merges (`mergeBoards`) and writes again.
  `DELETE /api/web/board` is *Show as Folder*.
- **Kept live:** the board reads the file and its cards again whenever the
  tree is read again (an edit here, a sync, an agent's write, a move).
- **Reading the cards:**
  - **Names cost nothing.** They come from the folder's listing, the one
    the sidebar already has: the disk on a Mac or an iPhone, the manifests
    a browser holds. No device asks for anything per file.
  - **What the board needs beyond names is each note's tags,** which are in
    its text.
  - **A Mac or an iPhone** reads each card's frontmatter block from its own
    disk, through one new backend call. That makes no request.
  - **A browser asks the worker once for the whole folder:**
    `GET /api/web/tags?space=&dir=` → `{notes: {<fid>: [{name, value}]}}`.
    It answers every markdown note directly in the folder with its pairs
    for the listed tags, from D1 `tags`, the index `ls` already answers
    tags from (`pairsIn`).
  - **Notes the index hasn't read since they changed are read first,** as
    a search with `where` catches up: a few inline, else `202 {indexing,
    pending}` and the browser asks again. A Mac's saves never update the
    index; a browser's own writes already do.
  - **A board of 500 cards is one request.** Each refresh is one more, made
    only when the folder's files changed in the manifest. `boards.json` is
    one read.

## Tags and boards

- **Renaming a tag** also rewrites every `boards.json` that names it, after
  the notes are rewritten and before the old name leaves the list (the
  rename writes the list twice). The Mac and the browser do this in the tag
  rename in `App.tsx`, the iPhone in `Workspace.renameInNotes`.
- **Renaming a value** rewrites the notes as today; cards keep their ranks,
  which are keyed by name. Columns follow the list.
- **Removing a value** leaves its notes with it: they show in a marked
  column.
- **Deleting a tag** leaves its boards asking for another one.
- **Reordering a tag's values** reorders the columns of every board that
  uses it.

## The iPhone and iPad (phase B)

The standard kanban, as phone apps for boards do it:

- **A board folder's screen is the board** (the sharing release deleted
  `FolderView`: check where a folder's list is shown now). Columns sit side
  by side and the board scrolls sideways, each column scrolling down on its
  own.
  - On an iPhone a column is most of the screen's width, so the next one
    shows at the edge.
  - On an iPad several fit, as on a Mac.
  - The value and the count head each column.
- **Tap a card** to open the note, as the folder's list does today.
- **Hold a card and move it** to drag it, within its column or to another
  one. Near the screen's edge the board scrolls to the next column. The
  same rules apply as on the Mac.
- **Hold a card without moving** for its menu: *Move to ▸* (the listed
  values and "No Status": the way to move a card without dragging, and
  VoiceOver's) and the folder list's own items for the file.
- **"+ New" at the foot of each column**, as on the Mac. It opens the new
  note to be named, as *New note* does.
- **The board's toolbar menu:** *Group by ▸* and *Show as Folder*. A
  folder's menu gets *Show as Board…*.
- **The code:**
  - `Markdown/Boards.swift` ports `src/boards.ts` and `rank.ts`, held to
    the fixture.
  - The file is read and written as the iPhone reads and writes notes. Its
    engine is the same crate, so it syncs and merges it with no Swift of
    its own.

## Out of scope

- more than one tag per board, and more than one board per folder;
- cards from subfolders;
- card previews or covers;
- side panels and card peeks;
- boards inside notes or on published pages;
- a board's own description;
- per-person boards;
- sort options other than the board's own order;
- anything an agent or the CLI can see.

## Phases and tests

- **Phase B:** the iPhone and iPad, with `BoardUITests` (run by `ios.yml`
  on the PR).
- **Docs** once built: the iPhone's rules into docs/ios.md. This file is
  deleted.
