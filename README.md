# Doklin — Markdown Editor

A minimal macOS desktop app (Tauri 2 + React) for editing markdown in a
Notion-style WYSIWYG editor. Files stay as plain `.md` on disk — no lock-in.

> **macOS only.** Doklin uses a few macOS-specific APIs (Trash, "Reveal in Finder",
> file associations).

## Features

- **Tabs & untitled notes** — open many documents at once. `⌘N` starts an
  untitled note that is *unsaved* until you give it a file: closing it asks
  first, quitting doesn't — it is back, still unsaved, the next time you open
  the app.
- **Live block editing** — Notion-like WYSIWYG (Milkdown / Crepe): `# ` becomes a
  heading, `**bold**` bolds inline, `[ ] ` starts a GitHub-style checklist you
  tick by clicking the box, `/` opens a block menu, plus drag handles and a
  lossless markdown round-trip.
- **Mermaid diagrams** — a ` ```mermaid ` code block (or `/diagram`) shows the
  rendered diagram, not the code: flowcharts, sequence/state/class diagrams,
  pies, gantts, … A *Source* chip (or just arrowing the caret in) flips the
  block to its code; leaving it flips back to the diagram. Diagrams are drawn
  in the app's own palette (all four themes), and the document stays plain
  markdown.
- **Links that go somewhere** — click a link to follow it, the way you would in
  Notion: a web address opens in your browser, an address next door
  (`[the plan](./plan.md)`) opens that note in a tab, and a `#heading` jumps
  down the page. Hovering shows the URL with edit/copy/remove, so changing a
  link never means opening it — and `⌘`-click puts the caret in the link text
  when you want to type there.
- **Boards** — a folder of notes can be a kanban board. Right-click a folder for
  *Turn into Board* (or *New Board…* for a fresh one) and the sidebar row opens
  a board instead of expanding: one card per note, columns from a `Status`
  property, drag to move. A card is an ordinary `.md` note whose properties are
  YAML frontmatter at the top, so vim, Obsidian, and GitHub read the same files
  — and the board's own columns live in a plain-text `store.jsonl` beside them.
  Nothing about a board is binary, and nothing needs Doklin to read. The same
  cards also show as a **table**, and the strip above the board switches
  between the views you save: each one keeps its own filter, sort, columns and
  properties, and *Export as CSV…* writes out exactly what it shows. Clicking a
  card **peeks** it beside the board — its properties above its body, editable,
  with *Open in a tab* for when it turns out to be the document you came for.
  A board also goes **inside a note**: `/board` in the slash menu drops a
  ` ```kanban ` block (or `/board` → *Board as a table* for a ` ```table ` one)
  that names a folder, and the note shows that view in the middle of the prose
  — live, not a picture. Every other markdown tool shows the block as three
  lines of config and leaves it alone.
- **Properties on any note** — every document has a quiet properties header
  above it. On a card the rows are its board's fields; on any other note they
  are the frontmatter keys the file already carries, including ones written by
  another tool. *Add property* adds a key to a note, or declares a field on the
  whole board when the note is a card. A note with no properties shows nothing
  until you go looking.
- **Folder workspaces** — open a directory to get a collapsible sidebar of its
  markdown files, with VS Code-style file management: create, rename, and
  delete files and folders from the context menu, and drag rows onto a folder
  (or empty space) to move them.
- **Autosave** — real files save back to the same `.md`; untitled notes save to app
  storage. Nothing is lost on tab switch or quit.
- **Version history** — every folder you open keeps its own history, cloud or
  no cloud: ⌘⌥H (or *Version history…* on a file) opens a rail of versions
  grouped by day, shows any of them in place, read-only, and restores or
  copies it out. A restore is itself a version, so it can be undone. Name a
  version and it is kept for good. Connect the folder and that history is
  mirrored to your own domain, so it outlives the laptop and every Mac sees
  what the others wrote.
- **The folder as it was** — *Workspace history…* on the sidebar's root is a
  timeline of the whole folder: pick a moment and it says exactly what
  restoring it would change, bring back and move to the Trash, file by file,
  before anything happens. A snapshot of now is taken first, so it can be
  undone. Delete a note and *Recently deleted* appears at the foot of the
  sidebar — with its old folder, when it was last seen, a read-only look at
  what it held, and one click to put it back, history and all. It works
  after the Trash has been emptied, and for a note deleted on another Mac:
  the store is not the Trash.
- **How much to keep, and a copy you own** — the gear's *Versions* says how
  far back each folder keeps (thirty days, ninety, a year, forever), what
  that costs on disk, and the same for your domain when the folder is
  connected. *Export…* writes one plain `tar.gz` holding the folder as it is
  now and its whole history — nothing needs Doklin to open it, which is the
  answer to "what if the cloud goes away".
- **Cloud** — connect a folder to a domain of your own and it is backed up and
  kept in sync on every Mac that opens it, with version history for every
  note. The cloud is one Cloudflare Worker with one bucket and one database
  on your own account, set up by an agent from a prompt the app writes — no
  dashboard, no terminal, no account with anyone else. Publishing is one click: a note, a
  folder, or the whole workspace gets an address on your domain, rendered
  from the synced files — boards, properties, diagrams, table widths and html
  renditions included — read-only and `noindex`, exactly as fresh as the
  sync. Stop publishing and the link stops working. How it is built:
  [docs/cloud.md](docs/cloud.md).
- **Agents** — a bot on another computer can work with a connected workspace
  without a copy of it. Add an agent under *Cloud → Agents*, tick what it may
  do — read, comment, edit, publish — and hand over the short prompt the app
  shows: it says what Doklin is and carries the two commands, one that
  installs `doklin` (Linux or macOS) and one that logs it in. From there it lists, reads, writes, searches, comments on and
  publishes documents through your domain, and what it changes arrives in
  the app like an edit from another Mac, signed with its name. A note and the
  html page made from it are one document to it, and its comments open in
  the app's comment rail. `doklin help agent` is the brief an agent reads
  once.
- **Themes** — system / light / sepia / dark.
- **Launches from Finder or the terminal** — double-click a `.md` file or folder,
  or run `doklin path/to/file.md`. A second launch talks to the running app: a
  file always opens in its own new window (never merged into an existing
  workspace window), while a folder focuses its workspace window or opens one.

## Install

One script builds the release bundle, installs `Doklin.app` to `/Applications`, and
installs the `doklin` command:

```sh
./scripts/install.sh
```

It's idempotent — re-run it any time you change the code. Prerequisites: `pnpm`
and Rust (`rustup`); the script sources `~/.cargo/env` for you.

Optional env overrides:

```sh
APP_DIR=~/Applications  ./scripts/install.sh   # install .app elsewhere
CLI_DIR=~/.local/bin    ./scripts/install.sh   # install the command elsewhere
SKIP_BUILD=1            ./scripts/install.sh   # re-install without rebuilding
SKIP_CLI=1              ./scripts/install.sh   # only the .app, no command
```

Once installed:

```sh
doklin notes.md
doklin ~/notes                # open a folder as a workspace
doklin                        # empty editor (welcome screen)
doklin help                   # the commands that work with a connected workspace from anywhere
```

Or double-click a `.md` file or folder in Finder.

---

## For agents & contributors

[CLAUDE.md](CLAUDE.md) has the commands, the house rules and which doc in
[docs/](docs/) covers which part of the code.
