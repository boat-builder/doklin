// The workspace manifest — the one mutable object in the bucket — as the
// worker sees it: the wire types and the shape check every PUT goes through.
// Semantics (revision ordering, merges, which device's entry wins) are the
// engine's business; corruption, traversal and what may sync at all
// (`syncs`, layout.ts) are the worker's. The check is what stops a broken
// device from publishing garbage: it never has to trust the client, and it
// never has to be clever.
//
// Nothing of the runtime is imported here, so the browser version (src/web/)
// reads a manifest with these types.

import {
  AGENT_ID_RE,
  BLOB_HASH_RE,
  ID_RE,
  MAX_DESC_LEN,
  MAX_FILE_BYTES,
  MAX_MANIFEST_FILES,
  MAX_NAME_LEN,
  MAX_PUBLIC_ENTRIES,
  MAX_TITLE_LEN,
  MAX_TOMBSTONES,
  MEMBER_ID_RE,
  RESERVED_SLUGS,
  SHARE_ID_RE,
  SLUG_RE,
  SPACE_ID_RE,
  UNSYNCED_SENTENCE,
  syncs,
  validPath,
} from "./layout";
import { MANIFEST_VERSION } from "./version";
import { isBoardsFile } from "../../src/boards";
import { listProblem, type TagDef } from "../../src/tags";

export type ManifestFile = {
  path: string;
  rev: number;
  hash: string;
  size: number;
  mtime?: number;
  /** Who last changed it: a member id, or an agent's. */
  by: string;
};

/** A removed file. `to` is set when it was not deleted but moved to another
 *  section: the id of the space it went to, `""` for the shared workspace.
 *  A Mac in that section moves its copy there; any other deletes it outright
 *  instead of putting it in the Trash. */
export type Tombstone = { path: string; rev: number; ts: number; by: string; to?: string };

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
      by: string;
      at: number;
    }
  | {
      kind: "dir";
      /** "" is the workspace root itself. */
      path: string;
      title?: string;
      desc?: string;
      root?: boolean;
      by: string;
      at: number;
    };

/**
 * Where a share sits in the section it is in, keyed by the share's id. Who
 * can open the share is never read from here (spaces.ts): this only says
 * where. A share with no entry sits at the section's top.
 */
export type Mount = {
  /** The folder of this section its item is in; "" the section's top. The
   *  item's name is the share's own. */
  dir: string;
  rev: number;
  by: string;
  /** Where the item was in this section before it was shared — a folder's
   *  path, a document's without its extension: its history carries on from
   *  there. */
  was?: string;
};

export type Manifest = {
  version: typeof MANIFEST_VERSION;
  name?: string;
  seq: number;
  files: Record<string, ManifestFile>;
  tombstones?: Record<string, Tombstone>;
  public?: Record<string, PublicEntry>;
  /** The workspace's tags, in order: which of a note's frontmatter lines
   *  are tags, and the values each takes (src/tags.ts). Library's manifest
   *  alone holds any. */
  tags?: TagDef[];
  mounts?: Record<string, Mount>;
};

/** Which section a manifest is: Library's holds no share, and a shared
 *  document's holds that one document and nothing else. */
export type ManifestOf = "library" | "private" | "folder" | "document";

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
/** A `by`: the id of a person or an agent. */
const isAuthor = (v: unknown): boolean => typeof v === "string" && (MEMBER_ID_RE.test(v) || AGENT_ID_RE.test(v));

/** What a shared document's manifest is told when it would hold anything else. */
export const ONE_DOCUMENT_SENTENCE = "a shared document's section holds that document and nothing else";

/** A document's files share a name: `plan.md`, `plan.html`, `plan.meta.jsonl`. */
function documentStem(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".meta.jsonl")) return lower.slice(0, -".meta.jsonl".length);
  const dot = lower.lastIndexOf(".");
  return dot > 0 ? lower.slice(0, dot) : lower;
}

/** What a manifest naming a file outside `syncs` is told. */
const unsynced = (path: string): string => `${UNSYNCED_SENTENCE} — "${path}" is neither`;

function validateFiles(files: unknown, of: ManifestOf): string | null {
  if (!isObject(files)) return "files must be an object";
  const ids = Object.keys(files);
  if (ids.length > MAX_MANIFEST_FILES) return "too many files";
  const seenPaths = new Set<string>();
  for (const id of ids) {
    if (!ID_RE.test(id)) return `invalid file id: ${id}`;
    const f = files[id];
    if (!isObject(f)) return `invalid file entry: ${id}`;
    if (!validPath(f.path)) return `invalid path for ${id}`;
    if (!syncs(f.path)) return unsynced(f.path);
    // Case-insensitive: the workspace lives on a case-insensitive disk.
    const pathKey = f.path.toLowerCase();
    if (seenPaths.has(pathKey)) return `duplicate path: ${f.path}`;
    seenPaths.add(pathKey);
    if (!isCount(f.rev) || f.rev < 1) return `invalid rev for ${id}`;
    if (typeof f.hash !== "string" || !BLOB_HASH_RE.test(f.hash)) return `invalid hash for ${id}`;
    if (!isCount(f.size) || f.size > MAX_FILE_BYTES) return `invalid size for ${id}`;
    if (f.mtime !== undefined && !isTime(f.mtime)) return `invalid mtime for ${id}`;
    if (!isAuthor(f.by)) return `invalid by for ${id}`;
  }
  if (of === "document") {
    // A board is a folder's, and nothing in a shared document's section is a folder.
    const paths = [...seenPaths];
    if (paths.some((p) => p.includes("/") || isBoardsFile(p)) || new Set(paths.map(documentStem)).size > 1) return ONE_DOCUMENT_SENTENCE;
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
    if (!syncs(t.path)) return unsynced(t.path);
    if (!isCount(t.rev)) return `invalid tombstone rev for ${id}`;
    if (!isTime(t.ts)) return `invalid tombstone ts for ${id}`;
    if (!isAuthor(t.by)) return `invalid tombstone by for ${id}`;
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
function validatePublic(map: unknown, of: ManifestOf): string | null {
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
      if (!syncs(e.path)) return unsynced(e.path);
      if (isBoardsFile(e.path)) return `a page shows a document or a folder, and "${e.path}" is neither`;
    } else if (e.kind === "dir") {
      if (typeof e.path !== "string" || (e.path !== "" && !validPath(e.path))) {
        return `invalid path for ${slug}`;
      }
      if (of === "document") return ONE_DOCUMENT_SENTENCE;
    } else {
      return `invalid kind for ${slug}`;
    }
    if (!optionalText(e.title, MAX_TITLE_LEN)) return `invalid title for ${slug}`;
    if (!optionalText(e.desc, MAX_DESC_LEN)) return `invalid desc for ${slug}`;
    if (!isAuthor(e.by)) return `invalid by for ${slug}`;
    if (!isTime(e.at)) return `invalid at for ${slug}`;
    if (e.root !== undefined && typeof e.root !== "boolean") return `invalid root for ${slug}`;
    if (e.root === true) roots += 1;
  }
  if (roots > 0 && of !== "library") return "The home page is chosen from Library.";
  if (roots > 1) return "more than one root page";
  return null;
}

/**
 * The tag list, held to the rules the app keeps it by (src/tags.ts) —
 * every tag's name and values, the limits, no name twice. It is the
 * workspace's, so only Library's manifest has one.
 */
function validateTags(tags: unknown, of: ManifestOf): string | null {
  if (tags === undefined) return null;
  if (!Array.isArray(tags)) return "tags must be a list";
  if (of !== "library" && tags.length > 0) return "The tags are the workspace's, kept with Library.";
  for (const t of tags) {
    if (!isObject(t) || typeof t.name !== "string") return "invalid tag";
    if (!Array.isArray(t.values) || !t.values.every((v) => typeof v === "string")) return `invalid values for tag ${t.name}`;
    if (t.desc !== undefined && typeof t.desc !== "string") return `invalid desc for tag ${t.name}`;
  }
  const problem = listProblem(tags as TagDef[]);
  return problem ? `invalid tags: ${problem}` : null;
}

/** Where the shares in a section sit. Library holds none, and neither does a
 *  shared document: nothing sits in a document. */
function validateMounts(mounts: unknown, of: ManifestOf): string | null {
  if (mounts === undefined) return null;
  if (!isObject(mounts)) return "mounts must be an object";
  const ids = Object.keys(mounts);
  if (ids.length === 0) return null;
  if (of === "library") return "Nothing in Library is shared separately: it is everyone's.";
  if (of === "document") return ONE_DOCUMENT_SENTENCE;
  if (ids.length > MAX_MANIFEST_FILES) return "too many mounts";
  for (const id of ids) {
    if (!SHARE_ID_RE.test(id)) return `invalid mount id: ${id}`;
    const m = mounts[id];
    if (!isObject(m)) return `invalid mount: ${id}`;
    if (typeof m.dir !== "string" || (m.dir !== "" && !validPath(m.dir))) return `invalid mount dir for ${id}`;
    if (!isCount(m.rev) || m.rev < 1) return `invalid mount rev for ${id}`;
    if (!isAuthor(m.by)) return `invalid mount by for ${id}`;
    if (m.was !== undefined && !validPath(m.was)) return `invalid mount was for ${id}`;
  }
  return null;
}

/** Shape-check a manifest without trusting the client. `of` is which
 *  section's it is. */
export function validateManifest(data: unknown, of: ManifestOf): ManifestProblem | null {
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
    validateFiles(data.files, of) ??
    validateTombstones(data.tombstones) ??
    validatePublic(data.public, of) ??
    validateTags(data.tags, of) ??
    validateMounts(data.mounts, of);
  return problem ? bad(problem) : null;
}

/**
 * `data` without the files, tombstones and pages of a file that `syncs`
 * says no to — what the worker's own write makes of a stored manifest that
 * still lists one (commit.ts), so that the write cleans it, as the engine's
 * does (`build_manifest`). An entry this cannot read is left for
 * `validateManifest` to refuse.
 */
export function withoutUnsynced(data: unknown): unknown {
  if (!isObject(data)) return data;
  const keep = (map: unknown, kept: (e: Record<string, unknown>) => boolean): unknown =>
    isObject(map) ? Object.fromEntries(Object.entries(map).filter(([, e]) => !isObject(e) || kept(e))) : map;
  const synced = (e: Record<string, unknown>): boolean => typeof e.path !== "string" || syncs(e.path);
  return {
    ...data,
    files: keep(data.files, synced),
    ...(data.tombstones === undefined ? {} : { tombstones: keep(data.tombstones, synced) }),
    ...(data.public === undefined ? {} : { public: keep(data.public, (e) => e.kind !== "file" || synced(e)) }),
  };
}
