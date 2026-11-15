# Plan: devices first, then the iPhone app as a device

Throwaway working file. Not for `main`: it lives only on the iOS branch, and is deleted before that branch merges.

## Status

- **PR 1 (devices) is merged: #120.**
- **The iOS branch is rebased on `main`** (after #120 and #121).
- **PR 2, step 1 (the engine as its own crate): done.** `engine/` holds the sync engine and the version store, with no Tauri. The Mac app keeps one wrapper per command (`src-tauri/src/cloud.rs`, `versions.rs`) and its `Setup`/`Host` (`src-tauri/src/engine.rs`). Engine tests 181, Mac app tests 18, `pnpm build`, `pnpm lint`: pass on Linux. `ci.yml` has a new `engine` job.
- **Step 2 (bridge and build): mostly done.** `engine/ffi` (C interface, header in `engine/ffi/include`), `engine/src/command.rs` (every command by name), Swift `Engine` (`ios/DoklinKit/Sources/DoklinKit/Engine/Engine.swift`), `scripts/ios-engine.sh`, an Xcode build phase, `ios.yml`. Left: the Swift payload types (below).
- **Step 0 (proof): mostly done.**
  - Linux: `EngineLiveTests` (Swift linked to the engine) joins the harness worker with a device code, downloads the workspace, syncs a new note up (`drive-ios.mjs` checks it reached the domain), mints another device code, leaves and deletes the copy. Passes.
  - Mac CI runner (run 5): the engine built for `aarch64-apple-ios`; `swift test` linked to it passed. The simulator app build failed only on a missing Intel slice. Fixed by excluding `x86_64` for the simulator (Apple Silicon only, as decided). **Run 6 checks it; not yet seen.**
- **Not checked by anything yet: the Mac app itself after the engine move.** Its macOS-only lines (Trash via `trash_path_impl`, `cli_install::after_connect`) compile only on a Mac, and `ci.yml` does not build `src-tauri/`. See "On your Mac", first item.

## Decided

- The phone is a **device** of its person, like a Mac: it holds the whole workspace locally and syncs in the background. It stops being an agent.
- **"Add a device" is the only way to add a Mac or an iPhone.** Any person can add any number of their own devices.
- The phone's screens are Swift. The sync engine is the Mac's Rust engine, shared, not rewritten.
- Not on the phone: creating a workspace, updating the worker, deleting a workspace, the raw-token door, the command line tool, PDF export.
- Diagrams (mermaid, svg) on the phone come later.
- **No backward compatibility.** What is replaced is deleted, not kept beside the new thing.
- **Apple Silicon only** for the simulator; the engine is not built for Intel.

---

## How the pieces fit (for whoever picks this up)

- `engine/src/host.rs`: `Core` (one running engine), `Setup` (said once at boot), `Host` (what the engine asks of the app: emit, open folders, write a file, trash, connected).
- `engine/src/command.rs`: `call(core, name, args)`. Same names and camelCase args as the Mac frontend's `invoke`. A test fails if a `cloud_*`/`versions_*` command has no arm. Extra names for an app without Tauri: `touched`, `device_name`, `bundled_worker_version`, `versions_reconcile`, `versions_flush`.
- `engine/src/paths.rs`: with `Setup::anchor` set (the iOS container), every path written down (`cloud.json` roots, version index roots, store keys) is relative to it.
- `engine/ffi/src/lib.rs`: `doklin_engine_start(configJSON, onEvent)`, `doklin_engine_call(name, argsJSON, ctx, done)`, `doklin_engine_free`. The phone's `Host`: every connected workspace is "open"; no trash; no watcher.
- New engine command `cloud_leave(root)`: ends the sign-in and deletes the copy (Remove from this iPhone).
- Swift: `Engine.shared.start(EngineSetup(...))`, `call(name, args, as:)`, `run`, `events()`.

---

## What is left in PR 2

### Step 2, the rest

- `ios/DoklinKit/Sources/DoklinKit/Engine/Payloads.swift`: Swift `Decodable` types for `CloudStatus`, `People`, `DeviceRecord`, `AgentRecord`, `Redeemed`, `DeviceCode`, `SpaceStatus`, `VersionsStatus`, `FileHistory`, … mirroring `engine/src/cloud/status.rs` and `versions/status.rs`. `docs/cloud.md` and `status.rs` already name this file: **status.rs ⇄ src/cloud.ts ⇄ Payloads.swift, change all three.** Replace the ad-hoc structs in `EngineLiveTests.swift` with these.

### Step 3: the app on local files (the biggest piece)

- Start the engine at launch: data in `Library/Application Support/Doklin`, workspaces in `Documents/`, anchor = the container (`NSHomeDirectory()`), client `ios/<MARKETING_VERSION>`, device name = `UIDevice.current.name`.
- Sign-in: paste a line (invite or device) → `cloud_parse_invite` → `cloud_redeem` → `cloud_join` (progress from `cloud-progress`).
- Folder list, reader, editor and search read local files. Every write: write the file, then `touched` with its path.
- Sync while open; on leaving, `versions_flush` and `cloud_sync_now` inside a `beginBackgroundTask` (about 30 s). Status line from `cloud-status`; Sync now; re-read open files on `cloud-applied`; show `cloud-conflict`.
- Remove from this iPhone: `cloud_leave`. Signed out from elsewhere: `cloud-removed` → say so, back to sign-in.
- **The phone's sign-in lives in the Keychain, not in `cloud.json`** (decided). The engine asks the app for it through `Host` (a get/set/delete secret hook, keyed by workspace id); the Mac's `Host` keeps today's behaviour (the token in `cloud.json`), the phone's leaves `token` empty there and calls back into Swift over the C interface. Keychain item: `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, so sync can read it while the phone is locked, and so it is never in a backup: a phone restored from a backup has no sign-in and joins again as a new device, which is what "a sign-in belongs to one device" asks. `read_cloud_file` already drops an entry with no token; on the phone that check asks the Keychain. Testable on Linux with an in-memory store; the Keychain itself only on a Mac.
- Delete: the agent client (`Client.swift`, `API.swift`, `Models/Wire.swift`), login, the save-conflict dialog, drafts, the offline cache, `ClientTests`, `LiveTests`, the agent part of `drive-ios.mjs`. Keep the markdown parser (`Markdown/`) and its tests, and `KeychainSecretStore` (reused for the sign-in).
- `DoklinUITests`: join with a device line from `drive-ios.mjs`, browse, read, edit, tick a box, search, relaunch (still joined), Remove from this iPhone.

### Step 4: people, devices, agents, sections

- People: list; invite, remove and roles for an owner (`cloud_people`, `cloud_invite`, `cloud_revoke_person`, `cloud_set_role`, `cloud_withdraw_invite`).
- Devices: yours, Sign out, Add a device (`cloud_device_code`, `cloud_revoke_device`).
- Agents: add, permissions, login line, remove, log a machine out (`cloud_agent_*`).
- Who is here now; "someone is editing this" (view only, take over: `cloud_set_activity`, `cloud_take_over`, leases in `CloudStatus`).
- Private and restricted folders (`cloud_space_*`; confirm a move that lets more people see something).

### Step 5: comments and publishing

- Comments: a Swift port of `src/criticMarkup.ts`, `src/metaFile.ts`, `src/htmlComments.ts`, pinned by test cases both languages read (a JSON fixture file both test suites load). Change both.
- Publishing, published pages, taking a page down: `cloud_publish`, `cloud_unpublish`, `cloud_set_root`, `cloud_pages`, `cloud_page_take_down`.

### Step 6: history

Per-note versions and restore, workspace history, recently deleted: `versions_history`, `versions_read`, `versions_diff`, `versions_restore_file`, `versions_snapshots`, `versions_snapshot_diff`, `versions_restore_snapshot`, `versions_deleted`.

### Docs and wrap-up

- `docs/ios.md` rewritten (a device, not an agent; the engine library; the build phase).
- `docs/cloud-people-agents.md`: drop "the iOS app is an agent".
- `CLAUDE.md` commands (`swift test` now needs `scripts/ios-engine.sh host` and `-Xlinker -L…`; `drive-ios.mjs` does both).
- Delete this file. Open PR 2. Write the phone's migration steps.

### Later, not in PR 2

Diagrams, QR scanning for codes, iOS background transfers for a large first download.

---

## On your Mac (Apple Silicon)

1. **The Mac app after the engine move.** `cd src-tauri && cargo check && cargo test --lib`, then `pnpm tauri dev`: open a connected workspace, edit, see it sync; delete a file synced from elsewhere (goes to the Trash); open a note's history and restore a version; Cloud → Add a device. The Rust engine tests: `(cd engine && cargo test --workspace)`.
2. **The phone's toolchain.** Xcode 16+, `rustup target add aarch64-apple-ios aarch64-apple-ios-sim`.
3. **The core against the worker:** `pnpm install`, then `node verify-harness/drive-ios.mjs` (builds the engine for the Mac, runs `swift test` linked to it, checks the note reached the domain).
4. **The app in a simulator:** `node verify-harness/drive-ios.mjs --app`, or open `ios/Doklin.xcodeproj` and run (Xcode builds the engine first; the first build takes a few minutes).

## Settled

- **One PR** for everything in PR 2, the engine move included. So the Mac app after the move is checked by hand on a Mac before merging ("On your Mac", 1), since merging cuts a Mac release.
- **The phone's sign-in is in the Keychain** (step 3).

## Migration — yours, once

After PR 1 (done, if you followed it):

1. Let the Mac app update itself on every Mac.
2. On the Mac that created the workspace, update the worker (Cloud → Update the worker).
3. On that Mac, open People and make sure the creator has a name and an email.
4. On every other Mac, with its workspace folder open: Cloud → Disconnect this Mac. On the first Mac: Devices… → Add a device, copy the line. Back on the other Mac, same folder open: Cloud → Join a workspace, paste, Join, then **Resume syncing this folder**.
5. On the first Mac: Devices… → Show the domain's token, keep a copy somewhere safe.

After PR 2:

6. On a Mac, remove the agent that was made for the phone (Agents).
7. Install the new build on the phone. On a Mac choose Add a device, and paste the line on the phone.
