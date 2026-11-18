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
// A browser has no bearer. Its sign-in is the same kind of row, carried by a
// cookie that script cannot read (`__Host-doklin`: HttpOnly, Secure,
// SameSite=Strict), and the cookie counts only on a request the app's own
// script made (`ownScript`). The token says it is a browser's in its first
// characters, and the two ways in are kept apart both ways: a browser's token
// sent as a bearer is nobody, and so is any other token sent as the cookie.
// `Auth.browser` is what narrows it from there (web.ts).
//
// The three routes above this gate are `POST /api/auth/join`,
// `POST /api/agent/login` and `POST /api/web/session`, which have to answer
// without a credential because answering them is how a Mac, a bot or a
// browser GETS one (api.ts).

import { AGENT_TOKEN_PREFIX, resolveAgentToken, touchAgent, type Scope } from "./agents";
import { sha256Hex, timingEq } from "./crypto";
import type { Env } from "./env";
import { ID_RE } from "./layout";
import { BROWSER_TOKEN_PREFIX, isRemovedToken, resolveToken } from "./members";
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
  /** The credential is a browser's sign-in, which came by its cookie. It is
   *  answered on the browser version's routes and no others (web.ts). */
  browser: boolean;
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

/* ---------- A browser's sign-in ---------- */

/** `__Host-`: a browser keeps it only when it came over TLS with `Secure`,
 *  `Path=/` and no `Domain`, so nothing on another host of the zone, and
 *  nothing unencrypted, can set or shadow it. */
const SESSION_COOKIE = "__Host-doklin";
const COOKIE_ATTRIBUTES = "Path=/; Secure; HttpOnly; SameSite=Strict";
/** How long a browser keeps the cookie, in seconds: 400 days, the most a
 *  browser will keep any. The probe sets it again (api.ts), so a browser in
 *  use never runs out. */
const SESSION_MAX_AGE = 400 * 24 * 60 * 60;

/** The header that hands a browser its sign-in. */
export const sessionCookie = (token: string): string => `${SESSION_COOKIE}=${token}; ${COOKIE_ATTRIBUTES}; Max-Age=${SESSION_MAX_AGE}`;

/** The header that takes the cookie back: sent with a `401` to a cookie
 *  that is nobody's, so the browser stops carrying it. */
export const NO_SESSION_COOKIE = `${SESSION_COOKIE}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`;

/**
 * What a browser is told when its sign-in ends — it signed out, or an owner
 * took its access away: the cookie goes, and so does everything the app kept
 * on that computer (the documents the browser cached, the drafts and open
 * tabs it remembered). A Mac that hears it was removed deletes its copy of
 * the workspace; this is a browser doing the same.
 */
export const SIGNED_OUT: Readonly<Record<string, string>> = {
  "set-cookie": NO_SESSION_COOKIE,
  "clear-site-data": '"cache", "storage"',
};

/**
 * Whether script on a page of this domain made the request, as the browser
 * itself says in headers no page can set: same origin, by `fetch`, to no
 * element. A cookie is sent with every request to its site, so this is what
 * keeps anything else on the domain from borrowing a sign-in — a public page
 * is somebody's markdown and may hold an `<img>`, a link or a form pointed
 * anywhere, but it runs no script (its policy, public.ts) — and what keeps
 * another site from signing a browser in to an account of its own choosing.
 */
export function ownScript(request: Request): boolean {
  const h = request.headers;
  const mode = h.get("sec-fetch-mode");
  return h.get("sec-fetch-site") === "same-origin" && h.get("sec-fetch-dest") === "empty" && (mode === "cors" || mode === "same-origin");
}

/** The browser sign-in a request carries, or null: only with no
 *  `Authorization` header, and only from the app's own script. */
export function sessionOf(request: Request): string | null {
  if (request.headers.has("authorization") || !ownScript(request)) return null;
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === SESSION_COOKIE) return value.join("=") || null;
  }
  return null;
}

/** The sha256 of the domain's key when the bearer is it — what a spent key
 *  is remembered by — and null otherwise. Constant time, no database read. */
export async function keyHashOf(request: Request, env: Env): Promise<string | null> {
  const bearer = bearerOf(request);
  if (!bearer || !env.OWNER_TOKEN) return null;
  const [given, key] = await Promise.all([sha256Hex(bearer), sha256Hex(env.OWNER_TOKEN)]);
  return timingEq(given, key) ? given : null;
}

/** Resolve the credential — a bearer, or a browser's cookie — to an
 *  identity: `null` for nobody, "removed" for one an owner took away,
 *  "unavailable" when the database could not say which. */
export async function authenticate(request: Request, env: Env): Promise<Auth | "removed" | "unavailable" | null> {
  const session = sessionOf(request);
  const bearer = session ?? bearerOf(request);
  if (!bearer) return null;
  // A browser's sign-in comes by the cookie and nothing else does.
  const browser = session !== null;
  if (bearer.startsWith(BROWSER_TOKEN_PREFIX) !== browser) return null;
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
      browser: false,
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
    browser,
  };
}
