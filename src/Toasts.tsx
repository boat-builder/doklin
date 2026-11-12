// Transient notices, stacked bottom-right: a cloud merge that left a
// conflict copy ("Open the copy"), a mass deletion the engine is holding
// ("Review…"), a restored version, a publish stopped from the sidebar
// ("Undo"), and errors from any of them. A notice with an action stays until
// it is used or dismissed; a plain one fades on its own.
//
// Each carries a tone from the one status vocabulary (src/cloud.ts): green
// when something is done, amber when it waits on you, red when it failed,
// and no mark for plain news.

import { useEffect } from "react";

export type ToastTone = "info" | "done" | "warn" | "error";

export type Toast = {
  id: number;
  tone: ToastTone;
  text: string;
  action?: { label: string; run: () => void };
};

const PLAIN_TOAST_MS = 9000;

function ToneMark({ tone }: { tone: ToastTone }) {
  if (tone === "info") return null;
  return (
    <span className={`toast-mark is-${tone}`} aria-hidden>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        {tone === "done" ? (
          <>
            <circle cx="8" cy="8" r="6.25" />
            <path d="M5.4 8.2l1.8 1.8 3.4-3.7" />
          </>
        ) : tone === "warn" ? (
          <>
            <path d="M8 2.2l6.2 11H1.8z" />
            <path d="M8 6.6v3M8 11.5v.1" />
          </>
        ) : (
          <>
            <circle cx="8" cy="8" r="6.25" />
            <path d="M8 4.8v3.8M8 11v.1" />
          </>
        )}
      </svg>
    </span>
  );
}

export default function Toasts({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  // Plain notices leave on their own; the timer belongs to the newest set.
  useEffect(() => {
    const plain = toasts.filter((t) => !t.action);
    if (plain.length === 0) return;
    const timers = plain.map((t) => window.setTimeout(() => onDismiss(t.id), PLAIN_TOAST_MS));
    return () => timers.forEach((h) => window.clearTimeout(h));
  }, [toasts, onDismiss]);

  if (toasts.length === 0) return null;
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast is-${t.tone}`} role="status">
          <ToneMark tone={t.tone} />
          <span className="toast-text">{t.text}</span>
          {t.action && (
            <button
              className="toast-btn"
              onClick={() => {
                t.action?.run();
                onDismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="toast-close" onClick={() => onDismiss(t.id)} aria-label="Dismiss">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden>
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
