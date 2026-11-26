// Comment threads on a document's HTML rendition — the data model.
//
// The rendition is generated markup Doklin never writes (an AI tool owns it),
// so unlike markdown comments — whose anchors live inline as CriticMarkup —
// HTML threads live entirely in the entity meta file beside the document,
// one `hthread` record per thread (metaFile.ts).
//
// A thread is on WORDS of the page, or on a PART of it as a whole (a
// paragraph, a heading, a row, a picture). Either way it is found again by
// what the page says, never by where the markup had it: ids and the
// structural path only say where to look first, and whatever they lead to is
// checked against the words before it is believed (htmlBridge.ts, "finding a
// place"). A thread whose place is not found is kept and shown as lost,
// never silently dropped — and finding a thread never rewrites its anchor.
// Entries reuse the markdown side's CommentEntry shape, so both views draw
// the same card.

import {
  newThreadId,
  sanitizeAuthor,
  sanitizeBody,
  type CommentEntry,
} from "./criticMarkup";

export type { CommentEntry };

// How much of the page an anchor keeps. The page script, the worker's reading
// of a page (cloud-worker/src/htmlText.ts) and the iPhone's
// (ios/DoklinKit/Sources/DoklinKit/Comments/HtmlText.swift) cut to the same
// lengths — change all three.
export const ANCHOR_TEXT_LEN = 120;
export const ANCHOR_QUOTE_LEN = 1000;
export const ANCHOR_CONTEXT_LEN = 32;
export const ANCHOR_IDS_MAX = 12;
export const ANCHOR_ID_LEN = 200;

// Where a thread is. `path`, `tag` and `text` are its part: a structural CSS
// selector from the document root ("section:nth-of-type(2) > p:nth-of-type(3)",
// a hint only), the part's tag, and the start of what it says (a picture's
// alt text, else its file name). `ids` are the ids of the part and of
// everything around it, nearest first. A thread on words also has them
// (`quote`) with the text either side (`prefix`, `suffix`), and its part is
// then the smallest one holding all of them.
export type HtmlAnchor = {
  path: string;
  tag: string;
  text: string;
  ids?: string[];
  quote?: string;
  prefix?: string;
  suffix?: string;
};

// An anchor as it is stored, from anything that claims to be one: the keys in
// the order every device writes them, `ids` only when there are some, and the
// words only when there are some. Null for what is no anchor at all. The
// engine (engine/src/sidecar.rs `anchor`) and the iPhone (MetaFile.swift)
// read one the same way — change all three.
export function storedAnchor(value: unknown): HtmlAnchor | null {
  const a = value as Record<string, unknown> | null;
  if (!a || typeof a !== "object") return null;
  if (typeof a.path !== "string" || typeof a.tag !== "string" || typeof a.text !== "string") return null;
  const out: HtmlAnchor = { path: a.path, tag: a.tag, text: a.text };
  if (Array.isArray(a.ids) && a.ids.length > 0 && a.ids.every((id) => typeof id === "string")) {
    out.ids = a.ids as string[];
  }
  if (typeof a.quote === "string" && a.quote !== "") {
    out.quote = a.quote;
    out.prefix = typeof a.prefix === "string" ? a.prefix : "";
    out.suffix = typeof a.suffix === "string" ? a.suffix : "";
  }
  return out;
}

// An anchor the page's frame sent. The frame is untrusted and the sidecar is
// synced to every device, so it is taken as strings and cut to what an
// anchor keeps.
export function anchorFromFrame(value: unknown): HtmlAnchor | null {
  const a = storedAnchor(value);
  if (!a || !/^[a-z][a-z0-9-]*$/.test(a.tag)) return null;
  const out: HtmlAnchor = {
    path: a.path.slice(0, 2000),
    tag: a.tag.slice(0, 60),
    text: a.text.slice(0, ANCHOR_TEXT_LEN),
  };
  const ids = (a.ids ?? [])
    .filter((id) => id !== "")
    .slice(0, ANCHOR_IDS_MAX)
    .map((id) => id.slice(0, ANCHOR_ID_LEN));
  if (ids.length > 0) out.ids = ids;
  if (a.quote !== undefined) {
    out.quote = a.quote.slice(0, ANCHOR_QUOTE_LEN);
    out.prefix = (a.prefix ?? "").slice(-ANCHOR_CONTEXT_LEN);
    out.suffix = (a.suffix ?? "").slice(0, ANCHOR_CONTEXT_LEN);
  }
  return out;
}

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

   A document's threads can change in two places at once: the cards in this
   window, and the meta file on disk when another device's edit lands
   (cloud sync, or another window). `base` is the state both sides last
   agreed on, `mine` is this window's, `theirs` is what arrived — so an addition
   on either side lands on both, and a deletion on either side sticks
   instead of resurrecting on the next write. */

// Entry identity: author+time (stable across body edits — editing keeps
// `at`; only filling an empty draft freshens it, and drafts are local).
const sameEntry = (a: CommentEntry, b: CommentEntry): boolean =>
  a.author === b.author && a.at === b.at;

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
      // Both sides have it: the body follows whoever actually changed it
      // (local edit wins a simultaneous rewrite — comment edits are rare and
      // low-stakes).
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
