# Verify — Doklin

Doklin is a macOS-only Tauri app, so the full app can't run on a Linux
runner. What CAN be verified end-to-end there is the frontend feature
surface, driven in real Chromium.

## Frontend features (Chromium harness)

`verify-harness/` mounts real components from `src/` in a plain browser page
(Tauri IPC stubbed via `window.__TAURI_INTERNALS__` in `index.html`). It
currently covers the HTML-rendition comment layer (`HtmlView` + the injected
iframe bridge + `CommentsRail` + the sidecar model) and the mermaid diagram
pipeline (`src/mermaid.ts` + the Editor wiring).

```sh
pnpm install
pnpm exec vite --port 1420 --strictPort    # dev server, repo root, keep running
(cd verify-harness && npm install)         # driver lib only (own package.json — npm can't
                                           # write into the pnpm node_modules); browser is preinstalled
node verify-harness/drive.mjs              # 17 scripted steps + screenshots into verify-harness/shots/
node verify-harness/drive-mermaid.mjs      # 13 steps: gallery render, live edit, error card,
                                           # theme flip, /diagram slash item, picker, read-only
node verify-harness/shot-mermaid.mjs       # optional: full-page shots of the diagram gallery
                                           # in light/sepia/dark for an eyeball pass
```

The driver prints PASS/FAIL per step and exits non-zero on failure.
Chromium lives at `/opt/pw-browsers/chromium` (launch with `--no-sandbox`
as root; `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` is already set).

Gotchas learned the hard way:

- The add-comment bubble follows the pointer on rAF — hover, then wait for
  the bubble to settle next to the target before clicking (`clickBubbleFor`
  in the driver), or the click lands on the page.
- After a bubble click (focus goes into the iframe), poll until
  `document.activeElement` is the rail textarea before typing.
- With a card active, cards above it clamp toward the rail top and may
  overlap — that's the designed "cram" behavior (same as the md rail).
  Deselect (click a non-commented spot) before clicking buttons on other
  cards.
- The harness runs under StrictMode: wire harness buttons with `onclick=`
  assignment, not `addEventListener` (double-mount would double-toggle).

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
node verify-harness/drive-web.mjs        # 18 steps: gate → html rail comment → reply →
                                         # read-only md + selection comment (CriticMarkup
                                         # save) → view-role stripping → edit-role autosave
                                         # → desktop-pushed thread visibility
node verify-harness/drive-mermaid-web.mjs  # 7 steps: static-page diagram hydration (light +
                                           # dark), broken-source fallback, shell renders via
                                           # the worker-served /__web mermaid module
```

serve-worker serves `/__web/*` from `share-worker/dist/web` (the plain-node
import leaves the embedded-assets stub empty — that's expected; deployable
bundles embed them via scripts/bundle-worker.mjs).

Also: `node share-worker/test/run.mjs` is the pure-node e2e suite for every
worker route (no browser needed) — run it for any worker change.

The desktop⇄web comment-thread three-way merge (the correctness core of pool
sync) has its own fast unit test — run it for any change to
`src/htmlComments.ts` merge logic or the sync flow:

```sh
node verify-harness/merge.test.mjs   # deletions stick, eid dedupe, concurrent replies
```

## Rust side

`cd src-tauri && cargo check` works on Linux after
`apt-get install libgtk-3-dev libwebkit2gtk-4.1-dev librsvg2-dev` and
creating dummy gitignored resources the build script expects:
`binaries/doklin-stt-x86_64-unknown-linux-gnu` (empty file) plus empty dirs
`binaries/{mlx-swift_Cmlx,swift-crypto_Crypto,swift-transformers_Hub}.bundle`.
`cargo test --lib sync` runs the sync engine tests. Menu-constant dead-code
warnings on Linux are pre-existing (macOS-only paths).
