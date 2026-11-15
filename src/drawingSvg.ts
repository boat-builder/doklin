// The ```svg drawing block's sanitizer: hand-placed SVG markup in, safe SVG
// out. Pure (no DOM), so the app and a published page run the same code and
// can't disagree about what a drawing may contain.
//
// It parses the markup itself, keeps an allowlist of elements and
// attributes, and serializes a fresh tree, so nothing the browser would
// parse differently can survive. Refused outright: anything outside the
// allowlist (script, style, foreignObject, use, image, a, …), event
// handlers, href/xlink:href, style and class attributes, and url() that
// points anywhere but an id inside the drawing.
//
// Every id, and every url(#…) naming one, gets the caller's namespace, so two
// drawings on one page that both define `arrow` keep their own markers.
//
// Colours are meant to be the drawing tokens (var(--dg-ink) etc., tokens.css)
// so a drawing follows the theme; hex still passes, since a literal colour
// is no danger, only off-theme.

const ELEMENTS = new Set([
  "svg", "g", "defs", "marker", "path", "rect", "line", "polyline", "polygon",
  "circle", "ellipse", "text", "tspan", "title", "desc",
]);

const ATTRIBUTES = new Set([
  "id", "role", "aria-label", "aria-hidden", "viewBox", "preserveAspectRatio", "xmlns",
  "width", "height", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry",
  "d", "points", "pathLength", "transform", "dx", "dy", "rotate", "textLength", "lengthAdjust",
  "fill", "fill-opacity", "fill-rule", "clip-rule", "opacity", "visibility",
  "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray", "stroke-dashoffset",
  "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "vector-effect", "paint-order",
  "font-family", "font-size", "font-weight", "font-style", "letter-spacing", "word-spacing",
  "text-anchor", "dominant-baseline", "alignment-baseline", "baseline-shift", "text-decoration",
  "marker-start", "marker-mid", "marker-end", "markerWidth", "markerHeight", "markerUnits",
  "refX", "refY", "orient",
]);

/** The fence info string that makes a code block a drawing. */
export function isDrawingLanguage(language: string): boolean {
  return language.trim().toLowerCase() === "svg";
}

export type DrawingResult = { ok: true; svg: string; label: string } | { ok: false; message: string };

type Node = { name: string; attrs: [string, string][]; children: (Node | string)[] };

const NAME = /^[A-Za-z_][\w.:-]*/;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[ent.toLowerCase()] ?? whole;
  });
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;");
}

class ParseError extends Error {}

// A small XML reader: elements, attributes (quoted with ' or "), text,
// comments, CDATA and an <?xml?> prolog. A DOCTYPE is refused (it can define
// entities). Mismatched or unclosed tags are errors, as in any XML parser.
function parse(src: string): Node {
  let i = 0;
  const root: Node = { name: "#root", attrs: [], children: [] };
  const stack: Node[] = [root];
  const fail = (what: string): never => {
    const line = src.slice(0, i).split("\n").length;
    throw new ParseError(`${what} (line ${line})`);
  };
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt === -1) {
      stack[stack.length - 1].children.push(decodeEntities(src.slice(i)));
      break;
    }
    if (lt > i) stack[stack.length - 1].children.push(decodeEntities(src.slice(i, lt)));
    i = lt;
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      if (end === -1) fail("Unclosed comment");
      i = end + 3;
    } else if (src.startsWith("<![CDATA[", i)) {
      const end = src.indexOf("]]>", i + 9);
      if (end === -1) fail("Unclosed CDATA section");
      stack[stack.length - 1].children.push(src.slice(i + 9, end));
      i = end + 3;
    } else if (src.startsWith("<?", i)) {
      const end = src.indexOf("?>", i + 2);
      if (end === -1) fail("Unclosed processing instruction");
      i = end + 2;
    } else if (src.startsWith("<!", i)) {
      fail("A drawing can't carry a DOCTYPE");
    } else if (src.startsWith("</", i)) {
      i += 2;
      const m = NAME.exec(src.slice(i));
      if (!m) fail("Malformed closing tag");
      const name = m![0];
      i += name.length;
      while (/\s/.test(src[i] ?? "")) i++;
      if (src[i] !== ">") fail(`Malformed closing tag </${name}>`);
      i++;
      const open = stack.pop();
      if (!open || open === root || open.name !== name) fail(`Unexpected </${name}>`);
    } else {
      i += 1;
      const m = NAME.exec(src.slice(i));
      if (!m) fail("Malformed tag");
      const node: Node = { name: m![0], attrs: [], children: [] };
      i += node.name.length;
      for (;;) {
        while (/\s/.test(src[i] ?? "")) i++;
        if (src[i] === ">") {
          i++;
          stack[stack.length - 1].children.push(node);
          stack.push(node);
          break;
        }
        if (src.startsWith("/>", i)) {
          i += 2;
          stack[stack.length - 1].children.push(node);
          break;
        }
        const a = NAME.exec(src.slice(i));
        if (!a) fail(`Malformed attribute in <${node.name}>`);
        const attr = a![0];
        i += attr.length;
        while (/\s/.test(src[i] ?? "")) i++;
        if (src[i] !== "=") fail(`Attribute ${attr} in <${node.name}> has no value`);
        i++;
        while (/\s/.test(src[i] ?? "")) i++;
        const quote = src[i];
        if (quote !== '"' && quote !== "'") fail(`Attribute ${attr} in <${node.name}> isn't quoted`);
        const end = src.indexOf(quote, i + 1);
        if (end === -1) fail(`Unclosed attribute ${attr} in <${node.name}>`);
        node.attrs.push([attr, decodeEntities(src.slice(i + 1, end))]);
        i = end + 1;
      }
    }
  }
  if (stack.length > 1) fail(`<${stack[stack.length - 1].name}> is never closed`);
  return root;
}

// A value may name an id inside the drawing — url(#id) — and nothing else.
const URL_REF = /url\(\s*(['"]?)#([\w.:-]+)\1\s*\)/g;

function cleanValue(value: string, ns: string): string | null {
  const stripped = value.replace(URL_REF, "");
  if (/url\s*\(|expression\s*\(|javascript:|[<>]/i.test(stripped)) return null;
  return value.replace(URL_REF, (_, __, id: string) => `url(#${ns}${id})`);
}

function serialize(node: Node, ns: string, isRoot: boolean): string {
  if (!ELEMENTS.has(node.name)) return "";
  let out = `<${node.name}`;
  for (const [name, raw] of node.attrs) {
    const allowed = ATTRIBUTES.has(name) || /^data-[\w-]+$/.test(name);
    if (!allowed) continue;
    if (name === "xmlns" && !isRoot) continue;
    const value = name === "id" ? `${ns}${raw}` : cleanValue(raw, ns);
    if (value === null) continue;
    out += ` ${name}="${escapeAttr(value)}"`;
  }
  out += ">";
  for (const child of node.children) {
    out += typeof child === "string" ? escapeText(child) : serialize(child, ns, false);
  }
  return `${out}</${node.name}>`;
}

/**
 * The drawing a block's source draws, or why it can't. `ns` prefixes every
 * id (and the url(#…) naming it); give each block on a page its own.
 */
export function sanitizeDrawing(source: string, ns: string): DrawingResult {
  let root: Node;
  try {
    root = parse(source.trim());
  } catch (err) {
    return { ok: false, message: err instanceof ParseError ? err.message : String(err) };
  }
  const elements = root.children.filter((c): c is Node => typeof c !== "string");
  const strays = root.children.filter((c) => typeof c === "string" && c.trim() !== "");
  if (elements.length !== 1 || strays.length > 0 || elements[0].name !== "svg") {
    return { ok: false, message: "A drawing is one <svg> element, with nothing around it" };
  }
  const svg = elements[0];
  if (!svg.attrs.some(([n]) => n === "viewBox")) {
    return { ok: false, message: "The <svg> needs a viewBox, such as viewBox=\"0 0 760 400\"" };
  }
  if (!svg.attrs.some(([n]) => n === "xmlns")) svg.attrs.push(["xmlns", "http://www.w3.org/2000/svg"]);
  const label = svg.attrs.find(([n]) => n === "aria-label")?.[1] ?? "";
  return { ok: true, svg: serialize(svg, ns, true), label };
}
