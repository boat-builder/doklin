// ↑ on the first line of the note's first block, or Backspace in an empty
// first paragraph, hands the caret to the title above the note — on the Mac
// (src/Editor.tsx) and in the iPhone's editor (src/ios-editor/). Used last,
// so the menus and the editor's own keys have them first.
import { Plugin, Selection } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";

export const leaveTopPlugin = (leave: () => (() => void) | undefined) =>
  $prose(
    () =>
      new Plugin({
        props: {
          handleKeyDown(view, event) {
            const go = leave();
            if (!go || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return false;
            const { selection, doc } = view.state;
            const $from = selection.$from;
            if (!selection.empty || $from.parent !== Selection.atStart(doc).$from.parent) return false;
            const leaves =
              event.key === "ArrowUp"
                ? view.endOfTextblock("up")
                : event.key === "Backspace" &&
                  $from.parent.type.name === "paragraph" &&
                  $from.parent.content.size === 0;
            if (!leaves) return false;
            event.preventDefault();
            go();
            return true;
          },
        },
      }),
  );
