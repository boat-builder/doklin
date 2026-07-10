// "Set up sharing" guide: a step-by-step modal that walks through standing up
// the Cloudflare backend (R2 bucket + share worker) and ends by verifying +
// saving the connection from inside the app. Three paths, one per tab:
// the default hands the whole job — including putting the links on the user's
// own domain — to an AI coding agent via a copyable prompt; the browser tab
// runs entirely in the Cloudflare dashboard — the app carries the worker code
// itself (bundled at build time, see vite.config.ts), generates the token,
// and the user just clicks and pastes; the terminal tab is the classic
// wrangler walkthrough. Cloudflare + R2 is the only supported backend.
// A successful connect ends with an optional branding step that writes the
// landing page's owner name/link through the worker's site API.

import { useEffect, useState } from "react";
import workerCode from "virtual:share-worker-code";
import {
  fetchSiteConfig,
  newConnectionId,
  pushSiteConfig,
  ShareWorkerOutdatedError,
  testShareConfig,
  type ShareConnection,
  type SiteConfig,
} from "./share";

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

// Loose hostname shape for the optional custom domain: at least one dot, no
// scheme/path (those get stripped before validation).
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

function cleanDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
}

// The hand-off prompt for an AI coding agent (Claude Code etc.) with shell
// access. It deploys from the public repo's source — deliberately no embedded
// worker code: 85 KB of JS would bloat the prompt past usefulness and drift
// from the canonical source, while cloning a public repo is trivial for an
// agent. The app's generated token rides along, so the only value the agent
// must hand back is the endpoint URL. With a domain, the agent also binds the
// worker to it as a Cloudflare Custom Domain — pausing for the one step only
// the user can do (pointing nameservers at Cloudflare).
function buildAgentPrompt(token: string, domain: string): string {
  const target = domain
    ? `one Cloudflare Worker in front of one R2 bucket, serving at my domain https://${domain}`
    : `one Cloudflare Worker in front of one R2 bucket`;
  const tomlStep = domain
    ? `Copy wrangler.toml.example to wrangler.toml. Fill in account_id from whoami. Keep name = "doklin-share". Set bucket_name to "doklin-pages" (or another name if you must). Set workers_dev = false, and set routes = [{ pattern = "${domain}", custom_domain = true }].`
    : `Copy wrangler.toml.example to wrangler.toml. Fill in account_id from whoami. Keep name = "doklin-share". Set bucket_name to "doklin-pages" (or another name if you must).`;
  const deployStep = domain
    ? `Deploy: \`npx -y wrangler@4 deploy\`. Wrangler binds the domain and provisions DNS + TLS itself. If it errors because the zone ${domain.split(".").slice(-2).join(".")} is not on this Cloudflare account, pause and ask me to add the domain in the Cloudflare dashboard (Account Home → Add a domain, free plan) and to point my registrar's nameservers at Cloudflare — then retry once the zone is active. First-deploy certificate issuance can take a minute or two.`
    : `Deploy: \`npx -y wrangler@4 deploy\`. Note the printed workers.dev URL.`;
  const endpoint = domain ? `https://${domain}` : `<the worker URL, no trailing slash>`;
  return `Set up the self-hosted sharing backend for the Doklin app on my Cloudflare account: ${target}.

1. Clone ${REPO_URL} (shallow is fine) into a temporary directory and work in its share-worker/ folder. The folder's README.md has details if you need them; these steps are the whole job.
2. Run \`npx -y wrangler@4 whoami\`. If it says not logged in, run \`npx -y wrangler@4 login\` and ask me to complete the sign-in in the browser window it opens.
3. ${tomlStep}
4. Create the bucket: \`npx -y wrangler@4 r2 bucket create doklin-pages\`. If the account has never enabled R2, pause and ask me to enable R2 once in the Cloudflare dashboard (it may require adding a payment method; the free allowance covers this use).
5. Store the app's write token as the worker secret: run \`npx -y wrangler@4 secret put SHARE_TOKEN\` and give it exactly this value:
${token}
6. ${deployStep}
7. Verify: an HTTP GET of ${domain ? `https://${domain}` : "<worker-url>"}/api/pages with header "Authorization: Bearer <the token from step 5>" must return status 200 and JSON like {"pages":[...]}. ${domain ? "DNS/TLS can lag the deploy by a couple of minutes — retry before assuming failure. " : ""}Fix and redeploy until it does.
8. Finish by printing exactly this line, filled in, so I can copy it back into the Doklin app:
ENDPOINT: ${endpoint}

The token is already configured in the app, so the endpoint is the only value I need back. Do not commit wrangler.toml anywhere, and do not create or modify any other Cloudflare resources.`;
}

export default function ShareSetup({
  isAddingAnother,
  onClose,
  onOpenExternal,
  onConnectionSaved,
}: {
  // True when at least one connection already exists — the guide is being
  // used to add another domain, not to bootstrap sharing.
  isAddingAnother: boolean;
  onClose: () => void;
  onOpenExternal: (url: string) => void;
  onConnectionSaved: (conn: ShareConnection) => Promise<void>;
}) {
  const [mode, setMode] = useState<"agent" | "browser" | "terminal">("agent");
  const [freshToken] = useState(generateToken);
  const [domain, setDomain] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState(freshToken);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The connection that was just verified + saved; flips the last step into
  // its "connected" state with the optional branding form.
  const [savedConn, setSavedConn] = useState<ShareConnection | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  // Branding: prefilled from the worker's current site config after connect
  // (an existing deployment may already carry one); null site = the worker
  // predates /api/site and branding is offered as a redeploy hint instead.
  const [site, setSite] = useState<SiteConfig | null>(null);
  const [ownerName, setOwnerName] = useState("");
  const [ownerLink, setOwnerLink] = useState("");
  const [brandBusy, setBrandBusy] = useState(false);
  const [brandDone, setBrandDone] = useState(false);
  const [brandError, setBrandError] = useState<string | null>(null);

  const cleanedDomain = cleanDomain(domain);
  const domainValid = cleanedDomain === "" || DOMAIN_RE.test(cleanedDomain);
  const agentPrompt = buildAgentPrompt(freshToken, domainValid ? cleanedDomain : "");

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
      const conn: ShareConnection = {
        id: newConnectionId(),
        endpoint: cleanEndpoint,
        token: cleanToken,
      };
      await testShareConfig(conn);
      await onConnectionSaved(conn);
      setSavedConn(conn);
      // Prefill the branding step from whatever the worker already carries;
      // a pre-/api/site worker just skips the form.
      try {
        const current = await fetchSiteConfig(conn);
        setSite(current);
        setOwnerName(current.ownerName ?? "");
        setOwnerLink(current.ownerLink ?? "");
      } catch (e) {
        setSite(null);
        if (!(e instanceof ShareWorkerOutdatedError)) {
          console.error("site config read failed", e);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveBranding = async () => {
    if (!savedConn || site === null || brandBusy) return;
    const name = ownerName.trim();
    const link = ownerLink.trim();
    if (link && !/^https?:\/\/\S+$/.test(link)) {
      setBrandError("The profile link must be an http(s) URL.");
      return;
    }
    setBrandBusy(true);
    setBrandError(null);
    try {
      const next: SiteConfig = {
        ...site,
        ownerName: name || undefined,
        ownerLink: link || undefined,
      };
      delete next.updatedAt;
      await pushSiteConfig(savedConn, next);
      setSite(next);
      setBrandDone(true);
    } catch (e) {
      setBrandError(e instanceof Error ? e.message : String(e));
    } finally {
      setBrandBusy(false);
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
  // and to the domain, whose endpoint is known upfront.
  const copyAgentPrompt = async () => {
    try {
      await navigator.clipboard.writeText(agentPrompt);
      setToken(freshToken);
      if (domainValid && cleanedDomain) setEndpoint(`https://${cleanedDomain}`);
      setSavedConn(null);
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
          <div className="shared-modal-title">
            {isAddingAnother ? "Add a share domain" : "Set up sharing"}
          </div>
          <button className="shared-modal-close" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="setup-body">
          <div className="setup-layout">
            <aside className="setup-rail">
              <p className="setup-intro">
                {isAddingAnother ? (
                  <>
                    Each domain is its own backend on{" "}
                    <strong>your Cloudflare account</strong> — one worker, one
                    bucket, one token. Set it up like the first one; the app
                    lets you pick a domain per share.
                  </>
                ) : (
                  <>
                    Sharing publishes read-only copies of your notes through{" "}
                    <strong>your own Cloudflare account</strong> — one small worker in front of an
                    R2 bucket, well inside the free tier. A one-time setup, about ten minutes,
                    and your links can live on your own domain.
                  </>
                )}
              </p>
              <div className="setup-mode" role="tablist" aria-label="Setup method">
                <button
                  role="tab"
                  aria-selected={mode === "agent"}
                  className={`setup-mode-btn ${mode === "agent" ? "is-active" : ""}`}
                  onClick={() => setMode("agent")}
                >
                  <span className="setup-mode-name">With an AI agent</span>
                  <span className="setup-mode-sub">Hand it to Claude Code — does domains too</span>
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
                Custom domains on the browser/terminal paths, landing-page details, and
                the full API live in {link(WORKER_GUIDE_URL, "the share-worker guide")}.
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
                  drift a little as Cloudflare updates it. Links land on{" "}
                  <code>workers.dev</code>; to use your own domain instead, add it to Cloudflare
                  and give the worker a Custom Domain —{" "}
                  {link(WORKER_GUIDE_URL, "two clicks, see the guide")}.
                </p>
              ) : (
                <p className="setup-intro">
                  For the terminal-inclined: you'll need{" "}
                  {link(CLOUDFLARE_SIGNUP_URL, "a free Cloudflare account")} and{" "}
                  {link(NODE_URL, "Node.js")}. Steps 2–6 run in the <code>share-worker</code>{" "}
                  folder from step 1. Own domain? Set <code>routes</code> in{" "}
                  <code>wrangler.toml</code> before deploying —{" "}
                  {link(WORKER_GUIDE_URL, "see the guide")}.
                </p>
              )}
              <ol className="setup-steps">
                {mode === "agent" ? (
                  <>
                    <li className="setup-step">
                      <div className="setup-step-title">Links on your own domain? Say so here</div>
                      <div className="setup-step-note">
                        Leave empty for a free <code>workers.dev</code> address. With a domain (it
                        can be one you just bought — the agent walks you through pointing it at
                        Cloudflare), your links become{" "}
                        <code>{domainValid && cleanedDomain ? cleanedDomain : "notes.example.com"}/…</code>{" "}
                        and its front page becomes yours too.
                      </div>
                      <div className="share-field">
                        <input
                          className="share-field-input"
                          value={domain}
                          onChange={(e) => {
                            setDomain(e.target.value);
                            setSavedConn(null);
                          }}
                          spellCheck={false}
                          autoCapitalize="off"
                          autoCorrect="off"
                          placeholder="notes.example.com (optional)"
                          aria-label="Custom domain"
                        />
                      </div>
                      {!domainValid && (
                        <div className="share-error">
                          That doesn't look like a domain — just the hostname, like{" "}
                          <code>notes.example.com</code>.
                        </div>
                      )}
                    </li>
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
                        Paste the prompt into the agent and let it work. It may pause for you: to
                        complete the Cloudflare sign-in in a browser window; the first time an
                        account uses R2, to enable R2 in the dashboard (asks for a payment method;
                        the free allowance covers sharing)
                        {cleanedDomain
                          ? "; and, if your domain isn't on Cloudflare yet, to add it and point your registrar's nameservers at Cloudflare (registrars take from minutes to a day to switch)"
                          : ""}
                        .
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
                        lets this app, and nothing else, publish pages. Want the links on your own
                        domain? <strong>Settings</strong> → <strong>Domains &amp; Routes</strong> →{" "}
                        <strong>Add</strong> → <strong>Custom Domain</strong> (the domain must be on
                        your Cloudflare account; details in{" "}
                        {link(WORKER_GUIDE_URL, "the guide")}).
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
                        name, e.g. <code>doklin-pages</code>. For links on your own domain, also set{" "}
                        <code>workers_dev = false</code> and the <code>routes</code> block (the file
                        shows how; the domain's zone must already be on your account).
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
                        <code>https://doklin-share.your-name.workers.dev</code> — or your domain, if
                        you configured one. That URL is your endpoint.
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
                        <code>https://doklin-share.your-name.workers.dev</code> (or{" "}
                        <code>https://your-domain</code> if you added one). The token is already
                        filled in with the one above. Both are stored only on this Mac.
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
                        setSavedConn(null);
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
                        setSavedConn(null);
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
                  {savedConn ? (
                    <div className="setup-done">
                      <CheckIcon /> Connected — sharing is ready. Open any note and hit{" "}
                      <strong>Share</strong>.
                    </div>
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
                {savedConn && (
                  <li className="setup-step">
                    <div className="setup-step-title">Put your name on it (optional)</div>
                    {site !== null ? (
                      <>
                        <div className="setup-step-note">
                          The front page of your share domain introduces the links as yours —
                          “Notes by …”, with a link to a profile of your choice. Change either any
                          time in <strong>Shared pages</strong>, where you can also make any shared
                          page the front page itself.
                        </div>
                        <div className="share-field">
                          <div className="share-field-label">Your name</div>
                          <input
                            className="share-field-input"
                            value={ownerName}
                            onChange={(e) => {
                              setOwnerName(e.target.value);
                              setBrandDone(false);
                            }}
                            placeholder="Ada Lovelace"
                            aria-label="Owner name"
                          />
                        </div>
                        <div className="share-field">
                          <div className="share-field-label">Profile link</div>
                          <input
                            className="share-field-input"
                            value={ownerLink}
                            onChange={(e) => {
                              setOwnerLink(e.target.value);
                              setBrandDone(false);
                            }}
                            spellCheck={false}
                            autoCapitalize="off"
                            autoCorrect="off"
                            placeholder="https://linkedin.com/in/you (optional)"
                            aria-label="Owner profile link"
                          />
                        </div>
                        <div className="share-buttons">
                          {brandDone ? (
                            <div className="setup-done">
                              <CheckIcon /> Saved — see it live at{" "}
                              <button
                                className="setup-link"
                                onClick={() => onOpenExternal(`${savedConn.endpoint}/`)}
                              >
                                {savedConn.endpoint.replace(/^https?:\/\//, "")}
                              </button>
                            </div>
                          ) : (
                            <button
                              className="share-btn is-primary"
                              onClick={() => void saveBranding()}
                              disabled={brandBusy}
                            >
                              {brandBusy ? "Saving…" : "Save landing page"}
                            </button>
                          )}
                          <button className="share-btn" onClick={onClose}>
                            Done
                          </button>
                        </div>
                        {brandError && <div className="share-error">{brandError}</div>}
                      </>
                    ) : (
                      <>
                        <div className="setup-step-note">
                          This worker is an older build that can't take landing-page settings from
                          the app — redeploy it with the latest worker code (any path on the left)
                          to unlock branding and custom home pages. Sharing itself works fine.
                        </div>
                        <div className="share-buttons">
                          <button className="share-btn is-primary" onClick={onClose}>
                            Done
                          </button>
                        </div>
                      </>
                    )}
                  </li>
                )}
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
