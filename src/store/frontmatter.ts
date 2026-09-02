// The frontmatter dialect — a card's properties, at the top of its note.
//
//   ---
//   status: In progress
//   tags: [bug, auth]
//   due: 2026-09-12
//   rank: a1
//   ---
//   Repro: sign in from a deep link…
//
// Full YAML is a large dependency and a large attack surface for a format
// that here only ever holds FLAT properties, so this module reads and writes
// a strict, documented subset and passes through everything else verbatim:
//
//   key: value        a string (quotes optional)
//   number: 3         a number
//   flag: true        a boolean
//   when: 2026-09-12  a date — an ordinary string, written back as-is
//   list: [a, "b c"]  a list of strings (flow style; what we write)
//   also:             a list of strings (block style — accepted on read)
//     - a
//   empty:            null
//
// Two rules make it safe to own someone else's file:
//
//   1. A file HAS frontmatter only when its very first line is exactly `---`
//      and a closing `---` line follows. That is the rule every other tool
//      applies, so a note that merely starts with a horizontal rule is left
//      alone.
//   2. A line the dialect can't read (a nested map, a multi-line scalar,
//      a comment) becomes an OPAQUE line: kept, re-emitted, never rewritten.
//      The app never turns a file it can't fully read into a file it broke.
//
// The serializer is canonical — declared fields in the store's order, then
// unknown keys alphabetically, then the opaque lines as they were — so equal
// state produces equal bytes on every device. That is what keeps two machines
// writing the same property from conflicting in the sync engine's line-based
// merge, and it is the same discipline metaFile.ts follows for the meta
// sidecar.

export type PropValue = string | number | boolean | string[] | null;
export type Props = Record<string, PropValue>;

export type Frontmatter = {
  // Every key the dialect understood, in the order the file listed them.
  props: Props;
  order: string[];
  // Lines inside the block that didn't parse, verbatim and in order.
  opaque: string[];
  // The document below the closing fence — what the editor is handed.
  body: string;
  // Whether the file had a block at all (an absent block and an empty one
  // are different files, and a note that never had one must not grow one).
  present: boolean;
};

export const FENCE = "---";

const emptyFrontmatter = (body: string): Frontmatter => ({
  props: {},
  order: [],
  opaque: [],
  body,
  present: false,
});

// `key:` or `key: value`. Keys are the ids a store declares plus whatever a
// foreign tool wrote — conservative on purpose: anything with a colon,
// bracket, or quote in the key is opaque rather than guessed at.
const KEY_RE = /^([A-Za-z0-9_][A-Za-z0-9_ .+/-]*):(?:[ \t]+(.*))?$/;
const BLOCK_ITEM_RE = /^[ \t]*-[ \t]+(.*)$/;
// A continuation line: indented, and carrying something.
const INDENTED_RE = /^[ \t]+\S/;

// A line is a fence when it is exactly `---` (trailing whitespace tolerated —
// editors add it, and refusing to see the block would be worse).
const isFence = (line: string) => line.replace(/[ \t\r]+$/, "") === FENCE;

const stripCr = (line: string) => (line.endsWith("\r") ? line.slice(0, -1) : line);

function unquote(raw: string): string | null {
  const q = raw[0];
  if ((q !== '"' && q !== "'") || raw.length < 2 || raw[raw.length - 1] !== q) return null;
  const inner = raw.slice(1, -1);
  if (q === "'") {
    // YAML single quotes: '' is a literal quote, nothing else escapes.
    return inner.includes("'") && !inner.includes("''") ? null : inner.replace(/''/g, "'");
  }
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c !== "\\") {
      if (c === '"') return null; // an unescaped quote — not a scalar we own
      out += c;
      continue;
    }
    const n = inner[++i];
    if (n === undefined) return null;
    out += n === "n" ? "\n" : n === "t" ? "\t" : n;
  }
  return out;
}

// One flow-style list: `[a, b, "c, d"]`. Returns null when the brackets don't
// balance or an item isn't a scalar — the whole line then goes opaque.
function parseFlowList(raw: string): string[] | null {
  if (raw[0] !== "[" || raw[raw.length - 1] !== "]") return null;
  const inner = raw.slice(1, -1).trim();
  if (inner === "") return [];
  const items: string[] = [];
  let buf = "";
  let quote: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      buf += c;
      if (c === "\\" && quote === '"') {
        const n = inner[++i];
        if (n === undefined) return null;
        buf += n;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      buf += c;
      continue;
    }
    if (c === "[" || c === "]" || c === "{" || c === "}") return null; // nesting
    if (c === ",") {
      items.push(buf);
      buf = "";
      continue;
    }
    buf += c;
  }
  if (quote) return null;
  items.push(buf);
  const out: string[] = [];
  for (const item of items) {
    const t = item.trim();
    if (t === "") return null; // a trailing comma — not ours to normalize
    const s = unquote(t);
    if (s !== null) out.push(s);
    else if (/["'[\]{}]/.test(t)) return null;
    else out.push(t);
  }
  return out;
}

// A bare scalar, once quoting and lists are ruled out.
function parseScalar(raw: string): PropValue | undefined {
  if (raw === "") return null;
  if (raw === "null" || raw === "~") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) return Number(raw);
  const quoted = unquote(raw);
  if (quoted !== null) return quoted;
  // Anything still carrying YAML structure characters is not a scalar this
  // dialect owns.
  if (/^[[{&*!|>%@`]/.test(raw) || raw.includes(": ") || /["']/.test(raw)) return undefined;
  if (raw.includes(" #")) return undefined; // a trailing comment we'd swallow
  return raw;
}

/**
 * The dialect's key/value reader, over the lines INSIDE a block. Shared by
 * the frontmatter block and the ```kanban embed's config (kanbanEmbed.ts):
 * one grammar, one set of rules about what stays opaque.
 */
export function parseProps(inner: string[]): {
  props: Props;
  order: string[];
  opaque: string[];
} {
  const props: Props = {};
  const order: string[] = [];
  const opaque: string[] = [];
  for (let i = 0; i < inner.length; i++) {
    const line = inner[i];
    if (line.trim() === "") continue; // blank lines inside the block: dropped
    const m = KEY_RE.exec(line);
    if (!m) {
      opaque.push(line);
      continue;
    }
    const key = m[1].trimEnd();
    const raw = (m[2] ?? "").trim();
    if (Object.prototype.hasOwnProperty.call(props, key)) {
      opaque.push(line); // a duplicate key: first wins, the rest ride along
      continue;
    }
    // A nested map or a multi-line scalar — the key OWNS the indented lines
    // under it, so claiming the key alone would tear it away from its value
    // when the block is re-serialized. The whole run goes opaque, together
    // and in order.
    if (!BLOCK_ITEM_RE.test(inner[i + 1] ?? "") && INDENTED_RE.test(inner[i + 1] ?? "")) {
      opaque.push(line);
      let j = i + 1;
      while (j < inner.length && INDENTED_RE.test(inner[j])) opaque.push(inner[j++]);
      i = j - 1;
      continue;
    }
    // Block-style list: an empty value followed by `- item` lines.
    if (raw === "" && BLOCK_ITEM_RE.test(inner[i + 1] ?? "")) {
      const items: string[] = [];
      let j = i + 1;
      let ok = true;
      for (; j < inner.length; j++) {
        const im = BLOCK_ITEM_RE.exec(inner[j]);
        if (!im) break;
        const v = parseScalar(im[1].trim());
        if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
          ok = false;
          break;
        }
        items.push(String(v));
      }
      if (ok) {
        props[key] = items;
        order.push(key);
        i = j - 1;
        continue;
      }
      opaque.push(line);
      continue;
    }
    const list = parseFlowList(raw);
    if (list) {
      props[key] = list;
      order.push(key);
      continue;
    }
    const value = parseScalar(raw);
    if (value === undefined) {
      opaque.push(line);
      continue;
    }
    props[key] = value;
    order.push(key);
  }
  return { props, order, opaque };
}

/**
 * Split `text` into its frontmatter block and its body. A file with no block
 * comes back with `present: false` and the whole text as the body — the shape
 * every existing note has, so the boundary is a no-op for prose.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const firstBreak = text.indexOf("\n");
  const firstLine = stripCr(firstBreak === -1 ? text : text.slice(0, firstBreak));
  if (!isFence(firstLine) || firstBreak === -1) return emptyFrontmatter(text);

  const rest = text.slice(firstBreak + 1);
  const lines = rest.split("\n");
  let close = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isFence(stripCr(lines[i]))) {
      close = i;
      break;
    }
  }
  if (close === -1) return emptyFrontmatter(text); // no closing fence: prose

  const inner = lines.slice(0, close).map(stripCr);
  // The body starts after the closing fence's newline. An eof-terminated
  // fence leaves an empty body.
  let bodyStart = firstBreak + 1;
  for (let i = 0; i <= close; i++) bodyStart += lines[i].length + 1;
  const body = bodyStart <= text.length ? text.slice(bodyStart) : "";

  const { props, order, opaque } = parseProps(inner);
  return { props, order, opaque, body, present: true };
}

// Quote a string only when leaving it bare would read back as something else
// (a number, a boolean, a list, an empty value, a comment) — `parseScalar(s)
// === s` is the exact test, so what we write always parses back to what we
// meant.
const quote = (s: string): string =>
  `"${s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")}"`;

function scalarText(s: string): string {
  const bare =
    s !== "" &&
    s === s.trim() &&
    !/[\r\n\t]/.test(s) &&
    !/^[[{&*!|>%@`#-]/.test(s) &&
    parseScalar(s) === s;
  return bare ? s : quote(s);
}

// A list item lives inside `[…]`, where the reader splits on commas and
// refuses brackets and stray quotes outright — so those force quoting even
// when the same text would be a fine standalone scalar.
function itemText(s: string): string {
  const bare =
    s !== "" &&
    s === s.trim() &&
    !/[,[\]{}"'\r\n\t]/.test(s) &&
    !/^[&*!|>%@`#-]/.test(s);
  return bare ? s : quote(s);
}

function valueText(v: PropValue): string {
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (Array.isArray(v)) return `[${v.map(itemText).join(", ")}]`;
  return scalarText(v);
}

/**
 * One `key: value` line in the dialect — an empty value writes the bare key.
 * Exported because the ```kanban embed writes its config in the same grammar
 * (kanbanEmbed.ts) without a block around it.
 */
export function propLine(key: string, value: PropValue): string {
  const text = valueText(value);
  return text === "" ? `${key}:` : `${key}: ${text}`;
}

/**
 * The canonical block for `props`, ending in a newline — or "" when there is
 * nothing to write and no opaque line to preserve (a card with no properties
 * is a plain note again, which is the honest file).
 *
 * `preferred` is the store's field order (plus `rank`); every other key
 * follows alphabetically, and the opaque lines come last, untouched.
 */
export function serializeFrontmatter(
  props: Props,
  opaque: string[] = [],
  preferred: string[] = [],
): string {
  const keys = Object.keys(props).filter((k) => props[k] !== undefined);
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const k of preferred) {
    if (seen.has(k)) continue;
    if (Object.prototype.hasOwnProperty.call(props, k)) {
      ordered.push(k);
      seen.add(k);
    }
  }
  for (const k of keys.filter((k) => !seen.has(k)).sort()) ordered.push(k);
  if (ordered.length === 0 && opaque.length === 0) return "";
  const lines = ordered.map((k) => propLine(k, props[k]));
  return `${FENCE}\n${[...lines, ...opaque].join("\n")}\n${FENCE}\n`;
}

/** A whole card file: the block (possibly "") followed by its body. */
export const composeCard = (head: string, body: string): string => head + body;

/** True when the two property sets are the same to the dialect's eye. */
export function propsEqual(a: Props, b: Props): boolean {
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false;
  for (const k of ak) {
    const x = a[k];
    const y = b[k];
    if (Array.isArray(x) || Array.isArray(y)) {
      if (!Array.isArray(x) || !Array.isArray(y)) return false;
      if (x.length !== y.length || x.some((v, i) => v !== y[i])) return false;
    } else if (x !== y) return false;
  }
  return true;
}

/** Read a property as display text (a multi-select joins with commas). */
export function propText(v: PropValue | undefined): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
}

/** Read a property as a list, whatever single-valued shape it arrived in. */
export function propList(v: PropValue | undefined): string[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.filter((s) => s !== "");
  const s = typeof v === "boolean" ? (v ? "true" : "false") : String(v);
  return s === "" ? [] : [s];
}
