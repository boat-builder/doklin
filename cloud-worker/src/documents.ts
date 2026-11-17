// A document, as the document API speaks of one.
//
// On disk, and in the manifest, a document is up to three files that share a
// stem: `plan.md`, its optional `plan.html` rendition, and `plan.meta.jsonl`
// holding its comment threads (src/metaFile.ts). The app has always treated
// them as one thing. Here that becomes the only view an agent gets: one name,
// up to two *versions* — markdown and html — and never the sidecar. There is
// nothing else to get: those are the only files Doklin syncs (`syncs`,
// layout.ts).
//
// Everything in this file is a pure reading of the manifest: which files make
// up the document a path names, which version a request means, what a folder
// holds. Nothing here reads a blob or writes anything.

import { Refusal } from "./commit";
import { UNSYNCED_SENTENCE, validPath } from "./layout";
import type { Manifest, ManifestFile } from "./manifest";
import { nestedUrl } from "./publicMap";
import { MD_EXT_RE, basename, dirOf, isHtmlPath, isMarkdownPath } from "./workspace";
import { META_SUFFIX } from "../../src/metaFile";

export type Version = "md" | "html";
export const VERSION_WORD: Record<Version, string> = { md: "markdown", html: "html" };

export type Entry = { fid: string; file: ManifestFile };

/** The extensions the app opens as a note, in the order it prefers them. */
const MD_EXTENSIONS = ["md", "markdown", "mdown", "mkd"] as const;

/** Folder names a device's scan never descends into (`is_hidden_or_ignored`,
 *  engine/src/lib.rs; `isHiddenOrIgnored` in the iPhone app's Files.swift).
 *  A file put under one would sync to nobody. Change all three. */
const IGNORED_NAMES: ReadonlySet<string> = new Set(["node_modules", "target", "dist", "build", "__pycache__"]);
/** The engine's own in-flight writes (`TMP_SUFFIX`, engine/src/cloud/scan.rs). */
const TMP_SUFFIX = ".doklin-sync-tmp";

/** How much older than its markdown an html version may be before it is
 *  called behind. Two files written together are stamped a moment apart. */
const HTML_BEHIND_SLACK_MS = 2000;

/** Why a path cannot be used, or null. Stricter than the manifest's own
 *  grammar: these are the paths a Mac's scan would never see. A path that
 *  names a file which is not a document is `locate`'s to refuse: this one
 *  also checks folders, whose names may have dots. */
export function pathProblem(path: string): string | null {
  if (!validPath(path)) {
    return "that is not a path in a workspace — use forward slashes, with no leading slash and no . or .. segments";
  }
  for (const seg of path.split("/")) {
    if (seg.startsWith(".")) return `"${seg}" is hidden — Doklin does not sync names that begin with a dot`;
    if (IGNORED_NAMES.has(seg)) return `"${seg}" is a folder Doklin does not sync`;
    if (seg.endsWith(TMP_SUFFIX)) return `"${seg}" is a name Doklin keeps for its own in-flight writes`;
  }
  if (path.toLowerCase().endsWith(META_SUFFIX)) {
    return "that file is where Doklin keeps a document's comments — read and write them with the comments commands";
  }
  return null;
}

/** A path split into the document it names and the version its extension picks. */
export function nameOf(path: string): { stem: string; version: Version | null } {
  const md = MD_EXT_RE.exec(path);
  if (md) return { stem: path.slice(0, -md[0].length), version: "md" };
  if (isHtmlPath(path)) return { stem: path.slice(0, -".html".length), version: "html" };
  return { stem: path, version: null };
}

/** The version a request picked — by its flag, or by the extension it typed —
 *  or null when it picked none, or a refusal when the two disagree. */
export function askedVersion(path: string, flag: Version | null): Version | null | Refusal {
  const typed = nameOf(path).version;
  if (flag && typed && flag !== typed) {
    return new Refusal(
      400,
      `${basename(path)} names the ${VERSION_WORD[typed]} version — drop the flag, or name the document without its extension`,
    );
  }
  return flag ?? typed;
}

/** Whether a name carries an extension of its own (`chart.png`, not `plan`). */
const hasExtension = (path: string): boolean => /[^.]\.[^./]+$/.test(basename(path));

/** The files that make up one document. `mds` is every markdown file with
 *  the stem — more than one is the ambiguous case; `md` is the one meant. */
export type Doc = {
  /** The path without an extension, in the case the files carry. */
  stem: string;
  md: Entry | null;
  mds: Entry[];
  html: Entry | null;
  /** The sidecar holding its comment threads. Never shown to an agent. */
  meta: Entry | null;
};

export const docExists = (doc: Doc): boolean => doc.md !== null || doc.html !== null;
/** The file a document is known by: its markdown, or its html when it has none. */
export const primaryOf = (doc: Doc): Entry | null => doc.md ?? doc.html;

/** The manifest's files, findable by path the way a case-insensitive disk finds them. */
export class Index {
  private readonly byLower = new Map<string, string>();

  constructor(readonly files: Record<string, ManifestFile>) {
    for (const [fid, f] of Object.entries(files)) {
      const key = f.path.toLowerCase();
      if (!this.byLower.has(key)) this.byLower.set(key, fid);
    }
  }

  at(path: string): Entry | null {
    const fid = this.byLower.get(path.toLowerCase());
    return fid ? { fid, file: this.files[fid] } : null;
  }

  /** The document with this stem — which may turn out to have no files. */
  doc(stem: string): Doc {
    const mds = MD_EXTENSIONS.map((ext) => this.at(`${stem}.${ext}`)).filter((e): e is Entry => e !== null);
    const html = this.at(`${stem}.html`);
    const meta = this.at(`${stem}${META_SUFFIX}`);
    const known = mds[0] ?? html;
    return {
      stem: known ? nameOf(known.file.path).stem : stem,
      md: mds[0] ?? null,
      mds,
      html,
      meta,
    };
  }

  /** Whether anything lives under `dir` — which makes `dir` a folder. */
  isFolder(dir: string): boolean {
    const prefix = `${dir.toLowerCase()}/`;
    for (const key of this.byLower.keys()) if (key.startsWith(prefix)) return true;
    return false;
  }

  /** Every file under a folder. */
  under(dir: string): Entry[] {
    const prefix = `${dir.toLowerCase()}/`;
    const out: Entry[] = [];
    for (const [key, fid] of this.byLower) if (key.startsWith(prefix)) out.push({ fid, file: this.files[fid] });
    return out;
  }

  /**
   * `path` with its folders spelled the way the workspace already spells
   * them: a new file typed under `projects/` goes into `Projects/` when that
   * is the folder there is. On a Mac's case-insensitive disk it would land
   * there whatever the manifest said, and the engine — which matches paths
   * exactly — would have to rename it to agree. The name itself, and any
   * folder that does not exist yet, stay as typed.
   */
  spelled(path: string): string {
    const segs = path.split("/");
    for (let i = segs.length - 1; i >= 1; i -= 1) {
      const dir = segs.slice(0, i).join("/");
      const inside = this.under(dir)[0];
      if (inside) return `${inside.file.path.slice(0, dir.length)}/${segs.slice(i).join("/")}`;
    }
    return path;
  }

  /**
   * Why nothing can be created at `path`: a file is in the way of one of its
   * folders, or a folder already has its name. Null when the place is free.
   * (A file already AT the path is the caller's question, not this one.)
   */
  placeProblem(path: string): string | null {
    const segs = path.split("/");
    for (let i = 1; i < segs.length; i += 1) {
      const dir = segs.slice(0, i).join("/");
      const inTheWay = this.at(dir);
      if (inTheWay) return `"${inTheWay.file.path}" is a file, so nothing can be put inside it`;
    }
    if (this.isFolder(path)) return `"${path}" is already a folder`;
    return null;
  }
}

/** The document a path names, which may not exist yet. */
export type Named = {
  doc: Doc;
  /** The version the request picked — by flag or by extension — if it picked one. */
  asked: Version | null;
  /** Where a markdown or an html version of it would be created. */
  mdPath: string;
  htmlPath: string;
};

/**
 * Resolve a path, and an optional version flag, to the document they name.
 *
 *   Projects/plan        the document, whichever versions it has
 *   Projects/plan.md     the document, and its markdown version
 *   Projects/plan.html   the document, and its html version
 *   Projects/chart.png   refused: not a document, and Doklin syncs nothing else
 *
 * A name with an extension of its own that is not a document's is refused —
 * unless a document or a folder has that name (`v1.2` for `v1.2.md`, or a
 * folder called `v1.2`), or a version flag says it is one.
 */
export function locate(index: Index, path: string, flag: Version | null): Named | Refusal {
  const problem = pathProblem(path);
  if (problem) return new Refusal(400, problem);
  const named = nameOf(path);
  const asked = askedVersion(path, flag);
  if (asked instanceof Refusal) return asked;
  const doc = index.doc(named.stem);

  if (named.version === null && !asked && hasExtension(path) && !docExists(doc) && !index.isFolder(path)) {
    return new Refusal(
      400,
      `${UNSYNCED_SENTENCE} — "${basename(path)}" is neither. Name a document: plan, plan.md or plan.html.`,
    );
  }

  if (named.version === "md") {
    // The markdown file named in full is the one meant, when it is there.
    const exact = doc.mds.find((e) => e.file.path.toLowerCase() === path.toLowerCase());
    if (exact) doc.md = exact;
  } else if (doc.mds.length > 1) {
    const names = doc.mds.map((e) => basename(e.file.path)).join(", ");
    return new Refusal(409, `more than one markdown file is called "${basename(doc.stem)}" (${names}) — name the one you mean in full`, {
      candidates: doc.mds.map((e) => e.file.path),
    });
  }
  return {
    doc,
    asked,
    mdPath: doc.md?.file.path ?? (named.version === "md" ? path : `${doc.stem}.md`),
    htmlPath: doc.html?.file.path ?? `${doc.stem}.html`,
  };
}

/* ---------- What a listing says ---------- */

export type VersionInfo = {
  /** The file's own name, extension included. */
  file: string;
  rev: number;
  size: number;
  /** When its content last changed, epoch ms. */
  changed: number | null;
  /** Who changed it: a member or agent id, as the manifest carries it. */
  by: string | null;
};

export type DocRow = {
  path: string;
  md?: VersionInfo;
  html?: VersionInfo;
  /** The html version is older than the markdown it was made from. */
  htmlBehind?: true;
};

export type Listing = { dir: string; folders: string[]; documents: DocRow[] };

const versionInfo = (e: Entry): VersionInfo => ({
  file: basename(e.file.path),
  rev: e.file.rev,
  size: e.file.size,
  changed: e.file.mtime ?? null,
  by: e.file.by ?? null,
});

/** Whether the html version is behind the markdown: made before the markdown
 *  last changed. Nothing is stored for it — the two dates say it. */
export function htmlBehind(doc: Doc): boolean {
  const md = doc.md?.file.mtime;
  const html = doc.html?.file.mtime;
  return md !== undefined && html !== undefined && md - html > HTML_BEHIND_SLACK_MS;
}

/**
 * Every address a document is public at: a page of its own, the domain root
 * when that page is the home page, and its place inside each published folder
 * that covers it. Its two versions share one address.
 */
export function addressesOf(m: Manifest, origin: string, doc: Doc): string[] {
  const primary = primaryOf(doc);
  if (!primary) return [];
  const path = primary.file.path;
  const fids = [doc.md?.fid, doc.html?.fid].filter((f): f is string => f !== undefined);
  const out: string[] = [];
  for (const slug of Object.keys(m.public ?? {}).sort()) {
    const entry = m.public![slug];
    if (entry.kind === "file") {
      if (!fids.includes(entry.file)) continue;
      if (entry.root) out.push(`${origin}/`);
      out.push(`${origin}/${slug}`);
    } else if (entry.path === "" || path.startsWith(`${entry.path}/`)) {
      // A note at its name, an html document at its exact path (pages.ts).
      if (isMarkdownPath(path) || isHtmlPath(path)) out.push(`${origin}${nestedUrl({ slug, entry }, path)}`);
    }
  }
  return out;
}

export function docRow(doc: Doc): DocRow {
  return {
    path: doc.stem,
    ...(doc.md ? { md: versionInfo(doc.md) } : {}),
    ...(doc.html ? { html: versionInfo(doc.html) } : {}),
    ...(htmlBehind(doc) ? { htmlBehind: true as const } : {}),
  };
}

const byName = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: "base" });

/** Every document under a folder ("" is the whole workspace), sidecars folded away. */
export function documentsUnder(index: Index, dir: string): Doc[] {
  const prefix = dir ? `${dir.toLowerCase()}/` : "";
  const seen = new Set<string>();
  const out: Doc[] = [];
  for (const f of Object.values(index.files)) {
    const lower = f.path.toLowerCase();
    if (prefix && !lower.startsWith(prefix)) continue;
    if (!isMarkdownPath(f.path) && !isHtmlPath(f.path)) continue;
    const { stem } = nameOf(f.path);
    if (seen.has(stem.toLowerCase())) continue;
    seen.add(stem.toLowerCase());
    out.push(index.doc(stem));
  }
  return out.sort((a, b) => byName(a.stem, b.stem));
}

/**
 * What a folder holds: its folders and its documents. Not deep, only what
 * sits directly in it; deep, everything beneath it. Built from the manifest
 * alone, so it costs no blob read — and so a folder with nothing in it does
 * not exist here, because it does not exist there.
 */
export function listTree(m: Manifest, dir: string, deep: boolean): Listing {
  const index = new Index(m.files);
  const prefix = dir ? `${dir.toLowerCase()}/` : "";
  const folders = new Map<string, string>();
  const documents: DocRow[] = [];
  const seenDocs = new Set<string>();

  for (const file of Object.values(m.files)) {
    const lower = file.path.toLowerCase();
    if (prefix && !lower.startsWith(prefix)) continue;
    const rel = file.path.slice(prefix.length);
    const segs = rel.split("/");
    // Each folder between here and the file: all of them when deep, the first otherwise.
    for (let i = 1; i < segs.length && (deep || i === 1); i += 1) {
      const folder = file.path.slice(0, prefix.length + segs.slice(0, i).join("/").length);
      if (!folders.has(folder.toLowerCase())) folders.set(folder.toLowerCase(), folder);
    }
    if (!deep && segs.length > 1) continue;
    if (lower.endsWith(META_SUFFIX)) continue;

    const { stem } = nameOf(file.path);
    if (seenDocs.has(stem.toLowerCase())) continue;
    seenDocs.add(stem.toLowerCase());
    const doc = index.doc(stem);
    if (doc.mds.length > 1) {
      // Two markdown files with one stem are two documents that have to be
      // named in full; the html beside them belongs to neither by name.
      for (const md of doc.mds) {
        documents.push(docRow({ stem: md.file.path, md, mds: [md], html: null, meta: null }));
      }
      if (doc.html) documents.push(docRow({ stem: doc.html.file.path, md: null, mds: [], html: doc.html, meta: null }));
      continue;
    }
    documents.push(docRow(doc));
  }
  return {
    dir,
    folders: [...folders.values()].sort(byName),
    documents: documents.sort((a, b) => byName(a.path, b.path)),
  };
}

/** The folder a document sits in — re-exported so callers need one import. */
export { basename, dirOf };
