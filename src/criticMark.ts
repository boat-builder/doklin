// CriticMarkup editorial comments — the data model.
//
// A comment is a first-class inline mark (`critic_comment`) carried by the
// anchor text, with the comment body in the mark's attributes. CriticMarkup
// `{==anchor==}{>>body<<}` is just the on-disk markdown serialization of that
// mark, handled by a remark plugin.
//
// Why a mark and not literal text + decorations: the anchor and its note are
// then structurally bound. Delete the anchor text and ProseMirror drops the
// mark (and its body) with it — so "anchor gone → comment gone" is automatic,
// and the right-side rail (derived from collectComments) just reflects the doc.
//
// Templated on the commonmark `link` mark (an inline mark with attributes and
// attribute-dependent markdown delimiters) and the gfm preset's remark wiring.

import { $markSchema, $remark } from "@milkdown/kit/utils";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { EditorView } from "@milkdown/kit/prose/view";
import { CRITIC_RE } from "./criticMarkup";

export const CRITIC_MARK = "critic_comment";

// The inline mark. Its `toDOM` renders the highlight (so no decoration is needed
// for the base highlight), and parse/serialize map it to the `criticComment`
// mdast node produced/consumed by the remark plugin below.
export const criticCommentSchema = $markSchema(CRITIC_MARK, () => ({
  attrs: {
    body: { default: "", validate: "string" },
  },
  // Like a link: typing at the boundary must not extend the comment.
  inclusive: false,
  parseDOM: [{ tag: "span.critic-anchor" }],
  toDOM: () => ["span", { class: "critic-anchor" }],
  parseMarkdown: {
    match: (node: { type: string }) => node.type === "criticComment",
    runner: (state: any, node: any, markType: any) => {
      state.openMark(markType, { body: (node.commentBody as string) ?? "" });
      state.next(node.children);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark: { type: { name: string } }) => mark.type.name === CRITIC_MARK,
    runner: (state: any, mark: any) => {
      state.withMark(mark, "criticComment", undefined, {
        commentBody: mark.attrs.body,
      });
    },
  },
}));

// One unified/remark plugin doing both directions:
//   stringify — register an mdast-util-to-markdown handler that renders a
//     `criticComment` mdast node as `{==anchor==}{>>body<<}`.
//   parse — split text nodes matching the CriticMarkup pattern into
//     `criticComment` mdast nodes (anchor as children, body as a field).
// Must be a normal `function` (not an arrow) so `this` is the unified processor.
export const criticRemark = $remark("criticComment", () => {
  return function (this: any) {
    const data = this.data();
    const toMarkdownExtensions =
      data.toMarkdownExtensions || (data.toMarkdownExtensions = []);
    toMarkdownExtensions.push({
      handlers: {
        criticComment(node: any, _parent: any, state: any, info: any) {
          const inner = state.containerPhrasing(node, {
            ...info,
            before: "{==",
            after: "=",
          });
          return `{==${inner}==}{>>${node.commentBody ?? ""}<<}`;
        },
      },
    });
    return (tree: any) => splitCriticTextNodes(tree);
  };
});

// Walk the mdast tree and split every `text` node whose value contains the
// CriticMarkup pattern into [text, criticComment, text, …]. Hand-rolled (rather
// than pulling in mdast-util-find-and-replace) so we add no new dependency; it
// only ever touches plain text nodes, leaving code/inlineCode/html untouched.
function splitCriticTextNodes(node: any): void {
  if (!node || !Array.isArray(node.children)) return;
  const next: any[] = [];
  for (const child of node.children) {
    if (child && child.type === "text" && typeof child.value === "string") {
      next.push(...splitCriticText(child.value));
    } else {
      splitCriticTextNodes(child);
      next.push(child);
    }
  }
  node.children = next;
}

function splitCriticText(value: string): any[] {
  const re = new RegExp(CRITIC_RE.source, "g");
  const out: any[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    if (m.index > last) out.push({ type: "text", value: value.slice(last, m.index) });
    out.push({
      type: "criticComment",
      commentBody: m[2],
      children: [{ type: "text", value: m[1] }],
    });
    last = m.index + m[0].length;
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  if (out.length === 0) return [{ type: "text", value }];
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

// A single comment as seen by the rail: a contiguous run of anchor text carrying
// the mark, plus its body. Identity for the UI is the run's `from` position.
export type Comment = { from: number; to: number; body: string };

// Walk the doc collecting each contiguous run of `critic_comment` text. Adjacent
// runs merge only when they touch AND share the same body (so two distinct
// comments stay distinct); any non-marked node breaks the run.
export function collectComments(doc: ProseNode): Comment[] {
  const markType = doc.type.schema.marks[CRITIC_MARK];
  if (!markType) return [];
  const out: Comment[] = [];
  let cur: Comment | null = null;
  doc.descendants((node, pos) => {
    if (node.isText) {
      const mark = node.marks.find((m) => m.type === markType);
      if (mark) {
        const from = pos;
        const to = pos + node.nodeSize;
        const body = (mark.attrs.body as string) ?? "";
        if (cur && cur.to === from && cur.body === body) {
          cur.to = to;
        } else {
          if (cur) out.push(cur);
          cur = { from, to, body };
        }
        return undefined;
      }
    }
    // A non-marked text node or any block boundary ends the current run.
    if (cur) {
      out.push(cur);
      cur = null;
    }
    return undefined;
  });
  if (cur) out.push(cur);
  return out;
}

// --- Mutations (thin transaction wrappers) ---

function markType(view: EditorView) {
  return view.state.schema.marks[CRITIC_MARK];
}

// Wrap the current selection in a new comment. No-op on an empty selection.
// Returns the new comment's range so the caller can open its card.
export function applyComment(view: EditorView, body: string): Comment | null {
  const { from, to, empty } = view.state.selection;
  if (empty) return null;
  const mt = markType(view);
  view.dispatch(view.state.tr.addMark(from, to, mt.create({ body })));
  view.focus();
  return { from, to, body };
}

// Replace a comment's body across its range (remove + re-add with new attrs).
export function updateCommentBody(
  view: EditorView,
  from: number,
  to: number,
  body: string,
): void {
  const mt = markType(view);
  view.dispatch(
    view.state.tr.removeMark(from, to, mt).addMark(from, to, mt.create({ body })),
  );
}

// Delete a comment: remove the mark only — the anchor text stays in the document.
export function removeComment(view: EditorView, from: number, to: number): void {
  const mt = markType(view);
  view.dispatch(view.state.tr.removeMark(from, to, mt));
}
