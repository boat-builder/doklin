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

import { notBound, refuse, type Call } from "./agentCall";
import { Refusal, commit, newFileId, type Tx } from "./commit";
import {
  Index,
  VERSION_WORD,
  basename,
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
  type Named,
  type Version,
} from "./documents";
import type { Env } from "./env";
import { json, readJsonObject } from "./http";
import { MAX_FILE_BYTES, blobKey } from "./layout";
import type { Manifest } from "./manifest";
import { listDirectory } from "./members";
import { mirrorAfter } from "./search";
import { openWorkspace } from "./workspace";
import { stripComments } from "../../src/criticMarkup";
import { META_SUFFIX, emptyMeta, markerIds, metaIsEmpty, parseEntityMeta, serializeEntityMeta } from "../../src/metaFile";

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
const ownPages = (m: Manifest, origin: string, fids: readonly string[]): string[] =>
  Object.entries(m.public ?? {})
    .filter(([, e]) => e.kind === "file" && fids.includes(e.file))
    .map(([slug]) => `${origin}/${slug}`)
    .sort();

/* ---------- Reading ---------- */

export async function getTree({ env, url }: Call): Promise<Response> {
  const dir = (url.searchParams.get("dir") ?? "").replace(/^\/+|\/+$/g, "");
  if (dir) {
    const problem = pathProblem(dir);
    if (problem) return json({ error: problem }, 400);
  }
  const ws = await openWorkspace(env);
  if (!ws) return notBound();
  const listing = listTree(ws.manifest, url.origin, dir, url.searchParams.get("deep") === "1");
  if (dir && listing.folders.length + listing.documents.length + listing.files.length === 0) {
    return json({ error: `there is no folder "${dir}"` }, 404);
  }
  return json(listing);
}

/** Which version a read means: the one asked for, else the markdown, else the html. */
function versionToRead(at: Extract<Named, { kind: "document" }>, typed: string): { version: Version; entry: Entry } | Refusal {
  const { doc } = at;
  if (!docExists(doc)) return new Refusal(404, `there is no document or file at "${typed}"`);
  const version: Version = at.asked ?? (doc.md ? "md" : "html");
  const entry = version === "md" ? doc.md : doc.html;
  if (entry) return { version, entry };
  return version === "html"
    ? new Refusal(404, `${doc.stem} has no html version — writing one with --html creates it`, { code: "no_html" })
    : new Refusal(404, `${doc.stem} has only an html version — writing one with --md adds a markdown version`, { code: "no_md" });
}

export async function getDoc({ env, url }: Call): Promise<Response> {
  const path = url.searchParams.get("path") ?? "";
  const flag = versionFlag(url.searchParams.get("v"));
  if (flag instanceof Refusal) return refuse(flag);
  const ws = await openWorkspace(env);
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
    if (!docExists(at.doc)) return json({ error: `there is no document or file at "${path}"` }, 404);
    return json(await docInfo(env, ws.manifest, url.origin, at.doc));
  }
  const picked = versionToRead(at, path);
  if (picked instanceof Refusal) return refuse(picked);
  return content(
    env,
    picked.entry,
    { kind: "document", path: at.doc.stem, version: picked.version, htmlBehind: htmlBehind(at.doc) },
    picked.version === "md" && url.searchParams.get("clean") === "1",
  );
}

/** A file's bytes, with what the caller needs to know about them in headers. */
async function content(
  env: Env,
  entry: Entry,
  what: { kind: "document" | "file"; path: string; version?: Version; htmlBehind?: boolean },
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
  if (clean) return new Response(stripComments(await obj.text()), { headers });
  return new Response(obj.body, { headers: { ...headers, "content-length": String(obj.size) } });
}

/** Display names for the ids a manifest signs with — empty when the database cannot say. */
async function namesOf(env: Env): Promise<Map<string, string>> {
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
    ...(row.md ? { md: named(row.md) } : {}),
    ...(row.html ? { html: named(row.html) } : {}),
    comments: meta.mthreads.length + meta.hthreads.length,
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
  const { request, env, url, who } = c;
  const path = url.searchParams.get("path") ?? "";
  const flag = versionFlag(url.searchParams.get("v"));
  if (flag instanceof Refusal) return refuse(flag);
  const force = url.searchParams.get("force") === "1";
  const pre = precondition(request, force);
  if (pre instanceof Refusal) return refuse(pre);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_FILE_BYTES) return json({ error: "that is too large — a file may be 25 MB" }, 413);

  const done = await commit(
    env,
    who.id,
    async (tx) => {
      const index = new Index(tx.files);
      const at = locate(index, path, flag);
      if (at instanceof Refusal) return at;
      const value = at.kind === "file" ? await writeFile(tx, index, at, bytes, pre, force) : await writeVersion(tx, index, at, bytes, pre, force);
      if (!(value instanceof Refusal)) keepPublic(tx);
      return value;
    },
    { dryRun: url.searchParams.get("dry") === "1" },
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
  const label = `the ${VERSION_WORD[version]} version of ${doc.stem}`;
  const refusal = checkRevision(pre, force, current, label);
  if (refusal) return refusal;

  const text = utf8(bytes);
  if (text === null) return new Refusal(400, `a ${VERSION_WORD[version]} version is text — that is not UTF-8`);
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
  const { env, url, who } = c;
  const path = url.searchParams.get("path") ?? "";
  const flag = versionFlag(url.searchParams.get("v"));
  if (flag instanceof Refusal) return refuse(flag);

  const done = await commit(
    env,
    who.id,
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
      if (!docExists(doc)) return new Refusal(404, `there is no document or file at "${path}"`);
      // A version is removed only when the flag says so: `rm plan.md` means
      // the document, exactly as `mv plan.md` does.
      return flag ? removeVersion(tx, doc, flag) : removeDocument(tx, doc, url.origin);
    },
    { dryRun: url.searchParams.get("dry") === "1" },
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

export async function postMove(c: Call): Promise<Response> {
  const body = await readJsonObject(c.request);
  if (!body) return json({ error: "invalid json body" }, 400);
  const from = typeof body.from === "string" ? body.from : "";
  const to = typeof body.to === "string" ? body.to : "";
  const done = await commit(c.env, c.who.id, async (tx) => move(tx, from, to), { dryRun: body.dryRun === true });
  if (done instanceof Refusal) return refuse(done);
  // A move changes no text, but it moves the etag the mirror is whole at.
  await mirrorAfter(c, done);
  return json({ ...done.value, ...(done.wrote ? {} : { moved: false }) });
}

const trimSlashes = (p: string): string => p.replace(/^\/+|\/+$/g, "");

/**
 * Move or rename a document, a plain file or a folder. A document moves
 * whole — both versions and its comments — whatever extension was typed, and
 * a destination that is an existing folder means "into it", as `mv` does.
 */
function move(tx: Tx, rawFrom: string, rawTo: string): Record<string, unknown> | Refusal {
  const index = new Index(tx.files);
  const fromFolder = rawFrom.endsWith("/");
  const from = trimSlashes(rawFrom);
  const to = trimSlashes(rawTo);
  for (const p of [from, to]) {
    const problem = pathProblem(p);
    if (problem) return new Refusal(400, problem);
  }
  // "Into it" — unless the destination is the very thing being moved, typed
  // in another case: that is a rename of its name, not a move inside itself.
  const into = rawTo.endsWith("/") || (index.isFolder(to) && to.toLowerCase() !== from.toLowerCase());

  // What is being moved.
  let kind: "document" | "file" | "folder";
  let moving: Entry[];
  let doc: Doc | null = null;
  const at = fromFolder ? null : locate(index, from, null);
  if (at instanceof Refusal) return at;
  if (at && at.kind === "file" && at.entry) {
    kind = "file";
    moving = [at.entry];
  } else if (at && at.kind === "document" && docExists(at.doc)) {
    kind = "document";
    doc = at.doc;
    moving = [doc.md, doc.html, doc.meta].filter((e): e is Entry => e !== null);
  } else if (index.isFolder(from)) {
    kind = "folder";
    moving = index.under(from);
  } else {
    return new Refusal(404, `there is nothing at "${from}"`);
  }

  // Where it lands has to be free — of anything but the files being moved,
  // which is what lets a rename change only the case of a name — and its
  // folders are spelled the way the workspace already spells them.
  const gone = new Set(moving.map((e) => e.fid));
  const without = new Index(Object.fromEntries(Object.entries(tx.files).filter(([fid]) => !gone.has(fid))));
  const plan: { fid: string; to: string }[] = [];
  let label: { from: string; to: string };
  if (kind === "file") {
    const entry = moving[0];
    const dest = without.spelled(into ? `${to}/${basename(entry.file.path)}` : to);
    plan.push({ fid: entry.fid, to: dest });
    label = { from: entry.file.path, to: dest };
  } else if (doc) {
    const stem = without.spelled(into ? `${to}/${basename(doc.stem)}` : nameOf(to).stem);
    if (doc.md) plan.push({ fid: doc.md.fid, to: `${stem}${doc.md.file.path.slice(doc.stem.length)}` });
    if (doc.html) plan.push({ fid: doc.html.fid, to: `${stem}.html` });
    if (doc.meta) plan.push({ fid: doc.meta.fid, to: `${stem}${META_SUFFIX}` });
    label = { from: doc.stem, to: stem };
  } else {
    // The folder as it is spelled, which is not always how it was typed.
    const folder = moving[0].file.path.slice(0, from.length);
    const dest = without.spelled(into ? `${to}/${basename(folder)}` : to);
    if (`${dest.toLowerCase()}/`.startsWith(`${from.toLowerCase()}/`) && dest.toLowerCase() !== from.toLowerCase()) {
      return new Refusal(400, "a folder cannot be moved inside itself");
    }
    for (const e of moving) plan.push({ fid: e.fid, to: `${dest}${e.file.path.slice(from.length)}` });
    label = { from: folder, to: dest };
  }

  for (const step of plan) {
    // A sidecar travels with its document; it is checked as the stem it belongs to.
    const sidecar = step.to.toLowerCase().endsWith(META_SUFFIX);
    const problem = pathProblem(sidecar ? step.to.slice(0, -META_SUFFIX.length) : step.to);
    if (problem) return new Refusal(400, problem);
    const taken = without.at(step.to);
    if (taken) return new Refusal(409, `"${taken.file.path}" is already there`);
    const place = without.placeProblem(step.to);
    if (place) return new Refusal(409, place);
  }
  if (kind === "document") {
    const there = without.doc(label.to);
    if (docExists(there)) return new Refusal(409, `there is already a document at "${there.stem}"`);
  }

  for (const step of plan) tx.move(step.fid, step.to);
  if (kind === "folder") {
    // A published folder follows its folder; so does one published beneath it.
    for (const entry of Object.values(tx.m.public ?? {})) {
      if (entry.kind !== "dir") continue;
      const lower = entry.path.toLowerCase();
      if (lower !== label.from.toLowerCase() && !lower.startsWith(`${label.from.toLowerCase()}/`)) continue;
      entry.path = `${label.to}${entry.path.slice(label.from.length)}`;
      tx.touch();
    }
  }
  keepPublic(tx);
  return { kind, ...label, files: plan.length };
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
  if (!docExists(at.doc)) return new Refusal(404, `there is no document at "${path}"`);
  return at.doc;
}
