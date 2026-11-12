// A board, as a pure shape: what a card is, what a column is, which cards
// land in which column, the pills a card's face shows, and the frozen
// picture of all of that which a published page carries.
//
// Nothing here reads a file or touches Tauri. That is the point: the board
// tab, a note's embed, and the picture a published page draws all derive
// their columns HERE, so a published board cannot quietly disagree with the
// board it was published from — and the whole derivation can be unit-tested
// without a browser (verify-harness/store.test.mjs).
//
// The live view that fills these shapes from disk is model.ts; the code that
// reads a synced store to build a snapshot is the cloud worker's pages.ts.

import { propList, propText, type Props } from "./frontmatter";
import { parseEmbedConfig } from "./embedConfig";
import { sortByRank } from "./rank";
import {
  fieldOf,
  resolveView,
  RANK_KEY,
  type Field,
  type FieldType,
  type Filter,
  type Option,
  type OptionColor,
  type Sort,
  type StoreDef,
  type View,
  type ViewKind,
} from "./storeFile";

export type FileSnapshot = { mtime_ms: number; size: number };

export type Card = {
  /** Absolute path of the card's note. */
  path: string;
  /** File name including the extension. */
  name: string;
  /** The card's title — the file name, minus `.md`. */
  title: string;
  snapshot: FileSnapshot;
  props: Props;
  /** Frontmatter lines the dialect couldn't read; carried through writes. */
  opaque: string[];
  /** The first paragraph of the body as plain text (cardExcerpt); "" for none. */
  excerpt: string;
};

/** What a card's file is called: a markdown note, by any of its names. */
export const CARD_EXT_RE = /\.(md|markdown|mdown|mkd)$/i;

/**
 * Strip what a file name can't hold. macOS refuses `/` and `:` — nothing
 * else. A card's title IS its file name, so every place that makes one (the
 * composer, a rename on the board, in a table, or in the peek) runs the name
 * through here and lands on the same bytes.
 */
export const sanitizeTitle = (title: string) =>
  title.replace(/[/:]/g, "-").replace(/\s+/g, " ").trim();

/**
 * Where a card lands when it is retitled: the same folder, the same
 * extension, and a file name the OS will take. "" when the new title is
 * nothing at all. The extension is the card's OWN — a note that arrived as
 * `.markdown` is not quietly turned into an `.md` by being renamed.
 */
export const renamedCardPath = (path: string, title: string): string => {
  const clean = sanitizeTitle(title);
  if (!clean) return "";
  const slash = path.lastIndexOf("/");
  const ext = CARD_EXT_RE.exec(path.slice(slash + 1))?.[0] ?? ".md";
  return `${path.slice(0, slash)}/${clean}${ext}`;
};

/* ---------- a card's excerpt ---------- */

const MAX_EXCERPT = 240;

// Lines that open a block which isn't prose: a heading, a rule, a table row,
// html, or a picture on its own.
const NOT_PROSE_RE =
  /^(#{1,6}(\s|$)|([-*_])(\s*\3){2,}$|\||<|!\[[^\]]*\]\([^)]*\)$)/;
const FENCE_RE = /^(`{3,}|~{3,})/;
// A setext heading's underline turns the paragraph above it into a heading.
const SETEXT_RE = /^(=+|-+)$/;
const LIST_MARK_RE = /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/;

/**
 * A card's excerpt: the first paragraph of its body, as plain text. `lead` is
 * what read_store hands over — the first few hundred bytes after the
 * frontmatter block — so a body that opens with a long code block or table
 * simply has no excerpt.
 *
 * Headings, rules, code, tables and html are skipped on the way to the
 * paragraph; inside it, markdown is reduced to the words a reader sees
 * (links keep their text, a comment marker keeps its anchor). "" when there
 * is nothing to show.
 */
export function cardExcerpt(lead: string): string {
  const para: string[] = [];
  let fence: string | null = null;
  for (const line of lead.replace(/\r\n?/g, "\n").split("\n")) {
    const t = line.trim();
    if (fence) {
      if (t.startsWith(fence)) fence = null;
      continue;
    }
    const open = FENCE_RE.exec(t);
    if (open) {
      if (para.length > 0) break;
      fence = open[1];
      continue;
    }
    if (t === "") {
      if (para.length > 0) break;
      continue;
    }
    if (para.length > 0 && SETEXT_RE.test(t)) {
      para.length = 0;
      continue;
    }
    if (NOT_PROSE_RE.test(t)) {
      if (para.length > 0) break;
      continue;
    }
    para.push(t.replace(/^(>\s?)+/, "").replace(LIST_MARK_RE, ""));
  }
  const text = para
    .join(" ")
    .replace(/\{>>[\s\S]*?<<\}/g, "")
    .replace(/\{==([\s\S]*?)==\}/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[\^[^\]]+\]/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/(`+)(.+?)\1/g, "$2")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?![\w*])/g, "$1$2")
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAX_EXCERPT ? `${text.slice(0, MAX_EXCERPT - 1).trimEnd()}…` : text;
}

/** The value a card carries for a field, as a single string ("" = unset). */
export const cardValue = (card: Card, field: string): string => {
  const v = card.props[field];
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v[0] ?? "";
  return typeof v === "boolean" ? (v ? "true" : "false") : String(v);
};

export const cardRank = (card: Card): string | null => {
  const v = card.props[RANK_KEY];
  return typeof v === "string" ? v : null;
};

/**
 * Every value a card carries for a field. One for most types; a multi_select
 * card carries several, and shows up in a column for EACH of them — the one
 * place a card is in two columns at once.
 */
export const cardValues = (card: Card, field: Field | null, id: string): string[] => {
  if (field?.type === "multi_select") {
    return propList(card.props[id])
      .map((v) => v.trim())
      .filter((v) => v !== "");
  }
  const v = cardValue(card, id).trim();
  return v === "" ? [] : [v];
};

/** Cards of one column, in board order. `value` of "" is the empty column. */
export const columnCards = (
  def: StoreDef,
  cards: Card[],
  groupBy: string,
  value: string,
): Card[] => {
  const field = fieldOf(def, groupBy);
  const held = cards.filter((c) => {
    const values = cardValues(c, field, groupBy);
    return value === "" ? values.length === 0 : values.includes(value);
  });
  return sortByRank(held, cardRank, (c) => c.title);
};

/** A field's options in column order. */
export const orderedOptions = (def: StoreDef, field: string): Option[] =>
  sortByRank(
    def.options.filter((o) => o.field === field),
    (o) => o.rank,
    (o) => o.name,
  );

/* ---------- stages of work ---------- */

/** The column names that mean "finished". */
const DONE_RE = /^(done|complete|completed|finished|shipped|closed|resolved)$/i;

/**
 * Where a column sits in the work. `todo` hasn't started (the first option,
 * and the empty column), `stage` is on the way — `fill` says how far, from
 * its position before the finished column — `done` is finished, and
 * `closed` comes after it (Cancelled, Archived): over, but not done.
 */
export type Stage = { kind: "todo" | "stage" | "done" | "closed"; fill: number };

/** A board that tracks progress: its finished column, and every column's stage. */
export type BoardStages = { done: string; stages: Map<string, Stage> };

/**
 * How a board's columns read as stages of work, or null when they don't.
 *
 * A board grouped by a select with a finished option ("Done", "Shipped"…)
 * tracks progress: that is what puts a status glyph on each column, a check
 * on a finished card, and a progress bar over the board. Any other board —
 * grouped by priority, by a tag, by a date — has no stages, and claims
 * nothing about progress. Nothing is stored for this: the option names
 * already say it, in every tool that reads the files.
 */
export function boardStages(def: StoreDef, groupBy: string): BoardStages | null {
  if (fieldOf(def, groupBy)?.type !== "select") return null;
  const options = orderedOptions(def, groupBy);
  const at = options.findIndex((o) => DONE_RE.test(o.name.trim()));
  if (at < 0) return null;
  const stages = new Map<string, Stage>([["", { kind: "todo", fill: 0 }]]);
  options.forEach((o, i) => {
    stages.set(
      o.name,
      i === at
        ? { kind: "done", fill: 1 }
        : i > at
          ? { kind: "closed", fill: 0 }
          : i === 0
            ? { kind: "todo", fill: 0 }
            : { kind: "stage", fill: i / at },
    );
  });
  return { done: options[at].name, stages };
}

/* ---------- what a board shows ---------- */

/** A column: a declared option, the empty value, or a value nothing declares. */
export type BoardColumn = {
  /** The group-by value this column holds. "" is the "No status" column. */
  key: string;
  label: string;
  color: OptionColor | null;
  option: Option | null;
  /** False for the empty column and for values no option declares. */
  declared: boolean;
  /** Whether "add this as an option" means anything here — only for a
   *  select-ish field, where options are what columns ARE. A date's columns
   *  come from the dates the cards carry; there is nothing to declare. */
  adoptable: boolean;
  cards: Card[];
};

/** How a board's columns are decided: from declared options, or from the data. */
const declaresOptions = (type: FieldType | undefined) =>
  type === "select" || type === "multi_select";

/**
 * The columns a board shows, in order: the empty column, the declared
 * options by rank, then any value the cards carry that nothing declares
 * (never silently normalised — see the design's edge cases).
 *
 * A `multi_select` group-by puts a card in a column for EACH value it
 * carries. A `date` group-by has no options at all: its columns are the dates
 * the cards carry, in order — sorting ISO dates as text IS chronological.
 *
 * `hide` leaves a column out of THIS view; the option stays declared and its
 * cards stay where they are. Nothing is filtered out of the store. `sort`
 * replaces the in-column rank order with the view's own.
 *
 * Pure, and the ONE derivation: the board tab, a note's embed, and the
 * snapshot a published page carries all read the same columns, so a
 * published board can't disagree with the one it was published from.
 */
export function boardColumns(
  def: StoreDef,
  cards: Card[],
  groupBy: string,
  opts: { hide?: string[]; sort?: Sort | null } = {},
): BoardColumn[] {
  const field = fieldOf(def, groupBy);
  const declared = orderedOptions(def, groupBy);
  const known = new Set(declared.map((o) => o.name));
  const stray = new Set<string>();
  for (const c of cards) {
    for (const v of cardValues(c, field, groupBy)) if (!known.has(v)) stray.add(v);
  }
  const order = (list: Card[]) => (opts.sort ? sortCards(def, list, opts.sort) : list);
  const build = (
    key: string,
    label: string,
    option: Option | null,
    isDeclared: boolean,
  ): BoardColumn => ({
    key,
    label,
    color: option?.color ?? null,
    option,
    declared: isDeclared,
    adoptable: !isDeclared && key !== "" && declaresOptions(field?.type),
    cards: order(columnCards(def, cards, groupBy, key)),
  });
  const hidden = new Set(opts.hide ?? []);
  return [
    build("", `No ${(field?.name ?? groupBy).toLowerCase()}`, null, false),
    ...declared.map((o) => build(o.name, o.name, o, true)),
    ...[...stray].sort().map((v) => build(v, v, null, false)),
  ].filter((c) => !hidden.has(c.key));
}

/** One pill on a card's face: a field's value, coloured if an option declares it. */
export type CardChip = { key: string; text: string; color: OptionColor | null };

/**
 * The fields a card face shows chips for: the fields the view shows, minus
 * the one the board groups by (the column already says it).
 */
export const chipFieldsOf = (
  def: StoreDef,
  groupBy: string | null,
  show?: string[] | null,
): Field[] => visibleFields(def, show).filter((f) => f.id !== groupBy);

/**
 * The fields a view shows, in the store's declaration order. `show` of null
 * (a view nobody has narrowed) means every field — a field added later then
 * appears, rather than being invisible until someone ticks it.
 */
export function visibleFields(def: StoreDef, show?: string[] | null): Field[] {
  if (!show) return def.fields;
  const on = new Set(show);
  return def.fields.filter((f) => on.has(f.id));
}

/* ---------- filter and sort ---------- */

/**
 * Whether a card passes one clause. A clause whose value is still empty
 * passes everything: half a filter, typed into the view options, must not
 * blank the board under the person building it.
 */
export function cardPasses(def: StoreDef, card: Card, clause: Filter): boolean {
  const field = fieldOf(def, clause.field);
  const values = cardValues(card, field, clause.field);
  if (clause.op === "empty") return values.length === 0;
  if (clause.op === "not_empty") return values.length > 0;
  const needle = clause.value.trim().toLowerCase();
  if (needle === "") return true;
  const lower = values.map((v) => v.toLowerCase());
  if (clause.op === "is") return lower.includes(needle);
  if (clause.op === "is_not") return !lower.includes(needle);
  return lower.some((v) => v.includes(needle));
}

/** The cards a view keeps. Clauses are ANDed. */
export const applyFilter = (
  def: StoreDef,
  cards: Card[],
  filter: Filter[] | undefined,
): Card[] =>
  !filter || filter.length === 0
    ? cards
    : cards.filter((c) => filter.every((f) => cardPasses(def, c, f)));

const compareText = (a: string, b: string, type: FieldType | undefined): number => {
  if (type === "number") {
    const x = Number(a);
    const y = Number(b);
    if (Number.isFinite(x) && Number.isFinite(y)) return x === y ? 0 : x < y ? -1 : 1;
  }
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
};

/**
 * A view's sort. An EMPTY value always sorts last, in both directions: a card
 * with no due date is not "the earliest" — it is one nobody has dated, and
 * burying it at the end is what a person means either way.
 */
export function sortCards(def: StoreDef, cards: Card[], sort: Sort | null): Card[] {
  if (!sort) return cards;
  const type = fieldOf(def, sort.field)?.type;
  const dir = sort.dir === "desc" ? -1 : 1;
  const byTitle = (a: Card, b: Card) =>
    a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" });
  return [...cards].sort((a, b) => {
    const av = propText(a.props[sort.field]).trim();
    const bv = propText(b.props[sort.field]).trim();
    if (av === "" || bv === "") {
      if (av === bv) return byTitle(a, b);
      return av === "" ? 1 : -1;
    }
    const c = compareText(av, bv, type);
    return c !== 0 ? dir * c : byTitle(a, b);
  });
}

/**
 * The cards a view shows, in its own order: filtered, then sorted by the
 * view's sort or — with none — by title, which is the order a table with no
 * opinion should have. A kanban view re-orders inside each column instead
 * (boardColumns does that), so it passes its own cards through here only for
 * the filter.
 */
export function viewCards(def: StoreDef, cards: Card[], view: View): Card[] {
  const kept = applyFilter(def, cards, view.filter);
  if (view.sort) return sortCards(def, kept, view.sort);
  return [...kept].sort((a, b) =>
    a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" }),
  );
}

/** A card's chips, in field order; a multi_select contributes one per value. */
export function cardChips(card: Card, def: StoreDef, fields: Field[]): CardChip[] {
  const chips: CardChip[] = [];
  for (const f of fields) {
    const raw = card.props[f.id];
    const text = propText(raw);
    if (text === "") continue;
    if (f.type === "multi_select" && Array.isArray(raw)) {
      for (const v of raw) {
        const opt = def.options.find((o) => o.field === f.id && o.name === v);
        chips.push({ key: `${f.id}:${v}`, text: v, color: opt?.color ?? null });
      }
      continue;
    }
    const opt = def.options.find((o) => o.field === f.id && o.name === text);
    chips.push({ key: f.id, text, color: opt?.color ?? null });
  }
  return chips;
}

/**
 * What a card face shows, split the way the face lays it out: the fields the
 * view shows minus the group-by (chipFieldsOf), with dates in the card's foot
 * and everything else as a pill.
 */
export function cardFaceFields(
  def: StoreDef,
  groupBy: string | null,
  show?: string[] | null,
): { pills: Field[]; dates: Field[] } {
  const shown = chipFieldsOf(def, groupBy, show);
  return { pills: shown.filter((f) => f.type !== "date"), dates: shown.filter((f) => f.type === "date") };
}

/* ---------- a card's dates ---------- */

// A date field that reads as a deadline — the one a card's date turns amber
// for when it comes close. Any other date (started, shipped) is just a date.
const DUE_RE = /\b(due|deadline)\b/i;
const SOON_DAYS = 3;
const ISO_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** One date in a card's foot. */
export type CardDate = { key: string; name: string; text: string; soon: boolean };

/**
 * A card's dates, one per date field it has a value for: "Dec 4", with the
 * year only when it isn't this one, and as written when it isn't an ISO day.
 * `soon` marks a deadline within SOON_DAYS of `today` on a card that isn't
 * finished; a finished card's deadline no longer presses. `today` is the
 * caller's, so the board in the app and the board a published page draws
 * read the same dates the same way.
 */
export function cardDates(card: Card, fields: Field[], finished: boolean, today: Date): CardDate[] {
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return fields.flatMap((f) => {
    const raw = propText(card.props[f.id]).trim();
    if (raw === "") return [];
    const m = ISO_DAY_RE.exec(raw);
    if (!m) return [{ key: f.id, name: f.name, text: raw, soon: false }];
    const day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const days = Math.round((day.getTime() - midnight.getTime()) / 86_400_000);
    const text = day.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      ...(day.getFullYear() === midnight.getFullYear() ? {} : { year: "numeric" }),
    });
    const due = DUE_RE.test(f.name) || DUE_RE.test(f.id);
    return [{ key: f.id, name: f.name, text, soon: due && !finished && days <= SOON_DAYS }];
  });
}

/* ---------- the frozen picture ---------- */

/** One pill on a published card. */
export type BoardChip = { text: string; color?: OptionColor };

/** One date in a published card's foot. */
export type BoardDateSnap = { name: string; text: string; soon?: true };

export type BoardCardSnap = {
  title: string;
  /** The card's first paragraph, when the view shows excerpts. */
  excerpt?: string;
  chips?: BoardChip[];
  dates?: BoardDateSnap[];
  /** The card sits in the board's finished column. */
  done?: true;
  /** The card's own public address, when the card is inside a published folder (the worker fills it in). */
  page?: string;
};

export type BoardColumnSnap = {
  name: string;
  color?: OptionColor;
  /** Where the column sits in the work, on a board that tracks progress. */
  stage?: Stage;
  cards: BoardCardSnap[];
  /** Cards beyond the cap, counted rather than dropped silently. */
  more?: number;
};

/** One embed's KANBAN board, as a published page shows it. */
export type KanbanSnap = {
  /** The fence's config text, verbatim — how the renderer finds this board. */
  fence: string;
  /** The board's name, for the frame's heading. */
  name: string;
  /** Absent means kanban — what the only kind used to be, so a page pushed
   *  before tables existed still reads correctly. */
  kind?: "kanban";
  columns: BoardColumnSnap[];
};

/** One cell of a published table: a value, or several for a multi_select. */
export type TableCellSnap = BoardChip[];

export type TableRowSnap = {
  title: string;
  /** The card's own public address, when the card is inside a published folder (the worker fills it in). */
  page?: string;
  /** One per shown field, in the header's order. */
  cells: TableCellSnap[];
};

/** One embed's TABLE, as a published page shows it. */
export type TableSnap = {
  fence: string;
  name: string;
  kind: "table";
  /** The column headings, after the title column. */
  fields: string[];
  rows: TableRowSnap[];
  /** Rows beyond the cap, counted rather than dropped silently. */
  more?: number;
};

/** What one fence in a published note carries. */
export type BoardSnap = KanbanSnap | TableSnap;

/** One value of one property, coloured when an option declares it. */
export type PagePropValue = { text: string; color?: OptionColor };

/** One row of a published note's properties. */
export type PageProp = { name: string; values: PagePropValue[] };

// A page is a document, not a database export. These caps keep a note that
// embeds a thousand-card board from turning into a megabyte of JSON on
// someone's phone; what they cut is COUNTED, never silently dropped.
const MAX_COLUMNS = 60;
const MAX_FIELDS = 24;
const MAX_CARDS = 200;
const MAX_CHIPS = 12;
const MAX_TEXT = 200;

export const clipText = (s: string) =>
  s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}\u2026` : s;

/**
 * How a fence and its snapshot find each other: the fence's own text, with
 * line endings and trailing whitespace normalized away. The cloud worker
 * imports this same function to match a note's fences to the boards it drew
 * (cloud-worker/src/pages.ts, render.ts), so there is one normalization.
 */
export const fenceKeyOf = (text: string): string =>
  text.replace(/\r\n?/g, "\n").replace(/\s+$/, "");

/** Which view a snapshot is of. Absent means kanban, the kind that came first. */
export const snapKind = (snap: BoardSnap): ViewKind =>
  snap.kind === "table" ? "table" : "kanban";

/**
 * The key a fence and its snapshot meet under. The same config in two
 * languages is two different views of the same store, so the language is
 * part of the key — the worker keys with this same function.
 */
export const snapKeyOf = (kind: ViewKind, fence: string): string =>
  `${kind}\u0000${fenceKeyOf(fence)}`;

const snapChips = (chips: CardChip[]): BoardChip[] =>
  chips
    .slice(0, MAX_CHIPS)
    .map((c) => ({ text: clipText(c.text), ...(c.color ? { color: c.color } : {}) }));

/**
 * One fence's snapshot, from the same derivation the live view renders. The
 * KIND comes from the fence's language — a ` ```table ` block publishes a
 * table however the config names its view.
 *
 * Empty columns are kept when an option DECLARES them — a column with
 * nothing in it is part of the board's shape — and dropped otherwise: the
 * "No status" column and a stray value's column exist on the desktop so you
 * can drag into them, and nobody drags on a published page.
 *
 * A card carries what its face in the app shows: its excerpt when the view
 * shows excerpts, its pills, its dates (read against `today`), and — on a
 * board that tracks progress — whether it is finished, with each column's
 * stage beside it.
 */
export function boardSnapshot(
  fence: string,
  kind: ViewKind,
  def: StoreDef,
  cards: Card[],
  pageIdFor: (cardPath: string) => string | undefined,
  today: Date,
): BoardSnap | null {
  const cfg = parseEmbedConfig(fence);
  const view = resolveView(def, kind, cfg.view);
  if (!view) return null;
  const kept = applyFilter(def, cards, view.filter);
  if (kind === "table") return tableSnapshot(fence, def, kept, view, pageIdFor);

  const groupBy = cfg.group ?? view.groupBy;
  if (!groupBy) return null;
  const face = cardFaceFields(def, groupBy, view.show);
  const stages = boardStages(def, groupBy);
  const hide = cfg.hide.length > 0 ? cfg.hide : (view.hide ?? []);
  const columns: BoardColumnSnap[] = [];
  for (const col of boardColumns(def, kept, groupBy, { hide, sort: view.sort ?? null })) {
    if (col.cards.length === 0 && !col.declared) continue;
    const shown = col.cards.slice(0, MAX_CARDS);
    const stage = stages?.stages.get(col.key);
    const finished = stages !== null && col.key === stages.done;
    columns.push({
      name: clipText(col.label),
      ...(col.color ? { color: col.color } : {}),
      ...(stage ? { stage } : {}),
      cards: shown.map((card) => {
        const chips = snapChips(cardChips(card, def, face.pills));
        const dates = cardDates(card, face.dates, finished, today).map((d) => ({
          name: clipText(d.name),
          text: clipText(d.text),
          ...(d.soon ? { soon: true as const } : {}),
        }));
        const page = pageIdFor(card.path);
        return {
          title: clipText(card.title),
          ...(view.excerpt && card.excerpt ? { excerpt: clipText(card.excerpt) } : {}),
          ...(chips.length > 0 ? { chips } : {}),
          ...(dates.length > 0 ? { dates } : {}),
          ...(finished ? { done: true as const } : {}),
          ...(page ? { page } : {}),
        };
      }),
      ...(col.cards.length > shown.length ? { more: col.cards.length - shown.length } : {}),
    });
    if (columns.length >= MAX_COLUMNS) break;
  }
  return { fence, name: def.name, columns };
}

function tableSnapshot(
  fence: string,
  def: StoreDef,
  cards: Card[],
  view: View,
  pageIdFor: (cardPath: string) => string | undefined,
): TableSnap {
  const fields = visibleFields(def, view.show).slice(0, MAX_FIELDS);
  const ordered = view.sort
    ? sortCards(def, cards, view.sort)
    : [...cards].sort((a, b) =>
        a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" }),
      );
  const shown = ordered.slice(0, MAX_CARDS);
  return {
    fence,
    name: def.name,
    kind: "table",
    fields: fields.map((f) => clipText(f.name)),
    rows: shown.map((card) => {
      const page = pageIdFor(card.path);
      return {
        title: clipText(card.title),
        ...(page ? { page } : {}),
        cells: fields.map((f) => snapChips(cardChips(card, def, [f]))),
      };
    }),
    ...(ordered.length > shown.length ? { more: ordered.length - shown.length } : {}),
  };
}
