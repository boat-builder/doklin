// A section's manifest under the names its person uses.
//
// A section stores its paths relative to itself: a note in somebody's My
// files is `notes/plan.md` in that space's manifest, and a Library note
// `notes/plan.md` in Library's. On that person's disk, and in every path an
// agent of theirs types, they are `My files/notes/plan.md` and
// `Library/notes/plan.md`. The document API works on the second form
// throughout — its lookups, its refusals and its answers all carry the path
// as typed — so a section's manifest is handed to it mounted: every path
// under the folder the section is at. A change made to the mounted copy is
// taken back to the stored form before it is checked and written (commit.ts).
//
// A shared folder is mounted at the folder it is: `My files/Work/Plans` for
// its owner, `Shared with me/Plans` for the people it is shared with. A
// shared document's section holds that one document, at its own top, so it
// is mounted at the folder the document sits in — and where another thing
// there has its name, it is shown by another (`named`): `Plan (Dave).md` on
// the way out is `Plan.md` again on the way back.
//
// A browser names a section's paths as the section stores them, and mounts
// every one at "" (webCall.ts): "" is the stored form itself.

import type { Manifest, ManifestFile, Mount, PublicEntry, Tombstone } from "./manifest";
import { META_SUFFIX } from "../../src/metaFile";

/** Where a section's paths are, as its person names them. */
export type At = {
  mount: string;
  /** A shared document's name as stored, and as shown here. */
  named?: { stored: string; shown: string };
};

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const depthOf = (mount: string): number => (mount === "" ? 0 : mount.split("/").length);

/** A file's name as the name its document goes by, and the rest. */
export function splitName(name: string): [string, string] {
  if (name.toLowerCase().endsWith(META_SUFFIX)) return [name.slice(0, -META_SUFFIX.length), name.slice(-META_SUFFIX.length)];
  const dot = name.lastIndexOf(".");
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
}

/** A file's name, said as `to` where it is `from`. */
function renamed(name: string, from: string, to: string): string {
  const [stem, rest] = splitName(name);
  return same(stem, from) ? `${to}${rest}` : name;
}

/** `path` as its person names it. The section itself — a published folder's
 *  `""`, a share at its top — is the folder the section is at. */
export function shownPath(at: At, path: string): string {
  const said = at.named && path !== "" ? renamed(path, at.named.stored, at.named.shown) : path;
  if (at.mount === "") return said;
  return said === "" ? at.mount : `${at.mount}/${said}`;
}

/** `path` as the section stores it, or null when it is not under the folder
 *  the section is at. `self`: whether that folder itself is a path here. */
export function storedPath(at: At, path: string, self: boolean): string | null {
  const segs = path.split("/");
  const depth = depthOf(at.mount);
  if (!same(segs.slice(0, depth).join("/"), at.mount)) return null;
  if (segs.length === depth) return self ? "" : null;
  const rest = segs.slice(depth).join("/");
  return at.named ? renamed(rest, at.named.shown, at.named.stored) : rest;
}

const plain = (at: At): boolean => at.mount === "" && !at.named;

/** A copy of a section's manifest with every path as its person names it. */
export function mounted(m: Manifest, at: At): Manifest {
  if (plain(at)) return m;
  const files: Record<string, ManifestFile> = {};
  for (const [fid, f] of Object.entries(m.files)) files[fid] = { ...f, path: shownPath(at, f.path) };
  const tombstones: Record<string, Tombstone> = {};
  for (const [fid, t] of Object.entries(m.tombstones ?? {})) tombstones[fid] = { ...t, path: shownPath(at, t.path) };
  const map: Record<string, PublicEntry> = {};
  for (const [slug, e] of Object.entries(m.public ?? {})) map[slug] = { ...e, path: shownPath(at, e.path) };
  const mounts: Record<string, Mount> = {};
  for (const [id, mount] of Object.entries(m.mounts ?? {})) mounts[id] = { ...mount, dir: shownPath(at, mount.dir) };
  return { ...m, files, tombstones, public: map, mounts };
}

/**
 * A mounted manifest as its section stores it. `{ outside }` names the first
 * path that is not under the folder the section is at: a change that would
 * put something there is not one this section can hold.
 */
export function unmounted(m: Manifest, at: At): Manifest | { outside: string } {
  if (plain(at)) return m;
  const files: Record<string, ManifestFile> = {};
  for (const [fid, f] of Object.entries(m.files)) {
    const path = storedPath(at, f.path, false);
    if (path === null) return { outside: f.path };
    files[fid] = { ...f, path };
  }
  const tombstones: Record<string, Tombstone> = {};
  for (const [fid, t] of Object.entries(m.tombstones ?? {})) {
    const path = storedPath(at, t.path, false);
    if (path === null) return { outside: t.path };
    tombstones[fid] = { ...t, path };
  }
  const map: Record<string, PublicEntry> = {};
  for (const [slug, e] of Object.entries(m.public ?? {})) {
    const path = storedPath(at, e.path, e.kind === "dir");
    if (path === null) return { outside: e.path };
    map[slug] = { ...e, path };
  }
  const mounts: Record<string, Mount> = {};
  for (const [id, mount] of Object.entries(m.mounts ?? {})) {
    const dir = storedPath(at, mount.dir, true);
    if (dir === null) return { outside: mount.dir };
    mounts[id] = { ...mount, dir };
  }
  return { ...m, files, tombstones, public: map, ...(m.mounts === undefined ? {} : { mounts }) };
}
