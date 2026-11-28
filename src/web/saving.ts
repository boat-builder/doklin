// What this page changes, and how it reaches the worker.
//
// A save is taken at once and sent a little later. The app saves a document
// every time the typing pauses, which on a Mac is a write to disk and here
// would be a request to the worker each time; so what it hands over waits
// here — read back by anything that reads the document meanwhile — and goes
// when the typing has settled, at most so often for one document, and at
// once when the page is left. This is what the disk is on a Mac, and the
// send is what the engine's sync is.
//
// Every send goes over the stored copy the text was made from (`ifRev`). One
// the worker refuses because the document moved on is not sent again as it
// is: the other version is read, the two are merged against the text both
// started from (merge.ts), and the result is sent over theirs. Changes that
// overlap are not merged: ours stays the document and theirs is written
// beside it as a conflict copy — what the engine does on a Mac
// (`apply_remote`, engine/src/cloud/unit.rs). Nothing is ever written over a
// version nobody here has read.
//
// What waits is also kept in this browser's storage, so a tab that closes
// before its last save went, or could not send it, loses nothing: the next
// time the workspace is opened in this browser it is sent then. A request
// made as the tab closes may carry 64 KB and no more.
//
// The other changes — a new document, a move, a copy, a delete — are asked
// of the worker when they are made, after anything waiting for what they
// touch has gone. One of them is more than one request: a folder too large
// for the worker to carry between sections at once, which it moves in parts
// and this page asks for until none is left. Sharing a folder is that move,
// to the top of the share just made for it.

import type { ManifestFile } from "../../cloud-worker/src/manifest";
import type { Space } from "../../cloud-worker/src/wire";
import { documentStem, type CloudSpace } from "../cloud";
import {
  SaveConflict,
  type DocumentText,
  type EntryKind,
  type LeftBehind,
  type OpenedDocument,
  type Removed,
  type Rev,
  type Saved,
} from "../backend";
import { MD_EXT_RE, htmlSiblingOf, metaFileOf } from "../metaFile";
import { KEEPALIVE_BYTES, Refused, Unreachable, ask, askJson, send } from "./http";
import { conflictCopyNames, mergeMeta, mergeText } from "./merge";
import type { StoredFile, Workspace } from "./workspace";

/** A save goes this long after the last one handed over for its document… */
const SETTLE_MS = 2000;
/** …and no sooner than this after the one before it. */
const EVERY_MS = 10_000;
/** How long until a save is tried again: one the domain did not answer, one
 *  it could not take just then, and one made after the account's requests
 *  for the day ran out. A save it refused outright waits for the next one
 *  made here: the same text would be refused the same way. */
const RETRY_MS = 15_000;
const RETRY_REFUSED_MS = 60_000;
const RETRY_LIMITED_MS = 5 * 60_000;
/** How many times one send is made over a document that keeps moving on. */
const ATTEMPTS = 4;

/** Where what waits is kept: `<prefix><workspace>:<person>:<tab>:<path>`. */
const DRAFTS = "doklin:web:draft:";
/** Held by a tab for as long as it lives: what it keeps is its own to send. */
const TAB_LOCK = "doklin:web:tab:";
/** Held while a tab takes over what closed tabs left. */
const DRAFTS_LOCK = "doklin:web:drafts";

/** What is said of a place the browser version does not change: a section itself… */
const IN_THE_APP = "That is done in the Doklin app, not in a browser.";
/** …and of one that is in no section, which nothing syncs. */
const IN_NO_SECTION = "That would be in no section: a browser keeps only what is in Library, in My files or shared.";
/** What can be shared, said of anything else. */
const NOT_SHAREABLE =
  "Only a folder or a document in My files, or in a folder shared with you, can be shared. Nothing in Library is shared separately: it is everyone's.";
/** What somebody a share is shared with is told when they would move it. */
const NOT_YOURS_TO_MOVE =
  "This is shared with you, and sits where its owner keeps it: only they move it. Copy it to My files to have one of your own.";

/** Why something failed, as a sentence that ends. */
const whyOf = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/[.]?$/, ".");

/** A folder moving between sections stopped part of the way: `moved` of its
 *  files are where they were going, and `left` are where they were. */
class Partway extends Error {
  constructor(
    readonly moved: number,
    readonly left: number,
    readonly why: string,
  ) {
    super(`${moved} of ${moved + left} files were moved before it stopped: ${why} Move it again to move the rest.`);
    this.name = "Partway";
  }
}

/** A share was made and only some of its files reached it: said as it is,
 *  and the share stays. */
class Carried extends Error {}

/** Where something is: a section, and the path as that section stores it —
 *  "" the section's own top. */
type Place = { space: string; path: string };

/** What `POST /api/web/move` answers: the files it moved, and, of a folder
 *  it is moving between sections in parts, how many it has yet to. */
type MovedAnswer = { files: number; remaining?: number };

/** A stored copy, as far as a save needs to know it. */
type Copy = { fid: string; rev: number; hash: string };
const copyOf = (f: StoredFile | null): Copy | null => (f ? { fid: f.fid, rev: f.file.rev, hash: f.file.hash } : null);

/** One file as this page holds it: a note's text, or its sidecar. */
type Held = {
  /** What a `Rev` names. It moves whenever the text a read here would give
   *  changes: a save, a change taken in from somewhere else, a merge. */
  mark: number;
  /** The stored copy last read or written here: what the next save goes
   *  over. Null: there was no file. */
  at: Copy | null;
  /** The text waiting to go over `at`; null when nothing waits. */
  out: string | null;
  /** `at`'s text while something waits: what a merge is made against. Null
   *  inside it: there is nothing to merge against. */
  base: Promise<string | null> | null;
};

/** A document with something waiting to go. */
type Waiting = {
  timer: number | null;
  savedAt: number;
  sentAt: number;
  retryAt: number;
  sending: Promise<void> | null;
  /** The request under way, when it would not outlive the page. */
  flying: { url: string; body: unknown } | null;
  /** Why the last send did not land, as a sentence. */
  error: string | null;
  /** The worker refused it for good: not sent again until it is saved again. */
  stuck: boolean;
  /** The other version already kept as a conflict copy, by its hash. */
  copied: string | null;
};

/** What `PUT /api/web/doc` answers (cloud-worker/src/webDocs.ts). */
type SavedAnswer = { md?: ManifestFile & { fid: string }; meta?: ManifestFile & { fid: string }; etag: string; over: string };

type Draft = { text?: string; over?: Copy | null; meta?: string; metaOver?: Copy | null };

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const dirname = (path: string): string => path.slice(0, path.lastIndexOf("/"));
/** Whether a file is of the item at `item`: a folder's own path and what
 *  is under it, or a document's files — `item` is then its path without an
 *  extension. */
const under =
  (item: string) =>
  (file: string): boolean =>
    file === item || file.startsWith(`${item}/`) || documentStem(file) === item;
const bytesOf = (body: unknown): number => new TextEncoder().encode(JSON.stringify(body)).length;
const markOf = (rev: Rev): number => (rev as unknown as { mark: number }).mark;
const isCopy = (c: unknown): c is Copy => {
  const copy = c as Copy | null;
  return !!copy && typeof copy.fid === "string" && typeof copy.rev === "number" && typeof copy.hash === "string";
};

/** A document's own files: its text, its sidecar, and the rendition beside a
 *  markdown one. */
const filesOf = (path: string): string[] => [path, metaFileOf(path), ...(MD_EXT_RE.test(path) ? [htmlSiblingOf(path)] : [])];

export class Saving {
  private marks = 0;
  /** By a file's absolute path. */
  private readonly held = new Map<string, Held>();
  /** By a document's absolute path. */
  private readonly docs = new Map<string, Waiting>();
  /** When each document was last sent, for as long as that paces the next. */
  private readonly sent = new Map<string, number>();
  /** Bytes of requests under way that outlive the page. */
  private aloft = 0;
  /** This tab, to the others of its browser; and whether what waits is
   *  kept in the browser's storage (it is where tabs can tell each other
   *  apart). */
  private readonly tab = Math.random().toString(36).slice(2, 10);
  private drafts = false;
  /** The page is going by `reload`, with what waits kept for the next. */
  private reloading = false;
  /** Hands over what the app still holds: the text typed since its last save. */
  private handOver: () => unknown = () => {};
  /** A share's files are being carried into it: one carry at a time. */
  private carrying = false;

  constructor(private readonly ws: Workspace) {
    ws.setOutbox(() => {
      let error: string | null = null;
      for (const doc of this.docs.values()) error ??= doc.error;
      return { waiting: this.docs.size > 0, error };
    });
    // A share whose files were not all carried into it — the page closed, or
    // the domain stopped answering — has the rest carried as soon as an
    // answer shows some left: nobody has to ask twice.
    ws.onTaken(() => void this.carryLeft());
    // Something no longer shared with this person, or deleted: what waited
    // for a document in it has nowhere to go, as a Mac's copy of it is
    // deleted with what was in it.
    ws.onSpaceLeft((e) => this.forget(under(`${e.root}/${e.path}`)));
    // Something shared is somewhere else in the tree: what is held for its
    // documents, and what waits for them, is theirs where they are now.
    ws.onSpaceMoved((e) => {
      for (const move of e.moves) {
        const [from, to] = [`${e.root}/${move.from}`, `${e.root}/${move.to}`];
        const there = (path: string) =>
          path === from ? to : move.dir && path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : null;
        for (const [path, doc] of [...this.docs]) {
          const now = there(path);
          if (now === null) continue;
          this.docs.delete(path);
          this.dropDraft(path);
          this.docs.set(now, doc);
        }
        for (const [file, h] of [...this.held]) {
          const now = there(file);
          if (now === null) continue;
          this.held.delete(file);
          this.held.set(now, h);
        }
        for (const path of this.docs.keys()) if (there(path) === null && path.startsWith(`${to}`)) this.keepDraft(path);
      }
    });
    // A document with something waiting changed somewhere else: the two are
    // put together now, rather than when its turn to be sent comes.
    ws.onApplied(({ paths }) => {
      const files = new Set(paths.map((rel) => `${ws.root}/${rel}`));
      for (const path of this.docs.keys()) {
        if (files.has(path) || files.has(metaFileOf(path))) void this.push(path);
      }
    });
  }

  /* ---------- Reading ---------- */

  private space(file: string): string {
    return this.ws.place(file)?.space ?? "";
  }

  private heldOf(file: string): Held {
    let h = this.held.get(file);
    if (!h) {
      h = { mark: (this.marks += 1), at: copyOf(this.ws.stored(file)), out: null, base: null };
      this.held.set(file, h);
    }
    return h;
  }

  /** Bring a file nothing waits for in step with the stored copy: one whose
   *  content is not what was last read here is another text. */
  private settle(h: Held, file: string): void {
    if (h.out !== null) return;
    const now = copyOf(this.ws.stored(file));
    if (now?.hash !== h.at?.hash) h.mark = this.marks += 1;
    h.at = now;
  }

  /** A stored copy's text, or null when it cannot be had: a copy no
   *  manifest names any more is collected after a day. */
  private baseOf(file: string, at: Copy | null): Promise<string | null> {
    if (!at) return Promise.resolve(null);
    return this.ws.textOf({ space: this.space(file), fid: at.fid, hash: at.hash }).catch(() => null);
  }

  /** A document's text and what it was read at: what waits to be sent, when
   *  something does. Rejects when there is none. */
  async read(path: string): Promise<DocumentText> {
    const h = this.heldOf(path);
    this.settle(h, path);
    const rev = { mark: h.mark } as unknown as Rev;
    if (h.out !== null) return { text: h.out, rev };
    const at = this.ws.stored(path);
    if (!at) throw new Error(`There is no document at ${this.ws.rel(path) ?? path}.`);
    return { text: await this.ws.textOf({ space: at.space, fid: at.fid, hash: at.file.hash }), rev };
  }

  /** A document's sidecar; null when it has none. */
  async meta(path: string): Promise<string | null> {
    const file = metaFileOf(path);
    const h = this.heldOf(file);
    this.settle(h, file);
    if (h.out !== null) return h.out;
    const at = this.ws.stored(file);
    return at ? this.ws.textOf({ space: at.space, fid: at.fid, hash: at.file.hash }) : null;
  }

  async open(path: string): Promise<OpenedDocument> {
    const doc = await this.read(path);
    return { ...doc, meta: await this.meta(path), rendition: this.ws.renditionOf(path) };
  }

  exists(path: string): boolean {
    return this.ws.exists(path) || this.held.get(path)?.out != null;
  }

  /* ---------- Saving ---------- */

  private put(h: Held, file: string, text: string): void {
    if (h.out === null) h.base = this.baseOf(file, h.at);
    if (h.out === text) return;
    h.out = text;
    h.mark = this.marks += 1;
  }

  private waiting(path: string): boolean {
    return this.held.get(path)?.out != null || this.held.get(metaFileOf(path))?.out != null;
  }

  /**
   * Take a save. Everything here happens before anything is awaited: a save
   * made as the page goes is waiting by the time the page asks what is left
   * to send. The text is refused, with `SaveConflict`, when it was made from
   * a text that is no longer the one here.
   */
  save(path: string, parts: { text?: string; meta?: string }, over: Rev | null): Promise<Saved> {
    let rev: Rev | null = null;
    try {
      if (parts.text !== undefined) {
        const h = this.heldOf(path);
        this.settle(h, path);
        if (over !== null && markOf(over) !== h.mark) throw new SaveConflict({ mark: h.mark } as unknown as Rev);
        this.put(h, path, parts.text);
        rev = { mark: h.mark } as unknown as Rev;
      }
      if (parts.meta !== undefined) {
        const file = metaFileOf(path);
        this.put(this.heldOf(file), file, parts.meta);
      }
    } catch (e) {
      return Promise.reject(e);
    }
    this.wait(path);
    this.ws.touch(path);
    return Promise.resolve({ rev });
  }

  /** Something waits for a document: keep it, and send it when its turn comes. */
  private wait(path: string): void {
    if (!this.waiting(path)) return;
    let doc = this.docs.get(path);
    if (!doc) {
      const now = Date.now();
      for (const [sent, at] of this.sent) if (now - at >= EVERY_MS) this.sent.delete(sent);
      doc = { timer: null, savedAt: 0, sentAt: this.sent.get(path) ?? 0, retryAt: 0, sending: null, flying: null, error: null, stuck: false, copied: null };
      this.docs.set(path, doc);
    }
    doc.savedAt = Date.now();
    doc.retryAt = 0;
    doc.stuck = false;
    this.keepDraft(path);
    if (!doc.sending) this.schedule(path, doc);
    this.ws.restate();
  }

  private schedule(path: string, doc: Waiting): void {
    if (doc.timer !== null) clearTimeout(doc.timer);
    const due = Math.max(doc.savedAt + SETTLE_MS, doc.sentAt + EVERY_MS, doc.retryAt);
    doc.timer = window.setTimeout(() => void this.push(path), Math.max(0, due - Date.now()));
  }

  /** Send what waits for a document now. One send at a time: a second ask
   *  joins the first, and what was handed over meanwhile goes after it. */
  private push(path: string, leaving = false): Promise<void> {
    const doc = this.docs.get(path);
    if (!doc) return Promise.resolve();
    if (doc.timer !== null) clearTimeout(doc.timer);
    doc.timer = null;
    doc.sending ??= this.send(path, doc, leaving)
      .then(
        () => {
          doc.error = null;
          doc.retryAt = 0;
        },
        (e: unknown) => {
          // A domain that is not answering is not a save gone wrong: the
          // status says it is offline, and the save waits.
          const offline = e instanceof Unreachable;
          const limited = e instanceof Refused && e.dailyLimit;
          doc.error = offline ? null : `${basename(path)} isn’t saved yet. ${whyOf(e)}`;
          doc.stuck = e instanceof Refused && e.status < 500 && e.status !== 429 && !limited;
          doc.retryAt = Date.now() + (offline ? RETRY_MS : limited ? RETRY_LIMITED_MS : RETRY_REFUSED_MS);
        },
      )
      .finally(() => {
        doc.sending = null;
        doc.flying = null;
        // Removed, or moved, while the send was under way: no longer this one's.
        if (this.docs.get(path) !== doc) return;
        this.keepDraft(path);
        if (!this.waiting(path)) this.docs.delete(path);
        else if (!doc.stuck) this.schedule(path, doc);
        this.ws.restate();
      });
    return doc.sending;
  }

  private async send(path: string, doc: Waiting, leaving: boolean): Promise<void> {
    const metaPath = metaFileOf(path);
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const text = this.held.get(path);
      const meta = this.held.get(metaPath);
      // What is known to have moved on is caught up with before anything goes.
      if (text) await this.reconcile(path, text, "text", doc);
      if (meta) await this.reconcile(metaPath, meta, "meta", doc);
      const sent = { text: text?.out ?? null, meta: meta?.out ?? null };
      if (sent.text === null && sent.meta === null) return;
      const place = this.ws.place(path);
      if (!place || place.path === "") throw new Error("The folder it was in is no longer one you can open.");
      const body = {
        ...(text && sent.text !== null ? { md: { text: sent.text, ifRev: text.at?.rev ?? null } } : {}),
        ...(meta && sent.meta !== null ? { meta: { text: sent.meta, ifRev: meta.at?.rev ?? null } } : {}),
      };
      const url = `/api/web/doc?space=${encodeURIComponent(place.space)}&path=${encodeURIComponent(place.path)}`;
      const size = bytesOf(body);
      const keepalive = leaving && this.aloft + size <= KEEPALIVE_BYTES;
      doc.sentAt = Date.now();
      this.sent.set(path, doc.sentAt);
      doc.flying = keepalive ? null : { url, body };
      if (keepalive) this.aloft += size;
      let answer: SavedAnswer;
      try {
        answer = await askJson<SavedAnswer>("PUT", url, { body, keepalive });
      } catch (e) {
        if (!(e instanceof Refused && e.status === 409)) throw e;
        // It moved on, and the manifest held here does not say so yet.
        await this.ws.reread([place.space]);
        continue;
      } finally {
        if (keepalive) this.aloft -= size;
      }
      this.ws.keep(place.space, [answer.md, answer.meta].flatMap((f) => f ?? []), answer.etag, answer.over);
      if (text && sent.text !== null && answer.md) this.landed(text, sent.text, place.space, answer.md);
      if (meta && sent.meta !== null && answer.meta) this.landed(meta, sent.meta, place.space, answer.meta);
      return;
    }
    throw new Error("It kept changing somewhere else.");
  }

  /** A file's text was written: it is the stored copy now. What was handed
   *  over while it went waits on, over what was just written. */
  private landed(h: Held, text: string, space: string, file: ManifestFile & { fid: string }): void {
    h.at = { fid: file.fid, rev: file.rev, hash: file.hash };
    void this.ws.textOf({ space, ...h.at }, text);
    if (h.out === text) {
      h.out = null;
      h.base = null;
    } else {
      h.base = Promise.resolve(text);
    }
  }

  /**
   * Put what waits for a file in step with its stored copy before it is
   * sent. Where the copy is the one the text was made from there is nothing
   * to do. Where it is another, the two are merged; where they overlap, the
   * other is kept beside the document and ours stays as it is.
   */
  private async reconcile(file: string, h: Held, kind: "text" | "meta", doc: Waiting): Promise<void> {
    for (;;) {
      const ours = h.out;
      if (ours === null) return;
      const stored = this.ws.stored(file);
      const now = copyOf(stored);
      if (now?.hash === h.at?.hash) {
        h.at = now;
        return;
      }
      if (!stored) {
        // Deleted somewhere else after it was changed here: what was
        // changed here is kept, as a new file.
        h.at = null;
        h.base = Promise.resolve(null);
        return;
      }
      const theirs = await this.ws.textOf({ space: stored.space, fid: stored.fid, hash: stored.file.hash });
      const base = await h.base;
      // Handed over again while those were read: start from what is here now.
      if (h.out !== ours) continue;
      let merged: string;
      if (kind === "meta") {
        merged = mergeMeta(base, ours, theirs, (fid) => this.ws.pathOfFile("", fid) !== null);
      } else {
        const both = ours === theirs ? ours : base === null ? null : mergeText(base, ours, theirs);
        if (both === null && doc.copied !== stored.file.hash) {
          await this.keepCopy(file, stored, theirs);
          doc.copied = stored.file.hash;
          if (h.out !== ours) continue;
        }
        merged = both ?? ours;
      }
      h.at = now;
      if (merged === theirs) {
        h.out = null;
        h.base = null;
      } else {
        h.out = merged;
        h.base = Promise.resolve(theirs);
      }
      if (merged !== ours) {
        // Another text than the app last handed over: it reads it again.
        h.mark = this.marks += 1;
        this.ws.changed([file]);
      }
      return;
    }
  }

  /** Write the other version of a document beside it, under a name that
   *  says whose it is and when, and say so. */
  private async keepCopy(file: string, stored: StoredFile, theirs: string): Promise<void> {
    const named = stored.file.by === undefined ? "" : this.ws.nameOf(stored.file.by);
    // A name nobody can read helps nobody: an id is "someone".
    const who = named === stored.file.by ? "" : named;
    for (const name of conflictCopyNames(basename(file), who)) {
      const copy = `${dirname(file)}/${name}`;
      const place = this.ws.place(copy);
      if (!place || this.ws.exists(copy)) continue;
      let answer: SavedAnswer;
      try {
        answer = await askJson<SavedAnswer>(
          "PUT",
          `/api/web/doc?space=${encodeURIComponent(place.space)}&path=${encodeURIComponent(place.path)}`,
          { body: { md: { text: theirs, ifRev: null } } },
        );
      } catch (e) {
        // Taken a moment ago: the next name.
        if (e instanceof Refused && e.status === 409) continue;
        throw e;
      }
      if (answer.md) {
        this.ws.keep(place.space, [answer.md], answer.etag, answer.over);
        void this.ws.textOf({ space: place.space, fid: answer.md.fid, hash: answer.md.hash }, theirs);
      }
      this.ws.changed([copy]);
      this.ws.conflicted({
        root: this.ws.root,
        path: this.ws.rel(file) ?? file,
        by: who || "someone",
        conflictPath: this.ws.rel(copy) ?? copy,
      });
      return;
    }
    throw new Error("The other version could not be kept beside it.");
  }

  /** Send everything waiting under a path, and wait for it to land. Rejects
   *  when something could not be sent. */
  private async land(under: (path: string) => boolean): Promise<void> {
    for (const [path, doc] of [...this.docs]) {
      if (!under(path)) continue;
      while (this.docs.get(path) === doc && this.waiting(path)) {
        await this.push(path);
        if (doc.error) throw new Error(doc.error);
        if (doc.retryAt > 0) throw new Unreachable();
      }
    }
  }

  /** Send what waits for a document, or for every document under a folder —
   *  for every document, with no path — and wait for it to land, the text
   *  the app still holds included: for what needs the workspace to have it
   *  first. Rejects when something could not be sent. */
  async flush(path?: string): Promise<void> {
    await this.handOver();
    await this.land(path === undefined ? () => true : under(path));
  }

  /** Let go of everything that waits, drafts and all: the sign-in has
   *  ended, and with it anywhere to send them. */
  drop(): void {
    this.forget(() => true);
  }

  /** Reload the page. The page that comes back sends what waits (`recover`),
   *  so this one goes without asking — unless this browser keeps nothing,
   *  when it asks as a closing tab does. */
  reload(): void {
    this.reloading = this.drafts;
    location.reload();
  }

  /** Let go of everything held under a path: it is being removed. */
  private forget(under: (file: string) => boolean): void {
    for (const [path, doc] of [...this.docs]) {
      if (!under(path)) continue;
      if (doc.timer !== null) clearTimeout(doc.timer);
      this.docs.delete(path);
      this.dropDraft(path);
    }
    for (const file of [...this.held.keys()]) if (under(file)) this.held.delete(file);
    this.ws.restate();
  }

  /* ---------- What waits, kept across a reload ---------- */

  private draftKey(path: string): string {
    return `${DRAFTS}${this.ws.wsId}:${this.ws.me}:${this.tab}:${path}`;
  }

  private dropDraft(path: string): void {
    if (!this.drafts) return;
    try {
      localStorage.removeItem(this.draftKey(path));
    } catch {
      // nothing was kept
    }
  }

  /** Keep what waits for a document where a reload finds it; drop it once
   *  nothing does. A browser that will not keep it (private browsing, a
   *  full store) is one whose closing tab asks first, like any other. */
  private keepDraft(path: string): void {
    if (!this.drafts) return;
    const text = this.held.get(path);
    const meta = this.held.get(metaFileOf(path));
    if (text?.out == null && meta?.out == null) return this.dropDraft(path);
    const draft: Draft = {
      ...(text?.out != null ? { text: text.out, over: text.at } : {}),
      ...(meta?.out != null ? { meta: meta.out, metaOver: meta.at } : {}),
    };
    try {
      localStorage.setItem(this.draftKey(path), JSON.stringify(draft));
    } catch {
      this.dropDraft(path);
    }
  }

  /**
   * Take over what tabs that are gone left waiting: each is sent from here,
   * over the copy it was made from, like any save. Asked once, before the
   * app reads anything, so a document it opens shows what was typed. A tab
   * still open keeps its own.
   */
  async recover(): Promise<void> {
    const locks = typeof navigator.locks === "object" ? navigator.locks : null;
    if (!locks) return;
    await new Promise<void>((held) => {
      void locks.request(`${TAB_LOCK}${this.tab}`, () => {
        this.drafts = true;
        held();
        return new Promise<never>(() => {});
      });
    });
    await locks.request(DRAFTS_LOCK, async () => {
      const live = new Set(((await locks.query()).held ?? []).map((l) => l.name));
      const mine = `${DRAFTS}${this.ws.wsId}:${this.ws.me}:`;
      const keys: string[] = [];
      try {
        for (let i = 0; i < localStorage.length; i += 1) {
          const key = localStorage.key(i);
          if (key?.startsWith(mine)) keys.push(key);
        }
      } catch {
        return;
      }
      for (const key of keys) {
        const rest = key.slice(mine.length);
        const tab = rest.slice(0, rest.indexOf(":"));
        const path = rest.slice(tab.length + 1);
        if (live.has(`${TAB_LOCK}${tab}`)) continue;
        let draft: Draft | null = null;
        try {
          draft = JSON.parse(localStorage.getItem(key) ?? "null") as Draft | null;
          localStorage.removeItem(key);
        } catch {
          // unreadable: nothing to take over
        }
        if (draft) this.adopt(path, draft);
      }
    });
  }

  private adopt(path: string, draft: Draft): void {
    const place = this.ws.place(path);
    if (!place || place.path === "") return;
    const take = (file: string, text: unknown, over: unknown) => {
      if (typeof text !== "string") return;
      const h = this.heldOf(file);
      h.at = isCopy(over) ? { fid: over.fid, rev: over.rev, hash: over.hash } : null;
      h.base = this.baseOf(file, h.at);
      h.out = text;
      h.mark = this.marks += 1;
    };
    take(path, draft.text, draft.over);
    take(metaFileOf(path), draft.meta, draft.metaOver);
    this.wait(path);
  }

  /* ---------- Leaving ---------- */

  /** What hands over the text the app still holds, asked as the page goes. */
  onLeave(flush: () => unknown): () => void {
    this.handOver = flush;
    return () => {
      if (this.handOver === flush) this.handOver = () => {};
    };
  }

  private pushAll(leaving: boolean): void {
    for (const path of [...this.docs.keys()]) void this.push(path, leaving);
  }

  /**
   * Send what waits whenever the page is left: at once when it loses the
   * person's attention, and as requests that outlive it when it goes out of
   * sight or closes. A tab closed while something still waits asks first.
   */
  attend(): void {
    const hand = () => {
      try {
        void this.handOver();
      } catch {
        // what the app could not hand over is the app's to say
      }
    };
    addEventListener("blur", () => {
      hand();
      this.pushAll(false);
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) return;
      hand();
      this.pushAll(true);
    });
    addEventListener("pagehide", () => {
      hand();
      this.pushAll(true);
      // A request made before the page began to go is dropped with it: made
      // again, as one that is not. Whichever lands, the other is refused.
      for (const doc of this.docs.values()) {
        if (!doc.flying) continue;
        const size = bytesOf(doc.flying.body);
        if (this.aloft + size > KEEPALIVE_BYTES) continue;
        this.aloft += size;
        void send("PUT", doc.flying.url, { body: doc.flying.body, keepalive: true })
          .catch(() => {})
          .finally(() => (this.aloft -= size));
      }
    });
    addEventListener("beforeunload", (e) => {
      hand();
      if (this.docs.size === 0 || this.reloading) return;
      this.pushAll(false);
      e.preventDefault();
      // What the browsers that predate `preventDefault` here ask for.
      e.returnValue = "";
    });
  }

  /* ---------- The tree's changes ---------- */

  /** Where a path is, for a change to it; rejects for a place the browser
   *  version does not change: a section itself, or outside every section. */
  private placed(path: string): Place {
    const place = this.ws.place(path);
    if (!place) throw new Error(IN_NO_SECTION);
    if (place.path === "") throw new Error(IN_THE_APP);
    return place;
  }

  async create(path: string, kind: EntryKind): Promise<void> {
    const place = this.placed(path);
    if (this.exists(path)) throw new Error(`${basename(path)} is already there.`);
    if (kind === "dir") return this.ws.makeFolder(path);
    const answer = await askJson<SavedAnswer>(
      "PUT",
      `/api/web/doc?space=${encodeURIComponent(place.space)}&path=${encodeURIComponent(place.path)}`,
      { body: { md: { text: "", ifRev: null } } },
    );
    if (!answer.md) return;
    this.ws.keep(place.space, [answer.md], answer.etag, answer.over);
    void this.ws.textOf({ space: place.space, fid: answer.md.fid, hash: answer.md.hash }, "");
  }

  async move(from: string, to: string, kind: EntryKind): Promise<LeftBehind[]> {
    // Something shared is still that share wherever it goes (`moveShare`).
    const own = this.ws.shareAt(from, kind === "dir" ? "dir" : "file");
    if (own) await this.moveShare(own, from, to, kind);
    else await this.carry(from, this.placed(from), to, this.placed(to), kind);
    return [];
  }

  /**
   * Rename or move something shared — what a Mac's engine makes of the same
   * rename or move on its disk (`moved_share`, engine/src/cloud/engine.rs).
   * A new name is its name for everyone. Moved inside the section it sits
   * in, that section says where it sits now. Moved into another folder of
   * its owner's, or another shared folder, it sits there from now on, and
   * that folder's people open it too. Moved into Library it is everyone's:
   * its files become Library's, and the share ends.
   */
  private async moveShare(space: Space, from: string, to: string, kind: EntryKind): Promise<void> {
    await this.land(under(kind === "dir" ? from : documentStem(from)));
    const renamed = basename(to) !== basename(from);
    if (dirname(to) !== dirname(from)) {
      const dest = this.ws.place(dirname(to));
      if (!dest) throw new Error(IN_NO_SECTION);
      if (space.parent === null) throw new Error(NOT_YOURS_TO_MOVE);
      if (dest.space === "") return this.endShare(space, from, to, kind);
      await this.ws.placeShare(space.id, dest.space, dest.path);
    }
    if (!renamed) return;
    if (kind === "dir") return this.ws.renameShare(space.id, basename(to));
    // A document's name is its files': renamed in its own section, where
    // the tree shows it under the name it now has.
    const a = this.placed(this.ws.itemAt(space.id) + basename(from).slice(basename(documentStem(from)).length));
    await this.carry(from, a, to, { space: space.id, path: basename(to) }, kind, false);
  }

  /** A share moved into Library: everything in it is carried there, to
   *  `to`, and the share — which then holds nothing — is erased. */
  private async endShare(space: Space, from: string, to: string, kind: EntryKind): Promise<void> {
    const dest = this.placed(to);
    if (kind !== "dir") {
      await this.carry(from, this.placed(from), to, dest, kind);
    } else {
      for (const top of this.ws.topOf(space.id)) {
        const a = { space: space.id, path: top.name };
        const b = { space: dest.space, path: `${dest.path}/${top.name}` };
        await this.carry(`${from}/${top.name}`, a, `${to}/${top.name}`, b, top.dir ? "dir" : "file");
      }
      this.ws.movedFolder(from, to);
    }
    await this.ws.deleteShare(space.id, true);
  }

  /** Move what is at `from` (`a`) to `to` (`b`), once anything waiting for
   *  it has gone; what is held follows it. A folder that is more than the
   *  worker carries between sections in one request is asked for until none
   *  of it is left (`remaining`, cloud-worker/src/changes.ts), and rejects
   *  with `Partway` when it stops after some of it went. */
  private async carry(from: string, a: Place, to: string, b: Place, kind: EntryKind, empty = true): Promise<void> {
    const under = (path: string) => path === from || (kind === "dir" && path.startsWith(`${from}/`));
    if (empty && kind === "dir" && !this.ws.holdsFiles(from)) {
      this.ws.movedFolder(from, to);
      return;
    }
    await this.land(under);
    const body = { from: a, to: b, kind: kind === "dir" ? "folder" : "document" };
    let moved = 0;
    for (let left = 1; left > 0; ) {
      let part: MovedAnswer;
      try {
        part = await askJson<MovedAnswer>("POST", "/api/web/move", { body });
      } catch (e) {
        if (moved === 0) throw e;
        await this.ws.reread([a.space, b.space]).catch(() => {});
        throw new Partway(moved, left, whyOf(e));
      }
      moved += part.files;
      left = part.remaining ?? 0;
    }
    // What is held follows the document: a text read before the move is
    // the same text after it.
    const held = kind === "dir" ? [...this.held.keys()].filter(under) : [from, metaFileOf(from)];
    const there = (file: string) => (kind === "dir" ? `${to}${file.slice(from.length)}` : file === from ? to : metaFileOf(to));
    for (const file of held) {
      const h = this.held.get(file);
      this.held.delete(file);
      if (h) this.held.set(there(file), h);
    }
    if (kind === "dir") this.ws.movedFolder(from, to);
    else if (MD_EXT_RE.test(from)) this.held.delete(htmlSiblingOf(from));
    await this.ws.reread([a.space, b.space]);
  }

  /**
   * Share the folder or the document at `path` with `members`. It stays
   * where it is in the tree: a share is made that sits there, and its files
   * are carried out of the section around it into the share's own — what a
   * Mac's engine does by syncing (`Engine::share`, engine/src/cloud/engine.rs).
   * Something shared already gets those people as well. What is shared from
   * inside a folder stays its own share, and sits in the new one.
   *
   * The share is made first and filled after, and until a file is carried
   * it is where it was: open to the people who could open it before, and to
   * nobody it is being shared with. A carry that stops says how far it got;
   * sharing it again carries the rest.
   */
  async share(path: string, members: string[]): Promise<CloudSpace> {
    const kind: EntryKind = this.ws.stored(path) ? "file" : "dir";
    const item = kind === "dir" ? path : documentStem(path);
    const told = (id: string) => {
      const space = this.ws.status().spaces.find((s) => s.id === id);
      if (!space) throw new Error("It is shared, and will show as shared in a moment.");
      return space;
    };
    const own = this.ws.shareAt(path, kind);
    if (own) {
      for (const member of members) await this.ws.shareMember(own.id, member, true);
      return told(own.id);
    }
    if (!this.ws.exists(path)) throw new Error(NOT_SHAREABLE);
    const a = this.placed(path);
    const around = this.ws.spaceOf(a.space);
    if (!around || around.kind === "document") throw new Error(NOT_SHAREABLE);
    await this.land(under(item));
    // What is shared from inside it, and the folder of it each is in.
    const inside = (kind === "dir" ? this.ws.sharesUnder(path) : []).flatMap((id) => {
      const at = this.ws.itemAt(id);
      return at === null ? [] : [{ id, dir: dirname(at).slice(path.length + 1) }];
    });
    const name = basename(item);
    const was = kind === "dir" ? a.path : a.path.slice(0, a.path.length - (basename(path).length - name.length));
    this.carrying = true;
    let made: Space;
    try {
      made = await this.ws.makeShare(kind === "dir" ? "folder" : "document", name, a.space, was, members);
    } catch (e) {
      this.carrying = false;
      throw e;
    }
    try {
      await this.fill(made.id, kind, path, { space: a.space, path: a.path });
    } catch (e) {
      if (e instanceof Carried) throw e;
      // Nothing went into it: it is taken back, so asking again does not
      // make a second one beside it.
      const takenBack = await this.ws.deleteShare(made.id, true).then(
        () => true,
        () => false,
      );
      throw takenBack
        ? e
        : new Error(`“${name}” is shared, but nothing could be moved into it yet: ${whyOf(e)} It is carried as soon as the domain answers.`);
    } finally {
      this.carrying = false;
    }
    for (const child of inside) await this.ws.placeShare(child.id, made.id, child.dir);
    return told(made.id);
  }

  /** Carry what earlier carries left behind (`Workspace.leftovers`). One
   *  that fails waits for the next answer of the domain's. */
  private async carryLeft(): Promise<void> {
    if (this.carrying) return;
    this.carrying = true;
    try {
      for (const left of this.ws.leftovers()) await this.fill(left.id, left.dir ? "dir" : "file", left.item, left.from);
    } catch {
      // Still where they were, open to whoever could open them before.
    } finally {
      this.carrying = false;
    }
  }

  /** Carry the files of what was shared at `path` out of the section it
   *  sits in (`from`, as that section stores it) into the share `id`. */
  private async fill(id: string, kind: EntryKind, path: string, from: Place): Promise<void> {
    try {
      await this.carry(path, from, path, { space: id, path: kind === "dir" ? "" : basename(from.path) }, kind, false);
    } catch (e) {
      if (!(e instanceof Partway)) throw e;
      throw new Carried(
        `“${basename(kind === "dir" ? path : documentStem(path))}” is shared, but only ${e.moved} of ${e.moved + e.left} files reached it: ${e.why} The rest are where they were, open only to whoever could open them before, and are carried as soon as the domain answers.`,
      );
    }
  }

  async copy(from: string, to: string, kind: EntryKind): Promise<LeftBehind[]> {
    const b = this.placed(to);
    if (kind === "dir" && !this.ws.holdsFiles(from)) {
      this.ws.makeFolder(to);
      return [];
    }
    // The copy is of the document as it is here, typed text and all.
    await this.land((path) => path === from || (kind === "dir" && path.startsWith(`${from}/`)));
    const copy = (a: Place, to: Place, kind: EntryKind) =>
      ask("POST", "/api/web/copy", { body: { from: a, to, kind: kind === "dir" ? "folder" : "document" } });
    const own = kind === "dir" ? this.ws.shareAt(from, "dir") : null;
    if (own) {
      // A shared folder is a section of its own, copied by what is in it:
      // the copy is an ordinary folder, shared with nobody.
      for (const top of this.ws.topOf(own.id)) {
        await copy({ space: own.id, path: top.name }, { space: b.space, path: `${b.path}/${top.name}` }, top.dir ? "dir" : "file");
      }
    } else {
      await copy(this.placed(from), b, kind);
    }
    await this.ws.reread([b.space]);
    return [];
  }

  async remove(path: string, kind: EntryKind): Promise<Removed> {
    const place = this.placed(path);
    const own = new Set(filesOf(path));
    // What waits for it is not sent: it is being deleted.
    this.forget((file) => (kind === "dir" ? file.startsWith(`${path}/`) : own.has(file)));
    if (kind === "dir") this.ws.movedFolder(path, null);
    if (kind === "file" || this.ws.holdsFiles(path)) {
      const route = kind === "dir" ? "folder" : "doc";
      await ask("DELETE", `/api/web/${route}?space=${encodeURIComponent(place.space)}&path=${encodeURIComponent(place.path)}`);
      await this.ws.reread([place.space]);
    }
    // A deletion here is a tombstone, which each Mac moves to its own Trash:
    // there is none to take it back out of.
    return { left: [], undo: null };
  }
}
