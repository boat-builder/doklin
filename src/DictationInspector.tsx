// Dictation Inspector — opt-in introspection for the polish pass (Settings →
// Dictation → inspector). A floating panel, entirely separate from the normal
// UI: regular users never see it. Newest first; each entry expands to the
// exact prompt sent to the model, its raw response, the guard decision, and
// the rolling summary that rode along.

import { useState } from "react";
import type { InspectorEntry } from "./dictation";

const DETAIL_ORDER = [
  "decision",
  "raw",
  "corrected",
  "modelRaw",
  "summaryUsed",
  "summary",
  "prompt",
  "sidecarMs",
  "ok",
] as const;

export default function DictationInspector({
  entries,
  onClear,
  onClose,
}: {
  entries: InspectorEntry[];
  onClear: () => void;
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <div className="dictation-inspector" role="log" aria-label="Dictation inspector">
      <div className="dictation-inspector-head">
        <span className="dictation-inspector-title">Dictation inspector</span>
        <button className="dictation-inspector-btn" onClick={onClear}>
          Clear
        </button>
        <button className="dictation-inspector-btn" onClick={onClose} aria-label="Close inspector">
          ✕
        </button>
      </div>
      <div className="dictation-inspector-body">
        {entries.length === 0 && (
          <div className="dictation-inspector-empty">
            Waiting for dictation activity… every polish call will show its full
            prompt, model response, and guard decision here.
          </div>
        )}
        {entries.map((e, i) => {
          const open = expanded === i;
          const hasDetail = e.detail && Object.keys(e.detail).length > 0;
          return (
            <div key={`${e.ts}-${i}`} className={`dictation-inspector-entry kind-${e.kind}`}>
              <button
                className="dictation-inspector-row"
                onClick={() => hasDetail && setExpanded(open ? null : i)}
              >
                <span className="dictation-inspector-time">
                  {new Date(e.ts).toLocaleTimeString(undefined, { hour12: false })}
                </span>
                <span className="dictation-inspector-label">{e.title}</span>
                {hasDetail && <span className="dictation-inspector-caret">{open ? "▾" : "▸"}</span>}
              </button>
              {open && hasDetail && (
                <div className="dictation-inspector-detail">
                  {DETAIL_ORDER.filter((k) => e.detail![k] != null && e.detail![k] !== "").map(
                    (k) => (
                      <div key={k}>
                        <div className="dictation-inspector-key">{k}</div>
                        <pre className="dictation-inspector-pre">
                          {typeof e.detail![k] === "string"
                            ? (e.detail![k] as string)
                            : JSON.stringify(e.detail![k], null, 1)}
                        </pre>
                      </div>
                    ),
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
