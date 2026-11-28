// What a browser does when a document it is saving was changed somewhere
// else first: what the engine does on a Mac (engine/src/cloud/merge.rs —
// change both). The two changes are merged against the text both started
// from, line by line, and when they overlap nothing is merged at all: the
// other version is kept beside the document as a conflict copy, named as the
// engine names one. Pure functions; nothing here reads or writes.
//
// A sidecar is merged by its records instead of its lines: it is a list of
// threads, and two replies to one thread are both kept where a line merge
// would call them an overlap. So is a folder's `boards.json`: its conflict
// copy would be a name that doesn't sync.

import { canonicalJson, newBoard, parseBoards, serializeBoards, type Board } from "../boards";
import { mergeHtmlThreads, type HtmlThread } from "../htmlComments";
import { parseEntityMeta, serializeEntityMeta, type LinkRecord, type MdThread } from "../metaFile";

/* ---------- Text ---------- */

/** Past this many changed lines between two versions no merge is tried: the
 *  search keeps a table that grows with their square. */
const MAX_EDITS = 3000;

/** A text as its lines, each with the line ending it has. */
const linesOf = (text: string): string[] => (text === "" ? [] : text.split(/(?<=\n)/));

/** The base's lines a side replaced: `len` of them from `at`, by `lines`. */
type Hunk = { at: number; len: number; lines: string[] };

/**
 * How one side differs from the base, as the runs of lines it replaced, in
 * order; null when the two are too far apart to compare (`MAX_EDITS`). The
 * shortest edit script, found the way Myers finds it: for each number of
 * edits, how far along every diagonal a path can get.
 */
function hunksOf(base: string[], side: string[]): Hunk[] | null {
  let head = 0;
  while (head < base.length && head < side.length && base[head] === side[head]) head += 1;
  let tail = 0;
  while (tail < base.length - head && tail < side.length - head && base[base.length - 1 - tail] === side[side.length - 1 - tail]) tail += 1;
  const a = base.slice(head, base.length - tail);
  const b = side.slice(head, side.length - tail);
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];

  const reach: Int32Array[] = [];
  let found = -1;
  // `v[k + d]` is the furthest x on diagonal k (x - y) after d edits.
  let v = new Int32Array(1);
  for (let d = 0; d <= n + m && found < 0; d += 1) {
    if (d > MAX_EDITS) return null;
    const next = new Int32Array(2 * d + 1);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (d === 0) x = 0;
      else if (k === -d || (k !== d && v[k - 1 + d - 1] < v[k + 1 + d - 1])) x = v[k + 1 + d - 1];
      else x = v[k - 1 + d - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      next[k + d] = x;
      if (x >= n && y >= m) found = d;
    }
    reach.push(next);
    v = next;
  }

  // Back along the path, collecting every edit: a base line dropped, or a
  // side line put in, at a place in the base.
  const edits: { at: number; drop: boolean; line: string }[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const prev = reach[d - 1];
    const k = x - y;
    const down = k === -d || (k !== d && prev[k - 1 + d - 1] < prev[k + 1 + d - 1]);
    const fromK = down ? k + 1 : k - 1;
    const fromX = prev[fromK + d - 1];
    const fromY = fromX - fromK;
    if (down) edits.push({ at: fromX, drop: false, line: b[fromY] });
    else edits.push({ at: fromX, drop: true, line: a[fromX] });
    x = fromX;
    y = fromY;
  }
  edits.reverse();

  const hunks: Hunk[] = [];
  for (const e of edits) {
    let hunk = hunks[hunks.length - 1];
    if (!hunk || hunk.at + hunk.len !== e.at) {
      hunk = { at: e.at, len: 0, lines: [] };
      hunks.push(hunk);
    }
    if (e.drop) hunk.len += 1;
    else hunk.lines.push(e.line);
  }
  for (const h of hunks) h.at += head;
  return hunks;
}

/** The base's lines from `start` to `end` as one side left them. */
function applied(base: string[], start: number, end: number, hunks: Hunk[]): string[] {
  const out: string[] = [];
  let pos = start;
  for (const h of hunks) {
    out.push(...base.slice(pos, h.at), ...h.lines);
    pos = h.at + h.len;
  }
  out.push(...base.slice(pos, end));
  return out;
}

/**
 * Both changes in one text, or null when they overlap: each changed a line
 * the other changed too, or lines that touch. The same change made on both
 * sides is no overlap.
 */
export function mergeText(base: string, ours: string, theirs: string): string | null {
  if (ours === theirs || theirs === base) return ours;
  if (ours === base) return theirs;
  const lines = linesOf(base);
  const mine = hunksOf(lines, linesOf(ours));
  const other = hunksOf(lines, linesOf(theirs));
  if (!mine || !other) return null;
  const all = [...mine.map((h) => ({ h, mine: true })), ...other.map((h) => ({ h, mine: false }))].sort((p, q) => p.h.at - q.h.at);

  const out: string[] = [];
  let pos = 0;
  for (let i = 0; i < all.length; ) {
    const start = all[i].h.at;
    let end = start + all[i].h.len;
    const group = [all[i]];
    i += 1;
    // Everything that reaches into this run of the base, or touches its end.
    while (i < all.length && all[i].h.at <= end) {
      end = Math.max(end, all[i].h.at + all[i].h.len);
      group.push(all[i]);
      i += 1;
    }
    out.push(...lines.slice(pos, start));
    const a = applied(lines, start, end, group.filter((g) => g.mine).map((g) => g.h));
    const b = applied(lines, start, end, group.filter((g) => !g.mine).map((g) => g.h));
    if (group.every((g) => g.mine)) out.push(...a);
    else if (group.every((g) => !g.mine)) out.push(...b);
    else if (a.length === b.length && a.every((line, n) => line === b[n])) out.push(...a);
    else return null;
    pos = end;
  }
  out.push(...lines.slice(pos));
  return out.join("");
}

/* ---------- The sidecar ---------- */

/** Records known by a key, merged three ways: one changed on one side only
 *  is that side's, one changed on both is ours, and a deletion sticks unless
 *  the other side changed what was deleted. */
function mergeKeyed<T>(base: T[], ours: T[], theirs: T[], key: (t: T) => string): T[] {
  const same = (a: T, b: T) => JSON.stringify(a) === JSON.stringify(b);
  const was = new Map(base.map((t) => [key(t), t]));
  const mine = new Map(ours.map((t) => [key(t), t]));
  const other = new Map(theirs.map((t) => [key(t), t]));
  const out: T[] = [];
  for (const t of ours) {
    const b = was.get(key(t));
    const o = other.get(key(t));
    if (o !== undefined) out.push(b !== undefined && same(b, t) ? o : t);
    else if (b === undefined || !same(b, t)) out.push(t);
  }
  for (const t of theirs) {
    const b = was.get(key(t));
    if (!mine.has(key(t)) && (b === undefined || !same(b, t))) out.push(t);
  }
  return out;
}

/** Links, three ways, as whole records by their destination. When both
 *  sides changed one destination to two different files, which only a path
 *  reused between two saves does, the one whose file `exists` is kept, else
 *  the lowest id: every device merging the two keeps the same one. */
function mergeLinks(base: LinkRecord[], ours: LinkRecord[], theirs: LinkRecord[], exists: (file: string) => boolean): LinkRecord[] {
  const was = new Map(base.map((l) => [l.id, l]));
  const other = new Map(theirs.map((l) => [l.id, l]));
  return mergeKeyed(base, ours, theirs, (l) => l.id).map((l) => {
    const o = other.get(l.id);
    if (o === undefined || o.file === l.file || was.get(l.id)?.file === o.file) return l;
    if (exists(l.file) !== exists(o.file)) return exists(l.file) ? l : o;
    return l.file < o.file ? l : o;
  });
}

const NO_ANCHOR = { path: "", tag: "", text: "" };
const anchored = (threads: MdThread[]): HtmlThread[] => threads.map((t) => ({ ...t, anchor: NO_ANCHOR }));

/**
 * Two versions of a document's sidecar in one, against the one both started
 * from (null: it had none). Threads fold as the open document's do when a
 * change arrives (`mergeHtmlThreads`): a reply on either side is kept, and a
 * deletion sticks. `exists` says whether a file id is one of the
 * workspace's, in any section (`mergeLinks`).
 */
export function mergeMeta(base: string | null, ours: string, theirs: string, exists: (file: string) => boolean): string {
  if (ours === theirs) return ours;
  const b = parseEntityMeta(base ?? "");
  const o = parseEntityMeta(ours);
  const t = parseEntityMeta(theirs);
  return serializeEntityMeta({
    hthreads: mergeHtmlThreads(b.hthreads, o.hthreads, t.hthreads),
    mthreads: mergeHtmlThreads(anchored(b.mthreads), anchored(o.mthreads), anchored(t.mthreads)).map(({ id, comments }) => ({ id, comments })),
    tcols: mergeKeyed(b.tcols, o.tcols, t.tcols, (c) => c.id),
    links: mergeLinks(b.links, o.links, t.links, exists),
    foreign: mergeKeyed(b.foreign, o.foreign, t.foreign, (f) => f.raw),
  });
}

/* ---------- A board ---------- */

/** A board's records: `tag`, each key a newer app wrote, and each card
 *  (keyed by its name whatever its case). `text` is the record as
 *  canonical JSON: what two sides compare, and what the board is built
 *  back from. */
type BoardRecord = { key: string; text: string };

function boardRecords(board: Board): BoardRecord[] {
  return [
    { key: "tag", text: canonicalJson(board.tag) },
    ...Object.entries(board.extra).map(([k, v]) => ({ key: `extra:${k}`, text: canonicalJson([k, v]) })),
    ...Object.entries(board.cards).map(([name, c]) => ({
      key: `card:${name.toLowerCase()}`,
      text: canonicalJson([name, c.rank, c.extra]),
    })),
  ];
}

function fromRecords(records: BoardRecord[]): Board {
  const board = newBoard("");
  for (const r of records) {
    const v = JSON.parse(r.text) as unknown;
    if (r.key === "tag") board.tag = v as string;
    else if (r.key.startsWith("extra:")) {
      const [k, value] = v as [string, unknown];
      board.extra[k] = value;
    } else {
      const [name, rank, extra] = v as [string, string | null, Record<string, unknown>];
      board.cards[name] = { rank, extra };
    }
  }
  return board;
}

/**
 * Two versions of a folder's `boards.json` in one, against the one both
 * started from (null: there was none), by its records as a sidecar is: a
 * record changed on one side is that side's, one changed on both is ours,
 * and a deletion sticks unless the other side changed what was deleted.
 * Never a conflict. When either side isn't a board this app reads (a newer
 * app's, or not one at all), theirs is kept as it is: the app never
 * rewrites a file it can't read. The engine merges alike
 * (`engine/src/boards.rs`): change both; `verify-harness/boards-fixture.json`
 * holds the two to one answer.
 */
export function mergeBoards(base: string | null, ours: string, theirs: string): string {
  if (ours === theirs) return ours;
  const o = parseBoards(ours);
  const t = parseBoards(theirs);
  if (o === null || o === "newer" || t === null || t === "newer") return theirs;
  const read = base === null ? null : parseBoards(base);
  const b = read === null || read === "newer" ? newBoard("") : read;
  const sameKey = (r: BoardRecord) => r.key;
  return serializeBoards(fromRecords(mergeKeyed(boardRecords(b), boardRecords(o), boardRecords(t), sameKey)));
}

/* ---------- Conflict copies ---------- */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number): string => String(n).padStart(2, "0");

/**
 * The names a conflict copy of `name` may take, in the order to try them:
 * "Meeting notes.md" and Alice give "Meeting notes (conflict — Alice, Jul 11
 * 14.32).md", then the same with " 2" after the time, and so on
 * (`conflict_copy_path`, merge.rs). `who` is whoever wrote the other version.
 */
export function conflictCopyNames(name: string, who: string, now = new Date()): string[] {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const by = [...(who || "someone")].slice(0, 40).join("").replace(/[/:\\\0]/g, "-");
  const when = `${MONTHS[now.getMonth()]} ${now.getDate()} ${two(now.getHours())}.${two(now.getMinutes())}`;
  const names: string[] = [];
  for (let n = 0; n < 100; n += 1) names.push(`${stem} (conflict — ${by}, ${when}${n === 0 ? "" : ` ${n + 1}`})${ext}`);
  names.push(`${stem} (conflict ${now.getTime()})${ext}`);
  return names;
}
