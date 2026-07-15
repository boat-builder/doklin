// The shared page's app shell — the SAME editing surface the desktop app
// renders, mounted in a browser for visitors whose access code carries the
// comment or edit role. The worker serves this for /<id> instead of the
// static reading view, so a shared document looks and behaves exactly like it
// does on the owner's machine:
//
//   - markdown view: the real Milkdown/Crepe editor. Edit-role sessions type
//     into it like the owner does (rev-guarded autosave); comment-role
//     sessions get it read-only with the full comment layer live — select
//     text, comment, reply, resolve — because markdown comments ARE the
//     document (CriticMarkup), a comment is a save whose stripped content is
//     unchanged, which is exactly what the worker enforces for them.
//   - html view: the real HtmlView (sandboxed rendition + comment mode with
//     anchored pins/cards), threads synced with the worker's per-page pool,
//     which the desktop app pushes its sidecar into and pulls web additions
//     back from.
//
// View-role sessions never see this shell — they get the classic read-only
// pages with every comment stripped.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { type EditorHandle } from "../src/Editor";
import HtmlView from "../src/HtmlView";
import { mergeHtmlThreads, type HtmlThread } from "../src/htmlComments";
import {
  beaconHtmlThreads,
  beaconMarkdown,
  fetchHtmlThreads,
  pushHtmlThreads,
  saveMarkdown,
} from "./api";

export type Boot = {
  id: string;
  title: string;
  role: "comment" | "edit";
  label: string;
  view: "md" | "html";
  hasMd: boolean;
  hasHtml: boolean;
  htmlStale: boolean;
  rev: number;
  markdown: string | null;
  crumb: { id: string; title: string } | null;
  host: string;
};

const SAVE_DEBOUNCE_MS = 900;
const THREADS_DEBOUNCE_MS = 500;

function readStoredName(): string {
  try {
    return localStorage.getItem("dk-comment-name") ?? "";
  } catch {
    return "";
  }
}

/* ---------- Comment bubble for read-only markdown ----------
   Crepe suppresses its selection toolbar in read-only mode, so comment-role
   sessions get this instead: a small floating "Comment" button that follows a
   text selection inside the document (the same affordance the html view's
   hover bubble provides). Clicking it routes to the editor's
   commentSelection() — the exact act behind the desktop toolbar's button. */
function SelectionCommentBubble({
  wrapRef,
  onComment,
}: {
  wrapRef: React.RefObject<HTMLDivElement | null>;
  onComment: () => void;
}) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const wrap = wrapRef.current;
      const sel = window.getSelection();
      if (!wrap || !sel || sel.rangeCount === 0 || sel.isCollapsed) {
        setPos(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const doc = wrap.querySelector(".ProseMirror");
      if (!doc || !doc.contains(range.commonAncestorContainer)) {
        setPos(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setPos(null);
        return;
      }
      const wrapRect = wrap.getBoundingClientRect();
      setPos({
        top: rect.top - wrapRect.top + wrap.scrollTop - 34,
        left: Math.min(
          rect.left - wrapRect.left + rect.width / 2,
          wrapRect.width - 70,
        ),
      });
    };
    const schedule = () => {
      if (raf === 0) raf = requestAnimationFrame(update);
    };
    document.addEventListener("selectionchange", schedule);
    window.addEventListener("resize", schedule);
    return () => {
      document.removeEventListener("selectionchange", schedule);
      window.removeEventListener("resize", schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [wrapRef]);

  if (!pos) return null;
  return (
    <button
      className="web-selection-bubble"
      style={{ top: pos.top, left: pos.left }}
      // The click must not collapse the selection before we read it.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onComment}
      title="Comment on the selection"
    >
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
      Comment
    </button>
  );
}

// Same markup/classes as the desktop tab bar's CommentsToggle — one look.
function CommentsToggle({
  count,
  visible,
  onToggle,
}: {
  count: number;
  visible: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      className={`comments-toggle ${visible ? "" : "is-off"}`}
      aria-pressed={visible}
      title={visible ? "Hide comments" : `Show comments (${count})`}
      onClick={onToggle}
    >
      <svg
        width="14"
        height="14"
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
      <span className="comments-toggle-count">{count}</span>
    </button>
  );
}

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "offline" }
  | { kind: "rejected"; message: string }
  | { kind: "conflict"; by: string; rev: number };

export default function WebApp({ boot }: { boot: Boot }) {
  const view = boot.view;
  const [name, setName] = useState(readStoredName);
  const author = name.trim() || boot.label;
  const authorRef = useRef(author);
  authorRef.current = author;

  const [commentsVisible, setCommentsVisible] = useState(true);
  const [commentCount, setCommentCount] = useState(0);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<EditorHandle | null>(null);

  const saveName = useCallback((value: string) => {
    setName(value);
    try {
      localStorage.setItem("dk-comment-name", value.trim());
    } catch {
      // storage may be unavailable; the session label still names entries
    }
  }, []);

  /* ---------- markdown persistence (both roles — comments are saves) ---------- */

  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  const baseRevRef = useRef(boot.rev);
  // Milkdown re-serializes the document on mount (normalized whitespace, list
  // markers, …). That serialization is the baseline — not an edit — so the
  // first onChange only records it. Same guard the desktop host uses.
  const baselineRef = useRef<string | null>(null);
  const currentMdRef = useRef<string>(boot.markdown ?? "");
  const lastSavedRef = useRef<string | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const savingRef = useRef(false);
  const conflictRef = useRef(false);

  const performSaveRef = useRef<(force?: boolean) => Promise<void>>(() => Promise.resolve());

  const scheduleSave = useCallback((delay = SAVE_DEBOUNCE_MS) => {
    if (saveTimerRef.current != null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void performSaveRef.current();
    }, delay);
  }, []);

  const performSave = useCallback(
    async (force = false) => {
      if (savingRef.current || conflictRef.current) return;
      const md = currentMdRef.current;
      if (lastSavedRef.current === md && !force) return;
      savingRef.current = true;
      setSaveState({ kind: "saving" });
      const result = await saveMarkdown(boot.id, md, baseRevRef.current, force);
      savingRef.current = false;
      if (result.kind === "ok") {
        baseRevRef.current = result.rev;
        lastSavedRef.current = md;
        setSaveState({ kind: "saved" });
        // More typing may have landed while the request flew.
        if (currentMdRef.current !== md) scheduleSave();
      } else if (result.kind === "conflict") {
        conflictRef.current = true;
        setSaveState({ kind: "conflict", by: result.by, rev: result.rev });
      } else if (result.kind === "offline") {
        setSaveState({ kind: "offline" });
        // Transient — retry shortly; nothing is lost locally while the tab
        // stays open.
        scheduleSave(4000);
      } else {
        // The server refused (revoked code, empty document): a permanent
        // state with the reason, not a spinning "retrying".
        setSaveState({ kind: "rejected", message: result.message });
      }
    },
    [boot.id, scheduleSave],
  );
  performSaveRef.current = performSave;

  const onMarkdownChange = useCallback(
    (md: string) => {
      currentMdRef.current = md;
      if (baselineRef.current === null) {
        baselineRef.current = md;
        lastSavedRef.current = md;
        return;
      }
      if (md !== lastSavedRef.current) scheduleSave();
    },
    [scheduleSave],
  );

  // Conflict resolution, desktop-parity: pull the newer version (reload — the
  // shell re-serves the latest revision) or push mine over it (edit role).
  const resolveReload = useCallback(() => {
    location.reload();
  }, []);
  const resolveKeepMine = useCallback(() => {
    const s = saveState;
    if (s.kind !== "conflict") return;
    baseRevRef.current = s.rev;
    conflictRef.current = false;
    setSaveState({ kind: "idle" });
    void performSaveRef.current(true);
  }, [saveState]);

  const unsavedMd = () =>
    !conflictRef.current &&
    lastSavedRef.current !== null &&
    currentMdRef.current !== lastSavedRef.current;

  useEffect(() => {
    if (view !== "md" || boot.markdown === null) return;
    // Tab-hide is a routine event (an alt-tab), and the page stays alive —
    // run a REAL save so we learn the new revision. A beacon here would bump
    // the server rev the client can never read, turning the visitor's next
    // save into a 409 against their own flush.
    const onVisibility = () => {
      if (document.visibilityState === "hidden" && unsavedMd()) void performSaveRef.current();
    };
    // pagehide is the true teardown: the page is leaving and can't learn a
    // response, so a best-effort beacon is the last resort.
    const onPageHide = () => {
      if (unsavedMd()) beaconMarkdown(boot.id, currentMdRef.current, baseRevRef.current);
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [view, boot.id, boot.markdown]);

  /* ---------- html rendition + thread pool ---------- */

  const [htmlContent, setHtmlContent] = useState<string | null>(null);
  const [threads, setThreads] = useState<HtmlThread[]>([]);
  const threadsRevRef = useRef(0);
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  // The last server-agreed thread state (at threadsRevRef) — the BASE of the
  // same three-way merge the desktop uses (mergeHtmlThreads): a lost CAS race
  // rebases mine onto the winner's copy instead of replaying ops, so nothing
  // the visitor wrote is dropped and no entry is duplicated across the
  // provenance stamp the worker adds.
  const threadsBaseRef = useRef<HtmlThread[]>([]);
  const threadsTimerRef = useRef<number | null>(null);
  const pushingRef = useRef(false);

  useEffect(() => {
    if (view !== "html") return;
    let cancelled = false;
    void (async () => {
      try {
        const [rawRes, snap] = await Promise.all([
          fetch(`/${boot.id}/raw`),
          fetchHtmlThreads(boot.id),
        ]);
        const raw = rawRes.ok ? await rawRes.text() : "";
        if (cancelled) return;
        threadsRevRef.current = snap.rev;
        threadsBaseRef.current = snap.threads;
        setThreads(snap.threads);
        setHtmlContent(raw);
      } catch (err) {
        console.error("failed to load rendition", err);
        if (!cancelled) setHtmlContent("");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view, boot.id]);

  const pushThreadsNowRef = useRef<() => Promise<void>>(() => Promise.resolve());

  const scheduleThreadsPush = useCallback((delay = THREADS_DEBOUNCE_MS) => {
    if (threadsTimerRef.current != null) window.clearTimeout(threadsTimerRef.current);
    threadsTimerRef.current = window.setTimeout(() => {
      threadsTimerRef.current = null;
      void pushThreadsNowRef.current();
    }, delay);
  }, []);

  const pushThreadsNow = useCallback(async () => {
    if (pushingRef.current) return;
    const mine = threadsRef.current;
    // Nothing local owes the pool when the rail already equals the base.
    if (JSON.stringify(mine) === JSON.stringify(threadsBaseRef.current)) return;
    pushingRef.current = true;
    const result = await pushHtmlThreads(boot.id, mine, threadsRevRef.current);
    pushingRef.current = false;
    // Fold in anything the visitor typed while the request was in flight, so
    // adopting the server's copy never reverts their newest change.
    const foldLive = (resolved: HtmlThread[]) =>
      JSON.stringify(threadsRef.current) === JSON.stringify(mine)
        ? resolved
        : mergeHtmlThreads(mine, threadsRef.current, resolved);
    if (result.kind === "ok") {
      threadsRevRef.current = result.rev;
      threadsBaseRef.current = result.threads;
      const next = foldLive(result.threads);
      setThreads(next);
      if (JSON.stringify(next) !== JSON.stringify(result.threads)) scheduleThreadsPush();
    } else if (result.kind === "conflict") {
      // Someone else's change landed first: three-way merge (base = the last
      // agreed copy, mine = what I pushed, theirs = the winner) and re-push.
      const merged = mergeHtmlThreads(threadsBaseRef.current, mine, result.threads);
      threadsRevRef.current = result.rev;
      threadsBaseRef.current = result.threads;
      setThreads(foldLive(merged));
      scheduleThreadsPush();
    } else {
      // Offline or rejected — the rail still differs from the base, so the
      // next change or the retry below tries again; nothing is lost.
      scheduleThreadsPush(4000);
    }
  }, [boot.id, scheduleThreadsPush]);
  pushThreadsNowRef.current = pushThreadsNow;

  const onThreadsChange = useCallback(
    (next: HtmlThread[]) => {
      setThreads(next);
      scheduleThreadsPush();
    },
    [scheduleThreadsPush],
  );

  // Flush unsynced rail changes when the tab goes away. On a routine tab-hide
  // the page stays alive, so run a real push (which learns the new rev); only
  // true teardown falls back to a best-effort beacon. Because the base is
  // untouched until a push is acknowledged, a delivered beacon just makes the
  // next push a fast-forward and a dropped one is retried — nothing is lost.
  useEffect(() => {
    if (view !== "html") return;
    const unsynced = () =>
      JSON.stringify(threadsRef.current) !== JSON.stringify(threadsBaseRef.current);
    const onVisibility = () => {
      if (document.visibilityState === "hidden" && unsynced()) void pushThreadsNowRef.current();
    };
    const onPageHide = () => {
      if (unsynced()) beaconHtmlThreads(boot.id, threadsRef.current, threadsRevRef.current);
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [view, boot.id]);

  /* ---------- chrome ---------- */

  const readOnly = boot.role !== "edit";
  const showBubble = view === "md" && readOnly;

  const saveLabel = useMemo(() => {
    switch (saveState.kind) {
      case "saving":
        return "Saving…";
      case "saved":
        return "Saved";
      case "offline":
        return "Offline — retrying";
      case "rejected":
        return saveState.message;
      default:
        return "";
    }
  }, [saveState]);

  const switchView = useCallback(
    (next: "md" | "html") => {
      if (next === view) return;
      // Give in-flight work its flush (the pagehide handlers double this).
      if (saveTimerRef.current != null) void performSaveRef.current();
      const q = next === "md" ? "?v=md" : boot.htmlStale ? "?v=html" : "";
      location.href = `/${boot.id}${q}`;
    },
    [view, boot.id, boot.htmlStale],
  );

  return (
    <div className="web-app">
      <header className="web-topbar">
        {boot.crumb ? (
          <a className="web-crumb" href={`/${boot.crumb.id}`}>
            <span aria-hidden>←</span> {boot.crumb.title || "Home"}
          </a>
        ) : (
          <span className="web-doc-title">{boot.title}</span>
        )}
        <div className="web-topbar-spacer" />
        {saveLabel && (
          <span
            className={`web-save-state ${saveState.kind === "rejected" ? "is-error" : ""}`}
          >
            {saveLabel}
          </span>
        )}
        <label className="web-identity" title="How your comments are signed">
          as
          <input
            value={name}
            placeholder={boot.label}
            maxLength={80}
            onChange={(e) => saveName(e.target.value)}
          />
        </label>
        {/* Markdown only: the html view carries its own floating "Comment"
            button (comment mode lives inside HtmlView). */}
        {view === "md" && commentCount > 0 && (
          <CommentsToggle
            count={commentCount}
            visible={commentsVisible}
            onToggle={() => setCommentsVisible((v) => !v)}
          />
        )}
        {boot.hasMd && boot.hasHtml && (
          <div className="view-toggle" role="tablist" aria-label="Document view">
            <button
              role="tab"
              aria-selected={view === "md"}
              className={`view-toggle-seg ${view === "md" ? "is-active" : ""}`}
              onClick={() => switchView("md")}
            >
              MD
            </button>
            <button
              role="tab"
              aria-selected={view === "html"}
              className={`view-toggle-seg ${view === "html" ? "is-active" : ""}`}
              title={boot.htmlStale ? "Rendition from before the latest edit" : "HTML"}
              onClick={() => switchView("html")}
            >
              HTML
            </button>
          </div>
        )}
      </header>

      {saveState.kind === "conflict" && (
        <div className="web-conflict" role="alert">
          <span>
            This page changed while you were working
            {saveState.by ? ` (last saved by ${saveState.by})` : ""}.
          </span>
          <button onClick={resolveReload}>Load the newer version</button>
          {!readOnly && <button onClick={resolveKeepMine}>Keep mine</button>}
        </div>
      )}

      {view === "md" && boot.markdown !== null ? (
        <div
          ref={wrapRef}
          className={`editor-wrap web-editor-wrap ${readOnly ? "is-readonly" : ""}`}
        >
          <Editor
            ref={editorRef}
            initialMarkdown={boot.markdown}
            onChange={onMarkdownChange}
            commentAuthor={author}
            commentsVisible={commentsVisible}
            onCommentsCount={setCommentCount}
            onRequestShowComments={() => setCommentsVisible(true)}
            readOnly={readOnly}
          />
          {showBubble && (
            <SelectionCommentBubble
              wrapRef={wrapRef}
              onComment={() => editorRef.current?.commentSelection()}
            />
          )}
        </div>
      ) : view === "html" ? (
        htmlContent === null ? (
          <div className="web-loading">Loading…</div>
        ) : (
          <div className="editor-wrap is-html-view web-editor-wrap">
            <HtmlView
              htmlContent={htmlContent}
              threads={threads}
              onThreadsChange={onThreadsChange}
              commentAuthor={author}
              onOpenExternal={(url) => window.open(url, "_blank", "noopener")}
            />
          </div>
        )
      ) : (
        <div className="web-loading">Nothing to show.</div>
      )}

      <footer className="web-footer">
        shared via <a href="/">{boot.host}</a>
      </footer>
    </div>
  );
}
