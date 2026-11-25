// Tags through the document API: the workspace's tag list, and a note's
// tags set by name.
//
//   GET  /api/agent/tags                         {note, exists, tags: [{name, values}]}
//   POST /api/agent/tag   {path, set: {<name>: value | null}, dryRun?}
//                                                → {path, version, rev, tags, unchanged?}
//
// A tag set here is written the way the app writes one (src/tags.ts,
// `writeTag`): the note's line for the tag, spelled as the list spells the
// tag and the value, and nothing else in the file changes. It is held to the
// list as every agent's write of a note is (tagList.ts), and written over the
// revision it read in the same manifest write. The list itself is changed as
// any note is, by a write of `Library/Tags`; nothing here rewrites notes when
// a value is renamed — that is the app's.

import { change, refuse, type Call } from "./agentCall";
import { finish } from "./agentDocs";
import { keepPublic } from "./changes";
import { Refusal } from "./commit";
import { Index, docExists, locate } from "./documents";
import { json, readJsonObject } from "./http";
import { mirrorAfter } from "./search";
import { spaceOf } from "./spaces";
import { isTagNote, noSuchTag, readTagList, valueRefusal } from "./tagList";
import { noteTags, writeTag, type TagDef } from "../../src/tags";

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export async function getTags(c: Call): Promise<Response> {
  const list = await readTagList(c.env);
  return list instanceof Refusal ? refuse(list) : json(list);
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
  if (list instanceof Refusal) return refuse(list);

  // Each tag and value as the list spells them, or why one isn't the list's.
  const changes: { def: TagDef; value: string | null }[] = [];
  for (const [name, raw] of asked) {
    const def = list.tags.find((d) => same(d.name, name.trim()));
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
  changes.sort((a, b) => list.tags.indexOf(a.def) - list.tags.indexOf(b.def));

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
      if (isTagNote(spaceOf(c.env), doc.md.file.path)) {
        return new Refusal(400, `${doc.stem} is the tag list itself — change it with doklin edit, or doklin write`);
      }
      const now = await tx.readText(doc.md.fid);
      if (now === null) return new Refusal(503, "its content has not finished syncing — try again in a moment");
      let text = now;
      for (const { def, value } of changes) text = writeTag(text, def.name, value === null ? null : { name: def.name, value });
      const written = await finish(tx, doc, "md", doc.md, doc.md.file.path, new TextEncoder().encode(text));
      keepPublic(tx);
      return { path: written.path, version: "md", rev: written.rev, tags: noteTags(text, list.tags), ...(written.unchanged ? { unchanged: true } : {}) };
    },
    body.dryRun === true,
  );
  if (done instanceof Refusal) return refuse(done);
  await mirrorAfter(c, done);
  return json({ ...done.value, ...(done.wrote ? {} : { written: false }) });
}
