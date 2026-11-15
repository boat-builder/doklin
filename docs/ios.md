# iOS app

`ios/`: a native iPhone and iPad app. Xcode 16 or later, iOS 17 or later, Apple Silicon. It is a **device** of its person's, like a Mac: it holds every workspace it joined as files of its own and syncs them in the background with the Mac's own engine (`engine/`), linked in as a static library.

## Rules

- **The phone runs the engine; Swift draws the screens.** Swift calls the engine's commands by name with the Mac frontend's arguments (`Engine.shared.call`, `engine/src/command.rs`) and hears its events; nothing in Swift talks to a domain. What the engine answers is mirrored in `Payloads.swift` (⇄ `engine/src/cloud/status.rs` ⇄ `src/cloud.ts`, **change all three**).
- **A workspace is joined with a line**: `Add a device` on a Mac, or an invite (`cloud_parse_invite` → `cloud_redeem` → `cloud_join`). It is downloaded to `Documents/<name>`; *Remove from this iPhone* is `cloud_leave` (signs out, deletes the copy, nothing changes in the cloud).
- **The sign-in is in the Keychain**, by workspace id (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`): readable while the phone is locked, never in a backup. The engine asks for it through `Host::secrets` (two C callbacks); the phone's `cloud.json` holds `token: ""`. A Keychain that cannot be read just now is never taken for "no sign-in": that workspace waits, untouched (`CloudFile::unread`).
- **Nothing of a workspace is in a backup**: `Application Support/Doklin` (the engine's files, the device id) and `Documents` (the copies) are excluded. A restored phone has nothing, and joins again as a new device.
- **Nothing written here is lost quietly.** A save writes only over what the note held when it was opened (`DocumentModel.save(_:over:)`); a change sync made meanwhile is a choice for the person. *Remove from this iPhone* syncs first and asks again when something has not reached the domain. A line's code works once: a join whose download failed retries with the sign-in it bought.
- **Every write is the app's own, then `touched`.** There is no folder watcher on iOS: a file written without `Workspace.wrote` (which rings the engine's edit bus) syncs only at the next poll. `WorkspaceFiles` writes; `Workspace.wrote` tells the engine and every screen.
- **No Trash.** A deletion on the phone — by a person or by sync — is outright; the version store keeps what went (Recently deleted).
- **What a folder holds is the Mac sidebar's rule**: a document is a stem (markdown, html, or both), `<stem>.meta.jsonl` goes wherever its document goes and is never a row, hidden names are `isHiddenOrIgnored` (⇄ `is_hidden_or_ignored` in `engine/src/lib.rs` ⇄ the worker's `IGNORED_NAMES`, **change all three**).
- **Leases are honoured**: a note another device holds opens view-only, with *Take over*; the editor says what it is editing (`cloud_set_activity`), never the reader.
- **What a person may do is the worker's role table** (`CloudStatus.can`, `Workspace.may`); empty means not known yet, and the engine refuses in words.
- **Colours are generated, never typed**: `node scripts/ios-colors.mjs` writes every colour set in `Assets.xcassets` from `src/styles/tokens.css`, for the names `Theme.swift` asks for. `--check` runs in CI.
- **`DoklinKit` imports nothing Apple-only** outside `#if canImport(…)`, so its tests run on Linux. Views go in `ios/Doklin/`; logic a view needs goes in the kit.
- User-facing errors are sentences, here too: the engine's refusals already are, and are shown as they stand.

## Layout

| Where | What |
| --- | --- |
| `engine/ffi/` | The engine behind three C functions (`include/doklin_engine.h`, **change both** with `src/lib.rs`): start (setup JSON, events, the Keychain callbacks), call a command by name, free |
| `scripts/ios-engine.sh` | Builds `ios/Engine/<platform>/libdoklin_engine_ffi.a` (ignored): `host` for `swift test`, `iphonesimulator`, `iphoneos`. Xcode runs it as the app target's first build phase |
| `ios/DoklinKit/` | Swift package: `Engine/` (`Engine.swift`, `Payloads.swift`), `Models/` (`Workspaces`: the engine's model, join, leave, settle; `Workspace`; `WorkspaceFiles`; the screens' models), `Markdown/` (the reader's parser, task ticking, links) |
| `ios/Doklin/` | SwiftUI views. UIKit only in `SourceEditor.swift` and `PlatformViews.swift` |
| `ios/DoklinUITests/` | One class per journey through the real screens, each joining with a line of its own (`UITestCase.swift`); run by `drive-ios.mjs --app`, skipped without it |
| `ios/Doklin.xcodeproj` | The app and its UI tests. Both folders are synchronized: a file added there is in the build, with no project edit |
| `ios/Info.plist` | Only what build settings cannot say (plain http to a worker on this machine). The rest is `INFOPLIST_KEY_*` |

## Traps

- iOS moves the app's folder on an update: `Setup::anchor` is the container, and everything the engine writes down is relative to it (`engine/src/paths.rs`). The selected workspace is remembered by `wsId`, never by path.
- `cloud_join` answers the folder before the engine has sent that workspace's status: `Workspaces` keeps a just-joined root selected until it does.
- The app gets about thirty seconds when it leaves the screen: `settle` flushes versions and syncs every workspace inside a background task. Nothing syncs while iOS has it suspended.
- `UIDevice.current.name` is the generic model name ("iPhone") without Apple's user-assigned-name entitlement: that is what Devices lists.
- `Info.plist` must stay outside `ios/Doklin/`: inside the synchronized folder it is copied as a resource too, and the build fails on two commands producing one file.
- `"\r\n"` is one `Character` in Swift. Lines are split by `MarkdownLines.split`, and a ticked box changes one character in place, so a note's line endings survive.
- A block's `line` is a line of the file, frontmatter included: `togglingTask` takes that number as it is.
- `x-doklin-client` is `ios/<MARKETING_VERSION>`. The version is the project's, not the Mac app's: `bump` does not stamp it, and a push touching only `ios/` cuts no release.
- Diagrams (` ```mermaid `, ` ```svg `) are shown as their source: there is no renderer on the device.
- The UI tests find rows and fields by `accessibilityIdentifier` (`entry-<name>`, `line`, `join`, `edit`, `done`, `workspace-menu`, …) and buttons by their label: renaming either is a change to the tests too.
- The engine is built for Apple Silicon only. The project excludes `x86_64` from simulator builds (`EXCLUDED_ARCHS`).
- The simulator build must stay signed-to-run-locally for the UI tests: with `CODE_SIGNING_ALLOWED=NO` the app has no Keychain, and a sign-in cannot be kept.

## Building and checking

```sh
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
open ios/Doklin.xcodeproj                 # set a team under Signing, then run (the first build compiles the engine: minutes)
node verify-harness/drive-ios.mjs         # the core against the harness worker (builds the host engine, runs swift test)
node verify-harness/drive-ios.mjs --app   # the app in a simulator; DOKLIN_ONLY=<class>, DOKLIN_SIMULATOR=<udid>
node scripts/ios-colors.mjs [--check]     # colour sets from tokens.css
```

To try the app in the simulator with no domain: `node verify-harness/serve-worker.mjs --no-mermaid`, mint a device line with the owner token (`drive-ios.mjs` shows how), and paste it.
