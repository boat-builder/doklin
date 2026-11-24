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
// (src/metaFile.ts). Links to other documents are the Mac's too
// (src/linkMark.ts): each is shown where its file is now, `@` lists the
// workspace's documents above the keyboard, and what the editor hands back
// is the note with the link records its sidecar is to hold. Nothing here
// fetches: the app serves this page and the workspace's pictures itself, and
// blocks every other load.
//
// The bridge (change both sides with NoteEditor.swift):
//   native → page   window.doklin.load({markdown, meta, note, documents,
//                     recent, workspace, block, prefix})
//                   window.doklin.documents(list)  the workspace's documents changed
//                   window.doklin.command(name)    bold, italic, strike, code,
//                     text, heading1…3, bullet, ordered, todo, quote,
//                     codeBlock, indent, outdent, undo, redo
//                   window.doklin.markdown()       what a write now would hold
//                   window.doklin.editable(on)     off while another device holds it
//                   window.doklin.blur()
//   page → native   {kind: "ready"} once, {kind: "loaded", markdown, links}
//                   (the baseline: the note as the editor would write it),
//                   {kind: "changed", markdown, links}, {kind: "relinked",
//                   markdown, links} (its links shown anew: not an edit),
//                   {kind: "selection", marks, block}, {kind: "notice",
//                   message}, {kind: "failed", message}
// `links` are the records the note's sidecar is to hold, `[id, file]` each.

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
import {
  FLOWCHART_PREVIEW_WAITING,
  flowchartPreview,
  isMermaidLanguage,
  mermaidLanguage,
  relayFlowcharts,
} from "../flowchartBlock";
import { drawingLanguage, drawingPreview, isDrawingLanguage } from "../drawing";
import { criticCommentSchema, criticRemark } from "../criticMark";
import { inlineCodeNewlines } from "../inlineCodeNewlines";
import { codeTheme } from "../codeTheme";
import { splitFrontmatter } from "../frontmatter";
import { expandMarkdown, extractMarkdown, markerIds, parseEntityMeta } from "../metaFile";
import { CALLOUT_PICK_EVENT, calloutPlugins, removeCallout, setCalloutKind, type CalloutPickDetail } from "../callout";
import { CALLOUTS, CALLOUT_KINDS, calloutIconSvg } from "../calloutTypes";
import { criticCopyPlugin } from "../criticPlugin";
import { indexDocuments, sectionOf, splitLinkRecords, type WorkspaceDocument } from "../docLinks";
import {
  configureLinkClipboard,
  configureLinkMark,
  linkContextCtx,
  linkPlugins,
  NO_LINKS,
  relinkDocument,
  setLinkRecords,
  type LinkContext,
} from "../linkMark";
import { mentionPlugin } from "../mentionMenu";

import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import "../styles/tokens.css";
import "../styles/docLinks.css";
import "./editor.css";

// As on the Mac (src/Editor.tsx): a code block's editor, once mounted, stays.
CodeMirrorBlock.TEARDOWN_DELAY = 2 ** 31 - 1;

export type Load = {
  /** The file, as it is on disk. */
  markdown: string;
  /** Where the note's pictures are, relative to: its folder, as the app
   *  serves the workspace (`/doc/<folder>/`). */
  base: string | null;
  /** Its `<stem>.meta.jsonl`, for the comments' bodies and the links'
   *  records; null when it has none. */
  meta: string | null;
  /** Where it is in the workspace, workspace-relative. */
  note: string;
  /** The workspace's documents (`cloud_documents`), what changed lately
   *  (workspace-relative paths, latest first), and its name. */
  documents: WorkspaceDocument[];
  recent: string[];
  workspace: string;
  /** The top-level block to start at, counted from 0; null for the top. */
  block: number | null;
  /** What that block's text begins with: the check that it is the one meant. */
  prefix: string | null;
};

/** The note as a write would hold it, and its sidecar's link records. */
type Written = { markdown: string; links: [string, string][] };

type Message =
  | { kind: "ready" }
  | ({ kind: "loaded" } & Written)
  | ({ kind: "changed" } & Written)
  | ({ kind: "relinked" } & Written)
  | { kind: "selection"; marks: string[]; block: string }
  | { kind: "notice"; message: string }
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

/** Where the note is and what the workspace holds, for its links. */
let links: LinkContext = NO_LINKS;

/** What the file would hold: the frontmatter, then the editor's markdown
 *  with its comments as bare markers; and the records of its links. */
function toDisk(editorMarkdown: string): Written {
  const { md, records } = splitLinkRecords(editorMarkdown);
  return {
    markdown: head + (keepInline ? md : extractMarkdown(md).md),
    links: records.map((r) => [r.id, r.file]),
  };
}

function contextFor(note: string, documents: WorkspaceDocument[], recent: string[], workspace: string): LinkContext {
  const docs = indexDocuments(documents);
  return {
    note: { path: note, section: sectionOf(note, docs) },
    docs,
    recent,
    workspace,
    placement: "keyboard",
    notify: (message) => post({ kind: "notice", message }),
  };
}

/** How wide the editor's column is: a flowchart is laid out for it, so its words are their real size on a phone. */
function column(): number {
  return document.getElementById("editor")?.clientWidth ?? window.innerWidth;
}
window.addEventListener("resize", () => relayFlowcharts(column()));

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
    const meta = input.meta ? parseEntityMeta(input.meta) : null;
    const threads = meta?.mthreads ?? [];
    links = contextFor(input.note, input.documents, input.recent, input.workspace);
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
        previewLoading: FLOWCHART_PREVIEW_WAITING,
        renderPreview: (language, content, applyPreview) => {
          if (isDrawingLanguage(language)) {
            if (!content.trim()) return null;
            return drawingPreview(content);
          }
          if (isMermaidLanguage(language)) {
            if (!content.trim()) return null;
            return flowchartPreview(content, column(), applyPreview);
          }
          return prev.renderPreview(language, content, applyPreview);
        },
      }));
    });
    editor.editor.use([...criticCommentSchema, ...criticRemark]);
    editor.editor.use([...inlineCodeNewlines]);
    // Callouts, as on the Mac (src/callout.ts); a tap on one's title opens
    // this page's own picker.
    editor.editor.use(calloutPlugins);
    // As on the Mac: links to documents, the `@` list, and a copy that
    // holds the plain markdown (src/Editor.tsx).
    editor.editor.use(linkPlugins);
    editor.editor.use(mentionPlugin);
    editor.editor.use(criticCopyPlugin);
    editor.editor.config((ctx) => {
      configureLinkMark(ctx);
      configureLinkClipboard(ctx);
      ctx.set(linkContextCtx.key, links);
      setLinkRecords(ctx, meta?.links ?? []);
    });
    editor.on((api) => {
      api.markdownUpdated((_ctx, markdown) => post({ kind: "changed", ...toDisk(markdown) }));
      api.selectionUpdated(() => report());
    });
    await editor.create();
    crepe = editor;
    // Every comment the note has must come out of the editor again: one
    // whose marker would not (its body is missing from the meta file) makes
    // the note one to read here, not to edit.
    const kept = markerIds(extractMarkdown(splitLinkRecords(editor.getMarkdown()).md).md);
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
    post({ kind: "loaded", ...toDisk(editor.getMarkdown()) });
    const v = view();
    if (v) {
      v.dom.addEventListener(CALLOUT_PICK_EVENT, (e) => openPicker(v, (e as CustomEvent<CalloutPickDetail>).detail));
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

/** The workspace's documents changed: each link shown where its file is
 *  now. The app hears what the note held first, then what it holds. */
function documents(list: WorkspaceDocument[]) {
  if (!links.note) return;
  links = contextFor(links.note.path, list, links.recent, links.workspace);
  const v = view();
  if (!crepe || !v) return;
  crepe.editor.ctx.set(linkContextCtx.key, links);
  post({ kind: "changed", ...toDisk(crepe.getMarkdown()) });
  if (relinkDocument(v, links)) post({ kind: "relinked", ...toDisk(crepe.getMarkdown()) });
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

/* ---------- The callout picker ----------
   The Mac's (src/CalloutPicker.tsx) on a phone: under the tapped title, one
   44pt row per kind — icon, name, meaning — a check on the current one, then
   Remove callout. A tap outside closes it. This page has no other layers, so
   it keeps its own outside-tap listener. */
let picker: { el: HTMLElement; close: () => void } | null = null;

function openPicker(v: EditorView, detail: CalloutPickDetail) {
  const reopen = picker?.el.dataset.pos === String(detail.pos);
  picker?.close();
  if (reopen) return; // a second tap on the same title closes it
  const el = document.createElement("div");
  el.className = "callout-picker";
  el.dataset.pos = String(detail.pos);
  el.setAttribute("role", "menu");
  const rows = CALLOUT_KINDS.map(
    (k) => `<button type="button" role="menuitemradio" aria-checked="${k === detail.kind}" class="callout-picker-row callout-${k}" data-kind="${k}">
${calloutIconSvg(k, "callout-picker-icon")}<span class="callout-picker-name">${CALLOUTS[k].name}</span>${
      k === detail.kind
        ? '<svg class="callout-picker-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>'
        : "<span></span>"
    }<span class="callout-picker-meaning">${CALLOUTS[k].meaning}</span></button>`,
  ).join("");
  el.innerHTML = `${rows}<div class="callout-picker-sep" role="separator"></div><button type="button" role="menuitem" class="callout-picker-remove">Remove callout</button>`;
  document.body.appendChild(el);
  const r = detail.anchor.getBoundingClientRect();
  el.style.top = `${window.scrollY + r.bottom + 6}px`;
  el.style.left = `${Math.max(8, Math.min(r.left - 4, window.innerWidth - el.offsetWidth - 8))}px`;
  detail.anchor.classList.add("is-open");
  const outside = (e: PointerEvent) => {
    if (!el.contains(e.target as Node) && !detail.anchor.contains(e.target as Node)) close();
  };
  const close = () => {
    window.removeEventListener("pointerdown", outside, true);
    detail.anchor.classList.remove("is-open");
    el.remove();
    picker = null;
  };
  window.addEventListener("pointerdown", outside, true);
  el.addEventListener("mousedown", (e) => e.preventDefault());
  el.addEventListener("click", (e) => {
    const button = (e.target as HTMLElement).closest("button");
    if (!button) return;
    close();
    const kind = button.dataset.kind;
    if (kind) setCalloutKind(v, detail.pos, kind as (typeof CALLOUT_KINDS)[number]);
    else removeCallout(v, detail.pos);
    v.focus();
  });
  picker = { el, close };
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
      documents: (list: WorkspaceDocument[]) => void;
      command: (name: string) => void;
      markdown: () => Written | null;
      editable: (on: boolean) => void;
      blur: () => void;
    };
  }
}

window.doklin = {
  load,
  documents,
  command,
  markdown: () => (crepe ? toDisk(crepe.getMarkdown()) : null),
  editable: (on: boolean) => crepe?.setReadonly(!on),
  blur: () => {
    const v = view();
    if (v) (v.dom as HTMLElement).blur();
  },
};

post({ kind: "ready" });
