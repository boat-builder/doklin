// The workspace's tag list from a browser: a tag set — made, or changed in
// its place — or removed. It is the change a device queues
// (engine/src/cloud/tags.rs), held to the same rules (src/tags.ts) and
// written over the list as the shared workspace's manifest has it now
// (tagList.ts): two changes of one tag at once, and the later one wins. A
// rename here changes no note; the browser rewrites the notes that have the
// old name, as the Mac does.

import { Refusal } from "./commit";
import { json, readJsonObject } from "./http";
import { changeTagList } from "./tagList";
import { refuse, type WebCall } from "./webCall";
import { TAGS_MAX, tagProblem, withTag, withoutTag, type TagDef } from "../../src/tags";

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** A tag as somebody typed it: trimmed, and what its values mean gone when
 *  there is nothing — or null when it isn't one. */
function typedTag(raw: unknown): TagDef | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { name, values, desc } = raw as Record<string, unknown>;
  if (typeof name !== "string" || !Array.isArray(values) || !values.every((v) => typeof v === "string")) return null;
  if (desc !== undefined && desc !== null && typeof desc !== "string") return null;
  const meaning = typeof desc === "string" ? desc.trim() : "";
  return { name: name.trim(), values: values.map((v: string) => v.trim()), ...(meaning ? { desc: meaning } : {}) };
}

/** `{at, tag}`: the tag that was `at` — or a new one, when none is called
 *  that — is now `tag`, in its place. */
export async function putTags(c: WebCall): Promise<Response> {
  const body = await readJsonObject(c.request);
  if (!body) return json({ error: "invalid json body" }, 400);
  const def = typedTag(body.tag);
  if (typeof body.at !== "string" || !def) return json({ error: "at is the tag's name before, and tag what it is now" }, 400);
  const at = body.at.trim();
  const done = await changeTagList(c.env, c.auth.memberId, (tags) => {
    const was = tags.find((d) => same(d.name, at));
    const wrong = tagProblem(def, tags, was?.name);
    if (wrong) return new Refusal(400, wrong);
    if (!was && tags.length >= TAGS_MAX) return new Refusal(400, `A workspace can have ${TAGS_MAX} tags at most.`);
    return { tags: withTag(tags, at, def), value: null };
  });
  if (done instanceof Refusal) return refuse(done);
  return json({ tags: done.manifest.tags ?? [], etag: done.etag });
}

/** `?name=`: the tag leaves the list, and the notes that have it keep their
 *  line, which is then plain frontmatter. */
export async function deleteTags(c: WebCall): Promise<Response> {
  const name = (c.url.searchParams.get("name") ?? "").trim();
  if (name === "") return json({ error: "name is the tag to remove" }, 400);
  const done = await changeTagList(c.env, c.auth.memberId, (tags) =>
    tags.some((d) => same(d.name, name)) ? { tags: withoutTag(tags, name), value: null } : new Refusal(404, `There's no tag called ${name}.`),
  );
  if (done instanceof Refusal) return refuse(done);
  return json({ tags: done.manifest.tags ?? [], etag: done.etag });
}
