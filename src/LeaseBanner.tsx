// The view-only banner over a document another Mac holds.
// The lease is advisory: the editor goes read-only because someone else
// has the document open, never because a write would be refused — so *Take
// over* is one click, and what both of you typed in the moment it takes
// merges as any overlap does.

import { useEffect, useState } from "react";
import { leaseLine, type LeaseHolder } from "./cloud";

export function LeaseBanner({ lease, onTakeOver }: { lease: LeaseHolder; onTakeOver: () => void }) {
  // Between the click and the status that says the lease moved: one beat,
  // usually well under a second. A new holder is a new question.
  const [taking, setTaking] = useState(false);
  useEffect(() => setTaking(false), [lease.deviceId, lease.path]);
  return (
    <div className="version-banner lease-banner" data-testid="lease-banner" role="status">
      <span className="version-banner-text" data-testid="lease-banner-text">
        {leaseLine(lease)}
      </span>
      <span className="version-banner-actions">
        <button
          className="version-banner-btn"
          data-testid="lease-take-over"
          disabled={taking}
          title={
            lease.own
              ? "Edit here instead — the other Mac goes view-only"
              : `Edit here instead — ${lease.name}'s copy goes view-only`
          }
          onClick={() => {
            setTaking(true);
            onTakeOver();
          }}
        >
          {taking ? "Taking over…" : "Take over"}
        </button>
      </span>
    </div>
  );
}
