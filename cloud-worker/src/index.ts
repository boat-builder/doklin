// Doklin cloud worker — one Cloudflare Worker in front of one R2 bucket,
// serving one workspace's cloud at one domain (docs/cloud-redesign.md §5).
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
import { readWorkspace } from "./bucket";
import type { Env } from "./env";
import { appleTouchIcon, favicon, landingPage, mermaidModule, notFoundPage, robotsTxt } from "./public";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api" || path.startsWith("/api/")) return handleApi(request, env, url);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", { status: 405 });
    }
    if (path === "/") return landingPage(await readWorkspace(env));
    if (path === "/robots.txt") return robotsTxt();
    if (path === "/favicon.ico") return favicon();
    if (path === "/apple-touch-icon.png") return appleTouchIcon();
    if (/^\/__web\/[a-z0-9]+\/mermaid\.js$/.test(path)) return mermaidModule();

    // Published pages are rendered from the synced files; the renderer lands
    // with publishing (PR 4). Until then every other path is this.
    return notFoundPage();
  },
} satisfies ExportedHandler<Env>;
