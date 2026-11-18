// A person's changes to documents, from a browser, and their search
// (web.ts lists the routes).
//
// A save is the note and its comments together: the text is one file and
// the comment threads another (src/metaFile.ts), and a browser that saved
// them in two requests could leave a marker in the text with no thread
// behind it. So both go in one manifest write, each over the revision the
// browser read, and when either has moved on neither is written — the
// browser is told which, reads it again and merges.
//
// What is written is what the person's editor made of the document, markers
// and sidecar included: nothing here second-guesses it, as nothing
// second-guesses the files a Mac syncs.

import { keepPublic, moveAcross, moveWithin, removeDocument, removeVersion, repointPages, versionPath, type MoveAsk } from "./changes";
import { Refusal, commit, newFileId, type Tx } from "./commit";
import { Index, docExists, locate, nameOf, pathProblem, primaryOf, versionFlag, type Entry } from "./documents";
import { json, readJsonObject } from "./http";
import { MAX_FILE_BYTES, contentTypeOf } from "./layout";
import { askOf, mirrorAfter, searchIn } from "./search";
import { listSpaces, sharedEnv, spaceEnv, type Where } from "./spaces";
import { refuse, sectionOf, trimSlashes, type WebCall } from "./webCall";
import { META_SUFFIX } from "../../src/metaFile";

/** `commit` in a section, signed with the person at the browser. */
const change = <T>(c: WebCall, where: Where, fn: (tx: Tx) => Promise<T | Refusal>) =>
  commit(where.env, c.auth.memberId, fn, { mount: where.mount });

/* ---------- Saving ---------- */

type Part = "md" | "meta";

/** One file of a save: its new text, over the revision that was read — null
 *  when there must be no such file yet. */
type Save = { bytes: Uint8Array; ifRev: number | null };

function saveOf(raw: unknown, part: Part): Save | null | Refusal {
  if (raw === undefined) return null;
  const given = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const { text, ifRev } = given;
  if (typeof text !== "string" || !(ifRev === null || (typeof ifRev === "number" && Number.isInteger(ifRev) && ifRev > 0))) {
    return new Refusal(400, `${part} is {text, ifRev}: the new text, and the revision that was read — null for a file that must not exist yet`);
  }
  const bytes = new TextEncoder().encode(text);
  return bytes.byteLength > MAX_FILE_BYTES ? new Refusal(413, "that is too large — a file may be 25 MB") : { bytes, ifRev };
}

/** Why a file is not written over what is there now, or null. */
function movedOn(part: Part, ifRev: number | null, current: Entry | null): Refusal | null {
  const rev = current?.file.rev ?? null;
  if (rev === ifRev) return null;
  const it = part === "md" ? "this note" : "this document's comments";
  const how =
    rev === null
      ? "deleted somewhere else after it was opened here"
      : ifRev === null
        ? "made somewhere else before it was saved here"
        : "changed somewhere else after it was opened here";
  return new Refusal(409, `${it} ${part === "md" ? "was" : "were"} ${how}`, { part, rev });
}

/** What a saved file is now. */
const savedAs = ({ fid, file }: Entry): Record<string, unknown> => ({ fid, path: file.path, rev: file.rev, hash: file.hash, size: file.size });

export async function putDoc(c: WebCall): Promise<Response> {
  const q = c.url.searchParams;
  const where = await sectionOf(c, q.get("space"));
  if (where instanceof Refusal) return refuse(where);
  const path = q.get("path") ?? "";
  const body = await readJsonObject(c.request);
  if (!body) return json({ error: "invalid json body" }, 400);
  const md = saveOf(body.md, "md");
  if (md instanceof Refusal) return refuse(md);
  const meta = saveOf(body.meta, "meta");
  if (meta instanceof Refusal) return refuse(meta);
  if (!md && !meta) return json({ error: "say what to save: md, meta or both" }, 400);

  const done = await change(c, where, async (tx) => {
    const index = new Index(tx.files);
    const at = locate(index, path, null);
    if (at instanceof Refusal) return at;
    const { doc } = at;

    let text: Entry | null = null;
    if (md) {
      // The text of a document is its markdown. An html page is made
      // elsewhere and shown here.
      if (at.asked === "html") return new Refusal(400, "an html page is not edited in a browser — name the note");
      const moved = movedOn("md", md.ifRev, doc.md);
      if (moved) return moved;
      const target = versionPath(index, at, "md");
      if (target instanceof Refusal) return target;
      const fid = doc.md?.fid ?? newFileId();
      text = { fid, file: await tx.write(fid, target, md.bytes, contentTypeOf(target)) };
      // An html-only document that gains its markdown: its page becomes the
      // markdown's, which is what gives it the MD/HTML switch.
      if (!doc.md && doc.html) repointPages(tx, doc.html.fid, text);
    }

    let comments: Entry | null = null;
    if (meta) {
      const whose = text ?? primaryOf(doc);
      if (!whose) return new Refusal(404, `there is no document at "${path}"`);
      const moved = movedOn("meta", meta.ifRev, doc.meta);
      if (moved) return moved;
      const target = doc.meta?.file.path ?? `${nameOf(whose.file.path).stem}${META_SUFFIX}`;
      const fid = doc.meta?.fid ?? newFileId();
      comments = { fid, file: await tx.write(fid, target, meta.bytes, contentTypeOf(target)) };
    }
    keepPublic(tx);
    return { ...(text ? { md: savedAs(text) } : {}), ...(comments ? { meta: savedAs(comments) } : {}) };
  });
  if (done instanceof Refusal) return refuse(done);
  await mirrorAfter({ env: where.env, ctx: c.ctx }, done);
  // The etag is the manifest's after this save: a browser that held the one
  // before it knows nothing else moved.
  return json({ ...done.value, etag: done.etag });
}

/* ---------- Removing ---------- */

export async function deleteDoc(c: WebCall): Promise<Response> {
  const q = c.url.searchParams;
  const where = await sectionOf(c, q.get("space"));
  if (where instanceof Refusal) return refuse(where);
  const path = q.get("path") ?? "";
  const version = versionFlag(q.get("v"));
  if (version instanceof Refusal) return refuse(version);

  const done = await change(c, where, async (tx) => {
    const at = locate(new Index(tx.files), path, version);
    if (at instanceof Refusal) return at;
    if (!docExists(at.doc)) return new Refusal(404, `there is no document at "${path}"`);
    return version ? removeVersion(tx, at.doc, version) : removeDocument(tx, at.doc, c.url.origin);
  });
  if (done instanceof Refusal) return refuse(done);
  await mirrorAfter({ env: where.env, ctx: c.ctx }, done);
  return json({ ...done.value, etag: done.etag });
}

/** Everything under a folder. A folder is its files: once they are gone, so is it. */
export async function deleteFolder(c: WebCall): Promise<Response> {
  const q = c.url.searchParams;
  const where = await sectionOf(c, q.get("space"));
  if (where instanceof Refusal) return refuse(where);
  const path = trimSlashes(q.get("path"));
  const problem = path === "" ? "say which folder" : pathProblem(path);
  if (problem) return json({ error: problem }, 400);

  const done = await change(c, where, async (tx) => {
    const inside = new Index(tx.files).under(path);
    if (inside.length === 0) return new Refusal(404, `there is no folder "${path}"`);
    for (const e of inside) tx.remove(e.fid);
    // The folder as it is spelled, which is not always how it was named.
    return { kind: "folder", path: inside[0].file.path.slice(0, path.length), files: inside.length };
  });
  if (done instanceof Refusal) return refuse(done);
  await mirrorAfter({ env: where.env, ctx: c.ctx }, done);
  return json({ ...done.value, etag: done.etag });
}

/* ---------- Moving ---------- */

/** One end of a move: a section, and a path in it. */
function endOf(raw: unknown): { space: unknown; path: string } | null {
  const given = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const path = trimSlashes(given.path);
  return path === "" ? null : { space: given.space, path };
}

/** A document or a folder, to exactly where the browser said: a rename, a
 *  move to another folder, or a move to another section. */
export async function postMove(c: WebCall): Promise<Response> {
  const body = await readJsonObject(c.request);
  if (!body) return json({ error: "invalid json body" }, 400);
  const from = endOf(body.from);
  const to = endOf(body.to);
  const { kind } = body;
  if (!from || !to || (kind !== "document" && kind !== "folder")) {
    return json({ error: 'a move is {from: {space, path}, to: {space, path}, kind: "document" | "folder"}' }, 400);
  }
  const problem = pathProblem(from.path) ?? pathProblem(to.path);
  if (problem) return json({ error: problem }, 400);
  const source = await sectionOf(c, from.space);
  if (source instanceof Refusal) return refuse(source);
  const dest = await sectionOf(c, to.space);
  if (dest instanceof Refusal) return refuse(dest);
  // The browser shows the tree and names the place: never "into this folder".
  const ask: MoveAsk = { from: from.path, to: to.path, what: kind, into: () => false };

  if (source.space !== dest.space) {
    const moved = await moveAcross({ by: c.auth.memberId, ctx: c.ctx, origin: c.url.origin }, source, dest, ask);
    return moved instanceof Refusal ? refuse(moved) : json(moved);
  }
  const done = await change(c, source, async (tx) => moveWithin(tx, ask));
  if (done instanceof Refusal) return refuse(done);
  // A move changes no text, but it moves the etag the mirror is whole at.
  await mirrorAfter({ env: source.env, ctx: c.ctx }, done);
  return json({ ...done.value, etag: done.etag });
}

/* ---------- Searching ---------- */

/** Every section the person is in, the shared workspace first. A hit names
 *  its section and its file by their ids: the browser holds the manifests. */
export async function getSearch(c: WebCall): Promise<Response> {
  const ask = askOf(c.url.searchParams, "");
  if (ask instanceof Refusal) return refuse(ask);
  const spaces = await listSpaces(c.env, c.auth);
  if (spaces === null) return json({ error: "search needs this domain's database, which isn't answering — try again in a moment" }, 503);
  const sections: Where[] = [
    { space: "", mount: "", env: sharedEnv(c.env) },
    ...spaces.map((s) => ({ space: s.id, mount: "", env: spaceEnv(c.env, s.id) })),
  ];

  const found = await searchIn(c.env, sections, ask);
  if (found instanceof Refusal) return refuse(found);
  if ("indexing" in found) return json({ indexing: true, pending: found.indexing }, 202);
  return json({
    query: ask.query,
    results: found.hits.map((hit) => ({
      space: hit.space,
      fid: hit.fid,
      path: hit.path,
      matches: hit.matches,
      ...(hit.moreLines > 0 ? { moreLines: hit.moreLines } : {}),
      ...(hit.inName ? { inName: true } : {}),
      ...(hit.inComments ? { inComments: true } : {}),
    })),
    total: found.total,
    ...(found.total > found.hits.length ? { truncated: true } : {}),
    // Too large to mirror — said, rather than silently never found.
    ...(found.notSearched.length > 0 ? { notSearched: found.notSearched } : {}),
    // More sections than one request opens.
    ...(found.left.length > 0 ? { sectionsNotSearched: found.left.map((s) => s.space) } : {}),
  });
}
