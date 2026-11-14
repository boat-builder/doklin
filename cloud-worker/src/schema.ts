// The D1 database beside the bucket: its schema, and the runner that owns it.
//
// An update ships ONE bundled JS file and no migrations directory, so
// `wrangler d1 migrations apply` is not available to a domain being updated:
// the worker has to migrate itself. It does that from an ordered list of
// steps and a `schema_version` in `meta`, and three properties keep that safe
// when two isolates reach a fresh database at the same moment:
//
//   · Idempotent statements. Every step is `CREATE TABLE IF NOT EXISTS` and
//     `CREATE INDEX IF NOT EXISTS`, so a step that runs twice converges
//     instead of colliding. A table whose shape changes is dropped and made
//     again, and only ever one that holds nothing worth keeping (steps 9 and
//     10). A table that does hold something gains a column instead, and only
//     after the runner has looked and found it missing (`columns`).
//   · A guarded bump. The version only ever moves with
//     `UPDATE meta SET schema_version = <to> WHERE schema_version = <to-1>`,
//     so exactly one isolate wins each step and the loser re-reads and finds
//     the work done. A statement that moves *data* cannot lean on being
//     repeatable, so it carries the guard itself: it names the version it
//     migrates from in its own WHERE (step 7's does), and moves nothing once
//     the bump has landed.
//   · A per-isolate flag. `migrated` only goes false → true, so a stale one
//     costs one extra pass over idempotent statements, never a wrong answer.
//
// A worker whose `DB` binding is missing or broken — every domain deployed
// before the binding existed — still serves the whole sync API unchanged and
// reports `d1: null`. What it cannot do is resolve a member's token or
// answer an identity route, because those ARE the database (members.ts);
// the owner's own credential is the env secret and never reads a row, so a
// database that is gone degrades a workspace to one credential rather than
// locking anyone out.

import type { Env } from "./env";

type Step = {
  /** The schema version this step produces. */
  to: number;
  /** The tables it creates — what a wipe empties. */
  tables: readonly string[];
  /** Columns it adds to tables an earlier step made, each only when the
   *  table does not have it yet. Added before `sql` runs. */
  columns?: readonly { table: string; column: string; type: string }[];
  /** Idempotent statements, run in order before the version is bumped. */
  sql: readonly string[];
};

/** Where a database starts once `meta` exists: Doklin's, and empty. */
const BASE_VERSION = 1;

const STEPS: readonly Step[] = [
  {
    // People and the credentials they hold. The
    // separation is the whole point: a *member* is permanent and keyed by
    // their email, so a new Mac re-reaches the same person; a *token* is
    // per-device and disposable; an *invite* is a token that has not been
    // claimed yet. Nothing here stores a code or a token in the clear —
    // both tables are keyed by the sha256 of the secret, so the database is
    // not a list of credentials.
    to: 2,
    // Children before parents: the wipe walks this list in order, so it
    // empties the tables that reference `members` before `members` itself
    // and never leans on whether foreign keys are being enforced.
    tables: ["tokens", "invites", "members"],
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
    ],
  },
  {
    // Who is here, a row per device. It used to be one
    // shared R2 object read, mutated and written back with no CAS — two beats
    // landing together lost one, and every beat was a Class A write. A row
    // per device, upserted, is atomic by itself.
    //
    // `member_id` is nullable: an owner who never adopted an identity is here
    // all the same, as their Mac's name.
    // No index on `ts`: the table holds one row per live device, every read
    // filters by the TTL, and an index would be a second write on every beat.
    to: 3,
    tables: ["presence"],
    sql: [
      `CREATE TABLE IF NOT EXISTS presence (
         device_id   TEXT PRIMARY KEY,          -- x-doklin-device
         member_id   TEXT,                      -- the person; null for an owner nobody named
         device_name TEXT NOT NULL,
         path        TEXT,                      -- what they are editing, when anything
         ts          INTEGER NOT NULL
       )`,
    ],
  },
  {
    // Who holds which document. Keyed by the path, so
    // one atomic upsert is the whole of acquiring, renewing and refusing: the
    // primary key is the lock, and the upsert's WHERE says whose it may be.
    //
    // Advisory, always — nothing on the sync path reads this table. Like
    // `presence`, a lease lapses by its `until` rather than by a reaper, and
    // `member_id` is nullable for the same owner nobody named. No index on
    // `device_id`: the table holds one row per document somebody has open,
    // and an index would be a second write on every renewal.
    to: 4,
    tables: ["leases"],
    sql: [
      `CREATE TABLE IF NOT EXISTS leases (
         path        TEXT PRIMARY KEY,          -- workspace-relative, lowercased
         device_id   TEXT NOT NULL,             -- the Mac that holds it
         member_id   TEXT,                      -- whose Mac; null for an owner nobody named
         device_name TEXT NOT NULL,
         until       INTEGER NOT NULL
       )`,
    ],
  },
  {
    // Agents and the credentials they hold — the same
    // three lifetimes as people, in tables of their own: an agent is not a
    // member (no email, permissions a member does not have, and a token that
    // is only answered on the document API). Both secrets are stored as their
    // sha256, exactly as a person's are.
    //
    // `scopes` is the permissions, space-separated ("read comment edit"):
    // four fixed words do not earn a table. `host` is what the machine that
    // logged in calls itself — a label for the People view, never authority.
    to: 5,
    tables: ["agent_tokens", "agent_codes", "agents"],
    sql: [
      `CREATE TABLE IF NOT EXISTS agents (
         id           TEXT PRIMARY KEY,         -- a-xxxxxxxx
         name         TEXT NOT NULL,
         scopes       TEXT NOT NULL,            -- 'read comment edit publish', any subset holding 'read'
         created_at   INTEGER NOT NULL,
         last_used_at INTEGER,                  -- moved by a request, at most once an hour
         disabled     INTEGER NOT NULL DEFAULT 0
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
    ],
  },
  {
    // The search mirror: one row per document holding
    // its text, lower-cased, so "which documents contain this" is one scan in
    // the database instead of a blob read per document. Keyed by file id, so
    // a move or a rename costs it nothing.
    //
    // `search_state` is one row: the manifest etag the mirror was last whole
    // at, and `held` — a JSON map of file id to the content hashes each row
    // was read from. Finding what is stale is then one row read and a diff
    // against the manifest, not a scan of every row.
    //
    // Derived data, all of it: a wipe empties it and the next search fills
    // it again.
    to: 6,
    tables: ["search_text", "search_state"],
    sql: [
      `CREATE TABLE IF NOT EXISTS search_text (
         fid    TEXT PRIMARY KEY,               -- the document's markdown file, or its html when it has no markdown
         folded TEXT                            -- lower-cased text, then comment bodies; NULL when too large to hold
       )`,
      `CREATE TABLE IF NOT EXISTS search_state (
         key  TEXT PRIMARY KEY,                 -- 'mirror'
         etag TEXT NOT NULL,                    -- the manifest etag the mirror was last whole at ('' = never)
         held TEXT NOT NULL                     -- {"<fid>": "<text hash>.<sidecar hash>"} for every row above
       )`,
    ],
  },
  {
    // A copy of every board card's properties block, so showing a board is one query rather than a blob read per
    // card. Keyed by file id, with the content hash the block was read from:
    // a row whose hash is not the manifest's is stale, and read again. A
    // card removed on a Mac leaves its row behind until a wipe — a few
    // hundred bytes, never a wrong answer, since a board only asks for the
    // cards its manifest holds.
    to: 7,
    tables: ["board_cards"],
    sql: [
      `CREATE TABLE IF NOT EXISTS board_cards (
         fid  TEXT PRIMARY KEY,                 -- the card's markdown file
         hash TEXT NOT NULL,                    -- the content hash its block was read from
         head TEXT NOT NULL                     -- the frontmatter block, fences included; '' for none
       )`,
    ],
  },
  {
    // Roles as data. Until here `members.role`
    // was a label and a token always authenticated as a member; from here a
    // token carries the role on its person's row, so there can be several
    // owners, and two things that used to be implied need saying.
    //
    // `creator` says which person holds the domain's env secret. It used to
    // be "the one row whose role is owner"; with several owners that no
    // longer picks anybody out. One row or none — the CHECK is what makes a
    // second creator impossible to write.
    //
    // `removed_tokens` remembers the credentials an owner took away, by the
    // same sha256 `tokens` held them under. It is what lets the worker tell
    // a Mac "your access was removed" — the one answer that has that Mac
    // delete its copy of the workspace — apart from a token it has merely
    // never heard of (a wiped domain, a rotated secret, a database that
    // cannot answer), which deletes nothing.
    to: 8,
    tables: ["creator", "removed_tokens"],
    sql: [
      `CREATE TABLE IF NOT EXISTS creator (
         id        INTEGER PRIMARY KEY CHECK (id = 1),  -- one row, or none
         member_id TEXT NOT NULL                        -- m-xxxxxxxx: who holds the env secret
       )`,
      // One-time move of stored data: before this step exactly one row could
      // carry the owner role, and it was the creator's. Guarded by the
      // version it migrates from, so an isolate that runs it after the bump
      // — when somebody may already have been promoted — moves nothing.
      `INSERT OR IGNORE INTO creator (id, member_id)
         SELECT 1, id FROM members
          WHERE role = 'owner' AND (SELECT schema_version FROM meta WHERE key = 'schema') < 8
          ORDER BY created_at, id LIMIT 1`,
      `CREATE TABLE IF NOT EXISTS removed_tokens (
         hash       TEXT PRIMARY KEY,           -- sha256(token), as the tokens table held it
         removed_at INTEGER NOT NULL
       )`,
    ],
  },
  {
    // Spaces: a restricted folder, or one person's Private, is a small
    // workspace of its own stored under `spaces/<id>/` in the bucket, with
    // its own people. The shared workspace is not a row here — it is
    // everything outside that prefix, and everybody's.
    //
    // `etag` is the space's manifest etag, written by the worker after each
    // write it makes there: it is how one poll says which of a person's
    // spaces moved without a bucket read for each.
    //
    // `addresses` says which space each public address belongs to ('' the
    // shared workspace). The primary key is what makes an address one
    // space's, and it is how the renderer finds a page that is not in the
    // shared workspace's own map.
    //
    // Presence and leases are made again with the space each row is in:
    // a lease is now one document in one space. Both hold only what the
    // last minute and a half wrote, so dropping them costs a beat.
    to: 9,
    tables: ["space_members", "addresses", "spaces"],
    sql: [
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
      `DROP TABLE IF EXISTS presence`,
      `CREATE TABLE IF NOT EXISTS presence (
         device_id   TEXT PRIMARY KEY,          -- x-doklin-device
         member_id   TEXT,                      -- the person; null for a creator nobody named
         device_name TEXT NOT NULL,
         space_id    TEXT NOT NULL DEFAULT '',  -- the space its path is in; '' the shared workspace
         path        TEXT,                      -- what they are editing, when anything
         ts          INTEGER NOT NULL
       )`,
      `DROP TABLE IF EXISTS leases`,
      `CREATE TABLE IF NOT EXISTS leases (
         space_id    TEXT NOT NULL DEFAULT '',  -- '' the shared workspace
         path        TEXT NOT NULL,             -- relative to its space, lowercased
         device_id   TEXT NOT NULL,             -- the Mac that holds it
         member_id   TEXT,                      -- whose Mac; null for a creator nobody named
         device_name TEXT NOT NULL,
         until       INTEGER NOT NULL,
         PRIMARY KEY (space_id, path)
       )`,
    ],
  },
  {
    // An agent belongs to a person, and sees what that person sees.
    // `agents.member_id` is whose it is. NULL is the creator's — whoever
    // holds the domain's secret, whether or not they have said who they are
    // — which is what every agent made before this step is, with nothing to
    // move: the creator was the only one who could make them.
    //
    // The search mirror is kept once per space ('' the shared workspace), so
    // a search reads only the text its caller's person may read. Both tables
    // are derived: dropped here, and filled again by the next search.
    to: 10,
    tables: [],
    columns: [{ table: "agents", column: "member_id", type: "TEXT" }],
    sql: [
      `DROP TABLE IF EXISTS search_text`,
      `CREATE TABLE IF NOT EXISTS search_text (
         space_id TEXT NOT NULL,                -- '' the shared workspace
         fid      TEXT NOT NULL,                -- the document's markdown file, or its html when it has no markdown
         folded   TEXT,                         -- lower-cased text, then comment bodies; NULL when too large to hold
         PRIMARY KEY (space_id, fid)
       )`,
      `DROP TABLE IF EXISTS search_state`,
      `CREATE TABLE IF NOT EXISTS search_state (
         space_id TEXT PRIMARY KEY,             -- '' the shared workspace
         etag     TEXT NOT NULL,                -- the manifest etag the mirror was last whole at ('' = never)
         held     TEXT NOT NULL                 -- {"<fid>": "<text hash>.<sidecar hash>"} for every row above
       )`,
    ],
  },
];

/** What a fully migrated database reports. */
export const SCHEMA_VERSION = STEPS.at(-1)?.to ?? BASE_VERSION;

/** Every table the steps create. The wipe empties these and leaves `meta`,
 *  which is the runner's own bookkeeping rather than anyone's data. */
export const DATA_TABLES: readonly string[] = STEPS.flatMap((s) => s.tables);

// Per isolate, not per request: the check costs one round trip the first time
// an isolate needs the database and nothing after that.
let migrated = false;

/**
 * Bring the database up to `SCHEMA_VERSION` and answer the version it is at —
 * or null when this deployment has no `DB` binding, or D1 could not be
 * reached. Callers read null as "no database": in this phase that is every
 * route but the `/api/meta` probe, which reports it.
 */
export async function ensureSchema(env: Env): Promise<number | null> {
  const db = env.DB;
  if (!db) return null;
  if (migrated) return SCHEMA_VERSION;
  try {
    let version = await bootstrap(db);
    for (const step of STEPS) {
      if (version >= step.to) continue;
      for (const c of step.columns ?? []) await ensureColumn(db, c.table, c.column, c.type);
      for (const sql of step.sql) await db.prepare(sql).run();
      const bump = await db
        .prepare("UPDATE meta SET schema_version = ? WHERE key = 'schema' AND schema_version = ?")
        .bind(step.to, step.to - 1)
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
 * Add a column to a table that holds something worth keeping — when it is
 * not there. Reading the column is the question: it fails on a table without
 * it, whatever the table holds. Two isolates that both find it missing both
 * add it, and the loser's failure is not one: the column is there.
 */
async function ensureColumn(db: D1Database, table: string, column: string, type: string): Promise<void> {
  // The names come from STEPS, never from a request.
  const there = async (): Promise<boolean> => {
    try {
      await db.prepare(`SELECT ${column} FROM ${table} LIMIT 1`).first();
      return true;
    } catch {
      return false;
    }
  };
  if (await there()) return;
  try {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
  } catch (e) {
    if (!(await there())) throw e;
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
