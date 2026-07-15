// Mermaid diagram support for ```mermaid code blocks.
//
// Rendering rides Crepe's code-block preview hook (codeBlockConfig.renderPreview),
// but a diagram block never shows source and diagram stacked: it reads as the
// diagram alone, and the Source button (or moving the caret in) switches to
// the source alone — leaving the block switches back (see queueMermaidPreview
// for the mechanism). Editor.tsx wires the hook up; this module owns
// everything mermaid:
//
//   - loading: mermaid is heavy (~1 MB gz), so it loads on demand, once, the
//     first time a document actually contains a diagram. The desktop app
//     imports the npm package (a lazy vite chunk); the web shell loads the
//     worker-served standalone bundle instead (window.__DK_MERMAID_URL, set by
//     the shell page) so the shell's own bundle stays lean — the
//     import("mermaid") branch is compiled out of the web build entirely
//     (import.meta.env.DK_WEB, see scripts/build-web.mjs).
//   - theming: no stock mermaid theme — the palette is derived at render time
//     from the app's own tokens (mermaidTheme.ts), so diagrams read as part
//     of the document in all four themes. A theme flip re-renders every live
//     diagram in place (the preview panel only redraws on edits, so this
//     module patches the DOM it produced itself).
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
import { bodyFontStack, mermaidThemeVariables } from "./mermaidTheme";

type Mermaid = typeof import("mermaid").default;

declare global {
  interface Window {
    // Set by the share worker's shell page: the URL of the standalone mermaid
    // bundle it serves (see share-worker/src/index.js).
    __DK_MERMAID_URL?: string;
  }
}

/* ---------- Loading ---------- */

let mermaidPromise: Promise<Mermaid> | null = null;

function loadMermaid(): Promise<Mermaid> {
  if (!mermaidPromise) {
    const url = typeof window !== "undefined" ? window.__DK_MERMAID_URL : undefined;
    // The web build compiles the import("mermaid") arm away (DK_WEB is
    // defined true there) so the npm package never lands in the shell
    // bundle; the worker serves it as its own cached asset instead.
    mermaidPromise = (
      import.meta.env.DK_WEB || url
        ? import(/* @vite-ignore */ url ?? "mermaid")
        : import("mermaid")
    ).then((mod: { default: Mermaid }) => mod.default);
    // On the web the module arrives over the network — don't let one failed
    // fetch pin every future render to a rejected promise.
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
      mermaid.initialize({
        startOnLoad: false,
        // Shared documents can carry anyone's markdown — keep label sanitizing
        // on and interactions off (mermaid also runs its own DOMPurify pass).
        securityLevel: "strict",
        suppressErrorRendering: true,
        theme: "base",
        themeVariables: mermaidThemeVariables(),
        fontFamily: bodyFontStack(),
      });
    }
    const { svg } = await mermaid.render(`dk-mermaid-${++renderSeq}`, source);
    return { ok: true, svg };
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

// The switcher into source view (see the "two states" note at
// queueMermaidPreview): rides inside the wrapper because that's the DOM this
// module owns. DOMPurify passes it through; behavior comes from the delegated
// click handler in ensureDomHooks, never from inline attributes.
const SOURCE_BUTTON = `<button class="dk-mermaid-edit" type="button" title="Edit diagram source">
<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
Source</button>`;

// The wrapper carries its own source (URI-encoded — attribute-safe and
// newline-proof) so a theme flip can re-render diagrams already in the DOM.
function diagramHtml(source: string, svg: string): string {
  return `<div class="dk-mermaid" data-dk-mermaid-src="${encodeURIComponent(source)}">${svg}${SOURCE_BUTTON}</div>`;
}

const ERROR_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;

// Half-written sources are the normal case while typing — the card reads as
// "not yet", not as a failure, and shows just enough of mermaid's message to
// point at the line.
function errorHtml(message: string): string {
  const detail = message.split("\n").slice(0, 4).join("\n").slice(0, 400).trim();
  return `<div class="dk-mermaid dk-mermaid-error">
<div class="dk-mermaid-error-head">${ERROR_ICON}<span>Diagram doesn’t parse yet</span></div>
${detail ? `<pre class="dk-mermaid-error-msg">${escapeHtml(detail)}</pre>` : ""}
${SOURCE_BUTTON}
</div>`;
}

export const MERMAID_PREVIEW_LOADING = `<div class="dk-mermaid dk-mermaid-loading">Rendering diagram…</div>`;

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
//
// A diagram block shows ONE thing at a time — never source and diagram
// stacked. Reading state (nothing in the block focused) is the diagram alone;
// the Source button (or arrowing the caret in) switches to the source alone,
// and leaving the block switches back. The states are CSS (App.css, keyed on
// :focus-within plus the .dk-mermaid-editing bridge class) — the hooks in
// ensureDomHooks only manage that class, since a display:none editor can't
// receive the focus that would otherwise reveal it.
export function queueMermaidPreview(source: string, apply: Apply): void {
  ensureDomHooks();
  queue.push({ source, apply });
  if (debounceTimer !== null) window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => {
    debounceTimer = null;
    void drainQueue();
  }, RENDER_DEBOUNCE_MS);
}

/* ---------- Document-level hooks (theme flips, the source switch) ---------- */

let domHooksStarted = false;

// The preview panel only redraws on edits, so a theme change re-renders every
// diagram this module has put in the DOM (the wrapper carries its source).
// Error cards are skipped — same source, same failure, theme-independent.
async function rerenderAll() {
  paletteEpoch += 1;
  memo.clear();
  const nodes = Array.from(
    document.querySelectorAll<HTMLElement>(".dk-mermaid[data-dk-mermaid-src]"),
  );
  for (const el of nodes) {
    const encoded = el.getAttribute("data-dk-mermaid-src");
    if (!encoded) continue;
    let source: string;
    try {
      source = decodeURIComponent(encoded);
    } catch {
      continue;
    }
    const result = await renderSource(source);
    // The element may have been replaced while we rendered (an edit landed);
    // only touch it if it's still connected.
    if (result.ok && el.isConnected) {
      memoSet(source, result.svg);
      el.innerHTML = result.svg + SOURCE_BUTTON;
    }
  }
}

function ensureDomHooks() {
  if (domHooksStarted || typeof window === "undefined") return;
  domHooksStarted = true;

  /* Theme flips. */
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
  // "system" theme (and the web shell, which sets no data-theme) follows the
  // OS — a live OS appearance change moves the palette without touching DOM.
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", onThemeChange);

  /* The diagram ⇄ source switch (see queueMermaidPreview). Delegated: the
     buttons are innerHTML'd through a sanitizer, so they carry no handlers of
     their own, and blocks come and go as Crepe mounts/tears code blocks. */
  // The chip must not TAKE focus on mousedown: it sits inside the block, so
  // focusing it flips :focus-within — the source view opens (hiding the chip)
  // between mousedown and mouseup and the click never lands.
  document.addEventListener("mousedown", (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest(".dk-mermaid-edit")) e.preventDefault();
  });
  document.addEventListener("click", (e) => {
    const target = e.target instanceof Element ? e.target : null;
    // Sweep first: an editing block that neither took this click nor holds
    // focus flips back to its diagram. This also cleans up the rare stray
    // class left when a focused block was torn down (no focusout fires then).
    for (const block of document.querySelectorAll(".milkdown-code-block.dk-mermaid-editing")) {
      if (!(target && block.contains(target)) && !block.contains(document.activeElement)) {
        block.classList.remove("dk-mermaid-editing");
      }
    }
    const button = target?.closest(".dk-mermaid-edit");
    const block = button?.closest(".milkdown-code-block");
    if (!block) return;
    block.classList.add("dk-mermaid-editing");
    // Focus must come AFTER the class reveals the editor — a display:none
    // CodeMirror can't take it. (Read-only sessions: the focus may not stick,
    // but the class keeps the source open until a click lands elsewhere.)
    block.querySelector<HTMLElement>(".cm-content")?.focus();
  });
  // Tab-away and other non-click focus moves also close the source view.
  document.addEventListener("focusout", (e) => {
    const from = e.target instanceof Element ? e.target : null;
    const block = from?.closest(".milkdown-code-block.dk-mermaid-editing");
    if (!block) return;
    // Let the new focus target settle before deciding.
    window.setTimeout(() => {
      if (!block.contains(document.activeElement)) block.classList.remove("dk-mermaid-editing");
    }, 0);
  });
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
