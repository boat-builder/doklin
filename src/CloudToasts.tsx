// Transient notices from the cloud (docs/cloud-redesign.md §7.2): a merge
// that left a conflict copy ("Open the copy"), a mass deletion the engine is
// holding ("Review…"). Stacked bottom-right; a notice with an action stays
// until it is used or dismissed, a plain one fades on its own.

import { useEffect } from "react";

export type CloudToast = {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
};

const PLAIN_TOAST_MS = 9000;

export default function CloudToasts({
  toasts,
  onDismiss,
}: {
  toasts: CloudToast[];
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
    <div className="cloud-toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="cloud-toast" role="status">
          <span className="cloud-toast-text">{t.text}</span>
          {t.action && (
            <button
              className="cloud-toast-btn"
              onClick={() => {
                t.action?.run();
                onDismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="cloud-toast-close" onClick={() => onDismiss(t.id)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
