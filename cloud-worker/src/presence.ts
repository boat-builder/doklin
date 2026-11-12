// Who is here, and who holds which document — a row per device and a row per
// leased path in D1, both written by the poll that carries a beat
// (docs/cloud.md §5.3, §8.2).
//
// Presence used to be `presence.json`, one R2 object every device read,
// mutated and wrote back on its own 25-second request. That was a lost update
// (two beats landing together, one vanished) and, at ten always-on Macs, 86%
// of the free plan's Class A writes. Here a beat is an upsert of the caller's
// own row — atomic by itself — and it rides `POST /api/poll`, so the request
// it used to cost is gone too.
//
// A lease is the same beat read one step further. A beat that names a path
// claims that document: the upsert of `leases` succeeds when nobody holds it,
// when it is already this Mac's (a renewal), or when the holder has lapsed —
// and changes nothing otherwise. A beat that names another path, or none,
// lets go of what this Mac held. So acquiring, renewing and releasing cost no
// request of their own either, and a lease lives exactly as long as the beats
// that carry it: `until` is the presence TTL from the last one.
//
// Advisory, always. Nothing that writes the manifest reads a lease; it changes
// what an editor does with a document, never whether a write lands.
//
// Best effort, always. Every function answers null when the database is
// missing or throws, and the poll answers the manifest etag regardless: sync
// never waits on presence or a lease, which is exactly the contract presence
// had as an R2 object ("TTL'd, best effort").
//
// No reaper. A read filters by the TTL, and a beat sweeps the rows that have
// lapsed in the same batch it writes in — so the tables hold the devices that
// are here and the documents they have open, plus whatever quit without saying
// so in the last minute and a half.

import type { Auth } from "./auth";
import type { Env } from "./env";
import { PRESENCE_TTL_MS } from "./layout";
import { ensureSchema } from "./schema";

/** One device, as the poll reports it. `name` is the Mac's; `memberId` is
 *  whose it is, and the app puts a person's name to it. */
export type PresenceEntry = { memberId: string | null; name: string; path?: string; ts: number };
export type PresenceMap = Record<string, PresenceEntry>;

/** One held document. `path` is the lease's key — workspace-relative and
 *  lowercased, so two spellings of one file on a case-insensitive disk are
 *  one lock. `name` is the holder's Mac. */
export type LeaseEntry = { path: string; deviceId: string; memberId: string | null; name: string; until: number };

/** What the poll answers beside the etag. When the database cannot say, the
 *  poll answers `presence: {}` and `leases: null` — and an editor reads a null
 *  exactly as "nobody holds anything". */
export type Here = { presence: PresenceMap; leases: LeaseEntry[] };

/** What a beat says: here (editing `path`, when set — which claims it, and
 *  `take` claims it from whoever holds it), or leaving. */
export type Beat = { kind: "here"; name: string; path: string | null; take: boolean } | { kind: "leave" };

/** `last_seen_at` moves at most this often per person — a write on every beat
 *  would be 19,200 rows a day for ten Macs, for a column the People list
 *  shows to the hour. */
export const LAST_SEEN_GRAIN_MS = 60 * 60 * 1000;

/** How long a beat holds a lease. The beat that renews it is the presence
 *  beat, so it lapses with the presence that carries it: one lost beat is
 *  survivable and two are not. */
export const LEASE_TTL_MS = PRESENCE_TTL_MS;

/** The key a path is leased under. Lowercased in JavaScript, not by SQLite's
 *  `lower()`, which folds ASCII only. */
export const leaseKey = (path: string): string => path.toLowerCase();

type PresenceRow = { device_id: string; member_id: string | null; device_name: string; path: string | null; ts: number };
type LeaseRow = { path: string; device_id: string; member_id: string | null; device_name: string; until: number };

const PRESENCE_SQL = "SELECT device_id, member_id, device_name, path, ts FROM presence WHERE ts > ?";
const LEASES_SQL = "SELECT path, device_id, member_id, device_name, until FROM leases WHERE until > ? ORDER BY path";

function toHere(presenceRows: PresenceRow[], leaseRows: LeaseRow[]): Here {
  const presence: PresenceMap = {};
  for (const r of presenceRows) {
    presence[r.device_id] = {
      memberId: r.member_id ?? null,
      name: r.device_name,
      ...(r.path ? { path: r.path } : {}),
      ts: Number(r.ts),
    };
  }
  const leases = leaseRows.map((r) => ({
    path: r.path,
    deviceId: r.device_id,
    memberId: r.member_id ?? null,
    name: r.device_name,
    until: Number(r.until),
  }));
  return { presence, leases };
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

/** Everyone whose last beat is inside the TTL, and what they hold. Reads
 *  only — the idle poll. */
export async function readHere(env: Env, now = Date.now()): Promise<Here | null> {
  return withDb(env, async (db) => {
    const [presence, leases] = await db.batch([
      db.prepare(PRESENCE_SQL).bind(now - PRESENCE_TTL_MS),
      db.prepare(LEASES_SQL).bind(now),
    ]);
    return toHere((presence?.results ?? []) as PresenceRow[], (leases?.results ?? []) as LeaseRow[]);
  });
}

/**
 * Record a beat and answer who is here and what they hold, in one round trip.
 *
 * The batch, for a beat that names a path: the caller's presence row, the
 * person's `last_seen_at` when it is more than an hour old, the release of
 * whatever else this Mac held, the claim on this path, the sweeps of lapsed
 * presence and lapsed leases, and the two reads the poll answers with.
 * A beat with no path releases everything this Mac held instead of claiming;
 * a leave removes its presence and its leases outright. `rows written` is one
 * per beat, one more while a document is open, one an hour per person, plus
 * whatever lapsed.
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
): Promise<Here | null> {
  return withDb(env, async (db) => {
    const leasing =
      beat.kind === "leave" || beat.path == null
        ? [db.prepare("DELETE FROM leases WHERE device_id = ?").bind(deviceId)]
        : [
            db.prepare("DELETE FROM leases WHERE device_id = ?1 AND path <> ?2").bind(deviceId, leaseKey(beat.path)),
            // Free, lapsed, or already this Mac's: the row becomes this Mac's
            // until the TTL from now. Anyone else's, live: the WHERE is false
            // and nothing changes — the read below says who has it. `take`
            // drops the WHERE, which is the whole of taking over. The member
            // is the one the presence upsert above just resolved.
            db
              .prepare(
                `INSERT INTO leases (path, device_id, member_id, device_name, until)
                 VALUES (?1, ?2, (SELECT member_id FROM presence WHERE device_id = ?2), ?3, ?4)
                 ON CONFLICT(path) DO UPDATE SET
                   device_id = excluded.device_id, member_id = excluded.member_id,
                   device_name = excluded.device_name, until = excluded.until` +
                  (beat.take ? "" : `\n                 WHERE leases.device_id = excluded.device_id OR leases.until <= ?5`),
              )
              .bind(...[leaseKey(beat.path), deviceId, beat.name, now + LEASE_TTL_MS, ...(beat.take ? [] : [now])]),
          ];
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
            // "Last seen" is the beat's to write, never `authenticate`'s — and
            // only when the stored one is stale.
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
      ...leasing,
      db.prepare("DELETE FROM presence WHERE ts <= ?").bind(now - PRESENCE_TTL_MS),
      db.prepare("DELETE FROM leases WHERE until <= ?").bind(now),
      db.prepare(PRESENCE_SQL).bind(now - PRESENCE_TTL_MS),
      db.prepare(LEASES_SQL).bind(now),
    ]);
    return toHere((results.at(-2)?.results ?? []) as PresenceRow[], (results.at(-1)?.results ?? []) as LeaseRow[]);
  });
}
