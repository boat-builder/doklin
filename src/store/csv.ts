// A store, as a spreadsheet.
//
// The point of keeping a datastore in plain files is that nothing about it is
// trapped, and "open it in Numbers" is the shape that question usually takes.
// So the export is the view you are looking at, not the folder: the rows the
// filter kept, in the order the sort put them, with the columns the view
// shows — what is on screen is what lands in the file.
//
// RFC 4180, CRLF line endings and all, because that is what every spreadsheet
// reads without being asked twice. Pure string work, unit-tested alongside the
// rest of src/store.

import { propText } from "./frontmatter";
import type { Card } from "./board";
import type { Field } from "./storeFile";

/**
 * One CSV field. Quoted when it has to be — a comma, a quote, a newline, or
 * leading/trailing space, which some readers otherwise eat.
 */
export function csvField(value: string): string {
  const needs = /[",\r\n]/.test(value) || value !== value.trim();
  return needs ? `"${value.replace(/"/g, '""')}"` : value;
}

/** A grid of strings as CSV text. */
export const toCsv = (rows: string[][]): string =>
  rows.map((row) => row.map(csvField).join(",")).join("\r\n") + "\r\n";

/**
 * A view's cards as CSV: the title, then one column per shown field. A
 * multi_select cell holds its values comma-separated inside one quoted
 * field — the shape a spreadsheet can split again if it wants to.
 */
export const storeCsv = (cards: Card[], fields: Field[]): string =>
  toCsv([
    ["Title", ...fields.map((f) => f.name)],
    ...cards.map((c) => [c.title, ...fields.map((f) => propText(c.props[f.id]))]),
  ]);

/** A file name for a store's export: `Projects.csv`, with nothing a path
 *  separator could make of it. */
export const csvFileName = (name: string): string =>
  `${(name.replace(/[/:]/g, "-").trim() || "Store").slice(0, 60)}.csv`;
