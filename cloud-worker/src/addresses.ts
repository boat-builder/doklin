// Public addresses, across spaces.
//
// Every space keeps its own public map in its own manifest, the shared
// workspace included. What makes an address one space's, in the whole
// domain, is its row in `addresses`: a claim is an insert on the primary
// key, so of two spaces asking for one address exactly one holds it. The
// same row is how the renderer finds a page that is not in the shared
// workspace's map (public.ts).
//
// A claim is made before the manifest that carries it is stored, and let go
// only after the one that drops it is: the registry may briefly hold an
// address its space did not get to publish, never lack one it did.
//
// The shared workspace's sync does not depend on the database: when it
// cannot answer, a manifest is stored with its addresses unclaimed. So a
// space's claim is also checked against the shared map itself, which is the
// truth about what the shared workspace serves.

import type { Env } from "./env";
import { withDb } from "./schema";
import { sharedEnv, spaceOf } from "./spaces";
import { openWorkspace } from "./workspace";

/** `taken`: addresses in the map that another space holds — the manifest
 *  must not be stored. `stale`: ones this space held and the map no longer
 *  names, to let go of once it is. */
export type Claim = { taken: string[]; stale: string[] };

/** Two values a row, and D1 binds at most 100 a statement. */
const CHUNK = 45;

const chunks = <T>(items: readonly T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
};

const marks = (n: number): string => Array.from({ length: n }, () => "?").join(", ");

/**
 * Claim every address in a manifest's public map for the space `env` is
 * scoped to. Null when the database cannot say.
 */
export async function claimAddresses(env: Env, slugs: readonly string[]): Promise<Claim | null> {
  const space = spaceOf(env);
  return withDb(env, async (db) => {
    const { results } = await db.prepare("SELECT slug FROM addresses WHERE space_id = ?").bind(space).all<{ slug: string }>();
    const held = new Set(results.map((r) => r.slug));
    const wanted = new Set(slugs);
    const stale = [...held].filter((slug) => !wanted.has(slug));
    let fresh = slugs.filter((slug) => !held.has(slug));
    const taken: string[] = [];
    if (fresh.length > 0 && space) {
      const served = (await openWorkspace(sharedEnv(env)))?.manifest.public ?? {};
      taken.push(...fresh.filter((slug) => Object.hasOwn(served, slug)));
      fresh = fresh.filter((slug) => !Object.hasOwn(served, slug));
    }
    for (const chunk of chunks(fresh)) {
      const [, others] = await db.batch([
        db
          .prepare(`INSERT OR IGNORE INTO addresses (slug, space_id) VALUES ${chunk.map(() => "(?, ?)").join(", ")}`)
          .bind(...chunk.flatMap((slug) => [slug, space])),
        db
          .prepare(`SELECT slug FROM addresses WHERE space_id <> ? AND slug IN (${marks(chunk.length)})`)
          .bind(space, ...chunk),
      ]);
      taken.push(...((others?.results ?? []) as { slug: string }[]).map((r) => r.slug));
    }
    return { taken: taken.sort(), stale };
  });
}

/** Let go of addresses this space no longer publishes at. */
export async function releaseAddresses(env: Env, stale: readonly string[]): Promise<void> {
  if (stale.length === 0) return;
  const space = spaceOf(env);
  await withDb(env, (db) =>
    db.batch(
      chunks(stale).map((chunk) =>
        db.prepare(`DELETE FROM addresses WHERE space_id = ? AND slug IN (${marks(chunk.length)})`).bind(space, ...chunk),
      ),
    ),
  );
}

/** What a manifest that names taken addresses is answered with. */
export const takenError = (taken: readonly string[]): { error: string; taken: readonly string[] } => ({
  error:
    taken.length === 1
      ? `the address "${taken[0]}" is already taken on this domain`
      : `these addresses are already taken on this domain: ${taken.join(", ")}`,
  taken,
});

/** The space — never the shared workspace — whose page answers at `slug`. */
export async function spaceAt(env: Env, slug: string): Promise<string | null> {
  const id = await withDb(env, (db) =>
    db.prepare("SELECT space_id FROM addresses WHERE slug = ? AND space_id <> ''").bind(slug).first<string>("space_id"),
  );
  return id ?? null;
}
