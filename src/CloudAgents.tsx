// The Agents tab of the workspace's "People and agents" view.
// An agent is an identity that is not a person: a bot on another computer
// that works with this workspace through the `doklin` command line, with no
// copy of the folder. The owner adds one here, ticks what it may do, and is
// handed one short prompt to give it (cloudPrompts.ts): what Doklin is, the
// command that installs `doklin`, and `doklin login <address> <code>`. That
// is the whole of setting it up, and there is one button for it. Everything
// the agent can reach is decided by the boxes here, on the domain; nothing
// on the bot's machine can widen them.
//
// The order is the People tab's: the door, its form and the prompt it ends
// in at the top, the list under them.
//
// For whoever may manage agents — today an owner: the routes behind this ask
// the same role table as the people routes beside them, and CloudPeople
// renders this tab only when that table says so. As everywhere in the view,
// no `fetch` here — the engine makes every call.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  cloudAgentAdd,
  cloudAgentCode,
  cloudAgentRemove,
  cloudAgentRevokeMachine,
  cloudAgentUpdate,
  cloudAgents,
  revealSoon,
  timeAgo,
  timeUntil,
  type AgentScope,
  type CloudAgent,
  type CloudAgentLogin,
} from "./cloud";
import { buildAgentLoginPrompt } from "./cloudPrompts";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The four permissions, in the order they are shown, with what each lets an
 *  agent do. `read` is not a choice — an agent that cannot read can do
 *  nothing else — so its box is ticked and fixed. */
const SCOPES: { scope: AgentScope; label: string; what: string }[] = [
  { scope: "read", label: "Read", what: "list, read and search documents, and read their comments" },
  { scope: "comment", label: "Comment", what: "start, answer and remove comment threads" },
  { scope: "edit", label: "Edit", what: "write, move and remove documents and files" },
  { scope: "publish", label: "Publish", what: "make any document in this workspace public, and stop publishing" },
];

/** What a new agent starts with. Publishing is off until the owner says so:
 *  a remote agent cannot be asked to confirm, so the box is the whole gate. */
const DEFAULT_SCOPES: AgentScope[] = ["read", "comment", "edit"];

type Draft = { id: string | null; name: string; scopes: AgentScope[] };

/** What an agent is — the first thing on the tab, whatever else it shows. */
const INTRO = (
  <p className="cloud-hint" data-testid="agents-intro">
    Agents are bots. Each works with this workspace from another computer through the{" "}
    <code>doklin</code> command line — reading, writing, commenting and publishing within what
    you allow — with no copy of the folder.
  </p>
);

export default function CloudAgents({
  root,
  domain,
  copy,
  copied,
}: {
  root: string;
  domain: string;
  copy: (key: string, text: string) => void;
  copied: string | null;
}) {
  const [agents, setAgents] = useState<CloudAgent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  /** A login code just minted — on screen once, and never again. */
  const [login, setLogin] = useState<{ name: string; login: CloudAgentLogin } | null>(null);
  /** Which row is asking "are you sure": `agent:<id>` or `machine:<id>`. */
  const [confirm, setConfirm] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** The door, its form and the prompt it ends in. */
  const top = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      setAgents(await cloudAgents(root));
    } catch (e) {
      setError(errText(e));
    }
  }, [root]);

  useEffect(() => {
    void load();
  }, [load]);

  // "expires in 40 min" keeps counting while the view is open.
  useEffect(() => {
    const h = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(h);
  }, []);

  /** Do something to the domain, then read the list back. */
  const act = useCallback(
    async (f: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await f();
        setConfirm(null);
        await load();
      } catch (e) {
        setError(errText(e));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const save = useCallback(() => {
    if (!draft) return;
    const name = draft.name.trim();
    void act(async () => {
      if (draft.id === null) {
        const added = await cloudAgentAdd(root, name, draft.scopes);
        // The one moment the code exists in the clear.
        setLogin({ name: added.agent.name, login: added.login });
        revealSoon(top);
      } else {
        await cloudAgentUpdate(root, draft.id, name, draft.scopes);
      }
      setDraft(null);
    });
  }, [act, draft, root]);

  const newCode = useCallback(
    (agent: CloudAgent) => {
      setDraft(null);
      void act(async () => {
        setLogin({ name: agent.name, login: await cloudAgentCode(root, agent.id) });
        revealSoon(top);
      });
    },
    [act, root],
  );

  const toggle = (scope: AgentScope) => {
    if (!draft || scope === "read") return;
    const has = draft.scopes.includes(scope);
    setDraft({ ...draft, scopes: has ? draft.scopes.filter((s) => s !== scope) : [...draft.scopes, scope] });
  };

  if (!agents) {
    // A worker that predates agents says so here, under what an agent is; the
    // People tab is unaffected.
    return (
      <>
        {INTRO}
        <p className="cloud-hint" data-testid="agents-unavailable">
          {error ?? `Asking ${domain} about its agents…`}
        </p>
      </>
    );
  }

  const prompt = login
    ? buildAgentLoginPrompt({ domain, line: login.login.line, expiresAt: login.login.expiresAt })
    : "";

  return (
    <>
      {INTRO}

      <div className="cloud-stack" ref={top}>
        {login && (
          <div className="cloud-card cloud-card--ok" data-testid="agent-login">
            <div className="cloud-card-title">Log {login.name} in</div>
            <p className="cloud-hint">
              Give this to the agent — paste it into its chat and it sets itself up — or run the two
              commands in it on the machine the agent works from.
            </p>
            <pre className="cloud-prompt cloud-prompt--whole" data-testid="agent-prompt">
              {prompt}
            </pre>
            <p className="cloud-hint">
              The code in it works once, on one machine, and stops working in{" "}
              {timeUntil(login.login.expiresAt, now)}. This is the only time it is shown: {domain} kept
              nothing but its fingerprint. A second machine needs a code of its own —{" "}
              <em>New login code…</em> on the agent’s row.
            </p>
            <div className="modal-buttons">
              <button
                className="modal-btn is-primary"
                data-testid="copy-agent-prompt"
                onClick={() => copy("agent-prompt", prompt)}
              >
                {copied === "agent-prompt" ? "Copied ✓" : "Copy prompt"}
              </button>
              <button className="modal-btn" data-testid="agent-login-done" onClick={() => setLogin(null)}>
                Done
              </button>
            </div>
          </div>
        )}

        {draft ? (
          <div className="cloud-card" data-testid="agent-form">
            <div className="cloud-card-title">{draft.id === null ? `Add an agent to ${domain}` : "Edit this agent"}</div>
            <div className="modal-field">
              <div className="modal-field-label">Its name</div>
              <input
                className="modal-field-input"
                data-testid="agent-name"
                placeholder="Research bot"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </div>
            <div className="modal-field">
              <div className="modal-field-label">It may</div>
              <div className="cloud-scopes">
                {SCOPES.map((s) => (
                  <label className="cloud-scope" key={s.scope}>
                    <input
                      type="checkbox"
                      data-testid={`agent-scope-${s.scope}`}
                      checked={draft.scopes.includes(s.scope)}
                      disabled={s.scope === "read"}
                      onChange={() => toggle(s.scope)}
                    />
                    <span>
                      <strong>{s.label}</strong> — {s.what}
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <p className="cloud-hint">
              The name is what its comments and changes are signed with. An agent cannot see or change
              who is on this workspace, its history or its settings, whatever is ticked here — and a
              change to these boxes reaches it on its next command.
            </p>
            <div className="modal-buttons">
              <button
                className="modal-btn is-primary"
                data-testid="agent-save"
                disabled={busy || !draft.name.trim()}
                onClick={save}
              >
                {draft.id === null ? (busy ? "Adding…" : "Add, and make a login code") : busy ? "Saving…" : "Save"}
              </button>
              <button className="modal-btn" disabled={busy} onClick={() => setDraft(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="cloud-actions">
            <button
              className="modal-btn is-primary"
              data-testid="agent-open"
              onClick={() => {
                setLogin(null);
                setDraft({ id: null, name: "", scopes: DEFAULT_SCOPES });
                revealSoon(top);
              }}
            >
              Add an agent…
            </button>
            <span className="cloud-hint">A bot gets an identity of its own, which you can take back.</span>
          </div>
        )}
      </div>

      <div className="cloud-section-label">
        {agents.length} {agents.length === 1 ? "agent" : "agents"}
      </div>
      {agents.length === 0 ? (
        <p className="cloud-hint" data-testid="agents-empty">
          None yet.
        </p>
      ) : (
        <ul className="cloud-people" data-testid="agent-list">
          {agents.map((a) => (
            <li className="cloud-person" key={a.id} data-testid={`agent-${a.id}`}>
              <div className="cloud-person-head">
                <span className="cloud-person-name">{a.name}</span>
                {a.scopes.includes("publish") && <span className="cloud-person-tag">can publish</span>}
                <span className="cloud-person-email">
                  {SCOPES.filter((s) => a.scopes.includes(s.scope))
                    .map((s) => s.label.toLowerCase())
                    .join(" · ")}
                </span>
              </div>
              <div className="cloud-hint">
                {a.machines.length === 0
                  ? "Not logged in anywhere"
                  : `Logged in on ${a.machines.length} machine${a.machines.length === 1 ? "" : "s"}`}
                {a.lastUsedAt != null && ` · last used ${timeAgo(a.lastUsedAt, now)}`}
                {a.code && a.code.expiresAt > now && ` · a login code is waiting, for ${timeUntil(a.code.expiresAt, now)} more`}
              </div>
              {a.machines.length > 0 && (
                <ul className="cloud-macs">
                  {a.machines.map((m) => (
                    <li className="cloud-mac-row" key={m.id} data-testid={`agent-machine-${m.id}`}>
                      <span className="cloud-mac-name">{m.host}</span>
                      <span className="cloud-presence-what">logged in {timeAgo(m.createdAt, now)}</span>
                      {confirm === `machine:${m.id}` ? (
                        <span className="cloud-inline-confirm">
                          <span className="cloud-hint">Its next command is refused.</span>
                          <button
                            className="modal-btn is-danger-solid"
                            data-testid={`agent-logout-yes-${m.id}`}
                            disabled={busy}
                            onClick={() => void act(() => cloudAgentRevokeMachine(root, a.id, m.id))}
                          >
                            Log out
                          </button>
                          <button className="modal-btn" disabled={busy} onClick={() => setConfirm(null)}>
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          className="modal-btn"
                          data-testid={`agent-logout-${m.id}`}
                          onClick={() => setConfirm(`machine:${m.id}`)}
                        >
                          Log out
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <div className="cloud-actions">
                <button
                  className="modal-btn"
                  data-testid={`agent-code-${a.id}`}
                  disabled={busy}
                  onClick={() => newCode(a)}
                >
                  New login code…
                </button>
                <button
                  className="modal-btn"
                  data-testid={`agent-edit-${a.id}`}
                  onClick={() => {
                    setLogin(null);
                    setDraft({ id: a.id, name: a.name, scopes: a.scopes });
                    revealSoon(top);
                  }}
                >
                  Edit…
                </button>
                {confirm === `agent:${a.id}` ? (
                  <span className="cloud-inline-confirm">
                    <span className="cloud-hint">
                      Every machine it is logged in on is refused from its next command. What it wrote stays.
                    </span>
                    <button
                      className="modal-btn is-danger-solid"
                      data-testid={`agent-remove-yes-${a.id}`}
                      disabled={busy}
                      onClick={() => void act(() => cloudAgentRemove(root, a.id))}
                    >
                      Remove
                    </button>
                    <button className="modal-btn" disabled={busy} onClick={() => setConfirm(null)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    className="modal-btn is-danger-outline"
                    data-testid={`agent-remove-${a.id}`}
                    onClick={() => setConfirm(`agent:${a.id}`)}
                  >
                    Remove
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {error && <div className="modal-error">{error}</div>}
    </>
  );
}
