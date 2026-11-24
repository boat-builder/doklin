// Where everything goes. Boxes are sized from their words (the drawing
// grammar's sizes), dagre places them in ranks, and route.ts runs the arrows.
//
// Kept from Mermaid, so an arrangement people know from other renderers comes
// out the same: a subgraph no arrow crosses is laid out by itself, in its own
// `direction` (by default across its parent's); one an arrow crosses is laid
// out with its parent, and its `direction` is ignored.
//
// The layout fits the frame it is given: labels wrap at 240 first, and
// tighter (down to 96) while the picture is wider than the frame. dagre is
// the slow part, so the loosest wrap that fits is found in at most four
// passes of it, not one for every wrap.
//
// A picture still wider than its frame is shown smaller. One that would be
// shown under three quarters of its size is laid out once more, and this
// time a part that does not fit its room — the whole flowchart, or a group
// laid out by itself — is turned the other way (left to right becomes top to
// bottom, top to bottom left to right) when that makes it narrower. The
// narrower picture is kept: on a phone, a row of boxes becomes a column that
// reads at full size.

import { layout } from "dagre-d3-es/src/dagre/index.js";
import { Graph } from "dagre-d3-es/src/graphlib/index.js";
import { LINE_STEP, QUIET_SIZE, typeset, type SetLine } from "./label";
import { textWidth } from "./measure";
import type { Arrow, Box, Chart, Dir, Group } from "./parse";
import { route, type Link, type LinkLabel, type Route } from "./route";

/** A placed thing with no parts of its own in this layout: a box, or a group laid out by itself. */
export type Leaf = {
  id: string;
  /** Centre. */
  x: number;
  y: number;
  w: number;
  h: number;
  box: Box | null;
  lines: SetLine[];
  group: Group | null;
  /** The group's own layout, drawn inside its frame. */
  inner: Laid | null;
};
/** The frame of a group whose members sit in this layout. */
export type Frame = { id: string; title: string; x: number; y: number; w: number; h: number };
export type Laid = { w: number; h: number; leaves: Leaf[]; frames: Frame[]; routes: Route[] };

/** Clear room round the picture, inside its frame. */
export const MARGIN = 24;
/** Inside a group laid out by itself: room above its content (the title sits in the frame's top line) and round it. */
export const GROUP_TOP = 28;
export const GROUP_PAD = 16;

const NODE_SEP = 24;
const RANK_SEP = 40;
/** Where labels wrap, loosest first. */
const WRAPS = [240, 208, 176, 152, 128, 112, 96];
/** An arrow's label wraps here. */
const ARROW_LABEL_WRAP = 160;

const ceil8 = (v: number) => Math.ceil(v / 8) * 8;

type Ctx = {
  chart: Chart;
  /** Every box and group inside a group, at any depth. */
  inside: Map<Group, Set<string>>;
  /** Which rank each leaf of a scope is in. Ranks do not move when labels wrap, so the first pass's serve the next. */
  ranks: Map<Group, Map<string, number>>;
  /** The first pass found boxes of one rank with different heights: it is worth one more. */
  uneven: boolean;
  /** Whether a part that does not fit its room is turned the other way. */
  turning: boolean;
  /** What this pass laid out, by scope and direction: a part is asked for again each way its parent is tried. */
  laid: Map<string, Laid>;
};

/** Shown smaller than this share of its size, a picture's words are too small to read. */
const SMALLEST = 0.75;

export function place(chart: Chart, frame: number): Laid {
  const written = fit(chart, frame, false);
  if (frame / (written.w + MARGIN * 2) >= SMALLEST) return written;
  const turned = fit(chart, frame, true);
  return turned.w < written.w ? turned : written;
}

/** The chart with its labels wrapped as loosely as the frame allows: as written, or with what does not fit turned. */
function fit(chart: Chart, frame: number, turning: boolean): Laid {
  const inside = new Map<Group, Set<string>>();
  const gather = (g: Group): Set<string> => {
    const set = new Set<string>();
    for (const c of g.children) {
      set.add(c.id);
      if (c.kind === "group") for (const id of gather(c)) set.add(id);
    }
    inside.set(g, set);
    return set;
  };
  gather(chart.root);
  const ctx: Ctx = { chart, inside, ranks: new Map(), uneven: false, turning, laid: new Map() };
  const room = frame - MARGIN * 2;
  const pass = (wrap: number) => {
    ctx.laid.clear();
    return fitted(chart.root, chart.dir, wrap, room, ctx);
  };

  const wide = pass(WRAPS[0]);
  if (wide.w <= room) return ctx.uneven ? pass(WRAPS[0]) : wide;
  // The loosest wrap that fits, found by halving: a tighter wrap is never wider.
  const tried = new Map<number, Laid>();
  const at = (k: number) => tried.get(k) ?? tried.set(k, pass(WRAPS[k])).get(k)!;
  let lo = 1;
  let hi = WRAPS.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (at(mid).w <= room) hi = mid;
    else lo = mid + 1;
  }
  return at(lo);
}

function sizeBox(box: Box, wrap: number): Leaf {
  const lines = typeset(box.label, wrap);
  const words = Math.max(0, ...lines.map((l) => l.width));
  const more = LINE_STEP * Math.max(0, lines.length - 1);
  let w: number;
  let h: number;
  switch (box.shape) {
    case "pill":
      w = Math.max(48, Math.ceil(words + 32));
      h = 32 + more;
      break;
    case "circle":
      w = h = Math.max(48, ceil8(Math.max(words + 24, Math.hypot(words, LINE_STEP * lines.length) + 16)));
      break;
    case "db":
      w = Math.max(96, ceil8(words + 32));
      h = 48 + more;
      break;
    case "decision":
      w = Math.max(96, ceil8(words + 56));
      h = 40 + more;
      break;
    case "subroutine":
      w = Math.max(96, ceil8(words + 40));
      h = 40 + more;
      break;
    default:
      w = Math.max(96, ceil8(words + 24));
      h = 40 + more;
  }
  return { id: box.id, x: 0, y: 0, w, h, box, lines, group: null, inner: null };
}

const isRect = (l: Leaf) => l.box !== null && (l.box.shape === "rect" || l.box.shape === "subroutine");

/** A scope laid out in `dir`; where parts turn and it does not fit `room` that way, the other way when that is narrower. */
function fitted(scope: Group, dir: Dir, wrap: number, room: number, ctx: Ctx): Laid {
  const written = layoutScope(scope, dir, wrap, room, ctx);
  if (!ctx.turning || written.w <= room) return written;
  const turned = layoutScope(scope, dir === "LR" || dir === "RL" ? "TB" : "LR", wrap, room, ctx);
  return turned.w < written.w ? turned : written;
}

function layoutScope(scope: Group, dir: Dir, wrap: number, room: number, ctx: Ctx): Laid {
  const key = `${scope.id}\n${dir}`;
  const done = ctx.laid.get(key);
  if (done) return done;
  const { chart } = ctx;
  const horizontal = dir === "LR" || dir === "RL";
  const crossed = (g: Group) => {
    const members = ctx.inside.get(g)!;
    return chart.arrows.some((a) => members.has(a.from) !== members.has(a.to));
  };

  const leaves: Leaf[] = [];
  const clusters: Group[] = [];
  const parentOf = new Map<string, string>();
  const collect = (g: Group, parent: string | null) => {
    for (const c of g.children) {
      if (parent !== null) parentOf.set(c.id, parent);
      if (c.kind === "box") {
        leaves.push(sizeBox(c, wrap));
      } else if (crossed(c)) {
        clusters.push(c);
        collect(c, c.id);
      } else {
        const inner = fitted(c, c.dir ?? (dir === "TB" ? "LR" : "TB"), wrap, room - GROUP_PAD * 2, ctx);
        const title = c.title ? ceil8(textWidth(c.title, QUIET_SIZE, "semibold") + 48) : 0;
        leaves.push({
          id: c.id,
          x: 0,
          y: 0,
          w: Math.max(inner.w + GROUP_PAD * 2, title),
          h: inner.h + GROUP_TOP + GROUP_PAD,
          box: null,
          lines: [],
          group: c,
          inner,
        });
      }
    }
  };
  collect(scope, null);
  if (!leaves.length) return { w: 0, h: 0, leaves: [], frames: [], routes: [] };

  // Box widths step by 48. Boxes side by side share a height: in a
  // left-to-right flow every box does, down the page those of one rank do.
  const rects = leaves.filter(isRect);
  for (const l of rects) l.w = Math.max(96, Math.ceil(l.w / 48) * 48);
  const known = ctx.ranks.get(scope);
  if (horizontal) {
    const h = Math.max(0, ...rects.map((l) => l.h));
    for (const l of rects) l.h = h;
  } else if (known) {
    const tallest = new Map<number, number>();
    for (const l of rects) tallest.set(known.get(l.id)!, Math.max(tallest.get(known.get(l.id)!) ?? 0, l.h));
    for (const l of rects) l.h = tallest.get(known.get(l.id)!)!;
  }
  // Groups side by side share the size across the flow, so their frames line up.
  const alone = leaves.filter((l) => l.group);
  if (alone.length > 1) {
    if (horizontal) {
      const h = Math.max(...alone.map((l) => l.h));
      for (const l of alone) l.h = h;
    } else {
      const w = Math.max(...alone.map((l) => l.w));
      for (const l of alone) l.w = w;
    }
  }

  const leafIds = new Set(leaves.map((l) => l.id));
  const clusterIds = new Set(clusters.map((c) => c.id));
  /** An arrow to a group whose members sit in this layout goes to the first box inside it, and stops at the frame. */
  const firstLeaf = (g: Group): string | null => {
    for (const c of g.children) {
      if (leafIds.has(c.id)) return c.id;
      const deeper = c.kind === "group" ? firstLeaf(c) : null;
      if (deeper) return deeper;
    }
    return null;
  };
  const endAt = (id: string): { node: string; frame: string | null } | null => {
    if (leafIds.has(id)) return { node: id, frame: null };
    if (!clusterIds.has(id)) return null;
    const node = firstLeaf(chart.groups.get(id)!);
    return node ? { node, frame: id } : null;
  };

  const g = new Graph({ multigraph: true, compound: true });
  g.setGraph({ rankdir: dir, nodesep: NODE_SEP, ranksep: RANK_SEP, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const c of clusters) g.setNode(c.id, {});
  // In the order they were first written, as Mermaid adds them: dagre breaks ties by it.
  const written = (l: Leaf) => (l.box ?? l.group!).order;
  for (const l of [...leaves].sort((a, b) => written(a) - written(b))) g.setNode(l.id, { width: l.w, height: l.h });
  for (const [child, parent] of parentOf) g.setParent(child, parent);

  type Wire = { arrow: Arrow; name: string; from: string; to: string; clipFrom: string | null; clipTo: string | null; label: LinkLabel | null };
  const wires: Wire[] = [];
  chart.arrows.forEach((arrow, k) => {
    const from = endAt(arrow.from);
    const to = endAt(arrow.to);
    if (!from || !to) return;
    // Between a group and something inside it there is nothing to draw.
    if (from.frame && (from.frame === to.frame || ctx.inside.get(chart.groups.get(from.frame)!)!.has(arrow.to))) return;
    if (to.frame && ctx.inside.get(chart.groups.get(to.frame)!)!.has(arrow.from)) return;
    const lines = arrow.label ? typeset(arrow.label, ARROW_LABEL_WRAP, true) : [];
    const label: LinkLabel | null = lines.length
      ? { w: Math.ceil(Math.max(...lines.map((l) => l.width)) + 12), h: LINE_STEP * lines.length + 2, lines }
      : null;
    const name = `e${k}`;
    g.setEdge(from.node, to.node, { minlen: arrow.span, ...(label ? { width: label.w, height: label.h + 2, labelpos: "c" } : {}) }, name);
    wires.push({ arrow, name, from: from.node, to: to.node, clipFrom: from.frame, clipTo: to.frame, label });
  });
  layout(g, {});

  for (const l of leaves) {
    const at = g.node(l.id);
    l.x = at.x;
    l.y = at.y;
  }
  const frames: Frame[] = clusters.map((c) => {
    const at = g.node(c.id);
    return { id: c.id, title: c.title, x: at.x, y: at.y, w: at.width, h: at.height };
  });

  if (!known) {
    const along = (l: Leaf) => Math.round(horizontal ? l.x : l.y);
    const steps = [...new Set(leaves.map(along))].sort((a, b) => a - b);
    const ranks = new Map(leaves.map((l) => [l.id, steps.indexOf(along(l))]));
    ctx.ranks.set(scope, ranks);
    if (!horizontal) {
      const heights = new Map<number, number>();
      for (const l of rects) {
        const rank = ranks.get(l.id)!;
        if (heights.has(rank) && heights.get(rank) !== l.h) ctx.uneven = true;
        heights.set(rank, l.h);
      }
    }
  }

  const links: Link[] = wires
    .filter((w) => w.arrow.stroke !== "none")
    .map((w) => ({
      arrow: w.arrow,
      from: w.from,
      to: w.to,
      points: g.edge(w.from, w.to, w.name).points ?? [],
      clipFrom: w.clipFrom,
      clipTo: w.clipTo,
      label: w.label,
    }));
  const routes = route(dir, leaves, frames, links);

  // The scope's own box: a loop round the side reaches past what dagre measured.
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const cover = (x: number, y: number, w: number, h: number) => {
    x0 = Math.min(x0, x - w / 2);
    x1 = Math.max(x1, x + w / 2);
    y0 = Math.min(y0, y - h / 2);
    y1 = Math.max(y1, y + h / 2);
  };
  for (const l of leaves) cover(l.x, l.y, l.w, l.h);
  for (const f of frames) cover(f.x, f.y, f.w, f.h);
  for (const r of routes) {
    for (const p of r.pts) cover(p.x, p.y, 0, 0);
    if (r.label) cover(r.label.x, r.label.y, r.label.w, r.label.h);
  }
  for (const item of [...leaves, ...frames]) {
    item.x -= x0;
    item.y -= y0;
  }
  for (const r of routes) {
    for (const p of r.pts) {
      p.x -= x0;
      p.y -= y0;
    }
    if (r.label) {
      r.label.x -= x0;
      r.label.y -= y0;
    }
  }
  const laid = { w: x1 - x0, h: y1 - y0, leaves, frames, routes };
  ctx.laid.set(key, laid);
  return laid;
}
