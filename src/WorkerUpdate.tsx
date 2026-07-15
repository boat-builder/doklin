// "Update backend worker" dialog. Shown when a deployed worker reports an
// older WORKER_VERSION than the code this app build carries (probed via
// /api/meta on launch). The app can't push the update itself — by design it
// holds only the worker's share token, never Cloudflare account credentials,
// and two of the three setup paths leave no wrangler state on this Mac — so
// this dialog makes the redeploy as close to one click as honesty allows. It
// offers the same three routes as first-time setup, one per tab: paste the
// code into the Cloudflare dashboard editor (fastest, preserves the bucket
// binding, the SHARE_TOKEN secret, and any custom domain — code-only), hand a
// self-contained prompt to an AI agent, or run one generated script yourself.
// None of them carry a secret: the SHARE_TOKEN survives a same-name redeploy
// untouched. "Check again" verifies the live version from in here.
//
// Each route covers EVERY outdated backend at once, because almost nothing
// about the update is per-backend: the worker code is byte-identical for all of
// them, and only the name/bucket/routing in wrangler.toml differ. So the
// instructions are built once for the whole set, and the per-backend cards
// below them carry only what genuinely is per-backend — the version and its
// "Check again". The terminal route leans hardest on this: rather than N × 5
// commands to paste in sequence, it writes one script next to the app's own
// config and asks for a single `sh <path>`. The app runs on the same Mac the
// wrangler commands do, so the script may as well already be on disk.
//
// Only a backend's OWNER can redeploy — a member joined via invite and holds
// no Cloudflare credentials — so members are excluded from the instructions
// (and from the script) and get a note asking them to nudge whoever runs the
// backend; they can still "Check again" to see when the owner has updated it.

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import workerCode from "virtual:share-worker-code";
import { shareHost, WORKER_BUNDLE_URL, type ShareConnection } from "./share";

const CLOUDFLARE_WORKERS_URL = "https://dash.cloudflare.com/?to=/:account/workers-and-pages";

// Lives beside share.json in <app_data_dir> rather than in a temp dir: the user
// may well have to open it and correct a guessed worker name, and a path that
// survives a reboot is one they can re-run without coming back here.
const SCRIPT_NAME = "doklin-worker-update.sh";

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
  { key: "terminal", name: "In the terminal", sub: "Run one script" },
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

// The wrangler.toml routing block for a deployment: a workers.dev worker keeps
// its generated subdomain, a custom-domain one re-asserts its route. Omitting
// it from a redeploy is what would drop a custom domain. Used by the agent
// prompt, which renders the block up front; the script builds the same two
// shapes in shell instead, since there the domain is only known at run time —
// keep the two in step.
function routingLines(domain: string | null): string {
  return domain
    ? `workers_dev = false
routes = [{ pattern = "${domain}", custom_domain = true }]`
    : `workers_dev = true`;
}

// POSIX single-quote escaping, for interpolating a name or path into generated
// shell. Endpoints come from whatever the user typed at setup, so nothing that
// reaches the script is trusted to be shell-safe.
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// The agent hand-off prompt, covering every backend in one job. Unlike setup, it
// carries no secret: the SHARE_TOKEN survives a same-name redeploy untouched, so
// the prompt is safe to paste anywhere. The dangerous failure mode is a name
// mismatch — a wrong-name deploy silently CREATES a second worker instead of
// updating this one — so the prompt verifies names before deploying and cleans
// up after itself if it guessed wrong. The download and login happen once; only
// the per-backend loop repeats.
function buildUpdatePrompt(conns: ShareConnection[]): string {
  const many = conns.length > 1;
  const list = conns
    .map((conn, i) => {
      const { worker, bucket, domain, certain } = deploymentNames(conn);
      const nameNote = certain
        ? "certain — it's the first label of the workers.dev hostname"
        : "A GUESS from Doklin's naming convention — verify it before deploying";
      return `${many ? `Backend ${i + 1} — ` : ""}${conn.endpoint}
  worker name: "${worker}" (${nameNote})
  R2 bucket: "${bucket}"${certain ? "" : " (also a guess — verify it)"}
  routing lines for wrangler.toml:
${routingLines(domain)
  .split("\n")
  .map((l) => `    ${l}`)
  .join("\n")}`;
    })
    .join("\n\n");
  return `Update my Doklin backend worker${many ? "s" : ""} to the latest code${many ? ` — there are ${conns.length}, listed at the bottom` : ` (it serves at ${conns[0].endpoint})`}. ${many ? "They run" : "It runs"} on my Cloudflare account. This is a code-only update: the R2 bucket binding, the SHARE_TOKEN secret, and the domain setup of each must come through unchanged — all three survive a same-name redeploy, so do not recreate or modify any of them.

1. Make an empty working directory and download the latest worker (a single ready-to-deploy file, published with every Doklin release):
curl -fsSL ${WORKER_BUNDLE_URL} -o doklin-worker.js
2. Run \`npx -y wrangler@4 whoami\`. If it says not logged in, run \`npx -y wrangler@4 login\` and ask me to complete the sign-in in the browser window it opens.
3. ${many ? "Then for each backend at the bottom, in turn:" : "Then:"}
   a. Verify the worker name. Where it's marked a guess, confirm it exists with \`npx -y wrangler@4 deployments list --name <name>\`. If that errors, ask me for the exact name — I can see it in the Cloudflare dashboard under Workers & Pages. Never substitute a name you invented.
   b. Verify the R2 bucket with \`npx -y wrangler@4 r2 bucket list\`; if the listed name isn't there, ask me which bucket that worker uses (dashboard → the worker → Settings → Bindings) instead of guessing.
   c. Next to the downloaded file, write wrangler.toml with exactly this (name/bucket from a–b, routing lines as listed, account_id from whoami):
name = "<name from a>"
main = "doklin-worker.js"
compatibility_date = "2025-05-05"
account_id = "<from whoami>"
<routing lines>
[[r2_buckets]]
binding = "PAGES"
bucket_name = "<bucket from b>"
   d. Deploy: \`npx -y wrangler@4 deploy\`. This must UPDATE the existing worker, never create a second one — the name in wrangler.toml is what decides. If anything suggests a new worker appeared (a fresh workers.dev URL that isn't that backend's endpoint, a "created" rather than "updated" message), delete what you just made with \`npx -y wrangler@4 delete --name <that-name>\` and go back to (a).
4. That's the whole job. Tell me when ${many ? "each deploy" : "the deploy"} succeeds — I'll press "Check again" in the Doklin app, which verifies the live version with its own token.

${many ? "The backends" : "The backend"}:

${list}

Do not commit wrangler.toml anywhere, and do not create or modify any other Cloudflare resources.`;
}

// The terminal path: ONE script covering every backend, written to disk for the
// user to run. Same non-secret property as the agent prompt — SHARE_TOKEN, the
// bucket binding, and the domain all survive a same-name redeploy — so nothing
// here needs the token, and the file is safe to leave lying around.
//
// The script's one real hazard is deploying under a name that doesn't exist,
// which CREATES a second worker rather than updating the intended one. It can't
// ask a question mid-run, so it refuses instead: names Doklin only guessed (see
// deploymentNames — anything that isn't a workers.dev endpoint) are checked
// against the account first and skipped if absent, leaving the user a corrected
// re-run. Names read straight off a workers.dev hostname are certain and skip
// the check, which also keeps the script working when `deployments list` can't
// resolve an account on its own.
function buildUpdateScript(conns: ShareConnection[], version: number, path: string): string {
  const calls = conns
    .map((conn) => {
      const { worker, bucket, domain, certain } = deploymentNames(conn);
      return `update_backend ${shellQuote(worker)} ${shellQuote(bucket)} ${shellQuote(
        domain ?? "",
      )} ${shellQuote(conn.endpoint)} ${shellQuote(certain ? "" : "verify")}`;
    })
    .join("\n");
  const many = conns.length > 1;
  return `#!/bin/sh
# Doklin — update ${many ? `${conns.length} backend workers` : "the backend worker"} to v${version}
#
# Generated by Doklin for the ${many ? "backends" : "backend"} connected on this Mac. Re-run it any
# time with:
#
#   sh ${path}
#
# It downloads the worker bundle published with the latest Doklin release and
# redeploys ${many ? "each backend" : "the backend"} listed at the bottom under its existing name.
# This is a code-only update: the SHARE_TOKEN secret, the R2 bucket binding and
# any custom domain all survive a same-name redeploy, so there is nothing
# secret in this file and nothing else on your Cloudflare account is touched.
#
# Needs Node.js (https://nodejs.org). Wrangler opens a browser to sign you in
# to Cloudflare if you aren't signed in already.

set -u

BUNDLE_URL=${shellQuote(WORKER_BUNDLE_URL)}

# Only needed if your Cloudflare login has more than one account — wrangler
# can't pick for you, and every command below fails until it can. Get the id
# from \`npx wrangler@4 whoami\`. Exported rather than written into
# wrangler.toml so that it reaches the name check too, not just the deploy.
ACCOUNT_ID=""
if [ -n "$ACCOUNT_ID" ]; then
  CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID"
  export CLOUDFLARE_ACCOUNT_ID
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "npx not found. Install Node.js from https://nodejs.org, then re-run this script." >&2
  exit 1
fi

work=$(mktemp -d) || exit 1
trap 'rm -rf "$work"' EXIT
cd "$work" || exit 1

echo "Downloading worker v${version}…"
if ! curl -fsSL "$BUNDLE_URL" -o doklin-worker.js; then
  echo "Download failed: $BUNDLE_URL" >&2
  exit 1
fi

echo "Checking your Cloudflare login…"
if ! npx --yes wrangler@4 whoami; then
  echo "Not signed in. Run: npx wrangler@4 login" >&2
  exit 1
fi

failed=""

# name, bucket, custom domain ("" = a workers.dev deployment), endpoint,
# and "verify" when the name is a guess Doklin couldn't confirm from the URL.
update_backend() {
  name=$1
  bucket=$2
  domain=$3
  endpoint=$4
  verify=$5

  echo ""
  echo "── $endpoint"
  echo "   worker \\"$name\\" · bucket \\"$bucket\\""

  # Start clean: wrangler reads wrangler.toml from the working directory, so a
  # file left by the previous backend must not colour this one's name check.
  rm -f wrangler.toml

  if [ -n "$verify" ]; then
    if ! probe=$(npx --yes wrangler@4 deployments list --name "$name" 2>&1); then
      echo "   SKIPPED: couldn't confirm a worker named \\"$name\\" on your account:"
      echo "$probe" | sed 's/^/   | /'
      echo "   That name is Doklin's guess, and deploying it blind could create a"
      echo "   SECOND worker rather than update yours — so nothing was deployed."
      echo "   If the error above is about the name, look the real one up in the"
      echo "   Cloudflare dashboard (Workers & Pages) and correct this endpoint's"
      echo "   update_backend line at the bottom of this script. If it's about"
      echo "   having several accounts, set ACCOUNT_ID at the top. Then re-run."
      failed="$failed $endpoint"
      return
    fi
  fi

  if [ -n "$domain" ]; then
    routes="workers_dev = false
routes = [{ pattern = \\"$domain\\", custom_domain = true }]"
  else
    routes="workers_dev = true"
  fi

  cat > wrangler.toml <<TOML
name = "$name"
main = "doklin-worker.js"
compatibility_date = "2025-05-05"
$routes
[[r2_buckets]]
binding = "PAGES"
bucket_name = "$bucket"
TOML

  if npx --yes wrangler@4 deploy; then
    echo "   updated ✓"
  else
    echo "   FAILED — see the wrangler output above."
    failed="$failed $endpoint"
  fi
}

${calls}

echo ""
if [ -n "$failed" ]; then
  echo "Not updated:$failed"
  echo "Those backends keep working on their old worker — nothing is broken."
  exit 1
fi

echo "Done. Press \\"Check again\\" in Doklin to confirm."
`;
}

// Per-connection check state: idle until pressed; "current" flips the card to
// its done face (App has already cleared the badge by then).
type CheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "stale"; version: number }
  | { kind: "current"; version: number }
  | { kind: "error"; message: string };

// The generated script, written to disk the first time the terminal tab is
// opened — never eagerly, so the other two routes leave nothing behind.
type ScriptState =
  | { kind: "idle" }
  | { kind: "writing" }
  | { kind: "ready"; path: string; command: string; text: string }
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
  // at least one backend can act on it (an owner's).
  const [mode, setMode] = useState<UpdateMode>("browser");
  const [script, setScript] = useState<ScriptState>({ kind: "idle" });

  // The backends this device can actually redeploy. A member (role explicitly
  // "member") can't — anything else, owner or an unresolved probe, gets the
  // instructions, so an actual owner is never denied them over a transient
  // error. Everything above the cards is built from this set.
  const owned = useMemo(
    () => outdated.filter((w) => w.role !== "member").map((w) => w.conn),
    [outdated],
  );
  const many = owned.length > 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Write the script when the terminal tab is first shown — never before, so the
  // other two routes leave nothing on disk. `outdated` is a snapshot App takes
  // when the dialog opens, so in practice this runs once per visit to the tab.
  // It overwrites unconditionally: the file is ours, and one left by an older
  // app version would deploy the wrong worker version.
  useEffect(() => {
    if (mode !== "terminal" || owned.length === 0) return;
    let cancelled = false;
    setScript({ kind: "writing" });
    void (async () => {
      try {
        const path = await join(await appDataDir(), SCRIPT_NAME);
        const text = buildUpdateScript(owned, latestVersion, shellQuote(path));
        await invoke("write_file", { path, contents: text, expected: null });
        if (!cancelled) {
          setScript({ kind: "ready", path, command: `sh ${shellQuote(path)}`, text });
        }
      } catch (e) {
        if (!cancelled) {
          setScript({ kind: "error", message: e instanceof Error ? e.message : String(e) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, owned, latestVersion]);

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

  const reveal = async (path: string) => {
    try {
      await invoke("reveal_in_finder", { path });
    } catch (e) {
      console.error("reveal failed", e);
    }
  };

  // Any backend whose worker name Doklin had to infer rather than read off a
  // workers.dev hostname. One such backend is enough to warrant the warning:
  // it's the mistake that costs a duplicate worker.
  const anyGuessed = owned.some((c) => !deploymentNames(c).certain);

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
          {owned.length > 0 && (
            <>
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
              {mode === "browser" ? (
                <>
                  <div className="share-note">
                    Fastest path — about a minute{many ? " each" : ""}, works for every setup.
                    {many ? " The code is the same for all of them: copy it once, then in the" : " In the"}{" "}
                    Cloudflare dashboard open <strong>Workers &amp; Pages</strong> →{" "}
                    {many ? "each worker below" : "the worker below"} → <strong>Edit code</strong>
                    . Select everything in the editor, paste, hit <strong>Deploy</strong> — then
                    come back and press “Check again”.
                  </div>
                  <WorkerList conns={owned} />
                  <div className="share-buttons">
                    <button
                      className="share-btn is-primary"
                      onClick={() => void copy("code", workerCode)}
                    >
                      {copied === "code" ? "Copied ✓" : "Copy worker code"}
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
                    The complete job for an agent with shell access (Claude Code etc.) —{" "}
                    {many ? `all ${owned.length} backends in one prompt` : "one prompt"}. It
                    contains no secrets — the token survives a same-name redeploy — so it's safe
                    to paste anywhere you trust with your machine.
                  </div>
                  <pre className="setup-prompt">{buildUpdatePrompt(owned)}</pre>
                  <div className="share-buttons">
                    <button
                      className="share-btn"
                      onClick={() => void copy("prompt", buildUpdatePrompt(owned))}
                    >
                      {copied === "prompt" ? "Copied ✓" : "Copy prompt"}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="share-note">
                    Doklin wrote one script to this Mac that updates{" "}
                    {many ? `all ${owned.length} backends` : "the backend"} — run it and it
                    downloads the latest worker and redeploys {many ? "each of them" : "it"} in
                    place. Needs{" "}
                    <button
                      className="setup-link"
                      onClick={() => onOpenExternal("https://nodejs.org")}
                    >
                      Node.js
                    </button>
                    ; wrangler signs into Cloudflare in a browser window. No token needed: your{" "}
                    <code>SHARE_TOKEN</code>, the R2 binding, and any custom domain all survive a
                    same-name redeploy, so nothing in the script is secret.
                  </div>
                  {anyGuessed && (
                    <div className="share-note">
                      Doklin had to guess the worker name for{" "}
                      {many ? "some of these deployments" : "this deployment"} — deploying under
                      the wrong name would create a <strong>second</strong> worker instead of
                      updating {many ? "yours" : "this one"}, so the script checks each guessed
                      name against your account first and stops rather than risk it. If it does,
                      it tells you which line to correct.
                    </div>
                  )}
                  {script.kind === "ready" ? (
                    <>
                      <div className="setup-cmd">
                        <code>{script.command}</code>
                        <button
                          className="setup-copy"
                          onClick={() => void copy("script-cmd", script.command)}
                          title="Copy command"
                          aria-label="Copy command"
                        >
                          {copied === "script-cmd" ? <CheckIcon /> : <CopyIcon />}
                        </button>
                      </div>
                      <div className="share-buttons">
                        <button className="share-btn" onClick={() => void reveal(script.path)}>
                          Show in Finder
                        </button>
                      </div>
                      <details className="worker-update-script">
                        <summary>What the script does</summary>
                        <pre className="setup-prompt">{script.text}</pre>
                      </details>
                    </>
                  ) : script.kind === "error" ? (
                    <div className="share-error">
                      Couldn't write the script: {script.message}. Use one of the other two
                      routes instead.
                    </div>
                  ) : (
                    <div className="share-note">Writing the script…</div>
                  )}
                </>
              )}
            </>
          )}
          {outdated.map(({ conn, version, role }) => {
            const host = shareHost(conn);
            const check = checks[conn.id] ?? { kind: "idle" };
            const done = check.kind === "current";
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
                {!done && role === "member" && (
                  <div className="share-note">
                    This backend is run by someone else, and only its owner can update it — that
                    takes Cloudflare access this app doesn't have. Ask whoever runs{" "}
                    <strong>{host}</strong> to open Doklin and update the backend worker.
                    Everything keeps working meanwhile; press “Check again” once they have.
                  </div>
                )}
                {!done && check.kind === "stale" && (
                  <div className="share-error">
                    Still on v{check.version} — the deploy hasn't landed. Give it a moment after
                    deploying, then check again.
                  </div>
                )}
                {!done && check.kind === "error" && (
                  <div className="share-error">Couldn't reach the worker: {check.message}</div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// The dashboard route's targets: which worker to open for which backend. The
// code pasted into each is the same, so this list is all that distinguishes
// them — and it's where a guessed name gets flagged, since a paste into the
// wrong worker is the one mistake this route can still make.
function WorkerList({ conns }: { conns: ShareConnection[] }) {
  return (
    <ul className="worker-update-targets">
      {conns.map((conn) => {
        const { worker, certain } = deploymentNames(conn);
        return (
          <li key={conn.id}>
            <code>{worker}</code>
            {!certain && <span className="worker-update-guess">likely — verify</span>}
            <span className="worker-update-target-host">{shareHost(conn)}</span>
          </li>
        );
      })}
    </ul>
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
