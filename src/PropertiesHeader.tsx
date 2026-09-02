// A card's properties, above its editor.
//
// The note below is an ordinary Doklin document; this header is the only
// place its frontmatter is shown, and changing a pill writes the frontmatter
// and nothing else — the body's bytes never move (see write_frontmatter in
// store.rs and the frontmatter boundary in App.tsx).
//
// Phase 1 shows the header only for cards — notes inside a datastore. Any
// other note keeps its frontmatter untouched but doesn't display it;
// "properties on any page" is the same header with an *Add property*
// affordance, and is deliberately left for later.

import { useEffect, useRef, useState } from "react";
import type { Props as CardProps, PropValue } from "./store/frontmatter";
import { propList } from "./store/frontmatter";
import type { Field, OptionColor, StoreDef } from "./store/storeFile";

type Props = {
  def: StoreDef;
  props: CardProps;
  /** Lines the dialect couldn't read; reported, never silently dropped. */
  opaqueCount?: number;
  readOnly?: boolean;
  onChange: (key: string, value: PropValue) => void;
};

export default function PropertiesHeader({
  def,
  props,
  opaqueCount = 0,
  readOnly = false,
  onChange,
}: Props) {
  const [open, setOpen] = useState<string | null>(null);
  if (def.fields.length === 0 && opaqueCount === 0) return null;
  return (
    <div className="dk-props">
      {def.fields.map((f) => (
        <div className="dk-prop-row" key={f.id}>
          <div className="dk-prop-label">{f.name}</div>
          <div className="dk-prop-value">
            <PropertyControl
              def={def}
              field={f}
              value={props[f.id] ?? null}
              readOnly={readOnly}
              open={open === f.id}
              onOpen={(v) => setOpen(v ? f.id : null)}
              onChange={(v) => onChange(f.id, v)}
            />
          </div>
        </div>
      ))}
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

function PropertyControl({
  def,
  field,
  value,
  readOnly,
  open,
  onOpen,
  onChange,
}: {
  def: StoreDef;
  field: Field;
  value: PropValue;
  readOnly: boolean;
  open: boolean;
  onOpen: (open: boolean) => void;
  onChange: (v: PropValue) => void;
}) {
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
      className="dk-prop-input"
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
  onClose,
}: {
  options: string[];
  selected: string[];
  multi: boolean;
  colorOf: (name: string) => OptionColor | null;
  onPick: (name: string) => void;
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
    <div className="dk-popover dk-prop-popover" ref={ref}>
      {options.length === 0 && <div className="dk-popover-note">No options yet.</div>}
      {options.map((name) => (
        <button
          key={name}
          className={`dk-popover-item ${selected.includes(name) ? "is-on" : ""}`}
          onClick={() => onPick(name)}
        >
          <span className={`dk-chip dk-color-${colorOf(name) ?? "grey"}`}>{name}</span>
          {selected.includes(name) && <span className="dk-popover-tick">✓</span>}
        </button>
      ))}
      {!multi && selected.length > 0 && (
        <button className="dk-popover-item" onClick={() => onPick(selected[0])}>
          Clear
        </button>
      )}
    </div>
  );
}
