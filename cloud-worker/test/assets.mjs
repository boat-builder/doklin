// Cloudflare's static-assets layer, as far as a domain uses it: a GET or HEAD
// whose path names a file in the web directory (doklin-cloud-web/, written by
// scripts/bundle-worker.mjs) is answered from it without running the worker,
// with the headers its `_headers` file gives; anything else goes to the
// worker. test/run.mjs --bundle and verify-harness/serve-worker.mjs put it in
// front of a bundle, so they see what a visitor of a deployed domain sees.
//
// `_headers`, as Cloudflare reads it: a line that is not indented is a path
// pattern (`*` matches anything, `:name` one segment), the indented
// `Name: value` lines under it are its headers, `! Name` drops one. Every
// rule that matches applies; one header set by two is joined with a comma —
// which is why no path may match two Cache-Control rules.

import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

/** Cloudflare's own Cache-Control for an asset `_headers` says nothing about. */
const DEFAULT_CACHE = "public, max-age=0, must-revalidate";

/** The files a web directory holds but never serves. */
const UNSERVED = new Set(["_headers", "_redirects", ".assetsignore"]);

/** `_headers` as rules: [{ pattern: RegExp, set: [name, value][], drop: string[] }]. */
export function parseHeaders(text) {
  const rules = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      const source = raw
        .trim()
        .split(/(\*|:[A-Za-z]\w*)/)
        .map((part) => (part === "*" ? ".*" : part.startsWith(":") ? "[^/]+" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")))
        .join("");
      rules.push({ pattern: new RegExp(`^${source}$`), set: [], drop: [] });
      continue;
    }
    const rule = rules.at(-1);
    if (!rule) throw new Error(`_headers: a header before any path: ${raw}`);
    const line = raw.trim();
    if (line.startsWith("!")) {
      rule.drop.push(line.slice(1).trim().toLowerCase());
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) throw new Error(`_headers: not a header: ${raw}`);
    rule.set.push([line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()]);
  }
  return rules;
}

/** The headers the rules give `pathname`: { name: value }, the drops as null. */
export function headersFor(rules, pathname) {
  const out = {};
  for (const rule of rules) {
    if (!rule.pattern.test(pathname)) continue;
    for (const [name, value] of rule.set) out[name] = name in out && out[name] !== null ? `${out[name]}, ${value}` : value;
    for (const name of rule.drop) out[name] = null;
  }
  return out;
}

/** The web directory's answer to `request`, or null when it is the worker's. */
export function serveAsset(webDir, request) {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url).pathname);
  } catch {
    return null;
  }
  const rel = pathname.slice(1);
  if (rel === "" || rel.split("/").some((seg) => seg === "" || seg === "." || seg === "..") || UNSERVED.has(rel)) return null;
  const file = path.join(webDir, rel);
  if (!existsSync(file) || !statSync(file).isFile()) return null;

  const bytes = readFileSync(file);
  const headers = new Headers({
    "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
    "cache-control": DEFAULT_CACHE,
    etag: `"${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}"`,
  });
  const rulesFile = path.join(webDir, "_headers");
  if (existsSync(rulesFile)) {
    for (const [name, value] of Object.entries(headersFor(parseHeaders(readFileSync(rulesFile, "utf8")), pathname))) {
      if (value === null) headers.delete(name);
      else headers.set(name, value);
    }
  }
  return new Response(request.method === "HEAD" ? null : bytes, { status: 200, headers });
}

/** `worker` with the web directory in front of its requests, as a deployed
 *  domain has; its other handlers (the cron's) as they are. */
export function withAssets(worker, webDir) {
  return {
    ...worker,
    fetch: (request, env, ctx) => serveAsset(webDir, request) ?? worker.fetch(request, env, ctx),
  };
}
