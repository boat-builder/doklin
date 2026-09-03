// The frontend's half of the cloud contract (docs/cloud-redesign.md §6.7):
// the types the engine's status event and commands carry, one typed wrapper
// per command, and the listeners. No `fetch` anywhere — the Rust engine is
// the only code that holds a token or talks to a domain; this file only
// asks it things. Mirrored by src-tauri/src/cloud/status.rs — change both.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type CloudPhase =
  | "idle"
  | "syncing"
  | "offline"
  | "paused"
  | "pending-deletes"
  | "revoked"
  | "worker-outdated"
  | "error";

export type PublicKind = "file" | "dir";

/** One published page, as the engine believes it (the manifest plus this
 *  Mac's not-yet-synced edits). */
export type PublicPage = {
  slug: string;
  kind: PublicKind;
  /** Workspace-relative; "" is the workspace root for a folder page. */
  path: string;
  title: string | null;
  desc: string | null;
  by: string;
  at: number;
  /** False when the file is gone (the page 404s until stopped or the file
   *  returns), or when no synced file lives under a folder page. */
  alive: boolean;
  root: boolean;
};

export type PresenceDevice = {
  deviceId: string;
  name: string;
  /** Workspace-relative path being edited; null = here, idle. */
  path: string | null;
  ts: number;
};

/** The whole model for one connected workspace. */
export type CloudStatus = {
  root: string;
  domain: string;
  endpoint: string;
  wsId: string;
  name: string;
  phase: CloudPhase;
  lastSyncMs: number | null;
  error: string | null;
  pendingDeletes: number;
  /** What the domain's /api/meta last reported; null until it answered. */
  workerVersion: number | null;
  public: PublicPage[];
  presence: PresenceDevice[];
};

export type CloudWorkspaceRecord = {
  id: string;
  name: string;
  createdAt: string;
  createdBy: { deviceId: string | null; deviceName: string };
};

/** What a domain answered before anything was touched. */
export type CloudProbe = {
  workerVersion: number;
  /** The worker version this app was built against. */
  bundledVersion: number;
  features: string[];
  workspace: CloudWorkspaceRecord | null;
};

export type CloudRevision = {
  rev: number;
  hash: string;
  size: number;
  timeMs: number;
  by: string;
  current: boolean;
};

export type CloudAppliedEvent = { root: string; paths: string[] };
export type CloudConflictEvent = { root: string; path: string; by: string; conflictPath: string };
export type CloudPendingDeletesEvent = { root: string; count: number; total: number; paths: string[] };
export type CloudProgressEvent = { root: string; kind: "upload" | "download"; done: number; total: number };

/* ---------- Commands ---------- */

/** Every connected workspace's status. Tolerates a harness that answers
 *  nothing (the IPC stubs return null for unknown commands). */
export async function cloudStatus(): Promise<CloudStatus[]> {
  const r = await invoke<unknown>("cloud_status");
  return Array.isArray(r) ? (r as CloudStatus[]) : [];
}

/** 32 random bytes, hex — the owner token the setup wizard hands the agent. */
export const cloudMintToken = () => invoke<string>("cloud_mint_token");

export const cloudProbe = (endpoint: string, token: string) =>
  invoke<CloudProbe>("cloud_probe", { endpoint, token });

/** Bind a fresh domain to `root` and upload everything; resolves to the workspace id. */
export const cloudConnect = (root: string, endpoint: string, token: string, name: string) =>
  invoke<string>("cloud_connect", { root, endpoint, token, name });

/** Download a domain's workspace into `<destParent>/<name>`; resolves to the new folder. */
export const cloudJoin = (endpoint: string, token: string, destParent: string) =>
  invoke<string>("cloud_join", { endpoint, token, destParent });

/** Adopt a folder carrying the domain's marker in place; resolves to the workspace id. */
export const cloudResume = (root: string, endpoint: string, token: string) =>
  invoke<string>("cloud_resume", { root, endpoint, token });

export const cloudDisconnect = (root: string) => invoke<void>("cloud_disconnect", { root });
export const cloudSyncNow = (root: string) => invoke<void>("cloud_sync_now", { root });
export const cloudPause = (root: string, paused: boolean) => invoke<void>("cloud_pause", { root, paused });
export const cloudConfirmDeletes = (root: string) => invoke<void>("cloud_confirm_deletes", { root });

/** Which document this window is editing (absolute path), or none — presence. */
export const cloudSetActivity = (path: string | null) => invoke<void>("cloud_set_activity", { path });

/** Publish a file or a folder (the path decides); resolves to the slug. */
export const cloudPublish = (path: string, opts: { slug?: string; title?: string; desc?: string } = {}) =>
  invoke<string>("cloud_publish", {
    path,
    slug: opts.slug ?? null,
    title: opts.title ?? null,
    desc: opts.desc ?? null,
  });

export const cloudUnpublish = (root: string, slug: string) => invoke<void>("cloud_unpublish", { root, slug });
export const cloudSetRoot = (root: string, slug: string | null) => invoke<void>("cloud_set_root", { root, slug });
export const cloudHistory = (path: string) => invoke<CloudRevision[]>("cloud_history", { path });
export const cloudRevision = (path: string, hash: string) => invoke<string>("cloud_revision", { path, hash });

/** Erase everything on the workspace's domain and forget it here; resolves to the purged count. */
export const cloudWipe = (root: string) => invoke<number>("cloud_wipe", { root });

/* ---------- Events ---------- */

export const onCloudStatus = (cb: (statuses: CloudStatus[]) => void): Promise<UnlistenFn> =>
  listen<unknown>("cloud-status", (e) => cb(Array.isArray(e.payload) ? (e.payload as CloudStatus[]) : []));
export const onCloudApplied = (cb: (e: CloudAppliedEvent) => void) =>
  listen<CloudAppliedEvent>("cloud-applied", (e) => cb(e.payload));
export const onCloudConflict = (cb: (e: CloudConflictEvent) => void) =>
  listen<CloudConflictEvent>("cloud-conflict", (e) => cb(e.payload));
export const onCloudPendingDeletes = (cb: (e: CloudPendingDeletesEvent) => void) =>
  listen<CloudPendingDeletesEvent>("cloud-pending-deletes", (e) => cb(e.payload));
export const onCloudProgress = (cb: (e: CloudProgressEvent) => void) =>
  listen<CloudProgressEvent>("cloud-progress", (e) => cb(e.payload));

/* ---------- Derivations ---------- */

/** The status of the workspace opened at `root`, if it is connected. */
export function cloudForWorkspace(statuses: CloudStatus[], root: string | null): CloudStatus | null {
  if (!root) return null;
  return statuses.find((s) => s.root === root) ?? null;
}

/** One line for the phase: "Synced 2 min ago · notes.example.com". */
export function describeCloud(s: CloudStatus, now = Date.now()): string {
  const ago = (ms: number | null) => {
    if (ms == null) return "not synced yet";
    const secs = Math.max(0, Math.round((now - ms) / 1000));
    if (secs < 45) return "synced just now";
    const mins = Math.round(secs / 60);
    if (mins < 60) return `synced ${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `synced ${hours} h ago`;
    return `synced ${Math.round(hours / 24)} d ago`;
  };
  const phase: string = (() => {
    switch (s.phase) {
      case "idle":
        return ago(s.lastSyncMs);
      case "syncing":
        return "syncing…";
      case "offline":
        return `offline — ${ago(s.lastSyncMs)}`;
      case "paused":
        return "paused";
      case "pending-deletes":
        return `${s.pendingDeletes} deletions waiting for your go`;
      case "revoked":
        return "access revoked";
      case "worker-outdated":
        return "waiting on a worker update";
      case "error":
        return s.error ?? "error";
    }
  })();
  const line = phase.charAt(0).toUpperCase() + phase.slice(1);
  return `${line} · ${s.domain}`;
}
