// What a change to the tree does to the manifest, whoever makes it.
//
// An agent's routes (agentDocs.ts) and a person's in a browser (webDocs.ts)
// take different requests, allow different things and word their answers for
// different readers. What then happens to the manifest is one thing, and it
// is here, once: removing a document or one of its versions, moving a
// document or a folder — inside a section, or from one to another — and
// keeping the public map true after any of them.
//
// Everything here goes through `commit` (commit.ts), so a document's files
// land in one manifest write or not at all. A move from one section to
// another is the one change that is more than one write: the place it goes to
// first. A copy is that first write and nothing after it.
//
// And a folder too large for one request to carry between sections is the
// one change that is more than one request, for an asker who said it will
// ask again (`MoveAsk.parts`): each request moves whole documents, the answer
// says how many files are still where they were, and until it says none the
// folder is in both places.

import { Refusal, commit, newFileId, type Committed, type Tx } from "./commit";
import { Index, VERSION_WORD, basename, docExists, locate, nameOf, pathProblem, type Doc, type Entry, type Named, type Version } from "./documents";
import { blobKey, contentTypeOf } from "./layout";
import type { Manifest, PublicEntry } from "./manifest";
import { mounted } from "./mount";
import { mirrorAfter } from "./search";
import type { Where } from "./spaces";
import { openWorkspace } from "./workspace";
import { META_SUFFIX, metaIsEmpty, parseEntityMeta, serializeEntityMeta } from "../../src/metaFile";

/** Who is making a change that is more than one write. */
export type Mover = {
  /** What `by` is signed with. */
  by: string;
  /** Absent under test, where work that would run after the response is awaited instead. */
  ctx: ExecutionContext | undefined;
  /** The domain, for the addresses an answer names. */
  origin: string;
};

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/* ---------- The public map follows the files ---------- */

/**
 * Keep the public map true after a change, the way the engine does on every
 * manifest it writes (`fold_public`, engine/src/cloud/engine.rs):
 *
 *   · a page's path snapshot follows its file when the file moved;
 *   · a page whose file is gone adopts a file that now sits at its path —
 *     which is what brings a page back when its document is recreated.
 */
export function keepPublic(tx: Tx): void {
  const map = tx.m.public;
  if (!map) return;
  const referenced = new Set<string>();
  for (const entry of Object.values(map)) {
    if (entry.kind !== "file") continue;
    referenced.add(entry.file);
    const live = tx.files[entry.file];
    if (live && live.path !== entry.path) {
      entry.path = live.path;
      tx.touch();
    }
  }
  for (const entry of Object.values(map)) {
    if (entry.kind !== "file" || tx.files[entry.file]) continue;
    const adopt = Object.entries(tx.files).find(([fid, f]) => f.path === entry.path && !referenced.has(fid));
    if (!adopt) continue;
    referenced.add(adopt[0]);
    entry.file = adopt[0];
    tx.touch();
  }
}

/** Point every page that shows `from` at `to` instead — a document's page
 *  belongs to its markdown when it has one, and to its html when it has not. */
export function repointPages(tx: Tx, from: string, to: Entry): void {
  for (const entry of Object.values(tx.m.public ?? {})) {
    if (entry.kind !== "file" || entry.file !== from) continue;
    entry.file = to.fid;
    entry.path = to.file.path;
    tx.touch();
  }
}

/** The addresses that point at `fids` by a page of their own. */
export const ownPages = (m: Manifest, origin: string, fids: readonly string[]): string[] =>
  Object.entries(m.public ?? {})
    .filter(([, e]) => e.kind === "file" && fids.includes(e.file))
    .map(([slug]) => `${origin}/${slug}`)
    .sort();

/* ---------- Writing ---------- */

/** The path a version of a document is at, or would be created at — or why
 *  nothing can be created there. */
export function versionPath(index: Index, at: Named, version: Version): string | Refusal {
  const current = version === "md" ? at.doc.md : at.doc.html;
  if (current) return current.file.path;
  const target = index.spelled(version === "md" ? at.mdPath : at.htmlPath);
  const place = index.placeProblem(target);
  if (place) return new Refusal(409, place);
  const inTheWay = index.at(target);
  return inTheWay ? new Refusal(409, `"${inTheWay.file.path}" is already there`) : target;
}

/* ---------- Removing ---------- */

/** Remove a document whole: both versions and its comments. */
export function removeDocument(tx: Tx, doc: Doc, origin: string): Record<string, unknown> {
  const parts = [doc.md, doc.html, doc.meta].filter((e): e is Entry => e !== null);
  const fids = [doc.md?.fid, doc.html?.fid].filter((f): f is string => f !== undefined);
  for (const part of parts) tx.remove(part.fid);
  return {
    kind: "document",
    path: doc.stem,
    versions: [...(doc.md ? ["md"] : []), ...(doc.html ? ["html"] : [])],
    // A page outlives its document on purpose.
    stillPublic: ownPages(tx.m, origin, fids),
  };
}

/** Remove one version of a document that has both. */
export async function removeVersion(tx: Tx, doc: Doc, version: Version): Promise<Record<string, unknown> | Refusal> {
  const entry = version === "md" ? doc.md : doc.html;
  const other = version === "md" ? doc.html : doc.md;
  if (!entry) return new Refusal(404, `${doc.stem} has no ${VERSION_WORD[version]} version`);
  if (!other) {
    return new Refusal(409, `that is the only version of ${doc.stem} — remove the document itself`, {
      code: "last_version",
    });
  }
  // The threads anchored in the version go with it: a markdown thread's
  // anchor is a marker in the markdown, an html thread's an element of the page.
  let threads = 0;
  if (doc.meta) {
    const meta = parseEntityMeta((await tx.readText(doc.meta.fid)) ?? "");
    if (version === "md") {
      threads = meta.mthreads.length;
      meta.mthreads = [];
      meta.tcols = [];
    } else {
      threads = meta.hthreads.length;
      meta.hthreads = [];
    }
    if (metaIsEmpty(meta)) tx.remove(doc.meta.fid);
    else await tx.write(doc.meta.fid, doc.meta.file.path, new TextEncoder().encode(serializeEntityMeta(meta)), contentTypeOf(doc.meta.file.path));
  }
  tx.remove(entry.fid);
  // A page that showed this file shows the document's other version now —
  // the markdown's page becoming the html's is the usual case, and a page a
  // Mac left on the html while the document had both is the other.
  repointPages(tx, entry.fid, other);
  return { kind: "document", path: doc.stem, versions: [version], ...(threads > 0 ? { threadsRemoved: threads } : {}) };
}

/* ---------- Moving ---------- */

/** Files a move from one section to another carries, or a copy: each is
 *  read from the bucket and written to it again, and a request has a budget. */
const MAX_FILES_ACROSS = 16;

/** What a move was asked to do. Both paths are without their slashes. */
export type MoveAsk = {
  from: string;
  /** "" is the top of the section it goes to, for a folder moved from
   *  another: what was in the folder is then what is in the section. */
  to: string;
  /** What `from` is known to be. "either": a document, else a folder. */
  what: "document" | "folder" | "either";
  /** Whether `to` means "into this folder" rather than "as this name" —
   *  asked of what is at the destination. */
  into: (there: Index) => boolean;
  /** Whether a folder of more files than a request carries between sections
   *  goes in parts, the asker asking again while the answer says `remaining`.
   *  Otherwise it is refused. */
  parts?: boolean;
};

/** What a move takes with it. */
type Picked = {
  kind: "document" | "folder";
  from: string;
  moving: Entry[];
  doc: Doc | null;
};

/** What a path names, as something that moves: a document whole — both
 *  versions and its comments — whatever extension it was named by, or a
 *  folder: every file under it, its `boards.json` as much as its documents. */
function pick(index: Index, from: string, what: MoveAsk["what"]): Picked | Refusal {
  const at = what === "folder" ? null : locate(index, from, null);
  if (at instanceof Refusal) return at;
  if (at && docExists(at.doc)) {
    const doc = at.doc;
    return { kind: "document", from, moving: [doc.md, doc.html, doc.meta].filter((e): e is Entry => e !== null), doc };
  }
  if (what !== "document" && index.isFolder(from)) return { kind: "folder", from, moving: index.under(from), doc: null };
  return new Refusal(404, `there is nothing at "${from}"`);
}

/** Where each file goes, and what the move is called. */
type Route = { plan: { fid: string; to: string }[]; label: { from: string; to: string } };

/** A path at or under the folder `from`, as it is once that folder is `to` —
 *  "" the top of a section. */
const rebased = (path: string, from: string, to: string): string => {
  const rest = path.slice(from.length);
  return to === "" ? rest.slice(1) : `${to}${rest}`;
};

/**
 * Where what was picked lands. `there` is everything already at the
 * destination — never the files being moved, which is what lets a rename
 * change only the case of a name — and the place has to be free of it. A
 * destination that is a folder means "into it" when the asker said so;
 * folders are spelled the way the place already spells them.
 */
function route(there: Index, picked: Picked, to: string, into: boolean): Route | Refusal {
  const { kind, from, moving, doc } = picked;
  const plan: Route["plan"] = [];
  let label: Route["label"];
  if (doc) {
    const stem = there.spelled(into ? `${to}/${basename(doc.stem)}` : nameOf(to).stem);
    if (doc.md) plan.push({ fid: doc.md.fid, to: `${stem}${doc.md.file.path.slice(doc.stem.length)}` });
    if (doc.html) plan.push({ fid: doc.html.fid, to: `${stem}.html` });
    if (doc.meta) plan.push({ fid: doc.meta.fid, to: `${stem}${META_SUFFIX}` });
    label = { from: doc.stem, to: stem };
  } else {
    // The folder as it is spelled, which is not always how it was named.
    const folder = moving[0].file.path.slice(0, from.length);
    const dest = there.spelled(into ? `${to}/${basename(folder)}` : to);
    if (`${dest.toLowerCase()}/`.startsWith(`${from.toLowerCase()}/`) && dest.toLowerCase() !== from.toLowerCase()) {
      return new Refusal(400, "a folder cannot be moved inside itself");
    }
    for (const e of moving) plan.push({ fid: e.fid, to: rebased(e.file.path, from, dest) });
    label = { from: folder, to: dest };
  }

  for (const step of plan) {
    // A sidecar travels with its document; it is checked as the stem it belongs to.
    const sidecar = step.to.toLowerCase().endsWith(META_SUFFIX);
    const problem = pathProblem(sidecar ? step.to.slice(0, -META_SUFFIX.length) : step.to);
    if (problem) return new Refusal(400, problem);
    const taken = there.at(step.to);
    if (taken) return new Refusal(409, `"${taken.file.path}" is already there`);
    const place = there.placeProblem(step.to);
    if (place) return new Refusal(409, place);
  }
  if (kind === "document") {
    const already = there.doc(label.to);
    if (docExists(already)) return new Refusal(409, `there is already a document at "${already.stem}"`);
  }
  return { plan, label };
}

/** Whether a published folder's path is the moved folder, or beneath it. */
const within = (path: string, folder: string): boolean =>
  sameName(path, folder) || path.toLowerCase().startsWith(`${folder.toLowerCase()}/`);

/** Move or rename a document or a folder inside one section. */
export function moveWithin(tx: Tx, ask: MoveAsk): Record<string, unknown> | Refusal {
  const index = new Index(tx.files);
  const picked = pick(index, ask.from, ask.what);
  if (picked instanceof Refusal) return picked;
  const { kind, moving } = picked;

  const gone = new Set(moving.map((e) => e.fid));
  const without = new Index(Object.fromEntries(Object.entries(tx.files).filter(([fid]) => !gone.has(fid))));
  const routed = route(without, picked, ask.to, ask.into(index));
  if (routed instanceof Refusal) return routed;
  const { plan, label } = routed;

  for (const step of plan) tx.move(step.fid, step.to);
  if (kind === "folder") {
    // A published folder follows its folder; so does one published beneath it.
    for (const entry of Object.values(tx.m.public ?? {})) {
      if (entry.kind !== "dir" || !within(entry.path, label.from)) continue;
      entry.path = rebased(entry.path, label.from, label.to);
      tx.touch();
    }
    // And what is shared from inside it sits where its folder now is.
    for (const mount of Object.values(tx.m.mounts ?? {})) {
      if (!within(mount.dir, label.from)) continue;
      mount.dir = rebased(mount.dir, label.from, label.to);
      mount.rev += 1;
      mount.by = tx.by;
      tx.touch();
    }
  }
  keepPublic(tx);
  return { kind, ...label, files: plan.length };
}

/** What a move between sections, or a copy, takes: what was picked, the
 *  bytes of each of its files as they were read, and how many files of a
 *  folder taken in parts are left for the next request. */
type Lifted = { picked: Picked; contents: Map<string, Uint8Array>; remaining: number };

/** As much of a folder as one request carries, in whole documents: a note
 *  never arrives ahead of its comments, or its html ahead of the note. By
 *  path, so every request that asks takes the same ones first. */
function firstPart(moving: readonly Entry[]): Entry[] {
  const documents = new Map<string, Entry[]>();
  for (const e of [...moving].sort((a, b) => (a.file.path < b.file.path ? -1 : 1))) {
    const path = e.file.path.toLowerCase();
    const stem = path.endsWith(META_SUFFIX) ? path.slice(0, -META_SUFFIX.length) : nameOf(path).stem;
    documents.set(stem, [...(documents.get(stem) ?? []), e]);
  }
  const part: Entry[] = [];
  for (const files of documents.values()) {
    if (part.length > 0 && part.length + files.length > MAX_FILES_ACROSS) break;
    part.push(...files);
  }
  return part;
}

/** Read what `ask.from` names out of the section it is in. `limit` is what
 *  is said of one that is more files than a request carries, when it is not
 *  a folder that goes in parts. */
async function lift(source: Where, ask: MoveAsk, limit: (files: number) => string): Promise<Lifted | Refusal> {
  const ws = await openWorkspace(source.env);
  if (!ws) return new Refusal(404, "this domain holds no workspace yet");
  const whole = pick(new Index(mounted(ws.manifest, source).files), ask.from, ask.what);
  if (whole instanceof Refusal) return whole;
  const files = whole.moving.length;
  if (files > MAX_FILES_ACROSS && !(ask.parts && whole.kind === "folder")) return new Refusal(400, limit(files));
  const picked = files > MAX_FILES_ACROSS ? { ...whole, moving: firstPart(whole.moving) } : whole;
  const contents = new Map<string, Uint8Array>();
  for (const e of picked.moving) {
    const obj = await source.env.DATA.get(blobKey(e.fid, e.file.hash));
    if (!obj) return new Refusal(503, "its content has not finished syncing — try again in a moment");
    contents.set(e.fid, new Uint8Array(await obj.arrayBuffer()));
  }
  return { picked, contents, remaining: files - picked.moving.length };
}

/** Where what was lifted landed: what the change is called, and the id each
 *  file has there, by the id it had where it was read. */
type Landed = { label: Route["label"]; ids: [string, string][] };

/** Write what was lifted where it goes. A copy is a new file there, with an
 *  id of its own. A move keeps each file's id, so every link to it still
 *  finds it — as a Mac's own move between sections does (`moved_in`,
 *  engine/src/cloud/unit.rs): change both. Only when the section already
 *  has a file by that id, from a move that stopped half done, does it get
 *  a new one. */
function land(
  who: Mover,
  dest: Where,
  lifted: Lifted,
  ask: MoveAsk,
  dryRun: boolean,
  keep: boolean,
): Promise<Committed<Landed> | Refusal> {
  return commit(
    dest.env,
    who.by,
    async (tx) => {
      const index = new Index(tx.files);
      const routed = route(index, lifted.picked, ask.to, ask.into(index));
      if (routed instanceof Refusal) return routed;
      const ids = new Map<string, string>();
      for (const step of routed.plan) {
        const fid = keep && !tx.files[step.fid] ? step.fid : newFileId();
        ids.set(step.fid, fid);
        await tx.write(fid, step.to, lifted.contents.get(step.fid)!, contentTypeOf(step.to));
      }
      keepPublic(tx);
      return { label: routed.label, ids: [...ids] };
    },
    { dryRun, at: dest },
  );
}

/**
 * Copy a document or a folder, in its section or to another: every file of
 * it is written again where the copy goes, as a new file. A copy has no page
 * and no link of its own: both belong to the files it was made from.
 */
export async function copyTo(who: Mover, source: Where, dest: Where, ask: MoveAsk): Promise<Committed<Record<string, unknown>> | Refusal> {
  const lifted = await lift(
    source,
    ask,
    (files) => `that is ${files} files, and ${MAX_FILES_ACROSS} are copied at a time — copy it in parts, or in the Doklin app`,
  );
  if (lifted instanceof Refusal) return lifted;
  const arrived = await land(who, dest, lifted, ask, false, false);
  if (arrived instanceof Refusal) return arrived;
  await mirrorAfter({ env: dest.env, ctx: who.ctx }, arrived);
  return { ...arrived, value: { kind: lifted.picked.kind, ...arrived.value.label, files: lifted.picked.moving.length } };
}

/**
 * Move something from one section to another: its files are written where
 * they go, and only then taken out of where they were — with a tombstone
 * that says where (`Tombstone.to`), so a Mac in both sections moves its copy
 * and a Mac that is not in the new one deletes its own outright. A failure
 * in between leaves the thing in both places, never in neither.
 *
 * A page keeps its address: the section it left gives the address up in the
 * write that removes the file, and the one it went to claims it after.
 */
export async function moveAcross(
  who: Mover,
  source: Where,
  dest: Where,
  ask: MoveAsk,
  dryRun = false,
): Promise<Record<string, unknown> | Refusal> {
  const change = <T>(at: Where, fn: (tx: Tx) => Promise<T | Refusal>) => commit(at.env, who.by, fn, { at });
  const lifted = await lift(
    source,
    ask,
    (files) => `that is ${files} files, and ${MAX_FILES_ACROSS} move between sections at a time — move it in parts, or in the Doklin app`,
  );
  if (lifted instanceof Refusal) return lifted;
  const { picked } = lifted;

  // Where it goes, first.
  const arrived = await land(who, dest, lifted, ask, dryRun, true);
  if (arrived instanceof Refusal) return arrived;
  const { label } = arrived.value;
  const answer = {
    kind: picked.kind,
    ...label,
    files: picked.moving.length,
    ...(lifted.remaining > 0 ? { remaining: lifted.remaining } : {}),
  };
  if (dryRun) return { ...answer, moved: false };
  await mirrorAfter({ env: dest.env, ctx: who.ctx }, arrived);

  // Then out of where it was — as it was read: a file that changed meanwhile
  // is not removed, because what arrived is not what it now says.
  const folder = picked.kind === "folder";
  const left = await change(source, async (tx) => {
    for (const e of picked.moving) {
      const now = tx.files[e.fid];
      if (!now || now.hash !== e.file.hash || now.path !== e.file.path) {
        return new Refusal(
          409,
          `${label.from} changed while it was being moved, so it was left where it is — ${label.to} is a copy of how it was. Remove the copy and move it again.`,
        );
      }
    }
    const gone = new Set(picked.moving.map((e) => e.fid));
    const pages: [string, PublicEntry][] = [];
    const map = tx.m.public ?? {};
    for (const [slug, entry] of Object.entries(map)) {
      if (entry.kind === "file" ? !gone.has(entry.file) : !(folder && within(entry.path, label.from))) continue;
      pages.push([slug, entry]);
      delete map[slug];
    }
    for (const e of picked.moving) tx.remove(e.fid, dest.space);
    return pages;
  });
  if (left instanceof Refusal) {
    if (left.status === 409) return left;
    return new Refusal(
      left.status,
      `${label.to} was written, and ${label.from} could not be taken out of where it was (${left.error}) — it is in both places. Remove ${label.from}.`,
    );
  }
  await mirrorAfter({ env: source.env, ctx: who.ctx }, left);

  // Its pages, at the addresses they had.
  const ids = new Map(arrived.value.ids);
  const pages = left.value;
  let unpublished: string[] = [];
  if (pages.length > 0) {
    const carried = await change(dest, async (tx) => {
      const map = (tx.m.public ??= {});
      for (const [slug, entry] of pages) {
        // The home page is chosen from Library.
        const { root: _root, ...kept } = entry;
        const common = dest.space === "" ? entry : kept;
        if (entry.kind === "file") {
          const fid = ids.get(entry.file);
          const file = fid ? tx.files[fid] : undefined;
          if (!fid || !file) continue;
          map[slug] = { ...common, kind: "file", file: fid, path: file.path };
        } else {
          map[slug] = { ...common, kind: "dir", path: rebased(entry.path, label.from, label.to) };
        }
      }
      tx.touch();
      return true;
    });
    if (carried instanceof Refusal) unpublished = pages.map(([slug]) => `${who.origin}/${slug}`).sort();
  }
  // Said, because nothing else would: an address stopped answering.
  return { ...answer, ...(unpublished.length > 0 ? { unpublished } : {}) };
}
