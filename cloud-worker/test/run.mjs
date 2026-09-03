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
import { gzipSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "vite";
import { FakeCache, FakeR2 } from "./fake-r2.mjs";
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
if (bundlePath) {
  ({ default: worker } = await import(pathToFileURL(path.resolve(bundlePath)).href));
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
  ({ default: worker } = await import(`data:text/javascript,${encodeURIComponent(chunk.code)}`));
}

/* ---------- Harness ---------- */

const OWNER = "owner-secret-token";
const MEMBER = "member-secret-token";
const DEVICE = "d-macbook";
const OTHER_DEVICE = "d-imac";
const fake = new FakeR2();
const env = { OWNER_TOKEN: OWNER, DATA: fake };

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const blobHash = (content) => sha256(content).slice(0, 16);

// A member's token, planted the way an invite will mint it: the route that
// mints them is not built yet, the lookup that resolves them is.
await fake.put(
  `auth/tokens/${sha256(MEMBER)}.json`,
  JSON.stringify({ id: "t-alice", name: "Alice", role: "member", createdAt: "2026-01-01T00:00:00Z" }),
);

async function call(path, { method = "GET", token, device = DEVICE, body, headers = {} } = {}) {
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
  const res = await worker.fetch(new Request(`https://notes.example.com${path}`, init), env);
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
  version: 2,
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
  by: "Sherin's MacBook Pro",
  hist: [],
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
  assert.equal(ok.json.workspace, null, "a fresh domain holds nothing");
  assert.equal((await call("/api/meta", { token: MEMBER })).status, 200);
});

await test("unbound: poll, manifest and workspace are 404 until a workspace is bound", async () => {
  for (const p of ["/api/poll", "/api/manifest", "/api/workspace"]) {
    const res = await call(p, { token: OWNER });
    assert.equal(res.status, 404, p);
    assert.equal(res.json.error, "not bound", p);
  }
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

await test("workspace: GET describes the binding with what the manifest holds", async () => {
  const res = await call("/api/workspace", { token: MEMBER });
  assert.equal(res.status, 200);
  assert.equal(res.json.id, ws.id);
  assert.equal(res.json.name, "Notes");
  assert.equal(res.json.createdBy.deviceId, DEVICE);
  assert.deepEqual([res.json.files, res.json.bytes], [0, 0]);
  assert.equal((await call("/api/workspace", { method: "PUT", token: OWNER })).status, 405);
});

await test("manifest: the empty v2 manifest, 304 on since, CAS PUT, a stale PUT loses with the current etag", async () => {
  const first = await call("/api/manifest", { token: OWNER });
  assert.equal(first.status, 200);
  const etag0 = first.headers.get("x-manifest-etag");
  assert.equal(etag0, ws.manifestEtag, "the etag the bind returned is the manifest's");
  const fresh = JSON.parse(first.text);
  assert.equal(fresh.version, 2);
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

await test("manifest: validation rejects traversal, duplicate paths, bad revs and hashes, oversized hist, bad tombstones", async () => {
  const etag = await currentEtag();
  const bad = [
    [manifest(3, { "f-evil": fileEntry("../evil.md", 1, "x") }), /path/],
    [manifest(3, { "f-a": fileEntry("Same.md", 1, "a"), "f-b": fileEntry("same.md", 1, "b") }), /duplicate/],
    [manifest(3, { "f-a": { ...fileEntry("ok.md", 1, "a"), rev: 0 } }), /rev/],
    [manifest(3, { "f-a": { ...fileEntry("ok.md", 1, "a"), hash: "ZZZ" } }), /hash/],
    [manifest(3, { "f-a": { ...fileEntry("ok.md", 1, "a"), size: -1 } }), /size/],
    [manifest(3, { "f-a": { ...fileEntry("ok.md", 1, "a"), hist: [{ r: "one" }] } }), /hist/],
    [
      manifest(3, {
        "f-a": {
          ...fileEntry("ok.md", 1, "a"),
          hist: Array.from({ length: 13 }, (_, i) => ({ r: i + 1, h: blobHash(`h${i}`), s: 1, t: 1 })),
        },
      }),
      /hist/,
    ],
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

await test("manifest: a newer schema is 426 (update the worker), an older one plain 400", async () => {
  const newer = await putManifest(manifest(3, {}, { version: 3 }));
  assert.equal(newer.status, 426);
  assert.match(newer.json.error, /update the worker/);
  const older = await putManifest(manifest(3, {}, { version: 1 }));
  assert.equal(older.status, 400);
  assert.equal((await putManifest(manifest(3, {}, { version: "2" }))).status, 400);
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

await test("history: archive round-trip, validation, 404 when there is none", async () => {
  assert.equal((await call("/api/history/f-doc1", { token: OWNER })).status, 404);
  const entries = [{ r: 1, h: "a".repeat(16), s: 10, t: 1700000000000, b: "Sherin's MacBook Pro" }];
  const put = await call("/api/history/f-doc1", { method: "PUT", token: OWNER, body: { version: 1, entries } });
  assert.equal(put.status, 200);
  assert.equal(put.json.entries, 1);
  const got = await call("/api/history/f-doc1", { token: MEMBER });
  assert.equal(got.status, 200);
  assert.deepEqual(JSON.parse(got.text).entries, entries);

  const bad = await call("/api/history/f-doc1", { method: "PUT", token: OWNER, body: { version: 1, entries: [{ r: "one" }] } });
  assert.equal(bad.status, 400);
  const wrongVersion = await call("/api/history/f-doc1", { method: "PUT", token: OWNER, body: { version: 2, entries } });
  assert.equal(wrongVersion.status, 400);
  // Phase 6 of versioning drops these archives; deleting one that is already
  // gone is the same success, so a sweep never has to look first.
  assert.equal((await call("/api/history/f-doc1", { method: "DELETE", token: OWNER })).status, 204);
  assert.equal((await call("/api/history/f-doc1", { token: OWNER })).status, 404);
  assert.equal((await call("/api/history/f-doc1", { method: "DELETE", token: MEMBER })).status, 204);
});

/* ---------- The version store (docs/versioning.md §6.4) ---------- */

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

await test("presence: the device header names the device; beats upsert, silence prunes, DELETE leaves; the poll carries it", async () => {
  const anonymous = await call("/api/presence", { method: "PUT", token: OWNER, device: null, body: { path: "Home.md" } });
  assert.equal(anonymous.status, 400);
  const badPath = await call("/api/presence", { method: "PUT", token: OWNER, body: { path: "../x" } });
  assert.equal(badPath.status, 400);

  const beat = await call("/api/presence", { method: "PUT", token: OWNER, body: { name: "Sherin's MacBook Pro", path: "Projects/plan.md" } });
  assert.equal(beat.status, 200);
  assert.equal(beat.json.presence[DEVICE].path, "Projects/plan.md");
  assert.equal(beat.json.presence[DEVICE].name, "Sherin's MacBook Pro");
  assert.ok(Date.now() - beat.json.presence[DEVICE].ts < 5000);

  // Alice is here but not editing anything: present, no path.
  const idle = await call("/api/presence", { method: "PUT", token: MEMBER, device: OTHER_DEVICE, body: { path: null } });
  assert.equal(idle.status, 200);
  assert.equal(idle.json.presence[OTHER_DEVICE].name, "Alice", "the token's name when the beat carries none");
  assert.equal(idle.json.presence[OTHER_DEVICE].path, undefined);
  assert.ok(idle.json.presence[DEVICE], "the other device's entry survives a beat");

  // Plant a stale entry directly; the next beat sweeps it out.
  const stored = await (await fake.get("presence.json")).json();
  stored.devices["d-ghost"] = { name: "Ghost", path: "Old.md", ts: Date.now() - 10 * 60 * 1000 };
  await fake.put("presence.json", JSON.stringify(stored));
  const beat2 = await call("/api/presence", { method: "PUT", token: OWNER, body: { path: "Home.md" } });
  assert.ok(!beat2.json.presence["d-ghost"], "stale presence pruned");
  assert.equal(beat2.json.presence[DEVICE].path, "Home.md");

  const poll = await call("/api/poll", { token: MEMBER });
  assert.equal(poll.status, 200);
  assert.equal(poll.json.manifestEtag, await currentEtag());
  assert.ok(poll.json.presence[DEVICE] && poll.json.presence[OTHER_DEVICE]);

  const leave = await call("/api/presence", { method: "DELETE", token: MEMBER, device: OTHER_DEVICE });
  assert.equal(leave.status, 200);
  assert.ok(!leave.json.presence[OTHER_DEVICE]);
  assert.ok(leave.json.presence[DEVICE]);
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
  assert.ok(page.text.includes('<span class="dk-board-kind">Board</span>') && page.text.includes('<span class="dk-board-kind">Table</span>'));
  assert.ok(page.text.includes('<span class="dk-board-name">Roadmap</span>'));
  assert.ok(
    page.text.includes('<span class="dk-col-dot dk-color-blue"></span><span class="dk-col-name">In progress</span><span class="dk-col-count">1</span>'),
    "a column with its option's colour and its count",
  );
  assert.ok(page.text.includes('<span class="dk-col-name">Done</span>'));
  assert.ok(
    page.text.includes('<a class="dk-card-title" href="/projects/Roadmap/Ship%20the%20boat">Ship the boat</a>'),
    "a card inside the published folder links to its nested page, not its own slug",
  );
  assert.ok(page.text.includes('<a class="dk-card-title" href="/projects/Roadmap/Paint%20it">Paint it</a>'));
  assert.ok(page.text.includes('<span class="dk-chip dk-color-green">Ada</span>'), "a chip takes the option's colour");
  assert.ok(page.text.includes('<span class="dk-chip dk-color-red">paint</span>'));
  assert.ok(page.text.includes('<span class="dk-board-sub">3 cards</span>'));
  assert.ok(page.text.includes('<th class="dk-th">Status</th>') && page.text.includes('<th class="dk-th">Owner</th>'));
  assert.ok(page.text.includes('<a class="dk-row-title" href="/projects/Roadmap/Launch">Launch</a>'));
  assert.ok(page.text.includes("Everything after the board is ordinary prose."));

  // The same kind of store from outside any published folder: its cards have no
  // page, so they are titles, not dead links.
  const ideas = await pub("/ideas");
  assert.equal(ideas.status, 200);
  assert.ok(ideas.text.includes('<span class="dk-card-title">Teleporter</span>'), "not a link");
  assert.ok(ideas.text.includes('<span class="dk-col-dot dk-color-yellow"></span><span class="dk-col-name">New</span>'));
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

// Destroys all state — keep this last.
await test("wipe: owner-only, confirmed, empties the bucket and frees the domain for a new binding", async () => {
  const member = await call("/api/admin/wipe", { method: "POST", token: MEMBER, body: { confirm: "wipe" } });
  assert.equal(member.status, 403);
  assert.equal((await call("/api/admin/wipe", { method: "POST", token: OWNER, body: {} })).status, 400);
  assert.equal((await call("/api/admin/wipe", { token: OWNER })).status, 405);
  assert.ok(fake.store.size > 0, "there is data to wipe");
  assert.ok([...fake.store.keys()].some((k) => k.startsWith("versions/")), "the version store is in the bucket");

  const res = await call("/api/admin/wipe", { method: "POST", token: OWNER, body: { confirm: "wipe" } });
  assert.equal(res.status, 200);
  assert.equal(res.json.remaining, false);
  assert.ok(res.json.purged > 0);
  assert.equal(fake.store.size, 0, "the bucket is completely empty — the version store included");

  // The member's token died with the bucket; the owner secret lives in the
  // worker's env, so the owner can still talk to the (now free) domain.
  assert.equal((await call("/api/meta", { token: MEMBER })).status, 401);
  const meta = await call("/api/meta", { token: OWNER });
  assert.equal(meta.status, 200);
  assert.equal(meta.json.workspace, null, "the domain is free");
  assert.equal((await call("/api/manifest", { token: OWNER })).status, 404);

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
  const landing = await call("/", { device: null });
  assert.ok(landing.text.includes("<h1>Sherin&#39;s &lt;Notes&gt;</h1>"), "the name is escaped on the landing page");
  assert.ok(landing.text.includes("<title>Sherin&#39;s &lt;Notes&gt; · Doklin</title>"));
});

/* ---------- Summary ---------- */

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  process.exitCode = 1;
}
