import { useEffect, useRef, useState } from "react";

type TabKind = "draft" | "file";
type Tab = { id: string; kind: TabKind; path: string; title?: string; missing?: boolean };

const basename = (p: string) => p.split(/[\\/]/).pop() || p;
const stripDocExt = (name: string) => name.replace(/\.(md|markdown|mdown|mkd|html)$/i, "");
const tabLabel = (t: Tab) =>
  t.kind === "draft" ? t.title ?? "Untitled" : stripDocExt(basename(t.path));

type Props = {
  tabs: Tab[];
  activeId: string | null;
  // The active document's dirty state — inactive tabs autosave, so only the
  // active tab can transiently show a dirty dot.
  dirty: boolean;
  onSwitch: (id: string) => void;
  onClose: (id: string) => void;
  onNewDraft: () => void;
  onReorder: (tabs: Tab[]) => void;
  // Rendered at the bar's right edge, after the tab strip (the app puts the
  // MD/HTML view toggle here).
  trailing?: React.ReactNode;
};

// A press only becomes a drag after moving this far, so plain clicks (switch
// tab) are untouched.
const DRAG_THRESHOLD_PX = 4;

export default function TabBar({
  tabs,
  activeId,
  dirty,
  onSwitch,
  onClose,
  onNewDraft,
  onReorder,
  trailing,
}: Props) {
  const activeRef = useRef<HTMLButtonElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  // Keep the active tab in view when switching (e.g. via ⌘N or the sidebar).
  useEffect(() => {
    activeRef.current?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeId]);

  // Drag-to-reorder. The pressed tab is tracked in a ref (pointermove is
  // high-frequency); reorders are applied live via onReorder, and the new
  // order flows back in through the `tabs` prop. The click that fires after a
  // completed drag must not switch tabs — see suppressClickRef.
  const dragRef = useRef<{ id: string; startX: number; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const onTabPointerDown = (e: React.PointerEvent<HTMLButtonElement>, id: string) => {
    if (e.button !== 0) return; // middle-click stays close, right-click stays menu
    dragRef.current = { id, startX: e.clientX, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onTabPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (!drag.moved) {
      if (Math.abs(e.clientX - drag.startX) < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
      setDraggingId(drag.id);
    }
    const strip = stripRef.current;
    if (!strip) return;
    const from = tabs.findIndex((t) => t.id === drag.id);
    if (from < 0) return;
    // Target slot = how many of the OTHER tabs' midpoints lie left of the
    // pointer; that count is exactly the dragged tab's index in the new order.
    let to = 0;
    for (const el of strip.querySelectorAll<HTMLElement>(".tab")) {
      if (el.dataset.tabId === drag.id) continue;
      const r = el.getBoundingClientRect();
      if (e.clientX > r.left + r.width / 2) to++;
    }
    if (to !== from) {
      const next = [...tabs];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      onReorder(next);
    }
  };

  // A finished drag is followed by a click event on the same button (pointer
  // capture retargets it there) — swallow that one; a cancelled drag has no
  // trailing click, so it must not arm the suppression.
  const endDrag = (cancelled: boolean) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag?.moved) {
      setDraggingId(null);
      if (!cancelled) {
        suppressClickRef.current = true;
        // The trailing click (if any) fires before the next task; don't let a
        // stale flag swallow a later, real click.
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }
    }
  };

  // Overflow: when the strip scrolls, offer a trailing "all tabs" menu so an
  // off-screen tab is one click away. Same dismiss pattern as Settings.
  const [overflowing, setOverflowing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const check = () => setOverflowing(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tabs]);

  useEffect(() => {
    if (overflowing) return;
    setMenuOpen(false); // the button is gone; don't leave an orphaned popover
  }, [overflowing]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuWrapRef.current && !menuWrapRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <div className="tab-bar">
      <div className="tab-strip" role="tablist" ref={stripRef}>
        {tabs.map((t) => {
          const active = t.id === activeId;
          return (
            <div
              key={t.id}
              data-tab-id={t.id}
              className={`tab ${active ? "is-active" : ""} ${
                t.id === draggingId ? "is-dragging" : ""
              } ${t.missing ? "is-missing" : ""}`}
            >
              <button
                ref={active ? activeRef : undefined}
                role="tab"
                aria-selected={active}
                className="tab-main"
                title={t.kind === "file" ? t.path : tabLabel(t)}
                onClick={() => {
                  if (suppressClickRef.current) {
                    suppressClickRef.current = false;
                    return;
                  }
                  onSwitch(t.id);
                }}
                onPointerDown={(e) => onTabPointerDown(e, t.id)}
                onPointerMove={onTabPointerMove}
                onPointerUp={() => endDrag(false)}
                onPointerCancel={() => endDrag(true)}
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
      {overflowing && (
        <div ref={menuWrapRef} className="tab-overflow">
          <button
            className="tab-overflow-btn"
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="All tabs"
            aria-expanded={menuOpen}
            title="All tabs"
          >
            <ChevronDownIcon />
          </button>
          {menuOpen && (
            <div className="tab-overflow-menu" role="menu" aria-label="Open tabs">
              {tabs.map((t) => {
                const active = t.id === activeId;
                return (
                  <button
                    key={t.id}
                    role="menuitemradio"
                    aria-checked={active}
                    className={`tab-overflow-item ${active ? "is-active" : ""} ${
                      t.missing ? "is-missing" : ""
                    }`}
                    title={t.kind === "file" ? t.path : tabLabel(t)}
                    onClick={() => {
                      setMenuOpen(false);
                      onSwitch(t.id);
                    }}
                  >
                    <span className="tab-overflow-check">
                      {active ? <CheckIcon /> : null}
                    </span>
                    <span className="tab-overflow-label">{tabLabel(t)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
      {trailing}
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

function ChevronDownIcon() {
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
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
