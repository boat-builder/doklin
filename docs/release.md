# Release

macOS, Apple Silicon only. Producer: `.github/workflows/release.yml`. Consumer: `src/updater.ts` + `plugins.updater` in `src-tauri/tauri.conf.json`.

## Jobs

- `ci.yml` (PRs): `checks` (eslint, tsc, cloud worker tests + bundle, max 3 MB gzipped), `cli` (`--locked` build + `verify-harness/drive-cli.mjs`).
- `release.yml` (push to `main`): `bump` → `build-cli` (Linux x64/arm64 musl) → `build-release` (macos-15, publishes).

## Rules

- Every push to `main` cuts a release, except one touching only `site/` (`paths-ignore`); runs are serialized (`concurrency: release-main`).
- Never version by hand. `bump` patch-bumps the latest `v*` tag; for minor/major, raise `version` in `src-tauri/tauri.conf.json`. It stamps `package.json`, `tauri.conf.json`, and `Cargo.toml` + `Cargo.lock` of `src-tauri/` (crate `doklin`) and `cli/` (crate `doklin-cli`, names hard-coded). A new file carrying the version must join the stamp, or app and manifest drift and the updater misfires.
- Keep the build in `bump`'s run: its tag is pushed with `GITHUB_TOKEN`, which triggers no workflow, so an `on: push: tags` workflow never runs.
- `ci.yml` does not compile the app's Rust; a `src-tauri/` break first fails the release on `main`.
- Two signing chains, never conflate them:
  - Apple Developer ID + notarization (`MACOS_*`/`APPLE_*`): Gatekeeper opens the `.app`/`.dmg`.
  - Tauri updater key (`TAURI_SIGNING_*`): installed apps accept the `.app.tar.gz`. It must pair with `plugins.updater.pubkey`; nothing checks, so a mismatch ships green and every install rejects it. Losing it strands every installed copy.
- Stage assets only in `release-assets/` (all of it is published), never `dist/` (Vite output).
- The macOS `doklin` binary is ad-hoc signed, not notarized, by design.
- `verify-harness/cloudprompts.test.mjs` pins `release.yml` lines (installer copy, release-notes install line, `SHA256SUMS`) and is not in CI: run it after touching asset steps.

## Updater contract

- Endpoint `https://github.com/boat-builder/doklin/releases/latest/download/latest.json`, live only because the release is `make_latest: 'true'`.
- Manifest, built with `jq` in `build-release`:
  ```json
  {"version": "X.Y.Z", "notes": "…", "pub_date": "<UTC>", "platforms": {"darwin-aarch64":
    {"signature": "<.sig contents>", "url": "…/releases/download/vX.Y.Z/Doklin.app.tar.gz"}}}
  ```
  Bare semver; `url` pinned to the tag; `.sig` inlined, not published; `notes` = Update button tooltip. A missing platform key means "up to date" forever, silently.
- `bundle.createUpdaterArtifacts: true` emits `.app.tar.gz` + `.sig`; the build fails without `TAURI_SIGNING_PRIVATE_KEY`.
- `src-tauri/capabilities/default.json` needs `updater:default` and `process:default` (relaunch).

## Release assets

At `releases/latest/download/<name>`. A rename breaks its consumers, including deployed workers and shipped apps.

| Asset | Consumer |
| --- | --- |
| `Doklin-<version>-macos-arm64.dmg` | archival |
| `Doklin-macos-arm64.dmg` (copied after stapling) | `DOWNLOAD_URL` in `cloud-worker/src/static.ts` |
| `Doklin.app.tar.gz`, `latest.json` | updater |
| `doklin-cloud-worker.js` | `src/cloudPrompts.ts`, `scripts/doklin-cloud-update.sh` |
| `doklin-cloud-update.sh`, `install-doklin.sh` | `src/cloudPrompts.ts` |
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
| `install-doklin.sh` checksum mismatch | A release landed mid-install: rerun. Never replace an asset by hand without regenerating `SHA256SUMS`. |
| Apps don't take a good release | Key/pubkey pair, `platforms` key, version drift. |
