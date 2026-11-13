// Search (docs/cloud.md §8.5): which documents contain this text, with the
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
// The mirror is derived and lazy:
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

import type { Call } from "./agentCall";
import type { Committed } from "./commit";
import { Index, nameOf, pathProblem, type Entry } from "./documents";
import type { Env } from "./env";
import { json } from "./http";
import { textOf } from "./htmlText";
import { blobKey } from "./layout";
import type { Manifest } from "./manifest";
import { ensureSchema } from "./schema";
import { isHtmlPath, isMarkdownPath, openWorkspace } from "./workspace";
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

async function readState(db: D1Database): Promise<State | null> {
  const row = await db.prepare("SELECT etag, held FROM search_state WHERE key = 'mirror'").first<{ etag: string; held: string }>();
  if (!row) return null;
  try {
    const held: unknown = JSON.parse(row.held);
    if (held !== null && typeof held === "object" && !Array.isArray(held)) return { etag: row.etag, held: held as Held };
  } catch {
    // an unreadable map is an empty mirror: everything is read again
  }
  return { etag: "", held: {} };
}

/**
 * Bring the mirror towards the manifest: read what is stale, drop what is
 * gone, and record what the rows now hold — in one batch, so a row and the
 * record of it never disagree. Answers how many documents are still stale
 * and how many blobs this round read.
 */
async function catchUp(
  env: Env,
  db: D1Database,
  etag: string,
  m: Manifest,
  state: State,
  maxReads: number,
): Promise<{ pending: number; reads: number }> {
  const want = searchable(m);
  const stale = [...want].filter(([fid, w]) => state.held[fid] !== w.signature);
  const dead = Object.keys(state.held).filter((fid) => !want.has(fid));
  if (stale.length === 0 && dead.length === 0) {
    if (state.etag !== etag) {
      await db.prepare("UPDATE search_state SET etag = ? WHERE key = 'mirror'").bind(etag).run();
    }
    return { pending: 0, reads: 0 };
  }

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
    return text === null ? null : { fid, w, text: folded(w.text.file.path, text, metaText) };
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
    statements.push(db.prepare("INSERT OR REPLACE INTO search_text (fid, folded) VALUES (?, ?)").bind(row.fid, row.text));
  }
  for (let i = 0; i < dead.length; i += 50) {
    const chunk = dead.slice(i, i + 50);
    statements.push(db.prepare(`DELETE FROM search_text WHERE fid IN (${chunk.map(() => "?").join(",")})`).bind(...chunk));
  }
  const pending = stale.length - round.length + missed;
  statements.push(
    db
      .prepare("INSERT OR REPLACE INTO search_state (key, etag, held) VALUES ('mirror', ?, ?)")
      .bind(pending === 0 ? etag : "", JSON.stringify(held)),
  );
  await db.batch(statements);
  return { pending, reads };
}

/**
 * After a change made through the document API: catch the mirror up to the
 * manifest that change just stored — when there is a mirror. Runs after the
 * response where the runtime allows it, and never fails the change it follows.
 */
export async function mirrorAfter(c: Pick<Call, "env" | "ctx">, done: Committed<unknown>): Promise<void> {
  if (!done.wrote) return;
  const work = (async (): Promise<void> => {
    const db = c.env.DB;
    if (!db) return;
    try {
      if ((await ensureSchema(c.env)) == null) return;
      const state = await readState(db);
      if (!state) return; // nobody has searched: there is no mirror to keep
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

export async function getSearch(c: Call): Promise<Response> {
  const { env, url } = c;
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

  const ws = await openWorkspace(env);
  if (!ws) return json({ error: "this domain holds no workspace yet" }, 404);
  const db = env.DB;
  const unavailable = (): Response => json({ error: "search needs this domain's database — update the worker" }, 503);
  if (!db) return unavailable();

  let rows: { fid: string; big: number }[];
  try {
    if ((await ensureSchema(env)) == null) return unavailable();
    const state = (await readState(db)) ?? { etag: "", held: {} };
    if (state.etag !== ws.etag) {
      const { pending, reads } = await catchUp(env, db, ws.etag, ws.manifest, state, CATCH_UP_READS);
      // A round that read more than a handful has used this request's
      // budget; the lines are cut on the next one.
      if (pending > 0 || reads > INLINE_READS) return json({ indexing: true, pending }, 202);
    }
    const found = await db
      .prepare("SELECT fid, folded IS NULL AS big FROM search_text WHERE folded IS NULL OR instr(folded, ?) > 0")
      .bind(needle)
      .all<{ fid: string; big: number }>();
    rows = found.results;
  } catch {
    return unavailable();
  }

  const want = searchable(ws.manifest);
  const prefix = dir ? `${dir.toLowerCase()}/` : "";
  const inDir = rows
    .map((r) => ({ big: Number(r.big) !== 0, doc: want.get(r.fid) }))
    .filter((r): r is { big: boolean; doc: Searchable } => r.doc !== undefined && r.doc.text.file.path.toLowerCase().startsWith(prefix))
    .sort((a, b) => a.doc.text.file.path.localeCompare(b.doc.text.file.path, undefined, { sensitivity: "base" }));
  const hits = inDir.filter((r) => !r.big);
  const shown = hits.slice(0, limit);

  const results = await mapLimited(shown, READ_CONCURRENCY, async ({ doc }) => {
    const path = doc.text.file.path;
    const text = await blobText(env, doc.text);
    const { matches, total } = text === null ? { matches: [], total: 0 } : matchingLines(path, text, needle);
    return {
      path: nameOf(path).stem,
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
    ...(inDir.some((r) => r.big) ? { notSearched: inDir.filter((r) => r.big).map((r) => nameOf(r.doc.text.file.path).stem) } : {}),
  });
}
