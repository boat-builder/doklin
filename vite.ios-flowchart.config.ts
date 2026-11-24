// The flowchart renderer for the iPhone's reader (src/flowchart/phone.ts):
// one classic script, ios/Editor/flowchart.js, beside the note editor that
// vite.ios-editor.config.ts builds there first (so this one must not empty
// the folder). scripts/ios-editor.sh runs both and copies the folder into
// the app. The app runs the script in a JavaScript context with no page:
// nothing in it may ask for a window, a document or a console.
import { defineConfig } from "vite";

export default defineConfig({
  logLevel: "warn",
  build: {
    outDir: "ios/Editor",
    emptyOutDir: false,
    copyPublicDir: false,
    target: "safari18",
    reportCompressedSize: false,
    lib: {
      entry: "src/flowchart/phone.ts",
      formats: ["iife"],
      name: "DoklinFlowchart",
      fileName: () => "flowchart.js",
    },
  },
});
