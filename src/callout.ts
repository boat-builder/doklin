// Callouts in the editor: GitHub's `> [!NOTE]` alerts as a block of their
// own, shared by the Mac and browser editor (Editor.tsx) and the iPhone's
// (ios-editor/main.ts). The kinds, names and icons are calloutTypes.ts's.
//
// On disk a callout is a quote whose first line is the marker:
//
//   > [!WARNING]
//   > Workers Free allows 100,000 requests a day.
//
// Parse: a TOP-LEVEL quote whose first line is a marker becomes a `callout`
// mdast node, and from it the `callout` node here. Only top level, as GitHub
// requires: a marker in a quote inside a list stays that quote's text.
//
// Write: the stringify handler writes the marker line itself, then the body
// as remark writes a quote's. Left to remark, the marker is text and comes
// back escaped (`> \[!WARNING]`), which is what every GitHub alert an agent
// wrote turned into before callouts existed. The marker word is written as
// it was read (`[!note]` stays lowercase); a new callout, or one whose kind
// was changed, writes uppercase. `gap` keeps a blank `>` line between the
// marker and the body when the source had one. Like every serializer here,
// the handler is stateless: Milkdown reuses serializer state and may run a
// node more than once.
//
// The node view draws the title (icon, name, chevron) as a non-editable
// widget beside the body, so find, copy and comments never see "Note". A
// click on the title asks the host for the type picker: a `dk-callout-pick`
// event on the editor's DOM, which Editor.tsx answers with CalloutPicker and
// the iPhone's page with its own.

import { $command, $nodeSchema, $remark, $shortcut, $view } from "@milkdown/kit/utils";
import { commandsCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { clearTextInCurrentBlockCommand } from "@milkdown/kit/preset/commonmark";
import type { Node as ProseNode, NodeType } from "@milkdown/kit/prose/model";
import { Fragment } from "@milkdown/kit/prose/model";
import { TextSelection, type Command, type EditorState } from "@milkdown/kit/prose/state";
import { liftTarget } from "@milkdown/kit/prose/transform";
import type { EditorView, NodeViewConstructor } from "@milkdown/kit/prose/view";
import { CALLOUTS, CALLOUT_KINDS, calloutIconSvg, calloutMarkerLine, parseCalloutMarker, type CalloutKind } from "./calloutTypes";

export const CALLOUT_NODE = "callout";

/** What a title click sends (on the editor's DOM, bubbling). */
export const CALLOUT_PICK_EVENT = "dk-callout-pick";
export type CalloutPickDetail = { pos: number; kind: CalloutKind; anchor: HTMLElement };

const isKind = (v: unknown): v is CalloutKind => (CALLOUT_KINDS as readonly string[]).includes(v as string);

/* ---------- Markdown ---------- */

// Turn top-level quotes that open with a marker into `callout` mdast nodes.
function liftCallouts(tree: any): void {
  if (!tree || !Array.isArray(tree.children)) return;
  for (let i = 0; i < tree.children.length; i++) {
    const quote = tree.children[i];
    if (quote?.type !== "blockquote") continue;
    const first = quote.children?.[0];
    if (first?.type !== "paragraph") continue;
    const lead = first.children?.[0];
    if (lead?.type !== "text" || typeof lead.value !== "string") continue;
    const nl = lead.value.indexOf("\n");
    const head = nl === -1 ? lead.value : lead.value.slice(0, nl);
    const found = parseCalloutMarker(head);
    if (!found) continue;
    let body: any[];
    let gap = false;
    const after = first.children.slice(1);
    if (nl === -1 && after.length === 0) {
      // The marker is a paragraph of its own: the body is what follows,
      // after a blank `>` line (or nothing: an empty callout).
      body = quote.children.slice(1);
      gap = body.length > 0;
    } else if (nl === -1) {
      // Milkdown has already made the marker's line ending a `break` node:
      // the body starts after it. Anything else on the marker's line (a
      // title in bold, a link) is not GitHub's syntax: a quote stays.
      if (after[0]?.type !== "break") continue;
      const runs = after.slice(1);
      body = runs.length ? [{ ...first, children: runs }, ...quote.children.slice(1)] : quote.children.slice(1);
    } else {
      // The body starts on the marker's next line, in the same paragraph.
      const rest = lead.value.slice(nl + 1);
      const runs = rest ? [{ ...lead, value: rest }, ...after] : after;
      body = [{ ...first, children: runs }, ...quote.children.slice(1)];
    }
    tree.children[i] = {
      type: "callout",
      kind: found.kind,
      marker: found.marker,
      gap,
      children: body,
      position: quote.position,
    };
  }
}

const quoteLine = (line: string, _row: number, blank: boolean) => ">" + (blank ? "" : " ") + line;

export const calloutRemark = $remark("callout", () => {
  return function (this: any) {
    const data = this.data();
    const toMarkdownExtensions = data.toMarkdownExtensions || (data.toMarkdownExtensions = []);
    toMarkdownExtensions.push({
      handlers: {
        callout(node: any, _parent: any, state: any, info: any) {
          const exit = state.enter("blockquote");
          const tracker = state.createTracker(info);
          tracker.move("> ");
          tracker.shift(2);
          const body: string = state.containerFlow(node, tracker.current());
          exit();
          const marker = calloutMarkerLine(isKind(node.kind) ? node.kind : "note", node.marker);
          const text = body ? marker + (node.gap ? "\n\n" : "\n") + body : marker;
          return state.indentLines(text, quoteLine);
        },
      },
    });
    return (tree: any) => liftCallouts(tree);
  };
});

/* ---------- The node ---------- */

export const calloutSchema = $nodeSchema(CALLOUT_NODE, () => ({
  content: "block+",
  group: "block",
  defining: true,
  attrs: {
    kind: { default: "note", validate: "string" },
    // The marker word as it was read, "" for one made or changed here.
    marker: { default: "", validate: "string" },
    // A blank `>` line between the marker and the body in the source.
    gap: { default: false, validate: "boolean" },
  },
  parseDOM: [
    {
      // Copied out of Doklin (the editor, a public page).
      tag: "div.callout[data-kind]",
      contentElement: ".callout-body",
      getAttrs: (dom: HTMLElement) => {
        const kind = dom.getAttribute("data-kind");
        return isKind(kind) ? { kind } : false;
      },
    },
    {
      // Copied off GitHub: <div class="markdown-alert markdown-alert-note">,
      // its first child the title.
      tag: "div.markdown-alert",
      getAttrs: (dom: HTMLElement) => {
        const kind = /markdown-alert-([a-z]+)/.exec(dom.className)?.[1];
        return isKind(kind) ? { kind } : false;
      },
      contentElement: (dom: HTMLElement) => {
        const body = dom.cloneNode(true) as HTMLElement;
        body.querySelector(".markdown-alert-title")?.remove();
        return body;
      },
    },
  ],
  toDOM: (node) => {
    const kind = isKind(node.attrs.kind) ? node.attrs.kind : "note";
    return [
      "div",
      { class: `callout callout-${kind}`, "data-kind": kind, role: "note" },
      ["div", { class: "callout-head", contenteditable: "false" }, CALLOUTS[kind].name],
      ["div", { class: "callout-body" }, 0],
    ];
  },
  parseMarkdown: {
    match: (node: { type: string }) => node.type === "callout",
    runner: (state: any, node: any, type: NodeType) => {
      state.openNode(type, {
        kind: isKind(node.kind) ? node.kind : "note",
        marker: typeof node.marker === "string" ? node.marker : "",
        gap: node.gap === true,
      });
      state.next(node.children);
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node: ProseNode) => node.type.name === CALLOUT_NODE,
    runner: (state: any, node: ProseNode) => {
      state.openNode("callout", undefined, {
        kind: node.attrs.kind,
        marker: node.attrs.marker,
        gap: node.attrs.gap,
      });
      // An empty callout writes its marker alone: no empty paragraph for
      // the body.
      const empty = node.childCount === 1 && node.firstChild!.isTextblock && node.firstChild!.content.size === 0;
      if (!empty) state.next(node.content);
      state.closeNode();
    },
  },
}));

/* ---------- The view ---------- */

const CHEVRON = `<svg class="callout-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>`;

const PLACEHOLDER: Record<CalloutKind, string> = {
  note: "Write a note…",
  tip: "Write a tip…",
  important: "Write what's important…",
  warning: "Write a warning…",
  caution: "Write what could go wrong…",
};
const placeholderOf = (kind: CalloutKind) => PLACEHOLDER[kind];

const isEmptyCallout = (node: ProseNode) =>
  node.childCount === 1 && node.firstChild!.isTextblock && node.firstChild!.content.size === 0;

export const calloutView = $view(calloutSchema.node, (): NodeViewConstructor => {
  return (initial: ProseNode, view: EditorView, getPos) => {
    let node = initial;
    const dom = document.createElement("div");
    dom.setAttribute("role", "note");
    const head = document.createElement("div");
    head.className = "callout-head";
    head.contentEditable = "false";
    const body = document.createElement("div");
    body.className = "callout-body";
    dom.append(head, body);

    const paint = () => {
      const kind = isKind(node.attrs.kind) ? node.attrs.kind : "note";
      dom.className = `callout callout-${kind}${isEmptyCallout(node) ? " is-empty" : ""}`;
      dom.dataset.kind = kind;
      body.dataset.placeholder = placeholderOf(kind);
      if (head.dataset.kind !== kind) {
        head.dataset.kind = kind;
        head.innerHTML = `${calloutIconSvg(kind)}<span class="callout-title">${CALLOUTS[kind].name}</span>${CHEVRON}`;
      }
    };
    paint();

    // The title is a control, not text: a press there never moves the caret.
    head.addEventListener("mousedown", (e) => e.preventDefault());
    head.addEventListener("click", (e) => {
      e.preventDefault();
      if (!view.editable) return;
      const pos = getPos();
      if (pos == null) return;
      const kind = isKind(node.attrs.kind) ? node.attrs.kind : "note";
      const detail: CalloutPickDetail = { pos, kind, anchor: head };
      view.dom.dispatchEvent(new CustomEvent(CALLOUT_PICK_EVENT, { bubbles: true, detail }));
    });

    return {
      dom,
      contentDOM: body,
      update(next: ProseNode) {
        if (next.type !== node.type) return false;
        node = next;
        paint();
        return true;
      },
      ignoreMutation(m) {
        // The title and the classes are this view's own.
        if (m.type === "selection") return false;
        return head.contains(m.target) || m.target === dom;
      },
      stopEvent(e) {
        return e.target instanceof Node && head.contains(e.target);
      },
    };
  };
});

/* ---------- Commands ---------- */

/** Make the current block a callout (the slash menu's Callout). Top level only, as GitHub requires. */
export const insertCalloutCommand = $command("InsertCallout", (ctx) => (kind: CalloutKind = "note") => {
  return (state, dispatch) => {
    const type = calloutSchema.type(ctx);
    const { $from } = state.selection;
    if ($from.depth < 1) return false;
    const attrs = { kind, marker: "", gap: false };
    if ($from.depth === 1 && $from.parent.isTextblock) {
      // A top-level paragraph: it becomes the callout's body.
      const start = $from.before(1);
      const block = $from.node(1);
      const para = block.type.name === "paragraph" ? block : state.schema.nodes.paragraph.create(null, block.content);
      const callout = type.create(attrs, para);
      if (dispatch) {
        const tr = state.tr.replaceWith(start, start + block.nodeSize, callout);
        tr.setSelection(TextSelection.near(tr.doc.resolve(start + 2 + ($from.pos - $from.start()))));
        dispatch(tr.scrollIntoView());
      }
      return true;
    }
    // Inside something else (a list, a quote, a table): a new callout after
    // the top-level block holding the caret.
    const after = $from.after(1);
    const callout = type.createAndFill(attrs);
    if (!callout) return false;
    if (dispatch) {
      const tr = state.tr.insert(after, callout);
      tr.setSelection(TextSelection.near(tr.doc.resolve(after + 2)));
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
});

/** Change a callout's kind (the picker). Its marker is rewritten uppercase. */
export function setCalloutKind(view: EditorView, pos: number, kind: CalloutKind): void {
  const node = view.state.doc.nodeAt(pos);
  if (!node || node.type.name !== CALLOUT_NODE || node.attrs.kind === kind) return;
  view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, kind, marker: "" }));
}

/** Remove a callout, keeping its body where it was as ordinary blocks (the picker's Remove callout). */
export function removeCallout(view: EditorView, pos: number): void {
  const node = view.state.doc.nodeAt(pos);
  if (!node || node.type.name !== CALLOUT_NODE) return;
  const content = isEmptyCallout(node) ? Fragment.from(view.state.schema.nodes.paragraph.create()) : node.content;
  const tr = view.state.tr.replaceWith(pos, pos + node.nodeSize, content);
  tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1)));
  view.dispatch(tr);
  view.focus();
}

// Enter at the end of a quote's first line that reads `[!warning]`: the
// quote becomes that callout — typing the markdown makes the block.
function markerToCallout(type: NodeType): Command {
  return (state: EditorState, dispatch) => {
    const { $from, empty } = state.selection;
    if (!empty || $from.depth !== 2 || !$from.parent.isTextblock) return false;
    const quote = $from.node(1);
    if (quote.type.name !== "blockquote" || $from.index(1) !== 0) return false;
    if ($from.parentOffset !== $from.parent.content.size) return false;
    const found = parseCalloutMarker($from.parent.textContent.trim());
    if (!found) return false;
    if (dispatch) {
      const start = $from.before(1);
      const rest: ProseNode[] = [];
      quote.forEach((child, _o, i) => {
        if (i > 0) rest.push(child);
      });
      const callout = type.createAndFill({ kind: found.kind, marker: found.marker, gap: false }, rest.length ? rest : undefined);
      if (!callout) return false;
      const tr = state.tr.replaceWith(start, start + quote.nodeSize, callout);
      tr.setSelection(TextSelection.near(tr.doc.resolve(start + 2)));
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

// Backspace at the very start of a callout's body lifts that first block
// out above it — the callout goes when it held only that — as a quote's
// does. Left to the base keymap, the line would join the block before the
// callout (a heading, say), crossing the box.
const liftOutOfCallout: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0 || $from.depth !== 2) return false;
  if ($from.node(1).type.name !== CALLOUT_NODE || $from.index(1) !== 0) return false;
  const range = $from.blockRange();
  const target = range ? liftTarget(range) : null;
  if (!range || target == null) return false;
  if (dispatch) dispatch(state.tr.lift(range, target).scrollIntoView());
  return true;
};

export const calloutKeymap = $shortcut((ctx) => ({
  Enter: {
    key: "Enter",
    // Ahead of the base keymap's Enter (50), which would split the line.
    priority: 100,
    onRun: () => markerToCallout(calloutSchema.type(ctx)),
  },
  Backspace: {
    key: "Backspace",
    priority: 100,
    onRun: () => liftOutOfCallout,
  },
}));

/** Everything a Milkdown editor needs for callouts. */
export const calloutPlugins = [
  ...calloutRemark,
  ...calloutSchema,
  calloutView,
  insertCalloutCommand,
  calloutKeymap,
].flat();

/** The slash menu's Callout item: clear the "/…" text, then make the block a Note. */
export function runInsertCallout(ctx: Ctx): void {
  const commands = ctx.get(commandsCtx);
  commands.call(clearTextInCurrentBlockCommand.key);
  commands.call(insertCalloutCommand.key, "note");
}

/** The slash menu's icon: the Note shape, in the menu's own filled-glyph size. */
export const calloutMenuIcon = calloutIconSvg("note", "callout-menu-icon");
