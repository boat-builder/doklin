// The tag of the web directory a release serves beside the worker:
// scripts/bundle-worker.mjs builds that directory and splices its tag in
// here. Cloudflare answers the directory's files without running the worker
// — the fonts, the icons, og.png, robots.txt, and the mermaid module at
// /__web/<tag>/mermaid.js, where the tag is a short hash of the module, so a
// build that changes it changes its address. A worker compiled from source
// (test/run.mjs) has no web directory, and its pages ask for "dev".
export const WEB_TAG: string = "dev";
