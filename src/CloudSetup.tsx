// The setup wizard — docs/cloud.md §6.8 and §7.2. Two entrances:
//
//   connect  the open folder goes to a fresh domain: name it, choose where
//            it lives (a domain of your own or a free workers.dev address),
//            copy the prompt (it carries the token this app just minted),
//            paste the endpoint the agent printed, probe, connect & upload;
//   join     open a workspace another Mac already connected: endpoint and
//            token from that Mac's Cloud panel, probe, download it here.
//
// The probe decides what the domain is, and the wizard says so in words:
// fresh → "Connect & upload"; already holding a workspace → "Download it
// here", plus "Resume syncing this folder" when the open folder carries
// that workspace's marker (a reinstall, a restore from a backup). There is
// no "bind anyway": a domain holds one workspace.

import { useCallback, useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  BUNDLED_WORKER_VERSION,
  WORKER_COMPATIBILITY_DATE,
  cloudConnect,
  cloudJoin,
  cloudMarker,
  cloudMintToken,
  cloudProbe,
  cloudResume,
  onCloudProgress,
  timeAgo,
  type CloudMarker,
  type CloudProbe,
  type CloudProgressEvent,
} from "./cloud";
import {
  buildSetupPrompt,
  cleanDomain,
  cleanWorkersName,
  endpointOf,
  resourceName,
  targetProblem,
  type CloudTarget,
} from "./cloudPrompts";

export type CloudSetupMode = "connect" | "join";
export type CloudSetupOutcome = "connect" | "join" | "resume";

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
      <line x1="5" y1="5" x2="19" y2="19" />
      <line x1="19" y1="5" x2="5" y2="19" />
    </svg>
  );
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const basename = (p: string) => p.split(/[\\/]/).pop() || p;

type Probed = {
  endpoint: string;
  result: CloudProbe;
  /** The open folder's marker, read alongside the probe. */
  marker: CloudMarker | null;
};

type Work = { how: CloudSetupOutcome; progress: CloudProgressEvent | null };

export default function CloudSetup({
  mode,
  root,
  onClose,
  onConnected,
}: {
  mode: CloudSetupMode;
  /** The open workspace folder, if any: what "connect" uploads, what "resume" adopts. */
  root: string | null;
  onClose: () => void;
  /** The workspace is syncing at `root` — the folder that was open, or the one a download created. */
  onConnected: (root: string, how: CloudSetupOutcome) => void;
}) {
  const [name, setName] = useState(root ? basename(root) : "Notes");
  const [targetKind, setTargetKind] = useState<CloudTarget["kind"]>("domain");
  const [domainInput, setDomainInput] = useState("");
  const [nameInput, setNameInput] = useState("");
  // Minted here for a connect; typed for a join.
  const [token, setToken] = useState("");
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [endpointInput, setEndpointInput] = useState("");
  const [endpointTouched, setEndpointTouched] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probed, setProbed] = useState<Probed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [work, setWork] = useState<Work | null>(null);
  const [done, setDone] = useState<{ root: string; how: CloudSetupOutcome } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !work) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, work]);

  useEffect(() => {
    if (mode !== "connect") return;
    let live = true;
    void cloudMintToken()
      .then((t) => {
        if (live && typeof t === "string" && t) setToken(t);
        else if (live) setTokenError("Couldn't mint a token.");
      })
      .catch((e) => {
        if (live) setTokenError(`Couldn't mint a token: ${errText(e)}`);
      });
    return () => {
      live = false;
    };
  }, [mode]);

  // Upload / download progress while a flow runs.
  useEffect(() => {
    const un = onCloudProgress((e) => {
      setWork((w) => (w ? { ...w, progress: e } : w));
    });
    return () => {
      void un.then((f) => f()).catch(() => {});
    };
  }, []);

  const target: CloudTarget | null = useMemo(() => {
    if (targetKind === "domain") {
      const d = cleanDomain(domainInput);
      return d ? { kind: "domain", domain: d } : null;
    }
    const n = cleanWorkersName(nameInput);
    return n ? { kind: "workers-dev", name: n } : null;
  }, [targetKind, domainInput, nameInput]);
  const targetTyped = targetKind === "domain" ? domainInput.trim() !== "" : nameInput.trim() !== "";
  const targetError = target ? targetProblem(target) : targetTyped ? "That doesn't look right yet." : null;
  const cleanName = name.trim() || (root ? basename(root) : "Notes");

  const prompt = useMemo(() => {
    if (mode !== "connect" || !target || targetError || !token) return null;
    return buildSetupPrompt({
      target,
      token,
      workspaceName: cleanName,
      workerVersion: BUNDLED_WORKER_VERSION,
      compatibilityDate: WORKER_COMPATIBILITY_DATE,
    });
  }, [mode, target, targetError, token, cleanName]);

  // A domain of your own answers at https://<domain>; a workers.dev address
  // is only known once wrangler prints it, so that one is pasted.
  const endpoint = endpointTouched || mode === "join" ? endpointInput : (target && endpointOf(target)) ?? "";

  const copyPrompt = useCallback(async () => {
    if (!prompt) return;
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* selectable text — copy by hand */
    }
  }, [prompt]);

  const probe = useCallback(async () => {
    setError(null);
    setProbed(null);
    setProbing(true);
    try {
      const [result, marker] = await Promise.all([
        cloudProbe(endpoint, token),
        root ? cloudMarker(root).catch(() => null) : Promise.resolve(null),
      ]);
      setProbed({ endpoint, result, marker });
    } catch (e) {
      setError(errText(e));
    } finally {
      setProbing(false);
    }
  }, [endpoint, token, root]);

  const run = useCallback(
    async (how: CloudSetupOutcome, go: () => Promise<string>) => {
      setError(null);
      setWork({ how, progress: null });
      try {
        const at = await go();
        setDone({ root: at, how });
      } catch (e) {
        setError(errText(e));
      } finally {
        setWork(null);
      }
    },
    [],
  );

  const connect = () => {
    if (!root || !probed) return;
    void run("connect", async () => {
      await cloudConnect(root, probed.endpoint, token, cleanName);
      return root;
    });
  };
  const resume = () => {
    if (!root || !probed) return;
    void run("resume", async () => {
      await cloudResume(root, probed.endpoint, token);
      return root;
    });
  };
  const download = async () => {
    if (!probed) return;
    let parent: string | null = null;
    try {
      const chosen = await openDialog({ directory: true, multiple: false, title: "Download the workspace into…" });
      if (typeof chosen === "string") parent = chosen;
    } catch (e) {
      setError(errText(e));
      return;
    }
    if (!parent) return;
    const dest = parent;
    void run("join", () => cloudJoin(probed.endpoint, token, dest));
  };

  /* ---------- pieces ---------- */

  const workspace = probed?.result.workspace ?? null;
  const markerMatches = !!(probed && root && probed.marker && workspace && probed.marker.wsId === workspace.id);
  const versionNote = (() => {
    if (!probed) return null;
    const { workerVersion, bundledVersion } = probed.result;
    if (workerVersion < bundledVersion) {
      return `The worker is behind this app (v${workerVersion}, the app expects v${bundledVersion}) — connect, then update it from the Cloud panel.`;
    }
    if (workerVersion > bundledVersion) {
      return `The worker is newer than this app (v${workerVersion}) — update Doklin soon.`;
    }
    return null;
  })();

  const progressLine = (() => {
    if (!work) return null;
    const verb = work.how === "join" ? "Downloading" : work.how === "connect" ? "Uploading" : "Adopting";
    if (!work.progress) return `${verb}…`;
    return `${verb} ${work.progress.done} of ${work.progress.total}…`;
  })();

  const outcome = probed && !done && (
    <div className="cloud-card" data-testid="probe-outcome">
      {workspace ? (
        <>
          <div className="cloud-card-title">
            {probed.result.workspace && probeDomain(probed.endpoint)} already holds “{workspace.name}”
          </div>
          <p className="cloud-hint">
            Created on {workspace.createdBy.deviceName}
            {createdAgo(workspace.createdAt)}. A domain holds one workspace — download that one
            here{markerMatches ? ", or resume syncing this folder, which is that workspace" : ""}.
          </p>
        </>
      ) : (
        <>
          <div className="cloud-card-title">
            {probeDomain(probed.endpoint)} is up and holds nothing yet
          </div>
          <p className="cloud-hint">
            Worker v{probed.result.workerVersion}.{" "}
            {mode === "connect" && root
              ? `Connecting uploads everything in “${basename(root)}” — every note and file under it — and keeps it in step from then on.`
              : "Connect a folder to it from the Mac that has the notes."}
          </p>
        </>
      )}
      {versionNote && <p className="cloud-hint cloud-warn">{versionNote}</p>}
      {work ? (
        <div className="cloud-progress" role="progressbar" aria-label={progressLine ?? "Working"}>
          <div className="cloud-progress-text">{progressLine}</div>
          {work.progress && work.progress.total > 0 && (
            <div className="cloud-progress-bar">
              <span style={{ width: `${Math.round((100 * work.progress.done) / work.progress.total)}%` }} />
            </div>
          )}
        </div>
      ) : (
        <div className="share-buttons">
          {!workspace && mode === "connect" && root && (
            <button className="share-btn is-primary" onClick={connect} data-testid="connect-upload">
              Connect &amp; upload
            </button>
          )}
          {workspace && (
            <button className="share-btn is-primary" onClick={() => void download()} data-testid="download-here">
              Download it here…
            </button>
          )}
          {workspace && markerMatches && (
            <button className="share-btn" onClick={resume} data-testid="resume-folder">
              Resume syncing this folder
            </button>
          )}
        </div>
      )}
    </div>
  );

  const doneBlock = done && (
    <div className="cloud-card cloud-card--ok" data-testid="setup-done">
      <div className="cloud-card-title">
        {done.how === "join" ? "Downloaded — syncing" : "Syncing"}
      </div>
      <p className="cloud-hint">
        {basename(done.root)} and {probeDomain(probed?.endpoint ?? endpoint)} stay in step from
        now on. The dot beside the workspace name shows the sync at a glance; the gear’s Cloud…
        item has the rest.
      </p>
      <div className="share-buttons">
        <button className="share-btn is-primary" onClick={() => onConnected(done.root, done.how)}>
          {done.how === "join" ? "Open the folder" : "Done"}
        </button>
      </div>
    </div>
  );

  const endpointStep = (
    <>
      <div className="share-field">
        <div className="share-field-label">Endpoint</div>
        <input
          className="share-field-input"
          data-testid="endpoint-input"
          value={endpoint}
          placeholder={targetKind === "domain" && mode === "connect" ? "https://notes.example.com" : "https://doklin-notes.example.workers.dev"}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => {
            setEndpointInput(e.target.value);
            setEndpointTouched(true);
            setProbed(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && endpoint && token && !probing) void probe();
          }}
        />
      </div>
      {mode === "join" && (
        <div className="share-field">
          <div className="share-field-label">Token</div>
          <input
            className="share-field-input share-field-token"
            data-testid="token-input"
            value={token}
            placeholder="64 hex characters, from the other Mac"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => {
              setToken(e.target.value.trim());
              setProbed(null);
            }}
          />
        </div>
      )}
      <div className="share-buttons">
        <button
          className={`share-btn ${probed ? "" : "is-primary"}`}
          data-testid="probe-button"
          disabled={!endpoint || !token || probing || !!work}
          onClick={() => void probe()}
        >
          {probing ? "Checking…" : "Check"}
        </button>
      </div>
      {error && <div className="share-error" data-testid="setup-error">{error}</div>}
    </>
  );

  return (
    <div
      className="shared-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !work) onClose();
      }}
    >
      <div
        className="shared-modal cloud-modal cloud-modal--wide"
        role="dialog"
        aria-modal="true"
        aria-label={mode === "connect" ? "Connect a domain" : "Open a workspace from a domain"}
      >
        <div className="shared-modal-header">
          <div className="shared-modal-title">
            {mode === "connect" ? "Connect a domain" : "Open a workspace from a domain"}
          </div>
          <button className="shared-modal-close" onClick={onClose} aria-label="Close" disabled={!!work}>
            <CloseIcon />
          </button>
        </div>
        <div className="cloud-body">
          {mode === "connect" ? (
            <ol className="cloud-steps">
              <li className="cloud-step">
                <div className="cloud-step-title">Name it, and say where it will live</div>
                <div className="cloud-step-note">
                  The name is what other Macs and the landing page see. The domain is where the
                  worker answers — a subdomain of one you already use with Cloudflare, or a free
                  address Cloudflare hands out.
                </div>
                <div className="share-field">
                  <div className="share-field-label">Workspace name</div>
                  <input
                    className="share-field-input"
                    data-testid="name-input"
                    value={name}
                    maxLength={80}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <div className="cloud-choices" role="radiogroup" aria-label="Where the cloud lives">
                  <button
                    role="radio"
                    aria-checked={targetKind === "domain"}
                    className={`cloud-choice ${targetKind === "domain" ? "is-active" : ""}`}
                    onClick={() => setTargetKind("domain")}
                  >
                    <span className="cloud-choice-name">A domain of my own</span>
                    <span className="cloud-choice-sub">notes.example.com — its zone on your Cloudflare account</span>
                  </button>
                  <button
                    role="radio"
                    aria-checked={targetKind === "workers-dev"}
                    className={`cloud-choice ${targetKind === "workers-dev" ? "is-active" : ""}`}
                    onClick={() => setTargetKind("workers-dev")}
                  >
                    <span className="cloud-choice-name">A free workers.dev address</span>
                    <span className="cloud-choice-sub">doklin-‹name›.‹your-subdomain›.workers.dev</span>
                  </button>
                </div>
                {targetKind === "domain" ? (
                  <div className="share-field">
                    <div className="share-field-label">Domain</div>
                    <input
                      className="share-field-input"
                      data-testid="domain-input"
                      value={domainInput}
                      placeholder="notes.example.com"
                      spellCheck={false}
                      autoCapitalize="off"
                      autoCorrect="off"
                      onChange={(e) => {
                        setDomainInput(e.target.value);
                        setProbed(null);
                      }}
                    />
                  </div>
                ) : (
                  <div className="share-field">
                    <div className="share-field-label">Name</div>
                    <input
                      className="share-field-input"
                      data-testid="workers-name-input"
                      value={nameInput}
                      placeholder="sherin-notes"
                      spellCheck={false}
                      autoCapitalize="off"
                      autoCorrect="off"
                      onChange={(e) => {
                        setNameInput(e.target.value);
                        setProbed(null);
                      }}
                    />
                  </div>
                )}
                {target && !targetError && (
                  <div className="cloud-step-note">
                    Worker and bucket: <code>{resourceName(target)}</code>
                  </div>
                )}
                {targetError && <div className="share-error">{targetError}</div>}
                {tokenError && <div className="share-error">{tokenError}</div>}
              </li>

              <li className={`cloud-step ${prompt ? "" : "is-waiting"}`}>
                <div className="cloud-step-title">Copy the prompt for your agent</div>
                <div className="cloud-step-note">
                  Run it in Claude Code, or any agent with a terminal. It signs into Cloudflare,
                  deploys the worker and its bucket under names derived from the domain, stores
                  the token as the worker’s secret, and prints the endpoint. It carries the token
                  this app just minted — the domain’s owner credential — so paste it only into an
                  agent you run yourself.
                </div>
                {prompt && (
                  <>
                    <pre className="cloud-prompt" data-testid="setup-prompt">
                      {prompt}
                    </pre>
                    <div className="share-buttons">
                      <button className="share-btn is-primary" onClick={() => void copyPrompt()}>
                        {copied ? "Copied ✓" : "Copy prompt"}
                      </button>
                    </div>
                  </>
                )}
              </li>

              <li className={`cloud-step ${prompt ? "" : "is-waiting"}`}>
                <div className="cloud-step-title">Paste the endpoint it printed</div>
                <div className="cloud-step-note">
                  The line that starts with <code>ENDPOINT:</code>. For a domain of your own it is
                  the domain itself; a workers.dev address includes your account’s subdomain.
                </div>
                {prompt && endpointStep}
                {outcome}
                {doneBlock}
              </li>
            </ol>
          ) : (
            <ol className="cloud-steps">
              <li className="cloud-step">
                <div className="cloud-step-title">Where is it?</div>
                <div className="cloud-step-note">
                  On the Mac that has the workspace: the gear → Cloud… → Connect another Mac…
                  shows both. The token is that domain’s owner credential — keep it to Macs you
                  own.
                </div>
                {endpointStep}
              </li>
              <li className={`cloud-step ${probed ? "" : "is-waiting"}`}>
                <div className="cloud-step-title">Download it</div>
                <div className="cloud-step-note">
                  Into a folder you pick: the workspace lands as a new folder named after it, and
                  stays in step from then on.
                  {root ? " A folder that already is that workspace can be resumed in place instead." : ""}
                </div>
                {outcome}
                {doneBlock}
              </li>
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}

/** The host of an endpoint, for prose. */
function probeDomain(endpoint: string): string {
  return cleanDomain(endpoint) ?? endpoint;
}

/** ", 12 d ago" from an ISO timestamp; nothing when it doesn't parse. */
function createdAgo(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? `, ${timeAgo(t)}` : "";
}
