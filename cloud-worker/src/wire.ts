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

/** `private` a person's My files; `folder` and `document` something shared. */
export type SpaceKind = "private" | "folder" | "document";

/**
 * A section of the workspace beside Library, as the person asking sees it.
 * Sections are a tree: a share sits in a My files, or in another share, and
 * whoever can open the section it sits in can open it.
 */
export type Space = {
  id: string;
  kind: SpaceKind;
  /** A shared folder's name, or a shared document's as its manifest last
   *  spelled it. */
  name: string;
  /** Who made it. */
  by: string;
  createdAt: number;
  /** Its manifest's etag as of the worker's last write there (`noteEtag`). */
  etag: string;
  /** The section it sits in: null for a My files — and to somebody who
   *  cannot open that section, who is told nothing of where it is. */
  parent: string | null;
  /** Whose My files it is in, in the end: what tells two shares of one name
   *  apart. "" when the database cannot say. */
  owner: string;
  /** The people it is shared with, by member id — a My files holds its one. */
  members: string[];
  /** Everyone else who can open it, because they can open the section it
   *  sits in: its owner is one. Named, and nothing more is said of them. */
  above: string[];
  /** When it was deleted, for a share that can still be restored. It is
   *  told only to somebody who can restore it, and holds no manifest to sync. */
  deletedAt?: number;
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

/* ---------- Searching ---------- */

/** One document `GET /api/web/search` found: its section and its file there
 *  (the markdown, or the html of a document that has no markdown). */
export type SearchHit = {
  space: string;
  fid: string;
  path: string;
  /** The lines that hold the text, a markdown file's numbered as the file
   *  numbers them. */
  matches: { line?: number; text: string }[];
  /** Matching lines beyond the ones in `matches`. */
  moreLines?: number;
  /** Its name holds the text. */
  inName?: true;
  /** Its text does not, on any line: the text was said in a comment. */
  inComments?: true;
};

/** `GET /api/web/search`, answered `200`. */
export type SearchAnswer = {
  query: string;
  results: SearchHit[];
  /** Every document that matched, listed or not. */
  total: number;
  truncated?: true;
  /** Documents too large to search. */
  notSearched?: { space: string; path: string }[];
  /** There are sections beyond what one request opens: ask again with
   *  `after` set to this. */
  next?: number;
};

/** The same, answered `202`: the search's mirror has `pending` documents
 *  still to read, and the caller asks again. */
export type SearchIndexing = { indexing: true; pending: number };

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
