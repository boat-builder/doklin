# Architecture

## Map

- `src/App.tsx` — the shell: tabs, windows, saving, links, themes. `Editor.tsx`
  wraps Milkdown Crepe; `src/tabs.ts` the tab descriptors.
- `src-tauri/src/lib.rs` — Tauri commands (`read_file`, `write_file`,
  `list_md_tree`, `create_file`/`create_dir`, `move_path`, `copy_path`,
  `trash_file`/`restore_trashed`, `open_external`, the clipboard and window
  commands), macOS open events (`RunEvent::Opened`), single-instance argv
  forwarding, the window session.
- `src-tauri/src/edits.rs` — every write command ends with `edits::touched`,
  which pokes the cloud engine and the versioner (the edit bus).
- `src-tauri/src/untitled.rs` — untitled-note buffers.
- `src-tauri/src/store.rs` + `src/store/` — datastores ([datastores.md](datastores.md)).
- `src-tauri/src/cloud/` + `src/cloud.ts` — sync and publishing ([cloud.md](cloud.md)).
- `src-tauri/src/versions/` + `src/versions.ts` — history ([versioning.md](versioning.md)).
- `src-tauri/src/pdf_export.rs` — PDF export ([pdf-export.md](pdf-export.md)).

## Saving

- Autosave 600 ms after the last keystroke; `⌘S` lands the pending write.
- Switching, closing a tab and quitting flush. The editor reports its text on
  a debounce of its own, so every flush — and every decision on the app's copy
  of the text — first calls `EditorHandle.flushMarkdown` to catch up.
- `list_md_tree` returns every non-hidden folder (empty ones too) and the
  markdown inside; a datastore folder is `store: true` with no children.
- `move_path` refuses to clobber an existing destination, except a case-only
  rename. `create_file`/`create_dir` fail if the name is taken.

## Untitled notes

- `⌘N` opens a note with no file. Its text lives in
  `<app_data>/untitled/<tab id>.md` (entity meta beside it), written by the
  normal autosave; deleted when the tab closes or the note is saved.
- Only the tab descriptor (`id`, `kind`, `path`) is persisted; title and the
  unsaved flag are read back from the buffer on restore.
- Closing a tab with text asks Save / Don't Save / Cancel. `⌘Q` asks nothing —
  every note comes back unsaved. Closing a non-main window asks per note.
- Untitled notes belong to the window, not a folder: switching folders takes
  them along. No history, no sync, no publishing until saved.
- `orphaned_untitled` at launch reopens any buffer with text that no window
  holds as an unsaved tab in the main window; empty buffers are swept.

## Windows and session

- An externally opened file (Finder, CLI, cold or warm start) always gets its
  own window. An opened folder focuses its workspace window or opens one.
- `<app_data_dir>/session.json` holds every window's folder, tabs, active tab
  and frame. Non-main windows respawn from it; a window closed mid-session is
  pruned. The main window takes only its frame from it — its tabs restore from
  `localStorage`, keyed by workspace folder.

## Editor traps

- Links (`src/linkOpen.ts`): a followed click always `preventDefault`s — a
  navigation would replace the app. `http(s)`/`mailto:` go to `open_external`;
  path-shaped hrefs resolve through `src/docLinks.ts` into a tab; other schemes
  are dropped; a `javascript:` href must never run. The html rendition posts
  its clicks out through `htmlBridge.ts`.
- Mermaid (`src/mermaid.ts`): a diagram block is diagram *or* source, never
  both, driven by `:focus-within` plus the `.dk-mermaid-editing` class. Any
  stylesheet that renders diagrams must reset page-level `p` styles inside
  `.dk-mermaid`, or label boxes clip.
- Sidebar and tab drags are pointer-based: Tauri intercepts HTML5 drag.
- Zoom (`⌘+`/`⌘-`/`⌘0`) scales the markdown editor through `--doc-zoom` and
  the html rendition through its frame's bridge; app chrome never scales.

## Popups

- Every modal, panel, popover and menu closes through `useDismiss`
  (`src/dismiss.ts`) — never a keydown or outside-click listener of its own.
  Only the top layer answers an Esc or a press outside; every layer but a
  menu also has a close button.
- A control inside a layer that takes Esc for itself (an inline rename, a
  find field) calls `preventDefault`, and the layer stays.
- A layer whose trigger toggles it passes an element that contains the
  trigger, or the press on the trigger closes it and the click reopens it.

## Themes

- Every palette, the type scale, radii and motion live in
  `src/styles/tokens.css`; components carry no theme literals (code blocks use
  `--code-*` tokens via `src/codeTheme.ts`).
- The worker imports `tokens.css` for public pages and reads it by selector
  (`cloud-worker/src/theme.ts`): keep it a flat list of rules with the
  `:root`, `:root, [data-theme="light"]` and `[data-theme="dark"]` blocks, or
  the worker tests fail.
- `localStorage` keys: `doklin:theme`, `doklin:doc-font`, `doklin:page-wide`.
