/// <reference types="vite/client" />

// The share worker, bundled to one ES-module string at build time by the
// share-worker-code plugin in vite.config.ts (for the setup guide's
// "Copy worker code" button).
declare module "virtual:share-worker-code" {
  const code: string;
  export default code;
}
