// The iPhone's note editor: the Mac's own Milkdown set-up (src/Editor.tsx) —
// its features, its comment marks, its code and figure blocks — without the
// Mac's chrome, in a web view the app drives (ios/Doklin/NoteEditor.swift).
// The same serializer writes what the Mac writes, so a note edited on the
// phone never comes back to the Mac as a diff of reformatting.
//
// What the phone hands in is the file as it is on disk. The frontmatter is
// split off before the editor sees it and put back byte for byte on every
// write (src/frontmatter.ts); comment markers are expanded with their bodies
// from the meta file, as the Mac does, and written back as bare markers
// (src/metaFile.ts). Nothing here fetches: the app serves this page and the
// workspace's pictures itself, and blocks every other load.
//
// The bridge (change both sides with NoteEditor.swift):
//   native → page   window.doklin.load({markdown, meta, block, prefix})
//                   window.doklin.command(name)    bold, italic, strike, code,
//                     text, heading1…3, bullet, ordered, todo, quote,
//                     codeBlock, indent, outdent, undo, redo
//                   window.doklin.markdown()       what a write now would hold
//                   window.doklin.editable(on)     off while another device holds it
//                   window.doklin.blur()
//   page → native   {kind: "ready"} once, {kind: "loaded", markdown} (the
//                   baseline: the note as the editor would write it),
//                   {kind: "changed", markdown}, {kind: "selection", marks,
//                   block}, {kind: "failed", message}

import { Crepe } from "@milkdown/crepe";
import { commandsCtx, editorViewCtx } from "@milkdown/kit/core";
import { codeBlockConfig, CodeMirrorBlock } from "@milkdown/kit/component/code-block";
import {
  createCodeBlockCommand,
  liftListItemCommand,
  sinkListItemCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleStrongCommand,
  turnIntoTextCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand,
} from "@milkdown/kit/preset/commonmark";
import { toggleStrikethroughCommand } from "@milkdown/kit/preset/gfm";
import { redoCommand, undoCommand } from "@milkdown/kit/plugin/history";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { isMermaidLanguage, mermaidLanguage, queueMermaidPreview, MERMAID_PREVIEW_LOADING } from "../mermaid";
import { drawingLanguage, drawingPreview, isDrawingLanguage } from "../drawing";
import { criticCommentSchema, criticRemark } from "../criticMark";
import { inlineCodeNewlines } from "../inlineCodeNewlines";
import { codeTheme } from "../codeTheme";
import { splitFrontmatter } from "../frontmatter";
import { expandMarkdown, extractMarkdown, markerIds, parseEntityMeta } from "../metaFile";

import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import "../styles/tokens.css";
import "./editor.css";

// As on the Mac (src/Editor.tsx): a code block's editor, once mounted, stays.
CodeMirrorBlock.TEARDOWN_DELAY = 2 ** 31 - 1;

export type Load = {
  /** The file, as it is on disk. */
  markdown: string;
  /** Where the note's pictures are, relative to: its folder, as the app
   *  serves the workspace (`/doc/<folder>/`). */
  base: string | null;
  /** Its `<stem>.meta.jsonl`, for the comments' bodies; null when it has none. */
  meta: string | null;
  /** The top-level block to start at, counted from 0; null for the top. */
  block: number | null;
  /** What that block's text begins with: the check that it is the one meant. */
  prefix: string | null;
};

type Message =
  | { kind: "ready" }
  | { kind: "loaded"; markdown: string }
  | { kind: "changed"; markdown: string }
  | { kind: "selection"; marks: string[]; block: string }
  | { kind: "failed"; message: string };

type Native = { postMessage(message: Message): void };

function post(message: Message) {
  const native = (window as unknown as { webkit?: { messageHandlers?: { doklin?: Native } } }).webkit?.messageHandlers
    ?.doklin;
  if (native) native.postMessage(message);
  else (window as unknown as { doklinMessages?: Message[] }).doklinMessages?.push(message);
}

let crepe: Crepe | null = null;
/** The frontmatter block as the file has it: put back on every write. */
let head = "";
/** The note carried comment bodies inline, which the meta file may not
 *  hold: it is written back in that form, so nothing of them is lost. */
let keepInline = false;

/** What the file would hold: the frontmatter, then the editor's markdown
 *  with its comments as bare markers. */
function toDisk(editorMarkdown: string): string {
  return head + (keepInline ? editorMarkdown : extractMarkdown(editorMarkdown).md);
}

function view(): EditorView | null {
  if (!crepe) return null;
  try {
    return crepe.editor.ctx.get(editorViewCtx);
  } catch {
    return null;
  }
}

async function load(input: Load): Promise<void> {
  try {
    if (crepe) {
      await crepe.destroy();
      crepe = null;
    }
    const root = document.getElementById("editor");
    if (!root) throw new Error("the page has no editor");
    root.replaceChildren();
    const base = document.querySelector("base") ?? document.head.appendChild(document.createElement("base"));
    base.href = input.base ?? "/";
    const fm = splitFrontmatter(input.markdown);
    head = fm.head;
    keepInline = extractMarkdown(fm.body).mthreads.length > 0;
    const threads = input.meta ? parseEntityMeta(input.meta).mthreads : [];
    const editor = new Crepe({
      root,
      defaultValue: expandMarkdown(fm.body, threads).md,
      // The phone's own bar does what the Mac's floating toolbar and block
      // handle do; what the document is read and written as is the same.
      features: {
        [Crepe.Feature.Toolbar]: false,
        [Crepe.Feature.BlockEdit]: false,
        [Crepe.Feature.TopBar]: false,
        [Crepe.Feature.AI]: false,
      },
      featureConfigs: {
        [Crepe.Feature.CodeMirror]: { theme: codeTheme },
        placeholder: { text: "Write something…", mode: "doc" },
      },
    });
    editor.editor.config((ctx) => {
      ctx.update(codeBlockConfig.key, (prev) => ({
        ...prev,
        languages: [...prev.languages, mermaidLanguage, drawingLanguage(prev.languages)],
        previewLoading: MERMAID_PREVIEW_LOADING,
        renderPreview: (language, content, applyPreview) => {
          if (isDrawingLanguage(language)) {
            if (!content.trim()) return null;
            return drawingPreview(content);
          }
          if (isMermaidLanguage(language)) {
            if (!content.trim()) return null;
            queueMermaidPreview(content, applyPreview);
            return undefined;
          }
          return prev.renderPreview(language, content, applyPreview);
        },
      }));
    });
    editor.editor.use([...criticCommentSchema, ...criticRemark]);
    editor.editor.use([...inlineCodeNewlines]);
    editor.on((api) => {
      api.markdownUpdated((_ctx, markdown) => post({ kind: "changed", markdown: toDisk(markdown) }));
      api.selectionUpdated(() => report());
    });
    await editor.create();
    crepe = editor;
    // Every comment the note has must come out of the editor again: one
    // whose marker would not (its body is missing from the meta file) makes
    // the note one to read here, not to edit.
    const kept = markerIds(extractMarkdown(editor.getMarkdown()).md);
    const lost = [...markerIds(extractMarkdown(fm.body).md)].filter((id) => !kept.has(id));
    if (lost.length > 0) {
      await editor.destroy();
      crepe = null;
      root.replaceChildren();
      post({ kind: "failed", message: "Editing this note here would lose some of its comments, so it can only be read on this iPhone." });
      return;
    }
    // The baseline: what the note reads as once the editor has it. Saving
    // is measured from this, so opening a note never rewrites it.
    post({ kind: "loaded", markdown: toDisk(editor.getMarkdown()) });
    const v = view();
    if (v) {
      place(v, input.block, input.prefix);
      v.focus();
    }
    report();
  } catch (error) {
    post({ kind: "failed", message: error instanceof Error ? error.message : String(error) });
  }
}

/** Put the caret at the start of the top-level block the reader was on —
 *  found by its index, checked by its first words, found by them when the
 *  two parsers count blocks differently — and bring it into view. */
function place(v: EditorView, block: number | null, prefix: string | null) {
  const doc = v.state.doc;
  if (block === null || doc.childCount === 0) return;
  const wanted = (prefix ?? "").trim().slice(0, 40);
  const fits = (index: number) => index < doc.childCount && doc.child(index).textContent.trim().startsWith(wanted);
  let index = Math.min(block, doc.childCount - 1);
  if (wanted && !fits(index)) {
    for (let i = 0; i < doc.childCount; i++) {
      if (fits(i)) {
        index = i;
        break;
      }
    }
  }
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  const selection = TextSelection.near(doc.resolve(Math.min(pos + 1, doc.content.size)));
  v.dispatch(v.state.tr.setSelection(selection));
  try {
    const at = v.domAtPos(selection.from);
    const element = at.node.nodeType === Node.TEXT_NODE ? at.node.parentElement : (at.node as HTMLElement);
    element?.scrollIntoView({ block: "start" });
  } catch {
    // a position that can't be shown yet: the top it is
  }
}

/** Tell the bar which marks and which kind of block the caret is in. */
let reporting = false;
function report() {
  if (reporting) return;
  reporting = true;
  requestAnimationFrame(() => {
    reporting = false;
    const v = view();
    if (!v) return;
    const { selection, storedMarks } = v.state;
    const marks = new Set<string>();
    if (selection.empty) {
      for (const mark of storedMarks ?? selection.$from.marks()) marks.add(mark.type.name);
    } else {
      v.state.doc.nodesBetween(selection.from, selection.to, (node) => {
        for (const mark of node.marks) marks.add(mark.type.name);
      });
    }
    post({ kind: "selection", marks: [...marks], block: blockAt(v) });
  });
}

function blockAt(v: EditorView): string {
  const $from = v.state.selection.$from;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    switch (node.type.name) {
      case "list_item":
        if (node.attrs.checked !== null && node.attrs.checked !== undefined) return "todo";
        return node.attrs.listType === "ordered" ? "ordered" : "bullet";
      case "blockquote":
        return "quote";
      case "code_block":
        return "codeBlock";
      case "heading":
        return `heading${node.attrs.level}`;
    }
  }
  return "text";
}

/** One thing the bar asked for. */
function command(name: string) {
  if (!crepe) return;
  const ctx = crepe.editor.ctx;
  const commands = ctx.get(commandsCtx);
  switch (name) {
    case "bold":
      commands.call(toggleStrongCommand.key);
      break;
    case "italic":
      commands.call(toggleEmphasisCommand.key);
      break;
    case "strike":
      commands.call(toggleStrikethroughCommand.key);
      break;
    case "code":
      commands.call(toggleInlineCodeCommand.key);
      break;
    case "text":
      commands.call(turnIntoTextCommand.key);
      break;
    case "heading1":
    case "heading2":
    case "heading3":
      commands.call(wrapInHeadingCommand.key, Number(name.slice(-1)));
      break;
    case "bullet":
      commands.call(wrapInBulletListCommand.key);
      break;
    case "ordered":
      commands.call(wrapInOrderedListCommand.key);
      break;
    case "todo":
      todo();
      break;
    case "quote":
      commands.call(wrapInBlockquoteCommand.key);
      break;
    case "codeBlock":
      commands.call(createCodeBlockCommand.key);
      break;
    case "indent":
      commands.call(sinkListItemCommand.key);
      break;
    case "outdent":
      commands.call(liftListItemCommand.key);
      break;
    case "undo":
      commands.call(undoCommand.key);
      break;
    case "redo":
      commands.call(redoCommand.key);
      break;
  }
  view()?.focus();
  report();
}

/** A to-do: the block as a list item with an unticked box. */
function todo() {
  const v = view();
  if (!v || !crepe) return;
  const inItem = () => {
    const $from = v.state.selection.$from;
    for (let depth = $from.depth; depth > 0; depth--) {
      if ($from.node(depth).type.name === "list_item") return depth;
    }
    return null;
  };
  if (inItem() === null) crepe.editor.ctx.get(commandsCtx).call(wrapInBulletListCommand.key);
  const depth = inItem();
  if (depth === null) return;
  const $from = v.state.selection.$from;
  const item = $from.node(depth);
  const checked = item.attrs.checked === null || item.attrs.checked === undefined ? false : null;
  const at = v.state.selection.from;
  v.dispatch(v.state.tr.setNodeMarkup($from.before(depth), undefined, { ...item.attrs, checked }));
  // The item is drawn again, with its box, after this: then the caret goes
  // back where it was.
  const back = () => {
    const doc = v.state.doc;
    v.dispatch(v.state.tr.setSelection(TextSelection.near(doc.resolve(Math.min(at, doc.content.size)))));
    v.focus();
  };
  setTimeout(back, 0);
}

/** The light or dark palette, as the phone is set. */
function theme() {
  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => (document.documentElement.dataset.theme = dark.matches ? "dark" : "light");
  apply();
  dark.addEventListener("change", apply);
}

theme();

declare global {
  interface Window {
    doklin: {
      load: (input: Load) => Promise<void>;
      command: (name: string) => void;
      markdown: () => string | null;
      editable: (on: boolean) => void;
      blur: () => void;
    };
  }
}

window.doklin = {
  load,
  command,
  markdown: () => (crepe ? toDisk(crepe.getMarkdown()) : null),
  editable: (on: boolean) => crepe?.setReadonly(!on),
  blur: () => {
    const v = view();
    if (v) (v.dom as HTMLElement).blur();
  },
};

post({ kind: "ready" });
