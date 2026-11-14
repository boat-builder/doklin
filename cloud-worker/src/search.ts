// Search: which documents contain this text, with the
// lines — the question the app's own search asks (`search_workspace`,
// src-tauri/src/lib.rs), answered for a caller that has no copy of the folder.
//
//   GET /api/agent/search?q=&dir=&limit=
//
// A Worker cannot read every document on every search: each is a blob read,
// and a request may make fifty. So the text is mirrored into D1, one row per
// document, lower-cased, and a search is one scan there (`instr`). The rows
// that match — at most `limit` of them — are then read from the bucket to cut
// the matching lines.
//
// There is one mirror per section — the shared workspace's, and one for each
// space — so a search scans the text of the sections its agent's person can
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
//   · A change made through the document API catches up straight away, so an
//     agent finds what it just wrote. A change made on a Mac is caught up by
//     the next search — deliberately not on the Mac's own manifest PUT, which
//     would spend a database write on every save for a mirror nobody may ask.
//   · Until somebody searches there is no mirror, and nothing here costs
//     anything.
//
// It is the database or nothing: a domain without one answers 503 to a search
// and loses nothing else.

import { refuse, type Call } from "./agentCall";
import { MAX_SECTIONS_READ, type Section } from "./agentPlace";
import { splitCard } from "./boardCards";
import { Refusal, type Committed } from "./commit";
import { Index, nameOf, pathProblem, type Entry } from "./documents";
import type { Env } from "./env";
import { json } from "./http";
import { textOf } from "./htmlText";
import { blobKey } from "./layout";
import type { Manifest } from "./manifest";
import { ensureSchema } from "./schema";
import { spaceOf } from "./spaces";
import { dirOf, isHtmlPath, isMarkdownPath, openWorkspace, type Workspace } from "./workspace";
import { stripComments } from "../../src/criticMarkup";
import { META_SUFFIX, parseEntityMeta } from "../../src/metaFile";

/** A document whose text and comments together pass this is not mirrored —
 *  D1 holds a row of two megabytes at most — and is listed as not searchable. */
const MAX_MIRRORED_BYTES = 1024 * 1024;
/** Blob reads one catch-up may make, and the text it may carry. */
const CATCH_UP_READS = 36;
const CATCH_UP_BYTES = 1024 * 1024;
/** Stale documents a search still catches up and answers in one request. */
const INLINE_READS = 8;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 30;
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
 *  html when it has no markdown. `board` when it is a card's page. */
type Searchable = { text: Entry; meta: Entry | null; board: string | null; signature: string };

/** Every document the manifest holds, by the file id its mirror row is keyed on. */
function searchable(m: Manifest): Map<string, Searchable> {
  const index = new Index(m.files);
  const out = new Map<string, Searchable>();
  for (const [fid, file] of Object.entries(m.files)) {
    const md = isMarkdownPath(file.path);
    if (!md && !isHtmlPath(file.path)) continue;
    // Inside a board only its cards are documents.
    if (index.hidden(file.path)) continue;
    const { stem } = nameOf(file.path);
    // An html file beside its markdown is that document's other version,
    // not a document of its own.
    if (!md && index.doc(stem).md) continue;
    const meta = index.at(`${stem}${META_SUFFIX}`);
    const board = index.isCard(file.path) ? index.board(dirOf(file.path)) : null;
    // A card's row holds its page, not its properties — so it is read again
    // when its folder becomes a board, or stops being one.
    const signature = `${file.hash}.${meta?.file.hash ?? ""}${board ? ".card" : ""}`;
    out.set(fid, { text: { fid, file }, meta, board, signature });
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
 * in one batch, so a row and the record of it never disagree. Answers how
 * many documents are still stale and how many blobs this round read.
 */
async function catchUp(
  env: Env,
  db: D1Database,
  etag: string,
  m: Manifest,
  state: State,
  maxReads: number,
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

  const rows = await mapLimited(round, READ_CONCURRENCY, async ([fid, w]) => {
    if (w.text.file.size + (w.meta?.file.size ?? 0) > MAX_MIRRORED_BYTES) return { fid, w, text: null as string | null };
    const [text, metaText] = await Promise.all([blobText(env, w.text), w.meta ? blobText(env, w.meta) : Promise.resolve(null)]);
    // A blob that is not there yet is a sync still in flight: leave the row
    // stale, and the next catch-up reads it.
    return text === null ? null : { fid, w, text: folded(w.text.file.path, w.board ? splitCard(text).page : text, metaText) };
  });

  const held: Held = { ...state.held };
  for (const fid of dead) delete held[fid];
  const statements: D1PreparedStatement[] = [];
  let missed = 0;
  for (const row of rows) {
    if (row === null) {
      missed += 1;
      continue;
    }
    held[row.fid] = row.w.signature;
    statements.push(
      db.prepare("INSERT OR REPLACE INTO search_text (space_id, fid, folded) VALUES (?, ?, ?)").bind(space, row.fid, row.text),
    );
  }
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
export async function mirrorAfter(c: Pick<Call, "env" | "ctx">, done: Committed<unknown>): Promise<void> {
  if (!done.wrote) return;
  const work = (async (): Promise<void> => {
    const db = c.env.DB;
    if (!db) return;
    try {
      if ((await ensureSchema(c.env)) == null) return;
      const state = (await readStates(db, [spaceOf(c.env)])).get(spaceOf(c.env));
      if (!state) return; // nobody has searched here: there is no mirror to keep
      await catchUp(c.env, db, done.etag, done.manifest, state, INLINE_READS);
    } catch {
      // the next search catches up instead
    }
  })();
  if (c.ctx) c.ctx.waitUntil(work);
  else await work;
}

type Match = { line?: number; text: string };

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

/** A path in a section, as its person names it. */
const under = (mount: string, path: string): string => (mount ? `${mount}/${path}` : path);

export async function getSearch(c: Call): Promise<Response> {
  const { env, url, places } = c;
  const query = (url.searchParams.get("q") ?? "").trim();
  if (query === "") return json({ error: "say what to search for" }, 400);
  if (/[\r\n]/.test(query)) return json({ error: "search for text within one line" }, 400);
  const needle = query.toLowerCase();
  const dir = (url.searchParams.get("dir") ?? "").replace(/^\/+|\/+$/g, "");
  if (dir) {
    const problem = pathProblem(dir);
    if (problem) return json({ error: problem }, 400);
  }
  const asked = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, MAX_LIMIT) : DEFAULT_LIMIT;
  const unavailable = (): Response => json({ error: "search needs this domain's database — update the worker" }, 503);

  // A folder is in one section. The workspace itself is all of them, and
  // `Restricted` every restricted folder.
  const at = dir === "" ? null : await places.at(dir);
  if (at instanceof Refusal) return refuse(at);
  let sections: Section[];
  if (at && at !== "restricted") {
    sections = [at];
  } else {
    const all = await places.all();
    if (all === null) return unavailable();
    sections = at === "restricted" ? all.filter((s) => s.kind === "restricted") : all;
  }
  const covered = sections.slice(0, 1 + MAX_SECTIONS_READ);
  const left = sections.slice(covered.length).map((s) => s.mount);

  const open: { section: Section; ws: Workspace; want: Map<string, Searchable> }[] = [];
  for (const section of covered) {
    const ws = await openWorkspace(section.env);
    if (ws) open.push({ section, ws, want: searchable(ws.manifest) });
    else if (section.space === "") return json({ error: "this domain holds no workspace yet" }, 404);
  }
  const db = env.DB;
  if (!db) return unavailable();

  let spent = 2 * open.length;
  let rows: { space_id: string; fid: string; big: number }[] = [];
  try {
    if ((await ensureSchema(env)) == null) return unavailable();
    if (open.length > 0) {
      const states = await readStates(db, open.map((o) => o.section.space));
      let pending = 0;
      let reads = 0;
      for (const { section, ws } of open) {
        const state = states.get(section.space) ?? { etag: "", held: {} };
        if (state.etag === ws.etag) continue;
        const round = await catchUp(section.env, db, ws.etag, ws.manifest, state, CATCH_UP_READS - reads);
        pending += round.pending;
        reads += round.reads;
      }
      // A round that read more than a handful has used this request's
      // budget; the lines are cut on the next one.
      if (pending > 0 || reads > INLINE_READS) return json({ indexing: true, pending }, 202);
      spent += reads;
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

  const bySpace = new Map(open.map((o) => [o.section.space, o]));
  const prefix = dir ? `${dir.toLowerCase()}/` : "";
  const inDir = rows
    .map((r) => {
      const from = bySpace.get(r.space_id);
      const doc = from?.want.get(r.fid);
      return from && doc ? { big: Number(r.big) !== 0, doc, section: from.section, path: under(from.section.mount, doc.text.file.path) } : null;
    })
    .filter((r): r is { big: boolean; doc: Searchable; section: Section; path: string } => r !== null && r.path.toLowerCase().startsWith(prefix))
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: "base" }));
  const hits = inDir.filter((r) => !r.big);
  const shown = hits.slice(0, Math.min(limit, Math.max(1, SEARCH_READS - spent)));

  const results = await mapLimited(shown, READ_CONCURRENCY, async ({ doc, section, path }) => {
    const raw = await blobText(section.env, doc.text);
    // A card's lines are its page's, numbered as `read` shows them.
    const text = raw !== null && doc.board ? splitCard(raw).page : raw;
    const { matches, total } = text === null ? { matches: [], total: 0 } : matchingLines(path, text, needle);
    return {
      path: nameOf(path).stem,
      ...(doc.board ? { board: under(section.mount, doc.board) } : {}),
      version: isMarkdownPath(path) ? "md" : "html",
      matches,
      ...(total > matches.length ? { moreLines: total - matches.length } : {}),
      // In the mirror but on no line: the text was said in a comment.
      ...(total === 0 ? { inComments: true } : {}),
    };
  });

  return json({
    query,
    dir,
    results,
    total: hits.length,
    ...(hits.length > shown.length ? { truncated: true } : {}),
    // Too large to mirror — said, rather than silently never found.
    ...(inDir.some((r) => r.big) ? { notSearched: inDir.filter((r) => r.big).map((r) => nameOf(r.path).stem) } : {}),
    // More sections than one request opens: search inside one of these.
    ...(left.length > 0 ? { sectionsNotSearched: left } : {}),
  });
}
