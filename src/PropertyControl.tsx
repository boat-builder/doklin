// One property's control: the pill you click, and the popover it opens.
//
// The same control serves both places a property is edited — the header above
// a note (PropertiesHeader.tsx) and a cell of a table view (TableView.tsx) —
// so a select looks and behaves the same wherever you meet it. It renders the
// value and reports a new one; the caller owns the write.

import { useEffect, useRef, useState } from "react";
import { propList, type PropValue } from "./store/frontmatter";
import type { Field, OptionColor, StoreDef } from "./store/storeFile";

export type PropertyControlProps = {
  /** The store the field belongs to; a plain note passes a synthetic one. */
  def: StoreDef;
  field: Field;
  value: PropValue;
  readOnly?: boolean;
  /** The popover is owned by the caller, so only one is ever open at a time. */
  open: boolean;
  onOpen: (open: boolean) => void;
  onChange: (v: PropValue) => void;
  /** Declare a value the field doesn't offer yet. Absent = no such option. */
  onAddOption?: (name: string) => void;
};

export default function PropertyControl({
  def,
  field,
  value,
  readOnly = false,
  open,
  onOpen,
  onChange,
  onAddOption,
}: PropertyControlProps) {
  const options = def.options.filter((o) => o.field === field.id);
  const colorOf = (name: string): OptionColor | null =>
    options.find((o) => o.name === name)?.color ?? null;

  if (field.type === "checkbox") {
    return (
      <input
        type="checkbox"
        className="dk-prop-check"
        disabled={readOnly}
        checked={value === true}
        onChange={(e) => onChange(e.target.checked ? true : null)}
      />
    );
  }

  if (field.type === "select" || field.type === "multi_select") {
    const many = field.type === "multi_select";
    const selected = propList(value);
    return (
      <div className="dk-prop-select">
        <button
          className="dk-prop-trigger"
          disabled={readOnly}
          onClick={() => onOpen(!open)}
        >
          {selected.length === 0 ? (
            <span className="dk-prop-empty">Empty</span>
          ) : (
            selected.map((s) => (
              <span key={s} className={`dk-chip dk-color-${colorOf(s) ?? "grey"}`}>
                {s}
              </span>
            ))
          )}
        </button>
        {open && !readOnly && (
          <SelectPopover
            options={options.map((o) => o.name)}
            selected={selected}
            multi={many}
            colorOf={colorOf}
            onAddOption={onAddOption}
            onPick={(name) => {
              if (!many) {
                onChange(selected[0] === name ? null : name);
                onOpen(false);
                return;
              }
              const next = selected.includes(name)
                ? selected.filter((s) => s !== name)
                : [...selected, name];
              onChange(next.length ? next : null);
            }}
            onClose={() => onOpen(false)}
          />
        )}
      </div>
    );
  }

  const text =
    value === null || value === undefined
      ? ""
      : Array.isArray(value)
        ? value.join(", ")
        : String(value);
  return (
    <input
      // An empty date input still draws "mm/dd/yyyy"; in a header that is one
      // row, in a table it is a wall of it. `is-blank` quiets an unset one
      // until it is hovered or focused (App.css).
      className={`dk-prop-input ${text === "" ? "is-blank" : ""}`}
      type={field.type === "date" ? "date" : field.type === "number" ? "number" : "text"}
      placeholder="Empty"
      disabled={readOnly}
      defaultValue={text}
      key={text}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          (e.target as HTMLInputElement).value = text;
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );

  function commit(raw: string) {
    const v = raw.trim();
    if (v === text.trim()) return;
    if (v === "") {
      onChange(null);
      return;
    }
    if (field.type === "number") {
      const n = Number(v);
      onChange(Number.isFinite(n) ? n : v);
      return;
    }
    onChange(v);
  }
}

function SelectPopover({
  options,
  selected,
  multi,
  colorOf,
  onPick,
  onAddOption,
  onClose,
}: {
  options: string[];
  selected: string[];
  multi: boolean;
  colorOf: (name: string) => OptionColor | null;
  onPick: (name: string) => void;
  onAddOption?: (name: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [typed, setTyped] = useState("");
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
  const clean = typed.trim();
  const isNew = clean !== "" && !options.some((o) => o.toLowerCase() === clean.toLowerCase());
  const shown = clean === ""
    ? options
    : options.filter((o) => o.toLowerCase().includes(clean.toLowerCase()));
  return (
    <div className="dk-popover dk-prop-popover" ref={ref}>
      {onAddOption && (
        // Typing filters; Enter on something new declares it. A property is
        // most often given a value nobody has written down yet, and making
        // that a trip to the board's column menu would be absurd.
        <input
          className="dk-popover-search"
          aria-label="Find or add an option"
          placeholder={options.length === 0 ? "Add an option" : "Find or add…"}
          value={typed}
          autoFocus
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            if (isNew) {
              onAddOption(clean);
              onPick(clean);
            } else if (shown.length > 0) {
              onPick(shown[0]);
            }
            setTyped("");
          }}
        />
      )}
      {shown.length === 0 && !isNew && (
        <div className="dk-popover-note">No options yet.</div>
      )}
      {shown.map((name) => (
        <button
          key={name}
          className={`dk-popover-item ${selected.includes(name) ? "is-on" : ""}`}
          onClick={() => onPick(name)}
        >
          <span className={`dk-chip dk-color-${colorOf(name) ?? "grey"}`}>{name}</span>
          {selected.includes(name) && <span className="dk-popover-tick">✓</span>}
        </button>
      ))}
      {onAddOption && isNew && (
        <button
          className="dk-popover-item"
          onClick={() => {
            onAddOption(clean);
            onPick(clean);
            setTyped("");
          }}
        >
          Add “{clean}”
        </button>
      )}
      {!multi && selected.length > 0 && (
        <button className="dk-popover-item" onClick={() => onPick(selected[0])}>
          Clear
        </button>
      )}
    </div>
  );
}
