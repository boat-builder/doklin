// The two horizons, where the disk goes, and the export
// (docs/versioning.md §8, docs/versioning-plan.md §8.2). One modal rather
// than a section of the gear popover: five controls, two of them lists, do
// not belong in a menu — and both the popover and the Cloud panel's *This
// Mac* need something they can open.
//
// Everything here is a setting or a read; the one long operation is the
// export, and it reports itself through `versions-progress`.

import { useCallback, useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  onVersionsProgress,
  versionsExport,
  versionsForget,
  versionsSetCloudHorizon,
  versionsSetHorizon,
  versionsStores,
  type ExportReport,
  type StoreInfo,
  type VersionsStatus,
} from "./versions";
import type { CloudStatus } from "./cloud";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const basename = (p: string) => p.split(/[\\/]/).pop() || p;

/** The four answers to "how far back". Null is forever — the same null the
 *  store and the cloud index use, so nothing has to translate. */
export const HORIZONS: { days: number | null; label: string }[] = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "A year" },
  { days: null, label: "Forever" },
];

/** A horizon in a sentence. A number the four buttons don't cover (a store
 *  written by a later version, or by hand) still reads correctly. */
export function horizonLabel(days: number | null): string {
  if (days == null) return "forever";
  if (days === 365) return "a year";
  return `${days} days`;
}

/** Disk, at the precision a human cares about: never more than three
 *  significant figures, and never a decimal point on bytes. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** What one store's row says about itself. */
export function storeLine(store: StoreInfo): string {
  const versions = `${store.snapshots} version${store.snapshots === 1 ? "" : "s"}`;
  return `${versions} · ${formatBytes(store.bytes)}`;
}

export default function VersionsSettings({
  root,
  statuses,
  cloud,
  onClose,
  onError,
}: {
  /** The workspace this window has open, or null for a lone document — the
   *  horizon and the export are that folder's, the store list is the Mac's. */
  root: string | null;
  statuses: VersionsStatus[];
  /** The open folder's cloud status, when it is connected: the second
   *  horizon lives in the bucket, not here. */
  cloud: CloudStatus | null;
  onClose: () => void;
  onError?: (message: string) => void;
}) {
  const [stores, setStores] = useState<StoreInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [exported, setExported] = useState<ExportReport | null>(null);
  const [forgetting, setForgetting] = useState<string | null>(null);

  const here = useMemo(() => statuses.find((s) => s.root === root) ?? null, [statuses, root]);
  // A store whose folder is open is one a running versioner owns; *Forget*
  // is refused on those in Rust too, so this only saves the user the error.
  const open = useMemo(() => new Set(statuses.map((s) => s.key)), [statuses]);
  const mirror = cloud?.versions ?? null;
  const cloudKnown = mirror != null && mirror.lastMirrorMs != null;

  const load = useCallback(async () => {
    try {
      setStores(await versionsStores());
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (forgetting) setForgetting(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [forgetting, onClose]);

  // Only while an export is running: the event fires per file and there is
  // no reason to hold a listener open for the life of the modal.
  useEffect(() => {
    if (!busy) return;
    let stop: (() => void) | null = null;
    let dead = false;
    void onVersionsProgress((e) => {
      if (root && e.root === root) setProgress({ done: e.done, total: e.total });
    }).then((un) => {
      if (dead) un();
      else stop = un;
    });
    return () => {
      dead = true;
      stop?.();
    };
  }, [busy, root]);

  const act = useCallback(
    async (run: () => Promise<void>) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        await run();
      } catch (e) {
        setError(errText(e));
        onError?.(errText(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, onError],
  );

  const exportHere = useCallback(async () => {
    if (!root) return;
    const dest = await openDialog({ directory: true, multiple: false });
    if (typeof dest !== "string") return;
    setExported(null);
    setProgress({ done: 0, total: 0 });
    await act(async () => {
      const report = await versionsExport(root, dest);
      setExported(report);
      await load();
    });
    setProgress(null);
  }, [root, act, load]);

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal cloud-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Versions"
        data-testid="versions-settings"
      >
        <div className="modal-header">
          <div className="modal-title">Versions</div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
              <line x1="5" y1="5" x2="19" y2="19" />
              <line x1="19" y1="5" x2="5" y2="19" />
            </svg>
          </button>
        </div>
        <div className="cloud-body">
          {here == null ? (
            <p className="cloud-hint" data-testid="vs-no-folder">
              Open a folder to set how far back it keeps history.
            </p>
          ) : (
            <>
              <div className="cloud-section-label">On this Mac · {basename(here.root)}</div>
              <p className="cloud-hint" data-testid="vs-here">
                {storeLine({
                  key: here.key,
                  root: here.root,
                  exists: true,
                  bytes: here.bytes.blobs + here.bytes.snapshots,
                  snapshots: here.snapshots,
                  newestMs: here.newestMs,
                })}
                {" · kept "}
                {horizonLabel(here.horizonDays)}
              </p>
              <div className="vs-choices" data-testid="vs-local-horizon" role="group" aria-label="How far back this folder keeps">
                {HORIZONS.map((h) => (
                  <button
                    key={h.label}
                    className={`modal-btn ${here.horizonDays === h.days ? "is-primary" : ""}`}
                    data-testid="vs-horizon"
                    data-days={h.days ?? "forever"}
                    aria-pressed={here.horizonDays === h.days}
                    disabled={busy}
                    onClick={() => void act(() => versionsSetHorizon(here.root, h.days))}
                  >
                    {h.label}
                  </button>
                ))}
              </div>
            </>
          )}

          {mirror != null && root != null && (
            <>
              <div className="cloud-section-label">In the cloud</div>
              <p className="cloud-hint" data-testid="vs-cloud">
                {cloudKnown
                  ? `${mirror.cloud} version${mirror.cloud === 1 ? "" : "s"} in the bucket · kept ${horizonLabel(mirror.horizonDays)}`
                  : "Waiting for the first mirror to say what the bucket keeps."}
              </p>
              <div className="vs-choices" data-testid="vs-cloud-horizon" role="group" aria-label="How far back the cloud keeps">
                {HORIZONS.map((h) => (
                  <button
                    key={h.label}
                    className={`modal-btn ${cloudKnown && mirror.horizonDays === h.days ? "is-primary" : ""}`}
                    data-testid="vs-cloud-horizon-option"
                    data-days={h.days ?? "forever"}
                    aria-pressed={cloudKnown && mirror.horizonDays === h.days}
                    disabled={busy}
                    onClick={() => void act(() => versionsSetCloudHorizon(root, h.days))}
                  >
                    {h.label}
                  </button>
                ))}
              </div>
              <p className="cloud-hint">Every Mac here reads the same answer.</p>
            </>
          )}

          {root != null && (
            <>
              <div className="cloud-section-label">A copy you keep</div>
              <p className="cloud-hint">
                One archive holding this folder as it is now and its whole history. Plain tar.gz — nothing needs Doklin
                to open it.
              </p>
              <div className="cloud-actions">
                <button className="modal-btn" data-testid="vs-export" disabled={busy} onClick={() => void exportHere()}>
                  {busy && progress ? "Exporting…" : "Export…"}
                </button>
                {progress && progress.total > 0 && (
                  <span className="cloud-hint" data-testid="vs-progress">
                    {progress.done} of {progress.total} files
                  </span>
                )}
                {exported && !busy && (
                  <span className="cloud-hint" data-testid="vs-exported">
                    Wrote {exported.files} file{exported.files === 1 ? "" : "s"} · {formatBytes(exported.bytes)}
                  </span>
                )}
              </div>
            </>
          )}

          <div className="cloud-section-label">Other folders</div>
          {stores.length === 0 ? (
            <p className="cloud-hint" data-testid="vs-no-stores">
              No history has been kept on this Mac yet.
            </p>
          ) : (
            <ul className="vs-stores" data-testid="vs-stores">
              {stores.map((store) => (
                <li className="vs-store" key={store.key} data-testid="vs-store" data-key={store.key}>
                  <span className="vs-store-name" title={store.root}>
                    {basename(store.root) || store.key}
                  </span>
                  <span className="vs-store-sub">
                    {storeLine(store)}
                    {!store.exists && " · that folder is gone"}
                  </span>
                  <span className="vs-store-actions">
                    {open.has(store.key) ? (
                      <span className="cloud-hint" data-testid="vs-store-open">
                        open
                      </span>
                    ) : forgetting === store.key ? (
                      <>
                        <button
                          className="modal-btn is-danger-solid"
                          data-testid="vs-forget-yes"
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              await versionsForget(store.key);
                              setForgetting(null);
                              await load();
                            })
                          }
                        >
                          Forget
                        </button>
                        <button className="modal-btn" data-testid="vs-forget-cancel" onClick={() => setForgetting(null)}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        className="modal-btn"
                        data-testid="vs-forget"
                        onClick={() => {
                          setError(null);
                          setForgetting(store.key);
                        }}
                      >
                        Forget…
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {forgetting && (
            <p className="cloud-hint" data-testid="vs-forget-warn">
              Forgetting deletes that folder's history for good. The folder itself is never touched.
            </p>
          )}
          {error && (
            <div className="modal-error" data-testid="vs-error">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
