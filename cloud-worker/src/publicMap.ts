// The public map, resolved against the synced tree: which slug a file
// answers at, which folder page covers a path, and the one question every
// link, board card and table-of-contents row asks — "where is this file
// public?" (docs/cloud-redesign.md §5.6, Slugs and paths).
//
// A note can be public two ways at once: on its own slug and inside a
// published folder, at a Notion-style nested URL. Both answer; which one a
// link prefers depends on where the link is (a page inside a folder share
// keeps its reader inside the folder).

import type { PublicEntry } from "./manifest";
import { isMarkdownPath, stemOf, type Workspace } from "./workspace";

export type FileEntry = Extract<PublicEntry, { kind: "file" }>;
export type DirEntry = Extract<PublicEntry, { kind: "dir" }>;
export type Page = { slug: string; entry: PublicEntry };
export type DirPage = { slug: string; entry: DirEntry };

/** The URL of a file inside a published folder: the slug, then the path relative to the folder, `.md` dropped, segments encoded. */
export function nestedUrl(dir: DirPage, path: string): string {
  const rel = dir.entry.path ? path.slice(dir.entry.path.length + 1) : path;
  const shown = isMarkdownPath(rel) ? stemOf(rel) : rel;
  return `/${dir.slug}/${shown.split("/").map(encodeURIComponent).join("/")}`;
}

const covers = (dir: DirEntry, path: string): boolean =>
  dir.path === "" || path.startsWith(`${dir.path}/`);

export class PublicMap {
  readonly entries = new Map<string, PublicEntry>();
  /** The entry that serves at `/`, if the map names one. */
  readonly root: Page | null;
  /** Folder pages, deepest first — the first that covers a path is its closest. */
  readonly dirs: DirPage[] = [];
  private readonly slugOfFile = new Map<string, string>();
  private readonly slugOfDir = new Map<string, string>();

  constructor(private readonly ws: Workspace) {
    let root: Page | null = null;
    for (const slug of Object.keys(ws.manifest.public ?? {}).sort()) {
      const entry = ws.manifest.public![slug];
      this.entries.set(slug, entry);
      if (entry.root && !root) root = { slug, entry };
      if (entry.kind === "file") {
        if (!this.slugOfFile.has(entry.file)) this.slugOfFile.set(entry.file, slug);
      } else {
        this.dirs.push({ slug, entry });
        if (!this.slugOfDir.has(entry.path)) this.slugOfDir.set(entry.path, slug);
      }
    }
    this.dirs.sort((a, b) => b.entry.path.length - a.entry.path.length || a.slug.localeCompare(b.slug));
    this.root = root;
  }

  page(slug: string): Page | null {
    const entry = this.entries.get(slug);
    return entry ? { slug, entry } : null;
  }

  /** The closest published folder covering a path, or — when `prefer` names one that covers it — that one. */
  folderCovering(path: string, prefer?: string | null): DirPage | null {
    if (prefer) {
      const preferred = this.dirs.find((d) => d.slug === prefer);
      if (preferred && covers(preferred.entry, path)) return preferred;
    }
    return this.dirs.find((d) => covers(d.entry, path)) ?? null;
  }

  /** A folder's own page, when the folder itself is published. */
  dirPage(path: string): DirPage | null {
    const slug = this.slugOfDir.get(path);
    return slug ? { slug, entry: this.entries.get(slug) as DirEntry } : null;
  }

  /**
   * Where a synced file is public: inside `prefer`'s folder when that folder
   * covers it, else on its own slug, else inside the closest published
   * folder. Null when it is not public anywhere — the link stays text.
   */
  urlFor(path: string, prefer?: string | null): string | null {
    const fid = this.ws.fileAt(path)?.fid ?? null;
    if (!fid) return null;
    const own = this.slugOfFile.get(fid);
    if (prefer) {
      const preferred = this.folderCovering(path, prefer);
      if (preferred && preferred.slug === prefer) return nestedUrl(preferred, path);
    }
    if (own) return `/${own}`;
    const covering = this.folderCovering(path);
    return covering ? nestedUrl(covering, path) : null;
  }
}
