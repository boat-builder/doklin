// The Publish pill in the tab bar and its popover — docs/cloud.md
// §7.2, §7.3. Rendered by App only for a file tab inside the open workspace.
// Everything it shows derives from the workspace's status (the public map as
// the engine believes it, this Mac's queued edits included): a note is
// published exactly when the map holds a file entry for its path.
//
// Not connected: one line and the door to the wizard. Connected: publish at
// a random or chosen address; once published, the link, copy / open, the
// address (editable — the engine re-keys the page), who published it and
// when, a quiet line while local edits are still on their way, and stop.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  cloudPublish,
  cloudUnpublish,
  pageForPath,
  pageUrl,
  placesOf,
  slugProblem,
  timeAgo,
  type CloudStatus,
} from "./cloud";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const basename = (p: string) => p.split(/[\\/]/).pop() || p;
const stemOf = (p: string) => basename(p).replace(/\.(md|markdown|mdown|mkd|html)$/i, "");

function GlobeIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </svg>
  );
}

export default function PublishMenu({
  cloud,
  absPath,
  rel,
  deviceName,
  dirty,
  onConnect,
  onOpenExternal,
  onOpenPublished,
}: {
  /** The workspace's status when it is connected. */
  cloud: CloudStatus | null;
  /** The active note. */
  absPath: string;
  /** …relative to the workspace. */
  rel: string;
  /** This Mac's name — "Published by Alice" appears only for someone else's page. */
  deviceName: string;
  /** The tab has edits not yet on disk. */
  dirty: boolean;
  onConnect: () => void;
  onOpenExternal: (url: string) => void;
  onOpenPublished: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [slugInput, setSlugInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const page = cloud ? pageForPath(cloud, rel, "file") : null;
  const nested = cloud ? placesOf(cloud, rel).filter((p) => p.nested) : [];

  // A fresh popover starts from the page as it is — and follows the slug
  // when publishing or a rename lands while it is open.
  const slug = page?.slug ?? null;
  useEffect(() => {
    if (!open) return;
    setSlugInput(slug ?? "");
    setError(null);
    setConfirmStop(false);
    setCopied(false);
  }, [open, absPath, slug]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const run = useCallback(async (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* the link is selectable — copy by hand */
    }
  }, []);

  const typed = slugInput.trim().toLowerCase();
  const typedProblem = typed ? slugProblem(typed) : null;
  const title = stemOf(absPath);

  let body: React.ReactNode;
  if (!cloud) {
    body = (
      <>
        <div className="publish-heading">Publish “{title}”</div>
        <p className="cloud-hint">
          Notes publish from a folder that is connected to a domain of your own. Connect this one,
          and any note in it is public with one click — as fresh as the sync, never fresher.
        </p>
        <div className="share-buttons">
          <button
            className="share-btn is-primary"
            data-testid="publish-connect"
            onClick={() => {
              setOpen(false);
              onConnect();
            }}
          >
            Connect a domain…
          </button>
        </div>
      </>
    );
  } else if (!page) {
    body = (
      <>
        <div className="publish-heading">Publish “{title}”</div>
        <p className="cloud-hint">
          Anyone with the link can read it. Leave the address empty for a random one.
        </p>
        <div className="publish-address">
          <span className="publish-prefix">{cloud.domain}/</span>
          <input
            data-testid="publish-slug"
            value={slugInput}
            placeholder="random letters"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            disabled={busy}
            onChange={(e) => setSlugInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !typedProblem && !busy) {
                void run(() => cloudPublish(absPath, typed ? { slug: typed } : {}));
              }
            }}
          />
        </div>
        {typedProblem && <div className="share-error">{typedProblem}</div>}
        {nested.map((p) => (
          <p className="publish-meta" key={p.page.slug} data-testid="publish-nested">
            Already public inside “{p.page.title || basename(p.page.path) || cloud.name}”:{" "}
            <button className="publish-link" onClick={() => onOpenExternal(p.url)}>
              {p.url.replace(/^https?:\/\//, "")}
            </button>
          </p>
        ))}
        <div className="share-buttons">
          <button
            className="share-btn is-primary"
            data-testid="publish-go"
            disabled={busy || typedProblem !== null}
            onClick={() => void run(() => cloudPublish(absPath, typed ? { slug: typed } : {}))}
          >
            {busy ? "Publishing…" : "Publish"}
          </button>
        </div>
        {error && <div className="share-error">{error}</div>}
      </>
    );
  } else {
    const url = pageUrl(cloud, page);
    const byOther = page.by && page.by !== deviceName;
    const pending = dirty || cloud.phase !== "idle";
    body = (
      <>
        <div className="publish-heading">Published{page.root ? " · the home page" : ""}</div>
        <div className="publish-url-row">
          <button className="publish-url" data-testid="publish-url" title={url} onClick={() => onOpenExternal(url)}>
            {url.replace(/^https?:\/\//, "")}
          </button>
          <button className="share-btn" data-testid="publish-copy" onClick={() => void copy(url)}>
            {copied ? "Copied ✓" : "Copy"}
          </button>
          <button className="share-btn" onClick={() => onOpenExternal(url)}>
            Open
          </button>
        </div>
        <p className="publish-meta" data-testid="publish-by">
          {byOther ? `Published by ${page.by} · ` : "Published "}
          {timeAgo(page.at)}
          {byOther ? "" : " by this Mac"}
        </p>
        {pending && (
          <p className="cloud-hint" data-testid="publish-pending">
            Your latest changes appear once synced.
          </p>
        )}
        <div className="publish-address">
          <span className="publish-prefix">{cloud.domain}/</span>
          <input
            data-testid="publish-slug"
            value={slugInput}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            disabled={busy}
            onChange={(e) => setSlugInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && typed && typed !== page.slug && !typedProblem && !busy) {
                void run(() => cloudPublish(absPath, { slug: typed }));
              }
            }}
          />
          <button
            className="share-btn"
            data-testid="publish-rename"
            disabled={busy || !typed || typed === page.slug || typedProblem !== null}
            onClick={() => void run(() => cloudPublish(absPath, { slug: typed }))}
          >
            Change
          </button>
        </div>
        {typedProblem && <div className="share-error">{typedProblem}</div>}
        {nested.map((p) => (
          <p className="publish-meta" key={p.page.slug} data-testid="publish-nested">
            Also inside “{p.page.title || basename(p.page.path) || cloud.name}”:{" "}
            <button className="publish-link" onClick={() => onOpenExternal(p.url)}>
              {p.url.replace(/^https?:\/\//, "")}
            </button>
          </p>
        ))}
        <div className="share-buttons">
          {confirmStop ? (
            <>
              <span className="cloud-hint">Stop publishing? The link stops working.</span>
              <button
                className="share-btn is-danger-solid"
                data-testid="publish-stop-yes"
                disabled={busy}
                onClick={() => void run(() => cloudUnpublish(cloud.root, page.slug))}
              >
                Stop
              </button>
              <button className="share-btn" onClick={() => setConfirmStop(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button
              className="share-btn is-danger-outline"
              data-testid="publish-stop"
              disabled={busy}
              onClick={() => setConfirmStop(true)}
            >
              Stop publishing
            </button>
          )}
        </div>
        {error && <div className="share-error">{error}</div>}
        <button
          className="publish-link"
          data-testid="publish-all"
          onClick={() => {
            setOpen(false);
            onOpenPublished();
          }}
        >
          All published pages…
        </button>
      </>
    );
  }

  return (
    <div className="publish-wrap" ref={wrapRef}>
      <button
        className={`publish-pill ${page ? "is-published" : ""}`}
        data-testid="publish-pill"
        aria-expanded={open}
        aria-haspopup="dialog"
        title={page ? `Published at ${pageUrl(cloud!, page)}` : "Publish this note"}
        onClick={() => setOpen((v) => !v)}
      >
        {page ? <span className="publish-pill-dot" aria-hidden /> : <GlobeIcon />}
        {page ? "Published" : "Publish"}
      </button>
      {open && (
        <div className="publish-pop" role="dialog" aria-label="Publish" data-testid="publish-pop">
          {body}
        </div>
      )}
    </div>
  );
}
