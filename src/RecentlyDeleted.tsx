// Every file this folder's history holds and the folder itself does not
// (docs/versioning-plan.md §7.2, §12.3.4). Apple Notes' shape: a row at the
// foot of the sidebar, opening in the sidebar's own column — because
// deletion is the moment nobody goes looking for a menu.
//
// This is the surface for the case the macOS Trash misses: a file deleted on
// another Mac, one deleted before the Trash was emptied, or a mass-delete
// confirmed at the sync's prompt. The store is not the Trash, so emptying
// the Trash changes nothing here.

import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { timeAgo } from "./cloud";
import { versionsRestoreFile, type DeletedFile } from "./versions";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const basename = (p: string) => p.split(/[\\/]/).pop() || p;
const dirname = (p: string) => {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "";
};
const stripDocExt = (name: string) => name.replace(/\.(md|markdown|mdown|mkd)$/i, "");

/** Where a restore lands when the old path is occupied: the plan's
 *  ` (restored)`, before the extension, numbered if that is taken too. */
export function restoredName(path: string, n = 1): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  const hasExt = dot > slash + 1;
  const stem = hasExt ? path.slice(0, dot) : path;
  const ext = hasExt ? path.slice(dot) : "";
  return `${stem} (restored${n > 1 ? ` ${n}` : ""})${ext}`;
}

/** The absolute path a deleted file comes back to. Its own, unless
 *  something else lives there now — both survive, always. */
export async function restoreTarget(root: string, rel: string): Promise<string> {
  const original = `${root}/${rel}`;
  if (!(await invoke<boolean>("path_exists", { path: original }))) return original;
  for (let n = 1; n < 100; n += 1) {
    const candidate = restoredName(original, n);
    if (!(await invoke<boolean>("path_exists", { path: candidate }))) return candidate;
  }
  return restoredName(original, Date.now());
}

export default function RecentlyDeleted({
  root,
  files,
  onBackToFiles,
  onOpen,
  onRestored,
  onError,
}: {
  /** The workspace whose history this is — the store's display root. */
  root: string;
  /** What `versions_deleted` answered. The app owns the list: the sidebar's
   *  row needs the same count, and reading it costs a walk of the retained
   *  snapshots — so it is read once, not once per surface. */
  files: DeletedFile[];
  onBackToFiles: () => void;
  /** Show the last content, read-only, in the version preview. */
  onOpen: (file: DeletedFile) => void;
  /** A file came back, at this absolute path. */
  onRestored: (path: string) => void;
  onError?: (message: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  const restore = useCallback(
    async (file: DeletedFile) => {
      if (busy) return;
      setBusy(file.path);
      try {
        const target = await restoreTarget(root, file.path);
        await versionsRestoreFile(root, target, { ts: file.lastSeenMs, hash: file.hash });
        onRestored(target);
      } catch (e) {
        onError?.(`Couldn't bring that file back: ${errText(e)}`);
      } finally {
        setBusy(null);
      }
    },
    [busy, root, onRestored, onError],
  );

  return (
    <aside className="sidebar ws-deleted" aria-label="Recently deleted" data-testid="recently-deleted">
      <div className="sidebar-header ws-search-header">
        <button className="sidebar-header-button" onClick={onBackToFiles} title="Back to files">
          <BackIcon />
          <span className="sidebar-header-name">Recently deleted</span>
        </button>
      </div>

      <div className="sidebar-body ws-deleted-body">
        {files.length === 0 && (
          <div className="sidebar-message" data-testid="deleted-empty">
            Nothing has been deleted from this folder.
          </div>
        )}
        {files.length > 0 && (
          <ul className="ws-deleted-list">
            {files.map((file) => (
              <li className="ws-deleted-row" key={file.path} data-testid="deleted-row" data-path={file.path}>
                <div className="ws-deleted-name" title={file.path}>
                  {stripDocExt(basename(file.path))}
                </div>
                <div className="ws-deleted-sub">
                  {[dirname(file.path) || basename(root), `last seen ${timeAgo(file.lastSeenMs)}`].join(" · ")}
                </div>
                <div className="ws-deleted-actions">
                  <button
                    className="modal-btn"
                    data-testid="deleted-restore"
                    disabled={busy === file.path}
                    onClick={() => void restore(file)}
                  >
                    {busy === file.path ? "Bringing it back…" : "Restore"}
                  </button>
                  <button className="modal-btn" data-testid="deleted-open" onClick={() => onOpen(file)}>
                    Open
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

function BackIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}
