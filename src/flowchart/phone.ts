// The renderer as the iPhone app's reader runs it. The reader is native, so
// it has no page to run a module in: this file is built to one classic
// script (vite.ios-flowchart.config.ts, into ios/Editor/flowchart.js) that
// the app runs in a JavaScript context of its own
// (ios/DoklinKit/…/Flowchart/FlowchartRenderer.swift), and it answers in
// JSON, which is all that crosses.
//
// The script's one name is `DoklinFlowchart`, and its one function is
// `layout` — FlowchartRenderer.swift calls it by those names: change both.

import { FRAME, layoutFlowchart } from "./index";

/**
 * The flowchart laid out for a column `room` points wide, never wider than
 * the page's own frame: a `Result` as JSON (⇄ `FlowchartResult` in
 * Scene.swift, change both).
 */
export function layout(source: string, room: number): string {
  return JSON.stringify(layoutFlowchart(source, Math.min(room, FRAME)));
}
