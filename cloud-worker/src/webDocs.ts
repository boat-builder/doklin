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
//
// Every change answers `etag`, the manifest's once it was made, and `over`,
// the manifest's it was made to. A browser that held `over` holds the
// manifest still, with this one change in it, and asks for nothing.

import { copyTo, keepPublic, moveAcross, moveWithin, removeDocument, removeVersion, repointPages, versionPath, type MoveAsk } from "./changes";
import { Refusal, commit, newFileId, type Committed, type Tx } from "./commit";
import { Index, docExists, locate, nameOf, pathProblem, primaryOf, versionFlag, type Entry } from "./documents";
import { json, readJsonObject } from "./http";
import { MAX_FILE_BYTES, SHARE_ID_RE, contentTypeOf, validPath } from "./layout";
import { setMount } from "./mounts";
import { askOf, mirrorAfter, searchIn } from "./search";
import { listOpenSpaces, openSpace, sharedEnv, spaceEnv, type Where } from "./spaces";
import { filtersOf } from "./tagList";
import { refuse, sectionOf, trimSlashes, type WebCall } from "./webCall";
import type { SearchAnswer, SearchIndexing } from "./wire";
import { META_SUFFIX } from "../../src/metaFile";

/** `commit` in a section, signed with the person at the browser. */
const change = <T>(c: WebCall, where: Where, fn: (tx: Tx) => Promise<T | Refusal>) =>
  commit(where.env, c.auth.memberId, fn, { at: where });

/** What a change is answered with: what it did, and the two etags. */
const answered = (made: Committed<Record<string, unknown>>): Response => json({ ...made.value, etag: made.etag, over: made.over });

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

/** What a saved file is now: its id, and its entry in the manifest. */
const savedAs = ({ fid, file }: Entry): Record<string, unknown> => ({ fid, ...file });

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

  const made = await change(c, where, async (tx) => {
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
  if (made instanceof Refusal) return refuse(made);
  await mirrorAfter({ env: where.env, ctx: c.ctx }, made);
  return answered(made);
}

/* ---------- Removing ---------- */

export async function deleteDoc(c: WebCall): Promise<Response> {
  const q = c.url.searchParams;
  const where = await sectionOf(c, q.get("space"));
  if (where instanceof Refusal) return refuse(where);
  const path = q.get("path") ?? "";
  const version = versionFlag(q.get("v"));
  if (version instanceof Refusal) return refuse(version);

  const made = await change(c, where, async (tx) => {
    const at = locate(new Index(tx.files), path, version);
    if (at instanceof Refusal) return at;
    if (!docExists(at.doc)) return new Refusal(404, `there is no document at "${path}"`);
    return version ? removeVersion(tx, at.doc, version) : removeDocument(tx, at.doc, c.url.origin);
  });
  if (made instanceof Refusal) return refuse(made);
  await mirrorAfter({ env: where.env, ctx: c.ctx }, made);
  return answered(made);
}

/** Everything under a folder. A folder is its files: once they are gone, so is it. */
export async function deleteFolder(c: WebCall): Promise<Response> {
  const q = c.url.searchParams;
  const where = await sectionOf(c, q.get("space"));
  if (where instanceof Refusal) return refuse(where);
  const path = trimSlashes(q.get("path"));
  const problem = path === "" ? "say which folder" : pathProblem(path);
  if (problem) return json({ error: problem }, 400);

  const made = await change(c, where, async (tx) => {
    const inside = new Index(tx.files).under(path);
    if (inside.length === 0) return new Refusal(404, `there is no folder "${path}"`);
    for (const e of inside) tx.remove(e.fid);
    // The folder as it is spelled, which is not always how it was named.
    return { kind: "folder", path: inside[0].file.path.slice(0, path.length), files: inside.length };
  });
  if (made instanceof Refusal) return refuse(made);
  await mirrorAfter({ env: where.env, ctx: c.ctx }, made);
  return answered(made);
}

/* ---------- Moving ---------- */

/** One end of a move: a section, and a path in it — "" the section's top. */
function endOf(raw: unknown): { space: unknown; path: string } | null {
  if (raw === null || typeof raw !== "object") return null;
  const given = raw as Record<string, unknown>;
  return typeof given.path === "string" ? { space: given.space, path: trimSlashes(given.path) } : null;
}

/** What a move or a copy names: what it is, the section it is in and the
 *  one it goes to. */
type Placed = { ask: MoveAsk; source: Where; dest: Where };

async function placedOf(c: WebCall, verb: "move" | "copy"): Promise<Placed | Refusal> {
  const body = await readJsonObject(c.request);
  if (!body) return new Refusal(400, "invalid json body");
  const from = endOf(body.from);
  const to = endOf(body.to);
  const { kind } = body;
  if (!from || !to || from.path === "" || (kind !== "document" && kind !== "folder")) {
    return new Refusal(400, `a ${verb} is {from: {space, path}, to: {space, path}, kind: "document" | "folder"}`);
  }
  const source = await sectionOf(c, from.space);
  if (source instanceof Refusal) return source;
  const dest = await sectionOf(c, to.space);
  if (dest instanceof Refusal) return dest;
  // The top of a section is where a folder moved from another one goes when
  // it is to be that section: a folder that is being shared.
  const top = to.path === "";
  if (top && !(verb === "move" && kind === "folder" && source.space !== dest.space)) {
    return new Refusal(400, "only a folder moved from another section goes to the top of one — say where this goes");
  }
  const problem = pathProblem(from.path) ?? (top ? null : pathProblem(to.path));
  if (problem) return new Refusal(400, problem);
  // The browser shows the tree and names the place: never "into this folder".
  // And it asks again for a folder that is more than one request carries.
  return { ask: { from: from.path, to: to.path, what: kind, into: () => false, parts: verb === "move" }, source, dest };
}

/** A document or a folder, to exactly where the browser said: a rename, a
 *  move to another folder, or a move to another section — where a folder of
 *  more files than a request carries goes in parts (`remaining`, changes.ts). */
export async function postMove(c: WebCall): Promise<Response> {
  const placed = await placedOf(c, "move");
  if (placed instanceof Refusal) return refuse(placed);
  const { ask, source, dest } = placed;
  if (source.space !== dest.space) {
    const moved = await moveAcross({ by: c.auth.memberId, ctx: c.ctx, origin: c.url.origin }, source, dest, ask);
    return moved instanceof Refusal ? refuse(moved) : json(moved);
  }
  const made = await change(c, source, async (tx) => moveWithin(tx, ask));
  if (made instanceof Refusal) return refuse(made);
  // A move changes no text, but it moves the etag the mirror is whole at.
  await mirrorAfter({ env: source.env, ctx: c.ctx }, made);
  return answered(made);
}

/** A document or a folder again, at exactly where the browser said: beside
 *  what it was copied from, in another folder, or in another section. */
export async function postCopy(c: WebCall): Promise<Response> {
  const placed = await placedOf(c, "copy");
  if (placed instanceof Refusal) return refuse(placed);
  const made = await copyTo({ by: c.auth.memberId, ctx: c.ctx, origin: c.url.origin }, placed.source, placed.dest, placed.ask);
  return made instanceof Refusal ? refuse(made) : answered(made);
}

/* ---------- Where a share sits ---------- */

/**
 * Say where a share sits in the section it is in: the folder of that section
 * its item is in. The entry is the section's manifest's (`mounts`), so it
 * lands with a compare-and-swap like any change to the tree; who can open
 * the share is never read from it (spaces.ts).
 */
export async function putMount(c: WebCall): Promise<Response> {
  const q = c.url.searchParams;
  const where = await sectionOf(c, q.get("space"));
  if (where instanceof Refusal) return refuse(where);
  const id = q.get("id") ?? "";
  const body = await readJsonObject(c.request);
  const dir = trimSlashes(body?.dir);
  const was = body?.was === undefined ? undefined : trimSlashes(body.was);
  if (!body || !SHARE_ID_RE.test(id) || typeof body.dir !== "string" || (dir !== "" && !validPath(dir)) || (was !== undefined && !validPath(was))) {
    return json({ error: "a mount is {dir, was?}, for the share ?id= in the section ?space=" }, 400);
  }
  const share = await openSpace(c.env, c.auth, id);
  if (share === null) return json({ error: "the domain's database isn't answering — try again in a moment" }, 503);
  if (share === "none" || share.parent !== where.space) return json({ error: "that is not something shared from here" }, 404);

  const made = await setMount(where.env, c.auth.memberId, id, { dir, ...(was === undefined ? {} : { was }) });
  return made instanceof Refusal ? refuse(made) : json({ etag: made.etag, over: made.over });
}

/* ---------- Searching ---------- */

/** Every section the person can open, the shared workspace first — as many
 *  as a request opens, `next` saying where the next one starts (`after`). A
 *  hit names its section and its file by their ids: the browser holds the
 *  manifests.
 *  `tag=name:value` (repeatable) narrows it to notes with that tag, and
 *  `tag=name` to notes with the tag at all; the browser sends only listed
 *  names, spelled as the list spells them. */
export async function getSearch(c: WebCall): Promise<Response> {
  const tags = filtersOf(c.url.searchParams, "tag");
  if (tags instanceof Refusal) return refuse(tags);
  const ask = askOf(c.url.searchParams, "", tags);
  if (ask instanceof Refusal) return refuse(ask);
  const spaces = await listOpenSpaces(c.env, c.auth);
  if (spaces === null) return json({ error: "search needs this domain's database, which isn't answering — try again in a moment" }, 503);
  const raw = Number(c.url.searchParams.get("after") ?? "0");
  const after = Number.isInteger(raw) && raw > 0 ? raw : 0;
  const sections: Where[] = [
    { space: "", mount: "", env: sharedEnv(c.env) },
    ...spaces.map((s) => ({ space: s.id, mount: "", env: spaceEnv(c.env, s) })),
  ].slice(after);

  const found = await searchIn(c.env, sections, ask);
  if (found instanceof Refusal) return refuse(found);
  if ("indexing" in found) return json({ indexing: true, pending: found.indexing } satisfies SearchIndexing, 202);
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
    // More sections than one request opens: the rest are the next request's.
    ...(found.left.length > 0 ? { next: after + sections.length - found.left.length } : {}),
  } satisfies SearchAnswer);
}
