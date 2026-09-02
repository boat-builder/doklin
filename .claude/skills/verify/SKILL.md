# Verify — Doklin

Doklin is a macOS-only Tauri app, so the full app can't run on a Linux
runner. What CAN be verified end-to-end there is the frontend feature
surface, driven in real Chromium.

## Frontend features (Chromium harness)

`verify-harness/` mounts real components from `src/` in a plain browser page
(Tauri IPC stubbed via `window.__TAURI_INTERNALS__` in `index.html`). It
currently covers the HTML-rendition comment layer (`HtmlView` + the injected
iframe bridge + `CommentsRail` + the sidecar model), the mermaid diagram
pipeline (`src/mermaid.ts` + the Editor wiring), the inline-code newline
normalization (`src/inlineCodeNewlines.ts`), and datastores / kanban boards
(`src/store/` + `StoreView` / `KanbanBoard` / `TableView` +
`PropertiesHeader` + `CardPeek` + the sidebar's board row).

```sh
pnpm install
pnpm exec vite --port 1420 --strictPort    # dev server, repo root, keep running
(cd verify-harness && npm install)         # driver lib only (own package.json — npm can't
                                           # write into the pnpm node_modules); browser is preinstalled
node verify-harness/drive.mjs              # 23 scripted steps + screenshots into verify-harness/shots/
                                           # (comment mode: button, scrim spotlight, hover bubble,
                                           # pins, floating cards, orphans)
node verify-harness/drive-mermaid.mjs      # 14 steps: gallery render, diagram⇄source switch,
                                           # live edit, error card, theme flip, /diagram slash
                                           # item, picker, read-only
node verify-harness/shot-mermaid.mjs       # optional: full-page shots of the diagram gallery
                                           # in light/sepia/dark for an eyeball pass
node verify-harness/drive-inline-code.mjs  # 7 steps: hard-wrapped inline code spans parse to a
                                           # single-space value, render one-line, and serialize
                                           # back on one line
node verify-harness/drive-links.mjs        # 25 steps: click-to-follow for links (src/linkOpen.ts)
                                           # — which clicks follow and which fall through to the
                                           # caret (modifier, drag, second half of a double click),
                                           # a follow never navigating the page, #anchors scrolling
                                           # in-editor, Crepe's hover tooltip url, read-only
                                           # documents, and the schemes openInBrowserTab refuses
node verify-harness/drive-meta.mjs         # 8 steps: boots the REAL <App/> (meta.html seeds
                                           # OLD-layout docs) and walks the entity-meta layout
                                           # (src/metaFile.ts) — lazy migration on open (inline
                                           # thread bodies → <stem>.meta.jsonl, legacy html
                                           # sidecar folded in and left in place), the workspace
                                           # sweep migrating unopened docs, expansion feeding the
                                           # editor full CriticMarkup, a reply saving meta-only
                                           # (markdown byte-identical), reload persistence,
                                           # orphan cards, deletion scrubbing both files
node verify-harness/drive-table-resize.mjs # 15 steps: table column-width PERSISTENCE against
                                           # the real Editor — a drag emits `tcols` records and
                                           # leaves the markdown byte-identical, a remount
                                           # restores the columns on first paint, a header
                                           # rename re-keys the record instead of orphaning it,
                                           # and a read-only view resizes without ever emitting
node verify-harness/drive-kanban.mjs       # 58 steps: boots the REAL <App/> (kanban.html seeds a
                                          # /docs workspace holding a DATASTORE) and walks the
                                          # board end to end — the sidebar's one-row board with
                                          # no cards under it, the board tab, columns from
                                          # store.jsonl in rank order, a pointer drag between
                                          # columns, the inline card and column composers,
                                          # peeking a card and then opening it as an ordinary
                                          # note, the properties header on a card AND on a plain
                                          # note (+ Add property adds a key there, and on a card
                                          # declares a FIELD on the store), the view strip adding
                                          # a table view, a table cell writing a card and a
                                          # heading saving the view's sort — and at every step
                                          # the invariant the design rests on: a card's BODY
                                          # bytes never move when its properties do (and a note
                                          # with no frontmatter never grows one)
node verify-harness/drive-kanban-embed.mjs # 53 steps over the SAME harness page: a ```kanban
                                          # fence in a note (kanban.html seeds /docs/Embed.md
                                          # and /docs/Broken.md) rendering as a live board —
                                          # a card composed in the embed never reaching
                                          # ProseMirror, a drag writing one card and not the
                                          # note, an ordinary prose edit re-serializing the note
                                          # with the fence BYTE-IDENTICAL, the Source chip
                                          # rewriting the config, ⌫ + undo on the block, the
                                          # slash menu's Board item and its in-place store
                                          # picker (writing a path relative to the note), a
                                          # ```table fence beside a ```kanban one in the SAME
                                          # note (both round-tripping through one ordinary
                                          # edit), an embed pointing at a folder that isn't a
                                          # board, and a split pane's board going read-only
                                          # until promoted.
                                          # The last block drives what a SHARE would publish
                                          # (src/store/publish.ts) straight against the stubbed
                                          # fs — the one seam store.test.mjs can't reach, since
                                          # it goes through the backend's read_store
node verify-harness/drive-split.mjs        # 18 steps: boots the REAL <App/> (split.html stubs
                                           # enough IPC: in-memory fs, /docs workspace tree,
                                           # window init, sync probes) and walks the split view —
                                           # same-doc duplicate split (read-only mirror tracking
                                           # autosaves), per-pane MD/HTML picks with live-editor
                                           # normalization, two-doc split + promotion by click /
                                           # iframe gesture, sync scroll off-by-default then
                                           # chained (md↔html and md↔md), divider + sidebar
                                           # resize, sidebar-file and tab drag-to-pane drop
                                           # zones, session-restore round trip, and (riding the
                                           # same real-app boot) following a link between notes:
                                           # a sibling opens in a tab, a missing target does
                                           # nothing, an external url goes to open_external
```

The driver prints PASS/FAIL per step and exits non-zero on failure.
Chromium lives at `/opt/pw-browsers/chromium` (launch with `--no-sandbox`
as root; `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` is already set).

Gotchas learned the hard way:

- The html view's comment layer only exists in comment mode — click
  `.html-comment-btn` first; outside the mode there is no hover bubble, no
  scrim, no pins.
- The add-comment bubble follows the pointer on rAF — hover, then wait for
  the bubble to settle next to the target before clicking (`clickBubbleFor`
  in the driver), or the click lands on the page.
- After a bubble click (focus goes into the iframe), poll until
  `document.activeElement` is the card textarea before typing.
- Frame locators report boxes in PAGE coordinates; the bridge's scrim canvas
  and anchor rects live in iframe-viewport space — subtract the iframe's own
  box before comparing.
- In the MD rail, with a card active, cards above it clamp toward the rail
  top and may overlap — that's the designed "cram" behavior. Deselect (click
  a non-commented spot) before clicking buttons on other cards.
- Leaving a document whose LAST block is a leaf node (a thematic break, a
  ```kanban embed) can log `Context "editorView" not found` — milkdown's
  listener debounces its serialize by 200ms and fires it after the editor's
  ctx is gone. Pre-existing (a note ending in `---` does it with every kanban
  plugin unregistered) and harmless; drive-kanban-embed.mjs filters it by
  name so it isn't mistaken for a defect.
- A published board is drawn TWICE from one snapshot: as HTML strings in
  `share-worker/src/index.js` (the static reading view) and as React in
  `src/BoardSnapshot.tsx` (the app shell). Same class names, same palette,
  two stylesheets — change one and change the other, and check both in
  `drive-web.mjs`. Inside either, use a `<div>` rather than a `<p>` for
  board chrome: `.doc p` and the editor's own paragraph styling will claim
  a paragraph.
- Clicking a card on a board PEEKS it (`CardPeek`), it does not open a tab —
  unless the card is already open in a tab, in which case the click goes to
  the tab. A driver that expects an editor after a card click has to click
  `.dk-peek-tab` first, and the harness's IPC stub needs `write_body` (the
  peek's body write) or every keystroke in the panel is silently dropped.
- `/board` in the slash menu now matches TWO items (Board, Board as a table),
  in that order. Filtering by text won't separate them — "Board as a table"
  contains "Board"; index them.
- A ProseMirror node view for a `draggable` node gets `draggable=true` on its
  DOM, and the native HTML5 drag that starts from it swallows the pointer
  events any inner drag needs. If a drag inside a node view "does nothing",
  check for a `dragstart` before blaming the pointer handlers.
- The harness runs under StrictMode: wire harness buttons with `onclick=`
  assignment, not `addEventListener` (double-mount would double-toggle).
- split.html seeds localStorage ONCE per browser context (guarded by
  `doklin:harness-seeded`) — a reload must keep what the app persisted, or
  the session/split restore steps can't be tested. Its IPC stub must answer
  `sync_status` with `[]` and `sync_device` with `{name}` (App `.then`s the
  shapes straight into state), and stub
  `__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener` or StrictMode's
  unmount pass throws on every `listen()` cleanup.

## Public web pages (worker served locally)

`verify-harness/serve-worker.mjs` runs the real share worker over node http
with an in-memory R2 fake (state resets on restart), so a browser can walk
the actual public flows. Since worker v10, comment/edit sessions get the APP
SHELL (the desktop's own editor + comment rail compiled for the browser), so
the drive exercises the real Milkdown editor and the real rail end to end:

```sh
node scripts/build-web.mjs               # compiles web/main.tsx → share-worker/dist/web
                                         # (rerun after ANY src/ editor change)
node verify-harness/serve-worker.mjs &   # http://localhost:8787, owner token "owner-secret"
node verify-harness/drive-web.mjs        # 42 steps: gate → comment-mode html comment →
                                         # reply → read-only md + selection comment
                                         # (CriticMarkup save) → view-role stripping →
                                         # edit-role autosave → desktop-pushed thread pins
                                         # → desktop-pushed table column widths on BOTH
                                         # reading paths (static-page colgroup, shell editor)
                                         # → a ```kanban embed, three ways: with no snapshot
                                         # the shell draws the frame and says the board isn't
                                         # available; WITH one it draws the board (columns,
                                         # colours, chips, +n more, a card linking to its own
                                         # page) and an edit-role save still returns the fence
                                         # byte for byte; and the static reading view renders
                                         # the same board server-side with JAVASCRIPT OFF,
                                         # plus a shared card's properties table; then the
                                         # SAME store as a ```table fence, drawn server-side
                                         # and in the shell, with an edit-role save still
                                         # returning the table fence byte for byte
node verify-harness/drive-mermaid-web.mjs  # 7 steps: static-page diagram hydration (light +
                                           # dark), broken-source fallback, shell renders via
                                           # the worker-served /__web mermaid module
```

serve-worker serves `/__web/*` from `share-worker/dist/web` (the plain-node
import leaves the embedded-assets stub empty — that's expected; deployable
bundles embed them via scripts/bundle-worker.mjs).

Also: `node share-worker/test/run.mjs` is the pure-node e2e suite for every
worker route (no browser needed) — run it for any worker change. It covers
the `boards` / `props` wire contract too: what a published page does with a
board snapshot, what it does with a fence that has none, and that junk
inside one degrades record by record while a wrong TYPE is a 400. It bakes in
the table-identity ids that `verify-harness/tablewidths.test.mjs` also pins:
the worker re-derives them from marked's tokens, so a change to
`src/tableWidths.ts` fails BOTH suites instead of silently dropping column
widths from published pages. Re-pin in both places, never one.

The desktop⇄web comment-thread three-way merge (the correctness core of pool
sync) has its own fast unit test — run it for any change to
`src/htmlComments.ts` merge logic or the sync flow:

```sh
node verify-harness/merge.test.mjs   # deletions stick, eid dedupe, concurrent replies
```

Four more pure-node unit suites (vite-compiled, no browser):

```sh
node verify-harness/metafile.test.mjs      # the entity meta file: expand/extract round trip,
                                           # tolerant parse, deterministic serialization,
                                           # the idempotent migration step
node verify-harness/tablewidths.test.mjs   # table-width identity (src/tableWidths.ts): what
                                           # keeps a column width and what deliberately drops
                                           # it, colspan/rowspan, junk records
node verify-harness/doclinks.test.mjs      # resolving a link inside a note to a path
                                           # (src/docLinks.ts): relative/absolute/file:// targets,
                                           # percent escapes, dropped fragments, what is
                                           # deliberately not a path, "." / ".." folding, and
                                           # relativeLinkPath (the inverse the board picker
                                           # writes) round-tripping back through it
node verify-harness/store.test.mjs         # the pure modules a datastore is built from
                                           # (src/store/): the frontmatter dialect (what IS a
                                           # block, the value grammar, opaque lines that survive
                                           # verbatim, canonical round-tripping bytes), the
                                           # store.jsonl definition file (header-or-nothing,
                                           # tolerant parse, equal state ⇒ equal bytes, options
                                           # sorted by name so a column MOVE is one line), and
                                           # the fractional index (strict ordering under a
                                           # thousand same-gap inserts, short keys when
                                           # appending, junk ranks that never block a drag),
                                           # the saved VIEW record (its kind, filter, sort,
                                           # show and hide, parsed tolerantly and written back
                                           # byte-identically when it carries nothing new);
                                           # plus an embed's config (the same dialect without a
                                           # block around it) and its fence, which grows past
                                           # any backtick run in the config; the scan that finds
                                           # fences in raw bytes (storeFences — a share push has
                                           # no parsed document); the board and table derivation
                                           # and snapshot (src/store/board.ts) that a tab, an
                                           # embed and a published page all share, so they can't
                                           # disagree — filters, sorts, multi_select and date
                                           # grouping included; and the CSV a view exports
                                           # (2252 checks)
```

## Rust side

`cd src-tauri && cargo check` works on Linux after
`apt-get install libgtk-3-dev libwebkit2gtk-4.1-dev librsvg2-dev` and
creating dummy gitignored resources the build script expects:
`binaries/doklin-stt-x86_64-unknown-linux-gnu` (empty file) plus empty dirs
`binaries/{mlx-swift_Cmlx,swift-crypto_Crypto,swift-transformers_Hub}.bundle`.
`cargo test --lib` runs every Rust test: the sync engine's two-device
merge/conflict/CAS matrix (`--lib sync`), the sidebar tree walk including the
one-row board (`--lib tree_tests`), and the datastore file surface
(`--lib store`: locating a card's leading frontmatter block, splicing a new one
in with the body byte-identical, the snapshot guard, what `read_store` lists
and what it leaves out). Menu-constant dead-code warnings on Linux are
pre-existing (macOS-only paths).

Two steps of `drive-links.mjs` (Crepe's hover tooltip) fail on this runner and
did before any of this — don't chase them.
