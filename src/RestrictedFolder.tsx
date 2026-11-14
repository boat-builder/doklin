// Making a restricted folder: a name, and who is in it. Three ways in, one
// dialog:
//
//   new      an empty folder (the Restricted heading's +)
//   folder   a folder that is there becomes it (*Restrict access…*) — and
//            leaves the Mac of everyone not picked
//   note     a private note goes into a new folder with somebody
//            (*Share with…*) — which is how a single note is shared, there
//            being no per-note permissions
//
// The dialog only asks; the app makes the folder and moves what belongs in
// it (`onSubmit`), and answers with a sentence when it could not.

import { useEffect, useMemo, useRef, useState } from "react";
import { cloudPeople, type CloudMember, type CloudStatus } from "./cloud";
import Avatar from "./Avatar";
import { useDismiss } from "./dismiss";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const basename = (p: string) => p.split(/[\\/]/).pop() || p;
const stemOf = (p: string) => basename(p).replace(/\.(md|markdown|mdown|mkd|html)$/i, "");

/** What the folder is made from. */
export type RestrictedSource = { kind: "new" } | { kind: "folder"; path: string } | { kind: "note"; path: string };

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
      <line x1="5" y1="5" x2="19" y2="19" />
      <line x1="19" y1="5" x2="5" y2="19" />
    </svg>
  );
}

export default function RestrictedFolder({
  cloud,
  source,
  onSubmit,
  onClose,
}: {
  cloud: CloudStatus;
  source: RestrictedSource;
  /** Make it. Resolves to a sentence when it could not be done, null when it was. */
  onSubmit: (name: string, members: string[]) => Promise<string | null>;
  onClose: () => void;
}) {
  const [name, setName] = useState(
    source.kind === "folder" ? basename(source.path) : source.kind === "note" ? stemOf(source.path) : "",
  );
  const [others, setOthers] = useState<CloudMember[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.select();
  }, []);

  useEffect(() => {
    let live = true;
    void cloudPeople(cloud.root)
      .then((people) => {
        if (live) setOthers(people.members.filter((m) => m.id !== people.me));
      })
      .catch((e) => {
        if (live) setError(errText(e));
      });
    return () => {
      live = false;
    };
  }, [cloud.root]);

  // Nothing closes while the folder is being made.
  const cardRef = useRef<HTMLDivElement>(null);
  useDismiss(() => {
    if (!busy) onClose();
  }, cardRef);

  const title =
    source.kind === "new"
      ? "New restricted folder"
      : source.kind === "folder"
        ? `Restrict access to “${basename(source.path)}”`
        : `Share “${stemOf(source.path)}”`;
  const trimmed = name.trim();
  // A note is shared *with* somebody; a folder may start with only its maker.
  const ready = trimmed.length > 0 && (source.kind !== "note" || picked.size > 0);
  const chosen = useMemo(() => (others ?? []).filter((m) => picked.has(m.id)), [others, picked]);

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    const failed = await onSubmit(trimmed, [...picked]);
    setBusy(false);
    if (failed) setError(failed);
  };

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="modal-overlay">
      <div
        ref={cardRef}
        className="modal cloud-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="restricted-folder"
      >
        <div className="modal-header">
          <div className="modal-title">{title}</div>
          <button className="modal-close" onClick={onClose} aria-label="Close" disabled={busy}>
            <CloseIcon />
          </button>
        </div>
        <div className="cloud-body">
          <p className="cloud-hint">
            {source.kind === "new" &&
              "A restricted folder is only on the Macs of the people in it. Nobody else in the workspace sees it, or that it exists."}
            {source.kind === "folder" &&
              "It becomes a restricted folder: only the people you pick keep it, and it is removed from everyone else’s Mac. Versions from before stay in the workspace’s history until they age out."}
            {source.kind === "note" &&
              "The note moves into a new restricted folder that holds you and the people you pick. Nobody else sees it."}
          </p>
          <div className="modal-field">
            <div className="modal-field-label">{source.kind === "note" ? "Folder name" : "Name"}</div>
            <input
              ref={nameRef}
              className="modal-field-input"
              data-testid="restricted-name"
              value={name}
              placeholder="Finance"
              spellCheck={false}
              autoFocus
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
            />
          </div>
          <div className="cloud-section-label">Who is in it</div>
          {others === null && !error && <p className="cloud-hint">Loading…</p>}
          {others !== null && others.length === 0 && (
            <p className="cloud-hint" data-testid="restricted-alone">
              Nobody else is in {cloud.name} yet, so it starts with only you.
            </p>
          )}
          {others !== null && others.length > 0 && (
            <ul className="space-people" data-testid="restricted-people">
              <li className="space-person">
                <Avatar name={cloud.me} size={22} />
                <span className="space-person-name">{cloud.me}</span>
                <span className="cloud-person-tag">you</span>
              </li>
              {others.map((m) => (
                <li className="space-person" key={m.id}>
                  <label>
                    <input
                      type="checkbox"
                      data-testid={`restricted-pick-${m.id}`}
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
          {source.kind === "folder" && others !== null && others.length > 0 && (
            <p className="cloud-hint" data-testid="restricted-effect">
              {chosen.length === 0
                ? "Only you will have it."
                : `You and ${chosen.map((m) => m.name || m.email).join(", ")} will have it.`}{" "}
              People can be added later.
            </p>
          )}
          {error && <div className="modal-error">{error}</div>}
          <div className="modal-buttons">
            <button
              className="modal-btn is-primary"
              data-testid="restricted-create"
              disabled={!ready || busy}
              onClick={() => void submit()}
            >
              {busy
                ? "Working…"
                : source.kind === "new"
                  ? "Create folder"
                  : source.kind === "folder"
                    ? "Restrict"
                    : "Share"}
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
