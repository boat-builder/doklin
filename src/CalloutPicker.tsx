// The callout type picker: opened by a click on a callout's title (the
// `dk-callout-pick` event, callout.ts), under that title. Five rows — the
// icon in its colour, the name, the one-line meaning — a check on the
// current kind, then "Remove callout". ↑ ↓ move, Enter picks; Esc and a
// press outside close it (useDismiss).

import { useLayoutEffect, useRef, useState } from "react";
import { useDismiss } from "./dismiss";
import { CALLOUTS, CALLOUT_KINDS, type CalloutKind } from "./calloutTypes";

type Row = CalloutKind | "remove";
const ROWS: Row[] = [...CALLOUT_KINDS, "remove"];

export default function CalloutPicker({
  anchor,
  kind,
  onPick,
  onRemove,
  onClose,
}: {
  anchor: HTMLElement;
  kind: CalloutKind;
  onPick: (kind: CalloutKind) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hot, setHot] = useState(() => ROWS.indexOf(kind));

  useDismiss(() => onClose(), ref);

  // Placed before the first paint, straight on the element (it has to be
  // measured, and a hidden element can't take the focus the keys need).
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const r = anchor.getBoundingClientRect();
    const below = r.bottom + 6;
    // Under the title; above it when the window has no room below.
    const top = below + menu.offsetHeight > window.innerHeight - 8 ? Math.max(8, r.top - 6 - menu.offsetHeight) : below;
    const left = Math.min(r.left - 4, window.innerWidth - menu.offsetWidth - 8);
    menu.style.top = `${top}px`;
    menu.style.left = `${Math.max(8, left)}px`;
    menu.focus();
    anchor.classList.add("is-open");
    return () => anchor.classList.remove("is-open");
  }, [anchor]);

  const choose = (row: Row) => {
    if (row === "remove") onRemove();
    else onPick(row);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setHot((h) => (h + step + ROWS.length) % ROWS.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(ROWS[hot]);
    }
  };

  return (
    <div
      ref={ref}
      className="callout-picker"
      role="menu"
      aria-label="Callout type"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {CALLOUT_KINDS.map((k, i) => (
        <button
          key={k}
          type="button"
          role="menuitemradio"
          aria-checked={k === kind}
          className={`callout-picker-row callout-${k} ${i === hot ? "is-hot" : ""}`}
          onMouseEnter={() => setHot(i)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => choose(k)}
        >
          <svg
            className="callout-picker-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: CALLOUTS[k].icon }}
          />
          <span className="callout-picker-name">{CALLOUTS[k].name}</span>
          {k === kind ? (
            <svg className="callout-picker-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <span />
          )}
          <span className="callout-picker-meaning">{CALLOUTS[k].meaning}</span>
        </button>
      ))}
      <div className="callout-picker-sep" role="separator" />
      <button
        type="button"
        role="menuitem"
        className={`callout-picker-remove ${hot === ROWS.length - 1 ? "is-hot" : ""}`}
        onMouseEnter={() => setHot(ROWS.length - 1)}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => choose("remove")}
      >
        Remove callout
      </button>
    </div>
  );
}
