// A folder shown as a board, in a tab of its own (src/boards.ts has the
// rules). Each value of the board's tag is a column, and every document
// directly in the folder is a card in the column of its value. Moving a
// card to another column sets the note's tag, through the code a tag chip
// uses (the host's `onSetTag`), and then writes the folder's
// `boards.json`; moving it up or down writes only `boards.json`.
//
// What a board shows costs no read per card: the names are the folder's
// listing, and the notes' tags come in one call (`Boards.cards`). All of it
// is read again whenever the host's tree is (`refreshToken`).
//
// Drag is built on pointer events, as the sidebar's and the tab strip's
// are: Tauri takes native drag events for its own file drops.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { backend, type BoardsText, type CardPair, type TreeNode } from "./backend";
import {
  boardColumns,
  dropCard,
  isBoardsFile,
  parseBoards,
  pruneBoard,
  regroup,
  serializeBoards,
  type Board as BoardFile,
  type BoardsRead,
  type Column,
} from "./boards";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu";
import type { TagDef } from "./tags";

const DOC_RE = /\.(md|markdown|mdown|mkd|html)$/i;
const MD_RE = /\.(md|markdown|mdown|mkd)$/i;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** A press becomes a drag past this many pixels; a shorter one is a click. */
const DRAG_THRESHOLD_PX = 5;
/** Dragging this close to the board's left or right edge scrolls it. */
const EDGE_PX = 48;

type Props = {
  dir: string;
  /** The tag list (src/tags.ts). */
  list: TagDef[];
  /** Bumped whenever the host reads its tree again. */
  refreshToken: number;
  /** Why the note at `path` can't change columns, in a sentence, or null
   *  when it can: another device holds it. */
  heldBy: (path: string) => string | null;
  /** A card clicked: the note in a tab of its own, or (⌘) one behind. */
  onOpen: (path: string, behind: boolean) => void;
  /** A card right-clicked: the sidebar's menu for its file. */
  onCardMenu: (path: string, x: number, y: number) => void;
  /** Set the note's tag (null: none), making the note when `create`.
   *  Resolves to a sentence when it couldn't. */
  onSetTag: (path: string, tag: string, value: string | null, create?: boolean) => Promise<string | null>;
  /** "+ New" made a note here: opened to be named. */
  onMade: (path: string) => void;
  /** *Show as Folder*. */
  onShowAsFolder: () => void;
  /** The folder is gone, or no longer a board: the tab is a ghost. */
  onGone: (gone: boolean) => void;
  onError: (sentence: string) => void;
};

/** What the board was read from. */
type Read = {
  missing: boolean;
  /** Every document directly in the folder, by file name. */
  names: string[];
  file: BoardsText | null;
  read: BoardsRead;
  /** Each markdown note's tag pairs, by its lowercased file name. */
  pairs: Map<string, CardPair[]>;
};

/** A column's key: its value whatever its case, or the notes with none. */
const keyOf = (c: Column) => (c.value === null ? "" : `=${c.value.toLowerCase()}`);

type Drag = {
  card: string;
  from: string;
  x: number;
  y: number;
  /** Where it would land: a column, and the place among its other cards. */
  over: { col: string; index: number } | null;
};

export default function Board({ dir, list, refreshToken, heldBy, onOpen, onCardMenu, onSetTag, onMade, onShowAsFolder, onGone, onError }: Props) {
  const [read, setRead] = useState<Read | null>(null);
  // What a change shows before the writes behind it land: the board as it
  // will be, and the cards whose column it moves.
  const [shown, setShown] = useState<{ board: BoardFile; values: Map<string, string | null> } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const ticket = useRef(0);
  const colsRef = useRef<HTMLDivElement>(null);

  // What a read tells the host, as it is now: the host's callbacks are new
  // on each of its renders, and the board is read again only when its
  // folder or the host's tree is.
  const tell = useRef({ onError, onGone });
  tell.current = { onError, onGone };

  const load = useCallback(async () => {
    const mine = ++ticket.current;
    let node: TreeNode | null = null;
    try {
      node = await backend.documents.tree(dir);
    } catch {
      node = null;
    }
    const names =
      node?.kind === "dir"
        ? node.children
            .filter((c) => c.kind === "file" && c.supported !== false && DOC_RE.test(c.name) && !isBoardsFile(c.name))
            .map((c) => c.name)
        : [];
    const file = node ? await backend.boards.read(dir).catch(() => null) : null;
    let pairs = new Map<string, CardPair[]>();
    if (file) {
      try {
        pairs = new Map(Object.entries(await backend.boards.cards(dir)).map(([name, p]) => [name.toLowerCase(), p]));
      } catch (e) {
        tell.current.onError(errText(e));
      }
    }
    if (mine !== ticket.current) return;
    setRead({ missing: node === null, names, file, read: file ? parseBoards(file.text) : null, pairs });
    setShown(null);
    tell.current.onGone(node === null || file === null);
  }, [dir]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  const board = shown?.board ?? (read && read.read !== null && read.read !== "newer" ? read.read : null);
  const def = board ? (list.find((d) => same(d.name, board.tag)) ?? null) : null;

  const valueOf = useCallback(
    (name: string): string | null => {
      if (shown?.values.has(name)) return shown.values.get(name) ?? null;
      if (!def || !read || !MD_RE.test(name)) return null;
      return read.pairs.get(name.toLowerCase())?.find((p) => same(p.name, def.name))?.value ?? null;
    },
    [shown, def, read],
  );

  const columns = useMemo(
    () => (board && def && read ? boardColumns(board, def, read.names.map((name) => ({ name, value: valueOf(name) }))) : []),
    [board, def, read, valueOf],
  );

  /** Why a card can't change columns, or null. */
  const fixedWhy = useCallback(
    (name: string): string | null => {
      if (!MD_RE.test(name)) return "An html document has no tags, so it stays here.";
      return heldBy(`${dir}/${name}`);
    },
    [dir, heldBy],
  );

  /** `next` written over the file as it was read, without the cards whose
   *  note is gone. `made`: a note made a moment ago, which the listing read
   *  doesn't have yet. */
  const write = useCallback(
    async (next: BoardFile, made?: string): Promise<boolean> => {
      if (!read) return false;
      try {
        const names = made === undefined ? read.names : [...read.names, made];
        await backend.boards.write(dir, serializeBoards(pruneBoard(next, names)), read.file);
        return true;
      } catch (e) {
        onError(errText(e));
        return false;
      }
    },
    [dir, read, onError],
  );

  /** `card` dropped at `index` among the other cards of `to`. */
  const commit = useCallback(
    async (card: string, from: string, to: Column, index: number) => {
      if (!board || !def) return;
      const others = to.cards.filter((n) => n !== card);
      const moved = keyOf(to) !== from;
      if (!moved && to.cards.indexOf(card) === index) return;
      const next = dropCard(board, others, index, card);
      setShown({ board: next, values: new Map(moved ? [[card, to.value]] : []) });
      setBusy(true);
      // The note first: a board that says a card moved when its note didn't
      // would be wrong; a rank for a card that didn't move is only a rank.
      const failed = moved ? await onSetTag(`${dir}/${card}`, def.name, to.value) : null;
      if (failed) onError(failed);
      else await write(next);
      setBusy(false);
      await load();
    },
    [board, def, dir, onSetTag, onError, write, load],
  );

  const newCard = useCallback(
    async (col: Column) => {
      if (!board || !def || !read || busy) return;
      const taken = new Set(read.names.map((n) => n.replace(DOC_RE, "").toLowerCase()));
      let stem = "Untitled";
      for (let n = 2; taken.has(stem.toLowerCase()); n += 1) stem = `Untitled ${n}`;
      const name = `${stem}.md`;
      const path = `${dir}/${name}`;
      setBusy(true);
      let failed: string | null = null;
      if (col.value === null) {
        await backend.documents.create(path, "file").catch((e: unknown) => {
          failed = `Couldn’t make a note here: ${errText(e)}`;
        });
      } else {
        failed = await onSetTag(path, def.name, col.value, true);
      }
      if (failed) {
        onError(failed);
        setBusy(false);
        return;
      }
      await write(dropCard(board, col.cards, col.cards.length, name), name);
      setBusy(false);
      onMade(path);
      await load();
    },
    [board, def, read, busy, dir, onSetTag, onError, write, onMade, load],
  );

  const groupBy = useCallback(
    async (tag: string) => {
      if (!board) return;
      setBusy(true);
      await write(regroup(board, tag));
      setBusy(false);
      await load();
    },
    [board, write, load],
  );

  const groupMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: r.left,
      y: r.bottom + 4,
      items: list.map((d) => ({ label: board && same(d.name, board.tag) ? `✓ ${d.name}` : d.name, onClick: () => void groupBy(d.name) })),
    });
  };

  /* ---------- Drag ---------- */

  /** Where the pointer would drop `card` from `from`: the column under it,
   *  and how many of its other cards sit above the pointer. */
  const overAt = useCallback(
    (x: number, y: number, card: string, from: string): Drag["over"] => {
      const cols = colsRef.current?.querySelectorAll<HTMLElement>("[data-board-col]") ?? [];
      for (const el of cols) {
        const r = el.getBoundingClientRect();
        if (x < r.left || x > r.right) continue;
        const key = el.dataset.boardCol ?? "";
        const col = columns.find((c) => keyOf(c) === key);
        if (!col) return null;
        // A card moves only to a listed value, and only when it may move at all.
        if (key !== from && ((!col.known && col.value !== null) || fixedWhy(card) !== null)) return null;
        let index = 0;
        for (const c of el.querySelectorAll<HTMLElement>("[data-card]")) {
          if (c.dataset.card === card) continue;
          const cr = c.getBoundingClientRect();
          if (y > cr.top + cr.height / 2) index += 1;
        }
        return { col: key, index };
      }
      return null;
    },
    [columns, fixedWhy],
  );

  // The window hears a drag to its end: what is under the pointer changes
  // as it moves, the card's own row included.
  const live = useRef({ overAt, columns, commit, onOpen, dir });
  live.current = { overAt, columns, commit, onOpen, dir };

  const onCardPointerDown = (e: React.PointerEvent, card: string, from: string) => {
    if (e.button !== 0 || busy) return;
    const start = { x: e.clientX, y: e.clientY, meta: e.metaKey };
    let current: Drag | null = null;
    const move = (ev: PointerEvent) => {
      if (!current && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD_PX) return;
      const el = colsRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        if (ev.clientX < r.left + EDGE_PX) el.scrollLeft -= 12;
        else if (ev.clientX > r.right - EDGE_PX) el.scrollLeft += 12;
      }
      current = { card, from, x: ev.clientX, y: ev.clientY, over: live.current.overAt(ev.clientX, ev.clientY, card, from) };
      setDrag(current);
    };
    const end = (ev: PointerEvent, cancelled: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      const { overAt: at, columns: cols, commit: drop, onOpen: open, dir: folder } = live.current;
      if (cancelled) {
        setDrag(null);
        return;
      }
      if (!current) {
        open(`${folder}/${card}`, start.meta || ev.metaKey);
        return;
      }
      const over = at(ev.clientX, ev.clientY, card, from);
      setDrag(null);
      const to = over && cols.find((c) => keyOf(c) === over.col);
      if (over && to) void drop(card, from, to, over.index);
    };
    const up = (ev: PointerEvent) => end(ev, false);
    const cancel = (ev: PointerEvent) => end(ev, true);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  };

  /* ---------- What it shows ---------- */

  if (!read) return <div className="board" data-testid="board" aria-busy />;

  const name = dir.slice(dir.lastIndexOf("/") + 1);
  const said = (sentence: string, more?: React.ReactNode) => (
    <div className="board" data-testid="board">
      <div className="board-head">
        <h1 className="board-title">{name}</h1>
      </div>
      <div className="board-said" data-testid="board-said">
        <p>{sentence}</p>
        {more}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
  if (read.missing) return said("This folder isn’t here any more.");
  if (!read.file) return said("This folder isn’t shown as a board any more.");
  if (read.read === "newer") return said("This board was made by a newer version of Doklin. Update Doklin to see it.");
  if (read.read === null) return said("This folder’s boards.json isn’t one Doklin can read, so it shows as a folder.");
  if (!def) {
    return said(
      list.length === 0
        ? `The tag list has no tag called “${read.read.tag}”, so there are no columns. Make a tag to group the notes by.`
        : `The tag list has no tag called “${read.read.tag}” any more. Pick another to group the notes by.`,
      list.length > 0 && (
        <button className="board-bar-btn" data-testid="board-group" onClick={groupMenu}>
          Group by ▾
        </button>
      ),
    );
  }

  const others = list.filter((d) => !same(d.name, def.name));
  const chipsOf = (card: string) => {
    if (!MD_RE.test(card)) return [];
    const pairs = read.pairs.get(card.toLowerCase()) ?? [];
    return others.flatMap((d) => {
      const pair = pairs.find((p) => same(p.name, d.name));
      if (!pair) return [];
      const listed = d.values.find((v) => same(v, pair.value));
      return [{ name: d.name, value: listed ?? pair.value, known: listed !== undefined }];
    });
  };

  return (
    <div className={`board ${drag ? "is-dragging" : ""}`} data-testid="board">
      <div className="board-head">
        <h1 className="board-title">{name}</h1>
        <div className="board-bar">
          <button className="board-bar-btn" data-testid="board-group" onClick={groupMenu} disabled={busy}>
            Group by {def.name} ▾
          </button>
          <span className="board-spacer" />
          <button className="board-bar-btn" data-testid="board-show-folder" onClick={onShowAsFolder} disabled={busy}>
            Show as Folder
          </button>
        </div>
      </div>
      <div className="board-cols" ref={colsRef}>
        {columns.map((col) => {
          const key = keyOf(col);
          // The notes with no value show only when there are some, and while
          // a card is dragged, as somewhere to put it.
          if (col.value === null && col.cards.length === 0 && !drag) return null;
          const target = drag?.over?.col === key ? drag.over : null;
          // The drop line sits among the column's other cards.
          let others = 0;
          return (
            <section
              key={key}
              className={`board-col ${col.known ? "" : "is-unlisted"} ${target ? "is-target" : ""}`}
              data-board-col={key}
              data-testid="board-col"
              aria-label={col.value ?? `No ${def.name}`}
            >
              <header className="board-col-head">
                <span className="board-col-name">{col.value ?? `No ${def.name}`}</span>
                <span className="board-col-count">{col.cards.length}</span>
              </header>
              <div className="board-col-list">
                {col.cards.map((card) => {
                  const why = fixedWhy(card);
                  const chips = chipsOf(card);
                  const lineHere = target !== null && card !== drag?.card && target.index === others;
                  if (card !== drag?.card) others += 1;
                  return (
                    <div key={card}>
                      {lineHere && <div className="board-drop-line" />}
                      <div
                        className={`board-card ${drag?.card === card ? "is-lifted" : ""} ${why ? "is-fixed" : ""}`}
                        role="button"
                        tabIndex={0}
                        data-card={card}
                        data-testid="board-card"
                        title={why ?? undefined}
                        onPointerDown={(e) => onCardPointerDown(e, card, key)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          onCardMenu(`${dir}/${card}`, e.clientX, e.clientY);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") onOpen(`${dir}/${card}`, e.metaKey);
                        }}
                      >
                        <div className="board-card-title">{card.replace(DOC_RE, "")}</div>
                        {chips.length > 0 && (
                          <div className="board-card-chips">
                            {chips.map((c) => (
                              <span key={c.name} className={`board-chip ${c.known ? "" : "is-unlisted"}`} title={`${c.name}: ${c.value}`}>
                                {c.value}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
                {target && target.index >= col.cards.filter((c) => c !== drag?.card).length && <div className="board-drop-line" />}
              </div>
              {(col.known || col.value === null) && (
                <button className="board-col-add" data-testid="board-new" onClick={() => void newCard(col)} disabled={busy}>
                  + New
                </button>
              )}
            </section>
          );
        })}
      </div>
      {drag && (
        <div className="board-ghost" style={{ left: drag.x + 8, top: drag.y + 8 }}>
          {drag.card.replace(DOC_RE, "")}
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** A board's mark: on its tab, and on its folder's row. */
export function BoardIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="9" y1="4" x2="9" y2="20" />
      <line x1="15" y1="4" x2="15" y2="20" />
    </svg>
  );
}
