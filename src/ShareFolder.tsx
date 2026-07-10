// Folder-share dialog. Two views on one modal shell: not yet shared → pick
// the address and publish the folder's collection page (an empty public table
// of contents); shared → the live link plus the include/exclude checklist
// that decides which documents appear on it. Including a document publishes
// it as an ordinary page share with its own address; removing it only delists
// it. App owns the registries and the pushes; this component owns the UX.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TreeNode } from "./Sidebar";
import {
  generateShareId,
  pageExists,
  shareHost,
  shareUrl,
  SHARE_ID_RE,
  type CollectionEntry,
  type ShareConfig,
  type ShareEntry,
} from "./share";

const basename = (p: string) => p.split(/[\\/]/).pop() || p;
const stripDocExt = (name: string) => name.replace(/\.(md|markdown|mdown|mkd|html)$/i, "");

// Every document under a node, depth-first — what a folder row's tri-state
// checkbox operates on.
function collectFiles(node: TreeNode, out: string[] = []): string[] {
  if (node.kind === "file") out.push(node.path);
  else for (const c of node.children) collectFiles(c, out);
  return out;
}

export default function ShareFolder({
  dirPath,
  collection,
  shares,
  config,
  onShare,
  onStopSharing,
  onToggleMember,
  onClose,
  onOpenExternal,
  onOpenSetup,
}: {
  dirPath: string;
  collection: CollectionEntry | null;
  shares: Record<string, ShareEntry>;
  config: ShareConfig | null;
  onShare: (id: string) => Promise<void>;
  onStopSharing: (alsoStopPages: boolean) => Promise<void>;
  onToggleMember: (path: string, include: boolean) => Promise<void>;
  onClose: () => void;
  onOpenExternal: (url: string) => void;
  onOpenSetup: () => void;
}) {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [slug, setSlug] = useState(() => generateShareId());
  const [shareBusy, setShareBusy] = useState(false);
  const [busyPaths, setBusyPaths] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  // "link" for the folder link button, a file path for a row's copy button.
  const [copied, setCopied] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopBusy, setStopBusy] = useState(false);

  const folderName = basename(dirPath);
  const host = shareHost(config);
  const memberSet = useMemo(() => new Set(collection?.members ?? []), [collection]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const node = await invoke<TreeNode>("list_md_tree", { path: dirPath });
        if (!cancelled) setTree(node);
      } catch (e) {
        if (!cancelled) setTreeError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dirPath]);

  const confirmShare = useCallback(async () => {
    if (!config || shareBusy) return;
    const id = slug.trim().toLowerCase();
    if (!SHARE_ID_RE.test(id) || id === "api") {
      setError("Use 3–64 characters: a–z, 0–9, dashes.");
      return;
    }
    setShareBusy(true);
    setError(null);
    try {
      if (await pageExists(config, id)) {
        setError("That address is already taken.");
        return;
      }
      await onShare(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setShareBusy(false);
    }
  }, [config, slug, shareBusy, onShare]);

  const setPathsBusy = useCallback((paths: string[], busy: boolean) => {
    setBusyPaths((prev) => {
      const next = new Set(prev);
      for (const p of paths) {
        if (busy) next.add(p);
        else next.delete(p);
      }
      return next;
    });
  }, []);

  const toggleFile = useCallback(
    async (path: string, include: boolean) => {
      setPathsBusy([path], true);
      setError(null);
      try {
        await onToggleMember(path, include);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setPathsBusy([path], false);
      }
    },
    [onToggleMember, setPathsBusy],
  );

  // A folder row's checkbox includes everything under it that isn't included
  // yet — or, when everything already is, removes everything.
  const toggleDir = useCallback(
    async (node: TreeNode) => {
      const files = collectFiles(node);
      if (files.length === 0) return;
      const include = !files.every((f) => memberSet.has(f));
      const targets = files.filter((f) => memberSet.has(f) !== include);
      setPathsBusy([node.path, ...targets], true);
      setError(null);
      try {
        for (const f of targets) {
          await onToggleMember(f, include);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setPathsBusy([node.path, ...targets], false);
      }
    },
    [memberSet, onToggleMember, setPathsBusy],
  );

  const copy = useCallback(
    async (key: string, url: string) => {
      try {
        await navigator.clipboard.writeText(url);
        setCopied(key);
        window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1600);
      } catch (e) {
        console.error("copy link failed", e);
      }
    },
    [],
  );

  const stop = useCallback(
    async (alsoStopPages: boolean) => {
      if (stopBusy) return;
      setStopBusy(true);
      setError(null);
      try {
        await onStopSharing(alsoStopPages);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setStopBusy(false);
      }
    },
    [stopBusy, onStopSharing],
  );

  const memberCount = collection?.members.length ?? 0;

  return (
    <div
      className="shared-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="shared-modal folder-share-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Share folder ${folderName}`}
      >
        <div className="shared-modal-header">
          <div className="shared-modal-title">
            {collection ? folderName : `Share “${folderName}”`}
          </div>
          <button className="shared-modal-close" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>

        {!config ? (
          <div className="shared-empty">
            <div>Sharing isn't set up on this Mac yet.</div>
            <button
              className="share-btn is-primary shared-empty-action"
              onClick={() => {
                onClose();
                onOpenSetup();
              }}
            >
              Set up sharing…
            </button>
          </div>
        ) : stopBusy && !collection ? (
          // Mid-stop the registry entry is already gone but member pages may
          // still be winding down; App closes the dialog when that finishes.
          <div className="shared-empty">Stopping…</div>
        ) : !collection ? (
          <div className="folder-share-body">
            <div className="share-note">
              Publishes a home page for this folder — a table of contents at
              the address below. Nothing inside is shared by this alone: you
              choose which documents to include, one by one, after.
            </div>
            <div className="share-url-row">
              <span className="share-url-prefix">{host}/</span>
              <input
                className="share-slug-input"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void confirmShare();
                }}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                aria-label="Folder share address"
              />
              <button
                className="share-regen"
                onClick={() => setSlug(generateShareId())}
                title="New address"
                aria-label="Generate a new address"
              >
                <RefreshIcon />
              </button>
            </div>
            <div className="share-buttons">
              <button
                className="share-btn is-primary"
                onClick={() => void confirmShare()}
                disabled={shareBusy}
              >
                {shareBusy ? "Sharing…" : "Share folder"}
              </button>
              <button className="share-btn" onClick={onClose}>
                Cancel
              </button>
            </div>
            {error && <div className="share-error">{error}</div>}
          </div>
        ) : confirmStop ? (
          <div className="folder-share-body">
            <div className="share-note">
              Stop sharing “{collection.title}”? The folder page goes away
              either way — choose what happens to the {memberCount}{" "}
              {memberCount === 1 ? "page" : "pages"} on it.
            </div>
            <div className="folder-share-stop-options">
              <button
                className="share-btn"
                onClick={() => void stop(false)}
                disabled={stopBusy || memberCount === 0}
              >
                Keep pages shared
              </button>
              <button className="share-btn is-danger" onClick={() => void stop(true)} disabled={stopBusy}>
                {stopBusy
                  ? "Stopping…"
                  : memberCount === 0
                    ? "Stop sharing"
                    : `Stop everything (${memberCount} ${memberCount === 1 ? "page" : "pages"})`}
              </button>
              <button className="share-btn" onClick={() => setConfirmStop(false)} disabled={stopBusy}>
                Cancel
              </button>
            </div>
            <div className="share-note">
              “Keep pages shared” removes the folder page but leaves every
              included page live at its own link.
            </div>
            {error && <div className="share-error">{error}</div>}
          </div>
        ) : (
          <div className="folder-share-body">
            <div className="share-url-row">
              <span className="share-url" title={shareUrl(config, collection.id)}>
                {host}/{collection.id}
              </span>
              <button
                className="share-btn folder-share-url-btn"
                onClick={() => void copy("link", shareUrl(config, collection.id))}
              >
                {copied === "link" ? "Copied" : "Copy"}
              </button>
              <button
                className="share-btn folder-share-url-btn"
                onClick={() => onOpenExternal(shareUrl(config, collection.id))}
              >
                Open
              </button>
            </div>
            <div className="share-note">
              Anyone with the link sees a table of contents of the pages you
              include below — and only those. Each included page also has its
              own link.
            </div>
            <div className="folder-share-list" role="group" aria-label="Included documents">
              {treeError && <div className="share-error">{treeError}</div>}
              {!treeError && !tree && <div className="shared-empty">Loading…</div>}
              {tree && tree.kind === "dir" && collectFiles(tree).length === 0 && (
                <div className="shared-empty">No documents in this folder yet.</div>
              )}
              {tree &&
                tree.kind === "dir" &&
                tree.children.map((child) => (
                  <ChecklistItem
                    key={child.path}
                    node={child}
                    depth={0}
                    memberSet={memberSet}
                    busyPaths={busyPaths}
                    shares={shares}
                    config={config}
                    copiedPath={copied}
                    onToggleFile={(p, inc) => void toggleFile(p, inc)}
                    onToggleDir={(n) => void toggleDir(n)}
                    onCopyLink={(p, url) => void copy(p, url)}
                  />
                ))}
            </div>
            <div className="folder-share-footer">
              <span className="folder-share-count">
                {memberCount} {memberCount === 1 ? "page" : "pages"} included
              </span>
              <button className="share-btn is-danger" onClick={() => setConfirmStop(true)}>
                Stop sharing…
              </button>
            </div>
            {error && <div className="share-error">{error}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

function ChecklistItem({
  node,
  depth,
  memberSet,
  busyPaths,
  shares,
  config,
  copiedPath,
  onToggleFile,
  onToggleDir,
  onCopyLink,
}: {
  node: TreeNode;
  depth: number;
  memberSet: Set<string>;
  busyPaths: Set<string>;
  shares: Record<string, ShareEntry>;
  config: ShareConfig;
  copiedPath: string | null;
  onToggleFile: (path: string, include: boolean) => void;
  onToggleDir: (node: TreeNode) => void;
  onCopyLink: (path: string, url: string) => void;
}) {
  const busy = busyPaths.has(node.path);

  if (node.kind === "file") {
    const included = memberSet.has(node.path);
    const share = shares[node.path];
    return (
      <div
        className={`folder-share-row ${included ? "is-included" : ""}`}
        style={{ paddingLeft: 8 + depth * 18 }}
      >
        <label className="folder-share-check">
          <input
            type="checkbox"
            checked={included}
            disabled={busy}
            onChange={() => onToggleFile(node.path, !included)}
            aria-label={`Include ${stripDocExt(node.name)}`}
          />
          <span className="folder-share-name">{stripDocExt(node.name)}</span>
        </label>
        {busy && <span className="folder-share-busy">…</span>}
        {!busy && included && share && (
          <button
            className="folder-share-copy"
            onClick={() => onCopyLink(node.path, shareUrl(config, share.id))}
            title={shareUrl(config, share.id)}
          >
            {copiedPath === node.path ? "Copied" : `/${share.id}`}
          </button>
        )}
      </div>
    );
  }

  const files = collectFiles(node);
  if (files.length === 0) return null; // nothing under it can be shared
  const includedCount = files.filter((f) => memberSet.has(f)).length;
  const allIncluded = includedCount === files.length;
  return (
    <div>
      <div className="folder-share-row is-dir" style={{ paddingLeft: 8 + depth * 18 }}>
        <label className="folder-share-check">
          <DirCheckbox
            checked={allIncluded}
            indeterminate={includedCount > 0 && !allIncluded}
            disabled={busy}
            onChange={() => onToggleDir(node)}
            label={`Include everything in ${node.name}`}
          />
          <span className="folder-share-name folder-share-dirname">{node.name}</span>
        </label>
        {busy ? (
          <span className="folder-share-busy">…</span>
        ) : (
          includedCount > 0 && (
            <span className="folder-share-dircount">
              {includedCount}/{files.length}
            </span>
          )
        )}
      </div>
      {node.children.map((c) => (
        <ChecklistItem
          key={c.path}
          node={c}
          depth={depth + 1}
          memberSet={memberSet}
          busyPaths={busyPaths}
          shares={shares}
          config={config}
          copiedPath={copiedPath}
          onToggleFile={onToggleFile}
          onToggleDir={onToggleDir}
          onCopyLink={onCopyLink}
        />
      ))}
    </div>
  );
}

// A native checkbox that can show the indeterminate state (only settable via
// the DOM property, not an attribute).
function DirCheckbox({
  checked,
  indeterminate,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  indeterminate: boolean;
  disabled: boolean;
  onChange: () => void;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      aria-label={label}
    />
  );
}

function CloseIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <polyline points="21 3 21 9 15 9" />
    </svg>
  );
}
