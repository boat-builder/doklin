// "Update the worker" — docs/cloud.md §7.2. One card (v1 → v2), two ways to
// run the same update, and "Check again", which asks the engine to probe the
// domain; the fresh version arrives through the status this card is rendered
// from. The app can't push the update itself: by design it holds only the
// worker's token, never Cloudflare credentials.
//
// The update is a fixed sequence, so it is a script — two commands to run in
// a terminal — and the agent prompt below them only asks an agent to run that
// same script. Neither carries a secret: the token, the bucket and the domain
// all survive a same-name redeploy.
//
// A worker that is NEWER than this app is the other way round — the card
// says so and points at the Doklin release instead.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BUNDLED_WORKER_VERSION,
  cloudCheckWorker,
  workerAhead,
  workerBehind,
  type CloudStatus,
} from "./cloud";
import { buildUpdatePrompt, updateCommands } from "./cloudPrompts";
import { RELEASES_PAGE } from "./updater";

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
      <line x1="5" y1="5" x2="19" y2="19" />
      <line x1="19" y1="5" x2="5" y2="19" />
    </svg>
  );
}

export default function WorkerUpdate({
  cloud,
  onClose,
  onOpenExternal,
}: {
  cloud: CloudStatus;
  onClose: () => void;
  onOpenExternal: (url: string) => void;
}) {
  const behind = workerBehind(cloud);
  const ahead = workerAhead(cloud);
  const [copied, setCopied] = useState<"commands" | "prompt" | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const commands = useMemo(() => updateCommands(cloud.endpoint), [cloud.endpoint]);
  const prompt = useMemo(
    () =>
      buildUpdatePrompt({
        endpoint: cloud.endpoint,
        fromVersion: cloud.workerVersion,
        toVersion: BUNDLED_WORKER_VERSION,
      }),
    [cloud.endpoint, cloud.workerVersion],
  );

  const copy = useCallback(async (what: "commands" | "prompt", text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      /* both blocks are selectable text — the user can still copy by hand */
    }
  }, []);

  // The answer comes back as a status; a worker that hasn't changed re-emits
  // the same numbers, so the button simply rests after a moment.
  const check = useCallback(async () => {
    setChecking(true);
    try {
      await cloudCheckWorker(cloud.root);
    } catch {
      /* the status carries whatever the engine learned */
    }
    window.setTimeout(() => setChecking(false), 1500);
  }, [cloud.root]);

  const running = cloud.workerVersion != null ? `v${cloud.workerVersion}` : "v?";
  let explain: string;
  if (behind && cloud.phase === "worker-outdated") {
    explain =
      "This Mac's changes are waiting on the update: the worker doesn't understand what the app is trying to sync yet. Everything else keeps working.";
  } else if (behind) {
    explain =
      "Doklin was built for a newer worker. Sync still works; the update brings the worker up to what this app expects.";
  } else if (ahead) {
    explain = "The worker is newer than this app — update Doklin instead.";
  } else {
    explain = "Up to date.";
  }

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal cloud-modal cloud-modal--wide"
        role="dialog"
        aria-modal="true"
        aria-label="Update the worker"
      >
        <div className="modal-header">
          <div className="modal-title">Update the worker</div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="cloud-body">
          <div className={`cloud-card ${behind ? "cloud-card--attention" : ""}`} data-testid="worker-card">
            <div className="cloud-card-title">{cloud.domain}</div>
            <div className="cloud-version-line" aria-label="Worker version">
              <span className="cloud-version-from">{running}</span>
              <span className="cloud-version-arrow" aria-hidden>
                →
              </span>
              <span className="cloud-version-to">v{BUNDLED_WORKER_VERSION}</span>
            </div>
            <p className="cloud-hint">{explain}</p>
          </div>

          {behind && (
            <>
              <div className="cloud-step-title">Run this in a terminal</div>
              <p className="cloud-hint">
                Two commands. The script downloads the worker published with the latest Doklin
                release, signs you into Cloudflare if you aren't already, confirms the worker and
                its bucket against your account, and deploys the new code over the same name — so
                your data, your token and your domain are untouched. Nothing here is secret.
              </p>
              <pre className="cloud-prompt" data-testid="update-commands">
                {commands}
              </pre>
              <div className="modal-buttons">
                <button
                  className="modal-btn is-primary"
                  onClick={() => void copy("commands", commands)}
                >
                  {copied === "commands" ? "Copied ✓" : "Copy commands"}
                </button>
                <button className="modal-btn" disabled={checking} onClick={() => void check()}>
                  {checking ? "Checking…" : "Check again"}
                </button>
              </div>

              <div className="cloud-step-title">Or hand it to your agent</div>
              <p className="cloud-hint">
                The same script, with the context around it: paste this into Claude Code, or any
                agent with a terminal.
              </p>
              <pre className="cloud-prompt" data-testid="update-prompt">
                {prompt}
              </pre>
              <div className="modal-buttons">
                <button className="modal-btn" onClick={() => void copy("prompt", prompt)}>
                  {copied === "prompt" ? "Copied ✓" : "Copy prompt"}
                </button>
              </div>
            </>
          )}
          {ahead && (
            <div className="modal-buttons">
              <button className="modal-btn is-primary" onClick={() => onOpenExternal(RELEASES_PAGE)}>
                Get the latest Doklin
              </button>
            </div>
          )}
          {!behind && !ahead && (
            <div className="modal-buttons">
              <button className="modal-btn is-primary" onClick={onClose}>
                Done
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
