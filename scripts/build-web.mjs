#!/usr/bin/env node
// Build the shared-page app shell (web/main.tsx — the SAME editor components
// the desktop renders) into exactly three strings: one ES-module JS file, one
// CSS file with every asset (KaTeX fonts, icons) inlined as data: URIs, and a
// standalone mermaid module (web/mermaid-entry.ts). Mermaid rides its own
// file — served at /__web/<tag>/mermaid.js — because it's ~1 MB gz that only
// documents with diagrams should ever pay for: the shell imports it lazily
// (the app build compiles its npm-import branch away via the DK_WEB define —
// see src/mermaid.ts), and the worker's static pages use the same module to
// render ```mermaid blocks.
//
// Two consumers:
//   - `node scripts/build-web.mjs` writes them to share-worker/dist/web/
//     (app.js + app.css + mermaid.js) for local serving —
//     verify-harness/serve-worker.mjs picks them up so a real browser can
//     drive the real thing.
//   - the worker bundlers (scripts/bundle-worker.mjs and vite.config.ts's
//     virtual:share-worker-code plugin) call buildWebAssets() and inject the
//     strings into share-worker/src/webAssets.js, so the deployable worker
//     stays ONE file that carries its own frontend.

import { build } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";
import { createHash } from "node:crypto";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function buildWebAssets() {
  const out = await build({
    configFile: false,
    logLevel: "warn",
    plugins: [react()],
    define: {
      // Lib builds don't substitute this the way app builds do, and React's
      // dev/prod split reads it at runtime.
      "process.env.NODE_ENV": JSON.stringify("production"),
      // Web build marker: src/mermaid.ts drops its import("mermaid") branch,
      // keeping the npm package out of this bundle — the shell loads the
      // standalone module below through window.__DK_MERMAID_URL instead.
      "import.meta.env.DK_WEB": "true",
    },
    build: {
      write: false,
      target: "es2022",
      cssCodeSplit: false,
      // Everything the CSS references (fonts, images) rides inside it — the
      // worker serves exactly two asset routes, nothing hashed, nothing else.
      assetsInlineLimit: Number.MAX_SAFE_INTEGER,
      lib: {
        entry: path.join(repoRoot, "web", "main.tsx"),
        formats: ["es"],
        fileName: "app",
      },
      rollupOptions: {
        output: { inlineDynamicImports: true },
      },
    },
  });
  const result = Array.isArray(out) ? out[0] : out;
  if (!("output" in result)) throw new Error("unexpected watcher from web build");
  const chunk = result.output.find((o) => o.type === "chunk");
  if (!chunk) throw new Error("web build produced no JS chunk");
  const cssAsset = result.output.find(
    (o) => o.type === "asset" && o.fileName.endsWith(".css"),
  );
  let css = cssAsset ? String(cssAsset.source) : "";
  // Every @font-face src carries inlined woff2 + woff + ttf copies (KaTeX
  // ships all three); the fallbacks can never be reached once the woff2 is a
  // data: URI, so drop them — they'd triple what the worker embeds.
  // (Data URIs contain semicolons, so the declaration is matched as a chain
  // of url(...) format(...) pairs, not up-to-the-next-semicolon.)
  css = css.replace(
    /src:\s*(url\([^)]*\)(?:\s*format\([^)]*\))?(?:\s*,\s*url\([^)]*\)(?:\s*format\([^)]*\))?)*)/g,
    (whole, srcs) => {
      const parts = srcs.split(/,\s*(?=url\()/);
      const woff2 = parts.filter((p) => /format\(['"]?woff2['"]?\)/.test(p));
      return woff2.length > 0 ? `src:${woff2.join(",")}` : whole;
    },
  );
  const strays = result.output.filter(
    (o) => o !== chunk && o !== cssAsset && o.type === "asset",
  );
  if (strays.length > 0) {
    // A non-inlined asset would 404 when served from the worker — fail loudly.
    throw new Error(
      `web build emitted un-inlined assets: ${strays.map((s) => s.fileName).join(", ")}`,
    );
  }
  return { js: chunk.code, css, mermaid: await buildMermaidAsset() };
}

// The standalone mermaid module (see the header): the npm package plus the
// app's palette derivation (src/mermaidTheme.ts), flattened to one ES file —
// mermaid's internal lazy diagram chunks must ride along, there is no second
// asset route to load them from.
async function buildMermaidAsset() {
  const out = await build({
    configFile: false,
    logLevel: "warn",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      write: false,
      target: "es2022",
      lib: {
        entry: path.join(repoRoot, "web", "mermaid-entry.ts"),
        formats: ["es"],
        fileName: "mermaid",
      },
      rollupOptions: {
        output: { inlineDynamicImports: true },
      },
    },
  });
  const result = Array.isArray(out) ? out[0] : out;
  if (!("output" in result)) throw new Error("unexpected watcher from mermaid build");
  const chunk = result.output.find((o) => o.type === "chunk");
  if (!chunk) throw new Error("mermaid build produced no chunk");
  return chunk.code;
}

// A rollup/vite plugin that splices built web assets into the worker's
// webAssets.js module — how both single-file worker bundlers (see this
// script's header) turn the checked-in empty shell into the real thing. The
// `tag` is a short content hash of the bundle: the worker uses it as the
// cache key in the shell's asset URLs, so a redeploy that changes the shell
// (even without a WORKER_VERSION bump) busts the immutable browser cache.
export function webAssetsInjector(web) {
  const tag = createHash("sha256")
    .update(web.js)
    .update(web.css)
    .update(web.mermaid)
    .digest("hex")
    .slice(0, 12);
  return {
    name: "doklin-inject-web-assets",
    transform(_code, id) {
      if (!id.replace(/\\/g, "/").endsWith("share-worker/src/webAssets.js")) return undefined;
      return `export const WEB_APP = { tag: ${JSON.stringify(tag)}, js: ${JSON.stringify(
        web.js,
      )}, css: ${JSON.stringify(web.css)}, mermaid: ${JSON.stringify(web.mermaid)} };\n`;
    },
  };
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { js, css, mermaid } = await buildWebAssets();
  const dest = path.join(repoRoot, "share-worker", "dist", "web");
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, "app.js"), js);
  fs.writeFileSync(path.join(dest, "app.css"), css);
  fs.writeFileSync(path.join(dest, "mermaid.js"), mermaid);
  const gz = (s) => (zlib.gzipSync(Buffer.from(s)).length / 1024).toFixed(0);
  console.log(
    `wrote ${dest}/app.js (${(js.length / 1024).toFixed(0)} KB, ${gz(js)} KB gz), ` +
      `app.css (${(css.length / 1024).toFixed(0)} KB, ${gz(css)} KB gz), ` +
      `and mermaid.js (${(mermaid.length / 1024).toFixed(0)} KB, ${gz(mermaid)} KB gz)`,
  );
}
