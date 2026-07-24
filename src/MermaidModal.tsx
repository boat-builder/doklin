// A zoomable / pannable canvas for a single mermaid diagram.
//
// A rendered diagram in the doc is a self-contained <svg> (mermaid inlines its
// own styles), so the "expand" chip on a diagram (src/mermaid.ts) hands us that
// SVG's outerHTML through a `dk-mermaid-expand` CustomEvent; App mounts this
// full-screen canvas with it. No pan/zoom library — the diagram is one node,
// so wheel-zoom toward the cursor and drag-to-pan are hand-rolled.
//
// HOW THE ZOOM WORKS (and why not transform: scale): zooming resizes the
// wrapper's layout box (nat × scale) with the SVG filling it at 100%/100%, and
// the CSS transform only ever *translates*. A scale() transform would be the
// obvious move, but WKWebView rasterizes the composited layer once at its
// current scale and stretches that bitmap — zoom in and the diagram is an
// unreadable blur, and the on-screen size can drift from what the fit math
// assumed. A layout resize re-renders the vectors (foreignObject labels
// included) at the displayed size, so every zoom level is crisp; translation
// reuses the raster as-is, so panning stays cheap.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as RPointerEvent,
} from "react";
import { createPortal } from "react-dom";

type Transform = { scale: number; x: number; y: number };

const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
// Canvas dot-grid spacing (px at 100%); the grid tracks the pan/zoom so the
// surface reads as one movable plane, not a fixed backdrop.
const GRID = 22;

function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

const CloseIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
    <line x1="5" y1="5" x2="19" y2="19" />
    <line x1="19" y1="5" x2="5" y2="19" />
  </svg>
);

export default function MermaidModal({ svg, onClose }: { svg: string; onClose: () => void }) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  // The diagram's intrinsic size (viewBox units — CSS px at 100%). A ref read
  // during render (for the wrapper's layout size), which is safe here: it only
  // moves in the layout effect below, which always schedules the re-render
  // that reads it (fit → setT).
  const nat = useRef({ w: 0, h: 0 });
  const drag = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);
  const [t, setT] = useState<Transform>({ scale: 1, x: 0, y: 0 });

  const fit = useCallback(() => {
    const stage = stageRef.current;
    const { w, h } = nat.current;
    if (!stage || !w || !h) return;
    const rect = stage.getBoundingClientRect();
    const pad = 56;
    const raw = Math.min((rect.width - pad * 2) / w, (rect.height - pad * 2) / h);
    // Shrink big diagrams to fit the stage; open small ones at 100%, never
    // blown up.
    const scale = clampScale(Math.min(raw, 1));
    setT({ scale, x: (rect.width - w * scale) / 2, y: (rect.height - h * scale) / 2 });
  }, []);

  // Measure the diagram, make the SVG fill its wrapper (the wrapper's layout
  // size is what zooms — see the header comment), then fit it to the stage.
  // Runs before paint, so the diagram never flashes at the top-left first.
  useLayoutEffect(() => {
    const svgEl = contentRef.current?.querySelector<SVGSVGElement>("svg");
    if (!svgEl) return;
    const vb = svgEl.viewBox?.baseVal;
    let w = vb && vb.width ? vb.width : 0;
    let h = vb && vb.height ? vb.height : 0;
    if (!w || !h) {
      const r = svgEl.getBoundingClientRect();
      w = r.width;
      h = r.height;
      // The wrapper-box zoom needs a viewBox to scale the drawing into.
      if (w && h) svgEl.setAttribute("viewBox", `0 0 ${w} ${h}`);
    }
    nat.current = { w, h };
    // Inline, so it beats mermaid's own inline max-width. The wrapper box and
    // the viewBox share an aspect ratio by construction, so 100%/100% maps the
    // drawing exactly — no letterboxing.
    svgEl.style.width = "100%";
    svgEl.style.height = "100%";
    svgEl.style.maxWidth = "none";
    fit();
  }, [svg, fit]);

  // Esc closes. Capture phase on window so it runs before (and alongside) the
  // app's own capture-phase key handlers — matching where they register keeps a
  // sibling listener firing even if one of them calls stopPropagation — and
  // stopPropagation here keeps a lower handler from also acting on the same Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // Wheel zoom toward the cursor. Native + non-passive so preventDefault sticks
  // (React's synthetic wheel listener is passive and would let the page scroll).
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = stage.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      setT((prev) => {
        const next = clampScale(prev.scale * Math.exp(-e.deltaY * 0.0015));
        const k = next / prev.scale;
        // Keep the point under the cursor fixed while scaling. The wrapper
        // grows from its top-left corner, so the same origin math as a
        // transform-origin 0 0 scale applies.
        return { scale: next, x: cx - (cx - prev.x) * k, y: cy - (cy - prev.y) * k };
      });
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const onResize = () => fit();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [fit]);

  // Zoom the button controls around the stage center.
  const zoomAround = useCallback((factor: number) => {
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    setT((prev) => {
      const next = clampScale(prev.scale * factor);
      const k = next / prev.scale;
      return { scale: next, x: cx - (cx - prev.x) * k, y: cy - (cy - prev.y) * k };
    });
  }, []);

  const onPointerDown = (e: RPointerEvent) => {
    if (e.button !== 0) return;
    drag.current = { px: e.clientX, py: e.clientY, ox: t.x, oy: t.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    setT((prev) => ({ ...prev, x: d.ox + dx, y: d.oy + dy }));
  };
  const endDrag = (e: RPointerEvent) => {
    drag.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  return createPortal(
    <div className="dk-zoom-overlay" role="dialog" aria-modal="true" aria-label="Diagram viewer">
      <div
        ref={stageRef}
        className="dk-zoom-stage"
        style={{
          backgroundSize: `${GRID * t.scale}px ${GRID * t.scale}px`,
          backgroundPosition: `${t.x}px ${t.y}px`,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={fit}
      >
        <div
          ref={contentRef}
          className="dk-zoom-content"
          style={{
            width: `${nat.current.w * t.scale}px`,
            height: `${nat.current.h * t.scale}px`,
            transform: `translate(${t.x}px, ${t.y}px)`,
          }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
      <div className="dk-zoom-toolbar">
        <button className="dk-zoom-btn" onClick={() => zoomAround(1 / 1.2)} title="Zoom out" aria-label="Zoom out">
          −
        </button>
        <button className="dk-zoom-pct" onClick={fit} title="Reset — fit to screen">
          {Math.round(t.scale * 100)}%
        </button>
        <button className="dk-zoom-btn" onClick={() => zoomAround(1.2)} title="Zoom in" aria-label="Zoom in">
          +
        </button>
        <span className="dk-zoom-sep" />
        <button className="dk-zoom-btn dk-zoom-close" onClick={onClose} title="Close (Esc)" aria-label="Close">
          {CloseIcon}
        </button>
      </div>
      <div className="dk-zoom-hint">Scroll to zoom · drag to pan · double-click to fit</div>
    </div>,
    document.body,
  );
}
