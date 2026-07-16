// Inline code spans hard-wrapped across source lines — `Money{Micros int64,\n
// Currency string}` — are valid CommonMark: the code span doesn't end at the
// newline, and spec-compliant renderers turn the line ending into a space at
// HTML-output time. remark, however, keeps the RAW value (newline plus the
// next line's indent) in the mdast `inlineCode` node, and milkdown copies
// that straight into a ProseMirror text node. ProseMirror's editable surface
// is `white-space: pre-wrap`, so the newline renders literally: the code
// pill breaks into a stacked two-line box in the middle of a sentence.
//
// Normalize at parse time instead: collapse each line ending and its
// surrounding indent to the single space every other renderer effectively
// shows (HTML would collapse the space run anyway; pre-wrap would not).
// Serialization needs no counterpart — the document simply carries a space,
// which round-trips as a one-line code span that renders identically
// everywhere.

import { $remark } from "@milkdown/kit/utils";

function normalizeInlineCode(node: any): void {
  if (!node) return;
  if (node.type === "inlineCode" && typeof node.value === "string") {
    node.value = node.value.replace(/[ \t]*\r?\n[ \t]*/g, " ");
    return;
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) normalizeInlineCode(child);
  }
}

export const inlineCodeNewlines = $remark("inlineCodeNewlines", () => {
  return () => (tree: any) => normalizeInlineCode(tree);
});
