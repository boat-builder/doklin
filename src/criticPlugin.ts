// CriticMarkup editorial comments — Milkdown (ProseMirror) $prose plugins.
//
// The persistent highlight + comment body live in the `critic_comment` mark
// (see criticMark.ts). These two plugins cover the *ephemeral* / view concerns:
//
//   criticActivePlugin — paints the "active" comment (the one whose card is
//     selected in the rail) with an extra decoration. Active state is transient
//     UI, not document data, so it lives here rather than on the mark.
//
//   criticCopyPlugin — intercepts copy/cut so the clipboard gets the *clean*
//     markdown (markers stripped). The verbatim "with comments" copy is a
//     separate explicit action in the app's Settings menu.

import { $prose } from "@milkdown/kit/utils";
import { serializerCtx, schemaCtx } from "@milkdown/kit/core";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { Node as ProseNode, Schema } from "@milkdown/kit/prose/model";
import { stripComments } from "./criticMarkup";

// --- Active comment highlight ---

export type ActiveRange = { from: number; to: number } | null;

export const criticActiveKey = new PluginKey<ActiveRange>("doklin-critic-active");

export const criticActivePlugin = $prose(
  () =>
    new Plugin<ActiveRange>({
      key: criticActiveKey,
      state: {
        init: () => null,
        apply(tr, value) {
          // A set/clear request wins outright (meta is `null` to clear).
          const meta = tr.getMeta(criticActiveKey) as ActiveRange | undefined;
          if (meta !== undefined) return meta;
          // Otherwise keep the range glued to its text across edits.
          if (value && tr.docChanged) {
            const from = tr.mapping.map(value.from);
            const to = tr.mapping.map(value.to);
            return to > from ? { from, to } : null;
          }
          return value;
        },
      },
      props: {
        decorations(state) {
          const r = criticActiveKey.getState(state);
          if (!r) return null;
          return DecorationSet.create(state.doc, [
            Decoration.inline(r.from, r.to, { class: "critic-anchor-active" }),
          ]);
        },
      },
    }),
);

// Set (or clear, with null) which comment is visually active.
export function setActiveComment(view: EditorView, range: ActiveRange): void {
  view.dispatch(view.state.tr.setMeta(criticActiveKey, range));
}

// --- Clean copy / cut ---

// Serialize the current selection to markdown exactly the way Milkdown's own
// clipboard plugin does (@milkdown/plugin-clipboard). With the comment mark in
// place this naturally emits CriticMarkup, which stripComments then cleans.
function selectionMarkdown(
  view: EditorView,
  serializer: (doc: ProseNode) => string,
  schema: Schema,
): string {
  const slice = view.state.selection.content();
  const doc = schema.topNodeType.createAndFill(undefined, slice.content);
  if (!doc) return slice.content.textBetween(0, slice.content.size, "\n\n");
  return serializer(doc);
}

export const criticCopyPlugin = $prose((ctx) => {
  // Shared handler for copy and cut: put clean markdown on the clipboard. `cut`
  // additionally deletes the selection (we've taken over the default). The
  // serializer/schema are read lazily here (as Milkdown's own clipboard plugin
  // does) so we never hold a stale reference.
  const handle = (view: EditorView, event: ClipboardEvent, isCut: boolean): boolean => {
    if (view.state.selection.empty) return false;
    const data = event.clipboardData;
    if (!data) return false;
    const serializer = ctx.get(serializerCtx);
    const schema = ctx.get(schemaCtx);
    const clean = stripComments(selectionMarkdown(view, serializer, schema));
    // Markdown's canonical clipboard form is text/plain; leaving text/html empty
    // makes paste targets (including Milkdown's own handlePaste) fall back to it.
    data.setData("text/plain", clean);
    event.preventDefault();
    if (isCut) view.dispatch(view.state.tr.deleteSelection());
    return true;
  };

  return new Plugin({
    key: new PluginKey("doklin-critic-copy"),
    props: {
      handleDOMEvents: {
        copy: (view, event) => handle(view, event, false),
        cut: (view, event) => handle(view, event, true),
      },
    },
  });
});
