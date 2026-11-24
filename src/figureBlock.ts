// A figure block: a fenced code block that reads as the picture it draws —
// ```mermaid flowcharts (flowchartBlock.ts) and ```svg drawings (drawing.ts). Both ride Crepe's
// code-block preview hook; this module owns what they share:
//
//   - the two chips a rendered figure carries: Source (switch to the source
//     text) and Expand (the full-screen zoom/pan canvas, FigureZoom);
//   - the two-state switch. A figure block never shows source and picture
//     stacked: reading (nothing in the block focused) is the picture alone;
//     the Source chip, or arrowing the caret in, shows the source alone, and
//     leaving the block switches back. The states are CSS (App.css, keyed on
//     :focus-within plus the .dk-figure-editing bridge class); the hooks here
//     only manage that class, because a display:none editor can't receive
//     the focus that would otherwise reveal it.
//
// A renderer wraps its picture as `<div class="dk-figure …">` + figureChips().

// The switcher into source view. Rides inside the wrapper because that's the
// DOM the renderer owns. Crepe's preview sanitizer passes it through; behavior
// comes from the delegated click handler in ensureFigureHooks, never from
// inline attributes.
const SOURCE_BUTTON = `<button class="dk-figure-source" type="button" title="Edit source">
<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
Source</button>`;

// Opens the figure in the zoom/pan canvas. Rides the top-left corner (Source
// sits top-right) so the two never collide. Only a rendered picture carries
// it — an unparsed source has nothing to zoom, so error cards omit it.
const EXPAND_BUTTON = `<button class="dk-figure-expand" type="button" title="Open in zoom view">
<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
</button>`;

/** The chips after a picture: Expand (when there is one to zoom) and Source. */
export function figureChips(expandable: boolean): string {
  return (expandable ? EXPAND_BUTTON : "") + SOURCE_BUTTON;
}

/** The event the Expand chip sends; App mounts FigureZoom on it. */
export const FIGURE_EXPAND_EVENT = "dk-figure-expand";
export type FigureExpandDetail = { svg: string; source: string };

let hooksStarted = false;

export function ensureFigureHooks(): void {
  if (hooksStarted || typeof window === "undefined") return;
  hooksStarted = true;

  // A chip must not TAKE focus on mousedown: it sits inside the block, so
  // focusing it flips :focus-within — the source view opens (hiding the
  // chip) between mousedown and mouseup and the click never lands.
  document.addEventListener("mousedown", (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest(".dk-figure-source, .dk-figure-expand")) e.preventDefault();
  });

  // Delegated: the chips are innerHTML'd through a sanitizer, so they carry
  // no handlers of their own, and blocks come and go as Crepe mounts them.
  document.addEventListener("click", (e) => {
    const target = e.target instanceof Element ? e.target : null;
    // Sweep first: an editing block that neither took this click nor holds
    // focus flips back to its picture. This also cleans up the rare stray
    // class left when a focused block was torn down (no focusout fires then).
    for (const block of document.querySelectorAll(".milkdown-code-block.dk-figure-editing")) {
      if (!(target && block.contains(target)) && !block.contains(document.activeElement)) {
        block.classList.remove("dk-figure-editing");
      }
    }

    // Expand: hand the rendered SVG (and the block's source) to App's
    // FigureZoom. The SVG is self-contained, so the modal needs nothing
    // more to draw the zoom/pan canvas.
    const expand = target?.closest(".dk-figure-expand");
    if (expand) {
      const wrapper = expand.closest(".dk-figure");
      const svg = wrapper?.querySelector("svg");
      if (svg) {
        const detail: FigureExpandDetail = { svg: svg.outerHTML, source: figureSource(wrapper) };
        window.dispatchEvent(new CustomEvent(FIGURE_EXPAND_EVENT, { detail }));
      }
      return;
    }

    const button = target?.closest(".dk-figure-source");
    const block = button?.closest(".milkdown-code-block");
    if (!block) return;
    block.classList.add("dk-figure-editing");
    // Focus must come AFTER the class reveals the editor — a display:none
    // CodeMirror can't take it. (Read-only sessions: the focus may not stick,
    // but the class keeps the source open until a click lands elsewhere.)
    block.querySelector<HTMLElement>(".cm-content")?.focus();
  });

  // Tab-away and other non-click focus moves also close the source view.
  document.addEventListener("focusout", (e) => {
    const from = e.target instanceof Element ? e.target : null;
    const block = from?.closest(".milkdown-code-block.dk-figure-editing");
    if (!block) return;
    // Let the new focus target settle before deciding.
    window.setTimeout(() => {
      if (!block.contains(document.activeElement)) block.classList.remove("dk-figure-editing");
    }, 0);
  });
}

// The wrapper carries its source URI-encoded (attribute-safe, newline-proof)
// in data-dk-figure-src, so a relayout (flowchartBlock.ts) and the zoom view
// can read it back.
export function figureSourceAttr(source: string): string {
  return `data-dk-figure-src="${encodeURIComponent(source)}"`;
}

export function figureSource(wrapper: Element | null | undefined): string {
  const encoded = wrapper?.getAttribute("data-dk-figure-src");
  if (!encoded) return "";
  try {
    return decodeURIComponent(encoded);
  } catch {
    return "";
  }
}
