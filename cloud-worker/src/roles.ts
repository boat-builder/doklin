// Who may do what.
//
// One table, one function. Every route that is not open to everybody asks
// `can(role, action)` and nothing else decides — so tightening or loosening
// what a role may do is moving it in or out of one row below, and the app
// hides what you cannot do from the same table (`/api/meta` answers the
// caller's row of it as `you.can`).
//
// Three roles a person can hold, and they are data. `owner` and `member` are
// `members.role`, read off the row a token resolves to. `superadmin` is the
// one person the `superadmin` table names — whoever last proved they control
// the Cloudflare account, by trading the domain's key (members.ts) — and it
// is theirs on every device they sign in on: no device is special. Their row
// keeps `owner`, so the role moving to somebody else leaves them an owner.
// An agent holds no row of this table at all: it is answered on the document
// API and nowhere else, within the permissions on its own row (agents.ts).

export type PersonRole = "superadmin" | "owner" | "member";

export type Action =
  /** Read, write, move and delete in the shared workspace; its version
   *  history; publishing. The sync API and the poll. */
  | "work"
  /** See who is in the workspace. */
  | "people.see"
  /** Invite people: make, list and withdraw invite codes. */
  | "people.invite"
  /** Make a new code for somebody who has signed in here before — let them
   *  back in after they lost every device. A code is a way in as that
   *  person, so this is the superadmin's: they control the account the
   *  workspace is stored on, and can read all of it anyway. */
  | "people.recover"
  /** Remove a person, or sign one of their devices out. */
  | "people.remove"
  /** Make someone an owner, or a member again. */
  | "people.roles"
  /** Connect agents of one's own: add them, change them, log them in and
   *  remove them. */
  | "agents.own"
  /** See everybody's agents, and remove any of them. */
  | "agents.manage"
  /** Add devices of one's own — another Mac, an iPhone — see them, and sign
   *  one out. Signing out somebody else's is `people.remove`. */
  | "devices.own"
  /** See every public address on the domain, and take any page down. */
  | "pages.manage"
  /** Bind the domain to a workspace, update its worker, and erase everything
   *  on it. The update is the app's card, not a route: it runs on the
   *  Cloudflare account, which is the superadmin's. */
  | "workspace.manage";

const TABLE: Readonly<Record<Action, readonly PersonRole[]>> = {
  work: ["superadmin", "owner", "member"],
  "people.see": ["superadmin", "owner", "member"],
  "people.invite": ["superadmin", "owner"],
  "people.recover": ["superadmin"],
  "people.remove": ["superadmin", "owner"],
  "people.roles": ["superadmin", "owner"],
  "agents.own": ["superadmin", "owner", "member"],
  "agents.manage": ["superadmin", "owner"],
  "devices.own": ["superadmin", "owner", "member"],
  "pages.manage": ["superadmin", "owner"],
  "workspace.manage": ["superadmin"],
};

/** Whether somebody holding `role` may do `action`. Any role that is not a
 *  person's — an agent's — may do nothing here. */
export function can(role: string, action: Action): boolean {
  return (TABLE[action] as readonly string[]).includes(role);
}

/** Everything `role` may do — what `/api/meta` tells the app, so it can hide
 *  the rest. */
export function allowed(role: string): Action[] {
  return (Object.keys(TABLE) as Action[]).filter((action) => can(role, action));
}

/** The refusal for an action `can` said no to, naming who may. */
export function refusal(action: Action): string {
  return TABLE[action].includes("owner") ? "only an owner can do that" : "only the workspace's superadmin can do that";
}
