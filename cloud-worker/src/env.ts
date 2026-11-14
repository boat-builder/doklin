// The worker's environment: what wrangler.toml binds and what the secret
// store holds. (Global runtime types — R2Bucket, ExecutionContext,
// ExportedHandler — come from @cloudflare/workers-types via tsconfig.)

export interface Env {
  /** The R2 bucket behind this domain: `[[r2_buckets]] binding = "DATA"`. */
  DATA: R2Bucket;
  /** The owner's bearer token — `wrangler secret put OWNER_TOKEN`; the app mints it at setup. */
  OWNER_TOKEN?: string;
  /** The D1 database beside the bucket: `[[d1_databases]] binding = "DB"`.
   *  Optional on purpose — a domain deployed before the binding existed has
   *  none, and every route works without one (schema.ts). */
  DB?: D1Database;
  /** Never bound: the worker sets it on the `Env` it hands a space's routes
   *  (spaces.ts). `DATA` is then that space's part of the bucket and `whole`
   *  the bucket itself. Absent for the shared workspace. */
  SPACE?: { id: string; whole: R2Bucket };
}
