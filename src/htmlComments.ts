// Comment threads on a document's HTML rendition — the data model.
//
// The rendition is generated markup Doklin never writes (an AI tool owns it),
// so unlike markdown comments — which live inline as CriticMarkup — HTML
// threads live in a sidecar next to the rendition:
//
//   notes.html  →  notes.html.comments.jsonl
//
// The sidecar is JSON Lines: a header line, then ONE line per thread. One
// thread per line is deliberate — cloud sync merges files with a three-way
// *text* merge (see src-tauri/src/sync.rs), so two people adding or replying
// to different threads concurrently merge cleanly line-by-line, where a
// single pretty-printed JSON document would conflict on every edit.
//
// A thread anchors to an ELEMENT of the rendition (markdown comments anchor
// to text ranges; the html view is component-level by design): a structural
// path resolved first, with the element's tag and leading text as the
// re-anchoring fallback when regeneration reshuffles the structure. Threads
// whose anchor no longer resolves are "orphaned" — kept, shown at the top of
// the rail, never silently dropped. Entries reuse the markdown side's
// CommentEntry shape, so the rail renders both sides identically.
//
// The sidecar never leaves the user's machines except via workspace sync:
// publishing reads only the .md/.html pair (see share.ts), the sidebar tree
// lists only markdown/html documents, and workspace search scans markdown —
// the sidecar is plumbing, not a document.

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

const HEADER = `{"doklin":"html-comments","v":1}`;

export const commentsSidecarOf = (htmlPath: string) => htmlPath + ".comments.jsonl";

function isEntry(value: unknown): value is CommentEntry {
  const e = value as CommentEntry;
  return (
    !!e &&
    typeof e === "object" &&
    typeof e.author === "string" &&
    typeof e.at === "number" &&
    typeof e.body === "string"
  );
}

function isAnchor(value: unknown): value is HtmlAnchor {
  const a = value as HtmlAnchor;
  return (
    !!a &&
    typeof a === "object" &&
    typeof a.path === "string" &&
    typeof a.tag === "string" &&
    typeof a.text === "string"
  );
}

// Tolerant parse: skip the header, skip malformed lines (a sync conflict
// marker or hand edit must never take every thread down with it), fold
// duplicate ids (first wins — matches the markdown side's "first run wins").
export function parseHtmlComments(raw: string): HtmlThread[] {
  const out: HtmlThread[] = [];
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
    const t = obj as HtmlThread & { doklin?: string };
    if (t.doklin) continue; // header line
    if (
      typeof t.id !== "string" ||
      t.id === "" ||
      seen.has(t.id) ||
      !isAnchor(t.anchor) ||
      !Array.isArray(t.comments) ||
      !t.comments.every(isEntry)
    ) {
      continue;
    }
    seen.add(t.id);
    out.push({ id: t.id, anchor: t.anchor, comments: t.comments });
  }
  return out;
}

export function serializeHtmlComments(threads: HtmlThread[]): string {
  const lines = [HEADER];
  for (const t of threads) {
    lines.push(JSON.stringify({ id: t.id, anchor: t.anchor, comments: t.comments }));
  }
  return lines.join("\n") + "\n";
}

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
