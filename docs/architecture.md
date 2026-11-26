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
  sidecar before it writes, for a document that isn't the active one too).
  The text lands only over the `Rev` it was read at and rejects with
  `SaveConflict` otherwise; the sidecar is last writer wins. A `Rev` is opaque
  outside the backend that made it.
- **A save fails whole, and writes the sidecar first.** While the text is
  written, the sidecar holds every record the text on disk or the new text
  uses (`sidecarWhileWriting`, `src/metaFile.ts`); the records it drops go
  once the text is down. A save that stops between the two writes leaves
  records nothing uses, never a text without its records. A browser's save
  is one manifest write, so it needs neither.
- **The editor's markdown ends with a records line** when its note has links
  to documents: an html comment marked by a private-use character, holding
  the `link` records the sidecar is to hold (`recordsLine`,
  `src/docLinks.ts`). It is the editor's form, like a comment's inline body:
  `splitLinkRecords` takes it off before anything is written, copied or
  compared with disk (`writeToDisk`, the untitled save, *Copy with
  comments*, the iPhone's `toDisk`). A save's records are the editor's; a
  meta-only write (the rail's) writes the ones of the text on disk
  (`metaLinksRef`), so it never drops a record that text uses.
- What a platform may not have is an optional group on `Backend` (`setup`,
  `sync`, `domain`, `access`, `spaces`, `session`, `versions`, `shows`,
  `leaving`, `windows`, `untitled`, `localFiles`, `pdf`, `updater`), never a flag and
  never a check of which platform this is. The group is asked for where the
  feature comes into view; what is behind that takes the group, or a handler,
  as a prop, and a missing one is a button, a menu row or a shortcut that is
  not there.
- `cloud` holds only what every backend answers of a workspace it shows:
  its status, what changed, who edits what, a page's link, publishing. A
  command that takes a copy of the workspace on the device (`setup`,
  `sync`), the domain's upkeep (`domain`), who may open the workspace
  (`access`: people, devices, agents) or its restricted folders (`spaces`)
  goes in that group, never in `cloud` with a refusal behind it. An event a
  backend never raises is in a group it has not got. A restricted folder's
  screens list people too, so they are offered only where both `spaces` and
  `access` are answered. A folder put straight under `Restricted` becomes a
  restricted folder of its name on every backend that has `spaces`: the
  engine finds it there on a Mac, and `Documents.move` makes it in a browser.
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
  app would put the same file: `/<Name>/Library/…` for the shared section
  (`LIBRARY_FOLDER`, `cloud-worker/src/layout.ts`), `/<Name>/Private/…`,
  `/<Name>/Restricted/<name>/…`. **A path outside the three is in no
  section** (`place` answers null), and so is one under `Library/Library`,
  `Library/Private` or `Library/Restricted`; the browser changes nothing there. What it sends
  is a section's id and the path inside it, never a UI path. It asks the
  worker by attention with the engine's numbers (`poll_gap`): change both.
- It reads the worker's answers with the worker's own types:
  `cloud-worker/src/wire.ts`, `manifest.ts`, `layout.ts`, `roles.ts`.
  **Those files import nothing of the worker's runtime; keep them so.** The
  app's typecheck has no Workers types, so one that came to import `env.ts`
  fails it.
- A link is `/app#w=&s=&f=`, taken out of the address by the `shows` group
  and resolved in the manifests held (`address.ts`). A page link of this
  domain that the app hands to `openExternal` becomes that address, so it
  opens here. *Copy link* makes the link the engine makes
  (`engine/src/cloud/link.rs`, whose test holds `src/pageLink.ts` to it).
- What a browser has not got is no group at all: `setup`, `sync`, `domain`,
  `windows`, `untitled`, `localFiles`, `versions`, `pdf`, `updater`. What it
  has that a Mac has not is `session`: the sign-out, which sends what waits,
  ends the sign-in and starts the page again.
- `access` in a browser is the routes a Mac's engine calls, asked from the
  page, with each code made there (`codes.ts` ⇄ `engine/src/cloud/invite.rs`,
  **change both**) and only its sha256 sent. Who the browser is and who is
  here was read once, when the page opened: the People view asks again each
  time it opens (`Workspace.probe`), and so does adding or changing an agent,
  which is how a new role or a new name reaches the rest of the page.
- `spaces` in a browser is the worker's routes too, and the picture held is
  changed as each answers, not at the next poll: a folder made here is held
  until a poll lists it (`entering`), because a poll asked before it was made
  says nothing of it, which would read as this person having been taken out.
  A folder that becomes a restricted one is a move to the new folder's top
  (`Saving.restrict`): [cloud-people-agents.md](cloud-people-agents.md) *A
  browser* says what that leaves when it stops part of the way.
- A folder moved between sections goes 16 files a request (`remaining`,
  `cloud-worker/src/changes.ts`): `Saving.carry` asks until none is left.
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

## The title

- A document's title is its file name, without the extension (`docName`,
  `src/tabs.ts`): drawn above the note (`src/DocTitle.tsx`), never part of
  the markdown. A note doesn't open with a `# title` line.
- Typing there renames the file `RENAME_PAUSE_MS` after the last key and on
  leaving, through `movePath` like any rename. Until then `DocTab.title`
  holds the typed title, so the tab, the tree row and the split header follow
  each key.
- Never renamed to: what a file name can't hold (`titleProblem`,
  `src/titleText.ts`, which the iPhone's editor shares), or a name
  another document in the folder has, its markdown or its html. Left that
  way, the title puts the name back.
- `Untitled` and `Untitled N` show an empty title with the name as its
  placeholder. *New Document* makes the first free one and focuses its
  title: a document is never named in the tree.
- **The title and the html view are siblings in one list**: they never share
  a React key, or a note opened after an html view shows two titles. The tags
  row under the title has a key of its own too (`tags:<tab id>`).
- A note's tags sit right below its title (*Tags*, below). Keys moving between
  the title and the body skip them.
- ↑ and Backspace from the body's first line go to the title through a plugin
  registered last (`src/leaveTop.ts`), so the menus and the editor's own
  keymaps take them first.
- The field clips what leaves its box: its `0.2em` padding, taken back by
  its margin, keeps descenders and accents whole.

## Untitled notes

- `⌘N` opens a note with no file. Its text lives in
  `<app_data>/untitled/<tab id>.md` (entity meta beside it), written by the
  normal autosave; deleted when the tab closes or the note is saved.
- Only the tab descriptor (`id`, `kind`, `path`) is persisted. The title is
  kept in local storage by the buffer's path (`doklin:untitled-title:`) and
  goes with the buffer; a note with a title or text is unsaved. Save offers
  the title as the file name.
- Closing a tab with a title or text asks Save / Don't Save / Cancel. `⌘Q` asks nothing —
  every note comes back unsaved. Closing a non-main window asks per note.
- Untitled notes belong to the window, not a folder: switching folders takes
  them along. No history, no sync, no publishing until saved.
- `orphaned_untitled` at launch reopens any buffer with text that no window
  holds as an unsaved tab in the main window; empty buffers are swept.

## Following links

- A link to a document goes there in its pane's own tab; ⌘-click (Ctrl-click
  off a Mac) opens it in a new tab beside, loaded when it is first shown, and
  nothing else moves. **One tab per file still holds**: a document open in
  another tab brings that tab forward, and the way back to the clicked note
  goes onto that tab's Back.
- A tab's steps (`Steps`, `src/tabs.ts`) are the documents it showed and
  where each was scrolled: never stored (the session keeps the descriptor),
  kept through a rename or move (`repoint`). An untitled note never follows
  in its own tab, which would close it: its links open as `openTab` does.
- **A pane follows in its own tab.** The other pane of a two-document split
  is promoted first. In a same-document split the pane that stays gets the
  document in a new tab beside (`splitOffSameDoc`): the split's tab is never
  the one moving.
- *Copy link*s of this window's workspace are followed in place too
  (`Cloud.follow`: `cloud_follow_link` in `src-tauri/src/cloud.rs`,
  `followLink` in `src/web/address.ts`); one of another workspace's goes to
  `openExternal`, which on a Mac hands it to that workspace's window.
- **⌘[ and ⌘] are taken in the capture phase on the window** (`goStep`):
  Milkdown binds them to list indent and table cells, CodeMirror to a code
  block's indent, and only stopping them first keeps a Back from also
  indenting. Tab and ⇧Tab still indent. In an html view the bridge passes
  them out, as it does the app's other shortcuts (below).
- In a browser each follow pushes a numbered entry onto its history
  (`src/web/steps.ts`), and the browser moving between two is a step for the
  tab in front. The app's own Back and Forward go through `history.go` while
  the browser has an entry of the app's that way, so the two never drift
  apart by a step.

## Windows and session

- A link to a page from outside the window it is clicked in
  (`doklin://open#…` from macOS, or `open_external` for one of another
  workspace) is turned into its file's path by the engine
  (`src-tauri/src/links.rs`) and then opened like any external open; a link
  that opens nothing says why in a dialog, since it can arrive with no window
  up.
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
- The app reads and writes the block's tag lines and nothing else in it
  (*Tags*, below). The rest shows as the file has it, in a closed
  *Frontmatter* disclosure under the tags. The worker leaves the block off
  published pages with the same splitter.
- A save of the open note writes when the body or the block differs from the
  disk's (`lastDiskMdRef`, `diskHeadRef`): a tag change is a write with the
  body unchanged.

## Tags

- **A note's tag is an unindented `key: value` line of its frontmatter**,
  and the workspace's tag list says which keys are tags and which values each
  takes. The rules (what a pair is, how a line is written and quoted, the
  list's format, names and values, the search's tokens) are `src/tags.ts`'s,
  ported for the iPhone (`Markdown/Tags.swift`) and read in Rust for the
  Mac's search (`src-tauri/src/tags.rs`), all held to
  `verify-harness/tags-fixture.json`: **change all three**.
- **A tag's line is the first line keyed by its name**, whatever the case. A
  later line for the same name is plain frontmatter. A line that isn't a pair
  (a list, a map, an empty value, a line with an indented run) gives the note
  no value, and setting the tag replaces it.
- **The list is a note**: `Tags.md` in the sidebar's first list (Library, when
  connected), found whatever its case. Its block holds one flow list per tag,
  in menu order; its body says what the values mean. Lines that don't parse
  are skipped and stay. It is read again whenever the tree is, and is the
  open note's own block while it is open (shown as the list: `TagListView`).
- **The writers hold notes to the list; readers never do.** A value the list
  doesn't have stays the note's, shown marked. Only the chip's menu sets a
  tag here.
- **A write touches the tag's line alone**: replaced in place, added before
  the closing fence, or a new block at the very top; cleared, the line goes,
  and a block left empty goes with it unless the body would then read as a
  block. The block's own line endings are kept.
- **A tag change on the open note** saves through the save path, after any
  write in flight. With nothing typed it is the new block over the body as
  the disk has it, never the editor's rendering of it (Milkdown rewrites a
  `-` list as `*`).
- **A tag change on any other note** (a rename) reads it and writes over the
  rev it read, once more on a conflict. A note in the other pane takes the
  new block and rev: a write of the window's own is never reported back.
- **A rename writes the list twice**: the new name or value beside the old,
  then the notes, then the old leaves. Notes are found with the search
  (`name:value`, or a name with any value), asked again until it finds none
  it hasn't tried. Removing a value or a tag rewrites nothing.
- **Search splits its tokens off** (`searchQuery`) and sends them beside the
  text, spelled as the list spells them; the backends never read the list.
  With tokens and no text, every note that has the tags is a result, with no
  lines. In a browser the worker answers them from its index
  ([cloud-people-agents.md](cloud-people-agents.md) *Search*).
- **No tags** on untitled notes, html-only documents, or in the html view.
  Read-only where the note is: a leased note, the other pane, a version.
- **Promoting the other pane changes nothing under the pointer.** It is
  promoted on a press, so a read-only row with no tags keeps its room, and
  every pane gets the *Add Tag…* token (a read-only row takes a bump in and
  opens nothing): a row appearing, or the menu opening and taking focus,
  would move the note, and the click (on a link, say) lands somewhere else.

## Editor traps

- A picture a note names by a path is asked for nowhere (`pictureAddress`,
  `Editor.tsx`): pictures do not sync and nothing reads one. Left to the page,
  the path would be asked of whatever serves the page, which in a browser is
  the workspace's worker, at a request against its day each. A picture on the
  web is asked for as written.
- Links (`src/linkOpen.ts`): a followed click always `preventDefault`s — a
  navigation would replace the app. `http(s)`/`mailto:` go to `open_external`
  (a *Copy link* of the workspace excepted: *Following links*); path-shaped
  hrefs resolve through `src/docLinks.ts`; other schemes are dropped; a
  `javascript:` href must never run. A ⌘-press on a link is taken from
  ProseMirror, which would select the block; ⌥- and ⇧-clicks, a drag and a
  double click stay the text's. The html rendition posts its clicks out
  through `htmlBridge.ts` (`follow`), with the href as written: the frame
  resolves a path against its own page (`/app/frame` in a browser), where
  it would pass for a web address. A link the editor marks closed (its file
  can't be opened here) is never followed by its path, which may be
  somebody else's file: the host says the engine's sentence.
- Links to documents (`src/linkMark.ts`): Crepe's link mark carries one more
  attribute, `doklin` (the file id, and what the link was read and shown
  as). The note's records and its place in the workspace must be in the
  editor's ctx before Crepe parses (`linkRecords`, `links`), and a change of
  `links` relinks in place, outside the undo history. A relink is not an
  edit: the editor reports the text as it stood through `onChange`, then the
  relinked text through `onRelinked`, which the host takes as its baseline
  only when nothing was unsaved. The mark's `toDOM` writes no id into the
  page, and every clipboard text is the markdown without the records line:
  copy and cut (`criticCopyPlugin`, which puts the records beside it in
  `application/x-doklin-links` for a paste into another note) and any drag
  (`clipboardTextSerializer`, a view prop, so it is asked before Milkdown's
  clipboard plugin).
- The `@` list (`src/mentionMenu.ts`) opens on an `@` typed through
  `handleTextInput`, never on the caret landing after one, and the `@` is
  never stored.
- Figure blocks (```` ```mermaid ```` flowcharts in `src/flowchartBlock.ts`,
  ```` ```svg ```` drawings in `src/drawing.ts`): the block is picture *or*
  source, never both, driven by `:focus-within` plus the `.dk-figure-editing`
  class (`src/figureBlock.ts`). A ```` ```mermaid ```` block of any other kind
  is not a figure: it stays a code block over a `.dk-figure-note`, which must
  never match the `:has(.preview .dk-figure)` rules.
- Flowcharts are drawn by `src/flowchart/` (pure: no DOM, nothing async; the
  public pages' module and the iPhone app run it too): Mermaid's flowchart
  syntax in, a scene out (`scene.ts`: rectangles, paths, lines of text), which
  `sceneSvg` writes with nothing a drawing may not hold and the iPhone's
  reader draws natively (`Scene.swift` mirrors it: **change both**). What is
  drawn is what `doklin help drawings` lists; `classDef`, `style`,
  `linkStyle`, `click` and `init` are read and dropped. Every caller names the
  frame it lays out for: 760, or a phone column's own width. A flowchart that
  would be shown under three quarters of its size is laid out again with
  every part that does not fit its room (the whole, or a group laid out by
  itself) turned the other way, and the narrower picture is kept
  (`place.ts`): a row of boxes is a column on a phone, whatever direction the
  source names. Change the renderer and
  `verify-harness/flowchart-fixture.json` together
  (`flowchart.test.mjs --write`, then look at the pictures).
- `dagre-d3-es` is pinned to one exact version, and only its `src/dagre` and
  `src/graphlib` are imported. It is the dagre Mermaid runs, so boxes land
  where other Mermaid renderers put them, and it keeps the boxes of a rank in
  written order (`@dagrejs/dagre` reverses them). An upgrade re-lays out every
  flowchart people wrote. Its `d3` dependency must never reach a bundle.
- A flowchart's words are measured with no page: `src/flowchart/interWidths.ts`
  is written from the bundled Inter by `scripts/inter-widths.mjs` (`--check`
  in CI). Run it when the fonts change.
- Drawings go through `sanitizeDrawing` (`src/drawingSvg.ts`, pure, also run by
  the worker): an element/attribute allowlist re-serialized from its own
  parse, and every `id`/`url(#…)` prefixed per drawing so two drawings never
  share a marker. Colours are `--dg-*` tokens — a contract documents depend
  on: never rename one, only add. The drawing grammar agents follow is
  `doklin help drawings` (`cli/src/help.rs`); `verify-harness/drive-drawing.mjs`
  renders its examples, so change the two together.
- Callouts (`src/callout.ts`; the kinds, meanings and icons in
  `src/calloutTypes.ts`, which the worker, the iPhone and `doklin help
  writing` share): GitHub's `> [!NOTE]` alerts. Only a top-level quote whose
  first line is the marker alone becomes one; anything else stays a quote,
  as GitHub shows it. The stringify handler writes the marker itself — left
  to remark it is text and comes back `\[!NOTE]` — and writes it as it was
  read (case, a blank line after it); a new or re-picked one is uppercase.
  Milkdown has already turned the marker's line ending into a `break` node
  when the transform runs. The title is a node-view widget, never text; a
  click on it sends `dk-callout-pick`, which `CalloutPicker.tsx` answers (the
  iPhone's page has its own). `verify-harness/drive-callouts.mjs` opens and
  saves the help's examples byte for byte, so change the two together.
- The outline (`src/DocOutline.tsx`) reads headings off the document, never
  the DOM (Crepe's block handle sits first among the editor's children), and
  is fixed to the window at the pane's box, measured on the comment rail's
  tick. It sits right, or left while the comment rail holds the right, or
  nowhere when neither side has room.
- Milkdown's listener reports a change 200 ms after it and never cancels that
  wait, so it also calls an editor destroyed in the meantime — and a tab
  switch mounts one for a moment, holding the outgoing note's text.
  `Editor.tsx` listens to `updated`, checks `editor.status` first and
  serializes there. Subscribing to `markdownUpdated` has Milkdown serialize
  on that wait instead, and writing a paragraph asks for the view, which
  throws once the editor is gone.
- Sidebar and tab drags are pointer-based: Tauri intercepts HTML5 drag.
- Zoom (`⌘+`/`⌘-`/`⌘0`) scales the markdown editor through `--doc-zoom` and
  the html rendition through its frame's bridge; app chrome never scales.
- **Keys pressed in the html rendition stop at its frame**: the window's
  key handlers never see them. The bridge matches the app's shortcuts as
  they do (`appShortcut`, `htmlBridge.ts`: change both) and passes them out
  by name (`APP_SHORTCUTS`, `src/keys.ts`); both paths run `runShortcut`.
  The page keeps `⌘F`, `⌘S`, `⌘⌫`, `⌘C`/`⌘X`/`⌘V` and `⌘Z`.
- **A page can fake any shortcut it passes**: its own scripts post whatever
  the bridge can. So only a shortcut that is harmless when faked goes in
  `APP_SHORTCUTS`, and the app takes one only while the frame holds focus.

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
- Appearance is the theme and Full width, both per app. The document's faces
  (serif `--font-heading`, sans `--font-text`) are fixed tokens, not reader
  choices. Its 680px `--doc-measure` is the column's cap: Full width
  (`data-full-width` on `<html>`) lifts it and keeps the side padding, and
  anything sized to the column (a drawing) holds to the measure instead of
  the pane. Public pages always use the column. Heading sizes are fixed px ×
  zoom.
- Bundled fonts (Inter, Literata, Roboto Mono, OFL) are named in
  `src/styles/fonts.css`; the worker imports each file by name
  (`cloud-worker/src/theme.ts`) — change both.
- Code block placeholders must match the mounted editor's height exactly
  (App.css "Code block placeholder parity"); the tools row floats out of flow.
- `localStorage` keys: `doklin:theme`, `doklin:full-width`.
