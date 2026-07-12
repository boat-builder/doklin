// "Delete backend" — the guided teardown of a whole deployment, reached from
// an owner's row in the Backends dialog. Three steps, in the only order that
// works:
//
//   1. Erase the data (in-app): the worker's owner-only wipe API empties the
//      R2 bucket — pages, workspaces, credentials, site config. The app can
//      do this because it holds the backend's token. It matters because R2
//      refuses to delete a non-empty bucket, and neither wrangler nor the
//      dashboard bulk-deletes objects.
//   2. Remove the worker + bucket (guided): the app can't — it never holds
//      Cloudflare account credentials — so this mirrors the setup guide's
//      three paths: a copyable prompt for an AI agent, dashboard clicks, or
//      wrangler commands.
//   3. Disconnect this Mac: forget the endpoint + token locally.
//
// Local sync engines for this backend are stopped before the erase, so they
// don't watch their workspaces 404 out from under them.

import { useEffect, useState } from "react";
import {
  fetchWorkerVersion,
  listRemotePages,
  shareHost,
  type ShareConnection,
} from "./share";
import {
  listRemoteWorkspaces,
  listTokens,
  SyncWorkerOutdatedError,
  wipeBackend,
} from "./sync";

// The wipe API arrived in worker version 6.
const WIPE_MIN_VERSION = 6;

// A workers.dev deployment names its worker in the URL's first label
// (https://<worker>.<account>.workers.dev); a custom domain doesn't say.
function workerNameFromEndpoint(endpoint: string): string | null {
  const m = endpoint.match(/^https?:\/\/([a-z0-9-]+)\.[^./]+\.workers\.dev\/?$/i);
  return m ? m[1] : null;
}

function buildAgentPrompt(conn: ShareConnection): string {
  const host = shareHost(conn);
  const workerName = workerNameFromEndpoint(conn.endpoint);
  const identify = workerName
    ? `Its name is "${workerName}" (the first label of its workers.dev URL).`
    : `It's bound to that custom domain — find it in the Cloudflare dashboard (Workers & Pages → the worker whose Domains & Routes lists ${host}). Doklin setups are usually named doklin-share or doklin-share-<suffix>.`;
  return `Remove the Doklin backend that serves ${conn.endpoint} from my Cloudflare account. Its data has already been erased through the app, so its R2 bucket should be empty.

1. Run \`npx -y wrangler@4 whoami\`. If it says not logged in, run \`npx -y wrangler@4 login\` and ask me to complete the sign-in in the browser window it opens.
2. Identify the Worker serving ${conn.endpoint}. ${identify}
3. Identify its R2 bucket: \`npx -y wrangler@4 r2 bucket list\` — Doklin buckets are named doklin-pages or doklin-pages-<suffix>, matching the worker's suffix. If more than one candidate exists, confirm with me before deleting anything.
4. Delete the worker: \`npx -y wrangler@4 delete --name ${workerName ?? "<worker-name>"}\`. This also releases its URL${workerName ? "" : " and the custom domain binding"}.
5. Delete the bucket: \`npx -y wrangler@4 r2 bucket delete <bucket-name>\`. If it refuses because the bucket isn't empty, STOP and tell me — the erase step in the app may not have finished.
6. Verify: an HTTP GET of ${conn.endpoint}/ must no longer answer with a Doklin page.

Do not touch any other Workers, buckets, domains, or Cloudflare resources.`;
}

// What the backend holds right now, fetched on open so the erase step can
// say what it's about to destroy.
type Summary =
  | { kind: "loading" }
  | { kind: "loaded"; pages: number; workspaces: number; tokens: number; version: number }
  | { kind: "error"; message: string };

export default function BackendTeardown({
  conn,
  onDisableLocalSync,
  onOpenExternal,
  onOpenWorkerUpdate,
  onDisconnect,
  onClose,
}: {
  conn: ShareConnection;
  // Stops this Mac's sync engines for this backend (App owns the engines).
  onDisableLocalSync: () => Promise<void>;
  onOpenExternal: (url: string) => void;
  // Routes to the worker-update guide when App knows this worker is stale.
  onOpenWorkerUpdate: (() => void) | null;
  // Forgets the connection on this Mac and closes this dialog (App does both).
  onDisconnect: () => Promise<void>;
  onClose: () => void;
}) {
  const [summary, setSummary] = useState<Summary>({ kind: "loading" });
  const [mode, setMode] = useState<"agent" | "browser" | "terminal">("agent");
  const [erase, setErase] = useState<
    | { state: "idle" | "confirm" }
    | { state: "running"; purged: number }
    | { state: "done"; purged: number }
    | { state: "error"; message: string }
  >({ state: "idle" });
  const [promptCopied, setPromptCopied] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const version = await fetchWorkerVersion(conn);
        const pages = await listRemotePages(conn);
        // Pre-sync workers (v < 4) 404 these two lists — that's still a
        // valid, erasable deployment, just with nothing sync-shaped on it.
        let workspaces = 0;
        let tokens = 0;
        try {
          workspaces = (await listRemoteWorkspaces(conn)).length;
          tokens = (await listTokens(conn)).length;
        } catch (e) {
          if (!(e instanceof SyncWorkerOutdatedError)) throw e;
        }
        if (!cancelled) {
          setSummary({ kind: "loaded", pages: pages.length, workspaces, tokens, version });
        }
      } catch (e) {
        if (!cancelled) {
          setSummary({ kind: "error", message: e instanceof Error ? e.message : String(e) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conn]);

  const canWipe = summary.kind === "loaded" && summary.version >= WIPE_MIN_VERSION;

  const runErase = async () => {
    setErase({ state: "running", purged: 0 });
    try {
      await onDisableLocalSync();
      const purged = await wipeBackend(conn, (n) =>
        setErase({ state: "running", purged: n }),
      );
      setErase({ state: "done", purged });
    } catch (e) {
      setErase({
        state: "error",
        message:
          e instanceof SyncWorkerOutdatedError
            ? "This worker predates remote erase — update it first (step above), then erase."
            : e instanceof Error
              ? e.message
              : String(e),
      });
    }
  };

  const disconnect = async () => {
    if (disconnecting) return;
    setDisconnecting(true);
    try {
      await onDisconnect();
    } finally {
      setDisconnecting(false);
    }
  };

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(buildAgentPrompt(conn));
      setPromptCopied(true);
      window.setTimeout(() => setPromptCopied(false), 1600);
    } catch (e) {
      console.error("copy teardown prompt failed", e);
    }
  };

  const host = shareHost(conn);
  const workerName = workerNameFromEndpoint(conn.endpoint);

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
        aria-label="Delete backend"
      >
        <div className="shared-modal-header">
          <div className="shared-modal-title">Delete backend — {host}</div>
          <button className="shared-modal-close" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>

        <div className="sync-body">
          <p className="sync-hint">
            This takes the whole backend down: every published page goes offline, every
            workspace's backend copy (and its version history) is destroyed, and everyone
            you invited is cut off. Files already on each Mac stay where they are. Just
            done with one workspace or one person? Cloud sync handles those without
            touching the rest.
          </p>

          {summary.kind === "error" && (
            <div className="sync-error">
              Can't reach the backend right now: {summary.message} — the erase step needs
              it reachable; the Cloudflare steps below work regardless.
            </div>
          )}

          <ol className="setup-steps">
            <li className="setup-step">
              <div className="setup-step-title">Erase everything it stores</div>
              <div className="setup-step-note">
                {summary.kind === "loaded" ? (
                  <>
                    Right now it holds <strong>{summary.pages}</strong> published{" "}
                    {summary.pages === 1 ? "page" : "pages"},{" "}
                    <strong>{summary.workspaces}</strong>{" "}
                    {summary.workspaces === 1 ? "workspace" : "workspaces"}, and{" "}
                    <strong>{summary.tokens}</strong>{" "}
                    {summary.tokens === 1 ? "key" : "keys"} (people and linked devices).{" "}
                  </>
                ) : summary.kind === "loading" ? (
                  <>Checking what it holds… </>
                ) : null}
                Erasing empties the storage bucket so Cloudflare will let you delete it —
                neither the dashboard nor wrangler removes a non-empty bucket.
              </div>
              {summary.kind === "loaded" && !canWipe && (
                <div className="shared-outdated">
                  This worker is too old to erase itself remotely.{" "}
                  {onOpenWorkerUpdate ? (
                    <button className="share-all-link" onClick={onOpenWorkerUpdate}>
                      Update the worker
                    </button>
                  ) : (
                    "Update it from the settings gear first"
                  )}
                  , then come back here.
                </div>
              )}
              {erase.state === "done" ? (
                <div className="setup-done">
                  <CheckIcon /> Erased — {erase.purged}{" "}
                  {erase.purged === 1 ? "object" : "objects"} deleted; the bucket is empty.
                </div>
              ) : erase.state === "running" ? (
                <div className="sync-hint">Erasing… {erase.purged} objects so far.</div>
              ) : erase.state === "confirm" ? (
                <div className="backend-confirm">
                  <div className="backend-confirm-title">
                    Erase everything on {host}? This can't be undone.
                  </div>
                  <ul className="backend-confirm-list">
                    <li>Every published page goes offline immediately.</li>
                    <li>
                      Every workspace's backend copy and all version history are destroyed.
                      Local folders on each Mac stay.
                    </li>
                    <li>
                      Every invite and key is revoked — people and linked devices are cut
                      off on their next sync.
                    </li>
                  </ul>
                  <div className="share-buttons">
                    <button className="share-btn is-danger" onClick={() => void runErase()}>
                      Erase everything
                    </button>
                    <button className="share-btn" onClick={() => setErase({ state: "idle" })}>
                      Keep
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {erase.state === "error" && <div className="sync-error">{erase.message}</div>}
                  <div className="share-buttons">
                    <button
                      className="share-btn is-danger"
                      disabled={!canWipe}
                      onClick={() => setErase({ state: "confirm" })}
                    >
                      Erase everything…
                    </button>
                  </div>
                </>
              )}
            </li>

            <li className="setup-step">
              <div className="setup-step-title">Remove the worker and bucket from Cloudflare</div>
              <div className="setup-step-note">
                The app can't do this part — it holds only the backend's access token,
                never your Cloudflare account. Pick whichever path you used to set up:
              </div>
              <div className="teardown-tabs" role="tablist" aria-label="Removal method">
                {(["agent", "browser", "terminal"] as const).map((m) => (
                  <button
                    key={m}
                    role="tab"
                    aria-selected={mode === m}
                    className={`share-btn ${mode === m ? "is-primary" : ""}`}
                    onClick={() => setMode(m)}
                  >
                    {m === "agent" ? "With an AI agent" : m === "browser" ? "In the browser" : "In the terminal"}
                  </button>
                ))}
              </div>
              {mode === "agent" ? (
                <>
                  <div className="setup-step-note">
                    Paste this into an AI coding agent on your machine (Claude Code or
                    anything that runs shell commands). It contains no secrets.
                  </div>
                  <pre className="setup-prompt">{buildAgentPrompt(conn)}</pre>
                  <div className="setup-code-row">
                    <button className="share-btn is-primary" onClick={() => void copyPrompt()}>
                      {promptCopied ? "Copied ✓" : "Copy prompt"}
                    </button>
                  </div>
                </>
              ) : mode === "browser" ? (
                <div className="setup-step-note">
                  In{" "}
                  <button
                    className="setup-link"
                    onClick={() => onOpenExternal("https://dash.cloudflare.com")}
                  >
                    the Cloudflare dashboard
                  </button>
                  : open <strong>Workers &amp; Pages</strong>, select the worker
                  {workerName ? (
                    <>
                      {" "}
                      named <code>{workerName}</code>
                    </>
                  ) : (
                    <>
                      {" "}
                      whose <strong>Domains &amp; Routes</strong> lists <code>{host}</code>{" "}
                      (Doklin setups are usually <code>doklin-share…</code>)
                    </>
                  )}
                  , then <strong>Settings</strong> → <strong>Delete</strong>. Next open{" "}
                  <strong>R2 Object Storage</strong>, select its bucket (usually{" "}
                  <code>doklin-pages…</code>) → <strong>Settings</strong> →{" "}
                  <strong>Delete bucket</strong>. The bucket must be empty — the erase step
                  above did that.
                </div>
              ) : (
                <>
                  <div className="setup-step-note">
                    {workerName ? (
                      <>
                        The worker is <code>{workerName}</code> (from its workers.dev URL).
                      </>
                    ) : (
                      <>
                        Fill in the worker's name — Doklin setups are usually{" "}
                        <code>doklin-share</code> or <code>doklin-share-&lt;suffix&gt;</code>.
                      </>
                    )}{" "}
                    List the buckets to spot the right <code>doklin-pages…</code> one; the
                    delete only succeeds once the bucket is empty (the erase step above).
                  </div>
                  <Cmd text={`npx wrangler@4 delete --name ${workerName ?? "<worker-name>"}`} />
                  <Cmd text="npx wrangler@4 r2 bucket list" />
                  <Cmd text="npx wrangler@4 r2 bucket delete <bucket-name>" />
                </>
              )}
            </li>

            <li className="setup-step">
              <div className="setup-step-title">Forget it on this Mac</div>
              <div className="setup-step-note">
                Removes the saved endpoint and token. Any local entries for its pages are
                kept as records but can't reach anything — the pages went offline with the
                erase.
              </div>
              <div className="share-buttons">
                <button
                  className="share-btn is-danger"
                  disabled={disconnecting}
                  onClick={() => void disconnect()}
                >
                  {disconnecting ? "Disconnecting…" : "Disconnect this Mac"}
                </button>
              </div>
            </li>
          </ol>
        </div>
      </div>
    </div>
  );
}

// One copyable command line — same treatment as the setup guide's.
function Cmd({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (e) {
      console.error("copy failed", e);
    }
  };
  return (
    <div className="setup-cmd">
      <code>{text}</code>
      <button
        className="setup-copy"
        onClick={() => void copy()}
        title="Copy command"
        aria-label="Copy command"
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </div>
  );
}

function CopyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
      <line x1="5" y1="5" x2="19" y2="19" />
      <line x1="19" y1="5" x2="5" y2="19" />
    </svg>
  );
}
