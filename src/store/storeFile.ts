// The store definition file — `store.jsonl`, one per board, inside the
// board's own folder.
//
//   {"doklin":"store","v":1,"name":"Projects"}
//   {"t":"field","id":"status","name":"Status","type":"select"}
//   {"t":"option","field":"status","name":"Backlog","rank":"a0"}
//   {"t":"option","field":"status","name":"Done","rank":"a2","color":"green"}
//   {"t":"view","id":"board","kind":"kanban","name":"Board","groupBy":"status"}
//
// It holds what is not any one card's business: the fields a card may carry,
// the select options that ARE the board's columns (with their order and
// colour), and the saved views. An empty column, a column's colour, and the
// field a board groups by have nowhere else to live.
//
// Same shape and same rules as the entity meta file (metaFile.ts), for the
// same reasons:
//
//   - a HEADER line is what makes a folder a store — not the file name alone
//     (and it gives two otherwise identical fresh boards different bytes,
//     which matters because sync pairs vanished/appeared files by content
//     hash when it detects renames);
//   - ONE record per line, so concurrent edits to different records merge
//     under the sync engine's line-based three-way merge — two people adding
//     a column at the same time merge instead of conflicting;
//   - sorted with a FIXED key order, so equal state serializes to equal bytes
//     on every device;
//   - a TOLERANT parse: malformed lines are skipped, the first of a duplicate
//     wins, and records this version doesn't understand survive a rewrite.
//
// Options are sorted by (field, name) rather than by rank on purpose: a line
// then keeps its identity when a column MOVES, so reordering columns is an
// in-place one-line edit rather than a reshuffle of the whole file.

export const STORE_FILE = "store.jsonl";
const HEADER_MARK = "store";
const HEADER_VERSION = 1;

export type FieldType =
  | "select"
  | "multi_select"
  | "text"
  | "number"
  | "date"
  | "checkbox";

const FIELD_TYPES: FieldType[] = [
  "select",
  "multi_select",
  "text",
  "number",
  "date",
  "checkbox",
];

// The named palette. Colours live as names, never raw hex, so every theme can
// render its own version of "blue" (see App.css).
export const OPTION_COLORS = [
  "grey",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
] as const;
export type OptionColor = (typeof OPTION_COLORS)[number];

export type Field = { id: string; name: string; type: FieldType };
export type Option = { field: string; name: string; rank: string; color?: OptionColor };
/** A saved way of showing a store. One fenced language per kind. */
export type ViewKind = "kanban" | "table";
export const VIEW_KINDS: ViewKind[] = ["kanban", "table"];

/**
 * One clause of a view's filter. Clauses are ANDed: a card shows when it
 * passes all of them.
 *
 * `has` is deliberately one op rather than two: on a multi_select it means
 * the list carries the value, on anything else it means the text contains it.
 * A person filtering a board thinks "cards with `bug` in them" either way.
 */
export type FilterOp = "is" | "is_not" | "has" | "empty" | "not_empty";
export const FILTER_OPS: FilterOp[] = ["is", "is_not", "has", "empty", "not_empty"];
export type Filter = { field: string; op: FilterOp; value: string };

export type SortDir = "asc" | "desc";
export type Sort = { field: string; dir: SortDir };

export type View = {
  id: string;
  kind: ViewKind;
  name: string;
  /** The field a kanban view's columns come from. "" for a table. */
  groupBy: string;
  /** Clauses every card must pass; empty means "every card". */
  filter: Filter[];
  /** null = the view's own order — rank inside a column, title in a table. */
  sort: Sort | null;
  /** The fields this view shows; null = every declared field. */
  show: string[] | null;
  /** Column values a kanban view leaves out. The cards stay where they are. */
  hide: string[];
  /**
   * Whether a kanban card shows its excerpt. On unless the record says
   * `"excerpt": false` — the only value ever written, because a build that
   * predates the switch rewrites a view from the keys it knows, and dropping
   * the key must land on the default rather than on "off".
   */
  excerpt: boolean;
};

/** A view with nothing set — what every constructor starts from. */
export const newView = (
  id: string,
  kind: ViewKind,
  name: string,
  groupBy: string,
): View => ({
  id,
  kind,
  name,
  groupBy,
  filter: [],
  sort: null,
  show: null,
  hide: [],
  excerpt: true,
});

// A record this app version doesn't understand, carried through rewrites.
export type ForeignRecord = { t: string; sortKey: string; raw: string };

export type StoreDef = {
  name: string;
  fields: Field[];
  options: Option[];
  views: View[];
  foreign: ForeignRecord[];
};

/** The path of a folder's definition file. */
export const storeFileOf = (dir: string) => `${dir}/${STORE_FILE}`;

/** A store.jsonl conflict copy: `store (conflict — Alice, Sep 2 14.32).jsonl`. */
export const isStoreConflictName = (name: string) =>
  /^store \(conflict[^/]*\)\.jsonl$/i.test(name);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** A JSON array of non-empty strings; anything else is nothing at all. */
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : [];

// A view's optional parts. Each reads tolerantly and falls back to "not set"
// rather than dropping the view: a filter written by a newer version, or torn
// by a bad merge, must not cost someone their board.
const parseFilter = (v: unknown): Filter[] => {
  if (!Array.isArray(v)) return [];
  const out: Filter[] = [];
  for (const raw of v) {
    if (!isRecord(raw)) continue;
    const field = str(raw.f);
    const op = str(raw.op);
    if (!field || !op || !FILTER_OPS.includes(op as FilterOp)) continue;
    out.push({ field, op: op as FilterOp, value: typeof raw.v === "string" ? raw.v : "" });
  }
  return out;
};

const parseSort = (v: unknown): Sort | null => {
  if (!isRecord(v)) return null;
  const field = str(v.f);
  if (!field) return null;
  return { field, dir: str(v.dir) === "desc" ? "desc" : "asc" };
};

/**
 * Parse a definition file. Returns null when the header line is missing — the
 * folder is then an ordinary folder, whatever the file is called.
 */
export function parseStoreDef(text: string): StoreDef | null {
  const lines = text.split("\n");
  let header: Record<string, unknown> | null = null;
  let start = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed) && parsed.doklin === HEADER_MARK) header = parsed;
    } catch {
      // not the header; a definition file always leads with it
    }
    start = i + 1;
    break;
  }
  if (!header) return null;

  const def: StoreDef = {
    name: str(header.name) ?? "",
    fields: [],
    options: [],
    views: [],
    foreign: [],
  };
  const fieldIds = new Set<string>();
  const optionKeys = new Set<string>();
  const viewIds = new Set<string>();

  for (let i = start; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (raw === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // a torn line from a bad merge: skipped, not fatal
    }
    if (!isRecord(parsed)) continue;
    const t = str(parsed.t);
    if (t === "field") {
      const id = str(parsed.id);
      const type = str(parsed.type);
      if (!id || fieldIds.has(id)) continue;
      if (!type || !FIELD_TYPES.includes(type as FieldType)) continue;
      fieldIds.add(id);
      def.fields.push({ id, name: str(parsed.name) ?? id, type: type as FieldType });
      continue;
    }
    if (t === "option") {
      const field = str(parsed.field);
      const name = str(parsed.name);
      if (!field || !name) continue;
      const key = `${field}\u0000${name}`;
      if (optionKeys.has(key)) continue;
      optionKeys.add(key);
      const color = str(parsed.color);
      def.options.push({
        field,
        name,
        rank: str(parsed.rank) ?? "",
        ...(color && (OPTION_COLORS as readonly string[]).includes(color)
          ? { color: color as OptionColor }
          : {}),
      });
      continue;
    }
    if (t === "view") {
      const id = str(parsed.id);
      const kind = str(parsed.kind);
      if (!id || viewIds.has(id)) continue;
      if (!kind || !VIEW_KINDS.includes(kind as ViewKind)) continue;
      const groupBy = str(parsed.groupBy) ?? "";
      // A kanban view with no field to group by is not a view of anything.
      if (kind === "kanban" && !groupBy) continue;
      viewIds.add(id);
      def.views.push({
        id,
        kind: kind as ViewKind,
        name: str(parsed.name) ?? id,
        groupBy,
        filter: parseFilter(parsed.filter),
        sort: parseSort(parsed.sort),
        show: Array.isArray(parsed.show) ? strList(parsed.show) : null,
        hide: strList(parsed.hide),
        excerpt: parsed.excerpt !== false,
      });
      continue;
    }
    if (t) def.foreign.push({ t, sortKey: str(parsed.id) ?? "", raw });
  }
  return def;
}

const jsonLine = (obj: Record<string, unknown>) => JSON.stringify(obj);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The canonical bytes for a definition. Equal state produces an equal file. */
export function serializeStoreDef(def: StoreDef): string {
  const out: string[] = [
    jsonLine({ doklin: HEADER_MARK, v: HEADER_VERSION, name: def.name }),
  ];
  for (const f of [...def.fields].sort((a, b) => cmp(a.id, b.id))) {
    out.push(jsonLine({ t: "field", id: f.id, name: f.name, type: f.type }));
  }
  for (const o of [...def.options].sort(
    (a, b) => cmp(a.field, b.field) || cmp(a.name, b.name),
  )) {
    out.push(
      jsonLine({
        t: "option",
        field: o.field,
        name: o.name,
        rank: o.rank,
        ...(o.color ? { color: o.color } : {}),
      }),
    );
  }
  for (const v of [...def.views].sort((a, b) => cmp(a.id, b.id))) {
    // Only what the view actually carries is written, so a view nobody has
    // filtered or sorted keeps the bytes it has always had.
    out.push(
      jsonLine({
        t: "view",
        id: v.id,
        kind: v.kind,
        name: v.name,
        groupBy: v.groupBy,
        ...(v.filter.length > 0
          ? { filter: v.filter.map((f) => ({ f: f.field, op: f.op, v: f.value })) }
          : {}),
        ...(v.sort ? { sort: { f: v.sort.field, dir: v.sort.dir } } : {}),
        ...(v.show ? { show: v.show } : {}),
        ...(v.hide.length > 0 ? { hide: v.hide } : {}),
        ...(v.excerpt ? {} : { excerpt: false }),
      }),
    );
  }
  for (const f of [...def.foreign].sort(
    (a, b) => cmp(a.t, b.t) || cmp(a.sortKey, b.sortKey) || cmp(a.raw, b.raw),
  )) {
    out.push(f.raw);
  }
  return out.join("\n") + "\n";
}

/** The definition a brand-new board starts with: one Status column set. */
export function defaultStoreDef(name: string): StoreDef {
  return {
    name,
    fields: [{ id: "status", name: "Status", type: "select" }],
    options: [
      { field: "status", name: "Backlog", rank: "a0", color: "grey" },
      { field: "status", name: "In progress", rank: "a1", color: "blue" },
      { field: "status", name: "Done", rank: "a2", color: "green" },
    ],
    views: [newView("board", "kanban", "Board", "status")],
    foreign: [],
  };
}

export const fieldOf = (def: StoreDef, id: string) =>
  def.fields.find((f) => f.id === id) ?? null;

/** The field types a kanban view can put in columns. */
export const GROUPABLE_TYPES: FieldType[] = ["select", "multi_select", "date"];

/** The fields a board could group by, in declaration order. */
export const groupableFields = (def: StoreDef) =>
  def.fields.filter((f) => GROUPABLE_TYPES.includes(f.type));

/**
 * The view to show: the one asked for by id, else the first saved view of
 * that kind, else a synthetic one — a store whose definition lost its view
 * record still opens, and a ` ```table ` fence works before anyone has saved
 * a table view.
 *
 * The KIND comes from the fence's language, not from the config, so a
 * ` ```table ` naming a kanban view still shows a table: the language is
 * what every other markdown tool sees, and it has to be the truth.
 */
export function resolveView(
  def: StoreDef,
  kind: ViewKind,
  id?: string | null,
): View | null {
  if (id) {
    const named = def.views.find((v) => v.id === id && v.kind === kind);
    if (named) return named;
  }
  // A saved view of the right kind always wins, even one whose group-by field
  // has since been deleted: it IS the view, and the honest answer is to show
  // it and say what it is missing — not to quietly show a different one.
  const first = def.views.find((v) => v.kind === kind);
  if (first) return first;
  // Nothing saved: a synthetic view, so a store whose definition lost its
  // view record still opens and a ` ```table ` fence works before anyone has
  // saved a table view. Its id avoids every saved one, so editing it saves a
  // NEW view instead of overwriting somebody else's.
  if (kind === "table") return newView(freeViewId(def, "table"), "table", "Table", "");
  const groupable =
    groupableFields(def).find((f) => f.type === "select") ?? groupableFields(def)[0];
  if (!groupable) return null;
  return newView(freeViewId(def, "board"), "kanban", "Board", groupable.id);
}

/** `base`, or `base_2`, `base_3`… — the first id no saved view is using. */
function freeViewId(def: StoreDef, base: string): string {
  const taken = new Set(def.views.map((v) => v.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}_${n}`;
    if (!taken.has(id)) return id;
  }
}

/** The key order a card's frontmatter is written in: fields, then `rank`. */
export const RANK_KEY = "rank";
export const cardKeyOrder = (def: StoreDef) => [...def.fields.map((f) => f.id), RANK_KEY];

/**
 * An id for a name: lowercase, words joined by underscores, unique among
 * `taken`. Field ids become frontmatter keys, so the alphabet is deliberately
 * narrower than the dialect accepts — a key nobody has to quote.
 */
export function slugId(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "field";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
  return id;
}

/** The id a new field gets: its frontmatter key, slugged once and never
 *  changed. `rank` is taken from the start — it is where a card sits. */
export const newFieldId = (def: StoreDef, name: string): string =>
  slugId(name, new Set([...def.fields.map((f) => f.id), RANK_KEY]));
