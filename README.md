# Doklin — Markdown Editor

A minimal macOS desktop app (Tauri 2 + React) for editing markdown in a
Notion-style WYSIWYG editor. Files stay as plain `.md` on disk — no lock-in.

> **macOS only.** Doklin uses a few macOS-specific APIs (Trash, "Reveal in Finder",
> file associations).

## Features

- **Tabs & drafts** — open many documents at once, mixing real `.md` files with
  untitled drafts that persist across restarts and are never silently lost.
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
- **Autosave** — real files save back to the same `.md`; drafts save to app
  storage. Nothing is lost on tab switch or quit.
- **Cloud** — connect a folder to a domain of your own and it is backed up and
  kept in sync on every Mac that opens it, with version history for every
  note. The cloud is one Cloudflare Worker and one bucket on your own account,
  set up by an agent from a prompt the app writes — no dashboard, no
  terminal, no account with anyone else. Publishing is one click: a note, a
  folder, or the whole workspace gets an address on your domain, rendered
  from the synced files — boards, properties, diagrams, table widths and html
  renditions included — read-only and `noindex`, exactly as fresh as the
  sync. Stop publishing and the link stops working. How it is built:
  [docs/cloud.md](docs/cloud.md).
- **Themes** — system / light / sepia / dark.
- **Launches from Finder or the terminal** — double-click a `.md` file or folder,
  or run `doklin path/to/file.md`. A second launch talks to the running app: a
  file always opens in its own new window (never merged into an existing
  workspace window), while a folder focuses its workspace window or opens one.

## Install

One script builds the release bundle, installs `Doklin.app` to `/Applications`, and
installs the `doklin` CLI shim:

```sh
./scripts/install.sh
```

It's idempotent — re-run it any time you change the code. Prerequisites: `pnpm`
and Rust (`rustup`); the script sources `~/.cargo/env` for you.

Optional env overrides:

```sh
APP_DIR=~/Applications  ./scripts/install.sh   # install .app elsewhere
CLI_DIR=~/.local/bin    ./scripts/install.sh   # install shim elsewhere
SKIP_BUILD=1            ./scripts/install.sh   # re-install without rebuilding
SKIP_CLI=1              ./scripts/install.sh   # only the .app, no shim
```

Once installed:

```sh
doklin notes.md
doklin ~/notes                # open a folder as a workspace
doklin                        # empty editor (welcome screen)
```

Or double-click a `.md` file or folder in Finder.

---

## For agents & contributors

Deeper docs live in dedicated files to keep this page focused:

- **[docs/development.md](docs/development.md)** — how to run from source, the
  architecture (frontend/backend, Tauri commands, file association, CLI shim),
  saving/autosave internals, the macOS-only porting convention, and the full
  keyboard / UI / theme reference. **Start here for any code change.**
- **[docs/release-pipeline.md](docs/release-pipeline.md)** — the *producer* side:
  how a push to `main` becomes a signed, notarized DMG on GitHub Releases —
  the CI/CD jobs, Apple signing + notarization, the auto-update manifest, the
  secrets, a failure playbook, and a checklist for reusing the pipeline.
- **[docs/auto-update.md](docs/auto-update.md)** — the *consumer* side: the
  one-click in-app update feature — its UI flow and state machine, the
  signed-manifest architecture and why it's safe, and a **portable checklist
  for adding the same feature to another Tauri app**.
- **[docs/tabs-drafts-followups.md](docs/tabs-drafts-followups.md)** — design
  notes and deferred follow-ups for the tabs + drafts system.
- **[docs/datastores-kanban.md](docs/datastores-kanban.md)** — the design for
  structured data: *datastores* (a folder of markdown cards with frontmatter
  plus a `store.jsonl` definition), kanban and table views as a tab and as
  a ` ```kanban ` / ` ```table ` embed in notes, how it rides sync / history
  / publishing, and the phased
  plan. All four phases are built: a board from a folder, a board embedded
  in a note, the pure snapshot a published page draws from, and the second
  view with properties on any note.
- **[docs/cloud.md](docs/cloud.md)** — the cloud as built: one domain per
  workspace, a single Rust engine as the only writer, publishing as a flag
  in the workspace manifest with pages rendered from synced files, the
  agent + wrangler setup, the room left for invites and locking, and the
  decisions behind each.
- **[cloud-worker/README.md](cloud-worker/README.md)** — the worker's
  contract: the bucket, the manifest, the sync API, the public routes, and
  deploying by hand.
