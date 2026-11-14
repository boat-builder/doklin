// People, and the credentials they hold.
//
// The shape everything here rests on is a separation the old design did not
// make: an *identity* is not a *credential*.
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
// another (roles.ts says what each role may do).
//
// The creator is not in here on the authenticating path. `OWNER_TOKEN` stays
// the worker's env secret, compared with no database read, so a D1 outage
// degrades a workspace to one credential instead of locking its creator out
// altogether. The creator gets a member row all the same — for
// attribution and for the People list — `adoptCreator` is what writes it, and
// the one-row `creator` table says which row it is: that row is never removed
// and never made a member.

import { randomHex, sha256Hex } from "./crypto";
import type { Env } from "./env";
import { MAX_EMAIL_LEN, MAX_NAME_LEN, validName } from "./layout";
import type { PersonRole } from "./roles";
import { withDb } from "./schema";

export type Member = {
  id: string;
  email: string;
  name: string;
  role: PersonRole;
  /** The person who holds the domain's env secret. Always an owner. */
  creator: boolean;
  createdAt: number;
  /** When a Mac of theirs last beat, to the hour — and, before any has, when
   *  they first traded a code in. Null means nobody has ever signed in as
   *  them: the row is an invitation, not yet a person with anything to keep. */
  lastSeenAt: number | null;
};

/** A member plus how many devices they are signed in on — the People list. */
export type MemberWithDevices = Member & { devices: number };

/**
 * What a bearer resolves to when it is a person's token, not the domain's
 * secret: who they are, and the role on their row. The role is read on every
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

export type TokenRow = {
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

// Crockford's base32: no I, no L, no O, no U — so a code cannot spell a word
// and cannot be mistyped into a different valid one. I and L read back as 1,
// O as 0, which is the whole reason he dropped them.
const CROCKFORD = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{20}$/;

/**
 * A code as it is hashed: the twenty Crockford characters, uppercase, no
 * prefix and no dashes. `dkln-K7QM2-9XVR4-8TBHN-3WGYD` and
 * `dkln k7qm2 9xvr4 8tbhn 3wgyd` and the bare twenty all canonicalize to the
 * same string, so a code that survived an autocorrect, a line wrap or a
 * spreadsheet still redeems. Null when it is not a code.
 *
 * `prefix` is the four letters the code announces itself with, uppercase:
 * `DKLN` for an invite, `DKLA` for an agent's login code (agents.ts). A code
 * wearing the other kind's prefix is not a code here — the two are stored in
 * different tables, and saying so at the door beats a lookup that misses.
 *
 * This is a wire contract, not a convenience: the app hashes the canonical
 * form when it mints a code, and the worker hashes the canonical form when it
 * redeems one. The two have to agree character for character.
 */
export function canonicalCode(raw: unknown, prefix: string): string | null {
  if (typeof raw !== "string") return null;
  const bare = raw.trim().toUpperCase().replace(/[^0-9A-Z]/g, "");
  // The prefix only comes off a string long enough to have carried one. (A
  // bare code can never begin with either prefix — L is not in the alphabet
  // — but the length guard says so without depending on that.)
  const body = bare.length === 24 && bare.startsWith(prefix) ? bare.slice(4) : bare;
  const canonical = body.replace(/[IL]/g, "1").replace(/O/g, "0");
  return CROCKFORD.test(canonical) ? canonical : null;
}

/** An invite code as it is hashed (see `canonicalCode`). */
export const normalizeCode = (raw: unknown): string | null => canonicalCode(raw, "DKLN");

/** A sha256 hex digest, as the two hashed columns store one. */
export const HASH_RE = /^[a-f0-9]{64}$/;

/** The ids this module mints: `m-` a member, `t-` a token, `i-` an invite.
 *  Short on purpose — a member id is what the manifest, presence and leases
 *  carry, and an email must never enter any of them. */
export const ENTITY_ID_RE = /^[mti]-[a-f0-9]{8}$/;
/** A member's id alone — what a space lists its people by. */
export const MEMBER_ID_RE = /^m-[a-f0-9]{8}$/;

type MemberRow = {
  id: string;
  email: string;
  name: string;
  role: string;
  /** 1 when the `creator` table names this row. Every read selects it. */
  creator: number;
  created_at: number;
  last_seen_at: number | null;
  disabled: number;
};

/** A member's columns, plus whether the `creator` table names the row. */
const MEMBER_COLS = `m.id AS id, m.email AS email, m.name AS name, m.role AS role,
                m.created_at AS created_at, m.last_seen_at AS last_seen_at, m.disabled AS disabled,
                EXISTS (SELECT 1 FROM creator c WHERE c.member_id = m.id) AS creator`;

const toRole = (raw: string): PersonRole => (raw === "owner" ? "owner" : "member");

const toMember = (r: MemberRow): Member => ({
  id: r.id,
  email: r.email,
  name: r.name,
  role: toRole(r.role),
  creator: Number(r.creator) !== 0,
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
export async function resolveToken(env: Env, bearerHash: string): Promise<TokenIdentity | null> {
  return withDb(env, async (db) => {
    const row = await db
      .prepare(
        `SELECT t.id AS token_id, m.id AS member_id, m.email, m.name, m.role
           FROM tokens t JOIN members m ON m.id = t.member_id
          WHERE t.hash = ? AND m.disabled = 0`,
      )
      .bind(bearerHash)
      .first<{ token_id: string; member_id: string; email: string; name: string; role: string }>();
    if (!row) return null;
    return {
      tokenId: row.token_id,
      memberId: row.member_id,
      email: row.email,
      name: row.name,
      role: toRole(row.role),
    };
  }).then((v) => v ?? null); // a database that cannot answer has authenticated nobody
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
 *  among them. Newest last, so the creator — who is written at bind — leads
 *  the list. */
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
 * to be able to put a name to that as well. A removed person is still listed:
 * what they wrote keeps their name.
 *
 * It is served by `GET /api/meta`, the route every engine already asks, so
 * putting a name to an id never costs a request of its own. The People list
 * proper — addresses, roles, device counts — is `GET /api/auth/members`, and
 * an agent's permissions stay with whoever may manage agents.
 */
export async function listDirectory(env: Env): Promise<{ id: string; name: string }[] | null> {
  return withDb(env, async (db) => {
    const { results } = await db
      .prepare(
        `SELECT id, name FROM (
           SELECT id, name, 0 AS kind, created_at FROM members
           UNION ALL
           SELECT id, name, 1 AS kind, created_at FROM agents WHERE disabled = 0
         ) ORDER BY kind, created_at, id`,
      )
      .all<{ id: string; name: string }>();
    return results.map((r) => ({ id: r.id, name: r.name }));
  });
}

/** The creator's own row, if they have said who they are. Identity, never
 *  authority: the env secret is what authenticates them, and this is only how
 *  `GET /api/meta` can tell them what they are called. */
export async function findCreator(env: Env): Promise<Member | null> {
  return withDb(env, async (db) => {
    const row = await db
      .prepare(`SELECT ${MEMBER_COLS} FROM members m JOIN creator c ON c.member_id = m.id LIMIT 1`)
      .first<MemberRow>();
    return row ? toMember(row) : null;
  });
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
  role: PersonRole,
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

/**
 * Write (or rename) the creator's own member row. The creator authenticates
 * off the env secret, so this is identity, never authority — but it is what
 * makes the creator a *person* in the People list and in attribution.
 *
 * One row is the creator's. Adopting a new address moves the mark to it and
 * makes the old row a plain member rather than deleting it: that row may
 * already be named in a manifest, and an address somebody stopped using
 * should not go on holding an owner's authority.
 */
export async function adoptCreator(env: Env, email: string, name: string | null): Promise<Member | null> {
  const given = typeof name === "string" && name.trim() ? name.trim().slice(0, MAX_NAME_LEN) : null;
  return withDb(env, async (db) => {
    // One batch, keyed by the address throughout: the row, the mark and the
    // role move together or not at all, so a removal that lands in between
    // cannot leave the mark on a row that is gone.
    await db.batch([
      db
        .prepare(
          `INSERT INTO members (id, email, name, role, created_at, last_seen_at, disabled)
           VALUES (?, ?, ?, 'owner', ?, NULL, 0)
           ON CONFLICT(email) DO UPDATE SET name = COALESCE(?, members.name), disabled = 0`,
        )
        .bind(memberId(), email, given ?? validName(null, email.split("@")[0] || "Member"), Date.now(), given),
      db
        .prepare("UPDATE members SET role = 'member' WHERE id IN (SELECT member_id FROM creator) AND email != ?")
        .bind(email),
      // The insert only sets the role on a *new* row; a person invited as a
      // member first has to be made an owner.
      db.prepare("UPDATE members SET role = 'owner' WHERE email = ?").bind(email),
      db
        .prepare(
          `INSERT INTO creator (id, member_id) SELECT 1, id FROM members WHERE email = ?
           ON CONFLICT(id) DO UPDATE SET member_id = excluded.member_id`,
        )
        .bind(email),
    ]);
    const row = await db.prepare(`SELECT ${MEMBER_COLS} FROM members m WHERE m.email = ?`).bind(email).first<MemberRow>();
    return row ? toMember(row) : null;
  });
}

/** What changing a role, or removing a person, can come to besides done:
 *  nobody has that id, or the row is the creator's and stays as it is. */
export type Refusal = "missing" | "creator";

/**
 * Make someone an owner, or a member again. Their tokens carry the new role
 * on their next request — it is read off this row every time. The creator's
 * row is refused: it is an owner's for as long as the domain has a secret.
 */
export async function setMemberRole(env: Env, id: string, role: PersonRole): Promise<Member | Refusal | null> {
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
                             AND id NOT IN (SELECT member_id FROM creator))`,
        )
        .bind(role, id),
      db
        .prepare(
          "UPDATE members SET role = ?1 WHERE id = ?2 AND disabled = 0 AND id NOT IN (SELECT member_id FROM creator)",
        )
        .bind(role, id),
    ]);
    const member = await readHere(db, id);
    if (!member) return "missing" as Refusal;
    return (results.at(-1)?.meta.changes ?? 0) > 0 ? member : ("creator" as Refusal);
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
 * taken away rather than merely lost (`isRemovedToken`). The creator's row is
 * refused — whoever holds the domain's secret cannot be removed from it.
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
    // on the two facts that matter: the row is not the creator's, and the
    // person is still here. The role is read by the statements above the one
    // that resets it.
    const here = "IN (SELECT id FROM members WHERE disabled = 0 AND id NOT IN (SELECT member_id FROM creator))";
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
    return (await readHere(db, id)) ? ("creator" as Refusal) : ("missing" as Refusal);
  });
}

/* ---------- Tokens ---------- */

/** Every signed-in device. Never the hash: the owner does not get to hold
 *  anyone's credential, only to name it. */
export async function listTokens(env: Env): Promise<TokenRow[] | null> {
  return withDb(env, async (db) => {
    const { results } = await db
      .prepare(
        `SELECT t.id, t.member_id, t.device_id, t.device_name, t.created_at, m.email
           FROM tokens t JOIN members m ON m.id = t.member_id
          ORDER BY t.created_at, t.id`,
      )
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

/** Revoke one device. Takes effect on that device's very next request: the
 *  bearer resolves through this table, so there is no session to expire.
 *  Its presence row and its lease go in the same batch — a Mac that has just
 *  been shown the door should not stay "here now", or keep a document
 *  view-only for everyone else, for the TTL's minute and a half. The token is
 *  written down in `removed_tokens` first, so that Mac is told its access was
 *  taken away and deletes its copy (`isRemovedToken`). */
export async function deleteToken(env: Env, id: string): Promise<boolean | null> {
  return withDb(env, async (db) => {
    const results = await db.batch([
      db
        .prepare("INSERT OR IGNORE INTO removed_tokens (hash, removed_at) SELECT hash, ?1 FROM tokens WHERE id = ?2")
        .bind(Date.now(), id),
      db
        .prepare("DELETE FROM presence WHERE device_id = (SELECT device_id FROM tokens WHERE id = ?)")
        .bind(id),
      db.prepare("DELETE FROM leases WHERE device_id = (SELECT device_id FROM tokens WHERE id = ?)").bind(id),
      db.prepare("DELETE FROM tokens WHERE id = ?").bind(id),
    ]);
    return (results.at(-1)?.meta.changes ?? 0) > 0;
  });
}

/* ---------- Invites ---------- */

/**
 * Put a pending invite on this member, replacing any they already had. One
 * pending invite per person is the whole rule: a second Mac never needs one
 * (the panel already shows the token it holds), so a second invite is always
 * "they lost the code", and the old one should stop working the moment the
 * new one is made.
 *
 * `codeHash` is sha256 of the canonical code and arrives from the app — the
 * worker never sees the plaintext at this end.
 */
export async function putInvite(
  env: Env,
  member: Member,
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
 * keeps only its sha256. That is the same strength as the domain's own
 * secret, which matters because a person's token is not a limited account —
 * and, on an owner's row, it is an owner's.
 */
export async function redeemInvite(
  env: Env,
  codeHash: string,
  deviceId: string | null,
  deviceName: string | null,
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

    const token = randomHex(32);
    const tokenId = `t-${randomHex(4)}`;
    await db.batch([
      db
        .prepare(
          "INSERT OR REPLACE INTO tokens (hash, id, member_id, device_id, device_name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(await sha256Hex(token), tokenId, row.id, deviceId, validName(deviceName, "A Mac"), now),
      db.prepare("DELETE FROM invites WHERE hash = ?").bind(codeHash),
      // From here somebody has signed in as this person (`Member.lastSeenAt`).
      db.prepare("UPDATE members SET last_seen_at = ?1 WHERE id = ?2 AND last_seen_at IS NULL").bind(now, row.id),
    ]);
    const member = toMember(row);
    return { token, tokenId, member: { ...member, lastSeenAt: member.lastSeenAt ?? now } } as RedeemResult;
  });
}
