// "Shared pages" modal: every live share, newest first — shared folders
// (collections) in their own group above the pages. Clicking a page row opens
// the source document in a tab; each row can copy its link, open it in the
// browser, or stop sharing (which deletes the remote copy). Folder rows route
// to the folder-share dialog for management, since stopping a folder needs
// its keep-or-stop-the-pages choice.
//
// The registry is keyed by local path, so a share whose source was deleted or
// moved outside the app stays listed (the published copy is still live) —
// those rows get a "file missing" flag, and this modal is where such orphans
// get stopped manually.
//
// This modal is also where a deployment's public face is managed, per
// connection: the landing-page branding (name + profile link, stored in the
// worker via /api/site) and the home page — any shared page can replace the
// landing page at the domain root ("Use as home page" on its row).

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  fetchSiteConfig,
  pushSiteConfig,
  shareHost,
  shareUrl,
  ShareWorkerOutdatedError,
  type CollectionEntry,
  type ShareConnection,
  type ShareEntry,
  type SiteConfig,
} from "./share";

// Per-connection site state: the worker's site config, or the reason we can't
// show site controls (outdated worker / unreachable).
type SiteState =
  | { kind: "loaded"; site: SiteConfig }
  | { kind: "outdated" }
  | { kind: "unavailable" };

export default function SharedPages({
  shares,
  collections,
  connections,
  connectionFor,
  onClose,
  onOpenDoc,
  onManageCollection,
  onOpenExternal,
  onOpenSetup,
  onOpenWorkerUpdate,
  onStopSharing,
}: {
  shares: ShareEntry[];
  collections: CollectionEntry[];
  connections: ShareConnection[];
  // Which connection an entry was published to (null = since removed).
  connectionFor: (entry: { connectionId: string }) => ShareConnection | null;
  onClose: () => void;
  onOpenDoc: (entry: ShareEntry) => void;
  onManageCollection: (entry: CollectionEntry) => void;
  onOpenExternal: (url: string) => void;
  onOpenSetup: () => void;
  // Non-null when App's version probe found a worker older than the bundled
  // code — routes the outdated banner to the guided update dialog.
  onOpenWorkerUpdate: (() => void) | null;
  onStopSharing: (entry: ShareEntry) => Promise<void>;
}) {
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState<Set<string>>(() => new Set());
  const [sites, setSites] = useState<Record<string, SiteState>>({});
  // The connection whose landing-page form is expanded, and its fields.
  const [brandingConn, setBrandingConn] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [linkInput, setLinkInput] = useState("");
  const [siteBusy, setSiteBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Flag rows whose local source no longer exists. Keyed on the joined path
  // list (the arrays are rebuilt every App render) so the stat sweep runs on
  // real membership changes, not every keystroke elsewhere.
  const pathsKey = useMemo(
    () => [...shares.map((s) => s.path), ...collections.map((c) => c.path)].join("\n"),
    [shares, collections],
  );
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const gone = new Set<string>();
      for (const path of pathsKey.split("\n").filter(Boolean)) {
        const exists = await invoke<boolean>("path_exists", { path }).catch(() => true);
        if (!exists) gone.add(path);
      }
      if (!cancelled) setMissing(gone);
    })();
    return () => {
      cancelled = true;
    };
  }, [pathsKey]);

  // What each worker's site config says right now — drives the branding forms
  // and the home-page marks. A worker that predates /api/site gets a gentle
  // "redeploy to unlock" note instead of controls.
  useEffect(() => {
    let cancelled = false;
    for (const conn of connections) {
      void (async () => {
        let state: SiteState;
        try {
          state = { kind: "loaded", site: await fetchSiteConfig(conn) };
        } catch (e) {
          state =
            e instanceof ShareWorkerOutdatedError
              ? { kind: "outdated" }
              : { kind: "unavailable" };
        }
        if (!cancelled) setSites((prev) => ({ ...prev, [conn.id]: state }));
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [connections]);

  const copyUrl = async (key: string, url: string) => {
    try {
      await navigator.clipboard.writeText(url);
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

  const siteFor = (connId: string | undefined): SiteConfig | null => {
    if (!connId) return null;
    const s = sites[connId];
    return s?.kind === "loaded" ? s.site : null;
  };

  // Make (or stop making) an entry's page the domain root. Full-record PUT:
  // everything else in the site config rides along unchanged.
  const setHomePage = async (
    entry: { id: string; path: string; connectionId: string },
    make: boolean,
  ) => {
    const conn = connectionFor(entry);
    const site = conn ? siteFor(conn.id) : null;
    if (!conn || !site) return;
    setBusyPath(entry.path);
    setError(null);
    try {
      const next: SiteConfig = { ...site, rootPageId: make ? entry.id : undefined };
      delete next.updatedAt;
      await pushSiteConfig(conn, next);
      setSites((prev) => ({ ...prev, [conn.id]: { kind: "loaded", site: next } }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyPath(null);
    }
  };

  const openBranding = (conn: ShareConnection) => {
    const site = siteFor(conn.id);
    setNameInput(site?.ownerName ?? "");
    setLinkInput(site?.ownerLink ?? "");
    setBrandingConn((prev) => (prev === conn.id ? null : conn.id));
    setError(null);
  };

  const saveBranding = async (conn: ShareConnection) => {
    const site = siteFor(conn.id);
    if (!site || siteBusy) return;
    const ownerName = nameInput.trim();
    const ownerLink = linkInput.trim();
    if (ownerLink && !/^https?:\/\/\S+$/.test(ownerLink)) {
      setError("The profile link must be an http(s) URL.");
      return;
    }
    setSiteBusy(true);
    setError(null);
    try {
      const next: SiteConfig = {
        ...site,
        ownerName: ownerName || undefined,
        ownerLink: ownerLink || undefined,
      };
      delete next.updatedAt;
      await pushSiteConfig(conn, next);
      setSites((prev) => ({ ...prev, [conn.id]: { kind: "loaded", site: next } }));
      setBrandingConn(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSiteBusy(false);
    }
  };

  const anyOutdated = connections.some((c) => sites[c.id]?.kind === "outdated");

  const rowHost = (entry: { connectionId: string }) => shareHost(connectionFor(entry));

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
        {connections.length === 0 ? (
          // Without a connection there's no host to build links from and no
          // way to push or stop shares — route to setup instead of a dead list.
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
        ) : (
          <>
            {(anyOutdated || onOpenWorkerUpdate) && (
              <div className="shared-outdated">
                A newer share worker is available — a quick redeploy picks up
                the latest features. Your pages keep working meanwhile.
                <button
                  className="share-all-link"
                  onClick={() => {
                    onClose();
                    if (onOpenWorkerUpdate) onOpenWorkerUpdate();
                    else onOpenSetup();
                  }}
                >
                  Update…
                </button>
              </div>
            )}
            <div className="shared-sites">
              {connections.map((conn) => {
                const site = siteFor(conn.id);
                return (
                  <div key={conn.id} className="shared-site">
                    <div className="shared-site-row">
                      <button
                        className="shared-site-host"
                        onClick={() => onOpenExternal(`${conn.endpoint}/`)}
                        title={`Open ${conn.endpoint}/`}
                      >
                        {shareHost(conn)}
                      </button>
                      <span className="shared-site-summary">
                        {site?.rootPageId
                          ? `home page: /${site.rootPageId}`
                          : site?.ownerName
                            ? `landing page by ${site.ownerName}`
                            : "default landing page"}
                      </span>
                      {site && (
                        <button className="share-btn" onClick={() => openBranding(conn)}>
                          {brandingConn === conn.id ? "Close" : "Landing page…"}
                        </button>
                      )}
                    </div>
                    {brandingConn === conn.id && site && (
                      <div className="shared-site-form">
                        <div className="share-field">
                          <div className="share-field-label">Your name</div>
                          <input
                            className="share-field-input"
                            value={nameInput}
                            onChange={(e) => setNameInput(e.target.value)}
                            placeholder="shown as “Notes by …” on the landing page"
                            aria-label="Owner name"
                          />
                        </div>
                        <div className="share-field">
                          <div className="share-field-label">Profile link</div>
                          <input
                            className="share-field-input"
                            value={linkInput}
                            onChange={(e) => setLinkInput(e.target.value)}
                            spellCheck={false}
                            autoCapitalize="off"
                            autoCorrect="off"
                            placeholder="https://linkedin.com/in/you (optional)"
                            aria-label="Owner profile link"
                          />
                        </div>
                        <div className="share-buttons">
                          <button
                            className="share-btn is-primary"
                            onClick={() => void saveBranding(conn)}
                            disabled={siteBusy}
                          >
                            {siteBusy ? "Saving…" : "Save"}
                          </button>
                          {site.rootPageId && (
                            <span className="shared-site-hint">
                              The landing page shows once /{site.rootPageId} stops
                              being the home page.
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {shares.length === 0 && collections.length === 0 ? (
              <div className="shared-empty">
                Nothing is shared yet. Open a note and hit Share.
              </div>
            ) : (
              <>
                {collections.length > 0 && (
                  <>
                    <div className="shared-section-label">Folders</div>
                    <ul className="shared-list">
                      {collections.map((c) => {
                        const conn = connectionFor(c);
                        const site = siteFor(conn?.id);
                        const isHome = !!site && site.rootPageId === c.id;
                        return (
                          <li key={c.path} className="shared-row">
                            <button
                              className="shared-row-main"
                              onClick={() => onManageCollection(c)}
                              title={`Manage the share for ${c.path}`}
                            >
                              <span className="shared-row-title">
                                {c.title}
                                {isHome && <HomeBadge />}
                              </span>
                              <span
                                className="shared-row-url"
                                title={`Updated ${new Date(c.updatedAt).toLocaleString()}`}
                              >
                                {conn ? `${rowHost(c)}/${c.id}` : c.id} ·{" "}
                                {c.members.length}{" "}
                                {c.members.length === 1 ? "page" : "pages"}
                                {!conn && (
                                  <span className="shared-row-missing"> · domain removed</span>
                                )}
                                {missing.has(c.path) && (
                                  <span className="shared-row-missing"> · folder missing</span>
                                )}
                              </span>
                            </button>
                            <div className="shared-row-actions">
                              {site && (
                                <button
                                  className="share-btn"
                                  onClick={() => void setHomePage(c, !isHome)}
                                  disabled={busyPath === c.path}
                                  title={
                                    isHome
                                      ? "Restore the landing page at the domain root"
                                      : "Serve this folder's page at the domain root"
                                  }
                                >
                                  {isHome ? "Unset home" : "Make home"}
                                </button>
                              )}
                              {conn && (
                                <>
                                  <button
                                    className="share-btn"
                                    onClick={() =>
                                      void copyUrl(c.path, shareUrl(conn, c.id))
                                    }
                                  >
                                    {copiedPath === c.path ? "Copied" : "Copy"}
                                  </button>
                                  <button
                                    className="share-btn"
                                    onClick={() => onOpenExternal(shareUrl(conn, c.id))}
                                  >
                                    Open
                                  </button>
                                </>
                              )}
                              <button
                                className="share-btn"
                                onClick={() => onManageCollection(c)}
                              >
                                Manage
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
                {collections.length > 0 && shares.length > 0 && (
                  <div className="shared-section-label">Pages</div>
                )}
                {shares.length > 0 && (
                  <ul className="shared-list">
                    {shares.map((s) => {
                      const conn = connectionFor(s);
                      const site = siteFor(conn?.id);
                      const isHome = !!site && site.rootPageId === s.id;
                      return (
                        <li key={s.path} className="shared-row">
                          <button
                            className="shared-row-main"
                            onClick={() => onOpenDoc(s)}
                            title={`Open ${s.path}`}
                          >
                            <span className="shared-row-title">
                              {s.title}
                              {isHome && <HomeBadge />}
                            </span>
                            <span
                              className="shared-row-url"
                              title={`Updated ${new Date(s.updatedAt).toLocaleString()}`}
                            >
                              {conn ? `${rowHost(s)}/${s.id}` : s.id}
                              {!conn && (
                                <span className="shared-row-missing"> · domain removed</span>
                              )}
                              {missing.has(s.path) && (
                                <span className="shared-row-missing"> · file missing</span>
                              )}
                            </span>
                          </button>
                          <div className="shared-row-actions">
                            {site && (
                              <button
                                className="share-btn"
                                onClick={() => void setHomePage(s, !isHome)}
                                disabled={busyPath === s.path}
                                title={
                                  isHome
                                    ? "Restore the landing page at the domain root"
                                    : "Serve this page at the domain root"
                                }
                              >
                                {isHome ? "Unset home" : "Make home"}
                              </button>
                            )}
                            {conn && (
                              <>
                                <button
                                  className="share-btn"
                                  onClick={() =>
                                    void copyUrl(s.path, shareUrl(conn, s.id))
                                  }
                                >
                                  {copiedPath === s.path ? "Copied" : "Copy"}
                                </button>
                                <button
                                  className="share-btn"
                                  onClick={() => onOpenExternal(shareUrl(conn, s.id))}
                                >
                                  Open
                                </button>
                              </>
                            )}
                            <button
                              className="share-btn is-danger"
                              onClick={() => void stop(s)}
                              disabled={busyPath === s.path}
                            >
                              {busyPath === s.path ? "Stopping…" : "Stop"}
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}
          </>
        )}
        {error && <div className="share-error">{error}</div>}
      </div>
    </div>
  );
}

// Small "this is the domain root" marker next to a row title.
function HomeBadge() {
  return <span className="shared-home-badge">home</span>;
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
