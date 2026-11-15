// ```svg drawing blocks: hand-placed SVG in the markdown, shown as the
// picture it draws — the same kind of figure as the Claude Docs viewer's
// diagrams. There is no layout engine: the author (a person or an agent)
// places every box, following the drawing grammar `doklin help drawings`
// teaches; colours are the --dg-* tokens, so a drawing follows the theme
// with no re-render.
//
// Rides Crepe's code-block preview hook as a figure block (figureBlock.ts:
// the picture alone while reading, the source alone while editing). The
// markup goes through drawingSvg.ts's sanitizer every time; rendering is
// synchronous, so the hook answers at once.

import { LanguageDescription } from "@codemirror/language";
import { ensureFigureHooks, figureChips, figureSourceAttr } from "./figureBlock";
import { isDrawingLanguage, sanitizeDrawing } from "./drawingSvg";

export { isDrawingLanguage };

let seq = 0;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const ERROR_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;

/** The preview a ```svg block shows: its drawing, or a quiet card saying why not. */
export function drawingPreview(source: string): string {
  ensureFigureHooks();
  // A namespace per render: the same drawing twice on a page, or one being
  // re-rendered while its old copy is still in the DOM, never shares ids.
  const result = sanitizeDrawing(source, `dg${++seq}-`);
  if (result.ok) {
    return `<div class="dk-figure dk-drawing" ${figureSourceAttr(source)}>${result.svg}${figureChips(true)}</div>`;
  }
  return `<div class="dk-figure dk-drawing dk-figure-error">
<div class="dk-figure-error-head">${ERROR_ICON}<span>Drawing doesn’t parse yet</span></div>
<pre class="dk-figure-error-msg">${escapeHtml(result.message)}</pre>
${figureChips(false)}
</div>`;
}

// The language picker's "svg": highlighted as XML (the picker's own XML
// grammar, borrowed so nothing new is bundled). Named lowercase on purpose:
// the name is written into the fence, and ```svg is the form other markdown
// renderers show as code.
export function drawingLanguage(languages: readonly LanguageDescription[]): LanguageDescription {
  const xml = languages.find((l) => l.name === "XML");
  return LanguageDescription.of({
    name: "svg",
    load: () => (xml ? xml.load() : Promise.reject(new Error("no XML grammar"))),
  });
}
