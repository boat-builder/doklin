// The authenticated API — everything the engine says to the worker.
// JSON in, JSON out, a bearer on
// every request; the engine is the only caller, so there is no CORS and no
// preflight. Every request also carries `x-doklin-device` (attribution for
// presence and the binding) and `x-doklin-client` (the app version, for
// the logs — nothing reads it).
//
//   GET    /api/meta                 {version, features, workspace|null, d1: schema version|null,
//                                    you: who this bearer is — {role, creator, memberId, email,
//                                    name, can: [what that role may do]}, people: [{id, name}] —
//                                    the directory a manifest's `by` is read with}
//   POST   /api/workspace            owner; bind this domain: body {name, deviceName?,
//                                    ownerEmail?, ownerName?} → 201 (+ {owner} when named)
//                                    409 {workspace} when it already holds one (never overwrites)
//   GET    /api/workspace            {id, name, createdAt, createdBy, files, bytes}
//   GET    /api/poll                 {manifestEtag, presence, leases} — the cheap 15 s poll; reads only
//   POST   /api/poll                 the same poll, carrying this device's beat:
//                                    body {name, path?, take?} — "here, editing path", which claims
//                                    its lease (take: from whoever holds it) and lets go of any
//                                    other — or {leave: true}. Presence and leases are best effort:
//                                    a database that cannot answer costs the lists ({} and null
//                                    come back), never the etag
//   GET    /api/manifest[?since=e]   the manifest + x-manifest-etag (304 when unchanged)
//   PUT    /api/manifest             x-base-etag required; 412 + current etag on a lost race;
//                                    400 on garbage, 426 on a schema this worker predates
//   GET    /api/blobs/<fid>          {blobs: [{hash, size, uploaded}]} — the inventory GC diffs
//   GET    /api/blobs/<fid>/<hash>   the bytes
//   PUT    /api/blobs/<fid>/<hash>   store bytes (immutable — a re-PUT of the same hash is a no-op)
//   DELETE /api/blobs/<fid>/<hash>   garbage-collect an unreferenced revision
//   GET    /api/versions/index       the version store's index + x-versions-etag; 404 when none
//   PUT    /api/versions/index       x-base-etag required ("*" creates); 412 + etag on a lost race
//   GET    /api/versions/snapshots/<id>   the gzip'd workspace state
//   PUT    /api/versions/snapshots/<id>   create-only ({existed:true} on a re-PUT)
//   DELETE /api/versions/snapshots/<id>
//   GET    /api/versions/blobs[?cursor=c] {blobs: [...], cursor?} — one page of the inventory
//   GET    /api/versions/blobs/<hash>     the bytes
//   PUT    /api/versions/blobs/<hash>     create-only
//   DELETE /api/versions/blobs/<hash>     garbage-collect an unreferenced version
//   POST   /api/admin/wipe           owner; body {"confirm":"wipe"} — erase everything, batched;
//                                    repeat until remaining:false. Frees the domain.
//
//   People. Everything here is the D1 database beside
//   the bucket; a deployment without one answers 503 and loses nothing else.
//   Who may call what is one table (roles.ts): "owner" below is anyone whose
//   role is — the domain's secret, or a person an owner made one — and
//   "creator" is the secret alone. A refusal is 403.
//
//   POST   /api/auth/join            NO BEARER — {code, deviceId?, deviceName?} → 201
//                                    {token, tokenId, member}; 401 when the code is unknown or
//                                    expired (the row goes either way). The ONE route above the
//                                    authenticate gate, matched on method AND path exactly,
//                                    because answering it is how a Mac gets a bearer at all.
//   POST   /api/auth/invites         owner; {email, name?, codeHash, expiresAt} → 201 {invite};
//                                    creates the member if the email is new, and replaces any
//                                    invite they already had. The worker never sees the code.
//   GET    /api/auth/invites         owner; the pending, unexpired ones
//   DELETE /api/auth/invites/<id>    owner; withdraw one (204)
//   GET    /api/auth/members         everyone, with a role, a device count and lastSeenAt — the
//                                    People list, which every person here may read
//   POST   /api/auth/members         creator; {email, name?} — say (or change) who holds the
//                                    domain's secret, for attribution and the People list
//   PATCH  /api/auth/members/<id>    owner; {role: "owner" | "member"} → {member}. Never your own
//                                    row, never the creator's (409)
//   DELETE /api/auth/members/<id>    owner; the person and every credential they hold (204).
//                                    Never your own row, never the creator's (409)
//   GET    /api/auth/tokens          owner; {id, memberId, email, deviceName, createdAt} — never a hash
//   DELETE /api/auth/tokens/<id>     owner; revoke one device, effective on its next request (204)
//
//   A credential an owner took away — a person removed, a Mac signed out — is answered
//   `401 {error, removed: true}` on every route from then on, where any other bearer nobody
//   holds is a bare 401. The difference is the app's cue to delete that Mac's copy
//   of the workspace, so it is only ever said of a token `removed_tokens` remembers.
//
//   Agents. An agent's token is answered under /api/agent and nowhere
//   else — every route above answers one with 403 — and the routes that manage agents sit
//   beside the people routes, an owner's like them. Both are listed in agentApi.ts.
//
//   POST   /api/agent/login          NO BEARER — the second route above the gate
//   *      /api/agent/…              an agent's token only: the document API
//   *      /api/auth/agents…         owner; add, list, change and remove agents

import { agentLogin, handleAgent, handleAgentAdmin } from "./agentApi";
import { authenticate, type Auth } from "./auth";
import { randomHex } from "./crypto";
import { readManifestTotals, readWorkspace, type WorkspaceRecord } from "./bucket";
import type { Env } from "./env";
import { json, readJsonObject } from "./http";
import {
  BLOB_HASH_RE,
  ID_RE,
  MANIFEST_KEY,
  MAX_FILE_BYTES,
  MAX_MANIFEST_BYTES,
  WORKSPACE_KEY,
  blobKey,
  blobPrefix,
  validName,
  validPath,
} from "./layout";
import { emptyManifest, validateManifest } from "./manifest";
import {
  ENTITY_ID_RE,
  HASH_RE,
  MAX_INVITE_TTL_MS,
  adoptCreator,
  deleteInvite,
  deleteMember,
  deleteToken,
  findCreator,
  findMemberByEmail,
  listDirectory,
  listInvites,
  listMembers,
  listTokens,
  normalizeCode,
  normalizeEmail,
  putInvite,
  redeemInvite,
  setMemberRole,
  upsertMember,
} from "./members";
import { sha256Hex } from "./crypto";
import { readHere, recordBeat, type Beat, type Here } from "./presence";
import { allowed, can } from "./roles";
import { ensureSchema, wipeSchema } from "./schema";
import { WORKER_FEATURES, WORKER_VERSION } from "./version";
import { handleVersions } from "./versions";

const JSON_OBJECT = { httpMetadata: { contentType: "application/json" } };

const methodNotAllowed = (): Response => json({ error: "method not allowed" }, 405);
/** What `can` said no to (roles.ts). Today every such action is an owner's. */
const notAllowed = (): Response => json({ error: "only an owner can do that" }, 403);
const notBound = (): Response => json({ error: "not bound" }, 404);

export async function handleApi(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext | undefined,
): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", section, …]

  // The one route above the gate. Redeeming an invite is how a Mac GETS a
  // bearer, so it cannot be behind one — and the carve-out is method AND
  // path, exactly, so `GET /api/auth/join`, `POST /api/auth/joinx` and every
  // other route under /api/auth still meet `authenticate` below.
  if (request.method === "POST" && parts.length === 3 && parts[1] === "auth" && parts[2] === "join") {
    return joinWithInvite(request, env);
  }
  // The other one, for the same reason: `doklin login` is how a bot gets a
  // bearer. Method and path exactly, again — `DELETE /api/agent/login` is a
  // token revoking itself, and meets the gate like everything else.
  if (request.method === "POST" && parts.length === 3 && parts[1] === "agent" && parts[2] === "login") {
    return agentLogin(request, env);
  }

  const auth = await authenticate(request, env);
  // Said only of a credential the database remembers an owner taking away:
  // the Mac that hears `removed` deletes its copy of the workspace.
  if (auth === "removed") return json({ error: "your access to this workspace was removed", removed: true }, 401);
  if (!auth) return json({ error: "unauthorized" }, 401);

  const section = parts[1];
  const method = request.method;

  // An agent's token and the document API belong to each other, both ways.
  // A token that could `PUT /api/manifest` could rewrite the whole workspace,
  // and then no permission on its row would mean anything — so an agent gets
  // nothing but /api/agent. And a person's credential is not a limited
  // account, so it has no business on routes whose whole point is the limit.
  if (auth.agent) {
    if (section !== "agent") {
      return json({ error: "an agent's token works on the document API only — /api/agent" }, 403);
    }
    return handleAgent(request, env, url, ctx, parts, { ...auth, agent: auth.agent });
  }
  if (section === "agent") {
    return json({ error: "the document API is for agents — add one in Doklin, under Cloud → People → Agents" }, 403);
  }

  // The probe: liveness, the credential, the version and "is this domain
  // bound" in one call — what the setup wizard asks before touching anything.
  if (section === "meta" && parts.length === 2) {
    if (method !== "GET") return methodNotAllowed();
    // The probe is also where the database migrates itself: it is the one
    // route every engine calls on start and on every poll, and the only one
    // that reports what it found. `d1` is the schema version, or null on a
    // deployment whose wrangler.toml has no DB binding.
    //
    // Since v6 it also answers identity: who the caller is, and what every
    // person here is called. Both belong on the route an engine already asks
    // before it writes anything — a manifest it PUTs signs with `you.memberId`
    // and every `by` it reads resolves through `people`.
    const [workspace, d1, you, people] = await Promise.all([
      readWorkspace(env),
      ensureSchema(env),
      whoIs(env, auth),
      listDirectory(env),
    ]);
    return json({ version: WORKER_VERSION, features: WORKER_FEATURES, workspace, d1, you, people: people ?? [] });
  }

  if (section === "workspace" && parts.length === 2) {
    if (method === "POST") {
      if (!can(auth.role, "workspace.manage")) return notAllowed();
      return bindWorkspace(request, env, auth);
    }
    if (method === "GET") {
      const workspace = await readWorkspace(env);
      if (!workspace) return notBound();
      return json({ ...workspace, ...(await readManifestTotals(env)) });
    }
    return methodNotAllowed();
  }

  // The work itself — the poll, the manifest, the blobs, the version store.
  // Both roles hold it today; a role that did not would stop here.
  const working = section === "poll" || section === "manifest" || section === "blobs" || section === "versions";
  if (working && !can(auth.role, "work")) return notAllowed();

  if (section === "poll" && parts.length === 2) {
    if (method !== "GET" && method !== "POST") return methodNotAllowed();
    return poll(request, env, auth);
  }

  if (section === "manifest" && parts.length === 2) {
    if (method === "GET") return getManifest(env, url);
    if (method === "PUT") return putManifest(request, env);
    return methodNotAllowed();
  }

  if (section === "blobs" && (parts.length === 3 || parts.length === 4)) {
    const fileId = parts[2];
    if (!ID_RE.test(fileId)) return json({ error: "invalid file id" }, 400);
    if (parts.length === 3) {
      if (method !== "GET") return methodNotAllowed();
      return listBlobs(env, fileId);
    }
    const hash = parts[3];
    if (!BLOB_HASH_RE.test(hash)) return json({ error: "invalid blob hash" }, 400);
    return blob(request, env, fileId, hash);
  }

  // The version store — its own prefix, its own CAS'd index, nothing to do
  // with the manifest's per-file history.
  if (section === "versions" && (parts.length === 3 || parts.length === 4)) {
    return handleVersions(request, env, url, parts);
  }

  if (section === "auth" && parts[2] === "agents") {
    if (!can(auth.role, "agents.manage")) return notAllowed();
    return handleAgentAdmin(request, env, parts);
  }

  if (section === "auth" && (parts.length === 3 || parts.length === 4)) {
    return handleAuth(request, env, parts, auth);
  }

  if (section === "admin" && parts[2] === "wipe" && parts.length === 3) {
    if (method !== "POST") return methodNotAllowed();
    if (!can(auth.role, "workspace.manage")) return notAllowed();
    const body = await readJsonObject(request);
    if (body?.confirm !== "wipe") return json({ error: 'body must be {"confirm":"wipe"}' }, 400);
    return wipeBucket(env);
  }

  return json({ error: "not found" }, 404);
}

/* ---------- People ---------- */

/** A deployment whose wrangler.toml has no `DB` binding, or whose database is
 *  gone. The sync API does not care; identity IS the database, so these
 *  routes say so instead of pretending nobody has been invited. */
const noDatabase = (): Response => json({ error: "this domain has no database — update the worker" }, 503);

/**
 * Who the bearer is, as the app has to write it down:
 * the id a manifest this Mac writes will carry in `by`, the role they hold,
 * and `can` — that role's row of the table in roles.ts, which is what the app
 * hides the rest by.
 *
 * A person's identity came off their token already — `authenticate` resolved
 * it in the row read that let them in — so this costs nothing. The creator's
 * takes one read, because matching the env secret deliberately reads nothing:
 * their *authority* is the secret and their *identity* is a row they adopted.
 * A creator who never adopted one is `memberId: null`, and their app signs
 * with the Mac's name until they do.
 */
async function whoIs(env: Env, auth: Auth): Promise<Record<string, unknown>> {
  const role = { role: auth.role, creator: auth.creator, can: allowed(auth.role) };
  if (!auth.creator) {
    // `tokenId` is which row of the Macs list this credential is — so the
    // app never offers to sign out the Mac it is running on.
    return { ...role, tokenId: auth.tokenId, memberId: auth.memberId, email: auth.email, name: auth.name };
  }
  const creator = await findCreator(env);
  return {
    ...role,
    tokenId: null,
    memberId: creator?.id ?? null,
    email: creator?.email ?? null,
    name: creator?.name ?? "Owner",
  };
}

/**
 * Trade an invite code for this device's own token — the one unauthenticated
 * route (see the carve-out in `handleApi`).
 *
 * The plaintext code crosses the wire here, where every *other* part of the
 * design sends a hash. That is deliberate and it is the point of hashing: the
 * owner's app sends `sha256(code)` when it creates the invite, so what the
 * database stores is not itself redeemable. If redeeming took the hash too,
 * the stored value would be the credential and hashing it would buy nothing.
 *
 * Unknown and expired answer identically. A caller learns whether a code
 * works, never whether it once existed or whom it was for.
 */
async function joinWithInvite(request: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return json({ error: "invalid json body" }, 400);
  const code = normalizeCode(body.code);
  if (!code) return json({ error: "that is not a Doklin invite code" }, 400);
  const deviceId = typeof body.deviceId === "string" && ID_RE.test(body.deviceId) ? body.deviceId : null;
  const deviceName = typeof body.deviceName === "string" ? body.deviceName : null;

  const redeemed = await redeemInvite(env, await sha256Hex(code), deviceId, deviceName);
  if (redeemed === null) return noDatabase();
  if (redeemed === "unknown" || redeemed === "expired") return json({ error: "that code is not valid" }, 401);
  return json({ token: redeemed.token, tokenId: redeemed.tokenId, member: redeemed.member }, 201);
}

/** Everything else under /api/auth. Each kind names the action it is, and
 *  `can` decides (roles.ts) — only the People list is everybody's. */
async function handleAuth(request: Request, env: Env, parts: string[], auth: Auth): Promise<Response> {
  const kind = parts[2];
  const id = parts[3];
  const method = request.method;

  if (kind === "invites") {
    if (!can(auth.role, "people.invite")) return notAllowed();
    if (id === undefined) {
      if (method === "GET") {
        const invites = await listInvites(env);
        return invites === null ? noDatabase() : json({ invites });
      }
      if (method === "POST") return createInvite(request, env, auth);
      return methodNotAllowed();
    }
    if (method !== "DELETE") return methodNotAllowed();
    if (!ENTITY_ID_RE.test(id)) return json({ error: "invalid invite id" }, 400);
    const gone = await deleteInvite(env, id);
    if (gone === null) return noDatabase();
    return gone ? new Response(null, { status: 204 }) : json({ error: "no such invite" }, 404);
  }

  if (kind === "members") {
    if (id === undefined) {
      if (method === "GET") {
        if (!can(auth.role, "people.see")) return notAllowed();
        const members = await listMembers(env);
        return members === null ? noDatabase() : json({ members });
      }
      if (method === "POST") {
        // Not a role's to do: it is the holder of the domain's secret saying
        // who they are, and anybody else already is somebody.
        if (!auth.creator) return json({ error: "only the domain's own token can say who its holder is" }, 403);
        return adoptCreatorIdentity(request, env);
      }
      return methodNotAllowed();
    }
    if (method !== "DELETE" && method !== "PATCH") return methodNotAllowed();
    if (!can(auth.role, method === "PATCH" ? "people.roles" : "people.remove")) return notAllowed();
    if (!ENTITY_ID_RE.test(id)) return json({ error: "invalid member id" }, 400);
    // Never your own row, either way: an owner who removed or demoted
    // themselves by a slip would have nobody but another owner to undo it.
    if (auth.memberId === id) {
      return json({ error: "that is your own row — another owner has to change it" }, 409);
    }
    if (method === "PATCH") return changeRole(request, env, id);
    const gone = await deleteMember(env, id);
    if (gone === null) return noDatabase();
    if (gone === "creator") return json({ error: "the workspace's creator cannot be removed" }, 409);
    return gone === true ? new Response(null, { status: 204 }) : json({ error: "no such member" }, 404);
  }

  if (kind === "tokens") {
    if (!can(auth.role, "people.remove")) return notAllowed();
    if (id === undefined) {
      if (method !== "GET") return methodNotAllowed();
      const tokens = await listTokens(env);
      return tokens === null ? noDatabase() : json({ tokens });
    }
    if (method !== "DELETE") return methodNotAllowed();
    if (!ENTITY_ID_RE.test(id)) return json({ error: "invalid token id" }, 400);
    // Never the credential that is asking: a signed-out Mac deletes its copy
    // of the workspace, and that is not something to do to the Mac in hand.
    // Disconnecting is how a Mac stops syncing.
    if (auth.tokenId === id) {
      return json({ error: "that is the Mac you are on — disconnect it instead of signing it out" }, 409);
    }
    const gone = await deleteToken(env, id);
    if (gone === null) return noDatabase();
    return gone ? new Response(null, { status: 204 }) : json({ error: "no such token" }, 404);
  }

  // `join` only ever answers POST, and that one is handled above the gate.
  if (kind === "join" && id === undefined) return methodNotAllowed();
  return json({ error: "not found" }, 404);
}

/**
 * Invite someone by email, creating the person if this is the first time that
 * address has been seen. The body carries `codeHash`, never a code: the app
 * mints the 100-bit code and hashes it, so a worker log, a D1 backup and this
 * request body are all incapable of letting anyone in.
 */
async function createInvite(request: Request, env: Env, auth: Auth): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return json({ error: "invalid json body" }, 400);
  const email = normalizeEmail(body.email);
  if (!email) return json({ error: "a valid email address is required" }, 400);
  // A code is a way in as the person it is for. One for an OWNER's address is
  // therefore that owner's to make, or the creator's — never another owner's,
  // who could keep it and come back as them after being removed. (For the
  // creator's own row, which nobody can remove, that would be for good.)
  const existing = await findMemberByEmail(env, email);
  if (existing === undefined) return noDatabase();
  if (existing?.role === "owner" && !auth.creator && auth.memberId !== existing.id) {
    return json({ error: "a code for an owner is theirs to make, or the workspace's creator's" }, 409);
  }
  const codeHash = typeof body.codeHash === "string" ? body.codeHash.trim().toLowerCase() : "";
  if (!HASH_RE.test(codeHash)) return json({ error: "codeHash must be the sha256 of the code, in hex" }, 400);

  const now = Date.now();
  const expiresAt =
    typeof body.expiresAt === "number" && Number.isFinite(body.expiresAt) ? Math.floor(body.expiresAt) : 0;
  if (expiresAt <= now || expiresAt > now + MAX_INVITE_TTL_MS) {
    const days = MAX_INVITE_TTL_MS / 86_400_000;
    return json({ error: `expiresAt must be a time within the next ${days} days` }, 400);
  }

  // The role is only used when the row is new: inviting an owner by their own
  // address must not demote them.
  const member = await upsertMember(env, email, typeof body.name === "string" ? body.name : null, "member");
  if (!member) return noDatabase();
  const invite = await putInvite(env, member, codeHash, expiresAt);
  return invite === null ? noDatabase() : json({ invite }, 201);
}

/** The creator saying who they are. Identity, not authority — `OWNER_TOKEN`
 *  keeps authenticating them either way (auth.ts). */
async function adoptCreatorIdentity(request: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return json({ error: "invalid json body" }, 400);
  const email = normalizeEmail(body.email);
  if (!email) return json({ error: "a valid email address is required" }, 400);
  const member = await adoptCreator(env, email, typeof body.name === "string" ? body.name : null);
  return member === null ? noDatabase() : json({ member });
}

/** Make someone an owner, or a member again. Every Mac they are signed in on
 *  carries the new role on its next request. */
async function changeRole(request: Request, env: Env, id: string): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return json({ error: "invalid json body" }, 400);
  const role = body.role;
  if (role !== "owner" && role !== "member") return json({ error: 'role must be "owner" or "member"' }, 400);
  const member = await setMemberRole(env, id, role);
  if (member === null) return noDatabase();
  if (member === "missing") return json({ error: "no such member" }, 404);
  if (member === "creator") return json({ error: "the workspace's creator is always an owner" }, 409);
  return json({ member });
}

/* ---------- The binding ---------- */

/**
 * Bind this domain to a workspace. workspace.json is written with R2's
 * create-only put, so of two devices racing to bind exactly one wins and the
 * other is told what the domain now holds (409 + the record) — never a
 * second binding, never an overwrite. The empty manifest goes first, also
 * create-only: a bind that dies between its two writes leaves a FREE domain
 * with an empty manifest for the next bind to adopt, never a bound domain
 * with no manifest.
 */
async function bindWorkspace(request: Request, env: Env, auth: Auth): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return json({ error: "invalid json body" }, 400);
  const name = validName(body.name, "Workspace");

  const bound = await readWorkspace(env);
  if (bound) return json({ error: "already bound", workspace: bound }, 409);

  let manifestEtag: string;
  const created = await env.DATA.put(MANIFEST_KEY, JSON.stringify(emptyManifest(name)), {
    ...JSON_OBJECT,
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (created) {
    manifestEtag = created.etag;
  } else {
    const head = await env.DATA.head(MANIFEST_KEY);
    if (!head) return json({ error: "could not create the manifest" }, 500);
    manifestEtag = head.etag;
  }

  const record: WorkspaceRecord = {
    id: `w-${randomHex(6)}`,
    name,
    createdAt: new Date().toISOString(),
    createdBy: { deviceId: auth.deviceId, deviceName: validName(body.deviceName, auth.name) },
  };
  const put = await env.DATA.put(WORKSPACE_KEY, JSON.stringify(record), {
    ...JSON_OBJECT,
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (!put) return json({ error: "already bound", workspace: await readWorkspace(env) }, 409);

  // Who bound it, as a person. Best effort on purpose: the creator's access is
  // the env secret, so a domain whose database is missing must still bind —
  // `POST /api/auth/members` adopts an identity afterwards. An owner row is
  // reported when there is one and simply absent when there is not.
  // Only the domain's own secret names its holder — the same rule as
  // `POST /api/auth/members`.
  const ownerEmail = auth.creator ? normalizeEmail(body.ownerEmail) : null;
  const owner = ownerEmail
    ? await adoptCreator(env, ownerEmail, typeof body.ownerName === "string" ? body.ownerName : null)
    : null;
  return json({ ...record, manifestEtag, ...(owner ? { owner } : {}) }, 201);
}

/* ---------- The manifest ---------- */

async function getManifest(env: Env, url: URL): Promise<Response> {
  const obj = await env.DATA.get(MANIFEST_KEY);
  if (!obj) return notBound();
  const since = url.searchParams.get("since");
  if (since && since === obj.etag) {
    return new Response(null, { status: 304, headers: { "x-manifest-etag": obj.etag } });
  }
  return new Response(obj.body, {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-manifest-etag": obj.etag,
    },
  });
}

async function putManifest(request: Request, env: Env): Promise<Response> {
  const baseEtag = request.headers.get("x-base-etag");
  if (!baseEtag) return json({ error: "x-base-etag header required" }, 428);
  const text = await request.text();
  if (text.length > MAX_MANIFEST_BYTES) return json({ error: "manifest too large" }, 413);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return json({ error: "invalid json body" }, 400);
  }
  const problem = validateManifest(data);
  if (problem) return json({ error: problem.error }, problem.status);

  const put = await env.DATA.put(MANIFEST_KEY, text, { ...JSON_OBJECT, onlyIf: { etagMatches: baseEtag } });
  if (!put) {
    // Lost the race (or the domain is not bound). Tell the loser where the
    // manifest is now so its next attempt starts from reality.
    const current = await env.DATA.head(MANIFEST_KEY);
    if (!current) return notBound();
    return json({ error: "manifest changed", etag: current.etag }, 412);
  }
  return json({ etag: put.etag, seq: (data as { seq: number }).seq });
}

/* ---------- Blobs ---------- */

/** The blob inventory for one file — what GC diffs against the manifest's live references. */
async function listBlobs(env: Env, fileId: string): Promise<Response> {
  const blobs: { hash: string; size: number; uploaded: string | null }[] = [];
  let cursor: string | undefined;
  do {
    const batch = await env.DATA.list({ prefix: blobPrefix(fileId), cursor });
    for (const obj of batch.objects) {
      blobs.push({
        hash: obj.key.slice(obj.key.lastIndexOf("/") + 1),
        size: obj.size,
        uploaded: obj.uploaded instanceof Date ? obj.uploaded.toISOString() : null,
      });
    }
    cursor = batch.truncated ? batch.cursor : undefined;
  } while (cursor);
  return json({ blobs });
}

async function blob(request: Request, env: Env, fileId: string, hash: string): Promise<Response> {
  const key = blobKey(fileId, hash);
  if (request.method === "GET") {
    const obj = await env.DATA.get(key);
    if (!obj) return json({ error: "not found" }, 404);
    return new Response(obj.body, {
      headers: {
        "content-type": obj.httpMetadata?.contentType || "application/octet-stream",
        "content-length": String(obj.size),
        "cache-control": "no-store",
      },
    });
  }
  if (request.method === "PUT") {
    const buf = await request.arrayBuffer();
    if (buf.byteLength > MAX_FILE_BYTES) return json({ error: "file too large" }, 413);
    // Content-addressed, so a hash that is already stored IS these bytes:
    // create-only makes the re-upload a no-op instead of a rewrite.
    const put = await env.DATA.put(key, buf, {
      httpMetadata: { contentType: request.headers.get("content-type") || "application/octet-stream" },
      onlyIf: { etagDoesNotMatch: "*" },
    });
    return json({ stored: true, existed: !put, hash, size: buf.byteLength });
  }
  if (request.method === "DELETE") {
    await env.DATA.delete(key);
    return json({ deleted: true });
  }
  return methodNotAllowed();
}

/* ---------- The poll ---------- */

/**
 * The 15-second question every engine asks — "has the manifest moved?" — and,
 * since v7, the carrier of its presence beat; since v8, of its leases too.
 *
 * The method says whether anything is written. A `GET` reads; a `POST` says
 * "this device is here" (or is leaving), and the engine sends one only when a
 * beat is due — every 45 s, the moment the edited path changes, or when the
 * document it has open is free to claim — so an idle poll writes nothing and
 * the client decides when a write happens. A worker that wrote on every poll
 * would spend 58% of D1's free daily writes on freshness nobody can see.
 *
 * The etag is the poll's job; presence and leases are not. A database that is
 * missing, broken or mid-outage answers `{}` for presence and `null` for
 * leases while the etag comes back as it always has — so neither is ever on
 * the sync path, and no lease is no lock. A beat this cannot attribute (no
 * device header) or whose path is not one is still a poll: it answers, and
 * records what it can.
 */
async function poll(request: Request, env: Env, auth: Auth): Promise<Response> {
  let beat: Beat | null = null;
  if (request.method === "POST") {
    const body = await readJsonObject(request);
    if (!body) return json({ error: "invalid json body" }, 400);
    beat =
      body.leave === true
        ? { kind: "leave" }
        : {
            kind: "here",
            name: validName(body.name, auth.name),
            path: typeof body.path === "string" && validPath(body.path) ? body.path : null,
            take: body.take === true,
          };
  }
  const answer = (etag: string, here: Here | null): Response =>
    json({ manifestEtag: etag, presence: here?.presence ?? {}, leases: here?.leases ?? null });
  const deviceId = auth.deviceId;
  if (beat && deviceId) {
    // In order, for a beat: a domain that holds no workspace answers 404 and
    // records nobody as being in it, or as holding anything. One poll in
    // three carries a beat, so the round trip this costs is rare; the idle
    // read below stays parallel.
    const head = await env.DATA.head(MANIFEST_KEY);
    if (!head) return notBound();
    return answer(head.etag, await recordBeat(env, auth, deviceId, beat));
  }
  const [head, here] = await Promise.all([env.DATA.head(MANIFEST_KEY), readHere(env)]);
  if (!head) return notBound();
  return answer(head.etag, here);
}

/* ---------- Wipe ---------- */

/**
 * The erase step of tearing a domain down — and the only thing that frees a
 * bound domain: delete every object in the bucket so `wrangler r2 bucket
 * delete` (which refuses a non-empty bucket) can finish the job, and so the
 * next bind finds no workspace.json. Batched to the per-request subrequest
 * budget; the client repeats the call until `remaining` comes back false.
 *
 * The last round empties D1 as well — otherwise a
 * rebound domain would inherit the old workspace's people. The database goes
 * in the round that finishes, never before: an owner whose credential is a
 * row in it — rather than the env secret — would otherwise cut the call off
 * half-done. Everyone's tokens go with it, which is the intent, and so does
 * `removed_tokens`: a wiped domain has taken nobody's access away, so no Mac
 * is told to delete its copy.
 */
async function wipeBucket(env: Env): Promise<Response> {
  let deleted = 0;
  const finish = async (): Promise<Response> => {
    // A database that is bound and did not empty is not done: its people and
    // their tokens would outlive the workspace they were for. The caller
    // repeats while `remaining`, so say so and let the next round try again.
    const emptied = (await wipeSchema(env)) !== null || !env.DB;
    return json({ wiped: true, purged: deleted, remaining: !emptied });
  };
  for (let round = 0; round < 20; round += 1) {
    const batch = await env.DATA.list({ limit: 1000 });
    const keys = batch.objects.map((o) => o.key);
    if (keys.length === 0) return finish();
    await env.DATA.delete(keys);
    deleted += keys.length;
    if (!batch.truncated && batch.objects.length < 1000) return finish();
  }
  return json({ wiped: true, purged: deleted, remaining: true });
}
