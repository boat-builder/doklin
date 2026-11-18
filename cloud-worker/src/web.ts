// The browser version — what a browser says to the worker.
//
// A browser is a device of its person's that holds no copy of the workspace.
// It reads what a Mac reads — the poll, the manifests, the stored copies —
// and it builds no manifest: what it changes, the worker writes for it
// (commit.ts), the way it writes an agent's changes, so a Mac cannot tell
// either from another Mac's.
//
// These routes are a person's. They are not the document API (agentApi.ts)
// with its limits taken off, and nothing here is routed to that: an agent has
// scopes, is told things in sentences written for a model, may try a change
// dry, and may never move a comment thread by writing content; a person has
// the run of what they can see, and a thread is theirs to move or remove.
// What the two share is beneath both — the commit, what a removal or a move
// does to the manifest (changes.ts), publishing's rules (publishing.ts), the
// search (search.ts).
//
// A section is named by its id — "" the shared workspace, a space's id
// otherwise — and a path is as that section stores it: the browser holds
// each section's manifest and speaks in its terms. No folder name stands for
// a section here, as `Private/` does for an agent.
//
//   POST   /api/web/session            NO CREDENTIAL — {code, deviceId?, deviceName?} → 201
//                                      {tokenId, member} and the cookie that is the sign-in.
//                                      The token itself is in no body: script never holds it.
//                                      401 when the code is unknown or expired. Answered only
//                                      to the app's own script (auth.ts, `ownScript`)
//
//   PUT    /api/web/doc?space=&path=   {md?: {text, ifRev}, meta?: {text, ifRev}} → {md?, meta?,
//                                      etag}: a note and its comments in ONE write. `ifRev` is
//                                      the revision that was read, or null for a file that must
//                                      not exist yet. 409 {part, rev} when either moved on —
//                                      and then nothing was written
//   DELETE /api/web/doc?space=&path=[&v=md|html]   the document, or one version of two
//   DELETE /api/web/folder?space=&path=            everything under a folder
//   POST   /api/web/move               {from: {space, path}, to: {space, path}, kind: "document" |
//                                      "folder"}: to exactly `to`, in the same section or another
//   GET    /api/web/search?q=&limit=   every section the person is in (search.ts); 202
//                                      {indexing, pending} while the mirror catches up
//   PUT    /api/web/pages              {space, path, kind, slug?, title?, desc?} → {slug, url, …}
//   DELETE /api/web/pages?slug=        stop a page, in whichever section of theirs holds it
//   PUT    /api/web/home               {slug: string | null}: the page at `/`, or none
//
// A browser's sign-in is answered here and on the routes `ALSO` lists, and on
// nothing else — and that is a property of the sign-in, not of the cookie: a
// browser's token is refused as a bearer (auth.ts). What is left out is what
// a browser has no use for, so a page that somehow ran script on this domain
// could not reach it either: putting a manifest or a stored copy, the version
// store, people and their invites, devices and their codes, agents, binding
// and erasing the domain.

import { ownScript, sessionCookie, type Auth } from "./auth";
import { sha256Hex } from "./crypto";
import type { Env } from "./env";
import { json, readJsonObject } from "./http";
import { ID_RE } from "./layout";
import { normalizeCode, redeemInvite } from "./members";
import type { WebCall } from "./webCall";
import { deleteDoc, deleteFolder, getSearch, postMove, putDoc } from "./webDocs";
import { deletePage, putHome, putPage } from "./webPages";

/* ---------- Signing in ---------- */

/**
 * Trade a code for this browser's sign-in. The code is the one a Mac's join
 * takes (`POST /api/auth/join`): an invite, or a code for another device of
 * one's own. The row it makes is a device's like any other, listed and signed
 * out with the rest — and what comes back is the cookie, never the token.
 */
export async function signIn(request: Request, env: Env): Promise<Response> {
  // Only the app's own page signs a browser in: another site, or a form on a
  // public page, could otherwise sign somebody in to an account of its choosing.
  if (!ownScript(request)) return json({ error: "sign in from the workspace's own page, at /app" }, 403);
  const body = await readJsonObject(request);
  if (!body) return json({ error: "invalid json body" }, 400);
  const code = normalizeCode(body.code);
  if (!code) return json({ error: "that is not a Doklin invite code" }, 400);
  const id = typeof body.deviceId === "string" && ID_RE.test(body.deviceId) ? body.deviceId : null;
  const name = typeof body.deviceName === "string" ? body.deviceName : null;

  const redeemed = await redeemInvite(env, await sha256Hex(code), { id, name, browser: true });
  if (redeemed === null) {
    return json({ error: env.DB ? "the domain's database isn't answering — try again in a moment" : "this domain's worker has no database bound to it" }, 503);
  }
  if (redeemed === "unknown" || redeemed === "expired") return json({ error: "that code is not valid" }, 401);
  return json({ tokenId: redeemed.tokenId, member: redeemed.member }, 201, { "set-cookie": sessionCookie(redeemed.token) });
}

/* ---------- What else a browser's sign-in is answered on ---------- */

/** Outside /api/web: the reads a client with no copy of the workspace is
 *  built from, the beat that says where it is, its person's own Private, and
 *  its own sign-out. By method and by the path after `/api/`. */
const ALSO: readonly (readonly [method: string, path: RegExp])[] = [
  ["GET", /^meta$/],
  ["GET", /^poll$/],
  ["POST", /^poll$/],
  ["GET", /^manifest$/],
  ["GET", /^blobs\/[^/]+\/[^/]+$/],
  ["PUT", /^spaces\/private$/],
  ["GET", /^spaces\/[^/]+\/manifest$/],
  ["GET", /^spaces\/[^/]+\/blobs\/[^/]+\/[^/]+$/],
  ["GET", /^pages$/],
  ["DELETE", /^auth\/session$/],
];

/** Whether a browser's sign-in is answered on a route outside /api/web. */
export function browserMay(method: string, parts: readonly string[]): boolean {
  const path = parts.slice(1).join("/");
  return ALSO.some(([m, re]) => m === method && re.test(path));
}

/* ---------- The routes ---------- */

type Handler = (c: WebCall) => Promise<Response>;

const ROUTES: Record<string, Partial<Record<string, Handler>>> = {
  doc: { PUT: putDoc, DELETE: deleteDoc },
  folder: { DELETE: deleteFolder },
  move: { POST: postMove },
  search: { GET: getSearch },
  pages: { PUT: putPage, DELETE: deletePage },
  home: { PUT: putHome },
  // POST is answered above the gate (api.ts); nothing else is asked of it.
  session: {},
};

export async function handleWeb(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext | undefined,
  parts: readonly string[],
  auth: Auth,
): Promise<Response> {
  const methods = parts.length === 3 ? ROUTES[parts[2]] : undefined;
  if (!methods) return json({ error: "not found" }, 404);
  const handler = methods[request.method];
  if (!handler) return json({ error: "method not allowed" }, 405);
  return handler({ request, env, url, ctx, auth });
}
