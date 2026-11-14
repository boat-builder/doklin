// The frontend's half of the cloud contract:
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

/** Another Mac here now. Mirrors `PresenceDevice` in status.rs — change both. */
export type PresenceDevice = {
  deviceId: string;
  /** Whose Mac it is; null from a worker before v7, or an owner nobody named. */
  memberId: string | null;
  /** Who is here, in words: the person — or the Mac, when it is your own
   *  other Mac or nobody the workspace can name yet. The engine resolves it. */
  name: string;
  /** The Mac's own name, whoever's it is. */
  device: string;
  /** Workspace-relative path being edited; null = here, idle. */
  path: string | null;
  ts: number;
};

/** A document another Mac holds — open there, so it
 *  opens view-only here. Mirrors `LeaseHolder` in status.rs — change both. */
export type LeaseHolder = {
  /** The lease's key: workspace-relative and lowercased, so match it with
   *  `leaseFor` rather than comparing a path to it. */
  path: string;
  deviceId: string;
  memberId: string | null;
  /** Who holds it, in words — resolved like a presence row: the person, or
   *  the Mac when it is your own other one or nobody the workspace can name. */
  name: string;
  /** The holder's Mac. */
  device: string;
  /** True when the holder is you, on another Mac. */
  own: boolean;
  /** When it lapses unless renewed, by the domain's clock. */
  until: number;
};

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

/** What a role may do on a workspace, in the words of the worker's one table
 *  (cloud-worker/src/roles.ts) — the domain says which of these this Mac
 *  holds, and every surface hides the rest by it. */
export type CloudAction =
  | "work"
  | "people.see"
  | "people.invite"
  | "people.remove"
  | "people.roles"
  | "agents.own"
  | "agents.manage"
  | "pages.manage"
  | "workspace.manage";

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
  /** The same person as the domain's id for them — which of a folder's
   *  `members` is you. Null until the domain has said, and for a creator who
   *  never said who they are. */
  meId: string | null;
  /** What this Mac's credential may do here, as the domain last said. Empty
   *  until it has answered, and from a worker that predates roles. Ask it
   *  with `mayOn`, which reads "not known yet" as it should be read. */
  can: string[];
  /** What the domain's /api/meta last reported; null until it answered. */
  workerVersion: number | null;
  /** The version store's mirror; null when the worker predates it — which
   *  is exactly when the update badge is worth showing. */
  versions: VersionsMirror | null;
  public: PublicPage[];
  presence: PresenceDevice[];
  /** The documents another Mac holds. Empty when the engine cannot hear the
   *  domain, or the worker predates leases: a lock nobody can confirm is no
   *  lock. */
  leases: LeaseHolder[];
  /** This person's sections besides the shared workspace — their Private and
   *  the restricted folders they are in — that have a folder on this Mac. */
  spaces: CloudSpace[];
  /** The workspace is in sections here: `Private` and `Restricted` at its
   *  top are not shared folders. False from a worker without spaces. */
  sections: boolean;
};

/** One section of a workspace that only some people have. Mirrors
 *  `SpaceStatus` in status.rs — change both. */
export type CloudSpace = {
  id: string;
  kind: "private" | "restricted";
  name: string;
  /** Its folder on this Mac, workspace-relative: `Private`, `Restricted/Finance`. */
  path: string;
  /** Who made it, as a name. */
  by: string;
  /** Everyone in it, by member id. */
  members: string[];
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
 *  "Connect another Mac", never part of a status. */
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
  /** The person's role, carried by every Mac they are signed in on. An owner
   *  makes another by changing it. */
  role: "owner" | "member";
  /** The person who made the workspace and holds its domain's own token.
   *  Always an owner; nobody can remove them or make them a member. */
  creator: boolean;
  createdAt: number;
  /** When a Mac of theirs last beat, to the hour — and, before any has, when
   *  they first traded a code in. Null means nobody has ever signed in as
   *  them: they are invited, and that is all. */
  lastSeenAt: number | null;
  /** How many Macs this person is signed in on. */
  devices: number;
};

/** One signed-in Mac. The creator's own are not among them: their credential
 *  is the domain's env secret, which has no row to list and none to revoke. */
export type CloudDevice = {
  id: string;
  memberId: string;
  email: string;
  deviceId: string | null;
  deviceName: string | null;
  createdAt: number;
};

/** `cloudPeople`: everything the People view draws. Who this Mac is here and
 *  what it may do is asked of the domain each time the view opens, never
 *  remembered — a role is the person's, and an owner can change it. */
export type CloudPeople = {
  role: "owner" | "member";
  /** This Mac holds the domain's own token: the workspace's creator. */
  creator: boolean;
  /** Which of `members` is you; null for a creator who has not said yet. */
  me: string | null;
  /** What that role may do — the buttons this view offers. */
  can: string[];
  /** This Mac's own device id, so the list can mark which Mac is this one. */
  deviceId: string;
  /** Which of `devices` is the credential this Mac syncs with — it can carry
   *  another Mac's device id, when the token came through *Connect another
   *  Mac…*. Never offered for signing out. Null for the creator's token. */
  tokenId: string | null;
  /** Everyone on the workspace. */
  members: CloudMember[];
  /** Codes nobody has used yet. Empty for whoever may not invite. */
  invites: CloudInvite[];
  /** Signed-in Macs. Empty for whoever may not sign one out. */
  devices: CloudDevice[];
};

/** What an agent may do. `read` is always held. */
export type AgentScope = "read" | "comment" | "edit" | "publish";

/** One machine an agent is logged in on, by what the machine calls itself. */
export type CloudAgentMachine = { id: string; host: string; createdAt: number };

/** An agent: an identity that is not a person, added by the owner. Never a
 *  credential — `code` says a login code is waiting, not what it is. */
export type CloudAgent = {
  id: string;
  name: string;
  scopes: AgentScope[];
  createdAt: number;
  /** When it last made a request, to the hour. Null until it has. */
  lastUsedAt: number | null;
  /** Whose it is: one of the workspace's people. Null for a creator who has
   *  not said who they are. */
  memberId: string | null;
  /** Whether that is you. Somebody else's is listed to an owner, who may
   *  remove it and nothing more. */
  mine: boolean;
  machines: CloudAgentMachine[];
  /** A login code nobody has used yet — only ever on an agent of your own. */
  code: { id: string; createdAt: number; expiresAt: number } | null;
};

/** A freshly minted login code and the line that carries it — the one moment
 *  the code exists in the clear. Show it once; nothing can produce it again. */
export type CloudAgentLogin = { line: string; code: string; expiresAt: number };

export type CloudAgentAdded = { agent: CloudAgent; login: CloudAgentLogin };

export type CloudAppliedEvent = { root: string; paths: string[] };
/** `by` is a name, not an id: the engine resolves it, because the conflict
 *  copy it names is a real file on disk and had to be called something.
 *  Both paths are workspace-relative. */
export type CloudConflictEvent = { root: string; path: string; by: string; conflictPath: string };
export type CloudPendingDeletesEvent = { root: string; count: number; total: number; paths: string[] };
/** A page asked for an address another section holds on this domain, and was
 *  not published. `path` is workspace-relative. */
export type CloudAddressTakenEvent = { root: string; slug: string; path: string };
/** A restricted folder left this Mac: you were taken out of it, or it was
 *  deleted. `path` is where it was, workspace-relative. */
export type CloudSpaceLeftEvent = { root: string; name: string; path: string };
export type CloudProgressEvent = { root: string; kind: "upload" | "download"; done: number; total: number };
/** An owner took this Mac's access to a workspace away, and its copy here is
 *  gone: the folder, and what Doklin kept for it. `deleted` is false when the
 *  folder could not be removed — the notice says so rather than pretending.
 *  `at` is when (ms): with `root`, how a window knows one it already showed. */
export type CloudRemovedEvent = { root: string; name: string; domain: string; deleted: boolean; at: number };

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

/** Invite someone to a connected workspace by email (an owner's to do). The
 *  code is minted and hashed on this Mac; only its sha256 goes up. */
export const cloudInvite = (root: string, email: string, name: string | null, days: number | null) =>
  invoke<CloudInvited>("cloud_invite", { root, email, name, days });

/** Who is on this workspace and what each of them holds — the People view's
 *  whole answer, this Mac's own role included. */
export const cloudPeople = (root: string) => invoke<CloudPeople>("cloud_people", { root });

/** The creator saying who they are. Identity, never authority: the domain's
 *  token authenticates them either way. */
export const cloudAdoptOwner = (root: string, email: string, name: string | null) =>
  invoke<CloudMember>("cloud_adopt_owner", { root, email, name });

/** Every workspace taken off this Mac since the app started. The event says
 *  so as it happens; this answers a window that was not listening yet — an
 *  engine can hear it on first contact, before the first window is up. */
export async function cloudRemoved(): Promise<CloudRemovedEvent[]> {
  const r = await invoke<unknown>("cloud_removed");
  return Array.isArray(r) ? (r as CloudRemovedEvent[]) : [];
}

/** Make someone an owner, or a member again. Every Mac they are signed in on
 *  carries the new role on its next request. */
export const cloudSetRole = (root: string, memberId: string, role: "owner" | "member") =>
  invoke<CloudMember>("cloud_set_role", { root, memberId, role });

/** Take a person off the workspace: their row, their pending invite and every
 *  Mac they signed in on. Each of those Macs deletes its copy when it hears. */
export const cloudRevokePerson = (root: string, memberId: string) =>
  invoke<void>("cloud_revoke_person", { root, memberId });

/** Sign one Mac out, leaving the person and their other Macs alone. It takes
 *  effect on that Mac's very next request, and that Mac deletes its copy. */
export const cloudRevokeDevice = (root: string, tokenId: string) =>
  invoke<void>("cloud_revoke_device", { root, tokenId });

/** Withdraw a code nobody has traded in yet. The person's row stays. */
export const cloudWithdrawInvite = (root: string, inviteId: string) =>
  invoke<void>("cloud_withdraw_invite", { root, inviteId });

/** Every agent on this workspace — the owner's to see. */
export const cloudAgents = (root: string) => invoke<CloudAgent[]>("cloud_agents", { root });

/** Add an agent and mint the line its first machine logs in with. */
export const cloudAgentAdd = (root: string, name: string, scopes: AgentScope[]) =>
  invoke<CloudAgentAdded>("cloud_agent_add", { root, name, scopes });

/** A new login code for an agent — for another machine, or after the last
 *  one ran out. Whatever code it had stops working. */
export const cloudAgentCode = (root: string, agentId: string) =>
  invoke<CloudAgentLogin>("cloud_agent_code", { root, agentId });

/** Rename an agent or change what it may do; it finds out on its next request. */
export const cloudAgentUpdate = (root: string, agentId: string, name: string | null, scopes: AgentScope[] | null) =>
  invoke<void>("cloud_agent_update", { root, agentId, name, scopes });

/** Remove an agent and log every one of its machines out. */
export const cloudAgentRemove = (root: string, agentId: string) =>
  invoke<void>("cloud_agent_remove", { root, agentId });

/** Log one machine out, leaving the agent and its other machines alone. */
export const cloudAgentRevokeMachine = (root: string, agentId: string, tokenId: string) =>
  invoke<void>("cloud_agent_revoke_machine", { root, agentId, tokenId });

/** Ask the domain's worker what it is again ("Check again" after an update);
 *  the fresh version arrives in the next status. */
export const cloudCheckWorker = (root: string) => invoke<void>("cloud_check_worker", { root });

/** Bind a fresh domain to `root` and upload everything; resolves to the workspace id. */
export const cloudConnect = (root: string, endpoint: string, token: string, name: string) =>
  invoke<string>("cloud_connect", { root, endpoint, token, name });

/** Download a domain's workspace into `~/Doklin/<name>` — no folder is asked
 *  for — and start syncing it; resolves to the new folder. */
export const cloudJoin = (endpoint: string, token: string) =>
  invoke<string>("cloud_join", { endpoint, token });

/** Adopt a folder carrying the domain's marker in place; resolves to the workspace id. */
export const cloudResume = (root: string, endpoint: string, token: string) =>
  invoke<string>("cloud_resume", { root, endpoint, token });

export const cloudDisconnect = (root: string) => invoke<void>("cloud_disconnect", { root });
export const cloudSyncNow = (root: string) => invoke<void>("cloud_sync_now", { root });
export const cloudPause = (root: string, paused: boolean) => invoke<void>("cloud_pause", { root, paused });
export const cloudConfirmDeletes = (root: string) => invoke<void>("cloud_confirm_deletes", { root });

/** Which document this window is editing (absolute path), or none — what
 *  presence reports, and the document this Mac claims the lease on. */
export const cloudSetActivity = (path: string | null) => invoke<void>("cloud_set_activity", { path });

/** *Take over* a document another Mac holds (absolute path): the engine claims
 *  it on its next beat, and the Mac it is taken from goes view-only on its
 *  next poll. The banner clears when the status says the lease moved. */
export const cloudTakeOver = (root: string, path: string) => invoke<void>("cloud_take_over", { root, path });

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

/** Make a restricted folder holding you and `members` (member ids). With
 *  `from` — a folder in the workspace, absolute — that folder becomes it and
 *  leaves the Mac of everyone not chosen. Resolves to the folder as the
 *  status lists it: `path` is where it is on this Mac. */
export const cloudSpaceCreate = (root: string, name: string, members: string[], from: string | null = null) =>
  invoke<CloudSpace>("cloud_space_create", { root, name, members, from });

/** Add a person to a restricted folder (`add`), or take one out — yourself
 *  included, which is leaving it. The last person cannot be taken out. */
export const cloudSpaceMember = (root: string, id: string, memberId: string, add: boolean) =>
  invoke<void>("cloud_space_member", { root, id, memberId, add });

/** Delete a restricted folder for everyone in it. */
export const cloudSpaceDelete = (root: string, id: string) => invoke<void>("cloud_space_delete", { root, id });

/** One public page as an owner is told of it: what its address tells anyone,
 *  and nothing of the section it was published from. */
export type EveryPage = {
  slug: string;
  kind: PublicKind;
  title: string;
  /** Who published it, as a name. */
  by: string;
  at: number;
  /** In the shared workspace, where everyone here can open its file. */
  shared: boolean;
};

/** Every public address on the domain (an owner's to read). `truncated` when
 *  the domain holds more than one answer carries. */
export const cloudPages = (root: string) =>
  invoke<{ pages: EveryPage[]; truncated: boolean }>("cloud_pages", { root });

/** Take a page down, whoever published it (an owner's to do). */
export const cloudPageTakeDown = (root: string, slug: string) =>
  invoke<void>("cloud_page_take_down", { root, slug });

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
export const onCloudAddressTaken = (cb: (e: CloudAddressTakenEvent) => void) =>
  listen<CloudAddressTakenEvent>("cloud-address-taken", (e) => cb(e.payload));
export const onCloudSpaceLeft = (cb: (e: CloudSpaceLeftEvent) => void) =>
  listen<CloudSpaceLeftEvent>("cloud-space-left", (e) => cb(e.payload));
export const onCloudProgress = (cb: (e: CloudProgressEvent) => void) =>
  listen<CloudProgressEvent>("cloud-progress", (e) => cb(e.payload));
export const onCloudRemoved = (cb: (e: CloudRemovedEvent) => void) =>
  listen<CloudRemovedEvent>("cloud-removed", (e) => cb(e.payload));

/* ---------- Derivations ---------- */

/** The status of the workspace opened at `root`, if it is connected. */
export function cloudForWorkspace(statuses: CloudStatus[], root: string | null): CloudStatus | null {
  if (!root) return null;
  return statuses.find((s) => s.root === root) ?? null;
}

/* ---------- Sections ---------- */

/** Which part of a workspace a path is in, and so who can open it. */
export type Place =
  /** Everyone in the workspace. */
  | { kind: "shared" }
  /** Only you, on every Mac of yours. */
  | { kind: "private"; space: CloudSpace }
  /** The people in that folder. */
  | { kind: "restricted"; space: CloudSpace }
  /** Under a reserved name but in no section: straight under `Restricted`,
   *  or in a folder there that is not a restricted folder yet. It syncs
   *  nowhere until it is moved. */
  | { kind: "nowhere" };

const RESERVED_TOP = new Set(["private", "restricted"]);

/** The section `rel` — workspace-relative — is in. Names are compared
 *  without case, as the disk compares them. */
export function placeOf(cloud: CloudStatus | null, rel: string): Place {
  if (!cloud?.sections) return { kind: "shared" };
  const lower = rel.toLowerCase();
  const space = cloud.spaces.find((s) => {
    const at = s.path.toLowerCase();
    return lower === at || lower.startsWith(`${at}/`);
  });
  if (space) return { kind: space.kind, space };
  return RESERVED_TOP.has(lower.split("/", 1)[0]) ? { kind: "nowhere" } : { kind: "shared" };
}

/** Who gains sight of something moved from one section to another —
 *  "Everyone in Acme", "All 3 people in “Finance”" — or null when nobody
 *  does, which is every move that keeps the audience or narrows it. */
export function widerAudience(cloud: CloudStatus, from: Place, to: Place): string | null {
  if (from.kind === "shared" || to.kind === "nowhere" || to.kind === "private") return null;
  if (to.kind === "shared") return `Everyone in ${cloud.name}`;
  if (from.kind !== "nowhere" && from.space.id === to.space.id) return null;
  const before = from.kind === "nowhere" ? [] : from.space.members;
  const gained = to.space.members.filter((m) => !before.includes(m) && m !== cloud.meId);
  if (gained.length === 0) return null;
  const n = to.space.members.length;
  return `${n === 2 ? "Both people" : `All ${n} people`} in “${to.space.name}”`;
}

/** Whether a role may do `action`, from an answer that states what it may —
 *  the People view's. The one question asked before a button is drawn. */
export function may(who: { can: string[] }, action: CloudAction): boolean {
  return who.can.includes(action);
}

/** Whether this Mac may make a new code for somebody the workspace already
 *  lists. Once anybody has signed in as a person, a code for them is theirs to
 *  make, or the creator's — the domain refuses anyone else's. Until then they
 *  are only invited, and whoever may invite may replace the code. */
export function mayInviteAgain(people: CloudPeople, memberId: string): boolean {
  if (!may(people, "people.invite")) return false;
  const person = people.members.find((m) => m.id === memberId);
  const signedIn = !!person && (person.creator || person.lastSeenAt != null);
  return !signedIn || people.creator || people.me === memberId;
}

/** The same question of a workspace's status, whose `can` is empty until the
 *  domain has answered and from a worker older than roles. Not knowing is not
 *  a refusal: the domain decides either way, so what cannot be known yet is
 *  offered, exactly as it was before there was a table to hide it by. */
export function mayOn(cloud: CloudStatus | null, action: CloudAction): boolean {
  if (!cloud) return false;
  const can = cloud.can ?? [];
  return can.length === 0 || can.includes(action);
}

/** The lease another Mac holds on the document at `absPath`, with the status
 *  of the workspace it is in — or null when nobody else holds it, which is
 *  also the answer for a document in no connected workspace. Paths are
 *  compared lowercased, as the worker keys them (presence.ts `leaseKey`). */
export function leaseFor(
  statuses: CloudStatus[],
  absPath: string | null,
): { status: CloudStatus; lease: LeaseHolder } | null {
  if (!absPath) return null;
  for (const status of statuses) {
    const prefix = status.root.endsWith("/") ? status.root : `${status.root}/`;
    if (!absPath.startsWith(prefix)) continue;
    const key = absPath.slice(prefix.length).toLowerCase();
    const lease = (status.leases ?? []).find((l) => l.path === key);
    if (lease) return { status, lease };
  }
  return null;
}

/** What the view-only banner says about a lease. */
export function leaseLine(lease: LeaseHolder): string {
  return lease.own ? `Open on your other Mac, ${lease.name} — view only` : `${lease.name} is editing — view only`;
}

/** Bring what has just opened at the top of a list into view: the row that
 *  asked for it may be a screen further down. After the frame, so that it is
 *  there to scroll to. */
export function revealSoon(el: { current: HTMLElement | null }): void {
  requestAnimationFrame(() => el.current?.scrollIntoView({ block: "nearest" }));
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
      return "this Mac's token isn't accepted";
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

/* ---------- Live status, in one vocabulary ----------
   Green is live or in sync, the accent is working, amber is waiting (on you,
   the network or the worker), red is broken. Every state pairs its colour
   with words, and only a state in motion animates. */

export type SyncTone = "live" | "busy" | "quiet" | "warn" | "error";

/** The workspace's sync in a few words, for the sidebar footer:
 *  "Synced", "Syncing…", "2 deletions to confirm". The full line
 *  (describeCloud) is the tooltip. */
export function syncWords(s: CloudStatus): { tone: SyncTone; text: string } {
  switch (s.phase) {
    case "idle":
      return { tone: "live", text: s.lastSyncMs == null ? "Not synced yet" : "Synced" };
    case "syncing":
      return { tone: "busy", text: "Syncing…" };
    case "offline":
      return { tone: "quiet", text: "Offline" };
    case "paused":
      return { tone: "quiet", text: "Sync paused" };
    case "pending-deletes":
      return {
        tone: "warn",
        text: `${s.pendingDeletes} deletion${s.pendingDeletes === 1 ? "" : "s"} to confirm`,
      };
    case "worker-outdated":
      return { tone: "warn", text: "Worker update needed" };
    case "revoked":
      return { tone: "error", text: "Not signed in" };
    case "error":
      return { tone: "error", text: "Can't sync" };
  }
}

/** Where a note's own page stands — the Live chip's five states.
 *  `publish`: no page of its own. `live`: up to date. `updating`: edits
 *  from here are still on their way. `stale`: sync has stopped short of the
 *  page (offline, paused, held, an old worker, an error), so it keeps what
 *  it had. `offline`: the page itself is down (this Mac's token isn't
 *  accepted, or the note is not in the sync, so the address answers Not
 *  found). */
export type PageState = "publish" | "live" | "updating" | "stale" | "offline";

export function pageState(s: CloudStatus | null, page: PublicPage | null, pending: boolean): PageState {
  if (!s || !page) return "publish";
  if (s.phase === "revoked" || !page.alive) return "offline";
  if (s.phase !== "idle" && s.phase !== "syncing") return "stale";
  return pending ? "updating" : "live";
}

/** Why a page is in the state it is, in a sentence — the popover's line and
 *  the chip's tooltip. Null for a page that is simply live. */
export function pageStateLine(s: CloudStatus, state: PageState, now = Date.now()): string | null {
  switch (state) {
    case "publish":
    case "live":
      return null;
    case "updating":
      return "Your latest changes appear once synced.";
    case "offline":
      return s.phase === "revoked"
        ? `${s.domain} doesn't accept this Mac's token, so it can't update the page.`
        : "The page answers Not found until this note is synced.";
    case "stale":
      switch (s.phase) {
        case "offline":
          return `Offline, so the page keeps what it had (${s.lastSyncMs == null ? "not synced yet" : `synced ${timeAgo(s.lastSyncMs, now)}`}).`;
        case "paused":
          return "Sync is paused, so the page keeps what it had.";
        case "pending-deletes":
          return "Sync is holding a deletion for your go, and the page waits with it.";
        case "worker-outdated":
          return `${s.domain} needs a worker update before the page changes again.`;
        default:
          return `Sync stopped: ${s.error ?? "an error"}.`;
      }
  }
}

/** What the Cloud panel's *Version history* line says: how much of this
 *  folder's history the domain is holding, or that its worker is too old to
 *  hold any. History is never gated on the
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
