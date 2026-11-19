// The frontend's half of the cloud contract: the types the engine's status
// event and commands carry, and what the UI reads out of them. The commands
// and events themselves are `Cloud` in src/backend.ts. No `fetch` anywhere:
// the Rust engine is the only code that holds a token or talks to a domain.
// Mirrored by engine/src/cloud/status.rs and the iPhone's Payloads.swift —
// change all three.

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
  | "pending-adds"
  | "revoked"
  | "worker-outdated"
  | "limited"
  | "error";

/** The Cloudflare plan the superadmin says the account is on — what every
 *  limit is derived from (cloud-worker/src/limits.ts). */
export type CloudPlan = "free" | "paid";

/** How this Mac’s requests stand against the day’s limits. Mirrors `UsageStatus` in
 *  status.rs and Payloads.swift — change all three. */
export type CloudUsage = {
  /** `bulk-waits`: big changes wait for the next UTC day while edits go on.
   *  `slow`: everything goes out about once a minute until then. */
  mode: "normal" | "bulk-waits" | "slow";
  /** Whose spend set the mode: this Mac's own, or everyone's together. */
  cause: "device" | "fleet" | null;
  /** This Mac's requests to the domain today (UTC day). */
  today: number;
  /** Everyone's, roughly, as the domain last summed it; null when it could not. */
  fleetToday: number | null;
  /** The account's daily requests; null on Workers Paid. */
  cap: number | null;
  /** Null until the domain has said. */
  plan: CloudPlan | null;
  /** The next 00:00 UTC (ms), set when the mode is not `normal` or the phase
   *  is `limited`. */
  resumesAt: number | null;
  /** Changes held back: uploads not sent and downloads owed. */
  waiting: number;
  /** This Mac's own allowance is what holds them, and it was not lifted today. */
  liftable: boolean;
  /** This Mac's person lifted the wait for today. */
  lifted: boolean;
};

export type PublicKind = "file" | "dir";

/** One published page, as the engine believes it (the manifest plus this
 *  Mac's not-yet-synced edits). */
export type PublicPage = {
  slug: string;
  kind: PublicKind;
  /** Workspace-relative: `Library` for the whole shared section. */
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
  /** Whose Mac it is. */
  memberId: string;
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
  memberId: string;
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
 *  up there in total. Mirrored by engine/src/cloud/status.rs. */
export type VersionsMirror = {
  mirrored: number;
  cloud: number;
  lastMirrorMs: number | null;
  /** How far back the bucket keeps, null for forever — the second of the two
   *  horizons. Meaningful once `lastMirrorMs` is set; before that no pass has
   *  read the cloud index. */
  horizonDays: number | null;
};

/** The role a person holds (cloud-worker/src/roles.ts). */
export type CloudRole = "superadmin" | "owner" | "member";

/** What a role may do on a workspace, in the words of the worker's one table
 *  (cloud-worker/src/roles.ts) — the domain says which of these this Mac
 *  holds, and every surface hides the rest by it. */
export type CloudAction =
  | "work"
  | "people.see"
  | "people.invite"
  | "people.recover"
  | "people.remove"
  | "people.roles"
  | "agents.own"
  | "agents.manage"
  | "devices.own"
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
  /** New documents the many-new-documents valve is holding. */
  pendingAdds: number;
  /** Today's requests and what the limits are doing to sync. */
  usage: CloudUsage;
  /** Who this Mac signs work with here, in words: the person the domain
   *  says it is. What a `by` is compared against to know whether somebody
   *  *else* did a thing. */
  me: string;
  /** The same person as the domain's id for them — which of a folder's
   *  `members` is you. Null until the domain has said. */
  meId: string | null;
  /** What this Mac's credential may do here, as the domain last said. Empty
   *  until it has answered. Ask it with `mayOn`. */
  can: string[];
  /** The workspace's superadmin, by name — whom to ask for what only they
   *  can do. Null until the domain has said. */
  superadmin: string | null;
  /** What the domain's /api/meta last reported; null until it answered. */
  workerVersion: number | null;
  /** The version store's mirror. */
  versions: VersionsMirror;
  public: PublicPage[];
  presence: PresenceDevice[];
  /** The documents another Mac holds. Empty when the engine cannot hear the
   *  domain: a lock nobody can confirm is no lock. */
  leases: LeaseHolder[];
  /** This person's sections besides Library — their Private and the
   *  restricted folders they are in — that have a folder on this Mac. */
  spaces: CloudSpace[];
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
  workspace: CloudWorkspaceRecord | null;
};

/** The hidden `.doklin/cloud.json` a connected folder carries — secret-free.
 *  `layout` is `"library"` once the folder holds its sections side by side,
 *  the shared one in `Library/`; absent before it has moved. */
export type CloudMarker = { domain: string; wsId: string; layout?: "library" };

/** `cloudHeld`: the copy of a domain's workspace this Mac already has. One
 *  per domain, so a code or a key traded for a second would buy nothing.
 *  `syncs` is false when that copy can't sync any more — the domain no
 *  longer takes this Mac's sign-in, or its folder is gone. */
export type CloudHeld = { root: string; name: string; domain: string; syncs: boolean };

/** A fresh code for another device of this person's own, and the line that
 *  carries it — the line an invite is. Shown once. */
export type CloudDeviceCode = { code: string; blob: string; expiresAt: number };

/** `cloudLink`: what *Copy link* puts on the clipboard — a link that opens
 *  the file in Doklin for anybody who can see it — and who that is, as a
 *  sentence. Mirrors `PageLinkCopy` (engine/src/cloud/status.rs ⇄
 *  Payloads.swift): change all three. */
export type CloudPageLink = { url: string; who: string };

/** `cloudRecent`: a workspace's documents by when their content last
 *  changed, newest first, across its sections, with the directory their
 *  `by`s are read with — what the iPhone's Home lists. Mirrors `RecentFiles`
 *  (engine/src/cloud/status.rs ⇄ Payloads.swift): change all three. */
export type CloudRecentFiles = {
  files: CloudRecentFile[];
  /** People, then agents, each agent with whose it is (`person`). */
  people: { id: string; name: string; person: string | null }[];
  /** Who this device works as, by member id; null until the domain has said. */
  me: string | null;
};

export type CloudRecentFile = {
  /** Workspace-relative. */
  path: string;
  /** Null for a file made here that no manifest carries yet. */
  fileId: string | null;
  /** The manifest's content address; null for a change not synced yet. */
  hash: string | null;
  /** When its content last changed, ms. A move is not a change. */
  mtime: number;
  /** A member id or an agent's. */
  by: string;
  /** 1: made and never changed (or moved in from another section). 0: not synced yet. */
  rev: number;
  /** The space it is in; null for Library. */
  section: string | null;
};

/** The two halves of an invite found in one paste — either may be missing,
 *  and the redeem screen fills what it finds. */
export type CloudPastedInvite = { endpoint: string | null; code: string | null };

/** What a redeemed code or a traded key answers with: this Mac's own
 *  credential, and who the domain says the person holding it is. The token
 *  goes straight into `cloudJoin`, `cloudConnect` or `cloudResume`. */
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
  /** The person's role, carried by every device they are signed in on. An
   *  owner makes another by changing it. The one superadmin — whoever last
   *  recovered the workspace with its Cloudflare account — nobody changes or
   *  removes. */
  role: CloudRole;
  createdAt: number;
  /** When a Mac of theirs last beat, to the hour — and, before any has, when
   *  they first traded a code in. Null means nobody has ever signed in as
   *  them: they are invited, and that is all. */
  lastSeenAt: number | null;
  /** How many devices this person is signed in on. */
  devices: number;
};

/** One signed-in device: a Mac, an iPhone. */
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
  role: CloudRole;
  /** Which of `members` is you. */
  me: string;
  /** What that role may do — the buttons this view offers. */
  can: string[];
  /** This Mac's own device id, so the list can mark which Mac is this one. */
  deviceId: string;
  /** Which of `devices` is the credential this Mac syncs with. Never offered
   *  for signing out. */
  tokenId: string;
  /** Everyone on the workspace. */
  members: CloudMember[];
  /** Codes nobody has used yet. Empty for whoever may not invite. */
  invites: CloudInvite[];
  /** The signed-in devices: this person's own, and for an owner everybody's. */
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
  /** Whose it is: one of the workspace's people. */
  memberId: string;
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
/** The many-new-documents valve is holding `count` new documents. `folders`
 *  are workspace-relative (`Library` for the files straight in it), most
 *  first, at most 5. */
export type CloudPendingAddsEvent = { root: string; count: number; folders: { path: string; count: number }[] };
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

/** One public page as an owner is told of it: what its address tells anyone,
 *  and nothing of the section it was published from. */
export type EveryPage = {
  slug: string;
  kind: PublicKind;
  title: string;
  /** Who published it, as a name. */
  by: string;
  at: number;
  /** In Library, where everyone here can open its file. */
  shared: boolean;
};

/* ---------- Derivations ---------- */

/** The status of the workspace opened at `root`, if it is connected. */
export function cloudForWorkspace(statuses: CloudStatus[], root: string | null): CloudStatus | null {
  if (!root) return null;
  return statuses.find((s) => s.root === root) ?? null;
}

/* ---------- Sections ---------- */

/** Which part of a workspace a path is in, and so who can open it. */
export type Place =
  /** Everyone in the workspace: Library. */
  | { kind: "shared" }
  /** Only you, on every Mac of yours. */
  | { kind: "private"; space: CloudSpace }
  /** The people in that folder. */
  | { kind: "restricted"; space: CloudSpace }
  /** In no section, so it stays on this Mac and syncs nowhere until it is
   *  moved: the workspace's folder itself and anything else at its top,
   *  straight under `Restricted` or in a folder there that is not a
   *  restricted folder yet, and a folder with a section's name at the top of
   *  Library. */
  | { kind: "nowhere" };

/** The shared section's folder, at the top of a connected workspace beside
 *  `Private` and `Restricted`. Said in four places: this, `LIBRARY_DIR` in
 *  engine/src/cloud/space.rs, `LIBRARY_FOLDER` in
 *  cloud-worker/src/layout.ts, and `TreeModel.libraryFolder` in the
 *  iPhone's Tree.swift (ios/DoklinKit) — change all four. */
export const LIBRARY_DIR = "Library";

/** The names a section's folder has at the top of a connected workspace,
 *  compared without case — and so the names no folder at the top of Library
 *  has: the shared section holds nothing under them (`RESERVED_DIRS`,
 *  engine/src/cloud/space.rs). */
const RESERVED_TOP = new Set([LIBRARY_DIR.toLowerCase(), "private", "restricted"]);

/** Whether `name` is a section's own, whatever its case. */
export const isSectionName = (name: string): boolean => RESERVED_TOP.has(name.toLowerCase());

/** The section `rel` — workspace-relative — is in. Names are compared
 *  without case, as the disk compares them. */
export function placeOf(cloud: CloudStatus | null, rel: string): Place {
  if (!cloud) return { kind: "shared" };
  const lower = rel.toLowerCase();
  const space = cloud.spaces.find((s) => {
    const at = s.path.toLowerCase();
    return lower === at || lower.startsWith(`${at}/`);
  });
  if (space) return { kind: space.kind, space };
  const [top, inLibrary] = lower.split("/", 2);
  if (top !== LIBRARY_DIR.toLowerCase()) return { kind: "nowhere" };
  // Library never holds anything under a section's name at its own top.
  return inLibrary !== undefined && RESERVED_TOP.has(inLibrary) ? { kind: "nowhere" } : { kind: "shared" };
}

/** Where a path inside a workspace's folder (`rel`, relative to it) is once
 *  the folder has moved into the Library layout: a path under a section's
 *  name or a hidden entry stays where it is, and anything else was the shared
 *  section's and is in Library now. The rule the engine's move follows
 *  (`moved_rel`, engine/src/cloud/layout.rs; `Sections.moved` on the
 *  iPhone: change all three), for the one-time
 *  stored-data migrations of the paths kept outside it. */
export function toLibraryLayout(rel: string): string {
  const top = rel.split("/", 1)[0];
  if (top === "" || top.startsWith(".") || RESERVED_TOP.has(top.toLowerCase())) return rel;
  return `${LIBRARY_DIR}/${rel}`;
}

/** Library's folder in the connected workspace at `root`: where the shared
 *  section's files and its version history are. */
export const libraryDirOf = (root: string): string => `${root}/${LIBRARY_DIR}`;

/** Who gains sight of something moved from one section to another —
 *  "Everyone in Acme", "All 3 people in “Finance”" — or null when nobody
 *  does, which is every move that keeps the audience or narrows it. The
 *  iPhone asks the same (`Sections.wider`, ios/DoklinKit) — change both. */
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
 *  make, or the superadmin's (`people.recover`) — the domain refuses anyone
 *  else's. Until then they are only invited, and whoever may invite may
 *  replace the code. The worker's `createInvite` decides, and the iPhone asks
 *  the same (`mayInviteAgain`, ios/DoklinKit) — change all three. */
export function mayInviteAgain(people: CloudPeople, memberId: string): boolean {
  if (!may(people, "people.invite")) return false;
  const person = people.members.find((m) => m.id === memberId);
  const signedIn = !!person && (person.role === "superadmin" || person.lastSeenAt != null);
  return !signedIn || may(people, "people.recover") || people.me === memberId;
}

/** The same question of a workspace's status, whose `can` is empty until the
 *  domain has answered: a control shows once the domain says it may. */
export function mayOn(cloud: CloudStatus | null, action: CloudAction): boolean {
  return !!cloud && cloud.can.includes(action);
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

/** What the view-only banner says about a lease. The holder may be a Mac, an
 *  iPhone or a browser. The iPhone says the same (ios/Doklin/DocumentView.swift)
 *  — change both. */
export function leaseLine(lease: LeaseHolder): string {
  return lease.own ? `Open on your other device, ${lease.name} — view only` : `${lease.name} is editing — view only`;
}

/** Bring what has just opened at the top of a list into view: the row that
 *  asked for it may be a screen further down. After the frame, so that it is
 *  there to scroll to. */
export function revealSoon(el: { current: HTMLElement | null }): void {
  requestAnimationFrame(() => el.current?.scrollIntoView({ block: "nearest" }));
}

/** "just now", "2 min ago", "3 h ago", "12 d ago". The iPhone writes times
 *  the same (`Clock`, ios/DoklinKit) — change both, with `timeUntil`. */
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
 *  What a pending invite's expiry is written with. The iPhone writes it the
 *  same (`Clock.left`, ios/DoklinKit) — change both. */
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

/** A time within the next day as this Mac's clock shows it: "05:30", "5:30 AM". */
export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { timeStyle: "short" });
}

/** "1 change", "1,240 changes". */
const counted = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/* ---------- The day's limits ----------
   The words are the surfaces' own (the engine says only the mode). The
   iPhone says the same — the mode lines, the plan's name, the
   many-new-documents question — in
   ios/DoklinKit/Sources/DoklinKit/Models/Limits.swift: change both. Its sync
   line spans the screen, so it carries the whole words (`waitWords`); only
   the Mac's footer, a corner of the sidebar, says them short (`heldWords`). */

/** What the day's limits are doing to sync right now. `waits`: big changes
 *  are held until the next UTC day, by this Mac's spend or everyone's.
 *  `sending`: this Mac's person lifted the wait and they are on their way.
 *  `slow`: everything goes out about once a minute until then. */
export type UsageState =
  | { kind: "normal" }
  | { kind: "waits"; cause: "device" | "fleet"; waiting: number; until: string | null }
  | { kind: "sending"; waiting: number }
  | { kind: "slow"; until: string | null };

export function usageState(u: CloudUsage): UsageState {
  const until = u.resumesAt == null ? null : clockTime(u.resumesAt);
  if (u.mode === "slow") return { kind: "slow", until };
  const cause = u.cause ?? "device";
  // A lift lets go of this Mac's own wait, never everyone's.
  if (u.mode === "bulk-waits" && !(u.lifted && cause === "device")) {
    return { kind: "waits", cause, waiting: u.waiting, until };
  }
  if (u.lifted && u.waiting > 0) return { kind: "sending", waiting: u.waiting };
  return { kind: "normal" };
}

/** "412 changes wait until 05:30". */
export function waitWords(waiting: number, until: string | null): string {
  return `${counted(waiting, "change waits", "changes wait")}${until ? ` until ${until}` : ""}`;
}

/** The footer's "412 held until 05:30": the sidebar's default width cuts
 *  `waitWords` off before its time. */
export function heldWords(waiting: number, until: string | null): string {
  return `${waiting.toLocaleString()} held${until ? ` until ${until}` : ""}`;
}

/** "Sending 412 changes…". */
export const sendingWords = (waiting: number): string => `Sending ${counted(waiting, "change", "changes")}…`;

/** The footer's words for a mode that changes what sync does, in place of
 *  "Synced" and "Syncing…" — or null when the day's limits change nothing
 *  anybody would notice. `whole` is the same said in full, for its tooltip. */
export function usageWords(u: CloudUsage): { tone: SyncTone; text: string; whole: string } | null {
  const state = usageState(u);
  switch (state.kind) {
    case "waits":
      return state.waiting > 0
        ? { tone: "warn", text: heldWords(state.waiting, state.until), whole: waitWords(state.waiting, state.until) }
        : null;
    case "sending": {
      const text = sendingWords(state.waiting);
      return { tone: "busy", text, whole: text };
    }
    case "slow":
      return { tone: "warn", text: "Sync is slower today", whole: "Sync is slower today" };
    case "normal":
      return null;
  }
}

/** The Cloud panel's quiet line: "This Mac today: 1,240 requests · everyone
 *  ≈ 8,900 of 100,000". A number the domain could not give is left out.
 *  `device` is what this one is called (`Backend.device`). */
export function usageLine(u: CloudUsage, device: string): string {
  const mine = `This ${device} today: ${counted(u.today, "request", "requests")}`;
  if (u.fleetToday == null) return mine;
  return `${mine} · everyone ≈ ${u.fleetToday.toLocaleString()}${u.cap == null ? "" : ` of ${u.cap.toLocaleString()}`}`;
}

/** The plan in words, as Cloudflare names it. */
export const planName = (plan: CloudPlan): string => (plan === "paid" ? "Workers Paid" : "Free");

/** The many-new-documents question: "212 new documents appeared in
 *  Library/Projects. Sync them?" — one folder by its path, several by how
 *  many, and no place at all when only the count is known (a window that
 *  opened after the event). The event lists at most 5 folders, so counts
 *  that fall short mean more. */
export function addsQuestion(count: number, folders: { path: string; count: number }[] | null): string {
  let where = "";
  if (folders && folders.length === 1) {
    where = ` in ${folders[0].path}`;
  } else if (folders && folders.length > 1) {
    const listed = folders.reduce((n, f) => n + f.count, 0);
    where = listed >= count ? ` in ${folders.length} folders` : ` in more than ${folders.length} folders`;
  }
  return `${counted(count, "new document", "new documents")} appeared${where}. Sync ${count === 1 ? "it" : "them"}?`;
}

/** When the next 00:00 UTC is on this Mac's clock, as `limited` waits for it. */
const resumesWords = (s: CloudStatus): string =>
  s.usage.resumesAt == null ? " for today" : ` until ${clockTime(s.usage.resumesAt)}`;

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
    case "pending-adds":
      return `${counted(s.pendingAdds, "new document", "new documents")} waiting for your go`;
    case "revoked":
      return "this Mac's token isn't accepted";
    case "worker-outdated":
      return "waiting on a worker update";
    case "limited":
      return `Cloudflare’s requests are used up${resumesWords(s)}`;
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
 *  "Synced", "Syncing…", "2 deletions to confirm", "412 changes wait until
 *  05:30". The full line (describeCloud) is the tooltip. */
export function syncWords(s: CloudStatus): { tone: SyncTone; text: string } {
  switch (s.phase) {
    case "idle":
      return usageWords(s.usage) ?? { tone: "live", text: s.lastSyncMs == null ? "Not synced yet" : "Synced" };
    case "syncing":
      return usageWords(s.usage) ?? { tone: "busy", text: "Syncing…" };
    case "offline":
      return { tone: "quiet", text: "Offline" };
    case "paused":
      return { tone: "quiet", text: "Sync paused" };
    case "pending-deletes":
      return {
        tone: "warn",
        text: `${s.pendingDeletes} deletion${s.pendingDeletes === 1 ? "" : "s"} to confirm`,
      };
    // The iPhone's words are in Limits.swift — change both.
    case "pending-adds":
      return {
        tone: "warn",
        text: `${counted(s.pendingAdds, "new document", "new documents")} — Sync ${s.pendingAdds === 1 ? "it" : "them"}?`,
      };
    case "worker-outdated":
      return { tone: "warn", text: "Worker update needed" };
    case "limited":
      return { tone: "warn", text: `Cloudflare’s requests are used up${resumesWords(s)}` };
    case "revoked":
      return { tone: "error", text: "Not signed in" };
    case "error":
      return { tone: "error", text: "Can't sync" };
  }
}

/** Where a note's own page stands — the Live chip's five states.
 *  `publish`: no page of its own. `live`: up to date. `updating`: edits
 *  from here are still on their way. `stale`: sync has stopped short of the
 *  page (offline, paused, a held deletion, a worker that needs updating,
 *  today's requests used up, an error), so it keeps what it had. Held new
 *  documents stop nothing else: edits still go out. `offline`: the page
 *  itself is down (this Mac's token isn't accepted, or the note is not in
 *  the sync, so the address answers Not found). The iPhone decides the same
 *  (Publishing.swift) — change both. */
export type PageState = "publish" | "live" | "updating" | "stale" | "offline";

export function pageState(s: CloudStatus | null, page: PublicPage | null, pending: boolean): PageState {
  if (!s || !page) return "publish";
  if (s.phase === "revoked" || !page.alive) return "offline";
  if (s.phase !== "idle" && s.phase !== "syncing" && s.phase !== "pending-adds") return "stale";
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
        case "limited":
          return "Today’s Cloudflare requests are used up, so the page keeps what it had.";
        default:
          return `Sync stopped: ${s.error ?? "an error"}.`;
      }
  }
}

/** What the Cloud panel's *Version history* line says: how much of this
 *  folder's history the domain is holding. History is never gated on the
 *  cloud, so a domain that holds none yet is a note, not a warning. */
export function versionsLine(s: CloudStatus, now = Date.now()): string {
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

/** Where the workspace opens in a browser, or null while the domain's worker
 *  is not known to be the one this app was built for, which serves it. */
export function browserAddress(s: CloudStatus): string | null {
  return s.workerVersion == null || workerBehind(s) ? null : `${s.endpoint}/app`;
}

/** What an invite's line is sent as: the line, then where the workspace opens
 *  in a browser for somebody with no Doklin app. The sentence comes after
 *  the line because a paste is read for the first address in it
 *  (`parse_pasted`, engine/src/cloud/invite.rs). */
export function inviteToSend(line: string, s: CloudStatus): string {
  const at = browserAddress(s);
  return at === null ? line : `${line}\nNo Doklin app? Open ${at} and paste the line above.`;
}

/** Whether the gear's badge should light for the cloud: some connected
 *  workspace's worker is behind. */
export const cloudNeedsAttention = (statuses: CloudStatus[]): boolean => statuses.some(workerBehind);

/* ---------- Publishing ---------- */

/** A slug's grammar — the same rule the engine, the worker and the iPhone
 *  (ios/DoklinKit/Sources/DoklinKit/Models/Publishing.swift) check; change all. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
/** Slugs the worker's own routes speak for; `app` is the browser version's.
 *  The engine's list (`RESERVED_SLUGS`, engine/src/cloud/manifest.rs), the
 *  worker's (cloud-worker/src/layout.ts) and the iPhone's (Publishing.swift)
 *  are this one: change all four. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "api",
  "__web",
  "raw",
  "og.png",
  "robots.txt",
  "favicon.ico",
  "apple-touch-icon.png",
  "join",
  "app",
]);

/** Why a typed slug can't be one, or null when it can. The engine says the same
 *  things; the iPhone checks with a port (Publishing.swift `slugProblem`) — change both. */
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
  const inner = rel.slice(dir.path.length + 1);
  const shown = inner.replace(MD_EXT_RE, "");
  return `${s.endpoint}/${dir.slug}/${shown.split("/").map(encodeURIComponent).join("/")}`;
}

const covers = (dir: PublicPage, rel: string): boolean => dir.kind === "dir" && rel.startsWith(`${dir.path}/`);

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

/** The absolute paths with a page of their own in this status (none when the
 *  workspace isn't connected). */
export function livePathsOf(s: CloudStatus | null): Set<string> {
  const out = new Set<string>();
  if (!s) return out;
  for (const rel of publishedByPath(s).keys()) out.add(`${s.root}/${rel}`);
  return out;
}

/** A slug to suggest for a name: lowercase, dashes for anything else, never shorter than the grammar allows.
 *  The iPhone suggests the same (Publishing.swift `suggestSlug`) — change both. */
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
