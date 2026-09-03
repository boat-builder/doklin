// Publish a folder — docs/cloud-redesign.md §7.2, §11 decision 4: publishing
// a folder publishes every note in it, at Notion-style nested addresses
// under one slug; there is no membership list to keep. The dialog says
// plainly what will be public, takes the slug, a public title and a
// description, and previews the address scheme. The same dialog edits a
// published folder and stops it.

import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import {
  cloudPublish,
  cloudUnpublish,
  pageForPath,
  relPathIn,
  slugProblem,
  suggestSlug,
  type CloudStatus,
} from "./cloud";

type TreeNode = { kind: "file" | "dir"; name: string; path: string; children?: TreeNode[] };

const MD_EXT_RE = /\.(md|markdown|mdown|mkd)$/i;
const countNotes = (node: TreeNode): number =>
  node.kind === "file"
    ? MD_EXT_RE.test(node.name)
      ? 1
      : 0
    : (node.children ?? []).reduce((n, c) => n + countNotes(c), 0);

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const basename = (p: string) => p.split(/[\\/]/).pop() || p;

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
      <line x1="5" y1="5" x2="19" y2="19" />
      <line x1="19" y1="5" x2="5" y2="19" />
    </svg>
  );
}

export default function PublishFolder({
  cloud,
  dir,
  onClose,
  onOpenExternal,
}: {
  cloud: CloudStatus;
  /** The folder's absolute path — the workspace root publishes the whole workspace. */
  dir: string;
  onClose: () => void;
  onOpenExternal: (url: string) => void;
}) {
  const rel = relPathIn(cloud.root, dir) ?? "";
  const existing = pageForPath(cloud, rel, "dir");
  const folderName = basename(dir) || cloud.name;
  const isRoot = rel === "";

  const [slug, setSlug] = useState(existing?.slug ?? suggestSlug(isRoot ? cloud.name : folderName));
  const [title, setTitle] = useState(existing?.title ?? (isRoot ? cloud.name : folderName));
  const [desc, setDesc] = useState(existing?.desc ?? "");
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  // How much becomes public: every note under the folder, however deep.
  useEffect(() => {
    let live = true;
    void invoke<TreeNode>("list_md_tree", { path: dir })
      .then((tree) => {
        if (live) setCount(countNotes(tree));
      })
      .catch(() => {
        if (live) setCount(null);
      });
    return () => {
      live = false;
    };
  }, [dir]);

  const run = useCallback(
    async (f: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await f();
        onClose();
      } catch (e) {
        setError(errText(e));
        setBusy(false);
      }
    },
    [onClose],
  );

  const typed = slug.trim().toLowerCase();
  const problem = slugProblem(typed);
  const canSave = !busy && problem === null && title.trim() !== "";
  const previewSlug = problem === null ? typed : "…";

  return (
    <div
      className="shared-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="shared-modal cloud-modal" role="dialog" aria-modal="true" aria-label={existing ? "Published folder" : "Publish folder"}>
        <div className="shared-modal-header">
          <div className="shared-modal-title">{existing ? "Published folder" : "Publish folder"}</div>
          <button className="shared-modal-close" onClick={onClose} aria-label="Close" disabled={busy}>
            <CloseIcon />
          </button>
        </div>
        <div className="cloud-body">
          <p className="cloud-hint" data-testid="folder-count">
            {isRoot ? "The whole workspace" : `“${folderName}”`}
            {count === null ? "" : ` — ${count} note${count === 1 ? "" : "s"}`}
            {existing ? " is public" : " will be public"}, every note in it, at addresses under one slug. Notes
            added later are public the moment they sync; a note can still be published on its own too.
          </p>
          <div className="share-field">
            <div className="share-field-label">Address</div>
            <div className="publish-address">
              <span className="publish-prefix">{cloud.domain}/</span>
              <input
                data-testid="folder-slug"
                value={slug}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                disabled={busy}
                onChange={(e) => setSlug(e.target.value)}
              />
            </div>
            {problem && <div className="share-error">{problem}</div>}
          </div>
          <div className="share-field">
            <div className="share-field-label">Title</div>
            <input
              className="share-field-input"
              data-testid="folder-title"
              value={title}
              disabled={busy}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="share-field">
            <div className="share-field-label">Description</div>
            <input
              className="share-field-input"
              data-testid="folder-desc"
              value={desc}
              placeholder="A line under the title, optional"
              disabled={busy}
              onChange={(e) => setDesc(e.target.value)}
            />
          </div>
          <p className="publish-meta" data-testid="folder-preview">
            The folder at {cloud.domain}/{previewSlug} · a note at {cloud.domain}/{previewSlug}/Some-folder/A-note
          </p>
          <div className="share-buttons">
            <button
              className="share-btn is-primary"
              data-testid="folder-publish"
              disabled={!canSave}
              onClick={() =>
                void run(() => cloudPublish(dir, { slug: typed, title: title.trim(), desc: desc.trim() || undefined }))
              }
            >
              {busy ? "Working…" : existing ? "Save changes" : "Publish folder"}
            </button>
            {existing && (
              <button className="share-btn" onClick={() => onOpenExternal(`${cloud.endpoint}/${existing.slug}`)}>
                Open
              </button>
            )}
            <button className="share-btn" disabled={busy} onClick={onClose}>
              Cancel
            </button>
          </div>
          {existing && (
            <div className="share-buttons">
              {confirmStop ? (
                <>
                  <span className="cloud-hint">Stop publishing the folder? Every address under it stops working.</span>
                  <button
                    className="share-btn is-danger-solid"
                    data-testid="folder-stop-yes"
                    disabled={busy}
                    onClick={() => void run(() => cloudUnpublish(cloud.root, existing.slug))}
                  >
                    Stop
                  </button>
                  <button className="share-btn" onClick={() => setConfirmStop(false)}>
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  className="share-btn is-danger-outline"
                  data-testid="folder-stop"
                  disabled={busy}
                  onClick={() => setConfirmStop(true)}
                >
                  Stop publishing
                </button>
              )}
            </div>
          )}
          {error && <div className="share-error">{error}</div>}
        </div>
      </div>
    </div>
  );
}
