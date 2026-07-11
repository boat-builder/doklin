// Version history for a synced document.
//
// Every push of a synced file leaves its previous revision behind as an
// immutable blob; this panel lists them (manifest inline tail + the deep
// archive) and offers the two calm exits from a bad merge:
//   Restore — the old content becomes the document's NEW current revision
//             (write the file; the engine pushes it — nothing is rewritten),
//   Save as new doc — materialize the revision beside the original and keep
//             working from there.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ShareConnection } from "./share";
import {
  fetchFileHistory,
  fetchRevisionContent,
  type HistoryRevision,
} from "./sync";

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
      <line x1="5" y1="5" x2="19" y2="19" />
      <line x1="19" y1="5" x2="5" y2="19" />
    </svg>
  );
}

function revLabel(r: HistoryRevision): string {
  const when = r.timeMs ? new Date(r.timeMs) : null;
  const time = when
    ? when.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "";
  return [time, r.by].filter(Boolean).join(" · ");
}

const basename = (p: string) => p.split(/[\\/]/).pop() || p;

export default function HistoryPanel({
  docPath,
  relPath,
  wsId,
  connection,
  onClose,
  onOpenFile,
}: {
  docPath: string; // absolute
  relPath: string; // workspace-relative
  wsId: string;
  connection: ShareConnection;
  onClose: () => void;
  onOpenFile: (path: string) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fileId, setFileId] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<HistoryRevision[]>([]);
  const [selected, setSelected] = useState<HistoryRevision | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState<"restore" | "copy" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await fetchFileHistory(connection, wsId, relPath);
        if (cancelled) return;
        if (!result) {
          setError("This document hasn't synced yet — history appears after its first sync.");
        } else {
          setFileId(result.fileId);
          setRevisions(result.revisions);
          setSelected(result.revisions[0] ?? null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection, wsId, relPath]);

  useEffect(() => {
    if (!selected || !fileId) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreview(null);
    void fetchRevisionContent(connection, wsId, fileId, selected.hash)
      .then((text) => {
        if (!cancelled) setPreview(text);
      })
      .catch((e) => {
        if (!cancelled) setPreview(`⚠ ${e instanceof Error ? e.message : String(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, fileId, connection, wsId]);

  const restore = useCallback(async () => {
    if (!selected || !fileId || preview == null) return;
    setBusy("restore");
    setNotice(null);
    try {
      // Plain write: the editor reloads through the file watcher, the engine
      // pushes it as a fresh revision — today's content stays in history.
      await invoke("write_file", { path: docPath, contents: preview, expected: null });
      setNotice(`Restored revision ${selected.rev} — the previous state stays in history.`);
    } catch (e) {
      setNotice(`Restore failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }, [selected, fileId, preview, docPath]);

  const saveAsNew = useCallback(async () => {
    if (!selected || preview == null) return;
    setBusy("copy");
    setNotice(null);
    try {
      const dot = docPath.lastIndexOf(".");
      const stem = dot > 0 ? docPath.slice(0, dot) : docPath;
      const ext = dot > 0 ? docPath.slice(dot) : "";
      let target = `${stem} (rev ${selected.rev})${ext}`;
      for (let n = 2; n < 50; n += 1) {
        const exists = await invoke<boolean>("path_exists", { path: target });
        if (!exists) break;
        target = `${stem} (rev ${selected.rev} ${n})${ext}`;
      }
      await invoke("write_file", { path: target, contents: preview, expected: null });
      setNotice(`Saved as ${basename(target)}.`);
      onOpenFile(target);
    } catch (e) {
      setNotice(`Couldn't save: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }, [selected, preview, docPath, onOpenFile]);

  return (
    <div
      className="shared-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="shared-modal sync-modal sync-history-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Version history"
      >
        <div className="shared-modal-header">
          <div className="shared-modal-title">History — {basename(docPath)}</div>
          <button className="shared-modal-close" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>

        <div className="sync-body">
          {loading && <div className="sync-hint">Fetching revisions…</div>}
          {error && <div className="sync-error">{error}</div>}
          {!loading && !error && (
            <div className="sync-history-layout">
              <ul className="sync-history-list" role="listbox" aria-label="Revisions">
                {revisions.map((r) => (
                  <li key={r.rev}>
                    <button
                      role="option"
                      aria-selected={selected?.rev === r.rev}
                      className={`sync-history-rev ${selected?.rev === r.rev ? "is-active" : ""}`}
                      onClick={() => setSelected(r)}
                    >
                      <span className="sync-history-rev-title">
                        {r.current ? "Current" : `Revision ${r.rev}`}
                      </span>
                      <span className="sync-history-rev-meta">{revLabel(r)}</span>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="sync-history-preview">
                {selected && (
                  <>
                    <pre className="sync-history-pre">
                      {preview == null ? "Loading…" : preview}
                    </pre>
                    {!selected.current && (
                      <div className="share-buttons">
                        <button
                          className="share-btn is-primary"
                          disabled={busy != null || preview == null}
                          onClick={() => void restore()}
                        >
                          {busy === "restore" ? "Restoring…" : "Restore this version"}
                        </button>
                        <button
                          className="share-btn"
                          disabled={busy != null || preview == null}
                          onClick={() => void saveAsNew()}
                        >
                          {busy === "copy" ? "Saving…" : "Save as new doc"}
                        </button>
                      </div>
                    )}
                    {notice && <div className="sync-hint">{notice}</div>}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
