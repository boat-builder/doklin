// *Share…* on a folder or a document: who can open it, and what is done
// about that — sharing it with somebody, stopping, leaving it, deleting it
// for everyone. One dialog, whether or not it is shared yet. The iPhone's
// Share sheet says the same, word for word (`ShareWords`,
// ios/DoklinKit/Sources/DoklinKit/Models/Sections.swift): change both.
//
// What is shared stays where it is. Its owner keeps it in their My files, or
// in a folder that is itself shared; the people it is shared with find it
// under Shared with me. Everyone who can open it can read it, edit it and
// share it with more people. Only somebody who can open the folder it sits
// in moves it or deletes it — anyone else leaves it.
//
// What it shows comes from the workspace's status, so the list is what the
// engine believes: a person added or taken off shows the moment the command
// answers. Names come from the People list, which everybody here may read.
// When it leaves this device — left, deleted, or no longer shared with this
// person — the status stops listing it and the dialog closes.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  documentStem,
  placeOf,
  relPathIn,
  shareAt,
  type CloudMember,
  type CloudSpace,
  type CloudStatus,
} from "./cloud";
import Avatar from "./Avatar";
import { useDismiss } from "./dismiss";
import { backend, type CloudAccess, type CloudShares } from "./backend";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const basename = (p: string) => p.split(/[\\/]/).pop() || p;

/** What the dialog is opened on: a folder, or a document by any of its files. */
export type ShareTarget = { path: string; kind: "file" | "dir" };

/** "“A”", "“A” and “B”", "“A”, “B” and “C”". */
const listed = (names: string[]) => {
  const quoted = names.map((n) => `“${n}”`);
  return quoted.length <= 1 ? quoted.join("") : `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
};

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
      <line x1="5" y1="5" x2="19" y2="19" />
      <line x1="19" y1="5" x2="5" y2="19" />
    </svg>
  );
}

export default function ShareDialog({
  access,
  shares,
  cloud,
  target,
  beforeSharing,
  onLeaving,
  onClose,
}: {
  /** Who there is to share with. */
  access: CloudAccess;
  shares: CloudShares;
  cloud: CloudStatus;
  target: ShareTarget;
  /** Land what is being typed in it before it becomes a share. */
  beforeSharing: () => Promise<void>;
  /** Called just before this device gives it up — leaving it or deleting it
   *  — so the app knows its going is the user's own doing. */
  onLeaving: (space: CloudSpace) => void;
  onClose: () => void;
}) {
  const isDir = target.kind === "dir";
  const rel = relPathIn(cloud.root, target.path) ?? "";
  // Which share this is, once it is one: by id, so the dialog follows it
  // through a rename and closes when it is gone.
  const [id, setId] = useState<string | null>(() => shareAt(cloud, rel, isDir)?.id ?? null);
  // What sharing answered, shown until the status lists it: the two arrive
  // apart, and it is shared from the moment the first does.
  const [made, setMade] = useState<CloudSpace | null>(null);
  const inStatus = id ? (cloud.spaces.find((s) => s.id === id && s.deletedAt === null) ?? null) : null;
  const space = inStatus ?? made;

  const [everyone, setEveryone] = useState<CloudMember[] | null>(null);
  const [me, setMe] = useState<string | null>(cloud.meId);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Which row is asking "are you sure": `out:<id>`, `leave`, `delete`. */
  const [confirm, setConfirm] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void access
      .people(cloud.root)
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
  }, [cloud.root, access]);

  // It was a share and the status no longer lists it: it is gone from here.
  const listedOnce = useRef(false);
  useEffect(() => {
    if (inStatus) {
      listedOnce.current = true;
      setMade(null);
    } else if (id && listedOnce.current && !busy) onClose();
  }, [inStatus, id, busy, onClose]);

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

  const name = space?.name ?? (isDir ? basename(target.path) : basename(documentStem(target.path)));
  const what = isDir ? "folder" : "document";
  const nameOf = (person: string) => {
    const found = everyone?.find((m) => m.id === person);
    return found ? found.name || found.email : person === me ? cloud.me : person;
  };
  const title = `Share “${name}”`;

  // Where it sits, and so who can open it before anybody is picked: inside a
  // shared folder, that folder's people already can.
  const slash = rel.lastIndexOf("/");
  const around = placeOf(cloud, slash < 0 ? "" : rel.slice(0, slash));
  // What is shared from inside it already: each stays its own, and the
  // people picked here will open those too.
  const inside = useMemo(
    () =>
      isDir
        ? cloud.spaces
            .filter((s) => s.kind !== "private" && s.path.toLowerCase().startsWith(`${rel.toLowerCase()}/`))
            .map((s) => s.name)
        : [],
    [cloud.spaces, rel, isDir],
  );

  const toggle = (person: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(person)) next.delete(person);
      else next.add(person);
      return next;
    });

  const shareNow = () =>
    act(async () => {
      await beforeSharing();
      const shared = await shares.share(cloud.root, target.path, [...picked]);
      setMade(shared);
      setId(shared.id);
      setPicked(new Set());
    });

  const header = (
    <div className="modal-header">
      <div className="modal-title">{title}</div>
      <button className="modal-close" onClick={onClose} aria-label="Close" disabled={busy}>
        <CloseIcon />
      </button>
    </div>
  );

  /* ---------- Not shared yet ---------- */

  if (!space) {
    const others = everyone?.filter((m) => m.id !== me) ?? null;
    return (
      <div className="modal-overlay">
        <div ref={cardRef} className="modal cloud-modal" role="dialog" aria-modal="true" aria-label={title} data-testid="share-dialog">
          {header}
          <div className="cloud-body">
            <p className="cloud-hint" data-testid="share-hint">
              It stays where it is. The people you pick find it under Shared with me, and can read it, edit it and
              share it with others.
              {around.kind === "share" && ` Everyone who can open “${around.space.name}” can open it already.`}
            </p>
            {inside.length > 0 && (
              <p className="cloud-hint" data-testid="share-inside">
                {listed(inside)} inside it {inside.length === 1 ? "is" : "are"} shared already, and{" "}
                {inside.length === 1 ? "stays" : "stay"} shared as {inside.length === 1 ? "it is" : "they are"}. The
                people you pick will be able to open {inside.length === 1 ? "that" : "those"} too.
              </p>
            )}
            <div className="cloud-section-label">Share with</div>
            {others === null && !error && <p className="cloud-hint">Loading…</p>}
            {others !== null && others.length === 0 && (
              <p className="cloud-hint" data-testid="share-alone">
                Nobody else is in {cloud.name} yet. Invite somebody from People, then share this with them.
              </p>
            )}
            {others !== null && others.length > 0 && (
              <ul className="space-people" data-testid="share-people">
                {others.map((m) => (
                  <li className="space-person" key={m.id}>
                    <label>
                      <input
                        type="checkbox"
                        data-testid={`share-pick-${m.id}`}
                        checked={picked.has(m.id)}
                        disabled={busy}
                        onChange={() => toggle(m.id)}
                      />
                      <Avatar name={m.name || m.email} size={22} />
                      <span className="space-person-name">{m.name || m.email}</span>
                      <span className="space-person-email">{m.email}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {error && <div className="modal-error">{error}</div>}
            <div className="modal-buttons">
              <button
                className="modal-btn is-primary"
                data-testid="share-submit"
                disabled={picked.size === 0 || busy}
                onClick={() => void shareNow()}
              >
                {busy ? "Sharing…" : "Share"}
              </button>
              <button className="modal-btn" disabled={busy} onClick={onClose}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* ---------- Shared ---------- */

  const owner = space.owner;
  // Everyone who can open it: its owner, whoever else has the folder it
  // sits in, then the people it is shared with.
  const through = space.above.filter((p) => p !== owner);
  const withThem = space.members.filter((p) => p !== owner && !through.includes(p));
  const everyoneOn = [...new Set([owner, ...through, ...withThem].filter((p) => p !== ""))];
  const addable = (everyone ?? []).filter((m) => !everyoneOn.includes(m.id));
  const mineToLeave = me !== null && space.members.includes(me) && !space.placed;

  return (
    <div className="modal-overlay">
      <div ref={cardRef} className="modal cloud-modal" role="dialog" aria-modal="true" aria-label={title} data-testid="share-dialog">
        {header}
        <div className="cloud-body">
          <p className="cloud-hint" data-testid="share-hint">
            {space.placed
              ? `It stays where it is. The people it is shared with find it under Shared with me.`
              : `${nameOf(owner)} shared this ${what} with you. It sits in their files, so only they move it or delete it.`}{" "}
            Everyone here can read it, edit it and share it with others.
          </p>

          <div className="cloud-section-label">
            {everyoneOn.length} {everyoneOn.length === 1 ? "person" : "people"} can open it
          </div>
          <ul className="space-people" data-testid="share-members">
            {everyoneOn.map((person) => {
              const you = person === me;
              const direct = withThem.includes(person);
              return (
                <li className="space-person" key={person} data-testid={`share-member-${person}`}>
                  <Avatar name={nameOf(person)} size={22} />
                  <span className="space-person-name">{nameOf(person)}</span>
                  {you && <span className="cloud-person-tag">you</span>}
                  {person === owner && <span className="cloud-person-tag">owner</span>}
                  {through.includes(person) && <span className="cloud-person-tag">has the folder it is in</span>}
                  <span className="space-person-gap" />
                  {direct &&
                    !you &&
                    (confirm === `out:${person}` ? (
                      <span className="cloud-inline-confirm">
                        <span className="cloud-hint">Their devices delete their copy of it.</span>
                        <button
                          className="modal-btn is-danger-solid"
                          data-testid={`share-out-yes-${person}`}
                          disabled={busy}
                          onClick={() => void act(() => shares.shareMember(cloud.root, space.id, person, false))}
                        >
                          Stop sharing
                        </button>
                        <button className="modal-btn" disabled={busy} onClick={() => setConfirm(null)}>
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        className="modal-btn"
                        data-testid={`share-out-${person}`}
                        disabled={busy}
                        onClick={() => setConfirm(`out:${person}`)}
                      >
                        Stop sharing
                      </button>
                    ))}
                </li>
              );
            })}
          </ul>

          <div className="cloud-section-label">Share with more people</div>
          {everyone === null && !error && <p className="cloud-hint">Loading…</p>}
          {everyone !== null && addable.length === 0 && (
            <p className="cloud-hint" data-testid="share-everyone-on">
              Everyone in {cloud.name} can open it already.
            </p>
          )}
          {addable.length > 0 && (
            <ul className="space-people" data-testid="share-addable">
              {addable.map((m) => (
                <li className="space-person" key={m.id}>
                  <Avatar name={m.name || m.email} size={22} />
                  <span className="space-person-name">{m.name || m.email}</span>
                  <span className="space-person-email">{m.email}</span>
                  <span className="space-person-gap" />
                  <button
                    className="modal-btn"
                    data-testid={`share-add-${m.id}`}
                    disabled={busy}
                    onClick={() => void act(() => shares.shareMember(cloud.root, space.id, m.id, true))}
                  >
                    Share
                  </button>
                </li>
              ))}
            </ul>
          )}

          {(mineToLeave || space.placed) && <div className="cloud-section-label">This {what}</div>}
          {confirm === "leave" ? (
            <div className="cloud-inline-confirm" data-testid="share-leave-confirm">
              <span className="cloud-hint">
                It is removed from this {backend.device} and your other devices. The others keep theirs.
              </span>
              <button
                className="modal-btn is-danger-solid"
                data-testid="share-leave-yes"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    if (!me) throw new Error(`This ${backend.device} does not know who you are here yet — try again in a moment.`);
                    onLeaving(space);
                    await shares.shareMember(cloud.root, space.id, me, false);
                  })
                }
              >
                Leave
              </button>
              <button className="modal-btn" disabled={busy} onClick={() => setConfirm(null)}>
                Cancel
              </button>
            </div>
          ) : confirm === "delete" ? (
            <div className="cloud-card cloud-card--attention" data-testid="share-delete-confirm">
              <div className="cloud-card-title">Delete “{space.name}” for everyone?</div>
              <p className="cloud-hint">
                {withThem.length + through.length === 0
                  ? "It is removed from your devices."
                  : `It is removed from your devices and from those of the ${
                      withThem.length + through.length === 1 ? "other person" : `${withThem.length + through.length} other people`
                    } who can open it.`}{" "}
                It stays in Recently deleted for 30 days, where it can be restored with its people and its history.
              </p>
              <div className="modal-buttons">
                <button
                  className="modal-btn is-danger-solid"
                  data-testid="share-delete-yes"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      onLeaving(space);
                      await shares.shareDelete(cloud.root, space.id);
                    })
                  }
                >
                  {busy ? "Deleting…" : `Delete the ${what}`}
                </button>
                <button className="modal-btn" disabled={busy} onClick={() => setConfirm(null)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="cloud-actions">
              {mineToLeave && (
                <button className="modal-btn" data-testid="share-leave" disabled={busy} onClick={() => setConfirm("leave")}>
                  Leave this {what}
                </button>
              )}
              {space.placed && (
                <button
                  className="modal-btn is-danger-outline"
                  data-testid="share-delete"
                  disabled={busy}
                  onClick={() => setConfirm("delete")}
                >
                  Delete it for everyone
                </button>
              )}
            </div>
          )}
          {error && <div className="modal-error">{error}</div>}
        </div>
      </div>
    </div>
  );
}
