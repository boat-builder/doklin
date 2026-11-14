// Who may do what.
//
// One table, one function. Every route that is not open to everybody asks
// `can(role, action)` and nothing else decides — so tightening or loosening
// what a member may do is moving a role in or out of one row below, and the
// app hides what you cannot do from the same table (`/api/meta` answers the
// caller's row of it as `you.can`).
//
// Two roles a person can hold, and they are data: `members.role`, read off
// the row a token resolves to. The domain's env secret is an owner too — the
// creator's, matched with no row read (auth.ts). An agent holds no row of
// this table at all: it is answered on the document API and nowhere else,
// within the permissions on its own row (agents.ts).

export type PersonRole = "owner" | "member";

export type Action =
  /** Read, write, move and delete in the shared workspace; its version
   *  history; publishing. The sync API and the poll. */
  | "work"
  /** See who is in the workspace. */
  | "people.see"
  /** Invite people: make, list and withdraw invite codes. */
  | "people.invite"
  /** Remove a person, or sign one of their Macs out. */
  | "people.remove"
  /** Make someone an owner, or a member again. */
  | "people.roles"
  /** Connect agents of one's own: add them, change them, log them in and
   *  remove them. */
  | "agents.own"
  /** See everybody's agents, and remove any of them. */
  | "agents.manage"
  /** See every public address on the domain, and take any page down. */
  | "pages.manage"
  /** Bind the domain to a workspace, and erase everything on it. */
  | "workspace.manage";

const TABLE: Readonly<Record<Action, readonly PersonRole[]>> = {
  work: ["owner", "member"],
  "people.see": ["owner", "member"],
  "people.invite": ["owner"],
  "people.remove": ["owner"],
  "people.roles": ["owner"],
  "agents.own": ["owner", "member"],
  "agents.manage": ["owner"],
  "pages.manage": ["owner"],
  "workspace.manage": ["owner"],
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
