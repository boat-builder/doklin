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
import { Plugin } from "@milkdown/kit/prose/state";
import { $view } from "@milkdown/kit/utils";
import { tableSchema } from "@milkdown/kit/preset/gfm";
import {
  TableMap,
  cellAround,
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

// ---------- Read-only views ----------
// prosemirror-tables gates every columnResizing interaction on view.editable,
// but the same editor mounts read-only on shared pages (comment-role web
// sessions) and column widths are a viewing concern: the commit only touches
// colwidth attrs, which never reach the serialized markdown, so both hosts'
// "did the markdown change" save guards see nothing. This companion plugin
// replays the stock plugin's mousemove/mousedown/mouseleave behavior when the
// view is NOT editable, dispatching through the same plugin key so the stock
// plugin's state, handle decorations, and resize-cursor styling render the
// interaction. On editable views it defers entirely to the stock plugin.
// The helpers mirror prosemirror-tables' un-exported internals.

const HANDLE_WIDTH = 5; // px within a border that activates the handle
const CELL_MIN_WIDTH = 25; // px floor while dragging

function domCellAround(target: EventTarget | null): HTMLElement | null {
  let el = target instanceof HTMLElement ? target : null;
  while (el && el.nodeName !== "TD" && el.nodeName !== "TH")
    el = el.classList.contains("ProseMirror") ? null : el.parentElement;
  return el;
}

function edgeCell(
  view: EditorView,
  event: MouseEvent,
  side: "left" | "right"
): number {
  const offset = side === "right" ? -HANDLE_WIDTH : HANDLE_WIDTH;
  const found = view.posAtCoords({
    left: event.clientX + offset,
    top: event.clientY,
  });
  if (!found) return -1;
  const $cell = cellAround(view.state.doc.resolve(found.pos));
  if (!$cell) return -1;
  if (side === "right") return $cell.pos;
  const map = TableMap.get($cell.node(-1));
  const start = $cell.start(-1);
  const index = map.map.indexOf($cell.pos - start);
  return index % map.width === 0 ? -1 : start + map.map[index - 1];
}

function currentColWidth(view: EditorView, cellPos: number): number {
  const { colspan, colwidth } = view.state.doc.nodeAt(cellPos)!.attrs;
  const width = colwidth && colwidth[colwidth.length - 1];
  if (width) return width;
  // No stored width: measure the rendered cell and split across its span.
  const dom = view.domAtPos(cellPos);
  const node = dom.node.childNodes[dom.offset] as HTMLElement;
  let domWidth = node.offsetWidth;
  let parts = colspan;
  if (colwidth)
    for (let i = 0; i < colspan; i++)
      if (colwidth[i]) {
        domWidth -= colwidth[i];
        parts--;
      }
  return domWidth / parts;
}

function displayColumnWidth(
  view: EditorView,
  cellPos: number,
  width: number
): void {
  const $cell = view.state.doc.resolve(cellPos);
  const table = $cell.node(-1);
  const start = $cell.start(-1);
  const col =
    TableMap.get(table).colCount($cell.pos - start) +
    $cell.nodeAfter!.attrs.colspan -
    1;
  let dom: globalThis.Node | null = view.domAtPos(start).node;
  while (dom && dom.nodeName !== "TABLE") dom = dom.parentNode;
  if (!dom) return;
  updateColumnsOnResize(
    table,
    (dom as HTMLTableElement).firstChild as HTMLTableColElement,
    dom as HTMLTableElement,
    DEFAULT_CELL_MIN_WIDTH,
    col,
    width
  );
}

function commitColumnWidth(
  view: EditorView,
  cellPos: number,
  width: number
): void {
  const $cell = view.state.doc.resolve(cellPos);
  const table = $cell.node(-1);
  const map = TableMap.get(table);
  const start = $cell.start(-1);
  const col =
    map.colCount($cell.pos - start) + $cell.nodeAfter!.attrs.colspan - 1;
  const tr = view.state.tr;
  for (let row = 0; row < map.height; row++) {
    const mapIndex = row * map.width + col;
    // Rowspanning cells only get the attr once.
    if (row && map.map[mapIndex] === map.map[mapIndex - map.width]) continue;
    const pos = map.map[mapIndex];
    const attrs = table.nodeAt(pos)!.attrs;
    const index = attrs.colspan === 1 ? 0 : col - map.colCount(pos);
    if (attrs.colwidth && attrs.colwidth[index] === width) continue;
    const colwidth = attrs.colwidth
      ? attrs.colwidth.slice()
      : (Array(attrs.colspan).fill(0) as number[]);
    colwidth[index] = width;
    tr.setNodeMarkup(start + pos, null, { ...attrs, colwidth });
  }
  if (tr.docChanged) view.dispatch(tr);
}

function readOnlyColumnResizing(): Plugin {
  return new Plugin({
    props: {
      handleDOMEvents: {
        mousemove: (view, event) => {
          if (view.editable) return;
          const state = columnResizingPluginKey.getState(view.state);
          if (!state || state.dragging) return;
          const target = domCellAround(event.target);
          let cell = -1;
          if (target) {
            const { left, right } = target.getBoundingClientRect();
            if (event.clientX - left <= HANDLE_WIDTH)
              cell = edgeCell(view, event, "left");
            else if (right - event.clientX <= HANDLE_WIDTH)
              cell = edgeCell(view, event, "right");
          }
          if (cell !== state.activeHandle)
            view.dispatch(
              view.state.tr.setMeta(columnResizingPluginKey, {
                setHandle: cell,
              })
            );
        },
        mouseleave: (view) => {
          if (view.editable) return;
          const state = columnResizingPluginKey.getState(view.state);
          if (state && state.activeHandle > -1 && !state.dragging)
            view.dispatch(
              view.state.tr.setMeta(columnResizingPluginKey, { setHandle: -1 })
            );
        },
        mousedown: (view, event) => {
          if (view.editable) return false;
          const state = columnResizingPluginKey.getState(view.state);
          if (!state || state.activeHandle === -1 || state.dragging)
            return false;
          const handle = state.activeHandle;
          const startWidth = currentColWidth(view, handle);
          view.dispatch(
            view.state.tr.setMeta(columnResizingPluginKey, {
              setDragging: { startX: event.clientX, startWidth },
            })
          );
          const win = view.dom.ownerDocument.defaultView ?? window;
          const dragged = (e: MouseEvent) =>
            Math.max(CELL_MIN_WIDTH, startWidth + e.clientX - event.clientX);
          const finish = (e: MouseEvent) => {
            win.removeEventListener("mouseup", finish);
            win.removeEventListener("mousemove", move);
            const s = columnResizingPluginKey.getState(view.state);
            if (s?.dragging) {
              commitColumnWidth(view, s.activeHandle, dragged(e));
              view.dispatch(
                view.state.tr.setMeta(columnResizingPluginKey, {
                  setDragging: null,
                })
              );
            }
          };
          const move = (e: MouseEvent) => {
            if (e.buttons === 0) return finish(e);
            const s = columnResizingPluginKey.getState(view.state);
            if (s?.dragging)
              displayColumnWidth(view, s.activeHandle, dragged(e));
          };
          win.addEventListener("mouseup", finish);
          win.addEventListener("mousemove", move);
          displayColumnWidth(view, handle, startWidth);
          event.preventDefault();
          return true;
        },
      },
    },
  });
}

// .config() entry. View: null — the colgroup lives in ResizableTableNodeView,
// so the plugin's own table node view (shadowed anyway) is disabled outright.
export function enableColumnResizing(ctx: Ctx) {
  ctx.update(editorStateOptionsCtx, (prev) => (options) => {
    const opts = prev(options);
    return {
      ...opts,
      plugins: [
        columnResizing({ View: null }),
        readOnlyColumnResizing(),
        ...(opts.plugins ?? []),
      ],
    };
  });
}
