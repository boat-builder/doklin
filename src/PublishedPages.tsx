// Every published page you can open — from the shared workspace, your
// Private and the restricted folders you are in:
// folders above files (the engine's order), path · slug · by / when, copy /
// open / stop, "Use as home page", and a "file missing" flag on an entry
// whose file is gone (the page 404s until the file returns or the entry is
// stopped — stopping is explicit). Reached from the Cloud
// panel and from the Publish popover.
//
// An owner also sees the rest: every address on the domain that some other
// section published. Of those the domain tells only what the address itself
// tells anyone — its title, who published it, when — and an owner can take
// any of them down.

import { useCallback, useEffect, useRef, useState } from "react";
import { useDismiss } from "./dismiss";
import {
  cloudPageTakeDown,
  cloudPages,
  cloudSetRoot,
  cloudUnpublish,
  pageUrl,
  placeOf,
  timeAgo,
  type CloudStatus,
  type EveryPage,
  type PublicPage,
} from "./cloud";

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
  // Every address on the domain, for whoever may see them all. Null until
  // the domain has answered; `elsewhereNote` is why it could not.
  const seesAll = cloud.can.includes("pages.manage");
  const [every, setEvery] = useState<{ pages: EveryPage[]; truncated: boolean } | null>(null);
  const [elsewhereNote, setElsewhereNote] = useState<string | null>(null);
  const [everyToken, setEveryToken] = useState(0);

  useEffect(() => {
    if (!seesAll) return;
    let live = true;
    void cloudPages(cloud.root)
      .then((answer) => {
        if (live) setEvery(answer);
      })
      .catch((e) => {
        if (live) setElsewhereNote(errText(e));
      });
    return () => {
      live = false;
    };
  }, [seesAll, cloud.root, everyToken]);

  const cardRef = useRef<HTMLDivElement>(null);
  useDismiss(onClose, cardRef);

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
  // The ones published from a section this Mac's person is not in.
  const elsewhere = (every?.pages ?? []).filter((p) => !p.shared && !pages.some((mine) => mine.slug === p.slug));

  return (
    <div className="modal-overlay">
      <div ref={cardRef} className="modal cloud-modal" role="dialog" aria-modal="true" aria-label="Published pages">
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
                          Edit
                        </button>
                      )}
                      {/* The home page is chosen from what everyone has. */}
                      {placeOf(cloud, page.path).kind === "shared" && (
                        <button
                          className="modal-btn"
                          data-testid="published-home"
                          onClick={() => void act(() => cloudSetRoot(cloud.root, page.root ? null : page.slug))}
                        >
                          {page.root ? "Unset as home page" : "Use as home page"}
                        </button>
                      )}
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
          {seesAll && (elsewhere.length > 0 || elsewhereNote) && (
            <>
              <div className="cloud-section-label">From sections you are not in</div>
              <p className="cloud-hint">
                Published from somebody’s Private or a restricted folder. You cannot open the files, but as an owner
                you can take a page down.
              </p>
              {elsewhereNote && (
                <p className="cloud-hint cloud-warn" data-testid="published-elsewhere-note">
                  {elsewhereNote}
                </p>
              )}
              <ul className="published-list" data-testid="published-elsewhere">
                {elsewhere.map((page) => {
                  const url = `${cloud.endpoint}/${page.slug}`;
                  return (
                    <li className="published-row" key={page.slug} data-testid="published-elsewhere-row" data-slug={page.slug}>
                      <div className="published-row-main">
                        <span className="published-row-icon">{page.kind === "dir" ? <FolderIcon /> : <PageIcon />}</span>
                        <span className="published-row-name">{page.title || page.slug}</span>
                      </div>
                      <div className="published-row-sub">
                        /{page.slug} · {page.by || "someone"}
                        {page.at > 0 && ` · ${timeAgo(page.at, now)}`}
                      </div>
                      <div className="published-row-actions">
                        <button className="modal-btn" onClick={() => void copy(page.slug, url)}>
                          {copied === page.slug ? "Copied ✓" : "Copy link"}
                        </button>
                        <button className="modal-btn" onClick={() => onOpenExternal(url)}>
                          Open
                        </button>
                        {stopping === page.slug ? (
                          <>
                            <button
                              className="modal-btn is-danger-solid"
                              data-testid="published-takedown-yes"
                              onClick={() =>
                                void act(() => cloudPageTakeDown(cloud.root, page.slug)).then(() => {
                                  setStopping(null);
                                  setEveryToken((t) => t + 1);
                                })
                              }
                            >
                              Take down
                            </button>
                            <button className="modal-btn" onClick={() => setStopping(null)}>
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            className="modal-btn is-danger-outline"
                            data-testid="published-takedown"
                            onClick={() => setStopping(page.slug)}
                          >
                            Take down
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {every?.truncated && (
                <p className="cloud-hint">There are more than this list shows.</p>
              )}
            </>
          )}
          {error && <div className="modal-error">{error}</div>}
        </div>
      </div>
    </div>
  );
}
