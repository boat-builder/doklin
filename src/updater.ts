// In-app auto-update: a quiet check at launch, a manual one, and one click
// that downloads, verifies, installs and restarts into the new version. How
// that is done is the backend's (`Updater` in backend.ts); a platform with no
// updater has no update row at all.
//
// The release pipeline (.github/workflows/release.yml) publishes what the
// check reads.
import { useCallback, useEffect, useRef, useState } from "react";
import { backend, type AvailableUpdate } from "./backend";

/** The rolling release page — manual-download fallback when auto-update fails. */
export const RELEASES_PAGE =
  "https://github.com/boat-builder/doklin/releases/latest";

export type UpdatePhase =
  | "checking" // querying the update manifest
  | "uptodate" // no newer release
  | "available" // a newer release exists, not yet installing
  | "downloading" // fetching + verifying the new bundle
  | "installing" // bundle swapped, about to relaunch
  | "error"; // check or download failed

export type UpdateState = {
  phase: UpdatePhase;
  /** The running app version. */
  current: string;
  /** The available version, set when phase === "available". */
  latest: string | null;
  /** Release notes for the available version. */
  notes: string;
  /** Download progress in [0, 1] while phase === "downloading". */
  progress: number;
  /** A human-readable failure reason when phase === "error". */
  error: string | null;
};

export type UpdateController = UpdateState & {
  /** Re-run the update check (the manual "Check for updates" button). */
  check: () => Promise<void>;
  /** Download, verify, install and relaunch into the available update. */
  install: () => Promise<void>;
};

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Update failed.";
}

/**
 * Owns updater state: a quiet check on mount, a manual re-check, and the
 * one-click download→verify→install→relaunch action. Null where the
 * platform has no updater.
 */
export function useUpdateCheck(): UpdateController | null {
  const [state, setState] = useState<UpdateState>({
    phase: "checking",
    current: "",
    latest: null,
    notes: "",
    progress: 0,
    error: null,
  });
  // What the last check found; needed to drive the install.
  const updateRef = useRef<AvailableUpdate | null>(null);
  // An install under way is never interrupted by another check (the cover in
  // UpdateRequired.tsx asks for one when it goes up).
  const installing = useRef(false);

  const runCheck = useCallback(async () => {
    const updater = backend.updater;
    if (!updater || installing.current) return;
    setState((s) => ({ ...s, phase: "checking", error: null }));
    try {
      const upd = await updater.check();
      updateRef.current = upd;
      setState((s) => ({
        ...s,
        phase: upd ? "available" : "uptodate",
        latest: upd?.version ?? null,
        notes: upd?.notes ?? "",
        error: null,
      }));
    } catch (e) {
      setState((s) => ({ ...s, phase: "error", error: errMsg(e) }));
    }
  }, []);

  const install = useCallback(async () => {
    const upd = updateRef.current;
    if (!upd) return;
    installing.current = true;
    setState((s) => ({ ...s, phase: "downloading", progress: 0, error: null }));
    try {
      await upd.install((p) => {
        if (p.phase === "downloading") setState((s) => ({ ...s, progress: p.fraction }));
        else setState((s) => ({ ...s, phase: "installing", progress: 1 }));
      });
    } catch (e) {
      installing.current = false;
      setState((s) => ({ ...s, phase: "error", error: errMsg(e) }));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void backend.updater?.version().then((v) => {
      if (alive) setState((s) => ({ ...s, current: v }));
    });
    void runCheck();
    return () => {
      alive = false;
    };
  }, [runCheck]);

  return backend.updater ? { ...state, check: runCheck, install } : null;
}
