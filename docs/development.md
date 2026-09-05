# Doklin — Development & internals

Architecture, saving internals, and the full keyboard / UI / theme reference.
Start here for any code change. For the cloud — sync, and publishing — see
[cloud.md](cloud.md); for the in-app updater and the release pipeline see
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
- **Mermaid diagrams**: a ` ```mermaid ` code block renders through Crepe's code-block preview hook (`codeBlockConfig.renderPreview`, chained in `Editor.tsx` in front of the stock LaTeX handler). A diagram block is two-state, never source and diagram stacked: at rest it shows the diagram alone; the *Source* chip riding the diagram (or moving the caret into the block) switches to the source alone, and leaving the block switches back. The states are CSS in `App.css`, keyed on `:focus-within` plus a `.dk-mermaid-editing` bridge class that `src/mermaid.ts` manages through delegated handlers (a `display:none` editor can't receive the focus that would reveal it — and the chip suppresses its own mousedown so it doesn't flip `:focus-within` mid-click and dodge the click). `src/mermaid.ts` owns the rest of the pipeline: on-demand loading (the npm package as a lazy vite chunk), a debounced render queue with memoization, quiet inline error cards for sources that don't parse, and re-rendering every live diagram when the theme flips. `src/mermaidTheme.ts` derives the full mermaid palette from the surrounding page's tokens (`--app-*` in the app; a public page rendered by the cloud worker feeds it its own tokens again, see [cloud.md](cloud.md) §5.6). The same module adds `mermaid` to the code block's language picker (with a small hand-rolled CodeMirror highlighter) and `Editor.tsx` adds a "Diagram" slash-menu item. One gotcha, fixed in `App.css` (and to repeat in any page stylesheet that renders diagrams): page-level `p` styling must be reset inside `.dk-mermaid`, because mermaid measures HTML labels outside that cascade — a mismatch clips the label boxes.
- **Links**: the editor surface is `contenteditable`, where browsers deliberately don't follow links (a click places the caret), so following one is a plugin: `src/linkOpen.ts`. It mirrors Notion — a plain left click follows the link, while a modifier-click, a drag, or the second half of a double click falls through to the normal caret/selection behavior (that, or arrowing in, is how you get the caret *into* link text; editing a link never needs it opened, since Crepe's hover tooltip already carries copy/edit/remove). A followed click always `preventDefault`s: in the desktop webview a navigation would replace Doklin itself with the site. In-document `#anchors` never leave the editor — the plugin scrolls to the heading whose id (or GitHub-style slug) matches, without moving the selection. Everything else is handed to the host as the raw href: `App.tsx`'s `followDocLink` sends `http(s)`/`mailto:` to `open_external` and resolves anything path-shaped through `src/docLinks.ts` (relative to the note, `.` / `..` folded, fragment dropped) into a tab when the file exists — Notion's internal-page link, applied to a folder of markdown. Other schemes and non-document targets are dropped rather than guessed at. `openInBrowserTab` is the host-less fallback: it opens a browser tab for the schemes a page link may carry and nothing else (a `javascript:` href must never run). The html rendition has its own path — `htmlBridge.ts` posts link clicks out of the sandboxed frame to the same `open_external`.
- **Datastores & kanban boards**: a folder with a `store.jsonl` in it is a *datastore* — a board. One markdown file per card, the card's properties as YAML-style frontmatter at the top of its note, and the definition file holding what isn't any one card's business (the fields, the select options that are the board's columns with their order and colour, the saved views). `src/store/` is the model: `frontmatter.ts` (a strict documented subset of YAML — flat properties only, anything else kept as an *opaque* line and re-emitted verbatim; the serializer is canonical so equal state produces equal bytes on every device), `storeFile.ts` (the JSONL definition, same one-record-per-line discipline as `metaFile.ts` and for the same merge reason), `rank.ts` (fractional indexing, so moving one card rewrites one line in one file), and `model.ts` (one instance per folder path, a cache of disk, every mutation a write followed by a rescan). `StoreView.tsx` is the shell every view sits in — it holds the model, decides which saved view is on screen, and draws the heading, the view strip (one chip per saved view, `+` for a new board or table) and the **View** panel (group-by, sort, filter, which properties show, which columns are hidden, CSV export, delete this view); `KanbanBoard.tsx` and `TableView.tsx` draw what is under it, both from the same pure derivation in `store/board.ts` so they can never disagree. A view's own settings are a line of `store.jsonl` and therefore everyone's, so only a TAB offers the panel; an embed shows the one view its fence names and changes nothing. The sidebar draws a board as ONE row with no disclosure (the backend returns no children for a store folder — a board can hold hundreds of cards) that opens a `store` tab, and highlights that row while any card inside it is the focused tab. The rule the whole thing rests on is the **frontmatter boundary**: Milkdown never sees a document's frontmatter block. `loadActiveContent` splits it off and keeps it in a ref, `writeToDisk` puts it back byte for byte, and the backend's `write_frontmatter` splices a new block onto whatever body is on disk *at that moment* — so a board's drag can't lose a keystroke an open tab hasn't flushed, a prose edit can't rewrite someone's `aliases:` line, and a properties-only change arriving from outside (another window, a board, cloud sync) is adopted without touching the editor or its caret. The header serves EVERY note, not only a card: a card's rows are its board's fields, any other note's are the keys its own file carries, and *Add property* declares a field on the store for a card or adds a key for a plain note (a property with no value yet is a row, never a line in the file — so a note with no frontmatter still never grows one by accident). `PropertyControl.tsx` is the one pill a header row and a table cell share. Clicking a card **peeks** it — `CardPeek.tsx`, a panel beside the board with the card's properties above an editable body, and *Open in a tab* beside it; a card already open in a tab goes to the tab instead, which is the better answer and removes the only race a peek could cause. The peek writes each half of a card through its own guarded splice (`write_frontmatter` for the block, `write_body` for the body), so a sentence typed in the peek and a card dragged on the board behind it cannot lose each other. A store also **embeds in a note**: `storeEmbed.ts` claims a ` ```kanban ` or ` ```table ` fenced block (a `$remark` transform retypes the mdast `code` node, a `$nodeSchema` atom holds the fence's config text and its language, a `$view` node view mounts `StoreEmbedFrame.tsx` inside a `contenteditable=false` frame whose `stopEvent` answers true for everything and `ignoreMutation` always) — so the view's inputs never reach ProseMirror and the fence round-trips byte for byte through every autosave, in the language it was written in. The fence's LANGUAGE decides the view kind; the config's `view:` only picks which saved view of that kind. `store/embedConfig.ts` is the pure half: the config dialect (the same grammar as frontmatter, via `parseProps`), the fence text, and `storeFences` — the scan that finds a document's fences in its raw bytes (no parsed document needed). `store/board.ts` holds the pure derivation (`boardColumns`, `cardChips`, `applyFilter`, `sortCards`, and the `boardSnapshot` they feed) — one derivation for the tab, the embed and the published page the cloud worker renders from the synced files ([cloud.md](cloud.md) §5.6), so none of them can disagree. `store/csv.ts` is the export: what the view shows, in the order it shows it, RFC 4180 with CRLF. Design and the phased plan: [datastores-kanban.md](datastores-kanban.md); all four phases are built.
- **Backend**: Tauri 2 (Rust). Commands: `read_file`, `write_file`, `list_md_tree` (walks a directory, returning every non-hidden folder plus the markdown files inside — empty folders stay visible so they can be creation targets; a datastore folder is marked `store: true` and returns no children), `read_store`/`write_frontmatter`/`write_body`/`create_card`/`watch_dir`/`unwatch_dir` (the datastore surface — `src-tauri/src/store.rs`; Rust only finds fences and moves bytes, the frontmatter dialect is parsed in TypeScript alone. `write_frontmatter` and `write_body` are mirror images: each replaces one half of a card and keeps the other byte-identical, under the same snapshot guard, so the two kinds of writer a card has can't clobber each other), `create_file`/`create_dir` (fail if the name is taken; backing for the sidebar's inline New File/New Folder), `move_path` (rename/move via `fs::rename`, refusing to clobber an existing destination except a case-only rename; backing for the sidebar's inline Rename and drag-to-move), `reveal_in_finder`, the draft lifecycle (`create_draft`, `list_drafts`, `delete_draft`, `migrate_scratch`), trash (`trash_file`/`restore_trashed`), plus pending-open hand-off for an initial CLI folder arg. `RunEvent::Opened` handles macOS open events for both files and folders. `tauri-plugin-single-instance` forwards CLI argv from a second `doklin` invocation into the running process. Every externally opened *file* (double-click, CLI, cold or warm start) spawns its own window — it is never attached as a tab to an existing window's workspace or to the restored session; an externally opened *folder* focuses its existing workspace window or opens a new one. The backend also persists the window session to `<app_data_dir>/session.json`: every window's folder, open file tabs, active tab, and frame, snapshotted on each content change and at quit. On launch, non-main windows (including externally-opened file windows) are respawned from it with their saved tabs and frames; a window the user closed mid-session is pruned and stays closed. The main window only takes its frame from the file — its tabs (which include drafts) restore from the renderer's `localStorage` session.
- **Cloud**: a workspace connects to one domain — a Cloudflare Worker in front of an R2 bucket, on the user's own account — and a domain holds one workspace; the whole folder is backed up and kept in sync on every Mac that opens it. The design and every decision are in [cloud.md](cloud.md); this is the map. `cloud-worker/` is the worker (TypeScript, flattened to one readable file by `scripts/bundle-worker.mjs` and attached to every release as `doklin-cloud-worker.js`; its contract is [cloud-worker/README.md](../cloud-worker/README.md)): the bearer-authenticated sync API — a workspace bound once per domain with a create-only put, the v2 manifest updated by compare-and-swap and shape-checked on every write, content-addressed blobs, per-file history, presence, the owner's wipe that frees the domain — and the public pages of the next bullet. `node cloud-worker/test/run.mjs` drives every route against an in-memory R2. The app side is `src-tauri/src/cloud/`: one engine task per connected workspace (`engine.rs` — the reconcile cycle: apply what changed remotely, scan what changed locally, three-way merge where both moved, conflict copies where they overlap, then compare-and-swap the manifest and retry on a lost race; the public map folded in on every won write; presence; history), the manager and the Tauri commands (`mod.rs`), `cloud.json` and the folder's hidden `.doklin/cloud.json` marker (`config.rs`), the flows that run before an engine exists — bind + upload, download, wipe (`flows.rs`) — and the edit bus (`bus.rs`): every write command ends with `edits::touched`, which pokes the engine (and the versioner of the next bullet), so an edit reaches the cloud about two seconds after the keystroke while external edits still ride the folder watcher. The engine is the only code that holds the token or talks to the domain; `cargo test --lib cloud` runs the whole thing against an in-memory worker. The frontend's side of the contract is `src/cloud.ts` — typed command wrappers and event listeners, no `fetch` anywhere — and the surfaces on top of it: `CloudPanel.tsx` (the gear's *Cloud…*, or the dot beside the workspace name: the phase, sync now / pause, who else is here, a held mass-deletion waiting for a word, the worker's version against this app's, the credentials a second Mac needs, disconnect, and the danger zone that erases the domain and hands over the teardown prompt), `CloudSetup.tsx` (the wizard: name the workspace, pick a domain of your own or a free workers.dev address, copy the setup prompt — it carries the owner token the app minted — paste the endpoint the agent printed, and the probe decides between *Connect & upload*, *Download it here* and *Resume syncing this folder*), `WorkerUpdate.tsx` (one card, one prompt without a secret, *Check again*), `CloudToasts.tsx` (a conflict copy's *Open the copy*, a held deletion's *Review…*), plus the sidebar's presence chips and *Version history…*. The three agent prompts — setup, update, teardown — are pure functions in `src/cloudPrompts.ts`, built from the worker version and the compatibility date that `vite.config.ts` parses out of `cloud-worker/src/version.ts` into `virtual:cloud-worker-version` — parsed, never mirrored, as `build.rs` does for the Rust side. `node verify-harness/drive-cloud.mjs` walks the surfaces against a scripted fake of the engine; `node verify-harness/cloudprompts.test.mjs` checks the prompts leave the agent nothing to invent. `device_name` (the Mac's own name) signs the comments written here and is the name the engine attributes revisions to.
- **Versions**: every open folder — and the drafts directory — gets a local snapshot store in app data, whether or not it is connected to a cloud. `src-tauri/src/versions/` is one versioner task per open root (started and stopped from the window registry, fed by the same edit bus and its own recursive watcher): it captures at most one snapshot per ten minutes of continuous editing plus one two minutes after editing stops, so the history reads as a list of sessions rather than of keystrokes, and a quiet hour costs nothing. A snapshot is the whole folder keyed by path — `path → {hash, size, mtime}` — gzipped beside content-addressed blobs under `<app_data>/versions/<key>/`, and it is thinned on a ladder (every one for an hour, hourly for a day, daily for a month, weekly for a year, monthly beyond) rather than by a count: two years of hourly snapshots come to 116. Nothing outside `retain.rs`'s sweep ever deletes from a store — the one exception is *Forget*, which removes a whole store the user named — which is what makes history survive the sync faithfully replicating a mistake. The design is [versioning.md](versioning.md), the phased build [versioning-plan.md](versioning-plan.md), the by-hand pass that says the promise holds [versioning-testing.md](versioning-testing.md), and `cargo test --lib versions` pins the cadence, the ladder and the sweep. `scripts/versions.sh` prints what a folder's store holds. `src/versions.ts` is the frontend's half of the contract, and `HistoryRail.tsx` / `VersionPreview.tsx` are the surface on it: a right rail of versions grouped by day, and the selected one rendered where the document is by the same editor, read-only — so an old version can never be autosaved over the new one. A restore is one Rust command (capture what is here, write the old bytes, capture what that made), which is why the frontend never does it in two calls. A connected workspace mirrors its store into the bucket under `versions/` — `src-tauri/src/cloud/versions.rs` on the app side, `cloud-worker/src/versions.ts` on the worker's: immutable snapshots and blobs, one compare-and-swap index, the same retention ladder applied to the bucket once a day. What other Macs mirrored comes back into the same rail as ordinary versions, so a rename made on another Mac is followed exactly like one made here; `cargo test --lib cloud` pins the mirror, the cloud sweep and the read-through. Over the whole folder there are two more surfaces (`versions/workspace.rs`): `WorkspaceHistory.tsx`, a timeline of the retained moments that says what restoring one would change, bring back and move to the Trash before anything happens — and does all three in one command, bracketed by a capture either side so it is undoable — and `RecentlyDeleted.tsx`, a dimmed row at the foot of the sidebar listing every file the store still holds and the folder does not, restorable to its old path with its history. `VersionsSettings.tsx` (the gear's *Versions*, and the Cloud panel's *This Mac*) is the settings over all of it, backed by `versions/stores.rs`: how far back each folder keeps — written into that store's own `index.json`, so two folders can differ — the same for the bucket, which is one compare-and-swap on the cloud index so every Mac reads the same answer, what each store costs, *Forget* for a store whose folder is gone (refused while it is open; the only deletion in a store outside the sweep), and *Export…*, one `tar.gz` of the folder and its history that nothing but `tar` is needed to open.
- **Publishing**: a flag on a synced file, never a push. A note, a folder or the whole workspace gets a slug in the manifest's public map (`cloud_publish` / `cloud_unpublish` / `cloud_set_root` — engine ops, queued offline and folded into the next won write), and the worker renders the page from the synced blobs on request: a note with its comments stripped, its frontmatter as a properties table coloured by its datastore, boards and tables derived from the folder's store with the same `store/board.ts` derivation the app uses (at most 40 cards read; the rest counted), column widths from the meta sidecar, the html rendition framed behind the MD/HTML pill and served sandboxed; a folder's table of contents with Notion-style nested addresses; links between public notes rewritten and unpublished targets dropped to text; the root page at `/`; a static OG image; all cached by manifest etag, so a page is exactly as fresh as the sync. In the app, `PublishMenu.tsx` is the pill in the tab bar for a note inside the workspace (publish at a random or chosen address, the link, copy / open, rename the address, stop — and the door to the wizard when the folder isn't connected), `PublishFolder.tsx` publishes a folder, or the whole workspace, as one page with every note under it, `PublishedPages.tsx` lists everything public (folders first, the home page, a `file missing` flag, stop), and the sidebar marks rows with a page of their own and offers *Publish folder…*, *Copy public link* and *Stop publishing* (undoable from the toast). The URL derivations the surfaces share (`pageUrl`, `nestedUrl`, `placesOf`, the slug grammar) live in `src/cloud.ts`. `node verify-harness/drive-public.mjs` walks the public pages in Chromium against `verify-harness/serve-worker.mjs`, the bundled worker over a seeded in-memory bucket.
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
