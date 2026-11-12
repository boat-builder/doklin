// The workspace's sync in words, at the foot of the sidebar — docs/cloud.md
// §7.2: "Synced", "Syncing…", "Offline", "2 deletions to confirm". The full
// line (describeCloud: the phase, when it last synced, the domain) is the
// tooltip, and a click opens the Cloud panel.

import { useEffect, useState } from "react";
import { describeCloud, syncWords, type CloudStatus, type SyncTone } from "./cloud";

/** The engine passes through "syncing" on every cycle (one every 15 s,
 *  src-tauri/src/cloud/engine.rs POLL_INTERVAL), and most finish in a blink.
 *  The words change to Syncing… only once a pass has run this long, so the
 *  footer moves when there is something to wait for. */
const SYNCING_SHOWS_AFTER_MS = 800;

function SyncIcon({ tone }: { tone: SyncTone }) {
  const cloud = <path d="M4.6 12.75h6.9a3 3 0 0 0 .35-5.98A4 4 0 0 0 4.2 7.4a2.7 2.7 0 0 0 .4 5.35z" />;
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {tone === "warn" || tone === "error" ? (
        <>
          <path d="M8 2.2l6.2 11H1.8z" />
          <path d="M8 6.6v3M8 11.5v.1" />
        </>
      ) : (
        <>
          {cloud}
          {tone === "live" && <path d="M6.2 9.6l1.3 1.3 2.4-2.6" />}
          {tone === "busy" && (
            <g className="sync-turn">
              <path d="M6.3 9.9a1.9 1.9 0 0 0 3.3-.6M9.7 8.6a1.9 1.9 0 0 0-3.3.6" />
            </g>
          )}
          {tone === "quiet" && <path d="M2.5 2.5l11 11" />}
        </>
      )}
    </svg>
  );
}

export default function SyncStatus({ cloud, onOpen }: { cloud: CloudStatus; onOpen: () => void }) {
  const [shown, setShown] = useState(cloud);
  useEffect(() => {
    if (cloud.phase !== "syncing") {
      setShown(cloud);
      return;
    }
    const t = window.setTimeout(() => setShown(cloud), SYNCING_SHOWS_AFTER_MS);
    return () => window.clearTimeout(t);
  }, [cloud]);

  const { tone, text } = syncWords(shown);
  const line = describeCloud(cloud);
  return (
    <button
      className={`sync-status is-${tone}`}
      data-testid="sync-status"
      data-phase={shown.phase}
      title={line}
      aria-label={line}
      onClick={onOpen}
    >
      <SyncIcon tone={tone} />
      <span className="sync-status-text">{text}</span>
    </button>
  );
}
