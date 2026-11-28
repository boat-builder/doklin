// Where an agent's path is.
//
// An agent sees what its person sees, under the names on that person's disk,
// and every path it types starts with one of three folders:
//
//   Library/…           everyone in the workspace
//   My files/…          its person's own
//   Shared with me/…    what others shared with its person, each under its own name
//
// A path is literal. Nothing but its segments says where it is, and no
// setting changes what a path means. A path that starts with none of the
// three is in no section, and is refused with a sentence that says which to
// use: nothing reaches everyone by being left unsaid. The workspace itself
// (`""`) is the three side by side, a place to list and search and nothing
// else, and so is `Shared with me`.
//
// Sections are a tree (spaces.ts): something shared is a section of its own,
// and sits where its item is. For its owner that is inside My files, or
// inside another shared folder — `My files/Work/Plans` — in the folder the
// parent section's manifest says (`mounts`). For somebody it is shared with,
// who cannot open that folder, it is at the top of `Shared with me`. So a
// path is answered in the deepest section that holds it: `My files/Work/Plan`
// reaches a shared document where it sits, with that section's part of the
// bucket and its manifest mounted there (mount.ts).
//
// Whether the agent's person can open a section is asked on every request, of
// the rows their own token is asked of: something shared with them, taken
// back, their removal from the workspace — the agent follows by its next
// command. What they cannot open answers what nothing answers.
//
// A share is called what a Mac calls it (`candidates`,
// engine/src/cloud/space.rs — change both): its name; its name and its
// owner's when that name is taken where it sits; then a number. A Mac gives
// the names out in the order shares reach it and the worker in the order
// they were made, so of two with one name a Mac may have the other one
// first — `doklin ls "Shared with me"` says what each is called here.

import type { Auth } from "./auth";
import { Refusal } from "./commit";
import type { Env } from "./env";
import { pathProblem } from "./documents";
import { LIBRARY_FOLDER, MAX_ITEM_NAME_LEN, MY_FILES_FOLDER, SHARED_FOLDER } from "./layout";
import type { Manifest } from "./manifest";
import { listDirectory } from "./members";
import { splitName } from "./mount";
import { withDb } from "./schema";
import { ensurePrivate, listOpenSpaces, sharedEnv, spaceEnv, type Where } from "./spaces";
import type { Space } from "./wire";
import { openWorkspace, type Workspace } from "./workspace";

/** Where a share's item is, as its person names paths. */
export type Shared = {
  space: Space;
  /** The section it sits in, when its person can open that; null for one at
   *  the top of `Shared with me`. */
  parent: Section | null;
  /** The folder its item is in: `My files/Work`, or `Shared with me`. */
  dir: string;
  /** The name its item goes by there. */
  shown: string;
};

/** A section, and which kind it is. `mount` is the folder its paths are
 *  under, as its person names them: `Library`, `My files`, a shared folder's
 *  own `My files/Work/Plans`, and for a shared document the folder it is in. */
export type Section = Where & {
  kind: "shared" | "private" | "folder" | "document";
  /** For something shared. */
  share?: Shared;
};

/** The path of a share's item: a folder, or a document without its extension. */
export const itemPath = (s: Shared): string => `${s.dir}/${s.shown}`;

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const under = (path: string, dir: string): boolean => path.toLowerCase().startsWith(`${dir.toLowerCase()}/`);

/** Whether a section's own files could be at or under `dir`. */
export const reaches = (s: Section, dir: string): boolean =>
  s.share && s.kind === "document"
    ? same(s.share.dir, dir) || under(s.share.dir, dir)
    : same(s.mount, dir) || under(s.mount, dir);

/** A name a file on a Mac can carry (`item_name`, engine/src/cloud/space.rs —
 *  change both). */
function fileName(name: string): string {
  const cleaned = name
    .replace(/[/:\0\\]/g, "-")
    .trim()
    .replace(/^\.+|\.+$/g, "");
  return cleaned === "" ? "Untitled" : [...cleaned].slice(0, MAX_ITEM_NAME_LEN).join("");
}

/** What is already called something in one folder: its folders, and its
 *  documents by their names without an extension. Lower-cased. */
export type Taken = { folders: Set<string>; documents: Set<string> };

/** What a section's own files take in the folder `dir` of it ("" its top). */
export function takenIn(m: Pick<Manifest, "files">, dir: string): Taken {
  const taken: Taken = { folders: new Set(), documents: new Set() };
  const prefix = dir === "" ? "" : `${dir.toLowerCase()}/`;
  for (const f of Object.values(m.files)) {
    const lower = f.path.toLowerCase();
    if (!lower.startsWith(prefix)) continue;
    const rest = lower.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash >= 0) taken.folders.add(rest.slice(0, slash));
    else taken.documents.add(splitName(rest)[0]);
  }
  return taken;
}

/**
 * The name each share goes by in one folder, given in the order they were
 * made: a folder among the folders there, a document among the documents.
 */
export function shownNames(
  shares: readonly Pick<Space, "id" | "kind" | "name" | "owner">[],
  taken: Taken,
  ownerName: (id: string) => string,
): Map<string, string> {
  const names = new Map<string, string>();
  for (const s of shares) {
    const among = s.kind === "document" ? taken.documents : taken.folders;
    const base = fileName(s.name);
    const owner = ownerName(s.owner);
    const tries = [base, ...(owner ? [`${base} (${fileName(owner)})`] : [])];
    let name = tries.find((t) => !among.has(t.toLowerCase()));
    for (let n = 2; name === undefined; n += 1) {
      if (!among.has(`${base} ${n}`.toLowerCase())) name = `${base} ${n}`;
    }
    among.add(name.toLowerCase());
    names.set(s.id, name);
  }
  return names;
}

const noDatabase = (): Refusal => new Refusal(503, "this domain's database is not answering — try again in a moment");

/** What a path that names a heading and nothing in it is told. */
const HEADINGS = `${LIBRARY_FOLDER}/… (everyone), "${MY_FILES_FOLDER}/…" (only your person) or "${SHARED_FOLDER}/<name>/…" (what others shared with them)`;

/** What the folders of an older Doklin are called now. */
const RENAMED: Record<string, string> = {
  private: `Private is called "${MY_FILES_FOLDER}" now — use "${MY_FILES_FOLDER}/…".`,
  restricted: `There is no Restricted any more: what is shared stays where it was shared from — under "${MY_FILES_FOLDER}/…" for its owner, and under "${SHARED_FOLDER}/…" for the people it is shared with.`,
};

/** Every section one agent's person can see, read at most once a request. */
export class Places {
  private readonly shared: Section;
  private listed: Promise<Section[] | null> | undefined;
  private rows: Promise<Space[] | null> | undefined;
  private names: Promise<Map<string, string>> | undefined;
  private readonly opened = new Map<string, Promise<Workspace | null>>();

  constructor(
    env: Env,
    /** The agent's own `Auth`: its `memberId` is its person. */
    private readonly person: Auth,
  ) {
    const whole = sharedEnv(env);
    this.shared = { space: "", kind: "shared", mount: LIBRARY_FOLDER, env: whole };
  }

  /** A section's tree, read once a request. */
  open(section: Pick<Where, "space" | "env">): Promise<Workspace | null> {
    let ws = this.opened.get(section.space);
    if (!ws) this.opened.set(section.space, (ws = openWorkspace(section.env)));
    return ws;
  }

  /** The spaces the person can open, as the database lists them — their own
   *  My files among them, made if this is the first anything asks. */
  private spaces(): Promise<Space[] | null> {
    this.rows ??= (async () => {
      const env = this.shared.env;
      const rows = await listOpenSpaces(env, this.person);
      if (rows === null) return null;
      if (rows.some((r) => r.kind === "private")) return rows;
      const mine = await ensurePrivate(env, this.person);
      return mine === null ? null : [mine, ...rows];
    })();
    return this.rows;
  }

  private ownerName = async (id: string): Promise<string> => {
    this.names ??= listDirectory(this.shared.env).then((all) => new Map((all ?? []).map((p) => [p.id, p.name])));
    return (await this.names).get(id) ?? "";
  };

  /** Library, then My files and what is shared from it, then what is shared
   *  with the person — each kind by the folder it is at. Null when the
   *  database cannot say. */
  all(): Promise<Section[] | null> {
    this.listed ??= this.list();
    return this.listed;
  }

  private async list(): Promise<Section[] | null> {
    const env = this.shared.env;
    const rows = await this.spaces();
    if (rows === null) return null;
    const mine = rows.find((r) => r.kind === "private");
    if (!mine) return null;
    const own: Section = { space: mine.id, kind: "private", mount: MY_FILES_FOLDER, env: spaceEnv(env, mine) };

    const kids = new Map<string | null, Space[]>();
    for (const r of rows) {
      if (r.kind === "private") continue;
      kids.set(r.parent, [...(kids.get(r.parent) ?? []), r]);
    }
    // The owners' names are read only where one is needed: a name taken twice.
    const owners = new Map<string, string>();
    const named = async (shares: readonly Space[], taken: Taken): Promise<Map<string, string>> => {
      const first = shownNames(shares, { folders: new Set(taken.folders), documents: new Set(taken.documents) }, () => "");
      if (shares.every((s) => same(first.get(s.id) ?? "", fileName(s.name)))) return first;
      for (const s of shares) if (!owners.has(s.owner)) owners.set(s.owner, await this.ownerName(s.owner));
      return shownNames(shares, taken, (id) => owners.get(id) ?? "");
    };
    const section = (space: Space, parent: Section | null, dir: string, shown: string): Section => {
      const share: Shared = { space, parent, dir, shown };
      return space.kind === "document"
        ? { space: space.id, kind: "document", mount: dir, named: { stored: space.name, shown }, env: spaceEnv(env, space), share }
        : { space: space.id, kind: "folder", mount: `${dir}/${shown}`, env: spaceEnv(env, space), share };
    };

    const shares: Section[] = [];
    // What sits in a section: placed by that section's manifest, each folder
    // of it naming its own.
    const place = async (parent: Section): Promise<void> => {
      const inside = kids.get(parent.space);
      if (!inside) return;
      const manifest = (await this.open(parent))?.manifest;
      const byDir = new Map<string, Space[]>();
      for (const s of inside) {
        const dir = manifest?.mounts?.[s.id]?.dir ?? "";
        byDir.set(dir.toLowerCase(), [...(byDir.get(dir.toLowerCase()) ?? []), s]);
      }
      for (const group of byDir.values()) {
        const dir = manifest?.mounts?.[group[0].id]?.dir ?? "";
        const names = await named(group, manifest ? takenIn(manifest, dir) : { folders: new Set(), documents: new Set() });
        for (const s of group) {
          const made = section(s, parent, dir === "" ? parent.mount : `${parent.mount}/${dir}`, names.get(s.id) ?? s.name);
          shares.push(made);
          if (made.kind === "folder") await place(made);
        }
      }
    };
    await place(own);
    const tops = kids.get(null) ?? [];
    const names = await named(tops, { folders: new Set(), documents: new Set() });
    for (const s of tops) {
      const made = section(s, null, SHARED_FOLDER, names.get(s.id) ?? s.name);
      shares.push(made);
      if (made.kind === "folder") await place(made);
    }
    const byPath = (a: Section, b: Section): number =>
      itemPath(a.share!).localeCompare(itemPath(b.share!), undefined, { sensitivity: "base" }) || (a.space < b.space ? -1 : 1);
    const mineFirst = (s: Section): number => (under(s.share!.dir, MY_FILES_FOLDER) || same(s.share!.dir, MY_FILES_FOLDER) ? 0 : 1);
    shares.sort((a, b) => mineFirst(a) - mineFirst(b) || byPath(a, b));
    return [this.shared, own, ...shares];
  }

  /** The deepest of `all` that holds `path`. `folder`: the path names a
   *  folder, which a shared document is not. */
  private deepest(all: readonly Section[], path: string, folder: boolean): Section | null {
    const stem = (() => {
      const slash = path.lastIndexOf("/");
      const [name] = splitName(path.slice(slash + 1));
      return `${path.slice(0, slash + 1)}${name}`;
    })();
    let best: Section | null = null;
    for (const s of all) {
      if (s.share && s.kind === "document") {
        // A shared document is the deepest thing there can be at its path.
        if (!folder && (same(itemPath(s.share), stem) || same(itemPath(s.share), path))) return s;
        continue;
      }
      if (!same(s.mount, path) && !under(path, s.mount)) continue;
      if (!best || s.mount.length > best.mount.length) best = s;
    }
    return best;
  }

  /**
   * The section a path is in. Two paths are in none, and say which place
   * they are for the callers that list what is there: "" is the workspace
   * itself, and exactly `Shared with me` the folder that holds what is
   * shared with the person. `folder`: the path names a folder, never a
   * shared document that has its name.
   */
  async at(path: string, folder = false): Promise<Section | "workspace" | "shared" | Refusal> {
    const trimmed = path.replace(/^\/+|\/+$/g, "");
    if (trimmed === "") return "workspace";
    const problem = pathProblem(trimmed);
    if (problem) return new Refusal(400, problem);
    const segs = trimmed.split("/");
    const top = segs[0].toLowerCase();
    if (top === LIBRARY_FOLDER.toLowerCase()) return this.shared;
    if (top === MY_FILES_FOLDER.toLowerCase()) {
      // One read of the rows, and no manifest's, when nothing is shared from it: the usual case.
      const rows = await this.spaces();
      if (rows === null) return noDatabase();
      const mine = rows.find((r) => r.kind === "private");
      if (!mine) return noDatabase();
      if (!rows.some((r) => r.parent === mine.id)) {
        return { space: mine.id, kind: "private", mount: MY_FILES_FOLDER, env: spaceEnv(this.shared.env, mine) };
      }
      const all = await this.all();
      if (all === null) return noDatabase();
      return this.deepest(all.filter((s) => s.kind !== "shared"), trimmed, folder) ?? noDatabase();
    }
    if (top !== SHARED_FOLDER.toLowerCase()) {
      return new Refusal(
        400,
        RENAMED[top] ??
          `${trimmed} is in no section. Say which: ${LIBRARY_FOLDER}/${trimmed} (everyone), "${MY_FILES_FOLDER}/${trimmed}" (only your person) or "${SHARED_FOLDER}/<name>/…" (something shared with them).`,
      );
    }
    if (segs.length === 1) return "shared";
    const all = await this.all();
    if (all === null) return noDatabase();
    return (
      this.deepest(all.filter((s) => s.share), trimmed, folder) ??
      new Refusal(
        404,
        `nothing called "${segs[1]}" is shared with this agent's person — \`doklin ls "${SHARED_FOLDER}"\` lists what is`,
      )
    );
  }

  /** The section a document or a file is in — never the workspace itself or
   *  `Shared with me`, which hold sections and nothing else. */
  async of(path: string, folder = false): Promise<Section | Refusal> {
    const at = await this.at(path, folder);
    if (at === "workspace") {
      return new Refusal(400, `name a document or a folder, starting with where it is: ${HEADINGS}`);
    }
    return at === "shared"
      ? new Refusal(400, `"${SHARED_FOLDER}" holds what others shared and nothing else — name something inside one of them`)
      : at;
  }

  /** The folders every path starts with, for this person: `Shared with me`
   *  only once something is. Null when the database cannot say. */
  async headings(): Promise<string[] | null> {
    const rows = await this.spaces();
    if (rows === null) return null;
    const shared = rows.some((r) => r.kind !== "private" && r.parent === null);
    return [LIBRARY_FOLDER, MY_FILES_FOLDER, ...(shared ? [SHARED_FOLDER] : [])];
  }

  /** The agent's person's own sign-in, for a change that is theirs to make
   *  (a shared folder's name). */
  get auth(): Auth {
    return this.person;
  }

  /** The agent's person, as the directory names them — null when the
   *  database cannot say. */
  async who(): Promise<{ id: string; name: string } | null> {
    return withDb(this.shared.env, (db) =>
      db
        .prepare("SELECT id, name FROM members WHERE id = ?1")
        .bind(this.person.memberId)
        .first<{ id: string; name: string }>(),
    );
  }
}
