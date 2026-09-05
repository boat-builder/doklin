# Versioning — the acceptance pass

The manual pass to run **through the app**, by hand, once the phases of
[versioning-plan.md](versioning-plan.md) are in. Each phase has its own
*Done when* gate in that document, which is the merge condition for that
phase; this is the different question asked at the end: *does the promise
hold*. A user should be able to say "the data I put into this thing is not
lost" and be right, and nothing here is proven by a unit test alone.

Not exhaustive. It covers every surface the plan builds, the handful of
crossings between them that no single phase owns, and the promises §5 of
[versioning.md](versioning.md) makes. Run a section as soon as the phase
that builds it lands, and the whole list before calling versioning done.

## How to run it

You need:

- a build of the app from the branch (`pnpm tauri dev`, or an installed
  build for the quit and relaunch checks — `./scripts/install.sh`);
- **Fresh** — a folder of a few dozen notes that Doklin has never opened;
- **Connected** — a workspace connected to a cloud domain;
- **Other Mac** — a second Mac holding the same workspace, for §8;
- the drafts folder, which every install has.

`scripts/versions.sh -w <folder>` prints what a store actually holds. Use it
when a surface says something you doubt: it is the store's own account, and
the two disagreeing is itself a finding.

A `[ ]` is a thing to do and a thing to expect. A finding is anything the
app does that the line does not say it does.

---

## 1. History accrues on its own

The cadence, seen from the outside (phases 1–2).

- [ ] Open **Fresh**. Its history exists immediately, with one entry from
      before you touched anything ("first seen").
- [ ] Type in a note for a minute, stop, wait. A new version appears about
      two minutes after the last keystroke, and **not before**.
- [ ] Keep editing for a quarter of an hour without pausing. Versions appear
      about ten minutes apart, never faster, however hard you type.
- [ ] Leave the app open and untouched for an hour. No new versions.
- [ ] Edit a note in another editor (TextEdit, `vim`, a `sed -i`). Doklin
      notices, and the version appears on the same schedule.
- [ ] Type into a note and quit with ⌘Q immediately. Reopen: the version
      from the moment of the quit is there, with what you typed.
- [ ] Repeat with the Dock icon's *Quit*, which is a different path through
      the app and the one most likely to be missed.
- [ ] Type into a note and close its window (⌘⇧W) without quitting. Same.
- [ ] Force-quit the app mid-edit (Activity Monitor). At most the last few
      minutes of typing are missing; every earlier version is intact and the
      store opens without complaint.

## 2. The rail says something true

Phase 2's history rail.

- [ ] Open a note's history from the sidebar's file menu, the tab's menu,
      the drafts panel and `⌘⌥H`. All four reach the same rail.
- [ ] The rail groups by day, shows a time and a device name per row, and
      says how far back history reaches. Today and yesterday are open; an
      older day is one row that expands.
- [ ] A note you have not touched in a week shows its newest version dated
      **a week ago**, not today — the list is of changes, not of captures.
- [ ] A brand-new file with no history yet says so plainly instead of
      showing an empty box or an error.
- [ ] A note in a folder that was **never connected to any cloud** has a
      full history. Nothing about versions is behind the Cloud panel.
- [ ] *Name this version* on an unchanged document names the version that is
      already there rather than adding a duplicate.
- [ ] *Name this version* after an edit adds one, with the name in the row.
- [ ] A named version is still there after a month of use (it is pinned, so
      the thinning never takes it).

## 3. Looking at an old version

- [ ] Select a version. The document area shows it in place, read-only,
      under a banner saying which version it is.
- [ ] Try to type in it. Nothing happens. Nothing is saved.
- [ ] *Back to now*, `Esc` and closing the rail each return to the live
      document with the caret and scroll position intact.
- [ ] Select a version while the live document has unsaved keystrokes. What
      you typed is in the newest version, not lost, and the preview is the
      old text.
- [ ] *Show changes* renders the difference between the version and the one
      that came **after** it — for the newest version, the document as it
      stands now. That is the answer to "what would restoring this undo?".
- [ ] *Show changes* is absent on a revision only the cloud has: its bytes
      are not in the local store, so there is nothing here to compare.
- [ ] The same document open in two windows: previewing in one leaves the
      other alone.
- [ ] A version of a note that is currently open in the split view's mirror
      pane previews without disturbing the mirror.

## 4. Restore, undo, and the copy

The heart of it, and the part with the most ways to go wrong (phase 2, and
[versioning.md](versioning.md) §5 rule 3).

- [ ] Restore an old version of an open note. The document reloads with the
      old text, the tab is not left stale, and the sidebar is current.
- [ ] The rail now shows **two** new entries: the state you left, and the
      state the restore made, the latter saying where it came from.
- [ ] The toast's *Undo* puts the document back exactly as it was before the
      restore, and that undo appears in the timeline as another entry. The
      history is a sequence of states, never a branch.
- [ ] Restore, then edit, then restore something older, then undo. The
      timeline reads as a story, and nothing you typed at any point is gone
      from it.
- [ ] Restore a version, then look at the history of the *version you
      restored from*. It is untouched.
- [ ] Type into a note and restore an old version **without pausing first**.
      What you typed is in the "before a restore" entry. This is the one
      that silently loses work if it is wrong.
- [ ] *Make a copy* creates a second file named for the version's date,
      opens it, and leaves the original and its history alone. The copy
      starts a history of its own.
- [ ] Restore while offline, in a connected workspace. It works; the change
      reaches the cloud when the network comes back.
- [ ] Restore on **Other Mac** a version that was made here. Both Macs agree
      afterwards, and neither produces a conflict copy.
- [ ] ⌘Z after a restore does not silently undo half of it. (The plan does
      not promise ⌘Z here; the toast and the timeline are the undo. If ⌘Z
      does something surprising, that is a finding.)

## 5. Drafts, renames and moves

Where a history has to follow a document, or admit it cannot.

- [ ] A draft has a history, from the drafts panel's row menu.
- [ ] Rename a note in the sidebar. Its history continues across the rename
      rather than starting over.
- [ ] Move a note into another folder of the same workspace. Same.
- [ ] Promote a draft to a real file (⌘S). Decide and write down what
      *should* happen to the draft's history — the plan does not say, and
      the two stores are separate. A user who typed for an hour in a draft
      will expect that hour to survive the save.
- [ ] Move a note from one workspace to another. Its history does not
      follow, and nothing pretends otherwise.
- [ ] Delete a note, then create a new one at the same path. The new note's
      history does not start with the old note's content.

## 6. Deleted files come back

Phase 4. `drive-versions.mjs` walks the surface itself in Chromium — the
dimmed row appearing with its count, the column's old folder and last-seen
line, *Open* reading the last content, and *Restore* landing at the old path
and beside it when that path is taken. What only a Mac can answer is below:
the real Trash, a real second Mac, and a folder deleted whole.

- [ ] Delete a note. *Recently deleted* appears at the foot of the sidebar
      with the right count.
- [ ] It lists the note, its old folder and when it was last seen.
- [ ] *Open* shows the last content, read-only.
- [ ] *Restore* puts it back where it was, with its history.
- [ ] Restore onto a path something else now occupies. Both survive.
- [ ] Delete a whole folder of notes. Every one of them is listed and can
      come back.
- [ ] Empty the macOS Trash after deleting, then restore. It still works —
      the store is not the Trash.
- [ ] Delete a note on **Other Mac** and let it sync here. It is recoverable
      on **both**.

## 7. The workspace as it was

Phase 4's timeline. `drive-versions.mjs` proves the shape — the day groups
with each moment's delta, the three lists, the inline confirm's counts, a
partial restore touching only what was ticked, and *Restore all* with its
Undo — against a scripted store. What is below is the same walk against a
real folder, where the Trash and the file sizes are real.

- [ ] Open *Workspace history…* from the sidebar root. The timeline lists
      snapshots by day, each with what changed in it.
- [ ] Select one: it shows what restoring would change, add and remove,
      before anything happens.
- [ ] *Restore selected* with two files ticked touches those two and nothing
      else.
- [ ] *Restore all* asks for confirmation with the real counts, in the app's
      own confirm — never a system dialog.
- [ ] Afterwards, a single undo puts the whole workspace back.
- [ ] Restore a snapshot from before a file existed. That file goes to the
      Trash rather than being deleted outright.
- [ ] Do all of this in a workspace with a couple of thousand files and
      watch that the app stays usable.

## 8. Two Macs and the cloud

Phase 3.

- [ ] Connect **Fresh** to a domain. Its existing local history stays and
      begins mirroring: `versions/` in the bucket fills within the hour, and
      nothing in `<app_data>/versions/<key>/` changes because of it.
- [ ] The Cloud panel's *Version history* line says how many snapshots the
      domain holds and how many of them came from this Mac.
- [ ] A version made here appears in the rail on **Other Mac** — under the
      name of the Mac that made it and the reason it was captured, not as
      an anonymous "from the cloud" row.
- [ ] *Show changes* works on that version: a mirrored version is read and
      compared exactly like a local one.
- [ ] A version older than the local horizon is still readable on either
      Mac, and the trust line counts it under "in the cloud".
- [ ] Restore, on **Other Mac**, a version whose content only exists in the
      cloud.
- [ ] Leave both Macs running for a day. The cloud store thins on the same
      ladder the local one does, and what it thinned does **not** reappear
      on the next hour's mirror — the bucket's snapshot count settles
      instead of sawing up and down.
- [ ] Point the app at a domain whose worker has **not** been updated. Sync
      keeps working, local history keeps working, the Cloud panel says the
      worker is too old to keep version history, and the badge asks for the
      update instead of an error.
- [ ] Update the worker. The mirror starts on its own, without a restart.
- [ ] Edit the same note on both Macs at once and let them fight it out. The
      conflict copy behaves as it always did, and both sides' work is in the
      history.
- [ ] Disconnect the workspace. The local history is untouched.
- [ ] Wipe the domain from the danger zone. The local history is *still*
      untouched — this is the one that would be unforgivable.

## 9. Settings, sizes and the export

Phase 5. `drive-versions.mjs` proves the surface against a scripted store —
the gear's entry, a horizon per folder (with `forever` as a real answer),
the export's picker and its report, every store listed with its size, and
*Forget* confirming in the app's own chrome. What is below is the same walk
where the disk, the archive and the Finder are real.

- [ ] The gear's *Versions · Version history…* opens the settings, and so
      does *Version settings…* in the Cloud panel's *This Mac*.
- [ ] It shows this folder's horizon and what its store costs on disk, and
      the bucket's horizon when the workspace is connected.
- [ ] Shorten the local horizon. Versions past it go, the named ones stay,
      and the size reported drops to match.
- [ ] Set the horizon to forever. Nothing is dropped from then on.
- [ ] Move a versioned folder somewhere else in Finder and reopen it. The
      old store is listed under *Other folders* and can be forgotten.
- [ ] *Forget* a store. Its space comes back, and no other store is touched.
- [ ] Two folders, two different horizons. Each keeps its own answer across
      a restart, and neither follows the other.
- [ ] Change the cloud horizon on one Mac. The other Mac reads the same
      answer after its next mirror, and the bucket thins to match.
- [ ] *Export…* writes one archive named `<folder> — <today>`. Open it
      outside the app with Archive Utility: `workspace/` holds the current
      notes as plain files, `versions/` holds the store.
- [ ] Export a workspace of a few thousand files. It reports progress and
      does not wedge the app.
- [ ] Turn versioning off. Capture stops, nothing already captured is
      removed, and the surfaces say it is off rather than looking empty.

## 10. The old system is gone and nothing noticed

Phase 6. This is the one section where the *absence* of an effect is the
result: the manifest stops carrying history and the bucket loses what the
old system left, and none of it should be visible from inside the app.

- [ ] Version history looks the same before and after the upgrade for a
      workspace that has been connected for a while.
- [ ] A Mac still on the **old** build syncs happily against a domain a new
      Mac has upgraded, both ways, and its own history panel still answers —
      from its own store, which this never touches.
- [ ] The bucket loses its old per-file archives over the following hour or
      two of the app being open, and keeps losing them across a restart
      rather than starting over. Watch `history/` empty out with
      `wrangler r2 object list`.
- [ ] The manifest gets smaller — pull it and check a file entry carries
      `"hist": []` — and nothing else about it changes.
- [ ] `blobs/<fid>/` ends up holding one object per live file, and nothing
      at all for a file deleted more than a day ago. No document loses its
      current content.
- [ ] Connect a folder to a domain whose worker is one version behind. The
      clean-up does not run, nothing errors, the phase stays *Synced*, and
      it runs after the worker is updated.
- [ ] *Show changes* is on **every** version in the rail now, including the
      oldest one a connected workspace has.

## 11. The promises, tested directly

The rules in [versioning.md](versioning.md) §5. Each of these is a way a
user could lose data, and each has to fail to.

- [ ] Delete half the workspace and confirm the sync's mass-delete prompt.
      Every version of every deleted file is still there.
- [ ] Let a note be overwritten by a sync from **Other Mac** with something
      wrong. The overwritten text is in the history here.
- [ ] Trash a folder, empty the Trash, and get all of it back from the
      history.
- [ ] Fill the disk (or come close) while the app is running. Capture fails
      quietly and says so; nothing already stored is corrupted; the app does
      not lose the document you are typing.
- [ ] Pull the power (or force-restart) during a busy edit session. On
      relaunch the store opens, the history is intact, and at most the last
      capture is missing.
- [ ] Open a workspace of more than five thousand files. Versioning says it
      is too large rather than partly capturing it, and the app is otherwise
      normal.
- [ ] Put a very large file (over the sync's limit) in a workspace. It is
      skipped, everything else is versioned, and nothing errors.
- [ ] Open twenty windows on ten folders. One history per folder, no
      duplicates, nothing pegged.

## 12. What this pass cannot prove

Two things, and what stands in for them:

- **The ladder over months.** Nothing here runs long enough to watch a
  year's worth of versions thin from hourly to weekly. It is pinned instead
  by `ladder_keeps_expected_counts_over_two_synthetic_years`, which asserts
  the exact per-band counts. If you want to see it by hand: capture a few
  versions, then set the Mac's clock forward a month, reopen the app and
  watch the rail collapse to one row per day.
- **A store that has been in use for a year.** Approximate it by generating
  a synthetic store (hourly snapshots over two years is about a hundred
  megabytes of small files) and opening a workspace on it, to see that the
  rail, the timeline and the export are all still quick.
