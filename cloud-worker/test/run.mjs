// Tests for the cloud worker — plain node, nothing deployed:
//
//   node cloud-worker/test/run.mjs
//
// The worker only touches R2 through the binding interface, so a small
// in-memory fake (etags, conditional puts, listings) is enough to exercise
// every route: the create-only put the binding rests on, the CAS races the
// sync protocol depends on, the validation that keeps a broken device from
// publishing garbage, and the wipe that frees a domain. The TypeScript
// sources are compiled in-process through vite, the way
// verify-harness/*.test.mjs compile the app's pure modules — or, with
//
//   node cloud-worker/test/run.mjs --bundle cloud-worker/dist/doklin-cloud-worker.js
//
// the same suite runs against a bundle scripts/bundle-worker.mjs wrote (the
// mermaid asset then serves instead of answering 503).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "vite";
import { FakeCache, FakeR2 } from "./fake-r2.mjs";
import { FakeD1, brokenD1 } from "./fake-d1.mjs";
import { PIXEL_PNG, SEED_FILES, SEED_PUBLIC, WIDE_TABLE, fidOf, seedThroughApi } from "./seed.mjs";

/* ---------- The worker under test: compiled from src/, or a bundle ---------- */

const workerDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const bundlePath = args.includes("--bundle") ? args[args.indexOf("--bundle") + 1] : undefined;
if (args.includes("--bundle") && !bundlePath) {
  console.error("--bundle needs a path");
  process.exit(2);
}
let worker;
/** The same worker as a module of its own: a second isolate, with the schema
 *  runner's per-isolate memory blank. `tag` only has to be new each time. */
let anotherIsolate;
if (bundlePath) {
  const href = pathToFileURL(path.resolve(bundlePath)).href;
  ({ default: worker } = await import(href));
  anotherIsolate = async (tag) => (await import(`${href}?isolate=${tag}`)).default;
  console.log(`testing the bundle at ${bundlePath}`);
} else {
  const out = await build({
    configFile: false,
    logLevel: "warn",
    build: {
      write: false,
      target: "es2022",
      lib: { entry: path.join(workerDir, "src", "index.ts"), formats: ["es"], fileName: "worker" },
    },
  });
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === "chunk");
  const source = `data:text/javascript,${encodeURIComponent(chunk.code)}`;
  ({ default: worker } = await import(source));
  anotherIsolate = async (tag) => (await import(`${source}${encodeURIComponent(`\n// isolate ${tag}`)}`)).default;
}

/* ---------- Harness ---------- */

const OWNER = "owner-secret-token";
const DEVICE = "d-macbook";
const OTHER_DEVICE = "d-imac";
const fake = new FakeR2();
const db = new FakeD1();
const env = { OWNER_TOKEN: OWNER, DATA: fake, DB: db };

/** What a fully migrated database reports, and the tables it then holds. */
const D1_SCHEMA = 8;
const D1_TABLES = [
  "agent_codes",
  "agent_tokens",
  "agents",
  "board_cards",
  "creator",
  "invites",
  "leases",
  "members",
  "meta",
  "presence",
  "removed_tokens",
  "search_state",
  "search_text",
  "tokens",
];

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const blobHash = (content) => sha256(content).slice(0, 16);

// Alice's token, and the member id behind it. Not planted: the identity test
// below invites her and redeems the code, which is the only way one exists —
// so every "a member can do this" assertion in this file is standing on a
// credential the real routes minted.
let MEMBER;
let ALICE;
const DAY = 24 * 60 * 60 * 1000;
/** A code the way the app will mint one: 20 Crockford characters, shown with
 *  the prefix and the groups, hashed in its canonical form. */
const code = (body) => `dkln-${body.slice(0, 5)}-${body.slice(5, 10)}-${body.slice(10, 15)}-${body.slice(15)}`;
const ALICE_CODE = code("K7QM29XVR48TBHN3WGYD");
const BOB_CODE = code("2ZC4XJ8HP0RTVW5YNQ3M");

async function call(path, { method = "GET", token, device = DEVICE, body, headers = {}, bindings = env } = {}) {
  const init = { method, headers: { "x-doklin-client": "0.0.0-test", ...headers } };
  if (token) init.headers.authorization = `Bearer ${token}`;
  if (device) init.headers["x-doklin-device"] = device;
  if (body !== undefined) {
    if (typeof body === "string" || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      init.body = body;
    } else {
      init.body = JSON.stringify(body);
      init.headers["content-type"] ??= "application/json";
    }
  }
  const res = await worker.fetch(new Request(`https://notes.example.com${path}`, init), bindings);
  // Read the bytes, not the text: the version store round-trips gzip, and a
  // body decoded as UTF-8 could not be compared with what went in.
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // html or empty responses are fine
  }
  return { status: res.status, headers: res.headers, text, bytes, json };
}

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.error(`FAIL ${name}\n     ${err.message}`);
  }
}

const manifest = (seq, files, extra = {}) => ({
  version: 3,
  name: "Notes",
  seq,
  files,
  tombstones: {},
  public: {},
  ...extra,
});
const fileEntry = (p, rev, seed) => ({
  path: p,
  rev,
  hash: blobHash(seed),
  size: 42,
  mtime: 1700000000000,
  // A member id since v3 — who changed it, not which Mac did.
  by: "m-1a2b3c4d",
});
const currentEtag = async () =>
  (await call("/api/manifest", { token: OWNER })).headers.get("x-manifest-etag");
const putManifest = async (body, etag, token = OWNER) =>
  call("/api/manifest", {
    method: "PUT",
    token,
    headers: { "x-base-etag": etag ?? (await currentEtag()) },
    body,
  });

/* ---------- Tests ---------- */

let ws; // the binding, once made
let workerVersion;

// First, because the schema runner remembers a successful migration for the
// life of the isolate: the cold-start postures can only be seen before one.
await test("d1: no binding and a broken binding both leave every route working", async () => {
  const none = await call("/api/meta", { token: OWNER, bindings: { OWNER_TOKEN: OWNER, DATA: fake } });
  assert.equal(none.status, 200, "a domain deployed before the binding existed");
  assert.equal(none.json.d1, null);
  assert.ok(none.json.features.includes("sync"), "…and it is the same worker otherwise");

  const bad = await call("/api/meta", { token: OWNER, bindings: { OWNER_TOKEN: OWNER, DATA: fake, DB: brokenD1() } });
  assert.equal(bad.status, 200, "a database deleted under a deployed worker is not an outage");
  assert.equal(bad.json.d1, null);
});

await test("d1: a fresh database migrates itself, once per isolate", async () => {
  assert.deepEqual(db.tables(), [], "nothing has touched it yet");
  db.queries.length = 0;

  const first = await call("/api/meta", { token: OWNER });
  assert.equal(first.status, 200);
  assert.equal(first.json.d1, D1_SCHEMA, "the probe reports the schema version");
  assert.ok(db.queries.length > 0, "…and the probe is what ran the migration");
  assert.deepEqual(
    db.tables(),
    D1_TABLES,
    "people and who made the workspace, who is here, what they hold, the credentials taken away, agents and theirs, the search mirror, and the runner's own anchor",
  );
  assert.equal(db.value("SELECT schema_version FROM meta WHERE key = 'schema'"), D1_SCHEMA);
  assert.equal(db.rows("SELECT * FROM meta").length, 1, "one row, and re-running never adds another");

  db.queries.length = 0;
  const again = await call("/api/meta", { token: OWNER });
  assert.equal(again.json.d1, D1_SCHEMA);
  // The migration never runs twice in an isolate. Identity does run every
  // time — a probe answers who the caller is and what everyone here is
  // called — but it only ever reads.
  assert.ok(
    db.queries.length > 0 && db.queries.every((sql) => /^\s*SELECT/i.test(sql)),
    `a migrated isolate only reads: ${db.queries.join(" | ")}`,
  );
});

/* ---------- People ---------- */

await test("identity: the owner invites an email, a Mac redeems the code, and that is the only way a token exists", async () => {
  const invited = await call("/api/auth/invites", {
    method: "POST",
    token: OWNER,
    body: { email: " Alice@Example.COM ", name: "Alice", codeHash: sha256("K7QM29XVR48TBHN3WGYD"), expiresAt: Date.now() + DAY },
  });
  assert.equal(invited.status, 201);
  assert.equal(invited.json.invite.email, "alice@example.com", "stored normalized");
  assert.equal(invited.json.invite.name, "Alice");
  assert.ok(/^i-[a-f0-9]{8}$/.test(invited.json.invite.id));
  assert.equal(
    db.value("SELECT COUNT(*) FROM invites WHERE hash = ?", sha256("K7QM29XVR48TBHN3WGYD")),
    1,
    "the row is keyed by the hash of the code — the plaintext never reaches the worker at this end",
  );

  const listed = await call("/api/auth/invites", { token: OWNER });
  assert.equal(listed.json.invites.length, 1);
  assert.equal(listed.json.invites[0].email, "alice@example.com");

  // No bearer — this is the request that produces one.
  const joined = await call("/api/auth/join", {
    method: "POST",
    device: OTHER_DEVICE,
    body: { code: ALICE_CODE, deviceId: OTHER_DEVICE, deviceName: "Alice's Air" },
  });
  assert.equal(joined.status, 201);
  assert.equal(joined.json.token.length, 64, "256 bits, the same as the owner's own credential");
  assert.ok(/^t-[a-f0-9]{8}$/.test(joined.json.tokenId));
  assert.ok(/^m-[a-f0-9]{8}$/.test(joined.json.member.id));
  assert.equal(joined.json.member.email, "alice@example.com");
  assert.equal(joined.json.member.role, "member");
  MEMBER = joined.json.token;
  ALICE = joined.json.member;

  assert.equal(db.value("SELECT COUNT(*) FROM tokens"), 1);
  assert.equal(db.value("SELECT hash FROM tokens"), sha256(MEMBER), "only the hash is kept");
  assert.equal(db.value("SELECT COUNT(*) FROM invites"), 0, "redeeming spends the invite");
  assert.deepEqual((await call("/api/auth/invites", { token: OWNER })).json.invites, []);

  // One-time, and it says the same thing as a code that never existed.
  const twice = await call("/api/auth/join", { method: "POST", body: { code: ALICE_CODE, deviceId: OTHER_DEVICE } });
  assert.equal(twice.status, 401);
  const never = await call("/api/auth/join", { method: "POST", body: { code: code("0000000000000000000Z"), deviceId: DEVICE } });
  assert.equal(never.status, 401);
  assert.deepEqual(never.json, twice.json, "a caller learns whether a code works, never whether it existed");

  assert.equal((await call("/api/meta", { token: MEMBER })).status, 200, "the minted token authenticates");
});

await test("identity: a code survives case, spacing and the prefix — and nothing else gets in", async () => {
  const hash = sha256("2ZC4XJ8HP0RTVW5YNQ3M");
  const invite = async () =>
    call("/api/auth/invites", {
      method: "POST",
      token: OWNER,
      body: { email: "bob@example.com", name: "Bob", codeHash: hash, expiresAt: Date.now() + DAY },
    });
  await invite();

  // Crockford: I and L read back as 1, O as 0, and case never matters. The
  // prefix and the grouping are presentation.
  const typed = " dkln 2zc4x j8hp0 rtvw5 ynq3m ";
  const redeemed = await call("/api/auth/join", {
    method: "POST",
    body: { code: typed, deviceId: "d-bobmac", deviceName: "Bob's mini" },
  });
  assert.equal(redeemed.status, 201, "…so a code that went through an autocorrect still redeems");
  const BOB = redeemed.json.token;
  assert.equal((await call("/api/meta", { token: BOB })).status, 200);

  for (const junk of ["", "hello", "dkln-K7QM2", ALICE_CODE.replace(/.$/, "") + "U", 42, null]) {
    const res = await call("/api/auth/join", { method: "POST", body: { code: junk, deviceId: DEVICE } });
    assert.equal(res.status, 400, `not a code: ${JSON.stringify(junk)}`);
  }

  // Revoking a device takes effect on its next request — there is no session.
  const tokens = await call("/api/auth/tokens", { token: OWNER });
  assert.equal(tokens.status, 200);
  assert.ok(!tokens.text.includes(sha256(BOB)), "the owner is told what exists, never handed it");
  const bobToken = tokens.json.tokens.find((t) => t.email === "bob@example.com");
  assert.equal(bobToken.deviceName, "Bob's mini");
  assert.equal(bobToken.deviceId, "d-bobmac");
  assert.equal((await call(`/api/auth/tokens/${bobToken.id}`, { method: "DELETE", token: OWNER })).status, 204);
  assert.equal((await call("/api/meta", { token: BOB })).status, 401, "revoked on the very next request");
  assert.equal((await call(`/api/auth/tokens/${bobToken.id}`, { method: "DELETE", token: OWNER })).status, 404);
});

await test("identity: one email is one person — case, spacing and a re-invite reach the same row", async () => {
  const before = (await call("/api/auth/members", { token: OWNER })).json.members;
  const bob = before.find((m) => m.email === "bob@example.com");
  assert.ok(bob, "Bob is a person, not a token");
  assert.equal(bob.name, "Bob");

  // A second invite to the same address in a different shape: same row, and a
  // new code that retires the old one rather than adding to it.
  const again = await call("/api/auth/invites", {
    method: "POST",
    token: OWNER,
    body: { email: "  BOB@Example.com ", codeHash: sha256("AAAAAAAAAAAAAAAAAAAA"), expiresAt: Date.now() + DAY },
  });
  assert.equal(again.status, 201);
  assert.equal(again.json.invite.memberId, bob.id, "the same person");
  assert.equal(again.json.invite.name, "Bob", "…and an invite with no name does not rename them");
  assert.equal(db.value("SELECT COUNT(*) FROM invites WHERE member_id = ?", bob.id), 1, "one pending invite per person");

  const renamed = await call("/api/auth/invites", {
    method: "POST",
    token: OWNER,
    body: { email: "bob@example.com", name: "Robert", codeHash: sha256("BBBBBBBBBBBBBBBBBBBB"), expiresAt: Date.now() + DAY },
  });
  assert.equal(renamed.json.invite.name, "Robert", "…but one that carries a name does");
  const after = (await call("/api/auth/members", { token: OWNER })).json.members;
  assert.equal(after.filter((m) => m.email === "bob@example.com").length, 1, "still one row");
  assert.equal(after.length, before.length, "and no new people");

  // The retired code is dead; only the newest one works.
  const stale = await call("/api/auth/join", { method: "POST", body: { code: code("AAAAAAAAAAAAAAAAAAAA"), deviceId: DEVICE } });
  assert.equal(stale.status, 401, "a replaced invite stops working the moment the new one is made");
});

await test("identity: an expired invite is refused and swept, without a reaper", async () => {
  const bob = (await call("/api/auth/members", { token: OWNER })).json.members.find(
    (m) => m.email === "bob@example.com",
  );
  // The clock moves; nothing else does. The row was written by the real
  // route — only its date is rewritten here.
  db.run("UPDATE invites SET expires_at = ? WHERE member_id = ?", Date.now() - 1000, bob.id);
  assert.deepEqual((await call("/api/auth/invites", { token: OWNER })).json.invites, [], "an expired invite is not pending");
  assert.equal(db.value("SELECT COUNT(*) FROM invites WHERE member_id = ?", bob.id), 1, "…though the row is still there");

  const late = await call("/api/auth/join", { method: "POST", body: { code: code("BBBBBBBBBBBBBBBBBBBB"), deviceId: DEVICE } });
  assert.equal(late.status, 401);
  assert.equal(
    db.value("SELECT COUNT(*) FROM invites WHERE member_id = ?", bob.id),
    0,
    "the only row time can delete is one somebody tried to use",
  );

  // The owner can also just withdraw one.
  const fresh = await call("/api/auth/invites", {
    method: "POST",
    token: OWNER,
    body: { email: "carol@example.com", codeHash: sha256("CCCCCCCCCCCCCCCCCCCC"), expiresAt: Date.now() + DAY },
  });
  assert.equal(fresh.json.invite.name, "carol", "no name given, so the address supplies one");
  assert.equal((await call(`/api/auth/invites/${fresh.json.invite.id}`, { method: "DELETE", token: OWNER })).status, 204);
  assert.equal(
    (await call("/api/auth/join", { method: "POST", body: { code: code("CCCCCCCCCCCCCCCCCCCC"), deviceId: DEVICE } })).status,
    401,
  );

  // A date that is past, or a month and a half out, is not an invite at all.
  for (const expiresAt of [Date.now() - 1, Date.now() + 45 * DAY, "soon", undefined]) {
    const res = await call("/api/auth/invites", {
      method: "POST",
      token: OWNER,
      body: { email: "dave@example.com", codeHash: sha256("DDDDDDDDDDDDDDDDDDDD"), expiresAt },
    });
    assert.equal(res.status, 400, `expiresAt ${String(expiresAt)}`);
  }
  for (const codeHash of ["", "nothex", sha256("x").slice(0, 32), 7]) {
    const res = await call("/api/auth/invites", {
      method: "POST",
      token: OWNER,
      body: { email: "dave@example.com", codeHash, expiresAt: Date.now() + DAY },
    });
    assert.equal(res.status, 400, `codeHash ${String(codeHash)}`);
  }
  for (const email of ["", "dave", "dave@example", "a b@example.com", 7]) {
    const res = await call("/api/auth/invites", {
      method: "POST",
      token: OWNER,
      body: { email, codeHash: sha256("DDDDDDDDDDDDDDDDDDDD"), expiresAt: Date.now() + DAY },
    });
    assert.equal(res.status, 400, `email ${String(email)}`);
  }
});

await test("identity: removing a person takes every credential they hold with them", async () => {
  await call("/api/auth/invites", {
    method: "POST",
    token: OWNER,
    body: { email: "erin@example.com", name: "Erin", codeHash: sha256("EEEEEEEEEEEEEEEEEEEE"), expiresAt: Date.now() + DAY },
  });
  const one = await call("/api/auth/join", { method: "POST", body: { code: code("EEEEEEEEEEEEEEEEEEEE"), deviceId: "d-erin1" } });
  assert.equal(one.status, 201);
  const erin = one.json.member;
  // A second device for the same person, invited again.
  await call("/api/auth/invites", {
    method: "POST",
    token: OWNER,
    body: { email: "erin@example.com", codeHash: sha256("FFFFFFFFFFFFFFFFFFFF"), expiresAt: Date.now() + DAY },
  });
  const two = await call("/api/auth/join", { method: "POST", body: { code: code("FFFFFFFFFFFFFFFFFFFF"), deviceId: "d-erin2" } });
  assert.equal(two.json.member.id, erin.id, "one person, two Macs");

  const listed = (await call("/api/auth/members", { token: OWNER })).json.members.find((m) => m.id === erin.id);
  assert.equal(listed.devices, 2, "the People list counts devices");
  assert.equal(listed.lastSeenAt, null, "written by the presence beat, never by authenticating");

  assert.equal((await call(`/api/auth/members/${erin.id}`, { method: "DELETE", token: OWNER })).status, 204);
  for (const mac of [one, two]) {
    const refused = await call("/api/meta", { token: mac.json.token });
    assert.equal(refused.status, 401);
    assert.equal(refused.json.removed, true, "each of her Macs is told its access was taken away");
  }
  assert.equal(db.value("SELECT COUNT(*) FROM tokens WHERE member_id = ?", erin.id), 0, "both tokens went with her");
  assert.equal(db.value("SELECT COUNT(*) FROM invites WHERE member_id = ?", erin.id), 0);
  assert.equal((await call(`/api/auth/members/${erin.id}`, { method: "DELETE", token: OWNER })).status, 404);

  for (const bad of ["nope", "m-xyz", "m-0123456789", "..%2F..%2Fetc", "t-0123abcd%20"]) {
    assert.equal((await call(`/api/auth/members/${bad}`, { method: "DELETE", token: OWNER })).status, 400, bad);
  }
});

await test("identity: POST /api/auth/join is the whole carve-out, and of the other auth routes only the People list is a member's", async () => {
  // Reaching a 400 without a bearer is the proof it is above the gate: the
  // body was read, so the request was never turned away for being anonymous.
  assert.equal((await call("/api/auth/join", { method: "POST", body: { code: "junk" } })).status, 400);

  for (const [path, method] of [
    ["/api/auth/join", "GET"],
    ["/api/auth/join", "DELETE"],
    ["/api/auth/joinx", "POST"],
    ["/api/auth/join/extra", "POST"],
    ["/api/auth/invites", "POST"],
    ["/api/auth/invites", "GET"],
    ["/api/auth/members", "GET"],
    ["/api/auth/tokens", "GET"],
    ["/api/meta", "GET"],
    ["/api/manifest", "GET"],
  ]) {
    const res = await call(path, { method, body: method === "GET" ? undefined : {} });
    assert.equal(res.status, 401, `${method} ${path} without a bearer`);
  }

  // A member is not a little owner: they hold a workspace credential, not an
  // administrative one.
  for (const [path, method] of [
    ["/api/auth/invites", "POST"],
    ["/api/auth/invites", "GET"],
    ["/api/auth/invites/i-00000000", "DELETE"],
    ["/api/auth/members", "POST"],
    [`/api/auth/members/${ALICE.id}`, "PATCH"],
    [`/api/auth/members/${ALICE.id}`, "DELETE"],
    ["/api/auth/tokens", "GET"],
    ["/api/auth/tokens/t-00000000", "DELETE"],
  ]) {
    const res = await call(path, { method, token: MEMBER, body: method === "GET" ? undefined : {} });
    assert.equal(res.status, 403, `${method} ${path} as a member`);
  }
  // Who is here is everybody's to see: a workspace you belong to is one whose
  // people you can name.
  const seen = await call("/api/auth/members", { token: MEMBER });
  assert.equal(seen.status, 200, "the People list answers a member");
  assert.ok(seen.json.members.some((m) => m.id === ALICE.id && m.role === "member" && m.creator === false));

  assert.equal((await call("/api/auth/join", { method: "POST", token: OWNER, body: { code: ALICE_CODE } })).status, 401);
  assert.equal((await call("/api/auth/nonsense", { token: OWNER })).status, 404);
  assert.equal((await call("/api/auth/tokens", { method: "POST", token: OWNER, body: {} })).status, 405);
  assert.equal((await call("/api/auth/join", { method: "PUT", token: OWNER, body: {} })).status, 405);
});

await test("identity: the owner needs no database, and everyone else is one", async () => {
  const noDb = { OWNER_TOKEN: OWNER, DATA: fake };
  const broken = { OWNER_TOKEN: OWNER, DATA: fake, DB: brokenD1() };

  for (const bindings of [noDb, broken]) {
    assert.equal((await call("/api/meta", { token: OWNER, bindings })).status, 200, "the owner is the env secret");
    assert.equal((await call("/api/manifest", { token: OWNER, bindings })).status, 404, "…and every sync route is theirs");
    assert.equal((await call("/api/meta", { token: MEMBER, bindings })).status, 401, "a member cannot be resolved");
    assert.equal((await call("/api/auth/members", { token: OWNER, bindings })).status, 503, "identity IS the database");
    assert.equal((await call("/api/auth/invites", { token: OWNER, bindings })).status, 503);
    assert.equal((await call("/api/auth/tokens", { token: OWNER, bindings })).status, 503);
    const join = await call("/api/auth/join", { method: "POST", bindings, body: { code: ALICE_CODE, deviceId: DEVICE } });
    assert.equal(join.status, 503, "and a redeem says so rather than 'wrong code'");
  }
});

await test("auth: /api/meta rejects a missing or wrong token; owner and member get in", async () => {
  assert.equal((await call("/api/meta")).status, 401);
  assert.equal((await call("/api/meta", { token: "nope" })).status, 401);
  const ok = await call("/api/meta", { token: OWNER });
  assert.equal(ok.status, 200);
  assert.ok(Number.isInteger(ok.json.version) && ok.json.version >= 1);
  workerVersion = ok.json.version;
  assert.ok(ok.json.features.includes("sync"));
  assert.ok(ok.json.features.includes("wipe"));
  assert.ok(ok.json.features.includes("versions"), "this worker mirrors the version store");
  assert.ok(ok.json.features.includes("members"), "…and mints per-person tokens");
  assert.ok(ok.json.features.includes("presence"), "…takes a beat on the poll");
  assert.ok(ok.json.features.includes("leases"), "…and a lease on the beat");
  assert.equal(ok.json.workspace, null, "a fresh domain holds nothing");
  assert.equal((await call("/api/meta", { token: MEMBER })).status, 200);
});

await test("unbound: poll, manifest and workspace are 404 until a workspace is bound", async () => {
  for (const p of ["/api/poll", "/api/manifest", "/api/workspace"]) {
    const res = await call(p, { token: OWNER });
    assert.equal(res.status, 404, p);
    assert.equal(res.json.error, "not bound", p);
  }
  const beat = await call("/api/poll", { method: "POST", token: OWNER, body: { name: "Mac", path: "Home.md" } });
  assert.equal(beat.status, 404, "a poll that beats is still a poll");
  assert.deepEqual(db.rows("SELECT * FROM presence"), [], "and nobody is recorded as being in a workspace that is not there");
  assert.deepEqual(db.rows("SELECT * FROM leases"), [], "…or as holding a document in it");
  const put = await putManifest(manifest(1, {}), "made-up-etag");
  assert.equal(put.status, 404, "a manifest PUT before binding has nothing to update");
  // The public side of a free domain: the landing page, and nothing else.
  const landing = await call("/", { device: null });
  assert.equal(landing.status, 200);
  assert.ok(landing.text.includes("<h1>Notes</h1>") && landing.text.includes("<title>Doklin</title>"));
  assert.ok(landing.text.includes("releases/latest/download/Doklin-macos-arm64.dmg"), "the download button");
  assert.equal((await call("/anything", { device: null })).status, 404);
});

await test("bind: owner only, once — the second bind is 409 with what the domain holds", async () => {
  const member = await call("/api/workspace", { method: "POST", token: MEMBER, body: { name: "x" } });
  assert.equal(member.status, 403);
  const garbage = await call("/api/workspace", {
    method: "POST",
    token: OWNER,
    body: "not json",
    headers: { "content-type": "application/json" },
  });
  assert.equal(garbage.status, 400);

  const made = await call("/api/workspace", {
    method: "POST",
    token: OWNER,
    body: { name: "  Notes  ", deviceName: "Sherin's MacBook Pro", ownerEmail: "Sherin@Example.com", ownerName: "Sherin" },
  });
  assert.equal(made.status, 201);
  assert.match(made.json.id, /^w-[0-9a-f]{12}$/);
  assert.equal(made.json.name, "Notes", "the name is trimmed");
  assert.ok(made.json.manifestEtag, "the bind hands back the etag the first CAS builds on");
  assert.ok(Date.parse(made.json.createdAt) > 0);
  assert.deepEqual(made.json.createdBy, { deviceId: DEVICE, deviceName: "Sherin's MacBook Pro" });
  assert.equal(made.json.owner.email, "sherin@example.com", "whoever bound it is a person too");
  assert.equal(made.json.owner.role, "owner");
  assert.equal(made.json.owner.name, "Sherin");
  ws = made.json;

  const meta = await call("/api/meta", { token: OWNER });
  assert.equal(meta.json.workspace.id, ws.id, "meta reports the binding");
  assert.equal(meta.json.workspace.name, "Notes");
  assert.equal(meta.json.version, workerVersion);

  const again = await call("/api/workspace", {
    method: "POST",
    token: OWNER,
    device: OTHER_DEVICE,
    body: { name: "Other" },
  });
  assert.equal(again.status, 409);
  assert.equal(again.json.workspace.id, ws.id, "the loser is told what the domain holds");
  assert.equal(again.json.workspace.createdBy.deviceName, "Sherin's MacBook Pro");
  assert.equal((await call("/api/meta", { token: OWNER })).json.workspace.name, "Notes", "nothing overwritten");
});

await test("identity: the creator is a person for attribution, and a secret for access", async () => {
  const listed = (await call("/api/auth/members", { token: OWNER })).json.members;
  const sherin = listed.find((m) => m.creator);
  assert.equal(sherin.email, "sherin@example.com", "the bind wrote the row");
  assert.equal(sherin.role, "owner", "whoever holds the domain's secret is an owner");
  assert.equal(listed.filter((m) => m.creator).length, 1);
  assert.equal(db.value("SELECT member_id FROM creator"), sherin.id, "one row says which person that is");

  // Adopting a second address moves the mark rather than minting a second
  // creator; the old row survives as a plain member, because a manifest may
  // already name it — and an address somebody stopped using should not keep
  // an owner's authority.
  const moved = await call("/api/auth/members", {
    method: "POST",
    token: OWNER,
    body: { email: "owner@second.example", name: "Owner Two" },
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.json.member.role, "owner");
  assert.equal(moved.json.member.creator, true);
  const after = (await call("/api/auth/members", { token: OWNER })).json.members;
  assert.equal(after.filter((m) => m.creator).length, 1, "exactly one creator");
  assert.equal(db.value("SELECT COUNT(*) FROM creator"), 1, "…and the table cannot hold a second");
  assert.equal(after.find((m) => m.id === sherin.id).role, "member", "the old address stays as a person");

  // Back, so the rest of the suite reads the way it was written.
  await call("/api/auth/members", { method: "POST", token: OWNER, body: { email: "sherin@example.com" } });
  const back = (await call("/api/auth/members", { token: OWNER })).json.members;
  assert.equal(back.find((m) => m.creator).id, sherin.id);
  await call(`/api/auth/members/${moved.json.member.id}`, { method: "DELETE", token: OWNER });

  // Inviting an existing member never promotes, and inviting an owner never
  // demotes: the role on the row wins over the role an invite implies.
  await call("/api/auth/invites", {
    method: "POST",
    token: OWNER,
    body: { email: "sherin@example.com", codeHash: sha256("11111111111111111111"), expiresAt: Date.now() + DAY },
  });
  assert.equal(
    (await call("/api/auth/members", { token: OWNER })).json.members.find((m) => m.id === sherin.id).role,
    "owner",
    "an invite to the creator's own address does not demote them",
  );
  assert.equal((await call("/api/auth/members", { token: OWNER })).json.members.find((m) => m.id === ALICE.id).role, "member");

  assert.equal((await call("/api/auth/members", { method: "POST", token: OWNER, body: { email: "nope" } })).status, 400);

  // A role is the person's, so a code redeemed for an owner's address is an
  // owner's credential — the creator's other Mac, signed in the ordinary way.
  // What it is NOT is the secret: it has a row, so it can be signed out, and
  // it cannot say who the secret's holder is.
  const redeemed = await call("/api/auth/join", {
    method: "POST",
    body: { code: code("11111111111111111111"), deviceId: "d-sherin2", deviceName: "Sherin's iMac" },
  });
  assert.equal(redeemed.status, 201);
  assert.equal(redeemed.json.member.role, "owner");
  const you = (await call("/api/meta", { token: redeemed.json.token })).json.you;
  assert.equal(you.role, "owner", "the token carries the role on its person's row");
  assert.equal(you.creator, false, "…and only the secret is the creator's credential");
  assert.equal(you.memberId, sherin.id);
  assert.equal((await call("/api/auth/invites", { token: redeemed.json.token })).status, 200, "an owner's routes answer it");
  assert.equal(
    (await call("/api/admin/wipe", { method: "POST", token: redeemed.json.token, body: {} })).status,
    400,
    "…the wipe included: it got as far as asking for the confirmation",
  );
  assert.equal(
    (await call("/api/auth/members", { method: "POST", token: redeemed.json.token, body: { email: "x@example.com" } })).status,
    403,
    "saying who holds the secret is the secret's alone",
  );
  const mine = (await call("/api/auth/tokens", { token: OWNER })).json.tokens.find((t) => t.deviceId === "d-sherin2");
  assert.equal((await call(`/api/auth/tokens/${mine.id}`, { method: "DELETE", token: OWNER })).status, 204);
  assert.equal((await call("/api/meta", { token: redeemed.json.token })).json.removed, true, "signed out like any other Mac");
});

await test("roles: a role is the person's — an owner makes another, and it lands on their very next request", async () => {
  const EVERYTHING = ["work", "people.see", "people.invite", "people.remove", "people.roles", "agents.manage", "workspace.manage"];
  const role = (id, to, token = OWNER) =>
    call(`/api/auth/members/${id}`, { method: "PATCH", token, body: { role: to } });
  const creator = (await call("/api/auth/members", { token: OWNER })).json.members.find((m) => m.creator);

  // What each role may do is one table, and the probe answers the caller's
  // row of it — the same answer every gated route below is decided by.
  assert.deepEqual((await call("/api/meta", { token: MEMBER })).json.you.can, ["work", "people.see"]);
  assert.deepEqual((await call("/api/meta", { token: OWNER })).json.you.can, EVERYTHING);

  assert.equal((await role(ALICE.id, "owner", MEMBER)).status, 403, "a member cannot make an owner — themselves least of all");

  const made = await role(ALICE.id, "owner");
  assert.equal(made.status, 200);
  assert.equal(made.json.member.role, "owner");
  assert.equal(made.json.member.creator, false);
  // The same token, untouched: the role is read off the row on every request.
  const you = (await call("/api/meta", { token: MEMBER })).json.you;
  assert.equal(you.role, "owner");
  assert.deepEqual(you.can, EVERYTHING);
  for (const path of ["/api/auth/invites", "/api/auth/tokens", "/api/auth/agents"]) {
    assert.equal((await call(path, { token: MEMBER })).status, 200, `${path} answers the new owner`);
  }
  assert.equal(
    (await call("/api/auth/members", { token: OWNER })).json.members.filter((m) => m.role === "owner").length,
    2,
    "there can be several owners",
  );

  // What an owner still cannot do. Their own row is another owner's to
  // change: a slip would otherwise leave them nobody to undo it.
  assert.equal((await role(ALICE.id, "member", MEMBER)).status, 409, "not their own role");
  assert.equal((await call(`/api/auth/members/${ALICE.id}`, { method: "DELETE", token: MEMBER })).status, 409, "nor their own removal");
  // And the creator's row is nobody's to change: the domain's secret keeps
  // letting them in whatever a row says, so the row may as well say so.
  assert.equal((await role(creator.id, "member", MEMBER)).status, 409, "the creator stays an owner");
  assert.equal((await role(creator.id, "member")).status, 409, "…even by their own hand");
  assert.equal((await call(`/api/auth/members/${creator.id}`, { method: "DELETE", token: MEMBER })).status, 409);
  assert.equal((await call(`/api/auth/members/${creator.id}`, { method: "DELETE", token: OWNER })).status, 409);
  const still = (await call("/api/auth/members", { token: OWNER })).json.members.find((m) => m.id === creator.id);
  assert.equal(still.role, "owner");
  assert.equal(still.creator, true);

  assert.equal((await role(ALICE.id, "admin")).status, 400, "two roles, and no third");
  assert.equal((await role("m-00000000", "owner")).status, 404);
  assert.equal((await role("nope", "owner")).status, 400);
  assert.equal((await call(`/api/auth/members/${ALICE.id}`, { method: "PUT", token: OWNER, body: {} })).status, 405);

  // A code is a way in as the person it is for, so one for an owner's address
  // is that owner's to make, or the creator's — never another owner's, who
  // could keep it and come back as them. Alice may make one for herself.
  const codeFor = (email, body, token) =>
    call("/api/auth/invites", { method: "POST", token, body: { email, codeHash: sha256(body), expiresAt: Date.now() + DAY } });
  const forCreator = await codeFor(creator.email, "CCCCCCCCCCCCCCCCCCCC", MEMBER);
  assert.equal(forCreator.status, 409, "an owner cannot make a code for the creator's row");
  assert.equal(db.value("SELECT COUNT(*) FROM invites WHERE member_id = ?", creator.id), 0, "…and none was stored");
  assert.equal((await codeFor("alice@example.com", "AAAAAAAAAAAAAAAAAAAA", MEMBER)).status, 201, "her own is hers");
  assert.equal((await codeFor(creator.email, "CCCCCCCCCCCCCCCCCCCC", OWNER)).status, 201, "the creator's is the creator's");
  assert.equal((await codeFor("someone-new@example.com", "NNNNNNNNNNNNNNNNNNNN", MEMBER)).status, 201, "a new person is any owner's to invite");

  // Nor can anyone sign out the Mac they are on: it would delete the copy in
  // their hands. The probe says which row is theirs, so the app never offers.
  const mine = (await call("/api/meta", { token: MEMBER })).json.you.tokenId;
  assert.ok(/^t-[a-f0-9]{8}$/.test(mine));
  assert.equal((await call("/api/meta", { token: OWNER })).json.you.tokenId, null, "the secret is no row");
  assert.equal((await call(`/api/auth/tokens/${mine}`, { method: "DELETE", token: MEMBER })).status, 409);
  assert.equal((await call("/api/meta", { token: MEMBER })).status, 200, "still signed in");

  // And back: a member again, on the next request, with the same token —
  // and every code nobody had used goes with the role, whoever it was for:
  // an owner can make codes for other people's rows, and keep them.
  assert.equal(db.value("SELECT COUNT(*) FROM invites"), 3);
  assert.equal((await role(ALICE.id, "member")).json.member.role, "member");
  assert.equal(db.value("SELECT COUNT(*) FROM invites"), 0, "no code an owner made outlives their being one");
  const kept = await call("/api/auth/join", { method: "POST", body: { code: code("NNNNNNNNNNNNNNNNNNNN"), deviceId: "d-kept" } });
  assert.equal(kept.status, 401, "the one she kept is dead");
  await call(`/api/auth/members/${(await call("/api/auth/members", { token: OWNER })).json.members.find((m) => m.email === "someone-new@example.com").id}`, { method: "DELETE", token: OWNER });
  assert.equal((await call("/api/meta", { token: MEMBER })).json.you.role, "member");
  assert.equal((await call("/api/auth/invites", { token: MEMBER })).status, 403);
  assert.equal((await call("/api/manifest", { token: MEMBER })).status, 200, "the work was never the role's to take");

  // The same when an owner is removed outright. Dan is made an owner, makes a
  // code for Alice's row and keeps it; removed, he is out — on his own token
  // and on the code that would have let him back in as her.
  await codeFor("dan@example.com", "DDDDDDDDDDDDDDDDDDDD", OWNER);
  const dan = (await call("/api/auth/join", { method: "POST", body: { code: code("DDDDDDDDDDDDDDDDDDDD"), deviceId: "d-dan" } })).json;
  assert.equal((await role(dan.member.id, "owner")).status, 200);
  assert.equal((await codeFor("alice@example.com", "BBBBBBBBBBBBBBBBBBBB", dan.token)).status, 201, "an owner may give a member a new code");
  assert.equal((await call(`/api/auth/members/${dan.member.id}`, { method: "DELETE", token: OWNER })).status, 204);
  assert.equal((await call("/api/meta", { token: dan.token })).json.removed, true);
  assert.equal(db.value("SELECT COUNT(*) FROM invites"), 0, "the codes go with the owner who could have kept them");
  const back = await call("/api/auth/join", { method: "POST", body: { code: code("BBBBBBBBBBBBBBBBBBBB"), deviceId: "d-dan" } });
  assert.equal(back.status, 401, "…so the one he kept does not let him back in as Alice");
  assert.equal(db.value("SELECT COUNT(*) FROM tokens WHERE member_id = ?", ALICE.id), 1, "and her row has the one Mac it had");
});

await test("removal: a credential an owner took away is told so — and no other refusal ever says it", async () => {
  await call("/api/auth/invites", {
    method: "POST",
    token: OWNER,
    body: { email: "zed@example.com", codeHash: sha256("ZZZZZZZZZZZZZZZZZZZZ"), expiresAt: Date.now() + DAY },
  });
  const zed = (await call("/api/auth/join", { method: "POST", body: { code: code("ZZZZZZZZZZZZZZZZZZZZ"), deviceId: "d-zed" } })).json;
  assert.equal((await call("/api/poll", { token: zed.token, device: "d-zed" })).status, 200);

  // Signing one Mac out leaves the person, and tells that Mac why it is
  // refused — on every route, not just the one it happened to ask first.
  assert.equal((await call(`/api/auth/tokens/${zed.tokenId}`, { method: "DELETE", token: OWNER })).status, 204);
  assert.equal(db.value("SELECT COUNT(*) FROM removed_tokens WHERE hash = ?", sha256(zed.token)), 1, "kept by its hash, as the token was");
  for (const [path, method] of [
    ["/api/meta", "GET"],
    ["/api/poll", "GET"],
    ["/api/poll", "POST"],
    ["/api/manifest", "GET"],
    ["/api/auth/members", "GET"],
  ]) {
    const refused = await call(path, { method, token: zed.token, device: "d-zed", body: method === "GET" ? undefined : {} });
    assert.equal(refused.status, 401, `${method} ${path}`);
    assert.equal(refused.json.removed, true, `${method} ${path} says the access was removed`);
  }
  assert.ok((await call("/api/auth/members", { token: OWNER })).json.members.some((m) => m.id === zed.member.id), "the person stays");

  // Everything else that is refused is refused without it. A Mac deletes its
  // copy of the workspace on that word, so it is only ever said of a token
  // the database remembers being taken away.
  for (const token of [undefined, "nope", "0".repeat(64), `${zed.token}0`]) {
    const refused = await call("/api/meta", { token });
    assert.equal(refused.status, 401);
    assert.deepEqual(refused.json, { error: "unauthorized" }, `a bearer nobody holds: ${token}`);
  }
  // …least of all by a database that cannot answer: an outage must never
  // read as "your access was removed".
  for (const bindings of [{ OWNER_TOKEN: OWNER, DATA: fake }, { OWNER_TOKEN: OWNER, DATA: fake, DB: brokenD1() }]) {
    const refused = await call("/api/meta", { token: zed.token, bindings });
    assert.equal(refused.status, 401);
    assert.deepEqual(refused.json, { error: "unauthorized" });
    assert.deepEqual((await call("/api/meta", { token: MEMBER, bindings })).json, { error: "unauthorized" }, "nor a live member's");
  }

  // Invited again, the same person signs in with a new credential; the old
  // one stays taken away.
  await call("/api/auth/invites", {
    method: "POST",
    token: OWNER,
    body: { email: "zed@example.com", codeHash: sha256("YYYYYYYYYYYYYYYYYYYY"), expiresAt: Date.now() + DAY },
  });
  const again = (await call("/api/auth/join", { method: "POST", body: { code: code("YYYYYYYYYYYYYYYYYYYY"), deviceId: "d-zed" } })).json;
  assert.equal(again.member.id, zed.member.id);
  assert.equal((await call("/api/meta", { token: again.token })).status, 200);
  assert.equal((await call("/api/meta", { token: zed.token })).json.removed, true);
  assert.equal((await call(`/api/auth/members/${zed.member.id}`, { method: "DELETE", token: OWNER })).status, 204);
  assert.equal((await call("/api/meta", { token: again.token })).json.removed, true, "removing the person takes the new one too");
});

await test("d1: a database from before roles learns who its creator was — once, and never from a later promotion", async () => {
  // A second isolate over a database the previous worker left: schema 6, the
  // one row that could carry the owner role, and a member beside it.
  const old = new FakeD1();
  old.db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, schema_version INTEGER NOT NULL);
    INSERT INTO meta (key, schema_version) VALUES ('schema', 6);
    CREATE TABLE members (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL,
                          created_at INTEGER NOT NULL, last_seen_at INTEGER, disabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE tokens (hash TEXT PRIMARY KEY, id TEXT NOT NULL, member_id TEXT NOT NULL, device_id TEXT,
                         device_name TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE invites (hash TEXT PRIMARY KEY, id TEXT NOT NULL, member_id TEXT NOT NULL,
                          created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    INSERT INTO members VALUES ('m-0000000a', 'ada@example.com', 'Ada', 'owner', 1, NULL, 0);
    INSERT INTO members VALUES ('m-0000000b', 'bob@example.com', 'Bob', 'member', 2, NULL, 0);
  `);
  old.run("INSERT INTO tokens VALUES (?, 't-0000000b', 'm-0000000b', 'd-bob', 'Air', 3)", sha256("bobs-token"));
  const bindings = { OWNER_TOKEN: OWNER, DATA: new FakeR2(), DB: old };
  const fetch = async (isolate, path, token, init = {}) => {
    const res = await isolate.fetch(
      new Request(`https://old.example.com${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      }),
      bindings,
    );
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  const first = await anotherIsolate("upgrade-1");
  const meta = await fetch(first, "/api/meta", OWNER);
  assert.equal(meta.json.d1, D1_SCHEMA);
  assert.equal(old.value("SELECT member_id FROM creator"), "m-0000000a", "the owner row of old was the creator's");
  assert.equal(meta.json.you.memberId, "m-0000000a");
  assert.equal(meta.json.you.creator, true);
  // Bob's token used to authenticate as a member whatever his row said; it
  // still does, because his row says member.
  assert.equal((await fetch(first, "/api/meta", "bobs-token")).json.you.role, "member");

  // Bob is made an owner, and then a stale isolate — one that read schema 6
  // before the bump — runs the step again. The move is guarded by the version
  // it migrates from, so it cannot crown whoever is an owner by then.
  const promoted = await fetch(first, "/api/auth/members/m-0000000b", OWNER, {
    method: "PATCH",
    body: JSON.stringify({ role: "owner" }),
  });
  assert.equal(promoted.json.member.role, "owner");
  old.run("DELETE FROM creator");
  old.run("UPDATE meta SET schema_version = 8 WHERE key = 'schema'");
  old.db.exec(`
    INSERT OR IGNORE INTO creator (id, member_id)
      SELECT 1, id FROM members
       WHERE role = 'owner' AND (SELECT schema_version FROM meta WHERE key = 'schema') < 8
       ORDER BY created_at, id LIMIT 1
  `);
  assert.equal(old.value("SELECT COUNT(*) FROM creator"), 0, "after the bump the move moves nothing");

  // And a database that had no owner row has no creator until one is adopted.
  const blank = new FakeD1();
  blank.db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, schema_version INTEGER NOT NULL);
    INSERT INTO meta (key, schema_version) VALUES ('schema', 6);
    CREATE TABLE members (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL,
                          created_at INTEGER NOT NULL, last_seen_at INTEGER, disabled INTEGER NOT NULL DEFAULT 0);
    INSERT INTO members VALUES ('m-0000000c', 'cy@example.com', 'Cy', 'member', 1, NULL, 0);
  `);
  const second = await anotherIsolate("upgrade-2");
  const res = await second.fetch(
    new Request("https://blank.example.com/api/meta", { headers: { authorization: `Bearer ${OWNER}` } }),
    { OWNER_TOKEN: OWNER, DATA: new FakeR2(), DB: blank },
  );
  const answered = await res.json();
  assert.equal(answered.d1, D1_SCHEMA);
  assert.equal(answered.you.memberId, null, "nobody adopted an identity, so nobody is named");
  assert.equal(blank.value("SELECT COUNT(*) FROM creator"), 0);
});

await test("meta: the probe says who the bearer is, and what everyone here is called", async () => {
  const owner = (await call("/api/meta", { token: OWNER })).json;
  assert.equal(owner.you.role, "owner");
  assert.equal(owner.you.creator, true, "the domain's secret is the creator's");
  assert.equal(owner.you.email, "sherin@example.com", "identity is the adopted row; the secret is the access");
  assert.ok(/^m-[a-f0-9]{8}$/.test(owner.you.memberId), "what a manifest this Mac writes signs with");

  // A member's identity came off their token in the very read that let them
  // in, so saying it back costs nothing.
  const mine = (await call("/api/meta", { token: MEMBER })).json;
  assert.equal(mine.you.role, "member");
  assert.equal(mine.you.creator, false);
  assert.equal(mine.you.memberId, ALICE.id);
  assert.equal(mine.you.email, "alice@example.com");

  // The directory rides on the probe — a manifest names ids, so every Mac has
  // to be able to put a name to one without a request of its own — and it is
  // names and nothing else. The People list, with addresses, roles and
  // devices, is a route of its own.
  assert.ok(mine.people.length >= 2);
  assert.deepEqual(
    [...new Set(mine.people.map((p) => Object.keys(p).sort().join(",")))],
    ["id,name"],
    "no address, no role, no device count",
  );
  assert.ok(mine.people.some((p) => p.id === ALICE.id && p.name === "Alice"));
  assert.ok(mine.people.some((p) => p.id === owner.you.memberId), "the owner is in it too");
  assert.deepEqual(owner.people, mine.people, "the same list, whoever asks");
});

await test("identity: a member is not a limited account — they write, they just do not administer", async () => {
  // Reaching the CAS is the proof: a 412 means the bearer was authorized and
  // the request was turned away by the etag, not by the role. (The CAS test
  // below has Alice land a real manifest.)
  const stale = await call("/api/manifest", {
    method: "PUT",
    token: MEMBER,
    headers: { "x-base-etag": "not-the-current-etag" },
    body: manifest(1, {}),
  });
  assert.equal(stale.status, 412, "a member may write the manifest");
  assert.equal((await call("/api/manifest", { token: MEMBER })).status, 200, "…and read it");
  assert.equal((await call("/api/workspace", { token: MEMBER })).status, 200);

  assert.equal((await call("/api/workspace", { method: "POST", token: MEMBER, body: { name: "x" } })).status, 403);
  assert.equal(
    (await call("/api/admin/wipe", { method: "POST", token: MEMBER, body: { confirm: "wipe" } })).status,
    403,
    "administering the domain is the owner's",
  );
});

await test("workspace: GET describes the binding with what the manifest holds", async () => {
  const res = await call("/api/workspace", { token: MEMBER });
  assert.equal(res.status, 200);
  assert.equal(res.json.id, ws.id);
  assert.equal(res.json.name, "Notes");
  assert.equal(res.json.createdBy.deviceId, DEVICE);
  assert.deepEqual([res.json.files, res.json.bytes], [0, 0]);
  assert.equal((await call("/api/workspace", { method: "PUT", token: OWNER })).status, 405);
});

await test("manifest: the empty v3 manifest, 304 on since, CAS PUT, a stale PUT loses with the current etag", async () => {
  const first = await call("/api/manifest", { token: OWNER });
  assert.equal(first.status, 200);
  const etag0 = first.headers.get("x-manifest-etag");
  assert.equal(etag0, ws.manifestEtag, "the etag the bind returned is the manifest's");
  const fresh = JSON.parse(first.text);
  assert.equal(fresh.version, 3);
  assert.equal(fresh.name, "Notes");
  assert.deepEqual([fresh.seq, fresh.files, fresh.tombstones, fresh.public], [0, {}, {}, {}]);

  const unchanged = await call(`/api/manifest?since=${etag0}`, { token: OWNER });
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.headers.get("x-manifest-etag"), etag0);

  const put1 = await putManifest(manifest(1, { "f-doc1": fileEntry("Projects/plan.md", 1, "v1") }), etag0);
  assert.equal(put1.status, 200, put1.text);
  const etag1 = put1.json.etag;
  assert.ok(etag1 && etag1 !== etag0);
  assert.equal(put1.json.seq, 1);
  assert.equal((await call(`/api/manifest?since=${etag1}`, { token: OWNER })).status, 304);
  assert.equal((await call(`/api/manifest?since=${etag0}`, { token: OWNER })).status, 200);

  const stale = await putManifest(manifest(2, { "f-doc1": fileEntry("Projects/plan.md", 2, "v2") }), etag0);
  assert.equal(stale.status, 412);
  assert.equal(stale.json.etag, etag1, "the loser learns where the manifest is now");

  const noBase = await call("/api/manifest", { method: "PUT", token: OWNER, body: manifest(2, {}) });
  assert.equal(noBase.status, 428);
  const notJson = await call("/api/manifest", {
    method: "PUT",
    token: OWNER,
    headers: { "x-base-etag": etag1, "content-type": "application/json" },
    body: "{nope",
  });
  assert.equal(notJson.status, 400);
  const huge = await call("/api/manifest", {
    method: "PUT",
    token: OWNER,
    headers: { "x-base-etag": etag1 },
    body: "x".repeat(4 * 1024 * 1024 + 1),
  });
  assert.equal(huge.status, 413);
  assert.equal(await currentEtag(), etag1, "none of the rejects touched the manifest");
});

await test("manifest: validation rejects traversal, duplicate paths, bad revs and hashes, bad tombstones", async () => {
  const etag = await currentEtag();
  const bad = [
    [manifest(3, { "f-evil": fileEntry("../evil.md", 1, "x") }), /path/],
    [manifest(3, { "f-a": fileEntry("Same.md", 1, "a"), "f-b": fileEntry("same.md", 1, "b") }), /duplicate/],
    [manifest(3, { "f-a": { ...fileEntry("ok.md", 1, "a"), rev: 0 } }), /rev/],
    [manifest(3, { "f-a": { ...fileEntry("ok.md", 1, "a"), hash: "ZZZ" } }), /hash/],
    [manifest(3, { "f-a": { ...fileEntry("ok.md", 1, "a"), size: -1 } }), /size/],
    [manifest(3, { "Bad Id": fileEntry("ok.md", 1, "a") }), /file id/],
    [manifest(3, {}, { tombstones: { "f-old": { path: "a/../b.md" } } }), /tombstone/],
    [manifest(3, {}, { tombstones: [] }), /tombstones/],
    [manifest(-1, {}), /seq/],
    [manifest(3, {}, { name: "n".repeat(81) }), /name/],
    [{ ...manifest(3, {}), files: [] }, /files/],
    ["[]", /object/],
  ];
  for (const [body, message] of bad) {
    const res = await call("/api/manifest", {
      method: "PUT",
      token: OWNER,
      headers: { "x-base-etag": etag, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    assert.match(res.json.error, message, res.json.error);
  }
  assert.equal(await currentEtag(), etag, "nothing invalid landed");
});

await test("manifest: either side of a schema skew is 426, and the sentence says which one is behind", async () => {
  const newer = await putManifest(manifest(3, {}, { version: 4 }));
  assert.equal(newer.status, 426);
  assert.match(newer.json.error, /update the worker/);
  // An app still writing v2 — `by` a device name, `hist` an array — is not
  // corrupt, it is old, and 426 is the status that says so.
  const older = await putManifest(manifest(3, {}, { version: 2 }));
  assert.equal(older.status, 426);
  assert.match(older.json.error, /update the app/);
  assert.equal((await putManifest(manifest(3, {}, { version: "3" }))).status, 400, "a version that is not a number is garbage");
});

await test("manifest: the public map — slug grammar, reserved words, kinds, references, one root; an entry may outlive its file", async () => {
  const files = { "f-doc1": fileEntry("Projects/plan.md", 1, "v1"), "f-home": fileEntry("Home.md", 1, "home") };
  const good = manifest(4, files, {
    public: {
      k7m2p9qx: { kind: "file", file: "f-doc1", path: "Projects/plan.md", by: "Sherin's MacBook Pro", at: 1757000000000 },
      roadmap: { kind: "dir", path: "Projects/Roadmap", title: "Roadmap", desc: "What we're building" },
      everything: { kind: "dir", path: "" },
      home: { kind: "file", file: "f-home", path: "Home.md", root: true },
      // Deleted last week; the page 404s until the file is back. Kept on purpose.
      ghost: { kind: "file", file: "f-gone", path: "Scratch.md" },
    },
  });
  const ok = await putManifest(good);
  assert.equal(ok.status, 200, ok.text);
  const stored = JSON.parse((await call("/api/manifest", { token: OWNER })).text);
  assert.equal(Object.keys(stored.public).length, 5);

  const etag = await currentEtag();
  const withPublic = (pub) => manifest(5, files, { public: pub });
  const entry = { kind: "file", file: "f-doc1", path: "Projects/plan.md" };
  const bad = [
    [withPublic({ AB: entry }), /slug/],
    [withPublic({ ab: entry }), /slug/],
    [withPublic({ "has_underscore": entry }), /slug/],
    [withPublic({ api: entry }), /slug/],
    [withPublic({ join: entry }), /slug/],
    [withPublic({ page: { ...entry, kind: "folder" } }), /kind/],
    [withPublic({ page: { ...entry, file: "Not An Id" } }), /file/],
    [withPublic({ page: { ...entry, path: "../plan.md" } }), /path/],
    [withPublic({ page: { kind: "dir", path: "a/../b" } }), /path/],
    [withPublic({ page: { kind: "dir", path: 7 } }), /path/],
    [withPublic({ page: { ...entry, title: "t".repeat(301) } }), /title/],
    [withPublic({ page: { ...entry, desc: "d".repeat(601) } }), /desc/],
    [withPublic({ page: { ...entry, root: "yes" } }), /root/],
    [withPublic({ page: { ...entry, at: -1 } }), /at/],
    [withPublic({ one: { ...entry, root: true }, two: { kind: "dir", path: "", root: true } }), /root/],
    [withPublic([]), /public/],
  ];
  for (const [body, message] of bad) {
    const res = await putManifest(body, etag);
    assert.equal(res.status, 400, JSON.stringify(body.public).slice(0, 80));
    assert.match(res.json.error, message, res.json.error);
  }
  assert.equal(await currentEtag(), etag);
});

await test("cas: interleaved writers — the loser gets 412 and lands after re-pulling", async () => {
  const a = await call("/api/manifest", { token: OWNER });
  const base = a.headers.get("x-manifest-etag");
  const current = JSON.parse(a.text);

  const fromA = { ...current, seq: current.seq + 1, files: { ...current.files, "f-a1": fileEntry("a.md", 1, "a1") } };
  assert.equal((await putManifest(fromA, base)).status, 200);

  const fromB = { ...current, seq: current.seq + 1, files: { ...current.files, "f-b1": fileEntry("b.md", 1, "b1") } };
  const putB = await putManifest(fromB, base, MEMBER);
  assert.equal(putB.status, 412);

  const fresh = await call(`/api/manifest?since=${base}`, { token: MEMBER });
  assert.equal(fresh.status, 200);
  const merged = JSON.parse(fresh.text);
  merged.seq += 1;
  merged.files["f-b1"] = fileEntry("b.md", 1, "b1");
  const retry = await putManifest(merged, fresh.headers.get("x-manifest-etag"), MEMBER);
  assert.equal(retry.status, 200, "members sync too");
  const final = JSON.parse((await call("/api/manifest", { token: OWNER })).text);
  assert.ok(final.files["f-a1"] && final.files["f-b1"], "both writers' files survive");
});

await test("workspace: the totals follow the manifest", async () => {
  const res = await call("/api/workspace", { token: OWNER });
  const stored = JSON.parse((await call("/api/manifest", { token: OWNER })).text);
  const n = Object.keys(stored.files).length;
  assert.ok(n >= 4);
  assert.equal(res.json.files, n);
  assert.equal(res.json.bytes, 42 * n);
});

await test("blobs: content-addressed round-trip, list, delete; a re-put is a no-op; bad hash, missing, too large", async () => {
  const content = "# hello\n\nsynced bytes";
  const hash = blobHash(content);
  const put = await call(`/api/blobs/f-doc1/${hash}`, {
    method: "PUT",
    token: OWNER,
    headers: { "content-type": "text/markdown" },
    body: content,
  });
  assert.equal(put.status, 200);
  assert.deepEqual(put.json, { stored: true, existed: false, hash, size: content.length });

  const again = await call(`/api/blobs/f-doc1/${hash}`, { method: "PUT", token: MEMBER, body: "different bytes, same address" });
  assert.equal(again.status, 200);
  assert.equal(again.json.existed, true, "the address already holds these bytes");
  const got = await call(`/api/blobs/f-doc1/${hash}`, { token: MEMBER });
  assert.equal(got.status, 200);
  assert.equal(got.text, content, "the first upload stands");
  assert.equal(got.headers.get("content-type"), "text/markdown");
  assert.equal(got.headers.get("cache-control"), "no-store");

  const list = await call("/api/blobs/f-doc1", { token: OWNER });
  assert.equal(list.status, 200);
  assert.ok(list.json.blobs.some((b) => b.hash === hash && b.size === content.length && b.uploaded));
  assert.deepEqual((await call("/api/blobs/f-nothing", { token: OWNER })).json, { blobs: [] });

  assert.equal((await call("/api/blobs/f-doc1/NOTHEX", { token: OWNER })).status, 400);
  assert.equal((await call("/api/blobs/Bad%20Id/" + hash, { token: OWNER })).status, 400);
  assert.equal((await call("/api/blobs", { token: OWNER })).status, 404);
  assert.equal((await call(`/api/blobs/f-doc1/${"0".repeat(16)}`, { token: OWNER })).status, 404);

  const del = await call(`/api/blobs/f-doc1/${hash}`, { method: "DELETE", token: OWNER });
  assert.equal(del.status, 200);
  assert.equal((await call(`/api/blobs/f-doc1/${hash}`, { token: OWNER })).status, 404);

  const tooBig = new Uint8Array(25 * 1024 * 1024 + 1);
  const rejected = await call(`/api/blobs/f-doc1/${"a".repeat(16)}`, { method: "PUT", token: OWNER, body: tooBig });
  assert.equal(rejected.status, 413);
});

await test("history: the three deprecated routes are gone, in every verb", async () => {
  // The manifest has carried no revisions since the version store landed, and
  // the compatibility rule is what let these go rather than linger as dead
  // routes. A 404 is the whole answer: not a method error, not an empty
  // archive — there is no such thing here any more.
  for (const method of ["GET", "PUT", "DELETE"]) {
    const res = await call("/api/history/f-doc1", { method, token: OWNER, body: method === "PUT" ? {} : undefined });
    assert.equal(res.status, 404, method);
  }
});

/* ---------- The version store ---------- */

const snapId = (ts, device = DEVICE) => `${String(ts).padStart(13, "0")}-${device}`;
const versionsIndex = (snapshots, horizonDays = null) => ({ version: 1, horizonDays, snapshots });
const versionEntry = (id, extra = {}) => ({
  id,
  ts: Number(id.slice(0, 13)),
  device: id.slice(14),
  reason: "interval",
  files: 3,
  bytes: 4096,
  digest: sha256(id),
  ...extra,
});
const T0 = 1756900000000;

await test('versions: no index until one is made; "*" creates it, the etag CAS\'s it, a stale base is 412', async () => {
  assert.equal((await call("/api/versions/index")).status, 401);
  assert.equal((await call("/api/versions/index", { token: OWNER })).status, 404);
  assert.equal((await call("/api/versions/index", { method: "POST", token: OWNER })).status, 405);
  assert.equal((await call("/api/versions/nonsense", { token: OWNER })).status, 404);

  const noBase = await call("/api/versions/index", { method: "PUT", token: OWNER, body: versionsIndex([]) });
  assert.equal(noBase.status, 428, "a PUT with no base etag never lands");

  const first = versionsIndex([versionEntry(snapId(T0))]);
  const created = await call("/api/versions/index", {
    method: "PUT",
    token: OWNER,
    headers: { "x-base-etag": "*" },
    body: first,
  });
  assert.equal(created.status, 200);
  assert.equal(created.json.snapshots, 1);

  // "*" is create-only, so the second device with the same idea loses — and
  // is told where the index actually is, the way a manifest race is settled.
  const raced = await call("/api/versions/index", {
    method: "PUT",
    token: MEMBER,
    headers: { "x-base-etag": "*" },
    body: first,
  });
  assert.equal(raced.status, 412);
  assert.equal(raced.json.etag, created.json.etag, "the loser is told where the index is");

  const got = await call("/api/versions/index", { token: MEMBER });
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("x-versions-etag"), created.json.etag);
  assert.equal(got.headers.get("cache-control"), "no-store");
  assert.deepEqual(got.json, first, "a member reads the index");

  const second = versionsIndex([...first.snapshots, versionEntry(snapId(T0 + 600000, OTHER_DEVICE))], 90);
  const moved = await call("/api/versions/index", {
    method: "PUT",
    token: MEMBER,
    headers: { "x-base-etag": created.json.etag },
    body: second,
  });
  assert.equal(moved.status, 200, "a member mirrors too");
  assert.notEqual(moved.json.etag, created.json.etag);
  const stale = await call("/api/versions/index", {
    method: "PUT",
    token: OWNER,
    headers: { "x-base-etag": created.json.etag },
    body: second,
  });
  assert.equal(stale.status, 412);
  assert.equal(stale.json.etag, moved.json.etag, "and where to start the retry from");
});

await test("versions: the index's shape check — ids, devices, reasons, digests, the horizon and the size cap", async () => {
  const base = (await call("/api/versions/index", { token: OWNER })).headers.get("x-versions-etag");
  const put = (body) =>
    call("/api/versions/index", { method: "PUT", token: OWNER, headers: { "x-base-etag": base }, body });
  const good = versionEntry(snapId(T0));

  assert.equal((await put([])).status, 400, "an index is an object");
  assert.equal((await put({ version: 2, horizonDays: null, snapshots: [] })).status, 400);
  assert.equal((await put({ version: 1, horizonDays: -1, snapshots: [] })).status, 400);
  assert.equal((await put({ version: 1, horizonDays: null, snapshots: {} })).status, 400);
  assert.equal((await put(versionsIndex([versionEntry("not-an-id")]))).status, 400);
  assert.equal((await put(versionsIndex([{ ...good, device: "Bad Device" }]))).status, 400);
  assert.equal((await put(versionsIndex([{ ...good, reason: "vibes" }]))).status, 400);
  assert.equal((await put(versionsIndex([{ ...good, digest: good.digest.slice(0, 16) }]))).status, 400, "the whole sha256");
  assert.equal((await put(versionsIndex([{ ...good, files: -1 }]))).status, 400);
  assert.equal((await put(versionsIndex([{ ...good, label: 7 }]))).status, 400);
  assert.equal((await put(versionsIndex([{ ...good, restoredFrom: "yesterday" }]))).status, 400);
  assert.equal((await put(versionsIndex([good, good]))).status, 400, "one id names one snapshot");

  const oversized = await call("/api/versions/index", {
    method: "PUT",
    token: OWNER,
    headers: { "x-base-etag": base },
    body: JSON.stringify({ version: 1, horizonDays: null, snapshots: [], pad: "x".repeat(1024 * 1024) }),
  });
  assert.equal(oversized.status, 413);

  const ok = await put(versionsIndex([{ ...good, pinned: true, label: "before the rewrite", restoredFrom: null }], 365));
  assert.equal(ok.status, 200, "a named, pinned, restored row is fine");
});

await test("versions: snapshots and blobs are immutable and create-only; the inventory pages; the caps hold", async () => {
  const id = snapId(T0);
  assert.equal((await call(`/api/versions/snapshots/${id}`, { token: OWNER })).status, 404);
  assert.equal((await call("/api/versions/snapshots/not-an-id", { token: OWNER })).status, 400);

  const snapshot = gzipSync(Buffer.from(JSON.stringify({ version: 1, ts: T0, files: { "Home.md": { h: "a", s: 1, m: 2 } } })));
  const put = await call(`/api/versions/snapshots/${id}`, { method: "PUT", token: OWNER, body: snapshot });
  assert.equal(put.status, 200);
  assert.deepEqual(put.json, { stored: true, existed: false, id, size: snapshot.length });
  const again = await call(`/api/versions/snapshots/${id}`, { method: "PUT", token: MEMBER, body: Buffer.from("other bytes") });
  assert.equal(again.json.existed, true, "an id already written stands");
  const gotSnapshot = await call(`/api/versions/snapshots/${id}`, { token: MEMBER });
  assert.deepEqual([...gotSnapshot.bytes], [...snapshot], "the bytes come back as the device wrote them");
  assert.equal(gotSnapshot.headers.get("content-type"), "application/gzip");

  const content = "one\ntwo\nthree\n";
  const hash = sha256(content);
  const body = gzipSync(Buffer.from(content));
  const stored = await call(`/api/versions/blobs/${hash}`, { method: "PUT", token: MEMBER, body });
  assert.deepEqual(stored.json, { stored: true, existed: false, hash, size: body.length });
  assert.equal((await call(`/api/versions/blobs/${hash}`, { method: "PUT", token: OWNER, body: Buffer.from("no") })).json.existed, true);
  assert.deepEqual([...(await call(`/api/versions/blobs/${hash}`, { token: OWNER })).bytes], [...body]);
  // A 16-hex prefix addresses a synced blob; a version blob is the whole hash.
  assert.equal((await call(`/api/versions/blobs/${hash.slice(0, 16)}`, { token: OWNER })).status, 400);
  assert.equal((await call(`/api/versions/blobs/${sha256("nothing")}`, { token: OWNER })).status, 404);
  assert.equal((await call("/api/versions/blobs", { method: "POST", token: OWNER })).status, 405);

  // The inventory is paged: this one prefix holds every version of every
  // file, so a listing answers a page and a cursor, never the whole bucket.
  for (let i = 0; i < 1001; i += 1) await fake.put(`versions/blobs/${sha256(`pad-${i}`)}`, "x");
  const page = await call("/api/versions/blobs", { token: OWNER });
  assert.equal(page.json.blobs.length, 1000);
  assert.ok(page.json.cursor, "there is more to come");
  assert.ok(page.json.blobs.every((b) => /^[a-f0-9]{64}$/.test(b.hash) && b.size > 0 && b.uploaded));
  const rest = await call(`/api/versions/blobs?cursor=${encodeURIComponent(page.json.cursor)}`, { token: OWNER });
  assert.equal(rest.json.blobs.length, 2, "the last pad and the real blob");
  assert.equal(rest.json.cursor, undefined, "the last page carries no cursor");

  assert.equal((await call(`/api/versions/blobs/${hash}`, { method: "DELETE", token: OWNER })).status, 200);
  assert.equal((await call(`/api/versions/blobs/${hash}`, { token: OWNER })).status, 404);
  assert.equal((await call(`/api/versions/snapshots/${id}`, { method: "DELETE", token: OWNER })).status, 200);
  assert.equal((await call(`/api/versions/snapshots/${id}`, { token: OWNER })).status, 404);

  const fatSnapshot = new Uint8Array(4 * 1024 * 1024 + 1);
  assert.equal((await call(`/api/versions/snapshots/${snapId(T0 + 1)}`, { method: "PUT", token: OWNER, body: fatSnapshot })).status, 413);
  const fatBlob = new Uint8Array(25 * 1024 * 1024 + 1);
  assert.equal((await call(`/api/versions/blobs/${sha256("huge")}`, { method: "PUT", token: OWNER, body: fatBlob })).status, 413);
});

/** The presence rows, as the database holds them — what a route wrote, read
 *  without going through one. */
const presenceRows = () => db.rows("SELECT * FROM presence ORDER BY device_id");
/** The leases, as the database holds them. */
const leaseRows = () => db.rows("SELECT * FROM leases ORDER BY path");
const holder = (answer, path) => answer.json.leases.find((l) => l.path === path)?.deviceId ?? null;
const writes = () => db.queries.filter((sql) => !/^\s*SELECT/i.test(sql));

await test("poll: a GET only reads; a POST is the same poll carrying this device's beat", async () => {
  const ownerId = (await call("/api/meta", { token: OWNER })).json.you.memberId;
  db.queries.length = 0;
  const idle = await call("/api/poll", { token: OWNER });
  assert.equal(idle.status, 200);
  assert.equal(idle.json.manifestEtag, await currentEtag());
  assert.deepEqual(idle.json.presence, {}, "nobody has beaten yet");
  assert.deepEqual(writes(), [], "an idle poll writes nothing — the client decides when a write happens");

  const beat = await call("/api/poll", {
    method: "POST",
    token: OWNER,
    body: { name: "Sherin's MacBook Pro", path: "Projects/plan.md" },
  });
  assert.equal(beat.status, 200);
  assert.equal(beat.json.manifestEtag, await currentEtag(), "the etag is the poll's job either way");
  const mine = beat.json.presence[DEVICE];
  assert.equal(mine.name, "Sherin's MacBook Pro", "the Mac's own name");
  assert.equal(mine.memberId, ownerId, "the owner's secret reads no row, so the beat takes the adopted one");
  assert.equal(mine.path, "Projects/plan.md");
  assert.ok(Date.now() - mine.ts < 5000);

  // Alice is here and editing nothing: present, no path, her own person.
  const alice = await call("/api/poll", { method: "POST", token: MEMBER, device: OTHER_DEVICE, body: { path: null } });
  assert.equal(alice.status, 200);
  assert.equal(alice.json.presence[OTHER_DEVICE].memberId, ALICE.id, "who else is here names a person");
  assert.equal(alice.json.presence[OTHER_DEVICE].name, "Alice", "the person's name when the beat carries none");
  assert.equal(alice.json.presence[OTHER_DEVICE].path, undefined);
  assert.ok(alice.json.presence[DEVICE], "the owner's row survives somebody else's beat");
  assert.equal(presenceRows().length, 2, "a row per device, upserted");

  // A second beat from the same Mac moves its row; it never adds one.
  await call("/api/poll", { method: "POST", token: OWNER, body: { name: "Sherin's MacBook Pro", path: "Home.md" } });
  assert.equal(presenceRows().length, 2);
  assert.equal(presenceRows().find((r) => r.device_id === DEVICE).path, "Home.md");

  // A beat it cannot use is still a poll. No device header: it answers and
  // records nothing. A path that is not one: here, idle. Only a body that is
  // not JSON at all is refused — that is a broken client, not a beat.
  const anonymous = await call("/api/poll", { method: "POST", token: OWNER, device: null, body: { name: "?" } });
  assert.equal(anonymous.status, 200);
  assert.ok(anonymous.json.manifestEtag);
  assert.equal(presenceRows().length, 2, "nobody to attribute it to, so nothing written");
  const traversal = await call("/api/poll", { method: "POST", token: MEMBER, device: OTHER_DEVICE, body: { path: "../x" } });
  assert.equal(traversal.status, 200);
  assert.equal(traversal.json.presence[OTHER_DEVICE].path, undefined);
  assert.equal((await call("/api/poll", { method: "POST", token: OWNER, body: "not json" })).status, 400);

  // The old routes are gone, and the poll answers two verbs.
  assert.equal((await call("/api/presence", { method: "PUT", token: OWNER, body: { path: "Home.md" } })).status, 404);
  assert.equal((await call("/api/presence", { method: "DELETE", token: OWNER })).status, 404);
  assert.equal((await call("/api/poll", { method: "PUT", token: OWNER, body: {} })).status, 405);
  assert.equal(await fake.get("presence.json"), null, "and nothing writes the bucket for it");
});

await test("poll: a lapsed row falls out of the window, the next beat sweeps it, and a leave is immediate", async () => {
  db.run(
    "INSERT INTO presence (device_id, member_id, device_name, path, ts) VALUES ('d-ghost', NULL, 'Ghost', 'Old.md', ?)",
    Date.now() - 10 * 60 * 1000,
  );
  const read = await call("/api/poll", { token: MEMBER });
  assert.ok(!read.json.presence["d-ghost"], "out of the TTL window, so not here");
  assert.ok(presenceRows().some((r) => r.device_id === "d-ghost"), "a GET reads, and sweeps nothing");
  await call("/api/poll", { method: "POST", token: OWNER, body: { name: "Sherin's MacBook Pro" } });
  assert.ok(!presenceRows().some((r) => r.device_id === "d-ghost"), "the next beat takes it, without a reaper");

  const leave = await call("/api/poll", { method: "POST", token: MEMBER, device: OTHER_DEVICE, body: { leave: true } });
  assert.equal(leave.status, 200);
  assert.equal(leave.json.manifestEtag, await currentEtag());
  assert.ok(!leave.json.presence[OTHER_DEVICE], "gone in the answer to the leave itself");
  assert.ok(leave.json.presence[DEVICE]);
  assert.ok(!presenceRows().some((r) => r.device_id === OTHER_DEVICE));
});

await test("poll: last seen is the beat's to write, at most once an hour per person", async () => {
  const seen = async (id) =>
    (await call("/api/auth/members", { token: OWNER })).json.members.find((m) => m.id === id).lastSeenAt;
  const ownerId = (await call("/api/meta", { token: OWNER })).json.you.memberId;
  await call("/api/poll", { method: "POST", token: MEMBER, device: OTHER_DEVICE, body: {} });
  const first = await seen(ALICE.id);
  assert.ok(first && Date.now() - first < 5000, "a beat says the person was here");
  assert.ok((await seen(ownerId)) > 0, "the owner too, through the row the beat attributed to them");

  // Within the hour: the beat writes its own row and leaves hers alone.
  const halfHourAgo = Date.now() - 30 * 60 * 1000;
  db.run("UPDATE members SET last_seen_at = ? WHERE id = ?", halfHourAgo, ALICE.id);
  await call("/api/poll", { method: "POST", token: MEMBER, device: OTHER_DEVICE, body: {} });
  assert.equal(await seen(ALICE.id), halfHourAgo, "not on every beat");
  // Past it: moved.
  db.run("UPDATE members SET last_seen_at = ? WHERE id = ?", Date.now() - 2 * 60 * 60 * 1000, ALICE.id);
  await call("/api/poll", { method: "POST", token: MEMBER, device: OTHER_DEVICE, body: {} });
  assert.ok(Date.now() - (await seen(ALICE.id)) < 5000, "an hour stale, and the beat writes it");
  // And never from authenticating: a member's GET poll is a request, not a beat.
  db.run("UPDATE members SET last_seen_at = ? WHERE id = ?", Date.now() - 2 * 60 * 60 * 1000, ALICE.id);
  const stale = await seen(ALICE.id);
  await call("/api/poll", { token: MEMBER, device: OTHER_DEVICE });
  await call("/api/manifest", { token: MEMBER, device: OTHER_DEVICE });
  assert.equal(await seen(ALICE.id), stale);
});

await test("poll: revoking a Mac or removing a person takes them out of presence and their leases at once", async () => {
  const invite = async (email, body) =>
    call("/api/auth/invites", {
      method: "POST",
      token: OWNER,
      body: { email, codeHash: sha256(body), expiresAt: Date.now() + DAY },
    });
  const join = async (body, deviceId) =>
    (await call("/api/auth/join", { method: "POST", body: { code: code(body), deviceId, deviceName: "Air" } })).json;

  await invite("gail@example.com", "GGGGGGGGGGGGGGGGGGGG");
  const gail = await join("GGGGGGGGGGGGGGGGGGGG", "d-gail");
  await call("/api/poll", { method: "POST", token: gail.token, device: "d-gail", body: { name: "Air", path: "Gail.md" } });
  assert.ok(presenceRows().some((r) => r.device_id === "d-gail"));
  assert.ok(leaseRows().some((r) => r.device_id === "d-gail"));
  assert.equal((await call(`/api/auth/tokens/${gail.tokenId}`, { method: "DELETE", token: OWNER })).status, 204);
  assert.ok(!presenceRows().some((r) => r.device_id === "d-gail"), "not 'here now' for the TTL's minute and a half");
  assert.ok(!leaseRows().some((r) => r.device_id === "d-gail"), "…and not holding a document anyone else wants");

  await invite("hal@example.com", "HHHHHHHHHHHHHHHHHHHH");
  const hal = await join("HHHHHHHHHHHHHHHHHHHH", "d-hal");
  await call("/api/poll", { method: "POST", token: hal.token, device: "d-hal", body: { name: "Air", path: "Hal.md" } });
  assert.ok(presenceRows().some((r) => r.member_id === hal.member.id));
  assert.ok(leaseRows().some((r) => r.member_id === hal.member.id));
  assert.equal((await call(`/api/auth/members/${hal.member.id}`, { method: "DELETE", token: OWNER })).status, 204);
  assert.ok(!presenceRows().some((r) => r.member_id === hal.member.id), "the person goes, and so does their row");
  assert.ok(!leaseRows().some((r) => r.member_id === hal.member.id), "…and their lease");
  assert.ok(presenceRows().some((r) => r.device_id === DEVICE), "nobody else's");
});

await test("leases: a beat that names a document claims it, and of two Macs racing for one exactly one holds it", async () => {
  db.run("DELETE FROM leases");
  const ownerId = (await call("/api/meta", { token: OWNER })).json.you.memberId;
  const idle = await call("/api/poll", { token: OWNER });
  assert.deepEqual(idle.json.leases, [], "the poll says who holds what — here, nobody");

  const mine = await call("/api/poll", { method: "POST", token: OWNER, body: { name: "Studio", path: "Projects/Plan.md" } });
  assert.equal(mine.status, 200);
  assert.equal(mine.json.leases.length, 1);
  const lease = mine.json.leases[0];
  assert.equal(lease.path, "projects/plan.md", "keyed lowercased: one file on a case-insensitive disk is one lock");
  assert.equal(lease.deviceId, DEVICE);
  assert.equal(lease.memberId, ownerId, "the holder is a person, resolved the way presence resolves them");
  assert.equal(lease.name, "Studio");
  assert.ok(lease.until > Date.now() && lease.until <= Date.now() + 90_000, "it lives as long as the beat that carries it");

  // Alice opens the same document under the other spelling: refused, and the
  // answer to her own beat says who has it.
  const hers = await call("/api/poll", { method: "POST", token: MEMBER, device: OTHER_DEVICE, body: { path: "projects/plan.md" } });
  assert.equal(hers.status, 200, "a refused claim is still a poll");
  assert.equal(holder(hers, "projects/plan.md"), DEVICE);
  assert.equal(leaseRows().length, 1);
  assert.equal(leaseRows()[0].device_id, DEVICE, "nothing moved");
  assert.equal(hers.json.presence[OTHER_DEVICE].path, "projects/plan.md", "she is here with it open all the same");

  // Two Macs arriving at a free document together: one row, one holder, and
  // both answers name the same one.
  const [a, b] = await Promise.all([
    call("/api/poll", { method: "POST", token: OWNER, device: "d-laptop", body: { name: "Laptop", path: "Race.md" } }),
    call("/api/poll", { method: "POST", token: MEMBER, device: OTHER_DEVICE, body: { path: "Race.md" } }),
  ]);
  const won = leaseRows().filter((r) => r.path === "race.md");
  assert.equal(won.length, 1, "exactly one wins");
  assert.ok(["d-laptop", OTHER_DEVICE].includes(won[0].device_id));
  assert.equal(holder(b, "race.md"), won[0].device_id);
  assert.ok([null, won[0].device_id].includes(holder(a, "race.md")), "the first answer can predate the second claim, never contradict it");

  // An idle poll reads them and writes nothing.
  db.queries.length = 0;
  const read = await call("/api/poll", { token: MEMBER, device: OTHER_DEVICE });
  assert.equal(holder(read, "projects/plan.md"), DEVICE);
  assert.deepEqual(writes(), []);
});

await test("leases: the holder's beat renews, a non-holder's changes nothing, and moving on lets go", async () => {
  db.run("DELETE FROM leases");
  await call("/api/poll", { method: "POST", token: OWNER, body: { name: "Studio", path: "Notes.md" } });
  db.run("UPDATE leases SET until = ? WHERE path = 'notes.md'", Date.now() + 10_000);
  await call("/api/poll", { method: "POST", token: MEMBER, device: OTHER_DEVICE, body: { path: "Notes.md" } });
  const before = leaseRows()[0].until;
  assert.ok(before < Date.now() + 11_000, "a renewal by the non-holder does nothing");
  await call("/api/poll", { method: "POST", token: OWNER, body: { name: "Studio", path: "Notes.md" } });
  assert.ok(leaseRows()[0].until > before + 60_000, "the holder's next beat moves it out by the TTL");

  // A beat that names another document lets go of this one and claims that.
  const moved = await call("/api/poll", { method: "POST", token: OWNER, body: { name: "Studio", path: "Other.md" } });
  assert.deepEqual(leaseRows().map((r) => r.path), ["other.md"], "one Mac, one document");
  assert.equal(holder(moved, "notes.md"), null);
  // So the Mac that was waiting gets it on its own next beat.
  const now = await call("/api/poll", { method: "POST", token: MEMBER, device: OTHER_DEVICE, body: { path: "Notes.md" } });
  assert.equal(holder(now, "notes.md"), OTHER_DEVICE);

  // A beat with nothing open lets go of everything; so does a leave.
  await call("/api/poll", { method: "POST", token: OWNER, body: { name: "Studio" } });
  assert.deepEqual(leaseRows().map((r) => r.device_id), [OTHER_DEVICE]);
  await call("/api/poll", { method: "POST", token: MEMBER, device: OTHER_DEVICE, body: { leave: true } });
  assert.deepEqual(leaseRows(), []);
});

await test("leases: a lapsed one is takeable and swept, and take claims a live one", async () => {
  db.run("DELETE FROM leases");
  db.run(
    "INSERT INTO leases (path, device_id, member_id, device_name, until) VALUES ('old.md', 'd-ghost', NULL, 'Ghost', ?)",
    Date.now() - 1000,
  );
  const read = await call("/api/poll", { token: OWNER });
  assert.equal(holder(read, "old.md"), null, "past its until, nobody holds it");
  const taken = await call("/api/poll", { method: "POST", token: MEMBER, device: OTHER_DEVICE, body: { path: "Old.md" } });
  assert.equal(holder(taken, "old.md"), OTHER_DEVICE, "a lapsed lease is free to claim, with no take");

  db.run(
    "INSERT INTO leases (path, device_id, member_id, device_name, until) VALUES ('gone.md', 'd-ghost', NULL, 'Ghost', ?)",
    Date.now() - 1000,
  );
  await call("/api/poll", { method: "POST", token: OWNER, body: { name: "Studio" } });
  assert.ok(!leaseRows().some((r) => r.path === "gone.md"), "and the next beat sweeps one nobody wants, without a reaper");

  // Live and somebody else's: a plain claim is refused, take is not.
  const refused = await call("/api/poll", { method: "POST", token: OWNER, body: { name: "Studio", path: "Old.md" } });
  assert.equal(holder(refused, "old.md"), OTHER_DEVICE);
  const took = await call("/api/poll", { method: "POST", token: OWNER, body: { name: "Studio", path: "Old.md", take: true } });
  assert.equal(holder(took, "old.md"), DEVICE, "taking over is the same claim without the WHERE");
  assert.equal(leaseRows().find((r) => r.path === "old.md").device_name, "Studio");
  // And the Mac it was taken from cannot take it back by claiming again.
  const back = await call("/api/poll", { method: "POST", token: MEMBER, device: OTHER_DEVICE, body: { path: "Old.md" } });
  assert.equal(holder(back, "old.md"), DEVICE);
  await call("/api/poll", { method: "POST", token: OWNER, body: { name: "Studio" } });
});

await test("poll: with no database, or a broken one, the etag still comes back and only presence and leases go quiet", async () => {
  const etag = await currentEtag();
  for (const bindings of [{ OWNER_TOKEN: OWNER, DATA: fake }, { OWNER_TOKEN: OWNER, DATA: fake, DB: brokenD1() }]) {
    const read = await call("/api/poll", { token: OWNER, bindings });
    assert.equal(read.status, 200, "presence is never on the sync path");
    assert.equal(read.json.manifestEtag, etag);
    assert.deepEqual(read.json.presence, {});
    assert.equal(read.json.leases, null, "not 'nobody holds anything' — the database could not say");
    const beat = await call("/api/poll", { method: "POST", token: OWNER, bindings, body: { name: "Mac", path: "Home.md" } });
    assert.equal(beat.status, 200, "…not even when it carries a beat nobody can write");
    assert.equal(beat.json.manifestEtag, etag);
    assert.deepEqual(beat.json.presence, {});
    assert.equal(beat.json.leases, null, "no lease is no lock, and never a refused poll");
  }
});

/* ---------- The public surface ---------- */

const pub = (path, init = {}) => call(path, { device: null, ...init });
const rawGet = async (path, init = {}) => {
  const res = await worker.fetch(new Request(`https://notes.example.com${path}`, init), env);
  return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
};
const between = (text, a, b) => text.indexOf(a) >= 0 && text.indexOf(b) > text.indexOf(a);

await test(`public: the landing page, robots, icons, the OG image, the mermaid asset (${bundlePath ? "served from the bundle" : "503 unbundled"}); an empty folder page; anything else a 404 page`, async () => {
  // The map the validation test left names a root page whose blob never
  // arrived: the domain root IS that page, and it is not there yet.
  const root = await pub("/");
  assert.equal(root.status, 404);
  assert.match(root.headers.get("content-type"), /text\/html/);
  assert.ok(root.text.includes("Nothing here") && root.text.includes('<meta name="robots" content="noindex">'));
  const head = await rawGet("/", { method: "HEAD" });
  assert.equal(head.status, 404);
  assert.equal(head.bytes.length, 0, "HEAD carries no body");

  const robots = await pub("/robots.txt");
  assert.equal(robots.status, 200);
  assert.match(robots.text, /User-agent: \*/);
  const ico = await pub("/favicon.ico");
  assert.equal(ico.status, 200);
  assert.equal(ico.headers.get("content-type"), "image/x-icon");
  assert.match(ico.headers.get("cache-control"), /immutable/);
  assert.equal((await pub("/apple-touch-icon.png")).headers.get("content-type"), "image/png");
  const og = await rawGet("/og.png");
  assert.equal(og.status, 200);
  assert.equal(og.headers.get("content-type"), "image/png");
  assert.equal(og.bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "a PNG");
  assert.ok(og.bytes.length > 10000, "the real image, not a placeholder");
  assert.ok((await rawGet("/anything/og.png")).bytes.equals(og.bytes), "one static image for every page");

  const mermaid = await pub("/__web/abc123/mermaid.js");
  if (bundlePath) {
    assert.equal(mermaid.status, 200, "the bundle carries the mermaid module");
    assert.match(mermaid.headers.get("content-type"), /javascript/);
    assert.match(mermaid.headers.get("cache-control"), /immutable/);
    assert.match(mermaid.headers.get("etag"), /^"[0-9a-f]{12}"$/, "the build's content tag");
    assert.ok(mermaid.text.includes("mermaidThemeVariables"), "with the app's palette derivation");
  } else {
    assert.equal(mermaid.status, 503, "this compile carries no assets; the bundle script splices them in");
  }

  // The Newsreader the app bundles, byte for byte, from the worker itself.
  const vendored = readFileSync(path.join(workerDir, "..", "src", "assets", "fonts", "newsreader", "newsreader-latin-opsz-normal.woff2"));
  const font = await rawGet("/__web/fonts/newsreader-latin-opsz-normal.woff2");
  assert.equal(font.status, 200);
  assert.equal(font.headers.get("content-type"), "font/woff2");
  assert.match(font.headers.get("cache-control"), /immutable/);
  assert.ok(font.bytes.equals(vendored), "the app's own file");
  assert.equal((await rawGet("/__web/fonts/newsreader-latin-opsz-normal.woff2", { method: "HEAD" })).bytes.length, 0);
  for (const p of ["/__web/fonts/nope.woff2", "/__web/fonts/", "/__web/fonts/x/newsreader-latin-opsz-normal.woff2"]) {
    assert.equal((await pub(p)).status, 404, p);
  }

  // The map the validation test left: a folder page over a folder with
  // nothing in it, and a note whose blob was never uploaded.
  const empty = await pub("/roadmap");
  assert.equal(empty.status, 200);
  assert.ok(empty.text.includes('<h1 class="toc-title">Roadmap</h1>') && empty.text.includes("Nothing here yet."));
  for (const p of ["/k7m2p9qx", "/roadmap/plan", "/k7m2p9qx/raw", "/nope", "/__web/x/app.js", "/raw"]) {
    const res = await pub(p);
    assert.equal(res.status, 404, p);
    assert.ok(res.text.includes("Nothing here"), p);
    assert.ok(res.text.includes('content="noindex"'), p);
  }
  assert.equal((await pub("/", { method: "POST", body: "x" })).status, 405);
  assert.equal((await pub("/k7m2p9qx", { method: "PUT", body: "x" })).status, 405);

  const unknownApi = await call("/api/nope", { token: OWNER });
  assert.equal(unknownApi.status, 404);
  assert.equal(unknownApi.json.error, "not found");
  assert.equal((await call("/api/meta", { method: "POST", token: OWNER, body: {} })).status, 405);
  assert.equal((await call("/api/nope")).status, 401, "auth comes before routing");
});

let seedEtag;
await test("public: the seed workspace loads through the API — blobs upload, the manifest lands on the binding", async () => {
  seedEtag = await seedThroughApi(worker, env, { token: OWNER });
  assert.equal(await currentEtag(), seedEtag);
  const stored = JSON.parse((await call("/api/manifest", { token: OWNER })).text);
  assert.equal(Object.keys(stored.files).length, Object.keys(SEED_FILES).length);
  assert.equal(stored.public.home.root, true);
  assert.equal(stored.files[fidOf("Sizes.md")].path, "Sizes.md");
});

await test("public: a published note renders from its blob — title, noindex, description, the document; the pill only with a rendition; what isn't published, or is gone, is a 404", async () => {
  const page = await pub("/sizes");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.equal(page.headers.get("x-robots-tag"), "noindex");
  assert.equal(page.headers.get("cache-control"), "no-cache");
  assert.ok(page.text.includes("<title>Sizes</title>"), "the lead heading names the page");
  assert.ok(page.text.includes('<meta name="robots" content="noindex">'));
  assert.ok(page.text.includes('<meta name="description" content="Sizes Name Role Location Ada Engineer London">'), page.text.match(/<meta name="description"[^>]*>/)?.[0]);
  assert.ok(page.text.includes('<meta property="og:image" content="https://notes.example.com/og.png">'));
  assert.ok(page.text.includes('<meta property="og:url" content="https://notes.example.com/sizes">'));
  assert.ok(page.text.includes("<h1>Sizes</h1>") && page.text.includes("<th>Name</th>"), "the document");
  assert.ok(!page.text.includes('<nav class="view-pill"'), "no rendition, no pill");
  assert.ok(page.text.includes('published via <a href="/">notes.example.com</a>'));
  assert.equal((await pub("/sizes/raw")).status, 404, "no rendition to serve");
  assert.equal((await pub("/sizes/anything")).status, 404);
  assert.equal((await pub("/scratch")).status, 404, "synced but never published");
  const ghost = await pub("/ghost");
  assert.equal(ghost.status, 404, "an entry whose file is gone");
  assert.ok(ghost.text.includes("Nothing here"));
  const head = await rawGet("/sizes", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.bytes.length, 0);
  assert.match(head.headers.get("content-type"), /text\/html/);
});

await test("public: a note with an html rendition leads with it, framed and sandboxed; ?v=md is the markdown; the pill switches between them", async () => {
  const framed = await pub("/plan");
  assert.equal(framed.status, 200);
  assert.ok(framed.text.includes('<iframe class="raw-frame" src="/plan/raw" sandbox="allow-scripts allow-popups"'), "the rendition is framed");
  assert.ok(framed.text.includes("<title>The plan</title>"), "the title comes from the markdown's lead heading");
  assert.ok(framed.text.includes('<a class="view-seg is-active" href="https://notes.example.com/plan">HTML</a>'));
  assert.ok(framed.text.includes('<a class="view-seg " href="https://notes.example.com/plan?v=md">MD</a>'));
  assert.ok(!framed.text.includes('<main class="doc">'));

  const md = await pub("/plan?v=md");
  assert.equal(md.status, 200);
  assert.ok(md.text.includes('<main class="doc">') && md.text.includes("Ship it by June."));
  assert.ok(md.text.includes('<a class="view-seg is-active" href="https://notes.example.com/plan?v=md">MD</a>'));
  assert.ok(!md.text.includes("<iframe"));

  const raw = await pub("/plan/raw");
  assert.equal(raw.status, 200);
  assert.equal(raw.text, SEED_FILES["Projects/plan.html"], "byte for byte");
  assert.match(raw.headers.get("content-type"), /text\/html/);
  assert.equal(raw.headers.get("content-security-policy"), "sandbox allow-scripts allow-popups", "an opaque origin, framed or not");
  assert.equal(raw.headers.get("x-robots-tag"), "noindex");
});

await test("public: a folder page lists every note under it; nested URLs render with the crumb; a picture inside serves by exact path; what isn't a note, or walks out, is a 404", async () => {
  const toc = await pub("/projects");
  assert.equal(toc.status, 200);
  assert.ok(toc.text.includes('<h1 class="toc-title">Projects</h1>'));
  assert.ok(toc.text.includes('<p class="toc-desc">Everything we&#39;re building</p>'));
  assert.ok(toc.text.includes("5 pages"), toc.text.match(/toc-meta">[^<]*/)?.[0]);
  for (const href of [
    "/projects/plan",
    "/projects/board",
    "/projects/Roadmap/Ship%20the%20boat",
    "/projects/Roadmap/Paint%20it",
    "/projects/Roadmap/Launch",
  ]) {
    assert.ok(toc.text.includes(`href="${href}"`), href);
  }
  assert.ok(toc.text.includes('class="toc-tree toc-cards"'), "a handful of pages lists as cards");
  assert.ok(toc.text.includes('<span class="toc-card-path">Roadmap</span>'), "a card wears its folder");
  assert.ok(!toc.text.includes("store.jsonl") && !toc.text.includes("pic.png"), "only notes are pages");
  assert.ok(toc.text.includes('<meta property="og:type" content="website">'));

  const nested = await pub("/projects/plan?v=md");
  assert.equal(nested.status, 200);
  assert.ok(nested.text.includes('<a class="home-crumb" href="/projects">'), "the crumb points at the folder");
  assert.ok(nested.text.includes('<span class="home-crumb-label">Projects</span>'));
  assert.ok(nested.text.includes('href="https://notes.example.com/projects/plan?v=md"'), "the pill keeps the nested address");
  assert.ok((await pub("/projects/plan")).text.includes('src="/projects/plan/raw"'), "the framed rendition loads from the nested address");
  assert.equal((await pub("/projects/plan/raw")).text, SEED_FILES["Projects/plan.html"]);
  assert.equal((await pub("/projects/PLAN?v=md")).status, 200, "paths match case-insensitively, like the disk they live on");
  assert.equal((await pub("/projects/plan.md?v=md")).status, 200, "the extension may be spelled out");
  assert.ok(!(await pub("/plan?v=md")).text.includes('<a class="home-crumb"'), "reached on its own slug, a note has no crumb");

  const card = await pub("/projects/Roadmap/Ship%20the%20boat");
  assert.equal(card.status, 200);
  assert.ok(card.text.includes("<title>Ship the boat</title>"), "a card without a heading is named after its file");
  assert.ok(card.text.includes("The hull is done."));

  const pic = await rawGet("/projects/assets/pic.png");
  assert.equal(pic.status, 200);
  assert.equal(pic.headers.get("content-type"), "image/png");
  assert.ok(pic.bytes.equals(PIXEL_PNG));
  const rendition = await rawGet("/projects/plan.html");
  assert.equal(rendition.status, 200, "an html file by its exact path");
  assert.equal(rendition.headers.get("content-security-policy"), "sandbox allow-scripts allow-popups");

  for (const p of [
    "/projects/store.jsonl",
    "/projects/Roadmap/store.jsonl",
    "/projects/Roadmap",
    "/projects/nope",
    "/projects/plan/nope",
    "/projects/%2e%2e/Home",
    "/projects/Roadmap%2FLaunch",
    "/projects//plan",
    "/projects/plan/raw/raw",
  ]) {
    assert.equal((await pub(p)).status, 404, p);
  }
});

await test("public: boards and tables derive from the synced datastore; cards link to their pages when they have one; a card page shows its properties", async () => {
  const page = await pub("/projects/board");
  assert.equal(page.status, 200);
  assert.ok(!page.text.includes("language-kanban") && !page.text.includes("language-table"), "the fences became views");
  assert.ok(!page.text.includes("store: ./Roadmap"), "config text never shows");
  assert.match(page.text, /<span class="dk-embed-kind"><svg[^>]*>.*?<\/svg>Board<\/span>/, "the embed's bar names its kind");
  assert.match(page.text, /<span class="dk-embed-kind"><svg[^>]*>.*?<\/svg>Table<\/span>/);
  assert.ok(page.text.includes('<span class="dk-board-title">Roadmap</span>'));
  // The board part of the page, before the table view of the same store.
  const board = page.text.slice(0, page.text.indexOf('<table class="dk-table">'));
  const column = (color, name, count) =>
    new RegExp(
      `<section class="dk-col dk-color-${color}"><header class="dk-col-head"><span class="dk-col-glyph"><svg[^>]*>(.*?)</svg></span><span class="dk-col-name">${name}</span><span class="dk-col-count">${count}</span>`,
    );
  // A board grouped by a select with a finished option tracks progress: each
  // column wears its stage — not started, on the way, done — as the app's glyph.
  assert.match(board, column("grey", "Backlog", 1), "a column with its option's colour and its count");
  assert.match(board.match(column("grey", "Backlog", 1))[1], /stroke-dasharray/, "the first stage hasn't started: a dashed ring");
  assert.match(board.match(column("blue", "In progress", 1))[1], /A3\.5 3\.5 0 0 1 /, "a stage on the way: a ring filling");
  assert.match(board.match(column("green", "Done", 1))[1], /class="dk-glyph-check"/, "the finished column: a check");
  assert.ok(board.includes('done</span>') && board.includes("1 of 3 done") && board.includes('style="width:33%"'), "progress over the board");
  assert.ok(
    page.text.includes('<a class="dk-card-title" href="/projects/Roadmap/Ship%20the%20boat">Ship the boat</a>'),
    "a card inside the published folder links to its nested page, not its own slug",
  );
  assert.ok(page.text.includes('<a class="dk-card-title" href="/projects/Roadmap/Paint%20it">Paint it</a>'));
  assert.match(
    board,
    /<li class="dk-card is-done"><a class="dk-card-title" href="\/projects\/Roadmap\/Launch"><span class="dk-card-check"><svg[^>]*>.*?<\/svg><\/span>Launch<\/a>/,
    "a card in the finished column is checked",
  );
  assert.ok(board.includes('<div class="dk-card-excerpt">The hull is done.</div>'), "a card shows its excerpt, as the view does in the app");
  assert.match(board, /<span class="dk-card-date(?: is-soon)?" title="Due"><svg[^>]*>.*?<\/svg>Dec 4(?:, 2026)?<\/span>/, "a date sits in the card's foot");
  assert.ok(!board.includes(">2026-12-04<"), "…not as a pill");
  assert.ok(page.text.includes('<span class="dk-chip dk-color-green">Ada</span>'), "a chip takes the option's colour");
  assert.ok(page.text.includes('<span class="dk-chip dk-color-red">paint</span>'));
  assert.ok(page.text.includes('<span class="dk-board-sub">3 cards</span>'), "the table counts its cards");
  assert.ok(page.text.includes('<th class="dk-th">Status</th>') && page.text.includes('<th class="dk-th">Due</th>'));
  assert.ok(page.text.includes('<a class="dk-row-title" href="/projects/Roadmap/Launch">Launch</a>'));
  assert.ok(page.text.includes("Everything after the board is ordinary prose."));

  // The same kind of store from outside any published folder: its cards have no
  // page, so they are titles, not dead links.
  const ideas = await pub("/ideas");
  assert.equal(ideas.status, 200);
  assert.ok(ideas.text.includes('<span class="dk-card-title">Teleporter</span>'), "not a link");
  assert.match(
    ideas.text,
    /<section class="dk-col dk-color-yellow"><header class="dk-col-head"><span class="dk-col-glyph"><svg[^>]*><circle cx="8" cy="8" r="3.75" fill="currentColor" stroke="none"\/><\/svg><\/span><span class="dk-col-name">New<\/span>/,
    "a board with no finished option tracks nothing: a plain dot in the column's colour",
  );
  assert.ok(ideas.text.includes('<span class="dk-board-sub">2 cards</span>') && !ideas.text.includes('<span class="dk-progress"'), "no progress claimed");
  assert.ok(ideas.text.includes('<span class="dk-card-title">Jetpack</span>'), "a note without frontmatter is a card too");
  assert.ok(!ideas.text.includes('href="/Ideas/'), "no dead links");

  const card = await pub("/ship");
  assert.equal(card.status, 200);
  assert.ok(card.text.includes('<div class="dk-props">'));
  assert.ok(card.text.includes('<div class="dk-prop-label">Status</div><div class="dk-prop-value"><span class="dk-chip dk-color-blue">In progress</span></div>'));
  assert.ok(card.text.includes('<div class="dk-prop-label">Owner</div><div class="dk-prop-value"><span class="dk-chip dk-color-green">Ada</span></div>'));
  assert.ok(card.text.includes('<div class="dk-prop-label">Tags</div><div class="dk-prop-value"><span class="dk-chip dk-color-grey">hull</span></div>'));
  assert.ok(!card.text.includes("rank"), "a card's rank is not a property");
  assert.ok(!card.text.includes("<hr"), "the frontmatter never reaches marked");
  assert.ok(between(card.text, '<main class="doc">', '<div class="dk-props">') && between(card.text, '<div class="dk-props">', "<p>The hull is done.</p>"), "properties sit above the body, inside the document");
  const launch = await pub("/projects/Roadmap/Launch");
  assert.ok(launch.text.includes('dk-color-green">Done</span>') && !launch.text.includes('dk-prop-label">Owner'), "unset values are left out");
});

await test("public: every page wears the app's own theme — its tokens light and dark, its Newsreader — with nothing the browser can't ask for", async () => {
  const tokens = readFileSync(path.join(workerDir, "..", "src", "styles", "tokens.css"), "utf8");
  const block = (selector) => tokens.slice(tokens.indexOf(`${selector} {`)).split("}")[0];
  const value = (selector, name) => block(selector).match(new RegExp(`${name}: ([^;]+);`))[1];
  const light = { sheet: value('[data-theme="light"]', "--sheet"), accent: value('[data-theme="light"]', "--accent") };
  const dark = { sheet: value('[data-theme="dark"]', "--sheet"), accent: value('[data-theme="dark"]', "--accent") };
  const paper = value('[data-theme="paper"]', "--sheet");
  assert.notEqual(light.accent, dark.accent, "the file's two palettes differ, so the checks below mean something");
  for (const p of ["/home", "/projects", "/plan", "/nope", "/"]) {
    const res = await pub(p);
    const css = res.text.slice(res.text.indexOf("<style>"), res.text.indexOf("</style>"));
    const media = css.indexOf("@media (prefers-color-scheme: dark)");
    assert.ok(media > 0, `${p}: the dark palette answers the reader's preference`);
    assert.ok(css.slice(0, media).includes(`--accent: ${light.accent}`) && css.slice(0, media).includes(`--sheet: ${light.sheet}`), `${p}: light is :root`);
    assert.ok(css.slice(media).includes(`--accent: ${dark.accent}`) && css.slice(media).includes(`--sheet: ${dark.sheet}`), `${p}: dark under the media query`);
    assert.ok(!css.includes("data-theme") && !css.includes(paper) && !css.includes("data-doc-font"), `${p}: no palette a browser can't ask for`);
    assert.ok(css.includes('url("/__web/fonts/newsreader-latin-opsz-normal.woff2")') && !css.includes("../assets"), `${p}: the faces point at the worker`);
    assert.ok(!css.includes("Design tokens") && !css.includes("SIL Open Font License"), `${p}: the app's comments stay in its files`);
  }
  const note = await pub("/home");
  assert.ok(note.text.includes('<link rel="preload" href="/__web/fonts/newsreader-latin-opsz-normal.woff2" as="font" type="font/woff2" crossorigin>'), "a page set in the serif asks for it early");
  assert.ok(!(await pub("/plan")).text.includes('rel="preload"'), "a framed rendition sets no serif of its own, so fetches none");
});

await test("public: column widths come from the meta sidecar under the app's own table identity; comment markers are stripped; the hydrator rides only pages with a diagram", async () => {
  const sizes = await pub("/sizes");
  assert.ok(
    sizes.text.includes('<table class="dk-cols"><colgroup><col style="width:260px"><col><col style="width:140px"></colgroup>'),
    "the record found its table — the same id the desktop derived (pinned in verify-harness/tablewidths.test.mjs)",
  );
  assert.ok(sizes.text.includes('class="dk-table-scroll"'));
  assert.ok(!sizes.text.includes("mermaid.js"), "no diagram, no script");

  const comments = await pub("/comments");
  assert.ok(comments.text.includes("A sentence with a highlighted phrase and more after it."), "the highlight unwrapped, the marker gone");
  assert.ok(!comments.text.includes("{==") && !comments.text.includes("<<}") && !comments.text.includes("c-1"));
  assert.ok(!comments.text.includes("Say it plainer"), "bodies never leave the sidecar");

  const diagram = await pub("/diagram");
  assert.ok(diagram.text.includes('<code class="language-mermaid">flowchart LR'), "the source stays a code block for readers without scripts");
  assert.match(diagram.text, /import\("\/__web\/[a-z0-9]+\/mermaid\.js"\)/, "the hydrator imports the tagged module");
  if (!bundlePath) assert.ok(diagram.text.includes("/__web/dev/mermaid.js"), "a source compile tags its module dev");
  assert.ok(diagram.text.includes("themeVariables: mod.mermaidThemeVariables()"), "the page's own palette");
});

await test("public: links between notes rewrite to public URLs — inside the folder they were reached through first — or fall back to text; pictures inside a published folder resolve; other links stay", async () => {
  const home = await pub("/home");
  assert.equal(home.status, 200);
  assert.ok(home.text.includes('<a href="/plan">the plan</a>'), "a note with its own slug");
  assert.ok(home.text.includes('<a href="/projects/board">board</a>'), "a note inside a published folder");
  assert.ok(home.text.includes("or a scratch note;") && !home.text.includes("Scratch.md"), "an unpublished target is plain text");
  assert.ok(home.text.includes('<a href="https://github.com/boat-builder/doklin">source</a>'), "an external link stays");
  assert.ok(home.text.includes('<a href="#home">this page</a>'), "an anchor stays");
  assert.ok(home.text.includes('<img src="/projects/assets/pic.png" alt="a picture">'), "a picture inside a published folder");
  assert.ok(home.text.includes("a missing picture") && !home.text.includes("none.png"), "a picture nobody can reach is its alt text");

  const board = await pub("/projects/board");
  assert.ok(board.text.includes('<a href="/projects/plan">the plan</a>'), "from inside the folder, the folder's address wins over the note's own slug");
  assert.ok(board.text.includes('<a href="/home">home</a>'), "a note outside the folder, on its own slug");
  const plan = await pub("/plan?v=md");
  assert.ok(plan.text.includes('<a href="/projects/board">board</a>'), "reached on its own slug, a sibling links into the folder that holds it");
  assert.ok(plan.text.includes('<a href="/ideas">ideas</a>'), "a link written with ../");
});

await test("public: the root page serves at /; renders cache under the manifest's etag and re-key when it moves; the landing page when the map names no root", async () => {
  const root = await pub("/");
  assert.equal(root.status, 200);
  assert.ok(root.text.includes("<title>Home</title>") && root.text.includes("<h1>Home</h1>"));
  assert.ok(root.text.includes('<meta property="og:url" content="https://notes.example.com/">'));
  assert.equal((await pub("/raw")).status, 404, "Home has no rendition");
  assert.ok((await pub("/home")).text.includes('<meta property="og:url" content="https://notes.example.com/home">'), "and answers under its slug too");

  // The cache: a fake `caches.default`, the way the runtime provides one.
  const cache = new FakeCache();
  globalThis.caches = { default: cache };
  try {
    const first = await pub("/sizes");
    assert.equal(first.headers.get("cache-control"), "no-cache", "the browser is never told to keep a page");
    assert.deepEqual(cache.puts, [`https://cache.doklin/${seedEtag}/sizes`], "keyed by the manifest's etag and the path");
    assert.equal(cache.store.get(cache.puts[0]).headers.get("cache-control"), "public, max-age=86400", "the cache keeps it for a day");
    const again = await pub("/sizes");
    assert.equal(cache.hits, 1, "the second read is a cache hit");
    assert.equal(again.text, first.text);
    assert.equal(again.headers.get("cache-control"), "no-cache");
    await pub("/sizes?v=md");
    assert.equal(cache.puts.length, 2, "the query is part of the key");
    assert.equal((await pub("/nope")).status, 404);
    assert.equal(cache.puts.length, 3, "a 404 for this manifest is cached too");
    assert.equal((await pub("/robots.txt")).status, 200);
    assert.equal(cache.puts.length, 3, "statics never go through the cache");

    // The manifest moves: every URL gets a new key, and nothing stale can be served.
    const current = JSON.parse((await call("/api/manifest", { token: OWNER })).text);
    const moved = await putManifest({
      ...current,
      seq: current.seq + 1,
      public: { ...current.public, sizes: { ...current.public.sizes, title: "Measurements" } },
    });
    assert.equal(moved.status, 200);
    const renamed = await pub("/sizes");
    assert.ok(renamed.text.includes("<title>Measurements</title>"), "the new title, not the cached page");
    assert.equal(cache.puts[cache.puts.length - 1], `https://cache.doklin/${moved.json.etag}/sizes`);
    assert.equal(cache.hits, 1, "nothing under the old key was served");
  } finally {
    delete globalThis.caches;
  }

  // No root page: the landing page.
  const current = JSON.parse((await call("/api/manifest", { token: OWNER })).text);
  const withoutRoot = { ...current.public, home: { ...current.public.home, root: false } };
  assert.equal((await putManifest({ ...current, seq: current.seq + 1, public: withoutRoot })).status, 200);
  const landing = await pub("/");
  assert.ok(landing.text.includes("<h1>Notes</h1>") && landing.text.includes("Download Doklin"));
  assert.equal((await pub("/home")).status, 200, "the page is still there under its slug");

  // A root page whose file is gone from the manifest: the domain root falls
  // back to the landing page rather than 404ing the whole site.
  const now = JSON.parse((await call("/api/manifest", { token: OWNER })).text);
  const dangling = { ...now.public, home: { ...now.public.home, root: true, file: "f-gone" } };
  assert.equal((await putManifest({ ...now, seq: now.seq + 1, public: dangling })).status, 200);
  assert.ok((await pub("/")).text.includes("Download Doklin"), "the landing page");
  assert.equal((await pub("/home")).status, 404, "the page itself is a 404 until the file is back");
});

/* ---------- Agents ---------- */

// An agent has no copy of the folder, so everything below is the worker
// itself reading and changing the workspace. "A Mac" in these tests is what a
// Mac is to the worker: blobs PUT under /api/blobs, then the manifest
// compare-and-swapped — the owner's token doing what the engine does.

const HOUR = 60 * 60 * 1000;
const ORIGIN = "https://notes.example.com";
/** A login code the way the app shows one: `dkla-` and four groups of five. */
const agentCode = (body) => `dkla-${body.slice(0, 5)}-${body.slice(5, 10)}-${body.slice(10, 15)}-${body.slice(15)}`;
let codeCount = 0;
/** Twenty Crockford characters no other code in this file has. */
const nextCodeBody = () => `AGENTC0DE${String((codeCount += 1)).padStart(11, "0")}`;
const loginWith = (typed, host) =>
  call("/api/agent/login", { method: "POST", device: null, body: { code: typed, ...(host ? { host } : {}) } });
const newCode = (agentId, body, expiresAt = Date.now() + HOUR) =>
  call(`/api/auth/agents/${agentId}/code`, { method: "POST", token: OWNER, body: { codeHash: sha256(body), expiresAt } });

/** Add an agent and log one machine in — the only way a `dka_` token exists. */
async function addAgent(name, scopes) {
  const body = nextCodeBody();
  const made = await call("/api/auth/agents", {
    method: "POST",
    token: OWNER,
    body: { name, scopes, codeHash: sha256(body), expiresAt: Date.now() + HOUR },
  });
  assert.equal(made.status, 201, made.text);
  const login = await loginWith(agentCode(body), "test-runner");
  assert.equal(login.status, 201, login.text);
  return { id: made.json.agent.id, name, token: login.json.token, scopes: login.json.scopes };
}
/** One request the way an agent's machine makes it: its token, and no device. */
const as = (agent) => (path, opts = {}) => call(path, { token: agent.token, device: null, ...opts });

/* What the bucket holds, read directly — never the worker's own answer. */
const storedManifest = () => JSON.parse(fake.store.get("manifest.json").bytes.toString("utf8"));
const etagNow = () => fake.store.get("manifest.json").etag;
/** `[fid, entry]` of the file at a path, or undefined. */
const entryAt = (m, p) => Object.entries(m.files).find(([, f]) => f.path === p);
const pathsOf = (m) => Object.values(m.files).map((f) => f.path).sort();
/** A file's text as the bucket holds it now, or undefined when the manifest has no such file. */
const textAt = (p) => {
  const hit = entryAt(storedManifest(), p);
  return hit ? fake.store.get(`blobs/${hit[0]}/${hit[1].hash}`)?.bytes.toString("utf8") : undefined;
};
const blobKeys = () => [...fake.store.keys()].filter((k) => k.startsWith("blobs/"));
/** Every blob the manifest names. */
const liveBlobKeys = (m) => new Set(Object.entries(m.files).map(([fid, f]) => `blobs/${fid}/${f.hash}`));

let macFiles = 0;
/**
 * A Mac's write: its blobs go up first, then the manifest is compare-and-
 * swapped over what is there. `change` edits the current manifest, with
 * `put(path, content, extra)` to add a file or give one new content.
 */
async function macWrite(change) {
  const m = JSON.parse((await call("/api/manifest", { token: OWNER })).text);
  const uploads = [];
  const put = (p, content, extra = {}) => {
    const bytes = Buffer.from(content);
    const hit = entryAt(m, p);
    const fid = hit?.[0] ?? `f-mac${String((macFiles += 1)).padStart(6, "0")}`;
    const hash = blobHash(bytes);
    m.files[fid] = { path: p, rev: (hit?.[1].rev ?? 0) + 1, hash, size: bytes.length, mtime: Date.now(), by: ALICE.id, ...extra };
    uploads.push({ fid, hash, bytes });
    return fid;
  };
  await change(m, put);
  for (const u of uploads) {
    const stored = await call(`/api/blobs/${u.fid}/${u.hash}`, { method: "PUT", token: OWNER, body: u.bytes });
    assert.equal(stored.status, 200, stored.text);
  }
  m.seq += 1;
  const res = await putManifest(m);
  assert.equal(res.status, 200, res.text);
  return res.json.etag;
}
/** Start from a workspace holding exactly these files — `{path: content}`. */
const freshWorkspace = (files, extra = {}) =>
  macWrite((m, put) => {
    m.files = {};
    m.tombstones = {};
    m.public = {};
    for (const [p, content] of Object.entries(files)) put(p, content, extra[p] ?? {});
  });
/** The sidecar as the app writes one: a header, then a record a line. */
const sidecar = (...records) => [`{"doklin":"meta","v":1}`, ...records.map((r) => JSON.stringify(r))].join("\n") + "\n";
const recordsOf = (text) =>
  (text ?? "")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))
    .filter((r) => r.doklin === undefined);

await test("agents: the owner adds one with its first code; the code is redeemed once, by its hash, for a dka_ token; unknown, used and expired are one answer", async () => {
  const body = nextCodeBody();
  const before = Date.now();
  const made = await call("/api/auth/agents", {
    method: "POST",
    token: OWNER,
    body: { name: "  Grok bot  ", scopes: ["edit"], codeHash: sha256(body), expiresAt: Date.now() + HOUR },
  });
  assert.equal(made.status, 201);
  const agent = made.json.agent;
  assert.ok(/^a-[a-f0-9]{8}$/.test(agent.id));
  assert.equal(agent.name, "Grok bot", "the name is trimmed");
  assert.deepEqual(agent.scopes, ["read", "edit"], "read is always held, and the order is canonical");
  assert.equal(agent.lastUsedAt, null);
  assert.deepEqual(agent.machines, []);
  assert.ok(/^c-[a-f0-9]{8}$/.test(agent.code.id) && agent.code.expiresAt > before);
  assert.equal(
    db.value("SELECT COUNT(*) FROM agent_codes WHERE hash = ? AND agent_id = ?", sha256(body), agent.id),
    1,
    "the row is keyed by the hash of the code — the plaintext never reaches the worker at this end",
  );
  assert.ok(!made.text.includes(sha256(body)), "and the hash is not said back");

  // What a request to add one must carry.
  const add = (over) =>
    call("/api/auth/agents", {
      method: "POST",
      token: OWNER,
      body: { name: "X", scopes: [], codeHash: sha256("x"), expiresAt: Date.now() + HOUR, ...over },
    });
  assert.equal((await add({ name: "   " })).status, 400, "a name");
  assert.equal((await add({ scopes: "edit" })).status, 400, "scopes as a list");
  assert.equal((await add({ scopes: ["edit", "admin"] })).status, 400, "…of permissions that exist");
  assert.equal((await add({ codeHash: "K7QM29XVR48TBHN3WGYD" })).status, 400, "a hash, not a code");
  assert.equal((await add({ expiresAt: Date.now() - 1 })).status, 400, "a code that has not run out already");
  assert.equal((await add({ expiresAt: Date.now() + 25 * HOUR })).status, 400, "…and runs out within a day");
  assert.equal((await add({ expiresAt: "soon" })).status, 400);
  assert.equal((await call("/api/auth/agents", { method: "POST", token: OWNER, body: "not json" })).status, 400);
  assert.equal((await call("/api/auth/agents", { method: "PUT", token: OWNER, body: {} })).status, 405);
  const readOnly = await add({ name: "Reader", scopes: [] });
  assert.deepEqual(readOnly.json.agent.scopes, ["read"], "an agent with nothing ticked can still read");

  const pending = (await call("/api/auth/agents", { token: OWNER })).json.agents.find((a) => a.id === agent.id);
  assert.deepEqual(pending.machines, [], "nobody has logged in");
  assert.equal(pending.code.id, agent.code.id, "the code is listed as pending — by its id, never itself");

  // No bearer — this is the request that produces one.
  const here = (await call("/api/workspace", { token: OWNER })).json;
  const login = await loginWith(agentCode(body), "ci-runner-7");
  assert.equal(login.status, 201);
  assert.ok(/^dka_[a-f0-9]{64}$/.test(login.json.token), "256 bits behind a prefix that says what it is");
  assert.deepEqual(login.json.agent, { id: agent.id, name: "Grok bot" });
  assert.deepEqual(login.json.scopes, ["read", "edit"]);
  assert.deepEqual(login.json.workspace, { id: here.id, name: here.name });
  assert.equal(login.json.version, workerVersion);
  for (const feature of ["agents", "agent-docs", "agent-pages", "agent-comments", "agent-search", "agent-boards"]) {
    assert.ok(login.json.features.includes(feature), `the login says the worker has ${feature}`);
  }
  const token = login.json.token;
  assert.equal(db.value("SELECT hash FROM agent_tokens WHERE agent_id = ?", agent.id), sha256(token), "only the hash is kept");
  assert.equal(db.value("SELECT COUNT(*) FROM agent_codes WHERE agent_id = ?", agent.id), 0, "redeeming spends the code");

  // One-time, and it says the same thing as a code that never existed.
  const twice = await loginWith(agentCode(body));
  assert.equal(twice.status, 401);
  const never = await loginWith(agentCode("0000000000000000000Z"));
  assert.equal(never.status, 401);
  assert.deepEqual(never.json, twice.json, "a caller learns whether a code works, never whether it existed");
  for (const bad of ["dkla-123", "", 42, null, ALICE_CODE]) {
    assert.equal((await loginWith(bad)).status, 400, `${JSON.stringify(bad)} is not a login code — an invite's prefix included`);
  }
  assert.equal((await call("/api/agent/login", { method: "POST", device: null, body: "not json" })).status, 400);
  assert.equal(
    (await call("/api/auth/join", { method: "POST", body: { code: agentCode(nextCodeBody()), deviceId: DEVICE } })).status,
    400,
    "and a login code is not an invite",
  );

  // Agents are the database's, and only theirs: without one the routes say
  // so, an agent's token is nobody's — and the owner's sync API is untouched.
  for (const bindings of [{ OWNER_TOKEN: OWNER, DATA: fake }, { OWNER_TOKEN: OWNER, DATA: fake, DB: brokenD1() }]) {
    assert.equal((await call("/api/agent/login", { method: "POST", device: null, body: { code: agentCode(nextCodeBody()) }, bindings })).status, 503);
    assert.equal((await call("/api/auth/agents", { token: OWNER, bindings })).status, 503);
    assert.equal((await call("/api/auth/agents", { method: "POST", token: OWNER, bindings, body: { name: "X", scopes: [], codeHash: sha256("x"), expiresAt: Date.now() + HOUR } })).status, 503);
    assert.equal((await call(`/api/auth/agents/${agent.id}`, { method: "DELETE", token: OWNER, bindings })).status, 503);
    assert.equal((await call("/api/agent/me", { token, device: null, bindings })).status, 401);
    assert.equal((await call("/api/manifest", { token: OWNER, bindings })).status, 200, "sync does not need the database");
  }
  assert.equal((await call("/api/agent/me", { token, device: null })).status, 200, "and with it back, nothing was lost");

  // Expired: the same 401, and the row goes with the attempt.
  const lateBody = nextCodeBody();
  const reissued = await newCode(agent.id, lateBody);
  assert.equal(reissued.status, 201);
  assert.ok(/^c-[a-f0-9]{8}$/.test(reissued.json.code.id));
  db.run("UPDATE agent_codes SET expires_at = ? WHERE agent_id = ?", Date.now() - 1, agent.id);
  const lapsed = (await call("/api/auth/agents", { token: OWNER })).json.agents.find((a) => a.id === agent.id);
  assert.equal(lapsed.code, null, "a code that ran out is not pending");
  const late = await loginWith(agentCode(lateBody));
  assert.equal(late.status, 401);
  assert.deepEqual(late.json, never.json, "expired says what unknown says");
  assert.equal(db.value("SELECT COUNT(*) FROM agent_codes WHERE agent_id = ?", agent.id), 0, "found expired, it is swept");

  // A new code replaces a pending one — the old line stops working.
  const first = nextCodeBody();
  const second = nextCodeBody();
  assert.equal((await newCode(agent.id, first)).status, 201);
  assert.equal((await newCode(agent.id, second)).status, 201);
  assert.equal(db.value("SELECT COUNT(*) FROM agent_codes WHERE agent_id = ?", agent.id), 1, "one pending code an agent");
  assert.equal((await loginWith(agentCode(first))).status, 401, "the replaced code is dead");
  assert.equal((await newCode(agent.id, nextCodeBody(), Date.now() - 1)).status, 400);
  assert.equal((await newCode(agent.id, nextCodeBody(), Date.now() + 25 * HOUR)).status, 400);
  assert.equal((await newCode("a-00000000", nextCodeBody())).status, 404, "no such agent");
  assert.equal((await newCode("m-00000000", nextCodeBody())).status, 400, "not an agent's id");
  // However it was typed: case, spacing and the dashes are presentation.
  const typed = ` ${agentCode(second).toLowerCase().replace(/-/g, "  ")} `;
  const other = await loginWith(typed);
  assert.equal(other.status, 201, "a second machine, with its own token");
  assert.notEqual(other.json.token, token);

  const listed = await call("/api/auth/agents", { token: OWNER });
  const two = listed.json.agents.find((a) => a.id === agent.id);
  assert.deepEqual(two.machines.map((m) => m.host).sort(), ["A machine", "ci-runner-7"], "each machine by what it calls itself");
  assert.ok(two.machines.every((m) => /^t-[a-f0-9]{8}$/.test(m.id) && m.createdAt >= before));
  assert.equal(two.code, null);
  assert.ok(!listed.text.includes("dka_") && !listed.text.includes(sha256(token)), "the list never carries a credential or its hash");

  // The token authenticates, and says what it is for.
  const me = await call("/api/agent/me", { token, device: null });
  assert.equal(me.status, 200);
  assert.deepEqual(me.json, {
    agent: { id: agent.id, name: "Grok bot" },
    scopes: ["read", "edit"],
    workspace: { id: here.id, name: here.name },
    version: workerVersion,
    features: login.json.features,
  });

  // "Last used" is a date in a list: the first request writes it, and then
  // nothing does for an hour — a request is one row read and no write.
  const used = db.value("SELECT last_used_at FROM agents WHERE id = ?", agent.id);
  assert.ok(used >= before, "the first request said the agent was here");
  db.queries.length = 0;
  assert.equal((await call("/api/agent/me", { token, device: null })).status, 200);
  assert.ok(
    db.queries.length === 1 && /^\s*SELECT/i.test(db.queries[0]),
    `a request within the hour is one read: ${db.queries.join(" | ")}`,
  );
  db.run("UPDATE agents SET last_used_at = ? WHERE id = ?", Date.now() - 2 * HOUR, agent.id);
  await call("/api/agent/me", { token, device: null });
  assert.ok(db.value("SELECT last_used_at FROM agents WHERE id = ?", agent.id) > Date.now() - HOUR, "an hour on, the next request moves it");
  const seen = (await call("/api/auth/agents", { token: OWNER })).json.agents.find((a) => a.id === agent.id);
  assert.ok(seen.lastUsedAt > Date.now() - HOUR, "which is what the People view shows");
});

await test("agents: a rename and new permissions apply on the next request; a machine is revoked on its own; a logout revokes itself; removing the agent takes everything", async () => {
  const bot = await addAgent("Two machines", ["comment", "edit"]);
  const secondBody = nextCodeBody();
  await newCode(bot.id, secondBody);
  const second = (await loginWith(agentCode(secondBody), "laptop")).json.token;
  const machines = (await call("/api/auth/agents", { token: OWNER })).json.agents.find((a) => a.id === bot.id).machines;
  const laptop = machines.find((m) => m.host === "laptop");
  const runner = machines.find((m) => m.host === "test-runner");
  const me = (token) => call("/api/agent/me", { token, device: null });
  const change = (id, body) => call(`/api/auth/agents/${id}`, { method: "POST", token: OWNER, body });

  // Permissions are read off the row every time: there is no session to outlive them.
  const changed = await change(bot.id, { name: "  Reviewer ", scopes: ["comment"] });
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.json, { updated: true });
  const now = (await me(bot.token)).json;
  assert.deepEqual(now.agent, { id: bot.id, name: "Reviewer" }, "the same agent under its new name");
  assert.deepEqual(now.scopes, ["read", "comment"]);
  const refused = await call("/api/agent/doc?path=Somewhere/new&dry=1", { method: "PUT", token: bot.token, device: null, body: "# New\n" });
  assert.equal(refused.status, 403, "edit was unticked, so the very next write is refused");
  assert.equal((await change(bot.id, { name: "Reviewer two" })).status, 200, "a name alone");
  assert.deepEqual((await me(bot.token)).json.scopes, ["read", "comment"], "…leaves the permissions as they were");
  assert.equal((await change(bot.id, { scopes: ["publish", "edit"] })).status, 200, "permissions alone");
  const again = (await me(second)).json;
  assert.equal(again.agent.name, "Reviewer two");
  assert.deepEqual(again.scopes, ["read", "edit", "publish"], "every machine of the agent, at once");
  assert.equal((await change(bot.id, { scopes: ["admin"] })).status, 400);
  assert.equal((await change(bot.id, { name: "  " })).status, 400);
  assert.equal((await change(bot.id, "not json")).status, 400);
  assert.equal((await change("a-00000000", { name: "Nobody" })).status, 404);
  assert.equal((await change("not-an-id", { name: "Nobody" })).status, 400);
  assert.equal((await call(`/api/auth/agents/${bot.id}`, { token: OWNER })).status, 405);
  assert.equal((await call(`/api/auth/agents/${bot.id}/code`, { token: OWNER })).status, 405);
  assert.equal((await call(`/api/auth/agents/${bot.id}/nope`, { token: OWNER })).status, 404);

  // One machine, by the id the list gave it.
  const other = await addAgent("Somebody else", []);
  const revoke = (agentId, tokenId) => call(`/api/auth/agents/${agentId}/tokens/${tokenId}`, { method: "DELETE", token: OWNER });
  assert.equal((await revoke(other.id, laptop.id)).status, 404, "a machine is revoked under its own agent");
  assert.equal((await revoke(bot.id, "t-nothex")).status, 400);
  assert.equal((await call(`/api/auth/agents/${bot.id}/tokens/${laptop.id}`, { token: OWNER })).status, 405);
  assert.equal((await me(second)).status, 200, "nothing has been revoked yet");
  assert.equal((await revoke(bot.id, laptop.id)).status, 204);
  assert.equal((await me(second)).status, 401, "the very next request from that machine");
  assert.equal((await me(bot.token)).status, 200, "the other machine carries on");
  assert.equal((await revoke(bot.id, laptop.id)).status, 404, "it is gone");

  // `doklin logout`: the token that made the request revokes itself.
  assert.equal((await call("/api/agent/login", { token: bot.token, device: null })).status, 405);
  const out = await call("/api/agent/login", { method: "DELETE", token: bot.token, device: null });
  assert.equal(out.status, 204);
  assert.equal((await me(bot.token)).status, 401);
  assert.equal(db.value("SELECT COUNT(*) FROM agent_tokens WHERE agent_id = ?", bot.id), 0);
  assert.equal(db.value("SELECT COUNT(*) FROM agent_tokens WHERE id = ?", runner.id), 0);
  const empty = (await call("/api/auth/agents", { token: OWNER })).json.agents.find((a) => a.id === bot.id);
  assert.deepEqual(empty.machines, [], "the agent is still there, logged in nowhere");

  // Removing the agent: its machines, and a code somebody still holds.
  const thirdBody = nextCodeBody();
  await newCode(bot.id, thirdBody);
  const third = (await loginWith(agentCode(thirdBody))).json.token;
  const unusedBody = nextCodeBody();
  await newCode(bot.id, unusedBody);
  assert.equal((await me(third)).status, 200);
  const removed = await call(`/api/auth/agents/${bot.id}`, { method: "DELETE", token: OWNER });
  assert.equal(removed.status, 204);
  assert.equal((await me(third)).status, 401, "it stops working the moment it is removed");
  assert.equal((await loginWith(agentCode(unusedBody))).status, 401, "and the line somebody was still holding is worth nothing");
  for (const table of ["agents WHERE id", "agent_tokens WHERE agent_id", "agent_codes WHERE agent_id"]) {
    assert.equal(db.value(`SELECT COUNT(*) FROM ${table} = ?`, bot.id), 0, `nothing left in ${table.split(" ")[0]}`);
  }
  assert.ok(!(await call("/api/auth/agents", { token: OWNER })).json.agents.some((a) => a.id === bot.id));
  assert.equal((await call(`/api/auth/agents/${bot.id}`, { method: "DELETE", token: OWNER })).status, 404);
  assert.equal((await me(other.token)).status, 200, "another agent is not touched");

  // Agents are the owner's to manage, like people.
  const body = { name: "Mine", scopes: ["edit"], codeHash: sha256("x"), expiresAt: Date.now() + HOUR };
  for (const [method, path, sent] of [
    ["GET", "/api/auth/agents"],
    ["POST", "/api/auth/agents", body],
    ["POST", `/api/auth/agents/${other.id}`, { scopes: ["publish"] }],
    ["POST", `/api/auth/agents/${other.id}/code`, { codeHash: sha256("x"), expiresAt: Date.now() + HOUR }],
    ["DELETE", `/api/auth/agents/${other.id}`],
    ["DELETE", `/api/auth/agents/${other.id}/tokens/t-00000000`],
  ]) {
    const member = await call(path, { method, token: MEMBER, body: sent });
    assert.equal(member.status, 403, `${method} ${path} is the owner's`);
    assert.deepEqual(member.json, { error: "only an owner can do that" });
    assert.equal((await call(path, { method, token: other.token, device: null, body: sent })).status, 403, "and never an agent's own");
    assert.equal((await call(path, { method, body: sent })).status, 401, "auth comes first");
  }
  assert.deepEqual((await me(other.token)).json.scopes, ["read"], "none of that changed anything");
});

await test("agents: the gate — an agent's token is answered on /api/agent and nowhere else, and a person's credential nowhere on it", async () => {
  await freshWorkspace({ "Gate/note.md": "# Note\n\nWhat the workspace held.\n" });
  // Everything ticked: no permission reaches the sync API.
  const bot = await addAgent("Trusted bot", ["comment", "edit", "publish"]);
  const etag = etagNow();
  const objects = fake.store.size;
  const people = db.value("SELECT COUNT(*) FROM members") + db.value("SELECT COUNT(*) FROM agents");
  const hash = "a".repeat(16);
  const sync = [
    ["GET", "/api/meta"],
    ["GET", "/api/workspace"],
    ["POST", "/api/workspace", { name: "Mine now" }],
    ["GET", "/api/poll"],
    ["POST", "/api/poll", { name: "Bot" }],
    ["GET", "/api/manifest"],
    ["PUT", "/api/manifest", manifest(999, {}), { "x-base-etag": etag }],
    ["GET", "/api/blobs/f-doc1"],
    ["GET", `/api/blobs/f-doc1/${hash}`],
    ["PUT", `/api/blobs/f-doc1/${hash}`, "bytes"],
    ["DELETE", `/api/blobs/f-doc1/${hash}`],
    ["GET", "/api/versions/index"],
    ["PUT", "/api/versions/index", {}, { "x-base-etag": "*" }],
    ["GET", "/api/versions/snapshots/1700000000000-d-macbook"],
    ["GET", "/api/versions/blobs"],
    ["GET", "/api/auth/members"],
    ["GET", "/api/auth/invites"],
    ["POST", "/api/auth/invites", { email: "bot@example.com", codeHash: sha256("x"), expiresAt: Date.now() + DAY }],
    ["GET", "/api/auth/tokens"],
    ["GET", "/api/auth/agents"],
    ["POST", "/api/auth/agents", { name: "Another", scopes: ["edit"], codeHash: sha256("y"), expiresAt: Date.now() + HOUR }],
    ["POST", "/api/admin/wipe", { confirm: "wipe" }],
    ["GET", "/api/nope"],
  ];
  for (const [method, path, body, headers] of sync) {
    const res = await as(bot)(path, { method, body, headers });
    assert.equal(res.status, 403, `${method} ${path} refuses an agent`);
    assert.ok(/document API only/.test(res.json.error), "and says where it belongs");
  }
  assert.equal(etagNow(), etag, "the manifest was not touched");
  assert.equal(fake.store.size, objects, "nothing was stored and nothing wiped");
  assert.equal(db.value("SELECT COUNT(*) FROM members") + db.value("SELECT COUNT(*) FROM agents"), people, "nobody was invited or added");

  // And the other way: a person's credential is not a limited account, so it
  // has no business on the routes whose whole point is the limit.
  const documentApi = [
    ["GET", "/api/agent/me"],
    ["DELETE", "/api/agent/login"],
    ["GET", "/api/agent/tree"],
    ["GET", "/api/agent/doc?path=Gate/note"],
    ["PUT", "/api/agent/doc?path=Gate/note&force=1", "# Replaced\n"],
    ["DELETE", "/api/agent/doc?path=Gate/note"],
    ["POST", "/api/agent/move", { from: "Gate/note", to: "Gate/moved" }],
    ["GET", "/api/agent/comments?path=Gate/note"],
    ["POST", "/api/agent/comments", { path: "Gate/note", on: "the workspace", body: "Hm." }],
    ["DELETE", "/api/agent/comments?path=Gate/note&thread=abc123"],
    ["GET", "/api/agent/search?q=workspace"],
    ["GET", "/api/agent/pages"],
    ["PUT", "/api/agent/pages", { path: "Gate/note" }],
    ["DELETE", "/api/agent/pages?slug=nothing-here"],
  ];
  for (const [method, path, body] of documentApi) {
    for (const [who, token] of [["the owner", OWNER], ["a member", MEMBER]]) {
      const res = await call(path, { method, token, body });
      assert.equal(res.status, 403, `${method} ${path} refuses ${who}`);
      assert.ok(/for agents/.test(res.json.error));
    }
    assert.equal((await call(path, { method, body })).status, 401, `${method} ${path} needs a bearer`);
  }
  assert.equal(etagNow(), etag, "none of that changed the workspace either");

  // The login is the whole carve-out: method and path, exactly.
  assert.equal((await call("/api/agent/login", { device: null })).status, 401);
  assert.equal((await call("/api/agent/loginx", { method: "POST", device: null, body: { code: "x" } })).status, 401);
  assert.equal((await call("/api/agent/login/x", { method: "POST", device: null, body: { code: "x" } })).status, 401);
  assert.equal(
    (await call("/api/agent/login", { method: "POST", token: OWNER, body: { code: "nope" } })).status,
    400,
    "it is answered above the gate — a bearer on it changes nothing",
  );

  // What is not a token is nobody.
  assert.equal((await call("/api/agent/me", { token: `dka_${"0".repeat(64)}`, device: null })).status, 401);
  assert.equal((await call("/api/agent/me", { token: bot.token.slice(4), device: null })).status, 401, "the prefix is part of it");
  assert.equal((await call("/api/meta", { token: bot.token.slice(4) })).status, 401);

  // Under /api/agent: one segment, a known route, a known verb.
  assert.equal((await as(bot)("/api/agent")).status, 404);
  assert.equal((await as(bot)("/api/agent/nope")).status, 404);
  assert.equal((await as(bot)("/api/agent/tree/deeper")).status, 404);
  assert.equal((await as(bot)("/api/agent/tree", { method: "PATCH" })).status, 405);
  assert.equal((await as(bot)("/api/agent/me", { method: "POST", body: {} })).status, 405);
  assert.equal((await as(bot)("/api/agent/search", { method: "POST", body: {} })).status, 405);
});

await test("agents: each permission — every route and verb is refused without its own, with what it needs, and answered with it", async () => {
  await freshWorkspace({ "Perm/note.md": "# Note\n\nSome plain words here.\n" });
  // [permission, verb, path, body, what it answers when allowed]. Every
  // change is a dry run or names nothing, so "allowed" leaves no mark.
  const routes = [
    ["read", "GET", "/api/agent/tree", undefined, 200],
    ["read", "GET", "/api/agent/doc?path=Perm/note", undefined, 200],
    ["read", "GET", "/api/agent/comments?path=Perm/note", undefined, 200],
    ["read", "GET", "/api/agent/search?q=plain", undefined, 200],
    ["read", "GET", "/api/agent/pages", undefined, 200],
    ["edit", "PUT", "/api/agent/doc?path=Perm/new&dry=1", "# New\n", 200],
    ["edit", "DELETE", "/api/agent/doc?path=Perm/note&dry=1", undefined, 200],
    ["edit", "POST", "/api/agent/move", { from: "Perm/note", to: "Perm/moved", dryRun: true }, 200],
    ["comment", "POST", "/api/agent/comments", { path: "Perm/note", on: "plain words", body: "Hm.", dryRun: true }, 200],
    ["comment", "DELETE", "/api/agent/comments?path=Perm/note&thread=nope00&dry=1", undefined, 404],
    ["publish", "PUT", "/api/agent/pages", { path: "Perm/note", dryRun: true }, 200],
    ["publish", "DELETE", "/api/agent/pages?slug=nothing-here&dry=1", undefined, 404],
  ];
  const agents = [
    await addAgent("Reader", []),
    await addAgent("Commenter", ["comment"]),
    await addAgent("Editor", ["edit"]),
    await addAgent("Publisher", ["publish"]),
    await addAgent("Everything", ["comment", "edit", "publish"]),
  ];
  assert.deepEqual(agents.map((a) => a.scopes.length), [1, 2, 2, 2, 4]);
  const etag = etagNow();
  for (const agent of agents) {
    for (const [scope, method, path, body, allowed] of routes) {
      const res = await as(agent)(path, { method, body });
      if (agent.scopes.includes(scope)) {
        assert.equal(res.status, allowed, `${agent.name} may ${method} ${path}: ${res.text.slice(0, 200)}`);
      } else {
        assert.equal(res.status, 403, `${agent.name} may not ${method} ${path}`);
        assert.equal(res.json.need, scope, "the refusal names the permission");
        assert.deepEqual(res.json.scopes, agent.scopes, "…and the ones it holds");
        assert.ok(/may not .* — the workspace's owner can allow it/.test(res.json.error), "in a sentence that says what to do next");
      }
    }
  }
  assert.equal(etagNow(), etag, "a refusal and a dry run both leave the workspace as it was");

  // The reviewer: it can say things about a text it cannot change.
  const reviewer = agents[1];
  const said = await as(reviewer)("/api/agent/comments", { method: "POST", body: { path: "Perm/note", on: "plain words", body: "Too plain." } });
  assert.equal(said.status, 201);
  assert.equal((await as(reviewer)("/api/agent/doc?path=Perm/note&force=1", { method: "PUT", body: "# Mine\n" })).status, 403);
  assert.ok(textAt("Perm/note.md").includes("{==plain words==}"), "the comment landed; the rewrite did not");
});

/* ---------- The document API: documents ---------- */

/** `GET /api/agent/doc` for a path and an optional version flag. */
const docUrl = (p, v = "", more = "") => `/api/agent/doc?path=${encodeURIComponent(p)}${v ? `&v=${v}` : ""}${more}`;
/** What a read says about what it read, out of its headers. */
const readHead = (res) => ({
  kind: res.headers.get("x-doklin-kind"),
  path: decodeURIComponent(res.headers.get("x-doklin-path") ?? ""),
  file: decodeURIComponent(res.headers.get("x-doklin-file") ?? ""),
  version: res.headers.get("x-doklin-version"),
  rev: Number(res.headers.get("x-doklin-rev")),
});

await test("documents: a write is a blob and one compare-and-swap — a fresh id at rev 1, rev + 1 after, signed with the agent's id; the same bytes and a dry run write nothing", async () => {
  await freshWorkspace({ "Notes/kept.md": "# Kept\n" });
  const bot = await addAgent("Writer", ["edit"]);
  const api = as(bot);
  const start = storedManifest();
  const before = Date.now();
  const text = "# Hello\n\nWritten by a bot — with ünïcode.\n";

  const made = await api(docUrl("Notes/hello"), { method: "PUT", body: text });
  assert.equal(made.status, 201);
  assert.deepEqual(made.json, {
    kind: "document",
    path: "Notes/hello",
    version: "md",
    file: "hello.md",
    rev: 1,
    size: Buffer.byteLength(text),
    created: true,
  });
  const one = storedManifest();
  assert.equal(one.seq, start.seq + 1, "one manifest write");
  const [fid, file] = entryAt(one, "Notes/hello.md");
  assert.ok(/^f-[a-f0-9]{12}$/.test(fid), "an id the way the engine mints one");
  assert.equal(file.rev, 1);
  assert.equal(file.hash, blobHash(text), "addressed by its content, as a Mac's upload is");
  assert.equal(file.size, Buffer.byteLength(text));
  assert.ok(file.mtime >= before && file.mtime <= Date.now());
  assert.equal(file.by, bot.id, "signed with the agent's id, the way a Mac signs with a member's");
  const blob = fake.store.get(`blobs/${fid}/${file.hash}`);
  assert.equal(blob.bytes.toString("utf8"), text);
  assert.equal(blob.httpMetadata.contentType, "text/markdown; charset=utf-8");
  const [keptFid, kept] = entryAt(start, "Notes/kept.md");
  assert.deepEqual(one.files[keptFid], kept, "nothing else moved");
  assert.equal((await call(`/api/blobs/${fid}/${file.hash}`, { token: MEMBER })).text, text, "a Mac downloads it like any other device's write");

  const back = await api(docUrl("Notes/hello"));
  assert.equal(back.status, 200);
  assert.equal(back.text, text);
  assert.deepEqual(readHead(back), { kind: "document", path: "Notes/hello", file: "Notes/hello.md", version: "md", rev: 1 });
  assert.equal(back.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(back.headers.get("cache-control"), "no-store");

  // Replacing it: the revision that was read, or nothing.
  const next = `${text}\nA second paragraph.\n`;
  const blind = await api(docUrl("Notes/hello"), { method: "PUT", body: next });
  assert.equal(blind.status, 409, "no silent overwrite");
  assert.equal(blind.json.code, "needs_rev");
  assert.equal(blind.json.rev, 1, "the refusal says which revision is there");
  const replaced = await api(docUrl("Notes/hello"), { method: "PUT", body: next, headers: { "if-rev": "1" } });
  assert.equal(replaced.status, 200);
  assert.deepEqual(replaced.json, { kind: "document", path: "Notes/hello", version: "md", file: "hello.md", rev: 2, size: Buffer.byteLength(next), created: false });
  const two = storedManifest();
  assert.equal(two.seq, start.seq + 2);
  assert.equal(two.files[fid].rev, 2, "the same file, one revision on");
  assert.equal(two.files[fid].hash, blobHash(next));
  assert.ok(fake.store.has(`blobs/${fid}/${file.hash}`), "the old revision is still in the bucket — collecting it is a Mac's job");
  const stale = await api(docUrl("Notes/hello"), { method: "PUT", body: "# Late\n", headers: { "if-rev": "1" } });
  assert.equal(stale.status, 409, "a write over a stale revision is refused");
  assert.equal(stale.json.rev, 2);
  assert.ok(/Read it again/.test(stale.json.error));
  assert.equal(textAt("Notes/hello.md"), next, "and nothing was lost");
  assert.equal((await api(docUrl("Notes/hello", "", "&force=1"), { method: "PUT", body: "x", headers: { "if-rev": "2" } })).status, 400, "a revision or a force, not both");
  assert.equal((await api(docUrl("Notes/hello"), { method: "PUT", body: "x", headers: { "if-rev": "two" } })).status, 400);
  const mustBeNew = await api(docUrl("Notes/hello"), { method: "PUT", body: "x", headers: { "if-rev": "*" } });
  assert.equal(mustBeNew.status, 409, "* means it must not exist yet");
  assert.equal(mustBeNew.json.rev, 2);
  const vanished = await api(docUrl("Notes/never-was"), { method: "PUT", body: "x", headers: { "if-rev": "3" } });
  assert.equal(vanished.status, 409, "a revision of something that is not there");
  assert.equal(vanished.json.rev, null);

  // The same bytes are not a new revision, and not a write.
  const etag = etagNow();
  const blobs = blobKeys().length;
  const same = await api(docUrl("Notes/hello", "", "&force=1"), { method: "PUT", body: next });
  assert.equal(same.status, 200);
  assert.equal(same.json.unchanged, true);
  assert.equal(same.json.written, false);
  assert.equal(same.json.rev, 2);
  assert.equal(etagNow(), etag, "no new etag, so no Mac wakes up for nothing");

  // A dry run is checked like the real thing, and then thrown away.
  const dry = await api(docUrl("Notes/hello", "", "&dry=1"), { method: "PUT", body: "# Other\n", headers: { "if-rev": "2" } });
  assert.equal(dry.status, 200);
  assert.equal(dry.json.rev, 3, "what it would have become");
  assert.equal(dry.json.written, false);
  const dryNew = await api(docUrl("Notes/unborn", "", "&dry=1"), { method: "PUT", body: "# Unborn\n" });
  assert.equal(dryNew.status, 200, "not a 201: nothing was created");
  assert.deepEqual([dryNew.json.created, dryNew.json.written], [true, false]);
  assert.equal((await api(docUrl("Notes/hello", "", "&dry=1"), { method: "PUT", body: "x", headers: { "if-rev": "1" } })).status, 409, "a dry run still says no");
  assert.equal(etagNow(), etag);
  assert.equal(blobKeys().length, blobs, "not even a blob");
  assert.equal(entryAt(storedManifest(), "Notes/unborn.md"), undefined);

  // Removing leaves the tombstone a Mac honours, one revision on.
  const gone = await api(docUrl("Notes/hello"), { method: "DELETE" });
  assert.equal(gone.status, 200);
  assert.deepEqual(gone.json, { kind: "document", path: "Notes/hello", versions: ["md"], stillPublic: [] });
  const three = storedManifest();
  assert.equal(three.seq, start.seq + 3);
  assert.equal(three.files[fid], undefined);
  const tomb = three.tombstones[fid];
  assert.deepEqual({ path: tomb.path, rev: tomb.rev, by: tomb.by }, { path: "Notes/hello.md", rev: 3, by: bot.id });
  assert.ok(tomb.ts >= before && tomb.ts <= Date.now());
  assert.equal((await api(docUrl("Notes/hello"))).status, 404);
  // The same name again is a new file, not the old one back.
  const reborn = await api(docUrl("Notes/hello"), { method: "PUT", body: "# Again\n", headers: { "if-rev": "*" } });
  assert.equal(reborn.status, 201);
  assert.equal(reborn.json.rev, 1);
  const four = storedManifest();
  assert.notEqual(entryAt(four, "Notes/hello.md")[0], fid);
  assert.ok(four.tombstones[fid], "and the old one stays deleted");

  // A Mac writes on top of what the worker wrote, by the same check as ever —
  // and an old tombstone ages out with whoever writes next, as it does there.
  await macWrite((m, put) => {
    put("Notes/from-a-mac.md", "# From a Mac\n");
    m.tombstones["f-old000001"] = { path: "Old/a.md", rev: 4, ts: Date.now() - 31 * DAY, by: ALICE.id };
    m.tombstones["f-new000001"] = { path: "Old/b.md", rev: 2, ts: Date.now() - 29 * DAY, by: ALICE.id };
  });
  assert.equal((await api(docUrl("Notes/another"), { method: "PUT", body: "# Another\n" })).status, 201);
  const aged = storedManifest();
  assert.equal(aged.tombstones["f-old000001"], undefined, "past thirty days");
  assert.ok(aged.tombstones["f-new000001"] && aged.tombstones[fid], "younger ones stay");
  assert.ok(entryAt(aged, "Notes/from-a-mac.md"), "and the Mac's file is there beside the agent's");

  // A plain file: named in full, its bytes as they are, no versions.
  const pic = await api(docUrl("Notes/pixel.png"), { method: "PUT", body: PIXEL_PNG });
  assert.equal(pic.status, 201);
  assert.deepEqual(pic.json, { kind: "file", path: "Notes/pixel.png", rev: 1, size: PIXEL_PNG.length, created: true });
  const [picFid, picFile] = entryAt(storedManifest(), "Notes/pixel.png");
  assert.equal(fake.store.get(`blobs/${picFid}/${picFile.hash}`).httpMetadata.contentType, "image/png");
  const picBack = await api(docUrl("Notes/pixel.png"));
  assert.deepEqual(Buffer.from(picBack.bytes), PIXEL_PNG, "byte for byte");
  assert.equal(picBack.headers.get("content-type"), "image/png");
  assert.deepEqual(readHead(picBack), { kind: "file", path: "Notes/pixel.png", file: "Notes/pixel.png", version: null, rev: 1 });
  assert.equal((await api(docUrl("Notes/pixel.png"), { method: "PUT", body: "other" })).json.code, "needs_rev", "the same rule as a document");
  assert.equal((await api(docUrl("Notes/pixel.png"), { method: "PUT", body: "other", headers: { "if-rev": "1" } })).json.rev, 2);
  const flagged = await api(docUrl("Notes/pixel.png", "md"));
  assert.equal(flagged.status, 400);
  assert.ok(/plain file — it has no versions/.test(flagged.json.error));
  const picInfo = await api(docUrl("Notes/pixel.png", "", "&info=1"));
  assert.deepEqual({ ...picInfo.json, changed: 0 }, { kind: "file", path: "Notes/pixel.png", rev: 2, size: 5, changed: 0, by: bot.id, byName: "Writer" });
  const picGone = await api(docUrl("Notes/pixel.png"), { method: "DELETE" });
  assert.deepEqual(picGone.json, { kind: "file", path: "Notes/pixel.png", stillPublic: [] });
  assert.equal(storedManifest().tombstones[picFid].rev, 3);

  assert.equal((await api(docUrl("Notes/huge.bin"), { method: "PUT", body: new Uint8Array(25 * 1024 * 1024 + 1) })).status, 413);

  // No workspace, or one this worker cannot read: nothing is invented.
  const unbound = { OWNER_TOKEN: OWNER, DATA: new FakeR2(), DB: db };
  const everything = as(await addAgent("Everything", ["comment", "edit", "publish"]));
  for (const [method, path, body] of [
    ["GET", "/api/agent/tree"],
    ["GET", docUrl("Notes/hello")],
    ["PUT", docUrl("Notes/hello"), "# Hello\n"],
    ["DELETE", docUrl("Notes/hello")],
    ["POST", "/api/agent/move", { from: "a", to: "b" }],
    ["GET", "/api/agent/comments?path=Notes/hello"],
    ["POST", "/api/agent/comments", { path: "Notes/hello", on: "Hello", body: "Hm." }],
    ["DELETE", "/api/agent/comments?path=Notes/hello&thread=abc123"],
    ["GET", "/api/agent/pages"],
    ["PUT", "/api/agent/pages", { path: "Notes/hello" }],
    ["DELETE", "/api/agent/pages?path=Notes/hello"],
    ["GET", "/api/agent/search?q=hello"],
  ]) {
    const res = await everything(path, { method, body, bindings: unbound });
    assert.equal(res.status, 404, `${method} ${path} on a domain with no workspace`);
    assert.ok(/holds no workspace yet/.test(res.json.error));
  }
  assert.equal(unbound.DATA.store.size, 0);
  const garbled = { OWNER_TOKEN: OWNER, DATA: new FakeR2(), DB: db };
  await garbled.DATA.put("manifest.json", "{ not a manifest");
  const refused = await api(docUrl("Notes/hello"), { method: "PUT", body: "# Hello\n", bindings: garbled });
  assert.equal(refused.status, 409);
  assert.ok(/open it in Doklin first/.test(refused.json.error));
  assert.equal(garbled.DATA.store.size, 1, "and no blob was left beside it");
});

await test("documents: one name, two versions — reading resolves, a flag or an extension picks, and only a write to an html-only document refuses to guess", async () => {
  const then = Date.now() - 60_000;
  await freshWorkspace(
    {
      "VT/md-only.md": "# Markdown only\n",
      "VT/both.md": "# Both, in markdown\n",
      "VT/both.html": "<h1>Both, as a page</h1>\n",
      "VT/html-only.html": "<h1>A page and nothing else</h1>\n",
      "VT/alt.markdown": "# The long extension\n",
      "VT/twin.md": "# Twin one\n",
      "VT/twin.mkd": "# Twin two\n",
    },
    { "VT/both.md": { mtime: then }, "VT/both.html": { mtime: then } },
  );
  const bot = await addAgent("Versions", ["edit"]);
  const api = as(bot);
  const put = (p, v, body, headers = {}, more = "") => api(docUrl(p, v, more), { method: "PUT", body, headers });

  // Reading: [document, flag] → the version read, or why not.
  for (const [doc, flag, want] of [
    ["VT/md-only", "", "md"],
    ["VT/md-only", "md", "md"],
    ["VT/md-only", "html", "no_html"],
    ["VT/both", "", "md"],
    ["VT/both", "md", "md"],
    ["VT/both", "html", "html"],
    ["VT/html-only", "", "html"],
    ["VT/html-only", "md", "no_md"],
    ["VT/html-only", "html", "html"],
    ["VT/nothing", "", null],
    ["VT/nothing", "md", null],
    ["VT/nothing", "html", null],
  ]) {
    const res = await api(docUrl(doc, flag));
    const label = `${doc}${flag ? ` --${flag}` : ""}`;
    if (want === "md" || want === "html") {
      assert.equal(res.status, 200, label);
      const head = readHead(res);
      assert.equal(head.version, want, `${label} reads the ${want} version, and says so`);
      assert.equal(head.path, doc, "the document's name, whatever was read");
      assert.equal(head.file, `${doc}.${want}`);
      assert.equal(res.headers.get("content-type"), want === "md" ? "text/markdown; charset=utf-8" : "text/html; charset=utf-8");
      assert.equal(res.text, textAt(`${doc}.${want}`));
    } else {
      assert.equal(res.status, 404, label);
      assert.equal(res.json.code, want ?? undefined, `${label} → ${want ?? "nothing there"}`);
    }
  }
  assert.ok(/writing one with --html creates it/.test((await api(docUrl("VT/md-only", "html"))).json.error));
  assert.ok(/writing one with --md adds a markdown version/.test((await api(docUrl("VT/html-only", "md"))).json.error));

  // An extension picks a version too — and still names the same document.
  assert.equal(readHead(await api(docUrl("VT/both.html"))).version, "html");
  assert.equal(readHead(await api(docUrl("VT/both.md"))).version, "md");
  assert.equal(readHead(await api(docUrl("VT/both.html"))).path, "VT/both");
  assert.equal((await api(docUrl("VT/md-only.html"))).json.code, "no_html");
  assert.equal((await api(docUrl("VT/html-only.md"))).json.code, "no_md");
  assert.equal((await api(docUrl("VT/both.md", "html"))).status, 400, "a flag that contradicts the extension");
  assert.equal((await api(docUrl("VT/both.md", "md"))).status, 200, "one that agrees is fine");
  assert.equal((await api(docUrl("VT/both", "pdf"))).status, 400);

  // Markdown is any of its extensions; two with one stem have to be named in full.
  const alt = await api(docUrl("VT/alt"));
  assert.deepEqual(readHead(alt), { kind: "document", path: "VT/alt", file: "VT/alt.markdown", version: "md", rev: 1 });
  const twin = await api(docUrl("VT/twin"));
  assert.equal(twin.status, 409);
  assert.deepEqual(twin.json.candidates, ["VT/twin.md", "VT/twin.mkd"]);
  assert.equal((await api(docUrl("VT/twin.mkd"))).text, "# Twin two\n");
  assert.equal((await api(docUrl("VT/twin.md"))).text, "# Twin one\n");
  const listed = (await api("/api/agent/tree?dir=VT")).json.documents;
  assert.deepEqual(
    listed.map((d) => [d.path, d.md?.file ?? null, d.html?.file ?? null]),
    [
      ["VT/alt", "alt.markdown", null],
      ["VT/both", "both.md", "both.html"],
      ["VT/html-only", null, "html-only.html"],
      ["VT/md-only", "md-only.md", null],
      ["VT/twin.md", "twin.md", null],
      ["VT/twin.mkd", "twin.mkd", null],
    ],
    "a listing shows each document once, with the versions it has",
  );
  assert.ok(listed.every((d) => d.htmlBehind === undefined), "nothing is behind yet");

  // Writing with no flag. Markdown only: the markdown.
  const mdOnly = await put("VT/md-only", "", "# Markdown only, edited\n", { "if-rev": "1" });
  assert.deepEqual([mdOnly.status, mdOnly.json.version, mdOnly.json.file, mdOnly.json.rev], [200, "md", "md-only.md", 2]);

  // Both: the markdown — and the html now describes an older text.
  const both = await put("VT/both", "", "# Both, edited in markdown\n", { "if-rev": "1" });
  assert.deepEqual([both.status, both.json.version, both.json.rev], [200, "md", 2]);
  assert.equal(both.json.htmlBehind, true, "the answer to a markdown write says the html is behind");
  assert.equal(textAt("VT/both.html"), "<h1>Both, as a page</h1>\n", "the html was not touched");
  assert.equal((await api("/api/agent/tree?dir=VT")).json.documents.find((d) => d.path === "VT/both").htmlBehind, true, "so does a listing");
  assert.equal((await api(docUrl("VT/both"))).headers.get("x-doklin-html-behind"), "1", "and a read of either version");
  assert.equal((await api(docUrl("VT/both", "html"))).headers.get("x-doklin-html-behind"), "1");
  assert.equal((await api(docUrl("VT/both", "", "&info=1"))).json.htmlBehind, true);
  const html = await put("VT/both", "html", "<h1>Both, edited</h1>\n", { "if-rev": "1" });
  assert.deepEqual([html.status, html.json.version, html.json.file, html.json.rev], [200, "html", "both.html", 2]);
  assert.equal(html.json.htmlBehind, undefined, "writing the html again brings it level");
  assert.equal((await api(docUrl("VT/both"))).headers.get("x-doklin-html-behind"), null);
  assert.equal((await api("/api/agent/tree?dir=VT")).json.documents.find((d) => d.path === "VT/both").htmlBehind, undefined);

  // Html only: the one place a default would do harm.
  const etag = etagNow();
  for (const [headers, more] of [[{}, ""], [{ "if-rev": "1" }, ""], [{}, "&force=1"]]) {
    const guess = await put("VT/html-only", "", "# Markdown, by accident\n", headers, more);
    assert.equal(guess.status, 400, "markdown text never replaces an html page by default");
    assert.equal(guess.json.code, "html_only");
    assert.ok(/say --html to replace it, or --md to add a markdown version/.test(guess.json.error));
  }
  assert.equal(etagNow(), etag);
  assert.equal((await put("VT/html-only", "html", "<h1>Replaced</h1>\n")).json.code, "needs_rev");
  const page = await put("VT/html-only", "html", "<h1>Replaced</h1>\n", { "if-rev": "1" });
  assert.deepEqual([page.status, page.json.version, page.json.rev, page.json.created], [200, "html", 2, false]);
  const added = await put("VT/html-only", "md", "# The markdown it never had\n");
  assert.deepEqual([added.status, added.json.version, added.json.file, added.json.rev, added.json.created], [201, "md", "html-only.md", 1, true]);
  assert.equal(readHead(await api(docUrl("VT/html-only"))).version, "md", "it has both now, and reads as any document with both");
  assert.equal((await put("VT/html-only", "", "# Markdown, on purpose\n", { "if-rev": "1" })).status, 200, "and a plain write is the markdown again");

  // Nothing yet: markdown, unless html is said.
  const fresh = await put("VT/fresh", "", "# Fresh\n");
  assert.deepEqual([fresh.status, fresh.json.version, fresh.json.file, fresh.json.created], [201, "md", "fresh.md", true]);
  const pageOnly = await put("VT/page", "html", "<p>A page of its own</p>\n");
  assert.deepEqual([pageOnly.status, pageOnly.json.version, pageOnly.json.file, pageOnly.json.created], [201, "html", "page.html", true]);
  assert.equal(entryAt(storedManifest(), "VT/page.md"), undefined, "an html-only document, with no markdown invented beside it");
  const typed = await put("VT/typed.html", "", "<p>Typed in full</p>\n");
  assert.deepEqual([typed.status, typed.json.path, typed.json.version], [201, "VT/typed", "html"]);
  const long = await put("VT/long.markdown", "", "# Long\n");
  assert.deepEqual([long.status, long.json.path, long.json.file], [201, "VT/long", "long.markdown"], "a markdown extension typed in full is kept");
  assert.equal((await put("VT/binary", "", new Uint8Array([0xff, 0xfe, 0xfd]))).status, 400, "a version is text");

  // What is known about a document, without reading it.
  const info = (await api(docUrl("VT/both.html", "", "&info=1"))).json;
  assert.deepEqual([info.kind, info.path, info.comments], ["document", "VT/both", 0]);
  assert.deepEqual([info.md.file, info.md.rev, info.md.by, info.md.byName], ["both.md", 2, bot.id, "Versions"]);
  assert.deepEqual([info.html.file, info.html.rev, info.html.size], ["both.html", 2, 22]);
  assert.equal((await api(docUrl("VT/nothing", "", "&info=1"))).status, 404);
});

await test("documents: what a Mac would never see is refused; the sidecar never appears; one name is one file whatever its case", async () => {
  await freshWorkspace({
    "Case/Report.md": "# Report\n\nThe {==numbers==}{>>#abc123<<} are in.\n",
    "Case/Report.meta.jsonl": sidecar({ t: "mthread", id: "abc123", comments: [{ author: "Alice", at: 1757000000000, body: "Which numbers?" }] }),
    "Case/Data.csv": "a,b\n1,2\n",
    "Case/Sub/inner.md": "# Inner\n",
  });
  const bot = await addAgent("Careful", ["edit"]);
  const api = as(bot);
  const etag = etagNow();

  const refused = [
    ".secret/plan",
    "Notes/.draft",
    "node_modules/pkg/readme",
    "Out/target/notes",
    "dist/page",
    "x/build/y",
    "__pycache__/a",
    "Notes/a.doklin-sync-tmp",
    "Case/Report.meta.jsonl",
    "Case/REPORT.META.JSONL",
    "Anything/new.meta.jsonl",
    "../outside",
    "a/../b",
    "a//b",
    "/leading",
    "a/./b",
    "back\\slash",
    "",
    Array.from({ length: 13 }, (_, i) => `d${i}`).join("/"),
  ];
  for (const p of refused) {
    assert.equal((await api(docUrl(p))).status, 400, `reading ${JSON.stringify(p)}`);
    assert.equal((await api(docUrl(p, "", "&force=1"), { method: "PUT", body: "x" })).status, 400, `writing ${JSON.stringify(p)}`);
    assert.equal((await api(docUrl(p), { method: "DELETE" })).status, 400, `removing ${JSON.stringify(p)}`);
    // (A move reads a leading slash as the workspace's root, as publishing reads "/".)
    if (p !== "/leading") {
      assert.equal((await api("/api/agent/move", { method: "POST", body: { from: "Case/Sub/inner", to: p } })).status, 400, `moving onto ${JSON.stringify(p)}`);
    }
  }
  assert.equal(etagNow(), etag, "none of it reached the manifest");
  assert.ok(/does not sync names that begin with a dot/.test((await api(docUrl(".secret/plan"))).json.error));
  assert.ok(/a folder Doklin does not sync/.test((await api(docUrl("node_modules/pkg/readme"))).json.error));
  assert.ok(/comments commands/.test((await api(docUrl("Case/Report.meta.jsonl"))).json.error), "the sidecar's refusal says where comments are");

  // A listing is folders, documents and plain files — never a sidecar.
  const root = (await api("/api/agent/tree")).json;
  assert.deepEqual(root, { dir: "", folders: ["Case"], boards: [], documents: [], files: [] });
  const deep = (await api("/api/agent/tree?deep=1")).json;
  assert.deepEqual(deep.folders, ["Case", "Case/Sub"]);
  assert.deepEqual(deep.documents.map((d) => d.path), ["Case/Report", "Case/Sub/inner"]);
  assert.deepEqual(deep.files.map((f) => f.path), ["Case/Data.csv"]);
  assert.ok(!JSON.stringify(deep).includes("meta.jsonl"));
  const folder = (await api("/api/agent/tree?dir=/Case/")).json;
  assert.deepEqual([folder.dir, folder.folders, folder.documents.map((d) => d.path), folder.files.map((f) => f.path)], [
    "Case",
    ["Case/Sub"],
    ["Case/Report"],
    ["Case/Data.csv"],
  ]);
  assert.deepEqual((await api("/api/agent/tree?dir=case")).json.documents.map((d) => d.path), ["Case/Report"], "a folder is found whatever case it is typed in");
  assert.equal((await api("/api/agent/tree?dir=Nope")).status, 404);
  assert.equal((await api("/api/agent/tree?dir=.git")).status, 400);
  assert.equal((await api(docUrl("Case/Report", "", "&info=1"))).json.comments, 1, "its comments are counted, not shown");

  // The workspace lives on a case-insensitive disk: a name typed in another
  // case is the same document, never a second file beside it.
  const typed = await api(docUrl("case/REPORT"));
  assert.equal(typed.status, 200);
  assert.equal(readHead(typed).path, "Case/Report", "answered under the name the files carry");
  const over = await api(docUrl("case/report.MD", "", "&force=1"), { method: "PUT", body: "# Report, rewritten\n\nThe {==numbers==}{>>#abc123<<} are in.\n" });
  assert.deepEqual([over.status, over.json.path, over.json.rev, over.json.created], [200, "Case/Report", 2, false]);
  const csv = await api(docUrl("CASE/DATA.CSV", "", "&force=1"), { method: "PUT", body: "a,b\n3,4\n" });
  assert.deepEqual([csv.status, csv.json.path, csv.json.rev], [200, "Case/Data.csv", 2]);
  const page = await api(docUrl("case/report", "html"), { method: "PUT", body: "<h1>Report</h1>\n" });
  assert.equal(page.status, 201);
  assert.deepEqual(pathsOf(storedManifest()), ["Case/Data.csv", "Case/Report.html", "Case/Report.md", "Case/Report.meta.jsonl", "Case/Sub/inner.md"], "an html version is spelled as its markdown is");

  // A real collision is a 409.
  const onto = await api("/api/agent/move", { method: "POST", body: { from: "Case/Sub/inner", to: "Case/REPORT" } });
  assert.equal(onto.status, 409, "a document moved onto a name that differs only in case");
  const ontoFile = await api("/api/agent/move", { method: "POST", body: { from: "Case/Data.csv", to: "case/sub/INNER.md" } });
  assert.equal(ontoFile.status, 409, "and a plain file onto a file that is there");
  assert.ok(/"Case\/Sub\/inner.md" is already there/.test(ontoFile.json.error), "named as it is spelled");
  const inside = await api(docUrl("Case/Data.csv/inside"), { method: "PUT", body: "# Inside a file\n" });
  assert.equal(inside.status, 409, "a file is in the way of the folder");
  assert.ok(/is a file, so nothing can be put inside it/.test(inside.json.error));
  assert.deepEqual(pathsOf(storedManifest()), ["Case/Data.csv", "Case/Report.html", "Case/Report.md", "Case/Report.meta.jsonl", "Case/Sub/inner.md"]);
  // …but changing only the case of a name is a rename like any other.
  const recased = await api("/api/agent/move", { method: "POST", body: { from: "Case/Report", to: "Case/REPORT" } });
  assert.deepEqual([recased.status, recased.json.to, recased.json.files], [200, "Case/REPORT", 3]);
  assert.deepEqual(pathsOf(storedManifest()), ["Case/Data.csv", "Case/REPORT.html", "Case/REPORT.md", "Case/REPORT.meta.jsonl", "Case/Sub/inner.md"]);

  // A new name typed under a folder in another case goes into the folder as
  // it is spelled — where a Mac's disk would put it anyway, so that no Mac
  // has to rename it to agree. The name itself stays as typed, and so does
  // any folder that is new.
  const made = [];
  for (const [typed, v, body, landed] of [
    ["case/SUB/Fresh", "", "# Fresh\n", "Case/Sub/Fresh.md"],
    ["CASE/sub/Page", "html", "<p>Page</p>\n", "Case/Sub/Page.html"],
    ["CASE/Pixel.PNG", "", PIXEL_PNG, "Case/Pixel.PNG"],
    ["case/Brand New/sub/Note", "", "# Note\n", "Case/Brand New/sub/Note.md"],
    ["Elsewhere/As Typed", "", "# As typed\n", "Elsewhere/As Typed.md"],
  ]) {
    const res = await api(docUrl(typed, v), { method: "PUT", body });
    assert.equal(res.status, 201, typed);
    assert.ok(entryAt(storedManifest(), landed), `${typed} landed at ${landed}`);
    assert.equal(res.json.path, landed.replace(/\.(md|html)$/, ""), "and the answer says where");
    made.push(landed);
  }
  assert.deepEqual((await api("/api/agent/tree?deep=1")).json.folders, ["Case", "Case/Brand New", "Case/Brand New/sub", "Case/Sub", "Elsewhere"], "one folder, one spelling");
  const intoTyped = await api("/api/agent/move", { method: "POST", body: { from: "Elsewhere/As Typed", to: "CASE/sub/" } });
  assert.deepEqual(intoTyped.json, { kind: "document", from: "Elsewhere/As Typed", to: "Case/Sub/As Typed", files: 1 });
  const renamedTyped = await api("/api/agent/move", { method: "POST", body: { from: "case/pixel.png", to: "case/SUB/Dot.png" } });
  assert.deepEqual(renamedTyped.json, { kind: "file", from: "Case/Pixel.PNG", to: "Case/Sub/Dot.png", files: 1 });
  const folderTyped = await api("/api/agent/move", { method: "POST", body: { from: "case/brand new/", to: "CASE/SUB/" } });
  assert.deepEqual(folderTyped.json, { kind: "folder", from: "Case/Brand New", to: "Case/Sub/Brand New", files: 1 });
  // A folder's own name can still change case: nothing else is in it to say otherwise.
  const recasedFolder = await api("/api/agent/move", { method: "POST", body: { from: "Case/Sub/Brand New", to: "Case/Sub/BRAND NEW" } });
  assert.deepEqual(recasedFolder.json, { kind: "folder", from: "Case/Sub/Brand New", to: "Case/Sub/BRAND NEW", files: 1 });
  assert.deepEqual(
    pathsOf(storedManifest()).filter((p) => p.startsWith("Case/Sub/")),
    ["Case/Sub/As Typed.md", "Case/Sub/BRAND NEW/sub/Note.md", "Case/Sub/Dot.png", "Case/Sub/Fresh.md", "Case/Sub/Page.html", "Case/Sub/inner.md"],
  );
  assert.ok(pathsOf(storedManifest()).every((p) => p.startsWith("Case/")), "everything under the one spelling of the folder");
});

await test("documents: a document moves and is removed whole — both versions and its comments in one manifest write; one version can go, never the last", async () => {
  const mthread = (id, body) => ({ t: "mthread", id, comments: [{ author: "Alice", at: 1757000000000, body }] });
  const hthread = (id, body) => ({ t: "hthread", id, anchor: { path: "0", tag: "h1", text: "The plan" }, comments: [{ author: "Alice", at: 1757000001000, body }] });
  await freshWorkspace({
    "Pairs/plan.md": "# The plan\n\nThe boat {==ships in June==}{>>#abc123<<} if the paint dries.\n",
    "Pairs/plan.html": "<h1>The plan</h1>\n<p>The boat ships in June.</p>\n",
    "Pairs/plan.meta.jsonl": sidecar(hthread("def456", "Nice page."), mthread("abc123", "Is June still right?")),
    "Pairs/draft.md": "# Draft\n\nA {==first==}{>>#aaa111<<} draft.\n",
    "Pairs/draft.html": "<h1>The plan</h1>\n",
    "Pairs/draft.meta.jsonl": sidecar(hthread("bbb222", "On the page."), mthread("aaa111", "On the text.")),
    "Pairs/chart.png": PIXEL_PNG,
    "Pairs/Deep/note.md": "# Deep\n",
    "Other/taken.md": "# Taken\n",
  });
  const bot = await addAgent("Mover", ["edit"]);
  const api = as(bot);
  const move = (from, to, extra = {}) => api("/api/agent/move", { method: "POST", body: { from, to, ...extra } });
  const start = storedManifest();
  const parts = ["Pairs/plan.md", "Pairs/plan.html", "Pairs/plan.meta.jsonl"].map((p) => entryAt(start, p));

  // Whatever extension was typed, the document moves.
  const moved = await move("Pairs/plan.html", "Archive/plan-2026");
  assert.equal(moved.status, 200);
  assert.deepEqual(moved.json, { kind: "document", from: "Pairs/plan", to: "Archive/plan-2026", files: 3 });
  const one = storedManifest();
  assert.equal(one.seq, start.seq + 1, "three files, one manifest write");
  for (const [[fid, was], suffix] of parts.map((part, i) => [part, [".md", ".html", ".meta.jsonl"][i]])) {
    const now = one.files[fid];
    assert.equal(now.path, `Archive/plan-2026${suffix}`, "the same file, by its id, at its new path");
    assert.equal(now.rev, was.rev + 1, "a move is a revision");
    assert.deepEqual([now.hash, now.size, now.mtime], [was.hash, was.size, was.mtime], "…of the same bytes — a Mac renames in place, and the content's date stands");
    assert.equal(now.by, bot.id);
  }
  assert.deepEqual(one.tombstones, start.tombstones, "nothing was deleted to do it");
  assert.equal((await api(docUrl("Pairs/plan"))).status, 404);
  assert.equal((await api(docUrl("Archive/plan-2026", "", "&info=1"))).json.comments, 2, "its comments came with it");

  // A destination that is a folder, or says it is one, means "into it".
  const into = await move("Archive/plan-2026.md", "Pairs");
  assert.deepEqual(into.json, { kind: "document", from: "Archive/plan-2026", to: "Pairs/plan-2026", files: 3 });
  const intoNew = await move("Pairs/plan-2026", "New place/");
  assert.deepEqual(intoNew.json, { kind: "document", from: "Pairs/plan-2026", to: "New place/plan-2026", files: 3 });
  // And one typed with an extension names the document, not a file.
  const named = await move("New place/plan-2026", "Pairs/plan.md");
  assert.deepEqual(named.json, { kind: "document", from: "New place/plan-2026", to: "Pairs/plan", files: 3 });
  assert.deepEqual(
    pathsOf(storedManifest()).filter((p) => p.includes("plan")),
    ["Pairs/plan.html", "Pairs/plan.md", "Pairs/plan.meta.jsonl"],
  );

  const etag = etagNow();
  assert.equal((await move("Pairs/plan", "Other/taken")).status, 409, "the name is taken");
  assert.equal((await move("Pairs/draft", "Pairs/plan")).status, 409);
  assert.equal((await move("Pairs/nope", "Pairs/somewhere")).status, 404);
  assert.equal((await move("Pairs/plan", ".hidden/plan")).status, 400);
  assert.equal((await move("Pairs/plan", "")).status, 400);
  assert.equal((await api("/api/agent/move", { method: "POST", body: "not json" })).status, 400);
  const dry = await move("Pairs/plan", "Elsewhere/plan", { dryRun: true });
  assert.deepEqual(dry.json, { kind: "document", from: "Pairs/plan", to: "Elsewhere/plan", files: 3, moved: false });
  assert.equal(etagNow(), etag, "a refusal and a dry run move nothing");

  // A plain file, and a whole folder.
  const file = await move("Pairs/chart.png", "Pairs/Deep/");
  assert.deepEqual(file.json, { kind: "file", from: "Pairs/chart.png", to: "Pairs/Deep/chart.png", files: 1 });
  const beforeFolder = storedManifest();
  const folder = await move("Pairs/", "Fleet");
  assert.deepEqual(folder.json, { kind: "folder", from: "Pairs", to: "Fleet", files: 8 });
  const afterFolder = storedManifest();
  assert.equal(afterFolder.seq, beforeFolder.seq + 1, "a folder moves in one write too");
  assert.deepEqual(pathsOf(afterFolder), [
    "Fleet/Deep/chart.png",
    "Fleet/Deep/note.md",
    "Fleet/draft.html",
    "Fleet/draft.md",
    "Fleet/draft.meta.jsonl",
    "Fleet/plan.html",
    "Fleet/plan.md",
    "Fleet/plan.meta.jsonl",
    "Other/taken.md",
  ]);
  assert.equal((await move("Fleet", "Fleet/Inner/")).status, 400, "a folder cannot be moved inside itself");
  assert.deepEqual((await move("Fleet/Deep", "Other")).json, { kind: "folder", from: "Fleet/Deep", to: "Other/Deep", files: 2 }, "a folder named without its slash, into another");

  // Removing one version: the threads anchored in it go with it.
  const noHtml = await api(docUrl("Fleet/draft", "html"), { method: "DELETE" });
  assert.equal(noHtml.status, 200);
  assert.deepEqual(noHtml.json, { kind: "document", path: "Fleet/draft", versions: ["html"], threadsRemoved: 1 });
  const afterHtml = storedManifest();
  assert.equal(entryAt(afterHtml, "Fleet/draft.html"), undefined);
  assert.ok(Object.values(afterHtml.tombstones).some((t) => t.path === "Fleet/draft.html"));
  assert.deepEqual(recordsOf(textAt("Fleet/draft.meta.jsonl")).map((r) => [r.t, r.id]), [["mthread", "aaa111"]], "the markdown's thread stays");
  assert.ok(textAt("Fleet/draft.md").includes("{>>#aaa111<<}"));
  assert.equal((await api(docUrl("Fleet/draft", "html"), { method: "DELETE" })).status, 404, "it has no html version now");
  const last = await api(docUrl("Fleet/draft", "md"), { method: "DELETE" });
  assert.equal(last.status, 409, "the last version is not removed that way");
  assert.equal(last.json.code, "last_version");
  assert.ok(entryAt(storedManifest(), "Fleet/draft.md"));
  assert.equal((await api(docUrl("Fleet/draft.md", "html"), { method: "DELETE" })).status, 400);

  // Removing the markdown of a pair: its threads, and the sidecar when that empties it.
  assert.equal((await api(docUrl("Fleet/draft", "html"), { method: "PUT", body: "<h1>Draft</h1>\n" })).status, 201);
  const noMd = await api(docUrl("Fleet/draft", "md"), { method: "DELETE" });
  assert.deepEqual(noMd.json, { kind: "document", path: "Fleet/draft", versions: ["md"], threadsRemoved: 1 });
  assert.deepEqual(
    pathsOf(storedManifest()).filter((p) => p.startsWith("Fleet/draft")),
    ["Fleet/draft.html"],
    "an html-only document now, with no empty sidecar left beside it",
  );
  assert.equal(readHead(await api(docUrl("Fleet/draft"))).version, "html");

  // Removing the document: every file it is, in one write, each with its tombstone.
  const dryRm = await api(docUrl("Fleet/plan", "", "&dry=1"), { method: "DELETE" });
  assert.deepEqual(dryRm.json, { kind: "document", path: "Fleet/plan", versions: ["md", "html"], stillPublic: [], removed: false });
  const beforeRm = storedManifest();
  assert.ok(entryAt(beforeRm, "Fleet/plan.md"), "the dry run removed nothing");
  const rm = await api(docUrl("Fleet/plan.md"), { method: "DELETE" });
  assert.equal(rm.status, 200);
  assert.deepEqual(rm.json, { kind: "document", path: "Fleet/plan", versions: ["md", "html"], stillPublic: [] }, "plan.md with no flag means the document, as it does for a move");
  const afterRm = storedManifest();
  assert.equal(afterRm.seq, beforeRm.seq + 1);
  for (const [fid] of parts) {
    assert.equal(afterRm.files[fid], undefined);
    const tomb = afterRm.tombstones[fid];
    assert.deepEqual([tomb.path, tomb.rev, tomb.by], [beforeRm.files[fid].path, beforeRm.files[fid].rev + 1, bot.id]);
  }
  assert.equal((await api(docUrl("Fleet/plan"), { method: "DELETE" })).status, 404);
  assert.equal((await api("/api/agent/comments?path=Fleet/plan")).status, 404, "and its comments are gone with it");
});

await test("commit: a write that loses the race to another device lands on what that device wrote; a real conflict is still refused; no blob is left behind", async () => {
  await freshWorkspace({ "Race/doc.md": "# Doc\n\nAs it was.\n" });
  const bot = await addAgent("Racer", ["edit"]);
  const api = as(bot);
  const JSON_META = { httpMetadata: { contentType: "application/json" } };

  /**
   * Let another device land a manifest between the worker's read and its
   * put, `times` times: the worker's compare-and-swap then finds a new etag.
   * `theirs(manifest, n)` is what that device changed.
   */
  const racing = async (times, theirs, run) => {
    const realPut = fake.put.bind(fake);
    let raced = 0;
    fake.put = async (key, value, opts = {}) => {
      if (key === "manifest.json" && opts.onlyIf?.etagMatches !== undefined && raced < times) {
        raced += 1;
        const m = storedManifest();
        theirs(m, raced);
        m.seq += 1;
        await realPut(key, JSON.stringify(m), JSON_META);
      }
      return realPut(key, value, opts);
    };
    try {
      return { res: await run(), raced };
    } finally {
      delete fake.put;
    }
  };
  /** A file another device adds — its blob is already up, as a Mac's is before its manifest. */
  const theirFile = async (p, content) => {
    const fid = `f-mac${String((macFiles += 1)).padStart(6, "0")}`;
    await fake.put(`blobs/${fid}/${blobHash(content)}`, content);
    return (m) => {
      m.files[fid] = { path: p, rev: 1, hash: blobHash(content), size: content.length, mtime: Date.now(), by: ALICE.id };
    };
  };
  /** After a request: every blob in the bucket is one the manifest names, or was there before. */
  const noOrphans = (before, message) => {
    const live = liveBlobKeys(storedManifest());
    assert.deepEqual(blobKeys().filter((k) => !before.has(k) && !live.has(k)), [], message);
  };

  // An unrelated write gets there first: both land.
  let before = new Set(blobKeys());
  let start = storedManifest();
  const addTheirs = await theirFile("Race/theirs.md", "# Theirs\n");
  before = new Set(blobKeys());
  const mine = "# Mine\n";
  const won = await racing(1, addTheirs, () => api(docUrl("Race/mine"), { method: "PUT", body: mine }));
  assert.equal(won.raced, 1, "the race happened");
  assert.equal(won.res.status, 201, "a lost race is re-read and re-applied, not failed");
  let after = storedManifest();
  assert.equal(after.seq, start.seq + 2, "their write, then this one on top of it");
  assert.ok(entryAt(after, "Race/theirs.md"), "nothing of the other device's is lost");
  assert.equal(textAt("Race/mine.md"), mine);
  assert.equal(entryAt(after, "Race/mine.md")[1].rev, 1);
  assert.equal(blobKeys().filter((k) => !before.has(k)).length, 1, "one blob for one new file — the first attempt's is gone");
  noOrphans(before, "no orphan from the attempt that lost");

  // Four lost races in a row are survived.
  start = storedManifest();
  before = new Set(blobKeys());
  const four = await racing(4, (m, n) => {
    m.name = `Renamed ${n}`;
  }, () => api(docUrl("Race/doc"), { method: "PUT", body: "# Doc\n\nRewritten.\n", headers: { "if-rev": "1" } }));
  assert.deepEqual([four.raced, four.res.status, four.res.json.rev], [4, 200, 2]);
  after = storedManifest();
  assert.equal(after.seq, start.seq + 5);
  assert.equal(after.name, "Renamed 4", "each of their writes is under this one");
  noOrphans(before, "the same blob served every attempt");

  // …and a workspace that never holds still is a 503, with nothing left behind.
  start = storedManifest();
  before = new Set(blobKeys());
  const never = await racing(99, (m, n) => {
    m.name = `Busy ${n}`;
  }, () => api(docUrl("Race/unlucky"), { method: "PUT", body: "# Unlucky\n" }));
  assert.equal(never.res.status, 503);
  assert.equal(never.raced, 5, "once, and again after each of four lost races");
  assert.ok(/try again in a moment/.test(never.res.json.error));
  after = storedManifest();
  assert.equal(entryAt(after, "Race/unlucky.md"), undefined);
  assert.equal(after.seq, start.seq + 5, "only their writes landed");
  noOrphans(before, "five attempts, five blobs, none kept");
  assert.deepEqual(blobKeys().filter((k) => !before.has(k)), []);

  // The race is for the very document: the precondition is checked again,
  // against the manifest the retry was handed, and the write is refused.
  const [docFid, doc] = entryAt(storedManifest(), "Race/doc.md");
  const theirText = "# Doc\n\nEdited on a Mac meanwhile.\n";
  await fake.put(`blobs/${docFid}/${blobHash(theirText)}`, theirText);
  before = new Set(blobKeys());
  const myText = "# Doc\n\nEdited by the agent, on what it read.\n";
  const conflict = await racing(
    1,
    (m) => {
      m.files[docFid] = { ...m.files[docFid], rev: doc.rev + 1, hash: blobHash(theirText), size: theirText.length, by: ALICE.id };
    },
    () => api(docUrl("Race/doc"), { method: "PUT", body: myText, headers: { "if-rev": String(doc.rev) } }),
  );
  assert.equal(conflict.raced, 1);
  assert.equal(conflict.res.status, 409, "the document changed after it was read");
  assert.equal(conflict.res.json.rev, doc.rev + 1);
  assert.equal(textAt("Race/doc.md"), theirText, "the other device's edit stands");
  assert.ok(!fake.store.has(`blobs/${docFid}/${blobHash(myText)}`), "and the refused text is not left in the bucket");
  noOrphans(before, "a refusal after a lost race sweeps what the first attempt stored");

  // Two writers creating one name: the second finds it exists.
  const sameName = await theirFile("Race/same.md", "# Theirs first\n");
  before = new Set(blobKeys());
  const second = await racing(1, sameName, () => api(docUrl("Race/same"), { method: "PUT", body: "# Mine second\n", headers: { "if-rev": "*" } }));
  assert.equal(second.res.status, 409);
  assert.ok(/already exists/.test(second.res.json.error));
  assert.equal(textAt("Race/same.md"), "# Theirs first\n");
  assert.equal(pathsOf(storedManifest()).filter((p) => p.toLowerCase() === "race/same.md").length, 1, "one file, not two");
  noOrphans(before, "nothing of the loser's is left");

  // A move and a delete ride the same loop.
  const third = await theirFile("Race/third.md", "# Third\n");
  const movedRace = await racing(1, third, () => api("/api/agent/move", { method: "POST", body: { from: "Race/mine", to: "Race/moved" } }));
  assert.equal(movedRace.res.status, 200);
  const fourth = await theirFile("Race/fourth.md", "# Fourth\n");
  const removedRace = await racing(1, fourth, () => api(docUrl("Race/moved"), { method: "DELETE" }));
  assert.equal(removedRace.res.status, 200);
  assert.deepEqual(pathsOf(storedManifest()), ["Race/doc.md", "Race/fourth.md", "Race/same.md", "Race/theirs.md", "Race/third.md"]);
});

await test("commit: what a change adds up to is checked the way a Mac's PUT is — a workspace at its file limit refuses one more, and stores nothing", async () => {
  // Five thousand files: the manifest's own ceiling (layout.ts, MAX_MANIFEST_FILES).
  await macWrite((m) => {
    m.files = {};
    m.tombstones = {};
    m.public = {};
    for (let i = 0; i < 5000; i += 1) {
      const n = String(i).padStart(4, "0");
      m.files[`f-full${n}`] = { path: `Full/file-${n}.txt`, rev: 1, hash: blobHash(`file ${n}`), size: 9, mtime: 1757000000000, by: ALICE.id };
    }
  });
  const bot = await addAgent("One too many", ["edit"]);
  const api = as(bot);
  const etag = etagNow();
  const blobs = blobKeys().length;
  const over = await api(docUrl("Full/one-more"), { method: "PUT", body: "# One more\n" });
  assert.equal(over.status, 409);
  assert.ok(/too many files/.test(over.json.error), "in the manifest check's own words");
  assert.equal(etagNow(), etag);
  assert.equal(blobKeys().length, blobs, "refused before anything was uploaded");
  // A move adds nothing, and a removal makes room.
  assert.equal((await api("/api/agent/move", { method: "POST", body: { from: "Full/file-0000.txt", to: "Full/renamed.txt" } })).status, 200);
  assert.equal((await api(docUrl("Full/file-0001.txt"), { method: "DELETE" })).status, 200);
  assert.equal((await api(docUrl("Full/one-more"), { method: "PUT", body: "# One more\n" })).status, 201);
  assert.equal(Object.keys(storedManifest().files).length, 5000);
  assert.equal((await api("/api/agent/tree?dir=Full")).json.files.length, 4999, "and a listing of all of it still answers");
});

/* ---------- The document API: publishing ---------- */

await test("pages: publishing is an entry in the public map — it answers at once, keeps its first publisher, and follows its document through a move, a new version and a removal", async () => {
  await freshWorkspace({
    "Pub/note.md": "# A note\n\nPublic words.\n",
    "Pub/page.html": "<h1>Only a page</h1>\n",
    "Pub/pair.md": "# Pair\n",
    "Pub/pair.html": "<h1>Pair</h1>\n",
    "Pub/pic.png": PIXEL_PNG,
    "Pub/data.csv": "a,b\n",
    "Pub/Sub/inner.md": "# Inner\n",
    "Pub/Sub/standalone.html": "<h1>Standalone</h1>\n",
    "Pub/Sub/Deep/deeper.md": "# Deeper\n",
    "Elsewhere/other.md": "# Other\n",
  });
  const bot = await addAgent("Publisher", ["edit", "publish"]);
  const api = as(bot);
  const publish = (body) => api("/api/agent/pages", { method: "PUT", body });
  const unpublish = (query) => api(`/api/agent/pages?${query}`, { method: "DELETE" });
  const pagesNow = async () => (await api("/api/agent/pages")).json.pages;
  const fidAt = (p) => entryAt(storedManifest(), p)[0];
  const before = Date.now();

  // A document, by whatever name it was typed under.
  const first = await publish({ path: "Pub/note.md" });
  assert.equal(first.status, 201);
  const random = first.json.slug;
  assert.ok(/^[abcdefghjkmnpqrstuvwxyz23456789]{8}$/.test(random), "a random address with no look-alike characters");
  assert.deepEqual(first.json, { slug: random, url: `${ORIGIN}/${random}`, kind: "document", path: "Pub/note", documents: ["Pub/note"], created: true });
  const entry = storedManifest().public[random];
  assert.deepEqual({ ...entry, at: 0 }, { kind: "file", file: fidAt("Pub/note.md"), path: "Pub/note.md", by: bot.id, at: 0 }, "the entry a Mac writes: the file's id, and a snapshot of its path");
  assert.ok(entry.at >= before && entry.at <= Date.now());
  const page = await pub(`/${random}`);
  assert.equal(page.status, 200, "nothing is uploaded or rendered ahead: the address answers the moment the entry lands");
  assert.ok(page.text.includes("Public words."));

  // Publishing it again renames or retitles the page; it does not make a second one.
  const named = await publish({ path: "Pub/note", slug: "  My-Note ", title: "A note, public", desc: "What it says." });
  assert.equal(named.status, 200);
  assert.deepEqual([named.json.slug, named.json.url, named.json.created], ["my-note", `${ORIGIN}/my-note`, false]);
  let map = storedManifest().public;
  assert.deepEqual(Object.keys(map), ["my-note"], "one page a document");
  assert.deepEqual(map["my-note"], { ...entry, title: "A note, public", desc: "What it says." }, "who published it first, and when, stay");
  assert.equal((await pub(`/${random}`)).status, 404);
  assert.ok((await pub("/my-note")).text.includes("<title>A note, public</title>"));
  const etag = etagNow();
  const same = await publish({ path: "Pub/note" });
  assert.deepEqual([same.status, same.json.slug, same.json.created, same.json.written], [200, "my-note", false, false], "already exactly this: nothing is written");
  assert.equal(etagNow(), etag);
  const second = await addAgent("Second publisher", ["publish"]);
  assert.equal((await as(second)("/api/agent/pages", { method: "PUT", body: { path: "Pub/note", title: "Retitled" } })).status, 200);
  map = storedManifest().public;
  assert.deepEqual([map["my-note"].title, map["my-note"].desc, map["my-note"].by, map["my-note"].at], ["Retitled", "What it says.", bot.id, entry.at], "republishing does not take a page over");

  // An address is free, or its own.
  const taken = await publish({ path: "Pub/pair", slug: "my-note" });
  assert.equal(taken.status, 409);
  assert.equal(taken.json.code, "slug_taken");
  assert.ok(/already the address of Pub\/note.md/.test(taken.json.error));
  for (const slug of ["ab", "has space", "-leading", "api", "join", "a".repeat(65)]) {
    assert.equal((await publish({ path: "Pub/pair", slug })).status, 400, `"${slug}" is not an address`);
  }
  assert.equal((await publish({})).status, 400, "say what to publish");
  assert.equal((await publish({ path: "Pub/nothing" })).status, 404);
  assert.equal((await publish({ path: ".hidden/x" })).status, 400);
  assert.equal((await api("/api/agent/pages", { method: "PUT", body: "not json" })).status, 400);
  const csv = await publish({ path: "Pub/data.csv" });
  assert.equal(csv.status, 400);
  assert.ok(/cannot be a page of its own/.test(csv.json.error));
  const pic = await publish({ path: "Pub/pic.png", slug: "the-pic" });
  assert.deepEqual([pic.status, pic.json.kind, pic.json.path], [201, "file", "Pub/pic.png"], "a picture can be a page");
  assert.deepEqual(Object.keys(storedManifest().public).sort(), ["my-note", "the-pic"], "none of the refusals left an entry");

  // What is public: as addresses, with who and when.
  const listed = await pagesNow();
  assert.deepEqual(listed.map((p) => p.slug), ["my-note", "the-pic"]);
  assert.deepEqual(listed[0], {
    slug: "my-note",
    url: `${ORIGIN}/my-note`,
    kind: "document",
    path: "Pub/note",
    title: "Retitled",
    desc: "What it says.",
    by: bot.id,
    byName: "Publisher",
    at: entry.at,
  });
  assert.deepEqual([listed[1].kind, listed[1].path], ["file", "Pub/pic.png"]);
  const row = (await api("/api/agent/tree?dir=Pub")).json.documents.find((d) => d.path === "Pub/note");
  assert.deepEqual(row.public, [`${ORIGIN}/my-note`], "and a listing shows it on the document");
  assert.deepEqual((await api(docUrl("Pub/note", "", "&info=1"))).json.public, [`${ORIGIN}/my-note`]);

  // The domain's home page is chosen in the app; an agent sees it, and republishing leaves it be.
  await macWrite((m) => {
    m.public["my-note"].root = true;
  });
  assert.equal((await pagesNow())[0].home, true);
  assert.deepEqual((await api(docUrl("Pub/note", "", "&info=1"))).json.public, [`${ORIGIN}/`, `${ORIGIN}/my-note`]);
  assert.equal((await publish({ path: "Pub/note", desc: "Still the home page." })).status, 200);
  assert.equal(storedManifest().public["my-note"].root, true);
  await macWrite((m) => {
    delete m.public["my-note"].root;
  });

  // The page follows its document when it moves.
  const noteFid = fidAt("Pub/note.md");
  assert.equal((await api("/api/agent/move", { method: "POST", body: { from: "Pub/note", to: "Pub/renamed" } })).status, 200);
  map = storedManifest().public;
  assert.deepEqual([map["my-note"].file, map["my-note"].path], [noteFid, "Pub/renamed.md"], "the same file, and its new path in the same write");
  assert.equal((await pub("/my-note")).status, 200);
  assert.equal((await pagesNow())[0].path, "Pub/renamed");

  // A document's page is its markdown's when it has one, its html's when it has not.
  const pair = await publish({ path: "Pub/pair.html", slug: "the-pair" });
  assert.equal(pair.json.kind, "document");
  assert.equal(storedManifest().public["the-pair"].file, fidAt("Pub/pair.md"), "typed as the html, published as the document");
  const htmlFid = fidAt("Pub/page.html");
  const only = await publish({ path: "Pub/page", slug: "the-page" });
  assert.deepEqual([only.status, only.json.kind, only.json.path], [201, "document", "Pub/page"]);
  map = storedManifest().public;
  assert.deepEqual([map["the-page"].file, map["the-page"].path], [htmlFid, "Pub/page.html"]);
  const htmlPage = await pub("/the-page");
  assert.equal(htmlPage.status, 200);
  assert.ok(!htmlPage.text.includes('<nav class="view-pill"'), "html only: nothing to switch to");
  // It gains a markdown version: the page becomes the markdown's, which is what gives it the switch.
  assert.equal((await api(docUrl("Pub/page", "md"), { method: "PUT", body: "# Page, in markdown\n" })).status, 201);
  map = storedManifest().public;
  assert.deepEqual([map["the-page"].file, map["the-page"].path], [fidAt("Pub/page.md"), "Pub/page.md"]);
  assert.ok((await pub("/the-page")).text.includes('<nav class="view-pill"'), "both versions, and the pill between them");
  // And loses it again: back to the html.
  assert.equal((await api(docUrl("Pub/page", "md"), { method: "DELETE" })).status, 200);
  map = storedManifest().public;
  assert.deepEqual([map["the-page"].file, map["the-page"].path], [htmlFid, "Pub/page.html"]);
  assert.equal((await pub("/the-page")).status, 200);

  // A page a Mac left on the html of a document that has both: when the html goes, the markdown is what it shows.
  await macWrite((m, put) => {
    put("Pub/left.md", "# Left behind\n");
    const leftHtml = put("Pub/left.html", "<h1>Left behind</h1>\n");
    m.public["left-page"] = { kind: "file", file: leftHtml, path: "Pub/left.html", by: ALICE.id, at: 1757000000000 };
  });
  assert.equal((await api(docUrl("Pub/left", "html"), { method: "DELETE" })).status, 200);
  map = storedManifest().public;
  assert.deepEqual([map["left-page"].file, map["left-page"].path], [fidAt("Pub/left.md"), "Pub/left.md"]);
  assert.ok((await pub("/left-page")).text.includes("<h1>Left behind</h1>"), "the page did not die with the version");
  assert.equal((await unpublish("slug=left-page")).status, 200);
  assert.equal((await api(docUrl("Pub/left"), { method: "DELETE" })).status, 200);

  // A folder: everything in it. The dry run says what that is, and writes nothing.
  const dryEtag = etagNow();
  const dry = await publish({ path: "Pub/Sub/", dryRun: true });
  assert.equal(dry.status, 200);
  assert.deepEqual(
    { ...dry.json, slug: "", url: "" },
    { slug: "", url: "", kind: "folder", path: "Pub/Sub", documents: ["Pub/Sub/Deep/deeper", "Pub/Sub/inner", "Pub/Sub/standalone"], created: true, written: false },
    "every document that would become readable — an html-only one is served there too",
  );
  assert.equal(etagNow(), dryEtag);
  const folder = await publish({ path: "pub/sub/", slug: "sub-folder", title: "Sub" });
  assert.deepEqual([folder.status, folder.json.kind, folder.json.path], [201, "folder", "Pub/Sub"], "the folder as it is spelled, however it was typed");
  map = storedManifest().public;
  assert.deepEqual({ ...map["sub-folder"], at: 0 }, { kind: "dir", path: "Pub/Sub", title: "Sub", by: bot.id, at: 0 });
  assert.ok((await pub("/sub-folder")).text.includes("inner"), "the folder's page lists its notes");
  assert.ok((await pub("/sub-folder/inner")).text.includes("<h1>Inner</h1>"));
  assert.equal((await rawGet("/sub-folder/standalone.html")).status, 200, "and the html-only document answers at its own name");
  const deepFolder = await publish({ path: "Pub/Sub/Deep", slug: "deep-folder" });
  assert.deepEqual([deepFolder.status, deepFolder.json.kind, deepFolder.json.documents], [201, "folder", ["Pub/Sub/Deep/deeper"]], "a folder named without its slash");
  assert.equal((await publish({ path: "Pub/Sub/", slug: "sub-folder" })).json.written, false);
  // Whatever a listing then shows as public under the folder is what the dry run named.
  const under = (await api("/api/agent/tree?dir=Pub/Sub&deep=1")).json.documents;
  assert.deepEqual(under.filter((d) => d.public?.some((u) => u.startsWith(`${ORIGIN}/sub-folder/`))).map((d) => d.path), dry.json.documents);
  assert.deepEqual(under.find((d) => d.path === "Pub/Sub/Deep/deeper").public, [`${ORIGIN}/deep-folder/deeper`, `${ORIGIN}/sub-folder/Deep/deeper`]);
  assert.deepEqual(under.find((d) => d.path === "Pub/Sub/standalone").public, [`${ORIGIN}/sub-folder/standalone.html`]);
  // The whole workspace is the folder "/".
  const allEtag = etagNow();
  const all = await publish({ path: "/", dryRun: true });
  assert.deepEqual([all.json.kind, all.json.path, all.json.written], ["folder", "", false]);
  assert.deepEqual(all.json.documents, ["Elsewhere/other", "Pub/page", "Pub/pair", "Pub/renamed", "Pub/Sub/Deep/deeper", "Pub/Sub/inner", "Pub/Sub/standalone"]);
  assert.equal(etagNow(), allEtag);
  assert.equal((await publish({ path: "" })).status, 400);
  assert.equal((await publish({ path: "." })).status, 400, "the workspace is named by its slash, not by a dot");

  // A published folder follows its folder — and so does one published beneath it, and a page inside it.
  assert.equal((await publish({ path: "Pub/Sub/inner", slug: "the-inner" })).status, 201);
  const innerFid = fidAt("Pub/Sub/inner.md");
  const movedFolder = await api("/api/agent/move", { method: "POST", body: { from: "Pub/Sub/", to: "Pub/Moved" } });
  assert.equal(movedFolder.status, 200);
  map = storedManifest().public;
  assert.equal(map["sub-folder"].path, "Pub/Moved");
  assert.equal(map["deep-folder"].path, "Pub/Moved/Deep");
  assert.deepEqual([map["the-inner"].file, map["the-inner"].path], [innerFid, "Pub/Moved/inner.md"]);
  assert.ok((await pub("/sub-folder/inner")).text.includes("<h1>Inner</h1>"), "the same address, the folder's new place");
  assert.ok((await pub("/deep-folder/deeper")).text.includes("<h1>Deeper</h1>"));

  // A removed document's page stays: it answers 404 until the document is back.
  const removed = await api(docUrl("Pub/renamed"), { method: "DELETE" });
  assert.deepEqual(removed.json.stillPublic, [`${ORIGIN}/my-note`], "the removal says the address is still held");
  map = storedManifest().public;
  assert.deepEqual([map["my-note"].file, map["my-note"].path], [noteFid, "Pub/renamed.md"], "the entry outlives its file");
  assert.equal((await pub("/my-note")).status, 404);
  const ghost = (await pagesNow()).find((p) => p.slug === "my-note");
  assert.deepEqual([ghost.path, ghost.kind, ghost.missing], ["Pub/renamed", "document", true]);
  assert.deepEqual((await api(docUrl("Pub/pic.png"), { method: "DELETE" })).json.stillPublic, [`${ORIGIN}/the-pic`]);
  // The document comes back at its path: the page adopts the new file.
  assert.equal((await api(docUrl("Pub/renamed"), { method: "PUT", body: "# Back again\n" })).status, 201);
  map = storedManifest().public;
  assert.equal(map["my-note"].file, fidAt("Pub/renamed.md"));
  assert.notEqual(map["my-note"].file, noteFid);
  assert.ok((await pub("/my-note")).text.includes("<h1>Back again</h1>"));
  assert.equal((await pagesNow()).find((p) => p.slug === "my-note").missing, undefined);

  // Stopping: by the document, the folder, the address, or the path a dead page remembers.
  const stopEtag = etagNow();
  const dryStop = await unpublish("path=Pub/renamed&dry=1");
  assert.deepEqual(dryStop.json, { stopped: [{ slug: "my-note", url: `${ORIGIN}/my-note` }], written: false });
  assert.equal(etagNow(), stopEtag);
  const stopped = await unpublish("path=Pub/renamed.md");
  assert.equal(stopped.status, 200);
  assert.deepEqual(stopped.json, { stopped: [{ slug: "my-note", url: `${ORIGIN}/my-note` }] });
  assert.equal(storedManifest().public["my-note"], undefined);
  assert.equal((await pub("/my-note")).status, 404);
  assert.ok(entryAt(storedManifest(), "Pub/renamed.md"), "the document itself is untouched");
  const again = await unpublish("path=Pub/renamed");
  assert.equal(again.status, 404);
  assert.ok(/is not published/.test(again.json.error));
  assert.equal((await unpublish("slug=THE-PAGE")).status, 200, "by its address");
  assert.equal((await unpublish("slug=the-page")).status, 404);
  assert.equal((await unpublish("")).status, 400);
  assert.equal((await unpublish("path=.hidden/x")).status, 400);
  assert.deepEqual((await unpublish("path=deep-folder")).json.stopped.map((s) => s.slug), ["deep-folder"], "an address given where a path goes");
  assert.deepEqual((await unpublish("path=Pub/Moved/")).json.stopped.map((s) => s.slug), ["sub-folder"], "a folder");
  assert.deepEqual((await unpublish("path=Pub/pic.png")).json.stopped.map((s) => s.slug), ["the-pic"], "a page whose file is gone, by the path it remembers");
  assert.deepEqual(Object.keys(storedManifest().public).sort(), ["the-inner", "the-pair"]);
});

/* ---------- The document API: comments ---------- */

const commentsUrl = (p, more = "") => `/api/agent/comments?path=${encodeURIComponent(p)}${more}`;

// The app's own sidecar module, compiled the way the worker was: what the
// worker writes has to be what the app would have written, or every Mac that
// opens the document rewrites it.
const appMeta = await (async () => {
  const out = await build({
    configFile: false,
    logLevel: "warn",
    build: {
      write: false,
      target: "es2022",
      lib: { entry: path.join(workerDir, "..", "src", "metaFile.ts"), formats: ["es"], fileName: "metaFile" },
    },
  });
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === "chunk");
  return import(`data:text/javascript,${encodeURIComponent(chunk.code)}`);
})();
/** Whether the app, opening this document, finds it already in its normal
 *  form — nothing to migrate in the markdown, nothing to rewrite in the sidecar. */
const settled = (stem, mdExt = ".md") => {
  const metaText = textAt(`${stem}.meta.jsonl`) ?? "";
  const meta = appMeta.parseEntityMeta(metaText);
  const result = appMeta.migrateEntity({ diskMd: mdExt ? textAt(`${stem}${mdExt}`) : null, meta });
  return !result.mdChanged && !result.metaChanged && (metaText === "" || appMeta.serializeEntityMeta(meta) === metaText);
};

await test("comments: a markdown thread is a marker in the text and a record in the sidecar, written together; the words must be plain, and occur once in ordinary text", async () => {
  const DRAFT = [
    "---",
    "title: ships in June",
    "---",
    "# The boat ships in June",
    "",
    "The boat ships in June if the paint dries. The crew is ready.",
    "",
    "Use `launch-window` and `ships in June` in code. See [the plan](https://example.com/the-paint-dries).",
    "",
    "- The crew is ready.",
    "",
    "```",
    "if the paint dries",
    "```",
    "",
  ].join("\n");
  await freshWorkspace({
    "Talk/draft.md": DRAFT,
    "Talk/old.md": "Hello {==old words==}{>>#old111 Alice · 2026-01-01T10:00:00Z: an inline thread<<} there.\n",
    "Talk/chart.png": PIXEL_PNG,
  });
  const bot = await addAgent("Reviewer", ["comment", "edit"]);
  const api = as(bot);
  const say = (body) => api("/api/agent/comments", { method: "POST", body });
  const threads = async (p) => (await api(commentsUrl(p))).json.threads;
  const start = storedManifest();
  const [mdFid] = entryAt(start, "Talk/draft.md");
  const before = Date.now();

  assert.deepEqual((await api(commentsUrl("Talk/draft"))).json, { path: "Talk/draft", threads: [] });

  // Where a comment cannot sit. Every refusal lists the places, so the
  // caller can quote more of the sentence.
  const twice = await say({ path: "Talk/draft", on: "ships in June", body: "When?" });
  assert.equal(twice.status, 409);
  assert.equal(twice.json.code, "anchor");
  assert.ok(/occurs 2 times/.test(twice.json.error), "the heading and the paragraph — not the properties, not the code");
  assert.deepEqual(twice.json.occurrences, [
    { line: 2, text: "title: ships in June", inside: "the properties at the top" },
    { line: 4, text: "# The boat ships in June" },
    { line: 6, text: "The boat ships in June if the paint dries. The crew is ready." },
    { line: 8, text: "Use `launch-window` and `ships in June` in code. See [the plan](https://example.com/the-paint-dries).", inside: "code" },
  ]);
  const both = await say({ path: "Talk/draft", on: "The crew is ready", body: "Are they?" });
  assert.deepEqual([both.status, both.json.code, both.json.occurrences.map((o) => o.line)], [409, "anchor", [6, 10]]);
  const none = await say({ path: "Talk/draft", on: "no such words", body: "?" });
  assert.deepEqual([none.status, none.json.code, none.json.occurrences], [404, "anchor", []]);
  assert.ok(/does not occur in the markdown of Talk\/draft/.test(none.json.error));
  const inCode = await say({ path: "Talk/draft", on: "launch-window", body: "?" });
  assert.deepEqual([inCode.status, inCode.json.code], [409, "anchor"]);
  assert.ok(/only occurs inside code/.test(inCode.json.error));
  assert.deepEqual(inCode.json.occurrences.map((o) => [o.line, o.inside]), [[8, "code"]]);
  const inAddress = await say({ path: "Talk/draft", on: "the-paint-dries", body: "?" });
  assert.ok(/only occurs inside a link's address/.test(inAddress.json.error));
  const listMark = await say({ path: "Talk/draft", on: "- The crew is ready.", body: "?" });
  assert.equal(listMark.status, 409);
  assert.ok(/a heading or list mark — quote the words after it/.test(listMark.json.error));
  for (const on of ["**bold** words", "a `code` span", "[the plan]", "two\nlines", "the_plan _now_"]) {
    assert.equal((await say({ path: "Talk/draft", on, body: "?" })).status, 400, `${JSON.stringify(on)} is not plain words on one line`);
  }
  assert.equal((await say({ path: "Talk/draft", on: "   ", body: "?" })).status, 400, "which words");
  assert.equal((await say({ path: "Talk/draft", on: "The boat", body: "  \n " })).status, 400, "and something to say");
  assert.equal((await say({ path: "Talk/draft", on: "The boat", body: "?", v: "pdf" })).status, 400);
  assert.equal((await say({ path: "Talk/draft", on: "if the paint dries", body: "?", v: "html" })).status, 404, "it has no html version");
  assert.equal((await say({ path: "Talk/nothing", on: "words", body: "?" })).status, 404);
  assert.equal((await say({ path: "Talk/chart.png", on: "words", body: "?" })).status, 400, "a plain file has no comments");
  assert.equal((await api(commentsUrl("Talk/chart.png"))).status, 400);
  assert.equal((await api(commentsUrl("Talk/nothing"))).status, 404);
  assert.equal((await api("/api/agent/comments", { method: "POST", body: "not json" })).status, 400);
  assert.equal(storedManifest().seq, start.seq, "none of the refusals wrote anything");
  assert.equal(textAt("Talk/draft.md"), DRAFT);

  // A dry run says where the thread would go, and writes neither half.
  const dry = await say({ path: "Talk/draft", on: "if the paint dries", body: "Is that still true?", dryRun: true });
  assert.equal(dry.status, 200);
  assert.deepEqual([dry.json.version, dry.json.on, dry.json.line, dry.json.written], ["md", "if the paint dries", 6, false]);
  assert.equal(storedManifest().seq, start.seq);
  assert.equal(textAt("Talk/draft.md"), DRAFT);

  // The words occur once in ordinary text — the copy inside the code block does not count.
  const made = await say({ path: "Talk/draft.md", on: "  if the paint dries ", body: "Is that\n\nstill true?" });
  assert.equal(made.status, 201);
  const id = made.json.thread;
  assert.ok(/^[a-z0-9]{6}$/.test(id));
  assert.deepEqual(made.json, { path: "Talk/draft", thread: id, version: "md", on: "if the paint dries", line: 6 });
  const one = storedManifest();
  assert.equal(one.seq, start.seq + 1, "the marker and the record land in one manifest write");
  const marked = DRAFT.replace("if the paint dries.", `{==if the paint dries==}{>>#${id}<<}.`);
  assert.equal(textAt("Talk/draft.md"), marked, "a bare marker around the words, and nothing else changed");
  assert.deepEqual([one.files[mdFid].rev, one.files[mdFid].by], [2, bot.id]);
  const [metaFid, metaFile] = entryAt(one, "Talk/draft.meta.jsonl");
  assert.deepEqual([metaFile.rev, metaFile.by], [1, bot.id], "the sidecar is a file like any other to a Mac");
  assert.ok(/^f-[a-f0-9]{12}$/.test(metaFid));
  const records = recordsOf(textAt("Talk/draft.meta.jsonl"));
  assert.equal(records.length, 1);
  assert.deepEqual({ ...records[0], comments: [{ ...records[0].comments[0], at: 0 }] }, {
    t: "mthread",
    id,
    comments: [{ author: "Reviewer", at: 0, body: "Is that still true?" }],
  });
  const at = records[0].comments[0].at;
  assert.ok(at >= before - 1000 && at <= Date.now());
  assert.equal(at % 1000, 0, "stamped to the second — all the markdown form of a thread keeps, so a Mac that opens it finds nothing to rewrite");
  assert.ok(textAt("Talk/draft.meta.jsonl").startsWith('{"doklin":"meta","v":1}\n'), "in the app's own format");
  assert.ok(settled("Talk/draft"), "and exactly as the app would have written both files");
  assert.ok(!JSON.stringify((await api("/api/agent/tree?deep=1")).json).includes("meta.jsonl"), "and still never listed");

  assert.deepEqual(await threads("Talk/draft"), [
    { id, version: "md", on: "if the paint dries", line: 6, comments: [{ author: "Reviewer", at, body: "Is that still true?" }] },
  ]);

  // Words inside an existing comment cannot carry another.
  const nested = await say({ path: "Talk/draft", on: "paint dries", body: "?" });
  assert.equal(nested.status, 409);
  assert.ok(/only occurs inside an existing comment/.test(nested.json.error));

  // Answering: the sidecar alone changes.
  const other = await addAgent("Second reviewer", ["comment"]);
  const reply = await as(other)("/api/agent/comments", { method: "POST", body: { path: "Talk/draft", thread: `#${id}`, body: "Yes." } });
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.json, { path: "Talk/draft", thread: id, version: "md", comments: 2 });
  const two = storedManifest();
  assert.equal(two.files[mdFid].rev, 2, "the text was not rewritten for a reply");
  assert.equal(two.files[metaFid].rev, 2);
  const afterReply = recordsOf(textAt("Talk/draft.meta.jsonl"))[0].comments;
  assert.deepEqual(afterReply.map((c) => [c.author, c.body]), [
    ["Reviewer", "Is that still true?"],
    ["Second reviewer", "Yes."],
  ]);
  assert.equal(afterReply[0].at, at, "what was already there is carried through as it was");
  assert.ok(settled("Talk/draft"));
  assert.equal((await say({ path: "Talk/draft", thread: "nope00", body: "?" })).status, 404);
  const dryReply = await say({ path: "Talk/draft", thread: id, body: "Not written.", dryRun: true });
  assert.deepEqual([dryReply.status, dryReply.json.comments, dryReply.json.written], [200, 3, false]);
  assert.equal((await threads("Talk/draft"))[0].comments.length, 2);

  // A second thread; reading shows both markers, and --clean neither.
  const secondThread = await say({ path: "Talk/draft", on: "in code", body: "Which code?" });
  assert.deepEqual([secondThread.status, secondThread.json.line], [201, 8]);
  const id2 = secondThread.json.thread;
  assert.notEqual(id2, id);
  const read = await api(docUrl("Talk/draft"));
  assert.ok(read.text.includes(`{==if the paint dries==}{>>#${id}<<}`) && read.text.includes(`{==in code==}{>>#${id2}<<}`), "a read keeps the markers, so a write back keeps the comments");
  const clean = await api(docUrl("Talk/draft", "", "&clean=1"));
  assert.equal(clean.text, DRAFT, "--clean is the text as it was before anyone commented");
  assert.equal(clean.headers.get("x-doklin-rev"), read.headers.get("x-doklin-rev"));
  assert.deepEqual((await threads("Talk/draft")).map((t) => [t.id, t.line]), [[id, 6], [id2, 8]]);
  assert.equal((await api(docUrl("Talk/draft", "", "&info=1"))).json.comments, 2);

  // Rewriting the document. Markers kept: nothing to say.
  const rev = () => String(entryAt(storedManifest(), "Talk/draft.md")[1].rev);
  const kept = await api(docUrl("Talk/draft"), { method: "PUT", body: read.text.replace("The crew is ready.", "The crew is rested."), headers: { "if-rev": rev() } });
  assert.equal(kept.status, 200);
  assert.equal(kept.json.orphaned, undefined);
  // A marker of its own making: refused — a thread is started with the comments route.
  const invented = await api(docUrl("Talk/draft"), { method: "PUT", body: `${read.text}\n{==my own==}{>>#zzz999<<}\n`, headers: { "if-rev": rev() } });
  assert.equal(invented.status, 400);
  assert.deepEqual(invented.json.unknownMarkers, ["zzz999"]);
  assert.ok(/start a thread with the comment command/.test(invented.json.error));
  assert.equal((await api(docUrl("Talk/fresh"), { method: "PUT", body: "A {==new==}{>>#abc999<<} document.\n" })).status, 400, "in a new document too");
  // A marker dropped: the thread is kept, without a place, and the answer names it.
  const current = (await api(docUrl("Talk/draft"))).text;
  const dropped = await api(docUrl("Talk/draft"), { method: "PUT", body: current.replace(`{==in code==}{>>#${id2}<<}`, "in code"), headers: { "if-rev": rev() } });
  assert.equal(dropped.status, 200);
  assert.deepEqual(dropped.json.orphaned, [id2]);
  const afterDrop = await threads("Talk/draft");
  assert.deepEqual(afterDrop.map((t) => [t.id, t.orphaned ?? false, t.on]), [[id, false, "if the paint dries"], [id2, true, ""]]);
  assert.equal(afterDrop[1].comments[0].body, "Which code?", "the conversation is not lost with its place");
  // Its marker written back puts it in place again — that id is a thread's, not an invention.
  const restored = await api(docUrl("Talk/draft"), { method: "PUT", body: current, headers: { "if-rev": rev() } });
  assert.deepEqual([restored.status, restored.json.orphaned], [200, undefined]);
  assert.deepEqual((await threads("Talk/draft")).map((t) => t.orphaned ?? false), [false, false]);
  // The clean text written back over the markdown drops every marker.
  const wiped = await api(docUrl("Talk/draft"), { method: "PUT", body: DRAFT, headers: { "if-rev": rev() } });
  assert.deepEqual(wiped.json.orphaned.sort(), [id, id2].sort());
  assert.equal((await api(docUrl("Talk/draft"), { method: "PUT", body: current, headers: { "if-rev": rev() } })).status, 200);

  // Removing a thread unwraps its marker: the words stay.
  const dryRm = await api(commentsUrl("Talk/draft", `&thread=${id2}&dry=1`), { method: "DELETE" });
  assert.deepEqual(dryRm.json, { path: "Talk/draft", thread: id2, version: "md", removed: false });
  assert.equal((await threads("Talk/draft")).length, 2);
  const rm = await api(commentsUrl("Talk/draft", `&thread=%23${id2}`), { method: "DELETE" });
  assert.equal(rm.status, 200);
  assert.deepEqual(rm.json, { path: "Talk/draft", thread: id2, version: "md", removed: true });
  assert.ok(!textAt("Talk/draft.md").includes(id2) && textAt("Talk/draft.md").includes("`ships in June` in code. See"));
  assert.deepEqual(recordsOf(textAt("Talk/draft.meta.jsonl")).map((r) => r.id), [id]);
  assert.ok(settled("Talk/draft"));
  assert.equal((await api(commentsUrl("Talk/draft", `&thread=${id2}`), { method: "DELETE" })).status, 404);
  assert.equal((await api(commentsUrl("Talk/draft"), { method: "DELETE" })).status, 400, "which thread");
  // The last one takes the sidecar with it.
  const beforeLast = storedManifest();
  assert.equal((await api(commentsUrl("Talk/draft", `&thread=${id}`), { method: "DELETE" })).status, 200);
  const afterLast = storedManifest();
  assert.equal(afterLast.seq, beforeLast.seq + 1);
  assert.equal(afterLast.files[metaFid], undefined, "no empty sidecar is left on anybody's disk");
  assert.equal(afterLast.tombstones[metaFid].path, "Talk/draft.meta.jsonl");
  assert.equal(textAt("Talk/draft.md"), DRAFT.replace("The crew is ready.", "The crew is rested."), "and the text is the text again");
  assert.deepEqual(await threads("Talk/draft"), []);

  // A thread written inline, the way the app wrote them before the sidecar:
  // read as it is, and normalized the first time it is changed.
  const inline = await threads("Talk/old");
  assert.deepEqual(inline, [
    { id: "old111", version: "md", on: "old words", line: 1, comments: [{ author: "Alice", at: Date.parse("2026-01-01T10:00:00Z"), body: "an inline thread" }] },
  ]);
  assert.equal((await say({ path: "Talk/old", thread: "old111", body: "Still here." })).json.comments, 2);
  assert.equal(textAt("Talk/old.md"), "Hello {==old words==}{>>#old111<<} there.\n", "the conversation moved out of the prose");
  assert.deepEqual(recordsOf(textAt("Talk/old.meta.jsonl"))[0].comments.map((c) => c.body), ["an inline thread", "Still here."]);
  assert.ok(settled("Talk/old"), "which is the migration the app itself would have made");
});

await test("comments: an html thread sits on the element whose text begins with the words — the innermost one — and lives wholly in the sidecar", async () => {
  const PAGE = [
    "<!doctype html>",
    "<html><head><title>Launch plan</title><style>p { color: red }</style></head>",
    "<body>",
    "<h1>Launch plan</h1>",
    "<ul>",
    "  <li><p>Paint the hull before June</p></li>",
    "  <li>Check the sails &amp; the rigging",
    "</ul>",
    "<p>Paint the hull twice.</p>",
    "<script>var hidden = 'Launch plan in a script';</script>",
    "</body></html>",
    "",
  ].join("\n");
  await freshWorkspace({
    "Talk/page.html": PAGE,
    "Talk/both.md": "# Both\n\nSome plain words in markdown.\n",
    "Talk/both.html": "<h1>Both</h1>\n<p>Some plain words on the page.</p>\n",
    "Talk/md-only.md": "# Markdown only\n",
  });
  const bot = await addAgent("Page reviewer", ["comment", "edit"]);
  const api = as(bot);
  const say = (body) => api("/api/agent/comments", { method: "POST", body });
  const threads = async (p) => (await api(commentsUrl(p))).json.threads;
  const start = storedManifest();
  const [htmlFid, htmlFile] = entryAt(start, "Talk/page.html");

  // An html-only document: the html is what a comment is on.
  const made = await say({ path: "Talk/page", on: "Paint the  hull before", body: "By when?" });
  assert.equal(made.status, 201);
  const id = made.json.thread;
  assert.deepEqual(made.json, { path: "Talk/page", thread: id, version: "html", on: "Paint the hull before June", tag: "p" }, "the paragraph, not the list item or the list around it");
  const one = storedManifest();
  assert.equal(one.seq, start.seq + 1);
  assert.deepEqual(one.files[htmlFid], htmlFile, "the page itself is not touched");
  const records = recordsOf(textAt("Talk/page.meta.jsonl"));
  assert.deepEqual(records.map((r) => [r.t, r.id, r.anchor, r.comments.map((c) => [c.author, c.body])]), [
    ["hthread", id, { path: "", tag: "p", text: "Paint the hull before June" }, [["Page reviewer", "By when?"]]],
  ]);
  assert.ok(settled("Talk/page", null), "a sidecar the app reads as its own");
  assert.deepEqual(await threads("Talk/page.html"), [
    { id, version: "html", on: "Paint the hull before June", tag: "p", comments: [{ author: "Page reviewer", at: records[0].comments[0].at, body: "By when?" }] },
  ]);

  // More than one element, or none: refused with the candidates.
  const two = await say({ path: "Talk/page", on: "Paint the hull", body: "?" });
  assert.deepEqual([two.status, two.json.code], [409, "anchor"]);
  assert.deepEqual(two.json.candidates, [
    { tag: "p", text: "Paint the hull before June" },
    { tag: "p", text: "Paint the hull twice." },
  ]);
  const none = await say({ path: "Talk/page", on: "Nothing like this", body: "?" });
  assert.deepEqual([none.status, none.json.code, none.json.candidates], [404, "anchor", []]);
  assert.equal((await say({ path: "Talk/page", on: "var hidden", body: "?" })).status, 404, "what nobody sees is not an element to comment on");
  assert.equal((await say({ path: "Talk/page", on: "p { color", body: "?" })).status, 404);
  assert.equal((await say({ path: "Talk/page", on: "Paint the hull before", body: "?", v: "md" })).status, 404, "it has no markdown version");
  assert.equal((await say({ path: "Talk/md-only", on: "Markdown", body: "?", v: "html" })).status, 404, "and this one no html");
  assert.equal(storedManifest().seq, one.seq);

  // A heading — its title and the script that repeats it are not it; and an
  // item nobody closed, with an entity in it.
  const heading = await say({ path: "Talk/page", on: "Launch plan", body: "Good title." });
  assert.deepEqual([heading.status, heading.json.tag, heading.json.on], [201, "h1", "Launch plan"]);
  const item = await say({ path: "Talk/page", on: "Check the sails & the", body: "Both?" });
  assert.deepEqual([item.status, item.json.tag, item.json.on], [201, "li", "Check the sails & the rigging"]);
  const dry = await say({ path: "Talk/page", on: "Paint the hull twice", body: "Twice?", dryRun: true });
  assert.deepEqual([dry.status, dry.json.tag, dry.json.written], [200, "p", false]);
  assert.equal((await threads("Talk/page")).length, 3);

  const reply = await say({ path: "Talk/page", thread: id, body: "By June." });
  assert.deepEqual(reply.json, { path: "Talk/page", thread: id, version: "html", comments: 2 });

  // The page is regenerated: a thread whose element is gone has lost its place, and says so.
  const without = PAGE.replace("  <li><p>Paint the hull before June</p></li>\n", "");
  assert.equal((await api(docUrl("Talk/page", "html"), { method: "PUT", body: without, headers: { "if-rev": "1" } })).status, 200);
  assert.deepEqual((await threads("Talk/page")).map((t) => [t.tag, t.orphaned ?? false]).sort(), [["h1", false], ["li", false], ["p", true]]);
  // …and finds it again when the element is back, wherever in the page it now is.
  const moved = PAGE.replace("<h1>Launch plan</h1>", "<h1>Launch plan</h1>\n<section><p>Paint the hull before June, weather allowing.</p></section>").replace("  <li><p>Paint the hull before June</p></li>\n", "");
  assert.equal((await api(docUrl("Talk/page", "html"), { method: "PUT", body: moved, headers: { "if-rev": "2" } })).status, 200);
  assert.deepEqual((await threads("Talk/page")).map((t) => t.orphaned ?? false), [false, false, false]);

  // Removing: the sidecar only, and the sidecar itself with the last one.
  const rm = await api(commentsUrl("Talk/page", `&thread=${id}`), { method: "DELETE" });
  assert.deepEqual(rm.json, { path: "Talk/page", thread: id, version: "html", removed: true });
  assert.equal((await api(commentsUrl("Talk/page", `&thread=${heading.json.thread}`), { method: "DELETE" })).status, 200);
  assert.equal((await api(commentsUrl("Talk/page", `&thread=${item.json.thread}`), { method: "DELETE" })).status, 200);
  assert.equal(entryAt(storedManifest(), "Talk/page.meta.jsonl"), undefined);
  assert.deepEqual(await threads("Talk/page"), []);

  // A document with both versions: the markdown unless html is said, and one list of threads.
  const onMd = await say({ path: "Talk/both", on: "Some plain words", body: "In the text." });
  assert.deepEqual([onMd.status, onMd.json.version, onMd.json.line], [201, "md", 3]);
  const onHtml = await say({ path: "Talk/both", on: "Some plain words", body: "On the page.", v: "html" });
  assert.deepEqual([onHtml.status, onHtml.json.version, onHtml.json.tag], [201, "html", "p"]);
  // The name it is typed under picks a version too, as it does for a read.
  const viaHtmlName = await say({ path: "Talk/both.html", on: "Both", body: "The heading of the page." });
  assert.deepEqual([viaHtmlName.status, viaHtmlName.json.version, viaHtmlName.json.tag, viaHtmlName.json.path], [201, "html", "h1", "Talk/both"]);
  const viaMdName = await say({ path: "Talk/both.md", on: "Both", body: "The heading of the text." });
  assert.deepEqual([viaMdName.status, viaMdName.json.version, viaMdName.json.line], [201, "md", 1]);
  assert.equal((await say({ path: "Talk/both.md", on: "Both", body: "?", v: "html" })).status, 400, "a flag that contradicts the name");
  assert.equal((await say({ path: "Talk/both.html", thread: onMd.json.thread, body: "A reply goes by its thread, whatever the name." })).json.version, "md");
  const all = await threads("Talk/both.html");
  assert.deepEqual(all.filter((t) => t.version === "md").map((t) => [t.on, t.line, t.comments.map((c) => c.body)]), [
    ["Both", 1, ["The heading of the text."]],
    ["Some plain words", 3, ["In the text.", "A reply goes by its thread, whatever the name."]],
  ], "the markdown's threads, in the order the text has them");
  assert.deepEqual(
    all.filter((t) => t.version === "html").map((t) => [t.tag, t.on, t.comments[0].body]).sort(),
    [["h1", "Both", "The heading of the page."], ["p", "Some plain words on the page.", "On the page."]],
    "then the page's — every thread on the document, whichever name it was asked by",
  );
  assert.deepEqual(recordsOf(textAt("Talk/both.meta.jsonl")).map((r) => r.t).sort(), ["hthread", "hthread", "mthread", "mthread"]);
  assert.ok(settled("Talk/both"));
  assert.equal((await api(docUrl("Talk/both", "", "&info=1"))).json.comments, 4);
  // The html version removed: its threads go with it, and the markdown's stay.
  assert.equal((await api(docUrl("Talk/both", "html"), { method: "DELETE" })).json.threadsRemoved, 2);
  assert.deepEqual((await threads("Talk/both")).map((t) => t.version), ["md", "md"]);
});

/* ---------- The document API: search ---------- */

const searchUrl = (q, more = "") => `/api/agent/search?q=${encodeURIComponent(q)}${more}`;
const mirrorEtag = () => db.value("SELECT etag FROM search_state WHERE key = 'mirror'");
/** Run something, counting the blobs the worker reads from the bucket meanwhile. */
const countingBlobReads = async (run) => {
  const realGet = fake.get.bind(fake);
  let reads = 0;
  fake.get = (key, opts) => {
    if (key.startsWith("blobs/")) reads += 1;
    return realGet(key, opts);
  };
  try {
    return { res: await run(), reads };
  } finally {
    delete fake.get;
  }
};

await test("search: nothing is mirrored until somebody searches; the first search reads the workspace in rounds one request can afford, answering 202 until it is whole", async () => {
  const files = {};
  for (let i = 1; i <= 50; i += 1) {
    const n = String(i).padStart(2, "0");
    files[`Lib/doc-${n}.md`] = `# Document ${n}\n\nEvery one has the word Shared.\nOnly this one says needle-${n}.\n`;
  }
  files["Lib/many.md"] = ["# Many", "", ...Array.from({ length: 7 }, (_, i) => `Ripple number ${i + 1}.`), ""].join("\n");
  files["Other/away.md"] = "# Away\n\nAlso shared, elsewhere.\n";
  await freshWorkspace(files);
  // A domain nobody has searched yet — what a new database, or a wipe, leaves.
  db.run("DELETE FROM search_text");
  db.run("DELETE FROM search_state");
  const bot = await addAgent("Searcher", ["edit"]);
  const api = as(bot);
  const found = async (q, more = "") => (await api(searchUrl(q, more))).json;

  // A write before anyone has searched starts no mirror: until somebody asks, it costs nothing.
  assert.equal((await api(docUrl("Lib/extra"), { method: "PUT", body: "# Extra\n\nA zebra crossing.\n" })).status, 201);
  assert.equal(db.value("SELECT COUNT(*) FROM search_state"), 0);
  assert.equal(db.value("SELECT COUNT(*) FROM search_text"), 0);
  const total = Object.keys(files).length + 1;
  // How many blobs one catch-up reads (search.ts, CATCH_UP_READS) — under the
  // fifty subrequests a Worker request may make, with room for the rest.
  const ROUND = 36;

  const first = await countingBlobReads(() => api(searchUrl("needle-07")));
  assert.equal(first.res.status, 202, "not an answer yet");
  assert.deepEqual(first.res.json, { indexing: true, pending: total - ROUND });
  assert.equal(first.reads, ROUND, "one round: what a request may read and still be one request");
  assert.equal(db.value("SELECT COUNT(*) FROM search_text"), ROUND);
  assert.equal(mirrorEtag(), "", "not whole yet, and it says so");
  const second = await countingBlobReads(() => api(searchUrl("needle-07")));
  assert.deepEqual(
    [second.res.status, second.res.json, second.reads],
    [202, { indexing: true, pending: 0 }, total - ROUND],
    "whole now — but this request spent its reads catching up, so the lines are cut on the next",
  );
  const third = await countingBlobReads(() => api(searchUrl("needle-07")));
  assert.equal(third.res.status, 200);
  assert.deepEqual(third.res.json, {
    query: "needle-07",
    dir: "",
    results: [{ path: "Lib/doc-07", version: "md", matches: [{ line: 4, text: "Only this one says needle-07." }] }],
    total: 1,
  });
  assert.equal(third.reads, 1, "the mirror said which document; one blob was read, to cut the line");
  assert.equal(db.value("SELECT COUNT(*) FROM search_text"), total, "one row a document");
  assert.equal(mirrorEtag(), etagNow());
  const [fid07] = entryAt(storedManifest(), "Lib/doc-07.md");
  assert.equal(db.value("SELECT folded FROM search_text WHERE fid = ?", fid07), files["Lib/doc-07.md"].toLowerCase(), "keyed by file id, lower-cased");
  assert.equal((await found("zebra")).results[0].path, "Lib/extra", "what was written before the first search was read with everything else");

  // The question the app's own search asks: which documents contain this, whatever the case — with the lines as written.
  const upper = await found("NEEDLE-07");
  assert.deepEqual([upper.query, upper.results], ["NEEDLE-07", third.res.json.results]);
  const shared = await countingBlobReads(() => api(searchUrl("shared")));
  assert.deepEqual([shared.res.json.total, shared.res.json.results.length, shared.res.json.truncated], [51, 20, true], "twenty documents unless asked");
  assert.equal(shared.reads, 20, "and only the ones shown are read");
  assert.deepEqual(shared.res.json.results.slice(0, 3).map((r) => r.path), ["Lib/doc-01", "Lib/doc-02", "Lib/doc-03"], "in the order a listing has them");
  assert.deepEqual(shared.res.json.results[0].matches, [{ line: 3, text: "Every one has the word Shared." }]);
  assert.equal((await found("shared", "&limit=5")).results.length, 5);
  assert.equal((await found("shared", "&limit=100")).results.length, 30, "thirty at most");
  assert.equal((await found("shared", "&limit=0")).results.length, 20);
  assert.equal((await found("shared", "&limit=lots")).results.length, 20);
  const nine = await found("needle-0");
  assert.deepEqual([nine.total, nine.results.length, nine.truncated], [9, 9, undefined]);
  const ripple = await found("ripple");
  assert.deepEqual(ripple.results, [
    {
      path: "Lib/many",
      version: "md",
      matches: [3, 4, 5, 6, 7].map((line) => ({ line, text: `Ripple number ${line - 2}.` })),
      moreLines: 2,
    },
  ]);

  // Under one folder.
  assert.deepEqual((await found("shared", "&dir=Other")).results.map((r) => r.path), ["Other/away"]);
  assert.equal((await found("shared", "&dir=lib")).total, 50, "a folder in whatever case");
  const away = await found("shared", "&dir=/Other/");
  assert.deepEqual([away.dir, away.total], ["Other", 1]);
  assert.deepEqual(await found("shared", "&dir=Nowhere"), { query: "shared", dir: "Nowhere", results: [], total: 0 });
  assert.equal((await api(searchUrl("shared", "&dir=.git"))).status, 400);
  assert.equal((await api("/api/agent/search")).status, 400, "say what to search for");
  assert.equal((await api(searchUrl("   "))).status, 400);
  assert.equal((await api(searchUrl("two\nlines"))).status, 400);
  assert.deepEqual(await found("nothing says this"), { query: "nothing says this", dir: "", results: [], total: 0 });
});

await test("search: an agent's change is mirrored in the request that made it; a Mac's by the next search; comments are searched, a move rewrites nothing, and what cannot be mirrored is said", async () => {
  await freshWorkspace({
    "Lib/alpha.md": "# Alpha\n\nThe first letter.\n",
    "Lib/beta.md": "# Beta\n\nOnly this one says needle.\n",
    "Lib/pair.md": "# Pair\n\nMarkdown side.\n",
    "Lib/pair.html": "<p>The quokka is only on the page.</p>\n",
    "Lib/page.html":
      "<html><head><title>Hidden title</title><style>p { color: teal }</style></head><body><h1>Sightings</h1><p>An <b>aardvark</b> sighting</p></body></html>\n",
    "Other/gamma.md": "# Gamma\n",
  });
  const bot = await addAgent("Keeper", ["comment", "edit"]);
  const api = as(bot);
  const found = async (q, more = "") => (await api(searchUrl(q, more))).json;

  // A handful of stale documents are read and answered in one request.
  const small = await countingBlobReads(() => api(searchUrl("needle")));
  assert.equal(small.res.status, 200, "no 202 for a small workspace");
  assert.deepEqual(small.res.json.results, [{ path: "Lib/beta", version: "md", matches: [{ line: 3, text: "Only this one says needle." }] }]);
  assert.equal(small.reads, 5 + 1, "five documents mirrored — the html beside a markdown is not one — and one line cut");
  assert.equal(db.value("SELECT COUNT(*) FROM search_text"), 5, "rows of documents that are gone were dropped in the same round");
  assert.equal(mirrorEtag(), etagNow());

  // An agent finds what it just wrote: the write itself caught the mirror up.
  assert.equal((await api(docUrl("Lib/new"), { method: "PUT", body: "# New\n\nA walrus on the ice.\n" })).status, 201);
  assert.equal(mirrorEtag(), etagNow(), "whole at the manifest the write left");
  const walrus = await countingBlobReads(() => api(searchUrl("walrus")));
  assert.deepEqual(walrus.res.json.results, [{ path: "Lib/new", version: "md", matches: [{ line: 3, text: "A walrus on the ice." }] }]);
  assert.equal(walrus.reads, 1, "nothing left to catch up");
  assert.equal((await api(docUrl("Lib/new"), { method: "PUT", body: "# New\n\nA narwhal instead.\n", headers: { "if-rev": "1" } })).status, 200);
  assert.equal((await found("walrus")).total, 0, "the old text is not found any more");
  assert.equal((await found("narwhal")).total, 1);

  // A Mac's save spends nothing on a mirror nobody may ask; the next search reads what it changed.
  const whole = mirrorEtag();
  await macWrite((m, put) => {
    put("Other/mac.md", "# From a Mac\n\nAn okapi in the garden.\n");
    put("Lib/alpha.md", "# Alpha\n\nNow about a lemur.\n");
  });
  assert.equal(mirrorEtag(), whole, "the manifest moved; the mirror was not touched");
  assert.notEqual(whole, etagNow());
  const okapi = await countingBlobReads(() => api(searchUrl("okapi")));
  assert.equal(okapi.res.status, 200);
  assert.deepEqual(okapi.res.json.results.map((r) => r.path), ["Other/mac"], "an edit made on a Mac is found after its sync");
  assert.equal(okapi.reads, 2 + 1, "the two documents that changed, and the line");
  assert.equal(mirrorEtag(), etagNow());
  assert.deepEqual([(await found("first letter")).total, (await found("lemur")).results[0].path], [0, "Lib/alpha"]);
  // More at once than a search answers inline: caught up, and asked again.
  await macWrite((m, put) => {
    for (let i = 1; i <= 9; i += 1) put(`Bulk/b${i}.md`, `# B${i}\n\nA heron by the water.\n`);
  });
  assert.deepEqual((await api(searchUrl("heron"))).json, { indexing: true, pending: 0 });
  assert.equal((await found("heron")).total, 9);

  // What was said about a document is searched with it — and a marker never splits a line.
  const said = await api("/api/agent/comments", { method: "POST", body: { path: "Lib/beta", on: "needle", body: "A platypus would say otherwise." } });
  assert.equal(said.status, 201);
  assert.ok(textAt("Lib/beta.md").includes("{==needle==}"));
  assert.deepEqual((await found("platypus")).results, [{ path: "Lib/beta", version: "md", matches: [], inComments: true }]);
  assert.deepEqual((await found("says needle.")).results, [{ path: "Lib/beta", version: "md", matches: [{ line: 3, text: "Only this one says needle." }] }]);
  assert.equal((await found("{==")).total, 0, "markers are not text");

  // A move changes no text: no document is read and no row rewritten.
  const [betaFid] = entryAt(storedManifest(), "Lib/beta.md");
  db.queries.length = 0;
  const moved = await countingBlobReads(() => api("/api/agent/move", { method: "POST", body: { from: "Lib/beta", to: "Archive/beta" } }));
  assert.equal(moved.res.status, 200);
  assert.equal(moved.reads, 0);
  assert.ok(!db.queries.some((sql) => /INTO search_text|DELETE FROM search_text/.test(sql)), "the mirror is keyed by file id, so a move costs it nothing");
  assert.equal(mirrorEtag(), etagNow(), "only the etag it is whole at moved on");
  assert.deepEqual((await found("platypus")).results.map((r) => r.path), ["Archive/beta"], "found where it now is");
  assert.deepEqual([(await found("platypus", "&dir=Lib")).total, (await found("platypus", "&dir=Archive")).total], [0, 1]);
  // A removal takes the row.
  assert.equal((await api(docUrl("Archive/beta"), { method: "DELETE" })).status, 200);
  assert.equal((await found("platypus")).total, 0);
  assert.equal(db.value("SELECT COUNT(*) FROM search_text WHERE fid = ?", betaFid), 0);

  // An html-only document is searched by what it says — not its markup, its style or its title.
  assert.deepEqual((await found("aardvark sighting")).results, [{ path: "Lib/page", version: "html", matches: [{ text: "An aardvark sighting" }] }]);
  assert.equal((await found("color: teal")).total, 0);
  assert.equal((await found("hidden title")).total, 0);
  assert.equal((await found("<b>")).total, 0);
  assert.equal((await api("/api/agent/comments", { method: "POST", body: { path: "Lib/page", on: "Sightings", body: "A capybara, surely." } })).status, 201);
  assert.deepEqual((await found("capybara")).results, [{ path: "Lib/page", version: "html", matches: [], inComments: true }]);
  // The html beside a markdown is that document's other version, not a text of its own…
  assert.equal((await found("quokka")).total, 0);
  // …until it is all the document has.
  assert.equal((await api(docUrl("Lib/pair", "md"), { method: "DELETE" })).status, 200);
  assert.deepEqual((await found("quokka")).results, [{ path: "Lib/pair", version: "html", matches: [{ text: "The quokka is only on the page." }] }]);
  assert.equal((await found("markdown side")).total, 0);

  // Too large to hold: listed as not searched, rather than silently never found.
  const huge = `# Huge\n\n${"leviathan ".repeat(110_000)}\n`;
  let hugeFid;
  await macWrite((m, put) => {
    hugeFid = put("Lib/huge.md", huge);
  });
  const big = await countingBlobReads(() => api(searchUrl("leviathan")));
  assert.deepEqual([big.res.status, big.res.json.total, big.res.json.results, big.res.json.notSearched], [200, 0, [], ["Lib/huge"]]);
  assert.equal(big.reads, 0, "and not read to find that out");
  assert.equal(db.value("SELECT folded IS NULL FROM search_text WHERE fid = ?", hugeFid), 1);
  assert.deepEqual((await found("narwhal")).notSearched, ["Lib/huge"], "whatever was asked");
  assert.equal((await found("okapi", "&dir=Other")).notSearched, undefined, "but only where the search looked");

  // A manifest ahead of one of its blobs — a sync still in flight: asked again, never answered short.
  const late = "# Late\n\nA dugong, eventually.\n";
  await macWrite((m) => {
    m.files["f-late00000001"] = { path: "Lib/late.md", rev: 1, hash: blobHash(late), size: late.length, mtime: Date.now(), by: ALICE.id };
  });
  assert.deepEqual((await api(searchUrl("dugong"))).json, { indexing: true, pending: 1 });
  const early = await api(docUrl("Lib/late"));
  assert.equal(early.status, 503, "and a read of it says to try again, rather than answering empty");
  assert.ok(/has not finished syncing/.test(early.json.error));
  assert.equal((await call(`/api/blobs/f-late00000001/${blobHash(late)}`, { method: "PUT", token: OWNER, body: late })).status, 200);
  assert.deepEqual((await found("dugong")).results.map((r) => r.path), ["Lib/late"]);

  // The mirror is derived, and the database's: when it cannot answer, search
  // says so — and a change is never failed for the mirror's sake.
  const flaky = {
    prepare(sql) {
      if (/search_/.test(sql)) throw new Error("D1_ERROR: no such table: search_state");
      return db.prepare(sql);
    },
    batch: (statements) => db.batch(statements),
    exec: (sql) => db.exec(sql),
  };
  const bindings = { OWNER_TOKEN: OWNER, DATA: fake, DB: flaky };
  const down = await api(searchUrl("narwhal"), { bindings });
  assert.equal(down.status, 503);
  assert.ok(/database/.test(down.json.error));
  const during = await api(docUrl("Lib/during"), { method: "PUT", body: "# During\n\nA manatee, written while search was down.\n", bindings });
  assert.equal(during.status, 201, "the write landed");
  assert.equal(textAt("Lib/during.md"), "# During\n\nA manatee, written while search was down.\n");
  assert.deepEqual((await found("manatee")).results.map((r) => r.path), ["Lib/during"], "and the next search that can, catches up");
});

/* ---------- The document API: boards ---------- */

const ROADMAP_DEF = [
  '{"doklin":"store","v":1,"name":"Roadmap"}',
  '{"t":"field","id":"due","name":"Due","type":"date"}',
  '{"t":"field","id":"owner","name":"Owner","type":"select"}',
  '{"t":"field","id":"status","name":"Status","type":"select"}',
  '{"t":"field","id":"tags","name":"Tags","type":"multi_select"}',
  '{"t":"option","field":"owner","name":"Ada","rank":"a0","color":"green"}',
  '{"t":"option","field":"status","name":"Backlog","rank":"a0","color":"grey"}',
  '{"t":"option","field":"status","name":"Done","rank":"a2","color":"green"}',
  '{"t":"option","field":"status","name":"In progress","rank":"a1","color":"blue"}',
  '{"t":"option","field":"tags","name":"hull","rank":"a0"}',
  '{"t":"option","field":"tags","name":"paint","rank":"a1","color":"red"}',
  '{"t":"view","id":"board","kind":"kanban","name":"Board","groupBy":"status"}',
  "",
].join("\n");
const IDEAS_DEF = '{"doklin":"store","v":1,"name":"Ideas"}\n{"t":"field","id":"status","name":"Status","type":"select"}\n{"t":"option","field":"status","name":"New","rank":"a0"}\n';
const SHIP = "---\nstatus: In progress\nowner: Ada\ntags: [hull]\nrank: a0\n---\nThe hull is done.\n";
const PAINT = "---\nstatus: Backlog\ntags: [paint, hull]\ndue: 2026-12-04\naliases: [Painting]\nrank: a1\n---\nAfter the hull.\n";
const LAUNCH = "---\nstatus: Done\nrank: a2\n---\nWe launched.\n";
/** A workspace with two boards in it, and what a board's folder holds that no agent should see. */
const BOARD_FILES = {
  "Projects/plan.md": "# Plan\n",
  "Projects/Roadmap/store.jsonl": ROADMAP_DEF,
  "Projects/Roadmap/Ship the boat.md": SHIP,
  "Projects/Roadmap/Paint it.md": PAINT,
  "Projects/Roadmap/Launch.md": LAUNCH,
  "Projects/Roadmap/Launch.html": "<p>An html rendition nobody shows.</p>",
  "Projects/Roadmap/pics/hull.png": PIXEL_PNG,
  "Projects/Roadmap/store (conflict — Alice, Sep 2 14.32).jsonl": ROADMAP_DEF,
  "Ideas.md": "# Ideas\n\n```kanban\nstore: ./Ideas\n```\n",
  "Ideas/store.jsonl": IDEAS_DEF,
  "Ideas/Teleporter.md": "---\nstatus: New\nrank: a0\n---\nBeam me up.\n",
  "Ideas/Jetpack.md": "Just a note in a board folder.\n",
};
const qs = (params) =>
  Object.entries(params)
    .flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => `${k}=${encodeURIComponent(x)}`))
    .join("&");
const boardApi = (api) => ({
  info: (path) => api(`/api/agent/board?${qs({ path })}`),
  show: (path, more = {}) => api(`/api/agent/cards?${qs({ path, ...more })}`),
  card: (path, card) => api(`/api/agent/card?${qs({ path, card })}`),
  make: (body) => api("/api/agent/board", { method: "POST", body }),
  add: (body) => api("/api/agent/card", { method: "POST", body }),
  set: (body) => api("/api/agent/card", { method: "PATCH", body }),
  rm: (path, card, more = {}) => api(`/api/agent/card?${qs({ path, card, ...more })}`, { method: "DELETE" }),
  field: (method, body) =>
    method === "DELETE" ? api(`/api/agent/field?${qs(body)}`, { method }) : api("/api/agent/field", { method, body }),
  option: (method, body) =>
    method === "DELETE" ? api(`/api/agent/option?${qs(body)}`, { method }) : api("/api/agent/option", { method, body }),
});
/** A new board's definition, as the app writes one (storeFile.ts, defaultStoreDef). */
const serializedDefault = (name) =>
  [
    `{"doklin":"store","v":1,"name":"${name}"}`,
    '{"t":"field","id":"status","name":"Status","type":"select"}',
    '{"t":"option","field":"status","name":"Backlog","rank":"a0","color":"grey"}',
    '{"t":"option","field":"status","name":"Done","rank":"a2","color":"green"}',
    '{"t":"option","field":"status","name":"In progress","rank":"a1","color":"blue"}',
    '{"t":"view","id":"board","kind":"kanban","name":"Board","groupBy":"status"}',
    "",
  ].join("\n");
/** Each column of a show as `name: titles`. */
const columnsOf = (show) => show.json.columns.map((c) => `${c.name}: ${c.cards.map((x) => x.title).join(", ")}`);

await test("boards: a board is one name — ls lists it as a board with its cards counted, never as a folder; --deep stops at it; nothing inside it can be named", async () => {
  await freshWorkspace(BOARD_FILES);
  const bot = await addAgent("Board reader", ["read"]);
  const api = as(bot);
  const tree = async (dir, deep = false) => (await api(`/api/agent/tree?${qs({ dir, ...(deep ? { deep: "1" } : {}) })}`)).json;

  const root = await tree("");
  assert.deepEqual(root.folders, ["Projects"]);
  assert.deepEqual(root.boards, [{ path: "Ideas", cards: 2 }], "a board beside a note of the same name is still a board");
  assert.deepEqual(root.documents.map((d) => d.path), ["Ideas"], "and the note is still a note");
  const projects = await tree("Projects");
  assert.deepEqual([projects.folders, projects.boards], [[], [{ path: "Projects/Roadmap", cards: 3 }]], "not a folder: a board, with three cards");
  const deep = await tree("", true);
  assert.deepEqual(deep.folders, ["Projects"], "--deep does not go inside a board…");
  assert.deepEqual(deep.boards.map((b) => b.path), ["Ideas", "Projects/Roadmap"]);
  assert.deepEqual(deep.documents.map((d) => d.path), ["Ideas", "Projects/plan"], "…so no card is a loose document");
  assert.deepEqual(deep.files, [], "and store.jsonl, its conflict copy and a picture in it are no files");

  for (const dir of ["Projects/Roadmap", "projects/roadmap", "Projects/Roadmap/pics"]) {
    const res = await api(`/api/agent/tree?${qs({ dir })}`);
    assert.equal(res.status, 400, dir);
    assert.equal(res.json.code, "board");
    assert.match(res.json.error, /^Projects\/Roadmap is a board, not a folder — see it with `doklin board show Projects\/Roadmap`$/);
  }
  // Inside a board, a name is a card or nothing.
  const read = (p, v = "") => api(docUrl(p, v));
  for (const p of ["Projects/Roadmap/store.jsonl", "Projects/Roadmap/pics/hull.png", "Projects/Roadmap/store (conflict — Alice, Sep 2 14.32).jsonl"]) {
    const res = await read(p);
    assert.equal(res.status, 400, p);
    assert.match(res.json.error, /is inside the board Projects\/Roadmap, which holds cards and nothing else/);
  }
  assert.equal((await read("Projects/Roadmap/Launch.html")).status, 400, "a card has no html version, whatever sits beside it");
  assert.equal((await read("Projects/Roadmap/Launch", "html")).status, 400);
  const missing = await read("Projects/Roadmap/Nope");
  assert.equal(missing.status, 404);
  assert.equal(missing.json.code, "no_card");
  const board = await read("Projects/Roadmap");
  assert.equal(board.status, 400, "a board named where a document was meant");
  assert.match(board.json.error, /Projects\/Roadmap is a board, not a document/);
  assert.equal((await api(`/api/agent/doc?path=Projects%2FRoadmap&info=1`)).status, 400);
  const asNote = await read("Ideas");
  assert.equal(asNote.status, 200, "a note beside its board is read as the note");
});

await test("boards: info and show — fields with their options in column order, cards in the columns the board's own view makes, --by and where; each card's block is read into the copy once", async () => {
  await freshWorkspace(BOARD_FILES);
  const bot = await addAgent("Board shower", ["read"]);
  const b = boardApi(as(bot));

  const info = await b.info("projects/roadmap");
  assert.equal(info.status, 200);
  assert.deepEqual(info.json, {
    board: "Projects/Roadmap",
    name: "Roadmap",
    cards: 3,
    by: "Status",
    fields: [
      { id: "due", name: "Due", type: "date" },
      { id: "owner", name: "Owner", type: "select", options: [{ name: "Ada", color: "green" }] },
      {
        id: "status",
        name: "Status",
        type: "select",
        options: [
          { name: "Backlog", color: "grey" },
          { name: "In progress", color: "blue" },
          { name: "Done", color: "green" },
        ],
      },
      { id: "tags", name: "Tags", type: "multi_select", options: [{ name: "hull" }, { name: "paint", color: "red" }] },
    ],
    conflicts: ["store (conflict — Alice, Sep 2 14.32).jsonl"],
  });
  assert.equal((await b.info("Projects")).status, 404, "a folder is not a board");
  assert.match((await b.info("Projects")).json.error, /^Projects is a folder, not a board/);
  assert.equal((await b.info("Nowhere")).status, 404);

  db.run("DELETE FROM board_cards");
  const first = await countingBlobReads(() => b.show("Projects/Roadmap"));
  assert.equal(first.res.status, 200);
  assert.equal(first.reads, 4, "the definition, and each card's block once");
  assert.equal(db.value("SELECT COUNT(*) FROM board_cards"), 3);
  const again = await countingBlobReads(() => b.show("Projects/Roadmap"));
  assert.equal(again.reads, 1, "then only the definition: the blocks come from the copy");
  assert.deepEqual(again.res.json, first.res.json);
  const show = first.res.json;
  assert.deepEqual(columnsOf(first.res), ["Backlog: Paint it", "In progress: Ship the boat", "Done: Launch"], "the empty No-status column is left out");
  assert.deepEqual(show.columns.map((c) => c.color), ["grey", "blue", "green"]);
  const ship = show.columns[1].cards[0];
  assert.deepEqual(ship.props, { Owner: "Ada", Status: "In progress", Tags: ["hull"] }, "by field name; rank never shown");
  assert.equal(ship.rev, 1);
  assert.equal(ship.by, ALICE.id);
  assert.deepEqual(show.columns[0].cards[0].props, { Due: "2026-12-04", Status: "Backlog", Tags: ["paint", "hull"] }, "an undeclared key is not a property of the board");

  assert.deepEqual(columnsOf(await b.show("Projects/Roadmap", { by: "tags" })), ["No tags: Launch", "hull: Ship the boat, Paint it", "paint: Paint it"], "a multi-select card sits in a column per value");
  assert.deepEqual(columnsOf(await b.show("Projects/Roadmap", { by: "Owner" })), ["No owner: Paint it, Launch", "Ada: Ship the boat"]);
  assert.deepEqual(columnsOf(await b.show("Projects/Roadmap", { by: "due" })), ["No due: Ship the boat, Launch", "2026-12-04: Paint it"]);
  const notDone = await b.show("Projects/Roadmap", { where: "status!=Done" });
  assert.deepEqual([columnsOf(notDone), notDone.json.shown], [["Backlog: Paint it", "In progress: Ship the boat", "Done: "], 2], "a declared column stays, empty");
  assert.deepEqual(columnsOf(await b.show("Projects/Roadmap", { where: ["tags=HULL", "due="] })), ["Backlog: ", "In progress: Ship the boat", "Done: "], "conditions are ANDed; = is carries, any case; field= is empty");
  assert.equal((await b.show("Projects/Roadmap", { by: "Nope" })).status, 404);
  assert.equal((await b.show("Projects/Roadmap", { where: "nope=1" })).json.code, "no_field");
  assert.equal((await b.show("Projects/Roadmap", { where: "status" })).status, 400);

  // A board with no field to group by is a list in board order; a card without frontmatter is a card.
  db.run("DELETE FROM board_cards");
  const ideas = await b.show("Ideas");
  assert.deepEqual(columnsOf(ideas), ["No status: Jetpack", "New: Teleporter"]);
  // A sync conflict copy of a card is a card, and says so.
  await macWrite((m, put) => put("Ideas/Teleporter (conflict — Ada, Sep 2 14.32).md", "---\nstatus: New\n---\nBeam me sideways.\n"));
  const copies = (await b.show("Ideas")).json.columns[1].cards;
  assert.deepEqual(copies.map((c) => [c.title, c.conflict ?? false]), [["Teleporter", false], ["Teleporter (conflict — Ada, Sep 2 14.32)", true]]);
});

await test("boards: a card is its properties and its page — read leaves the properties out, a write keeps them as they are at that moment, comments count lines from the page", async () => {
  await freshWorkspace(BOARD_FILES);
  const bot = await addAgent("Card editor", ["edit", "comment"]);
  const api = as(bot);
  const b = boardApi(api);

  const card = await b.card("Projects/Roadmap", "paint IT");
  assert.equal(card.status, 200);
  assert.deepEqual(
    { ...card.json, changed: undefined },
    {
      board: "Projects/Roadmap",
      title: "Paint it",
      path: "Projects/Roadmap/Paint it",
      rev: 1,
      changed: undefined,
      by: ALICE.id,
      byName: "Alice",
      size: PAINT.length,
      props: { Due: "2026-12-04", Status: "Backlog", Tags: ["paint", "hull"] },
      other: { aliases: ["Painting"] },
      comments: 0,
      page: "After the hull.\n",
    },
  );
  assert.equal((await b.card("Projects/Roadmap", "Nope")).status, 404);

  const page = await api(docUrl("Projects/Roadmap/Paint it"));
  assert.equal(page.text, "After the hull.\n", "the page, without the block above it");
  assert.equal(decodeURIComponent(page.headers.get("x-doklin-board")), "Projects/Roadmap");
  assert.deepEqual(readHead(page), { kind: "document", path: "Projects/Roadmap/Paint it", file: "Projects/Roadmap/Paint it.md", version: "md", rev: 1 });
  const info = (await api(`/api/agent/doc?path=${encodeURIComponent("Projects/Roadmap/Paint it")}&info=1`)).json;
  assert.equal(info.board, "Projects/Roadmap");

  // The page is written; the block stays what it is on disk now — not what it was when the page was read.
  const moved = await b.set({ path: "Projects/Roadmap", card: "Paint it", set: ["owner=ada"] });
  assert.equal(moved.status, 200, moved.text);
  const stale = await api(docUrl("Projects/Roadmap/Paint it"), { method: "PUT", body: "Two coats.\n", headers: { "if-rev": "1" } });
  assert.equal(stale.status, 409, "the card moved on since it was read");
  const wrote = await api(docUrl("Projects/Roadmap/Paint it"), { method: "PUT", body: "Two coats.\n", headers: { "if-rev": String(moved.json.rev) } });
  assert.equal(wrote.status, 200, wrote.text);
  assert.equal(wrote.json.board, "Projects/Roadmap");
  assert.equal(textAt("Projects/Roadmap/Paint it.md"), "---\ndue: 2026-12-04\nowner: Ada\nstatus: Backlog\ntags: [paint, hull]\nrank: a1\naliases: [Painting]\n---\nTwo coats.\n");
  // The same through Jetpack, a card with no properties at all: nothing grows a block.
  const jet = await api(docUrl("Ideas/Jetpack"), { method: "PUT", body: "Rewritten.\n", headers: { "if-rev": "1" } });
  assert.equal(jet.status, 200);
  assert.equal(textAt("Ideas/Jetpack.md"), "Rewritten.\n");

  const sneaky = await api(docUrl("Projects/Roadmap/Launch"), { method: "PUT", body: "---\nstatus: Backlog\n---\nHa.\n", headers: { "if-rev": "1" } });
  assert.equal(sneaky.status, 400, "a page may not carry properties of its own");
  assert.match(sneaky.json.error, /set its properties with `doklin board set Projects\/Roadmap "Launch" <field>=<value>`/);
  const fresh = await api(docUrl("Projects/Roadmap/New card"), { method: "PUT", body: "Hello.\n" });
  assert.equal(fresh.status, 400, "a card is made on the board");
  assert.match(fresh.json.error, /add a card to it with `doklin board add Projects\/Roadmap "New card"`/);
  assert.equal((await api(docUrl("Projects/Roadmap/pics/new.png"), { method: "PUT", body: "x" })).status, 400, "and nothing else goes in");
  assert.equal((await api(docUrl("Projects/Roadmap/Launch", "html"), { method: "PUT", body: "<p>x</p>" })).status, 400);
  const edit = await api(docUrl("Projects/Roadmap/Launch"), { method: "DELETE" });
  assert.equal(edit.status, 400);
  assert.match(edit.json.error, /remove it with `doklin board rm Projects\/Roadmap "Launch"`/);

  // Comments: on the page, numbered from its first line.
  const started = await api("/api/agent/comments", { method: "POST", body: { path: "Projects/Roadmap/Paint it", on: "Two coats", body: "Three?" } });
  assert.equal(started.status, 201, started.text);
  assert.equal(started.json.line, 1);
  assert.ok(textAt("Projects/Roadmap/Paint it.md").startsWith("---\ndue: 2026-12-04\nowner: Ada\nstatus: Backlog\n"), "the block is untouched");
  assert.ok(textAt("Projects/Roadmap/Paint it.md").endsWith(`---\n{==Two coats==}{>>#${started.json.thread}<<}.\n`));
  const threads = (await api(commentsUrl("Projects/Roadmap/Paint it"))).json;
  assert.deepEqual([threads.board, threads.threads.map((t) => [t.on, t.line])], ["Projects/Roadmap", [["Two coats", 1]]]);
  const inBlock = await api("/api/agent/comments", { method: "POST", body: { path: "Projects/Roadmap/Paint it", on: "Backlog", body: "No." } });
  assert.equal(inBlock.status, 404, "the properties are not words on the page");
  assert.equal((await b.card("Projects/Roadmap", "Paint it")).json.comments, 1);

  // Moving: a card stays on its board; nothing moves in; the board moves whole and keeps its name in step.
  const mv = (from, to) => api("/api/agent/move", { method: "POST", body: { from, to } });
  const cardMove = await mv("Projects/Roadmap/Launch", "Projects/Launch");
  assert.equal(cardMove.status, 400);
  assert.match(cardMove.json.error, /rename it with `doklin board set Projects\/Roadmap "Launch" --title "<new title>"`/);
  assert.equal((await mv("Projects/plan", "Projects/Roadmap")).status, 400, "into a board: refused");
  assert.match((await mv("Projects/plan", "Projects/Roadmap/plan")).json.error, /nothing moves into a board/);
  assert.equal((await mv("Projects/Roadmap/pics/", "Projects/pics")).status, 400, "what is inside a board stays inside");
  const whole = await mv("Projects/Roadmap", "Projects/Q4");
  assert.equal(whole.status, 200, whole.text);
  assert.deepEqual([whole.json.kind, whole.json.from, whole.json.to, whole.json.name], ["board", "Projects/Roadmap", "Projects/Q4", "Q4"]);
  assert.ok(textAt("Projects/Q4/store.jsonl").startsWith('{"doklin":"store","v":1,"name":"Q4"}\n'), "the name it was made with followed the folder");
  assert.equal(textAt("Projects/Q4/pics/hull.png") !== undefined, true, "everything in it went too");
  assert.equal((await b.info("Projects/Q4")).json.name, "Q4");
  await api("/api/agent/board", { method: "POST", body: { path: "Away", name: "Something else" } });
  const named = await mv("Away", "Elsewhere");
  assert.equal(named.json.name, undefined, "a board called something of its own keeps it");
  assert.equal((await b.info("Elsewhere")).json.name, "Something else");

  // Search finds a card by its page and says whose it is — never by its properties.
  const searched = async (q) => {
    for (;;) {
      const res = await api(searchUrl(q));
      if (res.status !== 202) return res.json;
    }
  };
  assert.deepEqual((await searched("two coats")).results, [{ path: "Projects/Q4/Paint it", board: "Projects/Q4", version: "md", matches: [{ line: 1, text: "Two coats." }] }]);
  assert.deepEqual((await searched("in progress")).results, [], "a value is not text on a page");
  assert.deepEqual((await searched("nobody shows")).results, [], "and what else is in a board's folder is not a document");
});

await test("boards: add, set and rm — a value is read against its field's type, an unknown field or option is refused with what there is, a title is unique, and a card that changes column goes to its foot", async () => {
  await freshWorkspace(BOARD_FILES);
  const bot = await addAgent("Card maker", ["edit"]);
  const b = boardApi(as(bot));
  const R = "Projects/Roadmap";

  const added = await b.add({ path: R, title: "Rig: the mast", set: ["status=backlog", "tags=PAINT, hull", "due=2026-12-24"], page: "Tall.\n" });
  assert.equal(added.status, 201, added.text);
  assert.deepEqual(added.json, {
    board: R,
    title: "Rig- the mast",
    path: `${R}/Rig- the mast`,
    rev: 1,
    props: { Due: "2026-12-24", Status: "Backlog", Tags: ["paint", "hull"] },
    created: true,
  });
  assert.equal(
    textAt(`${R}/Rig- the mast.md`),
    "---\ndue: 2026-12-24\nstatus: Backlog\ntags: [paint, hull]\nrank: a3\n---\nTall.\n",
    "the app's own bytes: fields in the order the definition holds them (by id), the declared spelling, a rank after every card's",
  );
  assert.deepEqual(columnsOf(await b.show(R)), ["Backlog: Paint it, Rig- the mast", "In progress: Ship the boat", "Done: Launch"]);
  const top = await b.add({ path: R, title: "Scrub the deck", set: ["status=Backlog"], first: true });
  assert.equal(top.status, 201);
  assert.deepEqual(columnsOf(await b.show(R))[0], "Backlog: Scrub the deck, Paint it, Rig- the mast");

  const refusal = async (res, status, code) => {
    assert.equal(res.status, status, res.text);
    if (code) assert.equal(res.json.code, code);
    return res.json;
  };
  const taken = await refusal(await b.add({ path: R, title: "ship THE boat" }), 409, "taken");
  assert.match(taken.error, /already has a card called "Ship the boat"/);
  const noOption = await refusal(await b.add({ path: R, title: "X", set: ["status=Someday"] }), 404, "no_option");
  assert.deepEqual(noOption.options, ["Backlog", "In progress", "Done"]);
  assert.match(noOption.error, /Add one with `doklin board option add Projects\/Roadmap "Status" "Someday"`/);
  const noField = await refusal(await b.add({ path: R, title: "X", set: ["Priority=High"] }), 404, "no_field");
  assert.deepEqual(noField.fields, ["Due", "Owner", "Status", "Tags"]);
  await refusal(await b.add({ path: R, title: "X", set: ["due=12/24/2026"] }), 400);
  await refusal(await b.add({ path: R, title: "X", set: ["due=2026-02-30"] }), 400);
  await refusal(await b.add({ path: R, title: "X", set: ["owner+=Ada"] }), 400);
  await refusal(await b.add({ path: R, title: "X", set: ["rank=a0"] }), 400);
  await refusal(await b.add({ path: R, title: "X", set: ["status"] }), 400);
  await refusal(await b.add({ path: R, title: "  " }), 400);
  await refusal(await b.add({ path: R, title: "X", page: "---\nstatus: Done\n---\n" }), 400);
  await refusal(await b.add({ path: R, title: ".hidden" }), 400);
  const before = etagNow();
  const dry = await b.add({ path: R, title: "Dry", set: ["status=Done"], dryRun: true });
  assert.equal(dry.status, 200);
  assert.equal(etagNow(), before, "a dry run writes nothing");

  // Setting: one property, the rest as it was; a column change goes to the foot unless told where.
  const done = await b.set({ path: R, card: "paint it", set: ["status=Done"] });
  assert.equal(done.status, 200, done.text);
  assert.deepEqual(columnsOf(await b.show(R)).slice(1), ["In progress: Ship the boat", "Done: Launch, Paint it"]);
  assert.equal(
    textAt(`${R}/Paint it.md`),
    "---\ndue: 2026-12-04\nstatus: Done\ntags: [paint, hull]\nrank: a4\naliases: [Painting]\n---\nAfter the hull.\n",
    "a key the board does not declare is kept, after the ones it does",
  );
  await b.set({ path: R, card: "Paint it", set: ["status=Done"], before: "Launch" });
  assert.deepEqual(columnsOf(await b.show(R))[2], "Done: Paint it, Launch");
  const rankOf = (title) => /rank: (\S+)/.exec(textAt(`${R}/${title}.md`))[1];
  const shipRank = rankOf("Ship the boat");
  await b.set({ path: R, card: "Ship the boat", set: ["tags+=paint", "tags+=HULL", "due=2027-01-01"] });
  assert.equal(rankOf("Ship the boat"), shipRank, "a card that stays in its column stays where it is");
  assert.match(textAt(`${R}/Ship the boat.md`), /^---\ndue: 2027-01-01\nowner: Ada\nstatus: In progress\ntags: \[hull, paint\]\nrank: /);
  await b.set({ path: R, card: "Ship the boat", set: ["tags-=hull", "due=", "owner="] });
  assert.match(textAt(`${R}/Ship the boat.md`), /^---\nstatus: In progress\ntags: \[paint\]\nrank: /);
  await refusal(await b.set({ path: R, card: "Ship the boat", before: "Ship the boat" }), 400);
  await refusal(await b.set({ path: R, card: "Ship the boat", before: "Nope" }), 404);
  await refusal(await b.set({ path: R, card: "Ship the boat", first: true, last: true }), 400);
  await refusal(await b.set({ path: R, card: "Ship the boat" }), 400);
  await refusal(await b.set({ path: R, card: "Nope", set: ["status=Done"] }), 404, "no_card");
  const same = await b.set({ path: R, card: "Launch", set: ["status=Done"] });
  assert.equal(same.json.changed, false, "a value it already has writes nothing");
  // Unranked cards — made by some other tool — sort after; nothing can go next to one.
  const jet = await b.set({ path: "Ideas", card: "Teleporter", after: "Jetpack" });
  assert.equal(jet.status, 409);
  const given = await b.set({ path: "Ideas", card: "jetpack", set: ["status=New"] });
  assert.equal(given.status, 200, given.text);
  assert.equal(textAt("Ideas/Jetpack.md"), "---\nstatus: New\nrank: a1\n---\nJust a note in a board folder.\n", "a note grows a block when it is given properties");

  // A new title: the file, its comments and its html rendition move together; a taken one is refused.
  await macWrite((m, put) => put(`${R}/Launch.meta.jsonl`, sidecar({ t: "mthread", id: "k1", comments: [{ author: "Ada", at: 1757000000000, body: "When?" }] })));
  const retitled = await b.set({ path: R, card: "Launch", title: "Launched" });
  assert.equal(retitled.status, 200, retitled.text);
  assert.deepEqual(retitled.json.renamed, { from: "Launch", to: "Launched" });
  const paths = pathsOf(storedManifest()).filter((p) => p.startsWith(`${R}/Launch`));
  assert.deepEqual(paths, [`${R}/Launched.html`, `${R}/Launched.md`, `${R}/Launched.meta.jsonl`]);
  await refusal(await b.set({ path: R, card: "Launched", title: "Paint it" }), 409, "taken");

  // Removing: the card with what the app trashes beside it, as one write.
  const gone = await b.rm(R, "launched");
  assert.equal(gone.status, 200, gone.text);
  assert.deepEqual(gone.json, { board: R, title: "Launched", path: `${R}/Launched`, stillPublic: [] });
  assert.deepEqual(pathsOf(storedManifest()).filter((p) => p.startsWith(`${R}/Launched`)), []);
  assert.equal(Object.values(storedManifest().tombstones).filter((t) => t.path.startsWith(`${R}/Launched`)).length, 3, "tombstones, so a Mac moves its copies to the Trash");
  assert.equal((await b.rm(R, "Launched")).status, 404);

  // Permissions: reading is read, everything else is edit.
  const reader = boardApi(as(await addAgent("Looker", ["read", "comment"])));
  assert.equal((await reader.show(R)).status, 200);
  assert.equal((await reader.add({ path: R, title: "Nope" })).status, 403);
  assert.equal((await reader.set({ path: R, card: "Paint it", set: ["status=Backlog"] })).status, 403);
});

await test("boards: new, fields and options — a board starts with the app's columns; a field's id is slugged once; renaming an option rewrites its cards a round at a time, and asking again finishes", async () => {
  await freshWorkspace(BOARD_FILES);
  const bot = await addAgent("Board keeper", ["edit"]);
  const b = boardApi(as(bot));

  const made = await b.make({ path: "work/sprint" });
  assert.equal(made.status, 201, made.text);
  assert.deepEqual([made.json.board, made.json.name], ["work/sprint", "sprint"]);
  assert.equal(textAt("work/sprint/store.jsonl").split("\n")[0], '{"doklin":"store","v":1,"name":"sprint"}');
  assert.deepEqual(columnsOf(await b.show("work/sprint")), ["Backlog: ", "In progress: ", "Done: "]);
  assert.equal((await b.make({ path: "Projects" })).status, 409, "a folder that exists");
  assert.equal((await b.make({ path: "Projects/Roadmap" })).status, 409, "a board that exists");
  assert.equal((await b.make({ path: "Projects/Roadmap/Inner" })).status, 409, "inside a board");
  assert.equal((await b.make({ path: "Projects/plan.md" })).status, 409, "a file in the way");
  assert.equal((await b.make({ path: "PROJECTS/Later", name: "Later on" })).json.board, "Projects/Later", "folders spelled as the workspace spells them");

  const R = "Projects/Roadmap";
  const field = await b.field("POST", { path: R, name: "Priority level", type: "select", options: "High, low, high, Medium" });
  assert.equal(field.status, 201, field.text);
  assert.deepEqual(field.json.field, { id: "priority_level", name: "Priority level", type: "select", options: [{ name: "High" }, { name: "low" }, { name: "Medium" }] });
  assert.equal((await b.field("POST", { path: R, name: "priority LEVEL", type: "text" })).status, 409);
  assert.equal((await b.field("POST", { path: R, name: "Rank", type: "text" })).status, 400);
  assert.equal((await b.field("POST", { path: R, name: "Notes", type: "text", options: ["a"] })).status, 400);
  assert.equal((await b.field("POST", { path: R, name: "Notes", type: "rich" })).status, 400);
  assert.equal((await b.field("POST", { path: R, name: "Done?", type: "checkbox" })).json.field.id, "done");
  assert.equal((await b.add({ path: R, title: "Check", set: ["done?=TRUE", "priority level=medium"] })).status, 201);
  assert.match(textAt(`${R}/Check.md`), /^---\ndone: true\npriority_level: Medium\nrank: /);
  const renamed = await b.field("PATCH", { path: R, field: "priority_level", name: "Urgency" });
  assert.deepEqual([renamed.json.field.id, renamed.json.field.name], ["priority_level", "Urgency"], "the key in every card stays");
  assert.deepEqual((await b.card(R, "Check")).json.props, { "Done?": true, Urgency: "Medium" });

  const option = await b.option("POST", { path: R, field: "status", name: "Review", color: "Purple", before: "done" });
  assert.equal(option.status, 201, option.text);
  assert.deepEqual(option.json.options.map((o) => o.name), ["Backlog", "In progress", "Review", "Done"]);
  assert.equal((await b.option("POST", { path: R, field: "status", name: "review" })).status, 409);
  assert.equal((await b.option("POST", { path: R, field: "status", name: "X", color: "teal" })).status, 400);
  assert.equal((await b.option("POST", { path: R, field: "due", name: "Soon" })).status, 400, "a date's columns are its dates");
  const recolored = await b.option("PATCH", { path: R, field: "status", option: "review", color: "none", first: true });
  assert.deepEqual(recolored.json.options[0], { name: "Review" });

  // An option rename is every card carrying it — in rounds a request can afford.
  const cards = {};
  // Ranks a1 … aU: one digit each, so their order is the cards' (rank.ts).
  for (let i = 1; i <= 30; i += 1) cards[`Sprint/Card ${String(i).padStart(2, "0")}.md`] = `---\nstatus: Backlog\nrank: a${"123456789ABCDEFGHIJKLMNOPQRSTU"[i - 1]}\n---\n`;
  await freshWorkspace({ "Sprint/store.jsonl": serializedDefault("Sprint"), ...cards });
  db.run("DELETE FROM board_cards");
  const rounds = [];
  for (;;) {
    const res = await b.option("PATCH", { path: "Sprint", field: "Status", option: "Backlog", name: "To do" });
    rounds.push([res.status, res.json.cards, res.json.pending ?? 0]);
    if (res.status !== 202 || rounds.length > 10) break;
  }
  assert.deepEqual(rounds.at(-1)[0], 200, JSON.stringify(rounds));
  assert.ok(rounds.length > 1, "more than one request's worth");
  assert.equal(rounds.reduce((n, r) => n + (r[1] ?? 0), 0), 30, "each card rewritten once");
  assert.ok(Object.keys(cards).every((p) => textAt(p).startsWith("---\nstatus: To do\n")));
  assert.deepEqual(columnsOf(await b.show("Sprint")).slice(0, 1), [`To do: ${Object.keys(cards).map((p) => p.slice(7, -3)).join(", ")}`]);

  // Removing an option or a field touches no card: the value stays, and shows as what it is.
  const before = textAt("Sprint/Card 01.md");
  assert.equal((await b.option("DELETE", { path: "Sprint", field: "status", option: "to do" })).status, 200);
  assert.equal(textAt("Sprint/Card 01.md"), before);
  assert.deepEqual((await b.show("Sprint")).json.columns.map((c) => [c.name, c.cards.length]), [["In progress", 0], ["Done", 0], ["To do", 30]], "a value nothing declares is a column of its own, last");
  assert.equal((await b.field("DELETE", { path: "Sprint", field: "Status" })).status, 200);
  assert.equal(textAt("Sprint/Card 01.md"), before);
  assert.deepEqual((await b.card("Sprint", "Card 01")).json.other, { status: "To do" }, "an undeclared key is kept, and shown as what it is");
});

await test("boards: a big board is read into the copy in rounds a request can afford — 202 with what is left, until it is whole", async () => {
  const files = { "Big/store.jsonl": serializedDefault("Big") };
  for (let i = 1; i <= 70; i += 1) files[`Big/Card ${String(i).padStart(2, "0")}.md`] = `---\nstatus: Done\nrank: a${String(i).padStart(2, "0")}\n---\n`;
  await freshWorkspace(files);
  db.run("DELETE FROM board_cards");
  const b = boardApi(as(await addAgent("Big reader", ["read"])));
  const first = await countingBlobReads(() => b.show("Big"));
  assert.deepEqual([first.res.status, first.res.json], [202, { indexing: true, pending: 38 }]);
  assert.equal(first.reads, 33, "the definition and 32 cards — well under a request's fifty");
  const second = await b.show("Big");
  assert.deepEqual([second.status, second.json], [202, { indexing: true, pending: 6 }]);
  const third = await b.show("Big");
  assert.equal(third.status, 200);
  assert.equal(third.json.columns.find((c) => c.name === "Done").cards.length, 70);
  assert.equal((await b.info("Big")).json.cards, 70, "info counts from the manifest, and reads no card");
});

/* ---------- Who an `a-` id is ---------- */

await test("directory: /api/meta names agents beside people, so every Mac can put a name to what an agent changed", async () => {
  await freshWorkspace({ "Dir/note.md": "# Note\n\nSome plain words.\n" });
  const bot = await addAgent("Grok bot", ["comment", "edit", "publish"]);
  const api = as(bot);
  assert.equal((await api(docUrl("Dir/by-bot"), { method: "PUT", body: "# By the bot\n" })).status, 201);
  assert.equal((await api(docUrl("Dir/note"), { method: "PUT", body: "# Note\n\nSome plain words, edited.\n", headers: { "if-rev": "1" } })).status, 200);
  assert.equal((await api("/api/agent/comments", { method: "POST", body: { path: "Dir/note", on: "plain words", body: "Mine." } })).status, 201);
  assert.equal((await api("/api/agent/pages", { method: "PUT", body: { path: "Dir/note", slug: "dir-note" } })).status, 201);
  assert.equal((await api(docUrl("Dir/by-bot"), { method: "DELETE" })).status, 200);

  // Everything it changed is signed with its id — never its name, which can change.
  const m = storedManifest();
  assert.equal(entryAt(m, "Dir/note.md")[1].by, bot.id);
  assert.equal(entryAt(m, "Dir/note.meta.jsonl")[1].by, bot.id);
  assert.equal(m.public["dir-note"].by, bot.id);
  assert.ok(Object.values(m.tombstones).some((t) => t.path === "Dir/by-bot.md" && t.by === bot.id));
  assert.ok(!JSON.stringify(m).includes("Grok bot"));

  // The directory every Mac already asks for resolves it.
  const asMember = (await call("/api/meta", { token: MEMBER })).json;
  assert.ok(asMember.people.some((p) => p.id === bot.id && p.name === "Grok bot"));
  assert.deepEqual([...new Set(asMember.people.map((p) => Object.keys(p).sort().join(",")))], ["id,name"], "a name, and nothing about what it may do");
  const firstAgent = asMember.people.findIndex((p) => p.id.startsWith("a-"));
  assert.ok(firstAgent > 0 && asMember.people.slice(0, firstAgent).every((p) => /^m-/.test(p.id)), "people first");
  assert.ok(asMember.people.slice(firstAgent).every((p) => /^a-[a-f0-9]{8}$/.test(p.id)), "then agents");
  assert.deepEqual((await call("/api/meta", { token: OWNER })).json.people, asMember.people, "the same list, whoever asks");
  assert.equal((await api(docUrl("Dir/note", "", "&info=1"))).json.md.byName, "Grok bot", "and the document API says it back by name");

  // A rename shows everywhere at once, because nothing stored the name…
  await call(`/api/auth/agents/${bot.id}`, { method: "POST", token: OWNER, body: { name: "Grok, renamed" } });
  assert.equal((await call("/api/meta", { token: MEMBER })).json.people.find((p) => p.id === bot.id).name, "Grok, renamed");
  assert.equal((await api("/api/agent/pages")).json.pages[0].byName, "Grok, renamed");
  // …except a comment, which is signed the way a person's is: with the name it was said under.
  assert.equal((await api(commentsUrl("Dir/note"))).json.threads[0].comments[0].author, "Grok bot");

  // Removed, it is nobody: what it wrote keeps the id, legible and never wrong.
  await call(`/api/auth/agents/${bot.id}`, { method: "DELETE", token: OWNER });
  assert.ok(!(await call("/api/meta", { token: MEMBER })).json.people.some((p) => p.id === bot.id));
  assert.equal(entryAt(storedManifest(), "Dir/note.md")[1].by, bot.id);
  const reader = await addAgent("Reader", []);
  const info = (await as(reader)(docUrl("Dir/note", "", "&info=1"))).json;
  assert.deepEqual([info.md.by, info.md.byName], [bot.id, undefined]);
});

// Destroys all state — keep this last.
await test("wipe: owner-only, confirmed, empties the bucket and frees the domain for a new binding", async () => {
  const member = await call("/api/admin/wipe", { method: "POST", token: MEMBER, body: { confirm: "wipe" } });
  assert.equal(member.status, 403);
  assert.equal((await call("/api/admin/wipe", { method: "POST", token: OWNER, body: {} })).status, 400);
  assert.equal((await call("/api/admin/wipe", { token: OWNER })).status, 405);
  assert.ok(fake.store.size > 0, "there is data to wipe");
  assert.ok([...fake.store.keys()].some((k) => k.startsWith("versions/")), "the version store is in the bucket");
  // An agent, a login code nobody has used, and a search mirror: all of it is the domain's.
  const doomed = await addAgent("Doomed", ["edit"]);
  const unusedBody = nextCodeBody();
  assert.equal((await newCode(doomed.id, unusedBody)).status, 201);
  assert.equal((await as(doomed)(searchUrl("anything"))).status, 200);
  for (const table of ["agents", "agent_tokens", "agent_codes", "search_text", "search_state"]) {
    assert.ok(db.value(`SELECT COUNT(*) FROM ${table}`) > 0, `${table} holds something to wipe`);
  }
  assert.equal((await as(doomed)("/api/admin/wipe", { method: "POST", body: { confirm: "wipe" } })).status, 403, "never an agent's to do");
  assert.ok(db.value("SELECT COUNT(*) FROM removed_tokens") > 0, "credentials were taken away along the way");

  const res = await call("/api/admin/wipe", { method: "POST", token: OWNER, body: { confirm: "wipe" } });
  assert.equal(res.status, 200);
  assert.equal(res.json.remaining, false);
  assert.ok(res.json.purged > 0);
  assert.equal(fake.store.size, 0, "the bucket is completely empty — the version store included");

  // Every person the domain knew goes with it. The owner secret lives in the
  // worker's env, so the owner can still talk to the (now free) domain — the
  // same asymmetry that keeps a D1 outage from locking them out.
  assert.equal(db.value("SELECT COUNT(*) FROM members"), 0, "nobody is left");
  assert.equal(db.value("SELECT COUNT(*) FROM tokens"), 0);
  assert.equal(db.value("SELECT COUNT(*) FROM invites"), 0);
  assert.equal(db.value("SELECT COUNT(*) FROM presence"), 0, "and nobody is here");
  assert.equal(db.value("SELECT COUNT(*) FROM leases"), 0, "…or holding anything");
  // A wiped domain refuses everybody's token and has taken nobody's away:
  // Alice's Mac stops syncing and keeps its copy, so it is a bare 401.
  assert.equal(db.value("SELECT COUNT(*) FROM removed_tokens"), 0);
  assert.equal(db.value("SELECT COUNT(*) FROM creator"), 0);
  const stranded = await call("/api/meta", { token: MEMBER });
  assert.equal(stranded.status, 401);
  assert.deepEqual(stranded.json, { error: "unauthorized" });
  // Agents go the same way, and the mirror and the card copy of a workspace that is gone with them.
  for (const table of ["agents", "agent_tokens", "agent_codes", "search_text", "search_state", "board_cards"]) {
    assert.equal(db.value(`SELECT COUNT(*) FROM ${table}`), 0, `${table} is empty`);
  }
  assert.equal((await as(doomed)("/api/agent/me")).status, 401, "an agent's token died with its row");
  assert.equal((await loginWith(agentCode(unusedBody))).status, 401, "and so did the code somebody was still holding");
  assert.deepEqual((await call("/api/auth/agents", { token: OWNER })).json.agents, [], "a rebound domain inherits no ghost agents");
  assert.deepEqual((await call("/api/auth/members", { token: OWNER })).json.members, []);
  const meta = await call("/api/meta", { token: OWNER });
  assert.equal(meta.status, 200);
  assert.equal(meta.json.workspace, null, "the domain is free");
  assert.equal((await call("/api/manifest", { token: OWNER })).status, 404);

  // The database is emptied, not dropped: the schema is re-run so the next
  // binding finds a migrated database rather than a half-built one.
  assert.deepEqual(db.tables(), D1_TABLES);
  assert.equal(db.value("SELECT schema_version FROM meta WHERE key = 'schema'"), D1_SCHEMA);
  assert.equal(meta.json.d1, D1_SCHEMA, "…and the probe still says so");

  const rebound = await call("/api/workspace", {
    method: "POST",
    token: OWNER,
    device: null,
    body: { name: "Sherin's <Notes>" },
  });
  assert.equal(rebound.status, 201, "a wiped domain binds again");
  assert.notEqual(rebound.json.id, ws.id, "as a new workspace");
  assert.equal(rebound.json.createdBy.deviceId, null, "no device header, no attribution");
  assert.equal(rebound.json.createdBy.deviceName, "Owner");
  assert.equal(rebound.json.owner, undefined, "no ownerEmail, no member row — binding never needed one");
  const landing = await call("/", { device: null });
  assert.ok(landing.text.includes("<h1>Sherin&#39;s &lt;Notes&gt;</h1>"), "the name is escaped on the landing page");
  assert.ok(landing.text.includes("<title>Sherin&#39;s &lt;Notes&gt; · Doklin</title>"));
});

/* ---------- Summary ---------- */

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  process.exitCode = 1;
}
