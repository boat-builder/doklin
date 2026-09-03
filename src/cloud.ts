// The frontend's half of the cloud contract (docs/cloud.md §6.7):
// the types the engine's status event and commands carry, one typed wrapper
// per command, and the listeners. No `fetch` anywhere — the Rust engine is
// the only code that holds a token or talks to a domain; this file only
// asks it things. Mirrored by src-tauri/src/cloud/status.rs — change both.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { COMPATIBILITY_DATE, WORKER_VERSION } from "virtual:cloud-worker-version";

/** The worker version this app was built for — parsed out of the worker's
 *  source at build time (vite.config.ts), never typed here. A domain whose
 *  worker reports less is "behind" and gets the update badge. */
export const BUNDLED_WORKER_VERSION: number = WORKER_VERSION;
/** The Workers runtime date the setup prompt writes into wrangler.toml. */
export const WORKER_COMPATIBILITY_DATE: string = COMPATIBILITY_DATE;

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
/** How much of this Mac's version history is in the bucket, and how much is
 *  up there in total. Mirrored by src-tauri/src/cloud/status.rs. */
export type VersionsMirror = {
  mirrored: number;
  cloud: number;
  lastMirrorMs: number | null;
};

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
  /** The version store's mirror; null when the worker predates it — which
   *  is exactly when the update badge is worth showing. */
  versions: VersionsMirror | null;
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

/** The hidden `.doklin/cloud.json` a connected folder carries — secret-free. */
export type CloudMarker = { domain: string; wsId: string };

/** What a second Mac needs to download a workspace: shown behind
 *  "Connect another Mac…", never part of a status. */
export type CloudCredentials = { endpoint: string; token: string };

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

/** The marker a folder carries, or null — the wizard's "resume" outcome. */
export const cloudMarker = (root: string) => invoke<CloudMarker | null>("cloud_marker", { root });

/** The endpoint and owner token of a connected workspace. */
export const cloudToken = (root: string) => invoke<CloudCredentials>("cloud_token", { root });

/** Ask the domain's worker what it is again ("Check again" after an update);
 *  the fresh version arrives in the next status. */
export const cloudCheckWorker = (root: string) => invoke<void>("cloud_check_worker", { root });

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

/** "just now", "2 min ago", "3 h ago", "12 d ago". */
export function timeAgo(ms: number, now = Date.now()): string {
  const secs = Math.max(0, Math.round((now - ms) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** The phase in words, lowercase: "synced 2 min ago", "paused", "offline — synced 3 h ago". */
export function phaseLine(s: CloudStatus, now = Date.now()): string {
  const synced = s.lastSyncMs == null ? "not synced yet" : `synced ${timeAgo(s.lastSyncMs, now)}`;
  switch (s.phase) {
    case "idle":
      return synced;
    case "syncing":
      return "syncing…";
    case "offline":
      return `offline — ${synced}`;
    case "paused":
      return "paused";
    case "pending-deletes":
      return `${s.pendingDeletes} deletion${s.pendingDeletes === 1 ? "" : "s"} waiting for your go`;
    case "revoked":
      return "access revoked";
    case "worker-outdated":
      return "waiting on a worker update";
    case "error":
      return s.error ?? "error";
  }
}

/** One line for the phase: "Synced 2 min ago · notes.example.com". */
export function describeCloud(s: CloudStatus, now = Date.now()): string {
  const phase = phaseLine(s, now);
  return `${phase.charAt(0).toUpperCase() + phase.slice(1)} · ${s.domain}`;
}

/** What the Cloud panel's *Version history* line says: how much of this
 *  folder's history the domain is holding, or that its worker is too old to
 *  hold any (docs/versioning-plan.md §6.2). History is never gated on the
 *  cloud, so a worker that can't mirror is a note, not a warning. */
export function versionsLine(s: CloudStatus, now = Date.now()): string {
  if (s.versions == null) {
    // Never having heard from the domain is not the same as hearing that it
    // is too old, and only one of the two asks the user to do something.
    return s.workerVersion == null
      ? `Still checking what ${s.domain} keeps — every version is kept on this Mac either way.`
      : "This domain’s worker is too old to keep version history — every version is still kept on this Mac.";
  }
  const { mirrored, cloud, lastMirrorMs } = s.versions;
  if (cloud === 0) {
    return `Nothing on ${s.domain} yet — this Mac’s history goes up within the hour.`;
  }
  const mine = mirrored >= cloud ? "all from this Mac" : `${mirrored} from this Mac`;
  const when = lastMirrorMs == null ? "" : ` · checked ${timeAgo(lastMirrorMs, now)}`;
  return `${cloud} snapshot${cloud === 1 ? "" : "s"} on ${s.domain}, ${mine}${when}`;
}

/** The domain's worker is behind the version this app was built for — the
 *  update badge. A 426 pause counts even before the version is known. */
export function workerBehind(s: CloudStatus): boolean {
  return s.phase === "worker-outdated" || (s.workerVersion != null && s.workerVersion < BUNDLED_WORKER_VERSION);
}

/** The domain's worker is newer than this app: Doklin is what needs updating. */
export function workerAhead(s: CloudStatus): boolean {
  return s.workerVersion != null && s.workerVersion > BUNDLED_WORKER_VERSION;
}

/** Whether the gear's badge should light for the cloud: some connected
 *  workspace's worker is behind. */
export const cloudNeedsAttention = (statuses: CloudStatus[]): boolean => statuses.some(workerBehind);

/* ---------- Publishing ---------- */

/** A slug's grammar — the same rule the engine and the worker check. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
/** Slugs the worker's own routes speak for. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "api",
  "__web",
  "raw",
  "og.png",
  "robots.txt",
  "favicon.ico",
  "apple-touch-icon.png",
  "join",
]);

/** Why a typed slug can't be one, or null when it can. The engine says the same things. */
export function slugProblem(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!SLUG_RE.test(s)) {
    return "3 to 64 characters: lowercase letters, digits and dashes, starting with a letter or digit";
  }
  if (RESERVED_SLUGS.has(s)) return `"${s}" is taken by the site itself`;
  return null;
}

const MD_EXT_RE = /\.(md|markdown|mdown|mkd)$/i;

/** A path inside the workspace, relative to its root ("" is the root itself); null when it lies outside. */
export function relPathIn(root: string, abs: string): string | null {
  if (abs === root) return "";
  return abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : null;
}

/** The address of a public page: its slug under the domain. */
export const pageUrl = (s: CloudStatus, page: PublicPage): string => `${s.endpoint}/${page.slug}`;

/**
 * The address of a note inside a published folder — Notion-style: the
 * folder's slug, then the path relative to the folder with the markdown
 * extension dropped and every segment percent-encoded.
 */
export function nestedUrl(s: CloudStatus, dir: PublicPage, rel: string): string {
  const inner = dir.path ? rel.slice(dir.path.length + 1) : rel;
  const shown = inner.replace(MD_EXT_RE, "");
  return `${s.endpoint}/${dir.slug}/${shown.split("/").map(encodeURIComponent).join("/")}`;
}

const covers = (dir: PublicPage, rel: string): boolean =>
  dir.kind === "dir" && (dir.path === "" || rel.startsWith(`${dir.path}/`));

/** The page published for exactly this path, of this kind, if any. */
export function pageForPath(s: CloudStatus, rel: string, kind: PublicKind): PublicPage | null {
  return s.public.find((p) => p.kind === kind && p.path === rel) ?? null;
}

/** The closest published folder covering a path (a folder counts as covering itself only through its own page). */
export function folderCovering(s: CloudStatus, rel: string): PublicPage | null {
  const dirs = s.public.filter((p) => covers(p, rel)).sort((a, b) => b.path.length - a.path.length);
  return dirs[0] ?? null;
}

/** One way a file is reachable: its own page, or a folder page's nested address. */
export type PublicPlace = { page: PublicPage; url: string; nested: boolean };

/** Everywhere a file is public, its own page first. */
export function placesOf(s: CloudStatus, rel: string): PublicPlace[] {
  const out: PublicPlace[] = [];
  const own = pageForPath(s, rel, "file");
  if (own) out.push({ page: own, url: pageUrl(s, own), nested: false });
  for (const dir of s.public.filter((p) => covers(p, rel)).sort((a, b) => b.path.length - a.path.length)) {
    out.push({ page: dir, url: nestedUrl(s, dir, rel), nested: true });
  }
  return out;
}

/** The pages with a page of their own, by workspace-relative path — the sidebar's dots. */
export function publishedByPath(s: CloudStatus | null): Map<string, PublicPage> {
  const out = new Map<string, PublicPage>();
  for (const p of s?.public ?? []) if (!out.has(p.path)) out.set(p.path, p);
  return out;
}

/** A slug to suggest for a name: lowercase, dashes for anything else, never shorter than the grammar allows. */
export function suggestSlug(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  const padded = base.length >= 3 ? base : `${base}${base ? "-" : ""}notes`;
  return RESERVED_SLUGS.has(padded) ? `${padded}-notes` : padded;
}
