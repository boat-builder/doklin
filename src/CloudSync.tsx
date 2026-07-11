// Cloud sync settings — the gear menu's "Cloud sync…" dialog.
//
// Three stories in one place, in the order people need them:
//   1. this workspace: turn sync on (or see that it's on),
//   2. synced workspaces: health, pause, sync-now, held deletions, stop,
//   3. people: invites, members/devices, revocation — owner only; the
//      backend decides who's the owner (whoami), not the UI.
//
// The dialog is a *view* over App-owned live state (statuses arrive as
// engine events) plus its own fetched people-state per connection.

import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { ShareConnection } from "./share";
import { shareHost } from "./share";
import {
  cancelInvite,
  createInvite,
  listInvites,
  listRemoteWorkspaces,
  listTokens,
  revokeToken,
  syncConfirmDeletes,
  syncDisable,
  syncEnable,
  syncNow,
  syncPause,
  SyncWorkerOutdatedError,
  whoami,
  type CreatedInvite,
  type InviteInfo,
  type RemoteWorkspace,
  type SyncProgressEvent,
  type SyncWorkspaceStatus,
  type TokenInfo,
  type WhoAmI,
} from "./sync";

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
      <line x1="5" y1="5" x2="19" y2="19" />
      <line x1="19" y1="5" x2="5" y2="19" />
    </svg>
  );
}

const PHASE_LABEL: Record<string, string> = {
  idle: "Synced",
  syncing: "Syncing…",
  offline: "Offline — will retry",
  paused: "Paused",
  "pending-deletes": "Deletions waiting for confirmation",
  revoked: "Access revoked",
  error: "Problem",
};

function phaseDotClass(phase: string): string {
  switch (phase) {
    case "idle":
      return "is-ok";
    case "syncing":
      return "is-busy";
    case "paused":
    case "offline":
      return "is-warn";
    default:
      return "is-bad";
  }
}

function timeAgo(ms: number | null): string {
  if (!ms) return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export default function CloudSync({
  workspaceRoot,
  workspaceName,
  connections,
  defaultConnectionId,
  statuses,
  deviceName,
  onClose,
  onOpenShareSetup,
  onOpenWorkerUpdate,
  onOpenConnectBackend,
}: {
  workspaceRoot: string | null;
  workspaceName: string | null;
  connections: ShareConnection[];
  defaultConnectionId: string | null;
  statuses: SyncWorkspaceStatus[];
  deviceName: string;
  onClose: () => void;
  onOpenShareSetup: () => void;
  onOpenWorkerUpdate: (() => void) | null;
  onOpenConnectBackend: () => void;
}) {
  const [connId, setConnId] = useState<string | null>(
    defaultConnectionId ?? connections[0]?.id ?? null,
  );
  const conn = connections.find((c) => c.id === connId) ?? null;

  /* ----- enable-this-workspace ----- */

  const rootSynced = useMemo(
    () => statuses.find((s) => workspaceRoot != null && s.root === workspaceRoot) ?? null,
    [statuses, workspaceRoot],
  );
  const [enabling, setEnabling] = useState(false);
  const [enableError, setEnableError] = useState<string | null>(null);
  const [progress, setProgress] = useState<SyncProgressEvent | null>(null);

  useEffect(() => {
    const un = listen<SyncProgressEvent>("sync-progress", (e) => setProgress(e.payload));
    return () => {
      void un.then((f) => f());
    };
  }, []);

  const enable = useCallback(async () => {
    if (!workspaceRoot || !conn) return;
    setEnabling(true);
    setEnableError(null);
    setProgress(null);
    try {
      await syncEnable(workspaceRoot, conn.id, workspaceName || "Workspace");
    } catch (e) {
      setEnableError(String(e));
    } finally {
      setEnabling(false);
      setProgress(null);
    }
  }, [workspaceRoot, workspaceName, conn]);

  /* ----- per-workspace actions ----- */

  const [confirmStop, setConfirmStop] = useState<string | null>(null);
  const [wsBusy, setWsBusy] = useState<string | null>(null);

  const act = useCallback(async (wsId: string, fn: () => Promise<unknown>) => {
    setWsBusy(wsId);
    try {
      await fn();
    } catch (e) {
      console.error("sync action failed", e);
    } finally {
      setWsBusy(null);
    }
  }, []);

  /* ----- people (per connection) ----- */

  type People = {
    loading: boolean;
    error: string | null;
    outdated: boolean;
    me: WhoAmI | null;
    tokens: TokenInfo[];
    invites: InviteInfo[];
    workspaces: RemoteWorkspace[];
  };
  const [people, setPeople] = useState<People>({
    loading: false,
    error: null,
    outdated: false,
    me: null,
    tokens: [],
    invites: [],
    workspaces: [],
  });

  const loadPeople = useCallback(async () => {
    if (!conn) return;
    setPeople((p) => ({ ...p, loading: true, error: null, outdated: false }));
    try {
      const me = await whoami(conn);
      if (me.role === "owner") {
        const [tokens, invites, workspaces] = await Promise.all([
          listTokens(conn),
          listInvites(conn),
          listRemoteWorkspaces(conn),
        ]);
        setPeople({ loading: false, error: null, outdated: false, me, tokens, invites, workspaces });
      } else {
        setPeople({
          loading: false,
          error: null,
          outdated: false,
          me,
          tokens: [],
          invites: [],
          workspaces: [],
        });
      }
    } catch (e) {
      setPeople({
        loading: false,
        error: e instanceof SyncWorkerOutdatedError ? null : String(e),
        outdated: e instanceof SyncWorkerOutdatedError,
        me: null,
        tokens: [],
        invites: [],
        workspaces: [],
      });
    }
  }, [conn]);

  useEffect(() => {
    void loadPeople();
  }, [loadPeople]);

  /* ----- invite form ----- */

  const [inviteOpen, setInviteOpen] = useState<false | "member" | "device">(false);
  const [inviteName, setInviteName] = useState("");
  const [inviteWs, setInviteWs] = useState<Set<string>>(new Set());
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const [copied, setCopied] = useState<"link" | "code" | null>(null);

  const startInvite = (kind: "member" | "device") => {
    setInviteOpen(kind);
    setInviteName("");
    setInviteError(null);
    setCreated(null);
    // Preselect: the workspace you're looking at, else everything granted.
    const pre = new Set<string>();
    if (rootSynced) pre.add(rootSynced.wsId);
    else if (people.workspaces.length === 1) pre.add(people.workspaces[0].id);
    setInviteWs(pre);
  };

  const submitInvite = useCallback(async () => {
    if (!conn || !inviteOpen) return;
    if (inviteOpen === "member" && inviteWs.size === 0) {
      setInviteError("Pick at least one workspace to share.");
      return;
    }
    setInviteBusy(true);
    setInviteError(null);
    try {
      const invite = await createInvite(conn, {
        name: inviteName.trim() || (inviteOpen === "device" ? "Linked device" : "Member"),
        role: inviteOpen === "device" ? "owner" : "member",
        workspaces: [...inviteWs],
      });
      setCreated(invite);
      void loadPeople();
    } catch (e) {
      setInviteError(String(e));
    } finally {
      setInviteBusy(false);
    }
  }, [conn, inviteOpen, inviteName, inviteWs, loadPeople]);

  const copy = useCallback(async (text: string, which: "link" | "code") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      // ignore
    }
  }, []);

  /* ----- render ----- */

  const showConnPicker = connections.length > 1;

  return (
    <div
      className="shared-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="shared-modal sync-modal" role="dialog" aria-modal="true" aria-label="Cloud sync">
        <div className="shared-modal-header">
          <div className="shared-modal-title">Cloud sync</div>
          <button className="shared-modal-close" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>

        <div className="sync-body">
          {connections.length === 0 ? (
            <div className="shared-empty">
              <p>
                Cloud sync runs on the same backend as sharing — your own Cloudflare worker.
                Set that up once and both light up.
              </p>
              <button className="share-btn is-primary shared-empty-action" onClick={onOpenShareSetup}>
                Set up a backend…
              </button>
              <p className="sync-hint">
                Someone sent you an invite instead?{" "}
                <button className="share-all-link" onClick={onOpenConnectBackend}>
                  Connect to their backend
                </button>
              </p>
            </div>
          ) : (
            <>
              {showConnPicker && (
                <div className="sync-conn-row">
                  <span className="shared-section-label">Backend</span>
                  <select
                    className="share-field-input sync-conn-select"
                    value={connId ?? ""}
                    onChange={(e) => setConnId(e.target.value)}
                  >
                    {connections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {shareHost(c)}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* --- This workspace --- */}
              {workspaceRoot && !rootSynced && (
                <>
                  <div className="shared-section-label">This workspace</div>
                  <div className="sync-enable">
                    <p>
                      Sync <strong>{workspaceName || workspaceRoot}</strong> to{" "}
                      <strong>{conn ? shareHost(conn) : "your backend"}</strong>: it backs up
                      automatically, follows you to other machines, and can be shared with
                      people you invite. Nothing becomes public.
                    </p>
                    {enableError && <div className="sync-error">{enableError}</div>}
                    <div className="share-buttons">
                      <button
                        className="share-btn is-primary"
                        disabled={enabling || !conn}
                        onClick={() => void enable()}
                      >
                        {enabling
                          ? progress && progress.kind === "upload"
                            ? `Uploading ${progress.done}/${progress.total}…`
                            : "Setting up…"
                          : "Sync this workspace"}
                      </button>
                    </div>
                  </div>
                </>
              )}

              {/* --- Synced workspaces --- */}
              {statuses.length > 0 && (
                <>
                  <div className="shared-section-label">Synced workspaces</div>
                  <ul className="shared-list">
                    {statuses.map((s) => (
                      <li key={s.wsId} className="shared-row sync-ws-row">
                        <div className="shared-row-main">
                          <span className="shared-row-title">
                            <span className={`sync-dot ${phaseDotClass(s.phase)}`} aria-hidden />
                            {s.name}
                          </span>
                          <span className="sync-ws-meta" title={s.root}>
                            {PHASE_LABEL[s.phase] ?? s.phase}
                            {s.phase === "idle" && s.lastSyncMs ? ` · ${timeAgo(s.lastSyncMs)}` : ""}
                            {s.error && s.phase !== "idle" ? ` — ${s.error}` : ""}
                          </span>
                          {s.phase === "pending-deletes" && (
                            <div className="sync-deletes">
                              {s.pendingDeletes} files disappeared locally. Propagate the
                              deletion to the backend and other devices?
                              <div className="share-buttons">
                                <button
                                  className="share-btn is-danger"
                                  onClick={() => void act(s.wsId, () => syncConfirmDeletes(s.wsId))}
                                >
                                  Delete everywhere
                                </button>
                                <button
                                  className="share-btn"
                                  onClick={() => void act(s.wsId, () => syncNow(s.wsId))}
                                  title="If the files are back in place (disk remounted, folder restored), a sync clears this"
                                >
                                  Re-check
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                        <div className="shared-row-actions">
                          {confirmStop === s.wsId ? (
                            <>
                              <button
                                className="share-btn is-danger"
                                disabled={wsBusy === s.wsId}
                                onClick={() =>
                                  void act(s.wsId, async () => {
                                    await syncDisable(s.wsId);
                                    setConfirmStop(null);
                                  })
                                }
                              >
                                Stop syncing
                              </button>
                              <button className="share-btn" onClick={() => setConfirmStop(null)}>
                                Keep
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                className="share-btn"
                                disabled={wsBusy === s.wsId}
                                onClick={() => void act(s.wsId, () => syncNow(s.wsId))}
                              >
                                Sync now
                              </button>
                              <button
                                className="share-btn"
                                disabled={wsBusy === s.wsId}
                                onClick={() =>
                                  void act(s.wsId, () => syncPause(s.wsId, s.phase !== "paused"))
                                }
                              >
                                {s.phase === "paused" ? "Resume" : "Pause"}
                              </button>
                              <button
                                className="share-btn"
                                title="Stops syncing on this Mac. Local files and the backend copy both stay."
                                onClick={() => setConfirmStop(s.wsId)}
                              >
                                Stop…
                              </button>
                            </>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {/* --- People --- */}
              <div className="shared-section-label">People &amp; devices</div>
              {people.loading && <div className="sync-hint">Checking the backend…</div>}
              {people.outdated && (
                <div className="shared-outdated">
                  This backend's worker predates cloud sync.{" "}
                  {onOpenWorkerUpdate ? (
                    <button className="share-all-link" onClick={onOpenWorkerUpdate}>
                      Update the worker
                    </button>
                  ) : (
                    "Update the worker from the settings gear, then reopen this dialog."
                  )}
                </div>
              )}
              {people.error && <div className="sync-error">{people.error}</div>}
              {people.me?.role === "member" && (
                <p className="sync-hint">
                  You're connected to {conn ? shareHost(conn) : "this backend"} as{" "}
                  <strong>{people.me.name}</strong> — invited by its owner. Only the owner
                  manages people.
                </p>
              )}
              {people.me?.role === "owner" && (
                <>
                  {people.tokens.length > 0 && (
                    <ul className="shared-list">
                      {people.tokens.map((t) => (
                        <li key={t.id} className="shared-row">
                          <div className="shared-row-main">
                            <span className="shared-row-title">{t.name}</span>
                            <span className="sync-ws-meta">
                              {t.role === "owner" ? "your device" : "member"}
                              {t.lastSeenAt
                                ? ` · seen ${timeAgo(Date.parse(t.lastSeenAt))}`
                                : " · never seen"}
                            </span>
                          </div>
                          <div className="shared-row-actions">
                            <button
                              className="share-btn is-danger"
                              title="Cuts this token off immediately. Their local files stay; sync stops."
                              onClick={() =>
                                void (async () => {
                                  if (!conn) return;
                                  await revokeToken(conn, t.id).catch((e) => console.error(e));
                                  void loadPeople();
                                })()
                              }
                            >
                              Revoke
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  {people.invites.length > 0 && (
                    <ul className="shared-list">
                      {people.invites.map((i) => (
                        <li key={i.id} className="shared-row">
                          <div className="shared-row-main">
                            <span className="shared-row-title">{i.name}</span>
                            <span className="sync-ws-meta">
                              invite waiting
                              {i.expiresAt
                                ? ` · expires ${new Date(i.expiresAt).toLocaleDateString()}`
                                : ""}
                            </span>
                          </div>
                          <div className="shared-row-actions">
                            <button
                              className="share-btn"
                              onClick={() =>
                                void (async () => {
                                  if (!conn) return;
                                  await cancelInvite(conn, i.id).catch((e) => console.error(e));
                                  void loadPeople();
                                })()
                              }
                            >
                              Cancel
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}

                  {created ? (
                    <div className="sync-invite-result">
                      <p>
                        Send this to <strong>{created.name}</strong> — it works once and
                        expires {created.expiresAt ? new Date(created.expiresAt).toLocaleDateString() : "in a week"}:
                      </p>
                      <div className="sync-invite-link">
                        <code>{created.joinUrl}</code>
                      </div>
                      <div className="share-buttons">
                        <button
                          className="share-btn is-primary"
                          onClick={() => void copy(created.joinUrl, "link")}
                        >
                          {copied === "link" ? "Copied ✓" : "Copy invite link"}
                        </button>
                        <button className="share-btn" onClick={() => void copy(created.code, "code")}>
                          {copied === "code" ? "Copied ✓" : "Copy code only"}
                        </button>
                        <button className="share-btn" onClick={() => setCreated(null)}>
                          Done
                        </button>
                      </div>
                    </div>
                  ) : inviteOpen ? (
                    <div className="sync-invite-form">
                      <div className="share-field">
                        <div className="share-field-label">
                          {inviteOpen === "device" ? "Device name" : "Their name"}
                        </div>
                        <input
                          className="share-field-input"
                          value={inviteName}
                          placeholder={inviteOpen === "device" ? "e.g. Studio iMac" : "e.g. Alice"}
                          onChange={(e) => setInviteName(e.target.value)}
                          autoFocus
                        />
                      </div>
                      {inviteOpen === "member" && (
                        <div className="share-field">
                          <div className="share-field-label">Workspaces they get</div>
                          {people.workspaces.length === 0 ? (
                            <div className="sync-hint">
                              No synced workspaces yet — sync one first, then invite people to it.
                            </div>
                          ) : (
                            <div className="sync-ws-picker">
                              {people.workspaces.map((w) => (
                                <label key={w.id} className="sync-ws-check">
                                  <input
                                    type="checkbox"
                                    checked={inviteWs.has(w.id)}
                                    onChange={(e) => {
                                      setInviteWs((prev) => {
                                        const next = new Set(prev);
                                        if (e.target.checked) next.add(w.id);
                                        else next.delete(w.id);
                                        return next;
                                      });
                                    }}
                                  />
                                  {w.name}
                                </label>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                      {inviteOpen === "device" && (
                        <p className="sync-hint">
                          A linked device is <strong>you</strong>, elsewhere: full access to
                          every workspace, people, and publishing on this backend.
                        </p>
                      )}
                      {inviteError && <div className="sync-error">{inviteError}</div>}
                      <div className="share-buttons">
                        <button
                          className="share-btn is-primary"
                          disabled={inviteBusy || (inviteOpen === "member" && people.workspaces.length === 0)}
                          onClick={() => void submitInvite()}
                        >
                          {inviteBusy ? "Creating…" : "Create invite"}
                        </button>
                        <button className="share-btn" onClick={() => setInviteOpen(false)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="share-buttons">
                      <button className="share-btn is-primary" onClick={() => startInvite("member")}>
                        Invite someone…
                      </button>
                      <button className="share-btn" onClick={() => startInvite("device")}>
                        Link another device…
                      </button>
                    </div>
                  )}
                </>
              )}

              <div className="sync-foot">
                This Mac appears to others as <strong>{deviceName}</strong>. Have an invite
                from someone else?{" "}
                <button className="share-all-link" onClick={onOpenConnectBackend}>
                  Connect to their backend
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
