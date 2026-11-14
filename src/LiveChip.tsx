// The Live chip in the title row and its popover.
// Rendered by App only for a file tab inside the open workspace.
// Everything it shows derives from the workspace's status (the public map as
// the engine believes it, this Mac's queued edits included): a note is
// published exactly when the map holds a file entry for its path.
//
// The chip says where the note's own page stands, in five states
// (src/cloud.ts pageState): Publish, Live, Updating, Not updating and Page
// offline. Not connected, the popover is one line and the door to the
// wizard. Connected and not published: publish at a random or chosen
// address. Published: the address with Copy, Open, Change address, who
// published it and when, why the page isn't current when it isn't, and Stop
// publishing.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  cloudPublish,
  cloudUnpublish,
  pageForPath,
  pageState,
  pageStateLine,
  pageUrl,
  placesOf,
  slugProblem,
  timeAgo,
  type CloudStatus,
  type PageState,
} from "./cloud";
import { useDismiss } from "./dismiss";
import { CloseIcon } from "./storeChrome";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const basename = (p: string) => p.split(/[\\/]/).pop() || p;
const stemOf = (p: string) => basename(p).replace(/\.(md|markdown|mdown|mkd|html)$/i, "");

const CHIP_LABEL: Record<PageState, string> = {
  publish: "Publish",
  live: "Live",
  updating: "Updating",
  stale: "Not updating",
  offline: "Page offline",
};

const HEADING: Record<PageState, string> = {
  publish: "isn’t published",
  live: "is live",
  updating: "is updating",
  stale: "isn’t updating",
  offline: "is offline",
};

function GlobeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12M8 2c1.7 1.7 2.5 3.7 2.5 6S9.7 12.3 8 14M8 2C6.3 3.7 5.5 5.7 5.5 8s.8 4.3 2.5 6" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="5.25" y="5.25" width="8.25" height="8.25" rx="1.5" />
      <path d="M3 10.5V3.5c0-.55.45-1 1-1h6.5" />
    </svg>
  );
}

function OpenIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 3H3v10h10V9M9.5 2.5h4v4M13.5 2.5L7.5 8.5" />
    </svg>
  );
}

/** The chip's lead: a globe for Publish, a turning ring while updating, a
 *  still dot otherwise. Only the state in motion moves. */
function StateMark({ state }: { state: PageState }) {
  if (state === "publish") return <GlobeIcon />;
  if (state === "updating") return <span className="live-spin" aria-hidden />;
  return <span className="live-dot" aria-hidden />;
}

export default function LiveChip({
  cloud,
  absPath,
  rel,
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
  /** The tab has edits not yet on disk. */
  dirty: boolean;
  onConnect: () => void;
  onOpenExternal: (url: string) => void;
  onOpenPublished: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [slugInput, setSlugInput] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const page = cloud ? pageForPath(cloud, rel, "file") : null;
  const nested = cloud ? placesOf(cloud, rel).filter((p) => p.nested) : [];

  // An edit saved here is on its way to the page until a sync completes
  // after it. A tab switch starts over: the chip is about the open note.
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const prev = useRef({ absPath, dirty });
  useEffect(() => {
    const was = prev.current;
    prev.current = { absPath, dirty };
    if (was.absPath !== absPath) setSavedAt(null);
    else if (was.dirty && !dirty) setSavedAt(Date.now());
  }, [absPath, dirty]);
  const syncing = savedAt != null && (cloud?.lastSyncMs ?? 0) < savedAt;
  const state = pageState(cloud, page, dirty || syncing);
  const reason = cloud ? pageStateLine(cloud, state) : null;

  // A fresh popover starts from the page as it is — and follows the slug
  // when publishing or a rename lands while it is open.
  const slug = page?.slug ?? null;
  useEffect(() => {
    if (!open) return;
    setSlugInput(slug ?? "");
    setEditing(false);
    setError(null);
    setConfirmStop(false);
    setCopied(false);
  }, [open, absPath, slug]);

  // The chip is inside the layer: pressing it toggles the card shut.
  useDismiss(() => setOpen(false), wrapRef, open);

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

  const nestedLines = (lead: string) =>
    cloud &&
    nested.map((p) => (
      <p className="publish-meta" key={p.page.slug} data-testid="publish-nested">
        {lead} “{p.page.title || basename(p.page.path) || cloud.name}”:{" "}
        <button className="publish-link" onClick={() => onOpenExternal(p.url)}>
          {p.url.replace(/^https?:\/\//, "")}
        </button>
      </p>
    ));

  let body: React.ReactNode;
  if (!cloud) {
    body = (
      <>
        <div className="live-pop-head">Publish “{title}”</div>
        <p className="cloud-hint">
          Notes publish from a folder that is connected to a domain of your own. Connect this one,
          and any note in it is public with one click — as fresh as the sync, never fresher.
        </p>
        <div className="modal-buttons">
          <button
            className="modal-btn is-primary"
            data-testid="publish-connect"
            onClick={() => {
              setOpen(false);
              onConnect();
            }}
          >
            Connect a domain
          </button>
        </div>
      </>
    );
  } else if (!page) {
    const publish = () => void run(() => cloudPublish(absPath, typed ? { slug: typed } : {}));
    body = (
      <>
        <div className="live-pop-head">Publish “{title}”</div>
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
              if (e.key === "Enter" && !typedProblem && !busy) publish();
            }}
          />
        </div>
        {typedProblem && <div className="modal-error">{typedProblem}</div>}
        {nestedLines("Already public inside")}
        <div className="modal-buttons">
          <button
            className="modal-btn is-primary"
            data-testid="publish-go"
            disabled={busy || typedProblem !== null}
            onClick={publish}
          >
            {busy ? "Publishing…" : "Publish"}
          </button>
        </div>
        {error && <div className="modal-error">{error}</div>}
      </>
    );
  } else {
    const url = pageUrl(cloud, page);
    const shown = url.replace(/^https?:\/\//, "");
    const cut = shown.indexOf("/");
    // Somebody else's page, or your own. `me` is what this Mac signs with —
    // a person since manifest v3 — so a page published from your other Mac
    // reads as yours rather than as a stranger's.
    const byOther = page.by && page.by !== cloud.me;
    const canRename = !busy && typed !== "" && typed !== page.slug && typedProblem === null;
    const rename = () =>
      void run(async () => {
        await cloudPublish(absPath, { slug: typed });
        setEditing(false);
      });
    body = (
      <>
        <div className="live-pop-head">
          <span className={`live-dot is-${state}`} aria-hidden />
          <span className="live-pop-title">
            “{title}” {HEADING[state]}
          </span>
          {page.root && <span className="live-pop-badge">Home page</span>}
        </div>
        <div className="live-url">
          <GlobeIcon />
          <button className="live-url-addr" data-testid="publish-url" title={url} onClick={() => onOpenExternal(url)}>
            <span className="live-url-host">{shown.slice(0, cut)}</span>
            {shown.slice(cut)}
          </button>
          <button className="modal-btn is-primary" data-testid="publish-copy" onClick={() => void copy(url)}>
            <CopyIcon />
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        {reason && (
          <p className={`live-reason is-${state}`} data-testid="publish-state">
            {reason}
          </p>
        )}
        <p className="live-meta">
          <span data-testid="publish-by">
            {byOther ? `Published by ${page.by} · ` : "Published "}
            {timeAgo(page.at)}
            {byOther ? "" : " by you"}
          </span>
          . Anyone with the link can read it; it’s hidden from search engines.
        </p>
        {nestedLines("Also inside")}
        {confirmStop ? (
          <div className="live-acts">
            <span className="live-confirm">Stop publishing? The link stops working.</span>
            <button
              className="modal-btn is-danger-solid"
              data-testid="publish-stop-yes"
              disabled={busy}
              onClick={() => void run(() => cloudUnpublish(cloud.root, page.slug))}
            >
              Stop
            </button>
            <button className="modal-btn" onClick={() => setConfirmStop(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="live-acts">
            <button className="modal-btn" onClick={() => onOpenExternal(url)}>
              <OpenIcon />
              Open
            </button>
            <button
              className="modal-btn"
              data-testid="publish-change"
              aria-expanded={editing}
              onClick={() => {
                setSlugInput(page.slug);
                setEditing((v) => !v);
              }}
            >
              Change address
            </button>
            <button
              className="live-stop"
              data-testid="publish-stop"
              disabled={busy}
              onClick={() => setConfirmStop(true)}
            >
              Stop publishing
            </button>
          </div>
        )}
        {editing && (
          <>
            <div className="publish-address">
              <span className="publish-prefix">{cloud.domain}/</span>
              <input
                data-testid="publish-slug"
                value={slugInput}
                autoFocus
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                disabled={busy}
                onChange={(e) => setSlugInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canRename) rename();
                }}
              />
              <button className="modal-btn" data-testid="publish-rename" disabled={!canRename} onClick={rename}>
                Change
              </button>
            </div>
            {typedProblem && <div className="modal-error">{typedProblem}</div>}
          </>
        )}
        {error && <div className="modal-error">{error}</div>}
        <button
          className="publish-link live-all"
          data-testid="publish-all"
          onClick={() => {
            setOpen(false);
            onOpenPublished();
          }}
        >
          All published pages
        </button>
      </>
    );
  }

  const chipTitle =
    state === "publish" ? "Publish this note" : state === "live" && cloud && page ? pageUrl(cloud, page) : reason ?? "";
  return (
    <div className="live-wrap" ref={wrapRef}>
      <button
        className={`live-chip is-${state}`}
        data-testid="live-chip"
        data-state={state}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={chipTitle}
        onClick={() => setOpen((v) => !v)}
      >
        <StateMark state={state} />
        {CHIP_LABEL[state]}
        {state === "live" && page && (
          <>
            <span className="live-chip-sep" aria-hidden />
            <span className="live-chip-path">/{page.slug}</span>
          </>
        )}
      </button>
      {open && (
        <div className="live-pop" role="dialog" aria-label="Publish" data-testid="publish-pop">
          <button className="live-pop-close" aria-label="Close" title="Close" onClick={() => setOpen(false)}>
            <CloseIcon size={14} />
          </button>
          {body}
        </div>
      )}
    </div>
  );
}
