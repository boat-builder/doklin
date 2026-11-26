import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import Avatar from "./Avatar";
import type { CommentEntry } from "./criticMark";

// One thread as the rail renders it. `anchorTop` is the anchor's vertical
// offset in the host's coordinate space — the scroll container's content
// space for the markdown editor, the page's for the html view; either way
// the cards move with the document. `orphaned` marks a thread whose anchor
// no longer exists in the document (an html rendition regenerated out from
// under its comments); the card stays, labeled, instead of vanishing.
//
// `on` and `note` are the html view's: there a thread's place is not always
// marked in the text (a thread on a part has no words to tint), so its card
// says what it is on — the quoted words, or the kind of part and what it is
// called — and `note` says when that is no longer quite what was commented
// on.
export type RailThread = {
  id: string;
  comments: CommentEntry[];
  anchorTop: number;
  orphaned?: boolean;
  on?: { quote: string } | { kind: string; title: string };
  note?: string;
};

// Which entry is being edited: the thread + its index (0 = the opener).
export type EditTarget = { id: string; index: number } | null;

type Props = {
  threads: RailThread[];
  activeId: string | null;
  editing: EditTarget;
  // Who is looking at the rail — the same identity new entries are stamped
  // with (the Mac's device name).
  // Only entries whose author matches get an Edit affordance, so nobody
  // rewords someone else's comment by clicking on it in a rail other synced
  // Macs share. Display-name matching, not security — the document format has no identity stronger
  // than a name, and that's fine here.
  selfAuthor: string;
  // The thread whose place is under the pointer (its card lights with it),
  // and the card the pointer is over (so its place can light). The html
  // view's; a note's threads light in the text itself.
  hoverId?: string | null;
  onHover?: (id: string | null) => void;
  // Where what the cards sit beside ends, when nothing can scroll past it
  // (an html page's height): a card is kept above it, or its foot could
  // never be reached. A note's rail has none: it grows its own scroller.
  floor?: number;
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
//
// With a `floor`, cards that would run past it are pushed up from it the
// same way, and the active card is kept whole above it: cards below the
// active one may still run past, since it is the one being read.
function layoutCards(
  threads: RailThread[],
  heights: Map<string, number>,
  activeId: string | null,
  floor: number | null,
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
    if (floor !== null) {
      let ceiling = floor - TOP_MIN;
      for (let i = threads.length - 1; i >= 0; i -= 1) {
        const at = tops.get(threads[i].id) ?? threads[i].anchorTop;
        if (at + h(threads[i]) <= ceiling) break;
        const top = Math.max(TOP_MIN, ceiling - h(threads[i]));
        tops.set(threads[i].id, top);
        ceiling = top - CARD_GAP;
      }
    }
    return tops;
  }
  const active = threads[ai];
  const lowest = floor === null ? Infinity : floor - TOP_MIN - h(active);
  const activeTop = Math.max(TOP_MIN, Math.min(active.anchorTop, lowest));
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
  selfAuthor,
  hoverId = null,
  onHover,
  floor,
  onActivate,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
  onReply,
  onDeleteThread,
  onDeleteReply,
}: Props) {
  // Real card heights: the stacking layout needs them, and they change as
  // threads grow or cards expand. Read after every render, before the
  // browser paints, so a card that opened in that render is stacked by the
  // height it has now; and by a shared ResizeObserver, for a change no render
  // of the rail brings (a reply box growing as it is typed in).
  const heightsRef = useRef<Map<string, number>>(new Map());
  const nodesRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const [measureTick, setMeasureTick] = useState(0);
  const measure = useCallback(() => {
    let changed = false;
    for (const [id, node] of nodesRef.current) {
      const height = node.offsetHeight;
      if (Math.abs((heightsRef.current.get(id) ?? 0) - height) > 0.5) {
        heightsRef.current.set(id, height);
        changed = true;
      }
    }
    if (changed) setMeasureTick((t) => t + 1);
  }, []);
  const observerRef = useRef<ResizeObserver | null>(null);
  if (!observerRef.current && typeof ResizeObserver !== "undefined") {
    observerRef.current = new ResizeObserver(measure);
  }
  useEffect(() => () => observerRef.current?.disconnect(), []);
  useLayoutEffect(measure);

  const cardRef = useCallback((id: string) => {
    return (node: HTMLDivElement | null) => {
      if (node) {
        nodesRef.current.set(id, node);
        observerRef.current?.observe(node);
      } else {
        nodesRef.current.delete(id);
      }
    };
  }, []);

  const tops = useMemo(
    () => layoutCards(threads, heightsRef.current, activeId, floor ?? null),
    // measureTick invalidates when observed card heights change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [threads, activeId, floor, measureTick],
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
          lit={t.id === hoverId}
          editing={editing && editing.id === t.id ? editing.index : null}
          selfAuthor={selfAuthor}
          onHover={onHover}
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
  lit,
  editing,
  selfAuthor,
  onHover,
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
  lit: boolean; // its place is under the pointer
  editing: number | null; // index of the entry being edited, if in this card
  selfAuthor: string;
  onHover?: (id: string | null) => void;
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
  const mine = (entry: CommentEntry) =>
    selfAuthor.trim() !== "" && entry.author === selfAuthor;

  // Clicking a card means "I want to respond": once the card is active the
  // caret goes to the reply composer. For an activating click the composer
  // doesn't exist yet — the flag hands the focus to the render that mounts
  // it (consumed-or-dropped there, so it can't fire later out of context).
  const replyInputRef = useRef<HTMLTextAreaElement | null>(null);
  const wantReplyFocusRef = useRef(false);
  useEffect(() => {
    if (!wantReplyFocusRef.current) return;
    wantReplyFocusRef.current = false;
    if (active && editing == null) replyInputRef.current?.focus({ preventScroll: true });
  });

  return (
    <div
      ref={setRef}
      className={`comment-card ${active ? "is-active" : ""} ${lit ? "is-lit" : ""}`}
      style={{ top: `${top}px` }}
      onMouseEnter={onHover && (() => onHover(id))}
      onMouseLeave={onHover && (() => onHover(null))}
      onMouseDown={(e) => {
        // Activate without stealing focus from a textarea inside the card
        // (or an editing textarea elsewhere).
        const t = e.target as HTMLElement;
        if (t.tagName !== "TEXTAREA") e.preventDefault();
        if (!active) {
          onActivate(id);
          wantReplyFocusRef.current = true;
        } else if (editing == null && t.tagName !== "TEXTAREA") {
          replyInputRef.current?.focus({ preventScroll: true });
        }
      }}
    >
      {thread.orphaned && (
        <div className="comment-orphan-note">Commented spot no longer in the document</div>
      )}
      {thread.on &&
        ("quote" in thread.on ? (
          <blockquote className="comment-on-quote">{thread.on.quote}</blockquote>
        ) : (
          <div className="comment-on-part">
            {thread.on.kind}
            {thread.on.title && <span className="comment-on-title"> · {thread.on.title}</span>}
          </div>
        ))}
      {thread.note && <div className="comment-on-note">{thread.note}</div>}
      <EntryRow
        entry={opener}
        editing={editing === 0}
        canEdit={mine(opener)}
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
              canEdit={mine(r)}
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
        <ReplyComposer inputRef={replyInputRef} onSubmit={(body) => onReply(id, body)} />
      )}
    </div>
  );
}

function EntryRow({
  entry,
  isReply = false,
  editing,
  canEdit,
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
  canEdit: boolean;
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
        <div className="comment-entry-actions">
          {canEdit && !editing && (
            <button
              className="comment-entry-edit"
              title="Edit"
              aria-label="Edit"
              onMouseDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                onStartEdit();
              }}
            >
              <PencilIcon />
            </button>
          )}
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
      </div>
      {editing ? (
        <EntryEditor
          initial={entry.body}
          placeholder={placeholder}
          onCommit={onCommit}
          onCancel={onCancel}
        />
      ) : (
        // Deliberately inert: the body is what someone SAID — clicking it
        // activates the thread (bubbles to the card) rather than opening it
        // for rewriting. Editing your own words is the pencil above.
        <div className="comment-entry-body">
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

function ReplyComposer({
  inputRef,
  onSubmit,
}: {
  // Owned by the card so a click anywhere on it can focus the composer.
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onSubmit: (body: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const ref = inputRef;

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

function PencilIcon() {
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
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
    </svg>
  );
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
