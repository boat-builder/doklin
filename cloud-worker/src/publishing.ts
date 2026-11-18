// Publishing, whoever asks for it.
//
// Publishing is what it is on a Mac: an entry in the manifest's public map,
// keyed by its slug (manifest.ts). Nothing is uploaded and nothing is
// rendered ahead of time — the page is drawn from the synced files when
// somebody asks for it — so an address answers the moment the entry lands.
//
// The rules an entry keeps are the engine's (`queue_publish` and
// `fold_public`, engine/src/cloud/engine.rs): one page per thing, a slug
// that is free or already its own, the first publisher's name and date kept
// when a page is republished. A document's page belongs to its markdown file
// when it has one and to its html when it has not.
//
// An agent's routes (agentPages.ts) and a person's in a browser
// (webPages.ts) both publish through here.

import { Refusal, type Tx } from "./commit";
import { Index, docExists, documentsUnder, locate, primaryOf, type Entry } from "./documents";
import { RESERVED_SLUGS, SLUG_RE } from "./layout";
import type { PublicEntry } from "./manifest";

/** The alphabet a random slug is drawn from — no look-alikes, as the engine's
 *  is (`SLUG_ALPHABET`, engine/src/cloud/manifest.rs). */
const SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const RANDOM_SLUG_LEN = 8;

function randomSlug(): string {
  const buf = new Uint8Array(RANDOM_SLUG_LEN);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => SLUG_ALPHABET[b % SLUG_ALPHABET.length]).join("");
}

/** What a page shows: a document (by its markdown, else its html) or a folder. */
export type Target = { kind: "file"; entry: Entry; name: string } | { kind: "dir"; path: string };

/** A target, and the files a page of it may already point at. */
export type Found = { target: Target; fids: string[] };

export const sameTarget = (e: PublicEntry, t: Target, fids: readonly string[]): boolean =>
  t.kind === "dir" ? e.kind === "dir" && e.path.toLowerCase() === t.path.toLowerCase() : e.kind === "file" && fids.includes(e.file);

const describe = (e: PublicEntry): string =>
  e.kind === "file" ? e.path : e.path === "" ? "the whole workspace" : `the folder ${e.path}`;

/** A title or a description as an entry keeps one, or undefined for none. */
export const cleanText = (raw: unknown, max: number): string | undefined => {
  const text = typeof raw === "string" ? raw.trim().slice(0, max) : "";
  return text === "" ? undefined : text;
};

/** Why `slug` cannot be an address, or null. */
export const slugProblem = (slug: string): string | null =>
  SLUG_RE.test(slug) && !RESERVED_SLUGS.has(slug)
    ? null
    : "an address is 3 to 64 characters — lowercase letters, digits and dashes, starting with a letter or a digit — and not a word Doklin keeps";

/** The document at `path` as something to publish; null when there is none.
 *  A picture or a PDF is refused by `locate`: nothing but documents syncs, so
 *  there is nothing else to show. */
export function documentTarget(index: Index, path: string): Found | Refusal | null {
  const at = locate(index, path, null);
  if (at instanceof Refusal) return at;
  if (!docExists(at.doc)) return null;
  const entry = primaryOf(at.doc)!;
  const fids = [at.doc.md?.fid, at.doc.html?.fid].filter((f): f is string => f !== undefined);
  return { target: { kind: "file", entry, name: at.doc.stem }, fids };
}

/** The folder at `path` — "" the whole section — as something to publish;
 *  null when nothing is under it. */
export function folderTarget(index: Index, path: string): Found | null {
  if (path === "") return { target: { kind: "dir", path: "" }, fids: [] };
  if (!index.isFolder(path)) return null;
  // The folder's own spelling, from a file inside it.
  const inside = index.under(path)[0].file.path;
  return { target: { kind: "dir", path: inside.slice(0, path.length) }, fids: [] };
}

/** Put a page of `target` in the public map: a new one, or the one it has,
 *  at another address or with another title. */
export function publish(
  tx: Tx,
  index: Index,
  { target, fids }: Found,
  ask: { wanted: string; title?: string; desc?: string },
  origin: string,
): (Record<string, unknown> & { slug: string; created: boolean }) | Refusal {
  const map = (tx.m.public ??= {});
  const existing = Object.keys(map).find((slug) => sameTarget(map[slug], target, fids));
  if (ask.wanted && map[ask.wanted] && ask.wanted !== existing) {
    return new Refusal(409, `"${ask.wanted}" is already the address of ${describe(map[ask.wanted])}`, { code: "slug_taken" });
  }
  let slug = ask.wanted || existing;
  while (!slug) {
    const candidate = randomSlug();
    if (!map[candidate] && !RESERVED_SLUGS.has(candidate)) slug = candidate;
  }

  const prev = existing ? map[existing] : undefined;
  const common = {
    ...((ask.title ?? prev?.title) ? { title: ask.title ?? prev?.title } : {}),
    ...((ask.desc ?? prev?.desc) ? { desc: ask.desc ?? prev?.desc } : {}),
    ...(prev?.root ? { root: true } : {}),
    // Who published it first, and when, stay: republishing renames or
    // retitles a page, it does not take it over.
    by: prev?.by ?? tx.by,
    at: prev?.at ?? tx.now,
  };
  const next: PublicEntry =
    target.kind === "dir"
      ? { kind: "dir", path: target.path, ...common }
      : { kind: "file", file: target.entry.fid, path: target.entry.file.path, ...common };
  if (!prev || existing !== slug || JSON.stringify(prev) !== JSON.stringify(next)) {
    if (existing && existing !== slug) delete map[existing];
    map[slug] = next;
    tx.touch();
  }

  const documents = target.kind === "dir" ? documentsUnder(index, target.path).map((d) => d.stem) : [target.name];
  return {
    slug,
    url: `${origin}/${slug}`,
    kind: target.kind === "dir" ? "folder" : "document",
    path: target.kind === "dir" ? target.path : target.name,
    // Everything this makes readable: one document, or every document in the
    // folder — an html-only one included, which a published folder serves at
    // its own name (pages.ts).
    documents,
    created: !prev,
  };
}
