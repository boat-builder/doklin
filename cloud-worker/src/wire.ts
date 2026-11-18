// What the worker's answers carry, as types and nothing else: this file
// imports nothing of the runtime, so the browser version (src/web/) reads the
// worker's answers with the very types the worker writes them with. The
// manifest's own types are manifest.ts's, which is as free of the runtime.
// The engine and the iPhone read the same answers with their own
// (engine/src/cloud/remote.rs, ios/DoklinKit): change all of them together.

import type { Action, PersonRole } from "./roles";

/** The binding: one domain, one workspace (`workspace.json`). */
export type WorkspaceRecord = {
  id: string;
  name: string;
  createdAt: string;
  createdBy: { deviceId: string | null; deviceName: string };
};

/* ---------- Sections ---------- */

export type SpaceKind = "restricted" | "private";

export type Space = {
  id: string;
  kind: SpaceKind;
  name: string;
  /** Who made it — what tells two folders of one name apart. */
  by: string;
  createdAt: number;
  /** Its manifest's etag as of the worker's last write there (`noteEtag`). */
  etag: string;
  /** Everyone in it, by member id. */
  members: string[];
};

/* ---------- The day's limits ---------- */

export type Plan = "free" | "paid";

export type Limits = {
  plan: Plan;
  /** The account's requests a day; null on a plan with no such limit. */
  cap: number | null;
  /** How fast a device's bulk lane refills, in requests a second. */
  bulkPerSecond: number;
  /** A device's requests today — all of them, not only bulk — past which its bulk waits for tomorrow. */
  deviceBulk: number | null;
  /** A device's requests today past which it goes slow. */
  deviceCeiling: number;
  /** Everyone's requests today past which every device's bulk waits. */
  fleetBulkWaits: number | null;
  /** Everyone's requests today past which every device goes slow. */
  fleetSlow: number | null;
  /** One agent machine's requests a day. */
  cliDaily: number;
  /** New documents in one pass from which a device asks before syncing them. */
  manyNew: number;
  /** Everyone's requests today, as they reported them; null when the database could not say. */
  fleetToday: number | null;
};

/* ---------- Who is here ---------- */

/** One device, as the poll reports it. `name` is the Mac's; `memberId` is
 *  whose it is, and the app puts a person's name to it. `path` is what they
 *  have open, in `space` when that is not the shared workspace — both absent
 *  when it is in a space the caller is not in. */
export type PresenceEntry = { memberId: string; name: string; path?: string; space?: string; ts: number };
export type PresenceMap = Record<string, PresenceEntry>;

/** One held document. `path` is the lease's key — relative to its space and
 *  lowercased, so two spellings of one file on a case-insensitive disk are
 *  one lock. `space` is set when it is not the shared workspace. `name` is
 *  the holder's Mac. */
export type LeaseEntry = {
  path: string;
  space?: string;
  deviceId: string;
  memberId: string;
  name: string;
  until: number;
};

/* ---------- The answers ---------- */

/** One row of the directory: a person, or an agent with whose it is. */
export type DirectoryEntry = { id: string; name: string; person?: string };

/** Who a credential is, and what it may do. An agent's is never told so
 *  here (it is answered on the document API alone): `agent` and a null
 *  `email` are what the credential's type allows, not what this carries. */
export type Who = {
  role: PersonRole | "agent";
  can: Action[];
  tokenId: string;
  memberId: string;
  email: string | null;
  name: string;
};

/** `GET /api/meta`, to a person's device. */
export type MetaAnswer = {
  version: number;
  workspace: WorkspaceRecord | null;
  /** The database's schema version; null where none is bound. */
  d1: number | null;
  you: Who;
  superadmin: { id: string; name: string } | null;
  people: DirectoryEntry[];
  limits: Limits;
};

/** `GET|POST /api/poll`. When the database cannot say, `presence` is empty
 *  and `leases` and `spaces` are null: nobody holds anything, and nothing is
 *  known of the sections. */
export type PollAnswer = {
  manifestEtag: string;
  presence: PresenceMap;
  leases: LeaseEntry[] | null;
  spaces: Space[] | null;
  limits: Limits;
};
