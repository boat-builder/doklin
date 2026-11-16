// What a domain's devices and agents may spend in a day, and what they have
// spent — the one source of these numbers. The engine and the CLI hold none
// of their own: every poll, `/api/meta`, the agent's `me` and its login carry
// `limits` for the domain's plan, and a client keeps the last answer. The
// shape is a contract (`Limits`, engine/src/cloud/pace.rs; the CLI reads
// `cliDaily`, cli/src/usage.rs) — change all.
//
// What they protect: on Workers Free the whole Cloudflare account answers
// `cap` requests a day, every Worker on it together, and past that every
// request gets Cloudflare's error page until 00:00 UTC. A request the worker
// refuses has been counted already, so these are numbers for a client to stop
// sending by. The worker's own loop catchers (`DEVICE_LIMIT`, `AGENT_LIMIT`,
// api.ts) only catch a loop; they never keep the account inside its day.
//
// The plan is the superadmin's to say (`settings`, key `plan`); until they
// do, and whenever the database cannot answer, it is Free — the tighter
// numbers. `fleetToday` is everyone's own report of their requests today
// (`x-doklin-used`, one `usage` row per credential): a number a client
// reports wrongly can only make devices slower. Public page views and other
// Workers on the account are not in it; the fleet thresholds leave that room.

import type { Env } from "./env";
import { withDb } from "./schema";

export type Plan = "free" | "paid";

export type Limits = {
  plan: Plan;
  /** The account's requests a day; null on a plan with no such limit. */
  cap: number | null;
  /** How fast a device's bulk lane refills, in requests a second. */
  bulkPerSecond: number;
  /** A device's requests today — all of them, not only bulk — past which its bulk waits for tomorrow. */
  deviceBulk: number | null;
  /** A device's requests today past which it goes slow. */
  deviceCeiling: number;
  /** Everyone's requests today past which every device's bulk waits. */
  fleetBulkWaits: number | null;
  /** Everyone's requests today past which every device goes slow. */
  fleetSlow: number | null;
  /** One agent machine's requests a day. */
  cliDaily: number;
  /** New documents in one pass from which a device asks before syncing them. */
  manyNew: number;
  /** Everyone's requests today, as they reported them; null when the database could not say. */
  fleetToday: number | null;
};

const TABLE: Readonly<Record<Plan, Omit<Limits, "plan" | "fleetToday">>> = {
  free: {
    cap: 100_000,
    bulkPerSecond: 4,
    deviceBulk: 10_000,
    deviceCeiling: 15_000,
    fleetBulkWaits: 60_000,
    fleetSlow: 85_000,
    cliDaily: 5_000,
    manyNew: 200,
  },
  // 10M requests a month are included and the rest is billed, never cut off:
  // what is left is a ceiling on a device gone wrong.
  paid: {
    cap: null,
    bulkPerSecond: 20,
    deviceBulk: null,
    deviceCeiling: 200_000,
    fleetBulkWaits: null,
    fleetSlow: null,
    cliDaily: 50_000,
    manyNew: 200,
  },
};

export const isPlan = (v: unknown): v is Plan => typeof v === "string" && Object.hasOwn(TABLE, v);

export const limitsFor = (plan: Plan, fleetToday: number | null): Limits => ({ plan, ...TABLE[plan], fleetToday });

/** What a client is told when the database cannot say: Free, and no fleet. */
export const UNKNOWN_LIMITS: Limits = limitsFor("free", null);

/** The UTC day a moment is in — what `usage.day` holds and the reset is at. */
export const dayOf = (ms: number): number => Math.floor(ms / 86_400_000);

/** The two reads `limits` is made of. They ride any batch a route already
 *  makes — the poll's, so a poll costs no round trip more — and are read back
 *  by `limitsFrom` from the batch's results. */
export const limitsReads = (db: D1Database, now: number): D1PreparedStatement[] => [
  db.prepare("SELECT value FROM settings WHERE key = 'plan'"),
  db.prepare("SELECT COALESCE(SUM(requests), 0) AS n FROM usage WHERE day = ?").bind(dayOf(now)),
];

/** `limits` out of the results of `limitsReads`, in the order it made them. */
export function limitsFrom([plan, fleet]: D1Result[]): Limits {
  const value = (plan?.results?.[0] as { value?: unknown } | undefined)?.value;
  const spent = Number((fleet?.results?.[0] as { n?: unknown } | undefined)?.n ?? 0);
  return limitsFor(isPlan(value) ? value : "free", Number.isFinite(spent) ? spent : null);
}

/** The domain's `limits` on a route that makes no batch of its own. */
export async function readLimits(env: Env, now = Date.now()): Promise<Limits> {
  return (await withDb(env, async (db) => limitsFrom(await db.batch(limitsReads(db, now))))) ?? UNKNOWN_LIMITS;
}

/** Say which plan the account is on, and answer the numbers it now has.
 *  Null when the database could not take it. */
export async function setPlan(env: Env, plan: Plan, now = Date.now()): Promise<Limits | null> {
  return withDb(env, async (db) => {
    const results = await db.batch([
      db
        .prepare("INSERT INTO settings (key, value) VALUES ('plan', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(plan),
      ...limitsReads(db, now),
    ]);
    return limitsFrom(results.slice(1));
  });
}

/** How often one credential's report is written. A client reports at most
 *  every 15 minutes; one that reports on every request costs no more than a
 *  row a minute. */
const USAGE_GRAIN_MS = 60_000;

/** The caller's requests today from `x-doklin-used`, or null when the header
 *  is missing or is not a count. */
export function usedOf(request: Request): number | null {
  const raw = request.headers.get("x-doklin-used")?.trim() ?? "";
  return /^\d{1,9}$/.test(raw) ? Number(raw) : null;
}

/**
 * Record a credential's report of its requests today: its own row, replaced
 * — never added to, so a report sent twice counts once — and yesterday's rows
 * swept in the same batch, so the table holds today's reports and no more.
 * Best effort: a report that does not land is the next one's to make.
 */
export async function recordUsage(env: Env, who: string, requests: number, now = Date.now()): Promise<void> {
  const day = dayOf(now);
  await withDb(env, (db) =>
    db.batch([
      db
        .prepare(
          `INSERT INTO usage (who, day, requests, at) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(who) DO UPDATE SET day = excluded.day, requests = excluded.requests, at = excluded.at
           WHERE usage.day <> excluded.day OR usage.at <= excluded.at - ?5`,
        )
        .bind(who, day, requests, now, USAGE_GRAIN_MS),
      db.prepare("DELETE FROM usage WHERE day < ?").bind(day),
    ]),
  );
}
