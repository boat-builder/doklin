// Who is calling. Every /api route but one runs through `authenticate`: the
// bearer is hashed, compared with the owner secret's hash in constant time,
// and — when that is not it — resolved against the `tokens` table as the
// person who holds it (docs/cloud.md §5.4, teams-plan.md §3.2, §9).
//
// The order is the design, not an optimization. The owner's credential is the
// worker's env secret and is matched with NO database read, so a D1 outage
// degrades a workspace to one credential rather than locking its owner out of
// their own domain. Only a bearer that is *not* the owner's costs a row read.
//
// Storing tokens by the sha256 of the token makes resolving a bearer one
// primary-key lookup and makes revocation — delete the row — take effect on
// the very next request: there is no session, so there is nothing to expire.
//
// The one route above this gate is `POST /api/auth/join`, which has to answer
// without a bearer because answering it is how a Mac GETS one (api.ts).

import { sha256Hex, timingEq } from "./crypto";
import type { Env } from "./env";
import { ID_RE } from "./layout";
import { resolveToken } from "./members";

export type Role = "owner" | "member";

export type Auth = {
  role: Role;
  /** "owner" for the OWNER_TOKEN secret; a minted token's own id otherwise. */
  tokenId: string;
  /**
   * The person behind the credential. Null for the owner secret — matching it
   * reads no row, so the worker knows a request is the owner's without
   * knowing which *person* that is. The owner's member row exists (they are
   * in the People list, and attribution names them) but it is identity, never
   * authority: `POST /api/auth/members` is what writes it, and losing it
   * costs a name, not access.
   */
  memberId: string | null;
  email: string | null;
  name: string;
  /** The calling device, from x-doklin-device (null when the header is missing or malformed). */
  deviceId: string | null;
};

export { randomHex } from "./crypto";

/** The device a request speaks for (`x-doklin-device`), or null. Attribution only — never authority. */
function deviceIdOf(request: Request): string | null {
  const id = request.headers.get("x-doklin-device")?.trim() ?? "";
  return ID_RE.test(id) ? id : null;
}

/** Resolve the bearer to an identity, or null. */
export async function authenticate(request: Request, env: Env): Promise<Auth | null> {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const bearer = header.slice("Bearer ".length).trim();
  if (!bearer) return null;
  const deviceId = deviceIdOf(request);

  const bearerHash = await sha256Hex(bearer);
  if (env.OWNER_TOKEN && timingEq(bearerHash, await sha256Hex(env.OWNER_TOKEN))) {
    return { role: "owner", tokenId: "owner", memberId: null, email: null, name: "Owner", deviceId };
  }

  const identity = await resolveToken(env, bearerHash);
  if (!identity) return null;
  // Always `member`, whatever role that person's row carries. The role column
  // describes a person, for the People list; owner authority comes from the
  // env secret and from nowhere else, so no row anybody can write — including
  // the owner's own, invited to their own address — can confer it.
  return {
    role: "member",
    tokenId: identity.tokenId,
    memberId: identity.memberId,
    email: identity.email,
    name: identity.name,
    deviceId,
  };
}
