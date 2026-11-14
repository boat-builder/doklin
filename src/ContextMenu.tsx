// The app's right-click menu: a fixed-position list
// that closes on an outside click, Esc, or after running an item. The
// sidebar tree and a tab raise the same one, so "Version history…" reads
// identically wherever it is reached from.

import { useRef } from "react";
import { useDismiss } from "./dismiss";

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

  useDismiss(onClose, menuRef);

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
