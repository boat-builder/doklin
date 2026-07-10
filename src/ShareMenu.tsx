// Top-right share control for the active document: a pill button + popover.
// Not shared → confirm dialog with an editable auto-generated address (plus a
// domain picker when several connections are configured); shared → the live
// link with copy / open / stop-sharing actions; a settings view manages the
// configured connections (each an endpoint + token pair in
// <app_data_dir>/share.json, verified against its worker before saving).
// While unconfigured, sharing is gated: the popover shows a prompt that
// routes to the setup guide instead of the share form. App owns the registry
// and the actual push; this component owns the UX.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  generateShareId,
  newConnectionId,
  normalizeEndpoint,
  pageExists,
  shareHost,
  shareUrl,
  testShareConfig,
  SHARE_ID_RE,
  type CollectionEntry,
  type ShareConnection,
  type ShareEntry,
} from "./share";

export default function ShareMenu({
  docTitle,
  entry,
  entryConnection,
  connections,
  defaultConnectionId,
  globalDefaultId,
  shareCountFor,
  collection,
  autoOpen,
  onAutoOpenConsumed,
  onShare,
  onStopSharing,
  onToggleCollection,
  onOpenSharedPages,
  onOpenSetupGuide,
  onOpenExternal,
  onSaveConnection,
  onRemoveConnection,
  onMakeDefault,
  onRememberWorkspaceConnection,
}: {
  docTitle: string;
  entry: ShareEntry | null;
  // The connection `entry` was published to; null when the entry's connection
  // has been removed (the page is out of reach — stop just forgets it).
  entryConnection: ShareConnection | null;
  connections: ShareConnection[];
  // Where a NEW share goes unless the picker says otherwise: the workspace's
  // remembered connection, falling back to the global default.
  defaultConnectionId: string | null;
  // The global default (settings shows/sets it; may differ from the above).
  globalDefaultId: string | null;
  // How many local entries live on a connection — quoted before removing it.
  shareCountFor: (connectionId: string) => number;
  // The folder share this document sits inside (nearest one), if any, whether
  // the document is currently on its table of contents, and the connection
  // that folder share lives on (its links must use THAT domain).
  collection: {
    entry: CollectionEntry;
    included: boolean;
    connection: ShareConnection | null;
  } | null;
  // True when something outside (the tree's "Share…" context item) asked for
  // the popover to open; consumed once acted on.
  autoOpen: boolean;
  onAutoOpenConsumed: () => void;
  onShare: (id: string, connectionId: string) => Promise<void>;
  onStopSharing: () => Promise<void>;
  // Include in / remove from the surrounding folder share. Including an
  // unshared document publishes it first (App handles both steps).
  onToggleCollection: (include: boolean) => Promise<void>;
  onOpenSharedPages: () => void;
  onOpenSetupGuide: () => void;
  onOpenExternal: (url: string) => void;
  onSaveConnection: (conn: ShareConnection) => Promise<void>;
  onRemoveConnection: (id: string) => Promise<void>;
  onMakeDefault: (id: string) => Promise<void>;
  // null while no workspace folder is open (nothing to remember against).
  onRememberWorkspaceConnection: ((connectionId: string) => void) | null;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"main" | "settings">("main");
  // settings sub-state: which connection is being edited ("new" = adding one).
  const [editing, setEditing] = useState<ShareConnection | "new" | null>(null);
  // Connection id pending a remove confirmation.
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [slug, setSlug] = useState("");
  // The picker's choice for a new share; null = follow defaultConnectionId.
  const [selectedConnId, setSelectedConnId] = useState<string | null>(null);
  const [rememberForWorkspace, setRememberForWorkspace] = useState(false);
  const [busy, setBusy] = useState<
    "share" | "stop" | "save" | "remove" | "collection" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [endpointInput, setEndpointInput] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = useCallback(() => {
    setOpen((o) => {
      const next = !o;
      if (next) {
        setError(null);
        setCopied(false);
        setSlug(generateShareId());
        setView("main");
        setEditing(null);
        setConfirmRemove(null);
        setSelectedConnId(null);
        setRememberForWorkspace(false);
      }
      return next;
    });
  }, []);

  // The tree's "Share…" context item lands here: open the popover as if the
  // pill was clicked (same reset), once per request.
  useEffect(() => {
    if (!autoOpen) return;
    onAutoOpenConsumed();
    if (!open) toggle();
  }, [autoOpen, onAutoOpenConsumed, open, toggle]);

  const openSettings = useCallback(() => {
    setError(null);
    setConfirmRemove(null);
    // With nothing configured, settings IS the add-a-token form.
    setEditing(connections.length === 0 ? "new" : null);
    setEndpointInput("");
    setTokenInput("");
    setView("settings");
  }, [connections.length]);

  const startEditing = useCallback((target: ShareConnection | "new") => {
    setError(null);
    setConfirmRemove(null);
    setEditing(target);
    setEndpointInput(target === "new" ? "" : target.endpoint);
    setTokenInput(target === "new" ? "" : target.token);
  }, []);

  const saveEditing = useCallback(async () => {
    if (busy || !editing) return;
    const endpoint = normalizeEndpoint(endpointInput);
    const token = tokenInput.trim();
    if (!/^https?:\/\/\S+$/.test(endpoint)) {
      setError("The endpoint must be an http(s) URL.");
      return;
    }
    if (!token) {
      setError("Paste the share token.");
      return;
    }
    setBusy("save");
    setError(null);
    try {
      await testShareConfig({ endpoint, token });
      await onSaveConnection({
        id: editing === "new" ? newConnectionId() : editing.id,
        endpoint,
        token,
      });
      setEditing(null);
      if (connections.length === 0) setView("main");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [busy, editing, endpointInput, tokenInput, onSaveConnection, connections.length]);

  const removeConn = useCallback(
    async (id: string) => {
      if (busy) return;
      setBusy("remove");
      setError(null);
      try {
        await onRemoveConnection(id);
        setConfirmRemove(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [busy, onRemoveConnection],
  );

  // The connection a new share would go to right now.
  const selectedConn =
    connections.find((c) => c.id === (selectedConnId ?? defaultConnectionId)) ??
    connections[0] ??
    null;

  const confirmShare = useCallback(async () => {
    if (!selectedConn || busy) return;
    const id = slug.trim().toLowerCase();
    if (!SHARE_ID_RE.test(id) || id === "api") {
      setError("Use 3–64 characters: a–z, 0–9, dashes.");
      return;
    }
    setBusy("share");
    setError(null);
    try {
      if (await pageExists(selectedConn, id)) {
        setError("That address is already taken.");
        return;
      }
      await onShare(id, selectedConn.id);
      if (rememberForWorkspace) onRememberWorkspaceConnection?.(selectedConn.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [selectedConn, slug, busy, onShare, rememberForWorkspace, onRememberWorkspaceConnection]);

  const stop = useCallback(async () => {
    if (busy) return;
    setBusy("stop");
    setError(null);
    try {
      await onStopSharing();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [busy, onStopSharing]);

  const copy = useCallback(async () => {
    if (!entry || !entryConnection) return;
    try {
      await navigator.clipboard.writeText(shareUrl(entryConnection, entry.id));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (e) {
      console.error("copy link failed", e);
    }
  }, [entry, entryConnection]);

  const toggleCollection = useCallback(async () => {
    if (!collection || busy) return;
    setBusy("collection");
    setError(null);
    try {
      await onToggleCollection(!collection.included);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [collection, busy, onToggleCollection]);

  // Unconfigured + not explicitly editing settings → the setup prompt. The
  // share form itself only ever renders with a working connection behind it.
  const showSetupPrompt = connections.length === 0 && view !== "settings";
  const showSettings = view === "settings";

  const openGuide = useCallback(() => {
    setOpen(false);
    onOpenSetupGuide();
  }, [onOpenSetupGuide]);

  return (
    <div ref={wrapRef} className="share-wrap">
      <button
        className={`share-button ${entry ? "is-shared" : ""}`}
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={entry ? "Shared — manage link" : "Share this note"}
      >
        <ShareIcon />
        <span>{entry ? "Shared" : "Share"}</span>
      </button>
      {open && (
        <div className="share-popover" role="dialog" aria-label="Share">
          {showSetupPrompt ? (
            <>
              <div className="share-heading">Sharing isn't set up yet</div>
              <div className="share-note">
                Sharing publishes read-only copies of your notes through your
                own Cloudflare account (free) — on your own domain if you have
                one. A one-time setup, about ten minutes, before the first
                share.
              </div>
              <div className="share-buttons">
                <button className="share-btn is-primary" onClick={openGuide}>
                  Set up sharing…
                </button>
                <button className="share-btn" onClick={openSettings}>
                  I have a token
                </button>
              </div>
            </>
          ) : showSettings ? (
            <>
              <div className="share-heading">Sharing settings</div>
              {editing ? (
                <>
                  <div className="share-note">
                    {editing === "new" ? (
                      <>
                        Connect a share backend: its URL and the token that
                        authorizes this app (the worker's{" "}
                        <code>SHARE_TOKEN</code> secret). Stored only on this
                        machine.
                      </>
                    ) : (
                      <>
                        Update this connection — the URL pages publish under,
                        and the token that must match the worker's{" "}
                        <code>SHARE_TOKEN</code> secret.
                      </>
                    )}
                  </div>
                  <div className="share-field">
                    <div className="share-field-label">Endpoint</div>
                    <input
                      className="share-field-input"
                      value={endpointInput}
                      onChange={(e) => setEndpointInput(e.target.value)}
                      spellCheck={false}
                      autoCapitalize="off"
                      autoCorrect="off"
                      placeholder="https://notes.example.com"
                      aria-label="Share endpoint"
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
                      placeholder="paste the share token"
                      aria-label="Share token"
                    />
                  </div>
                  <div className="share-buttons">
                    <button
                      className="share-btn is-primary"
                      onClick={() => void saveEditing()}
                      disabled={busy != null}
                    >
                      {busy === "save" ? "Checking…" : "Verify & save"}
                    </button>
                    <button
                      className="share-btn"
                      onClick={() =>
                        connections.length === 0 ? setView("main") : setEditing(null)
                      }
                    >
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="share-note">
                    The domains this app publishes to. New shares go to the
                    default; the share dialog can pick per page.
                  </div>
                  <ul className="share-conn-list">
                    {connections.map((c) => (
                      <li key={c.id} className="share-conn-row">
                        <div className="share-conn-main">
                          <span className="share-conn-host" title={c.endpoint}>
                            {shareHost(c)}
                          </span>
                          {c.id === globalDefaultId && (
                            <span className="share-conn-default">default</span>
                          )}
                        </div>
                        {confirmRemove === c.id ? (
                          <div className="share-conn-actions">
                            <span className="share-conn-hint">
                              {(() => {
                                const count = shareCountFor(c.id);
                                return count > 0
                                  ? `${count} shared ${
                                      count === 1 ? "page stays" : "pages stay"
                                    } live but can't be updated from here.`
                                  : "Nothing shared here.";
                              })()}
                            </span>
                            <button
                              className="share-btn is-danger"
                              onClick={() => void removeConn(c.id)}
                              disabled={busy != null}
                            >
                              {busy === "remove" ? "Removing…" : "Confirm"}
                            </button>
                            <button
                              className="share-btn"
                              onClick={() => setConfirmRemove(null)}
                            >
                              Keep
                            </button>
                          </div>
                        ) : (
                          <div className="share-conn-actions">
                            {c.id !== globalDefaultId && (
                              <button
                                className="share-btn"
                                onClick={() => void onMakeDefault(c.id)}
                                title="New shares go here unless picked otherwise"
                              >
                                Make default
                              </button>
                            )}
                            <button className="share-btn" onClick={() => startEditing(c)}>
                              Edit
                            </button>
                            <button
                              className="share-btn is-danger"
                              onClick={() => setConfirmRemove(c.id)}
                            >
                              Remove
                            </button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                  <div className="share-buttons">
                    <button className="share-btn is-primary" onClick={openGuide}>
                      Add a domain…
                    </button>
                    <button className="share-btn" onClick={() => startEditing("new")}>
                      I have a token
                    </button>
                    <button className="share-btn" onClick={() => setView("main")}>
                      Back
                    </button>
                  </div>
                </>
              )}
              {error && <div className="share-error">{error}</div>}
              <div className="share-footer-links">
                <button className="share-all-link" onClick={openGuide}>
                  Setup guide…
                </button>
              </div>
            </>
          ) : entry ? (
            <>
              <div className="share-heading" title={docTitle}>
                {docTitle}
              </div>
              {entryConnection ? (
                <>
                  <div className="share-note">
                    Anyone with the link can view this page. It updates as you
                    save.
                  </div>
                  <div className="share-url-row">
                    <span className="share-url" title={shareUrl(entryConnection, entry.id)}>
                      {shareHost(entryConnection)}/{entry.id}
                    </span>
                  </div>
                  <div className="share-buttons">
                    <button className="share-btn is-primary" onClick={() => void copy()}>
                      {copied ? "Copied" : "Copy link"}
                    </button>
                    <button
                      className="share-btn"
                      onClick={() => onOpenExternal(shareUrl(entryConnection, entry.id))}
                    >
                      Open
                    </button>
                    <button
                      className="share-btn is-danger"
                      onClick={() => void stop()}
                      disabled={busy != null}
                    >
                      {busy === "stop" ? "Stopping…" : "Stop sharing"}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="share-note">
                    The domain this page was shared on is no longer configured
                    here. The public copy stays live; stopping only forgets it
                    on this Mac.
                  </div>
                  <div className="share-buttons">
                    <button
                      className="share-btn is-danger"
                      onClick={() => void stop()}
                      disabled={busy != null}
                    >
                      {busy === "stop" ? "Forgetting…" : "Forget share"}
                    </button>
                  </div>
                </>
              )}
              {error && <div className="share-error">{error}</div>}
            </>
          ) : (
            <>
              <div className="share-heading" title={docTitle}>
                Share “{docTitle}”
              </div>
              <div className="share-note">
                Publishes a read-only copy at this address and keeps it in sync
                as you save.
              </div>
              <div className="share-url-row">
                {connections.length > 1 ? (
                  <select
                    className="share-conn-select"
                    value={selectedConn?.id ?? ""}
                    onChange={(e) => {
                      setSelectedConnId(e.target.value);
                      setRememberForWorkspace(false);
                    }}
                    aria-label="Share domain"
                  >
                    {connections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {shareHost(c)}/
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="share-url-prefix">{shareHost(selectedConn)}/</span>
                )}
                <input
                  className="share-slug-input"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void confirmShare();
                  }}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  aria-label="Share address"
                />
                <button
                  className="share-regen"
                  onClick={() => setSlug(generateShareId())}
                  title="New address"
                  aria-label="Generate a new address"
                >
                  <RefreshIcon />
                </button>
              </div>
              {connections.length > 1 &&
                onRememberWorkspaceConnection &&
                selectedConn &&
                selectedConn.id !== defaultConnectionId && (
                  <label className="share-remember">
                    <input
                      type="checkbox"
                      checked={rememberForWorkspace}
                      onChange={(e) => setRememberForWorkspace(e.target.checked)}
                    />
                    <span>Use this domain for this workspace from now on</span>
                  </label>
                )}
              <div className="share-buttons">
                <button
                  className="share-btn is-primary"
                  onClick={() => void confirmShare()}
                  disabled={busy != null}
                >
                  {busy === "share" ? "Sharing…" : "Share"}
                </button>
                <button className="share-btn" onClick={() => setOpen(false)}>
                  Cancel
                </button>
              </div>
              {error && <div className="share-error">{error}</div>}
            </>
          )}
          {!showSettings && !showSetupPrompt && collection && (
            <div className="share-collection">
              <div className="share-collection-text">
                <button
                  className="share-collection-name"
                  onClick={() =>
                    collection.connection &&
                    onOpenExternal(shareUrl(collection.connection, collection.entry.id))
                  }
                  title={
                    collection.connection
                      ? shareUrl(collection.connection, collection.entry.id)
                      : collection.entry.title
                  }
                >
                  <FolderGlyph />
                  <span>{collection.entry.title}</span>
                </button>
                <span className="share-collection-hint">
                  {collection.included ? "On the folder page" : "Not on the folder page"}
                </span>
              </div>
              <button
                className="share-btn"
                onClick={() => void toggleCollection()}
                disabled={busy != null}
              >
                {busy === "collection"
                  ? collection.included
                    ? "Removing…"
                    : "Including…"
                  : collection.included
                    ? "Remove"
                    : "Include"}
              </button>
            </div>
          )}
          {!showSettings && !showSetupPrompt && (
            <div className="share-footer-links">
              <button
                className="share-all-link"
                onClick={() => {
                  setOpen(false);
                  onOpenSharedPages();
                }}
              >
                All shared pages…
              </button>
              <button className="share-all-link" onClick={openSettings}>
                Sharing settings…
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FolderGlyph() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" />
      <polyline points="16 6 12 2 8 6" />
      <line x1="12" y1="2" x2="12" y2="15" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <polyline points="21 3 21 9 15 9" />
    </svg>
  );
}
