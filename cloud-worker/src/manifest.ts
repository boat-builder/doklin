// The workspace manifest — the one mutable object in the bucket — as the
// worker sees it: the wire types and the shape
// check every PUT goes through. Semantics (revision ordering, merges, which
// device's entry wins) are the engine's business; corruption and traversal
// are the worker's. The check is what stops a broken device from publishing
// garbage: it never has to trust the client, and it never has to be clever.

import {
  BLOB_HASH_RE,
  ID_RE,
  MAX_DESC_LEN,
  MAX_FILE_BYTES,
  MAX_MANIFEST_FILES,
  MAX_NAME_LEN,
  MAX_PUBLIC_ENTRIES,
  MAX_TITLE_LEN,
  MAX_TOMBSTONES,
  RESERVED_SLUGS,
  SLUG_RE,
  SPACE_ID_RE,
  reservedTop,
  validPath,
} from "./layout";
import { MANIFEST_VERSION } from "./version";

export type ManifestFile = {
  path: string;
  rev: number;
  hash: string;
  size: number;
  mtime?: number;
  /** Who last changed it: a member id since v3.
   *  Checked as a bounded string rather than as an id, because a workspace
   *  upgraded from v2 carries the device names it was written with and
   *  refusing those would throw away the attribution it already has. */
  by?: string;
};

/** A removed file. `to` is set when it was not deleted but moved to another
 *  section: the id of the space it went to, `""` for the shared workspace.
 *  A Mac in that section moves its copy there; any other deletes it outright
 *  instead of putting it in the Trash. */
export type Tombstone = { path: string; rev?: number; ts?: number; by?: string; to?: string };

/**
 * The public map, keyed by slug. A file entry references the fileId (so a
 * rename carries the page for free) and snapshots the path (so a file
 * deleted and recreated at the same path can be re-bound); a folder entry is
 * keyed by path and exposes every note under it. `root` on at most one
 * entry makes it the page at `/`.
 */
export type PublicEntry =
  | {
      kind: "file";
      file: string;
      path: string;
      title?: string;
      desc?: string;
      root?: boolean;
      by?: string;
      at?: number;
    }
  | {
      kind: "dir";
      /** "" is the workspace root itself. */
      path: string;
      title?: string;
      desc?: string;
      root?: boolean;
      by?: string;
      at?: number;
    };

export type Manifest = {
  version: typeof MANIFEST_VERSION;
  name?: string;
  seq: number;
  files: Record<string, ManifestFile>;
  tombstones?: Record<string, Tombstone>;
  public?: Record<string, PublicEntry>;
};

/** What a PUT that fails validation answers with: 400 for garbage, 426 for a schema this worker predates. */
export type ManifestProblem = { status: 400 | 426; error: string };

export function emptyManifest(name: string): Manifest {
  return { version: MANIFEST_VERSION, name, seq: 0, files: {}, tombstones: {}, public: {} };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const optionalText = (v: unknown, max: number): boolean =>
  v === undefined || (typeof v === "string" && v.length <= max);

/** What a shared manifest naming a file under a reserved folder is told. */
export const RESERVED_SENTENCE = "Private and Restricted are kept for a person's own and restricted folders";

function validateFiles(files: unknown, space: boolean): string | null {
  if (!isObject(files)) return "files must be an object";
  const ids = Object.keys(files);
  if (ids.length > MAX_MANIFEST_FILES) return "too many files";
  const seenPaths = new Set<string>();
  for (const id of ids) {
    if (!ID_RE.test(id)) return `invalid file id: ${id}`;
    const f = files[id];
    if (!isObject(f)) return `invalid file entry: ${id}`;
    if (!validPath(f.path)) return `invalid path for ${id}`;
    if (!space && reservedTop(f.path)) return RESERVED_SENTENCE;
    // Case-insensitive: the workspace lives on a case-insensitive disk.
    const pathKey = f.path.toLowerCase();
    if (seenPaths.has(pathKey)) return `duplicate path: ${f.path}`;
    seenPaths.add(pathKey);
    if (!isCount(f.rev) || f.rev < 1) return `invalid rev for ${id}`;
    if (typeof f.hash !== "string" || !BLOB_HASH_RE.test(f.hash)) return `invalid hash for ${id}`;
    if (!isCount(f.size) || f.size > MAX_FILE_BYTES) return `invalid size for ${id}`;
    if (f.mtime !== undefined && !isTime(f.mtime)) return `invalid mtime for ${id}`;
    if (!optionalText(f.by, MAX_NAME_LEN)) return `invalid by for ${id}`;
  }
  return null;
}

function validateTombstones(tombstones: unknown): string | null {
  if (tombstones === undefined) return null;
  if (!isObject(tombstones)) return "tombstones must be an object";
  const ids = Object.keys(tombstones);
  if (ids.length > MAX_TOMBSTONES) return "too many tombstones";
  for (const id of ids) {
    if (!ID_RE.test(id)) return `invalid tombstone id: ${id}`;
    const t = tombstones[id];
    if (!isObject(t) || !validPath(t.path)) return `invalid tombstone for ${id}`;
    if (t.rev !== undefined && !isCount(t.rev)) return `invalid tombstone rev for ${id}`;
    if (t.ts !== undefined && !isTime(t.ts)) return `invalid tombstone ts for ${id}`;
    if (!optionalText(t.by, MAX_NAME_LEN)) return `invalid tombstone by for ${id}`;
    if (t.to !== undefined && t.to !== "" && !(typeof t.to === "string" && SPACE_ID_RE.test(t.to))) {
      return `invalid tombstone to for ${id}`;
    }
  }
  return null;
}

/**
 * The public map: slug grammar, reserved words, kinds, well-formed
 * references, at most one root. References are checked for shape, not for
 * existence: an entry deliberately outlives its file (the page 404s while
 * the file is gone and comes back when the file does), and a folder entry
 * may cover a folder that is empty now. The page at `/` is the shared
 * workspace's to name: a space's map has none.
 */
function validatePublic(map: unknown, space: boolean): string | null {
  if (map === undefined) return null;
  if (!isObject(map)) return "public must be an object";
  const slugs = Object.keys(map);
  if (slugs.length > MAX_PUBLIC_ENTRIES) return "too many public entries";
  let roots = 0;
  for (const slug of slugs) {
    if (!SLUG_RE.test(slug) || RESERVED_SLUGS.has(slug)) return `invalid slug: ${slug}`;
    const e = map[slug];
    if (!isObject(e)) return `invalid public entry: ${slug}`;
    if (e.kind === "file") {
      if (typeof e.file !== "string" || !ID_RE.test(e.file)) return `invalid file for ${slug}`;
      if (!validPath(e.path)) return `invalid path for ${slug}`;
    } else if (e.kind === "dir") {
      if (typeof e.path !== "string" || (e.path !== "" && !validPath(e.path))) {
        return `invalid path for ${slug}`;
      }
    } else {
      return `invalid kind for ${slug}`;
    }
    if (!optionalText(e.title, MAX_TITLE_LEN)) return `invalid title for ${slug}`;
    if (!optionalText(e.desc, MAX_DESC_LEN)) return `invalid desc for ${slug}`;
    if (!optionalText(e.by, MAX_NAME_LEN)) return `invalid by for ${slug}`;
    if (e.at !== undefined && !isTime(e.at)) return `invalid at for ${slug}`;
    if (e.root !== undefined && typeof e.root !== "boolean") return `invalid root for ${slug}`;
    if (e.root === true) roots += 1;
  }
  if (roots > 0 && space) return "the home page is chosen from the shared workspace";
  if (roots > 1) return "more than one root page";
  return null;
}

/** Shape-check a manifest without trusting the client. `space` is true for
 *  the manifest of a restricted folder or a Private, false for the shared
 *  workspace's. */
export function validateManifest(data: unknown, space: boolean): ManifestProblem | null {
  const bad = (error: string): ManifestProblem => ({ status: 400, error });
  if (!isObject(data)) return bad("manifest must be an object");
  if (!Number.isInteger(data.version)) return bad("manifest version must be an integer");
  // A skew is 426 in both directions — "upgrade required" is what it is, and
  // the sentence says which side. A 400 here would
  // read as corruption, which a version older than this worker's is not.
  if (data.version !== MANIFEST_VERSION) {
    return {
      status: 426,
      error:
        (data.version as number) > MANIFEST_VERSION
          ? `manifest version ${data.version} is newer than this worker understands (${MANIFEST_VERSION}) — update the worker`
          : `manifest version ${data.version} is older than this worker accepts (${MANIFEST_VERSION}) — update the app`,
    };
  }
  if (!isCount(data.seq)) return bad("seq must be a non-negative integer");
  if (!optionalText(data.name, MAX_NAME_LEN)) return bad("invalid name");
  const problem =
    validateFiles(data.files, space) ?? validateTombstones(data.tombstones) ?? validatePublic(data.public, space);
  return problem ? bad(problem) : null;
}
