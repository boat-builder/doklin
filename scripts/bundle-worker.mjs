#!/usr/bin/env node
// Bundle the backend worker (share-worker/src + its vendored marked) into ONE
// deployable JavaScript file — the same transform the app build applies for
// its virtual:share-worker-code module (vite.config.ts), just written to disk.
//
// The release workflow attaches the output to every GitHub release as
// `doklin-worker.js`, giving setup/update instructions a stable URL:
//
//   https://github.com/boat-builder/doklin/releases/latest/download/doklin-worker.js
//
// so an agent (or a person) can deploy or update a backend with a single
// download — no clone, no build step.
//
//   node scripts/bundle-worker.mjs [outfile]     (default: share-worker/dist/doklin-worker.js)

import { build } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { buildWebAssets, webAssetsInjector } from "./build-web.mjs";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(repoRoot, "share-worker", "src", "index.js");
const dest = path.resolve(
  process.argv[2] ?? path.join(repoRoot, "share-worker", "dist", "doklin-worker.js"),
);

// The worker carries its own frontend (the app shell comment/edit sessions
// load — see share-worker/src/webAssets.js): build it first, splice it in.
const web = await buildWebAssets();

const out = await build({
  configFile: false,
  logLevel: "warn",
  plugins: [webAssetsInjector(web)],
  build: {
    write: false,
    minify: false, // stay readable — people are asked to trust-deploy this
    // (the embedded frontend is minified: it's the same app build the
    // desktop ships, injected as data)
    target: "es2022",
    lib: { entry, formats: ["es"], fileName: "doklin-worker" },
  },
});
const result = Array.isArray(out) ? out[0] : out;
if (!("output" in result)) throw new Error("unexpected watcher from worker build");
const chunk = result.output.find((o) => o.type === "chunk");
if (!chunk) throw new Error("worker bundle produced no chunk");

fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, chunk.code);

const version = chunk.code.match(/^const WORKER_VERSION = (\d+);$/m)?.[1] ?? "?";
console.log(`wrote ${dest} (${(chunk.code.length / 1024).toFixed(0)} KB, WORKER_VERSION ${version})`);
