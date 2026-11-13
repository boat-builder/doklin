// The D1 database beside the bucket: its schema, and the runner that owns it
// (docs/cloud.md §5.1).
//
// An update ships ONE bundled JS file and no migrations directory, so
// `wrangler d1 migrations apply` is not available to a domain being updated:
// the worker has to migrate itself. It does that from an ordered list of
// steps and a `schema_version` in `meta`, and three properties keep that safe
// when two isolates reach a fresh database at the same moment:
//
//   · Idempotent statements. Every step is `CREATE TABLE IF NOT EXISTS` and
//     `CREATE INDEX IF NOT EXISTS`, so a step that runs twice converges
//     instead of colliding.
//   · A guarded bump. The version only ever moves with
//     `UPDATE meta SET schema_version = <to> WHERE schema_version = <to-1>`,
//     so exactly one isolate wins each step and the loser re-reads and finds
//     the work done. A step that ever moves *data* must lean on that
//     `changes == 1` rather than on its statements being repeatable.
//   · A per-isolate flag. `migrated` only goes false → true, so a stale one
//     costs one extra pass over idempotent statements, never a wrong answer.
//
// A worker whose `DB` binding is missing or broken — every domain deployed
// before the binding existed — still serves the whole sync API unchanged and
// reports `d1: null`. What it cannot do is resolve a member's token or
// answer an identity route, because those ARE the database (members.ts);
// the owner's own credential is the env secret and never reads a row, so a
// database that is gone degrades a workspace to one credential rather than
// locking anyone out (docs/cloud.md §5.4).

import type { Env } from "./env";

type Step = {
  /** The schema version this step produces. */
  to: number;
  /** The tables it creates — what a wipe empties (docs/cloud.md §5.7). */
  tables: readonly string[];
  /** Idempotent statements, run in order before the version is bumped. */
  sql: readonly string[];
};

/** Where a database starts once `meta` exists: Doklin's, and empty. */
const BASE_VERSION = 1;

const STEPS: readonly Step[] = [
  {
    // People and the credentials they hold (docs/cloud.md §8.1). The
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
    // Who is here, a row per device (docs/cloud.md §5.3). It used to be one
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
    // Who holds which document (docs/cloud.md §8.2). Keyed by the path, so
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
    // Agents and the credentials they hold (docs/cloud.md §8.3) — the same
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
    // The search mirror (docs/cloud.md §8.5): one row per document holding
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
    // A copy of every board card's properties block (docs/cloud.md §8.4,
    // Boards), so showing a board is one query rather than a blob read per
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
 * The D1 half of the owner's wipe (docs/cloud.md §5.7): empty every table a step created,
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
