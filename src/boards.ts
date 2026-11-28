// Boards: a folder shown as columns, by one of the tag list's tags.
//
// A file in the folder, `boards.json`, says how: by which tag, and in what
// order the cards sit. Each of the tag's values is a column, and every
// document directly in the folder is a card in the column of its value.
// Moving a card to another column sets the note's tag (src/tags.ts); moving
// it up or down changes only `boards.json`.
//
// Only the apps read the file. Agents and `doklin` never see it: to them the
// folder is notes with tags, as it is to everyone without the file.
//
//   {
//     "doklin": "boards",
//     "v": 1,
//     "tag": "Status",
//     "cards": {
//       "Fix the login.md": { "rank": "a0" },
//       "Write the docs.md": { "rank": "a0V" }
//     }
//   }
//
// `tag` is the tag's name as the list spelled it when it was picked. Cards
// are keyed by file name, extension included; both match whatever their
// case. A rank is an order key (src/rank.ts), and a card with no entry has
// none. Keys this app doesn't know are kept, at the top and in a card, so a
// newer app's fields survive an older app's write. A file without the
// header, with a `v` this app doesn't know, or that isn't JSON makes no
// board, and the app never rewrites it.
//
// The bytes are canonical (`serializeBoards`): the same board is always the
// same file, so a merge the engine writes and one a browser writes agree.
// The file merges by its records, never as text (`mergeBoards`,
// src/web/merge.ts, and `engine/src/boards.rs`).
//
// The iPhone ports this (ios/DoklinKit/Sources/DoklinKit/Markdown/Boards.swift)
// and the engine merges it. All three are held to
// verify-harness/boards-fixture.json: change all three.

import { isRank, rankBetween, ranksBetween } from "./rank";
import type { TagDef } from "./tags";

/** The file a board folder holds, found whatever its case. */
export const BOARDS_FILE = "boards.json";
/** The one version this app reads and writes. */
export const BOARDS_V = 1;

/** Whether `path` names a folder's `boards.json`. */
export const isBoardsFile = (path: string): boolean => path.slice(path.lastIndexOf("/") + 1).toLowerCase() === BOARDS_FILE;

/** A card's record: its rank, and the keys a newer app wrote. */
export type BoardCard = { rank: string | null; extra: Record<string, unknown> };

/** What `boards.json` holds, read. */
export type Board = { tag: string; cards: Record<string, BoardCard>; extra: Record<string, unknown> };

/** What reading a `boards.json` gives: a board, a newer app's file, or
 *  nothing this app reads (not JSON, or no header). */
export type BoardsRead = Board | "newer" | null;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/* ---------- Order ---------- */

/** Text in code-point order, which is how Rust and Swift compare strings
 *  too (JavaScript compares UTF-16 units, which puts a character past
 *  U+FFFF before U+E000–U+FFFF). */
export function compareText(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  const unit = (c: number) => (c >= 0xd800 && c <= 0xdfff ? c + 0x2000 : c >= 0xe000 ? c - 0x800 : c);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) return unit(x) - unit(y);
  }
  return a.length - b.length;
}

/** File names in a board's order: whatever their case, then exactly. */
export const compareNames = (a: string, b: string): number =>
  compareText(a.toLowerCase(), b.toLowerCase()) || compareText(a, b);

/* ---------- The file ---------- */

/** A board with no cards yet, grouped by `tag`. */
export const newBoard = (tag: string): Board => ({ tag, cards: {}, extra: {} });

/** Reads a `boards.json`. Lenient inside a readable file: a `tag` that
 *  isn't text reads as none, a card that isn't a record is skipped, a rank
 *  that isn't text reads as none, and of two keys for one card in different
 *  cases the first in code-point order is kept. */
export function parseBoards(text: string): BoardsRead {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(v) || v.doklin !== "boards" || typeof v.v !== "number") return null;
  if (v.v !== BOARDS_V) return Number.isInteger(v.v) && v.v > BOARDS_V ? "newer" : null;
  const board = newBoard(typeof v.tag === "string" ? v.tag : "");
  for (const [key, value] of Object.entries(v)) {
    if (key !== "doklin" && key !== "v" && key !== "tag" && key !== "cards") board.extra[key] = value;
  }
  if (isObject(v.cards)) {
    const seen = new Set<string>();
    for (const name of Object.keys(v.cards).sort(compareText)) {
      const record = v.cards[name];
      if (name === "" || !isObject(record) || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      const card: BoardCard = { rank: typeof record.rank === "string" ? record.rank : null, extra: {} };
      for (const [key, value] of Object.entries(record)) if (key !== "rank") card.extra[key] = value;
      board.cards[name] = card;
    }
  }
  return board;
}

/** A value as one line of canonical JSON: an object's keys in code-point
 *  order, nothing between tokens. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).sort(compareText);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const hasRecord = (card: BoardCard) => card.rank !== null || Object.keys(card.extra).length > 0;

/** A card's record as its line holds it: `rank`, then the other keys in
 *  code-point order. */
function cardJson(card: BoardCard): string {
  const parts: string[] = [];
  if (card.rank !== null) parts.push(`"rank": ${JSON.stringify(card.rank)}`);
  for (const key of Object.keys(card.extra).sort(compareText)) {
    parts.push(`${JSON.stringify(key)}: ${canonicalJson(card.extra[key])}`);
  }
  return `{ ${parts.join(", ")} }`;
}

/** The file's bytes: the header, `tag`, `cards` (one per line, in
 *  code-point order of their names), then the keys a newer app wrote, in
 *  code-point order; two-space indent and a final newline. A card with
 *  nothing in its record is left out. */
export function serializeBoards(board: Board): string {
  const lines = [`  "doklin": "boards"`, `  "v": ${BOARDS_V}`, `  "tag": ${JSON.stringify(board.tag)}`];
  const names = Object.keys(board.cards).filter((n) => hasRecord(board.cards[n])).sort(compareText);
  lines.push(
    names.length === 0
      ? `  "cards": {}`
      : `  "cards": {\n${names.map((n) => `    ${JSON.stringify(n)}: ${cardJson(board.cards[n])}`).join(",\n")}\n  }`,
  );
  for (const key of Object.keys(board.extra).sort(compareText)) {
    lines.push(`  ${JSON.stringify(key)}: ${canonicalJson(board.extra[key])}`);
  }
  return `{\n${lines.join(",\n")}\n}\n`;
}

/* ---------- Cards ---------- */

/** The key `name`'s card has in `board`, whatever its case, or null. */
export function cardKey(board: Board, name: string): string | null {
  if (name in board.cards) return name;
  const lower = name.toLowerCase();
  return Object.keys(board.cards).find((k) => k.toLowerCase() === lower) ?? null;
}

/** `name`'s rank on `board`, when it has one that is a rank. */
export function rankOf(board: Board, name: string): string | null {
  const key = cardKey(board, name);
  const rank = key === null ? null : board.cards[key].rank;
  return isRank(rank) ? rank : null;
}

/** `names` in the order a column shows them: ranked cards by rank (two
 *  with one rank by name), then cards with no rank by name. */
export function orderCards(board: Board, names: string[]): string[] {
  const ranked = names.filter((n) => rankOf(board, n) !== null);
  const unranked = names.filter((n) => rankOf(board, n) === null);
  ranked.sort((a, b) => compareText(rankOf(board, a)!, rankOf(board, b)!) || compareNames(a, b));
  unranked.sort(compareNames);
  return [...ranked, ...unranked];
}

/** A note as a board sees it: its file name and its value for the board's
 *  tag (null: none, or an html-only document, which has no tags). */
export type BoardNote = { name: string; value: string | null };

/** A column: the value it is for (null: the notes with none), whether that
 *  value is one of the tag's, and its cards in order. */
export type Column = { value: string | null; known: boolean; cards: string[] };

/**
 * The board's columns: the notes with no value for the tag, then one per
 * value of `def` in the list's order, then one per value a note has that
 * the list lacks (marked, never dropped), in code-point order whatever
 * their case. Values match whatever their case; a listed one shows as the
 * list spells it, an unlisted one as the first card in name order spells it.
 */
export function boardColumns(board: Board, def: TagDef, notes: BoardNote[]): Column[] {
  const none: string[] = [];
  const listed = def.values.map((value) => ({ value, names: [] as string[] }));
  const others = new Map<string, { value: string; names: string[] }>();
  for (const note of [...notes].sort((a, b) => compareNames(a.name, b.name))) {
    if (note.value === null || note.value === "") {
      none.push(note.name);
      continue;
    }
    const lower = note.value.toLowerCase();
    const known = listed.find((c) => c.value.toLowerCase() === lower);
    if (known) {
      known.names.push(note.name);
      continue;
    }
    const other = others.get(lower) ?? { value: note.value, names: [] };
    other.names.push(note.name);
    others.set(lower, other);
  }
  return [
    { value: null, known: true, cards: orderCards(board, none) },
    ...listed.map((c) => ({ value: c.value, known: true, cards: orderCards(board, c.names) })),
    ...[...others.entries()]
      .sort(([a], [b]) => compareText(a, b))
      .map(([, c]) => ({ value: c.value, known: false, cards: orderCards(board, c.names) })),
  ];
}

const copyBoard = (board: Board): Board => ({
  tag: board.tag,
  extra: { ...board.extra },
  cards: Object.fromEntries(Object.entries(board.cards).map(([k, c]) => [k, { rank: c.rank, extra: { ...c.extra } }])),
});

/** Sets `name`'s rank, keyed by `name` as spelled now (a key in another
 *  case goes). */
function setRank(board: Board, name: string, rank: string): void {
  const key = cardKey(board, name);
  const extra = key === null ? {} : board.cards[key].extra;
  if (key !== null) delete board.cards[key];
  board.cards[name] = { rank, extra };
}

/**
 * The board once `card` is dropped at `index` in a column that shows
 * `column` (its cards in order, without `card`). The column's cards with no
 * rank are ranked first, after its ranked ones and in the order shown, so
 * what was seen is what stays; then `card` gets a rank between its new
 * neighbours. "+ New" drops at the column's end.
 */
export function dropCard(board: Board, column: string[], index: number, card: string): Board {
  const next = copyBoard(board);
  const others = column.filter((n) => n.toLowerCase() !== card.toLowerCase());
  const at = Math.max(0, Math.min(index, others.length));
  const unranked = others.filter((n) => rankOf(next, n) === null);
  if (unranked.length > 0) {
    const ranked = others.filter((n) => rankOf(next, n) !== null);
    const last = ranked.length > 0 ? rankOf(next, ranked[ranked.length - 1]) : null;
    ranksBetween(last, null, unranked.length).forEach((rank, i) => setRank(next, unranked[i], rank));
  }
  const before = at > 0 ? rankOf(next, others[at - 1]) : null;
  const after = at < others.length ? rankOf(next, others[at]) : null;
  setRank(next, card, rankBetween(before, after));
  return next;
}

/** The board once `from` is renamed `to` in the folder: its card keeps its
 *  record. */
export function renameCard(board: Board, from: string, to: string): Board {
  const key = cardKey(board, from);
  if (key === null) return board;
  const next = copyBoard(board);
  const card = next.cards[key];
  delete next.cards[key];
  const clash = cardKey(next, to);
  if (clash !== null) delete next.cards[clash];
  next.cards[to] = card;
  return next;
}

/** The board without the cards whose file isn't in the folder any more:
 *  `names` is every file directly in it. Every write prunes. */
export function pruneBoard(board: Board, names: string[]): Board {
  const here = new Set(names.map((n) => n.toLowerCase()));
  const next = copyBoard(board);
  for (const key of Object.keys(next.cards)) if (!here.has(key.toLowerCase())) delete next.cards[key];
  return next;
}

/** The board grouped by `tag` instead: ranks stay. */
export const regroup = (board: Board, tag: string): Board => ({ ...copyBoard(board), tag });
