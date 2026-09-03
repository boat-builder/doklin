// A store inside a note: an embed fence, as a ProseMirror node.
//
//   ```kanban
//   store: ./Projects
//   ```
//
// One node type serves every view kind; the fence's LANGUAGE (` ```kanban `,
// ` ```table `) rides along as an attribute, so the block round-trips into
// the same language it was written in.
//
// Unlike a mermaid diagram this does NOT ride Crepe's code-block preview hook.
// That hook hands the block sanitized `innerHTML` — right for an SVG, wrong
// for a board with drag-and-drop, text inputs and popovers. So the fence gets
// its own node instead, in three pieces:
//
//   - a $remark transform retypes the `code` mdast node whose lang is one of
//     the embed languages into a `storeEmbed` node at parse time, and writes
//     it back as the same fence at serialize time. The code-block schema therefore never
//     sees it, and a note carrying an embed round-trips byte for byte — which
//     is the property the whole feature is judged on, because every autosave
//     re-serializes the document;
//   - a $nodeSchema for an ATOM block node whose attributes are the fence's
//     raw config text and its language. An atom has no editable content, so the document's
//     text and the board's state can never be confused for one another;
//   - a $view node view mounting the React frame (StoreEmbed.tsx) inside a
//     contenteditable=false element that answers stopEvent() true for
//     everything inside it and ignoreMutation() always. ProseMirror then
//     neither eats the board's pointer events nor tries to re-parse the DOM
//     React owns.
//
// The config dialect and the fence text itself are pure and live in
// store/embedConfig.ts, so they can be tested without an editor.

import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { $nodeSchema, $remark, $view } from "@milkdown/kit/utils";
import type { Ctx } from "@milkdown/kit/ctx";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { EditorView, NodeView } from "@milkdown/kit/prose/view";
import { NodeSelection } from "@milkdown/kit/prose/state";
import { commandsCtx, editorViewCtx } from "@milkdown/kit/core";
import { clearTextInCurrentBlockCommand } from "@milkdown/kit/preset/commonmark";
import StoreEmbedFrame, { type StoreEmbedHost } from "./StoreEmbed";
import { embedKind, fenceEmbed, KANBAN_LANG } from "./store/embedConfig";
import type { ViewKind } from "./store/storeFile";

export type { StoreEmbedHost };
export { KANBAN_LANG };

/** The mdast node type the fence becomes between remark and the schema. */
const MDAST_TYPE = "storeEmbed";

const asKind = (v: unknown): ViewKind => (v === "table" ? "table" : "kanban");

/* ---------- the schema ---------- */

export const storeEmbedSchema = $nodeSchema("kanban_embed", () => ({
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  isolating: true,
  attrs: {
    config: { default: "", validate: "string" },
    kind: { default: "kanban", validate: "string" },
  },
  parseDOM: [
    {
      tag: "div[data-dk-kanban]",
      getAttrs: (dom: HTMLElement) => ({
        config: dom.getAttribute("data-dk-config") ?? "",
        kind: asKind(dom.getAttribute("data-dk-kind")),
      }),
    },
  ],
  // Also the copy/paste carrier: the config rides the element, so an embed
  // pasted into another note is the same embed and not an empty box.
  toDOM: (node: ProseNode) => [
    "div",
    {
      "data-dk-kanban": "",
      "data-dk-config": String(node.attrs.config ?? ""),
      "data-dk-kind": asKind(node.attrs.kind),
      class: "dk-embed",
    },
  ],
  parseMarkdown: {
    match: (node: { type: string }) => node.type === MDAST_TYPE,
    runner: (state: any, node: any, type: any) => {
      state.addNode(type, {
        config: typeof node.value === "string" ? node.value : "",
        kind: asKind(node.kind),
      });
    },
  },
  toMarkdown: {
    match: (node: ProseNode) => node.type.name === "kanban_embed",
    runner: (state: any, node: ProseNode) => {
      state.addNode(MDAST_TYPE, undefined, String(node.attrs.config ?? ""), {
        kind: asKind(node.attrs.kind),
      });
    },
  },
}));

/* ---------- the markdown round trip ---------- */

// Retype every embed fence in the tree. Recursive because an embed is legal
// wherever a code block is — inside a list item, inside a quote. The
// language becomes the node's kind, so serializing writes the same fence.
function claimStoreFences(node: any): void {
  if (!node || !Array.isArray(node.children)) return;
  for (const child of node.children) {
    const kind = child?.type === "code" ? embedKind(child.lang, child.meta) : null;
    if (kind) {
      child.type = MDAST_TYPE;
      child.kind = kind;
    } else {
      claimStoreFences(child);
    }
  }
}

// Must be a normal `function` (not an arrow) so `this` is the unified
// processor — same shape as criticRemark.
export const storeEmbedRemark = $remark("storeEmbed", () => {
  return function (this: any) {
    const data = this.data();
    const toMarkdownExtensions =
      data.toMarkdownExtensions || (data.toMarkdownExtensions = []);
    toMarkdownExtensions.push({
      handlers: {
        [MDAST_TYPE](node: any) {
          return fenceEmbed(asKind(node.kind), typeof node.value === "string" ? node.value : "");
        },
      },
    });
    return (tree: any) => {
      claimStoreFences(tree);
    };
  };
});

/* ---------- the node view ---------- */

// Live frames, so a host change (a split pane promoted from read-only to
// live) can redraw the boards already on screen. Node views get no props;
// this is how they hear about the world outside the document.
const liveViews = new Set<StoreEmbedNodeView>();

/** Redraw every mounted embed — call when the host or read-only state moves. */
export function refreshStoreEmbeds(): void {
  for (const v of liveViews) v.redraw();
}

class StoreEmbedNodeView implements NodeView {
  dom: HTMLElement;
  private root: Root;
  private node: ProseNode;
  private view: EditorView;
  private getPos: () => number | undefined;
  private host: () => StoreEmbedHost | null;
  private readOnly: () => boolean;
  private selected = false;

  constructor(
    node: ProseNode,
    view: EditorView,
    getPos: () => number | undefined,
    host: () => StoreEmbedHost | null,
    readOnly: () => boolean,
  ) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.host = host;
    this.readOnly = readOnly;
    this.dom = document.createElement("div");
    this.dom.className = "dk-embed";
    this.dom.setAttribute("data-dk-kanban", "");
    this.dom.contentEditable = "false";
    // ProseMirror marks a draggable node's DOM `draggable=true`, so the
    // browser will start a NATIVE drag from anywhere inside the frame — and a
    // native drag swallows the pointer events the board's own drag is built
    // on. (That interception is exactly why the sidebar's row drag and the
    // tab reorder are pointer-based in the first place.) The bar is the
    // block's handle, so a drag starting there is allowed through to
    // ProseMirror and moves the whole embed; anywhere else belongs to the
    // board.
    this.dom.addEventListener("dragstart", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".dk-embed-bar")) return;
      event.preventDefault();
      event.stopPropagation();
    });
    this.root = createRoot(this.dom);
    liveViews.add(this);
    this.redraw();
  }

  redraw(): void {
    // The element carries its config the way toDOM does, so the DOM is
    // self-describing (and a copy taken from it isn't an empty box).
    this.dom.setAttribute("data-dk-config", String(this.node.attrs.config ?? ""));
    this.dom.setAttribute("data-dk-kind", asKind(this.node.attrs.kind));
    this.root.render(
      createElement(StoreEmbedFrame, {
        config: String(this.node.attrs.config ?? ""),
        kind: asKind(this.node.attrs.kind),
        getHost: this.host,
        readOnly: this.readOnly() || !this.view.editable,
        selected: this.selected,
        onConfigChange: (next: string) => this.writeConfig(next),
      }),
    );
  }

  // The fence's text is document content, so changing it is one ordinary
  // transaction — undoable with ⌘Z, and saved by the same autosave as a
  // typed word.
  private writeConfig(next: string): void {
    const pos = this.getPos();
    if (pos === undefined) return;
    if (next === this.node.attrs.config) return;
    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(pos, undefined, {
        config: next,
        kind: asKind(this.node.attrs.kind),
      }),
    );
  }

  update(node: ProseNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.redraw();
    return true;
  }

  selectNode(): void {
    this.selected = true;
    this.dom.classList.add("is-selected");
    this.redraw();
  }

  deselectNode(): void {
    this.selected = false;
    this.dom.classList.remove("is-selected");
    this.redraw();
  }

  // Everything inside the frame belongs to the board: a card title typed into
  // a composer must never reach the document. The one exception is the frame's
  // bar, which acts as the block's handle — a click there selects the node so
  // ⌫ deletes the embed.
  stopEvent(event: Event): boolean {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(".dk-embed-bar") && !target.closest("button")) return false;
    return true;
  }

  // React owns this subtree; ProseMirror must never read it back as content.
  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    liveViews.delete(this);
    const root = this.root;
    // Unmounting synchronously here can land inside a React commit (the
    // editor itself is a React tree tearing down); defer one microtask.
    queueMicrotask(() => root.unmount());
  }
}

/**
 * The node view, bound to its host. Every argument is a getter so a pane
 * that is promoted from read-only to live picks it up without remounting the
 * editor (see refreshStoreEmbeds).
 */
export function storeEmbedView(
  host: () => StoreEmbedHost | null,
  readOnly: () => boolean = () => false,
) {
  return $view(
    storeEmbedSchema.node,
    () => (node: ProseNode, view: EditorView, getPos: () => number | undefined) =>
      new StoreEmbedNodeView(node, view, getPos, host, readOnly),
  );
}

/* ---------- inserting one ---------- */

/**
 * The slash menu's Board and Table items. Inserts an embed with an EMPTY
 * config — the frame then asks which store, which is a question better
 * answered in place than in a modal.
 */
export function insertStoreEmbed(ctx: Ctx, kind: ViewKind = "kanban"): void {
  // Clear the "/board" the user typed, the way the Diagram item does.
  ctx.get(commandsCtx).call(clearTextInCurrentBlockCommand.key);
  const view = ctx.get(editorViewCtx);
  const type = storeEmbedSchema.type(ctx);
  const { state } = view;
  const { $from } = state.selection;
  const tr = state.tr;
  const node = type.create({ config: "", kind });
  // An atom can't be "set" as a block type: replace the (now empty) paragraph
  // the slash was typed in, or the selection when it isn't one.
  if ($from.depth > 0 && $from.parent.isTextblock && $from.parent.content.size === 0) {
    const from = $from.before($from.depth);
    tr.replaceWith(from, $from.after($from.depth), node);
    tr.setSelection(NodeSelection.create(tr.doc, from));
  } else {
    tr.replaceSelectionWith(node);
  }
  view.dispatch(tr.scrollIntoView());
}
