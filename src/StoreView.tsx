// A datastore, shown.
//
// This is the shell every view of a store sits in: it holds the shared model
// for the folder, decides WHICH saved view is on screen, draws the heading and
// the view strip above it, and hands the cards to the board or the table. Both
// views read the same derivation (store/board.ts) from the same model, so what
// they show can never drift apart.
//
// Two hosts, two postures. A TAB owns the store — its strip switches between
// saved views, adds them, and edits what a view filters, sorts and shows, all
// of which is a line in store.jsonl and therefore everyone's. An EMBED shows
// the one view its fence names, in the language its fence is written in, and
// changes nothing: the note said what it wanted to show, and a reader
// scrolling past should not be able to rewrite that for the whole workspace.

import { useCallback, useEffect, useMemo, useState } from "react";
import KanbanBoard from "./KanbanBoard";
import TableView from "./TableView";
import { Popover } from "./storeChrome";
import { useStore } from "./store/useStore";
import {
  applyFilter,
  orderedOptions,
  viewCards,
  visibleFields,
  type Card,
} from "./store/board";
import { csvFileName, storeCsv } from "./store/csv";
import type { PropValue } from "./store/frontmatter";
import {
  fieldOf,
  groupableFields,
  resolveView,
  FILTER_OPS,
  type Filter,
  type FilterOp,
  type StoreDef,
  type View,
  type ViewKind,
} from "./store/storeFile";

// Which view a folder was last looked at in. A board tab is unmounted every
// time you switch tabs, and coming back to the table you were reading only to
// find the board again would be its own small betrayal. Not persisted: it is
// a glance, not a setting, and store.jsonl is shared with everyone.
const lastView = new Map<string, string>();

const OP_LABELS: Record<FilterOp, string> = {
  is: "is",
  is_not: "is not",
  has: "contains",
  empty: "is empty",
  not_empty: "is not empty",
};

type Props = {
  /** The store's folder. */
  dir: string;
  /**
   * The kind this host shows, fixed by a fence's language. Null in a tab,
   * where the kind is whichever view the reader picked.
   */
  kind?: ViewKind | null;
  /** Which saved view to show; the store's first of that kind by default. */
  viewId?: string | null;
  /**
   * Group by this field instead of the view's. An embed's `group:` key —
   * one note showing the same store split a different way, without changing
   * the store for everyone else.
   */
  group?: string | null;
  /** Column values to leave out (an embed's `hide:` key). */
  hide?: string[];
  /** Inside a note rather than filling a tab: sits in the text flow. */
  embedded?: boolean;
  /** A published page or an unfocused pane: same DOM, no writing. */
  readOnly?: boolean;
  /** Open a card. A host that peeks passes onOpenCardTab as well. */
  onOpenCard: (path: string) => void;
  onOpenCardTab?: (path: string) => void;
  onRenameCard?: (from: string, to: string) => Promise<string | null>;
  onDeleteCard?: (path: string) => void;
  onRevealInFinder?: (path: string) => void;
  /** Save an export. Absent where there is nowhere to save one. */
  onExport?: (fileName: string, text: string) => void;
};

export default function StoreView({
  dir,
  kind = null,
  viewId = null,
  group = null,
  hide,
  embedded = false,
  readOnly = false,
  onOpenCard,
  onOpenCardTab,
  onRenameCard,
  onDeleteCard,
  onRevealInFinder,
  onExport,
}: Props) {
  const { state, model } = useStore(dir);
  const { def, cards: allCards } = state;
  const [chosen, setChosen] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [options, setOptions] = useState<{ x: number; y: number } | null>(null);
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);
  const [renamingView, setRenamingView] = useState(false);

  useEffect(() => {
    setChosen(lastView.get(dir) ?? null);
  }, [dir]);

  const pick = useCallback(
    (id: string) => {
      lastView.set(dir, id);
      setChosen(id);
    },
    [dir],
  );

  // The view on screen. An embed's fence fixes the kind and may name the id;
  // a tab shows whatever the reader last picked, of either kind.
  const view: View | null = useMemo(() => {
    if (!def) return null;
    const wanted = viewId ?? chosen;
    if (kind) return resolveView(def, kind, wanted);
    const named = wanted ? def.views.find((v) => v.id === wanted) : null;
    // A tab shows a SAVED view of either kind before it shows a synthetic
    // one — a store with only a table saved opens on that table.
    return named ?? def.views[0] ?? resolveView(def, "kanban") ?? resolveView(def, "table");
  }, [def, kind, viewId, chosen]);

  const groupBy = group ?? view?.groupBy ?? "";
  const groupField = def && groupBy ? fieldOf(def, groupBy) : null;

  // A kanban view filters here and groups below (each column keeps its own
  // order); a table is filtered AND ordered in one go.
  const cards: Card[] = useMemo(() => {
    if (!def || !view) return [];
    return view.kind === "table"
      ? viewCards(def, allCards, view)
      : applyFilter(def, allCards, view.filter);
  }, [def, view, allCards]);

  const fields = useMemo(
    () => (def && view ? visibleFields(def, view.show) : []),
    [def, view],
  );

  const update = useCallback(
    (patch: Partial<Omit<View, "id" | "kind">>) => {
      if (view && model) void model.updateView(view, patch);
    },
    [view, model],
  );

  /* ---------- what there is to show ---------- */

  if (state.loading) {
    return <div className="dk-board-empty">Loading board…</div>;
  }
  if (state.error) {
    return <div className="dk-board-empty">This board couldn’t be read: {state.error}</div>;
  }
  if (!def) {
    // A tab can only be opened on a folder that WAS a board, so there the
    // honest report is that it stopped being one. An embed points wherever
    // its fence says, so there the folder may simply never have been one.
    return (
      <div className="dk-board-empty">
        {embedded ? (
          <>
            There’s no board here: this folder has no <code>store.jsonl</code>.
          </>
        ) : (
          <>
            This folder is no longer a board — its <code>store.jsonl</code> is gone.
            The notes inside it are intact.
          </>
        )}
      </div>
    );
  }

  const title = def.name || state.dir.split("/").pop();
  const shown = cards.length;
  const writable = !readOnly && model !== null;
  // Only a tab edits the store's own definition. An embed shows what its
  // fence asks for; changing that is the fence's business, not a reader's.
  const owns = writable && !embedded;

  const missingGroup = view?.kind !== "table" && (!groupBy || !groupField);

  return (
    <div
      className={`dk-board ${embedded ? "is-embed" : ""} ${dragging ? "is-dragging" : ""}`}
    >
      <header className="dk-board-head">
        {/* An embed lives inside someone's prose, where an <h1> would join
            the document outline and the table of contents. Only the tab —
            where the board IS the page — gets the heading. */}
        {embedded ? (
          <div className="dk-board-title">{title}</div>
        ) : (
          <h1 className="dk-board-title">{title}</h1>
        )}
        {!embedded && view && (
          <div className="dk-view-tabs">
            {def.views.map((v) => (
              <button
                key={v.id}
                className={`dk-view-tab ${v.id === view.id ? "is-on" : ""}`}
                onClick={() => pick(v.id)}
              >
                {v.name}
              </button>
            ))}
            {def.views.length === 0 && (
              <span className="dk-view-tab is-on">{view.name}</span>
            )}
            {owns && (
              <button
                className="dk-view-add"
                aria-label="New view"
                onClick={(e) => {
                  const box = e.currentTarget.getBoundingClientRect();
                  setAddMenu({ x: box.left, y: box.bottom + 4 });
                }}
              >
                +
              </button>
            )}
          </div>
        )}
        <span className="dk-board-spacer" />
        <span className="dk-board-sub">
          {shown} {shown === 1 ? "card" : "cards"}
          {view?.kind !== "table" && groupField ? ` · grouped by ${groupField.name}` : ""}
        </span>
        {owns && view && (
          <button
            className="dk-view-opts"
            onClick={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              setOptions({ x: Math.max(8, box.right - 300), y: box.bottom + 4 });
            }}
          >
            View
          </button>
        )}
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

      {!view || missingGroup ? (
        <div className="dk-board-empty">
          This board has no field to group by. Add a select, multi-select or date
          property to see columns{owns ? ", or switch to a table" : ""}.
        </div>
      ) : view.kind === "table" ? (
        <TableView
          def={def}
          cards={cards}
          fields={fields}
          sort={view.sort}
          readOnly={readOnly}
          embedded={embedded}
          onSort={owns ? (sort) => update({ sort }) : undefined}
          onSetProp={
            writable
              ? (path: string, key: string, value: PropValue) =>
                  void model?.setCardProp(path, key, value)
              : undefined
          }
          onAddOption={
            writable ? (field, name) => void model?.addOption(field, name) : undefined
          }
          onNewCard={
            writable
              ? (t) => void model?.createCard(t, { rank: model.appendRank(allCards) })
              : undefined
          }
          onOpenCard={onOpenCard}
          onOpenCardTab={onOpenCardTab}
          onRenameCard={onRenameCard}
          onDeleteCard={onDeleteCard}
          onRevealInFinder={onRevealInFinder}
        />
      ) : (
        <KanbanBoard
          def={def}
          cards={cards}
          model={model}
          groupBy={groupBy}
          groupField={groupField!}
          // An embed's own `hide:` is the narrower statement, made by the page
          // the reader is on, so it wins over the view's.
          hide={hide && hide.length > 0 ? hide : view.hide}
          sort={view.sort}
          show={view.show}
          readOnly={readOnly}
          onDragging={setDragging}
          onHideColumn={
            owns ? (value) => update({ hide: [...view.hide, value] }) : undefined
          }
          onOpenCard={onOpenCard}
          onOpenCardTab={onOpenCardTab}
          onRenameCard={onRenameCard}
          onDeleteCard={onDeleteCard}
          onRevealInFinder={onRevealInFinder}
        />
      )}

      {addMenu && (
        <Popover x={addMenu.x} y={addMenu.y} onClose={() => setAddMenu(null)}>
          <button
            className="dk-popover-item"
            // A board needs a field to put in columns. A table needs none, so
            // it is always on offer — including as the way to look at a store
            // that has nothing to group by yet.
            disabled={groupableFields(def).length === 0}
            title={
              groupableFields(def).length === 0
                ? "Add a select, multi-select or date property first."
                : undefined
            }
            onClick={() => {
              setAddMenu(null);
              void model?.addView("kanban", "Board").then((id) => id && pick(id));
            }}
          >
            New board
          </button>
          <button
            className="dk-popover-item"
            onClick={() => {
              setAddMenu(null);
              void model?.addView("table", "Table").then((id) => id && pick(id));
            }}
          >
            New table
          </button>
          <div className="dk-popover-note">
            A view is a saved way of looking at these cards. It changes nothing
            in any file but <code>store.jsonl</code>.
          </div>
        </Popover>
      )}
      {options && view && def && (
        <ViewOptions
          x={options.x}
          y={options.y}
          def={def}
          view={view}
          groupBy={groupBy}
          renaming={renamingView}
          onRenaming={setRenamingView}
          onUpdate={update}
          onDelete={() => {
            setOptions(null);
            void model?.deleteView(view.id);
            setChosen(null);
            lastView.delete(dir);
          }}
          onExport={
            onExport
              ? () => {
                  setOptions(null);
                  // What the view shows, in the view's order — a board's
                  // columns flatten into one list, which is what a
                  // spreadsheet can hold.
                  const rows = viewCards(def, allCards, view);
                  onExport(csvFileName(def.name || "Store"), storeCsv(rows, fields));
                }
              : undefined
          }
          onClose={() => setOptions(null)}
        />
      )}
    </div>
  );
}

/* ---------- the view's own settings ---------- */

function ViewOptions({
  x,
  y,
  def,
  view,
  groupBy,
  renaming,
  onRenaming,
  onUpdate,
  onDelete,
  onExport,
  onClose,
}: {
  x: number;
  y: number;
  def: StoreDef;
  view: View;
  groupBy: string;
  renaming: boolean;
  onRenaming: (v: boolean) => void;
  onUpdate: (patch: Partial<Omit<View, "id" | "kind">>) => void;
  onDelete: () => void;
  onExport?: () => void;
  onClose: () => void;
}) {
  const groupable = groupableFields(def);
  const shownIds = view.show ?? def.fields.map((f) => f.id);
  const columns = orderedOptions(def, groupBy);
  const declaresColumns =
    fieldOf(def, groupBy)?.type === "select" ||
    fieldOf(def, groupBy)?.type === "multi_select";

  const toggleShow = (id: string) => {
    const next = shownIds.includes(id)
      ? shownIds.filter((f) => f !== id)
      : [...shownIds, id];
    // Everything on is "no opinion", not a list — so a property declared
    // tomorrow shows up instead of being invisible until someone ticks it.
    onUpdate({ show: next.length === def.fields.length ? null : next });
  };

  const setClause = (i: number, patch: Partial<Filter>) =>
    onUpdate({ filter: view.filter.map((f, n) => (n === i ? { ...f, ...patch } : f)) });

  return (
    <Popover x={x} y={y} className="dk-view-panel" onClose={onClose}>
      <div className="dk-view-name">
        {renaming ? (
          <input
            className="dk-prop-name-input"
            aria-label="Rename view"
            defaultValue={view.name}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                const v = (e.target as HTMLInputElement).value.trim();
                if (v) onUpdate({ name: v });
                onRenaming(false);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onRenaming(false);
              }
            }}
            onBlur={() => onRenaming(false)}
          />
        ) : (
          <button className="dk-view-rename" onClick={() => onRenaming(true)}>
            {view.name} <span className="dk-view-kind">{view.kind}</span>
          </button>
        )}
      </div>

      {view.kind === "kanban" && (
        <label className="dk-popover-row">
          Group by
          <select
            aria-label="Group by"
            value={view.groupBy}
            onChange={(e) => onUpdate({ groupBy: e.target.value })}
          >
            {groupable.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="dk-popover-row">
        Sort by
        <select
          aria-label="Sort by"
          value={view.sort?.field ?? ""}
          onChange={(e) =>
            onUpdate({
              sort: e.target.value
                ? { field: e.target.value, dir: view.sort?.dir ?? "asc" }
                : null,
            })
          }
        >
          <option value="">{view.kind === "table" ? "Title" : "Board order"}</option>
          {def.fields.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        {view.sort && (
          <button
            className="dk-view-dir"
            onClick={() =>
              onUpdate({
                sort: { field: view.sort!.field, dir: view.sort!.dir === "asc" ? "desc" : "asc" },
              })
            }
          >
            {view.sort.dir === "asc" ? "ascending" : "descending"}
          </button>
        )}
      </label>

      <div className="dk-view-section">
        <div className="dk-view-section-head">Filter</div>
        {view.filter.map((clause, i) => (
          <div className="dk-view-clause" key={i}>
            <select
              aria-label="Filter property"
              value={clause.field}
              onChange={(e) => setClause(i, { field: e.target.value })}
            >
              {def.fields.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter test"
              value={clause.op}
              onChange={(e) => setClause(i, { op: e.target.value as FilterOp })}
            >
              {FILTER_OPS.map((op) => (
                <option key={op} value={op}>
                  {OP_LABELS[op]}
                </option>
              ))}
            </select>
            {clause.op !== "empty" && clause.op !== "not_empty" && (
              <input
                aria-label="Filter value"
                className="dk-view-value"
                defaultValue={clause.value}
                placeholder="value"
                onBlur={(e) => setClause(i, { value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
              />
            )}
            <button
              className="dk-view-drop"
              aria-label="Remove filter"
              onClick={() => onUpdate({ filter: view.filter.filter((_, n) => n !== i) })}
            >
              ×
            </button>
          </div>
        ))}
        <button
          className="dk-popover-item"
          disabled={def.fields.length === 0}
          onClick={() =>
            onUpdate({
              filter: [
                ...view.filter,
                { field: def.fields[0].id, op: "is" as FilterOp, value: "" },
              ],
            })
          }
        >
          + Add filter
        </button>
      </div>

      <div className="dk-view-section">
        <div className="dk-view-section-head">Properties</div>
        {def.fields.length === 0 && (
          <div className="dk-popover-note">
            This board has no properties yet. Add one from a card’s header.
          </div>
        )}
        {def.fields.map((f) => (
          <label className="dk-view-check" key={f.id}>
            <input
              type="checkbox"
              checked={shownIds.includes(f.id)}
              onChange={() => toggleShow(f.id)}
            />
            {f.name}
          </label>
        ))}
      </div>

      {view.kind === "kanban" && declaresColumns && (
        <div className="dk-view-section">
          <div className="dk-view-section-head">Columns</div>
          {columns.map((o) => (
            <label className="dk-view-check" key={o.name}>
              <input
                type="checkbox"
                checked={!view.hide.includes(o.name)}
                onChange={() =>
                  onUpdate({
                    hide: view.hide.includes(o.name)
                      ? view.hide.filter((h) => h !== o.name)
                      : [...view.hide, o.name],
                  })
                }
              />
              {o.name}
            </label>
          ))}
          <label className="dk-view-check">
            <input
              type="checkbox"
              checked={!view.hide.includes("")}
              onChange={() =>
                onUpdate({
                  hide: view.hide.includes("")
                    ? view.hide.filter((h) => h !== "")
                    : [...view.hide, ""],
                })
              }
            />
            No value
          </label>
        </div>
      )}

      {onExport && (
        <button className="dk-popover-item" onClick={onExport}>
          Export as CSV…
        </button>
      )}
      <button className="dk-popover-item is-danger" onClick={onDelete}>
        Delete this view
      </button>
      <div className="dk-popover-note">
        Deleting a view keeps every card and every column. It forgets only this
        way of looking at them.
      </div>
    </Popover>
  );
}
