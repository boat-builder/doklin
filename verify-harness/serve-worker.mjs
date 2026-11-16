// Serves the cloud worker over plain node http so a real browser can walk
// the public pages of the seed workspace (cloud-worker/test/seed.mjs) —
// what drive-public.mjs drives. The worker and its web directory are built
// in-process the way the release's are (the mermaid module takes about a
// minute; --no-mermaid skips it), and the web directory answers in front of
// the worker as Cloudflare's asset layer does (cloud-worker/test/assets.mjs);
// the bucket, the database and the cache are the in-memory fakes the worker
// tests use; state resets on restart.
//
//   node verify-harness/serve-worker.mjs [--no-mermaid]   # http://localhost:8787
//
// The domain's key is "owner-secret", and it is spent at start: traded, as an
// app would at setup, for the superadmin's device sign-in, which the seed is
// written with and which is printed — `superadmin token: <hex>` — for a
// driver that needs to act as them.
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { withAssets } from "../cloud-worker/test/assets.mjs";
import { FakeCache, FakeR2 } from "../cloud-worker/test/fake-r2.mjs";
import { FakeD1 } from "../cloud-worker/test/fake-d1.mjs";
import { seedThroughApi } from "../cloud-worker/test/seed.mjs";
import { WEB_DIR, buildWeb, bundleWorker } from "../scripts/bundle-worker.mjs";

const PORT = Number(process.env.PORT || 8787);
const KEY = "owner-secret";
const withMermaid = !process.argv.includes("--no-mermaid");

console.log(`bundling the worker${withMermaid ? " with the mermaid module (about a minute)" : ""}…`);
const distDir = new URL("../cloud-worker/dist/serve-worker/", import.meta.url);
mkdirSync(distDir, { recursive: true });
const webDir = new URL(`${WEB_DIR}/`, distDir).pathname;
const code = await bundleWorker(await buildWeb(webDir, { mermaid: withMermaid }));
const out = new URL("serve-worker.js", distDir);
writeFileSync(out, code);
const worker = withAssets((await import(`${pathToFileURL(out.pathname).href}?t=${Date.now()}`)).default, webDir);

const env = { OWNER_TOKEN: KEY, DATA: new FakeR2(), DB: new FakeD1() };
// The runtime's cache, so the harness exercises the same path a deploy does.
globalThis.caches = { default: new FakeCache() };
const traded = await worker.fetch(
  new Request(`http://localhost:${PORT}/api/auth/recover`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", "x-doklin-device": "d-seed" },
    body: JSON.stringify({ email: "sherin@example.com", name: "Sherin", deviceId: "d-seed", deviceName: "Sherin's MacBook Pro" }),
  }),
  env,
);
if (traded.status !== 201) throw new Error(`trading the key failed: ${traded.status} ${await traded.text()}`);
const { token } = await traded.json();
const etag = await seedThroughApi(worker, env, { token });
console.log(`seeded the workspace (manifest ${etag})`);
console.log(`superadmin token: ${token}`);

const ctx = {
  waitUntil(p) {
    p.catch(() => {});
  },
};

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers.set(k, v);
    else if (Array.isArray(v)) for (const one of v) headers.append(k, one);
  }
  const request = new Request(`http://localhost:${PORT}${req.url}`, {
    method: req.method,
    headers,
    ...(body.length > 0 ? { body, duplex: "half" } : {}),
  });
  let response;
  try {
    response = await worker.fetch(request, env, ctx);
  } catch (e) {
    res.writeHead(500);
    res.end(String(e?.stack || e));
    return;
  }
  const outHeaders = {};
  response.headers.forEach((v, k) => {
    outHeaders[k] = v;
  });
  res.writeHead(response.status, outHeaders);
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(PORT, () => console.log(`cloud worker on http://localhost:${PORT}`));
