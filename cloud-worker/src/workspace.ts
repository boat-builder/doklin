// The worker's view of the synced tree (docs/cloud.md §5.6): the
// manifest — one `head` per request for its etag, the body only when the
// etag moved past the isolate's memoized copy — the files it lists by path
// and by id, their blobs, the notes under a folder, a folder's datastore and
// a note's meta sidecar. Every public page is rendered from what comes
// through here, which is why nothing public is ever stored: a page can never
// be staler than the sync, and never fresher. Nothing here writes.

import { readWorkspace, type WorkspaceRecord } from "./bucket";
import type { Env } from "./env";
import { MANIFEST_KEY, blobKey, validPath } from "./layout";
import type { Manifest, ManifestFile, PublicEntry } from "./manifest";
import { MANIFEST_VERSION } from "./version";
import { META_SUFFIX, parseEntityMeta, type EntityMeta } from "../../src/metaFile";
import type { Card } from "../../src/store/board";
import { parseFrontmatter } from "../../src/store/frontmatter";
import { STORE_FILE, parseStoreDef, type StoreDef } from "../../src/store/storeFile";

/** What the app opens as a note — the same rule as App.tsx's MD_EXT_RE. */
export const MD_EXT_RE = /\.(md|markdown|mdown|mkd)$/i;
export const MD_EXTENSIONS = ["md", "markdown", "mdown", "mkd"] as const;
export const isMarkdownPath = (p: string): boolean => MD_EXT_RE.test(p);
/** A note's stem: its path without the markdown extension. */
export const stemOf = (p: string): string => p.replace(MD_EXT_RE, "");
/** The html rendition beside a note: `<stem>.html` (App.tsx's htmlSiblingOf). */
export const htmlSiblingOf = (p: string): string => `${stemOf(p)}.html`;
export const isHtmlPath = (p: string): boolean => /\.html$/i.test(p);
export const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
export const dirOf = (p: string): string => {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "";
};

/** A page is a document, not a dump: past this a blob is not rendered. */
export const MAX_RENDER_BYTES = 4 * 1024 * 1024;
/**
 * Cards a board reads — each is one blob read, and a Worker on the free plan
 * may make 50 subrequests per request. Cards past the cap are counted on the
 * board, never silently dropped (`unread`).
 */
export const MAX_STORE_CARDS = 40;
/** A card's frontmatter lives in its first bytes; the app reads the same window (store.rs). */
const MAX_HEAD_BYTES = 16 * 1024;
/** Blob reads in flight at once. */
const READ_CONCURRENCY = 8;

export type Located = { fid: string; file: ManifestFile };

export type StoreRead = {
  def: StoreDef;
  cards: Card[];
  /** Cards the folder holds beyond MAX_STORE_CARDS — counted, not read. */
  unread: number;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const optText = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * The manifest as the reader trusts it. Every PUT was shape-checked, but a
 * page must never 500 on someone else's bytes: anything unreadable simply
 * reads as absent.
 */
function readManifest(v: unknown): Manifest {
  const manifest: Manifest = { version: MANIFEST_VERSION, seq: 0, files: {}, tombstones: {}, public: {} };
  if (!isObject(v)) return manifest;
  manifest.name = optText(v.name);
  manifest.seq = num(v.seq);
  if (isObject(v.files)) {
    for (const [fid, f] of Object.entries(v.files)) {
      if (!isObject(f) || !validPath(f.path) || typeof f.hash !== "string") continue;
      manifest.files[fid] = {
        path: f.path,
        rev: num(f.rev),
        hash: f.hash,
        size: num(f.size),
        ...(typeof f.mtime === "number" ? { mtime: f.mtime } : {}),
        ...(typeof f.by === "string" ? { by: f.by } : {}),
      };
    }
  }
  if (isObject(v.public)) {
    const map: Record<string, PublicEntry> = {};
    for (const [slug, e] of Object.entries(v.public)) {
      if (!isObject(e)) continue;
      const common = {
        title: optText(e.title),
        desc: optText(e.desc),
        root: e.root === true,
        by: optText(e.by),
        at: typeof e.at === "number" ? e.at : undefined,
      };
      if (e.kind === "file" && typeof e.file === "string" && validPath(e.path)) {
        map[slug] = { kind: "file", file: e.file, path: e.path, ...common };
      } else if (e.kind === "dir" && typeof e.path === "string" && (e.path === "" || validPath(e.path))) {
        map[slug] = { kind: "dir", path: e.path, ...common };
      }
    }
    manifest.public = map;
  }
  return manifest;
}

type Loaded = {
  etag: string;
  manifest: Manifest;
  record: WorkspaceRecord | null;
  byPath: Map<string, string>;
  /** Lowercased path → fid: the workspace lives on a case-insensitive disk, and so do typed URLs. */
  byLowerPath: Map<string, string>;
};

// The isolate's copy: re-read only when the manifest's etag moved.
let memo: Loaded | null = null;

/** The synced workspace behind this domain, or null when the domain holds none. */
export async function openWorkspace(env: Env): Promise<Workspace | null> {
  const head = await env.DATA.head(MANIFEST_KEY);
  if (!head) return null;
  if (!memo || memo.etag !== head.etag) {
    const obj = await env.DATA.get(MANIFEST_KEY);
    if (!obj) return null;
    let parsed: unknown = null;
    try {
      parsed = await obj.json();
    } catch {
      parsed = null;
    }
    const manifest = readManifest(parsed);
    const byPath = new Map<string, string>();
    const byLowerPath = new Map<string, string>();
    for (const [fid, f] of Object.entries(manifest.files)) {
      byPath.set(f.path, fid);
      if (!byLowerPath.has(f.path.toLowerCase())) byLowerPath.set(f.path.toLowerCase(), fid);
    }
    memo = { etag: obj.etag, manifest, record: await readWorkspace(env), byPath, byLowerPath };
  }
  return new Workspace(env, memo);
}

export class Workspace {
  readonly etag: string;
  readonly manifest: Manifest;
  readonly record: WorkspaceRecord | null;

  constructor(
    private readonly env: Env,
    private readonly loaded: Loaded,
  ) {
    this.etag = loaded.etag;
    this.manifest = loaded.manifest;
    this.record = loaded.record;
  }

  /** The workspace's name: the manifest's, else the binding's. */
  get name(): string {
    return this.manifest.name?.trim() || this.record?.name.trim() || "Notes";
  }

  /** The file at a workspace-relative path — exact first, then case-insensitive. */
  fileAt(path: string): Located | null {
    const fid = this.loaded.byPath.get(path) ?? this.loaded.byLowerPath.get(path.toLowerCase());
    return fid ? { fid, file: this.manifest.files[fid] } : null;
  }

  file(fid: string): Located | null {
    const file = this.manifest.files[fid];
    return file ? { fid, file } : null;
  }

  /** The note at a URL-ish path with its markdown extension dropped, trying each extension the app opens. */
  noteAt(stem: string): Located | null {
    for (const ext of MD_EXTENSIONS) {
      const hit = this.fileAt(`${stem}.${ext}`);
      if (hit) return hit;
    }
    return null;
  }

  /** A blob's text, or null when it is missing or too large to render. */
  async text(loc: Located, maxBytes = MAX_RENDER_BYTES): Promise<string | null> {
    if (loc.file.size > maxBytes) return null;
    const obj = await this.env.DATA.get(blobKey(loc.fid, loc.file.hash));
    if (!obj) return null;
    return obj.text();
  }

  /** The first bytes of a blob as text — a card's frontmatter head. */
  private async head(loc: Located): Promise<string | null> {
    const obj = await this.env.DATA.get(blobKey(loc.fid, loc.file.hash), {
      range: { offset: 0, length: MAX_HEAD_BYTES },
    });
    if (!obj) return null;
    return obj.text();
  }

  /** A blob, streamed, with the content type it was uploaded with. */
  async bytes(loc: Located): Promise<R2ObjectBody | null> {
    return this.env.DATA.get(blobKey(loc.fid, loc.file.hash));
  }

  /** Every note under a folder ("" is the whole workspace), deepest paths included, in path order. */
  children(dir: string): Located[] {
    const prefix = dir ? `${dir}/` : "";
    const out: Located[] = [];
    for (const [fid, file] of Object.entries(this.manifest.files)) {
      if (!isMarkdownPath(file.path)) continue;
      if (prefix && !file.path.startsWith(prefix)) continue;
      out.push({ fid, file });
    }
    out.sort((a, b) => a.file.path.localeCompare(b.file.path, undefined, { sensitivity: "base" }));
    return out;
  }

  /** The notes directly inside a folder — what the app lists as a board's cards (store.rs read_store). */
  directNotes(dir: string): Located[] {
    return this.children(dir).filter((loc) => dirOf(loc.file.path) === dir);
  }

  /**
   * A folder's datastore: its definition file and its cards' properties, the
   * way the app reads them (`read_store`) — direct-child notes only, heads
   * only, cards sorted by name. Null when the folder is not a board.
   */
  async storeAt(dir: string): Promise<StoreRead | null> {
    const defLoc = this.fileAt(dir ? `${dir}/${STORE_FILE}` : STORE_FILE);
    if (!defLoc) return null;
    const defText = await this.text(defLoc);
    if (defText === null) return null;
    const def = parseStoreDef(defText);
    if (!def) return null;
    const notes = this.directNotes(dir).sort((a, b) =>
      basename(a.file.path).localeCompare(basename(b.file.path)),
    );
    const read = notes.slice(0, MAX_STORE_CARDS);
    const heads = await mapLimited(read, READ_CONCURRENCY, (loc) => this.head(loc));
    const cards: Card[] = [];
    read.forEach((loc, i) => {
      const head = heads[i];
      if (head === null) return; // vanished between manifest and blob; the next sync mends it
      const fm = parseFrontmatter(head);
      const name = basename(loc.file.path);
      cards.push({
        path: loc.file.path,
        name,
        title: stemOf(name),
        snapshot: { mtime_ms: loc.file.mtime ?? 0, size: loc.file.size },
        props: fm.props,
        opaque: fm.opaque,
      });
    });
    return { def, cards, unread: notes.length - read.length };
  }

  /** A note's meta sidecar (`<stem>.meta.jsonl`), or null when it has none. */
  async meta(stem: string): Promise<EntityMeta | null> {
    const loc = this.fileAt(`${stem}${META_SUFFIX}`);
    if (!loc) return null;
    const text = await this.text(loc);
    return text === null ? null : parseEntityMeta(text);
  }
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}
