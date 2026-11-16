// The worker's environment: what wrangler.toml binds and what the secret
// store holds. (Global runtime types — R2Bucket, ExecutionContext,
// ExportedHandler — come from @cloudflare/workers-types via tsconfig.)

export interface Env {
  /** The R2 bucket behind this domain: `[[r2_buckets]] binding = "DATA"`. */
  DATA: R2Bucket;
  /** The domain's key — `wrangler secret put OWNER_TOKEN`; the app mints a
   *  fresh one for setup and for each recovery. Never a sign-in: it is
   *  traded, once, for a superadmin's device sign-in (auth.ts, api.ts). */
  OWNER_TOKEN?: string;
  /** The D1 database beside the bucket: `[[d1_databases]] binding = "DB"`.
   *  Optional on purpose — a binding that did not take is a deployment
   *  without one, which still answers the probe (`d1: null`, schema.ts) so
   *  setup can catch it; nobody can sign in to it. */
  DB?: D1Database;
  /** Never bound: the worker sets it on the `Env` it hands a space's routes
   *  (spaces.ts). `DATA` is then that space's part of the bucket and `whole`
   *  the bucket itself. Absent for the shared workspace. */
  SPACE?: { id: string; whole: R2Bucket };
}
