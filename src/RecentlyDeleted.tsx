// Every file this folder's history holds and the folder itself does not.
// Apple Notes' shape: always in
// sight at the foot of the sidebar — a bin and its count in the footer bar —
// opening in the sidebar's own column, because deletion is the moment nobody
// goes looking for a menu.
//
// This is the surface for the case the macOS Trash misses: a file deleted on
// another Mac, one deleted before the Trash was emptied, or a mass-delete
// confirmed at the sync's prompt. The store is not the Trash, so emptying
// the Trash changes nothing here.
//
// A section's list covers what is shared from inside it. Each shared folder
// keeps a history of its own, so its deleted files are listed here with the
// section's and come back in their own folder. And something shared that
// was deleted for everyone is listed whole, for whoever can restore it: it
// is the domain that keeps it, thirty days, with its people and its history.

import { useCallback, useMemo, useState } from "react";
import { timeAgo, type CloudSpace } from "./cloud";
import { type DeletedFile } from "./versions";
import { backend, type Versions } from "./backend";
import { HTML_EXT_RE, MD_EXT_RE, META_SUFFIX, stemOf } from "./metaFile";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const basename = (p: string) => p.split(/[\\/]/).pop() || p;
const dirname = (p: string) => {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "";
};
const stripDocExt = (name: string) => name.replace(MD_EXT_RE, "").replace(HTML_EXT_RE, "");

/** A deleted document, as one row: the file it opens as (its markdown, else
 *  its html) and every file of it, its sidecar too. It comes back whole: a
 *  note never returns without its comments and its links' records. Grouped
 *  as the iPhone groups them (`DeletedDocument.group`,
 *  ios/DoklinKit/Sources/DoklinKit/Models/HistoryWords.swift): change both. */
export type DeletedDocument = { primary: DeletedFile; files: DeletedFile[] };

const isSidecar = (path: string) => path.toLowerCase().endsWith(META_SUFFIX) && basename(path).length > META_SUFFIX.length;

/** The folder and stem a note, its page and its sidecar are one document
 *  by; null for a file that is no document's. */
function documentKey(path: string): string | null {
  const stem = isSidecar(path)
    ? path.slice(0, -META_SUFFIX.length)
    : MD_EXT_RE.test(path) || HTML_EXT_RE.test(path)
      ? stemOf(path)
      : null;
  return stem === null ? null : stem.toLowerCase();
}

/** The deleted files of one folder as documents, the most recently seen
 *  first. */
export function deletedDocuments(files: DeletedFile[]): DeletedDocument[] {
  const byKey = new Map<string, DeletedFile[]>();
  for (const file of files) {
    const key = documentKey(file.path) ?? `file\0${file.path}`;
    byKey.set(key, [...(byKey.get(key) ?? []), file]);
  }
  const rank = (f: DeletedFile) => (MD_EXT_RE.test(f.path) ? 0 : HTML_EXT_RE.test(f.path) ? 1 : 2);
  const seen = (d: DeletedDocument) => Math.max(...d.files.map((f) => f.lastSeenMs));
  return [...byKey.values()]
    .map((members) => {
      const ranked = [...members].sort((a, b) => rank(a) - rank(b));
      return { primary: ranked[0], files: ranked };
    })
    .sort((a, b) => seen(b) - seen(a));
}

/** Where a restore lands when the old path is occupied:
 *  ` (restored)`, before the extension, numbered if that is taken too. */
export function restoredName(path: string, n = 1): string {
  const dot = isSidecar(path) ? path.length - META_SUFFIX.length : path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  const hasExt = dot > slash + 1;
  const stem = hasExt ? path.slice(0, dot) : path;
  const ext = hasExt ? path.slice(dot) : "";
  return `${stem} (restored${n > 1 ? ` ${n}` : ""})${ext}`;
}

/** The absolute path each file of a deleted document comes back to: its
 *  own, unless something lives at one of them now — then all of them beside
 *  it, under one name, so they stay one document. */
export async function restoreTargets(root: string, doc: DeletedDocument): Promise<[DeletedFile, string][]> {
  const at = (n: number): [DeletedFile, string][] =>
    doc.files.map((f) => [f, n === 0 ? `${root}/${f.path}` : restoredName(`${root}/${f.path}`, n)]);
  for (let n = 0; n < 100; n += 1) {
    const candidate = at(n);
    const taken = await Promise.all(candidate.map(([, path]) => backend.documents.exists(path)));
    if (!taken.some(Boolean)) return candidate;
  }
  return at(Date.now());
}

/** One folder's deleted files: the folder is its store's root, where a
 *  file comes back. */
export type DeletedIn = { root: string; files: DeletedFile[] };

/** How long the domain keeps something shared that was deleted
 *  (`DELETED_KEPT_MS`, cloud-worker/src/sweep.ts; `DeletedShare.keptDays`
 *  on the iPhone, which words a deleted share's row the same — change all
 *  three). */
const SHARE_KEPT_DAYS = 30;

export default function RecentlyDeleted({
  store,
  root,
  folders,
  shares = [],
  onBackToFiles,
  onOpen,
  onRestored,
  onRestoreShare,
  onError,
}: {
  /** The version store: what this reads and restores from. Null where the
   *  platform keeps none (a browser): then only what was shared and deleted
   *  is listed, which the domain keeps. */
  store: Versions | null;
  /** The folder this list is of: Library's, or a section's. */
  root: string;
  /** What `versions_deleted` answered, for `root` and for each shared
   *  folder inside it. The app owns the lists: the sidebar's row needs the
   *  same count, and reading one costs a walk of the retained snapshots —
   *  so it is read once, not once per surface. */
  folders: DeletedIn[];
  /** What was shared from here and deleted for everyone, that this person
   *  can still restore. */
  shares?: CloudSpace[];
  onBackToFiles: () => void;
  /** Show the last content, read-only, in the version preview. */
  onOpen: (file: DeletedFile, root: string) => void;
  /** A file came back, at this absolute path. */
  onRestored: (path: string) => void;
  /** Bring a deleted share back; resolves once it is. */
  onRestoreShare?: (share: CloudSpace) => Promise<void>;
  onError?: (message: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const documents = useMemo(
    () => folders.flatMap((folder) => deletedDocuments(folder.files).map((doc) => ({ ...doc, root: folder.root }))),
    [folders],
  );

  const restoreShare = useCallback(
    async (share: CloudSpace) => {
      if (busy || !onRestoreShare) return;
      setBusy(share.id);
      try {
        await onRestoreShare(share);
      } catch (e) {
        onError?.(errText(e));
      } finally {
        setBusy(null);
      }
    },
    [busy, onRestoreShare, onError],
  );

  // The sidecar first, as a save writes it: a note on disk always finds the
  // records it uses.
  const restore = useCallback(
    async (doc: DeletedDocument, root: string) => {
      if (busy || !store) return;
      setBusy(`${root}/${doc.primary.path}`);
      try {
        const targets = await restoreTargets(root, doc);
        const order = [...targets].sort(([a], [b]) => Number(!isSidecar(a.path)) - Number(!isSidecar(b.path)));
        for (const [file, target] of order) {
          await store.restoreFile(root, target, { ts: file.lastSeenMs, hash: file.hash });
        }
        onRestored(targets[0][1]);
      } catch (e) {
        onError?.(`Couldn't bring that file back: ${errText(e)}`);
      } finally {
        setBusy(null);
      }
    },
    [busy, onRestored, onError, store],
  );
  // Where a row's file was, as this list's folder names it.
  const where = (folder: string, path: string) => {
    const within = folder === root ? "" : folder.slice(root.length + 1);
    return [within, dirname(path)].filter(Boolean).join("/") || basename(root);
  };

  return (
    <aside className="sidebar ws-deleted" aria-label="Recently deleted" data-testid="recently-deleted">
      <div className="sidebar-header ws-search-header">
        <button className="sidebar-header-button" onClick={onBackToFiles} title="Back to files">
          <BackIcon />
          <span className="sidebar-header-name">Recently deleted</span>
        </button>
      </div>

      <div className="sidebar-body ws-deleted-body">
        {documents.length === 0 && shares.length === 0 && (
          <div className="sidebar-message" data-testid="deleted-empty">
            {store ? "Nothing has been deleted from this folder." : "Nothing shared from here has been deleted."}
          </div>
        )}
        {(documents.length > 0 || shares.length > 0) && (
          <ul className="ws-deleted-list">
            {shares.map((share) => {
              const left = Math.max(1, Math.ceil(SHARE_KEPT_DAYS - (Date.now() - (share.deletedAt ?? 0)) / 86_400_000));
              return (
                <li className="ws-deleted-row" key={share.id} data-testid="deleted-share" data-share={share.id}>
                  <div className="ws-deleted-name">{share.name}</div>
                  <div className="ws-deleted-sub">
                    {[
                      `shared ${share.kind === "folder" ? "folder" : "document"}`,
                      `deleted ${timeAgo(share.deletedAt ?? 0)}`,
                      `kept ${left} more ${left === 1 ? "day" : "days"}`,
                    ].join(" · ")}
                  </div>
                  <div className="ws-deleted-actions">
                    <button
                      className="modal-btn"
                      data-testid="deleted-share-restore"
                      disabled={busy === share.id || !onRestoreShare}
                      title="It comes back for everyone it was shared with, with its history"
                      onClick={() => void restoreShare(share)}
                    >
                      {busy === share.id ? "Bringing it back…" : "Restore"}
                    </button>
                  </div>
                </li>
              );
            })}
            {documents.map(({ primary: file, files: all, root: folder }) => {
              const key = `${folder}/${file.path}`;
              return (
                <li className="ws-deleted-row" key={key} data-testid="deleted-row" data-path={file.path}>
                  <div className="ws-deleted-name" title={file.path}>
                    {stripDocExt(basename(file.path))}
                  </div>
                  <div className="ws-deleted-sub">
                    {[where(folder, file.path), `last seen ${timeAgo(file.lastSeenMs)}`].join(" · ")}
                  </div>
                  <div className="ws-deleted-actions">
                    <button
                      className="modal-btn"
                      data-testid="deleted-restore"
                      disabled={busy === key}
                      onClick={() => void restore({ primary: file, files: all }, folder)}
                    >
                      {busy === key ? "Bringing it back…" : "Restore"}
                    </button>
                    <button className="modal-btn" data-testid="deleted-open" onClick={() => onOpen(file, folder)}>
                      Open
                    </button>
                  </div>
                </li>
              );
            })}
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
