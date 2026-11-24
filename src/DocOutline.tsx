// The outline of a long note ("On this page"), as Notion shows one: short
// lines at the pane's edge, one per heading, the line of the section being
// read in the text colour. Hovering (or tabbing into it) opens a card with
// the headings' names; a click scrolls there.
//
// Entries are the note's top-level H1–H3 — minus a leading H1, which is the
// note's title — read off the editor's DOM, and the outline shows once there
// are two. It sits at the pane's right edge, or at its left while the
// comments rail holds the right; with no room either side (a narrow pane)
// it isn't shown.
//
// Fixed to the window at the pane's measured box, so it stays put while the
// note scrolls with no work per frame. Editor.tsx renders it inside the
// pane's .editor-wrap (App.css hides it in the html view and behind a
// version preview) and re-measures it on the comment rail's tick: every
// editor update, a resize, a comment layer change.
//
// The card is a hover surface, not a layer: nothing to put away, so it has
// no useDismiss.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EditorView } from "@milkdown/kit/prose/view";

type Entry = { el: HTMLElement; depth: number; title: string };
type Place = { side: "right" | "left"; top: number; x: number; maxHeight: number };

/** Room the lines need beside the text, in px. */
const NEEDS = 48;
/** The nav's distance from the pane's top and edge. */
const TOP = 96;
const EDGE = 16;
/** A clicked heading lands this far below the pane's top. */
const LAND = 24;

// Read off the document, not the DOM: the editor's DOM also holds Crepe's
// widgets (the block handle sits first among the children).
function readEntries(view: EditorView): Entry[] {
  const heads: { el: HTMLElement; level: number; title: string }[] = [];
  view.state.doc.forEach((node, offset, index) => {
    if (node.type.name !== "heading") return;
    const level = Number(node.attrs.level);
    if (level > 3 || (index === 0 && level === 1)) return;
    const el = view.nodeDOM(offset);
    if (!(el instanceof HTMLElement)) return;
    heads.push({ el, level, title: node.textContent.replace(/\s+/g, " ").trim() || "Untitled" });
  });
  if (heads.length < 2) return [];
  const top = Math.min(...heads.map((h) => h.level));
  return heads.map((h) => ({ el: h.el, depth: h.level - top, title: h.title }));
}

function measure(view: EditorView, wrap: HTMLElement): Place | null {
  const pm = view.dom;
  const wr = wrap.getBoundingClientRect();
  const pr = pm.getBoundingClientRect();
  if (wr.width === 0 || wr.height === 0) return null;
  const cs = getComputedStyle(pm);
  const innerRight = wr.left + wrap.clientWidth; // left of the scrollbar
  const textRight = pr.right - parseFloat(cs.paddingRight);
  const railShowing = wrap.classList.contains("has-comments") && !wrap.classList.contains("comments-off");
  const maxHeight = Math.max(160, wr.height - TOP - 48);
  if (!railShowing && innerRight - textRight >= NEEDS) {
    return { side: "right", top: wr.top + TOP, x: window.innerWidth - innerRight + EDGE, maxHeight };
  }
  // Left: only outside the editor's own box — its left padding holds
  // Crepe's block handle.
  if (pr.left - wr.left >= NEEDS - EDGE + 8) {
    return { side: "left", top: wr.top + TOP, x: wr.left + EDGE, maxHeight };
  }
  return null;
}

export default function DocOutline({ getView, tick }: { getView: () => EditorView | null; tick: number }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [place, setPlace] = useState<Place | null>(null);
  const [current, setCurrent] = useState(-1);
  const entriesRef = useRef<Entry[]>([]);
  entriesRef.current = entries;
  const wrapRef = useRef<HTMLElement | null>(null);
  const spyRaf = useRef<number | null>(null);

  // Which section is being read: the last heading above a line 30% down
  // the pane; the last one once the note is scrolled to its end.
  const spy = useCallback(() => {
    spyRaf.current = null;
    const wrap = wrapRef.current;
    const list = entriesRef.current;
    if (!wrap || list.length === 0) return;
    const wr = wrap.getBoundingClientRect();
    if (wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 2) {
      setCurrent(list.length - 1);
      return;
    }
    const probe = wr.top + wr.height * 0.3;
    let at = -1;
    for (let i = 0; i < list.length; i++) {
      if (list[i].el.getBoundingClientRect().top <= probe) at = i;
      else break;
    }
    setCurrent(at);
  }, []);

  // Re-read and re-measure on every tick of the editor.
  useLayoutEffect(() => {
    const view = getView();
    const wrap = (view?.dom.closest(".editor-wrap") as HTMLElement | null) ?? null;
    wrapRef.current = wrap;
    if (!view || !wrap) {
      setEntries([]);
      return;
    }
    const next = readEntries(view);
    setEntries(next);
    entriesRef.current = next;
    setPlace(next.length ? measure(view, wrap) : null);
    spy();
  }, [getView, tick, spy]);

  // Follow the reader through the note.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || entries.length === 0) return;
    // A frame's worth of scrolling at a time; a timeout while the window is
    // hidden, where no frame comes (as the comment rail's tick does).
    const onScroll = () => {
      if (spyRaf.current != null) return;
      spyRaf.current = document.hidden ? window.setTimeout(spy, 32) : requestAnimationFrame(spy);
    };
    wrap.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      wrap.removeEventListener("scroll", onScroll);
      if (spyRaf.current != null) {
        cancelAnimationFrame(spyRaf.current);
        clearTimeout(spyRaf.current);
      }
      spyRaf.current = null;
    };
  }, [entries.length, spy]);

  const go = (i: number) => {
    const wrap = wrapRef.current;
    const el = entriesRef.current[i]?.el;
    if (!wrap || !el) return;
    const delta = el.getBoundingClientRect().top - wrap.getBoundingClientRect().top - LAND;
    wrap.scrollTo({ top: wrap.scrollTop + delta, behavior: "smooth" });
    setCurrent(i);
  };

  if (!place || entries.length === 0) return null;
  const style =
    place.side === "right"
      ? { top: place.top, right: place.x, maxHeight: place.maxHeight }
      : { top: place.top, left: place.x, maxHeight: place.maxHeight };
  return (
    <nav className={`doc-outline is-${place.side}`} style={style} aria-label="On this page">
      <div className="doc-outline-lines" aria-hidden="true">
        {entries.map((e, i) => (
          <span key={i} className={`doc-outline-line depth-${e.depth} ${i === current ? "is-current" : ""}`} />
        ))}
      </div>
      <div className="doc-outline-card" style={{ maxHeight: place.maxHeight }}>
        <div className="doc-outline-head">On this page</div>
        {entries.map((e, i) => (
          <button
            key={i}
            type="button"
            className={`doc-outline-item depth-${e.depth} ${i === current ? "is-current" : ""}`}
            aria-current={i === current ? "location" : undefined}
            onClick={() => go(i)}
          >
            {e.title}
          </button>
        ))}
      </div>
    </nav>
  );
}
