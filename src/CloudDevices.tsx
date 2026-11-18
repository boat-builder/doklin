// The Devices tab of the workspace's "People, devices and agents" view.
// A device is a Mac, an iPhone or a browser signed in as its person. Everybody
// adds their own, as many as they have, with a code that works once — pasted
// on the other device, it joins as them on a sign-in of its own, so any one
// device can be signed out without touching the rest. No token is ever shown
// or carried between two, and no device is special: the superadmin's are rows
// like anybody's.
//
// The order is the other tabs': the door and the code it ends in at the top,
// the list under them. As everywhere in the view, no `fetch` here — the
// backend makes every call, and the list is its `people` answer.

import { useCallback, useRef, useState } from "react";
import {
  revealSoon,
  timeAgo,
  timeUntil,
  type CloudDeviceCode,
  type CloudPeople,
} from "./cloud";
import { backend, type CloudAccess } from "./backend";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What signing a device out does, said before it is done. A list of devices
 *  does not say which are browsers, so this is true of each kind: a Mac or
 *  an iPhone deletes its copy, a browser what it stored. */
export const signedOutSentence = (name: string): string =>
  `It is signed out, and deletes what it keeps of ${name}, the next time it is used.`;

export default function CloudDevices({
  access,
  root,
  name,
  domain,
  browserAt,
  people,
  reload,
  now,
  copy,
  copied,
}: {
  access: CloudAccess;
  /** The connected workspace's folder — every command is keyed by it. */
  root: string;
  name: string;
  domain: string;
  /** Where the workspace opens in a browser, when the domain serves that. */
  browserAt: string | null;
  /** The People answer: who this device is, and the devices it may be told of. */
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
  const top = useRef<HTMLDivElement>(null);

  const add = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      // The one moment the code exists in the clear: nothing here writes it
      // down, and the domain kept only its sha256.
      setMinted(await access.deviceCode(root));
      revealSoon(top);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }, [root, access]);

  const signOut = useCallback(
    async (id: string) => {
      setBusy(true);
      setError(null);
      try {
        await access.revokeDevice(root, id);
        setConfirm(null);
        await reload();
      } catch (e) {
        setError(errText(e));
      } finally {
        setBusy(false);
      }
    },
    [root, reload, access],
  );

  const mine = people.devices.filter((d) => d.memberId === people.me);
  const superadmin = people.members.find((m) => m.role === "superadmin");

  return (
    <>
      <p className="cloud-hint" data-testid="devices-intro">
        Your devices in {name}: the Macs, iPhones and browsers signed in as you. Each has a sign-in
        of its own, so any one of them can be signed out without touching the others.
      </p>

      <div className="cloud-stack" ref={top}>
        {minted && (
          <div className="cloud-card cloud-card--ok" data-testid="minted-device">
            <div className="cloud-card-title">A code for another device of yours</div>
            <pre className="cloud-code cloud-code--line" data-testid="device-line">
              {minted.blob}
            </pre>
            <p className="cloud-hint" data-testid="device-terms">
              {browserAt
                ? `Paste this line on the other device. On a Mac or an iPhone, open Doklin and choose Join a workspace. In a browser, open ${browserAt}.`
                : "On the other Mac or iPhone, open Doklin, choose Join a workspace and paste this line."}{" "}
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

        {!minted && (
          <div className="cloud-actions">
            <button className="modal-btn is-primary" data-testid="device-add" disabled={busy} onClick={() => void add()}>
              {busy ? "Making a code…" : "Add a device"}
            </button>
            <span className="cloud-hint">
              {browserAt
                ? "Another Mac, an iPhone, or a browser on any computer. It joins with one line you paste there."
                : "Another Mac, or an iPhone. It joins with one line you paste there."}
            </span>
          </div>
        )}
      </div>

      <div className="cloud-section-label">Your devices</div>
      {/* A card each, as the People and Agents tabs list theirs: the name
          and its tag, what it is on a line of its own, then its action. */}
      <ul className="cloud-people" data-testid="device-list">
        {mine.map((d) => {
          const thisMac = d.id === people.tokenId;
          return (
            <li className="cloud-person" key={d.id} data-testid={`device-${d.id}`}>
              <div className="cloud-person-head">
                <span className="cloud-person-name">{d.deviceName || "A device"}</span>
                {thisMac && <span className="cloud-person-tag">this {backend.device}</span>}
              </div>
              <div className="cloud-hint">Joined {timeAgo(d.createdAt, now)}</div>
              {/* Never this one: signing it out would delete the copy being
                  looked at. Disconnect, or a browser's own Sign out, is the
                  way to leave from here. */}
              {!thisMac && (
                <div className="cloud-actions">
                  {confirm === d.id ? (
                    <span className="cloud-inline-confirm">
                      <span className="cloud-hint">{signedOutSentence(name)}</span>
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
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <div className="cloud-section-label">If you lose every device</div>
      <p className="cloud-hint" data-testid="lose-every-device">
        {people.role === "superadmin"
          ? `On a new Mac: the gear → Cloud… → Recover with your Cloudflare account. An agent puts a fresh key on ${domain}’s worker, and that Mac signs in as you.`
          : superadmin
            ? `${superadmin.name || superadmin.email}, the superadmin, can make you a new code to join with.`
            : "The workspace’s superadmin can make you a new code to join with."}
      </p>
      {error && <div className="modal-error">{error}</div>}
    </>
  );
}
