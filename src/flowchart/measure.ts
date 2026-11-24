// How wide a string draws in Inter, with no page to measure it on. The widths
// come from the bundled fonts (interWidths.ts, written by
// scripts/inter-widths.mjs). Kerning is left out: words come out a hair wider
// than the page draws them, which only leaves a box a little more room.

import { ITALIC, REGULAR, RUNS, SEMIBOLD, UNITS_PER_EM } from "./interWidths";

export type Face = "regular" | "semibold" | "italic";

const TABLES: Record<Face, readonly number[]> = { regular: REGULAR, semibold: SEMIBOLD, italic: ITALIC };

/** Code point → its place in the width tables. */
const PLACE = new Map<number, number>();
for (let i = 0, at = 0; i < RUNS.length; i += 2) {
  for (let k = 0; k < RUNS[i + 1]; k++) PLACE.set(RUNS[i] + k, at++);
}

/** A letter's width in ems. */
function letterWidth(cp: number, face: Face): number {
  const at = PLACE.get(cp);
  if (at !== undefined) return TABLES[face][at] / UNITS_PER_EM;
  // Marks that sit on the letter before them, and joiners: no width.
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  // Inter has no such letter, so another font draws it: arrows, symbols,
  // Chinese, Japanese, Korean and emoji are about an em wide, the rest
  // about Inter's average.
  return cp >= 0x2190 ? 1 : 0.62;
}

/** The width of `text` at `size` px. */
export function textWidth(text: string, size: number, face: Face): number {
  let ems = 0;
  for (const ch of text) ems += letterWidth(ch.codePointAt(0)!, face);
  return ems * size;
}
