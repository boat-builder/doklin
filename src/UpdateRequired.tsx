// A version a release marked mandatory no longer runs: this covers the whole
// window, nothing under it can be reached (App makes it inert), and its one
// button installs the update and restarts (updater.ts). Two things raise it:
// the release manifest names a minimum newer than this app
// (`update.required`), or a domain's worker turns this app away (a workspace
// in `app-outdated`, whose `domains` it names). The editor stays mounted
// underneath, so a save on its way still lands.

import { useEffect, useRef, type ReactNode } from "react";
import { RELEASES_PAGE, type UpdateController } from "./updater";
import { dragWindowFromGap } from "./windowDrag";

export default function UpdateRequired({
  update,
  domains,
  onOpenExternal,
}: {
  update: UpdateController;
  /** The domains turning this app away; none when only the manifest says so. */
  domains: string[];
  onOpenExternal: (url: string) => void;
}) {
  const first = useRef<HTMLButtonElement>(null);
  // The keyboard comes here: whatever had it is inert now.
  useEffect(() => first.current?.focus(), [update.phase]);

  const version = update.current ? ` (v${update.current})` : "";
  const where = domains.length > 0 ? ` with ${domains.join(" and ")}` : "";

  let action: ReactNode;
  switch (update.phase) {
    case "available":
      action = (
        <button ref={first} className="modal-btn is-primary update-required-button" onClick={() => void update.install()}>
          Update to v{update.latest} and restart
        </button>
      );
      break;
    case "downloading":
      action = (
        <div className="update-required-progress" aria-live="polite">
          <div className="settings-update-bar" aria-hidden>
            <span style={{ width: `${Math.round(update.progress * 100)}%` }} />
          </div>
          Downloading… {Math.round(update.progress * 100)}%
        </div>
      );
      break;
    case "installing":
      action = <div className="update-required-progress">Restarting…</div>;
      break;
    case "checking":
      action = <div className="update-required-progress">Looking for the update…</div>;
      break;
    case "uptodate":
      action = (
        <>
          <p className="update-required-note">The update isn’t out yet. Try again in a few minutes.</p>
          <button ref={first} className="modal-btn update-required-button" onClick={() => void update.check()}>
            Check again
          </button>
        </>
      );
      break;
    case "error":
      action = (
        <>
          <p className="update-required-note" title={update.error ?? undefined}>
            Doklin couldn’t get the update. Try again, or download it from the releases page.
          </p>
          <div className="update-required-buttons">
            <button ref={first} className="modal-btn is-primary update-required-button" onClick={() => void update.check()}>
              Try again
            </button>
            <button className="modal-btn update-required-button" onClick={() => onOpenExternal(RELEASES_PAGE)}>
              Open the releases page
            </button>
          </div>
        </>
      );
      break;
  }

  return (
    <div className="update-required" role="alertdialog" aria-modal="true" aria-labelledby="update-required-title" data-testid="update-required">
      <div className="update-required-bar" onMouseDown={dragWindowFromGap} />
      <div className="update-required-card">
        <h1 id="update-required-title" className="update-required-title">Update Doklin</h1>
        <p className="update-required-text">
          This version of Doklin{version} no longer works{where}. Update it to keep going: everything you wrote stays as
          it is.
        </p>
        {action}
      </div>
    </div>
  );
}
