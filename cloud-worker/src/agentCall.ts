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
import { MAX_SECTIONS_READ } from "./spaces";
import { openWorkspace } from "./workspace";

/** Who is asking: the id a change is signed with, the name a comment carries,
 *  and what its person ticked. */
export type AgentCaller = { id: string; name: string; tokenId: string; scopes: readonly Scope[] };

export type Call = {
  request: Request;
  /** The section this call is answered in: its part of the bucket. The
   *  whole domain's until a route's path names a section (agentApi.ts). */
  env: Env;
  /** The folder that section is at, as the caller names paths: `Library`,
   *  `My files`, `Shared with me/Finance` — "" until a path names one. Every
   *  path a handler reads, writes or says is under it. */
  mount: string;
  /** A shared document's name as stored and as shown there (mount.ts). */
  named?: Section["named"];
  /** The section itself, once a path named one. */
  section?: Section;
  url: URL;
  /** Absent under test, where work that would run after the response is awaited instead. */
  ctx: ExecutionContext | undefined;
  who: AgentCaller;
  /** Every section the agent's person can see. */
  places: Places;
};

/** The same call, answered in `section`. */
export const inSection = (c: Call, section: Section): Call => ({
  ...c,
  env: section.env,
  mount: section.mount,
  named: section.named,
  section,
});

/** The tree a call is in, under the names its caller uses — or null when the
 *  domain holds no workspace. */
export async function openTree(c: Pick<Call, "env" | "mount" | "named">): Promise<{ etag: string; manifest: Manifest } | null> {
  const ws = await openWorkspace(c.env);
  return ws ? { etag: ws.etag, manifest: mounted(ws.manifest, c) } : null;
}

/** `commit` in the section a call is in, signed with its agent. */
export const change = <T>(
  c: Pick<Call, "env" | "mount" | "named" | "who">,
  fn: (tx: Tx) => Promise<T | Refusal>,
  dryRun = false,
): Promise<Committed<T> | Refusal> => commit(c.env, c.who.id, fn, { dryRun, at: c });

/** How many sections one request opens (`MAX_SECTIONS_READ`, and Library). */
export const PAGE = 1 + MAX_SECTIONS_READ;

/**
 * Where a request that reads section after section starts: how many of them
 * the requests before it covered (`after`). Every shared document is a
 * section, so a listing or a search of more than one is often more than a
 * request opens: its answer then carries `next`, and the caller asks again
 * with `after` set to it.
 */
export function cursorOf(url: URL): number {
  const n = Number(url.searchParams.get("after") ?? "0");
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export const refuse = (r: Refusal): Response => json({ error: r.error, ...r.extra }, r.status);
export const notBound = (): Response => json({ error: "this domain holds no workspace yet" }, 404);
