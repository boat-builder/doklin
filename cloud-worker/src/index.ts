// Doklin cloud worker — one Cloudflare Worker in front of one R2 bucket,
// serving one workspace's cloud at one domain.
//
// Two surfaces:
//   /api/*      the engine's — bearer auth, JSON; see api.ts for the routes —
//               and, under /api/agent, an agent's (agentApi.ts)
//   everything  the visitor's — no auth, GET/HEAD only; see public.ts
//   else
// and one daily run, the cron trigger wrangler.toml declares: the sweep of
// stored copies no manifest points at (sweep.ts).
//
// The worker holds no page content of its own: the bucket is the synced
// workspace (manifest + content-addressed blobs), and a public page is a
// rendering of those files. Deployed by an agent running wrangler from the
// app's setup prompt; bundled to one file by scripts/bundle-worker.mjs.

import { handleApi } from "./api";
import type { Env } from "./env";
import { handlePublic } from "./public";
import { sweep } from "./sweep";

function answer(request: Request, env: Env, ctx: ExecutionContext | undefined): Promise<Response> | Response {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api" || path.startsWith("/api/")) return handleApi(request, env, url, ctx);

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", { status: 405 });
  }
  return handlePublic(request, env, ctx, url);
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const res = await answer(request, env, ctx);
    // Every answer is what its Content-Type says and nothing a browser
    // guesses: a stored file is never sniffed into a script or a stylesheet.
    // The files Cloudflare serves beside the worker say the same (web/_headers).
    const headers = new Headers(res.headers);
    headers.set("x-content-type-options", "nosniff");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const r = await sweep(env, Date.now());
    console.log(
      `sweep: ${r.deleted} copies deleted; ${r.swept} of ${r.sections} sections swept` +
        (r.unreadable > 0 ? `, ${r.unreadable} with an unreadable manifest left alone` : ""),
    );
  },
} satisfies ExportedHandler<Env>;
