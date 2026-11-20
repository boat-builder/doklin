// Where an agent's path is.
//
// An agent sees what its person sees, under the names on that person's disk,
// and every path it types starts with the section it is in:
//
//   Library/…               the shared section: everyone in the workspace
//   Private/…               their Private
//   Restricted/<folder>/…   a restricted folder they are in
//
// A path is literal. Nothing but its first segments says which section it is
// in, and no setting changes what a path means. A path that starts with none
// of the three is in no section, and is refused with a sentence that says
// which to use: nothing reaches everyone by being left unsaid. The workspace
// itself (`""`) is the three side by side, a place to list and search and
// nothing else. Each section is a tree of its own (spaces.ts), so a call is
// answered in the one its path names — with that section's part of the
// bucket, and its manifest mounted at the folder it is at (mount.ts).
//
// Whether the agent's person is in a section is asked on every request, of
// the rows their own token is asked of: added to a folder, taken out of one,
// removed from the workspace — the agent follows by its next command. A
// folder they are not in answers what a folder nobody made answers.
//
// A restricted folder is called what a Mac calls it (`candidates`,
// engine/src/cloud/space.rs — change both): its name; its name and who
// made it when that name is taken; then a number. A Mac gives the names out
// in the order folders reach it and the worker in the order they were made,
// so of two folders with one name a Mac may have the other one first —
// `doklin ls Restricted` says what each is called here.

import type { Auth } from "./auth";
import { Refusal } from "./commit";
import type { Env } from "./env";
import { pathProblem } from "./documents";
import { LIBRARY_FOLDER, MAX_NAME_LEN } from "./layout";
import { withDb } from "./schema";
import { ensurePrivate, sharedEnv, spaceEnv, type Where } from "./spaces";

/** How an agent spells the sections, which the app's *Copy path* writes for
 *  one (`SECTION_DIRS`, src/cloud.ts) — change both. */
export const PRIVATE_FOLDER = "Private";
export const RESTRICTED_FOLDER = "Restricted";

/** A section, and which kind it is. `mount` is the folder it is at, as its
 *  person names paths: `Library`, `Private`, `Restricted/Finance`. */
export type Section = Where & { kind: "shared" | "private" | "restricted" };

/** A name a folder on a Mac can carry (`sanitize_folder_name`,
 *  engine/src/cloud/config.rs — change both). */
function folderName(name: string): string {
  const cleaned = name
    .replace(/[/:\0\\]/g, "-")
    .trim()
    .replace(/^\.+|\.+$/g, "");
  return cleaned === "" ? "Workspace" : [...cleaned].slice(0, MAX_NAME_LEN).join("");
}

/** The folder each restricted space is at, given in the order they were made. */
export function folderNames(spaces: readonly { id: string; name: string; maker: string }[]): Map<string, string> {
  const taken = new Set<string>();
  const names = new Map<string, string>();
  for (const s of spaces) {
    const base = folderName(s.name);
    const tries = [base, ...(s.maker ? [`${base} (${folderName(s.maker)})`] : [])];
    let name = tries.find((t) => !taken.has(t.toLowerCase()));
    for (let n = 2; name === undefined; n += 1) {
      if (!taken.has(`${base} ${n}`.toLowerCase())) name = `${base} ${n}`;
    }
    taken.add(name.toLowerCase());
    names.set(s.id, name);
  }
  return names;
}

const noDatabase = (): Refusal => new Refusal(503, "this domain's database is not answering — try again in a moment");

/** Every section one agent's person can see, read at most once a request. */
export class Places {
  private readonly shared: Section;
  private listed: Promise<Section[] | null> | undefined;

  constructor(
    env: Env,
    /** The agent's own `Auth`: its `memberId` is its person. */
    private readonly person: Auth,
  ) {
    const whole = sharedEnv(env);
    this.shared = { space: "", kind: "shared", mount: LIBRARY_FOLDER, env: whole };
  }

  /** Library, then Private, then the restricted folders by name. Null when
   *  the database cannot say. */
  all(): Promise<Section[] | null> {
    this.listed ??= this.list();
    return this.listed;
  }

  private async list(): Promise<Section[] | null> {
    const env = this.shared.env;
    const rows = await withDb(env, async (db) => {
      const { results } = await db
        .prepare(
          `SELECT s.id, s.kind, s.name, COALESCE(m.name, '') AS maker
             FROM space_members mine JOIN spaces s ON s.id = mine.space_id
             LEFT JOIN members m ON m.id = s.created_by
            WHERE mine.member_id = ?1
            ORDER BY s.created_at, s.id`,
        )
        .bind(this.person.memberId)
        .all<{ id: string; kind: string; name: string; maker: string }>();
      return results;
    });
    if (rows === null) return null;

    const out: Section[] = [this.shared];
    // Everyone has a Private: it is made the first time anything asks.
    let mine = rows.find((r) => r.kind === "private")?.id;
    if (mine === undefined) {
      const made = await ensurePrivate(env, this.person);
      if (made === null) return null;
      mine = made.id;
    }
    out.push({ space: mine, kind: "private", mount: PRIVATE_FOLDER, env: spaceEnv(env, mine) });

    const restricted = rows.filter((r) => r.kind !== "private");
    const names = folderNames(restricted);
    const folders = restricted.map(
      (r): Section => ({
        space: r.id,
        kind: "restricted",
        mount: `${RESTRICTED_FOLDER}/${names.get(r.id)}`,
        env: spaceEnv(env, r.id),
      }),
    );
    folders.sort((a, b) => a.mount.localeCompare(b.mount, undefined, { sensitivity: "base" }));
    return [...out, ...folders];
  }

  /**
   * The section a path is in. Two paths are in none, and say which place
   * they are for the callers that list what is there: "" is the workspace
   * itself, and exactly `Restricted` the folder that holds the restricted
   * folders.
   */
  async at(path: string): Promise<Section | "workspace" | "restricted" | Refusal> {
    const trimmed = path.replace(/^\/+|\/+$/g, "");
    if (trimmed === "") return "workspace";
    const problem = pathProblem(trimmed);
    if (problem) return new Refusal(400, problem);
    const segs = trimmed.split("/");
    const top = segs[0].toLowerCase();
    if (top === LIBRARY_FOLDER.toLowerCase()) return this.shared;
    if (top === PRIVATE_FOLDER.toLowerCase()) {
      // One row read, and none of the folders': the usual case.
      const env = this.shared.env;
      const mine = await ensurePrivate(env, this.person);
      if (mine === null) return noDatabase();
      return { space: mine.id, kind: "private", mount: PRIVATE_FOLDER, env: spaceEnv(env, mine.id) };
    }
    if (top !== RESTRICTED_FOLDER.toLowerCase()) {
      return new Refusal(
        400,
        `${trimmed} is in no section. Say which: ${LIBRARY_FOLDER}/${trimmed} (everyone), ${PRIVATE_FOLDER}/${trimmed} (only your person) or ${RESTRICTED_FOLDER}/<folder>/${trimmed}.`,
      );
    }
    if (segs.length === 1) return "restricted";
    const all = await this.all();
    if (all === null) return noDatabase();
    const wanted = `${RESTRICTED_FOLDER}/${segs[1]}`.toLowerCase();
    return (
      all.find((s) => s.kind === "restricted" && s.mount.toLowerCase() === wanted) ??
      new Refusal(
        404,
        `there is no restricted folder "${segs[1]}" here for this agent — \`doklin ls ${RESTRICTED_FOLDER}\` lists the ones its person is in`,
      )
    );
  }

  /** The section a document or a file is in — never the workspace itself or
   *  `Restricted`, which hold sections and nothing else. */
  async of(path: string): Promise<Section | Refusal> {
    const at = await this.at(path);
    if (at === "workspace") {
      return new Refusal(
        400,
        `name a document or a folder, starting with its section: ${LIBRARY_FOLDER}/… (everyone), ${PRIVATE_FOLDER}/… (only your person) or ${RESTRICTED_FOLDER}/<folder>/…`,
      );
    }
    return at === "restricted"
      ? new Refusal(400, `${RESTRICTED_FOLDER} holds restricted folders and nothing else — name something inside one of them`)
      : at;
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
