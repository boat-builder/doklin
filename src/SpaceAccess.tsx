// *Manage access…* on a restricted folder: who is in it, and the four things
// anyone in it may do — add a person, take one out, leave, delete it. Everyone
// in a folder is equal; there is no owner of one.
//
// The folder itself comes from the workspace's status, so the list is what
// the engine believes: a person added or taken out shows the moment the
// command answers. Names come from the People list, which everybody here may
// read. When the folder leaves this Mac — left, deleted, or taken away — the
// status stops listing it and the dialog closes.
//
// The last person cannot leave: a folder is deleted, or handed to somebody
// first, never abandoned by its own people.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  cloudPeople,
  cloudSpaceDelete,
  cloudSpaceMember,
  type CloudMember,
  type CloudSpace,
  type CloudStatus,
} from "./cloud";
import Avatar from "./Avatar";
import { useDismiss } from "./dismiss";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
      <line x1="5" y1="5" x2="19" y2="19" />
      <line x1="19" y1="5" x2="5" y2="19" />
    </svg>
  );
}

export default function SpaceAccess({
  cloud,
  space,
  onLeaving,
  onClose,
}: {
  cloud: CloudStatus;
  /** The folder, as the status lists it now. */
  space: CloudSpace;
  /** Called just before this Mac gives the folder up — leaving it or deleting
   *  it — so the app knows the folder's going is the user's own doing. */
  onLeaving: (space: CloudSpace) => void;
  onClose: () => void;
}) {
  const [everyone, setEveryone] = useState<CloudMember[] | null>(null);
  const [me, setMe] = useState<string | null>(cloud.meId);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Which row is asking "are you sure": `out:<id>`, `leave`, `delete`. */
  const [confirm, setConfirm] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void cloudPeople(cloud.root)
      .then((people) => {
        if (!live) return;
        setEveryone(people.members);
        setMe(people.me);
      })
      .catch((e) => {
        if (live) setError(errText(e));
      });
    return () => {
      live = false;
    };
  }, [cloud.root]);

  // Nothing closes while a change is on its way to the domain.
  const cardRef = useRef<HTMLDivElement>(null);
  useDismiss(() => {
    if (!busy) onClose();
  }, cardRef);

  const act = useCallback(async (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
      setConfirm(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const nameOf = (id: string) => {
    const person = everyone?.find((m) => m.id === id);
    return person ? person.name || person.email : id;
  };
  const inIt = space.members;
  const addable = (everyone ?? []).filter((m) => !inIt.includes(m.id));
  const alone = inIt.length <= 1;

  /** Leave: take yourself out — after handing the folder to `to`, when alone. */
  const leave = (to: string | null) =>
    act(async () => {
      if (!me) throw new Error("This Mac does not know who you are here yet — try again in a moment.");
      if (to) await cloudSpaceMember(cloud.root, space.id, to, true);
      onLeaving(space);
      await cloudSpaceMember(cloud.root, space.id, me, false);
    });

  const title = `Who can open “${space.name}”`;
  return (
    <div className="modal-overlay">
      <div
        ref={cardRef}
        className="modal cloud-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="space-access"
      >
        <div className="modal-header">
          <div className="modal-title">{title}</div>
          <button className="modal-close" onClick={onClose} aria-label="Close" disabled={busy}>
            <CloseIcon />
          </button>
        </div>
        <div className="cloud-body">
          <p className="cloud-hint">
            Only the people here have this folder, on their own Macs. Nobody else in {cloud.name} sees it, or that
            it exists. Anyone in it can add people, take them out, rename it and delete it.
          </p>

          <div className="cloud-section-label">
            {inIt.length} {inIt.length === 1 ? "person" : "people"}
          </div>
          <ul className="space-people" data-testid="space-members">
            {inIt.map((id) => {
              const you = id === me;
              return (
                <li className="space-person" key={id} data-testid={`space-member-${id}`}>
                  <Avatar name={nameOf(id)} size={22} />
                  <span className="space-person-name">{nameOf(id)}</span>
                  {you && <span className="cloud-person-tag">you</span>}
                  <span className="space-person-gap" />
                  {!you &&
                    (confirm === `out:${id}` ? (
                      <span className="cloud-inline-confirm">
                        <span className="cloud-hint">Their Macs delete their copy of this folder.</span>
                        <button
                          className="modal-btn is-danger-solid"
                          data-testid={`space-out-yes-${id}`}
                          disabled={busy}
                          onClick={() => void act(() => cloudSpaceMember(cloud.root, space.id, id, false))}
                        >
                          Remove
                        </button>
                        <button className="modal-btn" disabled={busy} onClick={() => setConfirm(null)}>
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        className="modal-btn"
                        data-testid={`space-out-${id}`}
                        disabled={busy}
                        onClick={() => setConfirm(`out:${id}`)}
                      >
                        Remove
                      </button>
                    ))}
                </li>
              );
            })}
          </ul>

          <div className="cloud-section-label">Add people</div>
          {everyone === null && !error && <p className="cloud-hint">Loading…</p>}
          {everyone !== null && addable.length === 0 && (
            <p className="cloud-hint" data-testid="space-everyone-in">
              Everyone in {cloud.name} is in this folder already.
            </p>
          )}
          {addable.length > 0 && (
            <ul className="space-people" data-testid="space-addable">
              {addable.map((m) => (
                <li className="space-person" key={m.id}>
                  <Avatar name={m.name || m.email} size={22} />
                  <span className="space-person-name">{m.name || m.email}</span>
                  <span className="space-person-email">{m.email}</span>
                  <span className="space-person-gap" />
                  <button
                    className="modal-btn"
                    data-testid={`space-add-${m.id}`}
                    disabled={busy}
                    onClick={() => void act(() => cloudSpaceMember(cloud.root, space.id, m.id, true))}
                  >
                    Add
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="cloud-section-label">This folder</div>
          {confirm === "leave" ? (
            alone ? (
              // The last person: delete it, or hand it to someone.
              <div className="cloud-card cloud-card--attention" data-testid="space-last">
                <div className="cloud-card-title">You are the last person in “{space.name}”</div>
                <p className="cloud-hint">
                  A folder is not left with nobody in it. Hand it to someone — they get it, and you leave — or delete
                  it.
                </p>
                {addable.length > 0 && (
                  <ul className="space-people">
                    {addable.map((m) => (
                      <li className="space-person" key={m.id}>
                        <Avatar name={m.name || m.email} size={22} />
                        <span className="space-person-name">{m.name || m.email}</span>
                        <span className="space-person-gap" />
                        <button
                          className="modal-btn"
                          data-testid={`space-hand-${m.id}`}
                          disabled={busy}
                          onClick={() => void leave(m.id)}
                        >
                          Hand it to them
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="modal-buttons">
                  <button
                    className="modal-btn is-danger-outline"
                    data-testid="space-last-delete"
                    disabled={busy}
                    onClick={() => setConfirm("delete")}
                  >
                    Delete it
                  </button>
                  <button className="modal-btn" disabled={busy} onClick={() => setConfirm(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="cloud-inline-confirm" data-testid="space-leave-confirm">
                <span className="cloud-hint">This Mac deletes its copy of the folder. The others keep theirs.</span>
                <button
                  className="modal-btn is-danger-solid"
                  data-testid="space-leave-yes"
                  disabled={busy}
                  onClick={() => void leave(null)}
                >
                  Leave
                </button>
                <button className="modal-btn" disabled={busy} onClick={() => setConfirm(null)}>
                  Cancel
                </button>
              </div>
            )
          ) : confirm === "delete" ? (
            <div className="cloud-card cloud-card--attention" data-testid="space-delete-confirm">
              <div className="cloud-card-title">Delete “{space.name}” for everyone in it?</div>
              <p className="cloud-hint">
                Everything in it is erased from the cloud, and from the Mac of each person in it. This cannot be
                undone.
              </p>
              <div className="modal-buttons">
                <button
                  className="modal-btn is-danger-solid"
                  data-testid="space-delete-yes"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      onLeaving(space);
                      await cloudSpaceDelete(cloud.root, space.id);
                    })
                  }
                >
                  {busy ? "Deleting…" : "Delete the folder"}
                </button>
                <button className="modal-btn" disabled={busy} onClick={() => setConfirm(null)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="cloud-actions">
              <button className="modal-btn" data-testid="space-leave" disabled={busy} onClick={() => setConfirm("leave")}>
                Leave this folder
              </button>
              <button
                className="modal-btn is-danger-outline"
                data-testid="space-delete"
                disabled={busy}
                onClick={() => setConfirm("delete")}
              >
                Delete it for everyone
              </button>
            </div>
          )}
          {error && <div className="modal-error">{error}</div>}
        </div>
      </div>
    </div>
  );
}
