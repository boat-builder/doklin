// A zoomable / pannable canvas for a single mermaid diagram.
//
// A rendered diagram in the doc is a self-contained <svg> (mermaid inlines its
// own styles), so the "expand" chip on a diagram (src/mermaid.ts) hands us that
// SVG's outerHTML through a `dk-mermaid-expand` CustomEvent; App mounts this
// full-screen canvas with it. No pan/zoom library — the diagram is one node, so
// a transform on its wrapper (wheel-zoom toward the cursor, drag to pan) is all
// it takes.

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
  // The injected SVG's intrinsic size, so zoom math and re-fit are stable.
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
    // Shrink big diagrams to fit; don't blow small ones up past 2×.
    const scale = clampScale(Math.min(raw, 2));
    setT({ scale, x: (rect.width - w * scale) / 2, y: (rect.height - h * scale) / 2 });
  }, []);

  // Pin the injected SVG to its intrinsic size so a CSS transform on the wrapper
  // scales it predictably, record that size, then fit it to the stage. Runs
  // before paint, so the diagram never flashes at the top-left corner first.
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
    }
    nat.current = { w, h };
    svgEl.style.width = `${w}px`;
    svgEl.style.height = `${h}px`;
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
        // Keep the point under the cursor fixed while scaling.
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
          style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.scale})` }}
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
