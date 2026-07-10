// Top-right share control for the active document: a pill button + popover.
// Not shared → confirm dialog with an editable auto-generated address;
// shared → the live link with copy / open / stop-sharing actions; a settings
// view stores the endpoint + token in <app_data_dir>/share.json (verified
// against the worker before saving). While unconfigured, sharing is gated:
// the popover shows a prompt that routes to the setup guide instead of the
// share form. App owns the registry and the actual push; this component owns
// the UX.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  deleteShareConfig,
  generateShareId,
  pageExists,
  saveShareConfig,
  shareHost,
  shareUrl,
  testShareConfig,
  SHARE_ID_RE,
  type CollectionEntry,
  type ShareConfig,
  type ShareEntry,
} from "./share";

export default function ShareMenu({
  docTitle,
  entry,
  config,
  collection,
  onShare,
  onStopSharing,
  onToggleCollection,
  onOpenSharedPages,
  onOpenSetupGuide,
  onOpenExternal,
  onConfigChanged,
  onConfigDeleted,
}: {
  docTitle: string;
  entry: ShareEntry | null;
  config: ShareConfig | null;
  // The folder share this document sits inside (nearest one), if any, and
  // whether the document is currently on its table of contents.
  collection: { entry: CollectionEntry; included: boolean } | null;
  onShare: (id: string) => Promise<void>;
  onStopSharing: () => Promise<void>;
  // Include in / remove from the surrounding folder share. Including an
  // unshared document publishes it first (App handles both steps).
  onToggleCollection: (include: boolean) => Promise<void>;
  onOpenSharedPages: () => void;
  onOpenSetupGuide: () => void;
  onOpenExternal: (url: string) => void;
  onConfigChanged: (config: ShareConfig) => void;
  onConfigDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"main" | "settings">("main");
  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState<"share" | "stop" | "save" | "forget" | "collection" | null>(
    null,
  );
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
        setEndpointInput(config?.endpoint ?? "");
        setTokenInput(config?.token ?? "");
      }
      return next;
    });
  }, [config]);

  const openSettings = useCallback(() => {
    setError(null);
    setEndpointInput(config?.endpoint ?? "");
    setTokenInput(config?.token ?? "");
    setView("settings");
  }, [config]);

  const saveSettings = useCallback(async () => {
    if (busy) return;
    const endpoint = endpointInput.trim().replace(/\/+$/, "");
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
      const next = { endpoint, token };
      await testShareConfig(next);
      await saveShareConfig(next);
      onConfigChanged(next);
      setView("main");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [busy, endpointInput, tokenInput, onConfigChanged]);

  const forgetConfig = useCallback(async () => {
    if (busy) return;
    setBusy("forget");
    setError(null);
    try {
      await deleteShareConfig();
      onConfigDeleted();
      setTokenInput("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [busy, onConfigDeleted]);

  const confirmShare = useCallback(async () => {
    if (!config || busy) return;
    const id = slug.trim().toLowerCase();
    if (!SHARE_ID_RE.test(id) || id === "api") {
      setError("Use 3–64 characters: a–z, 0–9, dashes.");
      return;
    }
    setBusy("share");
    setError(null);
    try {
      if (await pageExists(config, id)) {
        setError("That address is already taken.");
        return;
      }
      await onShare(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [config, slug, busy, onShare]);

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
    if (!entry) return;
    try {
      await navigator.clipboard.writeText(shareUrl(config, entry.id));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (e) {
      console.error("copy link failed", e);
    }
  }, [entry, config]);

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

  const host = shareHost(config);
  // Unconfigured + not explicitly editing settings → the setup prompt. The
  // share form itself only ever renders with a working config behind it.
  const showSetupPrompt = !config && view !== "settings";
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
                own Cloudflare account (free). A one-time setup — about ten
                minutes — is needed before the first share.
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
              <div className="share-heading">Sharing setup</div>
              <div className="share-note">
                Where pages get published, and the token that authorizes this
                app. Both are stored only on this machine
                (<code>share.json</code> in the app data folder); the token must
                match the share worker's <code>SHARE_TOKEN</code> secret.
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
                  placeholder="https://your-share-worker.example.com"
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
                    if (e.key === "Enter") void saveSettings();
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
                  onClick={() => void saveSettings()}
                  disabled={busy != null}
                >
                  {busy === "save" ? "Checking…" : "Verify & save"}
                </button>
                <button className="share-btn" onClick={() => setView("main")}>
                  Cancel
                </button>
                {config && (
                  <button
                    className="share-btn is-danger"
                    onClick={() => void forgetConfig()}
                    disabled={busy != null}
                    title="Delete share.json from this Mac. Already-shared pages stay live."
                  >
                    {busy === "forget" ? "Removing…" : "Remove token"}
                  </button>
                )}
              </div>
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
              <div className="share-note">
                Anyone with the link can view this page. It updates as you save.
              </div>
              <div className="share-url-row">
                <span className="share-url" title={shareUrl(config, entry.id)}>
                  {host}/{entry.id}
                </span>
              </div>
              <div className="share-buttons">
                <button className="share-btn is-primary" onClick={() => void copy()}>
                  {copied ? "Copied" : "Copy link"}
                </button>
                <button
                  className="share-btn"
                  onClick={() => onOpenExternal(shareUrl(config, entry.id))}
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
                <span className="share-url-prefix">{host}/</span>
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
                  onClick={() => onOpenExternal(shareUrl(config, collection.entry.id))}
                  title={shareUrl(config, collection.entry.id)}
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
