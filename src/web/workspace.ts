// The browser version's picture of the workspace: what the worker last said,
// held in memory, and what the UI is told of it.
//
// A browser keeps no copy of the workspace. It holds the manifest of every
// section its person is in — the shared workspace, their Private, the
// restricted folders they are in — and reads a document's stored copy when
// the document is opened. From those and the poll it tells the UI what the
// engine tells it on a Mac: one `CloudStatus` (src/cloud.ts), the tree, and
// what changed somewhere else. What is here is what the worker holds; what
// this page has yet to send is saving.ts's.
//
// The poll carries this browser's beat, as a Mac's does: that it is here,
// and which document it is editing — which is its claim on that document.
// One tab of a browser asks and beats for all of them (tabs.ts).
//
// Paths. The UI names a document by an absolute path, as on a disk. Here
// that is the workspace's name as a root, then the path the Mac app would
// give the same file under its folder: every section's files are under its
// own folder there — `Library` (`LIBRARY_FOLDER`, layout.ts), `Private` or
// `Restricted/<name>` (`PRIVATE_DIR`, `RESTRICTED_DIR`,
// engine/src/cloud/space.rs — change both). A path under none of them is in
// no section, and neither is one under `Library/Private` or
// `Library/Restricted`: the shared manifest holds nothing there. What is sent
// to the worker is the section's id and the path inside the section.

import { LIBRARY_FOLDER, reservedTop, syncs, validPath } from "../../cloud-worker/src/layout";
import type { Manifest, ManifestFile } from "../../cloud-worker/src/manifest";
import type { Limits, MetaAnswer, PollAnswer, Space } from "../../cloud-worker/src/wire";
import type { DocumentChange, TreeNode, WatchedDocument } from "../backend";
import type {
  CloudAppliedEvent,
  CloudConflictEvent,
  CloudSpace,
  CloudSpaceLeftEvent,
  CloudStatus,
  CloudUsage,
  LeaseHolder,
  PresenceDevice,
  PublicPage,
} from "../cloud";
import { HTML_EXT_RE, MD_EXT_RE, META_SUFFIX, htmlSiblingOf, metaFileOf } from "../metaFile";
import { Refused, Unreachable, ask, askJson, deviceId, deviceName, nextDay, send, usedToday } from "./http";
import { tabs, type Tabs } from "./tabs";

const PRIVATE_DIR = "Private";
const RESTRICTED_DIR = "Restricted";

/** How often the worker is asked whether anything moved, by attention: the
 *  engine's numbers (`poll_gap`, engine/src/cloud/engine.rs — change both).
 *  Every poll is a request against the account's day. */
const POLL_ACTIVE_MS = 15_000;
/** The tab is in the background, or nothing was done in it for `IDLE_AFTER_MS`. */
const POLL_BACKGROUND_MS = 60_000;
/** Nothing was done in it for `AWAY_AFTER_MS`. */
const POLL_AWAY_MS = 5 * 60_000;
const IDLE_AFTER_MS = 5 * 60_000;
const AWAY_AFTER_MS = 30 * 60_000;

/** How often a poll carries the beat, and how long a beat says it holds: two
 *  and a half of the gaps to the next one, within the worker's bounds
 *  (`PRESENCE_BEAT`, `beat_ttl`, engine.rs — change both). */
const BEAT_MS = 45_000;
const BEAT_TTL_MIN_MS = 90_000;
const BEAT_TTL_MAX_MS = 15 * 60_000;
/** A document is being edited for this long after it was last opened or
 *  written here (`ACTIVITY_FRESH`, engine.rs): after it, the beat names none
 *  and the claim on it lapses. */
const ACTIVITY_FRESH_MS = 5 * 60_000;

/** How many stored copies are kept in memory. The browser's own cache keeps
 *  the rest: a copy never changes under its address. */
const TEXTS_KEPT = 64;

type Entry = { fid: string; file: ManifestFile };

/** One section as this browser holds it. */
type Section = {
  /** The space's id; "" is the shared workspace. */
  id: string;
  space: Space | null;
  /** Where its files are in the tree: `Library`, `Private`, `Restricted/<name>`. */
  mount: string;
  etag: string;
  manifest: Manifest;
  /** Its files by the path the section stores them under. */
  files: Map<string, Entry>;
};

/** A file as a section stores it. `space` is the section's id, "" the
 *  shared workspace. */
export type StoredFile = { space: string; fid: string; file: ManifestFile };

/** A section's manifest as it was read, or that the section is gone. */
type ReadSection =
  | { id: string; space: Space | null; etag: string; held: Section | undefined; fresh: Manifest | null }
  | { id: string; gone: true };

/** A name as a folder can carry it (`sanitize_folder_name`, engine/src/cloud/config.rs). */
const folderName = (name: string): string =>
  name
    .replace(/[/:\\\0]/g, "-")
    .trim()
    .replace(/^\.+|\.+$/g, "") || "Workspace";

const join = (dir: string, rel: string): string => (dir === "" ? rel : rel === "" ? dir : `${dir}/${rel}`);
const nameIn = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const dirIn = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const byName = <T extends { name: string }>(a: T, b: T): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function indexOf(manifest: Manifest, shared: boolean): Map<string, Entry> {
  const files = new Map<string, Entry>();
  for (const [fid, file] of Object.entries(manifest.files ?? {})) {
    if (typeof file?.path !== "string" || !syncs(file.path)) continue;
    // Nothing in the shared workspace is under a section's own name.
    if (shared && reservedTop(file.path)) continue;
    files.set(file.path, { fid, file });
  }
  return files;
}

type Listeners<T> = Set<(value: T) => void>;
const hear = <T>(set: Listeners<T>, cb: (value: T) => void) => {
  set.add(cb);
  return () => void set.delete(cb);
};
const tell = <T>(set: Listeners<T>, value: T) => {
  for (const cb of set) cb(value);
};

export class Workspace {
  /** The workspace's root, as the UI names it. */
  readonly root: string;
  readonly wsId: string;
  readonly name: string;
  private readonly people = new Map<string, string>();
  private readonly sections = new Map<string, Section>();
  /** Each space's folder, kept for as long as the page is: a folder never
   *  changes its name under an open document. */
  private readonly mounts = new Map<string, string>();
  /** Restricted folders made on this page that no poll has listed yet: an
   *  answer asked for before one was made says nothing of it, which would
   *  otherwise read as this person having been taken out of it. */
  private readonly entering = new Map<string, Space>();
  private poll: PollAnswer | null = null;
  private limits: Limits;
  private phase: CloudStatus["phase"] = "idle";
  private error: string | null = null;
  private lastSyncMs: number | null = null;
  private said = "";

  private watched: WatchedDocument[] = [];
  private readonly texts = new Map<string, Promise<string>>();
  /** Folders made on this page that hold nothing yet, workspace-relative. A
   *  folder is its documents everywhere else: one with none is only here. */
  private readonly made = new Set<string>();
  /** What this page has yet to send (saving.ts): whether anything waits,
   *  and why something could not be sent. */
  private outbox: () => { waiting: boolean; error: string | null } = () => ({ waiting: false, error: null });

  private readonly statusHeard: Listeners<CloudStatus[]> = new Set();
  private readonly changeHeard: Listeners<DocumentChange> = new Set();
  private readonly appliedHeard: Listeners<CloudAppliedEvent> = new Set();
  private readonly conflictHeard: Listeners<CloudConflictEvent> = new Set();
  private readonly spaceLeftHeard: Listeners<CloudSpaceLeftEvent> = new Set();

  private tabs: Tabs | null = null;
  private timer: number | null = null;
  private passing: Promise<void> | null = null;
  private activeAt = Date.now();
  private hiddenAt: number | null = null;
  private waitUntil = 0;

  /** The document this tab is editing, and when it was last opened or
   *  written: what the beat names while that is fresh. */
  private activity: { abs: string; at: number } | null = null;
  /** A *Take over* waiting for the beat that carries it. */
  private taking: string | null = null;
  /** When the last beat was sent from this tab, and the document it named
   *  ("" for none). Null: this tab owes one. */
  private lastBeat: { at: number; named: string } | null = null;
  /** The last beat sent ahead of the clock: what for, and when. */
  private hurried: { key: string; at: number } | null = null;

  private constructor(
    private meta: MetaAnswer,
    workspace: NonNullable<MetaAnswer["workspace"]>,
  ) {
    this.wsId = workspace.id;
    this.name = workspace.name;
    this.root = `/${folderName(workspace.name)}`;
    this.limits = meta.limits;
    for (const p of meta.people) this.people.set(p.id, p.name);
  }

  /** The workspace this domain holds, read whole: every section's manifest.
   *  Rejects with the reason as a sentence when there is none to show. */
  static async open(meta: MetaAnswer): Promise<Workspace> {
    if (!meta.workspace) throw new Error("This domain holds no workspace yet. It is set up from the Doklin app.");
    const ws = new Workspace(meta, meta.workspace);
    let poll = await askJson<PollAnswer>("GET", "/api/poll");
    // A person who has only ever signed in from a browser has no Private
    // yet: a Mac makes it when it joins, and so does this.
    if (poll.spaces && !poll.spaces.some((s) => s.kind === "private")) {
      await ask("PUT", "/api/spaces/private");
      poll = await askJson<PollAnswer>("GET", "/api/poll");
    }
    await ws.take(poll);
    return ws;
  }

  /* ---------- Names and places ---------- */

  /** A `by` in words. An id nobody can name stays an id. */
  nameOf(by: string): string {
    return this.people.get(by) ?? by;
  }

  /** The person at this browser, by their id. */
  get me(): string {
    return this.meta.you.memberId;
  }

  /** Ask the domain again who this browser is and who is here: a role is the
   *  person's, and an owner can change it while this page is open; somebody
   *  invited, or an agent added, has a name from then on. What the page was
   *  told when it opened is replaced, and the status says so. */
  async probe(): Promise<MetaAnswer> {
    const meta = await askJson<MetaAnswer>("GET", "/api/meta");
    this.meta = meta;
    for (const p of meta.people) this.people.set(p.id, p.name);
    this.restate();
    return meta;
  }

  /** The folder a space is shown as: its own for a Private; under
   *  `Restricted`, its name, then its name and who made it when that name is
   *  taken, then a number (`candidates`, engine/src/cloud/space.rs). */
  private mountOf(space: Space): string {
    const kept = this.mounts.get(space.id);
    if (kept !== undefined) return kept;
    let mount = PRIVATE_DIR;
    if (space.kind !== "private") {
      const taken = new Set([...this.mounts.values()].map((m) => m.toLowerCase()));
      const base = folderName(space.name);
      const maker = this.people.get(space.by);
      const names = [base, ...(maker ? [`${base} (${folderName(maker)})`] : [])];
      for (let n = 2; names.every((name) => taken.has(`${RESTRICTED_DIR}/${name}`.toLowerCase())); n += 1) {
        names.push(`${base} ${n}`);
      }
      mount = `${RESTRICTED_DIR}/${names.find((name) => !taken.has(`${RESTRICTED_DIR}/${name}`.toLowerCase()))}`;
    }
    this.mounts.set(space.id, mount);
    return mount;
  }

  /** A path under the root, relative to it ("" is the root); null outside it. */
  private relOf(abs: string): string | null {
    if (abs === this.root) return "";
    return abs.startsWith(`${this.root}/`) ? abs.slice(this.root.length + 1) : null;
  }

  /** The section a workspace-relative path is in, and the path as that
   *  section stores it; null for a path in no section. */
  private placeOf(rel: string): { section: Section; path: string } | null {
    for (const section of this.sections.values()) {
      const path = rel === section.mount ? "" : rel.startsWith(`${section.mount}/`) ? rel.slice(section.mount.length + 1) : null;
      if (path === null) continue;
      // Nothing in the shared section is under another section's own name.
      return section.id === "" && reservedTop(path) ? null : { section, path };
    }
    return null;
  }

  /** The stored file at an absolute path, with its section. */
  private fileAt(abs: string): { section: Section; entry: Entry } | null {
    const rel = this.relOf(abs);
    const place = rel === null ? null : this.placeOf(rel);
    const entry = place?.section.files.get(place.path);
    return place && entry ? { section: place.section, entry } : null;
  }

  /** Where an absolute path is: the section, and the path as that section
   *  stores it ("" is the section itself). Null for a path in no section. */
  place(abs: string): { space: string; path: string } | null {
    const rel = this.relOf(abs);
    const place = rel === null ? null : this.placeOf(rel);
    return place ? { space: place.section.id, path: place.path } : null;
  }

  /** A path under the root, as sentences and events name it; null outside it. */
  rel(abs: string): string | null {
    return this.relOf(abs);
  }

  /** What a folder put at an absolute path would be as a restricted folder:
   *  its name, and whether one is there already. Null for a path that is
   *  not straight under `Restricted`, where the restricted folders are. */
  restrictedSlot(abs: string): { name: string; taken: boolean } | null {
    const rel = this.relOf(abs);
    if (rel === null || dirIn(rel) !== RESTRICTED_DIR) return null;
    return { name: nameIn(rel), taken: [...this.mounts.values()].some((mount) => mount.toLowerCase() === rel.toLowerCase()) };
  }

  /** A section's own folder, by the section's id; null for one not held. */
  folderOf(space: string): string | null {
    const section = this.sections.get(space);
    return section ? join(this.root, section.mount) : null;
  }

  /** The file stored at an absolute path, or null. */
  stored(abs: string): StoredFile | null {
    const found = this.fileAt(abs);
    return found ? { space: found.section.id, fid: found.entry.fid, file: found.entry.file } : null;
  }

  /** The document a file id names, by its absolute path; null when no
   *  section this person is in holds it. `space` is the section's id, ""
   *  the shared workspace. */
  pathOfFile(space: string, fid: string): string | null {
    const section = this.sections.get(space);
    const file = section?.manifest.files?.[fid];
    if (!section || !file || !section.files.has(file.path)) return null;
    return `${this.root}/${join(section.mount, file.path)}`;
  }

  /* ---------- Reading ---------- */

  /** A stored copy's text. A copy never changes under its address, so one
   *  read is kept, and a text this page wrote is kept without a read. */
  textOf(copy: { space: string; fid: string; hash: string }, known?: string): Promise<string> {
    const key = `${copy.space}/${copy.fid}/${copy.hash}`;
    const kept = this.texts.get(key);
    if (kept) return kept;
    const at = copy.space === "" ? "/api/blobs" : `/api/spaces/${copy.space}/blobs`;
    const read = known !== undefined ? Promise.resolve(known) : ask("GET", `${at}/${copy.fid}/${copy.hash}`).then((res) => res.text());
    this.texts.set(key, read);
    read.catch(() => this.texts.delete(key));
    if (this.texts.size > TEXTS_KEPT) this.texts.delete(this.texts.keys().next().value as string);
    return read;
  }

  /** The html rendition beside a markdown document, by its path. */
  renditionOf(abs: string): string | null {
    if (!MD_EXT_RE.test(abs)) return null;
    const sibling = htmlSiblingOf(abs);
    return this.fileAt(sibling) ? sibling : null;
  }

  /** Whether a file or a folder is at an absolute path. */
  exists(abs: string): boolean {
    const rel = this.relOf(abs);
    if (rel === null) return false;
    if (rel === "" || this.fileAt(abs)) return true;
    return this.dirs().has(rel);
  }

  /** Whether a folder holds a stored file, at any depth. */
  holdsFiles(abs: string): boolean {
    const rel = this.relOf(abs);
    if (rel === null) return false;
    for (const path of this.placed()) if (rel === "" || path.startsWith(`${rel}/`)) return true;
    return false;
  }

  /* ---------- Folders with nothing in them ---------- */

  /** Make a folder: on this page only, until a document is in it. */
  makeFolder(abs: string): void {
    const rel = this.relOf(abs);
    if (rel) this.made.add(rel);
  }

  /** A folder was moved or removed: the empty ones made here go with it.
   *  `to` null: removed. */
  movedFolder(from: string, to: string | null): void {
    const was = this.relOf(from);
    const now = to === null ? null : this.relOf(to);
    if (was === null) return;
    for (const dir of [...this.made]) {
      if (dir !== was && !dir.startsWith(`${was}/`)) continue;
      this.made.delete(dir);
      if (now !== null) this.made.add(`${now}${dir.slice(was.length)}`);
    }
  }

  /* ---------- The tree ---------- */

  /** Every file as the tree places it: its workspace-relative path. */
  private *placed(): Generator<string> {
    for (const section of this.sections.values()) {
      for (const path of section.files.keys()) yield join(section.mount, path);
    }
  }

  /** Every folder there is: one holding a document, each section's own, and
   *  the empty ones made on this page. */
  private dirs(): Set<string> {
    const dirs = new Set<string>();
    const add = (dir: string) => {
      for (let d = dir; d !== "" && !dirs.has(d); d = dirIn(d)) dirs.add(d);
    };
    for (const section of this.sections.values()) add(section.mount);
    for (const path of this.placed()) add(dirIn(path));
    for (const dir of this.made) add(dir);
    return dirs;
  }

  /** The documents under a folder, as the Mac's tree lists them (`walk`,
   *  src-tauri/src/lib.rs): folders first, each by name; an html file beside
   *  a markdown file of its name folded into that row; no sidecars. */
  tree(abs: string): TreeNode {
    const top = this.relOf(abs);
    const dirs = this.dirs();
    if (top === null || (top !== "" && !dirs.has(top))) throw new Error(`There is no folder at ${abs}.`);
    const under = new Map<string, { dirs: string[]; files: string[] }>();
    const at = (dir: string) => {
      let row = under.get(dir);
      if (!row) under.set(dir, (row = { dirs: [], files: [] }));
      return row;
    };
    for (const dir of dirs) at(dirIn(dir)).dirs.push(dir);
    for (const path of this.placed()) at(dirIn(path)).files.push(path);

    const node = (dir: string): TreeNode => {
      const row = at(dir);
      const names = row.files.map(nameIn);
      const stems = (ext: RegExp) => new Set(names.filter((n) => ext.test(n)).map((n) => n.replace(ext, "")));
      const markdown = stems(MD_EXT_RE);
      const html = stems(HTML_EXT_RE);
      const files: TreeNode[] = [];
      for (const path of row.files) {
        const name = nameIn(path);
        if (name.endsWith(META_SUFFIX)) continue;
        // An html file beside a markdown file of its stem is that document's rendition.
        if (HTML_EXT_RE.test(name) && markdown.has(name.replace(HTML_EXT_RE, ""))) continue;
        files.push({
          kind: "file",
          name,
          path: `${this.root}/${path}`,
          paired: MD_EXT_RE.test(name) && html.has(name.replace(MD_EXT_RE, "")),
          supported: true,
        });
      }
      return {
        kind: "dir",
        name: dir === "" ? nameIn(this.root) : nameIn(dir),
        path: join(this.root, dir),
        children: [...row.dirs.map(node).sort(byName), ...files.sort(byName)],
      };
    };
    return node(top);
  }

  /* ---------- What the UI is told ---------- */

  onStatus(cb: (statuses: CloudStatus[]) => void) {
    return hear(this.statusHeard, cb);
  }
  onChange(cb: (change: DocumentChange) => void) {
    return hear(this.changeHeard, cb);
  }
  onApplied(cb: (e: CloudAppliedEvent) => void) {
    return hear(this.appliedHeard, cb);
  }
  onConflict(cb: (e: CloudConflictEvent) => void) {
    return hear(this.conflictHeard, cb);
  }
  onSpaceLeft(cb: (e: CloudSpaceLeftEvent) => void) {
    return hear(this.spaceLeftHeard, cb);
  }

  /** What this page has yet to send, asked each time the status is said. */
  setOutbox(probe: () => { waiting: boolean; error: string | null }): void {
    this.outbox = probe;
  }

  /** Two changes to one document overlapped, and both versions were kept. */
  conflicted(e: CloudConflictEvent): void {
    tell(this.conflictHeard, e);
  }

  /** Files changed, by their absolute paths: the tree is told, and each
   *  document on screen that one of them belongs to. */
  changed(files: string[]): void {
    const paths = files.flatMap((file) => this.relOf(file) ?? []);
    if (paths.length > 0) tell(this.appliedHeard, { root: this.root, paths });
    for (const file of files) {
      for (const doc of this.watched) {
        if (file === doc.path) tell(this.changeHeard, { path: doc.path, part: "text" });
        else if (file === metaFileOf(doc.path)) tell(this.changeHeard, { path: doc.path, part: "meta" });
        else if (doc.rendition !== null && file === doc.rendition) tell(this.changeHeard, { path: doc.path, part: "rendition" });
      }
    }
  }

  /** The documents on screen: `onChange` speaks only of these. */
  watch(docs: WatchedDocument[]): void {
    this.watched = docs;
  }

  /** How this browser's requests stand against the day's limits (`mode`,
   *  engine/src/cloud/pace.rs). A browser sends nothing in bulk, so the one
   *  thing the limits change for it is how often it asks. */
  private usage(): CloudUsage {
    const l = this.limits;
    const today = usedToday();
    const cause =
      today >= l.deviceCeiling ? "device" : l.fleetSlow !== null && (l.fleetToday ?? 0) >= l.fleetSlow ? "fleet" : null;
    return {
      mode: cause ? "slow" : "normal",
      cause,
      today,
      fleetToday: l.fleetToday,
      cap: l.cap,
      plan: l.plan,
      resumesAt: cause || this.phase === "limited" ? nextDay() : null,
      waiting: 0,
      liftable: false,
      lifted: false,
    };
  }

  private pages(): PublicPage[] {
    const pages: PublicPage[] = [];
    for (const section of this.sections.values()) {
      for (const [slug, e] of Object.entries(section.manifest.public ?? {})) {
        // The engine's rule (`public_pages`, engine/src/cloud/unit.rs): a file's
        // page is up while the file is; a folder's while a document is under it.
        const alive =
          e.kind === "file"
            ? e.file in (section.manifest.files ?? {})
            : e.path === "" || [...section.files.keys()].some((p) => p.startsWith(`${e.path}/`));
        pages.push({
          slug,
          kind: e.kind,
          path: join(section.mount, e.path),
          title: e.title ?? null,
          desc: e.desc ?? null,
          by: this.nameOf(e.by),
          at: e.at,
          alive,
          root: e.root === true,
        });
      }
    }
    return pages;
  }

  /** The section whose public map holds an address: its id, "" for the
   *  shared workspace — and for an address none of the sections held has. */
  pageSpace(slug: string): string {
    for (const section of this.sections.values()) if (section.manifest.public?.[slug]) return section.id;
    return "";
  }

  /** Everybody else here, named as the engine names them (`presence_of`,
   *  engine.rs): a person by their name; this person's own other device, and
   *  one nobody can name, by the device's. */
  private presence(): PresenceDevice[] {
    const mine = deviceId();
    const me = this.meta.you.memberId;
    const here: PresenceDevice[] = [];
    for (const [id, e] of Object.entries(this.poll?.presence ?? {})) {
      if (id === mine) continue;
      const section = e.path === undefined ? undefined : this.sections.get(e.space ?? "");
      here.push({
        deviceId: id,
        memberId: e.memberId,
        name: (e.memberId === me ? undefined : this.people.get(e.memberId)) ?? e.name,
        device: e.name,
        path: section && e.path !== undefined ? join(section.mount, e.path) : null,
        ts: e.ts,
      });
    }
    const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    return here.sort((a, b) => order(a.name, b.name) || order(a.device, b.device) || order(a.deviceId, b.deviceId));
  }

  /** The documents another device holds (`lease_holders`, engine.rs). None
   *  while the domain is not answering: a lock nobody can confirm is no lock. */
  private leases(): LeaseHolder[] {
    if (this.phase !== "idle") return [];
    const mine = deviceId();
    const me = this.meta.you.memberId;
    const held: LeaseHolder[] = [];
    for (const l of this.poll?.leases ?? []) {
      const section = this.sections.get(l.space ?? "");
      if (l.deviceId === mine || !section) continue;
      const own = l.memberId === me;
      held.push({
        path: join(section.mount, l.path).toLowerCase(),
        deviceId: l.deviceId,
        memberId: l.memberId,
        name: (own ? undefined : this.people.get(l.memberId)) ?? l.name,
        device: l.name,
        own,
        until: l.until,
      });
    }
    return held;
  }

  private spaces(): CloudSpace[] {
    const spaces: CloudSpace[] = [];
    for (const { space, mount } of this.sections.values()) {
      if (!space) continue;
      spaces.push({ id: space.id, kind: space.kind, name: space.name, path: mount, by: this.nameOf(space.by), members: space.members });
    }
    return spaces;
  }

  status(): CloudStatus {
    const you = this.meta.you;
    // What waits to be sent shows as a Mac's own unsent changes do; a save
    // the worker would not take is an error until it is taken.
    const out = this.outbox();
    const settled = this.phase === "idle";
    return {
      root: this.root,
      domain: location.host,
      endpoint: location.origin,
      wsId: this.wsId,
      name: this.name,
      phase: settled && out.error ? "error" : settled && out.waiting ? "syncing" : this.phase,
      lastSyncMs: this.lastSyncMs,
      error: this.error ?? out.error,
      pendingDeletes: 0,
      pendingAdds: 0,
      usage: this.usage(),
      me: you.name,
      meId: you.memberId,
      can: you.can,
      superadmin: this.meta.superadmin?.name ?? null,
      workerVersion: this.meta.version,
      // A browser keeps no history of its own and mirrors none.
      versions: { mirrored: 0, cloud: 0, lastMirrorMs: null, horizonDays: null },
      public: this.pages(),
      presence: this.presence(),
      leases: this.leases(),
      spaces: this.spaces(),
    };
  }

  /** Say the status again when it is not what was last said. When it was
   *  last in step counts to the minute, and today's requests not at all:
   *  both move with every pass. */
  restate(): void {
    const status = this.status();
    const said = JSON.stringify({
      ...status,
      lastSyncMs: Math.floor((status.lastSyncMs ?? 0) / 60_000),
      usage: { ...status.usage, today: 0 },
    });
    if (said === this.said) return;
    this.said = said;
    tell(this.statusHeard, [status]);
  }

  /* ---------- Keeping in step ---------- */

  /** Read one section's manifest: all of it when the one held is not at
   *  `etag` (null: whatever it is at now), nothing when it is. */
  private async readSection(id: string, space: Space | null, etag: string | null): Promise<ReadSection> {
    const held = this.sections.get(id);
    if (held && held.etag === etag) return { id, space, etag, held, fresh: null };
    const at = id === "" ? "/api/manifest" : `/api/spaces/${id}/manifest`;
    let res: Response;
    try {
      res = await ask("GET", held ? `${at}?since=${encodeURIComponent(held.etag)}` : at);
    } catch (e) {
      // Gone since it was named: this person was taken out of it, or it was deleted.
      if (e instanceof Refused && e.status === 404 && id !== "") return { id, gone: true };
      throw e;
    }
    const now = res.headers.get("x-manifest-etag") ?? etag ?? held?.etag ?? "";
    return { id, space, etag: now, held, fresh: res.status === 304 ? null : ((await res.json()) as Manifest) };
  }

  /** Put the sections that were read in place of the ones held, and say what
   *  changed. With `only`, the sections not read are left as they are;
   *  without, they are ones this person is no longer in. */
  private adopt(read: ReadSection[], only: boolean): void {
    const before = new Map(this.sections);
    const changed: string[] = [];
    const kept = new Set<string>();
    for (const r of read) {
      if ("gone" in r) continue;
      kept.add(r.id);
      const manifest = r.fresh ?? r.held?.manifest;
      if (!manifest) continue;
      const section: Section = {
        id: r.id,
        space: r.space,
        mount: r.space ? this.mountOf(r.space) : LIBRARY_FOLDER,
        etag: r.etag,
        manifest,
        files: r.fresh ? indexOf(r.fresh, r.id === "") : (r.held as Section).files,
      };
      this.sections.set(r.id, section);
      if (!r.fresh) continue;
      const old = r.held?.files ?? new Map<string, Entry>();
      for (const [path, e] of section.files) {
        if (old.get(path)?.file.hash !== e.file.hash) changed.push(join(section.mount, path));
      }
      for (const path of old.keys()) if (!section.files.has(path)) changed.push(join(section.mount, path));
    }
    for (const [id, section] of before) {
      if (kept.has(id) || (only && !read.some((r) => r.id === id))) continue;
      changed.push(...this.drop(section, true));
    }
    // A folder made here that a document now sits in is a folder like any other.
    for (const dir of [...this.made]) if (this.holdsFiles(join(this.root, dir))) this.made.delete(dir);
    // Nothing is said of the first reading: it is what the app opens on.
    if (before.size > 0 && changed.length > 0) this.changed(changed.map((rel) => `${this.root}/${rel}`));
  }

  /** Let go of a section this person is no longer in, and answer what was
   *  in it, as the tree placed it. `said`: the app is told the folder left
   *  (it is not, of one made a moment ago and taken back). */
  private drop(section: Section, said: boolean): string[] {
    this.sections.delete(section.id);
    this.mounts.delete(section.id);
    this.entering.delete(section.id);
    if (said && section.space?.kind === "restricted") {
      tell(this.spaceLeftHeard, { root: this.root, name: section.space.name, path: section.mount });
    }
    return [...section.files.keys()].map((path) => join(section.mount, path));
  }

  /** Take in what a poll says: read every manifest that moved, drop the
   *  sections this person is no longer in, and say what changed. */
  private async take(poll: PollAnswer): Promise<void> {
    this.limits = poll.limits;
    for (const space of poll.spaces ?? []) this.entering.delete(space.id);
    // Null: the database could not say. What is held stays as it is.
    const listed = poll.spaces ?? [...this.sections.values()].flatMap((s) => (s.space ? [s.space] : []));
    const spaces = [...listed, ...[...this.entering.values()].filter((made) => !listed.some((s) => s.id === made.id))];
    const read = await Promise.all([
      this.readSection("", null, poll.manifestEtag),
      ...spaces.map((space) => this.readSection(space.id, space, space.etag)),
    ]);
    this.adopt(read, false);
    this.poll = poll;
    this.phase = "idle";
    this.error = null;
    this.lastSyncMs = Date.now();
    this.restate();
  }

  /** Read sections again now, by their ids: after a change this page made
   *  to them that it cannot work out for itself. */
  async reread(spaces: string[]): Promise<void> {
    const read = await Promise.all(
      [...new Set(spaces)].flatMap((id) => {
        const held = this.sections.get(id);
        return held ? [this.readSection(id, held.space, null)] : [];
      }),
    );
    this.adopt(read, true);
    this.restate();
  }

  /* ---------- Restricted folders ---------- */

  /** A call about a restricted folder; `gone` is what is said when the
   *  domain knows nothing of what it named. */
  private async aboutSpace<T>(asked: Promise<T>, gone: string): Promise<T> {
    try {
      return await asked;
    } catch (e) {
      if (e instanceof Refused && e.status === 404) throw new Error(gone);
      throw e;
    }
  }

  /** Make a restricted folder holding this person and `members`, and hold
   *  it from now on rather than from the next poll. `at`: where it is shown
   *  on this page, for one made by putting a folder there. */
  async makeSpace(name: string, members: string[], at?: string): Promise<CloudSpace> {
    const { space } = await askJson<{ space: Space }>("POST", "/api/spaces", { body: { name, members } });
    const mount = at === undefined ? null : this.relOf(at);
    if (mount) this.mounts.set(space.id, mount);
    this.entering.set(space.id, space);
    this.adopt([await this.readSection(space.id, space, null)], true);
    this.restate();
    const made = this.spaces().find((s) => s.id === space.id);
    if (!made) throw new Error("The folder was made, and will be here in a moment.");
    return made;
  }

  /** Add a person to a restricted folder, or take one out. Taking this
   *  person out is leaving it: it goes from this page with them. */
  async spaceMember(id: string, member: string, add: boolean): Promise<void> {
    const at = `/api/spaces/${encodeURIComponent(id)}/members/${encodeURIComponent(member)}`;
    const section = this.sections.get(id);
    if (add) {
      const { space } = await this.aboutSpace(
        askJson<{ space: Space }>("PUT", at),
        "That person is not in this workspace any more, or the folder is gone.",
      );
      if (section) section.space = space;
    } else {
      await this.aboutSpace(ask("DELETE", at), "That folder is not there any more, or you are no longer in it.");
      if (member === this.me) this.leave(id, true);
      else if (section?.space) section.space = { ...section.space, members: section.space.members.filter((m) => m !== member) };
    }
    this.restate();
  }

  /** Delete a restricted folder for everyone in it: the domain erases what
   *  it stored a request's worth at a time. `quiet`: nothing is said of its
   *  going, for one made a moment ago that is being taken back. */
  async deleteSpace(id: string, quiet = false): Promise<void> {
    for (let remaining = true; remaining; ) {
      ({ remaining } = await this.aboutSpace(
        askJson<{ remaining: boolean }>("DELETE", `/api/spaces/${encodeURIComponent(id)}`),
        "That folder is not there any more, or you are no longer in it.",
      ));
    }
    this.leave(id, !quiet);
    this.restate();
  }

  /** This person is out of a restricted folder by something done on this
   *  page: it goes now rather than at the next poll. */
  private leave(id: string, said: boolean): void {
    const section = this.sections.get(id);
    if (!section) return;
    const gone = this.drop(section, said);
    if (gone.length > 0) this.changed(gone.map((rel) => `${this.root}/${rel}`));
  }

  /**
   * Files this page wrote, as the worker says the manifest now has them
   * (`{fid, …entry}`, cloud-worker/src/webDocs.ts), put into the manifest
   * held. `over` is the manifest the write was made to: when that is the one
   * held, the one held is now at `etag` and nothing is asked for.
   */
  keep(space: string, files: (ManifestFile & { fid: string })[], etag: string, over: string): void {
    const section = this.sections.get(space);
    if (!section) return;
    for (const { fid, ...file } of files) {
      const old = section.manifest.files[fid];
      if (old && old.path !== file.path) section.files.delete(old.path);
      section.manifest.files[fid] = file;
      delete section.manifest.tombstones?.[fid];
      if (syncs(file.path) && !(space === "" && reservedTop(file.path))) section.files.set(file.path, { fid, file });
    }
    if (section.etag === over) section.etag = etag;
    for (const dir of [...this.made]) if (this.holdsFiles(join(this.root, dir))) this.made.delete(dir);
  }

  /* ---------- The beat ---------- */

  /** The document this tab is editing, as the worker is told it: its
   *  section, and its path there. Null when there is none, the last touch
   *  is no longer fresh, or the path is one the worker would not record. */
  private editing(now: number): { space: string; path: string; key: string } | null {
    if (!this.activity || now - this.activity.at >= ACTIVITY_FRESH_MS) return null;
    const place = this.place(this.activity.abs);
    if (!place || !validPath(place.path)) return null;
    return { ...place, key: `${place.space}/${place.path}` };
  }

  /** Whether the document being edited is owed a claim now: *Take over* was
   *  asked, or the last poll said nobody holds it (`claim_owed`, engine.rs).
   *  Not when the domain could not say who holds what. */
  private claimOwed(editing: { space: string; path: string }): boolean {
    if (this.taking !== null && this.taking === this.activity?.abs) return true;
    const key = editing.path.toLowerCase();
    return this.poll?.leases != null && !this.poll.leases.some((l) => l.path === key && (l.space ?? "") === editing.space);
  }

  /** Whether the next poll carries a beat: on a cadence, at once when the
   *  document being edited is another, and at once when it is there to claim. */
  private beatDue(now: number): boolean {
    const editing = this.editing(now);
    return (
      this.lastBeat === null ||
      now - this.lastBeat.at >= BEAT_MS ||
      this.lastBeat.named !== (editing?.key ?? "") ||
      (editing !== null && this.claimOwed(editing))
    );
  }

  /** Ask ahead of the clock when a beat is owed for something that just
   *  happened here — and once for it, not until the worker agrees: a claim
   *  it will not record would otherwise be asked for without end. */
  private hurry(): void {
    const now = Date.now();
    const editing = this.editing(now);
    const key = `${editing?.key ?? ""}|${this.taking ?? ""}`;
    const moved = this.lastBeat !== null && this.lastBeat.named !== (editing?.key ?? "");
    if (!this.tabs?.leading() || !(moved || (editing !== null && this.claimOwed(editing)))) return;
    if (this.hurried && this.hurried.key === key && now - this.hurried.at < BEAT_MS) return;
    this.hurried = { key, at: now };
    // After the ask that is under way, if one is: it was made before this.
    void (this.passing ?? Promise.resolve()).then(() => this.pass()).then(() => this.schedule());
  }

  /** Which document this tab is editing (its absolute path), or none. */
  setActivity(abs: string | null): void {
    if (abs === (this.activity?.abs ?? null)) return;
    this.activity = abs === null ? null : { abs, at: Date.now() };
    this.hurry();
  }

  /** A document was written here: typing is what keeps a document this
   *  browser's, not only having opened it. */
  touch(abs: string): void {
    this.activeAt = Date.now();
    if (this.activity?.abs !== abs) return;
    this.activity.at = Date.now();
    this.hurry();
  }

  /** *Take over* a document another device holds: it is the one being
   *  edited from this moment, and the next beat claims it. */
  takeOver(abs: string): void {
    this.activity = { abs, at: Date.now() };
    this.taking = abs;
    this.hurry();
  }

  /** Ask the worker whether anything moved, and take in what did; the beat
   *  rides along when one is owed. One at a time: a second ask joins the
   *  first. Only the tab that asks for its browser does (tabs.ts). */
  pass(): Promise<void> {
    if (this.tabs && !this.tabs.leading()) return Promise.resolve();
    this.passing ??= (async () => {
      try {
        const now = Date.now();
        const editing = this.editing(now);
        const taking = editing !== null && this.taking !== null && this.taking === this.activity?.abs;
        const beat = this.beatDue(now)
          ? { name: deviceName(), ...(editing ? { path: editing.path, space: editing.space } : {}), take: taking, ttl: this.beatTtl(now) }
          : null;
        const poll = await askJson<PollAnswer>(beat ? "POST" : "GET", "/api/poll", beat ? { body: beat } : {});
        if (beat) {
          // From when it was sent: the next is then owed a little early
          // rather than a poll late.
          this.lastBeat = { at: now, named: editing?.key ?? "" };
          if (taking) this.taking = null;
        }
        await this.take(poll);
        this.tabs?.tell(poll);
      } catch (e) {
        if (e instanceof Unreachable) {
          this.phase = "offline";
        } else if (e instanceof Refused && e.dailyLimit) {
          this.phase = "limited";
        } else if (e instanceof Refused && e.status === 429) {
          // Asked to slow down: nothing is wrong, it asks again later.
          this.waitUntil = Date.now() + (e.retryAfter ?? 60) * 1000;
        } else if (!(e instanceof Refused && e.status === 401)) {
          this.phase = "error";
          this.error = e instanceof Error ? e.message : String(e);
        }
        this.restate();
      } finally {
        this.passing = null;
      }
    })();
    return this.passing;
  }

  /** How long until the next ask, by attention; null while the tab has been
   *  out of sight so long that it stops asking until it is looked at again. */
  private gap(now: number): number | null {
    if (this.hiddenAt !== null && now - this.hiddenAt >= AWAY_AFTER_MS) return null;
    const idle = now - this.activeAt;
    const focused = this.hiddenAt === null && document.hasFocus();
    const gap = idle >= AWAY_AFTER_MS ? POLL_AWAY_MS : !focused || idle >= IDLE_AFTER_MS ? POLL_BACKGROUND_MS : POLL_ACTIVE_MS;
    const slow = this.usage().mode === "slow" || this.phase === "limited";
    return Math.max(slow ? Math.max(gap, POLL_BACKGROUND_MS) : gap, this.waitUntil - now);
  }

  /** How long the beat sent now holds. */
  private beatTtl(now: number): number {
    const gap = Math.max(this.gap(now) ?? POLL_AWAY_MS, BEAT_MS) * 2.5;
    return Math.min(Math.max(gap, BEAT_TTL_MIN_MS), BEAT_TTL_MAX_MS);
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!this.tabs?.leading()) return;
    const gap = this.gap(Date.now());
    if (gap !== null) this.timer = window.setTimeout(() => void this.pass().then(() => this.schedule()), gap);
  }

  /** Start keeping in step, for as long as the page lives. */
  follow(): void {
    this.tabs = tabs({
      // This tab asks for its browser from now on. Which document the
      // browser was last said to be editing is another tab's to know, so a
      // beat is owed; and what is held here may be as old as that tab's
      // last answer.
      lead: () => {
        this.lastBeat = null;
        void this.pass().then(() => this.schedule());
      },
      follow: () => this.schedule(),
      heard: (poll) => void this.take(poll).catch(() => {}),
    });
    const used = () => {
      const idle = Date.now() - this.activeAt;
      this.activeAt = Date.now();
      this.tabs?.claim();
      // Back after a while: what is on screen may be old.
      if (idle >= IDLE_AFTER_MS) void this.pass().then(() => this.schedule());
    };
    for (const event of ["pointerdown", "keydown", "wheel"]) addEventListener(event, used, { passive: true, capture: true });
    addEventListener("focus", () => {
      this.tabs?.claim();
      this.schedule();
    });
    addEventListener("blur", () => this.schedule());
    document.addEventListener("visibilitychange", () => {
      const away = this.hiddenAt !== null && Date.now() - this.hiddenAt >= POLL_BACKGROUND_MS;
      this.hiddenAt = document.hidden ? Date.now() : null;
      if (!document.hidden && away) void this.pass().then(() => this.schedule());
      else this.schedule();
    });
    // The page is going: the others stop showing this browser now rather
    // than when its last beat lapses. Best effort, and only from the tab
    // that beats; another tab of this browser beats again when it takes over.
    addEventListener("pagehide", () => {
      if (this.tabs?.leading() && this.lastBeat !== null) {
        void send("POST", "/api/poll", { body: { leave: true }, keepalive: true }).catch(() => {});
      }
    });
    this.hiddenAt = document.hidden ? Date.now() : null;
  }
}
