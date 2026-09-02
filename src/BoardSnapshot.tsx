// A store's view and a note's properties, rendered from a SNAPSHOT rather
// than from disk — what a published page shows.
//
// The live views (StoreView, and KanbanBoard / TableView under it) read a
// folder through the store model and write files back. A shared page has
// neither: the worker sent a picture of the view along with the markdown
// (src/store/publish.ts), and there is nothing behind it to write to. So this
// is deliberately not StoreView with a flag — it is the same markup and the
// same stylesheet with no model, no drag, no menus and no composer. Editing a board from the web is out of
// scope; the web editor writes the page's own markdown and nothing else.
//
// The worker renders the same two things server-side, in HTML, for visitors
// who get the static reading view (share-worker/src/index.js, "Boards and
// properties"). Two implementations, one appearance — keep them in step.

import type { BoardSnap, KanbanSnap, PageProp, TableSnap } from "./store/board";

/** A published view: a board's columns, or a table's rows. */
export default function BoardSnapshot({ snap }: { snap: BoardSnap }) {
  return snap.kind === "table" ? (
    <TableSnapshot snap={snap} />
  ) : (
    <KanbanSnapshot snap={snap} />
  );
}

/** A published board: columns, cards, chips. Nothing here is interactive. */
function KanbanSnapshot({ snap }: { snap: KanbanSnap }) {
  const total = snap.columns.reduce((n, c) => n + c.cards.length + (c.more ?? 0), 0);
  return (
    <div className="dk-board is-embed is-snapshot">
      <header className="dk-board-head">
        <div className="dk-board-title">{snap.name || "Board"}</div>
        <span className="dk-board-sub">
          {total} {total === 1 ? "card" : "cards"}
        </span>
      </header>
      <div className="dk-board-cols">
        {snap.columns.map((col) => (
          <section className="dk-col" key={col.name}>
            <header className="dk-col-head">
              <span className={`dk-col-dot dk-color-${col.color ?? "grey"}`} aria-hidden />
              <span className="dk-col-name" title={col.name}>
                {col.name}
              </span>
              <span className="dk-col-count">{col.cards.length + (col.more ?? 0)}</span>
            </header>
            <div className="dk-col-list">
              {col.cards.map((card, i) => (
                <article className="dk-card" key={`${card.title}:${i}`}>
                  {/* A card links to its own page exactly when it has one —
                      that is, when the card is a member of the same folder
                      share. Otherwise it is a title, not a dead link. */}
                  {card.page ? (
                    <a className="dk-card-title" href={`/${card.page}`}>
                      {card.title}
                    </a>
                  ) : (
                    <div className="dk-card-title">{card.title}</div>
                  )}
                  {card.chips && card.chips.length > 0 && (
                    <div className="dk-card-chips">
                      {card.chips.map((chip, j) => (
                        <span
                          key={`${chip.text}:${j}`}
                          className={`dk-chip dk-color-${chip.color ?? "grey"}`}
                        >
                          {chip.text}
                        </span>
                      ))}
                    </div>
                  )}
                </article>
              ))}
            </div>
            {/* A div, not a <p>: inside the editor's node view a paragraph
                picks up the document's own paragraph styling. */}
            {col.more ? <div className="dk-col-more">+{col.more} more</div> : null}
          </section>
        ))}
      </div>
    </div>
  );
}

/** A published table: one row per card, one column per field it shows. */
function TableSnapshot({ snap }: { snap: TableSnap }) {
  const total = snap.rows.length + (snap.more ?? 0);
  return (
    <div className="dk-board is-embed is-snapshot">
      <header className="dk-board-head">
        <div className="dk-board-title">{snap.name || "Board"}</div>
        <span className="dk-board-sub">
          {total} {total === 1 ? "card" : "cards"}
        </span>
      </header>
      <div className="dk-table-wrap is-embed is-snapshot">
        <table className="dk-table">
          <thead>
            <tr>
              <th className="dk-th is-title" scope="col">
                Title
              </th>
              {snap.fields.map((name, i) => (
                <th className="dk-th" scope="col" key={`${name}:${i}`}>
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {snap.rows.map((row, i) => (
              <tr className="dk-tr" key={`${row.title}:${i}`}>
                <td className="dk-td is-title">
                  {/* A row links to its own page exactly when it has one —
                      that is, when the card is a member of the same folder
                      share. Otherwise it is a title, not a dead link. */}
                  {row.page ? (
                    <a className="dk-row-title" href={`/${row.page}`}>
                      {row.title}
                    </a>
                  ) : (
                    <span className="dk-row-title">{row.title}</span>
                  )}
                </td>
                {snap.fields.map((_, c) => (
                  <td className="dk-td" key={c}>
                    {(row.cells[c] ?? []).map((chip, j) => (
                      <span
                        key={`${chip.text}:${j}`}
                        className={`dk-chip dk-color-${chip.color ?? "grey"}`}
                      >
                        {chip.text}
                      </span>
                    ))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {snap.more ? <div className="dk-col-more">+{snap.more} more</div> : null}
      </div>
    </div>
  );
}

/**
 * A published document's properties. The desktop's PropertiesHeader is the
 * editable twin of this: it needs the store's definition to know what a
 * field may hold, and a published page has only the values.
 */
export function SnapshotProperties({ rows }: { rows: PageProp[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="dk-props is-snapshot">
      {rows.map((row) => (
        <div className="dk-prop-row" key={row.name}>
          <div className="dk-prop-label">{row.name}</div>
          <div className="dk-prop-value">
            {row.values.map((v, i) => (
              <span
                key={`${v.text}:${i}`}
                className={`dk-chip dk-color-${v.color ?? "grey"}`}
              >
                {v.text}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
