// The Cloud panel's "People and agents" view.
// Two kinds of access, a tab each, because they are let in differently and
// nobody should have to scroll past one to find the other:
//
//   People   work in the Doklin app, on Macs that hold a copy of the
//            workspace. Everybody here sees who is in it; an owner also lets
//            people in, takes access away, and makes other owners.
//   Agents   bots that work through the `doklin` command line with no copy of
//            the folder (CloudAgents.tsx) — shown to whoever may manage them.
//
// Both tabs stay mounted while the view is open — a code that is shown once
// must not be lost to a look at the other tab. In each, what an owner came to
// do is at the top: the door ("Invite someone…", "Add an agent…"), its form,
// and the one-time code it ends in; the lists follow.
//
// Everything comes from `cloud_people` in one answer — including who this Mac
// is here and what it may do, which the domain is asked every time the view
// opens: a role is the person's, and an owner can change it. Every button
// below is offered by `may(people, …)`, the same table the domain decides by
// (cloud-worker/src/roles.ts), so nothing is drawn that would be refused. No
// `fetch` here either; the engine makes every call.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  cloudAdoptOwner,
  cloudInvite,
  cloudPeople,
  cloudRevokeDevice,
  cloudRevokePerson,
  cloudSetRole,
  cloudWithdrawInvite,
  may,
  revealSoon,
  timeAgo,
  timeUntil,
  type CloudInvited,
  type CloudMember,
  type CloudPeople as People,
} from "./cloud";
import CloudAgents from "./CloudAgents";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** How long a fresh code is good for. The engine clamps anything longer: a
 *  year of "pending" is not a pending invite, it is a credential nobody is
 *  watching (src-tauri/src/cloud/invite.rs). */
const EXPIRY_CHOICES: { days: number; label: string }[] = [
  { days: 1, label: "1 day" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
];

type Draft = { email: string; name: string; days: number };

/** The view's two tabs. The panel owns which one is showing: each has a door
 *  of its own there. */
export type AccessTab = "people" | "agents";

const TABS: { tab: AccessTab; label: string }[] = [
  { tab: "people", label: "People" },
  { tab: "agents", label: "Agents" },
];

export default function CloudPeople({
  root,
  name,
  domain,
  tab,
  onTab,
  copy,
  copied,
}: {
  /** The connected workspace's folder — every command is keyed by it. */
  root: string;
  /** What the workspace is called — what people are invited to and removed from. */
  name: string;
  domain: string;
  tab: AccessTab;
  onTab: (tab: AccessTab) => void;
  /** The panel's clipboard helper, so "Copied ✓" reads the same everywhere. */
  copy: (key: string, text: string) => void;
  copied: string | null;
}) {
  const [people, setPeople] = useState<People | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  /** The code a fresh invite minted — on screen once, and never again. */
  const [minted, setMinted] = useState<CloudInvited | null>(null);
  /** Which row is asking "are you sure": `person:<id>`, `role:<id>`, `mac:<id>`, `code:<id>`. */
  const [confirm, setConfirm] = useState<string | null>(null);
  const [adopt, setAdopt] = useState({ email: "", name: "" });
  const [now, setNow] = useState(() => Date.now());
  /** The invite door, its form and the code it mints. */
  const top = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      setPeople(await cloudPeople(root));
    } catch (e) {
      setError(errText(e));
    }
  }, [root]);

  useEffect(() => {
    void load();
  }, [load]);

  // "expires in 3 h" keeps counting while the view is open.
  useEffect(() => {
    const h = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(h);
  }, []);

  /** Do something to the domain, then read the list back — the answer to
   *  "did that work" is the list, not the call. */
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

  const send = useCallback(async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const invited = await cloudInvite(root, draft.email.trim(), draft.name.trim() || null, draft.days);
      // The one moment the code exists in the clear: nothing here writes it
      // down, and the domain kept only its sha256.
      setMinted(invited);
      setDraft(null);
      revealSoon(top);
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }, [draft, root, load]);

  if (!people) {
    // A domain that could not be asked says so and offers nothing: an empty
    // roster and an Invite button would both be claims this view cannot make.
    return error ? (
      <div className="modal-error">{error}</div>
    ) : (
      <p className="cloud-hint">Asking {domain} who is here…</p>
    );
  }

  const { members, invites } = people;
  const canInvite = may(people, "people.invite");
  const canRemove = may(people, "people.remove");
  const canSetRoles = may(people, "people.roles");
  const canAgents = may(people, "agents.manage");
  const macsOf = (m: CloudMember) => people.devices.filter((d) => d.memberId === m.id);
  // The holder of the domain's own token who has not yet said who they are:
  // the one person the list cannot name.
  const unnamed = people.creator && !people.me;

  return (
    <>
      {canAgents && (
        <div className="cloud-tabs" role="tablist" aria-label="People and agents">
          {TABS.map((t) => (
            <button
              key={t.tab}
              role="tab"
              aria-selected={tab === t.tab}
              className={`cloud-tab ${tab === t.tab ? "is-active" : ""}`}
              data-testid={`tab-${t.tab}`}
              onClick={() => onTab(t.tab)}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      <div
        className="cloud-stack"
        role={canAgents ? "tabpanel" : undefined}
        data-testid="pane-people"
        hidden={canAgents && tab !== "people"}
      >
        {unnamed && (
          <div className="cloud-card cloud-card--attention" data-testid="adopt-owner">
            <div className="cloud-card-title">{name} doesn’t know who you are</div>
            <p className="cloud-hint">
              Your address is how this workspace names you — in the list below, and on what you write
              once history says <em>who</em> rather than <em>which Mac</em>. It is stored on your own
              domain and told to nobody else. Your access doesn’t depend on it: the domain’s token is
              what lets this Mac in, with or without a name.
            </p>
            <div className="cloud-copy-row">
              <input
                className="modal-field-input"
                data-testid="adopt-email"
                placeholder="you@example.com"
                value={adopt.email}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(e) => setAdopt({ ...adopt, email: e.target.value })}
              />
              <input
                className="modal-field-input"
                data-testid="adopt-name"
                placeholder="Your name (optional)"
                value={adopt.name}
                onChange={(e) => setAdopt({ ...adopt, name: e.target.value })}
              />
              <button
                className="modal-btn is-primary"
                data-testid="adopt-save"
                disabled={busy || !adopt.email.trim()}
                onClick={() => void act(() => cloudAdoptOwner(root, adopt.email.trim(), adopt.name.trim() || null))}
              >
                Save
              </button>
            </div>
          </div>
        )}

        <p className="cloud-hint" data-testid="people-intro">
          {canInvite
            ? `Everyone in ${name}. Each has a copy of it on a Mac of their own, kept in step with yours. You let someone in with an invite code, and they stay until an owner removes them.`
            : `Everyone in ${name}. Each has a copy of it on a Mac of their own, kept in step with yours. An owner invites people and removes them.`}
        </p>

        {canInvite && (
          <div className="cloud-stack" ref={top}>
            {minted && (
              <div className="cloud-card cloud-card--ok" data-testid="minted-invite">
                <div className="cloud-card-title">A code for {minted.invite.email}</div>
                <pre className="cloud-code" data-testid="invite-code">
                  {minted.code}
                </pre>
                <p className="cloud-hint" data-testid="invite-terms">
                  The code works once, for {timeUntil(minted.invite.expiresAt, now)}. Their access lasts
                  until an owner removes them.
                </p>
                <p className="cloud-hint">
                  Send the whole line: it carries the address too, and they join with one paste. This
                  is the only time the code is shown — {domain} kept nothing but its fingerprint, so
                  nobody, you included, can read it back.
                </p>
                <div className="modal-buttons">
                  <button className="modal-btn is-primary" data-testid="copy-invite-line" onClick={() => copy("invite-line", minted.blob)}>
                    {copied === "invite-line" ? "Copied ✓" : "Copy the line to send"}
                  </button>
                  <button className="modal-btn" onClick={() => copy("invite-code", minted.code)}>
                    {copied === "invite-code" ? "Copied ✓" : "Copy the code alone"}
                  </button>
                  <button className="modal-btn" data-testid="minted-done" onClick={() => setMinted(null)}>
                    Done
                  </button>
                </div>
              </div>
            )}

            {draft ? (
              <div className="cloud-card" data-testid="invite-form">
                <div className="cloud-card-title">Invite someone to {name}</div>
                <div className="modal-field">
                  <div className="modal-field-label">Their email</div>
                  <input
                    className="modal-field-input"
                    data-testid="invite-email"
                    placeholder="them@example.com"
                    value={draft.email}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                  />
                </div>
                <div className="modal-field">
                  <div className="modal-field-label">Their name (optional)</div>
                  <input
                    className="modal-field-input"
                    data-testid="invite-name"
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  />
                </div>
                <div className="modal-field">
                  <div className="modal-field-label">The code is good for</div>
                  <select
                    className="modal-field-input"
                    data-testid="invite-days"
                    value={draft.days}
                    onChange={(e) => setDraft({ ...draft, days: Number(e.target.value) })}
                  >
                    {EXPIRY_CHOICES.map((c) => (
                      <option key={c.days} value={c.days}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
                <p className="cloud-hint">
                  Only the code runs out. Once they have joined, their access lasts until an owner
                  removes them. Inviting somebody already here gives them a fresh code — for another
                  Mac, say — and stops the one they had.
                </p>
                <div className="modal-buttons">
                  <button
                    className="modal-btn is-primary"
                    data-testid="invite-send"
                    disabled={busy || !draft.email.trim()}
                    onClick={() => void send()}
                  >
                    {busy ? "Making a code…" : "Make a code"}
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
                  data-testid="invite-open"
                  onClick={() => {
                    setMinted(null);
                    setDraft({ email: "", name: "", days: 7 });
                    revealSoon(top);
                  }}
                >
                  Invite someone…
                </button>
                <span className="cloud-hint">They join with one line you send them.</span>
              </div>
            )}
          </div>
        )}

        <div className="cloud-section-label">
          {members.length} {members.length === 1 ? "person" : "people"}
        </div>
        {members.length === 0 ? (
          <p className="cloud-hint" data-testid="people-empty">
            Nobody but you yet.
          </p>
        ) : (
          <ul className="cloud-people" data-testid="people-list">
            {members.map((m) => {
              const macs = macsOf(m);
              const waiting = invites.some((i) => i.memberId === m.id);
              const you = m.id === people.me;
              // Nobody changes their own row, and nobody the creator's: the
              // domain refuses both, so neither is offered.
              const changeable = !you && !m.creator;
              return (
                <li className="cloud-person" key={m.id} data-testid={`person-${m.id}`}>
                  <div className="cloud-person-head">
                    <span className="cloud-person-name">{m.name || m.email}</span>
                    {you && <span className="cloud-person-tag">you</span>}
                    {m.role === "owner" && <span className="cloud-person-tag">owner</span>}
                    <span className="cloud-person-email">{m.email}</span>
                  </div>
                  <div className="cloud-hint">
                    {m.creator
                      ? `Made this workspace. ${you ? "Your Macs" : "Their Macs"} hold the domain’s own token, so they aren’t counted here.`
                      : m.devices === 0
                        ? waiting
                          ? "Invited — no Mac has traded the code in yet."
                          : "No Mac signed in."
                        : `${m.devices} Mac${m.devices === 1 ? "" : "s"}`}
                    {m.lastSeenAt != null && ` · seen ${timeAgo(m.lastSeenAt, now)}`}
                  </div>
                  {macs.length > 0 && (
                    <ul className="cloud-macs">
                      {macs.map((d) => {
                        // This Mac's own sign-in: the row it redeemed, or the
                        // row whose token it was handed by another Mac.
                        const thisMac = d.id === people.tokenId || (!!d.deviceId && d.deviceId === people.deviceId);
                        return (
                          <li className="cloud-mac-row" key={d.id} data-testid={`mac-${d.id}`}>
                            <span className="cloud-mac-name">{d.deviceName || "A Mac"}</span>
                            {thisMac && <span className="cloud-person-tag">this Mac</span>}
                            <span className="cloud-presence-what">joined {timeAgo(d.createdAt, now)}</span>
                            {/* Never this Mac: signing it out would delete the
                                copy being looked at. Disconnect is the way to
                                stop syncing here. */}
                            {thisMac ? null : confirm === `mac:${d.id}` ? (
                              <span className="cloud-inline-confirm">
                                <span className="cloud-hint">
                                  It stops syncing, and deletes its copy of {name} the next time Doklin
                                  runs there.
                                </span>
                                <button
                                  className="modal-btn is-danger-solid"
                                  data-testid={`revoke-mac-yes-${d.id}`}
                                  disabled={busy}
                                  onClick={() => void act(() => cloudRevokeDevice(root, d.id))}
                                >
                                  Sign out
                                </button>
                                <button className="modal-btn" disabled={busy} onClick={() => setConfirm(null)}>
                                  Cancel
                                </button>
                              </span>
                            ) : (
                              <button
                                className="modal-btn"
                                data-testid={`revoke-mac-${d.id}`}
                                onClick={() => setConfirm(`mac:${d.id}`)}
                              >
                                Sign out
                              </button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {changeable && (canSetRoles || canRemove) && (
                    <div className="cloud-actions">
                      {canSetRoles &&
                        (confirm === `role:${m.id}` ? (
                          <span className="cloud-inline-confirm">
                            <span className="cloud-hint">
                              {m.role === "owner"
                                ? "They keep working here, and stop being able to invite or remove people. Codes nobody has used yet are withdrawn."
                                : "They will be able to invite and remove people, make other owners, and delete the workspace."}
                            </span>
                            <button
                              className="modal-btn is-primary"
                              data-testid={`set-role-yes-${m.id}`}
                              disabled={busy}
                              onClick={() =>
                                void act(() => cloudSetRole(root, m.id, m.role === "owner" ? "member" : "owner"))
                              }
                            >
                              {m.role === "owner" ? "Make a member" : "Make an owner"}
                            </button>
                            <button className="modal-btn" disabled={busy} onClick={() => setConfirm(null)}>
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <button
                            className="modal-btn"
                            data-testid={`set-role-${m.id}`}
                            onClick={() => setConfirm(`role:${m.id}`)}
                          >
                            {m.role === "owner" ? "Make a member" : "Make an owner"}
                          </button>
                        ))}
                      {canRemove &&
                        (confirm === `person:${m.id}` ? (
                          <span className="cloud-inline-confirm">
                            <span className="cloud-hint">
                              Their code stops working, and every Mac they signed in on stops syncing and
                              deletes its copy of {name} the next time Doklin runs there. Nothing in the
                              cloud is deleted.
                              {m.role === "owner" && " Codes nobody has used yet are withdrawn with them."}
                            </span>
                            <button
                              className="modal-btn is-danger-solid"
                              data-testid={`remove-person-yes-${m.id}`}
                              disabled={busy}
                              onClick={() => void act(() => cloudRevokePerson(root, m.id))}
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
                            data-testid={`remove-person-${m.id}`}
                            onClick={() => setConfirm(`person:${m.id}`)}
                          >
                            Remove from {name}
                          </button>
                        ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {canInvite && invites.length > 0 && (
          <>
            <div className="cloud-section-label">Codes nobody has used yet</div>
            <ul className="cloud-people" data-testid="invite-list">
              {invites.map((i) => (
                <li className="cloud-person" key={i.id} data-testid={`invite-${i.id}`}>
                  <div className="cloud-person-head">
                    <span className="cloud-person-name">{i.name || i.email}</span>
                    <span className="cloud-person-email">{i.email}</span>
                  </div>
                  <div className="cloud-hint">the code runs out in {timeUntil(i.expiresAt, now)}</div>
                  <div className="cloud-actions">
                    <button
                      className="modal-btn"
                      data-testid={`reinvite-${i.id}`}
                      onClick={() => {
                        setMinted(null);
                        setDraft({ email: i.email, name: i.name, days: 7 });
                        revealSoon(top);
                      }}
                    >
                      New code…
                    </button>
                    {confirm === `code:${i.id}` ? (
                      <span className="cloud-inline-confirm">
                        <span className="cloud-hint">The code stops working; they stay invited to nothing.</span>
                        <button
                          className="modal-btn is-danger-solid"
                          data-testid={`withdraw-yes-${i.id}`}
                          disabled={busy}
                          onClick={() => void act(() => cloudWithdrawInvite(root, i.id))}
                        >
                          Withdraw
                        </button>
                        <button className="modal-btn" disabled={busy} onClick={() => setConfirm(null)}>
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        className="modal-btn"
                        data-testid={`withdraw-${i.id}`}
                        onClick={() => setConfirm(`code:${i.id}`)}
                      >
                        Withdraw
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
        {error && <div className="modal-error">{error}</div>}
      </div>

      {canAgents && (
        <div className="cloud-stack" role="tabpanel" data-testid="pane-agents" hidden={tab !== "agents"}>
          <CloudAgents root={root} domain={domain} copy={copy} copied={copied} />
        </div>
      )}
    </>
  );
}
