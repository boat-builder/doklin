# Doklin — Development & internals

Architecture, saving internals, and the full keyboard / UI / theme reference.
Start here for any code change. For the cloud (in rebuild) see
[cloud-redesign.md](cloud-redesign.md); for the in-app updater and the release
pipeline see
[auto-update.md](auto-update.md); for tabs/drafts design notes see
[tabs-drafts-followups.md](tabs-drafts-followups.md).

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
- **Mermaid diagrams**: a ` ```mermaid ` code block renders through Crepe's code-block preview hook (`codeBlockConfig.renderPreview`, chained in `Editor.tsx` in front of the stock LaTeX handler). A diagram block is two-state, never source and diagram stacked: at rest it shows the diagram alone; the *Source* chip riding the diagram (or moving the caret into the block) switches to the source alone, and leaving the block switches back. The states are CSS in `App.css`, keyed on `:focus-within` plus a `.dk-mermaid-editing` bridge class that `src/mermaid.ts` manages through delegated handlers (a `display:none` editor can't receive the focus that would reveal it — and the chip suppresses its own mousedown so it doesn't flip `:focus-within` mid-click and dodge the click). `src/mermaid.ts` owns the rest of the pipeline: on-demand loading (the npm package as a lazy vite chunk), a debounced render queue with memoization, quiet inline error cards for sources that don't parse, and re-rendering every live diagram when the theme flips. `src/mermaidTheme.ts` derives the full mermaid palette from the surrounding page's tokens (`--app-*` in the app; a public page's static view feeds it its own tokens again, see [cloud-redesign.md](cloud-redesign.md)). The same module adds `mermaid` to the code block's language picker (with a small hand-rolled CodeMirror highlighter) and `Editor.tsx` adds a "Diagram" slash-menu item. One gotcha, fixed in `App.css` (and to repeat in any page stylesheet that renders diagrams): page-level `p` styling must be reset inside `.dk-mermaid`, because mermaid measures HTML labels outside that cascade — a mismatch clips the label boxes.
- **Links**: the editor surface is `contenteditable`, where browsers deliberately don't follow links (a click places the caret), so following one is a plugin: `src/linkOpen.ts`. It mirrors Notion — a plain left click follows the link, while a modifier-click, a drag, or the second half of a double click falls through to the normal caret/selection behavior (that, or arrowing in, is how you get the caret *into* link text; editing a link never needs it opened, since Crepe's hover tooltip already carries copy/edit/remove). A followed click always `preventDefault`s: in the desktop webview a navigation would replace Doklin itself with the site. In-document `#anchors` never leave the editor — the plugin scrolls to the heading whose id (or GitHub-style slug) matches, without moving the selection. Everything else is handed to the host as the raw href: `App.tsx`'s `followDocLink` sends `http(s)`/`mailto:` to `open_external` and resolves anything path-shaped through `src/docLinks.ts` (relative to the note, `.` / `..` folded, fragment dropped) into a tab when the file exists — Notion's internal-page link, applied to a folder of markdown. Other schemes and non-document targets are dropped rather than guessed at. `openInBrowserTab` is the host-less fallback: it opens a browser tab for the schemes a page link may carry and nothing else (a `javascript:` href must never run). The html rendition has its own path — `htmlBridge.ts` posts link clicks out of the sandboxed frame to the same `open_external`.
- **Datastores & kanban boards**: a folder with a `store.jsonl` in it is a *datastore* — a board. One markdown file per card, the card's properties as YAML-style frontmatter at the top of its note, and the definition file holding what isn't any one card's business (the fields, the select options that are the board's columns with their order and colour, the saved views). `src/store/` is the model: `frontmatter.ts` (a strict documented subset of YAML — flat properties only, anything else kept as an *opaque* line and re-emitted verbatim; the serializer is canonical so equal state produces equal bytes on every device), `storeFile.ts` (the JSONL definition, same one-record-per-line discipline as `metaFile.ts` and for the same merge reason), `rank.ts` (fractional indexing, so moving one card rewrites one line in one file), and `model.ts` (one instance per folder path, a cache of disk, every mutation a write followed by a rescan). `StoreView.tsx` is the shell every view sits in — it holds the model, decides which saved view is on screen, and draws the heading, the view strip (one chip per saved view, `+` for a new board or table) and the **View** panel (group-by, sort, filter, which properties show, which columns are hidden, CSV export, delete this view); `KanbanBoard.tsx` and `TableView.tsx` draw what is under it, both from the same pure derivation in `store/board.ts` so they can never disagree. A view's own settings are a line of `store.jsonl` and therefore everyone's, so only a TAB offers the panel; an embed shows the one view its fence names and changes nothing. The sidebar draws a board as ONE row with no disclosure (the backend returns no children for a store folder — a board can hold hundreds of cards) that opens a `store` tab, and highlights that row while any card inside it is the focused tab. The rule the whole thing rests on is the **frontmatter boundary**: Milkdown never sees a document's frontmatter block. `loadActiveContent` splits it off and keeps it in a ref, `writeToDisk` puts it back byte for byte, and the backend's `write_frontmatter` splices a new block onto whatever body is on disk *at that moment* — so a board's drag can't lose a keystroke an open tab hasn't flushed, a prose edit can't rewrite someone's `aliases:` line, and a properties-only change arriving from outside (another window, a board, cloud sync) is adopted without touching the editor or its caret. The header serves EVERY note, not only a card: a card's rows are its board's fields, any other note's are the keys its own file carries, and *Add property* declares a field on the store for a card or adds a key for a plain note (a property with no value yet is a row, never a line in the file — so a note with no frontmatter still never grows one by accident). `PropertyControl.tsx` is the one pill a header row and a table cell share. Clicking a card **peeks** it — `CardPeek.tsx`, a panel beside the board with the card's properties above an editable body, and *Open in a tab* beside it; a card already open in a tab goes to the tab instead, which is the better answer and removes the only race a peek could cause. The peek writes each half of a card through its own guarded splice (`write_frontmatter` for the block, `write_body` for the body), so a sentence typed in the peek and a card dragged on the board behind it cannot lose each other. A store also **embeds in a note**: `storeEmbed.ts` claims a ` ```kanban ` or ` ```table ` fenced block (a `$remark` transform retypes the mdast `code` node, a `$nodeSchema` atom holds the fence's config text and its language, a `$view` node view mounts `StoreEmbed.tsx` inside a `contenteditable=false` frame whose `stopEvent` answers true for everything and `ignoreMutation` always) — so the view's inputs never reach ProseMirror and the fence round-trips byte for byte through every autosave, in the language it was written in. The fence's LANGUAGE decides the view kind; the config's `view:` only picks which saved view of that kind. `store/embedConfig.ts` is the pure half: the config dialect (the same grammar as frontmatter, via `parseProps`), the fence text, and `storeFences` — the scan that finds a document's fences in its raw bytes (no parsed document needed). `store/board.ts` holds the pure derivation (`boardColumns`, `cardChips`, `applyFilter`, `sortCards`, and the `boardSnapshot` they feed) — one derivation for the tab, the embed and, in the cloud rewrite, the published page the worker renders from synced files ([cloud-redesign.md](cloud-redesign.md) §5.6), so none of them can disagree. `store/csv.ts` is the export: what the view shows, in the order it shows it, RFC 4180 with CRLF. Design and the phased plan: [datastores-kanban.md](datastores-kanban.md); all four phases are built.
- **Backend**: Tauri 2 (Rust). Commands: `read_file`, `write_file`, `list_md_tree` (walks a directory, returning every non-hidden folder plus the markdown files inside — empty folders stay visible so they can be creation targets; a datastore folder is marked `store: true` and returns no children), `read_store`/`write_frontmatter`/`write_body`/`create_card`/`watch_dir`/`unwatch_dir` (the datastore surface — `src-tauri/src/store.rs`; Rust only finds fences and moves bytes, the frontmatter dialect is parsed in TypeScript alone. `write_frontmatter` and `write_body` are mirror images: each replaces one half of a card and keeps the other byte-identical, under the same snapshot guard, so the two kinds of writer a card has can't clobber each other), `create_file`/`create_dir` (fail if the name is taken; backing for the sidebar's inline New File/New Folder), `move_path` (rename/move via `fs::rename`, refusing to clobber an existing destination except a case-only rename; backing for the sidebar's inline Rename and drag-to-move), `reveal_in_finder`, the draft lifecycle (`create_draft`, `list_drafts`, `delete_draft`, `migrate_scratch`), trash (`trash_file`/`restore_trashed`), plus pending-open hand-off for an initial CLI folder arg. `RunEvent::Opened` handles macOS open events for both files and folders. `tauri-plugin-single-instance` forwards CLI argv from a second `doklin` invocation into the running process. Every externally opened *file* (double-click, CLI, cold or warm start) spawns its own window — it is never attached as a tab to an existing window's workspace or to the restored session; an externally opened *folder* focuses its existing workspace window or opens a new one. The backend also persists the window session to `<app_data_dir>/session.json`: every window's folder, open file tabs, active tab, and frame, snapshotted on each content change and at quit. On launch, non-main windows (including externally-opened file windows) are respawned from it with their saved tabs and frames; a window the user closed mid-session is pruned and stays closed. The main window only takes its frame from the file — its tabs (which include drafts) restore from the renderer's `localStorage` session.
- **Cloud**: being rebuilt from scratch — one domain per workspace, a single Rust engine as the only writer, publishing as a flag in the workspace manifest with pages rendered from synced files; the design and the phased plan are in [cloud-redesign.md](cloud-redesign.md). Until that lands there is no cloud code in the app. `src-tauri/src/sync.rs` is the v1 sync engine kept compiling (and tested: `cargo test --lib sync` runs its two-device merge/conflict/CAS matrix against an in-memory backend) as the reference implementation the rewrite ports; nothing wires it up — no manager, no commands, no engine at boot. The one thing the app still asks the Rust side that used to come from the engine is `device_name` (the Mac's own name), which signs the comments written here.
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
- `⌘+` / `⌘-` / `⌘0` — zoom the document in / out / back to 100%. One ladder of
  steps scales both versions of a document — the markdown editor through the
  `--doc-zoom` variable on `<html>` (`App.css`), the html rendition through the
  comment bridge inside its sandboxed frame (which also forwards these chords
  back out, since keys pressed in the frame never reach the app). App chrome
  doesn't scale; the setting is per app and persists across launches.
- All Milkdown/Crepe inline-format shortcuts: `⌘B` bold, `⌘I` italic, `⌘K` link, etc.
- Click a link to follow it; `⌘`-click (or `⌥`-click) to put the caret in its
  text instead.
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
  (inline, same input row — open tabs and the autosave target follow the new
  path) and *Delete* (to the Trash; deleting a folder closes any tabs
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
metadata are remembered in `localStorage` and restored on next launch. Secondary
windows survive a quit too: which windows were open, their folders/tabs, and
their positions/sizes are restored from the backend's `session.json` (VS
Code-style) — see Architecture. Closing a window mid-session removes it from
the restore set; quitting (⌘Q) preserves everything.

## Themes

- **system** (default) — follows macOS appearance.
- **light** — Notion-style pure white (`#ffffff`) with warm-dark text (`#37352f`).
- **sepia** — paper / iA Writer feel, cream (`#faf5ed`) on warm-dark — easier on
  the eyes than pure white in bright rooms.
- **dark** — low-contrast dark gray (`#191919`/`#ebebeb`).

Theme is persisted to `localStorage` under `doklin:theme`.
