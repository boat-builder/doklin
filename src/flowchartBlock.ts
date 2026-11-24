// ```mermaid blocks in the editor: a flowchart is shown as the picture
// Doklin draws from it (src/flowchart/), in the same grammar as ```svg
// drawings. Only flowcharts are drawn. Another kind of Mermaid diagram stays
// a code block, under a line saying so.
//
// Rides Crepe's code-block preview hook as a figure block (figureBlock.ts:
// the picture alone while reading, the source alone while editing). The hook
// runs on every keystroke inside the block and again whenever Crepe remounts
// it, so finished previews are kept by source. A small flowchart lays out in
// a few milliseconds and the hook answers at once, as drawing.ts does. A big
// one takes tens, so it waits for a pause in the typing.
//
// Colours are the --dg-* tokens, named inside the SVG, so a theme change
// needs no redraw.

import { LanguageDescription, LanguageSupport, StreamLanguage } from "@codemirror/language";
import { ensureFigureHooks, figureChips, figureSource, figureSourceAttr } from "./figureBlock";
import { layoutFlowchart, sceneSvg } from "./flowchart/index";

const MEMO_MAX = 32;
/** Finished previews by frame and source. */
const memo = new Map<string, string>();

/** A source with more lines of arrows than this takes too long to lay out on every keystroke. */
const BIG = 16;
const PAUSE_MS = 200;
const isBig = (source: string) => source.split("\n").filter((line) => /--|==|-\.|~~~/.test(line)).length > BIG;

type Apply = (value: string | HTMLElement | null) => void;
let waiting: { source: string; frame: number; apply: Apply }[] = [];
let timer: number | null = null;

/** What the block shows while a big flowchart waits for a pause in the typing. */
export const FLOWCHART_PREVIEW_WAITING = `<div class="dk-figure dk-flowchart dk-figure-loading">Drawing the flowchart…</div>`;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const ERROR_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;

/** The picture inside its figure wrapper, or null when the source is not a flowchart that can be drawn. */
function picture(source: string, frame: number): string | null {
  const result = layoutFlowchart(source, frame);
  return result.ok ? sceneSvg(result.scene) + figureChips(true) : null;
}

/**
 * The preview a ```mermaid block shows, laid out for a frame `frame` wide:
 * the flowchart; or a quiet card saying why it cannot be drawn yet (the
 * normal state mid-typing); or, for another kind of diagram, a note under
 * the source, which stays on show. Returns it at once, or undefined when it
 * will be handed to `apply` after a pause (the block shows
 * FLOWCHART_PREVIEW_WAITING until then).
 */
export function flowchartPreview(source: string, frame: number, apply: Apply): string | undefined {
  ensureFigureHooks();
  const kept = memo.get(`${frame}\n${source}`);
  if (kept !== undefined) return kept;
  if (!isBig(source)) return preview(source, frame);

  // The hook says nothing of which block it is for, so every revision of a
  // typing burst is kept and drawn: a half-typed one fails fast, and each
  // answer goes to the panel that asked.
  waiting.push({ source, frame, apply });
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = null;
    const jobs = waiting;
    waiting = [];
    for (const job of jobs) job.apply(preview(job.source, job.frame));
  }, PAUSE_MS);
  return undefined;
}

function preview(source: string, frame: number): string {
  const key = `${frame}\n${source}`;
  const kept = memo.get(key);
  if (kept !== undefined) return kept;

  const result = layoutFlowchart(source, frame);
  let html: string;
  if (result.ok) {
    // The wrapper carries its source, so the zoom view and a relayout can read it back.
    html = `<div class="dk-figure dk-flowchart" ${figureSourceAttr(source)}>${sceneSvg(result.scene)}${figureChips(true)}</div>`;
  } else if (result.why === "unsupported") {
    // Not a .dk-figure: the block keeps its source showing.
    html = `<div class="dk-figure-note">${escapeHtml(result.message)}</div>`;
  } else {
    html = `<div class="dk-figure dk-flowchart dk-figure-error">
<div class="dk-figure-error-head">${ERROR_ICON}<span>Flowchart can’t be drawn yet</span></div>
<pre class="dk-figure-error-msg">${escapeHtml(result.message)}</pre>
${figureChips(false)}
</div>`;
  }
  if (memo.size >= MEMO_MAX) {
    const oldest = memo.keys().next().value;
    if (oldest !== undefined) memo.delete(oldest);
  }
  memo.set(key, html);
  return html;
}

/** Draws every flowchart on the page again for a new frame width: the iPhone editor's column changes with the screen. */
export function relayFlowcharts(frame: number): void {
  for (const el of document.querySelectorAll<HTMLElement>(".dk-flowchart[data-dk-figure-src]")) {
    const drawn = picture(figureSource(el), frame);
    if (drawn !== null) el.innerHTML = drawn;
  }
}

export function isMermaidLanguage(language: string): boolean {
  const l = language.trim().toLowerCase();
  return l === "mermaid" || l === "mmd";
}

/* ---------- Language picker entry ---------- */

// The words of the flowchart syntax — enough for comments, strings, arrows
// and keywords to read distinctly; everything else stays plain.
const KEYWORDS = new Set([
  "flowchart", "graph", "subgraph", "end", "direction", "class", "classdef", "style", "linkstyle", "click",
  "acctitle", "accdescr", "title", "tb", "td", "bt", "lr", "rl",
]);

const mermaidStream = StreamLanguage.define({
  name: "mermaid",
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match("%%")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
    // Arrows: -->, ---, -.->, ==>, --x, --o, <-->, ~~~ …
    if (stream.match(/^(?:<?[-=.]{2,}[>xo]?|[xo<][-=.]{2,}>?|~{3,})/)) return "operator";
    if (stream.match(/^:::?|^[|&]/)) return "operator";
    const word = stream.match(/^[A-Za-z_][\w-]*/) as RegExpMatchArray | null;
    if (word) return KEYWORDS.has(word[0].toLowerCase()) ? "keyword" : null;
    stream.next();
    return null;
  },
});

// Named lowercase on purpose: the picker writes the description's name into
// the node's language attr, which serializes as the fence info string —
// ```mermaid is the form other renderers (GitHub & co) understand.
export const mermaidLanguage = LanguageDescription.of({
  name: "mermaid",
  alias: ["mmd"],
  extensions: ["mmd", "mermaid"],
  load: async () => new LanguageSupport(mermaidStream),
});
