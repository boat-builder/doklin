// Links between documents, for agents.
//
// An agent holds no copy of the workspace and never sees a sidecar or an
// id, so the worker does for it what the app does for a person:
//
//   · a read shows each link that has a record where its document is now,
//     and a named link saying its document's name now, as the agent's
//     person can open them; anything else is as stored (`shownNote`);
//   · a write keeps each link's record under the destination now written,
//     and gives a link the agent wrote one, by its path in its person's view
//     (`linksWritten`) — then what a save writes decides (`linksToSave`,
//     src/docLinks.ts), so a link into a section the note's readers are not
//     all in is stored as it was;
//   · `GET links` says what a document links to and what links to it.
//
// The rules of a link — its key, its record, its words — are
// src/docLinks.ts's; where a link is in a note's text is noteLinks.ts's.
//
//   GET /api/agent/links?path=&from=1&to=1[&after=]

import { cursorOf, inSection, notBound, openTree, refuse, type Call } from "./agentCall";
import type { Section } from "./agentPlace";
import { readWorkspace } from "./bucket";
import { Refusal } from "./commit";
import { Index, docExists, locate, nameOf, type Doc, type Entry } from "./documents";
import type { Env } from "./env";
import { json } from "./http";
import { LIBRARY_FOLDER, blobKey } from "./layout";
import type { ManifestFile } from "./manifest";
import { labelOf, linksIn, replaced, type WrittenLink } from "./noteLinks";
import { linkersOf } from "./search";
import { MAX_SECTIONS_READ, sharedEnv, spaceOf } from "./spaces";
import {
  documentName,
  documentsOf,
  indexDocuments,
  isNamedLink,
  keyTarget,
  linkKey,
  linksToSave,
  markdownDestination,
  shownLink,
  type DocumentIndex,
  type NoteLink,
  type WorkspaceDocument,
} from "../../src/docLinks";
import { parseEntityMeta, type LinkRecord } from "../../src/metaFile";
import { pageLinkOf } from "../../src/pageLink";

/** The section a call is answered in, as a document's `section` names it:
 *  null for Library. */
export const sectionOfCall = (c: Pick<Call, "env">): string | null => spaceOf(c.env) || null;

/** One section's documents, under the names its person uses. */
const documentsIn = (files: Record<string, ManifestFile>, section: string | null): WorkspaceDocument[] =>
  documentsOf(Object.entries(files).map(([fid, f]) => ({ path: f.path, fileId: fid, section })));

/**
 * The documents an agent's person can open, read a section at a time as
 * links need them: the call's own section and Library first, then the
 * section a path names, and — for an id found in neither — every section
 * the person is in, as many as a request opens (`MAX_SECTIONS_READ`).
 */
export class PersonDocs {
  /** By space, "" Library. */
  private readonly held = new Map<string, WorkspaceDocument[]>();
  private everywhere = false;

  constructor(private readonly c: Call) {}

  /** The call's own section as it is now: a write's, in the change it makes. */
  own(files: Record<string, ManifestFile>): this {
    this.held.set(spaceOf(this.c.env), documentsIn(files, sectionOfCall(this.c)));
    return this;
  }

  private async load(section: Section): Promise<void> {
    if (this.held.has(section.space)) return;
    const tree = await openTree(inSection(this.c, section));
    this.held.set(section.space, tree ? documentsIn(tree.manifest.files, section.space || null) : []);
  }

  private indexed(): DocumentIndex {
    return indexDocuments([...this.held.values()].flat());
  }

  /** The documents that cover `ids` and `paths` (paths as the person names
   *  them, `Library/…`), as an index. A document this person cannot open is
   *  not in it. */
  async index(ids: readonly string[], paths: readonly string[]): Promise<DocumentIndex> {
    if (!this.held.has(spaceOf(this.c.env))) {
      const tree = await openTree(this.c);
      this.held.set(spaceOf(this.c.env), tree ? documentsIn(tree.manifest.files, sectionOfCall(this.c)) : []);
    }
    const library = await this.c.places.at(LIBRARY_FOLDER);
    if (!(library instanceof Refusal) && typeof library !== "string") await this.load(library);
    let docs = this.indexed();
    for (const path of paths) {
      if (docs.byPath.has(path.toLowerCase())) continue;
      const at = await this.c.places.at(path);
      if (at instanceof Refusal || typeof at === "string" || this.held.has(at.space)) continue;
      await this.load(at);
      docs = this.indexed();
    }
    if (!this.everywhere && ids.some((id) => !docs.byId.has(id))) {
      this.everywhere = true;
      let opened = 0;
      for (const section of (await this.c.places.all()) ?? []) {
        if (this.held.has(section.space)) continue;
        if ((opened += 1) > MAX_SECTIONS_READ) break;
        await this.load(section);
      }
      docs = this.indexed();
    }
    return docs;
  }
}

/** What to write over a link so it reads `to`. */
function editsTo(link: WrittenLink, to: { href: string; words: string }): { at: [number, number]; text: string }[] {
  if (!link.at) return [];
  return [
    ...(to.href !== link.href ? [{ at: link.at.dest, text: markdownDestination(to.href) }] : []),
    ...(to.words !== link.words ? [{ at: link.at.label, text: labelOf(to.words) }] : []),
  ];
}

/**
 * The note at `path` (as its person names it) as an agent reads it: each
 * link that has a record pointing where its document is now, and a named
 * one saying its document's name now — when the agent's person can open it.
 * Every other link is as stored.
 */
export async function shownNote(person: PersonDocs, path: string, text: string, records: readonly LinkRecord[]): Promise<string> {
  if (records.length === 0) return text;
  const filed = new Map(records.map((r) => [r.id, r.file]));
  const recorded = linksIn(text).flatMap((link) => {
    const key = linkKey(link.href);
    const file = key === null ? undefined : filed.get(key);
    return file === undefined || !link.at ? [] : [{ link, file }];
  });
  if (recorded.length === 0) return text;
  const docs = await person.index(
    recorded.map((r) => r.file),
    [],
  );
  return replaced(
    text,
    recorded.flatMap(({ link, file }) => {
      const doc = docs.byId.get(file);
      return doc ? editsTo(link, shownLink(path, link, doc)) : [];
    }),
  );
}

/** A destination's path, and what follows it (`#…`, `?…`). */
function cut(href: string): [string, string] {
  const at = href.search(/[#?]/);
  return at < 0 ? [href, ""] : [href.slice(0, at), href.slice(at)];
}

/**
 * What an agent's write of the note at `note.path` stores, given the text
 * it sends and the note as stored ("" for a new one) with its records.
 *
 * A link of the stored note that has a record is known by its destination
 * as stored or as a read showed it, and is taken back to the form the note
 * has, as the editor hands its links to a save (`writeLinks`,
 * src/linkMark.ts): words the agent changed stay its own. A link the
 * stored note did not have is the agent's own, and gets a record by its
 * path in its person's view, in any section, as a link picked in the
 * editor does. One that was there without a record is left to the rule for
 * those. Answers the text to store and the records its sidecar is to hold.
 */
export async function linksWritten(
  person: PersonDocs,
  note: { path: string; section: string | null },
  sent: string,
  stored: { text: string; records: readonly LinkRecord[] },
): Promise<{ text: string; records: LinkRecord[] }> {
  type Known = { link: WrittenLink; file: string; shown: { href: string; words: string } | null; raw: { dest: string; label: string } | null };
  const filed = new Map(stored.records.map((r) => [r.id, r.file]));
  const byKey = new Map<string, Known>();
  const withoutRecord = new Set<string>();
  for (const link of linksIn(stored.text)) {
    const key = linkKey(link.href);
    if (key === null) continue;
    const file = filed.get(key);
    if (file === undefined) withoutRecord.add(key);
    else if (!byKey.has(key)) {
      const raw = link.at ? { dest: stored.text.slice(...link.at.dest), label: stored.text.slice(...link.at.label) } : null;
      byKey.set(key, { link, file, shown: null, raw });
    }
  }
  const links = linksIn(sent);
  const keys = links.map((l) => linkKey(l.href));
  if (keys.every((k) => k === null)) return { text: sent, records: [] };
  const elsewhere = keys.filter((k): k is string => k !== null && !byKey.has(k) && !withoutRecord.has(k));
  const docs = await person.index(
    [...byKey.values()].map((k) => k.file),
    elsewhere.flatMap((k) => keyTarget(k, note.path) ?? []),
  );

  // Where a read showed each stored link.
  const byShown = new Map<string, Known>();
  for (const k of byKey.values()) {
    const doc = docs.byId.get(k.file);
    if (!doc) continue;
    k.shown = shownLink(note.path, k.link, doc);
    const key = linkKey(k.shown.href);
    if (key !== null && !byShown.has(key)) byShown.set(key, k);
  }
  const known = keys.map((key) => (key === null ? null : (byKey.get(key) ?? byShown.get(key) ?? null)));
  const asSaved: NoteLink[] = links.map((l, i): NoteLink => {
    const key = keys[i];
    const k = known[i];
    if (key === null) return { href: l.href, words: l.words };
    if (k) {
      const words = l.words === (k.shown?.words ?? k.link.words) ? k.link.words : l.words;
      const href = byKey.get(key) === k ? l.href : cut(k.link.href)[0] + cut(l.href)[1];
      return { href, words };
    }
    if (withoutRecord.has(key)) return { href: l.href, words: l.words };
    const target = keyTarget(key, note.path);
    const doc = target === null ? undefined : docs.byPath.get(target.toLowerCase());
    return doc?.fileId ? { href: l.href, words: l.words, made: doc.fileId } : { href: l.href, words: l.words };
  });
  const saved = linksToSave(note, asSaved, [...stored.records], docs);

  // Written over the agent's own text, so whatever else it changed stays;
  // a link that could not be placed keeps what it sent, and its record says so.
  const fileOf = new Map(saved.records.map((r) => [r.id, r.file]));
  const edits: { at: [number, number]; text: string }[] = [];
  const records: LinkRecord[] = [];
  links.forEach((l, i) => {
    const out = saved.links[i];
    const file = fileOf.get(linkKey(out.href) ?? "");
    const k = known[i];
    if (l.at) {
      if (out.href !== l.href) edits.push({ at: l.at.dest, text: k?.raw && out.href === k.link.href ? k.raw.dest : markdownDestination(out.href) });
      if (out.words !== l.words) edits.push({ at: l.at.label, text: k?.raw && out.words === k.link.words ? k.raw.label : labelOf(out.words) });
    }
    const key = l.at ? linkKey(out.href) : keys[i];
    if (file !== undefined && key !== null && !records.some((r) => r.id === key)) records.push({ id: key, file });
  });
  return { text: replaced(sent, edits), records };
}

/* ---------- GET links ---------- */

/** A link of a document, as `links --from` answers it: the document it
 *  opens, as `doklin` names it, or `closed` — which says no more. */
type From = { words: string; path: string } | { words: string; closed: true };

const blobText = async (env: Env, e: Entry): Promise<string | null> => {
  const obj = await env.DATA.get(blobKey(e.fid, e.file.hash));
  return obj ? obj.text() : null;
};

/** Each link of a document's markdown to another document, in order, each
 *  said once. */
async function linksFrom(c: Call, doc: Doc, files: Record<string, ManifestFile>): Promise<From[] | Refusal> {
  if (!doc.md) return [];
  const [text, metaText] = await Promise.all([blobText(c.env, doc.md), doc.meta ? blobText(c.env, doc.meta) : Promise.resolve(null)]);
  if (text === null) return new Refusal(503, "its content has not finished syncing — try again in a moment");
  const filed = new Map(parseEntityMeta(metaText ?? "").links.map((r) => [r.id, r.file]));
  const host = c.url.host.toLowerCase();
  let workspace: Promise<string | null> | undefined;
  // What each link opens: a file by its id ("" for none), else a path.
  const asks: { words: string; key?: string; id?: string; path?: string | null }[] = [];
  for (const link of linksIn(text)) {
    const page = pageLinkOf(link.href);
    if (page) {
      if (page.domain !== host) continue;
      workspace ??= readWorkspace(sharedEnv(c.env)).then((w) => w?.id ?? null);
      asks.push({ words: link.words, id: page.workspace === (await workspace) ? page.file : "" });
      continue;
    }
    const key = linkKey(link.href);
    if (key === null) continue;
    const file = filed.get(key);
    asks.push(file !== undefined ? { words: link.words, key, id: file } : { words: link.words, key, path: keyTarget(key, doc.md.file.path) });
  }
  const docs = await new PersonDocs(c).own(files).index(
    asks.flatMap((a) => (a.id ? [a.id] : [])),
    asks.flatMap((a) => (a.path ? [a.path] : [])),
  );
  const out: From[] = [];
  const said = new Set<string>();
  for (const a of asks) {
    const found = a.id !== undefined ? docs.byId.get(a.id) : a.path ? docs.byPath.get(a.path.toLowerCase()) : undefined;
    // The words a read shows: a named link's are its document's name now.
    const words = found && a.key !== undefined && isNamedLink(a.words, a.key) ? documentName(found.path) : a.words;
    const entry: From = found ? { words, path: nameOf(found.path).stem } : { words, closed: true };
    const once = JSON.stringify(entry);
    if (said.has(once)) continue;
    said.add(once);
    out.push(entry);
  }
  return out;
}

/**
 * What a document links to (`from`) and the documents that link to it
 * (`to`); with neither flag, both. `from` lists each link of its markdown to
 * another document, with its words: a deleted file, one in a section the
 * agent's person is not in and one that never was are each `closed`, alike.
 * `to` lists the documents its person can open that link to it, from the
 * `links` index (search.ts), caught up first as a search is; one they cannot
 * read is neither listed nor counted. A document they cannot open is one
 * that does not exist: the call is answered in its section (agentApi.ts).
 */
export async function getLinks(c: Call): Promise<Response> {
  const q = c.url.searchParams;
  const path = q.get("path") ?? "";
  const from = q.get("from") === "1";
  const to = q.get("to") === "1";
  const tree = await openTree(c);
  if (!tree) return notBound();
  const at = locate(new Index(tree.manifest.files), path, null);
  if (at instanceof Refusal) return refuse(at);
  if (!docExists(at.doc)) return json({ error: `there is no document at "${path}"` }, 404);
  const doc = at.doc;
  const answer: Record<string, unknown> = { path: doc.stem };

  if (to || !from) {
    const all = await c.places.all();
    if (all === null) return json({ error: "this domain's database is not answering — try again in a moment" }, 503);
    const targets = [doc.md?.fid, doc.html?.fid].filter((f): f is string => f !== undefined);
    const after = cursorOf(c.url);
    const sections = all.slice(after);
    const found = await linkersOf(c.env, sections, targets);
    if (found instanceof Refusal) return refuse(found);
    if ("indexing" in found) return json({ indexing: true, pending: found.indexing }, 202);
    answer.to = found.paths.map((p) => ({ path: nameOf(p).stem }));
    // More sections than one request opens: the rest are the next request's.
    if (found.left.length > 0) answer.next = after + sections.length - found.left.length;
  }
  if (from || !to) {
    const links = await linksFrom(c, doc, tree.manifest.files);
    if (links instanceof Refusal) return refuse(links);
    answer.from = links;
  }
  return json(answer);
}
