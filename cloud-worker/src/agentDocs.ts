// The document routes of the document API: what a
// folder holds, a document's content and what is known about it, and the
// three ways an agent changes the tree — write, remove, move.
//
//   GET    /api/agent/tree?dir=&deep=1
//   GET    /api/agent/doc?path=&v=md|html[&clean=1][&info=1]
//   GET    /api/agent/search?q=&dir=&limit=
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
// than one: a listing or a search of the workspace itself, or of
// `Restricted`, and a move from one section to another. A note's links are
// read and written as they are now, wherever their documents are
// (agentLinks.ts).

import { change, inSection, notBound, openTree, refuse, type Call } from "./agentCall";
import type { Section } from "./agentPlace";
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
  type Listing,
  type Named,
  type Version,
} from "./documents";
import type { Env } from "./env";
import { PersonDocs, linksWritten, sectionOfCall, shownNote } from "./agentLinks";
import { anchorResolves, elementsOf } from "./htmlText";
import { json, readJsonObject } from "./http";
import { ID_RE, MAX_FILE_BYTES, SPACE_ID_RE, blobKey, contentTypeOf } from "./layout";
import type { Manifest } from "./manifest";
import { listDirectory } from "./members";
import { askOf, mirrorAfter, searchIn } from "./search";
import { MAX_SECTIONS_READ, sharedEnv, spaceOf } from "./spaces";
import { isHtmlPath } from "./workspace";
import { CRITIC_BLOCK_RE, parseSpans, stripComments } from "../../src/criticMarkup";
import { META_SUFFIX, emptyMeta, metaFileOf, metaIsEmpty, parseEntityMeta, serializeEntityMeta, type LinkRecord } from "../../src/metaFile";

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

export async function getTree(c: Call): Promise<Response> {
  const { url, places } = c;
  const dir = (url.searchParams.get("dir") ?? "").replace(/^\/+|\/+$/g, "");
  const deep = url.searchParams.get("deep") === "1";
  const at = await places.at(dir);
  if (at instanceof Refusal) return refuse(at);

  // A folder of one section, the section's own included.
  if (at !== "workspace" && at !== "restricted") {
    const tree = await openTree(inSection(c, at));
    if (!tree) return notBound();
    const listing = listTree(tree.manifest, dir, deep);
    const nothing = listing.folders.length + listing.documents.length === 0;
    // A section is there with nothing in it; any other folder is its files.
    if (nothing && !sameName(dir, at.mount)) return json({ error: `there is no folder "${dir}"` }, 404);
    return json(listing);
  }

  // The workspace itself, or `Restricted`: what is in more than one section.
  // At the top that is the sections this person has, and nothing else.
  if (at === "workspace" && !(await readWorkspace(c.env))) return notBound();
  const all = await places.all();
  if (all === null) return json({ error: "this domain's database is not answering — try again in a moment" }, 503);
  const sections = all.filter((s) => at === "workspace" || s.kind === "restricted");
  const listing: Listing = { dir, folders: [], documents: [] };
  const notListed: string[] = [];
  let opened = 0;
  for (const s of sections) {
    const top = s.mount.split("/")[0];
    if (at === "workspace" && !listing.folders.includes(top)) listing.folders.push(top);
    if ((at === "restricted" || deep) && !listing.folders.includes(s.mount)) listing.folders.push(s.mount);
    if (!deep) continue;
    // Library is one read like the others; the rest are what a request opens.
    if (s.kind !== "shared" && (opened += 1) > MAX_SECTIONS_READ) {
      notListed.push(s.mount);
      continue;
    }
    const tree = await openTree(inSection(c, s));
    if (!tree) {
      if (s.kind === "shared") return notBound();
      continue;
    }
    const inside = listTree(tree.manifest, s.mount, true);
    listing.folders.push(...inside.folders);
    listing.documents.push(...inside.documents);
  }
  listing.folders.sort(byName);
  listing.documents.sort((a, b) => byName(a.path, b.path));
  // Said, never left out silently: list one of these on its own.
  return json({ ...listing, ...(notListed.length > 0 ? { notListed } : {}) });
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
 * a Mac gives: a restricted folder is never told apart from nothing.
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
  if (all === null) return json({ error: "this domain's database is not answering — try again in a moment" }, 503);
  // A file keeps its id when it moves to another section, so the id is
  // looked for in every section, the one the link names first. While a move
  // is half done one id is in two sections: then the named one wins, else
  // the lowest section id, which is the shared workspace's — as on a Mac
  // (`follow`, engine/src/cloud/engine.rs). Change both.
  const order = [...all].sort((a, b) => (a.space === space ? -1 : b.space === space ? 1 : a.space < b.space ? -1 : 1));
  for (const section of order) {
    const tree = await openTree(inSection(c, section));
    if (!tree) return notBound();
    const file = tree.manifest.files[fid];
    if (!file || file.path.toLowerCase().endsWith(META_SUFFIX)) continue;
    const { stem } = nameOf(file.path);
    const alone = new Index(tree.manifest.files).doc(stem).mds.length <= 1;
    return json({ path: alone ? stem : file.path });
  }
  return nothing;
}

/** Which documents are called this or contain this text (search.ts). A
 *  folder is in one section; the workspace itself is all of them, and
 *  `Restricted` every restricted folder. */
export async function getSearch(c: Call): Promise<Response> {
  const { env, url, places } = c;
  const dir = (url.searchParams.get("dir") ?? "").replace(/^\/+|\/+$/g, "");
  const ask = askOf(url.searchParams, dir);
  if (ask instanceof Refusal) return refuse(ask);
  const at = await places.at(dir);
  if (at instanceof Refusal) return refuse(at);
  let sections: Section[];
  if (at !== "workspace" && at !== "restricted") {
    sections = [at];
  } else {
    const all = await places.all();
    if (all === null) {
      return json({ error: "search needs this domain's database, which isn't answering — try again in a moment" }, 503);
    }
    sections = at === "restricted" ? all.filter((s) => s.kind === "restricted") : all;
  }

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
    results,
    total: found.total,
    ...(found.total > results.length ? { truncated: true } : {}),
    // Too large to mirror — said, rather than silently never found.
    ...(found.notSearched.length > 0 ? { notSearched: found.notSearched.map(({ path }) => nameOf(path).stem) } : {}),
    // More sections than one request opens: search inside one of these.
    ...(found.left.length > 0 ? { sectionsNotSearched: found.left.map((s) => s.mount) } : {}),
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
  const [names, metaText, workspace] = await Promise.all([
    namesOf(env),
    doc.meta
      ? env.DATA.get(blobKey(doc.meta.fid, doc.meta.file.hash)).then((o) => (o ? o.text() : ""))
      : Promise.resolve(""),
    readWorkspace(sharedEnv(env)),
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
    ...(addresses.length > 0 ? { public: addresses } : {}),
    ...(workspace && opened ? { linkTo: { workspace: workspace.id, space: spaceOf(env), file: opened.fid } } : {}),
  };
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
  const done = await change(
    c,
    async (tx) => {
      const index = new Index(tx.files);
      const at = locate(index, path, flag);
      if (at instanceof Refusal) return at;
      const value = await writeVersion(tx, index, at, bytes, pre, force, person.own(tx.files), sectionOfCall(c));
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

/** Whether two sets of link records say the same. */
const sameRecords = (a: readonly LinkRecord[], b: readonly LinkRecord[]): boolean =>
  a.length === b.length && a.every((r) => b.some((o) => o.id === r.id && o.file === r.file));

/** Store a version's new bytes, and answer what the write did. */
async function finish(
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
 * An html thread's place is an element of the page, found again by its tag
 * and opening words. Every thread that has a place now must have one after.
 * One that has none already is not this write's doing.
 */
async function anchorsKept(tx: Tx, doc: Doc, before: string, after: string): Promise<Refusal | null> {
  if (!doc.meta) return null;
  const threads = parseEntityMeta((await tx.readText(doc.meta.fid)) ?? "").hthreads;
  if (threads.length === 0) return null;
  const was = elementsOf(before);
  const now = elementsOf(after);
  const gone = threads.filter((t) => anchorResolves(was, t.anchor) && !anchorResolves(now, t.anchor));
  if (gone.length === 0) return null;
  const names = gone.map((t) => `the <${t.anchor.tag}> comment #${t.id} is on (${quoted(t.anchor.text)})`);
  return new Refusal(
    400,
    `this write would take away ${andList(names)} — keep ${gone.length === 1 ? "that element and its opening words" : "those elements and their opening words"}, or remove the thread first with ${commentRm(doc.stem, gone.length === 1 ? gone[0].id : "<thread>")}`,
    { code: "comments", threads: gone.map((t) => t.id) },
  );
}

/* ---------- Removing ---------- */

export async function deleteDoc(c: Call): Promise<Response> {
  const { url } = c;
  const path = url.searchParams.get("path") ?? "";
  const flag = versionFlag(url.searchParams.get("v"));
  if (flag instanceof Refusal) return refuse(flag);

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
  const [source, dest] = [await c.places.of(rawFrom), await c.places.of(rawTo)];
  if (source instanceof Refusal) return refuse(source);
  if (dest instanceof Refusal) return refuse(dest);
  if (sameName(from, source.mount)) {
    return json({ error: `${source.mount} is a section of this workspace, not a folder to move — move what is in it` }, 400);
  }
  // What was typed says what is meant, as `mv` reads it: a trailing slash
  // names a folder, and a destination that is a folder means "into it".
  const what = rawFrom.endsWith("/") ? "folder" : "either";
  const intoSection = sameName(to, dest.mount);

  if (source.space !== dest.space) {
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

const trimSlashes = (p: string): string => p.replace(/^\/+|\/+$/g, "");

/** The document a whole-document route means — comments, publishing — or why
 *  there is none. Shared so each says "no such document" the same way. */
export function documentAt(index: Index, path: string): Doc | Refusal {
  const at = locate(index, path, null);
  if (at instanceof Refusal) return at;
  if (!docExists(at.doc)) return new Refusal(404, `there is no document at "${path}"`);
  return at.doc;
}
