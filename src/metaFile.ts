// The entity meta file — one optional sidecar per document entity.
//
// A document entity is a stem: `notes.md`, its optional `notes.html`
// rendition, and now an optional `notes.meta.jsonl` holding everything the
// entity owns that isn't the prose itself. Today that is comment-thread
// BODIES for both renditions; the typed-record format leaves room for more
// (properties, tags) without another sidecar kind.
//
//   notes.md  +  notes.html  +  notes.meta.jsonl
//
// Like the html comments sidecar it replaces, the file is JSON Lines — a
// header line, then ONE record per line — because cloud sync merges files
// with a three-way *text* merge: two people adding threads concurrently
// merge cleanly line-by-line. Records are sorted by (type, id) and
// serialized with a fixed key order, so two devices writing the same
// logical state produce the same bytes (a concurrent one-time migration on
// two machines must converge, not conflict).
//
// Record types:
//   {"t":"hthread", id, anchor, comments}  — a rendition (html) thread,
//       exactly htmlComments.ts's HtmlThread; storage moved here from
//       <stem>.html.comments.jsonl (still read during the transition).
//   {"t":"mthread", id, comments}          — a markdown thread's BODY.
//       The anchor stays in the markdown itself as `{==anchor==}{>>#id<<}`
//       — a bare CriticMarkup reference. Text-embedded anchors survive
//       edits, external editors, and content merges; only the
//       conversations move out of the prose.
//   {"t":"tcols", id, cols}                — one table's column widths in
//       px (0 = auto). Unlike a thread this record has NO anchor in the
//       prose: its id is derived from the table's own shape (see
//       tableWidths.ts). Widths are a view preference, not content — worth
//       remembering, not worth writing a marker into someone's markdown
//       for — so identity is content-addressed and best-effort: a table
//       whose header row or column count changes outside the app simply
//       falls back to auto widths.
//   anything else                          — preserved verbatim (a newer
//       app version's records must survive a rewrite by this one).
//
// The DISK markdown is the hybrid form (markers only); the EDITOR keeps
// speaking the full inline form. expandMarkdown /
// extractMarkdown convert at the IO boundary, and expand∘extract is the
// identity on a migrated file, which is what makes the one-time migration
// safe to re-run anywhere, any number of times.

import {
  CRITIC_BLOCK_RE,
  parseSpans,
  formatThreadSpans,
  type CommentEntry,
} from "./criticMarkup";
import type { HtmlThread, HtmlAnchor } from "./htmlComments";

export type MdThread = { id: string; comments: CommentEntry[] };

// One table's persisted column widths: `cols[i]` is column i's width in
// CSS px, 0 meaning "auto" (never resized). Dense — one slot per column —
// so the array's length doubles as a shape check against the live table.
export type TableCols = { id: string; cols: number[] };

// A record this app version doesn't understand, carried through rewrites.
// `sortId` is whatever `id` the line declared ("" when it had none).
export type ForeignRecord = { t: string; sortId: string; raw: string };

export type EntityMeta = {
  mthreads: MdThread[];
  hthreads: HtmlThread[];
  tcols: TableCols[];
  foreign: ForeignRecord[];
};

export const emptyMeta = (): EntityMeta => ({
  mthreads: [],
  hthreads: [],
  tcols: [],
  foreign: [],
});

const HEADER = `{"doklin":"meta","v":1}`;

// Mirrors App.tsx's document extension rules (a document is markdown, html,
// or the same-stem pair) — the meta file is named by the shared stem.
const MD_EXT_RE = /\.(md|markdown|mdown|mkd)$/i;
const HTML_EXT_RE = /\.html$/i;
export const META_SUFFIX = ".meta.jsonl";

export const stemOf = (docPath: string) =>
  docPath.replace(MD_EXT_RE, "").replace(HTML_EXT_RE, "");

export const metaFileOf = (docPath: string) => stemOf(docPath) + META_SUFFIX;

/* ---------- parse / serialize ---------- */

const isEntry = (value: unknown): value is CommentEntry => {
  const e = value as CommentEntry;
  return (
    !!e &&
    typeof e === "object" &&
    typeof e.author === "string" &&
    typeof e.at === "number" &&
    typeof e.body === "string"
  );
};

// A width array: finite, non-negative, integral px. Anything else (NaN from
// a bad merge, a negative from a hand edit) disqualifies the whole record —
// a partially-applied width set would render worse than none.
const isColWidths = (value: unknown): value is number[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0);

const isAnchor = (value: unknown): value is HtmlAnchor => {
  const a = value as HtmlAnchor;
  return (
    !!a &&
    typeof a === "object" &&
    typeof a.path === "string" &&
    typeof a.tag === "string" &&
    typeof a.text === "string"
  );
};

// Tolerant parse, same posture as the html sidecar's: skip the header, skip
// malformed lines (a sync conflict marker or hand edit must never take every
// thread down with it), fold duplicate (type, id) pairs — first wins.
export function parseEntityMeta(raw: string): EntityMeta {
  const meta = emptyMeta();
  const seen = new Set<string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const r = obj as { t?: unknown; id?: unknown; doklin?: unknown } & Record<string, unknown>;
    if (!r || typeof r !== "object") continue;
    if (typeof r.doklin === "string") continue; // header line
    if (typeof r.t !== "string" || r.t === "") continue;
    const id = typeof r.id === "string" ? r.id : "";
    const key = `${r.t} ${id}`;
    if (seen.has(key)) continue;
    if (r.t === "mthread") {
      if (id === "" || !Array.isArray(r.comments) || !r.comments.every(isEntry)) continue;
      seen.add(key);
      meta.mthreads.push({ id, comments: r.comments as CommentEntry[] });
    } else if (r.t === "hthread") {
      if (
        id === "" ||
        !isAnchor(r.anchor) ||
        !Array.isArray(r.comments) ||
        !r.comments.every(isEntry)
      ) {
        continue;
      }
      seen.add(key);
      meta.hthreads.push({
        id,
        anchor: r.anchor as HtmlAnchor,
        comments: r.comments as CommentEntry[],
      });
    } else if (r.t === "tcols") {
      if (id === "" || !isColWidths(r.cols)) continue;
      seen.add(key);
      meta.tcols.push({ id, cols: r.cols.map((n) => Math.round(n)) });
    } else {
      seen.add(key);
      meta.foreign.push({ t: r.t, sortId: id, raw: trimmed });
    }
  }
  return meta;
}

// Fixed key order (insertion order survives JSON.stringify) so equal state
// serializes to equal bytes on every device.
const canonicalEntry = (e: CommentEntry): CommentEntry => {
  const out: CommentEntry = { author: e.author, at: e.at, body: e.body };
  if (e.eid !== undefined) out.eid = e.eid;
  if (e.codeId !== undefined) out.codeId = e.codeId;
  if (e.label !== undefined) out.label = e.label;
  return out;
};

export function serializeEntityMeta(meta: EntityMeta): string {
  type Row = { key: string; line: string };
  const rows: Row[] = [];
  for (const t of meta.hthreads) {
    rows.push({
      key: `hthread ${t.id}`,
      line: JSON.stringify({
        t: "hthread",
        id: t.id,
        anchor: { path: t.anchor.path, tag: t.anchor.tag, text: t.anchor.text },
        comments: t.comments.map(canonicalEntry),
      }),
    });
  }
  for (const t of meta.mthreads) {
    rows.push({
      key: `mthread ${t.id}`,
      line: JSON.stringify({
        t: "mthread",
        id: t.id,
        comments: t.comments.map(canonicalEntry),
      }),
    });
  }
  for (const t of meta.tcols) {
    rows.push({
      key: `tcols ${t.id}`,
      line: JSON.stringify({ t: "tcols", id: t.id, cols: t.cols }),
    });
  }
  for (const f of meta.foreign) {
    rows.push({ key: `${f.t} ${f.sortId} ${f.raw}`, line: f.raw });
  }
  rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return [HEADER, ...rows.map((r) => r.line)].join("\n") + "\n";
}

// Does this meta carry anything worth a file on disk?
export const metaIsEmpty = (meta: EntityMeta): boolean =>
  meta.mthreads.length === 0 &&
  meta.hthreads.length === 0 &&
  meta.tcols.length === 0 &&
  meta.foreign.length === 0;

/* ---------- entry / thread union (fold-ins) ---------- */

// An entry's identity for folding two copies of a thread: the eid when one
// was stamped, else author+time (stable across body edits). First side wins
// the body.
const entryFoldKey = (e: CommentEntry): string => e.eid ?? `${e.author}|${e.at}`;

function unionEntries(a: CommentEntry[], b: CommentEntry[]): CommentEntry[] {
  const have = new Set(a.map(entryFoldKey));
  const extra = b.filter((e) => !have.has(entryFoldKey(e)));
  extra.sort((x, y) => x.at - y.at);
  return [...a, ...extra];
}

// Union two thread lists by id; on both sides, entries union (a wins body
// conflicts). Works for MdThread and HtmlThread alike (b's anchor is kept
// only when a lacks the thread — a's copy is "ours").
export function unionThreads<T extends { id: string; comments: CommentEntry[] }>(
  a: T[],
  b: T[],
): T[] {
  const ours = new Set(a.map((t) => t.id));
  const out: T[] = a.map((t) => {
    const other = b.find((x) => x.id === t.id);
    return other ? { ...t, comments: unionEntries(t.comments, other.comments) } : t;
  });
  for (const t of b) if (!ours.has(t.id)) out.push(t);
  return out;
}

/* ---------- expand / extract: the disk ⇄ editor boundary ---------- */

// A deterministic id derived from content: two machines looking at the same
// material mint the same id, so their independent rewrites of this file stay
// byte-identical. Salted by an occurrence index so identical material
// appearing twice in one document still gets two ids. FNV-1a, twice with
// different seeds — no async, no crypto dependency.
function fnv1a(s: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function deriveId(material: string, index: number): string {
  const src = `${index} ${material}`;
  const id = (
    fnv1a(src, 0x811c9dc5).toString(36) + fnv1a(src, 0x01234567).toString(36)
  ).replace(/[^a-z0-9]/g, "");
  return (id + "000000").slice(0, 8);
}

// The id for a thread that arrived without one (hand-written or legacy
// CriticMarkup) — see extractMarkdown.
export const deriveThreadId = deriveId;

export type ExpandResult = {
  md: string;
  // Meta threads that found no marker in the markdown — kept, surfaced as
  // orphans in the rail, never silently dropped (same posture as html
  // threads whose anchor stopped resolving).
  orphanIds: string[];
};

// Disk → editor: re-inline each thread's body onto the FIRST run of its
// marker (later runs stay bare refs; the parser folds runs by id and the
// first run's entries win — matching the serializer's own multi-run shape).
// A marker whose id has no meta body is left alone: with entries inline it
// IS the body (old format / an old device's write / a web pull), and both
// present means both survive — entries union, inline side winning bodies.
export function expandMarkdown(md: string, mthreads: MdThread[]): ExpandResult {
  const bodies = new Map(mthreads.map((t) => [t.id, t.comments]));
  const rooted = new Set<string>();
  const re = new RegExp(CRITIC_BLOCK_RE.source, "g");
  const out = md.replace(re, (whole, anchor: string, spans: string) => {
    const parsed = parseSpans(spans);
    if (parsed.kind === "ref") {
      const meta = bodies.get(parsed.id);
      if (!rooted.has(parsed.id) && meta && meta.length > 0) {
        rooted.add(parsed.id);
        return `{==${anchor}==}${formatThreadSpans(parsed.id, meta)}`;
      }
      return whole;
    }
    if (parsed.id !== null) {
      const meta = bodies.get(parsed.id);
      if (rooted.has(parsed.id)) return whole; // a later full run; parser folds it
      rooted.add(parsed.id);
      if (meta && meta.length > 0) {
        return `{==${anchor}==}${formatThreadSpans(
          parsed.id,
          unionEntries(parsed.comments, meta),
        )}`;
      }
    }
    return whole;
  });
  const orphanIds = mthreads.filter((t) => !rooted.has(t.id)).map((t) => t.id);
  return { md: out, orphanIds };
}

// Every thread id a markdown document mentions (root runs and bare refs
// alike) — the live/orphan divider: a meta record whose id is absent here
// has lost its marker.
export function markerIds(md: string): Set<string> {
  const ids = new Set<string>();
  const re = new RegExp(CRITIC_BLOCK_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    const parsed = parseSpans(m[2]);
    if (parsed.id !== null) ids.add(parsed.id);
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  return ids;
}

export type ExtractResult = { md: string; mthreads: MdThread[] };

// Editor → disk: move each thread's entries out to a record, leaving the
// bare `{==anchor==}{>>#id<<}` marker. First run of an id wins the record
// (the parser's own rule); every run flattens to a bare ref. Legacy spans
// with no id get a deterministic content-derived one. A bare ref whose root
// never appears is left untouched and yields no record — its body, if any,
// lives in the meta file already.
export function extractMarkdown(fullMd: string): ExtractResult {
  // Pre-pass: every explicit id the document declares anywhere, so a derived
  // legacy id can never collide with one that appears later on.
  const reserved = new Set<string>();
  {
    const scan = new RegExp(CRITIC_BLOCK_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = scan.exec(fullMd)) !== null) {
      const parsed = parseSpans(m[2]);
      if (parsed.id !== null) reserved.add(parsed.id);
      if (scan.lastIndex === m.index) scan.lastIndex++;
    }
  }
  const records: MdThread[] = [];
  const seen = new Set<string>();
  let legacySeq = 0;
  const re = new RegExp(CRITIC_BLOCK_RE.source, "g");
  const md = fullMd.replace(re, (whole, anchor: string, spans: string) => {
    const parsed = parseSpans(spans);
    if (parsed.kind === "ref") return whole;
    let id = parsed.id;
    if (id === null) {
      do {
        id = deriveThreadId(`${anchor} ${spans}`, legacySeq++);
      } while (reserved.has(id));
      reserved.add(id);
    }
    if (!seen.has(id)) {
      seen.add(id);
      if (parsed.comments.length > 0) records.push({ id, comments: parsed.comments });
    }
    return `{==${anchor}==}{>>#${id}<<}`;
  });
  return { md, mthreads: records };
}

/* ---------- the one-time migration, as a pure step ---------- */

export type MigrateInput = {
  diskMd: string | null; // null: an html-only entity (no markdown side)
  meta: EntityMeta;
  // Threads parsed from a legacy <stem>.html.comments.jsonl, when one exists.
  legacyHtmlThreads: HtmlThread[] | null;
};

export type MigrateResult = {
  md: string | null;
  meta: EntityMeta;
  mdChanged: boolean;
  metaChanged: boolean;
};

// Normalize an entity to the hybrid layout. Pure and idempotent: running it
// on an already-migrated entity changes nothing, so it is safe on every
// open, on every device, concurrently (writes race on snapshots upstream).
export function migrateEntity(input: MigrateInput): MigrateResult {
  const before = serializeEntityMeta(input.meta);
  let md: string | null = input.diskMd;
  let mthreads = input.meta.mthreads;
  if (input.diskMd !== null) {
    const expanded = expandMarkdown(input.diskMd, input.meta.mthreads);
    const extracted = extractMarkdown(expanded.md);
    const orphanSet = new Set(expanded.orphanIds);
    md = extracted.md;
    mthreads = [
      ...extracted.mthreads,
      ...input.meta.mthreads.filter((t) => orphanSet.has(t.id)),
    ];
  }
  const hthreads = input.legacyHtmlThreads
    ? unionThreads(input.meta.hthreads, input.legacyHtmlThreads)
    : input.meta.hthreads;
  // Table widths have no old format to migrate from and no anchor in the
  // prose to reconcile against — they ride through untouched.
  const meta: EntityMeta = {
    mthreads,
    hthreads,
    tcols: input.meta.tcols,
    foreign: input.meta.foreign,
  };
  return {
    md,
    meta,
    mdChanged: input.diskMd !== null && md !== input.diskMd,
    metaChanged: serializeEntityMeta(meta) !== before,
  };
}
