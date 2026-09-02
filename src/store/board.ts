// A board, as a pure shape: what a card is, what a column is, which cards
// land in which column, the pills a card's face shows, and the frozen
// picture of all of that which a published page carries.
//
// Nothing here reads a file or touches Tauri. That is the point: the board
// tab, a note's embed, and the snapshot a share push sends all derive their
// columns HERE, so a published board cannot quietly disagree with the board
// it was published from — and the whole derivation can be unit-tested
// without a browser (verify-harness/store.test.mjs).
//
// The live view that fills these shapes from disk is model.ts; the code that
// reads a store to build a snapshot is publish.ts.

import { propText, type Props } from "./frontmatter";
import { parseEmbedConfig } from "./embedConfig";
import { sortByRank } from "./rank";
import {
  fieldOf,
  kanbanView,
  RANK_KEY,
  type Field,
  type Option,
  type OptionColor,
  type StoreDef,
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
};

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

/** Cards of one column, in board order. */
export const columnCards = (cards: Card[], field: string, value: string): Card[] =>
  sortByRank(
    cards.filter((c) => cardValue(c, field) === value),
    cardRank,
    (c) => c.title,
  );

/** A field's options in column order. */
export const orderedOptions = (def: StoreDef, field: string): Option[] =>
  sortByRank(
    def.options.filter((o) => o.field === field),
    (o) => o.rank,
    (o) => o.name,
  );

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
  cards: Card[];
};

/**
 * The columns a board shows, in order: the empty column, the declared
 * options by rank, then any value the cards carry that nothing declares
 * (never silently normalised — see the design's edge cases).
 *
 * `hide` leaves a column out of THIS view; the option stays declared and its
 * cards stay where they are. Nothing is filtered out of the store.
 *
 * Pure, and the ONE derivation: the board tab, a note's embed, and the
 * snapshot a published page carries all read the same columns, so a
 * published board can't disagree with the one it was published from.
 */
export function boardColumns(
  def: StoreDef,
  cards: Card[],
  groupBy: string,
  hide?: string[],
): BoardColumn[] {
  const declared = orderedOptions(def, groupBy);
  const known = new Set(declared.map((o) => o.name));
  const stray = new Set<string>();
  for (const c of cards) {
    const v = cardValue(c, groupBy);
    if (v !== "" && !known.has(v)) stray.add(v);
  }
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
    cards: columnCards(cards, groupBy, key),
  });
  const hidden = new Set(hide ?? []);
  const field = fieldOf(def, groupBy);
  return [
    build("", `No ${(field?.name ?? groupBy).toLowerCase()}`, null, false),
    ...declared.map((o) => build(o.name, o.name, o, true)),
    ...[...stray].sort().map((v) => build(v, v, null, false)),
  ].filter((c) => !hidden.has(c.key));
}

/** One pill on a card's face: a field's value, coloured if an option declares it. */
export type CardChip = { key: string; text: string; color: OptionColor | null };

/** The fields a card face shows chips for: every declared field but the group-by. */
export const chipFieldsOf = (def: StoreDef, groupBy: string | null): Field[] =>
  def.fields.filter((f) => f.id !== groupBy);

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

/* ---------- the frozen picture ---------- */

/** One pill on a published card. */
export type BoardChip = { text: string; color?: OptionColor };

export type BoardCardSnap = {
  title: string;
  chips?: BoardChip[];
  /** The card's own page id, when the card is a member of the same folder share. */
  page?: string;
};

export type BoardColumnSnap = {
  name: string;
  color?: OptionColor;
  cards: BoardCardSnap[];
  /** Cards beyond the cap, counted rather than dropped silently. */
  more?: number;
};

/** One embed's board, as a published page shows it. */
export type BoardSnap = {
  /** The fence's config text, verbatim — how the renderer finds this board. */
  fence: string;
  /** The board's name, for the frame's heading. */
  name: string;
  columns: BoardColumnSnap[];
};

/** One value of one property, coloured when an option declares it. */
export type PagePropValue = { text: string; color?: OptionColor };

/** One row of a published note's properties. */
export type PageProp = { name: string; values: PagePropValue[] };

// A page is a document, not a database export. These caps keep a note that
// embeds a thousand-card board from turning into a megabyte of JSON on
// someone's phone; what they cut is COUNTED, never silently dropped.
const MAX_COLUMNS = 60;
const MAX_CARDS = 200;
const MAX_CHIPS = 12;
const MAX_TEXT = 200;

export const clipText = (s: string) =>
  s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}\u2026` : s;

/**
 * How a fence and its snapshot find each other: the fence's own text, with
 * line endings and trailing whitespace normalized away. The share worker
 * normalizes the same way (share-worker/src/index.js, `fenceKey`) — the two
 * must agree or a published board silently falls back to its code block.
 */
export const fenceKeyOf = (text: string): string =>
  text.replace(/\r\n?/g, "\n").replace(/\s+$/, "");

/**
 * One board's snapshot, from the same derivation the live board renders.
 *
 * Empty columns are kept when an option DECLARES them — a column with
 * nothing in it is part of the board's shape — and dropped otherwise: the
 * "No status" column and a stray value's column exist on the desktop so you
 * can drag into them, and nobody drags on a published page.
 */
export function boardSnapshot(
  fence: string,
  def: StoreDef,
  cards: Card[],
  pageIdFor: (cardPath: string) => string | undefined,
): BoardSnap | null {
  const cfg = parseEmbedConfig(fence);
  const view = kanbanView(def, cfg.view);
  const groupBy = cfg.group ?? view?.groupBy ?? null;
  if (!groupBy) return null;
  const fields = chipFieldsOf(def, groupBy);
  const columns: BoardColumnSnap[] = [];
  for (const col of boardColumns(def, cards, groupBy, cfg.hide)) {
    if (col.cards.length === 0 && !col.declared) continue;
    const shown = col.cards.slice(0, MAX_CARDS);
    columns.push({
      name: clipText(col.label),
      ...(col.color ? { color: col.color } : {}),
      cards: shown.map((card) => {
        const chips = cardChips(card, def, fields)
          .slice(0, MAX_CHIPS)
          .map((c) => ({ text: clipText(c.text), ...(c.color ? { color: c.color } : {}) }));
        const page = pageIdFor(card.path);
        return {
          title: clipText(card.title),
          ...(chips.length > 0 ? { chips } : {}),
          ...(page ? { page } : {}),
        };
      }),
      ...(col.cards.length > shown.length ? { more: col.cards.length - shown.length } : {}),
    });
    if (columns.length >= MAX_COLUMNS) break;
  }
  return { fence, name: def.name, columns };
}
