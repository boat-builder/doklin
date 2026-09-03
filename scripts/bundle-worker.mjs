#!/usr/bin/env node
// Bundle the cloud worker (cloud-worker/src, TypeScript) into ONE deployable
// JavaScript file, readable — people are asked to trust-deploy it — with the
// standalone mermaid module spliced in as data (cloud-worker/src/assets.ts).
//
// The release workflow attaches the output to every GitHub release as
// `doklin-cloud-worker.js`, giving the app's setup and update prompts a
// stable URL:
//
//   https://github.com/boat-builder/doklin/releases/latest/download/doklin-cloud-worker.js
//
// so an agent (or a person) deploys or updates a domain with one download —
// no clone, no build step.
//
//   node scripts/bundle-worker.mjs [outfile]   (default: cloud-worker/dist/doklin-cloud-worker.js)
//   node scripts/bundle-worker.mjs --no-mermaid   a quick local bundle without the
//                                                 mermaid module (the /__web asset 503s)
//
// Prints the size raw and gzipped — Cloudflare's free plan caps a worker at
// 3 MB compressed, and mermaid is most of what this carries — and fails the
// build past the cap rather than letting the deploy be the first to notice.

import { build } from "vite";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";
import { createHash } from "node:crypto";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerDir = path.join(repoRoot, "cloud-worker");

const GZIP_CEILING = 3 * 1024 * 1024;

/** One lib-mode vite build, returned as the code of its single chunk. */
async function bundle(entry, fileName, plugins = []) {
  const out = await build({
    configFile: false,
    logLevel: "warn",
    plugins,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      write: false,
      minify: false,
      target: "es2022",
      lib: { entry, formats: ["es"], fileName },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
  const result = Array.isArray(out) ? out[0] : out;
  if (!("output" in result)) throw new Error(`unexpected watcher from the ${fileName} build`);
  const chunk = result.output.find((o) => o.type === "chunk");
  if (!chunk) throw new Error(`the ${fileName} build produced no chunk`);
  const strays = result.output.filter((o) => o !== chunk);
  if (strays.length > 0) {
    throw new Error(
      `the ${fileName} build emitted extra files: ${strays.map((s) => s.fileName).join(", ")}`,
    );
  }
  return chunk.code;
}

// The standalone mermaid module (cloud-worker/web/mermaid-entry.ts): the npm
// package plus the app's palette derivation, flattened to one ES file.
export async function buildMermaidModule() {
  return bundle(path.join(workerDir, "web", "mermaid-entry.ts"), "mermaid");
}

// A rollup plugin that splices the built assets into cloud-worker/src/assets.ts
// — how the checked-in empty stub becomes the real thing. The tag is a short
// content hash of the module: the worker keys the immutable asset URL on it,
// so a redeploy that changes mermaid busts the browser cache even without a
// WORKER_VERSION bump.
export function assetsInjector(mermaid) {
  const tag = createHash("sha256").update(mermaid).digest("hex").slice(0, 12);
  return {
    name: "doklin-inject-web-assets",
    transform(_code, id) {
      if (!id.replace(/\\/g, "/").endsWith("cloud-worker/src/assets.ts")) return undefined;
      return {
        code: `export const WEB_ASSETS = { tag: ${JSON.stringify(tag)}, mermaid: ${JSON.stringify(mermaid)} };\n`,
        map: null,
      };
    },
  };
}

/** The whole worker as one ES module string — with the mermaid module spliced in unless told not to. */
export async function bundleWorker({ mermaid = true } = {}) {
  const module = mermaid ? await buildMermaidModule() : null;
  const code = await bundle(
    path.join(workerDir, "src", "index.ts"),
    "doklin-cloud-worker",
    module === null ? [] : [assetsInjector(module)],
  );
  return { code, mermaid: module };
}

// The command line: bundle, write, measure. Guarded so the harness can
// import bundleWorker without running a build at import time.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const withMermaid = !args.includes("--no-mermaid");
  const outArg = args.find((a) => !a.startsWith("--"));
  const dest = path.resolve(outArg ?? path.join(workerDir, "dist", "doklin-cloud-worker.js"));

  const { code, mermaid } = await bundleWorker({ mermaid: withMermaid });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, code);

  const version = code.match(/^const WORKER_VERSION = (\d+);$/m)?.[1];
  if (!version) throw new Error("WORKER_VERSION did not survive bundling in a parseable shape");
  const gz = zlib.gzipSync(Buffer.from(code)).length;
  const kb = (n) => (n / 1024).toFixed(0);
  console.log(
    `wrote ${dest} (${kb(code.length)} KB, ${kb(gz)} KB gzipped, WORKER_VERSION ${version}` +
      `${mermaid === null ? ", no mermaid module" : `, mermaid ${kb(mermaid.length)} KB`})`,
  );
  if (gz > GZIP_CEILING) {
    console.error(
      `::error::the worker is ${kb(gz)} KB gzipped — over the ${kb(GZIP_CEILING)} KB free-plan ceiling`,
    );
    process.exit(1);
  }
}
