// In-app auto-update, driven by Tauri's updater plugin. The plugin fetches the
// GitHub `latest.json` manifest (endpoint + pubkey configured in
// tauri.conf.json), and on install downloads the signed `.app.tar.gz`, verifies
// it against the pubkey, swaps the bundle in place, and — via the process
// plugin's relaunch() — restarts into the new version. One click, no browser,
// no drag-to-Applications.
//
// The release pipeline (.github/workflows/release.yml) publishes the updater
// artifacts + latest.json alongside the DMG; see that file for the CI side.
import { useCallback, useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

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
 * one-click download→verify→install→relaunch action.
 */
export function useUpdateCheck(): UpdateController {
  const [state, setState] = useState<UpdateState>({
    phase: "checking",
    current: "",
    latest: null,
    notes: "",
    progress: 0,
    error: null,
  });
  // The Update handle returned by check(); needed to drive the install.
  const updateRef = useRef<Update | null>(null);

  const runCheck = useCallback(async () => {
    setState((s) => ({ ...s, phase: "checking", error: null }));
    try {
      const upd = await check();
      updateRef.current = upd;
      setState((s) => ({
        ...s,
        phase: upd ? "available" : "uptodate",
        latest: upd?.version ?? null,
        notes: upd?.body ?? "",
        error: null,
      }));
    } catch (e) {
      setState((s) => ({ ...s, phase: "error", error: errMsg(e) }));
    }
  }, []);

  const install = useCallback(async () => {
    const upd = updateRef.current;
    if (!upd) return;
    let total = 0;
    let done = 0;
    setState((s) => ({ ...s, phase: "downloading", progress: 0, error: null }));
    try {
      await upd.downloadAndInstall((ev) => {
        if (ev.event === "Started") {
          total = ev.data.contentLength ?? 0;
          done = 0;
        } else if (ev.event === "Progress") {
          done += ev.data.chunkLength;
          setState((s) => ({ ...s, progress: total ? done / total : 0 }));
        } else if (ev.event === "Finished") {
          setState((s) => ({ ...s, phase: "installing", progress: 1 }));
        }
      });
      // Bundle swapped on disk — restart into the new version.
      await relaunch();
    } catch (e) {
      setState((s) => ({ ...s, phase: "error", error: errMsg(e) }));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void getVersion().then((v) => {
      if (alive) setState((s) => ({ ...s, current: v }));
    });
    void runCheck();
    return () => {
      alive = false;
    };
  }, [runCheck]);

  return { ...state, check: runCheck, install };
}
