// The workspace's tag list as the worker reads and changes it, the filters
// a search or a listing narrows by, and the check an agent's write passes.
// The rules themselves are src/tags.ts, which the app and the iPhone keep
// too.
//
// The list is the shared workspace's manifest's `tags` (manifest.ts). Every
// caller reads the same list, whichever section their write or their search
// is in, and a change of it is a write of that manifest, over the list as it
// is then: two changes of one tag at once, and the later one wins, as when a
// device's change lands (engine/src/cloud/tags.rs).
//
// A note's write is held to the list only where it changes a tag's line,
// compared with the text as it is stored: a body edit never fails over a
// value somebody removed later.

import { Refusal, commit, type Committed } from "./commit";
import type { Env } from "./env";
import { sharedEnv } from "./spaces";
import { openWorkspace } from "./workspace";
import { keyedLines, quoteValue, type TagDef, type TagFilter } from "../../src/tags";

/** Tags one search or listing narrows by, at most: each is a condition the
 *  index is asked about. */
const MAX_FILTERS = 8;

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The workspace's tags, in order — none when the domain holds no
 *  workspace yet. */
export async function readTagList(env: Env): Promise<TagDef[]> {
  const ws = await openWorkspace(sharedEnv(env));
  return ws?.manifest.tags ?? [];
}

/**
 * Change the list: `change` is handed it as the shared workspace's manifest
 * has it now, and answers what it becomes and what to say — or a Refusal,
 * and nothing is written. Signed `by`; `dryRun` checks and writes nothing.
 */
export function changeTagList<T>(
  env: Env,
  by: string,
  change: (tags: TagDef[]) => { tags: TagDef[]; value: T } | Refusal,
  dryRun = false,
): Promise<Committed<T> | Refusal> {
  return commit(
    sharedEnv(env),
    by,
    async (tx) => {
      const now = tx.m.tags ?? [];
      const done = change(now);
      if (done instanceof Refusal) return done;
      if (JSON.stringify(done.tags) !== JSON.stringify(now)) {
        tx.m.tags = done.tags;
        tx.touch();
      }
      return done.value;
    },
    { dryRun },
  );
}

/**
 * The tags a request narrows by: each `key` parameter is `name:value`, or a
 * bare `name` for a note that has the tag with any value. A name never holds
 * a colon (src/tags.ts), so the first one splits it.
 */
export function filtersOf(params: URLSearchParams, key: "where" | "tag"): TagFilter[] | Refusal {
  const out: TagFilter[] = [];
  for (const raw of params.getAll(key)) {
    const colon = raw.indexOf(":");
    const name = (colon === -1 ? raw : raw.slice(0, colon)).trim();
    const value = colon === -1 ? null : raw.slice(colon + 1).trim();
    if (name === "" || value === "") {
      return new Refusal(400, `${key} is a tag and its value, as status:Doing — or a tag's name alone, for any value`);
    }
    out.push({ name, value });
  }
  if (out.length > MAX_FILTERS) return new Refusal(400, `narrow by ${MAX_FILTERS} tags at most`);
  return out;
}

/** Filters as the list spells them, or why one names no tag. A value the
 *  list doesn't have is still asked for: a note can hold one. */
export function listedFilters(filters: readonly TagFilter[], list: readonly TagDef[]): TagFilter[] | Refusal {
  const out: TagFilter[] = [];
  for (const f of filters) {
    const def = list.find((d) => same(d.name, f.name));
    if (!def) return noSuchTag(f.name, list);
    out.push({ name: def.name, value: f.value === null ? null : (def.values.find((v) => same(v, f.value!)) ?? f.value) });
  }
  return out;
}

export function noSuchTag(name: string, list: readonly TagDef[]): Refusal {
  const known = list.map((d) => d.name);
  return new Refusal(
    400,
    known.length === 0
      ? "this workspace has no tags yet — people make them in Doklin's Settings, and doklin tags add makes one (ask your person first)"
      : `there is no tag called "${name}" — the tags are ${orList(known)} (doklin tags lists their values)`,
    { code: "no_tag", tags: known },
  );
}

const orList = (items: readonly string[]): string =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;

/** Why a tag can't be set to a value, or null: the list doesn't have it. */
export function valueRefusal(def: TagDef, value: string): Refusal | null {
  if (def.values.some((v) => same(v, value))) return null;
  return new Refusal(
    400,
    `${def.name} takes ${orList(def.values)}, not "${value}" — use one of those, or add it first with doklin tags add ${quoteArg(def.name)} ${quoteArg(value)} (ask your person if you aren't sure)`,
    { code: "tag_value", tag: def.name, values: def.values },
  );
}

/** A word as a shell takes it whole. */
const quoteArg = (word: string): string => (/^[\p{L}\p{N}_.:-]+$/u.test(word) ? word : `"${word.replace(/(["\\$`])/g, "\\$1")}"`);

/**
 * Whether an agent's new text of a note keeps to the list. Only a listed
 * tag's line that the write adds or changes is checked: it must be one
 * value, and one of the tag's. A line left exactly as it was passes,
 * whatever it holds.
 */
export function tagsKept(before: string, after: string, list: readonly TagDef[]): Refusal | null {
  const was = keyedLines(before);
  const now = keyedLines(after);
  for (const def of list) {
    const line = now.find((l) => same(l.key, def.name));
    if (!line) continue;
    const old = was.find((l) => same(l.key, def.name));
    if (old && old.key === line.key && old.value === line.value) continue;
    if (line.value === null) {
      return new Refusal(
        400,
        `${def.name} takes one value — write its line as "${def.name}: ${quoteValue(def.values[0])}", with ${orList(def.values)}`,
        { code: "tag_value", tag: def.name, values: def.values },
      );
    }
    const wrong = valueRefusal(def, line.value);
    if (wrong) return wrong;
  }
  return null;
}
