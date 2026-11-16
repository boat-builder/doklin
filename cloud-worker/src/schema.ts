// The D1 database beside the bucket: its schema, and the runner that owns it.
//
// An update ships ONE bundled JS file and no migrations directory, so
// `wrangler d1 migrations apply` is not available to a domain being updated:
// the worker has to migrate itself. It does that from an ordered list of
// steps and a `schema_version` in `meta`, and three properties keep that safe
// when two isolates reach the database at the same moment:
//
//   · Idempotent statements. Every step is `CREATE TABLE IF NOT EXISTS` and
//     `CREATE INDEX IF NOT EXISTS`, so a step that runs twice converges
//     instead of colliding. A table whose shape changes is dropped and made
//     again only when it holds nothing worth keeping. One that does hold
//     something gains a column instead, and only after the step has looked
//     and found it missing: `ALTER TABLE … ADD COLUMN` is not idempotent.
//   · A guarded bump. The version only ever moves with
//     `UPDATE meta SET schema_version = <to> WHERE schema_version = <read>`,
//     so exactly one isolate wins each step and the loser re-reads and finds
//     the work done. A statement that moves *data* cannot lean on being
//     repeatable, so it carries the guard itself: it names the version it
//     migrates from in its own WHERE, and moves nothing once the bump has
//     landed.
//   · A per-isolate flag. `migrated` only goes false → true, so a stale one
//     costs one extra pass over idempotent statements, never a wrong answer.
//
// A step that has shipped is never renumbered or removed: a database stores
// only the number it reached, so a number that changes meaning makes the
// runner skip a step it never ran.
//
// A worker whose `DB` binding is missing or broken still answers the probe
// and reports `d1: null`. Nobody can sign in to it: every credential is a row
// here (members.ts), the superadmin's devices' included, so a database that
// cannot answer is a workspace that is down for everyone until it answers
// again.

import type { Env } from "./env";

type Step = {
  /** The schema version this step produces. */
  to: number;
  /** The tables it creates — what a wipe empties, in this order. One a wipe
   *  leaves, as it leaves `meta`, is made by `sql` and not listed. */
  tables: readonly string[];
  /** Idempotent statements, run in order before the version is bumped. */
  sql: readonly string[];
};

/** Where a database starts once `meta` exists: Doklin's, and empty. */
const BASE_VERSION = 1;

const STEPS: readonly Step[] = [
  {
    // People and the credentials they hold. The separation is the whole
    // point: a *member* is permanent and keyed by their email, so a new Mac
    // re-reaches the same person; a *token* is per-device and disposable; an
    // *invite* is a token that has not been claimed yet. Nothing here stores
    // a code or a token in the clear — every credential table is keyed by
    // the sha256 of the secret, so the database is not a list of credentials.
    //
    // `superadmin` says who the one superadmin is: the person who last proved
    // they control the Cloudflare account, by trading the domain's key
    // (`claimSuperadmin`, members.ts). The CHECK is what makes a second
    // superadmin impossible to write.
    //
    // `spent_keys` remembers each key already traded, by its sha256, so a
    // key works once: a copy left in an agent's chat after setup or a
    // recovery lets nobody in. A wipe leaves it, as it leaves `meta` —
    // otherwise the key a freed domain was set up with would bind it again.
    //
    // `removed_tokens` remembers the credentials an owner took away, by the
    // same sha256 `tokens` held them under. It is what lets the worker tell
    // a Mac "your access was removed" — the one answer that has that Mac
    // delete its copy of the workspace — apart from a token it has merely
    // never heard of (a wiped domain's), which deletes nothing.
    //
    // Who is here, a row per device: an upsert of one row is atomic by
    // itself. Who holds which document, a row per leased path: one atomic
    // upsert is the whole of acquiring, renewing and refusing — the primary
    // key is the lock, and the upsert's WHERE says whose it may be. Both are
    // advisory, lapse by their time rather than by a reaper, and carry the
    // space each row is in. No index on `ts` or `device_id`: each table holds
    // a row per live device or open document, and an index would be a second
    // write on every beat.
    //
    // Agents and the credentials they hold — the same three lifetimes as
    // people, in tables of their own: an agent is not a member (no email,
    // permissions a member does not have, and a token that is only answered
    // on the document API). `scopes` is the permissions, space-separated
    // ("read comment edit"): four fixed words do not earn a table. `host` is
    // what the machine that logged in calls itself — a label for the People
    // view, never authority. `member_id` is the person the agent belongs to,
    // and sees what they see.
    //
    // The search mirror, once per space ('' the shared workspace): one row
    // per document holding its text, lower-cased, so "which documents contain
    // this" is one scan instead of a blob read per document, and a search
    // reads only the text its caller's person may read. `search_state` is the
    // manifest etag each space's mirror was last whole at, and `held` — a
    // JSON map of file id to the content hashes each row was read from.
    // Derived data, all of it: a wipe empties it and the next search fills
    // it again.
    //
    // Spaces: a restricted folder, or one person's Private, is a small
    // workspace of its own stored under `spaces/<id>/` in the bucket, with
    // its own people. The shared workspace is not a row here — it is
    // everything outside that prefix, and everybody's. `spaces.etag` is the
    // space's manifest etag, written by the worker after each write it makes
    // there: it is how one poll says which of a person's spaces moved without
    // a bucket read for each. `addresses` says which space each public
    // address belongs to ('' the shared workspace): the primary key is what
    // makes an address one space's, and it is how the renderer finds a page
    // that is not in the shared workspace's own map.
    to: 9,
    // Children before parents: the wipe walks this list in order, so it
    // empties the tables that reference `members` and `agents` before those
    // themselves, and never leans on whether foreign keys are being enforced.
    tables: [
      "tokens",
      "invites",
      "members",
      "presence",
      "leases",
      "agent_tokens",
      "agent_codes",
      "agents",
      "search_text",
      "search_state",
      "removed_tokens",
      "space_members",
      "addresses",
      "spaces",
      "superadmin",
    ],
    sql: [
      `CREATE TABLE IF NOT EXISTS members (
         id           TEXT PRIMARY KEY,         -- m-xxxxxxxx
         email        TEXT NOT NULL UNIQUE,     -- normalized: trimmed, lowercased
         name         TEXT NOT NULL,
         role         TEXT NOT NULL,            -- 'owner' | 'member'
         created_at   INTEGER NOT NULL,
         last_seen_at INTEGER,                  -- written by the presence beat, not by auth
         disabled     INTEGER NOT NULL DEFAULT 0
       )`,
      `CREATE TABLE IF NOT EXISTS tokens (
         hash        TEXT PRIMARY KEY,          -- sha256(token) — the auth lookup
         id          TEXT NOT NULL,             -- t-xxxxxxxx, what revocation names
         member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
         device_id   TEXT,
         device_name TEXT,
         created_at  INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS tokens_by_member ON tokens(member_id)`,
      `CREATE TABLE IF NOT EXISTS invites (
         hash       TEXT PRIMARY KEY,           -- sha256(code) — never the plaintext
         id         TEXT NOT NULL,              -- i-xxxxxxxx
         member_id  TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
         created_at INTEGER NOT NULL,
         expires_at INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS invites_by_member ON invites(member_id)`,
      `CREATE TABLE IF NOT EXISTS superadmin (
         id        INTEGER PRIMARY KEY CHECK (id = 1),  -- one row, or none
         member_id TEXT NOT NULL                        -- m-xxxxxxxx
       )`,
      `CREATE TABLE IF NOT EXISTS spent_keys (
         hash     TEXT PRIMARY KEY,             -- sha256(key), as it was traded
         spent_at INTEGER NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS removed_tokens (
         hash       TEXT PRIMARY KEY,           -- sha256(token), as the tokens table held it
         removed_at INTEGER NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS presence (
         device_id   TEXT PRIMARY KEY,          -- x-doklin-device
         member_id   TEXT,                      -- the person
         device_name TEXT NOT NULL,
         space_id    TEXT NOT NULL DEFAULT '',  -- the space its path is in; '' the shared workspace
         path        TEXT,                      -- what they are editing, when anything
         ts          INTEGER NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS leases (
         space_id    TEXT NOT NULL DEFAULT '',  -- '' the shared workspace
         path        TEXT NOT NULL,             -- relative to its space, lowercased
         device_id   TEXT NOT NULL,             -- the Mac that holds it
         member_id   TEXT,                      -- whose Mac
         device_name TEXT NOT NULL,
         until       INTEGER NOT NULL,
         PRIMARY KEY (space_id, path)
       )`,
      `CREATE TABLE IF NOT EXISTS agents (
         id           TEXT PRIMARY KEY,         -- a-xxxxxxxx
         name         TEXT NOT NULL,
         scopes       TEXT NOT NULL,            -- 'read comment edit publish', any subset holding 'read'
         created_at   INTEGER NOT NULL,
         last_used_at INTEGER,                  -- moved by a request, at most once an hour
         member_id    TEXT                      -- m-xxxxxxxx: whose agent it is
       )`,
      `CREATE TABLE IF NOT EXISTS agent_codes (
         hash       TEXT PRIMARY KEY,           -- sha256(code) — never the plaintext
         id         TEXT NOT NULL,              -- c-xxxxxxxx
         agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
         created_at INTEGER NOT NULL,
         expires_at INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS agent_codes_by_agent ON agent_codes(agent_id)`,
      `CREATE TABLE IF NOT EXISTS agent_tokens (
         hash       TEXT PRIMARY KEY,           -- sha256(token) — the auth lookup
         id         TEXT NOT NULL,              -- t-xxxxxxxx, what revocation names
         agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
         host       TEXT NOT NULL,
         created_at INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS agent_tokens_by_agent ON agent_tokens(agent_id)`,
      `CREATE TABLE IF NOT EXISTS search_text (
         space_id TEXT NOT NULL,                -- '' the shared workspace
         fid      TEXT NOT NULL,                -- the document's markdown file, or its html when it has no markdown
         folded   TEXT,                         -- lower-cased text, then comment bodies; NULL when too large to hold
         PRIMARY KEY (space_id, fid)
       )`,
      `CREATE TABLE IF NOT EXISTS search_state (
         space_id TEXT PRIMARY KEY,             -- '' the shared workspace
         etag     TEXT NOT NULL,                -- the manifest etag the mirror was last whole at ('' = never)
         held     TEXT NOT NULL                 -- {"<fid>": "<text hash>.<sidecar hash>"} for every row above
       )`,
      `CREATE TABLE IF NOT EXISTS spaces (
         id         TEXT PRIMARY KEY,           -- s-xxxxxxxx a restricted folder; p-xxxxxxxx a Private, after its member's id
         kind       TEXT NOT NULL,              -- 'restricted' | 'private'
         name       TEXT NOT NULL,
         created_by TEXT NOT NULL,              -- m-xxxxxxxx
         created_at INTEGER NOT NULL,
         etag       TEXT NOT NULL               -- its manifest's etag, as of the worker's last write there
       )`,
      `CREATE TABLE IF NOT EXISTS space_members (
         member_id TEXT NOT NULL,
         space_id  TEXT NOT NULL,
         added_by  TEXT NOT NULL,               -- m-xxxxxxxx
         added_at  INTEGER NOT NULL,
         PRIMARY KEY (member_id, space_id)      -- "which spaces is this person in" is the poll's question
       )`,
      `CREATE INDEX IF NOT EXISTS space_members_by_space ON space_members(space_id)`,
      `CREATE TABLE IF NOT EXISTS addresses (
         slug     TEXT PRIMARY KEY,
         space_id TEXT NOT NULL                 -- '' is the shared workspace
       )`,
      `CREATE INDEX IF NOT EXISTS addresses_by_space ON addresses(space_id)`,
    ],
  },
  {
    // What the account may spend and what it has spent (limits.ts).
    // `settings` holds the domain's own choices, a row each: `plan` is which
    // Cloudflare plan the account is on, the superadmin's to say. `usage`
    // holds each credential's own report of its requests today
    // (`x-doklin-used`), a row per token, replaced by the next report and
    // swept the day after. Both are the Cloudflare account's rather than the
    // workspace's, so a wipe leaves them, as it leaves `spent_keys`: the
    // account has spent today what it has, whichever workspace is next.
    //
    // A beat says how long it holds, so a presence row carries when it
    // lapses (`until`). Presence holds only what the last beats wrote, so it
    // is made again with the column: dropping it costs a beat.
    to: 10,
    tables: [],
    sql: [
      `CREATE TABLE IF NOT EXISTS settings (
         key   TEXT PRIMARY KEY,                -- 'plan'
         value TEXT NOT NULL                    -- 'free' | 'paid'
       )`,
      `CREATE TABLE IF NOT EXISTS usage (
         who      TEXT PRIMARY KEY,             -- the token id: a device's, or an agent machine's
         day      INTEGER NOT NULL,             -- the UTC day it counts, floor(ms / 86400000)
         requests INTEGER NOT NULL,             -- its requests that day, as it reported them
         at       INTEGER NOT NULL              -- when the report was written
       )`,
      `DROP TABLE IF EXISTS presence`,
      `CREATE TABLE IF NOT EXISTS presence (
         device_id   TEXT PRIMARY KEY,          -- x-doklin-device
         member_id   TEXT,                      -- the person
         device_name TEXT NOT NULL,
         space_id    TEXT NOT NULL DEFAULT '',  -- the space its path is in; '' the shared workspace
         path        TEXT,                      -- what they are editing, when anything
         ts          INTEGER NOT NULL,          -- the last beat
         until       INTEGER NOT NULL           -- when it lapses: the beat's ttl on from ts
       )`,
    ],
  },
];

/** What a fully migrated database reports. */
export const SCHEMA_VERSION = STEPS.at(-1)?.to ?? BASE_VERSION;

/** Every table the steps list. The wipe empties these and leaves `meta`,
 *  which is the runner's own bookkeeping, and `spent_keys`, `settings` and
 *  `usage`, which are the domain's and its account's rather than anyone's. */
export const DATA_TABLES: readonly string[] = STEPS.flatMap((s) => s.tables);

// Per isolate, not per request: the check costs one round trip the first time
// an isolate needs the database and nothing after that.
let migrated = false;

/**
 * Bring the database up to `SCHEMA_VERSION` and answer the version it is at —
 * or null when this deployment has no `DB` binding, or D1 could not be
 * reached. Every route but the `/api/meta` probe reads null as "no
 * database"; the probe reports it.
 */
export async function ensureSchema(env: Env): Promise<number | null> {
  const db = env.DB;
  if (!db) return null;
  if (migrated) return SCHEMA_VERSION;
  try {
    let version = await bootstrap(db);
    for (const step of STEPS) {
      if (version >= step.to) continue;
      for (const sql of step.sql) await db.prepare(sql).run();
      const bump = await db
        .prepare("UPDATE meta SET schema_version = ? WHERE key = 'schema' AND schema_version = ?")
        .bind(step.to, version)
        .run();
      version = bump.meta.changes === 1 ? step.to : await readVersion(db);
      // Another isolate is mid-migration and holds the step: leave the rest
      // to it rather than racing ahead of a version that hasn't landed.
      if (version < step.to) break;
    }
    migrated = version >= SCHEMA_VERSION;
    return version;
  } catch {
    return null;
  }
}

/**
 * Run something against the migrated database, or answer null: "this
 * deployment has no `DB` binding", "the database could not be migrated" and
 * "the query threw" are one answer, which a route turns into a 503 or into
 * going without — never a 500, and never a route that throws because
 * somebody deleted a database out from under a deployed worker.
 */
export async function withDb<T>(env: Env, fn: (db: D1Database) => Promise<T>): Promise<T | null> {
  const db = env.DB;
  if (!db) return null;
  try {
    if ((await ensureSchema(env)) == null) return null;
    return await fn(db);
  } catch {
    return null;
  }
}

/**
 * The D1 half of the owner's wipe: empty every table a step created,
 * so a rebound domain inherits no ghost members. The schema is brought up
 * first — a wipe of a database nobody has migrated has nothing to delete
 * from — and `meta` survives, since it holds no one's data.
 */
export async function wipeSchema(env: Env): Promise<number | null> {
  const db = env.DB;
  if (!db) return null;
  const version = await ensureSchema(env);
  if (version == null) return null;
  if (DATA_TABLES.length === 0) return version;
  try {
    // The names come from STEPS, never from a request.
    await db.batch(DATA_TABLES.map((t) => db.prepare(`DELETE FROM ${t}`)));
  } catch {
    return null;
  }
  return version;
}

/** `meta` itself, created outside the step list because the runner reads its
 *  own bookkeeping before it can know which steps to run. Both statements are
 *  idempotent, so a second isolate through here changes nothing. */
async function bootstrap(db: D1Database): Promise<number> {
  await db.prepare("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, schema_version INTEGER NOT NULL)").run();
  await db.prepare("INSERT OR IGNORE INTO meta (key, schema_version) VALUES ('schema', ?)").bind(BASE_VERSION).run();
  return readVersion(db);
}

async function readVersion(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT schema_version AS v FROM meta WHERE key = 'schema'").first<{ v: number }>();
  return row ? Number(row.v) : 0;
}
