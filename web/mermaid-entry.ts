// Entry for the standalone mermaid asset the share worker serves at
// /__web/<tag>/mermaid.js (built by scripts/build-web.mjs into one ES module
// string, embedded in the worker next to the app shell's bundle).
//
// Two consumers import it at runtime:
//   - the app shell (src/mermaid.ts): window.__DK_MERMAID_URL points here, so
//     the shell's own bundle stays lean — mermaid only travels the wire when
//     a document actually contains a diagram.
//   - the worker's static read-only pages: a small inline script renders
//     ```mermaid blocks with it (share-worker/src/index.js), using the same
//     page-derived palette the editor uses — hence the theme re-export.
export { default } from "mermaid";
export { mermaidThemeVariables } from "../src/mermaidTheme";
