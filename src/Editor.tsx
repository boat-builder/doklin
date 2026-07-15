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
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
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
} from "./criticMark";
import CommentsRail, { type RailThread, type EditTarget } from "./CommentsRail";

import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";

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
  },
  ref,
) {
  const viewRef = useRef<EditorView | null>(null);
  const crepeRef = useRef<Crepe | null>(null);
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
  const onCommentsCountRef = useRef(onCommentsCount);
  onCommentsCountRef.current = onCommentsCount;
  const onRequestShowCommentsRef = useRef(onRequestShowComments);
  onRequestShowCommentsRef.current = onRequestShowComments;

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
      },
    });
    // The comment mark + its remark round-trip must be registered together.
    // Spread each composable into its underlying MilkdownPlugins.
    crepe.editor.use([...criticCommentSchema, ...criticRemark]);
    crepe.editor.use(searchPlugin);
    crepe.editor.use(criticActivePlugin);
    crepe.editor.use(criticCopyPlugin);
    crepe.editor.use(ghostPlugin);
    crepe.editor.use(polishRevertPlugin);
    // Column drag-resize; must come after the Crepe features so its table
    // node view overrides the table block's (see tableResize.ts).
    crepe.editor.config(enableColumnResizing);
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
        view.dom
          .closest(".editor-wrap")
          ?.classList.toggle("comments-off", !visibleRef.current);
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
  // current; setProps forces ProseMirror to re-consult it).
  useEffect(() => {
    crepeRef.current?.setReadonly(readOnly);
    viewRef.current?.setProps({});
  }, [readOnly]);

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
  // tab) so the welcome screen isn't left with a phantom right margin.
  useEffect(() => {
    return () => {
      const wrap = document.querySelector(".editor-wrap");
      wrap?.classList.remove("has-comments", "comments-off");
      contentObserverRef.current?.disconnect();
      const pending = rafRef.current;
      if (pending) {
        if (pending.kind === "raf") cancelAnimationFrame(pending.id);
        else clearTimeout(pending.id);
      }
    };
  }, []);

  // Rail callbacks. All of them resolve the thread from the CURRENT doc by
  // its stable id at dispatch time, so stale rail state can never touch the
  // wrong text.
  const onActivate = useCallback((id: string) => {
    const view = viewRef.current;
    if (!view) return;
    const t = getThread(view.state, id);
    if (!t) return;
    setActiveThread(view, id);
    setActiveId(id);
    scrollPosIntoView(view, t.ranges[0].from);
  }, []);

  const onStartEdit = useCallback((id: string, index: number) => {
    const view = viewRef.current;
    if (view) setActiveThread(view, id);
    setActiveId(id);
    setEditing({ id, index });
  }, []);

  const onCommitEdit = useCallback((id: string, index: number, body: string) => {
    setEditing(null);
    const view = viewRef.current;
    if (!view) return;
    const entry = getThread(view.state, id)?.comments[index];
    if (!entry) return;
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
  }, []);

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
    if (view) addReply(view, id, authorRef.current, body);
  }, []);

  const onDeleteThread = useCallback((id: string) => {
    const view = viewRef.current;
    if (!view) return;
    setEditing((e) => (e?.id === id ? null : e));
    setActiveId((a) => (a === id ? null : a));
    deleteThread(view, id);
    setActiveThread(view, null);
  }, []);

  const onDeleteReply = useCallback((id: string, index: number) => {
    const view = viewRef.current;
    if (!view) return;
    setEditing((e) => (e && e.id === id && e.index === index ? null : e));
    deleteReply(view, id, index);
  }, []);

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
