// Test entry for tablewidths.test.mjs: re-exports src/tableWidths.ts plus a
// document builder, so the unit test can construct real ProseMirror tables
// without booting Milkdown. The schema mirrors the GFM preset's (see
// @milkdown/preset-gfm's node/table/schema.ts): prosemirror-tables' own
// tableNodes with paragraph cell content, which is what supplies the
// colspan/rowspan/colwidth attrs the module reads and writes.
import { Schema, type Node } from "@milkdown/kit/prose/model";
import { tableNodes } from "@milkdown/kit/prose/tables";

export {
  readTableWidths,
  applyTableWidths,
  tableWidthsKey,
  tableSignature,
} from "../src/tableWidths";
export { deriveId } from "../src/metaFile";

const base = tableNodes({ tableGroup: "block", cellContent: "paragraph", cellAttributes: {} });

export const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block" },
    blockquote: { content: "block+", group: "block" },
    text: { group: "inline" },
    ...base,
  },
});

type CellSpec = {
  text?: string;
  colspan?: number;
  rowspan?: number;
  colwidth?: number[] | null;
};

const cell = (type: string, spec: CellSpec): Node =>
  schema.nodes[type].create(
    {
      colspan: spec.colspan ?? 1,
      rowspan: spec.rowspan ?? 1,
      colwidth: spec.colwidth ?? null,
    },
    schema.nodes.paragraph.create(
      null,
      spec.text ? schema.text(spec.text) : undefined,
    ),
  );

/** A table from a header row of cell specs plus body rows of cell specs. */
export const table = (header: CellSpec[], ...rows: CellSpec[][]): Node =>
  schema.nodes.table.create(null, [
    schema.nodes.table_row.create(null, header.map((c) => cell("table_header", c))),
    ...rows.map((r) => schema.nodes.table_row.create(null, r.map((c) => cell("table_cell", c)))),
  ]);

export const para = (text: string): Node =>
  schema.nodes.paragraph.create(null, schema.text(text));

export const quote = (...content: Node[]): Node =>
  schema.nodes.blockquote.create(null, content);

export const doc = (...content: Node[]): Node => schema.nodes.doc.create(null, content);

/** Every table's per-column colwidth as rendered — the assertion surface for
 *  applyTableWidths (which returns a doc, not a record set). */
export function colwidthsOf(document: Node): (number[] | null)[][] {
  const out: (number[] | null)[][] = [];
  document.descendants((node) => {
    if (node.type.name !== "table") return true;
    const rows: (number[] | null)[][] = [];
    node.forEach((row) => {
      const cells: (number[] | null)[] = [];
      row.forEach((c) => cells.push((c.attrs.colwidth as number[] | null) ?? null));
      rows.push(cells);
    });
    out.push(...rows);
    return false;
  });
  return out;
}
