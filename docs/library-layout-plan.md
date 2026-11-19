# The Library layout — the plan (not built)

A connected workspace's folder holds its sections side by side, and every
path names its section: on disk, in the Mac app, in a browser, on the iPhone
and for agents. Designed 2026-11-19, not built. Delete this file once it is
built, and put what outlives it into the docs the way every other rule is
kept (*When it ships*).

## The layout

```
<workspace>/
  Library/                everyone in the workspace
  Private/                only you
  Restricted/<folder>/    only that folder's people
  .doklin/                the markers (hidden, as today)
```

- Today the shared section is the folder's root and the other two are folders
  in it, so anything that lands in the folder without saying where reaches
  everyone: a Finder drag, a `cp`, a local agent writing in the folder, a CLI
  path with no section. After this, nothing is shared by omission.
- **Anything else at the root is in no section**: it stays on that device and
  syncs nowhere. The app already has that place (`nowhere` in `placeOf`, a
  file directly under `Restricted/`); the root joins it.
- A local folder that is not connected is unaffected: no sections, the
  sidebar's "Files".

## Decided

- **The name is `Library`**: a fixed English word, never the workspace's
  name. The workspace's name would stutter (`~/Doklin/Acme/Acme/…`) and turn
  a workspace rename into a folder rename on every device and a new path for
  every agent. It is a section's name at the root in any case, and found
  however the disk spells it, as `Private` is (`space::top`).
- **The section's heading is "Library"** everywhere: the Mac sidebar (today
  "Workspace"), a browser (the same sidebar) and the iPhone's Browse (today
  "Everyone in <name>"). The heading is the folder, as "Private" is;
  `Library` has no row of its own.
- **Nothing that is stored or sent changes.** The bucket layout, every
  manifest (paths relative to their own section), a tombstone's `to` (a space
  id, `""` the shared section), a presence beat (section + path inside it),
  leases, page links (ids), public addresses, `MANIFEST_VERSION`, the D1
  schema. The shared section stays the bucket root; it does not become a
  `spaces/<id>`.
- **The layout is each device's own.** No single place can move a device's
  files: each device moves its own once, when it updates. The move is written
  once, in the engine crate, so the Mac and the iPhone share it. An old
  device and a moved one sync the same manifests side by side; an old one
  keeps the old layout until it updates. **No forced update**: nothing
  breaks without one, and the iPhone, built by hand, may lag.
- **`Private` and `Restricted` stay refused at the top of Library.** The
  shared manifest's rule (`RESERVED_FOLDERS`, `layout.ts` ⇄ `RESERVED_DIRS`,
  `space.rs`, **change both**) and the shared unit's skip of those names at
  its own top stay exactly as they are, now relative to `Library/`. An old
  device mounts the shared section at the root: a shared `Private/x.md`
  would land in that device's Private. On disk, `Library/Private/` and
  `Library/Restricted/` are `nowhere`. A folder called `Library` inside
  Library is fine (an existing shared `Library/…` lands at `Library/Library/…`).
- **Agent paths are literal and always start with a section.** `Library/…`,
  `Private/…`, `Restricted/<folder>/…`; a path with no section is refused
  with a sentence. "New work goes under `Private/` unless the person names a
  place" stays an instruction (`docs/cloud-people-agents.md` *Agents*): a
  path still says where a thing is, and now it always has to.
- **Hidden entries at the root stay at the root** in every move (`.doklin`,
  `.git`, `.obsidian`, anything dot-named): they belong to the folder, not
  to a section, and other tools expect them there.
- **A missing `Library/` is a missing section folder**: the shared unit's
  state is wiped and the folder comes back whole; never tombstones (the rule
  `reconcile_spaces` keeps for a space whose folder is gone). A `Library`
  renamed in Finder becomes a stray folder at the root and Library downloads
  again: nothing is deleted for anyone.
- **The move rewrites no document.** Relative links that cross sections (a
  Private note's `../Projects/plan.md`) break once; links within a section
  and page links (ids) keep working.

## The move (engine)

A one-time stored-data migration, commented as one, in the engine crate's
cloud module, for one connected root at a time.

**When.** Synchronously, for each connected root, before that root's engine
starts: in `cloud::init`, ahead of each spawn. On the Mac that is
`engine::init` in the app's `setup`, which already runs before
`read_persisted_session` restores windows. Also inside `cloud_resume` (a
disconnected folder in the old layout) and `cloud_connect` (*Connect*).

**State**, in the workspace marker `<root>/.doklin/cloud.json` (hidden, never
synced): a new `layout` field. Absent = the old layout; `"moving"`;
`"library"`.

**Steps**, each safe to repeat after a crash at any point:

1. `layout` is `"library"` → done.
2. Make `<root>/.doklin/moving-into-library/` if it is not there.
3. Write `layout: "moving"`.
4. Rename every entry at the root into that folder, except: hidden entries,
   the `Private` and `Restricted` folders (as `space::top` finds them), and
   the folder from step 2. A shared folder already called `Library` (any
   case) goes in with the rest. Ignored names (`node_modules`, `target`…) go
   too: they are the shared section's local files.
5. Rename `<root>/.doklin/moving-into-library/` to `<root>/Library`.
6. Re-key the version store (*Version history*).
7. Write `layout: "library"`.

With `layout: "moving"`, the folder from step 2 still there means step 5 has
not run: redo 4 and 5. It gone means step 5 ran: go on from 6. Step 2 runs
before step 3 so that "moving, and no folder" can only mean step 5 ran.

**Properties to keep:**

- Renames only, never copies. It is one volume, so size and mtime are kept,
  and the first survey after it finds nothing changed: `state.json` and
  `base/` hold paths relative to the unit's root (`unit.root`) and need no
  rewrite once the shared unit's root is `Library/`.
- No file id or rev changes, and nothing is sent. Every other device learns
  nothing, and an iPhone's unread dots (keyed by file id) stay as they are.

**Traps:**

- **Never while an engine or a watcher runs for that root.** With the shared
  unit still at the root, the moved files read as moves `x` → `Library/x`
  (`stage_local`, pass 3), and the manifest tells every device. Old devices
  then put the files in `<root>/Library/`, moved ones in `Library/Library/`.
  `weigh_new` does not catch it (it skips news whose hash matches a vanished
  file).
- **Never point the shared unit at `Library/` before every file is in it.** A
  partly moved tree reads as deletions: tombstones, or the mass-delete valve.
- **Never run an older build on a moved folder.** It is the first trap again,
  from the other side. Add, with this change: the engine refuses to start a
  workspace whose marker names a `layout` it does not know, with a sentence.
  That cannot protect this change (the old build has no such check), but it
  protects the next one.

**Stored paths outside the engine** are rewritten once for every root the move
ran on: each stored path under that root whose first segment is not
`Library`, `Private`, `Restricted` (any case) or hidden gets `Library/` in
front. On the Mac, src-tauri rewrites `<app_data>/session.json` (window
folders stay; tab paths move) before `read_persisted_session`. The frontends
rewrite their own stores (*Mac app*, *Browser*, *iPhone*).

## Engine

- **The shared unit**: `root` `<root>/Library`, `prefix` `Library`
  (`Engine::new`'s shared `UnitConfig`). `ws_rel` already works from the
  prefix.
- **`in_unit` for the shared unit** takes the prefix off as a space's does,
  then refuses `Private`/`Restricted` at the top of what is left (today's
  `reserved_top` check). A path outside every section is in no unit.
  `place()` loses its shared fallback, so the edit bus drops a stray's touch.
- **Names**: `LIBRARY_DIR` beside `PRIVATE_DIR` and `RESTRICTED_DIR`
  (`space.rs`), and the three as the names a section may have at the root.
  `RESERVED_DIRS` stays the shared section's own skip list. Mirrors:
  `LIBRARY_FOLDER` in the worker's `layout.ts` (`src/web` imports it), the
  Mac's `src/cloud.ts`, the iPhone's `Tree.swift`/`Workspaces.swift`
  literals: **change all four**.
- **`pass`**: a missing `Library/` is handled like a missing space folder
  (*Decided*), never skipped silently (today the shared unit is filtered out
  when `u.root.is_dir()` is false, and only `cfg.root` is checked).
- **Connect** (`cloud_connect`): bind as today, write the marker with
  `layout: "moving"`, do steps 2–7 of the move, then `seed_upload` from
  `Library/`, which keeps skipping `Private`/`Restricted` at its own top. A
  failure after the move leaves the folder in the new layout, which a retry
  takes as moved. The connect step's copy (`CloudSetup.tsx`, "this folder
  becomes what is in it") says the folder's files move into `Library/` and
  that hidden ones stay where they are.
- **Join** (`cloud_join`): `seed_download` writes into `<dest>/Library/`,
  made even when the shared manifest is empty; the marker is written with
  `layout: "library"`.
- **Resume** (`cloud_resume`): run the move first when the marker has no
  `layout`.
- **`make_space`** takes a folder inside Library or Private, never `Library`
  itself or a stray at the root.
- **Publishing the whole shared section** is publishing `Library/`: within
  the section it is still `""` (the manifest is unchanged); `PublicPage.path`
  and every other workspace-relative path for it is `Library`. `describe`
  calls it Library, not "the workspace". `set_cloud_horizon` with the
  workspace root maps to Library.
- **Status and events** carry workspace-relative paths, which now begin with
  `Library/` for shared files (it follows from `ws_rel`). `folders_of`
  (pending adds) groups two levels below the section's folder, not below the
  root.
- **Code comments that state the old layout**: `space.rs` header, `unit.rs`
  (`UnitConfig.prefix`), `engine.rs` (`PublishRequest.rel`, state dirs),
  `status.rs` (`PublicPage.path`), `scan.rs`, `versions/mod.rs`
  (`open_roots`), `cloud/mod.rs` (`section_roots`).

## Version history

- Stores live in `<app_data>/versions/<key>/`, the key a hash of the store
  root's path (`store_for_root`). Today the shared section's history is the
  workspace root's store, and its snapshot paths are already relative to the
  shared section, because `shared_skip` leaves `Private/` and `Restricted/`
  out.
- **Re-key it, don't rewrite it.** Step 6 renames the root's store to
  `Library`'s key and sets its `Index.root`. Every snapshot path is then right
  as it is. Snapshots mirrored to the bucket's `versions/` (any device, old
  or moved) are relative to the shared section too, so the history walk
  (`file_versions`, cloud snapshots included) stays one history.
- **A connected root has no store of its own.** Library is a section root
  like the others (`section_roots`, `open_roots`), so its versioner captures
  `Library/` and the unit's mirror (`store_for_root(unit.root)`) reads that
  same store. Strays get no history, as a file directly under `Restricted/`
  gets none today. Library's store skips `Private`/`Restricted` at its own
  top (`shared_skip` keys on the marker at the root today, which `Library/`
  does not carry).
- `delete_copy`, `forget_root` and `stores::forget` cover Library's store
  where they cover the root's today.
- **Restores land in the store's root**, which for the shared section is now
  `Library/`. The Mac's `restoreTarget(root, rel)` and the iPhone's Recently
  deleted are given the store's root, not the workspace's.

## Mac app (`src/`, src-tauri)

- **`placeOf`** (`src/cloud.ts`): `Library/…` is shared; `Private/…` and
  `Restricted/<folder>/…` as today; everything else, the root itself
  included, is `nowhere`. `RESERVED_TOP` becomes the three section names.
  `widerAudience` is unchanged ("Everyone in <name>" is about people).
- **Sidebar** (`Sidebar.tsx`):
  - `layout.shared` is the children of Library's folder (`libraryDir`, found
    as `privateDir` is), not "every root child that is not Private or
    Restricted". `SectionId` `"workspace"` becomes `"library"`, and the
    shared section's `data-section-dir` is `libraryDir`.
  - **Strays** (non-hidden root entries other than the three) show in a
    group after the sections, only when there are any, each row `loose` with
    "In no section, so it stays on this Mac — move it into Library or
    Private". Directly under `Restricted/` keeps its own line. *Open
    questions*.
  - **New things land in Library**: every default that resolves to `root`
    today resolves to `libraryDir`. That covers `createDirFor` (nothing
    selected, or the root target); `startCreate`'s redirect away from
    `restrictedDir`; the header "+" and "New folder"; right-click on empty
    sidebar space (New File, New Folder, Paste); the inline create row;
    `saveUntitled`'s fallback folder; ⌘V with nothing selected (App.tsx).
    The Private heading's "+" stays.
  - **The root is never a target**: no drop on it (`canDrop`, the empty-space
    drop target), no paste into it. Only Finder or an agent makes strays.
  - Root-target menu items move to the Library heading: "Publish Library…"
    (today "Publish the whole workspace…"), "Library history…" (today
    "Workspace history…"), "Recently deleted".
  - "Copy link" and "Restrict access…" are not offered on strays (`placeOf`
    already gates them).
- **Moves** (`confirmMove`, App.tsx): the title says "Move … to Library?"
  (today "the workspace"). A move into `nowhere` (a stray, or Library's
  `Private`/`Restricted`) takes it off everyone else's devices and is
  confirmed, like a move under `Restricted/` today.
- **Copy** that names the shared section: `PublishFolder.tsx` ("The whole
  workspace — N notes…"; its count, which today walks Private and Restricted
  too, covers Library only); `PublishedPages.tsx` ("the whole workspace";
  "Use as home page" stays shared-only); `CloudAgents.tsx` INTRO ("the
  shared workspace" → Library); `CloudPanel.tsx` (the workspace blurb);
  `RestrictedFolder.tsx` ("stay in the workspace's history" → Library's);
  `WorkspaceHistory.tsx` ("Workspace history · <name>"); the heading's
  "Show/Hide" tooltip follows the label.
- **The Live chip** shows only for a file in a section.
- **Agent prompt**: `buildAgentLoginPrompt` (`src/cloudPrompts.ts`) ⇄ the
  iPhone's `AgentPrompt.login` (**change both**): Private for new work,
  `Library/` for what everyone sees, every path starting with its section.
  `verify-harness/cloudprompts.test.mjs` asserts the sentence.
- **Stored state**, rewritten once (the move's rule): `doklin:session` tab
  paths (localStorage, keyed by root) and `doklin:sidebar-tree` (`open`
  folder paths; `folded` `"workspace"` → `"library"`). Record which roots are
  done so it runs once per root.
- src-tauri's tree walk and search know nothing of sections and stay so; a
  stray is listed like any file. External opens (`external_open.rs`) are
  unchanged: a path inside a connected root still goes to its window.

## Browser (`src/web/`)

- Ships with the worker (`doklin-cloud-web.tar.gz`), so it moves when the
  worker updates, whatever version each device is on.
- `workspace.ts`: the shared section's `mount` is `Library` (today `""`), so
  every UI path is `/<Name>/Library/…`. Its `placeOf` loses the shared
  fallback: a path not under a mount is in no section. The shared manifest
  still drops reserved-top paths.
- The wire is unchanged: `/api/web/*` takes a section id and a path inside
  the section; links carry ids. No route carries a document path.
- **Stored state**, rewritten once on load, the move's rule applied to the
  path after `/<Name>/`: drafts (`doklin:web:draft:<ws>:<person>:<tab>:<path>`
  — unsent work, never dropped), `doklin:session`, `doklin:sidebar-tree`.
- The sidebar is the Mac's code, so *Mac app* covers its headings, defaults
  and drops.

## iPhone (`ios/`)

- Same engine, so the same move, at `Engine.start`, before any screen.
  Workspaces stay at `Documents/<name>`.
- **`Audience.of`** (`Workspaces.swift`, the iPhone's `placeOf`): `library/…`
  is `.everyone`; the root and anything outside the three sections is
  `.nowhere`. **`Sections.wider`** and **`Sections.moveTitle`** ("Move … to
  Library?") follow; they mirror `widerAudience` (**change both**).
- **`TreeModel.load`** (`Tree.swift`): the shared group is Library's
  children (`.workspace` becomes `.library`); strays get a group of their own
  with the `icloud.slash` line (*Open questions*). The tree-open UserDefaults
  (`tree-open-<wsId>`) are rewritten once by the move's rule.
- **`FolderModel.isManaged`** covers `library`, so Library cannot be
  renamed, moved, removed or restricted (`EntryActions`, `restrictable`).
- **New things land in Library**: Browse's New note and New folder
  (`BrowseView`), the root `FolderView`, and `MoveSheet`'s top choice all
  target `Library`, not `""`. `whoSeesNew` reads from the target.
- **Copy**: the Browse header "Everyone in <name>" becomes "Library";
  `PublishView` / `WorkspaceSettings` ("Publish the workspace", "The whole
  workspace — N notes") publish and name Library, counting only its notes;
  `Publishing.name`/`detail`; `LimitWords.adds` (folder `""` → `Library`);
  Recently deleted and History (`storeName`, "Workspace history") name
  Library; `AgentsView` intro; the restricted hints that say "the
  workspace's history".
- **History**: `stores(of:)` is Library's store plus the section stores, not
  the workspace root's.
- **Search** covers the three sections, not the root's strays.
- **Seen** (`seen.json`): its `path:` keys (files with no id yet) are
  rewritten once by the move's rule.

## Worker: the document API (agents)

- **`agentPlace.ts`**: `LIBRARY_FOLDER`; the shared section is
  `{ kind: "shared", mount: "Library" }` (today `""`). `at()`: `Library` →
  shared, `Private` → theirs, `Restricted/<f>` → that folder, `""` → the
  workspace itself (listings only). **Anything else is refused** (400):
  "Projects/plan is in no section. Say which: Library/Projects/plan
  (everyone), Private/Projects/plan (only your person) or
  Restricted/<folder>/Projects/plan." Rewrite the file's header comment.
- **`getTree`** at the top lists only the sections the person has (Library,
  Private, Restricted), never shared files; `--deep` covers every section,
  Library included (the shared section stops being the special one there).
- **`me`** lists Library among `sections` (today it filters out
  `mount === ""`).
- **`postMove`**: Library is a section like the others: `Library` itself is
  not moved, and `doklin mv x Library/` means "into it". The
  `mount !== ""` guards go.
- **`find`, search, pages**: they already speak mounted paths, so they answer
  `Library/…`. Publishing `Library/` publishes the whole shared section.
- **`mount.ts`**: its comment ("the shared workspace is mounted at `""`")
  changes; the browser's calls still mount at `""` (`webCall.ts`).
- `cloud-worker/README.md` *Document API* and `test/run.mjs` (the agent
  tests' shared paths get `Library/`; bare paths get refused).
- **One `WORKER_VERSION` bump**, from what main has.

## CLI (`cli/`)

- **Help** (`help.rs`): the sections table (`Library/…` everyone,
  `Private/…` only your person, `Restricted/<folder>/…` that folder's people,
  a path with no section is refused); every example path
  (`Projects/plan` → `Library/Projects/plan`, `mv Private/drafts/summary
  Library/`); SECTIONS; the agent brief. Also `main.rs` (`mv`'s about),
  `commands.rs` (the login message, `whoami`'s sections) and the `link.rs`
  test path.
- **Never against an older worker.** Against a worker from before this
  change, `Library/plan` would make a shared folder called `Library`, which
  every moved device shows as `Library/Library/plan`. Login already answers
  the worker's `version` (`about`): keep it in `credentials.json` per
  workspace. While it is below the Library version, a command that takes a
  path asks `me` first, keeps the version it answers, and exits 7 with a
  sentence while it is still older. Once it is new enough, that check is
  never made again: a worker does not go back.
- `verify-harness/drive-cli.mjs` (root folders, `mv … Private/`, "It sees
  the shared workspace").

## Elsewhere

- **doklin.cc** (`site/public/index.html`): the "Shared, Private,
  Restricted" passage, "Open a folder of markdown… and it becomes your
  workspace", the CLI sample (`doklin read GTM/launch-plan`), "The shared
  workspace runs on your own Cloudflare account". Rewrite those as whole
  sentences for the new story; don't insert "Library" into the ones that are
  there.
- **verify-harness**: the stub engine `cloud.html` (shared files at
  `/docs/…`, sections as root siblings, `?sections`) and every driver that
  leans on it: `drive-sections` (headings "Workspace|Restricted|Private",
  `section-workspace`, the stored tree JSON, "Move “budget” to the
  workspace?"), `drive-cloud` (status paths at the root, the prompt
  sentence), `drive-versions` ("Workspace history…"), `drive-limits`
  (`{path: ""}`), `drive-web` (`/Notes/Home.md`, draft keys). `drive-ios`
  and `cloud-worker/test/seed.mjs` check the shared manifest, which does
  not change.
- **iPhone tests**: the UI tests expect seed rows at the top of Browse
  (`entry-Home`, `entry-Projects`, `entry-Scratch`, `entry-Comments`) and
  make a note at `""`; `EngineLiveTests`, `RedesignTests` (`TreeTests`),
  `FilesTests`, `PeopleTests`, `HistoryTests`, `PublishingTests`,
  `LimitsTests` use root-level shared paths.

## Tests to add

- **Engine** (`cloud/tests.rs`; the `Device` helper roots everything at the
  workspace folder and writes no marker, so it needs a moved variant):
  - the move from each crash point (after 2, 3, mid-4, 5, 6) ends in the same
    folder with nothing sent;
  - a folder holding `Library/` (any case), `.git/`, `Private/` and strays
    moves as *The move* says;
  - an old-layout device and a moved device on one in-memory worker: edits
    both ways, moves between sections both ways, a publish, a lease, a
    conflict copy, a deletion, `Library/Private/x.md` staying unsynced;
  - join lands in `Library/`, even for an empty workspace;
  - a stray is never uploaded and its touch is dropped;
  - a missing or renamed `Library/` comes back whole with no tombstone;
  - the mass-delete valve does not fire on the first pass after the move;
  - a file's history reads the same before and after the re-key, cloud
    snapshots included;
  - a marker with an unknown `layout` refuses to start.
- **Worker**: bare paths refused; `Library/` mapped; the top listing; `me`;
  `mv` into and out of Library; `find` answering `Library/…`.
- **CLI**: the worker-version check (old worker → exit 7 with no write; new
  worker → asked once, then never again).
- **Frontends**: the stored-state rewrites (a browser draft survives), new
  notes land in Library, strays read `nowhere`.

## Release

- One release. **The worker first**, through its update badge: the app's
  build bumps `WORKER_VERSION`, so a new app waits in `worker-outdated` until
  the domain has it, and the browser and agent paths ride the worker. An old
  app syncs with the new worker unchanged.
- Then the Mac (the updater; the CLI comes with the app), then the iPhone
  (built from Xcode). Nothing to hand-run in the bucket or D1.

## When it ships

- Rules into the docs:
  - `docs/cloud.md` *Sections* (on disk, the move, `layout`, strays) and
    *Sections in the app*;
  - `docs/cloud-people-agents.md` *Agents* and *Document API*;
  - `docs/architecture.md` (the browser's paths);
  - `docs/versioning.md` (Library's store; a connected root has none);
  - `docs/ios.md` (Browse's sections);
  - `cloud-worker/README.md`.
- Delete this file and its row in CLAUDE.md.

## Open questions

Calls the person has not made yet. Each has a default above; confirm before
building.

1. **Strays in the UI**: a group after the sections, shown only when there is
   something in it (the default), or hidden. Hiding risks losing what an
   agent or Finder put at the root.
2. **Relative links across sections**: left broken by the move (the
   default), or rewritten. Rewriting edits documents, and every rewritten
   shared file then syncs to everyone as an edit.
3. **`Private`/`Restricted` inside Library**: refused for good (the default),
   or allowed in a later change once no device runs the old layout.
