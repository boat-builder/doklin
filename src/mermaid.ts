// Mermaid diagram support for ```mermaid code blocks.
//
// Rendering rides Crepe's code-block preview hook (codeBlockConfig.renderPreview)
// as a figure block (figureBlock.ts): it reads as the diagram alone, and the
// Source chip (or moving the caret in) switches to the source alone.
// Editor.tsx wires the hook up; this module owns everything mermaid:
//
//   - loading: mermaid is heavy (~1 MB gz), so it loads on demand, once, the
//     first time a document actually contains a diagram — the npm package as
//     a lazy vite chunk.
//   - theming: no stock mermaid theme — diagrams are drawn in the same
//     grammar as ```svg drawings (mermaidTheme.ts: outline boxes, one accent,
//     the --dg-* tokens), so they read as part of the document in every
//     theme. A theme flip re-renders every live diagram in place (the
//     preview panel only redraws on edits, so this module patches the DOM it
//     produced itself).
//   - pacing: the preview hook fires on every keystroke inside the block. A
//     trailing debounce coalesces bursts, and finished renders are memoized by
//     source text, so re-mounts (Crepe tears code blocks down off-screen) and
//     theme flips stay cheap. Half-typed sources are the normal case while
//     the user writes — they surface as a quiet inline error card, replaced
//     by the diagram the moment the source parses again.
//
// Also exported: a CodeMirror LanguageDescription so "mermaid" shows up in the
// code block's language picker with light syntax highlighting.

import {
  LanguageDescription,
  LanguageSupport,
  StreamLanguage,
} from "@codemirror/language";
import { ensureFigureHooks, figureChips, figureSourceAttr, figureSource } from "./figureBlock";
import { finishMermaidSvg, mermaidConfig } from "./mermaidTheme";

type Mermaid = typeof import("mermaid").default;

/* ---------- Loading ---------- */

let mermaidPromise: Promise<Mermaid> | null = null;

function loadMermaid(): Promise<Mermaid> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((mod: { default: Mermaid }) => mod.default);
    // A chunk that fails to load (a torn-down dev server, a corrupt install)
    // mustn't pin every future render to a rejected promise.
    mermaidPromise.catch(() => {
      mermaidPromise = null;
      initializedEpoch = -1;
    });
  }
  return mermaidPromise;
}

/* ---------- Rendering ---------- */

const RENDER_DEBOUNCE_MS = 200;
const MEMO_MAX = 32;

let renderSeq = 0;
// mermaid.initialize is global state — re-run it when the palette epoch moves
// (theme flip), not per render.
let paletteEpoch = 0;
let initializedEpoch = -1;
// Finished SVGs by source text, valid within one palette epoch. Code blocks
// remount when scrolled back into view, so this makes re-entry instant.
const memo = new Map<string, string>();

function memoSet(source: string, svg: string) {
  if (memo.size >= MEMO_MAX) {
    const oldest = memo.keys().next().value;
    if (oldest !== undefined) memo.delete(oldest);
  }
  memo.set(source, svg);
}

type RenderResult = { ok: true; svg: string } | { ok: false; message: string };

async function renderSource(source: string): Promise<RenderResult> {
  try {
    const mermaid = await loadMermaid();
    if (initializedEpoch !== paletteEpoch) {
      initializedEpoch = paletteEpoch;
      mermaid.initialize(mermaidConfig());
    }
    const { svg } = await mermaid.render(`dk-mermaid-${++renderSeq}`, source);
    return { ok: true, svg: finishMermaidSvg(svg) };
  } catch (err) {
    // Parse errors AND a failed module load both land here — the block shows
    // the quiet card either way, and the next edit retries.
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// The wrapper carries its own source so a theme flip can re-render diagrams
// already in the DOM.
function diagramHtml(source: string, svg: string): string {
  return `<div class="dk-figure dk-mermaid" ${figureSourceAttr(source)}>${svg}${figureChips(true)}</div>`;
}

const ERROR_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;

// Half-written sources are the normal case while typing — the card reads as
// "not yet", not as a failure, and shows just enough of mermaid's message to
// point at the line.
function errorHtml(message: string): string {
  const detail = message.split("\n").slice(0, 4).join("\n").slice(0, 400).trim();
  return `<div class="dk-figure dk-mermaid dk-figure-error">
<div class="dk-figure-error-head">${ERROR_ICON}<span>Diagram doesn’t parse yet</span></div>
${detail ? `<pre class="dk-figure-error-msg">${escapeHtml(detail)}</pre>` : ""}
${figureChips(false)}
</div>`;
}

export const MERMAID_PREVIEW_LOADING = `<div class="dk-figure dk-mermaid dk-figure-loading">Rendering diagram…</div>`;

export function isMermaidLanguage(language: string): boolean {
  const l = language.trim().toLowerCase();
  return l === "mermaid" || l === "mmd";
}

/* ---------- The preview queue ----------
   renderPreview gives us no stable per-block identity, so jobs are plain
   (source, apply) pairs behind one trailing debounce: a typing burst queues
   several revisions of the same block and every one still renders (memo makes
   all but the last cheap-ish), while a document full of diagrams mounting at
   once queues one job per block and each lands in its own panel. Draining is
   sequential — mermaid is a singleton with global config. */

type Apply = (value: string | HTMLElement | null) => void;

let queue: { source: string; apply: Apply }[] = [];
let debounceTimer: number | null = null;
let draining = false;

async function drainQueue() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const jobs = queue;
      queue = [];
      for (const job of jobs) {
        const cached = memo.get(job.source);
        if (cached !== undefined) {
          job.apply(diagramHtml(job.source, cached));
          continue;
        }
        const result = await renderSource(job.source);
        if (result.ok) {
          memoSet(job.source, result.svg);
          job.apply(diagramHtml(job.source, result.svg));
        } else {
          job.apply(errorHtml(result.message));
        }
      }
    }
  } finally {
    draining = false;
  }
}

// The renderPreview hook for mermaid blocks (Editor.tsx chains it in front of
// Crepe's LaTeX/default handlers). Fire-and-forget: the panel shows its
// loading state until the debounced render applies the diagram.
export function queueMermaidPreview(source: string, apply: Apply): void {
  ensureFigureHooks();
  ensureThemeHook();
  queue.push({ source, apply });
  if (debounceTimer !== null) window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => {
    debounceTimer = null;
    void drainQueue();
  }, RENDER_DEBOUNCE_MS);
}

/* ---------- Theme flips ---------- */

let themeHookStarted = false;

// The preview panel only redraws on edits, so a theme change re-renders every
// diagram this module has put in the DOM (the wrapper carries its source).
// Error cards are skipped — same source, same failure, theme-independent.
async function rerenderAll() {
  paletteEpoch += 1;
  memo.clear();
  const nodes = Array.from(
    document.querySelectorAll<HTMLElement>(".dk-mermaid[data-dk-figure-src]"),
  );
  for (const el of nodes) {
    const source = figureSource(el);
    if (!source) continue;
    const result = await renderSource(source);
    // The element may have been replaced while we rendered (an edit landed);
    // only touch it if it's still connected.
    if (result.ok && el.isConnected) {
      memoSet(source, result.svg);
      el.innerHTML = result.svg + figureChips(true);
    }
  }
}

function ensureThemeHook() {
  if (themeHookStarted || typeof window === "undefined") return;
  themeHookStarted = true;
  let scheduled = false;
  const onThemeChange = () => {
    if (scheduled) return;
    scheduled = true;
    // Next frame: let the new CSS custom properties actually apply first.
    requestAnimationFrame(() => {
      scheduled = false;
      void rerenderAll();
    });
  };
  new MutationObserver(onThemeChange).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  // No prefers-color-scheme listener: App.tsx resolves "system" and writes
  // the resolved theme to data-theme, so an OS flip arrives as the attribute
  // change above.
}

/* ---------- Language picker entry ---------- */

// Structural words across the diagram grammars — enough for comments,
// strings, arrows, and keywords to read distinctly; everything else stays
// plain. (Mermaid has no official CodeMirror grammar; this is deliberately
// forgiving.)
const KEYWORDS = new Set([
  "graph", "flowchart", "sequencediagram", "classdiagram", "statediagram",
  "statediagram-v2", "erdiagram", "journey", "gantt", "pie", "mindmap",
  "timeline", "gitgraph", "quadrantchart", "xychart-beta", "block-beta",
  "c4context", "requirementdiagram", "sankey-beta", "packet-beta", "kanban",
  "architecture-beta", "subgraph", "end", "direction", "participant", "actor",
  "activate", "deactivate", "note", "over", "loop", "alt", "else", "opt",
  "par", "and", "critical", "break", "rect", "box", "autonumber", "title",
  "acctitle", "accdescr", "section", "class", "state", "namespace", "click",
  "style", "classdef", "linkstyle", "commit", "branch", "checkout", "merge",
  "cherry-pick", "dateformat", "axisformat", "excludes", "todaymarker",
  "x-axis", "y-axis", "line", "bar", "quadrant-1", "quadrant-2", "quadrant-3",
  "quadrant-4", "tb", "td", "bt", "lr", "rl",
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
    // Edges & arrows: -->, ---, -.->, ==>, --x, --o, ->>, -), <-->, o--o …
    if (stream.match(/^(?:<?[-=.]{2,}[>xo)]?|[xo<][-=.]{2,}>?|-\)|--\)|->>|-->>)/)) {
      return "operator";
    }
    if (stream.match(/^:::?|^[|&]/)) return "operator";
    if (stream.match(/^\d+(?:\.\d+)?%?/)) return "number";
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
