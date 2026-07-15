// The shared-page app shell's compiled assets — injected at bundle time.
//
// The checked-in copy is an empty shell so plain-node consumers (the test
// suite, verify-harness/serve-worker.mjs) can import the worker without a
// frontend build. Every deployable artifact gets the real thing: both
// single-file bundlers (scripts/bundle-worker.mjs and vite.config.ts's
// virtual:share-worker-code plugin) build web/main.tsx via
// scripts/build-web.mjs and swap this module's content for
//
//   export const WEB_APP = { js: "<ES module source>", css: "<stylesheet>" };
//
//   export const WEB_APP = { tag: "<content hash>", js: "...", css: "..." };
//
// (`tag` is a short content hash of the bundle; the worker uses it as the
// cache key in the shell's asset URLs.)
//
// Local serving without injection: `node scripts/build-web.mjs` writes the
// same two files to share-worker/dist/web/, which serve-worker.mjs serves in
// place of the /__web routes.
export const WEB_APP = null;
