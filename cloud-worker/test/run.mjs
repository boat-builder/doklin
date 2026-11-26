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
// the same suite runs against a bundle scripts/bundle-worker.mjs wrote, with
// the web directory it wrote beside it served in front of the worker the way
// Cloudflare serves it (test/assets.mjs): the fonts, icons, og.png and the
// flowchart module then answer instead of 404ing.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "vite";
import { withAssets } from "./assets.mjs";
import { FakeCache, FakeR2 } from "./fake-r2.mjs";
import { FakeD1, brokenD1, reads } from "./fake-d1.mjs";
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
/** The web directory beside the bundle (scripts/bundle-worker.mjs), or null for a source compile. */
const webDir = bundlePath ? path.join(path.dirname(path.resolve(bundlePath)), "doklin-cloud-web") : null;
/** The tag the worker's pages carry: the web directory's flowchart build, or "dev". */
const webTag = webDir ? (readdirSync(path.join(webDir, "__web")).find((d) => d !== "fonts") ?? "dev") : "dev";
if (bundlePath) {
  const href = pathToFileURL(path.resolve(bundlePath)).href;
  worker = withAssets((await import(href)).default, webDir);
  anotherIsolate = async (tag) => withAssets((await import(`${href}?isolate=${tag}`)).default, webDir);
  console.log(`testing the bundle at ${bundlePath}, its web directory in front`);
} else {
  const source = await compileWorker();
  ({ default: worker } = await import(source));
  anotherIsolate = async (tag) => (await import(`${source}${encodeURIComponent(`\n// isolate ${tag}`)}`)).default;
}

/** The worker compiled from src/, as a module to import; `plugins` change
 *  the sources on the way in. */
async function compileWorker(plugins = []) {
  const out = await build({
    configFile: false,
    logLevel: "warn",
    plugins,
    build: {
      write: false,
      target: "es2022",
      lib: { entry: path.join(workerDir, "src", "index.ts"), formats: ["es"], fileName: "worker" },
    },
  });
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === "chunk");
  return `data:text/javascript,${encodeURIComponent(chunk.code)}`;
}

/* ---------- Harness ---------- */

/** The domain's key: the env secret, which only ever trades for a sign-in. */
const KEY = "owner-secret-token";
/** Sherin's Mac — the superadmin's own device sign-in, which the "key" test
 *  below trades the key for. Every "an owner can do this" below stands on it. */
let OWNER;
const DEVICE = "d-macbook";
const OTHER_DEVICE = "d-imac";
const fake = new FakeR2();
const db = new FakeD1();
const env = { OWNER_TOKEN: KEY, DATA: fake, DB: db };

/** The manifest's format, from its one source. */
const MANIFEST_VERSION = Number(
  readFileSync(path.join(workerDir, "src", "version.ts"), "utf8").match(/^export const MANIFEST_VERSION = (\d+);$/m)[1],
);

/** What a fully migrated database reports, and the tables it then holds. */
const D1_SCHEMA = 13;
/** The manifest schema the worker takes (cloud-worker/src/version.ts). */
const D1_TABLES = [
  "addresses",
  "agent_codes",
  "agent_tokens",
  "agents",
  "invites",
  "leases",
  "links",
  "members",
  "meta",
  "presence",
  "removed_tokens",
  "search_state",
  "search_text",
  "settings",
  "space_members",
  "spaces",
  "spent_keys",
  "superadmin",
  "tags",
  "tokens",
  "usage",
];

/** The numbers of the two plans (cloud-worker/src/limits.ts), as the plan
 *  fixes them. `fleetToday` is whatever was reported. */
const FREE_LIMITS = {
  plan: "free",
  cap: 100_000,
  bulkPerSecond: 4,
  deviceBulk: 10_000,
  deviceCeiling: 15_000,
  fleetBulkWaits: 60_000,
  fleetSlow: 85_000,
  cliDaily: 5_000,
  manyNew: 200,
};
const PAID_LIMITS = {
  plan: "paid",
  cap: null,
  bulkPerSecond: 20,
  deviceBulk: null,
  deviceCeiling: 200_000,
  fleetBulkWaits: null,
  fleetSlow: null,
  cliDaily: 50_000,
  manyNew: 200,
};

/** The test database, failing every statement that matches `pattern` — what
 *  the best-effort parts of a request do when D1 errors past the sign-in. */
const failingPast = (pattern) => ({
  prepare(sql) {
    if (pattern.test(sql)) throw new Error("D1_ERROR: simulated");
    return db.prepare(sql);
  },
  batch: (statements) => db.batch(statements),
  exec: (sql) => db.exec(sql),
});

/** Trade a key for a device sign-in as the superadmin, `email`'s person. */
const recover = (key, body = {}, bindings = env, device = DEVICE) =>
  call("/api/auth/recover", { method: "POST", token: key, device, body, bindings });

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
  version: MANIFEST_VERSION,
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
  // A member id — who changed it, not which Mac did.
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

/** A share's id, as a device mints one. */
let shares = 0;
const shareId = () => `s-${(0x5a000000 + (shares += 1)).toString(16)}`;
/** The caller's own My files, made on first asking. */
const myFiles = async (token) => (await call("/api/spaces/private", { method: "PUT", token })).json.space;
/** Share a folder (or a document) — in the caller's My files unless `parent` says where. */
const share = async (token, { name, kind = "folder", members = [], parent, id = shareId() }) =>
  call("/api/spaces", { method: "POST", token, body: { id, kind, name, members, parent: parent ?? (await myFiles(token)).id } });

/* ---------- Tests ---------- */

let ws; // the binding, once made
let workerVersion;

// First, because the schema runner remembers a successful migration for the
// life of the isolate: the cold-start postures can only be seen before one.
await test("d1: no binding and a broken binding both still answer the probe", async () => {
  const none = await call("/api/meta", { token: KEY, bindings: { OWNER_TOKEN: KEY, DATA: fake } });
  assert.equal(none.status, 200, "a deployment whose binding did not take");
  assert.equal(none.json.d1, null);

  const bad = await call("/api/meta", { token: KEY, bindings: { OWNER_TOKEN: KEY, DATA: fake, DB: brokenD1() } });
  assert.equal(bad.status, 200, "a database deleted under a deployed worker is not an outage");
  assert.equal(bad.json.d1, null);
});

await test("d1: a fresh database migrates itself, once per isolate", async () => {
  assert.deepEqual(db.tables(), [], "nothing has touched it yet");
  db.queries.length = 0;

  const first = await call("/api/meta", { token: KEY });
  assert.equal(first.status, 200);
  assert.equal(first.json.d1, D1_SCHEMA, "the probe reports the schema version");
  assert.ok(db.queries.length > 0, "…and the probe is what ran the migration");
  assert.deepEqual(
    db.tables(),
    D1_TABLES,
    "people and the superadmin, who is here, what they hold, the credentials taken away, the keys spent, agents and theirs, the search mirror, the plan and what was spent today, and the runner's own anchor",
  );
  assert.equal(db.value("SELECT schema_version FROM meta WHERE key = 'schema'"), D1_SCHEMA);
  assert.equal(db.rows("SELECT * FROM meta").length, 1, "one row, and re-running never adds another");

  db.queries.length = 0;
  const again = await call("/api/meta", { token: KEY });
  assert.equal(again.json.d1, D1_SCHEMA);
  // The migration never runs twice in an isolate.
  assert.deepEqual(db.queries, [], "a migrated isolate's probe asks the database nothing");
});

await test("d1: a database at schema 9 takes steps 10 to 13 — settings, usage, links and tags made, presence made again with until, spaces given where each sits and when it was deleted, everything else kept", async () => {
  const at9 = new FakeD1();
  const probe = (isolate) =>
    isolate.fetch(new Request("https://nine.example.com/api/meta", { headers: { authorization: `Bearer ${KEY}` } }), {
      OWNER_TOKEN: KEY,
      DATA: new FakeR2(),
      DB: at9,
    });
  // A database as schema 9 left it: every table step 9 makes, presence as it was then.
  assert.equal((await (await probe(await anotherIsolate("nine-a"))).json()).d1, D1_SCHEMA);
  at9.run("DROP TABLE settings");
  at9.run("DROP TABLE usage");
  at9.run("DROP TABLE links");
  at9.run("DROP TABLE tags");
  at9.run("DROP TABLE presence");
  at9.run(
    "CREATE TABLE presence (device_id TEXT PRIMARY KEY, member_id TEXT, device_name TEXT NOT NULL, space_id TEXT NOT NULL DEFAULT '', path TEXT, ts INTEGER NOT NULL)",
  );
  at9.run("DROP INDEX spaces_by_parent");
  at9.run("ALTER TABLE spaces DROP COLUMN parent");
  at9.run("ALTER TABLE spaces DROP COLUMN deleted_at");
  at9.run("INSERT INTO spaces (id, kind, name, created_by, created_at, etag) VALUES ('s-00000009', 'folder', 'Kept', 'm-00000009', 1, 'e')");
  at9.run("UPDATE meta SET schema_version = 9 WHERE key = 'schema'");
  at9.run("INSERT INTO members (id, email, name, role, created_at) VALUES ('m-00000009', 'nine@example.com', 'Nine', 'owner', 1)");
  at9.run("INSERT INTO presence (device_id, member_id, device_name, ts) VALUES ('d-nine', 'm-00000009', 'Nine', ?)", Date.now());

  const after = await (await probe(await anotherIsolate("nine-b"))).json();
  assert.equal(after.d1, D1_SCHEMA, "the probe ran the steps");
  assert.deepEqual(at9.tables(), D1_TABLES);
  assert.ok(at9.rows("PRAGMA table_info(presence)").some((c) => c.name === "until" && c.notnull === 1), "presence says when a row lapses");
  assert.equal(at9.value("SELECT COUNT(*) FROM presence"), 0, "what the last beats wrote is the one thing dropped");
  assert.equal(at9.value("SELECT name FROM members WHERE id = 'm-00000009'"), "Nine", "everything else is as it was");
  assert.equal(at9.value("SELECT schema_version FROM meta WHERE key = 'schema'"), D1_SCHEMA);
  // A table that holds something gains its columns: its rows are kept, with nothing said in the new ones.
  assert.deepEqual(at9.rows("SELECT name, parent, deleted_at FROM spaces"), [{ name: "Kept", parent: null, deleted_at: null }]);

  // A database whose columns were added by hand, its number left behind: the step looks first, and adds nothing twice.
  at9.run("UPDATE meta SET schema_version = 12 WHERE key = 'schema'");
  assert.equal((await (await probe(await anotherIsolate("nine-c"))).json()).d1, D1_SCHEMA);
  assert.equal(at9.rows("PRAGMA table_info(spaces)").filter((c) => c.name === "parent" || c.name === "deleted_at").length, 2);
});

await test("key: the domain's key is no sign-in — it trades, once, for the superadmin's own device", async () => {
  const meta = await call("/api/meta", { token: KEY });
  assert.equal(meta.status, 200, "the probe answers it, so the app can tell a fresh domain from a bound one");
  assert.deepEqual(Object.keys(meta.json).sort(), ["d1", "version", "workspace"], "the key is nobody: no `you`, no people");
  for (const [path, method] of [
    ["/api/manifest", "GET"],
    ["/api/poll", "GET"],
    ["/api/workspace", "POST"],
    ["/api/auth/members", "GET"],
    ["/api/auth/invites", "POST"],
    ["/api/auth/devices/code", "POST"],
    ["/api/auth/session", "DELETE"],
    ["/api/admin/wipe", "POST"],
    ["/api/spaces", "GET"],
    ["/api/agent/me", "GET"],
  ]) {
    const res = await call(path, { method, token: KEY, body: method === "GET" ? undefined : {} });
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.ok(/no sign-in/.test(res.json.error), `${method} ${path} says why`);
  }
  assert.equal((await call("/api/auth/recover", { token: KEY })).status, 405);

  // A trade names who is at the keyboard.
  assert.equal((await recover(KEY)).status, 400);
  assert.equal((await recover(KEY, { email: "not an address" })).status, 400);
  assert.equal(db.value("SELECT COUNT(*) FROM spent_keys"), 0, "a refused trade spends nothing");

  const traded = await recover(KEY, {
    email: " Sherin@Example.com ",
    name: "Sherin",
    deviceId: DEVICE,
    deviceName: "Sherin's MacBook Pro",
  });
  assert.equal(traded.status, 201);
  assert.equal(traded.json.token.length, 64, "a device's own token, like anybody's");
  assert.ok(/^t-[a-f0-9]{8}$/.test(traded.json.tokenId));
  assert.equal(traded.json.member.email, "sherin@example.com");
  assert.equal(traded.json.member.name, "Sherin");
  assert.equal(traded.json.member.role, "superadmin");
  assert.ok(traded.json.member.lastSeenAt > 0, "somebody has signed in as her");
  OWNER = traded.json.token;
  assert.equal(db.value("SELECT member_id FROM superadmin"), traded.json.member.id, "one row says who the superadmin is");
  assert.equal(db.value("SELECT role FROM members WHERE id = ?", traded.json.member.id), "owner", "…and her row is an owner's");
  assert.equal(db.value("SELECT hash FROM tokens"), sha256(OWNER), "only the hash is kept");

  // Once.
  assert.equal(db.value("SELECT hash FROM spent_keys"), sha256(KEY));
  const twice = await recover(KEY, { email: "sherin@example.com" });
  assert.equal(twice.status, 401);
  assert.equal(twice.json.code, "key_spent");
  assert.equal(db.value("SELECT COUNT(*) FROM tokens"), 1, "and it minted nothing");
  assert.equal((await call("/api/meta", { token: KEY })).status, 200, "a spent key still only probes");

  const you = (await call("/api/meta", { token: OWNER })).json;
  assert.equal(you.you.role, "superadmin");
  assert.equal(you.you.tokenId, traded.json.tokenId, "a row of the devices list, like any device");
  assert.deepEqual(you.superadmin, { id: traded.json.member.id, name: "Sherin" }, "and everyone is told who that is");
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

  assert.equal(db.value("SELECT COUNT(*) FROM tokens WHERE member_id = ?", ALICE.id), 1);
  assert.equal(db.value("SELECT hash FROM tokens WHERE member_id = ?", ALICE.id), sha256(MEMBER), "only the hash is kept");
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
  const devices = await call("/api/auth/devices", { token: OWNER });
  assert.equal(devices.status, 200);
  assert.ok(!devices.text.includes(sha256(BOB)), "the owner is told what exists, never handed it");
  const bobToken = devices.json.devices.find((t) => t.email === "bob@example.com");
  assert.equal(bobToken.deviceName, "Bob's mini");
  assert.equal(bobToken.deviceId, "d-bobmac");
  assert.equal((await call(`/api/auth/devices/${bobToken.id}`, { method: "DELETE", token: OWNER })).status, 204);
  assert.equal((await call("/api/meta", { token: BOB })).status, 401, "revoked on the very next request");
  assert.equal((await call(`/api/auth/devices/${bobToken.id}`, { method: "DELETE", token: OWNER })).status, 404);
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

await test("identity: removing a person takes every credential they hold, and keeps who they were — invited again, they are the same person", async () => {
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
  assert.ok(listed.lastSeenAt > 0, "from the moment somebody first signed in as her; the beat moves it from there");
  assert.equal(listed.disabled, undefined, "a removed person is not in this list, so nothing says which are");

  assert.equal((await call(`/api/auth/members/${erin.id}`, { method: "DELETE", token: OWNER })).status, 204);
  for (const mac of [one, two]) {
    const refused = await call("/api/meta", { token: mac.json.token });
    assert.equal(refused.status, 401);
    assert.equal(refused.json.removed, true, "each of her Macs is told its access was taken away");
  }
  assert.equal(db.value("SELECT COUNT(*) FROM tokens WHERE member_id = ?", erin.id), 0, "both tokens went with her");
  assert.equal(db.value("SELECT COUNT(*) FROM invites WHERE member_id = ?", erin.id), 0);
  assert.equal((await call(`/api/auth/members/${erin.id}`, { method: "DELETE", token: OWNER })).status, 404);

  // Her row stays: out of the People list, and still the name on what she wrote.
  const here = async () => (await call("/api/auth/members", { token: OWNER })).json.members;
  assert.equal(db.value("SELECT disabled FROM members WHERE id = ?", erin.id), 1);
  assert.ok(!(await here()).some((m) => m.id === erin.id), "not in the People list");
  assert.ok(
    (await call("/api/meta", { token: OWNER })).json.people.some((p) => p.id === erin.id && p.name === "Erin"),
    "what she wrote keeps her name",
  );
  assert.equal(
    (await call(`/api/auth/members/${erin.id}`, { method: "PATCH", token: OWNER, body: { role: "owner" } })).status,
    404,
    "and there is nobody there to make an owner",
  );

  // Inviting the address again is the same person, here again as a member.
  const again = await call("/api/auth/invites", {
    method: "POST",
    token: OWNER,
    body: { email: " Erin@Example.com ", codeHash: sha256("EEEEEEEEEEEEEEEEEEE2"), expiresAt: Date.now() + DAY },
  });
  assert.equal(again.status, 201);
  assert.equal(again.json.invite.memberId, erin.id, "the row she had");
  const back = await call("/api/auth/join", { method: "POST", body: { code: code("EEEEEEEEEEEEEEEEEEE2"), deviceId: "d-erin3" } });
  assert.equal(back.status, 201);
  assert.equal(back.json.member.id, erin.id);
  assert.equal(back.json.member.role, "member");
  assert.equal((await here()).find((m) => m.id === erin.id).devices, 1, "back in the People list, on the one Mac that joined");
  assert.equal((await call("/api/meta", { token: one.json.token })).json.removed, true, "a Mac she was removed from stays removed");
  assert.equal((await call(`/api/auth/members/${erin.id}`, { method: "DELETE", token: OWNER })).status, 204);

  for (const bad of ["nope", "m-xyz", "m-0123456789", "..%2F..%2Fetc", "t-0123abcd%20"]) {
    assert.equal((await call(`/api/auth/members/${bad}`, { method: "DELETE", token: OWNER })).status, 400, bad);
  }
});

await test("identity: POST /api/auth/join is the whole carve-out, and of the other auth routes only the People list and their own devices are a member's", async () => {
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
    ["/api/auth/devices", "GET"],
    ["/api/auth/devices/code", "POST"],
    ["/api/auth/session", "DELETE"],
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
    [`/api/auth/members/${ALICE.id}`, "PATCH"],
    [`/api/auth/members/${ALICE.id}`, "DELETE"],
  ]) {
    const res = await call(path, { method, token: MEMBER, body: method === "GET" ? undefined : {} });
    assert.equal(res.status, 403, `${method} ${path} as a member`);
  }
  // Who is here is everybody's to see: a workspace you belong to is one whose
  // people you can name.
  const seen = await call("/api/auth/members", { token: MEMBER });
  assert.equal(seen.status, 200, "the People list answers a member");
  assert.ok(seen.json.members.some((m) => m.id === ALICE.id && m.role === "member"));
  assert.equal((await call("/api/auth/members", { method: "POST", token: OWNER, body: {} })).status, 405, "nobody says who somebody is");

  assert.equal((await call("/api/auth/join", { method: "POST", token: OWNER, body: { code: ALICE_CODE } })).status, 401);
  assert.equal((await call("/api/auth/nonsense", { token: OWNER })).status, 404);
  assert.equal((await call("/api/auth/devices", { method: "POST", token: OWNER, body: {} })).status, 405);
  assert.equal((await call("/api/auth/join", { method: "PUT", token: OWNER, body: {} })).status, 405);
});

await test("identity: without a database nobody signs in — the superadmin included — and it says 503, never 401", async () => {
  const noDb = { OWNER_TOKEN: KEY, DATA: fake };
  const broken = { OWNER_TOKEN: KEY, DATA: fake, DB: brokenD1() };

  for (const [bindings, said] of [[noDb, /no database/], [broken, /isn't answering/]]) {
    for (const token of [OWNER, MEMBER]) {
      const res = await call("/api/meta", { token, bindings });
      assert.equal(res.status, 503, "a 401 is what has a Mac stop syncing for good");
      assert.ok(said.test(res.json.error), res.json.error);
      assert.equal(res.json.removed, undefined);
      assert.equal((await call("/api/manifest", { token, bindings })).status, 503, "…and no device is spared");
    }
    assert.equal((await call("/api/meta", { token: KEY, bindings })).status, 200, "the probe still answers");
    const join = await call("/api/auth/join", { method: "POST", bindings, body: { code: ALICE_CODE, deviceId: DEVICE } });
    assert.equal(join.status, 503, "and a redeem says so rather than 'wrong code'");
    assert.equal((await recover("a-fresh-key", { email: "sherin@example.com" }, { ...bindings, OWNER_TOKEN: "a-fresh-key" })).status, 503);
  }
});

await test("auth: /api/meta rejects a missing or wrong token; owner and member get in", async () => {
  assert.equal((await call("/api/meta")).status, 401);
  assert.equal((await call("/api/meta", { token: "nope" })).status, 401);
  const ok = await call("/api/meta", { token: OWNER });
  assert.equal(ok.status, 200);
  assert.ok(Number.isInteger(ok.json.version) && ok.json.version >= 1);
  workerVersion = ok.json.version;
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

await test("bind: the superadmin's, once — the second bind is 409 with what the domain holds", async () => {
  const member = await call("/api/workspace", { method: "POST", token: MEMBER, body: { name: "x" } });
  assert.equal(member.status, 403);
  assert.ok(/superadmin/.test(member.json.error), "and says whose it is");
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
    body: { name: "  Notes  ", deviceName: "Sherin's MacBook Pro" },
  });
  assert.equal(made.status, 201);
  assert.match(made.json.id, /^w-[0-9a-f]{12}$/);
  assert.equal(made.json.name, "Notes", "the name is trimmed");
  assert.ok(made.json.manifestEtag, "the bind hands back the etag the first CAS builds on");
  assert.ok(Date.parse(made.json.createdAt) > 0);
  assert.deepEqual(made.json.createdBy, { deviceId: DEVICE, deviceName: "Sherin's MacBook Pro" });
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

await test("identity: the superadmin is one person, and theirs on every device they sign in on", async () => {
  const listed = (await call("/api/auth/members", { token: OWNER })).json.members;
  const sherin = listed.find((m) => m.role === "superadmin");
  assert.equal(sherin.email, "sherin@example.com", "the trade wrote the row");
  assert.equal(listed.filter((m) => m.role === "superadmin").length, 1);
  assert.equal(sherin.devices, 1);

  // Inviting an existing member never promotes, and inviting an owner never
  // demotes: the role on the row wins over the role an invite implies.
  await call("/api/auth/invites", {
    method: "POST",
    token: OWNER,
    body: { email: "sherin@example.com", codeHash: sha256("11111111111111111111"), expiresAt: Date.now() + DAY },
  });
  assert.equal(
    (await call("/api/auth/members", { token: OWNER })).json.members.find((m) => m.id === sherin.id).role,
    "superadmin",
    "an invite to the superadmin's own address changes nothing",
  );
  assert.equal((await call("/api/auth/members", { token: OWNER })).json.members.find((m) => m.id === ALICE.id).role, "member");

  // A second Mac of hers, signed in the ordinary way, IS the superadmin: the
  // role is the person's, so no device of theirs is special.
  const redeemed = await call("/api/auth/join", {
    method: "POST",
    body: { code: code("11111111111111111111"), deviceId: "d-sherin2", deviceName: "Sherin's iMac" },
  });
  assert.equal(redeemed.status, 201);
  assert.equal(redeemed.json.member.role, "superadmin");
  const you = (await call("/api/meta", { token: redeemed.json.token })).json.you;
  assert.equal(you.role, "superadmin", "the token carries the role its person has");
  assert.equal(you.memberId, sherin.id);
  assert.ok(you.can.includes("workspace.manage") && you.can.includes("people.recover"));
  assert.equal((await call("/api/auth/invites", { token: redeemed.json.token })).status, 200, "an owner's routes answer it");
  assert.equal(
    (await call("/api/admin/wipe", { method: "POST", token: redeemed.json.token, body: {} })).status,
    400,
    "…the wipe included: it got as far as asking for the confirmation",
  );
  const mine = (await call("/api/auth/devices", { token: OWNER })).json.devices.find((t) => t.deviceId === "d-sherin2");
  assert.equal((await call(`/api/auth/devices/${mine.id}`, { method: "DELETE", token: OWNER })).status, 204, "hers to sign out");
  assert.equal((await call("/api/meta", { token: redeemed.json.token })).json.removed, true, "signed out like any other Mac");
});

await test("key: whoever trades a fresh one becomes the superadmin — the role's only way to move — and the one before stays an owner", async () => {
  // A domain of its own, in an isolate of its own, so the move is all there is.
  const isolate = await anotherIsolate("superadmin-moves");
  const here = { DATA: new FakeR2(), DB: new FakeD1() };
  const ask = async (path, token, { method = "GET", body, key } = {}) => {
    const res = await isolate.fetch(
      new Request(`https://moves.example.com${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-doklin-device": "d-moves" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      { ...here, OWNER_TOKEN: key ?? "unset" },
    );
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const trade = (key, body) => ask("/api/auth/recover", key, { method: "POST", body, key });

  const ada = (await trade("key-one", { email: "ada@example.com", name: "Ada" })).json;
  assert.equal(ada.member.role, "superadmin");
  const people = async () => (await ask("/api/auth/members", ada.token)).json.members;

  // Ada lost every device: a fresh key, set on the account, and she is back
  // as herself on a new device, the old one untouched.
  const back = await trade("key-two", { email: "ada@example.com" });
  assert.equal(back.status, 201);
  assert.equal(back.json.member.id, ada.member.id);
  assert.equal((await ask("/api/meta", ada.token)).json.you.role, "superadmin");

  // Bo sets the next key: whoever controls the account is the superadmin.
  const bo = await trade("key-three", { email: "bo@example.com", name: "Bo" });
  assert.equal(bo.status, 201);
  assert.equal(bo.json.member.role, "superadmin");
  const now = await people();
  assert.equal(now.find((m) => m.id === ada.member.id).role, "owner", "the one before stays an owner");
  assert.equal(now.filter((m) => m.role === "superadmin").length, 1, "and there is one");
  assert.equal((await ask("/api/meta", ada.token)).json.you.role, "owner", "on her very next request");
  assert.equal((await ask("/api/meta", ada.token)).json.superadmin.name, "Bo");

  // Nothing in the app moves it: the role is not a role an owner gives.
  const handOver = await ask(`/api/auth/members/${ada.member.id}`, bo.json.token, { method: "PATCH", body: { role: "superadmin" } });
  assert.equal(handOver.status, 400);
  const demote = await ask(`/api/auth/members/${bo.json.member.id}`, ada.token, { method: "PATCH", body: { role: "member" } });
  assert.equal(demote.status, 409);
  assert.ok(/recovers the workspace/.test(demote.json.error), "and it says how the role does move");
  assert.equal((await ask(`/api/auth/members/${bo.json.member.id}`, ada.token, { method: "DELETE" })).status, 409);
  assert.equal(
    (await ask(`/api/auth/devices/${bo.json.tokenId}`, ada.token, { method: "DELETE" })).status,
    409,
    "nor does an owner sign out a device of the superadmin's",
  );
  assert.equal((await ask("/api/meta", bo.json.token)).status, 200, "…which is still signed in");
  const erase = await ask("/api/admin/wipe", ada.token, { method: "POST", body: { confirm: "wipe" } });
  assert.equal(erase.status, 403, "erasing the domain is the superadmin's alone");
  assert.ok(/superadmin/.test(erase.json.error));
});

await test("roles: a role is the person's — an owner makes another, and it lands on their very next request", async () => {
  const AN_OWNER = ["work", "people.see", "people.invite", "people.remove", "people.roles", "agents.own", "agents.manage", "devices.own", "pages.manage"];
  const EVERYTHING = ["work", "people.see", "people.invite", "people.recover", "people.remove", "people.roles", "agents.own", "agents.manage", "devices.own", "pages.manage", "workspace.manage"];
  const role = (id, to, token = OWNER) =>
    call(`/api/auth/members/${id}`, { method: "PATCH", token, body: { role: to } });
  const superadmin = (await call("/api/auth/members", { token: OWNER })).json.members.find((m) => m.role === "superadmin");

  // What each role may do is one table, and the probe answers the caller's
  // row of it — the same answer every gated route below is decided by.
  assert.deepEqual((await call("/api/meta", { token: MEMBER })).json.you.can, ["work", "people.see", "agents.own", "devices.own"]);
  assert.deepEqual((await call("/api/meta", { token: OWNER })).json.you.can, EVERYTHING);

  assert.equal((await role(ALICE.id, "owner", MEMBER)).status, 403, "a member cannot make an owner — themselves least of all");

  const made = await role(ALICE.id, "owner");
  assert.equal(made.status, 200);
  assert.equal(made.json.member.role, "owner");
  // The same token, untouched: the role is read off the row on every request.
  const you = (await call("/api/meta", { token: MEMBER })).json.you;
  assert.equal(you.role, "owner");
  assert.deepEqual(you.can, AN_OWNER, "an owner is everything but the superadmin's");
  for (const path of ["/api/auth/invites", "/api/auth/devices", "/api/auth/agents"]) {
    assert.equal((await call(path, { token: MEMBER })).status, 200, `${path} answers the new owner`);
  }
  assert.equal(
    (await call("/api/auth/members", { token: OWNER })).json.members.filter((m) => m.role !== "member").length,
    2,
    "there can be several owners",
  );

  // What an owner still cannot do. Their own row is another owner's to
  // change: a slip would otherwise leave them nobody to undo it.
  assert.equal((await role(ALICE.id, "member", MEMBER)).status, 409, "not their own role");
  assert.equal((await call(`/api/auth/members/${ALICE.id}`, { method: "DELETE", token: MEMBER })).status, 409, "nor their own removal");
  // And the superadmin's row is nobody's to change: the role moves only by
  // trading a key, which only the Cloudflare account can set.
  assert.equal((await role(superadmin.id, "member", MEMBER)).status, 409, "the superadmin stays");
  assert.equal((await role(superadmin.id, "member")).status, 409, "…even by their own hand");
  assert.equal((await call(`/api/auth/members/${superadmin.id}`, { method: "DELETE", token: MEMBER })).status, 409);
  assert.equal((await call(`/api/auth/members/${superadmin.id}`, { method: "DELETE", token: OWNER })).status, 409);
  const still = (await call("/api/auth/members", { token: OWNER })).json.members.find((m) => m.id === superadmin.id);
  assert.equal(still.role, "superadmin");
  // An owner does not sign out the superadmin's devices either: only they do.
  const hers = (await call("/api/meta", { token: OWNER })).json.you.tokenId;
  const signOut = await call(`/api/auth/devices/${hers}`, { method: "DELETE", token: MEMBER });
  assert.equal(signOut.status, 409);
  assert.ok(/only they/.test(signOut.json.error));
  assert.equal((await call("/api/meta", { token: OWNER })).status, 200, "still signed in");

  assert.equal((await role(ALICE.id, "admin")).status, 400, "two roles to give, and no third");
  assert.equal((await role(ALICE.id, "superadmin")).status, 400, "…the superadmin's least of all");
  assert.equal((await role("m-00000000", "owner")).status, 404);
  assert.equal((await role("nope", "owner")).status, 400);
  assert.equal((await call(`/api/auth/members/${ALICE.id}`, { method: "PUT", token: OWNER, body: {} })).status, 405);

  // A code is a way in as the person it is for, so one for an owner's address
  // is that owner's to make, or the superadmin's — never another owner's, who
  // could keep it and come back as them. Alice may make one for herself.
  const codeFor = (email, body, token) =>
    call("/api/auth/invites", { method: "POST", token, body: { email, codeHash: sha256(body), expiresAt: Date.now() + DAY } });
  const forSuperadmin = await codeFor(superadmin.email, "CCCCCCCCCCCCCCCCCCCC", MEMBER);
  assert.equal(forSuperadmin.status, 409, "an owner cannot make a code for the superadmin's row");
  assert.equal(db.value("SELECT COUNT(*) FROM invites WHERE member_id = ?", superadmin.id), 0, "…and none was stored");
  assert.equal((await codeFor("alice@example.com", "AAAAAAAAAAAAAAAAAAAA", MEMBER)).status, 201, "her own is hers");
  assert.equal((await codeFor(superadmin.email, "CCCCCCCCCCCCCCCCCCCC", OWNER)).status, 201, "the superadmin's is the superadmin's");
  assert.equal((await codeFor("someone-new@example.com", "NNNNNNNNNNNNNNNNNNNN", MEMBER)).status, 201, "a new person is any owner's to invite");

  // Nor can anyone sign out the Mac they are on: it would delete the copy in
  // their hands. The probe says which row is theirs, so the app never offers.
  const mine = (await call("/api/meta", { token: MEMBER })).json.you.tokenId;
  assert.ok(/^t-[a-f0-9]{8}$/.test(mine));
  assert.equal((await call(`/api/auth/devices/${mine}`, { method: "DELETE", token: MEMBER })).status, 409);
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

  // The address is never verified, so a code is whoever redeems it. Once
  // somebody has signed in as a person, a new code for them is theirs to make
  // or the superadmin's — another owner's would be a way into what is theirs.
  const invitesBefore = db.value("SELECT COUNT(*) FROM invites");
  const forAlice = await codeFor("alice@example.com", "BBBBBBBBBBBBBBBBBBBB", dan.token);
  assert.equal(forAlice.status, 409, "not another owner's to make");
  assert.ok(/signed in here before/.test(forAlice.json.error));
  assert.equal(db.value("SELECT COUNT(*) FROM invites"), invitesBefore, "…and none was stored");
  // The same for somebody who was removed: Erin signed in once, so she is still a person.
  assert.equal((await codeFor("erin@example.com", "EEEEEEEEEEEEEEEEEEE3", dan.token)).status, 409, "removed is not forgotten");
  assert.equal(db.value("SELECT disabled FROM members WHERE email = 'erin@example.com'"), 1, "a refused code brings nobody back");
  // Somebody nobody has signed in as is still only an invitation: any owner
  // makes their first code, and any owner replaces it when it is lost.
  assert.equal((await codeFor("pat@example.com", "PPPPPPPPPPPPPPPPPPPP", dan.token)).status, 201);
  assert.equal((await codeFor("pat@example.com", "PPPPPPPPPPPPPPPPPPP2", OWNER)).status, 201, "the superadmin replaces it");
  assert.equal((await codeFor("pat@example.com", "PPPPPPPPPPPPPPPPPPP3", dan.token)).status, 201, "and so does another owner");
  assert.equal(db.value("SELECT COUNT(*) FROM invites"), invitesBefore + 1, "one code a person, whoever made it");

  assert.equal((await call(`/api/auth/members/${dan.member.id}`, { method: "DELETE", token: OWNER })).status, 204);
  assert.equal((await call("/api/meta", { token: dan.token })).json.removed, true);
  assert.equal(db.value("SELECT COUNT(*) FROM invites"), 0, "the codes go with the owner who could have kept them");
  const back = await call("/api/auth/join", { method: "POST", body: { code: code("PPPPPPPPPPPPPPPPPPP3"), deviceId: "d-dan" } });
  assert.equal(back.status, 401, "…so the one he kept does not let him back in as somebody else");
  const pat = (await call("/api/auth/members", { token: OWNER })).json.members.find((m) => m.email === "pat@example.com");
  assert.equal(pat.lastSeenAt, null, "nobody ever signed in as them");
  assert.equal((await call(`/api/auth/members/${pat.id}`, { method: "DELETE", token: OWNER })).status, 204);
  assert.equal(db.value("SELECT COUNT(*) FROM tokens WHERE member_id = ?", ALICE.id), 1, "and Alice's row has the one Mac it had");
});

await test("devices: anyone adds a device of their own with a one-time code, sees and signs out their own — and a device leaves by ending its own sign-in", async () => {
  const HOUR = 60 * 60 * 1000;
  const deviceCode = (body, token, expiresAt = Date.now() + HOUR) =>
    call("/api/auth/devices/code", { method: "POST", token, body: { codeHash: sha256(body), expiresAt } });
  const join = (body, deviceId, deviceName) =>
    call("/api/auth/join", { method: "POST", device: deviceId, body: { code: code(body), deviceId, deviceName } });
  const namesOf = (res) => res.json.devices.map((d) => d.deviceName).sort();

  // A member, not an owner — and no address in the request: the code is for
  // nobody but the person asking.
  const made = await deviceCode("PHNE0000000000000001", MEMBER);
  assert.equal(made.status, 201);
  assert.ok(/^i-[a-f0-9]{8}$/.test(made.json.code.id));
  assert.ok(made.json.code.expiresAt > Date.now());
  assert.equal(db.value("SELECT member_id FROM invites WHERE hash = ?", sha256("PHNE0000000000000001")), ALICE.id);

  // The join that redeems an invite redeems it: the phone is Alice, on a
  // token of its own.
  const phone = await join("PHNE0000000000000001", "d-alicephone", "Alice's iPhone");
  assert.equal(phone.status, 201);
  assert.equal(phone.json.member.id, ALICE.id, "signed in as her");
  assert.notEqual(phone.json.token, MEMBER, "…with a credential of its own");
  assert.equal((await call("/api/meta", { token: phone.json.token, device: "d-alicephone" })).json.you.memberId, ALICE.id);
  assert.equal((await join("PHNE0000000000000001", "d-thief", "Somebody else")).status, 401, "a code works once");

  // Any number of them, one code at a time: a new code stops the one before.
  assert.equal((await deviceCode("PHNE0000000000000002", MEMBER)).status, 201);
  assert.equal((await deviceCode("PHNE0000000000000003", MEMBER)).status, 201);
  assert.equal((await join("PHNE0000000000000002", "d-alicepad", "Alice's iPad")).status, 401, "the code it replaced is dead");
  const pad = await join("PHNE0000000000000003", "d-alicepad", "Alice's iPad");
  assert.equal(pad.status, 201);

  // The superadmin adds one the same way, and it is the superadmin too.
  const superadmin = (await call("/api/auth/members", { token: OWNER })).json.members.find((m) => m.role === "superadmin");
  assert.equal((await deviceCode("CRTR0000000000000001", OWNER)).status, 201);
  const mini = await join("CRTR0000000000000001", "d-sherinmini", "Sherin's mini");
  assert.equal(mini.json.member.id, superadmin.id);
  const miniIs = (await call("/api/meta", { token: mini.json.token, device: "d-sherinmini" })).json.you;
  assert.equal(miniIs.role, "superadmin");
  assert.equal(miniIs.tokenId, mini.json.tokenId);

  // Her devices are hers to see, and nobody else's are: an owner sees everyone's.
  const hers = await call("/api/auth/devices", { token: MEMBER });
  assert.equal(hers.status, 200);
  assert.deepEqual(namesOf(hers), ["Alice's Air", "Alice's iPad", "Alice's iPhone"]);
  assert.ok(hers.json.devices.every((d) => d.memberId === ALICE.id));
  assert.ok(!hers.text.includes(sha256(phone.json.token)), "told what exists, never handed it");
  assert.deepEqual(namesOf(await call("/api/auth/devices", { token: phone.json.token, device: "d-alicephone" })), namesOf(hers), "from any of them");
  const all = await call("/api/auth/devices", { token: OWNER });
  assert.deepEqual(namesOf(all), ["Alice's Air", "Alice's iPad", "Alice's iPhone", "Sherin's MacBook Pro", "Sherin's mini"]);
  assert.deepEqual(namesOf(await call("/api/auth/devices", { token: mini.json.token, device: "d-sherinmini" })), namesOf(all), "any of her devices sees what she sees");

  // Somebody else's device is, to a member, what an unknown id is.
  const others = await call(`/api/auth/devices/${mini.json.tokenId}`, { method: "DELETE", token: MEMBER });
  assert.equal(others.status, 404);
  assert.equal((await call("/api/meta", { token: mini.json.token, device: "d-sherinmini" })).status, 200, "…and it is still signed in");
  assert.equal((await call("/api/auth/devices/nope", { method: "DELETE", token: MEMBER })).status, 400);

  // One of her own, signed out from another: told so, as when an owner does
  // it, because that is what has the device delete its copy.
  assert.equal((await call(`/api/auth/devices/${pad.json.tokenId}`, { method: "DELETE", token: MEMBER })).status, 204);
  const padNow = await call("/api/meta", { token: pad.json.token, device: "d-alicepad" });
  assert.equal(padNow.status, 401);
  assert.equal(padNow.json.removed, true);
  assert.equal((await call(`/api/auth/devices/${pad.json.tokenId}`, { method: "DELETE", token: MEMBER })).status, 404, "gone is gone");

  // A device that leaves ends its own sign-in. It is forgotten, and told to
  // delete nothing: that is for a device somebody else showed the door.
  await call("/api/poll", { method: "POST", token: phone.json.token, device: "d-alicephone", body: { name: "Alice's iPhone" } });
  assert.equal(db.value("SELECT COUNT(*) FROM presence WHERE device_id = 'd-alicephone'"), 1);
  assert.equal((await call("/api/auth/session", { method: "DELETE", token: phone.json.token, device: "d-alicephone" })).status, 204);
  const phoneNow = await call("/api/meta", { token: phone.json.token, device: "d-alicephone" });
  assert.equal(phoneNow.status, 401);
  assert.equal(phoneNow.json.removed, undefined, "a bare refusal");
  assert.equal(db.value("SELECT COUNT(*) FROM removed_tokens WHERE hash = ?", sha256(phone.json.token)), 0);
  assert.equal(db.value("SELECT COUNT(*) FROM presence WHERE device_id = 'd-alicephone'"), 0, "and it is not here now");
  assert.deepEqual(namesOf(await call("/api/auth/devices", { token: MEMBER })), ["Alice's Air"]);

  // A pending code is a way in as its person, so an owner sees it among the
  // pending invites and can withdraw it.
  const pending = await deviceCode("PHNE0000000000000004", MEMBER);
  const listed = (await call("/api/auth/invites", { token: OWNER })).json.invites;
  assert.ok(listed.some((i) => i.id === pending.json.code.id && i.memberId === ALICE.id));
  assert.equal((await call(`/api/auth/invites/${pending.json.code.id}`, { method: "DELETE", token: OWNER })).status, 204);
  assert.equal((await join("PHNE0000000000000004", "d-alicepad", "Alice's iPad")).status, 401);

  // What a code request has to be.
  assert.equal((await deviceCode("PHNE0000000000000005", MEMBER, Date.now() + 25 * HOUR)).status, 400, "an hour, not a month");
  assert.equal((await deviceCode("PHNE0000000000000005", MEMBER, Date.now() - 1)).status, 400);
  const noHash = await call("/api/auth/devices/code", { method: "POST", token: MEMBER, body: { codeHash: "nope", expiresAt: Date.now() + HOUR } });
  assert.equal(noHash.status, 400);
  assert.equal((await call("/api/auth/devices/code", { token: MEMBER })).status, 405);
  assert.equal((await call("/api/auth/session", { token: MEMBER })).status, 405);
  assert.equal(db.value("SELECT COUNT(*) FROM invites"), 0, "nothing is left pending");

  // Back to what the tests below stand on: Alice and Sherin, one Mac each.
  assert.equal((await call(`/api/auth/devices/${mini.json.tokenId}`, { method: "DELETE", token: OWNER })).status, 204);
  assert.equal(db.value("SELECT COUNT(*) FROM tokens WHERE member_id = ?", ALICE.id), 1);
  assert.equal(db.value("SELECT COUNT(*) FROM tokens WHERE member_id = ?", superadmin.id), 1);
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
  assert.equal((await call(`/api/auth/devices/${zed.tokenId}`, { method: "DELETE", token: OWNER })).status, 204);
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
  for (const bindings of [{ OWNER_TOKEN: KEY, DATA: fake }, { OWNER_TOKEN: KEY, DATA: fake, DB: brokenD1() }]) {
    const refused = await call("/api/meta", { token: zed.token, bindings });
    assert.equal(refused.status, 503);
    assert.equal(refused.json.removed, undefined);
    assert.equal((await call("/api/meta", { token: MEMBER, bindings })).json.removed, undefined, "nor a live member's");
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

await test("meta: the probe says who the bearer is, and what everyone here is called", async () => {
  const owner = (await call("/api/meta", { token: OWNER })).json;
  assert.equal(owner.you.role, "superadmin");
  assert.equal(owner.you.email, "sherin@example.com");
  assert.ok(/^m-[a-f0-9]{8}$/.test(owner.you.memberId), "what a manifest this Mac writes signs with");

  // A member's identity came off their token in the very read that let them
  // in, so saying it back costs nothing.
  const mine = (await call("/api/meta", { token: MEMBER })).json;
  assert.equal(mine.you.role, "member");
  assert.equal(mine.you.memberId, ALICE.id);
  assert.deepEqual(mine.superadmin, { id: owner.you.memberId, name: "Sherin" }, "whom to ask, told to everyone");
  assert.equal(mine.you.email, "alice@example.com");

  // The directory rides on the probe — a manifest names ids, so every Mac has
  // to be able to put a name to one without a request of its own — and it is
  // names and nothing else. The People list, with addresses, roles and
  // devices, is a route of its own.
  assert.ok(mine.people.length >= 2);
  assert.deepEqual(
    [...new Set(mine.people.filter((p) => p.id.startsWith("m-")).map((p) => Object.keys(p).sort().join(",")))],
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
    "administering the domain is the superadmin's",
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

await test("manifest: the empty manifest, 304 on since, CAS PUT, a stale PUT loses with the current etag", async () => {
  const first = await call("/api/manifest", { token: OWNER });
  assert.equal(first.status, 200);
  const etag0 = first.headers.get("x-manifest-etag");
  assert.equal(etag0, ws.manifestEtag, "the etag the bind returned is the manifest's");
  const fresh = JSON.parse(first.text);
  assert.equal(fresh.version, MANIFEST_VERSION);
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
    // `by` is a person's or an agent's id, never a device's name.
    [manifest(3, { "f-a": { ...fileEntry("ok.md", 1, "a"), by: "Sherin's MacBook Pro" } }), /invalid by/],
    [manifest(3, {}, { tombstones: { "f-old": { path: "a.md", rev: 2, ts: 1700000000000, by: "Sherin's MacBook Pro" } } }), /tombstone by/],
    [manifest(3, {}, { tombstones: { "f-old": { path: "a.md", rev: 2, ts: 1700000000000 } } }), /tombstone by/],
    [manifest(3, {}, { tombstones: { "f-old": { path: "a.md", ts: 1700000000000, by: "m-1a2b3c4d" } } }), /tombstone rev/],
    [manifest(3, { "f-a": { ...fileEntry("ok.md", 1, "a"), by: undefined } }), /invalid by/],
    [manifest(3, {}, { tombstones: { "f-old": { path: "a/../b.md" } } }), /tombstone/],
    [manifest(3, {}, { tombstones: [] }), /tombstones/],
    [manifest(3, {}, { tombstones: { "f-old": { path: "a.md", rev: 2, ts: 1700000000000, by: "m-1a2b3c4d", to: "the finance folder" } } }), /tombstone to/],
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

await test("manifest: only documents sync — a file, a tombstone or a page of anything but markdown, html or a document's comments is refused with a sentence", async () => {
  const etag = await currentEtag();
  const doc = { "f-doc1": fileEntry("Projects/plan.md", 1, "v1") };
  const tomb = (p) => ({ "f-old01": { path: p, rev: 2, ts: 1700000000000, by: "m-1a2b3c4d" } });
  const page = (p) => ({ pic: { kind: "file", file: "f-pic01", path: p, by: "m-1a2b3c4d", at: 1757000000000 } });
  for (const p of ["Projects/chart.png", "deck.PDF", "tools/run.py", "notes.txt", "Projects/plan.md.bak", "Projects/.md", "data.jsonl", "README"]) {
    for (const body of [
      manifest(3, { ...doc, "f-pic01": fileEntry(p, 1, "pic") }),
      manifest(3, doc, { tombstones: tomb(p) }),
      manifest(3, doc, { public: page(p) }),
    ]) {
      const res = await putManifest(body, etag);
      assert.equal(res.status, 400, `${p}: ${res.text}`);
      assert.equal(res.json.error, `Doklin syncs markdown and html documents only — "${p}" is neither`);
    }
  }
  // …in a space as in the shared workspace.
  const space = (await share(OWNER, { name: "Only documents" })).json.space;
  const spaceManifest = await call(`/api/spaces/${space.id}/manifest`, { token: OWNER });
  const inSpace = await call(`/api/spaces/${space.id}/manifest`, {
    method: "PUT",
    token: OWNER,
    headers: { "x-base-etag": spaceManifest.headers.get("x-manifest-etag") },
    body: manifest(1, { "f-pic01": fileEntry("chart.png", 1, "pic") }),
  });
  assert.equal(inSpace.status, 400);
  assert.match(inSpace.json.error, /Doklin syncs markdown and html documents only/);
  assert.equal((await call(`/api/spaces/${space.id}`, { method: "DELETE", token: OWNER })).status, 200);
  assert.equal(await currentEtag(), etag, "nothing outside the rule landed");

  // Every kind of name that does sync, whatever its case; a folder page names a folder, whatever is in its name.
  const synced = manifest(3, {
    "f-md0001": fileEntry("a.md", 1, "a"),
    "f-md0002": fileEntry("b.MARKDOWN", 1, "b"),
    "f-md0003": fileEntry("c.mdown", 1, "c"),
    "f-md0004": fileEntry("d.Mkd", 1, "d"),
    "f-ht0001": fileEntry("e.HTML", 1, "e"),
    "f-me0001": fileEntry("a.meta.jsonl", 1, "f"),
    "f-me0002": fileEntry("Old/B.META.JSONL", 1, "g"),
  }, { tombstones: tomb("gone.md"), public: { assets: { kind: "dir", path: "Projects/v1.2", by: "m-1a2b3c4d", at: 1757000000000 } } });
  const ok = await putManifest(synced, etag);
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await putManifest(manifest(4, {}))).status, 200);
});

await test("manifest: either side of a schema skew is 426, and the sentence says which one is behind", async () => {
  const newer = await putManifest(manifest(3, {}, { version: MANIFEST_VERSION + 1 }));
  assert.equal(newer.status, 426);
  assert.match(newer.json.error, /update the worker/);
  // An app writing an older version is not corrupt, it is behind, and 426 is
  // the status that says so.
  const older = await putManifest(manifest(3, {}, { version: MANIFEST_VERSION - 1 }));
  assert.equal(older.status, 426);
  assert.match(older.json.error, /update the app/);
  assert.equal((await putManifest(manifest(3, {}, { version: String(MANIFEST_VERSION) }))).status, 400, "a version that is not a number is garbage");
});

await test("manifest: Library names its folders what it likes and holds no share; a tombstone may say where its file went; a section says where its shares sit, and a shared document's holds that document alone", async () => {
  const etag = await currentEtag();
  // No name is kept from Library's top: a folder called what a section is called is an ordinary folder.
  const near = await putManifest(
    manifest(3, { "f-near01": fileEntry("My files/diary.md", 1, "n"), "f-near02": fileEntry("Shared with me/x.md", 1, "m"), "f-near03": fileEntry("Library/notes.md", 1, "l"), "f-near04": fileEntry("Private/x.md", 1, "k") }),
  );
  assert.equal(near.status, 200, JSON.stringify(near.json));
  // A file that moved to a section is a tombstone that says so: a space's id, or "" for the shared workspace.
  const moved = await putManifest(
    manifest(4, {}, { tombstones: { "f-near01": { path: "My files/diary.md", rev: 2, ts: 1700000000000, by: "m-1a2b3c4d", to: "p-0a1b2c3d" }, "f-near02": { path: "Shared with me/x.md", rev: 2, ts: 1700000000000, by: "m-1a2b3c4d", to: "" } } }),
  );
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  const bad = await putManifest(manifest(5, {}, { tombstones: { "f-near01": { path: "a.md", rev: 2, ts: 1700000000000, by: "m-1a2b3c4d", to: "nowhere" } } }));
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /tombstone to/);

  // Nothing in Library is shared separately: its manifest says where no share sits.
  const mount = { dir: "Work", rev: 1, by: "m-1a2b3c4d" };
  const inLibrary = await putManifest(manifest(5, {}, { mounts: { "s-0a1b2c3d": mount } }));
  assert.equal(inLibrary.status, 400);
  assert.match(inLibrary.json.error, /Nothing in Library is shared separately/);
  assert.equal((await putManifest(manifest(5, {}, { mounts: {} }))).status, 200, "an empty map says nothing");

  // A My files and a shared folder do: the folder a share's item is in, "" the top, and where it was before.
  const mine = await myFiles(OWNER);
  const put = async (id, body) => {
    const at = (await call(`/api/spaces/${id}/manifest`, { token: OWNER })).headers.get("x-manifest-etag");
    return call(`/api/spaces/${id}/manifest`, { method: "PUT", token: OWNER, headers: { "x-base-etag": at }, body });
  };
  const placed = await put(mine.id, manifest(1, {}, { name: "My files", mounts: { "s-0a1b2c3d": { ...mount, was: "Work/Plans" }, "s-0a1b2c3e": { dir: "", rev: 3, by: "m-1a2b3c4d" } } }));
  assert.equal(placed.status, 200, placed.text);
  for (const [entry, why] of [
    [{ ...mount, dir: "../up" }, /mount dir/],
    [{ ...mount, dir: 4 }, /mount dir/],
    [{ ...mount, rev: 0 }, /mount rev/],
    [{ ...mount, by: "Sherin's Mac" }, /mount by/],
    [{ ...mount, was: "" }, /mount was/],
    ["Work", /invalid mount/],
  ]) {
    const res = await put(mine.id, manifest(2, {}, { name: "My files", mounts: { "s-0a1b2c3d": entry } }));
    assert.equal(res.status, 400, JSON.stringify(entry));
    assert.match(res.json.error, why);
  }
  const notAShare = await put(mine.id, manifest(2, {}, { name: "My files", mounts: { "p-0a1b2c3d": mount } }));
  assert.equal(notAShare.status, 400, "only a share sits anywhere");
  assert.match(notAShare.json.error, /mount id/);
  assert.equal((await put(mine.id, manifest(2, {}, { name: "My files" }))).status, 200);

  // A shared document's section is that document: its files at the top, one name, and nothing else.
  const doc = (await share(OWNER, { name: "Plan", kind: "document" })).json.space;
  const one = { "f-pl0001": fileEntry("Plan.md", 1, "p"), "f-pl0002": fileEntry("Plan.html", 1, "h"), "f-pl0003": fileEntry("plan.meta.jsonl", 1, "c") };
  assert.equal((await put(doc.id, manifest(1, one, { name: "Plan" }))).status, 200);
  for (const [body, what] of [
    [manifest(2, { ...one, "f-ot0001": fileEntry("Other.md", 1, "o") }), "a second document"],
    [manifest(2, { "f-pl0001": fileEntry("Work/Plan.md", 1, "p") }), "a folder"],
    [manifest(2, one, { mounts: { "s-0a1b2c3d": mount } }), "a share inside it"],
    [manifest(2, one, { public: { plans: { kind: "dir", path: "", by: "m-1a2b3c4d", at: 1757000000000 } } }), "a published folder"],
  ]) {
    const res = await put(doc.id, body);
    assert.equal(res.status, 400, what);
    assert.equal(res.json.error, "a shared document's section holds that document and nothing else", what);
  }
  // Renamed, it is still one document — and the database follows its file's name.
  const renamed = await put(doc.id, manifest(2, { "f-pl0001": fileEntry("Budget.md", 2, "p"), "f-pl0003": fileEntry("Budget.meta.jsonl", 2, "c") }, { name: "Plan" }));
  assert.equal(renamed.status, 200, renamed.text);
  const listed = (await call("/api/spaces", { token: OWNER })).json.spaces.find((x) => x.id === doc.id);
  assert.equal(listed.name, "Budget", "a shared document is called what its file is called");
  assert.equal(listed.etag, renamed.json.etag);
  assert.equal((await call(`/api/spaces/${doc.id}`, { method: "DELETE", token: OWNER })).json.kept, true, "it holds a document: kept, to be restored");
  await putManifest(manifest(6, {}));
  assert.notEqual(await currentEtag(), etag);
});

await test("manifest: the public map — slug grammar, reserved words, kinds, references, one root; an entry may outlive its file", async () => {
  const files = { "f-doc1": fileEntry("Projects/plan.md", 1, "v1"), "f-home": fileEntry("Home.md", 1, "home") };
  const good = manifest(4, files, {
    public: {
      k7m2p9qx: { kind: "file", file: "f-doc1", path: "Projects/plan.md", by: "m-1a2b3c4d", at: 1757000000000 },
      roadmap: { kind: "dir", path: "Projects/Roadmap", title: "Roadmap", desc: "What we're building", by: "a-1a2b3c4d", at: 1757000000000 },
      everything: { kind: "dir", path: "", by: "m-1a2b3c4d", at: 1757000000000 },
      home: { kind: "file", file: "f-home", path: "Home.md", root: true, by: "m-1a2b3c4d", at: 1757000000000 },
      // Deleted last week; the page 404s until the file is back. Kept on purpose.
      ghost: { kind: "file", file: "f-gone", path: "Scratch.md", by: "m-1a2b3c4d", at: 1757000000000 },
    },
  });
  const ok = await putManifest(good);
  assert.equal(ok.status, 200, ok.text);
  const stored = JSON.parse((await call("/api/manifest", { token: OWNER })).text);
  assert.equal(Object.keys(stored.public).length, 5);

  const etag = await currentEtag();
  const withPublic = (pub) => manifest(5, files, { public: pub });
  const entry = { kind: "file", file: "f-doc1", path: "Projects/plan.md", by: "m-1a2b3c4d", at: 1757000000000 };
  const { at: _at, ...undated } = entry;
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
    [withPublic({ page: undated }), /at/],
    [withPublic({ page: { ...entry, by: "Sherin's MacBook Pro" } }), /by/],
    [withPublic({ one: { ...entry, root: true }, two: { kind: "dir", path: "", root: true, by: "m-1a2b3c4d", at: 1757000000000 } }), /root/],
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

await test("blobs: content-addressed round-trip; a re-put is a no-op; nobody lists or deletes them (the sweep collects); bad hash, missing, too large", async () => {
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
  assert.equal(got.headers.get("cache-control"), "private, max-age=31536000, immutable", "an address never holds other bytes, so a browser may keep them");

  assert.equal((await call("/api/blobs/f-doc1", { token: OWNER })).status, 404, "no inventory to list");

  // A re-upload of the same bytes is a push about to name the copy again:
  // it is stored again, so the sweep's day starts over. Other bytes at the
  // address change nothing.
  const stored = fake.store.get(`blobs/f-doc1/${hash}`);
  stored.uploaded = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  await call(`/api/blobs/f-doc1/${hash}`, { method: "PUT", token: MEMBER, body: "different bytes, same address" });
  assert.ok(Date.now() - fake.store.get(`blobs/f-doc1/${hash}`).uploaded.getTime() > 2 * 24 * 60 * 60 * 1000, "other bytes leave its age alone");
  const back = await call(`/api/blobs/f-doc1/${hash}`, { method: "PUT", token: MEMBER, headers: { "content-type": "text/markdown" }, body: content });
  assert.equal(back.json.existed, true);
  assert.ok(Date.now() - fake.store.get(`blobs/f-doc1/${hash}`).uploaded.getTime() < 60_000, "the same bytes start its day over");
  assert.equal((await call(`/api/blobs/f-doc1/${hash}`, { token: MEMBER })).text, content);

  assert.equal((await call("/api/blobs/f-doc1/NOTHEX", { token: OWNER })).status, 400);
  assert.equal((await call("/api/blobs/Bad%20Id/" + hash, { token: OWNER })).status, 400);
  assert.equal((await call("/api/blobs", { token: OWNER })).status, 404);
  assert.equal((await call(`/api/blobs/f-doc1/${"0".repeat(16)}`, { token: OWNER })).status, 404);

  assert.equal((await call(`/api/blobs/f-doc1/${hash}`, { method: "DELETE", token: OWNER })).status, 405, "not even the superadmin deletes one");
  assert.equal((await call(`/api/blobs/f-doc1/${hash}`, { token: MEMBER })).text, content, "it is still there");

  const tooBig = new Uint8Array(25 * 1024 * 1024 + 1);
  const rejected = await call(`/api/blobs/f-doc1/${"a".repeat(16)}`, { method: "PUT", token: OWNER, body: tooBig });
  assert.equal(rejected.status, 413);
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
const writes = () => db.queries.filter((sql) => !reads(sql));

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
  assert.equal(mine.memberId, ownerId, "the person whose device it is");
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

  // The poll answers two verbs.
  assert.equal((await call("/api/poll", { method: "PUT", token: OWNER, body: {} })).status, 405);
});

await test("poll: a lapsed row falls out of the window, the next beat sweeps it, and a leave is immediate", async () => {
  db.run(
    "INSERT INTO presence (device_id, member_id, device_name, path, ts, until) VALUES ('d-ghost', 'm-0000dead', 'Ghost', 'Old.md', ?, ?)",
    Date.now() - 10 * 60 * 1000,
    Date.now() - 1000,
  );
  const read = await call("/api/poll", { token: MEMBER });
  assert.ok(!read.json.presence["d-ghost"], "past its until, so not here");
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
  assert.equal((await call(`/api/auth/devices/${gail.tokenId}`, { method: "DELETE", token: OWNER })).status, 204);
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
    "INSERT INTO leases (path, device_id, member_id, device_name, until) VALUES ('old.md', 'd-ghost', 'm-0000dead', 'Ghost', ?)",
    Date.now() - 1000,
  );
  const read = await call("/api/poll", { token: OWNER });
  assert.equal(holder(read, "old.md"), null, "past its until, nobody holds it");
  const taken = await call("/api/poll", { method: "POST", token: MEMBER, device: OTHER_DEVICE, body: { path: "Old.md" } });
  assert.equal(holder(taken, "old.md"), OTHER_DEVICE, "a lapsed lease is free to claim, with no take");

  db.run(
    "INSERT INTO leases (path, device_id, member_id, device_name, until) VALUES ('gone.md', 'd-ghost', 'm-0000dead', 'Ghost', ?)",
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

await test("presence: a beat says how long it holds — 90 s at the least and when it says nothing, 15 min at the most — and its row and its lease lapse then", async () => {
  db.run("DELETE FROM presence");
  db.run("DELETE FROM leases");
  const beat = (ttl, path = "Ttl.md") =>
    call("/api/poll", { method: "POST", token: OWNER, body: { name: "Mac", path, ...(ttl === undefined ? {} : { ttl }) } });
  const held = async (ttl) => {
    const t0 = Date.now();
    await beat(ttl);
    const row = presenceRows().find((r) => r.device_id === DEVICE);
    return { span: row.until - row.ts, row, lease: leaseRows().find((r) => r.path === "ttl.md"), t0 };
  };

  const idle = await held(600_000);
  assert.equal(idle.span, 600_000, "an idle device's beat holds for as long as it says");
  assert.ok(idle.row.ts >= idle.t0 && idle.row.ts <= Date.now());
  assert.equal(idle.lease.until, idle.row.until, "its lease is held to the same moment");
  assert.equal((await held(1000)).span, 90_000, "never shorter than a minute and a half");
  assert.equal((await held(10 * 60 * 60 * 1000)).span, 15 * 60 * 1000, "never longer than a quarter of an hour");
  assert.equal((await held(undefined)).span, 90_000, "a beat that says nothing holds for the shortest");
  assert.equal((await held("long")).span, 90_000, "…and so does one that says nonsense");
  assert.equal((await held(123_456.7)).span, 123_457);

  // Reads and sweeps go by until: a row whose last beat is long ago but
  // whose ttl still holds is here; one whose until has passed is not.
  db.run(
    "INSERT INTO presence (device_id, member_id, device_name, path, ts, until) VALUES ('d-still', ?, 'Still', NULL, ?, ?), ('d-lapsed', ?, 'Lapsed', NULL, ?, ?)",
    ALICE.id, Date.now() - 10 * 60 * 1000, Date.now() + 5 * 60 * 1000,
    ALICE.id, Date.now() - 60 * 1000, Date.now() - 1,
  );
  const read = await call("/api/poll", { token: MEMBER, device: OTHER_DEVICE });
  assert.ok(read.json.presence["d-still"], "ten minutes since its beat, inside its ttl");
  assert.ok(!read.json.presence["d-lapsed"], "a minute since its beat, past its ttl");
  await beat(undefined);
  assert.deepEqual(presenceRows().map((r) => r.device_id).filter((d) => d.startsWith("d-") && d !== DEVICE), ["d-still"], "the next beat sweeps what lapsed, and only that");

  // A leave is immediate, whatever was said.
  await call("/api/poll", { method: "POST", token: OWNER, body: { leave: true } });
  assert.ok(!presenceRows().some((r) => r.device_id === DEVICE));
  assert.ok(!leaseRows().some((r) => r.device_id === DEVICE));
  db.run("DELETE FROM presence");
});

/* ---------- Spaces ---------- */

// Jo and Kim, two more members, and the folders the tests below make — each
// builds on what the one before it left.
let JO;
let KIM;
let FINANCE;
let PLANS;
const spaceCall = (id) => (path, opts = {}) => call(`/api/spaces/${id}${path}`, opts);
const mySpaces = async (token, device = DEVICE) => (await call("/api/spaces", { token, device })).json.spaces;
const polledSpaces = async (token, device = DEVICE) => (await call("/api/poll", { token, device })).json.spaces;
/** Invite an address and trade the code in on a Mac: `{token, tokenId, member}`. */
async function joinAs(email, name, body, deviceId) {
  const invited = await call("/api/auth/invites", {
    method: "POST",
    token: OWNER,
    body: { email, name, codeHash: sha256(body), expiresAt: Date.now() + DAY },
  });
  assert.equal(invited.status, 201, invited.text);
  const joined = await call("/api/auth/join", { method: "POST", body: { code: code(body), deviceId, deviceName: `${name}'s Air` } });
  assert.equal(joined.status, 201, joined.text);
  return joined.json;
}

await test("spaces: anyone shares a folder from their My files — it answers the people it is shared with and its owner, and to everyone else, the superadmin included, it does not exist", async () => {
  JO = await joinAs("jo@example.com", "Jo", "JJJJJJJJJJJJJJJJJJJJ", "d-jo");
  KIM = await joinAs("kim@example.com", "Kim", "KKKKKKKKKKKKKKKKKKKK", "d-kim");
  const alices = await myFiles(MEMBER);
  await myFiles(JO.token);
  const before = db.value("SELECT COUNT(*) FROM spaces");

  const id = shareId();
  const made = await share(MEMBER, { id, name: "  Finance ", members: [JO.member.id] });
  assert.equal(made.status, 201, made.text);
  FINANCE = made.json.space;
  assert.equal(FINANCE.id, id, "the id is the one her device minted");
  assert.equal(FINANCE.kind, "folder");
  assert.equal(FINANCE.name, "Finance");
  assert.equal(FINANCE.by, ALICE.id);
  assert.equal(FINANCE.parent, alices.id, "it sits in her My files — and she is told so, because she can open that");
  assert.equal(FINANCE.owner, ALICE.id, "whose My files it is in: what tells two shares of one name apart");
  assert.deepEqual(FINANCE.members, [JO.member.id], "it is shared with whoever she named — not with her: hers it is already");
  assert.deepEqual(FINANCE.above, [ALICE.id], "she opens it because she opens the folder it sits in");

  // The same id from her again is the same share: a device that never heard the answer asks again.
  const again = await share(MEMBER, { id, name: "Finance", members: [KIM.member.id] });
  assert.equal(again.status, 201);
  assert.deepEqual(again.json.space.members, [JO.member.id, KIM.member.id].sort(), "with those people added");
  assert.equal(db.value("SELECT COUNT(*) FROM spaces WHERE id = ?", id), 1);
  assert.equal((await call(`/api/spaces/${id}/members/${KIM.member.id}`, { method: "DELETE", token: MEMBER })).status, 204);
  // Anybody else's is taken, and so is hers for another thing.
  const taken = await share(JO.token, { id, name: "Finance" });
  assert.equal(taken.status, 409);
  assert.equal(taken.json.code, "id_taken");
  assert.equal((await share(MEMBER, { id, name: "Finance", kind: "document" })).status, 409);

  // A name is a folder's or a file's name on every device it reaches.
  for (const name of ["", "   ", "a/b", "a:b", ".hidden", "..", "x".repeat(201), 7]) {
    assert.equal((await share(MEMBER, { name })).status, 400, JSON.stringify(name));
  }
  const long = await share(MEMBER, { name: "A sentence of a title that is longer than eighty characters, as a document's name may well be" });
  assert.equal(long.status, 201);
  assert.equal((await call(`/api/spaces/${long.json.space.id}`, { method: "DELETE", token: MEMBER })).json.kept, false);
  for (const bad of ["nope", "p-0a1b2c3d", "s-123", "s-0123ABCD", 7]) {
    assert.equal((await share(MEMBER, { name: "X", id: bad })).status, 400, `id ${bad}`);
  }
  assert.equal((await share(MEMBER, { name: "X", kind: "restricted" })).status, 400);
  // Only people here can be shared with.
  const stranger = await share(MEMBER, { name: "X", members: ["m-00000000"] });
  assert.equal(stranger.status, 400);
  assert.deepEqual(stranger.json.unknown, ["m-00000000"]);
  const erin = db.value("SELECT id FROM members WHERE email = 'erin@example.com'");
  assert.deepEqual((await share(MEMBER, { name: "X", members: [erin] })).json.unknown, [erin], "a removed person is not here");
  for (const members of ["jo", ["jo"], [7], { id: JO.member.id }]) {
    assert.equal((await share(MEMBER, { name: "X", members })).status, 400);
  }
  // A share sits in a section its maker can open, that holds folders — never Library.
  const library = await share(MEMBER, { name: "X", parent: "" });
  assert.equal(library.status, 400);
  assert.match(library.json.error, /Nothing in Library is shared separately/);
  assert.equal((await share(MEMBER, { name: "X", parent: (await myFiles(OWNER)).id })).status, 404, "somebody else's My files is no place she knows");
  assert.equal((await share(MEMBER, { name: "X", parent: "s-00000000" })).status, 404);
  assert.equal((await share(MEMBER, { name: "X", parent: "nope" })).status, 400);
  assert.equal(db.value("SELECT COUNT(*) FROM spaces"), before + 1, "a refused request made nothing");

  // The same item shared from two of her devices at once is one share: the second asks under an id of its
  // own, for what sits where the first one's item was and is, and is answered the first — with its people as well.
  const twice = await call("/api/spaces", { method: "POST", token: MEMBER, body: { id: shareId(), kind: "folder", name: "Twice", parent: alices.id, dir: "Work", was: "Work/Twice", members: [JO.member.id] } });
  const again2 = await call("/api/spaces", { method: "POST", token: MEMBER, body: { id: shareId(), kind: "folder", name: "Twice", parent: alices.id, dir: "Work", was: "Work/Twice", members: [KIM.member.id] } });
  assert.deepEqual([again2.status, again2.json.space.id, again2.json.space.members], [201, twice.json.space.id, [JO.member.id, KIM.member.id].sort()]);
  const another = await call("/api/spaces", { method: "POST", token: MEMBER, body: { id: shareId(), kind: "folder", name: "Twice", parent: alices.id, dir: "Home", was: "Home/Twice" } });
  assert.notEqual(another.json.space.id, twice.json.space.id, "a folder of the same name somewhere else is another thing");
  for (const made of [twice, another]) assert.equal((await call(`/api/spaces/${made.json.space.id}`, { method: "DELETE", token: MEMBER })).json.kept, false);

  // Names need not be unique: Jo's own Finance is another share.
  const twin = (await share(JO.token, { name: "Finance" })).json.space;
  assert.notEqual(twin.id, FINANCE.id);
  assert.equal(twin.owner, JO.member.id);
  assert.deepEqual([twin.members, twin.above], [[], [JO.member.id]], "shared with nobody yet, it is a section of its own all the same");

  // Each person is told about what they can open, and nothing else.
  const told = async (token, device) => (await mySpaces(token, device)).filter((x) => x.kind !== "private").map((x) => x.id).sort();
  assert.ok((await told(MEMBER)).includes(FINANCE.id));
  assert.deepEqual(await told(JO.token, "d-jo"), [FINANCE.id, twin.id].sort());
  assert.deepEqual(await told(KIM.token, "d-kim"), []);
  assert.deepEqual(await told(OWNER), (await told(OWNER)).filter((x) => x !== FINANCE.id), "an owner is told nothing: no name, no lock, no count");
  // Somebody it is shared with is not told where it sits: not the section, so not its name or its path.
  const jos = (await mySpaces(JO.token, "d-jo")).find((x) => x.id === FINANCE.id);
  assert.equal(jos.parent, null);
  assert.deepEqual([jos.owner, jos.members, jos.above], [ALICE.id, [JO.member.id], [ALICE.id]], "who can open it, they are told");

  // To anyone who cannot open it, every route is the 404 an id nobody minted gets.
  const unknown = await call("/api/spaces/s-00000000/manifest", { token: OWNER });
  assert.equal(unknown.status, 404);
  const routes = [
    ["GET", "/manifest"],
    ["PUT", "/manifest"],
    ["GET", "/blobs/f-abc123"],
    ["GET", "/blobs/f-abc123/0123456789abcdef"],
    ["GET", "/versions/index"],
    ["PATCH", ""],
    ["DELETE", ""],
    ["POST", "/restore"],
    ["PUT", `/members/${KIM.member.id}`],
    ["DELETE", `/members/${JO.member.id}`],
  ];
  for (const [who, token, device] of [["the superadmin", OWNER, DEVICE], ["a member outside it", KIM.token, "d-kim"]]) {
    for (const [method, path] of routes) {
      const body = method === "PUT" || method === "PATCH" ? { body: {} } : {};
      const res = await call(`/api/spaces/${FINANCE.id}${path}`, { method, token, device, ...body });
      assert.equal(res.status, 404, `${who}: ${method} ${path}`);
      assert.deepEqual(res.json, unknown.json, "the same answer, to the letter");
    }
  }
  assert.equal((await call(`/api/spaces/${FINANCE.id}/manifest`, { token: MEMBER })).status, 200, "its owner gets in");
  assert.equal((await call(`/api/spaces/${FINANCE.id}/manifest`, { token: JO.token, device: "d-jo" })).status, 200, "and the people it is shared with");
  for (const bad of ["nope", "s-123", "m-0123abcd", "s-0123ABCD"]) {
    assert.equal((await call(`/api/spaces/${bad}/manifest`, { token: OWNER })).status, 400, bad);
  }
  assert.equal((await call(`/api/spaces/${FINANCE.id}/manifest`)).status, 401, "and nobody without a bearer");
  assert.equal((await call(`/api/spaces/${FINANCE.id}/nothing`, { token: MEMBER })).status, 404);
  assert.equal((await call("/api/spaces", { method: "DELETE", token: MEMBER })).status, 405);

  // One that holds nothing has nothing to restore: deleting it erases it.
  const gone = await call(`/api/spaces/${twin.id}`, { method: "DELETE", token: JO.token, device: "d-jo" });
  assert.deepEqual(gone.json, { deleted: true, kept: false, purged: 1, remaining: false });
  assert.equal(db.value("SELECT COUNT(*) FROM spaces WHERE id = ?", twin.id), 0);
});

await test("spaces: a space syncs like the workspace does — its own manifest, blobs and versions under its own prefix — and the poll says where each one is", async () => {
  const finance = spaceCall(FINANCE.id);
  const jo = { token: JO.token, device: "d-jo" };
  const sharedBefore = await currentEtag();
  const got = await finance("/manifest", { token: MEMBER });
  assert.equal(got.status, 200);
  assert.deepEqual(got.json, { version: MANIFEST_VERSION, name: "Finance", seq: 0, files: {}, tombstones: {}, public: {} });
  const etag0 = got.headers.get("x-manifest-etag");
  assert.equal(etag0, FINANCE.etag, "the etag the space was made with");
  assert.equal((await finance(`/manifest?since=${etag0}`, { token: MEMBER })).status, 304);

  const body = "# Budget\n";
  const hash = blobHash(body);
  assert.equal((await finance(`/blobs/f-budget01/${hash}`, { method: "PUT", ...jo, body })).status, 200);
  assert.ok(fake.store.has(`spaces/${FINANCE.id}/blobs/f-budget01/${hash}`), "under the space's own prefix");
  assert.ok(!fake.store.has(`blobs/f-budget01/${hash}`), "and nowhere the shared workspace reaches");
  assert.equal((await call(`/api/blobs/f-budget01/${hash}`, { token: MEMBER })).status, 404, "asking the shared workspace for it by id finds nothing");
  assert.equal((await finance(`/blobs/f-budget01/${hash}`, { token: MEMBER })).text, body);

  const next = manifest(1, { "f-budget01": fileEntry("Budget.md", 1, body) }, { name: "Finance" });
  const put = await finance("/manifest", { method: "PUT", ...jo, headers: { "x-base-etag": etag0 }, body: next });
  assert.equal(put.status, 200, put.text);
  const etag1 = put.json.etag;
  const stale = await finance("/manifest", { method: "PUT", token: MEMBER, headers: { "x-base-etag": etag0 }, body: { ...next, seq: 2 } });
  assert.equal(stale.status, 412);
  assert.equal(stale.json.etag, etag1);
  assert.equal(await currentEtag(), sharedBefore, "the shared manifest did not move");
  assert.ok(!(await call("/api/manifest", { token: OWNER })).text.includes("Budget"), "…and names nothing in the folder");

  // One poll says which spaces the caller can open and where each manifest is.
  db.queries.length = 0;
  const polled = await call("/api/poll", { token: JO.token, device: "d-jo" });
  assert.deepEqual(writes(), [], "still a poll that only reads");
  assert.deepEqual(
    polled.json.spaces.filter((x) => x.kind !== "private").map((x) => [x.id, x.kind, x.name, x.etag]),
    [[FINANCE.id, "folder", "Finance", etag1]],
  );
  assert.deepEqual(polled.json.spaces.find((x) => x.id === FINANCE.id).members, FINANCE.members);
  assert.deepEqual((await polledSpaces(KIM.token, "d-kim")).filter((x) => x.kind !== "private"), [], "somebody outside it is told nothing");
  assert.ok(!(await polledSpaces(OWNER)).some((x) => x.id === FINANCE.id));

  // Where the poll thinks a manifest is gets put right by the next read, when a write's note never landed.
  db.run("UPDATE spaces SET etag = 'lost' WHERE id = ?", FINANCE.id);
  await finance("/manifest", { token: MEMBER });
  assert.equal(db.value("SELECT etag FROM spaces WHERE id = ?", FINANCE.id), etag1);

  // The version store is the space's own too.
  const sharedIndex = fake.store.get("versions/index.json")?.etag;
  const index = await finance("/versions/index", { method: "PUT", token: MEMBER, headers: { "x-base-etag": "*" }, body: versionsIndex([]) });
  assert.equal(index.status, 200, index.text);
  assert.ok(fake.store.has(`spaces/${FINANCE.id}/versions/index.json`));
  assert.equal(fake.store.get("versions/index.json")?.etag, sharedIndex, "the workspace's own index is as it was");
  assert.equal((await finance("/versions/index", { token: MEMBER })).status, 200);

  // The home page is the shared workspace's to choose.
  const home = await finance("/manifest", {
    method: "PUT",
    token: MEMBER,
    headers: { "x-base-etag": etag1 },
    body: { ...next, seq: 2, public: { front: { kind: "dir", path: "", root: true, by: "m-1a2b3c4d", at: 1757000000000 } } },
  });
  assert.equal(home.status, 400);
  assert.ok(/home page/.test(home.json.error));
});

await test("spaces: everyone has a My files of their own — made the first time they ask, never anybody else's, and not a thing to rename, share, move or delete", async () => {
  const jo = { token: JO.token, device: "d-jo" };
  const first = await call("/api/spaces/private", { method: "PUT", ...jo });
  assert.equal(first.status, 200, first.text);
  const mine = first.json.space;
  assert.equal(mine.id, `p-${JO.member.id.slice(2)}`, "the person's own id, so asking twice cannot make two");
  assert.equal(mine.kind, "private");
  assert.equal(mine.name, "My files");
  assert.deepEqual([mine.parent, mine.owner, mine.members, mine.above], [null, JO.member.id, [JO.member.id], []]);
  assert.deepEqual((await call("/api/spaces/private", { method: "PUT", ...jo })).json.space, mine, "asking again changes nothing");
  assert.equal(db.value("SELECT COUNT(*) FROM spaces WHERE id = ?", mine.id), 1);
  assert.ok((await polledSpaces(JO.token, "d-jo")).some((s) => s.id === mine.id), "and their poll lists it");
  assert.equal((await call("/api/spaces/private", jo)).status, 405);

  const priv = spaceCall(mine.id);
  assert.equal((await priv("/manifest", jo)).status, 200);
  assert.ok(fake.store.has(`spaces/${mine.id}/manifest.json`));
  for (const [who, token] of [["another member", MEMBER], ["an owner", OWNER]]) {
    assert.equal((await priv("/manifest", { token })).status, 404, `${who} cannot open it`);
  }
  assert.equal((await priv(`/members/${ALICE.id}`, { method: "PUT", ...jo })).status, 409, "one person, never another");
  assert.equal((await priv(`/members/${JO.member.id}`, { method: "DELETE", ...jo })).status, 409);
  assert.equal((await priv("", { method: "PATCH", ...jo, body: { name: "Mine" } })).status, 409);
  assert.equal((await priv("", { method: "PATCH", ...jo, body: { parent: FINANCE.id } })).status, 409);
  const stays = await priv("", { method: "DELETE", ...jo });
  assert.equal(stays.status, 409);
  assert.match(stays.json.error, /Share a folder or a document in it instead/);

  // The superadmin has one like anybody: they are a person from their first device on.
  const me = (await call("/api/meta", { token: OWNER })).json.you.memberId;
  const own = await call("/api/spaces/private", { method: "PUT", token: OWNER });
  assert.equal(own.json.space.id, `p-${me.slice(2)}`);
  // A space is its rows: with no database there is nothing to answer for one.
  for (const bindings of [{ OWNER_TOKEN: KEY, DATA: fake }, { OWNER_TOKEN: KEY, DATA: fake, DB: brokenD1() }]) {
    assert.equal((await call("/api/spaces", { token: OWNER, bindings })).status, 503);
    assert.equal((await call(`/api/spaces/${own.json.space.id}/manifest`, { token: OWNER, bindings })).status, 503);
  }
});

await test("spaces: everyone on a share adds and takes off people and renames it, and may leave; its owner is never taken off, and it stays a section with nobody on it; a person removed from the workspace leaves what was shared with them and keeps their My files", async () => {
  const finance = spaceCall(FINANCE.id);
  const jo = { token: JO.token, device: "d-jo" };
  const kim = { token: KIM.token, device: "d-kim" };

  const added = await finance(`/members/${KIM.member.id}`, { method: "PUT", ...jo });
  assert.equal(added.status, 200, "Jo did not share the folder, and shares it on all the same");
  assert.deepEqual(added.json.space.members, [JO.member.id, KIM.member.id].sort());
  const twice = await finance(`/members/${KIM.member.id}`, { method: "PUT", ...jo });
  assert.deepEqual(twice.json.space.members, added.json.space.members, "adding twice is adding once");
  assert.equal((await finance("/manifest", kim)).status, 200, "and Kim is in, on her next request");
  assert.equal((await finance("/members/m-00000000", { method: "PUT", ...jo })).status, 404, "only people in the workspace");
  assert.equal((await finance("/members/nope", { method: "PUT", ...jo })).status, 400);
  assert.equal((await finance(`/members/${KIM.member.id}`, { method: "POST", ...jo })).status, 405);

  const renamed = await finance("", { method: "PATCH", ...kim, body: { name: "Finance 2026" } });
  assert.equal(renamed.json.space.name, "Finance 2026");
  assert.equal((await finance("", { method: "PATCH", ...kim, body: { name: "a/b" } })).status, 400);
  assert.equal((await polledSpaces(MEMBER)).find((s) => s.id === FINANCE.id).name, "Finance 2026", "everyone who can open it hears the new name on their next poll");

  // Where it sits, and whether it is at all, are its folder's people's to say: Alice's alone.
  for (const [what, ask] of [["move it", { method: "PATCH", body: { parent: (await myFiles(KIM.token)).id } }], ["delete it", { method: "DELETE" }]]) {
    const refused = await finance("", { ...kim, ...ask });
    assert.equal(refused.status, 403, `somebody it is shared with does not ${what}`);
    assert.match(refused.json.error, /You can leave it instead/);
  }
  // Alice cannot be taken off: she opens it through the folder it sits in.
  const owner = await finance(`/members/${ALICE.id}`, { method: "DELETE", ...kim });
  assert.equal(owner.status, 409);
  assert.match(owner.json.error, /nothing in a folder is kept from that folder's people/);
  assert.equal((await finance("/manifest", { token: MEMBER })).status, 200);
  assert.equal((await finance(`/members/${ALICE.id}`, { method: "PUT", ...kim })).status, 200, "shared with her by name as well, she is on it twice over");
  assert.equal((await finance(`/members/${ALICE.id}`, { method: "DELETE", ...kim })).status, 204, "and that is taken back");

  // Kim takes Jo off; then leaves herself, the last one on it.
  assert.equal((await finance(`/members/${JO.member.id}`, { method: "DELETE", ...kim })).status, 204);
  assert.equal((await finance("/manifest", jo)).status, 404, "to Jo it no longer exists");
  assert.deepEqual((await polledSpaces(JO.token, "d-jo")).filter((s) => s.id === FINANCE.id), [], "which is how his Mac learns to delete its copy");
  assert.equal((await finance(`/members/${JO.member.id}`, { method: "DELETE", ...kim })).status, 404, "it is not shared with him to take back");
  assert.equal((await finance(`/members/${KIM.member.id}`, { method: "DELETE", ...kim })).status, 204, "the last one leaves like any other");
  const alone = (await mySpaces(MEMBER)).find((s) => s.id === FINANCE.id);
  assert.deepEqual([alone.members, alone.above, alone.parent !== null], [[], [ALICE.id], true], "shared with nobody, it is Alice's still — and shared again at once");
  assert.equal((await finance(`/members/${KIM.member.id}`, { method: "PUT", token: MEMBER })).status, 200);
  assert.equal((await finance(`/members/${JO.member.id}`, { method: "PUT", token: MEMBER })).status, 200);

  // Removed from the workspace, Kim leaves what was shared with her and keeps her My files — and what she shared from it stays its people's.
  const kims = await myFiles(KIM.token);
  const hers = (await share(KIM.token, { name: "Kim's notes", members: [JO.member.id] })).json.space;
  assert.equal((await call(`/api/auth/members/${KIM.member.id}`, { method: "DELETE", token: OWNER })).status, 204);
  assert.deepEqual(db.rows("SELECT space_id FROM space_members WHERE member_id = ?", KIM.member.id), [{ space_id: kims.id }]);
  assert.ok(!(await mySpaces(MEMBER)).find((s) => s.id === FINANCE.id).members.includes(KIM.member.id));
  assert.equal((await call(`/api/spaces/${hers.id}/manifest`, jo)).status, 200, "what she shared is still open to the people on it");
  // Invited again she is the same person: her My files and what she shared are there, what was shared with her is not.
  KIM = await joinAs("kim@example.com", "Kim", "KKKKKKKKKKKKKKKKKKK2", "d-kim");
  assert.deepEqual((await mySpaces(KIM.token, "d-kim")).map((s) => s.id).sort(), [kims.id, hers.id].sort());
  assert.deepEqual((await call(`/api/spaces/${hers.id}`, { method: "DELETE", token: KIM.token, device: "d-kim" })).json, { deleted: true, kept: false, purged: 1, remaining: false });
});

await test("spaces: sections are a tree — whoever can open a folder can open what is shared from inside it, a share moves under another folder by a change of its parent, and never inside itself", async () => {
  const jo = { token: JO.token, device: "d-jo" };
  const kim = { token: KIM.token, device: "d-kim" };
  const alices = await myFiles(MEMBER);
  // Alice shares a folder inside Finance with Kim alone, and a document of it with nobody.
  const inner = (await share(MEMBER, { name: "Q3", parent: FINANCE.id, members: [KIM.member.id] })).json.space;
  const doc = (await share(MEMBER, { name: "Forecast", kind: "document", parent: inner.id })).json.space;
  assert.deepEqual([inner.parent, inner.owner, inner.members], [FINANCE.id, ALICE.id, [KIM.member.id]]);
  assert.deepEqual(inner.above, [ALICE.id, JO.member.id].sort(), "Finance's people, and its owner: nothing in a folder is kept from them");
  assert.deepEqual([doc.parent, doc.members, doc.above], [inner.id, [], [ALICE.id, JO.member.id, KIM.member.id].sort()]);
  assert.equal((await share(MEMBER, { name: "Inside a document", parent: doc.id })).status, 400, "nothing sits inside a shared document");

  // Jo is on Finance: he opens both, and is told where each sits. Kim is on Q3 alone: she opens Q3 and
  // what is in it, and is told nothing of Finance — not that Q3 sits in it.
  const seen = async (who) => new Map((await mySpaces(who.token, who.device)).map((x) => [x.id, x.parent]));
  assert.deepEqual([...(await seen(jo))].filter(([x]) => [FINANCE.id, inner.id, doc.id].includes(x)).sort(), [[FINANCE.id, null], [inner.id, FINANCE.id], [doc.id, inner.id]].sort());
  assert.deepEqual([...(await seen(kim))].filter(([x]) => [FINANCE.id, inner.id, doc.id].includes(x)).sort(), [[inner.id, null], [doc.id, inner.id]].sort());
  assert.equal((await call(`/api/spaces/${doc.id}/manifest`, kim)).status, 200);
  assert.equal((await call(`/api/spaces/${FINANCE.id}/manifest`, kim)).status, 404);
  // Jo shares from inside Finance too, and then anyone who can open Finance places what he made.
  const jos = (await share(JO.token, { name: "Jo's corner", parent: FINANCE.id })).json.space;
  assert.deepEqual([jos.by, jos.owner, jos.above], [JO.member.id, ALICE.id, [ALICE.id, JO.member.id].sort()]);
  assert.equal((await call(`/api/spaces/${jos.id}`, { method: "DELETE", token: MEMBER })).json.kept, false, "Alice can open Finance, so she deletes it");

  // Taken off Finance, Jo loses everything beneath it that is not shared with him by name.
  assert.equal((await call(`/api/spaces/${FINANCE.id}/members/${JO.member.id}`, { method: "DELETE", token: MEMBER })).status, 204);
  assert.equal((await call(`/api/spaces/${doc.id}/manifest`, jo)).status, 404);
  assert.equal((await call(`/api/spaces/${inner.id}/members/${JO.member.id}`, { method: "PUT", token: MEMBER })).status, 200);
  assert.equal((await call(`/api/spaces/${doc.id}/manifest`, jo)).status, 200, "on Q3, he opens the document in it again");
  assert.equal((await seen(jo)).get(inner.id), null, "and Q3 is no longer in a folder he can open");

  // A share moves by a change of its parent: Alice takes Q3 out of Finance, to the top of her My files.
  const place = (id, parent, who = { token: MEMBER }) => call(`/api/spaces/${id}`, { method: "PATCH", ...who, body: { parent } });
  for (const [to, status, why] of [[inner.id, 400, "itself"], [doc.id, 400, "a document"], ["", 400, "Library"], ["s-00000000", 404, "nowhere"], [7, 400, "not an id"]]) {
    assert.equal((await place(inner.id, to)).status, status, why);
  }
  assert.equal((await place(FINANCE.id, inner.id)).status, 400, "a folder does not go inside what is inside it");
  assert.equal((await place(inner.id, alices.id, kim)).status, 403, "Kim cannot open the folder it sits in, so it is not hers to move");
  const mountsOf = async (id) => (await call(`/api/spaces/${id}/manifest`, { token: MEMBER })).json.mounts ?? {};
  assert.deepEqual((await mountsOf(FINANCE.id))[inner.id], { dir: "", rev: 1, by: ALICE.id }, "Finance's manifest says where Q3 sits in it");
  assert.equal((await mountsOf(inner.id))[FINANCE.id], undefined, "a move that was refused wrote nothing");
  const moved = await call(`/api/spaces/${inner.id}`, { method: "PATCH", token: MEMBER, body: { parent: alices.id, dir: "Work/2026" } });
  assert.equal(moved.status, 200, moved.text);
  assert.deepEqual([moved.json.space.parent, moved.json.space.above], [alices.id, [ALICE.id]]);
  assert.deepEqual((await mountsOf(alices.id))[inner.id], { dir: "Work/2026", rev: 1, by: ALICE.id }, "the section it went to says where it sits now");
  assert.equal((await mountsOf(FINANCE.id))[inner.id], undefined, "and the one it left says nothing of it");
  assert.deepEqual((await place(inner.id, alices.id)).json.space.parent, alices.id, "where it is already is no change");
  assert.equal((await place(inner.id, FINANCE.id)).status, 200, "and back");
  assert.equal(db.value("SELECT parent FROM spaces WHERE id = ?", doc.id), inner.id, "what sits in it went with it, untouched");
  PLANS = inner;
});

await test("spaces: presence and leases are by space — what somebody has open in a share is told to the people who can open it, and to nobody else", async () => {
  const jo = { token: JO.token, device: "d-jo" };
  const held = (answer, space) =>
    answer.json.leases.filter((l) => l.path === "q3.md" && (l.space ?? "") === space).map((l) => l.deviceId);

  const beat = await call("/api/poll", { method: "POST", ...jo, body: { name: "Jo's Air", space: PLANS.id, path: "Q3.md" } });
  assert.equal(beat.status, 200);
  assert.equal(beat.json.presence["d-jo"].path, "Q3.md");
  assert.equal(beat.json.presence["d-jo"].space, PLANS.id);
  assert.deepEqual(held(beat, PLANS.id), ["d-jo"], "a beat claims the document in its space");

  // Alice opens it through the folder it sits in: she is told what Jo has open, and that it is held.
  const alice = await call("/api/poll", { token: MEMBER });
  assert.equal(alice.json.presence["d-jo"].path, "Q3.md");
  assert.equal(alice.json.presence["d-jo"].space, PLANS.id);
  assert.deepEqual(held(alice, PLANS.id), ["d-jo"]);
  // The superadmin cannot: Jo is here, and that is all.
  const owner = await call("/api/poll", { token: OWNER });
  assert.equal(owner.json.presence["d-jo"].name, "Jo's Air");
  assert.equal(owner.json.presence["d-jo"].path, undefined, "not the path");
  assert.equal(owner.json.presence["d-jo"].space, undefined, "not even which space");
  assert.deepEqual(owner.json.leases.filter((l) => l.space), [], "and no lease in a space they cannot open");

  // The same path in the shared workspace is another document.
  const shared = await call("/api/poll", { method: "POST", token: OWNER, body: { name: "Sherin's MacBook Pro", path: "Q3.md" } });
  assert.deepEqual(held(shared, ""), [DEVICE], "the owner holds the shared one");
  const both = await call("/api/poll", { token: MEMBER });
  assert.deepEqual([held(both, ""), held(both, PLANS.id)], [[DEVICE], ["d-jo"]], "two leases, one a space apart");

  // A beat that names a space the caller cannot open is a beat with no document.
  const sneaky = await call("/api/poll", {
    method: "POST",
    token: OWNER,
    body: { name: "Sherin's MacBook Pro", space: PLANS.id, path: "Q3.md", take: true },
  });
  assert.equal(sneaky.status, 200);
  assert.equal(sneaky.json.presence[DEVICE].path, undefined);
  assert.equal(db.value("SELECT device_id FROM leases WHERE space_id = ? AND path = 'q3.md'", PLANS.id), "d-jo", "Jo still holds it, take or no take");
  assert.equal(db.value("SELECT COUNT(*) FROM leases WHERE device_id = ?", DEVICE), 0, "and the Mac that asked holds nothing");

  // Taken off it, what Jo had open there stops being his.
  assert.equal((await call(`/api/spaces/${PLANS.id}/members/${JO.member.id}`, { method: "DELETE", token: MEMBER })).status, 204);
  assert.equal(db.value("SELECT COUNT(*) FROM leases WHERE space_id = ?", PLANS.id), 0);
  assert.deepEqual(db.rows("SELECT space_id, path FROM presence WHERE device_id = 'd-jo'"), [{ space_id: "", path: null }]);
  for (const who of [jo, { token: OWNER }]) await call("/api/poll", { method: "POST", ...who, body: { leave: true } });
});

await test("spaces: a deleted share is kept — nobody opens it or what sat in it, its pages stop answering, and whoever can open the folder it sat in restores it whole for thirty days; then the sweep erases it", async () => {
  const kim = { token: KIM.token, device: "d-kim" };
  const plans = spaceCall(PLANS.id);
  const doc = db.value("SELECT id FROM spaces WHERE parent = ?", PLANS.id);
  const body = "# Plan\n";
  const hash = blobHash(body);
  await plans(`/blobs/f-plan0001/${hash}`, { method: "PUT", token: MEMBER, body });
  // Sharing a document from inside it wrote where that sits: its manifest says so, and has moved on.
  const held0 = await plans("/manifest", { token: MEMBER });
  assert.deepEqual(held0.json.mounts, { [doc]: { dir: "", rev: 1, by: ALICE.id } });
  const put = await plans("/manifest", {
    method: "PUT",
    token: MEMBER,
    headers: { "x-base-etag": held0.headers.get("x-manifest-etag") },
    body: manifest(1, { "f-plan0001": fileEntry("Plan.md", 1, body) }, { name: "Q3", mounts: held0.json.mounts, public: { "q3-plan": { kind: "file", file: "f-plan0001", path: "Plan.md", by: ALICE.id, at: 1757000000000 } } }),
  });
  assert.equal(put.status, 200, put.text);
  assert.equal((await call("/q3-plan", { device: null })).status, 200, "its page answers");
  const others = () => [...fake.store.keys()].filter((k) => !k.startsWith(`spaces/${PLANS.id}/`)).sort();
  const before = others();
  const stored = () => [...fake.store.keys()].filter((k) => k.startsWith(`spaces/${PLANS.id}/`)).sort();
  const held = stored();
  const sharedBefore = await currentEtag();

  assert.equal((await plans("", { method: "DELETE", token: OWNER })).status, 404, "not an owner's to delete: to them there is no such thing");
  assert.equal((await plans("", { method: "DELETE", ...kim })).status, 403, "nor somebody's it is shared with");
  const gone = await plans("", { method: "DELETE", token: MEMBER });
  assert.deepEqual(gone.json, { deleted: true, kept: true });
  assert.deepEqual(stored(), held, "everything it stored is still stored");
  assert.equal(db.value("SELECT COUNT(*) FROM space_members WHERE space_id = ?", PLANS.id), 1, "and so are its people");
  // Nobody opens it, or what sat in it; to the people it was shared with it is simply gone.
  for (const who of [{ token: MEMBER }, kim]) {
    for (const id of [PLANS.id, doc]) assert.equal((await call(`/api/spaces/${id}/manifest`, who)).status, 404);
  }
  assert.deepEqual((await polledSpaces(KIM.token, "d-kim")).filter((x) => [PLANS.id, doc].includes(x.id)), []);
  assert.equal((await call("/q3-plan", { device: null })).status, 404, "its page stops answering");
  assert.ok(!(await call("/api/pages", { token: OWNER })).json.pages.some((p) => p.slug === "q3-plan"), "and is on no list of pages");
  assert.equal((await share(MEMBER, { name: "Into the deleted", parent: PLANS.id })).status, 404);
  // Whoever can open the folder it sat in is told it can be restored: it, not what sat in it.
  const told = (await polledSpaces(MEMBER)).filter((x) => x.deletedAt !== undefined);
  assert.deepEqual(told.map((x) => [x.id, x.name, x.parent]), [[PLANS.id, "Q3", FINANCE.id]]);
  assert.ok(Math.abs(told[0].deletedAt - Date.now()) < 5000);

  // Restored, it is as it was: its files, its people, what sat in it, its page.
  assert.equal((await plans("/restore", { method: "POST", ...kim })).status, 404, "not hers to restore");
  assert.equal((await call(`/api/spaces/${doc}/restore`, { method: "POST", token: MEMBER })).status, 409, "what sat in it comes back with it, not before it");
  assert.equal((await plans("/restore", { method: "GET", token: MEMBER })).status, 405);
  const back = await plans("/restore", { method: "POST", token: MEMBER });
  assert.equal(back.status, 200, back.text);
  assert.deepEqual([back.json.space.members, back.json.space.parent, back.json.space.deletedAt], [[KIM.member.id], FINANCE.id, undefined]);
  assert.equal((await plans("/restore", { method: "POST", token: MEMBER })).status, 404, "it is not deleted to restore");
  for (const id of [PLANS.id, doc]) assert.equal((await call(`/api/spaces/${id}/manifest`, kim)).status, 200);
  assert.equal((await call("/q3-plan", { device: null })).status, 200);
  assert.deepEqual(others(), before, "nothing else in the bucket was touched");
  assert.equal(await currentEtag(), sharedBefore);

  // A share deleted while the folder it sits in is deleted stays so when the folder comes back.
  assert.equal((await call(`/api/spaces/${doc}`, { method: "DELETE", token: MEMBER })).json.kept, false, "the document's section holds nothing: erased at once");
  const early = (await share(MEMBER, { name: "Early", parent: PLANS.id })).json.space;
  const earlyManifest = await call(`/api/spaces/${early.id}/manifest`, { method: "PUT", token: MEMBER, headers: { "x-base-etag": early.etag }, body: manifest(1, { "f-early001": fileEntry("e.md", 1, "e") }, { name: "Early" }) });
  assert.equal(earlyManifest.status, 200);
  assert.equal((await call(`/api/spaces/${early.id}`, { method: "DELETE", token: MEMBER })).json.kept, true);
  db.run("UPDATE spaces SET deleted_at = deleted_at - 1000 WHERE id = ?", early.id);
  assert.equal((await plans("", { method: "DELETE", token: MEMBER })).json.kept, true);
  assert.equal((await plans("/restore", { method: "POST", token: MEMBER })).status, 200);
  assert.equal((await call(`/api/spaces/${early.id}/manifest`, { token: MEMBER })).status, 404, "deleted on its own, it is restored on its own");
  assert.equal((await call(`/api/spaces/${early.id}/restore`, { method: "POST", token: MEMBER })).status, 200);

  // Thirty days on the sweep erases it: what it stored, what sat in it, then its rows.
  assert.equal((await plans("", { method: "DELETE", token: MEMBER })).json.kept, true);
  const sweep = async () => {
    const log = console.log;
    console.log = () => {};
    try {
      await worker.scheduled({ cron: "17 3 * * *", scheduledTime: Date.now() }, env, { waitUntil() {} });
    } finally {
      console.log = log;
    }
  };
  db.run("UPDATE spaces SET deleted_at = deleted_at - ? WHERE deleted_at IS NOT NULL", 29 * DAY);
  await sweep();
  assert.equal(db.value("SELECT COUNT(*) FROM spaces WHERE id IN (?, ?)", PLANS.id, early.id), 2, "a day short, it is all still there");
  db.run("UPDATE spaces SET deleted_at = deleted_at - ? WHERE deleted_at IS NOT NULL", 2 * DAY);
  await sweep();
  assert.equal(db.value("SELECT COUNT(*) FROM spaces WHERE id IN (?, ?)", PLANS.id, early.id), 0);
  assert.equal(db.value("SELECT COUNT(*) FROM space_members WHERE space_id = ?", PLANS.id), 0);
  assert.equal(db.value("SELECT COUNT(*) FROM addresses WHERE space_id = ?", PLANS.id), 0);
  assert.deepEqual([...fake.store.keys()].filter((k) => k.startsWith(`spaces/${PLANS.id}/`) || k.startsWith(`spaces/${early.id}/`)), []);
  assert.deepEqual((await polledSpaces(MEMBER)).filter((x) => x.deletedAt !== undefined), []);
  assert.ok(fake.store.has(`spaces/${FINANCE.id}/manifest.json`), "the folder it sat in is as it was");
  assert.equal((await call(`/api/spaces/${FINANCE.id}`, { method: "DELETE", token: MEMBER })).json.kept, true);
});

await test("poll: a database that fails past the sign-in costs presence, leases and spaces, never the etag", async () => {
  const etag = await currentEtag();
  for (const bindings of [{ OWNER_TOKEN: KEY, DATA: fake, DB: failingPast(/presence|leases|space/) }]) {
    const read = await call("/api/poll", { token: OWNER, bindings });
    assert.equal(read.status, 200, "presence is never on the sync path");
    assert.equal(read.json.manifestEtag, etag);
    assert.deepEqual(read.json.presence, {});
    assert.equal(read.json.leases, null, "not 'nobody holds anything' — the database could not say");
    assert.equal(read.json.spaces, null, "nor which spaces they are in");
    const beat = await call("/api/poll", { method: "POST", token: OWNER, bindings, body: { name: "Mac", path: "Home.md" } });
    assert.equal(beat.status, 200, "…not even when it carries a beat nobody can write");
    assert.equal(beat.json.manifestEtag, etag);
    assert.deepEqual(beat.json.presence, {});
    assert.equal(beat.json.leases, null, "no lease is no lock, and never a refused poll");
  }
});

/* ---------- The public surface ---------- */

const pub = (path, init = {}) => call(path, { device: null, ...init });
const rawGet = async (path, init = {}, bindings = env) => {
  const res = await worker.fetch(new Request(`https://notes.example.com${path}`, init), bindings);
  return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
};
const between = (text, a, b) => text.indexOf(a) >= 0 && text.indexOf(b) > text.indexOf(a);

/** The web directory beside a bundle, through the asset layer in front of it. */
async function webDirectory(fonts) {
  const robots = await pub("/robots.txt");
  assert.equal(robots.status, 200);
  assert.match(robots.text, /User-agent: \*/);
  const ico = await rawGet("/favicon.ico");
  assert.equal(ico.status, 200);
  assert.equal(ico.headers.get("content-type"), "image/x-icon");
  assert.match(ico.headers.get("cache-control"), /max-age=604800, immutable/);
  assert.ok(ico.bytes.equals(readFileSync(path.join(workerDir, "..", "public", "favicon.ico"))), "the app's own favicon");
  const apple = await rawGet("/apple-touch-icon.png");
  assert.equal(apple.headers.get("content-type"), "image/png");
  assert.ok(apple.bytes.equals(readFileSync(path.join(workerDir, "..", "public", "apple-touch-icon.png"))), "the app's own icon");
  const og = await rawGet("/og.png");
  assert.equal(og.status, 200);
  assert.equal(og.headers.get("content-type"), "image/png");
  assert.equal(og.bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "a PNG");
  assert.ok(og.bytes.length > 10000, "the real image, not a placeholder");
  assert.equal((await pub("/_headers")).status, 404, "the rules file is read, never served");

  // The flowchart module, at the tag the worker's pages carry (the diagram
  // test below checks a page asks for it there) — and only there.
  const tags = readdirSync(path.join(webDir, "__web")).filter((d) => d !== "fonts");
  assert.equal(tags.length, 1, "one flowchart build in the web directory");
  const [tag] = tags;
  assert.match(tag, /^[0-9a-f]{12}$/, "a content tag");
  const module = await pub(`/__web/${tag}/flowchart.js`);
  assert.equal(module.status, 200);
  assert.match(module.headers.get("content-type"), /javascript/);
  assert.equal(module.headers.get("cache-control"), "public, max-age=31536000, immutable", "one Cache-Control rule matches");
  assert.equal(module.headers.get("x-robots-tag"), "noindex");
  assert.ok(module.text.includes("layoutFlowchart") && module.text.includes("sceneSvg"), "with the app's flowchart renderer");
  assert.ok(module.text.includes("pre[data-dk-flowchart] > code"), "and it draws a page's flowcharts itself: no page carries a script for it");
  assert.ok(!/from\s*["']d3/.test(module.text) && !module.text.includes("d3-selection"), "the layout engine alone, without the drawing library it ships beside");
  assert.equal(module.headers.get("x-content-type-options"), "nosniff");
  assert.equal(robots.headers.get("x-content-type-options"), "nosniff", "every file the web directory serves");
  assert.equal(createHash("sha256").update(module.bytes).digest("hex").slice(0, 12), tag, "the tag is the module's hash");
  assert.equal((await pub("/__web/abc123/flowchart.js")).status, 404, "another tag names nothing");

  // The fonts the app bundles, byte for byte.
  for (const [family, file] of fonts) {
    const vendored = readFileSync(path.join(workerDir, "..", "src", "assets", "fonts", family, file));
    const font = await rawGet(`/__web/fonts/${file}`);
    assert.equal(font.status, 200, file);
    assert.equal(font.headers.get("content-type"), "font/woff2");
    assert.equal(font.headers.get("cache-control"), "public, max-age=604800, immutable");
    assert.equal(font.headers.get("x-content-type-options"), "nosniff");
    assert.ok(font.bytes.equals(vendored), `${file}: the app's own file`);
  }
  assert.equal((await rawGet("/__web/fonts/inter-latin-opsz-normal.woff2", { method: "HEAD" })).bytes.length, 0);
  for (const p of ["/__web/fonts/nope.woff2", "/__web/fonts/", "/__web/fonts/inter/inter-latin-opsz-normal.woff2"]) {
    assert.equal((await pub(p)).status, 404, p);
  }
}

await test(`the browser version: ${bundlePath ? "its page, scripts and frame page from the web directory, each under its own policy" : "nothing at /app from a source compile, and no page of the workspace's either"}`, async () => {
  if (!webDir) {
    // No web directory: /app is nobody's. It is a reserved address, so the
    // worker does not take it for a page's either.
    assert.equal((await pub("/app")).status, 404);
    assert.equal((await pub("/app/frame")).status, 404);
    return;
  }
  const page = await pub("/app");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.equal(page.headers.get("cache-control"), "no-cache", "one Cache-Control rule matches, and it is not kept");
  const policy = page.headers.get("content-security-policy");
  assert.ok(!policy.includes(","), "one policy: two rules matching would be two, both enforced");
  assert.match(policy, /(^|; )script-src 'self'(;|$)/, "script from this domain's files only");
  assert.match(policy, /(^|; )frame-ancestors 'none'(;|$)/, "framed by nobody");
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(page.headers.get("x-robots-tag"), "noindex");
  assert.ok(!/<script(?![^>]* src=)[^>]*>/.test(page.text), "the page carries no script of its own: its policy would refuse one");
  for (const spelled of ["/app.html", "/app/"]) {
    const sent = await rawGet(spelled);
    assert.equal(sent.status, 307, spelled);
    assert.equal(sent.headers.get("location"), "/app");
  }

  // Everything the page names is under /app/, and there.
  const named = [...page.text.matchAll(/(?:src|href)="(\/app\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(named.includes("/app/gate.js"), "the gate, by its own name");
  const entry = named.find((n) => /^\/app\/assets\/.+\.js$/.test(n));
  assert.ok(entry, "and the app's script, by its content's");
  for (const file of named) assert.equal((await rawGet(file)).status, 200, file);
  const script = await rawGet(entry);
  assert.match(script.headers.get("content-type"), /javascript/);
  assert.equal(script.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(script.headers.get("content-security-policy"), null, "a policy is a page's");
  const gate = await pub("/app/gate.js");
  assert.ok(gate.text === readFileSync(path.join(workerDir, "..", "src", "web", "gate.js"), "utf8"), "the gate as it was written: an old browser has to read it");
  assert.doesNotThrow(() => new Function(gate.text), "and it is a script by itself");

  // The page an html document is shown in: sandboxed, and nothing of the page's policy.
  const frame = await pub("/app/frame");
  assert.equal(frame.status, 200);
  assert.equal(frame.headers.get("content-security-policy"), "sandbox allow-scripts allow-popups; frame-ancestors 'self'");
  assert.equal(frame.headers.get("cache-control"), "no-cache");
  assert.ok(frame.text.includes("frame-html") && frame.text.includes("frame-ready"), "it asks for the markup and becomes it");
});

await test(`public: the landing page; robots, icons, the OG image, fonts and the flowchart module (${bundlePath ? "from the web directory" : "404s: a source compile has no web directory"}); an empty folder page; anything else a 404 page`, async () => {
  // The map the validation test left names a root page whose blob never
  // arrived: the domain root IS that page, and it is not there yet.
  const root = await pub("/");
  assert.equal(root.status, 404);
  assert.match(root.headers.get("content-type"), /text\/html/);
  assert.ok(root.text.includes("Nothing here") && root.text.includes('<meta name="robots" content="noindex">'));
  const head = await rawGet("/", { method: "HEAD" });
  assert.equal(head.status, 404);
  assert.equal(head.bytes.length, 0, "HEAD carries no body");

  const fonts = [
    ["inter", "inter-latin-opsz-normal.woff2"],
    ["literata", "literata-latin-opsz-italic.woff2"],
    ["roboto-mono", "roboto-mono-latin-ext-wght-normal.woff2"],
  ];
  const assetPaths = ["/robots.txt", "/favicon.ico", "/apple-touch-icon.png", "/og.png", "/__web/abc123/flowchart.js", ...fonts.map(([, f]) => `/__web/fonts/${f}`)];
  // What reaches the worker at those paths names nothing: the web directory
  // answers them on a domain, and the worker 404s without reading the bucket.
  const noBucket = { ...env, DATA: new Proxy({}, { get: () => () => { throw new Error("the bucket was read"); } }) };
  for (const p of [...assetPaths, "/__web/x/app.js"]) {
    const served = bundlePath && p !== "/__web/abc123/flowchart.js" && p !== "/__web/x/app.js";
    assert.equal((await rawGet(p, {}, noBucket)).status, served ? 200 : 404, p);
  }

  if (bundlePath) await webDirectory(fonts);

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
  assert.equal(md.text.match(/<h1[ >]/g)?.length, 1, "a note that opens with its own heading keeps it, and gets no second one");
  assert.ok(md.text.includes('<a class="view-seg is-active" href="https://notes.example.com/plan?v=md">MD</a>'));
  assert.ok(!md.text.includes("<iframe"));

  const raw = await pub("/plan/raw");
  assert.equal(raw.status, 200);
  assert.equal(raw.text, SEED_FILES["Projects/plan.html"], "byte for byte");
  assert.match(raw.headers.get("content-type"), /text\/html/);
  assert.equal(raw.headers.get("content-security-policy"), "sandbox allow-scripts allow-popups", "an opaque origin, framed or not");
  assert.equal(raw.headers.get("x-robots-tag"), "noindex");
});

await test("public: a folder page lists every note under it; nested URLs render with the crumb; an html document inside serves by exact path; anything else, or a path that walks out, is a 404", async () => {
  const toc = await pub("/projects");
  assert.equal(toc.status, 200);
  assert.ok(toc.text.includes('<h1 class="toc-title">Projects</h1>'));
  assert.ok(toc.text.includes('<p class="toc-desc">Everything we&#39;re building</p>'));
  assert.ok(toc.text.includes("5 pages"), toc.text.match(/toc-meta">[^<]*/)?.[0]);
  for (const href of [
    "/projects/plan",
    "/projects/status",
    "/projects/Roadmap/Ship%20the%20boat",
    "/projects/Roadmap/Paint%20it",
    "/projects/Roadmap/Launch",
  ]) {
    assert.ok(toc.text.includes(`href="${href}"`), href);
  }
  assert.ok(toc.text.includes('class="toc-tree toc-cards"'), "a handful of pages lists as cards");
  assert.ok(toc.text.includes('<span class="toc-card-path">Roadmap</span>'), "a card wears its folder");
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

  const unheaded = await pub("/projects/Roadmap/Ship%20the%20boat");
  assert.equal(unheaded.status, 200);
  assert.ok(unheaded.text.includes("<title>Ship the boat</title>"), "a note without a heading is named after its file");
  assert.ok(unheaded.text.includes('<main class="doc">\n<h1>Ship the boat</h1>\n'), "and its name is drawn above it, as the app draws it");
  assert.ok(unheaded.text.includes("The hull is done."));

  const rendition = await rawGet("/projects/plan.html");
  assert.equal(rendition.status, 200, "an html file by its exact path");
  assert.match(rendition.headers.get("content-type"), /text\/html/);
  assert.equal(rendition.headers.get("content-security-policy"), "sandbox allow-scripts allow-popups");
  assert.equal(rendition.bytes.toString("utf8"), SEED_FILES["Projects/plan.html"]);

  for (const p of [
    "/projects/assets/pic.png",
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

await test("public: a note's frontmatter block is left off its page; a note that merely opens with a rule keeps it", async () => {
  const ship = await pub("/ship");
  assert.equal(ship.status, 200);
  for (const words of ["status:", "In progress", "owner:", "tags:"]) assert.ok(!ship.text.includes(words), `${words} stays in the file`);
  assert.ok(!ship.text.includes("<hr"), "the block never reaches marked");
  assert.ok(between(ship.text, '<main class="doc">\n<h1>Ship the boat</h1>\n<p>The hull is done.</p>', "</main>"), "the document is its name and the body alone");
  assert.ok(ship.text.includes('<meta name="description" content="The hull is done.">'), "and so is the description");
  const launch = await pub("/projects/Roadmap/Launch");
  assert.ok(between(launch.text, "<hr>", "<p>We launched.</p>"), "a rule with no closing fence is the note's own");
});

await test("public: every page wears the app's own theme — its tokens light and dark, its bundled fonts — with nothing the browser can't ask for", async () => {
  const tokens = readFileSync(path.join(workerDir, "..", "src", "styles", "tokens.css"), "utf8");
  const block = (selector) => tokens.slice(tokens.indexOf(`${selector} {`)).split("}")[0];
  const value = (selector, name) => block(selector).match(new RegExp(`${name}: ([^;]+);`))[1];
  const light = { sheet: value('[data-theme="light"]', "--sheet"), link: value('[data-theme="light"]', "--link") };
  const dark = { sheet: value('[data-theme="dark"]', "--sheet"), link: value('[data-theme="dark"]', "--link") };
  const paper = value('[data-theme="paper"]', "--sheet");
  assert.notEqual(light.link, dark.link, "the file's two palettes differ, so the checks below mean something");
  for (const p of ["/home", "/projects", "/plan", "/nope", "/"]) {
    const res = await pub(p);
    const css = res.text.slice(res.text.indexOf("<style>"), res.text.indexOf("</style>"));
    const media = css.indexOf("@media (prefers-color-scheme: dark)");
    assert.ok(media > 0, `${p}: the dark palette answers the reader's preference`);
    assert.ok(css.slice(0, media).includes(`--link: ${light.link}`) && css.slice(0, media).includes(`--sheet: ${light.sheet}`), `${p}: light is :root`);
    assert.ok(css.slice(media).includes(`--link: ${dark.link}`) && css.slice(media).includes(`--sheet: ${dark.sheet}`), `${p}: dark under the media query`);
    assert.ok(
      !css.includes("data-theme") && !css.includes(paper),
      `${p}: no palette a browser can't ask for`,
    );
    assert.ok(
      ["inter-latin-opsz-normal", "literata-latin-opsz-normal", "roboto-mono-latin-wght-normal"].every((f) => css.includes(`url("/__web/fonts/${f}.woff2")`)) &&
        !css.includes("../assets"),
      `${p}: the faces point at the worker`,
    );
    assert.ok(!css.includes("Design tokens") && !css.includes("SIL Open Font License"), `${p}: the app's comments stay in its files`);
  }
  const note = await pub("/home");
  for (const f of ["inter-latin-opsz-normal", "literata-latin-opsz-normal"]) {
    assert.ok(note.text.includes(`<link rel="preload" href="/__web/fonts/${f}.woff2" as="font" type="font/woff2" crossorigin>`), `a note asks for ${f} early`);
  }
  assert.ok(!(await pub("/plan")).text.includes('rel="preload"'), "a framed rendition sets no type of its own, so fetches none");
});

await test("public: column widths come from the meta sidecar under the app's own table identity; comment markers are stripped; the flowchart module is named only on pages with a flowchart", async () => {
  const sizes = await pub("/sizes");
  assert.ok(
    sizes.text.includes('<table class="dk-cols"><colgroup><col style="width:260px"><col><col style="width:140px"></colgroup>'),
    "the record found its table — the same id the desktop derived (pinned in verify-harness/tablewidths.test.mjs)",
  );
  assert.ok(sizes.text.includes('class="dk-table-scroll"'));
  assert.ok(!sizes.text.includes("flowchart.js"), "no flowchart, no script");

  const comments = await pub("/comments");
  assert.ok(comments.text.includes("A sentence with a highlighted phrase and more after it."), "the highlight unwrapped, the marker gone");
  assert.ok(!comments.text.includes("{==") && !comments.text.includes("<<}") && !comments.text.includes("plain1"));
  assert.ok(!comments.text.includes("Say it plainer"), "bodies never leave the sidecar");

  const diagram = await pub("/diagram");
  assert.ok(
    diagram.text.includes('<pre data-dk-flowchart><code class="language-mermaid">flowchart LR'),
    "a flowchart's source stays a code block for readers without scripts, marked for the module",
  );
  assert.ok(
    diagram.text.includes('<pre><code class="language-mermaid">sequenceDiagram'),
    "another kind of Mermaid diagram is a plain code block: nothing draws it",
  );
  const asked = diagram.text.match(/<script type="module" src="(\/__web\/[a-z0-9]+\/flowchart\.js)"><\/script>\n<\/body>/)?.[1];
  assert.ok(asked, "the page names the tagged module, which draws its flowcharts");
  if (bundlePath) assert.equal((await rawGet(asked)).status, 200, "at the path the web directory serves it");
  else assert.equal(asked, "/__web/dev/flowchart.js", "a source compile tags its module dev");

  // Drawings are drawn by the worker itself, through the app's sanitizer:
  // no script needed, each with its own ids, nothing executable kept, and
  // one that doesn't parse stays its source.
  const figures = diagram.text.match(/<figure class="dk-drawing"><svg [^>]*>/g) ?? [];
  assert.equal(figures.length, 2, "two drawings drawn");
  assert.ok(diagram.text.includes('id="dg1-arrow"') && diagram.text.includes('url(#dg1-arrow)'), "the first drawing's marker, namespaced");
  assert.ok(diagram.text.includes('id="dg2-arrow"') && diagram.text.includes('url(#dg2-arrow)'), "the second keeps its own");
  const drawn = diagram.text.slice(diagram.text.indexOf('<figure class="dk-drawing">'), diagram.text.lastIndexOf("</figure>"));
  assert.ok(!drawn.includes("<script") && !drawn.includes("onclick") && !drawn.includes("alert("), "nothing executable survives");
  assert.ok(diagram.text.includes('<code class="language-svg">&lt;svg viewBox=&quot;0 0 760 80&quot;&gt;&lt;g&gt;&lt;/svg&gt;'), "a drawing that doesn't parse stays its source");

  // Callouts: a top-level quote opening with a marker is drawn as the app
  // draws it, the marker gone; one with a title after the marker, and one
  // inside a list, stay quotes, as GitHub shows them.
  const ideas = await pub("/ideas");
  assert.ok(
    ideas.text.includes('<div class="callout callout-warning" role="note"><p class="callout-title"><svg class="callout-icon"') &&
      ideas.text.includes('Warning</p><div class="callout-body"><p>Both need <em>fuel</em>.</p>'),
    "a callout: its title, then its body without the marker",
  );
  assert.ok(ideas.text.includes('<div class="callout callout-note" role="note">') && ideas.text.includes("<p>A marker in lowercase.</p>"), "a marker in any case");
  assert.equal((ideas.text.match(/class="callout /g) ?? []).length, 2, "two callouts, no more");
  assert.ok(ideas.text.includes("<blockquote>\n<p>[!NOTE] A title after the marker</p>"), "a title after the marker leaves a quote");
  assert.ok(/<li>[\s\S]*<blockquote>\n<p>\[!TIP\]/.test(ideas.text), "a quote in a list stays a quote");
  const description = ideas.text.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "";
  assert.ok(description.includes("Both need fuel") && !description.includes("[!WARNING]"), "a callout's words in the page's description, its marker not");
  assert.ok(ideas.text.includes(".doc .callout {"), "the page carries the callout look");
});

await test("public: every page the worker draws goes out under the page policy, which runs the flowchart module and nothing written into a note; an html document keeps its sandbox; every answer is nosniff", async () => {
  const policy = (origin) =>
    [
      "default-src 'none'",
      `script-src ${origin}/__web/${webTag}/flowchart.js`,
      "style-src 'unsafe-inline'",
      "img-src * data:",
      "media-src *",
      "font-src 'self'",
      "frame-src *",
      "form-action 'none'",
      "base-uri 'none'",
    ].join("; ");
  const HERE = "https://notes.example.com";

  // A note, a framed rendition, a folder, a nested note, the root, a 404,
  // and an asset path that reached the worker: one policy.
  for (const p of ["/", "/home", "/sizes", "/plan", "/plan?v=md", "/projects", "/projects/status", "/diagram", "/nope", "/projects/nope", "/__web/x/app.js"]) {
    const res = await pub(p);
    assert.equal(res.headers.get("content-security-policy"), policy(HERE), p);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff", p);
  }
  const head = await rawGet("/home", { method: "HEAD" });
  assert.equal(head.headers.get("content-security-policy"), policy(HERE), "HEAD says what GET says");

  // No page carries a script of its own: the only one a page ever names is
  // the module, and only where there is a diagram to draw.
  for (const p of ["/", "/home", "/sizes", "/plan", "/plan?v=md", "/projects", "/nope"]) {
    assert.ok(!(await pub(p)).text.includes("<script"), `${p}: no script`);
  }

  // HTML written into a note is drawn as written — the policy, not the
  // renderer, is what keeps it from acting (drive-public.mjs watches a
  // browser refuse each of these).
  const diagram = await pub("/diagram");
  assert.deepEqual(
    diagram.text.match(/<script\b[^>]*>/g),
    ["<script>", `<script type="module" src="/__web/${webTag}/flowchart.js">`],
    "the note's own script tag, then the module's — and the policy names the second alone",
  );
  for (const written of ['onerror="document.documentElement.dataset.ran', 'href="javascript:void(', '<form id="written-form"', '<base href="https://example.com/">']) {
    assert.ok(diagram.text.includes(written), written);
  }

  // An html document is the author's page, not the worker's: its sandbox,
  // and never the page policy on top of it.
  for (const p of ["/plan/raw", "/projects/plan/raw", "/projects/plan.html"]) {
    const res = await pub(p);
    assert.equal(res.headers.get("content-security-policy"), "sandbox allow-scripts allow-popups", p);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff", p);
  }

  // The policy names the domain a request came to, so it is set on the way
  // out: a page kept by the cache is kept without one, and answers on
  // another domain under that domain's name.
  const cache = new FakeCache();
  globalThis.caches = { default: cache };
  try {
    const ask = (origin, p) => worker.fetch(new Request(`${origin}${p}`), env);
    const first = await ask(HERE, "/diagram");
    assert.equal(first.headers.get("content-security-policy"), policy(HERE));
    assert.equal(cache.store.get(cache.puts[0]).headers.get("content-security-policy"), null, "kept without a policy");
    const elsewhere = await ask("https://docs.example.net", "/diagram");
    assert.equal(cache.hits, 1, "the same kept page");
    assert.equal(elsewhere.headers.get("content-security-policy"), policy("https://docs.example.net"));
    assert.equal((await ask(HERE, "/diagram")).headers.get("content-security-policy"), policy(HERE));
    await ask(HERE, "/plan/raw");
    const keptRaw = await ask(HERE, "/plan/raw");
    assert.equal(cache.hits, 3);
    assert.equal(keptRaw.headers.get("content-security-policy"), "sandbox allow-scripts allow-popups", "a kept document keeps its sandbox");
  } finally {
    delete globalThis.caches;
  }

  // The API's answers too: JSON, a stored file's bytes, a refusal.
  const manifest = await call("/api/manifest", { token: OWNER });
  assert.equal(manifest.headers.get("x-content-type-options"), "nosniff");
  const [fid, entry] = Object.entries(manifest.json.files)[0];
  const blob = await call(`/api/blobs/${fid}/${entry.hash}`, { token: OWNER });
  assert.equal(blob.status, 200);
  assert.equal(blob.headers.get("x-content-type-options"), "nosniff", "a stored file is never sniffed into a script");
  assert.equal(blob.headers.get("content-security-policy"), null, "the page policy is a page's");
  assert.equal((await call("/api/manifest")).headers.get("x-content-type-options"), "nosniff", "a 401");
  assert.equal((await pub("/home", { method: "POST", body: "x" })).headers.get("x-content-type-options"), "nosniff", "a 405");
});

await test("public: links between notes rewrite to public URLs — inside the folder they were reached through first — or fall back to text; a picture in the workspace is its alt text; other links and pictures stay", async () => {
  const home = await pub("/home");
  assert.equal(home.status, 200);
  assert.ok(home.text.includes('<a href="/plan">the plan</a>'), "a note with its own slug");
  assert.ok(home.text.includes('<a href="/projects/status">status</a>'), "a note inside a published folder");
  assert.ok(home.text.includes("or a scratch note;") && !home.text.includes("Scratch.md"), "an unpublished target is plain text");
  assert.ok(home.text.includes('<a href="https://github.com/boat-builder/doklin">source</a>'), "an external link stays");
  assert.ok(home.text.includes('<a href="#home">this page</a>'), "an anchor stays");
  assert.ok(home.text.includes("a picture") && !home.text.includes("pic.png"), "a picture in the workspace is its alt text: pictures stay on the device");
  assert.ok(home.text.includes("a missing picture") && !home.text.includes("none.png"), "so is one that was never there");
  assert.ok(home.text.includes('<img src="https://example.com/sky.png" alt="a picture on the web">'), "a picture on the web is shown");

  const status = await pub("/projects/status");
  assert.ok(status.text.includes('<a href="/projects/plan">the plan</a>'), "from inside the folder, the folder's address wins over the note's own slug");
  assert.ok(status.text.includes('<a href="/home">home</a>'), "a note outside the folder, on its own slug");
  const plan = await pub("/plan?v=md");
  assert.ok(plan.text.includes('<a href="/projects/status">status</a>'), "reached on its own slug, a sibling links into the folder that holds it");
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
    assert.deepEqual(cache.puts, [`https://cache.doklin/${webTag}/${seedEtag}/sizes`], "keyed by the web tag, the manifest's etag and the path");
    assert.equal(cache.store.get(cache.puts[0]).headers.get("cache-control"), "public, max-age=86400", "the cache keeps it for a day");
    const again = await pub("/sizes");
    assert.equal(cache.hits, 1, "the second read is a cache hit");
    assert.equal(again.text, first.text);
    assert.equal(again.headers.get("cache-control"), "no-cache");
    await pub("/sizes?v=md");
    assert.equal(cache.puts.length, 2, "the query is part of the key");
    assert.equal((await pub("/nope")).status, 404);
    assert.equal(cache.puts.length, 2, "an address nobody holds is not kept: a space could claim it without this manifest moving");
    assert.equal((await pub("/sizes/nope")).status, 404);
    assert.equal(cache.puts.length, 3, "a 404 under an address this manifest holds is cached too");
    assert.equal((await pub("/robots.txt")).status, bundlePath ? 200 : 404);
    assert.equal(cache.puts.length, 3, "an asset path never goes through the cache");

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
    assert.equal(cache.puts[cache.puts.length - 1], `https://cache.doklin/${webTag}/${moved.json.etag}/sizes`);
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
/** Start from a workspace holding exactly these files — `{path: content}` —
 *  and no tags. */
const freshWorkspace = (files, extra = {}) =>
  macWrite((m, put) => {
    m.files = {};
    m.tombstones = {};
    m.public = {};
    delete m.tags;
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
  assert.deepEqual({ ...login.json.limits, fleetToday: 0 }, { ...FREE_LIMITS, fleetToday: 0 }, "the limits the CLI keeps from its first answer on");
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

  // Agents are the database's, as everybody's sign-in is: without one the
  // routes say so, and an agent's token is refused as unavailable, never as
  // bad — the same as a person's.
  for (const bindings of [{ OWNER_TOKEN: KEY, DATA: fake }, { OWNER_TOKEN: KEY, DATA: fake, DB: brokenD1() }]) {
    assert.equal((await call("/api/agent/login", { method: "POST", device: null, body: { code: agentCode(nextCodeBody()) }, bindings })).status, 503);
    assert.equal((await call("/api/auth/agents", { token: OWNER, bindings })).status, 503);
    assert.equal((await call("/api/auth/agents", { method: "POST", token: OWNER, bindings, body: { name: "X", scopes: [], codeHash: sha256("x"), expiresAt: Date.now() + HOUR } })).status, 503);
    assert.equal((await call(`/api/auth/agents/${agent.id}`, { method: "DELETE", token: OWNER, bindings })).status, 503);
    assert.equal((await call("/api/agent/me", { token, device: null, bindings })).status, 503);
    assert.equal((await call("/api/manifest", { token: OWNER, bindings })).status, 503, "nor does anybody sync");
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
  const maker = (await call("/api/auth/members", { token: OWNER })).json.members.find((m) => m.role === "superadmin");
  const { limits: meLimits, ...meRest } = me.json;
  assert.equal(meLimits.cliDaily, FREE_LIMITS.cliDaily, "the CLI's allowance, from the domain's plan");
  assert.deepEqual(meRest, {
    agent: { id: agent.id, name: "Grok bot" },
    // Whose it is — Sherin made it — and where it can work: every section
    // its person has, Library first.
    person: { id: maker.id, name: maker.name },
    scopes: ["read", "edit"],
    sections: ["Library", "My files"],
    workspace: { id: here.id, name: here.name },
    version: workerVersion,
  });

  // "Last used" is a date in a list: the first request writes it, and then
  // nothing does for an hour — a request is one row read and no write.
  const used = db.value("SELECT last_used_at FROM agents WHERE id = ?", agent.id);
  assert.ok(used >= before, "the first request said the agent was here");
  db.queries.length = 0;
  assert.equal((await call("/api/agent/doc?path=Library/Nowhere/at-all", { token, device: null })).status, 404);
  assert.ok(
    db.queries.length === 1 && /^\s*SELECT/i.test(db.queries[0]),
    `a request in Library, within the hour, is one read: ${db.queries.join(" | ")}`,
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
  const refused = await call("/api/agent/doc?path=Library/Somewhere/new&dry=1", { method: "PUT", token: bot.token, device: null, body: "# New\n" });
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

  // An agent is its person's. Alice has none, and the owner's do not exist
  // to her: not in her list, and a 404 by id — what an id nobody minted gets.
  const mine = (token) => call("/api/auth/agents", { token });
  assert.deepEqual((await mine(MEMBER)).json.agents, [], "a member's list is her own agents");
  const theirs = [
    ["POST", `/api/auth/agents/${other.id}`, { scopes: ["publish"] }],
    ["POST", `/api/auth/agents/${other.id}/code`, { codeHash: sha256("x"), expiresAt: Date.now() + HOUR }],
    ["DELETE", `/api/auth/agents/${other.id}`],
    ["DELETE", `/api/auth/agents/${other.id}/tokens/t-00000000`],
  ];
  for (const [method, path, sent] of theirs) {
    const member = await call(path, { method, token: MEMBER, body: sent });
    assert.equal(member.status, 404, `${method} ${path}: the owner's agent is not Alice's to touch`);
    assert.deepEqual(member.json, { error: "no such agent" });
  }
  // And never an agent's own to do, nor anybody's without a credential.
  const body = { name: "Mine", scopes: ["edit"], codeHash: sha256("x"), expiresAt: Date.now() + HOUR };
  for (const [method, path, sent] of [["GET", "/api/auth/agents"], ["POST", "/api/auth/agents", body], ...theirs]) {
    assert.equal((await call(path, { method, token: other.token, device: null, body: sent })).status, 403, "never an agent's own");
    assert.equal((await call(path, { method, body: sent })).status, 401, "auth comes first");
  }

  // Anyone connects agents for themselves.
  const aliceBody = nextCodeBody();
  const made = await call("/api/auth/agents", {
    method: "POST",
    token: MEMBER,
    body: { name: "Alice's bot", scopes: ["edit"], codeHash: sha256(aliceBody), expiresAt: Date.now() + HOUR },
  });
  assert.equal(made.status, 201, made.text);
  assert.equal(made.json.agent.memberId, ALICE.id);
  assert.equal(made.json.agent.mine, true);
  assert.equal(db.value("SELECT member_id FROM agents WHERE id = ?", made.json.agent.id), ALICE.id);
  const alices = (await loginWith(agentCode(aliceBody), "alices-laptop")).json.token;
  assert.deepEqual((await me(alices)).json.person, { id: ALICE.id, name: ALICE.name }, "it is hers");
  assert.deepEqual((await mine(MEMBER)).json.agents.map((a) => [a.id, a.mine]), [[made.json.agent.id, true]]);
  const asAlice = (path, opts) => call(`/api/auth/agents/${made.json.agent.id}${path}`, { token: MEMBER, ...opts });
  assert.equal((await asAlice("", { method: "POST", body: { scopes: ["comment"] } })).status, 200, "hers to change");
  const againBody = nextCodeBody();
  const again2 = await asAlice("/code", { method: "POST", body: { codeHash: sha256(againBody), expiresAt: Date.now() + HOUR } });
  assert.equal(again2.status, 201, "and hers to log in on another machine");

  // An owner sees everybody's, and whose each is — and may remove any. That
  // is all: a new permission is its person's to give, and a login code is a
  // way in as that person, so neither is an owner's to make.
  const seen = (await mine(OWNER)).json.agents.find((a) => a.id === made.json.agent.id);
  assert.equal(seen.memberId, ALICE.id);
  assert.equal(seen.mine, false);
  assert.equal(seen.code, null, "whether hers has a code waiting is hers to know");
  assert.equal(seen.machines.length, 1);
  assert.equal((await mine(OWNER)).json.agents.find((a) => a.id === other.id).mine, true);
  const asOwner = (path, opts) => call(`/api/auth/agents/${made.json.agent.id}${path}`, { token: OWNER, ...opts });
  const meddle = await asOwner("", { method: "POST", body: { scopes: ["publish"] } });
  assert.equal(meddle.status, 403);
  assert.ok(/somebody else's/.test(meddle.json.error), meddle.json.error);
  assert.equal((await asOwner("/code", { method: "POST", body: { codeHash: sha256("y"), expiresAt: Date.now() + HOUR } })).status, 403);
  assert.deepEqual((await me(alices)).json.scopes, ["read", "comment"], "nothing of hers changed");
  assert.equal((await loginWith(agentCode(againBody))).status, 201, "and her own code still works");
  assert.equal((await asOwner(`/tokens/${seen.machines[0].id}`, { method: "DELETE" })).status, 204, "an owner logs one of its machines out");
  assert.equal((await me(alices)).status, 401);
  assert.equal((await asOwner("", { method: "DELETE" })).status, 204, "or removes it");
  assert.deepEqual((await mine(MEMBER)).json.agents, []);
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
    ["GET", "/api/spaces"],
    ["POST", "/api/spaces", { name: "An agent's" }],
    ["PUT", "/api/spaces/private"],
    ["GET", `/api/spaces/${FINANCE.id}/manifest`],
    ["GET", "/api/versions/snapshots/1700000000000-d-macbook"],
    ["GET", "/api/versions/blobs"],
    ["GET", "/api/auth/members"],
    ["GET", "/api/auth/invites"],
    ["POST", "/api/auth/invites", { email: "bot@example.com", codeHash: sha256("x"), expiresAt: Date.now() + DAY }],
    ["GET", "/api/auth/devices"],
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
    ["GET", "/api/agent/find?workspace=w-000000000000&file=f-000000000000"],
    ["GET", "/api/agent/doc?path=Library/Gate/note"],
    ["PUT", "/api/agent/doc?path=Library/Gate/note&force=1", "# Replaced\n"],
    ["DELETE", "/api/agent/doc?path=Library/Gate/note"],
    ["POST", "/api/agent/move", { from: "Library/Gate/note", to: "Library/Gate/moved" }],
    ["GET", "/api/agent/comments?path=Library/Gate/note"],
    ["POST", "/api/agent/comments", { path: "Library/Gate/note", on: "the workspace", body: "Hm." }],
    ["DELETE", "/api/agent/comments?path=Library/Gate/note&thread=abc123"],
    ["GET", "/api/agent/search?q=workspace"],
    ["GET", "/api/agent/pages"],
    ["PUT", "/api/agent/pages", { path: "Library/Gate/note" }],
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
    ["read", "GET", "/api/agent/find?workspace=w-000000000000&file=f-000000000000", undefined, 404],
    ["read", "GET", "/api/agent/doc?path=Library/Perm/note", undefined, 200],
    ["read", "GET", "/api/agent/comments?path=Library/Perm/note", undefined, 200],
    ["read", "GET", "/api/agent/search?q=plain", undefined, 200],
    ["read", "GET", "/api/agent/pages", undefined, 200],
    ["edit", "PUT", "/api/agent/doc?path=Library/Perm/new&dry=1", "# New\n", 200],
    ["edit", "DELETE", "/api/agent/doc?path=Library/Perm/note&dry=1", undefined, 200],
    ["edit", "POST", "/api/agent/move", { from: "Library/Perm/note", to: "Library/Perm/moved", dryRun: true }, 200],
    ["comment", "POST", "/api/agent/comments", { path: "Library/Perm/note", on: "plain words", body: "Hm.", dryRun: true }, 200],
    ["comment", "DELETE", "/api/agent/comments?path=Library/Perm/note&thread=nope00&dry=1", undefined, 404],
    ["publish", "PUT", "/api/agent/pages", { path: "Library/Perm/note", dryRun: true }, 200],
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
        assert.ok(/may not .* — its person can allow it/.test(res.json.error), "in a sentence that says what to do next");
      }
    }
  }
  assert.equal(etagNow(), etag, "a refusal and a dry run both leave the workspace as it was");

  // The reviewer: it can say things about a text it cannot change.
  const reviewer = agents[1];
  const said = await as(reviewer)("/api/agent/comments", { method: "POST", body: { path: "Library/Perm/note", on: "plain words", body: "Too plain." } });
  assert.equal(said.status, 201);
  assert.equal((await as(reviewer)("/api/agent/doc?path=Library/Perm/note&force=1", { method: "PUT", body: "# Mine\n" })).status, 403);
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

  const made = await api(docUrl("Library/Notes/hello"), { method: "PUT", body: text });
  assert.equal(made.status, 201);
  assert.deepEqual(made.json, {
    kind: "document",
    path: "Library/Notes/hello",
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

  const back = await api(docUrl("Library/Notes/hello"));
  assert.equal(back.status, 200);
  assert.equal(back.text, text);
  assert.deepEqual(readHead(back), { kind: "document", path: "Library/Notes/hello", file: "Library/Notes/hello.md", version: "md", rev: 1 });
  assert.equal(back.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(back.headers.get("cache-control"), "no-store");

  // Replacing it: the revision that was read, or nothing.
  const next = `${text}\nA second paragraph.\n`;
  const blind = await api(docUrl("Library/Notes/hello"), { method: "PUT", body: next });
  assert.equal(blind.status, 409, "no silent overwrite");
  assert.equal(blind.json.code, "needs_rev");
  assert.equal(blind.json.rev, 1, "the refusal says which revision is there");
  const replaced = await api(docUrl("Library/Notes/hello"), { method: "PUT", body: next, headers: { "if-rev": "1" } });
  assert.equal(replaced.status, 200);
  assert.deepEqual(replaced.json, { kind: "document", path: "Library/Notes/hello", version: "md", file: "hello.md", rev: 2, size: Buffer.byteLength(next), created: false });
  const two = storedManifest();
  assert.equal(two.seq, start.seq + 2);
  assert.equal(two.files[fid].rev, 2, "the same file, one revision on");
  assert.equal(two.files[fid].hash, blobHash(next));
  assert.ok(fake.store.has(`blobs/${fid}/${file.hash}`), "the old revision is still in the bucket — collecting it is a Mac's job");
  const stale = await api(docUrl("Library/Notes/hello"), { method: "PUT", body: "# Late\n", headers: { "if-rev": "1" } });
  assert.equal(stale.status, 409, "a write over a stale revision is refused");
  assert.equal(stale.json.rev, 2);
  assert.ok(/Read it again/.test(stale.json.error));
  assert.equal(textAt("Notes/hello.md"), next, "and nothing was lost");
  assert.equal((await api(docUrl("Library/Notes/hello", "", "&force=1"), { method: "PUT", body: "x", headers: { "if-rev": "2" } })).status, 400, "a revision or a force, not both");
  assert.equal((await api(docUrl("Library/Notes/hello"), { method: "PUT", body: "x", headers: { "if-rev": "two" } })).status, 400);
  const mustBeNew = await api(docUrl("Library/Notes/hello"), { method: "PUT", body: "x", headers: { "if-rev": "*" } });
  assert.equal(mustBeNew.status, 409, "* means it must not exist yet");
  assert.equal(mustBeNew.json.rev, 2);
  const vanished = await api(docUrl("Library/Notes/never-was"), { method: "PUT", body: "x", headers: { "if-rev": "3" } });
  assert.equal(vanished.status, 409, "a revision of something that is not there");
  assert.equal(vanished.json.rev, null);

  // The same bytes are not a new revision, and not a write.
  const etag = etagNow();
  const blobs = blobKeys().length;
  const same = await api(docUrl("Library/Notes/hello", "", "&force=1"), { method: "PUT", body: next });
  assert.equal(same.status, 200);
  assert.equal(same.json.unchanged, true);
  assert.equal(same.json.written, false);
  assert.equal(same.json.rev, 2);
  assert.equal(etagNow(), etag, "no new etag, so no Mac wakes up for nothing");

  // A dry run is checked like the real thing, and then thrown away.
  const dry = await api(docUrl("Library/Notes/hello", "", "&dry=1"), { method: "PUT", body: "# Other\n", headers: { "if-rev": "2" } });
  assert.equal(dry.status, 200);
  assert.equal(dry.json.rev, 3, "what it would have become");
  assert.equal(dry.json.written, false);
  const dryNew = await api(docUrl("Library/Notes/unborn", "", "&dry=1"), { method: "PUT", body: "# Unborn\n" });
  assert.equal(dryNew.status, 200, "not a 201: nothing was created");
  assert.deepEqual([dryNew.json.created, dryNew.json.written], [true, false]);
  assert.equal((await api(docUrl("Library/Notes/hello", "", "&dry=1"), { method: "PUT", body: "x", headers: { "if-rev": "1" } })).status, 409, "a dry run still says no");
  assert.equal(etagNow(), etag);
  assert.equal(blobKeys().length, blobs, "not even a blob");
  assert.equal(entryAt(storedManifest(), "Notes/unborn.md"), undefined);

  // Removing leaves the tombstone a Mac honours, one revision on.
  const gone = await api(docUrl("Library/Notes/hello"), { method: "DELETE" });
  assert.equal(gone.status, 200);
  assert.deepEqual(gone.json, { kind: "document", path: "Library/Notes/hello", versions: ["md"], stillPublic: [] });
  const three = storedManifest();
  assert.equal(three.seq, start.seq + 3);
  assert.equal(three.files[fid], undefined);
  const tomb = three.tombstones[fid];
  assert.deepEqual({ path: tomb.path, rev: tomb.rev, by: tomb.by }, { path: "Notes/hello.md", rev: 3, by: bot.id });
  assert.ok(tomb.ts >= before && tomb.ts <= Date.now());
  assert.equal((await api(docUrl("Library/Notes/hello"))).status, 404);
  // The same name again is a new file, not the old one back.
  const reborn = await api(docUrl("Library/Notes/hello"), { method: "PUT", body: "# Again\n", headers: { "if-rev": "*" } });
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
  assert.equal((await api(docUrl("Library/Notes/another"), { method: "PUT", body: "# Another\n" })).status, 201);
  const aged = storedManifest();
  assert.equal(aged.tombstones["f-old000001"], undefined, "past thirty days");
  assert.ok(aged.tombstones["f-new000001"] && aged.tombstones[fid], "younger ones stay");
  assert.ok(entryAt(aged, "Notes/from-a-mac.md"), "and the Mac's file is there beside the agent's");

  // Nothing but documents: a picture, a PDF, a script — refused by every
  // verb, in one sentence that says what to name instead, and nothing written.
  const untouched = etagNow();
  for (const p of ["Library/Notes/pixel.png", "Library/Notes/report.pdf", "Library/Notes/tool.py"]) {
    for (const [method, body] of [["PUT", PIXEL_PNG], ["GET"], ["DELETE"]]) {
      const res = await api(docUrl(p), { method, ...(body ? { body } : {}) });
      assert.equal(res.status, 400, `${method} ${p}`);
      assert.match(res.json.error, /^Doklin syncs markdown and html documents only — ".+" is neither\. Name a document/, res.json.error);
    }
  }
  assert.equal((await api(docUrl("Library/Notes/pixel.png", "", "&info=1"))).status, 400);
  assert.equal(etagNow(), untouched, "nothing was written");
  // A name with a dot of its own is a document when a version says so, and
  // found by that name once it is there.
  const dotted = await api(docUrl("Library/Notes/v1.2", "md"), { method: "PUT", body: "# v1.2\n" });
  assert.deepEqual([dotted.status, dotted.json.path, dotted.json.file], [201, "Library/Notes/v1.2", "v1.2.md"]);
  assert.equal((await api(docUrl("Library/Notes/v1.2"))).text, "# v1.2\n");

  assert.equal((await api(docUrl("Library/Notes/huge.bin"), { method: "PUT", body: new Uint8Array(25 * 1024 * 1024 + 1) })).status, 413);

  // No workspace, or one this worker cannot read: nothing is invented.
  const unbound = { OWNER_TOKEN: KEY, DATA: new FakeR2(), DB: db };
  const everything = as(await addAgent("Everything", ["comment", "edit", "publish"]));
  for (const [method, path, body] of [
    ["GET", "/api/agent/tree"],
    ["GET", docUrl("Library/Notes/hello")],
    ["PUT", docUrl("Library/Notes/hello"), "# Hello\n"],
    ["DELETE", docUrl("Library/Notes/hello")],
    ["POST", "/api/agent/move", { from: "Library/a", to: "Library/b" }],
    ["GET", "/api/agent/comments?path=Library/Notes/hello"],
    ["POST", "/api/agent/comments", { path: "Library/Notes/hello", on: "Hello", body: "Hm." }],
    ["DELETE", "/api/agent/comments?path=Library/Notes/hello&thread=abc123"],
    ["GET", "/api/agent/pages"],
    ["PUT", "/api/agent/pages", { path: "Library/Notes/hello" }],
    ["DELETE", "/api/agent/pages?path=Library/Notes/hello"],
    ["GET", "/api/agent/search?q=hello"],
  ]) {
    const res = await everything(path, { method, body, bindings: unbound });
    assert.equal(res.status, 404, `${method} ${path} on a domain with no workspace`);
    assert.ok(/holds no workspace yet/.test(res.json.error));
  }
  assert.equal(unbound.DATA.store.size, 0);
  const garbled = { OWNER_TOKEN: KEY, DATA: new FakeR2(), DB: db };
  await garbled.DATA.put("manifest.json", "{ not a manifest");
  const refused = await api(docUrl("Library/Notes/hello"), { method: "PUT", body: "# Hello\n", bindings: garbled });
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
    const res = await api(docUrl(`Library/${doc}`, flag));
    const label = `${doc}${flag ? ` --${flag}` : ""}`;
    if (want === "md" || want === "html") {
      assert.equal(res.status, 200, label);
      const head = readHead(res);
      assert.equal(head.version, want, `${label} reads the ${want} version, and says so`);
      assert.equal(head.path, `Library/${doc}`, "the document's name, whatever was read");
      assert.equal(head.file, `Library/${doc}.${want}`);
      assert.equal(res.headers.get("content-type"), want === "md" ? "text/markdown; charset=utf-8" : "text/html; charset=utf-8");
      assert.equal(res.text, textAt(`${doc}.${want}`));
    } else {
      assert.equal(res.status, 404, label);
      assert.equal(res.json.code, want ?? undefined, `${label} → ${want ?? "nothing there"}`);
    }
  }
  assert.ok(/writing one with --html creates it/.test((await api(docUrl("Library/VT/md-only", "html"))).json.error));
  assert.ok(/writing one with --md adds a markdown version/.test((await api(docUrl("Library/VT/html-only", "md"))).json.error));

  // An extension picks a version too — and still names the same document.
  assert.equal(readHead(await api(docUrl("Library/VT/both.html"))).version, "html");
  assert.equal(readHead(await api(docUrl("Library/VT/both.md"))).version, "md");
  assert.equal(readHead(await api(docUrl("Library/VT/both.html"))).path, "Library/VT/both");
  assert.equal((await api(docUrl("Library/VT/md-only.html"))).json.code, "no_html");
  assert.equal((await api(docUrl("Library/VT/html-only.md"))).json.code, "no_md");
  assert.equal((await api(docUrl("Library/VT/both.md", "html"))).status, 400, "a flag that contradicts the extension");
  assert.equal((await api(docUrl("Library/VT/both.md", "md"))).status, 200, "one that agrees is fine");
  assert.equal((await api(docUrl("Library/VT/both", "pdf"))).status, 400);

  // Markdown is any of its extensions; two with one stem have to be named in full.
  const alt = await api(docUrl("Library/VT/alt"));
  assert.deepEqual(readHead(alt), { kind: "document", path: "Library/VT/alt", file: "Library/VT/alt.markdown", version: "md", rev: 1 });
  const twin = await api(docUrl("Library/VT/twin"));
  assert.equal(twin.status, 409);
  assert.deepEqual(twin.json.candidates, ["Library/VT/twin.md", "Library/VT/twin.mkd"]);
  assert.equal((await api(docUrl("Library/VT/twin.mkd"))).text, "# Twin two\n");
  assert.equal((await api(docUrl("Library/VT/twin.md"))).text, "# Twin one\n");
  const listed = (await api("/api/agent/tree?dir=Library/VT")).json.documents;
  assert.deepEqual(
    listed.map((d) => [d.path, d.md?.file ?? null, d.html?.file ?? null]),
    [
      ["Library/VT/alt", "alt.markdown", null],
      ["Library/VT/both", "both.md", "both.html"],
      ["Library/VT/html-only", null, "html-only.html"],
      ["Library/VT/md-only", "md-only.md", null],
      ["Library/VT/twin.md", "twin.md", null],
      ["Library/VT/twin.mkd", "twin.mkd", null],
    ],
    "a listing shows each document once, with the versions it has",
  );
  assert.ok(listed.every((d) => d.htmlBehind === undefined), "nothing is behind yet");

  // Writing with no flag. Markdown only: the markdown.
  const mdOnly = await put("Library/VT/md-only", "", "# Markdown only, edited\n", { "if-rev": "1" });
  assert.deepEqual([mdOnly.status, mdOnly.json.version, mdOnly.json.file, mdOnly.json.rev], [200, "md", "md-only.md", 2]);

  // Both: the markdown — and the html now describes an older text.
  const both = await put("Library/VT/both", "", "# Both, edited in markdown\n", { "if-rev": "1" });
  assert.deepEqual([both.status, both.json.version, both.json.rev], [200, "md", 2]);
  assert.equal(both.json.htmlBehind, true, "the answer to a markdown write says the html is behind");
  assert.equal(textAt("VT/both.html"), "<h1>Both, as a page</h1>\n", "the html was not touched");
  assert.equal((await api("/api/agent/tree?dir=Library/VT")).json.documents.find((d) => d.path === "Library/VT/both").htmlBehind, true, "so does a listing");
  assert.equal((await api(docUrl("Library/VT/both"))).headers.get("x-doklin-html-behind"), "1", "and a read of either version");
  assert.equal((await api(docUrl("Library/VT/both", "html"))).headers.get("x-doklin-html-behind"), "1");
  assert.equal((await api(docUrl("Library/VT/both", "", "&info=1"))).json.htmlBehind, true);
  const html = await put("Library/VT/both", "html", "<h1>Both, edited</h1>\n", { "if-rev": "1" });
  assert.deepEqual([html.status, html.json.version, html.json.file, html.json.rev], [200, "html", "both.html", 2]);
  assert.equal(html.json.htmlBehind, undefined, "writing the html again brings it level");
  assert.equal((await api(docUrl("Library/VT/both"))).headers.get("x-doklin-html-behind"), null);
  assert.equal((await api("/api/agent/tree?dir=Library/VT")).json.documents.find((d) => d.path === "Library/VT/both").htmlBehind, undefined);

  // Html only: the one place a default would do harm.
  const etag = etagNow();
  for (const [headers, more] of [[{}, ""], [{ "if-rev": "1" }, ""], [{}, "&force=1"]]) {
    const guess = await put("Library/VT/html-only", "", "# Markdown, by accident\n", headers, more);
    assert.equal(guess.status, 400, "markdown text never replaces an html page by default");
    assert.equal(guess.json.code, "html_only");
    assert.ok(/say --html to replace it, or --md to add a markdown version/.test(guess.json.error));
  }
  assert.equal(etagNow(), etag);
  assert.equal((await put("Library/VT/html-only", "html", "<h1>Replaced</h1>\n")).json.code, "needs_rev");
  const page = await put("Library/VT/html-only", "html", "<h1>Replaced</h1>\n", { "if-rev": "1" });
  assert.deepEqual([page.status, page.json.version, page.json.rev, page.json.created], [200, "html", 2, false]);
  const added = await put("Library/VT/html-only", "md", "# The markdown it never had\n");
  assert.deepEqual([added.status, added.json.version, added.json.file, added.json.rev, added.json.created], [201, "md", "html-only.md", 1, true]);
  assert.equal(readHead(await api(docUrl("Library/VT/html-only"))).version, "md", "it has both now, and reads as any document with both");
  assert.equal((await put("Library/VT/html-only", "", "# Markdown, on purpose\n", { "if-rev": "1" })).status, 200, "and a plain write is the markdown again");

  // Nothing yet: markdown, unless html is said.
  const fresh = await put("Library/VT/fresh", "", "# Fresh\n");
  assert.deepEqual([fresh.status, fresh.json.version, fresh.json.file, fresh.json.created], [201, "md", "fresh.md", true]);
  const pageOnly = await put("Library/VT/page", "html", "<p>A page of its own</p>\n");
  assert.deepEqual([pageOnly.status, pageOnly.json.version, pageOnly.json.file, pageOnly.json.created], [201, "html", "page.html", true]);
  assert.equal(entryAt(storedManifest(), "VT/page.md"), undefined, "an html-only document, with no markdown invented beside it");
  const typed = await put("Library/VT/typed.html", "", "<p>Typed in full</p>\n");
  assert.deepEqual([typed.status, typed.json.path, typed.json.version], [201, "Library/VT/typed", "html"]);
  const long = await put("Library/VT/long.markdown", "", "# Long\n");
  assert.deepEqual([long.status, long.json.path, long.json.file], [201, "Library/VT/long", "long.markdown"], "a markdown extension typed in full is kept");
  assert.equal((await put("Library/VT/binary", "", new Uint8Array([0xff, 0xfe, 0xfd]))).status, 400, "a version is text");

  // What is known about a document, without reading it.
  const info = (await api(docUrl("Library/VT/both.html", "", "&info=1"))).json;
  assert.deepEqual([info.kind, info.path, info.comments], ["document", "Library/VT/both", 0]);
  assert.deepEqual([info.md.file, info.md.rev, info.md.by, info.md.byName], ["both.md", 2, bot.id, "Versions"]);
  assert.deepEqual([info.html.file, info.html.rev, info.html.size], ["both.html", 2, 22]);
  assert.equal((await api(docUrl("Library/VT/nothing", "", "&info=1"))).status, 404);
});

await test("documents: what a Mac would never see is refused — and so is anything that is not a document; the sidecar never appears; one name is one file whatever its case", async () => {
  await freshWorkspace({
    "Case/Report.md": "# Report\n\nThe {==numbers==}{>>#abc123<<} are in.\n",
    "Case/Report.meta.jsonl": sidecar({ t: "mthread", id: "abc123", comments: [{ author: "Alice", at: 1757000000000, body: "Which numbers?" }] }),
    "Case/Sub/inner.md": "# Inner\n",
  });
  const bot = await addAgent("Careful", ["edit"]);
  const api = as(bot);
  const etag = etagNow();

  const refused = [
    "Library/.secret/plan",
    "Library/Notes/.draft",
    "Library/node_modules/pkg/readme",
    "Library/Out/target/notes",
    "Library/dist/page",
    "Library/x/build/y",
    "Library/__pycache__/a",
    "Library/Notes/a.doklin-sync-tmp",
    "Library/Case/Report.meta.jsonl",
    "Library/Case/REPORT.META.JSONL",
    "Library/Anything/new.meta.jsonl",
    "../outside",
    "Library/../outside",
    "Library/a/../b",
    "Library/a//b",
    "/Library/leading",
    "Library/a/./b",
    "Library/back\\slash",
    "",
    ["Library", ...Array.from({ length: 12 }, (_, i) => `d${i}`)].join("/"),
  ];
  for (const p of refused) {
    assert.equal((await api(docUrl(p))).status, 400, `reading ${JSON.stringify(p)}`);
    assert.equal((await api(docUrl(p, "", "&force=1"), { method: "PUT", body: "x" })).status, 400, `writing ${JSON.stringify(p)}`);
    assert.equal((await api(docUrl(p), { method: "DELETE" })).status, 400, `removing ${JSON.stringify(p)}`);
    // (A move reads a leading slash as the workspace's root, as publishing reads "/".)
    if (p !== "/Library/leading") {
      assert.equal((await api("/api/agent/move", { method: "POST", body: { from: "Library/Case/Sub/inner", to: p } })).status, 400, `moving onto ${JSON.stringify(p)}`);
    }
  }
  // Plain files are not Doklin's: read, written or removed, a name that is
  // not a document's says so.
  for (const p of ["Library/Case/Data.csv", "library/CASE/Pixel.PNG", "Library/Case/Sub/tool.py", "Library/deck.pdf"]) {
    for (const [method, body] of [["GET"], ["PUT", "a,b\n"], ["DELETE"]]) {
      const res = await api(docUrl(p, "", method === "PUT" ? "&force=1" : ""), { method, ...(body ? { body } : {}) });
      assert.equal(res.status, 400, `${method} ${p}`);
      assert.match(res.json.error, /Doklin syncs markdown and html documents only/);
    }
  }
  assert.equal(etagNow(), etag, "none of it reached the manifest");
  // What is shared with a person is never Library's, in any case: a path
  // under `Shared with me` is something shared with them, or nowhere. And the
  // folders an older Doklin had are refused with what they are called now.
  for (const p of ["shared with me/Nobodys/q3", "Shared with me/q3"]) {
    const kept = await api(docUrl(p, "", "&force=1"), { method: "PUT", body: "# x\n" });
    assert.equal(kept.status, 404, `writing ${p}: ${kept.text}`);
    assert.match(kept.json.error, /is shared with this agent's person/);
  }
  for (const [p, said] of [["Private/q3", /Private is called "My files" now/], ["restricted/Finance/q3", /There is no Restricted any more/], ["RESTRICTED", /There is no Restricted any more/]]) {
    const kept = await api(docUrl(p, "", "&force=1"), { method: "PUT", body: "# x\n" });
    assert.equal(kept.status, 400, `writing ${p}: ${kept.text}`);
    assert.match(kept.json.error, said);
  }
  assert.equal(etagNow(), etag, "nor did those");
  // Inside Library a folder is called what its people like — a section's name included.
  for (const p of ["Library/My files/q3", "library/Shared with me/Finance/q3", "Library/Library/q3"]) {
    const kept = await api(docUrl(p, "", "&force=1"), { method: "PUT", body: "# x\n" });
    assert.equal(kept.status, 201, `writing ${p}: ${kept.text}`);
    assert.equal((await api(docUrl(p), { method: "DELETE" })).status, 200);
  }
  assert.ok(/does not sync names that begin with a dot/.test((await api(docUrl("Library/.secret/plan"))).json.error));
  assert.ok(/a folder Doklin does not sync/.test((await api(docUrl("Library/node_modules/pkg/readme"))).json.error));
  assert.ok(/comments commands/.test((await api(docUrl("Library/Case/Report.meta.jsonl"))).json.error), "the sidecar's refusal says where comments are");

  // A listing is folders and documents — never a sidecar.
  const root = (await api("/api/agent/tree")).json;
  // (The top is the sections the agent's person has: Library, and their Private.)
  assert.deepEqual(root, { dir: "", folders: ["Library", "My files"], documents: [] });
  const deep = (await api("/api/agent/tree?deep=1")).json;
  assert.deepEqual(Object.keys(deep), ["dir", "folders", "documents"]);
  assert.deepEqual(deep.folders, ["Library", "Library/Case", "Library/Case/Sub", "My files"]);
  assert.deepEqual(deep.documents.map((d) => d.path), ["Library/Case/Report", "Library/Case/Sub/inner"]);
  assert.ok(!JSON.stringify(deep).includes("meta.jsonl"));
  const folder = (await api("/api/agent/tree?dir=/Library/Case/")).json;
  assert.deepEqual([folder.dir, folder.folders, folder.documents.map((d) => d.path)], ["Library/Case", ["Library/Case/Sub"], ["Library/Case/Report"]]);
  assert.deepEqual((await api("/api/agent/tree?dir=library/case")).json.documents.map((d) => d.path), ["Library/Case/Report"], "a folder is found whatever case it is typed in");
  assert.equal((await api("/api/agent/tree?dir=Library/Nope")).status, 404);
  assert.equal((await api("/api/agent/tree?dir=Library/.git")).status, 400);
  assert.equal((await api(docUrl("Library/Case/Report", "", "&info=1"))).json.comments, 1, "its comments are counted, not shown");

  // The workspace lives on a case-insensitive disk: a name typed in another
  // case is the same document, never a second file beside it.
  const typed = await api(docUrl("library/case/REPORT"));
  assert.equal(typed.status, 200);
  assert.equal(readHead(typed).path, "Library/Case/Report", "answered under the name the files carry");
  const over = await api(docUrl("LIBRARY/case/report.MD", "", "&force=1"), { method: "PUT", body: "# Report, rewritten\n\nThe {==numbers==}{>>#abc123<<} are in.\n" });
  assert.deepEqual([over.status, over.json.path, over.json.rev, over.json.created], [200, "Library/Case/Report", 2, false]);
  const page = await api(docUrl("library/case/report", "html"), { method: "PUT", body: "<h1>Report</h1>\n" });
  assert.equal(page.status, 201);
  assert.deepEqual(pathsOf(storedManifest()), ["Case/Report.html", "Case/Report.md", "Case/Report.meta.jsonl", "Case/Sub/inner.md"], "an html version is spelled as its markdown is");

  // A real collision is a 409.
  const onto = await api("/api/agent/move", { method: "POST", body: { from: "Library/Case/Sub/inner", to: "Library/Case/REPORT" } });
  assert.equal(onto.status, 409, "a document moved onto a name that differs only in case");
  assert.ok(/"Library\/Case\/Report.md" is already there/.test(onto.json.error), "named as it is spelled");
  const inside = await api(docUrl("Library/Case/Report.md/inside"), { method: "PUT", body: "# Inside a file\n" });
  assert.equal(inside.status, 409, "a file is in the way of the folder");
  assert.ok(/is a file, so nothing can be put inside it/.test(inside.json.error));
  assert.deepEqual(pathsOf(storedManifest()), ["Case/Report.html", "Case/Report.md", "Case/Report.meta.jsonl", "Case/Sub/inner.md"]);
  // …but changing only the case of a name is a rename like any other.
  const recased = await api("/api/agent/move", { method: "POST", body: { from: "Library/Case/Report", to: "Library/Case/REPORT" } });
  assert.deepEqual([recased.status, recased.json.to, recased.json.files], [200, "Library/Case/REPORT", 3]);
  assert.deepEqual(pathsOf(storedManifest()), ["Case/REPORT.html", "Case/REPORT.md", "Case/REPORT.meta.jsonl", "Case/Sub/inner.md"]);

  // A new name typed under a folder in another case goes into the folder as
  // it is spelled — where a Mac's disk would put it anyway, so that no Mac
  // has to rename it to agree. The name itself stays as typed, and so does
  // any folder that is new.
  const made = [];
  for (const [typed, v, body, landed] of [
    ["library/case/SUB/Fresh", "", "# Fresh\n", "Case/Sub/Fresh.md"],
    ["LIBRARY/CASE/sub/Page", "html", "<p>Page</p>\n", "Case/Sub/Page.html"],
    ["Library/case/Brand New/sub/Note", "", "# Note\n", "Case/Brand New/sub/Note.md"],
    ["Library/Elsewhere/As Typed", "", "# As typed\n", "Elsewhere/As Typed.md"],
  ]) {
    const res = await api(docUrl(typed, v), { method: "PUT", body });
    assert.equal(res.status, 201, typed);
    assert.ok(entryAt(storedManifest(), landed), `${typed} landed at ${landed}`);
    assert.equal(res.json.path, `Library/${landed.replace(/\.(md|html)$/, "")}`, "and the answer says where");
    made.push(landed);
  }
  assert.deepEqual(
    (await api("/api/agent/tree?deep=1")).json.folders,
    ["Library", "Library/Case", "Library/Case/Brand New", "Library/Case/Brand New/sub", "Library/Case/Sub", "Library/Elsewhere", "My files"],
    "one folder, one spelling",
  );
  const intoTyped = await api("/api/agent/move", { method: "POST", body: { from: "Library/Elsewhere/As Typed", to: "library/CASE/sub/" } });
  assert.deepEqual(intoTyped.json, { kind: "document", from: "Library/Elsewhere/As Typed", to: "Library/Case/Sub/As Typed", files: 1 });
  const folderTyped = await api("/api/agent/move", { method: "POST", body: { from: "library/case/brand new/", to: "LIBRARY/CASE/SUB/" } });
  assert.deepEqual(folderTyped.json, { kind: "folder", from: "Library/Case/Brand New", to: "Library/Case/Sub/Brand New", files: 1 });
  // A folder's own name can still change case: nothing else is in it to say otherwise.
  const recasedFolder = await api("/api/agent/move", { method: "POST", body: { from: "Library/Case/Sub/Brand New", to: "Library/Case/Sub/BRAND NEW" } });
  assert.deepEqual(recasedFolder.json, { kind: "folder", from: "Library/Case/Sub/Brand New", to: "Library/Case/Sub/BRAND NEW", files: 1 });
  assert.deepEqual(
    pathsOf(storedManifest()).filter((p) => p.startsWith("Case/Sub/")),
    ["Case/Sub/As Typed.md", "Case/Sub/BRAND NEW/sub/Note.md", "Case/Sub/Fresh.md", "Case/Sub/Page.html", "Case/Sub/inner.md"],
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
    "Pairs/chart.md": "# Chart\n",
    "Pairs/Deep/note.md": "# Deep\n",
    "Other/taken.md": "# Taken\n",
  });
  const bot = await addAgent("Mover", ["edit"]);
  const api = as(bot);
  const move = (from, to, extra = {}) => api("/api/agent/move", { method: "POST", body: { from, to, ...extra } });
  const start = storedManifest();
  const parts = ["Pairs/plan.md", "Pairs/plan.html", "Pairs/plan.meta.jsonl"].map((p) => entryAt(start, p));

  // Whatever extension was typed, the document moves.
  const moved = await move("Library/Pairs/plan.html", "Library/Archive/plan-2026");
  assert.equal(moved.status, 200);
  assert.deepEqual(moved.json, { kind: "document", from: "Library/Pairs/plan", to: "Library/Archive/plan-2026", files: 3 });
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
  assert.equal((await api(docUrl("Library/Pairs/plan"))).status, 404);
  assert.equal((await api(docUrl("Library/Archive/plan-2026", "", "&info=1"))).json.comments, 2, "its comments came with it");

  // A destination that is a folder, or says it is one, means "into it".
  const into = await move("Library/Archive/plan-2026.md", "Library/Pairs");
  assert.deepEqual(into.json, { kind: "document", from: "Library/Archive/plan-2026", to: "Library/Pairs/plan-2026", files: 3 });
  const intoNew = await move("Library/Pairs/plan-2026", "Library/New place/");
  assert.deepEqual(intoNew.json, { kind: "document", from: "Library/Pairs/plan-2026", to: "Library/New place/plan-2026", files: 3 });
  // And one typed with an extension names the document, not a file.
  const named = await move("Library/New place/plan-2026", "Library/Pairs/plan.md");
  assert.deepEqual(named.json, { kind: "document", from: "Library/New place/plan-2026", to: "Library/Pairs/plan", files: 3 });
  assert.deepEqual(
    pathsOf(storedManifest()).filter((p) => p.includes("plan")),
    ["Pairs/plan.html", "Pairs/plan.md", "Pairs/plan.meta.jsonl"],
  );

  const etag = etagNow();
  assert.equal((await move("Library/Pairs/plan", "Library/Other/taken")).status, 409, "the name is taken");
  assert.equal((await move("Library/Pairs/draft", "Library/Pairs/plan")).status, 409);
  assert.equal((await move("Library/Pairs/nope", "Library/Pairs/somewhere")).status, 404);
  assert.equal((await move("Library/Pairs/plan", "Library/.hidden/plan")).status, 400);
  assert.equal((await move("Library/Pairs/plan", "")).status, 400);
  assert.equal((await api("/api/agent/move", { method: "POST", body: "not json" })).status, 400);
  const plain = await move("Library/Pairs/chart.png", "Library/Pairs/Deep/");
  assert.equal(plain.status, 400, "a name that is not a document's");
  assert.match(plain.json.error, /Doklin syncs markdown and html documents only/);
  const dry = await move("Library/Pairs/plan", "Library/Elsewhere/plan", { dryRun: true });
  assert.deepEqual(dry.json, { kind: "document", from: "Library/Pairs/plan", to: "Library/Elsewhere/plan", files: 3, moved: false });
  assert.equal(etagNow(), etag, "a refusal and a dry run move nothing");

  // A document into a folder, and a whole folder.
  const file = await move("Library/Pairs/chart", "Library/Pairs/Deep/");
  assert.deepEqual(file.json, { kind: "document", from: "Library/Pairs/chart", to: "Library/Pairs/Deep/chart", files: 1 });
  const beforeFolder = storedManifest();
  const folder = await move("Library/Pairs/", "Library/Fleet");
  assert.deepEqual(folder.json, { kind: "folder", from: "Library/Pairs", to: "Library/Fleet", files: 8 });
  const afterFolder = storedManifest();
  assert.equal(afterFolder.seq, beforeFolder.seq + 1, "a folder moves in one write too");
  assert.deepEqual(pathsOf(afterFolder), [
    "Fleet/Deep/chart.md",
    "Fleet/Deep/note.md",
    "Fleet/draft.html",
    "Fleet/draft.md",
    "Fleet/draft.meta.jsonl",
    "Fleet/plan.html",
    "Fleet/plan.md",
    "Fleet/plan.meta.jsonl",
    "Other/taken.md",
  ]);
  assert.equal((await move("Library/Fleet", "Library/Fleet/Inner/")).status, 400, "a folder cannot be moved inside itself");
  assert.deepEqual((await move("Library/Fleet/Deep", "Library/Other")).json, { kind: "folder", from: "Library/Fleet/Deep", to: "Library/Other/Deep", files: 2 }, "a folder named without its slash, into another");

  // Removing one version: the threads anchored in it go with it.
  const noHtml = await api(docUrl("Library/Fleet/draft", "html"), { method: "DELETE" });
  assert.equal(noHtml.status, 200);
  assert.deepEqual(noHtml.json, { kind: "document", path: "Library/Fleet/draft", versions: ["html"], threadsRemoved: 1 });
  const afterHtml = storedManifest();
  assert.equal(entryAt(afterHtml, "Fleet/draft.html"), undefined);
  assert.ok(Object.values(afterHtml.tombstones).some((t) => t.path === "Fleet/draft.html"));
  assert.deepEqual(recordsOf(textAt("Fleet/draft.meta.jsonl")).map((r) => [r.t, r.id]), [["mthread", "aaa111"]], "the markdown's thread stays");
  assert.ok(textAt("Fleet/draft.md").includes("{>>#aaa111<<}"));
  assert.equal((await api(docUrl("Library/Fleet/draft", "html"), { method: "DELETE" })).status, 404, "it has no html version now");
  const last = await api(docUrl("Library/Fleet/draft", "md"), { method: "DELETE" });
  assert.equal(last.status, 409, "the last version is not removed that way");
  assert.equal(last.json.code, "last_version");
  assert.ok(entryAt(storedManifest(), "Fleet/draft.md"));
  assert.equal((await api(docUrl("Library/Fleet/draft.md", "html"), { method: "DELETE" })).status, 400);

  // Removing the markdown of a pair: its threads, and the sidecar when that empties it.
  assert.equal((await api(docUrl("Library/Fleet/draft", "html"), { method: "PUT", body: "<h1>Draft</h1>\n" })).status, 201);
  const noMd = await api(docUrl("Library/Fleet/draft", "md"), { method: "DELETE" });
  assert.deepEqual(noMd.json, { kind: "document", path: "Library/Fleet/draft", versions: ["md"], threadsRemoved: 1 });
  assert.deepEqual(
    pathsOf(storedManifest()).filter((p) => p.startsWith("Fleet/draft")),
    ["Fleet/draft.html"],
    "an html-only document now, with no empty sidecar left beside it",
  );
  assert.equal(readHead(await api(docUrl("Library/Fleet/draft"))).version, "html");

  // Removing the document: every file it is, in one write, each with its tombstone.
  const dryRm = await api(docUrl("Library/Fleet/plan", "", "&dry=1"), { method: "DELETE" });
  assert.deepEqual(dryRm.json, { kind: "document", path: "Library/Fleet/plan", versions: ["md", "html"], stillPublic: [], removed: false });
  const beforeRm = storedManifest();
  assert.ok(entryAt(beforeRm, "Fleet/plan.md"), "the dry run removed nothing");
  const rm = await api(docUrl("Library/Fleet/plan.md"), { method: "DELETE" });
  assert.equal(rm.status, 200);
  assert.deepEqual(rm.json, { kind: "document", path: "Library/Fleet/plan", versions: ["md", "html"], stillPublic: [] }, "plan.md with no flag means the document, as it does for a move");
  const afterRm = storedManifest();
  assert.equal(afterRm.seq, beforeRm.seq + 1);
  for (const [fid] of parts) {
    assert.equal(afterRm.files[fid], undefined);
    const tomb = afterRm.tombstones[fid];
    assert.deepEqual([tomb.path, tomb.rev, tomb.by], [beforeRm.files[fid].path, beforeRm.files[fid].rev + 1, bot.id]);
  }
  assert.equal((await api(docUrl("Library/Fleet/plan"), { method: "DELETE" })).status, 404);
  assert.equal((await api("/api/agent/comments?path=Library/Fleet/plan")).status, 404, "and its comments are gone with it");
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
  const won = await racing(1, addTheirs, () => api(docUrl("Library/Race/mine"), { method: "PUT", body: mine }));
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
  }, () => api(docUrl("Library/Race/doc"), { method: "PUT", body: "# Doc\n\nRewritten.\n", headers: { "if-rev": "1" } }));
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
  }, () => api(docUrl("Library/Race/unlucky"), { method: "PUT", body: "# Unlucky\n" }));
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
    () => api(docUrl("Library/Race/doc"), { method: "PUT", body: myText, headers: { "if-rev": String(doc.rev) } }),
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
  const second = await racing(1, sameName, () => api(docUrl("Library/Race/same"), { method: "PUT", body: "# Mine second\n", headers: { "if-rev": "*" } }));
  assert.equal(second.res.status, 409);
  assert.ok(/already exists/.test(second.res.json.error));
  assert.equal(textAt("Race/same.md"), "# Theirs first\n");
  assert.equal(pathsOf(storedManifest()).filter((p) => p.toLowerCase() === "race/same.md").length, 1, "one file, not two");
  noOrphans(before, "nothing of the loser's is left");

  // A move and a delete ride the same loop.
  const third = await theirFile("Race/third.md", "# Third\n");
  const movedRace = await racing(1, third, () => api("/api/agent/move", { method: "POST", body: { from: "Library/Race/mine", to: "Library/Race/moved" } }));
  assert.equal(movedRace.res.status, 200);
  const fourth = await theirFile("Race/fourth.md", "# Fourth\n");
  const removedRace = await racing(1, fourth, () => api(docUrl("Library/Race/moved"), { method: "DELETE" }));
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
      m.files[`f-full${n}`] = { path: `Full/file-${n}.md`, rev: 1, hash: blobHash(`file ${n}`), size: 9, mtime: 1757000000000, by: ALICE.id };
    }
  });
  const bot = await addAgent("One too many", ["edit"]);
  const api = as(bot);
  const etag = etagNow();
  const blobs = blobKeys().length;
  const over = await api(docUrl("Library/Full/one-more"), { method: "PUT", body: "# One more\n" });
  assert.equal(over.status, 409);
  assert.ok(/too many files/.test(over.json.error), "in the manifest check's own words");
  assert.equal(etagNow(), etag);
  assert.equal(blobKeys().length, blobs, "refused before anything was uploaded");
  // A move adds nothing, and a removal makes room.
  assert.equal((await api("/api/agent/move", { method: "POST", body: { from: "Library/Full/file-0000", to: "Library/Full/renamed" } })).status, 200);
  assert.equal((await api(docUrl("Library/Full/file-0001"), { method: "DELETE" })).status, 200);
  assert.equal((await api(docUrl("Library/Full/one-more"), { method: "PUT", body: "# One more\n" })).status, 201);
  assert.equal(Object.keys(storedManifest().files).length, 5000);
  assert.equal((await api("/api/agent/tree?dir=Library/Full")).json.documents.length, 5000, "and a listing of all of it still answers");
});

/* ---------- The document API: publishing ---------- */

await test("pages: publishing is an entry in the public map — it answers at once, keeps its first publisher, and follows its document through a move, a new version and a removal", async () => {
  await freshWorkspace({
    "Pub/note.md": "# A note\n\nPublic words.\n",
    "Pub/page.html": "<h1>Only a page</h1>\n",
    "Pub/pair.md": "# Pair\n",
    "Pub/pair.html": "<h1>Pair</h1>\n",
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
  const first = await publish({ path: "Library/Pub/note.md" });
  assert.equal(first.status, 201);
  const random = first.json.slug;
  assert.ok(/^[abcdefghjkmnpqrstuvwxyz23456789]{8}$/.test(random), "a random address with no look-alike characters");
  assert.deepEqual(first.json, { slug: random, url: `${ORIGIN}/${random}`, kind: "document", path: "Library/Pub/note", documents: ["Library/Pub/note"], created: true });
  const entry = storedManifest().public[random];
  assert.deepEqual({ ...entry, at: 0 }, { kind: "file", file: fidAt("Pub/note.md"), path: "Pub/note.md", by: bot.id, at: 0 }, "the entry a Mac writes: the file's id, and a snapshot of its path");
  assert.ok(entry.at >= before && entry.at <= Date.now());
  const page = await pub(`/${random}`);
  assert.equal(page.status, 200, "nothing is uploaded or rendered ahead: the address answers the moment the entry lands");
  assert.ok(page.text.includes("Public words."));

  // Publishing it again renames or retitles the page; it does not make a second one.
  const named = await publish({ path: "Library/Pub/note", slug: "  My-Note ", title: "A note, public", desc: "What it says." });
  assert.equal(named.status, 200);
  assert.deepEqual([named.json.slug, named.json.url, named.json.created], ["my-note", `${ORIGIN}/my-note`, false]);
  let map = storedManifest().public;
  assert.deepEqual(Object.keys(map), ["my-note"], "one page a document");
  assert.deepEqual(map["my-note"], { ...entry, title: "A note, public", desc: "What it says." }, "who published it first, and when, stay");
  assert.equal((await pub(`/${random}`)).status, 404);
  assert.ok((await pub("/my-note")).text.includes("<title>A note, public</title>"));
  const etag = etagNow();
  const same = await publish({ path: "Library/Pub/note" });
  assert.deepEqual([same.status, same.json.slug, same.json.created, same.json.written], [200, "my-note", false, false], "already exactly this: nothing is written");
  assert.equal(etagNow(), etag);
  const second = await addAgent("Second publisher", ["publish"]);
  assert.equal((await as(second)("/api/agent/pages", { method: "PUT", body: { path: "Library/Pub/note", title: "Retitled" } })).status, 200);
  map = storedManifest().public;
  assert.deepEqual([map["my-note"].title, map["my-note"].desc, map["my-note"].by, map["my-note"].at], ["Retitled", "What it says.", bot.id, entry.at], "republishing does not take a page over");

  // An address is free, or its own.
  const taken = await publish({ path: "Library/Pub/pair", slug: "my-note" });
  assert.equal(taken.status, 409);
  assert.equal(taken.json.code, "slug_taken");
  assert.ok(/already the address of Library\/Pub\/note.md/.test(taken.json.error));
  for (const slug of ["ab", "has space", "-leading", "api", "join", "a".repeat(65)]) {
    assert.equal((await publish({ path: "Library/Pub/pair", slug })).status, 400, `"${slug}" is not an address`);
  }
  assert.equal((await publish({})).status, 400, "say what to publish");
  assert.equal((await publish({ path: "Library/Pub/nothing" })).status, 404);
  assert.equal((await publish({ path: "Library/.hidden/x" })).status, 400);
  assert.equal((await api("/api/agent/pages", { method: "PUT", body: "not json" })).status, 400);
  for (const path of ["Library/Pub/data.csv", "Library/Pub/pic.png", "Library/Pub/deck.pdf"]) {
    const plain = await publish({ path, slug: "the-pic" });
    assert.equal(plain.status, 400, `${path} is no page: only documents sync`);
    assert.match(plain.json.error, /Doklin syncs markdown and html documents only/);
  }
  assert.deepEqual(Object.keys(storedManifest().public).sort(), ["my-note"], "none of the refusals left an entry");

  // What is public: as addresses, with who and when.
  const listed = await pagesNow();
  assert.deepEqual(listed.map((p) => p.slug), ["my-note"]);
  assert.deepEqual(listed[0], {
    slug: "my-note",
    url: `${ORIGIN}/my-note`,
    kind: "document",
    path: "Library/Pub/note",
    title: "Retitled",
    desc: "What it says.",
    by: bot.id,
    byName: "Publisher",
    at: entry.at,
  });
  const row = (await api("/api/agent/tree?dir=Library/Pub")).json.documents.find((d) => d.path === "Library/Pub/note");
  assert.equal(row.public, undefined, "a listing says no address: a document's info does");
  assert.deepEqual((await api(docUrl("Library/Pub/note", "", "&info=1"))).json.public, [`${ORIGIN}/my-note`]);

  // The domain's home page is chosen in the app; an agent sees it, and republishing leaves it be.
  await macWrite((m) => {
    m.public["my-note"].root = true;
  });
  assert.equal((await pagesNow())[0].home, true);
  assert.deepEqual((await api(docUrl("Library/Pub/note", "", "&info=1"))).json.public, [`${ORIGIN}/`, `${ORIGIN}/my-note`]);
  assert.equal((await publish({ path: "Library/Pub/note", desc: "Still the home page." })).status, 200);
  assert.equal(storedManifest().public["my-note"].root, true);
  await macWrite((m) => {
    delete m.public["my-note"].root;
  });

  // The page follows its document when it moves.
  const noteFid = fidAt("Pub/note.md");
  assert.equal((await api("/api/agent/move", { method: "POST", body: { from: "Library/Pub/note", to: "Library/Pub/renamed" } })).status, 200);
  map = storedManifest().public;
  assert.deepEqual([map["my-note"].file, map["my-note"].path], [noteFid, "Pub/renamed.md"], "the same file, and its new path in the same write");
  assert.equal((await pub("/my-note")).status, 200);
  assert.equal((await pagesNow())[0].path, "Library/Pub/renamed");

  // A document's page is its markdown's when it has one, its html's when it has not.
  const pair = await publish({ path: "Library/Pub/pair.html", slug: "the-pair" });
  assert.equal(pair.json.kind, "document");
  assert.equal(storedManifest().public["the-pair"].file, fidAt("Pub/pair.md"), "typed as the html, published as the document");
  const htmlFid = fidAt("Pub/page.html");
  const only = await publish({ path: "Library/Pub/page", slug: "the-page" });
  assert.deepEqual([only.status, only.json.kind, only.json.path], [201, "document", "Library/Pub/page"]);
  map = storedManifest().public;
  assert.deepEqual([map["the-page"].file, map["the-page"].path], [htmlFid, "Pub/page.html"]);
  const htmlPage = await pub("/the-page");
  assert.equal(htmlPage.status, 200);
  assert.ok(!htmlPage.text.includes('<nav class="view-pill"'), "html only: nothing to switch to");
  // It gains a markdown version: the page becomes the markdown's, which is what gives it the switch.
  assert.equal((await api(docUrl("Library/Pub/page", "md"), { method: "PUT", body: "# Page, in markdown\n" })).status, 201);
  map = storedManifest().public;
  assert.deepEqual([map["the-page"].file, map["the-page"].path], [fidAt("Pub/page.md"), "Pub/page.md"]);
  assert.ok((await pub("/the-page")).text.includes('<nav class="view-pill"'), "both versions, and the pill between them");
  // And loses it again: back to the html.
  assert.equal((await api(docUrl("Library/Pub/page", "md"), { method: "DELETE" })).status, 200);
  map = storedManifest().public;
  assert.deepEqual([map["the-page"].file, map["the-page"].path], [htmlFid, "Pub/page.html"]);
  assert.equal((await pub("/the-page")).status, 200);

  // A page a Mac left on the html of a document that has both: when the html goes, the markdown is what it shows.
  await macWrite((m, put) => {
    put("Pub/left.md", "# Left behind\n");
    const leftHtml = put("Pub/left.html", "<h1>Left behind</h1>\n");
    m.public["left-page"] = { kind: "file", file: leftHtml, path: "Pub/left.html", by: ALICE.id, at: 1757000000000 };
  });
  assert.equal((await api(docUrl("Library/Pub/left", "html"), { method: "DELETE" })).status, 200);
  map = storedManifest().public;
  assert.deepEqual([map["left-page"].file, map["left-page"].path], [fidAt("Pub/left.md"), "Pub/left.md"]);
  assert.ok((await pub("/left-page")).text.includes("<h1>Left behind</h1>"), "the page did not die with the version");
  assert.equal((await unpublish("slug=left-page")).status, 200);
  assert.equal((await api(docUrl("Library/Pub/left"), { method: "DELETE" })).status, 200);

  // A folder: everything in it. The dry run says what that is, and writes nothing.
  const dryEtag = etagNow();
  const dry = await publish({ path: "Library/Pub/Sub/", dryRun: true });
  assert.equal(dry.status, 200);
  assert.deepEqual(
    { ...dry.json, slug: "", url: "" },
    { slug: "", url: "", kind: "folder", path: "Library/Pub/Sub", documents: ["Library/Pub/Sub/Deep/deeper", "Library/Pub/Sub/inner", "Library/Pub/Sub/standalone"], created: true, written: false },
    "every document that would become readable — an html-only one is served there too",
  );
  assert.equal(etagNow(), dryEtag);
  const folder = await publish({ path: "Library/pub/sub/", slug: "sub-folder", title: "Sub" });
  assert.deepEqual([folder.status, folder.json.kind, folder.json.path], [201, "folder", "Library/Pub/Sub"], "the folder as it is spelled, however it was typed");
  map = storedManifest().public;
  assert.deepEqual({ ...map["sub-folder"], at: 0 }, { kind: "dir", path: "Pub/Sub", title: "Sub", by: bot.id, at: 0 });
  assert.ok((await pub("/sub-folder")).text.includes("inner"), "the folder's page lists its notes");
  assert.ok((await pub("/sub-folder/inner")).text.includes("<h1>Inner</h1>"));
  assert.equal((await rawGet("/sub-folder/standalone.html")).status, 200, "and the html-only document answers at its own name");
  const deepFolder = await publish({ path: "Library/Pub/Sub/Deep", slug: "deep-folder" });
  assert.deepEqual([deepFolder.status, deepFolder.json.kind, deepFolder.json.documents], [201, "folder", ["Library/Pub/Sub/Deep/deeper"]], "a folder named without its slash");
  assert.equal((await publish({ path: "Library/Pub/Sub/", slug: "sub-folder" })).json.written, false);
  // Whatever is then public under the folder is what the dry run named.
  const under = new Map();
  for (const d of (await api("/api/agent/tree?dir=Library/Pub/Sub&deep=1")).json.documents) {
    under.set(d.path, (await api(docUrl(d.path, "", "&info=1"))).json.public ?? []);
  }
  assert.deepEqual([...under].filter(([, urls]) => urls.some((u) => u.startsWith(`${ORIGIN}/sub-folder/`))).map(([p]) => p), dry.json.documents);
  assert.deepEqual(under.get("Library/Pub/Sub/Deep/deeper"), [`${ORIGIN}/deep-folder/deeper`, `${ORIGIN}/sub-folder/Deep/deeper`]);
  assert.deepEqual(under.get("Library/Pub/Sub/standalone"), [`${ORIGIN}/sub-folder/standalone.html`]);
  // Library's own folder is the whole shared section: everything everyone sees.
  const allEtag = etagNow();
  const all = await publish({ path: "Library/", dryRun: true });
  assert.deepEqual([all.json.kind, all.json.path, all.json.written], ["folder", "Library", false]);
  assert.deepEqual(all.json.documents, ["Library/Elsewhere/other", "Library/Pub/page", "Library/Pub/pair", "Library/Pub/renamed", "Library/Pub/Sub/Deep/deeper", "Library/Pub/Sub/inner", "Library/Pub/Sub/standalone"]);
  assert.equal(etagNow(), allEtag);
  for (const path of ["", "/", "."]) {
    assert.equal((await publish({ path })).status, 400, `${JSON.stringify(path)} is no section: the workspace itself is not one page`);
  }
  const whole = await publish({ path: "library", slug: "everything" });
  assert.deepEqual([whole.status, whole.json.kind, whole.json.path], [201, "folder", "Library"], "named as it is spelled, however it was typed");
  assert.deepEqual({ ...storedManifest().public.everything, at: 0 }, { kind: "dir", path: "", by: bot.id, at: 0 }, "the whole shared section, as a Mac stores it");
  assert.equal((await pagesNow()).find((p) => p.slug === "everything").path, "Library");
  assert.deepEqual((await unpublish("path=Library/")).json.stopped.map((s) => s.slug), ["everything"]);

  // A published folder follows its folder — and so does one published beneath it, and a page inside it.
  assert.equal((await publish({ path: "Library/Pub/Sub/inner", slug: "the-inner" })).status, 201);
  const innerFid = fidAt("Pub/Sub/inner.md");
  const movedFolder = await api("/api/agent/move", { method: "POST", body: { from: "Library/Pub/Sub/", to: "Library/Pub/Moved" } });
  assert.equal(movedFolder.status, 200);
  map = storedManifest().public;
  assert.equal(map["sub-folder"].path, "Pub/Moved");
  assert.equal(map["deep-folder"].path, "Pub/Moved/Deep");
  assert.deepEqual([map["the-inner"].file, map["the-inner"].path], [innerFid, "Pub/Moved/inner.md"]);
  assert.ok((await pub("/sub-folder/inner")).text.includes("<h1>Inner</h1>"), "the same address, the folder's new place");
  assert.ok((await pub("/deep-folder/deeper")).text.includes("<h1>Deeper</h1>"));

  // A removed document's page stays: it answers 404 until the document is back.
  const removed = await api(docUrl("Library/Pub/renamed"), { method: "DELETE" });
  assert.deepEqual(removed.json.stillPublic, [`${ORIGIN}/my-note`], "the removal says the address is still held");
  map = storedManifest().public;
  assert.deepEqual([map["my-note"].file, map["my-note"].path], [noteFid, "Pub/renamed.md"], "the entry outlives its file");
  assert.equal((await pub("/my-note")).status, 404);
  const ghost = (await pagesNow()).find((p) => p.slug === "my-note");
  assert.deepEqual([ghost.path, ghost.kind, ghost.missing], ["Library/Pub/renamed", "document", true]);
  assert.equal((await publish({ path: "Library/Elsewhere/other", slug: "the-other" })).status, 201);
  assert.deepEqual((await api(docUrl("Library/Elsewhere/other"), { method: "DELETE" })).json.stillPublic, [`${ORIGIN}/the-other`]);
  // The document comes back at its path: the page adopts the new file.
  assert.equal((await api(docUrl("Library/Pub/renamed"), { method: "PUT", body: "# Back again\n" })).status, 201);
  map = storedManifest().public;
  assert.equal(map["my-note"].file, fidAt("Pub/renamed.md"));
  assert.notEqual(map["my-note"].file, noteFid);
  assert.ok((await pub("/my-note")).text.includes("<h1>Back again</h1>"));
  assert.equal((await pagesNow()).find((p) => p.slug === "my-note").missing, undefined);

  // Stopping: by the document, the folder, the address, or the path a dead page remembers.
  const stopEtag = etagNow();
  const dryStop = await unpublish("path=Library/Pub/renamed&dry=1");
  assert.deepEqual(dryStop.json, { stopped: [{ slug: "my-note", url: `${ORIGIN}/my-note` }], written: false });
  assert.equal(etagNow(), stopEtag);
  const stopped = await unpublish("path=Library/Pub/renamed.md");
  assert.equal(stopped.status, 200);
  assert.deepEqual(stopped.json, { stopped: [{ slug: "my-note", url: `${ORIGIN}/my-note` }] });
  assert.equal(storedManifest().public["my-note"], undefined);
  assert.equal((await pub("/my-note")).status, 404);
  assert.ok(entryAt(storedManifest(), "Pub/renamed.md"), "the document itself is untouched");
  const again = await unpublish("path=Library/Pub/renamed");
  assert.equal(again.status, 404);
  assert.ok(/is not published/.test(again.json.error));
  assert.equal((await unpublish("slug=THE-PAGE")).status, 200, "by its address");
  assert.equal((await unpublish("slug=the-page")).status, 404);
  assert.equal((await unpublish("")).status, 400);
  assert.equal((await unpublish("path=Library/.hidden/x")).status, 400);
  assert.deepEqual((await unpublish("path=deep-folder")).json.stopped.map((s) => s.slug), ["deep-folder"], "an address given where a path goes");
  const neither = await unpublish("path=no-such-page");
  assert.equal(neither.status, 400, "a word that is no address is a path, and a path needs its section");
  assert.match(neither.json.error, /^no-such-page is in no section\. Say which: Library\/no-such-page/);
  assert.deepEqual((await unpublish("path=Library/Pub/Moved/")).json.stopped.map((s) => s.slug), ["sub-folder"], "a folder");
  assert.deepEqual((await unpublish("path=Library/Elsewhere/other")).json.stopped.map((s) => s.slug), ["the-other"], "a page whose file is gone, by the path it remembers");
  assert.equal((await unpublish("path=Library/Pub/pic.png")).status, 400, "a name that is no document's is said so");
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
/** Whether the app, opening this document and saving it untouched, writes
 *  back the same bytes: the markdown expands into the editor and extracts
 *  back to itself, with every thread's record as it was, and the sidecar
 *  serializes to itself. */
const settled = (stem, mdExt = ".md") => {
  const metaText = textAt(`${stem}.meta.jsonl`) ?? "";
  const meta = appMeta.parseEntityMeta(metaText);
  if (metaText !== "" && appMeta.serializeEntityMeta(meta) !== metaText) return false;
  const md = mdExt ? textAt(`${stem}${mdExt}`) : null;
  if (md === null) return true;
  const expanded = appMeta.expandMarkdown(md, meta.mthreads);
  const extracted = appMeta.extractMarkdown(expanded.md);
  const orphans = new Set(expanded.orphanIds);
  const saved = { ...meta, mthreads: [...extracted.mthreads, ...meta.mthreads.filter((t) => orphans.has(t.id))] };
  return extracted.md === md && appMeta.serializeEntityMeta(saved) === appMeta.serializeEntityMeta(meta);
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
    "Talk/typed.md": "Hello {==typed words==}{>>a note somebody typed<<} there.\n",
  });
  const bot = await addAgent("Reviewer", ["comment", "edit"]);
  const api = as(bot);
  const say = (body) => api("/api/agent/comments", { method: "POST", body });
  const threads = async (p) => (await api(commentsUrl(p))).json.threads;
  const start = storedManifest();
  const [mdFid] = entryAt(start, "Talk/draft.md");
  const before = Date.now();

  assert.deepEqual((await api(commentsUrl("Library/Talk/draft"))).json, { path: "Library/Talk/draft", threads: [] });

  // Where a comment cannot sit. Every refusal lists the places, so the
  // caller can quote more of the sentence.
  const twice = await say({ path: "Library/Talk/draft", on: "ships in June", body: "When?" });
  assert.equal(twice.status, 409);
  assert.equal(twice.json.code, "anchor");
  assert.ok(/occurs 2 times/.test(twice.json.error), "the heading and the paragraph — not the frontmatter, not the code");
  assert.deepEqual(twice.json.occurrences, [
    { line: 2, text: "title: ships in June", inside: "the frontmatter at the top" },
    { line: 4, text: "# The boat ships in June" },
    { line: 6, text: "The boat ships in June if the paint dries. The crew is ready." },
    { line: 8, text: "Use `launch-window` and `ships in June` in code. See [the plan](https://example.com/the-paint-dries).", inside: "code" },
  ]);
  const both = await say({ path: "Library/Talk/draft", on: "The crew is ready", body: "Are they?" });
  assert.deepEqual([both.status, both.json.code, both.json.occurrences.map((o) => o.line)], [409, "anchor", [6, 10]]);
  const none = await say({ path: "Library/Talk/draft", on: "no such words", body: "?" });
  assert.deepEqual([none.status, none.json.code, none.json.occurrences], [404, "anchor", []]);
  assert.ok(/does not occur in the markdown of Library\/Talk\/draft/.test(none.json.error));
  const inCode = await say({ path: "Library/Talk/draft", on: "launch-window", body: "?" });
  assert.deepEqual([inCode.status, inCode.json.code], [409, "anchor"]);
  assert.ok(/only occurs inside code/.test(inCode.json.error));
  assert.deepEqual(inCode.json.occurrences.map((o) => [o.line, o.inside]), [[8, "code"]]);
  const inAddress = await say({ path: "Library/Talk/draft", on: "the-paint-dries", body: "?" });
  assert.ok(/only occurs inside a link's address/.test(inAddress.json.error));
  const listMark = await say({ path: "Library/Talk/draft", on: "- The crew is ready.", body: "?" });
  assert.equal(listMark.status, 409);
  assert.ok(/a heading or list mark — quote the words after it/.test(listMark.json.error));
  for (const on of ["**bold** words", "a `code` span", "[the plan]", "two\nlines", "the_plan _now_"]) {
    assert.equal((await say({ path: "Library/Talk/draft", on, body: "?" })).status, 400, `${JSON.stringify(on)} is not plain words on one line`);
  }
  assert.equal((await say({ path: "Library/Talk/draft", on: "   ", body: "?" })).status, 400, "which words");
  assert.equal((await say({ path: "Library/Talk/draft", on: "The boat", body: "  \n " })).status, 400, "and something to say");
  assert.equal((await say({ path: "Library/Talk/draft", on: "The boat", body: "?", v: "pdf" })).status, 400);
  assert.equal((await say({ path: "Library/Talk/draft", on: "if the paint dries", body: "?", v: "html" })).status, 404, "it has no html version");
  assert.equal((await say({ path: "Library/Talk/nothing", on: "words", body: "?" })).status, 404);
  assert.equal((await say({ path: "Library/Talk/chart.png", on: "words", body: "?" })).status, 400, "no document, no comments");
  assert.equal((await api(commentsUrl("Library/Talk/chart.png"))).status, 400);
  assert.equal((await api(commentsUrl("Library/Talk/nothing"))).status, 404);
  assert.equal((await api("/api/agent/comments", { method: "POST", body: "not json" })).status, 400);
  assert.equal(storedManifest().seq, start.seq, "none of the refusals wrote anything");
  assert.equal(textAt("Talk/draft.md"), DRAFT);

  // A dry run says where the thread would go, and writes neither half.
  const dry = await say({ path: "Library/Talk/draft", on: "if the paint dries", body: "Is that still true?", dryRun: true });
  assert.equal(dry.status, 200);
  assert.deepEqual([dry.json.version, dry.json.on, dry.json.line, dry.json.written], ["md", "if the paint dries", 6, false]);
  assert.equal(storedManifest().seq, start.seq);
  assert.equal(textAt("Talk/draft.md"), DRAFT);

  // The words occur once in ordinary text — the copy inside the code block does not count.
  const made = await say({ path: "Library/Talk/draft.md", on: "  if the paint dries ", body: "Is that\n\nstill true?" });
  assert.equal(made.status, 201);
  const id = made.json.thread;
  assert.ok(/^[a-z0-9]{6}$/.test(id));
  assert.deepEqual(made.json, { path: "Library/Talk/draft", thread: id, version: "md", on: "if the paint dries", line: 6 });
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

  assert.deepEqual(await threads("Library/Talk/draft"), [
    { id, version: "md", on: "if the paint dries", line: 6, comments: [{ author: "Reviewer", at, body: "Is that still true?" }] },
  ]);

  // Words inside an existing comment cannot carry another.
  const nested = await say({ path: "Library/Talk/draft", on: "paint dries", body: "?" });
  assert.equal(nested.status, 409);
  assert.ok(/only occurs inside an existing comment/.test(nested.json.error));

  // Answering: the sidecar alone changes.
  const other = await addAgent("Second reviewer", ["comment"]);
  const reply = await as(other)("/api/agent/comments", { method: "POST", body: { path: "Library/Talk/draft", thread: `#${id}`, body: "Yes." } });
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.json, { path: "Library/Talk/draft", thread: id, version: "md", comments: 2 });
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
  assert.equal((await say({ path: "Library/Talk/draft", thread: "nope00", body: "?" })).status, 404);
  const dryReply = await say({ path: "Library/Talk/draft", thread: id, body: "Not written.", dryRun: true });
  assert.deepEqual([dryReply.status, dryReply.json.comments, dryReply.json.written], [200, 3, false]);
  assert.equal((await threads("Library/Talk/draft"))[0].comments.length, 2);

  // A second thread; reading shows both markers, and --clean neither.
  const secondThread = await say({ path: "Library/Talk/draft", on: "in code", body: "Which code?" });
  assert.deepEqual([secondThread.status, secondThread.json.line], [201, 8]);
  const id2 = secondThread.json.thread;
  assert.notEqual(id2, id);
  const read = await api(docUrl("Library/Talk/draft"));
  assert.ok(read.text.includes(`{==if the paint dries==}{>>#${id}<<}`) && read.text.includes(`{==in code==}{>>#${id2}<<}`), "a read keeps the markers, so a write back keeps the comments");
  const clean = await api(docUrl("Library/Talk/draft", "", "&clean=1"));
  assert.equal(clean.text, DRAFT, "--clean is the text as it was before anyone commented");
  assert.equal(clean.headers.get("x-doklin-rev"), read.headers.get("x-doklin-rev"));
  assert.deepEqual((await threads("Library/Talk/draft")).map((t) => [t.id, t.line]), [[id, 6], [id2, 8]]);
  assert.equal((await api(docUrl("Library/Talk/draft", "", "&info=1"))).json.comments, 2);

  // Rewriting the document. Markers kept: nothing to say.
  const rev = () => String(entryAt(storedManifest(), "Talk/draft.md")[1].rev);
  const kept = await api(docUrl("Library/Talk/draft"), { method: "PUT", body: read.text.replace("The crew is ready.", "The crew is rested."), headers: { "if-rev": rev() } });
  assert.equal(kept.status, 200);
  const current = (await api(docUrl("Library/Talk/draft"))).text;
  // A marker may move, with its words.
  const marker2 = `{==in code==}{>>#${id2}<<}`;
  const moved = current.replace(`and \`ships in June\` ${marker2}. See`, `${marker2}: and \`ships in June\`. See`);
  assert.notEqual(moved, current);
  assert.equal((await api(docUrl("Library/Talk/draft"), { method: "PUT", body: moved, headers: { "if-rev": rev() } })).status, 200);
  assert.deepEqual((await threads("Library/Talk/draft")).map((t) => [t.id, t.orphaned ?? false, t.on]), [[id, false, "if the paint dries"], [id2, false, "in code"]]);
  assert.equal((await api(docUrl("Library/Talk/draft"), { method: "PUT", body: current, headers: { "if-rev": rev() } })).status, 200);

  // Anything else a write does to a marker is refused, and writes nothing.
  const refusedWrite = async (body, more = "") => {
    const before = storedManifest().seq;
    const res = await api(docUrl("Library/Talk/draft", "", more), { method: "PUT", body, headers: more === "&force=1" ? {} : { "if-rev": rev() } });
    assert.deepEqual([res.status, res.json.code], [400, "comments"], res.json.error);
    assert.equal(storedManifest().seq, before);
    return res.json;
  };
  // A marker dropped — no flag gets past that, --force included: a thread is removed with the comments route.
  const dropped = await refusedWrite(current.replace(marker2, "in code"));
  assert.deepEqual(dropped.threads, [id2]);
  assert.ok(dropped.error.includes(`remove the marker of comment #${id2} (on "in code")`) && dropped.error.includes(`doklin comment rm Library/Talk/draft ${id2}`), dropped.error);
  await refusedWrite(current.replace(marker2, "in code"), "&dry=1");
  await refusedWrite(current.replace(marker2, "in code"), "&force=1");
  // Its words changed.
  const reworded = await refusedWrite(current.replace(marker2, `{==in the code==}{>>#${id2}<<}`));
  assert.deepEqual([reworded.threads, reworded.added], [[id2], [id2]]);
  assert.ok(reworded.error.includes(`change the words of comment #${id2}`), reworded.error);
  // The clean text written back over the markdown: every marker.
  assert.deepEqual((await refusedWrite(DRAFT)).threads.sort(), [id, id2].sort());
  // A marker of its own making — a thread is started with the comments route.
  const invented = await refusedWrite(`${current}\n{==my own==}{>>#zzz999<<}\n`);
  assert.deepEqual([invented.added, invented.threads], [["zzz999"], undefined]);
  assert.ok(invented.error.includes("start a thread with `doklin comment`"), invented.error);
  assert.equal((await api(docUrl("Library/Talk/fresh"), { method: "PUT", body: "A {==new==}{>>#abc999<<} document.\n" })).status, 400, "in a new document too");
  assert.deepEqual((await threads("Library/Talk/draft")).map((t) => t.orphaned ?? false), [false, false], "every thread is where it was");

  // Removing a thread unwraps its marker: the words stay.
  const dryRm = await api(commentsUrl("Library/Talk/draft", `&thread=${id2}&dry=1`), { method: "DELETE" });
  assert.deepEqual(dryRm.json, { path: "Library/Talk/draft", thread: id2, version: "md", removed: false });
  assert.equal((await threads("Library/Talk/draft")).length, 2);
  const rm = await api(commentsUrl("Library/Talk/draft", `&thread=%23${id2}`), { method: "DELETE" });
  assert.equal(rm.status, 200);
  assert.deepEqual(rm.json, { path: "Library/Talk/draft", thread: id2, version: "md", removed: true });
  assert.ok(!textAt("Talk/draft.md").includes(id2) && textAt("Talk/draft.md").includes("`ships in June` in code. See"));
  assert.deepEqual(recordsOf(textAt("Talk/draft.meta.jsonl")).map((r) => r.id), [id]);
  assert.ok(settled("Talk/draft"));
  assert.equal((await api(commentsUrl("Library/Talk/draft", `&thread=${id2}`), { method: "DELETE" })).status, 404);
  assert.equal((await api(commentsUrl("Library/Talk/draft"), { method: "DELETE" })).status, 400, "which thread");
  // The last one takes the sidecar with it.
  const beforeLast = storedManifest();
  assert.equal((await api(commentsUrl("Library/Talk/draft", `&thread=${id}`), { method: "DELETE" })).status, 200);
  const afterLast = storedManifest();
  assert.equal(afterLast.seq, beforeLast.seq + 1);
  assert.equal(afterLast.files[metaFid], undefined, "no empty sidecar is left on anybody's disk");
  assert.equal(afterLast.tombstones[metaFid].path, "Talk/draft.meta.jsonl");
  assert.equal(textAt("Talk/draft.md"), DRAFT.replace("The crew is ready.", "The crew is rested."), "and the text is the text again");
  assert.deepEqual(await threads("Library/Talk/draft"), []);

  // A comment somebody typed by hand, with no id: a thread like any other,
  // given its id and its record the first time it is changed, as the app's
  // own save would give them.
  const typed = await threads("Library/Talk/typed");
  assert.equal(typed.length, 1);
  assert.match(typed[0].id, /^[a-z0-9]{8}$/);
  assert.deepEqual(typed[0], { id: typed[0].id, version: "md", on: "typed words", line: 1, comments: [{ author: "", at: 0, body: "a note somebody typed" }] });
  assert.equal((await say({ path: "Library/Talk/typed", thread: typed[0].id, body: "Answered." })).json.comments, 2);
  assert.equal(textAt("Talk/typed.md"), `Hello {==typed words==}{>>#${typed[0].id}<<} there.\n`, "the note moved out of the prose");
  assert.deepEqual(recordsOf(textAt("Talk/typed.meta.jsonl"))[0].comments.map((c) => c.body), ["a note somebody typed", "Answered."]);
  assert.ok(settled("Talk/typed"), "exactly as the app's own save would have left it");
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
  const made = await say({ path: "Library/Talk/page", on: "Paint the  hull before", body: "By when?" });
  assert.equal(made.status, 201);
  const id = made.json.thread;
  assert.deepEqual(made.json, { path: "Library/Talk/page", thread: id, version: "html", on: "Paint the hull before June", tag: "p" }, "the paragraph, not the list item or the list around it");
  const one = storedManifest();
  assert.equal(one.seq, start.seq + 1);
  assert.deepEqual(one.files[htmlFid], htmlFile, "the page itself is not touched");
  const records = recordsOf(textAt("Talk/page.meta.jsonl"));
  assert.deepEqual(records.map((r) => [r.t, r.id, r.anchor, r.comments.map((c) => [c.author, c.body])]), [
    ["hthread", id, { path: "", tag: "p", text: "Paint the hull before June" }, [["Page reviewer", "By when?"]]],
  ]);
  assert.ok(settled("Talk/page", null), "a sidecar the app reads as its own");
  assert.deepEqual(await threads("Library/Talk/page.html"), [
    { id, version: "html", on: "Paint the hull before June", tag: "p", comments: [{ author: "Page reviewer", at: records[0].comments[0].at, body: "By when?" }] },
  ]);

  // More than one element, or none: refused with the candidates.
  const two = await say({ path: "Library/Talk/page", on: "Paint the hull", body: "?" });
  assert.deepEqual([two.status, two.json.code], [409, "anchor"]);
  assert.deepEqual(two.json.candidates, [
    { tag: "p", text: "Paint the hull before June" },
    { tag: "p", text: "Paint the hull twice." },
  ]);
  const none = await say({ path: "Library/Talk/page", on: "Nothing like this", body: "?" });
  assert.deepEqual([none.status, none.json.code, none.json.candidates], [404, "anchor", []]);
  assert.equal((await say({ path: "Library/Talk/page", on: "var hidden", body: "?" })).status, 404, "what nobody sees is not an element to comment on");
  assert.equal((await say({ path: "Library/Talk/page", on: "p { color", body: "?" })).status, 404);
  assert.equal((await say({ path: "Library/Talk/page", on: "Paint the hull before", body: "?", v: "md" })).status, 404, "it has no markdown version");
  assert.equal((await say({ path: "Library/Talk/md-only", on: "Markdown", body: "?", v: "html" })).status, 404, "and this one no html");
  assert.equal(storedManifest().seq, one.seq);

  // A heading — its title and the script that repeats it are not it; and an
  // item nobody closed, with an entity in it.
  const heading = await say({ path: "Library/Talk/page", on: "Launch plan", body: "Good title." });
  assert.deepEqual([heading.status, heading.json.tag, heading.json.on], [201, "h1", "Launch plan"]);
  const item = await say({ path: "Library/Talk/page", on: "Check the sails & the", body: "Both?" });
  assert.deepEqual([item.status, item.json.tag, item.json.on], [201, "li", "Check the sails & the rigging"]);
  const dry = await say({ path: "Library/Talk/page", on: "Paint the hull twice", body: "Twice?", dryRun: true });
  assert.deepEqual([dry.status, dry.json.tag, dry.json.written], [200, "p", false]);
  assert.equal((await threads("Library/Talk/page")).length, 3);

  const reply = await say({ path: "Library/Talk/page", thread: id, body: "By June." });
  assert.deepEqual(reply.json, { path: "Library/Talk/page", thread: id, version: "html", comments: 2 });

  // The page is regenerated. Taking away the element a thread is on is refused, whatever the flags…
  const without = PAGE.replace("  <li><p>Paint the hull before June</p></li>\n", "");
  const seq = storedManifest().seq;
  for (const more of ["", "&force=1"]) {
    const lost = await api(docUrl("Library/Talk/page", "html", more), { method: "PUT", body: without, headers: more ? {} : { "if-rev": "1" } });
    assert.deepEqual([lost.status, lost.json.code, lost.json.threads], [400, "comments", [id]]);
    assert.ok(lost.json.error.includes(`the <p> comment #${id} is on ("Paint the hull before June")`) && lost.json.error.includes(`doklin comment rm Library/Talk/page ${id}`), lost.json.error);
  }
  assert.equal(storedManifest().seq, seq);
  // …and moving it is not: the thread finds its element wherever in the page it now is.
  const moved = PAGE.replace("<h1>Launch plan</h1>", "<h1>Launch plan</h1>\n<section><p>Paint the hull before June, weather allowing.</p></section>").replace("  <li><p>Paint the hull before June</p></li>\n", "");
  assert.equal((await api(docUrl("Library/Talk/page", "html"), { method: "PUT", body: moved, headers: { "if-rev": "1" } })).status, 200);
  assert.deepEqual((await threads("Library/Talk/page")).map((t) => t.orphaned ?? false), [false, false, false]);

  // Removing: the sidecar only, and the sidecar itself with the last one.
  const rm = await api(commentsUrl("Library/Talk/page", `&thread=${id}`), { method: "DELETE" });
  assert.deepEqual(rm.json, { path: "Library/Talk/page", thread: id, version: "html", removed: true });
  assert.equal((await api(commentsUrl("Library/Talk/page", `&thread=${heading.json.thread}`), { method: "DELETE" })).status, 200);
  assert.equal((await api(commentsUrl("Library/Talk/page", `&thread=${item.json.thread}`), { method: "DELETE" })).status, 200);
  assert.equal(entryAt(storedManifest(), "Talk/page.meta.jsonl"), undefined);
  assert.deepEqual(await threads("Library/Talk/page"), []);

  // A document with both versions: the markdown unless html is said, and one list of threads.
  const onMd = await say({ path: "Library/Talk/both", on: "Some plain words", body: "In the text." });
  assert.deepEqual([onMd.status, onMd.json.version, onMd.json.line], [201, "md", 3]);
  const onHtml = await say({ path: "Library/Talk/both", on: "Some plain words", body: "On the page.", v: "html" });
  assert.deepEqual([onHtml.status, onHtml.json.version, onHtml.json.tag], [201, "html", "p"]);
  // The name it is typed under picks a version too, as it does for a read.
  const viaHtmlName = await say({ path: "Library/Talk/both.html", on: "Both", body: "The heading of the page." });
  assert.deepEqual([viaHtmlName.status, viaHtmlName.json.version, viaHtmlName.json.tag, viaHtmlName.json.path], [201, "html", "h1", "Library/Talk/both"]);
  const viaMdName = await say({ path: "Library/Talk/both.md", on: "Both", body: "The heading of the text." });
  assert.deepEqual([viaMdName.status, viaMdName.json.version, viaMdName.json.line], [201, "md", 1]);
  assert.equal((await say({ path: "Library/Talk/both.md", on: "Both", body: "?", v: "html" })).status, 400, "a flag that contradicts the name");
  assert.equal((await say({ path: "Library/Talk/both.html", thread: onMd.json.thread, body: "A reply goes by its thread, whatever the name." })).json.version, "md");
  const all = await threads("Library/Talk/both.html");
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
  assert.equal((await api(docUrl("Library/Talk/both", "", "&info=1"))).json.comments, 4);
  // The html version removed: its threads go with it, and the markdown's stay.
  assert.equal((await api(docUrl("Library/Talk/both", "html"), { method: "DELETE" })).json.threadsRemoved, 2);
  assert.deepEqual((await threads("Library/Talk/both")).map((t) => t.version), ["md", "md"]);
});

await test("comments: an html thread by an element's id, and one on words — a write may reword or move what a thread is on, and may not take it away", async () => {
  const PAGE = [
    "<!doctype html>",
    "<html><body>",
    '<section id="launch"><h2>Launch</h2>',
    "<p>The boat ships in June if the paint dries.</p>",
    '<figure id="revenue-chart"><svg width="40" height="20"></svg></figure>',
    '<figure id="twice"></figure><figure id="twice"></figure>',
    "</section>",
    "</body></html>",
    "",
  ].join("\n");
  // A thread on words is the app's to start: here as a Mac left it.
  const WORDS = { path: "", tag: "p", text: "The boat ships in June if the paint dries.", ids: ["launch"], quote: "ships in June", prefix: "The boat ", suffix: " if the paint dries." };
  await freshWorkspace({
    "Talk/page.html": PAGE,
    "Talk/page.meta.jsonl": sidecar({ t: "hthread", id: "words1", anchor: WORDS, comments: [{ author: "Ada", at: 1757000000000, body: "Still June?" }] }),
  });
  const bot = await addAgent("Page reviewer", ["comment", "edit"]);
  const api = as(bot);
  const say = (body) => api("/api/agent/comments", { method: "POST", body });
  const threads = async () => (await api(commentsUrl("Library/Talk/page"))).json.threads;
  const anchorOf = (id) => recordsOf(textAt("Talk/page.meta.jsonl")).find((r) => r.id === id).anchor;
  const put = (body) => api(docUrl("Library/Talk/page", "html", "&force=1"), { method: "PUT", body });

  // An element with no words is named by its id, and the thread keeps the ids around it.
  const chart = await say({ path: "Library/Talk/page", on: "#revenue-chart", body: "Which year?" });
  assert.deepEqual([chart.status, chart.json.tag, chart.json.on], [201, "figure", ""]);
  assert.deepEqual(anchorOf(chart.json.thread), { path: "", tag: "figure", text: "", ids: ["revenue-chart", "launch"] });
  const none = await say({ path: "Library/Talk/page", on: "#no-such", body: "?" });
  assert.deepEqual([none.status, none.json.code], [404, "anchor"]);
  assert.ok(none.json.error.includes('has the id "no-such"'), none.json.error);
  const two = await say({ path: "Library/Talk/page", on: "#twice", body: "?" });
  assert.deepEqual([two.status, two.json.code, two.json.candidates.length], [409, "anchor", 2]);
  // One started by its opening words keeps them too.
  const heading = await say({ path: "Library/Talk/page", on: "Launch", body: "Good." });
  assert.deepEqual(anchorOf(heading.json.thread), { path: "", tag: "h2", text: "Launch", ids: ["launch"] });
  assert.deepEqual(anchorOf("words1"), WORDS, "a thread on words comes through the worker's writes whole");
  assert.deepEqual((await threads()).map((t) => [t.id, t.on, t.tag, t.orphaned ?? false]).sort(), [
    [chart.json.thread, "", "figure", false],
    [heading.json.thread, "Launch", "h2", false],
    ["words1", "ships in June", "p", false],
  ].sort());

  // The page written again. The paragraph around the words changes, the words
  // are reworded a little, everything moves into another section: all fine.
  const moved = PAGE.replace('<section id="launch">', '<section id="plan">')
    .replace("<p>The boat ships in June if the paint dries.</p>", "<p>Weather allowing, the boat ships in Juni.</p>")
    .replace('<figure id="revenue-chart"><svg width="40" height="20"></svg></figure>', '<div><figure id="revenue-chart"><svg width="80" height="20"></svg></figure></div>');
  assert.equal((await put(moved)).status, 200);
  assert.deepEqual((await threads()).map((t) => t.orphaned ?? false), [false, false, false]);

  // Taking the words away is refused, and the refusal says which words.
  const seq = storedManifest().seq;
  const noWords = await put(moved.replace("<p>Weather allowing, the boat ships in Juni.</p>", "<p>Weather allowing, we wait.</p>"));
  assert.deepEqual([noWords.status, noWords.json.code, noWords.json.threads], [400, "comments", ["words1"]]);
  assert.ok(noWords.json.error.includes('the words comment #words1 is on ("ships in June") — keep those words'), noWords.json.error);
  // And so is taking away an element named by its id, which says the id.
  const noChart = await put(moved.replace('<div><figure id="revenue-chart"><svg width="80" height="20"></svg></figure></div>', ""));
  assert.deepEqual([noChart.status, noChart.json.threads], [400, [chart.json.thread]]);
  assert.ok(noChart.json.error.includes(`the <figure id="revenue-chart"> comment #${chart.json.thread} is on — keep that element and its id`), noChart.json.error);
  // Both at once: each is named.
  const neither = await put(moved.replace("<p>Weather allowing, the boat ships in Juni.</p>", "").replace("<h2>Launch</h2>", "<h2>Leaving</h2>"));
  assert.deepEqual([neither.status, neither.json.threads.slice().sort()], [400, [heading.json.thread, "words1"].sort()]);
  assert.ok(neither.json.error.includes("keep them"), neither.json.error);
  assert.equal(storedManifest().seq, seq, "a refused write writes nothing");

  // A page that builds itself: what its file never had is not this write's to keep.
  await freshWorkspace({
    "Talk/built.html": '<!doctype html><html><body><div id="app"></div><script>render()</script></body></html>\n',
    "Talk/built.meta.jsonl": sidecar({ t: "hthread", id: "built1", anchor: { path: "", tag: "p", text: "Built by the page.", ids: ["app"], quote: "the page", prefix: "Built by ", suffix: "." }, comments: [{ author: "Ada", at: 1757000000000, body: "Says who?" }] }),
  });
  const bot2 = await addAgent("Page writer", ["comment", "edit"]);
  const built = await as(bot2)(docUrl("Library/Talk/built", "html", "&force=1"), { method: "PUT", body: '<!doctype html><html><body><div id="app"></div><script>render(2)</script></body></html>\n' });
  assert.equal(built.status, 200);
  assert.deepEqual((await as(bot2)(commentsUrl("Library/Talk/built"))).json.threads.map((t) => [t.id, t.on, t.orphaned ?? false]), [["built1", "the page", false]], "and nobody can say it is gone");
});

/* ---------- The document API: search ---------- */

const searchUrl = (q, more = "") => `/api/agent/search?q=${encodeURIComponent(q)}${more}`;
const mirrorEtag = (space = "") => db.value("SELECT etag FROM search_state WHERE space_id = ?", space);
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
  assert.equal((await api(docUrl("Library/Lib/extra"), { method: "PUT", body: "# Extra\n\nA zebra crossing.\n" })).status, 201);
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
    results: [{ path: "Library/Lib/doc-07", version: "md", matches: [{ line: 4, text: "Only this one says needle-07." }] }],
    total: 1,
  });
  assert.equal(third.reads, 1, "the mirror said which document; one blob was read, to cut the line");
  assert.equal(db.value("SELECT COUNT(*) FROM search_text"), total, "one row a document");
  assert.equal(mirrorEtag(), etagNow());
  const [fid07] = entryAt(storedManifest(), "Lib/doc-07.md");
  assert.equal(db.value("SELECT folded FROM search_text WHERE fid = ?", fid07), files["Lib/doc-07.md"].toLowerCase(), "keyed by file id, lower-cased");
  assert.equal((await found("zebra")).results[0].path, "Library/Lib/extra", "what was written before the first search was read with everything else");

  // The question the app's own search asks: which documents contain this, whatever the case — with the lines as written.
  const upper = await found("NEEDLE-07");
  assert.deepEqual([upper.query, upper.results], ["NEEDLE-07", third.res.json.results]);
  const shared = await countingBlobReads(() => api(searchUrl("shared")));
  assert.deepEqual([shared.res.json.total, shared.res.json.results.length, shared.res.json.truncated], [51, 20, true], "twenty documents unless asked");
  assert.equal(shared.reads, 20, "and only the ones shown are read");
  assert.deepEqual(shared.res.json.results.slice(0, 3).map((r) => r.path), ["Library/Lib/doc-01", "Library/Lib/doc-02", "Library/Lib/doc-03"], "in the order a listing has them");
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
      path: "Library/Lib/many",
      version: "md",
      matches: [3, 4, 5, 6, 7].map((line) => ({ line, text: `Ripple number ${line - 2}.` })),
      moreLines: 2,
    },
  ]);

  // Under one folder.
  assert.deepEqual((await found("shared", "&dir=Library/Other")).results.map((r) => r.path), ["Library/Other/away"]);
  assert.equal((await found("shared", "&dir=Library/lib")).total, 50, "a folder in whatever case");
  const away = await found("shared", "&dir=/Library/Other/");
  assert.deepEqual([away.dir, away.total], ["Library/Other", 1]);
  assert.deepEqual(await found("shared", "&dir=Library/Nowhere"), { query: "shared", dir: "Library/Nowhere", results: [], total: 0 });
  assert.equal((await api(searchUrl("shared", "&dir=Library/.git"))).status, 400);
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
  assert.deepEqual(small.res.json.results, [{ path: "Library/Lib/beta", version: "md", matches: [{ line: 3, text: "Only this one says needle." }] }]);
  assert.equal(small.reads, 5 + 1, "five documents mirrored — the html beside a markdown is not one — and one line cut");
  assert.equal(db.value("SELECT COUNT(*) FROM search_text"), 5, "rows of documents that are gone were dropped in the same round");
  assert.equal(mirrorEtag(), etagNow());

  // An agent finds what it just wrote: the write itself caught the mirror up.
  assert.equal((await api(docUrl("Library/Lib/new"), { method: "PUT", body: "# New\n\nA walrus on the ice.\n" })).status, 201);
  assert.equal(mirrorEtag(), etagNow(), "whole at the manifest the write left");
  const walrus = await countingBlobReads(() => api(searchUrl("walrus")));
  assert.deepEqual(walrus.res.json.results, [{ path: "Library/Lib/new", version: "md", matches: [{ line: 3, text: "A walrus on the ice." }] }]);
  assert.equal(walrus.reads, 1, "nothing left to catch up");
  assert.equal((await api(docUrl("Library/Lib/new"), { method: "PUT", body: "# New\n\nA narwhal instead.\n", headers: { "if-rev": "1" } })).status, 200);
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
  assert.deepEqual(okapi.res.json.results.map((r) => r.path), ["Library/Other/mac"], "an edit made on a Mac is found after its sync");
  assert.equal(okapi.reads, 2 + 1, "the two documents that changed, and the line");
  assert.equal(mirrorEtag(), etagNow());
  assert.deepEqual([(await found("first letter")).total, (await found("lemur")).results[0].path], [0, "Library/Lib/alpha"]);
  // More at once than a search answers inline: caught up, and asked again.
  await macWrite((m, put) => {
    for (let i = 1; i <= 9; i += 1) put(`Bulk/b${i}.md`, `# B${i}\n\nA heron by the water.\n`);
  });
  assert.deepEqual((await api(searchUrl("heron"))).json, { indexing: true, pending: 0 });
  assert.equal((await found("heron")).total, 9);

  // What was said about a document is searched with it — and a marker never splits a line.
  const said = await api("/api/agent/comments", { method: "POST", body: { path: "Library/Lib/beta", on: "needle", body: "A platypus would say otherwise." } });
  assert.equal(said.status, 201);
  assert.ok(textAt("Lib/beta.md").includes("{==needle==}"));
  assert.deepEqual((await found("platypus")).results, [{ path: "Library/Lib/beta", version: "md", matches: [], inComments: true }]);
  assert.deepEqual((await found("says needle.")).results, [{ path: "Library/Lib/beta", version: "md", matches: [{ line: 3, text: "Only this one says needle." }] }]);
  assert.equal((await found("{==")).total, 0, "markers are not text");

  // A move changes no text: no document is read and no row rewritten.
  const [betaFid] = entryAt(storedManifest(), "Lib/beta.md");
  db.queries.length = 0;
  const moved = await countingBlobReads(() => api("/api/agent/move", { method: "POST", body: { from: "Library/Lib/beta", to: "Library/Archive/beta" } }));
  assert.equal(moved.res.status, 200);
  assert.equal(moved.reads, 0);
  assert.ok(!db.queries.some((sql) => /INTO search_text|DELETE FROM search_text/.test(sql)), "the mirror is keyed by file id, so a move costs it nothing");
  assert.equal(mirrorEtag(), etagNow(), "only the etag it is whole at moved on");
  assert.deepEqual((await found("platypus")).results.map((r) => r.path), ["Library/Archive/beta"], "found where it now is");
  assert.deepEqual([(await found("platypus", "&dir=Library/Lib")).total, (await found("platypus", "&dir=Library/Archive")).total], [0, 1]);
  // A removal takes the row.
  assert.equal((await api(docUrl("Library/Archive/beta"), { method: "DELETE" })).status, 200);
  assert.equal((await found("platypus")).total, 0);
  assert.equal(db.value("SELECT COUNT(*) FROM search_text WHERE fid = ?", betaFid), 0);

  // An html-only document is searched by what it says — not its markup, its style or its title.
  assert.deepEqual((await found("aardvark sighting")).results, [{ path: "Library/Lib/page", version: "html", matches: [{ text: "An aardvark sighting" }] }]);
  assert.equal((await found("color: teal")).total, 0);
  assert.equal((await found("hidden title")).total, 0);
  assert.equal((await found("<b>")).total, 0);
  assert.equal((await api("/api/agent/comments", { method: "POST", body: { path: "Library/Lib/page", on: "Sightings", body: "A capybara, surely." } })).status, 201);
  assert.deepEqual((await found("capybara")).results, [{ path: "Library/Lib/page", version: "html", matches: [], inComments: true }]);
  // The html beside a markdown is that document's other version, not a text of its own…
  assert.equal((await found("quokka")).total, 0);
  // …until it is all the document has.
  assert.equal((await api(docUrl("Library/Lib/pair", "md"), { method: "DELETE" })).status, 200);
  assert.deepEqual((await found("quokka")).results, [{ path: "Library/Lib/pair", version: "html", matches: [{ text: "The quokka is only on the page." }] }]);
  assert.equal((await found("markdown side")).total, 0);

  // Too large to hold: listed as not searched, rather than silently never found.
  const huge = `# Huge\n\n${"leviathan ".repeat(110_000)}\n`;
  let hugeFid;
  await macWrite((m, put) => {
    hugeFid = put("Lib/huge.md", huge);
  });
  const big = await countingBlobReads(() => api(searchUrl("leviathan")));
  assert.deepEqual([big.res.status, big.res.json.total, big.res.json.results, big.res.json.notSearched], [200, 0, [], ["Library/Lib/huge"]]);
  assert.equal(big.reads, 0, "and not read to find that out");
  assert.equal(db.value("SELECT folded IS NULL FROM search_text WHERE fid = ?", hugeFid), 1);
  assert.deepEqual((await found("narwhal")).notSearched, ["Library/Lib/huge"], "whatever was asked");
  assert.equal((await found("okapi", "&dir=Library/Other")).notSearched, undefined, "but only where the search looked");

  // A manifest ahead of one of its blobs — a sync still in flight: asked again, never answered short.
  const late = "# Late\n\nA dugong, eventually.\n";
  await macWrite((m) => {
    m.files["f-late00000001"] = { path: "Lib/late.md", rev: 1, hash: blobHash(late), size: late.length, mtime: Date.now(), by: ALICE.id };
  });
  assert.deepEqual((await api(searchUrl("dugong"))).json, { indexing: true, pending: 1 });
  const early = await api(docUrl("Library/Lib/late"));
  assert.equal(early.status, 503, "and a read of it says to try again, rather than answering empty");
  assert.ok(/has not finished syncing/.test(early.json.error));
  assert.equal((await call(`/api/blobs/f-late00000001/${blobHash(late)}`, { method: "PUT", token: OWNER, body: late })).status, 200);
  assert.deepEqual((await found("dugong")).results.map((r) => r.path), ["Library/Lib/late"]);

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
  const bindings = { OWNER_TOKEN: KEY, DATA: fake, DB: flaky };
  const down = await api(searchUrl("narwhal"), { bindings });
  assert.equal(down.status, 503);
  assert.ok(/database/.test(down.json.error));
  const during = await api(docUrl("Library/Lib/during"), { method: "PUT", body: "# During\n\nA manatee, written while search was down.\n", bindings });
  assert.equal(during.status, 201, "the write landed");
  assert.equal(textAt("Lib/during.md"), "# During\n\nA manatee, written while search was down.\n");
  assert.deepEqual((await found("manatee")).results.map((r) => r.path), ["Library/Lib/during"], "and the next search that can, catches up");
});

await test("search: a document is found by its name as well as its text — its own name, not its folders' or its extension — named ones first, and a name alone costs no read", async () => {
  await freshWorkspace({
    "Lib/otter.md": "# River\n\nNotes from the bank.\n",
    "Lib/sea-otter-facts.md": "# Facts\n\nThe otter holds hands.\n",
    "Lib/aaa.md": "# First\n\nAn otter swam by.\n",
    "Lib/Otter Poster.html": "<p>Come and see.</p>\n",
    "Lib/twin.md": "# Left\n\nMarkdown side.\n",
    "Lib/twin.html": "<p>Page side.</p>\n",
    "Otter/zoo.md": "# Animals\n\nNothing here.\n",
  });
  const bot = await addAgent("Namer", ["edit"]);
  const api = as(bot);
  const found = async (q, more = "") => (await api(searchUrl(q, more))).json;
  assert.equal((await api(searchUrl("warm the mirror"))).status, 200);

  const otter = await countingBlobReads(() => api(searchUrl("otter")));
  assert.deepEqual(otter.res.json.results, [
    { path: "Library/Lib/Otter Poster", version: "html", matches: [], inName: true },
    { path: "Library/Lib/otter", version: "md", matches: [], inName: true },
    { path: "Library/Lib/sea-otter-facts", version: "md", matches: [{ line: 3, text: "The otter holds hands." }], inName: true },
    { path: "Library/Lib/aaa", version: "md", matches: [{ line: 3, text: "An otter swam by." }] },
  ]);
  assert.equal(otter.res.json.total, 4, "a folder's name is not its documents'");
  assert.equal(otter.reads, 2, "only the documents whose lines are shown are read");
  assert.deepEqual((await found("OTTER")).results, otter.res.json.results, "whatever the case");
  const first = await found("otter", "&limit=1");
  assert.deepEqual([first.results.map((r) => r.path), first.total, first.truncated], [["Library/Lib/Otter Poster"], 4, true], "a name before a line, whatever the path order");
  assert.equal((await found("otter", "&dir=Library/Otter")).total, 0);
  assert.deepEqual((await found("zoo", "&dir=Library/Otter")).results, [{ path: "Library/Otter/zoo", version: "md", matches: [], inName: true }]);
  assert.deepEqual([(await found(".md")).total, (await found(".html")).total], [0, 0], "the extension is not part of the name");
  assert.deepEqual((await found("twin")).results, [{ path: "Library/Lib/twin", version: "md", matches: [], inName: true }], "the html beside a markdown is the same document");

  // A rename is found at once, under the new name: the name is the manifest's, never the mirror's.
  assert.equal((await api("/api/agent/move", { method: "POST", body: { from: "Library/Lib/otter", to: "Library/Lib/beaver" } })).status, 200);
  const beaver = await countingBlobReads(() => api(searchUrl("beaver")));
  assert.deepEqual([beaver.res.json.results, beaver.reads], [[{ path: "Library/Lib/beaver", version: "md", matches: [], inName: true }], 0]);
  assert.ok(!(await found("otter")).results.some((r) => r.path === "Library/Lib/beaver"));

  // Too large to mirror, but its name is still its name.
  await macWrite((m, put) => {
    put("Lib/leviathan-log.md", `# Log\n\n${"whale ".repeat(200_000)}\n`);
  });
  const big = await countingBlobReads(() => api(searchUrl("leviathan")));
  assert.deepEqual([big.res.json.results, big.res.json.notSearched], [[{ path: "Library/Lib/leviathan-log", version: "md", matches: [], inName: true }], undefined]);
  assert.equal(big.reads, 0);
  assert.deepEqual((await found("whale")).notSearched, ["Library/Lib/leviathan-log"], "what it says still is not searched");
});

/* ---------- Who an `a-` id is ---------- */

/* ---------- The document API: tags ---------- */

const TAGS = [
  { name: "status", values: ["Todo", "Doing", "Done"], desc: "Where a task stands." },
  { name: "priority", values: ["p1", "p2"] },
];
/** A Mac's write of the tag list. */
const macTags = (tags) =>
  macWrite((m) => {
    m.tags = tags;
  });
const treeUrl = (dir, more = "") => `/api/agent/tree?dir=${encodeURIComponent(dir)}${more}`;
const where = (...filters) => filters.map((f) => `&where=${encodeURIComponent(f)}`).join("");
const pathsIn = (listing) => listing.documents.map((d) => d.path);
/** A Mac's removal of a file: gone from the files, with its tombstone. */
const macRemove = (m, p) => {
  const [fid, f] = entryAt(m, p);
  delete m.files[fid];
  m.tombstones[fid] = { path: f.path, rev: f.rev + 1, ts: Date.now(), by: ALICE.id };
  return fid;
};

await test("tags: the index holds each note's pairs, filled and cleared with the search mirror; a listing carries each note's listed tags, and where narrows a listing or a search", async () => {
  await freshWorkspace({
    "Work/a.md": "---\nstatus: Doing\npriority: p1\nowner: Sam\n---\n# A\n\nAlpha text.\n",
    "Work/b.md": "---\nStatus: doing\n---\nBeta text.\n",
    "Work/c.md": "---\nstatus: Blocked\n---\nGamma.\n",
    "Work/d.md": "---\nstatus:\n  - Todo\nstatus: Done\n---\nDelta.\n",
    "Work/e.md": "No block here, and it says alpha.\n",
    "Work/page.html": "<p>An html page.</p>\n",
  });
  await macTags(TAGS);
  const bot = await addAgent("Tagger", ["read"]);
  const api = as(bot);

  assert.deepEqual((await api("/api/agent/tags")).json, { tags: TAGS }, "the manifest's list, with what each tag's values mean");

  // Narrowed: the index catches up first, as a search's does.
  const doing = await api(treeUrl("Library/Work", where("status:Doing")));
  assert.equal(doing.status, 200, doing.text);
  assert.deepEqual(doing.json.where, [{ name: "status", value: "Doing" }], "said back, as the list spells it");
  assert.deepEqual(doing.json.folders, []);
  assert.deepEqual(pathsIn(doing.json), ["Library/Work/a", "Library/Work/b"], "whatever the case of the name or the value");
  assert.deepEqual(doing.json.documents[0].tags, [
    { name: "status", value: "Doing", known: true },
    { name: "priority", value: "p1", known: true },
  ]);
  assert.deepEqual(doing.json.documents[1].tags, [{ name: "status", value: "Doing", known: true }], "the list's spelling");
  const [aFid] = entryAt(storedManifest(), "Work/a.md");
  assert.deepEqual(
    db.rows("SELECT name, value, folded FROM tags WHERE fid = ? ORDER BY name", aFid),
    [
      { name: "owner", value: "Sam", folded: "sam" },
      { name: "priority", value: "p1", folded: "p1" },
      { name: "status", value: "Doing", folded: "doing" },
    ],
    "every pair of the note, not only the listed tags'",
  );

  // Every listing carries them, from the index as it is.
  const all = (await api(treeUrl("Library/Work"))).json;
  assert.equal(all.tagsBehind, undefined, "the index is whole");
  assert.deepEqual(
    all.documents.map((d) => [d.path, d.tags ?? []]),
    [
      ["Library/Work/a", doing.json.documents[0].tags],
      ["Library/Work/b", [{ name: "status", value: "Doing", known: true }]],
      ["Library/Work/c", [{ name: "status", value: "Blocked", known: false }]],
      ["Library/Work/d", []],
      ["Library/Work/e", []],
      ["Library/Work/page", []],
    ],
    "a value the list doesn't have is still the note's; a tag's first line that isn't one value gives none",
  );
  assert.deepEqual(pathsIn((await api(treeUrl("Library/Work", where("status")))).json), ["Library/Work/a", "Library/Work/b", "Library/Work/c"], "a name alone: any value");
  assert.deepEqual(pathsIn((await api(treeUrl("Library/Work", where("STATUS:blocked")))).json), ["Library/Work/c"], "a value not in the list can be asked for");
  assert.deepEqual(pathsIn((await api(treeUrl("Library/Work", where("priority:p1", "status:doing")))).json), ["Library/Work/a"], "every filter at once");
  assert.deepEqual(pathsIn((await api(treeUrl("Library", "&deep=1" + where("status:Doing")))).json), ["Library/Work/a", "Library/Work/b"]);
  assert.deepEqual(pathsIn((await api(treeUrl("", "&deep=1" + where("status:Doing")))).json), ["Library/Work/a", "Library/Work/b"], "the workspace itself");
  const unknown = await api(treeUrl("Library/Work", where("owner:Sam")));
  assert.deepEqual([unknown.status, unknown.json.code], [400, "no_tag"], "a pair that isn't a listed tag is not one to narrow by");
  assert.match(unknown.json.error, /there is no tag called "owner" — the tags are status or priority/);
  assert.equal((await api(treeUrl("Library/Work", where("status:")))).status, 400);
  assert.equal((await api(treeUrl("Library/Work", where(...Array.from({ length: 9 }, () => "status"))))).status, 400, "eight at most");

  // Search: the same filters, beside the text or alone.
  const alpha = (await api(searchUrl("alpha", where("status:Doing")))).json;
  assert.deepEqual([alpha.where, alpha.results.map((r) => r.path)], [[{ name: "status", value: "Doing" }], ["Library/Work/a"]], "the text and the tag");
  const only = await countingBlobReads(() => api(`/api/agent/search?q=${where("status:doing")}`));
  assert.deepEqual(only.res.json.results, [
    { path: "Library/Work/a", version: "md", matches: [] },
    { path: "Library/Work/b", version: "md", matches: [] },
  ]);
  assert.equal(only.reads, 0, "a tag alone reads no note: the list is the manifest's");
  assert.deepEqual((await api(`/api/agent/search?q=${where("status:Done")}`)).json.results, []);
  assert.equal((await api(`/api/agent/search?q=`)).status, 400, "text, or a tag");

  // `info` reads the note's tags from its text.
  assert.deepEqual((await api(docUrl("Library/Work/c", "", "&info=1"))).json.tags, [{ name: "status", value: "Blocked", known: false }]);
  assert.equal((await api(docUrl("Library/Work/e", "", "&info=1"))).json.tags, undefined);

  // A Mac's change: a listing says the index is behind, and a narrowed one waits for it.
  await macWrite((m, put) => {
    put("Work/a.md", "---\nstatus: Done\n---\n# A\n\nAlpha text.\n");
  });
  const stale = (await api(treeUrl("Library/Work"))).json;
  assert.deepEqual([stale.tagsBehind, stale.documents[0].tags[0].value], [true, "Doing"], "what the index holds, said to be behind");
  assert.deepEqual(pathsIn((await api(treeUrl("Library/Work", where("status:Done")))).json), ["Library/Work/a"]);
  assert.deepEqual(db.rows("SELECT name FROM tags WHERE fid = ?", aFid), [{ name: "status" }], "what it held before went");

  // A note gone holds nothing; the tags of a note too large to mirror are not known.
  let bFid;
  await macWrite((m, put) => {
    bFid = macRemove(m, "Work/b.md");
    put("Work/huge.md", `---\nstatus: Doing\n---\n${"word ".repeat(220_000)}\n`);
  });
  const now = (await api(`/api/agent/search?q=${where("status:Doing")}`)).json;
  assert.deepEqual([now.results, now.notSearched], [[], ["Library/Work/huge"]], "said, rather than silently never found");
  assert.equal(db.value("SELECT COUNT(*) FROM tags WHERE fid = ?", bFid), 0);

  // No list: no tags, and nothing to narrow by.
  await macTags([]);
  assert.deepEqual((await api("/api/agent/tags")).json, { tags: [] });
  assert.equal((await api(treeUrl("Library/Work"))).json.documents[0].tags, undefined);
  const none = await api(treeUrl("Library/Work", where("status:Doing")));
  assert.equal(none.status, 400);
  assert.match(none.json.error, /this workspace has no tags yet — people make them in Doklin's Settings, and doklin tags add makes one/);
});

await test("tags: an agent's write keeps to the list where it changes a tag's line; tag sets and clears one through the app's own writer; a note called Tags is a note", async () => {
  const c = "---\nstatus: Blocked\nowner: Sam\n---\nGamma.\n";
  await freshWorkspace({ "Work/c.md": c, "Work/e.md": "No block.\r\n", "Work/page.html": "<p>Page.</p>\n" });
  await macTags(TAGS);
  const bot = await addAgent("Setter", ["edit"]);
  const api = as(bot);
  const write = (p, text, rev) => api(docUrl(p), { method: "PUT", body: text, headers: rev ? { "if-rev": String(rev) } : {} });
  const tag = (body) => api("/api/agent/tag", { method: "POST", body });

  const wrong = await write("Library/Work/new", "---\nstatus: Doinf\n---\nNew.\n");
  assert.deepEqual([wrong.status, wrong.json.code, wrong.json.tag, wrong.json.values], [400, "tag_value", "status", ["Todo", "Doing", "Done"]]);
  assert.equal(
    wrong.json.error,
    'status takes Todo, Doing or Done, not "Doinf" — use one of those, or add it first with doklin tags add status Doinf (ask your person if you aren\'t sure)',
  );
  assert.equal(entryAt(storedManifest(), "Work/new.md"), undefined, "nothing written");
  assert.equal((await api(docUrl("Library/Work/new", "", "&dry=1"), { method: "PUT", body: "---\nstatus: Doinf\n---\n" })).status, 400, "a dry run says the same");
  const many = await write("Library/Work/new", "---\nstatus: [Todo, Done]\n---\nNew.\n");
  assert.deepEqual([many.status, many.json.error], [400, 'status takes one value — write its line as "status: Todo", with Todo, Doing or Done']);
  assert.equal((await write("Library/Work/new", "---\nSTATUS: doing\nmood: anything\n---\nNew.\n")).status, 201, "a listed value in any case; a pair that isn't a tag is the note's own");

  // A line the write leaves as it was is never checked: a body edit passes over a value the list doesn't have.
  assert.equal((await write("Library/Work/c", c.replace("Gamma.", "Gamma, edited."), 1)).status, 200);
  const changed = await write("Library/Work/c", c.replace("Blocked", "Blocked again"), 2);
  assert.deepEqual([changed.status, changed.json.code], [400, "tag_value"], "but one it changes is");
  assert.equal((await write("Library/Work/c", c.replace("status: Blocked\n", ""), 2)).status, 200, "and removing one always passes");

  // tag: the app's writer, over what is stored now.
  const set = await tag({ path: "Library/Work/e", set: { STATUS: "done" } });
  assert.equal(set.status, 200, set.text);
  assert.deepEqual(set.json, { path: "Library/Work/e", version: "md", rev: 2, tags: [{ name: "status", value: "Done", known: true }] });
  assert.equal(textAt("Work/e.md"), "---\r\nstatus: Done\r\n---\r\nNo block.\r\n", "a block of the note's own line endings, spelled as the list spells it");
  assert.deepEqual(pathsIn((await api(treeUrl("Library/Work", where("status:Done")))).json), ["Library/Work/e"], "found at once");
  assert.equal((await tag({ path: "Library/Work/e", set: { status: null } })).status, 200);
  assert.equal(textAt("Work/e.md"), "No block.\r\n", "a set and a clear give back the bytes");
  assert.equal((await tag({ path: "Library/Work/e", set: { priority: "p1", status: "Doing" } })).status, 200);
  assert.equal(textAt("Work/e.md"), "---\r\nstatus: Doing\r\npriority: p1\r\n---\r\nNo block.\r\n", "new lines in the list's order, whatever the request's");
  assert.equal((await tag({ path: "Library/Work/e", set: { status: null, priority: null } })).status, 200);
  const two = await tag({ path: "Library/Work/new", set: { priority: "P2", status: "todo" } });
  assert.deepEqual(two.json.tags, [
    { name: "status", value: "Todo", known: true },
    { name: "priority", value: "p2", known: true },
  ]);
  assert.equal(textAt("Work/new.md"), "---\nstatus: Todo\nmood: anything\npriority: p2\n---\nNew.\n", "a line in its place, a new one at the end of the block");
  const again = await tag({ path: "Library/Work/new", set: { status: "Todo" } });
  assert.deepEqual([again.json.unchanged, again.json.rev], [true, 2], "the same value writes nothing");
  const dry = await tag({ path: "Library/Work/new", set: { status: "Done" }, dryRun: true });
  assert.deepEqual([dry.json.written, dry.json.tags[0].value], [false, "Done"]);
  assert.match(textAt("Work/new.md"), /status: Todo/);

  const refused = async (body, status, pattern) => {
    const res = await tag(body);
    assert.equal(res.status, status, res.text);
    assert.match(res.json.error, pattern);
  };
  await refused({ path: "Library/Work/new", set: { stage: "Done" } }, 400, /there is no tag called "stage"/);
  await refused({ path: "Library/Work/new", set: { status: "Shipped" } }, 400, /status takes Todo, Doing or Done, not "Shipped"/);
  await refused({ path: "Library/Work/new", set: {} }, 400, /set is/);
  await refused({ path: "Library/Work/new", set: { status: 3 } }, 400, /set is/);
  await refused({ path: "Library/Work/page", set: { status: "Done" } }, 400, /only an html version/);
  await refused({ path: "Library/Work/nothing", set: { status: "Done" } }, 404, /there is no document/);
  const reader = await addAgent("Reader", ["read"]);
  assert.equal((await as(reader)("/api/agent/tag", { method: "POST", body: { path: "Library/Work/new", set: { status: "Done" } } })).status, 403);

  const spaced = await write("Library/Work/new", "---\nstatus: In review\n---\nNew.\n", 2);
  assert.match(spaced.json.error, /add it first with doklin tags add status "In review"/, "a value a shell would split is quoted");

  // A note called Tags is a note like any other: its lines are its own, and it takes tags.
  assert.equal((await write("Library/Tags", "---\nanything: at all\nother: [Todo, Doing]\n---\n")).status, 201);
  assert.equal((await tag({ path: "Library/Tags", set: { status: "Done" } })).status, 200);
  assert.deepEqual(storedManifest().tags, TAGS, "and the list is the manifest's, whatever it says");
});

await test("tags: the list is the shared workspace's manifest's — a PUT holds it to the app's rules, a space's has none, and every write keeps it", async () => {
  await freshWorkspace({ "Work/a.md": "---\nstatus: Doing\n---\nA.\n" });
  await macTags(TAGS);
  const now = () => JSON.parse(fake.store.get("manifest.json").bytes.toString("utf8"));
  const put = async (tags) => putManifest({ ...now(), seq: now().seq + 1, tags });
  const refused = async (tags, pattern) => {
    const res = await put(tags);
    assert.equal(res.status, 400, `${JSON.stringify(tags)}: ${res.text}`);
    assert.match(res.json.error, pattern);
  };
  await refused({ status: ["Todo"] }, /tags must be a list/);
  await refused([{ name: "status" }], /invalid values for tag status/);
  await refused([{ name: "status", values: ["Todo", 3] }], /invalid values for tag status/);
  await refused([{ name: "status", values: ["Todo"], desc: 3 }], /invalid desc for tag status/);
  await refused([{ values: ["Todo"] }], /invalid tag/);
  await refused([TAGS[0], { name: "Status", values: ["x"] }], /^invalid tags: Status: There's already a tag called status\.$/);
  await refused([{ name: "a:b", values: ["x"] }], /^invalid tags: a:b: A tag's name holds letters/);
  await refused([{ name: "status", values: [] }], /A tag needs at least one value/);
  await refused([{ name: "status", values: ["Done", "done"] }], /Done is there twice/);
  await refused([{ name: "status", values: ["x"], desc: "x".repeat(1001) }], /can be 1000 characters at most/);
  await refused(Array.from({ length: 51 }, (_, i) => ({ name: `t${i}`, values: ["a"] })), /^invalid tags: A workspace can have 50 tags at most\.$/);
  assert.equal((await put(Array.from({ length: 50 }, (_, i) => ({ name: `t${i}`, values: ["a"] })))).status, 200, "fifty is the most");
  assert.equal((await put(TAGS)).status, 200);
  assert.equal((await put(undefined)).status, 200, "no list is none");
  assert.equal(now().tags, undefined);
  await macTags(TAGS);

  // A space's manifest holds none.
  const own = (await call("/api/spaces/private", { method: "PUT", token: OWNER })).json.space;
  const stored = () => fake.store.get(`spaces/${own.id}/manifest.json`);
  const spacePut = (tags) => {
    const m = JSON.parse(stored().bytes.toString("utf8"));
    return call(`/api/spaces/${own.id}/manifest`, {
      method: "PUT",
      token: OWNER,
      headers: { "x-base-etag": stored().etag },
      body: { ...m, seq: m.seq + 1, tags },
    });
  };
  const inSpace = await spacePut(TAGS);
  assert.deepEqual([inSpace.status, inSpace.json.error], [400, "The tags are the workspace's, kept with Library."]);
  assert.equal((await spacePut([])).status, 200, "an empty list says nothing");

  // The worker's own writes keep it.
  const bot = await addAgent("Keeper", ["edit"]);
  assert.equal((await as(bot)(docUrl("Library/Work/b"), { method: "PUT", body: "# B\n" })).status, 201);
  assert.deepEqual(now().tags, TAGS);
});

await test("tags: an agent adds a tag, or values at the end of one, with tags add — what the list has already, in any case, is left as it is; it never renames or removes", async () => {
  await freshWorkspace({ "Work/a.md": "A.\n" });
  await macTags(TAGS);
  const bot = await addAgent("Adder", ["edit"]);
  const add = (body) => as(bot)("/api/agent/tags", { method: "POST", body });

  const more = await add({ name: "STATUS", values: ["Blocked", "todo", " Shipped "] });
  assert.equal(more.status, 200, more.text);
  assert.deepEqual(more.json, { tag: { ...TAGS[0], values: ["Todo", "Doing", "Done", "Blocked", "Shipped"] }, added: ["Blocked", "Shipped"] });
  assert.deepEqual(storedManifest().tags, [more.json.tag, TAGS[1]], "in its place, spelled as the list spells it, what its values mean kept");
  const etag = etagNow();
  assert.deepEqual((await add({ name: "status", values: ["blocked"] })).json.unchanged, true);
  assert.equal(etagNow(), etag, "nothing new, nothing written");

  const made = await add({ name: "area", values: ["Web", "web", "iPhone"] });
  assert.deepEqual(made.json, { tag: { name: "area", values: ["Web", "iPhone"] }, added: ["Web", "iPhone"], created: true });
  assert.deepEqual(storedManifest().tags.map((d) => d.name), ["status", "priority", "area"], "a new tag at the end");
  const dry = await add({ name: "owner", values: ["Sam"], dryRun: true });
  assert.deepEqual([dry.json.created, dry.json.written], [true, false]);
  assert.equal(storedManifest().tags.length, 3);

  // A tagged write takes a value added a moment ago.
  assert.equal((await as(bot)("/api/agent/tag", { method: "POST", body: { path: "Library/Work/a", set: { status: "shipped" } } })).json.tags[0].value, "Shipped");

  const refused = async (body, status, pattern) => {
    const res = await add(body);
    assert.equal(res.status, status, res.text);
    assert.match(res.json.error, pattern);
  };
  await refused({ name: "a:b", values: ["x"] }, 400, /A tag's name holds letters/);
  await refused({ name: "area", values: [] }, 400, /name is the tag, and values what to add/);
  await refused({ name: "area", values: ["x".repeat(61)] }, 400, /A value can be 60 characters at most/);
  await refused({ name: "area", values: "Web" }, 400, /name is the tag/);
  const reader = await addAgent("Looker", ["read"]);
  assert.equal((await as(reader)("/api/agent/tags", { method: "POST", body: { name: "area", values: ["x"] } })).status, 403);
  await macTags(Array.from({ length: 50 }, (_, i) => ({ name: `t${i}`, values: ["a"] })));
  await refused({ name: "one more", values: ["a"] }, 400, /this workspace has 50 tags, the most it can have/);
  assert.equal((await add({ name: "t0", values: ["b"] })).status, 200, "a full list still takes a value");
});

await test("directory: /api/meta names agents beside people, so every Mac can put a name to what an agent changed", async () => {
  await freshWorkspace({ "Dir/note.md": "# Note\n\nSome plain words.\n" });
  const bot = await addAgent("Grok bot", ["comment", "edit", "publish"]);
  const api = as(bot);
  assert.equal((await api(docUrl("Library/Dir/by-bot"), { method: "PUT", body: "# By the bot\n" })).status, 201);
  assert.equal((await api(docUrl("Library/Dir/note"), { method: "PUT", body: "# Note\n\nSome plain words, edited.\n", headers: { "if-rev": "1" } })).status, 200);
  assert.equal((await api("/api/agent/comments", { method: "POST", body: { path: "Library/Dir/note", on: "plain words", body: "Mine." } })).status, 201);
  assert.equal((await api("/api/agent/pages", { method: "PUT", body: { path: "Library/Dir/note", slug: "dir-note" } })).status, 201);
  assert.equal((await api(docUrl("Library/Dir/by-bot"), { method: "DELETE" })).status, 200);

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
  const agentRows = asMember.people.filter((p) => p.id.startsWith("a-"));
  assert.deepEqual([...new Set(agentRows.map((p) => Object.keys(p).sort().join(",")))], ["id,name,person"], "a name and whose it is, and nothing about what it may do");
  const ownerId = (await call("/api/meta", { token: OWNER })).json.you.memberId;
  assert.equal(asMember.people.find((p) => p.id === bot.id).person, ownerId, "whose agent it is, told to everyone");
  assert.ok(agentRows.every((p) => asMember.people.some((q) => q.id === p.person)), "and that person is in the list");
  const firstAgent = asMember.people.findIndex((p) => p.id.startsWith("a-"));
  assert.ok(firstAgent > 0 && asMember.people.slice(0, firstAgent).every((p) => /^m-/.test(p.id)), "people first");
  assert.ok(asMember.people.slice(firstAgent).every((p) => /^a-[a-f0-9]{8}$/.test(p.id)), "then agents");
  assert.deepEqual((await call("/api/meta", { token: OWNER })).json.people, asMember.people, "the same list, whoever asks");
  assert.equal((await api(docUrl("Library/Dir/note", "", "&info=1"))).json.md.byName, "Grok bot", "and the document API says it back by name");

  // A rename shows everywhere at once, because nothing stored the name…
  await call(`/api/auth/agents/${bot.id}`, { method: "POST", token: OWNER, body: { name: "Grok, renamed" } });
  assert.equal((await call("/api/meta", { token: MEMBER })).json.people.find((p) => p.id === bot.id).name, "Grok, renamed");
  assert.equal((await api("/api/agent/pages")).json.pages[0].byName, "Grok, renamed");
  // …except a comment, which is signed the way a person's is: with the name it was said under.
  assert.equal((await api(commentsUrl("Library/Dir/note"))).json.threads[0].comments[0].author, "Grok bot");

  // Removed, it is nobody: what it wrote keeps the id, legible and never wrong.
  await call(`/api/auth/agents/${bot.id}`, { method: "DELETE", token: OWNER });
  assert.ok(!(await call("/api/meta", { token: MEMBER })).json.people.some((p) => p.id === bot.id));
  assert.equal(entryAt(storedManifest(), "Dir/note.md")[1].by, bot.id);
  const reader = await addAgent("Reader", []);
  const info = (await as(reader)(docUrl("Library/Dir/note", "", "&info=1"))).json;
  assert.deepEqual([info.md.by, info.md.byName], [bot.id, undefined]);
});

// Destroys all state — keep this last.
await test("addresses: an address is one space's for the whole domain — the second claim is told it is taken — and a page is served from whichever space holds it", async () => {
  await freshWorkspace({ "Open/note.md": "# An open note\n", "Open/other.md": "# Another\n" });
  await macWrite((m) => {
    m.public = { open: { kind: "file", file: entryAt(m, "Open/note.md")[0], path: "Open/note.md", by: ALICE.id, at: 1 } };
  });
  assert.deepEqual(
    db.rows("SELECT slug, space_id FROM addresses ORDER BY slug"),
    [{ slug: "open", space_id: "" }],
    "the shared workspace's own are claimed as its manifest is stored, and the ones it dropped let go",
  );

  // Alice publishes a note from a folder only she is in.
  const books = (await share(MEMBER, { name: "Books" })).json.space;
  const sp = spaceCall(books.id);
  const text = "# The budget\n\nNumbers nobody else can open.\n";
  const hash = blobHash(text);
  await sp(`/blobs/f-budget02/${hash}`, { method: "PUT", token: MEMBER, body: text, headers: { "content-type": "text/markdown" } });
  const withPages = (seq, pages) => ({
    version: MANIFEST_VERSION,
    name: "Books",
    seq,
    files: { "f-budget02": { path: "Budget.md", rev: 1, hash, size: Buffer.byteLength(text), mtime: 1700000000000, by: ALICE.id } },
    tombstones: {},
    public: pages,
  });
  const page = { kind: "file", file: "f-budget02", path: "Budget.md", by: ALICE.id, at: 2 };
  const store = (etag, body) => sp("/manifest", { method: "PUT", token: MEMBER, headers: { "x-base-etag": etag }, body });
  const put1 = await store(books.etag, withPages(1, { budget: page }));
  assert.equal(put1.status, 200, put1.text);
  assert.equal(db.value("SELECT space_id FROM addresses WHERE slug = 'budget'"), books.id);

  const served = await pub("/budget");
  assert.equal(served.status, 200);
  assert.ok(served.text.includes("<h1>The budget</h1>") && served.text.includes("Numbers nobody else can open."), "rendered from the folder's own blobs");
  assert.equal((await pub("/open")).status, 200, "beside the shared workspace's own pages");
  assert.equal((await sp("/manifest", { token: OWNER })).status, 404, "publishing opens the page, never the folder");

  // The shared workspace cannot take an address a space holds — a Mac's write, or an agent's.
  const sharedEtag = await currentEtag();
  const cur = JSON.parse((await call("/api/manifest", { token: OWNER })).text);
  const clash = await putManifest({ ...cur, seq: cur.seq + 1, public: { ...cur.public, budget: { kind: "dir", path: "", by: "m-1a2b3c4d", at: 1757000000000 } } });
  assert.equal(clash.status, 409);
  assert.deepEqual(clash.json.taken, ["budget"]);
  assert.ok(/already taken/.test(clash.json.error));
  const bot = await addAgent("Claimer", ["edit", "publish"]);
  const byAgent = await as(bot)("/api/agent/pages", { method: "PUT", body: { path: "Library/Open/other", slug: "budget" } });
  assert.equal(byAgent.status, 409, byAgent.text);
  assert.deepEqual(byAgent.json.taken, ["budget"]);
  assert.equal(await currentEtag(), sharedEtag, "and nothing was stored either time");
  const free = await as(bot)("/api/agent/pages", { method: "PUT", body: { path: "Library/Open/other", slug: "other-page" } });
  assert.equal(free.status, 201, free.text);
  assert.equal(db.value("SELECT space_id FROM addresses WHERE slug = 'other-page'"), "", "an agent's claim is the shared workspace's");
  assert.equal((await as(bot)("/api/agent/pages?slug=other-page", { method: "DELETE" })).status, 200);
  assert.equal(db.value("SELECT COUNT(*) FROM addresses WHERE slug = 'other-page'"), 0, "…and is let go with the page");

  // A space cannot take one the shared workspace serves, or one another space holds.
  const refused = await store(put1.json.etag, withPages(2, { budget: page, open: page }));
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.json.taken, ["open"]);
  const jo = { token: JO.token, device: "d-jo" };
  const joPrivate = (await call("/api/spaces/private", { method: "PUT", ...jo })).json.space;
  const second = await call(`/api/spaces/${joPrivate.id}/manifest`, {
    method: "PUT",
    ...jo,
    headers: { "x-base-etag": joPrivate.etag },
    body: { version: MANIFEST_VERSION, name: "My files", seq: 1, files: {}, tombstones: {}, public: { budget: { kind: "dir", path: "", by: "m-1a2b3c4d", at: 1757000000000 } } },
  });
  assert.equal(second.status, 409, "the second claim is told it is taken");
  assert.deepEqual(second.json.taken, ["budget"]);
  // Even one the shared workspace published while the database could not hear it.
  db.run("DELETE FROM addresses WHERE slug = 'open'");
  assert.deepEqual((await store(put1.json.etag, withPages(2, { budget: page, open: page }))).json.taken, ["open"]);
  assert.equal(db.value("SELECT COUNT(*) FROM addresses WHERE slug = 'open'"), 0, "and no claim was written for it");

  // A space's page is cached under that space's own manifest, and Library's:
  // its links lead into both.
  const cache = new FakeCache();
  globalThis.caches = { default: cache };
  try {
    await pub("/budget");
    assert.deepEqual(cache.puts, [`https://cache.doklin/${webTag}/${put1.json.etag}@${books.id}+${etagNow()}/budget`]);
    await pub("/budget");
    assert.equal(cache.hits, 1);
  } finally {
    delete globalThis.caches;
  }

  // An owner sees every address on the domain — what the internet is told of each page, and nothing
  // of the section it is in — and can take any of them down.
  const joPage = await call(`/api/spaces/${joPrivate.id}/manifest`, {
    method: "PUT",
    ...jo,
    headers: { "x-base-etag": joPrivate.etag },
    body: {
      version: MANIFEST_VERSION,
      name: "My files",
      seq: 1,
      files: {},
      tombstones: {},
      public: { "jo-notes": { kind: "dir", path: "", by: JO.member.id, at: 3 } },
    },
  });
  assert.equal(joPage.status, 200, joPage.text);
  assert.equal((await pub("/jo-notes")).status, 200);
  assert.equal((await call("/api/pages", { token: MEMBER })).status, 403, "a member is not told");
  assert.equal((await call("/api/pages/jo-notes", { method: "DELETE", token: MEMBER })).status, 403);
  const every = (await call("/api/pages", { token: OWNER })).json;
  assert.deepEqual(
    every.pages.map((p) => [p.slug, p.kind, p.title, p.by, p.shared]),
    [
      ["budget", "file", "Budget", ALICE.name, false],
      ["jo-notes", "dir", "My files", JO.member.name, false],
      ["open", "file", "note", ALICE.name, true],
    ],
    "the shared workspace's own pages come from its map, which is the truth even where the registry is not",
  );
  assert.equal(every.truncated, false);
  const told = JSON.stringify(every);
  assert.ok(!told.includes(books.id) && !told.includes(joPrivate.id) && !told.includes("Budget.md"), "not which section, not the file's path");
  assert.equal((await call("/api/pages", { method: "POST", token: OWNER })).status, 405);
  assert.equal((await call("/api/pages/No%20Such", { method: "DELETE", token: OWNER })).status, 400);

  assert.equal((await call("/api/pages/jo-notes", { method: "DELETE", token: OWNER })).status, 204, "a page whose file the owner cannot open");
  assert.equal((await pub("/jo-notes")).status, 404);
  assert.equal(db.value("SELECT COUNT(*) FROM addresses WHERE slug = 'jo-notes'"), 0, "and the address is free");
  const joNow = await call(`/api/spaces/${joPrivate.id}/manifest`, { ...jo });
  assert.deepEqual(JSON.parse(joNow.text).public, {}, "her own Mac hears of it as any other change to her Private");
  assert.notEqual(joNow.headers.get("x-manifest-etag"), joPage.json.etag);
  assert.equal((await call("/api/pages/jo-notes", { method: "DELETE", token: OWNER })).status, 404, "nothing is published there now");
  // One of the shared workspace's own, the same way.
  const extra = await as(bot)("/api/agent/pages", { method: "PUT", body: { path: "Library/Open/other", slug: "other-page" } });
  assert.equal(extra.status, 201, extra.text);
  assert.equal((await call("/api/pages/other-page", { method: "DELETE", token: OWNER })).status, 204);
  assert.equal((await pub("/other-page")).status, 404);
  assert.equal(db.value("SELECT COUNT(*) FROM addresses WHERE slug = 'other-page'"), 0);
  // A claim left behind by a manifest that was never stored is let go when it is met.
  db.run(`INSERT INTO addresses (slug, space_id) VALUES ('ghost-page', '${books.id}')`);
  assert.equal((await call("/api/pages/ghost-page", { method: "DELETE", token: OWNER })).status, 404);
  assert.equal(db.value("SELECT COUNT(*) FROM addresses WHERE slug = 'ghost-page'"), 0);

  // Unpublished, the address is free again — and the shared workspace may have it.
  const put2 = await store(put1.json.etag, withPages(2, {}));
  assert.equal(put2.status, 200);
  assert.equal(db.value("SELECT COUNT(*) FROM addresses WHERE slug = 'budget'"), 0);
  assert.equal((await pub("/budget")).status, 404);
  const now = JSON.parse((await call("/api/manifest", { token: OWNER })).text);
  const taken = await putManifest({ ...now, seq: now.seq + 1, public: { ...now.public, budget: { kind: "dir", path: "", by: "m-1a2b3c4d", at: 1757000000000 } } });
  assert.equal(taken.status, 200, taken.text);
  assert.deepEqual(
    db.rows("SELECT slug FROM addresses WHERE space_id = '' ORDER BY slug").map((r) => r.slug),
    ["budget", "open"],
    "with the one the database had not heard of claimed at last",
  );

  // A share that is deleted stops answering at its addresses, and keeps them for the day it is restored.
  const put3 = await store(put2.json.etag, withPages(3, { ledger: page }));
  assert.equal(put3.status, 200);
  assert.equal((await pub("/ledger")).status, 200);
  assert.equal((await sp("", { method: "DELETE", token: MEMBER })).json.kept, true);
  assert.equal(db.value("SELECT COUNT(*) FROM addresses WHERE slug = 'ledger'"), 1);
  assert.equal((await pub("/ledger")).status, 404);

  // When the registry cannot answer the shared workspace still syncs: its addresses go unclaimed, and are served all the same.
  const latest = JSON.parse((await call("/api/manifest", { token: OWNER })).text);
  const unheard = await call("/api/manifest", {
    method: "PUT",
    token: OWNER,
    bindings: { OWNER_TOKEN: KEY, DATA: fake, DB: failingPast(/addresses/) },
    headers: { "x-base-etag": await currentEtag() },
    body: { ...latest, seq: latest.seq + 1, public: { ...latest.public, quiet: { kind: "dir", path: "", by: "m-1a2b3c4d", at: 1757000000000 } } },
  });
  assert.equal(unheard.status, 200, unheard.text);
  assert.equal(db.value("SELECT COUNT(*) FROM addresses WHERE slug = 'quiet'"), 0);
  assert.equal((await pub("/quiet")).status, 200);
});

/* ---------- The document API: sections ---------- */

// Pat and Quinn, their agents, and two folders both called Deals.
let PAT;
let QUINN;
let PAT_BOT;
let QUINN_BOT;
let ALICE_BOT;
let DEALS;
let DEALS_QUINN;
/** Add an agent as a person does for themselves, and log one machine in. */
async function addAgentFor(token, name, scopes) {
  const body = nextCodeBody();
  const made = await call("/api/auth/agents", {
    method: "POST",
    token,
    body: { name, scopes, codeHash: sha256(body), expiresAt: Date.now() + HOUR },
  });
  assert.equal(made.status, 201, made.text);
  const login = await loginWith(agentCode(body), "test-runner");
  assert.equal(login.status, 201, login.text);
  return { id: made.json.agent.id, name, token: login.json.token, scopes: login.json.scopes };
}
/** A space's manifest, and a file's text in it, read from the bucket itself. */
const spaceManifest = (id) => JSON.parse(fake.store.get(`spaces/${id}/manifest.json`).bytes.toString("utf8"));
const spaceText = (id, p) => {
  const hit = entryAt(spaceManifest(id), p);
  return hit ? fake.store.get(`spaces/${id}/blobs/${hit[0]}/${hit[1].hash}`)?.bytes.toString("utf8") : undefined;
};
const privateOf = (person) => `p-${person.member.id.slice(2)}`;
/**
 * Share what is at `path` in a person's My files, the way a Mac does: the
 * share is made where its item is, and the item's files leave the section
 * it sits in for the share's own, keeping their ids. A document is named
 * without its extension.
 */
async function shareFromMine(person, device, { path: at, kind = "folder", members = [] }) {
  const who = { token: person.token, device };
  const mine = privateOf(person);
  const name = at.slice(at.lastIndexOf("/") + 1);
  const dir = at.includes("/") ? at.slice(0, at.lastIndexOf("/")) : "";
  const made = await call("/api/spaces", { method: "POST", ...who, body: { id: shareId(), kind, name, members, parent: mine, dir, was: at } });
  assert.equal(made.status, 201, made.text);
  const space = made.json.space;
  const got = await call(`/api/spaces/${mine}/manifest`, who);
  const parent = got.json;
  assert.deepEqual(parent.mounts[space.id], { dir, rev: 1, by: person.member.id, was: at }, "where it sits is in its section's manifest from the moment it is shared");
  const prefix = kind === "folder" ? `${at}/` : `${at}.`;
  const files = {};
  parent.tombstones ??= {};
  for (const [fid, f] of Object.entries(parent.files)) {
    if (!f.path.toLowerCase().startsWith(prefix.toLowerCase())) continue;
    const bytes = fake.store.get(`spaces/${mine}/blobs/${fid}/${f.hash}`).bytes;
    assert.equal((await call(`/api/spaces/${space.id}/blobs/${fid}/${f.hash}`, { method: "PUT", ...who, body: bytes })).status, 200);
    files[fid] = { ...f, path: kind === "folder" ? f.path.slice(prefix.length) : f.path.slice(dir === "" ? 0 : dir.length + 1) };
    delete parent.files[fid];
    parent.tombstones[fid] = { path: f.path, rev: f.rev + 1, ts: Date.now(), by: person.member.id, to: space.id };
  }
  const filled = await call(`/api/spaces/${space.id}/manifest`, {
    method: "PUT",
    ...who,
    headers: { "x-base-etag": space.etag },
    body: { version: MANIFEST_VERSION, name, seq: 1, files, tombstones: {}, public: {} },
  });
  assert.equal(filled.status, 200, filled.text);
  parent.seq += 1;
  const placed = await call(`/api/spaces/${mine}/manifest`, { method: "PUT", ...who, headers: { "x-base-etag": got.headers.get("x-manifest-etag") }, body: parent });
  assert.equal(placed.status, 200, placed.text);
  return space;
}
const put = (api, p, text, more = "") => api(docUrl(p, "", more), { method: "PUT", body: text });

await test("sections: an agent sees what its person sees — a path under Library/, My files/ or Shared with me/ is in the section that holds it, by the names on their disk", async () => {
  await freshWorkspace({ "Shared/plan.md": "# Plan\n\nThe harbour plan.\n" });
  PAT = await joinAs("pat@example.com", "Pat", "PPPPPPPPPPPPPPPPPPPP", "d-pat");
  QUINN = await joinAs("quinn@example.com", "Quinn", "QQQQQQQQQQQQQQQQQQQQ", "d-quinn");
  PAT_BOT = await addAgentFor(PAT.token, "Pat's bot", ["comment", "edit", "publish"]);
  QUINN_BOT = await addAgentFor(QUINN.token, "Quinn's bot", ["comment", "edit", "publish"]);
  ALICE_BOT = await addAgentFor(MEMBER, "Alice's helper", ["comment", "edit", "publish"]);
  const [pat, quinn, alice] = [as(PAT_BOT), as(QUINN_BOT), as(ALICE_BOT)];

  // Who it is, and where it can work: nothing is shared with Pat yet.
  const me = (await pat("/api/agent/me")).json;
  assert.deepEqual(me.person, { id: PAT.member.id, name: "Pat" });
  assert.deepEqual(me.sections, ["Library", "My files"]);
  assert.ok(fake.store.has(`spaces/${privateOf(PAT)}/manifest.json`), "asking made Pat's My files: everyone has one");

  // Two folders of one name: Pat's, shared with Quinn, and Quinn's, shared with Pat.
  DEALS = (await share(PAT.token, { name: "Deals", members: [QUINN.member.id] })).json.space;
  DEALS_QUINN = (await share(QUINN.token, { name: "Deals", members: [PAT.member.id] })).json.space;
  assert.deepEqual((await pat("/api/agent/me")).json.sections, ["Library", "My files", "Shared with me"]);

  // A path is literal. Under My files/ it is Pat's own and nowhere else.
  const sharedEtag = etagNow();
  const wrote = await put(pat, "My files/notes/idea", "# Idea\n\nA quiet cove nobody knows.\n");
  assert.equal(wrote.status, 201, wrote.text);
  assert.equal(wrote.json.path, "My files/notes/idea", "said back the way it was typed");
  assert.deepEqual(pathsOf(spaceManifest(privateOf(PAT))), ["notes/idea.md"], "stored relative to its own section");
  assert.equal(entryAt(spaceManifest(privateOf(PAT)), "notes/idea.md")[1].by, PAT_BOT.id, "signed with the agent's own name");
  assert.equal(etagNow(), sharedEtag, "Library heard nothing of it");
  assert.equal(db.value("SELECT etag FROM spaces WHERE id = ?", privateOf(PAT)), fake.store.get(`spaces/${privateOf(PAT)}/manifest.json`).etag, "and Pat's Macs are told by their next poll");
  const read = await pat(docUrl("my files/NOTES/idea"));
  assert.equal(read.status, 200);
  assert.equal(read.text, "# Idea\n\nA quiet cove nobody knows.\n");
  assert.equal(decodeURIComponent(read.headers.get("x-doklin-path")), "My files/notes/idea", "whatever case it was asked in");
  assert.equal((await pat(docUrl("My files/notes/idea", "", "&info=1"))).json.path, "My files/notes/idea");

  // What Pat shared is where it was, in his My files; what is shared with him is under Shared with me.
  assert.equal((await put(pat, "My files/Deals/q3", "# Q3\n\nThe first deal.\n")).status, 201);
  assert.equal((await put(pat, "Shared with me/Deals/q4", "# Q4\n\nQuinn's deal.\n")).status, 201);
  assert.deepEqual(pathsOf(spaceManifest(DEALS.id)), ["q3.md"], "in the share's own section");
  assert.deepEqual(pathsOf(spaceManifest(DEALS_QUINN.id)), ["q4.md"]);
  assert.deepEqual(pathsOf(spaceManifest(privateOf(PAT))), ["notes/idea.md"], "not in the My files it sits in");
  assert.deepEqual(pathsOf(storedManifest()), ["Shared/plan.md"], "and neither in Library");
  // For Quinn the same two folders, from where she stands.
  assert.equal((await quinn(docUrl("Shared with me/Deals/q3"))).text, "# Q3\n\nThe first deal.\n");
  assert.equal((await quinn(docUrl("My files/Deals/q4"))).text, "# Q4\n\nQuinn's deal.\n");

  // Listing: the workspace itself is the three folders, and nothing else;
  // each is listed like any other folder; --deep is everything this person
  // can see, Library included.
  const ls = async (api, dir = "", deep = false) => (await api(`/api/agent/tree?dir=${encodeURIComponent(dir)}${deep ? "&deep=1" : ""}`));
  assert.deepEqual((await ls(pat)).json, { dir: "", folders: ["Library", "My files", "Shared with me"], documents: [] });
  assert.deepEqual((await ls(pat, "Library")).json, { dir: "Library", folders: ["Library/Shared"], documents: [] });
  assert.deepEqual((await ls(pat, "Shared with me")).json, { dir: "Shared with me", folders: ["Shared with me/Deals"], documents: [] });
  assert.deepEqual((await ls(pat, "My files")).json.folders, ["My files/Deals", "My files/notes"], "a shared folder is a folder where it sits");
  assert.deepEqual((await ls(pat, "My files/notes")).json.documents.map((d) => d.path), ["My files/notes/idea"]);
  assert.deepEqual((await ls(pat, "my files/deals")).json.documents.map((d) => d.path), ["My files/Deals/q3"]);
  assert.deepEqual((await ls(pat, "shared with me/DEALS")).json.documents.map((d) => d.path), ["Shared with me/Deals/q4"]);
  const everything = (await ls(pat, "", true)).json;
  assert.deepEqual(everything.documents.map((d) => d.path), ["Library/Shared/plan", "My files/Deals/q3", "My files/notes/idea", "Shared with me/Deals/q4"]);
  assert.deepEqual(everything.folders, ["Library", "Library/Shared", "My files", "My files/Deals", "My files/notes", "Shared with me", "Shared with me/Deals"]);
  assert.deepEqual((await ls(pat, "Shared with me", true)).json.documents.map((d) => d.path), ["Shared with me/Deals/q4"]);
  assert.deepEqual((await ls(pat, "My files", true)).json.documents.map((d) => d.path), ["My files/Deals/q3", "My files/notes/idea"], "a folder, deep, is what is shared from inside it too");
  // A section is there with nothing in it; a folder nobody made is not.
  const empty = await ls(alice, "My files");
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json, { dir: "My files", folders: [], documents: [] });
  assert.equal((await ls(pat, "My files/nothing")).status, 404);
  assert.deepEqual((await ls(alice)).json.folders, ["Library", "My files"], "nothing is shared with Alice, so she is shown no folder of it");
  assert.deepEqual((await ls(alice, "Shared with me")).json, { dir: "Shared with me", folders: [], documents: [] });

  // To an agent whose person cannot open it, a share is nothing — and a My
  // files is only ever its own person's.
  for (const api of [alice, as(await addAgent("The owner's bot", ["edit"]))]) {
    const gone = await api(docUrl("Shared with me/Deals/q3"));
    assert.equal(gone.status, 404);
    assert.match(gone.json.error, /nothing called "Deals" is shared with this agent's person/);
    assert.equal((await api(docUrl("My files/notes/idea"))).status, 404, "its own My files holds no such note");
    assert.equal((await api(docUrl("My files/Deals/q3"))).status, 404, "nor Pat's folder");
    assert.equal((await put(api, "Shared with me/Deals/intruder", "# No\n")).status, 404);
  }
  assert.deepEqual(pathsOf(spaceManifest(DEALS.id)), ["q3.md"]);

  // Taken off a share, put on one: the agent follows on its next call.
  const membership = (method) =>
    call(`/api/spaces/${DEALS.id}/members/${QUINN.member.id}`, { method, token: PAT.token, device: "d-pat" });
  assert.equal((await membership("DELETE")).status, 204);
  assert.deepEqual((await quinn("/api/agent/me")).json.sections, ["Library", "My files"], "nothing is shared with her now");
  assert.equal((await quinn(docUrl("Shared with me/Deals/q3"))).status, 404, "what was Pat's folder is not there for her");
  assert.equal((await quinn(docUrl("My files/Deals/q4"))).status, 200);
  assert.equal((await membership("PUT")).status, 200);
  assert.equal((await quinn(docUrl("Shared with me/Deals/q3"))).status, 200, "and back");

  // Two folders of one name shared with one person: the second is told apart by whose it is, as on a Mac.
  const third = (await share(MEMBER, { name: "Deals", members: [PAT.member.id] })).json.space;
  db.run("UPDATE spaces SET created_at = created_at + 1000 WHERE id = ?", third.id);
  assert.equal((await put(alice, "My files/Deals/q5", "# Q5\n\nAlice's deal.\n")).status, 201);
  assert.deepEqual((await ls(pat, "Shared with me")).json.folders, ["Shared with me/Deals", `Shared with me/Deals (${ALICE.name})`]);
  assert.equal((await pat(docUrl(`Shared with me/Deals (${ALICE.name})/q5`))).text, "# Q5\n\nAlice's deal.\n");
  assert.equal((await pat(docUrl("Shared with me/Deals/q4"))).status, 200, "the first of a name has it plain");
  assert.equal((await call(`/api/spaces/${third.id}`, { method: "DELETE", token: MEMBER })).json.kept, true);
  assert.deepEqual((await ls(pat, "Shared with me")).json.folders, ["Shared with me/Deals"], "deleted, it is gone for the people it was shared with");

  // The names of the folders themselves are not documents, and Shared with
  // me holds what is shared and nothing else.
  for (const section of ["Library", "My files"]) {
    const atRoot = await put(pat, section, "# x\n");
    assert.equal(atRoot.status, 400);
    assert.ok(new RegExp(`inside ${section}/`).test(atRoot.json.error), atRoot.json.error);
  }
  const loose = await put(pat, "Shared with me", "# x\n");
  assert.equal(loose.status, 400);
  assert.match(loose.json.error, /holds what others shared and nothing else/);
  assert.equal((await put(pat, "Shared with me/Brand New/x", "# x\n")).status, 404, "an agent does not share anything: its person does");
  assert.equal((await put(pat, "Library/My files.md", "# A Library note that is only called My files\n")).status, 201, "a name is a folder's where a path starts, not a word");
  assert.ok(pathsOf(storedManifest()).includes("My files.md"));
  assert.equal((await pat(docUrl("Library/My files.md"), { method: "DELETE" })).status, 200);

  // Permissions limit what it may do there, never where: a reader reads all
  // of it and writes none.
  const reader = as(await addAgentFor(PAT.token, "Pat's reader", []));
  assert.equal((await reader(docUrl("My files/notes/idea"))).status, 200);
  assert.equal((await put(reader, "My files/notes/idea", "# Mine\n", "&force=1")).status, 403);
});

await test("sections: every path starts with Library, My files or Shared with me — one that does not is refused on every route, with a sentence that says which to use, and nothing is written", async () => {
  const pat = as(PAT_BOT);
  const etag = etagNow();
  const privateEtag = fake.store.get(`spaces/${privateOf(PAT)}/manifest.json`).etag;
  const sentence = (p) => `${p} is in no section. Say which: Library/${p} (everyone), "My files/${p}" (only your person) or "Shared with me/<name>/…" (something shared with them).`;
  for (const [method, url, body, typed] of [
    ["GET", docUrl("Shared/plan"), undefined, "Shared/plan"],
    ["GET", docUrl("Shared/plan", "", "&info=1"), undefined, "Shared/plan"],
    ["PUT", docUrl("Projects/plan"), "# Plan\n", "Projects/plan"],
    ["DELETE", docUrl("Shared/plan"), undefined, "Shared/plan"],
    ["GET", commentsUrl("Shared/plan"), undefined, "Shared/plan"],
    ["POST", "/api/agent/comments", { path: "Shared/plan", on: "harbour plan", body: "Which harbour?" }, "Shared/plan"],
    ["DELETE", commentsUrl("Shared/plan", "&thread=abc123"), undefined, "Shared/plan"],
    ["POST", "/api/agent/move", { from: "Shared/plan", to: "Library/Moved/plan" }, "Shared/plan"],
    ["POST", "/api/agent/move", { from: "My files/notes/idea", to: "Projects/idea" }, "Projects/idea"],
    ["PUT", "/api/agent/pages", { path: "Shared/plan" }, "Shared/plan"],
    ["DELETE", "/api/agent/pages?path=Shared/plan", undefined, "Shared/plan"],
    ["GET", "/api/agent/tree?dir=Shared", undefined, "Shared"],
    ["GET", searchUrl("harbour", "&dir=Shared"), undefined, "Shared"],
  ]) {
    const res = await pat(url, { method, body });
    assert.equal(res.status, 400, `${method} ${url}: ${res.text}`);
    assert.equal(res.json.error, sentence(typed), `${method} ${url}`);
  }
  assert.equal((await pat(docUrl("/Shared/plan/"))).json.error, sentence("Shared/plan"), "named without the slashes around it");
  // The workspace itself holds the sections, not documents.
  const nothing = await pat(docUrl(""));
  assert.equal(nothing.status, 400);
  assert.equal(nothing.json.error, 'name a document or a folder, starting with where it is: Library/… (everyone), "My files/…" (only your person) or "Shared with me/<name>/…" (what others shared with them)');
  assert.equal(etagNow(), etag, "Library heard nothing of any of it");
  assert.equal(fake.store.get(`spaces/${privateOf(PAT)}/manifest.json`).etag, privateEtag, "nor did My files");
  // With its section, the same path is the document.
  assert.equal((await pat(docUrl("Library/Shared/plan"))).text, "# Plan\n\nThe harbour plan.\n");
});

await test("sections: comments and pages work in every section the person can see — a page is published where its document is, and listed and stopped only by those who can see it", async () => {
  const [pat, alice] = [as(PAT_BOT), as(ALICE_BOT)];
  const mine = privateOf(PAT);

  // A comment: the marker in the text and the thread in the sidecar, both in
  // Pat's Private.
  const said = await pat("/api/agent/comments", { method: "POST", body: { path: "My files/notes/idea", on: "quiet cove", body: "Which one?" } });
  assert.equal(said.status, 201, said.text);
  assert.equal(said.json.path, "My files/notes/idea");
  assert.ok(spaceText(mine, "notes/idea.md").includes("{==quiet cove==}"));
  assert.deepEqual(pathsOf(spaceManifest(mine)), ["notes/idea.md", "notes/idea.meta.jsonl"]);
  const threads = (await pat(commentsUrl("My files/notes/idea"))).json.threads;
  assert.equal(threads.length, 1);
  assert.equal(threads[0].comments[0].author, "Pat's bot");

  // Publishing: an entry in the map of the section the document is in, and
  // an address that is that section's for the whole domain.
  const page = await pat("/api/agent/pages", { method: "PUT", body: { path: "My files/notes/idea", slug: "pats-idea" } });
  assert.equal(page.status, 201, page.text);
  assert.equal(page.json.path, "My files/notes/idea");
  assert.deepEqual(Object.keys(spaceManifest(mine).public), ["pats-idea"]);
  assert.equal(spaceManifest(mine).public["pats-idea"].path, "notes/idea.md");
  assert.equal(db.value("SELECT space_id FROM addresses WHERE slug = 'pats-idea'"), mine);
  assert.ok(!("pats-idea" in (storedManifest().public ?? {})), "the shared map does not name it");
  const served = await pub("/pats-idea");
  assert.equal(served.status, 200);
  assert.ok(served.text.includes("A quiet") && !served.text.includes("{=="), "the page is the note, without its comment markers");
  const taken = await alice("/api/agent/pages", { method: "PUT", body: { path: "Library/Shared/plan", slug: "pats-idea" } });
  assert.equal(taken.status, 409, "the second claim is told it is taken");
  assert.ok(/already taken on this domain/.test(taken.json.error), taken.json.error);
  assert.equal((await alice("/api/agent/pages", { method: "PUT", body: { path: "Library/Shared/plan", slug: "the-plan" } })).status, 201);

  // The list is every section its person can see, and no other.
  const listed = async (api) => (await api("/api/agent/pages")).json.pages.map((x) => [x.slug, x.path]);
  assert.deepEqual(await listed(pat), [["pats-idea", "My files/notes/idea"], ["the-plan", "Library/Shared/plan"]]);
  assert.deepEqual(await listed(alice), [["the-plan", "Library/Shared/plan"]]);
  assert.equal((await pat(docUrl("My files/notes/idea", "", "&info=1"))).json.public[0], `${ORIGIN}/pats-idea`);

  // Stopping: by its document, or by its address — whichever section holds
  // it — and never one in a section the agent's person is not in.
  const stopBy = (api, q) => api(`/api/agent/pages?${q}`, { method: "DELETE" });
  const notHers = await stopBy(alice, "slug=pats-idea");
  assert.equal(notHers.status, 404);
  assert.deepEqual(notHers.json, { error: 'nothing is published at "pats-idea"' }, "what an address nobody has answers");
  const asWord = await stopBy(alice, "path=pats-idea");
  assert.equal(asWord.status, 400, "by the word alone, what a word that is no address answers: a path needs its section");
  assert.match(asWord.json.error, /^pats-idea is in no section\./);
  assert.equal((await pub("/pats-idea")).status, 200, "it still answers");
  const byWord = await stopBy(pat, "path=pats-idea&dry=1");
  assert.equal(byWord.status, 200, "the word alone is an address, found in the section that holds it");
  assert.deepEqual(byWord.json.stopped, [{ slug: "pats-idea", url: `${ORIGIN}/pats-idea` }]);
  const bySlug = await stopBy(pat, "slug=pats-idea");
  assert.equal(bySlug.status, 200, bySlug.text);
  assert.equal((await pub("/pats-idea")).status, 404);
  assert.equal(db.value("SELECT COUNT(*) FROM addresses WHERE slug = 'pats-idea'"), 0, "and the address is free again");
  assert.equal((await pat("/api/agent/pages", { method: "PUT", body: { path: "My files/notes/idea", slug: "pats-idea" } })).status, 201);
  assert.equal((await stopBy(pat, `path=${encodeURIComponent("My files/notes/idea")}`)).status, 200, "by its document");
  // A whole section is a folder like another.
  const whole = await pat("/api/agent/pages", { method: "PUT", body: { path: "My files/", dryRun: true } });
  assert.equal(whole.status, 200);
  assert.equal(whole.json.path, "My files");
  assert.deepEqual(whole.json.documents, ["My files/notes/idea"]);
});

await test("sections: search keeps a mirror per section — the workspace itself is every section its person can see, a folder only its own, and nobody's text is found by an agent that cannot read it", async () => {
  const [pat, quinn, alice] = [as(PAT_BOT), as(QUINN_BOT), as(ALICE_BOT)];
  db.run("DELETE FROM search_text");
  db.run("DELETE FROM search_state");
  await put(alice, "Library/Shared/harbour", "# Harbour\n\nThe cove is on the chart.\n");
  const search = async (api, q, more = "") => {
    for (let round = 0; round < 6; round += 1) {
      const res = await api(searchUrl(q, more));
      if (res.status !== 202) return res;
    }
    throw new Error("the search never finished indexing");
  };
  const paths = (res) => res.json.results.map((r) => r.path);

  const everywhere = await search(pat, "cove");
  assert.equal(everywhere.status, 200, everywhere.text);
  assert.deepEqual(paths(everywhere), ["Library/Shared/harbour", "My files/notes/idea"], "Library and Pat's My files");
  assert.deepEqual(everywhere.json.results[1].matches.map((m) => m.text), ["A quiet cove nobody knows."], "the line, without its comment marker");
  // One mirror a section: the rows of each are its own.
  const rowsIn = (space) => db.value("SELECT COUNT(*) FROM search_text WHERE space_id = ?", space);
  assert.equal(rowsIn(""), pathsOf(storedManifest()).filter((x) => x.endsWith(".md")).length);
  assert.equal(rowsIn(privateOf(PAT)), 1, "the note");
  assert.equal(rowsIn(DEALS.id), 1);
  assert.equal(mirrorEtag(privateOf(PAT)), fake.store.get(`spaces/${privateOf(PAT)}/manifest.json`).etag);
  assert.equal(rowsIn(privateOf(QUINN)), 0, "nobody has searched Quinn's");

  // Alice's agent scans the shared mirror and her own My files' — Pat's
  // words are not in what it reads.
  db.queries.length = 0;
  const hers = await search(alice, "cove");
  assert.deepEqual(paths(hers), ["Library/Shared/harbour"]);
  const scan = db.queries.find((sql) => /FROM search_text/.test(sql) && /instr/.test(sql));
  assert.ok(/space_id IN \(\?,\?\)/.test(scan), `two sections, by id: ${scan}`);
  assert.deepEqual(paths(await search(alice, "first deal")), []);

  // A folder narrows it to the section it is in, and to what is shared beneath it.
  const inDir = (dir) => `&dir=${encodeURIComponent(dir)}`;
  assert.deepEqual(paths(await search(pat, "cove", inDir("My files"))), ["My files/notes/idea"]);
  assert.deepEqual(paths(await search(pat, "cove", "&dir=Library/Shared")), ["Library/Shared/harbour"]);
  assert.deepEqual(paths(await search(pat, "cove", "&dir=library")), ["Library/Shared/harbour"], "Library is a section like the others");
  assert.deepEqual(paths(await search(pat, "deal", inDir("My files"))), ["My files/Deals/q3"], "what Pat shared from his My files is in it");
  assert.deepEqual(paths(await search(pat, "deal", inDir("my files/notes"))), [], "and in no other folder of it");
  assert.deepEqual(paths(await search(pat, "deal", inDir("Shared with me"))), ["Shared with me/Deals/q4"]);
  assert.deepEqual(paths(await search(pat, "deal", inDir("shared with me/deals"))), ["Shared with me/Deals/q4"]);
  assert.deepEqual(paths(await search(pat, "deal")), ["My files/Deals/q3", "Shared with me/Deals/q4"]);
  assert.deepEqual(paths(await search(quinn, "deal")), ["My files/Deals/q4", "Shared with me/Deals/q3"], "the same two, from where Quinn stands");
  assert.equal((await pat(searchUrl("deal", inDir("Shared with me/Nobodys")))).status, 404);

  // What an agent writes is mirrored in the request that wrote it — in the
  // mirror of the section it wrote to.
  assert.equal((await put(pat, "My files/notes/tide", "# Tide\n\nHigh water at noon.\n")).status, 201);
  assert.equal(mirrorEtag(privateOf(PAT)), fake.store.get(`spaces/${privateOf(PAT)}/manifest.json`).etag);
  db.queries.length = 0;
  assert.deepEqual(paths(await pat(searchUrl("high water"))), ["My files/notes/tide"]);
  assert.ok(!db.queries.some((sql) => /INTO search_text/.test(sql)), "the search had nothing to catch up");
});

await test("sections: a move between sections writes where it goes first and leaves a tombstone that says where it went — comments and its public address go with it", async () => {
  const [pat, quinn] = [as(PAT_BOT), as(QUINN_BOT)];
  const mine = privateOf(PAT);
  const move = (api, body) => api("/api/agent/move", { method: "POST", body });

  // Inside one section a move is the move it always was.
  const within = await move(pat, { from: "My files/notes/tide", to: "My files/tides/noon" });
  assert.equal(within.status, 200, within.text);
  assert.deepEqual(within.json, { kind: "document", from: "My files/notes/tide", to: "My files/tides/noon", files: 1 });
  assert.ok(pathsOf(spaceManifest(mine)).includes("tides/noon.md"));

  // My files → Library. Published first, so the address has something to keep.
  assert.equal((await pat("/api/agent/pages", { method: "PUT", body: { path: "My files/notes/idea", slug: "the-cove" } })).status, 201);
  const [oldFid] = entryAt(spaceManifest(mine), "notes/idea.md");
  const dry = await move(pat, { from: "My files/notes/idea", to: "Library/Shared/", dryRun: true });
  assert.equal(dry.status, 200, dry.text);
  assert.deepEqual(dry.json, { kind: "document", from: "My files/notes/idea", to: "Library/Shared/idea", files: 2, moved: false });
  assert.ok(pathsOf(spaceManifest(mine)).includes("notes/idea.md") && !pathsOf(storedManifest()).includes("Shared/idea.md"), "a dry run moved nothing");

  const out = await move(pat, { from: "My files/notes/idea", to: "Library/Shared/" });
  assert.equal(out.status, 200, out.text);
  assert.deepEqual(out.json, { kind: "document", from: "My files/notes/idea", to: "Library/Shared/idea", files: 2 });
  const shared = storedManifest();
  assert.ok(pathsOf(shared).includes("Shared/idea.md") && pathsOf(shared).includes("Shared/idea.meta.jsonl"), "the note and its comments");
  const [newFid, landed] = entryAt(shared, "Shared/idea.md");
  assert.equal(newFid, oldFid, "the id it had, so every link to it still finds it");
  assert.equal(landed.rev, 1);
  assert.equal(landed.by, PAT_BOT.id);
  assert.ok(textAt("Shared/idea.md").includes("{==quiet cove==}"), "the same bytes");
  assert.equal((await pat(commentsUrl("Library/Shared/idea"))).json.threads.length, 1, "its thread came with it");
  const left = spaceManifest(mine);
  assert.ok(!pathsOf(left).includes("notes/idea.md") && !pathsOf(left).includes("notes/idea.meta.jsonl"));
  assert.equal(left.tombstones[oldFid].to, "", "the tombstone says it went to Library, the shared section — a Mac in both moves its copy");
  assert.equal(left.tombstones[oldFid].path, "notes/idea.md");
  // The page: out of My files' map, into Library's, at the same address.
  assert.deepEqual(Object.keys(left.public), []);
  assert.deepEqual(shared.public["the-cove"], { ...shared.public["the-cove"], kind: "file", file: newFid, path: "Shared/idea.md" });
  assert.equal(db.value("SELECT space_id FROM addresses WHERE slug = 'the-cove'"), "");
  const page = await pub("/the-cove");
  assert.equal(page.status, 200, "and it answers from where the note is now");
  assert.ok(page.text.includes("A quiet"));

  // Library → a shared folder: `to` is that share's id, and the people it
  // is shared with find the note there.
  const [planFid] = entryAt(storedManifest(), "Shared/plan.md");
  const into = await move(pat, { from: "Library/Shared/plan", to: "My files/Deals" });
  assert.equal(into.status, 200, into.text);
  assert.equal(into.json.to, "My files/Deals/plan", "a section's own folder means into it, slash or not");
  assert.equal(storedManifest().tombstones[planFid].to, DEALS.id);
  assert.deepEqual(pathsOf(spaceManifest(DEALS.id)), ["plan.md", "q3.md"]);
  assert.equal((await quinn(docUrl("Shared with me/Deals/plan"))).text, "# Plan\n\nThe harbour plan.\n");
  // The page Alice's agent gave it went along, into a section she cannot see.
  assert.equal(db.value("SELECT space_id FROM addresses WHERE slug = 'the-plan'"), DEALS.id);
  assert.equal((await pub("/the-plan")).status, 200);

  // One shared folder to another, renamed on the way.
  const across = await move(pat, { from: "My files/Deals/q3", to: "Shared with me/Deals/archive/third" });
  assert.equal(across.status, 200, across.text);
  assert.deepEqual(pathsOf(spaceManifest(DEALS_QUINN.id)), ["archive/third.md", "q4.md"]);
  assert.equal(Object.values(spaceManifest(DEALS.id).tombstones).find((t) => t.path === "q3.md").to, DEALS_QUINN.id);

  // A folder moves whole, each file under the same name.
  await put(pat, "My files/trip/a", "# A\n");
  await put(pat, "My files/trip/b", "# B\n");
  const folder = await move(pat, { from: "My files/trip", to: "Library/Shared/Trips/2026" });
  assert.equal(folder.status, 200, folder.text);
  assert.deepEqual(folder.json, { kind: "folder", from: "My files/trip", to: "Library/Shared/Trips/2026", files: 2 });
  assert.ok(["Shared/Trips/2026/a.md", "Shared/Trips/2026/b.md"].every((x) => pathsOf(storedManifest()).includes(x)));

  // Library is a section like the others: its own folder means into it, at
  // the top of what the shared manifest stores, and out of it a path says where.
  const toLibrary = await move(pat, { from: "My files/tides/noon", to: "Library/" });
  assert.equal(toLibrary.status, 200, toLibrary.text);
  assert.deepEqual(toLibrary.json, { kind: "document", from: "My files/tides/noon", to: "Library/noon", files: 1 });
  const [noonFid] = entryAt(storedManifest(), "noon.md");
  assert.ok(noonFid, "stored as the shared manifest has its paths");
  const fromLibrary = await move(pat, { from: "library/NOON", to: "My files/tides/" });
  assert.deepEqual(fromLibrary.json, { kind: "document", from: "Library/noon", to: "My files/tides/noon", files: 1 });
  assert.equal(storedManifest().tombstones[noonFid].to, mine, "the tombstone says where it went");
  const back = spaceManifest(mine);
  assert.equal(back.files[noonFid]?.path, "tides/noon.md", "back where it was, under the id it always had");
  assert.equal(back.tombstones[noonFid], undefined, "and the tombstone its first move left there is gone");

  // What does not move.
  const refused = async (body, status, pattern) => {
    const res = await move(pat, body);
    assert.equal(res.status, status, `${JSON.stringify(body)}: ${res.text}`);
    assert.ok(pattern.test(res.json.error), res.json.error);
  };
  await refused({ from: "My files", to: "Library/Shared/everything" }, 400, /a section of this workspace, not a folder to move/);
  await refused({ from: "Library/", to: "My files/Library" }, 400, /^Library is a section of this workspace, not a folder to move/);
  await refused({ from: "Shared/idea", to: "My files/idea" }, 400, /^Shared\/idea is in no section\. Say which: Library\/Shared\/idea \(everyone\)/);
  await refused({ from: "My files/tides/noon", to: "Elsewhere/noon" }, 400, /^Elsewhere\/noon is in no section/);
  await refused({ from: "Library/Shared/idea", to: "Shared with me/" }, 400, /holds what others shared and nothing else/);
  await refused({ from: "Library/Shared/idea", to: "Shared with me/Nobodys/idea" }, 404, /nothing called "Nobodys" is shared/);
  await refused({ from: "My files/nothing", to: "Library/Shared/x" }, 404, /there is nothing at/);
  await refused({ from: "Library/Shared/idea", to: "My files/Deals/plan" }, 409, /"My files\/Deals\/plan.md" is already there/);
  for (let i = 0; i < 17; i += 1) await put(pat, `My files/many/n${String(i).padStart(2, "0")}`, `# ${i}\n`);
  await refused({ from: "My files/many", to: "Library/Shared/many" }, 400, /17 files, and 16 move between sections at a time/);
  assert.ok(!pathsOf(storedManifest()).some((x) => x.startsWith("Shared/many/")), "and nothing of it was written");
  // A reader's agent moves nothing anywhere.
  const reader = as(await addAgentFor(PAT.token, "Pat's second reader", []));
  assert.equal((await move(reader, { from: "Library/Shared/idea", to: "My files/idea" })).status, 403);
});

await test("sections: something shared is where it sits — a shared document is reached where its owner keeps it, and under Shared with me by the people it is shared with; an agent renames it and moves it inside its section, and does not delete it or move it anywhere else; many sections are read a page at a time", async () => {
  const [pat, quinn] = [as(PAT_BOT), as(QUINN_BOT)];
  const mine = privateOf(PAT);
  const move = (api, body) => api("/api/agent/move", { method: "POST", body });
  const ls = async (api, dir = "", more = "") => (await api(`/api/agent/tree?dir=${encodeURIComponent(dir)}${more}`)).json;
  const search = async (api, q, more = "") => {
    for (let round = 0; round < 8; round += 1) {
      const res = await api(searchUrl(q, more));
      if (res.status !== 202) return res;
    }
    throw new Error("the search never finished indexing");
  };
  const forecast = "# Forecast\n\nRain on the regatta.\n";
  assert.equal((await put(pat, "My files/plans/Forecast", forecast)).status, 201);
  assert.equal((await put(pat, "My files/plans/budget", "# Budget\n")).status, 201);
  const [fid] = entryAt(spaceManifest(mine), "plans/Forecast.md");

  // Pat shares the one document with Quinn, from his Mac: it leaves My files' manifest for a section of its own.
  const doc = await shareFromMine(PAT, "d-pat", { path: "plans/Forecast", kind: "document", members: [QUINN.member.id] });
  assert.deepEqual(pathsOf(spaceManifest(doc.id)), ["Forecast.md"]);
  assert.deepEqual(pathsOf(spaceManifest(mine)).filter((x) => x.startsWith("plans/")), ["plans/budget.md"]);

  // For Pat it is where it was: the path reaches it in the section it is now in.
  const read = await pat(docUrl("My files/plans/Forecast"));
  assert.equal(read.text, forecast);
  assert.equal(decodeURIComponent(read.headers.get("x-doklin-path")), "My files/plans/Forecast");
  assert.equal((await pat(docUrl("my files/PLANS/forecast.md", "", "&info=1"))).json.linkTo.space, doc.id);
  // For Quinn it is under Shared with me, by its own name — and nowhere in a folder of Pat's.
  assert.equal((await quinn(docUrl("Shared with me/Forecast"))).text, forecast);
  assert.equal((await quinn(docUrl("Shared with me/Forecast.md", "", "&info=1"))).json.path, "Shared with me/Forecast");
  assert.equal((await quinn(docUrl("My files/plans/Forecast"))).status, 404);
  // A link from before it was shared still finds it: the section it left says where it went.
  const ws = JSON.parse(fake.store.get("workspace.json").bytes.toString("utf8")).id;
  assert.deepEqual((await pat(`/api/agent/find?workspace=${ws}&space=${mine}&file=${fid}`)).json, { path: "My files/plans/Forecast" });
  assert.deepEqual((await quinn(`/api/agent/find?workspace=${ws}&space=${mine}&file=${fid}`)).json, { path: "Shared with me/Forecast" });

  // A listing says it is there, and shared, without opening its section; --deep opens it.
  assert.deepEqual(
    (await ls(pat, "My files/plans")).documents.map((d) => [d.path, d.shared === true, d.md !== undefined]),
    [["My files/plans/budget", false, true], ["My files/plans/Forecast", true, false]],
  );
  assert.deepEqual(
    (await ls(pat, "My files/plans", "&deep=1")).documents.map((d) => [d.path, d.md?.file]),
    [["My files/plans/budget", "budget.md"], ["My files/plans/Forecast", "Forecast.md"]],
  );
  const hers = await ls(quinn, "Shared with me");
  assert.deepEqual([hers.folders, hers.documents], [["Shared with me/Deals"], [{ path: "Shared with me/Forecast", shared: true }]]);

  // Whoever is on it changes it, and what is made beside it later is part of it: an html version, its comments.
  assert.equal((await put(quinn, "Shared with me/Forecast.html", "<p>Rain on the regatta.</p>")).status, 201);
  const said = await quinn("/api/agent/comments", { method: "POST", body: { path: "Shared with me/Forecast", on: "regatta", body: "Which day?" } });
  assert.equal(said.status, 201, said.text);
  assert.deepEqual(pathsOf(spaceManifest(doc.id)), ["Forecast.html", "Forecast.md", "Forecast.meta.jsonl"]);
  assert.equal((await pat(commentsUrl("My files/plans/Forecast"))).json.threads.length, 1, "Pat reads Quinn's thread where he keeps the note");
  // A search finds it for each by the path they know it by.
  assert.deepEqual((await search(pat, "regatta")).json.results.map((r) => r.path), ["My files/plans/Forecast"]);
  assert.deepEqual((await search(quinn, "regatta")).json.results.map((r) => r.path), ["Shared with me/Forecast"]);
  assert.deepEqual((await search(pat, "regatta", `&dir=${encodeURIComponent("My files/plans")}`)).json.results.map((r) => r.path), ["My files/plans/Forecast"]);

  // Renamed by the person it is shared with: the same share, called what its file is called.
  const renamed = await move(quinn, { from: "Shared with me/Forecast", to: "Shared with me/Outlook" });
  assert.equal(renamed.status, 200, renamed.text);
  assert.deepEqual(renamed.json, { kind: "document", from: "Shared with me/Forecast", to: "Shared with me/Outlook", shared: true });
  assert.deepEqual(pathsOf(spaceManifest(doc.id)), ["Outlook.html", "Outlook.md", "Outlook.meta.jsonl"]);
  assert.equal(db.value("SELECT name FROM spaces WHERE id = ?", doc.id), "Outlook");
  assert.equal((await pat(docUrl("My files/plans/Outlook"))).status, 200, "for Pat too, where it sits");
  assert.equal((await move(quinn, { from: "Shared with me/Outlook", to: "Shared with me/Outlook", dryRun: true })).json.moved, false);

  // Moved by its owner inside My files: where it sits is My files' own to say, and nothing of the share changes.
  const shareEtag = fake.store.get(`spaces/${doc.id}/manifest.json`).etag;
  const moved = await move(pat, { from: "My files/plans/Outlook", to: "My files/archive/" });
  assert.equal(moved.status, 200, moved.text);
  assert.deepEqual(moved.json, { kind: "document", from: "My files/plans/Outlook", to: "My files/archive/Outlook", shared: true });
  assert.deepEqual(spaceManifest(mine).mounts[doc.id], { dir: "archive", rev: 2, by: PAT_BOT.id, was: "plans/Forecast" });
  assert.equal(fake.store.get(`spaces/${doc.id}/manifest.json`).etag, shareEtag);
  assert.equal((await pat(docUrl("My files/archive/Outlook"))).status, 200);
  assert.equal((await pat(docUrl("My files/plans/Outlook"))).status, 404);
  assert.equal((await quinn(docUrl("Shared with me/Outlook"))).status, 200, "the people it is shared with see no move");
  assert.ok((await ls(pat, "My files")).folders.includes("My files/archive"), "a folder that holds only what is shared is a folder");
  // A folder that holds it moves with it.
  assert.equal((await put(pat, "My files/archive/old", "# Old\n")).status, 201);
  const folder = await move(pat, { from: "My files/archive", to: "My files/attic" });
  assert.equal(folder.status, 200, folder.text);
  assert.deepEqual([spaceManifest(mine).mounts[doc.id].dir, spaceManifest(mine).mounts[doc.id].rev], ["attic", 3]);
  assert.equal((await pat(docUrl("My files/attic/Outlook"))).status, 200);

  // What an agent does not do: delete something shared, or move it — or a folder that holds it — to where other people open it.
  const refused = async (res, said) => {
    assert.equal(res.status, 409, res.text);
    assert.equal(res.json.code, "shared");
    assert.match(res.json.error, said);
  };
  await refused(await pat(docUrl("My files/attic/Outlook"), { method: "DELETE" }), /does not delete something shared/);
  await refused(await quinn(docUrl("Shared with me/Outlook"), { method: "DELETE" }), /Its person deletes it, or leaves it, in Doklin/);
  await refused(await move(pat, { from: "My files/attic/Outlook", to: "Library/Shared/" }), /changes who can open it/);
  await refused(await move(pat, { from: "My files/attic/Outlook", to: "My files/Deals/" }), /changes who can open it/);
  await refused(await move(quinn, { from: "Shared with me/Outlook", to: "My files/Outlook" }), /changes who can open it/);
  await refused(await move(pat, { from: "My files/attic", to: "Library/Shared/attic" }), /holds something shared/);
  await refused(await move(pat, { from: "My files/Deals", to: "Library/Shared/Deals" }), /changes who can open it/);
  assert.deepEqual(pathsOf(spaceManifest(doc.id)), ["Outlook.html", "Outlook.md", "Outlook.meta.jsonl"], "none of it was done");
  // One of its two versions is not the document.
  assert.equal((await quinn(docUrl("Shared with me/Outlook", "html"), { method: "DELETE" })).status, 200);

  // A shared folder is renamed and moved the same way: its name is the share's own.
  const called = await move(pat, { from: "My files/Deals", to: "My files/attic/Deals 2026" });
  assert.equal(called.status, 200, called.text);
  assert.deepEqual(called.json, { kind: "folder", from: "My files/Deals", to: "My files/attic/Deals 2026", shared: true });
  assert.equal(db.value("SELECT name FROM spaces WHERE id = ?", DEALS.id), "Deals 2026");
  assert.equal(spaceManifest(mine).mounts[DEALS.id].dir, "attic");
  assert.equal((await pat(docUrl("My files/attic/Deals 2026/plan"))).status, 200);
  assert.equal((await quinn(docUrl("Shared with me/Deals 2026/plan"))).status, 200);
  // Somebody it is shared with renames it, and does not move it: there is nowhere of theirs it sits.
  await refused(await move(quinn, { from: "Shared with me/Deals 2026", to: "My files/Deals 2026" }), /changes who can open it/);
  assert.equal((await move(quinn, { from: "Shared with me/Deals 2026", to: "Shared with me/Deals" })).status, 200);
  assert.equal((await move(pat, { from: "My files/attic/Deals", to: "My files/" })).status, 200, "and back to the top of My files, for the tests below");
  assert.equal((await pat(docUrl("My files/Deals/plan"))).status, 200);

  // Two documents of one name shared with one person: the second is told apart by whose it is.
  const alice = as(ALICE_BOT);
  assert.equal((await put(alice, "My files/Outlook", "# Alice's outlook\n")).status, 201);
  const twin = await shareFromMine({ token: MEMBER, member: { id: ALICE.id } }, DEVICE, { path: "Outlook", kind: "document", members: [QUINN.member.id] });
  db.run("UPDATE spaces SET created_at = created_at + 1000 WHERE id = ?", twin.id);
  assert.deepEqual((await ls(quinn, "Shared with me")).documents.map((d) => d.path), ["Shared with me/Outlook", `Shared with me/Outlook (${ALICE.name})`]);
  assert.equal((await quinn(docUrl(`Shared with me/Outlook (${ALICE.name})`))).text, "# Alice's outlook\n");
  assert.equal((await put(quinn, `Shared with me/Outlook (${ALICE.name})`, "# Alice's outlook, by Quinn\n", "&force=1")).status, 200);
  assert.deepEqual(pathsOf(spaceManifest(twin.id)), ["Outlook.md"], "written under the name it is stored by");
  assert.equal((await call(`/api/spaces/${twin.id}`, { method: "DELETE", token: MEMBER })).json.kept, true);

  // More sections than one request opens: a deep listing and a search say `next`, and are asked again from there.
  const many = [];
  for (let i = 0; i < 12; i += 1) many.push(await shareFromMine(PAT, "d-pat", { path: `many/n${String(i).padStart(2, "0")}`, kind: "document" }));
  const first = await ls(pat, "My files/many", "&deep=1");
  assert.equal(first.next, 9, "nine sections a request: My files, and eight of what is shared from it");
  const rest = await ls(pat, "My files/many", "&deep=1&after=9");
  assert.equal(rest.next, undefined);
  assert.deepEqual(
    [...first.documents, ...rest.documents].map((d) => d.path).sort(),
    Array.from({ length: 17 }, (_, i) => `My files/many/n${String(i).padStart(2, "0")}`),
    "between them, every note of the folder — shared or not",
  );
  assert.equal((await ls(pat, "My files/many")).documents.filter((d) => d.shared).length, 12, "not deep, it opens none of them");
  const found = [];
  for (let after = 0; after !== undefined; ) {
    const page = (await search(pat, "#", `&dir=${encodeURIComponent("My files/many")}&limit=30${after ? `&after=${after}` : ""}`)).json;
    found.push(...page.results.map((r) => r.path));
    after = page.next;
  }
  assert.equal(new Set(found).size, 17, "a search pages through them the same way");
  for (const one of many) assert.equal((await call(`/api/spaces/${one.id}`, { method: "DELETE", token: PAT.token, device: "d-pat" })).json.kept, true);

  // A shared document that never got its document — the Mac sharing it never finished — is erased a day on.
  const stub = (await share(PAT.token, { name: "Never filled", kind: "document" })).json.space;
  const sweep = async () => {
    const log = console.log;
    console.log = () => {};
    try {
      await worker.scheduled({ cron: "17 3 * * *", scheduledTime: Date.now() }, env, { waitUntil() {} });
    } finally {
      console.log = log;
    }
  };
  await sweep();
  assert.equal(db.value("SELECT COUNT(*) FROM spaces WHERE id = ?", stub.id), 1, "made today, it may yet be filled");
  db.run("UPDATE spaces SET created_at = created_at - ? WHERE id IN (?, ?)", 2 * DAY, stub.id, doc.id);
  await sweep();
  assert.equal(db.value("SELECT COUNT(*) FROM spaces WHERE id = ?", stub.id), 0);
  assert.ok(!fake.store.has(`spaces/${stub.id}/manifest.json`));
  assert.equal(db.value("SELECT COUNT(*) FROM spaces WHERE id = ?", doc.id), 1, "one that holds its document is left alone, however old");
});

await test("find: a link's ids lead an agent to the path its person names — and every page it cannot open is one answer", async () => {
  const [pat, quinn, alice] = [as(PAT_BOT), as(QUINN_BOT), as(ALICE_BOT)];
  const ws = JSON.parse(fake.store.get("workspace.json").bytes.toString("utf8")).id;
  const find = (api, file, space = "", workspace = ws) =>
    api(`/api/agent/find?workspace=${workspace}&space=${space}&file=${file}`);
  assert.equal((await put(pat, "Library/Linked/shared", "# Shared\n")).status, 201);
  assert.equal((await put(pat, "My files/Deals/linked", "# Deal\n")).status, 201);
  assert.equal((await put(pat, "My files/linked", "# Mine\n")).status, 201);
  const [shared] = entryAt(storedManifest(), "Linked/shared.md");
  const [deal] = entryAt(spaceManifest(DEALS.id), "linked.md");
  const [mine] = entryAt(spaceManifest(privateOf(PAT)), "linked.md");

  // What a link names is in a document's info, and leads back to it.
  const linkTo = async (api, path) => (await api(docUrl(path, "", "&info=1"))).json.linkTo;
  assert.deepEqual(await linkTo(alice, "Library/Linked/shared"), { workspace: ws, space: "", file: shared });
  assert.deepEqual(await linkTo(quinn, "Shared with me/Deals/linked"), { workspace: ws, space: DEALS.id, file: deal });
  assert.deepEqual(await linkTo(pat, "My files/linked"), { workspace: ws, space: privateOf(PAT), file: mine });
  for (const [api, path] of [[alice, "Library/Linked/shared"], [quinn, "Shared with me/Deals/linked"], [pat, "My files/Deals/linked"], [pat, "My files/linked"]]) {
    const { space, file } = await linkTo(api, path);
    assert.deepEqual((await find(api, file, space)).json, { path }, `${path} round-trips`);
  }
  // The file people open: the markdown when there is one, else the html.
  assert.equal((await put(pat, "Library/Linked/shared.html", "<p>Shared</p>")).status, 201);
  assert.equal((await linkTo(pat, "Library/Linked/shared.html")).file, shared, "named by its html, it is still the markdown's");
  assert.equal((await put(pat, "Library/Linked/page.html", "<p>Page</p>")).status, 201);
  assert.equal((await linkTo(pat, "Library/Linked/page")).file, entryAt(storedManifest(), "Linked/page.html")[0]);

  // A document as the tree names it, in the section the link says.
  assert.deepEqual((await find(alice, shared)).json, { path: "Library/Linked/shared" });
  assert.deepEqual((await find(quinn, deal, DEALS.id)).json, { path: "Shared with me/Deals/linked" }, "as the person asking names it");
  assert.deepEqual((await find(pat, deal, DEALS.id)).json, { path: "My files/Deals/linked" });
  assert.deepEqual((await find(pat, mine, privateOf(PAT))).json, { path: "My files/linked" });
  // A rename keeps the link.
  const moved = await pat("/api/agent/move", { method: "POST", body: { from: "Library/Linked/shared", to: "Library/Linked/renamed" } });
  assert.equal(moved.status, 200, moved.text);
  assert.equal((await find(alice, shared)).json.path, "Library/Linked/renamed");

  // An id is looked for in every section its person can open, the one the
  // link names first: a link that names the wrong one still finds its file.
  assert.deepEqual((await find(pat, deal)).json, { path: "My files/Deals/linked" });

  // Somebody else's section, a page gone, a page never made and another
  // workspace: one answer, which names none of them.
  const refused = [
    await find(alice, deal, DEALS.id),
    await find(alice, deal),
    await find(quinn, mine, privateOf(PAT)),
    await find(pat, "f-000000000000"),
    await find(pat, shared, "", "w-000000000000"),
  ];
  assert.deepEqual(refused.map((r) => r.status), [404, 404, 404, 404, 404]);
  assert.equal(new Set(refused.map((r) => r.json.error)).size, 1, "all said alike");
  assert.ok(!refused[0].json.error.includes("Deals"));

  // A move to another section keeps the id, so the link from before it
  // finds the file where it went — for whoever can open it there.
  const across = await pat("/api/agent/move", { method: "POST", body: { from: "Library/Linked/renamed", to: "My files/Deals/" } });
  assert.equal(across.status, 200, across.text);
  assert.deepEqual((await find(quinn, shared)).json, { path: "Shared with me/Deals/renamed" });
  assert.equal((await find(alice, shared)).status, 404, "Deals is not shared with Alice");
  assert.equal((await pat(docUrl("My files/Deals/renamed"), { method: "DELETE" })).status, 200);
  assert.equal((await find(quinn, shared)).status, 404, "deleted, it is found nowhere");

  // What is not an id is a usage mistake, not a missing page.
  assert.equal((await find(pat, "../plan")).status, 400);
  assert.equal((await find(pat, shared, "Deals")).status, 400);
  assert.equal((await pat(`/api/agent/find?file=${shared}`)).status, 400, "a link always names its workspace");
});

/* ---------- The document API: links between documents ---------- */

/** A note's link records, from its sidecar in a section's bucket. */
const linkRecordsOf = (text) =>
  recordsOf(text)
    .filter((r) => r.t === "link")
    .map(({ id, file }) => ({ id, file }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
const linksUrl = (p, more = "") => `/api/agent/links?path=${encodeURIComponent(p)}${more}`;

await test("links: an agent's write gives each link to a document its record — its own by its path, in any section its person can open — and a read shows each where its document is now, as its person can open it", async () => {
  const [pat, alice] = [as(PAT_BOT), as(ALICE_BOT)];
  for (const [p, text] of [
    ["Library/Links/goal", "# Goal\n"],
    ["My files/Deals/deal", "# Deal\n"],
    ["My files/mine", "# Mine\n"],
  ]) {
    const made = await put(pat, p, text);
    assert.equal(made.status, 201, `${p}: ${made.text}`);
  }
  const [target] = entryAt(storedManifest(), "Links/goal.md");
  const [deal] = entryAt(spaceManifest(DEALS.id), "deal.md");
  const [mine] = entryAt(spaceManifest(privateOf(PAT)), "mine.md");

  const hub =
    "# Hub\n\nSee [goal](goal.md), [the deal](<../../My files/Deals/deal.md>), [mine](<../../My files/mine.md>),\n" +
    "[nowhere](gone.md), [the web](https://example.com/) and [this](#hub).\n";
  const wrote = await put(pat, "Library/Links/hub", hub);
  assert.equal(wrote.status, 201, wrote.text);
  assert.equal(textAt("Links/hub.md"), hub, "the text is stored as it was sent");
  assert.deepEqual(
    linkRecordsOf(textAt("Links/hub.meta.jsonl")),
    [
      { id: "../../My files/Deals/deal.md", file: deal },
      { id: "../../My files/mine.md", file: mine },
      { id: "goal.md", file: target },
    ],
    "a record for each link to a document Pat can open, whatever its section; none for one that opens nothing, the web or a heading",
  );

  // Renamed and moved: a read says where each is now, for whoever can open it.
  for (const [from, to] of [
    ["Library/Links/goal", "Library/Other/renamed"],
    ["My files/Deals/deal", "My files/Deals/deal-2"],
  ]) {
    assert.equal((await pat("/api/agent/move", { method: "POST", body: { from, to } })).status, 200);
  }
  const asPat = await pat(docUrl("Library/Links/hub"));
  assert.equal(asPat.status, 200);
  assert.equal(
    asPat.text,
    "# Hub\n\nSee [renamed](../Other/renamed.md), [the deal](<../../My files/Deals/deal-2.md>), [mine](<../../My files/mine.md>),\n" +
      "[nowhere](gone.md), [the web](https://example.com/) and [this](#hub).\n",
    "a named link says its document's name now; words of the author's own stay",
  );
  assert.equal(asPat.headers.get("content-length"), null, "the length is of what was shown, not the blob");
  const asAlice = await alice(docUrl("Library/Links/hub"));
  assert.equal(
    asAlice.text,
    "# Hub\n\nSee [renamed](../Other/renamed.md), [the deal](<../../My files/Deals/deal.md>), [mine](<../../My files/mine.md>),\n" +
      "[nowhere](gone.md), [the web](https://example.com/) and [this](#hub).\n",
    "what Alice cannot open is as stored: neither its new name nor where it went",
  );
  assert.ok(!asAlice.text.includes("deal-2"));
  assert.equal((await pat(docUrl("Library/Links/hub", "", "&clean=1"))).text, asPat.text, "--clean shows them the same");
  assert.equal(textAt("Links/hub.md"), hub, "a read writes nothing");

  // Written back as read, with a line of its own: a link into Library comes
  // out where its document is now; one into Deals is stored as it was, so
  // nobody outside Deals reads where it went. Each keeps its record.
  const back = asPat.text + "\nA new line.\n";
  const rev = Number(asPat.headers.get("x-doklin-rev"));
  const again = await pat(docUrl("Library/Links/hub"), { method: "PUT", body: back, headers: { "if-rev": String(rev) } });
  assert.equal(again.status, 200, again.text);
  assert.equal(
    textAt("Links/hub.md"),
    "# Hub\n\nSee [renamed](../Other/renamed.md), [the deal](<../../My files/Deals/deal.md>), [mine](<../../My files/mine.md>),\n" +
      "[nowhere](gone.md), [the web](https://example.com/) and [this](#hub).\n\nA new line.\n",
  );
  assert.deepEqual(linkRecordsOf(textAt("Links/hub.meta.jsonl")), [
    { id: "../../My files/Deals/deal.md", file: deal },
    { id: "../../My files/mine.md", file: mine },
    { id: "../Other/renamed.md", file: target },
  ]);
  assert.equal((await pat(docUrl("Library/Links/hub"))).text, back, "and Pat reads what Pat wrote");

  // Words the agent changed are its own, wherever the link leads.
  const reworded = back.replace("[the deal](<../../My files/Deals/deal-2.md>)", "[our deal](<../../My files/Deals/deal-2.md>)");
  const rev2 = Number((await pat(docUrl("Library/Links/hub"))).headers.get("x-doklin-rev"));
  assert.equal((await pat(docUrl("Library/Links/hub"), { method: "PUT", body: reworded, headers: { "if-rev": String(rev2) } })).status, 200);
  assert.ok(textAt("Links/hub.md").includes("[our deal](<../../My files/Deals/deal.md>)"), "its words, written back where it was");

  // A dry run says what would happen and writes nothing.
  const before = etagNow();
  const dry = await pat(docUrl("Library/Links/hub", "", "&dry=1&force=1"), { method: "PUT", body: "# Hub\n\nNo links now.\n" });
  assert.equal(dry.status, 200, dry.text);
  assert.equal(etagNow(), before);
});

await test("links: a link written before records gets one by its path only into the note's own section or Library — and a write never refuses a comment that holds a link a read showed moved", async () => {
  const pat = as(PAT_BOT);
  const [hub] = entryAt(storedManifest(), "Links/hub.md");
  const [target] = entryAt(storedManifest(), "Other/renamed.md");
  const [mine] = entryAt(spaceManifest(privateOf(PAT)), "mine.md");
  await macWrite((m, putFile) => {
    putFile("Links/old.md", "# Old\n\nBack to [hub](hub.md), and [mine](<../../My files/mine.md>).\n");
    putFile("Links/marked.md", "# Marked\n\n{==See [renamed](../Other/goal.md)==}{>>#c1abcd<<} first.\n");
    putFile(
      "Links/marked.meta.jsonl",
      sidecar(
        { t: "link", id: "../Other/goal.md", file: target },
        { t: "mthread", id: "c1abcd", comments: [{ author: "Alice", at: 1757000000000, body: "Which one?" }] },
      ),
    );
  });

  const old = await pat(docUrl("Library/Links/old"));
  assert.equal((await pat(docUrl("Library/Links/old", "", "&force=1"), { method: "PUT", body: old.text + "\nEdited.\n" })).status, 200);
  assert.deepEqual(
    linkRecordsOf(textAt("Links/old.meta.jsonl")),
    [{ id: "hub.md", file: hub }],
    "into Library, by its path; into a Private from Library, by its path no longer: on another device it is another person's",
  );
  assert.ok(textAt("Links/old.md").includes("[mine](<../../My files/mine.md>)"));
  assert.ok(!linkRecordsOf(textAt("Links/old.meta.jsonl")).some((r) => r.file === mine));

  // The thread's words hold a link the read shows where it goes now; written
  // back as read, the comment is where it was, around the link as it is now.
  const marked = await pat(docUrl("Library/Links/marked"));
  assert.ok(marked.text.includes("{==See [renamed](../Other/renamed.md)==}{>>#c1abcd<<}"), marked.text);
  const kept = await pat(docUrl("Library/Links/marked", "", "&force=1"), { method: "PUT", body: marked.text.replace("first.", "first, please.") });
  assert.equal(kept.status, 200, kept.text);
  assert.equal(textAt("Links/marked.md"), "# Marked\n\n{==See [renamed](../Other/renamed.md)==}{>>#c1abcd<<} first, please.\n");
  const meta = recordsOf(textAt("Links/marked.meta.jsonl"));
  assert.deepEqual(linkRecordsOf(textAt("Links/marked.meta.jsonl")), [{ id: "../Other/renamed.md", file: target }]);
  assert.ok(meta.some((r) => r.t === "mthread" && r.id === "c1abcd"), "the thread stays in the sidecar");
  // A marker still may not be changed by hand.
  const changed = await pat(docUrl("Library/Links/marked", "", "&force=1"), { method: "PUT", body: "# Marked\n\n{==See it==}{>>#c1abcd<<} first.\n" });
  assert.equal(changed.status, 400);
  assert.equal(changed.json.code, "comments");
});

await test("links: what a document links to and what links to it — as its agent's person can open them; one they can't is said to be closed, and one they can't read is not counted", async () => {
  const [pat, alice] = [as(PAT_BOT), as(ALICE_BOT)];
  assert.equal((await put(pat, "My files/notes/ref", "# Ref\n\nAbout [renamed](../../Library/Other/renamed.md).\n")).status, 201);

  const fromPat = await pat(linksUrl("Library/Links/hub", "&from=1"));
  assert.equal(fromPat.status, 200, fromPat.text);
  assert.deepEqual(fromPat.json, {
    path: "Library/Links/hub",
    from: [
      { words: "renamed", path: "Library/Other/renamed" },
      { words: "our deal", path: "My files/Deals/deal-2" },
      { words: "mine", path: "My files/mine" },
      { words: "nowhere", closed: true },
    ],
  });
  const fromAlice = (await alice(linksUrl("Library/Links/hub", "&from=1"))).json.from;
  assert.deepEqual(fromAlice, [
    { words: "renamed", path: "Library/Other/renamed" },
    { words: "our deal", closed: true },
    { words: "mine", closed: true },
    { words: "nowhere", closed: true },
  ], "a section she is not in, somebody's Private and a file never made: one answer");

  const toPat = await pat(linksUrl("Library/Other/renamed", "&to=1"));
  assert.equal(toPat.status, 200, toPat.text);
  assert.deepEqual(toPat.json, {
    path: "Library/Other/renamed",
    to: [{ path: "Library/Links/hub" }, { path: "Library/Links/marked" }, { path: "My files/notes/ref" }],
  });
  assert.deepEqual((await alice(linksUrl("Library/Other/renamed", "&to=1"))).json.to, [{ path: "Library/Links/hub" }, { path: "Library/Links/marked" }], "Pat's Private is neither listed nor counted");
  assert.deepEqual((await pat(linksUrl("Library/Links/hub", "&to=1"))).json.to, [{ path: "Library/Links/old" }], "a link without a record, by its path into Library");
  assert.deepEqual((await pat(linksUrl("My files/mine", "&to=1"))).json.to, [{ path: "Library/Links/hub" }]);

  // With neither flag, both.
  const both = (await pat(linksUrl("My files/Deals/deal-2"))).json;
  assert.deepEqual(both, { path: "My files/Deals/deal-2", to: [{ path: "Library/Links/hub" }], from: [] });

  // A document its person cannot open is one that does not exist.
  assert.equal((await alice(linksUrl("My files/Deals/deal-2"))).status, 404);
  assert.equal((await pat(linksUrl("Library/Links/nothing"))).status, 404);
  assert.equal((await pat(linksUrl("Links/hub"))).status, 400, "a path names its section");

  // The index follows what the documents say.
  assert.equal((await pat(docUrl("My files/notes/ref"), { method: "DELETE" })).status, 200);
  assert.deepEqual((await pat(linksUrl("Library/Other/renamed", "&to=1"))).json.to, [{ path: "Library/Links/hub" }, { path: "Library/Links/marked" }]);
  assert.ok(db.value("SELECT COUNT(*) FROM links WHERE target = ?", entryAt(storedManifest(), "Other/renamed.md")[0]) >= 2);
});

await test("links: a public page follows a link with a record to its document's page, a named one by its name now; a Copy link of this workspace too; anything else is its words", async () => {
  const pat = as(PAT_BOT);
  const ws = JSON.parse(fake.store.get("workspace.json").bytes.toString("utf8")).id;
  const [target] = entryAt(storedManifest(), "Other/renamed.md");
  const [deal] = entryAt(spaceManifest(DEALS.id), "deal-2.md");
  const copied = `https://doklin.cc/open#d=notes.example.com&w=${ws}&f=${target}`;
  const elsewhere = `https://doklin.cc/open#d=notes.example.com&w=w-000000000000&f=${target}`;
  await macWrite((m, putFile) => {
    putFile(
      "Links/page.md",
      `# Page\n\n[goal](../Other/goal.md#top), [the deal](<../../My files/Deals/deal.md>), [hub](hub.md), [copied](${copied}) and [another](${elsewhere}).\n`,
    );
    putFile(
      "Links/page.meta.jsonl",
      sidecar({ t: "link", id: "../../My files/Deals/deal.md", file: deal }, { t: "link", id: "../Other/goal.md", file: target }),
    );
  });
  for (const [p, slug] of [["Library/Links/page", "linkpage"], ["Library/Other/renamed", "renamedpage"]]) {
    const made = await pat("/api/agent/pages", { method: "PUT", body: { path: p, slug } });
    assert.equal(made.status, 201, made.text);
  }
  const page = await pub("/linkpage");
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('<a href="/renamedpage#top">renamed</a>'), "by its id to its page, its fragment kept, by its name now");
  assert.ok(page.text.includes("the deal") && !page.text.includes("Deals"), "a section the page is not in: its words");
  assert.ok(page.text.includes(", hub, ") && !page.text.includes("hub.md"), "unpublished: its words");
  assert.ok(page.text.includes('<a href="/renamedpage">copied</a>'), "a Copy link of this workspace goes to the page, not to doklin.cc");
  assert.ok(page.text.includes(`<a href="${elsewhere}">another</a>`), "one of another workspace is left as written");

  // A page in a restricted folder leads into Library too: its page is
  // drawn from both trees, and cached under both manifests.
  assert.equal((await put(pat, "My files/Deals/brief", "# Brief\n\nRead [renamed](../../Library/Other/renamed.md) first.\n")).status, 201);
  assert.equal((await pat("/api/agent/pages", { method: "PUT", body: { path: "My files/Deals/brief", slug: "dealbrief" } })).status, 201);
  assert.ok((await pub("/dealbrief")).text.includes('<a href="/renamedpage">renamed</a>'));
  assert.equal((await pat("/api/agent/move", { method: "POST", body: { from: "Library/Other/renamed", to: "Library/Other/final" } })).status, 200);
  assert.ok((await pub("/dealbrief")).text.includes('<a href="/renamedpage">final</a>'), "a rename in Library is on the page at once");
});

await test("sections: an agent goes with its person — removed from the workspace, every machine of every agent of theirs is refused, and inviting them again brings none back", async () => {
  const before = db.value("SELECT COUNT(*) FROM agents WHERE member_id = ?", QUINN.member.id);
  assert.ok(before >= 1);
  const alicesBefore = db.value("SELECT COUNT(*) FROM agents WHERE member_id = ?", ALICE.id);
  assert.equal((await as(QUINN_BOT)("/api/agent/me")).status, 200);
  assert.equal((await call(`/api/auth/members/${QUINN.member.id}`, { method: "DELETE", token: OWNER })).status, 204);
  assert.equal((await as(QUINN_BOT)("/api/agent/me")).status, 401, "its very next request");
  assert.equal(db.value("SELECT COUNT(*) FROM agents WHERE member_id = ?", QUINN.member.id), 0);
  assert.equal(db.value("SELECT COUNT(*) FROM agent_tokens WHERE agent_id = ?", QUINN_BOT.id), 0);
  assert.equal(db.value("SELECT COUNT(*) FROM agents WHERE member_id = ?", ALICE.id), alicesBefore, "nobody else's");
  assert.equal((await as(PAT_BOT)("/api/agent/me")).status, 200);
  assert.ok(!(await call("/api/auth/agents", { token: OWNER })).json.agents.some((a) => a.id === QUINN_BOT.id));

  // Invited again she is the same person, with her My files — and no agents:
  // one is connected again by its person.
  const back = await joinAs("quinn@example.com", "Quinn", "QQQQQQQQQQQQQQQQQQQ2", "d-quinn");
  assert.equal(back.member.id, QUINN.member.id);
  assert.deepEqual((await call("/api/auth/agents", { token: back.token, device: "d-quinn" })).json.agents, []);
  // What Quinn shared with Pat is his still, and what she shared is hers again; what Pat shared with her is not, until he shares it again.
  assert.deepEqual((await as(PAT_BOT)("/api/agent/me")).json.sections, ["Library", "My files", "Shared with me"]);
  const hers = (await call("/api/spaces", { token: back.token, device: "d-quinn" })).json.spaces.map((x) => x.id).sort();
  assert.deepEqual(hers, [privateOf(QUINN), DEALS_QUINN.id].sort());
});

/* ---------- What the account may spend ---------- */

const TODAY = Math.floor(Date.now() / DAY);
const tokenIdOf = async (token) => (await call("/api/meta", { token })).json.you.tokenId;

await test("limits: the probe, every poll, and an agent's me and login carry the plan's numbers; the plan is the superadmin's to set, and Free until they do", async () => {
  db.run("DELETE FROM settings");
  const bot = await addAgent("Counter", ["read"]);
  const free = (limits) => {
    const { fleetToday, ...rest } = limits;
    assert.deepEqual(rest, FREE_LIMITS);
    assert.equal(typeof fleetToday, "number", "what everyone has reported today");
  };
  free((await call("/api/meta", { token: OWNER })).json.limits);
  free((await call("/api/meta", { token: MEMBER, device: OTHER_DEVICE })).json.limits);
  free((await call("/api/poll", { token: MEMBER, device: OTHER_DEVICE })).json.limits);
  free((await call("/api/poll", { method: "POST", token: MEMBER, device: OTHER_DEVICE, body: {} })).json.limits);
  free((await as(bot)("/api/agent/me")).json.limits);
  const keyMeta = await call("/api/meta", { token: KEY });
  assert.ok(keyMeta.json === null || !("limits" in keyMeta.json), "the key is nobody, and paces nothing");

  // Only the superadmin says which plan the account is on.
  const asMember = await call("/api/settings/plan", { method: "PUT", token: MEMBER, device: OTHER_DEVICE, body: { plan: "paid" } });
  assert.equal(asMember.status, 403);
  assert.equal(asMember.json.error, "only the workspace's superadmin can do that");
  assert.equal((await as(bot)("/api/settings/plan", { method: "PUT", body: { plan: "paid" } })).status, 403, "never an agent's");
  assert.equal((await call("/api/settings/plan", { method: "PUT", token: OWNER, body: { plan: "enterprise" } })).status, 400);
  assert.equal((await call("/api/settings/plan", { method: "PUT", token: OWNER, body: "not json" })).status, 400);
  assert.equal((await call("/api/settings/plan", { token: OWNER })).status, 405);
  assert.equal(db.value("SELECT COUNT(*) FROM settings"), 0, "none of that wrote anything");

  const paid = await call("/api/settings/plan", { method: "PUT", token: OWNER, body: { plan: "paid" } });
  assert.equal(paid.status, 200);
  const { fleetToday, ...paidRest } = paid.json.limits;
  assert.deepEqual(paidRest, PAID_LIMITS, "the answer is the numbers the plan now has");
  assert.equal(typeof fleetToday, "number");
  assert.equal(db.value("SELECT value FROM settings WHERE key = 'plan'"), "paid");
  // Every device and agent hears it on its next request.
  assert.equal((await call("/api/poll", { token: MEMBER, device: OTHER_DEVICE })).json.limits.plan, "paid");
  assert.equal((await call("/api/meta", { token: MEMBER, device: OTHER_DEVICE })).json.limits.deviceCeiling, PAID_LIMITS.deviceCeiling);
  assert.equal((await as(bot)("/api/agent/me")).json.limits.cliDaily, PAID_LIMITS.cliDaily);
  const body = nextCodeBody();
  assert.equal((await newCode(bot.id, body)).status, 201);
  assert.equal((await loginWith(agentCode(body), "second-machine")).json.limits.cliDaily, PAID_LIMITS.cliDaily, "and a login answers with them");
  assert.equal((await call("/api/settings/plan", { method: "PUT", token: OWNER, body: { plan: "paid" } })).status, 200, "saying it again is no change");
  assert.equal((await call("/api/settings/plan", { method: "PUT", token: OWNER, body: { plan: "free" } })).json.limits.plan, "free");

  // A database that cannot say: the Free numbers, and no fleet.
  const failing = { ...env, DB: failingPast(/settings|usage/) };
  const down = (await call("/api/poll", { token: MEMBER, device: OTHER_DEVICE, bindings: failing })).json.limits;
  assert.deepEqual(down, { ...FREE_LIMITS, fleetToday: null });
  assert.deepEqual((await call("/api/meta", { token: MEMBER, device: OTHER_DEVICE, bindings: failing })).json.limits, { ...FREE_LIMITS, fleetToday: null });
  assert.equal((await call("/api/settings/plan", { method: "PUT", token: OWNER, body: { plan: "paid" }, bindings: failing })).status, 503);
  assert.equal(db.value("SELECT value FROM settings WHERE key = 'plan'"), "free");
});

await test("usage: x-doklin-used is the caller's own count of today — one row a credential, replaced, never added to — and fleetToday is today's sum; a malformed one is ignored, yesterday's is swept", async () => {
  db.run("DELETE FROM usage");
  const bot = await addAgent("Reporter", ["read"]);
  const [ownerTid, memberTid] = [await tokenIdOf(OWNER), await tokenIdOf(MEMBER)];
  const botTid = db.value("SELECT id FROM agent_tokens WHERE agent_id = ?", bot.id);
  const used = (n) => ({ "x-doklin-used": String(n) });

  const first = await call("/api/poll", { token: OWNER, headers: used(120) });
  assert.equal(first.status, 200);
  assert.deepEqual(db.rows("SELECT who, day, requests FROM usage"), [{ who: ownerTid, day: TODAY, requests: 120 }], "under its token id, on today");
  assert.equal(first.json.limits.fleetToday, 120);
  await call("/api/manifest", { token: MEMBER, device: OTHER_DEVICE, headers: used(30) });
  const agentMe = await as(bot)("/api/agent/me", { headers: used(7) });
  assert.equal(agentMe.json.limits.fleetToday, 157, "a device's, a person's other device's and an agent machine's, together");
  assert.equal(db.value("SELECT requests FROM usage WHERE who = ?", botTid), 7);

  // A report replaces the last one; sent again within the minute, it costs nothing.
  await call("/api/poll", { token: OWNER, headers: used(125) });
  assert.equal(db.value("SELECT requests FROM usage WHERE who = ?", ownerTid), 120, "a client that reports on every request writes a row a minute at most");
  db.run("UPDATE usage SET at = at - 61000 WHERE who = ?", ownerTid);
  await call("/api/poll", { token: OWNER, headers: used(125) });
  assert.equal(db.value("SELECT requests FROM usage WHERE who = ?", ownerTid), 125);
  assert.equal((await call("/api/poll", { token: OWNER })).json.limits.fleetToday, 162);

  // Not a count: ignored, and the request answered as ever.
  for (const bad of ["lots", "-5", "1.5", "", "1e3", "12345678901"]) {
    db.run("UPDATE usage SET at = at - 61000");
    const res = await call("/api/poll", { token: MEMBER, device: OTHER_DEVICE, headers: { "x-doklin-used": bad } });
    assert.equal(res.status, 200, bad);
  }
  assert.equal(db.value("SELECT requests FROM usage WHERE who = ?", memberTid), 30);

  // Yesterday's count is not today's, and the next report takes it out.
  db.run("INSERT INTO usage (who, day, requests, at) VALUES ('t-yesterday', ?, 5000, ?)", TODAY - 1, Date.now() - DAY);
  assert.equal((await call("/api/poll", { token: OWNER })).json.limits.fleetToday, 162);
  db.run("UPDATE usage SET at = at - 61000");
  await call("/api/poll", { token: MEMBER, device: OTHER_DEVICE, headers: used(31) });
  assert.equal(db.value("SELECT COUNT(*) FROM usage WHERE who = 't-yesterday'"), 0);
  // A bearer nobody holds reports nothing.
  await call("/api/poll", { token: "nobody", headers: used(999) });
  assert.equal(db.value("SELECT COUNT(*) FROM usage"), 3);
});

/** A rate-limit binding that lets `n` requests a key through: the shape of
 *  `[[ratelimits]]`, `limit({key}) → {success}`. */
class FakeLimit {
  constructor(n) {
    this.n = n;
    this.keys = [];
  }
  async limit({ key }) {
    this.keys.push(key);
    return { success: this.keys.filter((k) => k === key).length <= this.n };
  }
}

await test("loop catchers: past its binding's limit a bearer is told 429 with Retry-After: 60 before anything is done — a person's device and an agent's machine each by its token id; no binding, no check", async () => {
  const bot = await addAgent("Loopy", ["read"]);
  const devices = new FakeLimit(2);
  const agents = new FakeLimit(1);
  const bindings = { ...env, DEVICE_LIMIT: devices, AGENT_LIMIT: agents };
  const [ownerTid, memberTid] = [await tokenIdOf(OWNER), await tokenIdOf(MEMBER)];
  const botTid = db.value("SELECT id FROM agent_tokens WHERE agent_id = ?", bot.id);

  assert.equal((await call("/api/poll", { token: OWNER, bindings })).status, 200);
  assert.equal((await call("/api/meta", { token: OWNER, bindings })).status, 200);
  const usageBefore = db.rows("SELECT * FROM usage ORDER BY who");
  const over = await call("/api/poll", { method: "POST", token: OWNER, bindings, body: { name: "Mac", path: "Loop.md" }, headers: { "x-doklin-used": "9000" } });
  assert.equal(over.status, 429);
  assert.deepEqual(over.json, { error: "This device is sending too many requests — it will slow down by itself." });
  assert.equal(over.headers.get("retry-after"), "60");
  assert.deepEqual(db.rows("SELECT * FROM usage ORDER BY who"), usageBefore, "nothing was done for it — not even its report");
  assert.ok(!leaseRows().some((r) => r.path === "loop.md"), "…nor its beat");
  assert.equal((await call("/api/poll", { token: MEMBER, device: OTHER_DEVICE, bindings })).status, 200, "another person's device has a count of its own");

  assert.equal((await as(bot)("/api/agent/me", { bindings })).status, 200);
  const botOver = await as(bot)("/api/agent/tree", { bindings });
  assert.equal(botOver.status, 429, "an agent's machine, by its own binding");
  assert.equal(botOver.headers.get("retry-after"), "60");
  assert.deepEqual(devices.keys, [ownerTid, ownerTid, ownerTid, memberTid], "people are counted by their device's token");
  assert.deepEqual(agents.keys, [botTid, botTid], "agents by their machine's");

  // Nobody who is not signed in reaches it, and neither does the key.
  assert.equal((await call("/api/poll", { token: "nobody", bindings })).status, 401);
  assert.equal((await call("/api/meta", { token: KEY, bindings })).status, 200);
  assert.equal(devices.keys.length + agents.keys.length, 6);
  // Without the bindings — this whole file — nothing is checked, and a
  // binding that cannot answer stops nobody.
  assert.equal((await call("/api/poll", { token: OWNER })).status, 200);
  const broken = { limit: async () => { throw new Error("rate limiter unavailable"); } };
  assert.equal((await call("/api/poll", { token: OWNER, bindings: { ...env, DEVICE_LIMIT: broken } })).status, 200);
});

await test("commit: a stored manifest that still lists a picture — the file, its tombstone, its page — is read as if they were not there, and the worker's next write leaves them out and gives up the page's address", async () => {
  await freshWorkspace({ "Old/Home.md": "# Home\n\n![the chart](./chart.png)\n", "Old/keep.md": "# Keep\n" });
  const m = storedManifest();
  const homeFid = entryAt(m, "Old/Home.md")[0];
  const picHash = blobHash(PIXEL_PNG);
  m.files["f-legacypic"] = { path: "Old/chart.png", rev: 1, hash: picHash, size: PIXEL_PNG.length, mtime: 1757000000000, by: ALICE.id };
  m.files["f-legacypdf"] = { path: "Only pictures/deck.pdf", rev: 1, hash: blobHash("pdf"), size: 3, mtime: 1757000000000, by: ALICE.id };
  m.tombstones["f-legacyold"] = { path: "Old/gone.png", rev: 2, ts: Date.now(), by: ALICE.id };
  m.public = {
    "old-pic": { kind: "file", file: "f-legacypic", path: "Old/chart.png", by: ALICE.id, at: 1757000000000 },
    "old-home": { kind: "file", file: homeFid, path: "Old/Home.md", by: ALICE.id, at: 1757000000000 },
    "old-folder": { kind: "dir", path: "Old", by: ALICE.id, at: 1757000000000 },
  };
  m.seq += 1;
  // Written straight to the bucket: no PUT takes it.
  await fake.put(`blobs/f-legacypic/${picHash}`, PIXEL_PNG, { httpMetadata: { contentType: "image/png" } });
  await fake.put("manifest.json", JSON.stringify(m));
  db.run("INSERT OR IGNORE INTO addresses (slug, space_id) VALUES ('old-pic', ''), ('old-home', ''), ('old-folder', '')");

  // Nothing reads them: not the public pages, not an agent.
  assert.equal((await pub("/old-pic")).status, 404, "a picture's own page is gone");
  assert.equal((await rawGet("/old-folder/chart.png")).status, 404, "…and so is the picture by its path");
  const home = await pub("/old-home");
  assert.equal(home.status, 200);
  assert.ok(home.text.includes("the chart") && !home.text.includes("chart.png"), "a note's picture is its alt text");
  const bot = await addAgent("Cleaner", ["edit"]);
  const api = as(bot);
  const deep = (await api("/api/agent/tree?deep=1")).json;
  assert.deepEqual(deep.documents.map((d) => d.path), ["Library/Old/Home", "Library/Old/keep"]);
  assert.ok(!deep.folders.includes("Library/Only pictures"), "a folder of nothing but pictures is no folder here");
  assert.deepEqual((await api("/api/agent/pages")).json.pages.map((p) => p.slug), ["old-folder", "old-home"]);
  // A change that writes nothing leaves the manifest as it is.
  const etag = etagNow();
  assert.equal((await api(docUrl("Library/Old/new", "", "&dry=1"), { method: "PUT", body: "# New\n" })).json.written, false);
  assert.equal(etagNow(), etag);

  const wrote = await api(docUrl("Library/Old/new"), { method: "PUT", body: "# New\n" });
  assert.equal(wrote.status, 201);
  const after = storedManifest();
  assert.equal(after.seq, m.seq + 1);
  assert.deepEqual(pathsOf(after), ["Old/Home.md", "Old/keep.md", "Old/new.md"], "the picture and the PDF are left out");
  assert.equal(after.tombstones["f-legacyold"], undefined, "…and so is the picture's tombstone");
  assert.deepEqual(Object.keys(after.public).sort(), ["old-folder", "old-home"], "…and the picture's page");
  assert.deepEqual(db.rows("SELECT slug FROM addresses WHERE slug LIKE 'old-%' ORDER BY slug").map((r) => r.slug), ["old-folder", "old-home"], "whose address is given up");
  assert.ok(fake.store.has(`blobs/f-legacypic/${picHash}`), "its bytes are left for the collector: a write deletes only what it made");
  assert.equal((await putManifest({ ...after, seq: after.seq + 1 })).status, 200, "what it wrote is a manifest a Mac's PUT takes");
});

/* ---------- The daily sweep (sweep.ts) ---------- */

await test("sweep: the cron deletes every copy its manifest does not name once it is a day old — replaced, deleted, never named, a picture — in every section; a fresh upload, a named copy, the version store and a section whose manifest can't be read are left alone", async () => {
  const DAY = 24 * 60 * 60 * 1000;
  const bucket = new FakeR2();
  const bindings = { ...env, DATA: bucket };
  const put = async (key, body, age) => {
    await bucket.put(key, body);
    bucket.store.get(key).uploaded = new Date(Date.now() - age);
  };
  const old = DAY + 60_000;
  const files = (entries) => Object.fromEntries(entries.map(([fid, p, seed]) => [fid, { ...fileEntry(p, 2, seed), by: "m-x" }]));
  const copy = (prefix, fid, seed) => `${prefix}blobs/${fid}/${blobHash(seed)}`;

  // The shared workspace.
  await put("manifest.json", JSON.stringify(manifest(5, files([["f-plan", "Plan.md", "v2"], ["f-pic", "pic.png", "png"]]), { tombstones: { "f-gone": { path: "Gone.md", rev: 3, ts: 1, by: "m-x" } } })), 0);
  await put(copy("", "f-plan", "v2"), "v2", old);
  await put(copy("", "f-plan", "v1"), "v1", old);
  await put(copy("", "f-gone", "gone"), "gone", old);
  await put(copy("", "f-runaway", "lost"), "lost", old);
  await put(copy("", "f-pic", "png"), "png", old);
  await put(copy("", "f-new", "fresh"), "fresh", DAY - 60_000);
  await put("versions/blobs/" + "a".repeat(64), "kept by its own collector", old);
  // A person's Private, a restricted folder with no manifest yet, and one
  // whose manifest is garbage.
  const P = "spaces/p-0000000a/";
  await put(P + "manifest.json", JSON.stringify(manifest(1, files([["f-mine", "Mine.md", "m2"]]))), 0);
  await put(copy(P, "f-mine", "m2"), "m2", old);
  await put(copy(P, "f-mine", "m1"), "m1", old);
  const S = "spaces/s-0000000b/";
  await put(copy(S, "f-half", "half"), "half", old);
  const BAD = "spaces/s-0000000c/";
  await put(BAD + "manifest.json", "{not json", 0);
  await put(copy(BAD, "f-kept", "k"), "k", old);

  const logged = [];
  const log = console.log;
  console.log = (line) => logged.push(line);
  try {
    await worker.scheduled({ cron: "17 3 * * *", scheduledTime: Date.now() }, bindings, { waitUntil() {} });
  } finally {
    console.log = log;
  }
  const has = (key) => bucket.store.has(key);
  assert.ok(has(copy("", "f-plan", "v2")), "the copy the manifest names stays");
  assert.ok(!has(copy("", "f-plan", "v1")), "a replaced version goes");
  assert.ok(!has(copy("", "f-gone", "gone")), "a deleted file's copy goes");
  assert.ok(!has(copy("", "f-runaway", "lost")), "an upload no manifest ever named goes");
  assert.ok(!has(copy("", "f-pic", "png")), "a picture is not held, as the worker reads a manifest");
  assert.ok(has(copy("", "f-new", "fresh")), "an upload under a day old waits for its manifest");
  assert.ok(has("versions/blobs/" + "a".repeat(64)), "the version store is not the sweep's");
  assert.ok(has(copy(P, "f-mine", "m2")) && !has(copy(P, "f-mine", "m1")), "a space is swept against its own manifest");
  assert.ok(!has(copy(S, "f-half", "half")), "a section with no manifest names nothing");
  assert.ok(has(copy(BAD, "f-kept", "k")), "a manifest that can't be read leaves its section alone");
  assert.ok(has("manifest.json") && has(P + "manifest.json"), "nothing but copies is touched");
  assert.deepEqual(logged, ["sweep: 6 copies deleted; 3 of 4 sections swept, 1 with an unreadable manifest left alone"]);

  // A second run finds nothing more.
  console.log = () => {};
  try {
    await worker.scheduled({}, bindings, { waitUntil() {} });
  } finally {
    console.log = log;
  }
  const copies = [...bucket.store.keys()].filter((k) => /^(spaces\/[^/]+\/)?blobs\//.test(k)).sort();
  assert.deepEqual(copies, [copy("", "f-new", "fresh"), copy("", "f-plan", "v2"), copy(P, "f-mine", "m2"), copy(BAD, "f-kept", "k")].sort(), "a second run takes nothing more");
});

await test("sweep: a run makes at most 40 calls to the bucket (Workers Free allows 50), and starts each day at another section, so a bucket too big for one run is swept over the days that follow", async () => {
  const DAY = 24 * 60 * 60 * 1000;
  const bucket = new FakeR2();
  let calls = 0;
  const counted = new Proxy(bucket, {
    get(target, prop) {
      const v = target[prop];
      if (typeof v !== "function") return v;
      return (...a) => {
        calls += 1;
        return v.apply(target, a);
      };
    },
  });
  const bindings = { ...env, DATA: counted };
  // Sixty spaces with no manifest, each holding one old upload: three calls
  // each (list, manifest, delete) — more than one run's worth.
  const ids = Array.from({ length: 60 }, (_, i) => `s-${String(i).padStart(8, "0")}`);
  for (const id of ids) {
    await bucket.put(`spaces/${id}/blobs/f-orphan/${"b".repeat(16)}`, "x");
    bucket.store.get(`spaces/${id}/blobs/f-orphan/${"b".repeat(16)}`).uploaded = new Date(Date.now() - 2 * DAY);
  }
  const left = () => [...bucket.store.keys()].filter((k) => k.includes("/blobs/")).length;
  const realNow = Date.now;
  const log = console.log;
  console.log = () => {};
  const perRun = [];
  try {
    for (let day = 0; day < 10 && left() > 0; day++) {
      Date.now = () => realNow() + day * DAY;
      calls = 0;
      await worker.scheduled({}, bindings, { waitUntil() {} });
      perRun.push(calls);
    }
  } finally {
    Date.now = realNow;
    console.log = log;
  }
  assert.ok(perRun.every((n) => n <= 40), `every run within 40 calls: ${perRun}`);
  assert.ok(perRun.length > 1, "one run could not reach them all");
  assert.equal(left(), 0, `all swept within ${perRun.length} days`);
});

/* ---------- The browser version ---------- */

/** What a browser adds, and no page can, to a request the app's own script
 *  makes with `fetch`. */
const OWN_SCRIPT = { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" };
const BROWSER_DEVICE = "d-browser";
/** A request as a signed-in browser makes one: no bearer, the cookie. */
const browser = (path, { cookie, headers = {}, ...rest } = {}) =>
  call(path, {
    device: BROWSER_DEVICE,
    ...rest,
    headers: { ...OWN_SCRIPT, ...(cookie ? { cookie: `__Host-doklin=${cookie}` } : {}), ...headers },
  });
/** A code for another device of `token`'s own person, as their app mints one. */
const codeFor = async (body, token) => {
  const made = await call("/api/auth/devices/code", {
    method: "POST",
    token,
    body: { codeHash: sha256(body), expiresAt: Date.now() + 60 * 60 * 1000 },
  });
  assert.equal(made.status, 201);
  return code(body);
};
/** The token a `Set-Cookie` hands over. */
const cookieOf = (res) => /^__Host-doklin=([^;]*);/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? null;
const COOKIE_GONE = "__Host-doklin=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0";
const sharedManifest = async () => (await call("/api/manifest", { token: OWNER })).json;
const fileAt = (m, path) => Object.entries(m.files).find(([, f]) => f.path === path) ?? [null, null];
const blobText = async (fid, hash, prefix = "") => (await call(`/api${prefix}/blobs/${fid}/${hash}`, { token: OWNER })).text;
const SIDECAR = (id, body) =>
  `{"doklin":"meta","v":1}\n{"t":"mthread","id":"${id}","comments":[{"author":"Sherin","at":1782900000000,"body":"${body}"}]}\n`;

/** The owner's browser, signed in by the first test below. */
let WEB;
let WEB_TOKEN_ID;

await test("web: a browser signs in with a code and is handed a cookie, never the token — only the app's own script is answered, and the token is a browser's wherever it turns up", async () => {
  const typed = await codeFor("WEB00000000000000001", OWNER);
  const body = { code: typed, deviceId: BROWSER_DEVICE, deviceName: "Chrome on Windows" };

  // Another site, a form on a public page, a tool with no browser behind it.
  for (const headers of [
    {},
    { ...OWN_SCRIPT, "sec-fetch-site": "cross-site" },
    { ...OWN_SCRIPT, "sec-fetch-site": "same-site" },
    { ...OWN_SCRIPT, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
    { ...OWN_SCRIPT, "sec-fetch-mode": "no-cors" },
  ]) {
    const res = await call("/api/web/session", { method: "POST", body, headers });
    assert.equal(res.status, 403, JSON.stringify(headers));
    assert.equal(res.headers.get("set-cookie"), null);
  }
  assert.equal((await browser("/api/web/session", { method: "POST", body: { code: "nope" } })).status, 400);
  const unknown = await browser("/api/web/session", { method: "POST", body: { code: code("WEB0000000000000000Z") } });
  assert.equal(unknown.status, 401, "unknown and expired are one answer");
  assert.equal(unknown.headers.get("set-cookie"), null);

  const before = db.value("SELECT COUNT(*) FROM tokens");
  const signed = await browser("/api/web/session", { method: "POST", body });
  assert.equal(signed.status, 201, "…and none of the refusals above spent the code");
  assert.deepEqual(Object.keys(signed.json).sort(), ["member", "tokenId"], "no token in the body: script never holds it");
  assert.equal(signed.json.member.email, "sherin@example.com", "signed in as the person the code was for");
  const set = signed.headers.get("set-cookie");
  assert.ok(
    /^__Host-doklin=dkw_[a-f0-9]{64}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=34560000$/.test(set),
    `the cookie: ${set}`,
  );
  WEB = cookieOf(signed);
  WEB_TOKEN_ID = signed.json.tokenId;
  assert.equal(db.value("SELECT COUNT(*) FROM tokens"), before + 1, "a browser is a device: one more row");
  assert.equal(db.value("SELECT device_name FROM tokens WHERE id = ?", WEB_TOKEN_ID), "Chrome on Windows");
  assert.equal(db.value("SELECT hash FROM tokens WHERE id = ?", WEB_TOKEN_ID), sha256(WEB), "stored by its hash, prefix and all");
  assert.equal((await browser("/api/web/session", { method: "POST", body })).status, 401, "a code is spent once");
  const devices = await call("/api/auth/devices", { token: OWNER });
  assert.ok(devices.json.devices.some((d) => d.id === WEB_TOKEN_ID && d.deviceName === "Chrome on Windows"), "listed with their other devices");

  // The cookie is the sign-in.
  const meta = await browser("/api/meta", { cookie: WEB });
  assert.equal(meta.status, 200);
  assert.equal(meta.json.you.tokenId, WEB_TOKEN_ID);
  assert.equal(meta.json.you.role, "superadmin", "the person's own role");
  assert.equal(cookieOf(meta), WEB, "the probe hands the cookie back, its 400 days starting over");
  assert.equal((await browser("/api/poll", { cookie: WEB })).headers.get("set-cookie"), null, "and nothing else does");

  // …but only on a request the app's own script made: an <img> on a public
  // page, a link somebody clicked and a ping carry the cookie too.
  for (const headers of [
    { "sec-fetch-dest": "image", "sec-fetch-mode": "no-cors" },
    { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" },
    { "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate" },
    { "sec-fetch-mode": "no-cors" },
    { "sec-fetch-site": "same-site" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
  ]) {
    const res = await browser("/api/meta", { cookie: WEB, headers });
    assert.equal(res.status, 401, JSON.stringify(headers));
    assert.equal(res.headers.get("set-cookie"), null, "it is not told to drop a cookie that is good");
  }

  // The two ways in are kept apart, both ways.
  for (const [path, method] of [["/api/meta", "GET"], ["/api/manifest", "GET"], ["/api/manifest", "PUT"], ["/api/web/doc", "PUT"], ["/api/auth/devices/code", "POST"]]) {
    const res = await call(path, { method, token: WEB, body: method === "GET" ? undefined : {} });
    assert.equal(res.status, 401, `a browser's token sent as a bearer: ${method} ${path}`);
  }
  const borrowed = await browser("/api/meta", { cookie: OWNER });
  assert.equal(borrowed.status, 401, "a Mac's token sent as the cookie");
  assert.equal(borrowed.headers.get("set-cookie"), COOKIE_GONE, "a cookie that is nobody's is taken back");
  assert.equal(borrowed.headers.get("clear-site-data"), null, "…and that is all: nothing was signed out");
  const both = await browser("/api/web/search?q=x", { cookie: WEB, token: OWNER });
  assert.equal(both.status, 403, "with an Authorization header the cookie is not looked at: this is the Mac asking");
  assert.ok(/browser version's/.test(both.json.error));
});

await test("web: a browser's sign-in is answered on /api/web and the reads a browser is built from, and on nothing else; nobody else's credential is answered on /api/web", async () => {
  const m = await sharedManifest();
  const [fid, file] = Object.entries(m.files)[0];
  const mine = await browser("/api/spaces/private", { method: "PUT", cookie: WEB });
  assert.equal(mine.status, 200, "its person's own My files, made on first asking");
  const space = mine.json.space.id;

  for (const [path, method, body] of [
    ["/api/meta", "GET"],
    ["/api/poll", "GET"],
    ["/api/poll", "POST", { name: "Chrome on Windows", path: file.path }],
    ["/api/manifest", "GET"],
    [`/api/blobs/${fid}/${file.hash}`, "GET"],
    [`/api/spaces/${space}/manifest`, "GET"],
    ["/api/pages", "GET"],
  ]) {
    const res = await browser(path, { method, cookie: WEB, body });
    assert.equal(res.status, 200, `${method} ${path}`);
  }
  const here = await call("/api/poll", { token: OWNER });
  assert.equal(here.json.presence[BROWSER_DEVICE]?.name, "Chrome on Windows", "the beat says where the browser is, as a Mac's does");

  const copy = await browser(`/api/blobs/${fid}/${file.hash}`, { cookie: WEB });
  assert.equal(copy.headers.get("cache-control"), "private, max-age=31536000, immutable", "a stored copy never changes: the browser keeps it");
  assert.equal(copy.headers.get("vary"), "Cookie, Authorization", "…for the sign-in it was read with");
  assert.equal((await browser(`/api/blobs/${fid}/0000000000000000`, { cookie: WEB })).headers.get("cache-control"), "no-store", "a copy that is not there is not kept");

  for (const [path, method, body] of [
    ["/api/manifest", "PUT", m],
    [`/api/blobs/${fid}/${file.hash}`, "PUT", "x"],
    [`/api/spaces/${space}/manifest`, "PUT", m],
    ["/api/versions/index", "GET"],
    ["/api/versions/index", "PUT", {}],
    [`/api/versions/blobs/${"0".repeat(64)}`, "DELETE"],
    ["/api/workspace", "GET"],
    ["/api/workspace", "POST", { name: "Mine now" }],
    ["/api/settings/plan", "PUT", { plan: "paid" }],
    ["/api/auth/recover", "POST", { email: "mallory@example.com" }],
    ["/api/auth/join", "GET"],
    ["/api/spaces", "GET"],
    [`/api/spaces/${space}/versions/index`, "GET"],
    ["/api/pages/notes", "PUT", {}],
    ["/api/admin/wipe", "POST", { confirm: "wipe" }],
    ["/api/agent/me", "GET"],
  ]) {
    const res = await browser(path, { method, cookie: WEB, body });
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.ok(/not done from a browser|for agents/.test(res.json.error), `${method} ${path} says why: ${res.json.error}`);
  }
  assert.equal((await sharedManifest()).seq, m.seq, "and none of them was done");

  // /api/web is the browser's alone.
  for (const [path, method] of [["/api/web/doc?path=notes.md", "PUT"], ["/api/web/search?q=x", "GET"], ["/api/web/session", "DELETE"]]) {
    const person = await call(path, { method, token: OWNER, body: method === "GET" ? undefined : {} });
    assert.equal(person.status, 403, `a Mac's bearer: ${method} ${path}`);
    assert.ok(/browser version's/.test(person.json.error));
  }
  assert.equal((await browser("/api/web/nothing", { cookie: WEB })).status, 404);
  assert.equal((await browser("/api/web/doc/extra", { cookie: WEB })).status, 404);
  assert.equal((await browser("/api/web/doc?path=notes.md", { cookie: WEB })).status, 405, "a document is read from the stored copies, not from here");
  assert.equal((await browser("/api/web/session", { cookie: WEB })).status, 405);
  assert.equal((await browser("/api/web/search?q=x")).status, 401, "no cookie, nobody");
});

await test("web: people, devices and agents are a browser's too, by its person's role — a code it makes is a way in like any other, and outlasts the browser that made it", async () => {
  const me = (await browser("/api/meta", { cookie: WEB })).json.you.memberId;

  // A device of one's own: the line a browser made, joined as a Mac.
  const made = await browser("/api/auth/devices/code", {
    method: "POST",
    cookie: WEB,
    body: { codeHash: sha256("WEB000000000000000D1"), expiresAt: Date.now() + HOUR },
  });
  assert.equal(made.status, 201, made.text);
  const mac = await call("/api/auth/join", {
    method: "POST",
    body: { code: code("WEB000000000000000D1"), deviceId: "d-from-web", deviceName: "A Mac added from a browser" },
  });
  assert.equal(mac.status, 201);
  assert.ok(/^[a-f0-9]{64}$/.test(mac.json.token), "a Mac's sign-in: a bearer, with nothing in front");
  assert.equal(mac.json.member.id, me, "as the person whose browser made the code");
  assert.equal((await call("/api/manifest", { token: mac.json.token })).status, 200, "…and it syncs");

  const listed = await browser("/api/auth/devices", { cookie: WEB });
  assert.equal(listed.status, 200);
  assert.ok(listed.json.devices.some((d) => d.id === mac.json.tokenId && d.deviceName === "A Mac added from a browser"));
  assert.ok(listed.json.devices.some((d) => d.id === WEB_TOKEN_ID), "the browser itself is one of them");
  const own = await browser(`/api/auth/devices/${WEB_TOKEN_ID}`, { method: "DELETE", cookie: WEB });
  assert.equal(own.status, 409, "never the sign-in that is asking");
  assert.ok(/sign out of it instead/.test(own.json.error), own.json.error);
  assert.equal((await browser(`/api/auth/devices/${mac.json.tokenId}`, { method: "DELETE", cookie: WEB })).status, 204);
  const gone = await call("/api/poll", { token: mac.json.token });
  assert.deepEqual([gone.status, gone.json.removed], [401, true], "signed out from a browser, as from a Mac");

  // An agent of one's own, logged in with the code a browser made.
  const body = nextCodeBody();
  const added = await browser("/api/auth/agents", {
    method: "POST",
    cookie: WEB,
    body: { name: "Made in a browser", scopes: ["read", "comment"], codeHash: sha256(body), expiresAt: Date.now() + HOUR },
  });
  assert.equal(added.status, 201, added.text);
  const agent = added.json.agent.id;
  const login = await loginWith(agentCode(body), "a-linux-box");
  assert.equal(login.status, 201, login.text);
  assert.equal((await call("/api/agent/me", { token: login.json.token, device: null })).status, 200);
  const agents = await browser("/api/auth/agents", { cookie: WEB });
  const mine = agents.json.agents.find((a) => a.id === agent);
  assert.deepEqual([mine.mine, mine.machines.length], [true, 1]);
  assert.equal((await browser(`/api/auth/agents/${agent}`, { method: "POST", cookie: WEB, body: { name: "Renamed in a browser" } })).status, 200);
  const again = nextCodeBody();
  const recode = await browser(`/api/auth/agents/${agent}/code`, {
    method: "POST",
    cookie: WEB,
    body: { codeHash: sha256(again), expiresAt: Date.now() + HOUR },
  });
  assert.equal(recode.status, 201, recode.text);
  assert.equal((await browser(`/api/auth/agents/${agent}/tokens/${mine.machines[0].id}`, { method: "DELETE", cookie: WEB })).status, 204);
  assert.equal((await call("/api/agent/me", { token: login.json.token, device: null })).status, 401, "that machine is logged out");
  assert.equal((await browser(`/api/auth/agents/${agent}`, { method: "DELETE", cookie: WEB })).status, 204);
  assert.equal((await loginWith(agentCode(again), "late")).status, 401, "its code went with it");

  // People: an owner's, from a browser as from a Mac.
  assert.equal((await browser("/api/auth/members", { cookie: WEB })).status, 200);
  const invite = await browser("/api/auth/invites", {
    method: "POST",
    cookie: WEB,
    body: { email: "browser-only@example.com", name: "Bo", codeHash: sha256("WEB000000000000000P1"), expiresAt: Date.now() + DAY },
  });
  assert.equal(invite.status, 201, invite.text);
  assert.ok((await browser("/api/auth/invites", { cookie: WEB })).json.invites.some((i) => i.id === invite.json.invite.id));
  assert.equal((await browser(`/api/auth/invites/${invite.json.invite.id}`, { method: "DELETE", cookie: WEB })).status, 204);
  assert.equal(
    (await browser("/api/web/session", { method: "POST", body: { code: code("WEB000000000000000P1") } })).status,
    401,
    "a withdrawn code signs nobody in",
  );
  const second = await browser("/api/auth/invites", {
    method: "POST",
    cookie: WEB,
    body: { email: "browser-only@example.com", codeHash: sha256("WEB000000000000000P2"), expiresAt: Date.now() + DAY },
  });
  assert.equal(second.status, 201);

  // Somebody with no Mac at all: every device they will ever have starts here.
  const only = await browser("/api/web/session", {
    method: "POST",
    body: { code: code("WEB000000000000000P2"), deviceId: "d-only", deviceName: "Firefox on Linux" },
    device: "d-only",
  });
  assert.equal(only.status, 201);
  const theirs = cookieOf(only);
  const them = only.json.member.id;
  const asThem = (path, opts = {}) => browser(path, { cookie: theirs, device: "d-only", ...opts });
  assert.deepEqual((await asThem("/api/meta")).json.you.role, "member");
  const theirDevices = await asThem("/api/auth/devices");
  assert.deepEqual(theirDevices.json.devices.map((d) => d.id), [only.json.tokenId], "a member is told of their own devices only");
  const theirCode = await asThem("/api/auth/devices/code", {
    method: "POST",
    body: { codeHash: sha256("WEB000000000000000P3"), expiresAt: Date.now() + HOUR },
  });
  assert.equal(theirCode.status, 201, "another device of their own, with nobody's help");
  const phone = await call("/api/auth/join", { method: "POST", body: { code: code("WEB000000000000000P3"), deviceId: "d-phone", deviceName: "iPhone" } });
  assert.deepEqual([phone.status, phone.json.member.id], [201, them]);
  const theirAgent = await asThem("/api/auth/agents", {
    method: "POST",
    body: { name: "Bo's agent", scopes: ["read"], codeHash: sha256(nextCodeBody()), expiresAt: Date.now() + HOUR },
  });
  assert.equal(theirAgent.status, 201, "and an agent of their own");
  assert.equal((await asThem("/api/auth/agents")).json.agents.length, 1, "a member is listed their own agents only");
  // What an owner may do, a member may not, in a browser as anywhere.
  for (const [path, method, sent] of [
    ["/api/auth/invites", "GET"],
    ["/api/auth/invites", "POST", { email: "x@example.com", codeHash: sha256("x"), expiresAt: Date.now() + DAY }],
    [`/api/auth/members/${me}`, "PATCH", { role: "member" }],
    [`/api/auth/members/${me}`, "DELETE"],
  ]) {
    const res = await asThem(path, { method, body: sent });
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.ok(/only an owner/.test(res.json.error), res.json.error);
  }
  assert.equal((await asThem(`/api/auth/devices/${WEB_TOKEN_ID}`, { method: "DELETE" })).status, 404, "somebody else's device is no device");

  // The owner's browser makes them an owner, and takes them off again.
  const promoted = await browser(`/api/auth/members/${them}`, { method: "PATCH", cookie: WEB, body: { role: "owner" } });
  assert.deepEqual([promoted.status, promoted.json.member.role], [200, "owner"]);
  assert.equal((await asThem("/api/auth/invites")).status, 200, "the role bites on their very next request");
  assert.equal((await browser(`/api/auth/members/${them}`, { method: "DELETE", cookie: WEB })).status, 204);
  const out = await asThem("/api/poll");
  assert.deepEqual([out.status, out.json.removed], [401, true]);
  assert.equal(out.headers.get("clear-site-data"), '"cache", "storage"');
  assert.equal((await call("/api/poll", { token: phone.json.token })).json.removed, true, "every device they had, the one a browser's code let in among them");
  assert.equal(db.value("SELECT COUNT(*) FROM agents WHERE member_id = ?", them), 0, "and their agents");
});

await test("web: sharing is a browser's too — a folder of My files is shared where it is, its files carried to the share in parts; a document on its own; people put on and taken off; renamed, deleted and restored", async () => {
  const mine = (await browser("/api/spaces/private", { method: "PUT", cookie: WEB })).json.space.id;
  const save = (path, body, space = mine) => browser(`/api/web/doc?space=${space}&path=${encodeURIComponent(path)}`, { method: "PUT", cookie: WEB, body });
  const move = (body) => browser("/api/web/move", { method: "POST", cookie: WEB, body });
  const mount = (id, body, space = mine) => browser(`/api/web/mount?space=${space}&id=${id}`, { method: "PUT", cookie: WEB, body });
  const manifestOf = async (space) => (await browser(`/api/spaces/${space}/manifest`, { cookie: WEB })).json;
  const me = (await browser("/api/meta", { cookie: WEB })).json.you.memberId;
  const other = (await call("/api/meta", { token: MEMBER })).json.you.memberId;

  // A folder of My files. Twenty notes with their comments and two more
  // beneath: 42 files, where one request carries 16.
  for (let i = 0; i < 20; i += 1) {
    const name = `Work/board/n${String(i).padStart(2, "0")}.md`;
    assert.equal((await save(name, { md: { text: `# ${i}\n`, ifRev: null }, meta: { text: SIDECAR("m1", name), ifRev: null } })).status, 200);
  }
  for (const name of ["Work/board/Sub/Deep.md", "Work/board/Sub/Deeper/Last.md", "Work/other.md"]) {
    assert.equal((await save(name, { md: { text: `# ${name}\n`, ifRev: null } })).status, 200);
  }
  const page = await browser("/api/web/pages", { method: "PUT", cookie: WEB, body: { space: mine, path: "Work/board/n19.md", kind: "document", slug: "board-minutes" } });
  assert.equal(page.status, 201, page.text);
  const before = await manifestOf(mine);
  const fids = Object.keys(before.files).filter((fid) => before.files[fid].path.startsWith("Work/board/"));
  assert.equal(fids.length, 42);

  // Shared from a browser, by the route a Mac calls: it sits in My files, shared with whoever was named.
  const id = shareId();
  const made = await browser("/api/spaces", { method: "POST", cookie: WEB, body: { id, kind: "folder", name: "board", parent: mine, dir: "Work", was: "Work/board", members: [other] } });
  assert.equal(made.status, 201, made.text);
  const board = made.json.space;
  assert.deepEqual([board.kind, board.name, board.parent, board.owner, board.members, board.above], ["folder", "board", mine, me, [other], [me]]);
  const at = `/api/spaces/${board.id}`;
  assert.ok((await browser("/api/poll", { cookie: WEB })).json.spaces.some((x) => x.id === board.id), "the poll lists it from then on");
  assert.equal((await call(`${at}/manifest`, { token: MEMBER })).status, 200, "the person it is shared with opens it");
  assert.equal((await call(`${at}/manifest`, { token: KIM.token, device: "d-kim" })).status, 404, "and to everybody else it does not exist");

  // Where it sits is My files' manifest's to say, from the moment it is shared: the folder its item is
  // in, and where the item was. A browser says it again when the item moves inside My files.
  assert.deepEqual((await manifestOf(mine)).mounts, { [board.id]: { dir: "Work", rev: 1, by: me, was: "Work/board" } });
  const at0 = (await browser(`/api/spaces/${mine}/manifest`, { cookie: WEB })).headers.get("x-manifest-etag");
  const same = await mount(board.id, { dir: "Work" });
  assert.deepEqual([same.status, same.json.etag], [200, at0], "said again, nothing is written");
  const elsewhere = await mount(board.id, { dir: "Elsewhere" });
  assert.deepEqual([(await manifestOf(mine)).mounts[board.id].dir, (await manifestOf(mine)).mounts[board.id].rev, elsewhere.json.over], ["Elsewhere", 2, at0]);
  assert.equal((await mount(board.id, { dir: "Work" })).status, 200);
  for (const [bad, why] of [[{ dir: "../up" }, "not a folder"], [{ dir: 7 }, "not a path"], [{ was: "" }, "nowhere it was"]]) {
    const refused = await browser("/api/spaces", { method: "POST", cookie: WEB, body: { id: shareId(), kind: "folder", name: "x", parent: mine, ...bad } });
    assert.equal(refused.status, 400, why);
  }
  for (const [share, body, status, why] of [
    [board.id, { dir: "../up" }, 400, "not a folder of the section"],
    [board.id, {}, 400, "no folder said"],
    ["s-00000000", { dir: "" }, 404, "no such share"],
    [mine, { dir: "" }, 400, "My files is no share"],
  ]) {
    assert.equal((await mount(share, body)).status, status, why);
  }
  assert.equal((await mount(board.id, { dir: "" }, board.id)).status, 404, "it sits in My files, not in itself");
  assert.equal((await browser(`/api/web/mount?id=${board.id}`, { method: "PUT", cookie: WEB, body: { dir: "" } })).status, 404, "nor in Library");

  // Its files are carried to it — from the section it sits in to its own top.
  const ask = { from: { space: mine, path: "Work/board" }, to: { space: board.id, path: "" }, kind: "folder" };
  const parts = [];
  for (let left = 42; left > 0; ) {
    const part = await move(ask);
    assert.equal(part.status, 200, part.text);
    assert.deepEqual([part.json.kind, part.json.from, part.json.to], ["folder", "Work/board", ""]);
    parts.push(part.json.files);
    left -= part.json.files;
    assert.equal(part.json.remaining ?? 0, left, "each answer says how many files are still where they were");
    // Whole documents: no note is ever in one section and its comments in the other. And stopped
    // here, what is not yet carried is where only its owner reads it.
    const here = Object.values((await manifestOf(mine)).files).map((f) => f.path).filter((x) => x.startsWith("Work/board/"));
    for (const x of here.filter((x) => x.endsWith(".meta.jsonl"))) assert.ok(here.includes(x.replace(/\.meta\.jsonl$/, ".md")), x);
    assert.equal(here.length, left);
  }
  assert.deepEqual(parts, [16, 16, 10], "sixteen files a request, by path");
  let own = await manifestOf(mine);
  assert.deepEqual(Object.values(own.files).map((f) => f.path), ["Work/other.md"], "what was not in the folder stays My files' own");
  for (const fid of fids) assert.equal(own.tombstones[fid].to, board.id, "each with the tombstone that says where it went");
  let there = await manifestOf(board.id);
  assert.deepEqual(
    Object.values(there.files).map((f) => f.path).filter((x) => !x.endsWith(".meta.jsonl")).sort(),
    [...Array.from({ length: 20 }, (_, i) => `n${String(i).padStart(2, "0")}.md`), "Sub/Deep.md", "Sub/Deeper/Last.md"].sort(),
    "what was in the folder is what is in the share, at its top",
  );
  assert.equal(Object.values(there.files).filter((f) => f.path.endsWith(".meta.jsonl")).length, 20);
  for (const fid of fids) assert.ok(there.files[fid], "every file under the id it had");
  // Its page keeps its address, in the section it now belongs to.
  assert.ok(!own.public?.["board-minutes"]);
  assert.equal(there.public["board-minutes"].path, "n19.md");
  assert.equal((await move(ask)).status, 404, "and nothing is left to ask for");

  // A folder that holds something shared moves, in its section, with it: the share sits where its folder now is.
  const renamedFolder = await move({ from: { space: mine, path: "Work" }, to: { space: mine, path: "Office" }, kind: "folder" });
  assert.equal(renamedFolder.status, 200, renamedFolder.text);
  own = await manifestOf(mine);
  assert.deepEqual([own.mounts[board.id].dir, own.mounts[board.id].rev, own.mounts[board.id].was], ["Office", 4, "Work/board"]);

  // A document on its own: its section holds it and nothing else.
  assert.equal((await save("Solo.md", { md: { text: "# Solo\n", ifRev: null }, meta: { text: SIDECAR("m1", "Solo.md"), ifRev: null } })).status, 200);
  const solo = (await browser("/api/spaces", { method: "POST", cookie: WEB, body: { id: shareId(), kind: "document", name: "Solo", parent: mine, was: "Solo", members: [other] } })).json.space;
  assert.deepEqual((await manifestOf(mine)).mounts[solo.id], { dir: "", rev: 1, by: me, was: "Solo" });
  const carried = await move({ from: { space: mine, path: "Solo.md" }, to: { space: solo.id, path: "Solo.md" }, kind: "document" });
  assert.equal(carried.status, 200, carried.text);
  assert.deepEqual(Object.values((await manifestOf(solo.id)).files).map((f) => f.path).sort(), ["Solo.md", "Solo.meta.jsonl"]);
  const second = await save("Second.md", { md: { text: "# Second\n", ifRev: null } }, solo.id);
  assert.equal(second.status, 409, "nothing else goes in a shared document's section");
  assert.match(second.json.error, /holds that document and nothing else/);
  // The person it is shared with edits it, and renames it: the share is called what its file is.
  const theirs = await call(`/api/spaces/${solo.id}/manifest`, { token: MEMBER });
  const edited = JSON.parse(theirs.text);
  for (const f of Object.values(edited.files)) f.path = f.path.replace(/^Solo/, "Duet");
  edited.seq += 1;
  const put = (body) => call(`/api/spaces/${solo.id}/manifest`, { method: "PUT", token: MEMBER, headers: { "x-base-etag": theirs.headers.get("x-manifest-etag") }, body });
  // …and cannot take it out of its section: only the people of the folder it sits in move or delete it.
  const emptied = await put({ ...edited, files: {} });
  assert.equal(emptied.status, 409);
  assert.match(emptied.json.error, /You can leave it instead/);
  assert.equal((await put(edited)).status, 200);
  assert.equal((await browser("/api/poll", { cookie: WEB })).json.spaces.find((x) => x.id === solo.id).name, "Duet");
  assert.equal((await browser(`/api/spaces/${solo.id}`, { method: "PATCH", cookie: WEB, body: { name: "Trio" } })).status, 409, "a shared document is renamed by renaming its file");

  // Who it is shared with: anyone on it adds and takes off, from a browser as from a Mac.
  assert.equal((await browser(`${at}/members/m-00000000`, { method: "PUT", cookie: WEB })).status, 404, "only people here");
  assert.equal((await browser(`${at}/members/${other}`, { method: "DELETE", cookie: WEB })).status, 204);
  assert.equal((await call(`${at}/manifest`, { token: MEMBER })).status, 404);
  assert.equal((await browser(`${at}/members/${me}`, { method: "DELETE", cookie: WEB })).status, 409, "its owner is not taken off");
  const added = await browser(`${at}/members/${other}`, { method: "PUT", cookie: WEB });
  assert.deepEqual([added.status, added.json.space.members], [200, [other]]);
  // Renamed, a shared folder: its name is the share's own.
  const renamed = await browser(at, { method: "PATCH", cookie: WEB, body: { name: "Board papers" } });
  assert.deepEqual([renamed.status, renamed.json.space.name], [200, "Board papers"]);
  assert.equal((await browser(`/api/spaces/${mine}`, { method: "DELETE", cookie: WEB })).status, 409, "My files is not deleted, from a browser either");

  // A folder moved back out, to a name: nothing is lost.
  const back = { from: { space: board.id, path: "Sub" }, to: { space: mine, path: "papers" }, kind: "folder" };
  const out = await move(back);
  assert.deepEqual([out.status, out.json.files, out.json.remaining], [200, 2, undefined], "a folder one request carries says nothing of parts");
  own = await manifestOf(mine);
  assert.ok(fileAt(own, "papers/Deep.md")[0] && fileAt(own, "papers/Deeper/Last.md")[0]);

  // Deleted for everyone on it, from a browser: kept, and restored from one.
  const gone = await browser(at, { method: "DELETE", cookie: WEB });
  assert.deepEqual([gone.status, gone.json], [200, { deleted: true, kept: true }]);
  assert.equal((await browser(`${at}/manifest`, { cookie: WEB })).status, 404);
  assert.equal((await pub("/board-minutes")).status, 404);
  const listed = (await browser("/api/poll", { cookie: WEB })).json.spaces.find((x) => x.id === board.id);
  assert.ok(listed.deletedAt > 0, "the poll says it can be restored");
  const restored = await browser(`${at}/restore`, { method: "POST", cookie: WEB });
  assert.deepEqual([restored.status, restored.json.space.members], [200, [other]]);
  assert.equal((await pub("/board-minutes")).status, 200);
  // One that holds nothing is erased: the document, once it is moved back out.
  const outAgain = await move({ from: { space: solo.id, path: "Duet.md" }, to: { space: mine, path: "Duet.md" }, kind: "document" });
  assert.equal(outAgain.status, 200, outAgain.text);
  const erased = await browser(`/api/spaces/${solo.id}`, { method: "DELETE", cookie: WEB });
  assert.deepEqual([erased.json.kept, erased.json.remaining], [false, false]);
  assert.deepEqual([...fake.store.keys()].filter((k) => k.startsWith(`spaces/${solo.id}/`)), []);
  assert.equal((await browser(at, { method: "DELETE", cookie: WEB })).json.kept, true);
  assert.equal((await browser("/api/web/pages?slug=board-minutes", { method: "DELETE", cookie: WEB })).status, 404, "a deleted share's page is nobody's to stop: it answers nowhere");
});

await test("web: a note and its comments are saved in one manifest write, each over the revision that was read — and when either has moved on, neither is written", async () => {
  const start = await sharedManifest();
  const save = (path, body, extra = "") => browser(`/api/web/doc?path=${encodeURIComponent(path)}${extra}`, { method: "PUT", cookie: WEB, body });
  const TEXT = "# Browser\n\nThe {==opening==}{>>#m1web<<} is here.\n";

  const held = await currentEtag();
  const made = await save("browser/First.md", { md: { text: TEXT, ifRev: null }, meta: { text: SIDECAR("m1web", "stronger"), ifRev: null } });
  assert.equal(made.status, 200);
  let m = await sharedManifest();
  assert.equal(m.seq, start.seq + 1, "one write for both files");
  assert.equal(made.json.etag, await currentEtag(), "…and the answer names the manifest it left");
  assert.equal(made.json.over, held, "…and the one it was made to: a browser that held that one need not read it again");
  const [mdFid, md] = fileAt(m, "browser/First.md");
  const [metaFid, meta] = fileAt(m, "browser/First.meta.jsonl");
  assert.deepEqual([md.path, md.rev, meta.path, meta.rev], ["browser/First.md", 1, "browser/First.meta.jsonl", 1]);
  assert.deepEqual(made.json.md, { fid: mdFid, ...md }, "each file as the manifest now has it");
  assert.deepEqual(made.json.meta, { fid: metaFid, ...meta });
  assert.equal(md.by, (await browser("/api/meta", { cookie: WEB })).json.you.memberId, "signed with the person, as their Mac's write would be");
  assert.equal(await blobText(mdFid, md.hash), TEXT, "the text as the editor made it, markers and all");
  assert.equal(await blobText(metaFid, meta.hash), SIDECAR("m1web", "stronger"));

  // Each part on its own, over what was read.
  const again = await save("browser/First.md", { md: { text: `${TEXT}\nMore.\n`, ifRev: 1 } });
  assert.equal(again.status, 200);
  assert.equal(again.json.md.rev, 2);
  assert.equal(again.json.meta, undefined, "the comments were not sent, so they were not touched");
  const reply = await save("browser/first", { meta: { text: SIDECAR("m1web", "stronger still"), ifRev: 1 } });
  assert.equal(reply.status, 200, "named by its stem, in any case");
  assert.equal(reply.json.meta.rev, 2);
  assert.equal(reply.json.meta.fid, metaFid, "the same file, a revision on");

  // Moved on: the text, then the comments while the text is fine.
  const settled = await currentEtag();
  const stale = await save("browser/First.md", { md: { text: "mine", ifRev: 1 }, meta: { text: SIDECAR("m1web", "x"), ifRev: 2 } });
  assert.equal(stale.status, 409);
  assert.deepEqual([stale.json.part, stale.json.rev], ["md", 2], "which part, and where it is now");
  const half = await save("browser/First.md", { md: { text: "mine", ifRev: 2 }, meta: { text: SIDECAR("m1web", "x"), ifRev: 1 } });
  assert.equal(half.status, 409);
  assert.deepEqual([half.json.part, half.json.rev], ["meta", 2]);
  const taken = await save("browser/First.md", { md: { text: "mine", ifRev: null } });
  assert.deepEqual([taken.status, taken.json.part, taken.json.rev], [409, "md", 2], "a note that must not exist yet, and does");
  const gone = await save("browser/Never.md", { md: { text: "mine", ifRev: 3 } });
  assert.deepEqual([gone.status, gone.json.part, gone.json.rev], [409, "md", null], "a note that was read, and is gone");
  assert.equal(await currentEtag(), settled, "nothing was written by any of them");
  assert.equal((await sharedManifest()).files[mdFid].rev, 2, "…not even the half that was fine");

  // The same bytes are not a revision, and wake no Mac.
  const same = await save("browser/First.md", { md: { text: `${TEXT}\nMore.\n`, ifRev: 2 } });
  assert.deepEqual([same.status, same.json.md.rev, same.json.etag, same.json.over], [200, 2, settled, settled]);

  // A thread is a person's to remove by editing: nothing polices the markers.
  const plain = await save("browser/First.md", { md: { text: "# Browser\n\nNo comments now.\n", ifRev: 2 }, meta: { text: '{"doklin":"meta","v":1}\n', ifRev: 2 } });
  assert.equal(plain.status, 200);
  assert.deepEqual([plain.json.md.rev, plain.json.meta.rev], [3, 3]);

  // A new note has nothing in it yet.
  const empty = await save("browser/Empty.md", { md: { text: "", ifRev: null } });
  assert.deepEqual([empty.status, empty.json.md.rev, empty.json.md.size], [200, 1, 0]);
  assert.equal(await blobText(empty.json.md.fid, empty.json.md.hash), "");

  // What is asked wrongly, or of nothing.
  assert.equal((await save("browser/First.md", {})).status, 400);
  assert.equal((await save("browser/First.md", { md: { text: "x" } })).status, 400, "ifRev is said, null included");
  assert.equal((await save("browser/First.md", { md: { text: 1, ifRev: 3 } })).status, 400);
  assert.equal((await save("browser/First.md", { meta: "text" })).status, 400);
  assert.equal((await save("browser/First.md", { md: { text: "x", ifRev: 0 } })).status, 400);
  assert.equal((await save("browser/Never.md", { meta: { text: SIDECAR("m1", "x"), ifRev: null } })).status, 404, "comments on no document");
  assert.equal((await save("browser/Page.html", { md: { text: "x", ifRev: null } })).status, 400, "an html page is not written here");
  assert.equal((await save("browser/First.meta.jsonl", { md: { text: "x", ifRev: null } })).status, 400, "the sidecar is saved as the document's comments");
  assert.equal((await save("browser/chart.png", { md: { text: "x", ifRev: null } })).status, 400, "only documents sync");
  assert.equal(await currentEtag(), empty.json.etag);

  // A section is named by its id, and its paths are its own.
  const space = (await browser("/api/spaces/private", { method: "PUT", cookie: WEB })).json.space.id;
  const priv = await save("Diary.md", { md: { text: "# Diary\n", ifRev: null } }, `&space=${space}`);
  assert.equal(priv.status, 200);
  const inSpace = (await call(`/api/spaces/${space}/manifest`, { token: OWNER })).json;
  assert.equal(inSpace.files[priv.json.md.fid].path, "Diary.md", "as the space stores it: no My files/ in front");
  assert.equal(fileAt(await sharedManifest(), "Diary.md")[0], null, "…and not in the shared workspace");
  assert.equal(db.value("SELECT etag FROM spaces WHERE id = ?", space), priv.json.etag, "the poll is told where the space's manifest is");
  assert.equal((await save("x.md", { md: { text: "x", ifRev: null } }, "&space=s-00000000")).status, 404, "a folder they are not in is no folder");
  assert.equal((await save("x.md", { md: { text: "x", ifRev: null } }, "&space=nope")).status, 400);
});

await test("web: a document or a folder is moved to exactly where the browser said, removed whole or by one version, and a folder with everything under it", async () => {
  const save = (path, body, extra = "") => browser(`/api/web/doc?path=${encodeURIComponent(path)}${extra}`, { method: "PUT", cookie: WEB, body });
  const move = (body) => browser("/api/web/move", { method: "POST", cookie: WEB, body });
  const remove = (route, path, extra = "") => browser(`/api/web/${route}?path=${encodeURIComponent(path)}${extra}`, { method: "DELETE", cookie: WEB });
  const space = (await browser("/api/spaces/private", { method: "PUT", cookie: WEB })).json.space.id;
  for (const name of ["browser/Plan.md", "browser/Other.md", "browser/Sub/Deep.md"]) {
    assert.equal((await save(name, { md: { text: `# ${name}\n`, ifRev: null }, meta: { text: SIDECAR("m1", name), ifRev: null } })).status, 200);
  }
  let m = await sharedManifest();
  const [planFid, plan] = fileAt(m, "browser/Plan.md");
  const [planMetaFid] = fileAt(m, "browser/Plan.meta.jsonl");

  // A rename: the note and its comments, in one write, the bytes as they were.
  const renamed = await move({ from: { path: "browser/Plan.md" }, to: { path: "browser/Roadmap.md" }, kind: "document" });
  assert.equal(renamed.status, 200);
  assert.deepEqual([renamed.json.kind, renamed.json.from, renamed.json.to, renamed.json.files], ["document", "browser/Plan", "browser/Roadmap", 2]);
  assert.equal((await sharedManifest()).seq, m.seq + 1, "one write");
  m = await sharedManifest();
  assert.deepEqual([m.files[planFid].path, m.files[planFid].rev, m.files[planFid].hash], ["browser/Roadmap.md", plan.rev + 1, plan.hash]);
  assert.equal(m.files[planMetaFid].path, "browser/Roadmap.meta.jsonl");

  // Exactly there: a destination that is a folder's name is the note's new
  // name, beside the folder — where an agent's `mv` reads "into it".
  const beside = await move({ from: { path: "browser/Roadmap.md" }, to: { path: "browser/Sub" }, kind: "document" });
  assert.deepEqual([beside.status, beside.json.to], [200, "browser/Sub"]);
  m = await sharedManifest();
  assert.equal(m.files[planFid].path, "browser/Sub.md");
  assert.ok(fileAt(m, "browser/Sub/Deep.md")[0], "the folder is as it was");
  assert.equal((await move({ from: { path: "browser/Sub.md" }, to: { path: "browser/Roadmap.md" }, kind: "document" })).status, 200);
  assert.equal((await move({ from: { path: "browser/Roadmap.md" }, to: { path: "browser/Other.md" }, kind: "document" })).status, 409, "a name that is taken");
  assert.equal((await move({ from: { path: "browser/Nope.md" }, to: { path: "browser/X.md" }, kind: "document" })).status, 404);
  assert.equal((await move({ from: { path: "browser/Sub" }, to: { path: "browser/Sub2" }, kind: "document" })).status, 404, "a folder is not a document");
  assert.equal((await move({ from: { path: "browser/Roadmap" }, to: { path: "browser/R2" }, kind: "folder" })).status, 404, "nor a document a folder");
  assert.equal((await move({ from: { path: "browser/Roadmap.md" }, to: { path: "browser/Roadmap.md" } })).status, 400, "the kind is said");
  assert.equal((await move({ from: { path: "browser/Roadmap.md" }, kind: "document" })).status, 400);
  assert.equal((await move({ from: { path: "browser/Roadmap.md" }, to: { path: ".hidden/x.md" }, kind: "document" })).status, 400);

  // A folder, with everything under it.
  const folder = await move({ from: { path: "browser/Sub" }, to: { path: "browser/Deeper" }, kind: "folder" });
  assert.deepEqual([folder.status, folder.json.kind, folder.json.to, folder.json.files], [200, "folder", "browser/Deeper", 2]);
  assert.ok(fileAt(await sharedManifest(), "browser/Deeper/Deep.md")[0]);

  // To another section: written there first, then taken out of here with a
  // tombstone that says where it went.
  const across = await move({ from: { path: "browser/Roadmap.md" }, to: { space, path: "Roadmap.md" }, kind: "document" });
  assert.equal(across.status, 200);
  assert.equal(across.json.files, 2);
  m = await sharedManifest();
  assert.equal(m.files[planFid], undefined);
  assert.equal(m.tombstones[planFid].to, space, "a Mac in both sections moves its copy; one that is not deletes its own");
  const there = (await call(`/api/spaces/${space}/manifest`, { token: OWNER })).json;
  assert.equal(fileAt(there, "Roadmap.md")[0], planFid, "under the id it had, so links to it still find it");
  assert.ok(fileAt(there, "Roadmap.meta.jsonl")[0], "and its comments with it");
  assert.equal((await move({ from: { space: "s-00000000", path: "x.md" }, to: { path: "x.md" }, kind: "document" })).status, 404);

  // Removing: one version only when it is one of two; the document whole; a folder.
  const only = await remove("doc", "browser/Other.md", "&v=md");
  assert.deepEqual([only.status, only.json.code], [409, "last_version"]);
  assert.equal((await remove("doc", "browser/Other.md", "&v=pdf")).status, 400);
  assert.equal((await remove("doc", "browser/Nope.md")).status, 404);
  const [otherFid] = fileAt(m, "browser/Other.md");
  const [otherMetaFid] = fileAt(m, "browser/Other.meta.jsonl");
  const whole = await remove("doc", "browser/Other.md");
  assert.equal(whole.status, 200);
  m = await sharedManifest();
  assert.ok(!m.files[otherFid] && !m.files[otherMetaFid], "the note and its comments");
  assert.ok(m.tombstones[otherFid] && m.tombstones[otherMetaFid], "each with the tombstone a Mac honours");
  assert.equal(m.tombstones[otherFid].to, undefined, "deleted, not moved");

  assert.equal((await remove("folder", "")).status, 400, "never the section itself");
  assert.equal((await remove("folder", "browser/Nope")).status, 404);
  const before = Object.keys(m.files).filter((fid) => m.files[fid].path.startsWith("browser/")).length;
  assert.ok(before >= 3, "First and its comments, and what is under Deeper");
  const cleared = await remove("folder", "BROWSER");
  assert.deepEqual([cleared.status, cleared.json.path, cleared.json.files], [200, "browser", before], "named in any case, answered as it is spelled");
  m = await sharedManifest();
  assert.equal(Object.values(m.files).filter((f) => f.path.startsWith("browser/")).length, 0);
  assert.equal((await remove("folder", "browser")).status, 404, "a folder is its files");
  assert.equal((await remove("doc", "Roadmap.md", `&space=${space}`)).status, 200);
  assert.equal((await remove("doc", "Diary.md", `&space=${space}`)).status, 200);
});

await test("web: a document or a folder is copied to exactly where the browser said, every file of it a new one, in its section or in another", async () => {
  const save = (path, body, extra = "") => browser(`/api/web/doc?path=${encodeURIComponent(path)}${extra}`, { method: "PUT", cookie: WEB, body });
  const copy = (body) => browser("/api/web/copy", { method: "POST", cookie: WEB, body });
  const remove = (route, path, extra = "") => browser(`/api/web/${route}?path=${encodeURIComponent(path)}${extra}`, { method: "DELETE", cookie: WEB });
  const space = (await browser("/api/spaces/private", { method: "PUT", cookie: WEB })).json.space.id;
  for (const name of ["copies/Plan.md", "copies/Sub/Deep.md"]) {
    assert.equal((await save(name, { md: { text: `# ${name}\n`, ifRev: null }, meta: { text: SIDECAR("m1", name), ifRev: null } })).status, 200);
  }
  let m = await sharedManifest();
  const [planFid, plan] = fileAt(m, "copies/Plan.md");
  const held = await currentEtag();

  // Beside what it was copied from: the note and its comments, in one write.
  const made = await copy({ from: { path: "copies/Plan.md" }, to: { path: "copies/Plan copy.md" }, kind: "document" });
  assert.equal(made.status, 200);
  assert.deepEqual([made.json.kind, made.json.from, made.json.to, made.json.files], ["document", "copies/Plan", "copies/Plan copy", 2]);
  assert.deepEqual([made.json.over, made.json.etag], [held, await currentEtag()]);
  assert.equal((await sharedManifest()).seq, m.seq + 1, "one write");
  m = await sharedManifest();
  const [copyFid, copied] = fileAt(m, "copies/Plan copy.md");
  assert.ok(copyFid && copyFid !== planFid, "a file of its own");
  assert.deepEqual([copied.rev, copied.hash], [1, plan.hash], "…holding the same bytes, at its first revision");
  assert.equal(await blobText(copyFid, copied.hash), "# copies/Plan.md\n");
  assert.ok(fileAt(m, "copies/Plan copy.meta.jsonl")[0], "its comments came with it");
  assert.deepEqual(m.files[planFid], plan, "and what it was copied from is as it was");
  assert.equal(m.tombstones?.[planFid], undefined);

  assert.equal((await copy({ from: { path: "copies/Plan.md" }, to: { path: "copies/Plan copy.md" }, kind: "document" })).status, 409, "a name that is taken");
  assert.equal((await copy({ from: { path: "copies/Nope.md" }, to: { path: "copies/X.md" }, kind: "document" })).status, 404);
  assert.equal((await copy({ from: { path: "copies/Sub" }, to: { path: "copies/Sub2" }, kind: "document" })).status, 404, "a folder is not a document");
  assert.equal((await copy({ from: { path: "copies/Plan.md" }, to: { path: "copies/Y.md" } })).status, 400, "the kind is said");
  assert.equal((await copy({ from: { path: "copies/Plan.md" }, to: { path: ".hidden/x.md" }, kind: "document" })).status, 400);
  assert.equal((await call("/api/web/copy", { method: "POST", token: OWNER, body: {} })).status, 403, "a browser's route, like the rest");

  // A folder, with everything under it.
  const folder = await copy({ from: { path: "copies/Sub" }, to: { path: "copies/Sub copy" }, kind: "folder" });
  assert.deepEqual([folder.status, folder.json.kind, folder.json.to, folder.json.files], [200, "folder", "copies/Sub copy", 2]);
  m = await sharedManifest();
  assert.ok(fileAt(m, "copies/Sub copy/Deep.md")[0] && fileAt(m, "copies/Sub/Deep.md")[0]);

  // To another section: there, and still here.
  const across = await copy({ from: { path: "copies/Plan.md" }, to: { space, path: "Plan.md" }, kind: "document" });
  assert.deepEqual([across.status, across.json.files], [200, 2]);
  const there = (await call(`/api/spaces/${space}/manifest`, { token: OWNER })).json;
  assert.ok(fileAt(there, "Plan.md")[0] && fileAt(there, "Plan.meta.jsonl")[0]);
  assert.equal(across.json.etag, db.value("SELECT etag FROM spaces WHERE id = ?", space), "the etags are the section's it went to");
  assert.ok((await sharedManifest()).files[planFid], "nothing left where it was copied from");
  assert.equal((await copy({ from: { space: "s-00000000", path: "x.md" }, to: { path: "x.md" }, kind: "document" })).status, 404);

  // More files than one request carries.
  for (let i = 0; i < 17; i++) assert.equal((await save(`copies/Many/n${i}.md`, { md: { text: `${i}\n`, ifRev: null } })).status, 200);
  const many = await copy({ from: { path: "copies/Many" }, to: { path: "copies/Many copy" }, kind: "folder" });
  assert.equal(many.status, 400);
  assert.ok(/17 files, and 16 are copied at a time/.test(many.json.error), many.json.error);
  assert.equal(fileAt(await sharedManifest(), "copies/Many copy/n0.md")[0], null, "and none of it was");

  assert.equal((await remove("folder", "copies")).status, 200);
  assert.equal((await remove("doc", "Plan.md", `&space=${space}`)).status, 200);
});

await test("web: search covers every section the person is in, and names what it found by section and file id; what the browser just saved is found at once", async () => {
  const space = (await browser("/api/spaces/private", { method: "PUT", cookie: WEB })).json.space.id;
  const put = (path, text, extra = "") =>
    browser(`/api/web/doc?path=${encodeURIComponent(path)}${extra}`, { method: "PUT", cookie: WEB, body: { md: { text, ifRev: null } } });
  const search = async (q, as = { cookie: WEB }) => {
    for (let round = 0; round < 40; round += 1) {
      const res = await browser(`/api/web/search?q=${encodeURIComponent(q)}`, as);
      if (res.status !== 202) return res;
      assert.equal(res.json.indexing, true, "the mirror is catching up: ask again");
    }
    throw new Error("the mirror never caught up");
  };
  assert.equal((await search("warm")).status, 200, "a first search of the person's own Private builds its mirror");
  const shared = await put("browsing/Quokka.md", "# Field notes\n\nA zyzzyva sat on the fence.\n");
  const priv = await put("Secret.md", "# Secret\n\nThe zyzzyva again, in private.\n", `&space=${space}`);
  assert.deepEqual([shared.status, priv.status], [200, 200]);

  const found = await search("ZYZZYVA");
  assert.equal(found.status, 200);
  assert.deepEqual(
    found.json.results.map((r) => [r.space, r.fid, r.path, r.matches[0].line]),
    [
      ["", shared.json.md.fid, "browsing/Quokka.md", 3],
      [space, priv.json.md.fid, "Secret.md", 3],
    ],
    "the section's id and the file's, and the path as that section stores it",
  );
  assert.equal(found.json.total, 2);
  const named = await search("quokka");
  assert.deepEqual([named.json.results[0].fid, named.json.results[0].inName], [shared.json.md.fid, true], "by its name too");
  assert.equal((await browser("/api/web/search", { cookie: WEB })).status, 400);
  assert.equal((await browser("/api/web/search?q=a%0Ab", { cookie: WEB })).status, 400);

  // Somebody else's Private is not theirs to search.
  const alice = await codeFor("WEB00000000000000002", MEMBER);
  const hers = cookieOf(await browser("/api/web/session", { method: "POST", body: { code: alice, deviceId: "d-alice-web", deviceName: "Firefox" } }));
  const asAlice = await search("zyzzyva", { cookie: hers, device: "d-alice-web" });
  assert.deepEqual(asAlice.json.results.map((r) => [r.space, r.path]), [["", "browsing/Quokka.md"]], "the shared note, and nothing of his");
  assert.equal((await browser(`/api/spaces/${space}/manifest`, { cookie: hers })).status, 404, "nor to read");
  assert.equal((await browser("/api/pages", { cookie: hers })).status, 403, "and every address on the domain is an owner's to list, in a browser as on a Mac");
  assert.equal((await browser("/api/auth/session", { method: "DELETE", cookie: hers })).status, 204);

  assert.equal((await browser("/api/web/folder?path=browsing", { method: "DELETE", cookie: WEB })).status, 200);
  assert.equal((await browser(`/api/web/doc?path=Secret.md&space=${space}`, { method: "DELETE", cookie: WEB })).status, 200);
});

await test("web: a search narrows by tags — tag=name:value or a name alone, with text or none, and then every such note is listed", async () => {
  const put = (path, text) =>
    browser(`/api/web/doc?path=${encodeURIComponent(path)}`, { method: "PUT", cookie: WEB, body: { md: { text, ifRev: null } } });
  const search = async (query) => {
    for (let round = 0; round < 40; round += 1) {
      const res = await browser(`/api/web/search?${query}`, { cookie: WEB });
      if (res.status !== 202) return res;
    }
    throw new Error("the mirror never caught up");
  };
  const doing = await put("tagged/Doing one.md", "---\nstatus: Doing\n---\nA kakapo.\n");
  const done = await put("tagged/Done one.md", "---\nStatus: done\n---\nAnother kakapo.\n");
  await put("tagged/Plain.md", "A kakapo with no tags.\n");
  const paths = (res) => res.json.results.map((r) => r.path);

  assert.deepEqual(paths(await search("tag=status%3ADoing")), ["tagged/Doing one.md"], "no text: every note with the tag");
  assert.deepEqual((await search("tag=status%3ADoing")).json.results[0], { space: "", fid: doing.json.md.fid, path: "tagged/Doing one.md", matches: [] });
  assert.deepEqual(paths(await search("tag=status")), ["tagged/Doing one.md", "tagged/Done one.md"], "a name alone: any value");
  assert.deepEqual(paths(await search("q=kakapo&tag=status%3ADONE")), ["tagged/Done one.md"], "with the text, whatever the case");
  assert.equal((await search("q=&tag=status%3A")).status, 400);
  assert.equal(done.status, 200);

  assert.equal((await browser("/api/web/folder?path=tagged", { method: "DELETE", cookie: WEB })).status, 200);
  assert.deepEqual((await search("tag=status")).json.results, []);
});

await test("web: the tag list from a browser — a tag set in its place or made, held to the app's rules, or removed; two changes at once and the later one wins; a note saved from a browser keeps the list", async () => {
  const before = (await sharedManifest()).tags;
  await macTags(TAGS);
  const set = (at, tag) => browser("/api/web/tags", { method: "PUT", cookie: WEB, body: { at, tag } });
  const remove = (name) => browser(`/api/web/tags?name=${encodeURIComponent(name)}`, { method: "DELETE", cookie: WEB });
  const stored = () => storedManifest().tags;

  const edited = await set("Status", { name: " Stage ", values: ["Todo", " Done"], desc: "  " });
  assert.equal(edited.status, 200, edited.text);
  assert.deepEqual(edited.json, { tags: [{ name: "Stage", values: ["Todo", "Done"] }, TAGS[1]], etag: etagNow() }, "trimmed, in its place, and nothing said of its values is none");
  assert.deepEqual(stored(), edited.json.tags);
  const made = await set("area", { name: "area", values: ["Web"], desc: "Which app." });
  assert.deepEqual(made.json.tags.at(-1), { name: "area", values: ["Web"], desc: "Which app." });

  // A browser that had not seen the other change: the later one wins, over the list as it is now.
  await macTags([...stored().slice(0, 2), { name: "area", values: ["Web", "iPhone"] }]);
  assert.deepEqual((await set("AREA", { name: "Area", values: ["Mac"] })).json.tags.at(-1), { name: "Area", values: ["Mac"] });

  const refused = async (res, status, pattern) => {
    assert.equal(res.status, status, res.text);
    assert.match(res.json.error, pattern);
  };
  await refused(await set("area", { name: "priority", values: ["x"] }), 400, /^There's already a tag called priority\.$/);
  await refused(await set("new", { name: "new", values: [] }), 400, /^A tag needs at least one value\.$/);
  await refused(await set("new", { name: "new", values: ["a", "A"] }), 400, /^a is there twice\.$/);
  await refused(await set("new", { name: "new" }), 400, /at is the tag's name before/);
  await refused(await set(3, { name: "new", values: ["a"] }), 400, /at is the tag's name before/);
  await refused(await remove("nothing"), 404, /^There's no tag called nothing\.$/);
  await refused(await remove(""), 400, /name is the tag to remove/);

  const gone = await remove("STAGE");
  assert.deepEqual(gone.json.tags.map((d) => d.name), ["priority", "Area"]);

  // A note saved here keeps the list.
  const saved = await browser(`/api/web/doc?path=${encodeURIComponent("tag-list/kept.md")}`, { method: "PUT", cookie: WEB, body: { md: { text: "# Kept\n", ifRev: null } } });
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(stored().map((d) => d.name), ["priority", "Area"]);
  assert.equal((await browser("/api/web/folder?path=tag-list", { method: "DELETE", cookie: WEB })).status, 200);
  await macTags(before ?? []);
});

await test("web: publishing from a browser is the same entry in the public map — an address answers at once, the home page is chosen from Library, and `app` is no page's address", async () => {
  const space = (await browser("/api/spaces/private", { method: "PUT", cookie: WEB })).json.space.id;
  const put = (path, text, extra = "") =>
    browser(`/api/web/doc?path=${encodeURIComponent(path)}${extra}`, { method: "PUT", cookie: WEB, body: { md: { text, ifRev: null } } });
  const publish = (body) => browser("/api/web/pages", { method: "PUT", cookie: WEB, body });
  const stop = (slug) => browser(`/api/web/pages?slug=${slug}`, { method: "DELETE", cookie: WEB });
  const home = (slug) => browser("/api/web/home", { method: "PUT", cookie: WEB, body: { slug } });
  const visit = (path) => call(path, { device: null });
  const wasHome = Object.entries((await sharedManifest()).public ?? {}).find(([, e]) => e.root)?.[0] ?? null;
  assert.equal((await put("published/Handbook.md", "# Handbook\n\nFrom a browser.\n")).status, 200);
  assert.equal((await put("published/Notes/Aside.md", "# Aside\n")).status, 200);
  assert.equal((await put("Mine.md", "# Mine\n", `&space=${space}`)).status, 200);

  const page = await publish({ path: "published/Handbook.md", kind: "document", title: "The handbook" });
  assert.equal(page.status, 201);
  assert.ok(/^[a-z0-9]{8}$/.test(page.json.slug), "an address nobody chose");
  assert.equal(page.json.url, `https://notes.example.com/${page.json.slug}`);
  const shown = await visit(`/${page.json.slug}`);
  assert.equal(shown.status, 200, "it answers at once");
  assert.ok(shown.text.includes("From a browser."));
  const entry = (await sharedManifest()).public[page.json.slug];
  assert.deepEqual([entry.kind, entry.path, entry.title], ["file", "published/Handbook.md", "The handbook"]);
  assert.equal(entry.by, (await browser("/api/meta", { cookie: WEB })).json.you.memberId);

  // The page it has, at an address of its own choosing.
  const again = await publish({ path: "published/Handbook", kind: "document", slug: "Handbook" });
  assert.deepEqual([again.status, again.json.slug, again.json.created], [200, "handbook", false]);
  assert.equal((await visit(`/${page.json.slug}`)).status, 404, "the old address is given up");
  assert.equal((await visit("/handbook")).status, 200);
  const rekeyed = (await sharedManifest()).public.handbook;
  assert.deepEqual([rekeyed.title, rekeyed.at, rekeyed.by], [entry.title, entry.at, entry.by], "its title, its first date and who published it stay");

  const folder = await publish({ path: "published/Notes", kind: "folder", slug: "aside-notes" });
  assert.equal(folder.status, 201);
  assert.deepEqual(folder.json.documents, ["published/Notes/Aside"]);
  assert.equal((await visit("/aside-notes/Aside")).status, 200);

  for (const [body, status, why] of [
    [{ path: "published/Handbook.md", kind: "document", slug: "app" }, 400, "the browser version's own address"],
    [{ path: "published/Handbook.md", kind: "document", slug: "api" }, 400, "a word Doklin keeps"],
    [{ path: "published/Handbook.md", kind: "document", slug: "No" }, 400, "too short"],
    [{ path: "published/Notes/Aside.md", kind: "document", slug: "handbook" }, 409, "another page's address"],
    [{ path: "published/Nope.md", kind: "document" }, 404, "no such document"],
    [{ path: "published/Nope", kind: "folder" }, 404, "no such folder"],
    [{ path: "published/Handbook.md" }, 400, "the kind is said"],
    [{ path: "", kind: "document" }, 400, "nothing named"],
  ]) {
    assert.equal((await publish(body)).status, status, why);
  }
  const refused = await putManifest({ ...(await sharedManifest()), seq: (await sharedManifest()).seq + 1, public: { app: { kind: "dir", path: "", by: "m-1a2b3c4d", at: 1 } } });
  assert.equal(refused.status, 400, "nor may a Mac's manifest name it");
  // Nothing is published there, and nothing can be: beside a web directory
  // the address is the browser version's own page, and a path under it that
  // names none of its files is nobody's.
  const there = await visit("/app");
  if (webDir) assert.ok(there.status === 200 && there.text.includes('src="/app/gate.js"'), "the browser version's page, not a page of the workspace's");
  else assert.equal(there.status, 404);
  assert.equal((await visit("/app/handbook")).status, 404, "nor is a page under it");

  // The home page: one of the shared workspace's pages, or none.
  assert.equal((await home("handbook")).status, 200);
  assert.ok((await visit("/")).text.includes("From a browser."));
  assert.equal((await home("aside-notes")).status, 200);
  const map = (await sharedManifest()).public;
  assert.deepEqual(Object.keys(map).filter((s) => map[s].root), ["aside-notes"], "one home page: choosing another moves it");
  assert.equal((await home("nothing-here")).status, 404);
  assert.equal((await home("x")).status, 400);
  assert.equal((await home(undefined)).status, 400, "null says none; nothing said is not an answer");
  const mine = await publish({ space, path: "Mine.md", kind: "document", slug: "mine-alone" });
  assert.equal(mine.status, 201, "a page is published in the section its document is in");
  assert.equal((await visit("/mine-alone")).status, 200);
  const notShared = await home("mine-alone");
  assert.deepEqual([notShared.status, notShared.json.error], [409, "The home page is chosen from Library."]);
  assert.equal((await home(null)).status, 200);
  assert.equal(Object.values((await sharedManifest()).public).some((e) => e.root), false);

  // An owner's browser takes a page down as their Mac does, whoever published it.
  assert.equal((await publish({ path: "published/Handbook.md", kind: "document", slug: "handbook" })).status, 200);
  const listed = await browser("/api/pages", { cookie: WEB });
  assert.ok(listed.json.pages.some((p) => p.slug === "handbook" && p.shared), "every page on the domain, to an owner");
  assert.equal((await browser("/api/pages/aside-notes", { method: "DELETE", cookie: WEB })).status, 204);
  assert.equal((await visit("/aside-notes/Aside")).status, 404);
  assert.equal((await browser("/api/pages/aside-notes", { method: "DELETE", cookie: WEB })).status, 404);

  // Stopping: in whichever section of theirs holds the address.
  assert.equal((await stop("mine-alone")).status, 200);
  assert.equal((await visit("/mine-alone")).status, 404);
  assert.equal(db.value("SELECT COUNT(*) FROM addresses WHERE slug = 'mine-alone'"), 0, "the address is let go");
  assert.equal((await stop("handbook")).status, 200);
  assert.equal((await stop("aside-notes")).status, 404, "taken down already");
  assert.equal((await stop("handbook")).status, 404);
  assert.equal((await stop("x")).status, 400);
  if (wasHome) assert.equal((await home(wasHome)).status, 200);
  assert.equal((await browser("/api/web/folder?path=published", { method: "DELETE", cookie: WEB })).status, 200);
  assert.equal((await browser(`/api/web/doc?path=Mine.md&space=${space}`, { method: "DELETE", cookie: WEB })).status, 200);
});

await test("web: a browser that signs out, or is signed out, is told to drop its cookie and what it kept; one whose cookie is nobody's, only the cookie", async () => {
  const typed = await codeFor("WEB00000000000000003", OWNER);
  const second = await browser("/api/web/session", { method: "POST", body: { code: typed, deviceId: "d-browser-2", deviceName: "Edge" } });
  const other = cookieOf(second);

  // An owner signs the first one out from a Mac, as they would any device.
  assert.equal((await call(`/api/auth/devices/${WEB_TOKEN_ID}`, { method: "DELETE", token: OWNER })).status, 204);
  const removed = await browser("/api/poll", { cookie: WEB });
  assert.equal(removed.status, 401);
  assert.equal(removed.json.removed, true, "what a Mac hears, and deletes its copy for");
  assert.equal(removed.headers.get("set-cookie"), COOKIE_GONE);
  assert.equal(removed.headers.get("clear-site-data"), '"cache", "storage"', "a browser's copy is what it cached and what it remembered");
  assert.equal((await call("/api/poll", { token: WEB })).headers.get("set-cookie"), null, "said to a browser only");

  // The second signs itself out.
  const out = await browser("/api/auth/session", { method: "DELETE", cookie: other, device: "d-browser-2" });
  assert.equal(out.status, 204);
  assert.equal(out.headers.get("set-cookie"), COOKIE_GONE);
  assert.equal(out.headers.get("clear-site-data"), '"cache", "storage"');
  assert.equal(db.value("SELECT COUNT(*) FROM tokens WHERE id = ?", second.json.tokenId), 0);
  const after = await browser("/api/poll", { cookie: other });
  assert.deepEqual([after.status, after.json.removed], [401, undefined], "it left: nobody took its access away");
  assert.equal(after.headers.get("set-cookie"), COOKIE_GONE);
  assert.equal(after.headers.get("clear-site-data"), null);
  const spare = await call("/api/auth/join", {
    method: "POST",
    body: { code: await codeFor("WEB00000000000000004", OWNER), deviceId: "d-spare", deviceName: "A spare Mac" },
  });
  assert.ok(/^[a-f0-9]{64}$/.test(spare.json.token), "the same code, joined as a Mac: a bearer, with nothing in front");
  const mac = await call("/api/auth/session", { method: "DELETE", token: spare.json.token });
  assert.deepEqual([mac.status, mac.headers.get("set-cookie"), mac.headers.get("clear-site-data")], [204, null, null], "a Mac ending its sign-in is told nothing of the kind");
});

await test("wipe: the superadmin's, confirmed, empties the bucket and frees the domain for a new binding", async () => {
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
  // Every space is the domain's too: a folder nobody is left in, people's Privates, the addresses.
  for (const table of ["spaces", "space_members", "addresses"]) {
    assert.ok(db.value(`SELECT COUNT(*) FROM ${table}`) > 0, `${table} holds something to wipe`);
  }
  assert.ok([...fake.store.keys()].some((k) => k.startsWith("spaces/")), "and what they stored is in the bucket");
  // The plan and today's spend are the Cloudflare account's, not the workspace's.
  assert.equal((await call("/api/settings/plan", { method: "PUT", token: OWNER, body: { plan: "paid" } })).status, 200);
  await call("/api/poll", { token: OWNER, headers: { "x-doklin-used": "4321" } });
  const spent = db.value("SELECT SUM(requests) FROM usage");
  assert.ok(spent >= 4321);

  const res = await call("/api/admin/wipe", { method: "POST", token: OWNER, body: { confirm: "wipe" } });
  assert.equal(res.status, 200);
  assert.equal(res.json.remaining, false);
  assert.ok(res.json.purged > 0);
  assert.equal(fake.store.size, 0, "the bucket is completely empty — the version store included");

  // Every person the domain knew goes with it, the superadmin and the device
  // that asked included.
  assert.equal(db.value("SELECT COUNT(*) FROM members"), 0, "nobody is left");
  assert.equal(db.value("SELECT COUNT(*) FROM tokens"), 0);
  assert.equal(db.value("SELECT COUNT(*) FROM invites"), 0);
  assert.equal(db.value("SELECT COUNT(*) FROM presence"), 0, "and nobody is here");
  assert.equal(db.value("SELECT COUNT(*) FROM leases"), 0, "…or holding anything");
  // A wiped domain refuses everybody's token and has taken nobody's away:
  // Alice's Mac stops syncing and keeps its copy, so it is a bare 401.
  assert.equal(db.value("SELECT COUNT(*) FROM removed_tokens"), 0);
  assert.equal(db.value("SELECT COUNT(*) FROM superadmin"), 0);
  for (const token of [MEMBER, OWNER]) {
    const stranded = await call("/api/meta", { token });
    assert.equal(stranded.status, 401);
    assert.deepEqual(stranded.json, { error: "unauthorized" });
  }
  // The keys traded here stay spent: the one the domain was set up with
  // cannot set it up again. A fresh one, put on the account, is the way in.
  assert.equal(db.value("SELECT COUNT(*) FROM spent_keys WHERE hash = ?", sha256(KEY)), 1);
  // So do the plan the account is on and what it has spent today: the next
  // workspace on this domain is on the same account, on the same day.
  assert.equal(db.value("SELECT value FROM settings WHERE key = 'plan'"), "paid");
  assert.equal(db.value("SELECT SUM(requests) FROM usage"), spent);
  assert.equal((await recover(KEY, { email: "sherin@example.com" })).json.code, "key_spent");
  env.OWNER_TOKEN = "a-fresh-key";
  const fresh = await recover("a-fresh-key", { email: "sherin@example.com", name: "Sherin" });
  assert.equal(fresh.status, 201);
  OWNER = fresh.json.token;
  // Agents go the same way, and the mirror of a workspace that is gone with them.
  for (const table of ["agents", "agent_tokens", "agent_codes", "search_text", "search_state"]) {
    assert.equal(db.value(`SELECT COUNT(*) FROM ${table}`), 0, `${table} is empty`);
  }
  // And no space outlives the workspace it was in.
  for (const table of ["spaces", "space_members", "addresses"]) {
    assert.equal(db.value(`SELECT COUNT(*) FROM ${table}`), 0, `${table} is empty`);
  }
  assert.equal((await call("/api/spaces", { token: OWNER })).status, 200);
  assert.deepEqual((await call("/api/spaces", { token: OWNER })).json.spaces, []);
  assert.equal((await as(doomed)("/api/agent/me")).status, 401, "an agent's token died with its row");
  assert.equal((await loginWith(agentCode(unusedBody))).status, 401, "and so did the code somebody was still holding");
  assert.deepEqual((await call("/api/auth/agents", { token: OWNER })).json.agents, [], "a rebound domain inherits no ghost agents");
  assert.deepEqual(
    (await call("/api/auth/members", { token: OWNER })).json.members.map((m) => [m.email, m.role, m.devices]),
    [["sherin@example.com", "superadmin", 1]],
    "nobody but who just came in",
  );
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
  assert.equal(rebound.json.createdBy.deviceName, "Sherin", "a nameless device is named for its person");
  const landing = await call("/", { device: null });
  assert.ok(landing.text.includes("<h1>Sherin&#39;s &lt;Notes&gt;</h1>"), "the name is escaped on the landing page");
  assert.ok(landing.text.includes("<title>Sherin&#39;s &lt;Notes&gt; · Doklin</title>"));
});

/* ---------- Clients older than the release marked mandatory, and tabs of another release ---------- */

/** The release this worker and its browser version are built from: package.json's. */
const RELEASE = JSON.parse(readFileSync(path.join(workerDir, "..", "package.json"), "utf8")).version;

/** version.ts's minimums, as the worker under test was built with them. */
const shippedMinimum = (name) =>
  readFileSync(path.join(workerDir, "src", "version.ts"), "utf8").match(new RegExp(`^export const ${name} = "([^"]+)";$`, "m"))[1];

/** A plugin giving the compiled worker these minimums instead. */
const minimums = (app, ios) => ({
  name: "doklin:minimums",
  transform(code, id) {
    if (!id.endsWith(`${path.sep}src${path.sep}version.ts`)) return null;
    return code
      .replace(/^export const MINIMUM_APP = "[^"]+";$/m, `export const MINIMUM_APP = "${app}";`)
      .replace(/^export const MINIMUM_IOS = "[^"]+";$/m, `export const MINIMUM_IOS = "${ios}";`);
  },
});

/** One request to `w` as `client` says it is (null: no header). */
async function asClient(w, client, pathname = "/api/meta", init = {}) {
  const headers = client === null ? {} : { "x-doklin-client": client };
  const res = await w.fetch(new Request(`https://notes.example.com${pathname}`, { ...init, headers }), env);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // a page
  }
  return { status: res.status, body };
}

await test(
  bundlePath
    ? "clients: the bundle turns away nobody at its own minimums, and a tab of any release but its own"
    : "clients: a Mac, a doklin or an iPhone older than its minimum is refused on every route with a 410 and a sentence, and so is a browser tab of any release but the worker's; one at the minimum or newer, a build run from Xcode, a tab of this release, no header and a header nobody can read are answered",
  async () => {
    // A tab is held to the release, whatever the minimums.
    const tabs = async (w) => {
      assert.notEqual((await asClient(w, `web/${RELEASE}`)).status, 410, "a tab of this release");
      const stale = await asClient(w, "web/0.0.1", "/api/web/doc?space=&path=Home.md", { method: "PUT" });
      assert.equal(stale.status, 410, "a tab of another release");
      assert.equal(stale.body.error, `This page is from Doklin 0.0.1, and notes.example.com runs ${RELEASE} now. Reload the page to keep going.`);
      assert.equal((await asClient(w, "web/99.0.0")).status, 410, "a tab of a later release, the worker since put back");
      for (const client of ["web/", "web/dev", "web/0.1"]) assert.notEqual((await asClient(w, client)).status, 410, client);
    };
    if (bundlePath) {
      assert.notEqual((await asClient(worker, shippedMinimum("MINIMUM_APP"))).status, 410);
      assert.notEqual((await asClient(worker, `cli/${shippedMinimum("MINIMUM_APP")}`)).status, 410);
      assert.notEqual((await asClient(worker, `ios/${shippedMinimum("MINIMUM_IOS")}`)).status, 410);
      await tabs(worker);
      return;
    }
    await tabs(worker);
    const w = (await import(await compileWorker([minimums("0.1.150", "0.1.0+57")]))).default;
    const refused = async (client, pathname, init) => {
      const r = await asClient(w, client, pathname, init);
      assert.equal(r.status, 410, `${client} on ${pathname ?? "/api/meta"}`);
      return r.body.error;
    };
    const answered = async (client, pathname, init) =>
      assert.notEqual((await asClient(w, client, pathname, init)).status, 410, `${client} on ${pathname ?? "/api/meta"}`);

    assert.equal(
      await refused("0.1.149"),
      "This is Doklin 0.1.149, and notes.example.com needs 0.1.150 or newer. Update Doklin to keep working.",
    );
    assert.equal(
      await refused("cli/0.1.9"),
      "This is doklin 0.1.9, and notes.example.com needs 0.1.150 or newer. Update it: curl -fsSL https://github.com/boat-builder/doklin/releases/latest/download/install-doklin.sh | sh — or, on a Mac with the Doklin app, update the app.",
    );
    assert.equal(
      await refused("ios/0.1.0+56"),
      "This is Doklin 0.1.0 (56), and notes.example.com needs 0.1.0 (57) or newer. Update Doklin to keep working.",
    );
    assert.equal(
      await refused("ios/0.1.0"),
      "This is Doklin 0.1.0, and notes.example.com needs 0.1.0 (57) or newer. Update Doklin to keep working.",
      "an iPhone that names no build is older than any",
    );
    // Before the routes that take no bearer, and before the key.
    await refused("0.1.149", "/api/auth/join", { method: "POST" });
    await refused("cli/0.1.149", "/api/agent/login", { method: "POST" });
    await refused("0.0.9", "/api/nothing-here");

    for (const client of ["0.1.150", "0.2.0", "cli/0.1.150", "cli/1.0.0", "ios/0.1.0+57", "ios/0.1.1", "ios/0.1.0+dev"]) {
      await answered(client);
    }
    for (const client of [null, "0.0.0-test", "ios/drive", "cli/", "something else"]) await answered(client);
    assert.equal((await asClient(w, "0.0.1", "/")).status, 200, "a public page is nobody's client");

    // Once every iPhone release has a version of its own, the minimum names no build.
    const later = (await import(await compileWorker([minimums("0.0.0", "1.2.0")]))).default;
    assert.equal((await asClient(later, "ios/1.1.9+900")).status, 410);
    assert.notEqual((await asClient(later, "ios/1.2.0+1")).status, 410);
    assert.notEqual((await asClient(later, "0.0.1")).status, 410, "0.0.0 turns nobody away");
  },
);

/* ---------- Summary ---------- */

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  process.exitCode = 1;
}
