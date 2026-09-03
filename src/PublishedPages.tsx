// Every published page of the workspace — docs/cloud.md §7.2:
// folders above files (the engine's order), path · slug · by / when, copy /
// open / stop, "Use as home page", and a "file missing" flag on an entry
// whose file is gone (the page 404s until the file returns or the entry is
// stopped — stopping is explicit, §9 decision 7). Reached from the Cloud
// panel and from the Publish popover.

import { useCallback, useEffect, useState } from "react";
import { cloudSetRoot, cloudUnpublish, pageUrl, timeAgo, type CloudStatus, type PublicPage } from "./cloud";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const basename = (p: string) => p.split(/[\\/]/).pop() || p;
const stemOf = (p: string) => basename(p).replace(/\.(md|markdown|mdown|mkd|html)$/i, "");

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
      <line x1="5" y1="5" x2="19" y2="19" />
      <line x1="19" y1="5" x2="5" y2="19" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function PageIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

export default function PublishedPages({
  cloud,
  onClose,
  onOpenExternal,
  onOpenFile,
  onEditFolder,
}: {
  cloud: CloudStatus;
  onClose: () => void;
  onOpenExternal: (url: string) => void;
  /** Open a published note in a tab (absolute path). */
  onOpenFile: (path: string) => void;
  /** The folder dialog for a published folder (absolute path). */
  onEditFolder: (dir: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const h = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(h);
  }, []);

  const act = useCallback(async (f: () => Promise<unknown>) => {
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  const copy = useCallback(async (slug: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(slug);
      window.setTimeout(() => setCopied((c) => (c === slug ? null : c)), 1600);
    } catch {
      /* selectable — copy by hand */
    }
  }, []);

  const abs = (page: PublicPage) => (page.path ? `${cloud.root}/${page.path}` : cloud.root);
  const nameOf = (page: PublicPage) =>
    page.title?.trim() || (page.kind === "dir" ? basename(page.path) || cloud.name : stemOf(page.path));
  const pages = cloud.public;

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal cloud-modal" role="dialog" aria-modal="true" aria-label="Published pages">
        <div className="modal-header">
          <div className="modal-title">Published pages · {cloud.domain}</div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="cloud-body">
          {pages.length === 0 ? (
            <p className="cloud-hint" data-testid="published-empty">
              Nothing is published yet. Use the Publish pill on a note, or “Publish folder…” in the sidebar.
            </p>
          ) : (
            <ul className="published-list" data-testid="published-list">
              {pages.map((page) => {
                const url = pageUrl(cloud, page);
                const openable = page.kind === "file" && page.alive;
                return (
                  <li className="published-row" key={page.slug} data-testid="published-row" data-slug={page.slug}>
                    <div className="published-row-main">
                      <span className="published-row-icon">{page.kind === "dir" ? <FolderIcon /> : <PageIcon />}</span>
                      {openable ? (
                        <button className="published-row-name" title={abs(page)} onClick={() => onOpenFile(abs(page))}>
                          {nameOf(page)}
                        </button>
                      ) : (
                        <span className="published-row-name" title={abs(page)}>
                          {nameOf(page)}
                        </span>
                      )}
                      {page.root && <span className="published-badge">Home page</span>}
                      {!page.alive && (
                        <span className="published-badge is-warn" data-testid="published-missing">
                          {page.kind === "dir" ? "empty folder" : "file missing"}
                        </span>
                      )}
                    </div>
                    <div className="published-row-sub">
                      {page.path || "the whole workspace"} · /{page.slug} · {page.by || "someone"} · {timeAgo(page.at, now)}
                    </div>
                    <div className="published-row-actions">
                      <button className="modal-btn" onClick={() => void copy(page.slug, url)}>
                        {copied === page.slug ? "Copied ✓" : "Copy link"}
                      </button>
                      <button className="modal-btn" onClick={() => onOpenExternal(url)}>
                        Open
                      </button>
                      {page.kind === "dir" && (
                        <button className="modal-btn" data-testid="published-edit" onClick={() => onEditFolder(abs(page))}>
                          Edit…
                        </button>
                      )}
                      <button
                        className="modal-btn"
                        data-testid="published-home"
                        onClick={() => void act(() => cloudSetRoot(cloud.root, page.root ? null : page.slug))}
                      >
                        {page.root ? "Unset as home page" : "Use as home page"}
                      </button>
                      {stopping === page.slug ? (
                        <>
                          <button
                            className="modal-btn is-danger-solid"
                            data-testid="published-stop-yes"
                            onClick={() => void act(() => cloudUnpublish(cloud.root, page.slug)).then(() => setStopping(null))}
                          >
                            Stop
                          </button>
                          <button className="modal-btn" onClick={() => setStopping(null)}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          className="modal-btn is-danger-outline"
                          data-testid="published-stop"
                          onClick={() => setStopping(page.slug)}
                        >
                          Stop
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {error && <div className="modal-error">{error}</div>}
        </div>
      </div>
    </div>
  );
}
