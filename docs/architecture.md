# Architecture

## Map

- `src/App.tsx` — the shell: tabs, windows, saving, links, themes. `Editor.tsx`
  wraps Milkdown Crepe; `src/tabs.ts` the tab descriptors.
- `src/backend.ts` — what the UI asks of the platform it runs on;
  `src/mac/backend.ts` — the Mac's answer, through Tauri (*The backend*).
- `src/web/` + `app.html` — the browser's answer, through the workspace's
  worker (*The browser version*).
- `src-tauri/src/lib.rs` — Tauri commands (`read_file`, `write_file`,
  `list_md_tree`, `create_file`/`create_dir`, `move_path`, `copy_path`,
  `trash_file`/`restore_trashed`, `open_external`, the clipboard and window
  commands), macOS open events (`RunEvent::Opened`), single-instance argv
  forwarding, the window session.
- `src-tauri/src/edits.rs` — every write command ends with `edits::touched`,
  which pokes the cloud engine and the versioner (the edit bus).
- `engine/` — the sync engine and the version store, a crate with no Tauri
  in it, shared with the iPhone app. `src-tauri/src/engine.rs` is the Mac
  app's side of it; `cloud.rs` and `versions.rs` are its Tauri commands.
- `src-tauri/src/untitled.rs` — untitled-note buffers.
- `engine/src/cloud/` + `src/cloud.ts` — sync and publishing ([cloud.md](cloud.md)).
- `engine/src/versions/` + `src/versions.ts` — history ([versioning.md](versioning.md)).
- `src-tauri/src/pdf_export.rs` — PDF export ([pdf-export.md](pdf-export.md)).

## The backend

- The UI calls `backend` (`src/backend.ts`) and nothing beneath it. Only
  `src/mac/` imports `@tauri-apps/*`, and nothing under `src/` calls `fetch`
  but `src/web/http.ts`: eslint fails both.
- A Rust command or event is named in one place, `src/mac/backend.ts`. A new
  one is a method on the interface first, then its line there.
- A document is one thing: `open`, `save`, `move`, `copy` and `remove` take the
  document's path and carry its sidecar and its html rendition with it. The UI
  never names a `.meta.jsonl`, and never does to a document's parts in turn
  what it did to the document.
- A save is the text and the sidecar together (`writeToDisk` composes the
  sidecar before it writes). The text lands only over the `Rev` it was read at
  and rejects with `SaveConflict` otherwise; the sidecar is last writer wins.
  A `Rev` is opaque outside the backend that made it.
- What a platform may not have is an optional group on `Backend` (`setup`,
  `sync`, `domain`, `access`, `session`, `versions`, `shows`, `leaving`,
  `windows`, `untitled`, `localFiles`, `pdf`, `updater`), never a flag and
  never a check of which platform this is. The group is asked for where the
  feature comes into view; what is behind that takes the group, or a handler,
  as a prop, and a missing one is a button, a menu row or a shortcut that is
  not there.
- `cloud` holds only what every backend answers of a workspace it shows:
  its status, what changed, who edits what, a page's link, publishing. A
  command that takes a copy of the workspace on the device (`setup`,
  `sync`), the domain's upkeep (`domain`) or who may open what (`access`)
  goes in that group, never in `cloud` with a refusal behind it. An event a
  backend never raises is in a group it has not got.
- Where platforms differ in kind and not in ability, the backend says so as
  data: `home` (the one workspace it is for, which the app opens at start in
  place of the last one), `htmlFrame` (a page that arbitrary html is shown
  in, in place of a frame handed the markup), `device` (what a sentence
  calls this device: "this Mac", "this browser"), `documents.removeUndoes`
  (false: the app asks before a delete) and `documents.searchByCase`.
- A shortcut's hint is written with `keys()` (`src/keys.ts`): `⌘` on an Apple
  keyboard, `Ctrl+` on any other. The handlers take either key.
- `leaving.onLeave` is handed the app's flush where a page can go with no
  window to ask first. **The flush must reach `documents.save` before it
  first awaits anything**: it is called as a tab closes, and what it has not
  handed over by the time it returns is lost.
- Nothing calls `backend` at import time: an entry (`src/main.tsx`,
  `src/web/start.tsx`, a harness page) calls `installBackend` and then
  renders.
- `watch` is given the whole set of documents on screen each time it changes,
  and again after a document's first sidecar write: the Mac watches files, and
  a file that was not there was not being watched.
- `verify-harness/seam.tsx` is a backend of the harness's own (in memory, no
  optional group) that `drive-seam.mjs` runs the real `App` on. Nothing
  typechecks the harness: a required member added to `Backend` is added there
  too.

## The browser version (`src/web/`, `app.html`)

Its sign-in and the worker's routes: [cloud-people-agents.md](cloud-people-agents.md)
*A browser*.

- It is built into the worker's web directory (`buildApp`,
  `scripts/bundle-worker.mjs`, with the Mac frontend's own `vite.config.ts`)
  and ships with the worker: `app.html` at `/app`, its bundles under
  `/app/assets/`. Every address in it is absolute and under `/app`.
- **The page's policy is `script-src 'self'`** (`cloud-worker/web/_headers`),
  so: `app.html` carries no script of its own; nothing in the bundle may
  make script from text; and **a frame given markup (`srcdoc`, `blob:`)
  is held to the page's policy**, which is why an html document is shown in
  `/app/frame` (`Backend.htmlFrame`, `src/web/frame.html`), a page served
  with its own sandbox policy that asks the app for the markup.
- `src/web/gate.js` runs first, as written: plain ES5, never bundled. It
  stops a phone, a tablet and a browser too old for the editor, and
  `main.ts` then imports nothing. What it calls a phone or a tablet is said
  again by the page links go through (`site/public/open.html`): **change
  both**. `main.ts` stays that small; `start.tsx` imports `App` only once
  somebody is signed in.
- `src/web/http.ts` is the only code that fetches. It holds no credential
  (the sign-in is a cookie it cannot read), asks this origin only, and counts
  every request per UTC day as the engine does (`x-doklin-used`).
- `workspace.ts` holds every section's manifest and derives from them what
  the engine tells the UI on a Mac: one `CloudStatus`, the tree, what changed
  elsewhere. A path is the workspace's name as a root, then where the Mac
  app would put the same file (`Private/…`, `Restricted/<name>/…`). It asks
  the worker by attention with the engine's numbers (`poll_gap`): change
  both.
- It reads the worker's answers with the worker's own types:
  `cloud-worker/src/wire.ts`, `manifest.ts`, `layout.ts`, `roles.ts`.
  **Those files import nothing of the worker's runtime; keep them so.** The
  app's typecheck has no Workers types, so one that came to import `env.ts`
  fails it.
- A link is `/app#w=&s=&f=`, taken out of the address by the `shows` group
  and resolved in the manifests held (`address.ts`). A page link of this
  domain that the app hands to `openExternal` becomes that address, so it
  opens here. *Copy link* makes the link the engine makes
  (`engine/src/cloud/link.rs`, whose test holds `address.ts` to it).
- What a browser has not got is no group at all: `setup`, `sync`, `domain`,
  `access`, `windows`, `untitled`, `localFiles`, `versions`, `pdf`,
  `updater`. What it has that a Mac has not is `session`: the sign-out, which
  sends what waits, ends the sign-in and starts the page again.
- Search is the worker's (`GET /api/web/search`): it does not see what this
  page has yet to send, cannot match case, and answers `202` while its
  mirror catches up, which is asked again a few times and then said.
- Publishing is the worker's too; after a page is published, stopped or made
  the home page, the section's manifest is read again.
- `verify-harness/drive-web.mjs` drives the built page, not a dev server.

Writing (`saving.ts`, `merge.ts`, `tabs.ts`):

- **`documents.save` takes the text at once and sends it later**: it is the
  Mac's write to disk, and the send is the engine's sync. A document is sent
  2 s after its last save, at most once in 10 s, and at once when the page
  loses attention. Everything that reads a document reads what is waiting
  for it first. `save` does all of this before its first `await` (see
  `leaving`, above).
- A `Rev` is a mark that moves whenever the text a read would give changes: a
  save, a change taken in from elsewhere, a merge. It does not move when a
  save lands or the document is moved, so a text read before either is still
  the text.
- **A send goes over the stored copy its text was made from, and nothing is
  ever written over a version nobody here has read.** When the copy moved
  on, the two are merged against the text both started from; where they
  overlap, the other version is written beside the document as a conflict
  copy and ours stays. That is the engine's rule and its naming
  (`merge_texts`, `conflict_copy_path`, `engine/src/cloud/merge.rs`): change
  both. `mergeText` treats changes that touch as an overlap, as diff3 does.
- A sidecar is merged by its records, not its lines (`mergeMeta`): two
  replies to one thread are both kept. It never gets a conflict copy.
- What waits is also in `localStorage`, under the tab that holds it
  (`doklin:web:draft:<workspace>:<person>:<tab>:<path>`), and a tab holds a
  Web Lock for as long as it lives. **A tab takes over a draft only when the
  tab that wrote it holds no lock**: two tabs sending one draft would merge
  a text with an older copy of itself. A request made as the page goes
  carries 64 KB (`KEEPALIVE_BYTES`); the draft is what covers a larger note.
- After its own save the page puts the files the worker answered into the
  manifest it holds, and takes the answer's `etag` when it held `over`. A
  move, a copy and a delete read the section's manifest again instead.
- An empty folder exists on the page that made it and nowhere else, until a
  document is in it.
- The beat is the engine's (`PRESENCE_BEAT`, `beat_ttl`, `ACTIVITY_FRESH`,
  `claim_owed`, `engine.rs`): change both. One tab of a browser polls and
  beats, the one last used (`tabs.ts`: a Web Lock it takes from the others),
  and the rest are told what it was answered. The document the beat names is
  that tab's.
- A change to the tree that fails rejects with the sentence itself, not an
  `Error`: the UI prints `String(e)`, as it does for a Mac's command.

## Saving

- Autosave 600 ms after the last keystroke; `⌘S` lands the pending write.
- Switching, closing a tab and quitting flush. The editor reports its text on
  a debounce of its own, so every flush — and every decision on the app's copy
  of the text — first calls `EditorHandle.flushMarkdown` to catch up.
- `list_md_tree` returns every non-hidden folder (empty ones too) and the
  markdown inside.
- `move_path` refuses to clobber an existing destination, except a case-only
  rename. `create_file`/`create_dir` fail if the name is taken.
- A file tab that isn't markdown or html (a greyed "Show all files" row,
  clicked) holds no document: nothing reads, watches or autosaves it
  (`isUnsupportedTab`), and it can't be split. A rename that changes which it
  is reloads the tab.

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

- A link to a page (`doklin://open#…` from macOS, or a click in a note) is
  turned into its file's path by the engine (`src-tauri/src/links.rs`) and
  then opened like any external open; a link that opens nothing says why in a
  dialog, since it can arrive with no window up.
- External opens (Finder, `doklin open`, cold or warm start) are placed by
  `src-tauri/src/external_open.rs` against the connected roots in
  `cloud.json`. A path inside a connected workspace goes to that workspace's
  window: a file as its tab, a folder selected in the sidebar. A
  workspace root, or any other folder, focuses its own window or opens one; a
  file of no workspace is focused where it is already a tab, else gets its
  own window — never attached to a workspace it is not in.
- What a window must show is queued per label and drained by the window
  (`take_window_shows`, the `shows` group) once ready and on each
  `window-shows` ping, never emitted as data: a window still restoring or
  just spawned has no listener.
  Before the main window takes its folder, the first folder asked for becomes
  its own (`PendingOpen`); a window the session restores is reused.
- `<app_data_dir>/session.json` holds every window's folder, tabs, active tab
  and frame. Non-main windows respawn from it; a window closed mid-session is
  pruned. The main window takes only its frame from it — its tabs restore from
  `localStorage`, keyed by workspace folder.
- `session.json` parses whole or not at all: a `TabKind` the build doesn't
  know loses every window's tabs, not just that one. The `localStorage`
  session filters unknown kinds out.

## Frontmatter

- A note has a block only when line 1 is `---` (trailing whitespace ok) and a
  later line is `---` (`src/frontmatter.ts`); a note that merely opens with a
  rule has none.
- Milkdown never sees it — it would read the block as a rule and a heading.
  A load splits it off (`adoptFrontmatter`); every write prepends the block as
  last read, byte for byte. An external change whose body equals
  `lastDiskMdRef` touched only the block: adopt it and the snapshot, leave the
  editor and its caret.
- Shown read-only above the note. Nothing in the app parses or writes inside
  it; the worker leaves it off published pages with the same splitter.

## Editor traps

- A picture a note names by a path is asked for nowhere (`pictureAddress`,
  `Editor.tsx`): pictures do not sync and nothing reads one. Left to the page,
  the path would be asked of whatever serves the page, which in a browser is
  the workspace's worker, at a request against its day each. A picture on the
  web is asked for as written.
- Links (`src/linkOpen.ts`): a followed click always `preventDefault`s — a
  navigation would replace the app. `http(s)`/`mailto:` go to `open_external`;
  path-shaped hrefs resolve through `src/docLinks.ts` into a tab; other schemes
  are dropped; a `javascript:` href must never run. The html rendition posts
  its clicks out through `htmlBridge.ts`.
- Figure blocks (```` ```mermaid ```` in `src/mermaid.ts`, ```` ```svg ```` drawings
  in `src/drawing.ts`): the block is picture *or* source, never both, driven
  by `:focus-within` plus the `.dk-figure-editing` class (`src/figureBlock.ts`).
  Any stylesheet that renders diagrams must reset page-level `p` styles inside
  `.dk-mermaid`, and must also apply the Mermaid label sizes globally (App.css
  "Mermaid labels", restated in the worker's page CSS): Mermaid measures labels
  on `<body>` before its own stylesheet exists, so a size it didn't measure
  clips the box. Mermaid's SVG is not well-formed XML (`<br>` in labels):
  post-process it with an HTML parser.
- Drawings go through `sanitizeDrawing` (`src/drawingSvg.ts`, pure, also run by
  the worker): an element/attribute allowlist re-serialized from its own
  parse, and every `id`/`url(#…)` prefixed per drawing so two drawings never
  share a marker. Colours are `--dg-*` tokens — a contract documents depend
  on: never rename one, only add. The drawing grammar agents follow is
  `doklin help drawings` (`cli/src/help.rs`); `verify-harness/drive-drawing.mjs`
  renders its examples, so change the two together.
- Mermaid's `look` and `layout` are pinned (`mermaidConfig`): an upgrade that
  changes either default would re-lay out every diagram people wrote.
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
- The theme is the only appearance setting. The document's faces (serif
  `--font-heading`, sans `--font-text`) and its 672px `--doc-measure` are
  fixed tokens, not reader choices. Heading sizes are fixed px × zoom.
- Bundled fonts (Inter, Literata, Roboto Mono, OFL) are named in
  `src/styles/fonts.css`; the worker imports each file by name
  (`cloud-worker/src/theme.ts`) — change both.
- Code block placeholders must match the mounted editor's height exactly
  (App.css "Code block placeholder parity"); the tools row floats out of flow.
- `localStorage` key: `doklin:theme`.
