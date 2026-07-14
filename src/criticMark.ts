// CriticMarkup editorial comments — the data model.
//
// A comment thread is a first-class inline mark (`critic_comment`) carried by
// the anchor text; the thread — a stable id plus a flat list of entries
// (opening comment + replies), each with author and time — lives in the
// mark's attributes. CriticMarkup (see criticMarkup.ts for the exact shape)
// is just the on-disk markdown serialization of that mark, handled by a
// remark plugin.
//
// Why a mark and not literal text + decorations: the anchor and its thread
// are then structurally bound. Delete the anchor text and ProseMirror drops
// the mark (and the thread) with it — so "anchor gone → comment gone" is
// automatic, and the right-side rail (derived from collectThreads) just
// reflects the doc.
//
// Why an id: an inline mark can't cross a block boundary, so an anchor
// spanning paragraphs is several mark runs. The shared id groups them back
// into ONE thread — one rail card, one delete — and gives the UI an identity
// that survives edits elsewhere in the document (positions don't).

import { $markSchema, $remark } from "@milkdown/kit/utils";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { EditorState } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import {
  CRITIC_BLOCK_RE,
  parseSpans,
  formatThreadSpans,
  newThreadId,
  sanitizeAuthor,
  sanitizeBody,
  type CommentEntry,
} from "./criticMarkup";

export const CRITIC_MARK = "critic_comment";

export type { CommentEntry };

function isEntryArray(value: unknown): value is CommentEntry[] {
  return (
    Array.isArray(value) &&
    value.every(
      (e) =>
        e &&
        typeof e === "object" &&
        typeof (e as CommentEntry).author === "string" &&
        typeof (e as CommentEntry).at === "number" &&
        typeof (e as CommentEntry).body === "string",
    )
  );
}

// The inline mark. Its `toDOM` renders the highlight (so no decoration is
// needed for the base highlight), and parse/serialize map it to the
// `criticComment` mdast node produced/consumed by the remark plugin below.
export const criticCommentSchema = $markSchema(CRITIC_MARK, () => ({
  attrs: {
    id: { default: "", validate: "string" },
    comments: {
      default: [],
      validate: (value: unknown) => {
        if (!isEntryArray(value)) throw new RangeError("invalid comment thread");
      },
    },
  },
  // Like a link: typing at the boundary must not extend the comment.
  inclusive: false,
  // Only spans this app stamped with a thread id parse back into comments;
  // arbitrary pasted HTML never becomes a phantom thread.
  parseDOM: [
    {
      tag: "span.critic-anchor[data-comment-id]",
      getAttrs: (dom: HTMLElement) => {
        const id = dom.getAttribute("data-comment-id");
        return id ? { id, comments: [] } : false;
      },
    },
  ],
  toDOM: (mark) => ["span", { class: "critic-anchor", "data-comment-id": mark.attrs.id }],
  parseMarkdown: {
    match: (node: { type: string }) => node.type === "criticComment",
    runner: (state: any, node: any, markType: any) => {
      state.openMark(markType, {
        id: (node.threadId as string) ?? "",
        comments: (node.comments as CommentEntry[]) ?? [],
      });
      state.next(node.children);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark: { type: { name: string } }) => mark.type.name === CRITIC_MARK,
    runner: (state: any, mark: any) => {
      state.withMark(mark, "criticComment", undefined, {
        threadId: mark.attrs.id,
        comments: mark.attrs.comments,
      });
    },
  },
}));

// One unified/remark plugin doing both directions:
//   stringify — render a `criticComment` mdast node as `{==anchor==}` plus
//     its full thread spans. Every run of a multi-block thread writes the
//     thread in full: the serializer is deliberately stateless (milkdown
//     reuses serializer state across runs and may evaluate a node more than
//     once, so any "already written" bookkeeping here mis-fires), and the
//     parse side deduplicates instead.
//   parse — split text nodes matching the CriticMarkup pattern into
//     `criticComment` mdast nodes, unify runs that share a thread id (first
//     run's entries win), resolve bare `{>>#id<<}` refs onto their thread,
//     and unwrap refs whose thread is gone.
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
          const id = (node.threadId as string) || newThreadId();
          const spans = formatThreadSpans(id, (node.comments as CommentEntry[]) ?? []);
          return `{==${inner}==}${spans}`;
        },
      },
    });
    return (tree: any) => {
      splitCriticTextNodes(tree);
      resolveThreadRefs(tree);
    };
  };
});

// Walk the mdast tree and split every `text` node whose value contains the
// CriticMarkup pattern into [text, criticComment, text, …]. Hand-rolled
// (rather than pulling in mdast-util-find-and-replace) so we add no new
// dependency; it only ever touches plain text nodes, leaving
// code/inlineCode/html untouched.
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
  const re = new RegExp(CRITIC_BLOCK_RE.source, "g");
  const out: any[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    if (m.index > last) out.push({ type: "text", value: value.slice(last, m.index) });
    const parsed = parseSpans(m[2]);
    const node: any = {
      type: "criticComment",
      children: [{ type: "text", value: m[1] }],
    };
    if (parsed.kind === "ref") {
      node.refId = parsed.id;
    } else {
      node.threadId = parsed.id; // null = legacy span, id assigned below
      node.comments = parsed.comments;
    }
    out.push(node);
    last = m.index + m[0].length;
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  if (out.length === 0) return [{ type: "text", value }];
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

// Second parse pass: roots register their thread (several runs may carry the
// same id — the serializer writes multi-block threads in full on every run —
// and the first one wins), legacy spans get a fresh id, refs adopt their
// root's thread. A ref whose root no longer exists (e.g. the root paragraph
// was deleted in another editor) unwraps to plain text rather than surviving
// as an empty ghost comment.
function resolveThreadRefs(tree: any): void {
  const threads = new Map<string, CommentEntry[]>();
  visit(tree, (node) => {
    if (node.type !== "criticComment" || node.refId) return undefined;
    if (!node.threadId) node.threadId = newThreadId();
    const known = threads.get(node.threadId);
    if (known === undefined) threads.set(node.threadId, node.comments ?? []);
    else node.comments = known;
    return undefined;
  });
  visit(tree, (node) => {
    if (node.type !== "criticComment" || !node.refId) return undefined;
    const comments = threads.get(node.refId);
    if (comments === undefined) return node.children ?? [];
    node.threadId = node.refId;
    node.comments = comments;
    delete node.refId;
    return undefined;
  });
}

// Depth-first walk; `fn` may return a replacement array for the visited node
// (used to unwrap a node into its children).
function visit(node: any, fn: (node: any) => any[] | undefined): void {
  if (!node || !Array.isArray(node.children)) return;
  const next: any[] = [];
  for (const child of node.children) {
    visit(child, fn);
    const replacement = fn(child);
    if (replacement) next.push(...replacement);
    else next.push(child);
  }
  node.children = next;
}

/* ---------- Reading threads out of the document ---------- */

export type ThreadRange = { from: number; to: number };

// One comment thread as the rail sees it: the shared id, the entries, and
// every anchor run (usually one; several when the anchor crosses blocks).
export type DocThread = {
  id: string;
  comments: CommentEntry[];
  ranges: ThreadRange[];
};

// Walk the doc collecting every `critic_comment` run, grouped by thread id in
// document order. Contiguous runs merge; runs separated by other content or
// block boundaries stay separate ranges of the same thread.
export function collectThreads(doc: ProseNode): DocThread[] {
  const markType = doc.type.schema.marks[CRITIC_MARK];
  if (!markType) return [];
  const byId = new Map<string, DocThread>();
  const order: DocThread[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return undefined;
    const mark = node.marks.find((m) => m.type === markType);
    if (!mark) return undefined;
    const id = (mark.attrs.id as string) || "";
    const comments = (mark.attrs.comments as CommentEntry[]) ?? [];
    let thread = byId.get(id);
    if (!thread) {
      thread = { id, comments, ranges: [] };
      byId.set(id, thread);
      order.push(thread);
    } else if (comments.length > thread.comments.length) {
      // Defensive: if runs of one thread ever disagree, the fuller copy wins.
      thread.comments = comments;
    }
    const from = pos;
    const to = pos + node.nodeSize;
    const last = thread.ranges[thread.ranges.length - 1];
    if (last && last.to === from) last.to = to;
    else thread.ranges.push({ from, to });
    return undefined;
  });
  return order;
}

export function getThread(state: EditorState, id: string): DocThread | null {
  return collectThreads(state.doc).find((t) => t.id === id) ?? null;
}

/* ---------- Mutations (thin transaction wrappers) ---------- */
//
// Every mutation resolves the thread's ranges from the CURRENT document at
// dispatch time — never from cached positions — so stale UI state can't
// mangle a different part of the doc.

function markTypeOf(view: EditorView) {
  return view.state.schema.marks[CRITIC_MARK];
}

// Replace a thread's entries across all of its runs. addMark on an already
// marked range swaps the mark in place (same type replaces), and it doesn't
// move positions, so one transaction can cover every range as scanned.
function setThreadComments(view: EditorView, id: string, comments: CommentEntry[]): void {
  const thread = getThread(view.state, id);
  if (!thread) return;
  const mt = markTypeOf(view);
  const tr = view.state.tr;
  for (const r of thread.ranges) tr.addMark(r.from, r.to, mt.create({ id, comments }));
  view.dispatch(tr);
}

// Wrap the current selection in a new thread whose opening entry is an empty
// draft by `author` (the card opens for typing; an abandoned draft is
// discarded on commit). No-op on an empty selection. Returns the new id.
export function createThread(view: EditorView, author: string): string | null {
  const { from, to, empty } = view.state.selection;
  if (empty) return null;
  const id = newThreadId();
  const entry: CommentEntry = { author: sanitizeAuthor(author), at: Date.now(), body: "" };
  const mt = markTypeOf(view);
  view.dispatch(view.state.tr.addMark(from, to, mt.create({ id, comments: [entry] })));
  return id;
}

// Rewrite one entry's body. Filling an empty draft freshens the timestamp
// (the comment "happens" when it's committed); editing later keeps the
// original time.
export function updateCommentBody(
  view: EditorView,
  id: string,
  index: number,
  body: string,
): void {
  const thread = getThread(view.state, id);
  const entry = thread?.comments[index];
  if (!thread || !entry) return;
  const next = thread.comments.slice();
  next[index] = {
    ...entry,
    body: sanitizeBody(body),
    at: entry.body === "" ? Date.now() : entry.at,
  };
  setThreadComments(view, id, next);
}

// Append a reply (threads are flat: one level of replies under the opener).
export function addReply(view: EditorView, id: string, author: string, body: string): void {
  const thread = getThread(view.state, id);
  const clean = sanitizeBody(body);
  if (!thread || !clean) return;
  setThreadComments(view, id, [
    ...thread.comments,
    { author: sanitizeAuthor(author), at: Date.now(), body: clean },
  ]);
}

// Remove one reply. Deleting the opener is deleteThread's job — the thread
// has no meaning without it.
export function deleteReply(view: EditorView, id: string, index: number): void {
  const thread = getThread(view.state, id);
  if (!thread || index <= 0 || index >= thread.comments.length) return;
  setThreadComments(
    view,
    id,
    thread.comments.filter((_, i) => i !== index),
  );
}

// Delete a whole thread: remove the mark from every run — the anchor text
// stays in the document. Undo (⌘Z) brings the thread back.
export function deleteThread(view: EditorView, id: string): void {
  const thread = getThread(view.state, id);
  if (!thread) return;
  const mt = markTypeOf(view);
  const tr = view.state.tr;
  for (const r of thread.ranges) tr.removeMark(r.from, r.to, mt);
  view.dispatch(tr);
}
