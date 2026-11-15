// The Cloud panel (gear → Cloud…, and the dot
// beside the workspace name). A view over App-owned live state: the status
// array the engine emits is the whole model, and the panel derives
// everything from the entry for the open workspace.
//
// Not connected: three doors — join a workspace with a line (an invite
// somebody sent, or a code from another device of your own), create one from
// this folder on a domain of your own, or get back into one you made with the
// domain's own token. Connected: the workspace and its phase, sync now /
// pause, who else is here, the held mass-deletion waiting for a word, the
// worker's version against this app's, adding a device, disconnect, and the
// danger zone: erase everything on the domain (which frees it), then the
// teardown prompt for the agent. Who is in the workspace, their devices and
// its agents are the workspace menu's (PeopleDialog.tsx).
//
// What only an owner may do — the worker, the danger zone — is hidden from a
// member by the same table the domain decides with (`mayOn`).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BUNDLED_WORKER_VERSION,
  cloudConfirmDeletes,
  cloudDisconnect,
  cloudPause,
  cloudSyncNow,
  cloudWipe,
  mayOn,
  phaseLine,
  versionsLine,
  timeAgo,
  workerAhead,
  workerBehind,
  type CloudStatus,
} from "./cloud";
import { useDismiss } from "./dismiss";
import { buildTeardownPrompt } from "./cloudPrompts";
import { RELEASES_PAGE } from "./updater";

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
      <line x1="5" y1="5" x2="19" y2="19" />
      <line x1="19" y1="5" x2="5" y2="19" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="15 6 9 12 15 18" />
    </svg>
  );
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const MAX_LISTED_PATHS = 8;

type View = "main" | "wipe" | "teardown";

export default function CloudPanel({
  root,
  cloud,
  pendingDeletePaths,
  onClose,
  onConnect,
  onJoin,
  onRedeem,
  onAddDevice,
  onUpdateWorker,
  onOpenPublished,
  onOpenExternal,
  onWorkspaceHistory,
  onOpenVersions,
}: {
  /** The open workspace folder, if any. */
  root: string | null;
  /** Its status when it is connected. */
  cloud: CloudStatus | null;
  /** The paths of the held deletions, from the last event (may be empty after a relaunch). */
  pendingDeletePaths: string[];
  onClose: () => void;
  onConnect: () => void;
  onJoin: () => void;
  /** This Mac has a line to join with — an invite, or a code from another
   *  device of its person's: the wizard's third mode (CloudSetup.tsx). */
  onRedeem: () => void;
  /** The Devices tab, where a code for another device is made (CloudDevices.tsx). */
  onAddDevice: () => void;
  onUpdateWorker: () => void;
  /** The list of every published page (PublishedPages.tsx). */
  onOpenPublished: () => void;
  onOpenExternal: (url: string) => void;
  /** The workspace timeline. The sidebar
   *  root's menu is the other way in. */
  onWorkspaceHistory?: () => void;
  /** The Versions settings — the two
   *  horizons, the space, the export. The gear popover is the other way in. */
  onOpenVersions?: () => void;
}) {
  const [view, setView] = useState<View>("main");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [wipeInput, setWipeInput] = useState("");
  const [wiping, setWiping] = useState(false);
  // Captured before the wipe: the status is gone once the domain is empty.
  const [tornDown, setTornDown] = useState<{ domain: string; endpoint: string; purged: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Esc steps back out of a drilled-in view, as its back arrow does; a press
  // outside closes from anywhere. Nothing closes mid-wipe.
  const cardRef = useRef<HTMLDivElement>(null);
  useDismiss((how) => {
    if (wiping) return;
    if (how === "escape" && view !== "main" && view !== "teardown") setView("main");
    else onClose();
  }, cardRef);

  // "Synced 2 min ago" keeps counting while the panel is open.
  useEffect(() => {
    const h = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(h);
  }, []);

  const copy = useCallback(async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1600);
    } catch {
      /* selectable text — copy by hand */
    }
  }, []);

  const act = useCallback(async (f: () => Promise<unknown>) => {
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  const wipe = useCallback(async () => {
    if (!cloud) return;
    const { domain, endpoint, root: r } = cloud;
    setWiping(true);
    setError(null);
    try {
      const purged = await cloudWipe(r);
      setTornDown({ domain, endpoint, purged });
      setView("teardown");
    } catch (e) {
      setError(errText(e));
    } finally {
      setWiping(false);
    }
  }, [cloud]);

  const title =
    view === "wipe"
      ? `Delete everything on ${cloud?.domain ?? "the domain"}`
      : view === "teardown"
        ? "Tear down"
        : "Cloud";

  let body: React.ReactNode;
  if (view === "teardown" && tornDown) {
    const prompt = buildTeardownPrompt({ endpoint: tornDown.endpoint });
    body = (
      <>
        <div className="cloud-card cloud-card--ok" data-testid="wipe-done">
          <div className="cloud-card-title">
            Erased {tornDown.purged} object{tornDown.purged === 1 ? "" : "s"} — {tornDown.domain} is empty
          </div>
          <p className="cloud-hint">
            The domain is free for a new workspace, and this Mac has forgotten it. Your folder is
            untouched; other Macs keep their copies and stop syncing.
          </p>
        </div>
        <div className="cloud-step-title">Remove the worker, bucket and database from Cloudflare</div>
        <p className="cloud-hint">
          Nothing on the domain is needed any more. Hand this to your agent — no secret in it —
          or leave the empty worker in place: it serves the landing page and costs nothing.
        </p>
        <pre className="cloud-prompt" data-testid="teardown-prompt">
          {prompt}
        </pre>
        <div className="modal-buttons">
          <button className="modal-btn is-primary" onClick={() => void copy("teardown", prompt)}>
            {copied === "teardown" ? "Copied ✓" : "Copy prompt"}
          </button>
          <button className="modal-btn" onClick={onClose}>
            Done
          </button>
        </div>
      </>
    );
  } else if (!cloud) {
    body = (
      <>
        <p className="cloud-intro">
          A workspace is a folder of notes everyone in it shares: each person works on a copy on
          their own Mac, and the copies stay in step. It lives at a domain of your own — one
          Cloudflare Worker, one bucket and one database on your account, set up by an agent from
          a prompt this app writes — and publishing a note from it is one click.
        </p>
        <div className="cloud-doors">
          <button className="modal-btn is-primary" data-testid="join-with-invite" onClick={onRedeem}>
            Join a workspace
          </button>
          <button className="modal-btn" data-testid="connect-domain" disabled={!root} onClick={onConnect}>
            Create a workspace
          </button>
          <button className="modal-btn" data-testid="open-from-domain" onClick={onJoin}>
            Open with the domain’s token
          </button>
        </div>
        {!root && <p className="cloud-hint">Open a folder first to create a workspace from it.</p>}
        <p className="cloud-hint">
          Joining takes one line: the invite somebody sent you, or — for a workspace you are
          already in — the line another device of yours makes under Devices → Add a device.
          Creating one turns the open folder into a workspace you can invite people to. The third
          door is the way back into a workspace you made when every device is gone: it wants the
          domain’s own token.
        </p>
      </>
    );
  } else if (view === "wipe") {
    body = (
      <>
        <p className="cloud-hint">
          This erases every file, every revision and every published page on{" "}
          <strong>{cloud.domain}</strong>, and this Mac forgets the workspace. The folder on this
          Mac stays exactly as it is; other Macs keep their copies but stop syncing. The domain is
          free for a new workspace afterwards — and the worker, bucket and database can then be
          removed from Cloudflare with a prompt you get next.
        </p>
        <div className="modal-field">
          <div className="modal-field-label">Type the domain to confirm</div>
          <input
            className="modal-field-input"
            data-testid="wipe-confirm-input"
            value={wipeInput}
            placeholder={cloud.domain}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            disabled={wiping}
            onChange={(e) => setWipeInput(e.target.value)}
          />
        </div>
        <div className="modal-buttons">
          <button
            className="modal-btn is-danger-solid"
            data-testid="wipe-button"
            disabled={wipeInput.trim().toLowerCase() !== cloud.domain || wiping}
            onClick={() => void wipe()}
          >
            {wiping ? "Erasing…" : `Erase ${cloud.domain}`}
          </button>
          <button className="modal-btn" disabled={wiping} onClick={() => setView("main")}>
            Cancel
          </button>
        </div>
        {error && <div className="modal-error">{error}</div>}
      </>
    );
  } else {
    const behind = workerBehind(cloud);
    const ahead = workerAhead(cloud);
    const paused = cloud.phase === "paused";
    const others = cloud.presence;
    const pages = cloud.public.length;
    // An owner's, hidden from a member — and offered while the domain has not
    // said, which is every worker from before roles (`mayOn`).
    const manages = mayOn(cloud, "workspace.manage");
    body = (
      <>
        <div className="cloud-head">
          <div className="cloud-head-name">{cloud.name}</div>
          <button className="cloud-head-domain" onClick={() => onOpenExternal(cloud.endpoint)} title={cloud.endpoint}>
            {cloud.domain}
          </button>
        </div>
        <div className="cloud-phase-row" data-testid="phase-row">
          <span className={`cloud-dot phase-${cloud.phase}`} aria-hidden />
          <span className="cloud-phase-text" data-testid="phase-text">
            {cap(phaseLine(cloud, now))}
          </span>
          <div className="cloud-phase-actions">
            <button
              className="modal-btn"
              data-testid="sync-now"
              disabled={paused || cloud.phase === "syncing" || cloud.phase === "revoked"}
              onClick={() => void act(() => cloudSyncNow(cloud.root))}
            >
              Sync now
            </button>
            <button
              className="modal-btn"
              data-testid="pause-toggle"
              onClick={() => void act(() => cloudPause(cloud.root, !paused))}
            >
              {paused ? "Resume" : "Pause"}
            </button>
          </div>
        </div>
        {cloud.phase === "error" && cloud.error && <div className="modal-error">{cloud.error}</div>}
        {cloud.phase === "revoked" && (
          <p className="cloud-hint cloud-warn">
            {cloud.domain} doesn’t accept this Mac’s sign-in, so nothing syncs. Your files here are
            untouched. Disconnect this Mac, then join again with this folder open: with a line from
            another device of yours (Devices → Add a device), or an invite from an owner. If this
            Mac made the workspace and its worker was redeployed with a new token, open it with
            that token instead.
          </p>
        )}
        {cloud.phase === "offline" && (
          <p className="cloud-hint">Couldn’t reach {cloud.domain} — sync retries on its own.</p>
        )}

        {cloud.phase === "pending-deletes" && (
          <div className="cloud-card cloud-card--attention" data-testid="pending-deletes">
            <div className="cloud-card-title">
              {cloud.pendingDeletes} file{cloud.pendingDeletes === 1 ? "" : "s"} disappeared from this folder
            </div>
            <p className="cloud-hint">
              Sync holds a deletion this large until you say so. Delete them on {cloud.domain} too,
              or put the files back and they sync again on their own.
            </p>
            {pendingDeletePaths.length > 0 && (
              <ul className="cloud-paths">
                {pendingDeletePaths.slice(0, MAX_LISTED_PATHS).map((p) => (
                  <li key={p}>{p}</li>
                ))}
                {pendingDeletePaths.length > MAX_LISTED_PATHS && (
                  <li className="cloud-paths-more">…and {pendingDeletePaths.length - MAX_LISTED_PATHS} more</li>
                )}
              </ul>
            )}
            <div className="modal-buttons">
              <button
                className="modal-btn is-primary"
                data-testid="confirm-deletes"
                onClick={() => void act(() => cloudConfirmDeletes(cloud.root))}
              >
                Delete them on {cloud.domain}
              </button>
            </div>
          </div>
        )}

        {behind && (
          <div className="cloud-card cloud-card--attention" data-testid="worker-behind">
            <div className="cloud-card-title">
              The worker is behind this app
              {cloud.workerVersion != null ? ` — v${cloud.workerVersion}, the app expects v${BUNDLED_WORKER_VERSION}` : ""}
            </div>
            <p className="cloud-hint">
              {cloud.phase === "worker-outdated"
                ? "This Mac’s changes are waiting on the update."
                : "Sync still works; the update brings the worker up to what this app expects."}
              {!manages && " Updating it is for whoever set the domain up — ask an owner."}
            </p>
            {manages && (
              <div className="modal-buttons">
                <button className="modal-btn is-primary" data-testid="update-worker" onClick={onUpdateWorker}>
                  Update the worker
                </button>
              </div>
            )}
          </div>
        )}
        {ahead && (
          <div className="cloud-card" data-testid="worker-ahead">
            <div className="cloud-card-title">The worker is newer than this app (v{cloud.workerVersion})</div>
            <div className="modal-buttons">
              <button className="modal-btn" onClick={() => onOpenExternal(RELEASES_PAGE)}>
                Get the latest Doklin
              </button>
            </div>
          </div>
        )}

        <div className="cloud-section-label">Version history</div>
        <p className="cloud-hint" data-testid="versions-line">
          {versionsLine(cloud, now)}
        </p>
        {onWorkspaceHistory && (
          <div className="cloud-phase-actions">
            <button
              className="modal-btn"
              data-testid="cloud-workspace-history"
              onClick={onWorkspaceHistory}
            >
              Workspace history
            </button>
          </div>
        )}

        <div className="cloud-section-label">Here now</div>
        {others.length === 0 ? (
          <p className="cloud-hint" data-testid="presence-empty">
            Only this Mac.
          </p>
        ) : (
          <ul className="cloud-presence" data-testid="presence-list">
            {others.map((p) => (
              <li key={p.deviceId} className="cloud-presence-row">
                <span className="cloud-presence-name">{p.name}</span>
                <span className="cloud-presence-what">
                  {/* A person with two Macs open is two rows; the Mac tells them apart. */}
                  {p.device && p.device !== p.name && `on ${p.device} · `}
                  {p.path ? `editing ${p.path}` : "here, idle"} · {timeAgo(p.ts, now)}
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="cloud-section-label">Public</div>
        <div className="cloud-actions">
          <button className="modal-btn" data-testid="published-pages" onClick={onOpenPublished}>
            Published pages{pages > 0 ? ` (${pages})` : ""}
          </button>
          {pages === 0 && <span className="cloud-hint">Nothing is published yet.</span>}
        </div>

        <div className="cloud-section-label">This Mac</div>
        <div className="cloud-actions">
          {mayOn(cloud, "devices.own") && (
            <button className="modal-btn" data-testid="add-device" onClick={onAddDevice}>
              Add a device
            </button>
          )}
          {onOpenVersions && (
            <button className="modal-btn" data-testid="cloud-versions-settings" onClick={onOpenVersions}>
              Version settings
            </button>
          )}
          {!behind && manages && (
            <button className="modal-btn" data-testid="update-worker-quiet" onClick={onUpdateWorker}>
              Update the worker
            </button>
          )}
          {confirmDisconnect ? (
            <span className="cloud-inline-confirm" data-testid="disconnect-confirm">
              <span className="cloud-hint">
                Stop syncing on this Mac? The folder and the cloud stay, and this Mac’s sign-in ends:
                to sync here again it joins with a new line.
              </span>
              <button
                className="modal-btn is-primary"
                data-testid="disconnect-yes"
                onClick={() => void act(() => cloudDisconnect(cloud.root))}
              >
                Disconnect
              </button>
              <button className="modal-btn" onClick={() => setConfirmDisconnect(false)}>
                Cancel
              </button>
            </span>
          ) : (
            <button className="modal-btn" data-testid="disconnect" onClick={() => setConfirmDisconnect(true)}>
              Disconnect this Mac
            </button>
          )}
        </div>
        {error && <div className="modal-error">{error}</div>}

        {manages && (
          <>
            <div className="cloud-section-label cloud-danger-label">Danger zone</div>
            <div className="cloud-actions">
              <button
                className="modal-btn is-danger-outline"
                data-testid="wipe-open"
                onClick={() => {
                  setWipeInput("");
                  setError(null);
                  setView("wipe");
                }}
              >
                Delete everything on {cloud.domain}
              </button>
            </div>
          </>
        )}
      </>
    );
  }

  return (
    <div className="modal-overlay">
      <div ref={cardRef} className="modal cloud-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          {view !== "main" && view !== "teardown" && (
            <button className="modal-back" onClick={() => setView("main")} aria-label="Back">
              <BackIcon />
            </button>
          )}
          <div className="modal-title">{title}</div>
          <button className="modal-close" onClick={onClose} aria-label="Close" disabled={wiping}>
            <CloseIcon />
          </button>
        </div>
        <div className="cloud-body">{body}</div>
      </div>
    </div>
  );
}
