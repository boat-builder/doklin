// The D1 database beside the bucket: its schema, and the runner that owns it
// (docs/teams-plan.md §3.5, §4.3).
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
// locking anyone out (§3.2).

import type { Env } from "./env";

type Step = {
  /** The schema version this step produces. */
  to: number;
  /** The tables it creates — what a wipe empties (§4.4). */
  tables: readonly string[];
  /** Idempotent statements, run in order before the version is bumped. */
  sql: readonly string[];
};

/** Where a database starts once `meta` exists: Doklin's, and empty. */
const BASE_VERSION = 1;

const STEPS: readonly Step[] = [
  {
    // People and the credentials they hold (docs/teams-plan.md §3.5). The
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
 * The D1 half of the owner's wipe (§4.4): empty every table a step created,
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
