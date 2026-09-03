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
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "vite";

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

/* ---------- Fake R2 binding ---------- */

class FakeR2 {
  constructor() {
    this.store = new Map(); // key -> {bytes, etag, httpMetadata, customMetadata, uploaded}
  }

  #record(key, value, opts = {}) {
    const bytes =
      typeof value === "string"
        ? Buffer.from(value, "utf8")
        : value instanceof ArrayBuffer
          ? Buffer.from(new Uint8Array(value))
          : Buffer.from(value);
    return {
      bytes,
      etag: createHash("md5").update(bytes).update(key).digest("hex"),
      httpMetadata: opts.httpMetadata ?? {},
      customMetadata: opts.customMetadata ?? {},
      uploaded: new Date(),
    };
  }

  #object(key, rec) {
    return {
      key,
      etag: rec.etag,
      httpEtag: `"${rec.etag}"`,
      size: rec.bytes.length,
      uploaded: rec.uploaded,
      httpMetadata: rec.httpMetadata,
      customMetadata: rec.customMetadata,
      body: new Uint8Array(rec.bytes),
      json: async () => JSON.parse(rec.bytes.toString("utf8")),
      text: async () => rec.bytes.toString("utf8"),
      arrayBuffer: async () =>
        rec.bytes.buffer.slice(rec.bytes.byteOffset, rec.bytes.byteOffset + rec.bytes.length),
    };
  }

  async put(key, value, opts = {}) {
    const cond = opts.onlyIf;
    if (cond?.etagMatches !== undefined) {
      const existing = this.store.get(key);
      if (!existing || existing.etag !== cond.etagMatches) return null;
    }
    // If-None-Match: "*" — create only when the object is absent.
    if (cond?.etagDoesNotMatch === "*" && this.store.has(key)) return null;
    const rec = this.#record(key, value, opts);
    this.store.set(key, rec);
    return this.#object(key, rec);
  }

  async get(key) {
    const rec = this.store.get(key);
    return rec ? this.#object(key, rec) : null;
  }

  async head(key) {
    const rec = this.store.get(key);
    if (!rec) return null;
    const { body, json, text, arrayBuffer, ...meta } = this.#object(key, rec);
    return meta;
  }

  async delete(keys) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.store.delete(k);
  }

  async list({ prefix = "", cursor, delimiter, limit = 1000 } = {}) {
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort();
    if (delimiter) {
      const delimitedPrefixes = [];
      const objects = [];
      for (const k of keys) {
        const rest = k.slice(prefix.length);
        const idx = rest.indexOf(delimiter);
        if (idx >= 0) {
          const p = prefix + rest.slice(0, idx + 1);
          if (!delimitedPrefixes.includes(p)) delimitedPrefixes.push(p);
        } else {
          objects.push(this.#object(k, this.store.get(k)));
        }
      }
      return { objects, delimitedPrefixes, truncated: false };
    }
    const start = cursor ? Number(cursor) : 0;
    const page = keys.slice(start, start + limit);
    const truncated = start + limit < keys.length;
    return {
      objects: page.map((k) => this.#object(k, this.store.get(k))),
      truncated,
      cursor: truncated ? String(start + limit) : undefined,
      delimitedPrefixes: [],
    };
  }
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
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // html or empty responses are fine
  }
  return { status: res.status, headers: res.headers, text, json };
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
  assert.equal((await call("/api/history/f-doc1", { method: "DELETE", token: OWNER })).status, 405);
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

await test(`public: the landing page, robots, icons, the mermaid asset (${bundlePath ? "served from the bundle" : "503 unbundled"}); anything else is a 404 page`, async () => {
  const root = await call("/", { device: null });
  assert.equal(root.status, 200);
  assert.match(root.headers.get("content-type"), /text\/html/);
  assert.ok(root.text.includes("<h1>Notes</h1>"), "the workspace's name");
  assert.ok(root.text.includes('<meta name="robots" content="noindex">'));
  assert.ok(root.text.includes("releases/latest/download/Doklin-macos-arm64.dmg"), "the download button");
  assert.equal((await call("/", { method: "HEAD", device: null })).status, 200);

  const robots = await call("/robots.txt", { device: null });
  assert.equal(robots.status, 200);
  assert.match(robots.text, /User-agent: \*/);
  const ico = await call("/favicon.ico", { device: null });
  assert.equal(ico.status, 200);
  assert.equal(ico.headers.get("content-type"), "image/x-icon");
  assert.match(ico.headers.get("cache-control"), /immutable/);
  assert.equal((await call("/apple-touch-icon.png", { device: null })).headers.get("content-type"), "image/png");

  const mermaid = await call("/__web/abc123/mermaid.js", { device: null });
  if (bundlePath) {
    assert.equal(mermaid.status, 200, "the bundle carries the mermaid module");
    assert.match(mermaid.headers.get("content-type"), /javascript/);
    assert.match(mermaid.headers.get("cache-control"), /immutable/);
    assert.match(mermaid.headers.get("etag"), /^"[0-9a-f]{12}"$/, "the build's content tag");
    assert.ok(mermaid.text.includes("mermaidThemeVariables"), "with the app's palette derivation");
  } else {
    assert.equal(mermaid.status, 503, "this compile carries no assets; the bundle script splices them in");
  }

  for (const p of ["/k7m2p9qx", "/roadmap", "/roadmap/plan", "/k7m2p9qx/raw", "/nope", "/__web/x/app.js"]) {
    const res = await call(p, { device: null });
    assert.equal(res.status, 404, p);
    assert.ok(res.text.includes("Nothing here"), p);
    assert.ok(res.text.includes('content="noindex"'), p);
  }
  assert.equal((await call("/", { method: "POST", device: null, body: "x" })).status, 405);
  assert.equal((await call("/k7m2p9qx", { method: "PUT", device: null, body: "x" })).status, 405);

  const unknownApi = await call("/api/nope", { token: OWNER });
  assert.equal(unknownApi.status, 404);
  assert.equal(unknownApi.json.error, "not found");
  assert.equal((await call("/api/meta", { method: "POST", token: OWNER, body: {} })).status, 405);
  assert.equal((await call("/api/nope")).status, 401, "auth comes before routing");
});

// Destroys all state — keep this last.
await test("wipe: owner-only, confirmed, empties the bucket and frees the domain for a new binding", async () => {
  const member = await call("/api/admin/wipe", { method: "POST", token: MEMBER, body: { confirm: "wipe" } });
  assert.equal(member.status, 403);
  assert.equal((await call("/api/admin/wipe", { method: "POST", token: OWNER, body: {} })).status, 400);
  assert.equal((await call("/api/admin/wipe", { token: OWNER })).status, 405);
  assert.ok(fake.store.size > 0, "there is data to wipe");

  const res = await call("/api/admin/wipe", { method: "POST", token: OWNER, body: { confirm: "wipe" } });
  assert.equal(res.status, 200);
  assert.equal(res.json.remaining, false);
  assert.ok(res.json.purged > 0);
  assert.equal(fake.store.size, 0, "the bucket is completely empty");

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
