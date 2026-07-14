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
  assert.equal(ok.json.version, 9);
  assert.ok(ok.json.features.includes("sync"));
  assert.ok(ok.json.features.includes("auth"));
  assert.ok(ok.json.features.includes("workspace-pages"));
  assert.ok(ok.json.features.includes("wipe"));
  assert.ok(ok.json.features.includes("page-access"));
  assert.ok(ok.json.features.includes("access-roles"));
  assert.ok(ok.json.features.includes("web-comments"));
  assert.ok(ok.json.features.includes("web-edit"));
  assert.ok(ok.json.features.includes("html-comments"));
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

await test("roles: what each session sees and may do", async () => {
  // View: the page as it always was — no comments section, no edit button.
  const viewPage = await call("/team-page", { headers: { cookie: viewCookie } });
  assert.equal(viewPage.status, 200);
  assert.ok(!viewPage.text.includes('id="comments"'), "view sees no comments section");
  assert.ok(!viewPage.text.includes("/team-page/edit"), "view sees no edit button");

  // Comment: comments section, no edit button.
  const commentPage = await call("/team-page", { headers: { cookie: commentCookie } });
  assert.ok(commentPage.text.includes('id="comments"'));
  assert.ok(!commentPage.text.includes("/team-page/edit"));

  // Edit: both.
  const editPage = await call("/team-page", { headers: { cookie: editCookie } });
  assert.ok(editPage.text.includes('id="comments"'));
  assert.ok(editPage.text.includes('href="https://docs.test/team-page/edit"'));

  // The write endpoints enforce the same floors.
  assert.equal(
    (await postForm("/team-page/comments", { body: "hi" }, { cookie: viewCookie })).status,
    403,
  );
  assert.equal(
    (await call("/team-page/edit", { headers: { cookie: viewCookie } })).status,
    403,
  );
  assert.equal(
    (await call("/team-page/edit", { headers: { cookie: commentCookie } })).status,
    403,
  );
  // No cookie at all → the gate, not a 403.
  const anon = await call("/team-page/edit");
  assert.equal(anon.status, 401);
  assert.ok(anon.text.includes("gate-form"));
  assert.ok(anon.text.includes('value="/team-page/edit"'), "gate returns to the editor");
});

await test("comments: post, read, delete-own; owner moderates over the API", async () => {
  const posted = await postForm(
    "/team-page/comments",
    { body: "First!\n\nWith a second line.", name: "Priya P" },
    { cookie: commentCookie },
  );
  assert.equal(posted.status, 303);
  assert.equal(posted.headers.get("location"), "/team-page#comments");

  await postForm("/team-page/comments", { body: "Editor here." }, { cookie: editCookie });

  const page = await call("/team-page", { headers: { cookie: commentCookie } });
  assert.ok(page.text.includes("First!"));
  assert.ok(page.text.includes("Priya P"));
  assert.ok(page.text.includes("Editor here."));
  assert.ok(page.text.includes("Sam"), "a nameless comment is attributed to its code label");

  // Blank comments are refused.
  assert.equal(
    (await postForm("/team-page/comments", { body: "   " }, { cookie: commentCookie })).status,
    400,
  );

  // The owner reads everything (with code attribution) over the API.
  const ownerList = await call("/api/pages/team-page/comments", { token: OWNER });
  assert.equal(ownerList.status, 200);
  assert.equal(ownerList.json.comments.length, 2);
  assert.equal(ownerList.json.comments[0].name, "Priya P");
  assert.equal(ownerList.json.comments[0].codeId, commenterId);
  const first = ownerList.json.comments[0];
  const second = ownerList.json.comments[1];

  // A session deletes its own code's comments, not another code's.
  const denied = await postForm(
    `/team-page/comments/${second.id}/delete`,
    {},
    { cookie: commentCookie },
  );
  assert.equal(denied.status, 403);
  const okDelete = await postForm(
    `/team-page/comments/${first.id}/delete`,
    {},
    { cookie: commentCookie },
  );
  assert.equal(okDelete.status, 303);

  // Owner moderation: delete one by id, then the rest wholesale.
  assert.equal(
    (await call(`/api/pages/team-page/comments/${second.id}`, { method: "DELETE", token: OWNER }))
      .status,
    200,
  );
  await postForm("/team-page/comments", { body: "again" }, { cookie: commentCookie });
  assert.equal(
    (await call("/api/pages/team-page/comments", { method: "DELETE", token: OWNER })).status,
    200,
  );
  assert.deepEqual(
    (await call("/api/pages/team-page/comments", { token: OWNER })).json.comments,
    [],
  );

  // Unprotected pages take no comments — there's no one named to take them from.
  await call("/api/pages/open-page", {
    method: "PUT",
    token: OWNER,
    body: { title: "Open", markdown: "# open" },
  });
  assert.equal((await postForm("/open-page/comments", { body: "nope" })).status, 403);
  await call("/api/pages/open-page", { method: "DELETE", token: OWNER });
});

/* ---------- Comments on html renditions (version 9) ---------- */

await test("html comments: the html view grows the section; anchored posts round-trip", async () => {
  await call("/api/pages/brief", {
    method: "PUT",
    token: OWNER,
    body: {
      title: "Brief",
      markdown: "# Brief\n\nAlpha paragraph.",
      html: "<html><body><main><p>Alpha paragraph.</p></main></body></html>",
    },
  });
  await call("/api/pages/brief/access/codes", {
    method: "POST",
    token: OWNER,
    body: { label: "Vera", code: "brief-view-code", role: "view" },
  });
  await call("/api/pages/brief/access/codes", {
    method: "POST",
    token: OWNER,
    body: { label: "Cody", code: "brief-comment-code", role: "comment" },
  });
  const vCookie = cookieOf(await unlock("brief", "brief-view-code"));
  const cCookie = cookieOf(await unlock("brief", "brief-comment-code"));

  // View role: the page as it always was — fixed frame, no comments section,
  // and the raw rendition byte-for-byte (no bridge).
  const viewPage = await call("/brief", { headers: { cookie: vCookie } });
  assert.ok(viewPage.text.includes('class="raw-frame"'));
  assert.ok(!viewPage.text.includes('id="comments"'));
  const viewRaw = await call("/brief/raw", { headers: { cookie: vCookie } });
  assert.ok(!viewRaw.text.includes("dkw-bubble"), "view session raw is untouched");
  assert.ok(viewRaw.text.includes("Alpha paragraph."));

  // Comment role: flowing frame with the section below, the anchor plumbing
  // in the form, and the bridge injected into the raw rendition.
  const commentPage = await call("/brief", { headers: { cookie: cCookie } });
  assert.ok(commentPage.text.includes('class="raw-frame-flow"'));
  assert.ok(commentPage.text.includes('id="comments"'));
  assert.ok(commentPage.text.includes('id="dkw-data"'));
  assert.ok(commentPage.text.includes('name="anchor_path"'));
  const commentRaw = await call("/brief/raw", { headers: { cookie: cCookie } });
  assert.ok(commentRaw.text.includes("dkw-bubble"), "comment session raw carries the bridge");

  // An anchored post from the html view returns to the html view.
  const posted = await postForm(
    "/brief/comments",
    {
      body: "Tighten this.",
      view: "html",
      anchor_path: "body:nth-of-type(1) > main:nth-of-type(1) > p:nth-of-type(1)",
      anchor_tag: "P",
      anchor_text: "Alpha paragraph.",
      quote: "Alpha paragraph.",
    },
    { cookie: cCookie },
  );
  assert.equal(posted.status, 303);
  assert.equal(posted.headers.get("location"), "/brief#comments");

  // A plain post (md view, no view field) still returns to the md view.
  const mdPosted = await postForm("/brief/comments", { body: "General note." }, { cookie: cCookie });
  assert.equal(mdPosted.headers.get("location"), "/brief?v=md#comments");

  // Both views list both comments (one pool per page); the anchored one
  // carries its reveal button and rides the anchor-data JSON.
  const htmlView = await call("/brief", { headers: { cookie: cCookie } });
  assert.ok(htmlView.text.includes("Tighten this."));
  assert.ok(htmlView.text.includes("General note."));
  assert.ok(htmlView.text.includes("Show in document"));
  assert.ok(htmlView.text.includes("anchor"), "anchor data rendered for the shell script");
  const mdView = await call("/brief?v=md", { headers: { cookie: cCookie } });
  assert.ok(mdView.text.includes("Tighten this."));
  assert.ok(!mdView.text.includes('id="dkw-data"'), "md view carries no anchoring layer");

  // The owner sees the anchor (normalized) over the moderation API.
  const list = await call("/api/pages/brief/comments", { token: OWNER });
  const anchored = list.json.comments.find((c) => c.body === "Tighten this.");
  assert.deepEqual(anchored.anchor, {
    path: "body:nth-of-type(1) > main:nth-of-type(1) > p:nth-of-type(1)",
    tag: "p",
    text: "Alpha paragraph.",
  });
  assert.equal(anchored.quote, "Alpha paragraph.");
  assert.equal(list.json.comments.find((c) => c.body === "General note.").anchor, undefined);

  // A malformed anchor never sinks the comment — it posts unanchored.
  await postForm(
    "/brief/comments",
    { body: "bad anchor", view: "html", anchor_path: "main > p", anchor_tag: "not a tag" },
    { cookie: cCookie },
  );
  const list2 = await call("/api/pages/brief/comments", { token: OWNER });
  assert.equal(list2.json.comments.find((c) => c.body === "bad anchor").anchor, undefined);

  // Deleting from the html view returns there too.
  const mine = list2.json.comments.find((c) => c.body === "General note.");
  const del = await postForm(`/brief/comments/${mine.id}/delete`, { view: "html" }, { cookie: cCookie });
  assert.equal(del.status, 303);
  assert.equal(del.headers.get("location"), "/brief#comments");

  await call("/api/pages/brief", { method: "DELETE", token: OWNER });
});

await test("html comments: html-only pages flow the section and return to themselves", async () => {
  await call("/api/pages/deck", {
    method: "PUT",
    token: OWNER,
    body: { title: "Deck", html: "<html><body><section><h2>Slide one</h2></section></body></html>" },
  });
  await call("/api/pages/deck/access/codes", {
    method: "POST",
    token: OWNER,
    body: { label: "Cody", code: "deck-comment-code", role: "comment" },
  });
  const cookie = cookieOf(await unlock("deck", "deck-comment-code"));

  const page = await call("/deck", { headers: { cookie } });
  assert.ok(page.text.includes('class="raw-frame-flow"'));
  assert.ok(page.text.includes('id="comments"'));
  assert.ok(page.text.includes('id="dkw-data"'));

  const posted = await postForm(
    "/deck/comments",
    {
      body: "Bigger title?",
      view: "html",
      anchor_path: "body:nth-of-type(1) > section:nth-of-type(1) > h2:nth-of-type(1)",
      anchor_tag: "h2",
      anchor_text: "Slide one",
      quote: "Slide one",
    },
    { cookie },
  );
  assert.equal(posted.headers.get("location"), "/deck#comments");
  const after = await call("/deck", { headers: { cookie } });
  assert.ok(after.text.includes("Bigger title?"));
  assert.ok(after.text.includes("Show in document"));

  await call("/api/pages/deck", { method: "DELETE", token: OWNER });
});

await test("web edit: save bumps rev, retitles, stamps webEdit; stale baseRev 409s", async () => {
  const editor = await call("/team-page/edit", { headers: { cookie: editCookie } });
  assert.equal(editor.status, 200);
  assert.ok(editor.text.includes('name="markdown"'));
  const revMatch = editor.text.match(/name="baseRev" value="(\d+)"/);
  assert.ok(revMatch, "editor carries the loaded revision");
  const baseRev = Number(revMatch[1]);

  const saved = await postForm(
    "/team-page/edit",
    { markdown: "# Renamed by the web\n\nnew body {>>smuggled comment<<}", baseRev: String(baseRev) },
    { cookie: editCookie },
  );
  assert.equal(saved.status, 303);
  assert.equal(saved.headers.get("location"), "/team-page");

  const page = await call("/team-page", { headers: { cookie: viewCookie } });
  assert.ok(page.text.includes("Renamed by the web"));
  assert.ok(page.text.includes("new body"));
  assert.ok(!page.text.includes("smuggled"), "CriticMarkup is stripped on web saves");

  const meta = await call("/api/pages/team-page", { token: OWNER });
  assert.equal(meta.json.title, "Renamed by the web", "lead H1 retitles the page");
  assert.equal(meta.json.rev, baseRev + 1);
  assert.equal(meta.json.webEdit.by, "Sam");

  const listRow = (await call("/api/pages", { token: OWNER })).json.pages.find(
    (p) => p.id === "team-page",
  );
  assert.equal(listRow.rev, baseRev + 1);
  assert.equal(listRow.webEdit.by, "Sam");

  // The app pulls the edited markdown back.
  const content = await call("/api/pages/team-page/content", { token: OWNER });
  assert.equal(content.status, 200);
  assert.ok(content.json.markdown.startsWith("# Renamed by the web"));
  assert.equal(content.json.rev, baseRev + 1);
  assert.equal(content.json.webEdit.by, "Sam");

  // A save from the revision that just got overwritten: 409, editor again,
  // the visitor's text preserved, the fresh rev in the form.
  const stale = await postForm(
    "/team-page/edit",
    { markdown: "# My stale attempt", baseRev: String(baseRev) },
    { cookie: editCookie },
  );
  assert.equal(stale.status, 409);
  assert.ok(stale.text.includes("My stale attempt"));
  assert.ok(stale.text.includes(`name="baseRev" value="${baseRev + 1}"`));
  assert.ok(stale.text.includes("changed while you were editing"));

  // Emptying the document from the web is refused.
  assert.equal(
    (
      await postForm(
        "/team-page/edit",
        { markdown: "  \n ", baseRev: String(baseRev + 1) },
        { cookie: editCookie },
      )
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
  const editorNow = await call("/team-page/edit", { headers: { cookie: editCookie } });
  const nowRev = Number(editorNow.text.match(/name="baseRev" value="(\d+)"/)[1]);
  await postForm(
    "/team-page/edit",
    { markdown: "# web again", baseRev: String(nowRev) },
    { cookie: editCookie },
  );
  const legacy = await call("/api/pages/team-page", {
    method: "PUT",
    token: OWNER,
    body: { title: "Legacy", markdown: "# legacy push" },
  });
  assert.equal(legacy.status, 200);
  assert.equal((await call("/api/pages/team-page", { token: OWNER })).json.webEdit, null);
});

await test("web edit: outdates the html rendition until the app replaces it", async () => {
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

  // With both renditions the link opens on the html frame.
  const before = await call("/dual-page", { headers: { cookie } });
  assert.ok(before.text.includes("/dual-page/raw"));

  const editor = await call("/dual-page/edit", { headers: { cookie } });
  assert.ok(editor.text.includes("polished HTML rendition"), "editor warns about the rendition");
  const rev = Number(editor.text.match(/name="baseRev" value="(\d+)"/)[1]);
  const saved = await postForm(
    "/dual-page/edit",
    { markdown: "# Dual\n\nedited on the web", baseRev: String(rev) },
    { cookie },
  );
  assert.equal(saved.headers.get("location"), "/dual-page?v=md");

  // The markdown (the edited truth) is now the default view; the stale
  // rendition stays reachable explicitly.
  const after = await call("/dual-page", { headers: { cookie } });
  assert.ok(after.text.includes("edited on the web"), "default view is the markdown");
  assert.ok(!after.text.includes('src="https://docs.test/dual-page/raw"'));
  assert.ok(after.text.includes("is-stale"), "the pill marks the rendition stale");
  const explicitHtml = await call("/dual-page?v=html", { headers: { cookie } });
  assert.ok(explicitHtml.text.includes("/dual-page/raw"), "?v=html still frames the rendition");
  assert.equal((await call("/api/pages/dual-page", { token: OWNER })).json.htmlStale, true);

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
  const restored = await call("/dual-page", { headers: { cookie } });
  assert.ok(restored.text.includes("/dual-page/raw"), "fresh rendition leads again");

  await call("/api/pages/dual-page", { method: "DELETE", token: OWNER });
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
  assert.ok(member.text.includes('id="comments"'), "folder role grants comments on members");
  assert.ok(member.text.includes("/role-member/edit"), "folder role grants editing members");
  const editor = await call("/role-member/edit", { headers: { cookie } });
  assert.equal(editor.status, 200);

  // Deleting a page also drops its comments object.
  await postForm("/role-member/comments", { body: "folder session comment" }, { cookie });
  assert.equal(
    (await call("/api/pages/role-member/comments", { token: OWNER })).json.comments.length,
    1,
  );
  await call("/api/pages/role-member", { method: "DELETE", token: OWNER });
  await call("/api/pages/role-member", {
    method: "PUT",
    token: OWNER,
    body: { title: "Member", markdown: "# fresh", collection: { id: "role-folder", title: "Folder" } },
  });
  const fresh = await call("/api/pages/role-member/comments", { token: OWNER });
  assert.deepEqual(fresh.json.comments, [], "comments died with the page");

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
