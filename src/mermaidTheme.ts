// The Doklin mermaid palette: turns the surrounding page's colors into a full
// mermaid themeVariables set, so diagrams read as part of the document rather
// than wearing a stock mermaid theme.
//
// Two consumers read it, both on the app's own tokens (styles/tokens.css):
// the editor, and a public page, which the cloud worker themes from that
// same file and hydrates with this module (cloud-worker/src/theme.ts). A
// token that doesn't parse falls back to the body's computed colors, so any
// page with sane text and background still gets a sane palette.

type Rgb = { r: number; g: number; b: number };

function parseColor(input: string): { rgb: Rgb; a: number } | null {
  const s = input.trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3})$/);
  if (m) {
    const [r, g, b] = m[1].split("").map((c) => parseInt(c + c, 16));
    return { rgb: { r, g, b }, a: 1 };
  }
  m = s.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/);
  if (m) {
    const n = parseInt(m[1], 16);
    return {
      rgb: { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff },
      a: m[2] ? parseInt(m[2], 16) / 255 : 1,
    };
  }
  m = s.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/);
  if (m) {
    return {
      rgb: { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) },
      a: m[4] === undefined ? 1 : Number(m[4]),
    };
  }
  return null;
}

function toHex({ r, g, b }: Rgb): string {
  const h = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

// w of `over` blended onto `under` (both solid), as hex.
function mix(over: Rgb, under: Rgb, w: number): string {
  return toHex({
    r: over.r * w + under.r * (1 - w),
    g: over.g * w + under.g * (1 - w),
    b: over.b * w + under.b * (1 - w),
  });
}

function rgbToHsl({ r, g, b }: Rgb): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h * 360, s, l];
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const hn = (((h % 360) + 360) % 360) / 360;
  if (s === 0) {
    const v = l * 255;
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t0: number) => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return { r: channel(hn + 1 / 3) * 255, g: channel(hn) * 255, b: channel(hn - 1 / 3) * 255 };
}

function luminance({ r, g, b }: Rgb): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

// Mermaid measures HTML labels in a container attached to <body>, BEFORE the
// SVG's own style element exists — so the layout font is whatever body
// computes to. Handing that same stack back to mermaid as the display font is
// what keeps measurement and rendering identical (a mismatch clips labels).
export function bodyFontStack(): string {
  return (
    getComputedStyle(document.body).fontFamily ||
    '-apple-system, BlinkMacSystemFont, "Inter", "SF Pro Text", "Segoe UI", sans-serif'
  );
}

// A token's color, or `fallback` when it doesn't parse; alpha composites onto
// `base` when given (muted tokens are rgba over the page).
function readToken(
  styles: CSSStyleDeclaration,
  name: string,
  fallback: Rgb,
  base?: Rgb,
): Rgb {
  const parsed = parseColor(styles.getPropertyValue(name));
  if (!parsed) return fallback;
  if (parsed.a >= 1 || !base) return parsed.rgb;
  return {
    r: parsed.rgb.r * parsed.a + base.r * (1 - parsed.a),
    g: parsed.rgb.g * parsed.a + base.g * (1 - parsed.a),
    b: parsed.rgb.b * parsed.a + base.b * (1 - parsed.a),
  };
}

// Everything mermaid needs to draw in the drawing grammar (the one ```svg
// drawings follow, drawing.ts): boxes are outlines on the page with no fill,
// borders and connectors in the rule colour, words in the drawing inks, the
// accent kept for the one emphasised thing, and the drawing hues
// (--dg-cat-*) for the categorical diagrams (pie slices, git branches).
// Most of a flowchart's look is THEME_CSS below, which names the tokens
// directly; these hex values serve the diagram types it doesn't reach.
export function mermaidThemeVariables(): Record<string, string> {
  const styles = getComputedStyle(document.documentElement);
  const bodyStyles = getComputedStyle(document.body);
  const bg =
    readToken(styles, "--sheet", parseColor(bodyStyles.backgroundColor)?.rgb ??
      { r: 255, g: 255, b: 255 });
  const dark = luminance(bg) < 0.5;
  const ink = readToken(
    styles,
    "--dg-ink",
    parseColor(bodyStyles.color)?.rgb ?? (dark ? { r: 240, g: 239, b: 236 } : { r: 31, g: 30, b: 29 }),
    bg,
  );
  const ink2 = readToken(styles, "--dg-ink-2", { r: ink.r, g: ink.g, b: ink.b }, bg);
  const rule = readToken(styles, "--dg-rule", dark ? { r: 56, g: 56, b: 53 } : { r: 195, g: 194, b: 183 }, bg);
  const accent = readToken(
    styles,
    "--dg-accent",
    dark ? { r: 57, g: 135, b: 229 } : { r: 42, g: 120, b: 214 },
    bg,
  );

  const inkAt = (w: number) => mix(ink, bg, w);
  const paper = toHex(bg);
  const text = toHex(ink);
  const quiet = toHex(ink2);
  const fill = paper; // no fill: a box is its outline
  const fill2 = inkAt(0.04); // the rare second surface (alternating rows)
  const subtle = paper;
  const border = toHex(rule);
  const borderSoft = toHex(rule);
  const line = toHex(rule);

  // Categorical hues: the drawing palette, in order.
  const ramp = Array.from({ length: 8 }, (_, i) =>
    toHex(readToken(styles, `--dg-cat-${i + 1}`, hslToRgb(rgbToHsl(accent)[0] + i * 45, 0.6, 0.5), bg)),
  );
  // Branch/commit chips carry their label ON the color: pick per-chip ink.
  const onRamp = ramp.map((c) => (luminance(parseColor(c)!.rgb) > 0.55 ? "#1f1e1d" : "#ffffff"));

  const accentSoft = mix(accent, bg, 0.12);
  const accentEdge = toHex(accent);

  return {
    fontFamily: bodyFontStack(),
    fontSize: "13px",
    background: paper,
    textColor: text,
    lineColor: line,
    // primary/secondary/tertiary: the tint families every diagram draws from
    primaryColor: fill,
    primaryTextColor: text,
    primaryBorderColor: border,
    secondaryColor: fill2,
    secondaryTextColor: text,
    secondaryBorderColor: borderSoft,
    tertiaryColor: subtle,
    tertiaryTextColor: quiet,
    tertiaryBorderColor: borderSoft,
    // flowchart
    mainBkg: fill,
    secondBkg: fill2,
    nodeBorder: border,
    nodeTextColor: text,
    defaultLinkColor: line,
    edgeLabelBackground: paper,
    clusterBkg: subtle,
    clusterBorder: borderSoft,
    titleColor: text,
    // sequence
    actorBkg: fill,
    actorBorder: border,
    actorTextColor: text,
    actorLineColor: borderSoft,
    signalColor: line,
    signalTextColor: text,
    labelBoxBkgColor: fill,
    labelBoxBorderColor: border,
    labelTextColor: text,
    loopTextColor: text,
    activationBkgColor: fill2,
    activationBorderColor: border,
    sequenceNumberColor: paper,
    noteBkgColor: accentSoft,
    noteBorderColor: accentEdge,
    noteTextColor: text,
    // state
    transitionColor: line,
    transitionLabelColor: text,
    stateLabelColor: text,
    stateBkg: fill,
    labelBackgroundColor: fill,
    compositeBackground: subtle,
    compositeTitleBackground: fill2,
    altBackground: subtle,
    innerEndBackground: border,
    specialStateColor: line,
    // class / er
    classText: text,
    attributeBackgroundColorOdd: paper,
    attributeBackgroundColorEven: subtle,
    // pie
    ...Object.fromEntries([...ramp, ...ramp].map((c, i) => [`pie${i + 1}`, c])),
    pieSectionTextColor: text,
    pieLegendTextColor: text,
    pieTitleTextColor: text,
    pieStrokeColor: paper,
    pieTitleTextSize: "15px",
    pieSectionTextSize: "13px",
    pieOuterStrokeColor: paper,
    pieOpacity: "1",
    // gantt
    sectionBkgColor: subtle,
    altSectionBkgColor: paper,
    sectionBkgColor2: subtle,
    excludeBkgColor: subtle,
    taskBkgColor: accentSoft,
    taskBorderColor: accentEdge,
    taskTextColor: text,
    taskTextOutsideColor: text,
    taskTextLightColor: text,
    taskTextDarkColor: text,
    activeTaskBkgColor: mix(accent, bg, 0.3),
    activeTaskBorderColor: accentEdge,
    doneTaskBkgColor: fill2,
    doneTaskBorderColor: border,
    gridColor: borderSoft,
    todayLineColor: accentEdge,
    // git graph
    ...Object.fromEntries(ramp.slice(0, 8).map((c, i) => [`git${i}`, c])),
    ...Object.fromEntries(onRamp.slice(0, 8).map((c, i) => [`gitBranchLabel${i}`, c])),
    commitLabelColor: text,
    commitLabelBackground: fill2,
    tagLabelColor: text,
    tagLabelBackground: accentSoft,
    tagLabelBorder: accentEdge,
  };
}

/* ---------- The flowchart grammar ---------- */

// Flowchart labels follow one convention: `"<b>Name</b><br/>line"` is a name
// over a quieter line (13/600 ink over 11.5 secondary), a label without <b>
// is plain 13px ink, and `X:::focus` (or `class X focus`) is the one
// emphasised box — no classDef needed. Colours are --dg-* tokens resolved by
// the page, so these rules hold in every theme. Mermaid scopes themeCSS
// under the diagram's id. The label SIZES must also exist as global CSS
// (App.css, "Mermaid labels"): mermaid measures labels before this
// stylesheet is in the SVG, and a size it didn't measure clips the box.
const THEME_CSS = `
  .node rect, .node polygon, .node circle, .node ellipse, .node path {
    fill: none !important; stroke: var(--dg-rule) !important; stroke-width: 1.25px !important;
  }
  .node.focus rect, .node.focus polygon, .node.focus circle, .node.focus ellipse, .node.focus path {
    fill: color-mix(in srgb, var(--dg-accent) 12%, transparent) !important;
    stroke: var(--dg-accent) !important; stroke-width: 2px !important;
  }
  .nodeLabel, .nodeLabel p { color: var(--dg-ink) !important; }
  .nodeLabel:has(b), .nodeLabel:has(b) p { color: var(--dg-ink-2) !important; }
  .nodeLabel b { color: var(--dg-ink); font-weight: 600; }
  .nodeLabel i { font-style: italic; }
  .edgeLabel, .edgeLabel p, .edgeLabel span { color: var(--dg-ink-2) !important; }
  .edgeLabel rect, .labelBkg { fill: var(--sheet) !important; background: var(--sheet) !important; }
  .flowchart-link, .edgePath .path { stroke: var(--dg-rule) !important; stroke-width: 1.25px !important; }
  .marker, .arrowheadPath, .arrowMarkerPath { fill: var(--dg-rule) !important; stroke: var(--dg-rule) !important; }
  .cluster rect { fill: none !important; stroke: var(--dg-grid) !important; stroke-width: 1px !important; }
  .cluster-label .nodeLabel, .cluster-label span, .cluster-label p { color: var(--dg-ink-2) !important; font-weight: 600; }
  .flowchartTitleText, .pieTitleText, .titleText { fill: var(--dg-ink) !important; font-size: 15px !important; font-weight: 600; }
  .flowchartTitleText { text-anchor: start !important; }
`;

// Pinned on purpose: Mermaid 12 makes another look and layout the default,
// and an upgrade must not re-lay out or restyle documents people wrote.
const FLOWCHART = {
  htmlLabels: true,
  curve: "linear",
  nodeSpacing: 24,
  rankSpacing: 36,
  padding: 14,
  wrappingWidth: 520,
  diagramPadding: 8,
  subGraphTitleMargin: { top: 6, bottom: 6 },
  useMaxWidth: true,
} as const;

/** The full mermaid.initialize config, read from the page's tokens now. */
export function mermaidConfig() {
  return {
    startOnLoad: false,
    // Shared documents can carry anyone's markdown — keep label sanitizing
    // on and interactions off (mermaid also runs its own DOMPurify pass).
    securityLevel: "strict" as const,
    suppressErrorRendering: true,
    theme: "base" as const,
    look: "classic" as const,
    layout: "dagre",
    fontFamily: bodyFontStack(),
    themeVariables: mermaidThemeVariables(),
    themeCSS: THEME_CSS,
    flowchart: FLOWCHART,
  };
}

/**
 * What CSS can't do to a rendered diagram: the title moves to the drawing's
 * left edge (drawings put their title top-left), and node rectangles take
 * the grammar's 8px corners as attributes (WebKit ignores rx as CSS).
 */
export function finishMermaidSvg(svg: string): string {
  // Parsed as HTML, the way it is inserted: mermaid's labels carry HTML
  // (<br>) that an XML parser refuses.
  const holder = document.createElement("template");
  holder.innerHTML = svg;
  const root = holder.content.firstElementChild;
  if (!root || root.nodeName.toLowerCase() !== "svg") return svg;
  const box = (root.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  const title = root.querySelector("text.flowchartTitleText");
  if (title && box.length === 4 && box.every(Number.isFinite)) {
    title.setAttribute("x", String(box[0] + FLOWCHART.diagramPadding));
  }
  for (const rect of root.querySelectorAll("g.node rect.label-container, g.node rect.basic")) {
    rect.setAttribute("rx", "8");
    rect.setAttribute("ry", "8");
  }
  return holder.innerHTML;
}
