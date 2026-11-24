// What the app asks of the platform it runs on. The UI is written against
// this file and nothing beneath it; the Mac answers it through Tauri
// (src/mac/backend.ts), and nothing else under src/ imports `@tauri-apps/*`
// (eslint holds it).
//
// Three rules shape it:
//
//   A document is asked for as a document. A note is its text, its sidecar
//   (comment threads, table widths) and, beside a markdown note, an html
//   rendition: one thing to open, save, move, copy and delete. Which files
//   that is, in what order they are written and where a deleted one goes are
//   the backend's to know. A path names a document; it is never taken apart
//   here to find the files beside it.
//
//   What a platform cannot do is absent, not refused. A group marked optional
//   below is one a backend may not have: the UI asks for the group where the
//   feature comes into view (a button, a menu row, a shortcut) and shows
//   nothing when it is not there. Nothing asks which platform this is.
//
//   Nothing is called before `installBackend`: the entry installs a backend
//   and then renders, so no module may ask at import time.

import type {
  AgentScope,
  CloudAddressTakenEvent,
  CloudAgent,
  CloudAgentAdded,
  CloudAgentLogin,
  CloudAppliedEvent,
  CloudConflictEvent,
  CloudDeviceCode,
  CloudHeld,
  CloudInvited,
  CloudMarker,
  CloudMember,
  CloudPageLink,
  CloudPastedInvite,
  CloudPendingAddsEvent,
  CloudPendingDeletesEvent,
  CloudPeople,
  CloudPlan,
  CloudProbe,
  CloudProgressEvent,
  CloudRecentFiles,
  CloudRedeemed,
  CloudRemovedEvent,
  CloudSpace,
  CloudSpaceLeftEvent,
  CloudStatus,
  EveryPage,
} from "./cloud";
import type { WorkspaceDocument } from "./docLinks";
import type { StoredTab } from "./tabs";
import type {
  DeletedFile,
  ExportReport,
  FileHistory,
  RestoreOutcome,
  RestoreReport,
  SnapshotDiff,
  SnapshotMeta,
  StoreInfo,
  VersionReason,
  VersionsAppliedEvent,
  VersionsProgressEvent,
  VersionsStatus,
} from "./versions";

/** Stops a listener. Safe to call more than once. */
export type Unsubscribe = () => void;

/* ---------- Documents ---------- */

declare const revBrand: unique symbol;
/** What a document's text was read at. It goes back with the save made from
 *  that text, which then lands only if nothing else wrote in between. Only
 *  the backend that handed one out can read it. */
export type Rev = { readonly [revBrand]: true };

export type EntryKind = "file" | "dir";

/** A document's own text: markdown, or html for a document that is html alone. */
export type DocumentText = { text: string; rev: Rev };

export type OpenedDocument = DocumentText & {
  /** The sidecar's text; null when the document has none yet. */
  meta: string | null;
  /** The html rendition beside a markdown document, by its path; null when
   *  there is none. Read like any document's text. */
  rendition: string | null;
};

/** The text moved on since it was read: `current` is what it is at now.
 *  Nothing was written. */
export class SaveConflict extends Error {
  constructor(readonly current: Rev) {
    super("The document changed since it was read.");
    this.name = "SaveConflict";
  }
}

export type Saved = {
  /** What the text is at now; null when the save carried no text. */
  rev: Rev | null;
};

/** The parts of a document that travel with it. */
export type DocumentPart = "rendition" | "meta";

/** A part that did not follow its document through a move, a copy or a
 *  delete, and why. The document itself went through. */
export type LeftBehind = { part: DocumentPart; error: string };

export type Restored = {
  /** Whether anything came back. */
  restored: boolean;
  failed: { path: string; error: string }[];
};

export type Removed = {
  left: LeftBehind[];
  /** Puts back what was removed; null where a delete cannot be taken back. */
  undo: (() => Promise<Restored>) | null;
};

/** A document on screen, as `watch` is told of it. */
export type WatchedDocument = { path: string; rendition: string | null };

/** A watched document changed somewhere else. `rendition` is never said of a
 *  document that is html alone: there the html is its text. */
export type DocumentChange = { path: string; part: "text" | DocumentPart };

/** The tree's rows.
 *  `paired`: a markdown row with an html rendition folded into it.
 *  `supported: false`: a file that is not a document, listed only when every
 *  file is asked for. */
export type TreeNode =
  | { kind: "file"; name: string; path: string; paired?: boolean; supported?: boolean }
  | { kind: "dir"; name: string; path: string; children: TreeNode[] };

/** `line`: null in a document whose lines are not numbered (html, searched
 *  as the text it shows). */
export type SearchMatch = { line: number | null; column: number; preview: string };
/** `named`: the document's name holds the query. */
export type FileMatches = { path: string; name: string; named: boolean; matches: SearchMatch[] };
/** `more`: documents that matched and are not among `files`, where the
 *  backend lists only the first of many. */
export type SearchResults = { files: FileMatches[]; more: number };

export interface Documents {
  /** Everything a document is shown from. Rejects when there is none at `path`. */
  open(path: string): Promise<OpenedDocument>;
  /** A document's text alone. Rejects when there is none at `path`. */
  read(path: string): Promise<DocumentText>;
  /** A document's sidecar alone; null when it has none. */
  meta(path: string): Promise<string | null>;
  /** Write a document's text, its sidecar, or both as one save. The text
   *  lands only over `over` (null: over whatever is there) and rejects with
   *  `SaveConflict` otherwise. The sidecar is last writer wins. Both land, or
   *  the save rejects: the sidecar is written before the text, and on a
   *  rejection it may hold the new text's records beside the old ones, which
   *  nothing uses until a text does. */
  save(path: string, parts: { text?: string; meta?: string }, over: Rev | null): Promise<Saved>;
  /** Whether a file or a folder is at `path`. */
  exists(path: string): Promise<boolean>;
  /** The documents under `root`; with `all`, every file. */
  tree(root: string, all?: boolean): Promise<TreeNode>;
  /** Every document of the workspace at `root`, in every section, by its
   *  workspace-relative path, each with its file id where it has one: what a
   *  link to a document is resolved against. A folder that doesn't sync
   *  lists its tree, with no ids. */
  documents(root: string): Promise<WorkspaceDocument[]>;
  /** An empty document, or a folder. */
  create(path: string, kind: EntryKind): Promise<void>;
  /** Move or rename; a document's parts go with it. Rejects when nothing moved. */
  move(from: string, to: string, kind: EntryKind): Promise<LeftBehind[]>;
  /** Duplicate; a document's parts go with it. Rejects when nothing was copied. */
  copy(from: string, to: string, kind: EntryKind): Promise<LeftBehind[]>;
  /** Delete; a document's parts go with it. Rejects when nothing was deleted. */
  remove(path: string, kind: EntryKind): Promise<Removed>;
  /** Whether a delete here can be taken back (`Removed.undo`). Where it
   *  cannot, the app asks before it deletes. */
  readonly removeUndoes: boolean;
  /** The documents on screen, all of them, each time the set changes.
   *  `onChange` speaks only of these. */
  watch(docs: WatchedDocument[]): Promise<void>;
  onChange(cb: (change: DocumentChange) => void): Unsubscribe;
  search(root: string, query: string, caseSensitive: boolean): Promise<SearchResults>;
  /** Whether a search can be told to match case. */
  readonly searchByCase: boolean;
}

/* ---------- The file clipboard ---------- */

/** What Cut or Copy in the tree parked, for every window of the app. */
export type FileClipboardPayload = { items: { path: string; kind: EntryKind }[]; cut: boolean };

export interface FileClipboard {
  get(): Promise<FileClipboardPayload | null>;
  set(items: FileClipboardPayload["items"], cut: boolean): Promise<void>;
  clear(): Promise<void>;
  onChange(cb: (clip: FileClipboardPayload | null) => void): Unsubscribe;
}

/* ---------- The cloud ----------
   What a backend answers of a workspace it shows: its status, what changed
   in it, who is editing what, a page's link, and publishing. The types, and
   what each status means, are src/cloud.ts's. What only some backends have —
   a copy of the workspace on the device, the way onto a device, the domain's
   upkeep, who may open what — is in the optional groups further down. */

export interface Cloud {
  /** Every connected workspace's status. */
  status(): Promise<CloudStatus[]>;
  onStatus(cb: (statuses: CloudStatus[]) => void): Unsubscribe;
  onApplied(cb: (e: CloudAppliedEvent) => void): Unsubscribe;
  onConflict(cb: (e: CloudConflictEvent) => void): Unsubscribe;
  onSpaceLeft(cb: (e: CloudSpaceLeftEvent) => void): Unsubscribe;

  /** Which document this window is editing (its path), or none: what
   *  presence reports, and the document this device claims the lease on. */
  setActivity(path: string | null): Promise<void>;
  /** *Take over* a document another device holds: claimed on the next beat,
   *  and the device it is taken from goes view-only on its next poll. The
   *  banner clears when the status says the lease moved. */
  takeOver(root: string, path: string): Promise<void>;
  /** The link to the document at `path`. Waits for one made a moment ago,
   *  which has no id until the workspace has taken it in. */
  link(path: string): Promise<CloudPageLink>;
  /** Where a link to a page (`link`'s) leads on this device: the file's
   *  path. Null for an address that is no such link, which is the web's to
   *  open. Rejects, with the reason as a sentence, for one that opens
   *  nothing here. */
  follow(url: string): Promise<string | null>;

  /** Publish a file or a folder (the path decides); resolves to the slug.
   *  Rejects when the address asked for is another page's, where the backend
   *  knows at once (`CloudSync.onAddressTaken` is where it does not). */
  publish(path: string, opts?: { slug?: string; title?: string; desc?: string }): Promise<string>;
  unpublish(root: string, slug: string): Promise<void>;
  setRoot(root: string, slug: string | null): Promise<void>;
  /** Every public address on the domain (an owner's to read). `truncated`
   *  when the domain holds more than one answer carries. */
  pages(root: string): Promise<{ pages: EveryPage[]; truncated: boolean }>;
  /** Take a page down, whoever published it (an owner's to do). */
  pageTakeDown(root: string, slug: string): Promise<void>;
}

/* ---------- What a platform may not have ---------- */

/** Bringing a workspace onto this device: making one from a folder, joining
 *  one with a line, getting back into one with its Cloudflare account. */
export interface CloudSetup {
  /** 32 random bytes, hex: a fresh key for the domain, which the setup and
   *  recovery prompts have an agent put on the worker. Traded once, by
   *  `recover`, for this device's own sign-in. */
  mintToken(): Promise<string>;
  probe(endpoint: string, token: string): Promise<CloudProbe>;
  /** The marker a folder carries, or null: the wizard's "resume" outcome. */
  marker(root: string): Promise<CloudMarker | null>;
  /** The copy of `endpoint`'s workspace this device already has, if any:
   *  asked before a code or a key is traded, since the trade refuses one
   *  held here. */
  held(endpoint: string): Promise<CloudHeld | null>;
  /** Split one paste into the address and the code. No domain is touched. */
  parseInvite(text: string): Promise<CloudPastedInvite>;
  /** Trade an invite code for this device's own credential. The order is
   *  inverted from every other entrance (redeem first, probe with what it
   *  minted), because an invitee cannot ask a domain anything until they
   *  hold a token. */
  redeem(endpoint: string, code: string): Promise<CloudRedeemed>;
  /** Trade the key an agent just put on the worker for this device's own
   *  sign-in, as the superadmin: `email`'s person, who becomes it. The key
   *  works once, so a step after this that fails is retried with the token,
   *  never the key. */
  recover(endpoint: string, key: string, email: string, name: string | null): Promise<CloudRedeemed>;
  /** Bind a fresh domain to `root` and upload everything; resolves to the workspace id. */
  connect(root: string, endpoint: string, token: string, name: string): Promise<string>;
  /** Download a domain's workspace into `~/Doklin/<name>` (no folder is
   *  asked for) and start syncing it; resolves to the new folder. */
  join(endpoint: string, token: string): Promise<string>;
  /** Adopt a folder carrying the domain's marker in place; resolves to the workspace id. */
  resume(root: string, endpoint: string, token: string): Promise<string>;
  onProgress(cb: (e: CloudProgressEvent) => void): Unsubscribe;
}

/** This device's own copy of a workspace, and the sync that keeps it in
 *  step: what is held back for a word, what is paused, what is forgotten. */
export interface CloudSync {
  syncNow(root: string): Promise<void>;
  pause(root: string, paused: boolean): Promise<void>;
  /** Stop syncing here and end this device's sign-in. The folder stays. */
  disconnect(root: string): Promise<void>;
  confirmDeletes(root: string): Promise<void>;
  /** Answer the many-new-documents question: `sync` sends them (and lifts
   *  the day's wait for them); false ("Not now") leaves them here until it
   *  asks again. */
  confirmAdds(root: string, sync: boolean): Promise<void>;
  /** Send what this device's spent allowance holds back, now. Holds until
   *  the next 00:00 UTC, so it is never asked twice in a day. */
  liftWait(root: string): Promise<void>;
  onPendingDeletes(cb: (e: CloudPendingDeletesEvent) => void): Unsubscribe;
  onPendingAdds(cb: (e: CloudPendingAddsEvent) => void): Unsubscribe;
  /** A page queued here asked for an address that turned out to be taken. */
  onAddressTaken(cb: (e: CloudAddressTakenEvent) => void): Unsubscribe;
  /** Every workspace taken off this device since the app started. The event
   *  says so as it happens; this answers a window that was not listening
   *  yet. */
  removed(): Promise<CloudRemovedEvent[]>;
  onRemoved(cb: (e: CloudRemovedEvent) => void): Unsubscribe;
  /** What changed lately in the workspace at `root`, at most `limit` documents. */
  recent(root: string, limit?: number | null): Promise<CloudRecentFiles>;
}

/** The domain's own upkeep, which is its superadmin's. */
export interface CloudDomain {
  /** Ask the domain's worker what it is again ("Check again" after an
   *  update); the fresh version arrives in the next status. */
  checkWorker(root: string): Promise<void>;
  /** Tell the domain which Cloudflare plan the account is on; the new
   *  limits arrive in the next status. */
  setPlan(root: string, plan: CloudPlan): Promise<void>;
  /** Erase everything on the workspace's domain and forget it here; resolves to the purged count. */
  wipe(root: string): Promise<number>;
}

/** Who may open a workspace and what each may do in it: its people and
 *  their devices, and its agents. */
export interface CloudAccess {
  /** Who is on this workspace and what each of them holds: the People
   *  view's whole answer, this device's own role included. */
  people(root: string): Promise<CloudPeople>;
  /** Invite someone to a connected workspace by email (an owner's to do).
   *  The code is minted and hashed on this device; only its sha256 goes up. */
  invite(root: string, email: string, name: string | null, days: number | null): Promise<CloudInvited>;
  /** Withdraw a code nobody has traded in yet. The person's row stays. */
  withdrawInvite(root: string, inviteId: string): Promise<void>;
  /** Make someone an owner, or a member again. Every device they are signed
   *  in on carries the new role on its next request. */
  setRole(root: string, memberId: string, role: "owner" | "member"): Promise<CloudMember>;
  /** Take a person off the workspace: their row, their pending invite and
   *  every device they signed in on. Each of those deletes its copy when it
   *  hears. */
  revokePerson(root: string, memberId: string): Promise<void>;
  /** A one-time code for another device of this person's own. Whoever
   *  pastes its line joins as them, on a sign-in of its own. */
  deviceCode(root: string): Promise<CloudDeviceCode>;
  /** Sign one device out (one's own, or as an owner anybody's), leaving the
   *  person and their other devices alone. It takes effect on that device's
   *  very next request, and that device deletes its copy. */
  revokeDevice(root: string, tokenId: string): Promise<void>;

  /** Every agent on this workspace: the owner's to see. */
  agents(root: string): Promise<CloudAgent[]>;
  /** Add an agent and mint the line its first machine logs in with. */
  agentAdd(root: string, name: string, scopes: AgentScope[]): Promise<CloudAgentAdded>;
  /** A new login code for an agent: for another machine, or after the last
   *  one ran out. Whatever code it had stops working. */
  agentCode(root: string, agentId: string): Promise<CloudAgentLogin>;
  /** Rename an agent or change what it may do; it finds out on its next request. */
  agentUpdate(root: string, agentId: string, name: string | null, scopes: AgentScope[] | null): Promise<void>;
  /** Remove an agent and log every one of its machines out. */
  agentRemove(root: string, agentId: string): Promise<void>;
  /** Log one machine out, leaving the agent and its other machines alone. */
  agentRevokeMachine(root: string, agentId: string, tokenId: string): Promise<void>;
}

/** Restricted folders: making one, who is in it, deleting it. Who there is
 *  to put in one is `CloudAccess.people`, so what offers these asks for both
 *  groups. */
export interface CloudSpaces {
  /** Make a restricted folder holding you and `members` (member ids). With
   *  `from` (a folder in the workspace) that folder becomes it and leaves
   *  the device of everyone not chosen. Resolves to the folder as the
   *  status lists it: `path` is where it is here. */
  spaceCreate(root: string, name: string, members: string[], from?: string | null): Promise<CloudSpace>;
  /** Add a person to a restricted folder (`add`), or take one out, yourself
   *  included, which is leaving it. The last person cannot be taken out. */
  spaceMember(root: string, id: string, memberId: string, add: boolean): Promise<void>;
  /** Delete a restricted folder for everyone in it. */
  spaceDelete(root: string, id: string): Promise<void>;
}

/** A sign-in the page itself holds, where there is no copy of the workspace
 *  on the device to disconnect: a browser's. */
export interface Session {
  /** End it. Text not yet sent goes first where it can; the page then
   *  starts again, signed out. */
  signOut(): Promise<void>;
}

/** Version history: the store beside each folder (src/versions.ts has the
 *  types and what they mean). */
export interface Versions {
  /** Every version store's status. */
  status(): Promise<VersionsStatus[]>;
  onStatus(cb: (statuses: VersionsStatus[]) => void): Unsubscribe;
  /** History put files back: `paths` are the ones it wrote. */
  onApplied(cb: (e: VersionsAppliedEvent) => void): Unsubscribe;
  onProgress(cb: (e: VersionsProgressEvent) => void): Unsubscribe;
  /** A folder's retained snapshots, newest first. */
  snapshots(root: string): Promise<SnapshotMeta[]>;
  /** Capture now, whatever the cadence says. A `manual` capture (the
   *  default) is pinned and may carry a name; the answer is null when the
   *  folder is already exactly what the newest snapshot holds. */
  captureNow(root: string, opts?: { reason?: VersionReason; label?: string }): Promise<SnapshotMeta | null>;
  /** Keep a version out of the ladder's reach, and optionally name it. */
  setPinned(root: string, ts: number, pinned: boolean, label?: string): Promise<void>;
  /** The kill switch. Nothing already captured is touched. */
  setEnabled(enabled: boolean): Promise<void>;
  /** Every version of one document, newest first: this device's snapshots
   *  and the ones other devices mirrored, in one walk. */
  history(path: string): Promise<FileHistory>;
  /** One version's text, for the preview. */
  read(root: string, hash: string): Promise<string>;
  /** A unified diff between two versions. A null hash means the file as it
   *  is, which is how the newest version is compared against now. */
  diff(root: string, opts?: { path?: string; from?: string | null; to?: string | null }): Promise<string>;
  /** Put an earlier version back. The content is named either by `hash` (a
   *  version in this store) or by `text` (one only the cloud still holds).
   *  One call, never a capture and a write from the UI: the cadence could
   *  capture between them and the state being left would go unrecorded. */
  restoreFile(
    root: string,
    path: string,
    opts?: { ts?: number | null; hash?: string | null; text?: string | null },
  ): Promise<RestoreOutcome>;
  /** What restoring one snapshot would do to the folder as it is now: the
   *  three lists the workspace timeline shows before anything happens. */
  snapshotDiff(root: string, ts: number): Promise<SnapshotDiff>;
  /** Every file this folder's history holds and the folder itself does not,
   *  most recently seen first. */
  deleted(root: string): Promise<DeletedFile[]>;
  /** Put a whole moment back, or with `paths` the part of it the user
   *  ticked. Like the file restore it captures the state it leaves first, so
   *  the whole thing is undone by restoring `preRestoreTs` with the same
   *  paths. */
  restoreSnapshot(root: string, ts: number, paths?: string[] | null): Promise<RestoreReport>;
  /** How far back this folder keeps, null for forever. Written into the
   *  store's own index, so two folders can answer differently. */
  setHorizon(root: string, days: number | null): Promise<void>;
  /** How far back the *bucket* keeps: one CAS on the cloud index, so every
   *  device agrees. Rejects when the folder isn't connected. */
  setCloudHorizon(root: string, days: number | null): Promise<void>;
  /** Every version store on this device, newest first. */
  stores(): Promise<StoreInfo[]>;
  /** Delete one store outright. Refused while its folder is open. */
  forget(key: string): Promise<void>;
  /** One archive of the folder and its whole history, written into `dest`. */
  export(root: string, dest: string): Promise<ExportReport>;
}

/** What a window opens with. */
export type WindowInit = {
  isMain: boolean;
  folder: string | null;
  file: string | null;
  tabs: StoredTab[];
  activeId: string | null;
  restored: boolean;
};

/** Something an open from outside the app asked this window to show
 *  (`Show` in src-tauri/src/external_open.rs — change both). */
export type Show = { path: string; kind: "file" | "folder" };

/** Opens from outside the app that land in this window: a link followed, a
 *  document handed over by whatever opens those here. */
export interface Shows {
  /** What has been asked for since this was last asked. Rejects, with the
   *  reason as a sentence, when what was asked for cannot be shown. */
  take(): Promise<Show[]>;
  /** There is something to take. */
  onArrive(cb: () => void): Unsubscribe;
}

/** A browser's own Back and Forward. Each step a tab takes by a link
 *  followed in it is an entry in the browser's history, so the browser's
 *  Back — its button, a swipe, a key — takes the tab in front back a step. */
export interface BrowserHistory {
  /** The tab in front took a step: the browser gets an entry for it. */
  took(): void;
  /** Go back (-1) or forward (1) through the browser, when it has an entry
   *  of the app's that way: the step then comes back through `onStep`.
   *  False when it has none, and the app takes the step itself. */
  go(by: -1 | 1): boolean;
  /** The browser moved an entry of the app's back (-1) or forward (1). */
  onStep(cb: (by: -1 | 1) => void): Unsubscribe;
}

/** A page that can go at any moment, with no window of the app's own to
 *  ask first (`Windows` has that): a browser's tab. */
export interface Leaving {
  /** The page is going out of use — left for another, hidden, closing.
   *  `flush` is called at once and must hand the backend what the app still
   *  holds before it first waits for anything: there may be no later. */
  onLeave(flush: () => Promise<unknown>): Unsubscribe;
}

/** What a window says it is showing, so another open of the same thing
 *  finds it and a quit can bring it back. */
export type WindowContent = { folder: string | null; tabs: StoredTab[]; activeId: string | null };

/** A request to close the window; `preventDefault` keeps it open. */
export type CloseRequest = { preventDefault(): void };

/** The app's own windows: more than one of them, each restored at launch,
 *  each asked before it goes. */
export interface Windows {
  /** Who this window is and what it opens with. Answers once. */
  init(): Promise<WindowInit>;
  /** The folder a launch from outside asked the main window for. Answers once. */
  pendingFolder(): Promise<string | null>;
  report(content: WindowContent): void;
  /** Show a file or a folder in a window of its own: the one already
   *  showing it, or a new one. */
  openInNew(target: { folder: string } | { file: string }): Promise<void>;
  /** Bring the app's next window (or the one before) to the front. */
  focusNext(backward: boolean): void;
  /** The window's own chrome (menus, dialogs, tooltips): pinned light or
   *  dark, or null to follow the system. */
  setTheme(theme: "light" | "dark" | null): void;
  onCloseRequested(cb: (request: CloseRequest) => void | Promise<void>): Unsubscribe;
  /** Ask the window to close, as its close button would. */
  close(): void;
  /** Close it now, asking nothing. */
  destroy(): void;
  /** The app is quitting: it waits, briefly, for `flush` to settle in every window. */
  onQuit(flush: () => Promise<unknown>): Unsubscribe;
  /** Move the window with the pointer that is down on it. */
  startDragging(): void;
  toggleMaximize(): void;
}

/** Notes that have no file yet: each is a buffer of the app's own, read and
 *  saved as a document at its path. */
export interface UntitledNotes {
  /** Where the buffers live. */
  dir(): Promise<string>;
  /** Delete a note's buffer and what was kept beside it. */
  discard(path: string): Promise<void>;
  /** The buffers no window has open; `open` are the ones this window does. */
  orphans(open: string[]): Promise<string[]>;
}

/** This computer's own files and folders, outside any workspace. */
export interface LocalFiles {
  /** Ask for a folder; null when the question was dismissed. */
  pickFolder(): Promise<string | null>;
  /** Ask for a document. */
  pickDocument(): Promise<string | null>;
  /** Ask where to save a note, offering `defaultPath`. */
  pickSaveAs(defaultPath: string): Promise<string | null>;
  /** Show a file or a folder where it lives. */
  reveal(path: string): Promise<void>;
}

/** A stage of a PDF export, and how far through it where that is known. */
export type PdfProgress = { stage: string; pct: number | null };

export interface PdfExport {
  /** Export the html document at `path`; resolves to where the PDF was saved. */
  export(path: string, onProgress: (p: PdfProgress) => void): Promise<string>;
}

/** How far an update has got: the download in [0, 1], then installed and
 *  about to restart. */
export type UpdateProgress = { phase: "downloading"; fraction: number } | { phase: "installing" };

/** A newer release, found by `Updater.check`. */
export type AvailableUpdate = {
  version: string;
  notes: string;
  /** Download, verify and install it, then restart into it. */
  install(onProgress: (p: UpdateProgress) => void): Promise<void>;
};

export interface Updater {
  /** The running app's version. */
  version(): Promise<string>;
  /** The newer release, if there is one. */
  check(): Promise<AvailableUpdate | null>;
}

/* ---------- The whole of it ---------- */

export interface Backend {
  readonly documents: Documents;
  readonly cloud: Cloud;
  readonly fileClipboard: FileClipboard;
  /** Hand a web or mail address to whatever opens those here. */
  openExternal(url: string): Promise<void>;
  /** The name comments written here are signed with. */
  authorName(): Promise<string>;
  /** What the window, or the browser's tab, is called. */
  setTitle(title: string): void;
  /** What this device is in a sentence, after "this": "Mac", "browser". */
  readonly device: string;

  /** The one workspace this backend is for, by its root, where there is only
   *  one: the app opens it at start and offers no other. */
  readonly home?: string;
  /** A page of the platform's own that arbitrary html is shown in, where the
   *  app's page may not be handed markup that runs script: framed, it asks
   *  for the markup (`{ doklin: "frame-ready" }`) and is posted it
   *  (`{ doklin: "frame-html", html }`). Absent: the frame is given the
   *  markup itself. */
  readonly htmlFrame?: string;

  readonly setup?: CloudSetup;
  readonly sync?: CloudSync;
  readonly domain?: CloudDomain;
  readonly access?: CloudAccess;
  readonly spaces?: CloudSpaces;
  readonly session?: Session;
  readonly versions?: Versions;
  readonly shows?: Shows;
  readonly leaving?: Leaving;
  readonly browserHistory?: BrowserHistory;
  readonly windows?: Windows;
  readonly untitled?: UntitledNotes;
  readonly localFiles?: LocalFiles;
  readonly pdf?: PdfExport;
  readonly updater?: Updater;
}

/** The backend the app runs on. Set once, by the entry, before anything renders. */
export let backend: Backend;

export function installBackend(b: Backend): void {
  backend = b;
}
