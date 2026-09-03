// The app's right-click menu (docs/development.md): a fixed-position list
// that closes on an outside click, Esc, or after running an item. The
// sidebar tree, a tab and a draft row all raise the same one, so "Version
// history…" reads identically wherever it is reached from.

import { useEffect, useRef } from "react";

export type ContextMenuItem = {
  label: string;
  danger?: boolean;
  // Visible but inert (greyed out) — e.g. Paste with an empty clipboard.
  disabled?: boolean;
  onClick: () => void;
};

export default function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Keep the menu on-screen when invoked near the bottom/right edges.
  const estHeight = items.length * 30 + 12;
  const left = Math.min(x, window.innerWidth - 190);
  const top = Math.min(y, window.innerHeight - estHeight - 8);

  return (
    <div ref={menuRef} className="tree-context-menu" role="menu" style={{ left, top }}>
      {items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          className={`sidebar-menu-item ${item.danger ? "is-danger" : ""}`}
          disabled={item.disabled}
          onClick={() => {
            onClose();
            item.onClick();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
