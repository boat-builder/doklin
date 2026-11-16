# iPhone redesign (plan)

Not built. The screens: <https://claude.ai/artifact/1hzyyjUT36NAcg4FeQAqtv> (a design canvas; rows 1–5 below are its rows). Read this only to build it; delete it once it is built, and move whatever became a rule into [ios.md](ios.md).

## What the app is for

In order, all four close together:

1. **A link arrives.** An agent or a person made a document and mailed its doklin.cc link. The tap opens that document, nothing else.
2. **What changed.** Open the app to see what was created or edited lately, by whom.
3. **Search.** Find any note or page and see it at once.
4. **Browse.** Walk the workspace's tree to a document whose place you know.

Editing is rare here: the phone reads, agents write. When it happens it has to be quick and look like the page, never like markdown.

## The shape

- **Three tabs: Home, Browse, Search** (`TabView`, Search as `Tab(role: .search)`). One `NavigationStack` per tab. On iPad the same tabs become a sidebar (`.tabViewStyle(.sidebarAdaptable)`), with Browse's tree in it beside the document.
- **A document pushes over the tab it was opened from.** A followed link pushes over Home, whatever tab was showing, so Back always leads Home.
- **Home** is the workspace switcher (its name, top left), a few pinned documents, and *Recent changes*: every document by when it last changed, newest first, with who changed it (a person, or whose agent) and a dot when it changed since you last opened it. Filters: All, Unread, Agents, People.
- **The workspace menu goes.** Its fifteen items become a switcher sheet (workspaces, sync, who is here, People, Settings) and a Settings screen (sync and plan; people, agents, devices, here now; published pages, history, recently deleted; remove from this iPhone). Every screen behind them stays as it is.
- **Sync speaks only when it needs you.** "Synced" and "Syncing…" sit under the workspace name on Home; a hold, a confirmation, an error or a toast rises into one bar above the tabs. The words stay the Mac's.
- **Reading first, editing a tap away.** A document opens to read. *Edit* in its bottom toolbar, or a double-tap on a paragraph, makes the same page editable right there; *Done* gives it back. Boxes tick and comments work while reading, as now.

### Why read-first, not always editable

Note apps (Apple Notes, Notion, Bear, Craft) open every page editable; document apps (Google Docs, Word, Confluence, Dropbox) open to read, with a pencil. Doklin on a phone is the second kind, and here it is also the safer one:

- An always-live editor would take every reader's lease, so everyone else's copy would go view-only while someone reads on the bus.
- A tap meant for a link, a box or a comment would put the caret down and raise the keyboard.
- Agents' documents would collect stray edits.

What makes read-first feel instant is the in-place switch: no new screen, no markdown, the caret lands where you tapped.

## What changes, by area

### 1. The shell

- Deployment target 17.0 → **26.0** (`project.pbxproj`, both configurations). `Tab` and `sidebarAdaptable` need 18; the bar above the tabs is `tabViewBottomAccessory` and the floating tab bar's minimise-on-scroll is `tabBarMinimizeBehavior`, both 26. The app reaches phones only through TestFlight, so nobody is left on an older iOS. (A floor of 18 works too, with the bar drawn as a `safeAreaInset` instead.)
- `WorkspaceView` splits: the tab view, one path per tab (`[Route]` each), and the root's handling of `device.opening`, which now selects Home and pushes there.
- The bottom inset that holds the sync line, the notices and the toast for the whole stack goes (`WorkspaceView.safeAreaInset`). The trap in ios.md that follows from it ("screens put their actions at the top") goes with it: documents get a bottom toolbar (Comments, Edit, Share, More).
- `RootView` is unchanged: no workspace → sign-in; otherwise the tab view.

### 2. A link arrives (row 1)

- `Workspaces.follow` stops answering "isn't showing here yet" in an alert. It sets an *arriving* state that the document screen draws (what it knows, and that it will open by itself), and asks `cloud_follow_link` again on each `cloud-status` of that workspace for about thirty seconds. Then one sentence, and it may not tell a deleted file from a folder this person isn't in: a link is an address, never access ([cloud.md](cloud.md) *Links*).
- A link to a workspace this iPhone hasn't joined says so, with how to join.
- Cold start stays native: the reader is SwiftUI, so nothing waits for a web view before the first frame.

### 3. Recent changes (row 2) — engine

- A new command, **`files_recent {root, limit}`** → `[{path, fileId, mtime, by, rev, section}]`, newest first, across the workspace and its sections. It reads the last applied manifests the engine already keeps (`state.json`; manifest v4 has `mtime` and `by` per file), plus this device's own changes not yet synced (`by` = this member). Mirrored in `Payloads.swift` ⇄ `engine/src/cloud/status.rs` ⇄ `src/cloud.ts` (**change all three**); the Mac could show the same list.
- *Created* is `rev == 1`. Trap: a move to another section is a new file id with `rev: 1`, so it reads as created there.
- Who: `m-…` resolves through the people list. `a-…` resolves only for the person's own agents, and an owner's (`agents.manage`); to anyone else another person's agent is a `404`. "Research agent · Maya Chen's" for everybody needs **a small worker addition**: agents' names and their person, read-only, on `GET /api/meta` or the poll. Until then: "An agent of Maya Chen's" when the person is known, "An agent" when not.
- Home re-reads on `workspace.changes`.

### 4. What you've read, and what changed since (rows 1–2)

- A **seen-store** on the device: file id (path until it has one) → the hash last shown, in `Application Support/Doklin`, excluded from backup like the rest. Written when a document is shown; read for Home's dots and the *Unread* filter. Your own edits never count as unread.
- **Changed since you read it**: when the seen hash differs and the version store holds it, read that version (`versions_read`), parse both with the reader's parser, and diff the block lists in DoklinKit (block text, by sequence). Changed blocks get a bar, inserted words a tint, removals a "1 paragraph removed · Show" line, and a stepper walks them. No old version kept → just "Changed since you read it", no marks.

### 5. Search (row 3)

- Results group **Titles** first, then **In the text**, with the words in context. Scopes: All, Notes, Pages, and a folder.
- **Pages' text becomes searchable** (tags stripped). Today a page is found by its name alone, matching the Mac's `search_workspace` and the worker's search: change all three together, or keep the phone's rule the same and leave this out.
- A tap opens at the first match: `DocumentView` takes a find term; `MarkdownView` marks the runs (`Theme.mark`, the current one ringed) and scrolls to its block; a page uses `WKWebView.find`. A find bar steps through them.
- Press and hold a result: `.contextMenu(menuItems:preview:)` with the document's first screen (the native reader for a note, a small web view for a page).
- Recent searches stay on the device (`UserDefaults`).
- The walk (`WorkspaceFiles.search`) is fine at today's sizes. Past about 2,000 documents, an index replaces it; the engine has no SQLite today, so that is a new dependency (FTS5) or an index built in memory at start and kept by `touched`.

### 6. Browse (row 4)

- A `TreeModel` in DoklinKit: children listed on expand with `WorkspaceFiles.list` (the Mac sidebar's rules, unchanged), flattened into one lazy `List`. What is open is kept per workspace by `wsId`.
- Sections as the Mac names them: everyone in the workspace; restricted folders (with how many people); Private.
- The filter narrows the tree in place: matching names and their folders, opened.
- `FolderView`'s actions (rename, move, remove, restrict, share, publish) move onto the tree's rows, same models. `FolderView` stays as the screen a restricted folder's access or a "Show in Browse" can push.
- Pinned documents: device-local first (a list of file ids). Synced pins would be a per-person setting the worker doesn't have.

### 7. The editor (row 5)

**Recommendation: the Mac's own Milkdown editor in a web view, bundled with the app.**

| | Mac's Milkdown in WKWebView | Native TextKit live preview | Native block editor |
| --- | --- | --- | --- |
| Looks like the page | Yes | Markup shows beside the caret | Yes |
| Same markdown out as the Mac | Yes: same serializer | No | No |
| Comments, tables, code, frontmatter | Already handled | To build | To build |
| Mermaid and ```svg | Renders | Source only | To build |
| Work | A bundle and a bridge | Large | Largest |

The deciding row is the second: Milkdown normalises markdown when it loads a document (`src/Editor.tsx` emits a load-normalisation baseline). A different serializer on the phone would rewrite lists and emphasis its own way, and every phone edit would come back to the Mac as a diff of reformatting.

- **A bundle.** A Vite entry (`src/ios-editor/`) that mounts the editor's Crepe set-up without the Mac's chrome, built into the app's resources by an Xcode build phase as `scripts/ios-engine.sh` is. Loaded with `loadFileURL`, `nonPersistent` data store, and a content rule list that blocks every load: "the frontend never fetches" still holds.
- **A bridge** (`WKScriptMessageHandler`): native → web `load(markdown)`, `command(name)` (bold, heading 2, to-do, undo…); web → native `changed(markdown)`, `selection({marks, block})` so the bar shows what is on. Saving stays `DocumentModel.save(_:over:)`, debounced as now, with the same changed-elsewhere banner and *Keep mine* / *Reload*.
- **The bar** is native, pinned to `keyboardLayoutGuide`, not the web view's input accessory. *Aa* swaps the keyboard for the *Turn into* panel.
- **Warm and invisible.** One web view is made after the first frame and kept. *Edit* hands it the markdown and the top block in view (by block index, its line as a check) and cross-fades. Inter, Literata and Roboto Mono (OFL, in `src/assets/fonts`) are bundled into the app (`UIAppFonts`) and the native reader uses them too, so the two look the same.
- **Leases**: taken on *Edit* (`model.editing(true)`), given back on *Done* and on leaving, as now. Reading takes none.
- `SourceEditor.swift` stays behind *More → Edit as markdown* for the rare case, or goes.
- Risks to try early: ProseMirror with iOS autocorrect, dictation and IME input; the web content process's memory (tens of MB); a document of several thousand lines.

### 8. Docs and tests

- [ios.md](ios.md): layout (the tabs, the editor bundle, the fonts), the traps that move (the bottom inset, the identifiers), and that diagrams render in the editor.
- UI tests find things by `accessibilityIdentifier` and buttons by label (`workspace-menu`, `new`, `edit`, `done`, `sync-status`, `entry-<name>`): each journey in `ios/DoklinUITests/` changes with the screens.
- `drive-ios.mjs` gains the editor bundle's build.

## Order

1. **Shell, Home and links**: tabs, `files_recent`, the seen-store, Home, the arriving state, the switcher and Settings, the sync bar. Uses 1, 2 and the menus.
2. **Search**: open at the match, the press-and-hold preview, scopes.
3. **Changed since you read it.**
4. **Browse and iPad**: the tree, the filter, pins, the sidebar.
5. **The editor**: bundle, bridge, bar, fonts. Biggest, and independent of 1–4.

## Open questions

- iOS 26 as the floor, or 18 with the bar drawn by hand?
- May everyone see the names of other people's agents (the worker addition in 3)?
- Pages' text in search: on all three, or not at all?
- Pins on this iPhone only, or synced per person?
