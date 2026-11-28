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

- **Decided: `@` is only the editor's way to pick a document.** It is never stored in a
  note's text, so agents learn one kind of link, not two. A person's mention is
  the one `@` a note keeps (piece 4).
- **Decided: the note's text decides which links there are.** A sidecar only adds ids,
  and only Doklin writes notes.
- **Decided: writing back never reveals (rule 4).** A save never puts the new name
  or folder of a document in My files or in something shared into notes that people
  who cannot open it read.
- **Decided (2026-11-26): a mention notifies the person mentioned.** How:
  `notifications-plan.md`, which builds piece 4 with its mention notifications.
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

- **Rule 4 holds:** the rewrite never reveals the new name or folder of a document in My files or in something shared.
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
- **No reminders:** a date notifies nobody (`notifications-plan.md` has none).
- **Open question, the format:** Notion's default ("November 28, 2026") or ISO
  (`2026-11-28`), which is plainer for agents.

### 4. People in `@`

The third of Notion's three groups (documents, dates, people). Built in release 2
of `notifications-plan.md`, with the notification a mention sends. The user left
the architecture to me (2026-11-26); everything below is mine, not yet objected to.

**What a note holds:**

- **The text says `@Maya Chen`:** an `@` and the person's name as the directory has
  it. The `@` is kept so that a mention can be told from a name by anyone reading
  the text: people, agents, other editors, a search for "mentions of me".
- **The sidecar says whom it means:** `{"t":"person","id":<the words, folded>,"member":"m-…"}`,
  one record per name for the whole document, its markdown and every comment on it.
  As with a link, the text says it and the record only finds the person again after
  a rename, or when a second person takes the same name. Old apps keep unknown
  records verbatim.
- **No member id in the text,** as no file id is: people and agents never see one.
- Where a mention sits is the `@` list's own rule (`opensAt`, `mentionMenu.ts`):
  after a space or punctuation, never inside a word (an email address stays one),
  code or a link's words.

**What a save writes** (`peopleToSave`, beside `linksToSave` in `src/docLinks.ts`,
ported to `Markdown/Links.swift`, held to `links-fixture.json`, **change both**):

1. A mention picked from `@`, or pasted from another note, gets a record from the
   person it was made with.
2. A mention that has a record keeps it, written as `@` and that person's name now:
   a rename reaches the text at the next save, as a named link's words do.
3. An `@` followed by a name that exactly one person in the workspace has (any case)
   and no record gets one. That is how a hand-typed mention and an agent's become
   mentions. A name two people share, or nobody has, stays text.
4. Nothing to hide: names are in everyone's directory, so rule 4 of links has no
   counterpart.

**How it shows:**

- A pill with the person's name now. A removed person's pill is greyed (the directory
  keeps their name). A person record whose words are gone from the document is
  dropped at the save, as a link's is.
- The iPhone's reader draws the same pill; its editor is the Mac's.
- Search finds `@Maya Chen` as words; "mentions of me" is the notifications list.

**The `@` list:**

- People come above documents, as Notion has them, agents never.
- The people who can open the document come first. Anyone else is below a line,
  and picking them warns "Dave can't open this. Share it with him?" with **Share**,
  as `pickNotice` warns for documents.
- The same list opens in a comment's box; a comment keeps `@Maya Chen` in its body.
- Two people of one name in one document: the list warns, and the first keeps the
  words. Rare, and left at that.

**Agents:**

- `doklin read` shows `@Maya Chen` as stored. An agent mentions someone by writing
  `@` and their full name (rule 3); the write answers which names became mentions
  and which stayed text. `doklin help documents` says so.
- An html document's own text holds no mentions; its comments do.

### 5. `[[`

Opens the same list as `@`, with a "New note “…”" choice in it.

- **Open question:** where does the new note go? Its folder, or Library.

### 6. iPhone: long-press a link to preview it

A context-menu preview of the linked note.

## Order

Not settled. My suggestion: dates first (smallest), then backlinks and
rewriting, which make links more reliable. People in `@` needs the most
design.
