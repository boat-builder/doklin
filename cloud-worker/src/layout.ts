// The bucket's layout (docs/cloud.md §5.2), the grammar of the ids,
// hashes, slugs and paths that appear in it, and the caps on what the worker
// stores.
//
//   workspace.json              the binding: one domain, one workspace (written create-only)
//   manifest.json               the workspace manifest, updated by compare-and-swap on its etag
//   blobs/<fileId>/<hash>       immutable file content, addressed by (a prefix of) its sha256
//   history/<fileId>.json       DEPRECATED deep revision archive (docs/versioning.md §6.5) —
//                               written only by an app on a release before the version store
//                               replaced it; the current app deletes these once and never again
//   presence.json               {devices: {<deviceId>: {name, path?, ts}}}, TTL'd, best effort
//   versions/index.json         the mirrored version store's retained set (versions.ts)
//   versions/snapshots/<id>     one workspace state, gzip'd; immutable
//   versions/blobs/<hash>       one file's content, gzip'd; immutable
//   auth/tokens/<sha256>.json   per-person tokens (minted by invites — not built; the lookup is)
//   auth/invites/<sha256>.json  pending invites (not built)
//
// Nothing public is stored here: public pages are rendered from blobs/.

export const WORKSPACE_KEY = "workspace.json";
export const MANIFEST_KEY = "manifest.json";
export const PRESENCE_KEY = "presence.json";
export const BLOBS_PREFIX = "blobs/";
export const HISTORY_PREFIX = "history/";
export const TOKENS_PREFIX = "auth/tokens/";
export const VERSIONS_PREFIX = "versions/";
export const VERSIONS_INDEX_KEY = "versions/index.json";
export const VERSION_SNAPSHOTS_PREFIX = "versions/snapshots/";
export const VERSION_BLOBS_PREFIX = "versions/blobs/";

export const blobPrefix = (fileId: string): string => `${BLOBS_PREFIX}${fileId}/`;
export const blobKey = (fileId: string, hash: string): string => `${BLOBS_PREFIX}${fileId}/${hash}`;
export const historyKey = (fileId: string): string => `${HISTORY_PREFIX}${fileId}.json`;
export const tokenKey = (hash: string): string => `${TOKENS_PREFIX}${hash}.json`;
export const versionSnapshotKey = (id: string): string => `${VERSION_SNAPSHOTS_PREFIX}${id}.json.gz`;
export const versionBlobKey = (hash: string): string => `${VERSION_BLOBS_PREFIX}${hash}`;

/** File, device and workspace ids — what the engine mints. */
export const ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/;
/** A content address: a hex prefix (16 characters and up) of the blob's sha256. */
export const BLOB_HASH_RE = /^[a-f0-9]{16,64}$/;
/** A mirrored snapshot: the millisecond it was taken, then the device that took it. */
export const SNAPSHOT_ID_RE = /^\d{13}-[a-z0-9][a-z0-9_-]{2,63}$/;
/** The version store's content address: the WHOLE sha256, never a prefix. */
export const VERSION_HASH_RE = /^[a-f0-9]{64}$/;
/** A public page's slug: the one path segment under the domain. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
/** Slugs the worker's own routes speak for. Several cannot match SLUG_RE anyway; the set says what is taken. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "api",
  "__web",
  "raw",
  "og.png",
  "robots.txt",
  "favicon.ico",
  "apple-touch-icon.png",
  "join",
]);

/* Caps. The app has matching limits on what it is willing to walk
   (MAX_TREE_DEPTH / MAX_TREE_ENTRIES in src-tauri), so the worker never
   accepts a workspace the app couldn't hold. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
export const MAX_MANIFEST_FILES = 5000;
export const MAX_TOMBSTONES = 10_000;
export const MAX_PUBLIC_ENTRIES = 5000;
/** DEPRECATED, all three: the retired manifest history. The current app writes
 *  no `hist` and no archive; these caps still bound what an older one sends. */
export const MAX_INLINE_HIST = 12;
export const MAX_HISTORY_ENTRIES = 200;
export const MAX_HISTORY_BYTES = 256 * 1024;
export const MAX_PATH_LEN = 1024;
export const MAX_PATH_DEPTH = 12;
export const MAX_NAME_LEN = 80;
export const MAX_TITLE_LEN = 300;
export const MAX_DESC_LEN = 600;
export const PRESENCE_TTL_MS = 90_000;
/* The version store's caps. A snapshot is a gzip'd map of the whole
   workspace, so it is bounded by the manifest's own file ceiling; a version
   blob is one file and gets the same cap as a synced one. */
export const MAX_VERSIONS_INDEX_BYTES = 1024 * 1024;
export const MAX_VERSION_SNAPSHOT_BYTES = 4 * 1024 * 1024;
export const MAX_VERSION_BLOB_BYTES = MAX_FILE_BYTES;
export const MAX_VERSION_SNAPSHOTS = 2000;

/** A path relative to the workspace root: forward slashes, no traversal, bounded depth and length. */
export function validPath(p: unknown): p is string {
  if (typeof p !== "string" || p.length === 0 || p.length > MAX_PATH_LEN) return false;
  if (p.includes("\0") || p.includes("\\")) return false;
  const segs = p.split("/");
  if (segs.length > MAX_PATH_DEPTH) return false;
  return segs.every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}

/** A human-facing name, trimmed and capped — the fallback when blank or not a string. */
export function validName(raw: unknown, fallback: string): string {
  const name = typeof raw === "string" ? raw.trim().slice(0, MAX_NAME_LEN) : "";
  return name || fallback;
}
