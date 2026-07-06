type DraftRow = { id: string; path: string; title: string; preview: string };

type Props = {
  drafts: DraftRow[];
  activePath: string | null;
  onOpen: (path: string) => void;
  onDiscard: (path: string, id: string) => void;
  onNewDraft: () => void;
  onClose: () => void;
};

export default function DraftsPanel({
  drafts,
  activePath,
  onOpen,
  onDiscard,
  onNewDraft,
  onClose,
}: Props) {
  return (
    <aside className="drafts-panel" aria-label="Drafts">
      <div className="drafts-header">
        <span className="drafts-header-title">Drafts</span>
        <div className="drafts-header-actions">
          <button
            className="drafts-header-button"
            onClick={onNewDraft}
            title="New note (⌘N)"
            aria-label="New note"
          >
            <PlusIcon />
          </button>
          <button
            className="drafts-header-button"
            onClick={onClose}
            title="Hide drafts (⌘⇧D)"
            aria-label="Hide drafts panel"
          >
            <CloseIcon />
          </button>
        </div>
      </div>
      <div className="drafts-body">
        {drafts.length === 0 ? (
          <div className="drafts-empty">No drafts yet</div>
        ) : (
          <ul className="drafts-list">
            {drafts.map((d) => {
              const active = d.path === activePath;
              return (
                <li key={d.id}>
                  <div className={`draft-row ${active ? "is-active" : ""}`}>
                    <button
                      className="draft-open"
                      onClick={() => onOpen(d.path)}
                      title={d.preview || d.title}
                    >
                      <span className="draft-title">{d.title}</span>
                      <span className="draft-preview">
                        {d.preview || "Empty draft"}
                      </span>
                    </button>
                    <button
                      className="draft-discard"
                      onClick={() => onDiscard(d.path, d.id)}
                      title="Discard draft"
                      aria-label={`Discard ${d.title}`}
                    >
                      <TrashIcon />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}

function PlusIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
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
