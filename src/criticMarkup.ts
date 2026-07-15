// CriticMarkup editorial comments — pure string helpers (no editor deps).
//
// A comment is a *thread*: an anchored highlight plus a flat list of entries
// (the opening comment and its replies), each stamped with an author and a
// time. In the editor the thread lives in the `critic_comment` mark's attrs
// (see criticMark.ts); on disk it serializes to CriticMarkup — the anchor
// wrapped in {==…==} followed by one {>>…<<} span per entry:
//
//   {==anchor text==}{>>#c7k2x9 Sherin's Mac · 2026-07-14T09:12:33Z: This reads odd<<}{>>Aisha · 2026-07-14T10:01:05Z: agree<<}
//
// The `#id` on the first span names the thread. Inline marks can't cross a
// block boundary, so an anchor spanning paragraphs becomes several runs, each
// carrying the same id; every run serializes the thread in full and the
// parser folds them back into one thread (the first run's entries win). A
// bare reference — {==rest of anchor==}{>>#c7k2x9<<} — also parses as a
// continuation of that thread. Spans with no `#id` ("{>>free text<<}", the
// format older Doklin versions wrote, and hand-written CriticMarkup) parse
// as a thread with one authorless entry.

export type CommentEntry = {
  author: string; // display name; "" = unknown (legacy / hand-written)
  at: number; // epoch ms; 0 = unknown
  body: string;
  // Web-share provenance, stamped by the share worker when an entry arrives
  // from a browser session: a stable entry id plus the access code that wrote
  // it. Absent on desktop-authored entries. Only html-rendition threads carry
  // these (they travel as JSON); the CriticMarkup serialization below doesn't
  // encode them — markdown entries never have them.
  eid?: string;
  codeId?: string;
  label?: string;
};

// {==anchor==} directly followed by one or more {>>…<<} spans. `[\s\S]` (not
// `.`) so any part can contain anything but the delimiters; non-greedy so
// adjacent markers don't merge into one match. The anchor must be non-empty.
export const CRITIC_BLOCK_RE = /\{==([\s\S]+?)==\}((?:\{>>[\s\S]*?<<\})+)/g;

// One {>>…<<} span inside the block above.
const SPAN_RE = /\{>>([\s\S]*?)<<\}/g;

// `#id` at the start of a thread's first span (rest = first entry), or alone
// as a continuation reference.
const ID_RE = /^#([a-z0-9]{4,16})(?:[ \t\n]+([\s\S]+))?$/;

// `author · ISO time: body`. The author part is non-greedy and backtracks
// past any inner "·" until the ISO timestamp anchors the split, so author
// names containing "·" still parse.
const ENTRY_RE =
  /^([\s\S]{0,200}?) · (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z): ([\s\S]*)$/;

export function newThreadId(): string {
  let id = "";
  while (id.length < 6) id += Math.random().toString(36).slice(2);
  return id.slice(0, 6);
}

// What one anchor's span group means: a full thread, or a reference to a
// thread rooted at another run of the same anchor.
export type ParsedSpans =
  | { kind: "thread"; id: string | null; comments: CommentEntry[] }
  | { kind: "ref"; id: string };

export function parseSpans(raw: string): ParsedSpans {
  const spans: string[] = [];
  const re = new RegExp(SPAN_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) spans.push(m[1]);
  if (spans.length === 0) return { kind: "thread", id: null, comments: [] };

  const idMatch = spans[0].match(ID_RE);
  if (idMatch) {
    const rest = idMatch[2];
    if (rest === undefined && spans.length === 1) {
      return { kind: "ref", id: idMatch[1] };
    }
    const entries = rest === undefined ? spans.slice(1) : [rest, ...spans.slice(1)];
    return { kind: "thread", id: idMatch[1], comments: entries.map(parseEntry) };
  }
  // No id: legacy or hand-written CriticMarkup.
  return { kind: "thread", id: null, comments: spans.map(parseEntry) };
}

function parseEntry(raw: string): CommentEntry {
  const m = raw.match(ENTRY_RE);
  if (!m) return { author: "", at: 0, body: raw.trim() };
  const at = Date.parse(m[2]);
  return { author: m[1], at: Number.isFinite(at) ? at : 0, body: m[3] };
}

// Comment text is stored inside {>>…<<}, inline in a markdown paragraph, so
// it must not contain the closing delimiter or blank lines (which would split
// the paragraph on reparse). Lossy but safe; applied when entries are
// created, so what the card shows is what the file keeps.
export function sanitizeBody(body: string): string {
  return body.replace(/\s*\n[\s\n]*/g, " ").replace(/<<\}/g, "<< }").trim();
}

export function sanitizeAuthor(author: string): string {
  return author.replace(/\s+/g, " ").replace(/<<\}/g, "<< }").trim().slice(0, 80);
}

function formatEntry(e: CommentEntry): string {
  if (!e.author && !e.at) return e.body;
  const iso = new Date(e.at || 0).toISOString().replace(/\.\d{3}Z$/, "Z");
  return `${e.author} · ${iso}: ${e.body}`;
}

// The span group for one run of a thread: `{>>#id entry<<}{>>entry<<}…`.
// A thread with no entries degrades to a bare ref, which the next parse
// unwraps (no root anywhere) or folds into its thread (root elsewhere).
export function formatThreadSpans(id: string, comments: CommentEntry[]): string {
  if (comments.length === 0) return `{>>#${id}<<}`;
  return comments
    .map((e, i) => (i === 0 ? `{>>#${id} ${formatEntry(e)}<<}` : `{>>${formatEntry(e)}<<}`))
    .join("");
}

// The clean / "accept" transform: drop comments entirely, unwrap highlights to
// their plain text. This is what plain ⌘C copies and what publishing sends, so
// a marked-up document never leaks braces to a reader.
//
// Comments are removed first (delimiters + content), then any remaining
// highlight wrapper is unwrapped — which also tidies a stray `{==..==}` that
// has no trailing comment.
export function stripComments(md: string): string {
  return md
    .replace(/\{>>[\s\S]*?<<\}/g, "")
    .replace(/\{==([\s\S]*?)==\}/g, "$1");
}
