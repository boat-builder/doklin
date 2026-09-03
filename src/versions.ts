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

/** One version of one document, as the history rail lists it. Mirrored by
 *  src-tauri/src/versions/history.rs — change both. */
export type FileVersion = {
  ts: number;
  /** The full sha256 for a version in either store; the sync manifest's
   *  16-character prefix for a `manifest` revision. */
  hash: string;
  size: number;
  /** The device that took the snapshot. */
  by: string;
  /** The capture's reason, or "" for a sync-manifest revision. */
  reason: VersionReason | "";
  label: string | null;
  pinned: boolean;
  restoredFrom: number | null;
  /** The path as of that version — different from today's after a rename. */
  path: string;
  /** Where the bytes come from: `local` (a blob on this Mac), `cloud` (the
   *  mirrored version store, read through the engine) or `manifest` (the
   *  sync manifest's own per-file revisions, which phase 6 retires). */
  source: "local" | "cloud" | "manifest";
  /** This version is byte-for-byte the file on disk right now. */
  current: boolean;
};

/** What `versionsHistory` answers. */
export type FileHistory = {
  /** The store's display root — what every other version command is keyed
   *  by, so a caller never has to work out which folder a document is in. */
  root: string;
  /** sha256 of the file on disk now; null when it is gone. */
  currentHash: string | null;
  versions: FileVersion[];
};

/** What a restore leaves behind, so *Undo* can put it back. */
export type RestoreOutcome = {
  preRestoreTs: number | null;
  preRestoreHash: string | null;
  /** The snapshot the restore itself made. */
  ts: number | null;
};

/** A restore landed on disk — the same shape as `cloud-applied`. */
export type VersionsAppliedEvent = { root: string; paths: string[] };

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

/** Every version of one document, newest first. Where the workspace is
 *  connected, the manifest's own revisions are folded in behind the local
 *  ones so history does not shrink on the day the rail ships. */
export async function versionsHistory(path: string): Promise<FileHistory> {
  const r = await invoke<FileHistory | null>("versions_history", { path });
  return r ?? { root: "", currentHash: null, versions: [] };
}

/** One version's text, for the preview. */
export const versionsRead = (root: string, hash: string) =>
  invoke<string>("versions_read", { root, hash });

/** A unified diff between two versions. A null hash means the file on disk,
 *  which is how the newest version is compared against now. */
export const versionsDiff = (
  root: string,
  opts: { path?: string; from?: string | null; to?: string | null } = {},
) =>
  invoke<string>("versions_diff", {
    root,
    path: opts.path ?? null,
    from: opts.from ?? null,
    to: opts.to ?? null,
  });

/** Put an earlier version back. The content is named either by `hash` (a
 *  version in this store) or by `text` (one only the cloud still holds).
 *  One command, never a capture and a write from here: the cadence could
 *  capture between them and the state being left would go unrecorded. */
export const versionsRestoreFile = (
  root: string,
  path: string,
  opts: { ts?: number | null; hash?: string | null; text?: string | null } = {},
) =>
  invoke<RestoreOutcome>("versions_restore_file", {
    root,
    path,
    ts: opts.ts ?? null,
    hash: opts.hash ?? null,
    text: opts.text ?? null,
  });

/* ---------- Events ---------- */

export const onVersionsStatus = (cb: (statuses: VersionsStatus[]) => void): Promise<UnlistenFn> =>
  listen<unknown>("versions-status", (e) => cb(Array.isArray(e.payload) ? (e.payload as VersionsStatus[]) : []));

export const onVersionsApplied = (cb: (e: VersionsAppliedEvent) => void): Promise<UnlistenFn> =>
  listen<VersionsAppliedEvent>("versions-applied", (e) => cb(e.payload));

/* ---------- Derivations ---------- */

/** The store for the workspace opened at `root`, if it has one. */
export function versionsForWorkspace(statuses: VersionsStatus[], root: string | null): VersionsStatus | null {
  if (!root) return null;
  return statuses.find((s) => s.root === root) ?? null;
}

/** Whether this store is keeping history right now. */
export const versionsRunning = (s: VersionsStatus | null): boolean =>
  s != null && s.phase !== "disabled" && s.phase !== "too-large" && s.phase !== "error";

/** The small word a row wears, so a list of times reads as a list of
 *  moments. Kept beside the contract because the reasons are the contract. */
export function versionReasonWord(v: Pick<FileVersion, "reason" | "source">): string {
  // A mirrored version carries the reason the device that took it recorded,
  // and `by` already says which Mac that was. A manifest revision carries
  // neither, so the source is all there is to say.
  if (v.source === "manifest") return "from the cloud";
  switch (v.reason) {
    case "interval":
      return "while editing";
    case "closing":
      return "end of session";
    case "seed":
      return "first seen";
    case "pre-restore":
      return "before a restore";
    case "restore":
      return "restored";
    case "manual":
      return "marked";
    default:
      return "";
  }
}
