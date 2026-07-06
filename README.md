# Doklin — Markdown Editor

A minimal macOS desktop app (Tauri 2 + React) for editing markdown in a
Notion-style WYSIWYG editor. Files stay as plain `.md` on disk — no lock-in.

> **macOS only.** Doklin uses a few macOS-specific APIs (Trash, "Reveal in Finder",
> file associations).

## Features

- **Tabs & drafts** — open many documents at once, mixing real `.md` files with
  untitled drafts that persist across restarts and are never silently lost.
- **Live block editing** — Notion-like WYSIWYG (Milkdown / Crepe): `# ` becomes a
  heading, `**bold**` bolds inline, `/` opens a block menu, plus drag handles and
  a lossless markdown round-trip.
- **Folder workspaces** — open a directory to get a collapsible sidebar of its
  markdown files, with VS Code-style file management: create, rename, and
  delete files and folders from the context menu, and drag rows onto a folder
  (or empty space) to move them.
- **Autosave** — real files save back to the same `.md`; drafts save to app
  storage. Nothing is lost on tab switch or quit.
- **Publish & share** — one click publishes a document as a public web page,
  backed by a self-hostable backend.
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
- **[share-worker/README.md](share-worker/README.md)** — the share backend: how
  publishing works, the storage layout, the API contract, and
  **[step-by-step setup of your own backend](share-worker/README.md#set-up-your-own-backend)**
  (Cloudflare Worker + R2; a compatible backend on any other stack also works).
- **[docs/tabs-drafts-followups.md](docs/tabs-drafts-followups.md)** — design
  notes and deferred follow-ups for the tabs + drafts system.
