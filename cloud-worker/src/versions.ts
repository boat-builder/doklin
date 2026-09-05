// The version store in the bucket (docs/cloud.md §5.2, docs/versioning.md
// §6.4): the mirror of what every device keeps locally under
// `<app_data>/versions/<key>/`, so history outlives the laptop that made it.
//
//   versions/index.json                           the retained set, CAS'd on its etag
//   versions/snapshots/<ts13>-<deviceId>.json.gz  immutable; the bytes the device wrote
//   versions/blobs/<hash>                         immutable; gzip'd content, full sha256 key
//
// Two rules make concurrent devices safe without the worker knowing anything
// about versioning: snapshots and blobs are immutable and create-only (two
// devices that write the same bytes agree by construction), and the index —
// the only mutable object — moves by compare-and-swap, exactly like the
// manifest. The worker validates shape and size and nothing else; which
// snapshots deserve to live is the ladder's business, in the app.

import type { Env } from "./env";
import { json } from "./http";
import {
  ID_RE,
  MAX_VERSION_BLOB_BYTES,
  MAX_VERSION_SNAPSHOT_BYTES,
  MAX_VERSIONS_INDEX_BYTES,
  MAX_VERSION_SNAPSHOTS,
  SNAPSHOT_ID_RE,
  VERSION_BLOBS_PREFIX,
  VERSIONS_INDEX_KEY,
  VERSION_HASH_RE,
  versionBlobKey,
  versionSnapshotKey,
} from "./layout";

const JSON_OBJECT = { httpMetadata: { contentType: "application/json" } };
const GZIP_OBJECT = { httpMetadata: { contentType: "application/gzip" } };

const methodNotAllowed = (): Response => json({ error: "method not allowed" }, 405);
const notFound = (): Response => json({ error: "not found" }, 404);

/**
 * `/api/versions/…`. `parts` is the split path — ["api", "versions", section,
 * id?] — so the shape of the URL has already been checked by the caller.
 */
export async function handleVersions(request: Request, env: Env, url: URL, parts: string[]): Promise<Response> {
  const section = parts[2];
  const tail = parts[3];

  if (section === "index" && tail === undefined) {
    if (request.method === "GET") return getIndex(env);
    if (request.method === "PUT") return putIndex(request, env);
    return methodNotAllowed();
  }

  if (section === "snapshots" && tail !== undefined) {
    if (!SNAPSHOT_ID_RE.test(tail)) return json({ error: "invalid snapshot id" }, 400);
    return snapshot(request, env, tail);
  }

  if (section === "blobs") {
    if (tail === undefined) {
      if (request.method !== "GET") return methodNotAllowed();
      return listBlobs(env, url);
    }
    if (!VERSION_HASH_RE.test(tail)) return json({ error: "invalid blob hash" }, 400);
    return blob(request, env, tail);
  }

  return notFound();
}

/* ---------- The index ---------- */

async function getIndex(env: Env): Promise<Response> {
  const obj = await env.DATA.get(VERSIONS_INDEX_KEY);
  if (!obj) return notFound();
  return new Response(obj.body, {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-versions-etag": obj.etag,
    },
  });
}

/**
 * Compare-and-swap on the index, the manifest's ceremony exactly: the base
 * etag is required (428 without it), `"*"` means "there is none yet, create
 * it", and a lost race answers 412 with where the index actually is so the
 * loser's retry starts from reality rather than from its own hope.
 */
async function putIndex(request: Request, env: Env): Promise<Response> {
  const baseEtag = request.headers.get("x-base-etag");
  if (!baseEtag) return json({ error: "x-base-etag header required" }, 428);
  const text = await request.text();
  if (text.length > MAX_VERSIONS_INDEX_BYTES) return json({ error: "versions index too large" }, 413);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return json({ error: "invalid json body" }, 400);
  }
  const problem = validateVersionsIndex(data);
  if (problem) return json({ error: problem }, 400);

  const onlyIf = baseEtag === "*" ? { etagDoesNotMatch: "*" } : { etagMatches: baseEtag };
  const put = await env.DATA.put(VERSIONS_INDEX_KEY, text, { ...JSON_OBJECT, onlyIf });
  if (!put) {
    const current = await env.DATA.head(VERSIONS_INDEX_KEY);
    return json({ error: "versions index changed", ...(current ? { etag: current.etag } : {}) }, 412);
  }
  return json({ etag: put.etag, snapshots: (data as VersionsIndex).snapshots.length });
}

/* ---------- Snapshots ---------- */

/**
 * One workspace state, gzip'd, named by when it was taken and which device
 * took it — so two devices capturing in the same millisecond write two
 * objects rather than fighting over one. Immutable: a re-PUT of an id that
 * exists is a no-op that says so, which is what makes a retry after a
 * half-lost upload free.
 */
async function snapshot(request: Request, env: Env, id: string): Promise<Response> {
  const key = versionSnapshotKey(id);
  if (request.method === "GET") {
    const obj = await env.DATA.get(key);
    if (!obj) return notFound();
    return new Response(obj.body, {
      headers: {
        "content-type": obj.httpMetadata?.contentType || "application/gzip",
        "content-length": String(obj.size),
        "cache-control": "no-store",
      },
    });
  }
  if (request.method === "PUT") {
    const buf = await request.arrayBuffer();
    if (buf.byteLength > MAX_VERSION_SNAPSHOT_BYTES) return json({ error: "snapshot too large" }, 413);
    const put = await env.DATA.put(key, buf, { ...GZIP_OBJECT, onlyIf: { etagDoesNotMatch: "*" } });
    return json({ stored: true, existed: !put, id, size: buf.byteLength });
  }
  if (request.method === "DELETE") {
    await env.DATA.delete(key);
    return json({ deleted: true });
  }
  return methodNotAllowed();
}

/* ---------- Blobs ---------- */

/**
 * The inventory the cloud sweep diffs against the retained snapshots. Paged
 * rather than walked to the end like the per-file listing: this prefix holds
 * every version of every file in the workspace, so "one page per request"
 * is the difference between a listing that finishes and one that doesn't.
 */
async function listBlobs(env: Env, url: URL): Promise<Response> {
  const cursor = url.searchParams.get("cursor") || undefined;
  const batch = await env.DATA.list({ prefix: VERSION_BLOBS_PREFIX, cursor });
  const blobs = batch.objects.map((obj) => ({
    hash: obj.key.slice(VERSION_BLOBS_PREFIX.length),
    size: obj.size,
    uploaded: obj.uploaded instanceof Date ? obj.uploaded.toISOString() : null,
  }));
  return json({ blobs, ...(batch.truncated && batch.cursor ? { cursor: batch.cursor } : {}) });
}

async function blob(request: Request, env: Env, hash: string): Promise<Response> {
  const key = versionBlobKey(hash);
  if (request.method === "GET") {
    const obj = await env.DATA.get(key);
    if (!obj) return notFound();
    return new Response(obj.body, {
      headers: {
        "content-type": obj.httpMetadata?.contentType || "application/gzip",
        "content-length": String(obj.size),
        "cache-control": "no-store",
      },
    });
  }
  if (request.method === "PUT") {
    const buf = await request.arrayBuffer();
    if (buf.byteLength > MAX_VERSION_BLOB_BYTES) return json({ error: "file too large" }, 413);
    // Content-addressed: a hash already stored IS these bytes.
    const put = await env.DATA.put(key, buf, { ...GZIP_OBJECT, onlyIf: { etagDoesNotMatch: "*" } });
    return json({ stored: true, existed: !put, hash, size: buf.byteLength });
  }
  if (request.method === "DELETE") {
    await env.DATA.delete(key);
    return json({ deleted: true });
  }
  return methodNotAllowed();
}

/* ---------- The index's shape ---------- */

/** One row of the cloud index — the local index's row plus who wrote it. */
export type VersionsEntry = {
  id: string;
  ts: number;
  device: string;
  reason: string;
  files: number;
  bytes: number;
  digest: string;
  pinned?: boolean;
  label?: string | null;
  restoredFrom?: number | null;
};

/** `versions/index.json`. The horizon lives here so every device agrees. */
export type VersionsIndex = {
  version: number;
  horizonDays: number | null;
  snapshots: VersionsEntry[];
};

/** The store format both sides write; bumped when the shape changes. */
export const VERSIONS_INDEX_VERSION = 1;

const REASONS: ReadonlySet<string> = new Set(["interval", "closing", "seed", "pre-restore", "restore", "manual"]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

/** null on a good index, a sentence naming the first problem otherwise. */
export function validateVersionsIndex(data: unknown): string | null {
  if (!isObject(data)) return "versions index must be an object";
  if (data.version !== VERSIONS_INDEX_VERSION) return "unsupported versions index version";
  if (data.horizonDays !== null && !isCount(data.horizonDays)) return "horizonDays must be a non-negative integer or null";
  if (!Array.isArray(data.snapshots)) return "snapshots must be an array";
  if (data.snapshots.length > MAX_VERSION_SNAPSHOTS) return "too many snapshots";
  const seen = new Set<string>();
  for (const entry of data.snapshots) {
    if (!isObject(entry)) return "each snapshot must be an object";
    if (typeof entry.id !== "string" || !SNAPSHOT_ID_RE.test(entry.id)) return "invalid snapshot id";
    if (seen.has(entry.id)) return "duplicate snapshot id";
    seen.add(entry.id);
    if (!isCount(entry.ts)) return "invalid snapshot ts";
    if (typeof entry.device !== "string" || !ID_RE.test(entry.device)) return "invalid device id";
    if (typeof entry.reason !== "string" || !REASONS.has(entry.reason)) return "invalid snapshot reason";
    if (!isCount(entry.files) || !isCount(entry.bytes)) return "invalid snapshot totals";
    if (typeof entry.digest !== "string" || !VERSION_HASH_RE.test(entry.digest)) return "invalid snapshot digest";
    if (entry.pinned !== undefined && typeof entry.pinned !== "boolean") return "pinned must be a boolean";
    if (entry.label !== undefined && entry.label !== null && typeof entry.label !== "string") {
      return "label must be a string";
    }
    if (entry.restoredFrom !== undefined && entry.restoredFrom !== null && !isCount(entry.restoredFrom)) {
      return "restoredFrom must be a non-negative integer or null";
    }
  }
  return null;
}
