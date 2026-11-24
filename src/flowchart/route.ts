// Arrows, once the boxes are placed: every arrow runs in straight pieces with
// square turns, through the clear gaps between ranks of boxes.
//
// The rules, in the order they apply:
//   - An arrow leaves the side of its box that faces down the flow and enters
//     the side that faces up it, at the middle. Arrows into one side share
//     one head.
//   - It turns once, in the gap next to its source when the way from there is
//     clear, else next to its target; only an arrow that must dodge boxes
//     turns more.
//   - Arrows that share a gap and would lie on each other take lanes of their
//     own. Arrows from one box share a lane (they fan out), and so do arrows
//     into one box.
//   - An arrow that goes back up the flow loops round the side, clear of
//     every box between; a box that points at itself gets a small loop.
//   - An arrow to or from a group stops at the group's frame.
//   - A lane never lies on a group's frame line.
//
// All of it works in "flow" coordinates, where m runs down the flow and c
// across it, so the four directions are one case.

import type { SetLine } from "./label";
import type { Arrow, Dir } from "./parse";

export type Pt = { x: number; y: number };
/** A rectangle by its centre and size. */
export type Rect = { id: string; x: number; y: number; w: number; h: number };
export type LinkLabel = { w: number; h: number; lines: SetLine[] };
/** An arrow between two placed boxes, with the points dagre gave it. */
export type Link = {
  arrow: Arrow;
  from: string;
  to: string;
  points: Pt[];
  /** A frame the arrow starts at, or stops at, rather than the box inside it. */
  clipFrom: string | null;
  clipTo: string | null;
  label: LinkLabel | null;
};
export type Route = { arrow: Arrow; pts: Pt[]; label: (LinkLabel & { x: number; y: number }) | null };

type CM = { c: number; m: number };
type Box = { id: string; c: number; m: number; cs: number; ms: number; lo: number; hi: number; rank: number };
/** A run across the flow inside a gap. `up` and `down` are where it turns towards the rank above and below. */
type Jog = { gap: number; up: number; down: number; source: string | null; target: string | null; m: number };
type Knot = { c: number; m: number; jog?: Jog };
type Plan = { link: Link; knots: Knot[]; labelAt: CM | null };
type Net = { jogs: Jog[]; lo: number; hi: number };

/** Clear room kept between a lane and a box face or a frame line. */
const CLEAR = 8;
const LANE_STEP = 12;
const SIDE_CLEAR = 20;
const LOOP = 20;

export function route(dir: Dir, leaves: Rect[], frames: Rect[], links: Link[]): Route[] {
  const horizontal = dir === "LR" || dir === "RL";
  const sign = dir === "BT" || dir === "RL" ? -1 : 1;
  const cm = (p: Pt): CM => (horizontal ? { c: p.y, m: p.x * sign } : { c: p.x, m: p.y * sign });
  const xy = (p: CM): Pt => (horizontal ? { x: p.m * sign, y: p.c } : { x: p.c, y: p.m * sign });
  const flow = (r: Rect): Box => {
    const p = cm(r);
    const cs = horizontal ? r.h : r.w;
    const ms = horizontal ? r.w : r.h;
    return { id: r.id, c: p.c, m: p.m, cs, ms, lo: p.m - ms / 2, hi: p.m + ms / 2, rank: -1 };
  };

  const boxes = leaves.map(flow);
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const ranks: { m: number; lo: number; hi: number }[] = [];
  for (const b of boxes) {
    let r = ranks.find((x) => Math.abs(x.m - b.m) < 1);
    if (!r) ranks.push((r = { m: b.m, lo: Infinity, hi: -Infinity }));
    r.lo = Math.min(r.lo, b.lo);
    r.hi = Math.max(r.hi, b.hi);
  }
  ranks.sort((a, b) => a.m - b.m);
  const rankOf = (m: number) => ranks.findIndex((r) => Math.abs(r.m - m) < 1);
  for (const b of boxes) b.rank = rankOf(b.m);
  /** No box of that rank sits on this line. */
  const free = (c: number, rank: number) => !boxes.some((b) => b.rank === rank && Math.abs(b.c - c) < b.cs / 2 + 12);

  const jogs: Jog[] = [];
  const addJog = (gap: number, up: number, down: number, source: string | null, target: string | null): Jog => {
    const jog: Jog = { gap, up, down, source, target, m: (ranks[gap].hi + ranks[gap + 1].lo) / 2 };
    jogs.push(jog);
    return jog;
  };

  const plans: Plan[] = [];
  /** Boxes with a loop of their own: it takes the far side, so nothing else leaves or enters there. */
  const looped = new Set<string>();
  type Forward = { link: Link; src: Box; tgt: Box; mids: { c: number; rank: number }[]; start: number; straight: boolean };
  const forward: Forward[] = [];
  const back: { link: Link; src: Box; tgt: Box }[] = [];

  for (const link of links) {
    const src = byId.get(link.from);
    const tgt = byId.get(link.to);
    if (!src || !tgt) continue;
    if (src === tgt) {
      looped.add(src.id);
      const c = src.c + src.cs / 2;
      plans.push({
        link,
        knots: [
          { c, m: src.m - 8 },
          { c: c + LOOP, m: src.m - 8 },
          { c: c + LOOP, m: src.m + 8 },
          { c, m: src.m + 8 },
        ],
        labelAt: { c: c + LOOP + 6, m: src.m },
      });
    } else if (tgt.rank > src.rank) {
      // dagre passes a long arrow through one point in every rank between.
      const seen = new Set<number>();
      const mids = link.points
        .slice(1, -1)
        .map(cm)
        .map((p) => ({ c: p.c, rank: rankOf(p.m) }))
        .filter((p) => p.rank > src.rank && p.rank < tgt.rank && !seen.has(p.rank) && seen.add(p.rank))
        .sort((a, b) => a.rank - b.rank);
      forward.push({ link, src, tgt, mids, start: src.c, straight: false });
    } else if (tgt.rank < src.rank) {
      back.push({ link, src, tgt });
    } else {
      const side = tgt.c > src.c ? 1 : -1;
      plans.push({
        link,
        knots: [
          { c: src.c + (side * src.cs) / 2, m: src.m },
          { c: tgt.c - (side * tgt.cs) / 2, m: tgt.m },
        ],
        labelAt: null,
      });
    }
  }

  // Where an arrow leaves: the middle of the side, unless its target sits
  // almost under it. Then it leaves in line with the target and runs straight,
  // and the box's other arrows leave from there too when that is within 16 of
  // the middle (two exits a few pixels apart read as a mistake).
  const straightFrom = new Map<string, number[]>();
  for (const f of forward) {
    if (f.mids.length) continue;
    const offset = f.tgt.c - f.src.c;
    if (Math.abs(offset) <= Math.max(Math.min(f.src.cs, f.tgt.cs) / 2 - 16, 6)) {
      f.start = f.tgt.c;
      f.straight = true;
      straightFrom.set(f.src.id, [...(straightFrom.get(f.src.id) ?? []), f.start]);
    }
  }
  for (const f of forward) {
    if (f.straight) continue;
    const near = (straightFrom.get(f.src.id) ?? []).find((c) => Math.abs(c - f.src.c) < 16);
    if (near !== undefined) f.start = near;
  }

  /** Where a long arrow passes a rank: a later loop round the side stays clear of it. */
  const columns: { c: number; rank: number }[] = [];
  for (const f of forward) {
    const { src, tgt, mids, start } = f;
    const end = tgt.c;
    let cols: number[];
    if (mids.every((p) => free(end, p.rank))) cols = mids.map(() => end);
    else if (mids.every((p) => free(start, p.rank))) cols = mids.map(() => start);
    else {
      cols = [];
      let prev = start;
      for (const p of mids) {
        prev = free(prev, p.rank) ? prev : p.c;
        cols.push(prev);
      }
    }
    mids.forEach((p, k) => columns.push({ c: cols[k], rank: p.rank }));
    const anchors = [
      { c: start, m: src.hi, rank: src.rank },
      ...mids.map((p, k) => ({ c: cols[k], m: ranks[p.rank].m, rank: p.rank })),
      { c: end, m: tgt.lo, rank: tgt.rank },
    ];
    const knots: Knot[] = [anchors[0]];
    for (let k = 1; k < anchors.length; k++) {
      const a = anchors[k - 1];
      const b = anchors[k];
      if (Math.abs(a.c - b.c) >= 0.5) {
        const jog = addJog(a.rank, a.c, b.c, k === 1 ? `${src.id}@${start}` : null, k === anchors.length - 1 ? tgt.id : null);
        knots.push({ c: a.c, m: 0, jog }, { c: b.c, m: 0, jog });
      }
      knots.push(b);
    }
    plans.push({ link: f.link, knots, labelAt: null });
  }

  // Back up the flow: out of the side, along a lane clear of every box between,
  // into the side. Shorter loops take the inner lanes. A label sits on its
  // lane, so a labelled lane keeps half the label's width clear on both sides.
  const sideLanes: { c: number; lo: number; hi: number; half: number }[] = [];
  back.sort((a, b) => a.src.rank - a.tgt.rank - (b.src.rank - b.tgt.rank));
  for (const { link, src, tgt } of back) {
    const between = boxes.filter((b) => b.rank >= tgt.rank && b.rank <= src.rank);
    const passing = columns.filter((col) => col.rank >= tgt.rank && col.rank <= src.rank).map((col) => col.c);
    const half = link.label ? (horizontal ? link.label.h : link.label.w) / 2 + 4 : 0;
    const tryOn = (side: 1 | -1) => {
      const extent =
        side > 0
          ? Math.max(...between.map((b) => b.c + b.cs / 2), ...passing)
          : Math.min(...between.map((b) => b.c - b.cs / 2), ...passing);
      let lane = extent + side * Math.max(SIDE_CLEAR, half + 4);
      const tooNear = (l: (typeof sideLanes)[number]) =>
        (l.c - extent) * side > 0 && Math.abs(l.c - lane) < Math.max(LANE_STEP, l.half, half) && l.lo < src.m && l.hi > tgt.m;
      while (sideLanes.some(tooNear)) lane += side * 4;
      // In the way of leaving by the side: a box beside this one on the lane's side, or the box's own loop.
      const blocked = (box: Box) =>
        (side > 0 && looped.has(box.id)) || boxes.some((b) => b !== box && b.rank === box.rank && (b.c - box.c) * side > 0);
      const fromBlocked = blocked(src);
      const toBlocked = blocked(tgt);
      const cost = (fromBlocked ? 1000 : 0) + (toBlocked ? 1000 : 0) + Math.abs(lane - src.c) + Math.abs(lane - tgt.c);
      return { side, lane, fromBlocked, toBlocked, cost };
    };
    const right = tryOn(1);
    const left = tryOn(-1);
    const pick = left.cost < right.cost ? left : right;
    const knots: Knot[] = [];
    if (pick.fromBlocked && pick.toBlocked && src.rank - tgt.rank === 1) {
      // Boxed in on both sides, one rank apart: straight between the facing sides, beside the arrow that goes down.
      const off = Math.max(0, Math.min(16, src.cs / 2 - 8, tgt.cs / 2 - 8));
      const jog = addJog(tgt.rank, tgt.c + off, src.c + off, null, null);
      knots.push({ c: src.c + off, m: src.lo }, { c: src.c + off, m: 0, jog }, { c: tgt.c + off, m: 0, jog }, { c: tgt.c + off, m: tgt.hi });
    } else {
      const { side, lane } = pick;
      if (pick.fromBlocked) {
        const jog = addJog(src.rank - 1, lane, src.c, null, null);
        knots.push({ c: src.c, m: src.lo }, { c: src.c, m: 0, jog }, { c: lane, m: 0, jog });
      } else {
        knots.push({ c: src.c + (side * src.cs) / 2, m: src.m }, { c: lane, m: src.m });
      }
      if (pick.toBlocked) {
        const jog = addJog(tgt.rank, tgt.c, lane, null, null);
        knots.push({ c: lane, m: 0, jog }, { c: tgt.c, m: 0, jog }, { c: tgt.c, m: tgt.hi });
      } else {
        knots.push({ c: lane, m: tgt.m }, { c: tgt.c + (side * tgt.cs) / 2, m: tgt.m });
      }
      sideLanes.push({ c: lane, lo: tgt.m, hi: src.m, half });
    }
    plans.push({ link, knots, labelAt: null });
  }

  // Lanes, gap by gap.
  const frameLines = frames.flatMap((f) => {
    const b = flow(f);
    return [b.lo, b.hi];
  });
  for (let gap = 0; gap < ranks.length - 1; gap++) {
    const own = jogs.filter((j) => j.gap === gap);
    if (!own.length) continue;
    const tracks = orderTracks(toTracks(toNets(own)));
    const lo = ranks[gap].hi;
    const hi = ranks[gap + 1].lo;
    const [from, to] = clearStretch(lo, hi, frameLines, tracks.length);
    const step = tracks.length > 1 ? Math.min(LANE_STEP, (to - from) / (tracks.length - 1)) : 0;
    const first = (from + to) / 2 - (step * (tracks.length - 1)) / 2;
    tracks.forEach((track, k) => {
      for (const net of track) for (const jog of net.jogs) jog.m = first + step * k;
    });
  }

  // Lines in page coordinates, then the labels on them.
  const frameById = new Map(frames.map((f) => [f.id, f]));
  const routes: Route[] = [];
  const spots: (CM | null)[] = [];
  for (const plan of plans) {
    let pts = tidy(plan.knots.map((k) => xy({ c: k.c, m: k.jog ? k.jog.m : k.m })));
    const stopAt = plan.link.clipTo ? frameById.get(plan.link.clipTo) : undefined;
    if (stopAt) pts = cutEntering(pts, stopAt);
    const startAt = plan.link.clipFrom ? frameById.get(plan.link.clipFrom) : undefined;
    if (startAt) pts = cutEntering(pts.reverse(), startAt).reverse();
    routes.push({ arrow: plan.link.arrow, pts, label: null });
    spots.push(plan.labelAt);
  }
  const placed: Rect[] = [];
  routes.forEach((r, k) => {
    const label = plans[k].link.label;
    if (!label) return;
    const spot = spots[k];
    let at: Pt;
    if (spot) {
      // Beside a self loop: past it, across the flow.
      const along = horizontal ? label.h : label.w;
      at = xy({ c: spot.c + along / 2, m: spot.m });
    } else {
      at = labelSpot(r.pts, label, leaves, placed, routes, k);
    }
    r.label = { ...label, x: at.x, y: at.y };
    placed.push({ id: "", x: at.x, y: at.y, w: label.w, h: label.h });
  });
  return routes;
}

/** Runs that may share a lane: those leaving one box, then those entering one box. */
function toNets(jogs: Jog[]): Net[] {
  const nets: Net[] = [];
  const taken = new Set<Jog>();
  const net = (group: Jog[]): Net => ({
    jogs: group,
    lo: Math.min(...group.map((j) => Math.min(j.up, j.down))),
    hi: Math.max(...group.map((j) => Math.max(j.up, j.down))),
  });
  const groupBy = (list: Jog[], key: (j: Jog) => string | null) => {
    const groups = new Map<string, Jog[]>();
    for (const j of list) {
      const k = key(j);
      if (k !== null) groups.set(k, [...(groups.get(k) ?? []), j]);
    }
    return groups;
  };
  for (const group of groupBy(jogs, (j) => j.source).values()) {
    if (group.length < 2) continue;
    nets.push(net(group));
    for (const j of group) taken.add(j);
  }
  for (const group of groupBy(jogs.filter((j) => !taken.has(j)), (j) => j.target).values()) {
    nets.push(net(group));
    for (const j of group) taken.add(j);
  }
  for (const j of jogs) if (!taken.has(j)) nets.push(net([j]));
  return nets;
}

/** The fewest lanes in which no two nets lie on each other. */
function toTracks(nets: Net[]): Net[][] {
  const tracks: Net[][] = [];
  for (const net of [...nets].sort((a, b) => a.lo - b.lo || a.hi - b.hi)) {
    const track = tracks.find((t) => t.every((other) => net.lo > other.hi + CLEAR || other.lo > net.hi + CLEAR));
    if (track) track.push(net);
    else tracks.push([net]);
  }
  return tracks;
}

/** The order of lanes, first nearest the rank above, in which the fewest arrows cross. */
function orderTracks(tracks: Net[][]): Net[][] {
  if (tracks.length < 2 || tracks.length > 6) return tracks;
  const inside = (c: number, net: Net) => c > net.lo + 1 && c < net.hi - 1;
  // With `above` nearer the rank above: its turns downward cross the lane below, and the lower one's turns upward cross it.
  const crossings = (above: Net[], below: Net[]) => {
    let n = 0;
    for (const a of above)
      for (const b of below) {
        for (const j of a.jogs) if (inside(j.down, b)) n++;
        for (const j of b.jogs) if (inside(j.up, a)) n++;
      }
    return n;
  };
  let best = tracks;
  let bestCost = Infinity;
  const walk = (done: Net[][], left: Net[][], cost: number) => {
    if (cost >= bestCost) return;
    if (!left.length) {
      best = done;
      bestCost = cost;
      return;
    }
    left.forEach((next, k) => {
      const added = done.reduce((sum, above) => sum + crossings(above, next), 0);
      walk([...done, next], [...left.slice(0, k), ...left.slice(k + 1)], cost + added);
    });
  };
  walk([], tracks, 0);
  return best;
}

/** The widest stretch of a gap that no frame line runs through, with room at both ends; the whole gap when lanes would not fit. */
function clearStretch(lo: number, hi: number, frameLines: number[], lanes: number): [number, number] {
  const cuts = frameLines.filter((m) => m > lo && m < hi).sort((a, b) => a - b);
  let best: [number, number] = [lo + CLEAR, hi - CLEAR];
  if (cuts.length) {
    const edges = [lo, ...cuts, hi];
    let widest = -Infinity;
    for (let k = 0; k + 1 < edges.length; k++) {
      const from = edges[k] + CLEAR;
      const to = edges[k + 1] - CLEAR;
      if (to - from > widest) {
        widest = to - from;
        best = [from, to];
      }
    }
    if (widest < (lanes - 1) * 6) best = [lo + CLEAR, hi - CLEAR];
  }
  if (best[1] < best[0]) {
    const mid = (lo + hi) / 2;
    return [mid, mid];
  }
  return best;
}

/** Drops points that repeat the one before, and those in the middle of a straight run. */
function tidy(pts: Pt[]): Pt[] {
  const same = (a: Pt, b: Pt) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
  const distinct = pts.filter((p, k) => k === 0 || !same(p, pts[k - 1]));
  return distinct.filter((p, k) => {
    if (k === 0 || k === distinct.length - 1) return true;
    const a = distinct[k - 1];
    const b = distinct[k + 1];
    const onX = Math.abs(a.x - p.x) < 0.5 && Math.abs(b.x - p.x) < 0.5;
    const onY = Math.abs(a.y - p.y) < 0.5 && Math.abs(b.y - p.y) < 0.5;
    return !(onX || onY);
  });
}

const within = (p: Pt, r: Rect) => Math.abs(p.x - r.x) < r.w / 2 && Math.abs(p.y - r.y) < r.h / 2;

/** The path up to where it first crosses into `r`. */
function cutEntering(pts: Pt[], r: Rect): Pt[] {
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1];
    const b = pts[k];
    if (within(a, r) || !within(b, r)) continue;
    const hit =
      Math.abs(a.x - b.x) < 0.5
        ? { x: b.x, y: a.y < b.y ? r.y - r.h / 2 : r.y + r.h / 2 }
        : { x: a.x < b.x ? r.x - r.w / 2 : r.x + r.w / 2, y: b.y };
    return [...pts.slice(0, k), hit];
  }
  return pts;
}

/** Where a label sits on its arrow: the longest piece with room for it, clear of boxes, other labels and other arrows. */
function labelSpot(pts: Pt[], label: LinkLabel, leaves: Rect[], placed: Rect[], routes: Route[], self: number): Pt {
  const pieces = pts
    .slice(1)
    .map((b, k) => ({ a: pts[k], b, len: Math.hypot(b.x - pts[k].x, b.y - pts[k].y) }))
    .sort((p, q) => q.len - p.len);
  const overlaps = (x: number, y: number, r: Rect, pad: number) =>
    Math.abs(x - r.x) < (label.w + r.w) / 2 + pad && Math.abs(y - r.y) < (label.h + r.h) / 2 + pad;
  const crossed = (x: number, y: number) =>
    routes.some(
      (other, k) =>
        k !== self &&
        other.pts.slice(1).some((b, i) => {
          const a = other.pts[i];
          return (
            Math.min(a.x, b.x) < x + label.w / 2 &&
            Math.max(a.x, b.x) > x - label.w / 2 &&
            Math.min(a.y, b.y) < y + label.h / 2 &&
            Math.max(a.y, b.y) > y - label.h / 2
          );
        }),
    );
  const clear = (x: number, y: number) =>
    !leaves.some((r) => overlaps(x, y, r, 2)) && !placed.some((r) => overlaps(x, y, r, 4)) && !crossed(x, y);
  let fallback: Pt | null = null;
  for (const piece of pieces) {
    const flat = Math.abs(piece.a.y - piece.b.y) < 0.5;
    const room = piece.len >= (flat ? label.w : label.h) + 8;
    for (const t of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) {
      const x = piece.a.x + (piece.b.x - piece.a.x) * t;
      const y = piece.a.y + (piece.b.y - piece.a.y) * t;
      if (!clear(x, y)) continue;
      if (room) return { x, y };
      fallback ??= { x, y };
    }
  }
  const longest = pieces[0];
  if (!longest) return pts[0];
  return fallback ?? { x: (longest.a.x + longest.b.x) / 2, y: (longest.a.y + longest.b.y) / 2 };
}
