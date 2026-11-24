# Links between documents, phase 2 — the plan (not built)

What comes after the links between documents that shipped in v0.1.136. Only
what is marked **decided** was agreed with the user; everything else is a
question for a design pass with the user, which comes before any building.
Delete this file once the pieces are built, and put what outlives it into the
docs the way every other rule is kept.

## What phase 1 built (v0.1.136, worker 29, D1 schema 11)

- **A link is a plain relative markdown link:** `[launch-plan](../GTM/launch-plan.md)`.
  The note's sidecar `<stem>.meta.jsonl` holds the file id of each link
  as a record: `{"t":"link","id":<destination as written>,"file":<fid>}`.
  People and agents never see a sidecar or an id.
- **The rules are in `src/docLinks.ts`:** `linkKey`, `resolveLink`, `shownWords`,
  and `linksToSave` with its rules 1–4.
  - The iPhone ports them in `ios/DoklinKit/Sources/DoklinKit/Markdown/Links.swift`,
    held to them by `verify-harness/links-fixture.json`.
  - A record whose id is gone greys the link out. It never falls back to the link's path.
- **The editor:**
  - `src/linkMark.ts`: a link's `doklin` attribute and the greying;
  - `src/mentionMenu.ts`: the `@` list of documents, with a warning before
    picking one in a narrower section (`pickNotice`).
- **Following:** a click goes there in the same tab, ⌘-click opens a new tab, and each tab has Back and Forward.
- **Ids that last:** a file keeps its id when it moves to another section, on a
  Mac and through the worker.
- **The worker:**
  - `cloud-worker/src/noteLinks.ts`: `linksIn`, the links in a note's markdown;
  - `agentLinks.ts`: agents' reads and writes;
  - `search.ts`: the D1 `links` table, filled by search's catch-up (`targetsOf`, `linkersOf`).
- **The CLI:** `doklin links <doc> [--from|--to]`.
- **On the live domain:** the `links` index is filled, and the notes synced to
  the user's Mac were given their records by a one-time migration.

**Known gaps:**
- **Version previews:** a link in one (`src/VersionPreview.tsx`) isn't followed.
- **Old apps:** a move across sections on an app older than v0.1.136 gives the
  file a new id, so new apps grey the links to it.
- **Links to a note's html version** (`framework.html` beside `framework.md`):
  - the app treats the html file as part of the note, so a save gives such a link no record;
  - the worker's `links` index counts the link anyway.

## Decisions that bind phase 2

- **Decided: `@` is only the editor's way to pick.** It is never stored in a note's
  text, so agents learn one kind of link, not two.
- **Decided: the note's text decides which links there are.** A sidecar only adds ids,
  and only Doklin writes notes.
- **Decided: writing back never reveals (rule 4).** A save never puts a Private or
  restricted document's new name or folder into notes that people outside it read.
- **Decided: Doklin sends no notifications.**
- **Decided: no legacy code.** No compatibility layers or fallback chains; the one
  exception is a commented one-time migration of stored data.
- **The worker version:** `WORKER_VERSION` moves once per release, from main's number.
- **Mirrored contracts:** a contract kept in two places (TS ⇄ Rust ⇄ Swift) says
  "change both" on each side; change all of them.

## The pieces

### 1. Backlinks in the app

The documents that link to this one, from the sections this person holds.

- **Where they come from:**
  - Macs and iPhones read their own notes and sidecars;
  - a browser asks the `links` index (`GET links`, which `doklin links --to` uses).
- **Open questions:**
  - **Where it shows:** a section at the end of the note (as Notion does), or a panel.
  - **The browser:** should it make the index catch up first? The index fills only when a search runs.
  - **Links to a note's html version:** which way should they count (see *Known gaps*)?

### 2. Rewriting links on rename and move

The device that renames or moves a file rewrites the links to it in the notes
it holds, as Obsidian's "update internal links" does. Stored text then stays
current, not just what people and agents are shown.

- **Rule 4 holds:** the rewrite never reveals a Private or restricted document's new name or folder.
- **Leases:** a note another device holds a lease on is skipped.
- **Open questions:**
  - **Agents' moves:** does the worker rewrite too when an agent moves a file (`moveAcross`)?
  - **Notes this device doesn't hold:** sections the mover isn't in keep stale text; their links still resolve by record.
  - **Cost:** one rewrite can touch many notes at once.

### 3. Dates in `@`

Asked for by the user, to match Notion.

- **What it offers:** `@today`, `@tomorrow`, `@yesterday`, a weekday (`@friday`
  means the next one) or a typed date.
- **What it writes:** the date as plain text, with no record, so `@` stays the
  editor's alone.
- **No reminders,** since Doklin sends no notifications.
- **Open question, the format:** Notion's default ("November 28, 2026") or ISO
  (`2026-11-28`), which is plainer for agents.

### 4. People in `@`

The third of Notion's three groups (documents, dates, people). This piece has no design yet.

- **What it writes into the note:**
  - **A plain name,** like a date: simple, but it doesn't follow a rename and
    can't be found as "mentions of me".
  - **Or a name plus a member id** in the sidecar, like a link (a new record type
    such as `{"t":"person",…}`). Old apps keep unknown records verbatim.
  - Either way, `@` itself is never stored.
- **What the mentioned person gets:** no notification. Most likely a mention shows in
  what's new for them:
  - `cloud_recent` (`backend.cloud.recent`);
  - the iPhone's `Models/Recent.swift`, with its read and unread marks.
- **Who can be mentioned:** the workspace's members (`/api/meta`'s people, the engine's
  `people`).
  - A note in a restricted folder could offer only that folder's members.
  - A mention of someone who can't read the note could get a warning, like `pickNotice`.
- **Agents:** what does `doklin read` show for a mention, and may an agent write one?
- **A person who leaves or is renamed:** what does their mention show?

### 5. `[[`

Opens the same list as `@`, with a "New note “…”" choice in it.

- **Open question:** where does the new note go? Its folder, or Library.

### 6. iPhone: long-press a link to preview it

A context-menu preview of the linked note.

## Order

Not settled. My suggestion: dates first (smallest), then backlinks and
rewriting, which make links more reliable. People in `@` needs the most
design.
