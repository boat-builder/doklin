// Every public address on the domain — an owner's to see, and to take down.
//
// A page is published from the section its file is in, and to anybody
// outside that section the section does not exist. A public page is not
// private, though: its address answers the whole internet. So an owner is
// told what the internet is told — the address, the page's title, who
// published it and when — and nothing more: not which section it is in, not
// the file's path, not whether its file is still there.
//
// Taking a page down edits that section's public map the way one of its own
// people would (commit.ts), so their Macs hear of it as any other change.

import { releaseAddresses, spaceAt } from "./addresses";
import { commit, Refusal } from "./commit";
import type { Env } from "./env";
import { MANIFEST_KEY } from "./layout";
import type { Manifest, PublicEntry } from "./manifest";
import { listDirectory } from "./members";
import { withDb } from "./schema";
import { sharedEnv, spaceEnv } from "./spaces";
import { basename } from "./workspace";

export type EveryPage = {
  slug: string;
  kind: "file" | "dir";
  title: string;
  /** Who published it, as a name; "" when nobody signed it. */
  by: string;
  at: number;
  /** In the shared workspace, where everyone here can open its file. */
  shared: boolean;
};

/** How many spaces' maps one request reads: each is a read of the bucket,
 *  and a request has a budget of those. */
const MAX_SPACES_READ = 40;

const DOC_EXT_RE = /\.(md|markdown|mdown|mkd|html)$/i;

async function readPublic(env: Env): Promise<{ name: string; map: Record<string, PublicEntry> } | null> {
  const obj = await env.DATA.get(MANIFEST_KEY);
  if (!obj) return null;
  try {
    const m = (await obj.json()) as Manifest;
    return { name: m.name ?? "", map: m.public ?? {} };
  } catch {
    return null;
  }
}

/** What the page calls itself when its publisher gave it no title: the
 *  document's name, the folder's, or — for a whole section — the section's. */
const titleOf = (entry: PublicEntry, sectionName: string): string =>
  entry.title?.trim() ||
  (entry.kind === "file" ? basename(entry.path).replace(DOC_EXT_RE, "") : basename(entry.path) || sectionName);

/**
 * Every page the domain serves. `truncated` when more spaces hold addresses
 * than one request reads. Null when the database cannot say.
 */
export async function listEveryPage(env: Env): Promise<{ pages: EveryPage[]; truncated: boolean } | null> {
  const shared = sharedEnv(env);
  const rows = await withDb(shared, async (db) => {
    const { results } = await db
      .prepare("SELECT slug, space_id FROM addresses WHERE space_id <> '' ORDER BY space_id, slug")
      .all<{ slug: string; space_id: string }>();
    return results;
  });
  if (rows === null) return null;
  const names = new Map((await listDirectory(shared))?.map((p) => [p.id, p.name]) ?? []);
  const page = (slug: string, entry: PublicEntry, sectionName: string, isShared: boolean): EveryPage => ({
    slug,
    kind: entry.kind,
    title: titleOf(entry, sectionName),
    by: entry.by ? (names.get(entry.by) ?? entry.by) : "",
    at: entry.at ?? 0,
    shared: isShared,
  });

  const pages: EveryPage[] = [];
  // The shared map is the truth about what the shared workspace serves: its
  // claims in the registry are best effort (addresses.ts).
  const own = await readPublic(shared);
  for (const [slug, entry] of Object.entries(own?.map ?? {})) pages.push(page(slug, entry, own?.name ?? "", true));

  const bySpace = new Map<string, string[]>();
  for (const row of rows) bySpace.set(row.space_id, [...(bySpace.get(row.space_id) ?? []), row.slug]);
  const spaces = [...bySpace.keys()];
  for (const id of spaces.slice(0, MAX_SPACES_READ)) {
    const theirs = await readPublic(spaceEnv(shared, id));
    for (const slug of bySpace.get(id) ?? []) {
      const entry = theirs?.map[slug];
      if (entry) pages.push(page(slug, entry, theirs.name, false));
    }
  }
  pages.sort((a, b) => a.slug.localeCompare(b.slug));
  return { pages, truncated: spaces.length > MAX_SPACES_READ };
}

/**
 * Stop serving the page at `slug`, whichever section published it. A refusal
 * when nothing is published there.
 */
export async function takeDownPage(env: Env, by: string, slug: string): Promise<true | Refusal> {
  const shared = sharedEnv(env);
  const holder = await spaceAt(shared, slug);
  const target = holder ? spaceEnv(shared, holder) : shared;
  const done = await commit(target, by, async (tx) => {
    const map = tx.m.public ?? {};
    if (!map[slug]) return new Refusal(404, `nothing is published at "${slug}"`);
    delete map[slug];
    tx.touch();
    return true as const;
  });
  if (done instanceof Refusal) {
    // The registry held the address for a section whose map does not name
    // it: a claim left behind. Nothing answers there; let it go.
    if (holder && done.status === 404) await releaseAddresses(target, [slug]);
    return done;
  }
  return true;
}
