# Verify — Doklin

Doklin is a macOS-only Tauri app, so the full app can't run on a Linux
runner. What CAN be verified end-to-end there is the frontend feature
surface, driven in real Chromium.

## Frontend features (Chromium harness)

`verify-harness/` mounts real components from `src/` in a plain browser page
(Tauri IPC stubbed via `window.__TAURI_INTERNALS__` in `index.html`). It
currently covers the HTML-rendition comment layer (`HtmlView` + the injected
iframe bridge + `CommentsRail` + the sidecar model), the mermaid diagram
pipeline (`src/mermaid.ts` + the Editor wiring), and the inline-code newline
normalization (`src/inlineCodeNewlines.ts`).

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
node verify-harness/drive-split.mjs        # 18 steps: boots the REAL <App/> (split.html stubs
                                           # enough IPC: in-memory fs, /docs workspace tree,
                                           # window init, sync probes) and walks the split view —
                                           # same-doc duplicate split (read-only mirror tracking
                                           # autosaves), per-pane MD/HTML picks with live-editor
                                           # normalization, two-doc split + promotion by click /
                                           # iframe gesture, sync scroll off-by-default then
                                           # chained (md↔html and md↔md), divider + sidebar
                                           # resize, sidebar-file and tab drag-to-pane drop
                                           # zones, session-restore round trip
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
node verify-harness/drive-web.mjs        # 21 steps: gate → comment-mode html comment →
                                         # reply → read-only md + selection comment
                                         # (CriticMarkup save) → view-role stripping →
                                         # edit-role autosave → desktop-pushed thread pins
                                         # → desktop-pushed table column widths on BOTH
                                         # reading paths (static-page colgroup, shell editor)
node verify-harness/drive-mermaid-web.mjs  # 7 steps: static-page diagram hydration (light +
                                           # dark), broken-source fallback, shell renders via
                                           # the worker-served /__web mermaid module
```

serve-worker serves `/__web/*` from `share-worker/dist/web` (the plain-node
import leaves the embedded-assets stub empty — that's expected; deployable
bundles embed them via scripts/bundle-worker.mjs).

Also: `node share-worker/test/run.mjs` is the pure-node e2e suite for every
worker route (no browser needed) — run it for any worker change. It bakes in
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

Two more pure-node unit suites (vite-compiled, no browser):

```sh
node verify-harness/metafile.test.mjs      # the entity meta file: expand/extract round trip,
                                           # tolerant parse, deterministic serialization,
                                           # the idempotent migration step
node verify-harness/tablewidths.test.mjs   # table-width identity (src/tableWidths.ts): what
                                           # keeps a column width and what deliberately drops
                                           # it, colspan/rowspan, junk records
```

## Rust side

`cd src-tauri && cargo check` works on Linux after
`apt-get install libgtk-3-dev libwebkit2gtk-4.1-dev librsvg2-dev` and
creating dummy gitignored resources the build script expects:
`binaries/doklin-stt-x86_64-unknown-linux-gnu` (empty file) plus empty dirs
`binaries/{mlx-swift_Cmlx,swift-crypto_Crypto,swift-transformers_Hub}.bundle`.
`cargo test --lib sync` runs the sync engine tests. Menu-constant dead-code
warnings on Linux are pre-existing (macOS-only paths).
