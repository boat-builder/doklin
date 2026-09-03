// Entry for the standalone mermaid module the cloud worker serves at
// /__web/<tag>/mermaid.js. scripts/bundle-worker.mjs builds it into one ES
// module string (mermaid's lazy diagram chunks flattened in — there is no
// second asset route to load them from) and splices it into src/assets.ts.
// A public page that carries a ```mermaid block loads it lazily to draw its
// diagrams with the same page-derived palette the editor uses — hence the
// theme re-export. Browser code: typechecked with the app, never bundled
// into it.
export { default } from "mermaid";
export { mermaidThemeVariables } from "../../src/mermaidTheme";
