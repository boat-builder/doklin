// "Update backend worker" dialog. Shown when a deployed worker reports an
// older WORKER_VERSION than the code this app build carries (probed via
// /api/meta on launch). The app can't push the update itself — by design it
// holds only the worker's share token, never Cloudflare account credentials,
// and two of the three setup paths leave no wrangler state on this Mac — so
// this dialog makes the redeploy as close to one click as honesty allows. It
// offers the same three routes as first-time setup, one per tab: paste the
// code into the Cloudflare dashboard editor (fastest, preserves the bucket
// binding, the SHARE_TOKEN secret, and any custom domain — code-only), hand a
// self-contained prompt to an AI agent, or run the wrangler commands yourself.
// None of them carry a secret: the SHARE_TOKEN survives a same-name redeploy
// untouched. "Check again" verifies the live version from in here.
//
// Only the backend's OWNER can redeploy — a member joined via invite and holds
// no Cloudflare credentials — so a member's card drops the instructions for a
// note asking them to nudge whoever runs it; they can still "Check again" to
// see when the owner has updated it.

import { useEffect, useState } from "react";
import workerCode from "virtual:share-worker-code";
import { shareHost, WORKER_BUNDLE_URL, type ShareConnection } from "./share";

const CLOUDFLARE_WORKERS_URL = "https://dash.cloudflare.com/?to=/:account/workers-and-pages";

export type OutdatedWorker = {
  conn: ShareConnection;
  version: number;
  // This device's role on the backend (from /api/auth/whoami). Only an owner
  // can redeploy; a member sees the "nudge the owner" note instead. Undefined
  // while the probe is in flight or after it failed — read as owner, so an
  // actual owner is never denied the steps over a transient error.
  role?: "owner" | "member";
};

type UpdateMode = "browser" | "agent" | "terminal";

const MODES: { key: UpdateMode; name: string; sub: string }[] = [
  { key: "browser", name: "In the browser", sub: "Paste in the dashboard — ~1 min" },
  { key: "agent", name: "With an AI agent", sub: "Hand it to Claude Code" },
  { key: "terminal", name: "In the terminal", sub: "Run wrangler yourself" },
];

// Recover the deployment's resource names from its endpoint. A workers.dev
// endpoint literally carries the worker name (first hostname label); a custom
// domain falls back to the setup flow's naming convention (doklin-share-<domain
// with dashes> — see ShareSetup's buildAgentPrompt). Either way the bucket
// convention is the worker name with share→pages. These are best guesses for
// the instructions to lead with — both paths tell the user/agent to verify.
function deploymentNames(conn: ShareConnection): {
  worker: string;
  bucket: string;
  domain: string | null;
  certain: boolean;
} {
  const host = shareHost(conn);
  const m = host.match(/^([a-z0-9-]+)\.[^.]+\.workers\.dev$/i);
  const worker = m ? m[1] : `doklin-share-${host.replace(/\./g, "-")}`;
  const bucket = worker.startsWith("doklin-share")
    ? worker.replace(/^doklin-share/, "doklin-pages")
    : "doklin-pages";
  return { worker, bucket, domain: m ? null : host, certain: !!m };
}

// The agent hand-off prompt for an update. Unlike setup, it carries no secret:
// the SHARE_TOKEN survives a same-name redeploy untouched, so the prompt is
// safe to paste anywhere. The dangerous failure mode is a name mismatch — a
// wrong-name deploy silently CREATES a second worker instead of updating this
// one — so the prompt verifies names before deploying and cleans up after
// itself if it guessed wrong.
function buildUpdatePrompt(conn: ShareConnection): string {
  const { worker, bucket, domain, certain } = deploymentNames(conn);
  const nameStep = certain
    ? `The worker is named "${worker}" — that's the first label of its workers.dev hostname.`
    : `The worker should be named "${worker}" (the Doklin setup derives names from the domain). Confirm it exists: \`npx -y wrangler@4 deployments list --name ${worker}\`. If that errors, ask me for the exact name — I can see it in the Cloudflare dashboard under Workers & Pages.`;
  const routesLines = domain
    ? `workers_dev = false
routes = [{ pattern = "${domain}", custom_domain = true }]`
    : `workers_dev = true`;
  return `Update my Doklin backend worker to the latest code. It serves at ${conn.endpoint} and runs on my Cloudflare account. This is a code-only update: its R2 bucket binding, its SHARE_TOKEN secret, and its domain setup must come through unchanged — all three survive a same-name redeploy, so do not recreate or modify any of them.

1. Make an empty working directory and download the latest worker (a single ready-to-deploy file, published with every Doklin release):
curl -fsSL ${WORKER_BUNDLE_URL} -o doklin-worker.js
2. Run \`npx -y wrangler@4 whoami\`. If it says not logged in, run \`npx -y wrangler@4 login\` and ask me to complete the sign-in in the browser window it opens.
3. ${nameStep}
4. Its R2 bucket should be named "${bucket}". Check with \`npx -y wrangler@4 r2 bucket list\`; if that name isn't in the list, ask me which bucket the worker uses (dashboard → the worker → Settings → Bindings) instead of guessing.
5. Next to the downloaded file, write wrangler.toml with exactly this (name/bucket from steps 3–4, account_id from whoami):
name = "${worker}"
main = "doklin-worker.js"
compatibility_date = "2025-05-05"
account_id = "<from whoami>"
${routesLines}
[[r2_buckets]]
binding = "PAGES"
bucket_name = "${bucket}"
6. Deploy: \`npx -y wrangler@4 deploy\`. This must UPDATE the existing worker, never create a second one — the name in wrangler.toml is what decides. If anything suggests a new worker appeared (a fresh workers.dev URL that isn't ${conn.endpoint}, a "created" rather than "updated" message), delete what you just made with \`npx -y wrangler@4 delete --name <that-name>\` and go back to step 3.
7. That's the whole job. Tell me when the deploy succeeds — I'll press "Check again" in the Doklin app, which verifies the live version with its own token.

Do not commit wrangler.toml anywhere, and do not create or modify any other Cloudflare resources.`;
}

// The terminal (wrangler) path: copy-paste commands that redeploy the same-name
// worker with the latest code. Same non-secret property as the agent prompt —
// SHARE_TOKEN, the bucket binding, and the domain all survive a same-name
// redeploy — so nothing here needs the token. The wrangler.toml write mirrors
// the deployment's names (see deploymentNames); the terminal note flags the
// guess when the endpoint isn't a workers.dev address.
function buildUpdateCommands(conn: ShareConnection): string[] {
  const { worker, bucket, domain } = deploymentNames(conn);
  const routesLines = domain
    ? `workers_dev = false
routes = [{ pattern = "${domain}", custom_domain = true }]`
    : `workers_dev = true`;
  return [
    "mkdir doklin-worker-update && cd doklin-worker-update",
    `curl -fsSL ${WORKER_BUNDLE_URL} -o doklin-worker.js`,
    "npx wrangler@4 whoami",
    `cat > wrangler.toml << 'EOF'
name = "${worker}"
main = "doklin-worker.js"
compatibility_date = "2025-05-05"
${routesLines}
[[r2_buckets]]
binding = "PAGES"
bucket_name = "${bucket}"
EOF`,
    "npx wrangler@4 deploy",
  ];
}

// Per-connection check state: idle until pressed; "current" flips the card to
// its done face (App has already cleared the badge by then).
type CheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "stale"; version: number }
  | { kind: "current"; version: number }
  | { kind: "error"; message: string };

export default function WorkerUpdate({
  outdated,
  latestVersion,
  onRecheck,
  onOpenExternal,
  onClose,
}: {
  outdated: OutdatedWorker[];
  latestVersion: number;
  // Re-probes the connection and updates App's registry; resolves to the live
  // version, throws when the worker can't be reached.
  onRecheck: (conn: ShareConnection) => Promise<number>;
  onOpenExternal: (url: string) => void;
  onClose: () => void;
}) {
  const [checks, setChecks] = useState<Record<string, CheckState>>({});
  const [copied, setCopied] = useState<string | null>(null);
  // Dialog-level tab, mirroring the setup guide. Defaults to the dashboard
  // paste — the fastest path that works for every deployment. Only shown when
  // at least one card can act on it (an owner's).
  const [mode, setMode] = useState<UpdateMode>("browser");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1600);
    } catch (e) {
      console.error("copy failed", e);
    }
  };

  const recheck = async (conn: ShareConnection) => {
    setChecks((prev) => ({ ...prev, [conn.id]: { kind: "checking" } }));
    try {
      const version = await onRecheck(conn);
      setChecks((prev) => ({
        ...prev,
        [conn.id]:
          version >= latestVersion ? { kind: "current", version } : { kind: "stale", version },
      }));
    } catch (e) {
      setChecks((prev) => ({
        ...prev,
        [conn.id]: { kind: "error", message: e instanceof Error ? e.message : String(e) },
      }));
    }
  };

  // A member (role explicitly "member") can't redeploy; anything else — owner,
  // or an unresolved probe — gets the instructions. The tab strip only makes
  // sense when at least one such card is present.
  const hasOwnerCard = outdated.some((w) => w.role !== "member");

  return (
    <div
      className="shared-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="shared-modal worker-update-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Update backend worker"
      >
        <div className="shared-modal-header">
          <div className="shared-modal-title">Update backend worker</div>
          <button className="shared-modal-close" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="worker-update-body">
          <div className="share-note">
            This app ships a newer version of the backend worker than{" "}
            {outdated.length === 1 ? "your deployment runs" : "some of your deployments run"}.
            Everything keeps working meanwhile — the update unlocks what this app version
            added (cloud sync needs worker v4). It swaps only the worker's code: pages,
            synced files, tokens, and domains stay put.
          </div>
          {hasOwnerCard && (
            <div className="worker-update-modes" role="tablist" aria-label="Update method">
              {MODES.map((m) => (
                <button
                  key={m.key}
                  role="tab"
                  aria-selected={mode === m.key}
                  className={`setup-mode-btn ${mode === m.key ? "is-active" : ""}`}
                  onClick={() => setMode(m.key)}
                >
                  <span className="setup-mode-name">{m.name}</span>
                  <span className="setup-mode-sub">{m.sub}</span>
                </button>
              ))}
            </div>
          )}
          {outdated.map(({ conn, version, role }) => {
            const host = shareHost(conn);
            const check = checks[conn.id] ?? { kind: "idle" };
            const done = check.kind === "current";
            const isMember = role === "member";
            const { worker, certain } = deploymentNames(conn);
            return (
              <div key={conn.id} className="worker-update-conn">
                <div className="worker-update-conn-head">
                  <span className="worker-update-host">{host}</span>
                  <span className="worker-update-vers">
                    {done
                      ? `up to date (v${latestVersion})`
                      : `v${check.kind === "stale" ? check.version : version} → v${latestVersion}`}
                  </span>
                  {done ? (
                    <span className="worker-update-done">
                      <CheckIcon /> Updated
                    </span>
                  ) : (
                    <button
                      className="share-btn"
                      onClick={() => void recheck(conn)}
                      disabled={check.kind === "checking"}
                    >
                      {check.kind === "checking" ? "Checking…" : "Check again"}
                    </button>
                  )}
                </div>
                {!done && (
                  <>
                    {isMember ? (
                      <div className="share-note">
                        This backend is run by someone else, and only its owner can update it
                        — that takes Cloudflare access this app doesn't have. Ask whoever runs{" "}
                        <strong>{host}</strong> to open Doklin and update the backend worker.
                        Everything keeps working meanwhile; press “Check again” once they have.
                      </div>
                    ) : mode === "browser" ? (
                      <>
                        <div className="share-note">
                          Fastest path — about a minute, works for every setup: in the
                          Cloudflare dashboard open <strong>Workers &amp; Pages</strong> →{" "}
                          <strong>{certain ? worker : `your worker (likely ${worker})`}</strong>{" "}
                          → <strong>Edit code</strong>. Select everything in the editor, paste
                          the code from the button below, hit <strong>Deploy</strong> — then
                          come back and press “Check again”.
                        </div>
                        <div className="share-buttons">
                          <button
                            className="share-btn is-primary"
                            onClick={() => void copy(`code-${conn.id}`, workerCode)}
                          >
                            {copied === `code-${conn.id}` ? "Copied ✓" : "Copy worker code"}
                          </button>
                          <button
                            className="share-btn"
                            onClick={() => onOpenExternal(CLOUDFLARE_WORKERS_URL)}
                          >
                            Open dashboard
                          </button>
                        </div>
                      </>
                    ) : mode === "agent" ? (
                      <>
                        <div className="share-note">
                          The complete job for an agent with shell access (Claude Code etc.).
                          It contains no secrets — the token survives a same-name redeploy — so
                          it's safe to paste anywhere you trust with your machine.
                        </div>
                        <pre className="setup-prompt">{buildUpdatePrompt(conn)}</pre>
                        <div className="share-buttons">
                          <button
                            className="share-btn"
                            onClick={() => void copy(`prompt-${conn.id}`, buildUpdatePrompt(conn))}
                          >
                            {copied === `prompt-${conn.id}` ? "Copied ✓" : "Copy prompt"}
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="share-note">
                          Run these yourself — needs{" "}
                          <button
                            className="setup-link"
                            onClick={() => onOpenExternal("https://nodejs.org")}
                          >
                            Node.js
                          </button>
                          ; wrangler signs into Cloudflare in a browser window. No token needed:
                          your <code>SHARE_TOKEN</code>, the R2 binding, and any custom domain
                          all survive a same-name redeploy, so nothing here is secret. If{" "}
                          <code>whoami</code> says you're not signed in, run{" "}
                          <code>npx wrangler@4 login</code> first (add{" "}
                          <code>account_id</code> to the config if your login has more than one
                          Cloudflare account).
                        </div>
                        {!certain && (
                          <div className="share-note">
                            Double-check the <code>name</code> below matches this deployment
                            (dashboard → <strong>Workers &amp; Pages</strong>) — deploying under
                            a different name creates a <strong>second</strong> worker instead of
                            updating this one.
                          </div>
                        )}
                        {buildUpdateCommands(conn).map((cmd, i) => {
                          const key = `cmd-${conn.id}-${i}`;
                          return (
                            <div key={key} className="setup-cmd">
                              <code>{cmd}</code>
                              <button
                                className="setup-copy"
                                onClick={() => void copy(key, cmd)}
                                title="Copy command"
                                aria-label="Copy command"
                              >
                                {copied === key ? <CheckIcon /> : <CopyIcon />}
                              </button>
                            </div>
                          );
                        })}
                      </>
                    )}
                    {check.kind === "stale" && (
                      <div className="share-error">
                        Still on v{check.version} — the deploy hasn't landed. Give it a moment
                        after deploying, then check again.
                      </div>
                    )}
                    {check.kind === "error" && (
                      <div className="share-error">
                        Couldn't reach the worker: {check.message}
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
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

function CheckIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function CopyIcon() {
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
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}
