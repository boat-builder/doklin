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
  /** The full sha256, whichever store the version came out of. */
  hash: string;
  size: number;
  /** The device that took the snapshot. */
  by: string;
  /** The capture's reason. Empty only on a row the app synthesises — the
   *  last state of a deleted file, which no capture produced. */
  reason: VersionReason | "";
  label: string | null;
  pinned: boolean;
  restoredFrom: number | null;
  /** The path as of that version — different from today's after a rename. */
  path: string;
  /** Where the bytes come from: `local` (a blob on this Mac) or `cloud`
   *  (one another Mac mirrored, read through the engine). Two values since
   *  phase 6 retired the sync manifest's own revisions. */
  source: "local" | "cloud";
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

/** One file a retained snapshot and the folder disagree about. Mirrored by
 *  src-tauri/src/versions/workspace.rs — change both. */
export type ChangedFile = {
  path: string;
  /** The content the snapshot holds — what a restore would write. */
  thenHash: string;
  /** The content on disk now. */
  nowHash: string;
};

/** The whole of what restoring one snapshot would do, before anything
 *  happens. A file the snapshot and the folder agree on is in none of the
 *  three lists. */
export type SnapshotDiff = {
  changed: ChangedFile[];
  /** On disk now and not in the snapshot: a restore moves these to the Trash. */
  added: string[];
  /** In the snapshot and not on disk: a restore brings these back. */
  missing: string[];
};

/** One file that was here and is not — a row of *Recently deleted*. */
export type DeletedFile = {
  /** Workspace-relative, as the snapshot held it. */
  path: string;
  /** The newest snapshot that still had it. */
  lastSeenMs: number;
  /** Its content then, for the preview and the restore. */
  hash: string;
  size: number;
};

/** What a workspace restore did. *Undo* is a restore of `preRestoreTs` with
 *  the same paths. */
export type RestoreReport = {
  written: number;
  trashed: number;
  preRestoreTs: number | null;
};

/** One version store on this Mac, whether or not its folder is open — a row
 *  of *Other folders* in the Versions settings. Mirrored by
 *  src-tauri/src/versions/stores.rs — change both. */
export type StoreInfo = {
  /** The store directory's name: `r-<16 hex>`, or `drafts`. */
  key: string;
  /** The folder it versions, as the store recorded it. */
  root: string;
  /** Is that folder still on this Mac? A store whose root is gone is what
   *  *Forget* is for. */
  exists: boolean;
  /** Everything under the store directory, compressed as it sits. */
  bytes: number;
  snapshots: number;
  newestMs: number | null;
};

/** What an export wrote. */
export type ExportReport = { bytes: number; files: number };

/** A restore landed on disk — the same shape as `cloud-applied`. */
export type VersionsAppliedEvent = { root: string; paths: string[] };

/** An export, file by file. */
export type VersionsProgressEvent = { root: string; done: number; total: number };

/** What one snapshot changed against the one before it — the "+2 −1 ~5" a
 *  row of the workspace timeline wears. */
export type SnapshotDelta = { added: number; removed: number; changed: number };

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
  /** Only `versionsSnapshots` fills this in — it reads both file maps to
   *  work it out. Null for the oldest row and for a capture's answer. */
  delta: SnapshotDelta | null;
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

/** Every version of one document, newest first — this Mac's snapshots and
 *  the ones other Macs mirrored, in one walk. */
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

/** What restoring one snapshot would do to the folder as it is now — the
 *  three lists the workspace timeline shows before anything happens. */
export const versionsSnapshotDiff = (root: string, ts: number) =>
  invoke<SnapshotDiff>("versions_snapshot_diff", { root, ts });

/** Every file this folder's history holds and the folder itself does not,
 *  most recently seen first. */
export async function versionsDeleted(root: string): Promise<DeletedFile[]> {
  const r = await invoke<unknown>("versions_deleted", { root });
  return Array.isArray(r) ? (r as DeletedFile[]) : [];
}

/** Put a whole moment back — or, with `paths`, the part of it the user
 *  ticked. Like the file restore it captures the state it leaves first, so
 *  the whole thing is undone by restoring `preRestoreTs` with the same
 *  paths. */
export const versionsRestoreSnapshot = (root: string, ts: number, paths?: string[] | null) =>
  invoke<RestoreReport>("versions_restore_snapshot", { root, ts, paths: paths ?? null });

/** How far back this folder keeps, null for forever. Written into the
 *  store's own index, so two folders can answer differently. */
export const versionsSetHorizon = (root: string, days: number | null) =>
  invoke<void>("versions_set_horizon", { root, days });

/** How far back the *bucket* keeps — one CAS on the cloud index, so every
 *  device agrees. Errors when the folder isn't connected. */
export const versionsSetCloudHorizon = (root: string, days: number | null) =>
  invoke<void>("versions_set_cloud_horizon", { root, days });

/** Every version store on this Mac, newest first. */
export async function versionsStores(): Promise<StoreInfo[]> {
  const r = await invoke<unknown>("versions_stores");
  return Array.isArray(r) ? (r as StoreInfo[]) : [];
}

/** Delete one store outright. Refused while its folder is open. */
export const versionsForget = (key: string) => invoke<void>("versions_forget", { key });

/** One archive of the folder and its whole history, written into `dest`. */
export const versionsExport = (root: string, dest: string) =>
  invoke<ExportReport>("versions_export", { root, dest });

/* ---------- Events ---------- */

export const onVersionsStatus = (cb: (statuses: VersionsStatus[]) => void): Promise<UnlistenFn> =>
  listen<unknown>("versions-status", (e) => cb(Array.isArray(e.payload) ? (e.payload as VersionsStatus[]) : []));

export const onVersionsApplied = (cb: (e: VersionsAppliedEvent) => void): Promise<UnlistenFn> =>
  listen<VersionsAppliedEvent>("versions-applied", (e) => cb(e.payload));

export const onVersionsProgress = (cb: (e: VersionsProgressEvent) => void): Promise<UnlistenFn> =>
  listen<VersionsProgressEvent>("versions-progress", (e) => cb(e.payload));

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
  // and `by` already says which Mac that was — so the word is the same on
  // both sides of the walk.
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
