// Assets the bundle carries beside the worker's own code, spliced in by
// scripts/bundle-worker.mjs: the standalone mermaid module public pages
// hydrate their ```mermaid blocks with (served at /__web/<tag>/mermaid.js,
// immutable, content-tagged — `tag` is a short hash of the module). The
// checked-in copy is empty so plain-node consumers (test/run.mjs) can compile
// the worker without building mermaid; every deployable artifact gets the
// real thing.
export const WEB_ASSETS: { tag: string; mermaid: string } | null = null;
