// Who is here — a row per device in D1, written by the poll that carries a
// beat (docs/teams-plan.md §3.3, §13).
//
// Presence used to be `presence.json`, one R2 object every device read,
// mutated and wrote back on its own 25-second request. That was a lost update
// (two beats landing together, one vanished) and, at ten always-on Macs, 86%
// of the free plan's Class A writes. Here a beat is an upsert of the caller's
// own row — atomic by itself — and it rides `POST /api/poll`, so the request
// it used to cost is gone too.
//
// Best effort, always. Every function answers null when the database is
// missing or throws, and the poll answers the manifest etag regardless: sync
// never waits on presence, which is exactly the contract presence had as an
// R2 object ("TTL'd, best effort").
//
// No reaper. A read filters by the TTL, and a beat sweeps the rows that have
// lapsed in the same batch it writes in — so the table holds the devices that
// are here, plus whoever quit without saying so in the last minute and a half.

import type { Auth } from "./auth";
import type { Env } from "./env";
import { PRESENCE_TTL_MS } from "./layout";
import { ensureSchema } from "./schema";

/** One device, as the poll reports it. `name` is the Mac's; `memberId` is
 *  whose it is, and the app puts a person's name to it (teams-plan.md §12). */
export type PresenceEntry = { memberId: string | null; name: string; path?: string; ts: number };
export type PresenceMap = Record<string, PresenceEntry>;

/** What a beat says: here (editing `path`, when set), or leaving. */
export type Beat = { kind: "here"; name: string; path: string | null } | { kind: "leave" };

/** `last_seen_at` moves at most this often per person — a write on every beat
 *  would be 19,200 rows a day for ten Macs, for a column the People list
 *  shows to the hour. */
export const LAST_SEEN_GRAIN_MS = 60 * 60 * 1000;

type Row = { device_id: string; member_id: string | null; device_name: string; path: string | null; ts: number };

const READ_SQL = "SELECT device_id, member_id, device_name, path, ts FROM presence WHERE ts > ?";

function toMap(rows: Row[]): PresenceMap {
  const out: PresenceMap = {};
  for (const r of rows) {
    out[r.device_id] = {
      memberId: r.member_id ?? null,
      name: r.device_name,
      ...(r.path ? { path: r.path } : {}),
      ts: Number(r.ts),
    };
  }
  return out;
}

async function withDb<T>(env: Env, fn: (db: D1Database) => Promise<T>): Promise<T | null> {
  const db = env.DB;
  if (!db) return null;
  try {
    if ((await ensureSchema(env)) == null) return null;
    return await fn(db);
  } catch {
    return null;
  }
}

/** Everyone whose last beat is inside the TTL. Reads only — the idle poll. */
export async function readPresence(env: Env, now = Date.now()): Promise<PresenceMap | null> {
  return withDb(env, async (db) => {
    const { results } = await db.prepare(READ_SQL).bind(now - PRESENCE_TTL_MS).all<Row>();
    return toMap(results);
  });
}

/**
 * Record a beat and answer who is here, in one round trip.
 *
 * The batch is four statements: the caller's row (or its removal, for a
 * leave), the person's `last_seen_at` when it is more than an hour old, the
 * sweep of lapsed rows, and the read the poll answers with. `rows written`
 * is one per beat, plus one an hour per person, plus whatever lapsed.
 *
 * The owner's request carries no member id — the env secret reads no row
 * (auth.ts) — so their row takes the id of whoever holds the owner role, in
 * the same statement. An owner who never adopted one is here as their Mac.
 */
export async function recordBeat(
  env: Env,
  auth: Auth,
  deviceId: string,
  beat: Beat,
  now = Date.now(),
): Promise<PresenceMap | null> {
  return withDb(env, async (db) => {
    const write =
      beat.kind === "leave"
        ? [db.prepare("DELETE FROM presence WHERE device_id = ?").bind(deviceId)]
        : [
            db
              .prepare(
                `INSERT INTO presence (device_id, member_id, device_name, path, ts)
                 VALUES (?1, COALESCE(?2, (SELECT id FROM members WHERE role = 'owner' AND disabled = 0 LIMIT 1)), ?3, ?4, ?5)
                 ON CONFLICT(device_id) DO UPDATE SET
                   member_id = excluded.member_id, device_name = excluded.device_name,
                   path = excluded.path, ts = excluded.ts`,
              )
              .bind(deviceId, auth.memberId, beat.name, beat.path, now),
            // Decision 7: "last seen" is the beat's to write, never
            // `authenticate`'s — and only when the stored one is stale.
            db
              .prepare(
                `UPDATE members SET last_seen_at = ?1
                  WHERE id = (SELECT member_id FROM presence WHERE device_id = ?2)
                    AND (last_seen_at IS NULL OR last_seen_at <= ?1 - ?3)`,
              )
              .bind(now, deviceId, LAST_SEEN_GRAIN_MS),
          ];
    const results = await db.batch([
      ...write,
      db.prepare("DELETE FROM presence WHERE ts <= ?").bind(now - PRESENCE_TTL_MS),
      db.prepare(READ_SQL).bind(now - PRESENCE_TTL_MS),
    ]);
    return toMap((results.at(-1)?.results ?? []) as Row[]);
  });
}
