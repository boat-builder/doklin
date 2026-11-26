// Where a share sits in the section it is in, as the worker writes it.
//
// The entry is that section's manifest's (`mounts`, manifest.ts), and who can
// open the share is never read from it. The worker writes it when the rows
// change — a share made, moved to another section, erased — so that a device
// never hears of a share before its place is there to read. A device writes
// it when the share's item moves inside the section (the engine's own
// manifest write, or `PUT /api/web/mount` for a browser).

import { Refusal, commit, type Committed } from "./commit";
import type { Env } from "./env";
import type { Mount } from "./manifest";
import { spaceStore } from "./spaces";

/** Where a share is to sit: the folder of the section its item is in, and
 *  where the item was before it was shared. */
export type Placing = { dir: string; was?: string };

/**
 * Say where the share `id` sits in the section `env` is scoped to. Nothing
 * is written when the manifest says so already.
 */
export function setMount(env: Env, by: string, id: string, at: Placing): Promise<Committed<Mount> | Refusal> {
  return commit(env, by, async (tx) => {
    const mounts = (tx.m.mounts ??= {});
    const now = mounts[id];
    if (now && now.dir === at.dir && (at.was === undefined || now.was === at.was)) return now;
    const was = at.was ?? now?.was;
    const next: Mount = { dir: at.dir, rev: (now?.rev ?? 0) + 1, by, ...(was === undefined ? {} : { was }) };
    mounts[id] = next;
    tx.touch();
    return next;
  });
}

/** Forget where the share `id` sat in the section `parent`: it is erased, or
 *  sits in another section now. Best effort — an entry for a share that is
 *  not there is read by nobody. */
export async function dropMount(env: Env, parent: string, id: string): Promise<void> {
  await commit(spaceStore(env, parent), "", async (tx) => {
    if (!tx.m.mounts?.[id]) return null;
    delete tx.m.mounts[id];
    tx.touch();
    return null;
  });
}
