// Persisted table column widths: the mapping between a ProseMirror document
// and the `tcols` records in the entity meta file (see metaFile.ts).
//
// WHY THERE IS NO ANCHOR IN THE PROSE
//
// Comment threads keep an anchor in the markdown (`{==text==}{>>#id<<}`)
// because losing a conversation is unacceptable, so they pay for absolute
// identity with a visible marker. A column width is a view preference: worth
// remembering across restarts, not worth writing invisible bookkeeping into
// a file the user also opens in vim and commits to git. So identity here is
// CONTENT-ADDRESSED — a table is recognized by its own shape:
//
//     id = deriveId(<column count> + <header row texts>, <nth such table>)
//
// The consequences are deliberate:
//   • Editing body cells, adding/removing/reordering rows, moving the table
//     to another part of the document, renaming the file — all keep widths.
//   • Renaming a header or adding a column while the document is OPEN keeps
//     them too: the editor rewrites the whole record set on every change, so
//     the record simply moves to the new id with the same widths.
//   • The same edit made OUTSIDE the app (another editor, a sync merge)
//     strips the widths: the old id matches nothing and the table renders at
//     auto width. That is the whole failure mode — local, silent, one table,
//     and repaired by dragging a border again.
//   • Two identical tables in one document are told apart by occurrence
//     index among tables with the SAME signature, so an unrelated table
//     added earlier in the document doesn't shift them.
//
// Widths are absolute px, as prosemirror-tables produces them. Fractions
// would travel better between window sizes, but the plugin is px-native and
// converting in both directions accumulates drift on every drag; a table
// that ends up wider than its pane scrolls inside `.table-wrapper` rather
// than breaking the layout.

import type { Node } from "@milkdown/kit/prose/model";
import { Transform } from "@milkdown/kit/prose/transform";
import { TableMap } from "@milkdown/kit/prose/tables";
import { deriveId, type TableCols } from "./metaFile";

export type { TableCols };

// Visit every table in the document, in document order. Descends into block
// containers (blockquotes, list items) but stops at textblocks — a paragraph
// can't hold a table, and skipping their inline content keeps this walk
// proportional to the block count rather than the text length.
function forEachTable(doc: Node, fn: (table: Node, pos: number) => void): void {
  doc.descendants((node, pos) => {
    if (node.type.name === "table") {
      fn(node, pos);
      return false;
    }
    return node.isBlock && !node.isTextblock;
  });
}

// What makes a table recognizable across sessions: how many columns it has
// and what its header row says. Whitespace is normalized so a reflow of the
// markdown source doesn't count as a change.
//
// Header text is compared as PLAIN TEXT: `| **Q3** |` and `| Q3 |` are the
// same header, which is also what lets the worker's mirror (which sees
// marked's tokens, not ProseMirror's) reach the same answer.
export const normalizeHeaderText = (s: string): string => s.replace(/\s+/g, " ").trim();

/** THE definition of a table's identity, expressed as a function of plain
 *  data because it has a second implementation: the cloud worker's public
 *  page re-derives it from marked's table tokens to attach stored widths to
 *  server-rendered HTML (cloud-worker/src/render.ts). The two must agree —
 *  cloud-worker/test/run.mjs asserts it against the ids this function's
 *  own suite pins, so a change here fails there instead of silently
 *  dropping widths from published pages. Joined by a separator no normalized header text can
 *  contain, so ["ab","c"] and ["a","bc"] stay distinct. */
export function tableSignature(colCount: number, headerTexts: string[]): string {
  return [String(colCount), ...headerTexts.map(normalizeHeaderText)].join("\n");
}

function signatureOfTable(table: Node, map: TableMap): string {
  const header: string[] = [];
  table.firstChild?.forEach((cell) => {
    header.push(cell.textContent);
  });
  return tableSignature(map.width, header);
}

// Per-column widths as the document currently holds them. prosemirror-tables
// stores `colwidth` per CELL (an array of length colspan), so a column's
// width is read from the first cell that declares one — preferring the
// simple case, but a spanning cell's slot counts too.
function columnWidths(table: Node, map: TableMap): number[] {
  const cols = new Array<number>(map.width).fill(0);
  for (let col = 0; col < map.width; col++) {
    for (let row = 0; row < map.height; row++) {
      const pos = map.map[row * map.width + col];
      const cell = table.nodeAt(pos);
      const colwidth = cell?.attrs.colwidth as number[] | null | undefined;
      if (!colwidth) continue;
      const index = cell!.attrs.colspan === 1 ? 0 : col - map.colCount(pos);
      const w = colwidth[index];
      if (typeof w === "number" && w > 0) {
        cols[col] = Math.round(w);
        break;
      }
    }
  }
  return cols;
}

/** Every table's persisted identity and widths, in document order. Tables
 *  nobody has resized produce no record — an untouched document keeps its
 *  meta file untouched (and un-created). */
export function readTableWidths(doc: Node): TableCols[] {
  const out: TableCols[] = [];
  const seenSignature = new Map<string, number>();
  const seenId = new Set<string>();
  forEachTable(doc, (table) => {
    const map = TableMap.get(table);
    const signature = signatureOfTable(table, map);
    const nth = seenSignature.get(signature) ?? 0;
    seenSignature.set(signature, nth + 1);
    const cols = columnWidths(table, map);
    if (!cols.some((w) => w > 0)) return;
    const id = deriveId(signature, nth);
    if (seenId.has(id)) return; // hash collision: first table wins, as on parse
    seenId.add(id);
    out.push({ id, cols });
  });
  return out;
}

/** The document with stored widths written onto its cells' `colwidth` attrs.
 *  Returns the input unchanged when nothing matches, so the common case (no
 *  records, or a document whose tables all moved on) costs one walk and no
 *  allocation. Applied to the PARSED doc before the editor state is created
 *  — no transaction, no history entry, no re-serialization, no flash. */
export function applyTableWidths(doc: Node, records: TableCols[]): Node {
  if (records.length === 0) return doc;
  const byId = new Map(records.map((r) => [r.id, r.cols]));
  const tr = new Transform(doc);
  const seenSignature = new Map<string, number>();
  // Positions are read from the ORIGINAL doc throughout: setNodeMarkup
  // replaces a node with one of identical content size, so no position
  // before or after it moves (the same reason prosemirror-tables' own
  // commit can batch a column's cells in one transaction).
  forEachTable(doc, (table, pos) => {
    const map = TableMap.get(table);
    const signature = signatureOfTable(table, map);
    const nth = seenSignature.get(signature) ?? 0;
    seenSignature.set(signature, nth + 1);
    const cols = byId.get(deriveId(signature, nth));
    if (!cols) return;
    // Collect first, write once per cell: a cell spanning two columns is
    // visited twice, and re-reading its attrs from `table` in between would
    // read the pre-transform node and drop the earlier column's width.
    const pending = new Map<number, { cell: Node; colwidth: number[] }>();
    for (let col = 0; col < map.width; col++) {
      const width = cols[col];
      if (!width || width <= 0) continue;
      for (let row = 0; row < map.height; row++) {
        const mapIndex = row * map.width + col;
        // A rowspanning cell is the same node in several rows; write once.
        if (row && map.map[mapIndex] === map.map[mapIndex - map.width]) continue;
        const cellPos = map.map[mapIndex];
        const cell = table.nodeAt(cellPos);
        if (!cell) continue;
        let entry = pending.get(cellPos);
        if (!entry) {
          const existing = cell.attrs.colwidth as number[] | null | undefined;
          entry = {
            cell,
            colwidth: existing
              ? existing.slice()
              : (new Array<number>(cell.attrs.colspan).fill(0) as number[]),
          };
          pending.set(cellPos, entry);
        }
        const index = cell.attrs.colspan === 1 ? 0 : col - map.colCount(cellPos);
        entry.colwidth[index] = width;
      }
    }
    const start = pos + 1; // the table's content start
    for (const [cellPos, { cell, colwidth }] of pending) {
      const existing = cell.attrs.colwidth as number[] | null | undefined;
      if (existing && existing.every((w, i) => w === colwidth[i])) continue;
      tr.setNodeMarkup(start + cellPos, null, { ...cell.attrs, colwidth });
    }
  });
  return tr.doc;
}

/** Stable comparison key for a record set — the change detector for both the
 *  editor's emitter and the host's write scheduler. */
export const tableWidthsKey = (records: TableCols[]): string =>
  records.map((r) => `${r.id}:${r.cols.join(",")}`).join("|");
