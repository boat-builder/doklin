# Doklin

macOS-only (Apple Silicon) Tauri 2 markdown editor. `src/` React + Milkdown
Crepe frontend, `src-tauri/` Rust backend, `cloud-worker/` Cloudflare Worker,
`cli/` the `doklin` command.

## Commands

```sh
pnpm install && pnpm tauri dev                 # run the app
pnpm build && pnpm lint                        # typecheck + build the frontend, eslint
cd src-tauri && cargo test --lib               # Rust: engine, versions, store, tree
pnpm typecheck:worker && pnpm test:worker      # the cloud worker
(cd cli && cargo build --release)              # the CLI
```

`verify-harness/drive-*.mjs` drive real `src/` components in Chromium with
Tauri IPC stubbed: `(cd verify-harness && npm install)` once, a vite server on
`:1420` (`pnpm exec vite --port 1420 --strictPort`), then `node <driver>`.

## Rules

- Every push to `main` cuts a release.
- The frontend never `fetch`es. The cloud engine in Rust is the only code that
  holds a token or talks to a domain.
- Contracts mirrored in two places say "change both" on both sides — change both.
- A number with one source is parsed from it, never retyped.
- macOS-specific Rust is tagged `macOS-only`.
- User-facing errors are sentences.

## Docs

Read a doc only when the change is in its area.

| Area | Doc |
|---|---|
| App shell, saving, tabs, windows, editor | `docs/architecture.md` |
| `src-tauri/src/cloud/`, `src/cloud.ts`, sync | `docs/cloud.md` |
| Publishing, public pages | `docs/cloud-publishing.md` |
| People, leases, agents, document API, `cli/` | `docs/cloud-people-agents.md` |
| Worker routes, bucket, D1, manifest format | `cloud-worker/README.md` |
| `src-tauri/src/versions/`, history | `docs/versioning.md` |
| `src/store/`, boards, frontmatter | `docs/datastores.md` |
| `pdf_export.rs` | `docs/pdf-export.md` |
| `.github/workflows/`, updater | `docs/release.md` |

Docs hold rules, shared formats and traps — nothing else. Update one when a
change alters those; never add history, "as built" notes or test walkthroughs.
