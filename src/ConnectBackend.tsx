// "Connect to a shared backend…" — the receiving end of an invite.
//
// Paste the invite link (or bare code + backend URL) → the app exchanges it
// for this device's own token, saves the connection into share.json, lists
// the workspaces the invite granted, and pulls whichever ones you want onto
// this Mac. Each pulled workspace opens like any local folder — because from
// then on it IS one, with an engine keeping it in sync.

import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { newConnectionId, normalizeEndpoint, shareHost, type ShareConnection } from "./share";
import {
  joinBackend,
  listRemoteWorkspaces,
  parseInviteInput,
  syncConnect,
  type RemoteWorkspace,
  type SyncProgressEvent,
} from "./sync";

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
      <line x1="5" y1="5" x2="19" y2="19" />
      <line x1="19" y1="5" x2="5" y2="19" />
    </svg>
  );
}

type WsRow = RemoteWorkspace & {
  state: "idle" | "pulling" | "done" | "error";
  root?: string;
  error?: string;
};

export default function ConnectBackend({
  deviceName,
  onSaveConnection,
  onOpenWorkspace,
  onClose,
}: {
  deviceName: string;
  // Persists the new connection into share.json (App's saveConnection).
  onSaveConnection: (conn: ShareConnection) => Promise<void>;
  // Open a freshly pulled folder as the workspace.
  onOpenWorkspace: (root: string) => void;
  onClose: () => void;
}) {
  const [input, setInput] = useState("");
  const [endpointInput, setEndpointInput] = useState("");
  const [needEndpoint, setNeedEndpoint] = useState(false);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Set once the join succeeds.
  const [joined, setJoined] = useState<{
    conn: ShareConnection;
    name: string;
    workspaces: WsRow[];
  } | null>(null);
  const [progress, setProgress] = useState<SyncProgressEvent | null>(null);

  useEffect(() => {
    const un = listen<SyncProgressEvent>("sync-progress", (e) => setProgress(e.payload));
    return () => {
      void un.then((f) => f());
    };
  }, []);

  const join = useCallback(async () => {
    setError(null);
    const parsed = parseInviteInput(input);
    if (!parsed) {
      setError("That doesn't look like an invite — paste the whole link or the dk_i_… code.");
      return;
    }
    let endpoint = parsed.endpoint;
    if (!endpoint) {
      const manual = normalizeEndpoint(endpointInput);
      if (!/^https?:\/\/\S+$/.test(manual)) {
        setNeedEndpoint(true);
        setError(
          endpointInput.trim()
            ? "Enter the backend's full address, like https://docs.example.com"
            : "That's a bare code — also enter the backend's address (the invite link's domain).",
        );
        return;
      }
      endpoint = manual;
    }
    setJoining(true);
    try {
      const result = await joinBackend(endpoint, parsed.code, deviceName);
      const conn: ShareConnection = {
        id: newConnectionId(),
        endpoint: normalizeEndpoint(endpoint),
        token: result.token,
      };
      await onSaveConnection(conn);
      const workspaces = await listRemoteWorkspaces(conn);
      setJoined({
        conn,
        name: result.name,
        workspaces: workspaces.map((w) => ({ ...w, state: "idle" })),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setJoining(false);
    }
  }, [input, endpointInput, deviceName, onSaveConnection]);

  const pull = useCallback(
    async (ws: WsRow) => {
      if (!joined) return;
      const dest = await openDialog({
        directory: true,
        multiple: false,
        title: `Where should “${ws.name}” live?`,
      });
      if (typeof dest !== "string") return;
      setJoined((prev) =>
        prev && {
          ...prev,
          workspaces: prev.workspaces.map((w) =>
            w.id === ws.id ? { ...w, state: "pulling", error: undefined } : w,
          ),
        },
      );
      try {
        const root = await syncConnect(ws.id, ws.name, dest, joined.conn.id);
        setJoined((prev) =>
          prev && {
            ...prev,
            workspaces: prev.workspaces.map((w) =>
              w.id === ws.id ? { ...w, state: "done", root } : w,
            ),
          },
        );
      } catch (e) {
        setJoined((prev) =>
          prev && {
            ...prev,
            workspaces: prev.workspaces.map((w) =>
              w.id === ws.id ? { ...w, state: "error", error: String(e) } : w,
            ),
          },
        );
      } finally {
        setProgress(null);
      }
    },
    [joined],
  );

  return (
    <div
      className="shared-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="shared-modal sync-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Connect to a shared backend"
      >
        <div className="shared-modal-header">
          <div className="shared-modal-title">Connect to a shared backend</div>
          <button className="shared-modal-close" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>

        <div className="sync-body">
          {!joined ? (
            <>
              <p className="sync-hint">
                Someone with a Doklin backend can invite you to their workspaces: paste
                their invite link and this Mac gets its own key — their documents sync
                here, your edits sync back. No account needed.
              </p>
              <div className="share-field">
                <div className="share-field-label">Invite link or code</div>
                <input
                  className="share-field-input"
                  value={input}
                  placeholder="https://docs.example.com/join#dk_i_…"
                  onChange={(e) => {
                    setInput(e.target.value);
                    const parsed = parseInviteInput(e.target.value);
                    setNeedEndpoint(!!parsed && !parsed.endpoint);
                  }}
                  autoFocus
                  spellCheck={false}
                />
              </div>
              {needEndpoint && (
                <div className="share-field">
                  <div className="share-field-label">Backend address</div>
                  <input
                    className="share-field-input"
                    value={endpointInput}
                    placeholder="https://docs.example.com"
                    onChange={(e) => setEndpointInput(e.target.value)}
                    spellCheck={false}
                  />
                </div>
              )}
              {error && <div className="sync-error">{error}</div>}
              <div className="share-buttons">
                <button
                  className="share-btn is-primary"
                  disabled={joining || !input.trim()}
                  onClick={() => void join()}
                >
                  {joining ? "Connecting…" : "Connect"}
                </button>
              </div>
              <p className="sync-hint">
                You'll appear to them as <strong>{deviceName}</strong>.
              </p>
            </>
          ) : (
            <>
              <p className="sync-hint">
                Connected to <strong>{shareHost(joined.conn)}</strong> as{" "}
                <strong>{joined.name}</strong>. Pick where each shared workspace should
                live on this Mac:
              </p>
              {joined.workspaces.length === 0 && (
                <div className="shared-empty">
                  <p>
                    The invite worked, but no workspaces are shared with you yet — ask the
                    owner to sync one and re-invite you to it.
                  </p>
                </div>
              )}
              <ul className="shared-list">
                {joined.workspaces.map((w) => (
                  <li key={w.id} className="shared-row">
                    <div className="shared-row-main">
                      <span className="shared-row-title">{w.name}</span>
                      {w.state === "pulling" && (
                        <span className="sync-ws-meta">
                          {progress && progress.wsId === w.id && progress.kind === "download"
                            ? `Downloading ${progress.done}/${progress.total}…`
                            : "Downloading…"}
                        </span>
                      )}
                      {w.state === "done" && w.root && (
                        <span className="sync-ws-meta" title={w.root}>
                          Synced to {w.root}
                        </span>
                      )}
                      {w.state === "error" && <span className="sync-error">{w.error}</span>}
                    </div>
                    <div className="shared-row-actions">
                      {w.state === "done" && w.root ? (
                        <button
                          className="share-btn is-primary"
                          onClick={() => {
                            onOpenWorkspace(w.root!);
                            onClose();
                          }}
                        >
                          Open
                        </button>
                      ) : (
                        <button
                          className="share-btn is-primary"
                          disabled={w.state === "pulling"}
                          onClick={() => void pull(w)}
                        >
                          {w.state === "error" ? "Retry…" : "Choose folder…"}
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              <div className="share-buttons">
                <button className="share-btn" onClick={onClose}>
                  Done
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
