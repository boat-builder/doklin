# Throwaway: remove every backward-compatibility path

Temporary. Doklin has exactly one installation: one Mac on the latest app,
one Cloudflare account, one domain with one worker, one D1 database and one
bucket, and two agents on the current CLI. Nothing older than the current
code exists anywhere, so every line whose only job is coping with an older
worker, database, bucket, stored file or app version goes. This file is the
checklist; it goes with the cleanup.

Line numbers are as of the commit that added this file; the symbol named is
what to look for.

## When

1. The renumbering fix (worker v18, D1 schema 9) is merged and the domain's
   worker runs it: `/api/meta` answers `version ≥ 18` and `d1: 9`.
2. The Mac signs in with its own device token and the domain has a
   superadmin (`/api/meta` `superadmin` is not null). Done.
3. The decisions below are answered.

Checked against the live setup before writing this: the D1 is at 9 with
`superadmin` and `spent_keys`; the workspace's `legacy_cleanup` is done; every
public entry has `at`; no document in a Doklin folder on the Mac has inline
thread bodies, id-less CriticMarkup or `eid`/`codeId`/`label` stamps; 22 of
285 manifest entries are still signed with a device name (D4); the bucket
still holds a dead `presence.json`.

## Decisions (answer before starting)

- **D1 — squash the D1 history.** Replace `STEPS` with one step `to: 9` that
  makes the final shapes, matching the live tables. Recommended.
- **D2 — drop worker features.** Drop `WORKER_FEATURES`, `meta.features`, and
  every feature check in the engine, CLI and app. `WORKER_VERSION` becomes
  the one compatibility signal. Recommended.
- **D3 — drop `key: true` from `/api/meta`.** The recovery prompt's check
  verifies on the 200 instead. Recommended.
- **D4 — the 22 manifest entries signed with a device name.** Re-sign them
  to the superadmin's member id once, on the live manifest, then make `by` an
  id everywhere. The alternative is keeping the device-name tolerance.
  Re-signing is recommended. Tightening the worker's validation first would
  refuse the Mac's next push.
- **D5 — the comment format.** Drop the inline-thread migration and the
  `eid`/`codeId`/`label` stamps in the app, worker and iPhone app, and in the
  shared fixture. Keep id-less CriticMarkup, which is hand-written input.
  Recommended.
- **D6 — `mayOn` stops treating an empty `can` as "allowed".** Controls show
  once the domain has answered. Recommended.
- **D7 — delete `columns`/`ensureColumn`.** Bring them back with the first
  future step that adds a column. Recommended.
- **D8 — remove dead code found on the way.** That is `agents.disabled`,
  never written, and `/<slug>/og.png`, never linked. Then drop the live column
  by hand. Recommended.

## What goes

### Worker — `cloud-worker/`

**`src/schema.ts`**
- With D1: `STEPS` becomes one step `to: 9` that creates:
  - members, and tokens and invites with their indexes;
  - presence and leases keyed by space;
  - agents, with `member_id` last and nullable, as the live table has it;
  - agent_codes and agent_tokens with their indexes;
  - search_text and search_state by space;
  - removed_tokens, and spaces, space_members and addresses with their
    indexes;
  - superadmin and spent_keys.
- Its `tables` lists them children-first, which the wipe batch relies on:
  tokens, invites, members, presence, leases, agent_tokens, agent_codes,
  agents, search_text, search_state, removed_tokens, space_members, addresses,
  spaces, superadmin. `spent_keys` is not listed, because the wipe keeps it.
- These go with the squash:
  - `SPACES_STEP` and step 8;
  - every `creator` statement and the `< 7`/`< 9` guarded moves;
  - the presence/leases/search drop-and-recreate;
  - the orphan-agent `DELETE`s and `DROP TABLE board_cards`;
  - `retires`/`RETIRED` (39–41, 407–408);
  - with D7, `columns` (42–44, 428) and `ensureColumn` (446–468).
- With D8, `agents.disabled` leaves the fresh schema.
- The runner's guarded bump (430–433) binds the version it read, not
  `step.to - 1`. Otherwise a fresh database at `BASE_VERSION` never matches.
- Rewrite the header (9–29) as rules: no "step 7 does", and no "deployed
  before the binding existed".
- Every comment about creator, "owner nobody named", "used to", "now" and
  "rotated secret" goes. That covers 52–100, 145, 156, 221–258, 345–371
  and 418.

**`src/version.ts`**
- With D2: `WORKER_FEATURES` and the comments explaining each name (41–58).
- History:
  - 64–67, the key and stored-key trade sentences;
  - 76–78, "Version 3 is where `by`…".

**`src/api.ts`**
- With D3: `key: true` in `handleKey`'s meta (366) and its doc.
- History comments: 265–268, 933–935, 944–947 ("missing" database) and
  999–1002.
- `noDatabase`'s "update the worker" (348) means a pre-D1 domain. Make it
  say the binding is missing.

**`src/agentApi.ts`**
- `noDatabase` text (84).
- With D2, `features` (92).

**`src/agentComments.ts`**
- With D5: the `migrateEntity` import and calls (38, 248–257, 90–92).
- Read through the current sidecar path.

**`src/manifest.ts`**
- With D4: `by` validated as a member or agent id, and its v2 comment (32–36).
- `at` required on public entries.
- The tombstone-under-`Private/` tolerance comment and its README line (260).

**`src/presence.ts`**
- History comments 4–9 and 22–25.
- `memberId: string | null` becomes `string` (49, 60, 123, 133).

**`src/agents.ts`**
- With D8: the `disabled = 0` reads (143, 154, 209, 363).
- `AgentListed.memberId` is already `string`.

**`src/public.ts`**
- With D8: the `/<slug>/og.png` alias (14, 91) and README:214.

**History comments**
- `src/layout.ts` 17–21;
- `src/bucket.ts` 2–4;
- `src/commit.ts` 3–4;
- `src/members.ts` 3–4;
- `src/env.ts` 12–16 (keep `DB?`, reword it as a binding that may be
  missing).

**"Shared sync goes on without a database" premises**
- `addresses.ts` 14–17, `api.ts` 861–864, `presence.ts` 22–23, `search.ts`
  33–34.
- Keep the best-effort behaviour, which still holds for a D1 failure
  mid-request. Reword the premise.

**`test/run.mjs`**
- `AGENT_TABLES_BEFORE_OWNERS` (114–121).
- `rewound` and the three D1 migration tests (1088–1284).
- "history: the three deprecated routes are gone" (1572–1583).
- The old `/api/presence` and `presence.json` asserts in "poll: a GET only
  reads…" (1790–1792, 1794).
- The stale message at 1760, and "A member id since v3" (193).
- With D5, the inline-thread block (4254, 4447–4456).
- With D3, the `key: true` asserts (250, 308).
- The NULL `member_id` presence rows (1799, 1944, 1953).
- The tombstone "an old one must not stop the next write" line (1447–1449).
- The no-binding test messages (215) say "binding missing", not "deployed
  before".

**`README.md`**
- 11: "D1 down… rotated secret" (D1 down is a 503).
- 25–26 with D3.
- 129: `memberId|null`.
- 237: old `presence.json` and `history/`.
- 255 with D4, and 260.
- 273–274: `member_id?`.
- 292–297: runner rules after the squash. Keep the rule that a shipped step
  is never renumbered or removed, from the squash on.

**`scripts/doklin-cloud-update.sh`**
- The create-a-missing-D1 branch (295–313) and its header and comments
  (17–22, 253–257).
- A missing database dies, as a missing `D1_NAME` already does.

### Engine — `engine/`

**The key trade**
- `cloud/engine.rs`:
  - `KEY_TRADE_GAP` (81–85), `KEY_SENTENCE` (198–201);
  - `EngineConfig::on_key` (222–226);
  - the `key`/`key_asked` fields (294–298, 365–366);
  - the `meta.key` branch (535–543);
  - `self.key` in `can_cycle` (408), `pass` (624–625) and the run loop
    (1885–1887).
- `cloud/mod.rs`: the `on_key` wiring (252–255), `trade_key` (294–322), and
  `describe_recover`'s `NotFound | Forbidden` arm (663–666).
- `cloud/remote.rs`:
  - `Meta::key` (52–56) and "before v17" (58);
  - `recover`'s email is `&str`, not `Option` (636–641).

**Feature gating (D2)**
- `cloud/engine.rs`:
  - `ASKED_AGAIN_FOR` (72–74, 1298–1307): replace it with "probe until
    answered", so an engine that started offline still learns `me`;
  - `worker_features` (278–280) and `worker_has` (609–611);
  - `in_sections` (470–472);
  - the `versions` gate on the status (498–503);
  - `reconcile_spaces` (983–985);
  - `make_space`'s old-worker refusal (1169–1174);
  - `mirror_versions` (1308–1310);
  - `set_cloud_horizon`'s "too old" (1322–1324);
  - `beat_due`/`beat_deadline` (1446–1463), `claim_owed` (1477–1479), and
    `leave` (1513, the presence half);
  - the `VersionsIndex` filter (1816).
- `cloud/mod.rs`: `people_of`'s `roles` check (829–838), and the
  `versions_index_for` doc (1408–1410).
- `CloudStatus.sections` (`status.rs` 98–101) is always true, so it goes. So
  do `src/cloud.ts` 154–156 and 560, and on the iPhone the `sections ==
  false` checks: `Workspaces.swift:402`, `Folder.swift:96`,
  `Sections.swift:35, 48`.

**Old-worker error arms in `cloud/mod.rs`**
- `describe_redeem`'s `Outdated | NotFound` (611–621), with `remote.rs`
  `redeem`'s "predates invites" (1299–1312).
- `describe_devices` (711–720): callers use `describe_people`.
- `describe_people`'s `NotFound` (859–870), and the `revoked` doc (872–875).
- `describe_agents` (900–909) and `describe_pages` (1373–1383).

**A person the domain has not named (`me` is None)**
- `cloud/engine.rs`:
  - `signature()`'s device-name fallback (571–579);
  - `status.me` through it (493);
  - `meta.you.unwrap_or_default()` and the empty-id filter (531–532);
  - `&& self.me.is_some()` (999–1000) and `self.me.is_none()` in
    `make_space` (1175–1180);
  - the `member_id.is_some()` guard in `lease_holders` (1643);
  - the `private_refusals` comment (263–266).
- `cloud/remote.rs`:
  - `Identity::can`'s default and comment (74–78);
  - `token_id`/`member_id` are `String`, not `Option` (79–84).
- `cloud/status.rs`: `People.me` is `String` (272–274; change both with
  `src/cloud.ts:262`), and the comments at 61–74, 81–83, 94–97 and 162–164.
- `cloud/terminal.rs`: `you.name` (53), and `terminal_name`'s
  `Terminal (…)` branch (69–80) with its assert (142).
- `cloud/flows.rs` `seed_upload` (85–86, 133–139): sign with the member id
  `cloud_recover` returns, not the device name.
- `cloud/manifest.rs`: with D4, `is_directory_id` and its guard in
  `learn_people`. `PresenceEntry`/`LeaseEntry` `member_id` becomes `String`,
  with the worker's types.

**Stored-data migrations**
- `cloud/unit.rs`, the retired-history sweep:
  - `LEGACY_BATCH` (54–57);
  - `WorkspaceState.legacy_cleanup` (124–127) and `LegacyCleanup`
    (130–163);
  - `legacy_fids`/`legacy_cleanup` (1505–1563);
  - in `cloud/engine.rs`, `space_unit`'s `done = true` (397–399) and the
    poll's call (1622–1624).
- `cloud/unit.rs`, the reserved-name rescue:
  - `top_dir` (309–317) and the `read_space_marker` import (31);
  - the survey arm (425–427);
  - `reserved_clear` (443–450) and `rescue_reserved` (452–485);
  - its call, "2½" (559–561);
  - in `cloud/engine.rs`, the guards at 987–991 and 1178.
- `cloud/manifest.rs`: `#[serde(default)] at` on public entries (151).
- `cloud/config.rs`: filling in an empty `domain` (111–115).
- Dead fields: `WorkspaceState.version` and `CloudFile.version`, which are
  written but never read.

**History comments**
- `cloud/mod.rs:15` "manifest v2" (it is 4).
- `cloud/engine.rs` 260–262, 281–289, 307–319, 525–530, 581–585, 1299–1304
  and 1784–1788.
- `cloud/remote.rs` 39–42, 351–355, 605–608 and 788–793.
- `cloud/manifest.rs` 53–55, 101–105, 181–193 and 228–232.
- `cloud/unit.rs` 1142–1149.
- `versions/mod.rs` 1114–1117, and `versions/store.rs` 114–118 (keep the
  three horizon states).

**`cloud/tests.rs`**
- The fake worker:
  - `key` (88–90, 340–342, 396–408) and `on_key: None` (1395);
  - with D2, `features` and its gates (64, 240–250, 477–480, 490, 525,
    554–555, 567–571);
  - the superadmin is named by default (104–108);
  - `member_id` is not `Option` (375–382) and `meta` always says who
    (416–423);
  - the "nobody to…" errors (587–589, 615–617) and `name_superadmin`
    (256–274) go;
  - `create_invite` names a person from the email as the real worker does
    (1056);
  - the history comments at 72–74, 3705, 4016 and 4109.
- Tests that go:
  - `an_older_devices_attribution_is_read_and_never_rewritten`
  - `a_mac_still_holding_the_key_syncs_nothing_and_asks_the_manager_to_trade_it`
  - `a_worker_without_presence_is_polled_and_never_beaten_at_until_it_is_updated`
  - `the_hourly_pass_asks_again_until_the_worker_holds_leases`
  - `no_versions_feature_means_no_mirror_and_a_null_status`
  - `a_worker_updated_mid_session_starts_mirroring_on_its_own`
  - `legacy_cleanup_sweeps_the_retired_blob_backlog_across_polls`
  - `a_bookmark_from_the_archive_pass_does_not_carry_into_the_blob_sweep`
  - `a_mac_the_domain_has_not_named_has_no_private_and_is_not_asked_for_one`
  - `a_shared_folder_called_private_is_renamed_once_and_stays_shared`
  - `a_folder_needs_somebody_to_belong_to_and_a_worker_that_has_them`
- Tests that lose a part:
  - `people_is_everybodys_to_see_and_an_owners_to_change`: 2849–2860;
  - `a_worker_without_leases_or_a_database_shows_no_lock_and_is_not_claimed_at`:
    the `older == true` pass;
  - `manifest_wire_shape_matches_the_worker`: the sparse `version: 2`
    manifest;
  - `a_restricted_folder_made_with_people_is_theirs_from_the_start`: 6295.
- Tests whose device-name `by` asserts become member ids:
  - `initial_push_then_second_device_pulls`
  - `edit_propagates_and_the_manifest_keeps_no_revisions`
  - `same_line_conflict_keeps_both_versions`
  - `publish_mirrors_to_the_other_device`
  - `a_manifest_naming_a_stranger_asks_the_domain_once_who_they_are`
  - `an_agent_the_directory_cannot_name_is_shown_as_its_id_and_asked_about_once_a_gap`

### Mac app shell — `src-tauri/`

- `src/lib.rs` session v1:
  - `PersistedWindow.files`/`.active_file` and their comment (124–130);
  - `#[serde(default)]` on `PersistedWindow` (119);
  - the migration loop in `read_persisted_session` (212–233);
  - `..Default::default()` in `persist_session` (250).
- `src/untitled.rs`:
  - `adopt_legacy_drafts` (145–170) and its call in `lib.rs` setup
    (1796–1800);
  - the test `legacy_drafts_move_over_once` (231–252);
  - fold `dir_in` into `dir`.
- `src/cli_install.rs` 6–8: the comment is reworded as a rule.

### CLI — `cli/`

- `src/commands.rs` 127–135: `login`'s "too old for agents" and its comment.
- With D2:
  - `session()`'s feature lookup and refresh (45–69);
  - `features` stored at login (150);
  - the 16 `agent-*` gates (215, 269, 317, 364, 480, 492, 539, 569, 611,
    658, 673, 719, 761, 785, 814, 845);
  - `creds.rs` `features` (31–34).
- Exit 7 and `Failure::too_old` stay, for a route an older worker answers
  404/405 (`http.rs` 105–125). Reword `main.rs` 28–29 and `help.rs` 61–62
  and 358–359 without "missing feature".

### iPhone — `ios/`

- With D5:
  - `CriticMarkup.swift` stamps (24–29) and comments (5–6, 17–18);
  - `MetaFile.swift`'s `migrate` and stamp branches (85–87, 139–141,
    243–291);
  - the `Threads.swift` comment (133–134);
  - `CommentsTests.swift` `testMigration` and stamp cases (36–40, 129–144).
  - Keep the id-less span parsing.
- `Models/Publishing.swift` 143–155: the `page.at > 0` branches.

### Frontend — `src/`

**`cloud.ts`**
- With D6, `mayOn`'s empty-`can` branch (604–612).
- `versionsLine`'s "too old to keep version history" (779–790).
- With D2, `CloudProbe.features` (185).
- `sections` (154–156, 560).
- `CloudPeople.me` is `string` (262).
- The old-worker comments at 54, 133–135, 142–143 and 147–149.

**`cloudPrompts.ts`**
- With D3, the recover step 4 "no key at all… update script first" sentence
  (236); the check verifies on the 200.
- Teardown's "set up before Doklin used a database" and "skip if no such
  database" (335, 337).

**Other components**
- `CloudSetup.tsx`: `versionNote`'s `withKey` branch (399–400).
- `WorkerUpdate.tsx`: the D1-creation text (10–11, 136–137) and "(v1 → v2)"
  (1).

**`App.tsx`**
- `readStoredTheme`'s sepia → paper (446–452).
- `readAllSessions`' v1 session migration (553–555, 574–582).
- `forgetDraftsPanelKeys` (641–651) and its call (4159).
- The board comment (1042–1043).
- With D5:
  - the workspace-wide meta sweep and its `doklin:meta-migrated-v1` flag
    (4465–4518);
  - the per-open migration: `migrateEntityOnDisk` (1558–1634), `diskRaw`
    (1391–1460), normalize on open (2022–2032) and the import (106).

**Comment format, with D5**
- `metaFile.ts`: `migrateEntity` (379–424) and its comments (4–5, 16–17,
  38–42, 126).
- `criticMarkup.ts`: the stamps (28–36).
- `metaFile.ts` 183–185 and 235–238.
- `htmlComments.ts` 125–131 and 144–145.
- Id-less spans stay; drop the "older Doklin versions"/"legacy" wording
  (`criticMarkup.ts` 16–18, 25; `criticMark.ts` 174–188; `metaFile.ts`
  271–366, where `legacySeq` gets a plain name).

**History comments**
- `CloudAgents.tsx` 171–172.
- `CloudPeople.tsx` 175–176.
- `CloudPanel.tsx` 279–280.
- `Sidebar.tsx` 149–150.
- `linkOpen.ts` 6–7.
- `CommentsRail.tsx` 35–37.

### Harness — `verify-harness/`

**`cloudprompts.test.mjs`**
- 339 (recover "too old").
- 324 (teardown with no database).
- 306–307 and 312–313 (D1 creation).
- 174 (the `SHARE_TOKEN` guard against the removed stack).

**`drive-cloud.mjs`**
- The header (17–19).
- The step "Agents (an older worker)" (1454–1484).
- The "too old" half of "version history… one version behind" (565–582).
- The `status()` fixture carries the current shape (113–131): `can`, `meId`,
  `superadmin`, `spaces`, `versions`.
- `features: ["sync","wipe"]` (231, 913) and `memberId: null` presence rows
  (713).

**`cloud.html`**
- `versionsMirror: null` (148–150).
- The agents error comment (170–174).
- The `statusFor` `spaces`/`sections` defaults (401–402), and the nameless
  `me` (388–390).

**`drive-cli.mjs`**
- 1627–1635: before agents.
- With D2:
  - the header (8–9, 33–34) and `ALL_FEATURES` (365);
  - "it remembers what the worker can do" (529);
  - the features part of "the worker" (632);
  - section 14's feature-gating check (1572–1625), keeping its route
    404/405 checks.

**With D5**
- `drive-meta.mjs` (1–6, 59, 74, 76–86) and `meta.html` (13–39).
- `metafile.test.mjs` (4, 171–236).
- `comments.test.mjs` (68–76, 95, 142, 158).
- `merge.test.mjs` test 4 (71–80) and the eid fixtures.
- `comments-fixture.json`: `migrate` (1083), threads[1] (1189),
  operations[2] (1448) and meta[4] (690). Change it with the iPhone tests.

**Others**
- `shot-refresh.mjs`: the old font and wide-page keys (86–90, 134–140,
  155).
- `refresh.html` prose (42, 51).

### Docs

**`docs/cloud.md`**
- 74, second sentence.
- 76: `rescue_reserved`.
- 82: `sections`.
- 112: pre-v3 device names.
- 124: the key bullet.
- 138: the engine and CLI feature gates.
- 142: "may create only the D1 database".

**`docs/versioning.md`**
- 7: `versions/drafts`.
- 17: no `versions` feature.
- 73: `legacy_cleanup`.

**`docs/cloud-people-agents.md`**
- 11: an empty `can`.
- 106: exit 7's "missing feature".

**This file**

## Stays — not compatibility

- The version probe, the update card, 426 on a version mismatch, and the
  CLI's 404/405 → exit 7. That is how the next release reaches the domain.
- The optional `DB` binding and `d1: null`: setup step 9 uses it to catch a
  binding that did not take.
- The key-bearer probe on `/api/meta`, for the setup wizard. Only the `key`
  field goes (D3).
- Hand-written CriticMarkup with no `#id`.
- `sanitizeTabs`, the session file's version stamp, `members.disabled`, the
  roles-table gates (`agents.own`, `devices.own`), and the UI's superadmin
  fallbacks while the domain has not answered.
- A raw `by` shown for a person since removed (`everyPage.ts`, `name_of`).
- The mermaid any-tag rule, the zoom probe, and the install script's
  `~/.local/bin` handling.

## Outside the code (by hand, each with the owner's OK)

- **Bucket:** delete the dead `presence.json`.
- **Manifest:** with D4, re-sign the 22 device-name entries before the
  worker tightens `by`.
- **D1:** with D8, `ALTER TABLE agents DROP COLUMN disabled`.
- **The Mac's app data** (`~/Library/Application Support/com.sherin.doklin/`)
  holds files nothing reads: `dictation.json`, `stt-models/`, `share.json`,
  `sync.json` and `sync/`, `scratch/`, and `doklin-worker-update.sh`.
- **`~/Library/Application Support/com.sherin.mde/`**, the pre-rename
  identifier, holds 4 notes in `drafts/` from 1 July. Look at them before
  deleting.
- **`~/.config/doklin/credentials.json`** caches an old `features` list. It
  is harmless once D2 lands, since serde ignores unknown keys.

## After

- Worker typecheck and tests, on the source and on the bundle.
- `cargo test --workspace` in `engine/`, and `cargo test --lib` in
  `src-tauri/`.
- `pnpm build && pnpm lint`.
- `cloudprompts`, `metafile`, `comments` and `merge` tests.
- The `drive-cloud`, `drive-cli` and `drive-meta` drivers.
- The iPhone package tests.
- Bump `WORKER_VERSION` once, from main's number, so the domain's update card
  offers the cleaned worker. There is no new schema step: the squashed step
  stays at 9.
- Update the domain's worker from the card, then check that `/api/meta`
  answers the new version and `d1: 9`.
