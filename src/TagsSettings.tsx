// Settings' *Tags*: the workspace's tags, each with its values and what they
// mean, *New tag*, and *Edit* on each. New and Edit are TagDialogs.tsx's
// forms, as pages of this card; Cancel and a save come back to the list.
//
// The list is the status's (`CloudStatus.tags`), so a folder that isn't
// connected has none, and the page says so. The host changes it and the
// notes a rename changes (App.tsx), as it does for a note's own dialogs.

import { useState } from "react";
import { EditTagForm, NewTagForm, TagShell, type TagEdit } from "./TagDialogs";
import type { TagDef } from "./tags";

type View = { kind: "list" } | { kind: "new" } | { kind: "edit"; def: TagDef };

export default function TagsSettings({
  list,
  connected,
  canEdit,
  onCreate,
  onEdit,
  onDelete,
  onClose,
}: {
  list: TagDef[];
  /** The folder is a connected workspace's: one that isn't has no tags. */
  connected: boolean;
  /** This person may change the list. */
  canEdit: boolean;
  onCreate: (def: TagDef) => Promise<string | null>;
  /** `saved` is called once the list is, before any note is changed. */
  onEdit: (edit: TagEdit, saved: () => void) => Promise<string | null>;
  onDelete: (name: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const [view, setView] = useState<View>({ kind: "list" });
  const [busy, setBusy] = useState(false);
  // A form left is no longer busy, though a rename's notes are still being
  // changed after it (with a notice of their own).
  const back = () => {
    setBusy(false);
    setView({ kind: "list" });
  };
  const title = view.kind === "new" ? "New tag" : view.kind === "edit" ? `Edit ${view.def.name}` : "Tags";

  return (
    <TagShell title={title} busy={busy} onClose={onClose} testId="tags-settings">
      {!connected ? (
        <p className="cloud-hint" data-testid="tags-not-connected">
          Tags belong to a workspace connected to a domain, where everyone in it sees the same ones. This folder isn’t
          connected: connect it from Cloud… to use tags.
        </p>
      ) : view.kind === "new" ? (
        <NewTagForm
          list={list}
          forNote={false}
          onSubmit={async (def) => {
            const failed = await onCreate(def);
            if (!failed) back();
            return failed;
          }}
          onCancel={back}
          onBusy={setBusy}
        />
      ) : view.kind === "edit" ? (
        <EditTagForm
          key={view.def.name}
          def={view.def}
          list={list}
          onSave={(edit) => onEdit(edit, back)}
          onDelete={async () => {
            const failed = await onDelete(view.def.name);
            if (!failed) back();
            return failed;
          }}
          onCancel={back}
          onBusy={setBusy}
        />
      ) : (
        <>
          <p className="cloud-hint">
            Everyone in the workspace sees the same tags, and a note has one value of each. Agents read what the values
            mean.
          </p>
          {list.length === 0 ? (
            <p className="cloud-hint" data-testid="tags-none">
              No tags yet.
            </p>
          ) : (
            <ul className="tags-page-list">
              {list.map((def) => (
                <li className="tags-page-row" key={def.name} data-testid={`tags-row-${def.name}`}>
                  <div className="tags-page-head">
                    <span className="tags-page-name">{def.name}</span>
                    {canEdit && (
                      <button
                        className="modal-btn"
                        data-testid={`tags-edit-${def.name}`}
                        onClick={() => setView({ kind: "edit", def })}
                      >
                        Edit
                      </button>
                    )}
                  </div>
                  <div className="tags-page-values">
                    {def.values.map((v) => (
                      <span className="tag-chip is-value" key={v}>
                        <span className="tag-chip-value">{v}</span>
                      </span>
                    ))}
                  </div>
                  {def.desc && <p className="tags-page-desc">{def.desc}</p>}
                </li>
              ))}
            </ul>
          )}
          {canEdit && (
            <div className="modal-buttons">
              <button className="modal-btn is-primary" data-testid="tags-new" onClick={() => setView({ kind: "new" })}>
                New tag
              </button>
            </div>
          )}
        </>
      )}
    </TagShell>
  );
}
