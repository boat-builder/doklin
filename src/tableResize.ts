// Notion-style drag-to-resize for table columns.
//
// Markdown has no syntax for column widths, so widths are session-only by
// design: a drag sets prosemirror-tables' `colwidth` attr on the cells (the
// GFM preset never serializes it) and everything resets when the doc is
// reopened.
//
// Two pieces make prosemirror-tables' columnResizing plugin work under Crepe:
//
// 1. Plugin order. Crepe registers tableEditing(), whose mousedown handler
//    binds cell-drag-selection listeners without claiming the event, so
//    columnResizing must run FIRST: when a drag starts it preventDefault()s
//    the mousedown, which stops the plugin chain before tableEditing turns
//    the same drag into a cell selection. Plugins added with .use() land
//    after Crepe's, so instead we prepend via editorStateOptionsCtx — the
//    hook applied to the final EditorState options.
//
// 2. The node view. Crepe's table block owns the "table" node view. It
//    renders no <colgroup> (columnResizing applies live widths through
//    table.firstChild) and its stopEvent() swallows any mousedown inside a
//    cell to drive its own cell selection — including the one that should
//    start a resize. ResizableTableNodeView subclasses it to maintain a
//    <colgroup> synced from cell attrs and to let pointer events through
//    while a column border is hot. Registering this $view after Crepe's
//    wins: node views are merged with Object.fromEntries, so the last entry
//    for "table" is the one used.

import type { Ctx } from "@milkdown/kit/ctx";
import type { Node } from "@milkdown/kit/prose/model";
import type { EditorView } from "@milkdown/kit/prose/view";
import { editorStateOptionsCtx } from "@milkdown/kit/core";
import { $view } from "@milkdown/kit/utils";
import { tableSchema } from "@milkdown/kit/preset/gfm";
import {
  columnResizing,
  columnResizingPluginKey,
  updateColumnsOnResize,
} from "@milkdown/kit/prose/tables";
import { TableNodeView } from "@milkdown/kit/component/table-block";

// Must match columnResizing()'s defaultCellMinWidth so the widths this node
// view renders agree with the plugin's live-drag feedback.
const DEFAULT_CELL_MIN_WIDTH = 100;

class ResizableTableNodeView extends TableNodeView {
  private colgroup: HTMLTableColElement;
  private table: HTMLTableElement;

  constructor(
    ctx: Ctx,
    node: Node,
    view: EditorView,
    getPos: () => number | undefined
  ) {
    super(ctx, node, view, getPos);
    // Crepe renders <table class="children"> and mounts the tbody contentDOM
    // into it (the drag-preview table has no .children class).
    const table = this.dom.querySelector<HTMLTableElement>("table.children");
    if (!table) throw new Error("table-block did not render its content table");
    this.table = table;
    this.colgroup = document.createElement("colgroup");
    table.insertBefore(this.colgroup, this.contentDOM);
    table.style.setProperty(
      "--default-cell-min-width",
      `${DEFAULT_CELL_MIN_WIDTH}px`
    );
    updateColumnsOnResize(node, this.colgroup, table, DEFAULT_CELL_MIN_WIDTH);
  }

  override update(node: Node): boolean {
    if (node.type !== this.node.type) return false;
    const updated = super.update(node);
    if (updated)
      updateColumnsOnResize(node, this.colgroup, this.table, DEFAULT_CELL_MIN_WIDTH);
    // Crepe returns false for "nothing changed", which ProseMirror reads as
    // "destroy and recreate me". The resize plugin's hover decorations update
    // the view with an UNCHANGED node, so that false would tear down and
    // remount the whole table block (Vue app included) every time the handle
    // highlight flips. An unchanged node is trivially updatable: say so.
    return (
      updated ||
      (node.sameMarkup(this.node) && node.content.eq(this.node.content))
    );
  }

  override stopEvent(e: Event): boolean {
    // While the pointer is over a column border (activeHandle set by the
    // plugin's mousemove) columnResizing owns pointer events; Crepe's handler
    // would otherwise turn the mousedown into a cell selection and the resize
    // drag would never start.
    const resize = columnResizingPluginKey.getState(this.view.state);
    if (resize && resize.activeHandle > -1) return false;
    return super.stopEvent(e);
  }
}

export const resizableTableView = $view(
  tableSchema.node,
  (ctx: Ctx) =>
    (node: Node, view: EditorView, getPos: () => number | undefined) =>
      new ResizableTableNodeView(ctx, node, view, getPos)
);

// .config() entry. View: null — the colgroup lives in ResizableTableNodeView,
// so the plugin's own table node view (shadowed anyway) is disabled outright.
export function enableColumnResizing(ctx: Ctx) {
  ctx.update(editorStateOptionsCtx, (prev) => (options) => {
    const opts = prev(options);
    return {
      ...opts,
      plugins: [columnResizing({ View: null }), ...(opts.plugins ?? [])],
    };
  });
}
