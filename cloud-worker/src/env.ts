// The worker's environment: what wrangler.toml binds and what the secret
// store holds. (Global runtime types — R2Bucket, ExecutionContext,
// ExportedHandler — come from @cloudflare/workers-types via tsconfig.)

export interface Env {
  /** The R2 bucket behind this domain: `[[r2_buckets]] binding = "DATA"`. */
  DATA: R2Bucket;
  /** The owner's bearer token — `wrangler secret put OWNER_TOKEN`; the app mints it at setup. */
  OWNER_TOKEN?: string;
}
