// A folder's `boards.json` in a browser (src/boards.ts): read from the
// manifest this page holds, as any stored copy is; written by the worker
// (`/api/web/board`), over the revision it was read at. When it moved on,
// the two are merged by record (`mergeBoards`) and written again, as the
// engine merges them on a Mac, so a board's write never conflicts. A
// folder's notes' tags come in one request (`/api/web/tags`), answered from
// the worker's index of them, never one read per note.

import type { ManifestFile } from "../../cloud-worker/src/manifest";
import type { Boards, BoardsText, CardPair, Rev } from "../backend";
import { Refused, ask, askJson } from "./http";
import { mergeBoards } from "./merge";
import type { Workspace } from "./workspace";

/** What a board's `Rev` is here: the stored copy it was read from. */
type Read = { space: string; fid: string; rev: number };
const revOf = (r: Read) => r as unknown as Rev;
const readOf = (rev: Rev) => rev as unknown as Read;

/** How many times a write is merged and sent again while others write too. */
const WRITE_TRIES = 4;
/** How often a folder's tags are asked again while the worker's index of
 *  them catches up, and how long between (as a search is). */
const TAGS_TRIES = 6;
const TAGS_AGAIN_MS = 1200;

/** `/api/web/board`'s answer (cloud-worker/src/web.ts). */
type Written = { file: ManifestFile & { fid: string }; etag: string; over: string };

export function boardsOf(ws: Workspace): Boards {
  // The last answer for each folder, kept while its notes stay as they were:
  // a board read again after an edit elsewhere asks nothing.
  const answered = new Map<string, { key: string; cards: Record<string, CardPair[]> }>();
  const placed = (dir: string) => {
    const place = ws.place(dir);
    if (!place) throw new Error("That folder isn’t one you can open.");
    return place;
  };
  const at = (route: string, space: string, path: string, key = "path") =>
    `/api/web/${route}?space=${encodeURIComponent(space)}&${key}=${encodeURIComponent(path)}`;

  async function read(dir: string): Promise<BoardsText | null> {
    const found = ws.boardIn(dir);
    if (!found) return null;
    const text = await ws.textOf({ space: found.space, fid: found.fid, hash: found.file.hash });
    return { text, rev: revOf({ space: found.space, fid: found.fid, rev: found.file.rev }) };
  }

  return {
    read,
    async write(dir, text, base) {
      const place = placed(dir);
      let ours = text;
      let from = base;
      for (let tries = 1; ; tries += 1) {
        try {
          const done = await askJson<Written>("PUT", at("board", place.space, place.path), {
            body: { text: ours, ifRev: from ? readOf(from.rev).rev : null },
          });
          ws.keep(place.space, [done.file], done.etag, done.over);
          return { text: ours, rev: revOf({ space: place.space, fid: done.file.fid, rev: done.file.rev }) };
        } catch (e) {
          if (!(e instanceof Refused && e.status === 409) || tries === WRITE_TRIES) throw e;
        }
        // Somebody wrote it first, and the manifest held here doesn't say so yet.
        await ws.reread([place.space]);
        const now = await read(dir);
        if (now === null) {
          if (from !== null) throw new Error("This folder isn’t shown as a board any more.");
        } else {
          ours = mergeBoards(from?.text ?? null, ours, now.text);
        }
        from = now;
      }
    },
    async remove(dir) {
      const place = placed(dir);
      await ask("DELETE", at("board", place.space, place.path));
      await ws.reread([place.space]);
    },
    async folders(root) {
      return ws.boardFolders(root);
    },
    async cards(dir) {
      const place = placed(dir);
      const key = ws.notesKey(dir);
      const kept = answered.get(dir);
      if (key !== null && kept?.key === key) return kept.cards;
      for (let tries = 1; ; tries += 1) {
        const res = await ask("GET", at("tags", place.space, place.path, "dir"));
        if (res.status !== 202) {
          const { notes } = (await res.json()) as { notes: Record<string, CardPair[]> };
          const out: Record<string, CardPair[]> = {};
          for (const [fid, pairs] of Object.entries(notes)) {
            const path = ws.pathOfFile(place.space, fid);
            if (path) out[path.slice(path.lastIndexOf("/") + 1)] = pairs;
          }
          if (key !== null) answered.set(dir, { key, cards: out });
          return out;
        }
        const { pending } = (await res.json()) as { pending: number };
        if (tries === TAGS_TRIES) {
          throw new Error(
            `The board is still reading this folder’s notes: ${pending.toLocaleString()} ${pending === 1 ? "note" : "notes"} to go. Try again in a moment.`,
          );
        }
        await new Promise((done) => setTimeout(done, TAGS_AGAIN_MS));
      }
    },
  };
}
