// The placed flowchart as a scene: every box, frame, arrow and line of text
// as a rectangle, a path or a text item, in the drawing grammar's look.
//
// Order is depth: frames first, then arrows, then boxes and labels on top.

import { LINE_STEP, QUIET_SIZE } from "./label";
import { textWidth } from "./measure";
import type { Chart, End, Status } from "./parse";
import { GROUP_PAD, GROUP_TOP, MARGIN, type Laid, type Leaf } from "./place";
import type { Pt, Route } from "./route";
import type { Item, Paint, Scene, Seg } from "./scene";

const HAIRLINE = 1.25;
const TITLE_SIZE = 15;
/** Room for the title above the picture. */
const TITLE_ROOM = 56;
/** A quarter circle as a cubic curve. */
const KAPPA = 0.5523;

const r1 = (v: number) => Math.round(v * 10) / 10;

type Layers = { back: Item[]; lines: Item[]; front: Item[] };

export function draw(chart: Chart, laid: Laid, frame: number): Scene {
  const top = chart.title ? TITLE_ROOM : MARGIN;
  const layers: Layers = { back: [], lines: [], front: [] };
  drawScope(laid, MARGIN, top, layers);
  const items: Item[] = [];
  if (chart.title) {
    items.push({ t: "text", x: MARGIN, y: 34, anchor: "start", size: TITLE_SIZE, paint: "ink", runs: [{ s: chart.title, bold: true }] });
  }
  items.push(...layers.back, ...layers.lines, ...layers.front);
  return {
    width: Math.max(frame, Math.ceil(laid.w + MARGIN * 2)),
    height: Math.ceil(laid.h + top + MARGIN),
    label: chart.label,
    items,
  };
}

function drawScope(laid: Laid, ox: number, oy: number, layers: Layers) {
  const paths = laid.routes.map((r) => r.pts.map((p) => ({ x: p.x + ox, y: p.y + oy })));
  // Frames first: a title may move an arrow's end (see groupFrame).
  for (const f of laid.frames) groupFrame(f.x - f.w / 2 + ox, f.y - f.h / 2 + oy, f.w, f.h, f.title, paths, layers);
  const alone = laid.leaves.filter((l) => l.inner);
  for (const l of alone) groupFrame(l.x - l.w / 2 + ox, l.y - l.h / 2 + oy, l.w, l.h, l.group!.title, paths, layers);
  laid.routes.forEach((r, k) => arrow(r, paths[k], ox, oy, layers));
  for (const l of laid.leaves) {
    if (l.box) node(l, ox, oy, layers);
    else if (l.inner) drawScope(l.inner, l.x - l.w / 2 + ox + GROUP_PAD, l.y - l.h / 2 + oy + GROUP_TOP, layers);
  }
}

/**
 * A group: a hairline frame, its title set into the top line on a patch of
 * the page. The title sits at the left, or at the right when an arrow passes
 * through the line at the left. An arrow that ends on the line where the
 * title is stops just above the title instead: it points at the name.
 */
function groupFrame(x: number, y: number, w: number, h: number, title: string, paths: Pt[][], layers: Layers) {
  layers.back.push({ t: "rect", x: r1(x), y: r1(y), w: r1(w), h: r1(h), r: 12, stroke: "grid", width: HAIRLINE });
  if (!title) return;
  const patch = textWidth(title, QUIET_SIZE, "semibold") + 12;
  const over = (p: Pt, px: number) => p.x > px - 4 && p.x < px + patch + 4;
  const passes = (px: number) =>
    paths.some((pts) =>
      pts.slice(1).some((b, k) => {
        const a = pts[k];
        return Math.min(a.x, b.x) < px + patch + 4 && Math.max(a.x, b.x) > px - 4 && Math.min(a.y, b.y) < y - 1 && Math.max(a.y, b.y) > y + 1;
      }),
    );
  const left = x + 12;
  const right = x + w - 12 - patch;
  const px = passes(left) && right > left && !passes(right) ? right : left;
  for (const pts of paths) {
    for (const [end, next] of [
      [pts[pts.length - 1], pts[pts.length - 2]],
      [pts[0], pts[1]],
    ]) {
      if (end && next && Math.abs(end.y - y) < 0.5 && next.y < y - 12 && over(end, px)) end.y = y - 9;
    }
  }
  // Above the arrows: where a title has no clear place on its line, an arrow passes behind it.
  layers.front.push(
    { t: "rect", x: r1(px), y: r1(y - 8), w: r1(patch), h: 16, r: 0, fill: "sheet" },
    { t: "text", x: r1(px + 6), y: r1(y + 4), anchor: "start", size: QUIET_SIZE, paint: "ink-2", runs: [{ s: title, bold: true }] },
  );
}

type Look = { stroke: Paint; width: number; fill?: Paint; opacity?: number };

function look(status: Status | null): Look {
  if (status === "focus") return { stroke: "accent", width: 2, fill: "accent", opacity: 0.12 };
  if (status) return { stroke: status, width: HAIRLINE, fill: status, opacity: 0.1 };
  return { stroke: "rule", width: HAIRLINE };
}

function node(l: Leaf, ox: number, oy: number, layers: Layers) {
  const box = l.box!;
  const x = ox + l.x - l.w / 2;
  const y = oy + l.y - l.h / 2;
  const cx = ox + l.x;
  const cy = oy + l.y;
  const ink = look(box.status);
  const more = LINE_STEP * Math.max(0, l.lines.length - 1);
  /** The first line's baseline. */
  let base = y + (l.h - 40 - more) / 2 + 24;
  const out = layers.front;
  const P = (px: number, py: number): [number, number] => [r1(px), r1(py)];

  switch (box.shape) {
    case "pill":
      out.push({ t: "rect", x: r1(x), y: r1(y), w: l.w, h: l.h, r: l.h / 2, ...ink });
      base = y + (l.h - 32 - more) / 2 + 20.5;
      break;
    case "circle":
      out.push({ t: "rect", x: r1(x), y: r1(y), w: l.w, h: l.h, r: l.w / 2, ...ink });
      base = cy - more / 2 + 4.5;
      break;
    case "db": {
      // A cylinder: the body with its curved ends, then the front of the top rim.
      const ry = 7;
      const rx = l.w / 2;
      const x2 = x + l.w;
      const top = y + ry;
      const bottom = y + l.h - ry;
      const kx = KAPPA * rx;
      const ky = KAPPA * ry;
      out.push(
        {
          t: "path",
          d: [
            ["M", ...P(x, top)],
            ["C", ...P(x, top - ky), ...P(cx - kx, y), ...P(cx, y)],
            ["C", ...P(cx + kx, y), ...P(x2, top - ky), ...P(x2, top)],
            ["L", ...P(x2, bottom)],
            ["C", ...P(x2, bottom + ky), ...P(cx + kx, y + l.h), ...P(cx, y + l.h)],
            ["C", ...P(cx - kx, y + l.h), ...P(x, bottom + ky), ...P(x, bottom)],
            ["Z"],
          ],
          ...ink,
        },
        {
          t: "path",
          d: [
            ["M", ...P(x, top)],
            ["C", ...P(x, top + ky), ...P(cx - kx, top + ry), ...P(cx, top + ry)],
            ["C", ...P(cx + kx, top + ry), ...P(x2, top + ky), ...P(x2, top)],
          ],
          stroke: ink.stroke,
          width: ink.width,
        },
      );
      base = y + 32;
      break;
    }
    case "decision": {
      // A box with pointed ends.
      const t = 16;
      out.push({
        t: "path",
        d: [
          ["M", ...P(x + t, y)],
          ["L", ...P(x + l.w - t, y)],
          ["L", ...P(x + l.w, cy)],
          ["L", ...P(x + l.w - t, y + l.h)],
          ["L", ...P(x + t, y + l.h)],
          ["L", ...P(x, cy)],
          ["Z"],
        ],
        ...ink,
      });
      break;
    }
    default:
      out.push({ t: "rect", x: r1(x), y: r1(y), w: l.w, h: l.h, r: 8, ...ink });
      if (box.shape === "subroutine") {
        out.push({
          t: "path",
          d: [
            ["M", ...P(x + 8, y)],
            ["L", ...P(x + 8, y + l.h)],
            ["M", ...P(x + l.w - 8, y)],
            ["L", ...P(x + l.w - 8, y + l.h)],
          ],
          stroke: ink.stroke,
          width: HAIRLINE,
        });
      }
  }
  l.lines.forEach((line, k) => {
    out.push({
      t: "text",
      x: r1(cx),
      y: r1(base + LINE_STEP * k),
      anchor: "middle",
      size: line.size,
      paint: line.kind === "quiet" ? "ink-2" : "ink",
      runs: line.runs,
    });
  });
}

/** How far the line stops short of the arrow's tip, by what sits there. */
const SHORT: Record<End, number> = { none: 0, arrow: 4, circle: 7, cross: 5 };

function arrow(r: Route, pts: Pt[], ox: number, oy: number, layers: Layers) {
  if (pts.length < 2) return;
  const thick = r.arrow.stroke === "thick";
  const dotted = r.arrow.stroke === "dotted";
  const tip = pts[pts.length - 1];
  const tail = pts[0];
  const line = shorten(shorten(pts, SHORT[r.arrow.end]).reverse(), SHORT[r.arrow.start]).reverse();
  const item: Item = { t: "path", d: rounded(line), stroke: "rule", width: dotted ? 1.75 : thick ? 2 : HAIRLINE };
  if (dotted) item.dash = [1, 5];
  layers.lines.push(item);
  layers.lines.push(...head(r.arrow.end, pts[pts.length - 2], tip, thick), ...head(r.arrow.start, pts[1], tail, thick));

  if (!r.label) return;
  const { x, y, w, h, lines } = r.label;
  layers.front.push({ t: "rect", x: r1(x + ox - w / 2), y: r1(y + oy - h / 2), w, h, r: 4, fill: "sheet" });
  lines.forEach((l, k) => {
    layers.front.push({
      t: "text",
      x: r1(x + ox),
      y: r1(y + oy - (LINE_STEP * lines.length) / 2 + 12 + LINE_STEP * k),
      anchor: "middle",
      size: l.size,
      paint: "ink-2",
      runs: l.runs,
    });
  });
}

/** The path, ending `by` before its last point (unless its last piece is too short to give that up). */
function shorten(pts: Pt[], by: number): Pt[] {
  if (!by) return [...pts];
  const a = pts[pts.length - 2];
  const b = pts[pts.length - 1];
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len <= by + 1) return [...pts];
  return [...pts.slice(0, -1), { x: b.x - ((b.x - a.x) / len) * by, y: b.y - ((b.y - a.y) / len) * by }];
}

/** What sits at an arrow's end: a filled head, a dot, or a cross. `from` is the point before the tip. */
function head(end: End, from: Pt, tip: Pt, thick: boolean): Item[] {
  if (end === "none") return [];
  const len = Math.hypot(tip.x - from.x, tip.y - from.y) || 1;
  const ux = (tip.x - from.x) / len;
  const uy = (tip.y - from.y) / len;
  const at = (along: number, across: number): [number, number] => [r1(tip.x - ux * along - uy * across), r1(tip.y - uy * along + ux * across)];
  if (end === "arrow") {
    const long = thick ? 10 : 8;
    const half = thick ? 5 : 4;
    return [{ t: "path", d: [["M", ...at(0, 0)], ["L", ...at(long, half)], ["L", ...at(long, -half)], ["Z"]], fill: "rule" }];
  }
  if (end === "circle") {
    const r = 3.5;
    const k = KAPPA * r;
    const cx = tip.x - ux * r;
    const cy = tip.y - uy * r;
    const P = (x: number, y: number): [number, number] => [r1(x), r1(y)];
    return [
      {
        t: "path",
        d: [
          ["M", ...P(cx - r, cy)],
          ["C", ...P(cx - r, cy - k), ...P(cx - k, cy - r), ...P(cx, cy - r)],
          ["C", ...P(cx + k, cy - r), ...P(cx + r, cy - k), ...P(cx + r, cy)],
          ["C", ...P(cx + r, cy + k), ...P(cx + k, cy + r), ...P(cx, cy + r)],
          ["C", ...P(cx - k, cy + r), ...P(cx - r, cy + k), ...P(cx - r, cy)],
          ["Z"],
        ],
        fill: "rule",
      },
    ];
  }
  return [
    {
      t: "path",
      d: [["M", ...at(1, 4)], ["L", ...at(9, -4)], ["M", ...at(1, -4)], ["L", ...at(9, 4)]],
      stroke: "rule",
      width: thick ? 2 : HAIRLINE,
    },
  ];
}

/** Straight pieces joined by corners of radius 8. */
function rounded(pts: Pt[], radius = 8): Seg[] {
  const d: Seg[] = [["M", r1(pts[0].x), r1(pts[0].y)]];
  for (let k = 1; k < pts.length - 1; k++) {
    const a = pts[k - 1];
    const p = pts[k];
    const b = pts[k + 1];
    const la = Math.hypot(p.x - a.x, p.y - a.y);
    const lb = Math.hypot(b.x - p.x, b.y - p.y);
    const q = Math.min(radius, la / 2, lb / 2);
    d.push(
      ["L", r1(p.x - ((p.x - a.x) / la) * q), r1(p.y - ((p.y - a.y) / la) * q)],
      ["Q", r1(p.x), r1(p.y), r1(p.x + ((b.x - p.x) / lb) * q), r1(p.y + ((b.y - p.y) / lb) * q)],
    );
  }
  const z = pts[pts.length - 1];
  d.push(["L", r1(z.x), r1(z.y)]);
  return d;
}
