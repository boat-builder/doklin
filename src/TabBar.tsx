import { useEffect, useRef } from "react";

type TabKind = "draft" | "file";
type Tab = { id: string; kind: TabKind; path: string; title?: string };

const basename = (p: string) => p.split(/[\\/]/).pop() || p;
const stripMdExt = (name: string) => name.replace(/\.(md|markdown|mdown|mkd)$/i, "");
const tabLabel = (t: Tab) =>
  t.kind === "draft" ? t.title ?? "Untitled" : stripMdExt(basename(t.path));

type Props = {
  tabs: Tab[];
  activeId: string | null;
  // The active document's dirty state — inactive tabs autosave, so only the
  // active tab can transiently show a dirty dot.
  dirty: boolean;
  onSwitch: (id: string) => void;
  onClose: (id: string) => void;
  onNewDraft: () => void;
};

export default function TabBar({
  tabs,
  activeId,
  dirty,
  onSwitch,
  onClose,
  onNewDraft,
}: Props) {
  const activeRef = useRef<HTMLButtonElement>(null);

  // Keep the active tab in view when switching (e.g. via ⌘N or the sidebar).
  useEffect(() => {
    activeRef.current?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeId]);

  return (
    <div className="tab-bar" role="tablist">
      {tabs.map((t) => {
        const active = t.id === activeId;
        return (
          <div key={t.id} className={`tab ${active ? "is-active" : ""}`}>
            <button
              ref={active ? activeRef : undefined}
              role="tab"
              aria-selected={active}
              className="tab-main"
              title={t.kind === "file" ? t.path : tabLabel(t)}
              onClick={() => onSwitch(t.id)}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(t.id); // middle-click closes
                }
              }}
            >
              <span className="tab-label">{tabLabel(t)}</span>
              {active && dirty && (
                <span className="tab-dot" aria-hidden>
                  ●
                </span>
              )}
            </button>
            <button
              className="tab-close"
              aria-label={`Close ${tabLabel(t)}`}
              title="Close tab (⌘W)"
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.id);
              }}
            >
              <CloseIcon />
            </button>
          </div>
        );
      })}
      <button
        className="tab-new"
        onClick={onNewDraft}
        aria-label="New note"
        title="New note (⌘N / ⌘T)"
      >
        <PlusIcon />
      </button>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
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
