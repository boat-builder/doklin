// The authenticated API — everything the engine says to the worker
// (docs/cloud.md §5.3–5.5, §5.7). JSON in, JSON out, a bearer on
// every request; the engine is the only caller, so there is no CORS and no
// preflight. Every request also carries `x-doklin-device` (attribution for
// presence and the binding) and `x-doklin-client` (the app version, for
// the logs — nothing reads it).
//
//   GET    /api/meta                 {version, features, workspace|null, d1: schema version|null}
//   POST   /api/workspace            owner; bind this domain: body {name, deviceName?,
//                                    ownerEmail?, ownerName?} → 201 (+ {owner} when named)
//                                    409 {workspace} when it already holds one (never overwrites)
//   GET    /api/workspace            {id, name, createdAt, createdBy, files, bytes}
//   GET    /api/poll                 {manifestEtag, presence} — the cheap 15 s poll
//   GET    /api/manifest[?since=e]   the manifest + x-manifest-etag (304 when unchanged)
//   PUT    /api/manifest             x-base-etag required; 412 + current etag on a lost race;
//                                    400 on garbage, 426 on a schema this worker predates
//   GET    /api/blobs/<fid>          {blobs: [{hash, size, uploaded}]} — the inventory GC diffs
//   GET    /api/blobs/<fid>/<hash>   the bytes
//   PUT    /api/blobs/<fid>/<hash>   store bytes (immutable — a re-PUT of the same hash is a no-op)
//   DELETE /api/blobs/<fid>/<hash>   garbage-collect an unreferenced revision
//   GET    /api/history/<fid>        DEPRECATED {version, entries}
//   PUT    /api/history/<fid>        DEPRECATED replace the archive (advisory, size-capped)
//   DELETE /api/history/<fid>        drop the archive (204 whether or not one was there)
//                                    — the three above are the retired manifest history
//                                    (docs/versioning.md §6.5). No current app reads or writes
//                                    one; GET and PUT stay because an app on an older release
//                                    still does, and this API only grows. DELETE is what the
//                                    current app's one-time clean-up calls.
//   GET    /api/versions/index       the version store's index + x-versions-etag; 404 when none
//   PUT    /api/versions/index       x-base-etag required ("*" creates); 412 + etag on a lost race
//   GET    /api/versions/snapshots/<id>   the gzip'd workspace state
//   PUT    /api/versions/snapshots/<id>   create-only ({existed:true} on a re-PUT)
//   DELETE /api/versions/snapshots/<id>
//   GET    /api/versions/blobs[?cursor=c] {blobs: [...], cursor?} — one page of the inventory
//   GET    /api/versions/blobs/<hash>     the bytes
//   PUT    /api/versions/blobs/<hash>     create-only
//   DELETE /api/versions/blobs/<hash>     garbage-collect an unreferenced version
//   PUT    /api/presence             body {name?, path?} — "this device is here (editing path)"
//   DELETE /api/presence             this device left
//   POST   /api/admin/wipe           owner; body {"confirm":"wipe"} — erase everything, batched;
//                                    repeat until remaining:false. Frees the domain.
//
//   People (docs/teams-plan.md §9). Everything here is the D1 database beside
//   the bucket; a deployment without one answers 503 and loses nothing else.
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
//   GET    /api/auth/members         owner; everyone, with a device count and lastSeenAt
//   POST   /api/auth/members         owner; {email, name?} — adopt or rename the owner's own
//                                    identity, for attribution and the People list
//   DELETE /api/auth/members/<id>    owner; the person and every credential they hold (204)
//   GET    /api/auth/tokens          owner; {id, memberId, email, deviceName, createdAt} — never a hash
//   DELETE /api/auth/tokens/<id>     owner; revoke one device, effective on its next request (204)

import { authenticate, type Auth } from "./auth";
import { randomHex } from "./crypto";
import { prunePresence, readManifestTotals, readPresence, readWorkspace, type WorkspaceRecord } from "./bucket";
import type { Env } from "./env";
import { json, readJsonObject } from "./http";
import {
  BLOB_HASH_RE,
  ID_RE,
  MANIFEST_KEY,
  MAX_FILE_BYTES,
  MAX_HISTORY_BYTES,
  MAX_HISTORY_ENTRIES,
  MAX_MANIFEST_BYTES,
  PRESENCE_KEY,
  WORKSPACE_KEY,
  blobKey,
  blobPrefix,
  historyKey,
  validName,
  validPath,
} from "./layout";
import { emptyManifest, validateManifest, validHistoryArchive } from "./manifest";
import {
  ENTITY_ID_RE,
  HASH_RE,
  MAX_INVITE_TTL_MS,
  adoptOwner,
  deleteInvite,
  deleteMember,
  deleteToken,
  listInvites,
  listMembers,
  listTokens,
  normalizeCode,
  normalizeEmail,
  putInvite,
  redeemInvite,
  upsertMember,
} from "./members";
import { sha256Hex } from "./crypto";
import { ensureSchema, wipeSchema } from "./schema";
import { WORKER_FEATURES, WORKER_VERSION } from "./version";
import { handleVersions } from "./versions";

const JSON_OBJECT = { httpMetadata: { contentType: "application/json" } };

const methodNotAllowed = (): Response => json({ error: "method not allowed" }, 405);
const ownerOnly = (): Response => json({ error: "owner only" }, 403);
const notBound = (): Response => json({ error: "not bound" }, 404);

export async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", section, …]

  // The one route above the gate. Redeeming an invite is how a Mac GETS a
  // bearer, so it cannot be behind one — and the carve-out is method AND
  // path, exactly, so `GET /api/auth/join`, `POST /api/auth/joinx` and every
  // other route under /api/auth still meet `authenticate` below.
  if (request.method === "POST" && parts.length === 3 && parts[1] === "auth" && parts[2] === "join") {
    return joinWithInvite(request, env);
  }

  const auth = await authenticate(request, env);
  if (!auth) return json({ error: "unauthorized" }, 401);

  const section = parts[1];
  const method = request.method;

  // The probe: liveness, the credential, the version and "is this domain
  // bound" in one call — what the setup wizard asks before touching anything.
  if (section === "meta" && parts.length === 2) {
    if (method !== "GET") return methodNotAllowed();
    // The probe is also where the database migrates itself: it is the one
    // route every engine calls on start and on every poll, and the only one
    // that reports what it found. `d1` is the schema version, or null on a
    // deployment whose wrangler.toml has no DB binding (docs/teams-plan.md §8).
    const [workspace, d1] = await Promise.all([readWorkspace(env), ensureSchema(env)]);
    return json({ version: WORKER_VERSION, features: WORKER_FEATURES, workspace, d1 });
  }

  if (section === "workspace" && parts.length === 2) {
    if (method === "POST") {
      if (auth.role !== "owner") return ownerOnly();
      return bindWorkspace(request, env, auth);
    }
    if (method === "GET") {
      const workspace = await readWorkspace(env);
      if (!workspace) return notBound();
      return json({ ...workspace, ...(await readManifestTotals(env)) });
    }
    return methodNotAllowed();
  }

  if (section === "poll" && parts.length === 2) {
    if (method !== "GET") return methodNotAllowed();
    const [head, devices] = await Promise.all([env.DATA.head(MANIFEST_KEY), readPresence(env)]);
    if (!head) return notBound();
    return json({ manifestEtag: head.etag, presence: prunePresence(devices) });
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
  // with the manifest's per-file history (docs/versioning.md §6.4).
  if (section === "versions" && (parts.length === 3 || parts.length === 4)) {
    return handleVersions(request, env, url, parts);
  }

  if (section === "history" && parts.length === 3) {
    const fileId = parts[2];
    if (!ID_RE.test(fileId)) return json({ error: "invalid file id" }, 400);
    return history(request, env, fileId);
  }

  if (section === "presence" && parts.length === 2) {
    if (method !== "PUT" && method !== "DELETE") return methodNotAllowed();
    return presence(request, env, auth);
  }

  if (section === "auth" && (parts.length === 3 || parts.length === 4)) {
    if (auth.role !== "owner") return ownerOnly();
    return handleAuth(request, env, parts);
  }

  if (section === "admin" && parts[2] === "wipe" && parts.length === 3) {
    if (method !== "POST") return methodNotAllowed();
    if (auth.role !== "owner") return ownerOnly();
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

/** Everything else under /api/auth — owner-only, checked by the caller. */
async function handleAuth(request: Request, env: Env, parts: string[]): Promise<Response> {
  const kind = parts[2];
  const id = parts[3];
  const method = request.method;

  if (kind === "invites") {
    if (id === undefined) {
      if (method === "GET") {
        const invites = await listInvites(env);
        return invites === null ? noDatabase() : json({ invites });
      }
      if (method === "POST") return createInvite(request, env);
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
        const members = await listMembers(env);
        return members === null ? noDatabase() : json({ members });
      }
      if (method === "POST") return adoptOwnerIdentity(request, env);
      return methodNotAllowed();
    }
    if (method !== "DELETE") return methodNotAllowed();
    if (!ENTITY_ID_RE.test(id)) return json({ error: "invalid member id" }, 400);
    const gone = await deleteMember(env, id);
    if (gone === null) return noDatabase();
    return gone ? new Response(null, { status: 204 }) : json({ error: "no such member" }, 404);
  }

  if (kind === "tokens") {
    if (id === undefined) {
      if (method !== "GET") return methodNotAllowed();
      const tokens = await listTokens(env);
      return tokens === null ? noDatabase() : json({ tokens });
    }
    if (method !== "DELETE") return methodNotAllowed();
    if (!ENTITY_ID_RE.test(id)) return json({ error: "invalid token id" }, 400);
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
 * request body are all incapable of letting anyone in (teams-plan.md §6.3).
 */
async function createInvite(request: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return json({ error: "invalid json body" }, 400);
  const email = normalizeEmail(body.email);
  if (!email) return json({ error: "a valid email address is required" }, 400);
  const codeHash = typeof body.codeHash === "string" ? body.codeHash.trim().toLowerCase() : "";
  if (!HASH_RE.test(codeHash)) return json({ error: "codeHash must be the sha256 of the code, in hex" }, 400);

  const now = Date.now();
  const expiresAt =
    typeof body.expiresAt === "number" && Number.isFinite(body.expiresAt) ? Math.floor(body.expiresAt) : 0;
  if (expiresAt <= now || expiresAt > now + MAX_INVITE_TTL_MS) {
    const days = MAX_INVITE_TTL_MS / 86_400_000;
    return json({ error: `expiresAt must be a time within the next ${days} days` }, 400);
  }

  // The role is only used when the row is new: inviting the owner by their own
  // address must not demote them.
  const member = await upsertMember(env, email, typeof body.name === "string" ? body.name : null, "member");
  if (!member) return noDatabase();
  const invite = await putInvite(env, member, codeHash, expiresAt);
  return invite === null ? noDatabase() : json({ invite }, 201);
}

/** The owner saying who they are. Identity, not authority — `OWNER_TOKEN`
 *  keeps authenticating them either way (auth.ts). */
async function adoptOwnerIdentity(request: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return json({ error: "invalid json body" }, 400);
  const email = normalizeEmail(body.email);
  if (!email) return json({ error: "a valid email address is required" }, 400);
  const member = await adoptOwner(env, email, typeof body.name === "string" ? body.name : null);
  return member === null ? noDatabase() : json({ member });
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

  // Who bound it, as a person. Best effort on purpose: the owner's access is
  // the env secret, so a domain whose database is missing must still bind —
  // `POST /api/auth/members` adopts an identity afterwards. An owner row is
  // reported when there is one and simply absent when there is not.
  const ownerEmail = normalizeEmail(body.ownerEmail);
  const owner = ownerEmail
    ? await adoptOwner(env, ownerEmail, typeof body.ownerName === "string" ? body.ownerName : null)
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

/* ---------- History ---------- */

async function history(request: Request, env: Env, fileId: string): Promise<Response> {
  const key = historyKey(fileId);
  if (request.method === "GET") {
    const obj = await env.DATA.get(key);
    if (!obj) return json({ error: "not found" }, 404);
    return new Response(obj.body, {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  if (request.method === "PUT") {
    // The deep archive: entries the engine rolled out of the manifest's
    // inline tail. Advisory data — last write wins, size-capped.
    const text = await request.text();
    if (text.length > MAX_HISTORY_BYTES) return json({ error: "history too large" }, 413);
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return json({ error: "invalid json body" }, 400);
    }
    if (!validHistoryArchive(data, MAX_HISTORY_ENTRIES)) return json({ error: "invalid history" }, 400);
    await env.DATA.put(key, text, JSON_OBJECT);
    return json({ stored: true, entries: (data as { entries: unknown[] }).entries.length });
  }
  if (request.method === "DELETE") {
    // Phase 6 of versioning retires these archives; deleting one that was
    // already gone is the same success, so a sweep never has to check first.
    await env.DATA.delete(key);
    return new Response(null, { status: 204 });
  }
  return methodNotAllowed();
}

/* ---------- Presence ---------- */

/**
 * "This device is here, editing <path>." Ephemeral and self-healing (the next
 * heartbeat repaints it, the TTL sweeps the silent), so plain last-write-wins
 * is fine — no CAS ceremony. The device is the request's `x-doklin-device`.
 */
async function presence(request: Request, env: Env, auth: Auth): Promise<Response> {
  const deviceId = auth.deviceId;
  if (!deviceId) return json({ error: "x-doklin-device header required" }, 400);
  const devices = prunePresence(await readPresence(env));
  if (request.method === "DELETE") {
    delete devices[deviceId];
  } else {
    const body = await readJsonObject(request);
    if (!body) return json({ error: "invalid json body" }, 400);
    if (body.path !== undefined && body.path !== null && !validPath(body.path)) {
      return json({ error: "invalid path" }, 400);
    }
    devices[deviceId] = {
      name: validName(body.name, auth.name),
      ...(typeof body.path === "string" ? { path: body.path } : {}),
      ts: Date.now(),
    };
  }
  await env.DATA.put(PRESENCE_KEY, JSON.stringify({ devices }), JSON_OBJECT);
  return json({ presence: devices });
}

/* ---------- Wipe ---------- */

/**
 * The erase step of tearing a domain down — and the only thing that frees a
 * bound domain: delete every object in the bucket so `wrangler r2 bucket
 * delete` (which refuses a non-empty bucket) can finish the job, and so the
 * next bind finds no workspace.json. Batched to the per-request subrequest
 * budget; the client repeats the call until `remaining` comes back false.
 *
 * The last round empties D1 as well (docs/teams-plan.md §4.4) — otherwise a
 * rebound domain would inherit the old workspace's people. Nothing has to be
 * saved for last any more: a wipe is owner-only, and the owner's credential
 * is the worker's env secret rather than anything in here, so the call cannot
 * cut itself off half-done. Members lose theirs, which is the intent.
 */
async function wipeBucket(env: Env): Promise<Response> {
  let deleted = 0;
  const finish = async (): Promise<Response> => {
    await wipeSchema(env);
    return json({ wiped: true, purged: deleted, remaining: false });
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
