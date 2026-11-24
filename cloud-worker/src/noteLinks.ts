// The links written in a note's markdown, and where each one is in its text.
//
// The worker has no editor, and agents send and receive notes as text. So
// it finds a note's links here: to show an agent each one where its document
// is now (agentLinks.ts), to write back what an agent sends, and to say who
// links to what (`links`, search.ts). They are read with the renderer's own
// parser, so a link here is what a public page draws as one. What a link
// means — its key, its record, where it leads — is src/docLinks.ts's.
//
// Only an inline link has a place a rewrite can change: `[words](address)`,
// with `<…>` around an address that needs it and a title after it. A
// reference link (`[words][ref]`), an autolink and a bare web address are
// not links to documents and are left as written.

import { Lexer, Parser, TextRenderer, type Token, type Tokens } from "marked";
import { decodeEntities } from "./render";

/** One inline link of a note. */
export type WrittenLink = {
  /** The address as markdown means it: `<…>` and escapes undone. */
  href: string;
  /** The words, as a reader sees them: no formatting, no escapes. */
  words: string;
  /** Where its words and its address are in the text, each `[start, end)`.
   *  Null when the link could not be placed, and is left as written. */
  at: { label: [number, number]; dest: [number, number] } | null;
};

/** Every inline link of `md`, in the order the text has them. */
export function linksIn(md: string): WrittenLink[] {
  // The parser reads `\r\n` as `\n`, so places in such a text are not its own.
  const placeable = !md.includes("\r");
  const out: WrittenLink[] = [];
  // How far into the text the tokens read so far reach: each one is found
  // from there, so a link's place is its own and not an earlier copy of it.
  let cursor = 0;
  const find = (raw: string): number => {
    const i = placeable ? md.indexOf(raw, cursor) : -1;
    if (i >= 0) cursor = i + raw.length;
    return i;
  };
  const visit = (tokens: readonly Token[]): void => {
    for (const t of tokens) {
      if (t.type === "link") {
        const link = t as Tokens.Link;
        const i = find(link.raw);
        const parts = inlineParts(link.raw);
        if (!parts) continue;
        out.push({
          href: link.href,
          words: decodeEntities(new Parser().parseInline(link.tokens, new TextRenderer())),
          at: i < 0 ? null : { label: shift(parts.label, i), dest: shift(parts.dest, i) },
        });
        continue;
      }
      const inside = childrenOf(t);
      if (inside) visit(inside);
      else find(t.raw);
    }
  };
  visit(new Lexer({ gfm: true }).lex(md));
  return out;
}

const shift = ([a, b]: [number, number], by: number): [number, number] => [a + by, b + by];

/** The tokens a token holds, in the order the text has them; null for one
 *  that holds no link. */
function childrenOf(t: Token): readonly Token[] | null {
  if (t.type === "image" || t.type === "codespan" || t.type === "code" || t.type === "html") return null;
  if (t.type === "list") return (t as Tokens.List).items.flatMap((item) => item.tokens);
  if (t.type === "table") {
    const table = t as Tokens.Table;
    return [...table.header.flatMap((c) => c.tokens), ...table.rows.flatMap((row) => row.flatMap((c) => c.tokens))];
  }
  const tokens = (t as { tokens?: Token[] }).tokens;
  return Array.isArray(tokens) && tokens.length > 0 ? tokens : null;
}

// The words of an inline link, as the parser reads them (marked's own
// `inline.link` label): a level of brackets, escapes, code spans.
const LABEL = /^\[((?:\[(?:\\[\s\S]|[^[\]\\])*\]|\\[\s\S]|`[^`]*`|[^[\]\\`])*?)\]\(/;

/** Where the words and the address are in an inline link's own source;
 *  null for any other kind of link. */
function inlineParts(raw: string): { label: [number, number]; dest: [number, number] } | null {
  const m = LABEL.exec(raw);
  if (!m) return null;
  let i = m[0].length;
  while (i < raw.length && /[ \t\n]/.test(raw[i])) i += 1;
  const start = i;
  if (raw[i] === "<") {
    for (i += 1; i < raw.length && raw[i] !== ">"; i += 1) {
      if (raw[i] === "\n") return null;
      if (raw[i] === "\\") i += 1;
    }
    if (raw[i] !== ">") return null;
    i += 1;
  } else {
    let depth = 0;
    for (; i < raw.length; i += 1) {
      const c = raw[i];
      if (c === "\\") {
        i += 1;
        continue;
      }
      if (/\s/.test(c)) break;
      if (c === "(") depth += 1;
      else if (c === ")") {
        if (depth === 0) break;
        depth -= 1;
      }
    }
  }
  return { label: [1, 1 + m[1].length], dest: [start, i] };
}

/** Words as a link's label writes them: what markdown would read as
 *  formatting is escaped. */
export const labelOf = (words: string): string => words.replace(/[\\[\]*_`<~]/g, (c) => `\\${c}`);

/** `md` with each range replaced; the ranges never overlap. */
export function replaced(md: string, edits: readonly { at: [number, number]; text: string }[]): string {
  let out = md;
  for (const e of [...edits].sort((a, b) => b.at[0] - a.at[0])) out = out.slice(0, e.at[0]) + e.text + out.slice(e.at[1]);
  return out;
}
