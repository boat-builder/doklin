// A space's manifest under the names its person uses.
//
// A space stores its paths relative to itself: a note in somebody's Private
// is `notes/plan.md` in that space's manifest. On that person's disk, and in
// every path an agent of theirs types, it is `Private/notes/plan.md`. The
// document API works on the second form throughout — its lookups, its
// refusals and its answers all carry the path as typed — so a space's
// manifest is handed to it mounted: every path under the folder the space is
// at. A change made to the mounted copy is taken back to the stored form
// before it is checked and written (commit.ts).
//
// The shared workspace is mounted at "", and is its own stored form.

import type { Manifest, ManifestFile, PublicEntry, Tombstone } from "./manifest";

const depthOf = (mount: string): number => (mount === "" ? 0 : mount.split("/").length);

/** `path` as its person names it. The space itself — a published folder's
 *  `""` — is the folder the space is at. */
const out = (mount: string, path: string): string => (path === "" ? mount : `${mount}/${path}`);

/** `path` as the space stores it, or null when it is not under `mount`. */
function back(mount: string, path: string, self: boolean): string | null {
  const segs = path.split("/");
  const depth = depthOf(mount);
  if (segs.slice(0, depth).join("/").toLowerCase() !== mount.toLowerCase()) return null;
  if (segs.length === depth) return self ? "" : null;
  return segs.slice(depth).join("/");
}

/** A copy of a space's manifest with every path under `mount`. */
export function mounted(m: Manifest, mount: string): Manifest {
  if (mount === "") return m;
  const files: Record<string, ManifestFile> = {};
  for (const [fid, f] of Object.entries(m.files)) files[fid] = { ...f, path: out(mount, f.path) };
  const tombstones: Record<string, Tombstone> = {};
  for (const [fid, t] of Object.entries(m.tombstones ?? {})) tombstones[fid] = { ...t, path: out(mount, t.path) };
  const map: Record<string, PublicEntry> = {};
  for (const [slug, e] of Object.entries(m.public ?? {})) map[slug] = { ...e, path: out(mount, e.path) };
  return { ...m, files, tombstones, public: map };
}

/**
 * A mounted manifest as its space stores it. `{ outside }` names the first
 * path that is not under `mount`: a change that would put something there
 * is not one this space can hold.
 */
export function unmounted(m: Manifest, mount: string): Manifest | { outside: string } {
  if (mount === "") return m;
  const files: Record<string, ManifestFile> = {};
  for (const [fid, f] of Object.entries(m.files)) {
    const path = back(mount, f.path, false);
    if (path === null) return { outside: f.path };
    files[fid] = { ...f, path };
  }
  const tombstones: Record<string, Tombstone> = {};
  for (const [fid, t] of Object.entries(m.tombstones ?? {})) {
    const path = back(mount, t.path, false);
    if (path === null) return { outside: t.path };
    tombstones[fid] = { ...t, path };
  }
  const map: Record<string, PublicEntry> = {};
  for (const [slug, e] of Object.entries(m.public ?? {})) {
    const path = back(mount, e.path, e.kind === "dir");
    if (path === null) return { outside: e.path };
    map[slug] = { ...e, path };
  }
  return { ...m, files, tombstones, public: map };
}
