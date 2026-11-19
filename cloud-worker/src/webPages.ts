// Publishing, from a browser (web.ts lists the routes).
//
// What a page is and the rules its entry keeps are publishing.ts's — the
// ones an agent publishes by, and the engine's. A page is published in the
// section its document is in, and stopped in whichever section of the
// person's holds its address (addresses.ts). The home page is the one thing
// here an agent has no way to choose.

import { spaceAt } from "./addresses";
import { Refusal, commit } from "./commit";
import { Index, pathProblem } from "./documents";
import { json, readJsonObject } from "./http";
import { MAX_DESC_LEN, MAX_TITLE_LEN, SLUG_RE } from "./layout";
import { cleanText, documentTarget, folderTarget, publish, slugProblem } from "./publishing";
import { mirrorAfter } from "./search";
import { refuse, sectionOf, trimSlashes, type WebCall } from "./webCall";

/** Publish a document or a folder — "" is the whole section — or give the
 *  page it has another address, title or description. */
export async function putPage(c: WebCall): Promise<Response> {
  const body = await readJsonObject(c.request);
  if (!body) return json({ error: "invalid json body" }, 400);
  const { kind } = body;
  if (kind !== "document" && kind !== "folder") return json({ error: 'kind is "document" or "folder"' }, 400);
  const path = trimSlashes(body.path);
  const problem = path === "" ? (kind === "folder" ? null : "say what to publish") : pathProblem(path);
  if (problem) return json({ error: problem }, 400);
  const wanted = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
  const unusable = wanted ? slugProblem(wanted) : null;
  if (unusable) return json({ error: unusable }, 400);
  const title = cleanText(body.title, MAX_TITLE_LEN);
  const desc = cleanText(body.desc, MAX_DESC_LEN);
  const where = await sectionOf(c, body.space);
  if (where instanceof Refusal) return refuse(where);

  const done = await commit(where.env, c.auth.memberId, async (tx) => {
    const index = new Index(tx.files);
    const found = kind === "folder" ? folderTarget(index, path) : documentTarget(index, path);
    if (found instanceof Refusal) return found;
    if (!found) return new Refusal(404, kind === "folder" ? `there is no folder "${path}"` : `there is no document at "${path}"`);
    return publish(tx, index, found, { wanted, title, desc }, c.url.origin);
  });
  if (done instanceof Refusal) return refuse(done);
  await mirrorAfter({ env: where.env, ctx: c.ctx }, done);
  return json({ ...done.value, etag: done.etag }, done.value.created && done.wrote ? 201 : 200);
}

/** Stop a page. Its address is in one section of the domain: the shared
 *  workspace unless the registry names a space — which answers only its own
 *  people, so a page of a folder they are not in is no page to them. */
export async function deletePage(c: WebCall): Promise<Response> {
  const slug = (c.url.searchParams.get("slug") ?? "").trim().toLowerCase();
  if (!SLUG_RE.test(slug)) return json({ error: "say which address to stop" }, 400);
  const nothing = new Refusal(404, `nothing is published at "${slug}"`);
  const where = await sectionOf(c, (await spaceAt(c.env, slug)) ?? "");
  if (where instanceof Refusal) return refuse(where.status === 404 ? nothing : where);

  const done = await commit(where.env, c.auth.memberId, async (tx) => {
    const map = tx.m.public ?? {};
    if (!map[slug]) return nothing;
    delete map[slug];
    tx.touch();
    return { slug };
  });
  if (done instanceof Refusal) return refuse(done);
  await mirrorAfter({ env: where.env, ctx: c.ctx }, done);
  return json({ ...done.value, etag: done.etag });
}

/** Choose the page the domain's `/` shows, or none. It is one of the shared
 *  workspace's pages: `/` belongs to everybody here (manifest.ts). */
export async function putHome(c: WebCall): Promise<Response> {
  const body = await readJsonObject(c.request);
  if (!body) return json({ error: "invalid json body" }, 400);
  const slug = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : body.slug;
  if (slug !== null && (typeof slug !== "string" || !SLUG_RE.test(slug))) {
    return json({ error: "slug is the address of the page to show at /, or null for none" }, 400);
  }
  const shared = await sectionOf(c, "");
  if (shared instanceof Refusal) return refuse(shared);
  const elsewhere = slug === null ? null : await spaceAt(c.env, slug);

  const done = await commit(shared.env, c.auth.memberId, async (tx) => {
    const map = tx.m.public ?? {};
    if (slug !== null && !map[slug]) {
      return elsewhere
        ? new Refusal(409, "The home page is chosen from Library.")
        : new Refusal(404, `nothing is published at "${slug}"`);
    }
    for (const [at, entry] of Object.entries(map)) {
      const home = at === slug;
      if ((entry.root === true) === home) continue;
      if (home) entry.root = true;
      else delete entry.root;
      tx.touch();
    }
    return { home: slug };
  });
  if (done instanceof Refusal) return refuse(done);
  await mirrorAfter({ env: shared.env, ctx: c.ctx }, done);
  return json({ ...done.value, etag: done.etag });
}
