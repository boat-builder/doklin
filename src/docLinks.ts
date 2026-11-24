// Links written inside a note, and the documents they lead to.
//
// The click gesture lives in linkOpen.ts; this is where a link goes. In a
// folder of markdown files a link to another note is a relative path:
// `[launch-plan](../GTM/launch-plan.md)`. In a workspace that syncs, the
// note's sidecar also holds, for each such link, the id of the file it
// means (a `link` record, src/metaFile.ts), so the link still finds its file
// after a rename or a move, and its words follow the file's name when they
// are that name. The note's text is what decides which links there are; a
// record only adds an id.
//
// Pure string work, so it can be tested without a filesystem
// (verify-harness/doclinks.test.mjs). The worker imports it too. The
// iPhone's reader resolves links with a port of `linkKey`, `resolveLink`
// and `shownWords` (ios/DoklinKit/Sources/DoklinKit/Markdown/Links.swift),
// held to the same cases (verify-harness/links-fixture.json): change both.

import type { LinkRecord } from "./metaFile";

// Fold "." and ".." out of a slash path, the way the filesystem would. A ".."
// that walks past an absolute root is dropped; on a relative path it is kept,
// so the result stays a truthful (if unopenable) path rather than a wrong one.
export function normalizePath(p: string): string {
  const absolute = p.startsWith("/");
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(seg);
  }
  return (absolute ? "/" : "") + out.join("/");
}

export const dirOf = (p: string) => {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : p;
};

/**
 * Resolve a link's href against the note it was written in — "./other.md",
 * "../archive/x.md", "/Users/me/notes/x.md", "file:///…". Returns null when
 * the target can't be placed: an external URL, or a relative link in a
 * document that has no path of its own (an untitled note).
 *
 * A #fragment or ?query is dropped — opening the document is as far as a link
 * between files takes us.
 */
export function linkTargetPath(href: string, fromPath: string | null): string | null {
  let raw = href.trim();
  if (/^file:\/\//i.test(raw)) raw = raw.slice("file://".length);
  else if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null; // some other scheme: not a path
  raw = raw.split("#")[0].split("?")[0];
  if (!raw) return null;
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // a malformed escape sequence — take the path as written
  }
  if (raw.startsWith("/")) return normalizePath(raw);
  if (!fromPath) return null;
  return normalizePath(`${dirOf(fromPath)}/${raw}`);
}

/* ---------- Links to documents ---------- */

/** A document of the workspace that a link can lead to, as a backend lists
 *  them (`Documents.documents`, src/backend.ts). A markdown note's html
 *  rendition is part of the note, not a document of its own. Mirrors
 *  `WorkspaceDocument` (engine/src/cloud/status.rs ⇄ Payloads.swift): change
 *  all three. */
export type WorkspaceDocument = {
  /** Workspace-relative: `Library/GTM/launch-plan.md`. */
  path: string;
  /** Null for one no manifest carries yet, and in a folder that doesn't sync. */
  fileId: string | null;
  /** The section it is in; null for Library, the shared one. */
  section: string | null;
};

const DOCUMENT_RE = /\.(md|markdown|mdown|mkd|html)$/i;

/** Whether a path names a document: markdown or html. */
export const isDocumentPath = (p: string): boolean => DOCUMENT_RE.test(p);

const MARKDOWN_RE = /\.(md|markdown|mdown|mkd)$/i;

/** Which of `files` are documents: markdown, and html that is not a
 *  markdown note's rendition (`<stem>.html` beside `<stem>.md`), sorted by
 *  path. The engine's rule (`documents_of`, engine/src/cloud/status.rs):
 *  change both. */
export function documentsOf(files: WorkspaceDocument[]): WorkspaceDocument[] {
  const notes = new Set(files.filter((f) => MARKDOWN_RE.test(f.path)).map((f) => f.path.replace(MARKDOWN_RE, "").toLowerCase()));
  return files
    .filter((f) => MARKDOWN_RE.test(f.path) || (/\.html$/i.test(f.path) && !notes.has(f.path.slice(0, -".html".length).toLowerCase())))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The folder a workspace-relative path is in; "" at the top. */
const folderOf = (p: string): string => {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
};

/** A destination's path, and what follows it (`#…` or `?…`, kept as written). */
function splitDestination(href: string): { path: string; rest: string } {
  const at = href.search(/[#?]/);
  return at < 0 ? { path: href, rest: "" } : { path: href.slice(0, at), rest: href.slice(at) };
}

/**
 * The key a link's record is filed under: its destination's path, decoded,
 * with `.` and `..` folded (`./a.md` and `a.md` are one). Null when the link
 * is not to a document of the workspace: an address with a scheme (the web,
 * a *Copy link*, `file:`), a `#heading` of this note, a path from a disk's
 * root, or a file that is not a document.
 */
export function linkKey(href: string): string | null {
  const raw = href.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) return null;
  let path = splitDestination(raw).path;
  if (!path || path.startsWith("/")) return null;
  try {
    path = decodeURIComponent(path);
  } catch {
    // a malformed escape sequence: the path as written
  }
  const key = normalizePath(path);
  return key && isDocumentPath(key) ? key : null;
}

/** Where a key leads from the note at `from`, workspace-relative; null when
 *  it climbs out of the workspace. */
export function keyTarget(key: string, from: string): string | null {
  const folder = folderOf(from);
  const path = normalizePath(folder ? `${folder}/${key}` : key);
  return path === "" || path === ".." || path.startsWith("../") ? null : path;
}

/** The destination a note at `from` writes for the document at `to`: the
 *  path between their folders. Both are workspace-relative. */
export function relativePath(from: string, to: string): string {
  const mine = folderOf(from).split("/").filter(Boolean);
  const theirs = to.split("/");
  let same = 0;
  while (same < mine.length && same < theirs.length - 1 && mine[same] === theirs[same]) same += 1;
  return [...mine.slice(same).map(() => ".."), ...theirs.slice(same)].join("/");
}

/** A path as markdown writes it as a link's destination: inside `<…>` when
 *  it holds a space or anything else that would end it there. */
export function markdownDestination(path: string): string {
  return /[\s()<>]/.test(path) ? `<${path.replace(/[\\<>]/g, (c) => `\\${c}`)}>` : path;
}

/** A document's name as a link to it says it: its file name without the
 *  extension. */
export function documentName(path: string): string {
  return (path.slice(path.lastIndexOf("/") + 1) || path).replace(DOCUMENT_RE, "");
}

/** A name as a link's words write it: `[` and `]` escaped. */
export function linkWords(name: string): string {
  return name.replace(/[\\[\]]/g, (c) => `\\${c}`);
}

/** The documents a link can open, by file id and by path. An id in two
 *  sections (a move between sections half done) is the shared section's,
 *  else the one in the lowest section id: every device answers alike, as
 *  `Engine::follow` does (engine/src/cloud/engine.rs). */
export type DocumentIndex = {
  byId: Map<string, WorkspaceDocument>;
  byPath: Map<string, WorkspaceDocument>;
};

export function indexDocuments(docs: WorkspaceDocument[]): DocumentIndex {
  const byId = new Map<string, WorkspaceDocument>();
  const byPath = new Map<string, WorkspaceDocument>();
  for (const doc of docs) {
    byPath.set(doc.path.toLowerCase(), doc);
    if (doc.fileId === null) continue;
    const held = byId.get(doc.fileId);
    if (!held || (doc.section ?? "") < (held.section ?? "")) byId.set(doc.fileId, doc);
  }
  return { byId, byPath };
}

/** What a link opens. `record`: it has one, and the id decides, never its
 *  path, which may be somebody else's file; `doc` null is a link that opens
 *  nothing here: a file deleted, in a section this person is not in, or
 *  never there, all alike. `path`: it has none, and goes by its path, as
 *  every link did before records. */
export type ResolvedLink =
  | { by: "record"; key: string; doc: WorkspaceDocument | null }
  | { by: "path"; key: string; path: string | null; doc: WorkspaceDocument | null };

/** What the link `href` in the note at `from` opens; null for a link that is
 *  not to a document (`linkKey`), which goes as it always did. */
export function resolveLink(href: string, from: string, records: LinkRecord[], docs: DocumentIndex): ResolvedLink | null {
  const key = linkKey(href);
  if (key === null) return null;
  const record = records.find((r) => r.id === key);
  if (record) return { by: "record", key, doc: docs.byId.get(record.file) ?? null };
  const path = keyTarget(key, from);
  return { by: "path", key, path, doc: path === null ? null : (docs.byPath.get(path.toLowerCase()) ?? null) };
}

/** Whether a link's words are its destination's file name: a named link,
 *  whose words are its document's name and follow it. */
export const isNamedLink = (words: string, key: string): boolean => words === documentName(key);

/** The words a link shows: a named link's are its document's name now, any
 *  other words are the author's. */
export function shownWords(words: string, resolved: ResolvedLink): string {
  return resolved.doc && isNamedLink(words, resolved.key) ? documentName(resolved.doc.path) : words;
}

/* ---------- What a save writes ---------- */

/** A link in a note as the editor hands it to a save: its destination and
 *  words as they are written now, and, for one made in this editor (picked
 *  from the `@` list, or pasted from another note), the file id it was made
 *  with. */
export type NoteLink = { href: string; words: string; made?: string };

/** What the save writes for each link, in the same order, and the records
 *  the note's sidecar is to hold. */
export type SavedLinks = { links: { href: string; words: string }[]; records: LinkRecord[] };

/**
 * What a save writes for the links of the note at `note.path`, in section
 * `note.section` (null: Library), given the records it was read with.
 *
 * 1. A link made in this editor gets a record from the id it was made with.
 * 2. A link that has a record keeps it, written from where its document is
 *    now: its destination, and a named link's words.
 * 3. A link with no record gets one by its path, but only when that path
 *    leads into the note's own section or into Library, the same file for
 *    everyone who reads the note. Into a Private or a restricted folder from
 *    outside it may name another person's folder on another device, so no
 *    id is guessed for it.
 * 4. Writing back never reveals: a link whose document is in a section other
 *    than the note's own and other than Library is written back as it was,
 *    unless it was made in this editor just now. So a move into a restricted
 *    folder, or a rename there, never puts its new name or folder into notes
 *    that people outside it read.
 */
export function linksToSave(
  note: { path: string; section: string | null },
  links: NoteLink[],
  records: LinkRecord[],
  docs: DocumentIndex,
): SavedLinks {
  const filed = new Map(records.map((r) => [r.id, r.file]));
  const out: SavedLinks = { links: [], records: [] };
  const recorded = new Set<string>();
  const record = (key: string, file: string) => {
    if (recorded.has(key)) return;
    recorded.add(key);
    out.records.push({ id: key, file });
  };
  const opensForAll = (doc: WorkspaceDocument) => doc.section === null || doc.section === note.section;
  // Written from where `doc` is now, the fragment kept; a named link's
  // words follow its name.
  const current = (link: NoteLink, key: string, doc: WorkspaceDocument) => {
    const now = relativePath(note.path, doc.path);
    const href = now === key ? link.href : now + splitDestination(link.href.trim()).rest;
    const words = isNamedLink(link.words, key) ? documentName(doc.path) : link.words;
    return { href, words, key: now };
  };
  for (const link of links) {
    const key = linkKey(link.href);
    if (key === null) {
      out.links.push({ href: link.href, words: link.words });
      continue;
    }
    const made = link.made !== undefined ? docs.byId.get(link.made) : undefined;
    const file = link.made ?? filed.get(key);
    if (file !== undefined) {
      const doc = made ?? docs.byId.get(file);
      const written = doc && (link.made !== undefined || opensForAll(doc)) ? current(link, key, doc) : null;
      out.links.push(written ? { href: written.href, words: written.words } : { href: link.href, words: link.words });
      record(written?.key ?? key, file);
      continue;
    }
    out.links.push({ href: link.href, words: link.words });
    const path = keyTarget(key, note.path);
    const doc = path === null ? undefined : docs.byPath.get(path.toLowerCase());
    if (doc?.fileId && opensForAll(doc)) record(key, doc.fileId);
  }
  return out;
}
