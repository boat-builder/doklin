// The table view — a datastore shown as rows and columns.
//
// The second way to look at the same files. Nothing about a store changes
// when it is shown this way: a row is a card, a cell is one property of it,
// and editing a cell writes that card's frontmatter through exactly the
// pipeline a board's drag writes through. What differs is only what is easy
// to see — a board answers "what is in progress", a table answers "what does
// every card say".
//
// The rows arrive already filtered and sorted (store/board.ts owns that, so
// a published table and this one can't disagree); this file draws them.

import { useState } from "react";
import PropertyControl from "./PropertyControl";
import { CardMenu, InlineInput } from "./storeChrome";
import type { Card } from "./store/board";
import type { PropValue } from "./store/frontmatter";
import type { Field, Sort, StoreDef } from "./store/storeFile";

type Props = {
  def: StoreDef;
  /** The cards this view shows, in its order. */
  cards: Card[];
  /** The columns after the title, in the view's order. */
  fields: Field[];
  sort: Sort | null;
  readOnly?: boolean;
  /** Inside a note rather than filling a tab. */
  embedded?: boolean;
  /** Clicking a heading. Absent where the view isn't the reader's to change. */
  onSort?: (sort: Sort | null) => void;
  onSetProp?: (path: string, key: string, value: PropValue) => void;
  onAddOption?: (field: string, name: string) => void;
  onNewCard?: (title: string) => void;
  onOpenCard: (path: string) => void;
  /** Present when a click PEEKS, so the tab is still one menu item away. */
  onOpenCardTab?: (path: string) => void;
  onRenameCard?: (from: string, to: string) => Promise<string | null>;
  onDeleteCard?: (path: string) => void;
  onRevealInFinder?: (path: string) => void;
};

const UP = "↑";
const DOWN = "↓";

export default function TableView({
  def,
  cards,
  fields,
  sort,
  readOnly = false,
  embedded = false,
  onSort,
  onSetProp,
  onAddOption,
  onNewCard,
  onOpenCard,
  onOpenCardTab,
  onRenameCard,
  onDeleteCard,
  onRevealInFinder,
}: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);

  // Click a heading: ascending, then descending, then back to the table's own
  // order — which is by title, and is what the Title heading itself restores.
  const cycle = (id: string) => {
    if (!onSort) return;
    if (!sort || sort.field !== id) onSort({ field: id, dir: "asc" });
    else if (sort.dir === "asc") onSort({ field: id, dir: "desc" });
    else onSort(null);
  };
  const arrow = (id: string) =>
    sort?.field === id ? (sort.dir === "asc" ? ` ${UP}` : ` ${DOWN}`) : "";

  return (
    <div className={`dk-table-wrap ${embedded ? "is-embed" : ""}`}>
      <table className="dk-table">
        <thead>
          <tr>
            <th className="dk-th is-title" scope="col">
              <button
                className="dk-th-btn"
                disabled={!onSort}
                onClick={() => onSort?.(null)}
                title={onSort ? "Sort by title" : undefined}
              >
                Title{sort === null ? ` ${UP}` : ""}
              </button>
            </th>
            {fields.map((f) => (
              <th className="dk-th" scope="col" key={f.id}>
                <button
                  className="dk-th-btn"
                  disabled={!onSort}
                  onClick={() => cycle(f.id)}
                  title={onSort ? `Sort by ${f.name}` : undefined}
                >
                  {f.name}
                  {arrow(f.id)}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cards.map((card) => (
            <tr className="dk-tr" key={card.path}>
              <td className="dk-td is-title">
                <button
                  className="dk-row-title"
                  title={card.path}
                  onClick={() => onOpenCard(card.path)}
                  onContextMenu={(e) => {
                    if (readOnly) return;
                    e.preventDefault();
                    setMenu({ path: card.path, x: e.clientX, y: e.clientY });
                  }}
                >
                  {card.title}
                </button>
              </td>
              {fields.map((f) => (
                <td className="dk-td" key={f.id}>
                  <PropertyControl
                    def={def}
                    field={f}
                    value={card.props[f.id] ?? null}
                    readOnly={readOnly || !onSetProp}
                    open={open === `${card.path} ${f.id}`}
                    onOpen={(v) => setOpen(v ? `${card.path} ${f.id}` : null)}
                    onChange={(v) => onSetProp?.(card.path, f.id, v)}
                    onAddOption={
                      onAddOption ? (name) => onAddOption(f.id, name) : undefined
                    }
                  />
                </td>
              ))}
            </tr>
          ))}
          {cards.length === 0 && (
            <tr className="dk-tr">
              <td className="dk-td is-empty" colSpan={fields.length + 1}>
                No cards here yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {!readOnly && onNewCard && (
        <div className="dk-table-foot">
          {composing ? (
            <InlineInput
              initial=""
              placeholder="Card title"
              ariaLabel="New card"
              keepOpen
              onCommit={(title) => onNewCard(title)}
              onCancel={() => setComposing(false)}
            />
          ) : (
            <button className="dk-col-add" onClick={() => setComposing(true)}>
              + New
            </button>
          )}
        </div>
      )}
      {menu && (
        <CardMenu
          x={menu.x}
          y={menu.y}
          onOpen={() => {
            onOpenCard(menu.path);
            setMenu(null);
          }}
          onOpenTab={
            onOpenCardTab
              ? () => {
                  onOpenCardTab(menu.path);
                  setMenu(null);
                }
              : undefined
          }
          onRename={
            onRenameCard
              ? () => {
                  const card = cards.find((c) => c.path === menu.path);
                  setMenu(null);
                  if (!card) return;
                  const next = window.prompt("Rename card", card.title);
                  if (next && next.trim() && next.trim() !== card.title) {
                    const dir = card.path.slice(0, card.path.lastIndexOf("/"));
                    void onRenameCard(
                      card.path,
                      `${dir}/${next.trim().replace(/[/:]/g, "-")}.md`,
                    );
                  }
                }
              : undefined
          }
          onReveal={
            onRevealInFinder
              ? () => {
                  onRevealInFinder(menu.path);
                  setMenu(null);
                }
              : undefined
          }
          onDelete={
            onDeleteCard
              ? () => {
                  onDeleteCard(menu.path);
                  setMenu(null);
                }
              : undefined
          }
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
