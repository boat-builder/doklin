// The worker as a writer of the manifest (docs/cloud.md §8.4).
//
// Until the document API, the worker only ever stored a manifest a Mac had
// built. An agent has no engine and no copy of the folder, so its changes are
// made here — and made exactly the way a Mac makes them: new content goes up
// as immutable blobs, then the manifest is replaced by compare-and-swap on
// its etag. A Mac cannot tell an agent's write from another Mac's, which is
// the point: its next poll sees a new etag and its ordinary cycle applies it
// (src-tauri/src/cloud/engine.rs, `apply_remote`).
//
// What every change here keeps, because that cycle reads it:
//
//   · a new file gets a fresh id and `rev: 1`; a changed one `rev + 1` with
//     its new `hash`, `size` and `mtime`; `by` is whoever changed it;
//   · a move changes `path` and bumps `rev`, and keeps the hash — a Mac
//     renames in place when the bytes did not change;
//   · a delete removes the entry and leaves a tombstone one revision on, so a
//     Mac moves its clean copy to the Trash and keeps an edited one;
//   · `seq` goes up by one, and the manifest still passes `validateManifest`
//     — the same check a Mac's PUT goes through.
//
// A lost race is nearly always another device's unrelated write, so the loop
// re-reads and re-applies rather than failing. That is why a caller's own
// precondition (`if-rev`) is checked inside `change`, against the manifest it
// was just handed, and never against the etag.

import { randomHex, sha256Hex } from "./crypto";
import type { Env } from "./env";
import { MANIFEST_KEY, MAX_FILE_BYTES, MAX_MANIFEST_BYTES, blobKey } from "./layout";
import { validateManifest, type Manifest, type ManifestFile } from "./manifest";

const JSON_OBJECT = { httpMetadata: { contentType: "application/json" } };

/** How many times a change is applied before giving up: once, and again
 *  after each of four lost races. */
const ATTEMPTS = 5;

/** A tombstone older than this ages out with whoever writes next — the
 *  engine's `TOMBSTONE_TTL_MS` (src-tauri/src/cloud/engine.rs). Change both. */
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The answer when a change must not be made. `status` is the HTTP status
 *  the route answers with; anything in `extra` rides in the body. */
export class Refusal {
  constructor(
    readonly status: number,
    readonly error: string,
    readonly extra: Record<string, unknown> = {},
  ) {}
}

/** The manifest as a change sees it: parsed, mutable, with what a change
 *  needs to read content and to write it. */
export class Tx {
  /** One clock for the whole change, so a document's files move together. */
  readonly now = Date.now();
  private readonly staged = new Map<string, { bytes: Uint8Array; contentType: string }>();
  private dirty = false;

  constructor(
    private readonly env: Env,
    readonly m: Manifest,
    /** Who is changing it: what `by` is signed with. */
    readonly by: string,
  ) {}

  get files(): Record<string, ManifestFile> {
    return this.m.files;
  }

  /** Whether anything changed. A change that leaves the manifest as it found
   *  it is not written — no new etag, so no Mac wakes up for nothing. */
  get changed(): boolean {
    return this.dirty;
  }

  /** Say the manifest was edited directly (the public map). */
  touch(): void {
    this.dirty = true;
  }

  /** A file's current content — the blob the manifest names — or null. */
  async read(fid: string): Promise<Uint8Array | null> {
    const file = this.m.files[fid];
    if (!file) return null;
    const staged = this.staged.get(blobKey(fid, file.hash));
    if (staged) return staged.bytes;
    const obj = await this.env.DATA.get(blobKey(fid, file.hash));
    return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
  }

  async readText(fid: string): Promise<string | null> {
    const bytes = await this.read(fid);
    return bytes === null ? null : new TextDecoder().decode(bytes);
  }

  /**
   * Give a file new content: a new revision of `fid` when it exists, a new
   * file at `path` when it does not. Answers the entry it left in the
   * manifest. Nothing is uploaded yet — the commit does that once the whole
   * change is known to be wanted.
   */
  async write(fid: string, path: string, bytes: Uint8Array, contentType: string): Promise<ManifestFile> {
    const hash = (await sha256Hex(bytes)).slice(0, 16);
    const prev = this.m.files[fid];
    // The same bytes are not a new revision.
    if (prev && prev.hash === hash) return prev;
    this.staged.set(blobKey(fid, hash), { bytes, contentType });
    this.dirty = true;
    const tombRev = this.m.tombstones?.[fid]?.rev ?? 0;
    const file: ManifestFile = {
      path: prev?.path ?? path,
      rev: Math.max(prev?.rev ?? 0, tombRev) + 1,
      hash,
      size: bytes.byteLength,
      mtime: this.now,
      by: this.by,
    };
    if (this.m.tombstones) delete this.m.tombstones[fid];
    this.m.files[fid] = file;
    return file;
  }

  /** Move a file. The bytes, and so the hash, stay; so does `mtime`, which
   *  says when the content last changed — a move is not an edit, here or in
   *  the engine's own move (engine.rs, `staged.moves`). Change both. */
  move(fid: string, to: string): void {
    const file = this.m.files[fid];
    if (!file || file.path === to) return;
    file.path = to;
    file.rev += 1;
    file.by = this.by;
    this.dirty = true;
  }

  /** Delete a file, leaving the tombstone a Mac honours. */
  remove(fid: string): void {
    const file = this.m.files[fid];
    if (!file) return;
    delete this.m.files[fid];
    this.m.tombstones ??= {};
    this.m.tombstones[fid] = { path: file.path, rev: file.rev + 1, ts: this.now, by: this.by };
    this.dirty = true;
  }

  /** The blobs this change needs stored, by key. */
  blobs(): Map<string, { bytes: Uint8Array; contentType: string }> {
    // Only what the manifest ended up naming: a change that wrote a file and
    // then thought better of it leaves nothing behind.
    const live = new Set(Object.entries(this.m.files).map(([fid, f]) => blobKey(fid, f.hash)));
    return new Map([...this.staged].filter(([key]) => live.has(key)));
  }
}

/** A fresh file id, as the engine mints one (`random_id("f")`, scan.rs). */
export const newFileId = (): string => `f-${randomHex(6)}`;

/** `wrote` is false when the change left the manifest as it was, or was a
 *  dry run: nothing was stored and `etag` is the manifest's own. `manifest`
 *  is the manifest as this call left it — what `etag` names when it wrote. */
export type Committed<T> = { value: T; etag: string; manifest: Manifest; wrote: boolean };

/**
 * Apply `change` to the manifest and store the result, or answer why not.
 *
 * `change` is handed a transaction over the manifest as it is right now, and
 * either mutates it and returns a value for the caller, or returns a
 * `Refusal` — in which case nothing is written at all. It may run more than
 * once (a lost race re-reads and re-applies), so it must derive everything
 * from the `Tx` it is given and nothing from an earlier run.
 *
 * With `dryRun` the change is applied and checked and then thrown away: the
 * value says what would have happened.
 */
export async function commit<T>(
  env: Env,
  by: string,
  change: (tx: Tx) => Promise<T | Refusal>,
  opts: { dryRun?: boolean } = {},
): Promise<Committed<T> | Refusal> {
  /** Blobs this call created, as opposed to found already stored. */
  const created = new Set<string>();
  const stored = new Set<string>();
  // A blob created for an attempt that then lost the race, or was refused on
  // the way back round, is named by no manifest: take it out again. `keep` is
  // every key the manifest in hand names, so nothing live is ever touched.
  const sweep = async (keep: ReadonlySet<string>): Promise<void> => {
    const orphans = [...created].filter((key) => !keep.has(key));
    if (orphans.length > 0) await env.DATA.delete(orphans);
  };
  const named = (m: Manifest): Set<string> =>
    new Set(Object.entries(m.files).map(([fid, f]) => blobKey(fid, f.hash)));

  let lastSeen = new Set<string>();
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const obj = await env.DATA.get(MANIFEST_KEY);
    if (!obj) return new Refusal(404, "this domain holds no workspace yet");
    let parsed: unknown;
    try {
      parsed = await obj.json();
    } catch {
      parsed = null;
    }
    if (validateManifest(parsed) !== null) {
      return new Refusal(409, "this workspace's manifest is not one this worker can change — open it in Doklin first");
    }
    const tx = new Tx(env, parsed as Manifest, by);
    const before = named(tx.m);
    lastSeen = before;

    const value = await change(tx);
    if (value instanceof Refusal) {
      await sweep(before);
      return value;
    }
    if (!tx.changed) {
      await sweep(before);
      return { value, etag: obj.etag, manifest: tx.m, wrote: false };
    }

    const next = tx.m;
    next.seq += 1;
    if (next.tombstones) {
      for (const [fid, t] of Object.entries(next.tombstones)) {
        if ((t.ts ?? 0) < tx.now - TOMBSTONE_TTL_MS) delete next.tombstones[fid];
      }
    }
    // The change itself was well-formed — what it adds up to may not be: one
    // file too many, a name that collides, a path too deep.
    const problem = validateManifest(next);
    const body = JSON.stringify(next);
    const blobs = tx.blobs();
    const refusal = problem
      ? new Refusal(409, `that can't be done here: ${problem.error}`)
      : body.length > MAX_MANIFEST_BYTES
        ? new Refusal(413, "this workspace's manifest is full — remove some files first")
        : [...blobs.values()].some((b) => b.bytes.byteLength > MAX_FILE_BYTES)
          ? new Refusal(413, "that is too large — a file may be 25 MB")
          : null;
    if (refusal) {
      await sweep(before);
      return refusal;
    }
    if (opts.dryRun) return { value, etag: obj.etag, manifest: next, wrote: false };

    // Content first, the manifest last: a manifest must never name a blob
    // that is not there. Content-addressed and create-only, so storing one
    // that is already there is a no-op.
    for (const [key, { bytes, contentType }] of blobs) {
      if (stored.has(key)) continue;
      const made = await env.DATA.put(key, bytes, { httpMetadata: { contentType }, onlyIf: { etagDoesNotMatch: "*" } });
      stored.add(key);
      if (made) created.add(key);
    }
    const put = await env.DATA.put(MANIFEST_KEY, body, { ...JSON_OBJECT, onlyIf: { etagMatches: obj.etag } });
    if (put) {
      await sweep(named(next));
      return { value, etag: put.etag, manifest: next, wrote: true };
    }
  }
  await sweep(lastSeen);
  return new Refusal(503, "the workspace kept changing underneath this — try again in a moment");
}
