// A folder shown as a board, from a browser, and the tags of its cards
// (web.ts lists the routes).
//
// A board is a file in its folder, `boards.json` (src/boards.ts): which tag
// groups the folder's notes into columns, and each card's rank. It syncs as
// a document does, so a browser's write goes through the commit its save
// goes through, over the revision it read; when the file moved on, nothing
// is written, and the browser merges (`mergeBoards`, src/web/merge.ts) and
// writes again. Only the apps read it: to an agent the folder is notes with
// tags, and no route of theirs names the file (documents.ts).
//
// A card's column is its note's tag, and a tag is a line of the note's text,
// which a browser does not hold. So it asks for the tags of the whole folder
// at once, answered from the index the search catch-up keeps (search.ts): a
// board of 500 cards is one request, never one per card.

import { Refusal, commit, newFileId } from "./commit";
import { Index, pathProblem } from "./documents";
import { json, readJsonObject } from "./http";
import { MAX_FILE_BYTES, contentTypeOf } from "./layout";
import type { Manifest } from "./manifest";
import { catchUpOpen, mirrorAfter, pairsIn } from "./search";
import { kindOf, type Where } from "./spaces";
import { readTagList } from "./tagList";
import { refuse, sectionOf, trimSlashes, type WebCall } from "./webCall";
import { dirOf, isMarkdownPath, openWorkspace } from "./workspace";
import { BOARDS_FILE, parseBoards } from "../../src/boards";

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const under = (path: string, dir: string): boolean => path.toLowerCase().startsWith(`${dir.toLowerCase()}/`);

/** Where a folder's board is, or would be. */
const boardPath = (folder: string): string => (folder === "" ? BOARDS_FILE : `${folder}/${BOARDS_FILE}`);

/**
 * The folder a board request names, or why it can't be shown as one. A
 * section's own top is a board only in a shared folder, which is a folder
 * of the section it sits in; Library's top and a My files' are headings,
 * and a shared document's section holds no folder.
 */
function boardFolder(where: Where, raw: unknown): string | Refusal {
  const folder = trimSlashes(raw);
  if (folder === "") {
    return kindOf(where.env) === "folder" ? "" : new Refusal(400, "a section's own folder is never a board — show a folder inside it as one");
  }
  const problem = pathProblem(folder);
  return problem ? new Refusal(400, problem) : folder;
}

/** Whether `folder` is one of the section's: something is in it, a file or
 *  something shared that sits there. */
function isFolderOf(m: Manifest, index: Index, folder: string): boolean {
  if (folder === "" || index.isFolder(folder)) return true;
  return Object.values(m.mounts ?? {}).some((mount) => same(mount.dir, folder) || under(mount.dir, folder));
}

/** Why a board is not written over what is there now, or null. */
function movedOn(ifRev: number | null, rev: number | null): Refusal | null {
  if (rev === ifRev) return null;
  const how =
    rev === null
      ? "this folder was shown as a folder again somewhere else after its board was opened here"
      : ifRev === null
        ? "this folder was shown as a board somewhere else before this board was saved here"
        : "this board was changed somewhere else after it was opened here";
  return new Refusal(409, how, { rev });
}

/* ---------- The board's file ---------- */

/** Show a folder as a board, or change its board: `boards.json` written
 *  over the revision that was read, null when there is none yet. A file
 *  that is there under another case keeps its name. */
export async function putBoard(c: WebCall): Promise<Response> {
  const q = c.url.searchParams;
  const where = await sectionOf(c, q.get("space"));
  if (where instanceof Refusal) return refuse(where);
  const folder = boardFolder(where, q.get("path"));
  if (folder instanceof Refusal) return refuse(folder);
  const body = await readJsonObject(c.request);
  const text = body?.text;
  const ifRev = body?.ifRev;
  if (typeof text !== "string" || !(ifRev === null || (typeof ifRev === "number" && Number.isInteger(ifRev) && ifRev > 0))) {
    return json({ error: "a board is {text, ifRev}: the file's new text, and the revision that was read — null when there is none yet" }, 400);
  }
  const read = parseBoards(text);
  if (read === null) return json({ error: `that is not a board — ${BOARDS_FILE} holds {"doklin": "boards", "v": 1, …}` }, 400);
  if (read === "newer") return json({ error: "that board is from a newer Doklin than this workspace's worker — update the worker first" }, 400);
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > MAX_FILE_BYTES) return json({ error: "that is too large — a file may be 25 MB" }, 413);

  const made = await commit(
    where.env,
    c.auth.memberId,
    async (tx) => {
      const index = new Index(tx.files);
      if (!isFolderOf(tx.m, index, folder)) return new Refusal(400, `there is no folder "${folder}" here`);
      const current = index.at(boardPath(folder));
      const moved = movedOn(ifRev, current?.file.rev ?? null);
      if (moved) return moved;
      const target = current?.file.path ?? index.spelled(boardPath(folder));
      const place = current ? null : index.placeProblem(target);
      if (place) return new Refusal(409, place);
      const fid = current?.fid ?? newFileId();
      const file = await tx.write(fid, target, bytes, contentTypeOf(target));
      return { file: { fid, ...file } };
    },
    { at: where },
  );
  if (made instanceof Refusal) return refuse(made);
  // A board changes no text, but it moves the etag the mirror is whole at.
  await mirrorAfter({ env: where.env, ctx: c.ctx }, made);
  return json({ ...made.value, etag: made.etag, over: made.over });
}

/** *Show as Folder*: the board's file goes as a deleted document does, with
 *  the tombstone a Mac honours, so the folder's history keeps it. */
export async function deleteBoard(c: WebCall): Promise<Response> {
  const q = c.url.searchParams;
  const where = await sectionOf(c, q.get("space"));
  if (where instanceof Refusal) return refuse(where);
  const folder = boardFolder(where, q.get("path"));
  if (folder instanceof Refusal) return refuse(folder);

  const made = await commit(
    where.env,
    c.auth.memberId,
    async (tx) => {
      const current = new Index(tx.files).at(boardPath(folder));
      if (!current) return new Refusal(404, folder === "" ? "this folder is not shown as a board" : `"${folder}" is not shown as a board`);
      tx.remove(current.fid);
      return { tombstone: { fid: current.fid, ...tx.m.tombstones![current.fid] } };
    },
    { at: where },
  );
  if (made instanceof Refusal) return refuse(made);
  await mirrorAfter({ env: where.env, ctx: c.ctx }, made);
  return json({ ...made.value, etag: made.etag, over: made.over });
}

/* ---------- The cards' tags ---------- */

/**
 * Every note directly in the folder `dir` ("" the section's top) — never
 * one in a folder beneath it — with its pairs for the listed tags, by its
 * markdown file's id: `[]` for one that has none. Names as the list spells
 * them, values as the note does. The index is caught up first, as a search
 * that narrows by a tag is: a `202` while it reads, and the browser asks
 * again.
 */
export async function getTags(c: WebCall): Promise<Response> {
  const q = c.url.searchParams;
  const where = await sectionOf(c, q.get("space"));
  if (where instanceof Refusal) return refuse(where);
  const dir = trimSlashes(q.get("dir"));
  const problem = dir === "" ? null : pathProblem(dir);
  if (problem) return json({ error: problem }, 400);
  const ws = await openWorkspace(where.env);
  if (!ws) return where.space === "" ? json({ error: "this domain holds no workspace yet" }, 404) : json({ notes: {} });

  const notes = Object.entries(ws.manifest.files)
    .filter(([, f]) => isMarkdownPath(f.path) && same(dirOf(f.path), dir))
    .map(([fid]) => fid);
  if (notes.length === 0) return json({ notes: {} });
  const list = await readTagList(c.env);
  if (list.length === 0) return json({ notes: Object.fromEntries(notes.map((fid) => [fid, []])) });

  const open = [{ section: where, ws }];
  const up = await catchUpOpen(c.env, open);
  if (up instanceof Refusal) return refuse(up);
  if ("indexing" in up) return json({ indexing: true, pending: up.indexing }, 202);
  const held = await pairsIn(c.env, open, list.map((d) => d.name.toLowerCase()));
  if (held === null) return json({ error: "this needs the domain's database, which isn't answering — try again in a moment" }, 503);
  const answer: Record<string, { name: string; value: string }[]> = {};
  for (const fid of notes) {
    const pairs = held.pairs.get(`${where.space}/${fid}`);
    answer[fid] = list.flatMap((d) => {
      const value = pairs?.get(d.name.toLowerCase());
      return value === undefined ? [] : [{ name: d.name, value }];
    });
  }
  return json({ notes: answer });
}
