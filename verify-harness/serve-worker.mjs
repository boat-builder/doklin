// Serves the cloud worker over plain node http so a real browser can walk
// the public pages of the seed workspace (cloud-worker/test/seed.mjs) —
// what drive-public.mjs drives. The worker is bundled in-process the way
// the release asset is (the mermaid module spliced in, about a minute)
// unless --no-mermaid; the bucket and the cache are the in-memory fakes the
// worker tests use; state resets on restart.
//
//   node verify-harness/serve-worker.mjs [--no-mermaid]   # http://localhost:8787, owner token "owner-secret"
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { FakeCache, FakeR2 } from "../cloud-worker/test/fake-r2.mjs";
import { seedThroughApi } from "../cloud-worker/test/seed.mjs";
import { bundleWorker } from "../scripts/bundle-worker.mjs";

const PORT = Number(process.env.PORT || 8787);
const OWNER = "owner-secret";
const withMermaid = !process.argv.includes("--no-mermaid");

console.log(`bundling the worker${withMermaid ? " with the mermaid module (about a minute)" : ""}…`);
const { code } = await bundleWorker({ mermaid: withMermaid });
const distDir = new URL("../cloud-worker/dist/", import.meta.url);
mkdirSync(distDir, { recursive: true });
const out = new URL("serve-worker.js", distDir);
writeFileSync(out, code);
const { default: worker } = await import(`${pathToFileURL(out.pathname).href}?t=${Date.now()}`);

const env = { OWNER_TOKEN: OWNER, DATA: new FakeR2() };
// The runtime's cache, so the harness exercises the same path a deploy does.
globalThis.caches = { default: new FakeCache() };
const etag = await seedThroughApi(worker, env, { token: OWNER });
console.log(`seeded the workspace (manifest ${etag})`);

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
