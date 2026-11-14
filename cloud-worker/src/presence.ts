// Who is here, and who holds which document — a row per device and a row per
// leased path in D1, both written by the poll that carries a beat.
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
// By space. A beat names the space its document is in ('' the shared
// workspace), and a lease is one document in one space. What somebody has
// open in a space is told only to the people in that space: to everyone else
// they are here, and that is all. The poll's own batch also answers which
// spaces the caller is in (spaces.ts), which is how a Mac learns it was added
// to one, or taken out.
//
// No reaper. A read filters by the TTL, and a beat sweeps the rows that have
// lapsed in the same batch it writes in — so the tables hold the devices that
// are here and the documents they have open, plus whatever quit without saying
// so in the last minute and a half.

import type { Auth } from "./auth";
import type { Env } from "./env";
import { PRESENCE_TTL_MS } from "./layout";
import { withDb } from "./schema";
import { CALLER_SQL, spacesStatement, toSpace, type Space, type SpaceRow } from "./spaces";

/** One device, as the poll reports it. `name` is the Mac's; `memberId` is
 *  whose it is, and the app puts a person's name to it. `path` is what they
 *  have open, in `space` when that is not the shared workspace — both absent
 *  when it is in a space the caller is not in. */
export type PresenceEntry = { memberId: string | null; name: string; path?: string; space?: string; ts: number };
export type PresenceMap = Record<string, PresenceEntry>;

/** One held document. `path` is the lease's key — relative to its space and
 *  lowercased, so two spellings of one file on a case-insensitive disk are
 *  one lock. `space` is set when it is not the shared workspace. `name` is
 *  the holder's Mac. */
export type LeaseEntry = {
  path: string;
  space?: string;
  deviceId: string;
  memberId: string | null;
  name: string;
  until: number;
};

/** What the poll answers beside the etag. When the database cannot say, the
 *  poll answers `presence: {}`, `leases: null` and `spaces: null` — and an
 *  editor reads a null exactly as "nobody holds anything". */
export type Here = { presence: PresenceMap; leases: LeaseEntry[]; spaces: Space[] };

/** What a beat says: here (editing `path` in `space`, when set — which claims
 *  it, and `take` claims it from whoever holds it), or leaving. */
export type Beat =
  | { kind: "here"; name: string; space: string; path: string | null; take: boolean }
  | { kind: "leave" };

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

type PresenceRow = {
  device_id: string;
  member_id: string | null;
  device_name: string;
  space_id: string | null;
  path: string | null;
  ts: number;
};
type LeaseRow = {
  space_id: string;
  path: string;
  device_id: string;
  member_id: string | null;
  device_name: string;
  until: number;
};

/** The spaces the caller (?1) is in — what they may be told about. */
const MINE = `(SELECT space_id FROM space_members WHERE member_id = ${CALLER_SQL})`;
const SEEN = `space_id = '' OR space_id IN ${MINE}`;

// Both bind the caller's member id as ?1 and the clock as ?2.
const PRESENCE_SQL = `SELECT device_id, member_id, device_name, ts,
       CASE WHEN ${SEEN} THEN space_id END AS space_id,
       CASE WHEN ${SEEN} THEN path END AS path
  FROM presence WHERE ts > ?2`;
const LEASES_SQL = `SELECT space_id, path, device_id, member_id, device_name, until
  FROM leases WHERE until > ?2 AND (${SEEN}) ORDER BY space_id, path`;

function toHere(presenceRows: PresenceRow[], leaseRows: LeaseRow[], spaces: Space[]): Here {
  const presence: PresenceMap = {};
  for (const r of presenceRows) {
    presence[r.device_id] = {
      memberId: r.member_id ?? null,
      name: r.device_name,
      ...(r.path ? { path: r.path, ...(r.space_id ? { space: r.space_id } : {}) } : {}),
      ts: Number(r.ts),
    };
  }
  const leases = leaseRows.map((r) => ({
    path: r.path,
    ...(r.space_id ? { space: r.space_id } : {}),
    deviceId: r.device_id,
    memberId: r.member_id ?? null,
    name: r.device_name,
    until: Number(r.until),
  }));
  return { presence, leases, spaces };
}

/** The three reads every poll ends on, and what they come to. */
const reads = (db: D1Database, auth: Auth, now: number): D1PreparedStatement[] => [
  db.prepare(PRESENCE_SQL).bind(auth.memberId, now - PRESENCE_TTL_MS),
  db.prepare(LEASES_SQL).bind(auth.memberId, now),
  spacesStatement(db, auth),
];
const answer = (results: D1Result[]): Here => {
  const [presence, leases, spaces] = results.slice(-3);
  return toHere(
    (presence?.results ?? []) as PresenceRow[],
    (leases?.results ?? []) as LeaseRow[],
    ((spaces?.results ?? []) as SpaceRow[]).map(toSpace),
  );
};

/** Everyone whose last beat is inside the TTL, what they hold, and the spaces
 *  the caller is in. Reads only — the idle poll. */
export async function readHere(env: Env, auth: Auth, now = Date.now()): Promise<Here | null> {
  return withDb(env, async (db) => answer(await db.batch(reads(db, auth, now))));
}

/**
 * Record a beat and answer who is here and what they hold, in one round trip.
 *
 * The batch, for a beat that names a path: the caller's presence row, the
 * person's `last_seen_at` when it is more than an hour old, the release of
 * whatever else this Mac held, the claim on this path, the sweeps of lapsed
 * presence and lapsed leases, and the reads the poll answers with.
 * A beat with no path releases everything this Mac held instead of claiming;
 * a leave removes its presence and its leases outright. `rows written` is one
 * per beat, one more while a document is open, one an hour per person, plus
 * whatever lapsed.
 *
 * A beat that names a space the caller is not in is a beat with no path: the
 * presence row is written without one, so nothing is claimed.
 *
 * The creator's request carries no member id — the env secret reads no row
 * (auth.ts) — so their row takes the id the `creator` table names, in the
 * same statement. A creator who never said who they are is here as their Mac.
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
            // Everything this Mac held but the document it now names — and
            // that one too, when the presence row above came out with no
            // path because the space is not the caller's.
            db
              .prepare(
                `DELETE FROM leases
                  WHERE device_id = ?1
                    AND (space_id <> ?2 OR path <> ?3
                         OR NOT EXISTS (SELECT 1 FROM presence WHERE device_id = ?1 AND path IS NOT NULL))`,
              )
              .bind(deviceId, beat.space, leaseKey(beat.path)),
            // Free, lapsed, or already this Mac's: the row becomes this Mac's
            // until the TTL from now. Anyone else's, live: the WHERE is false
            // and nothing changes — the read below says who has it. `take`
            // drops that WHERE, which is the whole of taking over. The space
            // and the member are the ones the presence upsert above resolved.
            db
              .prepare(
                `INSERT INTO leases (space_id, path, device_id, member_id, device_name, until)
                 SELECT p.space_id, ?1, p.device_id, p.member_id, ?3, ?4
                   FROM presence p WHERE p.device_id = ?2 AND p.path IS NOT NULL
                 ON CONFLICT(space_id, path) DO UPDATE SET
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
                `INSERT INTO presence (device_id, member_id, device_name, space_id, path, ts)
                 SELECT ?2, ${CALLER_SQL}, ?3,
                        CASE WHEN ?4 = '' OR ?4 IN ${MINE} THEN ?4 ELSE '' END,
                        CASE WHEN ?4 = '' OR ?4 IN ${MINE} THEN ?5 END,
                        ?6
                  WHERE true
                 ON CONFLICT(device_id) DO UPDATE SET
                   member_id = excluded.member_id, device_name = excluded.device_name,
                   space_id = excluded.space_id, path = excluded.path, ts = excluded.ts`,
              )
              .bind(auth.memberId, deviceId, beat.name, beat.space, beat.path, now),
            // "Last seen" is the beat's to move, never `authenticate`'s — and
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
      ...reads(db, auth, now),
    ]);
    return answer(results);
  });
}
