// Entry for the standalone mermaid module a domain serves at
// /__web/<tag>/mermaid.js. scripts/bundle-worker.mjs builds it into one ES
// module (mermaid's lazy diagram chunks flattened in — one file, one path)
// and writes it into the web directory Cloudflare serves beside the worker.
// A public page that carries a ```mermaid block names it in a script tag,
// and it draws that page's diagrams in the same grammar and page-derived
// palette the editor uses (src/mermaidTheme.ts).
//
// It is the only script a public page runs: the page's policy names this
// one address (cloud-worker/src/public.ts) and refuses every script written
// into a page. So whatever a page needs done in the browser is done here.
// Browser code: typechecked with the app, never bundled into it.
import mermaid from "mermaid";
import { finishMermaidSvg, mermaidConfig } from "../../src/mermaidTheme";

// Each ```mermaid code block and the figure that takes its place. A source
// that doesn't parse keeps its plain code block, and without JavaScript the
// page still shows every source.
const spots = [...document.querySelectorAll("pre > code.language-mermaid")].flatMap((code) => {
  const pre = code.parentElement;
  if (!pre) return [];
  const holder = document.createElement("div");
  holder.className = "dk-mermaid";
  return [{ source: code.textContent ?? "", pre, holder }];
});

let seq = 0;
async function drawAll(): Promise<void> {
  // Re-initialized per pass: the palette derives from the page's current
  // colors, and the prefers-color-scheme listener below draws again on flips.
  mermaid.initialize(mermaidConfig());
  for (const spot of spots) {
    try {
      const { svg } = await mermaid.render(`dk-mermaid-${++seq}`, spot.source);
      spot.holder.innerHTML = finishMermaidSvg(svg);
      if (!spot.holder.isConnected) spot.pre.replaceWith(spot.holder);
    } catch {
      if (spot.holder.isConnected) spot.holder.replaceWith(spot.pre);
    }
  }
  document.documentElement.dataset.mermaid = String(spots.filter((s) => s.holder.isConnected).length);
}

if (spots.length > 0) {
  void drawAll().then(() => matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => void drawAll()));
}
