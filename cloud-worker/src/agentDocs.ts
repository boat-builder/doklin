// The document routes of the document API: what a
// folder holds, a document's content and what is known about it, and the
// three ways an agent changes the tree — write, remove, move.
//
//   GET    /api/agent/tree?dir=&deep=1
//   GET    /api/agent/doc?path=&v=md|html[&clean=1][&info=1]
//   PUT    /api/agent/doc?path=&v=[&force=1][&dry=1]      if-rev: <n> | *
//   DELETE /api/agent/doc?path=&v=[&dry=1]
//   POST   /api/agent/move                                 {from, to, dryRun?}
//
// One route serves documents and plain files alike, because only the worker
// can tell which a path names (documents.ts, `locate`): the CLI sends what
// was typed and is told what it turned out to be.
//
// Every change goes through `commit` (commit.ts), so a document's files land
// in one manifest write or not at all, and the public map is kept true in
// that same write (`keepPublic`).
//
// A call is answered in the section its path is in (agentPlace.ts), with
// every path under the folder that section is at. Two routes look at more
// than one: a listing of the workspace itself, or of `Restricted`, and a move
// from one section to another — which is the one change here that is two
// manifest writes, the place it goes to first.
//
// A card's page is a document here like any other, with one difference: its
// file begins with the card's properties, and those are the board's business
// (agentBoards.ts). A read leaves them out and a write puts them back as they
// are on disk at that moment — the split the app makes (`splice_body`,
// src-tauri/src/store.rs).

import { change, inSection, notBound, openTree, refuse, type Call } from "./agentCall";
import { MAX_SECTIONS_READ, type Section } from "./agentPlace";
import { splitCard } from "./boardCards";
import { Refusal, newFileId, type Tx } from "./commit";
import {
  Index,
  VERSION_WORD,
  absent,
  basename,
  boardHint,
  docExists,
  docRow,
  fileRow,
  htmlBehind,
  listTree,
  locate,
  nameOf,
  pathProblem,
  type Doc,
  type Entry,
  type Listing,
  type Named,
  type Version,
} from "./documents";
import type { Env } from "./env";
import { json, readJsonObject } from "./http";
import { MAX_FILE_BYTES, blobKey } from "./layout";
import type { Manifest, PublicEntry } from "./manifest";
import { listDirectory } from "./members";
import { mirrorAfter } from "./search";
import { stripComments } from "../../src/criticMarkup";
import { META_SUFFIX, emptyMeta, markerIds, metaIsEmpty, parseEntityMeta, serializeEntityMeta } from "../../src/metaFile";
import { parseFrontmatter } from "../../src/store/frontmatter";
import { STORE_FILE, parseStoreDef, serializeStoreDef } from "../../src/store/storeFile";

const CONTENT_TYPES: Record<string, string> = {
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  mdown: "text/markdown; charset=utf-8",
  mkd: "text/markdown; charset=utf-8",
  html: "text/html; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  json: "application/json",
  jsonl: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
};

/** What a blob is stored as — the engine's own table (`content_type_for`, scan.rs). */
export const contentTypeOf = (path: string): string =>
  CONTENT_TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";

/** A header value that survives the wire: paths are not always ASCII. */
const headerText = (s: string): string => encodeURIComponent(s);

/** A version as a request names one — `md`, `html`, or nothing — or a refusal
 *  when it is anything else. */
export function versionFlag(raw: unknown): Version | null | Refusal {
  if (raw === null || raw === undefined || raw === "") return null;
  if (raw === "md" || raw === "html") return raw;
  return new Refusal(400, 'a version is "md" or "html"');
}

/** Text out of bytes, or null when they are not UTF-8. */
function utf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

/* ---------- The public map follows the files ---------- */

/**
 * Keep the public map true after a change, the way the engine does on every
 * manifest it writes (`fold_public`, src-tauri/src/cloud/engine.rs):
 *
 *   · a page's path snapshot follows its file when the file moved;
 *   · a page whose file is gone adopts a file that now sits at its path —
 *     which is what brings a page back when its document is recreated.
 */
export function keepPublic(tx: Tx): void {
  const map = tx.m.public;
  if (!map) return;
  const referenced = new Set<string>();
  for (const entry of Object.values(map)) {
    if (entry.kind !== "file") continue;
    referenced.add(entry.file);
    const live = tx.files[entry.file];
    if (live && live.path !== entry.path) {
      entry.path = live.path;
      tx.touch();
    }
  }
  for (const entry of Object.values(map)) {
    if (entry.kind !== "file" || tx.files[entry.file]) continue;
    const adopt = Object.entries(tx.files).find(([fid, f]) => f.path === entry.path && !referenced.has(fid));
    if (!adopt) continue;
    referenced.add(adopt[0]);
    entry.file = adopt[0];
    tx.touch();
  }
}

/** Point every page that shows `from` at `to` instead — a document's page
 *  belongs to its markdown when it has one, and to its html when it has not. */
function repointPages(tx: Tx, from: string, to: Entry): void {
  for (const entry of Object.values(tx.m.public ?? {})) {
    if (entry.kind !== "file" || entry.file !== from) continue;
    entry.file = to.fid;
    entry.path = to.file.path;
    tx.touch();
  }
}

/** The addresses that point at `fids` by a page of their own. */
export const ownPages = (m: Manifest, origin: string, fids: readonly string[]): string[] =>
  Object.entries(m.public ?? {})
    .filter(([, e]) => e.kind === "file" && fids.includes(e.file))
    .map(([slug]) => `${origin}/${slug}`)
    .sort();

/* ---------- Reading ---------- */

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const byName = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: "base" });

export async function getTree(c: Call): Promise<Response> {
  const { url, places } = c;
  const dir = (url.searchParams.get("dir") ?? "").replace(/^\/+|\/+$/g, "");
  const deep = url.searchParams.get("deep") === "1";
  if (dir) {
    const problem = pathProblem(dir);
    if (problem) return json({ error: problem }, 400);
  }
  const at = dir === "" ? null : await places.at(dir);
  if (at instanceof Refusal) return refuse(at);

  // A folder of one section — which the shared workspace's own are.
  if (at && at !== "restricted") {
    const tree = await openTree(inSection(c, at));
    if (!tree) return notBound();
    const index = new Index(tree.manifest.files);
    const board = index.board(dir) ?? index.boardOf(dir);
    if (board) return json({ error: `${board} is a board, not a folder — ${boardHint(board)}`, code: "board", board }, 400);
    const listing = listTree(tree.manifest, url.origin, dir, deep);
    const nothing = listing.folders.length + listing.boards.length + listing.documents.length + listing.files.length === 0;
    // A section is there with nothing in it; any other folder is its files.
    if (nothing && !sameName(dir, at.mount)) return json({ error: `there is no folder "${dir}"` }, 404);
    return json(listing);
  }

  // The workspace itself, or `Restricted`: what is in more than one section.
  const all = await places.all();
  if (all === null) return json({ error: "this domain's database is not answering — try again in a moment" }, 503);
  const sections = all.filter((s) => (at === "restricted" ? s.kind === "restricted" : s.kind !== "shared"));
  let listing: Listing = { dir, folders: [], boards: [], documents: [], files: [] };
  if (at === null) {
    const tree = await openTree(c);
    if (!tree) return notBound();
    listing = listTree(tree.manifest, url.origin, "", deep);
    // The two folders a workspace keeps for itself, when there is something
    // behind them for this person.
    for (const s of sections) {
      const top = s.mount.split("/")[0];
      if (!listing.folders.includes(top)) listing.folders.push(top);
    }
  }
  const notListed: string[] = [];
  for (const [i, s] of sections.entries()) {
    if ((at === "restricted" || deep) && !listing.folders.includes(s.mount)) listing.folders.push(s.mount);
    if (!deep) continue;
    if (i >= MAX_SECTIONS_READ) {
      notListed.push(s.mount);
      continue;
    }
    const tree = await openTree(inSection(c, s));
    if (!tree) continue;
    const inside = listTree(tree.manifest, url.origin, s.mount, true);
    listing.folders.push(...inside.folders);
    listing.boards.push(...inside.boards);
    listing.documents.push(...inside.documents);
    listing.files.push(...inside.files);
  }
  listing.folders.sort(byName);
  listing.boards.sort((a, b) => byName(a.path, b.path));
  listing.documents.sort((a, b) => byName(a.path, b.path));
  listing.files.sort((a, b) => byName(a.path, b.path));
  // Said, never left out silently: list one of these on its own.
  return json({ ...listing, ...(notListed.length > 0 ? { notListed } : {}) });
}

/** Which version a read means: the one asked for, else the markdown, else the html. */
function versionToRead(index: Index, at: Extract<Named, { kind: "document" }>, typed: string): { version: Version; entry: Entry } | Refusal {
  const { doc } = at;
  if (!docExists(doc)) return absent(index, doc, typed, `there is no document or file at "${typed}"`);
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
  const wantInfo = url.searchParams.get("info") === "1";

  if (at.kind === "file") {
    if (!at.entry) return json({ error: `there is no document or file at "${path}"` }, 404);
    if (wantInfo) {
      const names = await namesOf(env);
      const row = fileRow(ws.manifest, url.origin, at.entry);
      return json({ kind: "file", ...row, ...(row.by && names.has(row.by) ? { byName: names.get(row.by) } : {}) });
    }
    return content(env, at.entry, { kind: "file", path: at.entry.file.path }, false);
  }

  if (wantInfo) {
    if (!docExists(at.doc)) return refuse(absent(index, at.doc, path, `there is no document or file at "${path}"`));
    return json(await docInfo(env, ws.manifest, url.origin, at.doc));
  }
  const picked = versionToRead(index, at, path);
  if (picked instanceof Refusal) return refuse(picked);
  return content(
    env,
    picked.entry,
    { kind: "document", path: at.doc.stem, version: picked.version, htmlBehind: htmlBehind(at.doc), board: at.doc.board },
    picked.version === "md" && url.searchParams.get("clean") === "1",
  );
}

/** A file's bytes, with what the caller needs to know about them in headers.
 *  A card's are its page: the properties above it are left out. */
async function content(
  env: Env,
  entry: Entry,
  what: { kind: "document" | "file"; path: string; version?: Version; htmlBehind?: boolean; board?: string | null },
  clean: boolean,
): Promise<Response> {
  const obj = await env.DATA.get(blobKey(entry.fid, entry.file.hash));
  if (!obj) return json({ error: "its content has not finished syncing — try again in a moment" }, 503);
  const headers: Record<string, string> = {
    "content-type": contentTypeOf(entry.file.path),
    "cache-control": "no-store",
    "x-doklin-kind": what.kind,
    "x-doklin-path": headerText(what.path),
    "x-doklin-file": headerText(entry.file.path),
    "x-doklin-rev": String(entry.file.rev),
  };
  if (what.version) headers["x-doklin-version"] = what.version;
  if (what.htmlBehind) headers["x-doklin-html-behind"] = "1";
  if (what.board) {
    headers["x-doklin-board"] = headerText(what.board);
    const { page } = splitCard(await obj.text());
    return new Response(clean ? stripComments(page) : page, { headers });
  }
  if (clean) return new Response(stripComments(await obj.text()), { headers });
  return new Response(obj.body, { headers: { ...headers, "content-length": String(obj.size) } });
}

/** Display names for the ids a manifest signs with — empty when the database cannot say. */
export async function namesOf(env: Env): Promise<Map<string, string>> {
  return new Map(((await listDirectory(env)) ?? []).map((p) => [p.id, p.name]));
}

/** Everything known about a document without reading its text. */
async function docInfo(env: Env, m: Manifest, origin: string, doc: Doc): Promise<Record<string, unknown>> {
  const [names, metaText] = await Promise.all([
    namesOf(env),
    doc.meta
      ? env.DATA.get(blobKey(doc.meta.fid, doc.meta.file.hash)).then((o) => (o ? o.text() : ""))
      : Promise.resolve(""),
  ]);
  const meta = parseEntityMeta(metaText);
  const row = docRow(m, origin, doc);
  const named = <T extends { by: string | null }>(v: T | undefined) =>
    v ? { ...v, ...(v.by && names.has(v.by) ? { byName: names.get(v.by) } : {}) } : undefined;
  return {
    kind: "document",
    ...row,
    ...(doc.board ? { board: doc.board } : {}),
    ...(row.md ? { md: named(row.md) } : {}),
    ...(row.html ? { html: named(row.html) } : {}),
    comments: meta.mthreads.length + (doc.board ? 0 : meta.hthreads.length),
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

  const done = await change(
    c,
    async (tx) => {
      const index = new Index(tx.files);
      const at = locate(index, path, flag);
      if (at instanceof Refusal) return at;
      const value = at.kind === "file" ? await writeFile(tx, index, at, bytes, pre, force) : await writeVersion(tx, index, at, bytes, pre, force);
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

async function writeFile(
  tx: Tx,
  index: Index,
  at: Extract<Named, { kind: "file" }>,
  bytes: Uint8Array,
  pre: Precondition,
  force: boolean,
): Promise<Written | Refusal> {
  const refusal = checkRevision(pre, force, at.entry, at.path);
  if (refusal) return refusal;
  const path = at.entry ? at.entry.file.path : index.spelled(at.path);
  if (!at.entry) {
    const place = index.placeProblem(path);
    if (place) return new Refusal(409, place);
  }
  const before = at.entry?.file.hash;
  const file = await tx.write(at.entry?.fid ?? newFileId(), path, bytes, contentTypeOf(path));
  return {
    kind: "file",
    path: file.path,
    rev: file.rev,
    size: file.size,
    created: !at.entry,
    ...(before === file.hash ? { unchanged: true } : {}),
  };
}

async function writeVersion(
  tx: Tx,
  index: Index,
  at: Extract<Named, { kind: "document" }>,
  bytes: Uint8Array,
  pre: Precondition,
  force: boolean,
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
  // What exists on a board, and what a card says about itself, are the
  // board's: a card is made with `board add`, and its properties set with
  // `board set`. Its page is written here.
  const title = basename(doc.stem);
  if (doc.board && !current) {
    return new Refusal(400, `${doc.board} is a board — add a card to it with \`doklin board add ${doc.board} "${title}"\``, {
      code: "board",
      board: doc.board,
    });
  }
  const label = doc.board ? `the page of ${doc.stem}` : `the ${VERSION_WORD[version]} version of ${doc.stem}`;
  const refusal = checkRevision(pre, force, current, label);
  if (refusal) return refusal;

  const text = utf8(bytes);
  if (text === null) return new Refusal(400, `a ${VERSION_WORD[version]} version is text — that is not UTF-8`);
  if (doc.board && parseFrontmatter(text).present) {
    return new Refusal(
      400,
      `a card's page cannot begin with a properties block — set its properties with \`doklin board set ${doc.board} "${title}" <field>=<value>\``,
      { code: "board", board: doc.board },
    );
  }
  const target = current?.file.path ?? index.spelled(version === "md" ? at.mdPath : at.htmlPath);
  if (!current) {
    const place = index.placeProblem(target);
    if (place) return new Refusal(409, place);
    const inTheWay = index.at(target);
    if (inTheWay) return new Refusal(409, `"${inTheWay.file.path}" is already there`);
  }

  let orphaned: string[] = [];
  if (version === "md") {
    const checked = await checkMarkers(tx, doc, text);
    if (checked instanceof Refusal) return checked;
    orphaned = checked;
  }

  let stored = bytes;
  if (doc.board && current) {
    // The card's properties as they are now, not as they were when the page
    // was read: a change on the board meanwhile is kept, not undone.
    const now = await tx.readText(current.fid);
    if (now === null) return new Refusal(503, "its content has not finished syncing — try again in a moment");
    stored = new TextEncoder().encode(splitCard(now).head + text);
  }

  const before = current?.file.hash;
  const fid = current?.fid ?? newFileId();
  const file = await tx.write(fid, target, stored, contentTypeOf(target));
  // An html-only document that gains its markdown: its page becomes the
  // markdown's, which is what gives it the MD/HTML switch.
  if (version === "md" && !current && doc.html) repointPages(tx, doc.html.fid, { fid, file });

  const after: Doc = { ...doc, [version]: { fid, file } };
  return {
    kind: "document",
    // From the file, not the request: a new document's name is spelled as it landed.
    path: nameOf(file.path).stem,
    ...(doc.board ? { board: doc.board } : {}),
    version,
    file: basename(file.path),
    rev: file.rev,
    size: file.size,
    created: !current,
    ...(before === file.hash ? { unchanged: true } : {}),
    ...(htmlBehind(after) ? { htmlBehind: true } : {}),
    ...(orphaned.length > 0 ? { orphaned } : {}),
  };
}

/**
 * What a markdown write may do to comment markers. A thread's anchor is a
 * marker in the text — `{==words==}{>>#id<<}`
 * — and its conversation is in the sidecar. So:
 *
 *   · a marker whose id no thread has is refused: a thread is started with
 *     the comments route, which writes both halves together;
 *   · a thread whose marker this write removes is kept, as the app keeps it,
 *     and reported — the answer is the list of ids that just lost theirs.
 */
async function checkMarkers(tx: Tx, doc: Doc, text: string): Promise<string[] | Refusal> {
  const after = markerIds(text);
  const meta = doc.meta ? parseEntityMeta((await tx.readText(doc.meta.fid)) ?? "") : emptyMeta();
  const threads = new Set(meta.mthreads.map((t) => t.id));
  const strangers = [...after].filter((id) => !threads.has(id));
  if (threads.size === 0 && strangers.length === 0) return [];
  // Only now is the old text worth a read: it says which markers were there.
  const before = doc.md ? markerIds((await tx.readText(doc.md.fid)) ?? "") : new Set<string>();
  const invented = strangers.filter((id) => !before.has(id));
  if (invented.length > 0) {
    return new Refusal(
      400,
      `the text carries a comment marker no thread has (${invented.map((id) => `#${id}`).join(", ")}) — start a thread with the comment command instead of writing a marker`,
      { unknownMarkers: invented },
    );
  }
  return [...threads].filter((id) => before.has(id) && !after.has(id));
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
      if (at.kind === "file") {
        if (!at.entry) return new Refusal(404, `there is no document or file at "${path}"`);
        tx.remove(at.entry.fid);
        return { kind: "file", path: at.entry.file.path, stillPublic: ownPages(tx.m, url.origin, [at.entry.fid]) };
      }
      const { doc } = at;
      if (!docExists(doc)) return absent(index, doc, path, `there is no document or file at "${path}"`);
      if (doc.board) {
        return new Refusal(400, `${doc.stem} is a card — remove it with \`doklin board rm ${doc.board} "${basename(doc.stem)}"\``, {
          code: "board",
          board: doc.board,
        });
      }
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

function removeDocument(tx: Tx, doc: Doc, origin: string): Record<string, unknown> {
  const parts = [doc.md, doc.html, doc.meta].filter((e): e is Entry => e !== null);
  const fids = [doc.md?.fid, doc.html?.fid].filter((f): f is string => f !== undefined);
  for (const part of parts) tx.remove(part.fid);
  return {
    kind: "document",
    path: doc.stem,
    versions: [...(doc.md ? ["md"] : []), ...(doc.html ? ["html"] : [])],
    // A page outlives its document on purpose.
    stillPublic: ownPages(tx.m, origin, fids),
  };
}

async function removeVersion(tx: Tx, doc: Doc, version: Version): Promise<Record<string, unknown> | Refusal> {
  const entry = version === "md" ? doc.md : doc.html;
  const other = version === "md" ? doc.html : doc.md;
  if (!entry) return new Refusal(404, `${doc.stem} has no ${VERSION_WORD[version]} version`);
  if (!other) {
    return new Refusal(409, `that is the only version of ${doc.stem} — remove the document itself, without a version flag`, {
      code: "last_version",
    });
  }
  // The threads anchored in the version go with it: a markdown thread's
  // anchor is a marker in the markdown, an html thread's an element of the page.
  let threads = 0;
  if (doc.meta) {
    const meta = parseEntityMeta((await tx.readText(doc.meta.fid)) ?? "");
    if (version === "md") {
      threads = meta.mthreads.length;
      meta.mthreads = [];
      meta.tcols = [];
    } else {
      threads = meta.hthreads.length;
      meta.hthreads = [];
    }
    if (metaIsEmpty(meta)) tx.remove(doc.meta.fid);
    else await tx.write(doc.meta.fid, doc.meta.file.path, new TextEncoder().encode(serializeEntityMeta(meta)), contentTypeOf(doc.meta.file.path));
  }
  tx.remove(entry.fid);
  // A page that showed this file shows the document's other version now —
  // the markdown's page becoming the html's is the usual case, and a page a
  // Mac left on the html while the document had both is the other.
  repointPages(tx, entry.fid, other);
  return { kind: "document", path: doc.stem, versions: [version], ...(threads > 0 ? { threadsRemoved: threads } : {}) };
}

/* ---------- Moving ---------- */

/** Files a move from one section to another carries: each is read from one
 *  part of the bucket and written to the other, and a request has a budget. */
const MAX_FILES_ACROSS = 16;

export async function postMove(c: Call): Promise<Response> {
  const body = await readJsonObject(c.request);
  if (!body) return json({ error: "invalid json body" }, 400);
  const from = typeof body.from === "string" ? body.from : "";
  const to = typeof body.to === "string" ? body.to : "";
  const dryRun = body.dryRun === true;
  const problem = pathProblem(trimSlashes(from)) ?? pathProblem(trimSlashes(to));
  if (problem) return json({ error: problem }, 400);
  const [source, dest] = [await c.places.of(from), await c.places.of(to)];
  if (source instanceof Refusal) return refuse(source);
  if (dest instanceof Refusal) return refuse(dest);
  if (source.mount !== "" && sameName(trimSlashes(from), source.mount)) {
    return json({ error: `${source.mount} is a section of this workspace, not a folder to move — move what is in it` }, 400);
  }

  if (source.space !== dest.space) return moveAcross(c, source, dest, from, to, dryRun);
  const here = inSection(c, source);
  const done = await change(here, async (tx) => move(tx, from, to, source), dryRun);
  if (done instanceof Refusal) return refuse(done);
  // A move changes no text, but it moves the etag the mirror is whole at.
  await mirrorAfter(here, done);
  return json({ ...done.value, ...(done.wrote ? {} : { moved: false }) });
}

const trimSlashes = (p: string): string => p.replace(/^\/+|\/+$/g, "");

/** What a move takes with it. */
type Picked = {
  kind: "document" | "file" | "folder" | "board";
  /** The path it was named by, without its slashes. */
  from: string;
  moving: Entry[];
  doc: Doc | null;
};

/** What `rawFrom` names, as something that moves: a document whole — both
 *  versions and its comments — whatever extension was typed, a plain file, a
 *  folder, or a board. What is inside a board stays put. */
function pick(index: Index, rawFrom: string): Picked | Refusal {
  const fromFolder = rawFrom.endsWith("/");
  const from = trimSlashes(rawFrom);
  const inside = index.boardOf(from);
  if (inside) {
    const card = fromFolder ? null : locate(index, from, null);
    if (card instanceof Refusal) return card;
    if (card && card.kind === "document" && docExists(card.doc)) {
      const title = basename(card.doc.stem);
      return new Refusal(
        400,
        `${card.doc.stem} is a card on ${inside} — rename it with \`doklin board set ${inside} "${title}" --title "<new title>"\`; a card does not move off its board`,
        { code: "board", board: inside },
      );
    }
    return new Refusal(400, `"${from}" is inside the board ${inside} — ${boardHint(inside)}`, { code: "board", board: inside });
  }
  const at = fromFolder ? null : locate(index, from, null);
  if (at instanceof Refusal) return at;
  if (at && at.kind === "file" && at.entry) return { kind: "file", from, moving: [at.entry], doc: null };
  if (at && at.kind === "document" && docExists(at.doc)) {
    const doc = at.doc;
    return { kind: "document", from, moving: [doc.md, doc.html, doc.meta].filter((e): e is Entry => e !== null), doc };
  }
  if (index.isFolder(from)) return { kind: index.board(from) ? "board" : "folder", from, moving: index.under(from), doc: null };
  return new Refusal(404, `there is nothing at "${from}"`);
}

/** Where each file goes, and what the move is called. */
type Route = { plan: { fid: string; to: string }[]; label: { from: string; to: string } };

/**
 * Where what was picked lands. `there` is everything already at the
 * destination — never the files being moved, which is what lets a rename
 * change only the case of a name — and the place has to be free of it. A
 * destination that is a folder means "into it", as `mv` does; folders are
 * spelled the way the place already spells them; nothing moves into a board.
 */
function route(there: Index, picked: Picked, to: string, into: boolean): Route | Refusal {
  const { kind, from, moving, doc } = picked;
  const plan: Route["plan"] = [];
  let label: Route["label"];
  if (kind === "file") {
    const entry = moving[0];
    const dest = there.spelled(into ? `${to}/${basename(entry.file.path)}` : to);
    plan.push({ fid: entry.fid, to: dest });
    label = { from: entry.file.path, to: dest };
  } else if (doc) {
    const stem = there.spelled(into ? `${to}/${basename(doc.stem)}` : nameOf(to).stem);
    if (doc.md) plan.push({ fid: doc.md.fid, to: `${stem}${doc.md.file.path.slice(doc.stem.length)}` });
    if (doc.html) plan.push({ fid: doc.html.fid, to: `${stem}.html` });
    if (doc.meta) plan.push({ fid: doc.meta.fid, to: `${stem}${META_SUFFIX}` });
    label = { from: doc.stem, to: stem };
  } else {
    // The folder as it is spelled, which is not always how it was typed.
    const folder = moving[0].file.path.slice(0, from.length);
    const dest = there.spelled(into ? `${to}/${basename(folder)}` : to);
    if (`${dest.toLowerCase()}/`.startsWith(`${from.toLowerCase()}/`) && dest.toLowerCase() !== from.toLowerCase()) {
      return new Refusal(400, `a ${kind} cannot be moved inside itself`);
    }
    for (const e of moving) plan.push({ fid: e.fid, to: `${dest}${e.file.path.slice(from.length)}` });
    label = { from: folder, to: dest };
  }

  for (const step of plan) {
    const board = there.boardOf(step.to);
    if (board) {
      return new Refusal(400, `nothing moves into a board — ${board} holds cards, and \`doklin board add\` makes them`, {
        code: "board",
        board,
      });
    }
    // A sidecar travels with its document; it is checked as the stem it belongs to.
    const sidecar = step.to.toLowerCase().endsWith(META_SUFFIX);
    const problem = pathProblem(sidecar ? step.to.slice(0, -META_SUFFIX.length) : step.to);
    if (problem) return new Refusal(400, problem);
    const taken = there.at(step.to);
    if (taken) return new Refusal(409, `"${taken.file.path}" is already there`);
    const place = there.placeProblem(step.to);
    if (place) return new Refusal(409, place);
  }
  if (kind === "document") {
    const already = there.doc(label.to);
    if (docExists(already)) return new Refusal(409, `there is already a document at "${already.stem}"`);
  }
  return { plan, label };
}

/** Whether a published folder's path is the moved folder, or beneath it. */
const within = (path: string, folder: string): boolean =>
  sameName(path, folder) || path.toLowerCase().startsWith(`${folder.toLowerCase()}/`);

/**
 * Move or rename a document, a plain file, a folder or a board inside one
 * section. A board moves whole; what is inside one stays put, and nothing
 * moves into one — its cards are made and renamed on the board.
 */
async function move(tx: Tx, rawFrom: string, rawTo: string, section: Section): Promise<Record<string, unknown> | Refusal> {
  const index = new Index(tx.files);
  const picked = pick(index, rawFrom);
  if (picked instanceof Refusal) return picked;
  const { kind, from, moving } = picked;
  const to = trimSlashes(rawTo);
  // "Into it" — unless the destination is the very thing being moved, typed
  // in another case: that is a rename of its name, not a move inside itself.
  const into =
    rawTo.endsWith("/") || (!sameName(to, from) && (index.isFolder(to) || (section.mount !== "" && sameName(to, section.mount))));

  const gone = new Set(moving.map((e) => e.fid));
  const without = new Index(Object.fromEntries(Object.entries(tx.files).filter(([fid]) => !gone.has(fid))));
  const routed = route(without, picked, to, into);
  if (routed instanceof Refusal) return routed;
  const { plan, label } = routed;

  for (const step of plan) tx.move(step.fid, step.to);
  if (kind === "folder" || kind === "board") {
    // A published folder follows its folder; so does one published beneath it.
    for (const entry of Object.values(tx.m.public ?? {})) {
      if (entry.kind !== "dir" || !within(entry.path, label.from)) continue;
      entry.path = `${label.to}${entry.path.slice(label.from.length)}`;
      tx.touch();
    }
  }
  const def = kind === "board" ? index.at(`${label.from}/${STORE_FILE}`) : null;
  const named = def ? await renameBoard(tx, def.fid, label) : null;
  keepPublic(tx);
  return { kind, ...label, files: plan.length, ...(named ? { name: named } : {}) };
}

/**
 * Move something from one section to another: its files are written where
 * they go, and only then taken out of where they were — with a tombstone
 * that says where (`Tombstone.to`), so a Mac in both sections moves its copy
 * and a Mac that is not in the new one deletes its own outright. A failure
 * in between leaves the thing in both places, never in neither.
 *
 * A page keeps its address: the section it left gives the address up in the
 * write that removes the file, and the one it went to claims it after.
 */
async function moveAcross(c: Call, source: Section, dest: Section, rawFrom: string, rawTo: string, dryRun: boolean): Promise<Response> {
  const [here, there] = [inSection(c, source), inSection(c, dest)];
  const tree = await openTree(here);
  if (!tree) return notBound();
  const picked = pick(new Index(tree.manifest.files), rawFrom);
  if (picked instanceof Refusal) return refuse(picked);
  if (picked.moving.length > MAX_FILES_ACROSS) {
    return json(
      {
        error: `that is ${picked.moving.length} files, and ${MAX_FILES_ACROSS} move between sections at a time — move it in parts, or in Doklin`,
      },
      400,
    );
  }
  const to = trimSlashes(rawTo);
  const contents = new Map<string, Uint8Array>();
  for (const e of picked.moving) {
    const obj = await here.env.DATA.get(blobKey(e.fid, e.file.hash));
    if (!obj) return json({ error: "its content has not finished syncing — try again in a moment" }, 503);
    contents.set(e.fid, new Uint8Array(await obj.arrayBuffer()));
  }

  // Where it goes, first. Each file is a new one there, with an id of its own.
  const arrived = await change(
    there,
    async (tx) => {
      const index = new Index(tx.files);
      const into = rawTo.endsWith("/") || index.isFolder(to) || (dest.mount !== "" && sameName(to, dest.mount));
      const routed = route(index, picked, to, into);
      if (routed instanceof Refusal) return routed;
      const ids = new Map<string, string>();
      for (const step of routed.plan) {
        const fid = newFileId();
        ids.set(step.fid, fid);
        await tx.write(fid, step.to, contents.get(step.fid)!, contentTypeOf(step.to));
      }
      const def = picked.kind === "board" ? new Index(tx.files).at(`${routed.label.to}/${STORE_FILE}`) : null;
      const named = def ? await renameBoard(tx, def.fid, routed.label) : null;
      keepPublic(tx);
      return { label: routed.label, ids: [...ids], named };
    },
    dryRun,
  );
  if (arrived instanceof Refusal) return refuse(arrived);
  const { label, named } = arrived.value;
  const answer = { kind: picked.kind, ...label, files: picked.moving.length, ...(named ? { name: named } : {}) };
  if (dryRun) return json({ ...answer, moved: false });
  await mirrorAfter(there, arrived);

  // Then out of where it was — as it was read: a file that changed meanwhile
  // is not removed, because what arrived is not what it now says.
  const folder = picked.kind === "folder" || picked.kind === "board";
  const left = await change(here, async (tx) => {
    for (const e of picked.moving) {
      const now = tx.files[e.fid];
      if (!now || now.hash !== e.file.hash || now.path !== e.file.path) {
        return new Refusal(
          409,
          `${label.from} changed while it was being moved, so it was left where it is — ${label.to} is a copy of how it was. Remove the copy and move it again.`,
        );
      }
    }
    const gone = new Set(picked.moving.map((e) => e.fid));
    const pages: [string, PublicEntry][] = [];
    const map = tx.m.public ?? {};
    for (const [slug, entry] of Object.entries(map)) {
      if (entry.kind === "file" ? !gone.has(entry.file) : !(folder && within(entry.path, label.from))) continue;
      pages.push([slug, entry]);
      delete map[slug];
    }
    for (const e of picked.moving) tx.remove(e.fid, dest.space);
    return pages;
  });
  if (left instanceof Refusal) {
    if (left.status === 409) return refuse(left);
    return json(
      {
        error: `${label.to} was written, and ${label.from} could not be taken out of where it was (${left.error}) — it is in both places. Remove ${label.from}.`,
      },
      left.status,
    );
  }
  await mirrorAfter(here, left);

  // Its pages, at the addresses they had.
  const ids = new Map(arrived.value.ids);
  const pages = left.value;
  let unpublished: string[] = [];
  if (pages.length > 0) {
    const carried = await change(there, async (tx) => {
      const map = (tx.m.public ??= {});
      for (const [slug, entry] of pages) {
        // The home page is chosen from the shared workspace.
        const { root: _root, ...kept } = entry;
        const common = dest.space === "" ? entry : kept;
        if (entry.kind === "file") {
          const fid = ids.get(entry.file);
          const file = fid ? tx.files[fid] : undefined;
          if (!fid || !file) continue;
          map[slug] = { ...common, kind: "file", file: fid, path: file.path };
        } else {
          map[slug] = { ...common, kind: "dir", path: `${label.to}${entry.path.slice(label.from.length)}` };
        }
      }
      tx.touch();
      return true;
    });
    if (carried instanceof Refusal) unpublished = pages.map(([slug]) => `${c.url.origin}/${slug}`).sort();
  }
  // Said, because nothing else would: an address stopped answering.
  return json({ ...answer, ...(unpublished.length > 0 ? { unpublished } : {}) });
}

/**
 * A board is called what its definition says, and the app writes its folder's
 * name there when it makes one. A board renamed by moving is renamed there
 * too, in the same write — unless it was called something of its own.
 * `def` is its definition file. Answers the new name, or null when it keeps
 * the one it had.
 */
async function renameBoard(tx: Tx, def: string, label: { from: string; to: string }): Promise<string | null> {
  const was = basename(label.from);
  const now = basename(label.to);
  if (was === now) return null;
  const text = await tx.readText(def);
  const parsed = text === null ? null : parseStoreDef(text);
  if (!parsed || parsed.name.trim().toLowerCase() !== was.toLowerCase()) return null;
  const path = tx.files[def].path;
  await tx.write(def, path, new TextEncoder().encode(serializeStoreDef({ ...parsed, name: now })), contentTypeOf(path));
  return now;
}

/** The document a whole-document route means — comments, publishing — or why
 *  there is none. Shared so each says "no such document" the same way. */
export function documentAt(index: Index, path: string): Doc | Refusal {
  const at = locate(index, path, null);
  if (at instanceof Refusal) return at;
  if (at.kind === "file") {
    return at.entry
      ? new Refusal(400, `${at.entry.file.path} is a plain file, not a document`)
      : new Refusal(404, `there is no document at "${path}"`);
  }
  if (!docExists(at.doc)) return absent(index, at.doc, path, `there is no document at "${path}"`);
  return at.doc;
}
