// The kanban view — a datastore shown as columns of cards.
//
// One component for every host: the board tab a sidebar row opens, a board
// embedded in a note, and the read-only mirror an unfocused split pane shows.
// It renders from the shared store model and writes through it; every change
// is a file on disk, so a drag here and a drag on another machine meet in the
// sync engine like any other edit.
//
// The store itself — loading it, which view is showing, the header above the
// columns — belongs to StoreView.tsx, which hosts this and the table view
// alike. What is here is the columns and the drag.
//
// Drag is POINTER-based, not HTML5 drag-and-drop: Tauri intercepts native
// drag events for its own file-drop handling, which is why the sidebar's row
// drag and the tab bar's reorder are built the same way.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CardMenu, InlineInput, Popover } from "./storeChrome";
import type { StoreModel } from "./store/model";
import {
  boardColumns,
  cardChips,
  chipFieldsOf,
  orderedOptions,
  type BoardColumn,
  type Card,
} from "./store/board";
import {
  OPTION_COLORS,
  type Field,
  type OptionColor,
  type Sort,
  type StoreDef,
} from "./store/storeFile";

type DropTarget = { colKey: string; index: number } | null;

type CardDrag = {
  kind: "card";
  path: string;
  title: string;
  /** The column the card was picked up from — a multi_select card is in
   *  several at once, and only the one it left should lose its value. */
  from: string;
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
  def: StoreDef;
  /** The cards this view shows — already through the view's filter. */
  cards: Card[];
  model: StoreModel | null;
  /** The field the columns come from. */
  groupBy: string;
  groupField: Field;
  /** Column values to leave out (a view's or an embed's `hide`). */
  hide?: string[];
  /** The view's sort, which replaces rank order inside every column. */
  sort?: Sort | null;
  /** Which fields a card's face shows chips for; null = all but the group-by. */
  show?: string[] | null;
  /** A published page or an unfocused pane: same DOM, no writing. */
  readOnly?: boolean;
  /** Told when a drag starts and ends, so the host can dress the whole board. */
  onDragging?: (dragging: boolean) => void;
  /** Leave a column out of the saved view. Absent where the view is fixed. */
  onHideColumn?: (value: string) => void;
  /** Open a card — a peek where the host offers one, else its note. */
  onOpenCard: (path: string) => void;
  /** Present when a click PEEKS, so the tab is still one menu item away. */
  onOpenCardTab?: (path: string) => void;
  /** Rename through the app, so open tabs, shares and the sidecar follow. */
  onRenameCard?: (from: string, to: string) => Promise<string | null>;
  /** Delete through the app, so it lands in the Trash with its sidecar. */
  onDeleteCard?: (path: string) => void;
  onRevealInFinder?: (path: string) => void;
};

export default function KanbanBoard({
  def,
  cards,
  model,
  groupBy,
  groupField,
  hide,
  sort = null,
  show = null,
  readOnly = false,
  onDragging,
  onHideColumn,
  onOpenCard,
  onOpenCardTab,
  onRenameCard,
  onDeleteCard,
  onRevealInFinder,
}: Props) {
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

  // The columns come from the shared derivation (store/board.ts), which is
  // also what a share push snapshots — a published board and this one can't
  // disagree about what it shows.
  const columns: BoardColumn[] = useMemo(
    () => boardColumns(def, cards, groupBy, { hide, sort }),
    [def, groupBy, cards, hide, sort],
  );

  // The chips a card face shows: the fields this view shows, except the one
  // the board groups by (the column already says it).
  const chipFields = useMemo(
    () => chipFieldsOf(def, groupBy, show),
    [def, groupBy, show],
  );

  // Only a field whose values ARE options can grow a column. A board grouped
  // by a date has columns because cards carry dates; there is nothing to add.
  const declaresOptions =
    groupField.type === "select" || groupField.type === "multi_select";

  /* ---------- pointer drag ---------- */

  const clearDrag = useCallback(() => {
    dragRef.current = null;
    dropRef.current = null;
    setDrag(null);
    setDrop(null);
    onDragging?.(false);
  }, [onDragging]);

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
      if (started && !d.started) onDragging?.(true);
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
      if (!d || !d.started || !model) return;
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
          d.from,
        );
        return;
      }
      const declared = orderedOptions(def, groupBy).filter((o) => o.name !== d.key);
      const me = def.options.find((o) => o.field === groupBy && o.name === d.key);
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
  }, [drag, columns, def, groupBy, model, hitCard, hitColumn, clearDrag, onDragging]);

  const startCardDrag = (
    e: React.PointerEvent<HTMLElement>,
    card: Card,
    from: string,
  ) => {
    if (readOnly || e.button !== 0) return;
    const box = e.currentTarget.getBoundingClientRect();
    const next: CardDrag = {
      kind: "card",
      path: card.path,
      title: card.title,
      from,
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

  const startColumnDrag = (e: React.PointerEvent<HTMLElement>, col: BoardColumn) => {
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

  const addCard = async (col: BoardColumn, title: string) => {
    if (!model) return;
    const clean = title.trim();
    if (!clean) return;
    const props: Record<string, string> = { [groupBy]: col.key };
    if (col.key === NO_VALUE) delete props[groupBy];
    await model.createCard(clean, {
      ...props,
      rank: model.appendRank(col.cards),
    });
  };

  const dragging = drag?.started === true;

  return (
    <>
      <div className="dk-board-cols" ref={boardRef}>
        {columns.map((col) => (
          <section
            key={col.key || " none"}
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
                    onPointerDown={(e) => startCardDrag(e, card, col.key)}
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
              {col.adoptable && !readOnly && (
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
        {!readOnly && declaresOptions && (
          <div className="dk-col dk-col-new">
            {addingColumn ? (
              <InlineInput
                initial=""
                placeholder="Column name"
                ariaLabel="New column"
                onCommit={async (name) => {
                  setAddingColumn(false);
                  await model?.addOption(groupBy, name);
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
          onHide={
            onHideColumn
              ? () => {
                  const key = menu.key;
                  setMenu(null);
                  onHideColumn(key);
                }
              : undefined
          }
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
          onOpenTab={
            onOpenCardTab
              ? () => {
                  onOpenCardTab(cardMenu.path);
                  setCardMenu(null);
                }
              : undefined
          }
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
    </>
  );
}

/** A column's cards minus the one currently in flight. */
function visibleCards(col: BoardColumn, drag: Drag | null): Card[] {
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
  fields: Field[];
}) {
  const chips = cardChips(card, def, fields);
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

function ColumnMenu({
  x,
  y,
  declared,
  onRename,
  onColor,
  onHide,
  onDelete,
  onClose,
}: {
  x: number;
  y: number;
  /** False for a value no option declares: there is no record to colour or
   *  delete yet, only cards carrying the value. Renaming still works — it
   *  rewrites the value in every card that uses it — and so does hiding,
   *  which is a property of the view, not of the option. */
  declared: boolean;
  onRename: () => void;
  onColor: (c: OptionColor) => void;
  onHide?: () => void;
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
      {onHide && (
        <button className="dk-popover-item" onClick={onHide}>
          Hide in this view
        </button>
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
