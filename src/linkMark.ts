// Links to documents inside the editor.
//
// A link to another document of the workspace stays Crepe's link mark; it
// only carries one more attribute, `doklin`: the id of the file it means,
// and what it was read and shown as (`LinkFile`). Nothing new is drawn, and
// one that can't be opened here is greyed out.
//
// - **Reading a note.** The editor is handed the note as its file has it
//   and the link records of its sidecar (`setLinkRecords`). Each link with a
//   record gets its file's id, and is shown where its file is now: its
//   destination from this note, a named link's words the file's name now
//   (`shownLink`, src/docLinks.ts). That happens before the editor reports
//   its first markdown, which the app takes as the note's baseline, so
//   opening a note never makes it unsaved.
// - **What the editor hands back** is the note as a save writes it, every
//   link as *What a save writes* says (`linksToSave`), then a line with the
//   records the sidecar is to hold (`recordsLine`). The app splits that line
//   off before anything is written (`splitLinkRecords`). Read back in (a
//   pane mounted again from what the editor said), the line gives the
//   records again.
// - **A rename while the note is open** shows each link where its file is
//   now (`relinkDocument`), without a step in the undo history.
// - **Copy and paste.** What is copied is the note's markdown, with the
//   records beside it in a type of the app's own: pasted into another note
//   of the workspace, each link keeps its file and leads there from the
//   note it lands in. Anywhere else gets the plain markdown.
//
// Like every serializer handler here, the one that writes links keeps no
// state between runs (src/criticMark.ts says why).

import type { Ctx } from "@milkdown/kit/ctx";
import { editorViewOptionsCtx, parserCtx, schemaCtx, serializerCtx } from "@milkdown/kit/core";
import { linkAttr, linkSchema } from "@milkdown/kit/preset/commonmark";
import { Slice, type Mark, type Node as ProseNode } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey, TextSelection, type Transaction } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import { $ctx, $prose, $remark } from "@milkdown/kit/utils";
import {
  documentName,
  keyTarget,
  linkKey,
  linksToSave,
  recordsLine,
  relativePath,
  shownLink,
  splitLinkRecords,
  takeRecordsLine,
  type DocumentIndex,
  type NoteLink,
  type WorkspaceDocument,
  type ShareNamed,
} from "./docLinks";
import type { LinkRecord } from "./metaFile";

/** What a link to a document carries in the editor. `href` and `words` are
 *  what the editor showed it as; a link whose address is changed by hand no
 *  longer means `file`, and words changed by hand are the author's. `wrote`
 *  and `said` are the address and words the note has, when they are not
 *  the ones shown. */
export type LinkFile = {
  file: string;
  /** Picked from the `@` list or pasted in this editor: kept by its id. */
  made: boolean;
  href: string;
  words: string;
  wrote: string | null;
  said: string | null;
};

/** Where the editor's note is, and the workspace's documents, for its
 *  links. `note` null: a note with no place in a workspace (untitled), whose
 *  links are left as written. `docs` null: not listed yet. */
export type LinkContext = {
  note: { path: string; section: string | null } | null;
  docs: DocumentIndex | null;
  /** Workspace-relative paths, latest change first (the `@` list's order). */
  recent: string[];
  /** The workspace's name, for who can open a document. */
  workspace: string;
  /** What is shared, by its section's id, where the app knows: what the
   *  `@` list names when it says who can open a document. */
  shares?: ReadonlyMap<string, ShareNamed>;
  /** Where the `@` list shows: under the caret, or above an on-screen
   *  keyboard (the iPhone). */
  placement: "caret" | "keyboard";
  /** Tell the author something about a pick (`pickNotice`). */
  notify: (message: string) => void;
};

export const NO_LINKS: LinkContext = { note: null, docs: null, recent: [], workspace: "", placement: "caret", notify: () => {} };

export const linkContextCtx = $ctx<LinkContext, "doklinLinkContext">(NO_LINKS, "doklinLinkContext");

/** The note's link records, for the one parse that reads it in; taken by
 *  that parse, so a paste later never reads them. */
const loadRecordsCtx = $ctx<LinkRecord[] | null, "doklinLoadRecords">(null, "doklinLoadRecords");

/** Where pasted markdown was copied from, for the parse of the paste. */
type PasteSource = { from: string | null; records: LinkRecord[] };
const pasteSourceCtx = $ctx<PasteSource | null, "doklinPasteSource">(null, "doklinPasteSource");

/** The clipboard type a copy puts its links' records in. */
const LINKS_TYPE = "application/x-doklin-links";

export function setLinkRecords(ctx: Ctx, records: LinkRecord[]) {
  ctx.set(loadRecordsCtx.key, records);
}

/* ---------- mdast ---------- */

type MdNode = {
  type: string;
  value?: string;
  url?: string;
  alt?: string;
  children?: MdNode[];
  doklin?: LinkFile;
};

const plainText = (n: MdNode): string =>
  n.type === "html" ? "" : typeof n.value === "string" ? n.value : n.type === "image" ? (n.alt ?? "") : (n.children ?? []).map(plainText).join("");

function linkNodes(tree: MdNode): MdNode[] {
  const out: MdNode[] = [];
  const walk = (n: MdNode) => {
    if (n.type === "link" && typeof n.url === "string" && linkKey(n.url) !== null) out.push(n);
    n.children?.forEach(walk);
  };
  walk(tree);
  return out;
}

const destinationRest = (href: string): string => {
  const at = href.trim().search(/[#?]/);
  return at < 0 ? "" : href.trim().slice(at);
};

/** The note as read in: its records line taken off, and each link with a
 *  record given its file and shown where that file is now. A paste's links
 *  lead from the note they land in to where they led, and keep their
 *  records as made here. */
function readLinks(tree: MdNode, ctx: Ctx) {
  let records: LinkRecord[] | null = null;
  const last = tree.children?.[tree.children.length - 1];
  if (last?.type === "html" && typeof last.value === "string") {
    const taken = takeRecordsLine(last.value);
    if (taken) {
      records = taken.records;
      if (taken.rest.trim() === "") tree.children!.pop();
      else last.value = taken.rest.trimEnd();
    }
  }
  const loading = ctx.get(loadRecordsCtx.key);
  if (loading !== null) ctx.set(loadRecordsCtx.key, null);
  const paste = ctx.get(pasteSourceCtx.key);
  const { note, docs } = ctx.get(linkContextCtx.key);

  if (paste) {
    for (const node of linkNodes(tree)) {
      const key = linkKey(node.url!)!;
      const target = paste.from === null ? null : keyTarget(key, paste.from);
      const href = note && target ? relativePath(note.path, target) + destinationRest(node.url!) : node.url!;
      node.url = href;
      const record = paste.records.find((r) => r.id === key);
      if (record) node.doklin = { file: record.file, made: true, href, words: plainText(node), wrote: null, said: null };
    }
    return;
  }
  records = records ?? loading;
  if (!records || records.length === 0) return;
  for (const node of linkNodes(tree)) {
    const key = linkKey(node.url!)!;
    const record = records.find((r) => r.id === key);
    if (!record) continue;
    const written = { href: node.url!, words: plainText(node) };
    const doc = docs?.byId.get(record.file);
    const shown = doc && note ? shownLink(note.path, written, doc) : written;
    node.url = shown.href;
    if (shown.words !== written.words) node.children = [{ type: "text", value: shown.words }];
    node.doklin = {
      file: record.file,
      made: false,
      href: shown.href,
      words: shown.words,
      wrote: shown.href === written.href ? null : written.href,
      said: shown.words === written.words ? null : written.words,
    };
  }
}

/** Each link written as a save writes it; the records the sidecar is to
 *  hold. The tree is the serializer's own for this run. */
function writeLinks(tree: MdNode, ctx: Ctx): LinkRecord[] {
  const { note, docs } = ctx.get(linkContextCtx.key);
  const nodes = linkNodes(tree);
  if (nodes.length === 0) return [];
  const links: NoteLink[] = [];
  const records: LinkRecord[] = [];
  const words = nodes.map(plainText);
  nodes.forEach((node, i) => {
    const d = node.doklin;
    if (!d || node.url !== d.href) {
      links.push({ href: node.url!, words: words[i] });
      return;
    }
    const href = d.wrote ?? d.href;
    const said = d.said !== null && words[i] === d.words ? d.said : words[i];
    if (d.made) {
      links.push({ href, words: said, made: d.file });
    } else {
      links.push({ href, words: said });
      records.push({ id: linkKey(href)!, file: d.file });
    }
  });
  if (!note) {
    // No place to write links from: as they are, each with its record.
    nodes.forEach((node, i) => setLink(node, links[i], words[i]));
    return dedupe([...records, ...links.flatMap((l) => (l.made ? [{ id: linkKey(l.href)!, file: l.made }] : []))]);
  }
  const saved = linksToSave(note, links, records, docs ?? EMPTY_INDEX);
  nodes.forEach((node, i) => setLink(node, saved.links[i], words[i]));
  return saved.records;
}

const EMPTY_INDEX: DocumentIndex = { list: [], byId: new Map(), byPath: new Map() };

function setLink(node: MdNode, link: { href: string; words: string }, words: string) {
  node.url = link.href;
  if (link.words !== words) node.children = [{ type: "text", value: link.words }];
  delete node.doklin;
}

function dedupe(records: LinkRecord[]): LinkRecord[] {
  const seen = new Set<string>();
  return records.filter((r) => !seen.has(r.id) && (seen.add(r.id), true));
}

const PHRASING = new Set(["text", "emphasis", "strong", "delete", "link", "inlineCode", "image", "break", "criticComment"]);

/** Both directions in one remark plugin: read links in as a note is parsed,
 *  write them out (and the records line after them) as it is serialized. */
export const linkRemark = $remark("doklinLinks", (ctx) => {
  // A normal `function`, so `this` is the unified processor.
  return function (this: any) {
    const data = this.data();
    const extensions = data.toMarkdownExtensions || (data.toMarkdownExtensions = []);
    extensions.push({
      handlers: {
        root(node: MdNode, _parent: unknown, state: any, info: unknown) {
          const records = writeLinks(node, ctx);
          const phrasing = (node.children ?? []).some((c) => PHRASING.has(c.type));
          const body: string = phrasing ? state.containerPhrasing(node, info) : state.containerFlow(node, info);
          const line = recordsLine(records);
          return line ? `${body}\n\n${line}` : body;
        },
      },
    });
    return (tree: unknown) => readLinks(tree as MdNode, ctx);
  };
});

/* ---------- The mark ---------- */

const isLinkFile = (v: unknown): boolean => {
  if (v === null) return true;
  const d = v as LinkFile;
  return (
    !!d &&
    typeof d.file === "string" &&
    typeof d.made === "boolean" &&
    typeof d.href === "string" &&
    typeof d.words === "string" &&
    (d.wrote === null || typeof d.wrote === "string") &&
    (d.said === null || typeof d.said === "string")
  );
};

/** Crepe's link mark, with the file a link to a document means. */
export function configureLinkMark(ctx: Ctx) {
  ctx.update(linkSchema.key, (prev) => (c) => {
    const base = prev(c);
    return {
      ...base,
      attrs: {
        ...base.attrs,
        doklin: {
          default: null,
          validate: (v: unknown) => {
            if (!isLinkFile(v)) throw new RangeError("invalid link file");
          },
        },
      },
      // The id is the app's: nothing of it goes into the page.
      toDOM: (mark: Mark) => ["a", { ...c.get(linkAttr.key)(mark), href: mark.attrs.href, title: mark.attrs.title }],
      parseMarkdown: {
        match: (node: { type: string }) => node.type === "link",
        runner: (state: any, node: any, markType: any) => {
          state.openMark(markType, { href: node.url as string, title: (node.title as string) ?? null, doklin: (node.doklin as LinkFile) ?? null });
          state.next(node.children);
          state.closeMark(markType);
        },
      },
      toMarkdown: {
        match: (mark: Mark) => mark.type.name === "link",
        runner: (state: any, mark: Mark) => {
          state.withMark(mark, "link", undefined, {
            title: mark.attrs.title,
            url: mark.attrs.href,
            ...(mark.attrs.doklin ? { doklin: mark.attrs.doklin } : {}),
          });
        },
      },
    };
  });
}

/* ---------- Links on screen ---------- */

/** Each run of one link mark in the document, last first. */
function linkRuns(doc: ProseNode): { from: number; to: number; mark: Mark }[] {
  const runs: { from: number; to: number; mark: Mark }[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const mark = node.marks.find((m) => m.type.name === "link");
    if (!mark) return;
    const last = runs[runs.length - 1];
    if (last && last.to === pos && last.mark.eq(mark)) last.to = pos + node.nodeSize;
    else runs.push({ from: pos, to: pos + node.nodeSize, mark });
  });
  return runs.reverse();
}

const closedKey = new PluginKey<DecorationSet>("doklin-link-closed");

/** A link whose file isn't one this person can open here: greyed out. */
export function isClosed(d: LinkFile | null, ctx: LinkContext): boolean {
  return !!d && !!ctx.docs && !ctx.docs.byId.has(d.file);
}

/** Whether the note has a link to `href` that can't be opened here. */
export function hasClosedLink(view: EditorView, href: string, ctx: LinkContext): boolean {
  return linkRuns(view.state.doc).some((r) => r.mark.attrs.href === href && isClosed(r.mark.attrs.doklin as LinkFile | null, ctx));
}

function closedDecorations(doc: ProseNode, ctx: LinkContext): DecorationSet {
  if (!ctx.docs) return DecorationSet.empty;
  const decos = linkRuns(doc)
    .filter((r) => isClosed(r.mark.attrs.doklin as LinkFile | null, ctx))
    .map((r) => Decoration.inline(r.from, r.to, { class: "doc-link-closed" }));
  return DecorationSet.create(doc, decos);
}

export const linkClosedPlugin = $prose(
  (ctx) =>
    new Plugin<DecorationSet>({
      key: closedKey,
      state: {
        init: (_, state) => closedDecorations(state.doc, ctx.get(linkContextCtx.key)),
        apply: (tr, old) =>
          tr.docChanged || tr.getMeta(closedKey) ? closedDecorations(tr.doc, ctx.get(linkContextCtx.key)) : old,
      },
      props: { decorations: (state) => closedKey.getState(state) },
    }),
);

/**
 * Show each link with a file where that file is now, after the documents
 * or the note's own place changed. The step stays out of the undo history:
 * undoing an edit never puts an old name back. False when nothing changed.
 */
export function relinkDocument(view: EditorView, ctx: LinkContext): boolean {
  const { note, docs } = ctx;
  let tr: Transaction = view.state.tr;
  let changed = false;
  if (note && docs) {
    for (const run of linkRuns(view.state.doc)) {
      const d = run.mark.attrs.doklin as LinkFile | null;
      if (!d || run.mark.attrs.href !== d.href) continue;
      const doc = docs.byId.get(d.file);
      if (!doc) continue;
      const words = view.state.doc.textBetween(run.from, run.to);
      const written = { href: d.wrote ?? d.href, words: d.said !== null && words === d.words ? d.said : words };
      const shown = shownLink(note.path, written, doc);
      const shownWords = words === d.words ? shown.words : words;
      if (shown.href === d.href && shownWords === words) continue;
      const mark = run.mark.type.create({
        ...run.mark.attrs,
        href: shown.href,
        doklin: {
          ...d,
          href: shown.href,
          words: shownWords,
          wrote: shown.href === written.href ? null : written.href,
          said: shownWords === written.words ? null : written.words,
        } satisfies LinkFile,
      });
      if (shownWords !== words) {
        // The words as one run, with the marks the link's first run has.
        const marks = run.mark.removeFromSet(view.state.doc.nodeAt(run.from)?.marks ?? []);
        tr = tr.replaceWith(run.from, run.to, view.state.schema.text(shownWords, mark.addToSet(marks)));
      } else {
        tr = tr.removeMark(run.from, run.to, run.mark).addMark(run.from, run.to, mark);
      }
      changed = true;
    }
  }
  tr.setMeta(closedKey, true);
  if (changed) tr.setMeta("addToHistory", false);
  view.dispatch(tr);
  return changed;
}

/**
 * Put a named link to `doc` in place of `from`–`to`, and a space after it,
 * with the caret past the space: what picking a document from the `@` list
 * does. The link keeps the file's id, as one made here.
 */
export function insertDocumentLink(view: EditorView, from: number, to: number, doc: WorkspaceDocument, ctx: LinkContext) {
  const { schema } = view.state;
  const words = documentName(doc.path);
  const href = ctx.note ? relativePath(ctx.note.path, doc.path) : doc.path;
  const doklin: LinkFile | null = doc.fileId ? { file: doc.fileId, made: true, href, words, wrote: null, said: null } : null;
  const link = schema.marks.link.create({ href, title: null, doklin });
  const around = view.state.doc.resolve(from).marks().filter((m) => m.type !== schema.marks.link);
  const tr = view.state.tr.replaceWith(from, to, [schema.text(words, link.addToSet(around)), schema.text(" ", around)]);
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from + words.length + 1)).setStoredMarks(around).scrollIntoView());
}

/* ---------- Copy and paste ---------- */

/** The clipboard's text for markdown the editor wrote, and the records its
 *  links had, for a paste into another note. */
export function clipboardOf(editorMarkdown: string, ctx: LinkContext): { text: string; links: string | null } {
  const { md, records } = splitLinkRecords(editorMarkdown);
  const links = ctx.note || records.length > 0 ? JSON.stringify({ from: ctx.note?.path ?? null, records }) : null;
  return { text: md, links };
}

export { LINKS_TYPE };

const readPasteSource = (raw: string): PasteSource | null => {
  try {
    const v = JSON.parse(raw) as { from?: unknown; records?: unknown };
    if (!Array.isArray(v.records)) return null;
    const records = v.records.filter(
      (r): r is LinkRecord => !!r && typeof (r as LinkRecord).id === "string" && typeof (r as LinkRecord).file === "string",
    );
    return { from: typeof v.from === "string" ? v.from : null, records };
  } catch {
    return null;
  }
};

/** Plain text, no marks: what a selection inside one line is. */
const isPlainText = (slice: Slice): boolean => {
  let plain = true;
  slice.content.descendants((node) => {
    if (node.isText ? node.marks.length > 0 : node.type.name !== "paragraph") plain = false;
    return plain;
  });
  return plain;
};

/**
 * The clipboard, both ways. A paste of markdown copied from a note of this
 * app: its links keep their files, and lead from this note to where they
 * led. Any text the view puts on a clipboard itself (a drag out of the
 * editor) is the markdown without the records line. Both are the view's own
 * props, asked before any plugin's (Milkdown's clipboard plugin).
 */
export function configureLinkClipboard(ctx: Ctx) {
  ctx.update(editorViewOptionsCtx, (prev) => ({
    ...prev,
    clipboardTextSerializer: (slice: Slice) => {
      if (isPlainText(slice)) return slice.content.textBetween(0, slice.content.size, "\n\n");
      const doc = ctx.get(schemaCtx).topNodeType.createAndFill(undefined, slice.content);
      return doc ? splitLinkRecords(ctx.get(serializerCtx)(doc)).md : "";
    },
    handlePaste: (view: EditorView, event: ClipboardEvent, slice: Slice) => {
      if (prev.handlePaste?.(view, event, slice)) return true;
      const data = event.clipboardData;
      const raw = data?.getData(LINKS_TYPE);
      const text = data?.getData("text/plain");
      if (!raw || !text || !view.editable) return false;
      if (view.state.selection.$from.parent.type.spec.code) return false;
      const source = readPasteSource(raw);
      if (!source) return false;
      ctx.set(pasteSourceCtx.key, source);
      let doc: ProseNode | string;
      try {
        doc = ctx.get(parserCtx)(text);
      } finally {
        ctx.set(pasteSourceCtx.key, null);
      }
      if (!doc || typeof doc === "string") return false;
      view.dispatch(view.state.tr.replaceSelection(Slice.maxOpen(doc.content)).scrollIntoView());
      return true;
    },
  }));
}

/** Every piece the editor's links need, in the order they are used. */
export const linkPlugins = [linkContextCtx, loadRecordsCtx, pasteSourceCtx, linkRemark, linkClosedPlugin].flat();
