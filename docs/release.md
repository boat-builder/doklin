# Release

macOS, Apple Silicon, plus a temporary Intel build ([below](#intel-temporary), intel-mac). Producer: `.github/workflows/release.yml`. Consumer: `src/updater.ts` + `plugins.updater` in `src-tauri/tauri.conf.json`.

## Jobs

- `ci.yml` (PRs): `checks` (eslint, tsc, cloud worker tests + bundle, max 3 MB gzipped), `cli` (`--locked` build, `cargo test`, `verify-harness/drive-cli.mjs`), `engine` (`cargo test --workspace --locked` in `engine/`), `ios` (colour sets + `verify-harness/drive-ios.mjs`).
- `ios.yml` (push touching `ios/`): on macos-15, the iOS core's tests, a simulator build, and the app driven in a simulator (`verify-harness/drive-ios.mjs --app`). Nothing ships the iOS app: [ios.md](ios.md).
- `release.yml` (push to `main`): `bump` → `build-cli` (Linux x64/arm64 musl) → `build-release` (macos-15, publishes); beside them `build-intel` → `publish-intel` (intel-mac).

## Rules

- Every push to `main` cuts a release, except one touching only `site/` and `ios/` (`paths-ignore`); runs are serialized (`concurrency: release-main`).
- Never version by hand. `bump` patch-bumps the latest `v*` tag; for minor/major, raise `version` in `src-tauri/tauri.conf.json`. It stamps `package.json`, `tauri.conf.json`, and `Cargo.toml` + `Cargo.lock` of `src-tauri/` (crate `doklin`) and `cli/` (crate `doklin-cli`, names hard-coded). A new file carrying the version must join the stamp, or app and manifest drift and the updater misfires.
- Keep the build in `bump`'s run: its tag is pushed with `GITHUB_TOKEN`, which triggers no workflow, so an `on: push: tags` workflow never runs.
- `ci.yml` does not compile the Mac app's Rust; a `src-tauri/` break first fails the release on `main`. That includes its wrappers over the engine's commands (`src-tauri/src/cloud.rs`, `versions.rs`): after changing a command's signature in `engine/`, run `cd src-tauri && cargo check`.
- Two signing chains, never conflate them:
  - Apple Developer ID + notarization (`MACOS_*`/`APPLE_*`): Gatekeeper opens the `.app`/`.dmg`.
  - Tauri updater key (`TAURI_SIGNING_*`): installed apps accept the `.app.tar.gz`. It must pair with `plugins.updater.pubkey`; nothing checks, so a mismatch ships green and every install rejects it. Losing it strands every installed copy.
- Stage assets only in `release-assets/` (all of it is published), never `dist/` (Vite output).
- The macOS `doklin` rides inside the app (`Contents/Helpers/doklin`). Tauri signs only the app's own binary, so `build-release` signs the CLI with the Developer ID and hardened runtime first, in a keychain it deletes before Tauri imports the certificate (two keychains with one identity: codesign refuses it as ambiguous). That keychain must be on the user search list (`security list-keychains -d user -s`), as Tauri's is: `--keychain` only narrows the identity search. Its `tauri build` overrides `beforeBuildCommand` to leave out `pnpm build:cli`: cargo copies a fresh link over the signed binary even when nothing changed. The `doklin-macos-arm64` asset is the copy from inside the notarized app.
- `verify-harness/cloudprompts.test.mjs` pins `release.yml` lines (installer copy, release-notes install line, `SHA256SUMS`) and is not in CI: run it after touching asset steps.

## Updater contract

- Endpoint `https://github.com/boat-builder/doklin/releases/latest/download/latest.json`, live only because the release is `make_latest: 'true'`.
- Manifest, built with `jq` in `build-release`:
  ```json
  {"version": "X.Y.Z", "notes": "…", "pub_date": "<UTC>", "platforms": {"darwin-aarch64":
    {"signature": "<.sig contents>", "url": "…/releases/download/vX.Y.Z/Doklin.app.tar.gz"}}}
  ```
  Bare semver; `url` pinned to the tag; `.sig` inlined, not published; `notes` = Update button tooltip. A missing key for the running platform (`<os>-<arch>-app`, then `<os>-<arch>`) is an error, even with no newer version: Settings shows "Couldn't check".
- `bundle.createUpdaterArtifacts: true` emits `.app.tar.gz` + `.sig`; the build fails without `TAURI_SIGNING_PRIVATE_KEY`.
- `src-tauri/capabilities/default.json` needs `updater:default` and `process:default` (relaunch).

## Release assets

At `releases/latest/download/<name>`. A rename breaks its consumers, including deployed workers and shipped apps.

| Asset | Consumer |
| --- | --- |
| `Doklin-<version>-macos-arm64.dmg` | archival |
| `Doklin-macos-arm64.dmg` (copied after stapling) | `DOWNLOAD_URL` in `cloud-worker/src/static.ts`, `site/public/*.html` |
| `Doklin-<version>-macos-x64.dmg`, `Doklin-macos-x64.dmg`, `Doklin-x64.app.tar.gz`, `doklin-macos-x64` (intel-mac) | as their arm64 twins: archival, `site/public/index.html`, updater, `scripts/install-doklin.sh` |
| `Doklin.app.tar.gz`, `latest.json` | updater |
| `doklin-cloud-worker.js`, `doklin-cloud-web.tar.gz` (unpacks to `doklin-cloud-web/`) | `src/cloudPrompts.ts`, `scripts/doklin-cloud-update.sh` |
| `doklin-cloud-update.sh`, `install-doklin.sh` | `src/cloudPrompts.ts` |
| `doklin-linux-x64`, `doklin-linux-arm64`, `doklin-macos-arm64`, `SHA256SUMS` | `scripts/install-doklin.sh` |

## Intel (temporary)

One Intel Mac on macOS 12 runs Doklin until it is replaced; then Intel goes.

- Every piece is tagged `intel-mac`: `git grep -n intel-mac` lists them. Removing Intel is deleting each tagged piece and this section, and putting back the installer's refusal (`die "there is no doklin for Intel Macs — Apple Silicon only."` after the `uname -m` case, and its case in `cloudprompts.test.mjs`'s refusals).
- `build-intel` cross-builds the same tag for `x86_64-apple-darwin` on the arm64 `macos-15` runner (its Rosetta runs the CLI's `--version` check; `macos-15-intel` has a stapling bug), signed and notarized as `build-release` is. Its `--config` sets `minimumSystemVersion` 12.0 and the x86_64 `Contents/Helpers/doklin`; `tauri.conf.json`'s 14.0 is the Apple Silicon build's. `MACOSX_DEPLOYMENT_TARGET` 12.0 covers rustc and C; the verify step refuses any binary whose `minos` is above 12.0.
- The web engine check: on macOS 12, WKWebView is whatever engine Safari last installed. The Intel build injects `src-tauri/src/safari_check.js` into every window ahead of its page; if the engine lacks what the frontend needs (regex lookbehind, `URL.canParse`: Safari 17), it makes the page's module scripts inert and shows how to update Safari. A frontend dependency that needs a newer engine feature adds it to that test.
- No PDF export on Intel: `pdf_export` and the crates only it uses compile for `not(target_arch = "x86_64")`, and the frontend hides the button when `pdf_export_supported` says no.
- `publish-intel` runs after `build-release` has published: it attaches the Intel files, appends their `SHA256SUMS` lines and adds `darwin-x86_64` to `latest.json`, replacing both in place. It starts from `build-release`'s copies (the `release-manifests` artifact), never the release's: `--clobber` deletes before it uploads, and a lost upload must be repairable by a re-run. A failed Intel build never holds back the Apple Silicon release, but until `publish-intel` succeeds the latest release has no Intel files: `releases/latest/download/Doklin-macos-x64.dmg` (the site's Intel button) 404s and Intel installs' update check fails (Settings shows "Couldn't check"). A re-run within a day (artifact retention) is safe.
- Once Intel goes, `latest.json` has no `darwin-x86_64` and installed Intel copies say "Couldn't check" for good.

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
