// Flowcharts, drawn by Doklin. A ```mermaid block keeps Mermaid's flowchart
// syntax; this reads it (parse.ts), places it (place.ts, route.ts) and draws
// it (draw.ts) as a scene in the drawing grammar's look. No other kind of
// Mermaid diagram is drawn: the result says which kind it was instead.
//
// Pure: no page, no network, nothing async. The same code runs in the editor,
// on a public page, and inside the iPhone app.

import { draw } from "./draw";
import { otherKind } from "./kind";
import { FlowchartError, parse } from "./parse";
import { place } from "./place";
import type { Scene } from "./scene";

export { isFlowchart } from "./kind";
export { sceneSvg } from "./svg";
export type { Item, Paint, Run, Scene, Seg } from "./scene";

export type Result =
  | { ok: true; scene: Scene }
  /** `unsupported`: a kind of diagram Doklin does not draw. `error`: a flowchart that cannot be read. `message` is a sentence. */
  | { ok: false; why: "unsupported" | "error"; message: string };

/** The frame the Mac app and the browser version draw into: the drawing grammar's. */
export const FRAME = 760;

/** The flowchart as a scene laid out for a frame `frame` wide, or why there is none. */
export function layoutFlowchart(source: string, frame: number): Result {
  const other = otherKind(source);
  if (other) return { ok: false, why: "unsupported", message: `Doklin draws flowcharts. ${other} is shown as its source.` };
  try {
    const chart = parse(source);
    if (!chart.boxes.size && !chart.groups.size) return { ok: false, why: "error", message: "This flowchart has no boxes yet." };
    const width = Math.max(240, Math.round(frame));
    return { ok: true, scene: draw(chart, place(chart, width), width) };
  } catch (err) {
    if (err instanceof FlowchartError) return { ok: false, why: "error", message: err.message };
    return { ok: false, why: "error", message: "This flowchart could not be drawn." };
  }
}
