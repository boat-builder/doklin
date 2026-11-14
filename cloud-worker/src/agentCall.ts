// What every document-API handler is handed, and the answers they all give
// the same way. In a file of its own so the route modules can share it
// without importing each other.

import type { Places, Section } from "./agentPlace";
import type { Scope } from "./agents";
import { commit, type Committed, type Refusal, type Tx } from "./commit";
import type { Env } from "./env";
import { json } from "./http";
import type { Manifest } from "./manifest";
import { mounted } from "./mount";
import { openWorkspace } from "./workspace";

/** Who is asking: the id a change is signed with, the name a comment carries,
 *  and what its person ticked. */
export type AgentCaller = { id: string; name: string; tokenId: string; scopes: readonly Scope[] };

export type Call = {
  request: Request;
  /** The section this call is answered in: its part of the bucket. The
   *  shared workspace until a route's path says otherwise (agentApi.ts). */
  env: Env;
  /** The folder that section is at, as the caller names paths — "" for the
   *  shared workspace. Every path a handler reads, writes or says is under it. */
  mount: string;
  url: URL;
  /** Absent under test, where work that would run after the response is awaited instead. */
  ctx: ExecutionContext | undefined;
  who: AgentCaller;
  /** Every section the agent's person can see. */
  places: Places;
};

/** The same call, answered in `section`. */
export const inSection = (c: Call, section: Section): Call => ({ ...c, env: section.env, mount: section.mount });

/** The tree a call is in, under the names its caller uses — or null when the
 *  domain holds no workspace. */
export async function openTree(c: Pick<Call, "env" | "mount">): Promise<{ etag: string; manifest: Manifest } | null> {
  const ws = await openWorkspace(c.env);
  return ws ? { etag: ws.etag, manifest: mounted(ws.manifest, c.mount) } : null;
}

/** `commit` in the section a call is in, signed with its agent. */
export const change = <T>(
  c: Pick<Call, "env" | "mount" | "who">,
  fn: (tx: Tx) => Promise<T | Refusal>,
  dryRun = false,
): Promise<Committed<T> | Refusal> => commit(c.env, c.who.id, fn, { dryRun, mount: c.mount });

export const refuse = (r: Refusal): Response => json({ error: r.error, ...r.extra }, r.status);
export const notBound = (): Response => json({ error: "this domain holds no workspace yet" }, 404);
