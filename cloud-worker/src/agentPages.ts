// Publishing, for an agent.
//
//   GET    /api/agent/pages
//   PUT    /api/agent/pages           {path, slug?, title?, desc?, dryRun?}
//   DELETE /api/agent/pages?path= | ?slug=  [&dry=1]
//
// What publishing is, and the rules an entry keeps, are publishing.ts's:
// a person in a browser publishes through the same ones.
//
// Each section keeps its own map, and an address is one section's for the
// whole domain (addresses.ts). So a page is published in the section its
// document is in, the list is every section's the agent's person can see, and
// an address is stopped in whichever of those holds it.

import { spaceAt, spacesWithPages } from "./addresses";
import { change, inSection, notBound, openTree, refuse, type Call } from "./agentCall";
import type { Section } from "./agentPlace";
import { Refusal, type Committed, type Tx } from "./commit";
import { Index, nameOf, pathProblem } from "./documents";
import { json, readJsonObject } from "./http";
import { MAX_DESC_LEN, MAX_TITLE_LEN, SLUG_RE } from "./layout";
import type { Manifest } from "./manifest";
import { listDirectory } from "./members";
import { cleanText, documentTarget, folderTarget, publish, sameTarget, slugProblem, type Found } from "./publishing";
import { mirrorAfter } from "./search";
import { MAX_SECTIONS_READ } from "./spaces";

/**
 * What a path means to publishing. A trailing slash says "the folder";
 * otherwise a document, then a folder — the order a path is read in
 * everywhere else. A section's own folder is the whole section: `Library/`
 * is everything everyone sees. A picture or a PDF is refused by `locate`:
 * nothing but documents syncs, so there is nothing else to show.
 */
function targetAt(index: Index, raw: string): Found | Refusal {
  const asFolder = raw.endsWith("/");
  const path = raw.replace(/^\/+|\/+$/g, "");
  const problem = pathProblem(path);
  if (problem) return new Refusal(400, problem);
  const found = (asFolder ? null : documentTarget(index, path)) ?? folderTarget(index, path);
  return found ?? new Refusal(404, `there is nothing at "${path}" to publish`);
}

/* ---------- What is public ---------- */

export async function getPages(c: Call): Promise<Response> {
  const { env, url, places } = c;
  const unavailable = (): Response => json({ error: "this domain's database is not answering — try again in a moment" }, 503);
  const [all, holding, directory] = await Promise.all([places.all(), spacesWithPages(env), listDirectory(env)]);
  if (all === null || holding === null) return unavailable();
  const names = new Map((directory ?? []).map((p) => [p.id, p.name]));
  // Library's map, and that of each section the registry says holds an
  // address: a section that publishes nothing is not opened.
  const publishing = all.filter((s) => s.space === "" || holding.has(s.space));
  const pages: Record<string, unknown>[] = [];
  const notListed: string[] = [];
  for (const [i, section] of publishing.entries()) {
    if (i > MAX_SECTIONS_READ) {
      notListed.push(section.mount);
      continue;
    }
    const tree = await openTree(inSection(c, section));
    if (!tree) {
      if (section.space === "") return notBound();
      continue;
    }
    pages.push(...pagesOf(tree.manifest, url.origin, names));
  }
  pages.sort((a, b) => String(a.slug).localeCompare(String(b.slug)));
  return json({ pages, ...(notListed.length > 0 ? { notListed } : {}) });
}

function pagesOf(m: Manifest, origin: string, names: ReadonlyMap<string, string>): Record<string, unknown>[] {
  return Object.keys(m.public ?? {})
    .sort()
    .map((slug) => {
      const e = m.public![slug];
      const live = e.kind === "file" ? m.files[e.file] : undefined;
      return {
        slug,
        url: `${origin}/${slug}`,
        kind: e.kind === "dir" ? "folder" : "document",
        path: e.kind === "dir" ? e.path : nameOf(live?.path ?? e.path).stem,
        ...(e.title ? { title: e.title } : {}),
        ...(e.desc ? { desc: e.desc } : {}),
        ...(e.root ? { home: true } : {}),
        ...(e.by ? { by: e.by, ...(names.has(e.by) ? { byName: names.get(e.by) } : {}) } : {}),
        at: e.at,
        // A page outlives its file: it answers 404 until the file is back.
        ...(e.kind === "file" && !live ? { missing: true } : {}),
      };
    });
}

/* ---------- Publishing ---------- */

export async function putPage(c: Call): Promise<Response> {
  const { request, url } = c;
  const body = await readJsonObject(request);
  if (!body) return json({ error: "invalid json body" }, 400);
  const path = typeof body.path === "string" ? body.path : "";
  const wanted = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
  const unusable = wanted ? slugProblem(wanted) : null;
  if (unusable) return json({ error: unusable }, 400);
  const title = cleanText(body.title, MAX_TITLE_LEN);
  const desc = cleanText(body.desc, MAX_DESC_LEN);

  const done = await change(
    c,
    async (tx) => {
      const index = new Index(tx.files);
      const found = targetAt(index, path);
      if (found instanceof Refusal) return found;
      return publish(tx, index, found, { wanted, title, desc }, url.origin);
    },
    body.dryRun === true,
  );
  if (done instanceof Refusal) return refuse(done);
  await mirrorAfter(c, done);
  const { created, ...answer } = done.value;
  // Not written: a dry run, or a page that already was exactly this.
  return json({ ...answer, created, ...(done.wrote ? {} : { written: false }) }, created && done.wrote ? 201 : 200);
}

/* ---------- Stopping ---------- */

type Stopped = { stopped: { slug: string; url: string }[] };

export async function deletePage(c: Call): Promise<Response> {
  const { url, places } = c;
  const slugParam = (url.searchParams.get("slug") ?? "").trim().toLowerCase();
  const path = url.searchParams.get("path") ?? "";
  if (!slugParam && !path) return json({ error: "say which page — a document, a folder or an address" }, 400);
  const dryRun = url.searchParams.get("dry") === "1";

  /** The section of this agent's person that holds an address — Library
   *  when none does, where it then is not published either. */
  const holderOf = async (slug: string): Promise<Section | null> => {
    const [all, space] = [await places.all(), await spaceAt(c.env, slug)];
    if (all === null) return null;
    return all.find((s) => s.space === (space ?? "")) ?? all[0];
  };
  const stop = async (section: Section, slug: string): Promise<{ at: Call; done: Committed<Stopped> | Refusal }> => {
    const at = inSection(c, section);
    const done = await change(
      at,
      async (tx) => {
        const map = tx.m.public ?? {};
        const slugs = slug ? (map[slug] ? [slug] : []) : slugsFor(tx, path);
        if (slugs instanceof Refusal) return slugs;
        if (slugs.length === 0) {
          return new Refusal(404, slugParam ? `nothing is published at "${slugParam}"` : `"${path}" is not published`);
        }
        const stopped = slugs.map((s) => ({ slug: s, url: `${url.origin}/${s}` }));
        for (const s of slugs) delete map[s];
        tx.touch();
        return { stopped };
      },
      dryRun,
    );
    return { at, done };
  };

  // The word may be an address rather than a path, and an address is in
  // whichever section published it: a word that is in no section is tried
  // as one, and so is a path whose section has published nothing by it.
  const word = path.replace(/^\/+|\/+$/g, "").toLowerCase();
  const named = slugParam ? await holderOf(slugParam) : await places.of(path);
  const unplaced = !slugParam && named instanceof Refusal && named.status === 400 && SLUG_RE.test(word) ? named : null;
  const section = unplaced ? await holderOf(word) : named;
  if (section === null) return json({ error: "this domain's database is not answering — try again in a moment" }, 503);
  if (section instanceof Refusal) return refuse(section);
  let { at, done } = await stop(section, slugParam || (unplaced ? word : ""));
  // No address either: what the word is told is that a path needs its section.
  if (unplaced && done instanceof Refusal && done.status === 404) return refuse(unplaced);
  if (done instanceof Refusal && done.status === 404 && !slugParam && !unplaced && SLUG_RE.test(word)) {
    const holder = await holderOf(word);
    if (holder && holder.space !== section.space) ({ at, done } = await stop(holder, word));
  }
  if (done instanceof Refusal) return refuse(done);
  await mirrorAfter(at, done);
  return json({ ...done.value, ...(done.wrote ? {} : { written: false }) });
}

/**
 * The pages a path names. A document or a folder that is published comes
 * first; then a page whose document is gone, by the path it remembers; and
 * last the word itself as an address — so `unpublish` takes whichever of the
 * three the caller has in hand.
 */
function slugsFor(tx: Tx, raw: string): string[] | Refusal {
  const map = tx.m.public ?? {};
  const index = new Index(tx.files);
  const found = targetAt(index, raw);
  if (!(found instanceof Refusal)) {
    const hits = Object.keys(map).filter((slug) => sameTarget(map[slug], found.target, found.fids));
    if (hits.length > 0) return hits;
  } else if (found.status === 400) {
    return found;
  }
  const path = raw.replace(/^\/+|\/+$/g, "");
  const stem = nameOf(path).stem.toLowerCase();
  const dead = Object.keys(map).filter((slug) => {
    const e = map[slug];
    return e.kind === "file" && !tx.files[e.file] && nameOf(e.path).stem.toLowerCase() === stem;
  });
  if (dead.length > 0) return dead;
  const asSlug = path.toLowerCase();
  return map[asSlug] ? [asSlug] : [];
}
