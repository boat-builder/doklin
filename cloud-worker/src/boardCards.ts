// A board's cards as the worker reads them.
//
// A card is a note: its frontmatter block holds its properties and the rest
// is its page (src/store/frontmatter.ts). Two things live here.
//
//   · Splitting a card into those halves, as the app does on disk
//     (`head_len`, src-tauri/src/store.rs), so an agent reads and writes the
//     page and never the block above it.
//   · The copy of every card's block kept in D1, which is what lets a board
//     of hundreds of cards be shown at all. Each block is a blob read, and a
//     request may make fifty. So the blocks live in `board_cards`, keyed by
//     file id beside the content hash they were read from, and a read brings
//     only the stale rows up to date: a few dozen per request, and `202` with
//     how many are left when that is not enough. The search mirror makes the
//     same bargain for the same reason (search.ts). A card changed through
//     the API is simply stale too: its row is read again by the next read of
//     its board, one blob, the way a Mac's change is.

import type { Entry } from "./documents";
import type { Env } from "./env";
import { blobKey } from "./layout";
import { ensureSchema } from "./schema";
import { parseFrontmatter } from "../../src/store/frontmatter";

/** A card's properties live in its first bytes; the app reads the same window (store.rs). */
const HEAD_BYTES = 16 * 1024;
/** Stale cards one request reads — under fifty subrequests, with room for the rest of it. */
export const CATCH_UP_CARDS = 32;
/** Bound parameters D1 takes in one statement is 100; a chunk of ids stays under it. */
const IDS_PER_QUERY = 90;
const READ_CONCURRENCY = 8;

/** A card's text split into its properties block (fences included, "" for
 *  none) and its page — the two halves the app writes separately. */
export function splitCard(text: string): { head: string; page: string } {
  const fm = parseFrontmatter(text);
  if (!fm.present) return { head: "", page: text };
  return { head: text.slice(0, text.length - fm.body.length), page: fm.body };
}

/** How many lines a block takes: what a card's page numbers its lines after. */
export const headLines = (head: string): number => (head.match(/\n/g) ?? []).length;

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

/** Every card's block by file id, and how many blobs it took to know them. */
export type Heads = { heads: Map<string, string>; read: number } | { pending: number };

/**
 * The block of every card, by file id: from the copy where it is current,
 * from the bucket where it is not. `{pending}` when more were stale than
 * `budget` reads — what was read is kept, so asking again gets further.
 * Null when there is no database to keep the copy in.
 */
export async function cardHeads(env: Env, cards: readonly Entry[], budget = CATCH_UP_CARDS): Promise<Heads | null> {
  const db = env.DB;
  if (!db) return null;
  try {
    if ((await ensureSchema(env)) == null) return null;
    const held = new Map<string, { hash: string; head: string }>();
    const chunks: Entry[][] = [];
    for (let i = 0; i < cards.length; i += IDS_PER_QUERY) chunks.push(cards.slice(i, i + IDS_PER_QUERY));
    if (chunks.length > 0) {
      const answers = await db.batch(
        chunks.map((chunk) =>
          db
            .prepare(`SELECT fid, hash, head FROM board_cards WHERE fid IN (${chunk.map(() => "?").join(",")})`)
            .bind(...chunk.map((e) => e.fid)),
        ),
      );
      for (const answer of answers) {
        for (const row of answer.results as { fid: string; hash: string; head: string }[]) held.set(row.fid, row);
      }
    }

    const stale = cards.filter((e) => held.get(e.fid)?.hash !== e.file.hash);
    const read = await mapLimited(stale.slice(0, budget), READ_CONCURRENCY, async (e) => {
      const obj = await env.DATA.get(blobKey(e.fid, e.file.hash), { range: { offset: 0, length: HEAD_BYTES } });
      // A blob that is not there yet is a sync still in flight: the row stays
      // stale, and the next read tries again.
      return obj ? { fid: e.fid, hash: e.file.hash, head: splitCard(await obj.text()).head } : null;
    });
    const rows = read.filter((r): r is { fid: string; hash: string; head: string } => r !== null);
    if (rows.length > 0) {
      await db.batch(
        rows.map((r) =>
          db.prepare("INSERT OR REPLACE INTO board_cards (fid, hash, head) VALUES (?, ?, ?)").bind(r.fid, r.hash, r.head),
        ),
      );
    }
    for (const r of rows) held.set(r.fid, r);

    const pending = stale.length - rows.length;
    if (pending > 0) return { pending };
    return { heads: new Map(cards.map((e) => [e.fid, held.get(e.fid)?.head ?? ""])), read: read.length };
  } catch {
    return null;
  }
}
