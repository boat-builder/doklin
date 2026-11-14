// What Esc and a click elsewhere put away.
//
// Everything the app lays over itself — the modals, the card peek, the
// publish card, the diagram viewer, popovers and menus — registers here while
// it is open, and only the TOP one answers: one Esc, one press elsewhere, one
// layer. So Esc in a property menu inside the card peek closes the menu and
// leaves the peek, and a modal opened over the history preview goes before
// the preview does. Each layer also has a close button (a menu's items are
// its own way out).
//
// An Esc something already answered arrives defaultPrevented and is left
// alone: an inline rename cancelling, a find field closing, a code block
// dropping its selection. A control inside a layer that takes Esc for itself
// calls preventDefault (or stops the event), and the layer stays.
//
// "Elsewhere" is a pointerdown outside the layer's element, caught on the
// window in the capture phase — ahead of every handler under the pointer, so
// a press that opens a new layer is never taken as a press outside it. A
// layer whose trigger toggles it passes an element holding the trigger too,
// or the press on the trigger would close it and the click reopen it. A layer
// with no element (a full-window viewer) has no outside.
//
// Presses inside a sandboxed frame never reach this window; the frame's
// bridge reports them and HtmlView hands them to `pressedOutside`.

import { useEffect, useRef, type RefObject } from "react";

export type DismissHow = "escape" | "outside";

type Layer = {
  dismiss: RefObject<(how: DismissHow) => void>;
  el: RefObject<HTMLElement | null> | null;
};

const layers: Layer[] = [];

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
  const top = layers[layers.length - 1];
  if (!top) return;
  e.preventDefault();
  top.dismiss.current("escape");
}

function onPointerDown(e: PointerEvent) {
  const top = layers[layers.length - 1];
  const el = top?.el?.current;
  if (!top || !el || el.contains(e.target as Node)) return;
  top.dismiss.current("outside");
}

/** A press somewhere the app can't see into: outside every layer. */
export function pressedOutside() {
  const top = layers[layers.length - 1];
  if (top?.el) top.dismiss.current("outside");
}

/**
 * Register a layer while `open`. `dismiss` runs when Esc or a press outside
 * `el` puts the layer away; it may refuse (mid-operation) or, on Esc, step
 * back inside the layer instead of closing it.
 */
export function useDismiss(
  dismiss: (how: DismissHow) => void,
  el: RefObject<HTMLElement | null> | null = null,
  open = true,
) {
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  useEffect(() => {
    if (!open) return;
    const layer: Layer = { dismiss: dismissRef, el };
    if (layers.length === 0) {
      window.addEventListener("keydown", onKeyDown);
      window.addEventListener("pointerdown", onPointerDown, true);
    }
    layers.push(layer);
    return () => {
      layers.splice(layers.indexOf(layer), 1);
      if (layers.length === 0) {
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("pointerdown", onPointerDown, true);
      }
    };
  }, [open, el]);
}
