// A scene as SVG, for every surface that shows a flowchart in a web page.
// It writes only svg, rect, path, text and tspan, coloured with the drawing
// tokens: nothing a ```svg drawing may not hold itself (src/drawingSvg.ts),
// so a flowchart follows the theme the way a drawing does, with no redraw.

import type { Item, Paint, Scene } from "./scene";

const colour = (p: Paint) => (p === "sheet" ? "var(--sheet)" : `var(--dg-${p})`);

const text = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = (s: string) => text(s).replace(/"/g, "&quot;");

function paint(it: { stroke?: Paint; width?: number; fill?: Paint; opacity?: number }): string {
  let out = ` fill="${it.fill ? colour(it.fill) : "none"}"`;
  if (it.fill && it.opacity !== undefined) out += ` fill-opacity="${it.opacity}"`;
  if (it.stroke) out += ` stroke="${colour(it.stroke)}" stroke-width="${it.width ?? 1}"`;
  return out;
}

function one(it: Item): string {
  if (it.t === "rect") {
    return `<rect x="${it.x}" y="${it.y}" width="${it.w}" height="${it.h}"${it.r ? ` rx="${it.r}"` : ""}${paint(it)}/>`;
  }
  if (it.t === "path") {
    const d = it.d.map((seg) => seg[0] + seg.slice(1).join(" ")).join("");
    const dash = it.dash ? ` stroke-dasharray="${it.dash[0]} ${it.dash[1]}" stroke-linecap="round"` : "";
    return `<path d="${d}"${paint(it)} stroke-linejoin="round"${dash}/>`;
  }
  const runs = it.runs
    .map((run) =>
      run.bold || run.italic
        ? `<tspan${run.bold ? ' font-weight="600"' : ""}${run.italic ? ' font-style="italic"' : ""}>${text(run.s)}</tspan>`
        : text(run.s),
    )
    .join("");
  const anchor = it.anchor === "middle" ? ' text-anchor="middle"' : "";
  return `<text x="${it.x}" y="${it.y}"${anchor} font-size="${it.size}" fill="${colour(it.paint)}">${runs}</text>`;
}

/** The scene as one `<svg>` element, sized by its viewBox alone. */
export function sceneSvg(scene: Scene): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${scene.width} ${scene.height}" role="img" aria-label="${attr(scene.label)}">` +
    scene.items.map(one).join("") +
    "</svg>"
  );
}
