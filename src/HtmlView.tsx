import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import CommentsRail, { type RailThread, type EditTarget } from "./CommentsRail";
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
  type BridgeScrollToMsg,
  type BridgeSyncMsg,
} from "./htmlBridge";

// The HTML rendition view: the sandboxed preview iframe plus its comment
// layer (the same right-hand rail the markdown editor uses). The iframe DOM
// is out of reach behind the sandbox's opaque origin, so all element work
// happens bridge-side (see htmlBridge.ts) and this component only exchanges
// messages: it sends the thread list, visibility, and the active id down;
// it gets anchor positions (iframe-viewport space — the rail overlays the
// same box, so they're used as card tops directly), picks, and activations
// back.
//
// Thread DATA lives with the host (App owns the sidecar file and its
// persistence, like it owns the markdown autosave); this component owns the
// transient UI state — active card, which entry is being edited — mirroring
// Editor.tsx's split exactly, including the draft semantics: a new thread
// opens as an empty card, and an abandoned draft (committed or cancelled
// empty) is discarded rather than saved.
type Props = {
  htmlContent: string;
  threads: HtmlThread[];
  onThreadsChange: (next: HtmlThread[]) => void;
  commentAuthor: string;
  commentsVisible: boolean;
  onRequestShowComments: () => void;
  // How external links leave the rendition. The desktop default routes them
  // to the system browser via Tauri; a web host passes window.open instead.
  onOpenExternal?: (url: string) => void;
};

export default function HtmlView({
  htmlContent,
  threads,
  onThreadsChange,
  commentAuthor,
  commentsVisible,
  onRequestShowComments,
  onOpenExternal,
}: Props) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditTarget>(null);
  // Latest anchor layout from the bridge: card tops (viewport space) and
  // which threads failed to re-anchor. Orphans surface at the top of the
  // rail instead of vanishing.
  const [tops, setTops] = useState<Map<string, number>>(new Map());
  const [orphans, setOrphans] = useState<Set<string>>(new Set());

  // Refs for the message handler (installed once).
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const visibleRef = useRef(commentsVisible);
  visibleRef.current = commentsVisible;
  const authorRef = useRef(commentAuthor);
  authorRef.current = commentAuthor;
  const onThreadsChangeRef = useRef(onThreadsChange);
  onThreadsChangeRef.current = onThreadsChange;
  const onRequestShowCommentsRef = useRef(onRequestShowComments);
  onRequestShowCommentsRef.current = onRequestShowComments;
  const onOpenExternalRef = useRef(onOpenExternal);
  onOpenExternalRef.current = onOpenExternal;

  const srcDoc = useMemo(() => instrumentHtml(htmlContent), [htmlContent]);

  const postToBridge = useCallback((msg: BridgeSyncMsg | BridgeScrollToMsg) => {
    iframeRef.current?.contentWindow?.postMessage(msg, "*");
  }, []);

  const syncBridge = useCallback(() => {
    postToBridge({
      dk: "doklin-comments",
      type: "sync",
      threads: bridgeThreads(threadsRef.current),
      activeId: activeIdRef.current,
      visible: visibleRef.current,
    });
  }, [postToBridge]);

  // Push every state change down; the bridge re-resolves and reports layout
  // back. (On iframe reload — external regeneration rewrites srcDoc — the
  // fresh bridge says "ready" and gets the same sync.)
  useEffect(() => {
    syncBridge();
  }, [threads, activeId, commentsVisible, syncBridge]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      if (!isBridgeMsg(e.data)) return;
      const msg = e.data;
      if (msg.type === "ready") {
        syncBridge();
      } else if (msg.type === "layout") {
        setTops(new Map(msg.tops.map((t) => [t.id, t.top])));
        setOrphans(new Set(msg.orphans));
      } else if (msg.type === "pick") {
        // The hover bubble: create a draft thread on the picked element and
        // open its card for typing. Works while comments are hidden too —
        // the app flips them visible first (markdown-toolbar parity).
        if (!visibleRef.current) onRequestShowCommentsRef.current?.();
        const { next, id } = createHtmlThread(
          threadsRef.current,
          msg.anchor,
          authorRef.current,
        );
        onThreadsChangeRef.current(next);
        setTops((prev) => new Map(prev).set(id, msg.top)); // place the card before the next layout arrives
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
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [syncBridge]);

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

  // Hiding comments clears the selection — no invisible active highlight.
  useEffect(() => {
    if (!commentsVisible) {
      setActiveId(null);
      setEditing(null);
    }
  }, [commentsVisible]);

  // Rail order: orphans pinned at the top (they have no position of their
  // own), then anchored threads by their on-screen position. layoutCards
  // stacks from there with real measured heights.
  const railThreads: RailThread[] = useMemo(() => {
    const orphaned = threads.filter((t) => orphans.has(t.id));
    const anchored = threads
      .filter((t) => !orphans.has(t.id))
      .map((t) => ({ t, top: tops.get(t.id) ?? 0 }))
      .sort((a, b) => a.top - b.top);
    return [
      ...orphaned.map((t) => ({
        id: t.id,
        comments: t.comments,
        anchorTop: 8,
        orphaned: true,
      })),
      ...anchored.map(({ t, top }) => ({ id: t.id, comments: t.comments, anchorTop: top })),
    ];
  }, [threads, tops, orphans]);

  /* ----- rail callbacks: same contracts as Editor.tsx, over the sidecar ----- */

  const onActivate = useCallback(
    (id: string) => {
      setActiveId(id);
      postToBridge({ dk: "doklin-comments", type: "scroll-to", id });
    },
    [postToBridge],
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

  const showRail = commentsVisible && railThreads.length > 0;
  return (
    <div className={`html-view ${showRail ? "has-comments" : ""}`}>
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
      {showRail && (
        <CommentsRail
          threads={railThreads}
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
    </div>
  );
}
