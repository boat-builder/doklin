// Who is in the workspace, and its agents — the workspace menu's *People…*
// and *Agents…*. A window of its own rather than a view of the Cloud panel:
// who is here is the workspace's business, not sync's. The body is
// CloudPeople, one tab each.

import { useCallback, useEffect, useState } from "react";
import { mayOn, type CloudStatus } from "./cloud";
import CloudPeople, { type AccessTab } from "./CloudPeople";

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
      <line x1="5" y1="5" x2="19" y2="19" />
      <line x1="19" y1="5" x2="5" y2="19" />
    </svg>
  );
}

export default function PeopleDialog({
  cloud,
  tab,
  onTab,
  onClose,
}: {
  cloud: CloudStatus;
  tab: AccessTab;
  onTab: (tab: AccessTab) => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copy = useCallback(async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1600);
    } catch {
      /* selectable text — copy by hand */
    }
  }, []);

  const title = mayOn(cloud, "agents.manage") ? "People and agents" : "People";
  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal cloud-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <div className="modal-title">{title}</div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="cloud-body">
          <CloudPeople
            root={cloud.root}
            name={cloud.name}
            domain={cloud.domain}
            tab={tab}
            onTab={onTab}
            copy={(k, t) => void copy(k, t)}
            copied={copied}
          />
        </div>
      </div>
    </div>
  );
}
