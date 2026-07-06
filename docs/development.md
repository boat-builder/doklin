# Doklin — Development & internals

Architecture, saving internals, and the full keyboard / UI / theme reference.
Start here for any code change. For the share backend see
[../share-worker/README.md](../share-worker/README.md); for tabs/drafts design
notes see [tabs-drafts-followups.md](tabs-drafts-followups.md).

## Run from source

```sh
pnpm install
pnpm tauri dev
```

To build and install the app + `doklin` CLI shim, use `./scripts/install.sh` (see
the top-level [README](../README.md#install)).

## Platform (macOS only)

Doklin currently targets macOS and uses a few macOS-specific APIs (Trash via
`NSFileManager`, "Reveal in Finder", file associations). Every such spot in the
Rust backend is tagged with the comment `macOS-only`:

```sh
grep -r "macOS-only" src-tauri
```

Grep for that tag to find every place that needs attention if you ever port it
to another OS.

## Architecture

- **Frontend**: React + Vite + Milkdown Crepe (`@milkdown/crepe`). Crepe is Milkdown's batteries-included preset — slash menu, block handles, toolbar, Notion-like keyboard shortcuts.
- **Backend**: Tauri 2 (Rust). Commands: `read_file`, `write_file`, `list_md_tree` (walks a directory, returning every non-hidden folder plus the markdown files inside — empty folders stay visible so they can be creation targets), `create_file`/`create_dir` (fail if the name is taken; backing for the sidebar's inline New File/New Folder), `move_path` (rename/move via `fs::rename`, refusing to clobber an existing destination except a case-only rename; backing for the sidebar's inline Rename and drag-to-move), `reveal_in_finder`, the draft lifecycle (`create_draft`, `list_drafts`, `delete_draft`, `migrate_scratch`), trash (`trash_file`/`restore_trashed`), plus pending-open hand-off for the initial CLI args. `RunEvent::Opened` handles macOS open events for both files and folders. `tauri-plugin-single-instance` forwards CLI argv from a second `doklin` invocation into the running window.
- **File association**: Declared in `src-tauri/tauri.conf.json` under `bundle.fileAssociations`. Tauri injects `CFBundleDocumentTypes` into `Info.plist` at bundle time.
- **CLI**: `scripts/install.sh` writes a small `doklin` shell shim that calls `open -a Doklin --args <files>`. macOS routes argv through LaunchServices to the bundled app.

## Saving

Both real files and drafts auto-save 600ms after the last keystroke — files to
their path, drafts to `app_data_dir/drafts/<id>.md`. For a real file `⌘S` just
flushes the pending write; for a draft it promotes the draft into a real `.md`
file (removing the draft). Where the promotion happens is VS Code-style:

- **Workspace open** — no Finder navigation. An in-app prompt asks only for a
  name (pre-filled from the note's first line) and saves straight into the
  context folder: the sidebar's selected folder, the selected file's folder,
  or the workspace root. Name collisions are refused inline; a *Choose
  location…* link falls back to the native dialog for saving outside the
  workspace.
- **No workspace** — the native Save dialog picks the location.

Switching tabs and quitting also flush, so unsaved keystrokes aren't lost.

## Keyboard

- `⌘N` / `⌘T` — new untitled draft (in a new tab)
- `⌘W` — close the current tab
- `⌘S` — flush the current file, or Save As to promote a draft
- `⌘O` — open a file (in a new tab)
- `⌘⇧O` — open a folder as a workspace
- `⌘\` — toggle the file sidebar (only when a workspace is open)
- `⌘⇧D` — toggle the drafts panel
- `⌘Z` / `⌘⇧Z` — undo / redo (also `⌘Y` for redo). `⌘Z` outside the editor
  restores a file deleted with `⌘⌫` from the sidebar.
- All Milkdown/Crepe inline-format shortcuts: `⌘B` bold, `⌘I` italic, `⌘K` link, etc.
- `/` on a new line — slash menu (headings, lists, code blocks, tables, …)

## UI elements

- **Tab bar** — one row below the title strip; one tab per open document (drafts
  and files), with a close `×` and a trailing `+` for a new draft. Middle-click
  or `⌘W` closes a tab.
- **Welcome screen** — shown when no document is open, or when the active tab is
  an empty draft. Buttons for *New note*, *Open file*, and *Open folder*.
- **Drafts panel** (`⌘⇧D`) — a left panel listing every draft with a one-line
  preview, independent of any workspace. Click to open/switch to a draft; the
  trash icon discards one. The active draft is highlighted.
- **Sidebar** (`⌘\`, when a workspace is open) — collapsible tree of folders and
  `.md` files under the workspace root, to the right of the drafts panel.
  Clicking a row selects it (VS Code-style); the selection is the creation
  context for new files. Right-clicking a row (or empty space) opens a context
  menu: *New File…* / *New Folder…* create inline — an input row appears in the
  target folder (inside a right-clicked folder, next to a right-clicked file, at
  the root from empty space); Enter commits, Esc cancels, and new files get
  `.md` appended and open in a tab. Files and folders also get *Rename…*
  (inline, same input row — open tabs, the autosave target, and shares follow
  the new path) and *Delete* (to the Trash; deleting a folder closes any tabs
  inside it, and `⌘Z` restores + reopens them); everything gets *Reveal in
  Finder*. Rows can be dragged to move them (pointer-based, like the tab bar —
  Tauri intercepts HTML5 drag): drop on a folder (or on a file, targeting its
  folder) to move into it, or on empty space to move to the workspace root. A
  ghost pill follows the pointer showing the item and destination, the target
  folder is ringed, hovering a collapsed folder springs it open, the tree
  auto-scrolls near its edges, and Esc cancels. Drops that wouldn't move
  anything (same folder, a folder into itself) are refused with a not-allowed
  cursor. The header has new-file/new-folder
  buttons that act on the current selection. The folder name at the top is a
  menu: *Open folder…*, *Open file…*, *Reveal in Finder*. A refresh button next
  to it re-scans the workspace, and the tree auto-refreshes on window focus.
- **Top-left** — toggles for the drafts panel and (when a workspace is open) the
  file sidebar.
- **Bottom-left** — a small gear button opens a settings popover with file
  actions and the appearance picker.

The open tabs + active tab, last opened workspace, panel visibility, and draft
metadata are remembered in `localStorage` and restored on next launch.

## Themes

- **system** (default) — follows macOS appearance.
- **light** — Notion-style pure white (`#ffffff`) with warm-dark text (`#37352f`).
- **sepia** — paper / iA Writer feel, cream (`#faf5ed`) on warm-dark — easier on
  the eyes than pure white in bright rooms.
- **dark** — low-contrast dark gray (`#191919`/`#ebebeb`).

Theme is persisted to `localStorage` under `doklin:theme`.
