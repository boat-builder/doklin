// The authenticated API — everything the engine says to the worker, and what
// the browser version says to it (web.ts).
// JSON in, JSON out, a bearer on every request — or, from a browser, the
// cookie that is its sign-in (auth.ts). Every caller is the engine or a page
// this domain served, so there is no CORS and no preflight. Every request
// also carries `x-doklin-device` (attribution for presence and the binding)
// and `x-doklin-client` (which app and version: an older one than the
// minimums is turned away first, clients.ts);
// now and then, `x-doklin-used` (the caller's requests today, limits.ts).
//
// A bearer that sends too much is a loop, and is told so with a 429 before
// anything else is done (`DEVICE_LIMIT`, `AGENT_LIMIT`).
//
//   GET    /api/meta                 {version, workspace|null, d1: schema version|null,
//                                    you: who this bearer is — {role, memberId, email, name,
//                                    tokenId, can: [what that role may do]}, superadmin: {id,
//                                    name}|null, people: [{id, name, person?}] — the directory a
//                                    manifest's `by` is read with (`person`: an agent's, whose
//                                    it is), limits}
//   POST   /api/workspace            superadmin; bind this domain: body {name, deviceName?} → 201
//                                    409 {workspace} when it already holds one (never overwrites)
//   GET    /api/workspace            {id, name, createdAt, createdBy, files, bytes}
//   GET    /api/poll                 {manifestEtag, presence, leases, spaces, limits} — the
//                                    cheap poll; reads only. `spaces` is every space the caller
//                                    is in, each with its manifest's etag
//   POST   /api/poll                 the same poll, carrying this device's beat:
//                                    body {name, path?, space?, take?, ttl?} — "here, editing
//                                    path (in that space), for ttl ms", which claims its lease
//                                    (take: from whoever holds it) and lets go of any other — or
//                                    {leave: true}. Presence, leases, spaces and the fleet are
//                                    best effort: a database that cannot answer costs the lists
//                                    ({}, null and null come back, and the Free limits with no
//                                    fleetToday), never the etag
//   PUT    /api/settings/plan        superadmin; {plan: "free" | "paid"} → {limits}: which
//                                    Cloudflare plan the account is on
//   GET    /api/manifest[?since=e]   the manifest + x-manifest-etag (304 when unchanged)
//   PUT    /api/manifest             x-base-etag required; 412 + current etag on a lost race;
//                                    400 on garbage, 426 on a schema this worker predates,
//                                    409 {taken: [slug]} when its public map names an address
//                                    another space holds (addresses.ts)
//   GET    /api/blobs/<fid>/<hash>   the bytes — a browser may keep them for good: a copy
//                                    never changes under its address
//   PUT    /api/blobs/<fid>/<hash>   store bytes (immutable — a re-PUT of the same hash is a no-op).
//                                    Nobody deletes one: the daily sweep collects what no
//                                    manifest names (sweep.ts)
//   GET    /api/versions/index       the version store's index + x-versions-etag; 404 when none
//   PUT    /api/versions/index       x-base-etag required ("*" creates); 412 + etag on a lost race
//   GET    /api/versions/snapshots/<id>   the gzip'd workspace state
//   PUT    /api/versions/snapshots/<id>   create-only ({existed:true} on a re-PUT)
//   DELETE /api/versions/snapshots/<id>
//   GET    /api/versions/blobs[?cursor=c] {blobs: [...], cursor?} — one page of the inventory
//   GET    /api/versions/blobs/<hash>     the bytes
//   PUT    /api/versions/blobs/<hash>     create-only
//   DELETE /api/versions/blobs/<hash>     garbage-collect an unreferenced version
//   POST   /api/admin/wipe           superadmin; body {"confirm":"wipe"} — erase everything,
//                                    batched; repeat until remaining:false. Frees the domain.
//
//   The domain's key — the env secret `OWNER_TOKEN` — is no sign-in. As a bearer it is answered
//   on two routes and refused (403) on every other:
//
//   GET    /api/meta                 the probe above, with no `you`
//   POST   /api/auth/recover         {email, name?, deviceId?, deviceName?} → 201 {token, tokenId,
//                                    member}: a device sign-in as `email`'s person, who becomes the
//                                    superadmin. The key is spent: 401 {code: "key_spent"} the
//                                    next time
//
//   People. Everything here is the D1 database beside the bucket; a
//   deployment without one answers 503. Who may call what is one table
//   (roles.ts): "owner" below is anyone whose role is, the superadmin among
//   them, and "superadmin" is the one person the `superadmin` table names. A
//   refusal is 403.
//
//   POST   /api/auth/join            NO BEARER — {code, deviceId?, deviceName?} → 201
//                                    {token, tokenId, member}; 401 when the code is unknown or
//                                    expired (the row goes either way). The ONE route above the
//                                    authenticate gate, matched on method AND path exactly,
//                                    because answering it is how a Mac gets a bearer at all.
//   POST   /api/auth/invites         owner; {email, name?, codeHash, expiresAt} → 201 {invite};
//                                    creates the member if the email is new, brings back one who
//                                    was removed, and replaces any invite they already had. For
//                                    somebody who has signed in before, the superadmin's or their
//                                    own to make (409). The worker never sees the code.
//   GET    /api/auth/invites         owner; the pending, unexpired ones
//   DELETE /api/auth/invites/<id>    owner; withdraw one (204)
//   GET    /api/auth/members         everyone, with a role, a device count and lastSeenAt — the
//                                    People list, which every person here may read
//   PATCH  /api/auth/members/<id>    owner; {role: "owner" | "member"} → {member}. Never your own
//                                    row, never the superadmin's (409)
//   DELETE /api/auth/members/<id>    owner; remove the person: every credential they hold, and
//                                    what was shared with them (204). Their row stays,
//                                    out of the People list. Never your own, never the
//                                    superadmin's (409)
//   POST   /api/auth/devices/code    anyone; {codeHash, expiresAt} → 201 {code}: a one-time code
//                                    for a device of the caller's own, redeemed by the join above.
//                                    Replaces the pending code they had
//   GET    /api/auth/devices         anyone; the caller's devices, an owner everyone's: {id,
//                                    memberId, email, deviceId, deviceName, createdAt} — never a hash
//   DELETE /api/auth/devices/<id>    its person, or an owner — but the superadmin's are theirs
//                                    alone (409); sign one device out, effective on its next
//                                    request (204). Never the calling one (409)
//   DELETE /api/auth/session         a device ending its own sign-in (204): it is forgotten, and
//                                    told to delete nothing. A browser's cookie goes with it,
//                                    and what that browser kept
//
//   A credential an owner took away — a person removed, a Mac signed out — is answered
//   `401 {error, removed: true}` on every route from then on, where any other bearer nobody
//   holds is a bare 401. The difference is the app's cue to delete that Mac's copy
//   of the workspace, so it is only ever said of a token `removed_tokens` remembers. A
//   browser is told the same, with the headers that end its sign-in there (auth.ts).
//
//   Spaces — the caller's My files, and what is shared (spaces.ts): a tree, in which whoever
//   can open a section can open what sits in it. Anyone here shares; a space answers the
//   people who can open it and is a 404 to everybody else, owners included.
//
//   GET    /api/spaces               {spaces} — the ones the caller can open, and the deleted
//                                    shares they can restore (`deletedAt`)
//   POST   /api/spaces               {id, kind: "folder" | "document", name, parent, dir?, was?,
//                                    members?: [memberId]} → 201 {space}: a share in the section
//                                    `parent`, which the caller can open and is never Library —
//                                    in its folder `dir` ("" its top), which that section's
//                                    manifest says from then on (`mounts`), with `was`, where the
//                                    item was before. The device mints `id`; the same one from
//                                    its maker again answers the same share. 409 when it is taken
//   PUT    /api/spaces/private       {space} — the caller's own My files, made on first asking
//   PATCH  /api/spaces/<id>          {name} → {space}, a shared folder only (a shared document
//                                    is renamed by renaming its file); or {parent, dir?} →
//                                    {space}, by somebody who can open both the section it sits
//                                    in and the one it goes to
//   DELETE /api/spaces/<id>          by somebody who can open the section it sits in. One that
//                                    holds something is kept thirty days: {deleted, kept: true}.
//                                    One that holds nothing is erased, batched: repeat until
//                                    remaining:false
//   POST   /api/spaces/<id>/restore  a deleted share back, by the same people → {space}
//   PUT    /api/spaces/<id>/members/<memberId>     share it with a person here → {space}
//   DELETE /api/spaces/<id>/members/<memberId>     stop, yourself included (204); 409 for
//                                    somebody who opens it through the folder it sits in
//   *      /api/spaces/<id>/manifest · blobs/… · versions/…   the sync routes above, on that space
//
//   Every public address (everyPage.ts) — an owner's, whichever section published the page.
//
//   GET    /api/pages                {pages: [{slug, kind, title, by, at, shared}], truncated} —
//                                    what the internet is told of each page, and no more
//   DELETE /api/pages/<slug>         take the page down (204); 404 when nothing is published there
//
//   Agents. An agent's token is answered under /api/agent and nowhere
//   else — every route above answers one with 403 — and the routes that manage agents sit
//   beside the people routes. Both are listed in agentApi.ts.
//
//   POST   /api/agent/login          NO BEARER — the second route above the gate
//   *      /api/agent/…              an agent's token only: the document API
//   *      /api/auth/agents…         anyone; their own agents — an owner sees everyone's and
//                                    may remove any
//
//   The browser version. A browser's sign-in is answered under /api/web and on the
//   routes above that web.ts lists — the reads it is built from, people, devices and
//   agents, and sharing — and on nothing else (403); nobody else's credential
//   is answered under /api/web.
//
//   POST   /api/web/session          NO CREDENTIAL — the third route above the gate
//   *      /api/web/…                a browser's sign-in only: listed in web.ts

import { claimAddresses, releaseAddresses, takenError } from "./addresses";
import { agentLogin, handleAgent, handleAgentAdmin } from "./agentApi";
import { NO_SESSION_COOKIE, SIGNED_OUT, authenticate, keyHashOf, sessionCookie, sessionOf, type Auth } from "./auth";
import { randomHex } from "./crypto";
import { readManifestTotals, readWorkspace } from "./bucket";
import type { Env } from "./env";
import { listEveryPage, takeDownPage } from "./everyPage";
import { json, readJsonObject } from "./http";
import { UNKNOWN_LIMITS, isPlan, readLimits, recordUsage, setPlan, usedOf } from "./limits";
import {
  BLOB_HASH_RE,
  ID_RE,
  MANIFEST_KEY,
  MAX_FILE_BYTES,
  MAX_MANIFEST_BYTES,
  MEMBER_ID_RE,
  SHARE_ID_RE,
  SLUG_RE,
  SPACE_ID_RE,
  WORKSPACE_KEY,
  blobKey,
  normalizeCode,
  validItemName,
  validName,
  validPath,
} from "./layout";
import { emptyManifest, validateManifest, type Manifest } from "./manifest";
import {
  ENTITY_ID_RE,
  HASH_RE,
  MAX_DEVICE_CODE_TTL_MS,
  MAX_INVITE_TTL_MS,
  claimSuperadmin,
  deleteInvite,
  endSession,
  findMemberByEmail,
  findSuperadmin,
  listDevices,
  listDirectory,
  listInvites,
  listMembers,
  normalizeEmail,
  putInvite,
  redeemInvite,
  removeMember,
  signOutDevice,
  setMemberRole,
  upsertMember,
} from "./members";
import { sha256Hex } from "./crypto";
import { beatTtl, readHere, recordBeat, type Beat, type Here } from "./presence";
import { allowed, can, refusal, type Action } from "./roles";
import { ensureSchema, wipeSchema } from "./schema";
import {
  addToSpace,
  createSpace,
  deleteSpace,
  ensurePrivate,
  isInside,
  kindOf,
  listSpaces,
  moveSpace,
  noteEtag,
  openDeleted,
  openSpace,
  removeFromSpace,
  renameSpace,
  restoreSpace,
  spaceEnv,
} from "./spaces";
import { NOT_YOURS_TO_TAKE, Refusal, takesShared } from "./commit";
import { dropMount, setMount, type Placing } from "./mounts";
import { turnedAway } from "./clients";
import { WORKER_VERSION } from "./version";
import type { MetaAnswer, PollAnswer, Space, Who, WorkspaceRecord } from "./wire";
import { browserMay, handleWeb, signIn } from "./web";
import { handleVersions } from "./versions";
import { openWorkspace } from "./workspace";

const JSON_OBJECT = { httpMetadata: { contentType: "application/json" } };

const methodNotAllowed = (): Response => json({ error: "method not allowed" }, 405);
/** What `can` said no to (roles.ts), naming who may. */
const notAllowed = (action: Action): Response => json({ error: refusal(action) }, 403);
const notBound = (): Response => json({ error: "not bound" }, 404);

/** What a bearer the loop catchers stopped is told. `Retry-After` is the
 *  period of the `[[ratelimits]]` blocks in wrangler.toml, where the numbers
 *  live. */
const tooMany = (): Response =>
  json({ error: "This device is sending too many requests — it will slow down by itself." }, 429, { "retry-after": "60" });

export async function handleApi(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext | undefined,
): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", section, …]

  // A client older than the release marked mandatory, or a browser tab of
  // another release, is turned away before anything else, a join and a login
  // included (clients.ts).
  const away = turnedAway(request.headers.get("x-doklin-client"), url.host);
  if (away) return away;

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

  // And the third: signing in is how a browser gets its cookie.
  if (request.method === "POST" && parts.length === 3 && parts[1] === "web" && parts[2] === "session") {
    return signIn(request, env);
  }

  // The domain's key is nobody's sign-in: it is answered on the probe and on
  // the trade that makes one, and on nothing else.
  const keyHash = await keyHashOf(request, env);
  if (keyHash) return handleKey(request, env, parts, keyHash);

  const auth = await authenticate(request, env);
  // Said only of a credential the database remembers an owner taking away:
  // the Mac that hears `removed` deletes its copy of the workspace. A browser
  // that hears it is told to drop what it kept too; one whose cookie is
  // simply nobody's is told to drop the cookie.
  const session = sessionOf(request) !== null;
  if (auth === "removed") {
    return json({ error: "your access to this workspace was removed", removed: true }, 401, session ? SIGNED_OUT : {});
  }
  // Never a 401: a database that cannot answer has refused nobody.
  if (auth === "unavailable") return unavailable(env);
  if (!auth) return json({ error: "unauthorized" }, 401, session ? { "set-cookie": NO_SESSION_COOKIE } : {});

  // A loop, caught: a person's device past what a person does in a minute,
  // or an agent's machine past what a tool does. Approximate, and only ever
  // a backstop — a request refused here has been counted against the account
  // already, so the budget is the clients' to keep (limits.ts). A binding the
  // deployment lacks is not checked, and one that cannot answer stops nobody.
  const limiter = auth.agent ? env.AGENT_LIMIT : env.DEVICE_LIMIT;
  const under = limiter ? await limiter.limit({ key: auth.tokenId }).then((o) => o.success, () => true) : true;
  if (!under) return tooMany();

  // The caller's own count of its requests today, for everyone's sum. After
  // the answer: it is nothing the answer waits on.
  const used = usedOf(request);
  if (used !== null) {
    const report = recordUsage(env, auth.tokenId, used);
    if (ctx) ctx.waitUntil(report);
    else await report;
  }

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
    return json({ error: "the document API is for agents — add one in Doklin, under Agents" }, 403);
  }

  // A browser's sign-in and the browser version's routes belong to each
  // other the same way. A browser holds no copy of the workspace and builds
  // no manifest, so it has no business where one is put; and what it may not
  // reach, a page that got script onto this domain could not reach either.
  if (section === "web" ? !auth.browser : auth.browser && !browserMay(method, parts)) {
    return json(
      {
        error: auth.browser
          ? "that is not done from a browser — it is done in the Doklin app"
          : "these routes are the browser version's — an app syncs through the others",
      },
      403,
    );
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
    // It also answers identity: who the caller is, and what every person
    // here is called. Both belong on the route an engine already asks
    // before it writes anything — a manifest it PUTs signs with `you.memberId`
    // and every `by` it reads resolves through `people`.
    //
    // `superadmin` is everyone's to know: it is whom the app says to ask for
    // what only they can do — an update of the worker, a person's way back in.
    // `limits` are what an engine paces itself by from its first request on.
    const [workspace, d1, people, superadmin, limits] = await Promise.all([
      readWorkspace(env),
      ensureSchema(env),
      listDirectory(env),
      findSuperadmin(env),
      readLimits(env),
    ]);
    // A browser is handed its cookie again: its lifetime starts over each
    // time the app starts, so one in use never runs out.
    const again = auth.browser ? sessionOf(request) : null;
    const answer: MetaAnswer = {
      version: WORKER_VERSION,
      workspace,
      d1,
      you: whoIs(auth),
      superadmin,
      people: people ?? [],
      limits,
    };
    return json(answer, 200, again ? { "set-cookie": sessionCookie(again) } : {});
  }

  // Which Cloudflare plan the account is on — the superadmin's to say, since
  // the account is theirs — and so which numbers every device paces itself by.
  if (section === "settings" && parts.length === 3 && parts[2] === "plan") {
    if (method !== "PUT") return methodNotAllowed();
    if (!can(auth.role, "workspace.manage")) return notAllowed("workspace.manage");
    const body = await readJsonObject(request);
    if (!body) return json({ error: "invalid json body" }, 400);
    if (!isPlan(body.plan)) return json({ error: 'plan must be "free" or "paid"' }, 400);
    const limits = await setPlan(env, body.plan);
    return limits === null ? noDatabase() : json({ limits });
  }

  if (section === "workspace" && parts.length === 2) {
    if (method === "POST") {
      if (!can(auth.role, "workspace.manage")) return notAllowed("workspace.manage");
      return bindWorkspace(request, env, auth);
    }
    if (method === "GET") {
      const workspace = await readWorkspace(env);
      if (!workspace) return notBound();
      return json({ ...workspace, ...(await readManifestTotals(env)) });
    }
    return methodNotAllowed();
  }

  // The work itself — the poll, the manifest, the blobs, the version store,
  // and the spaces, which are those three again. Both roles hold it today; a
  // role that did not would stop here.
  const working = ["poll", "manifest", "blobs", "versions", "spaces", "web"].includes(section);
  if (working && !can(auth.role, "work")) return notAllowed("work");

  if (section === "web") return handleWeb(request, env, url, ctx, parts, auth);

  if (section === "poll" && parts.length === 2) {
    if (method !== "GET" && method !== "POST") return methodNotAllowed();
    return poll(request, env, auth);
  }

  if (section === "spaces") return handleSpaces(request, env, url, parts, auth);

  const synced = await sync(request, env, url, parts.slice(1));
  if (synced) return synced;

  if (section === "pages" && (parts.length === 2 || parts.length === 3)) {
    if (!can(auth.role, "pages.manage")) return notAllowed("pages.manage");
    return handlePages(request, env, parts, auth);
  }

  if (section === "auth" && parts[2] === "agents") {
    if (!can(auth.role, "agents.own")) return notAllowed("agents.own");
    return handleAgentAdmin(request, env, parts, auth);
  }

  if (section === "auth" && (parts.length === 3 || parts.length === 4)) {
    return handleAuth(request, env, parts, auth);
  }

  if (section === "admin" && parts[2] === "wipe" && parts.length === 3) {
    if (method !== "POST") return methodNotAllowed();
    if (!can(auth.role, "workspace.manage")) return notAllowed("workspace.manage");
    const body = await readJsonObject(request);
    if (body?.confirm !== "wipe") return json({ error: 'body must be {"confirm":"wipe"}' }, 400);
    return wipeBucket(env);
  }

  return json({ error: "not found" }, 404);
}

/* ---------- People ---------- */

/** The database could not answer. Identity IS the database, so these routes
 *  say so instead of pretending nobody has been invited. */
const noDatabase = (): Response => json({ error: "the domain's database isn't answering — try again in a moment" }, 503);

/** The database could not answer a route that needs no row to reach it: the
 *  workspace is down for everyone, and says which way. */
const unavailable = (env: Env): Response =>
  env.DB ? noDatabase() : json({ error: "this domain's worker has no database bound to it" }, 503);

/**
 * The domain's key as a bearer. It is what proves control of the Cloudflare
 * account — only that account sets the env secret — and it buys exactly one
 * thing: a device sign-in as the superadmin (`claimSuperadmin`). The probe
 * answers it too, so the app can tell a fresh domain from a bound one before
 * it trades; it has no `you`, because the key is nobody.
 */
async function handleKey(request: Request, env: Env, parts: string[], keyHash: string): Promise<Response> {
  if (parts.length === 2 && parts[1] === "meta") {
    if (request.method !== "GET") return methodNotAllowed();
    const [workspace, d1] = await Promise.all([readWorkspace(env), ensureSchema(env)]);
    return json({ version: WORKER_VERSION, workspace, d1 });
  }
  if (parts.length === 3 && parts[1] === "auth" && parts[2] === "recover") {
    if (request.method !== "POST") return methodNotAllowed();
    return recoverWithKey(request, env, keyHash);
  }
  return json(
    { error: "the domain's key is no sign-in — it only recovers the workspace, from Doklin's Cloud panel" },
    403,
  );
}

/** Trade the key for this device's own token, as the superadmin. */
async function recoverWithKey(request: Request, env: Env, keyHash: string): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return json({ error: "invalid json body" }, 400);
  const email = normalizeEmail(body.email);
  if (!email) return json({ error: "a valid email address is required" }, 400);
  const deviceId = typeof body.deviceId === "string" && ID_RE.test(body.deviceId) ? body.deviceId : null;
  const name = typeof body.name === "string" ? body.name : null;
  const deviceName = typeof body.deviceName === "string" ? body.deviceName : null;

  const claimed = await claimSuperadmin(env, keyHash, email, name, deviceId, deviceName);
  if (claimed === null) return unavailable(env);
  if (claimed === "spent") {
    return json({ error: "this key has been used already — make a fresh one", code: "key_spent" }, 401);
  }
  return json({ token: claimed.token, tokenId: claimed.tokenId, member: claimed.member }, 201);
}

/**
 * Who the bearer is, as the app has to write it down:
 * the id a manifest this Mac writes will carry in `by`, the role they hold,
 * and `can` — that role's row of the table in roles.ts, which is what the app
 * hides the rest by. All of it came off the token already — `authenticate`
 * resolved it in the row read that let them in — so this costs nothing.
 * `tokenId` is which row of the devices list this credential is, so the app
 * never offers to sign out the Mac it is running on.
 */
function whoIs(auth: Auth): Who {
  return {
    role: auth.role,
    can: allowed(auth.role),
    tokenId: auth.tokenId,
    memberId: auth.memberId,
    email: auth.email,
    name: auth.name,
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

  const redeemed = await redeemInvite(env, await sha256Hex(code), { id: deviceId, name: deviceName, browser: false });
  if (redeemed === null) return unavailable(env);
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
    if (!can(auth.role, "people.invite")) return notAllowed("people.invite");
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
      if (method !== "GET") return methodNotAllowed();
      if (!can(auth.role, "people.see")) return notAllowed("people.see");
      const members = await listMembers(env);
      return members === null ? noDatabase() : json({ members });
    }
    if (method !== "DELETE" && method !== "PATCH") return methodNotAllowed();
    const action = method === "PATCH" ? "people.roles" : "people.remove";
    if (!can(auth.role, action)) return notAllowed(action);
    if (!ENTITY_ID_RE.test(id)) return json({ error: "invalid member id" }, 400);
    // Never your own row, either way: an owner who removed or demoted
    // themselves by a slip would have nobody but another owner to undo it.
    if (auth.memberId === id) {
      return json({ error: "that is your own row — another owner has to change it" }, 409);
    }
    if (method === "PATCH") return changeRole(request, env, id);
    const gone = await removeMember(env, id);
    if (gone === null) return noDatabase();
    if (gone === "superadmin") return json({ error: "the workspace's superadmin cannot be removed" }, 409);
    return gone === true ? new Response(null, { status: 204 }) : json({ error: "no such member" }, 404);
  }

  if (kind === "devices") {
    if (!can(auth.role, "devices.own")) return notAllowed("devices.own");
    // Whose devices the caller may name: an owner anybody's, everyone else
    // their own — and to them somebody else's is what an unknown id is.
    const everyone = can(auth.role, "people.remove");
    if (id === undefined) {
      if (method !== "GET") return methodNotAllowed();
      const devices = await listDevices(env, everyone ? null : auth.memberId);
      return devices === null ? noDatabase() : json({ devices });
    }
    if (id === "code") {
      if (method !== "POST") return methodNotAllowed();
      return createDeviceCode(request, env, auth);
    }
    if (method !== "DELETE") return methodNotAllowed();
    if (!ENTITY_ID_RE.test(id)) return json({ error: "invalid device id" }, 400);
    // Never the credential that is asking: a signed-out device deletes its
    // copy of the workspace, and that is not something to do to the device in
    // hand. Ending its own sign-in is how a device leaves (`session`, below).
    if (auth.tokenId === id) {
      return json(
        {
          error: auth.browser
            ? "that is the browser you are in — sign out of it instead"
            : "that is the device you are on — disconnect it instead of signing it out",
        },
        409,
      );
    }
    const gone = await signOutDevice(env, id, auth.memberId, everyone);
    if (gone === null) return noDatabase();
    if (gone === "superadmin") {
      return json({ error: "that is one of the superadmin's devices — only they sign theirs out" }, 409);
    }
    return gone ? new Response(null, { status: 204 }) : json({ error: "no such device" }, 404);
  }

  if (kind === "session" && id === undefined) {
    if (method !== "DELETE") return methodNotAllowed();
    const gone = await endSession(env, auth.tokenId);
    return gone === null ? noDatabase() : new Response(null, { status: 204, headers: auth.browser ? SIGNED_OUT : {} });
  }

  // `join` only ever answers POST, and that one is handled above the gate.
  if (kind === "join" && id === undefined) return methodNotAllowed();
  return json({ error: "not found" }, 404);
}

/**
 * Invite someone by email, creating the person if this is the first time that
 * address has been seen, and bringing them back if they were removed. The
 * body carries `codeHash`, never a code: the app mints the 100-bit code and
 * hashes it, so a worker log, a D1 backup and this request body are all
 * incapable of letting anyone in.
 */
async function createInvite(request: Request, env: Env, auth: Auth): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return json({ error: "invalid json body" }, 400);
  const email = normalizeEmail(body.email);
  if (!email) return json({ error: "a valid email address is required" }, 400);
  // A code is a way in as the person it is for, and the address is never
  // verified. So once somebody has signed in as a person — here now, or
  // removed since — a code for them is theirs to make, or the superadmin's
  // (`people.recover`): another owner's would open that person's My files
  // and what is shared with them. A row nobody has signed in as is still only an
  // invitation, and any owner may replace its code. The apps ask the same
  // before offering a new code (`mayInviteAgain`, src/cloud.ts and
  // ios/DoklinKit) — change all three.
  const existing = await findMemberByEmail(env, email);
  if (existing === undefined) return noDatabase();
  const established = existing !== null && (existing.role === "superadmin" || existing.lastSeenAt !== null);
  if (established && !can(auth.role, "people.recover") && auth.memberId !== existing.id) {
    return json(
      { error: "they have signed in here before, so a new code for them is theirs to make, or the workspace's superadmin's" },
      409,
    );
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

/**
 * A one-time code for another device of the caller's own: a second Mac, an
 * iPhone. It is an invite for a person who is already here, made by that
 * person — so `POST /api/auth/join` redeems it as it redeems any invite, and
 * the device it lets in is signed in as them, with a token of its own that
 * can be taken back without touching their other devices.
 */
async function createDeviceCode(request: Request, env: Env, auth: Auth): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return json({ error: "invalid json body" }, 400);
  const codeHash = typeof body.codeHash === "string" ? body.codeHash.trim().toLowerCase() : "";
  if (!HASH_RE.test(codeHash)) return json({ error: "codeHash must be the sha256 of the code, in hex" }, 400);
  const now = Date.now();
  const expiresAt =
    typeof body.expiresAt === "number" && Number.isFinite(body.expiresAt) ? Math.floor(body.expiresAt) : 0;
  if (expiresAt <= now || expiresAt > now + MAX_DEVICE_CODE_TTL_MS) {
    const hours = MAX_DEVICE_CODE_TTL_MS / 3_600_000;
    return json({ error: `expiresAt must be a time within the next ${hours} hours` }, 400);
  }

  if (auth.email === null) return notAllowed("devices.own");
  const invite = await putInvite(env, { id: auth.memberId, email: auth.email, name: auth.name }, codeHash, expiresAt);
  if (invite === null) return noDatabase();
  return json({ code: { id: invite.id, createdAt: invite.createdAt, expiresAt: invite.expiresAt } }, 201);
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
  if (member === "superadmin") {
    return json({ error: "the workspace's superadmin is always an owner — the role moves only when somebody recovers the workspace with its Cloudflare account" }, 409);
  }
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
  return json({ ...record, manifestEtag }, 201);
}

/* ---------- Sync ---------- */

/**
 * What a Mac syncs through — the manifest, the blobs, the version store — for
 * whichever space `env` is scoped to. `rest` is the path after `/api` for the
 * shared workspace and after `/api/spaces/<id>` for a space. Null when it is
 * none of the three.
 */
async function sync(request: Request, env: Env, url: URL, rest: string[]): Promise<Response | null> {
  const section = rest[0];
  const method = request.method;

  if (section === "manifest" && rest.length === 1) {
    if (method === "GET") return getManifest(env, url);
    if (method === "PUT") return putManifest(request, env);
    return methodNotAllowed();
  }

  if (section === "blobs" && rest.length === 3) {
    const fileId = rest[1];
    if (!ID_RE.test(fileId)) return json({ error: "invalid file id" }, 400);
    const hash = rest[2];
    if (!BLOB_HASH_RE.test(hash)) return json({ error: "invalid blob hash" }, 400);
    return blob(request, env, fileId, hash);
  }

  // The version store — its own prefix, its own CAS'd index, nothing to do
  // with the manifest's per-file history.
  if (section === "versions" && (rest.length === 2 || rest.length === 3)) {
    return handleVersions(request, env, url, rest[1], rest[2]);
  }

  return null;
}

/* ---------- Spaces ---------- */

/** How many people something can be shared with in one request. */
const MAX_SPACE_INVITEES = 100;

const NAME_RULE = "a shared folder or document needs a name a file can carry: no slashes or colons, and not starting with a dot";
/** What somebody a share is shared with is told when they would place it. */
const NOT_YOURS_TO_PLACE = "This is shared with you: only the people of the folder it sits in can move or delete it. You can leave it instead.";
const MY_FILES_STAY = "My files is its person's for as long as they are here: it is not renamed, moved, shared or deleted. Share a folder or a document in it instead.";

async function handleSpaces(request: Request, env: Env, url: URL, parts: string[], auth: Auth): Promise<Response> {
  const method = request.method;

  if (parts.length === 2) {
    if (method === "GET") {
      const spaces = await listSpaces(env, auth);
      return spaces === null ? noDatabase() : json({ spaces });
    }
    if (method === "POST") return makeSpace(request, env, auth);
    return methodNotAllowed();
  }

  const id = parts[2];
  if (id === "private" && parts.length === 3) {
    if (method !== "PUT") return methodNotAllowed();
    const mine = await ensurePrivate(env, auth);
    return mine === null ? noDatabase() : json({ space: mine });
  }
  if (!SPACE_ID_RE.test(id)) return json({ error: "invalid space id" }, 400);

  // A deleted share answers one route, and only the people who can restore it.
  if (parts[3] === "restore" && parts.length === 4) {
    if (method !== "POST") return methodNotAllowed();
    const gone = await openDeleted(env, auth, id);
    if (gone === null) return noDatabase();
    if (gone === "none") return json({ error: "not found" }, 404);
    const back = await restoreSpace(env, auth, gone);
    if (back === null) return noDatabase();
    return back === "orphan"
      ? json({ error: "The folder this was in is deleted too. Restore that folder, and this comes back with it." }, 409)
      : json({ space: back });
  }

  // The gate: one read, before anything under the space. Not being able to
  // open it and its not existing are one answer.
  const space = await openSpace(env, auth, id);
  if (space === null) return noDatabase();
  if (space === "none") return json({ error: "not found" }, 404);

  if (parts.length === 3) {
    if (method !== "PATCH" && method !== "DELETE") return methodNotAllowed();
    if (space.kind === "private") return json({ error: MY_FILES_STAY }, 409);
    if (method === "DELETE") {
      if (space.parent === null) return json({ error: NOT_YOURS_TO_PLACE }, 403);
      const gone = await deleteSpace(env, space);
      if (gone === null) return noDatabase();
      // Erased, it sits nowhere: the section it sat in stops saying where.
      if (!gone.kept && !gone.remaining) await dropMount(env, space.parent, space.id);
      return json({ deleted: true, ...gone });
    }
    const body = await readJsonObject(request);
    if (!body) return json({ error: "invalid json body" }, 400);
    if (body.parent !== undefined) return placeSpace(env, auth, space, body);
    if (space.kind === "document") {
      return json({ error: "A shared document is called what its file is called: rename the document." }, 409);
    }
    const name = validItemName(body.name);
    if (!name) return json({ error: NAME_RULE }, 400);
    const renamed = await renameSpace(env, auth, space, name);
    return renamed === null ? noDatabase() : json({ space: renamed });
  }

  if (parts[3] === "members" && parts.length === 5) {
    if (method !== "PUT" && method !== "DELETE") return methodNotAllowed();
    const person = parts[4];
    if (!MEMBER_ID_RE.test(person)) return json({ error: "invalid member id" }, 400);
    if (space.kind === "private") return json({ error: MY_FILES_STAY }, 409);
    if (method === "PUT") {
      const now = await addToSpace(env, auth, space, person);
      if (now === null) return noDatabase();
      return now === "missing" ? json({ error: "only people in this workspace can be added" }, 404) : json({ space: now });
    }
    const out = await removeFromSpace(env, space, person);
    if (out === null) return noDatabase();
    if (out === "missing") return json({ error: "it is not shared with them" }, 404);
    if (out === "above") {
      return json({ error: "They can open the folder this sits in, and nothing in a folder is kept from that folder's people." }, 409);
    }
    return new Response(null, { status: 204 });
  }

  // Everything else is the sync API again, on this space's part of the bucket.
  const scoped = spaceEnv(env, space);
  const res = await sync(request, scoped, url, parts.slice(3));
  if (!res) return json({ error: "not found" }, 404);
  // Every answer about the manifest says where it is; when that is not where
  // the poll thinks it is, the poll is put right — after any read that finds
  // an earlier write's note did not land. A write notes its own.
  const etag = parts[3] === "manifest" && method === "GET" ? res.headers.get("x-manifest-etag") : null;
  if (etag && etag !== space.etag) await noteEtag(scoped, etag);
  return res;
}

/** Where a share is to sit, as a request says it: `dir` the folder of the
 *  section its item is in ("" its top, and when unsaid), `was` where the
 *  item was before it was shared. */
function placingOf(body: Record<string, unknown>): Placing | Response {
  const trim = (raw: unknown): string => (typeof raw === "string" ? raw.replace(/^\/+|\/+$/g, "") : "");
  const dir = trim(body.dir);
  const was = body.was === undefined ? undefined : trim(body.was);
  if ((body.dir !== undefined && typeof body.dir !== "string") || (dir !== "" && !validPath(dir)) || (was !== undefined && !validPath(was))) {
    return json({ error: "dir is the folder it sits in, and was where it was before it was shared" }, 400);
  }
  return { dir, ...(was === undefined ? {} : { was }) };
}

/** Put a share in another section (`PATCH {parent, dir?}`): its rows say who
 *  can open it now, and the two sections' manifests where it sits. */
async function placeSpace(env: Env, auth: Auth, space: Space, body: Record<string, unknown>): Promise<Response> {
  if (space.parent === null) return json({ error: NOT_YOURS_TO_PLACE }, 403);
  const at = placingOf(body);
  if (at instanceof Response) return at;
  const to = await parentOf(env, auth, body.parent);
  if (to instanceof Response) return to;
  if (to.id === space.parent) return json({ space });
  const inside = await isInside(env, to.id, space.id);
  if (inside === null) return noDatabase();
  if (inside) return json({ error: "A folder cannot be moved inside itself." }, 400);
  // Where it will sit is said before anybody is told it sits there.
  const placed = await setMount(spaceEnv(env, to), auth.memberId, space.id, at);
  if (placed instanceof Refusal) return json({ error: placed.error }, placed.status);
  const moved = await moveSpace(env, auth, space, to);
  if (moved === null) return noDatabase();
  await dropMount(env, space.parent, space.id);
  return json({ space: moved });
}

/** The section a share is to sit in, as a request names it: one the caller
 *  can open, and one that holds folders. */
async function parentOf(env: Env, auth: Auth, raw: unknown): Promise<Space | Response> {
  if (raw === "") return json({ error: "Nothing in Library is shared separately: it is everyone's." }, 400);
  if (typeof raw !== "string" || !SPACE_ID_RE.test(raw)) return json({ error: "parent is the id of the section it sits in" }, 400);
  const parent = await openSpace(env, auth, raw);
  if (parent === null) return noDatabase();
  if (parent === "none") return json({ error: "That folder is gone, or you can no longer open it." }, 404);
  if (parent.kind === "document") return json({ error: "Nothing sits inside a shared document." }, 400);
  return parent;
}

/**
 * The share already made of the item a request would share: one that sits
 * in the same section, where the item was and is, under its name. "none"
 * when there is none; null when the database cannot say.
 */
async function sharedAlready(
  env: Env,
  auth: Auth,
  parent: Space,
  asked: { id: string; kind: string; name: string },
  at: Placing,
): Promise<Space | "none" | null> {
  if (at.was === undefined) return "none";
  const mounts = (await openWorkspace(spaceEnv(env, parent)))?.manifest.mounts ?? {};
  for (const [other, mount] of Object.entries(mounts)) {
    if (other === asked.id || mount.was !== at.was || mount.dir !== at.dir) continue;
    const space = await openSpace(env, auth, other);
    if (space === null) return null;
    if (space !== "none" && space.parent === parent.id && space.kind === asked.kind && space.name === asked.name) return space;
  }
  return "none";
}

async function makeSpace(request: Request, env: Env, auth: Auth): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return json({ error: "invalid json body" }, 400);
  const { id, kind } = body;
  if (typeof id !== "string" || !SHARE_ID_RE.test(id)) return json({ error: "id is the share's own: s- and eight hex characters" }, 400);
  if (kind !== "folder" && kind !== "document") return json({ error: 'kind is "folder" or "document"' }, 400);
  const name = validItemName(body.name);
  if (!name) return json({ error: NAME_RULE }, 400);
  const people: unknown = body.members ?? [];
  if (
    !Array.isArray(people) ||
    people.length > MAX_SPACE_INVITEES ||
    !people.every((p): p is string => typeof p === "string" && MEMBER_ID_RE.test(p))
  ) {
    return json({ error: `members must be a list of at most ${MAX_SPACE_INVITEES} member ids` }, 400);
  }
  const at = placingOf(body);
  if (at instanceof Response) return at;
  const parent = await parentOf(env, auth, body.parent);
  if (parent instanceof Response) return parent;
  // The same item shared from two of its owner's devices at once is one
  // share: the one already made, with these people as well.
  const twin = await sharedAlready(env, auth, parent, { id, kind, name }, at);
  if (twin === null) return noDatabase();
  if (twin !== "none") {
    let now: Space = twin;
    for (const person of people.filter((p) => p !== auth.memberId && !twin.members.includes(p))) {
      const added = await addToSpace(env, auth, now, person);
      if (added === null) return noDatabase();
      if (added === "missing") return json({ error: "only people in this workspace can be added", unknown: [person] }, 400);
      now = added;
    }
    return json({ space: now }, 201);
  }
  // Where it sits is in its section's manifest before its rows are there:
  // nobody hears of a share before its place can be read.
  const first = async (): Promise<void> => {
    const placed = await setMount(spaceEnv(env, parent), auth.memberId, id, at);
    if (placed instanceof Refusal) throw new Error(placed.error);
  };
  const made = await createSpace(env, auth, { id, kind, name, parent, people, first });
  if (made === null) return noDatabase();
  if (made === "taken") return json({ error: "that id is taken — mint another", code: "id_taken" }, 409);
  if ("unknown" in made) return json({ error: "only people in this workspace can be added", unknown: made.unknown }, 400);
  return json({ space: made }, 201);
}

/* ---------- Every public address ---------- */

async function handlePages(request: Request, env: Env, parts: string[], auth: Auth): Promise<Response> {
  const method = request.method;
  if (parts.length === 2) {
    if (method !== "GET") return methodNotAllowed();
    const every = await listEveryPage(env);
    return every === null ? noDatabase() : json(every);
  }
  if (method !== "DELETE") return methodNotAllowed();
  const slug = parts[2].toLowerCase();
  if (!SLUG_RE.test(slug)) return json({ error: "invalid address" }, 400);
  const done = await takeDownPage(env, auth.memberId, slug);
  if (done !== true) return json({ error: done.error, ...done.extra }, done.status);
  return new Response(null, { status: 204 });
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
  const of = kindOf(env);
  const inSpace = of !== "library";
  const problem = validateManifest(data, of);
  if (problem) return json({ error: problem.error }, problem.status);
  if (takesShared(env, data as Manifest)) return json({ error: NOT_YOURS_TO_TAKE }, 409);

  // Its addresses are claimed before it is stored (addresses.ts). A database
  // that cannot answer does not hold up the shared workspace; a space is its
  // rows, so it does hold that up.
  const claim = await claimAddresses(env, Object.keys((data as Manifest).public ?? {}));
  if (claim === null && inSpace) return noDatabase();
  if (claim && claim.taken.length > 0) return json(takenError(claim.taken), 409);

  const put = await env.DATA.put(MANIFEST_KEY, text, { ...JSON_OBJECT, onlyIf: { etagMatches: baseEtag } });
  if (!put) {
    // Lost the race (or the domain is not bound). Tell the loser where the
    // manifest is now so its next attempt starts from reality.
    const current = await env.DATA.head(MANIFEST_KEY);
    if (!current) return notBound();
    return json({ error: "manifest changed", etag: current.etag }, 412, { "x-manifest-etag": current.etag });
  }
  if (claim) await releaseAddresses(env, claim.stale);
  await noteEtag(env, put.etag, data as Manifest);
  return json({ etag: put.etag, seq: (data as Manifest).seq }, 200, { "x-manifest-etag": put.etag });
}

/* ---------- Blobs ---------- */

/** One stored copy of a file: read it, or store it. */
async function blob(request: Request, env: Env, fileId: string, hash: string): Promise<Response> {
  const key = blobKey(fileId, hash);
  if (request.method === "GET") {
    const obj = await env.DATA.get(key);
    if (!obj) return json({ error: "not found" }, 404);
    // A stored copy never changes under its address, so a browser keeps it
    // for good and never asks again — its own copy only (`private`), and only
    // for the sign-in it was read with (`vary`): after a sign-out the same
    // address is asked of the worker again, and refused.
    return new Response(obj.body, {
      headers: {
        "content-type": obj.httpMetadata?.contentType || "application/octet-stream",
        "content-length": String(obj.size),
        "cache-control": "private, max-age=31536000, immutable",
        vary: "Cookie, Authorization",
      },
    });
  }
  if (request.method === "PUT") {
    const buf = await request.arrayBuffer();
    if (buf.byteLength > MAX_FILE_BYTES) return json({ error: "file too large" }, 413);
    // Content-addressed, so a stored copy is never rewritten with other
    // bytes: create-only. The same bytes again are a push about to name this
    // copy — a file back to an earlier version — so they are stored again,
    // and its day starts over: the daily sweep (sweep.ts) cannot take it
    // before the manifest write that names it lands.
    const httpMetadata = { contentType: request.headers.get("content-type") || "application/octet-stream" };
    const put = await env.DATA.put(key, buf, { httpMetadata, onlyIf: { etagDoesNotMatch: "*" } });
    if (!put && (await sha256Hex(new Uint8Array(buf))).startsWith(hash)) await env.DATA.put(key, buf, { httpMetadata });
    return json({ stored: true, existed: !put, hash, size: buf.byteLength });
  }
  return methodNotAllowed();
}

/* ---------- The poll ---------- */

/**
 * The 15-second question every engine asks — "has the manifest moved?" — and
 * the carrier of its presence beat, its leases, and the spaces the caller is
 * in with where each one's manifest is.
 *
 * The method says whether anything is written. A `GET` reads; a `POST` says
 * "this device is here" (or is leaving), for as long as its `ttl` says, and
 * the engine sends one only when a beat is due — so an idle poll writes
 * nothing and the client decides when a write happens. A worker that wrote
 * on every poll would spend D1's free daily writes on freshness nobody can
 * see.
 *
 * Every answer carries the domain's `limits`, read in the same batch.
 *
 * The etag is the poll's job; presence, leases and spaces are not. When the
 * database cannot answer, presence comes back `{}` and leases and spaces
 * `null` while the etag comes back as it always has — so none is ever on the
 * shared workspace's sync path, and no lease is no lock. A beat this cannot
 * attribute (no device header) or whose path is not one is still a poll: it
 * answers, and records what it can.
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
            space: typeof body.space === "string" && SPACE_ID_RE.test(body.space) ? body.space : "",
            path: typeof body.path === "string" && validPath(body.path) ? body.path : null,
            take: body.take === true,
            ttl: beatTtl(body.ttl),
          };
  }
  const answer = (etag: string, here: Here | null): Response => {
    const said: PollAnswer = {
      manifestEtag: etag,
      presence: here?.presence ?? {},
      leases: here?.leases ?? null,
      spaces: here?.spaces ?? null,
      limits: here?.limits ?? UNKNOWN_LIMITS,
    };
    return json(said);
  };
  const deviceId = auth.deviceId;
  if (beat && deviceId) {
    // In order, for a beat: a domain that holds no workspace answers 404 and
    // records nobody as being in it, or as holding anything. Most polls
    // carry no beat, so the round trip this costs is rare; the idle read
    // below stays parallel.
    const head = await env.DATA.head(MANIFEST_KEY);
    if (!head) return notBound();
    return answer(head.etag, await recordBeat(env, auth, deviceId, beat));
  }
  const [head, here] = await Promise.all([env.DATA.head(MANIFEST_KEY), readHere(env, auth)]);
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
 * in the round that finishes, never before: the caller's credential is a
 * row in it, and would otherwise cut the call off half-done. Everyone's tokens go with it, which is the intent, and so does
 * `removed_tokens`: a wiped domain has taken nobody's access away, so no Mac
 * is told to delete its copy.
 */
async function wipeBucket(env: Env): Promise<Response> {
  let deleted = 0;
  const finish = async (): Promise<Response> => {
    // A database that is bound and did not empty is not done: its people and
    // their tokens would outlive the workspace they were for. The caller
    // repeats while `remaining`, so say so and let the next round try again.
    const emptied = (await wipeSchema(env)) !== null;
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
