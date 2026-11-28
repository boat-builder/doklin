// Spaces: one person's My files, or something shared from it.
//
// A space is a small workspace of its own beside Library. Its manifest, its
// blobs and its version history live under `spaces/<id>/` in the bucket, and
// the routes that serve it are Library's own handlers, handed an `Env` whose
// bucket is that prefix (`spaceEnv`).
//
// Spaces are a tree. Its roots are each person's My files: the space
// `p-<their member id's hex>`, made the first time one of their devices asks
// for it (`ensurePrivate`), with one person on it and never another. Every
// other space is a share — a folder, or one document — and sits in the
// section its item is in: a My files, or another share (`spaces.parent`).
// Library holds none.
//
// So there is one question, asked once, before anything under a space
// (`openSpace`): is this person on it, or on anything above it? Whoever can
// open a folder can open what sits in it; `space_members` holds only the
// people a share itself is shared with. Changing who can open something is a
// change to these rows and to nothing else: no file moves.
//
// To anybody who cannot open it — an owner of the workspace included — a
// space does not exist: every route answers what it answers for an id nobody
// ever minted. Somebody a share is shared with, who cannot open the section
// it sits in, is told nothing of where it sits (`parent` is null to them).
//
// A deleted share stays thirty days (`deleted_at`, and sweep.ts): it and
// every share beneath it are marked, nobody opens them, and whoever can open
// the section it sat in can restore it whole.

import type { Auth } from "./auth";
import type { Env } from "./env";
import { MANIFEST_KEY, MY_FILES_FOLDER, spacePrefix } from "./layout";
import { emptyManifest, type Manifest } from "./manifest";
import { withDb } from "./schema";
import type { Space, SpaceKind } from "./wire";
import { META_SUFFIX } from "../../src/metaFile";

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

/** What `spaceEnv` is told of a space: which kind it is, and whether the
 *  caller can open the section it sits in. */
type Opened = Pick<Space, "id" | "kind" | "parent">;

/** The `Env` a space's routes run with: `DATA` is that space alone. */
export function spaceEnv(env: Env, space: Opened): Env {
  const whole = env.SPACE?.whole ?? env.DATA;
  const placed = space.kind === "private" || space.parent !== null;
  return { ...env, DATA: scoped(whole, spacePrefix(space.id)), SPACE: { id: space.id, whole, kind: space.kind, placed } };
}

/** A space's `Env` for work that asks nothing of who is asking: the sweep,
 *  a public page, an owner taking a page down. */
export const spaceStore = (env: Env, id: string): Env => spaceEnv(env, { id, kind: "folder", parent: "" });

/** The section a space sits in, whoever is asking and whether or not it is
 *  deleted. Null for a My files, and for a space that is not there. */
export async function parentIdOf(env: Env, id: string): Promise<string | null> {
  const parent = await withDb(env, (db) => db.prepare("SELECT parent FROM spaces WHERE id = ?").bind(id).first<string>("parent"));
  return parent ?? null;
}

/** A space's part of the bucket, for making or erasing one. */
const bucketOf = (env: Env, id: string): R2Bucket => scoped(env.SPACE?.whole ?? env.DATA, spacePrefix(id));

/** The `Env` of the shared workspace, from whichever one is in hand. */
export function sharedEnv(env: Env): Env {
  if (!env.SPACE) return env;
  const { SPACE, ...rest } = env;
  return { ...rest, DATA: SPACE.whole };
}

/** The space `env` is scoped to; "" is the shared workspace. */
export const spaceOf = (env: Env): string => env.SPACE?.id ?? "";

/** Which kind of section `env` is scoped to. */
export const kindOf = (env: Env): SpaceKind | "library" => env.SPACE?.kind ?? "library";

/** A section of the workspace as somewhere to work: its part of the bucket,
 *  and the folder its paths are under as the caller names them — "" when the
 *  caller names them as the section stores them. */
export type Where = {
  /** "" the shared workspace; a space's id otherwise. */
  space: string;
  mount: string;
  /** For a shared document whose name is taken where its person sees it:
   *  the name it is stored under, and the one it is shown by (mount.ts). */
  named?: { stored: string; shown: string };
  env: Env;
};

/** How many sections beside the shared workspace one request opens: each is
 *  a read or two of the bucket, and a request has a budget of those. A route
 *  that would need more says which it left out. */
export const MAX_SECTIONS_READ = 8;

/* ---------- Reading ---------- */

export type SpaceRow = {
  id: string;
  kind: string;
  name: string;
  created_by: string;
  created_at: number;
  etag: string;
  deleted_at: number | null;
  /** Null when the caller cannot open it. */
  parent: string | null;
  members: string | null;
  above: string | null;
  /** The space at the top of its chain: a My files. */
  root: string | null;
};

/** How deep a chain of shares is followed. */
const MAX_DEPTH = 32;

/** The spaces the caller (?1) can open — the ones they are on, and every
 *  live share beneath those — as the rows of a recursive `open(id)`. For any
 *  statement that asks what somebody may be told (presence.ts). */
export const OPEN_CTE = `open(id) AS (
    SELECT s.id FROM space_members m JOIN spaces s ON s.id = m.space_id
     WHERE m.member_id = ?1 AND s.deleted_at IS NULL
    UNION
    SELECT c.id FROM open o JOIN spaces c ON c.parent = o.id WHERE c.deleted_at IS NULL)`;

const COLUMNS = "s.id, s.kind, s.name, s.created_by, s.created_at, s.etag, s.deleted_at";
const MEMBERS = "(SELECT group_concat(x.member_id) FROM space_members x WHERE x.space_id = s.id) AS members";

/** Every space the caller (their member id, bound as ?1) can open, each with
 *  everyone who can, and the deleted shares they can restore: the ones that
 *  sat in a section they can open. One statement, so the poll can carry it
 *  in the batch it already sends (presence.ts). */
export const SPACES_SQL = `WITH RECURSIVE ${OPEN_CTE},
  listed(id) AS (
    SELECT id FROM open
    UNION ALL
    SELECT d.id FROM open o JOIN spaces d ON d.parent = o.id WHERE d.deleted_at IS NOT NULL),
  up(id, anc) AS (
    SELECT s.id, s.parent FROM listed l JOIN spaces s ON s.id = l.id WHERE s.parent IS NOT NULL
    UNION
    SELECT u.id, a.parent FROM up u JOIN spaces a ON a.id = u.anc WHERE a.parent IS NOT NULL)
SELECT ${COLUMNS},
       CASE WHEN s.parent IN (SELECT id FROM open) THEN s.parent END AS parent,
       ${MEMBERS},
       (SELECT group_concat(DISTINCT x.member_id) FROM up u JOIN space_members x ON x.space_id = u.anc WHERE u.id = s.id) AS above,
       COALESCE((SELECT u.anc FROM up u JOIN spaces a ON a.id = u.anc WHERE u.id = s.id AND a.parent IS NULL), s.id) AS root
  FROM listed l JOIN spaces s ON s.id = l.id
 ORDER BY s.created_at, s.id`;

/** One space (?2) as the caller (?1) sees it, when they are on it or on
 *  anything above it. `via` is the nearest step up at which they are: 0 on
 *  the space itself. */
const ONE_SQL = `WITH RECURSIVE chain(id, parent, n) AS (
    SELECT id, parent, 0 FROM spaces WHERE id = ?2
    UNION ALL
    SELECT s.id, s.parent, c.n + 1 FROM chain c JOIN spaces s ON s.id = c.parent WHERE c.n < ${MAX_DEPTH}),
  mine(n) AS (SELECT c.n FROM chain c JOIN space_members x ON x.space_id = c.id WHERE x.member_id = ?1)
SELECT ${COLUMNS},
       CASE WHEN EXISTS (SELECT 1 FROM mine WHERE n > 0) THEN s.parent END AS parent,
       ${MEMBERS},
       (SELECT group_concat(DISTINCT x.member_id) FROM chain c JOIN space_members x ON x.space_id = c.id WHERE c.n > 0) AS above,
       (SELECT c.id FROM chain c WHERE c.parent IS NULL) AS root
  FROM spaces s
 WHERE s.id = ?2 AND EXISTS (SELECT 1 FROM mine)`;

const ids = (list: string | null): string[] => (list ?? "").split(",").filter(Boolean).sort();

export const toSpace = (r: SpaceRow): Space => {
  const members = ids(r.members);
  return {
    id: r.id,
    kind: r.kind === "private" ? "private" : r.kind === "document" ? "document" : "folder",
    name: r.name,
    by: r.created_by,
    createdAt: Number(r.created_at),
    etag: r.etag,
    parent: r.parent ?? null,
    owner: r.root?.startsWith("p-") ? `m-${r.root.slice(2)}` : "",
    members,
    above: ids(r.above).filter((id) => !members.includes(id)),
    ...(r.deleted_at == null ? {} : { deletedAt: Number(r.deleted_at) }),
  };
};

/** The statement behind `listSpaces`, for a batch of the caller's own. */
export const spacesStatement = (db: D1Database, auth: Auth): D1PreparedStatement =>
  db.prepare(SPACES_SQL).bind(auth.memberId);

/** The spaces the caller can open — their My files once it exists, and the
 *  shares — and the deleted ones they can restore. Null when the database
 *  cannot say. */
export async function listSpaces(env: Env, auth: Auth): Promise<Space[] | null> {
  return withDb(env, async (db) => {
    const { results } = await spacesStatement(db, auth).all<SpaceRow>();
    return results.map(toSpace);
  });
}

/** The live ones of `listSpaces`: what there is to read and to search. */
export async function listOpenSpaces(env: Env, auth: Auth): Promise<Space[] | null> {
  const all = await listSpaces(env, auth);
  return all === null ? null : all.filter((s) => s.deletedAt === undefined);
}

async function readSpace(db: D1Database, auth: Auth, id: string): Promise<Space | null> {
  const row = await db.prepare(ONE_SQL).bind(auth.memberId, id).first<SpaceRow>();
  return row ? toSpace(row) : null;
}

/**
 * The gate. The space, when the caller can open it; "none" when they cannot —
 * which is also the answer for a space that does not exist and for a deleted
 * one, so the three cannot be told apart; null when the database cannot say.
 */
export async function openSpace(env: Env, auth: Auth, id: string): Promise<Space | "none" | null> {
  return withDb(env, async (db) => {
    const space = await readSpace(db, auth, id);
    return space && space.deletedAt === undefined ? space : ("none" as const);
  });
}

/** A deleted share, for whoever can restore it: somebody who can open the
 *  section it sat in. "none" otherwise. */
export async function openDeleted(env: Env, auth: Auth, id: string): Promise<Space | "none" | null> {
  return withDb(env, async (db) => {
    const space = await readSpace(db, auth, id);
    return space && space.deletedAt !== undefined && space.parent !== null ? space : ("none" as const);
  });
}

/* ---------- Making ---------- */

/**
 * A space's empty manifest, create-only, before any row names the space: a
 * space whose rows landed and whose manifest did not could not be synced,
 * and one whose manifest landed alone is a few bytes nobody can reach.
 * Answers its etag, or null when the bucket would not take it.
 */
async function makeManifest(env: Env, id: string, name: string): Promise<string | null> {
  const bucket = bucketOf(env, id);
  const made = await bucket.put(MANIFEST_KEY, JSON.stringify(emptyManifest(name)), {
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  return made?.etag ?? (await bucket.head(MANIFEST_KEY))?.etag ?? null;
}

/**
 * The caller's own My files, made if this is the first time they ask. Asking
 * again changes nothing: the id is the person's, and both rows are
 * insert-or-ignore.
 */
export async function ensurePrivate(env: Env, auth: Auth): Promise<Space | null> {
  return withDb(env, async (db) => {
    const me = auth.memberId;
    const id = `p-${me.slice(2)}`;
    const have = await readSpace(db, auth, id);
    if (have) return have;
    const etag = await makeManifest(env, id, MY_FILES_FOLDER);
    if (etag === null) throw new Error("the bucket refused the manifest");
    const now = Date.now();
    await db.batch([
      db
        .prepare("INSERT OR IGNORE INTO spaces (id, kind, name, created_by, created_at, etag) VALUES (?, 'private', ?, ?, ?, ?)")
        .bind(id, MY_FILES_FOLDER, me, now, etag),
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

/** What a share is made from. The device that makes it mints `id`. */
export type ShareAsk = {
  id: string;
  kind: "folder" | "document";
  name: string;
  /** The section its item sits in — one the caller has opened. */
  parent: Space;
  people: readonly string[];
  /** Run once everything is checked and before the rows are written: what
   *  must be true by the time anybody is told of the share. */
  first?: () => Promise<void>;
};

/**
 * Share a folder or a document: a space in the section its item sits in,
 * with whoever the caller named on it — who must already be people here.
 * The caller is not one of them: they can open the section it sits in, and
 * that is how they open it. `{ unknown }` lists the ids that are not people
 * here, and nothing was made.
 *
 * The same id from its maker again is the same share, with these people
 * added: a device that never heard the first answer asks again. "taken" when
 * the id is anybody else's, or was this person's for something else.
 */
export async function createSpace(env: Env, auth: Auth, ask: ShareAsk): Promise<Space | { unknown: string[] } | "taken" | null> {
  return withDb(env, async (db) => {
    const me = auth.memberId;
    const wanted = [...new Set(ask.people)].filter((id) => id !== me);
    const here = await peopleHere(db, wanted);
    const unknown = wanted.filter((id) => !here.has(id));
    if (unknown.length > 0) return { unknown };

    const now = Date.now();
    const people = wanted.map((person) =>
      db
        .prepare("INSERT OR IGNORE INTO space_members (member_id, space_id, added_by, added_at) VALUES (?, ?, ?, ?)")
        .bind(person, ask.id, me, now),
    );
    const there = await db
      .prepare("SELECT kind, parent, created_by, deleted_at FROM spaces WHERE id = ?")
      .bind(ask.id)
      .first<{ kind: string; parent: string | null; created_by: string; deleted_at: number | null }>();
    if (there) {
      const same = there.created_by === me && there.kind === ask.kind && there.parent === ask.parent.id && there.deleted_at === null;
      if (!same) return "taken" as const;
      await ask.first?.();
      if (people.length > 0) await db.batch(people);
    } else {
      await ask.first?.();
      const etag = await makeManifest(env, ask.id, ask.name);
      if (etag === null) throw new Error("the bucket refused the manifest");
      await db.batch([
        db
          .prepare("INSERT INTO spaces (id, kind, name, created_by, created_at, etag, parent) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .bind(ask.id, ask.kind, ask.name, me, now, etag, ask.parent.id),
        ...people,
      ]);
    }
    const made = await readSpace(db, auth, ask.id);
    if (!made) throw new Error("the space did not land");
    return made;
  });
}

/* ---------- Changing ---------- */

/** Rename a shared folder. The space as it now is. */
export async function renameSpace(env: Env, auth: Auth, space: Space, name: string): Promise<Space | null> {
  return withDb(env, async (db) => {
    await db.prepare("UPDATE spaces SET name = ? WHERE id = ?").bind(name, space.id).run();
    return (await readSpace(db, auth, space.id)) ?? { ...space, name };
  });
}

/** Whether the section `to` is the share `id` itself, or beneath it: a
 *  folder never sits inside itself. Null when the database cannot say. */
export async function isInside(env: Env, to: string, id: string): Promise<boolean | null> {
  return withDb(env, async (db) => {
    const found = await db
      .prepare(
        `WITH RECURSIVE chain(id, parent, n) AS (
           SELECT id, parent, 0 FROM spaces WHERE id = ?1
           UNION ALL
           SELECT s.id, s.parent, c.n + 1 FROM chain c JOIN spaces s ON s.id = c.parent WHERE c.n < ${MAX_DEPTH})
         SELECT 1 AS inside FROM chain WHERE id = ?2`,
      )
      .bind(to, id)
      .first();
    return found !== null;
  });
}

/**
 * Put a share in another section: its item was moved there. `to` is a
 * section the caller has opened, and not one beneath the share (`isInside`).
 * Who can open the share changes with it, and nothing else does: where in
 * that section it sits is the section's manifest's to say (`mounts`).
 */
export async function moveSpace(env: Env, auth: Auth, space: Space, to: Space): Promise<Space | null> {
  return withDb(env, async (db) => {
    await db.prepare("UPDATE spaces SET parent = ?1 WHERE id = ?2").bind(to.id, space.id).run();
    return (await readSpace(db, auth, space.id)) ?? space;
  });
}

/**
 * Share something with one more person. "missing" when that id is not a
 * person here; adding someone already on it changes nothing.
 */
export async function addToSpace(
  env: Env,
  auth: Auth,
  space: Space,
  person: string,
): Promise<Space | "missing" | null> {
  return withDb(env, async (db) => {
    // `SELECT … FROM members` is the check: no row for a person who is not here.
    await db
      .prepare(
        `INSERT OR IGNORE INTO space_members (member_id, space_id, added_by, added_at)
         SELECT id, ?2, ?3, ?4 FROM members WHERE id = ?1 AND disabled = 0`,
      )
      .bind(person, space.id, auth.memberId, Date.now())
      .run();
    const now = await readSpace(db, auth, space.id);
    return now && now.members.includes(person) ? now : ("missing" as const);
  });
}

/**
 * Stop sharing something with a person — anyone on it, themselves included.
 * "above" when they open it because they can open the section it sits in:
 * nothing in a folder is kept from that folder's people. What they had open
 * there stops being theirs in the same batch. A share with nobody left on it
 * stays what it is.
 */
export async function removeFromSpace(
  env: Env,
  space: Space,
  person: string,
): Promise<true | "missing" | "above" | null> {
  if (!space.members.includes(person)) return space.above.includes(person) ? "above" : "missing";
  return withDb(env, async (db) => {
    await db.batch([
      db.prepare("DELETE FROM leases WHERE space_id = ?1 AND member_id = ?2").bind(space.id, person),
      db.prepare("UPDATE presence SET space_id = '', path = NULL WHERE space_id = ?1 AND member_id = ?2").bind(space.id, person),
      db.prepare("DELETE FROM space_members WHERE space_id = ?1 AND member_id = ?2").bind(space.id, person),
    ]);
    return true as const;
  });
}

/** What a shared document is called: its file's name without the extension.
 *  Null for a manifest that holds no document. */
export function documentNameOf(m: Pick<Manifest, "files">): string | null {
  const paths = Object.values(m.files).map((f) => f.path);
  const named = paths.find((p) => !p.toLowerCase().endsWith(META_SUFFIX)) ?? paths[0];
  if (named === undefined) return null;
  const base = named.slice(named.lastIndexOf("/") + 1);
  if (base.toLowerCase().endsWith(META_SUFFIX)) return base.slice(0, -META_SUFFIX.length);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Record where a space's manifest now is — and, for a shared document, what
 * the manifest now calls it: its name is its file's, so it is renamed by a
 * write like any other. `env` is that space's.
 */
export async function noteEtag(env: Env, etag: string, written?: Pick<Manifest, "files">): Promise<void> {
  const id = spaceOf(env);
  if (!id) return;
  const name = written && kindOf(env) === "document" ? documentNameOf(written) : null;
  await withDb(env, (db) =>
    name === null
      ? db.prepare("UPDATE spaces SET etag = ?1 WHERE id = ?2 AND etag <> ?1").bind(etag, id).run()
      : db.prepare("UPDATE spaces SET etag = ?1, name = ?3 WHERE id = ?2 AND (etag <> ?1 OR name <> ?3)").bind(etag, id, name).run(),
  );
}

/* ---------- Deleting ---------- */

/** A share and every share beneath it, as the rows of a recursive `sub(id)`
 *  for the id bound as ?1. */
const SUB_CTE = `WITH RECURSIVE sub(id) AS (
    SELECT ?1
    UNION
    SELECT c.id FROM sub s JOIN spaces c ON c.parent = s.id)`;

/** Whether a space holds anything: a file of its own, or a share. Null when
 *  the bucket or the database cannot say. */
async function holdsAnything(env: Env, db: D1Database, id: string): Promise<boolean | null> {
  const child = await db.prepare("SELECT 1 AS there FROM spaces WHERE parent = ? LIMIT 1").bind(id).first();
  if (child) return true;
  const obj = await bucketOf(env, id).get(MANIFEST_KEY);
  if (!obj) return false;
  try {
    const files = ((await obj.json()) as { files?: unknown } | null)?.files;
    return files !== null && typeof files === "object" && Object.keys(files as object).length > 0;
  } catch {
    return null;
  }
}

/**
 * Delete a share. One that holds something is marked, with every share
 * beneath it, and kept: nobody opens it, and whoever can open the section it
 * sat in can restore it for thirty days (sweep.ts). One that holds nothing —
 * its item was moved out, or it never got one — has nothing to restore and
 * is erased now, batched as `eraseSpace` is: the caller repeats while
 * `remaining`.
 */
export async function deleteSpace(
  env: Env,
  space: Space,
): Promise<{ kept: true } | { kept: false; purged: number; remaining: boolean } | null> {
  const holds = await withDb(env, (db) => holdsAnything(env, db, space.id));
  if (holds === null) return null;
  if (!holds) {
    const erased = await eraseSpace(env, space.id);
    return erased === null ? null : { kept: false, purged: erased.purged, remaining: erased.remaining };
  }
  const marked = await withDb(env, (db) =>
    db.batch([
      db.prepare(`${SUB_CTE} DELETE FROM leases WHERE space_id IN (SELECT id FROM sub)`).bind(space.id),
      db.prepare(`${SUB_CTE} UPDATE presence SET space_id = '', path = NULL WHERE space_id IN (SELECT id FROM sub)`).bind(space.id),
      db
        .prepare(`${SUB_CTE} UPDATE spaces SET deleted_at = ?2 WHERE deleted_at IS NULL AND id IN (SELECT id FROM sub)`)
        .bind(space.id, Date.now()),
    ]),
  );
  return marked === null ? null : { kept: true };
}

/** Bring a deleted share back, with every share that was deleted with it:
 *  its people, what it stored and its addresses are as they were. "orphan"
 *  when the section it sat in is itself deleted. */
export async function restoreSpace(env: Env, auth: Auth, space: Space): Promise<Space | "orphan" | null> {
  return withDb(env, async (db) => {
    const parent = await db
      .prepare("SELECT p.deleted_at AS gone FROM spaces s JOIN spaces p ON p.id = s.parent WHERE s.id = ?")
      .bind(space.id)
      .first<{ gone: number | null }>();
    if (!parent || parent.gone !== null) return "orphan" as const;
    await db
      .prepare(`${SUB_CTE} UPDATE spaces SET deleted_at = NULL WHERE deleted_at = ?2 AND id IN (SELECT id FROM sub)`)
      .bind(space.id, space.deletedAt ?? 0)
      .run();
    return (await readSpace(db, auth, space.id)) ?? "orphan";
  });
}

/**
 * Erase a space and every space beneath it: everything they stored, then
 * their rows. Batched to one request's subrequest budget, the way the wipe
 * is — `calls` is how many it may make to the bucket, `spent` how many it
 * made — and the caller repeats while `remaining`. A space's rows go in the
 * round that empties it, never before: the rows are how the next round
 * finds it.
 */
export async function eraseSpace(
  env: Env,
  id: string,
  calls = 40,
): Promise<{ purged: number; remaining: boolean; spent: number } | null> {
  const whole = env.SPACE?.whole ?? env.DATA;
  const all = await withDb(env, async (db) => {
    const { results } = await db.prepare(`${SUB_CTE} SELECT id FROM sub`).bind(id).all<{ id: string }>();
    return results.map((r) => r.id);
  });
  if (all === null) return null;
  let purged = 0;
  let spent = 0;
  // Beneath first, so a round that stops early leaves nothing without a parent.
  for (const one of all.reverse()) {
    const prefix = spacePrefix(one);
    let empty = false;
    while (!empty && spent + 2 <= calls) {
      const batch = await whole.list({ prefix, limit: 1000 });
      spent += 1;
      const keys = batch.objects.map((o) => o.key);
      if (keys.length > 0) {
        await whole.delete(keys);
        spent += 1;
        purged += keys.length;
      }
      empty = keys.length === 0 || (!batch.truncated && keys.length < 1000);
    }
    if (!empty) return { purged, remaining: true, spent };
    const done = await withDb(env, (db) =>
      db.batch([
        db.prepare("DELETE FROM leases WHERE space_id = ?").bind(one),
        db.prepare("UPDATE presence SET space_id = '', path = NULL WHERE space_id = ?").bind(one),
        db.prepare("DELETE FROM addresses WHERE space_id = ?").bind(one),
        db.prepare("DELETE FROM space_members WHERE space_id = ?").bind(one),
        db.prepare("DELETE FROM spaces WHERE id = ?").bind(one),
      ]),
    );
    if (done === null) return null;
  }
  return { purged, remaining: false, spent };
}
