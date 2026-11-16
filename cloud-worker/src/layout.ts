// The bucket's layout, the grammar of the ids,
// hashes, slugs and paths that appear in it, and the caps on what the worker
// stores.
//
//   workspace.json              the binding: one domain, one workspace (written create-only)
//   manifest.json               the workspace manifest, updated by compare-and-swap on its etag
//   blobs/<fileId>/<hash>       immutable file content, addressed by (a prefix of) its sha256
//   versions/index.json         the mirrored version store's retained set (versions.ts)
//   versions/snapshots/<id>     one workspace state, gzip'd; immutable
//   versions/blobs/<hash>       one file's content, gzip'd; immutable
//   spaces/<spaceId>/…          a restricted folder or a person's Private: the same four kinds of
//                               object again — manifest.json, blobs/, versions/ — under its own prefix
//
// Nothing public is stored here: public pages are rendered from blobs/. And
// nobody is stored here: people, their tokens and their invites live in the
// D1 database beside the bucket (schema.ts, members.ts) — a blob store cannot
// hold a UNIQUE email or delete a credential atomically. So do presence and
// leases (presence.ts): a row per device is atomic where one shared object
// read and rewritten with no CAS is not.

export const WORKSPACE_KEY = "workspace.json";
export const MANIFEST_KEY = "manifest.json";
export const BLOBS_PREFIX = "blobs/";
export const VERSIONS_PREFIX = "versions/";
export const VERSIONS_INDEX_KEY = "versions/index.json";
export const VERSION_SNAPSHOTS_PREFIX = "versions/snapshots/";
export const VERSION_BLOBS_PREFIX = "versions/blobs/";
export const SPACES_PREFIX = "spaces/";

export const blobPrefix = (fileId: string): string => `${BLOBS_PREFIX}${fileId}/`;
export const blobKey = (fileId: string, hash: string): string => `${BLOBS_PREFIX}${fileId}/${hash}`;
export const versionSnapshotKey = (id: string): string => `${VERSION_SNAPSHOTS_PREFIX}${id}.json.gz`;
export const versionBlobKey = (hash: string): string => `${VERSION_BLOBS_PREFIX}${hash}`;
/** Everything one space stores. The trailing slash is what keeps `s-1` from covering `s-10`. */
export const spacePrefix = (spaceId: string): string => `${SPACES_PREFIX}${spaceId}/`;

/** File, device and workspace ids — what the engine mints. */
export const ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/;
/** A space: `s-` a restricted folder, `p-` a person's Private. */
export const SPACE_ID_RE = /^[sp]-[a-f0-9]{8}$/;
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
export const MAX_PATH_LEN = 1024;
export const MAX_PATH_DEPTH = 12;
export const MAX_NAME_LEN = 80;
/** An address is allowed to be long; RFC 5321 caps a path at 254 characters. */
export const MAX_EMAIL_LEN = 254;
export const MAX_TITLE_LEN = 300;
export const MAX_DESC_LEN = 600;
/** The shortest a beat keeps a device "here", and how long one holds that
 *  says nothing: a beat says how long it holds (`ttl`, presence.ts), clamped
 *  to these two. */
export const PRESENCE_TTL_MS = 90_000;
/** The longest: a device polling seldom (idle, in the background) stays
 *  listed as around, and one that quit without saying so drops out within
 *  this. */
export const MAX_PRESENCE_TTL_MS = 15 * 60_000;
/* The version store's caps. A snapshot is a gzip'd map of the whole
   workspace, so it is bounded by the manifest's own file ceiling; a version
   blob is one file and gets the same cap as a synced one. */
export const MAX_VERSIONS_INDEX_BYTES = 1024 * 1024;
export const MAX_VERSION_SNAPSHOT_BYTES = 4 * 1024 * 1024;
export const MAX_VERSION_BLOB_BYTES = MAX_FILE_BYTES;
export const MAX_VERSION_SNAPSHOTS = 2000;

/** What a file's name has to end in for Doklin to sync it: a markdown or an
 *  html document, or a document's comments (`<stem>.meta.jsonl`). Lowercased
 *  ASCII-only, as the engine lowercases it. */
const SYNCED_SUFFIXES = [".md", ".markdown", ".mdown", ".mkd", ".html", ".meta.jsonl"] as const;

/**
 * Whether Doklin syncs the file at `path`. Everything else — a picture, a
 * PDF, a script an agent wrote, a cloned repository's sources — stays on its
 * device: no manifest PUT may name one (manifest.ts), the worker's own writes
 * drop any a stored manifest still lists (commit.ts), and the document API
 * and the public pages never see one (workspace.ts). Mirrored by the engine
 * (`syncs`, engine/src/lib.rs): change both.
 */
export function syncs(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1).replace(/[A-Z]/g, (c) => c.toLowerCase());
  return SYNCED_SUFFIXES.some((suffix) => name.length > suffix.length && name.endsWith(suffix));
}

/** What a path outside `syncs` is told, wherever it is refused. */
export const UNSYNCED_SENTENCE = "Doklin syncs markdown and html documents only";

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


/** The two names a workspace keeps for itself at its top: where a person's
 *  Private and their restricted folders are on disk. Nothing in the shared
 *  manifest lives under either, whatever its case (`RESERVED_DIRS`,
 *  engine/src/cloud/space.rs: change both). */
export const RESERVED_FOLDERS: ReadonlySet<string> = new Set(["private", "restricted"]);

/** Whether a workspace-relative path is under one of the reserved names. */
export const reservedTop = (path: string): boolean => RESERVED_FOLDERS.has(path.split("/", 1)[0].toLowerCase());

/** A name a folder on disk can carry — what a restricted folder is called:
 *  one path segment, trimmed and capped, not hidden. Null when it is not one. */
export function validFolderName(raw: unknown): string | null {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (name.length > MAX_NAME_LEN || name.includes("/") || name.startsWith(".")) return null;
  return validPath(name) ? name : null;
}
