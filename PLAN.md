# Plan: devices first, then the iPhone app as a device

Throwaway working file. Not for `main`: it lives only on the iOS branch, and is deleted before that branch merges.

## Status

- **PR 1 is open: #120**, on `claude/devices`. Worker tests (79), engine tests (193) and the two UI drives pass. The Mac app itself has not been run.
- Next: you try it and merge; then the rebase and PR 2.

## Decided

- The phone is a **device** of its person, like a Mac: it holds the whole workspace locally and syncs in the background. It stops being an agent.
- **"Add a device" is the only way to add a Mac or an iPhone.** Any person can add any number of their own devices, as they can agents. A person can have a Mac alone, an iPhone alone, or both.
- The phone's screens are Swift. The sync engine is the Mac's Rust engine, shared, not rewritten.
- Not on the phone: creating a workspace, updating the worker, deleting a workspace, the raw-token door, the command line tool, PDF export.
- Diagrams (mermaid, svg) on the phone come later.
- **No backward compatibility.** There is one user today. What is replaced is deleted, not kept beside the new thing: the copied-token way of adding a Mac, the old routes, the agent-based phone. Moving over is a one-time migration, written out as a guide when each PR is done (outline at the end).

## Two pull requests

| | Branch | Holds | Touches |
|---|---|---|---|
| PR 1 | `claude/devices`, new, from `main` | Devices | worker, Mac engine, Mac UI, docs. Nothing under `ios/`. |
| PR 2 | `claude/ecstatic-euler-m1iu2p`, rebased on `main` after PR 1 merges | iPhone app as a device | engine crate, bridge, `ios/`, docs |

---

## PR 1 — Devices

### What changes for a person

- **Add a device** makes a one-time line to paste on the other Mac or iPhone. It works once and runs out after an hour. No token is ever shown.
- Everyone sees **their own devices** and can sign one out. An owner still sees and signs out anybody's.
- A signed-out device deletes its copy the next time it reaches the domain (as today).
- The door that takes a raw token stays on the Mac for **recovery only**: a creator who has lost every device has nobody to issue them a code.

### Worker (`cloud-worker/`)

A wire change: `WORKER_VERSION` 15 → 16, new feature name `devices`.

| Route | Who | Does |
|---|---|---|
| `POST /api/auth/devices/code` (new) | any person | `{codeHash, expiresAt ≤ 24 h}` → a code for the caller's own person. Replaces their pending one. |
| `POST /api/auth/join` (unchanged) | no bearer | Redeems it, exactly as it redeems an invite. |
| `GET /api/auth/devices` | any person | The caller's own devices; an owner everyone's. The same shape as the agents list. |
| `DELETE /api/auth/devices/<id>` | its person, or an owner | Signs that device out. Never the calling one. |
| `DELETE /api/auth/session` (new) | the device itself | Ends its own sign-in. Not added to `removed_tokens`: nothing is deleted because of it. |

- `/api/auth/tokens` is renamed `/api/auth/devices`, so the wire says what the app says. The old routes are deleted, not kept.
- A device code is stored as an invite row for a person who is already here. So there is **one code grammar, one pasted line (`doklin-invite <endpoint> <code>`) and one redeem route**, and no new contract to mirror. No table changes shape.
- The domain's own secret asking for a code gets one for the creator's person; `409` when the creator has not yet said who they are.
- A sign-in belongs to one device: no person's token is ever shown, so none can be copied to a second one.
- `roles.ts`: one new action, `devices.own`, for owner and member.
- An owner sees a pending device code among pending invites and can withdraw it. Removing or demoting a person withdraws theirs, as it does invites.
- Wording: "A Mac" → "A device" in defaults and refusals.

### Mac engine (`src-tauri/src/cloud/`)

- `cloud_device_code(root)`: mints the code here, sends only its hash, answers the line once. `DEVICE_CODE_MINUTES` = 60, beside `AGENT_CODE_MINUTES`.
- `cloud_people`: a member's answer now carries their own devices.
- `cloud_token` no longer answers a member. It stays only for the creator's recovery copy of the domain's token (open point 1).
- `cloud_revoke_device`: allowed on one's own.
- `cloud_disconnect`: also ends this Mac's own sign-in, best effort.
- A worker older than this answers Add a device with the usual "update the worker" sentence. Nothing else is kept for old workers.
- Payload types in `status.rs` ⇄ `src/cloud.ts`: change both.

### Mac UI (`src/`)

- `CloudPanel`: "Connect another Mac" becomes **Add a device**: the line, Copy, "works once, for an hour". The token view goes.
- Not connected: *Join a workspace* takes an invite or a device line (the same door). The third door is relabelled as recovery with the domain's own token.
- `CloudPeople` / `PeopleDialog`: "Macs" → "devices"; a **Devices** tab beside People and Agents with your devices, Sign out and Add a device.
- Worker behind: Add a device shows the usual update card, or "ask an owner".

### Docs

`cloud-worker/README.md` (routes), `docs/cloud-people-agents.md` (devices, credentials), `docs/cloud.md` (flows).

### Checks

- `pnpm typecheck:worker && pnpm test:worker`, then again on the bundle. New cases:
  - a member makes a code, a second device joins, both are listed;
  - a member sees no one else's devices;
  - signing out another of one's devices answers it `401 removed`;
  - ending one's own sign-in answers a bare `401` after;
  - a creator with no identity is refused;
  - an owner withdraws a pending code; removal withdraws it.
- `pnpm build && pnpm lint`; `cd src-tauri && cargo test --lib`; `verify-harness/drive-cloud.mjs` updated for the panel.
- **Not checkable from here:** the Mac app itself. To try by hand: add a second Mac with a code, sign it out from the first, disconnect.

### Compatibility

None is built. The Mac app and the worker move together: after the merge the Mac app updates itself, the worker is updated from it, and the Macs are moved over once (Migration, at the end). Merging cuts a Mac release.

The creator's first Mac keeps the domain's secret. Their later devices are ordinary sign-ins with the owner role; saying who the creator is stays on the first Mac.

### Not in PR 1

Anything under `ios/`, the engine crate, QR codes.

---

## Between the two

After PR 1 merges, rebase the three iOS commits (`515c8f5`, `5da6661`, `74cbbf3`) onto `main` and force-push the branch. Expected conflicts are a few doc lines (`README.md`, `CLAUDE.md`, `cloud-worker/README.md`, `docs/cloud-people-agents.md`) and `ci.yml`. The app is still agent-based at that point and still passes its tests.

---

## PR 2 — The iPhone app as a device

### Step 0 — Proof, before anything else

The engine has never been built for iOS. Prove on the Mac CI runner that it builds for the simulator, and that the app can join the test worker with a device code and sync a folder. **If this turns out unworkable, the fallback is a Swift engine; steps 3 to 6 are the same either way.**

### Step 1 — The engine as its own crate

- Move the sync engine and the version store out of `src-tauri` into a crate with no Tauri in it. `src-tauri` keeps its commands as thin wrappers. **Mac behaviour does not change.**
- The engine's tests move with it and can then run on Linux in CI. Today no workflow runs them.
- What the phone needs from it: folder paths kept relative to the app's folder (iOS can move it between updates), plain delete instead of the Trash (the switch exists), no file watcher.

### Step 2 — The bridge and the build

- Two entry points: a command (name and JSON in, JSON out) and an event callback. The same command names and payloads the Mac frontend uses.
- Swift types mirror the payloads: `status.rs` ⇄ `src/cloud.ts` ⇄ Swift, change all three.
- A script builds the engine for device and simulator; Xcode links it; `ios.yml` runs it.

### Step 3 — The app on local files

- The workspace lives in the app's own folder. Folder list, reader, editor and search read local files; an edit is written to disk and the engine told.
- Sign-in: paste a line (invite or device) → join → download with progress.
- Sync runs while open, on opening, and when leaving (iOS allows about half a minute). Status line and Sync now.
- Remove from this iPhone: ends the sign-in and deletes the copy. Signed out from elsewhere: the copy is deleted and the app says so.
- Goes: the agent client and login, the save-conflict dialog, drafts, the offline cache, the tests against the agent API. No agent mode is kept on the phone. `drive-ios.mjs` mints device codes instead of agents.

### Step 4 — People, devices, agents, sections

- People: list; invite, remove and roles for an owner.
- Devices: yours, Sign out, Add a device.
- Agents: add, permissions, login line, remove, log a machine out.
- Who is here now; "someone is editing this" (view only, take over).
- Private and restricted folders: create, manage access, leave, delete; confirm a move that lets more people see something.

### Step 5 — Comments and publishing on local files

- Comments: a Swift port of `criticMarkup.ts`, `metaFile.ts` and `htmlComments.ts`, pinned by test cases both languages read. Change both.
- Publishing, published pages, taking a page down: through the engine's commands.

### Step 6 — History

Per-note versions and restore, workspace history, recently deleted: through the engine's version store.

### Docs

`docs/ios.md` rewritten (a device, not an agent); the "iOS app is an agent" line leaves `docs/cloud-people-agents.md`; `CLAUDE.md` commands; `docs/release.md`.

### Later, not in PR 2

Diagrams, QR scanning for codes, iOS background transfers for a large first download.

---

## Migration — yours, once

An outline. The exact steps are checked and written out as a guide when each PR is done.

After PR 1:

1. Let the Mac app update itself on every Mac.
2. On the Mac that created the workspace, update the worker (Cloud → Update the worker).
3. On that Mac, open People and make sure the creator has a name and an email. Adding a device needs it.
4. On every other Mac, with its workspace folder open: Cloud → Disconnect this Mac. On the first Mac: workspace menu → Devices… → Add a device, and copy the line. Back on the other Mac, with the same folder still open: Cloud → Join a workspace, paste, Join, then **Resume syncing this folder**. Nothing is downloaded again.
5. On the first Mac: Devices… → Show the domain's token, and keep a copy somewhere safe. It is the only way back in if every device is lost.

After PR 2:

6. On a Mac, remove the agent that was made for the phone (Agents).
7. Install the new build on the phone. On a Mac choose Add a device, and paste the line on the phone.

---

## Open, with what I will do unless told otherwise

1. **Engine crate.** First commits of PR 2. It can be split into its own PR if you want that Mac release watched before the phone depends on it.

Settled in PR 1: the domain's own token is shown only to the creator, in the Devices tab, as the way back in; a device code lasts one hour.
