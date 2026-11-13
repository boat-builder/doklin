// Comments, as threads (docs/cloud.md §8.4, Comments).
//
//   GET    /api/agent/comments?path=
//   POST   /api/agent/comments           {path, on, body, v?, dryRun?}   start a thread
//                                        {path, thread, body, dryRun?}   answer one
//   DELETE /api/agent/comments?path=&thread=[&dry=1]
//
// Nothing about where comments live changes for an agent: a markdown thread
// is still a marker in the text (`{==words==}{>>#id<<}`) with its conversation
// in the sidecar, and an html thread is still wholly in the sidecar, anchored
// to an element (src/metaFile.ts, src/htmlComments.ts). What changes is that
// the agent never sees either half. It names a document and some words, and
// the worker writes the marker and the record in one manifest write — so a
// thread can never be half-made.

import { notBound, refuse, type Call } from "./agentCall";
import { contentTypeOf, documentAt, versionFlag } from "./agentDocs";
import { headLines, splitCard } from "./boardCards";
import { Refusal, commit, newFileId, type Tx } from "./commit";
import { Index, askedVersion, type Doc, type Version } from "./documents";
import { json, readJsonObject } from "./http";
import { ANCHOR_TEXT_LEN, anchorResolves, elementsOf, elementsStartingWith, normalizeText } from "./htmlText";
import { blobKey } from "./layout";
import { mirrorAfter } from "./search";
import { openWorkspace } from "./workspace";
import {
  CRITIC_BLOCK_RE,
  newThreadId,
  parseSpans,
  sanitizeAuthor,
  sanitizeBody,
  type CommentEntry,
} from "../../src/criticMarkup";
import {
  META_SUFFIX,
  emptyMeta,
  expandMarkdown,
  extractMarkdown,
  metaIsEmpty,
  migrateEntity,
  parseEntityMeta,
  serializeEntityMeta,
  type EntityMeta,
} from "../../src/metaFile";

export type Thread = {
  id: string;
  version: Version;
  /** The text it is anchored on: the marked words, or the start of the element. */
  on: string;
  /** Markdown only: the line its marker is on, 1-based. */
  line?: number;
  /** Html only: the element it is on. */
  tag?: string;
  /** Its anchor is gone — the marker was removed, or no element matches any more. */
  orphaned?: true;
  comments: { author: string; at: number; body: string }[];
};

const entries = (comments: readonly CommentEntry[]): Thread["comments"] =>
  comments.map((c) => ({ author: c.author, at: c.at, body: c.body }));

const lineAt = (text: string, index: number): number => {
  let line = 1;
  for (let i = text.indexOf("\n"); i >= 0 && i < index; i = text.indexOf("\n", i + 1)) line += 1;
  return line;
};

/** Every CriticMarkup block in a text: where it is, and the words it wraps. */
function blocksOf(md: string): { index: number; end: number; anchor: string; spans: string }[] {
  const out: { index: number; end: number; anchor: string; spans: string }[] = [];
  const re = new RegExp(CRITIC_BLOCK_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    out.push({ index: m.index, end: m.index + m[0].length, anchor: m[1], spans: m[2] });
    if (re.lastIndex === m.index) re.lastIndex += 1;
  }
  return out;
}

/**
 * Every thread on a document, both versions. Pure: the texts in, the threads
 * out. `md` and `html` are null when the document has no such version — a
 * thread recorded for a version that is gone reads as orphaned. `skip` is the
 * lines above what the reader is shown — a card's properties — so a line is
 * numbered as `read` shows it.
 */
export function threadsOf(md: string | null, html: string | null, meta: EntityMeta, skip = 0): Thread[] {
  const out: Thread[] = [];

  if (md !== null) {
    // The app's own reading of the pair: bodies re-inlined, then split out
    // again, so an old inline-format thread and a hybrid one look the same.
    const expanded = expandMarkdown(md, meta.mthreads);
    const extracted = extractMarkdown(expanded.md);
    const bodies = new Map(extracted.mthreads.map((t) => [t.id, t.comments]));
    const raw = blocksOf(md);
    const bare = blocksOf(extracted.md);
    const seen = new Set<string>();
    bare.forEach((block, i) => {
      const parsed = parseSpans(block.spans);
      const id = parsed.id;
      if (id === null || seen.has(id) || !bodies.has(id)) return;
      seen.add(id);
      out.push({
        id,
        version: "md",
        on: block.anchor,
        ...(raw.length === bare.length ? { line: lineAt(md, raw[i].index) - skip } : {}),
        comments: entries(bodies.get(id) ?? []),
      });
    });
    for (const t of meta.mthreads) {
      if (expanded.orphanIds.includes(t.id)) out.push({ id: t.id, version: "md", on: "", orphaned: true, comments: entries(t.comments) });
    }
  } else {
    for (const t of meta.mthreads) out.push({ id: t.id, version: "md", on: "", orphaned: true, comments: entries(t.comments) });
  }

  const elements = html !== null && meta.hthreads.length > 0 ? elementsOf(html) : null;
  for (const t of meta.hthreads) {
    const resolves = elements !== null && anchorResolves(elements, t.anchor);
    out.push({
      id: t.id,
      version: "html",
      on: t.anchor.text,
      tag: t.anchor.tag,
      ...(resolves ? {} : { orphaned: true as const }),
      comments: entries(t.comments),
    });
  }
  return out;
}

/* ---------- Reading ---------- */

export async function getComments({ env, url }: Call): Promise<Response> {
  const path = url.searchParams.get("path") ?? "";
  const ws = await openWorkspace(env);
  if (!ws) return notBound();
  const doc = documentAt(new Index(ws.manifest.files), path);
  if (doc instanceof Refusal) return refuse(doc);
  const text = async (e: Doc["md"]): Promise<string | null> => {
    if (!e) return null;
    const obj = await env.DATA.get(blobKey(e.fid, e.file.hash));
    return obj ? obj.text() : null;
  };
  const meta = doc.meta ? parseEntityMeta((await text(doc.meta)) ?? "") : emptyMeta();
  const [md, html] = await Promise.all([text(doc.md), meta.hthreads.length > 0 ? text(doc.html) : Promise.resolve(null)]);
  if (doc.board) {
    // A card's page: its lines counted below its properties, and no html
    // threads, since a card has no html version to put them on.
    const skip = md === null ? 0 : headLines(splitCard(md).head);
    return json({ path: doc.stem, board: doc.board, threads: threadsOf(md, null, { ...meta, hthreads: [] }, skip) });
  }
  return json({ path: doc.stem, threads: threadsOf(md, html, meta) });
}

/* ---------- Where a new markdown thread may sit ---------- */

/** Why these words cannot carry a comment, whatever the text — or null. */
function anchorProblem(on: string): string | null {
  if (on === "") return "say which words the comment is on";
  if (/[\r\n]/.test(on)) return "a comment sits on words within one paragraph — quote text from a single line";
  // The marker has to land inside one run of plain text: the app reads
  // markers out of text, never across a formatting boundary.
  if (/[*`[\]<>|\\{}]|~~/.test(on) || /(^|[\s(])_|_($|[\s).,;:!?])/.test(on)) {
    return "quote plain words — without formatting marks such as **, backticks, links or table bars";
  }
  return null;
}

/** Stretches of a markdown text no marker may be written into, with why. */
function closedRanges(md: string): { from: number; to: number; why: string }[] {
  const out: { from: number; to: number; why: string }[] = [];
  const add = (re: RegExp, why: string): void => {
    let m: RegExpExecArray | null;
    while ((m = re.exec(md)) !== null) {
      out.push({ from: m.index, to: m.index + m[0].length, why });
      if (re.lastIndex === m.index) re.lastIndex += 1;
    }
  };
  const front = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(md);
  if (front) out.push({ from: 0, to: front[0].length, why: "the properties at the top" });
  add(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n {0,3}\1[`~]*[ \t]*(?=\n|$)|$)/gm, "a code block");
  add(/`[^`\n]+`/g, "code");
  add(/\]\([^)\n]*\)/g, "a link's address");
  add(/<[^>\n]+>/g, "an html tag");
  add(/https?:\/\/[^\s)>\]]+/g, "a link's address");
  add(/\{==[\s\S]+?==\}(?:\{>>[\s\S]*?<<\})*/g, "an existing comment");
  add(/\{>>[\s\S]*?<<\}/g, "an existing comment");
  return out;
}

type Occurrence = { line: number; text: string; inside?: string };

/**
 * The one place in a markdown text where `on` can be marked. The words must
 * occur exactly once outside anything a marker would break — code, a link's
 * address, the frontmatter, another comment. Anything else is refused with
 * every occurrence listed, so the caller can quote more of the sentence.
 */
function placeForMarker(md: string, on: string, name: string): number | Refusal {
  const closed = closedRanges(md);
  const found: (Occurrence & { index: number })[] = [];
  for (let i = md.indexOf(on); i >= 0; i = md.indexOf(on, i + on.length)) {
    const lineStart = md.lastIndexOf("\n", i - 1) + 1;
    const lineEnd = md.indexOf("\n", i);
    const lineText = md.slice(lineStart, lineEnd < 0 ? md.length : lineEnd);
    const blocker = closed.find((r) => i < r.to && i + on.length > r.from);
    // Words that open a line and begin with a block mark would take the mark
    // inside the marker with them, and the line would stop being a heading.
    const opensLine = md.slice(lineStart, i).trim() === "" && /^(#{1,6}\s|[-+]\s|\d+[.)]\s|>|={3,}|-{3,})/.test(on);
    found.push({
      index: i,
      line: lineAt(md, i),
      text: lineText.trim().slice(0, 160),
      ...(blocker ? { inside: blocker.why } : opensLine ? { inside: "a heading or list mark — quote the words after it" } : {}),
    });
  }
  const open = found.filter((f) => f.inside === undefined);
  if (open.length === 1) return open[0].index;
  // One row a line: a word that occurs four times in a sentence is one place to look.
  const occurrences: Occurrence[] = [];
  for (const { index: _index, ...rest } of found) {
    if (occurrences.length < 20 && !occurrences.some((o) => o.line === rest.line && o.inside === rest.inside)) occurrences.push(rest);
  }
  // Words that are not there are not found; words that are there but cannot
  // carry a comment, or are there more than once, are a conflict with the
  // text as it stands. `edit --find` draws the same line.
  if (found.length === 0) {
    return new Refusal(404, `"${on}" does not occur in the markdown of ${name} — quote the words exactly as reading it shows them`, {
      code: "anchor",
      occurrences,
    });
  }
  if (open.length === 0) {
    return new Refusal(409, `"${on}" only occurs inside ${found[0].inside} in ${name} — a comment needs words in ordinary text`, {
      code: "anchor",
      occurrences,
    });
  }
  return new Refusal(409, `"${on}" occurs ${open.length} times in ${name} — quote more of the sentence, so that it occurs once`, {
    code: "anchor",
    occurrences,
  });
}

/* ---------- Changing ---------- */

/** The document's sidecar and markdown as a change starts from them: parsed,
 *  and normalized to the hybrid layout the way the app normalizes on open —
 *  so every change below works on bare markers and sidecar records only. */
async function openThreads(tx: Tx, doc: Doc): Promise<{ md: string | null; meta: EntityMeta } | Refusal> {
  const meta = doc.meta ? parseEntityMeta((await tx.readText(doc.meta.fid)) ?? "") : emptyMeta();
  if (!doc.md) return { md: null, meta };
  const md = await tx.readText(doc.md.fid);
  if (md === null) return new Refusal(503, "its content has not finished syncing — try again in a moment");
  const migrated = migrateEntity({ diskMd: md, meta });
  return { md: migrated.md, meta: migrated.meta };
}

/** Store what a change left: the markdown when it changed, and the sidecar —
 *  created when there is now something to keep, removed when there is not. */
async function saveThreads(tx: Tx, doc: Doc, md: string | null, meta: EntityMeta): Promise<void> {
  const encode = (s: string): Uint8Array => new TextEncoder().encode(s);
  if (doc.md && md !== null) await tx.write(doc.md.fid, doc.md.file.path, encode(md), contentTypeOf(doc.md.file.path));
  if (metaIsEmpty(meta)) {
    if (doc.meta) tx.remove(doc.meta.fid);
    return;
  }
  const path = doc.meta?.file.path ?? `${doc.stem}${META_SUFFIX}`;
  await tx.write(doc.meta?.fid ?? newFileId(), path, encode(serializeEntityMeta(meta)), contentTypeOf(path));
}

/** An id no thread on this document has. */
function freshThreadId(md: string | null, meta: EntityMeta): string {
  const taken = new Set([...meta.mthreads.map((t) => t.id), ...meta.hthreads.map((t) => t.id)]);
  for (;;) {
    const id = newThreadId();
    if (!taken.has(id) && !(md ?? "").includes(`#${id}`)) return id;
  }
}

export async function postComment(c: Call): Promise<Response> {
  const { request, env, who } = c;
  const body = await readJsonObject(request);
  if (!body) return json({ error: "invalid json body" }, 400);
  const path = typeof body.path === "string" ? body.path : "";
  const said = typeof body.body === "string" ? sanitizeBody(body.body) : "";
  if (!said) return json({ error: "a comment needs something to say" }, 400);
  const thread = typeof body.thread === "string" ? body.thread.replace(/^#/, "").trim() : "";
  const on = typeof body.on === "string" ? body.on.trim() : "";
  if (!thread && !on) return json({ error: "say which words the comment is on, or which thread it answers" }, 400);
  const flag = versionFlag(body.v);
  if (flag instanceof Refusal) return refuse(flag);
  // A new thread is on one version: the one the flag names, or the one the
  // path was typed with — `plan.html` means the page, as it does to a read.
  const asked = thread ? null : askedVersion(path, flag);
  if (asked instanceof Refusal) return refuse(asked);

  const done = await commit(env, who.id, async (tx) => {
    const doc = documentAt(new Index(tx.files), path);
    if (doc instanceof Refusal) return doc;
    const open = await openThreads(tx, doc);
    if (open instanceof Refusal) return open;
    // To the second: the markdown form of a thread keeps no finer time
    // (criticMarkup.ts, `formatEntry`), so a record stamped more finely would
    // differ from its own round trip — and every Mac that opened the document
    // would rewrite the sidecar to say so (`migrateEntity`).
    const entry: CommentEntry = { author: sanitizeAuthor(who.name), at: Math.floor(tx.now / 1000) * 1000, body: said };
    const value = thread ? reply(doc, open, thread, entry) : await start(tx, doc, open, on, asked, entry);
    if (value instanceof Refusal) return value;
    await saveThreads(tx, doc, value.md, open.meta);
    return value.answer;
  }, { dryRun: body.dryRun === true });
  if (done instanceof Refusal) return refuse(done);
  await mirrorAfter(c, done);
  return json({ ...done.value, ...(done.wrote ? {} : { written: false }) }, thread || !done.wrote ? 200 : 201);
}

type Changed = { md: string | null; answer: Record<string, unknown> };

function reply(doc: Doc, open: { md: string | null; meta: EntityMeta }, id: string, entry: CommentEntry): Changed | Refusal {
  const md = open.meta.mthreads.find((t) => t.id === id);
  const html = md ? undefined : open.meta.hthreads.find((t) => t.id === id);
  const found = md ?? html;
  if (!found) return new Refusal(404, `${doc.stem} has no thread #${id}`);
  found.comments = [...found.comments, entry];
  return { md: open.md, answer: { path: doc.stem, thread: id, version: md ? "md" : "html", comments: found.comments.length } };
}

async function start(
  tx: Tx,
  doc: Doc,
  open: { md: string | null; meta: EntityMeta },
  on: string,
  asked: Version | null,
  entry: CommentEntry,
): Promise<Changed | Refusal> {
  const version: Version = asked ?? (doc.md ? "md" : "html");
  const id = freshThreadId(open.md, open.meta);

  if (version === "md") {
    if (!doc.md || open.md === null) return new Refusal(404, `${doc.stem} has no markdown version — comment on its html with --html`);
    const problem = anchorProblem(on);
    if (problem) return new Refusal(400, problem);
    // A card's words are looked for on its page, and its lines numbered there.
    const head = doc.board ? splitCard(open.md).head : "";
    const page = open.md.slice(head.length);
    const at = placeForMarker(page, on, doc.stem);
    if (at instanceof Refusal) return at;
    const md = `${head}${page.slice(0, at)}{==${on}==}{>>#${id}<<}${page.slice(at + on.length)}`;
    open.meta.mthreads = [...open.meta.mthreads, { id, comments: [entry] }];
    return { md, answer: { path: doc.stem, thread: id, version, on, line: lineAt(page, at) } };
  }

  if (!doc.html) return new Refusal(404, `${doc.stem} has no html version`);
  const html = await tx.readText(doc.html.fid);
  if (html === null) return new Refusal(503, "its content has not finished syncing — try again in a moment");
  // An html thread sits on an element, found by how its text begins — the
  // same handle the app falls back to when a page is regenerated.
  const hits = elementsStartingWith(elementsOf(html), on);
  if (hits.length !== 1) {
    const candidates = hits.slice(0, 20).map((el) => ({ tag: el.tag, text: el.text }));
    return new Refusal(
      hits.length === 0 ? 404 : 409,
      hits.length === 0
        ? `nothing on the html page of ${doc.stem} begins with "${normalizeText(on).slice(0, ANCHOR_TEXT_LEN)}" — give the opening words of a heading, a paragraph or a list item`
        : `${hits.length} elements on the html page of ${doc.stem} begin with those words — give more of them`,
      { code: "anchor", candidates },
    );
  }
  const el = hits[0];
  open.meta.hthreads = [...open.meta.hthreads, { id, anchor: { path: "", tag: el.tag, text: el.text }, comments: [entry] }];
  return { md: open.md, answer: { path: doc.stem, thread: id, version, on: el.text, tag: el.tag } };
}

export async function deleteComment(c: Call): Promise<Response> {
  const { env, url, who } = c;
  const path = url.searchParams.get("path") ?? "";
  const id = (url.searchParams.get("thread") ?? "").replace(/^#/, "").trim();
  if (!id) return json({ error: "say which thread" }, 400);

  const done = await commit(env, who.id, async (tx) => {
    const doc = documentAt(new Index(tx.files), path);
    if (doc instanceof Refusal) return doc;
    const open = await openThreads(tx, doc);
    if (open instanceof Refusal) return open;
    const { meta } = open;
    let md = open.md;
    let version: Version;
    if (meta.mthreads.some((t) => t.id === id)) {
      version = "md";
      meta.mthreads = meta.mthreads.filter((t) => t.id !== id);
      // The marker goes with the thread: the words it wrapped stay.
      if (md !== null) {
        md = md.replace(new RegExp(CRITIC_BLOCK_RE.source, "g"), (whole, anchor: string, spans: string) =>
          parseSpans(spans).id === id ? anchor : whole,
        );
      }
    } else if (meta.hthreads.some((t) => t.id === id)) {
      version = "html";
      meta.hthreads = meta.hthreads.filter((t) => t.id !== id);
    } else {
      return new Refusal(404, `${doc.stem} has no thread #${id}`);
    }
    await saveThreads(tx, doc, md, meta);
    return { path: doc.stem, thread: id, version };
  }, { dryRun: url.searchParams.get("dry") === "1" });
  if (done instanceof Refusal) return refuse(done);
  await mirrorAfter(c, done);
  return json({ ...done.value, removed: done.wrote });
}
