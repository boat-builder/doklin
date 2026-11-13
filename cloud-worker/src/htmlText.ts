// A small, tolerant reading of html markup — enough to answer the two
// questions the document API asks of a document's html version, without a
// DOM (a Worker has none):
//
//   · what are its elements, and what does each one's text begin with? — so a
//     comment can be anchored to "the element that starts with these words",
//     and an existing anchor checked for whether it still resolves;
//   · what does it say? — the visible text, for search.
//
// It is not a parser of record. The app resolves a comment's anchor in a real
// browser (src/htmlBridge.ts, `resolveAnchor`), by the element's tag and the
// start of its text; this only has to agree with the browser about those two
// things for ordinary markup, and it never has to produce a tree.

/** As much of an element's text as an anchor keeps (htmlBridge.ts `normText`). */
export const ANCHOR_TEXT_LEN = 120;

export type HtmlElement = {
  tag: string;
  /** The element's text, whitespace collapsed, trimmed, cut to the anchor length. */
  text: string;
  /** Its ancestors' indexes in the list, outermost first — what makes one element "inside" another. */
  ancestors: number[];
};

const VOID_TAGS: ReadonlySet<string> = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);
/** Elements whose content is text up to their own closing tag, whatever it looks like. */
const RAW_TEXT_TAGS: ReadonlySet<string> = new Set(["script", "style", "textarea", "title"]);
/** Elements nobody reads: their text is not part of what the page says. */
const UNSEEN_TAGS: ReadonlySet<string> = new Set(["script", "style", "template", "noscript", "head", "title"]);
/** Opening one of these closes an open <p>, as a browser does. */
const CLOSES_P: ReadonlySet<string> = new Set([
  "address", "article", "aside", "blockquote", "div", "dl", "fieldset", "figure", "footer", "form",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "nav", "ol", "p", "pre", "section", "table", "ul",
]);
/** An open element of the left kind is closed by opening one of the right. */
const CLOSED_BY: Record<string, ReadonlySet<string>> = {
  li: new Set(["li"]),
  dt: new Set(["dt", "dd"]),
  dd: new Set(["dt", "dd"]),
  tr: new Set(["tr", "tbody", "tfoot"]),
  td: new Set(["td", "th", "tr", "tbody", "tfoot"]),
  th: new Set(["td", "th", "tr", "tbody", "tfoot"]),
  option: new Set(["option", "optgroup"]),
};
/** Wrappers an implied close reaches through. */
const INLINE_TAGS: ReadonlySet<string> = new Set(["a", "b", "code", "em", "i", "s", "small", "span", "strong", "u"]);
/** Elements that end a line of text. */
const BLOCK_TAGS: ReadonlySet<string> = new Set([...CLOSES_P, "li", "tr", "br", "dt", "dd", "td", "th", "caption", "title"]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", copy: "©", reg: "®", trade: "™", middot: "·", bull: "•",
};

function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** `\s`, without paying for a regex on every ordinary character. */
function isSpace(c: string): boolean {
  const code = c.charCodeAt(0);
  return code <= 32 || code === 0xa0 || (code >= 0x1680 && /\s/.test(c));
}

type Sink = {
  open(tag: string): void;
  close(tag: string): void;
  text(chunk: string): void;
};

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
    i = j < n ? j + 1 : n;
    if (m[1] === "/") {
      sink.close(tag);
      continue;
    }
    sink.open(tag);
    if (VOID_TAGS.has(tag) || selfClosed) {
      sink.close(tag);
    } else if (RAW_TEXT_TAGS.has(tag)) {
      const end = html.toLowerCase().indexOf(`</${tag}`, i);
      const stop = end < 0 ? n : end;
      sink.text(html.slice(i, stop));
      i = stop;
    }
  }
}

/** Every element of the document, in document order, with the start of its text. */
export function elementsOf(html: string): HtmlElement[] {
  type Open = { index: number; tag: string; text: string; space: boolean; full: boolean };
  const out: HtmlElement[] = [];
  const stack: Open[] = [];
  const done = (o: Open): void => {
    out[o.index].text = o.text.trimEnd().slice(0, ANCHOR_TEXT_LEN);
  };
  const closeTo = (depth: number): void => {
    while (stack.length > depth) done(stack.pop()!);
  };
  walk(html, {
    open(tag) {
      // The nearest open element this tag closes, as a browser would close
      // it — provided only inline wrappers and paragraphs sit inside it. An
      // <li> opened inside a nested list closes nothing above that list.
      for (let d = stack.length - 1; d >= 0; d -= 1) {
        const o = stack[d];
        if ((o.tag === "p" && CLOSES_P.has(tag)) || CLOSED_BY[o.tag]?.has(tag)) {
          closeTo(d);
          break;
        }
        if (o.tag !== "p" && !INLINE_TAGS.has(o.tag)) break;
      }
      out.push({ tag, text: "", ancestors: stack.map((o) => o.index) });
      stack.push({ index: out.length - 1, tag, text: "", space: false, full: false });
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
      // Every open element's text grows by this run — that is what
      // `textContent` is — collapsed as it goes and stopped once there is
      // more than an anchor ever keeps.
      for (const o of stack) {
        if (o.full) continue;
        for (let k = 0; k < chunk.length; k += 1) {
          const c = chunk[k];
          if (isSpace(c)) {
            o.space = o.text.length > 0;
          } else {
            if (o.space) o.text += " ";
            o.space = false;
            o.text += c;
          }
          if (o.text.length > ANCHOR_TEXT_LEN) {
            o.full = true;
            break;
          }
        }
      }
    },
  });
  closeTo(0);
  return out;
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

/** Whitespace collapsed and trimmed — how an anchor's text is compared. */
export const normalizeText = (s: string): string => s.replace(/\s+/g, " ").trim();

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
    if (el.text.startsWith(want.slice(0, ANCHOR_TEXT_LEN))) hits.add(i);
  });
  const outer = new Set<number>();
  for (const i of hits) for (const a of elements[i].ancestors) if (hits.has(a)) outer.add(a);
  return [...hits].filter((i) => !outer.has(i)).map((i) => elements[i]);
}

/** Whether a stored anchor still finds an element — the bridge's own
 *  fallback: same tag, and one text is the start of the other. */
export function anchorResolves(elements: readonly HtmlElement[], anchor: { tag: string; text: string }): boolean {
  if (!anchor.text) return true; // nothing to compare by; only a browser can say
  return elements.some(
    (el) => el.tag === anchor.tag && el.text !== "" && (el.text.startsWith(anchor.text) || anchor.text.startsWith(el.text)),
  );
}
