// The Devices tab of the workspace's "People, devices and agents" view.
// A device is a Mac or an iPhone signed in as its person: it holds a copy of
// the workspace and keeps it in step. Everybody adds their own, as many as
// they have, with a code that works once — pasted on the other device, it
// joins as them on a sign-in of its own, so any one device can be signed out
// without touching the rest. No token is ever shown or carried between two.
//
// The one exception is said out loud here: the Mac a workspace was made on
// holds the domain's own token, which is no sign-in — it is not in the list
// and cannot be signed out. Whoever holds it keeps a copy for the day every
// device is lost, and that is the only thing it is shown for.
//
// The order is the other tabs': the door and the code it ends in at the top,
// the list under them. As everywhere in the view, no `fetch` here — the
// engine makes every call, and the list comes from `cloud_people`.

import { useCallback, useRef, useState } from "react";
import {
  cloudDeviceCode,
  cloudRevokeDevice,
  cloudToken,
  revealSoon,
  timeAgo,
  timeUntil,
  type CloudCredentials,
  type CloudDeviceCode,
  type CloudPeople,
} from "./cloud";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function CloudDevices({
  root,
  name,
  domain,
  people,
  reload,
  now,
  copy,
  copied,
}: {
  /** The connected workspace's folder — every command is keyed by it. */
  root: string;
  name: string;
  domain: string;
  /** The People answer: who this Mac is, and the devices it may be told of. */
  people: CloudPeople;
  /** Read that answer again — a change is done when the list says so. */
  reload: () => Promise<void>;
  now: number;
  copy: (key: string, text: string) => void;
  copied: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The code a click just minted — on screen once, and never again. */
  const [minted, setMinted] = useState<CloudDeviceCode | null>(null);
  /** Which row is asking "are you sure". */
  const [confirm, setConfirm] = useState<string | null>(null);
  /** The domain's own token, once its holder asked to see it. */
  const [secret, setSecret] = useState<CloudCredentials | null>(null);
  const top = useRef<HTMLDivElement>(null);

  const add = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      // The one moment the code exists in the clear: nothing here writes it
      // down, and the domain kept only its sha256.
      setMinted(await cloudDeviceCode(root));
      revealSoon(top);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }, [root]);

  const signOut = useCallback(
    async (id: string) => {
      setBusy(true);
      setError(null);
      try {
        await cloudRevokeDevice(root, id);
        setConfirm(null);
        await reload();
      } catch (e) {
        setError(errText(e));
      } finally {
        setBusy(false);
      }
    },
    [root, reload],
  );

  const show = useCallback(async () => {
    setError(null);
    try {
      setSecret(await cloudToken(root));
    } catch (e) {
      setError(errText(e));
    }
  }, [root]);

  const mine = people.devices.filter((d) => d.memberId === people.me);
  // A device is signed in as a person, so the holder of the domain's token
  // has to have said who they are before they can add one.
  const unnamed = people.creator && !people.me;

  return (
    <>
      <p className="cloud-hint" data-testid="devices-intro">
        Your devices in {name}: the Macs and iPhones signed in as you. Each holds a copy of the
        workspace and keeps it in step, on a sign-in of its own — so any one of them can be signed
        out without touching the others.
      </p>

      <div className="cloud-stack" ref={top}>
        {minted && (
          <div className="cloud-card cloud-card--ok" data-testid="minted-device">
            <div className="cloud-card-title">A code for another device of yours</div>
            <pre className="cloud-code cloud-code--line" data-testid="device-line">
              {minted.blob}
            </pre>
            <p className="cloud-hint" data-testid="device-terms">
              On the other Mac or iPhone, open Doklin, choose Join a workspace and paste this line.
              It works once, for {timeUntil(minted.expiresAt, now)}. That device is then signed in as
              you: it sees what you see, and you can sign it out here.
            </p>
            <p className="cloud-hint">
              This is the only time the code is shown — {domain} kept nothing but its fingerprint.
              Making another code stops this one.
            </p>
            <div className="modal-buttons">
              <button className="modal-btn is-primary" data-testid="copy-device-line" onClick={() => copy("device-line", minted.blob)}>
                {copied === "device-line" ? "Copied ✓" : "Copy the line"}
              </button>
              <button className="modal-btn" data-testid="minted-device-done" onClick={() => setMinted(null)}>
                Done
              </button>
            </div>
          </div>
        )}

        {unnamed ? (
          <div className="cloud-card cloud-card--attention" data-testid="device-needs-identity">
            <div className="cloud-card-title">Say who you are first</div>
            <p className="cloud-hint">
              A device is signed in as a person, and {name} doesn’t know who you are yet. Give it your
              name and email under People, then add a device here.
            </p>
          </div>
        ) : (
          !minted && (
            <div className="cloud-actions">
              <button className="modal-btn is-primary" data-testid="device-add" disabled={busy} onClick={() => void add()}>
                {busy ? "Making a code…" : "Add a device"}
              </button>
              <span className="cloud-hint">Another Mac, or an iPhone. It joins with one line you paste there.</span>
            </div>
          )
        )}
      </div>

      <div className="cloud-section-label">Your devices</div>
      <ul className="cloud-macs" data-testid="device-list">
        {people.creator && (
          <li className="cloud-mac-row" data-testid="device-secret">
            <span className="cloud-mac-name">This Mac</span>
            <span className="cloud-presence-what">holds the domain’s own token · can’t be signed out</span>
          </li>
        )}
        {mine.map((d) => {
          const thisMac = d.id === people.tokenId;
          return (
            <li className="cloud-mac-row" key={d.id} data-testid={`device-${d.id}`}>
              <span className="cloud-mac-name">{d.deviceName || "A device"}</span>
              {thisMac && <span className="cloud-person-tag">this Mac</span>}
              <span className="cloud-presence-what">joined {timeAgo(d.createdAt, now)}</span>
              {/* Never this Mac: signing it out would delete the copy being
                  looked at. Disconnect is the way to stop syncing here. */}
              {thisMac ? null : confirm === d.id ? (
                <span className="cloud-inline-confirm">
                  <span className="cloud-hint">
                    It stops syncing, and deletes its copy of {name} the next time Doklin runs there.
                  </span>
                  <button
                    className="modal-btn is-danger-solid"
                    data-testid={`device-sign-out-yes-${d.id}`}
                    disabled={busy}
                    onClick={() => void signOut(d.id)}
                  >
                    Sign out
                  </button>
                  <button className="modal-btn" disabled={busy} onClick={() => setConfirm(null)}>
                    Cancel
                  </button>
                </span>
              ) : (
                <button className="modal-btn" data-testid={`device-sign-out-${d.id}`} onClick={() => setConfirm(d.id)}>
                  Sign out
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {people.creator && (
        <>
          <div className="cloud-section-label">If you lose every device</div>
          <p className="cloud-hint">
            The domain’s own token is the way back in: on a new Mac, the gear → Cloud… → Open with the
            domain’s token. Keep a copy somewhere safe. It is never how a device is added — whoever
            holds it has all of {domain}, and it cannot be taken back.
          </p>
          {secret ? (
            <div className="cloud-stack" data-testid="domain-secret">
              <div className="modal-field">
                <div className="modal-field-label">Endpoint</div>
                <div className="cloud-copy-row">
                  <input className="modal-field-input" readOnly value={secret.endpoint} data-testid="creds-endpoint" />
                  <button className="modal-btn" onClick={() => copy("endpoint", secret.endpoint)}>
                    {copied === "endpoint" ? "Copied ✓" : "Copy"}
                  </button>
                </div>
              </div>
              <div className="modal-field">
                <div className="modal-field-label">Token</div>
                <div className="cloud-copy-row">
                  <input className="modal-field-input modal-field-token" readOnly value={secret.token} data-testid="creds-token" />
                  <button className="modal-btn" onClick={() => copy("token", secret.token)}>
                    {copied === "token" ? "Copied ✓" : "Copy"}
                  </button>
                </div>
              </div>
              <div className="cloud-actions">
                <button className="modal-btn" onClick={() => setSecret(null)}>
                  Hide
                </button>
              </div>
            </div>
          ) : (
            <div className="cloud-actions">
              <button className="modal-btn" data-testid="show-domain-secret" onClick={() => void show()}>
                Show the domain’s token
              </button>
            </div>
          )}
        </>
      )}
      {error && <div className="modal-error">{error}</div>}
    </>
  );
}
