// A label, from the words Mermaid's syntax allows to the lines the picture
// draws. Kept of a label's markup: line breaks (<br>, a new line), bold and
// italic (<b> <strong> <i> <em>, and ** and * in a Markdown string). Any
// other tag is dropped and its words stay.
//
// The look is the drawing grammar's: a label with a bold part is a name
// (13/600) over quiet lines (11.5); a label without one is plain 13.

import type { Run } from "./scene";
import { textWidth, type Face } from "./measure";

/** A label as written: its text, and whether it is a Markdown string ("`…`"). */
export type Label = { text: string; markdown: boolean };

type Piece = { s: string; bold: boolean; italic: boolean };

export type Kind = "plain" | "name" | "quiet";

/** A line as drawn: its runs, its width, and its size by kind. */
export type SetLine = { runs: Run[]; width: number; size: number; kind: Kind };

export const NAME_SIZE = 13;
export const QUIET_SIZE = 11.5;
/** From one baseline to the next. */
export const LINE_STEP = 16;

const CODES: Record<string, string> = { quot: '"', amp: "&", lt: "<", gt: ">", apos: "'", nbsp: " " };

/** Mermaid's codes (#quot; #35;) and HTML's (&quot; &#35;) as the letters they stand for. */
function decodeCodes(s: string): string {
  return s.replace(/(?:#|&#?)(x[0-9a-f]+|\d+|[a-z]+);/gi, (all: string, code: string) => {
    if (/^\d+$/.test(code)) return fromCodePoint(Number(code), all);
    if (/^x[0-9a-f]+$/i.test(code)) return fromCodePoint(parseInt(code.slice(1), 16), all);
    return CODES[code.toLowerCase()] ?? all;
  });
}

function fromCodePoint(cp: number, otherwise: string): string {
  return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : otherwise;
}

/** A Markdown string's ** and * as the tags the reader below knows. */
function markdownToTags(line: string): string {
  return line
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^\w])__(.+?)__(?!\w)/g, "$1<b>$2</b>")
    .replace(/\*(.+?)\*/g, "<i>$1</i>")
    .replace(/(^|[^\w])_(.+?)_(?!\w)/g, "$1<i>$2</i>");
}

/** The label's lines, each a list of pieces in one style. */
function read(label: Label): Piece[][] {
  const lines: Piece[][] = [];
  // Mermaid's icon words (fa:fa-user) draw nothing here.
  const text = label.text.replace(/\bfa[bsrlk]?:fa-[\w-]+\s*/g, "");
  for (const raw of text.split(/<br\s*\/?>|\r?\n|\\n/i)) {
    const line = label.markdown ? markdownToTags(raw) : raw;
    const pieces: Piece[] = [];
    let bold = 0;
    let italic = 0;
    // Only what is a tag by name is read as one: "x < y and z > 0" keeps its signs.
    const tagOrText = /<(\/?)(b|strong|i|em|u|s|span|div|p|code|sub|sup|small|font|center|mark|a)\b[^>]*>|([^<]+|<)/gi;
    for (let m = tagOrText.exec(line); m; m = tagOrText.exec(line)) {
      if (m[3] !== undefined) {
        pieces.push({ s: decodeCodes(m[3]), bold: bold > 0, italic: italic > 0 });
        continue;
      }
      const step = m[1] ? -1 : 1;
      const tag = m[2].toLowerCase();
      if (tag === "b" || tag === "strong") bold = Math.max(0, bold + step);
      else if (tag === "i" || tag === "em") italic = Math.max(0, italic + step);
    }
    lines.push(pieces);
  }
  return lines;
}

/** The label's words alone, on one line: a group's title, a screen reader's label. */
export function plainText(label: Label): string {
  return read(label)
    .map((pieces) => pieces.map((p) => p.s).join(""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

const faceOf = (p: { bold: boolean; italic: boolean }): Face => (p.bold ? "semibold" : p.italic ? "italic" : "regular");

type Word = { s: string; bold: boolean; italic: boolean; space: boolean; width: number };

/**
 * The label as drawn lines, none wider than `wrap` unless one word is. With
 * `quiet`, every line is the small secondary size: an arrow's label.
 */
export function typeset(label: Label, wrap: number, quiet = false): SetLine[] {
  const lines = read(label);
  const hasName = !quiet && lines.some((pieces) => pieces.some((p) => p.bold && p.s.trim() !== ""));
  const out: SetLine[] = [];
  for (const pieces of lines) {
    const kind: Kind = quiet ? "quiet" : !hasName ? "plain" : pieces.some((p) => p.bold) ? "name" : "quiet";
    const size = kind === "quiet" ? QUIET_SIZE : NAME_SIZE;
    let words: Word[] = [];
    let width = 0;
    const flush = () => {
      while (words.length && words[words.length - 1].space) width -= words.pop()!.width;
      if (words.length) out.push({ runs: toRuns(words), width, size, kind });
      words = [];
      width = 0;
    };
    for (const piece of pieces) {
      for (const s of piece.s.split(/(\s+)/)) {
        if (s === "") continue;
        const space = /^\s+$/.test(s);
        const word: Word = { s: space ? " " : s, bold: piece.bold, italic: piece.italic, space, width: 0 };
        word.width = textWidth(word.s, size, faceOf(word));
        if (space) {
          if (words.length) {
            words.push(word);
            width += word.width;
          }
          continue;
        }
        if (words.length && width + word.width > wrap) flush();
        words.push(word);
        width += word.width;
      }
    }
    flush();
  }
  return out;
}

function toRuns(words: Word[]): Run[] {
  const runs: Run[] = [];
  let last: Word | null = null;
  for (const w of words) {
    if (last && last.bold === w.bold && last.italic === w.italic) {
      runs[runs.length - 1].s += w.s;
    } else {
      const run: Run = { s: w.s };
      if (w.bold) run.bold = true;
      if (w.italic) run.italic = true;
      runs.push(run);
    }
    last = w;
  }
  return runs;
}
