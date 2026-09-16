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
  /** Who published it, in words. The engine resolves the manifest's member
   *  id through the workspace's directory before this gets here, so nothing
   *  in the frontend holds a second answer to "who is m-1a2b3c4d". */
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
  /** How far back the bucket keeps, null for forever — the second of the two
   *  horizons. Meaningful once `lastMirrorMs` is set; before that no pass has
   *  read the cloud index. */
  horizonDays: number | null;
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
  /** What this Mac signs work with here, in words: the person the domain
   *  says it is, or this Mac's own name when it has not said. What a `by` is
   *  compared against to know whether somebody *else* did a thing. */
  me: string;
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

/** The hidden `.doklin/cloud.json` a connected folder carries — secret-free. */
export type CloudMarker = { domain: string; wsId: string };

/** What a second Mac needs to download a workspace: shown behind
 *  "Connect another Mac…", never part of a status. */
export type CloudCredentials = { endpoint: string; token: string };

/** The two halves of an invite found in one paste — either may be missing,
 *  and the redeem screen fills what it finds. */
export type CloudPastedInvite = { endpoint: string | null; code: string | null };

/** What a redeemed code answers with: this Mac's own credential, and who the
 *  domain says the person holding it is. The token goes straight into
 *  `cloudJoin` — an invitee's flow is the second Mac's flow from there on. */
export type CloudRedeemed = {
  endpoint: string;
  token: string;
  memberId: string;
  email: string;
  name: string;
};

/** A pending invite, as the domain holds it. The code is not in it: the
 *  worker keeps only `sha256(code)` and cannot hand one back. */
export type CloudInvite = {
  id: string;
  memberId: string;
  email: string;
  name: string;
  createdAt: number;
  expiresAt: number;
};

/** `cloudInvite`: the invite the domain now holds, plus the code itself —
 *  the one moment it exists in the clear. Show it once; nothing can produce
 *  it again. */
export type CloudInvited = { code: string; blob: string; invite: CloudInvite };

/** A person on a workspace. Never a credential: the app is told who holds
 *  one, never what it is. */
export type CloudMember = {
  id: string;
  email: string;
  name: string;
  /** What the People list shows — never authority. The owner's credential is
   *  the domain's env secret, so no row anybody can write confers it. */
  role: "owner" | "member";
  createdAt: number;
  /** Null until something writes one: the presence beat carries it, so it
   *  fills in with the phase that folds presence into the poll. */
  lastSeenAt: number | null;
  disabled: boolean;
  /** How many Macs this person is signed in on. */
  devices: number;
};

/** One signed-in Mac. The owner's own are not among them: their credential is
 *  the domain's env secret, which has no row to list and none to revoke. */
export type CloudDevice = {
  id: string;
  memberId: string;
  email: string;
  deviceId: string | null;
  deviceName: string | null;
  createdAt: number;
};

/** `cloudPeople`: everything the People view draws. `role` is how *this Mac*
 *  authenticates, and it is asked rather than remembered — the members route
 *  answers the owner's credential and refuses every other, so a member's
 *  lists are empty because they were never asked for. */
export type CloudPeople = {
  role: "owner" | "member";
  /** This Mac's own device id, so the list can mark which Mac is this one. */
  deviceId: string;
  members: CloudMember[];
  invites: CloudInvite[];
  devices: CloudDevice[];
};

export type CloudAppliedEvent = { root: string; paths: string[] };
/** `by` is a name, not an id: the engine resolves it, because the conflict
 *  copy it names is a real file on disk and had to be called something. */
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

/** Split one paste into the address and the code. Pure — no domain is touched. */
export const cloudParseInvite = (text: string) =>
  invoke<CloudPastedInvite>("cloud_parse_invite", { text });

/** Trade an invite code for this Mac's own credential. The order is inverted
 *  from every other entrance — redeem first, probe with what it minted —
 *  because an invitee cannot ask a domain anything until they hold a token. */
export const cloudRedeem = (endpoint: string, code: string) =>
  invoke<CloudRedeemed>("cloud_redeem", { endpoint, code });

/** Invite someone to a connected workspace by email (owner only). The code is
 *  minted and hashed on this Mac; only its sha256 goes up. */
export const cloudInvite = (root: string, email: string, name: string | null, days: number | null) =>
  invoke<CloudInvited>("cloud_invite", { root, email, name, days });

/** Who is on this workspace and what each of them holds — the People view's
 *  whole answer, this Mac's own role included. */
export const cloudPeople = (root: string) => invoke<CloudPeople>("cloud_people", { root });

/** The owner saying who they are. Identity, never authority: the domain's
 *  token authenticates them either way. */
export const cloudAdoptOwner = (root: string, email: string, name: string | null) =>
  invoke<CloudMember>("cloud_adopt_owner", { root, email, name });

/** Take a person off the workspace: their row, their pending invite and every
 *  Mac they signed in on. */
export const cloudRevokePerson = (root: string, memberId: string) =>
  invoke<void>("cloud_revoke_person", { root, memberId });

/** Revoke one Mac, leaving the person and their other Macs alone. It takes
 *  effect on that Mac's very next request. */
export const cloudRevokeDevice = (root: string, tokenId: string) =>
  invoke<void>("cloud_revoke_device", { root, tokenId });

/** Withdraw a code nobody has traded in yet. The person's row stays. */
export const cloudWithdrawInvite = (root: string, inviteId: string) =>
  invoke<void>("cloud_withdraw_invite", { root, inviteId });

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

/** How long something has left: "6 days", "3 h", "12 min", "any moment now".
 *  What a pending invite's expiry is written with. */
export function timeUntil(ms: number, now = Date.now()): string {
  const secs = Math.round((ms - now) / 1000);
  if (secs < 60) return "any moment now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours} h`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
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
