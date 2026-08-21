// Ticking a task-list checkbox in a document you may comment on but not edit.
//
// A GFM checklist (`- [ ] item`) is a list item carrying a `checked` attribute,
// and Milkdown's list-item node view draws the box and flips that attribute
// when the box is clicked — but only `if (view.editable)`. That gate is right
// for a read-only MIRROR (the unfocused split pane, a preview); it is wrong for
// a shared page's comment-role visitor, who is exactly the person a checklist
// is usually for. Ticking a box is not rewriting the document: the text is
// untouched, one bit of state moves, and the worker's save guard checks that
// claim on its own side (`taskToggleOnly` in share-worker/src/index.js).
//
// So this plugin re-adds the gesture for read-only sessions the host opts in
// for. It listens in the CAPTURE phase because the node view's own pointerdown
// handler sits ON the label and calls stopPropagation() — a plugin's
// handleDOMEvents (bubble phase, on the editor root) would never hear the
// click. The transaction is dispatched programmatically, which ProseMirror
// allows on a non-editable view; `editable` only governs what the DOM itself
// may do.

import { $prose } from "@milkdown/kit/utils";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";

export const taskToggleKey = new PluginKey("doklin-task-toggle");

// The node view's parts (see @milkdown/components/list-item-block): the block
// root wraps a `.label-wrapper` holding the bullet/number/checkbox icon and a
// `[data-content-dom]` holding the item's actual content.
const BLOCK = ".milkdown-list-item-block";
const LABEL = ".label-wrapper";
const CONTENT = "[data-content-dom]";

// Document position of the list item a node-view root renders. The label sits
// OUTSIDE the item's contentDOM, so it has no position of its own — resolve
// the start of the content instead and walk out to the item that holds it.
function itemPosAt(view: EditorView, block: Element): number | null {
  const content = block.querySelector(CONTENT);
  if (!content) return null;
  try {
    const $pos = view.state.doc.resolve(view.posAtDOM(content, 0));
    for (let depth = $pos.depth; depth > 0; depth -= 1) {
      if ($pos.node(depth).type.name === "list_item") return $pos.before(depth);
    }
  } catch {
    // The DOM can be mid-update (a remount, an incoming remote change) —
    // then this click simply isn't a toggle.
  }
  return null;
}

/**
 * Click-to-toggle for task-list checkboxes in a read-only editor. `enabled` is
 * read per click, so a host can grant or withdraw the gesture without
 * remounting. Inert while the editor is editable — there the node view's own
 * handler owns the box, and running both would toggle it twice.
 */
export function taskTogglePlugin(enabled: () => boolean) {
  return $prose(() => {
    return new Plugin({
      key: taskToggleKey,
      view: (view) => {
        // The class is what CSS keys the pointer cursor off: the node view
        // marks its icon `.readonly` (cursor: not-allowed) whenever the editor
        // isn't editable, which would otherwise advertise the box as dead.
        const sync = () => {
          view.dom.classList.toggle("dk-task-toggle", enabled() && !view.editable);
        };
        sync();

        const onPointerDown = (event: PointerEvent) => {
          if (!enabled() || view.editable) return;
          if (event.button !== 0) return;
          const target = event.target as HTMLElement | null;
          if (!target?.closest?.(LABEL)) return;
          const block = target.closest(BLOCK);
          if (!block) return;
          const pos = itemPosAt(view, block);
          if (pos == null) return;
          const node = view.state.doc.nodeAt(pos);
          // A bullet or a number, not a box: `checked` is null on those.
          if (!node || node.attrs.checked == null) return;
          event.preventDefault();
          event.stopPropagation();
          view.dispatch(view.state.tr.setNodeAttribute(pos, "checked", !node.attrs.checked));
        };

        view.dom.addEventListener("pointerdown", onPointerDown, true);
        return {
          update: sync,
          destroy: () => view.dom.removeEventListener("pointerdown", onPointerDown, true),
        };
      },
    });
  });
}
