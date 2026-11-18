// People, and the credentials they hold.
//
// The shape everything here rests on: an *identity* is not a *credential*.
//
//   member   permanent, one row per person, keyed by their normalized email.
//            What the manifest, presence and leases name. Survives every
//            Mac they ever use — lose the laptop, get invited again, same row
//            — and survives being removed: the row is marked `disabled`, so
//            their name stays on what they wrote and inviting the address
//            again is the same person.
//   token    one per device, disposable, 256 bits. Stored only as
//            sha256(token): the database is not a list of credentials, and
//            revoking one is deleting one row.
//   invite   a token that has not been claimed yet. Stored only as
//            sha256(code), one-time, and deleted the moment it is redeemed or
//            found expired — no cron trigger, no reaper.
//
// A person's role is data: `members.role`, read off the row their token
// resolves to, so there can be several owners and one of them can make
// another (roles.ts says what each role may do). One person is more: the
// superadmin, whom the one-row `superadmin` table names. Their row is never
// removed or made a member, and only they sign out a device of theirs.
//
// The superadmin is whoever last traded the domain's key (`claimSuperadmin`):
// the env secret `OWNER_TOKEN`, which only somebody who controls the
// Cloudflare account can set. The key is never a sign-in. Trading it makes a
// device token like any other, on the superadmin's row, and spends it —
// `spent_keys` remembers it, so the same key never works twice.

import { randomHex, sha256Hex } from "./crypto";
import type { Env } from "./env";
import { MAX_EMAIL_LEN, MAX_NAME_LEN, validName } from "./layout";
import type { PersonRole } from "./roles";
import { withDb } from "./schema";
import type { DirectoryEntry } from "./wire";

export type Member = {
  id: string;
  email: string;
  name: string;
  /** `superadmin` for the one row the `superadmin` table names; otherwise
   *  the role on the row. */
  role: PersonRole;
  createdAt: number;
  /** When a Mac of theirs last beat, to the hour — and, before any has, when
   *  they first traded a code in. Null means nobody has ever signed in as
   *  them: the row is an invitation, not yet a person with anything to keep. */
  lastSeenAt: number | null;
};

/** A member plus how many devices they are signed in on — the People list. */
export type MemberWithDevices = Member & { devices: number };

/** What `members.role` itself holds: superadmin is a row of its own table. */
type StoredRole = Exclude<PersonRole, "superadmin">;

/**
 * What a bearer resolves to when it is a person's token: who they are, and
 * the role on their row. The role is read on every
 * request, so making someone an owner — or a member again — takes effect on
 * their very next call, exactly as a revocation does.
 */
export type TokenIdentity = {
  tokenId: string;
  memberId: string;
  email: string;
  name: string;
  role: PersonRole;
};

/** One signed-in device: a Mac, an iPhone. Its `id` is its token's. */
export type Device = {
  id: string;
  memberId: string;
  email: string;
  deviceId: string | null;
  deviceName: string | null;
  createdAt: number;
};

export type Invite = {
  id: string;
  memberId: string;
  email: string;
  name: string;
  createdAt: number;
  expiresAt: number;
};

/** An invite may be dated this far out and no further — a year of "pending" is
 *  not a pending invite, it is a credential nobody is watching. */
export const MAX_INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A device code is pasted on the device beside the one that made it, so the
 *  app dates it an hour out (engine/src/cloud/invite.rs,
 *  `DEVICE_CODE_MINUTES`); the ceiling is looser only to absorb a clock that
 *  is wrong. */
export const MAX_DEVICE_CODE_TTL_MS = 24 * 60 * 60 * 1000;

/* ---------- Normalizing what people type ---------- */

/**
 * The email as the `UNIQUE` column stores it: trimmed and lowercased, so
 * " Ada@Example.com " and "ada@example.com" are one person. Null when it is
 * not an address at all. The check is deliberately loose — a strict pattern
 * rejects addresses that work — it only insists on the shape a mailbox has:
 * something, one @, something with a dot, and no whitespace.
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_LEN) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/** A sha256 hex digest, as the two hashed columns store one. */
export const HASH_RE = /^[a-f0-9]{64}$/;

/** The ids this module mints: `m-` a member (`MEMBER_ID_RE`, layout.ts),
 *  `t-` a token, `i-` an invite. */
export const ENTITY_ID_RE = /^[mti]-[a-f0-9]{8}$/;

type MemberRow = {
  id: string;
  email: string;
  name: string;
  /** The role as `MEMBER_COLS` reads it: superadmin first. */
  role: string;
  created_at: number;
  last_seen_at: number | null;
  disabled: number;
};

/** A person's role in SQL, over a members row aliased `m`: superadmin when
 *  the `superadmin` table names it, else what the row holds. */
const ROLE_SQL = `CASE WHEN EXISTS (SELECT 1 FROM superadmin s WHERE s.member_id = m.id) THEN 'superadmin' ELSE m.role END`;

/** A member's columns, with the role as `ROLE_SQL` reads it. */
const MEMBER_COLS = `m.id AS id, m.email AS email, m.name AS name, ${ROLE_SQL} AS role,
                m.created_at AS created_at, m.last_seen_at AS last_seen_at, m.disabled AS disabled`;

/** Rows a statement may change, over a members row's id: not the superadmin's. */
const NOT_SUPERADMIN = "NOT IN (SELECT member_id FROM superadmin)";

const toRole = (raw: string): PersonRole => (raw === "superadmin" || raw === "owner" ? raw : "member");

const toMember = (r: MemberRow): Member => ({
  id: r.id,
  email: r.email,
  name: r.name,
  role: toRole(r.role),
  createdAt: Number(r.created_at),
  lastSeenAt: r.last_seen_at == null ? null : Number(r.last_seen_at),
});

const memberId = (): string => `m-${randomHex(4)}`;

/* ---------- Authenticating a member ---------- */

/**
 * Resolve a bearer's sha256 to the person behind it: one row read on the
 * tokens primary key, joined to their member row. A disabled member is no
 * one — the column would otherwise be a claim the worker does not keep.
 *
 * Deliberately NOT written here: `last_seen_at`. A write on every request is
 * 57,600 writes a day for ten Macs; the presence beat carries it instead,
 * at most once an hour per person (presence.ts), after the redeem that first
 * sets it.
 */
export async function resolveToken(env: Env, bearerHash: string): Promise<TokenIdentity | "nobody" | null> {
  // Null is a database that could not answer, which is not "nobody": the
  // caller says the domain is unavailable rather than that the token is bad.
  return withDb(env, async (db) => {
    const row = await db
      .prepare(
        `SELECT t.id AS token_id, m.id AS member_id, m.email, m.name, ${ROLE_SQL} AS role
           FROM tokens t JOIN members m ON m.id = t.member_id
          WHERE t.hash = ? AND m.disabled = 0`,
      )
      .bind(bearerHash)
      .first<{ token_id: string; member_id: string; email: string; name: string; role: string }>();
    if (!row) return "nobody" as const;
    return {
      tokenId: row.token_id,
      memberId: row.member_id,
      email: row.email,
      name: row.name,
      role: toRole(row.role),
    };
  });
}

/**
 * Whether this bearer is a credential an owner took away — a person removed,
 * or one of their Macs signed out. Asked only once a bearer has resolved to
 * nobody, so it costs a request that was going to be refused anyway.
 *
 * The answer is what a Mac acts on by deleting its copy of the workspace
 * outright, so it has to be a fact the database states, never an
 * inference: a database that cannot answer says `false`, and so does a token
 * this domain has simply never heard of.
 */
export async function isRemovedToken(env: Env, bearerHash: string): Promise<boolean> {
  const removed = await withDb(env, async (db) => {
    const row = await db.prepare("SELECT 1 AS gone FROM removed_tokens WHERE hash = ?").bind(bearerHash).first();
    return row !== null;
  });
  return removed === true;
}

/* ---------- Members ---------- */

/** Everyone here, with how many devices they hold — a removed person is not
 *  among them. Newest last, so whoever set the workspace up leads the list. */
export async function listMembers(env: Env): Promise<MemberWithDevices[] | null> {
  return withDb(env, async (db) => {
    const { results } = await db
      .prepare(
        `SELECT ${MEMBER_COLS}, (SELECT COUNT(*) FROM tokens t WHERE t.member_id = m.id) AS devices
           FROM members m WHERE m.disabled = 0 ORDER BY m.created_at, m.id`,
      )
      .all<MemberRow & { devices: number }>();
    return results.map((r) => ({ ...toMember(r), devices: Number(r.devices) }));
  });
}

/**
 * Everyone's id and display name, and nothing else — what a `by` in the
 * manifest is read with. People first, then agents: an
 * agent signs what it changes with its own `a-` id (agents.ts), and a Mac has
 * to be able to put a name to that as well — and, as `person`, whose agent
 * it is, so an app can say "Maya's Research agent" to everyone in the
 * workspace. A removed person is still listed: what they wrote keeps their
 * name.
 *
 * It is served by `GET /api/meta`, the route every engine already asks, so
 * putting a name to an id never costs a request of its own. The People list
 * proper — addresses, roles, device counts — is `GET /api/auth/members`, and
 * an agent's permissions and machines stay with whoever may manage agents.
 */
export async function listDirectory(env: Env): Promise<DirectoryEntry[] | null> {
  return withDb(env, async (db) => {
    const { results } = await db
      .prepare(
        `SELECT id, name, person FROM (
           SELECT id, name, NULL AS person, 0 AS kind, created_at FROM members
           UNION ALL
           SELECT id, name, member_id AS person, 1 AS kind, created_at FROM agents
         ) ORDER BY kind, created_at, id`,
      )
      .all<{ id: string; name: string; person: string | null }>();
    return results.map((r) => (r.person ? { id: r.id, name: r.name, person: r.person } : { id: r.id, name: r.name }));
  });
}

/** Who the superadmin is, by id and name — what `GET /api/meta` tells
 *  everyone, so the app can say whom to ask. Null when there is none yet, or
 *  the database cannot say. */
export async function findSuperadmin(env: Env): Promise<{ id: string; name: string } | null> {
  return withDb(env, (db) =>
    db
      .prepare("SELECT m.id AS id, m.name AS name FROM members m JOIN superadmin s ON s.member_id = m.id")
      .first<{ id: string; name: string }>(),
  ).then((v) => v ?? null);
}

/**
 * The member for this email, created if this is the first time it has been
 * seen. A name that comes with it wins, so re-inviting someone is also how
 * they get renamed; the role of an existing row is left alone, because
 * inviting an owner must not demote them. A removed person's row is here
 * again: the same person, a member, with the Private they had.
 */
export async function upsertMember(
  env: Env,
  email: string,
  name: string | null,
  role: StoredRole,
): Promise<Member | null> {
  // A name that was actually supplied, or null. The distinction matters on
  // the conflict branch: re-inviting Ada without typing her name again must
  // not rename her to "ada", so an absent name leaves the row's own alone.
  const given = typeof name === "string" && name.trim() ? name.trim().slice(0, MAX_NAME_LEN) : null;
  return withDb(env, async (db) => {
    const row = await db
      .prepare(
        `INSERT INTO members (id, email, name, role, created_at, last_seen_at, disabled)
         VALUES (?, ?, ?, ?, ?, NULL, 0)
         ON CONFLICT(email) DO UPDATE SET name = COALESCE(?, members.name), disabled = 0
         RETURNING id`,
      )
      .bind(memberId(), email, given ?? validName(null, email.split("@")[0] || "Member"), role, Date.now(), given)
      .first<{ id: string }>();
    return row ? readMember(db, row.id) : null;
  });
}

async function readMember(db: D1Database, id: string): Promise<Member | null> {
  const row = await db.prepare(`SELECT ${MEMBER_COLS} FROM members m WHERE m.id = ?`).bind(id).first<MemberRow>();
  return row ? toMember(row) : null;
}

/** The person with this id, unless they were removed. */
async function readHere(db: D1Database, id: string): Promise<Member | null> {
  const row = await db
    .prepare(`SELECT ${MEMBER_COLS} FROM members m WHERE m.id = ? AND m.disabled = 0`)
    .bind(id)
    .first<MemberRow>();
  return row ? toMember(row) : null;
}

/** The person at this (normalized) address, if the workspace has a row for
 *  one — here now, or removed. `undefined` when the database cannot answer,
 *  which is not "nobody". */
export async function findMemberByEmail(env: Env, email: string): Promise<Member | null | undefined> {
  const found = await withDb(env, async (db) => {
    const row = await db.prepare(`SELECT ${MEMBER_COLS} FROM members m WHERE m.email = ?`).bind(email).first<MemberRow>();
    return { member: row ? toMember(row) : null };
  });
  return found === null ? undefined : found.member;
}

/** What trading the domain's key can come to besides a sign-in: the key
 *  was traded before. */
export type ClaimRefusal = "spent";

/**
 * Trade the domain's key for a device sign-in as the superadmin — how a
 * workspace gets its first device, and the way back in for whoever controls
 * the Cloudflare account after every device is lost.
 *
 * `email` names who is at the keyboard, and makes THEM the superadmin:
 * setting the key proved they control the account the workspace is stored
 * on, and that is what the role is. The person they replace keeps the owner role on
 * their row. A person removed before is here again, an owner.
 *
 * The key is spent in the same batch, first: of two trades racing with one
 * key, the second's batch fails on the primary key and writes nothing.
 */
export async function claimSuperadmin(
  env: Env,
  keyHash: string,
  email: string,
  name: string | null,
  deviceId: string | null,
  deviceName: string | null,
  now = Date.now(),
): Promise<Redeemed | ClaimRefusal | null> {
  const given = typeof name === "string" && name.trim() ? name.trim().slice(0, MAX_NAME_LEN) : null;
  return withDb(env, async (db) => {
    if (await db.prepare("SELECT 1 AS spent FROM spent_keys WHERE hash = ?").bind(keyHash).first()) {
      return "spent" as const;
    }
    const token = randomHex(32);
    const tokenId = `t-${randomHex(4)}`;
    await db.batch([
      db.prepare("INSERT INTO spent_keys (hash, spent_at) VALUES (?, ?)").bind(keyHash, now),
      db
        .prepare(
          `INSERT INTO members (id, email, name, role, created_at, last_seen_at, disabled)
           VALUES (?1, ?2, ?3, 'owner', ?4, ?4, 0)
           ON CONFLICT(email) DO UPDATE SET name = COALESCE(?5, members.name), role = 'owner', disabled = 0,
                                            last_seen_at = COALESCE(members.last_seen_at, ?4)`,
        )
        .bind(memberId(), email, given ?? validName(null, email.split("@")[0] || "Member"), now, given),
      db
        .prepare(
          `INSERT INTO superadmin (id, member_id) SELECT 1, id FROM members WHERE email = ?
           ON CONFLICT(id) DO UPDATE SET member_id = excluded.member_id`,
        )
        .bind(email),
      db
        .prepare(
          `INSERT INTO tokens (hash, id, member_id, device_id, device_name, created_at)
           SELECT ?, ?, id, ?, ?, ? FROM members WHERE email = ?`,
        )
        .bind(await sha256Hex(token), tokenId, deviceId, validName(deviceName, "A device"), now, email),
    ]);
    const row = await db.prepare(`SELECT ${MEMBER_COLS} FROM members m WHERE m.email = ?`).bind(email).first<MemberRow>();
    if (!row) throw new Error("the superadmin's row did not land");
    return { token, tokenId, member: toMember(row) };
  });
}

/** What changing a role, or removing a person, can come to besides done:
 *  nobody has that id, or the row is the superadmin's and stays as it is. */
export type Refusal = "missing" | "superadmin";

/**
 * Make someone an owner, or a member again. Their tokens carry the new role
 * on their next request — it is read off this row every time. The
 * superadmin's row is refused: the role moves only by trading the key.
 */
export async function setMemberRole(env: Env, id: string, role: StoredRole): Promise<Member | Refusal | null> {
  return withDb(env, async (db) => {
    const results = await db.batch([
      // An owner who stops being one may have made codes for anybody, and
      // kept them: every code nobody has used yet is withdrawn with the
      // role, so none of them outlives it (see `removeMember`).
      db
        .prepare(
          `DELETE FROM invites
            WHERE ?1 = 'member'
              AND EXISTS (SELECT 1 FROM members WHERE id = ?2 AND role = 'owner' AND disabled = 0
                             AND id ${NOT_SUPERADMIN})`,
        )
        .bind(role, id),
      db
        .prepare(
          `UPDATE members SET role = ?1 WHERE id = ?2 AND disabled = 0 AND id ${NOT_SUPERADMIN}`,
        )
        .bind(role, id),
    ]);
    const member = await readHere(db, id);
    if (!member) return "missing" as Refusal;
    return (results.at(-1)?.meta.changes ?? 0) > 0 ? member : ("superadmin" as Refusal);
  });
}

/**
 * Remove a person: everything they can sign in with goes, atomically, and
 * their row stays, marked `disabled` and a member again. Keeping the row is
 * what keeps their name on what they wrote, and what makes inviting the same
 * address later the same person — with the Private they had. The restricted
 * folders they were in they leave: somebody in each adds them again. Their
 * agents go with them, machines and all — an agent is its person's way in,
 * and comes back only by being connected again.
 * Their presence and their leases go with them, so nobody keeps seeing — or
 * being kept out of a document by — a person who is no longer here.
 *
 * Every token they held is written down in `removed_tokens` on the way out:
 * that is what tells each of their Macs, on its next request, that access was
 * taken away rather than merely lost (`isRemovedToken`). The superadmin's row
 * is refused — whoever controls the account the workspace is stored on
 * cannot be removed from it.
 *
 * Removing an OWNER also withdraws every code nobody has used yet, whoever it
 * was for. An owner makes codes for other people's rows; one they made and
 * kept would otherwise let them straight back in as that person. Which codes
 * were theirs is not recorded, so all of them go, and the owners who remain
 * make the ones still wanted again.
 */
export async function removeMember(env: Env, id: string): Promise<true | Refusal | null> {
  return withDb(env, async (db) => {
    // Every statement carries the same guard, so the batch is all or nothing
    // on the two facts that matter: the row is not the superadmin's, and the
    // person is still here. The role is read by the statements above the one
    // that resets it.
    const here = `IN (SELECT id FROM members WHERE disabled = 0 AND id ${NOT_SUPERADMIN})`;
    const results = await db.batch([
      db
        .prepare(
          `INSERT OR IGNORE INTO removed_tokens (hash, removed_at)
             SELECT hash, ?1 FROM tokens WHERE member_id = ?2 AND member_id ${here}`,
        )
        .bind(Date.now(), id),
      db.prepare(`DELETE FROM presence WHERE member_id = ? AND member_id ${here}`).bind(id),
      db.prepare(`DELETE FROM leases WHERE member_id = ? AND member_id ${here}`).bind(id),
      db.prepare(`DELETE FROM tokens WHERE member_id = ? AND member_id ${here}`).bind(id),
      db
        .prepare(`DELETE FROM invites WHERE EXISTS (SELECT 1 FROM members WHERE id = ? AND role = 'owner' AND id ${here})`)
        .bind(id),
      db.prepare(`DELETE FROM invites WHERE member_id = ? AND member_id ${here}`).bind(id),
      db
        .prepare(
          `DELETE FROM space_members
            WHERE member_id = ? AND member_id ${here}
              AND space_id IN (SELECT id FROM spaces WHERE kind = 'restricted')`,
        )
        .bind(id),
      db
        .prepare(`DELETE FROM agent_tokens WHERE agent_id IN (SELECT id FROM agents WHERE member_id = ? AND member_id ${here})`)
        .bind(id),
      db
        .prepare(`DELETE FROM agent_codes WHERE agent_id IN (SELECT id FROM agents WHERE member_id = ? AND member_id ${here})`)
        .bind(id),
      db.prepare(`DELETE FROM agents WHERE member_id = ? AND member_id ${here}`).bind(id),
      db.prepare(`UPDATE members SET disabled = 1, role = 'member' WHERE id = ? AND id ${here}`).bind(id),
    ]);
    if ((results.at(-1)?.meta.changes ?? 0) > 0) return true as const;
    return (await readHere(db, id)) ? ("superadmin" as Refusal) : ("missing" as Refusal);
  });
}

/* ---------- Devices ---------- */

/** The signed-in devices: one person's (`of`), or everybody's (`null`, an
 *  owner's view). Never the hash: nobody gets to hold a credential, only to
 *  name it. */
export async function listDevices(env: Env, of: string | null): Promise<Device[] | null> {
  return withDb(env, async (db) => {
    const { results } = await db
      .prepare(
        `SELECT t.id, t.member_id, t.device_id, t.device_name, t.created_at, m.email
           FROM tokens t JOIN members m ON m.id = t.member_id
          WHERE ?1 IS NULL OR t.member_id = ?1
          ORDER BY t.created_at, t.id`,
      )
      .bind(of)
      .all<{
        id: string;
        member_id: string;
        device_id: string | null;
        device_name: string | null;
        created_at: number;
        email: string;
      }>();
    return results.map((r) => ({
      id: r.id,
      memberId: r.member_id,
      email: r.email,
      deviceId: r.device_id,
      deviceName: r.device_name,
      createdAt: Number(r.created_at),
    }));
  });
}

/** Sign one device out: one of `caller`'s own or, with `everyone` (an
 *  owner), anybody's but the superadmin's, which only they sign out. Answers
 *  "superadmin" when that is why nothing went.
 *  Takes effect on that device's very next request: the bearer resolves
 *  through this table, so there is no session to expire. Its presence row and
 *  its lease go in the same batch — a device that has just been shown the
 *  door should not stay "here now", or keep a document view-only for everyone
 *  else, for the TTL's minute and a half. The token is written down in
 *  `removed_tokens` first, so that device is told its access was taken away
 *  and deletes its copy (`isRemovedToken`). */
export async function signOutDevice(
  env: Env,
  id: string,
  caller: string,
  everyone: boolean,
): Promise<boolean | "superadmin" | null> {
  const mine = `id = ?1 AND (member_id = ?2 OR (?3 = 1 AND member_id ${NOT_SUPERADMIN}))`;
  const flag = everyone ? 1 : 0;
  return withDb(env, async (db) => {
    const results = await db.batch([
      db
        .prepare(`INSERT OR IGNORE INTO removed_tokens (hash, removed_at) SELECT hash, ?4 FROM tokens WHERE ${mine}`)
        .bind(id, caller, flag, Date.now()),
      db.prepare(`DELETE FROM presence WHERE device_id = (SELECT device_id FROM tokens WHERE ${mine})`).bind(id, caller, flag),
      db.prepare(`DELETE FROM leases WHERE device_id = (SELECT device_id FROM tokens WHERE ${mine})`).bind(id, caller, flag),
      db.prepare(`DELETE FROM tokens WHERE ${mine}`).bind(id, caller, flag),
    ]);
    if ((results.at(-1)?.meta.changes ?? 0) > 0) return true;
    if (!everyone) return false;
    const theirs = await db
      .prepare("SELECT 1 AS theirs FROM tokens WHERE id = ? AND member_id IN (SELECT member_id FROM superadmin)")
      .bind(id)
      .first();
    return theirs ? ("superadmin" as const) : false;
  });
}

/** A device ending its own sign-in: it is leaving, not being shown the door.
 *  So nothing goes to `removed_tokens` — that list is what has a device
 *  delete its copy, and what a person does with the copy on a device they
 *  are holding is theirs to say. Its presence and its lease go with it. */
export async function endSession(env: Env, tokenId: string): Promise<boolean | null> {
  return withDb(env, async (db) => {
    const results = await db.batch([
      db.prepare("DELETE FROM presence WHERE device_id = (SELECT device_id FROM tokens WHERE id = ?)").bind(tokenId),
      db.prepare("DELETE FROM leases WHERE device_id = (SELECT device_id FROM tokens WHERE id = ?)").bind(tokenId),
      db.prepare("DELETE FROM tokens WHERE id = ?").bind(tokenId),
    ]);
    return (results.at(-1)?.meta.changes ?? 0) > 0;
  });
}

/* ---------- Invites ---------- */

/**
 * Put a pending code on this member, replacing any they already had. One
 * pending code per person is the whole rule: a code is a way in as that
 * person, whoever made it — an owner inviting them, or they themselves adding
 * a device (`POST /api/auth/devices/code`) — so a second one is always "the
 * first is not going to be used", and the old one should stop working the
 * moment the new one is made.
 *
 * `codeHash` is sha256 of the canonical code and arrives from the app — the
 * worker never sees the plaintext at this end.
 */
export async function putInvite(
  env: Env,
  member: Pick<Member, "id" | "email" | "name">,
  codeHash: string,
  expiresAt: number,
): Promise<Invite | null> {
  const invite: Invite = {
    id: `i-${randomHex(4)}`,
    memberId: member.id,
    email: member.email,
    name: member.name,
    createdAt: Date.now(),
    expiresAt,
  };
  return withDb(env, async (db) => {
    await db.batch([
      db.prepare("DELETE FROM invites WHERE member_id = ?").bind(member.id),
      db
        .prepare("INSERT OR REPLACE INTO invites (hash, id, member_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
        .bind(codeHash, invite.id, member.id, invite.createdAt, expiresAt),
    ]);
    return invite;
  });
}

/** The pending invites, expired ones filtered out rather than swept up — a row
 *  past its date is dead on redeem, so listing it would be a lie. */
export async function listInvites(env: Env, now = Date.now()): Promise<Invite[] | null> {
  return withDb(env, async (db) => {
    const { results } = await db
      .prepare(
        `SELECT i.id, i.member_id, i.created_at, i.expires_at, m.email, m.name
           FROM invites i JOIN members m ON m.id = i.member_id
          WHERE i.expires_at > ? ORDER BY i.created_at, i.id`,
      )
      .bind(now)
      .all<{ id: string; member_id: string; created_at: number; expires_at: number; email: string; name: string }>();
    return results.map((r) => ({
      id: r.id,
      memberId: r.member_id,
      email: r.email,
      name: r.name,
      createdAt: Number(r.created_at),
      expiresAt: Number(r.expires_at),
    }));
  });
}

export async function deleteInvite(env: Env, id: string): Promise<boolean | null> {
  return withDb(env, async (db) => {
    const res = await db.prepare("DELETE FROM invites WHERE id = ?").bind(id).run();
    return res.meta.changes > 0;
  });
}

/**
 * What a browser's sign-in starts with. A browser is a device, and its token
 * a row of `tokens` like any other's — but it is carried by a cookie no
 * script can read and answered on fewer routes (web.ts), and that has to stay
 * true of the token itself: one lifted out of a browser's cookie store and
 * sent as a Mac would send it is refused, because of how it starts
 * (auth.ts). The prefix is inside what is hashed, so it cannot be taken off.
 */
export const BROWSER_TOKEN_PREFIX = "dkw_";

export type Redeemed = { token: string; tokenId: string; member: Member };

/** What a redeem can come to: the token, or the reason there isn't one.
 *  `null` from `redeemInvite` is the fourth: this domain has no database. */
export type RedeemResult = Redeemed | "expired" | "unknown";

/**
 * Trade a code for this device's own token. The invite is deleted either way
 * — redeemed or found expired — which is what makes "one-time" and "expiring"
 * true without a reaper: the only row that can be deleted by time is one
 * somebody tried to use.
 *
 * The token is minted here, 256 bits, and returned exactly once; the database
 * keeps only its sha256. That matters because a person's token is not a
 * limited account — and, on an owner's row, it is an owner's.
 *
 * A browser's is a row like any device's, and says what it is in its first
 * characters (`BROWSER_TOKEN_PREFIX`).
 */
export async function redeemInvite(
  env: Env,
  codeHash: string,
  device: { id: string | null; name: string | null; browser: boolean },
  now = Date.now(),
): Promise<RedeemResult | null> {
  return withDb(env, async (db) => {
    // Aliased column by column: `i.id` and `m.id` are different ids, and a
    // `SELECT i.id, m.*` would quietly hand back whichever came last.
    const row = await db
      .prepare(
        `SELECT i.expires_at AS expires_at, ${MEMBER_COLS}
           FROM invites i JOIN members m ON m.id = i.member_id
          WHERE i.hash = ?`,
      )
      .bind(codeHash)
      .first<MemberRow & { expires_at: number }>();
    if (!row) return "unknown" as RedeemResult;
    if (Number(row.expires_at) <= now || Number(row.disabled) !== 0) {
      await db.prepare("DELETE FROM invites WHERE hash = ?").bind(codeHash).run();
      return "expired" as RedeemResult;
    }

    const token = `${device.browser ? BROWSER_TOKEN_PREFIX : ""}${randomHex(32)}`;
    const tokenId = `t-${randomHex(4)}`;
    await db.batch([
      db
        .prepare(
          "INSERT OR REPLACE INTO tokens (hash, id, member_id, device_id, device_name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(await sha256Hex(token), tokenId, row.id, device.id, validName(device.name, device.browser ? "A browser" : "A device"), now),
      db.prepare("DELETE FROM invites WHERE hash = ?").bind(codeHash),
      // From here somebody has signed in as this person (`Member.lastSeenAt`).
      db.prepare("UPDATE members SET last_seen_at = ?1 WHERE id = ?2 AND last_seen_at IS NULL").bind(now, row.id),
    ]);
    const member = toMember(row);
    return { token, tokenId, member: { ...member, lastSeenAt: member.lastSeenAt ?? now } } as RedeemResult;
  });
}
