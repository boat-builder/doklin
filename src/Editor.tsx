import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Crepe } from "@milkdown/crepe";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import { commandsCtx, editorViewCtx } from "@milkdown/kit/core";
import {
  addBlockTypeCommand,
  clearTextInCurrentBlockCommand,
  codeBlockSchema,
} from "@milkdown/kit/preset/commonmark";
import { codeBlockConfig, CodeMirrorBlock } from "@milkdown/kit/component/code-block";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import {
  isMermaidLanguage,
  mermaidLanguage,
  queueMermaidPreview,
  MERMAID_PREVIEW_LOADING,
} from "./mermaid";
import {
  searchKey,
  searchPlugin,
  getSearchState,
  type SearchInfo,
  type SearchMeta,
} from "./searchPlugin";
import {
  criticActivePlugin,
  criticActiveKey,
  criticCopyPlugin,
  setActiveThread,
} from "./criticPlugin";
import { ghostPlugin, ghostKey, getGhostState, type GhostSegment } from "./ghostText";
import { polishRevertPlugin, revertKey, getRevertEntries } from "./polishRevert";
import { resizableTableView, enableColumnResizing } from "./tableResize";
import { linkOpenPlugin, openInBrowserTab } from "./linkOpen";
import { taskTogglePlugin } from "./taskToggle";
import type { TableCols } from "./tableWidths";
import { inlineCodeNewlines } from "./inlineCodeNewlines";
import {
  criticCommentSchema,
  criticRemark,
  collectThreads,
  getThread,
  createThread,
  updateCommentBody,
  addReply,
  deleteReply,
  deleteThread,
  refreshThreadBodies,
  type CommentEntry,
} from "./criticMark";
import {
  insertStoreEmbed,
  storeEmbedRemark,
  storeEmbedSchema,
  storeEmbedView,
  refreshStoreEmbeds,
  type StoreEmbedHost,
} from "./storeEmbed";
import CommentsRail, { type RailThread, type EditTarget } from "./CommentsRail";

import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";

/* ---------- Code block lifetime ----------
   Crepe's code-block node view lazy-mounts CodeMirror when a block comes
   within 200px of the viewport and tears it back down 5s after it leaves,
   swapping a static <pre> placeholder back in. App.css gives that placeholder
   the mounted editor's exact metrics so the swap costs no height — but a
   DIAGRAM block can't be matched that way: mounted it shows a rendered
   mermaid SVG, torn down it shows the source text, and the two differ by
   hundreds of pixels.

   That mismatch is enough to make the swap self-sustaining. With the block
   just off-screen, a teardown that grows it (source taller than diagram)
   pushes it back inside the observer's 200px margin, which remounts it,
   which shrinks it out of the margin again — so 5s later it tears down once
   more. The reader sees the document jump, forever, on a page nobody is
   touching (verify-harness/blink-idle.*: a 5.03s beat, ~±500px of scroll).

   So once a block is mounted, it stays mounted. What that gives up is a
   memory optimization — one CodeMirror per code block the reader actually
   scrolled past, a handful in a document-sized editor — and what it buys
   back, besides the oscillation, is the jump when scrolling up past a
   diagram. The value must stay a legal setTimeout delay: past 2^31-1 ms
   timers fire immediately, which would bring the teardown back with worse
   timing than it has now. */
CodeMirrorBlock.TEARDOWN_DELAY = 2 ** 31 - 1;

// Document context handed to the dictation polish pass: enough surrounding
// text for the LLM to disambiguate misheard words, never to rewrite them.
export type DictationContext = {
  docText: string;
  headingPath: string;
  before: string;
  after: string;
};

// Imperative handle the host (App) uses to drive in-file search. Setting the
// query is idempotent; next/prev advance the current match and scroll it into
// view. Calls made before the editor has mounted are buffered (see pendingRef).
//
// The dictation* methods drive voice input: begin pins the ghost-text anchor
// at the caret and suspends typing while the pipeline is busy; setGhost
// paints the in-flight transcript; commit inserts finalized text at the
// anchor (one undo step per chunk); end restores normal editing. The
// controller calls begin/end around each utterance batch — between them the
// document is an ordinary editor. insertText types literal text at the caret
// (the talk key doubles as the spacebar when tapped).
//
// When commit gets a `raw` that differs from the polished text, the landed
// range is tracked (see polishRevert.ts): revertPolish swaps every still-
// intact tracked range back to its raw transcript, clearRevert forgets them
// (the controller calls it on each talk-key press).
export type EditorHandle = {
  setSearch: (query: string, caseSensitive: boolean) => void;
  searchNext: () => void;
  searchPrev: () => void;
  clearSearch: () => void;
  insertText: (text: string) => void;
  dictationBegin: () => boolean;
  dictationSetGhost: (segments: GhostSegment[]) => void;
  dictationCommit: (text: string, raw?: string) => void;
  dictationRevertPolish: () => number;
  dictationClearRevert: () => void;
  dictationEnd: () => void;
  dictationContext: () => DictationContext | null;
  // Create a comment thread on the current selection (the same act as the
  // toolbar's Comment button). Read-only hosts use this: Crepe suppresses its
  // selection toolbar there, so they provide their own affordance and route
  // it here. Returns false when there's nothing usable selected.
  commentSelection: () => boolean;
  // Swap thread bodies in place (external meta change — a teammate's reply
  // arriving through sync). Caret-safe, history-free; see criticMark.ts.
  refreshThreadBodies: (bodies: Map<string, CommentEntry[]>) => void;
};

// Markdown threads whose meta record lost its marker (deleted in another
// editor, an old revision restored): shown as orphan cards at the top of the
// rail — never silently dropped — with their mutations routed to the host
// (they live in the entity meta file, not in the document).
export type OrphanOps = {
  threads: { id: string; comments: CommentEntry[] }[];
  onReply: (id: string, author: string, body: string) => void;
  onDeleteThread: (id: string) => void;
  onDeleteReply: (id: string, index: number) => void;
  onUpdateBody: (id: string, index: number, body: string) => void;
};

type Props = {
  initialMarkdown: string;
  onChange: (markdown: string) => void;
  onSearchState?: (info: SearchInfo) => void;
  onFocusChange?: (focused: boolean) => void;
  // Fires once the ProseMirror view exists with the full document rendered —
  // the earliest point DOM-level work (e.g. restoring scroll) can stick.
  onReady?: () => void;
  // Comments: who new comments/replies are attributed to (the app's device
  // identity — the same name sync history and presence use).
  commentAuthor?: string;
  // False hides the whole comment layer (rail, highlights, gutter) so the
  // document reads clean; the marks stay in the doc untouched.
  commentsVisible?: boolean;
  // Reports the doc's thread count (drives the tab-bar toggle).
  onCommentsCount?: (count: number) => void;
  // Asks the host to flip comments visible (creating a comment while hidden).
  onRequestShowComments?: () => void;
  // True renders the document read-only: typing, slash menu, and toolbar are
  // off, but selection and the whole comment layer still work (a web
  // comment-role session comments on a document it can't edit). Comment
  // mutations still dispatch — they go through the rail and commentSelection,
  // not through DOM editing.
  readOnly?: boolean;
  // Lets a read-only session still tick task-list checkboxes (taskToggle.ts).
  // Off by default: a read-only view is normally a MIRROR of a document
  // someone else owns (the unfocused split pane), where nothing should move.
  // The shared page's comment-role visitor is the exception — a checklist is
  // usually for exactly the people who may comment on it.
  taskToggle?: boolean;
  // Marker-less markdown threads from the entity meta file (see OrphanOps).
  orphans?: OrphanOps;
  // Persisted table column widths (entity meta `tcols` records). Read ONCE,
  // at mount: they are applied to the parsed document before the editor
  // state exists, so a later prop change is deliberately inert — nothing
  // should resize a table under the user's hands mid-session.
  tableWidths?: TableCols[];
  // Where this editor's live width set goes when it changes. Omit for views
  // that don't own the document (read-only mirrors, the unfocused pane) —
  // their resizes stay session-only. Unlike `tableWidths` this IS read
  // live, so a pane promoted without a remount starts persisting at once.
  onTableWidths?: (records: TableCols[]) => void;
  // A link the reader followed (clicked), href verbatim from the markdown —
  // see linkOpen.ts for which clicks count. Hosts route it: the desktop app
  // sends external URLs to the system browser and in-workspace paths to a tab;
  // a host without one opens a browser tab. In-document `#anchors` never arrive
  // here; the editor scrolls to them itself. Read-only views follow links too
  // — a published page is exactly where links matter most.
  onOpenLink?: (href: string) => void;
  // What an embed in this document can reach: which note it is
  // written in (a relative `store:` resolves against it), the workspace's
  // boards, and how to open a card. A host with no workspace behind it
  // (null) makes the embed say so in place instead of drawing a board it
  // can't read.
  kanban?: StoreEmbedHost | null;
};

function dispatchMeta(view: EditorView, meta: SearchMeta) {
  view.dispatch(view.state.tr.setMeta(searchKey, meta));
}

// Speech-bubble icon for the selection-toolbar "Comment" button. Crepe renders
// the toolbar icon from a raw SVG string (same as its built-in bold/italic).
const commentIcon = `
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
  </svg>
`;

// Material "account_tree" — the slash menu's Diagram item, drawn in the same
// filled style as Crepe's built-in menu icons.
const diagramIcon = `
  <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="currentColor">
    <path d="M600-120v-120H440v-400h-80v120H80v-320h280v120h240v-120h280v320H600v-120h-80v320h80v-120h280v320H600Zm-440-520h120v-160H160v160Zm520 400h120v-160H680v160Zm0-400h120v-160H680v160ZM160-640Zm520 240Zm0-240Z"/>
  </svg>
`;

// Material "view_kanban" — the slash menu's Board item, in the same filled
// style as the Diagram icon beside it.
const boardIcon = `
  <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="currentColor">
    <path d="M200-160q-33 0-56.5-23.5T120-240v-480q0-33 23.5-56.5T200-800h560q33 0 56.5 23.5T840-720v480q0 33-23.5 56.5T760-160H200Zm0-80h133v-480H200v480Zm213 0h133v-480H413v480Zm213 0h134v-480H626v480Z"/>
  </svg>
`;

function infoOf(view: EditorView): SearchInfo {
  const s = getSearchState(view.state);
  return { count: s?.matches.length ?? 0, current: s?.current ?? 0 };
}

// Scroll a doc position into view WITHOUT touching the editor selection. Resolves
// the DOM node at the position and scrolls it; falls back silently if the
// position can't be mapped mid-edit.
function scrollPosIntoView(view: EditorView, pos: number) {
  try {
    const dom = view.domAtPos(pos);
    const el =
      dom.node.nodeType === Node.TEXT_NODE
        ? dom.node.parentElement
        : (dom.node as HTMLElement);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  } catch {
    // position may be momentarily invalid mid-edit; ignore
  }
}

function scrollToCurrent(view: EditorView) {
  const s = getSearchState(view.state);
  if (!s || s.matches.length === 0) return;
  const m = s.matches[s.current];
  if (m) scrollPosIntoView(view, m.from);
}

/* ---------- Dictation helpers ---------- */

// Join a finalized dictation chunk onto the text before the anchor: add the
// missing space between chunks, capitalize at paragraph starts and after
// sentence enders. Whisper already punctuates within a chunk; this only fixes
// the seams between chunks.
function smartJoin(doc: import("@milkdown/kit/prose/model").Node, anchor: number, text: string): string {
  let out = text.replace(/\s*\n+\s*/g, " ").trim();
  if (!out) return "";
  const before = doc.textBetween(Math.max(0, anchor - 8), anchor, "\n", "\n");
  const atBlockStart = before === "" || before.endsWith("\n");
  const last = before.slice(-1);
  if (!atBlockStart && last && !/\s/.test(last) && !/^[,.;:!?)\]}»%]/.test(out)) {
    out = " " + out;
  }
  if (atBlockStart || /[.!?…]["')\]]?\s*$/.test(before)) {
    const lead = out.search(/\S/);
    out = out.slice(0, lead) + out.charAt(lead).toUpperCase() + out.slice(lead + 1);
  }
  return out;
}

// Heading trail above a position ("Doc Title › Section › Subsection") plus the
// text right before/after it — the structural context for the polish prompt.
function dictationContextAt(doc: import("@milkdown/kit/prose/model").Node, anchor: number): DictationContext {
  const levels: string[] = [];
  doc.forEach((node, offset) => {
    if (offset >= anchor) return;
    if (node.type.name === "heading") {
      const level = Math.max(1, Math.min(6, Number(node.attrs.level) || 1));
      levels.length = level - 1; // entering h2 drops any stale h3+ trail
      levels[level - 1] = node.textContent;
    }
  });
  const headingPath = levels.filter(Boolean).join(" › ");

  const before = doc.textBetween(Math.max(0, anchor - 700), anchor, "\n", " ");
  const after = doc.textBetween(anchor, Math.min(doc.content.size, anchor + 400), "\n", " ");

  let docText = doc.textBetween(0, doc.content.size, "\n", " ");
  if (docText.length > 8000) {
    // Keep both ends — openings carry titles/terms, the tail is what the user
    // is dictating into.
    docText = `${docText.slice(0, 4000)}\n[…]\n${docText.slice(-4000)}`;
  }
  return { docText, headingPath, before, after };
}

const MilkdownInner = forwardRef<EditorHandle, Props>(function MilkdownInner(
  {
    initialMarkdown,
    onChange,
    onSearchState,
    onFocusChange,
    onReady,
    commentAuthor = "",
    commentsVisible = true,
    onCommentsCount,
    onRequestShowComments,
    readOnly = false,
    taskToggle = false,
    orphans,
    tableWidths,
    onTableWidths,
    onOpenLink,
    kanban,
  },
  ref,
) {
  const viewRef = useRef<EditorView | null>(null);
  const crepeRef = useRef<Crepe | null>(null);
  // The scroll container this editor lives in, captured while mounted. The
  // unmount cleanup must address exactly this wrap — by unmount time the
  // editor DOM is detached (closest() finds nothing), and with split panes a
  // global .editor-wrap query could hit the OTHER pane.
  const wrapRef = useRef<HTMLElement | null>(null);
  // True while dictation owns the editor — from the talk-key press until the
  // chunk pipeline drains. The editable prop (installed at mount) reads this,
  // so typing is suspended exactly while spoken text is in flight. Flips take
  // effect on the next transaction, which begin/end always dispatch.
  const dictatingRef = useRef(false);
  // A search request that arrived before the editor mounted (e.g. opening a
  // workspace-search result remounts the editor, then the query is applied).
  const pendingRef = useRef<{ query: string; caseSensitive: boolean } | null>(null);
  // Callbacks captured in the (run-once) editor factory must read the latest
  // prop, so route them through refs.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSearchStateRef = useRef(onSearchState);
  onSearchStateRef.current = onSearchState;
  const onFocusChangeRef = useRef(onFocusChange);
  onFocusChangeRef.current = onFocusChange;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  // Right-side comment rail state. `threads` is derived from the doc's marks
  // on every update; activeId/editing are transient UI state keyed by a
  // thread's stable id, so they survive edits elsewhere in the document.
  const [threads, setThreads] = useState<RailThread[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditTarget>(null);
  // The pending recompute tick: rAF while the window paints, a timeout when
  // it's hidden (rAF never fires in hidden windows, and the rail must not
  // stall until the next paint).
  const rafRef = useRef<{ kind: "raf" | "timeout"; id: number } | null>(null);
  const contentObserverRef = useRef<ResizeObserver | null>(null);
  // Latest comment props for the run-once editor closures.
  const authorRef = useRef(commentAuthor);
  authorRef.current = commentAuthor;
  const visibleRef = useRef(commentsVisible);
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const taskToggleRef = useRef(taskToggle);
  taskToggleRef.current = taskToggle;
  const onCommentsCountRef = useRef(onCommentsCount);
  onCommentsCountRef.current = onCommentsCount;
  const onRequestShowCommentsRef = useRef(onRequestShowComments);
  onRequestShowCommentsRef.current = onRequestShowComments;
  const orphansRef = useRef(orphans);
  orphansRef.current = orphans;
  const onTableWidthsRef = useRef(onTableWidths);
  onTableWidthsRef.current = onTableWidths;
  const onOpenLinkRef = useRef(onOpenLink);
  onOpenLinkRef.current = onOpenLink;
  const kanbanRef = useRef(kanban);
  kanbanRef.current = kanban;

  const report = () => {
    const view = viewRef.current;
    if (view) onSearchStateRef.current?.(infoOf(view));
  };

  // Rebuild the rail from the document: scan the comment marks, group them
  // into threads, and position each card at its first anchor's vertical
  // offset (in the scroll container's content space, so cards translate with
  // scroll). Overlap stacking happens in the rail, with measured heights.
  // Also the janitor for transient state: active/editing ids whose thread
  // vanished (deleted, cut, undone) are dropped here. rAF-debounced because
  // it runs on every editor update.
  const recompute = useCallback(() => {
    if (rafRef.current != null) return;
    const run = () => {
      rafRef.current = null;
      const view = viewRef.current;
      const wrap = view?.dom.closest(".editor-wrap") as HTMLElement | null;
      if (!view || !wrap) {
        setThreads([]);
        onCommentsCountRef.current?.(0);
        return;
      }
      const wrapRect = wrap.getBoundingClientRect();
      const items: RailThread[] = [];
      // Orphaned meta threads (marker gone) lead the rail, pinned to the top
      // — same presentation as the html view's unresolvable anchors.
      const docIds = new Set(collectThreads(view.state.doc).map((t) => t.id));
      for (const o of orphansRef.current?.threads ?? []) {
        if (docIds.has(o.id)) continue; // its marker is back (undo, paste)
        items.push({ id: o.id, comments: o.comments, anchorTop: 0, orphaned: true });
      }
      for (const t of collectThreads(view.state.doc)) {
        let top: number;
        try {
          const coords = view.coordsAtPos(t.ranges[0].from);
          top = coords.top - wrapRect.top + wrap.scrollTop;
        } catch {
          // position momentarily unmappable mid-edit; keep doc order
          top = items.length > 0 ? items[items.length - 1].anchorTop + 1 : 0;
        }
        items.push({ id: t.id, comments: t.comments, anchorTop: top });
      }
      wrap.classList.toggle("has-comments", items.length > 0 && visibleRef.current);
      setThreads(items);
      onCommentsCountRef.current?.(items.length);
      setActiveId((a) => (a != null && !items.some((t) => t.id === a) ? null : a));
      setEditing((e) => {
        if (!e) return e;
        const t = items.find((x) => x.id === e.id);
        return t && e.index < t.comments.length ? e : null;
      });
    };
    rafRef.current = document.hidden
      ? { kind: "timeout", id: window.setTimeout(run, 32) }
      : { kind: "raf", id: requestAnimationFrame(run) };
  }, []);

  // Create a comment thread from the current selection and open its (empty)
  // card for typing. Routed through a ref so the run-once toolbar handler
  // calls the latest copy.
  const createCommentRef = useRef<(view: EditorView) => void>(() => {});
  createCommentRef.current = (view: EditorView) => {
    onRequestShowCommentsRef.current?.();
    const id = createThread(view, authorRef.current);
    if (!id) return;
    setActiveThread(view, id);
    setActiveId(id);
    setEditing({ id, index: 0 });
    recompute();
  };

  useEditor((root) => {
    const crepe = new Crepe({
      root,
      defaultValue: initialMarkdown,
      featureConfigs: {
        placeholder: {
          text: "Type / for commands…",
          mode: "doc",
        },
        toolbar: {
          // Add a "Comment" button to the selection toolbar (its own group so we
          // don't depend on a built-in group key).
          buildToolbar: (builder) => {
            builder.addGroup("critic-markup", "Comment").addItem("comment", {
              icon: commentIcon,
              active: () => false,
              onRun: (ctx) => createCommentRef.current(ctx.get(editorViewCtx)),
            });
          },
        },
        "block-edit": {
          // "/diagram" → a mermaid code block; the preview panel below it
          // renders the diagram live (see the codeBlockConfig update below).
          buildMenu: (builder) => {
            builder.getGroup("advanced").addItem("diagram", {
              label: "Diagram",
              icon: diagramIcon,
              onRun: (ctx) => {
                const commands = ctx.get(commandsCtx);
                commands.call(clearTextInCurrentBlockCommand.key);
                commands.call(addBlockTypeCommand.key, {
                  nodeType: codeBlockSchema.type(ctx),
                  attrs: { language: "mermaid" },
                });
              },
            });
            // "/board" → a ```kanban embed, "/table" → a ```table one. Both
            // start with no store named: the frame asks which one, in place
            // (see StoreEmbed.tsx).
            builder.getGroup("advanced").addItem("kanban", {
              label: "Board",
              icon: boardIcon,
              onRun: (ctx) => insertStoreEmbed(ctx, "kanban"),
            });
            builder.getGroup("advanced").addItem("table_view", {
              label: "Board as a table",
              icon: boardIcon,
              onRun: (ctx) => insertStoreEmbed(ctx, "table"),
            });
          },
        },
      },
    });
    // Mermaid diagrams: put "mermaid" in the code block's language picker and
    // chain a diagram renderer in front of the stock preview handlers (LaTeX
    // et al) — registered after the Crepe constructor, so `prev` already
    // carries the feature-installed chain. Rendering itself (loading, theming,
    // debouncing) lives in mermaid.ts.
    crepe.editor.config((ctx) => {
      ctx.update(codeBlockConfig.key, (prev) => ({
        ...prev,
        languages: [...prev.languages, mermaidLanguage],
        previewLoading: MERMAID_PREVIEW_LOADING,
        renderPreview: (language, content, applyPreview) => {
          if (isMermaidLanguage(language)) {
            if (!content.trim()) return null;
            queueMermaidPreview(content, applyPreview);
            return undefined; // async — the panel shows previewLoading meanwhile
          }
          return prev.renderPreview(language, content, applyPreview);
        },
      }));
    });
    // The comment mark + its remark round-trip must be registered together.
    // Spread each composable into its underlying MilkdownPlugins.
    crepe.editor.use([...criticCommentSchema, ...criticRemark]);
    // ```kanban fences become a board. Schema and remark go in together (the
    // node has no meaning without its round trip); the node view follows, so
    // the schema it names is already registered. Every host gets all three —
    // a host with no workspace behind it draws the frame and says so, which
    // still round-trips the fence byte for byte.
    crepe.editor.use([...storeEmbedSchema, ...storeEmbedRemark]);
    crepe.editor.use(
      storeEmbedView(
        () => kanbanRef.current ?? null,
        () => readOnlyRef.current === true,
      ),
    );
    // Hard-wrapped inline code spans: collapse the source newline to a space
    // at parse time so the code pill doesn't render as a stacked two-line box
    // (see inlineCodeNewlines.ts).
    crepe.editor.use([...inlineCodeNewlines]);
    crepe.editor.use(searchPlugin);
    // Click-to-follow for links (linkOpen.ts). Registered for read-only views
    // too — following a link is reading, not editing. Hosts that don't say
    // where links go get a browser tab.
    crepe.editor.use(linkOpenPlugin(() => onOpenLinkRef.current ?? openInBrowserTab));
    // Checkbox ticking for read-only sessions that are allowed it (the plugin
    // stands down whenever the editor is editable — there the list item's own
    // node view already owns the box).
    crepe.editor.use(taskTogglePlugin(() => taskToggleRef.current));
    crepe.editor.use(criticActivePlugin);
    crepe.editor.use(criticCopyPlugin);
    crepe.editor.use(ghostPlugin);
    crepe.editor.use(polishRevertPlugin);
    // Column drag-resize; must come after the Crepe features so its table
    // node view overrides the table block's (see tableResize.ts). The store
    // reads the widths prop from THIS render (mount-time by definition) and
    // routes emissions through the ref, so the callback can come and go with
    // the pane's ownership of the document.
    crepe.editor.config((ctx) =>
      enableColumnResizing(ctx, {
        initial: tableWidths ?? [],
        sink: () => onTableWidthsRef.current ?? null,
      }),
    );
    crepe.editor.use(resizableTableView);
    crepeRef.current = crepe;
    // Crepe's readonly flag silences its own chrome (toolbar, slash menu,
    // block handle); the editable prop installed at mount keeps ProseMirror
    // itself from accepting input.
    if (readOnlyRef.current) crepe.setReadonly(true);
    crepe.on((api) => {
      api.markdownUpdated((_ctx, markdown) => {
        onChangeRef.current(markdown);
      });
      api.mounted((ctx) => {
        const view = ctx.get(editorViewCtx);
        viewRef.current = view;
        view.setProps({ editable: () => !dictatingRef.current && !readOnlyRef.current });
        // Emit the mounted doc's serialization as the baseline. markdownUpdated
        // only fires on edit transactions — never on mount — so without this the
        // host would mistake the first real edit (e.g. a paste into a fresh
        // draft) for the load-normalization baseline and never autosave it.
        onChangeRef.current(crepe.getMarkdown());
        // Host visibility into editor focus (drives the empty-draft placeholder).
        view.dom.addEventListener("focus", () => onFocusChangeRef.current?.(true));
        view.dom.addEventListener("blur", () => onFocusChangeRef.current?.(false));
        const pending = pendingRef.current;
        if (pending) {
          pendingRef.current = null;
          dispatchMeta(view, { kind: "set", ...pending });
          scrollToCurrent(view);
        }
        // Clicking a highlighted anchor activates its thread in the rail;
        // clicking anywhere else in the document deselects.
        view.dom.addEventListener("click", (e) => {
          const v = viewRef.current;
          if (!v || !visibleRef.current) return;
          const at = v.posAtCoords({ left: e.clientX, top: e.clientY });
          if (!at) return;
          const hit = collectThreads(v.state.doc).find((t) =>
            t.ranges.some((r) => at.pos >= r.from && at.pos < r.to),
          );
          if (hit) {
            setActiveThread(v, hit.id);
            setActiveId(hit.id);
          } else if (criticActiveKey.getState(v.state)?.id) {
            setActiveThread(v, null);
            setActiveId(null);
          }
        });
        // Content height changes without an edit transaction (image loads,
        // fonts) move the anchors — keep the rail aligned.
        const observer = new ResizeObserver(() => recompute());
        observer.observe(view.dom);
        contentObserverRef.current = observer;
        wrapRef.current = view.dom.closest(".editor-wrap") as HTMLElement | null;
        wrapRef.current?.classList.toggle("comments-off", !visibleRef.current);
        report();
        recompute();
        onReadyRef.current?.();
      });
      // Keep search count + comment rail fresh as the document changes.
      api.updated(() => {
        report();
        recompute();
      });
    });
    return crepe;
  }, []);

  // The editor width (and thus card anchor positions) changes on window resize.
  useEffect(() => {
    const onResize = () => recompute();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [recompute]);

  // Apply readOnly flips after mount (the ref keeps the editable prop
  // current; setProps forces ProseMirror to re-consult it). A flip also
  // re-reports the rail: the split view promotes/demotes a pane by flipping
  // readOnly, and the incoming host callbacks (comment count) need a fresh
  // report even though no transaction happened.
  // The taskToggle dep is here for the same reason: the toggle plugin decides
  // from view.editable + the prop, and only a view update re-runs that.
  useEffect(() => {
    crepeRef.current?.setReadonly(readOnly);
    viewRef.current?.setProps({});
    recompute();
  }, [readOnly, taskToggle, recompute]);

  // Node views get no props, so an embed can't see a readOnly flip or a host
  // arriving; both are read through getters and this is the nudge to re-read
  // them. Mounted boards then go live (or read-only) without the editor
  // remounting and losing the caret. Keyed on what a board can actually see
  // change — the host object itself is rebuilt on every host render, and
  // redrawing every board that often would be pure waste.
  const kanbanDoc = kanban?.docPath ?? null;
  useEffect(() => {
    refreshStoreEmbeds();
  }, [readOnly, kanbanDoc]);

  // Show/hide the comment layer. Hiding clears the selection (no invisible
  // active highlight) and drops the gutter; the marks themselves are
  // untouched — the doc just reads clean.
  useEffect(() => {
    visibleRef.current = commentsVisible;
    const view = viewRef.current;
    const wrap = view?.dom.closest(".editor-wrap") as HTMLElement | null;
    wrap?.classList.toggle("comments-off", !commentsVisible);
    if (!commentsVisible) {
      if (view) setActiveThread(view, null);
      setActiveId(null);
      setEditing(null);
    }
    recompute();
  }, [commentsVisible, recompute]);

  // Drop the reserved gutter when this editor unmounts (e.g. closing the last
  // tab) so the welcome screen isn't left with a phantom right margin. Scoped
  // to OUR wrap (resolved from the mounted view) — with split panes there can
  // be two .editor-wrap elements, and a global query would strip the other
  // pane's gutter.
  useEffect(() => {
    return () => {
      const wrap = wrapRef.current ?? document.querySelector(".editor-wrap");
      wrap?.classList.remove("has-comments", "comments-off");
      contentObserverRef.current?.disconnect();
      const pending = rafRef.current;
      if (pending) {
        if (pending.kind === "raf") cancelAnimationFrame(pending.id);
        else clearTimeout(pending.id);
        // Clear the handle, or the next recompute() thinks a tick is still
        // pending and skips — under StrictMode's dev-only effect replay this
        // wedged the rail empty for the whole session.
        rafRef.current = null;
      }
    };
  }, []);

  // Rail callbacks. All of them resolve the thread from the CURRENT doc by
  // its stable id at dispatch time, so stale rail state can never touch the
  // wrong text. Ids the doc doesn't know are orphaned meta threads — their
  // mutations route to the host (they live in the meta file, not the doc).
  const orphanOf = useCallback((id: string) => {
    return orphansRef.current?.threads.find((t) => t.id === id) ?? null;
  }, []);

  const onActivate = useCallback((id: string) => {
    const view = viewRef.current;
    if (!view) return;
    const t = getThread(view.state, id);
    if (!t) {
      if (orphanOf(id)) setActiveId(id); // nothing to highlight or scroll to
      return;
    }
    setActiveThread(view, id);
    setActiveId(id);
    scrollPosIntoView(view, t.ranges[0].from);
  }, [orphanOf]);

  const onStartEdit = useCallback((id: string, index: number) => {
    const view = viewRef.current;
    if (view && getThread(view.state, id)) setActiveThread(view, id);
    setActiveId(id);
    setEditing({ id, index });
  }, []);

  const onCommitEdit = useCallback((id: string, index: number, body: string) => {
    setEditing(null);
    const view = viewRef.current;
    if (!view) return;
    const entry = getThread(view.state, id)?.comments[index];
    if (!entry) {
      const o = orphanOf(id);
      const oEntry = o?.comments[index];
      if (o && oEntry && body.trim() !== "" && body !== oEntry.body) {
        orphansRef.current?.onUpdateBody(id, index, body);
      }
      return;
    }
    if (body.trim() === "") {
      if (index === 0 && entry.body === "") {
        // An abandoned draft (opened, never written) is discarded on blur.
        deleteThread(view, id);
        setActiveThread(view, null);
        setActiveId((a) => (a === id ? null : a));
      }
      // Emptying an existing entry reverts it; deleting is an explicit act.
    } else if (body !== entry.body) {
      updateCommentBody(view, id, index, body);
    }
  }, [orphanOf]);

  const onCancelEdit = useCallback((id: string, index: number) => {
    setEditing(null);
    const view = viewRef.current;
    if (!view || index !== 0) return;
    if (getThread(view.state, id)?.comments[0]?.body === "") {
      deleteThread(view, id);
      setActiveThread(view, null);
      setActiveId((a) => (a === id ? null : a));
    }
  }, []);

  const onReply = useCallback((id: string, body: string) => {
    const view = viewRef.current;
    if (!view) return;
    if (!getThread(view.state, id) && orphanOf(id)) {
      orphansRef.current?.onReply(id, authorRef.current, body);
      return;
    }
    addReply(view, id, authorRef.current, body);
  }, [orphanOf]);

  const onDeleteThread = useCallback((id: string) => {
    const view = viewRef.current;
    if (!view) return;
    setEditing((e) => (e?.id === id ? null : e));
    setActiveId((a) => (a === id ? null : a));
    if (!getThread(view.state, id) && orphanOf(id)) {
      orphansRef.current?.onDeleteThread(id);
      return;
    }
    deleteThread(view, id);
    setActiveThread(view, null);
  }, [orphanOf]);

  const onDeleteReply = useCallback((id: string, index: number) => {
    const view = viewRef.current;
    if (!view) return;
    setEditing((e) => (e && e.id === id && e.index === index ? null : e));
    if (!getThread(view.state, id) && orphanOf(id)) {
      orphansRef.current?.onDeleteReply(id, index);
      return;
    }
    deleteReply(view, id, index);
  }, [orphanOf]);

  // Orphans arrive/leave outside editor transactions — re-derive the rail.
  useEffect(() => {
    recompute();
  }, [orphans, recompute]);

  useImperativeHandle(
    ref,
    () => ({
      setSearch(query, caseSensitive) {
        const view = viewRef.current;
        if (!view) {
          pendingRef.current = { query, caseSensitive };
          return;
        }
        dispatchMeta(view, { kind: "set", query, caseSensitive });
        report();
        scrollToCurrent(view);
      },
      searchNext() {
        const view = viewRef.current;
        if (!view) return;
        dispatchMeta(view, { kind: "next" });
        report();
        scrollToCurrent(view);
      },
      searchPrev() {
        const view = viewRef.current;
        if (!view) return;
        dispatchMeta(view, { kind: "prev" });
        report();
        scrollToCurrent(view);
      },
      clearSearch() {
        pendingRef.current = null;
        const view = viewRef.current;
        if (!view) return;
        dispatchMeta(view, { kind: "clear" });
        report();
      },
      insertText(text) {
        const view = viewRef.current;
        if (!view || dictatingRef.current || !view.hasFocus()) return;
        view.dispatch(view.state.tr.insertText(text));
      },
      dictationBegin() {
        const view = viewRef.current;
        if (!view || dictatingRef.current) return false;
        dictatingRef.current = true;
        const pos = view.state.selection.head;
        view.dispatch(view.state.tr.setMeta(ghostKey, { kind: "begin", pos }));
        return true;
      },
      dictationSetGhost(segments) {
        const view = viewRef.current;
        if (!view || !dictatingRef.current) return;
        view.dispatch(view.state.tr.setMeta(ghostKey, { kind: "segments", segments }));
      },
      dictationCommit(text, raw) {
        const view = viewRef.current;
        if (!view || !dictatingRef.current) return;
        const anchor = getGhostState(view.state)?.anchor;
        if (anchor == null) return;
        const joined = smartJoin(view.state.doc, anchor, text);
        if (!joined) return;
        const tr = view.state.tr.insertText(joined, anchor, anchor);
        if (raw != null && raw.trim() && raw !== text) {
          tr.setMeta(revertKey, {
            kind: "track",
            entry: { from: anchor, to: anchor + joined.length, inserted: joined, raw },
          });
        }
        view.dispatch(tr);
      },
      dictationRevertPolish() {
        const view = viewRef.current;
        if (!view) return 0;
        const entries = getRevertEntries(view.state);
        if (entries.length === 0) return 0;
        // Front-to-back, remapping each entry through the replacements made
        // so far, so every raw chunk re-joins (spacing, capitalization)
        // against the already-reverted text before it. Only ranges that
        // still read exactly what polish inserted are touched — user edits win.
        let tr = view.state.tr;
        let reverted = 0;
        for (const e of [...entries].sort((a, b) => a.from - b.from)) {
          const from = tr.mapping.map(e.from, 1);
          const to = tr.mapping.map(e.to, -1);
          if (to <= from || to > tr.doc.content.size) continue;
          if (tr.doc.textBetween(from, to, "\n", "\n") !== e.inserted) continue;
          const rawJoined = smartJoin(tr.doc, from, e.raw);
          if (!rawJoined) continue;
          tr = tr.insertText(rawJoined, from, to);
          reverted++;
        }
        view.dispatch(tr.setMeta(revertKey, { kind: "clear" }));
        return reverted;
      },
      dictationClearRevert() {
        const view = viewRef.current;
        if (!view || getRevertEntries(view.state).length === 0) return;
        view.dispatch(view.state.tr.setMeta(revertKey, { kind: "clear" }));
      },
      dictationEnd() {
        const view = viewRef.current;
        if (!view) {
          dictatingRef.current = false;
          return;
        }
        dictatingRef.current = false;
        view.dispatch(view.state.tr.setMeta(ghostKey, { kind: "end" }));
        view.focus();
      },
      dictationContext() {
        const view = viewRef.current;
        if (!view) return null;
        const anchor = getGhostState(view.state)?.anchor ?? view.state.selection.head;
        return dictationContextAt(view.state.doc, anchor);
      },
      commentSelection() {
        const view = viewRef.current;
        if (!view) return false;
        if (view.state.selection.empty) {
          // A read-only editor may not have folded the DOM selection into its
          // state (that tracking rides focus) — map it in explicitly.
          const sel = window.getSelection();
          if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
          const range = sel.getRangeAt(0);
          if (!view.dom.contains(range.commonAncestorContainer)) return false;
          let from: number;
          let to: number;
          try {
            const a = view.posAtDOM(range.startContainer, range.startOffset);
            const b = view.posAtDOM(range.endContainer, range.endOffset);
            from = Math.min(a, b);
            to = Math.max(a, b);
          } catch {
            return false;
          }
          if (from === to) return false;
          view.dispatch(
            view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)),
          );
        }
        createCommentRef.current(view);
        return true;
      },
      refreshThreadBodies(bodies: Map<string, CommentEntry[]>) {
        const view = viewRef.current;
        if (!view) return;
        refreshThreadBodies(view, bodies);
      },
    }),
    [],
  );

  return (
    <>
      <Milkdown />
      {commentsVisible && (
        <CommentsRail
          threads={threads}
          activeId={activeId}
          editing={editing}
          selfAuthor={commentAuthor}
          onActivate={onActivate}
          onStartEdit={onStartEdit}
          onCommitEdit={onCommitEdit}
          onCancelEdit={onCancelEdit}
          onReply={onReply}
          onDeleteThread={onDeleteThread}
          onDeleteReply={onDeleteReply}
        />
      )}
    </>
  );
});

const Editor = forwardRef<EditorHandle, Props>(function Editor(props, ref) {
  return (
    <MilkdownProvider>
      <MilkdownInner {...props} ref={ref} />
    </MilkdownProvider>
  );
});

export default Editor;
