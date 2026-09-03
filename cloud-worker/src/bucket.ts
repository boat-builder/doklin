// Readers for the bucket's small JSON objects — the binding, presence, the
// manifest's totals — tolerant of a corrupt object (the worker answers with
// what it can tell, never a 500 from someone else's bytes).

import type { Env } from "./env";
import { MANIFEST_KEY, MAX_NAME_LEN, PRESENCE_KEY, PRESENCE_TTL_MS, WORKSPACE_KEY } from "./layout";

/** workspace.json — the binding. Exists iff the domain holds a workspace. */
export type WorkspaceRecord = {
  id: string;
  name: string;
  createdAt: string;
  createdBy: { deviceId: string | null; deviceName: string };
};

export type PresenceEntry = { name: string; path?: string; ts: number };
export type PresenceMap = Record<string, PresenceEntry>;

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** The object parsed as a JSON object; `undefined` when it does not exist, `null` when it is not one. */
async function readObject(env: Env, key: string): Promise<Record<string, unknown> | null | undefined> {
  const obj = await env.DATA.get(key);
  if (!obj) return undefined;
  try {
    const v: unknown = await obj.json();
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

const str = (v: unknown, fallback: string, max = MAX_NAME_LEN): string =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : fallback;

/**
 * The binding, or null when the domain is free. A corrupt record still means
 * "bound" — a domain is bound iff workspace.json exists, and the only thing
 * that frees it is a wipe — so it reads as a workspace with unknown details.
 */
export async function readWorkspace(env: Env): Promise<WorkspaceRecord | null> {
  const v = await readObject(env, WORKSPACE_KEY);
  if (v === undefined) return null;
  const by = isObject(v?.createdBy) ? v.createdBy : {};
  return {
    id: str(v?.id, "unknown"),
    name: str(v?.name, "Workspace"),
    createdAt: str(v?.createdAt, "", 40),
    createdBy: {
      deviceId: typeof by.deviceId === "string" ? by.deviceId : null,
      deviceName: str(by.deviceName, "unknown"),
    },
  };
}

export async function readPresence(env: Env): Promise<PresenceMap> {
  const v = await readObject(env, PRESENCE_KEY);
  const devices = v?.devices;
  if (!isObject(devices)) return {};
  const out: PresenceMap = {};
  for (const [id, entry] of Object.entries(devices)) {
    if (!isObject(entry) || typeof entry.ts !== "number") continue;
    out[id] = {
      name: str(entry.name, "Someone"),
      ...(typeof entry.path === "string" ? { path: entry.path } : {}),
      ts: entry.ts,
    };
  }
  return out;
}

/** Drop the devices that stopped heartbeating. */
export function prunePresence(devices: PresenceMap, now = Date.now()): PresenceMap {
  const fresh: PresenceMap = {};
  for (const [id, entry] of Object.entries(devices)) {
    if (now - entry.ts < PRESENCE_TTL_MS) fresh[id] = entry;
  }
  return fresh;
}

/** How much the manifest lists: file count and their bytes. Zero when there is no readable manifest. */
export async function readManifestTotals(env: Env): Promise<{ files: number; bytes: number }> {
  const v = await readObject(env, MANIFEST_KEY);
  const files = v?.files;
  if (!isObject(files)) return { files: 0, bytes: 0 };
  let bytes = 0;
  let count = 0;
  for (const f of Object.values(files)) {
    if (!isObject(f)) continue;
    count += 1;
    if (typeof f.size === "number" && Number.isFinite(f.size)) bytes += f.size;
  }
  return { files: count, bytes };
}
