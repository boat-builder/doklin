import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Avatar, ThreadCard, type EditTarget, type RailThread } from "./CommentsRail";
import {
  addHtmlReply,
  createHtmlThread,
  deleteHtmlReply,
  deleteHtmlThread,
  updateHtmlCommentBody,
  type HtmlThread,
} from "./htmlComments";
import {
  bridgeThreads,
  instrumentHtml,
  isBridgeMsg,
  type AnchorRect,
  type BridgeSyncMsg,
} from "./htmlBridge";

// The HTML rendition view: the sandboxed preview iframe plus its comment
// layer. The layer lives behind an explicit COMMENT MODE, entered from this
// view's controls — which dock into the HOST's chrome (the desktop tab bar,
// a split pane's header, the web share's top bar) instead of floating over
// the rendition: a generated document owns its whole canvas, and app buttons
// standing on it read as part of the page. Mode off (the default) shows the
// pristine page; mode on dims the page (bridge-side scrim), arms the hover
// "add comment" bubble, and overlays existing threads AT their elements:
// a small avatar pin on each commented element, expanding into a floating
// card when clicked. No side rail — comments live where they were made.
//
// The iframe DOM is out of reach behind the sandbox's opaque origin, so all
// element work happens bridge-side (see htmlBridge.ts) and this component
// only exchanges messages: it sends the thread list, comment mode, and the
// active id down; it gets anchor rects (iframe-viewport space — the overlay
// shares the same box, so they position pins/cards directly), picks, and
// activations back.
//
// Thread DATA lives with the host (App owns the entity meta file and its
// persistence, like it owns the markdown autosave); this component owns the
// transient UI state — comment mode, active card, which entry is being
// edited — mirroring Editor.tsx's split, including the draft semantics: a
// new thread opens as an empty card, and an abandoned draft (committed or
// cancelled empty, or left behind when mode exits) is discarded, not saved.
type Props = {
  htmlContent: string;
  threads: HtmlThread[];
  onThreadsChange: (next: HtmlThread[]) => void;
  commentAuthor: string;
  // How external links leave the rendition. The desktop default routes them
  // to the system browser via Tauri; a web host passes window.open instead.
  onOpenExternal?: (url: string) => void;
  // False hides the whole comment layer (button, pins, cards). The split
  // view's unfocused pane uses this: comments there activate only after the
  // pane is promoted to the focused document.
  commentsEnabled?: boolean;
  // Split-view scroll sync: a USER scroll of the rendition's document, as a
  // 0..1 proportion of its scrollable range (programmatic sync moves are
  // filtered bridge-side).
  onScrollRatio?: (ratio: number) => void;
  // Any pointerdown inside the sandboxed frame (which the app can't observe
  // directly) — the split view uses it to move pane focus here.
  onGesture?: () => void;
  // Document zoom (⌘+ / ⌘-), the same factor the markdown editor scales by.
  // The rendition lives behind the sandbox, so the bridge applies it inside
  // the frame; hosts that don't zoom (the web share, where the browser's own
  // zoom does the job) leave it at 1.
  zoom?: number;
  // A zoom chord pressed while focus is inside the frame (1 in, -1 out, 0
  // reset) — the app's own key handler can't see those.
  onZoomKey?: (dir: number) => void;
  // Absolute path of the rendition on disk — presence enables the "PDF"
  // button (desktop only; web hosts omit it). The export itself runs in the
  // Rust backend against a pinned headless engine (see pdf_export.rs) and
  // REFUSES rather than emit a PDF its validation gate can prove wrong.
  pdfExportPath?: string | null;
  // Where this view's controls (Comment mode, and PDF export where it
  // exists) render. Hosts pass a node inside their own chrome and the row is
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

const CARD_W = 300;
const PIN = 26; // pin hit target, square

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

const HtmlView = forwardRef<HtmlViewHandle, Props>(function HtmlView(
  {
    htmlContent,
    threads,
    onThreadsChange,
    commentAuthor,
    onOpenExternal,
    commentsEnabled = true,
    onScrollRatio,
    onGesture,
    zoom = 1,
    onZoomKey,
    pdfExportPath,
    controlsSlot,
  }: Props,
  ref,
) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [mode, setMode] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditTarget>(null);
  // Latest anchor layout from the bridge: element rects (viewport space) and
  // which threads failed to re-anchor. Orphans surface in a stack under the
  // Comment button instead of vanishing.
  const [rects, setRects] = useState<Map<string, AnchorRect>>(new Map());
  const [orphans, setOrphans] = useState<Set<string>>(new Set());
  // The overlay's own box — pins and cards clamp inside it.
  const [size, setSize] = useState({ w: 0, h: 0 });
  // PDF export: idle → running (stage streamed from Rust via
  // pdf-export-progress) → a transient "Saved" flash, or an error card.
  const [pdf, setPdf] = useState<PdfState>({ kind: "idle" });

  // Refs for the message handler (installed once).
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const authorRef = useRef(commentAuthor);
  authorRef.current = commentAuthor;
  const onThreadsChangeRef = useRef(onThreadsChange);
  onThreadsChangeRef.current = onThreadsChange;
  const onOpenExternalRef = useRef(onOpenExternal);
  onOpenExternalRef.current = onOpenExternal;
  const onScrollRatioRef = useRef(onScrollRatio);
  onScrollRatioRef.current = onScrollRatio;
  const onGestureRef = useRef(onGesture);
  onGestureRef.current = onGesture;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const onZoomKeyRef = useRef(onZoomKey);
  onZoomKeyRef.current = onZoomKey;
  const pdfPathRef = useRef(pdfExportPath);
  pdfPathRef.current = pdfExportPath;

  const srcDoc = useMemo(() => instrumentHtml(htmlContent), [htmlContent]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToRatio(ratio: number) {
        iframeRef.current?.contentWindow?.postMessage(
          { dk: "doklin-comments", type: "scroll-sync", ratio },
          "*",
        );
      },
    }),
    [],
  );

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() =>
      setSize({ w: el.clientWidth, h: el.clientHeight }),
    );
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const postToBridge = useCallback((msg: BridgeSyncMsg) => {
    iframeRef.current?.contentWindow?.postMessage(msg, "*");
  }, []);

  const syncBridge = useCallback(() => {
    postToBridge({
      dk: "doklin-comments",
      type: "sync",
      threads: bridgeThreads(threadsRef.current),
      activeId: activeIdRef.current,
      visible: modeRef.current,
      zoom: zoomRef.current,
    });
  }, [postToBridge]);

  // Push every state change down; the bridge re-resolves and reports layout
  // back. (On iframe reload — external regeneration rewrites srcDoc — the
  // fresh bridge says "ready" and gets the same sync.)
  useEffect(() => {
    syncBridge();
  }, [threads, activeId, mode, zoom, syncBridge]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      if (!isBridgeMsg(e.data)) return;
      const msg = e.data;
      if (msg.type === "ready") {
        syncBridge();
      } else if (msg.type === "layout") {
        setRects(new Map(msg.rects.map((r) => [r.id, r])));
        setOrphans(new Set(msg.orphans));
      } else if (msg.type === "pick") {
        // The hover bubble (comment mode only): create a draft thread on the
        // picked element and open its card for typing.
        const { next, id } = createHtmlThread(
          threadsRef.current,
          msg.anchor,
          authorRef.current,
        );
        onThreadsChangeRef.current(next);
        setRects((prev) => new Map(prev).set(id, msg.rect)); // place the card before the next layout arrives
        setActiveId(id);
        setEditing({ id, index: 0 });
      } else if (msg.type === "activate") {
        setActiveId(msg.id);
        if (msg.id === null) setEditing(null);
      } else if (msg.type === "open") {
        // External links open outside the rendition; navigating the iframe
        // would replace it (and this whole layer) with the site.
        if (onOpenExternalRef.current) {
          onOpenExternalRef.current(msg.url);
        } else {
          void invoke("open_external", { url: msg.url }).catch((err) =>
            console.error("open_external failed", err),
          );
        }
      } else if (msg.type === "scroll") {
        onScrollRatioRef.current?.(msg.ratio);
      } else if (msg.type === "gesture") {
        onGestureRef.current?.();
      } else if (msg.type === "zoom-key") {
        onZoomKeyRef.current?.(msg.dir);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [syncBridge]);

  // The unfocused split pane disables the layer; dropping out of enabled
  // mid-session (a demote) must not leave an invisible mode/card armed.
  useEffect(() => {
    if (commentsEnabled) return;
    setMode(false);
    setActiveId(null);
    setEditing(null);
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

  // Entering/leaving comment mode. Leaving discards an unwritten draft (its
  // textarea's blur usually got there first — this is the belt to that
  // suspender) and clears the selection: nothing invisible stays active.
  const toggleMode = useCallback(() => {
    const next = !modeRef.current;
    if (!next) {
      const e = editingRef.current;
      if (e && e.index === 0) {
        const t = threadsRef.current.find((x) => x.id === e.id);
        if (t && t.comments.length === 1 && t.comments[0].body === "") {
          onThreadsChangeRef.current(deleteHtmlThread(threadsRef.current, e.id));
        }
      }
      setActiveId(null);
      setEditing(null);
    }
    setMode(next);
  }, []);

  // One-click export (no options, by design). Subscribe to progress BEFORE
  // invoking so the first stage event can't slip past; the backend serializes
  // concurrent exports itself, so a second click elsewhere just errors.
  const exportPdf = useCallback(async () => {
    const path = pdfPathRef.current;
    if (!path) return;
    setPdf({ kind: "running", label: "Exporting…" });
    const unlisten = await listen<{ stage: string; pct: number | null }>(
      "pdf-export-progress",
      (e) => {
        const { stage, pct } = e.payload;
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
      },
    );
    try {
      const saved = await invoke<string>("export_pdf", { path });
      setPdf({ kind: "saved", name: saved.split("/").pop() ?? "PDF" });
    } catch (err) {
      setPdf({ kind: "error", msg: String(err) });
    } finally {
      unlisten();
    }
  }, []);

  // The "Saved …" flash decays back to the plain button.
  useEffect(() => {
    if (pdf.kind !== "saved") return;
    const t = window.setTimeout(() => setPdf({ kind: "idle" }), 2500);
    return () => window.clearTimeout(t);
  }, [pdf]);

  /* ----- card callbacks: same contracts as Editor.tsx, over the sidecar ----- */

  const onActivate = useCallback((id: string) => {
    setActiveId(id);
  }, []);

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

  const noopRef = useCallback(() => {}, []);
  const cardProps = {
    selfAuthor: commentAuthor,
    onActivate,
    onStartEdit,
    onCommitEdit,
    onCancelEdit,
    onReply,
    onDeleteThread,
    onDeleteReply,
  };

  const asRailThread = (t: HtmlThread, orphaned = false): RailThread => ({
    id: t.id,
    comments: t.comments,
    anchorTop: 0,
    orphaned,
  });

  // Pins: one per anchored, on-screen thread (the active one shows its card
  // instead). Nested or twice-commented elements would stack pins on the
  // same corner — nudge collisions apart so both stay clickable.
  const pins = useMemo(() => {
    if (!mode) return [];
    const placed: { id: string; top: number; left: number; count: number }[] = [];
    for (const t of threads) {
      if (t.id === activeId || orphans.has(t.id)) continue;
      const r = rects.get(t.id);
      if (!r) continue;
      if (r.top + r.height < 0 || r.top > size.h) continue; // off-screen anchor
      let left = clamp(r.left + r.width - PIN + 4, 8, size.w - PIN - 8);
      const top = clamp(r.top - 10, 8, size.h - PIN - 8);
      for (let nudges = 0; nudges <= placed.length; nudges += 1) {
        const clash = placed.find(
          (p) => Math.abs(p.top - top) < PIN && Math.abs(p.left - left) < PIN,
        );
        if (!clash) break;
        left = clash.left - PIN - 4;
      }
      placed.push({ id: t.id, top, left: Math.max(4, left), count: t.comments.length });
    }
    return placed;
  }, [mode, threads, rects, orphans, activeId, size]);

  const activeThread = activeId ? threads.find((t) => t.id === activeId) ?? null : null;
  const activeRect = activeThread && !orphans.has(activeThread.id)
    ? rects.get(activeThread.id) ?? null
    : null;

  // The floating card sits beside its element when the gutter is wide
  // enough, otherwise tucked over the element's right edge — always inside
  // the view, capped to the space below so long threads scroll internally.
  const cardPos = activeRect
    ? (() => {
        const beside = activeRect.left + activeRect.width + 10;
        const left =
          beside + CARD_W + 8 <= size.w
            ? beside
            : clamp(activeRect.left + activeRect.width - CARD_W, 8, size.w - CARD_W - 8);
        const top = clamp(activeRect.top, 8, Math.max(8, size.h - 180));
        return { left, top, maxHeight: size.h - top - 12 };
      })()
    : null;

  const orphaned = mode ? threads.filter((t) => orphans.has(t.id)) : [];
  const pinFaces = new Map(threads.map((t) => [t.id, t.comments[0]?.author ?? ""]));

  // Docked = the host gave us a place in its chrome (see controlsSlot). The
  // class swaps the floating pill styling for the compact look the bar's
  // other controls wear, and moves the refusal card up into the corner the
  // buttons used to occupy.
  const docked = controlsSlot !== undefined;
  const controls = (
    <div className={`html-view-btns ${docked ? "is-docked" : ""}`}>
      {pdfExportPath != null && (
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
      <button
        type="button"
        className={`html-comment-btn ${mode ? "is-on" : ""}`}
        aria-pressed={mode}
        title={mode ? "Hide comments" : "Review and comment"}
        onClick={toggleMode}
      >
        <BubbleIcon />
        {mode ? "Done" : "Comment"}
        {!mode && threads.length > 0 && (
          <span className="html-comment-btn-count">{threads.length}</span>
        )}
      </button>
    </div>
  );

  return (
    <div className="html-view" ref={rootRef}>
      {/* The rendition is arbitrary generated markup: render it isolated in a
          sandboxed frame (scripts run under an opaque origin — no access to
          the app, its storage, or Tauri IPC). The bridge script injected by
          instrumentHtml runs inside that same sandbox. */}
      <iframe
        ref={iframeRef}
        className="html-preview"
        title="HTML version"
        sandbox="allow-scripts allow-popups"
        srcDoc={srcDoc}
      />
      {commentsEnabled && (
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
        {pins.map((p) => (
          <button
            key={p.id}
            type="button"
            className="html-comment-pin"
            style={{ top: p.top, left: p.left }}
            title="Open comment"
            onClick={() => setActiveId(p.id)}
          >
            <Avatar name={pinFaces.get(p.id) ?? ""} />
            {p.count > 1 && <span className="html-comment-pin-count">{p.count}</span>}
          </button>
        ))}
        {activeThread && cardPos && (
          <div className="html-comment-pop" style={cardPos}>
            <ThreadCard
              setRef={noopRef}
              thread={asRailThread(activeThread)}
              top={0}
              active
              editing={editing && editing.id === activeThread.id ? editing.index : null}
              {...cardProps}
            />
          </div>
        )}
        {orphaned.length > 0 && (
          <div className="html-comment-orphans">
            {orphaned.map((t) => (
              <ThreadCard
                key={t.id}
                setRef={noopRef}
                thread={asRailThread(t, true)}
                top={0}
                active={t.id === activeId}
                editing={editing && editing.id === t.id ? editing.index : null}
                {...cardProps}
              />
            ))}
          </div>
        )}
      </div>
      )}
    </div>
  );
});

export default HtmlView;

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

function BubbleIcon() {
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
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}
