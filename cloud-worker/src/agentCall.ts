// What every document-API handler is handed, and the two answers they all
// give the same way. In a file of its own so the route modules can share it
// without importing each other.

import type { Scope } from "./agents";
import type { Refusal } from "./commit";
import type { Env } from "./env";
import { json } from "./http";

/** Who is asking: the id a change is signed with, the name a comment carries,
 *  and what the owner ticked. */
export type AgentCaller = { id: string; name: string; tokenId: string; scopes: readonly Scope[] };

export type Call = {
  request: Request;
  env: Env;
  url: URL;
  /** Absent under test, where work that would run after the response is awaited instead. */
  ctx: ExecutionContext | undefined;
  who: AgentCaller;
};

export const refuse = (r: Refusal): Response => json({ error: r.error, ...r.extra }, r.status);
export const notBound = (): Response => json({ error: "this domain holds no workspace yet" }, 404);
