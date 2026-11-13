// Publishing, for an agent (docs/cloud.md §8.4, Publishing).
//
//   GET    /api/agent/pages
//   PUT    /api/agent/pages           {path, slug?, title?, desc?, dryRun?}
//   DELETE /api/agent/pages?path= | ?slug=  [&dry=1]
//
// Publishing is what it is on a Mac: an entry in the manifest's public map,
// keyed by its slug (manifest.ts). Nothing is uploaded and nothing is
// rendered ahead of time — the page is drawn from the synced files when
// somebody asks for it — so an address answers the moment the entry lands.
//
// The rules an entry keeps are the engine's (`queue_publish` and
// `fold_public`, src-tauri/src/cloud/engine.rs): one page per thing, a slug
// that is free or already its own, the first publisher's name and date kept
// when a page is republished. A document's page belongs to its markdown file
// when it has one and to its html when it has not.

import { notBound, refuse, type Call } from "./agentCall";
import { Refusal, commit, type Tx } from "./commit";
import {
  Index,
  docExists,
  documentsUnder,
  locate,
  nameOf,
  pathProblem,
  primaryOf,
  type Entry,
} from "./documents";
import { json, readJsonObject } from "./http";
import { MAX_DESC_LEN, MAX_TITLE_LEN, RESERVED_SLUGS, SLUG_RE } from "./layout";
import type { Manifest, PublicEntry } from "./manifest";
import { listDirectory } from "./members";
import { mirrorAfter } from "./search";
import { isHtmlPath, isMarkdownPath, openWorkspace } from "./workspace";

/** The alphabet a random slug is drawn from — no look-alikes, as the engine's
 *  is (`SLUG_ALPHABET`, src-tauri/src/cloud/manifest.rs). */
const SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const RANDOM_SLUG_LEN = 8;

/** File types a page can show on their own (pages.ts `fileResponse`). */
const SERVED_AS_FILE = /\.(html|png|jpe?g|gif|webp|avif|svg|pdf)$/i;

function randomSlug(): string {
  const buf = new Uint8Array(RANDOM_SLUG_LEN);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => SLUG_ALPHABET[b % SLUG_ALPHABET.length]).join("");
}

/** What a page shows: a file (a document's, or a plain one) or a folder. */
type Target = { kind: "file"; entry: Entry; name: string; shown: "document" | "file" } | { kind: "dir"; path: string };

const sameTarget = (e: PublicEntry, t: Target, fids: readonly string[]): boolean =>
  t.kind === "dir" ? e.kind === "dir" && e.path.toLowerCase() === t.path.toLowerCase() : e.kind === "file" && fids.includes(e.file);

const describe = (e: PublicEntry): string =>
  e.kind === "file" ? e.path : e.path === "" ? "the whole workspace" : `the folder ${e.path}`;

const cleanText = (raw: unknown, max: number): string | undefined => {
  const text = typeof raw === "string" ? raw.trim().slice(0, max) : "";
  return text === "" ? undefined : text;
};

/**
 * What a path means to publishing. `/` is the whole workspace; a trailing
 * slash says "the folder"; otherwise a document, then a plain file, then a
 * folder — the order a path is read in everywhere else.
 */
function targetAt(index: Index, raw: string): { target: Target; fids: string[] } | Refusal {
  const asFolder = raw.endsWith("/");
  const path = raw.replace(/^\/+|\/+$/g, "");
  if (path === "") {
    return asFolder ? { target: { kind: "dir", path: "" }, fids: [] } : new Refusal(400, "say what to publish");
  }
  const problem = pathProblem(path);
  if (problem) return new Refusal(400, problem);
  if (!asFolder) {
    const at = locate(index, path, null);
    if (at instanceof Refusal) return at;
    if (at.kind === "document" && docExists(at.doc)) {
      const entry = primaryOf(at.doc)!;
      const fids = [at.doc.md?.fid, at.doc.html?.fid].filter((f): f is string => f !== undefined);
      return { target: { kind: "file", entry, name: at.doc.stem, shown: "document" }, fids };
    }
    if (at.kind === "file" && at.entry) {
      if (!SERVED_AS_FILE.test(at.entry.file.path)) {
        return new Refusal(400, `${at.entry.file.path} cannot be a page of its own — documents, pictures and PDFs can`);
      }
      return { target: { kind: "file", entry: at.entry, name: at.entry.file.path, shown: "file" }, fids: [at.entry.fid] };
    }
  }
  if (index.isFolder(path)) {
    // The folder's own spelling, from a file inside it.
    const inside = index.under(path)[0].file.path;
    return { target: { kind: "dir", path: inside.slice(0, path.length) }, fids: [] };
  }
  return new Refusal(404, `there is nothing at "${path}" to publish`);
}

/* ---------- What is public ---------- */

export async function getPages({ env, url }: Call): Promise<Response> {
  const ws = await openWorkspace(env);
  if (!ws) return notBound();
  const names = new Map(((await listDirectory(env)) ?? []).map((p) => [p.id, p.name]));
  return json({ pages: pagesOf(ws.manifest, url.origin, names) });
}

function pagesOf(m: Manifest, origin: string, names: ReadonlyMap<string, string>): Record<string, unknown>[] {
  return Object.keys(m.public ?? {})
    .sort()
    .map((slug) => {
      const e = m.public![slug];
      const live = e.kind === "file" ? m.files[e.file] : undefined;
      const path = live?.path ?? e.path;
      const isDoc = isMarkdownPath(path) || isHtmlPath(path);
      return {
        slug,
        url: `${origin}/${slug}`,
        kind: e.kind === "dir" ? "folder" : isDoc ? "document" : "file",
        path: e.kind === "dir" ? e.path : isDoc ? nameOf(path).stem : path,
        ...(e.title ? { title: e.title } : {}),
        ...(e.desc ? { desc: e.desc } : {}),
        ...(e.root ? { home: true } : {}),
        ...(e.by ? { by: e.by, ...(names.has(e.by) ? { byName: names.get(e.by) } : {}) } : {}),
        ...(e.at ? { at: e.at } : {}),
        // A page outlives its file: it answers 404 until the file is back.
        ...(e.kind === "file" && !live ? { missing: true } : {}),
      };
    });
}

/* ---------- Publishing ---------- */

export async function putPage(c: Call): Promise<Response> {
  const { request, env, url, who } = c;
  const body = await readJsonObject(request);
  if (!body) return json({ error: "invalid json body" }, 400);
  const path = typeof body.path === "string" ? body.path : "";
  const wanted = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
  if (wanted && (!SLUG_RE.test(wanted) || RESERVED_SLUGS.has(wanted))) {
    return json(
      { error: "an address is 3 to 64 characters — lowercase letters, digits and dashes, starting with a letter or a digit — and not a word Doklin keeps" },
      400,
    );
  }
  const title = cleanText(body.title, MAX_TITLE_LEN);
  const desc = cleanText(body.desc, MAX_DESC_LEN);

  const done = await commit(
    env,
    who.id,
    async (tx) => {
      const index = new Index(tx.files);
      const found = targetAt(index, path);
      if (found instanceof Refusal) return found;
      return publish(tx, index, found.target, found.fids, { wanted, title, desc }, url.origin);
    },
    { dryRun: body.dryRun === true },
  );
  if (done instanceof Refusal) return refuse(done);
  await mirrorAfter(c, done);
  const { created, ...answer } = done.value;
  // Not written: a dry run, or a page that already was exactly this.
  return json({ ...answer, created, ...(done.wrote ? {} : { written: false }) }, created && done.wrote ? 201 : 200);
}

function publish(
  tx: Tx,
  index: Index,
  target: Target,
  fids: readonly string[],
  ask: { wanted: string; title?: string; desc?: string },
  origin: string,
): (Record<string, unknown> & { created: boolean }) | Refusal {
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
    kind: target.kind === "dir" ? "folder" : target.shown,
    path: target.kind === "dir" ? target.path : target.name,
    // Everything this makes readable: one document, or every document in the
    // folder — an html-only one included, which a published folder serves at
    // its own name (pages.ts).
    documents,
    created: !prev,
  };
}

/* ---------- Stopping ---------- */

export async function deletePage(c: Call): Promise<Response> {
  const { env, url, who } = c;
  const slugParam = (url.searchParams.get("slug") ?? "").trim().toLowerCase();
  const path = url.searchParams.get("path") ?? "";
  if (!slugParam && !path) return json({ error: "say which page — a document, a folder or an address" }, 400);

  const done = await commit(env, who.id, async (tx) => {
    const map = tx.m.public ?? {};
    const slugs = slugParam ? (map[slugParam] ? [slugParam] : []) : slugsFor(tx, path);
    if (slugs instanceof Refusal) return slugs;
    if (slugs.length === 0) {
      return new Refusal(404, slugParam ? `nothing is published at "${slugParam}"` : `"${path}" is not published`);
    }
    const stopped = slugs.map((slug) => ({ slug, url: `${url.origin}/${slug}` }));
    for (const slug of slugs) delete map[slug];
    tx.touch();
    return { stopped };
  }, { dryRun: url.searchParams.get("dry") === "1" });
  if (done instanceof Refusal) return refuse(done);
  await mirrorAfter(c, done);
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
