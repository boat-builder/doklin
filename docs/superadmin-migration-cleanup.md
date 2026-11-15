# Throwaway: remove the key-migration support

Temporary. The superadmin change (worker v17, D1 schema 8) carries code that
only moves existing installations over: a domain's old `creator` row, and a
Mac whose `cloud.json` still holds the domain's key from when it was a
sign-in. Once every installation has moved, all of it goes, and so does this
file.

## When

All three, confirmed with the users:

1. Every domain runs worker v17 or newer (`/api/meta` answers `version ≥ 17`
   and `d1: 8`).
2. Every Mac that was connected before v17 has updated the app and synced
   since: none shows "this Mac still signs in with the domain's key…", and
   every domain has a superadmin (`/api/meta` `superadmin` is not null).
3. Nobody runs an app older than this release against any domain.

## What goes

**The worker's data move** — `cloud-worker/src/schema.ts`
- Step 8: every statement but the two `CREATE TABLE … superadmin` /
  `spent_keys` — the `CREATE … creator`, the copy into `superadmin`, the
  agents `UPDATE`, the three orphan `DELETE`s, the `DROP TABLE creator` —
  and `retires: ["creator"]`.
- Step 7: the `creator` table, its `INSERT OR IGNORE INTO creator` move, and
  `"creator"` in its `tables`; the comment lines about `creator` and
  `member_id` NULL.
- The `retires` field on `Step` and `RETIRED` (nothing else uses them).
- `cloud-worker/test/run.mjs`: the test "d1: a database from before roles
  learns who its creator was…" (it seeds schema-6 databases to exercise both
  moves).

**The app's key trade** — `src-tauri/src/cloud/`
- `engine.rs`: `KEY_SENTENCE`, `KEY_TRADE_GAP`, `EngineConfig::on_key`, the
  `key` and `key_asked` fields, the `meta.key` branch in `probe_worker`, and
  `self.key` in `can_cycle`, `pass` and the run loop's poll branch.
- `mod.rs`: `trade_key` and the `on_key` wiring in `spawn_engine`.
- `remote.rs`: `Meta::key` (the worker keeps answering `key: true` — the
  recovery prompt's check reads it — but nothing in the app does).
- `tests.rs`: `FakeWorker::key`, its branches in `meta` and `ready`, and the
  test `a_mac_still_holding_the_key_syncs_nothing_and_asks_the_manager_to_trade_it`.
- `docs/cloud.md` *Flows*: the "A Mac whose `cloud.json` still holds the key"
  bullet.
- `cloud-worker/src/version.ts`: the last sentence of the `"superadmin"`
  comment (the app trading a stored key).

**Messages for a worker older than v17**
- `mod.rs` `describe_recover`: the `NotFound | Forbidden` arm ("too old to
  recover").
- `src/cloudPrompts.ts` `buildRecoverPrompt`: "If it answers but has no
  "key" at all…" in step 4, and its check in
  `verify-harness/cloudprompts.test.mjs` (`/update script first/`).
- `src/CloudSetup.tsx` `versionNote`: the `withKey` branch ("run the update
  script on it first").

**Older than this change, the same kind — decide then**
- `engine.rs` `signature()`: signing with the Mac's name when the domain does
  not say who this is (workers before v6), and what leans on `me` being
  `None` (`make_space`'s check, the Private reconcile's `self.me.is_some()`,
  the fake worker's nameless first device and the two tests about a Mac the
  domain has not named).
- `terminal.rs` `terminal_name`: `Terminal (…)` for a person with no name.

No wire change: no `WORKER_VERSION` bump, no schema step. Run the worker
tests, `cargo test --lib`, `pnpm build && pnpm lint`, and the
`drive-cloud` / `drive-cli` drivers after.
