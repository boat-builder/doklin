// "Shared pages" modal: every live share on the configured backend, newest
// first — shared folders (collections) in their own group above the pages.
// Clicking a page row opens the source document in a tab; each row can copy
// its link, open it in the browser, or stop sharing (which deletes the remote
// copy). Folder rows route to the folder-share dialog for management, since
// stopping a folder needs its keep-or-stop-the-pages choice.

import { useEffect, useState } from "react";
import {
  shareHost,
  shareUrl,
  type CollectionEntry,
  type ShareConfig,
  type ShareEntry,
} from "./share";

export default function SharedPages({
  shares,
  collections,
  config,
  onClose,
  onOpenDoc,
  onManageCollection,
  onOpenExternal,
  onOpenSetup,
  onStopSharing,
}: {
  shares: ShareEntry[];
  collections: CollectionEntry[];
  config: ShareConfig | null;
  onClose: () => void;
  onOpenDoc: (entry: ShareEntry) => void;
  onManageCollection: (entry: CollectionEntry) => void;
  onOpenExternal: (url: string) => void;
  onOpenSetup: () => void;
  onStopSharing: (entry: ShareEntry) => Promise<void>;
}) {
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const host = shareHost(config);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copyUrl = async (key: string, id: string) => {
    try {
      await navigator.clipboard.writeText(shareUrl(config, id));
      setCopiedPath(key);
      window.setTimeout(() => setCopiedPath((p) => (p === key ? null : p)), 1600);
    } catch (e) {
      console.error("copy link failed", e);
    }
  };

  const stop = async (entry: ShareEntry) => {
    setBusyPath(entry.path);
    setError(null);
    try {
      await onStopSharing(entry);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyPath(null);
    }
  };

  return (
    <div
      className="shared-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="shared-modal" role="dialog" aria-modal="true" aria-label="Shared pages">
        <div className="shared-modal-header">
          <div className="shared-modal-title">Shared pages</div>
          <button className="shared-modal-close" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        {!config ? (
          // Without a config there's no host to build links from and no way to
          // push or stop shares — route to setup instead of a dead list.
          <div className="shared-empty">
            <div>Sharing isn't set up on this Mac yet.</div>
            <button
              className="share-btn is-primary shared-empty-action"
              onClick={() => {
                onClose();
                onOpenSetup();
              }}
            >
              Set up sharing…
            </button>
          </div>
        ) : shares.length === 0 && collections.length === 0 ? (
          <div className="shared-empty">
            Nothing is shared yet. Open a note and hit Share.
          </div>
        ) : (
          <>
            {collections.length > 0 && (
              <>
                <div className="shared-section-label">Folders</div>
                <ul className="shared-list">
                  {collections.map((c) => (
                    <li key={c.path} className="shared-row">
                      <button
                        className="shared-row-main"
                        onClick={() => onManageCollection(c)}
                        title={`Manage the share for ${c.path}`}
                      >
                        <span className="shared-row-title">{c.title}</span>
                        <span
                          className="shared-row-url"
                          title={`Updated ${new Date(c.updatedAt).toLocaleString()}`}
                        >
                          {host}/{c.id} · {c.members.length}{" "}
                          {c.members.length === 1 ? "page" : "pages"}
                        </span>
                      </button>
                      <div className="shared-row-actions">
                        <button className="share-btn" onClick={() => void copyUrl(c.path, c.id)}>
                          {copiedPath === c.path ? "Copied" : "Copy"}
                        </button>
                        <button
                          className="share-btn"
                          onClick={() => onOpenExternal(shareUrl(config, c.id))}
                        >
                          Open
                        </button>
                        <button className="share-btn" onClick={() => onManageCollection(c)}>
                          Manage
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {collections.length > 0 && shares.length > 0 && (
              <div className="shared-section-label">Pages</div>
            )}
            {shares.length > 0 && (
              <ul className="shared-list">
                {shares.map((s) => (
                  <li key={s.path} className="shared-row">
                    <button
                      className="shared-row-main"
                      onClick={() => onOpenDoc(s)}
                      title={`Open ${s.path}`}
                    >
                      <span className="shared-row-title">{s.title}</span>
                      <span
                        className="shared-row-url"
                        title={`Updated ${new Date(s.updatedAt).toLocaleString()}`}
                      >
                        {host}/{s.id}
                      </span>
                    </button>
                    <div className="shared-row-actions">
                      <button className="share-btn" onClick={() => void copyUrl(s.path, s.id)}>
                        {copiedPath === s.path ? "Copied" : "Copy"}
                      </button>
                      <button
                        className="share-btn"
                        onClick={() => onOpenExternal(shareUrl(config, s.id))}
                      >
                        Open
                      </button>
                      <button
                        className="share-btn is-danger"
                        onClick={() => void stop(s)}
                        disabled={busyPath === s.path}
                      >
                        {busyPath === s.path ? "Stopping…" : "Stop"}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {error && <div className="share-error">{error}</div>}
      </div>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
