// The workspace's tag list as the worker reads it, the filters a search or
// a listing narrows by, and the check an agent's write passes. The rules
// themselves are src/tags.ts, which the app and the iPhone keep too.
//
// The list is `Tags.md` at the top of Library: the shared workspace's own
// `Tags.md`, whatever its case. Everyone sees Library, so every caller reads
// the same list, whichever section their write or their search is in.
//
// The file format can't hold a note to the list, so the writers do: the
// picker for people, and the check below for agents. A write is held to the
// list only where it changes a tag's line, compared with the text as it is
// stored: a body edit never fails over a value somebody removed later.

import { Refusal } from "./commit";
import type { Env } from "./env";
import { LIBRARY_FOLDER } from "./layout";
import { sharedEnv } from "./spaces";
import { openWorkspace } from "./workspace";
import { TAG_NOTE, keyedLines, listProblem, parseTagList, quoteValue, type TagDef, type TagFilter } from "../../src/tags";

/** How the list's note is named to an agent, and to people in a sentence. */
export const TAG_NOTE_NAMED = `${LIBRARY_FOLDER}/${TAG_NOTE.replace(/\.md$/i, "")}`;

/** Tags one search or listing narrows by, at most: each is a condition the
 *  index is asked about. */
const MAX_FILTERS = 8;

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The workspace's tags, in the list's order, and where the list is. */
export type TagList = {
  /** The list's note as an agent names it: its path, without the extension. */
  note: string;
  /** Whether there is such a note. */
  exists: boolean;
  tags: TagDef[];
};

/** Whether a file is the list: `Tags.md` at the top of the shared
 *  workspace — `path` as an agent names it, under `Library/`. */
export const isTagNote = (space: string, path: string): boolean => space === "" && same(path, `${LIBRARY_FOLDER}/${TAG_NOTE}`);

/** The list, read from the shared workspace — no tags when it holds no
 *  list note. 503 while the note's content is still on its way. */
export async function readTagList(env: Env): Promise<TagList | Refusal> {
  const ws = await openWorkspace(sharedEnv(env));
  const at = ws?.fileAt(TAG_NOTE) ?? null;
  if (!ws || !at) return { note: TAG_NOTE_NAMED, exists: false, tags: [] };
  const text = await ws.text(at, Number.MAX_SAFE_INTEGER);
  if (text === null) return new Refusal(503, "the tag list has not finished syncing — try again in a moment");
  return { note: `${LIBRARY_FOLDER}/${at.file.path.replace(/\.md$/i, "")}`, exists: true, tags: parseTagList(text) };
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
export function listedFilters(filters: readonly TagFilter[], list: TagList): TagFilter[] | Refusal {
  const out: TagFilter[] = [];
  for (const f of filters) {
    const def = list.tags.find((d) => same(d.name, f.name));
    if (!def) return noSuchTag(f.name, list);
    out.push({ name: def.name, value: f.value === null ? null : (def.values.find((v) => same(v, f.value!)) ?? f.value) });
  }
  return out;
}

export function noSuchTag(name: string, list: TagList): Refusal {
  const known = list.tags.map((d) => d.name);
  return new Refusal(
    400,
    known.length === 0
      ? `this workspace has no tags yet — a tag is a line in ${TAG_NOTE_NAMED} (doklin help tags)`
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
    `${def.name} takes ${orList(def.values)}, not "${value}" — use one of those, or add "${value}" to ${def.name}'s line in ${TAG_NOTE_NAMED} first (ask your person if you aren't sure)`,
    { code: "tag_value", tag: def.name, values: def.values },
  );
}

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

/** Whether an agent's new text of the list is one the app can read whole:
 *  every line of its block a tag, names unique, values valid. */
export function listKept(text: string, note: string): Refusal | null {
  const problem = listProblem(text);
  if (!problem) return null;
  return new Refusal(400, `the tag list (${note}) can't hold line ${problem.line}, "${problem.text}". ${problem.problem}`, {
    code: "tag_list",
    line: problem.line,
  });
}
