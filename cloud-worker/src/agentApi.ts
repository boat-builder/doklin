// The document API — everything an agent says to the worker (docs/cloud.md
// §8.3–8.5). An agent is a bot with no copy of the folder: it works with a
// workspace through these routes and through nothing else, and what it may do
// here is what the owner ticked for it.
//
//   POST   /api/agent/login       NO BEARER — {code, host?} → 201 {token, agent, workspace,
//                                 version, features}; 401 when the code is unknown, used or
//                                 expired. One of the two routes above the gate (api.ts).
//   DELETE /api/agent/login       this token revokes itself (204)
//   GET    /api/agent/me          {agent, scopes, workspace, version, features}
//
//   read       GET    /api/agent/tree?dir=&deep=1
//              GET    /api/agent/doc?path=&v=[&clean=1][&info=1]
//              GET    /api/agent/comments?path=
//              GET    /api/agent/search?q=&dir=&limit=
//              GET    /api/agent/pages
//              GET    /api/agent/board?path=        GET /api/agent/cards?path=&by=&where=
//              GET    /api/agent/card?path=&card=
//   edit       PUT    /api/agent/doc?path=&v=[&force=1][&dry=1]      if-rev: <n> | *
//              DELETE /api/agent/doc?path=&v=[&dry=1]
//              POST   /api/agent/move               {from, to, dryRun?}
//              POST   /api/agent/board · POST/PATCH/DELETE /api/agent/card, /field, /option
//                                                   (agentBoards.ts says what each takes)
//   comment    POST   /api/agent/comments           {path, on, body, v?, dryRun?} | {path, thread, body, dryRun?}
//              DELETE /api/agent/comments?path=&thread=[&dry=1]
//   publish    PUT    /api/agent/pages              {path, slug?, title?, desc?, dryRun?}
//              DELETE /api/agent/pages?path= | ?slug=  [&dry=1]
//
// And the owner's side of it, beside the people routes:
//
//   POST   /api/auth/agents                    {name, scopes, codeHash, expiresAt} → 201 {agent}
//   GET    /api/auth/agents                    {agents} — each with its machines and pending code
//   POST   /api/auth/agents/<id>               {name?, scopes?}
//   POST   /api/auth/agents/<id>/code          {codeHash, expiresAt} → 201 {code}; replaces a pending one
//   DELETE /api/auth/agents/<id>               the agent and every token it holds (204)
//   DELETE /api/auth/agents/<id>/tokens/<tid>  one machine (204)
//
// The answers are JSON, except a document's content. A refusal is a sentence
// in `error` that says what to do next, because the reader is as likely to be
// a model as a person.

import {
  deleteCard,
  deleteField,
  deleteOption,
  getBoard,
  getCard,
  getCards,
  patchCard,
  patchField,
  patchOption,
  postBoard,
  postCard,
  postField,
  postOption,
} from "./agentBoards";
import type { AgentCaller, Call } from "./agentCall";
import { deleteComment, getComments, postComment } from "./agentComments";
import { deleteDoc, getDoc, getTree, postMove, putDoc } from "./agentDocs";
import { deletePage, getPages, putPage } from "./agentPages";
import {
  AGENT_ID_RE,
  AGENT_TOKEN_ID_RE,
  MAX_AGENT_CODE_TTL_MS,
  createAgent,
  deleteAgent,
  deleteAgentToken,
  deleteOwnToken,
  listAgents,
  normalizeAgentCode,
  parseScopes,
  putAgentCode,
  redeemAgentCode,
  updateAgent,
  type Scope,
} from "./agents";
import type { Auth } from "./auth";
import { readWorkspace } from "./bucket";
import { sha256Hex } from "./crypto";
import type { Env } from "./env";
import { json, readJsonObject } from "./http";
import { validName } from "./layout";
import { HASH_RE } from "./members";
import { getSearch } from "./search";
import { WORKER_FEATURES, WORKER_VERSION } from "./version";

const methodNotAllowed = (): Response => json({ error: "method not allowed" }, 405);
const noDatabase = (): Response => json({ error: "this domain has no database — update the worker" }, 503);

/** What the worker is, for a client deciding which commands it can offer. */
const about = async (env: Env): Promise<Record<string, unknown>> => {
  const workspace = await readWorkspace(env);
  return {
    workspace: workspace ? { id: workspace.id, name: workspace.name } : null,
    version: WORKER_VERSION,
    features: WORKER_FEATURES,
  };
};

/* ---------- Logging in ---------- */

/**
 * Trade a login code for this machine's own token — unauthenticated, for the
 * reason `POST /api/auth/join` is: answering it is how a bot gets a bearer.
 *
 * Unknown, used and expired answer identically. The code arrives in the
 * clear here and nowhere else; what the database holds is its sha256, so
 * nothing stored is itself redeemable.
 */
export async function agentLogin(request: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return json({ error: "invalid json body" }, 400);
  const code = normalizeAgentCode(body.code);
  if (!code) return json({ error: "that is not a Doklin login code — one looks like dkla-7QK2M-9XVR4-8TBHN-3WGYD" }, 400);
  const host = typeof body.host === "string" ? body.host : null;

  const result = await redeemAgentCode(env, await sha256Hex(code), host);
  if (result === null) return noDatabase();
  if (result === "unknown" || result === "expired") {
    return json({ error: "that login code is not valid — it has been used already, or it ran out. Ask for a new one." }, 401);
  }
  const { id, name, scopes } = result.agent;
  return json({ token: result.token, agent: { id, name }, scopes, ...(await about(env)) }, 201);
}

/* ---------- The routes an agent's token is answered on ---------- */

const MAY: Record<Scope, string> = {
  read: "read this workspace",
  comment: "comment",
  edit: "change documents",
  publish: "publish or stop publishing",
};

type Handler = (c: Call) => Promise<Response>;

/** Route → method → what it needs and what answers it. */
const ROUTES: Record<string, Partial<Record<string, [Scope, Handler]>>> = {
  tree: { GET: ["read", getTree] },
  doc: { GET: ["read", getDoc], PUT: ["edit", putDoc], DELETE: ["edit", deleteDoc] },
  move: { POST: ["edit", postMove] },
  comments: { GET: ["read", getComments], POST: ["comment", postComment], DELETE: ["comment", deleteComment] },
  search: { GET: ["read", getSearch] },
  pages: { GET: ["read", getPages], PUT: ["publish", putPage], DELETE: ["publish", deletePage] },
  board: { GET: ["read", getBoard], POST: ["edit", postBoard] },
  cards: { GET: ["read", getCards] },
  card: { GET: ["read", getCard], POST: ["edit", postCard], PATCH: ["edit", patchCard], DELETE: ["edit", deleteCard] },
  field: { POST: ["edit", postField], PATCH: ["edit", patchField], DELETE: ["edit", deleteField] },
  option: { POST: ["edit", postOption], PATCH: ["edit", patchOption], DELETE: ["edit", deleteOption] },
};

export async function handleAgent(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext | undefined,
  parts: string[],
  auth: Auth & { agent: NonNullable<Auth["agent"]> },
): Promise<Response> {
  if (parts.length !== 3) return json({ error: "not found" }, 404);
  const who: AgentCaller = { id: auth.agent.id, name: auth.name, tokenId: auth.tokenId, scopes: auth.agent.scopes };
  const route = parts[2];
  const method = request.method;

  if (route === "login") {
    // POST never reaches here — it is answered above the gate.
    if (method !== "DELETE") return methodNotAllowed();
    const gone = await deleteOwnToken(env, who.tokenId);
    return gone === null ? noDatabase() : new Response(null, { status: 204 });
  }
  if (route === "me") {
    if (method !== "GET") return methodNotAllowed();
    return json({ agent: { id: who.id, name: who.name }, scopes: who.scopes, ...(await about(env)) });
  }

  const methods = ROUTES[route];
  if (!methods) return json({ error: "not found" }, 404);
  const found = methods[method];
  if (!found) return methodNotAllowed();
  const [scope, handler] = found;
  if (!who.scopes.includes(scope)) {
    return json(
      {
        error: `this agent may not ${MAY[scope]} — the workspace's owner can allow it in Doklin, under Cloud → People → Agents`,
        need: scope,
        scopes: who.scopes,
      },
      403,
    );
  }
  return handler({ request, env, url, ctx, who });
}

/* ---------- The owner's side: /api/auth/agents… ---------- */

/** `expiresAt` from a request body, or null when it is not a time a login
 *  code may run to. */
function codeExpiry(raw: unknown): number | null {
  const now = Date.now();
  const at = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : 0;
  return at > now && at <= now + MAX_AGENT_CODE_TTL_MS ? at : null;
}

const badExpiry = (): Response =>
  json({ error: `expiresAt must be a time within the next ${MAX_AGENT_CODE_TTL_MS / 3_600_000} hours` }, 400);
const badHash = (): Response => json({ error: "codeHash must be the sha256 of the code, in hex" }, 400);
const codeHashOf = (raw: unknown): string | null => {
  const hash = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return HASH_RE.test(hash) ? hash : null;
};

/** Everything under /api/auth/agents — owner-only, checked by the caller. */
export async function handleAgentAdmin(request: Request, env: Env, parts: string[]): Promise<Response> {
  const method = request.method;
  const id = parts[3];
  const sub = parts[4];
  const subId = parts[5];

  if (id === undefined) {
    if (method === "GET") {
      const agents = await listAgents(env);
      return agents === null ? noDatabase() : json({ agents });
    }
    if (method !== "POST") return methodNotAllowed();
    const body = await readJsonObject(request);
    if (!body) return json({ error: "invalid json body" }, 400);
    const name = validName(body.name, "");
    if (!name) return json({ error: "an agent needs a name" }, 400);
    const scopes = parseScopes(body.scopes);
    if (!scopes) return json({ error: "scopes is a list drawn from: read, comment, edit, publish" }, 400);
    const codeHash = codeHashOf(body.codeHash);
    if (!codeHash) return badHash();
    const expiresAt = codeExpiry(body.expiresAt);
    if (expiresAt === null) return badExpiry();
    const agent = await createAgent(env, name, scopes, codeHash, expiresAt);
    return agent === null ? noDatabase() : json({ agent }, 201);
  }

  if (!AGENT_ID_RE.test(id)) return json({ error: "invalid agent id" }, 400);
  const noAgent = (): Response => json({ error: "no such agent" }, 404);

  if (sub === undefined) {
    if (method === "DELETE") {
      const gone = await deleteAgent(env, id);
      if (gone === null) return noDatabase();
      return gone ? new Response(null, { status: 204 }) : noAgent();
    }
    if (method !== "POST") return methodNotAllowed();
    const body = await readJsonObject(request);
    if (!body) return json({ error: "invalid json body" }, 400);
    const change: { name?: string; scopes?: Scope[] } = {};
    if (body.name !== undefined) {
      const name = validName(body.name, "");
      if (!name) return json({ error: "an agent needs a name" }, 400);
      change.name = name;
    }
    if (body.scopes !== undefined) {
      const scopes = parseScopes(body.scopes);
      if (!scopes) return json({ error: "scopes is a list drawn from: read, comment, edit, publish" }, 400);
      change.scopes = scopes;
    }
    const updated = await updateAgent(env, id, change);
    if (updated === null) return noDatabase();
    return updated ? json({ updated: true }) : noAgent();
  }

  if (sub === "code" && subId === undefined) {
    if (method !== "POST") return methodNotAllowed();
    const body = await readJsonObject(request);
    if (!body) return json({ error: "invalid json body" }, 400);
    const codeHash = codeHashOf(body.codeHash);
    if (!codeHash) return badHash();
    const expiresAt = codeExpiry(body.expiresAt);
    if (expiresAt === null) return badExpiry();
    const code = await putAgentCode(env, id, codeHash, expiresAt);
    if (code === null) return noDatabase();
    return code ? json({ code }, 201) : noAgent();
  }

  if (sub === "tokens" && subId !== undefined && parts.length === 6) {
    if (method !== "DELETE") return methodNotAllowed();
    if (!AGENT_TOKEN_ID_RE.test(subId)) return json({ error: "invalid token id" }, 400);
    const gone = await deleteAgentToken(env, id, subId);
    if (gone === null) return noDatabase();
    return gone ? new Response(null, { status: 204 }) : json({ error: "no such machine" }, 404);
  }

  return json({ error: "not found" }, 404);
}
