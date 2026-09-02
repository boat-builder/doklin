// The kanban view — the one way a datastore is shown today.
//
// One component for both hosts: the board tab a sidebar row opens, and (from
// phase 2) a board embedded in a note. It renders from the shared store model
// and writes through it; every change is a file on disk, so a drag here and a
// drag on another machine meet in the sync engine like any other edit.
//
// Drag is POINTER-based, not HTML5 drag-and-drop: Tauri intercepts native
// drag events for its own file-drop handling, which is why the sidebar's row
// drag and the tab bar's reorder are built the same way.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "./store/useStore";
import { columnCards, orderedOptions, cardValue, type Card } from "./store/model";
import {
  kanbanView,
  fieldOf,
  OPTION_COLORS,
  type Option,
  type OptionColor,
  type StoreDef,
} from "./store/storeFile";
import { propText } from "./store/frontmatter";

/** A column: a declared option, the empty value, or a value nothing declares. */
type Column = {
  /** The group-by value this column holds. "" is the "No status" column. */
  key: string;
  label: string;
  color: OptionColor | null;
  option: Option | null;
  /** False for the empty column and for values no option declares. */
  declared: boolean;
  cards: Card[];
};

type DropTarget = { colKey: string; index: number } | null;

type CardDrag = {
  kind: "card";
  path: string;
  title: string;
  startX: number;
  startY: number;
  x: number;
  y: number;
  width: number;
  started: boolean;
};

type ColumnDrag = {
  kind: "column";
  key: string;
  label: string;
  startX: number;
  startY: number;
  x: number;
  y: number;
  started: boolean;
  /** Insertion index among the declared columns. */
  index: number;
};

type Drag = CardDrag | ColumnDrag;

const DRAG_THRESHOLD = 4;
const NO_VALUE = "";

type Props = {
  /** The store's folder. */
  dir: string;
  /** Which saved view to show; the store's first kanban view by default. */
  viewId?: string | null;
  /** A published page or an unfocused pane: same DOM, no writing. */
  readOnly?: boolean;
  /** Open a card's note. */
  onOpenCard: (path: string) => void;
  /** Rename through the app, so open tabs, shares and the sidecar follow. */
  onRenameCard?: (from: string, to: string) => Promise<string | null>;
  /** Delete through the app, so it lands in the Trash with its sidecar. */
  onDeleteCard?: (path: string) => void;
  onRevealInFinder?: (path: string) => void;
};

export default function KanbanBoard({
  dir,
  viewId = null,
  readOnly = false,
  onOpenCard,
  onRenameCard,
  onDeleteCard,
  onRevealInFinder,
}: Props) {
  const { state, model } = useStore(dir);
  const { def, cards } = state;
  const view = useMemo(() => (def ? kanbanView(def, viewId) : null), [def, viewId]);
  const groupBy = view?.groupBy ?? null;
  const groupField = def && groupBy ? fieldOf(def, groupBy) : null;

  const [drag, setDrag] = useState<Drag | null>(null);
  const [drop, setDrop] = useState<DropTarget>(null);
  const dragRef = useRef<Drag | null>(null);
  const dropRef = useRef<DropTarget>(null);
  const boardRef = useRef<HTMLDivElement | null>(null);

  // Inline composers: a new card at a column's foot, a new column at the end.
  const [composing, setComposing] = useState<string | null>(null);
  const [addingColumn, setAddingColumn] = useState(false);
  const [menu, setMenu] = useState<{ key: string; x: number; y: number } | null>(null);
  const [cardMenu, setCardMenu] = useState<{ path: string; x: number; y: number } | null>(
    null,
  );
  const [renaming, setRenaming] = useState<string | null>(null);

  const columns: Column[] = useMemo(() => {
    if (!def || !groupBy) return [];
    const declared = orderedOptions(def, groupBy);
    const known = new Set(declared.map((o) => o.name));
    const stray = new Set<string>();
    for (const c of cards) {
      const v = cardValue(c, groupBy);
      if (v !== NO_VALUE && !known.has(v)) stray.add(v);
    }
    const build = (
      key: string,
      label: string,
      option: Option | null,
      isDeclared: boolean,
    ): Column => ({
      key,
      label,
      color: option?.color ?? null,
      option,
      declared: isDeclared,
      cards: columnCards(cards, groupBy, key),
    });
    return [
      build(NO_VALUE, `No ${(groupField?.name ?? groupBy).toLowerCase()}`, null, false),
      ...declared.map((o) => build(o.name, o.name, o, true)),
      ...[...stray].sort().map((v) => build(v, v, null, false)),
    ];
  }, [def, groupBy, groupField, cards]);

  // The chips a card face shows: every declared field except the one the
  // board groups by (the column already says it) and the position key.
  const chipFields = useMemo(
    () => (def ? def.fields.filter((f) => f.id !== groupBy) : []),
    [def, groupBy],
  );

  /* ---------- pointer drag ---------- */

  const clearDrag = useCallback(() => {
    dragRef.current = null;
    dropRef.current = null;
    setDrag(null);
    setDrop(null);
  }, []);

  // Where a pointer at (x, y) would drop the dragged card: the column under
  // it, and the index among that column's OTHER cards.
  const hitCard = useCallback((x: number, y: number, self: string): DropTarget => {
    const el = document.elementFromPoint(x, y);
    const col = el?.closest<HTMLElement>("[data-dk-col]");
    if (!col) return null;
    const key = col.dataset.dkCol ?? NO_VALUE;
    const list = Array.from(
      col.querySelectorAll<HTMLElement>("[data-dk-card]"),
    ).filter((n) => n.dataset.dkCard !== self);
    let index = list.length;
    for (let i = 0; i < list.length; i++) {
      const box = list[i].getBoundingClientRect();
      if (y < box.top + box.height / 2) {
        index = i;
        break;
      }
    }
    return { colKey: key, index };
  }, []);

  const hitColumn = useCallback((x: number, self: string): number => {
    const board = boardRef.current;
    if (!board) return 0;
    const list = Array.from(
      board.querySelectorAll<HTMLElement>("[data-dk-col-declared='1']"),
    ).filter((n) => n.dataset.dkCol !== self);
    let index = list.length;
    for (let i = 0; i < list.length; i++) {
      const box = list[i].getBoundingClientRect();
      if (x < box.left + box.width / 2) {
        index = i;
        break;
      }
    }
    return index;
  }, []);

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const started =
        d.started ||
        Math.abs(e.clientX - d.startX) > DRAG_THRESHOLD ||
        Math.abs(e.clientY - d.startY) > DRAG_THRESHOLD;
      if (d.kind === "card") {
        const next: CardDrag = { ...d, x: e.clientX, y: e.clientY, started };
        dragRef.current = next;
        setDrag(next);
        if (started) {
          const target = hitCard(e.clientX, e.clientY, d.path);
          dropRef.current = target;
          setDrop(target);
        }
      } else {
        const index = started ? hitColumn(e.clientX, d.key) : d.index;
        const next: ColumnDrag = { ...d, x: e.clientX, y: e.clientY, started, index };
        dragRef.current = next;
        setDrag(next);
      }
    };
    const onUp = () => {
      const d = dragRef.current;
      const target = dropRef.current;
      clearDrag();
      if (!d || !d.started || !model || !groupBy) return;
      if (d.kind === "card") {
        if (!target) return;
        const col = columns.find((c) => c.key === target.colKey);
        if (!col) return;
        const list = col.cards.filter((c) => c.path !== d.path);
        void model.moveCard(
          d.path,
          groupBy,
          col.key,
          list[target.index - 1] ?? null,
          list[target.index] ?? null,
        );
        return;
      }
      const declared = orderedOptions(def!, groupBy).filter((o) => o.name !== d.key);
      const me = def!.options.find((o) => o.field === groupBy && o.name === d.key);
      if (!me) return;
      void model.moveOption(
        groupBy,
        d.key,
        declared[d.index - 1] ?? null,
        declared[d.index] ?? null,
      );
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearDrag();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", clearDrag);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", clearDrag);
      window.removeEventListener("keydown", onKey);
    };
  }, [drag, columns, def, groupBy, model, hitCard, hitColumn, clearDrag]);

  const startCardDrag = (e: React.PointerEvent<HTMLElement>, card: Card) => {
    if (readOnly || e.button !== 0) return;
    const box = e.currentTarget.getBoundingClientRect();
    const next: CardDrag = {
      kind: "card",
      path: card.path,
      title: card.title,
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      y: e.clientY,
      width: box.width,
      started: false,
    };
    dragRef.current = next;
    setDrag(next);
  };

  const startColumnDrag = (e: React.PointerEvent<HTMLElement>, col: Column) => {
    if (readOnly || e.button !== 0 || !col.declared) return;
    const next: ColumnDrag = {
      kind: "column",
      key: col.key,
      label: col.label,
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      y: e.clientY,
      started: false,
      index: 0,
    };
    dragRef.current = next;
    setDrag(next);
  };

  /* ---------- composers ---------- */

  const addCard = async (col: Column, title: string) => {
    if (!model || !groupBy) return;
    const clean = title.trim();
    if (!clean) return;
    const props: Record<string, string> = { [groupBy]: col.key };
    if (col.key === NO_VALUE) delete props[groupBy];
    await model.createCard(clean, {
      ...props,
      rank: model.appendRank(col.cards),
    });
  };

  const addColumn = async (name: string) => {
    if (!model || !groupBy) return;
    await model.addOption(groupBy, name);
  };

  /* ---------- render ---------- */

  if (state.loading) {
    return <div className="dk-board-empty">Loading board…</div>;
  }
  if (state.error) {
    return <div className="dk-board-empty">This board couldn’t be read: {state.error}</div>;
  }
  if (!def) {
    return (
      <div className="dk-board-empty">
        This folder is no longer a board — its <code>store.jsonl</code> is gone. The
        notes inside it are intact.
      </div>
    );
  }
  if (!groupBy || !groupField) {
    return (
      <div className="dk-board-empty">
        This board has no select field to group by. Add one to{" "}
        <code>store.jsonl</code> to see columns.
      </div>
    );
  }

  const dragging = drag?.started === true;

  return (
    <div className={`dk-board ${dragging ? "is-dragging" : ""}`} ref={boardRef}>
      <header className="dk-board-head">
        <h1 className="dk-board-title">{def.name || state.dir.split("/").pop()}</h1>
        <span className="dk-board-sub">
          {cards.length} {cards.length === 1 ? "card" : "cards"} · grouped by{" "}
          {groupField.name}
        </span>
      </header>
      {state.conflicts.length > 0 && (
        <div className="dk-board-warn">
          This board’s definition has a conflict copy from sync (
          {state.conflicts.join(", ")}). Open it to see what differs, then delete it.
        </div>
      )}
      {state.truncated && (
        <div className="dk-board-warn">
          This folder holds more notes than one board can show; some cards are not
          listed.
        </div>
      )}
      <div className="dk-board-cols">
        {columns.map((col) => (
          <section
            key={col.key || " none"}
            className={`dk-col ${col.declared ? "" : "is-loose"} ${
              drop?.colKey === col.key && dragging ? "is-drop-target" : ""
            }`}
            data-dk-col={col.key}
            data-dk-col-declared={col.declared ? "1" : "0"}
          >
            <header
              className="dk-col-head"
              onPointerDown={(e) => startColumnDrag(e, col)}
            >
              <span className={`dk-col-dot dk-color-${col.color ?? "grey"}`} aria-hidden />
              {renaming === col.key ? (
                <InlineInput
                  initial={col.label}
                  ariaLabel="Rename column"
                  onCommit={async (name) => {
                    setRenaming(null);
                    if (model) await model.renameOption(groupBy, col.key, name);
                  }}
                  onCancel={() => setRenaming(null)}
                />
              ) : (
                <span className="dk-col-name" title={col.label}>
                  {col.label}
                </span>
              )}
              <span className="dk-col-count">{col.cards.length}</span>
              {!readOnly && col.key !== NO_VALUE && (
                <button
                  className="dk-col-menu-btn"
                  aria-label={`Column options for ${col.label}`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    const box = e.currentTarget.getBoundingClientRect();
                    setMenu({ key: col.key, x: box.left, y: box.bottom + 4 });
                  }}
                >
                  ⋯
                </button>
              )}
            </header>
            <div className="dk-col-list">
              {/* The card being dragged leaves its column and follows the
                  pointer as a ghost, so the drop line indexes against what
                  is actually left to sit between. */}
              {visibleCards(col, drag).map((card, i) => (
                <Fragment key={card.path}>
                  {dragging && drop?.colKey === col.key && drop.index === i && (
                    <div className="dk-drop-line" />
                  )}
                  <article
                    className="dk-card"
                    data-dk-card={card.path}
                    onPointerDown={(e) => startCardDrag(e, card)}
                    onClick={() => {
                      if (dragRef.current?.started) return;
                      onOpenCard(card.path);
                    }}
                    onContextMenu={(e) => {
                      if (readOnly) return;
                      e.preventDefault();
                      setCardMenu({ path: card.path, x: e.clientX, y: e.clientY });
                    }}
                    title={card.path}
                  >
                    <div className="dk-card-title">{card.title}</div>
                    <Chips card={card} def={def} fields={chipFields} />
                  </article>
                </Fragment>
              ))}
              {dragging &&
                drop?.colKey === col.key &&
                drop.index >= visibleCards(col, drag).length && (
                  <div className="dk-drop-line" />
                )}
              {!col.declared && col.key !== NO_VALUE && !readOnly && (
                <button
                  className="dk-col-adopt"
                  onClick={() => void model?.adoptValue(groupBy, col.key)}
                >
                  Add “{col.label}” as an option
                </button>
              )}
            </div>
            {!readOnly && (
              <footer className="dk-col-foot">
                {composing === col.key ? (
                  <InlineInput
                    initial=""
                    placeholder="Card title"
                    ariaLabel={`New card in ${col.label}`}
                    keepOpen
                    onCommit={async (title) => {
                      await addCard(col, title);
                    }}
                    onCancel={() => setComposing(null)}
                  />
                ) : (
                  <button className="dk-col-add" onClick={() => setComposing(col.key)}>
                    + New
                  </button>
                )}
              </footer>
            )}
          </section>
        ))}
        {!readOnly && (
          <div className="dk-col dk-col-new">
            {addingColumn ? (
              <InlineInput
                initial=""
                placeholder="Column name"
                ariaLabel="New column"
                onCommit={async (name) => {
                  setAddingColumn(false);
                  await addColumn(name);
                }}
                onCancel={() => setAddingColumn(false)}
              />
            ) : (
              <button className="dk-col-add" onClick={() => setAddingColumn(true)}>
                + Add column
              </button>
            )}
          </div>
        )}
      </div>

      {menu && (
        <ColumnMenu
          x={menu.x}
          y={menu.y}
          declared={columns.find((c) => c.key === menu.key)?.declared === true}
          onRename={() => {
            setRenaming(menu.key);
            setMenu(null);
          }}
          onColor={(color) => {
            void model?.setOptionColor(groupBy, menu.key, color);
            setMenu(null);
          }}
          onDelete={() => {
            void model?.deleteOption(groupBy, menu.key);
            setMenu(null);
          }}
          onClose={() => setMenu(null)}
        />
      )}
      {cardMenu && (
        <CardMenu
          x={cardMenu.x}
          y={cardMenu.y}
          onOpen={() => {
            onOpenCard(cardMenu.path);
            setCardMenu(null);
          }}
          onRename={
            onRenameCard
              ? () => {
                  const card = cards.find((c) => c.path === cardMenu.path);
                  setCardMenu(null);
                  if (!card) return;
                  const next = window.prompt("Rename card", card.title);
                  if (next && next.trim() && next.trim() !== card.title) {
                    const dirOf = card.path.slice(0, card.path.lastIndexOf("/"));
                    void onRenameCard(
                      card.path,
                      `${dirOf}/${next.trim().replace(/[/:]/g, "-")}.md`,
                    );
                  }
                }
              : undefined
          }
          onReveal={
            onRevealInFinder
              ? () => {
                  onRevealInFinder(cardMenu.path);
                  setCardMenu(null);
                }
              : undefined
          }
          onDelete={
            onDeleteCard
              ? () => {
                  onDeleteCard(cardMenu.path);
                  setCardMenu(null);
                }
              : undefined
          }
          onClose={() => setCardMenu(null)}
        />
      )}
      {dragging && drag.kind === "card" && (
        <div
          className="dk-drag-ghost"
          style={{ left: drag.x + 8, top: drag.y + 8, width: drag.width }}
        >
          {drag.title}
        </div>
      )}
      {dragging && drag.kind === "column" && (
        <div className="dk-drag-ghost" style={{ left: drag.x + 8, top: drag.y + 8 }}>
          {drag.label}
        </div>
      )}
    </div>
  );

}

/** A column's cards minus the one currently in flight. */
function visibleCards(col: Column, drag: Drag | null): Card[] {
  return drag?.kind === "card" && drag.started
    ? col.cards.filter((c) => c.path !== drag.path)
    : col.cards;
}

function Chips({
  card,
  def,
  fields,
}: {
  card: Card;
  def: StoreDef;
  fields: StoreDef["fields"];
}) {
  const chips: { key: string; text: string; color: OptionColor | null }[] = [];
  for (const f of fields) {
    const raw = card.props[f.id];
    const text = propText(raw);
    if (text === "") continue;
    if (f.type === "multi_select" && Array.isArray(raw)) {
      for (const v of raw) {
        const opt = def.options.find((o) => o.field === f.id && o.name === v);
        chips.push({ key: `${f.id}:${v}`, text: v, color: opt?.color ?? null });
      }
      continue;
    }
    const opt = def.options.find((o) => o.field === f.id && o.name === text);
    chips.push({ key: f.id, text, color: opt?.color ?? null });
  }
  if (chips.length === 0) return null;
  return (
    <div className="dk-card-chips">
      {chips.map((c) => (
        <span key={c.key} className={`dk-chip dk-color-${c.color ?? "grey"}`}>
          {c.text}
        </span>
      ))}
    </div>
  );
}

/** A one-line input that commits on Enter and cancels on Escape or blur. */
function InlineInput({
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

function Popover({
  x,
  y,
  onClose,
  children,
}: {
  x: number;
  y: number;
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
      className="dk-popover"
      style={{ left: x, top: y }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

function ColumnMenu({
  x,
  y,
  declared,
  onRename,
  onColor,
  onDelete,
  onClose,
}: {
  x: number;
  y: number;
  /** False for a value no option declares: there is no record to colour or
   *  delete yet, only cards carrying the value. Renaming still works — it
   *  rewrites the value in every card that uses it. */
  declared: boolean;
  onRename: () => void;
  onColor: (c: OptionColor) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <Popover x={x} y={y} onClose={onClose}>
      <button className="dk-popover-item" onClick={onRename}>
        Rename…
      </button>
      {declared && (
        <div className="dk-popover-colors">
          {OPTION_COLORS.map((c) => (
            <button
              key={c}
              className={`dk-color-swatch dk-color-${c}`}
              aria-label={c}
              title={c}
              onClick={() => onColor(c)}
            />
          ))}
        </div>
      )}
      {declared && (
        <>
          <button className="dk-popover-item is-danger" onClick={onDelete}>
            Delete column
          </button>
          <div className="dk-popover-note">
            Deleting a column keeps every card — they move to a column of their
            own.
          </div>
        </>
      )}
    </Popover>
  );
}

function CardMenu({
  x,
  y,
  onOpen,
  onRename,
  onReveal,
  onDelete,
  onClose,
}: {
  x: number;
  y: number;
  onOpen: () => void;
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
