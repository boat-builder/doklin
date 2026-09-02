// A note's properties, above its editor.
//
// The note below is an ordinary Doklin document; this header is the only
// place its frontmatter is shown, and changing a pill writes the frontmatter
// and nothing else — the body's bytes never move (see write_frontmatter in
// store.rs and the frontmatter boundary in App.tsx).
//
// Every note gets one, not just a card. A card's rows are the fields its
// board declares, in the board's order, with their types and colours; any
// other note shows the keys its own file carries, as text. Both can grow a
// property — on a card that DECLARES a field on the store (so it appears on
// every card and in every view), on a plain note it just adds a key. A note
// with no properties shows nothing but a quiet "Add property", which only
// surfaces on hover: an empty header must not push every document down the
// page.

import { useEffect, useRef, useState } from "react";
import PropertyControl from "./PropertyControl";
import type { Props as CardProps, PropValue } from "./store/frontmatter";
import {
  RANK_KEY,
  type Field,
  type FieldType,
  type StoreDef,
} from "./store/storeFile";

const FIELD_TYPE_NAMES: { type: FieldType; label: string }[] = [
  { type: "text", label: "Text" },
  { type: "select", label: "Select" },
  { type: "multi_select", label: "Multi-select" },
  { type: "date", label: "Date" },
  { type: "number", label: "Number" },
  { type: "checkbox", label: "Checkbox" },
];

/** A store with no fields — what an ordinary note's rows hang off. */
const LOOSE_DEF: StoreDef = {
  name: "",
  fields: [],
  options: [],
  views: [],
  foreign: [],
};

type Props = {
  /** The board this note is a card of, or null for an ordinary note. */
  def: StoreDef | null;
  props: CardProps;
  /** The frontmatter keys the file carries, in file order. */
  order?: string[];
  /** Lines the dialect couldn't read; reported, never silently dropped. */
  opaqueCount?: number;
  readOnly?: boolean;
  onChange: (key: string, value: PropValue) => void;
  /** Declare a field on the board. Absent when the note isn't a card. */
  onAddField?: (name: string, type: FieldType) => void;
  onRenameField?: (id: string, name: string) => void;
  onRetypeField?: (id: string, type: FieldType) => void;
  onDeleteField?: (id: string) => void;
  /** Declare a value a select field doesn't offer yet. */
  onAddOption?: (fieldId: string, name: string) => void;
};

export default function PropertiesHeader({
  def,
  props,
  order = [],
  opaqueCount = 0,
  readOnly = false,
  onChange,
  onAddField,
  onRenameField,
  onRetypeField,
  onDeleteField,
  onAddOption,
}: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  // Keys added here but not yet given a value. Until one is typed there is
  // nothing to write: an empty property is not a line in someone's file.
  const [pending, setPending] = useState<string[]>([]);

  const declared = def?.fields ?? [];
  const declaredIds = new Set(declared.map((f) => f.id));
  // Keys the store doesn't declare — written by another tool, or by an
  // ordinary note that was never a card. Shown as text, kept verbatim.
  const loose = [...order, ...pending].filter(
    (k, i, all) => k !== RANK_KEY && !declaredIds.has(k) && all.indexOf(k) === i,
  );
  const rows: { field: Field; declared: boolean }[] = [
    ...declared.map((field) => ({ field, declared: true })),
    ...loose.map((k) => ({ field: { id: k, name: k, type: "text" as FieldType }, declared: false })),
  ];

  // Nothing to show and nothing anyone can add: not a header at all.
  if (rows.length === 0 && opaqueCount === 0 && readOnly) return null;

  return (
    <div className={`dk-props ${rows.length === 0 ? "is-empty" : ""}`}>
      {rows.map(({ field, declared: isDeclared }) => (
        <div className="dk-prop-row" key={field.id}>
          {renaming === field.id ? (
            <NameInput
              initial={field.name}
              ariaLabel="Rename property"
              onCommit={(name) => {
                setRenaming(null);
                if (name !== field.name) onRenameField?.(field.id, name);
              }}
              onCancel={() => setRenaming(null)}
            />
          ) : (
            <button
              className="dk-prop-label"
              disabled={readOnly}
              title={isDeclared ? field.name : `${field.name} — not a field of this board`}
              onClick={(e) => {
                if (readOnly) return;
                e.stopPropagation();
                setMenu(menu === field.id ? null : field.id);
              }}
            >
              {field.name}
            </button>
          )}
          <div className="dk-prop-value">
            <PropertyControl
              def={def ?? LOOSE_DEF}
              field={field}
              value={props[field.id] ?? null}
              readOnly={readOnly}
              open={open === field.id}
              onOpen={(v) => setOpen(v ? field.id : null)}
              onChange={(v) => {
                onChange(field.id, v);
                if (v !== null) setPending((p) => p.filter((k) => k !== field.id));
              }}
              onAddOption={
                onAddOption && isDeclared
                  ? (name) => onAddOption(field.id, name)
                  : undefined
              }
            />
          </div>
          {menu === field.id && (
            <FieldMenu
              field={field}
              declared={isDeclared}
              canRename={isDeclared && !!onRenameField}
              canRetype={isDeclared && !!onRetypeField}
              onRename={() => {
                setMenu(null);
                setRenaming(field.id);
              }}
              onRetype={(type) => {
                setMenu(null);
                onRetypeField?.(field.id, type);
              }}
              onRemove={() => {
                setMenu(null);
                setPending((p) => p.filter((k) => k !== field.id));
                if (isDeclared) onDeleteField?.(field.id);
                else onChange(field.id, null);
              }}
              onClose={() => setMenu(null)}
            />
          )}
        </div>
      ))}
      {!readOnly && (
        <div className="dk-prop-add-row">
          {adding ? (
            <AddProperty
              typed={!!onAddField}
              onCommit={(name, type) => {
                setAdding(false);
                const clean = name.trim();
                if (!clean) return;
                if (onAddField) onAddField(clean, type);
                else setPending((p) => (p.includes(clean) ? p : [...p, clean]));
              }}
              onCancel={() => setAdding(false)}
            />
          ) : (
            <button className="dk-prop-add" onClick={() => setAdding(true)}>
              + Add property
            </button>
          )}
        </div>
      )}
      {opaqueCount > 0 && (
        <div className="dk-prop-note">
          {opaqueCount} {opaqueCount === 1 ? "line" : "lines"} of this note’s
          frontmatter use syntax Doklin doesn’t edit. They are kept exactly as they
          are.
        </div>
      )}
    </div>
  );
}

/** A one-line name input: Enter commits, Escape and blur cancel. */
function NameInput({
  initial,
  ariaLabel,
  placeholder,
  onCommit,
  onCancel,
}: {
  initial: string;
  ariaLabel: string;
  placeholder?: string;
  onCommit: (name: string) => void;
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
      className="dk-prop-name-input"
      aria-label={ariaLabel}
      placeholder={placeholder}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const v = value.trim();
          if (v) onCommit(v);
          else onCancel();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={onCancel}
    />
  );
}

/**
 * Name and type for a new property. Two controls, so — unlike the one-line
 * rename above — a blur is not a cancel: moving from the name to the type
 * picker is part of filling this in. Focus leaving the form altogether is.
 */
function AddProperty({
  typed,
  onCommit,
  onCancel,
}: {
  typed: boolean;
  onCommit: (name: string, type: FieldType) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<FieldType>("text");
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const commit = () => {
    const clean = name.trim();
    if (clean) onCommit(clean, type);
    else onCancel();
  };
  return (
    <div
      className="dk-prop-add-form"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onCancel();
      }}
    >
      <input
        ref={ref}
        className="dk-prop-name-input"
        aria-label="New property name"
        placeholder="Property name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      {typed && (
        <select
          className="dk-prop-type"
          aria-label="Property type"
          value={type}
          onChange={(e) => setType(e.target.value as FieldType)}
        >
          {FIELD_TYPE_NAMES.map((t) => (
            <option key={t.type} value={t.type}>
              {t.label}
            </option>
          ))}
        </select>
      )}
      <button className="dk-prop-add-go" onClick={commit}>
        Add
      </button>
    </div>
  );
}

function FieldMenu({
  field,
  declared,
  canRename,
  canRetype,
  onRename,
  onRetype,
  onRemove,
  onClose,
}: {
  field: Field;
  declared: boolean;
  canRename: boolean;
  canRetype: boolean;
  onRename: () => void;
  onRetype: (type: FieldType) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
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
    <div className="dk-popover dk-prop-field-menu" ref={ref}>
      {canRename && (
        <button className="dk-popover-item" onClick={onRename}>
          Rename…
        </button>
      )}
      {canRetype && (
        <label className="dk-popover-row">
          Type
          <select
            className="dk-prop-type"
            aria-label={`Type of ${field.name}`}
            value={field.type}
            onChange={(e) => onRetype(e.target.value as FieldType)}
          >
            {FIELD_TYPE_NAMES.map((t) => (
              <option key={t.type} value={t.type}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <button className="dk-popover-item is-danger" onClick={onRemove}>
        {declared ? "Delete property" : "Remove from this note"}
      </button>
      <div className="dk-popover-note">
        {declared
          ? "Deleting a property leaves every card’s value in its file, untouched."
          : "This key isn’t a field of the board; removing it clears it from this note."}
      </div>
    </div>
  );
}
