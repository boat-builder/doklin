// Search: which documents are called this or contain this text, with the
// lines — the question the app's own search asks (`search_workspace`,
// src-tauri/src/lib.rs), answered for a caller that has no copy of the folder.
//
//   GET /api/agent/search?q=&dir=&limit=      an agent's (agentDocs.ts)
//   GET /api/web/search?q=&limit=             a person's in a browser (webDocs.ts)
//
// A Worker cannot read every document on every search: each is a blob read,
// and a request may make fifty. So the text is mirrored into D1, one row per
// document, lower-cased, and a search is one scan there (`instr`). The rows
// that match — at most `limit` of them — are then read from the bucket to cut
// the matching lines.
//
// There is one mirror per section — the shared workspace's, and one for each
// space — so a search scans the text of the sections its caller's person can
// see and of no other. Searching the workspace itself covers every one of
// them, up to what a request can open (`sectionsNotSearched` names the rest).
//
// A mirror is derived and lazy:
//
//   · `search_state.held` records, for every row, the content hashes it was
//     read from. Comparing it with the manifest says what is stale in one
//     row read; nothing is scanned to find out.
//   · A search catches the mirror up before it answers. A few stale
//     documents are read in the same request; more than that and the answer
//     is `202` with how many are left, and the caller asks again.
//   · A change the worker itself makes — an agent's, or a person's in a
//     browser — catches up straight away, so they find what they just wrote. A change made on a Mac is caught up by
//     the next search — deliberately not on the Mac's own manifest PUT, which
//     would spend a database write on every save for a mirror nobody may ask.
//   · Until somebody searches there is no mirror, and nothing here costs
//     anything.
//
// A document's name is read off the manifest, not the mirror: it is never
// stale, a rename costs the mirror nothing, and a document found by its name
// alone costs no read.
//
// It is the database or nothing: a database that cannot answer is a 503 to a
// search, and costs nothing else.
//
// The same catch-up keeps the `links` index: for each note it reads, the
// files it links to (`targetsOf`), so "which documents link to this one" is
// one query too (`linkersOf`, for `doklin links --to`).

import { Refusal, type Committed } from "./commit";
import { Index, nameOf, type Entry } from "./documents";
import type { Env } from "./env";
import { textOf } from "./htmlText";
import { LIBRARY_FOLDER, SEARCH_LIMIT_MAX, blobKey } from "./layout";
import type { Manifest } from "./manifest";
import { PRIVATE_FOLDER, RESTRICTED_FOLDER } from "./agentPlace";
import { linksIn } from "./noteLinks";
import { ensureSchema } from "./schema";
import { MAX_SECTIONS_READ, sharedEnv, spaceOf, type Where } from "./spaces";
import { basename, isHtmlPath, isMarkdownPath, openWorkspace, type Workspace } from "./workspace";
import { stripComments } from "../../src/criticMarkup";
import { keyTarget, linkKey } from "../../src/docLinks";
import { META_SUFFIX, parseEntityMeta } from "../../src/metaFile";
import { pageLinkOf } from "../../src/pageLink";

/** A document whose text and comments together pass this is not mirrored —
 *  D1 holds a row of two megabytes at most — and is listed as not searchable. */
const MAX_MIRRORED_BYTES = 1024 * 1024;
/** Blob reads one catch-up may make, and the text it may carry. */
const CATCH_UP_READS = 36;
const CATCH_UP_BYTES = 1024 * 1024;
/** Stale documents a search still catches up and answers in one request. */
const INLINE_READS = 8;
const DEFAULT_LIMIT = 20;
/** Matching lines shown per document. */
const MAX_LINES = 5;
const LINE_PREVIEW = 200;
const READ_CONCURRENCY = 6;
/** Reads of the bucket one search makes at most, of the fifty a request may:
 *  opening its sections, catching up, and cutting lines. */
const SEARCH_READS = 44;

type Held = Record<string, string>;
type State = { etag: string; held: Held };

/** One document as search sees it: keyed by its markdown file, or by its
 *  html when it has no markdown. */
type Searchable = { text: Entry; meta: Entry | null; signature: string };

/** Every document the manifest holds, by the file id its mirror row is keyed on. */
function searchable(m: Manifest): Map<string, Searchable> {
  const index = new Index(m.files);
  const out = new Map<string, Searchable>();
  for (const [fid, file] of Object.entries(m.files)) {
    const md = isMarkdownPath(file.path);
    if (!md && !isHtmlPath(file.path)) continue;
    const { stem } = nameOf(file.path);
    // An html file beside its markdown is that document's other version,
    // not a document of its own.
    if (!md && index.doc(stem).md) continue;
    const meta = index.at(`${stem}${META_SUFFIX}`);
    out.set(fid, { text: { fid, file }, meta, signature: `${file.hash}.${meta?.file.hash ?? ""}` });
  }
  return out;
}

async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const blobText = async (env: Env, e: Entry): Promise<string | null> => {
  const obj = await env.DATA.get(blobKey(e.fid, e.file.hash));
  return obj ? obj.text() : null;
};

/** What a document says, as search reads it: its text without comment
 *  markers (or an html page's visible text), then every comment body. */
function folded(path: string, text: string, metaText: string | null): string {
  const said = isMarkdownPath(path) ? stripComments(text) : textOf(text);
  const meta = metaText === null ? null : parseEntityMeta(metaText);
  const bodies = meta ? [...meta.mthreads, ...meta.hthreads].flatMap((t) => t.comments.map((c) => c.body)) : [];
  return [said, ...bodies].join("\n").toLowerCase();
}

/* ---------- What a note links to ---------- */

/** What a note's links are read against: Library's manifest, as it stores
 *  its paths, and the workspace's id, which a *Copy link* to one of its
 *  pages names. */
type Around = { library: Manifest | null; workspace: string | null };

/** A manifest's files by their path, lower-cased: the workspace lives on a
 *  case-insensitive disk. */
function lowerPaths(m: Manifest): Map<string, string> {
  const out = new Map<string, string>();
  for (const [fid, f] of Object.entries(m.files)) if (!out.has(f.path.toLowerCase())) out.set(f.path.toLowerCase(), fid);
  return out;
}

/**
 * The files the note at `path` in `space` links to, for the `links` index.
 * A link with a record names its file; so does a *Copy link* to a page of
 * this workspace. A link without either goes by its path, under rule 3 of
 * what a save writes (`linksToSave`, src/docLinks.ts): only into the note's
 * own section or into Library, never from outside into a Private or a
 * restricted folder. A restricted folder's name is each person's own
 * (agentPlace.ts), so a path that names one, the note's own included, is
 * not followed.
 */
function targetsOf(
  space: string,
  path: string,
  text: string,
  metaText: string | null,
  own: () => Map<string, string>,
  library: () => Map<string, string> | null,
  workspace: string | null,
): string[] {
  const records = metaText === null ? [] : parseEntityMeta(metaText).links;
  const mount = space === "" ? LIBRARY_FOLDER : space.startsWith("p-") ? PRIVATE_FOLDER : `${RESTRICTED_FOLDER}/\u0000`;
  const out = new Set<string>();
  for (const link of linksIn(text)) {
    const page = pageLinkOf(link.href);
    if (page) {
      if (workspace !== null && page.workspace === workspace && page.file !== "") out.add(page.file);
      continue;
    }
    const key = linkKey(link.href);
    if (key === null) continue;
    const record = records.find((r) => r.id === key);
    if (record) {
      out.add(record.file);
      continue;
    }
    const target = keyTarget(key, `${mount}/${path}`)?.toLowerCase();
    if (target === undefined) continue;
    const inOwn = target.startsWith(`${mount.toLowerCase()}/`);
    const inLibrary = !inOwn && target.startsWith(`${LIBRARY_FOLDER.toLowerCase()}/`);
    const fid = inOwn
      ? own().get(target.slice(mount.length + 1))
      : inLibrary
        ? library()?.get(target.slice(LIBRARY_FOLDER.length + 1))
        : undefined;
    if (fid !== undefined) out.add(fid);
  }
  return [...out];
}

/** Rows of the `links` index, a statement for each 33 (D1 binds at most a
 *  hundred values). */
function linkRows(db: D1Database, space: string, rows: readonly { fid: string; targets: readonly string[] }[]): D1PreparedStatement[] {
  const all = rows.flatMap((r) => r.targets.filter((t) => t !== r.fid).map((t) => [space, r.fid, t]));
  const out: D1PreparedStatement[] = [];
  for (let i = 0; i < all.length; i += 33) {
    const chunk = all.slice(i, i + 33);
    out.push(
      db.prepare(`INSERT OR IGNORE INTO links (space_id, fid, target) VALUES ${chunk.map(() => "(?, ?, ?)").join(", ")}`).bind(...chunk.flat()),
    );
  }
  return out;
}

const readHeld = (etag: string, raw: string): State => {
  try {
    const held: unknown = JSON.parse(raw);
    if (held !== null && typeof held === "object" && !Array.isArray(held)) return { etag, held: held as Held };
  } catch {
    // an unreadable map is an empty mirror: everything is read again
  }
  return { etag: "", held: {} };
};

/** Where each of these spaces' mirrors is; a space nobody has searched has
 *  no entry. */
async function readStates(db: D1Database, spaces: readonly string[]): Promise<Map<string, State>> {
  const { results } = await db
    .prepare(`SELECT space_id, etag, held FROM search_state WHERE space_id IN (${spaces.map(() => "?").join(",")})`)
    .bind(...spaces)
    .all<{ space_id: string; etag: string; held: string }>();
  return new Map(results.map((r) => [r.space_id, readHeld(r.etag, r.held)]));
}

/**
 * Bring the mirror of the space `env` is scoped to towards its manifest:
 * read what is stale, drop what is gone, and record what the rows now hold —
 * text and links alike, in one batch, so a row and the record of it never
 * disagree. Answers how many documents are still stale and how many blobs
 * this round read. `around` is asked for once, when a note is read.
 */
async function catchUp(
  env: Env,
  db: D1Database,
  etag: string,
  m: Manifest,
  state: State,
  maxReads: number,
  around: () => Promise<Around>,
): Promise<{ pending: number; reads: number }> {
  const space = spaceOf(env);
  const want = searchable(m);
  const stale = [...want].filter(([fid, w]) => state.held[fid] !== w.signature);
  const dead = Object.keys(state.held).filter((fid) => !want.has(fid));
  if (stale.length === 0 && dead.length === 0) {
    if (state.etag !== etag) {
      await db
        .prepare("INSERT OR REPLACE INTO search_state (space_id, etag, held) VALUES (?, ?, ?)")
        .bind(space, etag, JSON.stringify(state.held))
        .run();
    }
    return { pending: 0, reads: 0 };
  }
  // This request has read what it can: the next one goes on from here.
  if (stale.length > 0 && maxReads <= 0) return { pending: stale.length, reads: 0 };

  // As many as this round's budget allows — and always one, however large.
  const round: [string, Searchable][] = [];
  let reads = 0;
  let bytes = 0;
  for (const item of stale) {
    const w = item[1];
    const size = w.text.file.size + (w.meta?.file.size ?? 0);
    const tooLarge = size > MAX_MIRRORED_BYTES;
    const cost = tooLarge ? 0 : 1 + (w.meta ? 1 : 0);
    if (round.length > 0 && (reads + cost > maxReads || bytes + (tooLarge ? 0 : size) > CATCH_UP_BYTES)) break;
    reads += cost;
    bytes += tooLarge ? 0 : size;
    round.push(item);
  }

  const context = round.some(([, w]) => isMarkdownPath(w.text.file.path)) ? await around() : { library: null, workspace: null };
  let ownPaths: Map<string, string> | undefined;
  let libraryPaths: Map<string, string> | null | undefined;
  const own = () => (ownPaths ??= lowerPaths(m));
  const library = () => (libraryPaths ??= context.library ? lowerPaths(context.library) : null);
  const rows = await mapLimited(round, READ_CONCURRENCY, async ([fid, w]) => {
    if (w.text.file.size + (w.meta?.file.size ?? 0) > MAX_MIRRORED_BYTES) return { fid, w, text: null as string | null, targets: [] as string[] };
    const [text, metaText] = await Promise.all([blobText(env, w.text), w.meta ? blobText(env, w.meta) : Promise.resolve(null)]);
    // A blob that is not there yet is a sync still in flight: leave the row
    // stale, and the next catch-up reads it.
    if (text === null) return null;
    const path = w.text.file.path;
    const targets = isMarkdownPath(path) ? targetsOf(space, path, text, metaText, own, library, context.workspace) : [];
    return { fid, w, text: folded(path, text, metaText), targets };
  });

  const held: Held = { ...state.held };
  for (const fid of dead) delete held[fid];
  const statements: D1PreparedStatement[] = [];
  const read: { fid: string; targets: string[] }[] = [];
  let missed = 0;
  for (const row of rows) {
    if (row === null) {
      missed += 1;
      continue;
    }
    held[row.fid] = row.w.signature;
    read.push(row);
    statements.push(
      db.prepare("INSERT OR REPLACE INTO search_text (space_id, fid, folded) VALUES (?, ?, ?)").bind(space, row.fid, row.text),
    );
  }
  // What a note read again links to replaces what it did; a note gone links to nothing.
  const forgotten = [...dead, ...read.map((r) => r.fid)];
  for (let i = 0; i < forgotten.length; i += 50) {
    const chunk = forgotten.slice(i, i + 50);
    statements.push(
      db.prepare(`DELETE FROM links WHERE space_id = ? AND fid IN (${chunk.map(() => "?").join(",")})`).bind(space, ...chunk),
    );
  }
  statements.push(...linkRows(db, space, read));
  for (let i = 0; i < dead.length; i += 50) {
    const chunk = dead.slice(i, i + 50);
    statements.push(
      db.prepare(`DELETE FROM search_text WHERE space_id = ? AND fid IN (${chunk.map(() => "?").join(",")})`).bind(space, ...chunk),
    );
  }
  const pending = stale.length - round.length + missed;
  statements.push(
    db
      .prepare("INSERT OR REPLACE INTO search_state (space_id, etag, held) VALUES (?, ?, ?)")
      .bind(space, pending === 0 ? etag : "", JSON.stringify(held)),
  );
  await db.batch(statements);
  return { pending, reads };
}

/**
 * After a change made through the document API: catch the mirror of the
 * section it was made in up to the manifest that change just stored — when
 * there is a mirror. Runs after the response where the runtime allows it,
 * and never fails the change it follows.
 */
export async function mirrorAfter(c: { env: Env; ctx: ExecutionContext | undefined }, done: Committed<unknown>): Promise<void> {
  if (!done.wrote) return;
  const work = (async (): Promise<void> => {
    const db = c.env.DB;
    if (!db) return;
    try {
      if ((await ensureSchema(c.env)) == null) return;
      const state = (await readStates(db, [spaceOf(c.env)])).get(spaceOf(c.env));
      if (!state) return; // nobody has searched here: there is no mirror to keep
      await catchUp(c.env, db, done.etag, done.manifest, state, INLINE_READS, () => aroundOf(c.env, spaceOf(c.env) === "" ? done.manifest : null));
    } catch {
      // the next search catches up instead
    }
  })();
  if (c.ctx) c.ctx.waitUntil(work);
  else await work;
}

/** What a section's notes are read against (`Around`): Library's manifest —
 *  `library` when it is in hand — and the workspace's id. */
async function aroundOf(env: Env, library: Manifest | null): Promise<Around> {
  const shared = await openWorkspace(sharedEnv(env));
  return { library: library ?? shared?.manifest ?? null, workspace: shared?.record?.id ?? null };
}

/** A section opened for reading its mirror: its tree and the documents in it. */
type Opened = { section: Where; ws: Workspace; want: Map<string, Searchable> };

/**
 * Open `sections` — as many as a request opens, `left` the rest — and catch
 * their mirrors up. `{ indexing }` when there was more to read than one
 * request reads; `reads` is what this one read.
 */
async function caughtUp(
  env: Env,
  sections: readonly Where[],
): Promise<{ open: Opened[]; left: Where[]; reads: number; db: D1Database } | { indexing: number } | Refusal> {
  const unavailable = (): Refusal => new Refusal(503, "search needs this domain's database, which isn't answering — try again in a moment");
  const covered = sections.slice(0, 1 + MAX_SECTIONS_READ);
  const left = sections.slice(covered.length);
  const open: Opened[] = [];
  for (const section of covered) {
    const ws = await openWorkspace(section.env);
    if (ws) open.push({ section, ws, want: searchable(ws.manifest) });
    else if (section.space === "") return new Refusal(404, "this domain holds no workspace yet");
  }
  const db = env.DB;
  if (!db) return unavailable();
  const shared = open.find((o) => o.section.space === "")?.ws;
  let around: Promise<Around> | undefined;
  const aroundOnce = (): Promise<Around> =>
    (around ??= shared ? Promise.resolve({ library: shared.manifest, workspace: shared.record?.id ?? null }) : aroundOf(env, null));
  try {
    if ((await ensureSchema(env)) == null) return unavailable();
    let reads = 0;
    if (open.length > 0) {
      const states = await readStates(db, open.map((o) => o.section.space));
      let pending = 0;
      for (const { section, ws } of open) {
        const state = states.get(section.space) ?? { etag: "", held: {} };
        if (state.etag === ws.etag) continue;
        const round = await catchUp(section.env, db, ws.etag, ws.manifest, state, CATCH_UP_READS - reads, aroundOnce);
        pending += round.pending;
        reads += round.reads;
      }
      // A round that read more than a handful has used this request's
      // budget; the answer comes on the next one.
      if (pending > 0 || reads > INLINE_READS) return { indexing: pending };
    }
    return { open, left, reads, db };
  } catch {
    return unavailable();
  }
}

export type Match = { line?: number; text: string };

/** The lines of a document that contain the needle. Markdown lines are
 *  numbered as the file numbers them; an html page's are its text, unnumbered. */
function matchingLines(path: string, text: string, needle: string): { matches: Match[]; total: number } {
  const md = isMarkdownPath(path);
  const lines = (md ? text : textOf(text)).split("\n");
  const matches: Match[] = [];
  let total = 0;
  lines.forEach((raw, i) => {
    const line = md ? stripComments(raw) : raw;
    if (!line.toLowerCase().includes(needle)) return;
    total += 1;
    if (matches.length < MAX_LINES) matches.push({ ...(md ? { line: i + 1 } : {}), text: line.trim().slice(0, LINE_PREVIEW) });
  });
  return { matches, total };
}

/** A path in a section, as the caller names it. */
const under = (mount: string, path: string): string => (mount ? `${mount}/${path}` : path);

/** Whether a document is called something holding the needle: its file name
 *  without the extension, as the sidebar shows it — not its folders'. */
const isCalled = (path: string, needle: string): boolean => basename(nameOf(path).stem).toLowerCase().includes(needle);

/** A document a search found: by its name, by its mirror row — `text` when
 *  the row holds the needle, `big` when it was too large to mirror — or both. */
type Found = { doc: Searchable; section: Where; path: string; named: boolean; row: "text" | "big" | null };

/** What to search for: one line of text, in the documents under `dir` ("" is
 *  everything the sections hold), at most `limit` of them. */
export type Ask = { query: string; dir: string; limit: number };

/** What a request's `q` and `limit` ask for, or why they ask for nothing. */
export function askOf(params: URLSearchParams, dir: string): Ask | Refusal {
  const query = (params.get("q") ?? "").trim();
  if (query === "") return new Refusal(400, "say what to search for");
  if (/[\r\n]/.test(query)) return new Refusal(400, "search for text within one line");
  const asked = Number(params.get("limit") ?? DEFAULT_LIMIT);
  const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, SEARCH_LIMIT_MAX) : DEFAULT_LIMIT;
  return { query, dir, limit };
}

/** One document a search found. */
export type Hit = {
  /** The section it is in, and its file there: the markdown, or the html of
   *  a document that has no markdown. */
  space: string;
  fid: string;
  /** That file's path, as the caller names paths. */
  path: string;
  matches: Match[];
  /** Matching lines beyond the ones in `matches`. */
  moreLines: number;
  /** Its name holds the text. */
  inName: boolean;
  /** Its text does not, on any line: the text was said in a comment. */
  inComments: boolean;
};

export type Searched = {
  hits: Hit[];
  /** Every document that matched, shown or not. */
  total: number;
  /** Documents too large to mirror, and not found by name either: never
   *  searched, and said so. */
  notSearched: { space: string; path: string }[];
  /** Sections beyond what one request opens. */
  left: Where[];
};

/**
 * Search `sections`. `{ indexing }` when the mirror had more to catch up on
 * than one request reads — that many documents are left, and the caller asks
 * again.
 */
export async function searchIn(
  env: Env,
  sections: readonly Where[],
  { query, dir, limit }: Ask,
): Promise<Searched | { indexing: number } | Refusal> {
  const needle = query.toLowerCase();
  const unavailable = (): Refusal => new Refusal(503, "search needs this domain's database, which isn't answering — try again in a moment");
  const up = await caughtUp(env, sections);
  if (up instanceof Refusal || "indexing" in up) return up;
  const { open, left, db } = up;

  const spent = 2 * open.length + up.reads;
  let rows: { space_id: string; fid: string; big: number }[] = [];
  try {
    if (open.length > 0) {
      const found = await db
        .prepare(
          `SELECT space_id, fid, folded IS NULL AS big FROM search_text
            WHERE space_id IN (${open.map(() => "?").join(",")}) AND (folded IS NULL OR instr(folded, ?) > 0)`,
        )
        .bind(...open.map((o) => o.section.space), needle)
        .all<{ space_id: string; fid: string; big: number }>();
      rows = found.results;
    }
  } catch {
    return unavailable();
  }

  const prefix = dir ? `${dir.toLowerCase()}/` : "";
  const docs = new Map<string, Found>();
  const found = (section: Where, fid: string, doc: Searchable): Found => {
    const k = `${section.space}/${fid}`;
    let f = docs.get(k);
    if (!f) docs.set(k, (f = { doc, section, path: under(section.mount, doc.text.file.path), named: false, row: null }));
    return f;
  };
  for (const { section, want } of open) {
    for (const [fid, doc] of want) if (isCalled(doc.text.file.path, needle)) found(section, fid, doc).named = true;
  }
  const bySpace = new Map(open.map((o) => [o.section.space, o]));
  for (const r of rows) {
    const from = bySpace.get(r.space_id);
    const doc = from?.want.get(r.fid);
    if (from && doc) found(from.section, r.fid, doc).row = Number(r.big) !== 0 ? "big" : "text";
  }
  const inDir = [...docs.values()].filter((r) => r.path.toLowerCase().startsWith(prefix));
  // What a document is called first: whoever typed a name is after that one.
  const matched = inDir
    .filter((r) => r.named || r.row === "text")
    .sort((a, b) => Number(b.named) - Number(a.named) || a.path.localeCompare(b.path, undefined, { sensitivity: "base" }));
  // Only a row's lines cost a read; a name alone is already in the manifest.
  const shown: Found[] = [];
  let reads = Math.max(1, SEARCH_READS - spent);
  for (const hit of matched) {
    if (shown.length === limit) break;
    if (hit.row === "text") {
      if (reads === 0) break;
      reads -= 1;
    }
    shown.push(hit);
  }

  const hits = await mapLimited(shown, READ_CONCURRENCY, async ({ doc, section, path, named, row }): Promise<Hit> => {
    const text = row === "text" ? await blobText(section.env, doc.text) : null;
    const { matches, total } = text === null ? { matches: [], total: 0 } : matchingLines(path, text, needle);
    return {
      space: section.space,
      fid: doc.text.fid,
      path,
      matches,
      moreLines: total - matches.length,
      inName: named,
      inComments: row === "text" && total === 0,
    };
  });
  return {
    hits,
    total: matched.length,
    notSearched: inDir.filter((r) => r.row === "big" && !r.named).map((r) => ({ space: r.section.space, path: r.path })),
    left,
  };
}

/**
 * The documents in `sections` that link to any of `targets` — the files of
 * one document — from the `links` index, caught up first, by the path their
 * caller names them by. A document gone since is none, and so is the one
 * whose files `targets` are.
 */
export async function linkersOf(
  env: Env,
  sections: readonly Where[],
  targets: readonly string[],
): Promise<{ paths: string[]; left: Where[] } | { indexing: number } | Refusal> {
  const up = await caughtUp(env, sections);
  if (up instanceof Refusal || "indexing" in up) return up;
  const { open, left, db } = up;
  if (open.length === 0 || targets.length === 0) return { paths: [], left };
  let rows: { space_id: string; fid: string }[];
  try {
    const found = await db
      .prepare(
        `SELECT DISTINCT space_id, fid FROM links
          WHERE target IN (${targets.map(() => "?").join(",")}) AND space_id IN (${open.map(() => "?").join(",")})`,
      )
      .bind(...targets, ...open.map((o) => o.section.space))
      .all<{ space_id: string; fid: string }>();
    rows = found.results;
  } catch {
    return new Refusal(503, "this needs the domain's database, which isn't answering — try again in a moment");
  }
  const bySpace = new Map(open.map((o) => [o.section.space, o]));
  const paths: string[] = [];
  for (const r of rows) {
    const from = bySpace.get(r.space_id);
    const doc = from?.want.get(r.fid);
    if (!from || !doc || targets.includes(r.fid)) continue;
    paths.push(under(from.section.mount, doc.text.file.path));
  }
  paths.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  return { paths, left };
}
