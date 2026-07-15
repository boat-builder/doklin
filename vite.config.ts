import { defineConfig, build as viteBuild, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Bundles the share worker (share-worker/src + its vendored marked + the
// compiled app shell the worker serves to comment/edit sessions) into a
// single ES-module string the app imports as `virtual:share-worker-code`.
// This is what makes the setup guide's "Copy worker code" button possible:
// installed-app users paste it into the Cloudflare dashboard editor and never
// touch the repo. Bundled with vite's own programmatic builds (nested,
// in-memory) so no extra dependency is needed.
function shareWorkerCode(): Plugin {
  const virtualId = "virtual:share-worker-code";
  const resolvedId = `\0${virtualId}`;
  const entry = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "share-worker/src/index.js",
  );
  return {
    name: "share-worker-code",
    resolveId(id) {
      return id === virtualId ? resolvedId : undefined;
    },
    async load(id) {
      if (id !== resolvedId) return undefined;
      // Plain node module (shared with scripts/bundle-worker.mjs) — no types.
      const { buildWebAssets, webAssetsInjector } = (await import(
        "./scripts/build-web.mjs"
      )) as {
        buildWebAssets: () => Promise<{ js: string; css: string }>;
        webAssetsInjector: (web: { js: string; css: string }) => Plugin;
      };
      const web = await buildWebAssets();
      const out = await viteBuild({
        configFile: false,
        logLevel: "warn",
        plugins: [webAssetsInjector(web)],
        build: {
          write: false,
          minify: false, // stay readable — users are asked to trust-paste this
          target: "es2022",
          lib: { entry, formats: ["es"], fileName: "share-worker" },
        },
      });
      const result = Array.isArray(out) ? out[0] : out;
      if (!("output" in result)) throw new Error("unexpected watcher from worker build");
      const chunk = result.output.find((o) => o.type === "chunk");
      if (!chunk) throw new Error("share worker bundle produced no chunk");
      return `export default ${JSON.stringify(chunk.code)};\n`;
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), shareWorkerCode()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
