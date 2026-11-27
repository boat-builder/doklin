// Tags through the document API: the workspace's tag list, a tag or a value
// added to it, and a note's tags set by name.
//
//   GET  /api/agent/tags                         {tags: [{name, values, desc?}]}
//   POST /api/agent/tags  {name, values: [value], dryRun?}
//                                                → {tag, added, created?, unchanged?}
//   POST /api/agent/tag   {path, set: {<name>: value | null}, dryRun?}
//                                                → {path, version, rev, tags, unchanged?}
//
// An agent only adds to the list: a new tag with its values, or values at
// the end of a tag's. Renaming and removing are a person's, in the app,
// which rewrites the notes that have the old name.
//
// A tag set here is written the way the app writes one (src/tags.ts,
// `writeTag`): the note's line for the tag, spelled as the list spells the
// tag and the value, and nothing else in the file changes. It is held to the
// list as every agent's write of a note is (tagList.ts), and written over the
// revision it read in the same manifest write.

import { change, refuse, type Call } from "./agentCall";
import { finish } from "./agentDocs";
import { keepPublic } from "./changes";
import { Refusal } from "./commit";
import { Index, docExists, locate } from "./documents";
import { json, readJsonObject } from "./http";
import { mirrorAfter } from "./search";
import { changeTagList, noSuchTag, readTagList, valueRefusal } from "./tagList";
import { TAGS_MAX, noteTags, tagProblem, withTag, writeTag, type TagDef } from "../../src/tags";

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export async function getTags(c: Call): Promise<Response> {
  return json({ tags: await readTagList(c.env) });
}

/** Add a tag to the list, or values to a tag it has: what an agent may
 *  change of it. A value the tag has already, in any case, is left as the
 *  list spells it. */
export async function postTags(c: Call): Promise<Response> {
  const body = await readJsonObject(c.request);
  if (!body) return json({ error: "invalid json body" }, 400);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const values = Array.isArray(body.values) && body.values.every((v) => typeof v === "string") ? body.values.map((v: string) => v.trim()) : null;
  if (name === "" || !values || values.length === 0) {
    return json({ error: "name is the tag, and values what to add to it — doklin tags add status Blocked" }, 400);
  }
  const done = await changeTagList(
    c.env,
    c.who.id,
    (tags) => {
      const had = tags.find((d) => same(d.name, name));
      const added: string[] = [];
      for (const v of values) {
        if (![...(had?.values ?? []), ...added].some((o) => same(o, v))) added.push(v);
      }
      const def: TagDef = had ? { ...had, values: [...had.values, ...added] } : { name, values: added };
      const wrong = tagProblem(def, tags, had?.name);
      if (wrong) return new Refusal(400, wrong, { code: "tag_list" });
      if (!had && tags.length >= TAGS_MAX) {
        return new Refusal(400, `this workspace has ${TAGS_MAX} tags, the most it can have — ask your person which to use`, { code: "tag_list" });
      }
      const value = { tag: def, added, ...(had ? {} : { created: true }), ...(added.length === 0 ? { unchanged: true } : {}) };
      return { tags: withTag(tags, had?.name ?? name, def), value };
    },
    body.dryRun === true,
  );
  if (done instanceof Refusal) return refuse(done);
  return json({ ...done.value, ...(done.wrote ? {} : { written: false }) });
}

export async function postTag(c: Call): Promise<Response> {
  const body = await readJsonObject(c.request);
  if (!body) return json({ error: "invalid json body" }, 400);
  const path = typeof body.path === "string" ? body.path : "";
  const set = body.set;
  const asked = set !== null && typeof set === "object" && !Array.isArray(set) ? Object.entries(set as Record<string, unknown>) : [];
  if (asked.length === 0 || asked.some(([, v]) => v !== null && typeof v !== "string")) {
    return json({ error: "set is {<tag>: value} — a value from the list, or null to remove the tag" }, 400);
  }
  const list = await readTagList(c.env);

  // Each tag and value as the list spells them, or why one isn't the list's.
  const changes: { def: TagDef; value: string | null }[] = [];
  for (const [name, raw] of asked) {
    const def = list.find((d) => same(d.name, name.trim()));
    if (!def) return refuse(noSuchTag(name.trim(), list));
    if (raw === null) {
      changes.push({ def, value: null });
      continue;
    }
    const typed = (raw as string).trim();
    const wrong = valueRefusal(def, typed);
    if (wrong) return refuse(wrong);
    changes.push({ def, value: def.values.find((v) => same(v, typed))! });
  }
  // In the list's order, whatever order the request names them in: lines
  // a note doesn't have yet are added in that order.
  changes.sort((a, b) => list.indexOf(a.def) - list.indexOf(b.def));

  const done = await change(
    c,
    async (tx) => {
      const index = new Index(tx.files);
      const at = locate(index, path, null);
      if (at instanceof Refusal) return at;
      const { doc } = at;
      if (!docExists(doc)) return new Refusal(404, `there is no document at "${path}"`);
      if (at.asked === "html" || !doc.md) {
        return new Refusal(400, `${doc.stem} has only an html version — tags are a note's, in its markdown`, { code: "html_only" });
      }
      const now = await tx.readText(doc.md.fid);
      if (now === null) return new Refusal(503, "its content has not finished syncing — try again in a moment");
      let text = now;
      for (const { def, value } of changes) text = writeTag(text, def.name, value === null ? null : { name: def.name, value });
      const written = await finish(tx, doc, "md", doc.md, doc.md.file.path, new TextEncoder().encode(text));
      keepPublic(tx);
      return { path: written.path, version: "md", rev: written.rev, tags: noteTags(text, list), ...(written.unchanged ? { unchanged: true } : {}) };
    },
    body.dryRun === true,
  );
  if (done instanceof Refusal) return refuse(done);
  await mirrorAfter(c, done);
  return json({ ...done.value, ...(done.wrote ? {} : { written: false }) });
}
