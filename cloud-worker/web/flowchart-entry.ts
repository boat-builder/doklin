// Entry for the standalone flowchart module a domain serves at
// /__web/<tag>/flowchart.js. scripts/bundle-worker.mjs builds it into one ES
// module and writes it into the web directory Cloudflare serves beside the
// worker. A public page that carries a ```mermaid flowchart names it in a
// script tag, and it draws that page's flowcharts with the app's own renderer
// (src/flowchart/). It runs in the reader's browser and not on the worker: a
// layout costs more processor time than one request may spend there.
//
// It is the only script a public page runs: the page's policy names this
// one address (cloud-worker/src/public.ts) and refuses every script written
// into a page. So whatever a page needs done in the browser is done here.
// Browser code: typechecked with the app, never bundled into it.
import { FRAME, layoutFlowchart, sceneSvg } from "../../src/flowchart/index";

/** Below this, a column is a phone's: the flowchart is laid out for the column itself, so its words stay their real size. */
const NARROW = 520;

// Each flowchart's code block (the worker marks them, src/render.ts) and the
// figure that takes its place. A source that does not parse keeps its plain
// code block, and without JavaScript the page still shows every source.
const spots = [...document.querySelectorAll("pre[data-dk-flowchart] > code")].flatMap((code) => {
  const pre = code.parentElement;
  if (!pre) return [];
  const figure = document.createElement("figure");
  figure.className = "dk-flowchart";
  return [{ source: code.textContent ?? "", pre, figure }];
});

let drawnFor = 0;
function drawAll(): void {
  // The width of the block itself: the column, inside the page's padding.
  const column = Math.round((spots[0].figure.isConnected ? spots[0].figure : spots[0].pre).getBoundingClientRect().width);
  const frame = column > 0 && column < NARROW ? column : FRAME;
  if (frame === drawnFor) return;
  drawnFor = frame;
  for (const spot of spots) {
    const result = layoutFlowchart(spot.source, frame);
    if (!result.ok) continue;
    spot.figure.innerHTML = sceneSvg(result.scene);
    if (!spot.figure.isConnected) spot.pre.replaceWith(spot.figure);
  }
  document.documentElement.dataset.flowcharts = String(spots.filter((s) => s.figure.isConnected).length);
}

if (spots.length > 0) {
  drawAll();
  // A phone turned on its side has a column of another width.
  addEventListener("resize", drawAll);
}
