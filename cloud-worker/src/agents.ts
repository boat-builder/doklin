// Agents, and the credentials they hold.
//
// An agent is an identity that is not a person: a bot on a remote computer, a
// coding agent in a sandbox. It has the same three lifetimes a person has
// (members.ts) and none of the same rows:
//
//   agent   permanent, one row per bot: a name and a set of permissions. What
//           a manifest's `by` names when the bot changed something.
//   code    one-time and short-lived. The owner's app mints it and sends only
//           sha256(code); `doklin login` trades it for a token. Deleted the
//           moment it is redeemed or found expired.
//   token   one per machine the bot is logged in on, `dka_` + 256 bits.
//           Stored only as sha256(token), so revoking one is deleting one row.
//
// An agent is not a member on purpose. A member is a person keyed by an
// email and may use the whole sync API; an agent has no address, holds
// permissions a member does not have, and is only ever answered on the
// document API (agentApi.ts). Nothing here is on the sync path: a database
// that cannot answer costs a workspace its agents and nothing else.

import { randomHex, sha256Hex } from "./crypto";
import type { Env } from "./env";
import { validName } from "./layout";
import { canonicalCode } from "./members";
import { withDb } from "./schema";

/** What an agent may do. `read` is not optional — an agent that cannot read
 *  cannot do anything else usefully — so every agent holds it. */
export const SCOPES = ["read", "comment", "edit", "publish"] as const;
export type Scope = (typeof SCOPES)[number];

export type Agent = {
  id: string;
  name: string;
  scopes: Scope[];
  createdAt: number;
  lastUsedAt: number | null;
};

/** One machine an agent is logged in on. Never the credential. */
export type AgentMachine = { id: string; host: string; createdAt: number };

/** A login code nobody has traded in yet. Never the code. */
export type AgentCode = { id: string; createdAt: number; expiresAt: number };

/** An agent as the People view lists it. */
export type AgentListed = Agent & { machines: AgentMachine[]; code: AgentCode | null };

/** What an agent's bearer resolves to. */
export type AgentIdentity = {
  tokenId: string;
  agentId: string;
  name: string;
  scopes: Scope[];
  lastUsedAt: number | null;
};

/** `a-` an agent, `c-` a login code, `t-` one machine's token. */
export const AGENT_ID_RE = /^a-[a-f0-9]{8}$/;
export const AGENT_TOKEN_ID_RE = /^t-[a-f0-9]{8}$/;

/** What an agent's bearer starts with, so the gate knows which table to ask
 *  and a leaked one is greppable. */
export const AGENT_TOKEN_PREFIX = "dka_";

/**
 * A login code may be dated this far out and no further. The app asks for an
 * hour (src-tauri/src/cloud/invite.rs, `AGENT_CODE_MINUTES`); the ceiling is
 * wider only so two clocks that disagree by a few minutes do not refuse each
 * other. The line a code travels in gets pasted into chats, so a code is
 * meant to be worthless soon.
 */
export const MAX_AGENT_CODE_TTL_MS = 24 * 60 * 60 * 1000;

/** How stale `last_used_at` may get before a request moves it. */
const LAST_USED_GAP_MS = 60 * 60 * 1000;

/* ---------- Normalizing what arrives ---------- */

/** A login code as it is hashed — `dkla-7QK2M-…` in any spacing or case
 *  canonicalizes to its twenty characters (see `canonicalCode`). */
export const normalizeAgentCode = (raw: unknown): string | null => canonicalCode(raw, "DKLA");

/** The permissions in a request body, in their canonical order with `read`
 *  always among them — or null when the body names one that does not exist. */
export function parseScopes(raw: unknown): Scope[] | null {
  if (!Array.isArray(raw)) return null;
  const asked = new Set<string>(["read"]);
  for (const s of raw) {
    if (typeof s !== "string" || !(SCOPES as readonly string[]).includes(s)) return null;
    asked.add(s);
  }
  return SCOPES.filter((s) => asked.has(s));
}

const storeScopes = (scopes: readonly Scope[]): string => scopes.join(" ");
const readScopes = (stored: string): Scope[] => {
  const have = new Set(stored.split(" "));
  return SCOPES.filter((s) => s === "read" || have.has(s));
};

type AgentRow = {
  id: string;
  name: string;
  scopes: string;
  created_at: number;
  last_used_at: number | null;
};

const toAgent = (r: AgentRow): Agent => ({
  id: r.id,
  name: r.name,
  scopes: readScopes(r.scopes),
  createdAt: Number(r.created_at),
  lastUsedAt: r.last_used_at == null ? null : Number(r.last_used_at),
});

/* ---------- Authenticating an agent ---------- */

/**
 * Resolve a bearer's sha256 to the agent behind it: one row read on the
 * tokens primary key, joined to the agent. A disabled agent is no one.
 * Nothing is written here — `touchAgent` moves `last_used_at`, at most once
 * an hour, so a request costs a read and no write.
 */
export async function resolveAgentToken(env: Env, bearerHash: string): Promise<AgentIdentity | null> {
  return withDb(env, async (db) => {
    const row = await db
      .prepare(
        `SELECT t.id AS token_id, a.id AS id, a.name AS name, a.scopes AS scopes, a.last_used_at AS last_used_at
           FROM agent_tokens t JOIN agents a ON a.id = t.agent_id
          WHERE t.hash = ? AND a.disabled = 0`,
      )
      .bind(bearerHash)
      .first<{ token_id: string; id: string; name: string; scopes: string; last_used_at: number | null }>();
    if (!row) return null;
    return {
      tokenId: row.token_id,
      agentId: row.id,
      name: row.name,
      scopes: readScopes(row.scopes),
      lastUsedAt: row.last_used_at == null ? null : Number(row.last_used_at),
    };
  });
}

/** Say "this agent was here", unless something said so within the hour. The
 *  guard is in the statement too, so two requests racing past the caller's
 *  own check still write once. Best effort: it is a date in a list. */
export async function touchAgent(env: Env, identity: AgentIdentity, now = Date.now()): Promise<void> {
  if (identity.lastUsedAt !== null && now - identity.lastUsedAt < LAST_USED_GAP_MS) return;
  await withDb(env, (db) =>
    db
      .prepare("UPDATE agents SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)")
      .bind(now, identity.agentId, now - LAST_USED_GAP_MS)
      .run(),
  );
}

/* ---------- The owner's side ---------- */

/** Add an agent, with the first login code already on it. */
export async function createAgent(
  env: Env,
  name: string,
  scopes: Scope[],
  codeHash: string,
  expiresAt: number,
): Promise<AgentListed | null> {
  const now = Date.now();
  const agent: Agent = { id: `a-${randomHex(4)}`, name, scopes, createdAt: now, lastUsedAt: null };
  const code: AgentCode = { id: `c-${randomHex(4)}`, createdAt: now, expiresAt };
  return withDb(env, async (db) => {
    await db.batch([
      db
        .prepare("INSERT INTO agents (id, name, scopes, created_at, last_used_at, disabled) VALUES (?, ?, ?, ?, NULL, 0)")
        .bind(agent.id, agent.name, storeScopes(scopes), now),
      db
        .prepare("INSERT OR REPLACE INTO agent_codes (hash, id, agent_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
        .bind(codeHash, code.id, agent.id, now, expiresAt),
    ]);
    return { ...agent, machines: [], code };
  });
}

/** Every agent, with the machines it is logged in on and its pending code. */
export async function listAgents(env: Env, now = Date.now()): Promise<AgentListed[] | null> {
  return withDb(env, async (db) => {
    const [agents, tokens, codes] = await db.batch<Record<string, unknown>>([
      db.prepare("SELECT id, name, scopes, created_at, last_used_at FROM agents ORDER BY created_at, id"),
      db.prepare("SELECT id, agent_id, host, created_at FROM agent_tokens ORDER BY created_at, id"),
      db.prepare("SELECT id, agent_id, created_at, expires_at FROM agent_codes WHERE expires_at > ? ORDER BY created_at, id").bind(now),
    ]);
    return (agents.results as AgentRow[]).map((row) => ({
      ...toAgent(row),
      machines: tokens.results
        .filter((t) => t.agent_id === row.id)
        .map((t) => ({ id: String(t.id), host: String(t.host), createdAt: Number(t.created_at) })),
      code:
        codes.results
          .filter((c) => c.agent_id === row.id)
          .map((c) => ({ id: String(c.id), createdAt: Number(c.created_at), expiresAt: Number(c.expires_at) }))
          .at(-1) ?? null,
    }));
  });
}

/** Rename an agent or change what it may do. Takes effect on its next
 *  request: permissions are read off the row every time. False when there is
 *  no such agent. */
export async function updateAgent(
  env: Env,
  id: string,
  change: { name?: string; scopes?: Scope[] },
): Promise<boolean | null> {
  return withDb(env, async (db) => {
    const res = await db
      .prepare("UPDATE agents SET name = COALESCE(?, name), scopes = COALESCE(?, scopes) WHERE id = ?")
      .bind(change.name ?? null, change.scopes ? storeScopes(change.scopes) : null, id)
      .run();
    return res.meta.changes > 0;
  });
}

/** Put a fresh login code on an agent, replacing any it had: a second code is
 *  always "the first one ran out" or "another machine", and either way the old
 *  line should stop working. False when there is no such agent. */
export async function putAgentCode(
  env: Env,
  agentId: string,
  codeHash: string,
  expiresAt: number,
): Promise<AgentCode | false | null> {
  const code: AgentCode = { id: `c-${randomHex(4)}`, createdAt: Date.now(), expiresAt };
  return withDb(env, async (db) => {
    const agent = await db.prepare("SELECT id FROM agents WHERE id = ?").bind(agentId).first<{ id: string }>();
    if (!agent) return false;
    await db.batch([
      db.prepare("DELETE FROM agent_codes WHERE agent_id = ?").bind(agentId),
      db
        .prepare("INSERT OR REPLACE INTO agent_codes (hash, id, agent_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
        .bind(codeHash, code.id, agentId, code.createdAt, expiresAt),
    ]);
    return code;
  });
}

/** Remove an agent and everything it can log in with, atomically. Spelled out
 *  rather than left to the cascade, for the reason members.ts gives. */
export async function deleteAgent(env: Env, id: string): Promise<boolean | null> {
  return withDb(env, async (db) => {
    const results = await db.batch([
      db.prepare("DELETE FROM agent_tokens WHERE agent_id = ?").bind(id),
      db.prepare("DELETE FROM agent_codes WHERE agent_id = ?").bind(id),
      db.prepare("DELETE FROM agents WHERE id = ?").bind(id),
    ]);
    return (results.at(-1)?.meta.changes ?? 0) > 0;
  });
}

/** Log one machine out. Effective on that machine's very next request. */
export async function deleteAgentToken(env: Env, agentId: string, tokenId: string): Promise<boolean | null> {
  return withDb(env, async (db) => {
    const res = await db.prepare("DELETE FROM agent_tokens WHERE id = ? AND agent_id = ?").bind(tokenId, agentId).run();
    return res.meta.changes > 0;
  });
}

/* ---------- Logging in ---------- */

export type LoggedIn = { token: string; tokenId: string; agent: Agent };

/** What a login can come to. `null` from `redeemAgentCode` is the fourth
 *  answer: this domain has no database. */
export type LoginResult = LoggedIn | "expired" | "unknown";

/**
 * Trade a login code for this machine's own token.
 *
 * The code is deleted by the statement that reads it, so of two machines
 * racing one code exactly one gets a row back — "one-time" is the database's
 * doing, not a check this function makes. The token is minted here, returned
 * exactly once, and kept only as its sha256.
 */
export async function redeemAgentCode(
  env: Env,
  codeHash: string,
  host: string | null,
  now = Date.now(),
): Promise<LoginResult | null> {
  return withDb(env, async (db) => {
    const code = await db
      .prepare("DELETE FROM agent_codes WHERE hash = ? RETURNING agent_id, expires_at")
      .bind(codeHash)
      .first<{ agent_id: string; expires_at: number }>();
    if (!code) return "unknown" as LoginResult;
    if (Number(code.expires_at) <= now) return "expired" as LoginResult;
    const row = await db
      .prepare("SELECT id, name, scopes, created_at, last_used_at FROM agents WHERE id = ? AND disabled = 0")
      .bind(code.agent_id)
      .first<AgentRow>();
    if (!row) return "unknown" as LoginResult;

    const token = `${AGENT_TOKEN_PREFIX}${randomHex(32)}`;
    const tokenId = `t-${randomHex(4)}`;
    await db
      .prepare("INSERT INTO agent_tokens (hash, id, agent_id, host, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(await sha256Hex(token), tokenId, row.id, validName(host, "A machine"), now)
      .run();
    return { token, tokenId, agent: toAgent(row) } as LoginResult;
  });
}

/** `doklin logout`: the token that made this request revokes itself. */
export async function deleteOwnToken(env: Env, tokenId: string): Promise<boolean | null> {
  return withDb(env, async (db) => {
    const res = await db.prepare("DELETE FROM agent_tokens WHERE id = ?").bind(tokenId).run();
    return res.meta.changes > 0;
  });
}
