// What a flowchart becomes: a flat list of rectangles, paths and lines of
// text, every one already placed. Whoever shows the picture only draws the
// list, in order (later items sit on top), so a drawer holds no layout rule.
//
// Numbers are in the scene's own units: `width` × `height` is its frame, and
// a drawer scales that frame to the room it has.

/** A colour by name: the drawing token `--dg-<name>`; `sheet` is the page (`--sheet`). */
export type Paint = "ink" | "ink-2" | "rule" | "grid" | "accent" | "good" | "warn" | "bad" | "sheet";

/** One step of a path, as in SVG path data: move, line, quadratic, cubic, close. */
export type Seg =
  | ["M", number, number]
  | ["L", number, number]
  | ["Q", number, number, number, number]
  | ["C", number, number, number, number, number, number]
  | ["Z"];

/** A stretch of a line of text in one style. */
export type Run = { s: string; bold?: true; italic?: true };

export type Item =
  /** A rectangle with corner radius `r`. `opacity` is the fill's. */
  | { t: "rect"; x: number; y: number; w: number; h: number; r: number; stroke?: Paint; width?: number; fill?: Paint; opacity?: number }
  /** A path. Joins are round; a dashed one (`dash`: on, off) has round ends. `opacity` is the fill's. */
  | { t: "path"; d: Seg[]; stroke?: Paint; width?: number; dash?: [number, number]; fill?: Paint; opacity?: number }
  /** One line of text. `y` is its baseline; `x` is its start or its middle, by `anchor`. Bold is weight 600. */
  | { t: "text"; x: number; y: number; anchor: "start" | "middle"; size: number; paint: Paint; runs: Run[] };

export type Scene = {
  width: number;
  height: number;
  /** What the picture is, for a screen reader. */
  label: string;
  items: Item[];
};
