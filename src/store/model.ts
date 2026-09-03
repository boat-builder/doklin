// The live view of one datastore: its definition, its cards, and every
// mutation a board can make.
//
// The model is a CACHE OF DISK, never a second source of truth — the same
// posture tabs take. Every mutation writes a file and lets the folder watcher
// bring the change back, so a card edited in another window, another tool, or
// by cloud sync lands the same way a card edited here does. Local state moves
// first (a drag must not wait for a round trip), and the rescan that follows
// is what makes it true.
//
// One instance per folder path, shared by everything showing that store in
// this window (a board tab, an embed), so two views of one board never
// disagree and one watcher covers both.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  parseFrontmatter,
  propList,
  serializeFrontmatter,
  type Props,
  type PropValue,
} from "./frontmatter";
import {
  cardKeyOrder,
  defaultStoreDef,
  fieldOf,
  groupableFields,
  newView,
  parseStoreDef,
  RANK_KEY,
  serializeStoreDef,
  storeFileOf,
  STORE_FILE,
  type FieldType,
  type Option,
  type OptionColor,
  type StoreDef,
  type View,
  type ViewKind,
} from "./storeFile";
import { rankBetween } from "./rank";
// The pure half — what a card is, what a column is, and how the two derive.
// This module fills those shapes from disk and writes changes back; the
// shapes themselves belong to everything that shows a board, published
// pages included, so they live apart from Tauri.
import {
  cardRank,
  cardValue,
  orderedOptions,
  type Card,
  type FileSnapshot,
} from "./board";

// The model's own surface speaks in cards and snapshots, so they re-export
// from here — no caller needs to know which of the two files a type is in.
export type { Card, FileSnapshot } from "./board";

type CardHead = {
  name: string;
  path: string;
  snapshot: FileSnapshot;
  head: string;
};

type StoreRead = {
  def: string | null;
  defSnapshot: FileSnapshot | null;
  cards: CardHead[];
  conflicts: string[];
  truncated: boolean;
};

export type StoreState = {
  dir: string;
  /** null until the first load resolves, or when the folder isn't a store. */
  def: StoreDef | null;
  cards: Card[];
  /** `store (conflict — …).jsonl` copies sync left behind, surfaced not hidden. */
  conflicts: string[];
  truncated: boolean;
  loading: boolean;
  error: string | null;
};

const MD_EXT_RE = /\.(md|markdown|mdown|mkd)$/i;

/** Strip what a file name can't hold. macOS refuses `/` and `:` — nothing else. */
export const sanitizeTitle = (title: string) =>
  title.replace(/[/:]/g, "-").replace(/\s+/g, " ").trim();

const cardOf = (head: CardHead): Card => {
  const fm = parseFrontmatter(head.head);
  return {
    path: head.path,
    name: head.name,
    title: head.name.replace(MD_EXT_RE, ""),
    snapshot: head.snapshot,
    props: fm.props,
    opaque: fm.opaque,
  };
};

type WriteErrorShape = { kind: "io" | "conflict"; message?: string; current?: FileSnapshot };
const isWriteError = (e: unknown): e is WriteErrorShape =>
  typeof e === "object" && e !== null && "kind" in e;

/* ---------- the model ---------- */

export class StoreModel {
  readonly dir: string;
  private state: StoreState;
  private defSnapshot: FileSnapshot | null = null;
  private listeners = new Set<(s: StoreState) => void>();
  private pendingWrites = 0;
  private reloadTimer: number | null = null;
  private disposed = false;
  /** Set once the folder turns out to be a store and a watcher is armed. */
  private watching = false;
  /** Refcount: the last holder to release tears the watcher down. */
  refs = 0;

  constructor(dir: string) {
    this.dir = dir;
    this.state = {
      dir,
      def: null,
      cards: [],
      conflicts: [],
      truncated: false,
      loading: true,
      error: null,
    };
  }

  get snapshot(): StoreState {
    return this.state;
  }

  subscribe(fn: (s: StoreState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(next: Partial<StoreState>) {
    this.state = { ...this.state, ...next };
    for (const fn of this.listeners) fn(this.state);
  }

  /** Re-read the folder. Cheap when the folder isn't a store: one stat. */
  async reload(): Promise<void> {
    if (this.disposed) return;
    // A rescan mid-write would show a torn board; the write's own `finally`
    // reloads once the last one settles.
    if (this.pendingWrites > 0) return;
    try {
      const exists = await invoke<boolean>("path_exists", {
        path: storeFileOf(this.dir),
      });
      if (!exists) {
        this.defSnapshot = null;
        this.emit({ def: null, cards: [], conflicts: [], loading: false, error: null });
        return;
      }
      // Only a real store gets a folder watcher. Any note's parent folder
      // acquires a model (that's how a card finds its board), and arming a
      // recursive watcher on every folder someone opens a note in would be a
      // steep price for a stat that usually says "not a store".
      if (!this.watching) {
        this.watching = true;
        void invoke("watch_dir", { path: this.dir }).catch((e) => {
          // A board still works without a watcher; it just won't self-refresh.
          this.watching = false;
          console.error("watch_dir failed", this.dir, e);
        });
      }
      const read = await invoke<StoreRead>("read_store", { path: this.dir });
      if (this.disposed) return;
      this.defSnapshot = read.defSnapshot;
      this.emit({
        def: read.def === null ? null : parseStoreDef(read.def),
        cards: read.cards.map(cardOf),
        conflicts: read.conflicts,
        truncated: read.truncated,
        loading: false,
        error: null,
      });
    } catch (e) {
      if (this.disposed) return;
      this.emit({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Coalesce the bursts a folder watcher produces into one rescan. */
  scheduleReload() {
    if (this.reloadTimer != null) window.clearTimeout(this.reloadTimer);
    this.reloadTimer = window.setTimeout(() => {
      this.reloadTimer = null;
      void this.reload();
    }, 150);
  }

  dispose() {
    this.disposed = true;
    this.listeners.clear();
    if (this.reloadTimer != null) window.clearTimeout(this.reloadTimer);
  }

  private async write<T>(fn: () => Promise<T>): Promise<T | null> {
    this.pendingWrites++;
    try {
      return await fn();
    } catch (e) {
      console.error("store write failed", this.dir, e);
      if (isWriteError(e) && e.kind === "conflict") {
        // Someone else got there first. Disk wins; the rescan below shows it.
        this.emit({ error: null });
      } else {
        this.emit({ error: e instanceof Error ? e.message : String(e) });
      }
      return null;
    } finally {
      this.pendingWrites--;
      if (this.pendingWrites === 0) void this.reload();
    }
  }

  /* ---------- card mutations ---------- */

  /** Replace a card's properties. The body on disk is untouched, byte for byte. */
  async setCardProps(path: string, next: Props): Promise<void> {
    const card = this.state.cards.find((c) => c.path === path);
    if (!card) return;
    const def = this.state.def;
    const head = serializeFrontmatter(
      next,
      card.opaque,
      def ? cardKeyOrder(def) : [RANK_KEY],
    );
    // Local state moves first so a drag lands under the pointer.
    this.emit({
      cards: this.state.cards.map((c) => (c.path === path ? { ...c, props: next } : c)),
    });
    await this.write(async () => {
      const snapshot = await invoke<FileSnapshot>("write_frontmatter", {
        path,
        head,
        expected: card.snapshot,
      });
      this.emit({
        cards: this.state.cards.map((c) => (c.path === path ? { ...c, snapshot } : c)),
      });
    });
  }

  /** Set one property, leaving the rest of the card's frontmatter alone. */
  async setCardProp(path: string, key: string, value: PropValue): Promise<void> {
    const card = this.state.cards.find((c) => c.path === path);
    if (!card) return;
    const next: Props = { ...card.props };
    if (value === null || value === "" || (Array.isArray(value) && value.length === 0)) {
      delete next[key];
    } else {
      next[key] = value;
    }
    await this.setCardProps(path, next);
  }

  /**
   * Drop a card into a column, between two of its neighbours. `value` is the
   * group-by option's name, or "" for the "No status" column (which clears
   * the field rather than writing an empty string).
   *
   * On a MULTI_SELECT board a card is in a column for every value it carries,
   * so a drag has to say which column it left: that value goes, the new one
   * comes, and the card's other values are none of this drag's business.
   * Dropping into the empty column means "none of them", and clears the field.
   */
  async moveCard(
    path: string,
    field: string,
    value: string,
    before: Card | null,
    after: Card | null,
    from?: string,
  ): Promise<void> {
    const card = this.state.cards.find((c) => c.path === path);
    if (!card) return;
    const next: Props = { ...card.props };
    const multi = this.state.def
      ? fieldOf(this.state.def, field)?.type === "multi_select"
      : false;
    if (value === "") {
      delete next[field];
    } else if (multi) {
      const kept = propList(card.props[field]).filter((v) => v !== "" && v !== from);
      next[field] = kept.includes(value) ? kept : [...kept, value];
    } else {
      next[field] = value;
    }
    next[RANK_KEY] = rankBetween(
      before ? cardRank(before) : null,
      after ? cardRank(after) : null,
    );
    await this.setCardProps(path, next);
  }

  /**
   * A new card at the foot of a column. Returns its path, or null when the
   * name was taken by something the app couldn't get past.
   */
  async createCard(title: string, props: Props): Promise<string | null> {
    const def = this.state.def;
    const clean = sanitizeTitle(title) || "Untitled";
    let target = `${this.dir}/${clean}.md`;
    for (let n = 2; n < 100; n++) {
      if (!(await invoke<boolean>("path_exists", { path: target }).catch(() => false))) {
        break;
      }
      target = `${this.dir}/${clean} ${n}.md`;
    }
    const head = serializeFrontmatter(props, [], def ? cardKeyOrder(def) : [RANK_KEY]);
    const created = await this.write(async () => {
      await invoke<FileSnapshot>("create_card", { path: target, head });
      return target;
    });
    return created ?? null;
  }

  /** The rank for a card appended after `cards`. */
  appendRank(cards: Card[]): string {
    const last = cards.length ? cards[cards.length - 1] : null;
    return rankBetween(last ? cardRank(last) : null, null);
  }

  /* ---------- definition mutations ---------- */

  private async writeDef(next: StoreDef): Promise<void> {
    this.emit({ def: next });
    await this.write(async () => {
      const snapshot = await invoke<FileSnapshot>("write_file", {
        path: storeFileOf(this.dir),
        contents: serializeStoreDef(next),
        expected: this.defSnapshot,
      });
      this.defSnapshot = snapshot;
    });
  }

  /** Add a column: a new option at the end of a field's list. */
  async addOption(field: string, name: string, color?: OptionColor): Promise<void> {
    const def = this.state.def;
    const clean = name.trim();
    if (!def || !clean) return;
    if (def.options.some((o) => o.field === field && o.name === clean)) return;
    const existing = orderedOptions(def, field);
    const rank = rankBetween(existing.length ? existing[existing.length - 1].rank : null, null);
    await this.writeDef({
      ...def,
      options: [...def.options, { field, name: clean, rank, ...(color ? { color } : {}) }],
    });
  }

  /**
   * Rename a column. The value lives in every card that uses it, so this is N
   * small writes — honest and visible, and the price of storing readable
   * values in the frontmatter instead of opaque ids.
   */
  async renameOption(field: string, from: string, to: string): Promise<void> {
    const def = this.state.def;
    const clean = to.trim();
    if (!def || !clean || clean === from) return;
    if (def.options.some((o) => o.field === field && o.name === clean)) return;
    await this.writeDef({
      ...def,
      options: def.options.map((o) =>
        o.field === field && o.name === from ? { ...o, name: clean } : o,
      ),
    });
    for (const card of this.state.cards) {
      if (cardValue(card, field) === from) await this.setCardProp(card.path, field, clean);
    }
  }

  async setOptionColor(field: string, name: string, color: OptionColor): Promise<void> {
    const def = this.state.def;
    if (!def) return;
    await this.writeDef({
      ...def,
      options: def.options.map((o) =>
        o.field === field && o.name === name ? { ...o, color } : o,
      ),
    });
  }

  /**
   * Delete a column. No card data is deleted: the cards keep their value and
   * reappear in a trailing "unknown value" column.
   */
  async deleteOption(field: string, name: string): Promise<void> {
    const def = this.state.def;
    if (!def) return;
    await this.writeDef({
      ...def,
      options: def.options.filter((o) => !(o.field === field && o.name === name)),
    });
  }

  /** Move a column between two of its neighbours. */
  async moveOption(
    field: string,
    name: string,
    before: Option | null,
    after: Option | null,
  ): Promise<void> {
    const def = this.state.def;
    if (!def) return;
    const rank = rankBetween(before?.rank ?? null, after?.rank ?? null);
    await this.writeDef({
      ...def,
      options: def.options.map((o) =>
        o.field === field && o.name === name ? { ...o, rank } : o,
      ),
    });
  }

  /** Adopt a value a card carries that no option declares. */
  async adoptValue(field: string, name: string): Promise<void> {
    await this.addOption(field, name);
  }

  /* ---------- fields ---------- */

  /**
   * Declare a new property. Its ID is the frontmatter key every card will
   * carry, so it is slugged once, at creation, and never changes again —
   * renaming a field renames what people READ, not what the files say.
   * Returns the id, or null when there was nothing to add.
   */
  async addField(name: string, type: FieldType): Promise<string | null> {
    const def = this.state.def;
    const clean = name.trim();
    if (!def || !clean) return null;
    const id = slugId(clean, new Set(def.fields.map((f) => f.id)));
    await this.writeDef({ ...def, fields: [...def.fields, { id, name: clean, type }] });
    return id;
  }

  /** Rename a field. The id — the key in every card — is untouched. */
  async renameField(id: string, name: string): Promise<void> {
    const def = this.state.def;
    const clean = name.trim();
    if (!def || !clean) return;
    await this.writeDef({
      ...def,
      fields: def.fields.map((f) => (f.id === id ? { ...f, name: clean } : f)),
    });
  }

  /**
   * Change what a field holds. No card is rewritten either: a value that was
   * text is still text on disk, it is simply read and edited as a date (or a
   * select, or a number) from now on. A value the new type can't make sense
   * of stays exactly as it is — the dialect keeps what it doesn't understand.
   */
  async retypeField(id: string, type: FieldType): Promise<void> {
    const def = this.state.def;
    if (!def) return;
    await this.writeDef({
      ...def,
      fields: def.fields.map((f) => (f.id === id ? { ...f, type } : f)),
    });
  }

  /**
   * Undeclare a field. No card is rewritten: the key stays in every file that
   * carries it and is preserved verbatim on the next write, the way a key
   * some other tool wrote always has been. Views that pointed at it drop the
   * reference so they don't sort or filter by something nobody can see.
   */
  async deleteField(id: string): Promise<void> {
    const def = this.state.def;
    if (!def) return;
    await this.writeDef({
      ...def,
      fields: def.fields.filter((f) => f.id !== id),
      options: def.options.filter((o) => o.field !== id),
      views: def.views.map((v) => ({
        ...v,
        filter: v.filter.filter((f) => f.field !== id),
        sort: v.sort?.field === id ? null : v.sort,
        show: v.show ? v.show.filter((f) => f !== id) : null,
      })),
    });
  }

  /* ---------- views ---------- */

  /** Save a new view. Returns its id, or null when there was nothing to add. */
  async addView(kind: ViewKind, name: string): Promise<string | null> {
    const def = this.state.def;
    const clean = name.trim();
    if (!def || !clean) return null;
    const id = slugId(clean, new Set(def.views.map((v) => v.id)));
    // A board needs a field to put in columns; a table needs none.
    const groupBy = kind === "kanban" ? (groupableFields(def)[0]?.id ?? "") : "";
    if (kind === "kanban" && !groupBy) return null;
    await this.writeDef({ ...def, views: [...def.views, newView(id, kind, clean, groupBy)] });
    return id;
  }

  /**
   * Change a view — its name, what it groups by, its filter, sort, shown
   * fields, or hidden columns. One mutation rather than six: they are all one
   * line of one file, and a view is only ever edited as a whole.
   *
   * Takes the view itself, not its id, because the one on screen may be
   * SYNTHETIC — a store whose definition never had a view record still opens
   * one (resolveView). Narrowing that view is how it gets saved.
   */
  async updateView(view: View, patch: Partial<Omit<View, "id" | "kind">>): Promise<void> {
    const def = this.state.def;
    if (!def) return;
    const next: View = { ...view, ...patch };
    const saved = def.views.some((v) => v.id === view.id);
    await this.writeDef({
      ...def,
      views: saved
        ? def.views.map((v) => (v.id === view.id ? next : v))
        : [...def.views, next],
    });
  }

  /** Forget a saved view. No card and no option is touched. */
  async deleteView(id: string): Promise<void> {
    const def = this.state.def;
    if (!def) return;
    await this.writeDef({ ...def, views: def.views.filter((v) => v.id !== id) });
  }
}

/**
 * An id for a name: lowercase, words joined by underscores, unique among
 * `taken`. Field ids become frontmatter keys, so the alphabet is deliberately
 * narrower than the dialect accepts — a key nobody has to quote.
 */
function slugId(name: string, taken: Set<string>): string {
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

/* ---------- registry + folder watch ---------- */

const models = new Map<string, StoreModel>();
let watching: Promise<UnlistenFn> | null = null;

function ensureWatchListener() {
  if (watching) return;
  watching = listen<{ root: string }>("dir-changed", (e) => {
    const model = models.get(e.payload.root);
    model?.scheduleReload();
  });
}

/**
 * The shared model for `dir`, loading on first acquire and watching the
 * folder while anyone holds it. Every caller must `release` exactly once.
 */
export function acquireStore(dir: string): StoreModel {
  ensureWatchListener();
  let model = models.get(dir);
  if (!model) {
    model = new StoreModel(dir);
    models.set(dir, model);
    void model.reload();
  }
  model.refs++;
  return model;
}

export function releaseStore(dir: string) {
  const model = models.get(dir);
  if (!model) return;
  model.refs--;
  if (model.refs > 0) return;
  models.delete(dir);
  model.dispose();
  void invoke("unwatch_dir", { path: dir }).catch(() => {});
}

/** Create `dir/store.jsonl`, turning a folder into a board. Refuses to
 *  overwrite a definition that is already there — the menu only offers this
 *  for a folder that isn't a board, but the tree it asks can be a moment out
 *  of date, and a board's columns are not something to clobber. */
export async function createStoreFile(dir: string, name: string): Promise<void> {
  const already = await invoke<boolean>("path_exists", {
    path: storeFileOf(dir),
  }).catch(() => false);
  if (already) throw new Error("This folder is already a board.");
  await invoke("write_file", {
    path: storeFileOf(dir),
    contents: serializeStoreDef(defaultStoreDef(name)),
    expected: null,
  });
  models.get(dir)?.scheduleReload();
}

export { STORE_FILE, storeFileOf };
