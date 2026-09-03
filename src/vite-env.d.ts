/// <reference types="vite/client" />

// Build-time constants parsed out of cloud-worker/src/version.ts by the
// plugin in vite.config.ts (docs/cloud.md §7.1): the worker
// version this app was built for and the runtime date its wrangler.toml
// pins. Read through src/cloud.ts.
declare module "virtual:cloud-worker-version" {
  export const WORKER_VERSION: number;
  export const MANIFEST_VERSION: number;
  export const COMPATIBILITY_DATE: string;
}
