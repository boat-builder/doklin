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
- **Mermaid diagrams** — a ` ```mermaid ` code block (or `/diagram`) renders
  live as you type: flowcharts, sequence/state/class diagrams, pies, gantts, …
  Diagrams are drawn in the app's own palette (all four themes), the document
  stays plain markdown, and shared pages render them too — the reading view,
  the web editor, everywhere.
- **Folder workspaces** — open a directory to get a collapsible sidebar of its
  markdown files, with VS Code-style file management: create, rename, and
  delete files and folders from the context menu, and drag rows onto a folder
  (or empty space) to move them.
- **Autosave** — real files save back to the same `.md`; drafts save to app
  storage. Nothing is lost on tab switch or quit.
- **Publish & share** — one click publishes a document as a public web page,
  backed by a self-hostable backend. Any page or shared folder can be put
  behind named access codes — one code per person or group, individually
  revocable; visitors enter it once per browser, no accounts involved. Each
  code also carries a role: view only (the default — every public page stays
  read-only unless you say otherwise), comment (a comments section right on
  the page), or edit (a web markdown editor). Web edits flow back into the
  local file; if both sides changed, the app asks before either version wins.
- **Cloud sync** — sync a workspace to that same backend (your own Cloudflare
  worker + R2 bucket): it backs up automatically, follows you to another Mac,
  and can be shared with people you invite — they install Doklin, paste a
  one-time invite link, and the workspace syncs to their machine with edits
  flowing both ways. Concurrent edits merge; overlapping ones become a
  conflict copy; every revision stays restorable from per-file version
  history. No accounts — invites mint per-device tokens the owner can revoke.
  Public shares sync too: everyone in the workspace sees what's published
  (no accidental duplicate pages), and whoever edits a shared document keeps
  its public page fresh — the original sharer doesn't have to be online.
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
