// Who is calling. Every /api route but two runs through `authenticate`: the
// bearer is hashed and resolved against the `tokens` table as the person who
// holds it, with the role their row gives them (roles.ts).
//
// Every credential is a row. No device is matched any other way, so none is
// special: the superadmin's Macs are rows like everybody's, carrying the
// superadmin's role, and a database that cannot answer is a workspace nobody
// can sign in to — said as a 503, never as a 401, because a 401 is what has
// a Mac stop syncing for good.
//
// Storing tokens by the sha256 of the token makes resolving a bearer one
// primary-key lookup and makes revocation — delete the row — take effect on
// the very next request: there is no session, so there is nothing to expire.
// A change of role lands the same way, for the same reason.
//
// A bearer that resolves to nobody is `null` — except one an owner took
// away, which is "removed": the worker says so in as many words, because a
// Mac that hears it deletes its copy of the workspace.
//
// A bearer that starts `dka_` is an agent's (agents.ts) and resolves through
// the agents' own table instead: the same one primary-key read, to a role the
// sync API refuses outright. An agent is only ever answered on the document
// API (agentApi.ts), within the permissions on its row, and its `memberId` is
// the person it belongs to: every question of what it can see is asked as
// that person.
//
// The domain's key — the worker's env secret, `OWNER_TOKEN` — is not a
// credential of anybody's and never authenticates. `isKey` recognizes it,
// with no database read, for the two routes that take it: the probe and the
// trade that makes a device sign-in of the superadmin's (api.ts).
//
// The two routes above this gate are `POST /api/auth/join` and
// `POST /api/agent/login`, which have to answer without a bearer because
// answering them is how a Mac, or a bot, GETS one (api.ts).

import { AGENT_TOKEN_PREFIX, resolveAgentToken, touchAgent, type Scope } from "./agents";
import { sha256Hex, timingEq } from "./crypto";
import type { Env } from "./env";
import { ID_RE } from "./layout";
import { isRemovedToken, resolveToken } from "./members";
import type { PersonRole } from "./roles";

export type Role = PersonRole | "agent";

export type Auth = {
  /** What the caller may do is asked of this, through `can` (roles.ts). */
  role: Role;
  /** A minted token's own id: which row of the devices list, or of an
   *  agent's machines, this credential is. */
  tokenId: string;
  /** The person behind the credential — for an agent, the person it
   *  belongs to. */
  memberId: string;
  /** The person's address; null for an agent, which has none. */
  email: string | null;
  name: string;
  /** The calling device, from x-doklin-device (null when the header is missing or malformed). */
  deviceId: string | null;
  /**
   * Set exactly when `role` is "agent": the id it signs what it changes with,
   * and what its person ticked for it. Null for people — a person's token is
   * not a limited account, so there is nothing to list.
   */
  agent: { id: string; scopes: readonly Scope[] } | null;
};

export { randomHex } from "./crypto";

/** The device a request speaks for (`x-doklin-device`), or null. Attribution only — never authority. */
function deviceIdOf(request: Request): string | null {
  const id = request.headers.get("x-doklin-device")?.trim() ?? "";
  return ID_RE.test(id) ? id : null;
}

/** The bearer, or null when there is none. */
function bearerOf(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim() || null;
}

/** The sha256 of the domain's key when the bearer is it — what a spent key
 *  is remembered by — and null otherwise. Constant time, no database read. */
export async function keyHashOf(request: Request, env: Env): Promise<string | null> {
  const bearer = bearerOf(request);
  if (!bearer || !env.OWNER_TOKEN) return null;
  const [given, key] = await Promise.all([sha256Hex(bearer), sha256Hex(env.OWNER_TOKEN)]);
  return timingEq(given, key) ? given : null;
}

/** Resolve the bearer to an identity: `null` for nobody, "removed" for a
 *  credential an owner took away, "unavailable" when the database could not
 *  say which. */
export async function authenticate(request: Request, env: Env): Promise<Auth | "removed" | "unavailable" | null> {
  const bearer = bearerOf(request);
  if (!bearer) return null;
  const deviceId = deviceIdOf(request);
  const bearerHash = await sha256Hex(bearer);

  if (bearer.startsWith(AGENT_TOKEN_PREFIX)) {
    const agent = await resolveAgentToken(env, bearerHash);
    if (agent === null) return "unavailable";
    if (agent === "nobody") return null;
    await touchAgent(env, agent);
    return {
      role: "agent",
      tokenId: agent.tokenId,
      memberId: agent.memberId,
      email: null,
      name: agent.name,
      deviceId,
      agent: { id: agent.agentId, scopes: agent.scopes },
    };
  }

  const identity = await resolveToken(env, bearerHash);
  if (identity === null) return "unavailable";
  if (identity === "nobody") return (await isRemovedToken(env, bearerHash)) ? "removed" : null;
  return {
    role: identity.role,
    tokenId: identity.tokenId,
    memberId: identity.memberId,
    email: identity.email,
    name: identity.name,
    deviceId,
    agent: null,
  };
}
