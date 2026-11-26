import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { pressedOutside } from "./dismiss";
import { backend } from "./backend";
import { isAppShortcut, type AppShortcut } from "./keys";
import CommentsRail, { type EditTarget, type RailThread } from "./CommentsRail";
import {
  addHtmlReply,
  anchorFromFrame,
  createHtmlThread,
  deleteHtmlReply,
  deleteHtmlThread,
  updateHtmlCommentBody,
  type HtmlAnchor,
  type HtmlThread,
} from "./htmlComments";
import {
  bridgeThreads,
  instrumentHtml,
  isBridgeMsg,
  type Box,
  type BridgeInMsg,
  type BridgePlace,
  type PartKind,
  type PartLabel,
  type PlaceState,
} from "./htmlBridge";

// The HTML rendition view: the sandboxed preview frame, what the app draws
// over it, and the column of comment cards beside it.
//
// Comments sit BESIDE the page, as they do beside a note: the same cards,
// stacked by the same rule (CommentsRail), each level with what it is about.
// While comments are shown and the page has some, the page gives the column
// its width — and has it back when they are hidden, or when it has none. The
// frame's document is the same either way, so showing and hiding never
// reloads the page.
//
// Three things are drawn over the frame, none of them in the page: the
// Comment button level with a selection, a small marker at the corner of a
// part that has a thread (with its outline while the thread is open or under
// the pointer), and the outline of the part offered while picking. Words are
// tinted by the script inside the frame, which changes nothing in the page
// (htmlBridge.ts).
//
// Two ways to start a thread: select words and press Comment (⌘⌥M), or pick a
// part of the page (C) — the smallest one under the pointer, a click anywhere
// in it, ↑ and ↓ for the part around it and back. Both open the same card,
// which says what it is on before anything is typed.
//
// The iframe DOM is out of reach behind the sandbox's opaque origin, so this
// component only exchanges messages with the script: it sends the threads'
// anchors and what is open; it gets back where each thread is ON THE PAGE
// (not on screen) and the page's scroll, and moves its layers by that scroll
// with a transform — nothing is measured or rendered again while the page
// only scrolls.
//
// Thread DATA lives with the host (App owns the entity meta file and its
// persistence, like it owns the markdown autosave); this component owns the
// transient UI state — what is open, which entry is being edited, picking —
// mirroring Editor.tsx's split, including the draft semantics: a new thread
// opens as an empty card, and an abandoned draft is discarded, not saved.
type Props = {
  htmlContent: string;
  threads: HtmlThread[];
  onThreadsChange: (next: HtmlThread[]) => void;
  commentAuthor: string;
  // A link clicked in the rendition, as the app follows one in a note: a web
  // address as the frame resolved it, anything else (a path to a document)
  // as the markup writes it, and whether ⌘ or Ctrl asked for a new tab.
  // Absent: a web address opens through the backend, and the rest is inert.
  onFollowLink?: (href: string, newTab: boolean) => void;
  // False takes the whole comment layer away (cards, marks, the ways to
  // start a thread). The split view's unfocused pane uses this: comments
  // there activate only after the pane is promoted to the focused document.
  commentsEnabled?: boolean;
  // Whether comments are shown: the app-wide switch a note's comments follow
  // too. Hidden, the page is as its reader gets it, at its full width.
  commentsVisible?: boolean;
  // Starting a thread while comments are hidden shows them, as in a note.
  onRequestShowComments?: () => void;
  // ⇧C: show or hide comments.
  onToggleComments?: () => void;
  // Whether keys pressed outside the frame are this view's (the focused
  // pane's). Keys pressed inside the frame are always its own view's.
  keysActive?: boolean;
  // Split-view scroll sync: a USER scroll of the rendition's document, as a
  // 0..1 proportion of its scrollable range (programmatic sync moves are
  // filtered script-side).
  onScrollRatio?: (ratio: number) => void;
  // Any pointerdown inside the sandboxed frame (which the app can't observe
  // directly) — the split view uses it to move pane focus here.
  onGesture?: () => void;
  // Document zoom (⌘+ / ⌘-), the same factor the markdown editor scales by.
  // The rendition lives behind the sandbox, so the script applies it inside
  // the frame; hosts that don't zoom (the web share, where the browser's own
  // zoom does the job) leave it at 1.
  zoom?: number;
  // One of the app's shortcuts pressed while focus is inside the frame —
  // the app's own key handlers can't see those.
  onShortcut?: (shortcut: AppShortcut) => void;
  // Absolute path of the rendition on disk — presence enables the "PDF"
  // button (desktop only; web hosts omit it). The export itself runs in the
  // Rust backend against a pinned headless engine (see pdf_export.rs) and
  // REFUSES rather than emit a PDF its validation gate can prove wrong.
  pdfExportPath?: string | null;
  // Where this view's controls (Comment, and PDF export where it exists)
  // render. Hosts pass a node inside their own chrome and the row is
  // portalled into it. Three-valued on purpose: `undefined` means the host
  // has no chrome to dock into (the bare verification harness) and the row
  // falls back to floating over the rendition's top-right corner; `null`
  // means the host DOES dock but its node hasn't mounted yet, so nothing
  // renders this frame — floating first would flash the buttons across the
  // document before they jump into the bar.
  controlsSlot?: HTMLElement | null;
};

// Export button states. The error text is the Rust gate's refusal verbatim —
// it names the failed check (and page), per the export contract.
type PdfState =
  | { kind: "idle" }
  | { kind: "running"; label: string }
  | { kind: "saved"; name: string }
  | { kind: "error"; msg: string };

// Imperative surface for the split view's scroll sync: drive this rendition
// to a proportional scroll offset.
export type HtmlViewHandle = {
  scrollToRatio: (ratio: number) => void;
};

// What the reader has selected, and the part under the pointer while picking.
type Selected = { anchor: HtmlAnchor; box: Box; first: Box };
type Offered = { anchor: HtmlAnchor; box: Box; label: PartLabel | null };

const MARKER = 20; // a part's marker, square

const KIND_WORDS: Record<PartKind, string> = {
  block: "Part",
  section: "Section",
  heading: "Heading",
  paragraph: "Paragraph",
  list: "List",
  item: "List item",
  table: "Table",
  row: "Table row",
  picture: "Picture",
  drawing: "Drawing",
  button: "Button",
};
const STATES: ReadonlySet<string> = new Set<PlaceState>(["found", "changed", "part", "lost"]);

/* What arrives from the frame is untrusted: numbers, or nothing. */

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function boxOf(v: unknown): Box | null {
  const b = v as Box | null;
  if (!b || typeof b !== "object") return null;
  const top = num(b.top);
  const left = num(b.left);
  const width = num(b.width);
  const height = num(b.height);
  return top === null || left === null || width === null || height === null ? null : { top, left, width, height };
}

function labelOf(v: unknown): PartLabel | null {
  const l = v as PartLabel | null;
  if (!l || typeof l !== "object" || typeof l.title !== "string") return null;
  return Object.prototype.hasOwnProperty.call(KIND_WORDS, l.kind) ? { kind: l.kind, title: l.title.slice(0, 90) } : null;
}

function placeOf(v: unknown): BridgePlace | null {
  const p = v as BridgePlace | null;
  if (!p || typeof p !== "object" || typeof p.id !== "string" || !STATES.has(p.state)) return null;
  const out: BridgePlace = { id: p.id, state: p.state };
  const top = num(p.top);
  if (top !== null) out.top = top;
  const words = boxOf(p.words);
  if (words) out.words = words;
  const part = boxOf(p.part);
  if (part) out.part = part;
  const label = labelOf(p.label);
  if (label) out.label = label;
  if (p.hidden === true) out.hidden = true;
  return out;
}

const HtmlView = forwardRef<HtmlViewHandle, Props>(function HtmlView(
  {
    htmlContent,
    threads,
    onThreadsChange,
    commentAuthor,
    onFollowLink,
    commentsEnabled = true,
    commentsVisible = true,
    onRequestShowComments,
    onToggleComments,
    keysActive = true,
    onScrollRatio,
    onGesture,
    zoom = 1,
    onShortcut,
    pdfExportPath,
    controlsSlot,
  }: Props,
  ref,
) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditTarget>(null);
  const [picking, setPicking] = useState(false);
  // Where each thread is on the page, as the script last said.
  const [places, setPlaces] = useState<Map<string, BridgePlace>>(new Map());
  // Whether the script tints commented words (it can't in a browser without
  // the highlight registry; the overlay outlines them instead).
  const [painted, setPainted] = useState(true);
  // How tall the page is, as its script last said: the cards are kept above
  // its end, since the page is all that scrolls.
  const [pageHeight, setPageHeight] = useState<number | null>(null);
  const [selection, setSelection] = useState<Selected | null>(null);
  const [offered, setOffered] = useState<Offered | null>(null);
  // The thread under the pointer: over its card or marker, or over its words.
  const [cardHover, setCardHover] = useState<string | null>(null);
  const [frameHover, setFrameHover] = useState<string | null>(null);
  // PDF export: idle → running (stage streamed from Rust via
  // pdf-export-progress) → a transient "Saved" flash, or an error card.
  const [pdf, setPdf] = useState<PdfState>({ kind: "idle" });
  // The page's canvas colour as the script reports it, painted over the
  // frame's white backdrop so the scrollbar gutter matches the page.
  const [canvas, setCanvas] = useState<string | null>(null);

  // The page's scroll, and the layers that follow it: what is drawn on the
  // page moves both ways, what sits beside or at the edge of it only up and
  // down. Moved by a transform as each scroll arrives, never by a render.
  const scrollRef = useRef({ x: 0, y: 0 });
  const pageLayerRef = useRef<HTMLDivElement | null>(null);
  const edgeLayerRef = useRef<HTMLDivElement | null>(null);
  const cardsLayerRef = useRef<HTMLDivElement | null>(null);
  const applyScroll = useCallback(() => {
    const { x, y } = scrollRef.current;
    if (pageLayerRef.current) pageLayerRef.current.style.transform = `translate3d(${-x}px, ${-y}px, 0)`;
    if (edgeLayerRef.current) edgeLayerRef.current.style.transform = `translate3d(0, ${-y}px, 0)`;
    if (cardsLayerRef.current) cardsLayerRef.current.style.transform = `translate3d(0, ${-y}px, 0)`;
  }, []);
  // A layer that has just appeared takes the scroll there already is.
  useLayoutEffect(applyScroll);

  const shown = commentsEnabled && commentsVisible;

  // Refs for the message handler (installed once).
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const pickingRef = useRef(picking);
  pickingRef.current = picking;
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const enabledRef = useRef(commentsEnabled);
  enabledRef.current = commentsEnabled;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const hover = cardHover ?? frameHover;
  const hoverRef = useRef(hover);
  hoverRef.current = hover;
  const authorRef = useRef(commentAuthor);
  authorRef.current = commentAuthor;
  const onThreadsChangeRef = useRef(onThreadsChange);
  onThreadsChangeRef.current = onThreadsChange;
  const onFollowLinkRef = useRef(onFollowLink);
  onFollowLinkRef.current = onFollowLink;
  const onRequestShowRef = useRef(onRequestShowComments);
  onRequestShowRef.current = onRequestShowComments;
  const onToggleRef = useRef(onToggleComments);
  onToggleRef.current = onToggleComments;
  const onScrollRatioRef = useRef(onScrollRatio);
  onScrollRatioRef.current = onScrollRatio;
  const onGestureRef = useRef(onGesture);
  onGestureRef.current = onGesture;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const onShortcutRef = useRef(onShortcut);
  onShortcutRef.current = onShortcut;
  const pdfPathRef = useRef(pdfExportPath);
  pdfPathRef.current = pdfExportPath;

  const srcDoc = useMemo(() => instrumentHtml(htmlContent), [htmlContent]);
  // Where the app's own page may not be handed markup that runs script, the
  // frame is a page of the platform's that asks for the markup instead
  // (`Backend.htmlFrame`), loaded afresh for each markup it is to show.
  const frameHost = backend.htmlFrame;
  const srcDocRef = useRef(srcDoc);
  srcDocRef.current = srcDoc;
  const frameLoads = useRef(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the count moves when the markup does
  const frameLoad = useMemo(() => (frameLoads.current += 1), [srcDoc]);

  const post = useCallback((msg: BridgeInMsg) => {
    iframeRef.current?.contentWindow?.postMessage(msg, "*");
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      scrollToRatio(ratio: number) {
        post({ dk: "doklin-comments", type: "scroll-sync", ratio });
      },
    }),
    [post],
  );

  const syncBridge = useCallback(() => {
    post({
      dk: "doklin-comments",
      type: "sync",
      threads: bridgeThreads(threadsRef.current),
      visible: shownRef.current,
      picking: pickingRef.current,
      activeId: activeIdRef.current,
      hoverId: hoverRef.current,
      zoom: zoomRef.current,
    });
  }, [post]);

  // Push every state change down; the script finds each place again and
  // says where it is. (On a frame reload — external regeneration rewrites
  // srcDoc — the fresh script says "ready" and gets the same sync.)
  useEffect(() => {
    syncBridge();
  }, [threads, shown, picking, zoom, syncBridge]);

  // What is open or under the pointer is only a repaint.
  useEffect(() => {
    post({ dk: "doklin-comments", type: "focus", activeId, hoverId: hover });
  }, [activeId, hover, post]);

  // An empty draft (opened, never written) is discarded, not saved.
  const dropDraft = useCallback((id: string) => {
    const t = threadsRef.current.find((x) => x.id === id);
    if (t && t.comments.length === 1 && t.comments[0].body === "") {
      onThreadsChangeRef.current(deleteHtmlThread(threadsRef.current, id));
    }
  }, []);

  // A new thread: an empty card, open for typing, level with what it is on
  // before the script's next word on where that is.
  const startThread = useCallback(
    (anchor: HtmlAnchor, place: Omit<BridgePlace, "id" | "state">) => {
      const e = editingRef.current;
      if (e && e.index === 0) dropDraft(e.id);
      onRequestShowRef.current?.();
      const { next, id } = createHtmlThread(threadsRef.current, anchor, authorRef.current);
      onThreadsChangeRef.current(next);
      setPlaces((prev) => new Map(prev).set(id, { id, state: "found", ...place }));
      setActiveId(id);
      setEditing({ id, index: 0 });
      setPicking(false);
      setOffered(null);
    },
    [dropDraft],
  );

  const startOnWords = useCallback(() => {
    const sel = selectionRef.current;
    if (!sel || !enabledRef.current) return;
    startThread(sel.anchor, { top: sel.first.top, words: sel.box });
    setSelection(null);
    post({ dk: "doklin-comments", type: "deselect" });
  }, [startThread, post]);

  const leavePicking = useCallback(() => {
    setPicking(false);
    setOffered(null);
  }, []);

  // The comment keys, wherever they were pressed: inside the frame (the
  // script forwards them) or outside it (the window listener below).
  const onKey = useCallback(
    (key: "c" | "C" | "m" | "Escape") => {
      if (!enabledRef.current) return;
      if (key === "Escape") {
        // Stop picking; else drop the draft being written; else close the
        // open card.
        if (pickingRef.current) {
          leavePicking();
          return;
        }
        const e = editingRef.current;
        if (e) {
          setEditing(null);
          if (e.index === 0) dropDraft(e.id);
          return;
        }
        setActiveId(null);
      } else if (key === "C") {
        onToggleRef.current?.();
      } else if (key === "m") {
        startOnWords();
      } else if (pickingRef.current) {
        leavePicking();
      } else {
        // Picking starts with nothing open: one thing at a time.
        const e = editingRef.current;
        if (e && e.index === 0) dropDraft(e.id);
        setEditing(null);
        setActiveId(null);
        onRequestShowRef.current?.();
        setPicking(true);
      }
    },
    [dropDraft, leavePicking, startOnWords],
  );
  const onKeyRef = useRef(onKey);
  onKeyRef.current = onKey;

  useEffect(() => {
    if (!commentsEnabled || !keysActive) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === "KeyM") {
        if (!selectionRef.current) return;
        e.preventDefault();
        onKeyRef.current("m");
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // A key typed into a box (a card's, the sidebar's, a note's) is that box's.
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (pickingRef.current && (e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey) {
        // While picking, ↑ and ↓ move the outline out and in, wherever the keyboard is.
        e.preventDefault();
        post({ dk: "doklin-comments", type: "widen", by: e.key === "ArrowUp" ? 1 : -1 });
      } else if (e.key === "Escape") {
        onKeyRef.current("Escape");
      } else if (e.key === "c" || e.key === "C") {
        onKeyRef.current(e.shiftKey ? "C" : "c");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [commentsEnabled, keysActive, post]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const frame = iframeRef.current?.contentWindow;
      if (!frame || e.source !== frame) return;
      if ((e.data as { doklin?: unknown } | null)?.doklin === "frame-ready") {
        // The frame's origin is opaque, so there is none to address it by:
        // it is this view's own frame, and nothing else is posted to.
        frame.postMessage({ doklin: "frame-html", html: srcDocRef.current }, "*");
        return;
      }
      if (!isBridgeMsg(e.data)) return;
      // The frame is untrusted: everything below is taken as positions and
      // quoted words, checked for what it claims to be, never as something
      // to do.
      const msg = e.data;
      if (msg.type === "ready") {
        syncBridge();
      } else if (msg.type === "layout") {
        const said = Array.isArray(msg.places) ? msg.places : [];
        setPlaces(new Map(said.flatMap((p) => { const place = placeOf(p); return place ? [[place.id, place] as const] : []; })));
        setPainted(msg.painted !== false);
        setPageHeight(num(msg.pageHeight));
        scrollRef.current = { x: num(msg.scrollX) ?? 0, y: num(msg.scrollY) ?? 0 };
        applyScroll();
      } else if (msg.type === "scroll") {
        scrollRef.current = { x: num(msg.x) ?? 0, y: num(msg.y) ?? 0 };
        applyScroll();
        const ratio = num(msg.ratio);
        if (ratio !== null) onScrollRatioRef.current?.(ratio);
      } else if (msg.type === "select") {
        const anchor = anchorFromFrame(msg.anchor);
        const box = boxOf(msg.box);
        const first = boxOf(msg.first);
        setSelection(anchor && anchor.quote && box && first ? { anchor, box, first } : null);
      } else if (msg.type === "pickhover" || msg.type === "pick") {
        if (!pickingRef.current) return;
        const anchor = anchorFromFrame(msg.anchor);
        const box = boxOf(msg.box);
        const label = labelOf(msg.label);
        // A part is picked whole: its words are not what the thread is on.
        const part: HtmlAnchor | null = anchor && { path: anchor.path, tag: anchor.tag, text: anchor.text, ...(anchor.ids ? { ids: anchor.ids } : {}) };
        if (msg.type === "pickhover") {
          setOffered(part && box ? { anchor: part, box, label } : null);
        } else if (part && box) {
          startThread(part, { top: box.top, part: box, ...(label ? { label } : {}) });
        }
      } else if (msg.type === "hover") {
        setFrameHover(typeof msg.id === "string" ? msg.id : null);
      } else if (msg.type === "activate") {
        if (!shownRef.current) return;
        setActiveId(typeof msg.id === "string" ? msg.id : null);
        if (typeof msg.id !== "string") setEditing(null);
      } else if (msg.type === "key") {
        // Taken only while the frame holds focus, where the key can have
        // been pressed: the page's own scripts can post this as well as the
        // app's.
        const focusedHere = document.hasFocus() && document.activeElement === iframeRef.current;
        if (focusedHere && (msg.key === "c" || msg.key === "C" || msg.key === "m" || msg.key === "Escape")) onKeyRef.current(msg.key);
      } else if (msg.type === "follow") {
        // The app follows the link; navigating the iframe would replace it
        // (and this whole layer) with what it leads to.
        if (typeof msg.href !== "string" || typeof msg.url !== "string") return;
        // A path (or `file:`) is a document's: the frame resolved it against
        // its own page, which is not where the document is.
        const toDocument = !/^\s*(?!file:)([a-z][a-z0-9+.-]*:|\/\/)/i.test(msg.href);
        const web = !toDocument && /^(https?:|mailto:)/i.test(msg.url);
        if (onFollowLinkRef.current) {
          if (toDocument || web) onFollowLinkRef.current(toDocument ? msg.href : msg.url, msg.newTab === true);
        } else if (web) {
          void backend.openExternal(msg.url).catch((err) => console.error("open external failed", err));
        }
      } else if (msg.type === "gesture") {
        // A press inside the frame never reaches the app's window: tell
        // the open popover, if any, it was pressed outside.
        pressedOutside();
        onGestureRef.current?.();
      } else if (msg.type === "shortcut") {
        // Taken only while the frame holds focus, where the key can have been
        // pressed: the page's own scripts can post this as well as the bridge.
        const focusedHere = document.hasFocus() && document.activeElement === iframeRef.current;
        if (focusedHere && isAppShortcut(msg.shortcut)) onShortcutRef.current?.(msg.shortcut);
      } else if (msg.type === "canvas") {
        // A single colour value or nothing, so the string can never smuggle
        // a url() into the app's own styles.
        if (typeof msg.color === "string" && CSS.supports("color", msg.color)) setCanvas(msg.color);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [syncBridge, applyScroll, startThread]);

  // Comments hidden, or the layer taken away (a demoted split pane): nothing
  // invisible stays open, armed or half-written.
  useEffect(() => {
    if (shown) return;
    const e = editingRef.current;
    if (e && e.index === 0) dropDraft(e.id);
    setActiveId(null);
    setEditing(null);
    setPicking(false);
    setOffered(null);
    setCardHover(null);
    setFrameHover(null);
  }, [shown, dropDraft]);
  useEffect(() => {
    if (!commentsEnabled) setSelection(null);
  }, [commentsEnabled]);

  // Janitor (Editor.tsx recompute parity): transient state whose thread
  // vanished — deleted here, or removed by an external sidecar reload — is
  // dropped rather than left dangling.
  useEffect(() => {
    setActiveId((a) => (a != null && !threads.some((t) => t.id === a) ? null : a));
    setEditing((e) => {
      if (!e) return e;
      const t = threads.find((x) => x.id === e.id);
      return t && e.index < t.comments.length ? e : null;
    });
  }, [threads]);

  // One-click export (no options, by design). One export runs at a time: a
  // second click elsewhere just errors.
  const exportPdf = useCallback(async () => {
    const path = pdfPathRef.current;
    if (!path || !backend.pdf) return;
    setPdf({ kind: "running", label: "Exporting…" });
    try {
      const saved = await backend.pdf.export(path, ({ stage, pct }) => {
        const label =
          stage === "engine-download"
            ? `Fetching engine ${pct ?? 0}%`
            : stage === "pdfium-download"
              ? "Fetching PDF tools…"
              : stage === "engine-unpack" || stage === "pdfium-unpack"
                ? "Unpacking engine…"
                : stage === "validating"
                  ? "Checking…"
                  : "Rendering…";
        setPdf((p) => (p.kind === "running" ? { kind: "running", label } : p));
      });
      setPdf({ kind: "saved", name: saved.split("/").pop() ?? "PDF" });
    } catch (err) {
      setPdf({ kind: "error", msg: String(err) });
    }
  }, []);

  // The "Saved …" flash decays back to the plain button.
  useEffect(() => {
    if (pdf.kind !== "saved") return;
    const t = window.setTimeout(() => setPdf({ kind: "idle" }), 2500);
    return () => window.clearTimeout(t);
  }, [pdf]);

  /* ----- card callbacks: same contracts as Editor.tsx, over the sidecar ----- */

  // Opening a thread from its card or its marker brings its place into view.
  const onActivate = useCallback(
    (id: string) => {
      setActiveId(id);
      post({ dk: "doklin-comments", type: "reveal", id });
    },
    [post],
  );

  const onStartEdit = useCallback((id: string, index: number) => {
    setActiveId(id);
    setEditing({ id, index });
  }, []);

  const onCommitEdit = useCallback((id: string, index: number, body: string) => {
    setEditing(null);
    const thread = threadsRef.current.find((t) => t.id === id);
    const entry = thread?.comments[index];
    if (!entry) return;
    if (body.trim() === "") {
      if (index === 0 && entry.body === "") {
        // An abandoned draft (opened, never written) is discarded on blur.
        onThreadsChangeRef.current(deleteHtmlThread(threadsRef.current, id));
        setActiveId((a) => (a === id ? null : a));
      }
      // Emptying an existing entry reverts it; deleting is an explicit act.
    } else if (body !== entry.body) {
      onThreadsChangeRef.current(updateHtmlCommentBody(threadsRef.current, id, index, body));
    }
  }, []);

  const onCancelEdit = useCallback((id: string, index: number) => {
    setEditing(null);
    if (index !== 0) return;
    const thread = threadsRef.current.find((t) => t.id === id);
    if (thread?.comments[0]?.body === "") {
      onThreadsChangeRef.current(deleteHtmlThread(threadsRef.current, id));
      setActiveId((a) => (a === id ? null : a));
    }
  }, []);

  const onReply = useCallback((id: string, body: string) => {
    onThreadsChangeRef.current(addHtmlReply(threadsRef.current, id, authorRef.current, body));
  }, []);

  const onDeleteThread = useCallback((id: string) => {
    setEditing((e) => (e?.id === id ? null : e));
    setActiveId((a) => (a === id ? null : a));
    onThreadsChangeRef.current(deleteHtmlThread(threadsRef.current, id));
  }, []);

  const onDeleteReply = useCallback((id: string, index: number) => {
    setEditing((e) => (e && e.id === id && e.index === index ? null : e));
    onThreadsChangeRef.current(deleteHtmlReply(threadsRef.current, id, index));
  }, []);

  // The cards, top to bottom as their places are down the page. A thread
  // whose place is not found sits at the top, saying so. Each says what it is
  // on: its words, or the part.
  const cards: RailThread[] = useMemo(() => {
    const rows = threads.map((t, index) => {
      const place = places.get(t.id);
      const lost = place?.state === "lost";
      const card: RailThread = {
        id: t.id,
        comments: t.comments,
        anchorTop: lost ? 0 : (place?.top ?? 0),
        orphaned: lost,
        on: t.anchor.quote
          ? { quote: t.anchor.quote }
          : { kind: place?.label ? KIND_WORDS[place.label.kind] : "Part", title: place?.label?.title ?? t.anchor.text },
      };
      if (t.anchor.quote && place?.state === "changed") card.note = "These words have changed since the comment";
      if (t.anchor.quote && place?.state === "part") card.note = "These words are gone";
      return { card, index };
    });
    rows.sort((a, b) => a.card.anchorTop - b.card.anchorTop || a.index - b.index);
    return rows.map((r) => r.card);
  }, [threads, places]);

  // Parts with a thread on them: a marker at the part's top-right corner. Two
  // threads on one part (or two parts with one corner) sit side by side.
  const markers = useMemo(() => {
    if (!shown) return [];
    const corners = new Map<string, number>();
    return threads.flatMap((t) => {
      const place = places.get(t.id);
      const part = place?.part;
      if (!place || !part || place.hidden || t.anchor.quote) return [];
      const key = `${Math.round(part.top)}:${Math.round(part.left + part.width)}`;
      const nth = corners.get(key) ?? 0;
      corners.set(key, nth + 1);
      return [{
        id: t.id,
        top: part.top - MARKER / 2,
        left: Math.max(4, part.left + part.width - MARKER * 0.6 - nth * (MARKER + 2)),
      }];
    });
  }, [shown, threads, places]);

  // The thread whose place is outlined: the open one, else the one under the
  // pointer. A part is outlined; words are tinted in the page itself, and
  // outlined only where the page can't be tinted, or where the words are gone
  // and the thread has fallen back to their part.
  const lit = activeId ?? hover;
  const litPlace = shown && lit ? places.get(lit) : undefined;
  const outlined = litPlace && !litPlace.hidden ? (litPlace.part ?? (painted ? null : (litPlace.words ?? null))) : null;

  const showMargin = shown && threads.length > 0;

  // Docked = the host gave us a place in its chrome (see controlsSlot). The
  // class swaps the floating pill styling for the compact look the bar's
  // other controls wear, and moves the refusal card up into the corner the
  // buttons used to occupy.
  const docked = controlsSlot !== undefined;
  const controls = (
    <div className={`html-view-btns ${docked ? "is-docked" : ""}`}>
      {pdfExportPath != null && backend.pdf && (
        <button
          type="button"
          className={`html-comment-btn html-pdf-btn ${pdf.kind === "running" ? "is-busy" : ""}`}
          disabled={pdf.kind === "running"}
          title="Export this rendition as a validated PDF"
          onClick={() => void exportPdf()}
        >
          <PdfIcon />
          {pdf.kind === "running"
            ? pdf.label
            : pdf.kind === "saved"
              ? `Saved ${pdf.name}`
              : "PDF"}
        </button>
      )}
      {commentsEnabled && (
        <button
          type="button"
          className={`html-comment-btn ${picking ? "is-on" : ""}`}
          aria-pressed={picking}
          title={picking ? "Stop picking (Esc)" : "Comment on a part of the page (C)"}
          onClick={() => onKey("c")}
        >
          <BubbleIcon size={13} />
          Comment
        </button>
      )}
    </div>
  );

  return (
    <div className={`html-view ${showMargin ? "has-margin" : ""}`}>
      <div className="html-frame-box">
        {/* The rendition is arbitrary generated markup: render it isolated in a
            sandboxed frame (scripts run under an opaque origin — no access to
            the app, its storage, or Tauri IPC). The script instrumentHtml adds
            runs inside that same sandbox. */}
        <iframe
          key={frameHost ? frameLoad : undefined}
          ref={iframeRef}
          className="html-preview"
          title="HTML version"
          sandbox="allow-scripts allow-popups"
          {...(frameHost ? { src: frameHost } : { srcDoc })}
          // A one-colour gradient layers the page's colour over the white
          // backdrop, compositing a translucent canvas exactly as the page does.
          style={canvas ? { backgroundImage: `linear-gradient(${canvas}, ${canvas})` } : undefined}
        />
        <div className={`html-comment-layer ${docked ? "is-docked" : ""}`}>
          {docked ? controlsSlot && createPortal(controls, controlsSlot) : controls}
          {pdf.kind === "error" && (
            // The gate's refusal, verbatim: which check failed, on which page.
            // Stays up until dismissed — this is the feature telling the user
            // their PDF would have been wrong, not a transient hiccup.
            <div className="html-pdf-error" role="alert">
              <div className="html-pdf-error-head">
                Export refused
                <button
                  type="button"
                  className="html-pdf-error-x"
                  title="Dismiss"
                  onClick={() => setPdf({ kind: "idle" })}
                >
                  ×
                </button>
              </div>
              <div className="html-pdf-error-msg">{pdf.msg}</div>
            </div>
          )}
          {commentsEnabled && (
            <>
              {/* Drawn on the page: moves with it both ways. */}
              <div className="html-page-layer" ref={pageLayerRef}>
                {outlined && !picking && <PartOutline box={outlined} />}
                {picking && offered && <PartOutline box={offered.box} picking label={offered.label} />}
                {!picking &&
                  markers.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      className={`html-comment-marker ${m.id === lit ? "is-lit" : ""}`}
                      style={{ top: m.top, left: m.left }}
                      title="Open comment"
                      aria-label="Open comment"
                      onMouseEnter={() => setCardHover(m.id)}
                      onMouseLeave={() => setCardHover((h) => (h === m.id ? null : h))}
                      onClick={() => onActivate(m.id)}
                    >
                      <BubbleIcon size={11} />
                    </button>
                  ))}
              </div>
              {/* At the page's edge: level with the selection, whatever the page's width. */}
              <div className="html-edge-layer" ref={edgeLayerRef}>
                {selection && !picking && (
                  <button
                    type="button"
                    className="html-select-comment"
                    style={{ top: selection.first.top + selection.first.height / 2 }}
                    title="Comment on the selected words (⌘⌥M)"
                    // The press must not take the selection it is about.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={startOnWords}
                  >
                    <BubbleIcon size={13} />
                    Comment
                  </button>
                )}
              </div>
              {picking && (
                <div className="html-pick-bar" role="status">
                  Click a part to comment
                  <span className="html-pick-bar-keys">↑ ↓ for a wider or narrower part</span>
                  <button type="button" className="html-pick-bar-stop" onClick={leavePicking}>
                    Esc to stop
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {showMargin && (
        // The page is all that scrolls, and the cards follow it. The wheel
        // over them scrolls it; and when the browser scrolls the column
        // itself to show something in a card (the caret while typing, a
        // control the Tab key lands on), that move is the page's too, or
        // every card would sit that far from its place from then on.
        <aside
          className="html-comments-margin"
          aria-label="Comments"
          onWheel={(e) => post({ dk: "doklin-comments", type: "scroll-by", dy: e.deltaY })}
          onScroll={(e) => {
            const column = e.currentTarget;
            const dy = column.scrollTop;
            if (dy === 0 && column.scrollLeft === 0) return;
            column.scrollTop = 0;
            column.scrollLeft = 0;
            if (dy !== 0) post({ dk: "doklin-comments", type: "scroll-by", dy });
          }}
        >
          <div className="html-cards-layer" ref={cardsLayerRef}>
            <CommentsRail
              threads={cards}
              activeId={activeId}
              editing={editing}
              selfAuthor={commentAuthor}
              hoverId={hover}
              onHover={setCardHover}
              floor={pageHeight ?? undefined}
              onActivate={onActivate}
              onStartEdit={onStartEdit}
              onCommitEdit={onCommitEdit}
              onCancelEdit={onCancelEdit}
              onReply={onReply}
              onDeleteThread={onDeleteThread}
              onDeleteReply={onDeleteReply}
            />
          </div>
        </aside>
      )}
    </div>
  );
});

export default HtmlView;

// The outline of a part: the one a thread is on, or (dashed, with what it is)
// the one offered while picking. A few pixels clear of the part, so its own
// border still reads.
function PartOutline({ box, picking = false, label = null }: { box: Box; picking?: boolean; label?: PartLabel | null }) {
  return (
    <div
      className={`html-part-outline ${picking ? "is-picking" : ""}`}
      style={{ top: box.top - 4, left: box.left - 4, width: box.width + 8, height: box.height + 8 }}
    >
      {picking && label && (
        <span className="html-part-outline-label">
          {KIND_WORDS[label.kind]}
          {label.title && <span className="html-part-outline-title"> · {label.title}</span>}
        </span>
      )}
    </div>
  );
}

function PdfIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M12 11v6" />
      <path d="m9.5 14.5 2.5 2.5 2.5-2.5" />
    </svg>
  );
}

function BubbleIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}
