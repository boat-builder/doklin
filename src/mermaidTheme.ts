// The Doklin mermaid palette: turns the surrounding page's colors into a full
// mermaid themeVariables set, so diagrams read as part of the document rather
// than wearing a stock mermaid theme.
//
// Shared by two consumers with different CSS around them:
//   - the editor (desktop + web shell): App.css --app-* tokens
//   - the worker's static read-only pages: PAGE_CSS --bg/--text/--link tokens
// so tokens are read through a fallback chain that ends at the body's
// computed colors — any page with sane text/background gets a sane palette.
// (This module is also re-exported by the standalone mermaid asset the worker
// serves — web/mermaid-entry.ts — which is how static pages theme diagrams
// without duplicating any of this.)

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

// First token in the chain that parses as a color wins; alpha composites onto
// `base` when given (muted tokens are rgba over the page).
function readToken(
  styles: CSSStyleDeclaration,
  names: string[],
  fallback: Rgb,
  base?: Rgb,
): Rgb {
  for (const name of names) {
    const parsed = parseColor(styles.getPropertyValue(name));
    if (!parsed) continue;
    if (parsed.a >= 1 || !base) return parsed.rgb;
    return {
      r: parsed.rgb.r * parsed.a + base.r * (1 - parsed.a),
      g: parsed.rgb.g * parsed.a + base.g * (1 - parsed.a),
      b: parsed.rgb.b * parsed.a + base.b * (1 - parsed.a),
    };
  }
  return fallback;
}

// Everything mermaid needs to draw like a Doklin document: near-paper node
// fills, muted ink lines and borders, the accent reserved for emphasis
// (notes, "today", active tasks), and a soft hue ramp around the accent for
// the inherently-categorical diagrams (pie slices, git branches).
export function mermaidThemeVariables(): Record<string, string> {
  const styles = getComputedStyle(document.documentElement);
  const bodyStyles = getComputedStyle(document.body);
  const bg =
    readToken(styles, ["--app-bg", "--bg"], parseColor(bodyStyles.backgroundColor)?.rgb ??
      { r: 255, g: 255, b: 255 });
  const dark = luminance(bg) < 0.5;
  const ink = readToken(
    styles,
    ["--app-text", "--text"],
    parseColor(bodyStyles.color)?.rgb ?? (dark ? { r: 235, g: 235, b: 235 } : { r: 55, g: 53, b: 47 }),
    bg,
  );
  const accent = readToken(
    styles,
    ["--app-accent", "--link"],
    dark ? { r: 92, g: 150, b: 242 } : { r: 47, g: 111, b: 221 },
    bg,
  );

  const inkAt = (w: number) => mix(ink, bg, w);
  const paper = toHex(bg);
  const text = toHex(ink);
  const fill = inkAt(0.05); // node interiors: barely-there tint
  const fill2 = inkAt(0.1);
  const subtle = inkAt(0.03); // clusters, section stripes
  const border = inkAt(0.42);
  const borderSoft = inkAt(0.22);
  const line = inkAt(0.6); // edges & arrows: muted ink

  // Categorical ramp: gentle rotations around the accent hue, softened toward
  // the page so a pie chart doesn't shout in a quiet document.
  const [hue] = rgbToHsl(accent);
  const sat = dark ? 0.38 : 0.45;
  const lig = dark ? 0.62 : 0.6;
  const ramp = [0, 40, -45, 85, -95, 135, 180, -140, 20, -25, 60, -70].map((off, i) =>
    mix(hslToRgb(hue + off, sat, lig + (i % 2 ? -0.07 : 0)), bg, 0.85),
  );
  // Branch/commit chips carry their label ON the color: pick per-chip ink.
  const onRamp = ramp.map((c) => (luminance(parseColor(c)!.rgb) > 0.55 ? "#28261f" : "#f5f5f2"));

  const accentSoft = mix(accent, bg, 0.12);
  const accentEdge = mix(accent, bg, 0.55);

  return {
    fontFamily: bodyFontStack(),
    fontSize: "14px",
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
    tertiaryTextColor: text,
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
    ...Object.fromEntries(ramp.map((c, i) => [`pie${i + 1}`, c])),
    pieSectionTextColor: text,
    pieLegendTextColor: text,
    pieTitleTextColor: text,
    pieStrokeColor: paper,
    pieOuterStrokeColor: paper,
    pieOpacity: "1",
    // gantt
    sectionBkgColor: subtle,
    altSectionBkgColor: paper,
    sectionBkgColor2: subtle,
    excludeBkgColor: subtle,
    taskBkgColor: mix(accent, bg, 0.16),
    taskBorderColor: accentEdge,
    taskTextColor: text,
    taskTextOutsideColor: text,
    taskTextLightColor: text,
    taskTextDarkColor: text,
    activeTaskBkgColor: mix(accent, bg, 0.3),
    activeTaskBorderColor: toHex(accent),
    doneTaskBkgColor: fill2,
    doneTaskBorderColor: border,
    gridColor: borderSoft,
    todayLineColor: toHex(accent),
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
