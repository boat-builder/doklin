// The frontend's half of the versioning contract
// (docs/versioning-plan.md §4.5): the types the versioner's status event and
// commands carry, one typed wrapper per command, and the listener. No
// `fetch` and no filesystem here — the Rust versioner owns the store; this
// file only asks it things. Mirrored by src-tauri/src/versions/status.rs —
// change both.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type VersionsPhase = "idle" | "capturing" | "too-large" | "disabled" | "error";

/** Why a snapshot was taken. `pre-restore` is the state a restore left,
 *  `restore` the state it made. */
export type VersionReason = "interval" | "closing" | "seed" | "pre-restore" | "restore" | "manual";

/** How much of a store is on disk, compressed. */
export type VersionsBytes = { blobs: number; snapshots: number };

/** The whole model for one folder's version store. */
export type VersionsStatus = {
  /** The display root; the drafts folder for drafts. */
  root: string;
  key: string;
  phase: VersionsPhase;
  error: string | null;
  snapshots: number;
  oldestMs: number | null;
  newestMs: number | null;
  lastCaptureMs: number | null;
  bytes: VersionsBytes;
  /** How far back this store keeps versions; null = forever. */
  horizonDays: number | null;
};

/** One retained snapshot, as the history surfaces list it. */
export type SnapshotMeta = {
  ts: number;
  reason: VersionReason;
  files: number;
  bytes: number;
  /** Pinned versions are never thinned by the retention ladder. */
  pinned: boolean;
  label: string | null;
  /** For a `restore`: the ts of the snapshot its content came from. */
  restoredFrom: number | null;
};

/* ---------- Commands ---------- */

/** Every version store's status. Tolerates a harness that answers nothing
 *  (the IPC stubs return null for unknown commands). */
export async function versionsStatus(): Promise<VersionsStatus[]> {
  const r = await invoke<unknown>("versions_status");
  return Array.isArray(r) ? (r as VersionsStatus[]) : [];
}

/** A folder's retained snapshots, newest first. */
export async function versionsSnapshots(root: string): Promise<SnapshotMeta[]> {
  const r = await invoke<unknown>("versions_snapshots", { root });
  return Array.isArray(r) ? (r as SnapshotMeta[]) : [];
}

/** Capture now, whatever the cadence says. A `manual` capture (the default)
 *  is pinned and may carry a name; the answer is null when the folder is
 *  already exactly what the newest snapshot holds. */
export const versionsCaptureNow = (
  root: string,
  opts: { reason?: VersionReason; label?: string } = {},
) => invoke<SnapshotMeta | null>("versions_capture_now", { root, reason: opts.reason ?? null, label: opts.label ?? null });

/** Keep a version out of the ladder's reach, and optionally name it. */
export const versionsSetPinned = (root: string, ts: number, pinned: boolean, label?: string) =>
  invoke<void>("versions_set_pinned", { root, ts, pinned, label: label ?? null });

/** The kill switch. Nothing already captured is touched. */
export const versionsSetEnabled = (enabled: boolean) => invoke<void>("versions_set_enabled", { enabled });

/* ---------- Events ---------- */

export const onVersionsStatus = (cb: (statuses: VersionsStatus[]) => void): Promise<UnlistenFn> =>
  listen<unknown>("versions-status", (e) => cb(Array.isArray(e.payload) ? (e.payload as VersionsStatus[]) : []));

/* ---------- Derivations ---------- */

/** The store for the workspace opened at `root`, if it has one. */
export function versionsForWorkspace(statuses: VersionsStatus[], root: string | null): VersionsStatus | null {
  if (!root) return null;
  return statuses.find((s) => s.root === root) ?? null;
}

/** Whether this store is keeping history right now. */
export const versionsRunning = (s: VersionsStatus | null): boolean =>
  s != null && s.phase !== "disabled" && s.phase !== "too-large" && s.phase !== "error";
