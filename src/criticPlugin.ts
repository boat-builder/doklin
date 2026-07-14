// CriticMarkup editorial comments — Milkdown (ProseMirror) $prose plugins.
//
// The persistent highlight + thread data live in the `critic_comment` mark
// (see criticMark.ts). These two plugins cover the *ephemeral* / view
// concerns:
//
//   criticActivePlugin — paints the "active" thread (the one whose card is
//     selected in the rail) with an extra decoration on every one of its
//     anchor runs. Active state is transient UI, not document data, so it
//     lives here rather than on the mark. It is keyed by thread id, so it
//     survives edits elsewhere and vanishes by itself the moment the thread's
//     marks are gone (delete, cut, undo) — no stale highlight can linger.
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
import { collectThreads } from "./criticMark";

/* ---------- Active thread highlight ---------- */

type ActiveState = { id: string | null; decos: DecorationSet };

export const criticActiveKey = new PluginKey<ActiveState>("doklin-critic-active");

function buildDecos(doc: ProseNode, id: string | null): DecorationSet {
  if (!id) return DecorationSet.empty;
  const thread = collectThreads(doc).find((t) => t.id === id);
  if (!thread) return DecorationSet.empty;
  return DecorationSet.create(
    doc,
    thread.ranges.map((r) =>
      Decoration.inline(r.from, r.to, { class: "critic-anchor-active" }),
    ),
  );
}

export const criticActivePlugin = $prose(
  () =>
    new Plugin<ActiveState>({
      key: criticActiveKey,
      state: {
        init: () => ({ id: null, decos: DecorationSet.empty }),
        apply(tr, value) {
          // A set/clear request wins outright (meta is `null` to clear).
          const meta = tr.getMeta(criticActiveKey) as string | null | undefined;
          const id = meta !== undefined ? meta : value.id;
          if (!id) return { id: null, decos: DecorationSet.empty };
          // Rebuild from the marks themselves whenever the doc (or the
          // selection of active thread) changes: the decoration always
          // mirrors where the thread's runs ARE, and disappears with them.
          if (meta !== undefined || tr.docChanged) {
            return { id, decos: buildDecos(tr.doc, id) };
          }
          return value;
        },
      },
      props: {
        decorations(state) {
          return criticActiveKey.getState(state)?.decos ?? null;
        },
      },
    }),
);

// Set (or clear, with null) which thread is visually active.
export function setActiveThread(view: EditorView, id: string | null): void {
  view.dispatch(view.state.tr.setMeta(criticActiveKey, id));
}

/* ---------- Clean copy / cut ---------- */

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
