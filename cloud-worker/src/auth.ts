// Who is calling. Every /api route but two runs through `authenticate`: the
// bearer is hashed, compared with the domain secret's hash in constant time,
// and — when that is not it — resolved against the `tokens` table as the
// person who holds it, with the role on their row.
//
// The order is the design, not an optimization. The creator's credential is
// the worker's env secret and is matched with NO database read, so a D1
// outage degrades a workspace to one credential rather than locking its
// creator out of their own domain. Only a bearer that is *not* the secret
// costs a row read.
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
  /** True for the OWNER_TOKEN secret and nothing else: the one credential no
   *  row confers and none can take away. */
  creator: boolean;
  /** "owner" for the OWNER_TOKEN secret; a minted token's own id otherwise. */
  tokenId: string;
  /**
   * The person behind the credential. Null for the domain's secret — matching
   * it reads no row, so the worker knows a request is the creator's without
   * knowing which *person* that is. The creator's member row exists (they are
   * in the People list, and attribution names them) but it is identity, never
   * authority: `POST /api/auth/members` is what writes it, and losing it
   * costs a name, not access. For an agent it is the person the agent
   * belongs to — null, again, when that is the creator.
   */
  memberId: string | null;
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

/** Resolve the bearer to an identity; `null` for nobody, "removed" for a
 *  credential an owner took away. */
export async function authenticate(request: Request, env: Env): Promise<Auth | "removed" | null> {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const bearer = header.slice("Bearer ".length).trim();
  if (!bearer) return null;
  const deviceId = deviceIdOf(request);

  const bearerHash = await sha256Hex(bearer);
  if (env.OWNER_TOKEN && timingEq(bearerHash, await sha256Hex(env.OWNER_TOKEN))) {
    return {
      role: "owner",
      creator: true,
      tokenId: "owner",
      memberId: null,
      email: null,
      name: "Owner",
      deviceId,
      agent: null,
    };
  }

  if (bearer.startsWith(AGENT_TOKEN_PREFIX)) {
    const agent = await resolveAgentToken(env, bearerHash);
    if (!agent) return null;
    await touchAgent(env, agent);
    return {
      role: "agent",
      creator: false,
      tokenId: agent.tokenId,
      memberId: agent.memberId,
      email: null,
      name: agent.name,
      deviceId,
      agent: { id: agent.agentId, scopes: agent.scopes },
    };
  }

  const identity = await resolveToken(env, bearerHash);
  if (!identity) return (await isRemovedToken(env, bearerHash)) ? "removed" : null;
  return {
    role: identity.role,
    creator: false,
    tokenId: identity.tokenId,
    memberId: identity.memberId,
    email: identity.email,
    name: identity.name,
    deviceId,
    agent: null,
  };
}
