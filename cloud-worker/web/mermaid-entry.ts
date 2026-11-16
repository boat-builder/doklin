// Entry for the standalone mermaid module a domain serves at
// /__web/<tag>/mermaid.js. scripts/bundle-worker.mjs builds it into one ES
// module (mermaid's lazy diagram chunks flattened in — one file, one path)
// and writes it into the web directory Cloudflare serves beside the worker.
// A public page that carries a ```mermaid block loads it lazily to draw its
// diagrams in the same grammar and page-derived palette the editor uses —
// hence the config and post-processing re-exports. Browser code: typechecked with the app, never bundled
// into it.
export { default } from "mermaid";
export { finishMermaidSvg, mermaidConfig } from "../../src/mermaidTheme";
