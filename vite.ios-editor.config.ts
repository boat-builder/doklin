// The iPhone's note editor (src/ios-editor/): built into ios/Editor/, which
// scripts/ios-editor.sh copies into the app. The app serves it from a scheme
// of its own (`doklin-editor://app/`), so its paths are absolute and its
// chunks load as modules. Nothing in it fetches: the app blocks every load
// that is not its own.
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/ios-editor",
  base: "/",
  logLevel: "warn",
  build: {
    outDir: "../../ios/Editor",
    emptyOutDir: true,
    target: "safari18",
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4000,
    reportCompressedSize: false,
  },
});
