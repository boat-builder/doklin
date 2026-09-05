// The workspace as it was, as a modal (docs/versioning-plan.md §7.2,
// §12.3.5). Choosing a moment for a whole folder is a deliberate,
// occasional act — Dropbox Rewind's shape, not a rail — so it says exactly
// what a restore would do before anything happens, and confirms with the
// real counts in the app's own chrome. Never `window.confirm`: the harness
// auto-dismisses one, and a system dialog is the wrong place to read
// "move 2 to the Trash".
//
// A snapshot of now is taken first, so every restore here is itself a
// version and the toast's *Undo* is another restore.

import { useCallback, useEffect, useMemo, useState } from "react";
import { groupByDay, isRecent, timeLabel } from "./HistoryRail";
import {
  versionsRestoreSnapshot,
  versionsSnapshotDiff,
  versionsSnapshots,
  versionReasonWord,
  type RestoreReport,
  type SnapshotDiff,
  type SnapshotMeta,
} from "./versions";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const basename = (p: string) => p.split(/[\\/]/).pop() || p;

/** "+2 −1 ~5" — what a snapshot changed against the one before it. The
 *  oldest row has nothing to compare against and says its size instead. */
export function deltaLabel(row: SnapshotMeta): string {
  if (!row.delta) return `${row.files} file${row.files === 1 ? "" : "s"}`;
  const { added, removed, changed } = row.delta;
  const parts = [added > 0 && `+${added}`, removed > 0 && `−${removed}`, changed > 0 && `~${changed}`];
  return parts.filter(Boolean).join(" ") || "no change";
}

/** The confirm's sentence, built from what is actually ticked — the counts
 *  the user is about to live with, in the order the restore does them. */
export function restoreSentence(write: number, back: number, trash: number): string {
  const parts = [
    write > 0 && `Write ${write} file${write === 1 ? "" : "s"}`,
    back > 0 && `bring back ${back}`,
    trash > 0 && `move ${trash} to the Trash`,
  ].filter(Boolean) as string[];
  if (parts.length === 0) return "Nothing is ticked.";
  return `${parts.join(", ")}?`;
}

type Row = { path: string; kind: "changed" | "missing" | "added" };

/** The three lists as one list, in the order they read: what changes, what
 *  comes back, what goes. */
export function rowsOf(diff: SnapshotDiff | null): Row[] {
  if (!diff) return [];
  return [
    ...diff.changed.map((c) => ({ path: c.path, kind: "changed" as const })),
    ...diff.missing.map((path) => ({ path, kind: "missing" as const })),
    ...diff.added.map((path) => ({ path, kind: "added" as const })),
  ];
}

const KIND_WORD: Record<Row["kind"], string> = {
  changed: "changes",
  missing: "comes back",
  added: "to the Trash",
};

export default function WorkspaceHistory({
  root,
  onClose,
  onRestored,
  onError,
}: {
  /** The workspace whose timeline this is — the store's display root. */
  root: string;
  onClose: () => void;
  /** A restore landed. The app toasts it with an *Undo* that restores
   *  `preRestoreTs` with the same paths. */
  onRestored?: (report: RestoreReport, paths: string[] | null) => void;
  onError?: (message: string) => void;
}) {
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [diff, setDiff] = useState<SnapshotDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [confirming, setConfirming] = useState<"selected" | "all" | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSnapshots(await versionsSnapshots(root));
      setError(null);
    } catch (e) {
      setSnapshots([]);
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [root]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  // Selecting a row asks what restoring it would do. Everything is ticked to
  // begin with: *Restore selected* with nothing unticked is *Restore all*.
  useEffect(() => {
    if (selected == null) {
      setDiff(null);
      setDiffError(null);
      return;
    }
    let cancelled = false;
    setDiff(null);
    setDiffError(null);
    void (async () => {
      try {
        const next = await versionsSnapshotDiff(root, selected);
        if (cancelled) return;
        setDiff(next);
        setTicked(new Set(rowsOf(next).map((r) => r.path)));
      } catch (e) {
        if (!cancelled) setDiffError(errText(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [root, selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (confirming) setConfirming(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirming, onClose]);

  const groups = useMemo(() => groupByDay(snapshots), [snapshots]);
  const rows = useMemo(() => rowsOf(diff), [diff]);
  const scope = useMemo(
    () => (confirming === "all" ? rows : rows.filter((r) => ticked.has(r.path))),
    [confirming, rows, ticked],
  );
  const counts = useMemo(
    () => ({
      write: scope.filter((r) => r.kind === "changed").length,
      back: scope.filter((r) => r.kind === "missing").length,
      trash: scope.filter((r) => r.kind === "added").length,
    }),
    [scope],
  );

  const restore = useCallback(async () => {
    if (selected == null || busy) return;
    // "Everything" is null rather than a list of every path: the snapshot
    // is the intent, and the folder may have moved on since the diff.
    const paths = confirming === "all" ? null : scope.map((r) => r.path);
    setBusy(true);
    try {
      const report = await versionsRestoreSnapshot(root, selected, paths);
      setConfirming(null);
      onRestored?.(report, paths);
      await load();
      // The folder has changed under it; re-ask what is left to do.
      const next = await versionsSnapshotDiff(root, selected);
      setDiff(next);
      setTicked(new Set(rowsOf(next).map((r) => r.path)));
    } catch (e) {
      setConfirming(null);
      setDiffError(errText(e));
      onError?.(errText(e));
    } finally {
      setBusy(false);
    }
  }, [selected, busy, confirming, scope, root, onRestored, onError, load]);

  const toggle = (path: string) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const nothingToDo = diff != null && rows.length === 0;

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal cloud-modal cloud-modal--wide"
        role="dialog"
        aria-modal="true"
        aria-label="Workspace history"
        data-testid="workspace-history"
      >
        <div className="modal-header">
          <div className="modal-title">Workspace history · {basename(root)}</div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
              <line x1="5" y1="5" x2="19" y2="19" />
              <line x1="19" y1="5" x2="5" y2="19" />
            </svg>
          </button>
        </div>
        <div className="cloud-body ws-history">
          <div className="ws-history-times">
            {loading && <p className="cloud-hint">Reading this folder's history…</p>}
            {error && (
              <p className="cloud-hint modal-error" data-testid="ws-error">
                {error}
              </p>
            )}
            {!loading && !error && snapshots.length === 0 && (
              <p className="cloud-hint" data-testid="ws-no-snapshots">
                No versions of this folder yet. One is kept a couple of minutes after you stop typing.
              </p>
            )}
            {groups.map((group) => {
              const open = isRecent(group.day) || expanded.has(group.day);
              return (
                <div className="history-day" key={group.day}>
                  <button
                    className={`history-day-head ${open ? "is-open" : ""}`}
                    data-testid="ws-day"
                    aria-expanded={open}
                    onClick={() =>
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        if (next.has(group.day)) next.delete(group.day);
                        else next.add(group.day);
                        return next;
                      })
                    }
                  >
                    <span className="history-day-label">{group.label}</span>
                    <span className="history-day-count">{group.versions.length}</span>
                  </button>
                  {open && (
                    <ul className="history-versions">
                      {group.versions.map((row) => (
                        <li key={row.ts}>
                          <button
                            className={`history-version ${selected === row.ts ? "is-active" : ""}`}
                            data-testid="ws-snapshot"
                            data-ts={row.ts}
                            aria-current={selected === row.ts}
                            onClick={() => {
                              setConfirming(null);
                              setSelected(row.ts);
                            }}
                          >
                            <span className="history-version-line">
                              <span className="history-version-time">{timeLabel(row.ts)}</span>
                              <span className="ws-delta" data-testid="ws-delta">
                                {deltaLabel(row)}
                              </span>
                            </span>
                            {row.label && (
                              <span className="history-version-label" data-testid="ws-label">
                                {row.label}
                              </span>
                            )}
                            <span className="history-version-meta">
                              {versionReasonWord({ reason: row.reason, source: "local" })}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>

          <div className="ws-history-plan" data-testid="ws-diff">
            {selected == null ? (
              <p className="cloud-hint" data-testid="ws-unselected">
                Pick a moment to see what restoring it would change.
              </p>
            ) : diffError ? (
              <p className="cloud-hint modal-error" data-testid="ws-diff-error">
                {diffError}
              </p>
            ) : diff == null ? (
              <p className="cloud-hint">Comparing this folder with that moment…</p>
            ) : nothingToDo ? (
              <p className="cloud-hint" data-testid="ws-empty">
                This is exactly what the folder holds now — there is nothing to restore.
              </p>
            ) : (
              <>
                <div className="cloud-section-label">If you restore {timeLabel(selected)}</div>
                <ul className="ws-file-list">
                  {rows.map((row) => (
                    <li className="ws-file" key={`${row.kind}:${row.path}`} data-testid="ws-file" data-path={row.path} data-kind={row.kind}>
                      <label className="ws-file-label">
                        <input
                          type="checkbox"
                          checked={ticked.has(row.path)}
                          onChange={() => toggle(row.path)}
                          aria-label={`${row.path} — ${KIND_WORD[row.kind]}`}
                        />
                        <span className="ws-file-path">{row.path}</span>
                        <span className={`ws-file-kind is-${row.kind}`}>{KIND_WORD[row.kind]}</span>
                      </label>
                    </li>
                  ))}
                </ul>
                <p className="cloud-hint" data-testid="ws-undoable">
                  A snapshot of now is taken first, so this can be undone.
                </p>
                {confirming ? (
                  <div className="ws-actions" data-testid="ws-confirm">
                    <span className="ws-confirm-text">
                      {restoreSentence(counts.write, counts.back, counts.trash)}
                    </span>
                    <button
                      className="modal-btn is-danger-solid"
                      data-testid="ws-confirm-yes"
                      disabled={busy || scope.length === 0}
                      onClick={() => void restore()}
                    >
                      {busy ? "Restoring…" : "Restore"}
                    </button>
                    <button className="modal-btn" data-testid="ws-confirm-cancel" onClick={() => setConfirming(null)}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="ws-actions">
                    <button
                      className="modal-btn"
                      data-testid="ws-restore-selected"
                      disabled={ticked.size === 0}
                      onClick={() => setConfirming("selected")}
                    >
                      Restore selected
                    </button>
                    <button className="modal-btn" data-testid="ws-restore-all" onClick={() => setConfirming("all")}>
                      Restore all
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
