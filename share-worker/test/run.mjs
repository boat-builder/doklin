// Smoke tests for the share worker — plain node, zero dependencies:
//
//   node share-worker/test/run.mjs
//
// The worker only touches R2 through the binding interface, so a small
// in-memory fake (etags, conditional puts, delimited lists) is enough to
// exercise every route, including the CAS races the sync protocol depends on.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import worker from "../src/index.js";

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

  async list({ prefix = "", cursor, delimiter, limit = 1000, include } = {}) {
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
const fake = new FakeR2();
const env = { SHARE_TOKEN: OWNER, PAGES: fake };

let ipCounter = 0;
const freshIp = () => `10.0.0.${(ipCounter += 1)}`;

async function call(path, { method = "GET", token, body, headers = {}, ip } = {}) {
  const init = { method, headers: { ...headers } };
  if (token) init.headers.authorization = `Bearer ${token}`;
  if (ip) init.headers["cf-connecting-ip"] = ip;
  if (body !== undefined) {
    if (typeof body === "string" || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      init.body = body;
    } else {
      init.body = JSON.stringify(body);
      init.headers["content-type"] ??= "application/json";
    }
  }
  const res = await worker.fetch(new Request(`https://docs.test${path}`, init), env);
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

const validManifest = (seq, files, extra = {}) => ({
  version: 1,
  name: "Docs",
  seq,
  files,
  tombstones: {},
  ...extra,
});
const fileEntry = (path, rev, hashSeed) => ({
  path,
  rev,
  hash: createHash("sha256").update(hashSeed).digest("hex").slice(0, 16),
  size: 42,
  mtime: 1700000000000,
  by: "d-test",
  hist: [],
});

/* ---------- Tests ---------- */

let ws; // workspace id shared by most tests
let alice; // member token scoped to ws
let bob; // second member token

await test("auth: /api/meta rejects missing and bad tokens, accepts owner", async () => {
  assert.equal((await call("/api/meta")).status, 401);
  assert.equal((await call("/api/meta", { token: "nope" })).status, 401);
  const ok = await call("/api/meta", { token: OWNER });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.version, 16);
  assert.ok(ok.json.features.includes("sync"));
  assert.ok(ok.json.features.includes("auth"));
  assert.ok(ok.json.features.includes("workspace-pages"));
  assert.ok(ok.json.features.includes("wipe"));
  assert.ok(ok.json.features.includes("page-access"));
  assert.ok(ok.json.features.includes("access-roles"));
  assert.ok(ok.json.features.includes("web-comments"));
  assert.ok(ok.json.features.includes("web-edit"));
  assert.ok(ok.json.features.includes("html-comments"));
  assert.ok(ok.json.features.includes("web-app"));
});

await test("auth: whoami reflects the owner", async () => {
  const res = await call("/api/auth/whoami", { token: OWNER });
  assert.equal(res.status, 200);
  assert.deepEqual(
    { role: res.json.role, workspaces: res.json.workspaces },
    { role: "owner", workspaces: "*" },
  );
});

await test("workspaces: owner creates, duplicate id rejected, list shows it", async () => {
  const made = await call("/api/sync/workspaces", {
    method: "POST",
    token: OWNER,
    body: { name: "Product docs" },
  });
  assert.equal(made.status, 200);
  assert.ok(made.json.id.startsWith("ws-"));
  assert.ok(made.json.manifestEtag);
  ws = made.json.id;

  const dup = await call("/api/sync/workspaces", {
    method: "POST",
    token: OWNER,
    body: { id: ws, name: "Again" },
  });
  assert.equal(dup.status, 409);

  const list = await call("/api/sync/workspaces", { token: OWNER });
  assert.equal(list.status, 200);
  assert.ok(list.json.workspaces.some((w) => w.id === ws && w.name === "Product docs"));
});

await test("manifest: fresh GET, CAS PUT, 304 poll, stale PUT loses", async () => {
  const first = await call(`/api/sync/${ws}/manifest`, { token: OWNER });
  assert.equal(first.status, 200);
  const etag0 = first.headers.get("x-manifest-etag");
  assert.ok(etag0);
  assert.deepEqual(JSON.parse(first.text).files, {});

  const put1 = await call(`/api/sync/${ws}/manifest`, {
    method: "PUT",
    token: OWNER,
    headers: { "x-base-etag": etag0 },
    body: validManifest(1, { "f-doc1": fileEntry("notes/hello.md", 1, "v1") }),
  });
  assert.equal(put1.status, 200);
  const etag1 = put1.json.etag;
  assert.ok(etag1 && etag1 !== etag0);

  const cached = await call(`/api/sync/${ws}/manifest?since=${etag1}`, { token: OWNER });
  assert.equal(cached.status, 304);

  const stale = await call(`/api/sync/${ws}/manifest`, {
    method: "PUT",
    token: OWNER,
    headers: { "x-base-etag": etag0 },
    body: validManifest(2, { "f-doc1": fileEntry("notes/hello.md", 2, "v2") }),
  });
  assert.equal(stale.status, 412);
  assert.equal(stale.json.etag, etag1);

  const noBase = await call(`/api/sync/${ws}/manifest`, {
    method: "PUT",
    token: OWNER,
    body: validManifest(2, {}),
  });
  assert.equal(noBase.status, 428);
});

await test("manifest: validation rejects traversal, dup paths, bad revs", async () => {
  const etag = (await call(`/api/sync/${ws}/manifest`, { token: OWNER })).headers.get(
    "x-manifest-etag",
  );
  const cases = [
    validManifest(3, { "f-evil": fileEntry("../evil.md", 1, "x") }),
    validManifest(3, {
      "f-a": fileEntry("same.md", 1, "a"),
      "f-b": fileEntry("Same.md", 1, "b"), // case-insensitive duplicate
    }),
    validManifest(3, { "f-a": { ...fileEntry("ok.md", 1, "a"), rev: 0 } }),
    validManifest(3, { "f-a": { ...fileEntry("ok.md", 1, "a"), hash: "ZZZ" } }),
    { version: 2, seq: 1, files: {} },
  ];
  for (const body of cases) {
    const res = await call(`/api/sync/${ws}/manifest`, {
      method: "PUT",
      token: OWNER,
      headers: { "x-base-etag": etag },
      body,
    });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body).slice(0, 80)}`);
  }
});

await test("cas: interleaved writers — loser gets 412, retries from fresh state", async () => {
  const a = await call(`/api/sync/${ws}/manifest`, { token: OWNER });
  const base = a.headers.get("x-manifest-etag");
  const current = JSON.parse(a.text);

  // Writer A lands first.
  const fromA = {
    ...current,
    seq: current.seq + 1,
    files: { ...current.files, "f-a1": fileEntry("a.md", 1, "a1") },
  };
  const putA = await call(`/api/sync/${ws}/manifest`, {
    method: "PUT",
    token: OWNER,
    headers: { "x-base-etag": base },
    body: fromA,
  });
  assert.equal(putA.status, 200);

  // Writer B raced from the same base and must lose…
  const fromB = {
    ...current,
    seq: current.seq + 1,
    files: { ...current.files, "f-b1": fileEntry("b.md", 1, "b1") },
  };
  const putB = await call(`/api/sync/${ws}/manifest`, {
    method: "PUT",
    token: OWNER,
    headers: { "x-base-etag": base },
    body: fromB,
  });
  assert.equal(putB.status, 412);

  // …then re-pull, merge, and land cleanly.
  const fresh = await call(`/api/sync/${ws}/manifest?since=${base}`, { token: OWNER });
  assert.equal(fresh.status, 200);
  const merged = JSON.parse(fresh.text);
  merged.seq += 1;
  merged.files["f-b1"] = fileEntry("b.md", 1, "b1");
  const retry = await call(`/api/sync/${ws}/manifest`, {
    method: "PUT",
    token: OWNER,
    headers: { "x-base-etag": fresh.headers.get("x-manifest-etag") },
    body: merged,
  });
  assert.equal(retry.status, 200);
  const final = JSON.parse((await call(`/api/sync/${ws}/manifest`, { token: OWNER })).text);
  assert.ok(final.files["f-a1"] && final.files["f-b1"], "both writers' files survive");
});

await test("blobs: content-addressed round-trip, list, delete, caps", async () => {
  const content = "# hello\n\nsynced bytes";
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
  const put = await call(`/api/sync/${ws}/files/f-doc1/${hash}`, {
    method: "PUT",
    token: OWNER,
    headers: { "content-type": "text/markdown" },
    body: content,
  });
  assert.equal(put.status, 200);
  assert.equal(put.json.size, content.length);

  const got = await call(`/api/sync/${ws}/files/f-doc1/${hash}`, { token: OWNER });
  assert.equal(got.status, 200);
  assert.equal(got.text, content);
  assert.equal(got.headers.get("content-type"), "text/markdown");
  assert.equal(got.headers.get("cache-control"), "no-store");

  const list = await call(`/api/sync/${ws}/files/f-doc1`, { token: OWNER });
  assert.equal(list.status, 200);
  assert.ok(list.json.blobs.some((b) => b.hash === hash && b.size === content.length));

  assert.equal(
    (await call(`/api/sync/${ws}/files/f-doc1/NOTHEX`, { token: OWNER })).status,
    400,
  );
  const missing = await call(`/api/sync/${ws}/files/f-doc1/${"0".repeat(16)}`, { token: OWNER });
  assert.equal(missing.status, 404);

  const del = await call(`/api/sync/${ws}/files/f-doc1/${hash}`, {
    method: "DELETE",
    token: OWNER,
  });
  assert.equal(del.status, 200);
  assert.equal((await call(`/api/sync/${ws}/files/f-doc1/${hash}`, { token: OWNER })).status, 404);

  const tooBig = new Uint8Array(25 * 1024 * 1024 + 1);
  const rejected = await call(`/api/sync/${ws}/files/f-doc1/${"a".repeat(16)}`, {
    method: "PUT",
    token: OWNER,
    body: tooBig,
  });
  assert.equal(rejected.status, 413);
});

await test("history: archive round-trip and validation", async () => {
  const entries = [{ r: 1, h: "a".repeat(16), s: 10, t: 1700000000000, b: "d-test" }];
  const put = await call(`/api/sync/${ws}/history/f-doc1`, {
    method: "PUT",
    token: OWNER,
    body: { version: 1, entries },
  });
  assert.equal(put.status, 200);
  const got = await call(`/api/sync/${ws}/history/f-doc1`, { token: OWNER });
  assert.equal(got.status, 200);
  assert.deepEqual(JSON.parse(got.text).entries, entries);

  const bad = await call(`/api/sync/${ws}/history/f-doc1`, {
    method: "PUT",
    token: OWNER,
    body: { version: 1, entries: [{ r: "one" }] },
  });
  assert.equal(bad.status, 400);
});

await test("invites: mint → join → single use, expiry, rate limit", async () => {
  const inv = await call("/api/auth/invites", {
    method: "POST",
    token: OWNER,
    body: { name: "Alice", role: "member", workspaces: [ws] },
  });
  assert.equal(inv.status, 200);
  assert.ok(inv.json.code.startsWith("dk_i_"));
  assert.ok(inv.json.joinUrl.endsWith(`/join#${inv.json.code}`));

  const listed = await call("/api/auth/invites", { token: OWNER });
  assert.ok(listed.json.invites.some((i) => i.id === inv.json.id && i.name === "Alice"));

  const join = await call("/api/auth/join", {
    method: "POST",
    ip: freshIp(),
    body: { invite: inv.json.code, name: "Alice · MacBook" },
  });
  assert.equal(join.status, 200);
  assert.ok(join.json.token.startsWith("dk_m_"));
  assert.deepEqual(join.json.workspaces, [ws]);
  alice = join.json.token;

  const again = await call("/api/auth/join", {
    method: "POST",
    ip: freshIp(),
    body: { invite: inv.json.code },
  });
  assert.equal(again.status, 410, "an invite mints exactly one token");

  const who = await call("/api/auth/whoami", { token: alice });
  assert.equal(who.json.role, "member");
  assert.equal(who.json.name, "Alice · MacBook");

  const expired = await call("/api/auth/invites", {
    method: "POST",
    token: OWNER,
    body: { name: "Late", role: "member", workspaces: [ws], ttlMs: 1 },
  });
  await new Promise((r) => setTimeout(r, 10));
  const lateJoin = await call("/api/auth/join", {
    method: "POST",
    ip: freshIp(),
    body: { invite: expired.json.code },
  });
  assert.equal(lateJoin.status, 410);

  assert.equal(
    (await call("/api/auth/join", { method: "POST", ip: freshIp(), body: { invite: "dk_i_bogus" } }))
      .status,
    404,
  );

  const stormIp = freshIp();
  let last;
  for (let i = 0; i < 11; i += 1) {
    last = await call("/api/auth/join", {
      method: "POST",
      ip: stormIp,
      body: { invite: `dk_i_${"f".repeat(64)}` },
    });
  }
  assert.equal(last.status, 429, "11th attempt from one IP is throttled");
});

await test("members: scoped to granted workspaces, no admin surface", async () => {
  assert.equal((await call(`/api/sync/${ws}/manifest`, { token: alice })).status, 200);
  assert.equal((await call(`/api/sync/ws-elsewhere/manifest`, { token: alice })).status, 403);
  assert.equal(
    (await call("/api/sync/workspaces", { method: "POST", token: alice, body: { name: "x" } }))
      .status,
    403,
  );
  assert.equal(
    (await call("/api/site", { method: "PUT", token: alice, body: { ownerName: "Mallory" } }))
      .status,
    403,
  );
  assert.equal((await call("/api/site", { token: alice })).status, 403);
  assert.equal((await call("/api/auth/tokens", { token: alice })).status, 403);
  assert.equal(
    (await call("/api/auth/invites", { method: "POST", token: alice, body: { workspaces: [ws] } }))
      .status,
    403,
  );
  // The workspace list a member sees is exactly their grant.
  const list = await call("/api/sync/workspaces", { token: alice });
  assert.deepEqual(
    list.json.workspaces.map((w) => w.id),
    [ws],
  );
});

await test("pages: members own what they publish, owner sees all", async () => {
  const inv = await call("/api/auth/invites", {
    method: "POST",
    token: OWNER,
    body: { name: "Bob", role: "member", workspaces: [ws] },
  });
  bob = (
    await call("/api/auth/join", { method: "POST", ip: freshIp(), body: { invite: inv.json.code } })
  ).json.token;

  const made = await call("/api/pages/alice-doc", {
    method: "PUT",
    token: alice,
    body: { title: "Alice's doc", markdown: "# hers" },
  });
  assert.equal(made.status, 200);

  assert.equal(
    (
      await call("/api/pages/alice-doc", {
        method: "PUT",
        token: bob,
        body: { title: "Hijack", markdown: "# mine now" },
      })
    ).status,
    403,
  );
  assert.equal((await call("/api/pages/alice-doc", { method: "DELETE", token: bob })).status, 403);

  const aliceList = await call("/api/pages", { token: alice });
  assert.deepEqual(
    aliceList.json.pages.map((p) => p.id),
    ["alice-doc"],
  );
  const bobList = await call("/api/pages", { token: bob });
  assert.equal(bobList.json.pages.length, 0);
  const ownerList = await call("/api/pages", { token: OWNER });
  assert.ok(ownerList.json.pages.some((p) => p.id === "alice-doc"));

  // Owner updating the page doesn't steal it from Alice.
  const ownerEdit = await call("/api/pages/alice-doc", {
    method: "PUT",
    token: OWNER,
    body: { title: "Alice's doc", markdown: "# tidied" },
  });
  assert.equal(ownerEdit.status, 200);
  const aliceEdit = await call("/api/pages/alice-doc", {
    method: "PUT",
    token: alice,
    body: { title: "Alice's doc", markdown: "# hers again" },
  });
  assert.equal(aliceEdit.status, 200);

  assert.equal((await call("/api/pages/alice-doc", { method: "DELETE", token: alice })).status, 200);
});

await test("pages: workspace-stamped pages are managed by the whole workspace", async () => {
  // Carol is a member of a DIFFERENT workspace — she must stay locked out.
  const other = await call("/api/sync/workspaces", {
    method: "POST",
    token: OWNER,
    body: { name: "Elsewhere" },
  });
  const inv = await call("/api/auth/invites", {
    method: "POST",
    token: OWNER,
    body: { name: "Carol", role: "member", workspaces: [other.json.id] },
  });
  const carol = (
    await call("/api/auth/join", { method: "POST", ip: freshIp(), body: { invite: inv.json.code } })
  ).json.token;

  // Claiming a workspace you're not in is refused outright.
  assert.equal(
    (
      await call("/api/pages/team-doc", {
        method: "PUT",
        token: carol,
        body: { title: "Team doc", markdown: "# nope", ws },
      })
    ).status,
    403,
  );

  // Alice publishes a page from the synced workspace: stamped with ws.
  const made = await call("/api/pages/team-doc", {
    method: "PUT",
    token: alice,
    body: { title: "Team doc", markdown: "# v1", ws },
  });
  assert.equal(made.status, 200);

  // Bob shares the workspace, so he can keep the page fresh — even with a
  // push that omits `ws` (the stamp is sticky) — and every member sees it
  // in their listing.
  const bobEdit = await call("/api/pages/team-doc", {
    method: "PUT",
    token: bob,
    body: { title: "Team doc", markdown: "# bob's edit" },
  });
  assert.equal(bobEdit.status, 200);
  const afterBob = await call("/api/pages/team-doc", {
    method: "PUT",
    token: alice,
    body: { title: "Team doc", markdown: "# still shared", ws },
  });
  assert.equal(afterBob.status, 200, "an omitted ws must not strip the stamp");
  const bobList = await call("/api/pages", { token: bob });
  assert.ok(bobList.json.pages.some((p) => p.id === "team-doc"));

  // Carol can't touch or even list it.
  assert.equal(
    (
      await call("/api/pages/team-doc", {
        method: "PUT",
        token: carol,
        body: { title: "Hijack", markdown: "# mine" },
      })
    ).status,
    403,
  );
  const carolList = await call("/api/pages", { token: carol });
  assert.ok(!carolList.json.pages.some((p) => p.id === "team-doc"));

  // Collections stamp the same way, and a workspace member can stop a page
  // they didn't create.
  const toc = await call("/api/pages/team-toc", {
    method: "PUT",
    token: alice,
    body: { title: "Team folder", kind: "collection", items: [], ws },
  });
  assert.equal(toc.status, 200);
  assert.equal(
    (await call("/api/pages/team-toc", { method: "DELETE", token: bob })).status,
    200,
  );
  assert.equal((await call("/api/pages/team-doc", { method: "DELETE", token: bob })).status, 200);

  // A malformed ws claim is a 400, not a silent unstamped page.
  assert.equal(
    (
      await call("/api/pages/bad-ws", {
        method: "PUT",
        token: alice,
        body: { title: "x", markdown: "# x", ws: "NOT VALID" },
      })
    ).status,
    400,
  );
});

await test("manifest: share metadata validates leniently, garbage rejected", async () => {
  const head = await call(`/api/sync/${ws}/manifest`, { token: OWNER });
  const etag = head.headers.get("x-manifest-etag");
  const files = { "f-doc1": fileEntry("notes/hello.md", 9, "v9") };

  const good = await call(`/api/sync/${ws}/manifest`, {
    method: "PUT",
    token: OWNER,
    headers: { "x-base-etag": etag },
    body: {
      ...validManifest(9, files),
      // A dead share (fileId not in files) is legal: the page outlives the file.
      shares: {
        "f-doc1": { id: "team-doc", path: "notes/hello.md", cid: "team-toc", title: "Team doc", by: "Alice", at: 1 },
        "f-gone": { id: "old-page", path: "notes/old.md", title: "Old", by: "Bob", at: 1 },
      },
      collections: {
        "team-toc": { path: "", title: "Team folder", desc: "the docs", by: "Alice", at: 1 },
      },
    },
  });
  assert.equal(good.status, 200);
  const round = await call(`/api/sync/${ws}/manifest`, { token: OWNER });
  const stored = JSON.parse(round.text);
  assert.equal(stored.shares["f-doc1"].id, "team-doc");
  assert.equal(stored.collections["team-toc"].title, "Team folder");

  const etag2 = round.headers.get("x-manifest-etag");
  const bad = await call(`/api/sync/${ws}/manifest`, {
    method: "PUT",
    token: OWNER,
    headers: { "x-base-etag": etag2 },
    body: {
      ...validManifest(10, files),
      shares: { "f-doc1": { id: "../etc", path: "notes/hello.md" } },
    },
  });
  assert.equal(bad.status, 400);
});

await test("presence: heartbeats merge, stale entries pruned", async () => {
  const beat = await call(`/api/sync/${ws}/presence`, {
    method: "PUT",
    token: alice,
    body: { deviceId: "d-alice", name: "Alice", fileId: "f-doc1", path: "notes/hello.md" },
  });
  assert.equal(beat.status, 200);
  assert.equal(beat.json.presence["d-alice"].fileId, "f-doc1");

  // Plant a stale entry directly, then any fresh heartbeat sweeps it out.
  const key = `sync/${ws}/presence.json`;
  const now = (await fake.get(key)).json ? await (await fake.get(key)).json() : { devices: {} };
  now.devices["d-ghost"] = { name: "Ghost", fileId: "f-doc1", ts: Date.now() - 10 * 60 * 1000 };
  await fake.put(key, JSON.stringify(now));

  const beat2 = await call(`/api/sync/${ws}/presence`, {
    method: "PUT",
    token: OWNER,
    body: { deviceId: "d-owner", name: "Sherin", fileId: "f-doc1" },
  });
  assert.ok(beat2.json.presence["d-owner"]);
  assert.ok(!beat2.json.presence["d-ghost"], "stale presence pruned");

  const poll = await call(`/api/sync/${ws}/poll`, { token: alice });
  assert.equal(poll.status, 200);
  assert.ok(poll.json.manifestEtag);
  assert.ok(poll.json.presence["d-owner"]);

  const leave = await call(`/api/sync/${ws}/presence`, {
    method: "PUT",
    token: alice,
    body: { deviceId: "d-alice", fileId: null },
  });
  assert.ok(!leave.json.presence["d-alice"]);
});

await test("revocation: deleting a token 401s its next request", async () => {
  const tokens = await call("/api/auth/tokens", { token: OWNER });
  const bobEntry = tokens.json.tokens.find((t) => t.name === "Bob");
  assert.ok(bobEntry, "bob shows up in the token list");
  assert.ok(bobEntry.lastSeenAt, "join stamps lastSeen");

  const del = await call(`/api/auth/tokens/${bobEntry.id}`, { method: "DELETE", token: OWNER });
  assert.equal(del.status, 200);
  assert.equal((await call("/api/auth/whoami", { token: bob })).status, 401);
  assert.equal((await call(`/api/sync/${ws}/manifest`, { token: bob })).status, 401);
});

await test("workspace delete: purge and 404 afterwards", async () => {
  const made = await call("/api/sync/workspaces", {
    method: "POST",
    token: OWNER,
    body: { name: "Scratch" },
  });
  const scratch = made.json.id;
  await call(`/api/sync/${scratch}/files/f-x/${"c".repeat(16)}`, {
    method: "PUT",
    token: OWNER,
    body: "bytes",
  });
  const del = await call(`/api/sync/workspaces/${scratch}`, { method: "DELETE", token: OWNER });
  assert.equal(del.status, 200);
  assert.equal(del.json.remaining, false);
  assert.equal((await call(`/api/sync/${scratch}/manifest`, { token: OWNER })).status, 404);
});

await test("public surface: landing, /join page, private prefixes unreachable", async () => {
  const root = await call("/");
  assert.equal(root.status, 200);
  assert.ok(root.text.includes("Doklin"));
  assert.ok(root.text.includes('rel="icon"'), "pages link the favicon");

  // Brand icons are served by the worker, not a 204 placeholder.
  const favicon = await call("/favicon.ico");
  assert.equal(favicon.status, 200);
  assert.equal(favicon.headers.get("content-type"), "image/x-icon");
  const apple = await call("/apple-touch-icon.png");
  assert.equal(apple.status, 200);
  assert.equal(apple.headers.get("content-type"), "image/png");

  const join = await call("/join");
  assert.equal(join.status, 200);
  assert.ok(join.text.includes("You're invited"));
  assert.ok(join.text.includes("Connect to a shared backend"));

  // "sync" and "auth" look like page ids but must never serve private state.
  assert.equal((await call("/sync")).status, 404);
  assert.equal((await call("/auth")).status, 404);
  assert.equal((await call(`/${ws}`)).status, 404);
});

/* ---------- Visitor access codes ---------- */

// Pull the gate cookie out of a 303 unlock response, ready for a Cookie header.
const cookieOf = (res) => {
  const raw = res.headers.get("set-cookie");
  assert.ok(raw, "unlock sets a cookie");
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /SameSite=Lax/);
  assert.match(raw, /Path=\//);
  return raw.split(";")[0];
};

const unlock = (gateId, code, extra = {}) =>
  call(`/${gateId}/unlock`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `code=${encodeURIComponent(code)}${extra.next ? `&next=${encodeURIComponent(extra.next)}` : ""}`,
    ip: extra.ip ?? freshIp(),
    ...(extra.cookie ? { headers: { "content-type": "application/x-www-form-urlencoded", cookie: extra.cookie } } : {}),
  });

await test("access: codes gate every public route, nothing leaks pre-code", async () => {
  const secret = "The Launch Plan — DO NOT LEAK";
  await call("/api/pages/locked-doc", {
    method: "PUT",
    token: OWNER,
    body: { title: secret, markdown: `# ${secret}\n\nnumbers inside`, html: "<html><body>rendition-sentinel-b7</body></html>" },
  });
  await call("/api/pages/locked-doc/og", {
    method: "PUT",
    token: OWNER,
    headers: { "content-type": "image/png" },
    body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  });

  // Before protection: publicly readable.
  assert.equal((await call("/locked-doc")).status, 200);

  const added = await call("/api/pages/locked-doc/access/codes", {
    method: "POST",
    token: OWNER,
    body: { label: "Acme team", code: "Sunset-Marble-Fig" },
  });
  assert.equal(added.status, 200);
  assert.match(added.json.id, /^a-[a-f0-9]{8}$/);
  assert.equal(added.json.label, "Acme team");

  // The listing shows labels, never hashes or codes.
  const listed = await call("/api/pages/locked-doc/access", { token: OWNER });
  assert.equal(listed.status, 200);
  assert.equal(listed.json.protected, true);
  assert.deepEqual(
    listed.json.codes.map((c) => ({ id: c.id, label: c.label })),
    [{ id: added.json.id, label: "Acme team" }],
  );
  assert.ok(!listed.text.includes("hash"));

  // Page metadata + the pages list carry the protected flag.
  assert.equal((await call("/api/pages/locked-doc", { token: OWNER })).json.protected, true);
  const pageRow = (await call("/api/pages", { token: OWNER })).json.pages.find(
    (p) => p.id === "locked-doc",
  );
  assert.equal(pageRow.protected, true);

  // Every public route is a gate (or a 401) now — and the gate leaks nothing.
  for (const path of ["/locked-doc", "/locked-doc?v=md", "/locked-doc/raw"]) {
    const res = await call(path);
    assert.equal(res.status, 401, path);
    assert.ok(!res.text.includes("Launch Plan"), `${path} must not leak the title`);
    assert.ok(!res.text.includes("numbers inside"), `${path} must not leak content`);
    assert.ok(!res.text.includes("rendition-sentinel-b7"), `${path} must not leak the rendition`);
    assert.ok(res.text.includes("gate-form"), `${path} serves the gate`);
    assert.match(res.headers.get("cache-control"), /no-store/);
  }
  assert.equal((await call("/locked-doc/og.png")).status, 401);
});

await test("access: unlock — wrong code 401s, right code cookies the browser", async () => {
  const wrong = await unlock("locked-doc", "not-the-code");
  assert.equal(wrong.status, 401);
  assert.ok(wrong.text.includes("didn't match"));
  assert.equal(wrong.headers.get("set-cookie"), null);

  // Codes are case/whitespace-insensitive (normalized on both ends).
  const right = await unlock("locked-doc", "  sunset-marble-fig ", { next: "/locked-doc?v=md" });
  assert.equal(right.status, 303);
  assert.equal(right.headers.get("location"), "/locked-doc?v=md");
  const cookie = cookieOf(right);

  const page = await call("/locked-doc", { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.ok(page.text.includes("Launch Plan"));
  assert.match(page.headers.get("cache-control"), /no-store/);
  assert.equal((await call("/locked-doc/raw", { headers: { cookie } })).status, 200);
  assert.equal((await call("/locked-doc/og.png", { headers: { cookie } })).status, 200);

  // A tampered cookie is just a missing cookie.
  const forged = cookie.replace(/.$/, (c) => (c === "0" ? "1" : "0"));
  assert.equal((await call("/locked-doc", { headers: { cookie: forged } })).status, 401);

  // An open-redirect next is refused in favor of the page itself.
  const evil = await unlock("locked-doc", "sunset-marble-fig", { next: "https://evil.test/x" });
  assert.equal(evil.status, 303);
  assert.equal(evil.headers.get("location"), "/locked-doc");

  // GET /unlock (typed URL) just bounces to the page.
  assert.equal((await call("/locked-doc/unlock")).status, 303);
});

await test("access: revoking one named code kills exactly its sessions", async () => {
  const second = await call("/api/pages/locked-doc/access/codes", {
    method: "POST",
    token: OWNER,
    body: { label: "Priya", code: "quiet-harbor-lime" },
  });
  assert.equal(second.status, 200);

  // Duplicate plaintext is refused (revocation would be misleading).
  const dup = await call("/api/pages/locked-doc/access/codes", {
    method: "POST",
    token: OWNER,
    body: { label: "Copycat", code: "SUNSET-marble-fig" },
  });
  assert.equal(dup.status, 409);

  const acmeCookie = cookieOf(await unlock("locked-doc", "sunset-marble-fig"));
  const priyaCookie = cookieOf(await unlock("locked-doc", "quiet-harbor-lime"));

  const acmeId = (await call("/api/pages/locked-doc/access", { token: OWNER })).json.codes.find(
    (c) => c.label === "Acme team",
  ).id;
  const revoked = await call(`/api/pages/locked-doc/access/codes/${acmeId}`, {
    method: "DELETE",
    token: OWNER,
  });
  assert.equal(revoked.status, 200);

  // Acme's session is dead on its next request; Priya's still works, and the
  // revoked code no longer unlocks.
  assert.equal((await call("/locked-doc", { headers: { cookie: acmeCookie } })).status, 401);
  assert.equal((await call("/locked-doc", { headers: { cookie: priyaCookie } })).status, 200);
  assert.equal((await unlock("locked-doc", "sunset-marble-fig")).status, 401);
});

await test("access: content pushes can't strip or inject protection", async () => {
  // An autosave push (no access field) keeps the gate up…
  const push = await call("/api/pages/locked-doc", {
    method: "PUT",
    token: OWNER,
    body: { title: "Renamed", markdown: "# edited" },
  });
  assert.equal(push.status, 200);
  assert.equal((await call("/locked-doc")).status, 401);

  // …and a push that tries to smuggle its own access section is ignored.
  const inject = await call("/api/pages/inject-doc", {
    method: "PUT",
    token: OWNER,
    body: {
      title: "Inject",
      markdown: "# x",
      access: { codes: [{ id: "a-deadbeef", label: "evil", hash: "f".repeat(64) }] },
    },
  });
  assert.equal(inject.status, 200);
  assert.equal((await call("/inject-doc")).status, 200, "injected access must not gate");
  assert.equal(
    (await call("/api/pages/inject-doc/access", { token: OWNER })).json.protected,
    false,
  );
  await call("/api/pages/inject-doc", { method: "DELETE", token: OWNER });
});

await test("access: folder codes cover member pages, own codes win", async () => {
  await call("/api/pages/locked-folder", {
    method: "PUT",
    token: OWNER,
    body: {
      title: "Client folder",
      kind: "collection",
      items: [{ id: "member-doc", title: "Member", path: "docs/member.md" }],
    },
  });
  await call("/api/pages/member-doc", {
    method: "PUT",
    token: OWNER,
    body: {
      title: "Member",
      markdown: "# member secret",
      collection: { id: "locked-folder", title: "Client folder" },
    },
  });
  await call("/api/pages/locked-folder/access/codes", {
    method: "POST",
    token: OWNER,
    body: { label: "Client", code: "goose-canyon-mint" },
  });

  // TOC and member both gate; the member's gate posts to the FOLDER's unlock,
  // so one code entry opens everything.
  const toc = await call("/locked-folder");
  assert.equal(toc.status, 401);
  const member = await call("/member-doc");
  assert.equal(member.status, 401);
  assert.ok(member.text.includes('action="/locked-folder/unlock"'));
  assert.ok(!member.text.includes("member secret"));

  const res = await unlock("locked-folder", "goose-canyon-mint", { next: "/member-doc" });
  assert.equal(res.headers.get("location"), "/member-doc");
  const cookie = cookieOf(res);
  assert.equal((await call("/member-doc", { headers: { cookie } })).status, 200);
  assert.equal((await call("/locked-folder", { headers: { cookie } })).status, 200);

  // A member with its own codes locks tighter: the folder cookie stops working
  // for it and its gate points at its own unlock.
  await call("/api/pages/member-doc/access/codes", {
    method: "POST",
    token: OWNER,
    body: { label: "Inner circle", code: "velvet-otter-peak" },
  });
  const gated = await call("/member-doc", { headers: { cookie } });
  assert.equal(gated.status, 401);
  assert.ok(gated.text.includes('action="/member-doc/unlock"'));
  const own = cookieOf(await unlock("member-doc", "velvet-otter-peak"));
  assert.equal((await call("/member-doc", { headers: { cookie: own } })).status, 200);
});

await test("access: root-page override gates the domain root", async () => {
  await call("/api/site", {
    method: "PUT",
    token: OWNER,
    body: { rootPageId: "locked-doc" },
  });
  const root = await call("/");
  assert.equal(root.status, 401);
  assert.ok(root.text.includes("gate-form"));
  const res = await unlock("locked-doc", "quiet-harbor-lime", { next: "/" });
  assert.equal(res.headers.get("location"), "/");
  assert.equal((await call("/", { headers: { cookie: cookieOf(res) } })).status, 200);
  await call("/api/site", { method: "PUT", token: OWNER, body: {} });
});

await test("access: permissions mirror page management", async () => {
  // Alice (member) protects her own page…
  await call("/api/pages/alice-locked", {
    method: "PUT",
    token: alice,
    body: { title: "Alice's", markdown: "# hers" },
  });
  const own = await call("/api/pages/alice-locked/access/codes", {
    method: "POST",
    token: alice,
    body: { label: "Friends", code: "paper-lantern-sky" },
  });
  assert.equal(own.status, 200);

  // …but can't read or manage codes on someone else's page.
  const carolInv = await call("/api/auth/invites", {
    method: "POST",
    token: OWNER,
    body: { name: "Dana", role: "member", workspaces: [ws] },
  });
  const dana = (
    await call("/api/auth/join", {
      method: "POST",
      ip: freshIp(),
      body: { invite: carolInv.json.code },
    })
  ).json.token;
  assert.equal((await call("/api/pages/alice-locked/access", { token: dana })).status, 403);
  assert.equal(
    (
      await call("/api/pages/alice-locked/access/codes", {
        method: "POST",
        token: dana,
        body: { code: "gate-crash-attempt" },
      })
    ).status,
    403,
  );

  // The owner can manage anyone's; removing protection reopens the page.
  assert.equal((await call("/alice-locked")).status, 401);
  const cleared = await call("/api/pages/alice-locked/access", {
    method: "DELETE",
    token: OWNER,
  });
  assert.equal(cleared.status, 200);
  assert.equal((await call("/alice-locked")).status, 200);
  await call("/api/pages/alice-locked", { method: "DELETE", token: alice });
});

await test("access: unlock attempts are rate-limited per IP", async () => {
  const stormIp = freshIp();
  let last;
  for (let i = 0; i < 11; i += 1) {
    last = await unlock("locked-doc", `guess-${i}`, { ip: stormIp });
  }
  assert.equal(last.status, 429);
  assert.ok(last.text.includes("Too many attempts"));

  // Validation guardrails while we're here: short codes and overlong codes.
  assert.equal(
    (
      await call("/api/pages/locked-doc/access/codes", {
        method: "POST",
        token: OWNER,
        body: { code: "abc" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call("/api/pages/locked-doc/access/codes", {
        method: "POST",
        token: OWNER,
        body: { code: "x".repeat(200) },
      })
    ).status,
    400,
  );
  // Cleanup: unprotect + drop the shares this suite created.
  await call("/api/pages/locked-doc/access", { method: "DELETE", token: OWNER });
  assert.equal((await call("/locked-doc")).status, 200);
  for (const id of ["locked-doc", "locked-folder", "member-doc"]) {
    await call(`/api/pages/${id}`, { method: "DELETE", token: OWNER });
  }
});

/* ---------- Code roles: web comments + the web editor ---------- */

// Post a public form (comments, edits) the way a browser would.
const postForm = (path, fields, { cookie, ip } = {}) =>
  call(path, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie } : {}),
    },
    body: Object.entries(fields)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&"),
    ip: ip ?? freshIp(),
  });

let viewCookie;
let commentCookie;
let editCookie;
let commenterId; // the comment-role code's id

await test("roles: codes carry view/comment/edit, PATCH changes them", async () => {
  await call("/api/pages/team-page", {
    method: "PUT",
    token: OWNER,
    body: { title: "Team page", markdown: "# Team page\n\nshared body" },
  });

  const viewer = await call("/api/pages/team-page/access/codes", {
    method: "POST",
    token: OWNER,
    body: { label: "Viewer", code: "viewer-code-one" },
  });
  assert.equal(viewer.status, 200);
  assert.equal(viewer.json.role, "view", "role defaults to view");

  const commenter = await call("/api/pages/team-page/access/codes", {
    method: "POST",
    token: OWNER,
    body: { label: "Priya", code: "comment-code-one", role: "comment" },
  });
  assert.equal(commenter.status, 200);
  assert.equal(commenter.json.role, "comment");
  commenterId = commenter.json.id;

  const editor = await call("/api/pages/team-page/access/codes", {
    method: "POST",
    token: OWNER,
    body: { label: "Sam", code: "edit-code-one", role: "edit" },
  });
  assert.equal(editor.json.role, "edit");

  assert.equal(
    (
      await call("/api/pages/team-page/access/codes", {
        method: "POST",
        token: OWNER,
        body: { label: "Bad", code: "bad-role-code", role: "admin" },
      })
    ).status,
    400,
  );

  const listed = await call("/api/pages/team-page/access", { token: OWNER });
  assert.deepEqual(
    listed.json.codes.map((c) => [c.label, c.role]),
    [
      ["Viewer", "view"],
      ["Priya", "comment"],
      ["Sam", "edit"],
    ],
  );

  // PATCH: rename + upgrade the viewer, then downgrade back.
  const up = await call(`/api/pages/team-page/access/codes/${viewer.json.id}`, {
    method: "PATCH",
    token: OWNER,
    body: { role: "comment", label: "Viewer+" },
  });
  assert.equal(up.status, 200);
  assert.deepEqual({ label: up.json.label, role: up.json.role }, { label: "Viewer+", role: "comment" });
  const down = await call(`/api/pages/team-page/access/codes/${viewer.json.id}`, {
    method: "PATCH",
    token: OWNER,
    body: { role: "view" },
  });
  assert.equal(down.status, 200);
  assert.equal(down.json.role, "view");
  assert.equal(down.json.label, "Viewer+", "PATCHing role alone keeps the label");
  assert.equal(
    (
      await call(`/api/pages/team-page/access/codes/${viewer.json.id}`, {
        method: "PATCH",
        token: OWNER,
        body: { role: "root" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call(`/api/pages/team-page/access/codes/a-00000000`, {
        method: "PATCH",
        token: OWNER,
        body: { role: "edit" },
      })
    ).status,
    404,
  );

  viewCookie = cookieOf(await unlock("team-page", "viewer-code-one"));
  commentCookie = cookieOf(await unlock("team-page", "comment-code-one"));
  editCookie = cookieOf(await unlock("team-page", "edit-code-one"));
});

const bootOf = (text) => {
  const m = text.match(/<script type="application\/json" id="dk-boot">([\s\S]*?)<\/script>/);
  assert.ok(m, "page carries an app-shell boot record");
  return JSON.parse(m[1]);
};

await test("roles: view keeps the classic page; comment/edit get the app shell", async () => {
  // View: the page as it always was — no shell, no comment machinery.
  const viewPage = await call("/team-page", { headers: { cookie: viewCookie } });
  assert.equal(viewPage.status, 200);
  assert.ok(viewPage.text.includes('<main class="doc">'));
  assert.ok(!viewPage.text.includes("dk-boot"), "view gets no app shell");

  // Comment/edit: the app shell, booted with the session's role and the
  // document (comments included — that's the point).
  const commentPage = await call("/team-page", { headers: { cookie: commentCookie } });
  assert.equal(commentPage.status, 200);
  assert.ok(commentPage.text.includes('id="dk-root"'));
  const commentBoot = bootOf(commentPage.text);
  assert.equal(commentBoot.role, "comment");
  assert.equal(commentBoot.view, "md");
  assert.equal(commentBoot.label, "Priya");
  assert.ok(commentBoot.markdown.includes("shared body"));

  const editBoot = bootOf((await call("/team-page", { headers: { cookie: editCookie } })).text);
  assert.equal(editBoot.role, "edit");

  // The shell references version-stamped assets; without an injected bundle
  // (this test build) the asset route says exactly that.
  assert.ok(commentPage.text.includes("/__web/16/app.js"));
  assert.equal((await call("/__web/16/app.js")).status, 503);

  // Write-endpoint floors: view can't save or comment; no cookie is a 401.
  const viewSave = await call("/team-page/save", {
    method: "POST",
    headers: { cookie: viewCookie },
    body: { markdown: "# nope", baseRev: 1 },
  });
  assert.equal(viewSave.status, 403);
  assert.equal(
    (await call("/team-page/html-comments", { headers: { cookie: viewCookie } })).status,
    403,
  );
  assert.equal((await call("/team-page/html-comments")).status, 401);

  // JSON-only writes: a form-encoded body is refused (the CSRF line), and a
  // cross-origin sender is refused even with the right cookie.
  const formish = await call("/team-page/save", {
    method: "POST",
    headers: { cookie: editCookie, "content-type": "application/x-www-form-urlencoded" },
    body: "markdown=x&baseRev=1",
  });
  assert.equal(formish.status, 415);
  const crossOrigin = await call("/team-page/save", {
    method: "POST",
    headers: { cookie: editCookie, origin: "https://evil.test" },
    body: { markdown: "# x", baseRev: 1 },
  });
  assert.equal(crossOrigin.status, 403);

  // The old v8/v9 routes send stale tabs back to the page.
  const legacyEdit = await call("/team-page/edit", { headers: { cookie: editCookie } });
  assert.equal(legacyEdit.status, 303);
  assert.equal(legacyEdit.headers.get("location"), "/team-page");
  assert.equal((await call("/team-page/comments", { method: "POST" })).status, 303);
});

await test("mermaid: static pages hydrate diagram blocks, shell knows the module URL", async () => {
  // A page WITH a ```mermaid block: the reading view keeps the code block in
  // the markup (no-JS fallback) and gains the hydrator, which imports the
  // version-stamped module.
  await call("/api/pages/diagram-doc", {
    method: "PUT",
    token: OWNER,
    body: {
      title: "With a diagram",
      markdown: "# Flow\n\n```mermaid\nflowchart LR\n  A --> B\n```\n",
    },
  });
  const withDiagram = await call("/diagram-doc");
  assert.equal(withDiagram.status, 200);
  assert.ok(withDiagram.text.includes('class="language-mermaid"'));
  assert.ok(withDiagram.text.includes("/__web/16/mermaid.js"));

  // A page without one doesn't pay for the script.
  await call("/api/pages/plain-doc", {
    method: "PUT",
    token: OWNER,
    body: { title: "No diagram", markdown: "# Plain\n\n```js\n1\n```\n" },
  });
  assert.ok(!(await call("/plain-doc")).text.includes("mermaid.js"));

  // The shell hands the module URL to the editor (window.__DK_MERMAID_URL);
  // the asset route answers like app.js does (503 in this bundle-less build).
  const shell = await call("/team-page", { headers: { cookie: commentCookie } });
  assert.ok(shell.text.includes(`window.__DK_MERMAID_URL = "/__web/16/mermaid.js"`));
  assert.equal((await call("/__web/16/mermaid.js")).status, 503);

  await call("/api/pages/diagram-doc", { method: "DELETE", token: OWNER });
  await call("/api/pages/plain-doc", { method: "DELETE", token: OWNER });
});

await test("markdown comments: a comment-role save must leave the document unchanged", async () => {
  const content = await call("/api/pages/team-page/content", { token: OWNER });
  const rev = content.json.rev;
  const md = content.json.markdown;

  // A comment IS a save: the same document, one CriticMarkup thread added.
  const commented = md.replace(
    "shared body",
    "{==shared body==}{>>#w1a2b3 Priya P · 2026-07-15T10:00:00Z: bolder?<<}",
  );
  const saved = await call("/team-page/save", {
    method: "POST",
    headers: { cookie: commentCookie },
    body: { markdown: commented, baseRev: rev },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.rev, rev + 1);

  // Comment/edit sessions see the thread; view sessions never do.
  const shell = await call("/team-page", { headers: { cookie: commentCookie } });
  assert.ok(bootOf(shell.text).markdown.includes("bolder?"));
  const viewPage = await call("/team-page", { headers: { cookie: viewCookie } });
  assert.ok(!viewPage.text.includes("bolder?"), "comments are stripped for view sessions");
  assert.ok(viewPage.text.includes("shared body"), "the anchor text stays");

  // The pull-back stamp is set — the app folds web comments in like edits —
  // but a comment-only save never retitles.
  const meta = await call("/api/pages/team-page", { token: OWNER });
  assert.equal(meta.json.webEdit.by, "Priya");
  assert.equal(meta.json.title, "Team page");

  // Content changes are the edit role's alone.
  const sneaky = await call("/team-page/save", {
    method: "POST",
    headers: { cookie: commentCookie },
    body: { markdown: commented.replace("shared body==}", "REWRITTEN==}"), baseRev: rev + 1 },
  });
  assert.equal(sneaky.status, 403);

  // Normalized-but-equivalent markdown still counts as unchanged — the
  // shell's editor re-serializes documents in its own style (here: an extra
  // blank line, which renders and describes identically).
  const normalized = commented.replace("\n\n", "\n\n\n");
  const okNorm = await call("/team-page/save", {
    method: "POST",
    headers: { cookie: commentCookie },
    body: { markdown: normalized, baseRev: rev + 1 },
  });
  assert.equal(okNorm.status, 200);

  // But content that renders invisibly yet would surface to a VIEW reader — a
  // link reference definition lands verbatim in the page description — is NOT
  // a comment: rejected exactly like a body change.
  const smuggle = "[Wire funds to acct 9982]: https://evil.test\n\n" + commented;
  const rejected = await call("/team-page/save", {
    method: "POST",
    headers: { cookie: commentCookie },
    body: { markdown: smuggle, baseRev: okNorm.json.rev },
  });
  assert.equal(rejected.status, 403);

  // A stale baseRev answers 409 with the current rev, never a clobber.
  const stale = await call("/team-page/save", {
    method: "POST",
    headers: { cookie: commentCookie },
    body: { markdown: commented, baseRev: rev },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.rev, rev + 2);
});

await test("web edit: rev bumps, retitles, stamps webEdit; comments ride along", async () => {
  const rev = (await call("/api/pages/team-page/content", { token: OWNER })).json.rev;
  const newMd =
    "# Renamed by the web\n\nnew body {==here==}{>>#a1b2c3 Sam · 2026-07-15T11:00:00Z: kept<<}";
  const saved = await call("/team-page/save", {
    method: "POST",
    headers: { cookie: editCookie },
    body: { markdown: newMd, baseRev: rev },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.rev, rev + 1);

  const meta = await call("/api/pages/team-page", { token: OWNER });
  assert.equal(meta.json.title, "Renamed by the web", "lead H1 retitles the page");
  assert.equal(meta.json.rev, rev + 1);
  assert.equal(meta.json.webEdit.by, "Sam");

  // The comment the editor left rides the document: stored in full, pulled
  // back by the app, stripped for view sessions.
  const viewPage = await call("/team-page", { headers: { cookie: viewCookie } });
  assert.ok(viewPage.text.includes("new body"));
  assert.ok(!viewPage.text.includes("kept"), "view sessions never see comment text");
  const content = await call("/api/pages/team-page/content", { token: OWNER });
  assert.ok(content.json.markdown.includes("{>>#a1b2c3"), "the app pulls comments with the doc");

  const listRow = (await call("/api/pages", { token: OWNER })).json.pages.find(
    (p) => p.id === "team-page",
  );
  assert.equal(listRow.rev, rev + 1);
  assert.equal(listRow.webEdit.by, "Sam");

  // A save from the revision that just got overwritten: 409 with the fresh
  // rev; force (the shell's explicit "keep mine") pushes through.
  const stale = await call("/team-page/save", {
    method: "POST",
    headers: { cookie: editCookie },
    body: { markdown: "# My stale attempt", baseRev: rev },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.rev, rev + 1);
  const forced = await call("/team-page/save", {
    method: "POST",
    headers: { cookie: editCookie },
    body: { markdown: "# Renamed by the web\n\nforced body", baseRev: rev, force: true },
  });
  assert.equal(forced.status, 200);

  // force is the edit role's alone.
  const commentForce = await call("/team-page/save", {
    method: "POST",
    headers: { cookie: commentCookie },
    body: { markdown: "# Renamed by the web\n\nsneaky body", baseRev: rev, force: true },
  });
  assert.ok(commentForce.status === 403 || commentForce.status === 409);

  // Emptying the document from the web is refused.
  assert.equal(
    (
      await call("/team-page/save", {
        method: "POST",
        headers: { cookie: editCookie },
        body: { markdown: "  \n ", baseRev: forced.json.rev },
      })
    ).status,
    400,
  );
});

await test("web edit: app pushes see the conflict once, devices keep last-writer-wins", async () => {
  const current = await call("/api/pages/team-page", { token: OWNER });
  const rev = current.json.rev;

  // The app pushes with the rev it last pushed (before the web edit): 409
  // with enough context to pull.
  const conflicted = await call("/api/pages/team-page", {
    method: "PUT",
    token: OWNER,
    body: { title: "App title", markdown: "# from the app", baseRev: rev - 1 },
  });
  assert.equal(conflicted.status, 409);
  assert.equal(conflicted.json.rev, rev);
  assert.equal(conflicted.json.webEdit.by, "Sam");

  // Pushing with the current rev (the app pulled or chose to override):
  // accepted, rev bumps, the webEdit stamp clears.
  const accepted = await call("/api/pages/team-page", {
    method: "PUT",
    token: OWNER,
    body: { title: "App title", markdown: "# from the app", baseRev: rev },
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.json.rev, rev + 1);
  assert.equal((await call("/api/pages/team-page", { token: OWNER })).json.webEdit, null);

  // With no unseen web edit, a stale baseRev does NOT conflict — another
  // device pushing the synced file keeps its last-writer-wins behavior.
  const devicePush = await call("/api/pages/team-page", {
    method: "PUT",
    token: OWNER,
    body: { title: "App title", markdown: "# other device", baseRev: rev },
  });
  assert.equal(devicePush.status, 200);

  // Legacy pushes (no baseRev) clobber a web edit silently, as before v8.
  const nowRev = (await call("/api/pages/team-page", { token: OWNER })).json.rev;
  await call("/team-page/save", {
    method: "POST",
    headers: { cookie: editCookie },
    body: { markdown: "# web again", baseRev: nowRev },
  });
  const legacy = await call("/api/pages/team-page", {
    method: "PUT",
    token: OWNER,
    body: { title: "Legacy", markdown: "# legacy push" },
  });
  assert.equal(legacy.status, 200);
  assert.equal((await call("/api/pages/team-page", { token: OWNER })).json.webEdit, null);
});

await test("web edit: only content changes outdate the rendition", async () => {
  await call("/api/pages/dual-page", {
    method: "PUT",
    token: OWNER,
    body: {
      title: "Dual",
      markdown: "# Dual\n\nmd body",
      html: "<html><body>rendition-v1</body></html>",
    },
  });
  await call("/api/pages/dual-page/access/codes", {
    method: "POST",
    token: OWNER,
    body: { label: "Editor", code: "dual-edit-code", role: "edit" },
  });
  const cookie = cookieOf(await unlock("dual-page", "dual-edit-code"));

  // With both renditions the shell opens on the html view.
  const before = bootOf((await call("/dual-page", { headers: { cookie } })).text);
  assert.equal(before.view, "html");
  assert.equal(before.hasMd, true);
  assert.equal(before.markdown, null, "the html view's shell doesn't carry the markdown");

  // A comment-only save (strip-equivalent) leaves the rendition current.
  const rev1 = (await call("/api/pages/dual-page", { token: OWNER })).json.rev;
  const commentOnly = await call("/dual-page/save", {
    method: "POST",
    headers: { cookie },
    body: {
      markdown:
        "# Dual\n\n{==md body==}{>>#q1w2e3 Editor · 2026-07-15T12:00:00Z: note<<}",
      baseRev: rev1,
    },
  });
  assert.equal(commentOnly.status, 200);
  assert.equal((await call("/api/pages/dual-page", { token: OWNER })).json.htmlStale, false);
  assert.equal(
    bootOf((await call("/dual-page", { headers: { cookie } })).text).view,
    "html",
    "the rendition still leads after comment traffic",
  );

  // A real edit stales it: the markdown becomes the default view.
  const edited = await call("/dual-page/save", {
    method: "POST",
    headers: { cookie },
    body: { markdown: "# Dual\n\nedited on the web", baseRev: commentOnly.json.rev },
  });
  assert.equal(edited.status, 200);
  assert.equal((await call("/api/pages/dual-page", { token: OWNER })).json.htmlStale, true);
  const after = bootOf((await call("/dual-page", { headers: { cookie } })).text);
  assert.equal(after.view, "md");
  assert.equal(after.htmlStale, true);
  assert.equal(
    bootOf((await call("/dual-page?v=html", { headers: { cookie } })).text).view,
    "html",
    "?v=html still reaches the stale rendition",
  );

  // The app re-pushing the SAME rendition (it hasn't regenerated) keeps the
  // markdown in front…
  await call("/api/pages/dual-page", {
    method: "PUT",
    token: OWNER,
    body: {
      title: "Dual",
      markdown: "# Dual\n\nedited on the web",
      html: "<html><body>rendition-v1</body></html>",
    },
  });
  assert.equal((await call("/api/pages/dual-page", { token: OWNER })).json.htmlStale, true);

  // …and a fresh rendition takes the default view back.
  await call("/api/pages/dual-page", {
    method: "PUT",
    token: OWNER,
    body: {
      title: "Dual",
      markdown: "# Dual\n\nedited on the web",
      html: "<html><body>rendition-v2</body></html>",
    },
  });
  assert.equal((await call("/api/pages/dual-page", { token: OWNER })).json.htmlStale, false);
  assert.equal(bootOf((await call("/dual-page", { headers: { cookie } })).text).view, "html");

  await call("/api/pages/dual-page", { method: "DELETE", token: OWNER });
});

/* ---------- Comment threads on html renditions (version 10) ---------- */

await test("html threads: session pool round-trip with provenance stamping", async () => {
  const RENDITION =
    "<html><body><main><h1>Brief</h1><p>opening line</p></main></body></html>";
  await call("/api/pages/brief", {
    method: "PUT",
    token: OWNER,
    body: { title: "Brief", markdown: "# Brief\n\nopening", html: RENDITION },
  });
  await call("/api/pages/brief/access/codes", {
    method: "POST",
    token: OWNER,
    body: { label: "Reviewer", code: "brief-comment-code", role: "comment" },
  });
  const cookie = cookieOf(await unlock("brief", "brief-comment-code"));

  // Empty pool; the shell's html view boots lean (no markdown payload).
  assert.deepEqual((await call("/brief/html-comments", { headers: { cookie } })).json, {
    rev: 0,
    threads: [],
  });
  const boot = bootOf((await call("/brief", { headers: { cookie } })).text);
  assert.equal(boot.view, "html");
  assert.equal(boot.markdown, null);

  // The rendition is served byte-for-byte — the shell instruments it
  // client-side, exactly like the desktop preview.
  const raw = await call("/brief/raw", { headers: { cookie } });
  assert.equal(raw.text, RENDITION);

  // A new thread: the client pushes the whole list against the rev it read.
  const post = await call("/brief/html-comments", {
    method: "POST",
    headers: { cookie },
    body: {
      baseRev: 0,
      threads: [
        {
          id: "t1abcd",
          anchor: { path: "main:nth-of-type(1) > p:nth-of-type(1)", tag: "p", text: "opening line" },
          comments: [{ author: "Priya P", at: 1752570000000, body: "Bolder opening?" }],
        },
      ],
    },
  });
  assert.equal(post.status, 200);
  assert.equal(post.json.rev, 1);
  const entry = post.json.threads[0].comments[0];
  assert.ok(/^e-[a-f0-9]{8}$/.test(entry.eid), "new entries get a server eid");
  assert.equal(entry.label, "Reviewer");
  assert.ok(entry.codeId.startsWith("a-"), "entries carry the code that wrote them");

  // A concurrent writer with a stale base gets the current state to rebase on.
  const conflicted = await call("/brief/html-comments", {
    method: "POST",
    headers: { cookie },
    body: { baseRev: 0, threads: [] },
  });
  assert.equal(conflicted.status, 409);
  assert.equal(conflicted.json.rev, 1);
  assert.equal(conflicted.json.threads.length, 1);

  // Owner GET carries a flat `comments` back-compat view (one row per thread)
  // so a pre-v10 desktop app still reads the moderation list.
  const ownerCompat = await call("/api/pages/brief/comments", { token: OWNER });
  assert.equal(ownerCompat.json.comments.length, 1);
  assert.equal(ownerCompat.json.comments[0].id, "t1abcd");
  assert.equal(ownerCompat.json.comments[0].body, "Bolder opening?");
  assert.equal(ownerCompat.json.comments[0].quote, "opening line");

  // Replies join the thread — and the stored identity of existing entries is
  // pinned: a swap can't reattribute someone else's words.
  const tampered = post.json.threads.map((t) => ({
    ...t,
    comments: [
      { ...t.comments[0], author: "Mallory", label: "Mallory" },
      { author: "Sam", at: 1752570100000, body: "Agreed." },
    ],
  }));
  const replied = await call("/brief/html-comments", {
    method: "POST",
    headers: { cookie },
    body: { baseRev: 1, threads: tampered },
  });
  assert.equal(replied.status, 200);
  const [opener, reply] = replied.json.threads[0].comments;
  assert.equal(opener.author, "Priya P", "stored authorship survives a hostile swap");
  assert.equal(opener.label, "Reviewer");
  assert.equal(reply.label, "Reviewer", "new entries are stamped with the session's code");

  // Body edits DO follow the incoming copy (desktop-parity edit-anywhere),
  // under the same stable identity.
  const editedThreads = replied.json.threads.map((t) => ({
    ...t,
    comments: t.comments.map((e, i) => (i === 0 ? { ...e, body: "Bolder opening!!" } : e)),
  }));
  const body2 = await call("/brief/html-comments", {
    method: "POST",
    headers: { cookie },
    body: { baseRev: replied.json.rev, threads: editedThreads },
  });
  assert.equal(body2.json.threads[0].comments[0].body, "Bolder opening!!");
  assert.equal(body2.json.threads[0].comments[0].eid, entry.eid, "identity survives edits");

  // Owner side: the same pool through the API, and the pool's revision rides
  // the page listing (one request tells the app what to pull).
  const ownerRead = await call("/api/pages/brief/comments", { token: OWNER });
  assert.equal(ownerRead.json.rev, body2.json.rev);
  assert.equal(ownerRead.json.threads.length, 1);
  const row = (await call("/api/pages", { token: OWNER })).json.pages.find(
    (p) => p.id === "brief",
  );
  assert.equal(row.commentsRev, body2.json.rev);

  // The app pushes its sidecar in (a desktop thread joins), rev-guarded like
  // every other writer.
  const appPush = await call("/api/pages/brief/comments", {
    method: "PUT",
    token: OWNER,
    body: {
      baseRev: body2.json.rev,
      threads: [
        ...body2.json.threads,
        {
          id: "t2wxyz",
          anchor: { path: "main:nth-of-type(1) > h1:nth-of-type(1)", tag: "h1", text: "Brief" },
          comments: [{ author: "Sherin's Mac", at: 1752570200000, body: "Desktop note" }],
        },
      ],
    },
  });
  assert.equal(appPush.status, 200);
  assert.equal(appPush.json.threads.length, 2);
  const desktopEntry = appPush.json.threads[1].comments[0];
  assert.ok(desktopEntry.eid, "desktop entries get eids at ingestion");
  assert.equal(desktopEntry.codeId, undefined, "owner pushes carry no code provenance");
  assert.equal(
    (
      await call("/api/pages/brief/comments", {
        method: "PUT",
        token: OWNER,
        body: { baseRev: 0, threads: [] },
      })
    ).status,
    409,
  );

  // Comment sessions see the merged pool — the desktop's thread included.
  assert.equal(
    (await call("/brief/html-comments", { headers: { cookie } })).json.threads.length,
    2,
  );

  // Owner moderation: one thread away, then the slate.
  assert.equal(
    (await call("/api/pages/brief/comments/t1abcd", { method: "DELETE", token: OWNER })).status,
    200,
  );
  assert.equal(
    (await call("/brief/html-comments", { headers: { cookie } })).json.threads.length,
    1,
  );
  await call("/api/pages/brief/comments", { method: "DELETE", token: OWNER });
  assert.deepEqual(
    (await call("/brief/html-comments", { headers: { cookie } })).json,
    { rev: 0, threads: [] },
  );

  await call("/api/pages/brief", { method: "DELETE", token: OWNER });
});

await test("html threads: two first-writers race a fresh pool — exactly one wins", async () => {
  await call("/api/pages/race", {
    method: "PUT",
    token: OWNER,
    body: { title: "Race", html: "<html><body><p>x</p></body></html>" },
  });
  await call("/api/pages/race/access/codes", {
    method: "POST",
    token: OWNER,
    body: { label: "One", code: "race-code", role: "comment" },
  });
  const cookie = cookieOf(await unlock("race", "race-code"));

  const mk = (tid, who) => ({
    method: "POST",
    headers: { cookie },
    body: {
      baseRev: 0,
      threads: [
        { id: tid, anchor: { path: "", tag: "", text: "" }, comments: [{ author: who, at: 1, body: who }] },
      ],
    },
  });
  // Both read rev 0 (no pool object yet) and both try to CREATE. The
  // If-None-Match create guard must let only one through; the loser re-reads
  // and gets the 409 conflict — never a silent overwrite that loses a comment.
  const [a, b] = await Promise.all([
    call("/race/html-comments", mk("aaa111", "Ana")),
    call("/race/html-comments", mk("bbb222", "Ben")),
  ]);
  const oks = [a, b].filter((r) => r.status === 200);
  const conflicts = [a, b].filter((r) => r.status === 409);
  assert.equal(oks.length, 1, "exactly one create wins");
  assert.equal(conflicts.length, 1, "the other is told to rebase, not silently dropped");
  assert.equal(oks[0].json.rev, 1);
  assert.equal(conflicts[0].json.rev, 1);
  assert.equal(conflicts[0].json.threads.length, 1, "the loser sees the winner's comment to merge");

  await call("/api/pages/race", { method: "DELETE", token: OWNER });
});

// TODO(legacy-cleanup): retire this suite together with migrateFlatComments
// (share-worker/src/index.js) once no pre-v10 flat pools remain.
await test("html threads: a v9 flat pool reads as threads (nothing lost)", async () => {
  await call("/api/pages/legacy", {
    method: "PUT",
    token: OWNER,
    body: { title: "Legacy", markdown: "# Legacy\n\nopening", html: "<html><body><p>opening</p></body></html>" },
  });
  await call("/api/pages/legacy/access/codes", {
    method: "POST",
    token: OWNER,
    body: { label: "Reviewer", code: "legacy-comment-code", role: "comment" },
  });
  const cookie = cookieOf(await unlock("legacy", "legacy-comment-code"));

  // Seed the exact shape a v9 worker stored.
  await fake.put(
    "pages/legacy.comments.json",
    JSON.stringify({
      comments: [
        {
          id: "m-11223344",
          body: "Anchored one",
          quote: "opening",
          anchor: { path: "body:nth-of-type(1) > p:nth-of-type(1)", tag: "p", text: "opening" },
          name: "Priya P",
          label: "Reviewer",
          codeId: "a-12345678",
          createdAt: "2026-07-01T10:00:00Z",
        },
        {
          id: "m-55667788",
          body: "Whole-page note",
          label: "Reviewer",
          codeId: "a-12345678",
          createdAt: "2026-07-02T10:00:00Z",
        },
      ],
    }),
  );

  const read = await call("/legacy/html-comments", { headers: { cookie } });
  assert.equal(read.json.rev, 1);
  assert.equal(read.json.threads.length, 2);
  const [anchored, whole] = read.json.threads;
  assert.equal(anchored.id, "m-11223344");
  assert.equal(anchored.anchor.tag, "p");
  assert.equal(anchored.comments[0].author, "Priya P");
  assert.equal(anchored.comments[0].eid, "m-11223344");
  assert.equal(whole.anchor.path, "", "an unanchored comment becomes an orphan thread");
  assert.equal(whole.comments[0].body, "Whole-page note");

  // The first write upgrades the object in place.
  const upgraded = await call("/legacy/html-comments", {
    method: "POST",
    headers: { cookie },
    body: { baseRev: 1, threads: read.json.threads },
  });
  assert.equal(upgraded.status, 200);
  assert.equal(upgraded.json.rev, 2);

  await call("/api/pages/legacy", { method: "DELETE", token: OWNER });
});

await test("roles: folder codes carry their role onto member pages", async () => {
  await call("/api/pages/role-folder", {
    method: "PUT",
    token: OWNER,
    body: {
      title: "Folder",
      kind: "collection",
      items: [{ id: "role-member", title: "Member", path: "member.md" }],
    },
  });
  await call("/api/pages/role-member", {
    method: "PUT",
    token: OWNER,
    body: {
      title: "Member",
      markdown: "# member",
      collection: { id: "role-folder", title: "Folder" },
    },
  });
  await call("/api/pages/role-folder/access/codes", {
    method: "POST",
    token: OWNER,
    body: { label: "Team", code: "folder-edit-code", role: "edit" },
  });

  const cookie = cookieOf(await unlock("role-folder", "folder-edit-code"));
  const member = await call("/role-member", { headers: { cookie } });
  assert.equal(member.status, 200);
  const boot = bootOf(member.text);
  assert.equal(boot.role, "edit", "folder role reaches member pages");
  assert.equal(boot.crumb.id, "role-folder", "the shell keeps the back-home crumb");

  const rev = (await call("/api/pages/role-member", { token: OWNER })).json.rev;
  const saved = await call("/role-member/save", {
    method: "POST",
    headers: { cookie },
    body: { markdown: "# member\n\nedited via folder code", baseRev: rev },
  });
  assert.equal(saved.status, 200);

  // Deleting a page also drops its thread pool.
  await call("/role-member/html-comments", {
    method: "POST",
    headers: { cookie },
    body: {
      baseRev: 0,
      threads: [
        {
          id: "t3folk",
          anchor: { path: "", tag: "", text: "" },
          comments: [{ author: "Team", at: 1752570300000, body: "folder session comment" }],
        },
      ],
    },
  });
  assert.equal(
    (await call("/api/pages/role-member/comments", { token: OWNER })).json.threads.length,
    1,
  );
  await call("/api/pages/role-member", { method: "DELETE", token: OWNER });
  await call("/api/pages/role-member", {
    method: "PUT",
    token: OWNER,
    body: { title: "Member", markdown: "# fresh", collection: { id: "role-folder", title: "Folder" } },
  });
  assert.deepEqual(
    (await call("/api/pages/role-member/comments", { token: OWNER })).json.threads,
    [],
    "the pool died with the page",
  );

  for (const id of ["role-member", "role-folder", "team-page"]) {
    await call(`/api/pages/${id}`, { method: "DELETE", token: OWNER });
  }
});

// Destroys all state — keep this last.
await test("wipe: owner-only, confirmed, empties the bucket completely", async () => {
  // Guardrails: a member can't wipe, and the confirm phrase is required.
  const inv = await call("/api/auth/invites", {
    method: "POST",
    token: OWNER,
    body: { name: "Mallory", role: "member", workspaces: [ws] },
  });
  const joined = await call("/api/auth/join", {
    method: "POST",
    ip: freshIp(),
    body: { invite: inv.json.code, name: "Mallory's Mac" },
  });
  const mallory = joined.json.token;
  assert.equal(
    (await call("/api/admin/wipe", { method: "POST", token: mallory, body: { confirm: "wipe" } }))
      .status,
    403,
  );
  assert.equal(
    (await call("/api/admin/wipe", { method: "POST", token: OWNER, body: {} })).status,
    400,
  );
  assert.equal((await call("/api/admin/wipe", { token: OWNER })).status, 405);

  // A linked-device owner wipes too: its own token object must go LAST so
  // the wipe can't cut itself off half-done.
  const devInv = await call("/api/auth/invites", {
    method: "POST",
    token: OWNER,
    body: { name: "Studio iMac", role: "owner" },
  });
  const devJoin = await call("/api/auth/join", {
    method: "POST",
    ip: freshIp(),
    body: { invite: devInv.json.code, name: "Studio iMac" },
  });
  const device = devJoin.json.token;

  assert.ok(fake.store.size > 0, "there is data to wipe");
  const res = await call("/api/admin/wipe", {
    method: "POST",
    token: device,
    body: { confirm: "wipe" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.remaining, false);
  assert.ok(res.json.purged > 0);
  assert.equal(fake.store.size, 0, "bucket is completely empty");

  // Every minted credential died with the bucket; the master secret lives in
  // the env, so the owner can still talk to the (now empty) worker.
  assert.equal((await call("/api/auth/whoami", { token: mallory })).status, 401);
  assert.equal((await call("/api/auth/whoami", { token: device })).status, 401);
  const pages = await call("/api/pages", { token: OWNER });
  assert.equal(pages.status, 200);
  assert.deepEqual(pages.json.pages, []);
  assert.equal((await call(`/api/sync/${ws}/manifest`, { token: OWNER })).status, 404);
  const wss = await call("/api/sync/workspaces", { token: OWNER });
  assert.deepEqual(wss.json.workspaces, []);
});

/* ---------- Summary ---------- */

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  process.exitCode = 1;
}
