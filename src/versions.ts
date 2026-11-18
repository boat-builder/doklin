// The frontend's half of the versioning contract: the types the versioner's
// status event and commands carry, and what the UI reads out of them. The
// commands and events themselves are `Versions` in src/backend.ts. Mirrored by
// engine/src/versions/status.rs and the iPhone's Payloads.swift — change all
// three.

export type VersionsPhase = "idle" | "capturing" | "too-large" | "disabled" | "error";

/** Why a snapshot was taken. `pre-restore` is the state a restore left,
 *  `restore` the state it made. */
export type VersionReason = "interval" | "closing" | "seed" | "pre-restore" | "restore" | "manual";

/** How much of a store is on disk, compressed. */
export type VersionsBytes = { blobs: number; snapshots: number };

/** The whole model for one folder's version store. */
export type VersionsStatus = {
  /** The display root. */
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
 *  engine/src/versions/history.rs and the iPhone's Payloads.swift — change
 *  all three. */
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
   *  (one another Mac mirrored, read through the engine). */
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
 *  engine/src/versions/workspace.rs and the iPhone's Payloads.swift — change
 *  all three. */
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
 *  engine/src/versions/stores.rs — change both. */
export type StoreInfo = {
  /** The store directory's name: `r-<16 hex>`. */
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
  /** Only `snapshots` fills this in — it reads both file maps to
   *  work it out. Null for the oldest row and for a capture's answer. */
  delta: SnapshotDelta | null;
};

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
 *  moments. Kept beside the contract because the reasons are the contract.
 *  The iPhone says the same (`HistoryWords.reason`) — change both. */
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
