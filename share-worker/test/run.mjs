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
    if (opts.onlyIf?.etagMatches !== undefined) {
      const existing = this.store.get(key);
      if (!existing || existing.etag !== opts.onlyIf.etagMatches) return null;
    }
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
  assert.equal(ok.json.version, 5);
  assert.ok(ok.json.features.includes("sync"));
  assert.ok(ok.json.features.includes("auth"));
  assert.ok(ok.json.features.includes("workspace-pages"));
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

  const join = await call("/join");
  assert.equal(join.status, 200);
  assert.ok(join.text.includes("You're invited"));
  assert.ok(join.text.includes("Connect to a shared backend"));

  // "sync" and "auth" look like page ids but must never serve private state.
  assert.equal((await call("/sync")).status, 404);
  assert.equal((await call("/auth")).status, 404);
  assert.equal((await call(`/${ws}`)).status, 404);
});

/* ---------- Summary ---------- */

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  process.exitCode = 1;
}
