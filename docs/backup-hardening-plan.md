# Backup hardening plan

Goal: no single mistake, bug, token or account can erase the workspace's
history, and one copy lives outside Cloudflare.

**Decided:** the live workspace never sits inside a Google Drive (or any other
synced) folder. Drive's only role is to hold export archives (item 4). Sharing
stays Doklin's.

## How it works today

A connected workspace has sections: `Library/` (everyone), each person's
`Private/`, and each folder under `Restricted/`. Every section has its own
history.

- **Files:** every Mac in a section holds its current files.
- **Local history:** each Mac keeps snapshots of each section it holds, in app
  data (`engine/src/versions/`). They're thinned by age, and the default limit
  is 90 days.
- **Cloud history:** every Mac uploads its snapshots to that section's
  `versions/` in the bucket (`versions/` for Library, `spaces/<id>/versions/`
  for the others). The default is to keep them forever.
  - Once a day, every device in the section thins it by the same rule
    (`sweep()`, `engine/src/cloud/versions.rs`).
  - The worker checks only the shape and size of what it's sent
    (`cloud-worker/src/versions.ts`).
- **Export:** *Versions → Export…* writes one `tar.gz` holding the current
  files and the local history, by hand. It covers **Library only**:
  `App.tsx` passes `libraryDir`, so your Private and restricted folders are in
  no archive.

What can erase history today:

| What | What it erases | Who can do it |
| --- | --- | --- |
| Deleting a restricted folder | its files and all its history: in the bucket and on every member's Mac, with no Trash | anyone in the folder (the dialog says "cannot be undone") |
| Changing the cloud horizon | that section's cloud history older than the new limit | anyone in the section |
| A buggy or misused client | any cloud history in the sections it's in: index rows, snapshots, blobs | any person's device or browser session (agents can't reach these routes) |
| *Delete everything…* (wipe) | the whole bucket | the superadmin |
| Losing the Cloudflare account | the whole bucket | — |

## Checklist

- [x] **1. The daily sweep can't delete content that history still needs**
  - Already on main: the sweep collects no blobs when a retained snapshot can't
    be read, and puts back referenced blobs the bucket lacks, from any Mac that
    still has them.

- [ ] **2. A deleted restricted folder's cloud history is kept for 30 days**
  - Decided 2026-11-25: keep it for 30 days. This replaces today's deliberate
    "cannot be undone" (`src/SpaceAccess.tsx`). The scheduled export (item 4)
    stays as the second copy.
  - Worker: `deleteSpace` (`cloud-worker/src/spaces.ts`) deletes the folder's
    manifest and file copies, keeps `spaces/<id>/versions/`, and writes a
    deletion date beside it. The daily cron (`sweep.ts`) purges that history
    30 days later. The D1 rows go as today.
  - Trap: `deleteSpace` loops until a listing of the space comes back empty,
    and the engine repeats it while `remaining`. Skipping `versions/` keys in
    that listing would never finish, so list `manifest.json` and `blobs/`
    instead.
  - Macs: unchanged. A Mac can't tell "the folder was deleted" from "you were
    taken out of it" (both arrive as "no longer listed", `engine.rs`
    `reconcile_spaces`), and the second must delete the local copy.
  - Restoring: a hand-run script for the superadmin rebuilds the folder from
    the newest kept snapshot.
  - Change the dialog's wording to match.
  - Done when: a worker test deletes a folder, its history is still there after
    the delete, and the cron removes it after 30 days and not before.

- [ ] **3. Limit what one client can remove from cloud history**
  - The sweep has to stay with the people in each section. The superadmin's
    devices can't reach a restricted folder they aren't in, or anyone else's
    Private. An unswept index hits the worker's 2,000-row cap (`layout.ts`)
    within a month or two of steady editing, and its mirror then stops.
  - So the worker enforces these limits on everyone:
    - changing `horizonDays` needs the superadmin (a new row in
      `cloud-worker/src/roles.ts`, the way the wipe is superadmin-only);
    - an index PUT may not drop a pinned (named) row or the newest row;
    - a snapshot DELETE is refused while the index still lists it;
    - a blob DELETE is refused within an hour of its upload.
  - App: everyone else sees the cloud horizon read-only (`you.can` from
    `/api/meta`).
  - Trap: a refusal must not reach the mirror's error path. Treat it like a lost
    race (try tomorrow).
  - Still possible after this: dropping ordinary rows and deleting referenced
    blobs. The next sweep puts back blobs any Mac still holds. Item 4 covers
    the rest.
  - Done when: worker tests (`cloud-worker/test/run.mjs`) refuse each of the
    four, and an engine test shows a refused sweep is retried the next day.

- [ ] **4. Scheduled export to a folder outside Cloudflare**
  - Versions settings: Daily (the default) / Weekly / Off, plus a destination
    (a Google Drive, iCloud or other folder). Runs while the app is open, and
    on launch when one is overdue. Mac only.
  - Each run writes `<workspace> — <date>/`, holding one archive per section
    this Mac holds: Library, its Private and each restricted folder.
    `versions_export` already exports one section; the run loops over
    `cloud::section_roots`.
  - The manual *Export…* does the same, so it stops being Library-only.
  - Keeps the last 7 runs and deletes older ones it made.
  - Shows "Last backup: date · size", and warns when one is overdue or failed.
  - Caution in the UI: the destination's own sharing applies, so pick a folder
    nobody else can open.
  - Restore means unpacking: `workspace/` is the files, and `versions/` is the
    store. Write that down in versioning.md.
  - Done when: a test runs a due export across all sections, prunes to 7 runs,
    and reports a failure.

- [ ] **5. Report what the sweep couldn't fix**
  - Today the sweep only logs unreadable snapshots (`eprintln!`), and it
    silently leaves referenced blobs that no Mac could put back.
  - Add both counts to `VersionsMirror` (`engine/src/cloud/status.rs` ⇄
    `src/cloud.ts`), and show them in the Cloud panel when they aren't zero.
  - Done when: a test removes a referenced blob that no store holds and the
    status reports it.

- [ ] **6. Docs and version**
  - versioning.md: who may remove cloud history, a deleted folder's 30 days,
    the scheduled export, and how to restore from it.
  - cloud.md and cloud-people-agents.md (restricted-folder deletion),
    cloud-worker/README.md (the route limits).
  - One `WORKER_VERSION` bump, from whatever main has when this ships. Item 2
    adds no D1 column.
  - Delete this plan, and its row in CLAUDE.md's doc map, once it's built.

## Deferred

- **The worker runs the thinning rule itself**, so that no client can drop
  rows it shouldn't. That means porting `retain()`
  (`engine/src/versions/retain.rs`) to the worker and keeping both in step,
  with clock-skew slack at the boundaries. Worth it only if item 3's limits
  prove too loose.
- **R2 bucket lock** (blocks deletes under a key prefix for N days). History
  sits under each space's own prefix, next to a manifest that is rewritten
  every sync. Locking needs a rule per space, or all history moved under one
  prefix, plus a sweep that collects by listing past the lock age. Once items
  2–5 land, it would only add cover for the day since the last export.

## Not doing

- A workspace folder inside Google Drive for desktop: two sync systems on one
  folder, and Drive wouldn't get Doklin's history anyway.
- Edit-sharing a Doklin workspace through Drive.
