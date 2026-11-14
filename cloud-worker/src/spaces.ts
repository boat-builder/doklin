// Spaces: a restricted folder, or one person's Private.
//
// A space is a small workspace of its own beside the shared one. Its
// manifest, its blobs and its version history live under `spaces/<id>/` in
// the bucket, and the routes that serve it are the shared workspace's own
// handlers, handed an `Env` whose bucket is that prefix (`spaceEnv`). So
// there is one question, asked once, before anything under it: is this
// person in this space? (`openSpace`).
//
// To anybody who is not in it — an owner included — a space does not exist:
// every route answers what it answers for an id nobody ever minted.
//
// A person's Private is the space `p-<their member id's hex>`, made the first
// time one of their Macs asks for it (`ensurePrivate`). It has one person in
// it and never another.

import type { Auth } from "./auth";
import { randomHex } from "./crypto";
import type { Env } from "./env";
import { MANIFEST_KEY, spacePrefix } from "./layout";
import { emptyManifest } from "./manifest";
import { withDb } from "./schema";

export type SpaceKind = "restricted" | "private";

export type Space = {
  id: string;
  kind: SpaceKind;
  name: string;
  /** Who made it — what tells two folders of one name apart. */
  by: string;
  createdAt: number;
  /** Its manifest's etag as of the worker's last write there (`noteEtag`). */
  etag: string;
  /** Everyone in it, by member id. */
  members: string[];
};

/** What a person's own section is called. */
const PRIVATE_NAME = "Private";

/* ---------- A space's part of the bucket ---------- */

/**
 * The bucket as one space sees it: every key under `prefix`, and a listing
 * that answers keys relative to it. Only the five calls the worker makes.
 */
function scoped(bucket: R2Bucket, prefix: string): R2Bucket {
  const part = {
    head: (key: string) => bucket.head(prefix + key),
    get: (key: string, options?: R2GetOptions) => bucket.get(prefix + key, options),
    put: (key: string, value: Parameters<R2Bucket["put"]>[1], options?: R2PutOptions) =>
      bucket.put(prefix + key, value, options),
    delete: (keys: string | string[]) =>
      bucket.delete(typeof keys === "string" ? prefix + keys : keys.map((key) => prefix + key)),
    list: async (options: R2ListOptions = {}) => {
      const page = await bucket.list({ ...options, prefix: prefix + (options.prefix ?? "") });
      // Field by field: a listed object is not a plain one to spread.
      const objects = page.objects.map((o) => ({
        key: o.key.slice(prefix.length),
        version: o.version,
        size: o.size,
        etag: o.etag,
        httpEtag: o.httpEtag,
        uploaded: o.uploaded,
        httpMetadata: o.httpMetadata,
        customMetadata: o.customMetadata,
      }));
      return { ...page, objects };
    },
  };
  return part as unknown as R2Bucket;
}

/** The `Env` a space's routes run with: `DATA` is that space alone. */
export function spaceEnv(env: Env, id: string): Env {
  const whole = env.SPACE?.whole ?? env.DATA;
  return { ...env, DATA: scoped(whole, spacePrefix(id)), SPACE: { id, whole } };
}

/** The `Env` of the shared workspace, from whichever one is in hand. */
export function sharedEnv(env: Env): Env {
  if (!env.SPACE) return env;
  const { SPACE, ...rest } = env;
  return { ...rest, DATA: SPACE.whole };
}

/** The space `env` is scoped to; "" is the shared workspace. */
export const spaceOf = (env: Env): string => env.SPACE?.id ?? "";

/* ---------- Reading ---------- */

export type SpaceRow = {
  id: string;
  kind: string;
  name: string;
  created_by: string;
  created_at: number;
  etag: string;
  members: string | null;
};

/** The caller as a person, in SQL: their member id (bound as ?1), or — for
 *  the domain's secret, which carries none — the row the `creator` table
 *  names. A creator who never said who they are is nobody, in no space. */
export const CALLER_SQL = "COALESCE(?1, (SELECT member_id FROM creator))";

/** Every space the caller is in, each with everyone in it. One statement, so
 *  the poll can carry it in the batch it already sends (presence.ts). */
export const SPACES_SQL = `SELECT s.id, s.kind, s.name, s.created_by, s.created_at, s.etag,
       (SELECT group_concat(x.member_id) FROM space_members x WHERE x.space_id = s.id) AS members
  FROM space_members mine JOIN spaces s ON s.id = mine.space_id
 WHERE mine.member_id = ${CALLER_SQL}`;

const SPACES_ORDER = " ORDER BY s.kind, s.created_at, s.id";

export const toSpace = (r: SpaceRow): Space => ({
  id: r.id,
  kind: r.kind === "private" ? "private" : "restricted",
  name: r.name,
  by: r.created_by,
  createdAt: Number(r.created_at),
  etag: r.etag,
  members: (r.members ?? "").split(",").filter(Boolean).sort(),
});

/** The statement behind `listSpaces`, for a batch of the caller's own. */
export const spacesStatement = (db: D1Database, auth: Auth): D1PreparedStatement =>
  db.prepare(SPACES_SQL + SPACES_ORDER).bind(auth.memberId);

/** The spaces the caller is in — their Private once it exists, then the
 *  restricted folders. Null when the database cannot say. */
export async function listSpaces(env: Env, auth: Auth): Promise<Space[] | null> {
  return withDb(env, async (db) => {
    const { results } = await spacesStatement(db, auth).all<SpaceRow>();
    return results.map(toSpace);
  });
}

async function readSpace(db: D1Database, auth: Auth, id: string): Promise<Space | null> {
  const row = await db.prepare(`${SPACES_SQL} AND s.id = ?2`).bind(auth.memberId, id).first<SpaceRow>();
  return row ? toSpace(row) : null;
}

/**
 * The gate. The space, when the caller is in it; "none" when they are not —
 * which is also the answer for a space that does not exist, so the two cannot
 * be told apart; null when the database cannot say.
 */
export async function openSpace(env: Env, auth: Auth, id: string): Promise<Space | "none" | null> {
  return withDb(env, async (db) => (await readSpace(db, auth, id)) ?? ("none" as const));
}

/** The caller's member id — for the domain's secret, the creator's row. */
async function callerId(db: D1Database, auth: Auth): Promise<string | null> {
  if (auth.memberId) return auth.memberId;
  return (await db.prepare("SELECT member_id FROM creator").first<string>("member_id")) ?? null;
}

/* ---------- Making ---------- */

/**
 * A space's empty manifest, create-only, before any row names the space: a
 * space whose rows landed and whose manifest did not could not be synced,
 * and one whose manifest landed alone is a few bytes nobody can reach.
 * Answers its etag, or null when the bucket would not take it.
 */
async function makeManifest(env: Env, id: string, name: string): Promise<string | null> {
  const bucket = spaceEnv(env, id).DATA;
  const made = await bucket.put(MANIFEST_KEY, JSON.stringify(emptyManifest(name)), {
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  return made?.etag ?? (await bucket.head(MANIFEST_KEY))?.etag ?? null;
}

/** "nobody": the domain's secret, held by a creator who never said who they
 *  are — there is no person for a space to belong to. */
export type Nobody = "nobody";

/**
 * The caller's own Private, made if this is the first time they ask. Asking
 * again changes nothing: the id is the person's, and both rows are
 * insert-or-ignore.
 */
export async function ensurePrivate(env: Env, auth: Auth): Promise<Space | Nobody | null> {
  return withDb(env, async (db) => {
    const me = await callerId(db, auth);
    if (!me) return "nobody" as const;
    const id = `p-${me.slice(2)}`;
    const have = await readSpace(db, auth, id);
    if (have) return have;
    const etag = await makeManifest(env, id, PRIVATE_NAME);
    if (etag === null) throw new Error("the bucket refused the manifest");
    const now = Date.now();
    await db.batch([
      db
        .prepare("INSERT OR IGNORE INTO spaces (id, kind, name, created_by, created_at, etag) VALUES (?, 'private', ?, ?, ?, ?)")
        .bind(id, PRIVATE_NAME, me, now, etag),
      db
        .prepare("INSERT OR IGNORE INTO space_members (member_id, space_id, added_by, added_at) VALUES (?, ?, ?, ?)")
        .bind(me, id, me, now),
    ]);
    const made = await readSpace(db, auth, id);
    if (!made) throw new Error("the space did not land");
    return made;
  });
}

/** How many ids one `IN (…)` carries: D1 binds at most 100 values a statement. */
const IN_CHUNK = 90;

/** Which of these ids are people here now (not removed). */
async function peopleHere(db: D1Database, ids: readonly string[]): Promise<Set<string>> {
  const here = new Set<string>();
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    const { results } = await db
      .prepare(`SELECT id FROM members WHERE disabled = 0 AND id IN (${chunk.map(() => "?").join(", ")})`)
      .bind(...chunk)
      .all<{ id: string }>();
    for (const r of results) here.add(r.id);
  }
  return here;
}

/**
 * Make a restricted folder: the caller is in it, with whoever they named —
 * who must already be people here. `{ unknown }` lists the ids that are not,
 * and nothing was made.
 */
export async function createSpace(
  env: Env,
  auth: Auth,
  name: string,
  people: readonly string[],
): Promise<Space | Nobody | { unknown: string[] } | null> {
  return withDb(env, async (db) => {
    const me = await callerId(db, auth);
    if (!me) return "nobody" as const;
    const wanted = [...new Set([me, ...people])];
    const here = await peopleHere(db, wanted);
    const unknown = wanted.filter((id) => !here.has(id));
    if (unknown.length > 0) return { unknown };

    const id = `s-${randomHex(4)}`;
    const etag = await makeManifest(env, id, name);
    if (etag === null) throw new Error("the bucket refused the manifest");
    const now = Date.now();
    await db.batch([
      db
        .prepare("INSERT INTO spaces (id, kind, name, created_by, created_at, etag) VALUES (?, 'restricted', ?, ?, ?, ?)")
        .bind(id, name, me, now, etag),
      ...wanted.map((person) =>
        db
          .prepare("INSERT INTO space_members (member_id, space_id, added_by, added_at) VALUES (?, ?, ?, ?)")
          .bind(person, id, me, now),
      ),
    ]);
    const made = await readSpace(db, auth, id);
    if (!made) throw new Error("the space did not land");
    return made;
  });
}

/* ---------- Changing ---------- */

/** Rename a restricted folder. The space as it now is. */
export async function renameSpace(env: Env, auth: Auth, space: Space, name: string): Promise<Space | null> {
  return withDb(env, async (db) => {
    await db.prepare("UPDATE spaces SET name = ? WHERE id = ?").bind(name, space.id).run();
    return (await readSpace(db, auth, space.id)) ?? { ...space, name };
  });
}

/**
 * Add a person to a restricted folder. "missing" when that id is not a
 * person here; adding someone already in it changes nothing.
 */
export async function addToSpace(
  env: Env,
  auth: Auth,
  space: Space,
  person: string,
): Promise<Space | "missing" | null> {
  return withDb(env, async (db) => {
    const me = await callerId(db, auth);
    // `SELECT … FROM members` is the check: no row for a person who is not here.
    await db
      .prepare(
        `INSERT OR IGNORE INTO space_members (member_id, space_id, added_by, added_at)
         SELECT id, ?2, ?3, ?4 FROM members WHERE id = ?1 AND disabled = 0`,
      )
      .bind(person, space.id, me ?? person, Date.now())
      .run();
    const now = await readSpace(db, auth, space.id);
    return now && now.members.includes(person) ? now : ("missing" as const);
  });
}

/**
 * Take a person out of a restricted folder — anyone in it, themselves
 * included. "last" when they are the only one left: a folder is deleted, or
 * handed to somebody, never abandoned by its own people. What they had open
 * there stops being theirs in the same batch.
 */
export async function removeFromSpace(
  env: Env,
  space: Space,
  person: string,
): Promise<true | "missing" | "last" | null> {
  if (!space.members.includes(person)) return "missing";
  return withDb(env, async (db) => {
    // Each statement carries the guard, so a batch that would empty the
    // folder changes nothing at all.
    const others = "(SELECT COUNT(*) FROM space_members WHERE space_id = ?1) > 1";
    const results = await db.batch([
      db.prepare(`DELETE FROM leases WHERE space_id = ?1 AND member_id = ?2 AND ${others}`).bind(space.id, person),
      db
        .prepare(`UPDATE presence SET space_id = '', path = NULL WHERE space_id = ?1 AND member_id = ?2 AND ${others}`)
        .bind(space.id, person),
      db.prepare(`DELETE FROM space_members WHERE space_id = ?1 AND member_id = ?2 AND ${others}`).bind(space.id, person),
    ]);
    return (results.at(-1)?.meta.changes ?? 0) > 0 ? (true as const) : ("last" as const);
  });
}

/** Record where a space's manifest now is. `env` is that space's. */
export async function noteEtag(env: Env, etag: string): Promise<void> {
  const id = spaceOf(env);
  if (!id) return;
  await withDb(env, (db) => db.prepare("UPDATE spaces SET etag = ?1 WHERE id = ?2 AND etag <> ?1").bind(etag, id).run());
}

/* ---------- Deleting ---------- */

/**
 * Delete a restricted folder: everything it stored, then its rows. Batched
 * to one request's subrequest budget, the way the wipe is — the caller
 * repeats while `remaining`. The rows go in the round that finishes, never
 * before: once they are gone nobody is in the space to ask again.
 */
export async function deleteSpace(env: Env, space: Space): Promise<{ purged: number; remaining: boolean } | null> {
  const whole = env.SPACE?.whole ?? env.DATA;
  const prefix = spacePrefix(space.id);
  let purged = 0;
  let empty = false;
  for (let round = 0; round < 20 && !empty; round += 1) {
    const batch = await whole.list({ prefix, limit: 1000 });
    const keys = batch.objects.map((o) => o.key);
    if (keys.length > 0) {
      await whole.delete(keys);
      purged += keys.length;
    }
    empty = keys.length === 0 || (!batch.truncated && keys.length < 1000);
  }
  if (!empty) return { purged, remaining: true };
  const done = await withDb(env, (db) =>
    db.batch([
      db.prepare("DELETE FROM leases WHERE space_id = ?").bind(space.id),
      db.prepare("UPDATE presence SET space_id = '', path = NULL WHERE space_id = ?").bind(space.id),
      db.prepare("DELETE FROM addresses WHERE space_id = ?").bind(space.id),
      db.prepare("DELETE FROM space_members WHERE space_id = ?").bind(space.id),
      db.prepare("DELETE FROM spaces WHERE id = ?").bind(space.id),
    ]),
  );
  return done === null ? null : { purged, remaining: false };
}
