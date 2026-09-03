// Doklin cloud worker — one Cloudflare Worker in front of one R2 bucket,
// serving one workspace's cloud at one domain (docs/cloud.md §5).
//
// Two surfaces:
//   /api/*      the engine's — bearer auth, JSON; see api.ts for the routes
//   everything  the visitor's — no auth, GET/HEAD only; see public.ts
//   else
//
// The worker holds no page content of its own: the bucket is the synced
// workspace (manifest + content-addressed blobs), and a public page is a
// rendering of those files. Deployed by an agent running wrangler from the
// app's setup prompt; bundled to one file by scripts/bundle-worker.mjs.

import { handleApi } from "./api";
import type { Env } from "./env";
import { handlePublic } from "./public";

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api" || path.startsWith("/api/")) return handleApi(request, env, url);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", { status: 405 });
    }
    return handlePublic(request, env, ctx, url);
  },
} satisfies ExportedHandler<Env>;
