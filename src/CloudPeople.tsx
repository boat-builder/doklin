// The Cloud panel's People view — docs/cloud.md §7.2, teams-plan.md §11.
// Who is on this workspace, what each of them holds, and the two things an
// owner does about it: let somebody in by email, and take access away again.
//
// Everything comes from `cloud_people` in one answer — including which door
// this Mac came in by. Only the owner's credential is answered by the members
// route, so a member is shown their own half instead of an error, and nothing
// on this Mac records which they are: the domain is asked every time the view
// opens. No `fetch` here either; the engine makes every call.

import { useCallback, useEffect, useState } from "react";
import {
  cloudAdoptOwner,
  cloudInvite,
  cloudPeople,
  cloudRevokeDevice,
  cloudRevokePerson,
  cloudWithdrawInvite,
  timeAgo,
  timeUntil,
  type CloudInvited,
  type CloudMember,
  type CloudPeople as People,
} from "./cloud";

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

export default function CloudPeople({
  root,
  domain,
  copy,
  copied,
}: {
  /** The connected workspace's folder — every command is keyed by it. */
  root: string;
  domain: string;
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
  /** Which row is asking "are you sure": `person:<id>`, `mac:<id>`, `code:<id>`. */
  const [confirm, setConfirm] = useState<string | null>(null);
  const [adopt, setAdopt] = useState({ email: "", name: "" });
  const [now, setNow] = useState(() => Date.now());

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

  if (people.role === "member") {
    return (
      <>
        <div className="cloud-card" data-testid="people-member">
          <div className="cloud-card-title">You’re here on an invite</div>
          <p className="cloud-hint">
            Who else is on {domain} — and inviting anybody, or taking a Mac’s access away — is the
            owner’s to see and do. Your own credential for a second Mac of your own is behind{" "}
            <em>Connect another Mac…</em> — and if you lose it, ask for a fresh invite: it reaches
            the same you, a new code rather than a new person.
          </p>
        </div>
        {error && <div className="modal-error">{error}</div>}
      </>
    );
  }

  const { members, invites } = people;
  const owner = members.find((m) => m.role === "owner") ?? null;
  const macsOf = (m: CloudMember) => people.devices.filter((d) => d.memberId === m.id);

  return (
    <>
      {!owner && (
        <div className="cloud-card cloud-card--attention" data-testid="adopt-owner">
          <div className="cloud-card-title">{domain} doesn’t know who you are</div>
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
            return (
              <li className="cloud-person" key={m.id} data-testid={`person-${m.id}`}>
                <div className="cloud-person-head">
                  <span className="cloud-person-name">{m.name || m.email}</span>
                  {m.role === "owner" && <span className="cloud-person-tag">owner</span>}
                  <span className="cloud-person-email">{m.email}</span>
                </div>
                <div className="cloud-hint">
                  {m.role === "owner"
                    ? "Your Macs hold the domain’s own token, so they aren’t listed here — and can’t be revoked from here either."
                    : macs.length === 0
                      ? waiting
                        ? "Invited — no Mac has traded the code in yet."
                        : "No Mac signed in."
                      : `${macs.length} Mac${macs.length === 1 ? "" : "s"}`}
                  {m.lastSeenAt != null && ` · seen ${timeAgo(m.lastSeenAt, now)}`}
                </div>
                {macs.length > 0 && (
                  <ul className="cloud-macs">
                    {macs.map((d) => (
                      <li className="cloud-mac-row" key={d.id} data-testid={`mac-${d.id}`}>
                        <span className="cloud-mac-name">{d.deviceName || "A Mac"}</span>
                        {d.deviceId && d.deviceId === people.deviceId && (
                          <span className="cloud-person-tag">this Mac</span>
                        )}
                        <span className="cloud-presence-what">joined {timeAgo(d.createdAt, now)}</span>
                        {confirm === `mac:${d.id}` ? (
                          <span className="cloud-inline-confirm">
                            <span className="cloud-hint">Stops syncing on its next check.</span>
                            <button
                              className="modal-btn is-danger-solid"
                              data-testid={`revoke-mac-yes-${d.id}`}
                              disabled={busy}
                              onClick={() => void act(() => cloudRevokeDevice(root, d.id))}
                            >
                              Revoke
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
                            Revoke
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {m.role !== "owner" &&
                  (confirm === `person:${m.id}` ? (
                    <span className="cloud-inline-confirm">
                      <span className="cloud-hint">
                        Every Mac they signed in on stops syncing, and their code stops working. Their
                        copies stay on their own Macs.
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
                      Remove from {domain}
                    </button>
                  ))}
              </li>
            );
          })}
        </ul>
      )}

      {invites.length > 0 && (
        <>
          <div className="cloud-section-label">Codes nobody has used yet</div>
          <ul className="cloud-people" data-testid="invite-list">
            {invites.map((i) => (
              <li className="cloud-person" key={i.id} data-testid={`invite-${i.id}`}>
                <div className="cloud-person-head">
                  <span className="cloud-person-name">{i.name || i.email}</span>
                  <span className="cloud-person-email">{i.email}</span>
                </div>
                <div className="cloud-hint">expires in {timeUntil(i.expiresAt, now)}</div>
                <div className="cloud-actions">
                  <button
                    className="modal-btn"
                    data-testid={`reinvite-${i.id}`}
                    onClick={() => {
                      setMinted(null);
                      setDraft({ email: i.email, name: i.name, days: 7 });
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

      {minted && (
        <div className="cloud-card cloud-card--ok" data-testid="minted-invite">
          <div className="cloud-card-title">A code for {minted.invite.email}</div>
          <pre className="cloud-code" data-testid="invite-code">
            {minted.code}
          </pre>
          <p className="cloud-hint">
            This is the only time it is shown: {domain} kept nothing but its fingerprint, so nobody —
            you included — can read it back. It works once, and stops working in{" "}
            {timeUntil(minted.invite.expiresAt, now)}. Send the whole line; it carries the address
            too, and their app fills both boxes from one paste.
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
          <div className="cloud-card-title">Invite someone to {domain}</div>
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
            The address is who they are, not what lets them in — a code is what does that, and it is
            minted on this Mac. Inviting somebody already here gives them a fresh code and stops the
            one they had.
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
            }}
          >
            Invite someone…
          </button>
          <span className="cloud-hint">They get a credential of their own, which you can take back.</span>
        </div>
      )}
      {error && <div className="modal-error">{error}</div>}
    </>
  );
}
