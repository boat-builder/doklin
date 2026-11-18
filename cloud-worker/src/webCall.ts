// What every handler of the browser version's routes is handed, and what
// they all do the same way. In a file of its own so the route modules can
// share it without importing each other.

import type { Auth } from "./auth";
import { Refusal } from "./commit";
import type { Env } from "./env";
import { json } from "./http";
import { SPACE_ID_RE } from "./layout";
import { openSpace, sharedEnv, spaceEnv, type Where } from "./spaces";

export type WebCall = {
  request: Request;
  env: Env;
  url: URL;
  /** Absent under test, where work that would run after the response is awaited instead. */
  ctx: ExecutionContext | undefined;
  /** The person at the browser: what they change is signed with `memberId`. */
  auth: Auth;
};

export const refuse = (r: Refusal): Response => json({ error: r.error, ...r.extra }, r.status);

/** A path as a request names one, without the slashes around it. */
export const trimSlashes = (raw: unknown): string => (typeof raw === "string" ? raw.replace(/^\/+|\/+$/g, "") : "");

/**
 * The section a request names — "" or nothing is the shared workspace —
 * when its person is in it. One they are not in and one that does not exist
 * are one answer (spaces.ts). Its paths are as it stores them: mounted at "".
 */
export async function sectionOf(c: Pick<WebCall, "env" | "auth">, raw: unknown): Promise<Where | Refusal> {
  const id = raw ?? "";
  if (id === "") return { space: "", mount: "", env: sharedEnv(c.env) };
  if (typeof id !== "string" || !SPACE_ID_RE.test(id)) return new Refusal(400, "that is not a section of this workspace");
  const space = await openSpace(c.env, c.auth, id);
  if (space === null) return new Refusal(503, "the domain's database isn't answering — try again in a moment");
  if (space === "none") return new Refusal(404, "that section is gone, or you are no longer in it");
  return { space: id, mount: "", env: spaceEnv(c.env, id) };
}
