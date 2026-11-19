# The Library layout — the cutover (built, not cut over)

The Library layout is built: its rules are in docs/cloud.md (*Sections*, *The
move into Library*, *Sections in the app*), docs/cloud-people-agents.md,
docs/versioning.md, docs/architecture.md, docs/ios.md and
cloud-worker/README.md. What is left is cutting base.aeoxoxo.ai over. Delete
this file, and its row in CLAUDE.md, once step 8 is done.

## Cutover (base.aeoxoxo.ai)

One release, for the one installation: the domain `base.aeoxoxo.ai`, whose
worker, bucket and D1 database are each named `doklin-base-aeoxoxo-ai`
(`sh scripts/doklin-cloud-update.sh --names https://base.aeoxoxo.ai`).

**What changes where:**

| Where | What happens | Who |
| --- | --- | --- |
| The worker | One code deploy: agent paths and the browser's paths | the superadmin, with `doklin-cloud-update.sh` |
| The bucket, D1 | Nothing. No object or row holds a path from the workspace's root: manifests, presence, leases, search and addresses are all per section | — |
| Each Mac | The update. The move runs by itself at launch, before anything syncs | each person |
| Each iPhone | The update, when its TestFlight build arrives. Until then the old build keeps syncing in the old layout | each person |
| A browser | A reload: the browser version ships with the worker | each person |
| Agents | Off for the window. After it, every path starts with its section | each person |

**What the window is for.** The sync wire does not change, so the apps need
no window: old and moved devices sync side by side with the old worker or
the new one. The engine never pauses for an older worker (it pauses only on
a `426`, or on a worker without request limits). The Cloud panel's
update card is advice. The window does two things:

- It keeps the new `doklin`, which comes with the new app, from writing
  `Library/…` to the old worker (docs/cloud-people-agents.md *CLI*). Agents stay off from the merge
  until the worker is deployed.
- It keeps the bucket quiet, so the check after the first move is exact:
  nothing may have changed.

A release takes 5–10 minutes (`release.yml`), so the window is about an
hour with the checks. Ask for two.

**Steps.** `$N` is `doklin-base-aeoxoxo-ai`, `$ROOT` is the superadmin's
workspace folder, and `CLOUDFLARE_ACCOUNT_ID` is set to the account that
holds the worker. Every command before step 5 only reads.

1. **Announce** (message A, below) a day ahead. At the start of the window,
   everyone has quit Doklin on the Mac once it says it is up to date, has
   closed Doklin in the browser, and has stopped every agent that runs
   `doklin`. iPhones stay closed.
2. **Check that it is quiet.** No device is beating:
   ```sh
   wrangler d1 execute $N --remote --command "SELECT device_name FROM presence WHERE until > unixepoch() * 1000"
   ```
3. **Keep a copy of what the move must not change.** Every section's
   manifest goes into a dated folder. The copies hold everyone's file paths,
   Private ones included: keep the folder off any shared disk, and delete it
   once the day-after check is done.
   ```sh
   B=cutover-before; mkdir -p "$B"
   wrangler r2 object get "$N/manifest.json" --remote --file "$B/manifest.json"
   for id in $(wrangler d1 execute $N --remote --json --command "SELECT id FROM spaces" | jq -r '.[0].results[].id'); do
     wrangler r2 object get "$N/spaces/$id/manifest.json" --remote --file "$B/$id.json"
   done
   jq '[.files[].path | select(ascii_downcase | startswith("library/"))] | length' "$B/manifest.json"   # 0 expected
   scripts/versions.sh "$ROOT" > "$B/versions.txt"   # the root's version history
   ```
   A count above 0 means a shared folder is already called `Library`. It
   moves to `Library/Library/` (docs/cloud.md *Sections*), and the later checks count from
   that number instead of 0.
4. **Merge the implementation's PR** and wait for `release.yml` to publish
   (`latest.json` names the new version).
5. **Deploy the worker:**
   `sh doklin-cloud-update.sh https://base.aeoxoxo.ai`, fetched from the
   release as its header says. Agents may run again after this step, with
   the new rule.
6. **Update the superadmin's Mac first.** Open Doklin and install the
   update. It relaunches and moves the folder. Check:
   - The sidebar shows Library, Restricted and Private, with nothing called
     Workspace. Every shared file is under Library.
   - `$ROOT` holds only `Library/`, `Private/`, `Restricted/` and hidden
     entries, and `$ROOT/.doklin/cloud.json` says `"layout": "library"`.
   - Once the status says up to date, every manifest is as it was (`seq`,
     and each file's id, rev and path). Fetch them again into
     `cutover-after/`, then compare each pair:
     ```sh
     node -e 'const [a,b]=process.argv.slice(1).map(f=>JSON.parse(require("fs").readFileSync(f,"utf8")));const k=m=>Object.entries(m.files).map(([i,f])=>i+" "+f.rev+" "+f.path).sort().join("\n");console.log(a.seq===b.seq&&k(a)===k(b)?"unchanged":"CHANGED")' cutover-before/manifest.json cutover-after/manifest.json
     ```
   - `scripts/versions.sh "$ROOT/Library"` lists the rows that
     `cutover-before/versions.txt` lists, and a shared file's Version
     history shows its old versions.
   - The Cloud panel shows no worker update card.
   - The new `doklin`: `doklin ls` lists Library, Private and Restricted;
     `doklin read Library/<a file>` reads it; the same path without
     `Library/` is refused with the sentence.
   - `https://base.aeoxoxo.ai/app` shows the same tree.
7. **Send message B.**
8. **The day after**, fetch the shared manifest again. The `library/` count
   is still what step 3 found, and the tombstones have not jumped. Then
   delete both folders of copies.

**If something goes wrong:**

- **Never revert this change on `main` once a device has moved.** A revert
  is a new release. The updater offers it as an update, and every Mac that
  takes it runs the old layout on a moved folder (docs/cloud.md *The move into Library*, its traps). Fix
  forward.
- **The worker deploy fails.** The old worker keeps serving and the apps are
  unaffected. Keep agents off and run the script again.
- **Shared paths start with `Library/`** (the count went up). An old build
  ran on a moved folder, or the new `doklin` wrote to the old worker. Find
  it and stop it. Then, on one moved Mac, move everything in
  `Library/Library/` up into `Library/`, which moves the paths back for
  every device.
- **A Mac's marker says `"moving"`.** The move stopped partway. Open Doklin
  again and the move finishes (docs/cloud.md *The move into Library*). Nobody moves files by hand.
- **The mass-delete valve asks on a Mac right after it updates.** Decline.
  The shared unit saw a partly moved tree, which the move is built to rule
  out. That is a bug to find before anyone approves.

**Message A (a day ahead):**

> Doklin will be down for maintenance on <day>, <start>–<end> <zone>.
> Before <start>: wait until Doklin says everything is up to date, then quit
> it (⌘Q). Close Doklin in your browser, and stop any agent that uses the
> `doklin` command. Leave the iPhone app closed. I'll message you when it's
> back.

**Message B (when step 6 has passed):**

> Doklin is back. Everything we all share is now in a folder called
> **Library**, next to Private and Restricted. Nothing was deleted, and who
> sees what has not changed.
>
> - **Mac**: open Doklin and install the update it offers (Settings → Check
>   for updates, if it doesn't). It relaunches and moves your files into
>   Library by itself, before it syncs anything. Don't move them in Finder
>   yourself.
> - **Browser**: reload base.aeoxoxo.ai/app.
> - **iPhone**: keep using it. It moves its files by itself once the new
>   build reaches you.
> - **Agents**: every path now starts with its section: `Library/…`,
>   `Private/…` or `Restricted/<folder>/…`. A path without one is refused
>   with a message that says which to use. The `doklin` on your Mac updated
>   with the app. On any other machine, run the install line again.
> - A link from a Private note to a Library note written as `../…` needs
>   fixing once.
