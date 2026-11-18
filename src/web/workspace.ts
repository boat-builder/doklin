// The browser version's picture of the workspace: what the worker last said,
// held in memory, and what the UI is told of it.
//
// A browser keeps no copy of the workspace. It holds the manifest of every
// section its person is in — the shared workspace, their Private, the
// restricted folders they are in — and reads a document's stored copy when
// the document is opened. From those and the poll it tells the UI what the
// engine tells it on a Mac: one `CloudStatus` (src/cloud.ts), the tree, and
// what changed somewhere else.
//
// Paths. The UI names a document by an absolute path, as on a disk. Here
// that is the workspace's name as a root, then the path the Mac app would
// give the same file under its folder: a section's files are under `Private`
// or `Restricted/<name>` (`PRIVATE_DIR`, `RESTRICTED_DIR`,
// engine/src/cloud/space.rs — change both), the shared workspace's at the top.

import { reservedTop, syncs } from "../../cloud-worker/src/layout";
import type { Manifest, ManifestFile } from "../../cloud-worker/src/manifest";
import type { Limits, MetaAnswer, PollAnswer, Space } from "../../cloud-worker/src/wire";
import type { DocumentChange, Rev, TreeNode, WatchedDocument } from "../backend";
import type {
  CloudAppliedEvent,
  CloudSpace,
  CloudSpaceLeftEvent,
  CloudStatus,
  CloudUsage,
  LeaseHolder,
  PresenceDevice,
  PublicPage,
} from "../cloud";
import { HTML_EXT_RE, MD_EXT_RE, META_SUFFIX, htmlSiblingOf, metaFileOf } from "../metaFile";
import { Refused, Unreachable, ask, askJson, deviceId, nextDay, usedToday } from "./http";

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

/** How many stored copies are kept in memory. The browser's own cache keeps
 *  the rest: a copy never changes under its address. */
const TEXTS_KEPT = 64;

type Entry = { fid: string; file: ManifestFile };

/** One section as this browser holds it. */
type Section = {
  /** The space's id; "" is the shared workspace. */
  id: string;
  space: Space | null;
  /** Where its files are in the tree: "" for the shared workspace. */
  mount: string;
  etag: string;
  manifest: Manifest;
  /** Its files by the path the section stores them under. */
  files: Map<string, Entry>;
};

/** What a document's text was read at: the stored copy it was. */
type Read = { fid: string; rev: number; hash: string };
const revOf = (e: Entry) => ({ fid: e.fid, rev: e.file.rev, hash: e.file.hash }) satisfies Read as unknown as Rev;

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
  private poll: PollAnswer | null = null;
  private limits: Limits;
  private phase: CloudStatus["phase"] = "idle";
  private error: string | null = null;
  private lastSyncMs: number | null = null;
  private said = "";

  private watched: WatchedDocument[] = [];
  private readonly texts = new Map<string, Promise<string>>();

  private readonly statusHeard: Listeners<CloudStatus[]> = new Set();
  private readonly changeHeard: Listeners<DocumentChange> = new Set();
  private readonly appliedHeard: Listeners<CloudAppliedEvent> = new Set();
  private readonly spaceLeftHeard: Listeners<CloudSpaceLeftEvent> = new Set();

  private timer: number | null = null;
  private passing: Promise<void> | null = null;
  private activeAt = Date.now();
  private hiddenAt: number | null = null;
  private waitUntil = 0;

  private constructor(
    private readonly meta: MetaAnswer,
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
  private nameOf(by: string): string {
    return this.people.get(by) ?? by;
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
      if (section.mount === "") continue;
      if (rel === section.mount) return { section, path: "" };
      if (rel.startsWith(`${section.mount}/`)) return { section, path: rel.slice(section.mount.length + 1) };
    }
    const shared = this.sections.get("");
    return shared && !reservedTop(rel) ? { section: shared, path: rel } : null;
  }

  /** The stored file at an absolute path, with its section. */
  private fileAt(abs: string): { section: Section; entry: Entry } | null {
    const rel = this.relOf(abs);
    const place = rel === null ? null : this.placeOf(rel);
    const entry = place?.section.files.get(place.path);
    return place && entry ? { section: place.section, entry } : null;
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

  private text(section: Section, entry: Entry): Promise<string> {
    const key = `${section.id}/${entry.fid}/${entry.file.hash}`;
    const kept = this.texts.get(key);
    if (kept) return kept;
    const at = section.id === "" ? "/api/blobs" : `/api/spaces/${section.id}/blobs`;
    const read = ask("GET", `${at}/${entry.fid}/${entry.file.hash}`).then((res) => res.text());
    this.texts.set(key, read);
    read.catch(() => this.texts.delete(key));
    if (this.texts.size > TEXTS_KEPT) this.texts.delete(this.texts.keys().next().value as string);
    return read;
  }

  /** A file's text and what it was read at. Rejects when there is none. */
  async read(abs: string): Promise<{ text: string; rev: Rev }> {
    const found = this.fileAt(abs);
    if (!found) throw new Error(`There is no document at ${this.relOf(abs) ?? abs}.`);
    return { text: await this.text(found.section, found.entry), rev: revOf(found.entry) };
  }

  /** A document's sidecar; null when it has none. */
  async sidecar(abs: string): Promise<string | null> {
    const found = this.fileAt(metaFileOf(abs));
    return found ? this.text(found.section, found.entry) : null;
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

  /* ---------- The tree ---------- */

  /** Every file as the tree places it: its workspace-relative path. */
  private *placed(): Generator<string> {
    for (const section of this.sections.values()) {
      for (const path of section.files.keys()) yield join(section.mount, path);
    }
  }

  /** Every folder there is: one holding a document, and each section's own. */
  private dirs(): Set<string> {
    const dirs = new Set<string>();
    const add = (dir: string) => {
      for (let d = dir; d !== "" && !dirs.has(d); d = dirIn(d)) dirs.add(d);
    };
    for (const section of this.sections.values()) add(section.mount);
    for (const path of this.placed()) add(dirIn(path));
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
  onSpaceLeft(cb: (e: CloudSpaceLeftEvent) => void) {
    return hear(this.spaceLeftHeard, cb);
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
    return {
      root: this.root,
      domain: location.host,
      endpoint: location.origin,
      wsId: this.wsId,
      name: this.name,
      phase: this.phase,
      lastSyncMs: this.lastSyncMs,
      error: this.error,
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
  private say(): void {
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

  /** Take in what a poll says: read every manifest that moved, drop the
   *  sections this person is no longer in, and say what changed. */
  private async take(poll: PollAnswer): Promise<void> {
    this.limits = poll.limits;
    // Null: the database could not say. What is held stays as it is.
    const spaces = poll.spaces ?? [...this.sections.values()].flatMap((s) => (s.space ? [s.space] : []));
    const wanted: { id: string; space: Space | null; etag: string }[] = [
      { id: "", space: null, etag: poll.manifestEtag },
      ...spaces.map((space) => ({ id: space.id, space, etag: space.etag })),
    ];
    const before = new Map([...this.sections].map(([id, s]) => [id, s] as const));
    const read = await Promise.all(
      wanted.map(async (w) => {
        const held = this.sections.get(w.id);
        if (held && held.etag === w.etag) return { ...w, held, fresh: null };
        const at = w.id === "" ? "/api/manifest" : `/api/spaces/${w.id}/manifest`;
        let res: Response;
        try {
          res = await ask("GET", held ? `${at}?since=${encodeURIComponent(held.etag)}` : at);
        } catch (e) {
          // Gone since the poll named it: taken out of it, or it was deleted.
          if (e instanceof Refused && e.status === 404 && w.space) return { ...w, held: undefined, fresh: null, gone: true };
          throw e;
        }
        const etag = res.headers.get("x-manifest-etag") ?? w.etag;
        return { ...w, etag, held, fresh: res.status === 304 ? null : ((await res.json()) as Manifest) };
      }),
    );

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
        mount: r.space ? this.mountOf(r.space) : "",
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
      if (kept.has(id)) continue;
      this.sections.delete(id);
      this.mounts.delete(id);
      for (const path of section.files.keys()) changed.push(join(section.mount, path));
      if (section.space?.kind === "restricted") {
        tell(this.spaceLeftHeard, { root: this.root, name: section.space.name, path: section.mount });
      }
    }

    this.poll = poll;
    this.phase = "idle";
    this.error = null;
    this.lastSyncMs = Date.now();
    // Nothing is said of the first reading: it is what the app opens on.
    if (before.size > 0 && changed.length > 0) {
      tell(this.appliedHeard, { root: this.root, paths: changed });
      for (const rel of changed) {
        const file = `${this.root}/${rel}`;
        for (const doc of this.watched) {
          if (file === doc.path) tell(this.changeHeard, { path: doc.path, part: "text" });
          else if (file === metaFileOf(doc.path)) tell(this.changeHeard, { path: doc.path, part: "meta" });
          else if (doc.rendition !== null && file === doc.rendition) {
            tell(this.changeHeard, { path: doc.path, part: "rendition" });
          }
        }
      }
    }
    this.say();
  }

  /** Ask the worker whether anything moved, and take in what did. One at a
   *  time: a second ask joins the first. */
  pass(): Promise<void> {
    this.passing ??= (async () => {
      try {
        await this.take(await askJson<PollAnswer>("GET", "/api/poll"));
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
        this.say();
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

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    const gap = this.gap(Date.now());
    this.timer = gap === null ? null : window.setTimeout(() => void this.pass().then(() => this.schedule()), gap);
  }

  /** Start keeping in step, for as long as the page lives. */
  follow(): void {
    const used = () => {
      const idle = Date.now() - this.activeAt;
      this.activeAt = Date.now();
      // Back after a while: what is on screen may be old.
      if (idle >= IDLE_AFTER_MS) void this.pass().then(() => this.schedule());
    };
    for (const event of ["pointerdown", "keydown", "wheel"]) addEventListener(event, used, { passive: true, capture: true });
    addEventListener("focus", () => this.schedule());
    addEventListener("blur", () => this.schedule());
    document.addEventListener("visibilitychange", () => {
      const away = this.hiddenAt !== null && Date.now() - this.hiddenAt >= POLL_BACKGROUND_MS;
      this.hiddenAt = document.hidden ? Date.now() : null;
      if (!document.hidden && away) void this.pass().then(() => this.schedule());
      else this.schedule();
    });
    this.hiddenAt = document.hidden ? Date.now() : null;
    this.schedule();
  }
}
