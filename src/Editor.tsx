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
import type { EditorView } from "@milkdown/kit/prose/view";
import {
  searchKey,
  searchPlugin,
  getSearchState,
  type SearchInfo,
  type SearchMeta,
} from "./searchPlugin";
import { criticActivePlugin, criticCopyPlugin, setActiveComment } from "./criticPlugin";
import { ghostPlugin, ghostKey, getGhostState, type GhostSegment } from "./ghostText";
import {
  criticCommentSchema,
  criticRemark,
  collectComments,
  applyComment,
  updateCommentBody,
  removeComment,
} from "./criticMark";
import CommentsRail, { type RailComment } from "./CommentsRail";

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
// at the caret and suspends typing (dictation is a mode); setGhost paints the
// in-flight transcript; commit inserts finalized text at the anchor (one undo
// step per chunk); end restores normal editing.
export type EditorHandle = {
  setSearch: (query: string, caseSensitive: boolean) => void;
  searchNext: () => void;
  searchPrev: () => void;
  clearSearch: () => void;
  dictationBegin: () => boolean;
  dictationSetGhost: (segments: GhostSegment[]) => void;
  dictationCommit: (text: string) => void;
  dictationEnd: () => void;
  dictationContext: () => DictationContext | null;
};

type Props = {
  initialMarkdown: string;
  onChange: (markdown: string) => void;
  onSearchState?: (info: SearchInfo) => void;
  onFocusChange?: (focused: boolean) => void;
  // Fires once the ProseMirror view exists with the full document rendered —
  // the earliest point DOM-level work (e.g. restoring scroll) can stick.
  onReady?: () => void;
};

// Estimated card height + gap used by the rail's overlap-avoidance stacking pass
// (cards have a min-height; very tightly packed comments may still touch).
const CARD_MIN_HEIGHT = 52;
const CARD_GAP = 10;

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
  { initialMarkdown, onChange, onSearchState, onFocusChange, onReady },
  ref,
) {
  const viewRef = useRef<EditorView | null>(null);
  // True while a dictation session owns the editor: the editable prop
  // (installed at mount) reads this, so typing is suspended for the session —
  // dictation is a mode. Flips take effect on the next transaction, which
  // begin/end always dispatch.
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

  // Right-side comment rail state. `comments` is derived from the doc's marks on
  // every update; activeId/editingId are transient UI state keyed by a comment's
  // anchor `from` position.
  const [comments, setComments] = useState<RailComment[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const rafRef = useRef<number | null>(null);

  const report = () => {
    const view = viewRef.current;
    if (view) onSearchStateRef.current?.(infoOf(view));
  };

  // Rebuild the rail from the document: scan the comment marks, position each
  // card at its anchor's vertical offset (in the scroll container's content
  // space, so cards translate with scroll), and stack to avoid overlaps.
  // rAF-debounced because it runs on every editor update.
  const recompute = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const view = viewRef.current;
      const wrap = view?.dom.closest(".editor-wrap") as HTMLElement | null;
      if (!view || !wrap) {
        setComments([]);
        return;
      }
      const wrapRect = wrap.getBoundingClientRect();
      const items: RailComment[] = [];
      let cursor = 0;
      for (const c of collectComments(view.state.doc)) {
        let top: number;
        try {
          const coords = view.coordsAtPos(c.from);
          top = coords.top - wrapRect.top + wrap.scrollTop;
        } catch {
          top = cursor;
        }
        top = Math.max(top, cursor);
        items.push({ id: c.from, from: c.from, to: c.to, body: c.body, top });
        cursor = top + CARD_MIN_HEIGHT + CARD_GAP;
      }
      wrap.classList.toggle("has-comments", items.length > 0);
      setComments(items);
    });
  }, []);

  // Create a comment from the current selection and open its (empty) card.
  // Routed through a ref so the run-once toolbar handler calls the latest copy.
  const createCommentRef = useRef<(view: EditorView) => void>(() => {});
  createCommentRef.current = (view: EditorView) => {
    const range = applyComment(view, "");
    if (!range) return;
    setActiveComment(view, { from: range.from, to: range.to });
    setActiveId(range.from);
    setEditingId(range.from);
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
    crepe.on((api) => {
      api.markdownUpdated((_ctx, markdown) => {
        onChangeRef.current(markdown);
      });
      api.mounted((ctx) => {
        const view = ctx.get(editorViewCtx);
        viewRef.current = view;
        view.setProps({ editable: () => !dictatingRef.current });
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
        // Clicking a highlighted anchor activates its comment in the rail.
        view.dom.addEventListener("click", (e) => {
          const v = viewRef.current;
          if (!v) return;
          const at = v.posAtCoords({ left: e.clientX, top: e.clientY });
          if (!at) return;
          const hit = collectComments(v.state.doc).find(
            (c) => at.pos >= c.from && at.pos < c.to,
          );
          if (hit) {
            setActiveComment(v, { from: hit.from, to: hit.to });
            setActiveId(hit.from);
          }
        });
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

  // Drop the reserved gutter when this editor unmounts (e.g. closing the last
  // tab) so the welcome screen isn't left with a phantom right margin.
  useEffect(() => {
    return () => {
      document.querySelector(".editor-wrap")?.classList.remove("has-comments");
    };
  }, []);

  const findComment = (id: number) => comments.find((c) => c.id === id);

  const onActivate = useCallback(
    (id: number) => {
      const view = viewRef.current;
      const c = comments.find((x) => x.id === id);
      if (!view || !c) return;
      setActiveComment(view, { from: c.from, to: c.to });
      setActiveId(id);
      scrollPosIntoView(view, c.from);
    },
    [comments],
  );

  const onStartEdit = useCallback((id: number) => setEditingId(id), []);

  const onCommitBody = useCallback(
    (id: number, body: string) => {
      const view = viewRef.current;
      const c = findComment(id);
      setEditingId(null);
      if (!view || !c) return;
      if (body.trim() === "") {
        // An empty / never-filled comment is discarded on blur.
        removeComment(view, c.from, c.to);
        setActiveId((a) => (a === id ? null : a));
      } else if (body !== c.body) {
        updateCommentBody(view, c.from, c.to, body);
      }
    },
    // findComment closes over `comments`
    [comments],
  );

  const onDelete = useCallback(
    (id: number) => {
      const view = viewRef.current;
      const c = findComment(id);
      setEditingId((e) => (e === id ? null : e));
      setActiveId((a) => (a === id ? null : a));
      if (view && c) removeComment(view, c.from, c.to);
    },
    [comments],
  );

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
      dictationCommit(text) {
        const view = viewRef.current;
        if (!view || !dictatingRef.current) return;
        const anchor = getGhostState(view.state)?.anchor;
        if (anchor == null) return;
        const joined = smartJoin(view.state.doc, anchor, text);
        if (!joined) return;
        view.dispatch(view.state.tr.insertText(joined, anchor, anchor));
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
    }),
    [],
  );

  return (
    <>
      <Milkdown />
      <CommentsRail
        comments={comments}
        activeId={activeId}
        editingId={editingId}
        onActivate={onActivate}
        onStartEdit={onStartEdit}
        onCommitBody={onCommitBody}
        onDelete={onDelete}
      />
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
