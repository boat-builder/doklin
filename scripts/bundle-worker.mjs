#!/usr/bin/env node
// Bundle the cloud worker (cloud-worker/src, TypeScript) into ONE deployable
// JavaScript file, readable — people are asked to trust-deploy it — and build
// the web directory Cloudflare serves beside it as static assets: the files
// public pages ask for, answered without running the worker, so they cost
// none of the day's requests. It is doklin-cloud-web/, beside the worker file:
//
//   __web/<tag>/mermaid.js   the standalone mermaid module (cloud-worker/web/mermaid-entry.ts)
//   __web/fonts/<file>       the fonts src/styles/fonts.css names, from src/assets/fonts/
//   favicon.ico, apple-touch-icon.png   the app's own, from public/
//   og.png, robots.txt, _headers        from cloud-worker/web/
//
// The tag is a short content hash of the mermaid module, spliced into the
// worker (cloud-worker/src/assets.ts) so its pages ask for the module at the
// path this build wrote it to.
//
// The release workflow attaches both to every GitHub release —
// `doklin-cloud-worker.js` and `doklin-cloud-web.tar.gz`, which unpacks to the
// directory —
// giving the app's setup prompt and the update script stable URLs:
//
//   https://github.com/boat-builder/doklin/releases/latest/download/doklin-cloud-worker.js
//   https://github.com/boat-builder/doklin/releases/latest/download/doklin-cloud-web.tar.gz
//
// so an agent (or a person) deploys or updates a domain with two downloads —
// no clone, no build step.
//
//   node scripts/bundle-worker.mjs [outfile]   (default: cloud-worker/dist/doklin-cloud-worker.js;
//                                               doklin-cloud-web/ goes beside it)
//   node scripts/bundle-worker.mjs --no-mermaid   a quick local build without the mermaid
//                                                 module (pages ask for /__web/dev/mermaid.js)
//
// Prints the sizes, and fails the build past Cloudflare's free-plan cap of
// 3 MB compressed for the worker rather than letting the deploy be the first
// to notice.

import { build } from "vite";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";
import { createHash } from "node:crypto";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerDir = path.join(repoRoot, "cloud-worker");

const GZIP_CEILING = 3 * 1024 * 1024;

/** The tag of a build without the mermaid module — what a source compile says too. */
export const DEV_TAG = "dev";

/** The web directory's name, beside the worker file — wrangler.toml's
 *  `[assets] directory`, and what the release's archive unpacks to. */
export const WEB_DIR = "doklin-cloud-web";

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
async function buildMermaidModule() {
  return bundle(path.join(workerDir, "web", "mermaid-entry.ts"), "mermaid");
}

/**
 * The font files src/styles/fonts.css names, as [family, file] — read with
 * the pattern cloud-worker/src/theme.ts rewrites, so every face a page
 * declares is a file this build copies. Two files of one name would land on
 * one path, so they are refused.
 */
function fontFiles() {
  const css = fs.readFileSync(path.join(repoRoot, "src", "styles", "fonts.css"), "utf8");
  const files = [...css.matchAll(/url\("\.\.\/assets\/fonts\/([a-z-]+)\/([^"]+)"\)/g)].map((m) => [m[1], m[2]]);
  if (files.length === 0) throw new Error("fonts.css names no font files");
  const names = new Set();
  for (const [, file] of files) {
    if (names.has(file)) throw new Error(`fonts.css names two fonts called ${file}`);
    names.add(file);
  }
  return files;
}

/**
 * Write the web directory to `dir` (emptied first) and return its tag: the
 * mermaid module's content hash, or DEV_TAG without one.
 */
export async function buildWeb(dir, { mermaid = true } = {}) {
  fs.rmSync(dir, { recursive: true, force: true });
  const put = (rel, bytes) => {
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes);
  };
  const copy = (rel, from) => put(rel, fs.readFileSync(from));

  let tag = DEV_TAG;
  if (mermaid) {
    const module = await buildMermaidModule();
    tag = createHash("sha256").update(module).digest("hex").slice(0, 12);
    put(`__web/${tag}/mermaid.js`, module);
  }
  for (const [family, file] of fontFiles()) {
    copy(`__web/fonts/${file}`, path.join(repoRoot, "src", "assets", "fonts", family, file));
  }
  copy("favicon.ico", path.join(repoRoot, "public", "favicon.ico"));
  copy("apple-touch-icon.png", path.join(repoRoot, "public", "apple-touch-icon.png"));
  for (const file of ["og.png", "robots.txt", "_headers"]) copy(file, path.join(workerDir, "web", file));
  return tag;
}

// A rollup plugin that splices the web directory's tag into
// cloud-worker/src/assets.ts — how the checked-in "dev" becomes this build's.
function tagInjector(tag) {
  return {
    name: "doklin-inject-web-tag",
    transform(_code, id) {
      if (!id.replace(/\\/g, "/").endsWith("cloud-worker/src/assets.ts")) return undefined;
      return { code: `export const WEB_TAG = ${JSON.stringify(tag)};\n`, map: null };
    },
  };
}

/** The whole worker as one ES module string, its pages asking for the web directory tagged `tag`. */
export async function bundleWorker(tag) {
  return bundle(path.join(workerDir, "src", "index.ts"), "doklin-cloud-worker", [tagInjector(tag)]);
}

/** Every file under `dir`, as [relative path, size]. */
function listFiles(dir, prefix = "") {
  return fs.readdirSync(path.join(dir, prefix), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(prefix, e.name);
    return e.isDirectory() ? listFiles(dir, rel) : [[rel, fs.statSync(path.join(dir, rel)).size]];
  });
}

// The command line: build, write, measure. Guarded so the harness can import
// buildWeb and bundleWorker without running a build at import time.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const withMermaid = !args.includes("--no-mermaid");
  const outArg = args.find((a) => !a.startsWith("--"));
  const dest = path.resolve(outArg ?? path.join(workerDir, "dist", "doklin-cloud-worker.js"));
  const webDir = path.join(path.dirname(dest), WEB_DIR);

  const tag = await buildWeb(webDir, { mermaid: withMermaid });
  const code = await bundleWorker(tag);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, code);

  const version = code.match(/^const WORKER_VERSION = (\d+);$/m)?.[1];
  if (!version) throw new Error("WORKER_VERSION did not survive bundling in a parseable shape");
  const gz = zlib.gzipSync(Buffer.from(code)).length;
  const kb = (n) => (n / 1024).toFixed(0);
  const files = listFiles(webDir);
  const webBytes = files.reduce((n, [, size]) => n + size, 0);
  console.log(`wrote ${dest} (${kb(code.length)} KB, ${kb(gz)} KB gzipped, WORKER_VERSION ${version})`);
  console.log(`wrote ${webDir} (${files.length} files, ${kb(webBytes)} KB, tag ${tag})`);
  if (gz > GZIP_CEILING) {
    console.error(
      `::error::the worker is ${kb(gz)} KB gzipped — over the ${kb(GZIP_CEILING)} KB free-plan ceiling`,
    );
    process.exit(1);
  }
}
