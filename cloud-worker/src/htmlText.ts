// A small, tolerant reading of html markup — enough to answer the questions
// the document API asks of a document's html version, without a DOM (a Worker
// has none):
//
//   · what does the page say, as one run of text, and what are its elements
//     (their tag, their id, where their words are in that text)? — so a
//     comment can be put on "the element that starts with these words" or on
//     the one with an id, and a thread's place checked for whether the file
//     still has it;
//   · what does it say, a block to a line? — the visible text, for search.
//
// It is not a parser of record. The app finds a thread's place in a real
// browser, in the page as drawn (src/htmlBridge.ts, "finding a place"); this
// reads the file as written, by the same rules — the page as one run of
// text, the three ways of looking for words, how a part's text agrees with
// an anchor's — and only has to agree with the browser for ordinary markup.
// What a page's own script builds is not in the file, so a thread this does
// not find on a page that runs script is one it cannot tell about, not one
// that is gone (`placeOf`).
//
// The iPhone reads a page's threads with a port of this file
// (ios/DoklinKit/Sources/DoklinKit/Comments/HtmlText.swift). The app's
// script, this and the port are held to verify-harness/comments-fixture.json
// (`places`) — change all three.

import { ANCHOR_IDS_MAX, ANCHOR_ID_LEN, ANCHOR_TEXT_LEN, type HtmlAnchor } from "../../src/htmlComments";

export type HtmlElement = {
  tag: string;
  /** Its id, "" for none. */
  id: string;
  /** The start of what it says, as an anchor keeps it: its words in the page's text, or a picture's alt text, else its file name. */
  text: string;
  /** Where its words are in the page's text. */
  from: number;
  to: number;
  /** Its ancestors' indexes in the list, outermost first — what makes one element "inside" another. */
  ancestors: number[];
};

/** A page as read from its file. */
export type Page = {
  /** What it says, as one run of text (htmlBridge.ts `buildModel`). */
  text: string;
  /** Every element, in document order. */
  elements: HtmlElement[];
  /** It runs script, which may build more than the file has. */
  runsScript: boolean;
};

const VOID_TAGS: ReadonlySet<string> = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);
/** Elements whose content is text up to their own closing tag, whatever it looks like. */
const RAW_TEXT_TAGS: ReadonlySet<string> = new Set(["script", "style", "textarea", "title"]);
/** Elements nobody reads: their text is not part of what the page says. */
const UNSEEN_TAGS: ReadonlySet<string> = new Set(["script", "style", "template", "noscript", "head", "title"]);
/** The same for the page as one run of text (htmlBridge.ts `SKIP`, and the head, which is not the page's body). */
const NOT_TEXT: ReadonlySet<string> = new Set(["script", "style", "noscript", "template", "textarea", "title", "desc", "head"]);
/** Words in a line, never a block of their own (htmlBridge.ts `INLINE`). */
const IN_LINE: ReadonlySet<string> = new Set([
  "a", "abbr", "b", "bdi", "bdo", "big", "cite", "code", "del", "dfn", "em", "font", "i", "ins", "kbd", "label", "mark", "q", "s", "samp",
  "small", "span", "strike", "strong", "sub", "sup", "time", "tt", "u", "var", "wbr",
]);
/** Opening one of these closes an open <p>, as a browser does. */
const CLOSES_P: ReadonlySet<string> = new Set([
  "address", "article", "aside", "blockquote", "div", "dl", "fieldset", "figure", "footer", "form",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "nav", "ol", "p", "pre", "section", "table", "ul",
]);
/** An open element of the left kind is closed by opening one of the right. A map, not an object: a page may name an element anything. */
const CLOSED_BY: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["li", new Set(["li"])],
  ["dt", new Set(["dt", "dd"])],
  ["dd", new Set(["dt", "dd"])],
  ["tr", new Set(["tr", "tbody", "tfoot"])],
  ["td", new Set(["td", "th", "tr", "tbody", "tfoot"])],
  ["th", new Set(["td", "th", "tr", "tbody", "tfoot"])],
  ["option", new Set(["option", "optgroup"])],
]);
/** Wrappers an implied close reaches through. */
const INLINE_TAGS: ReadonlySet<string> = new Set(["a", "b", "code", "em", "i", "s", "small", "span", "strong", "u"]);
/** Elements that end a line of text. */
const BLOCK_TAGS: ReadonlySet<string> = new Set([...CLOSES_P, "li", "tr", "br", "dt", "dd", "td", "th", "caption", "title"]);

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map(Object.entries({
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", ndash: "–", mdash: "—", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", copy: "©", reg: "®", trade: "™", middot: "·", bull: "•",
}));

function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES.get(body.toLowerCase()) ?? whole;
  });
}

/** `\s`, without paying for a regex on every ordinary character. */
function isSpace(c: string): boolean {
  const code = c.charCodeAt(0);
  return code <= 32 || code === 0xa0 || (code >= 0x1680 && /\s/.test(c));
}

type Sink = {
  /** `attrs`: everything between the tag's name and its end, as written. */
  open(tag: string, attrs: string): void;
  close(tag: string): void;
  text(chunk: string): void;
};

/** One attribute of a tag as written (`attrs`), entities decoded; null when it has none by that name. The first of two wins, as in a browser. */
function attrOf(attrs: string, name: string): string | null {
  const n = attrs.length;
  let i = 0;
  while (i < n) {
    while (i < n && (isSpace(attrs[i]) || attrs[i] === "/")) i += 1;
    const start = i;
    while (i < n && !isSpace(attrs[i]) && attrs[i] !== "=" && attrs[i] !== "/" && attrs[i] !== ">") i += 1;
    if (i === start) {
      i += 1; // a stray "=" or ">"
      continue;
    }
    const key = attrs.slice(start, i).toLowerCase();
    while (i < n && isSpace(attrs[i])) i += 1;
    let value = "";
    if (attrs[i] === "=") {
      i += 1;
      while (i < n && isSpace(attrs[i])) i += 1;
      const quote = attrs[i];
      if (quote === '"' || quote === "'") {
        const end = attrs.indexOf(quote, i + 1);
        value = attrs.slice(i + 1, end < 0 ? n : end);
        i = end < 0 ? n : end + 1;
      } else {
        const from = i;
        while (i < n && !isSpace(attrs[i]) && attrs[i] !== ">") i += 1;
        value = attrs.slice(from, i);
      }
    }
    if (key === name) return decodeEntities(value);
  }
  return null;
}

/** Walk the markup once, telling `sink` about every element and text run. */
function walk(html: string, sink: Sink): void {
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      sink.text(decodeEntities(html.slice(i)));
      break;
    }
    if (lt > i) sink.text(decodeEntities(html.slice(i, lt)));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    const next = html.charCodeAt(lt + 1);
    if (next === 33 /* ! */ || next === 63 /* ? */) {
      const end = html.indexOf(">", lt);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(lt, lt + 64));
    if (!m) {
      // A bare "<" in prose.
      sink.text("<");
      i = lt + 1;
      continue;
    }
    const tag = m[2].toLowerCase();
    // The end of the tag: the first ">" outside a quoted attribute value.
    let j = lt + m[0].length;
    let quote = 0;
    for (; j < n; j += 1) {
      const c = html.charCodeAt(j);
      if (quote) {
        if (c === quote) quote = 0;
      } else if (c === 34 || c === 39) quote = c;
      else if (c === 62) break;
    }
    const selfClosed = html.charCodeAt(j - 1) === 47;
    const attrs = html.slice(lt + m[0].length, j);
    i = j < n ? j + 1 : n;
    if (m[1] === "/") {
      sink.close(tag);
      continue;
    }
    sink.open(tag, attrs);
    if (VOID_TAGS.has(tag) || selfClosed) {
      sink.close(tag);
    } else if (RAW_TEXT_TAGS.has(tag)) {
      // Its closing tag in any case, found in the markup itself: lower-casing
      // the page to look would move every index after a letter that
      // lower-cases to two.
      const closing = new RegExp(`</${tag}`, "gi");
      closing.lastIndex = i;
      const stop = closing.exec(html)?.index ?? n;
      sink.text(html.slice(i, stop));
      i = stop;
    }
  }
}

/** Whitespace collapsed and trimmed — how an anchor's text is compared. */
export const normalizeText = (s: string): string => s.replace(/\s+/g, " ").trim();

/** What a picture is called: its alt text, else its file name (htmlBridge.ts `pictureText`). */
function pictureText(attrs: string): string {
  const alt = normalizeText(attrOf(attrs, "alt") ?? "");
  if (alt) return alt.slice(0, ANCHOR_TEXT_LEN);
  const src = attrOf(attrs, "src") ?? "";
  if (/^\s*data:/i.test(src)) return "";
  const path = src.split("#")[0].split("?")[0];
  return normalizeText(path.slice(path.lastIndexOf("/") + 1)).slice(0, ANCHOR_TEXT_LEN);
}

/** A script the browser would run: no type, a module, or a JavaScript type. */
function runs(attrs: string): boolean {
  const type = (attrOf(attrs, "type") ?? "").trim().toLowerCase();
  return type === "" || type === "module" || type.includes("javascript") || type.includes("ecmascript");
}

/**
 * The page as the app's script reads it (htmlBridge.ts `buildModel`), from
 * the file: its text as one run — every stretch of whitespace one space, a
 * space between two blocks or across a <br>, nothing of what nobody reads —
 * and every element with where its words are in that run.
 */
export function readPage(html: string): Page {
  type Open = { index: number; tag: string };
  const elements: HtmlElement[] = [];
  const pictures = new Map<number, string>();
  const stack: Open[] = [];
  let text = "";
  let lastSpace = true;
  let boundary = false;
  let previousBlock: number | null = null;
  let unread = 0; // how many open elements are ones nobody reads
  let runsScript = false;
  // Elements whose words begin, or end, where the next text does.
  let begins: number[] = [];
  let ends: number[] = [];
  const settle = (): void => {
    for (const i of begins) elements[i].from = text.length;
    for (const i of ends) elements[i].to = text.length;
    begins = [];
    ends = [];
  };
  const closeTo = (depth: number): void => {
    while (stack.length > depth) {
      const o = stack.pop()!;
      if (NOT_TEXT.has(o.tag)) unread -= 1;
      ends.push(o.index);
    }
  };
  walk(html, {
    open(tag, attrs) {
      // The nearest open element this tag closes, as a browser would close
      // it — provided only inline wrappers and paragraphs sit inside it. An
      // <li> opened inside a nested list closes nothing above that list.
      for (let d = stack.length - 1; d >= 0; d -= 1) {
        const o = stack[d];
        if ((o.tag === "p" && CLOSES_P.has(tag)) || CLOSED_BY.get(o.tag)?.has(tag)) {
          closeTo(d);
          break;
        }
        if (o.tag !== "p" && !INLINE_TAGS.has(o.tag)) break;
      }
      if (tag === "br" && unread === 0) boundary = true;
      if (tag === "script" && runs(attrs)) runsScript = true;
      const index = elements.length;
      elements.push({ tag, id: attrOf(attrs, "id") ?? "", text: "", from: 0, to: 0, ancestors: stack.map((o) => o.index) });
      if (tag === "img") pictures.set(index, pictureText(attrs));
      begins.push(index);
      stack.push({ index, tag });
      if (NOT_TEXT.has(tag)) unread += 1;
    },
    close(tag) {
      for (let d = stack.length - 1; d >= 0; d -= 1) {
        if (stack[d].tag === tag) {
          closeTo(d);
          return;
        }
      }
    },
    text(chunk) {
      if (unread > 0 || chunk === "") return;
      // Words in two blocks, or either side of a line break, are apart even
      // where the markup puts no space between them.
      let block = -1;
      for (let d = stack.length - 1; d >= 0; d -= 1) {
        if (!IN_LINE.has(stack[d].tag)) {
          block = stack[d].index;
          break;
        }
      }
      if ((boundary || (previousBlock !== null && block !== previousBlock)) && !lastSpace) {
        text += " ";
        lastSpace = true;
      }
      boundary = false;
      previousBlock = block;
      settle();
      for (let k = 0; k < chunk.length; k += 1) {
        const code = chunk.charCodeAt(k);
        if (code === 8203 || code === 8204 || code === 8205 || code === 65279 || code === 173) continue;
        if (code === 32 || code === 160 || (code >= 9 && code <= 13) || code === 8239 || code === 8201) {
          if (!lastSpace) {
            text += " ";
            lastSpace = true;
          }
        } else {
          text += chunk[k];
          lastSpace = false;
        }
      }
    },
  });
  closeTo(0);
  settle();
  elements.forEach((el, i) => {
    const picture = pictures.get(i);
    // Its words without the space either side of them (`wordsOf`): a space
    // is the only whitespace the run has.
    el.text = picture ?? text.slice(el.from, el.to).replace(/^ +| +$/g, "").slice(0, ANCHOR_TEXT_LEN);
  });
  return { text, elements, runsScript };
}

/** What an html document says: its visible text, one block to a line. */
export function textOf(html: string): string {
  const parts: string[] = [];
  let unseen = 0;
  const stack: string[] = [];
  walk(html, {
    open(tag) {
      stack.push(tag);
      if (UNSEEN_TAGS.has(tag)) unseen += 1;
      if (BLOCK_TAGS.has(tag)) parts.push("\n");
    },
    close(tag) {
      const at = stack.lastIndexOf(tag);
      if (at < 0) return;
      for (const gone of stack.splice(at)) if (UNSEEN_TAGS.has(gone)) unseen -= 1;
      if (BLOCK_TAGS.has(tag)) parts.push("\n");
    },
    text(chunk) {
      if (unseen === 0) parts.push(chunk);
    },
  });
  return parts
    .join("")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "")
    .join("\n");
}

/** Elements a comment is never anchored to: the page's frame, and what nobody sees. */
const NOT_ANCHORS: ReadonlySet<string> = new Set(["html", "head", "body", ...UNSEEN_TAGS, "meta", "link", "base"]);

/**
 * The elements whose text begins with `words`, innermost only: when a
 * paragraph and the list item around it both begin with the words, the
 * paragraph is the one meant.
 */
export function elementsStartingWith(elements: readonly HtmlElement[], words: string): HtmlElement[] {
  const want = normalizeText(words);
  if (want === "") return [];
  const hits = new Set<number>();
  elements.forEach((el, i) => {
    if (NOT_ANCHORS.has(el.tag) || el.ancestors.some((a) => UNSEEN_TAGS.has(elements[a].tag))) return;
    if (el.text !== "" && el.text.startsWith(want.slice(0, ANCHOR_TEXT_LEN))) hits.add(i);
  });
  const outer = new Set<number>();
  for (const i of hits) for (const a of elements[i].ancestors) if (hits.has(a)) outer.add(a);
  return [...hits].filter((i) => !outer.has(i)).map((i) => elements[i]);
}

/** The elements with an id, of those a comment may be on. */
export function elementsWithId(elements: readonly HtmlElement[], id: string): HtmlElement[] {
  return elements.filter(
    (el) => el.id === id && !NOT_ANCHORS.has(el.tag) && !el.ancestors.some((a) => UNSEEN_TAGS.has(elements[a].tag)),
  );
}

/** The ids of an element and of everything around it, nearest first — what an anchor keeps (htmlBridge.ts `idsAround`). */
export function idsAround(elements: readonly HtmlElement[], el: HtmlElement): string[] {
  const around = [...el.ancestors.map((a) => elements[a]), el].reverse();
  return around
    .filter((e) => e.id !== "" && e.tag !== "html" && e.tag !== "body")
    .slice(0, ANCHOR_IDS_MAX)
    .map((e) => e.id.slice(0, ANCHOR_ID_LEN));
}

/* ---------- Looking for words (htmlBridge.ts "finding words") ---------- */

/** The same text with case and typographic marks folded, a character for a character. */
function fold(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    let ch = text[i];
    if (code === 8216 || code === 8217 || code === 8242) ch = "'";
    else if (code === 8220 || code === 8221 || code === 8243) ch = '"';
    else if (code >= 8208 && code <= 8213) ch = "-";
    else {
      const lower = ch.toLowerCase();
      if (lower.length === 1) ch = lower;
    }
    out += ch;
  }
  return out;
}

/** Whether a run within `allowed` edits of the pattern is in a sequence of `count`: Sellers' algorithm, with a free start. */
function hasClose(n: number, count: number, same: (a: number, b: number) => boolean, allowed: number): boolean {
  const distance = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= count; i += 1) {
    let diagonal = distance[0];
    distance[0] = 0;
    for (let j = 1; j <= n; j += 1) {
      const up = distance[j];
      distance[j] = Math.min(diagonal + (same(j - 1, i - 1) ? 0 : 1), up + 1, distance[j - 1] + 1);
      diagonal = up;
    }
    if (distance[n] <= allowed) return true;
  }
  return false;
}

/**
 * Whether a page's text has words close to the quote: for four words or
 * more, up to a third of them changed; for 6 to 80 characters, up to 30% of
 * the characters; otherwise nothing is close enough to say (`findClose`).
 */
function hasCloseWords(text: string, quote: string): boolean {
  const page = fold(text);
  const wanted = fold(quote);
  const words = wanted.split(" ");
  if (words.length >= 4) {
    const tokens = page.split(" ").filter((t) => t !== "").slice(0, 30000);
    if (words.length > 300 || tokens.length === 0) return false;
    return hasClose(words.length, tokens.length, (a, b) => words[a] === tokens[b], Math.floor(words.length * 0.34));
  }
  if (wanted.length < 6 || wanted.length > 80 || page.length > 200000) return false;
  return hasClose(wanted.length, page.length, (a, b) => wanted.charCodeAt(a) === page.charCodeAt(b), Math.max(1, Math.floor(wanted.length * 0.3)));
}

/** Whether a page's text has the words: as written, folded, or close to them. */
function hasWords(text: string, quote: string): boolean {
  if (quote === "") return false;
  return text.includes(quote) || fold(text).includes(fold(quote)) || hasCloseWords(text, quote);
}

/* ---------- A thread's place in the file ---------- */

/**
 * How much of a thread's place the file has:
 *   2  its words (as written, folded or close to them);
 *   1  its part — an element with its tag whose text agrees with the
 *      anchor's (equal, or one begins with the other), or, for a part with
 *      no text, the element with its own id;
 *   0  neither.
 * `known` is false for a 0 that says nothing: the anchor has nothing a file
 * can be checked by, or the page runs script, which may build what the
 * thread is on. A reader says a thread is gone only on a known 0.
 */
export type FilePlace = { level: 0 | 1 | 2; known: boolean };

export function placeOf(page: Page, anchor: HtmlAnchor): FilePlace {
  if (anchor.quote && hasWords(page.text, anchor.quote)) return { level: 2, known: true };
  const ownId = anchor.ids?.[0] ?? "";
  const part =
    anchor.tag !== "" &&
    !NOT_ANCHORS.has(anchor.tag) &&
    page.elements.some((el) => {
      if (el.tag !== anchor.tag || el.ancestors.some((a) => UNSEEN_TAGS.has(page.elements[a].tag))) return false;
      if (anchor.text === "") return el.text === "" && ownId !== "" && el.id === ownId;
      return el.text !== "" && (el.text.startsWith(anchor.text) || anchor.text.startsWith(el.text));
    });
  if (part) return { level: 1, known: true };
  const nothingToGoBy = !anchor.quote && anchor.text === "" && ownId === "";
  return { level: 0, known: !nothingToGoBy && !page.runsScript };
}
