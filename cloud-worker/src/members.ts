// People, and the credentials they hold (docs/teams-plan.md §3, §9).
//
// The shape everything here rests on is a separation the old design did not
// make: an *identity* is not a *credential*.
//
//   member   permanent, one row per person, keyed by their normalized email.
//            What the manifest, presence and leases will name. Survives every
//            Mac they ever use — lose the laptop, get invited again, same row.
//   token    one per device, disposable, 256 bits. Stored only as
//            sha256(token): the database is not a list of credentials, and
//            revoking one is deleting one row.
//   invite   a token that has not been claimed yet. Stored only as
//            sha256(code), one-time, and deleted the moment it is redeemed or
//            found expired (§6.6) — no cron trigger, no reaper.
//
// The owner is not in here on the authenticating path. `OWNER_TOKEN` stays
// the worker's env secret, compared with no database read, so a D1 outage
// degrades a workspace to one credential instead of locking its owner out
// (§3.2). The owner gets a member row all the same — for attribution and for
// the People list — and `adoptOwner` is what writes it.

import { randomHex, sha256Hex } from "./crypto";
import type { Env } from "./env";
import { MAX_EMAIL_LEN, MAX_NAME_LEN, validName } from "./layout";
import { ensureSchema } from "./schema";

export type MemberRole = "owner" | "member";

export type Member = {
  id: string;
  email: string;
  name: string;
  role: MemberRole;
  createdAt: number;
  lastSeenAt: number | null;
  disabled: boolean;
};

/** A member plus how many devices they are signed in on — the People list. */
export type MemberWithDevices = Member & { devices: number };

/**
 * What a bearer resolves to when it is a member's token, not the owner's
 * secret. Note what is NOT here: a role. The `members.role` column describes
 * a *person* — it is what the People list shows — and a token is never
 * evidence of it. Owner authority comes from exactly one place, the env
 * secret, so no row anybody can write grants it (§3.2). Inviting the owner's
 * own address therefore mints an ordinary member credential, which is what
 * it should be: their second Mac already has the real one.
 */
export type TokenIdentity = {
  tokenId: string;
  memberId: string;
  email: string;
  name: string;
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
 * An invite code as it is hashed: the twenty Crockford characters, uppercase,
 * no prefix and no dashes. `dkln-K7QM2-9XVR4-8TBHN-3WGYD` and
 * `dkln k7qm2 9xvr4 8tbhn 3wgyd` and the bare twenty all canonicalize to the
 * same string, so a code that survived an autocorrect, a line wrap or a
 * spreadsheet still redeems. Null when it is not a code.
 *
 * This is a wire contract, not a convenience: the app hashes the canonical
 * form when it mints the invite, and the worker hashes the canonical form
 * when it redeems one. The two have to agree character for character.
 */
export function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const bare = raw.trim().toUpperCase().replace(/[^0-9A-Z]/g, "");
  // The prefix only comes off a string long enough to have carried one. (A
  // bare code can never begin "DKLN" — L is not in the alphabet — but the
  // length guard says so without depending on that.)
  const body = bare.length === 24 && bare.startsWith("DKLN") ? bare.slice(4) : bare;
  const canonical = body.replace(/[IL]/g, "1").replace(/O/g, "0");
  return CROCKFORD.test(canonical) ? canonical : null;
}

/** A sha256 hex digest, as the two hashed columns store one. */
export const HASH_RE = /^[a-f0-9]{64}$/;

/** The ids this module mints: `m-` a member, `t-` a token, `i-` an invite.
 *  Short on purpose — a member id is what the manifest, presence and leases
 *  will carry, and an email must never enter any of them (§6.2). */
export const ENTITY_ID_RE = /^[mti]-[a-f0-9]{8}$/;

/* ---------- The database, or nothing ---------- */

/**
 * Run something against the migrated database, or answer null. Every export
 * below goes through here, so "this deployment has no `DB` binding", "the
 * database could not be migrated" and "the query threw" are one answer the
 * routes turn into a 503 — never a 500, and never a route that throws because
 * somebody deleted a database out from under a deployed worker.
 */
async function withDb<T>(env: Env, fn: (db: D1Database) => Promise<T>): Promise<T | null> {
  const db = env.DB;
  if (!db) return null;
  try {
    if ((await ensureSchema(env)) == null) return null;
    return await fn(db);
  } catch {
    return null;
  }
}

type MemberRow = {
  id: string;
  email: string;
  name: string;
  role: string;
  created_at: number;
  last_seen_at: number | null;
  disabled: number;
};

const toMember = (r: MemberRow): Member => ({
  id: r.id,
  email: r.email,
  name: r.name,
  role: r.role === "owner" ? "owner" : "member",
  createdAt: Number(r.created_at),
  lastSeenAt: r.last_seen_at == null ? null : Number(r.last_seen_at),
  disabled: Number(r.disabled) !== 0,
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
 * at most once a day per person (§6.7).
 */
export async function resolveToken(env: Env, bearerHash: string): Promise<TokenIdentity | null> {
  return withDb(env, async (db) => {
    const row = await db
      .prepare(
        `SELECT t.id AS token_id, m.id AS member_id, m.email, m.name
           FROM tokens t JOIN members m ON m.id = t.member_id
          WHERE t.hash = ? AND m.disabled = 0`,
      )
      .bind(bearerHash)
      .first<{ token_id: string; member_id: string; email: string; name: string }>();
    if (!row) return null;
    return { tokenId: row.token_id, memberId: row.member_id, email: row.email, name: row.name };
  }).then((v) => v ?? null); // a database that cannot answer has authenticated nobody
}

/* ---------- Members ---------- */

/** Everyone, with how many devices they hold. Newest last, so the owner — who
 *  is written at bind — leads the list. */
export async function listMembers(env: Env): Promise<MemberWithDevices[] | null> {
  return withDb(env, async (db) => {
    const { results } = await db
      .prepare(
        `SELECT m.*, (SELECT COUNT(*) FROM tokens t WHERE t.member_id = m.id) AS devices
           FROM members m ORDER BY m.created_at, m.id`,
      )
      .all<MemberRow & { devices: number }>();
    return results.map((r) => ({ ...toMember(r), devices: Number(r.devices) }));
  });
}

/**
 * The member for this email, created if this is the first time it has been
 * seen. A name that comes with it wins, so re-inviting someone is also how
 * they get renamed; the role of an existing row is left alone, because
 * inviting the owner must not demote them.
 */
export async function upsertMember(
  env: Env,
  email: string,
  name: string | null,
  role: MemberRole,
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
         ON CONFLICT(email) DO UPDATE SET name = COALESCE(?, members.name)
         RETURNING *`,
      )
      .bind(memberId(), email, given ?? validName(null, email.split("@")[0] || "Member"), role, Date.now(), given)
      .first<MemberRow>();
    return row ? toMember(row) : null;
  });
}

export async function findMemberByEmail(env: Env, email: string): Promise<Member | null> {
  return withDb(env, async (db) => {
    const row = await db.prepare("SELECT * FROM members WHERE email = ?").bind(email).first<MemberRow>();
    return row ? toMember(row) : null;
  });
}

/**
 * Write (or rename) the owner's own member row. The owner authenticates off
 * the env secret, so this is identity, never authority — but it is what makes
 * the owner a *person* in the People list and in attribution.
 *
 * Exactly one row carries the owner role: adopting a new address demotes the
 * old one to a plain member rather than deleting it, because that row may
 * already be named in a manifest.
 */
export async function adoptOwner(env: Env, email: string, name: string | null): Promise<Member | null> {
  const member = await upsertMember(env, email, name, "owner");
  if (!member) return null;
  return withDb(env, async (db) => {
    // The insert only sets the role on a *new* row; a person invited as a
    // member first has to be promoted, and whoever held the role before has
    // to let it go.
    await db.batch([
      db.prepare("UPDATE members SET role = 'owner' WHERE id = ?").bind(member.id),
      db.prepare("UPDATE members SET role = 'member' WHERE role = 'owner' AND id != ?").bind(member.id),
    ]);
    return { ...member, role: "owner" as MemberRole };
  });
}

/**
 * Remove a person and everything they can sign in with, atomically: their
 * tokens, their pending invite, then the row itself. The cascade is declared
 * in the schema too, but spelling it out means revocation does not depend on
 * whether foreign keys are being enforced.
 */
export async function deleteMember(env: Env, id: string): Promise<boolean | null> {
  return withDb(env, async (db) => {
    const results = await db.batch([
      db.prepare("DELETE FROM tokens WHERE member_id = ?").bind(id),
      db.prepare("DELETE FROM invites WHERE member_id = ?").bind(id),
      db.prepare("DELETE FROM members WHERE id = ?").bind(id),
    ]);
    return (results.at(-1)?.meta.changes ?? 0) > 0;
  });
}

/* ---------- Tokens ---------- */

/** Every signed-in device. Never the hash: the owner does not get to hold
 *  anyone's credential, only to name it (§6.5). */
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
 *  bearer resolves through this table, so there is no session to expire. */
export async function deleteToken(env: Env, id: string): Promise<boolean | null> {
  return withDb(env, async (db) => {
    const res = await db.prepare("DELETE FROM tokens WHERE id = ?").bind(id).run();
    return res.meta.changes > 0;
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
 * worker never sees the plaintext at this end (§6.3).
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
 * keeps only its sha256. That is the same strength as the owner's own
 * credential, which matters because a member token is not a limited account.
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
        `SELECT i.expires_at AS expires_at,
                m.id AS id, m.email AS email, m.name AS name, m.role AS role,
                m.created_at AS created_at, m.last_seen_at AS last_seen_at, m.disabled AS disabled
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
    ]);
    return { token, tokenId, member: toMember(row) } as RedeemResult;
  });
}
