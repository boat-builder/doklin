// The Cloud panel (gear → Cloud…, and the dot
// beside the workspace name). A view over App-owned live state: the status
// array the engine emits is the whole model, and the panel derives
// everything from the entry for the open workspace.
//
// Not connected: three doors — join a workspace with a line (an invite
// somebody sent, or a code from another device of your own), create one from
// this folder on a domain of your own, or recover one with its Cloudflare
// account after every device is gone. Connected: the workspace and its phase, sync now /
// pause, who else is here, the held mass-deletion and the held new documents
// waiting for a word, what the day's Cloudflare limits are doing (and lifting
// this Mac's own wait), the worker's version against this app's, today's
// requests and the Cloudflare plan, adding a device, disconnect, and the
// danger zone: erase everything on the domain (which frees it), then the
// teardown prompt for the agent. Who is in the workspace, their devices and
// its agents are the workspace menu's (PeopleDialog.tsx).
//
// What only the superadmin may do — the worker, the plan, the danger zone —
// is hidden from everyone else by the same table the domain decides with
// (`mayOn`).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BUNDLED_WORKER_VERSION,
  addsQuestion,
  mayOn,
  phaseLine,
  planName,
  sendingWords,
  usageLine,
  usageState,
  versionsLine,
  timeAgo,
  waitWords,
  workerAhead,
  workerBehind,
  type CloudPendingAddsEvent,
  type CloudPlan,
  type CloudStatus,
} from "./cloud";
import { useDismiss } from "./dismiss";
import { buildTeardownPrompt } from "./cloudPrompts";
import { RELEASES_PAGE } from "./updater";
import { backend } from "./backend";

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

/** What changing the plan does, said before it is changed. The iPhone asks
 *  with the same words (ios/DoklinKit/Sources/DoklinKit/Models/Limits.swift)
 *  — change both. */
const PLAN_CONFIRM: Record<CloudPlan, string> = {
  paid: "Doklin stops pacing sync for Cloudflare’s free daily requests. Choose this only once the account is on Workers Paid, or Cloudflare stops every request once today’s are used up.",
  free: "Doklin paces sync to stay inside Cloudflare’s free daily requests: big changes may wait until the next day.",
};

type View = "main" | "wipe" | "teardown";

export default function CloudPanel({
  root,
  cloud,
  pendingDeletePaths,
  pendingAdds,
  onClose,
  onConnect,
  onRecover,
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
  /** The held new documents' folders, from the last event for this workspace
   *  (null after a relaunch: the status still has the count). */
  pendingAdds: CloudPendingAddsEvent | null;
  onClose: () => void;
  onConnect: () => void;
  /** Every device is gone: get back in with the Cloudflare account — the
   *  wizard's recover mode (CloudSetup.tsx). */
  onRecover: () => void;
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
  // The plan a press asked for, waiting for its confirmation.
  const [askPlan, setAskPlan] = useState<CloudPlan | null>(null);
  // A command in flight whose button should not be pressed twice.
  const [busy, setBusy] = useState<"lift" | "adds" | "plan" | null>(null);
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

  const act = useCallback(async (f: () => Promise<unknown>, what: typeof busy = null) => {
    setError(null);
    if (what) setBusy(what);
    try {
      await f();
    } catch (e) {
      setError(errText(e));
    } finally {
      if (what) setBusy(null);
    }
  }, []);

  const wipe = useCallback(async () => {
    if (!cloud) return;
    const { domain, endpoint, root: r } = cloud;
    setWiping(true);
    setError(null);
    try {
      const purged = await backend.cloud.wipe(r);
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
          <button className="modal-btn" data-testid="recover-domain" onClick={onRecover}>
            Recover with your Cloudflare account
          </button>
        </div>
        {!root && <p className="cloud-hint">Open a folder first to create a workspace from it.</p>}
        <p className="cloud-hint">
          Joining takes one line: the invite somebody sent you, or — for a workspace you are
          already in — the line another device of yours makes under Devices → Add a device.
          Creating one turns the open folder into a workspace you can invite people to. The third
          door is the way back in for whoever controls a workspace’s Cloudflare account, when
          every device is gone.
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
    // The superadmin's, hidden from everyone else (`mayOn`).
    const manages = mayOn(cloud, "workspace.manage");
    const usage = usageState(cloud.usage);
    const plan = cloud.usage.plan;
    // Nothing held on this Mac's own allowance is nothing to say; everyone's
    // being near the limit is worth saying either way.
    const waits = usage.kind === "waits" && (usage.waiting > 0 || usage.cause === "fleet") ? usage : null;
    const after = (until: string | null) => (until ? `after ${until}` : "once Cloudflare’s day starts again");
    // Only the superadmin can say the account moved to Workers Paid.
    const planHint =
      manages && plan !== "paid"
        ? "If the Cloudflare account moves to Workers Paid, say so under Cloudflare plan below and these limits lift."
        : null;
    // The folders come from the event that asked; an event for another count
    // is an older question, so only the count is said.
    const adds = cloud.pendingAdds;
    const addsFolders = pendingAdds && pendingAdds.count === adds ? pendingAdds.folders : null;
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
              onClick={() => void act(() => backend.cloud.syncNow(cloud.root))}
            >
              Sync now
            </button>
            <button
              className="modal-btn"
              data-testid="pause-toggle"
              onClick={() => void act(() => backend.cloud.pause(cloud.root, !paused))}
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
            another device of yours (Devices → Add a device), or an invite from an owner. Without
            either, whoever controls the workspace’s Cloudflare account can recover it with that.
          </p>
        )}
        {cloud.phase === "offline" && (
          <p className="cloud-hint">Couldn’t reach {cloud.domain} — sync retries on its own.</p>
        )}
        {cloud.phase === "limited" && (
          <p className="cloud-hint cloud-warn" data-testid="limited">
            {cloud.error ?? "Today’s Cloudflare requests are used up."}
            {manages &&
              plan !== "paid" &&
              " Moving the Cloudflare account to Workers Paid lifts it within half an hour — then set the plan below to match."}
          </p>
        )}

        {waits && (
          <div className="cloud-card cloud-card--attention" data-testid="usage-waits" data-cause={waits.cause}>
            <div className="cloud-card-title">
              {waits.waiting > 0
                ? waitWords(waits.waiting, waits.until)
                : `Big changes wait${waits.until ? ` until ${waits.until}` : ""}`}
            </div>
            <p className="cloud-hint">
              {waits.cause === "device"
                ? "This Mac has sent its share of big changes for today."
                : "Everyone on this workspace together is near today’s Cloudflare limit."}{" "}
              The rest go out {after(waits.until)}, so nothing else on this workspace slows down.
            </p>
            {waits.cause === "fleet" && planHint && <p className="cloud-hint">{planHint}</p>}
            {waits.cause === "device" && cloud.usage.liftable && (
              <div className="modal-buttons">
                <button
                  className="modal-btn is-primary"
                  data-testid="lift-wait"
                  disabled={busy === "lift"}
                  onClick={() => void act(() => backend.cloud.liftWait(cloud.root), "lift")}
                >
                  {waits.waiting === 1 ? "Send it now" : "Send them now"}
                </button>
              </div>
            )}
          </div>
        )}
        {usage.kind === "sending" && (
          <div className="cloud-card" data-testid="usage-sending">
            <div className="cloud-card-title">{sendingWords(usage.waiting)}</div>
          </div>
        )}
        {usage.kind === "slow" && (
          <p className="cloud-hint cloud-warn" data-testid="usage-slow">
            {plan === "paid"
              ? "Sync is slower for the rest of today because this Mac has sent an unusual number of requests — edits still go out, about once a minute."
              : "Sync is slower for the rest of today to stay inside Cloudflare’s free requests — edits still go out, about once a minute."}
            {cloud.usage.cause === "fleet" && planHint && ` ${planHint}`}
          </p>
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
                onClick={() => void act(() => backend.cloud.confirmDeletes(cloud.root))}
              >
                Delete them on {cloud.domain}
              </button>
            </div>
          </div>
        )}

        {cloud.phase === "pending-adds" && (
          <div className="cloud-card cloud-card--attention" data-testid="pending-adds">
            <div className="cloud-card-title">{addsQuestion(adds, addsFolders, cloud.name)}</div>
            <p className="cloud-hint">
              Sync asks before sending this many new documents at once. Not now keeps them on this
              Mac, and Doklin asks again when another new document lands there or you press Sync now.
            </p>
            {addsFolders && addsFolders.length > 1 && (
              <ul className="cloud-paths">
                {addsFolders.map((f) => (
                  <li key={f.path}>
                    {f.path || cloud.name} — {f.count.toLocaleString()}
                  </li>
                ))}
              </ul>
            )}
            <div className="modal-buttons">
              <button
                className="modal-btn is-primary"
                data-testid="confirm-adds"
                disabled={busy === "adds"}
                onClick={() => void act(() => backend.cloud.confirmAdds(cloud.root, true), "adds")}
              >
                {adds === 1 ? "Sync it" : "Sync them"}
              </button>
              <button
                className="modal-btn"
                data-testid="decline-adds"
                disabled={busy === "adds"}
                onClick={() => void act(() => backend.cloud.confirmAdds(cloud.root, false), "adds")}
              >
                Not now
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
              {!manages &&
                (cloud.superadmin
                  ? ` Updating it is the superadmin’s — ask ${cloud.superadmin}.`
                  : " Updating it is the superadmin’s — whoever set the domain up.")}
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

        <div className="cloud-section-label">Cloudflare</div>
        <p className="cloud-hint" data-testid="usage-line">
          {usageLine(cloud.usage)}
        </p>
        {(manages || plan) && (
          <>
            <div className="cloud-plan-row" data-testid="plan-row">
              <span className="cloud-plan-label">Cloudflare plan:</span>
              {manages ? (
                <div className="view-toggle" role="radiogroup" aria-label="Cloudflare plan">
                  {(["free", "paid"] as const).map((p) => (
                    <button
                      key={p}
                      role="radio"
                      aria-checked={plan === p}
                      className={`view-toggle-seg ${plan === p ? "is-active" : ""}`}
                      data-testid={`plan-${p}`}
                      disabled={busy === "plan"}
                      onClick={() => setAskPlan(p === plan ? null : p)}
                    >
                      {planName(p)}
                    </button>
                  ))}
                </div>
              ) : (
                plan && (
                  <span className="cloud-plan-value" data-testid="plan-value">
                    {planName(plan)}
                  </span>
                )
              )}
            </div>
            <p className="cloud-hint">Workers Paid lifts the daily limits; the worker still slows a device that loops.</p>
            {manages && askPlan && askPlan !== plan && (
              <span className="cloud-inline-confirm" data-testid="plan-confirm">
                <span className="cloud-hint">{PLAN_CONFIRM[askPlan]}</span>
                <button
                  className="modal-btn is-primary"
                  data-testid="plan-yes"
                  disabled={busy === "plan"}
                  onClick={() =>
                    void act(async () => {
                      await backend.cloud.setPlan(cloud.root, askPlan);
                      setAskPlan(null);
                    }, "plan")
                  }
                >
                  Switch to {planName(askPlan)}
                </button>
                <button className="modal-btn" disabled={busy === "plan"} onClick={() => setAskPlan(null)}>
                  Cancel
                </button>
              </span>
            )}
          </>
        )}

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
                onClick={() => void act(() => backend.cloud.disconnect(cloud.root))}
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
