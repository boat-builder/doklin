// The list `@` opens: the editor's way to pick a document to link to.
//
// Typing `@` at the start of a block, or after a space or punctuation,
// opens it; never inside a word (an email address stays one), in code, or
// in a link's words. What is typed after the `@` filters it
// (`documentsFor`, src/docLinks.ts). ↑ ↓ choose, Enter or Tab picks, a click
// or a tap picks; Esc, or a space when nothing matches, leaves the text as
// typed, and so does taking the caret out of it. Picking puts a named link
// in place of the `@` and what followed it (`insertDocumentLink`,
// src/linkMark.ts). The `@` itself is never stored: it is typed text until
// a document is picked, and gone once one is.

import type { Ctx } from "@milkdown/kit/ctx";
import { Plugin, PluginKey, type EditorState } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import { documentName, documentsFor, pickNotice, sectionName, sectionOf, whoCanOpen, type WorkspaceDocument } from "./docLinks";
import { insertDocumentLink, linkContextCtx, type LinkContext } from "./linkMark";

type Open = { at: number; query: string; index: number };
type MentionState = Open | null;
type MentionMeta = { open: number } | { close: true } | { index: number };

const mentionKey = new PluginKey<MentionState>("doklin-mention");

/** How many rows the list shows. */
const ROWS = 8;
/** Past this many characters after the `@`, it was not a pick. */
const LONGEST = 60;

const OPENS_AFTER = /[\s\p{P}\p{S}]/u;

/** Whether an `@` typed at `pos` opens the list. */
function opensAt(state: EditorState, pos: number): boolean {
  const $pos = state.doc.resolve(pos);
  if (!$pos.parent.isTextblock || $pos.parent.type.spec.code) return false;
  if ($pos.marks().some((m) => m.type.name === "inlineCode" || m.type.name === "link")) return false;
  if ($pos.parentOffset === 0) return true;
  const before = state.doc.textBetween(pos - 1, pos, "\n", "\n");
  return OPENS_AFTER.test(before);
}

/** The open list after `state`: still around its `@`, with what follows it
 *  up to the caret as the query; null once the caret has left it. */
function follow(at: number, state: EditorState, index: number): MentionState {
  const { selection, doc } = state;
  if (!selection.empty || at >= doc.content.size) return null;
  const $caret = selection.$from;
  const $at = doc.resolve(at);
  if ($caret.pos <= at || $at.parent !== $caret.parent) return null;
  if (doc.textBetween(at, at + 1) !== "@") return null;
  const query = doc.textBetween(at + 1, $caret.pos, "\n", "\n");
  if (query.length > LONGEST || query.includes("\n") || query.startsWith(" ")) return null;
  return { at, query, index };
}

const menuOf = (state: EditorState): MentionState => mentionKey.getState(state) ?? null;

function results(open: Open, ctx: LinkContext): WorkspaceDocument[] {
  if (!ctx.docs) return [];
  return documentsFor(open.query, ctx.note?.path ?? null, ctx.docs, ctx.recent).slice(0, ROWS);
}

function pick(view: EditorView, open: Open, doc: WorkspaceDocument, ctx: LinkContext) {
  insertDocumentLink(view, open.at, view.state.selection.from, doc, ctx);
  view.dispatch(view.state.tr.setMeta(mentionKey, { close: true }));
  const notice = ctx.note ? pickNotice(doc, ctx.note.section) : null;
  if (notice) ctx.notify(notice);
}

/** The list on screen, beside the editor. */
class MentionList {
  private readonly el: HTMLDivElement;
  private shown: WorkspaceDocument[] = [];
  private readonly reposition = () => this.place();

  constructor(
    private view: EditorView,
    private readonly ctx: Ctx,
  ) {
    this.el = document.createElement("div");
    this.el.className = "doc-mention-menu";
    this.el.setAttribute("role", "listbox");
    this.el.hidden = true;
    // A press on a row must not take the caret out of the note.
    this.el.addEventListener("mousedown", (e) => e.preventDefault());
    document.body.appendChild(this.el);
    document.addEventListener("scroll", this.reposition, true);
    window.visualViewport?.addEventListener("resize", this.reposition);
    window.visualViewport?.addEventListener("scroll", this.reposition);
  }

  update(view: EditorView) {
    this.view = view;
    const open = menuOf(view.state);
    if (!open) {
      this.hide();
      return;
    }
    const links = this.ctx.get(linkContextCtx.key);
    const found = results(open, links);
    if (found.length === 0 && open.query.endsWith(" ")) {
      // A space with nothing to pick: it was text after all.
      queueMicrotask(() => {
        if (menuOf(this.view.state)) this.view.dispatch(this.view.state.tr.setMeta(mentionKey, { close: true }));
      });
      return;
    }
    this.shown = found;
    this.render(open, links);
    this.el.hidden = false;
    this.place();
  }

  private render(open: Open, links: LinkContext) {
    const selected = Math.min(open.index, Math.max(0, this.shown.length - 1));
    const rows = this.shown.map((doc, i) => {
      const row = document.createElement("div");
      row.className = i === selected ? "row selected" : "row";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(i === selected));
      const line = row.appendChild(document.createElement("div"));
      line.className = "line";
      const name = line.appendChild(document.createElement("span"));
      name.className = "name";
      name.textContent = documentName(doc.path);
      const where = line.appendChild(document.createElement("span"));
      where.className = "where";
      where.textContent = folderWithin(doc.path);
      const own = links.note && links.docs ? sectionOf(links.note.path, links.docs) : null;
      if (links.note && doc.section !== own) {
        const section = line.appendChild(document.createElement("span"));
        section.className = "section";
        section.textContent = sectionName(doc.path);
        if (doc.section !== null) {
          const who = row.appendChild(document.createElement("div"));
          who.className = "who";
          who.textContent = whoCanOpen(doc, links.workspace);
        }
      }
      row.addEventListener("mouseenter", () => {
        const now = menuOf(this.view.state);
        if (now && now.index !== i) this.view.dispatch(this.view.state.tr.setMeta(mentionKey, { index: i }));
      });
      row.addEventListener("click", () => {
        const now = menuOf(this.view.state);
        if (now) pick(this.view, now, doc, this.ctx.get(linkContextCtx.key));
      });
      return row;
    });
    if (rows.length === 0) {
      const none = document.createElement("div");
      none.className = "none";
      none.textContent = links.docs ? "No document is called that." : "Finding documents…";
      rows.push(none);
    }
    this.el.replaceChildren(...rows);
    // The chosen row in view, without scrolling anything but the list.
    const row = rows[selected];
    if (row && this.el.scrollHeight > this.el.clientHeight) {
      if (row.offsetTop < this.el.scrollTop) this.el.scrollTop = row.offsetTop;
      else if (row.offsetTop + row.offsetHeight > this.el.scrollTop + this.el.clientHeight) {
        this.el.scrollTop = row.offsetTop + row.offsetHeight - this.el.clientHeight;
      }
    }
  }

  private place() {
    const open = menuOf(this.view.state);
    if (!open || this.el.hidden) return;
    const { placement } = this.ctx.get(linkContextCtx.key);
    if (placement === "keyboard") {
      // Above the keyboard: the bottom of what is left of the screen.
      const vv = window.visualViewport;
      const bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
      this.el.style.left = "8px";
      this.el.style.right = "8px";
      this.el.style.top = `${Math.max(8, bottom - this.el.offsetHeight - 8)}px`;
      return;
    }
    let at: { left: number; bottom: number; top: number };
    try {
      at = this.view.coordsAtPos(open.at);
    } catch {
      return;
    }
    const height = this.el.offsetHeight;
    const below = at.bottom + 4;
    const top = below + height > window.innerHeight - 8 ? Math.max(8, at.top - height - 4) : below;
    this.el.style.top = `${top}px`;
    this.el.style.left = `${Math.max(8, Math.min(at.left, window.innerWidth - this.el.offsetWidth - 8))}px`;
  }

  private hide() {
    if (this.el.hidden) return;
    this.el.hidden = true;
    this.el.replaceChildren();
    this.shown = [];
  }

  pickSelected(): boolean {
    const open = menuOf(this.view.state);
    if (!open || this.shown.length === 0) return false;
    const doc = this.shown[Math.min(open.index, this.shown.length - 1)];
    pick(this.view, open, doc, this.ctx.get(linkContextCtx.key));
    return true;
  }

  get count() {
    return this.shown.length;
  }

  destroy() {
    document.removeEventListener("scroll", this.reposition, true);
    window.visualViewport?.removeEventListener("resize", this.reposition);
    window.visualViewport?.removeEventListener("scroll", this.reposition);
    this.el.remove();
  }
}

/** A document's folder below its section's: "GTM" for
 *  `Library/GTM/launch-plan.md`. */
function folderWithin(path: string): string {
  const parts = path.split("/").slice(0, -1);
  const skip = parts[0] === "Restricted" ? 2 : parts[0] === "Library" || parts[0] === "Private" ? 1 : 0;
  return parts.slice(skip).join("/");
}

export const mentionPlugin = $prose((ctx) => {
  let list: MentionList | null = null;
  return new Plugin<MentionState>({
    key: mentionKey,
    state: {
      init: () => null,
      apply(tr, prev, _old, state) {
        const meta = tr.getMeta(mentionKey) as MentionMeta | undefined;
        if (meta && "close" in meta) return null;
        if (meta && "open" in meta) return follow(meta.open, state, 0);
        if (!prev) return null;
        const index = meta && "index" in meta ? meta.index : 0;
        const at = tr.mapping.mapResult(prev.at, 1);
        if (at.deleted) return null;
        const next = follow(at.pos, state, index);
        // The same query keeps the row the reader moved to.
        return next && !meta && next.query === prev.query ? { ...next, index: prev.index } : next;
      },
    },
    props: {
      handleTextInput(view, from, to, text) {
        if (text !== "@" || !view.editable || !opensAt(view.state, from)) return false;
        view.dispatch(view.state.tr.insertText("@", from, to).setMeta(mentionKey, { open: from }));
        return true;
      },
      handleKeyDown(view, event) {
        const open = menuOf(view.state);
        if (!open || !list) return false;
        const count = list.count;
        switch (event.key) {
          case "ArrowDown":
          case "ArrowUp": {
            if (count === 0) return true;
            const step = event.key === "ArrowDown" ? 1 : count - 1;
            view.dispatch(view.state.tr.setMeta(mentionKey, { index: (Math.min(open.index, count - 1) + step) % count }));
            return true;
          }
          case "Enter":
          case "Tab":
            if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
            return list.pickSelected();
          case "Escape":
            view.dispatch(view.state.tr.setMeta(mentionKey, { close: true }));
            return true;
          default:
            return false;
        }
      },
      handleDOMEvents: {
        // Leaving the note closes the list; a moment later, so a tap on a
        // row that took the focus (a phone) still picks it first.
        blur: (view) => {
          window.setTimeout(() => {
            if (!view.isDestroyed && !view.hasFocus() && menuOf(view.state)) {
              view.dispatch(view.state.tr.setMeta(mentionKey, { close: true }));
            }
          }, 200);
          return false;
        },
      },
    },
    view(view) {
      list = new MentionList(view, ctx);
      return {
        update: (v) => list?.update(v),
        destroy: () => {
          list?.destroy();
          list = null;
        },
      };
    },
  });
});
