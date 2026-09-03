// Comment threads on a document's HTML rendition — the data model.
//
// The rendition is generated markup Doklin never writes (an AI tool owns it),
// so unlike markdown comments — whose anchors live inline as CriticMarkup —
// HTML threads live entirely in the entity meta file beside the document,
// one `hthread` record per thread (metaFile.ts). One record per line is
// deliberate: cloud sync merges files with a three-way *text* merge
// (src-tauri/src/cloud/merge.rs), so two people adding or replying to
// different threads concurrently merge cleanly line by line.
//
// A thread anchors to an ELEMENT of the rendition (markdown comments anchor
// to text ranges; the html view is component-level by design): a structural
// path resolved first, with the element's tag and leading text as the
// re-anchoring fallback when regeneration reshuffles the structure. Threads
// whose anchor no longer resolves are "orphaned" — kept, shown at the top of
// the rail, never silently dropped. Entries reuse the markdown side's
// CommentEntry shape, so the rail renders both sides identically.

import {
  newThreadId,
  sanitizeAuthor,
  sanitizeBody,
  type CommentEntry,
} from "./criticMarkup";

export type { CommentEntry };

// How a thread finds its element again. `path` is a structural CSS selector
// from the document root ("section:nth-of-type(2) > p:nth-of-type(3)");
// `tag` and `text` (normalized leading text, ~120 chars) let the bridge
// re-anchor by content when the path no longer matches.
export type HtmlAnchor = {
  path: string;
  tag: string;
  text: string;
};

export type HtmlThread = {
  id: string;
  anchor: HtmlAnchor;
  comments: CommentEntry[];
};

/* ---------- Pure mutations (the html-side createThread/addReply/…) ----------
   Same semantics as criticMark.ts's transaction wrappers, over a plain array:
   a new thread opens as an empty draft by `author` (the card opens for
   typing; an abandoned draft is discarded by the view), filling an empty
   draft freshens its timestamp, replies are flat. */

export function createHtmlThread(
  threads: HtmlThread[],
  anchor: HtmlAnchor,
  author: string,
): { next: HtmlThread[]; id: string } {
  const id = newThreadId();
  const entry: CommentEntry = { author: sanitizeAuthor(author), at: Date.now(), body: "" };
  return { next: [...threads, { id, anchor, comments: [entry] }], id };
}

export function updateHtmlCommentBody(
  threads: HtmlThread[],
  id: string,
  index: number,
  body: string,
): HtmlThread[] {
  return threads.map((t) => {
    const entry = t.comments[index];
    if (t.id !== id || !entry) return t;
    const next = t.comments.slice();
    next[index] = {
      ...entry,
      body: sanitizeBody(body),
      at: entry.body === "" ? Date.now() : entry.at,
    };
    return { ...t, comments: next };
  });
}

export function addHtmlReply(
  threads: HtmlThread[],
  id: string,
  author: string,
  body: string,
): HtmlThread[] {
  const clean = sanitizeBody(body);
  if (!clean) return threads;
  return threads.map((t) =>
    t.id === id
      ? {
          ...t,
          comments: [
            ...t.comments,
            { author: sanitizeAuthor(author), at: Date.now(), body: clean },
          ],
        }
      : t,
  );
}

export function deleteHtmlReply(
  threads: HtmlThread[],
  id: string,
  index: number,
): HtmlThread[] {
  return threads.map((t) =>
    t.id === id && index > 0 && index < t.comments.length
      ? { ...t, comments: t.comments.filter((_, i) => i !== index) }
      : t,
  );
}

export function deleteHtmlThread(threads: HtmlThread[], id: string): HtmlThread[] {
  return threads.filter((t) => t.id !== id);
}

/* ---------- Three-way merge of two copies of a thread list ----------

   A document's threads can change in two places at once: the live rail in
   this window, and the meta file on disk when another device's edit lands
   (cloud sync, or another window). `base` is the state both sides last
   agreed on, `mine` is the rail, `theirs` is what arrived — so an addition
   on either side lands on both, and a deletion on either side sticks
   instead of resurrecting on the next write. */

// Entry identity: two entries are the same when their eids match, or by
// author+time when either side carries no eid (stable across body edits —
// editing keeps `at`; only filling an empty draft freshens it, and drafts
// are local). Two distinct stamped entries are never conflated, whatever
// their timestamps.
const sameEntry = (a: CommentEntry, b: CommentEntry): boolean =>
  a.eid && b.eid ? a.eid === b.eid : a.author === b.author && a.at === b.at;

function mergeEntries(
  base: CommentEntry[],
  mine: CommentEntry[],
  theirs: CommentEntry[],
): CommentEntry[] {
  const inBase = (e: CommentEntry) => base.find((b) => sameEntry(b, e));
  const out: CommentEntry[] = [];
  for (const e of mine) {
    const b = inBase(e);
    const t = theirs.find((x) => sameEntry(x, e));
    if (t) {
      // Both sides have it: their copy carries any provenance stamps; the
      // body follows whoever actually changed it (local edit wins a
      // simultaneous rewrite — comment edits are rare and low-stakes).
      out.push({ ...t, body: b && e.body === b.body ? t.body : e.body });
    } else if (!b) {
      out.push(e); // my addition, not pushed yet
    }
    // b && !t → deleted on their side; the deletion sticks.
  }
  for (const e of theirs) {
    if (!mine.some((m) => sameEntry(m, e)) && !inBase(e)) out.push(e); // their addition
    // !mine && base → deleted locally; the deletion sticks.
  }
  return out;
}

export function mergeHtmlThreads(
  base: HtmlThread[],
  mine: HtmlThread[],
  theirs: HtmlThread[],
): HtmlThread[] {
  const baseBy = new Map(base.map((t) => [t.id, t]));
  const mineBy = new Map(mine.map((t) => [t.id, t]));
  const theirsBy = new Map(theirs.map((t) => [t.id, t]));
  const out: HtmlThread[] = [];
  for (const t of mine) {
    const b = baseBy.get(t.id);
    const other = theirsBy.get(t.id);
    if (other) {
      const comments = mergeEntries(b?.comments ?? [], t.comments, other.comments);
      if (comments.length > 0) {
        // Anchors only change when a side re-anchored deliberately — same
        // rule as bodies: local movement wins, otherwise follow theirs.
        const anchor =
          b && JSON.stringify(t.anchor) === JSON.stringify(b.anchor) ? other.anchor : t.anchor;
        out.push({ ...t, anchor, comments });
      }
    } else if (!b) {
      out.push(t); // my new thread
    }
    // b && !other → the whole thread was deleted on their side.
  }
  for (const t of theirs) {
    if (!mineBy.has(t.id) && !baseBy.has(t.id)) out.push(t); // their new thread
  }
  return out;
}
