// The small pieces of chrome every view of a datastore shares: the popover a
// menu sits in, the one-line input a name is typed into, the menu a card
// offers wherever it is shown, and the icons and status glyphs they draw.
//
// They live apart from any one view because a card behaves the same on a
// board and in a table — the same menu, the same inline composer — and two
// copies of that would drift.

import { useEffect, useRef, useState } from "react";
import type { Stage } from "./store/board";

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

/* ---------- icons ---------- */

// Every view of a store draws with the same few marks, at 16-unit strokes so
// they sit beside the app's other icons. Colour comes from the context
// (currentColor): a board's violet, a column's hue, the text around them.

type IconProps = { size?: number };

const line = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function Icon({ size = 14, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden {...line}>
      {children}
    </svg>
  );
}

/** The three-column mark the sidebar and the tab bar give a board. */
export function BoardIcon({ size }: IconProps) {
  return (
    <Icon size={size}>
      <rect x="1.75" y="2.25" width="3.5" height="11.5" rx="1" />
      <rect x="6.25" y="2.25" width="3.5" height="7.5" rx="1" />
      <rect x="10.75" y="2.25" width="3.5" height="9.5" rx="1" />
    </Icon>
  );
}

export function TableIcon({ size }: IconProps) {
  return (
    <Icon size={size}>
      <rect x="1.75" y="2.5" width="12.5" height="11" rx="2" />
      <path d="M1.75 6.25h12.5M6 6.25v7.25" />
    </Icon>
  );
}

export function FilterIcon({ size }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M2 4h12M4.5 8h7M7 12h2" />
    </Icon>
  );
}

export function SortIcon({ size }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M5 2.5v11M2.75 11.25L5 13.5l2.25-2.25M11 13.5v-11M8.75 4.75L11 2.5l2.25 2.25" />
    </Icon>
  );
}

/** The view's own settings: what it groups by, what a card shows. */
export function SlidersIcon({ size }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6" />
      <circle cx="10" cy="4.5" r="1.5" />
      <circle cx="6" cy="11.5" r="1.5" />
    </Icon>
  );
}

export function PlusIcon({ size }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M8 3v10M3 8h10" />
    </Icon>
  );
}

export function CalendarIcon({ size }: IconProps) {
  return (
    <Icon size={size}>
      <rect x="2" y="3" width="12" height="11" rx="2" />
      <path d="M2 6.5h12M5 1.5v3M11 1.5v3" />
    </Icon>
  );
}

export function OpenTabIcon({ size }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M7 3H3v10h10V9M9.5 2.5h4v4M13.5 2.5L7.5 8.5" />
    </Icon>
  );
}

export function CloseIcon({ size }: IconProps) {
  return (
    <Icon size={size}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Icon>
  );
}

export function MoreIcon({ size }: IconProps) {
  return (
    <svg width={size ?? 14} height={size ?? 14} viewBox="0 0 16 16" aria-hidden>
      <circle cx="3.5" cy="8" r="1.25" fill="currentColor" />
      <circle cx="8" cy="8" r="1.25" fill="currentColor" />
      <circle cx="12.5" cy="8" r="1.25" fill="currentColor" />
    </svg>
  );
}

/**
 * A column's stage of work, as a status glyph: a dashed ring that hasn't
 * started, a ring filling as the work moves on, a solid check when it is
 * finished, and a slashed ring for closed-but-not-done. A board that doesn't
 * track progress (stage null) gets a plain dot in the column's colour.
 */
export function StatusGlyph({ stage, size = 15 }: { stage: Stage | null; size?: number }) {
  const ring = <circle cx="8" cy="8" r="6" strokeWidth="1.6" />;
  let mark: React.ReactNode;
  if (!stage) {
    mark = <circle cx="8" cy="8" r="3.75" fill="currentColor" stroke="none" />;
  } else if (stage.kind === "todo") {
    mark = <circle cx="8" cy="8" r="6" strokeWidth="1.6" strokeDasharray="2.3 2.1" />;
  } else if (stage.kind === "done") {
    mark = (
      <>
        <circle cx="8" cy="8" r="6.75" fill="currentColor" stroke="none" />
        <path className="dk-glyph-check" d="M5.25 8.25l1.9 1.9 3.6-4" strokeWidth="1.7" />
      </>
    );
  } else if (stage.kind === "closed") {
    mark = (
      <>
        {ring}
        <path d="M4.5 11.5l7-7" strokeWidth="1.6" />
      </>
    );
  } else {
    // The pie grows clockwise from twelve o'clock.
    const r = 3.5;
    const a = stage.fill * 2 * Math.PI;
    const x = 8 + r * Math.sin(a);
    const y = 8 - r * Math.cos(a);
    mark = (
      <>
        {ring}
        <path
          d={`M8 8V${8 - r}A${r} ${r} 0 ${stage.fill > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}Z`}
          fill="currentColor"
          stroke="none"
        />
      </>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden {...line}>
      {mark}
    </svg>
  );
}

/**
 * What a view offers its host's "New card" button: open the composer where a
 * new card would land — the board's first column, or the table's foot.
 */
export type ComposeHandle = { compose: () => void };
