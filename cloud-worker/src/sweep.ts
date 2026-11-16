// The daily sweep (a cron trigger, index.ts): every stored copy of a file —
// blobs/<fileId>/<hash>, in the shared workspace and in every space — that
// its manifest does not point at, and that has been stored for more than a
// day, is deleted.
//
// The manifest is the one word on what is live, so this one rule covers every
// way a copy is left behind: a file deleted, a version replaced, an upload
// whose manifest write never won, a push cut short and never resumed. The
// worker is the one place that sees every manifest and the whole bucket, so
// it is the one that collects; no device deletes a copy.
//
// The day is the grace a copy needs between its upload and the manifest write
// that names it: a push uploads first and writes the manifest after, and a
// lost race retries. The engine remembers an upload for half of it
// (`UPLOADED_TTL_MS`, engine/src/cloud/unit.rs) and uploads again after, so a
// copy it still counts on is never one this takes. Change both.
//
// A run is bounded: Workers Free allows 50 calls to the bucket in one
// invocation, and this makes at most SWEEP_CALLS. Each day starts at another
// section, so one that a run did not reach is reached on a later one. The
// version store (versions/) is not this: it has its own grace and its own
// collector (engine/src/cloud/versions.rs).

import type { Env } from "./env";
import { BLOBS_PREFIX, MANIFEST_KEY, SPACES_PREFIX, SPACE_ID_RE } from "./layout";
import { withoutUnsynced } from "./manifest";
import { spaceEnv } from "./spaces";

/** How long a copy no manifest names is left alone. */
export const SWEEP_MIN_AGE_MS = 24 * 60 * 60 * 1000;
/** Calls to the bucket one run may make — under Workers Free's 50. */
export const SWEEP_CALLS = 40;
/** R2 deletes at most this many keys in one call. */
const DELETE_BATCH = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type SweepReport = {
  /** The sections the bucket holds: the shared workspace and each space. */
  sections: number;
  /** Those this run went all the way through. */
  swept: number;
  /** Copies deleted. */
  deleted: number;
  /** Sections passed over because their manifest could not be read. */
  unreadable: number;
};

/** The calls one run has left: every bucket call takes one. */
class Budget {
  constructor(private left: number) {}
  take(): boolean {
    if (this.left <= 0) return false;
    this.left -= 1;
    return true;
  }
  get remaining(): number {
    return this.left;
  }
}

type Outcome = "swept" | "cut" | "unreadable";

export async function sweep(env: Env, now: number): Promise<SweepReport> {
  const budget = new Budget(SWEEP_CALLS);
  const report: SweepReport = { sections: 0, swept: 0, deleted: 0, unreadable: 0 };

  // The shared workspace, then every space the bucket holds a prefix for.
  const sections: string[] = [""];
  let cursor: string | undefined;
  do {
    if (!budget.take()) return report;
    const page = await env.DATA.list({ prefix: SPACES_PREFIX, delimiter: "/", cursor });
    for (const p of page.delimitedPrefixes) {
      const id = p.slice(SPACES_PREFIX.length, -1);
      if (SPACE_ID_RE.test(id)) sections.push(id);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  sections.sort();
  report.sections = sections.length;

  const start = Math.floor(now / DAY_MS) % sections.length;
  for (let i = 0; i < sections.length; i++) {
    const id = sections[(start + i) % sections.length];
    const outcome = await sweepSection(id === "" ? env : spaceEnv(env, id), now, budget, report);
    if (outcome === "unreadable") report.unreadable += 1;
    if (outcome === "swept") report.swept += 1;
    if (outcome === "cut" || budget.remaining === 0) break;
  }
  return report;
}

/**
 * One section (`env` scoped to it): list its copies, then read its manifest,
 * then delete what the manifest does not name and is past the grace. The
 * manifest is read after the listing, so a write that lands meanwhile and
 * names a copy keeps it. Two calls are held back while listing — the
 * manifest's read and one delete — so a long listing still collects what it
 * found.
 */
async function sweepSection(env: Env, now: number, budget: Budget, report: SweepReport): Promise<Outcome> {
  const old: string[] = [];
  let cursor: string | undefined;
  let cut = false;
  do {
    if (budget.remaining <= 2) {
      cut = true;
      break;
    }
    budget.take();
    const page = await env.DATA.list({ prefix: BLOBS_PREFIX, cursor });
    for (const obj of page.objects) {
      if (now - obj.uploaded.getTime() > SWEEP_MIN_AGE_MS) old.push(obj.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  if (old.length === 0) return cut ? "cut" : "swept";

  if (!budget.take()) return "cut";
  const named = await namedCopies(env);
  if (named === null) return "unreadable";

  const gone = old.filter((key) => !named.has(key));
  for (let i = 0; i < gone.length; i += DELETE_BATCH) {
    if (!budget.take()) return "cut";
    const batch = gone.slice(i, i + DELETE_BATCH);
    await env.DATA.delete(batch);
    report.deleted += batch.length;
  }
  return cut ? "cut" : "swept";
}

/**
 * The copies a section's manifest points at — `blobs/<fileId>/<hash>` for
 * every file it holds, read as the worker reads a manifest (a file outside
 * what syncs is not held). No manifest names none; one that cannot be read
 * is null, and its section is left alone rather than swept on a guess.
 */
async function namedCopies(env: Env): Promise<Set<string> | null> {
  const obj = await env.DATA.get(MANIFEST_KEY);
  if (!obj) return new Set();
  let data: unknown;
  try {
    data = withoutUnsynced(await obj.json());
  } catch {
    return null;
  }
  const files = (data as { files?: unknown } | null)?.files;
  if (files === null || typeof files !== "object" || Array.isArray(files)) return null;
  const named = new Set<string>();
  for (const [fid, f] of Object.entries(files as Record<string, unknown>)) {
    const hash = (f as { hash?: unknown } | null)?.hash;
    if (typeof hash !== "string") return null;
    named.add(`${BLOBS_PREFIX}${fid}/${hash}`);
  }
  return named;
}
