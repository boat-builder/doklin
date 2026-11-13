// Boards, for an agent (docs/cloud.md §8.4, Boards).
//
//   read   GET    /api/agent/board?path=                     its name, fields and options, how many cards
//          GET    /api/agent/cards?path=&by=&where=…         every card, in columns
//          GET    /api/agent/card?path=&card=                one card: its properties and its page
//   edit   POST   /api/agent/board    {path, name?, dryRun?}                         a new board
//          POST   /api/agent/card     {path, title, set?, first?, page?, dryRun?}    a new card
//          PATCH  /api/agent/card     {path, card, set?, title?, <place>, dryRun?}   change one
//          DELETE /api/agent/card?path=&card=[&dry=1]
//          POST   /api/agent/field    {path, name, type, options?, dryRun?}
//          PATCH  /api/agent/field    {path, field, name, dryRun?}
//          DELETE /api/agent/field?path=&field=[&dry=1]
//          POST   /api/agent/option   {path, field, name, color?, <place>, dryRun?}
//          PATCH  /api/agent/option   {path, field, option, name?, color?, <place>, dryRun?}
//          DELETE /api/agent/option?path=&field=&option=[&dry=1]
//
//   <place> is one of `first: true`, `last: true`, `before: "<name>"`, `after: "<name>"`.
//   `set` is a list of assignments exactly as typed: `status=Done`, `tags+=bug`, `due=`.
//
// On disk a board is a folder: `store.jsonl` holds its fields and options,
// and every card is a markdown file whose frontmatter is its properties
// (src/store/). An agent never sees that. It names a board by its path, a
// card by its title, a field by its name, and what it says is parsed here,
// against the field's type, by the same pure modules the app uses — so the
// bytes written are the bytes the app would write, and a card can never be
// given a value its board has no place for. Views are the app's: an agent
// gets the board's own grouping, and `by` to regroup.

import { notBound, refuse, type Call } from "./agentCall";
import { contentTypeOf, keepPublic, namesOf, ownPages } from "./agentDocs";
import { cardHeads, splitCard } from "./boardCards";
import { Refusal, commit, newFileId, type Committed, type Tx } from "./commit";
import { Index, addressesOf, pathProblem, type Entry } from "./documents";
import type { Env } from "./env";
import { json, readJsonObject } from "./http";
import { blobKey } from "./layout";
import { mirrorAfter } from "./search";
import { basename, dirOf, openWorkspace, stemOf } from "./workspace";
import { META_SUFFIX, markerIds, parseEntityMeta } from "../../src/metaFile";
import {
  applyFilter,
  boardColumns,
  cardRank,
  cardValues,
  orderedOptions,
  renamedCardPath,
  sanitizeTitle,
  type Card,
} from "../../src/store/board";
import { parseFrontmatter, propList, propsEqual, serializeFrontmatter, type PropValue, type Props } from "../../src/store/frontmatter";
import { rankBetween, ranksBetween, sortByRank, validateRank } from "../../src/store/rank";
import {
  GROUPABLE_TYPES,
  OPTION_COLORS,
  RANK_KEY,
  STORE_FILE,
  cardKeyOrder,
  defaultStoreDef,
  fieldOf,
  isStoreConflictName,
  newFieldId,
  parseStoreDef,
  resolveView,
  serializeStoreDef,
  type Field,
  type FieldType,
  type Filter,
  type Option,
  type OptionColor,
  type StoreDef,
} from "../../src/store/storeFile";

const FIELD_TYPES: readonly FieldType[] = ["select", "multi_select", "text", "number", "date", "checkbox"];
const TYPE_WORD: Record<FieldType, string> = {
  select: "select",
  multi_select: "multi-select",
  text: "text",
  number: "number",
  date: "date",
  checkbox: "checkbox",
};
/** Fields whose values are declared options — the ones with columns of their own. */
const hasOptions = (type: FieldType): boolean => type === "select" || type === "multi_select";
/** A sync conflict copy of a card: `Ship it (conflict — Alice, Sep 2 14.32)`. */
const CONFLICT_RE = / \(conflict(?: — [^)]*| \d+)\)$/;
/** Blobs a change reads to bring the copy of cards' blocks up to date before
 *  it writes — fewer than a read may, because the change has its own to make. */
const WRITE_BUDGET = 24;
/** Blob reads and writes an option rename spends on cards in one request. */
const RENAME_BUDGET = 40;

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);
const trimSlashes = (p: string): string => p.replace(/^\/+|\/+$/g, "");
const lower = (s: string): string => s.trim().toLowerCase();
const titleOf = (e: Entry): string => stemOf(basename(e.file.path));

const indexing = (pending: number): Refusal => new Refusal(202, "the board's cards are still being read", { indexing: true, pending });
const noDatabase = (): Refusal => new Refusal(503, "boards need this domain's database — update the worker");

/** A refusal as the route answers it — `202` is "not yet", and says how far. */
const refused = (r: Refusal): Response => (r.status === 202 ? json({ indexing: true, pending: r.extra.pending }, 202) : refuse(r));

/* ---------- The board a request names ---------- */

type BoardAt = {
  /** As spelled in the workspace. */
  path: string;
  def: Entry;
  cards: Entry[];
  /** `store (conflict — …).jsonl` copies a sync left beside its definition. */
  conflicts: string[];
};

function boardIn(index: Index, raw: unknown): BoardAt | Refusal {
  const typed = trimSlashes(typeof raw === "string" ? raw : "");
  if (typed === "") return new Refusal(400, "say which board — a board is named by its path, like Projects/Roadmap");
  const problem = pathProblem(typed);
  if (problem) return new Refusal(400, problem);
  const path = index.board(typed);
  if (!path) {
    const inside = index.boardOf(typed);
    if (inside) return new Refusal(404, `there is no board at "${typed}" — that is inside the board ${inside}`);
    if (index.isFolder(typed)) return new Refusal(404, `${typed} is a folder, not a board — \`doklin ls ${typed}\` shows what it holds`);
    return new Refusal(404, `there is no board at "${typed}" — \`doklin ls\` lists the boards there are`);
  }
  const conflicts = index
    .under(path)
    .map((e) => e.file.path.slice(path.length + 1))
    .filter((rel) => !rel.includes("/") && isStoreConflictName(rel))
    .sort();
  return { path, def: index.at(`${path}/${STORE_FILE}`)!, cards: index.cards(path), conflicts };
}

type Read = (e: Entry) => Promise<string | null>;
const fromTx = (tx: Tx): Read => (e) => tx.readText(e.fid);
const fromBucket =
  (env: Env): Read =>
  async (e) => {
    const obj = await env.DATA.get(blobKey(e.fid, e.file.hash));
    return obj ? obj.text() : null;
  };

const syncing = (): Refusal => new Refusal(503, "its content has not finished syncing — try again in a moment");

async function readDef(read: Read, at: BoardAt): Promise<StoreDef | Refusal> {
  const text = await read(at.def);
  if (text === null) return syncing();
  return (
    parseStoreDef(text) ??
    new Refusal(409, `${at.path} holds a store.jsonl that is not a board Doklin can read — open it in Doklin`)
  );
}

const nameOfBoard = (at: BoardAt, def: StoreDef): string => def.name.trim() || basename(at.path);

async function writeDef(tx: Tx, at: BoardAt, before: StoreDef, after: StoreDef): Promise<void> {
  const text = serializeStoreDef(after);
  if (text !== serializeStoreDef(before)) await tx.write(at.def.fid, at.def.file.path, encode(text), contentTypeOf(at.def.file.path));
}

/* ---------- Fields, options and values, by the names an agent types ---------- */

function fieldNamed(def: StoreDef, board: string, typed: string): Field | Refusal {
  const t = lower(typed);
  const found = def.fields.find((f) => f.id.toLowerCase() === t) ?? def.fields.find((f) => lower(f.name) === t);
  if (found) return found;
  if (t === RANK_KEY) {
    return new Refusal(400, "rank is not a field — it is where a card sits; place a card with --first, --last, --before or --after");
  }
  const names = def.fields.map((f) => f.name);
  return new Refusal(
    404,
    `${board} has no field "${typed.trim()}" — ${names.length > 0 ? `its fields are ${names.join(", ")}` : "it has no fields yet"}. Add one with \`doklin board field add ${board} "${typed.trim()}" --type <type>\``,
    { code: "no_field", fields: names },
  );
}

const optionsField = (field: Field, board: string): Refusal | null =>
  hasOptions(field.type)
    ? null
    : new Refusal(
        400,
        `${field.name} on ${board} is a ${TYPE_WORD[field.type]} field — only select and multi-select fields have options`,
      );

function optionNamed(def: StoreDef, board: string, field: Field, typed: string): Option | Refusal {
  const found = orderedOptions(def, field.id).find((o) => lower(o.name) === lower(typed));
  if (found) return found;
  const names = orderedOptions(def, field.id).map((o) => o.name);
  return new Refusal(
    404,
    `${field.name} on ${board} has no option "${typed.trim()}" — ${names.length > 0 ? `its options are ${names.join(", ")}` : "it has no options yet"}. Add one with \`doklin board option add ${board} "${field.name}" "${typed.trim()}"\``,
    { code: "no_option", options: names },
  );
}

type Assignment = { field: Field; op: "=" | "+=" | "-="; value: string };

function assignmentOf(def: StoreDef, board: string, text: string): Assignment | Refusal {
  const eq = text.indexOf("=");
  if (eq <= 0) return new Refusal(400, `"${text}" is not a property to set — write it as <field>=<value>, like status=Done`);
  let key = text.slice(0, eq).trim();
  let op: Assignment["op"] = "=";
  // `tags+=bug` — unless a field is itself called "tags+".
  const last = key.slice(-1);
  if ((last === "+" || last === "-") && fieldNamed(def, board, key) instanceof Refusal) {
    op = last === "+" ? "+=" : "-=";
    key = key.slice(0, -1).trim();
  }
  const field = fieldNamed(def, board, key);
  if (field instanceof Refusal) return field;
  if (op !== "=" && field.type !== "multi_select") {
    return new Refusal(400, `${op} adds to a list or takes from one — ${field.name} is a ${TYPE_WORD[field.type]} field, so set it with ${key}=<value>`);
  }
  return { field, op, value: text.slice(eq + 1).trim() };
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const isIsoDate = (s: string): boolean => {
  const m = ISO_DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
};

/** What a field holds after an assignment — null when it is cleared. */
function valueAfter(def: StoreDef, board: string, a: Assignment, current: PropValue | undefined): PropValue | Refusal {
  const { field, value } = a;
  if (field.type === "multi_select") {
    const items = value.split(",").map((s) => s.trim()).filter((s) => s !== "");
    if (a.op === "-=") {
      const gone = new Set(items.map(lower));
      const kept = propList(current).filter((v) => !gone.has(lower(v)));
      return kept.length > 0 ? kept : null;
    }
    const declared: string[] = [];
    for (const item of items) {
      const option = optionNamed(def, board, field, item);
      if (option instanceof Refusal) return option;
      if (!declared.includes(option.name)) declared.push(option.name);
    }
    if (a.op === "=") return declared.length > 0 ? declared : null;
    if (declared.length === 0) return new Refusal(400, `say what to add to ${field.name}`);
    const have = propList(current);
    for (const name of declared) if (!have.some((v) => lower(v) === lower(name))) have.push(name);
    return have;
  }
  if (value === "") return null;
  switch (field.type) {
    case "select": {
      const option = optionNamed(def, board, field, value);
      return option instanceof Refusal ? option : option.name;
    }
    case "number":
      return /^-?\d+(?:\.\d+)?$/.test(value) ? Number(value) : new Refusal(400, `${field.name} is a number — "${value}" is not one`);
    case "date":
      return isIsoDate(value) ? value : new Refusal(400, `${field.name} is a date — write it as 2026-09-12, not "${value}"`);
    case "checkbox": {
      const v = value.toLowerCase();
      return v === "true" ? true : v === "false" ? false : new Refusal(400, `${field.name} is a checkbox — set it to true or false`);
    }
    default:
      return value;
  }
}

/** Apply assignments to a card's properties, in order. */
function assign(def: StoreDef, board: string, props: Props, raw: readonly string[]): Props | Refusal {
  const next: Props = { ...props };
  for (const text of raw) {
    const a = assignmentOf(def, board, text);
    if (a instanceof Refusal) return a;
    const v = valueAfter(def, board, a, next[a.field.id]);
    if (v instanceof Refusal) return v;
    if (v === null) delete next[a.field.id];
    else next[a.field.id] = v;
  }
  return next;
}

/** The assignments of a request body: a list of strings, or nothing. */
function assignmentsIn(raw: unknown): string[] | Refusal {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((s) => typeof s !== "string")) {
    return new Refusal(400, "set is a list of assignments, like [\"status=Done\", \"tags+=bug\"]");
  }
  return raw as string[];
}

/** A condition from `where`: `status=Done`, `status!=Done`, `due=` (empty), `due!=` (not empty). */
function filterOf(def: StoreDef, board: string, text: string): Filter | Refusal {
  const eq = text.indexOf("=");
  if (eq <= 0) return new Refusal(400, `"${text}" is not a condition — write it as <field>=<value> or <field>!=<value>`);
  const negate = text[eq - 1] === "!";
  const field = fieldNamed(def, board, text.slice(0, negate ? eq - 1 : eq));
  if (field instanceof Refusal) return field;
  const value = text.slice(eq + 1).trim();
  const op: Filter["op"] = value === "" ? (negate ? "not_empty" : "empty") : negate ? "is_not" : "is";
  return { field: field.id, op, value };
}

/* ---------- What an answer says ---------- */

/** A board's fields as an agent sees them: names, types, and options in column order. */
const fieldsOf = (def: StoreDef) =>
  def.fields.map((f) => ({
    id: f.id,
    name: f.name,
    type: f.type,
    ...(hasOptions(f.type)
      ? { options: orderedOptions(def, f.id).map((o) => ({ name: o.name, ...(o.color ? { color: o.color } : {}) })) }
      : {}),
  }));

const isEmpty = (v: PropValue | undefined): boolean => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** A card's declared properties, by field name, in the board's order — what is set, and nothing else. */
function shownProps(def: StoreDef, props: Props): Record<string, PropValue> {
  const out: Record<string, PropValue> = {};
  for (const f of def.fields) {
    if (isEmpty(props[f.id])) continue;
    out[Object.prototype.hasOwnProperty.call(out, f.name) ? f.id : f.name] = props[f.id];
  }
  return out;
}

/** Keys the board does not declare — kept as they are, shown, never settable. */
function otherProps(def: StoreDef, props: Props): Record<string, PropValue> {
  const declared = new Set(def.fields.map((f) => f.id));
  const out: Record<string, PropValue> = {};
  for (const key of Object.keys(props).sort()) if (key !== RANK_KEY && !declared.has(key) && !isEmpty(props[key])) out[key] = props[key];
  return out;
}

/** The field a board puts in columns: its first kanban view's, as the app opens it. */
function groupField(def: StoreDef): Field | null {
  const view = resolveView(def, "kanban");
  return view ? fieldOf(def, view.groupBy) : null;
}

const cardOf = (e: Entry, head: string): Card => {
  const fm = parseFrontmatter(head);
  return {
    path: e.file.path,
    name: basename(e.file.path),
    title: titleOf(e),
    snapshot: { mtime_ms: e.file.mtime ?? 0, size: e.file.size },
    props: fm.props,
    opaque: fm.opaque,
    excerpt: "",
  };
};

const changedBy = (e: Entry, names: ReadonlyMap<string, string>) => ({
  rev: e.file.rev,
  changed: e.file.mtime ?? null,
  by: e.file.by ?? null,
  ...(e.file.by && names.has(e.file.by) ? { byName: names.get(e.file.by) } : {}),
});

/** Every card's properties, or why they cannot be had yet. */
async function cardsOf(env: Env, at: BoardAt, budget?: number): Promise<{ cards: Card[]; read: number } | Refusal> {
  const got = await cardHeads(env, at.cards, budget);
  if (got === null) return noDatabase();
  if ("pending" in got) return indexing(got.pending);
  return { cards: at.cards.map((e) => cardOf(e, got.heads.get(e.fid) ?? "")), read: got.read };
}

/* ---------- Where something goes ---------- */

type Place = { first: true } | { last: true } | { before: string } | { after: string };

function placeIn(body: Record<string, unknown>): Place | null | Refusal {
  const named = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  const given: Place[] = [];
  if (body.first === true) given.push({ first: true });
  if (body.last === true) given.push({ last: true });
  const before = named(body.before);
  if (before) given.push({ before });
  const after = named(body.after);
  if (after) given.push({ after });
  if (given.length > 1) return new Refusal(400, "say one place — --first, --last, --before or --after");
  return given[0] ?? null;
}

const usable = (rank: string | null | undefined): rank is string => {
  if (typeof rank !== "string" || rank === "") return false;
  try {
    validateRank(rank);
    return true;
  } catch {
    return false;
  }
};

/**
 * The rank that puts something at `place` among `others`, which are in rank
 * order already. Ranks are one order across the whole board — a column shows
 * its own cards in it — so "before X" is the rank just before X's.
 */
function rankAt<T>(
  others: readonly T[],
  rankOf: (t: T) => string | null | undefined,
  nameOf: (t: T) => string,
  place: Place,
  what: { thing: string; where: string; self: string },
): string | Refusal {
  const ranked = others.filter((t) => usable(rankOf(t)));
  const ranks = ranked.map((t) => rankOf(t) as string);
  if ("first" in place) return rankBetween(null, ranks[0] ?? null);
  if ("last" in place) return rankBetween(ranks.at(-1) ?? null, null);
  const typed = "before" in place ? place.before : place.after;
  if (lower(typed) === lower(what.self)) return new Refusal(400, `a ${what.thing} cannot be put next to itself`);
  const target = others.find((t) => lower(nameOf(t)) === lower(typed));
  if (!target) return new Refusal(404, `${what.where} has no ${what.thing} "${typed}" to put it next to`);
  const rank = rankOf(target);
  if (!usable(rank)) {
    return new Refusal(409, `"${nameOf(target)}" has no place of its own yet, so nothing can be put next to it — use --first or --last`);
  }
  if ("before" in place) {
    const i = ranks.indexOf(rank);
    return rankBetween(i > 0 ? ranks[i - 1] : null, rank);
  }
  return rankBetween(rank, ranks[ranks.lastIndexOf(rank) + 1] ?? null);
}

const inRankOrder = (cards: readonly Card[]): Card[] => sortByRank([...cards], cardRank, (c) => c.title);

/* ---------- Reading ---------- */

export async function getBoard({ env, url }: Call): Promise<Response> {
  const ws = await openWorkspace(env);
  if (!ws) return notBound();
  const at = boardIn(new Index(ws.manifest.files), url.searchParams.get("path"));
  if (at instanceof Refusal) return refuse(at);
  const def = await readDef(fromBucket(env), at);
  if (def instanceof Refusal) return refuse(def);
  return json({
    board: at.path,
    name: nameOfBoard(at, def),
    cards: at.cards.length,
    by: groupField(def)?.name ?? null,
    fields: fieldsOf(def),
    ...(at.conflicts.length > 0 ? { conflicts: at.conflicts } : {}),
  });
}

export async function getCards({ env, url }: Call): Promise<Response> {
  const ws = await openWorkspace(env);
  if (!ws) return notBound();
  const at = boardIn(new Index(ws.manifest.files), url.searchParams.get("path"));
  if (at instanceof Refusal) return refuse(at);
  const def = await readDef(fromBucket(env), at);
  if (def instanceof Refusal) return refuse(def);

  const byTyped = url.searchParams.get("by")?.trim() ?? "";
  let by: Field | null = groupField(def);
  if (byTyped !== "") {
    const asked = fieldNamed(def, at.path, byTyped);
    if (asked instanceof Refusal) return refuse(asked);
    if (!GROUPABLE_TYPES.includes(asked.type)) {
      return json({ error: `${asked.name} is a ${TYPE_WORD[asked.type]} field — a board's columns come from a select, multi-select or date field` }, 400);
    }
    by = asked;
  }
  const filters: Filter[] = [];
  for (const text of url.searchParams.getAll("where")) {
    const f = filterOf(def, at.path, text);
    if (f instanceof Refusal) return refuse(f);
    filters.push(f);
  }

  const got = await cardsOf(env, at);
  if (got instanceof Refusal) return refused(got);
  const names = await namesOf(env);
  const entries = new Map(at.cards.map((e) => [e.file.path, e]));
  const row = (card: Card) => ({
    title: card.title,
    props: shownProps(def, card.props),
    ...changedBy(entries.get(card.path)!, names),
    ...(CONFLICT_RE.test(card.title) ? { conflict: true } : {}),
  });
  const kept = applyFilter(def, got.cards, filters);
  const columns = by
    ? boardColumns(def, kept, by.id)
        // An empty column is worth showing when it is one a card can be put in.
        .filter((col) => col.declared || col.cards.length > 0)
        .map((col) => ({
          name: col.label,
          ...(col.key === "" ? { empty: true } : {}),
          ...(col.color ? { color: col.color } : {}),
          cards: col.cards.map(row),
        }))
    : [{ name: null, cards: inRankOrder(kept).map(row) }];
  return json({
    board: at.path,
    name: nameOfBoard(at, def),
    cards: at.cards.length,
    ...(filters.length > 0 ? { shown: kept.length } : {}),
    by: by?.name ?? null,
    fields: fieldsOf(def),
    columns,
    ...(at.conflicts.length > 0 ? { conflicts: at.conflicts } : {}),
  });
}

function cardNamed(at: BoardAt, typed: unknown): Entry | Refusal {
  const raw = typeof typed === "string" ? typed.trim().replace(/\.(md|markdown|mdown|mkd)$/i, "") : "";
  if (raw === "") return new Refusal(400, "say which card — by its title");
  const want = sanitizeTitle(raw);
  const hits = at.cards.filter((e) => lower(titleOf(e)) === lower(want));
  if (hits.length === 0) {
    return new Refusal(404, `${at.path} has no card "${raw}" — \`doklin board show ${at.path}\` lists its cards`, { code: "no_card" });
  }
  return hits.find((e) => titleOf(e) === want) ?? hits[0];
}

export async function getCard({ env, url }: Call): Promise<Response> {
  const ws = await openWorkspace(env);
  if (!ws) return notBound();
  const index = new Index(ws.manifest.files);
  const at = boardIn(index, url.searchParams.get("path"));
  if (at instanceof Refusal) return refuse(at);
  const def = await readDef(fromBucket(env), at);
  if (def instanceof Refusal) return refuse(def);
  const entry = cardNamed(at, url.searchParams.get("card"));
  if (entry instanceof Refusal) return refuse(entry);
  const doc = index.doc(stemOf(entry.file.path));
  const [text, metaText, names] = await Promise.all([
    fromBucket(env)(entry),
    doc.meta ? fromBucket(env)(doc.meta) : Promise.resolve(""),
    namesOf(env),
  ]);
  if (text === null) return refuse(syncing());
  const { head, page } = splitCard(text);
  const props = parseFrontmatter(head).props;
  const other = otherProps(def, props);
  const threads = parseEntityMeta(metaText ?? "").mthreads.length;
  const addresses = addressesOf(ws.manifest, url.origin, [entry.fid], entry.file.path);
  return json({
    board: at.path,
    title: titleOf(entry),
    path: doc.stem,
    ...changedBy(entry, names),
    size: entry.file.size,
    props: shownProps(def, props),
    ...(Object.keys(other).length > 0 ? { other } : {}),
    comments: threads,
    ...(addresses.length > 0 ? { public: addresses } : {}),
    ...(CONFLICT_RE.test(titleOf(entry)) ? { conflict: true } : {}),
    page,
  });
}

/* ---------- Changing ---------- */

/** Run a change to a board and answer it. Every change is a commit: the
 *  latest bytes, re-read on a lost race, so two agents setting different
 *  properties of one card both land. */
async function change(
  c: Call,
  dryRun: boolean,
  fn: (tx: Tx, index: Index) => Promise<Record<string, unknown> | Refusal>,
  status: (value: Record<string, unknown>, done: Committed<Record<string, unknown>>) => number = () => 200,
): Promise<Response> {
  const done = await commit(c.env, c.who.id, (tx) => fn(tx, new Index(tx.files)), { dryRun });
  if (done instanceof Refusal) return refused(done);
  await mirrorAfter(c, done);
  return json({ ...done.value, ...(done.wrote || dryRun ? {} : { changed: false }) }, status(done.value, done));
}

async function bodyOf(request: Request): Promise<Record<string, unknown> | Response> {
  return (await readJsonObject(request)) ?? json({ error: "invalid json body" }, 400);
}

async function openBoard(tx: Tx, index: Index, path: unknown): Promise<{ at: BoardAt; def: StoreDef } | Refusal> {
  const at = boardIn(index, path);
  if (at instanceof Refusal) return at;
  const def = await readDef(fromTx(tx), at);
  return def instanceof Refusal ? def : { at, def };
}

export async function postBoard(c: Call): Promise<Response> {
  const body = await bodyOf(c.request);
  if (body instanceof Response) return body;
  const typed = trimSlashes(typeof body.path === "string" ? body.path : "");
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 200) : "";
  return change(
    c,
    body.dryRun === true,
    async (tx, index) => {
      if (typed === "") return new Refusal(400, "say where the board goes — a path, like Projects/Roadmap");
      const problem = pathProblem(`${typed}/${STORE_FILE}`);
      if (problem) return new Refusal(400, problem);
      const inside = index.boardOf(typed);
      if (inside) return new Refusal(409, `"${typed}" is inside the board ${inside} — a board cannot hold another`);
      if (index.board(typed)) return new Refusal(409, `there is already a board at ${index.board(typed)}`);
      const there = index.at(typed);
      if (there) return new Refusal(409, `"${there.file.path}" is already there`);
      if (index.isFolder(typed)) {
        return new Refusal(409, `"${typed}" is already a folder — a board starts as a new folder here; Doklin itself can turn a folder into a board`);
      }
      const target = index.spelled(`${typed}/${STORE_FILE}`);
      const place = index.placeProblem(target);
      if (place) return new Refusal(409, place);
      const path = dirOf(target);
      const def = defaultStoreDef(name || basename(path));
      await tx.write(newFileId(), target, encode(serializeStoreDef(def)), contentTypeOf(target));
      return { board: path, name: def.name, fields: fieldsOf(def), created: true };
    },
    (_, done) => (done.wrote ? 201 : 200),
  );
}

/** A page as `board add` takes one, or why it cannot be one. */
function pageProblem(page: string, board: string, title: string): Refusal | null {
  if (parseFrontmatter(page).present) {
    return new Refusal(400, `a card's page cannot begin with a properties block — set its properties with \`doklin board set ${board} "${title}" <field>=<value>\``);
  }
  if (markerIds(page).size > 0) {
    return new Refusal(400, "the page carries a comment marker no thread has — start a thread with `doklin comment` once the card exists");
  }
  return null;
}

export async function postCard(c: Call): Promise<Response> {
  const body = await bodyOf(c.request);
  if (body instanceof Response) return body;
  const raw = assignmentsIn(body.set);
  if (raw instanceof Refusal) return refuse(raw);
  const page = typeof body.page === "string" ? body.page : "";
  if (body.page !== undefined && typeof body.page !== "string") return json({ error: "page is the card's text, as a string" }, 400);
  const title = sanitizeTitle(typeof body.title === "string" ? body.title : "");
  if (body.first !== undefined && body.first !== true) return json({ error: "first is true or absent" }, 400);

  return change(
    c,
    body.dryRun === true,
    async (tx, index) => {
      const open = await openBoard(tx, index, body.path);
      if (open instanceof Refusal) return open;
      const { at, def } = open;
      if (title === "") return new Refusal(400, "a card needs a title");
      const taken = at.cards.find((e) => lower(titleOf(e)) === lower(title));
      if (taken) return new Refusal(409, `${at.path} already has a card called "${titleOf(taken)}"`, { code: "taken" });
      const pageWrong = pageProblem(page, at.path, title);
      if (pageWrong) return pageWrong;
      const target = `${at.path}/${title}.md`;
      const problem = pathProblem(target);
      if (problem) return new Refusal(400, problem);
      const inTheWay = index.at(target);
      if (inTheWay) return new Refusal(409, `"${inTheWay.file.path}" is already there`);
      const place = index.placeProblem(target);
      if (place) return new Refusal(409, place);

      const props = assign(def, at.path, {}, raw);
      if (props instanceof Refusal) return props;
      const got = await cardsOf(c.env, at, WRITE_BUDGET);
      if (got instanceof Refusal) return got;
      const rank = rankAt(inRankOrder(got.cards), cardRank, (x) => x.title, body.first === true ? { first: true } : { last: true }, {
        thing: "card",
        where: at.path,
        self: title,
      });
      if (rank instanceof Refusal) return rank;
      props[RANK_KEY] = rank;
      const file = await tx.write(newFileId(), target, encode(serializeFrontmatter(props, [], cardKeyOrder(def)) + page), contentTypeOf(target));
      return { board: at.path, title, path: stemOf(file.path), rev: file.rev, props: shownProps(def, props), created: true };
    },
    (_, done) => (done.wrote ? 201 : 200),
  );
}

/** Whether two values put a card in the same columns. */
const sameColumns = (a: PropValue | undefined, b: PropValue | undefined): boolean => {
  const x = propList(a).map(lower).sort();
  const y = propList(b).map(lower).sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

export async function patchCard(c: Call): Promise<Response> {
  const body = await bodyOf(c.request);
  if (body instanceof Response) return body;
  const raw = assignmentsIn(body.set);
  if (raw instanceof Refusal) return refuse(raw);
  const place = placeIn(body);
  if (place instanceof Refusal) return refuse(place);
  if (body.title !== undefined && typeof body.title !== "string") return json({ error: "title is the card's new title" }, 400);
  const retitle = typeof body.title === "string" ? sanitizeTitle(body.title) : null;
  if (retitle === "") return json({ error: "a card needs a title" }, 400);
  if (raw.length === 0 && place === null && retitle === null) {
    return json({ error: "say what to change — a property (<field>=<value>), --title, or where the card goes" }, 400);
  }

  return change(c, body.dryRun === true, async (tx, index) => {
    const open = await openBoard(tx, index, body.path);
    if (open instanceof Refusal) return open;
    const { at, def } = open;
    const entry = cardNamed(at, body.card);
    if (entry instanceof Refusal) return entry;
    const title = titleOf(entry);
    const text = await tx.readText(entry.fid);
    if (text === null) return syncing();
    const { head, page } = splitCard(text);
    const fm = parseFrontmatter(head);
    const next = assign(def, at.path, fm.props, raw);
    if (next instanceof Refusal) return next;

    // A card that changes column goes to the foot of it, unless it was told where.
    const group = groupField(def);
    const moved = group !== null && !sameColumns(fm.props[group.id], next[group.id]);
    const where: Place | null = place ?? (moved ? { last: true } : null);
    if (where) {
      const got = await cardsOf(c.env, at, WRITE_BUDGET);
      if (got instanceof Refusal) return got;
      const others = inRankOrder(got.cards.filter((x) => x.path !== entry.file.path));
      const rank = rankAt(others, cardRank, (x) => x.title, where, { thing: "card", where: at.path, self: title });
      if (rank instanceof Refusal) return rank;
      next[RANK_KEY] = rank;
    }

    let file = entry.file;
    if (!propsEqual(fm.props, next)) {
      file = await tx.write(entry.fid, entry.file.path, encode(serializeFrontmatter(next, fm.opaque, cardKeyOrder(def)) + page), contentTypeOf(entry.file.path));
    }

    let renamed: { from: string; to: string } | null = null;
    if (retitle !== null && retitle !== title) {
      const clash = at.cards.find((e) => e.fid !== entry.fid && lower(titleOf(e)) === lower(retitle));
      if (clash) return new Refusal(409, `${at.path} already has a card called "${titleOf(clash)}"`, { code: "taken" });
      const to = renamedCardPath(entry.file.path, retitle);
      const problem = pathProblem(to);
      if (problem) return new Refusal(400, problem);
      // What the app keeps beside a note moves with it: its comments, and an
      // html rendition, which a board does not show but must not orphan.
      const stem = stemOf(entry.file.path);
      const toStem = stemOf(to);
      const companions = [META_SUFFIX, ".html"]
        .map((suffix) => ({ from: index.at(`${stem}${suffix}`), to: `${toStem}${suffix}` }))
        .filter((s): s is { from: Entry; to: string } => s.from !== null);
      const moving = new Set([entry.fid, ...companions.map((s) => s.from.fid)]);
      const steps = [{ fid: entry.fid, to }, ...companions.map((s) => ({ fid: s.from.fid, to: s.to }))];
      for (const step of steps) {
        const there = index.at(step.to);
        if (there && !moving.has(there.fid)) return new Refusal(409, `"${there.file.path}" is already there`);
      }
      for (const step of steps) tx.move(step.fid, step.to);
      file = tx.files[entry.fid];
      keepPublic(tx);
      renamed = { from: title, to: retitle };
    }

    return {
      board: at.path,
      title: retitle ?? title,
      path: stemOf(file.path),
      rev: file.rev,
      props: shownProps(def, next),
      ...(renamed ? { renamed } : {}),
      ...(where ? { placed: "first" in where ? "first" : "last" in where ? "last" : "before" in where ? { before: where.before } : { after: where.after } } : {}),
    };
  });
}

export async function deleteCard(c: Call): Promise<Response> {
  const { url } = c;
  return change(c, url.searchParams.get("dry") === "1", async (tx, index) => {
    const at = boardIn(index, url.searchParams.get("path"));
    if (at instanceof Refusal) return at;
    const entry = cardNamed(at, url.searchParams.get("card"));
    if (entry instanceof Refusal) return entry;
    // What the app trashes with a note goes with it: its comments, and an
    // html rendition the board never showed.
    const stem = stemOf(entry.file.path);
    tx.remove(entry.fid);
    for (const suffix of [META_SUFFIX, ".html"]) {
      const companion = index.at(`${stem}${suffix}`);
      if (companion) tx.remove(companion.fid);
    }
    // A page outlives its document on purpose (docs/cloud.md §9, decision 7).
    return { board: at.path, title: titleOf(entry), path: stem, stillPublic: ownPages(tx.m, url.origin, [entry.fid]) };
  });
}

/* ---------- Fields ---------- */

function typeOf(raw: unknown): FieldType | Refusal {
  const t = typeof raw === "string" ? raw.trim().toLowerCase().replace(/-/g, "_") : "";
  if ((FIELD_TYPES as readonly string[]).includes(t)) return t as FieldType;
  return new Refusal(400, `a field's type is one of: ${FIELD_TYPES.join(", ")}`);
}

/** Option names from a list or a comma-separated string, trimmed, each once. */
function optionNames(raw: unknown): string[] | Refusal {
  if (raw === undefined || raw === null) return [];
  const items = typeof raw === "string" ? raw.split(",") : Array.isArray(raw) && raw.every((s) => typeof s === "string") ? (raw as string[]) : null;
  if (!items) return new Refusal(400, 'options is a list of names, or one string like "Low, Medium, High"');
  const out: string[] = [];
  for (const item of items.map((s) => s.trim()).filter((s) => s !== "")) if (!out.some((o) => lower(o) === lower(item))) out.push(item);
  return out;
}

const fieldTaken = (def: StoreDef, name: string, except?: Field): Field | undefined =>
  def.fields.find((f) => f !== except && (lower(f.name) === lower(name) || f.id === lower(name)));

export async function postField(c: Call): Promise<Response> {
  const body = await bodyOf(c.request);
  if (body instanceof Response) return body;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const type = typeOf(body.type);
  if (type instanceof Refusal) return refuse(type);
  const options = optionNames(body.options);
  if (options instanceof Refusal) return refuse(options);
  return change(
    c,
    body.dryRun === true,
    async (tx, index) => {
      const open = await openBoard(tx, index, body.path);
      if (open instanceof Refusal) return open;
      const { at, def } = open;
      if (name === "") return new Refusal(400, "a field needs a name");
      if (lower(name) === RANK_KEY) return new Refusal(400, "rank is where a card sits — call the field something else");
      const taken = fieldTaken(def, name);
      if (taken) return new Refusal(409, `${at.path} already has a field called "${taken.name}"`, { code: "taken" });
      if (options.length > 0 && !hasOptions(type)) return new Refusal(400, `a ${TYPE_WORD[type]} field has no options — only select and multi-select fields do`);
      const id = newFieldId(def, name);
      const ranks = ranksBetween(null, null, options.length);
      const after: StoreDef = {
        ...def,
        fields: [...def.fields, { id, name, type }],
        options: [...def.options, ...options.map((o, i) => ({ field: id, name: o, rank: ranks[i] }))],
      };
      await writeDef(tx, at, def, after);
      return { board: at.path, field: fieldsOf(after).find((f) => f.id === id), created: true };
    },
    (_, done) => (done.wrote ? 201 : 200),
  );
}

export async function patchField(c: Call): Promise<Response> {
  const body = await bodyOf(c.request);
  if (body instanceof Response) return body;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name === "") return json({ error: "say the field's new name with --name" }, 400);
  return change(c, body.dryRun === true, async (tx, index) => {
    const open = await openBoard(tx, index, body.path);
    if (open instanceof Refusal) return open;
    const { at, def } = open;
    const field = fieldNamed(def, at.path, typeof body.field === "string" ? body.field : "");
    if (field instanceof Refusal) return field;
    if (lower(name) === RANK_KEY) return new Refusal(400, "rank is where a card sits — call the field something else");
    const taken = fieldTaken(def, name, field);
    if (taken) return new Refusal(409, `${at.path} already has a field called "${taken.name}"`, { code: "taken" });
    // Its id is the key in every card, and stays: renaming is what people read.
    const after: StoreDef = { ...def, fields: def.fields.map((f) => (f === field ? { ...f, name } : f)) };
    await writeDef(tx, at, def, after);
    return { board: at.path, field: fieldsOf(after).find((f) => f.id === field.id), renamed: { from: field.name, to: name } };
  });
}

export async function deleteField(c: Call): Promise<Response> {
  const { url } = c;
  return change(c, url.searchParams.get("dry") === "1", async (tx, index) => {
    const open = await openBoard(tx, index, url.searchParams.get("path"));
    if (open instanceof Refusal) return open;
    const { at, def } = open;
    const field = fieldNamed(def, at.path, url.searchParams.get("field") ?? "");
    if (field instanceof Refusal) return field;
    // No card is rewritten: the key stays in every card that has it, kept as
    // it is, the way the app undeclares a field (model.ts, deleteField).
    const after: StoreDef = {
      ...def,
      fields: def.fields.filter((f) => f.id !== field.id),
      options: def.options.filter((o) => o.field !== field.id),
      views: def.views.map((v) => ({
        ...v,
        filter: v.filter.filter((f) => f.field !== field.id),
        sort: v.sort?.field === field.id ? null : v.sort,
        show: v.show ? v.show.filter((f) => f !== field.id) : null,
      })),
    };
    await writeDef(tx, at, def, after);
    return { board: at.path, field: { id: field.id, name: field.name, type: field.type } };
  });
}

/* ---------- Options ---------- */

function colorOf(raw: unknown): OptionColor | "none" | null | Refusal {
  if (raw === undefined || raw === null) return null;
  const c = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (c === "none") return "none";
  if ((OPTION_COLORS as readonly string[]).includes(c)) return c as OptionColor;
  return new Refusal(400, `a color is one of: ${OPTION_COLORS.join(", ")} — or none`);
}

const optionRow = (o: Option) => ({ name: o.name, ...(o.color ? { color: o.color } : {}) });

async function openField(
  tx: Tx,
  index: Index,
  body: { path?: unknown; field?: unknown },
): Promise<{ at: BoardAt; def: StoreDef; field: Field } | Refusal> {
  const open = await openBoard(tx, index, body.path);
  if (open instanceof Refusal) return open;
  const field = fieldNamed(open.def, open.at.path, typeof body.field === "string" ? body.field : "");
  if (field instanceof Refusal) return field;
  const wrong = optionsField(field, open.at.path);
  return wrong ?? { ...open, field };
}

export async function postOption(c: Call): Promise<Response> {
  const body = await bodyOf(c.request);
  if (body instanceof Response) return body;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const color = colorOf(body.color);
  if (color instanceof Refusal) return refuse(color);
  const place = placeIn(body);
  if (place instanceof Refusal) return refuse(place);
  return change(
    c,
    body.dryRun === true,
    async (tx, index) => {
      const open = await openField(tx, index, body);
      if (open instanceof Refusal) return open;
      const { at, def, field } = open;
      if (name === "") return new Refusal(400, "an option needs a name");
      const ordered = orderedOptions(def, field.id);
      const taken = ordered.find((o) => lower(o.name) === lower(name));
      if (taken) return new Refusal(409, `${field.name} on ${at.path} already has an option "${taken.name}"`, { code: "taken" });
      const rank = rankAt(ordered, (o) => o.rank, (o) => o.name, place ?? { last: true }, { thing: "option", where: field.name, self: name });
      if (rank instanceof Refusal) return rank;
      const option: Option = { field: field.id, name, rank, ...(color && color !== "none" ? { color } : {}) };
      const after: StoreDef = { ...def, options: [...def.options, option] };
      await writeDef(tx, at, def, after);
      return { board: at.path, field: field.name, option: optionRow(option), options: orderedOptions(after, field.id).map(optionRow), created: true };
    },
    (_, done) => (done.wrote ? 201 : 200),
  );
}

export async function patchOption(c: Call): Promise<Response> {
  const body = await bodyOf(c.request);
  if (body instanceof Response) return body;
  const typed = typeof body.option === "string" ? body.option.trim() : "";
  if (typed === "") return json({ error: "say which option" }, 400);
  if (body.name !== undefined && typeof body.name !== "string") return json({ error: "name is the option's new name" }, 400);
  const name = typeof body.name === "string" ? body.name.trim() : null;
  if (name === "") return json({ error: "an option needs a name" }, 400);
  const color = colorOf(body.color);
  if (color instanceof Refusal) return refuse(color);
  const place = placeIn(body);
  if (place instanceof Refusal) return refuse(place);
  if (name === null && color === null && place === null) return json({ error: "say what to change — --name, --color, or where the option goes" }, 400);
  const dryRun = body.dryRun === true;

  return change(
    c,
    dryRun,
    async (tx, index) => {
      const open = await openField(tx, index, body);
      if (open instanceof Refusal) return open;
      const { at, def, field } = open;
      const ordered = orderedOptions(def, field.id);
      let option = ordered.find((o) => lower(o.name) === lower(typed));
      // A rename this request is asked to finish: the option has its new name
      // already, and cards may still carry the old one (see below).
      if (!option && name !== null) option = ordered.find((o) => lower(o.name) === lower(name));
      if (!option) {
        const missing = optionNamed(def, at.path, field, typed);
        return missing instanceof Refusal ? missing : new Refusal(404, `${field.name} on ${at.path} has no option "${typed}"`);
      }
      const current = option;
      if (name !== null) {
        const clash = ordered.find((o) => o !== current && lower(o.name) === lower(name));
        if (clash) return new Refusal(409, `${field.name} on ${at.path} already has an option "${clash.name}"`, { code: "taken" });
      }
      let rank = current.rank;
      if (place) {
        const r = rankAt(ordered.filter((o) => o !== current), (o) => o.rank, (o) => o.name, place, { thing: "option", where: field.name, self: current.name });
        if (r instanceof Refusal) return r;
        rank = r;
      }
      const updated: Option = {
        field: field.id,
        name: name ?? current.name,
        rank,
        ...(color === "none" ? {} : color ? { color } : current.color ? { color: current.color } : {}),
      };
      const after: StoreDef = { ...def, options: def.options.map((o) => (o === current ? updated : o)) };
      await writeDef(tx, at, def, after);

      // A rename is also every card that carries the old value — rewritten a
      // round at a time, the definition first, as the app renames a column
      // (model.ts, renameOption). Until the last round, a card not yet
      // rewritten shows under a column for the old value, which nothing
      // declares any more; asking again carries on from there. A card counts
      // as carrying it in any case but the new name's exact one, so a rename
      // that only changes case finishes too.
      const from = lower(current.name) === lower(typed) ? current.name : typed;
      const stale = (v: string): boolean => lower(v) === lower(from) && v !== updated.name;
      let cards = 0;
      let pending = 0;
      if (name !== null) {
        const got = await cardsOf(c.env, at, WRITE_BUDGET);
        if (got instanceof Refusal) return got;
        const carrying = got.cards.filter((card) => cardValues(card, field, field.id).some(stale));
        const round = dryRun ? carrying : carrying.slice(0, Math.max(4, Math.floor((RENAME_BUDGET - got.read) / 2)));
        if (!dryRun) {
          for (const card of round) {
            const entry = at.cards.find((e) => e.file.path === card.path)!;
            const text = await tx.readText(entry.fid);
            if (text === null) return syncing();
            const { head, page } = splitCard(text);
            const fm = parseFrontmatter(head);
            const was = fm.props[field.id];
            const props: Props = { ...fm.props };
            if (field.type === "multi_select") {
              const list: string[] = [];
              for (const v of propList(was)) {
                const nv = stale(v) ? updated.name : v;
                if (!list.includes(nv)) list.push(nv);
              }
              props[field.id] = list;
            } else {
              props[field.id] = updated.name;
            }
            await tx.write(entry.fid, entry.file.path, encode(serializeFrontmatter(props, fm.opaque, cardKeyOrder(after)) + page), contentTypeOf(entry.file.path));
          }
        }
        cards = round.length;
        pending = carrying.length - round.length;
      }
      return {
        board: at.path,
        field: field.name,
        option: optionRow(updated),
        ...(name !== null ? { renamed: { from, to: updated.name }, cards } : {}),
        ...(pending > 0 ? { pending } : {}),
        options: orderedOptions(after, field.id).map(optionRow),
      };
    },
    // Cards still to rewrite: the same request again finishes the job.
    (value) => (typeof value.pending === "number" && value.pending > 0 ? 202 : 200),
  );
}

export async function deleteOption(c: Call): Promise<Response> {
  const { url } = c;
  return change(c, url.searchParams.get("dry") === "1", async (tx, index) => {
    const open = await openField(tx, index, { path: url.searchParams.get("path"), field: url.searchParams.get("field") });
    if (open instanceof Refusal) return open;
    const { at, def, field } = open;
    const option = optionNamed(def, at.path, field, url.searchParams.get("option") ?? "");
    if (option instanceof Refusal) return option;
    // No card is touched: a card that carries the value keeps it, and shows
    // in a column of its own for a value nothing declares.
    const after: StoreDef = { ...def, options: def.options.filter((o) => o !== option) };
    await writeDef(tx, at, def, after);
    return { board: at.path, field: field.name, option: optionRow(option), options: orderedOptions(after, field.id).map(optionRow) };
  });
}
