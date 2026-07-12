// Custom select: replaces the native <select> everywhere in the app. The
// native control's trigger was already de-chromed with CSS, but the dropdown
// list itself is OS chrome — it ignores the theme palettes and looks foreign
// next to the app's popovers. This renders the menu ourselves in the same
// visual language as .settings-popover / .sidebar-menu.
//
// The menu is portaled to <body> and positioned with fixed coordinates so it
// can never be clipped by a modal's rounded corners or a scrolling body, and
// never adds a scrollbar to its host. Focus stays on the trigger the whole
// time (aria-activedescendant pattern), so Tab order and the host modal's
// Escape handling stay predictable: Escape with the menu open closes just the
// menu and stops there; Escape with the menu closed reaches the modal as
// before.

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export type SelectOption = {
  value: string;
  label: string;
  /* Second muted line in the menu row — model size/RAM notes and the like. */
  detail?: string;
};

const MENU_MARGIN = 8; // min gap between the menu and the viewport edge

export default function Select({
  value,
  options,
  onChange,
  variant = "field",
  className,
  id,
  ariaLabel,
  disabled,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** "field": bordered button (settings rows). "inline": text-like trigger
      that sits inside composed rows such as the share-address bar. */
  variant?: "field" | "inline";
  className?: string;
  id?: string;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number; minWidth: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const typeahead = useRef({ text: "", at: 0 });
  const menuId = useId();

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const openMenu = () => {
    if (disabled) return;
    setActive(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  };

  const commit = (index: number) => {
    const opt = options[index];
    setOpen(false);
    if (opt && opt.value !== value) onChange(opt.value);
  };

  // Position after the menu has rendered (its size is content-driven): below
  // the trigger, flipped above when the space below can't fit it, clamped to
  // the viewport horizontally.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const t = trigger.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    let top = t.bottom + 4;
    if (top + m.height > window.innerHeight - MENU_MARGIN) {
      const above = t.top - 4 - m.height;
      if (above >= MENU_MARGIN) top = above;
      else top = Math.max(MENU_MARGIN, window.innerHeight - MENU_MARGIN - m.height);
    }
    const left = Math.max(
      MENU_MARGIN,
      Math.min(t.left, window.innerWidth - MENU_MARGIN - m.width),
    );
    setPos({ top, left, minWidth: t.width });
  }, [open, options.length]);

  // Keep the active row in view while arrowing through a long list.
  useEffect(() => {
    if (!open) return;
    menuRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  // Dismissal: any pointer-down outside, scrolling anywhere outside the menu,
  // a window resize, or the window losing focus — same reflexes as the native
  // dropdown, minus the OS chrome.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onScroll = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive((i) => Math.min(options.length - 1, i + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((i) => Math.max(0, i - 1));
        break;
      case "Home":
        e.preventDefault();
        setActive(0);
        break;
      case "End":
        e.preventDefault();
        setActive(options.length - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        commit(active);
        break;
      case "Escape":
        // Only the menu closes; the host modal's document-level Escape
        // handler must not see this press.
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        break;
      case "Tab":
        setOpen(false);
        break;
      default: {
        if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey) return;
        // Native-select typeahead: keys within a second extend the query.
        const now = Date.now();
        const q =
          now - typeahead.current.at < 1000
            ? typeahead.current.text + e.key.toLowerCase()
            : e.key.toLowerCase();
        typeahead.current = { text: q, at: now };
        const start = q.length === 1 ? active + 1 : active;
        for (let step = 0; step < options.length; step++) {
          const i = (start + step) % options.length;
          if (options[i].label.toLowerCase().startsWith(q)) {
            setActive(i);
            break;
          }
        }
      }
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        className={`select-trigger select-trigger--${variant}${className ? ` ${className}` : ""}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-activedescendant={open ? `${menuId}-${active}` : undefined}
        aria-label={ariaLabel}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span className="select-trigger-label">{selected?.label ?? value}</span>
        <svg
          className="select-trigger-chevron"
          width="8"
          height="8"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <polyline points="2 3.5 5 6.5 8 3.5" />
        </svg>
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="listbox"
            className="select-menu"
            style={
              pos
                ? { top: pos.top, left: pos.left, minWidth: pos.minWidth }
                : { top: 0, left: 0, visibility: "hidden" }
            }
            // Presses inside the menu must not move focus off the trigger
            // (aria-activedescendant pattern) and must not reach the host's
            // document-level "click outside closes the popover" handlers —
            // the portal lives under <body>, so to those handlers a click in
            // this menu looks like a click outside.
            onPointerDown={(e) => e.preventDefault()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {options.map((opt, i) => (
              <div
                key={opt.value}
                id={`${menuId}-${i}`}
                data-index={i}
                role="option"
                aria-selected={opt.value === value}
                className={`select-option${i === active ? " is-active" : ""}`}
                onClick={() => commit(i)}
                onPointerMove={() => setActive(i)}
              >
                <span className="select-option-check" aria-hidden>
                  {opt.value === value && (
                    <svg
                      width="11"
                      height="11"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </span>
                <span className="select-option-text">
                  <span className="select-option-label">{opt.label}</span>
                  {opt.detail && (
                    <span className="select-option-detail">{opt.detail}</span>
                  )}
                </span>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
