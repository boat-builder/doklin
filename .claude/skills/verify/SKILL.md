# Verify — Doklin

Doklin is a macOS-only Tauri app, so the full app can't run on a Linux
runner. What CAN be verified end-to-end there is the frontend feature
surface, driven in real Chromium.

## Frontend features (Chromium harness)

`verify-harness/` mounts real components from `src/` in a plain browser page
(Tauri IPC stubbed via `window.__TAURI_INTERNALS__` in `index.html`). It
currently covers the HTML-rendition comment layer (`HtmlView` + the injected
iframe bridge + `CommentsRail` + the sidecar model).

```sh
pnpm install
pnpm exec vite --port 1420 --strictPort    # dev server, repo root, keep running
(cd verify-harness && npm install)         # driver lib only (own package.json — npm can't
                                           # write into the pnpm node_modules); browser is preinstalled
node verify-harness/drive.mjs              # 15 scripted steps + screenshots into verify-harness/shots/
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
the actual public flows — gate unlock, comments, the html anchoring layer:

```sh
node verify-harness/serve-worker.mjs &   # http://localhost:8787, owner token "owner-secret"
node verify-harness/drive-web.mjs        # gate → comment → anchor round-trip + no-JS parity
```

Also: `node share-worker/test/run.mjs` is the pure-node e2e suite for every
worker route (no browser needed) — run it for any worker change.

## Rust side

`cd src-tauri && cargo check` works on Linux after
`apt-get install libgtk-3-dev libwebkit2gtk-4.1-dev librsvg2-dev` and
creating dummy gitignored resources the build script expects:
`binaries/doklin-stt-x86_64-unknown-linux-gnu` (empty file) plus empty dirs
`binaries/{mlx-swift_Cmlx,swift-crypto_Crypto,swift-transformers_Hub}.bundle`.
`cargo test --lib sync` runs the sync engine tests. Menu-constant dead-code
warnings on Linux are pre-existing (macOS-only paths).
