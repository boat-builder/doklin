# iOS app

`ios/`: a native iPhone and iPad app. Xcode 16 or later, iOS 17 or later, no dependency.

## Rules

- **The app is an agent of its person's**, exactly as `doklin` is ([cloud-people-agents.md](cloud-people-agents.md), *Agents*, *Document API*): it logs in with a `doklin login <address> <code>` line from the Mac's Agents panel and speaks only `/api/agent/*`. It keeps no copy of the folder and never touches the sync routes; what it changes reaches Macs as an agent's write does.
- **A token lives in the Keychain and nowhere else** (`KeychainSecretStore`, this device only): not in `workspaces.json`, not in a cache, not in a log.
- **Nothing overwrites silently.** A save sends the revision that was read (`if-rev`); `force=1` is sent only after a person chose "Replace it with mine". A new note is `if-rev: *`.
- **Nothing of the worker's is restated.** The code is sent as typed (the worker knows what a code is), a refusal is shown in the worker's words, and which folders are sections is read from `GET me` (`Session.audience`), never from a name.
- **Colours are generated, never typed**: `node scripts/ios-colors.mjs` writes every colour set in `Assets.xcassets` from `src/styles/tokens.css`, for the names `Theme.swift` asks for. `--check` runs in CI.
- **`DoklinKit` imports nothing Apple-only** outside `#if canImport(Security)`, so its tests run on Linux. Views go in `ios/Doklin/`; logic a view needs goes in the kit, where it can be tested.
- User-facing errors are sentences, here too: a `DoklinError.message` is shown as it stands.

## Layout

| Where | What |
| --- | --- |
| `ios/DoklinKit/` | Swift package: `Client.swift` + `API.swift` (the document API), `Markdown/` (the reader's parser, task ticking, comment anchors, links), `Models/` (accounts, session, the `@Observable` model behind each screen, the caches) |
| `ios/Doklin/` | SwiftUI views. UIKit only in `SourceEditor.swift` and `PlatformViews.swift` |
| `ios/Doklin.xcodeproj` | One target. `ios/Doklin/` is a synchronized folder: a file added there is in the build, with no project edit |
| `ios/Info.plist` | Only what build settings cannot say (plain http to a worker on this machine). The rest is `INFOPLIST_KEY_*` |

## Traps

- `Info.plist` must stay outside `ios/Doklin/`: inside the synchronized folder it is copied as a resource too, and the build fails on two commands producing one file.
- `"\r\n"` is one `Character` in Swift. Lines are split by `MarkdownLines.split`, and a ticked box changes one character in place, so a note's line endings survive.
- A block's `line` is a line of the file, frontmatter included: `togglingTask` and `commentAnchor` take that number as it is.
- A comment's marker is in the text, so any comment change gives the markdown a new revision: the model reads the document again before the next save.
- `x-doklin-client` is `ios/<version>`; `host` at login is the device's name, which is what the Mac's Agents panel lists.
- The version is `MARKETING_VERSION` in the project, not the Mac app's: `bump` does not stamp it, and a push touching only `ios/` cuts no release.
- Diagrams (` ```mermaid `, ` ```svg `) are shown as their source: there is no renderer on the device.

## Building and checking

```sh
open ios/Doklin.xcodeproj                 # set a team under Signing, then run
swift test --package-path ios/DoklinKit   # the core; live tests skip without a worker
node verify-harness/drive-ios.mjs         # the core against the harness worker
node scripts/ios-colors.mjs [--check]     # colour sets from tokens.css
```

To try the app in the simulator with no domain: `node verify-harness/serve-worker.mjs --no-mermaid`, add an agent with the owner token (`drive-ios.mjs` shows how), and log in to `http://localhost:8787`.
