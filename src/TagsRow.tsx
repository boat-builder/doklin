// A note's tags, right below its title: a chip per tag, in the list's order,
// and *+ Tag*. A chip's menu sets the value, removes the tag or opens the
// tag's editor; *+ Tag* offers the tags the note doesn't have and *New
// tag…*. The rest of the block, when there is any, is a closed
// *Frontmatter* disclosure under the chips, as the file has it.
//
// Nothing here writes. The host does (App.tsx: through the save path), and
// the rules are src/tags.ts's.

import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useDismiss } from "./dismiss";
import { splitFrontmatter } from "./frontmatter";
import { hasOtherFrontmatter, noteTags, type NoteTag, type TagDef } from "./tags";

type MenuState =
  | { kind: "chip"; tag: NoteTag; x: number; y: number }
  | { kind: "add"; open: string | null; x: number; y: number };

const MENU_W = 220;

function placeUnder(el: HTMLElement): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: Math.min(r.left, window.innerWidth - MENU_W - 8), y: r.bottom + 4 };
}

/** ↑ and ↓ move between a menu's items. */
function menuKeys(e: KeyboardEvent<HTMLDivElement>) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = e.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
  items[next]?.focus();
}

function Menu({
  at,
  holder,
  label,
  onClose,
  children,
}: {
  at: { x: number; y: number };
  /** What a press inside doesn't close it for: the row with its trigger. */
  holder: React.RefObject<HTMLElement | null>;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(onClose, holder);
  // Opened (each level of *+ Tag*'s is a menu of its own): kept on screen,
  // and its first item focused.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 8) el.style.top = `${Math.max(8, window.innerHeight - r.height - 8)}px`;
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, []);
  return (
    <div
      ref={ref}
      className="tree-context-menu tag-menu"
      role="menu"
      aria-label={label}
      style={{ left: at.x, top: at.y, width: MENU_W }}
      onKeyDown={menuKeys}
    >
      {children}
    </div>
  );
}

function Check({ on }: { on: boolean }) {
  return (
    <span className="tag-menu-check" aria-hidden>
      {on && (
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3.5 8.4l3 3 6-6.8" />
        </svg>
      )}
    </span>
  );
}

function Item({
  children,
  onClick,
  danger,
  disabled,
  checked,
}: {
  children: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
}) {
  return (
    <button
      role={checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={checked}
      className={`sidebar-menu-item tag-menu-item ${danger ? "is-danger" : ""}`}
      disabled={disabled}
      onClick={onClick}
    >
      {checked !== undefined && <Check on={checked} />}
      <span className="tag-menu-label">{children}</span>
    </button>
  );
}

/** Its height, as `--doc-tags-h` on the document's scroller: a short note is
 *  a viewport tall less the title and this, so it doesn't scroll. */
function useHeightVar(ref: React.RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const el = ref.current;
    const wrap = el?.parentElement;
    if (!el || !wrap) return;
    const observer = new ResizeObserver(() => wrap.style.setProperty("--doc-tags-h", `${el.offsetHeight}px`));
    observer.observe(el);
    return () => {
      observer.disconnect();
      wrap.style.removeProperty("--doc-tags-h");
    };
  }, [ref]);
}

export function TagsRow({
  head,
  list,
  readOnly,
  onSet,
  onNewTag,
  onEditTag,
  addToken,
}: {
  /** The note's frontmatter block, both fences included ("" for none). */
  head: string;
  list: TagDef[];
  readOnly: boolean;
  /** Give the note `value` for the tag (spelled as the list spells both), or
   *  clear it. */
  onSet?: (name: string, value: string | null) => void;
  onNewTag?: () => void;
  onEditTag?: (name: string) => void;
  /** Bumped to open *+ Tag*'s menu (the Edit menu's *Add Tag…*). Every
   *  pane gets the same token: a read-only row takes a bump in and opens
   *  nothing, so a pane promoted later doesn't read the token it then sees
   *  as a new one. */
  addToken?: number;
}) {
  const tags = useMemo(() => noteTags(head, list), [head, list]);
  const other = useMemo(() => hasOtherFrontmatter(head, list), [head, list]);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  useHeightVar(rowRef);

  // The Edit menu's *Add Tag…*: the menu opens under *+ Tag*.
  const seenToken = useRef(addToken);
  useLayoutEffect(() => {
    if (addToken === seenToken.current) return;
    seenToken.current = addToken;
    if (!readOnly && addRef.current) setMenu({ kind: "add", open: null, ...placeUnder(addRef.current) });
  }, [addToken, readOnly]);

  const close = () => setMenu(null);
  const set = (name: string, value: string | null) => {
    close();
    onSet?.(name, value);
  };
  const missing = list.filter((d) => !tags.some((t) => t.name === d.name));
  const editable = !readOnly && onSet !== undefined;

  // Read-only with nothing to show, the row still takes its room: the other
  // pane is promoted on a press, and a row appearing then would move the
  // note under the pointer, so the click lands somewhere else (a link in it
  // never followed).
  return (
    <div className="doc-tags" ref={rowRef} data-testid="doc-tags">
      <div className={`doc-tags-row ${tags.length === 0 ? "is-empty" : ""}`}>
        {tags.map((t) => (
          <button
            key={t.name}
            className={`tag-chip ${t.known ? "" : "is-unknown"}`}
            data-testid={`tag-chip-${t.name}`}
            disabled={!editable}
            aria-haspopup={editable ? "menu" : undefined}
            aria-expanded={editable ? menu?.kind === "chip" && menu.tag.name === t.name : undefined}
            title={t.known ? undefined : `${t.value} isn't one of ${t.name}'s values.`}
            onClick={(e) => {
              if (menu?.kind === "chip" && menu.tag.name === t.name) return close();
              setMenu({ kind: "chip", tag: t, ...placeUnder(e.currentTarget) });
            }}
          >
            <span className="tag-chip-name">{t.name}</span>
            <span className="tag-chip-value">{t.value}</span>
          </button>
        ))}
        {editable && (
          <button
            ref={addRef}
            className="tag-add"
            data-testid="tag-add"
            aria-haspopup="menu"
            aria-expanded={menu?.kind === "add"}
            onClick={(e) => {
              if (menu?.kind === "add") return close();
              setMenu({ kind: "add", open: null, ...placeUnder(e.currentTarget) });
            }}
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
              <path d="M8 3v10M3 8h10" />
            </svg>
            {tags.length === 0 ? "Add tag" : "Tag"}
          </button>
        )}
      </div>
      {other && (
        <details className="doc-frontmatter-more">
          <summary>Frontmatter</summary>
          <pre aria-label="Frontmatter">{splitFrontmatter(head).inner}</pre>
        </details>
      )}
      {menu?.kind === "chip" && (() => {
        const def = list.find((d) => d.name === menu.tag.name)!;
        return (
          <Menu key={`chip:${def.name}`} at={menu} holder={rowRef} label={menu.tag.name} onClose={close}>
            {!menu.tag.known && (
              <Item checked disabled>
                {menu.tag.value} <span className="tag-menu-hint">not one of the values</span>
              </Item>
            )}
            {def.values.map((v) => (
              <Item key={v} checked={menu.tag.known && v === menu.tag.value} onClick={() => set(def.name, v)}>
                {v}
              </Item>
            ))}
            <div className="tag-menu-rule" role="separator" />
            <Item onClick={() => set(def.name, null)}>Remove</Item>
            <Item
              onClick={() => {
                close();
                onEditTag?.(def.name);
              }}
            >
              Edit {def.name}…
            </Item>
          </Menu>
        );
      })()}
      {menu?.kind === "add" && (
        <Menu key={`add:${menu.open ?? ""}`} at={menu} holder={rowRef} label="Add tag" onClose={close}>
          {menu.open === null ? (
            <>
              {missing.map((d) => (
                <Item key={d.name} onClick={() => setMenu({ ...menu, open: d.name })}>
                  {d.name}
                  <span className="tag-menu-more" aria-hidden>›</span>
                </Item>
              ))}
              {missing.length > 0 && <div className="tag-menu-rule" role="separator" />}
              <Item
                onClick={() => {
                  close();
                  onNewTag?.();
                }}
              >
                New tag…
              </Item>
            </>
          ) : (
            <>
              <Item onClick={() => setMenu({ ...menu, open: null })}>
                <span className="tag-menu-back" aria-hidden>‹</span>
                {menu.open}
              </Item>
              <div className="tag-menu-rule" role="separator" />
              {(list.find((d) => d.name === menu.open)?.values ?? []).map((v) => (
                <Item key={v} checked={false} onClick={() => set(menu.open!, v)}>
                  {v}
                </Item>
              ))}
            </>
          )}
        </Menu>
      )}
    </div>
  );
}
