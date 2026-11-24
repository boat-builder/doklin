// Reads the part of Mermaid's flowchart syntax Doklin draws: boxes in a few
// shapes, arrows, subgraphs, and the classes that mark a box. What Mermaid
// has for restyling a diagram (classDef, style, linkStyle, click, init) is
// read and dropped: the look is Doklin's.
//
// A source that cannot be read ends in a FlowchartError whose message is a
// sentence naming the line.

import { plainText, type Label } from "./label";

export type Dir = "TB" | "BT" | "LR" | "RL";
export type Shape = "rect" | "pill" | "db" | "decision" | "circle" | "subroutine";
export type Status = "focus" | "good" | "warn" | "bad";
export type End = "none" | "arrow" | "circle" | "cross";
/** `none` is Mermaid's ~~~: it places its two boxes and draws nothing. */
export type Stroke = "solid" | "dotted" | "thick" | "none";

export type Box = { kind: "box"; id: string; shape: Shape; label: Label; status: Status | null; order: number };
export type Group = {
  kind: "group";
  id: string;
  title: string;
  /** Its own `direction`, when it names one. */
  dir: Dir | null;
  parent: Group | null;
  children: (Box | Group)[];
  order: number;
};
export type Arrow = {
  from: string;
  to: string;
  stroke: Stroke;
  start: End;
  end: End;
  /** How many ranks it spans: 1 for -->, 2 for --->. */
  span: number;
  label: Label | null;
};
export type Chart = {
  title: string;
  /** What a screen reader says the picture is. */
  label: string;
  dir: Dir;
  /** The chart itself, as the group every other one is inside. */
  root: Group;
  boxes: Map<string, Box>;
  groups: Map<string, Group>;
  arrows: Arrow[];
};

/** A flowchart that cannot be drawn. The message is a sentence for the reader. */
export class FlowchartError extends Error {}

const fail = (line: number, sentence: string): never => {
  throw new FlowchartError(`Line ${line}: ${sentence}`);
};

const STATUSES = new Set<string>(["focus", "good", "warn", "bad"]);

/** A box's brackets, longest first: what opens it, what may close it, the shape. */
const BRACKETS: readonly [string, readonly string[], Shape][] = [
  ["(((", [")))"], "circle"],
  ["([", ["])"], "pill"],
  ["[[", ["]]"], "subroutine"],
  ["[(", [")]"], "db"],
  ["((", ["))"], "circle"],
  ["{{", ["}}"], "decision"],
  ["[/", ["/]", "\\]"], "rect"],
  ["[\\", ["\\]", "/]"], "rect"],
  [">", ["]"], "rect"],
  ["[", ["]"], "rect"],
  ["(", [")"], "rect"],
  ["{", ["}"], "decision"],
];

/** Mermaid 11's shape names (`A@{ shape: … }`) that have a component here. Any other is a box. */
const SHAPE_NAMES: Record<string, Shape> = {};
const name = (shape: Shape, names: string) => {
  for (const n of names.split(" ")) SHAPE_NAMES[n] = shape;
};
name("pill", "stadium terminal pill");
name("subroutine", "fr-rect subprocess subproc framed-rectangle subroutine");
name("db", "cyl db database cylinder lin-cyl disk lined-cylinder h-cyl das horizontal-cylinder datastore data-store");
name("circle", "circle circ sm-circ start small-circle fr-circ stop framed-circle dbl-circ double-circle f-circ junction filled-circle");
name("decision", "diam decision diamond question hex hexagon prepare");

const normDir = (d: string): Dir => {
  const up = d.toUpperCase();
  return up === "TD" ? "TB" : (up as Dir);
};

const ID = /^[\p{L}\p{N}_]+(?:[-.][\p{L}\p{N}_]+)*/u;

/** A quoted label: a Markdown string when it is wrapped in backticks. */
function quoted(text: string): Label {
  const md = /^`([\s\S]*)`$/.exec(text.trim());
  return md ? { text: md[1], markdown: true } : { text, markdown: false };
}

/** A label that may or may not be in quotes. */
function loose(text: string): Label {
  const t = text.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? quoted(t.slice(1, -1)) : { text: t, markdown: false };
}

/**
 * A label in quotes, and a `@{ … }`, may run over several lines. Each is
 * joined into its first line; the lines it took stay as blanks, so a line
 * number still names the line the reader sees.
 */
function joinContinued(lines: string[]): string[] {
  const out: string[] = [];
  const open = (s: string) => {
    if (s.trim().startsWith("%%")) return false;
    if ((s.match(/"/g)?.length ?? 0) % 2 === 1) return true;
    const at = s.lastIndexOf("@{");
    return at >= 0 && !s.includes("}", at);
  };
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    let taken = 0;
    while (open(line) && i + taken + 1 < lines.length) {
      taken++;
      line += `\n${lines[i + taken]}`;
    }
    out.push(line);
    for (let k = 0; k < taken; k++) out.push("");
    i += taken;
  }
  return out;
}

export function parse(source: string): Chart {
  const lines = joinContinued(source.replace(/\r/g, "").split("\n"));
  const skippable = (s: string | undefined) => s !== undefined && (s.trim() === "" || s.trim().startsWith("%%"));

  let i = 0;
  let title = "";
  let accTitle = "";
  while (i < lines.length && lines[i].trim() === "") i++;
  if (lines[i]?.trim() === "---") {
    for (i++; i < lines.length && lines[i].trim() !== "---"; i++) {
      const m = /^title:\s*(.*)$/.exec(lines[i]);
      if (m) title = m[1].trim().replace(/^(["'])(.*)\1$/, "$2");
    }
    i++;
  }
  while (skippable(lines[i])) i++;
  const head = /^\s*(?:flowchart(?:-elk)?|graph)(?![\w-])[ \t]*(TB|TD|BT|LR|RL)?(?![\w-])\s*;?(.*)$/i.exec(lines[i] ?? "");
  if (!head) return fail(Math.min(i, lines.length - 1) + 1, 'a flowchart starts with "flowchart TB" or "flowchart LR".');

  const root: Group = { kind: "group", id: "", title: "", dir: null, parent: null, children: [], order: 0 };
  const boxes = new Map<string, Box>();
  const groups = new Map<string, Group>();
  const arrows: Arrow[] = [];
  /** The box names each group's own lines say, in order. */
  const named = new Map<Group, string[]>();
  const openedAt = new Map<Group, number>();
  const owner = new Map<string, Group>();
  const arrowIds = new Set<string>();
  let dir: Dir = head[1] ? normDir(head[1]) : "TB";
  let order = 1;
  let unnamed = 0;
  let cur = root;

  const ref = (id: string): Box | Group => {
    const group = groups.get(id);
    if (group) return group;
    let box = boxes.get(id);
    if (!box) {
      box = { kind: "box", id, shape: "rect", label: { text: id, markdown: false }, status: null, order: order++ };
      boxes.set(id, box);
    }
    if (cur !== root) named.get(cur)!.push(id);
    return box;
  };
  const mark = (target: Box | Group, cls: string) => {
    if (target.kind === "box" && STATUSES.has(cls)) target.status = cls as Status;
  };

  // The header's own line may carry a first statement after a semicolon.
  lines[i] = head[2];
  for (; i < lines.length; i++) {
    const ln = i + 1;
    const s = lines[i].trim().replace(/;+$/, "").trim();
    if (s === "" || s.startsWith("%%")) continue;
    let m: RegExpExecArray | null;

    if ((m = /^subgraph(?![\w-])\s*([\s\S]*)$/.exec(s))) {
      const rest = m[1].trim();
      const withTitle = /^([^\s[\]"]+)\s*\[([\s\S]*)\]$/.exec(rest);
      let id: string;
      let label: Label;
      if (withTitle) {
        id = withTitle[1];
        label = loose(withTitle[2]);
      } else if (rest === "" || /\s/.test(rest) || rest.startsWith('"')) {
        id = `subgraph ${++unnamed}`;
        label = loose(rest);
      } else {
        id = rest;
        label = { text: rest, markdown: false };
      }
      if (groups.has(id)) fail(ln, `two subgraphs are named "${id}".`);
      // An arrow written before the subgraph may have named it: that was this group, not a box.
      boxes.delete(id);
      const group: Group = { kind: "group", id, title: plainText(label), dir: null, parent: cur, children: [], order: order++ };
      groups.set(id, group);
      named.set(group, []);
      openedAt.set(group, ln);
      cur = group;
      continue;
    }
    if (/^end$/i.test(s)) {
      if (cur === root) fail(ln, '"end" has no subgraph to close.');
      // Mermaid's rule: a box named in two subgraphs belongs to the one that closes first.
      for (const id of named.get(cur)!) if (!owner.has(id)) owner.set(id, cur);
      cur = cur.parent!;
      continue;
    }
    if ((m = /^direction\s+(TB|TD|BT|LR|RL)$/i.exec(s))) {
      if (cur === root) dir = normDir(m[1]);
      else cur.dir = normDir(m[1]);
      continue;
    }
    if ((m = /^accTitle\s*:\s*(.*)$/i.exec(s))) {
      accTitle = m[1].trim();
      continue;
    }
    if (/^accDescr\s*\{/i.test(s)) {
      while (i < lines.length && !lines[i].includes("}")) i++;
      continue;
    }
    if (/^(classDef|style|linkStyle|click|accDescr)(?![\w-])/.test(s)) continue;
    if ((m = /^class\s+(.+?)\s+([\w-]+)$/.exec(s))) {
      for (const id of m[1].split(",")) if (id.trim()) mark(ref(id.trim()), m[2]);
      continue;
    }
    // Mermaid 11 names an arrow (A e1@--> B) to restyle it later (e1@{ … }): nothing to draw.
    if ((m = /^([\w-]+)@\{/.exec(s)) && arrowIds.has(m[1])) continue;

    let p = 0;
    const ws = () => {
      while (p < s.length && /\s/.test(s[p])) p++;
    };
    const stop = (sentence: string) => fail(ln, sentence);

    const readLabel = (closes: readonly string[]): Label => {
      ws();
      if (s[p] === '"') {
        const e = s.indexOf('"', p + 1);
        if (e < 0) stop("a label is missing its closing quote.");
        const text = s.slice(p + 1, e);
        p = e + 1;
        ws();
        const close = closes.find((c) => s.startsWith(c, p));
        if (!close) return stop(`"${closes[0]}" is missing after the label.`);
        p += close.length;
        return quoted(text);
      }
      let at = -1;
      let len = 0;
      for (const c of closes) {
        const e = s.indexOf(c, p);
        if (e >= 0 && (at < 0 || e < at)) {
          at = e;
          len = c.length;
        }
      }
      if (at < 0) stop(`"${closes[0]}" is missing.`);
      const text = s.slice(p, at).trim();
      p = at + len;
      return { text, markdown: false };
    };

    const readNode = (): Box | Group => {
      const im = ID.exec(s.slice(p));
      if (!im) return stop(`there should be a box name at "${s.slice(p, p + 16)}".`);
      p += im[0].length;
      const node = ref(im[0]);
      const bracket = BRACKETS.find(([o]) => s.startsWith(o, p));
      if (bracket) {
        p += bracket[0].length;
        const label = readLabel(bracket[1]);
        if (node.kind === "box") {
          node.shape = bracket[2];
          node.label = label;
        }
      }
      if (s.startsWith("@{", p)) {
        const e = s.indexOf("}", p);
        if (e < 0) stop('"@{" is missing its closing "}".');
        const body = s.slice(p + 2, e);
        p = e + 1;
        const shape = /(?:^|[\s,])shape\s*:\s*["']?([\w-]+)/.exec(body);
        const label = /(?:^|[\s,])label\s*:\s*(?:"([^"]*)"|'([^']*)'|([^,\n]+))/.exec(body);
        if (node.kind === "box") {
          if (shape) node.shape = SHAPE_NAMES[shape[1].toLowerCase()] ?? "rect";
          if (label) node.label = quoted(label[1] ?? label[2] ?? label[3].trim());
        }
      }
      for (let cm = /^:::([\w-]+)/.exec(s.slice(p)); cm; cm = /^:::([\w-]+)/.exec(s.slice(p))) {
        mark(node, cm[1]);
        p += cm[0].length;
      }
      return node;
    };

    const readNodes = (): (Box | Group)[] => {
      const list = [readNode()];
      ws();
      while (s[p] === "&") {
        p++;
        ws();
        list.push(readNode());
        ws();
      }
      return list;
    };

    const END: Record<string, End> = { ">": "arrow", "<": "arrow", o: "circle", x: "cross" };
    const end = (ch: string | undefined): End => (ch ? (END[ch] ?? "none") : "none");

    const readArrow = (): Omit<Arrow, "from" | "to"> | null => {
      const named = /^([\w-]+)@(?=[-=~.<xo])/.exec(s.slice(p));
      if (named) {
        arrowIds.add(named[1]);
        p += named[0].length;
      }
      const rest = s.slice(p);
      let a: Omit<Arrow, "from" | "to"> | null = null;
      let m2: RegExpExecArray | null;
      if ((m2 = /^~{3,}/.exec(rest))) {
        a = { stroke: "none", start: "none", end: "none", span: m2[0].length - 2, label: null };
      } else if ((m2 = /^([xo<])?-(\.+)-([xo>])?/.exec(rest))) {
        a = { stroke: "dotted", start: end(m2[1]), end: end(m2[3]), span: m2[2].length, label: null };
      } else if ((m2 = /^([xo<])?-\.(?![.-])\s*([\s\S]+?)\s*(\.+)-([xo>])?/.exec(rest))) {
        a = { stroke: "dotted", start: end(m2[1]), end: end(m2[4]), span: m2[3].length, label: loose(m2[2]) };
      } else if ((m2 = /^([xo<])?(={2,})([=xo>])/.exec(rest))) {
        a = { stroke: "thick", start: end(m2[1]), end: end(m2[3]), span: m2[2].length - 1, label: null };
      } else if ((m2 = /^([xo<])?==(?![=xo>])\s*([\s\S]+?)\s*(={2,})([=xo>])/.exec(rest))) {
        a = { stroke: "thick", start: end(m2[1]), end: end(m2[4]), span: m2[3].length - 1, label: loose(m2[2]) };
      } else if ((m2 = /^([xo<])?(-{2,})([-xo>])/.exec(rest))) {
        a = { stroke: "solid", start: end(m2[1]), end: end(m2[3]), span: m2[2].length - 1, label: null };
      } else if ((m2 = /^([xo<])?--(?![-xo>])\s*([\s\S]+?)\s*(-{2,})([-xo>])/.exec(rest))) {
        a = { stroke: "solid", start: end(m2[1]), end: end(m2[4]), span: m2[3].length - 1, label: loose(m2[2]) };
      }
      if (!a || !m2) return null;
      p += m2[0].length;
      ws();
      if (s[p] === "|") {
        // A quoted label may hold a | of its own.
        const from = s[p + 1] === '"' ? s.indexOf('"', p + 2) : p;
        const e = from < 0 ? -1 : s.indexOf("|", from + 1);
        if (e < 0) stop("an arrow's label is missing its closing |.");
        a.label = loose(s.slice(p + 1, e));
        p = e + 1;
      }
      if (a.label && a.label.text.trim() === "") a.label = null;
      return a;
    };

    let left = readNodes();
    for (;;) {
      ws();
      if (p >= s.length) break;
      if (s[p] === ";") {
        // Another statement on the same line.
        p++;
        ws();
        if (p >= s.length) break;
        left = readNodes();
        continue;
      }
      const arrow = readArrow();
      if (!arrow) return stop(`"${s.slice(p, p + 16)}" is not an arrow Doklin draws.`);
      ws();
      if (p >= s.length) stop("an arrow has no box to point at.");
      const right = readNodes();
      for (const a of left) for (const b of right) arrows.push({ ...arrow, from: a.id, to: b.id });
      left = right;
    }
  }
  if (cur !== root) fail(openedAt.get(cur)!, 'this subgraph has no "end".');

  for (const group of groups.values()) group.parent!.children.push(group);
  for (const box of boxes.values()) (owner.get(box.id) ?? root).children.push(box);
  const sort = (g: Group) => {
    g.children.sort((a, b) => a.order - b.order);
    for (const c of g.children) if (c.kind === "group") sort(c);
  };
  sort(root);

  return { title, label: accTitle || title || "Flowchart", dir, root, boxes, groups, arrows };
}
