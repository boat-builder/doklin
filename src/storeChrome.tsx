// The small pieces of chrome every view of a datastore shares: the popover a
// menu sits in, the one-line input a name is typed into, and the menu a card
// offers wherever it is shown.
//
// They live apart from any one view because a card behaves the same on a
// board and in a table — the same menu, the same inline composer — and two
// copies of that would drift.

import { useEffect, useRef, useState } from "react";

export function Popover({
  x,
  y,
  className = "",
  onClose,
  children,
}: {
  x: number;
  y: number;
  className?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onDown = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Defer: the click that opened the popover is still propagating.
    const id = window.setTimeout(() => {
      window.addEventListener("pointerdown", onDown);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <div
      className={`dk-popover ${className}`}
      style={{ left: x, top: y }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

/** A one-line input that commits on Enter and cancels on Escape or blur. */
export function InlineInput({
  initial,
  placeholder,
  ariaLabel,
  keepOpen = false,
  onCommit,
  onCancel,
}: {
  initial: string;
  placeholder?: string;
  ariaLabel: string;
  /** Stay open after committing — how a column takes several cards in a row. */
  keepOpen?: boolean;
  onCommit: (value: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      className="dk-inline-input"
      aria-label={ariaLabel}
      placeholder={placeholder}
      value={value}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const v = value.trim();
          if (!v) {
            onCancel();
            return;
          }
          void onCommit(v);
          if (keepOpen) setValue("");
          else onCancel();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={() => onCancel()}
    />
  );
}

export function CardMenu({
  x,
  y,
  onOpen,
  onOpenTab,
  onRename,
  onReveal,
  onDelete,
  onClose,
}: {
  x: number;
  y: number;
  onOpen: () => void;
  /** Present when "open" means a peek, so the tab is still one click away. */
  onOpenTab?: () => void;
  onRename?: () => void;
  onReveal?: () => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  return (
    <Popover x={x} y={y} onClose={onClose}>
      <button className="dk-popover-item" onClick={onOpen}>
        Open
      </button>
      {onOpenTab && (
        <button className="dk-popover-item" onClick={onOpenTab}>
          Open in a tab
        </button>
      )}
      {onRename && (
        <button className="dk-popover-item" onClick={onRename}>
          Rename…
        </button>
      )}
      {onReveal && (
        <button className="dk-popover-item" onClick={onReveal}>
          Reveal in Finder
        </button>
      )}
      {onDelete && (
        <button className="dk-popover-item is-danger" onClick={onDelete}>
          Delete
        </button>
      )}
    </Popover>
  );
}
