import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error node builtins have no types in this project (this file sits outside the app's tsconfig)
import { readFileSync } from "node:fs";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// The worker's version integer and the runtime date wrangler.toml pins,
// parsed out of cloud-worker/src/version.ts and served to the app as
// `virtual:cloud-worker-version` (docs/cloud.md §7.1). Parsed,
// never mirrored — the same rule src-tauri/build.rs follows for the Rust
// side — so the update badge and the setup prompt can't drift from the
// worker they describe.
const VERSION_FILE = new URL("./cloud-worker/src/version.ts", import.meta.url);
const VIRTUAL_ID = "virtual:cloud-worker-version";
const RESOLVED_ID = "\0" + VIRTUAL_ID;

function cloudWorkerVersion() {
  const constant = (src: string, name: string, kind: "int" | "string"): string => {
    const re =
      kind === "int"
        ? new RegExp(`^export const ${name} = (\\d+);$`, "m")
        : new RegExp(`^export const ${name} = "([^"]+)";$`, "m");
    const m = src.match(re);
    if (!m) throw new Error(`cloud-worker/src/version.ts has no \`export const ${name} = …;\` line`);
    return kind === "int" ? m[1] : JSON.stringify(m[1]);
  };
  return {
    name: "doklin:cloud-worker-version",
    resolveId(id: string) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null;
    },
    load(id: string) {
      if (id !== RESOLVED_ID) return null;
      this.addWatchFile(decodeURIComponent(VERSION_FILE.pathname));
      const src = readFileSync(VERSION_FILE, "utf8");
      return [
        `export const WORKER_VERSION = ${constant(src, "WORKER_VERSION", "int")};`,
        `export const MANIFEST_VERSION = ${constant(src, "MANIFEST_VERSION", "int")};`,
        `export const COMPATIBILITY_DATE = ${constant(src, "COMPATIBILITY_DATE", "string")};`,
        "",
      ].join("\n");
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), cloudWorkerVersion()],

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
