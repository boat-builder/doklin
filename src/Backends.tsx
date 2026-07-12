// "Backends" — the gear menu's home for every backend this Mac is connected
// to. One row per connection: whose it is (yours vs shared with you, via
// whoami), what on this Mac depends on it (synced workspaces, published
// pages), and the actions that manage the CONNECTION itself — make default,
// edit the credentials, disconnect. Content stays in its own dialogs and is
// linked from here: workspaces + people in Cloud sync, public pages in
// Shared pages.
//
// Disconnecting is local by design: App stops this Mac's sync engines for
// the backend's workspaces (local files stay), forgets the credentials, and
// leaves the backend — and every published page — untouched. The confirm
// step spells out exactly that, and warns a member that coming back needs a
// fresh invite (their key is deleted locally and invites are one-time).

import { useEffect, useState } from "react";
import {
  newConnectionId,
  normalizeEndpoint,
  shareHost,
  testShareConfig,
  type ShareConnection,
} from "./share";
import { whoami, SyncWorkerOutdatedError, type SyncWorkspaceStatus, type WhoAmI } from "./sync";

// What we know about a connection's identity on its backend. "outdated"
// (worker predates the auth API) implies owner in practice — members can only
// exist on workers new enough to mint them — but we label it neutrally.
type Identity =
  | { kind: "loading" }
  | { kind: "ok"; me: WhoAmI }
  | { kind: "outdated" }
  | { kind: "unreachable" };

export default function Backends({
  connections,
  defaultId,
  statuses,
  shareCountFor,
  outdatedIds,
  onClose,
  onOpenExternal,
  onOpenSetup,
  onOpenConnectBackend,
  onOpenWorkerUpdate,
  onOpenCloudSync,
  onOpenSharedPages,
  onSaveConnection,
  onMakeDefault,
  onDisconnect,
  onTeardown,
}: {
  connections: ShareConnection[];
  defaultId: string | null;
  statuses: SyncWorkspaceStatus[];
  // How many published pages + folder shares live on a connection.
  shareCountFor: (connectionId: string) => number;
  // Connection ids whose deployed worker is older than the bundled code.
  outdatedIds: string[];
  onClose: () => void;
  onOpenExternal: (url: string) => void;
  onOpenSetup: () => void;
  onOpenConnectBackend: () => void;
  onOpenWorkerUpdate: (() => void) | null;
  onOpenCloudSync: () => void;
  onOpenSharedPages: () => void;
  onSaveConnection: (conn: ShareConnection) => Promise<void>;
  onMakeDefault: (id: string) => Promise<void>;
  // Disables sync for the backend's workspaces on this Mac, then removes the
  // connection (App owns both steps).
  onDisconnect: (id: string) => Promise<void>;
  // Opens the guided teardown (erase data, remove worker + bucket) for a
  // backend this user owns.
  onTeardown: (conn: ShareConnection) => void;
}) {
  const [identities, setIdentities] = useState<Record<string, Identity>>({});
  // Connection id pending the disconnect confirmation.
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Which connection is being edited ("new" = the manual add form).
  const [editing, setEditing] = useState<ShareConnection | "new" | null>(null);
  const [endpointInput, setEndpointInput] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Who this Mac is on each backend. Reprobed on every connections change —
  // cheap (one request each), and a token edit must refresh the answer.
  useEffect(() => {
    let cancelled = false;
    setIdentities((prev) => {
      const next: Record<string, Identity> = {};
      for (const c of connections) next[c.id] = prev[c.id] ?? { kind: "loading" };
      return next;
    });
    for (const conn of connections) {
      void whoami(conn)
        .then((me) => {
          if (!cancelled) {
            setIdentities((prev) => ({ ...prev, [conn.id]: { kind: "ok", me } }));
          }
        })
        .catch((e) => {
          if (!cancelled) {
            setIdentities((prev) => ({
              ...prev,
              [conn.id]:
                e instanceof SyncWorkerOutdatedError
                  ? { kind: "outdated" }
                  : { kind: "unreachable" },
            }));
          }
        });
    }
    return () => {
      cancelled = true;
    };
  }, [connections]);

  const startEditing = (target: ShareConnection | "new") => {
    setError(null);
    setConfirmId(null);
    setEditing(target);
    setEndpointInput(target === "new" ? "" : target.endpoint);
    setTokenInput(target === "new" ? "" : target.token);
  };

  const saveEditing = async () => {
    if (saving || !editing) return;
    const endpoint = normalizeEndpoint(endpointInput);
    const token = tokenInput.trim();
    if (!/^https?:\/\/\S+$/.test(endpoint)) {
      setError("The endpoint must be an http(s) URL — your worker's address.");
      return;
    }
    if (!token) {
      setError("Paste the share token (the value stored as SHARE_TOKEN).");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await testShareConfig({ endpoint, token });
      await onSaveConnection({
        id: editing === "new" ? newConnectionId() : editing.id,
        endpoint,
        token,
      });
      setEditing(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async (id: string) => {
    if (busyId) return;
    setBusyId(id);
    setError(null);
    try {
      await onDisconnect(id);
      setConfirmId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const identityLine = (connId: string): string => {
    const idn = identities[connId];
    switch (idn?.kind) {
      case "ok":
        return idn.me.role === "owner"
          ? "Yours — you own this backend"
          : `Shared with you — connected as “${idn.me.name}”`;
      case "outdated":
        return "Worker predates cloud sync";
      case "unreachable":
        return "Can't reach it right now";
      default:
        return "Checking…";
    }
  };

  const countsLine = (connId: string): string => {
    const wsCount = statuses.filter((s) => s.connectionId === connId).length;
    const pageCount = shareCountFor(connId);
    const parts = [
      wsCount > 0 ? `${wsCount} synced ${wsCount === 1 ? "workspace" : "workspaces"}` : null,
      pageCount > 0 ? `${pageCount} published ${pageCount === 1 ? "page" : "pages"}` : null,
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(" · ") : "nothing synced or published from this Mac";
  };

  const editForm = (
    <div className="backend-form">
      <div className="share-field">
        <div className="share-field-label">Endpoint</div>
        <input
          className="share-field-input"
          value={endpointInput}
          onChange={(e) => setEndpointInput(e.target.value)}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder="https://doklin-share.your-name.workers.dev"
          aria-label="Backend endpoint"
          autoFocus
        />
      </div>
      <div className="share-field">
        <div className="share-field-label">Token</div>
        <input
          className="share-field-input share-field-token"
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void saveEditing();
          }}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder="the SHARE_TOKEN value"
          aria-label="Backend token"
        />
      </div>
      <div className="share-buttons">
        <button
          className="share-btn is-primary"
          onClick={() => void saveEditing()}
          disabled={saving}
        >
          {saving ? "Checking…" : "Verify & save"}
        </button>
        <button className="share-btn" onClick={() => setEditing(null)}>
          Cancel
        </button>
      </div>
    </div>
  );

  return (
    <div
      className="shared-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="shared-modal sync-modal" role="dialog" aria-modal="true" aria-label="Backends">
        <div className="shared-modal-header">
          <div className="shared-modal-title">Backends</div>
          <button className="shared-modal-close" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>

        <div className="sync-body">
          {connections.length === 0 ? (
            <div className="shared-empty">
              <p>
                A backend is a small worker + storage bucket on a Cloudflare account: it
                publishes the pages you share and privately syncs workspaces across Macs
                and people. Set up your own, or connect to someone else's with an invite.
              </p>
              <button
                className="share-btn is-primary shared-empty-action"
                onClick={() => {
                  onClose();
                  onOpenSetup();
                }}
              >
                Set up your backend…
              </button>
              <p className="sync-hint">
                Someone sent you an invite?{" "}
                <button
                  className="share-all-link"
                  onClick={() => {
                    onClose();
                    onOpenConnectBackend();
                  }}
                >
                  Connect to their backend
                </button>
              </p>
            </div>
          ) : (
            <>
              <ul className="backend-list">
                {connections.map((c) => {
                  const isDefault = c.id === defaultId;
                  const outdated = outdatedIds.includes(c.id);
                  const wsCount = statuses.filter((s) => s.connectionId === c.id).length;
                  const pageCount = shareCountFor(c.id);
                  const idn = identities[c.id];
                  const role = idn?.kind === "ok" ? idn.me.role : null;
                  return (
                    <li key={c.id} className="backend-row">
                      <div className="backend-row-head">
                        <button
                          className="shared-site-host"
                          onClick={() => onOpenExternal(`${c.endpoint}/`)}
                          title={`Open ${c.endpoint}/`}
                        >
                          {shareHost(c)}
                        </button>
                        {isDefault && <span className="share-conn-default">default</span>}
                        {role === "member" && (
                          <span className="share-conn-default backend-badge-member">
                            invited
                          </span>
                        )}
                      </div>
                      <div className="sync-ws-meta backend-row-meta">
                        {identityLine(c.id)} · {countsLine(c.id)}
                      </div>
                      {outdated && (
                        <div className="backend-outdated">
                          A newer backend worker is available.
                          {onOpenWorkerUpdate && (
                            <button
                              className="share-all-link"
                              onClick={() => {
                                onClose();
                                onOpenWorkerUpdate();
                              }}
                            >
                              Update…
                            </button>
                          )}
                        </div>
                      )}
                      {editing !== "new" && editing?.id === c.id ? (
                        editForm
                      ) : confirmId === c.id ? (
                        <div className="backend-confirm">
                          <div className="backend-confirm-title">
                            Disconnect this Mac from {shareHost(c)}?
                          </div>
                          <ul className="backend-confirm-list">
                            {wsCount > 0 && (
                              <li>
                                {wsCount === 1
                                  ? "1 synced workspace stops syncing"
                                  : `${wsCount} synced workspaces stop syncing`}{" "}
                                on this Mac. The local folders stay put, and the backend
                                keeps its copies.
                              </li>
                            )}
                            {pageCount > 0 && (
                              <li>
                                {pageCount === 1
                                  ? "1 published page stays live"
                                  : `${pageCount} published pages stay live`}{" "}
                                on {shareHost(c)}, but this Mac can no longer update or
                                unpublish {pageCount === 1 ? "it" : "them"}. Stop sharing
                                anything you want offline first.
                              </li>
                            )}
                            {wsCount === 0 && pageCount === 0 && (
                              <li>Nothing on this Mac depends on it.</li>
                            )}
                            {role === "member" ? (
                              <li>
                                Your access key is deleted from this Mac — connecting again
                                takes a fresh invite from the owner. If you're leaving for
                                good, ask them to also revoke this device.
                              </li>
                            ) : (
                              <li>
                                The backend itself keeps running on its Cloudflare account —
                                connecting again just takes the endpoint and token. To take
                                it down for good, use <strong>Delete backend</strong> instead.
                              </li>
                            )}
                          </ul>
                          <div className="share-buttons">
                            <button
                              className="share-btn is-danger"
                              onClick={() => void disconnect(c.id)}
                              disabled={busyId != null}
                            >
                              {busyId === c.id ? "Disconnecting…" : "Disconnect"}
                            </button>
                            <button className="share-btn" onClick={() => setConfirmId(null)}>
                              Keep
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="share-conn-actions">
                          {!isDefault && (
                            <button
                              className="share-btn"
                              onClick={() => void onMakeDefault(c.id)}
                              title="New shares and newly synced workspaces go here unless picked otherwise"
                            >
                              Make default
                            </button>
                          )}
                          <button className="share-btn" onClick={() => startEditing(c)}>
                            Edit…
                          </button>
                          <button
                            className="share-btn is-danger"
                            onClick={() => {
                              setError(null);
                              setEditing(null);
                              setConfirmId(c.id);
                            }}
                          >
                            Disconnect…
                          </button>
                          {/* Teardown is the owner's move; a pre-sync worker
                              can't have members, so "outdated" is owner too. */}
                          {(role === "owner" || idn?.kind === "outdated") && (
                            <button
                              className="share-btn is-danger"
                              title="Erase its data and remove the worker + bucket from Cloudflare — the whole backend, not just this Mac's connection"
                              onClick={() => onTeardown(c)}
                            >
                              Delete backend…
                            </button>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>

              {editing === "new" ? (
                editForm
              ) : (
                <div className="share-buttons">
                  <button
                    className="share-btn is-primary"
                    onClick={() => {
                      onClose();
                      onOpenSetup();
                    }}
                  >
                    Add a backend…
                  </button>
                  <button
                    className="share-btn"
                    onClick={() => {
                      onClose();
                      onOpenConnectBackend();
                    }}
                  >
                    Connect with an invite…
                  </button>
                  <button className="share-btn" onClick={() => startEditing("new")}>
                    I have a token
                  </button>
                </div>
              )}

              <div className="sync-foot">
                Workspaces, people, and invites live in{" "}
                <button
                  className="share-all-link"
                  onClick={() => {
                    onClose();
                    onOpenCloudSync();
                  }}
                >
                  Cloud sync
                </button>
                ; public pages in{" "}
                <button
                  className="share-all-link"
                  onClick={() => {
                    onClose();
                    onOpenSharedPages();
                  }}
                >
                  Shared pages
                </button>
              </div>
            </>
          )}
          {error && <div className="sync-error">{error}</div>}
        </div>
      </div>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      aria-hidden
    >
      <line x1="5" y1="5" x2="19" y2="19" />
      <line x1="19" y1="5" x2="5" y2="19" />
    </svg>
  );
}
