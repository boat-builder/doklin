// Tags: a note's choice tags, as lines of its frontmatter, and the
// workspace's one list of them, kept in a note of its own.
//
// A note's tag is an unindented `key: value` line in its frontmatter block
// (src/frontmatter.ts), `status: Doing`. The tag list says which keys are
// tags and which values each takes: `Library/Tags.md` in a connected
// workspace, `Tags.md` at the top of a folder that isn't, whose block holds
// one line per tag, `status: [Todo, Doing, Done]`. Its body says what the
// values mean, for the people and agents who set them.
//
// The file format can't hold a note to the list, so the writers do: the
// picker is the only way a person sets a tag, and the worker checks what an
// agent writes. Readers are lenient: a value that isn't in the list is still
// the note's, shown marked and never dropped. Matching is case-insensitive
// everywhere, and what shows is the list's spelling.
//
// The iPhone ports this (ios/DoklinKit/Sources/DoklinKit/Markdown/Tags.swift)
// and the Mac's search reads a note's lines in Rust (src-tauri/src/tags.rs).
// All three are held to verify-harness/tags-fixture.json: change all three.

import { splitFrontmatter } from "./frontmatter";

/** A tag of the list: its name, and the values a note can have, in order. */
export type TagDef = { name: string; values: string[] };

/** An unindented `key: …` line of a block. `value` is null when the line
 *  isn't a pair: an empty value, a list or map, a block scalar, or a line
 *  an indented run belongs to. */
export type KeyedLine = { key: string; value: string | null };

/** A note's tag, spelled as the list spells it. `known`: the value is one of
 *  the tag's; a value that isn't shows marked. */
export type NoteTag = { name: string; value: string; known: boolean };

/** A search's tag token: notes whose tag holds `value`, or (null) that have
 *  the tag at all. */
export type TagFilter = { name: string; value: string | null };

/** The tag list's file name, in Library or at the top of a folder that
 *  doesn't sync. Found whatever its case. */
export const TAG_NOTE = "Tags.md";

/** What a tag list made by *New tag…* says under its block. */
export const TAG_NOTE_BODY =
  "The workspace's tags. Each line at the top is a tag and the values a note can have. Say here what each value means, for the people and agents who set them.\n";

export const NAME_MAX = 40;
export const VALUE_MAX = 60;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const length = (s: string) => [...s].length;

/* ---------- The block, line by line ---------- */

type Entry = KeyedLine & {
  /** What follows the key's colon, trimmed. */
  rest: string;
  /** An indented run belongs to the line. */
  run: boolean;
  /** Where the line starts, and where its run ends (after its newline):
   *  what a write replaces. */
  from: number;
  end: number;
};

type Block = {
  /** Where the lines inside the fences start, and where the closing fence
   *  does. */
  start: number;
  close: number;
  /** Where the block ends: the body starts here. */
  headEnd: number;
  /** The block's own line ending: its first line's. */
  eol: string;
  entries: Entry[];
  /** Every line inside the fences, with where it starts and ends. */
  lines: { from: number; end: number; text: string }[];
};

function blockOf(text: string): Block | null {
  const { head } = splitFrontmatter(text);
  if (!head) return null;
  const firstNl = head.indexOf("\n");
  const start = firstNl + 1;
  const last = head.endsWith("\n") ? head.length - 1 : head.length;
  const close = head.lastIndexOf("\n", last - 1) + 1;
  const eol = head.slice(0, firstNl).endsWith("\r") ? "\r\n" : "\n";
  const lines: Block["lines"] = [];
  for (let at = start; at < close; ) {
    const nl = text.indexOf("\n", at);
    const end = nl + 1;
    lines.push({ from: at, end, text: text.slice(at, nl).replace(/\r$/, "") });
    at = end;
  }
  const indented = (s: string) => s.startsWith(" ") || s.startsWith("\t");
  const blank = (s: string) => s.trim() === "";
  const entries: Entry[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const keyed = keyedLine(lines[i].text);
    if (!keyed) continue;
    // The run that belongs to it: the indented lines after it, with any
    // blank lines between them, up to the last indented one.
    let runEnd = i;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (indented(lines[j].text) && !blank(lines[j].text)) runEnd = j;
      else if (!blank(lines[j].text)) break;
    }
    entries.push({
      key: keyed.key,
      value: runEnd > i ? null : keyed.value,
      rest: keyed.rest,
      run: runEnd > i,
      from: lines[i].from,
      end: lines[runEnd].end,
    });
    i = runEnd;
  }
  return { start, close, headEnd: head.length, eol, entries, lines };
}

/** A line's key and value: the text before the first `:` that a space, a
 *  tab or the line's end follows, and the scalar after it. */
function keyedLine(line: string): (KeyedLine & { rest: string }) | null {
  if (line === "" || /^[\s#-]/.test(line)) return null;
  for (let at = 0; ; ) {
    const colon = line.indexOf(":", at);
    if (colon === -1) return null;
    const next = line[colon + 1];
    if (next === undefined || next === " " || next === "\t") {
      const key = line.slice(0, colon).trimEnd();
      if (!key) return null;
      const rest = line.slice(colon + 1).trim();
      return { key, value: scalarOf(rest), rest };
    }
    at = colon + 1;
  }
}

/** What may follow a quoted value or a list: nothing, or a comment. */
const trailerOk = (rest: string) => rest.trim() === "" || /^\s+#/.test(rest);

/** A double-quoted value at the start of `s`, with where it ends. Its
 *  escapes are `\"` and `\\`; any other makes it not a value. */
function doubleQuoted(s: string): { value: string; end: number } | null {
  let value = "";
  for (let i = 1; i < s.length; i += 1) {
    const c = s[i];
    if (c === '"') return { value, end: i + 1 };
    if (c === "\\") {
      const n = s[i + 1];
      if (n !== '"' && n !== "\\") return null;
      value += n;
      i += 1;
    } else {
      value += c;
    }
  }
  return null;
}

/** A single-quoted value at the start of `s`: `''` is a quote. */
function singleQuoted(s: string): { value: string; end: number } | null {
  let value = "";
  for (let i = 1; i < s.length; i += 1) {
    if (s[i] !== "'") {
      value += s[i];
    } else if (s[i + 1] === "'") {
      value += "'";
      i += 1;
    } else {
      return { value, end: i + 1 };
    }
  }
  return null;
}

/** One scalar, or null: empty, a list or map, a block scalar, or YAML's
 *  anchors, aliases, tags and reserved marks. A bare value ends at a `#`
 *  that a space comes before, as a YAML comment does. */
function scalarOf(rest: string): string | null {
  if (rest === "") return null;
  if (rest[0] === '"' || rest[0] === "'") {
    const q = rest[0] === '"' ? doubleQuoted(rest) : singleQuoted(rest);
    if (!q || !trailerOk(rest.slice(q.end))) return null;
    return q.value;
  }
  if (/^[[{|>&*!%@`]/.test(rest)) return null;
  const bare = rest.replace(/[ \t]+#.*$/, "").trimEnd();
  return bare === "" ? null : bare;
}

/** The unindented `key: …` lines of a note's block, in order. A note with
 *  no block has none. */
export function keyedLines(text: string): KeyedLine[] {
  return (blockOf(text)?.entries ?? []).map(({ key, value }) => ({ key, value }));
}

/* ---------- A note's tags ---------- */

/** The note's tags, in the list's order. A tag's line is the first line
 *  keyed by its name; one that isn't a pair gives the note no value. */
export function noteTags(text: string, list: TagDef[]): NoteTag[] {
  const lines = keyedLines(text);
  const out: NoteTag[] = [];
  for (const def of list) {
    const line = lines.find((l) => same(l.key, def.name));
    if (!line || line.value === null) continue;
    const value = line.value;
    const known = def.values.find((v) => same(v, value));
    out.push({ name: def.name, value: known ?? value, known: known !== undefined });
  }
  return out;
}

/** Whether the block holds anything besides the note's tags: what the
 *  *Frontmatter* disclosure is shown for. */
export function hasOtherFrontmatter(text: string, list: TagDef[]): boolean {
  const block = blockOf(text);
  if (!block) return false;
  const tagLines = new Set<number>();
  for (const def of list) {
    const entry = block.entries.find((e) => same(e.key, def.name));
    if (entry && entry.value !== null) tagLines.add(entry.from);
  }
  return block.lines.some((l) => !tagLines.has(l.from) && l.text.trim() !== "");
}

/** A value as a line holds it: bare, unless YAML would read it otherwise
 *  (Obsidian and other tools read the same text Doklin does). */
export function quoteValue(value: string): string {
  const plain =
    !/[:#,[\]{}"']/.test(value) &&
    !/^[-?!&*|>%@` ]/.test(value) &&
    !/^(true|false|yes|no|null|~)$/i.test(value);
  return plain ? value : `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Put `line` where the line keyed `at` is (its indented run with it), or
 *  after the line keyed `after`, or at the end of the block, or in a new
 *  block at the top; null removes the line, and a block left with no lines
 *  goes, fences and all. Nothing else in the file changes. */
function writeLine(text: string, at: string, line: string | null, after?: string): string {
  const block = blockOf(text);
  if (!block) {
    if (line === null) return text;
    const eol = /^[^\n]*\r\n/.test(text) ? "\r\n" : "\n";
    return `---${eol}${line}${eol}---${eol}${text}`;
  }
  const found = block.entries.find((e) => same(e.key, at));
  if (found) {
    if (line !== null) return text.slice(0, found.from) + line + block.eol + text.slice(found.end);
    // The block goes when this was its last line, unless the body would
    // then read as a block of its own (a rule at its top, and another).
    const emptied = found.from === block.start && found.end === block.close;
    const body = text.slice(block.headEnd);
    if (emptied && splitFrontmatter(body).head === "") return body;
    return text.slice(0, found.from) + text.slice(found.end);
  }
  if (line === null) return text;
  const anchor = after === undefined ? undefined : block.entries.find((e) => same(e.key, after));
  const where = anchor ? anchor.end : block.close;
  return text.slice(0, where) + line + block.eol + text.slice(where);
}

/** Set a note's tag: the line keyed `at` (the tag's name, or its old name
 *  in a rename) becomes `tag`, spelled as the caller gives it. Null clears
 *  it. A set followed by a clear gives back the original bytes. */
export function writeTag(text: string, at: string, tag: { name: string; value: string } | null): string {
  return writeLine(text, at, tag ? `${tag.name}: ${quoteValue(tag.value)}` : null);
}

/* ---------- The tag list ---------- */

/** A flow list, `[a, "b, c", 'd']`, and what follows it; null when it isn't
 *  one. */
function flowList(rest: string): string[] | null {
  if (rest[0] !== "[") return null;
  const out: string[] = [];
  let i = 1;
  const skip = () => {
    while (rest[i] === " " || rest[i] === "\t") i += 1;
  };
  skip();
  if (rest[i] === "]") return trailerOk(rest.slice(i + 1)) ? out : null;
  for (;;) {
    skip();
    const c = rest[i];
    if (c === '"' || c === "'") {
      const q = c === '"' ? doubleQuoted(rest.slice(i)) : singleQuoted(rest.slice(i));
      if (!q) return null;
      out.push(q.value);
      i += q.end;
    } else {
      let j = i;
      while (j < rest.length && rest[j] !== "," && rest[j] !== "]") j += 1;
      const bare = rest.slice(i, j).trim();
      if (bare === "" || /[[{}"']|\s#/.test(bare) || /^[&*!|>%@`]/.test(bare)) return null;
      out.push(bare);
      i = j;
    }
    skip();
    if (rest[i] === ",") {
      i += 1;
      skip();
      // A trailing comma is allowed, as YAML allows it.
      if (rest[i] === "]") return trailerOk(rest.slice(i + 1)) ? out : null;
      continue;
    }
    if (rest[i] === "]") return trailerOk(rest.slice(i + 1)) ? out : null;
    return null;
  }
}

/** The workspace's tags from its list's text, in order. A line that doesn't
 *  parse is skipped (it stays on disk), and so is a second line for a name
 *  already listed. No note, or no lines: no tags. */
export function parseTagList(text: string): TagDef[] {
  const out: TagDef[] = [];
  for (const entry of blockOf(text)?.entries ?? []) {
    const values = entry.run ? null : flowList(entry.rest);
    if (!values || values.length === 0 || nameProblem(entry.key, out) !== null) continue;
    if (values.some((v, i) => valueProblem(v, values.slice(0, i)) !== null)) continue;
    out.push({ name: entry.key, values });
  }
  return out;
}

/** The first line of the list's block that isn't a tag it lists, with why,
 *  in a sentence: what the worker refuses an agent's write of the list for.
 *  Null when every line is one. `line` counts from the file's first line. */
export function listProblem(text: string): { line: number; text: string; problem: string } | null {
  const block = blockOf(text);
  if (!block) return null;
  const listed: TagDef[] = [];
  const at = (from: number, problem: string) => {
    const line = block.lines.find((l) => l.from === from)!;
    return { line: text.slice(0, from).split("\n").length, text: line.text, problem };
  };
  const shape = "Write a tag and its values as status: [Todo, Doing, Done].";
  let covered = block.start;
  for (const entry of block.entries) {
    const stray = block.lines.find((l) => l.from >= covered && l.from < entry.from && l.text.trim() !== "");
    if (stray) return at(stray.from, shape);
    covered = entry.end;
    if (entry.run) return at(entry.from, "Its values go in brackets on its own line, as status: [Todo, Doing, Done].");
    const values = flowList(entry.rest);
    if (!values) return at(entry.from, shape);
    if (values.length === 0) return at(entry.from, "A tag needs at least one value.");
    const named = nameProblem(entry.key, listed);
    if (named) return at(entry.from, named);
    for (let i = 0; i < values.length; i += 1) {
      const wrong = valueProblem(values[i], values.slice(0, i));
      if (wrong) return at(entry.from, wrong);
    }
    listed.push({ name: entry.key, values });
  }
  const stray = block.lines.find((l) => l.from >= covered && l.text.trim() !== "");
  return stray ? at(stray.from, shape) : null;
}

/** Whether the list's block holds lines that aren't tags it lists. */
export function otherListLines(text: string): boolean {
  const block = blockOf(text);
  if (!block) return false;
  return block.lines.filter((l) => l.text.trim() !== "").length > parseTagList(text).length;
}

/** A tag's line in the list. */
export const tagLine = (def: TagDef) => `${def.name}: [${def.values.map(quoteValue).join(", ")}]`;

/** Put a tag in the list: the line keyed `at` becomes `def`'s, or `def` is
 *  added (after the line keyed `after`, else at the end); null removes the
 *  line keyed `at`. A list with no note yet starts as `TAG_NOTE_BODY`
 *  under its block. */
export function writeTagList(text: string, at: string, def: TagDef | null, after?: string): string {
  const base = text === "" && def !== null ? TAG_NOTE_BODY : text;
  return writeLine(base, at, def ? tagLine(def) : null, after);
}

/* ---------- Names and values ---------- */

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u;

/** Why `name` can't be a tag's name in `list` (a sentence), or null. `except`
 *  is the tag being renamed, whose own name doesn't count. */
export function nameProblem(name: string, list: TagDef[], except?: string): string | null {
  if (name === "") return "A tag needs a name.";
  if (length(name) > NAME_MAX) return `A tag's name can be ${NAME_MAX} characters at most.`;
  if (!NAME_RE.test(name) || /\s$/.test(name)) {
    return "A tag's name holds letters, digits, spaces, _ and -, and starts and ends with a letter or a digit.";
  }
  const taken = list.find((d) => same(d.name, name) && !(except !== undefined && same(d.name, except)));
  return taken ? `There's already a tag called ${taken.name}.` : null;
}

/** Why `value` can't be a value beside `others` (a sentence), or null. */
export function valueProblem(value: string, others: string[]): string | null {
  if (value === "") return "A value can't be empty.";
  if (length(value) > VALUE_MAX) return `A value can be ${VALUE_MAX} characters at most.`;
  if (/[\u0000-\u001f\u007f]/.test(value)) return "A value is one line of text.";
  if (value !== value.trim()) return "A value can't start or end with a space.";
  const twin = others.find((o) => same(o, value));
  return twin ? `${twin} is there twice.` : null;
}

/* ---------- Search ---------- */

/** A search box's text, split into the words a search looks for and its
 *  tag tokens: `name:value`, either side in double quotes when it holds a
 *  space (`status:"In progress"`). Only a listed tag's name makes a token;
 *  any other `x:y` is text. Values are spelled as the list spells them. With
 *  no token, the text is the query as typed. */
export function searchQuery(q: string, list: TagDef[]): { text: string; tags: TagFilter[] } {
  const words: string[] = [];
  for (let i = 0; i < q.length; ) {
    if (/\s/.test(q[i])) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < q.length && !/\s/.test(q[j])) {
      if (q[j] === '"') {
        const close = q.indexOf('"', j + 1);
        j = close === -1 ? q.length : close + 1;
      } else {
        j += 1;
      }
    }
    words.push(q.slice(i, j));
    i = j;
  }
  const tags: TagFilter[] = [];
  const text: string[] = [];
  for (const word of words) {
    const m = /^(?:"([^"]+)"|([^\s:"]+)):(?:"([^"]+)"|([^\s"]+))$/.exec(word);
    const def = m ? list.find((d) => same(d.name, m[1] ?? m[2])) : undefined;
    if (!m || !def) {
      text.push(word);
      continue;
    }
    const typed = (m[3] ?? m[4]).trim();
    tags.push({ name: def.name, value: def.values.find((v) => same(v, typed)) ?? typed });
  }
  return tags.length === 0 ? { text: q.trim(), tags } : { text: text.join(" "), tags };
}

/** Whether a note's text has the tags a search asks for. */
export function matchesTags(text: string, filters: TagFilter[]): boolean {
  if (filters.length === 0) return true;
  const lines = keyedLines(text);
  return filters.every((f) => {
    const line = lines.find((l) => same(l.key, f.name));
    if (!line || line.value === null) return false;
    return f.value === null || same(line.value, f.value);
  });
}
