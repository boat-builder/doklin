# Doklin

macOS-only (Apple Silicon) Tauri 2 markdown editor. `src/` React + Milkdown
Crepe frontend (`src/web/`: the same frontend in a browser, served by the
worker at `/app`), `src-tauri/` Rust backend, `engine/` the sync engine and
version store (Rust, no Tauri: the Mac and iPhone apps both build it in),
`cloud-worker/` Cloudflare Worker, `cli/` the `doklin` command, `ios/` the
iPhone and iPad app (Swift, built from Xcode by hand), `site/` the doklin.cc
product page (static, deployed by `.github/workflows/site.yml`).

## Commands

```sh
pnpm install && pnpm tauri dev                 # run the app
pnpm build && pnpm lint                        # typecheck + build the frontend, eslint
(cd engine && cargo test --workspace)          # Rust: the sync engine, versions, the C interface
cd src-tauri && cargo test --lib               # Rust: the Mac app's own (tree, untitled, pdf)
pnpm typecheck:worker && pnpm test:worker      # the cloud worker
(cd cli && cargo build --release && cargo test) # the CLI
node verify-harness/drive-ios.mjs             # the iOS app's core against a harness worker
node verify-harness/drive-ios.mjs --app       # the iOS app in a simulator (a Mac with Xcode)
node verify-harness/drive-web.mjs             # the browser version, built, against a harness worker
node verify-harness/drive-open.mjs            # doklin.cc's link page (site/public/open.html)
```

`swift test --package-path ios/DoklinKit` links the engine: `scripts/ios-engine.sh
host` first, and `-Xlinker -L$PWD/ios/Engine/host` (drive-ios.mjs does both).

`verify-harness/drive-*.mjs` drive real `src/` components in Chromium with
Tauri IPC stubbed: `(cd verify-harness && npm install)` once, a vite server on
`:1420` (`pnpm exec vite --port 1420 --strictPort`), then `node <driver>`.

## Rules

- Every push to `main` cuts a release, unless it only touches `site/` or `ios/`.
  One that touches `site/` puts it on doklin.cc.
- The frontend never `fetch`es. The cloud engine in Rust is the only code that
  holds a token or talks to a domain. In a browser the one module that
  fetches is `src/web/http.ts`, and it holds no token.
- The UI asks `src/backend.ts`. Only `src/mac/` imports Tauri; `src/web/`
  answers it in a browser.
- Contracts mirrored in two places say "change both" on both sides — change both.
- A number with one source is parsed from it, never retyped.
- macOS-specific Rust is tagged `macOS-only`.
- User-facing errors are sentences.

## Docs

Read a doc only when the change is in its area.

| Area | Doc |
|---|---|
| App shell, `src/backend.ts`, `src/web/`, saving, tabs, windows, editor, frontmatter | `docs/architecture.md` |
| `engine/` (not `versions/`), `src-tauri/src/engine.rs`, `src/cloud.ts`, sync | `docs/cloud.md` |
| Publishing, public pages | `docs/cloud-publishing.md` |
| People, spaces, leases, agents, document API, a browser's sign-in and routes, `cli/` | `docs/cloud-people-agents.md` |
| Worker routes, bucket, D1, manifest format | `cloud-worker/README.md` |
| `engine/src/versions/`, history | `docs/versioning.md` |
| `pdf_export.rs` | `docs/pdf-export.md` |
| `ios/`, `scripts/ios-colors.mjs` | `docs/ios.md` |
| `.github/workflows/`, updater | `docs/release.md` |
| Building live sync (deferred, not built): the Durable Object doorbell | `docs/live-sync-plan.md` |
| Building links phase 2 (not built): backlinks, rewriting links on a move, dates and people in `@` | `docs/links-phase2-plan.md` |

Docs hold rules, shared formats and traps — nothing else. Update one when a
change alters those; never add history, "as built" notes or test walkthroughs.
The one exception is a `*-plan.md`: a design that is not built yet, read only
to build it, and deleted once it is.
