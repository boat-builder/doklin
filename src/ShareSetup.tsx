// "Set up sharing" guide: a step-by-step modal that walks through standing up
// the Cloudflare backend (R2 bucket + share worker) and ends by verifying +
// saving the endpoint/token from inside the app. Three paths, one per tab:
// the default runs entirely in the Cloudflare dashboard — the app carries the
// worker code itself (bundled at build time, see vite.config.ts), generates
// the token, and the user just clicks and pastes; the "AI agent" tab is a
// copyable prompt that has a coding agent (Claude Code etc.) run the wrangler
// steps and report back the endpoint; the terminal tab is the classic
// wrangler walkthrough. Cloudflare + R2 is the only supported backend.

import { useEffect, useState } from "react";
import workerCode from "virtual:share-worker-code";
import { saveShareConfig, testShareConfig, type ShareConfig } from "./share";

const REPO_URL = "https://github.com/boat-builder/doklin";
const WORKER_GUIDE_URL = `${REPO_URL}/tree/main/share-worker#custom-domain-optional`;
const CLOUDFLARE_SIGNUP_URL = "https://dash.cloudflare.com/sign-up";
const CLOUDFLARE_DASH_URL = "https://dash.cloudflare.com";
const NODE_URL = "https://nodejs.org";

// The bearer token that authorizes this app against the worker. Generated
// here so the user never needs openssl: shown in the secret step, prefilled
// in the connect step — both sides of the handshake come from the same string.
function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// The hand-off prompt for an AI coding agent (Claude Code etc.) with shell
// access. It deploys from the public repo's source — deliberately no embedded
// worker code: 85 KB of JS would bloat the prompt past usefulness and drift
// from the canonical source, while cloning a public repo is trivial for an
// agent. The app's generated token rides along, so the only value the agent
// must hand back is the endpoint URL.
function buildAgentPrompt(token: string): string {
  return `Set up the self-hosted sharing backend for the Doklin app on my Cloudflare account: one Cloudflare Worker in front of one R2 bucket.

1. Clone ${REPO_URL} (shallow is fine) into a temporary directory and work in its share-worker/ folder. The folder's README.md has details if you need them; these steps are the whole job.
2. Run \`npx -y wrangler@4 whoami\`. If it says not logged in, run \`npx -y wrangler@4 login\` and ask me to complete the sign-in in the browser window it opens.
3. Copy wrangler.toml.example to wrangler.toml. Fill in account_id from whoami. Keep name = "doklin-share". Set bucket_name to "doklin-pages" (or another name if you must).
4. Create the bucket: \`npx -y wrangler@4 r2 bucket create doklin-pages\`. If the account has never enabled R2, pause and ask me to enable R2 once in the Cloudflare dashboard (it may require adding a payment method; the free allowance covers this use).
5. Store the app's write token as the worker secret: run \`npx -y wrangler@4 secret put SHARE_TOKEN\` and give it exactly this value:
${token}
6. Deploy: \`npx -y wrangler@4 deploy\`. Note the printed workers.dev URL.
7. Verify: an HTTP GET of <worker-url>/api/pages with header "Authorization: Bearer <the token from step 5>" must return status 200 and JSON like {"pages":[...]}. Fix and redeploy until it does.
8. Finish by printing exactly this line, filled in, so I can copy it back into the Doklin app:
ENDPOINT: <the worker URL, no trailing slash>

The token is already configured in the app, so the endpoint is the only value I need back. Do not commit wrangler.toml anywhere, and do not create or modify any other Cloudflare resources.`;
}

export default function ShareSetup({
  config,
  onClose,
  onOpenExternal,
  onConfigChanged,
}: {
  config: ShareConfig | null;
  onClose: () => void;
  onOpenExternal: (url: string) => void;
  onConfigChanged: (config: ShareConfig) => void;
}) {
  const [mode, setMode] = useState<"agent" | "browser" | "terminal">("agent");
  const [freshToken] = useState(generateToken);
  const [endpoint, setEndpoint] = useState(config?.endpoint ?? "");
  const [token, setToken] = useState(config?.token ?? freshToken);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);

  const agentPrompt = buildAgentPrompt(freshToken);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const verifyAndSave = async () => {
    if (busy) return;
    const cleanEndpoint = endpoint.trim().replace(/\/+$/, "");
    const cleanToken = token.trim();
    if (!/^https?:\/\/\S+$/.test(cleanEndpoint)) {
      setError("The endpoint must be an http(s) URL — your worker's address.");
      return;
    }
    if (!cleanToken) {
      setError("Paste the share token (the value stored as SHARE_TOKEN).");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = { endpoint: cleanEndpoint, token: cleanToken };
      await testShareConfig(next);
      await saveShareConfig(next);
      onConfigChanged(next);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const copyWorkerCode = async () => {
    try {
      await navigator.clipboard.writeText(workerCode);
      setCodeCopied(true);
      window.setTimeout(() => setCodeCopied(false), 1600);
    } catch (e) {
      console.error("copy worker code failed", e);
    }
  };

  // Copying the prompt is the commitment point for the agent path: the agent
  // will install `freshToken` as the secret, so sync the connect form to it —
  // even if an older config had prefilled something else.
  const copyAgentPrompt = async () => {
    try {
      await navigator.clipboard.writeText(agentPrompt);
      setToken(freshToken);
      setSaved(false);
      setPromptCopied(true);
      window.setTimeout(() => setPromptCopied(false), 1600);
    } catch (e) {
      console.error("copy agent prompt failed", e);
    }
  };

  const link = (url: string, label: string) => (
    <button className="setup-link" onClick={() => onOpenExternal(url)}>
      {label}
    </button>
  );

  return (
    <div
      className="shared-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="setup-modal" role="dialog" aria-modal="true" aria-label="Set up sharing">
        <div className="shared-modal-header">
          <div className="shared-modal-title">Set up sharing</div>
          <button className="shared-modal-close" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="setup-body">
          <div className="setup-layout">
            <aside className="setup-rail">
              <p className="setup-intro">
                Sharing publishes read-only copies of your notes through{" "}
                <strong>your own Cloudflare account</strong> — one small worker in front of an R2
                bucket, well inside the free tier. A one-time setup, about ten minutes.
              </p>
              <div className="setup-mode" role="tablist" aria-label="Setup method">
                <button
                  role="tab"
                  aria-selected={mode === "agent"}
                  className={`setup-mode-btn ${mode === "agent" ? "is-active" : ""}`}
                  onClick={() => setMode("agent")}
                >
                  <span className="setup-mode-name">With an AI agent</span>
                  <span className="setup-mode-sub">Hand it to Claude Code — fastest</span>
                </button>
                <button
                  role="tab"
                  aria-selected={mode === "browser"}
                  className={`setup-mode-btn ${mode === "browser" ? "is-active" : ""}`}
                  onClick={() => setMode("browser")}
                >
                  <span className="setup-mode-name">In the browser</span>
                  <span className="setup-mode-sub">Click through the dashboard</span>
                </button>
                <button
                  role="tab"
                  aria-selected={mode === "terminal"}
                  className={`setup-mode-btn ${mode === "terminal" ? "is-active" : ""}`}
                  onClick={() => setMode("terminal")}
                >
                  <span className="setup-mode-name">In the terminal</span>
                  <span className="setup-mode-sub">Run wrangler yourself</span>
                </button>
              </div>
              <div className="setup-footer">
                Want links on your own domain (like <code>notes.example.com</code>), or a branded
                landing page? See {link(WORKER_GUIDE_URL, "the share-worker guide")}.
              </div>
            </aside>
            <div className="setup-main">
              {mode === "agent" ? (
                <p className="setup-intro">
                  Hand the whole job to an AI coding agent — Claude Code or anything else that can
                  run shell commands on your machine. It needs {link(NODE_URL, "Node.js")} and
                  signs in to {link(CLOUDFLARE_SIGNUP_URL, "your Cloudflare account")} through a
                  browser window you approve. It hands back one endpoint URL.
                </p>
              ) : mode === "browser" ? (
                <p className="setup-intro">
                  No developer tools needed — just{" "}
                  {link(CLOUDFLARE_SIGNUP_URL, "a free Cloudflare account")} and this guide. Keep
                  this window open while you work through{" "}
                  {link(CLOUDFLARE_DASH_URL, "the Cloudflare dashboard")}; exact menu labels can
                  drift a little as Cloudflare updates it.
                </p>
              ) : (
                <p className="setup-intro">
                  For the terminal-inclined: you'll need{" "}
                  {link(CLOUDFLARE_SIGNUP_URL, "a free Cloudflare account")} and{" "}
                  {link(NODE_URL, "Node.js")}. Steps 2–6 run in the <code>share-worker</code>{" "}
                  folder from step 1.
                </p>
              )}
              <ol className="setup-steps">
                {mode === "agent" ? (
                  <>
                    <li className="setup-step">
                      <div className="setup-step-title">Copy the prompt for your agent</div>
                      <div className="setup-step-note">
                        Read it first — it's the complete job description, and it{" "}
                        <strong>contains the access token</strong> for your new backend, so only
                        hand it to an agent you trust on your own machine. The agent deploys from
                        the app's public repo; nothing here is secret except that token.
                      </div>
                      <pre className="setup-prompt">{agentPrompt}</pre>
                      <div className="setup-code-row">
                        <button
                          className="share-btn is-primary"
                          onClick={() => void copyAgentPrompt()}
                        >
                          {promptCopied ? "Copied ✓" : "Copy prompt"}
                        </button>
                      </div>
                    </li>
                    <li className="setup-step">
                      <div className="setup-step-title">Run it and follow along</div>
                      <div className="setup-step-note">
                        Paste the prompt into the agent and let it work. It may pause for you
                        twice: to complete the Cloudflare sign-in in a browser window, and — the
                        first time an account uses R2 — to enable R2 in the dashboard (asks for a
                        payment method; the free allowance covers sharing).
                      </div>
                    </li>
                  </>
                ) : mode === "browser" ? (
                  <>
                    <li className="setup-step">
                      <div className="setup-step-title">Create a Cloudflare account</div>
                      <div className="setup-step-note">
                        {link(CLOUDFLARE_SIGNUP_URL, "Sign up")} (the free plan is all sharing
                        needs), then log in to {link(CLOUDFLARE_DASH_URL, "the dashboard")}.
                      </div>
                    </li>
                    <li className="setup-step">
                      <div className="setup-step-title">Create the storage bucket</div>
                      <div className="setup-step-note">
                        In the dashboard's sidebar open <strong>R2 Object Storage</strong> →{" "}
                        <strong>Create bucket</strong>. Name it anything — <code>doklin-pages</code>{" "}
                        is a fine choice — and leave every option at its default. First time using
                        R2? It asks for a payment method once; sharing fits well within the free
                        allowance.
                      </div>
                    </li>
                    <li className="setup-step">
                      <div className="setup-step-title">Create the worker</div>
                      <div className="setup-step-note">
                        Sidebar → <strong>Workers &amp; Pages</strong> → <strong>Create</strong> →
                        create a Worker from the <strong>Hello World</strong> starter. Name it{" "}
                        <code>doklin-share</code> (the name becomes part of your share links) and
                        hit <strong>Deploy</strong>. If Cloudflare asks you to pick a{" "}
                        <code>workers.dev</code> subdomain first, choose one — that's your personal
                        hosting address.
                      </div>
                    </li>
                    <li className="setup-step">
                      <div className="setup-step-title">Replace its code with the share worker</div>
                      <div className="setup-step-note">
                        On the worker's page choose <strong>Edit code</strong>. Select everything in
                        the editor, delete it, paste the code from the button below, then{" "}
                        <strong>Deploy</strong>. It's the app's open-source share worker — the same
                        code you can read in the repo's <code>share-worker</code> folder.
                      </div>
                      <div className="setup-code-row">
                        <button className="share-btn is-primary" onClick={() => void copyWorkerCode()}>
                          {codeCopied ? "Copied ✓" : "Copy worker code"}
                        </button>
                        <span className="setup-code-size">
                          ~{Math.round(workerCode.length / 1024)} KB of JavaScript
                        </span>
                      </div>
                    </li>
                    <li className="setup-step">
                      <div className="setup-step-title">Connect the bucket to the worker</div>
                      <div className="setup-step-note">
                        On the worker's page: <strong>Settings</strong> → <strong>Bindings</strong> →{" "}
                        <strong>Add</strong> → <strong>R2 bucket</strong>. Set the variable name to
                        exactly <code>PAGES</code> and pick the bucket from step 2, then save. The
                        worker refuses to run without this binding.
                      </div>
                    </li>
                    <li className="setup-step">
                      <div className="setup-step-title">Set the access token</div>
                      <div className="setup-step-note">
                        Still in <strong>Settings</strong> → <strong>Variables and Secrets</strong> →{" "}
                        <strong>Add</strong>. Type <strong>Secret</strong>, name exactly{" "}
                        <code>SHARE_TOKEN</code>, and for the value paste this token — generated just
                        now, only shown here:
                      </div>
                      <TokenRow token={freshToken} />
                      <div className="setup-step-note">
                        Save (Cloudflare may redeploy the worker — that's fine). This token is what
                        lets this app, and nothing else, publish pages.
                      </div>
                    </li>
                  </>
                ) : (
                  <>
                    <li className="setup-step">
                      <div className="setup-step-title">Get the worker code</div>
                      <div className="setup-step-note">
                        The backend lives in the app's open-source repo, in the{" "}
                        <code>share-worker</code> folder. No git? Download the ZIP from{" "}
                        {link(REPO_URL, "the GitHub page")} instead.
                      </div>
                      <Cmd text={`git clone ${REPO_URL}.git`} />
                      <Cmd text="cd doklin/share-worker" />
                    </li>
                    <li className="setup-step">
                      <div className="setup-step-title">Sign in to Cloudflare from the terminal</div>
                      <div className="setup-step-note">
                        Opens a browser window to authorize wrangler, Cloudflare's deploy tool.
                      </div>
                      <Cmd text="npx wrangler@4 login" />
                    </li>
                    <li className="setup-step">
                      <div className="setup-step-title">Create your deployment config</div>
                      <div className="setup-step-note">
                        Then open <code>wrangler.toml</code> in any editor and fill in the two
                        placeholders: <code>account_id</code> (printed by{" "}
                        <code>npx wrangler@4 whoami</code>) and <code>bucket_name</code> — pick any
                        name, e.g. <code>doklin-pages</code>.
                      </div>
                      <Cmd text="cp wrangler.toml.example wrangler.toml" />
                    </li>
                    <li className="setup-step">
                      <div className="setup-step-title">Create the storage bucket</div>
                      <div className="setup-step-note">
                        Use the same name you put in <code>wrangler.toml</code>. First time using R2?
                        Enable it once under <strong>R2</strong> in the Cloudflare dashboard — it
                        asks for a payment method, but sharing fits well within the free allowance.
                      </div>
                      <Cmd text="npx wrangler@4 r2 bucket create doklin-pages" />
                    </li>
                    <li className="setup-step">
                      <div className="setup-step-title">Store the app's write token</div>
                      <div className="setup-step-note">
                        When prompted for the value, paste this token — generated just now, only
                        shown here (it's prefilled in the last step too):
                      </div>
                      <TokenRow token={freshToken} />
                      <Cmd text="npx wrangler@4 secret put SHARE_TOKEN" />
                    </li>
                    <li className="setup-step">
                      <div className="setup-step-title">Deploy the worker</div>
                      <div className="setup-step-note">
                        Prints your worker's public URL, like{" "}
                        <code>https://doklin-share.your-name.workers.dev</code>. That URL is your
                        endpoint.
                      </div>
                      <Cmd text="npx wrangler@4 deploy" />
                    </li>
                  </>
                )}
                <li className="setup-step">
                  <div className="setup-step-title">Connect this app</div>
                  <div className="setup-step-note">
                    {mode === "agent" ? (
                      <>
                        Paste the <code>ENDPOINT</code> the agent reported when it finished. The
                        token is already filled in — it's the one embedded in the prompt. Both are
                        stored only on this Mac.
                      </>
                    ) : mode === "browser" ? (
                      <>
                        The endpoint is your worker's URL — shown on its overview page, like{" "}
                        <code>https://doklin-share.your-name.workers.dev</code>. The token is
                        already filled in with the one above. Both are stored only on this Mac.
                      </>
                    ) : (
                      <>
                        The endpoint is the URL deploy printed. The token is already filled in with
                        the one above — replace it if you stored a different value. Both are stored
                        only on this Mac.
                      </>
                    )}
                  </div>
                  <div className="share-field">
                    <div className="share-field-label">Endpoint</div>
                    <input
                      className="share-field-input"
                      value={endpoint}
                      onChange={(e) => {
                        setEndpoint(e.target.value);
                        setSaved(false);
                      }}
                      spellCheck={false}
                      autoCapitalize="off"
                      autoCorrect="off"
                      placeholder="https://doklin-share.your-name.workers.dev"
                      aria-label="Share endpoint"
                    />
                  </div>
                  <div className="share-field">
                    <div className="share-field-label">Token</div>
                    <input
                      className="share-field-input share-field-token"
                      value={token}
                      onChange={(e) => {
                        setToken(e.target.value);
                        setSaved(false);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void verifyAndSave();
                      }}
                      spellCheck={false}
                      autoCapitalize="off"
                      autoCorrect="off"
                      placeholder="the SHARE_TOKEN value"
                      aria-label="Share token"
                    />
                  </div>
                  {saved ? (
                    <>
                      <div className="setup-done">
                        <CheckIcon /> Connected — sharing is ready. Open any note and hit{" "}
                        <strong>Share</strong>.
                      </div>
                      <div className="share-buttons">
                        <button className="share-btn is-primary" onClick={onClose}>
                          Done
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="share-buttons">
                      <button
                        className="share-btn is-primary"
                        onClick={() => void verifyAndSave()}
                        disabled={busy}
                      >
                        {busy ? "Checking…" : "Verify & save"}
                      </button>
                    </div>
                  )}
                  {error && <div className="share-error">{error}</div>}
                </li>
              </ol>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// The generated token, selectable + copyable. Same row treatment as commands —
// retyping 64 hex characters is exactly the failure mode this guide exists to
// prevent.
function TokenRow({ token }: { token: string }) {
  return <Cmd text={token} label="Copy token" />;
}

// One copyable line — a terminal command or a token.
function Cmd({ text, label = "Copy command" }: { text: string; label?: string }) {
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
        title={label}
        aria-label={label}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </div>
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
