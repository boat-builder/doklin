// The document routes of the document API: what a
// folder holds, a document's content and what is known about it, and the
// three ways an agent changes the tree — write, remove, move.
//
//   GET    /api/agent/tree?dir=&deep=1[&where=][&after=]
//   GET    /api/agent/doc?path=&v=md|html[&clean=1][&info=1]
//   GET    /api/agent/search?q=&dir=&limit=[&where=][&after=]
//   PUT    /api/agent/doc?path=&v=[&force=1][&dry=1]      if-rev: <n> | *
//   DELETE /api/agent/doc?path=&v=[&dry=1]
//   POST   /api/agent/move                                 {from, to, dryRun?}
//
// Every path names a document (documents.ts, `locate`) — by its stem or by a
// version's full name — or, for a move, a folder: the CLI sends what was
// typed and is told what it turned out to be. Nothing else syncs, so nothing
// else is here (`syncs`, layout.ts).
//
// Every change goes through `commit` (commit.ts), so a document's files land
// in one manifest write or not at all, and the public map is kept true in
// that same write. What a removal or a move does to the manifest is not this
// file's: a person in a browser makes the same ones (changes.ts).
//
// A call is answered in the section its path is in (agentPlace.ts), with
// every path under the folder that section is at. Three routes look at more
// than one: a listing or a search of a folder that holds something shared —
// the workspace itself and `Shared with me` are two — and a move from one
// section to another. A note's links are read and written as they are now,
// wherever their documents are (agentLinks.ts).
//
// Something shared is its people's, and an agent does not change who can
// open anything. So it renames a shared folder or document, and moves one
// inside the section it sits in; deleting one, moving one anywhere else, and
// moving a folder that holds one to another section are refused with a
// sentence: its person does those in Doklin, which says who gains or loses
// what first.
//
// A listing's notes carry their tags, and `where=name:value` (repeatable, or
// a name alone for any value) narrows a listing or a search to the notes
// that have them, from the index the search catch-up keeps (search.ts). A
// write of a note is held to the tag list where it changes a tag's line
// (tagList.ts).

import { PAGE, change, cursorOf, inSection, notBound, openTree, refuse, type Call } from "./agentCall";
import { itemPath, takenIn, type Section, type Shared } from "./agentPlace";
import { readWorkspace } from "./bucket";
import { keepPublic, moveAcross, moveWithin, removeDocument, removeVersion, repointPages, versionPath } from "./changes";
import { Refusal, newFileId, type Tx } from "./commit";
import {
  Index,
  VERSION_WORD,
  addressesOf,
  basename,
  docExists,
  docRow,
  htmlBehind,
  listTree,
  locate,
  nameOf,
  pathProblem,
  primaryOf,
  versionFlag,
  type Doc,
  type Entry,
  type DocRow,
  type Listing,
  type Named,
  type Version,
} from "./documents";
import type { Env } from "./env";
import { PersonDocs, linksWritten, sectionOfCall, shownNote } from "./agentLinks";
import { placeOf, readPage } from "./htmlText";
import { json, readJsonObject } from "./http";
import {
  ID_RE,
  LIBRARY_FOLDER,
  MAX_FILE_BYTES,
  MY_FILES_FOLDER,
  SHARED_FOLDER,
  SPACE_ID_RE,
  blobKey,
  contentTypeOf,
  validItemName,
} from "./layout";
import type { Manifest } from "./manifest";
import { listDirectory } from "./members";
import { mounted, shownPath, storedPath } from "./mount";
import { askOf, catchUpOpen, mirrorAfter, pairsIn, searchIn, type OpenSection } from "./search";
import { renameSpace, sharedEnv, spaceOf } from "./spaces";
import { filtersOf, listedFilters, readTagList, tagsKept } from "./tagList";
import { isHtmlPath, isMarkdownPath } from "./workspace";
import { CRITIC_BLOCK_RE, parseSpans, stripComments } from "../../src/criticMarkup";
import { META_SUFFIX, emptyMeta, metaFileOf, metaIsEmpty, parseEntityMeta, serializeEntityMeta, type LinkRecord } from "../../src/metaFile";
import { keyedLines, noteTags, type NoteTag, type TagDef, type TagFilter } from "../../src/tags";

/** A header value that survives the wire: paths are not always ASCII. */
const headerText = (s: string): string => encodeURIComponent(s);

/** Text out of bytes, or null when they are not UTF-8. */
function utf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

/* ---------- Reading ---------- */

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const byName = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: "base" });

const under = (path: string, dir: string): boolean => dir === "" || path.toLowerCase().startsWith(`${dir.toLowerCase()}/`);
const noDatabase = (): Response => json({ error: "this domain's database is not answering — try again in a moment" }, 503);

/** The sections whose files are at or under a folder: the one the folder is
 *  in, then whatever is shared beneath it, in the order of their paths. */
function sectionsUnder(all: readonly Section[], at: Section | "workspace" | "shared", dir: string): Section[] {
  if (at === "workspace") return [...all];
  if (at === "shared") return all.filter((s) => s.share && under(itemPath(s.share), SHARED_FOLDER));
  return [at, ...all.filter((s) => s.share && s.space !== at.space && under(itemPath(s.share), dir))];
}

/**
 * What something shared puts in a listing of `dir` without being opened:
 * the folders between `dir` and it, itself when it is a folder, and — when
 * the listing is not deep and it is a document right there — a row that
 * says only that it is there, and shared.
 */
function impliedBy(share: Shared, kind: Section["kind"], dir: string, deep: boolean, listing: Listing & { documents: Row[] }): void {
  const item = itemPath(share);
  if (!under(item, dir)) return;
  const segs = item.slice(dir === "" ? 0 : dir.length + 1).split("/");
  const upTo = (n: number): string => item.slice(0, item.length - segs.slice(n).join("/").length - (n < segs.length ? 1 : 0));
  const last = kind === "folder" ? segs.length : segs.length - 1;
  for (let i = 1; i <= last && (deep || i === 1); i += 1) {
    const folder = upTo(i);
    if (!listing.folders.some((f) => sameName(f, folder))) listing.folders.push(folder);
  }
  if (!deep && kind === "document" && segs.length === 1) listing.documents.push({ path: item, shared: true });
}

/** A listing's row: a document with its versions, or one shared right there
 *  that a listing which is not deep does not open. */
type Row = DocRow & { shared?: true; tags?: NoteTag[] };

export async function getTree(c: Call): Promise<Response> {
  const { url, places } = c;
  const dir = (url.searchParams.get("dir") ?? "").replace(/^\/+|\/+$/g, "");
  const deep = url.searchParams.get("deep") === "1";
  const after = cursorOf(url);
  const asked = filtersOf(url.searchParams, "where");
  if (asked instanceof Refusal) return refuse(asked);
  const at = await places.at(dir, true);
  if (at instanceof Refusal) return refuse(at);
  if (at === "workspace" && !(await readWorkspace(c.env))) return notBound();

  const listing: Listing & { documents: Row[] } = { dir, folders: [], documents: [] };
  // What is shared changes a listing only where there is some: a section
  // nothing is shared from is read alone, as it always was.
  const all = await places.all();
  if (all === null) return noDatabase();
  const within = sectionsUnder(all, at, dir);
  if (at === "workspace") {
    listing.folders.push(LIBRARY_FOLDER, MY_FILES_FOLDER);
    if (all.some((s) => s.share && under(itemPath(s.share), SHARED_FOLDER))) listing.folders.push(SHARED_FOLDER);
  }
  if (after === 0) {
    for (const s of within) if (s.share && (at === "workspace" ? deep : true)) impliedBy(s.share, s.kind, dir, deep, listing);
  }

  // The folder's own section, and with `deep` everything shared beneath it —
  // as many as a request opens, the rest on the next.
  const reading = typeof at === "string" ? (deep ? within : []) : deep ? within : [at];
  const page = reading.slice(after, after + PAGE);
  const opened: OpenSection[] = [];
  for (const s of page) {
    const ws = await places.open(s);
    if (!ws) {
      if (s.kind === "shared") return notBound();
      continue;
    }
    opened.push({ section: s, ws });
    const own = typeof at !== "string" && s.space === at.space;
    const inside = listTree(mounted(ws.manifest, s), own ? dir : s.mount, own ? deep : s.kind !== "document");
    for (const folder of inside.folders) if (!listing.folders.some((f) => sameName(f, folder))) listing.folders.push(folder);
    listing.documents.push(...inside.documents);
  }
  // A section is there with nothing in it; any other folder is what is in it.
  const nothing = listing.folders.length + listing.documents.length === 0;
  if (nothing && after === 0 && typeof at !== "string" && !sameName(dir, at.mount)) {
    return json({ error: `there is no folder "${dir}"` }, 404);
  }
  listing.folders.sort(byName);
  listing.documents.sort((a, b) => byName(a.path, b.path));
  const next = after + page.length < reading.length ? { next: after + page.length } : {};
  return withTags(c, listing, opened, asked, next);
}

/** A note's tags from what the index holds for it, as `noteTags` reads them
 *  from its text: in the list's order, spelled as the list spells them. */
function tagsHeld(pairs: Map<string, string>, list: readonly TagDef[]): NoteTag[] {
  const out: NoteTag[] = [];
  for (const def of list) {
    const value = pairs.get(def.name.toLowerCase());
    if (value === undefined) continue;
    const known = def.values.find((v) => sameName(v, value));
    out.push({ name: def.name, value: known ?? value, known: known !== undefined });
  }
  return out;
}

/** Whether a note's tags hold every filter. */
const holds = (tags: readonly NoteTag[], where: readonly TagFilter[]): boolean =>
  where.every((f) => tags.some((t) => sameName(t.name, f.name) && (f.value === null || sameName(t.value, f.value))));

/**
 * A listing with each note's tags, as the index holds them — and with
 * `where`, only the notes that have them, once the index has caught up (a
 * `202` while it reads, as a search's). Without `where` the index is not
 * waited for: `tagsBehind` says it has not read the latest changes yet.
 */
async function withTags(
  c: Call,
  listing: Listing & { documents: Row[] },
  opened: readonly OpenSection[],
  asked: readonly TagFilter[],
  extra: Record<string, unknown>,
): Promise<Response> {
  if (listing.documents.length === 0 && asked.length === 0) return json({ ...listing, ...extra });
  const list = await readTagList(c.env);
  const where = listedFilters(asked, list);
  if (where instanceof Refusal) return refuse(where);
  if (list.length === 0) return json({ ...listing, ...extra });
  if (where.length > 0) {
    const up = await catchUpOpen(c.env, opened);
    if (up instanceof Refusal) return refuse(up);
    if ("indexing" in up) return json({ indexing: true, pending: up.indexing }, 202);
  }
  const held = await pairsIn(c.env, opened, list.map((d) => d.name.toLowerCase()));
  if (held === null) {
    if (where.length > 0) return json({ error: "this needs the domain's database, which isn't answering — try again in a moment" }, 503);
    return json({ ...listing, ...extra, tagsBehind: true });
  }
  // Each note's file, by the path a listing row names it by.
  const keys = new Map<string, string>();
  for (const { section, ws } of opened) {
    for (const [fid, f] of Object.entries(ws.manifest.files)) {
      if (!isMarkdownPath(f.path)) continue;
      const path = shownPath(section, f.path);
      const key = `${section.space}/${fid}`;
      keys.set(path.toLowerCase(), key);
      if (!keys.has(nameOf(path).stem.toLowerCase())) keys.set(nameOf(path).stem.toLowerCase(), key);
    }
  }
  const documents: Row[] = [];
  for (const row of listing.documents) {
    const key = row.md ? keys.get(row.path.toLowerCase()) : undefined;
    const pairs = key === undefined ? undefined : held.pairs.get(key);
    const tags = pairs ? tagsHeld(pairs, list) : [];
    if (!holds(tags, where)) continue;
    documents.push(tags.length > 0 ? { ...row, tags } : row);
  }
  return json({
    ...listing,
    // Narrowed to notes, the folders they are in say nothing.
    ...(where.length > 0 ? { folders: [], where } : {}),
    documents,
    ...extra,
    ...(held.behind && where.length === 0 ? { tagsBehind: true } : {}),
  });
}

/**
 * Where a link to a page leads, as this agent's person names the path. A
 * link (engine/src/cloud/link.rs) names its workspace, the space its file is
 * in ("" the shared workspace) and the file's id — never a path, so that a
 * rename or a move keeps it and no folder's name is in it. Only documents sync, so a
 * file found is one: it comes back as the tree names it, by its stem.
 *
 * A space this person is not in, a file deleted, one that never was and a
 * link from another workspace on this domain are all one answer, the same
 * a Mac gives: what is not shared with you is never told apart from nothing.
 */
export async function getFind(c: Call): Promise<Response> {
  const q = c.url.searchParams;
  const fid = q.get("file") ?? "";
  const space = q.get("space") ?? "";
  const workspace = q.get("workspace") ?? "";
  if (!ID_RE.test(fid) || !ID_RE.test(workspace) || (space !== "" && !SPACE_ID_RE.test(space))) {
    return json({ error: "a link names its workspace, its section and its file by their ids — pass them as the link has them" }, 400);
  }
  const nothing = json(
    { error: "there is no page at that link this agent can open — it was deleted, or it is somewhere its person is not" },
    404,
  );
  const bound = await readWorkspace(c.env);
  if (!bound) return notBound();
  if (bound.id !== workspace) return nothing;
  const all = await c.places.all();
  if (all === null) return noDatabase();
  // A file keeps its id when it moves to another section — and something
  // shared is a section of its own — so the id is looked for where the link
  // names, then wherever that section says it went (`Tombstone.to`), then in
  // the rest, as many as a request opens. While a move is half done one id
  // is in two sections: then the named one wins, else the lowest section
  // id, which is the shared workspace's — as on a Mac (`follow`,
  // engine/src/cloud/engine.rs). Change both.
  const order = [...all].sort((a, b) => (a.space === space ? -1 : b.space === space ? 1 : a.space < b.space ? -1 : 1));
  const seen = new Set<string>();
  let opened = 0;
  for (let i = 0; i < order.length && opened < PAGE; i += 1) {
    const section = order[i];
    if (seen.has(section.space)) continue;
    seen.add(section.space);
    opened += 1;
    const ws = await c.places.open(section);
    if (!ws) {
      if (section.kind === "shared") return notBound();
      continue;
    }
    const file = ws.manifest.files[fid];
    if (!file) {
      // Where it went from here is looked at next.
      const went = ws.manifest.tombstones?.[fid]?.to;
      const there = went === undefined ? -1 : order.findIndex((s) => s.space === went);
      if (there > i) order.splice(i + 1, 0, ...order.splice(there, 1));
      continue;
    }
    if (file.path.toLowerCase().endsWith(META_SUFFIX)) continue;
    const files = mounted(ws.manifest, section).files;
    const { stem } = nameOf(files[fid].path);
    const alone = new Index(files).doc(stem).mds.length <= 1;
    return json({ path: alone ? stem : files[fid].path });
  }
  return nothing;
}

/** Which documents are called this or contain this text (search.ts): in a
 *  folder's own section and whatever is shared beneath it; the workspace
 *  itself is every section, and `Shared with me` everything shared with the
 *  person. */
export async function getSearch(c: Call): Promise<Response> {
  const { env, url, places } = c;
  const dir = (url.searchParams.get("dir") ?? "").replace(/^\/+|\/+$/g, "");
  const asked = filtersOf(url.searchParams, "where");
  if (asked instanceof Refusal) return refuse(asked);
  let where: TagFilter[] = [];
  if (asked.length > 0) {
    const listed = listedFilters(asked, await readTagList(env));
    if (listed instanceof Refusal) return refuse(listed);
    where = listed;
  }
  const ask = askOf(url.searchParams, dir, where);
  if (ask instanceof Refusal) return refuse(ask);
  const at = await places.at(dir, true);
  if (at instanceof Refusal) return refuse(at);
  const all = await places.all();
  if (all === null) {
    return json({ error: "search needs this domain's database, which isn't answering — try again in a moment" }, 503);
  }
  const after = cursorOf(url);
  const sections = sectionsUnder(all, at, dir).slice(after);

  const found = await searchIn(env, sections, ask);
  if (found instanceof Refusal) return refuse(found);
  if ("indexing" in found) return json({ indexing: true, pending: found.indexing }, 202);
  const results = found.hits.map((hit) => ({
    path: nameOf(hit.path).stem,
    version: isHtmlPath(hit.path) ? "html" : "md",
    matches: hit.matches,
    ...(hit.moreLines > 0 ? { moreLines: hit.moreLines } : {}),
    ...(hit.inName ? { inName: true } : {}),
    ...(hit.inComments ? { inComments: true } : {}),
  }));
  return json({
    query: ask.query,
    dir,
    ...(where.length > 0 ? { where } : {}),
    results,
    total: found.total,
    ...(found.total > results.length ? { truncated: true } : {}),
    // Too large to mirror — said, rather than silently never found.
    ...(found.notSearched.length > 0 ? { notSearched: found.notSearched.map(({ path }) => nameOf(path).stem) } : {}),
    // More sections than one request opens: the rest are the next request's.
    ...(found.left.length > 0 ? { next: after + sections.length - found.left.length } : {}),
  });
}

/** Which version a read means: the one asked for, else the markdown, else the html. */
function versionToRead(at: Named, typed: string): { version: Version; entry: Entry } | Refusal {
  const { doc } = at;
  if (!docExists(doc)) return new Refusal(404, `there is no document at "${typed}"`);
  const version: Version = at.asked ?? (doc.md ? "md" : "html");
  const entry = version === "md" ? doc.md : doc.html;
  if (entry) return { version, entry };
  return version === "html"
    ? new Refusal(404, `${doc.stem} has no html version — writing one with --html creates it`, { code: "no_html" })
    : new Refusal(404, `${doc.stem} has only an html version — writing one with --md adds a markdown version`, { code: "no_md" });
}

export async function getDoc(c: Call): Promise<Response> {
  const { env, url } = c;
  const path = url.searchParams.get("path") ?? "";
  const flag = versionFlag(url.searchParams.get("v"));
  if (flag instanceof Refusal) return refuse(flag);
  const ws = await openTree(c);
  if (!ws) return notBound();
  const index = new Index(ws.manifest.files);
  const at = locate(index, path, flag);
  if (at instanceof Refusal) return refuse(at);

  if (url.searchParams.get("info") === "1") {
    if (!docExists(at.doc)) return json({ error: `there is no document at "${path}"` }, 404);
    return json(await docInfo(env, ws.manifest, url.origin, at.doc));
  }
  const picked = versionToRead(at, path);
  if (picked instanceof Refusal) return refuse(picked);
  // A note whose links have records reads as they are now.
  let show: ((text: string) => Promise<string>) | null = null;
  if (picked.version === "md" && at.doc.meta) {
    const records = parseEntityMeta((await blobText(env, at.doc.meta)) ?? "").links;
    const note = picked.entry.file.path;
    if (records.length > 0) {
      const person = new PersonDocs(c).own(ws.manifest.files);
      show = (text) => shownNote(person, note, text, records);
    }
  }
  return content(
    env,
    picked.entry,
    { path: at.doc.stem, version: picked.version, htmlBehind: htmlBehind(at.doc) },
    picked.version === "md" && url.searchParams.get("clean") === "1",
    show,
  );
}

const blobText = async (env: Env, e: Entry): Promise<string | null> => {
  const obj = await env.DATA.get(blobKey(e.fid, e.file.hash));
  return obj ? obj.text() : null;
};

/** A version's bytes, with what the caller needs to know about them in
 *  headers — or its text, shown as `show` says. */
async function content(
  env: Env,
  entry: Entry,
  what: { path: string; version: Version; htmlBehind: boolean },
  clean: boolean,
  show: ((text: string) => Promise<string>) | null,
): Promise<Response> {
  const obj = await env.DATA.get(blobKey(entry.fid, entry.file.hash));
  if (!obj) return json({ error: "its content has not finished syncing — try again in a moment" }, 503);
  const headers: Record<string, string> = {
    "content-type": contentTypeOf(entry.file.path),
    "cache-control": "no-store",
    "x-doklin-kind": "document",
    "x-doklin-path": headerText(what.path),
    "x-doklin-file": headerText(entry.file.path),
    "x-doklin-rev": String(entry.file.rev),
    "x-doklin-version": what.version,
  };
  if (what.htmlBehind) headers["x-doklin-html-behind"] = "1";
  if (!clean && !show) return new Response(obj.body, { headers: { ...headers, "content-length": String(obj.size) } });
  const text = show ? await show(await obj.text()) : await obj.text();
  return new Response(clean ? stripComments(text) : text, { headers });
}

/** Display names for the ids a manifest signs with — empty when the database cannot say. */
export async function namesOf(env: Env): Promise<Map<string, string>> {
  return new Map(((await listDirectory(env)) ?? []).map((p) => [p.id, p.name]));
}

/**
 * Everything known about a document without reading its text — and what a
 * link to it names (engine/src/cloud/link.rs): its workspace, its section
 * ("" the shared workspace) and the file people open, the markdown when it
 * has one. The ids, never the link: its form is the CLI's to write.
 */
async function docInfo(env: Env, m: Manifest, origin: string, doc: Doc): Promise<Record<string, unknown>> {
  const [names, metaText, workspace, tags] = await Promise.all([
    namesOf(env),
    doc.meta
      ? env.DATA.get(blobKey(doc.meta.fid, doc.meta.file.hash)).then((o) => (o ? o.text() : ""))
      : Promise.resolve(""),
    readWorkspace(sharedEnv(env)),
    tagsOfNote(env, doc),
  ]);
  const meta = parseEntityMeta(metaText);
  const row = docRow(doc);
  const addresses = addressesOf(m, origin, doc);
  const opened = primaryOf(doc);
  const named = <T extends { by: string | null }>(v: T | undefined) =>
    v ? { ...v, ...(v.by && names.has(v.by) ? { byName: names.get(v.by) } : {}) } : undefined;
  return {
    kind: "document",
    ...row,
    ...(row.md ? { md: named(row.md) } : {}),
    ...(row.html ? { html: named(row.html) } : {}),
    comments: meta.mthreads.length + meta.hthreads.length,
    ...(tags.length > 0 ? { tags } : {}),
    ...(addresses.length > 0 ? { public: addresses } : {}),
    ...(workspace && opened ? { linkTo: { workspace: workspace.id, space: spaceOf(env), file: opened.fid } } : {}),
  };
}

/** A note's tags, read from its text as it is now — none for a document
 *  with no markdown, or when the list or the text can't be read yet. */
async function tagsOfNote(env: Env, doc: Doc): Promise<NoteTag[]> {
  if (!doc.md) return [];
  const list = await readTagList(env);
  if (list.length === 0) return [];
  const text = await blobText(env, doc.md);
  return text === null ? [] : noteTags(text, list);
}

/* ---------- Writing ---------- */

type Precondition = number | "new" | null;

function precondition(request: Request, force: boolean): Precondition | Refusal {
  const raw = request.headers.get("if-rev")?.trim() ?? "";
  if (raw === "") return null;
  if (force) return new Refusal(400, "say which revision you read, or force — not both");
  if (raw === "*") return "new";
  if (/^\d{1,15}$/.test(raw)) return Number(raw);
  return new Refusal(400, "if-rev is a revision number, or * for something that must not exist yet");
}

/** Rule 4: no silent overwrite. Creating needs nothing; replacing needs the
 *  revision that was read, or an explicit force. */
function checkRevision(pre: Precondition, force: boolean, current: Entry | null, label: string): Refusal | null {
  if (pre === "new") {
    return current ? new Refusal(409, `${label} already exists, at revision ${current.file.rev}`, { rev: current.file.rev }) : null;
  }
  if (typeof pre === "number") {
    if (!current) return new Refusal(409, `${label} is gone — it was removed after you read it`, { rev: null });
    return current.file.rev === pre
      ? null
      : new Refusal(409, `${label} is at revision ${current.file.rev}, not ${pre} — it changed after you read it. Read it again, then write.`, {
          rev: current.file.rev,
        });
  }
  if (current && !force) {
    return new Refusal(
      409,
      `${label} already exists, at revision ${current.file.rev} — pass the revision you read (--if-rev ${current.file.rev}) to replace it, or --force`,
      { rev: current.file.rev, code: "needs_rev" },
    );
  }
  return null;
}

export async function putDoc(c: Call): Promise<Response> {
  const { request, url } = c;
  const path = url.searchParams.get("path") ?? "";
  const flag = versionFlag(url.searchParams.get("v"));
  if (flag instanceof Refusal) return refuse(flag);
  const force = url.searchParams.get("force") === "1";
  const pre = precondition(request, force);
  if (pre instanceof Refusal) return refuse(pre);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_FILE_BYTES) return json({ error: "that is too large — a file may be 25 MB" }, 413);

  // Read once for every attempt; the section written to is the change's own.
  const person = new PersonDocs(c);
  let listed: Promise<TagDef[]> | undefined;
  const tagList = (): Promise<TagDef[]> => (listed ??= readTagList(c.env));
  const done = await change(
    c,
    async (tx) => {
      const index = new Index(tx.files);
      const at = locate(index, path, flag);
      if (at instanceof Refusal) return at;
      const value = await writeVersion(tx, index, at, bytes, pre, force, person.own(tx.files), sectionOfCall(c), tagList);
      if (!(value instanceof Refusal)) keepPublic(tx);
      return value;
    },
    url.searchParams.get("dry") === "1",
  );
  if (done instanceof Refusal) return refuse(done);
  await mirrorAfter(c, done);
  const { created, ...answer } = done.value;
  return json({ ...answer, created, ...(done.wrote ? {} : { written: false }) }, created && done.wrote ? 201 : 200);
}

type Written = Record<string, unknown> & { created: boolean };

async function writeVersion(
  tx: Tx,
  index: Index,
  at: Named,
  bytes: Uint8Array,
  pre: Precondition,
  force: boolean,
  person: PersonDocs,
  section: string | null,
  tagList: () => Promise<TagDef[]>,
): Promise<Written | Refusal> {
  const { doc } = at;
  let version: Version;
  if (at.asked) version = at.asked;
  else if (doc.md || !doc.html) version = "md";
  else {
    // The one place a default would do harm: markdown text replacing an html page.
    return new Refusal(
      400,
      `${doc.stem} has only an html version — say --html to replace it, or --md to add a markdown version beside it`,
      { code: "html_only" },
    );
  }
  const current = version === "md" ? doc.md : doc.html;
  const label = `the ${VERSION_WORD[version]} version of ${doc.stem}`;
  const refusal = checkRevision(pre, force, current, label);
  if (refusal) return refusal;

  const text = utf8(bytes);
  if (text === null) return new Refusal(400, `a ${VERSION_WORD[version]} version is text — that is not UTF-8`);
  const target = versionPath(index, at, version);
  if (target instanceof Refusal) return target;

  // The version as it is now, when the write could take a comment's place from it.
  let now: string | null = "";
  if (current && (version === "md" || doc.meta)) now = await tx.readText(current.fid);
  if (now === null) return new Refusal(503, "its content has not finished syncing — try again in a moment");
  if (version === "html") {
    const lost = await anchorsKept(tx, doc, now, text);
    if (lost) return lost;
    return finish(tx, doc, version, current, target, bytes);
  }

  // A note's links as a read showed them, which is what an agent sends back.
  const meta = doc.meta ? parseEntityMeta((await tx.readText(doc.meta.fid)) ?? "") : emptyMeta();
  const shown = await shownNote(person, target, now, meta.links);
  // Compared with what the agent read; the text as stored passes too.
  const lost = markersKept(shown, text, doc.stem);
  if (lost && (shown === now || markersKept(now, text, doc.stem))) return lost;
  const untagged = await tagsChecked(tagList, now, text);
  if (untagged) return untagged;
  const written = await linksWritten(person, { path: target, section }, text, { text: now, records: meta.links });
  const value = await finish(tx, doc, version, current, target, written.text === text ? bytes : new TextEncoder().encode(written.text));
  // The sidecar in the same write: what a note is linked by never lands apart from its text.
  if (!sameRecords(meta.links, written.records)) {
    const next = { ...meta, links: written.records };
    if (metaIsEmpty(next)) {
      if (doc.meta) tx.remove(doc.meta.fid);
    } else {
      const metaPath = doc.meta?.file.path ?? metaFileOf(target);
      await tx.write(doc.meta?.fid ?? newFileId(), metaPath, new TextEncoder().encode(serializeEntityMeta(next)), contentTypeOf(metaPath));
    }
  }
  return value;
}

/**
 * What the tag list says of a note's new text (tagList.ts): it keeps to the
 * list where the write changes a tag's line. The list is read only for a
 * write that changes a keyed line.
 */
async function tagsChecked(tagList: () => Promise<TagDef[]>, now: string, text: string): Promise<Refusal | null> {
  const before = keyedLines(now);
  const after = keyedLines(text);
  if (after.every((l, i) => before[i] && before[i].key === l.key && before[i].value === l.value)) return null;
  return tagsKept(now, text, await tagList());
}

/** Whether two sets of link records say the same. */
const sameRecords = (a: readonly LinkRecord[], b: readonly LinkRecord[]): boolean =>
  a.length === b.length && a.every((r) => b.some((o) => o.id === r.id && o.file === r.file));

/** Store a version's new bytes, and answer what the write did. */
export async function finish(
  tx: Tx,
  doc: Doc,
  version: Version,
  current: Entry | null,
  target: string,
  bytes: Uint8Array,
): Promise<Written> {
  const before = current?.file.hash;
  const fid = current?.fid ?? newFileId();
  const file = await tx.write(fid, target, bytes, contentTypeOf(target));
  // An html-only document that gains its markdown: its page becomes the
  // markdown's, which is what gives it the MD/HTML switch.
  if (version === "md" && !current && doc.html) repointPages(tx, doc.html.fid, { fid, file });

  const after: Doc = { ...doc, [version]: { fid, file } };
  return {
    kind: "document",
    // From the file, not the request: a new document's name is spelled as it landed.
    path: nameOf(file.path).stem,
    version,
    file: basename(file.path),
    rev: file.rev,
    size: file.size,
    created: !current,
    ...(before === file.hash ? { unchanged: true } : {}),
    ...(htmlBehind(after) ? { htmlBehind: true } : {}),
  };
}

/* ---------- What a write may not do to comments ---------- */
//
// Nothing. Threads are started, answered and removed by the comments routes,
// which change the text and the sidecar together; a write of content leaves
// every thread where it was, or is refused. No flag gets past this — not
// --force, which is about revisions.

type Marker = { whole: string; id: string | null; words: string };

const markersOf = (md: string): Marker[] =>
  [...md.matchAll(CRITIC_BLOCK_RE)].map((m) => ({ whole: m[0], id: parseSpans(m[2]).id, words: m[1] }));

/** What of `of` is not in `from`, counting repeats. */
function missing(of: readonly Marker[], from: readonly Marker[]): Marker[] {
  const left = new Map<string, number>();
  for (const m of from) left.set(m.whole, (left.get(m.whole) ?? 0) + 1);
  return of.filter((m) => {
    const n = left.get(m.whole) ?? 0;
    if (n > 0) left.set(m.whole, n - 1);
    return n === 0;
  });
}

const quoted = (words: string): string => {
  const flat = words.replace(/\s+/g, " ").trim();
  return `"${flat.length > 40 ? `${flat.slice(0, 40)}…` : flat}"`;
};

const commentRm = (stem: string, thread: string): string =>
  `\`doklin comment rm ${/\s/.test(stem) ? `"${stem}"` : stem} ${thread}\``;

const andList = (items: readonly string[]): string =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/**
 * A markdown thread's place is a marker in the text, `{==words==}{>>#id<<}`.
 * The new text must carry exactly the markers the old one did, each as it
 * was, words and all; it may move one with its words. Compared as written,
 * so a marker of any shape — a stray, a hand-written one — is kept like
 * the rest.
 */
function markersKept(before: string, after: string, stem: string): Refusal | null {
  const was = markersOf(before);
  const now = markersOf(after);
  const gone = missing(was, now);
  const added = missing(now, was);
  if (gone.length === 0 && added.length === 0) return null;
  // A marker that is gone while one with its id is new was changed, not removed.
  const twin = (m: Marker, among: readonly Marker[]): Marker | undefined => (m.id === null ? undefined : among.find((o) => o.id === m.id));
  const name = (m: Marker): string => (m.id === null ? `the comment on ${quoted(m.words)}` : `comment #${m.id} (on ${quoted(m.words)})`);
  const ids = (ms: readonly Marker[]): string[] => [...new Set(ms.map((m) => m.id).filter((id): id is string => id !== null))];
  const removed = gone.filter((m) => !twin(m, added));
  const changed = gone.filter((m) => twin(m, added));
  const invented = added.filter((m) => !twin(m, gone));
  const parts = [
    ...(removed.length > 0 ? [`remove the marker${removed.length > 1 ? "s" : ""} of ${andList(removed.map(name))}`] : []),
    ...changed.map((m) => `change ${twin(m, added)?.words === m.words ? "the marker" : "the words"} of ${name(m)}`),
    ...(invented.length > 0
      ? [`add ${invented.length > 1 ? "comment markers" : "a comment marker"}${ids(invented).length > 0 ? ` (${ids(invented).map((id) => `#${id}`).join(", ")})` : ""}`]
      : []),
  ];
  const fix =
    gone.length > 0
      ? `keep every marker exactly as \`doklin read\` shows it (it may move with its words), or remove the thread first with ${commentRm(stem, gone.length === 1 && gone[0].id ? gone[0].id : "<thread>")}`
      : "start a thread with `doklin comment` instead of writing a marker";
  return new Refusal(400, `this write would ${andList(parts)} — ${fix}`, {
    code: "comments",
    ...(gone.length > 0 ? { threads: ids(gone) } : {}),
    ...(added.length > 0 ? { added: ids(added) } : {}),
  });
}

/**
 * An html thread's place is words of the page, or a part of it found again by
 * its tag and opening words (`placeOf`, htmlText.ts). A write may not leave a
 * thread with less of its place than the file had: its words gone, or its
 * part. Words reworded a little are still its words, as a marker in markdown
 * may move with its words. A thread the file had no place for already is not
 * this write's doing.
 */
async function anchorsKept(tx: Tx, doc: Doc, before: string, after: string): Promise<Refusal | null> {
  if (!doc.meta) return null;
  const threads = parseEntityMeta((await tx.readText(doc.meta.fid)) ?? "").hthreads;
  if (threads.length === 0) return null;
  const was = readPage(before);
  const now = readPage(after);
  const gone = threads.flatMap((t) => {
    const had = placeOf(was, t.anchor).level;
    return placeOf(now, t.anchor).level < had ? [{ thread: t, words: had === 2 }] : [];
  });
  if (gone.length === 0) return null;
  const names = gone.map(({ thread: t, words }) => {
    if (words) return `the words comment #${t.id} is on (${quoted(t.anchor.quote ?? "")})`;
    const id = t.anchor.ids?.[0] && t.anchor.text === "" ? ` id="${t.anchor.ids[0]}"` : "";
    return `the <${t.anchor.tag}${id}> comment #${t.id} is on${t.anchor.text === "" ? "" : ` (${quoted(t.anchor.text)})`}`;
  });
  const keep =
    gone.length > 1
      ? "keep them"
      : gone[0].words
        ? "keep those words"
        : gone[0].thread.anchor.text === ""
          ? "keep that element and its id"
          : "keep that element and its opening words";
  return new Refusal(
    400,
    `this write would take away ${andList(names)} — ${keep}, or remove the thread first with ${commentRm(doc.stem, gone.length === 1 ? gone[0].thread.id : "<thread>")}`,
    { code: "comments", threads: gone.map((g) => g.thread.id) },
  );
}

/* ---------- Removing ---------- */

export async function deleteDoc(c: Call): Promise<Response> {
  const { url } = c;
  const path = url.searchParams.get("path") ?? "";
  const flag = versionFlag(url.searchParams.get("v"));
  if (flag instanceof Refusal) return refuse(flag);
  if (!flag && c.section?.kind === "document") return refuse(sharedStays(itemPath(c.section.share!), "delete"));

  const done = await change(
    c,
    async (tx) => {
      const index = new Index(tx.files);
      const at = locate(index, path, flag);
      if (at instanceof Refusal) return at;
      const { doc } = at;
      if (!docExists(doc)) return new Refusal(404, `there is no document at "${path}"`);
      // A version is removed only when the flag says so: `rm plan.md` means
      // the document, exactly as `mv plan.md` does.
      return flag ? removeVersion(tx, doc, flag) : removeDocument(tx, doc, url.origin);
    },
    url.searchParams.get("dry") === "1",
  );
  if (done instanceof Refusal) return refuse(done);
  await mirrorAfter(c, done);
  return json({ ...done.value, ...(done.wrote ? {} : { removed: false }) });
}

/* ---------- Moving ---------- */

/** What an agent is told when it would change who can open something shared. */
function sharedStays(item: string, verb: "delete" | "move"): Refusal {
  return new Refusal(
    409,
    verb === "delete"
      ? `"${item}" is shared with people — an agent does not delete something shared. Its person deletes it, or leaves it, in Doklin.`
      : `"${item}" is shared with people — an agent renames it, or moves it inside the folder it sits in. Moving it anywhere else changes who can open it: its person does that in Doklin.`,
    { code: "shared" },
  );
}

export async function postMove(c: Call): Promise<Response> {
  const body = await readJsonObject(c.request);
  if (!body) return json({ error: "invalid json body" }, 400);
  const rawFrom = typeof body.from === "string" ? body.from : "";
  const rawTo = typeof body.to === "string" ? body.to : "";
  const dryRun = body.dryRun === true;
  const from = trimSlashes(rawFrom);
  const to = trimSlashes(rawTo);
  const problem = pathProblem(from) ?? pathProblem(to);
  if (problem) return json({ error: problem }, 400);
  // What was typed says what is meant, as `mv` reads it: a trailing slash
  // names a folder, and a destination that is a folder means "into it".
  const what = rawFrom.endsWith("/") ? "folder" : "either";
  const source = await c.places.of(rawFrom, what === "folder");
  if (source instanceof Refusal) return refuse(source);
  // Something shared, named itself: a document's section is the document.
  if (source.share && (source.kind === "document" || sameName(from, source.mount))) {
    return moveShared(c, source, source.share, rawTo, dryRun);
  }
  const dest = await c.places.of(rawTo, true);
  if (dest instanceof Refusal) return refuse(dest);
  if (sameName(from, source.mount)) {
    return json({ error: `${source.mount} is a section of this workspace, not a folder to move — move what is in it` }, 400);
  }
  const intoSection = sameName(to, dest.mount);

  if (source.space !== dest.space) {
    // What is shared beneath a folder would go with it, to people who could
    // then open it — or away from people who can.
    const tree = await openTree(inSection(c, source));
    const held = Object.entries(tree?.manifest.mounts ?? {}).find(([, m]) => sameName(m.dir, from) || under(m.dir, from));
    if (held) {
      return json(
        {
          error: `"${from}" holds something shared — moving it to another section changes who can open that. Its person moves it in Doklin.`,
          code: "shared",
        },
        409,
      );
    }
    const into = (there: Index): boolean => rawTo.endsWith("/") || there.isFolder(to) || intoSection;
    const moved = await moveAcross({ by: c.who.id, ctx: c.ctx, origin: c.url.origin }, source, dest, { from, to, what, into }, dryRun);
    return moved instanceof Refusal ? refuse(moved) : json(moved);
  }
  // "Into it" — unless the destination is the very thing being moved, typed
  // in another case: that is a rename of its name, not a move inside itself.
  const into = (there: Index): boolean => rawTo.endsWith("/") || (!sameName(to, from) && (there.isFolder(to) || intoSection));
  const here = inSection(c, source);
  const done = await change(here, async (tx) => moveWithin(tx, { from, to, what, into }), dryRun);
  if (done instanceof Refusal) return refuse(done);
  // A move changes no text, but it moves the etag the mirror is whole at.
  await mirrorAfter(here, done);
  return json({ ...done.value, ...(done.wrote ? {} : { moved: false }) });
}

/**
 * Rename something shared, or move it to another folder of the section it
 * sits in. Its name is its own: a folder's in the database, a document's its
 * file's. Where it sits is the section it sits in's to say (`mounts`), so
 * only somebody who can open that section moves it.
 */
async function moveShared(c: Call, section: Section, share: Shared, rawTo: string, dryRun: boolean): Promise<Response> {
  const item = itemPath(share);
  const to = trimSlashes(rawTo);
  if (sameName(to, item) && to === item) return json({ kind: section.kind, from: item, to: item, files: 0, moved: false });
  const parent = share.parent;
  const container = parent ? await c.places.open(parent) : null;
  // "Into it": a trailing slash, or a folder that is there.
  const all = (await c.places.all()) ?? [];
  const folderThere =
    !sameName(to, item) &&
    (all.some((s) => s.kind !== "document" && sameName(s.mount, to)) ||
      (parent !== null &&
        container !== null &&
        (new Index(mounted(container.manifest, parent).files).isFolder(to) ||
          all.some((s) => s.share && s.space !== section.space && under(itemPath(s.share), to)))));
  const into = rawTo.endsWith("/") || folderThere;
  const dir = into ? to : to.includes("/") ? to.slice(0, to.lastIndexOf("/")) : "";
  const typed = into ? share.shown : to.slice(to.lastIndexOf("/") + 1);
  const name = validItemName(section.kind === "document" ? nameOf(typed).stem : typed);
  if (!name) return json({ error: "that is not a name a shared folder or document can carry" }, 400);

  const moving = !sameName(dir, share.dir);
  if (moving) {
    // The folder it goes to has to be one of the section it sits in.
    const there = dir === "" ? null : await c.places.at(dir, true);
    const sameSection = parent !== null && there !== null && typeof there !== "string" && !(there instanceof Refusal) && there.space === parent.space;
    if (!sameSection) return refuse(sharedStays(item, "move"));
  }
  const renaming = name !== share.shown;
  if (!moving && !renaming) return json({ kind: section.kind, from: item, to: item, files: 0, moved: false });

  // Nothing there may have its name already.
  if (parent && container) {
    const stored = storedPath(parent, dir, true);
    const taken = stored === null ? null : takenIn(container.manifest, stored);
    const among = section.kind === "document" ? taken?.documents : taken?.folders;
    const other = all.some(
      (s) => s.share && s.space !== section.space && s.kind === section.kind && sameName(s.share.dir, dir) && sameName(s.share.shown, name),
    );
    if (other || among?.has(name.toLowerCase())) {
      return json({ error: `"${dir}/${name}" is already there` }, 409);
    }
  } else if (all.some((s) => s.share && s.space !== section.space && s.kind === section.kind && sameName(s.share.dir, dir) && sameName(s.share.shown, name))) {
    return json({ error: `"${dir}/${name}" is already there` }, 409);
  }
  const answer = { kind: section.kind, from: item, to: `${dir}/${name}`, shared: true };
  if (dryRun) return json({ ...answer, moved: false });

  if (moving && parent) {
    const placed = await change(inSection(c, parent), async (tx) => {
      const mounts = (tx.m.mounts ??= {});
      const now = mounts[share.space.id];
      mounts[share.space.id] = { ...now, dir, rev: (now?.rev ?? 0) + 1, by: tx.by };
      tx.touch();
      return true;
    });
    if (placed instanceof Refusal) return refuse(placed);
  }
  if (renaming && section.kind === "folder") {
    const renamed = await renameSpace(c.env, c.places.auth, share.space, name);
    if (renamed === null) return noDatabase();
  }
  if (renaming && section.kind === "document") {
    // Its files are in its own section, at the folder it sat in when this began.
    const here = inSection(c, section);
    const done = await change(here, async (tx) =>
      moveWithin(tx, { from: item, to: `${share.dir}/${name}`, what: "document", into: () => false }),
    );
    if (done instanceof Refusal) return refuse(done);
    await mirrorAfter(here, done);
  }
  return json(answer);
}

const trimSlashes = (p: string): string => p.replace(/^\/+|\/+$/g, "");

/** The document a whole-document route means — comments, publishing — or why
 *  there is none. Shared so each says "no such document" the same way. */
export function documentAt(index: Index, path: string): Doc | Refusal {
  const at = locate(index, path, null);
  if (at instanceof Refusal) return at;
  if (!docExists(at.doc)) return new Refusal(404, `there is no document at "${path}"`);
  return at.doc;
}
