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
`PropertiesHeader` + `CardPeek` + the sidebar's board row), the cloud's
surfaces over a scripted engine (`drive-cloud.mjs`), and the public pages a
published workspace serves (`drive-public.mjs`, against the real worker).

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
                                           # thread bodies → <stem>.meta.jsonl), the workspace
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
node verify-harness/drive-kanban-embed.mjs # 44 steps over the SAME harness page: a ```kanban
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
                                          # until promoted
node verify-harness/drive-split.mjs        # 18 steps: boots the REAL <App/> (split.html stubs
                                           # enough IPC: in-memory fs, /docs workspace tree,
                                           # window init, the device name) and walks the split view —
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
node verify-harness/drive-cloud.mjs        # 29 steps: boots the REAL <App/> (cloud.html stubs the
                                           # ENGINE: every cloud_* command answers from a scripted
                                           # fake, window.__emit injects the engine's events) and
                                           # walks the cloud surfaces — the not-connected panel, the
                                           # wizard's fresh / bound / marker outcomes (the setup
                                           # prompt carrying the token, the derived names, the
                                           # route, the runtime date read from version.ts), the
                                           # panel's phases on both dots, the gear badge, the worker
                                           # update card (a prompt with no secret, Check again), a
                                           # held mass-deletion's toast → panel → confirm, a conflict
                                           # copy's toast opening the copy, cloud-applied refreshing
                                           # the tree, presence chips, Connect another Mac, the
                                           # history panel restoring a revision, disconnect, wipe →
                                           # the teardown prompt, and the join flow opening the
                                           # downloaded folder — and publishing: the pill's
                                           # not-connected door, a note published at a random then
                                           # a chosen address (Copy, a bad slug refused), the
                                           # sidebar's dots, the folder dialog, a note inside a
                                           # published folder knowing its nested address, the
                                           # published list (home page, stop), the sidebar's
                                           # undoable stop
node verify-harness/serve-worker.mjs &     # the cloud worker bundled in-process (mermaid module
                                           # included, ~1 min) over an in-memory bucket seeded with
                                           # cloud-worker/test/seed.mjs, on http://localhost:8787
node verify-harness/drive-public.mjs       # 8 steps against it, in Chromium: a note with stored
                                           # column widths, the MD/HTML pill and the sandboxed
                                           # rendition (its script runs), the folder page's cards,
                                           # the crumb on a nested note, a board with JavaScript
                                           # OFF (cards linking to their pages, a card's
                                           # properties), a diagram hydrating in light and dark,
                                           # the root page's rewritten links and a picture inside
                                           # the published folder, 404s
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
- Inside board chrome, use a `<div>` rather than a `<p>`: `.doc p` and the
  editor's own paragraph styling will claim a paragraph.
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
  `device_name` with a string (App `.then`s it straight into the comment
  author), and stub `__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener` or
  StrictMode's unmount pass throws on every `listen()` cleanup.
- A harness that DELIVERS events (cloud.html) has to honour unlisten:
  `plugin:event|listen` hands back an id, and both `plugin:event|unlisten`
  and `unregisterListener` must drop that id — StrictMode mounts twice, so
  a registry that only ever grows delivers every event twice (two toasts).
- Playwright auto-dismisses `window.confirm` (it returns false), so a
  destructive action the drive has to reach must confirm inline (the
  panel's Disconnect, the popover's Stop) or by typing the name back (the
  wipe), never with a native dialog. The sidebar's Stop publishing avoids
  the question entirely: it stops at once and the toast's Undo brings the
  page back.
- The worker's pages inline their stylesheet, so a test that asserts "no
  pill" or "no crumb" must look for the markup (`<nav class="view-pill"`),
  not the class name — the CSS mentions both on every page.
- The worker only reaches `caches.default` and `ctx.waitUntil` when the
  runtime has them; a node harness installs `globalThis.caches` itself
  (test/fake-r2.mjs `FakeCache`) and passes a ctx whose waitUntil swallows.
- cloud.html's fake engine reports the worker version the drive hands it
  (`window.__cloud.workerVersion`, parsed from version.ts) — a hardcoded
  `1` made "Check again" never rest once the real version moved to 2.

Six pure-node unit suites (vite-compiled, no browser):

```sh
node verify-harness/merge.test.mjs         # the comment-thread three-way merge
                                           # (src/htmlComments.ts): deletions stick, eid
                                           # dedupe, concurrent replies
node verify-harness/metafile.test.mjs      # the entity meta file: expand/extract round trip,
                                           # tolerant parse, deterministic serialization,
                                           # the idempotent migration step
node verify-harness/tablewidths.test.mjs   # table-width identity (src/tableWidths.ts): what
                                           # keeps a column width and what deliberately drops
                                           # it, colspan/rowspan, junk records
node verify-harness/cloudprompts.test.mjs  # the three agent prompts (src/cloudPrompts.ts) —
                                           # setup with the token, update and teardown without
                                           # — and the naming rule they share: numbered steps,
                                           # login, verify-before-mutate, the config verbatim,
                                           # the failure named, one line back, the negative
                                           # scope; a workers.dev name is certain, a custom
                                           # domain's is a convention the prompt says to verify
                                           # (112 checks)
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
                                           # fences in raw bytes (storeFences — no parsed
                                           # document needed); the board and table derivation
                                           # and snapshot (src/store/board.ts) that a tab, an
                                           # embed and a published page all share, so they can't
                                           # disagree — filters, sorts, multi_select and date
                                           # grouping included; and the CSV a view exports
                                           # (2252 checks)
```

## Cloud worker (`cloud-worker/`)

The Cloudflare Worker behind a connected domain — TypeScript, its own
tsconfig (Workers runtime types, no DOM), tested without deploying:

```sh
pnpm exec tsc -p cloud-worker/tsconfig.json --noEmit
node cloud-worker/test/run.mjs             # 23 cases against an in-memory R2 fake (test/fake-r2.mjs,
                                           # shared with serve-worker.mjs), the sources compiled
                                           # in-process through vite: auth, meta, bind-once (409),
                                           # the unbound 404s + landing page, manifest CAS (304 /
                                           # 412 / 428), validation + the public map, 426 on a
                                           # newer schema, blobs (a re-put is a no-op), history,
                                           # presence (device header, prune, leave), the statics /
                                           # OG image / an empty folder page / 404s, then the seed
                                           # workspace loaded through the API and the renderer: a
                                           # note (title, description, noindex, HEAD), a rendition
                                           # (framed, ?v=md, /raw sandboxed), a folder page and
                                           # nested paths (crumb, case-insensitive, exact-path
                                           # files, traversal 404s), boards / tables / a card's
                                           # properties from the datastore, column widths under
                                           # the app's table identity, comment stripping, the
                                           # mermaid hydrator, link rewriting, the root page, the
                                           # cache keyed by manifest etag (a fake caches.default),
                                           # the landing fallback; wipe freeing the domain last
node scripts/bundle-worker.mjs             # → cloud-worker/dist/doklin-cloud-worker.js (the
                                           # mermaid module spliced in; ~40 s); prints raw +
                                           # gzipped size, fails past 3 MB gzipped
node cloud-worker/test/run.mjs --bundle cloud-worker/dist/doklin-cloud-worker.js
                                           # the same suite against the bundle — the mermaid
                                           # asset then serves instead of 503
```

`--no-mermaid` gives a quick bundle for shape checks (the /__web asset 503s).

## Rust side

`cd src-tauri && cargo check` works on Linux after
`apt-get install libgtk-3-dev libwebkit2gtk-4.1-dev librsvg2-dev` and
creating dummy gitignored resources the build script expects:
`binaries/doklin-stt-x86_64-unknown-linux-gnu` (empty file) plus empty dirs
`binaries/{mlx-swift_Cmlx,swift-crypto_Crypto,swift-transformers_Hub}.bundle`.
`cargo test --lib` runs every Rust test: the cloud engine against an
in-memory worker (`--lib cloud` — 38 tests: the two-device merge / conflict /
tombstone / rename / history / CAS-race matrix, the public map (mirroring,
rename-follow, re-bind, a folder page following its folder, the custom-slug
race, the root page), bind-once and the upload / download / resume flows, a
touched path settling in 1.5 s against a watched one's 5 s under tokio's
paused clock, the 426 → worker-outdated state and the Probe command that
resumes it, presence, history, the edit bus routing, cloud.json and the
marker), the sidebar tree walk including the
one-row board (`--lib tree_tests`), and the datastore file surface
(`--lib store`: locating a card's leading frontmatter block, splicing a new one
in with the body byte-identical, the snapshot guard, what `read_store` lists
and what it leaves out). Menu-constant dead-code warnings on Linux are
pre-existing (macOS-only paths).

Two steps of `drive-links.mjs` (Crepe's hover tooltip) fail on this runner and
did before any of this — don't chase them.
