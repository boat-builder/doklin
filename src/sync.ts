// Cloud sync — frontend side.
//
// The heavy lifting (watching, hashing, merging, CAS pushes) lives in the
// Rust engine (src-tauri/src/sync.rs); this module is the thin layer the UI
// needs: typed wrappers around the engine's Tauri commands and events, plus
// the worker's auth/workspace HTTP API (invites, members, joining) — which is
// people-management, so it stays in the frontend next to share.ts, whose
// connections it reuses.
//
// Mental model shown to users: a *backend* is a place (a domain you connect);
// a *workspace* is a folder that lives at a place; *people* are invited to
// workspaces; publishing stays a separate, explicit act.

import { invoke } from "@tauri-apps/api/core";
import type { ShareConfig } from "./share";

/* ---------- Engine state (Tauri commands + events) ---------- */

// Mirror of the engine's WsStatus (serde camelCase).
export type SyncWorkspaceStatus = {
  wsId: string;
  name: string;
  root: string;
  connectionId: string;
  phase:
    | "idle"
    | "syncing"
    | "offline"
    | "paused"
    | "pending-deletes"
    | "revoked"
    | "error"
    | "removed"
    | string;
  pendingDeletes: number;
  lastSyncMs: number | null;
  error: string | null;
  // The workspace's share registry as the engine believes it: the last
  // applied manifest overlaid with this device's not-yet-committed share
  // ops. App.tsx mirrors these into the localStorage registry so every
  // device (and every person on the backend) agrees on what's published.
  shares: WsShareInfo[];
  collections: WsCollectionInfo[];
};

// One published file in a synced workspace (engine's WsShare).
export type WsShareInfo = {
  path: string; // workspace-relative
  id: string; // public page id
  cid: string | null; // folder share (collection page id) listing it, if any
  title: string;
  by: string;
  at: number;
  // False = the file was deleted; its page lives on until stopped, but it
  // should drop off TOCs and grow no new mirror entries.
  alive: boolean;
};

// One folder share in a synced workspace (engine's WsCollection).
export type WsCollectionInfo = {
  id: string; // public TOC page id
  path: string; // workspace-relative directory, "" = the workspace root
  title: string;
  desc: string | null;
  by: string;
  at: number;
};

// The wire shape of a share op's payload — mirrors the engine's ShareRef.
// `path` is stamped engine-side from the op key, so callers leave it "".
export type ShareRefInput = {
  id: string;
  path: string;
  cid?: string | null;
  title: string;
  by: string;
  at: number;
};

export type CollectionRefInput = {
  path: string; // workspace-relative directory, "" = root
  title: string;
  desc?: string | null;
  by: string;
  at: number;
};

export type SyncDevice = { id: string; name: string };

// Payload of the engine's "sync-presence" event: who else is editing what,
// per workspace (this device filtered out engine-side).
export type SyncPresenceEvent = {
  wsId: string;
  devices: { deviceId: string; name: string; fileId: string | null; path: string | null; ts: number }[];
};

export type SyncConflictEvent = {
  wsId: string;
  path: string;
  by: string;
  conflictPath: string;
};

export type SyncPendingDeletesEvent = {
  wsId: string;
  count: number;
  total: number;
  paths: string[];
};

export type SyncProgressEvent = {
  wsId: string;
  kind: "upload" | "download";
  done: number;
  total: number;
};

export type SyncAppliedEvent = { wsId: string; paths: string[] };

export const syncStatus = () => invoke<SyncWorkspaceStatus[]>("sync_status");
export const syncEnable = (root: string, connectionId: string, name: string) =>
  invoke<string>("sync_enable", { root, connectionId, name });
export const syncConnect = (
  wsId: string,
  name: string,
  destParent: string,
  connectionId: string,
) => invoke<string>("sync_connect", { wsId, name, destParent, connectionId });
export const syncDisable = (wsId: string) => invoke("sync_disable", { wsId });
export const syncNow = (wsId: string) => invoke("sync_now", { wsId });
export const syncPause = (wsId: string, paused: boolean) =>
  invoke("sync_pause", { wsId, paused });
export const syncConfirmDeletes = (wsId: string) => invoke("sync_confirm_deletes", { wsId });
export const syncDevice = () => invoke<SyncDevice>("sync_device");
export const syncReloadConnections = () => invoke("sync_reload_connections");

// Queue share-registry ops on a workspace's manifest: `files` keyed by
// workspace-relative path, `collections` by collection page id; null = forget
// the record. The engine persists the ops and carries them on its next won
// CAS, so callers fire-and-forget.
export const syncSetShares = (
  wsId: string,
  files: Record<string, ShareRefInput | null>,
  collections: Record<string, CollectionRefInput | null> = {},
) => invoke("sync_set_shares", { wsId, files, collections });

// Fire-and-forget: tells the engines which document the user is actively
// editing so presence heartbeats say something true. Called from autosave and
// tab focus — must never surface an error into that path.
export function reportSyncActivity(path: string | null) {
  invoke("sync_set_activity", { path }).catch(() => {});
}

/* ---------- Worker auth/workspace API (people management) ---------- */

function api(config: ShareConfig, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${config.endpoint}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${config.token}`,
      ...(init?.headers ?? {}),
    },
  });
}

// Thrown when a route 404s because the deployed worker predates sync
// (version < 4) — the caller routes to the worker-update guide.
export class SyncWorkerOutdatedError extends Error {
  constructor() {
    super("This backend's worker predates cloud sync. Update the worker, then try again.");
    this.name = "SyncWorkerOutdatedError";
  }
}

async function readJson<T>(res: Response, what: string): Promise<T> {
  if (res.status === 404) throw new SyncWorkerOutdatedError();
  if (res.status === 401) throw new Error("The backend rejected this connection's token.");
  if (res.status === 403) throw new Error("This connection isn't allowed to do that.");
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ? `${what}: ${body.error}` : `${what} failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export type WhoAmI = {
  tokenId: string;
  name: string;
  role: "owner" | "member";
  workspaces: "*" | string[];
};

export function whoami(config: ShareConfig): Promise<WhoAmI> {
  return api(config, "/api/auth/whoami").then((r) => readJson<WhoAmI>(r, "identity check"));
}

export type RemoteWorkspace = { id: string; name: string; createdAt: string | null };

export async function listRemoteWorkspaces(config: ShareConfig): Promise<RemoteWorkspace[]> {
  const res = await api(config, "/api/sync/workspaces");
  const body = await readJson<{ workspaces?: RemoteWorkspace[] }>(res, "workspace list");
  return Array.isArray(body.workspaces) ? body.workspaces : [];
}

export async function deleteRemoteWorkspace(config: ShareConfig, wsId: string): Promise<void> {
  // The worker purges as much as one request may; repeat until done.
  for (let i = 0; i < 50; i += 1) {
    const res = await api(config, `/api/sync/workspaces/${wsId}`, { method: "DELETE" });
    const body = await readJson<{ remaining?: boolean }>(res, "workspace delete");
    if (!body.remaining) return;
  }
  throw new Error("workspace delete didn't finish — try again");
}

export type InviteInfo = {
  id: string;
  name: string;
  role: "owner" | "member";
  workspaces: "*" | string[];
  createdAt: string | null;
  expiresAt: string | null;
};

export type CreatedInvite = InviteInfo & { code: string; joinUrl: string };

export async function createInvite(
  config: ShareConfig,
  opts: { name: string; role: "owner" | "member"; workspaces?: string[] },
): Promise<CreatedInvite> {
  const res = await api(config, "/api/auth/invites", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: opts.name,
      role: opts.role,
      ...(opts.role === "member" ? { workspaces: opts.workspaces ?? [] } : {}),
    }),
  });
  return readJson<CreatedInvite>(res, "invite");
}

export async function listInvites(config: ShareConfig): Promise<InviteInfo[]> {
  const res = await api(config, "/api/auth/invites");
  const body = await readJson<{ invites?: InviteInfo[] }>(res, "invite list");
  return Array.isArray(body.invites) ? body.invites : [];
}

export async function cancelInvite(config: ShareConfig, id: string): Promise<void> {
  const res = await api(config, `/api/auth/invites/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error(`cancel invite failed (${res.status})`);
}

export type TokenInfo = {
  id: string;
  name: string;
  role: "owner" | "member";
  workspaces: "*" | string[];
  createdAt: string | null;
  lastSeenAt: string | null;
};

export async function listTokens(config: ShareConfig): Promise<TokenInfo[]> {
  const res = await api(config, "/api/auth/tokens");
  const body = await readJson<{ tokens?: TokenInfo[] }>(res, "member list");
  return Array.isArray(body.tokens) ? body.tokens : [];
}

export async function revokeToken(config: ShareConfig, id: string): Promise<void> {
  const res = await api(config, `/api/auth/tokens/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error(`revoke failed (${res.status})`);
}

/* ---------- Joining a backend (no auth — the invite IS the credential) ---------- */

export type JoinResult = {
  token: string;
  tokenId: string;
  name: string;
  role: "owner" | "member";
  workspaces: "*" | string[];
};

// Accepts what a person will actually paste: the full invite link
// (https://host/join#dk_i_…), just the code, or the code with whitespace.
// Returns the pieces, or null when it's neither.
export function parseInviteInput(raw: string): { endpoint: string | null; code: string } | null {
  const text = raw.trim();
  if (!text) return null;
  const codeMatch = text.match(/dk_i_[a-f0-9]{24,80}/);
  if (!codeMatch) return null;
  const code = codeMatch[0];
  try {
    const url = new URL(text);
    if (url.protocol === "https:" || url.protocol === "http:") {
      return { endpoint: url.origin, code };
    }
  } catch {
    // not a URL — bare code
  }
  return { endpoint: null, code };
}

export async function joinBackend(
  endpoint: string,
  code: string,
  deviceLabel: string,
): Promise<JoinResult> {
  let res: Response;
  try {
    res = await fetch(`${endpoint.replace(/\/+$/, "")}/api/auth/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invite: code, name: deviceLabel }),
    });
  } catch {
    throw new Error("Couldn't reach that backend. Check the link and your connection.");
  }
  if (res.status === 404) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    // A worker without /api/auth/join answers with the shell 404 page (no
    // JSON error field) — distinguish "old worker" from "bad code".
    if (!body?.error) throw new SyncWorkerOutdatedError();
    throw new Error("That invite isn't valid — ask for a fresh link.");
  }
  if (res.status === 410) throw new Error("That invite was already used — ask for a fresh link.");
  if (res.status === 429) throw new Error("Too many attempts — wait a minute and try again.");
  if (!res.ok) throw new Error(`Joining failed (${res.status}).`);
  const body = (await res.json().catch(() => null)) as JoinResult | null;
  if (!body || typeof body.token !== "string") throw new Error("Joining failed — bad response.");
  return body;
}

/* ---------- Version history (worker manifest + archive + blobs) ---------- */

export type HistoryRevision = {
  rev: number;
  hash: string;
  size: number;
  timeMs: number;
  by: string;
  current: boolean;
};

type WireHist = { r: number; h: string; s: number; t: number; b?: string };
type WireManifest = {
  files?: Record<
    string,
    { path?: string; rev?: number; hash?: string; size?: number; mtime?: number; by?: string; hist?: WireHist[] }
  >;
};

// Every known revision of the file at `relPath`, newest first: the manifest's
// current + inline tail, extended by the deep archive when present.
export async function fetchFileHistory(
  config: ShareConfig,
  wsId: string,
  relPath: string,
): Promise<{ fileId: string; revisions: HistoryRevision[] } | null> {
  const mres = await api(config, `/api/sync/${wsId}/manifest`);
  const manifest = await readJson<WireManifest>(mres, "history");
  const entry = Object.entries(manifest.files ?? {}).find(([, f]) => f.path === relPath);
  if (!entry) return null;
  const [fileId, f] = entry;

  const seen = new Set<number>();
  const revisions: HistoryRevision[] = [];
  const push = (r: WireHist, current: boolean) => {
    if (seen.has(r.r)) return;
    seen.add(r.r);
    revisions.push({
      rev: r.r,
      hash: r.h,
      size: r.s,
      timeMs: r.t,
      by: r.b ?? "",
      current,
    });
  };
  push({ r: f.rev ?? 0, h: f.hash ?? "", s: f.size ?? 0, t: f.mtime ?? 0, b: f.by }, true);
  for (const h of f.hist ?? []) push(h, false);

  const ares = await api(config, `/api/sync/${wsId}/history/${fileId}`);
  if (ares.ok) {
    const body = (await ares.json().catch(() => null)) as { entries?: WireHist[] } | null;
    for (const h of body?.entries ?? []) push(h, false);
  }
  revisions.sort((a, b) => b.rev - a.rev);
  return { fileId, revisions };
}

export async function fetchRevisionContent(
  config: ShareConfig,
  wsId: string,
  fileId: string,
  hash: string,
): Promise<string> {
  const res = await api(config, `/api/sync/${wsId}/files/${fileId}/${hash}`);
  if (res.status === 404) {
    throw new Error("That revision's content was already cleaned up.");
  }
  if (!res.ok) throw new Error(`couldn't fetch revision (${res.status})`);
  return res.text();
}
