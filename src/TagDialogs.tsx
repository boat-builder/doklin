// The forms a tag is made and changed in. *New tag* asks for a name, the
// values one per line, what they mean, and (from a note) which value the
// note gets. *Edit* renames the tag, renames, adds, removes and reorders its
// values (drag a value's handle, or ⌥↑ ⌥↓ in its field), says what they
// mean, and deletes the tag. From a note's tags each is a dialog of its own
// (`NewTagDialog`, `EditTagDialog`); in Settings' *Tags* each is a page of
// that one (TagsSettings.tsx).
//
// The forms only ask, and say what's wrong with a tag as src/tags.ts does.
// The host changes the list (and the notes a rename changes), and answers
// with a sentence when it couldn't.

import { useEffect, useMemo, useRef, useState } from "react";
import { useDismiss } from "./dismiss";
import { TAGS_MAX, tagProblem, type TagDef } from "./tags";

/** What *Edit* saves: the tag that was `from`, now `def`, with the values
 *  renamed old → new. */
export type TagEdit = { from: string; def: TagDef; renames: [string, string][] };

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
      <line x1="5" y1="5" x2="19" y2="19" />
      <line x1="19" y1="5" x2="5" y2="19" />
    </svg>
  );
}

/** A tag as the form holds it: trimmed, and what its values mean left out
 *  when nothing is written there. */
function typed(name: string, values: string[], desc: string): TagDef {
  const meaning = desc.trim();
  return { name: name.trim(), values, ...(meaning ? { desc: meaning } : {}) };
}

/** A form's busy state, told to the card it is in: nothing closes while the
 *  list is being changed. */
function useBusy(onBusy?: (busy: boolean) => void): [boolean, (busy: boolean) => void] {
  const [busy, setBusy] = useState(false);
  return [
    busy,
    (b: boolean) => {
      setBusy(b);
      onBusy?.(b);
    },
  ];
}

function DescField({ value, busy, onChange, testId }: { value: string; busy: boolean; onChange: (v: string) => void; testId: string }) {
  return (
    <div className="modal-field">
      <div className="modal-field-label">What the values mean</div>
      <textarea
        className="modal-field-input tag-values-text"
        data-testid={testId}
        value={value}
        placeholder={"Todo: nobody has started. Doing: somebody is on it. Done: finished."}
        rows={3}
        disabled={busy}
        onChange={(e) => onChange(e.target.value)}
      />
      <p className="cloud-hint">People see it here, and agents read it with the tags.</p>
    </div>
  );
}

/** The card a tag's form is in: a dialog of its own, or Settings' *Tags*. */
export function TagShell({
  title,
  busy,
  onClose,
  testId,
  children,
}: {
  title: string;
  busy: boolean;
  onClose: () => void;
  testId: string;
  children: React.ReactNode;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  // Nothing closes while the list is being changed.
  useDismiss(() => {
    if (!busy) onClose();
  }, cardRef);
  return (
    <div className="modal-overlay">
      <div ref={cardRef} className="modal cloud-modal tag-dialog" role="dialog" aria-modal="true" aria-label={title} data-testid={testId}>
        <div className="modal-header">
          <div className="modal-title">{title}</div>
          <button className="modal-close" onClick={onClose} aria-label="Close" disabled={busy}>
            <CloseIcon />
          </button>
        </div>
        <div className="cloud-body">{children}</div>
      </div>
    </div>
  );
}

/** *Show as Board…*: which tag the folder's columns are. With no tags yet,
 *  *New tag…* makes one, and the board is grouped by it. */
export function ShowAsBoardDialog({
  folder,
  list,
  onPick,
  onNewTag,
  onClose,
}: {
  folder: string;
  list: TagDef[];
  onPick: (tag: string) => Promise<string | null>;
  onNewTag: () => void;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pick = async (tag: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const failed = await onPick(tag);
    setBusy(false);
    if (failed) setError(failed);
  };
  return (
    <TagShell title="Show as Board" busy={busy} onClose={onClose} testId="board-show-dialog">
      <p className="cloud-hint">
        {list.length === 0
          ? `A board's columns are a tag's values. Make a tag, and ${folder} shows its notes by it.`
          : `Its columns are the values of the tag you pick, and each note in ${folder} sits in the column of its value. Everyone who can open the folder sees the board.`}
      </p>
      {list.length > 0 && (
        <ul className="board-tag-picks">
          {list.map((def) => (
            <li key={def.name}>
              <button className="board-tag-pick" data-testid="board-tag-pick" onClick={() => void pick(def.name)} disabled={busy}>
                <span className="board-tag-pick-name">{def.name}</span>
                <span className="board-tag-pick-values">{def.values.join(", ")}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <div className="modal-error">{error}</div>}
      <div className="modal-buttons">
        <button className="modal-btn" onClick={onNewTag} disabled={busy} data-testid="board-new-tag">
          New tag…
        </button>
        <button className="modal-btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
      </div>
    </TagShell>
  );
}

export function NewTagForm({
  list,
  forNote,
  onSubmit,
  onCancel,
  onBusy,
}: {
  list: TagDef[];
  /** Made from a note's *+ Tag*: the note gets one of the values. */
  forNote: boolean;
  onSubmit: (def: TagDef, value: string | null) => Promise<string | null>;
  onCancel: () => void;
  onBusy?: (busy: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [valuesText, setValuesText] = useState("");
  const [desc, setDesc] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useBusy(onBusy);
  const values = useMemo(
    () => valuesText.split("\n").map((v) => v.trim()).filter((v) => v !== ""),
    [valuesText],
  );
  const def = typed(name, values, desc);
  const problem = tagProblem(def, list) ?? (list.length >= TAGS_MAX ? `A workspace can have ${TAGS_MAX} tags at most.` : null);
  // The note gets the first value until another is picked.
  const gets = chosen !== null && values.includes(chosen) ? chosen : (values[0] ?? null);

  const submit = async () => {
    setTried(true);
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    const failed = await onSubmit(def, forNote ? gets : null);
    setBusy(false);
    if (failed) setError(failed);
  };

  return (
    <>
      <p className="cloud-hint">
        A tag is a name and the values a note can have, one at a time. Everyone in the workspace sees the same tags.
      </p>
      <div className="modal-field">
        <div className="modal-field-label">Name</div>
        <input
          className="modal-field-input"
          data-testid="tag-new-name"
          value={name}
          placeholder="Status"
          spellCheck={false}
          autoFocus
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="modal-field">
        <div className="modal-field-label">Values, one per line</div>
        <textarea
          className="modal-field-input tag-values-text"
          data-testid="tag-new-values"
          value={valuesText}
          placeholder={"Todo\nDoing\nDone"}
          rows={4}
          spellCheck={false}
          disabled={busy}
          onChange={(e) => setValuesText(e.target.value)}
        />
      </div>
      <DescField value={desc} busy={busy} onChange={setDesc} testId="tag-new-desc" />
      {forNote && values.length > 0 && (
        <div className="modal-field">
          <div className="modal-field-label">This note gets</div>
          <select
            className="modal-field-input"
            data-testid="tag-new-gets"
            value={gets ?? ""}
            disabled={busy}
            onChange={(e) => setChosen(e.target.value)}
          >
            {values.map((v, i) => (
              <option key={`${i}:${v}`} value={v}>
                {v}
              </option>
            ))}
          </select>
        </div>
      )}
      {((tried && problem) || error) && <div className="modal-error">{error ?? problem}</div>}
      <div className="modal-buttons">
        <button className="modal-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="modal-btn is-primary" data-testid="tag-new-create" onClick={() => void submit()} disabled={busy}>
          {busy ? "Making it…" : "Create"}
        </button>
      </div>
    </>
  );
}

export function NewTagDialog({
  list,
  forNote,
  onSubmit,
  onClose,
}: {
  list: TagDef[];
  forNote: boolean;
  onSubmit: (def: TagDef, value: string | null) => Promise<string | null>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <TagShell title="New tag" busy={busy} onClose={onClose} testId="tag-new-dialog">
      <NewTagForm list={list} forNote={forNote} onSubmit={onSubmit} onCancel={onClose} onBusy={setBusy} />
    </TagShell>
  );
}

type Row = { key: number; from: string | null; value: string };

export function EditTagForm({
  def,
  list,
  onSave,
  onDelete,
  onCancel,
  onBusy,
}: {
  def: TagDef;
  list: TagDef[];
  onSave: (edit: TagEdit) => Promise<string | null>;
  onDelete: () => Promise<string | null>;
  onCancel: () => void;
  onBusy?: (busy: boolean) => void;
}) {
  const [name, setName] = useState(def.name);
  const seq = useRef(0);
  const [rows, setRows] = useState<Row[]>(() => def.values.map((v) => ({ key: seq.current++, from: v, value: v })));
  const [adding, setAdding] = useState("");
  const [desc, setDesc] = useState(def.desc ?? "");
  const [deleting, setDeleting] = useState(false);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useBusy(onBusy);
  const listRef = useRef<HTMLUListElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);

  const values = rows.map((r) => r.value.trim());
  const next = typed(name, values, desc);
  const problem = tagProblem(next, list, def.name);
  const renames = rows
    .filter((r) => r.from !== null && r.from !== r.value.trim())
    .map((r): [string, string] => [r.from!, r.value.trim()]);
  const renamedTag = name.trim() !== def.name;
  const removed = def.values.filter((v) => !rows.some((r) => r.from === v));

  const move = (key: number, by: number) =>
    setRows((rs) => {
      const at = rs.findIndex((r) => r.key === key);
      const to = at + by;
      if (at === -1 || to < 0 || to >= rs.length) return rs;
      const next = [...rs];
      const [row] = next.splice(at, 1);
      next.splice(to, 0, row);
      return next;
    });

  // A value's handle drags it: the row moves to wherever the pointer is.
  useEffect(() => {
    if (dragging === null) return;
    const onMove = (e: PointerEvent) => {
      const items = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-row]") ?? [])];
      const over = items.findIndex((el) => {
        const r = el.getBoundingClientRect();
        return e.clientY < r.top + r.height / 2;
      });
      // Before which row it goes, as the rows stand now.
      const before = over === -1 ? items.length : over;
      setRows((rs) => {
        const at = rs.findIndex((r) => r.key === dragging);
        const dest = before > at ? before - 1 : before;
        if (at === -1 || dest === at || dest < 0) return rs;
        const next = [...rs];
        const [row] = next.splice(at, 1);
        next.splice(dest, 0, row);
        return next;
      });
    };
    const onUp = () => setDragging(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [dragging]);

  const add = () => {
    const v = adding.trim();
    if (!v) return;
    setRows((rs) => [...rs, { key: seq.current++, from: null, value: v }]);
    setAdding("");
  };

  const save = async () => {
    setTried(true);
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    const failed = await onSave({ from: def.name, def: next, renames });
    setBusy(false);
    if (failed) setError(failed);
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    const failed = await onDelete();
    setBusy(false);
    if (failed) setError(failed);
  };

  return (
    <>
      <div className="modal-field">
        <div className="modal-field-label">Name</div>
        <input
          className="modal-field-input"
          data-testid="tag-edit-name"
          value={name}
          spellCheck={false}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="modal-field">
        <div className="modal-field-label">Values</div>
        <ul className="tag-values" ref={listRef}>
          {rows.map((r, i) => (
            <li key={r.key} data-row className={`tag-value-row ${dragging === r.key ? "is-dragging" : ""}`}>
              <span
                className="tag-value-grip"
                aria-hidden
                onPointerDown={(e) => {
                  e.preventDefault();
                  setDragging(r.key);
                }}
              >
                <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
                  <circle cx="3" cy="3" r="1.2" />
                  <circle cx="7" cy="3" r="1.2" />
                  <circle cx="3" cy="7" r="1.2" />
                  <circle cx="7" cy="7" r="1.2" />
                  <circle cx="3" cy="11" r="1.2" />
                  <circle cx="7" cy="11" r="1.2" />
                </svg>
              </span>
              <input
                className="modal-field-input"
                data-testid={`tag-edit-value-${i}`}
                aria-label={`Value ${i + 1}`}
                value={r.value}
                spellCheck={false}
                disabled={busy}
                onChange={(e) => {
                  const value = e.target.value;
                  setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, value } : x)));
                }}
                onKeyDown={(e) => {
                  if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
                    e.preventDefault();
                    move(r.key, e.key === "ArrowUp" ? -1 : 1);
                  }
                }}
              />
              <button
                className="tag-value-remove"
                aria-label={`Remove ${r.value || "this value"}`}
                data-testid={`tag-edit-remove-${i}`}
                disabled={busy}
                onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
              >
                <CloseIcon />
              </button>
            </li>
          ))}
        </ul>
        <input
          className="modal-field-input"
          data-testid="tag-edit-add"
          value={adding}
          placeholder="Add a value"
          spellCheck={false}
          disabled={busy}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          onBlur={add}
        />
      </div>
      <DescField value={desc} busy={busy} onChange={setDesc} testId="tag-edit-desc" />
      {(renames.length > 0 || renamedTag) && (
        <p className="cloud-hint" data-testid="tag-edit-effect">
          Every note you can open with {renamedTag ? `a ${def.name} tag` : renames.map(([o]) => o).join(" or ")} is
          changed to match.
        </p>
      )}
      {removed.length > 0 && (
        <p className="cloud-hint">
          Notes that have {removed.join(" or ")} keep it, shown as a value that isn't one of {name.trim() || def.name}’s.
        </p>
      )}
      {((tried && problem) || error) && <div className="modal-error">{error ?? problem}</div>}
      {deleting ? (
        <div className="tag-delete-confirm">
          <p className="cloud-hint">
            {def.name} leaves the list. Notes keep their {def.name} line, which becomes plain frontmatter.
          </p>
          <div className="modal-buttons">
            <button className="modal-btn" onClick={() => setDeleting(false)} disabled={busy}>
              Keep it
            </button>
            <button className="modal-btn is-danger-solid" data-testid="tag-edit-delete-confirm" onClick={() => void remove()} disabled={busy}>
              Delete {def.name}
            </button>
          </div>
        </div>
      ) : (
        <div className="modal-buttons tag-edit-buttons">
          <button className="modal-btn is-danger-outline" data-testid="tag-edit-delete" onClick={() => setDeleting(true)} disabled={busy}>
            Delete tag
          </button>
          <span className="tag-edit-gap" />
          <button className="modal-btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="modal-btn is-primary" data-testid="tag-edit-save" onClick={() => void save()} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      )}
    </>
  );
}

export function EditTagDialog({
  def,
  list,
  onSave,
  onDelete,
  onClose,
}: {
  def: TagDef;
  list: TagDef[];
  onSave: (edit: TagEdit) => Promise<string | null>;
  onDelete: () => Promise<string | null>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <TagShell title={`Edit ${def.name}`} busy={busy} onClose={onClose} testId="tag-edit-dialog">
      <EditTagForm def={def} list={list} onSave={onSave} onDelete={onDelete} onCancel={onClose} onBusy={setBusy} />
    </TagShell>
  );
}
