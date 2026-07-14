import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CommentEntry } from "./criticMark";

// One thread as the rail renders it. `anchorTop` is the anchor's vertical
// offset in the scroll container's content space (cards translate with the
// document as it scrolls).
export type RailThread = {
  id: string;
  comments: CommentEntry[];
  anchorTop: number;
};

// Which entry is being edited: the thread + its index (0 = the opener).
export type EditTarget = { id: string; index: number } | null;

type Props = {
  threads: RailThread[];
  activeId: string | null;
  editing: EditTarget;
  onActivate: (id: string) => void;
  onStartEdit: (id: string, index: number) => void;
  onCommitEdit: (id: string, index: number, body: string) => void;
  onCancelEdit: (id: string, index: number) => void;
  onReply: (id: string, body: string) => void;
  onDeleteThread: (id: string) => void;
  onDeleteReply: (id: string, index: number) => void;
};

const CARD_GAP = 12;
const TOP_MIN = 8;
const EST_HEIGHT = 76;

// Place cards without overlap. With no selection, cards flow top-down from
// their anchors. With a selection, the active card pins exactly to its
// anchor; cards below flow down from it and cards above stack tightly
// upward — the Google-Docs feel, with real measured heights.
function layoutCards(
  threads: RailThread[],
  heights: Map<string, number>,
  activeId: string | null,
): Map<string, number> {
  const tops = new Map<string, number>();
  const h = (t: RailThread) => heights.get(t.id) ?? EST_HEIGHT;
  const ai = activeId ? threads.findIndex((t) => t.id === activeId) : -1;
  if (ai === -1) {
    let cursor = TOP_MIN;
    for (const t of threads) {
      const top = Math.max(t.anchorTop, cursor);
      tops.set(t.id, top);
      cursor = top + h(t) + CARD_GAP;
    }
    return tops;
  }
  const active = threads[ai];
  const activeTop = Math.max(TOP_MIN, active.anchorTop);
  tops.set(active.id, activeTop);
  let cursor = activeTop + h(active) + CARD_GAP;
  for (let i = ai + 1; i < threads.length; i += 1) {
    const top = Math.max(threads[i].anchorTop, cursor);
    tops.set(threads[i].id, top);
    cursor = top + h(threads[i]) + CARD_GAP;
  }
  let ceiling = activeTop - CARD_GAP;
  for (let i = ai - 1; i >= 0; i -= 1) {
    // Cards above the active one may be pushed up, never down past it. In a
    // pathological cram they clamp at the top; the active card wins z-order.
    const top = Math.max(TOP_MIN, Math.min(threads[i].anchorTop, ceiling - h(threads[i])));
    tops.set(threads[i].id, top);
    ceiling = top - CARD_GAP;
  }
  return tops;
}

// The right-side rail of comment cards. Cards are absolutely positioned; the
// editor reserves the gutter via the `.has-comments` class. An inactive card
// shows the opening comment (plus a reply count); selecting it expands the
// full thread with a reply composer.
export default function CommentsRail({
  threads,
  activeId,
  editing,
  onActivate,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
  onReply,
  onDeleteThread,
  onDeleteReply,
}: Props) {
  // Real card heights, measured by a shared ResizeObserver: the stacking
  // layout needs them, and they change as threads grow or cards expand.
  const heightsRef = useRef<Map<string, number>>(new Map());
  const [measureTick, setMeasureTick] = useState(0);
  const observerRef = useRef<ResizeObserver | null>(null);
  const idOfNode = useRef<WeakMap<Element, string>>(new WeakMap());

  if (!observerRef.current && typeof ResizeObserver !== "undefined") {
    observerRef.current = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const id = idOfNode.current.get(entry.target);
        if (!id) continue;
        const height = (entry.target as HTMLElement).offsetHeight;
        if (Math.abs((heightsRef.current.get(id) ?? 0) - height) > 0.5) {
          heightsRef.current.set(id, height);
          changed = true;
        }
      }
      if (changed) setMeasureTick((t) => t + 1);
    });
  }
  useEffect(() => () => observerRef.current?.disconnect(), []);

  const cardRef = useCallback((id: string) => {
    return (node: HTMLDivElement | null) => {
      if (node) {
        idOfNode.current.set(node, id);
        heightsRef.current.set(id, node.offsetHeight);
        observerRef.current?.observe(node);
      }
    };
  }, []);

  const tops = useMemo(
    () => layoutCards(threads, heightsRef.current, activeId),
    // measureTick invalidates when observed card heights change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [threads, activeId, measureTick],
  );

  if (threads.length === 0) return null;
  return (
    <div className="comments-rail" aria-label="Comments">
      {threads.map((t) => (
        <ThreadCard
          key={t.id}
          setRef={cardRef(t.id)}
          thread={t}
          top={tops.get(t.id) ?? t.anchorTop}
          active={t.id === activeId}
          editing={editing && editing.id === t.id ? editing.index : null}
          onActivate={onActivate}
          onStartEdit={onStartEdit}
          onCommitEdit={onCommitEdit}
          onCancelEdit={onCancelEdit}
          onReply={onReply}
          onDeleteThread={onDeleteThread}
          onDeleteReply={onDeleteReply}
        />
      ))}
    </div>
  );
}

function ThreadCard({
  setRef,
  thread,
  top,
  active,
  editing,
  onActivate,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
  onReply,
  onDeleteThread,
  onDeleteReply,
}: {
  setRef: (node: HTMLDivElement | null) => void;
  thread: RailThread;
  top: number;
  active: boolean;
  editing: number | null; // index of the entry being edited, if in this card
  onActivate: (id: string) => void;
  onStartEdit: (id: string, index: number) => void;
  onCommitEdit: (id: string, index: number, body: string) => void;
  onCancelEdit: (id: string, index: number) => void;
  onReply: (id: string, body: string) => void;
  onDeleteThread: (id: string) => void;
  onDeleteReply: (id: string, index: number) => void;
}) {
  const { id, comments } = thread;
  const opener = comments[0];
  const replies = comments.slice(1);

  return (
    <div
      ref={setRef}
      className={`comment-card ${active ? "is-active" : ""}`}
      style={{ top: `${top}px` }}
      onMouseDown={(e) => {
        // Activate without stealing focus from a textarea inside the card
        // (or an editing textarea elsewhere).
        const t = e.target as HTMLElement;
        if (t.tagName !== "TEXTAREA") e.preventDefault();
        if (!active) onActivate(id);
      }}
    >
      <EntryRow
        entry={opener}
        editing={editing === 0}
        placeholder="Comment…"
        onStartEdit={() => onStartEdit(id, 0)}
        onCommit={(body) => onCommitEdit(id, 0, body)}
        onCancel={() => onCancelEdit(id, 0)}
        onDelete={() => onDeleteThread(id)}
        deleteTitle="Delete comment"
      />
      {active
        ? replies.map((r, i) => (
            <EntryRow
              key={`${i}-${r.at}`}
              entry={r}
              isReply
              editing={editing === i + 1}
              placeholder="Reply…"
              onStartEdit={() => onStartEdit(id, i + 1)}
              onCommit={(body) => onCommitEdit(id, i + 1, body)}
              onCancel={() => onCancelEdit(id, i + 1)}
              onDelete={() => onDeleteReply(id, i + 1)}
              deleteTitle="Delete reply"
            />
          ))
        : replies.length > 0 && (
            <div className="comment-replies-hint">
              {replies.length === 1 ? "1 reply" : `${replies.length} replies`}
            </div>
          )}
      {active && editing == null && (
        <ReplyComposer onSubmit={(body) => onReply(id, body)} />
      )}
    </div>
  );
}

function EntryRow({
  entry,
  isReply = false,
  editing,
  placeholder,
  onStartEdit,
  onCommit,
  onCancel,
  onDelete,
  deleteTitle,
}: {
  entry: CommentEntry;
  isReply?: boolean;
  editing: boolean;
  placeholder: string;
  onStartEdit: () => void;
  onCommit: (body: string) => void;
  onCancel: () => void;
  onDelete: () => void;
  deleteTitle: string;
}) {
  return (
    <div className={`comment-entry ${isReply ? "is-reply" : ""}`}>
      <div className="comment-entry-head">
        <Avatar name={entry.author} />
        <span className="comment-entry-author">{entry.author || "Unknown"}</span>
        <span className="comment-entry-when">{formatWhen(entry.at)}</span>
        <button
          className="comment-entry-delete"
          title={deleteTitle}
          aria-label={deleteTitle}
          onMouseDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onDelete();
          }}
        >
          <TrashIcon />
        </button>
      </div>
      {editing ? (
        <EntryEditor
          initial={entry.body}
          placeholder={placeholder}
          onCommit={onCommit}
          onCancel={onCancel}
        />
      ) : (
        <div
          className="comment-entry-body"
          onMouseDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onStartEdit();
          }}
        >
          {entry.body || <span className="comment-entry-empty">Empty comment</span>}
        </div>
      )}
    </div>
  );
}

// The textarea for writing/editing an entry. Grows with its content; Enter
// commits, Esc cancels, clicking away commits.
function EntryEditor({
  initial,
  placeholder,
  onCommit,
  onCancel,
}: {
  initial: string;
  placeholder: string;
  onCommit: (body: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  // Esc must cancel, not also commit through the blur it causes.
  const cancelledRef = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      autoGrow(el);
    }
  }, []);

  return (
    <textarea
      ref={ref}
      className="comment-input"
      rows={1}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => {
        setDraft(e.target.value);
        autoGrow(e.target);
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onBlur={() => {
        if (!cancelledRef.current) onCommit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          onCommit(draft);
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancelledRef.current = true;
          onCancel();
        }
      }}
    />
  );
}

function ReplyComposer({ onSubmit }: { onSubmit: (body: string) => void }) {
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  const post = () => {
    if (!draft.trim()) return;
    onSubmit(draft);
    setDraft("");
    const el = ref.current;
    if (el) {
      el.style.height = "auto";
      el.focus();
    }
  };

  return (
    <div className="comment-reply-composer">
      <textarea
        ref={ref}
        className="comment-input"
        rows={1}
        value={draft}
        placeholder="Reply…"
        onChange={(e) => {
          setDraft(e.target.value);
          autoGrow(e.target);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            post();
          } else if (e.key === "Escape") {
            e.preventDefault();
            (e.target as HTMLTextAreaElement).blur();
          }
        }}
      />
    </div>
  );
}

function autoGrow(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

/* ---------- Presentation helpers ---------- */

function Avatar({ name }: { name: string }) {
  const known = name.trim().length > 0;
  const style = known ? { background: `hsl(${hueOf(name)} 40% 52%)` } : undefined;
  return (
    <span className={`comment-avatar ${known ? "" : "is-unknown"}`} style={style} aria-hidden>
      {known ? initialsOf(name) : "?"}
    </span>
  );
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = [...parts[0]][0] ?? "";
  const last = parts.length > 1 ? [...parts[parts.length - 1]][0] ?? "" : "";
  return (first + last).toUpperCase();
}

function hueOf(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 360;
  return h;
}

function formatWhen(at: number): string {
  if (!at) return "";
  const now = Date.now();
  const delta = now - at;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)}d ago`;
  const date = new Date(at);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (date.getFullYear() !== new Date(now).getFullYear()) opts.year = "numeric";
  return date.toLocaleDateString(undefined, opts);
}

function TrashIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}
