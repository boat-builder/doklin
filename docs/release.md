# Release

macOS, Apple Silicon only. Producer: `.github/workflows/release.yml`. Consumer: `Updater` in `src/mac/backend.ts` (its state is `src/updater.ts`) + `plugins.updater` in `src-tauri/tauri.conf.json`.

## Jobs

- `ci.yml` (PRs): `checks` (eslint, tsc, cloud worker tests + bundle, max 3 MB gzipped), `cli` (`--locked` build, `cargo test`, `verify-harness/drive-cli.mjs`), `engine` (`cargo test --workspace --locked` in `engine/`), `ios` (colour sets + `verify-harness/drive-ios.mjs`).
- `ios.yml` (push touching `ios/`): on macos-15, the iOS core's tests, a simulator build, and the app driven in a simulator (`verify-harness/drive-ios.mjs --app`). Nothing ships the iOS app: [ios.md](ios.md).
- `release.yml` (push to `main`): `bump` → `build-cli` (Linux x64/arm64 musl) → `build-release` (macos-15, publishes).
- `site.yml` (push to `main` touching `site/`): `wrangler deploy` of `site/`, the assets-only Worker `doklin-site` behind doklin.cc.

## Rules

- Every push to `main` cuts a release, except one touching only `site/` and `ios/` (`paths-ignore`); runs are serialized (`concurrency: release-main`).
- doklin.cc is what `main`'s `site/` has. A deploy by hand from a branch lasts until the next push that touches `site/`. `site.yml` needs the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` and fails without them. Nothing orders it with a release or with a domain's worker: a page that leans on a newer worker is live once merged, and that is accepted.
- Never version by hand. `bump` patch-bumps the latest `v*` tag; for minor/major, raise `version` in `src-tauri/tauri.conf.json`. It stamps `package.json`, `tauri.conf.json`, and `Cargo.toml` + `Cargo.lock` of `src-tauri/` (crate `doklin`) and `cli/` (crate `doklin-cli`, names hard-coded). A new file carrying the version must join the stamp, or app and manifest drift and the updater misfires.
- Keep the build in `bump`'s run: its tag is pushed with `GITHUB_TOKEN`, which triggers no workflow, so an `on: push: tags` workflow never runs.
- `ci.yml` does not compile the Mac app's Rust; a `src-tauri/` break first fails the release on `main`. That includes its wrappers over the engine's commands (`src-tauri/src/cloud.rs`, `versions.rs`): after changing a command's signature in `engine/`, run `cd src-tauri && cargo check`.
- Two signing chains, never conflate them:
  - Apple Developer ID + notarization (`MACOS_*`/`APPLE_*`): Gatekeeper opens the `.app`/`.dmg`.
  - Tauri updater key (`TAURI_SIGNING_*`): installed apps accept the `.app.tar.gz`. It must pair with `plugins.updater.pubkey`; nothing checks, so a mismatch ships green and every install rejects it. Losing it strands every installed copy.
- Stage assets only in `release-assets/` (all of it is published), never `dist/` (Vite output).
- The macOS `doklin` rides inside the app (`Contents/Helpers/doklin`). Tauri signs only the app's own binary, so `build-release` signs the CLI with the Developer ID and hardened runtime first, in a keychain it deletes before Tauri imports the certificate (two keychains with one identity: codesign refuses it as ambiguous). That keychain must be on the user search list (`security list-keychains -d user -s`), as Tauri's is: `--keychain` only narrows the identity search. Its `tauri build` overrides `beforeBuildCommand` to leave out `pnpm build:cli`: cargo copies a fresh link over the signed binary even when nothing changed. The `doklin-macos-arm64` asset is the copy from inside the notarized app.
- `verify-harness/cloudprompts.test.mjs` pins `release.yml` lines (installer copy, release-notes install line, `SHA256SUMS`) and is not in CI: run it after touching asset steps.

## Mandatory releases

A mandatory release turns away every Mac app and `doklin` older than it. The oldest versions a worker answers are `MINIMUM_APP` and `MINIMUM_IOS` in `cloud-worker/src/version.ts`; nothing but `bump` writes them, and they never go down.

- **Mark one:** label the PR `mandatory` before it is merged. `bump` reads the label off every commit `main` took since the last tag (`--first-parent`), and any one makes the release mandatory. Forgotten, or for a release with no PR: **Run workflow** with *mandatory* ticked, which cuts a release of `main` as it is.
- A Claude session hears about the label only when it opens a PR: `.claude/hooks/pr-mandatory.sh`, a `PostToolUse` hook on `gh pr create` (`.claude/settings.json`), which keeps it out of every other session's context. A change to what the label means changes that text too.
- **The iPhone:** **Run workflow** with *iphone* set to a build that is on TestFlight, as TestFlight shows it (`0.1.0 (57)`), or a version alone once every release has its own. It is stored as `0.1.0+57`. A build that is not out yet locks every iPhone out with nothing to update to.
- A mandatory release, or a new iPhone minimum, also moves `WORKER_VERSION` when nothing merged since the last tag did: that is how a domain is told to update its worker, and the minimum is in the worker.
- **When it bites:** a Mac as soon as the release is published (`latest.json` `minimum`, checked at launch and hourly); `doklin` and the iPhone, and a Mac too, once a domain runs the release's worker (`410` on every request, [cloud-worker/README.md](../cloud-worker/README.md)). Only builds that have this know the `410`: an older Mac or iPhone shows the worker's sentence as a sync error, an older `doklin` prints it with exit `1`.
- The Mac covers every window with *Update Doklin* (`UpdateRequired.tsx`), the iPhone every screen with *Open TestFlight* ([ios.md](ios.md)), and `doklin` exits `9` with the install line.

## Updater contract

- Endpoint `https://github.com/boat-builder/doklin/releases/latest/download/latest.json`, live only because the release is `make_latest: 'true'`.
- Manifest, built with `jq` in `build-release`:
  ```json
  {"version": "X.Y.Z", "notes": "…", "minimum": "X.Y.Z", "pub_date": "<UTC>", "platforms": {"darwin-aarch64":
    {"signature": "<.sig contents>", "url": "…/releases/download/vX.Y.Z/Doklin.app.tar.gz"}}}
  ```
  Bare semver; `url` pinned to the tag; `.sig` inlined, not published; `notes` = Update button tooltip; `minimum` = `MINIMUM_APP`, which Tauri ignores and the app reads off `rawJson`. A missing platform key means "up to date" forever, silently.
- `bundle.createUpdaterArtifacts: true` emits `.app.tar.gz` + `.sig`; the build fails without `TAURI_SIGNING_PRIVATE_KEY`.
- `src-tauri/capabilities/default.json` needs `updater:default` and `process:default` (relaunch).

## Release assets

At `releases/latest/download/<name>`. A rename breaks its consumers, including deployed workers and shipped apps.

| Asset | Consumer |
| --- | --- |
| `Doklin-<version>-macos-arm64.dmg` | archival |
| `Doklin-macos-arm64.dmg` (copied after stapling) | `DOWNLOAD_URL` in `cloud-worker/src/static.ts` |
| `Doklin.app.tar.gz`, `latest.json` | updater |
| `doklin-cloud-worker.js`, `doklin-cloud-web.tar.gz` (unpacks to `doklin-cloud-web/`) | `src/cloudPrompts.ts`, `scripts/doklin-cloud-update.sh` |
| `doklin-cloud-update.sh`, `install-doklin.sh` | `src/cloudPrompts.ts`; `install-doklin.sh` also `cloud-worker/src/clients.ts` |
| `doklin-linux-x64`, `doklin-linux-arm64`, `doklin-macos-arm64`, `SHA256SUMS` | `scripts/install-doklin.sh` |

## Secrets

| Secret | For | Scope |
| --- | --- | --- |
| `MACOS_CERTIFICATE` | Developer ID Application `.p12`, base64 | team |
| `MACOS_CERTIFICATE_PWD` | its export password | team |
| `MACOS_SIGNING_IDENTITY` | `Developer ID Application: … (TEAMID)` | team |
| `APPLE_ID` | notarization account | team |
| `APPLE_PASSWORD` | app-specific password (notarytool) | team |
| `APPLE_TEAM_ID` | team ID | team |
| `TAURI_SIGNING_PRIVATE_KEY` | updater private key | app |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | its password | app |

Team secrets are shared verbatim with other apps on the Apple account (bluesnake).

## Failure playbook

| Symptom | Fix |
| --- | --- |
| notarytool 403 "A required agreement is missing or has expired" | Account-side, blocks every team app. Owner accepts it at developer.apple.com/account, then **Re-run failed jobs** within 24 h. |
| Notarization hits the 360 min timeout | **Re-run failed jobs** within 24 h (reuses the tag). |
| Re-run needed after 24 h | `build-cli` artifacts expired (`retention-days: 1`). Re-run all jobs or merge again; that tag is skipped, `latest` stays on the previous release. |
| Green build, `stapler validate` fails | Tauri skipped notarization: it reads `APPLE_*` env names, not the `MACOS_*` secret names. |
| `build-cli` `--locked` fails | Commit `cli/Cargo.lock`; the stamp needs `version` right after `name = "doklin-cli"`. |
| Notarization rejects `Contents/Helpers/doklin` (not Developer ID signed, no hardened runtime) | The bundle carries an unsigned CLI: the signing step was skipped, or `tauri build` rebuilt it — keep its `beforeBuildCommand` override. |
| Signing the CLI: `error: The specified item could not be found in the keychain.` | Its keychain is off the user search list. A fix to `release.yml` needs a new merge: **Re-run** replays the workflow file of the failed run's commit. |
| `install-doklin.sh` checksum mismatch | A release landed mid-install: rerun. Never replace an asset by hand without regenerating `SHA256SUMS`. |
| Apps don't take a good release | Key/pubkey pair, `platforms` key, version drift. |
