import { useEffect, useRef, useState } from "react";

// A comment positioned for the rail. `id` is the anchor run's `from` position.
export type RailComment = {
  id: number;
  from: number;
  to: number;
  body: string;
  top: number;
};

type Props = {
  comments: RailComment[];
  activeId: number | null;
  editingId: number | null;
  onActivate: (id: number) => void;
  onStartEdit: (id: number) => void;
  onCommitBody: (id: number, body: string) => void;
  onDelete: (id: number) => void;
};

// The right-side rail of comment cards (Notion-style). Cards are absolutely
// positioned at their anchor's vertical offset; the editor reserves the gutter
// via the `.has-comments` class. Clicking a card activates its anchor; clicking
// the body edits it.
export default function CommentsRail({
  comments,
  activeId,
  editingId,
  onActivate,
  onStartEdit,
  onCommitBody,
  onDelete,
}: Props) {
  if (comments.length === 0) return null;
  return (
    <div className="comments-rail" aria-label="Comments">
      {comments.map((c) => (
        <CommentCard
          key={c.id}
          comment={c}
          active={c.id === activeId}
          editing={c.id === editingId}
          onActivate={onActivate}
          onStartEdit={onStartEdit}
          onCommitBody={onCommitBody}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}

function CommentCard({
  comment,
  active,
  editing,
  onActivate,
  onStartEdit,
  onCommitBody,
  onDelete,
}: {
  comment: RailComment;
  active: boolean;
  editing: boolean;
  onActivate: (id: number) => void;
  onStartEdit: (id: number) => void;
  onCommitBody: (id: number, body: string) => void;
  onDelete: (id: number) => void;
}) {
  const { id, body, top } = comment;
  // Local draft while editing; seeded from the committed body each time editing
  // (re)starts so external edits don't clobber an in-progress draft.
  const [draft, setDraft] = useState(body);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(body);
      const el = textareaRef.current;
      if (el) {
        el.focus();
        // Caret at the end so typing appends to an existing note.
        el.setSelectionRange(el.value.length, el.value.length);
      }
    }
    // Only re-seed when entering edit mode for this card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const commit = () => onCommitBody(id, draft);

  return (
    <div
      className={`comment-card ${active ? "is-active" : ""}`}
      style={{ top: `${top}px` }}
      onMouseDown={(e) => {
        // Activate without stealing focus from an editing textarea elsewhere.
        if (!editing) e.preventDefault();
        onActivate(id);
      }}
    >
      {editing ? (
        <textarea
          ref={textareaRef}
          className="comment-card-input"
          value={draft}
          placeholder="Add a comment…"
          onChange={(e) => setDraft(e.target.value)}
          onMouseDown={(e) => e.stopPropagation()}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              commit();
              textareaRef.current?.blur();
            } else if (e.key === "Escape") {
              e.preventDefault();
              textareaRef.current?.blur();
            }
          }}
        />
      ) : (
        <div
          className="comment-card-body"
          onMouseDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onActivate(id);
            onStartEdit(id);
          }}
        >
          {body || <span className="comment-card-empty">Empty comment</span>}
        </div>
      )}
      <button
        className="comment-card-delete"
        title="Delete comment"
        aria-label="Delete comment"
        onMouseDown={(e) => {
          e.stopPropagation();
          e.preventDefault();
          onDelete(id);
        }}
      >
        <TrashIcon />
      </button>
    </div>
  );
}

function TrashIcon() {
  return (
    <svg
      width="13"
      height="13"
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
